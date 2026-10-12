import { describe, expect, it } from 'vitest'
import type { ApplicationUpdateSnapshot } from '@canvas/editor/updates'
import { reduceDesktopUpdate } from '../src/main/update-machine'

const idle = Object.freeze<ApplicationUpdateSnapshot>({ kind: 'desktop', channel: 'nightly', status: 'idle', currentVersion: '1.0.0-nightly.1', availableVersion: null, progress: null, releaseNotes: null, checkedAt: null, message: null, reference: null, retryable: false })

describe('DESKTOP-UPDATE-001 update recovery', () => {
  it('keeps a downloaded installer when a later check fails', () => {
    const ready = reduceDesktopUpdate(idle, { type: 'downloaded', version: '1.0.0-nightly.2', releaseNotes: 'Fixed selection.' })
    const failed = reduceDesktopUpdate(ready, { type: 'failure', message: 'offline', reference: 'ref-1', retryable: true })
    expect(failed).toMatchObject({ status: 'ready', availableVersion: '1.0.0-nightly.2', progress: 100, reference: 'ref-1' })
  })

  it('returns an interrupted download to an actionable available state', () => {
    const available = reduceDesktopUpdate(idle, { type: 'available', version: '1.1.0', releaseNotes: null })
    const downloading = reduceDesktopUpdate(available, { type: 'download' })
    const failed = reduceDesktopUpdate(downloading, { type: 'failure', message: 'offline', reference: 'ref-2', retryable: true })
    expect(failed).toMatchObject({ status: 'available', availableVersion: '1.1.0', progress: null, retryable: true })
  })

  it('does not conflate a check failure with an up-to-date result', () => {
    const failed = reduceDesktopUpdate(reduceDesktopUpdate(idle, { type: 'check' }), { type: 'failure', message: 'invalid manifest', reference: 'ref-3', retryable: true })
    expect(failed.status).toBe('error')
  })
})
