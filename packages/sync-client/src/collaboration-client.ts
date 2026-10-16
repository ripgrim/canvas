import {
  collaborationEnvelopeSchemaVersion,
  collaborationProtocolEpoch,
  collaborationWebSocketProtocol,
  decodeSemanticCommandFromPersistence,
  defaultMaxCollaborationMessageBytes,
  encodeSemanticCommandForPersistence,
  encodeCollaborationMessage,
  flowDragResourceLimits,
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
  FlowDragLane,
  FlowDragPresentation,
  FlowDragServerLeaseId,
  FlowDragTerminalBinding,
  FlowDragTopologyAuthority,
  InteractionResultMessage,
  InteractionRosterEntry,
  InteractionSampleAcceptedMessage,
  InteractionReleasedMessage,
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
const maxPendingMutations = 512
const presenceFrameMs = 30
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digestPattern = /^[0-9a-f]{64}$/

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

export type CollaborationClientLifecycleTarget = Readonly<{
  addEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void): void
}>

export type CollaborationMutationReceipt = Readonly<{
  mutationId: string
  sequence: DurableSequence
  status: 'applied' | 'duplicate'
}>

export type CollaborationMutationInput = Readonly<{
  mutationId: string
  command: SemanticFileCommand
  flowBinding?: FlowDragTerminalBinding
}>

export type CollaborationFlowClaim = Readonly<{
  pageId: string
  interactionId: string
  sourceNodeId: string
  localClaimGeneration: number
}>

export type CollaborationFlowRequest = Readonly<{
  claim: CollaborationFlowClaim
  result: Promise<InteractionResultMessage>
}>

export type CollaborationRemoteFlowEvent =
  | Readonly<{ type: 'sample'; source: 'live' | 'roster'; sample: InteractionSampleAcceptedMessage | InteractionRosterEntry }>
  | Readonly<{ type: 'released'; release: InteractionReleasedMessage }>

export type CollaborationFlowClaimSnapshot = Readonly<{
  claim: CollaborationFlowClaim
  leaseId: FlowDragServerLeaseId | null
  reservationGeneration: number
  currentTargetLane: FlowDragLane | null
  latestAcceptedPresentation: FlowDragPresentation | null
  sampleSequence: number
  pendingRelease: boolean
  boundMutationIds: readonly string[]
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
  remoteInteractions: readonly InteractionRosterEntry[]
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
  createWebSocket?: (url: string, protocol: typeof collaborationWebSocketProtocol) => CollaborationWebSocket
  createId?: () => string
  reconnectDelaysMs?: readonly number[]
  random?: () => number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  maxPreAdmissionFailures?: number
  lifecycleTarget?: CollaborationClientLifecycleTarget | null
  isOnline?: () => boolean
  isVisible?: () => boolean
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  maxMessageBytes?: number
  reportError?: (error: unknown, operation: 'room.leave') => void
  reportCacheError?: (error: unknown) => void
  onRemoteFlow?: (event: CollaborationRemoteFlowEvent) => void
  resolveFlowAuthority?: (document: TDocument, pageId: string) => FlowDragTopologyAuthority | null
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
  readonly replayScopeId: string
  flowBinding: FlowDragTerminalBinding | null
  quarantinedFlowBinding: boolean
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

type StagedCheckpoint<TDocument extends object> = Readonly<{
  checkpoint: StoredCollaborationCheckpoint
  document: TDocument
}>

type MutableFlowClaim = {
  readonly claim: CollaborationFlowClaim
  leaseId: FlowDragServerLeaseId | null
  reservationGeneration: number
  currentTargetLane: FlowDragLane | null
  latestAcceptedPresentation: FlowDragPresentation | null
  sampleSequence: number
  requestedPresentation: FlowDragPresentation
  requestedTargetLane: FlowDragLane | null
  pendingRelease: Readonly<{ terminalSampleSequence: number; reason: 'committed' | 'cancelled' | 'failed' | 'disconnecting' }> | null
  readonly boundMutationIds: Set<string>
}

type FlowResultWaiter = Readonly<{
  action: 'acquire' | 'reserve' | 'release'
  localClaimGeneration: number
  reservationGeneration: number
  resolve(result: InteractionResultMessage): void
  reject(error: Error): void
}>

const emptyPresence: PresenceState = Object.freeze({
  pageId: null,
  focused: false,
  selection: null,
  camera: null,
  cursor: null,
})

function copyPresenceState(value: PresenceState): PresenceState {
  return Object.freeze({
    pageId: value.pageId,
    focused: value.focused,
    selection: value.selection ? Object.freeze({ pageId: value.selection.pageId, nodeIds: Object.freeze([...value.selection.nodeIds]) }) : null,
    camera: value.camera ? Object.freeze({ ...value.camera }) : null,
    cursor: value.cursor ? Object.freeze({ ...value.cursor }) : null,
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
  })
}

function fullPresencePatch(value: PresenceState): PresencePatch {
  return Object.freeze({
    pageId: value.pageId,
    focused: value.focused,
    selection: value.selection,
    camera: value.camera,
    cursor: value.cursor,
  })
}

function mergePresencePatch(current: PresencePatch | null, patch: PresencePatch): PresencePatch {
  const merged = { ...(current ?? {}), ...patch }
  if (Object.hasOwn(patch, 'pageId') && patch.pageId !== current?.pageId) {
    if (!Object.hasOwn(patch, 'selection')) merged.selection = null
    if (!Object.hasOwn(patch, 'camera')) merged.camera = null
    if (!Object.hasOwn(patch, 'cursor')) merged.cursor = null
  }
  return Object.freeze(merged)
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
  if (value.checkpoint !== null && isRecord(value.checkpoint) && exactKeys(value.checkpoint, ['snapshotId', 'serverSequence', 'document', 'replayScopeId'])) {
    try {
      if (typeof value.checkpoint.snapshotId !== 'string') throw new Error('Invalid snapshot id.')
      const snapshotId = validateIdentifier(value.checkpoint.snapshotId, 'snapshot id')
      const serverSequence = validateSequence(value.checkpoint.serverSequence)
      if (typeof value.checkpoint.replayScopeId !== 'string' || !digestPattern.test(value.checkpoint.replayScopeId)) throw new Error('Invalid replay scope id.')
      document = validateDocument(value.checkpoint.document)
      checkpoint = Object.freeze({ snapshotId, serverSequence, document, replayScopeId: value.checkpoint.replayScopeId })
    } catch { repaired = true }
  } else if (value.checkpoint !== null) repaired = true

  const pending: StoredCollaborationMutation[] = []
  const seen = new Set<string>()
  for (const item of value.pending) {
    try {
      if (!isRecord(item)) throw new Error('Invalid stored mutation.')
      const hasFlowBinding = exactKeys(item, ['mutationId', 'baseSequence', 'command', 'status', 'replayScopeId', 'flowBinding'])
      const hasReplayScope = exactKeys(item, ['mutationId', 'baseSequence', 'command', 'status', 'replayScopeId'])
      const isLegacyMutation = exactKeys(item, ['mutationId', 'baseSequence', 'command', 'status'])
      if (!hasFlowBinding && !hasReplayScope && !isLegacyMutation) throw new Error('Invalid stored mutation.')
      if (typeof item.mutationId !== 'string') throw new Error('Invalid stored mutation id.')
      const mutationId = validateIdentifier(item.mutationId, 'mutation id')
      if (mutationId.length < 8 || seen.has(mutationId)) throw new Error('Invalid stored mutation id.')
      const baseSequence = item.baseSequence === null ? null : validateSequence(item.baseSequence)
      const command = encodeSemanticCommandForPersistence(decodeSemanticCommandFromPersistence(item.command))
      if (item.status !== 'pending' && item.status !== 'recoverable') throw new Error('Invalid stored mutation status.')
      const replayScopeId = (hasFlowBinding || hasReplayScope) && typeof item.replayScopeId === 'string' && digestPattern.test(item.replayScopeId)
        ? item.replayScopeId
        : null
      let flowBinding: FlowDragTerminalBinding | null = null
      let invalidFlowBinding = false
      if (hasFlowBinding && item.flowBinding !== null) {
        try {
          const validated = parseCollaborationClientMessage(JSON.stringify({
            type: 'operation.submit',
            operation: { mutationId, baseSequence: '0', command: decodeSemanticCommandFromPersistence(command), flowBinding: item.flowBinding },
          }))
          flowBinding = frozenJsonCopy((validated as Extract<CollaborationClientMessage, { type: 'operation.submit' }>).operation.flowBinding ?? null)
        } catch { invalidFlowBinding = true }
      }
      const status = replayScopeId === null || invalidFlowBinding ? 'recoverable' as const : item.status
      if (!hasFlowBinding || replayScopeId === null || invalidFlowBinding || status !== item.status) repaired = true
      seen.add(mutationId)
      pending.push(Object.freeze({ mutationId, baseSequence, command, status, replayScopeId, flowBinding }))
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

function browserLifecycleTarget(): CollaborationClientLifecycleTarget | null {
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

function frozenJsonCopy<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    for (const entry of Object.values(candidate)) freeze(entry)
    Object.freeze(candidate)
  }
  freeze(copy)
  return copy
}

function sameFlowSlot(left: FlowDragLane['slot'], right: FlowDragLane['slot']): boolean {
  return left.presence === right.presence && (left.presence === 'absent' || right.presence === 'present' && left.value === right.value)
}

function sameFlowLane(left: FlowDragLane | null, right: FlowDragLane | null): boolean {
  return left === right || Boolean(left && right && left.parentId === right.parentId && sameFlowSlot(left.slot, right.slot))
}

export function createCollaborationClient<TDocument extends object>(options: CollaborationClientOptions<TDocument>) {
  const origin = validateSyncOrigin(options.syncOrigin)
  const buildId = validateIdentifier(options.buildId, 'build id')
  const clientId = validateIdentifier(options.clientId, 'client id')
  const createId = options.createId ?? (() => crypto.randomUUID())
  const reconnectDelays = options.reconnectDelaysMs ?? [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
  if (!reconnectDelays.length || reconnectDelays.some(delay => !Number.isSafeInteger(delay) || delay < 0)) throw new Error('Reconnect delays must contain non-negative integers.')
  const random = options.random ?? Math.random
  const heartbeatIntervalMs = validatePositiveInteger(options.heartbeatIntervalMs ?? 15_000, 'Heartbeat interval')
  const heartbeatTimeoutMs = validatePositiveInteger(options.heartbeatTimeoutMs ?? 5_000, 'Heartbeat timeout')
  const maxPreAdmissionFailures = validatePositiveInteger(options.maxPreAdmissionFailures ?? 8, 'Pre-admission failure limit')
  const lifecycleTarget = options.lifecycleTarget === undefined ? browserLifecycleTarget() : options.lifecycleTarget
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
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
    remoteInteractions: Object.freeze([]),
    pendingMutationIds: Object.freeze([]),
    recoverableMutationIds: Object.freeze([]),
    reconnectAttempt: 0,
    error: null,
    disposed: false,
  })
  let binding: SocketBinding | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let presenceTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  let socketEpoch = 0
  let requestId: string | null = null
  let roomEnvelope: ServerRoomEnvelope | null = null
  let currentReplayScopeId: string | null = null
  let visibleReplayScopeId: string | null = null
  let assembler: ReturnType<typeof createSnapshotAssembler> | null = null
  let stagedSnapshot: StagedSnapshot<TDocument> | null = null
  let stagedCheckpoint: StagedCheckpoint<TDocument> | null = null
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
  let lifecycleListening = false
  let admittedSocketEpoch: number | null = null
  let sessionWasAdmitted = false
  const explicitRecoverySessionEpochs = new Set<number>()
  const flowClaims = new Map<number, MutableFlowClaim>()
  const flowWaiters = new Set<FlowResultWaiter>()
  const flowResultListeners = new Set<(result: InteractionResultMessage) => void>()
  const remoteFlowListeners = new Set<(event: CollaborationRemoteFlowEvent) => void>()
  const remoteFlows = new Map<string, InteractionRosterEntry>()
  let localClaimGeneration = 0
  let flowTransportGeneration = 0

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

  const flowClaimSnapshot = (claim: MutableFlowClaim): CollaborationFlowClaimSnapshot => Object.freeze({
    claim: claim.claim,
    leaseId: claim.leaseId,
    reservationGeneration: claim.reservationGeneration,
    currentTargetLane: claim.currentTargetLane,
    latestAcceptedPresentation: claim.latestAcceptedPresentation,
    sampleSequence: claim.sampleSequence,
    pendingRelease: claim.pendingRelease !== null,
    boundMutationIds: Object.freeze([...claim.boundMutationIds]),
  })

  const emitRemoteFlow = (event: CollaborationRemoteFlowEvent) => {
    options.onRemoteFlow?.(event)
    for (const listener of remoteFlowListeners) listener(event)
  }

  const rejectFlowWaiters = (error: Error) => {
    const waiters = [...flowWaiters]
    flowWaiters.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  const clearFlowState = (error: Error) => {
    flowTransportGeneration += 1
    rejectFlowWaiters(error)
    flowClaims.clear()
    remoteFlows.clear()
    if (cached.remoteInteractions.length > 0) publish({ remoteInteractions: Object.freeze([]) })
    for (const mutation of pending) {
      if (mutation.flowBinding) {
        mutation.quarantinedFlowBinding = true
        mutation.sentSocketEpoch = null
      }
    }
  }

  const releaseAllPending = (error: Error) => {
    const rejected = pending.splice(0)
    publishPending()
    for (const mutation of rejected) {
      if (!mutation.settled) mutation.reject(error)
      mutation.settled = true
    }
  }

  const retainPendingAsRecoverable = (error: Error) => {
    for (const mutation of pending) {
      recoverableMutationIds.add(mutation.id)
      if (!mutation.settled) mutation.reject(error)
      mutation.settled = true
    }
    publishPending()
  }

  const rejectPendingWithoutReclassification = (error: Error) => {
    for (const mutation of pending) {
      if (!mutation.settled) mutation.reject(error)
      mutation.settled = true
    }
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

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) cancel(heartbeatTimer)
    if (heartbeatTimeoutTimer !== null) cancel(heartbeatTimeoutTimer)
    heartbeatTimer = null
    heartbeatTimeoutTimer = null
  }

  const detach = (close: boolean, code = normalClosure, reason = 'Client stopped') => {
    clearHeartbeat()
    clearFlowState(new Error(reason))
    const current = binding
    binding = null
    if (current && admittedSocketEpoch === current.epoch) admittedSocketEpoch = null
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

  const terminal = (lifecycle: 'access-revoked' | 'incompatible-build' | 'capacity-refused' | 'connection-failed', error: Error) => {
    const currentLifecycle = state.getSnapshot().lifecycle
    if (!isValidClientLifecycleTransition(currentLifecycle, lifecycle)) throw new Error(`Invalid terminal collaboration transition from ${currentLifecycle} to ${lifecycle}.`)
    cancelReconnect()
    cancelPresence()
    detachLifecycle()
    publishParticipants([])
    stopped = true
    const requiresExplicitRecovery = lifecycle === 'access-revoked'
    if (requiresExplicitRecovery) explicitRecoverySessionEpochs.add(sessionEpoch)
    disposeAssembler()
    roomEnvelope = null
    currentReplayScopeId = null
    visibleReplayScopeId = null
    stagedCheckpoint = null
    state.transition(lifecycle)
    publishState(lifecycle === 'access-revoked'
      ? { error: error.message, document: null, snapshotId: null, serverSequence: '0', lastOperation: null }
      : { error: error.message })
    if (requiresExplicitRecovery) retainPendingAsRecoverable(error)
    else rejectPendingWithoutReclassification(error)
    if (requiresExplicitRecovery && durableStore && durableScope) {
      const store = durableStore
      const scope = durableScope
      void persist(() => store.markAllRecoverable(scope, { clearCheckpoint: lifecycle === 'access-revoked' })).catch(reportCacheError)
    }
    detach(true, policyViolation, error.message.slice(0, 123))
  }

  const trustedFlowAuthority = (pageId: string): FlowDragTopologyAuthority => {
    const document = cached.document
    const authority = document ? options.resolveFlowAuthority?.(document, pageId) ?? null : null
    if (!authority || authority.pageId !== pageId || authority.fileId !== cached.fileId) {
      throw new Error('Authoritative interaction topology is unavailable.')
    }
    return authority
  }

  const parseServerFrame = (source: string, decoded: unknown): CollaborationServerMessage => {
    if (!isRecord(decoded)) return parseCollaborationServerMessage(source, maxMessageBytes)
    if (decoded.type === 'interaction.sample') {
      const authority = typeof decoded.pageId === 'string' ? trustedFlowAuthority(decoded.pageId) : undefined
      return parseCollaborationServerMessage(source, maxMessageBytes, authority)
    }
    if (decoded.type !== 'interaction.roster') return parseCollaborationServerMessage(source, maxMessageBytes)
    if (!Array.isArray(decoded.interactions) || decoded.interactions.length === 0) {
      return parseCollaborationServerMessage(source, maxMessageBytes)
    }
    if (decoded.interactions.length > flowDragResourceLimits.maxReservationsPerRoom) {
      throw new Error('Invalid collaboration server message')
    }
    const interactions: InteractionRosterEntry[] = []
    const leases = new Set<string>()
    const interactionIds = new Set<string>()
    let parsedFrame: Extract<CollaborationServerMessage, { type: 'interaction.roster' }> | null = null
    for (const item of decoded.interactions) {
      if (!isRecord(item) || typeof item.pageId !== 'string') throw new Error('Invalid collaboration server message')
      const singleton = JSON.stringify({ ...decoded, interactions: [item] })
      const parsed = parseCollaborationServerMessage(singleton, maxMessageBytes, trustedFlowAuthority(item.pageId))
      if (parsed.type !== 'interaction.roster' || parsed.interactions.length !== 1) throw new Error('Invalid collaboration server message')
      const entry = parsed.interactions[0]!
      if (leases.has(entry.leaseId) || interactionIds.has(entry.presentation.identity.interactionId)) {
        throw new Error('Invalid collaboration server message')
      }
      leases.add(entry.leaseId)
      interactionIds.add(entry.presentation.identity.interactionId)
      interactions.push(entry)
      parsedFrame ??= parsed
    }
    return Object.freeze({ ...parsedFrame!, interactions: Object.freeze(interactions) })
  }

  const send = (message: CollaborationClientMessage) => {
    const current = binding
    if (!current || current.socket.readyState !== openState) throw new Error('Collaboration socket is not open.')
    const encoded = encodeCollaborationMessage(message)
    if (new TextEncoder().encode(encoded).byteLength > maxMessageBytes) throw new CollaborationMessageTooLargeError()
    const authority = message.type === 'interaction.acquire' || message.type === 'interaction.reserve' || message.type === 'interaction.sample'
      ? trustedFlowAuthority(message.pageId)
      : undefined
    parseCollaborationClientMessage(encoded, maxMessageBytes, authority)
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
    if (!mutation || mutation.quarantinedFlowBinding || !current || current.socket.readyState !== openState || machine.lifecycle !== 'live' || !roomEnvelope || mutation.replayScopeId !== currentReplayScopeId) return
    if (mutation.sentSocketEpoch === current.epoch) return
    mutation.baseSequence ??= cached.serverSequence
    const message: CollaborationClientMessage = {
      type: 'operation.submit',
      operation: {
        mutationId: mutation.id,
        baseSequence: mutation.baseSequence,
        command: mutation.command,
        ...(mutation.flowBinding ? { flowBinding: mutation.flowBinding } : {}),
      },
    }
    send(message)
    mutation.sentSocketEpoch = current.epoch
  }

  const storedCheckpoint = (document: TDocument, snapshotId: string, serverSequence: DurableSequence): StoredCollaborationCheckpoint => {
    if (!currentReplayScopeId) throw new Error('Collaboration replay scope is unavailable.')
    return Object.freeze({ document, snapshotId, serverSequence, replayScopeId: currentReplayScopeId })
  }

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

  const scheduleReconnect = (message: string, preAdmissionFailure = false) => {
    if (stopped || disposed || reconnectTimer !== null) return
    disposeAssembler()
    cancelPresence()
    publishParticipants([])
    roomEnvelope = null
    currentReplayScopeId = null
    for (const mutation of pending) mutation.sentSocketEpoch = null
    if (preAdmissionFailure && cached.reconnectAttempt + 1 >= maxPreAdmissionFailures) {
      terminal('connection-failed', new Error('Collaboration could not be reached. Try again.'))
      return
    }
    const dirty = pending.length > 0
    const lifecycle = state.getSnapshot().lifecycle
    if (lifecycle === 'live' || lifecycle === 'read-only') transitionIfAllowed(dirty ? 'offline-dirty' : 'offline-clean')
    else if (lifecycle === 'authorizing' || lifecycle === 'streaming' || lifecycle === 'applying' || lifecycle === 'replaying' || lifecycle === 'admission-queued') transitionIfAllowed(dirty ? 'offline-dirty' : 'offline-clean')
    const disconnectedLifecycle = state.getSnapshot().lifecycle
    if (!isVisible() && !dirty && disconnectedLifecycle === 'offline-clean') transitionIfAllowed('parked')
    if (!isOnline() || !isVisible()) {
      publishState({ error: message })
      return
    }
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
      if (stopped || disposed) return
      if (!isOnline() || !isVisible()) {
        scheduleReconnect(message)
        return
      }
      connect()
    }, reconnectDelay(attempt - 1))
  }

  const armHeartbeat = (socket: CollaborationWebSocket, epoch: number, expectedSessionEpoch: number, delayMs = heartbeatIntervalMs) => {
    clearHeartbeat()
    heartbeatTimer = schedule(() => {
      heartbeatTimer = null
      if (!binding || binding.socket !== socket || binding.epoch !== epoch || sessionEpoch !== expectedSessionEpoch || stopped || disposed) return
      if (!isOnline() || !isVisible()) return
      try { socket.send('ping') }
      catch {
        detach(true, reconnectRequired, 'Heartbeat send failed')
        scheduleReconnect('Collaboration heartbeat failed.')
        return
      }
      heartbeatTimeoutTimer = schedule(() => {
        heartbeatTimeoutTimer = null
        if (!binding || binding.socket !== socket || binding.epoch !== epoch || sessionEpoch !== expectedSessionEpoch || stopped || disposed) return
        detach(true, reconnectRequired, 'Heartbeat timeout')
        scheduleReconnect('Collaboration heartbeat timed out.')
      }, heartbeatTimeoutMs)
    }, delayMs)
  }

  const protocolFailure = (error: unknown, code = policyViolation) => {
    const failure = error instanceof Error ? error : new Error('Invalid collaboration message.')
    const preAdmissionFailure = !sessionWasAdmitted && binding !== null && admittedSocketEpoch !== binding.epoch
    detach(true, code, failure.message.slice(0, 123))
    scheduleReconnect(failure.message, preAdmissionFailure)
  }

  const flowTransportFailure = (error: unknown): Error => {
    const failure = error instanceof Error ? error : new Error('Collaboration interaction could not be sent.')
    detach(true, internalError, 'Interaction send failed')
    scheduleReconnect(failure.message)
    return failure
  }

  const sendFlow = (message: Extract<CollaborationClientMessage, { type: `interaction.${string}` }>) => {
    try { send(message); return null } catch (error) { return flowTransportFailure(error) }
  }

  const createFlowWaiter = (action: FlowResultWaiter['action'], generation: number, reservationGeneration: number): Promise<InteractionResultMessage> => {
    return new Promise((resolve, reject) => {
      flowWaiters.add(Object.freeze({ action, localClaimGeneration: generation, reservationGeneration, resolve, reject }))
    })
  }

  const takeFlowWaiter = (result: InteractionResultMessage): FlowResultWaiter | null => {
    const waiter = [...flowWaiters].find(candidate => candidate.action === result.action
      && candidate.localClaimGeneration === result.localClaimGeneration
      && (candidate.action === 'acquire' || candidate.action === 'release' || candidate.reservationGeneration === result.reservationGeneration)) ?? null
    if (waiter) flowWaiters.delete(waiter)
    return waiter
  }

  const sendPendingRelease = (claim: MutableFlowClaim): Error | null => {
    const pendingRelease = claim.pendingRelease
    if (!pendingRelease || !claim.leaseId) return null
    return sendFlow({
      type: 'interaction.release',
      pageId: claim.claim.pageId,
      leaseId: claim.leaseId,
      interactionId: claim.claim.interactionId,
      localClaimGeneration: claim.claim.localClaimGeneration,
      reservationGeneration: claim.reservationGeneration,
      terminalSampleSequence: pendingRelease.terminalSampleSequence,
      reason: pendingRelease.reason,
    })
  }

  const claimForBinding = (bindingValue: FlowDragTerminalBinding): MutableFlowClaim | null => {
    const claim = flowClaims.get(bindingValue.localClaimGeneration) ?? null
    if (!claim || claim.leaseId !== bindingValue.leaseId || claim.claim.interactionId !== bindingValue.interactionId
      || claim.reservationGeneration !== bindingValue.reservationGeneration
      || claim.latestAcceptedPresentation?.identity.sampleSequence !== bindingValue.terminalSampleSequence
      || !sameFlowLane(claim.currentTargetLane, bindingValue.targetLane)) return null
    const source = claim.latestAcceptedPresentation.original.sourceRelationship
    return sameFlowLane({ parentId: source.parentId, slot: source.slot }, bindingValue.sourceLane) ? claim : null
  }

  const reconcileReplayScope = (
    replayScopeId: string,
    expectedSessionEpoch: number,
    expectedSocketEpoch: number,
    expectedScope: CollaborationStoreScope | null,
  ): boolean | Promise<boolean> => {
    const mismatched = pending.filter(mutation => mutation.replayScopeId !== replayScopeId)
    const checkpointMismatched = stagedCheckpoint !== null && stagedCheckpoint.checkpoint.replayScopeId !== replayScopeId
    const visibleCheckpointMismatched = visibleReplayScopeId !== null && visibleReplayScopeId !== replayScopeId
    const matchedCheckpoint = stagedCheckpoint?.checkpoint.replayScopeId === replayScopeId ? stagedCheckpoint : null
    const assignmentIsCurrent = () => sessionEpoch === expectedSessionEpoch
      && !stopped
      && !disposed
      && binding?.epoch === expectedSocketEpoch
      && currentReplayScopeId === replayScopeId
      && durableScope === expectedScope
    const retain = () => {
      if (!assignmentIsCurrent()) return false
      for (const mutation of mismatched) {
        const index = pending.indexOf(mutation)
        if (index >= 0) pending.splice(index, 1)
        recoverableMutationIds.add(mutation.id)
        if (!mutation.settled) mutation.reject(new Error('This change belongs to an earlier access grant and requires recovery.'))
        mutation.settled = true
      }
      if (visibleCheckpointMismatched) {
        visibleReplayScopeId = null
        publish({ document: null, snapshotId: null, serverSequence: '0', lastOperation: null })
      }
      if (matchedCheckpoint) {
        visibleReplayScopeId = replayScopeId
        publish({
          document: matchedCheckpoint.document,
          snapshotId: matchedCheckpoint.checkpoint.snapshotId,
          serverSequence: matchedCheckpoint.checkpoint.serverSequence,
          lastOperation: null,
        })
      }
      stagedCheckpoint = null
      publishPending()
      return true
    }
    const requiresDurableReconciliation = mismatched.length > 0 || checkpointMismatched || visibleCheckpointMismatched
    if (!requiresDurableReconciliation) return retain()
    if (!durableStore || !expectedScope) return retain()
    const store = durableStore
    return persist(() => store.reconcileReplayScope(expectedScope, replayScopeId)).then(retain)
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
      admittedSocketEpoch = current.epoch
      sessionWasAdmitted = true
      currentReplayScopeId = message.replayScopeId
      const finish = () => {
        if (sessionEpoch !== expectedSessionEpoch || stopped || disposed || binding?.epoch !== current.epoch || currentReplayScopeId !== message.replayScopeId) return
        publishState({ error: null })
        if (cached.reconnectAttempt > 0 || pending.length > 0 || cached.snapshotId) {
          send({
            type: 'room.resume',
            requestId: message.requestId,
            afterSequence: cached.serverSequence,
            pendingMutationIds: pending.map(item => item.id),
          })
        }
      }
      const reconciliation = reconcileReplayScope(message.replayScopeId, expectedSessionEpoch, current.epoch, durableScope)
      if (reconciliation instanceof Promise) {
        return reconciliation.then(applied => { if (applied) finish() }, error => {
          if (sessionEpoch !== expectedSessionEpoch || stopped || disposed || binding?.epoch !== current.epoch) return
          terminal('connection-failed', error instanceof Error ? error : new Error('Collaboration cache could not be reconciled.'))
        })
      }
      if (reconciliation) finish()
      return
    }
    assertCurrent(message)
    if (message.type === 'interaction.result') {
      const claim = flowClaims.get(message.localClaimGeneration)
      if (!claim || claim.claim.pageId !== message.pageId || claim.claim.interactionId !== message.interactionId) return
      if (message.action === 'acquire' || message.action === 'reserve') {
        if (message.sampleSequence !== claim.requestedPresentation.identity.sampleSequence) return
      } else if (!claim.pendingRelease || message.sampleSequence !== claim.pendingRelease.terminalSampleSequence) return
      if (message.action !== 'acquire') {
        if (claim.leaseId !== message.leaseId || claim.reservationGeneration !== message.reservationGeneration) return
      } else if (claim.leaseId !== null && message.leaseId !== claim.leaseId) return
      const waiter = takeFlowWaiter(message)
      if (!waiter) return
      const result = frozenJsonCopy(message)
      if (message.action === 'acquire') {
        if (message.status === 'denied' || message.leaseId === null) {
          flowClaims.delete(message.localClaimGeneration)
          const releaseWaiters = [...flowWaiters].filter(candidate => candidate.action === 'release' && candidate.localClaimGeneration === message.localClaimGeneration)
          for (const releaseWaiter of releaseWaiters) {
            flowWaiters.delete(releaseWaiter)
            releaseWaiter.reject(new Error(`Interaction acquisition was denied: ${message.denialCode ?? 'unknown'}.`))
          }
        } else {
          claim.leaseId = message.leaseId
          claim.reservationGeneration = message.reservationGeneration
          claim.currentTargetLane = claim.requestedPresentation.target
            ? frozenJsonCopy({ parentId: claim.requestedPresentation.target.parentId, slot: claim.requestedPresentation.target.slot })
            : null
          claim.latestAcceptedPresentation = claim.requestedPresentation
        }
      } else if (message.action === 'reserve') {
        if (message.status !== 'denied') {
          claim.currentTargetLane = claim.requestedTargetLane
          claim.latestAcceptedPresentation = claim.requestedPresentation
        }
      } else if (message.status === 'released' || message.status === 'retained') {
        flowClaims.delete(message.localClaimGeneration)
      } else {
        claim.pendingRelease = null
      }
      waiter.resolve(result)
      for (const listener of flowResultListeners) listener(result)
      if (message.action === 'acquire' && message.status !== 'denied') sendPendingRelease(claim)
      return
    }
    if (message.type === 'interaction.roster') {
      remoteFlows.clear()
      const interactions: InteractionRosterEntry[] = []
      for (const item of message.interactions) {
        if (item.clientId === clientId) continue
        const copied = frozenJsonCopy(item)
        remoteFlows.set(copied.leaseId, copied)
        interactions.push(copied)
        emitRemoteFlow(Object.freeze({ type: 'sample', source: 'roster', sample: copied }))
      }
      publish({ remoteInteractions: Object.freeze(interactions) })
      return
    }
    if (message.type === 'interaction.sample') {
      if (message.clientId === clientId) return
      const currentRemote = remoteFlows.get(message.leaseId)
      if (currentRemote) {
        if (message.pageId !== currentRemote.pageId || message.clientId !== currentRemote.clientId
          || message.subjectId !== currentRemote.subjectId || message.presenceId !== currentRemote.presenceId
          || message.presentation.identity.interactionId !== currentRemote.presentation.identity.interactionId
          || message.presentation.original.documentNodeId !== currentRemote.presentation.original.documentNodeId
          || message.localClaimGeneration < currentRemote.localClaimGeneration
          || message.localClaimGeneration === currentRemote.localClaimGeneration && message.reservationGeneration < currentRemote.reservationGeneration
          || message.localClaimGeneration === currentRemote.localClaimGeneration && message.reservationGeneration === currentRemote.reservationGeneration
            && message.presentation.identity.sampleSequence <= currentRemote.presentation.identity.sampleSequence) return
      }
      const copied = frozenJsonCopy(message)
      const entry: InteractionRosterEntry = Object.freeze({
        pageId: copied.pageId,
        presenceId: copied.presenceId,
        subjectId: copied.subjectId,
        clientId: copied.clientId,
        leaseId: copied.leaseId,
        localClaimGeneration: copied.localClaimGeneration,
        reservationGeneration: copied.reservationGeneration,
        presentation: copied.presentation,
      })
      remoteFlows.set(entry.leaseId, entry)
      publish({ remoteInteractions: Object.freeze([...remoteFlows.values()]) })
      emitRemoteFlow(Object.freeze({ type: 'sample', source: 'live', sample: copied }))
      return
    }
    if (message.type === 'interaction.released') {
      const currentRemote = remoteFlows.get(message.leaseId)
      if (!currentRemote || message.clientId !== currentRemote.clientId || message.subjectId !== currentRemote.subjectId
        || message.presenceId !== currentRemote.presenceId || message.pageId !== currentRemote.pageId
        || message.interactionId !== currentRemote.presentation.identity.interactionId
        || message.localClaimGeneration !== currentRemote.localClaimGeneration
        || message.reservationGeneration !== currentRemote.reservationGeneration
        || message.terminalSampleSequence < currentRemote.presentation.identity.sampleSequence) return
      remoteFlows.delete(message.leaseId)
      publish({ remoteInteractions: Object.freeze([...remoteFlows.values()]) })
      emitRemoteFlow(Object.freeze({ type: 'released', release: frozenJsonCopy(message) }))
      return
    }
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
      let document: TDocument
      try {
        const decoded: unknown = JSON.parse(publication.jsonText)
        document = options.validateDocument(decoded)
      } catch {
        terminal('connection-failed', new Error('This file contains invalid data. Error ID: invalid-file-document'))
        return
      }
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
        visibleReplayScopeId = currentReplayScopeId
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
        armHeartbeat(current.socket, current.epoch, expectedSessionEpoch)
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
        for (const claim of flowClaims.values()) claim.boundMutationIds.delete(mutation.id)
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
    if (!isOnline() || !isVisible()) {
      scheduleReconnect(!isOnline() ? 'Collaboration is offline.' : 'Collaboration paused while hidden.')
      return
    }
    let socket: CollaborationWebSocket
    try { socket = socketFactory(websocketUrl(origin, cached.fileId, clientId), collaborationWebSocketProtocol) }
    catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : 'Collaboration connection failed.', !sessionWasAdmitted)
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
      if (event.data === 'pong') {
        if (heartbeatTimeoutTimer !== null) cancel(heartbeatTimeoutTimer)
        heartbeatTimeoutTimer = null
        armHeartbeat(socket, epoch, activeSessionEpoch)
        return
      }
      if (event.data === 'ping') {
        try { socket.send('pong') } catch (error) { protocolFailure(error) }
        return
      }
      if (new TextEncoder().encode(event.data).byteLength > maxMessageBytes) { protocolFailure(new Error('Collaboration message exceeds the byte limit.'), messageTooLarge); return }
      let parsed: CollaborationServerMessage
      try {
        const decoded: unknown = JSON.parse(event.data)
        parsed = parseServerFrame(event.data, decoded)
      }
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
      const admitted = admittedSocketEpoch === epoch
      detach(false, normalClosure, event.reason || 'Collaboration disconnected.')
      if (!stopped && !disposed) {
        const message = event.reason || 'Collaboration disconnected.'
        scheduleReconnect(message, !sessionWasAdmitted && !admitted)
      }
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

  const disconnectForLifecycle = (message: string) => {
    cancelReconnect()
    clearHeartbeat()
    if (binding?.socket.readyState === openState && roomEnvelope) {
      try { send({ type: 'room.leave' }) } catch (error) { reportError(error, 'room.leave') }
    }
    detach(true)
    scheduleReconnect(message)
  }

  const resumeConnection = () => {
    if (stopped || disposed || binding || !isOnline() || !isVisible()) return
    cancelReconnect()
    const lifecycle = state.getSnapshot().lifecycle
    if (lifecycle === 'offline-clean' || lifecycle === 'offline-dirty' || lifecycle === 'draining' || lifecycle === 'parked') transitionIfAllowed('reconnecting')
    connect()
  }

  const online = () => { resumeConnection() }

  const offline = () => {
    if (stopped || disposed) return
    disconnectForLifecycle('Collaboration is offline.')
  }

  const visibilityChanged = () => {
    if (stopped || disposed) return
    if (!isVisible()) {
      disconnectForLifecycle('Collaboration paused while hidden.')
      return
    }
    if (binding) {
      armHeartbeat(binding.socket, binding.epoch, sessionEpoch, 0)
      return
    }
    resumeConnection()
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

  const stop = () => {
    const lifecycle = state.getSnapshot().lifecycle
    if (stopped && (lifecycle === 'cold' || lifecycle === 'closed')) return
    sessionEpoch += 1
    stopped = true
    cancelReconnect()
    clearHeartbeat()
    detachLifecycle()
    disposeAssembler()
    cancelPresence()
    if (binding?.socket.readyState === openState && roomEnvelope) {
      try { send({ type: 'room.leave' }) } catch (error) { reportError(error, 'room.leave') }
    }
    detach(true)
    roomEnvelope = null
    currentReplayScopeId = null
    visibleReplayScopeId = null
    stagedCheckpoint = null
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
      sessionWasAdmitted = false
      presenceSequence = 0
      localPresence = emptyPresence
      currentReplayScopeId = null
      visibleReplayScopeId = null
      stagedCheckpoint = null
      pending.splice(0)
      recoverableMutationIds = new Set()
      durableScope = nextScope
      durableStore = nextScope ? options.durableStore ?? createIndexedDbCollaborationStore() : null
      attachLifecycle()
      publish({ fileId, document: null, snapshotId: null, serverSequence: '0', lastOperation: null, participants: Object.freeze([]), remoteInteractions: Object.freeze([]), pendingMutationIds: Object.freeze([]), recoverableMutationIds: Object.freeze([]), reconnectAttempt: 0, error: null })
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
            replayScopeId: item.replayScopeId!,
            flowBinding: item.flowBinding,
            quarantinedFlowBinding: item.flowBinding !== null,
            baseSequence: item.baseSequence,
            sentSocketEpoch: null,
            resolve: () => undefined,
            reject: () => undefined,
            validateResult: options.validateDocument,
            settled: true,
          })
        }
        stagedCheckpoint = hydrated.room.checkpoint && hydrated.document
          ? Object.freeze({ checkpoint: hydrated.room.checkpoint, document: hydrated.document })
          : null
        publish({
          pendingMutationIds: Object.freeze(pending.map(item => item.id)),
          recoverableMutationIds: Object.freeze([...recoverableMutationIds]),
        })
        connect()
      }).catch(error => {
        const failure = error instanceof Error ? error : new Error('Collaboration cache could not be loaded.')
        if (sessionEpoch === activeSessionEpoch && durableScope === scope) {
          stopped = true
          detachLifecycle()
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
      if (options.immediate === true) throw new Error('Presence updates are frame limited.')
      const nextPresence = mergePresenceState(localPresence, patch)
      const data = mergePresencePatch(pendingPresence, patch)
      const candidate = {
        type: 'presence.update' as const,
        sequence: presenceSequence + 1,
        data,
      }
      parseCollaborationClientMessage(JSON.stringify(candidate), maxMessageBytes)
      localPresence = nextPresence
      updateLocalParticipant(localPresence)
      pendingPresence = data
      schedulePresence()
    },
    getFlowClaims(): readonly CollaborationFlowClaimSnapshot[] {
      return Object.freeze([...flowClaims.values()].map(flowClaimSnapshot))
    },
    subscribeInteractionResults(listener: (result: InteractionResultMessage) => void) {
      if (disposed) throw new Error('Collaboration client is disposed.')
      flowResultListeners.add(listener)
      return () => flowResultListeners.delete(listener)
    },
    subscribeRemoteFlow(listener: (event: CollaborationRemoteFlowEvent) => void) {
      if (disposed) throw new Error('Collaboration client is disposed.')
      remoteFlowListeners.add(listener)
      return () => remoteFlowListeners.delete(listener)
    },
    acquireInteraction(input: Readonly<{ presentation: FlowDragPresentation; leaseId?: FlowDragServerLeaseId }>): CollaborationFlowRequest {
      if (disposed) throw new Error('Collaboration client is disposed.')
      if (state.getSnapshot().mode !== 'editable' || state.getSnapshot().lifecycle !== 'live' || !roomEnvelope) throw new Error('This file is read only.')
      if (localClaimGeneration >= 2_147_483_647) throw new Error('Interaction claim generation is exhausted.')
      const presentation = frozenJsonCopy(input.presentation)
      const pageId = presentation.fence.pageId
      const interactionId = presentation.identity.interactionId
      const sourceNodeId = presentation.original.documentNodeId
      if (input.leaseId) {
        const compatible = [...flowClaims.values()].some(candidate => candidate.leaseId === input.leaseId
          && candidate.claim.pageId === pageId && candidate.claim.interactionId === interactionId && candidate.claim.sourceNodeId === sourceNodeId)
        if (!compatible) throw new Error('The interaction lease is not confirmed for this source.')
      }
      localClaimGeneration += 1
      const claimValue: CollaborationFlowClaim = Object.freeze({ pageId, interactionId, sourceNodeId, localClaimGeneration })
      const claim: MutableFlowClaim = {
        claim: claimValue,
        leaseId: input.leaseId ?? null,
        reservationGeneration: 1,
        currentTargetLane: null,
        latestAcceptedPresentation: null,
        sampleSequence: presentation.identity.sampleSequence,
        requestedPresentation: presentation,
        requestedTargetLane: null,
        pendingRelease: null,
        boundMutationIds: new Set(),
      }
      flowClaims.set(localClaimGeneration, claim)
      const result = createFlowWaiter('acquire', localClaimGeneration, 1)
      sendFlow({ type: 'interaction.acquire', pageId, localClaimGeneration, ...(input.leaseId ? { leaseId: input.leaseId } : {}), presentation })
      return Object.freeze({ claim: claimValue, result })
    },
    reserveInteraction(input: Readonly<{ claim: CollaborationFlowClaim; targetLane: FlowDragLane; presentation: FlowDragPresentation }>): Promise<InteractionResultMessage> {
      const claim = flowClaims.get(input.claim.localClaimGeneration)
      if (!claim || claim.claim !== input.claim || !claim.leaseId) return Promise.reject(new Error('Interaction lease is not confirmed.'))
      if (claim.pendingRelease) return Promise.reject(new Error('Interaction release is pending.'))
      if ([...flowWaiters].some(waiter => waiter.action === 'reserve' && waiter.localClaimGeneration === claim.claim.localClaimGeneration)) {
        return Promise.reject(new Error('Interaction reservation is already pending.'))
      }
      if (claim.reservationGeneration >= 2_147_483_647) return Promise.reject(new Error('Interaction reservation generation is exhausted.'))
      const presentation = frozenJsonCopy(input.presentation)
      const presentationTarget = presentation.target ? { parentId: presentation.target.parentId, slot: presentation.target.slot } : null
      if (presentation.fence.pageId !== claim.claim.pageId || presentation.identity.interactionId !== claim.claim.interactionId
        || presentation.original.documentNodeId !== claim.claim.sourceNodeId || presentation.identity.sampleSequence <= claim.sampleSequence
        || !sameFlowLane(input.targetLane, presentationTarget)) {
        return Promise.reject(new Error('Interaction reservation does not match the active claim.'))
      }
      claim.reservationGeneration += 1
      claim.requestedTargetLane = frozenJsonCopy(input.targetLane)
      claim.requestedPresentation = presentation
      claim.sampleSequence = presentation.identity.sampleSequence
      const result = createFlowWaiter('reserve', claim.claim.localClaimGeneration, claim.reservationGeneration)
      sendFlow({ type: 'interaction.reserve', pageId: claim.claim.pageId, leaseId: claim.leaseId, localClaimGeneration: claim.claim.localClaimGeneration,
        reservationGeneration: claim.reservationGeneration, targetLane: claim.requestedTargetLane, presentation })
      return result
    },
    sampleInteraction(input: Readonly<{ claim: CollaborationFlowClaim; presentation: FlowDragPresentation }>): void {
      const claim = flowClaims.get(input.claim.localClaimGeneration)
      if (!claim || claim.claim !== input.claim || !claim.leaseId) throw new Error('Interaction lease is not confirmed.')
      if (claim.pendingRelease) throw new Error('Interaction release is pending.')
      const presentation = frozenJsonCopy(input.presentation)
      const presentationTarget = presentation.target ? { parentId: presentation.target.parentId, slot: presentation.target.slot } : null
      if (presentation.fence.pageId !== claim.claim.pageId || presentation.identity.interactionId !== claim.claim.interactionId
        || presentation.original.documentNodeId !== claim.claim.sourceNodeId || presentation.identity.sampleSequence <= claim.sampleSequence
        || !sameFlowLane(claim.currentTargetLane, presentationTarget)) {
        throw new Error('Interaction sample does not match the active claim.')
      }
      const failure = sendFlow({ type: 'interaction.sample', pageId: claim.claim.pageId, leaseId: claim.leaseId, localClaimGeneration: claim.claim.localClaimGeneration,
        reservationGeneration: claim.reservationGeneration, presentation })
      if (failure) throw failure
      claim.requestedPresentation = presentation
      claim.latestAcceptedPresentation = presentation
      claim.sampleSequence = presentation.identity.sampleSequence
    },
    releaseInteraction(input: Readonly<{ claim: CollaborationFlowClaim; terminalSampleSequence: number; reason: 'committed' | 'cancelled' | 'failed' | 'disconnecting' }>): Promise<InteractionResultMessage> {
      const claim = flowClaims.get(input.claim.localClaimGeneration)
      if (!claim || claim.claim !== input.claim) return Promise.reject(new Error('Interaction claim is unavailable.'))
      if (claim.pendingRelease) return Promise.reject(new Error('Interaction release is already pending.'))
      if (!Number.isSafeInteger(input.terminalSampleSequence) || input.terminalSampleSequence < 0
        || claim.latestAcceptedPresentation && input.terminalSampleSequence < claim.latestAcceptedPresentation.identity.sampleSequence) {
        return Promise.reject(new Error('Interaction terminal sequence is stale.'))
      }
      claim.pendingRelease = Object.freeze({ terminalSampleSequence: input.terminalSampleSequence, reason: input.reason })
      const result = createFlowWaiter('release', claim.claim.localClaimGeneration, claim.reservationGeneration)
      sendPendingRelease(claim)
      return result
    },
    rebindInteractionMutation(mutationId: string, flowBinding: FlowDragTerminalBinding): void {
      const mutation = pending.find(candidate => candidate.id === mutationId)
      const claim = claimForBinding(flowBinding)
      if (!mutation || !mutation.quarantinedFlowBinding || !claim) throw new Error('The interaction-bound mutation cannot be rebound.')
      mutation.flowBinding = frozenJsonCopy(flowBinding)
      mutation.quarantinedFlowBinding = false
      claim.boundMutationIds.add(mutation.id)
      sendNextMutation()
    },
    submit(input: CollaborationMutationInput): Promise<CollaborationMutationReceipt> {
      if (disposed) return Promise.reject(new Error('Collaboration client is disposed.'))
      if (state.getSnapshot().mode !== 'editable' || state.getSnapshot().lifecycle !== 'live') return Promise.reject(new Error('This file is read only.'))
      const validCommand = decodeSemanticCommandFromPersistence(encodeSemanticCommandForPersistence(validateSemanticFileCommand(input.command)))
      const id = validateIdentifier(input.mutationId, 'mutation id')
      if (id.length < 8) return Promise.reject(new Error('Invalid mutation id.'))
      if (usedMutationIds.has(id)) return Promise.reject(new Error('Mutation id was already used.'))
      if (pending.length >= maxPendingMutations) return Promise.reject(new Error('Too many pending collaboration changes.'))
      const flowBinding = input.flowBinding ? frozenJsonCopy(input.flowBinding) : null
      const flowClaim = flowBinding ? claimForBinding(flowBinding) : null
      if (flowBinding && !flowClaim) return Promise.reject(new Error('The interaction binding is not authoritative.'))
      const candidate: CollaborationClientMessage = { type: 'operation.submit', operation: {
        mutationId: id,
        baseSequence: maximumDurableSequence,
        command: validCommand,
        ...(flowBinding ? { flowBinding } : {}),
      } }
      const encoded = encodeCollaborationMessage(candidate)
      if (new TextEncoder().encode(encoded).byteLength > maxMessageBytes) return Promise.reject(new CollaborationMessageTooLargeError())
      parseCollaborationClientMessage(encoded, maxMessageBytes)
      if (!durableStore || !durableScope) return Promise.reject(new Error('Collaboration storage is required before editing.'))
      if (!currentReplayScopeId) return Promise.reject(new Error('Collaboration replay scope is unavailable.'))
      usedMutationIds.add(id)
      const activeSessionEpoch = sessionEpoch
      const submittedFlowTransportGeneration = flowTransportGeneration
      const replayScopeId = currentReplayScopeId
      let committedStatus: 'pending' | 'recoverable' = 'pending'
      const resolveCommittedStatus = () => {
        committedStatus = explicitRecoverySessionEpochs.has(activeSessionEpoch) ? 'recoverable' : 'pending'
        return committedStatus
      }
      const register = () => {
        if (stopped || disposed || sessionEpoch !== activeSessionEpoch) {
          const failure = new Error('Collaboration client stopped after the change was saved for recovery.')
          if (committedStatus === 'recoverable' && durableScope === scope) {
            recoverableMutationIds.add(id)
            publishPending()
          }
          return Promise.reject(failure)
        }
        return new Promise<CollaborationMutationReceipt>((resolve, reject) => {
          const mutation: PendingMutation<TDocument> = {
            id,
            command: validCommand,
            replayScopeId,
            flowBinding,
            quarantinedFlowBinding: flowBinding !== null && submittedFlowTransportGeneration !== flowTransportGeneration,
            baseSequence: null,
            sentSocketEpoch: null,
            resolve,
            reject,
            validateResult: options.validateDocument,
            settled: false,
          }
          pending.push(mutation)
          if (!mutation.quarantinedFlowBinding) flowClaim?.boundMutationIds.add(id)
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
        replayScopeId,
        flowBinding,
      }), resolveCommittedStatus)).then(register, error => {
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
      flowResultListeners.clear()
      remoteFlowListeners.clear()
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
