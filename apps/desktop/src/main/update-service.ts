import { randomUUID } from 'node:crypto'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import type { ApplicationUpdateSnapshot } from '@canvas/editor/updates'
import { reduceDesktopUpdate } from './update-machine'

export type DesktopUpdater = Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on' | 'off' | 'setFeedURL'> & {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  fullChangelog: boolean
}

type DesktopUpdateOptions = Readonly<{
  updater: DesktopUpdater
  currentVersion: string
  channel: 'nightly' | 'stable'
  feedURL: string | null
  enabled: boolean
  now?: () => number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  createReference?: () => string
  prepareInstall?: () => Promise<void>
}>

function releaseNotes(info: UpdateInfo): string | null {
  if (typeof info.releaseNotes === 'string') return info.releaseNotes.trim() || null
  if (Array.isArray(info.releaseNotes)) return info.releaseNotes.map(note => typeof note === 'string' ? note : note.note).filter(Boolean).join('\n\n') || null
  return null
}

export class DesktopUpdateService {
  #updater: DesktopUpdater
  #snapshot: ApplicationUpdateSnapshot
  #listeners = new Set<(snapshot: ApplicationUpdateSnapshot) => void>()
  #feedURL: string | null
  #enabled: boolean
  #operation: Promise<ApplicationUpdateSnapshot> | null = null
  #timer: ReturnType<typeof globalThis.setTimeout> | null = null
  #started = false
  #lastCheckedAt = 0
  #now: () => number
  #setTimeout: typeof globalThis.setTimeout
  #clearTimeout: typeof globalThis.clearTimeout
  #createReference: () => string
  #availableInfo: UpdateInfo | null = null
  #progressBucket = -1
  #installing = false
  #prepareInstall: () => Promise<void>

  constructor(options: DesktopUpdateOptions) {
    this.#updater = options.updater
    this.#feedURL = options.feedURL
    this.#enabled = options.enabled && Boolean(options.feedURL)
    this.#now = options.now ?? Date.now
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout
    this.#createReference = options.createReference ?? randomUUID
    this.#prepareInstall = options.prepareInstall ?? (() => Promise.resolve())
    this.#snapshot = Object.freeze({ kind: 'desktop', channel: options.channel, status: this.#enabled ? 'idle' : 'disabled', currentVersion: options.currentVersion, availableVersion: null, progress: null, releaseNotes: null, checkedAt: null, message: this.#enabled ? null : 'Updates are unavailable in this build.', reference: null, retryable: false })
    this.#updater.autoDownload = false
    this.#updater.autoInstallOnAppQuit = false
    this.#updater.autoRunAppAfterInstall = true
    this.#updater.allowPrerelease = options.channel === 'nightly'
    this.#updater.allowDowngrade = false
    this.#updater.fullChangelog = true
    if (this.#enabled && this.#feedURL) this.#updater.setFeedURL({ provider: 'generic', url: this.#feedURL, channel: options.channel === 'nightly' ? 'nightly' : 'latest' })
  }

  getSnapshot(): ApplicationUpdateSnapshot { return this.#snapshot }
  isInstalling(): boolean { return this.#installing }
  subscribe(listener: (snapshot: ApplicationUpdateSnapshot) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  start(): void {
    if (this.#started || !this.#enabled) return
    this.#started = true
    this.#updater.on('update-available', this.#onAvailable)
    this.#updater.on('update-not-available', this.#onNotAvailable)
    this.#updater.on('download-progress', this.#onProgress)
    this.#updater.on('update-downloaded', this.#onDownloaded)
    this.#updater.on('error', this.#onError)
    this.#timer = this.#setTimeout(() => void this.check(), 15_000)
  }

  stop(): void {
    if (!this.#started) return
    this.#started = false
    this.#updater.off('update-available', this.#onAvailable)
    this.#updater.off('update-not-available', this.#onNotAvailable)
    this.#updater.off('download-progress', this.#onProgress)
    this.#updater.off('update-downloaded', this.#onDownloaded)
    this.#updater.off('error', this.#onError)
    if (this.#timer !== null) this.#clearTimeout(this.#timer)
    this.#timer = null
  }

  checkIfStale(): void { if (this.#enabled && this.#now() - this.#lastCheckedAt >= 5 * 60_000) void this.check() }

  check(): Promise<ApplicationUpdateSnapshot> {
    if (!this.#enabled) return Promise.resolve(this.#snapshot)
    const operation = this.#reserve(async () => {
      this.#transition({ type: 'check' })
      await this.#updater.checkForUpdates()
      this.#lastCheckedAt = this.#now()
      this.#scheduleCheck()
      return this.#snapshot
    }, 'check')
    void operation.then(snapshot => { if (snapshot.status === 'available') void this.download() })
    return operation
  }

  download(): Promise<ApplicationUpdateSnapshot> {
    if (!this.#enabled || !this.#availableInfo || !['available', 'error'].includes(this.#snapshot.status)) return Promise.resolve(this.#snapshot)
    return this.#reserve(async () => {
      this.#progressBucket = 0
      this.#transition({ type: 'download' })
      await this.#updater.downloadUpdate()
      return this.#snapshot
    }, 'download')
  }

  install(): Promise<ApplicationUpdateSnapshot> {
    if (this.#snapshot.status !== 'ready') return Promise.resolve(this.#snapshot)
    return this.#reserve(async () => {
      await this.#prepareInstall()
      this.#installing = true
      try { this.#updater.quitAndInstall(true, true) } catch (error) { this.#installing = false; throw error }
      return this.#snapshot
    }, 'install')
  }

  #reserve(operation: () => Promise<ApplicationUpdateSnapshot>, context: string): Promise<ApplicationUpdateSnapshot> {
    if (this.#operation) return this.#operation
    this.#operation = operation().catch(error => { this.#failure(error, context); return this.#snapshot }).finally(() => { this.#operation = null })
    return this.#operation
  }

  #scheduleCheck(): void {
    if (!this.#started) return
    if (this.#timer !== null) this.#clearTimeout(this.#timer)
    this.#timer = this.#setTimeout(() => void this.check(), 15 * 60_000)
  }

  #transition(event: Parameters<typeof reduceDesktopUpdate>[1]): void {
    this.#snapshot = reduceDesktopUpdate(this.#snapshot, event)
    for (const listener of this.#listeners) listener(this.#snapshot)
  }

  #failure(error: unknown, context: string): void {
    const reference = this.#createReference()
    const failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'UnknownError', message: String(error) }
    console.error(JSON.stringify({ level: 'error', event: 'desktop_update_failed', context, reference, error: failure }))
    this.#transition({ type: 'failure', message: 'Comp Canvas could not finish the update.', reference, retryable: true })
    this.#scheduleCheck()
  }

  #onAvailable = (info: UpdateInfo) => {
    this.#availableInfo = info
    this.#transition({ type: 'available', version: info.version, releaseNotes: releaseNotes(info) })
  }
  #onNotAvailable = () => this.#transition({ type: 'not-available', checkedAt: new Date(this.#now()).toISOString() })
  #onProgress = (info: ProgressInfo) => {
    const bucket = info.percent >= 100 ? 100 : Math.floor(info.percent / 5) * 5
    if (bucket === this.#progressBucket) return
    this.#progressBucket = bucket
    this.#transition({ type: 'progress', progress: bucket })
  }
  #onDownloaded = (info: UpdateInfo) => this.#transition({ type: 'downloaded', version: info.version, releaseNotes: releaseNotes(info) })
  #onError = (error: Error) => this.#failure(error, 'event')
}
