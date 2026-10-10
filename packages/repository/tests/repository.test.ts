import { mkdtemp, mkdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGitHubCloneRequest } from '../src/index'
import { managedRepositoryPath, RepositoryConnectionStore, RepositoryConnector, type GitCommand } from '../src/node'

const id = '11111111-2222-4333-8444-555555555555'

describe('repository connection', () => {
  it('uses workspace/<id>/repo for managed clones', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canvas-repository-'))
    const commands: GitCommand[] = []
    const connector = new RepositoryConnector(root, async command => {
      commands.push(command)
      const target = command.args.at(-1)
      if (!target) throw new Error('Missing target')
      await mkdir(target, { recursive: true })
      return { stdout: '' }
    }, () => id)
    const connection = await connector.cloneGitHub({ owner: 'shadcn-ui', name: 'ui' })
    expect(connection.repository).toEqual({ id, name: 'ui', source: 'managed-clone' })
    expect(connection.rootPath).toBe(await realpath(path.join(root, 'workspace', id, 'repo')))
    expect(commands).toEqual([{ cwd: path.join(root, 'workspace', id), args: ['clone', '--origin', 'origin', '--', 'https://github.com/shadcn-ui/ui.git', path.join(root, 'workspace', id, 'repo')] }])
  })

  it('connects a selected folder to its repository root without exposing another path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canvas-local-repository-'))
    const nested = path.join(root, 'packages', 'ui')
    await mkdir(nested, { recursive: true })
    const connector = new RepositoryConnector('/unused', async command => {
      expect(command).toEqual({ cwd: await realpath(nested), args: ['rev-parse', '--show-toplevel'] })
      return { stdout: `${root}\n` }
    }, () => id)
    const connection = await connector.connectLocal(nested)
    expect(connection.repository).toEqual({ id, name: path.basename(root), source: 'local' })
    expect(connection.rootPath).toBe(await realpath(root))
  })

  it('cleans only its managed workspace when cloning fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canvas-failed-clone-'))
    const connector = new RepositoryConnector(root, async () => { throw new Error('clone failed') }, () => id)
    await expect(connector.cloneGitHub({ owner: 'owner', name: 'repo' })).rejects.toThrow('clone failed')
    await expect(stat(path.join(root, 'workspace', id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never clones into or removes a pre-existing managed target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canvas-existing-clone-'))
    const target = managedRepositoryPath(root, id)
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'keep.txt'), 'keep')
    let ran = false
    const connector = new RepositoryConnector(root, async () => { ran = true; return { stdout: '' } }, () => id)
    await expect(connector.cloneGitHub({ owner: 'owner', name: 'repo' })).rejects.toThrow('not empty')
    expect(ran).toBe(false)
    expect(await stat(path.join(target, 'keep.txt'))).toBeTruthy()
  })

  it('rejects a managed workspace link that escapes application data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canvas-linked-workspace-'))
    const userData = path.join(root, 'user-data')
    const outside = path.join(root, 'outside')
    await mkdir(userData)
    await mkdir(outside)
    await symlink(outside, path.join(userData, 'workspace'), process.platform === 'win32' ? 'junction' : 'dir')
    let ran = false
    const connector = new RepositoryConnector(userData, async () => { ran = true; return { stdout: '' } }, () => id)
    await expect(connector.cloneGitHub({ owner: 'owner', name: 'repo' })).rejects.toThrow('inside the application data directory')
    expect(ran).toBe(false)
    const localRoot = path.join(root, 'local-repository')
    await mkdir(localRoot)
    const store = new RepositoryConnectionStore(userData)
    await expect(store.write({ repository: { id, name: 'Local', source: 'local' }, rootPath: localRoot })).rejects.toThrow('inside the application data directory')
    await expect(stat(path.join(outside, 'repositories.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { owner: '../escape', name: 'repo' },
    { owner: 'owner', name: '..' },
    { owner: 'https://example.com', name: 'repo' },
    { owner: 'owner', name: 'repo;calc' },
    { owner: 'owner', name: '' },
  ])('rejects unsafe clone input %#', input => {
    expect(() => parseGitHubCloneRequest(input)).toThrow('Invalid GitHub repository.')
  })

  it('rejects traversal repository ids', () => {
    expect(() => managedRepositoryPath('C:/safe', '../../outside')).toThrow('Invalid repository identifier.')
  })

  it('persists a main-process connection and restores its canonical root', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'canvas-saved-repository-'))
    const repositoryRoot = path.join(userData, 'external-repository')
    await mkdir(repositoryRoot)
    const store = new RepositoryConnectionStore(userData)
    const connection = { repository: { id, name: 'External repository', source: 'local' as const }, rootPath: repositoryRoot }
    await store.write(connection)
    expect(await store.read()).toEqual({ ...connection, rootPath: await realpath(repositoryRoot) })
    await store.write({ ...connection, repository: { ...connection.repository, name: 'Renamed repository' } })
    expect((await store.read())?.repository.name).toBe('Renamed repository')
  })

  it('passes cancellation authority to the bounded Git clone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canvas-cancelled-clone-'))
    const controller = new AbortController()
    const connector = new RepositoryConnector(root, command => new Promise((_resolve, reject) => {
      expect(command.signal).toBe(controller.signal)
      if (command.signal?.aborted) reject(new Error('aborted'))
      else command.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }), () => id)
    const pending = connector.cloneGitHub({ owner: 'owner', name: 'repo' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  it('rejects a managed clone whose saved root does not match workspace/<id>/repo', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'canvas-invalid-saved-repository-'))
    const workspace = path.join(userData, 'workspace')
    const outside = path.join(userData, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(path.join(workspace, 'repositories.json'), JSON.stringify({ version: 1, repository: { id, name: 'Wrong root', source: 'managed-clone' }, rootPath: outside }))
    await expect(new RepositoryConnectionStore(userData).read()).rejects.toThrow('Invalid managed repository connection.')
  })

  it('does not commit a cancelled repository persistence transaction', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'canvas-cancelled-store-'))
    const repositoryRoot = path.join(userData, 'local')
    await mkdir(repositoryRoot)
    const controller = new AbortController()
    controller.abort()
    await expect(new RepositoryConnectionStore(userData).write({ repository: { id, name: 'Local', source: 'local' }, rootPath: repositoryRoot }, controller.signal)).rejects.toThrow('cancelled')
    await expect(stat(path.join(userData, 'workspace', 'repositories.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
