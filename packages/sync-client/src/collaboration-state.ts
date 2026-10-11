import { collaborationModeForRole, isValidClientLifecycleTransition, maxPostgresSignedInt64 } from '@canvas/sync-protocol'
import type { ClientLifecycleState, CollaborationMode, ServerRoomEnvelope, VerifiedRoomRole } from '@canvas/sync-protocol'

export type CollaborationAttempt = Readonly<{
  fileId: string
  requestId: string
  socketEpoch: number
}>

export type CollaborationAttemptContext = Readonly<{
  requestId: string
  socketEpoch: number
}>

export type CollaborationMessageContext = CollaborationAttemptContext & Readonly<{
  envelope: ServerRoomEnvelope
}>

export type CollaborationRoomAssignmentContext = CollaborationMessageContext & Readonly<{
  role: VerifiedRoomRole
}>

export type CollaborationReadyContext = CollaborationRoomAssignmentContext

export type CollaborationStateSnapshot = Readonly<{
  lifecycle: ClientLifecycleState
  attempt: CollaborationAttempt | null
  envelope: ServerRoomEnvelope | null
  role: VerifiedRoomRole | null
  mode: CollaborationMode | null
  disposed: boolean
}>

export type StaleCollaborationMessageReason =
  | 'disposed'
  | 'lifecycle'
  | 'no_active_attempt'
  | 'request'
  | 'socket_epoch'
  | 'file'
  | 'generation'
  | 'fence'

export class StaleCollaborationMessageError extends Error {
  readonly reason: StaleCollaborationMessageReason

  constructor(reason: StaleCollaborationMessageReason) {
    super(`Rejected stale collaboration message: ${reason}.`)
    this.name = 'StaleCollaborationMessageError'
    this.reason = reason
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const messageAcceptingStates = new Set<ClientLifecycleState>([
  'admission-queued',
  'streaming',
  'applying',
  'live',
  'read-only',
  'replaying',
])

function identifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function fileId(value: string): string {
  if (!uuidPattern.test(value)) throw new Error('Invalid file id.')
  return value
}

function socketEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid socket epoch.')
  return value
}

function copyAttempt(value: CollaborationAttempt): CollaborationAttempt {
  return Object.freeze({
    fileId: fileId(value.fileId),
    requestId: identifier(value.requestId, 'request id'),
    socketEpoch: socketEpoch(value.socketEpoch),
  })
}

function copyEnvelope(value: ServerRoomEnvelope): ServerRoomEnvelope {
  if (!uuidPattern.test(value.room.fileId) || !uuidPattern.test(value.room.generationId)) throw new Error('Invalid room identity.')
  if (!/^[1-9][0-9]{0,18}$/.test(value.fenceToken) || BigInt(value.fenceToken) > maxPostgresSignedInt64) throw new Error('Invalid room fence token.')
  return Object.freeze({
    protocolEpoch: value.protocolEpoch,
    schemaVersion: value.schemaVersion,
    room: Object.freeze({ fileId: value.room.fileId, generationId: value.room.generationId }),
    fenceToken: value.fenceToken,
  })
}

export function createCollaborationStateMachine() {
  let snapshot: CollaborationStateSnapshot = Object.freeze({
    lifecycle: 'cold',
    attempt: null,
    envelope: null,
    role: null,
    mode: null,
    disposed: false,
  })

  const publish = (patch: Partial<CollaborationStateSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...patch })
    return snapshot
  }

  const requireActive = () => {
    if (snapshot.disposed) throw new Error('This collaboration state machine was disposed.')
  }

  const assertTransition = (to: ClientLifecycleState) => {
    if (!isValidClientLifecycleTransition(snapshot.lifecycle, to)) {
      throw new Error(`Invalid collaboration state transition from ${snapshot.lifecycle} to ${to}.`)
    }
  }

  const rejectReason = (context: CollaborationMessageContext): StaleCollaborationMessageReason | null => {
    if (snapshot.disposed) return 'disposed'
    if (!messageAcceptingStates.has(snapshot.lifecycle)) return 'lifecycle'
    const current = snapshot.attempt
    if (!current || !snapshot.envelope) return 'no_active_attempt'
    if (context.requestId !== current.requestId) return 'request'
    if (context.socketEpoch !== current.socketEpoch) return 'socket_epoch'
    if (context.envelope.room.fileId !== current.fileId || context.envelope.room.fileId !== snapshot.envelope.room.fileId) return 'file'
    if (context.envelope.room.generationId !== snapshot.envelope.room.generationId) return 'generation'
    if (context.envelope.fenceToken !== snapshot.envelope.fenceToken) return 'fence'
    return null
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    open(attempt: CollaborationAttempt) {
      requireActive()
      assertTransition('opening')
      return publish({ lifecycle: 'opening', attempt: copyAttempt(attempt), envelope: null, role: null, mode: null })
    },
    transition(to: ClientLifecycleState) {
      requireActive()
      if (to === 'admission-queued') throw new Error('Admission queue state requires validated request and socket context.')
      if (to === 'live' || to === 'read-only') throw new Error('Ready state requires an authoritative role confirmation.')
      assertTransition(to)
      if ((to === 'streaming' || to === 'applying' || to === 'replaying') && !snapshot.envelope) {
        throw new Error(`Collaboration state ${to} requires an assigned room.`)
      }
      return publish({ lifecycle: to })
    },
    acceptAdmissionQueued(context: CollaborationAttemptContext) {
      requireActive()
      const current = snapshot.attempt
      if (!current) throw new StaleCollaborationMessageError('no_active_attempt')
      if (context.requestId !== current.requestId) throw new StaleCollaborationMessageError('request')
      if (context.socketEpoch !== current.socketEpoch) throw new StaleCollaborationMessageError('socket_epoch')
      if (snapshot.envelope) throw new Error('Admission queue progress must arrive before room assignment.')
      assertTransition('admission-queued')
      return publish({ lifecycle: 'admission-queued' })
    },
    startReconnectAttempt(attempt: CollaborationAttempt) {
      requireActive()
      if (snapshot.lifecycle !== 'reconnecting') throw new Error('A reconnect attempt requires the reconnecting state.')
      const next = copyAttempt(attempt)
      const previous = snapshot.attempt
      if (previous && next.fileId !== previous.fileId) throw new Error('A reconnect attempt cannot change files.')
      if (previous && next.socketEpoch <= previous.socketEpoch) throw new Error('A reconnect attempt requires a newer socket epoch.')
      assertTransition('authorizing')
      return publish({ lifecycle: 'authorizing', attempt: next, envelope: null, role: null, mode: null })
    },
    assignRoom(context: CollaborationRoomAssignmentContext) {
      requireActive()
      const current = snapshot.attempt
      if (!current) throw new StaleCollaborationMessageError('no_active_attempt')
      if (context.requestId !== current.requestId) throw new StaleCollaborationMessageError('request')
      if (context.socketEpoch !== current.socketEpoch) throw new StaleCollaborationMessageError('socket_epoch')
      if (context.envelope.room.fileId !== current.fileId) throw new StaleCollaborationMessageError('file')
      if (snapshot.lifecycle !== 'admission-queued') {
        throw new Error('A room can only be assigned after admission is queued.')
      }
      if (snapshot.envelope) throw new Error('A room is already assigned for this connection attempt.')
      const envelope = copyEnvelope(context.envelope)
      const mode = collaborationModeForRole(context.role)
      publish({ envelope, role: context.role, mode })
      return envelope
    },
    acceptSyncReady(context: CollaborationReadyContext) {
      requireActive()
      const reason = rejectReason(context)
      if (reason) throw new StaleCollaborationMessageError(reason)
      if (snapshot.lifecycle !== 'applying' && snapshot.lifecycle !== 'replaying') throw new Error('Sync readiness requires applying or replaying state.')
      if (context.role !== snapshot.role) throw new Error('Sync ready role does not match the assigned room role.')
      const lifecycle: ClientLifecycleState = collaborationModeForRole(context.role) === 'editable' ? 'live' : 'read-only'
      assertTransition(lifecycle)
      return publish({ lifecycle })
    },
    assertCurrentMessage(context: CollaborationMessageContext) {
      const reason = rejectReason(context)
      if (reason) throw new StaleCollaborationMessageError(reason)
      return true
    },
    dispose() {
      if (snapshot.disposed) return snapshot
      return publish({ attempt: null, envelope: null, role: null, mode: null, disposed: true })
    },
  })
}
