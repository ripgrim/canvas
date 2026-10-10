import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseGitHubCloneRequest, type ConnectedRepository, type GitHubCloneRequest, type RepositoryConnection } from './index.js'

export type GitCommand = Readonly<{ cwd: string; args: readonly string[]; signal?: AbortSignal }>
export type GitRunner = (command: GitCommand) => Promise<Readonly<{ stdout: string }>>

const cloneUrl = ({ owner, name }: GitHubCloneRequest) => `https://github.com/${owner}/${name}.git`

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key]
  return env
}

export function createGitRunner(executable = 'git'): GitRunner {
  return (command) => new Promise((resolve, reject) => {
    const { cwd, args } = command
    if (args.length > 32 || args.some(argument => argument.length > 2048 || argument.includes('\0'))) return reject(new Error('Invalid Git command.'))
    const child = spawn(executable, [...args], { cwd, env: safeEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(command.signal ? { signal: command.signal } : {}) })
    let stdout = ''
    let stderr = ''
    let finished = false
    const timeout = setTimeout(() => { if (!finished) { finished = true; child.kill(); reject(new Error('Git command timed out.')) } }, 5 * 60_000)
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 64_000) stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_000) stderr += chunk.toString() })
    child.once('error', error => { if (finished) return; finished = true; clearTimeout(timeout); reject(error) })
    child.once('exit', code => { if (finished) return; finished = true; clearTimeout(timeout); code === 0 ? resolve({ stdout }) : reject(new Error(stderr.trim() || `Git exited with code ${code ?? 'unknown'}.`)) })
  })
}

function repositoryName(root: string) {
  return path.basename(root).replace(/\.git$/i, '') || 'Repository'
}

function ensureRepositoryId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid repository identifier.')
  return value
}

export function managedRepositoryPath(userDataRoot: string, repositoryId: string): string {
  const id = ensureRepositoryId(repositoryId)
  const workspaceRoot = path.resolve(userDataRoot, 'workspace')
  const target = path.resolve(workspaceRoot, id, 'repo')
  if (path.relative(workspaceRoot, target).startsWith('..')) throw new Error('Invalid managed repository path.')
  return target
}

async function canonicalManagedWorkspace(userDataRoot: string): Promise<string> {
  const requestedUserData = path.resolve(userDataRoot)
  const requestedWorkspace = path.join(requestedUserData, 'workspace')
  await mkdir(requestedWorkspace, { recursive: true })
  const canonicalUserData = await realpath(requestedUserData)
  const canonicalWorkspace = await realpath(requestedWorkspace)
  if (path.relative(canonicalUserData, canonicalWorkspace) !== 'workspace') throw new Error('Managed workspace must be inside the application data directory.')
  return canonicalWorkspace
}

function command(cwd: string, args: readonly string[], signal?: AbortSignal): GitCommand {
  return { cwd, args, ...(signal ? { signal } : {}) }
}

function parseStoredConnection(value: unknown, userDataRoot: string): RepositoryConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved repository connection.')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'repository,rootPath,version' || record.version !== 1 || typeof record.rootPath !== 'string' || !path.isAbsolute(record.rootPath)) throw new Error('Invalid saved repository connection.')
  const repository = record.repository
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) throw new Error('Invalid saved repository connection.')
  const summary = repository as Record<string, unknown>
  if (Object.keys(summary).sort().join(',') !== 'id,name,source' || typeof summary.id !== 'string' || typeof summary.name !== 'string' || !['local', 'managed-clone'].includes(String(summary.source))) throw new Error('Invalid saved repository connection.')
  ensureRepositoryId(summary.id)
  if (!summary.name || summary.name.length > 200 || /[\u0000-\u001f]/.test(summary.name)) throw new Error('Invalid saved repository connection.')
  const connection: RepositoryConnection = { repository: { id: summary.id, name: summary.name, source: summary.source as 'local' | 'managed-clone' }, rootPath: path.resolve(record.rootPath) }
  if (connection.repository.source === 'managed-clone' && path.relative(managedRepositoryPath(userDataRoot, connection.repository.id), path.resolve(connection.rootPath)) !== '') throw new Error('Invalid managed repository connection.')
  return connection
}

export class RepositoryConnectionStore {
  constructor(private readonly userDataRoot: string) {}

  async read(): Promise<RepositoryConnection | null> {
    try {
      const file = path.join(await canonicalManagedWorkspace(this.userDataRoot), 'repositories.json')
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      const connection = parseStoredConnection(parsed, this.userDataRoot)
      return { repository: connection.repository, rootPath: await realpath(connection.rootPath) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async write(connection: RepositoryConnection, signal?: AbortSignal): Promise<void> {
    const validated = parseStoredConnection({ version: 1, repository: connection.repository, rootPath: connection.rootPath }, this.userDataRoot)
    const workspaceRoot = await canonicalManagedWorkspace(this.userDataRoot)
    const file = path.join(workspaceRoot, 'repositories.json')
    const previous = await readFile(file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    const temporary = path.join(workspaceRoot, `.repositories-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, repository: validated.repository, rootPath: validated.rootPath }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      if (signal?.aborted) throw new Error('Repository operation was cancelled.')
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
    if (signal?.aborted) {
      if (previous === null) await rm(file, { force: true })
      else {
        const rollback = path.join(workspaceRoot, `.repositories-${randomUUID()}.rollback`)
        try {
          await writeFile(rollback, previous, { flag: 'wx', mode: 0o600 })
          await rename(rollback, file)
        } finally {
          await rm(rollback, { force: true })
        }
      }
      throw new Error('Repository operation was cancelled.')
    }
  }
}

async function assertEmptyTarget(target: string): Promise<void> {
  try {
    const information = await stat(target)
    if (!information.isDirectory() || (await readdir(target)).length > 0) throw new Error('Managed repository target is not empty.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function removeFailedWorkspace(workspaceRoot: string, allocatedRoot: string): Promise<void> {
  try {
    const canonicalWorkspace = await realpath(workspaceRoot)
    const canonicalAllocated = await realpath(allocatedRoot)
    const relative = path.relative(canonicalWorkspace, canonicalAllocated)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return
    await rm(canonicalAllocated, { recursive: true, force: true })
  } catch { return }
}

export class RepositoryConnector {
  constructor(
    private readonly userDataRoot: string,
    private readonly runGit: GitRunner = createGitRunner(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async connectLocal(selectedPath: string, signal?: AbortSignal): Promise<RepositoryConnection> {
    const selected = await realpath(selectedPath)
    const result = await this.runGit(command(selected, ['rev-parse', '--show-toplevel'], signal))
    const root = await realpath(result.stdout.trim())
    const relative = path.relative(root, selected)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Selected folder is outside the repository.')
    const repository: ConnectedRepository = { id: this.createId(), name: repositoryName(root), source: 'local' }
    return { repository, rootPath: root }
  }

  async validate(connection: RepositoryConnection, signal?: AbortSignal): Promise<RepositoryConnection> {
    const root = await realpath(connection.rootPath)
    const result = await this.runGit(command(root, ['rev-parse', '--show-toplevel'], signal))
    const reported = await realpath(result.stdout.trim())
    if (path.relative(root, reported) !== '') throw new Error('Saved repository root changed.')
    if (connection.repository.source === 'managed-clone' && path.relative(managedRepositoryPath(this.userDataRoot, connection.repository.id), root) !== '') throw new Error('Managed repository root changed.')
    return { repository: connection.repository, rootPath: root }
  }

  async cloneGitHub(input: GitHubCloneRequest, signal?: AbortSignal): Promise<RepositoryConnection> {
    const request = parseGitHubCloneRequest(input)
    const id = this.createId()
    const workspaceRoot = await canonicalManagedWorkspace(this.userDataRoot)
    const target = path.join(workspaceRoot, id, 'repo')
    const parent = path.dirname(target)
    await assertEmptyTarget(target)
    await mkdir(parent, { recursive: true })
    try {
      await this.runGit(command(parent, ['clone', '--origin', 'origin', '--', cloneUrl(request), target], signal))
      const root = await realpath(target)
      return { repository: { id, name: request.name, source: 'managed-clone' }, rootPath: root }
    } catch (error) {
      await removeFailedWorkspace(workspaceRoot, path.resolve(parent))
      throw error
    }
  }

  async discardManaged(connection: RepositoryConnection): Promise<void> {
    if (connection.repository.source !== 'managed-clone') return
    const workspaceRoot = await canonicalManagedWorkspace(this.userDataRoot)
    const expected = path.join(workspaceRoot, connection.repository.id, 'repo')
    const canonicalRoot = await realpath(connection.rootPath)
    if (path.relative(expected, canonicalRoot) !== '') throw new Error('Managed repository root changed.')
    await removeFailedWorkspace(workspaceRoot, path.dirname(canonicalRoot))
  }
}
