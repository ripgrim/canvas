import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import type { ShadcnScan } from '@canvas/scanner/contracts'

type ScanResponse = { ok: true; value: ShadcnScan } | { ok: false; error: string }

export class ScannerProcess {
  private worker: UtilityProcess | undefined
  private pending: { resolve(value: ShadcnScan): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> } | undefined

  constructor(private readonly workerPath: string, private readonly root: string) {}

  scan(): Promise<ShadcnScan> {
    if (this.worker || this.pending) return Promise.reject(new Error('Repository scan is already running.'))
    return new Promise((resolve, reject) => {
      const env: Record<string, string> = { NODE_ENV: 'production' }
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
      const worker = utilityProcess.fork(this.workerPath, [this.root], { env, serviceName: 'Design editor scanner', stdio: 'pipe' })
      this.worker = worker
      const timeout = setTimeout(() => { this.dispose(); reject(new Error('Repository scan timed out.')) }, 60_000)
      this.pending = { resolve, reject, timeout }
      worker.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return
        const response = message as ScanResponse
        this.finish(response.ok ? null : new Error(response.error), response.ok ? response.value : undefined)
      })
      worker.once('error', error => this.finish(new Error(error)))
      worker.once('exit', code => { if (this.pending) this.finish(new Error(`Repository scanner stopped with code ${code ?? 'unknown'}.`)) })
    })
  }

  dispose(): void {
    this.worker?.kill()
    this.worker = undefined
    if (this.pending) this.finish(new Error('Repository scanner stopped.'))
  }

  private finish(error: Error | null, value?: ShadcnScan): void {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending = undefined
    this.worker?.kill()
    this.worker = undefined
    if (error) pending.reject(error)
    else if (value) pending.resolve(value)
    else pending.reject(new Error('Repository scanner returned no result.'))
  }
}
