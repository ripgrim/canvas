import type { ShadcnComponentCatalog, ShadcnScan } from '@canvas/scanner/contracts'
import { RepositoryConnectionStore, RepositoryConnector, createGitRunner } from '@canvas/repository/node'
import type { ConnectedRepository, GitHubCloneRequest, RepositoryConnection } from '@canvas/repository'
import { ScannerProcess } from './scanner-process'
import type { ScannerResult } from './scanner-process'
import { ConnectedRegistryStore, type ConnectedRepositoryRegistry } from './connected-registry'

export type ConnectedRepositoryScan = Readonly<{ repository: ConnectedRepository; scan: ShadcnScan; registry: ShadcnComponentCatalog }>
type Scanner = Pick<ScannerProcess, 'scan' | 'dispose'>
type ScannerFactory = (workerPath: string, root: string) => Scanner

export class RepositoryConnections {
  private readonly connector: RepositoryConnector
  private readonly store: RepositoryConnectionStore
  private readonly registryStore: ConnectedRegistryStore
  private current: RepositoryConnection | null = null
  private lastScan: ShadcnScan | null = null
  private activeRegistry: ConnectedRepositoryRegistry | null = null
  private scanner: Scanner | null = null
  private activeOperation: AbortController | null = null
  private startError: Error | null = null
  private disposed = false

  constructor(
    userDataRoot: string,
    private readonly scannerWorkerPath: string,
    gitExecutable = 'git',
    private readonly registryChanged?: (registry: ConnectedRepositoryRegistry) => Promise<void> | void,
    private readonly scannerFactory: ScannerFactory = (workerPath, root) => new ScannerProcess(workerPath, root),
  ) {
    this.connector = new RepositoryConnector(userDataRoot, createGitRunner(gitExecutable))
    this.store = new RepositoryConnectionStore(userDataRoot)
    this.registryStore = new ConnectedRegistryStore(userDataRoot)
  }

  async start(): Promise<void> {
    try {
      const saved = await this.store.read()
      this.current = saved ? await this.connector.validate(saved) : null
      if (this.current) {
        const result = await this.scan(this.current)
        const registry = await this.registryStore.install(this.current, result.scan, result.request)
        await this.publishScan(this.current, result, registry)
      }
    } catch (error) {
      this.current = null
      this.startError = error instanceof Error ? error : new Error('The saved repository connection could not be restored.')
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
        try { await this.connector.discardManaged(connection) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'The repository connection and cleanup both failed.') }
        throw error
      }
    })
  }

  async getCurrent(): Promise<ConnectedRepositoryScan | null> {
    if (this.startError) throw this.startError
    if (!this.current) return null
    return this.lastScan && this.activeRegistry ? { repository: this.current.repository, scan: this.lastScan, registry: this.activeRegistry.catalog } : this.scanCurrent()
  }

  async scanCurrent(): Promise<ConnectedRepositoryScan> {
    return this.runExclusive(async () => {
      if (!this.current) throw new Error('Connect a repository first.')
      const result = await this.scan(this.current)
      const registry = await this.registryStore.install(this.current, result.scan, result.request)
      await this.publishScan(this.current, result, registry)
      return { repository: this.current.repository, scan: result.scan, registry: registry.catalog }
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
    this.activeRegistry = null
  }

  private async activate(connection: RepositoryConnection, signal: AbortSignal): Promise<ConnectedRepositoryScan> {
    const result = await this.scan(connection)
    if (signal.aborted) throw new Error('Repository operation was cancelled.')
    const registry = await this.registryStore.install(connection, result.scan, result.request, signal)
    await this.store.write(connection, signal)
    if (signal.aborted) throw new Error('Repository operation was cancelled.')
    await this.publishScan(connection, result, registry, signal)
    this.startError = null
    return { repository: connection.repository, scan: result.scan, registry: registry.catalog }
  }

  private async scan(connection: RepositoryConnection): Promise<ScannerResult> {
    this.scanner?.dispose()
    const scanner = this.scannerFactory(this.scannerWorkerPath, connection.rootPath)
    this.scanner = scanner
    try {
      return await scanner.scan()
    } finally {
      if (this.scanner === scanner) this.scanner = null
    }
  }

  private async publishScan(connection: RepositoryConnection, result: ScannerResult, registry: ConnectedRepositoryRegistry, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.registryChanged?.(registry)
    signal?.throwIfAborted()
    this.current = connection
    this.lastScan = result.scan
    this.activeRegistry = registry
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
