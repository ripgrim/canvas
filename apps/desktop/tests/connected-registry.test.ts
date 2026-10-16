import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyComponentRegistry } from '@canvas/preview-runtime/verified-registry'
import { scanShadcnPreviewRegistry } from '@canvas/scanner/preview-registry'
import type { RepositoryConnection } from '@canvas/repository'
import { ConnectedRegistryStore } from '../src/main/connected-registry.js'
import { RepositoryConnections } from '../src/main/repository-connections.js'

const temporary: string[] = []
const run = promisify(execFile)

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'design-editor-connected-registry-source-'))
  temporary.push(root)
  await mkdir(path.join(root, 'src/components/ui'), { recursive: true })
  const dependencies = { react: '19.3.0', 'react-dom': '19.3.0' }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'connected-fixture', private: true, dependencies }), 'utf8')
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'connected-fixture',
    lockfileVersion: 3,
    packages: {
      '': { dependencies },
      'node_modules/react': { version: dependencies.react },
      'node_modules/react-dom': { version: dependencies['react-dom'] },
    },
  }), 'utf8')
  const dependencySource = await realpath(path.resolve(import.meta.dirname, '../../../fixtures/component-repo/node_modules'))
  await symlink(dependencySource, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path.join(root, 'components.json'), JSON.stringify({ aliases: { ui: '@/components/ui' }, tailwind: { css: 'src/globals.css' } }), 'utf8')
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }), 'utf8')
  await writeFile(path.join(root, 'src/components/ui/card.tsx'), `type CardProps = { title?: string }\nexport function Card({ title }: CardProps) { return <article>{title}</article> }\n`, 'utf8')
  await writeFile(path.join(root, 'src/globals.css'), ':root { --card: #ffffff; }\n', 'utf8')
  return root
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('connected repository registry handoff', () => {
  it('[AT-P0-001][AT-PRV-001] persists one verified manifest outside the repository for both preview consumers', async () => {
    const repositoryRoot = await fixture()
    const userDataRoot = await mkdtemp(path.join(tmpdir(), 'design-editor-connected-registry-data-'))
    temporary.push(userDataRoot)
    const before = await repositoryBytes(repositoryRoot)
    const generated = await scanShadcnPreviewRegistry(repositoryRoot)
    const connection: RepositoryConnection = { repository: { id: 'local-fixture', name: 'Fixture', source: 'local' }, rootPath: repositoryRoot }

    const installed = await new ConnectedRegistryStore(userDataRoot).install(connection, generated.scan, generated.request)

    expect(path.relative(repositoryRoot, installed.manifestPath).startsWith('..')).toBe(true)
    expect(installed.binding.componentId).toBe(generated.request.entry.componentId)
    expect(installed.binding.registry).toHaveLength(1)
    expect(installed.binding.registry?.[0]).toMatchObject({ props: { title: { kind: 'string', optional: true } }, slots: [] })
    expect(installed.catalog.components[0]).toMatchObject({ componentId: generated.request.entry.componentId, exportName: 'Card', props: [{ name: 'title', type: 'string | undefined', optional: true }], slots: [] })
    expect((installed.binding as typeof installed.binding & { aliases?: unknown[] }).aliases).toHaveLength(1)
    expect(await repositoryBytes(repositoryRoot)).toEqual(before)
    await expect(verifyComponentRegistry(repositoryRoot, generated.request)).resolves.toMatchObject({ fingerprint: installed.fingerprint })
  })

  it('[AT-P0-001] rejects a stale request and refreshes the manifest fingerprint after source changes', async () => {
    const repositoryRoot = await fixture()
    const userDataRoot = await mkdtemp(path.join(tmpdir(), 'design-editor-connected-registry-refresh-'))
    temporary.push(userDataRoot)
    const connection: RepositoryConnection = { repository: { id: 'refresh-fixture', name: 'Fixture', source: 'local' }, rootPath: repositoryRoot }
    const store = new ConnectedRegistryStore(userDataRoot)
    const first = await scanShadcnPreviewRegistry(repositoryRoot)
    const installed = await store.install(connection, first.scan, first.request)

    await writeFile(path.join(repositoryRoot, 'src/components/ui/card.tsx'), `type CardProps = { title?: string }\nexport function Card({ title }: CardProps) { return <section>{title}</section> }\n`, 'utf8')

    await expect(store.install(connection, first.scan, first.request)).rejects.toThrow('changed after the registry was generated')
    const refreshed = await scanShadcnPreviewRegistry(repositoryRoot)
    const current = await store.install(connection, refreshed.scan, refreshed.request)
    expect(current.fingerprint).not.toBe(installed.fingerprint)
  })

  it('[AT-PRV-001] refreshes the verified handoff on connect, rescan, and saved-connection startup', async () => {
    const repositoryRoot = await fixture()
    const userDataRoot = await mkdtemp(path.join(tmpdir(), 'design-editor-connected-registry-connections-'))
    temporary.push(userDataRoot)
    await run('git', ['init'], { cwd: repositoryRoot })
    const fingerprints: string[] = []
    const scannerFactory = (_workerPath: string, root: string) => ({
      scan: () => scanShadcnPreviewRegistry(root),
      dispose: () => undefined,
    })
    const connections = new RepositoryConnections(userDataRoot, 'unused-worker.js', 'git', registry => { fingerprints.push(registry.fingerprint) }, scannerFactory)

    await connections.connectLocal(repositoryRoot)
    expect(fingerprints).toHaveLength(1)
    await writeFile(path.join(repositoryRoot, 'src/components/ui/card.tsx'), `type CardProps = { title?: string }\nexport function Card({ title }: CardProps) { return <aside>{title}</aside> }\n`, 'utf8')
    await connections.scanCurrent()
    expect(fingerprints).toHaveLength(2)
    expect(fingerprints[1]).not.toBe(fingerprints[0])
    connections.dispose()

    const restored = new RepositoryConnections(userDataRoot, 'unused-worker.js', 'git', registry => { fingerprints.push(registry.fingerprint) }, scannerFactory)
    await restored.start()
    expect(fingerprints).toHaveLength(3)
    expect(fingerprints[2]).toBe(fingerprints[1])
    restored.dispose()
  })

  it('[AT-PRV-001] retains the last published registry when a rescan restart fails', async () => {
    const repositoryRoot = await fixture()
    const userDataRoot = await mkdtemp(path.join(tmpdir(), 'design-editor-connected-registry-last-good-'))
    temporary.push(userDataRoot)
    await run('git', ['init'], { cwd: repositoryRoot })
    let rejectRestart = false
    const scannerFactory = (_workerPath: string, root: string) => ({
      scan: () => scanShadcnPreviewRegistry(root),
      dispose: () => undefined,
    })
    const connections = new RepositoryConnections(userDataRoot, 'unused-worker.js', 'git', () => {
      if (rejectRestart) throw new Error('Candidate preview failed.')
    }, scannerFactory)

    const first = await connections.connectLocal(repositoryRoot)
    await writeFile(path.join(repositoryRoot, 'src/components/ui/card.tsx'), `type CardProps = { title?: string }\nexport function Card({ title }: CardProps) { return <aside>{title}</aside> }\n`, 'utf8')
    rejectRestart = true
    await expect(connections.scanCurrent()).rejects.toThrow('Candidate preview failed.')
    expect((await connections.getCurrent())?.registry.fingerprint).toBe(first.registry.fingerprint)
    connections.dispose()
  })
})

async function repositoryBytes(root: string, directory = ''): Promise<Record<string, string>> {
  const output: Record<string, string> = {}
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!directory && entry.name === 'node_modules') continue
    const relative = path.posix.join(directory.replaceAll('\\', '/'), entry.name)
    if (entry.isDirectory()) Object.assign(output, await repositoryBytes(root, relative))
    else output[relative] = (await readFile(path.join(root, relative))).toString('base64')
  }
  return output
}
