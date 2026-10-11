import {
  collaborationEnvelopeSchemaVersion,
  collaborationProtocolEpoch,
  decodeSemanticCommandFromPersistence,
  defaultMaxCollaborationMessageBytes,
  encodeSemanticCommandForPersistence,
  encodeCollaborationMessage,
  isValidClientLifecycleTransition,
  parseCollaborationClientMessage,
  parseCollaborationServerMessage,
  validateSemanticFileCommand,
} from '@canvas/sync-protocol'
import type {
  ClientLifecycleState,
  CollaborationClientMessage,
  CollaborationMode,
  CollaborationServerMessage,
  DurableSequence,
  PresenceParticipant,
  PresencePatch,
  PresenceState,
  SemanticFileCommand,
  ServerRoomEnvelope,
  VerifiedRoomRole,
} from '@canvas/sync-protocol'
import { createCollaborationStateMachine, StaleCollaborationMessageError } from './collaboration-state.js'
import {
  createIndexedDbCollaborationStore,
  type CollaborationDurableStore,
  type CollaborationStoreScope,
  type StoredCollaborationCheckpoint,
  type StoredCollaborationMutation,
  type StoredCollaborationRoom,
} from './collaboration-store.js'
import { createSnapshotAssembler } from './snapshot-assembler.js'

const openState = 1
const maximumDurableSequence = '9223372036854775807'
const normalClosure = 1000
const unsupportedData = 4003
const policyViolation = 4008
const messageTooLarge = 4009
const internalError = 4011
const reconnectRequired = 4012
const syncWebSocketProtocol = 'canvas-sync-v2'
const maxPendingMutations = 512
const presenceFrameMs = 30
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type CollaborationSocketEventMap = Readonly<{
  open: Event
  message: MessageEvent<unknown>
  close: CloseEvent
  error: Event
}>

export type CollaborationWebSocket = Readonly<{
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void): void
  removeEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void): void
}>

export type CollaborationMutationReceipt = Readonly<{
  mutationId: string
  sequence: DurableSequence
  status: 'applied' | 'duplicate'
}>

export type CollaborationMutationInput = Readonly<{
  mutationId: string
  command: SemanticFileCommand
}>

export type CollaborationAppliedOperation =
  | Readonly<{
      source: 'local'
      mutationId: string
      sequence: DurableSequence
      command: SemanticFileCommand
    }>
  | Readonly<{
      source: 'remote'
      mutationId: string
      sequence: DurableSequence
      subjectId: string
      command: SemanticFileCommand
    }>

export type CollaborationClientSnapshot<TDocument extends object> = Readonly<{
  lifecycle: ClientLifecycleState
  fileId: string | null
  clientId: string
  mode: CollaborationMode | null
  role: VerifiedRoomRole | null
  document: TDocument | null
  snapshotId: string | null
  serverSequence: DurableSequence
  lastOperation: CollaborationAppliedOperation | null
  participants: readonly PresenceParticipant[]
  pendingMutationIds: readonly string[]
  recoverableMutationIds: readonly string[]
  reconnectAttempt: number
  error: string | null
  disposed: boolean
}>

export type CollaborationClientStartInput = Readonly<{
  fileId: string
  cache: false | Readonly<{
    accountId: string
    documentSchemaVersion: number
  }>
}>

export type CollaborationClientOptions<TDocument extends object> = Readonly<{
  syncOrigin: string
  buildId: string
  clientId: string
  validateDocument(value: unknown): TDocument
  applyCommand(document: TDocument, command: SemanticFileCommand): TDocument
  createWebSocket?: (url: string, protocol: typeof syncWebSocketProtocol) => CollaborationWebSocket
  createId?: () => string
  reconnectDelaysMs?: readonly number[]
  random?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  maxMessageBytes?: number
  reportError?: (error: unknown, operation: 'room.leave') => void
  reportCacheError?: (error: unknown) => void
  durableStore?: CollaborationDurableStore
}>

export class CollaborationMessageTooLargeError extends Error {
  constructor() {
    super('Collaboration message exceeds the byte limit.')
    this.name = 'CollaborationMessageTooLargeError'
  }
}

type SocketBinding = Readonly<{
  socket: CollaborationWebSocket
  epoch: number
  open: (event: Event) => void
  message: (event: MessageEvent<unknown>) => void
  close: (event: CloseEvent) => void
  error: (event: Event) => void
}>

type PendingMutation<TDocument extends object> = {
  readonly id: string
  readonly command: SemanticFileCommand
  baseSequence: DurableSequence | null
  sentSocketEpoch: number | null
  readonly resolve: (receipt: CollaborationMutationReceipt) => void
  readonly reject: (error: Error) => void
  readonly validateResult: (value: unknown) => TDocument
  settled: boolean
}

type StagedSnapshot<TDocument extends object> = Readonly<{
  requestId: string
  snapshotId: string
  baseSequence: DurableSequence
  document: TDocument
}>

const emptyPresence: PresenceState = Object.freeze({
  pageId: null,
  focused: false,
  selection: null,
  camera: null,
  cursor: null,
  interaction: null,
})

function copyPresenceState(value: PresenceState): PresenceState {
  return Object.freeze({
    pageId: value.pageId,
    focused: value.focused,
    selection: value.selection ? Object.freeze({ pageId: value.selection.pageId, nodeIds: Object.freeze([...value.selection.nodeIds]) }) : null,
    camera: value.camera ? Object.freeze({ ...value.camera }) : null,
    cursor: value.cursor ? Object.freeze({ ...value.cursor }) : null,
    ...(Object.hasOwn(value, 'interaction') ? { interaction: value.interaction ? Object.freeze({ ...value.interaction, nodeIds: Object.freeze([...value.interaction.nodeIds]), transforms: Object.freeze(value.interaction.transforms.map(transform => Object.freeze({ ...transform }))) }) : null } : {}),
  })
}

function copyParticipant(value: PresenceParticipant): PresenceParticipant {
  return Object.freeze({
    presenceId: value.presenceId,
    subjectId: value.subjectId,
    displayName: value.displayName,
    avatarUrl: value.avatarUrl,
    clientId: value.clientId,
    role: value.role,
    sequence: value.sequence,
    data: copyPresenceState(value.data),
  })
}

function mergePresenceState(current: PresenceState, patch: PresencePatch): PresenceState {
  const hasPageId = Object.hasOwn(patch, 'pageId')
  const pageId = hasPageId ? patch.pageId ?? null : current.pageId
  const pageChanged = hasPageId && pageId !== current.pageId
  return copyPresenceState({
    pageId,
    focused: patch.focused ?? current.focused,
    selection: Object.hasOwn(patch, 'selection') ? patch.selection ?? null : pageChanged ? null : current.selection,
    camera: Object.hasOwn(patch, 'camera') ? patch.camera ?? null : pageChanged ? null : current.camera,
    cursor: Object.hasOwn(patch, 'cursor') ? patch.cursor ?? null : pageChanged ? null : current.cursor,
    interaction: Object.hasOwn(patch, 'interaction') ? patch.interaction ?? null : pageChanged ? null : current.interaction ?? null,
  })
}

function fullPresencePatch(value: PresenceState): PresencePatch {
  return Object.freeze({
    pageId: value.pageId,
    focused: value.focused,
    selection: value.selection,
    camera: value.camera,
    cursor: value.cursor,
    interaction: value.interaction ?? null,
  })
}

function mergePresencePatch(current: PresencePatch | null, patch: PresencePatch): PresencePatch {
  const merged = { ...(current ?? {}), ...patch }
  if (Object.hasOwn(patch, 'pageId') && patch.pageId !== current?.pageId) {
    if (!Object.hasOwn(patch, 'selection')) merged.selection = null
    if (!Object.hasOwn(patch, 'camera')) merged.camera = null
    if (!Object.hasOwn(patch, 'cursor')) merged.cursor = null
    if (!Object.hasOwn(patch, 'interaction')) merged.interaction = null
  }
  return Object.freeze(merged)
}

function isImmediateInteractionPatch(patch: PresencePatch): boolean {
  const keys = Object.keys(patch)
  return Object.hasOwn(patch, 'interaction') && keys.every(key => key === 'pageId' || key === 'interaction')
}

function validateIdentifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function validateFileId(value: string): string {
  if (!uuidPattern.test(value)) throw new Error('Invalid file id.')
  return value
}

function validateSyncOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Sync origin must be a WebSocket origin.') }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.origin !== value || url.username || url.password) throw new Error('Sync origin must be a WebSocket origin.')
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Sync origin must use WSS outside loopback.')
  return url.origin
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validateSequence(value: unknown): DurableSequence {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid durable sequence.')
  BigInt(value)
  return value
}

function validateStoreScope(value: unknown, expected: CollaborationStoreScope): boolean {
  if (!isRecord(value) || !exactKeys(value, ['accountId', 'clientId', 'fileId', 'documentSchemaVersion', 'protocolEpoch'])) return false
  return value.accountId === expected.accountId
    && value.clientId === expected.clientId
    && value.fileId === expected.fileId
    && value.documentSchemaVersion === expected.documentSchemaVersion
    && value.protocolEpoch === expected.protocolEpoch
}

function hydrateStoredRoom<TDocument extends object>(
  value: unknown,
  scope: CollaborationStoreScope,
  validateDocument: (value: unknown) => TDocument,
): Readonly<{ room: StoredCollaborationRoom; document: TDocument | null; repaired: boolean }> {
  const empty: StoredCollaborationRoom = Object.freeze({ scope, checkpoint: null, pending: Object.freeze([]), updatedAt: Date.now() })
  if (!isRecord(value) || !exactKeys(value, ['scope', 'checkpoint', 'pending', 'updatedAt']) || !validateStoreScope(value.scope, scope) || !Array.isArray(value.pending) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
    return Object.freeze({ room: empty, document: null, repaired: value !== null })
  }
  let repaired = false
  let checkpoint: StoredCollaborationCheckpoint | null = null
  let document: TDocument | null = null
  if (value.checkpoint !== null && isRecord(value.checkpoint) && exactKeys(value.checkpoint, ['snapshotId', 'serverSequence', 'document'])) {
    try {
      if (typeof value.checkpoint.snapshotId !== 'string') throw new Error('Invalid snapshot id.')
      const snapshotId = validateIdentifier(value.checkpoint.snapshotId, 'snapshot id')
      const serverSequence = validateSequence(value.checkpoint.serverSequence)
      document = validateDocument(value.checkpoint.document)
      checkpoint = Object.freeze({ snapshotId, serverSequence, document })
    } catch { repaired = true }
  } else if (value.checkpoint !== null) repaired = true

  const pending: StoredCollaborationMutation[] = []
  const seen = new Set<string>()
  for (const item of value.pending) {
    try {
      if (!isRecord(item) || !exactKeys(item, ['mutationId', 'baseSequence', 'command', 'status'])) throw new Error('Invalid stored mutation.')
      if (typeof item.mutationId !== 'string') throw new Error('Invalid stored mutation id.')
      const mutationId = validateIdentifier(item.mutationId, 'mutation id')
      if (mutationId.length < 8 || seen.has(mutationId)) throw new Error('Invalid stored mutation id.')
      const baseSequence = item.baseSequence === null ? null : validateSequence(item.baseSequence)
      const command = encodeSemanticCommandForPersistence(decodeSemanticCommandFromPersistence(item.command))
      if (item.status !== 'pending' && item.status !== 'recoverable') throw new Error('Invalid stored mutation status.')
      seen.add(mutationId)
      pending.push(Object.freeze({ mutationId, baseSequence, command, status: item.status }))
    } catch { repaired = true }
  }
  const room: StoredCollaborationRoom = Object.freeze({
    scope,
    checkpoint,
    pending: Object.freeze(pending),
    updatedAt: value.updatedAt,
  })
  return Object.freeze({ room, document, repaired })
}

function nextSequence(value: DurableSequence): DurableSequence {
  return (BigInt(value) + 1n).toString()
}

function compareSequence(left: DurableSequence, right: DurableSequence): number {
  const first = BigInt(left)
  const second = BigInt(right)
  return first < second ? -1 : first > second ? 1 : 0
}

function websocketUrl(origin: string, fileId: string, clientId: string): string {
  const url = new URL(`/sync/${encodeURIComponent(fileId)}`, origin)
  url.searchParams.set('tabId', clientId)
  return url.toString()
}

export function createCollaborationClient<TDocument extends object>(options: CollaborationClientOptions<TDocument>) {
  const origin = validateSyncOrigin(options.syncOrigin)
  const buildId = validateIdentifier(options.buildId, 'build id')
  const clientId = validateIdentifier(options.clientId, 'client id')
  const createId = options.createId ?? (() => crypto.randomUUID())
  const reconnectDelays = options.reconnectDelaysMs ?? [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
  if (!reconnectDelays.length || reconnectDelays.some(delay => !Number.isSafeInteger(delay) || delay < 0)) throw new Error('Reconnect delays must contain non-negative integers.')
  const random = options.random ?? Math.random
  const schedule = options.setTimer ?? setTimeout
  const cancel = options.clearTimer ?? clearTimeout
  const maxMessageBytes = validatePositiveInteger(options.maxMessageBytes ?? defaultMaxCollaborationMessageBytes, 'Message byte limit')
  const socketFactory = options.createWebSocket ?? ((url, protocol) => new WebSocket(url, protocol))
  const reportError = options.reportError ?? ((error: unknown, operation: 'room.leave') => console.error(`Collaboration ${operation} failed.`, error))
  const reportCacheError = options.reportCacheError ?? ((error: unknown) => console.error('Collaboration cache operation failed.', error))
  const listeners = new Set<() => void>()
  const usedMutationIds = new Set<string>()
  const state = createCollaborationStateMachine()
  const pending: PendingMutation<TDocument>[] = []
  let cached: CollaborationClientSnapshot<TDocument> = Object.freeze({
    lifecycle: 'cold',
    fileId: null,
    clientId,
    mode: null,
    role: null,
    document: null,
    snapshotId: null,
    serverSequence: '0',
    lastOperation: null,
    participants: Object.freeze([]),
    pendingMutationIds: Object.freeze([]),
    recoverableMutationIds: Object.freeze([]),
    reconnectAttempt: 0,
    error: null,
    disposed: false,
  })
  let binding: SocketBinding | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let presenceTimer: ReturnType<typeof setTimeout> | null = null
  let socketEpoch = 0
  let requestId: string | null = null
  let roomEnvelope: ServerRoomEnvelope | null = null
  let assembler: ReturnType<typeof createSnapshotAssembler> | null = null
  let stagedSnapshot: StagedSnapshot<TDocument> | null = null
  let stopped = true
  let disposed = false
  let presenceSequence = 0
  let localPresence = emptyPresence
  let pendingPresence: PresencePatch | null = null
  let durableStore: CollaborationDurableStore | null = null
  let durableScope: CollaborationStoreScope | null = null
  let recoverableMutationIds = new Set<string>()
  let persistenceChain = Promise.resolve()
  let sessionEpoch = 0

  const persist = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = persistenceChain.then(operation)
    persistenceChain = result.then(() => undefined, () => undefined)
    return result
  }
  const persistInBackground = (operation: () => Promise<unknown>) => {
    void persist(operation).catch(reportCacheError)
  }

  const publish = (patch: Partial<CollaborationClientSnapshot<TDocument>>) => {
    cached = Object.freeze({ ...cached, ...patch })
    for (const listener of listeners) listener()
    return cached
  }

  const publishState = (patch: Partial<CollaborationClientSnapshot<TDocument>> = {}) => {
    const current = state.getSnapshot()
    return publish({ lifecycle: current.lifecycle, mode: current.mode, role: current.role, ...patch })
  }

  const publishPending = () => publish({
    pendingMutationIds: Object.freeze(pending.map(item => item.id)),
    recoverableMutationIds: Object.freeze([...recoverableMutationIds]),
  })

  const releaseAllPending = (error: Error) => {
    const rejected = pending.splice(0)
    publishPending()
    for (const mutation of rejected) {
      if (!mutation.settled) mutation.reject(error)
      mutation.settled = true
    }
  }

  const retainPendingAsRecoverable = (error: Error) => {
    const store = durableStore
    const scope = durableScope
    for (const mutation of pending) {
      recoverableMutationIds.add(mutation.id)
      if (!mutation.settled) mutation.reject(error)
      mutation.settled = true
      if (store && scope) void persist(() => store.markRecoverable(scope, mutation.id)).catch(reportCacheError)
    }
    publishPending()
  }

  const disposeAssembler = () => {
    assembler?.dispose()
    assembler = null
    stagedSnapshot = null
  }

  const cancelReconnect = () => {
    if (reconnectTimer === null) return
    cancel(reconnectTimer)
    reconnectTimer = null
  }

  const cancelPresence = () => {
    if (presenceTimer !== null) cancel(presenceTimer)
    presenceTimer = null
    pendingPresence = null
  }

  const detach = (close: boolean, code = normalClosure, reason = 'Client stopped') => {
    const current = binding
    binding = null
    if (!current) return
    current.socket.removeEventListener('open', current.open)
    current.socket.removeEventListener('message', current.message)
    current.socket.removeEventListener('close', current.close)
    current.socket.removeEventListener('error', current.error)
    if (close) current.socket.close(code, reason)
  }

  const transitionIfAllowed = (to: ClientLifecycleState) => {
    const from = state.getSnapshot().lifecycle
    if (!isValidClientLifecycleTransition(from, to)) return false
    state.transition(to)
    publishState()
    return true
  }

  const terminal = (lifecycle: 'access-revoked' | 'incompatible-build' | 'capacity-refused', error: Error) => {
    cancelReconnect()
    cancelPresence()
    publishParticipants([])
    stopped = true
    disposeAssembler()
    transitionIfAllowed(lifecycle)
    publishState(lifecycle === 'access-revoked'
      ? { error: error.message, document: null, snapshotId: null, serverSequence: '0', lastOperation: null }
      : { error: error.message })
    retainPendingAsRecoverable(error)
    if (lifecycle === 'access-revoked' && durableStore && durableScope) {
      const store = durableStore
      const scope = durableScope
      void persist(() => store.clearCheckpoint(scope)).catch(reportCacheError)
    }
    detach(true, policyViolation, error.message.slice(0, 123))
  }

  const send = (message: CollaborationClientMessage) => {
    const current = binding
    if (!current || current.socket.readyState !== openState) throw new Error('Collaboration socket is not open.')
    const encoded = encodeCollaborationMessage(message)
    if (new TextEncoder().encode(encoded).byteLength > maxMessageBytes) throw new CollaborationMessageTooLargeError()
    parseCollaborationClientMessage(encoded, maxMessageBytes)
    current.socket.send(encoded)
  }

  const publishParticipants = (participants: readonly PresenceParticipant[]) => {
    const copied = Object.freeze(participants.map(copyParticipant))
    publish({ participants: copied })
    return copied
  }

  const flushPresence = () => {
    if (presenceTimer !== null) cancel(presenceTimer)
    presenceTimer = null
    const data = pendingPresence
    pendingPresence = null
    if (!data || cached.participants.length <= 1 || state.getSnapshot().lifecycle !== 'live' || state.getSnapshot().mode !== 'editable' || !roomEnvelope) return
    presenceSequence += 1
    send({
      type: 'presence.update',
      sequence: presenceSequence,
      data,
    })
  }

  const schedulePresence = (delay = presenceFrameMs) => {
    if (presenceTimer !== null || cached.participants.length <= 1) return
    presenceTimer = schedule(() => {
      try { flushPresence() } catch (error) { protocolFailure(error) }
    }, delay)
  }

  const updateParticipant = (participant: PresenceParticipant) => {
    const index = cached.participants.findIndex(item => item.presenceId === participant.presenceId)
    if (index < 0) throw new Error('Presence update arrived before participant join.')
    const current = cached.participants[index]!
    if (current.subjectId !== participant.subjectId || current.displayName !== participant.displayName || current.avatarUrl !== participant.avatarUrl || current.clientId !== participant.clientId || current.role !== participant.role) {
      throw new Error('Presence identity changed for an active participant.')
    }
    if (current.sequence !== null && participant.sequence !== null && participant.sequence <= current.sequence) return
    const next = [...cached.participants]
    next[index] = copyParticipant(participant)
    publishParticipants(next)
  }

  const updateLocalParticipant = (data: PresenceState) => {
    const index = cached.participants.findIndex(item => item.clientId === clientId)
    if (index < 0) return
    const current = cached.participants[index]!
    const next = [...cached.participants]
    next[index] = copyParticipant({ ...current, data })
    publishParticipants(next)
  }

  const currentMessageContext = (envelope: ServerRoomEnvelope, frameRequestId = requestId) => {
    if (!frameRequestId || !binding) throw new StaleCollaborationMessageError('no_active_attempt')
    return { requestId: frameRequestId, socketEpoch: binding.epoch, envelope }
  }

  const assertCurrent = (message: Exclude<CollaborationServerMessage, { type: 'request.error' | 'admission.queued' }>) => {
    const frameRequestId = 'requestId' in message ? message.requestId : requestId
    state.assertCurrentMessage(currentMessageContext(message.envelope, frameRequestId))
  }

  const sendNextMutation = () => {
    const mutation = pending[0]
    const current = binding
    const machine = state.getSnapshot()
    if (!mutation || !current || current.socket.readyState !== openState || machine.lifecycle !== 'live' || !roomEnvelope) return
    if (mutation.sentSocketEpoch === current.epoch) return
    mutation.baseSequence ??= cached.serverSequence
    const message: CollaborationClientMessage = {
      type: 'operation.submit',
      operation: { mutationId: mutation.id, baseSequence: mutation.baseSequence, command: mutation.command },
    }
    send(message)
    mutation.sentSocketEpoch = current.epoch
  }

  const storedCheckpoint = (document: TDocument, snapshotId: string, serverSequence: DurableSequence): StoredCollaborationCheckpoint => Object.freeze({
    document,
    snapshotId,
    serverSequence,
  })

  const persistCheckpoint = (document: TDocument, snapshotId: string, serverSequence: DurableSequence): Promise<void> | null => {
    if (!durableStore || !durableScope) return null
    const store = durableStore
    const scope = durableScope
    return persist(() => store.checkpoint(scope, storedCheckpoint(document, snapshotId, serverSequence)))
  }

  const applyAuthoritativeCommand = (operation: Extract<CollaborationServerMessage, { type: 'operation.applied' }>, expectedSessionEpoch: number): void | Promise<void> => {
    const { sequence, command } = operation
    const comparison = compareSequence(sequence, cached.serverSequence)
    if (comparison <= 0) return
    if (sequence !== nextSequence(cached.serverSequence) || !cached.document) throw new Error('Collaboration operation sequence is discontinuous.')
    const document = options.validateDocument(options.applyCommand(cached.document, command))
    const commit = () => {
      if (sessionEpoch !== expectedSessionEpoch || stopped || disposed) return
      publish({ document, serverSequence: sequence, lastOperation: Object.freeze({
        source: 'remote',
        mutationId: operation.mutationId,
        sequence,
        subjectId: operation.subjectId,
        command,
      }) })
    }
    const persistence = persistCheckpoint(document, cached.snapshotId ?? `projection:${sequence}`, sequence)
    if (persistence) void persistence.catch(reportCacheError)
    commit()
  }

  const reconnectDelay = (attempt: number) => {
    const base = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)]!
    const sample = random()
    const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5
    return Math.round(base * (0.5 + jitter))
  }

  let connect: () => void

  const scheduleReconnect = (message: string) => {
    if (stopped || disposed || reconnectTimer !== null) return
    disposeAssembler()
    cancelPresence()
    publishParticipants([])
    roomEnvelope = null
    for (const mutation of pending) mutation.sentSocketEpoch = null
    const dirty = pending.length > 0
    const lifecycle = state.getSnapshot().lifecycle
    if (lifecycle === 'live' || lifecycle === 'read-only') transitionIfAllowed(dirty ? 'offline-dirty' : 'offline-clean')
    else if (lifecycle === 'streaming' || lifecycle === 'applying' || lifecycle === 'replaying' || lifecycle === 'admission-queued') transitionIfAllowed(dirty ? 'offline-dirty' : 'offline-clean')
    if (state.getSnapshot().lifecycle === 'offline-clean' || state.getSnapshot().lifecycle === 'offline-dirty' || state.getSnapshot().lifecycle === 'draining' || state.getSnapshot().lifecycle === 'parked') transitionIfAllowed('reconnecting')
    else if (isValidClientLifecycleTransition(state.getSnapshot().lifecycle, 'closing')) {
      state.transition('closing')
      state.transition('closed')
      publishState()
    }
    const attempt = cached.reconnectAttempt + 1
    publishState({ reconnectAttempt: attempt, error: message })
    reconnectTimer = schedule(() => {
      reconnectTimer = null
      if (!stopped && !disposed) connect()
    }, reconnectDelay(attempt - 1))
  }

  const protocolFailure = (error: unknown, code = policyViolation) => {
    const failure = error instanceof Error ? error : new Error('Invalid collaboration message.')
    detach(true, code, failure.message.slice(0, 123))
    scheduleReconnect(failure.message)
  }

  const receive = (message: CollaborationServerMessage, expectedSessionEpoch: number): void | Promise<void> => {
    if (sessionEpoch !== expectedSessionEpoch || stopped || disposed) return
    const current = binding
    if (!current || !requestId) return
    if (message.type === 'request.error') {
      if (message.requestId !== requestId) throw new StaleCollaborationMessageError('request')
      const failure = new Error(message.message)
      if (message.code === 'unsupported_epoch' || message.code === 'unsupported_schema' || message.code === 'incompatible_build') terminal('incompatible-build', failure)
      else if (message.code === 'capacity_refused') terminal('capacity-refused', failure)
      else if (message.code === 'unauthorized' || message.code === 'forbidden' || message.code === 'file_not_found') terminal('access-revoked', failure)
      else throw failure
      return
    }
    if (message.type === 'admission.queued') {
      if (message.requestId !== requestId) throw new StaleCollaborationMessageError('request')
      if (state.getSnapshot().lifecycle === 'authorizing') state.acceptAdmissionQueued({ requestId, socketEpoch: current.epoch })
      publishState({ error: null })
      return
    }
    if (message.type === 'room.assigned') {
      if (state.getSnapshot().lifecycle === 'authorizing') state.acceptAdmissionQueued({ requestId, socketEpoch: current.epoch })
      roomEnvelope = state.assignRoom({ requestId: message.requestId, socketEpoch: current.epoch, envelope: message.envelope, role: message.role })
      publishState({ error: null })
      if (cached.reconnectAttempt > 0 || pending.length > 0 || cached.snapshotId) {
        send({
          type: 'room.resume',
          requestId,
          afterSequence: cached.serverSequence,
          pendingMutationIds: pending.map(item => item.id),
        })
      }
      return
    }
    assertCurrent(message)
    if (message.type === 'load.phase') {
      if (message.phase === 'stream') {
        const lifecycle = state.getSnapshot().lifecycle
        if (lifecycle === 'admission-queued') state.transition('streaming')
      } else if (state.getSnapshot().lifecycle === 'streaming') state.transition('applying')
      publishState()
      return
    }
    if (message.type === 'snapshot.begin') {
      if (state.getSnapshot().lifecycle === 'admission-queued') state.transition('streaming')
      disposeAssembler()
      assembler = createSnapshotAssembler(message)
      publishState()
      return
    }
    if (message.type === 'snapshot.chunk') {
      if (!assembler) throw new Error('Snapshot chunk arrived before snapshot metadata.')
      assembler.push(message)
      return
    }
    if (message.type === 'snapshot.end') {
      if (!assembler) throw new Error('Snapshot end arrived before snapshot metadata.')
      assembler.finish(message)
      const publication = assembler.publish()
      let decoded: unknown
      try { decoded = JSON.parse(publication.jsonText) } catch { throw new Error('Snapshot document is not valid JSON.') }
      const document = options.validateDocument(decoded)
      stagedSnapshot = Object.freeze({ requestId: publication.requestId, snapshotId: publication.snapshotId, baseSequence: publication.baseSequence, document })
      assembler = null
      return
    }
    if (message.type === 'sync.ready') {
      const staged = stagedSnapshot
      if (!staged || staged.requestId !== message.requestId || staged.snapshotId !== message.snapshotId || staged.baseSequence !== message.serverSequence) throw new Error('Sync readiness does not match the verified snapshot.')
      if (state.getSnapshot().lifecycle === 'streaming') state.transition('applying')
      if (pending.length > 0 && state.getSnapshot().lifecycle === 'applying') state.transition('replaying')
      state.acceptSyncReady({ requestId: message.requestId, socketEpoch: current.epoch, envelope: message.envelope, role: message.role })
      stagedSnapshot = null
      const commit = () => {
        if (sessionEpoch !== expectedSessionEpoch || stopped || disposed) return
        publishState({
          document: staged.document,
          snapshotId: staged.snapshotId,
          serverSequence: staged.baseSequence,
          lastOperation: null,
          reconnectAttempt: 0,
          error: null,
        })
        for (const mutation of pending) {
          mutation.baseSequence = null
          mutation.sentSocketEpoch = null
        }
        if (state.getSnapshot().lifecycle === 'read-only' && pending.length > 0) retainPendingAsRecoverable(new Error('This file is read only.'))
        else sendNextMutation()
      }
      const persistence = persistCheckpoint(staged.document, staged.snapshotId, staged.baseSequence)
      if (persistence) void persistence.catch(reportCacheError)
      commit()
      return
    }
    if (message.type === 'operation.applied') {
      return applyAuthoritativeCommand(message, expectedSessionEpoch)
    }
    if (message.type === 'presence.roster') {
      const wasSinglePlayer = cached.participants.length <= 1
      const participants = publishParticipants(message.participants)
      if (wasSinglePlayer && participants.length > 1 && state.getSnapshot().mode === 'editable') {
        pendingPresence = fullPresencePatch(localPresence)
        schedulePresence(0)
      }
      return
    }
    if (message.type === 'presence.join') {
      if (cached.participants.some(item => item.presenceId === message.participant.presenceId)) throw new Error('Participant joined twice.')
      const wasSinglePlayer = cached.participants.length <= 1
      const previousIndex = cached.participants.findIndex(item => item.clientId === message.participant.clientId)
      let nextParticipants: readonly PresenceParticipant[]
      if (previousIndex < 0) nextParticipants = [...cached.participants, message.participant]
      else {
        const previous = cached.participants[previousIndex]!
        if (previous.subjectId !== message.participant.subjectId) throw new Error('Presence subject changed across a participant reconnect.')
        const next = [...cached.participants]
        next[previousIndex] = message.participant
        nextParticipants = next
      }
      const participants = publishParticipants(nextParticipants)
      if (wasSinglePlayer && participants.length > 1 && state.getSnapshot().mode === 'editable') {
        pendingPresence = fullPresencePatch(localPresence)
        schedulePresence(0)
      }
      return
    }
    if (message.type === 'presence.changed') {
      updateParticipant(message.participant)
      return
    }
    if (message.type === 'presence.leave') {
      const participant = cached.participants.find(item => item.presenceId === message.presenceId)
      if (!participant) return
      if (participant.subjectId !== message.subjectId || participant.clientId !== message.clientId) {
        throw new Error('Presence leave identity does not match the active participant.')
      }
      const participants = publishParticipants(cached.participants.filter(item => item.presenceId !== message.presenceId))
      if (participants.length <= 1) cancelPresence()
      return
    }
    if (message.type === 'operation.ack') {
      const index = pending.findIndex(item => item.id === message.mutationId)
      if (index < 0) return
      if (index !== 0) throw new Error('Collaboration acknowledgement arrived out of order.')
      const mutation = pending[0]!
      if (mutation.baseSequence === null) throw new Error('Collaboration acknowledgement arrived before submission.')
      const comparison = compareSequence(message.sequence, cached.serverSequence)
      let document = cached.document
      let lastOperation = cached.lastOperation
      if (message.status === 'applied') {
        if (comparison <= 0) throw new Error('Applied collaboration acknowledgement is not newer than the visible document.')
        if (message.sequence !== nextSequence(cached.serverSequence) || !cached.document) throw new Error('Collaboration acknowledgement sequence is discontinuous.')
        document = mutation.validateResult(options.applyCommand(cached.document, mutation.command))
        lastOperation = Object.freeze({ source: 'local', mutationId: mutation.id, sequence: message.sequence, command: mutation.command })
      } else if (comparison > 0) {
        throw new Error('Duplicate collaboration acknowledgement is ahead of the visible document.')
      }
      if (!document) throw new Error('Collaboration acknowledgement arrived before a document was loaded.')
      const committedSequence = message.status === 'applied' ? message.sequence : cached.serverSequence
      const finish = () => {
        if (sessionEpoch !== expectedSessionEpoch || stopped || disposed) return
        if (message.status === 'applied') publish({ document, serverSequence: committedSequence, lastOperation })
        pending.shift()
        recoverableMutationIds.delete(mutation.id)
        publishPending()
        if (!mutation.settled) mutation.resolve(Object.freeze({ mutationId: mutation.id, sequence: message.sequence, status: message.status }))
        mutation.settled = true
        sendNextMutation()
      }
      if (durableStore && durableScope) {
        const store = durableStore
        const scope = durableScope
        const checkpoint = storedCheckpoint(document, cached.snapshotId ?? `projection:${committedSequence}`, committedSequence)
        persistInBackground(() => store.acknowledge(scope, mutation.id, checkpoint))
      }
      finish()
      return
    }
    if (message.type === 'operation.rebase_required') {
      if (pending.some(item => item.id === message.mutationId)) {
        detach(true, reconnectRequired, 'Resync required')
        scheduleReconnect('The file changed. Resyncing pending changes.')
      }
      return
    }
    if (message.type === 'room.error') {
      const failure = new Error(message.message)
      if (message.code === 'access_revoked') terminal('access-revoked', failure)
      else if (message.code === 'incompatible_build') terminal('incompatible-build', failure)
      else if (message.code === 'capacity_refused') terminal('capacity-refused', failure)
      else if (message.retry === 'reconnect' || message.code === 'draining') {
        transitionIfAllowed('draining')
        detach(true, reconnectRequired, 'Reconnect required')
        scheduleReconnect(message.message)
      } else {
        const mutation = message.mutationId ? pending.find(item => item.id === message.mutationId) : undefined
        if (mutation) {
          const retain = () => {
            if (sessionEpoch !== expectedSessionEpoch || stopped || disposed) return
            pending.splice(pending.indexOf(mutation), 1)
            recoverableMutationIds.add(mutation.id)
            publishPending()
            if (!mutation.settled) mutation.reject(failure)
            mutation.settled = true
            sendNextMutation()
          }
          if (durableStore && durableScope) {
            const store = durableStore
            const scope = durableScope
            return persist(() => store.markRecoverable(scope, mutation.id)).then(retain)
          }
          retain()
        } else throw failure
      }
    }
  }

  connect = () => {
    if (stopped || disposed || !cached.fileId || binding) return
    const nextRequestId = validateIdentifier(createId(), 'request id')
    socketEpoch += 1
    requestId = nextRequestId
    const attempt = { fileId: cached.fileId, requestId: nextRequestId, socketEpoch }
    if (state.getSnapshot().lifecycle === 'reconnecting') state.startReconnectAttempt(attempt)
    else {
      state.open(attempt)
      state.transition('authorizing')
    }
    publishState({ error: null })
    let socket: CollaborationWebSocket
    try { socket = socketFactory(websocketUrl(origin, cached.fileId, clientId), syncWebSocketProtocol) }
    catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : 'Collaboration connection failed.')
      return
    }
    const epoch = socketEpoch
    const activeSessionEpoch = sessionEpoch
    let socketReceiveChain = Promise.resolve()
    const open = () => {
      if (!binding || binding.epoch !== epoch || sessionEpoch !== activeSessionEpoch || stopped || disposed || !cached.fileId) return
      try {
        send({
          type: 'room.open',
          protocolEpoch: collaborationProtocolEpoch,
          schemaVersion: collaborationEnvelopeSchemaVersion,
          requestId: nextRequestId,
          fileId: cached.fileId,
          clientId,
          buildId,
          ...(cached.snapshotId ? { cachedSnapshotId: cached.snapshotId, afterSequence: cached.serverSequence } : {}),
        })
      } catch (error) { protocolFailure(error) }
    }
    const message = (event: MessageEvent<unknown>) => {
      if (!binding || binding.epoch !== epoch || sessionEpoch !== activeSessionEpoch) return
      if (typeof event.data !== 'string') { protocolFailure(new Error('Binary collaboration messages are not supported.'), unsupportedData); return }
      if (new TextEncoder().encode(event.data).byteLength > maxMessageBytes) { protocolFailure(new Error('Collaboration message exceeds the byte limit.'), messageTooLarge); return }
      let parsed: CollaborationServerMessage
      try { parsed = parseCollaborationServerMessage(event.data, maxMessageBytes) }
      catch (error) { protocolFailure(error); return }
      if (durableScope) {
        socketReceiveChain = socketReceiveChain
          .then(() => {
            if (!binding || binding.epoch !== epoch || sessionEpoch !== activeSessionEpoch || stopped || disposed) return
            return receive(parsed, activeSessionEpoch)
          })
          .catch(error => {
            if (binding?.epoch === epoch && sessionEpoch === activeSessionEpoch && !stopped && !disposed) protocolFailure(error)
          })
        return
      }
      try {
        const result = receive(parsed, activeSessionEpoch)
        if (result) void result.catch(error => {
          if (binding?.epoch === epoch && sessionEpoch === activeSessionEpoch && !stopped && !disposed) protocolFailure(error)
        })
      } catch (error) { protocolFailure(error) }
    }
    const close = (event: CloseEvent) => {
      if (!binding || binding.epoch !== epoch || sessionEpoch !== activeSessionEpoch) return
      detach(false)
      if (!stopped && !disposed) scheduleReconnect(event.reason || 'Collaboration disconnected.')
    }
    const error = () => {
      if (!binding || binding.epoch !== epoch || sessionEpoch !== activeSessionEpoch) return
      publish({ error: 'Collaboration connection failed.' })
    }
    binding = Object.freeze({ socket, epoch, open, message, close, error })
    socket.addEventListener('open', open)
    socket.addEventListener('message', message)
    socket.addEventListener('close', close)
    socket.addEventListener('error', error)
  }

  const stop = () => {
    const lifecycle = state.getSnapshot().lifecycle
    if (stopped && (lifecycle === 'cold' || lifecycle === 'closed')) return
    sessionEpoch += 1
    stopped = true
    cancelReconnect()
    disposeAssembler()
    cancelPresence()
    if (binding?.socket.readyState === openState && roomEnvelope) {
      try { send({ type: 'room.leave' }) } catch (error) { reportError(error, 'room.leave') }
    }
    detach(true)
    roomEnvelope = null
    publishParticipants([])
    releaseAllPending(new Error('Collaboration client stopped.'))
    transitionIfAllowed('closing')
    transitionIfAllowed('closed')
    publishState({ reconnectAttempt: 0 })
  }

  return Object.freeze({
    getSnapshot: () => cached,
    subscribe(listener: () => void) {
      if (disposed) throw new Error('Collaboration client is disposed.')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start(input: CollaborationClientStartInput): Promise<void> {
      if (disposed) throw new Error('Collaboration client is disposed.')
      if (!stopped) throw new Error('Collaboration client is already started.')
      const fileId = validateFileId(input.fileId)
      let nextScope: CollaborationStoreScope | null = null
      if (input.cache !== false) {
        const accountId = validateIdentifier(input.cache.accountId, 'account id')
        const documentSchemaVersion = validatePositiveInteger(input.cache.documentSchemaVersion, 'Document schema version')
        nextScope = Object.freeze({ accountId, clientId, fileId, documentSchemaVersion, protocolEpoch: collaborationProtocolEpoch })
      }
      sessionEpoch += 1
      const activeSessionEpoch = sessionEpoch
      stopped = false
      presenceSequence = 0
      localPresence = emptyPresence
      pending.splice(0)
      recoverableMutationIds = new Set()
      durableScope = nextScope
      durableStore = nextScope ? options.durableStore ?? createIndexedDbCollaborationStore() : null
      publish({ fileId, document: null, snapshotId: null, serverSequence: '0', lastOperation: null, participants: Object.freeze([]), pendingMutationIds: Object.freeze([]), recoverableMutationIds: Object.freeze([]), reconnectAttempt: 0, error: null })
      if (!durableStore || !durableScope) {
        connect()
        return Promise.resolve()
      }
      const store = durableStore
      const scope = durableScope
      return persistenceChain.then(() => store.load(scope)).then(async value => {
        if (stopped || disposed || sessionEpoch !== activeSessionEpoch || durableScope !== scope) return
        const hydrated = hydrateStoredRoom(value, scope, options.validateDocument)
        if (hydrated.repaired) await store.repair(scope, hydrated.room)
        if (stopped || disposed || sessionEpoch !== activeSessionEpoch || durableScope !== scope) return
        for (const item of hydrated.room.pending) {
          usedMutationIds.add(item.mutationId)
          if (item.status === 'recoverable') {
            recoverableMutationIds.add(item.mutationId)
            continue
          }
          pending.push({
            id: item.mutationId,
            command: decodeSemanticCommandFromPersistence(item.command),
            baseSequence: item.baseSequence,
            sentSocketEpoch: null,
            resolve: () => undefined,
            reject: () => undefined,
            validateResult: options.validateDocument,
            settled: true,
          })
        }
        publish({
          document: hydrated.document,
          snapshotId: hydrated.room.checkpoint?.snapshotId ?? null,
          serverSequence: hydrated.room.checkpoint?.serverSequence ?? '0',
          pendingMutationIds: Object.freeze(pending.map(item => item.id)),
          recoverableMutationIds: Object.freeze([...recoverableMutationIds]),
        })
        connect()
      }).catch(error => {
        const failure = error instanceof Error ? error : new Error('Collaboration cache could not be loaded.')
        if (sessionEpoch === activeSessionEpoch && durableScope === scope) {
          stopped = true
          durableScope = null
          durableStore = null
          publish({ error: failure.message })
        }
        throw failure
      })
    },
    updatePresence(patch: PresencePatch, options: Readonly<{ immediate?: boolean }> = {}): void {
      if (disposed) throw new Error('Collaboration client is disposed.')
      if (state.getSnapshot().mode !== 'editable' || state.getSnapshot().lifecycle !== 'live' || !roomEnvelope) throw new Error('This file is read only.')
      const nextPresence = mergePresenceState(localPresence, patch)
      const immediate = options.immediate === true
      if (immediate && !isImmediateInteractionPatch(patch)) throw new Error('Only interaction presence can bypass the frame limit.')
      const data = immediate ? patch : mergePresencePatch(pendingPresence, patch)
      const candidate = {
        type: 'presence.update' as const,
        sequence: presenceSequence + 1,
        data,
      }
      parseCollaborationClientMessage(JSON.stringify(candidate), maxMessageBytes)
      if (immediate) {
        try {
          send({ type: 'presence.update', sequence: candidate.sequence, data })
        } catch (error) {
          localPresence = mergePresenceState(localPresence, { interaction: null })
          protocolFailure(error, internalError)
          throw error
        }
        presenceSequence = candidate.sequence
        localPresence = nextPresence
        if (pendingPresence && Object.hasOwn(patch, 'pageId')) pendingPresence = mergePresencePatch(pendingPresence, { pageId: patch.pageId ?? null })
      } else {
        localPresence = nextPresence
        const authoritativeInteraction = cached.participants.find(participant => participant.clientId === clientId)?.data.interaction ?? null
        updateLocalParticipant(Object.freeze({ ...localPresence, interaction: authoritativeInteraction }))
        pendingPresence = data
        schedulePresence()
      }
    },
    submit(input: CollaborationMutationInput): Promise<CollaborationMutationReceipt> {
      if (disposed) return Promise.reject(new Error('Collaboration client is disposed.'))
      if (state.getSnapshot().mode !== 'editable' || state.getSnapshot().lifecycle !== 'live') return Promise.reject(new Error('This file is read only.'))
      const validCommand = decodeSemanticCommandFromPersistence(encodeSemanticCommandForPersistence(validateSemanticFileCommand(input.command)))
      const id = validateIdentifier(input.mutationId, 'mutation id')
      if (id.length < 8) return Promise.reject(new Error('Invalid mutation id.'))
      if (usedMutationIds.has(id)) return Promise.reject(new Error('Mutation id was already used.'))
      if (pending.length >= maxPendingMutations) return Promise.reject(new Error('Too many pending collaboration changes.'))
      const candidate: CollaborationClientMessage = { type: 'operation.submit', operation: { mutationId: id, baseSequence: maximumDurableSequence, command: validCommand } }
      const encoded = encodeCollaborationMessage(candidate)
      if (new TextEncoder().encode(encoded).byteLength > maxMessageBytes) return Promise.reject(new CollaborationMessageTooLargeError())
      parseCollaborationClientMessage(encoded, maxMessageBytes)
      if (!durableStore || !durableScope) return Promise.reject(new Error('Collaboration storage is required before editing.'))
      usedMutationIds.add(id)
      const activeSessionEpoch = sessionEpoch
      const register = () => {
        if (stopped || disposed || sessionEpoch !== activeSessionEpoch) return Promise.reject(new Error('Collaboration client stopped after the change was saved for recovery.'))
        return new Promise<CollaborationMutationReceipt>((resolve, reject) => {
          const mutation: PendingMutation<TDocument> = { id, command: validCommand, baseSequence: null, sentSocketEpoch: null, resolve, reject, validateResult: options.validateDocument, settled: false }
          pending.push(mutation)
          publishPending()
          try { sendNextMutation() } catch (error) {
            if (error instanceof CollaborationMessageTooLargeError) {
              pending.splice(pending.indexOf(mutation), 1)
              publishPending()
              mutation.reject(error)
              mutation.settled = true
            } else {
              detach(true, policyViolation, 'Invalid operation')
              scheduleReconnect(error instanceof Error ? error.message : 'Operation submission failed.')
            }
          }
        })
      }
      const store = durableStore
      const scope = durableScope
      return persist(() => store.enqueue(scope, Object.freeze({
        mutationId: id,
        baseSequence: null,
        command: encodeSemanticCommandForPersistence(validCommand),
        status: 'pending',
      }))).then(register, error => {
        usedMutationIds.delete(id)
        throw error
      })
    },
    stop,
    dispose() {
      if (disposed) return
      stop()
      disposed = true
      state.dispose()
      listeners.clear()
      publish({ disposed: true })
    },
    purgeAccount(accountId: string): Promise<void> {
      const validAccountId = validateIdentifier(accountId, 'account id')
      if (durableScope?.accountId === validAccountId && !stopped) stop()
      const store = options.durableStore ?? durableStore ?? createIndexedDbCollaborationStore()
      return persist(() => store.purgeAccount(validAccountId))
    },
  })
}
