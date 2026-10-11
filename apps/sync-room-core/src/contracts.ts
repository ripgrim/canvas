import type { CollaborationPayload, CollaborationPersistence, CollaborationProjection } from '@canvas/database/collaboration'
import type { SemanticFileCommand, VerifiedRoomTicketClaims } from '@canvas/sync-protocol'

export type RoomIdentity = Readonly<{
  fileId: string
  generationId: string
  protocolEpoch: 2
}>

export type RoomTicketContext = Readonly<{
  token: string
  fileId: string
  generationId: string
  clientId: string
  connectionNonce: string
  nowUnixMs: number
}>

export type RoomAuthorization = Readonly<{
  claims: VerifiedRoomTicketClaims
}>

export interface RoomTicketVerifier {
  verify(context: RoomTicketContext): Promise<RoomAuthorization | null>
  consume(authorization: RoomAuthorization, input: Readonly<{ nowUnixMs: number; buildId: string }>): Promise<VerifiedRoomTicketClaims | null>
  isCurrent(claims: VerifiedRoomTicketClaims, nowUnixMs: number): Promise<boolean>
}

export interface CollaborationProjector {
  apply(document: CollaborationPayload, command: SemanticFileCommand): CollaborationPayload
}

export type CheckpointArtifact = Readonly<{
  objectKey: string
  objectDigest: string
  documentDigest: string
  compressedBytes: bigint
}>

export interface CheckpointStore {
  write(projection: CollaborationProjection): Promise<CheckpointArtifact>
}

export interface RoomLogger {
  event(event: Readonly<Record<string, string | number | boolean | null>>): void
}

export type RoomCoreDependencies = Readonly<{
  persistence: CollaborationPersistence
  tickets: RoomTicketVerifier
  projector: CollaborationProjector
  checkpoints: CheckpointStore
  logger?: RoomLogger
}>

export type RoomCoreOptions = Readonly<{
  identity: RoomIdentity
  leaseDurationMs: number
  leaseRenewalMs: number
  drainTimeoutMs: number
  maxMessageBytes?: number
}>
