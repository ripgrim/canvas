import type { FileCommand } from '@canvas/repo-engine/file-document'
import type {
  FlowDragDenialCode,
  FlowDragLane,
  FlowDragLocalClaimGeneration,
  FlowDragPresentation,
  FlowDragReservationGeneration,
  FlowDragServerLeaseId,
  FlowDragTerminalBinding,
} from './flow.js'

export const collaborationProtocolEpoch = 4 as const
export const collaborationWebSocketProtocol = `canvas-sync-v${collaborationProtocolEpoch}` as const
export const collaborationEnvelopeSchemaVersion = 1 as const
export const collaborationDocumentSchemaVersion = 13 as const
export const maxCollaborationIdentifierLength = 128
export const maxPresenceParticipants = 512
export const maxCollaborationDisplayNameLength = 80
export const maxCollaborationAvatarUrlBytes = 480
export const maxCollaborationConnectionNonceLength = 128
export const maxRoomTicketLength = 2_240
export const maxRoomTicketPayloadBytes = 1_640

export type CollaborationProtocolEpoch = typeof collaborationProtocolEpoch
export type CollaborationEnvelopeSchemaVersion = typeof collaborationEnvelopeSchemaVersion

/** A canonical PostgreSQL signed int64 decimal carried as text. */
export type FenceToken = string
export type DurableSequence = string

export type RoomIdentity = Readonly<{
  fileId: string
  generationId: string
}>

/** Fence tokens are emitted by the authority and never accepted from clients. */
export type ServerRoomEnvelope = Readonly<{
  protocolEpoch: CollaborationProtocolEpoch
  schemaVersion: CollaborationEnvelopeSchemaVersion
  room: RoomIdentity
  fenceToken: FenceToken
}>

/**
 * Server-side claims produced only after signature, expiry, and access checks.
 * These claims are bound to the accepted socket and never appear in client frames.
 */
export type VerifiedRoomTicketClaims = Readonly<{
  subjectId: string
  displayName: string
  avatarUrl: string | null
  fileId: string
  role: VerifiedRoomRole
  generationId: string
  protocolEpoch: CollaborationProtocolEpoch
  buildId: string
  expiresAtUnixMs: number
  accessEpoch: DurableSequence
  clientId: string
  connectionNonce: string
}>

export type VerifiedRoomRole = 'owner' | 'viewer'
export type CollaborationMode = 'editable' | 'read_only'

export type ClientLifecycleState =
  | 'cold'
  | 'opening'
  | 'authorizing'
  | 'hydrating-local'
  | 'admission-queued'
  | 'streaming'
  | 'applying'
  | 'live'
  | 'read-only'
  | 'offline-clean'
  | 'offline-dirty'
  | 'reconnecting'
  | 'replaying'
  | 'parked'
  | 'access-revoked'
  | 'incompatible-build'
  | 'capacity-refused'
  | 'connection-failed'
  | 'draining'
  | 'closing'
  | 'closed'

export type ClientLifecycleTransition = Readonly<{
  from: ClientLifecycleState
  to: ClientLifecycleState
}>

/** The repo-engine command language is the collaboration command language. */
export type SemanticFileCommand = FileCommand

export type SemanticOperationEnvelope = Readonly<{
  mutationId: string
  baseSequence: DurableSequence
  command: SemanticFileCommand
  flowBinding?: FlowDragTerminalBinding
}>

export type CollaborationJsonValue = string | number | boolean | null | readonly CollaborationJsonValue[] | CollaborationJsonObject
export interface CollaborationJsonObject {
  readonly [key: string]: CollaborationJsonValue
}

export type PersistedSemanticCommand = Readonly<{
  operationType: SemanticFileCommand['type']
  operationPayload: CollaborationJsonObject
}>

export type RoomOpenMessage = Readonly<{
  type: 'room.open'
  protocolEpoch: CollaborationProtocolEpoch
  schemaVersion: CollaborationEnvelopeSchemaVersion
  requestId: string
  fileId: string
  clientId: string
  buildId: string
  cachedSnapshotId?: string
  afterSequence?: DurableSequence
}>

export type RoomResumeMessage = Readonly<{
  type: 'room.resume'
  requestId: string
  afterSequence: DurableSequence
  pendingMutationIds: readonly string[]
}>

export type OperationSubmitMessage = Readonly<{
  type: 'operation.submit'
  operation: SemanticOperationEnvelope
}>

export type PresencePoint = Readonly<{
  pageId: string
  x: number
  y: number
}>

export type PresenceCamera = Readonly<{
  pageId: string
  x: number
  y: number
  zoom: number
}>

export type PresenceSelection = Readonly<{
  pageId: string
  nodeIds: readonly string[]
}>

/** A sparse awareness update. The room merges it into the participant state. */
export type PresencePatch = Readonly<{
  pageId?: string | null
  focused?: boolean
  selection?: PresenceSelection | null
  camera?: PresenceCamera | null
  cursor?: PresencePoint | null
}>

/** The room-owned awareness snapshot. Missing values are represented explicitly. */
export type PresenceState = Readonly<{
  pageId: string | null
  focused: boolean
  selection: PresenceSelection | null
  camera: PresenceCamera | null
  cursor: PresencePoint | null
}>

export type PresenceUpdateMessage = Readonly<{
  type: 'presence.update'
  sequence: number
  data: PresencePatch
}>

export type RoomLeaveMessage = Readonly<{
  type: 'room.leave'
}>

export type InteractionAcquireMessage = Readonly<{
  type: 'interaction.acquire'
  pageId: string
  localClaimGeneration: FlowDragLocalClaimGeneration
  leaseId?: FlowDragServerLeaseId
  presentation: FlowDragPresentation
}>

export type InteractionReserveMessage = Readonly<{
  type: 'interaction.reserve'
  pageId: string
  leaseId: FlowDragServerLeaseId
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  targetLane: FlowDragLane
  presentation: FlowDragPresentation
}>

export type InteractionSampleMessage = Readonly<{
  type: 'interaction.sample'
  pageId: string
  leaseId: FlowDragServerLeaseId
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  presentation: FlowDragPresentation
}>

export type InteractionReleaseReason = 'committed' | 'cancelled' | 'failed' | 'disconnecting'
export type InteractionReleaseMessage = Readonly<{
  type: 'interaction.release'
  pageId: string
  leaseId: FlowDragServerLeaseId
  interactionId: string
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  terminalSampleSequence: number
  reason: InteractionReleaseReason
}>

export type CollaborationClientMessage = RoomOpenMessage | RoomResumeMessage | OperationSubmitMessage | PresenceUpdateMessage
  | InteractionAcquireMessage | InteractionReserveMessage | InteractionSampleMessage | InteractionReleaseMessage | RoomLeaveMessage

export type RoomAssignedMessage = Readonly<{
  type: 'room.assigned'
  envelope: ServerRoomEnvelope
  requestId: string
  role: VerifiedRoomRole
  /** Non-secret equality tag. Durable edits only replay under the same server-verified access grant. */
  replayScopeId: string
}>

export type AdmissionQueuedMessage = Readonly<{
  type: 'admission.queued'
  protocolEpoch: CollaborationProtocolEpoch
  schemaVersion: CollaborationEnvelopeSchemaVersion
  requestId: string
}>

export type LoadPhase = 'stream' | 'apply'
export type LoadPhaseTransition = Readonly<{ from: LoadPhase; to: LoadPhase }>

export type LoadPhaseMessage = Readonly<{
  type: 'load.phase'
  envelope: ServerRoomEnvelope
  requestId: string
  phase: LoadPhase
}>

export type SnapshotBeginMessage = Readonly<{
  type: 'snapshot.begin'
  envelope: ServerRoomEnvelope
  requestId: string
  snapshotId: string
  documentSchemaVersion: typeof collaborationDocumentSchemaVersion
  baseSequence: DurableSequence
  compression: 'none'
  contentEncoding: 'utf-8'
  storedByteLength: number
  documentByteLength: number
  objectDigest: string
  documentDigest: string
  chunkCount: number
}>

export type SnapshotChunkMessage = Readonly<{
  type: 'snapshot.chunk'
  envelope: ServerRoomEnvelope
  requestId: string
  snapshotId: string
  chunkIndex: number
  chunkCount: number
  data: string
}>

export type SnapshotEndMessage = Readonly<{
  type: 'snapshot.end'
  envelope: ServerRoomEnvelope
  requestId: string
  snapshotId: string
}>

export type SyncReadyMessage = Readonly<{
  type: 'sync.ready'
  envelope: ServerRoomEnvelope
  requestId: string
  snapshotId: string
  serverSequence: DurableSequence
  role: VerifiedRoomRole
}>

/** Duplicate ACKs are success: the mutation was already durably recorded. */
export type OperationAckMessage = Readonly<{
  type: 'operation.ack'
  envelope: ServerRoomEnvelope
  mutationId: string
  sequence: DurableSequence
  status: 'applied' | 'duplicate'
}>

export type OperationAppliedMessage = Readonly<{
  type: 'operation.applied'
  envelope: ServerRoomEnvelope
  mutationId: string
  sequence: DurableSequence
  subjectId: string
  command: SemanticFileCommand
}>

export type PresenceParticipant = Readonly<{
  presenceId: string
  subjectId: string
  displayName: string
  avatarUrl: string | null
  clientId: string
  role: VerifiedRoomRole
  sequence: number | null
  data: PresenceState
}>

export type PresenceRosterMessage = Readonly<{
  type: 'presence.roster'
  envelope: ServerRoomEnvelope
  participants: readonly PresenceParticipant[]
}>

export type PresenceJoinMessage = Readonly<{
  type: 'presence.join'
  envelope: ServerRoomEnvelope
  participant: PresenceParticipant
}>

export type PresenceChangedMessage = Readonly<{
  type: 'presence.changed'
  envelope: ServerRoomEnvelope
  participant: PresenceParticipant
}>

export type PresenceLeaveMessage = Readonly<{
  type: 'presence.leave'
  envelope: ServerRoomEnvelope
  presenceId: string
  subjectId: string
  clientId: string
}>

export type InteractionResultAction = 'acquire' | 'reserve' | 'release'
export type InteractionResultStatus = 'granted' | 'retained' | 'released' | 'denied'
export type InteractionResultMessage = Readonly<{
  type: 'interaction.result'
  envelope: ServerRoomEnvelope
  pageId: string
  action: InteractionResultAction
  status: InteractionResultStatus
  interactionId: string
  leaseId: FlowDragServerLeaseId | null
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  sampleSequence: number
  denialCode: FlowDragDenialCode | null
}>

export type InteractionSampleAcceptedMessage = Readonly<{
  type: 'interaction.sample'
  envelope: ServerRoomEnvelope
  pageId: string
  presenceId: string
  subjectId: string
  clientId: string
  leaseId: FlowDragServerLeaseId
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  presentation: FlowDragPresentation
}>

export type InteractionReleasedMessage = Readonly<{
  type: 'interaction.released'
  envelope: ServerRoomEnvelope
  pageId: string
  presenceId: string
  subjectId: string
  clientId: string
  interactionId: string
  leaseId: FlowDragServerLeaseId
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  terminalSampleSequence: number
  reason: InteractionReleaseReason
}>

export type InteractionRosterEntry = Readonly<{
  pageId: string
  presenceId: string
  subjectId: string
  clientId: string
  leaseId: FlowDragServerLeaseId
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  presentation: FlowDragPresentation
}>

export type InteractionRosterMessage = Readonly<{
  type: 'interaction.roster'
  envelope: ServerRoomEnvelope
  interactions: readonly InteractionRosterEntry[]
}>

export type RebaseRequiredMessage = Readonly<{
  type: 'operation.rebase_required'
  envelope: ServerRoomEnvelope
  mutationId: string
  baseSequence: DurableSequence
  authoritativeSequence: DurableSequence
  retry: 'resync'
}>

export type PreAssignmentErrorCode = 'invalid_message' | 'unsupported_epoch' | 'unsupported_schema' | 'unauthorized' | 'forbidden' | 'file_not_found' | 'incompatible_build' | 'capacity_refused' | 'internal_error'

export type PreAssignmentErrorMessage = Readonly<{
  type: 'request.error'
  protocolEpoch: CollaborationProtocolEpoch
  schemaVersion: CollaborationEnvelopeSchemaVersion
  requestId: string
  code: PreAssignmentErrorCode
  message: string
  retry: 'none' | 'refresh' | 'retry'
  retryAfterMs?: number
}>

export type RoomErrorCode = 'room_scope_mismatch' | 'mutation_id_reused' | 'invalid_operation' | 'read_only' | 'access_revoked' | 'incompatible_build' | 'capacity_refused' | 'draining' | 'internal_error'

export type RoomErrorMessage = Readonly<{
  type: 'room.error'
  envelope: ServerRoomEnvelope
  code: RoomErrorCode
  message: string
  retry: 'none' | 'refresh' | 'reconnect'
  mutationId?: string
  retryAfterMs?: number
}>

export type CollaborationServerMessage = AdmissionQueuedMessage | RoomAssignedMessage | LoadPhaseMessage | SnapshotBeginMessage | SnapshotChunkMessage | SnapshotEndMessage | SyncReadyMessage | OperationAckMessage | OperationAppliedMessage | PresenceRosterMessage | PresenceJoinMessage | PresenceChangedMessage | PresenceLeaveMessage | InteractionResultMessage | InteractionSampleAcceptedMessage | InteractionReleasedMessage | InteractionRosterMessage | RebaseRequiredMessage | PreAssignmentErrorMessage | RoomErrorMessage
