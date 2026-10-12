import type { ApplicationUpdateBridge, ApplicationUpdateSnapshot } from '@canvas/editor/updates'

type WebUpdateManifest = Readonly<{ buildId: string; version: string; commit: string | null }>
export type UpdateEnvironment = Readonly<{
  buildId: string
  version: string
  fetchManifest: () => Promise<WebUpdateManifest>
  reload: () => void
  now: () => number
  setTimeout: (callback: () => void, delay: number) => unknown
  clearTimeout: (handle: unknown) => void
  addWindowListener: (type: 'focus' | 'error' | 'unhandledrejection', listener: EventListener) => void
  removeWindowListener: (type: 'focus' | 'error' | 'unhandledrejection', listener: EventListener) => void
}>

const disabledSnapshot = Object.freeze<ApplicationUpdateSnapshot>({ kind: 'web', channel: 'web', status: 'disabled', currentVersion: '0.0.0', availableVersion: null, progress: null, releaseNotes: null, checkedAt: null, message: null, reference: null, retryable: false })
const chunkFailure = /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i

function messageFromEvent(event: Event): string {
  if (event instanceof ErrorEvent) return event.message
  if (event instanceof PromiseRejectionEvent) return event.reason instanceof Error ? event.reason.message : String(event.reason)
  return ''
}

export class ApplicationUpdateService {
  #snapshot = disabledSnapshot
  #listeners = new Set<() => void>()
  #desktop: ApplicationUpdateBridge | null = null
  #prepareDesktopInstall: (() => Promise<void>) | null = null
  #web: UpdateEnvironment | null = null
  #unsubscribe: (() => void) | null = null
  #timer: unknown | null = null
  #check: Promise<ApplicationUpdateSnapshot> | null = null
  #started = false
  #lastCheckedAt = 0
  #dismissedVersion: string | null = null

  readonly subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  readonly getSnapshot = () => this.#snapshot
  readonly getServerSnapshot = () => disabledSnapshot
  readonly getDismissedVersion = () => this.#dismissedVersion

  configureDesktop(bridge: ApplicationUpdateBridge, prepareInstall?: () => Promise<void>): void { this.#desktop = bridge; this.#prepareDesktopInstall = prepareInstall ?? null; this.#web = null }
  configureWeb(environment: UpdateEnvironment): void { this.#web = environment; this.#desktop = null }

  start(): void {
    if (this.#started) return
    this.#started = true
    if (this.#desktop) {
      this.#unsubscribe = this.#desktop.onUpdateChanged(snapshot => this.#publish(snapshot))
      void this.#desktop.getUpdateSnapshot().then(snapshot => this.#publish(snapshot)).catch(error => this.#fail(error))
      return
    }
    if (!this.#web) return
    this.#publish({ ...disabledSnapshot, status: 'idle', currentVersion: this.#web.version })
    this.#web.addWindowListener('focus', this.#onFocus)
    this.#web.addWindowListener('error', this.#onRuntimeError)
    this.#web.addWindowListener('unhandledrejection', this.#onRuntimeError)
    this.#timer = this.#web.setTimeout(() => void this.check(), 15_000)
  }

  stop(): void {
    if (!this.#started) return
    this.#started = false
    this.#unsubscribe?.()
    this.#unsubscribe = null
    if (this.#web) {
      this.#web.removeWindowListener('focus', this.#onFocus)
      this.#web.removeWindowListener('error', this.#onRuntimeError)
      this.#web.removeWindowListener('unhandledrejection', this.#onRuntimeError)
      if (this.#timer !== null) this.#web.clearTimeout(this.#timer)
    }
    this.#timer = null
    this.#check = null
  }

  dismiss(): void { this.#dismissedVersion = this.#snapshot.availableVersion; this.#emit() }

  check(): Promise<ApplicationUpdateSnapshot> {
    if (this.#check) return this.#check
    this.#dismissedVersion = null
    const operation = this.#desktop ? this.#desktop.checkForUpdate() : this.#checkWeb()
    this.#check = operation.then(snapshot => { this.#publish(snapshot); return snapshot }).catch(error => { this.#fail(error); return this.#snapshot }).finally(() => { this.#check = null })
    return this.#check
  }

  async download(): Promise<void> {
    if (!this.#desktop) return
    try { this.#publish(await this.#desktop.downloadUpdate()) } catch (error) { this.#fail(error) }
  }

  async install(): Promise<void> {
    if (this.#desktop) {
      try { await this.#prepareDesktopInstall?.(); this.#publish(await this.#desktop.installUpdate()) } catch (error) { this.#fail(error) }
      return
    }
    this.#web?.reload()
  }

  async #checkWeb(): Promise<ApplicationUpdateSnapshot> {
    const web = this.#web
    if (!web) return this.#snapshot
    this.#publish({ ...this.#snapshot, status: 'checking', message: null, reference: null, retryable: false })
    const manifest = await web.fetchManifest()
    if (!manifest.buildId || !manifest.version) throw new Error('The update manifest is invalid.')
    this.#lastCheckedAt = web.now()
    this.#scheduleWebCheck()
    return Object.freeze({ ...this.#snapshot, status: manifest.buildId === web.buildId ? 'idle' : 'ready', availableVersion: manifest.buildId === web.buildId ? null : manifest.version, checkedAt: new Date(this.#lastCheckedAt).toISOString(), message: null, reference: null, retryable: false })
  }

  #scheduleWebCheck(): void {
    const web = this.#web
    if (!web || !this.#started) return
    if (this.#timer !== null) web.clearTimeout(this.#timer)
    this.#timer = web.setTimeout(() => void this.check(), 15 * 60_000)
  }

  #publish(snapshot: ApplicationUpdateSnapshot): void { this.#snapshot = Object.freeze(snapshot); this.#emit() }
  #emit(): void { for (const listener of this.#listeners) listener() }
  #fail(error: unknown): void {
    const reference = crypto.randomUUID()
    console.error(JSON.stringify({ level: 'error', event: 'application_update_failed', reference, error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError', message: String(error) } }))
    this.#publish({ ...this.#snapshot, status: 'error', message: 'Comp Canvas could not check for updates.', reference, retryable: true })
    this.#scheduleWebCheck()
  }
  #onFocus = () => { const web = this.#web; if (web && web.now() - this.#lastCheckedAt >= 5 * 60_000) void this.check() }
  #onRuntimeError = (event: Event) => { if (chunkFailure.test(messageFromEvent(event))) void this.check() }
}

export const applicationUpdateService = new ApplicationUpdateService()
