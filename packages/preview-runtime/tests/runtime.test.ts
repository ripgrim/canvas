import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPreviewRuntime, validatePreviewFiles } from '../src/index.js'

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const binding = { componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'] }
const registry = ['Card', 'Label', 'Input', 'Button'].map(exportName => ({ componentId: `atom-${exportName.toLowerCase()}`, exportName, entryPath: `src/atoms/${exportName}.tsx` }))

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
      await service.stop()
      expect(service.snapshot().status).toBe('stopped')
      await expect(fetch(good.url!)).rejects.toThrow()
    } finally { await service.dispose() }
  }, 60_000)

  it('rejects registry aliases and escaped paths while retaining the accepted generation', async () => {
    const service = createPreviewRuntime({ repositoryRoot, editorOrigin: 'http://127.0.0.1:4319', executionTrust: 'fixture-only' })
    try {
      const good = await service.start({ ...binding, registry })
      expect(good.status).toBe('ready')
      for (const invalid of [[registry[0]!, registry[0]!], [{ ...registry[0]!, exportName: 'PreviewLogin' }], [{ ...registry[0]!, entryPath: '../outside.tsx' }]]) {
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
    await expect(validatePreviewFiles(options, binding, files)).resolves.toBeUndefined()
    await expect(validatePreviewFiles(options, binding, { ...files, 'src/PreviewLogin.tsx': 'export const PreviewLogin = () => <section>' })).rejects.toThrow()
    await expect(validatePreviewFiles(options, binding, { ...files, '../outside.tsx': 'export const Outside = 1' })).rejects.toThrow('repository-relative src files')
    expect(await readFile(join(repositoryRoot, 'src/PreviewLogin.tsx'), 'utf8')).toBe(fixtureBytes)
  }, 60_000)
})
