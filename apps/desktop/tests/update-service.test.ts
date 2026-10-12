import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DesktopUpdateService } from '../src/main/update-service'
import type { DesktopUpdater } from '../src/main/update-service'

function updater() {
  const emitter = new EventEmitter()
  const value = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    allowPrerelease: false,
    allowDowngrade: true,
    fullChangelog: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  })
  return value as unknown as DesktopUpdater & typeof value
}

function service(value: DesktopUpdater, prepareInstall = vi.fn(async () => undefined)) {
  return new DesktopUpdateService({ updater: value, currentVersion: '1.0.0-nightly.1', channel: 'nightly', feedURL: 'https://updates.test/windows/x64', enabled: true, setTimeout: (() => 1) as unknown as typeof setTimeout, clearTimeout: vi.fn(), createReference: () => 'update-ref', prepareInstall })
}

describe('DESKTOP-UPDATE-002 updater orchestration', () => {
  it('serializes checks, downloads in the background, and coalesces renderer progress', async () => {
    const backend = updater()
    backend.checkForUpdates.mockImplementation(async () => {
      backend.emit('update-available', { version: '1.0.0-nightly.2', releaseNotes: 'Selection is smoother.' })
      return null
    })
    backend.downloadUpdate.mockImplementation(async () => {
      backend.emit('download-progress', { percent: 1 })
      backend.emit('download-progress', { percent: 4 })
      backend.emit('download-progress', { percent: 8 })
      backend.emit('update-downloaded', { version: '1.0.0-nightly.2', releaseNotes: 'Selection is smoother.' })
      return []
    })
    const updates = service(backend)
    const snapshots: string[] = []
    updates.subscribe(snapshot => snapshots.push(`${snapshot.status}:${snapshot.progress ?? ''}`))
    updates.start()
    const first = updates.check()
    const second = updates.check()
    expect(first).toBe(second)
    await first
    await vi.waitFor(() => expect(updates.getSnapshot().status).toBe('ready'))
    expect(backend.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(snapshots.filter(item => item.startsWith('downloading:'))).toEqual(['downloading:0', 'downloading:5'])
  })

  it('waits for the editor save guard before restarting', async () => {
    const backend = updater()
    const prepareInstall = vi.fn(async () => undefined)
    const updates = service(backend, prepareInstall)
    updates.start()
    backend.emit('update-downloaded', { version: '1.0.1', releaseNotes: null })
    await updates.install()
    expect(prepareInstall).toHaveBeenCalledOnce()
    expect(backend.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(updates.isInstalling()).toBe(true)
  })

  it('keeps a failed check visible and retryable', async () => {
    const backend = updater()
    backend.checkForUpdates.mockRejectedValue(new Error('invalid signature'))
    const updates = service(backend)
    updates.start()
    await updates.check()
    expect(updates.getSnapshot()).toMatchObject({ status: 'error', reference: 'update-ref', retryable: true })
  })
})
