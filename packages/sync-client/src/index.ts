import { defaultMaxSyncMessageBytes, syncProtocolVersion } from '@canvas/sync-protocol'
import type { FileEdit, JsonObject, JsonValue, PersistedFileEditBatch, ServerSyncMessage } from '@canvas/sync-protocol'

export * from './collaboration-state.js'
export * from './snapshot-assembler.js'
export * from './collaboration-client.js'
export * from './collaboration-store.js'

export type SyncClientStatus = 'idle' | 'connecting' | 'subscribing' | 'ready' | 'reconnecting' | 'conflict' | 'error' | 'disposed'

export type SyncConflict = Readonly<{
  kind: 'stale-revision'
  baseRevision: number
  serverRevision: number
  message: string
}>

export type SyncClientSnapshot<TDocument extends object = JsonObject> = Readonly<{
  status: SyncClientStatus
  fileId: string | null
  clientId: string | null
  revision: number
  document: TDocument | null
  conflict: SyncConflict | null
  error: string | null
  reconnectAttempt: number
}>

export type SyncStartInput<TDocument extends object> = Readonly<{
  fileId: string
  clientId: string
  revision: number
  document: TDocument
}>

export type WebSocketEventMap = Readonly<{
  open: Event
  message: MessageEvent<unknown>
  close: CloseEvent
  error: Event
}>

export type SyncWebSocket = Readonly<{
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void): void
  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void): void
}>

export type SyncClientLifecycleTarget = Readonly<{
  addEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void): void
}>

export type RevisionSyncClientOptions<TDocument extends object> = Readonly<{
  syncOrigin: string
  createWebSocket?: (url: string) => SyncWebSocket
  validateDocument(value: unknown): TDocument
  reconnectDelaysMs?: readonly number[]
  random?: () => number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  lifecycleTarget?: SyncClientLifecycleTarget | null
  isOnline?: () => boolean
  isVisible?: () => boolean
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  createId?: () => string
  maxMessageBytes?: number
}>

export class SyncClientConflictError extends Error {
  readonly conflict: SyncConflict

  constructor(conflict: SyncConflict) {
    super(conflict.message)
    this.name = 'SyncClientConflictError'
    this.conflict = conflict
  }
}

export class SyncClientMessageTooLargeError extends Error {
  constructor() {
    super('This edit is too large for live sync.')
    this.name = 'SyncClientMessageTooLargeError'
  }
}

type PendingMutation<TDocument extends object> = {
  id: string
  baseRevision: number
  edits: readonly FileEdit[]
  resolve: (snapshot: SyncClientSnapshot<TDocument>) => void
  reject: (error: Error) => void
  sentGeneration: number | null
  encoded: string
}

const openState = 1
const idPattern = /^[A-Za-z0-9:._-]{1,128}$/
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const own = (value: object, key: string | number) => Object.hasOwn(value, key)

function syncOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Sync origin must be a WebSocket origin.') }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('Sync origin must be a WebSocket origin.')
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Sync origin must use WSS outside loopback.')
  return url.origin
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function parseBatch(value: unknown): PersistedFileEditBatch {
  if (!record(value) || !safeInteger(value.baseRevision) || !safeInteger(value.serverRevision) || !Array.isArray(value.edits)) throw new Error('Invalid sync edit batch.')
  return value as PersistedFileEditBatch
}

function parseServerMessage(source: unknown): ServerSyncMessage {
  if (typeof source !== 'string') throw new Error('Sync messages must be text.')
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new Error('Sync message is not valid JSON.') }
  if (!record(value) || value.protocolVersion !== syncProtocolVersion || typeof value.type !== 'string') throw new Error('Invalid sync message.')
  switch (value.type) {
    case 'file.payload':
      if (!record(value.payload) || !safeInteger(value.payload.serverRevision) || !record(value.payload.document)) throw new Error('Invalid file payload.')
      text(value.requestId, 'request id'); text(value.payload.fileId, 'file id')
      if (value.reason !== 'bootstrap' && value.reason !== 'history_unavailable') throw new Error('Invalid file payload reason.')
      break
    case 'file.catchup':
      text(value.requestId, 'request id'); text(value.fileId, 'file id')
      if (!safeInteger(value.fromRevision) || !safeInteger(value.serverRevision) || !Array.isArray(value.batches)) throw new Error('Invalid file catch-up.')
      value.batches.forEach(parseBatch)
      break
    case 'file.ready':
      text(value.requestId, 'request id'); text(value.fileId, 'file id')
      if (!safeInteger(value.serverRevision)) throw new Error('Invalid file readiness.')
      break
    case 'file.ack':
      text(value.fileId, 'file id'); text(value.clientMutationId, 'mutation id')
      if (!safeInteger(value.baseRevision) || !safeInteger(value.serverRevision) || !['applied', 'duplicate'].includes(String(value.status))) throw new Error('Invalid file acknowledgement.')
      break
    case 'file.edit.applied':
      parseBatch(value.batch)
      break
    case 'file.conflict':
      text(value.fileId, 'file id'); text(value.clientMutationId, 'mutation id')
      if (!safeInteger(value.baseRevision) || !safeInteger(value.serverRevision) || value.code !== 'stale_revision' || value.retry !== 'resubscribe') throw new Error('Invalid file conflict.')
      if (value.batches !== undefined && (!Array.isArray(value.batches) || value.batches.some(item => { try { parseBatch(item); return false } catch { return true } }))) throw new Error('Invalid file conflict batches.')
      break
    case 'file.presence':
      text(value.fileId, 'file id'); text(value.subjectId, 'subject id'); text(value.clientId, 'client id')
      if (!safeInteger(value.sequence) || !record(value.data)) throw new Error('Invalid presence message.')
      break
    case 'error':
      if (typeof value.code !== 'string' || typeof value.message !== 'string') throw new Error('Invalid sync error.')
      break
    default:
      throw new Error('Unknown sync message type.')
  }
  return value as ServerSyncMessage
}

function child(container: JsonValue, segment: string | number): JsonValue {
  if (typeof segment === 'string' && forbiddenKeys.has(segment)) throw new Error('Unsafe edit path.')
  if (Array.isArray(container)) {
    if (typeof segment !== 'number' || !own(container, segment)) throw new Error('Edit path does not exist.')
    return container[segment]!
  }
  if (!record(container) || typeof segment !== 'string' || !own(container, segment)) throw new Error('Edit path does not exist.')
  return container[segment] as JsonValue
}

function applyEdits(input: JsonObject, edits: readonly FileEdit[]): JsonObject {
  const result = structuredClone(input)
  for (const edit of edits) {
    if (!edit.path.length) throw new Error('An edit path cannot be empty.')
    let parent: JsonValue = result
    for (const segment of edit.type === 'splice' ? edit.path : edit.path.slice(0, -1)) parent = child(parent, segment)
    if (edit.type === 'splice') {
      if (!Array.isArray(parent) || edit.index > parent.length || edit.deleteCount > parent.length - edit.index) throw new Error('Invalid splice range.')
      parent.splice(edit.index, edit.deleteCount, ...structuredClone(edit.values))
      continue
    }
    const key = edit.path.at(-1)!
    if (typeof key === 'string' && forbiddenKeys.has(key)) throw new Error('Unsafe edit path.')
    if (Array.isArray(parent)) {
      if (typeof key !== 'number' || key < 0 || (edit.type === 'set' ? key > parent.length : key >= parent.length)) throw new Error('Invalid array index.')
      if (edit.type === 'set') { if (key === parent.length) parent.push(structuredClone(edit.value)); else parent[key] = structuredClone(edit.value) }
      else parent.splice(key, 1)
    } else {
      if (!record(parent) || typeof key !== 'string') throw new Error('Edit target is not an object.')
      if (edit.type === 'set') parent[key] = structuredClone(edit.value)
      else { if (!own(parent, key)) throw new Error('Edit path does not exist.'); delete parent[key] }
    }
  }
  return result
}

function messageText(event: MessageEvent<unknown>): string | null {
  return typeof event.data === 'string' ? event.data : null
}

function browserLifecycleTarget(): SyncClientLifecycleTarget | null {
  const connectivityTarget = typeof globalThis.addEventListener === 'function' ? globalThis : null
  const visibilityTarget = typeof document === 'undefined' ? null : document
  if (!connectivityTarget && !visibilityTarget) return null
  return {
    addEventListener(type, listener) {
      const target = type === 'visibilitychange' ? visibilityTarget : connectivityTarget
      target?.addEventListener(type, listener)
    },
    removeEventListener(type, listener) {
      const target = type === 'visibilitychange' ? visibilityTarget : connectivityTarget
      target?.removeEventListener(type, listener)
    },
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`)
  return value
}

export function createRevisionSyncClient<TDocument extends object>(options: RevisionSyncClientOptions<TDocument>) {
  const origin = syncOrigin(options.syncOrigin)
  const socketFactory = options.createWebSocket ?? (url => new WebSocket(url))
  const reconnectDelays = options.reconnectDelaysMs ?? [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
  if (!reconnectDelays.length || reconnectDelays.some(delay => !Number.isSafeInteger(delay) || delay < 0)) throw new Error('Reconnect delays must contain non-negative integers.')
  const random = options.random ?? Math.random
  const heartbeatIntervalMs = positiveInteger(options.heartbeatIntervalMs ?? 15_000, 'Heartbeat interval')
  const heartbeatTimeoutMs = positiveInteger(options.heartbeatTimeoutMs ?? 5_000, 'Heartbeat timeout')
  const lifecycleTarget = options.lifecycleTarget === undefined ? browserLifecycleTarget() : options.lifecycleTarget
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const schedule = options.setTimer ?? setTimeout
  const cancel = options.clearTimer ?? clearTimeout
  const createId = options.createId ?? (() => crypto.randomUUID())
  const maxMessageBytes = options.maxMessageBytes ?? defaultMaxSyncMessageBytes
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new Error('Message byte limit must be a positive integer.')
  const listeners = new Set<() => void>()
  let cached: SyncClientSnapshot<TDocument> = Object.freeze({ status: 'idle', fileId: null, clientId: null, revision: 0, document: null, conflict: null, error: null, reconnectAttempt: 0 })
  let socket: SyncWebSocket | null = null
  let socketListeners: { open: (event: Event) => void; message: (event: MessageEvent<unknown>) => void; close: (event: CloseEvent) => void; error: (event: Event) => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let requestId: string | null = null
  let pending: PendingMutation<TDocument> | null = null
  let stopped = true
  let disposed = false
  let terminal = false
  let lifecycleListening = false

  const publish = (patch: Partial<SyncClientSnapshot<TDocument>>) => {
    cached = Object.freeze({ ...cached, ...patch })
    for (const listener of listeners) listener()
    return cached
  }

  const clearHeartbeat = () => {
    if (heartbeatTimer) { cancel(heartbeatTimer); heartbeatTimer = null }
    if (heartbeatTimeoutTimer) { cancel(heartbeatTimeoutTimer); heartbeatTimeoutTimer = null }
  }

  const detachSocket = (close = false) => {
    clearHeartbeat()
    const target = socket
    const bound = socketListeners
    socket = null
    socketListeners = null
    if (!target || !bound) return
    target.removeEventListener('open', bound.open)
    target.removeEventListener('message', bound.message)
    target.removeEventListener('close', bound.close)
    target.removeEventListener('error', bound.error)
    if (close) target.close(1000, 'Client stopped')
  }

  const cancelReconnect = () => {
    if (!reconnectTimer) return
    cancel(reconnectTimer)
    reconnectTimer = null
  }

  const rejectPending = (error: Error) => {
    const current = pending
    pending = null
    current?.reject(error)
  }

  const conflict = (baseRevision: number, serverRevision: number, message = 'This file changed in another session. Refresh before saving again.') => {
    const next: SyncConflict = { kind: 'stale-revision', baseRevision, serverRevision, message }
    publish({ status: 'conflict', conflict: next, error: null })
    rejectPending(new SyncClientConflictError(next))
  }

  const nextBatchState = (document: TDocument | null, revision: number, batch: PersistedFileEditBatch): Readonly<{ document: TDocument; revision: number }> | null => {
    if (batch.fileId !== cached.fileId || batch.baseRevision !== revision || batch.serverRevision !== batch.baseRevision + 1 || !document) return null
    return { document: options.validateDocument(applyEdits(document as unknown as JsonObject, batch.edits)), revision: batch.serverRevision }
  }

  const applyBatch = (batch: PersistedFileEditBatch): boolean => {
    const next = nextBatchState(cached.document, cached.revision, batch)
    if (!next) return false
    publish({ ...next, conflict: null, error: null })
    return true
  }

  const settlePendingFromBatch = (batch: PersistedFileEditBatch) => {
    if (!pending || batch.clientId !== cached.clientId || batch.clientMutationId !== pending.id || batch.baseRevision !== pending.baseRevision) return
    const completed = pending
    pending = null
    publish({ status: 'ready', conflict: null, error: null })
    completed.resolve(cached)
  }

  const sendPending = () => {
    if (!pending || !socket || socket.readyState !== openState || cached.status !== 'ready' || !cached.fileId || !cached.clientId) return
    if (pending.sentGeneration === generation) return
    pending.sentGeneration = generation
    socket.send(pending.encoded)
  }

  const ready = (revision: number) => {
    if (revision !== cached.revision) { conflict(cached.revision, revision); return }
    publish({ status: 'ready', reconnectAttempt: 0, conflict: null, error: null })
    sendPending()
  }

  const receive = (message: ServerSyncMessage) => {
    if (!cached.fileId) return
    if (message.type === 'file.payload') {
      if (message.requestId !== requestId || message.payload.fileId !== cached.fileId) throw new Error('Sync payload does not match this subscription.')
      const document = options.validateDocument(message.payload.document)
      publish({ document, revision: message.payload.serverRevision, status: 'ready', reconnectAttempt: 0, conflict: null, error: null })
      sendPending()
      return
    }
    if (message.type === 'file.catchup') {
      if (message.requestId !== requestId || message.fileId !== cached.fileId || message.fromRevision !== cached.revision) throw new Error('Sync catch-up does not match this subscription.')
      let stagedDocument = cached.document
      let stagedRevision = cached.revision
      let acknowledged: PersistedFileEditBatch | null = null
      for (const batch of message.batches) {
        const next = nextBatchState(stagedDocument, stagedRevision, batch)
        if (!next) throw new Error('Sync catch-up is discontinuous.')
        stagedDocument = next.document
        stagedRevision = next.revision
        if (pending && batch.clientId === cached.clientId && batch.clientMutationId === pending.id && batch.baseRevision === pending.baseRevision) acknowledged = batch
      }
      if (stagedRevision !== message.serverRevision || !stagedDocument) throw new Error('Sync catch-up is discontinuous.')
      publish({ document: stagedDocument, revision: stagedRevision, conflict: null, error: null })
      if (acknowledged) settlePendingFromBatch(acknowledged)
      ready(message.serverRevision)
      return
    }
    if (message.type === 'file.ready') {
      if (message.requestId !== requestId || message.fileId !== cached.fileId) throw new Error('Sync readiness does not match this subscription.')
      ready(message.serverRevision)
      return
    }
    if (message.type === 'file.edit.applied') {
      if (!applyBatch(message.batch)) conflict(cached.revision, message.batch.serverRevision)
      return
    }
    if (message.type === 'file.ack') {
      if (!pending || message.fileId !== cached.fileId || message.clientMutationId !== pending.id) return
      if (message.baseRevision !== pending.baseRevision || message.serverRevision !== message.baseRevision + 1) throw new Error('Sync acknowledgement is discontinuous.')
      if (message.status !== 'duplicate' || cached.revision < message.serverRevision) {
        if (!applyBatch({ fileId: message.fileId, subjectId: 'self', clientId: cached.clientId!, clientMutationId: pending.id, baseRevision: message.baseRevision, serverRevision: message.serverRevision, edits: pending.edits, committedAt: new Date().toISOString() })) throw new Error('Sync acknowledgement is discontinuous.')
      }
      const completed = pending
      pending = null
      publish({ status: 'ready', conflict: null, error: null })
      completed.resolve(cached)
      return
    }
    if (message.type === 'file.conflict') {
      if (pending && message.clientMutationId === pending.id) conflict(message.baseRevision, message.serverRevision)
      return
    }
    if (message.type === 'error') {
      const related = pending && message.clientMutationId === pending.id
      const error = new Error(message.message)
      if (related) rejectPending(error)
      publish({ status: 'error', error: message.message })
    }
  }

  const reconnectDelay = (attempt: number) => {
    const base = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)]!
    const sample = random()
    const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5
    return Math.round(base * (0.5 + jitter))
  }

  const terminalCloseError = (event: CloseEvent): Error | null => {
    if (event.code === 1009) return new SyncClientMessageTooLargeError()
    if (event.code === 4401) return new Error('Sign in to resume live sync.')
    if (event.code === 4403) return new Error('You no longer have access to this file.')
    if (event.code === 4404) return new Error('This file is no longer available.')
    return null
  }

  let connect: () => void

  const scheduleReconnect = () => {
    if (stopped || disposed || terminal || socket || reconnectTimer) return
    if (!isOnline()) {
      publish({ status: 'reconnecting', error: null })
      return
    }
    const attempt = cached.reconnectAttempt
    publish({ status: 'reconnecting', reconnectAttempt: attempt + 1, error: null })
    reconnectTimer = schedule(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay(attempt))
  }

  const forceReconnect = (target: SyncWebSocket, currentGeneration: number, reason: string) => {
    if (generation !== currentGeneration || socket !== target || stopped || disposed) return
    detachSocket()
    target.close(4000, reason)
    scheduleReconnect()
  }

  const armHeartbeat = (target: SyncWebSocket, currentGeneration: number, delayMs = heartbeatIntervalMs) => {
    clearHeartbeat()
    heartbeatTimer = schedule(() => {
      heartbeatTimer = null
      if (generation !== currentGeneration || socket !== target || stopped || disposed) return
      if (!isVisible()) {
        armHeartbeat(target, currentGeneration)
        return
      }
      try {
        target.send('ping')
      } catch {
        forceReconnect(target, currentGeneration, 'Heartbeat send failed')
        return
      }
      heartbeatTimeoutTimer = schedule(() => {
        heartbeatTimeoutTimer = null
        forceReconnect(target, currentGeneration, 'Heartbeat timeout')
      }, heartbeatTimeoutMs)
    }, delayMs)
  }

  connect = () => {
    if (stopped || disposed || terminal || socket || !cached.fileId || !cached.clientId) return
    if (!isOnline()) {
      publish({ status: 'reconnecting', error: null })
      return
    }
    const currentGeneration = ++generation
    requestId = createId()
    let target: SyncWebSocket
    try {
      target = socketFactory(`${origin}/sync/${encodeURIComponent(cached.fileId)}?tabId=${encodeURIComponent(cached.clientId)}`)
    } catch {
      scheduleReconnect()
      return
    }
    socket = target
    const open = () => {
      if (generation !== currentGeneration || socket !== target || stopped) return
      publish({ status: 'subscribing', error: null })
      armHeartbeat(target, currentGeneration)
      try {
        target.send(JSON.stringify({ type: 'file.subscribe', protocolVersion: syncProtocolVersion, requestId, fileId: cached.fileId, clientId: cached.clientId, afterRevision: cached.revision }))
      } catch {
        forceReconnect(target, currentGeneration, 'Subscription send failed')
      }
    }
    const message = (event: MessageEvent<unknown>) => {
      if (generation !== currentGeneration || socket !== target || stopped) return
      try {
        const source = messageText(event)
        if (source === null) throw new Error('Sync messages must be text.')
        if (source === 'pong') {
          if (heartbeatTimeoutTimer) { cancel(heartbeatTimeoutTimer); heartbeatTimeoutTimer = null }
          armHeartbeat(target, currentGeneration)
          return
        }
        if (source === 'ping') {
          target.send('pong')
          return
        }
        receive(parseServerMessage(source))
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The sync service returned an invalid message.'
        publish({ status: 'error', error: reason })
        detachSocket(true)
        rejectPending(new Error(reason))
      }
    }
    const closed = (event: CloseEvent) => {
      if (generation !== currentGeneration || socket !== target || stopped) return
      detachSocket()
      const terminalError = terminalCloseError(event)
      if (terminalError) {
        terminal = true
        publish({ status: 'error', error: terminalError.message })
        rejectPending(terminalError)
        return
      }
      scheduleReconnect()
    }
    const error = () => undefined
    socketListeners = { open, message, close: closed, error }
    target.addEventListener('open', open)
    target.addEventListener('message', message)
    target.addEventListener('close', closed)
    target.addEventListener('error', error)
  }

  const online = () => {
    if (stopped || disposed || terminal || socket) return
    cancelReconnect()
    connect()
  }

  const offline = () => {
    if (stopped || disposed || terminal) return
    cancelReconnect()
    if (socket) detachSocket(true)
    publish({ status: 'reconnecting', error: null })
  }

  const visibilityChanged = () => {
    if (stopped || disposed || terminal) return
    if (!isVisible()) {
      clearHeartbeat()
      return
    }
    if (socket) {
      armHeartbeat(socket, generation, 0)
      return
    }
    if (isOnline()) {
      cancelReconnect()
      connect()
    }
  }

  const attachLifecycle = () => {
    if (!lifecycleTarget || lifecycleListening) return
    lifecycleTarget.addEventListener('online', online)
    lifecycleTarget.addEventListener('offline', offline)
    lifecycleTarget.addEventListener('visibilitychange', visibilityChanged)
    lifecycleListening = true
  }

  const detachLifecycle = () => {
    if (!lifecycleTarget || !lifecycleListening) return
    lifecycleTarget.removeEventListener('online', online)
    lifecycleTarget.removeEventListener('offline', offline)
    lifecycleTarget.removeEventListener('visibilitychange', visibilityChanged)
    lifecycleListening = false
  }

  return Object.freeze({
    getSnapshot: () => cached,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    start(input: SyncStartInput<TDocument>) {
      if (disposed) throw new Error('This sync client was disposed.')
      text(input.fileId, 'file id'); text(input.clientId, 'client id')
      if (!safeInteger(input.revision)) throw new Error('Invalid file revision.')
      cancelReconnect()
      detachSocket(true)
      rejectPending(new Error('The synced file changed.'))
      stopped = false
      terminal = false
      attachLifecycle()
      const document = options.validateDocument(structuredClone(input.document))
      publish({ status: 'connecting', fileId: input.fileId, clientId: input.clientId, revision: input.revision, document, conflict: null, error: null, reconnectAttempt: 0 })
      connect()
    },
    submit(edits: readonly FileEdit[], expectedRevision: number): Promise<SyncClientSnapshot<TDocument>> {
      if (disposed || stopped || cached.status !== 'ready' || !cached.fileId || !cached.document) return Promise.reject(new Error('Live sync is not ready.'))
      if (!safeInteger(expectedRevision) || expectedRevision !== cached.revision) {
        conflict(expectedRevision, cached.revision)
        return Promise.reject(new SyncClientConflictError(cached.conflict!))
      }
      if (!edits.length) return Promise.resolve(cached)
      if (pending) return Promise.reject(new Error('Wait for the current save to finish.'))
      return new Promise((resolve, reject) => {
        const id = createId()
        const copied = structuredClone(edits)
        const encoded = JSON.stringify({ type: 'file.edit.batch', protocolVersion: syncProtocolVersion, fileId: cached.fileId, clientId: cached.clientId, clientMutationId: id, baseRevision: expectedRevision, edits: copied })
        if (copied.length > 256 || new TextEncoder().encode(encoded).byteLength > maxMessageBytes) { reject(new SyncClientMessageTooLargeError()); return }
        pending = { id, baseRevision: expectedRevision, edits: copied, resolve, reject, sentGeneration: null, encoded }
        sendPending()
      })
    },
    stop() {
      if (disposed) return
      stopped = true
      generation += 1
      cancelReconnect()
      detachSocket(true)
      detachLifecycle()
      rejectPending(new Error('Live sync stopped.'))
      publish({ status: 'idle', conflict: null, error: null, reconnectAttempt: 0 })
    },
    dispose() {
      if (disposed) return
      stopped = true
      disposed = true
      generation += 1
      cancelReconnect()
      detachSocket(true)
      detachLifecycle()
      rejectPending(new Error('Live sync was disposed.'))
      publish({ status: 'disposed', conflict: null, error: null, reconnectAttempt: 0 })
      listeners.clear()
    },
  })
}
