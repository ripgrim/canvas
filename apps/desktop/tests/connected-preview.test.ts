import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyFileCommand, createBlankFile } from '@canvas/repo-engine/file-document'
import { scanShadcnPreviewRegistry } from '@canvas/scanner/preview-registry'
import type { RepositoryConnection } from '@canvas/repository'
import { ConnectedRegistryStore } from '../src/main/connected-registry.js'
import { ConnectedPreviewService, connectedRegistryAtoms } from '../src/main/connected-preview.js'

const temporary: string[] = []

async function loginFormFixture(): Promise<string> {
  const base = path.join(process.cwd(), '.tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(path.join(base, 'connected-login-form-'))
  temporary.push(root)
  await mkdir(path.join(root, 'src/components/ui'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'connected-login-form', private: true, dependencies: { react: '19.3.0', 'react-dom': '19.3.0' } }), 'utf8')
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'connected-login-form', lockfileVersion: 3, packages: { '': { dependencies: { react: '19.3.0', 'react-dom': '19.3.0' } }, 'node_modules/react': { version: '19.3.0' }, 'node_modules/react-dom': { version: '19.3.0' }, 'node_modules/scheduler': { version: '0.28.0' } } }), 'utf8')
  await writeFile(path.join(root, 'components.json'), JSON.stringify({ aliases: { ui: '@/components/ui' }, tailwind: { css: 'src/globals.css' } }), 'utf8')
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '@/*': ['./src/*'] } } }), 'utf8')
  await writeFile(path.join(root, 'src/components/ui/LoginForm.tsx'), `import React from 'react'\nimport 'react-dom/client'\nexport function LoginForm() { return <form data-testid="login-form">Sign in</form> }\n`, 'utf8')
  await writeFile(path.join(root, 'src/globals.css'), ':root { --background: #ffffff; }\n', 'utf8')
  return root
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('connected desktop preview', () => {
  it('[AT-P0-001][AT-COMP-001][AT-PRV-001] inserts the generated LoginForm identity and serves its verified build', async () => {
    const repositoryRoot = await loginFormFixture()
    const userDataRoot = await mkdtemp(path.join(process.cwd(), '.tmp', 'connected-login-data-'))
    temporary.push(userDataRoot)
    const generated = await scanShadcnPreviewRegistry(repositoryRoot)
    expect(generated.request.components).toEqual([expect.objectContaining({ exportName: 'LoginForm', props: {}, slots: [] })])
    const connection: RepositoryConnection = { repository: { id: 'login-form', name: 'Login form', source: 'local' }, rootPath: repositoryRoot }
    const registryStore = new ConnectedRegistryStore(userDataRoot)
    const registry = await registryStore.install(connection, generated.scan, generated.request)
    const atoms = connectedRegistryAtoms(registry)
    const componentId = generated.request.entry.componentId
    expect(atoms.map(atom => atom.componentId)).toEqual([componentId])

    let file = createBlankFile('file-login', 'page-login', 'root-login', 'Login')
    file = applyFileCommand(file, { type: 'node.insert', node: { id: 'login-form', type: 'component', componentId, exportName: 'LoginForm', props: {} }, placement: { parentId: 'root-login' } }, atoms)
    expect(() => applyFileCommand(file, { type: 'node.insert', node: { id: 'unknown', type: 'component', componentId: 'not-in-registry', exportName: 'Unknown', props: {} }, placement: { parentId: 'root-login' } }, atoms)).toThrow('Component binding needs review')

    const service = new ConnectedPreviewService('http://127.0.0.1:4317')
    try {
      await service.activate(registry)
      const snapshot = await service.project(file)
      expect(snapshot).toMatchObject({ status: 'ready', stale: false, origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) })
      const html = await fetch(snapshot.url!).then(response => { expect(response.status).toBe(200); return response.text() })
      const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1]
      expect(script).toMatch(/^\/connected\/\d+\/build\/\d+\/assets\/.+\.js$/)
      const source = await fetch(new URL(script!, snapshot.origin!)).then(response => { expect(response.status).toBe(200); return response.text() })
      expect(source).toContain('data-testid')
      expect(source).toContain('login-form')

      await writeFile(path.join(repositoryRoot, 'src/components/ui/LoginForm.tsx'), `import React from 'react'\nimport 'react-dom/client'\nexport function LoginForm() { return <form data-testid="login-form">Rescanned</form> }\n`, 'utf8')
      const rescanned = await scanShadcnPreviewRegistry(repositoryRoot)
      const rescannedRegistry = await registryStore.install(connection, rescanned.scan, rescanned.request)
      const restarted = await service.activate(rescannedRegistry)
      expect(restarted.url).not.toBe(snapshot.url)
      expect(service.registry()?.fingerprint).toBe(rescannedRegistry.fingerprint)

      const lastGood = service.snapshot()
      await writeFile(path.join(repositoryRoot, 'src/components/ui/LoginForm.tsx'), `import React from 'react'\nimport 'react-dom/client'\nexport function LoginForm() { return <main>Changed after rescan</main> }\n`, 'utf8')
      await expect(service.project(file)).rejects.toThrow('changed after the registry was generated')
      expect(service.snapshot()).toEqual(lastGood)
      await expect(service.activate(rescannedRegistry)).rejects.toThrow('changed after the registry was generated')
      expect(service.snapshot()).toEqual(lastGood)
      await expect(fetch(lastGood.url!)).resolves.toMatchObject({ status: 200 })
    } finally {
      await service.dispose()
    }
  }, 30_000)

  it('[FILE-ASSET-LIFECYCLE-001] refuses to silently omit image bytes from a connected preview', async () => {
    const repositoryRoot = await loginFormFixture()
    const userDataRoot = await mkdtemp(path.join(process.cwd(), '.tmp', 'connected-image-data-'))
    temporary.push(userDataRoot)
    const generated = await scanShadcnPreviewRegistry(repositoryRoot)
    const connection: RepositoryConnection = { repository: { id: 'login-form-image', name: 'Login form image', source: 'local' }, rootPath: repositoryRoot }
    const registry = await new ConnectedRegistryStore(userDataRoot).install(connection, generated.scan, generated.request)
    let file = createBlankFile('file-image', 'page-image', 'root-image', 'Image')
    file = applyFileCommand(file, {
      type: 'asset.attach',
      asset: { id: 'photo', name: 'photo.png', mime: 'image/png', extension: 'png', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) },
    }, [])
    file = applyFileCommand(file, {
      type: 'node.insert',
      node: {
        id: 'frame-image', type: 'frame', name: 'Frame',
        styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 100 },
        appearance: { fills: [{ id: 'fill-image', type: 'image', assetId: 'photo', fit: 'cover' }] },
      },
      placement: { parentId: 'root-image' },
    }, [])

    const service = new ConnectedPreviewService('http://127.0.0.1:4317')
    try {
      await service.activate(registry)
      await expect(service.project(file)).rejects.toThrow('Images in a connected repository preview are unavailable until their bytes are loaded.')
    } finally {
      await service.dispose()
    }
  }, 30_000)
})
