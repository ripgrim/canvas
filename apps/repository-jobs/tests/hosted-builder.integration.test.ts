import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { hostedPreviewCatalogFingerprint } from '@canvas/preview-runtime/hosted-artifact'
import { scanShadcnPreviewRegistry } from '@canvas/scanner/preview-registry'
import { createDockerHostedPreviewSandbox } from '../src/hosted-sandbox.js'

describe('hosted preview builder image', () => {
  it('COMP-V2-CODE-012 builds the verified fixture in the real Docker boundary', async () => {
    const image = process.env.HOSTED_PREVIEW_BUILDER_IMAGE
    if (!image) throw new Error('HOSTED_PREVIEW_BUILDER_IMAGE is required for this acceptance test.')
    const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
    const scanned = await scanShadcnPreviewRegistry(repositoryRoot)
    const sourceRevision = 'a'.repeat(40)
    const artifactId = '00000000-0000-4000-8000-000000000901'
    const sandbox = createDockerHostedPreviewSandbox({ image })

    const output = await sandbox.build({
      artifactId,
      repositoryRoot,
      sourceRevision,
      registryFingerprint: hostedPreviewCatalogFingerprint(scanned.request),
      request: scanned.request,
    })

    expect(output.manifest.entrypoint).toBe('index.html')
    expect(output.manifest.sourceRevision).toBe(sourceRevision)
    expect(output.manifest.components).toHaveLength(scanned.request.components.length)
    expect(output.files.get('index.html')?.byteLength).toBeGreaterThan(0)
    expect(output.files.get('assets/components.js')?.byteLength).toBeGreaterThan(0)
  }, 120_000)

  it('COMP-V2-CODE-012 carries verified providers, styles, and assets through Docker', async () => {
    const image = process.env.HOSTED_PREVIEW_BUILDER_IMAGE
    if (!image) throw new Error('HOSTED_PREVIEW_BUILDER_IMAGE is required for this acceptance test.')
    const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/stateful-shadcn-repo')
    const scanned = await scanShadcnPreviewRegistry(repositoryRoot)
    const sandbox = createDockerHostedPreviewSandbox({ image })

    const output = await sandbox.build({
      artifactId: '00000000-0000-4000-8000-000000000902',
      repositoryRoot,
      sourceRevision: 'b'.repeat(40),
      registryFingerprint: hostedPreviewCatalogFingerprint(scanned.request),
      request: scanned.request,
    })

    expect(output.manifest.files.some(file => file.contentType === 'text/css; charset=utf-8')).toBe(true)
    expect(output.manifest.files.some(file => file.contentType === 'image/svg+xml')).toBe(true)
    expect(output.manifest.files.some(file => file.contentType === 'font/woff2')).toBe(true)
    expect(output.manifest.components).toHaveLength(scanned.request.components.length)

    const types = new Map(output.manifest.files.map(file => [file.path, file.contentType]))
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1) || 'index.html')
      const bytes = output.files.get(path)
      if (!bytes) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': types.get(path) ?? 'application/octet-stream' }).end(bytes)
    })
    await new Promise<void>((resolveListen, reject) => server.listen(0, '127.0.0.1', resolveListen).once('error', reject))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Hosted preview test server did not bind.')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`))
      await page.goto(`http://127.0.0.1:${address.port}/index.html`)
      await page.waitForTimeout(250)
      expect(errors).toEqual([])
      await page.getByRole('button', { name: 'Open dialog' }).click()
      expect(await page.getByRole('dialog').count()).toBe(1)
      expect(await page.getByRole('dialog').textContent()).toContain('Registry provider')
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('img[alt="Fixture mark"]')
        return Boolean(image?.complete && image.naturalWidth > 0)
      })
      await page.getByRole('button', { name: 'Close' }).click()
      expect(await page.getByRole('dialog').count()).toBe(0)
      await page.getByRole('button', { name: 'Open dialog' }).click()
      expect(await page.getByRole('dialog').isVisible()).toBe(true)
      await page.keyboard.press('Escape')
      expect(await page.getByRole('dialog').count()).toBe(0)
    } finally {
      await browser.close()
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    }
  }, 120_000)

  it('COMP-V2-CODE-010 rejects changed and undeclared transitive source in Docker', async () => {
    const image = process.env.HOSTED_PREVIEW_BUILDER_IMAGE
    if (!image) throw new Error('HOSTED_PREVIEW_BUILDER_IMAGE is required for this acceptance test.')
    const sourceRoot = resolve(import.meta.dirname, '../../../fixtures/stateful-shadcn-repo')
    const scanned = await scanShadcnPreviewRegistry(sourceRoot)
    const repositoryRoot = await mkdtemp(resolve(tmpdir(), 'canvas-hosted-builder-'))
    await cp(sourceRoot, repositoryRoot, { recursive: true, filter: source => !source.replaceAll('\\', '/').includes('/node_modules') })
    const sandbox = createDockerHostedPreviewSandbox({ image })
    try {
      const contextPath = 'src/preview/context.tsx'
      expect(scanned.request.dependencies?.some(dependency => dependency.path === contextPath)).toBe(true)
      const incomplete = {
        ...scanned.request,
        dependencies: (scanned.request.dependencies ?? []).filter(dependency => dependency.path !== contextPath),
        resolutions: (scanned.request.resolutions ?? []).filter(resolution => resolution.path !== contextPath),
      }
      await expect(sandbox.build({
        artifactId: '00000000-0000-4000-8000-000000000903',
        repositoryRoot,
        sourceRevision: 'c'.repeat(40),
        registryFingerprint: hostedPreviewCatalogFingerprint(incomplete),
        request: incomplete,
      })).rejects.toThrow('undeclared')

      const original = await readFile(resolve(repositoryRoot, contextPath), 'utf8')
      await writeFile(resolve(repositoryRoot, contextPath), `${original}\nexport const changedAfterScan = true\n`, 'utf8')
      await expect(sandbox.build({
        artifactId: '00000000-0000-4000-8000-000000000904',
        repositoryRoot,
        sourceRevision: 'd'.repeat(40),
        registryFingerprint: hostedPreviewCatalogFingerprint(scanned.request),
        request: scanned.request,
      })).rejects.toThrow('integrity changed')
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it('COMP-V2-CODE-010 ignores aliases owned by another workspace', async () => {
    const image = process.env.HOSTED_PREVIEW_BUILDER_IMAGE
    if (!image) throw new Error('HOSTED_PREVIEW_BUILDER_IMAGE is required for this acceptance test.')
    const repositoryRoot = await mkdtemp(resolve(tmpdir(), 'canvas-hosted-builder-scoped-alias-'))
    try {
      for (const workspace of ['apps/web', 'packages/ui']) {
        await mkdir(resolve(repositoryRoot, workspace, 'src/components/ui'), { recursive: true })
        await writeFile(resolve(repositoryRoot, workspace, 'package.json'), JSON.stringify({ name: `@acme/${workspace.endsWith('web') ? 'web' : 'ui'}`, private: true }), 'utf8')
        await writeFile(resolve(repositoryRoot, workspace, 'src/styles.css'), ':root { --surface: #fff; }\n', 'utf8')
      }
      await writeFile(resolve(repositoryRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }), 'utf8')
      await writeFile(resolve(repositoryRoot, 'apps/web/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }), 'utf8')
      await writeFile(resolve(repositoryRoot, 'packages/ui/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'react/*': ['./src/react/*'] } } }), 'utf8')
      await writeFile(resolve(repositoryRoot, 'apps/web/src/components/ui/button.tsx'), `export function Button() { return <button>Scoped alias build</button> }\n`, 'utf8')
      await writeFile(resolve(repositoryRoot, 'packages/ui/src/components/ui/card.tsx'), `export function Card() { return null }\n`, 'utf8')
      const scanned = await scanShadcnPreviewRegistry(repositoryRoot)
      const sandbox = createDockerHostedPreviewSandbox({ image })

      const output = await sandbox.build({
        artifactId: '00000000-0000-4000-8000-000000000905',
        repositoryRoot,
        sourceRevision: 'e'.repeat(40),
        registryFingerprint: hostedPreviewCatalogFingerprint(scanned.request),
        request: scanned.request,
      })

      expect(output.files.get('assets/components.js')?.byteLength).toBeGreaterThan(0)
      expect(Buffer.from(output.files.get('assets/components.js') ?? []).toString('utf8')).toContain('Scoped alias build')
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
