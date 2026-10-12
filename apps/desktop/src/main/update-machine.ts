import type { ApplicationUpdateSnapshot } from '@canvas/editor/updates'

export type DesktopUpdateEvent =
  | Readonly<{ type: 'check' }>
  | Readonly<{ type: 'available'; version: string; releaseNotes: string | null }>
  | Readonly<{ type: 'not-available'; checkedAt: string }>
  | Readonly<{ type: 'download' }>
  | Readonly<{ type: 'progress'; progress: number }>
  | Readonly<{ type: 'downloaded'; version: string; releaseNotes: string | null }>
  | Readonly<{ type: 'failure'; message: string; reference: string; retryable: boolean }>

export function reduceDesktopUpdate(snapshot: ApplicationUpdateSnapshot, event: DesktopUpdateEvent): ApplicationUpdateSnapshot {
  if (event.type === 'check') {
    if (snapshot.status === 'ready') return snapshot
    return Object.freeze({ ...snapshot, status: 'checking', message: null, reference: null, retryable: false })
  }
  if (event.type === 'available') return Object.freeze({ ...snapshot, status: 'available', availableVersion: event.version, progress: null, releaseNotes: event.releaseNotes, message: null, reference: null, retryable: false })
  if (event.type === 'not-available') {
    if (snapshot.status === 'ready') return Object.freeze({ ...snapshot, checkedAt: event.checkedAt })
    return Object.freeze({ ...snapshot, status: 'idle', availableVersion: null, progress: null, releaseNotes: null, checkedAt: event.checkedAt, message: null, reference: null, retryable: false })
  }
  if (event.type === 'download') return Object.freeze({ ...snapshot, status: 'downloading', progress: 0, message: null, reference: null, retryable: false })
  if (event.type === 'progress') return Object.freeze({ ...snapshot, status: 'downloading', progress: Math.max(0, Math.min(100, event.progress)) })
  if (event.type === 'downloaded') return Object.freeze({ ...snapshot, status: 'ready', availableVersion: event.version, progress: 100, releaseNotes: event.releaseNotes, message: null, reference: null, retryable: false })
  if (snapshot.status === 'ready') return Object.freeze({ ...snapshot, message: event.message, reference: event.reference, retryable: event.retryable })
  if (snapshot.status === 'downloading' && snapshot.availableVersion) return Object.freeze({ ...snapshot, status: 'available', progress: null, message: event.message, reference: event.reference, retryable: event.retryable })
  return Object.freeze({ ...snapshot, status: 'error', message: event.message, reference: event.reference, retryable: event.retryable })
}
