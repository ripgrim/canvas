import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createPreviewRuntime, validatePreviewFiles } from '../src/index.js'

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const binding = { componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'] }
const registry = [
  { componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', props: {}, slots: [] },
  ...['Card', 'Label', 'Input', 'Button'].map(exportName => ({ componentId: `atom-${exportName.toLowerCase()}`, exportName, entryPath: `src/atoms/${exportName}.tsx`, props: {}, slots: [] })),
]

async function fixtureFiles(path = 'src'): Promise<Record<string, string>> {
  const entries = await readdir(join(repositoryRoot, path), { withFileTypes: true })
  const files: Record<string, string> = {}
  for (const entry of entries) {
    const relative = `${path}/${entry.name}`
    if (entry.isDirectory()) Object.assign(files, await fixtureFiles(relative))
    else if (entry.isFile()) files[relative] = await readFile(join(repositoryRoot, relative), 'utf8')
  }
  return files
}

function childProcessIds(): Set<number> {
  const handles = (process as NodeJS.Process & { _getActiveHandles(): Array<{ constructor?: { name?: string }, pid?: number }> })._getActiveHandles()
  return new Set(handles.filter(handle => handle.constructor?.name === 'ChildProcess' && typeof handle.pid === 'number').map(handle => handle.pid!))
}

async function waitForNewChildProcess(baseline: ReadonlySet<number>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ([...childProcessIds()].some(pid => !baseline.has(pid))) return
    await delay(10)
  }
  throw new Error('Preview build worker did not start.')
}

async function temporaryFixture(): Promise<{ root: string, cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'design-editor-preview-acceptance-')))
  await cp(repositoryRoot, root, { recursive: true, filter: path => !path.endsWith('node_modules') && !path.includes('.design-editor') })
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' } }))
  await symlink(await realpath(join(repositoryRoot, 'node_modules')), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } }
}

describe('AT-PRV-003 and AT-PRV-004 real Vite build boundary', () => {
  it('compiles real atom imports, serves isolated assets, retains last good on failure and closes its port', async () => {
    const service = createPreviewRuntime({ repositoryRoot, editorOrigin: 'http://127.0.0.1:4319', executionTrust: 'fixture-only' })
    try {
      const good = await service.start({ ...binding, registry })
      expect(good.status).toBe('ready')
      expect(good.activeGeneration).toBe(1)
      expect(good.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const response = await fetch(good.url!)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors http://127.0.0.1:4319')
      const html = await response.text()
      const script = /src="([^"]+\.js)"/.exec(html)?.[1]
      expect(script).toBeTruthy()
      const bundle = await (await fetch(`${good.origin}${script}`)).text()
      expect(bundle).toContain('PreviewLogin')
      expect(bundle).toContain('createPortal')
      expect(bundle).toContain('design-editor-preview')
      expect(bundle).toContain('data-preview-instance')
      expect(bundle).toContain('atom-input')
      expect(bundle).toContain('set-document')
      expect(bundle).toContain('fixture-input')
      expect(bundle).not.toContain('node:fs')
      expect((await fetch(`${good.origin}/@fs/C:/Windows/win.ini`)).status).toBe(404)
      expect((await fetch(`${good.origin}/build/1/settings.json`)).status).toBe(404)
      expect((await fetch(good.url!, { method: 'POST' })).status).toBe(405)
      const bad = await service.rebuild({ ...binding, entryPath: 'src/does-not-exist.tsx' })
      expect(bad.status).toBe('error')
      expect(bad.stale).toBe(true)
      expect(bad.currentGeneration).toBe(2)
      expect(bad.activeGeneration).toBe(1)
      expect(bad.url).toBe(good.url)
      expect(bad.diagnostics.length).toBe(1)
      expect((await fetch(good.url!)).status).toBe(200)
      const fixed = await service.rebuild({ ...binding, registry })
      expect(fixed).toMatchObject({ status: 'ready', currentGeneration: 3, activeGeneration: 3, stale: false, diagnostics: [] })
      expect(fixed.url).not.toBe(good.url)
      expect((await fetch(fixed.url!)).status).toBe(200)
      await service.stop()
      expect(service.snapshot().status).toBe('stopped')
      await expect(fetch(good.url!)).rejects.toThrow()
    } finally { await service.dispose() }
  }, 60_000)

  it('AT-PRV-002 accepts build N+1 while delayed build N is still running and never lets N replace it', async () => {
    const fixture = await temporaryFixture()
    const slowPath = join(fixture.root, 'src/SlowPreview.tsx')
    const values = Array.from({ length: 600_000 }, (_, index) => String(index)).join(',')
    await writeFile(slowPath, `const values = [${values}]\nexport function SlowPreview() { return <output>{values[0]}</output> }\n`)
    const service = createPreviewRuntime({ repositoryRoot: fixture.root, editorOrigin: 'http://127.0.0.1:4319', executionTrust: 'fixture-only', buildTimeoutMs: 60_000 })
    try {
      const baselineWorkers = childProcessIds()
      let delayedResolved = false
      const delayedBuild = service.start({ componentId: 'slow-preview', entryPath: 'src/SlowPreview.tsx', exportName: 'SlowPreview', registry: [{ componentId: 'slow-preview', entryPath: 'src/SlowPreview.tsx', exportName: 'SlowPreview', props: {}, slots: [] }] }).finally(() => { delayedResolved = true })
      await waitForNewChildProcess(baselineWorkers)
      expect(service.snapshot()).toMatchObject({ status: 'building', currentGeneration: 1, activeGeneration: null })

      const newest = await service.rebuild({ ...binding, registry })
      expect(newest, JSON.stringify(newest)).toMatchObject({ status: 'ready', currentGeneration: 2, activeGeneration: 2, stale: false })
      expect(delayedResolved).toBe(false)
      const newestUrl = newest.url

      await delayedBuild
      expect(service.snapshot()).toMatchObject({ status: 'ready', currentGeneration: 2, activeGeneration: 2, url: newestUrl, stale: false })
      expect((await fetch(newestUrl!)).status).toBe(200)
      expect([...childProcessIds()].filter(pid => !baselineWorkers.has(pid))).toEqual([])
    } finally {
      await service.dispose()
      await fixture.cleanup()
    }
  }, 90_000)

  it('AT-PRV-004 repeatedly disposes subscribers, build workers, HTTP ports, and owned temporary services within the documented heap budget', async () => {
    const baselineWorkers = childProcessIds()
    const baselineHeap = process.memoryUsage().heapUsed
    for (let cycle = 0; cycle < 4; cycle++) {
      const service = createPreviewRuntime({ repositoryRoot, editorOrigin: 'http://127.0.0.1:4319', executionTrust: 'fixture-only' })
      let notifications = 0
      const unsubscribe = service.subscribe(() => { notifications++ })
      const ready = await service.start({ ...binding, registry })
      expect(ready.status).toBe('ready')
      expect(notifications).toBeGreaterThan(0)
      unsubscribe()
      const afterUnsubscribe = notifications
      const url = ready.url!
      await service.dispose()
      expect(service.snapshot()).toMatchObject({ status: 'disposed', activeGeneration: null, origin: null, url: null })
      expect(notifications).toBe(afterUnsubscribe)
      await expect(fetch(url)).rejects.toThrow()
      await expect(service.start({ ...binding, registry })).rejects.toThrow('Preview service is not available')
    }
    await delay(50)
    expect([...childProcessIds()].filter(pid => !baselineWorkers.has(pid))).toEqual([])
    const retainedHeap = process.memoryUsage().heapUsed - baselineHeap
    expect(retainedHeap).toBeLessThanOrEqual(96 * 1024 * 1024)
  }, 90_000)

  it('rejects registry aliases and escaped paths while retaining the accepted generation', async () => {
    const service = createPreviewRuntime({ repositoryRoot, editorOrigin: 'http://127.0.0.1:4319', executionTrust: 'fixture-only' })
    try {
      const good = await service.start({ ...binding, registry })
      expect(good.status).toBe('ready')
      for (const invalid of [[...registry, registry[1]!], [{ ...registry[0]!, exportName: 'OtherPreview' }, ...registry.slice(1)], [registry[0]!, { ...registry[1]!, entryPath: '../outside.tsx' }, ...registry.slice(2)]]) {
        const bad = await service.rebuild({ ...binding, registry: invalid })
        expect(bad.status).toBe('error')
        expect(bad.url).toBe(good.url)
        expect(bad.activeGeneration).toBe(1)
      }
    } finally { await service.dispose() }
  }, 60_000)

  it('rejects a real malformed source without changing the imported fixture', async () => {
    const fixtureBytes = await readFile(join(repositoryRoot, 'src/PreviewLogin.tsx'), 'utf8')
    const files = await fixtureFiles()
    const options = { repositoryRoot, editorOrigin: 'http://127.0.0.1:4319', executionTrust: 'fixture-only' as const }
    const runtimeBinding = { ...binding, registry }
    await expect(validatePreviewFiles(options, runtimeBinding, files)).resolves.toBeUndefined()
    await expect(validatePreviewFiles(options, runtimeBinding, { ...files, 'src/PreviewLogin.tsx': 'export const PreviewLogin = () => <section>' })).rejects.toThrow()
    await expect(validatePreviewFiles(options, runtimeBinding, { ...files, 'src/PreviewLogin.tsx': "export function CopiedDialog() { return <section role='dialog'><button>Close</button></section> }" })).rejects.toThrow('Component export could not be verified: PreviewLogin')
    await expect(validatePreviewFiles(options, runtimeBinding, { ...files, '../outside.tsx': 'export const Outside = 1' })).rejects.toThrow('repository-relative src files')
    expect(await readFile(join(repositoryRoot, 'src/PreviewLogin.tsx'), 'utf8')).toBe(fixtureBytes)
  }, 60_000)
})
