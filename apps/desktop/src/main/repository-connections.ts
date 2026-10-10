import type { ShadcnScan } from '@canvas/scanner/contracts'
import { RepositoryConnectionStore, RepositoryConnector, createGitRunner } from '@canvas/repository/node'
import type { ConnectedRepository, GitHubCloneRequest, RepositoryConnection } from '@canvas/repository'
import { ScannerProcess } from './scanner-process'

export type ConnectedRepositoryScan = Readonly<{ repository: ConnectedRepository; scan: ShadcnScan }>

export class RepositoryConnections {
  private readonly connector: RepositoryConnector
  private readonly store: RepositoryConnectionStore
  private current: RepositoryConnection | null = null
  private lastScan: ShadcnScan | null = null
  private scanner: ScannerProcess | null = null
  private activeOperation: AbortController | null = null
  private disposed = false

  constructor(userDataRoot: string, private readonly scannerWorkerPath: string, gitExecutable = 'git') {
    this.connector = new RepositoryConnector(userDataRoot, createGitRunner(gitExecutable))
    this.store = new RepositoryConnectionStore(userDataRoot)
  }

  async start(): Promise<void> {
    try {
      const saved = await this.store.read()
      this.current = saved ? await this.connector.validate(saved) : null
    } catch {
      this.current = null
    }
  }

  async connectLocal(selectedPath: string): Promise<ConnectedRepositoryScan> {
    return this.runExclusive(async signal => this.activate(await this.connector.connectLocal(selectedPath, signal), signal))
  }

  async cloneGitHub(input: GitHubCloneRequest): Promise<ConnectedRepositoryScan> {
    return this.runExclusive(async signal => {
      const connection = await this.connector.cloneGitHub(input, signal)
      try {
        return await this.activate(connection, signal)
      } catch (error) {
        await this.connector.discardManaged(connection).catch(() => undefined)
        throw error
      }
    })
  }

  async getCurrent(): Promise<ConnectedRepositoryScan | null> {
    if (!this.current) return null
    return this.lastScan ? { repository: this.current.repository, scan: this.lastScan } : this.scanCurrent()
  }

  async scanCurrent(): Promise<ConnectedRepositoryScan> {
    return this.runExclusive(async () => {
      if (!this.current) throw new Error('Connect a repository first.')
      const scan = await this.scan(this.current)
      this.lastScan = scan
      return { repository: this.current.repository, scan }
    })
  }

  dispose(): void {
    this.disposed = true
    this.activeOperation?.abort()
    this.activeOperation = null
    this.scanner?.dispose()
    this.scanner = null
    this.current = null
    this.lastScan = null
  }

  private async activate(connection: RepositoryConnection, signal: AbortSignal): Promise<ConnectedRepositoryScan> {
    const scan = await this.scan(connection)
    if (signal.aborted) throw new Error('Repository operation was cancelled.')
    await this.store.write(connection, signal)
    if (signal.aborted) throw new Error('Repository operation was cancelled.')
    this.current = connection
    this.lastScan = scan
    return { repository: connection.repository, scan }
  }

  private async scan(connection: RepositoryConnection): Promise<ShadcnScan> {
    this.scanner?.dispose()
    const scanner = new ScannerProcess(this.scannerWorkerPath, connection.rootPath)
    this.scanner = scanner
    try {
      return await scanner.scan()
    } finally {
      if (this.scanner === scanner) this.scanner = null
    }
  }

  private async runExclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('Repository connection service is unavailable.')
    if (this.activeOperation) throw new Error('Another repository operation is already running.')
    const controller = new AbortController()
    this.activeOperation = controller
    try {
      return await operation(controller.signal)
    } finally {
      if (this.activeOperation === controller) this.activeOperation = null
    }
  }
}
