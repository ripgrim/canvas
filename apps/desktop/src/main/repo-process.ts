import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import type { RepositoryRequest, RepositoryResponse, RepositoryResult } from '../preload/contracts'

type Pending = { resolve(value: RepositoryResult): void; reject(reason: Error): void; timeout: ReturnType<typeof setTimeout> }

export class RepositoryProcess {
  private worker: UtilityProcess | undefined
  private sequence = 0
  private pending = new Map<number, Pending>()

  constructor(private readonly workerPath: string, private readonly root: string) {}

  start(): Promise<void> {
    if (this.worker) throw new Error('Repository service already started.')
    return new Promise((resolve, reject) => {
      const env: Record<string, string> = { NODE_ENV: 'production' }
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
        if (process.env[key]) env[key] = process.env[key]
      }
      const worker = utilityProcess.fork(this.workerPath, [this.root], { env, serviceName: 'Design editor repository', stdio: 'pipe' })
      let startupDiagnostics = ''
      let ready = false
      worker.stderr?.on('data', (chunk: Buffer) => { if (!ready && startupDiagnostics.length < 4000) startupDiagnostics += chunk.toString() })
      this.worker = worker
      const startupTimeout = setTimeout(() => { this.dispose(); reject(new Error('Repository service did not start.')) }, 30_000)
      worker.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return
        const response = message as { ready?: boolean; id?: number; result?: RepositoryResponse }
        if (response.ready === true) { ready = true; startupDiagnostics = ''; clearTimeout(startupTimeout); resolve(); return }
        if (typeof response.id !== 'number' || !response.result) return
        const pending = this.pending.get(response.id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pending.delete(response.id)
        if (response.result.ok) pending.resolve(response.result.value)
        else pending.reject(new Error(response.result.error))
      })
      worker.on('exit', () => {
        clearTimeout(startupTimeout)
        this.worker = undefined
        this.rejectPending()
        reject(new Error(`Repository service stopped.${startupDiagnostics ? ` ${startupDiagnostics}` : ''}`))
      })
    })
  }

  execute(request: RepositoryRequest): Promise<RepositoryResult> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('Repository service is unavailable.'))
    if (this.pending.size >= 16) return Promise.reject(new Error('Too many repository commands.'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The repository command timed out. Refresh before continuing.'))
      }, 60_000)
      this.pending.set(id, { resolve, reject, timeout })
      worker.postMessage({ id, request })
    })
  }

  dispose(): void {
    this.worker?.kill()
    this.worker = undefined
    this.rejectPending()
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Repository service stopped.'))
    }
    this.pending.clear()
  }
}
