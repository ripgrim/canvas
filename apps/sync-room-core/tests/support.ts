import { collaborationDocumentDigest } from '@canvas/database/collaboration'
import type {
  AppendCollaborationOperationResult,
  CollaborationLease,
  CollaborationPayload,
  CollaborationPersistence,
  CollaborationProjection,
} from '@canvas/database/collaboration'
import type { VerifiedRoomTicketClaims } from '@canvas/sync-protocol'
import type { CheckpointStore, CollaborationProjector, RoomTicketVerifier } from '../src/contracts.js'
import type { RoomPeer } from '../src/room-core.js'

export const fileId = 'c4964764-a27f-4345-8b6a-eada5b77f339'
export const generationId = 'cc4d2b27-6105-472e-bcb8-31398b063b1c'
export const subjectId = 'subject-1'
export const displayName = 'Alpha'
export const avatarUrl = 'https://images.example/alpha.png'
export const clientId = 'client-1'
export const connectionNonce = 'A'.repeat(24)
export const ticket = 'B'.repeat(32)

export function document(extra: Readonly<Record<string, unknown>> = {}): CollaborationPayload {
  return {
    schemaVersion: 7,
    fileId,
    revision: 0,
    pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
    nodes: { 'root-1': { id: 'root-1', type: 'root' }, 'node-1': { id: 'node-1', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 100, height: 100 } } },
    relationships: { 'node-1': { parentId: 'root-1', orderKey: 'V' } },
    theme: { tokens: {} },
    ...extra,
  } as CollaborationPayload
}

export function projection(value = document(), sequence = 0n): CollaborationProjection {
  return Object.freeze({
    fileId,
    sequence,
    documentSchemaVersion: 7,
    document: value,
    documentDigest: collaborationDocumentDigest(value),
    generationId,
    fencingToken: 1n,
    authority: sequence === 0n ? 'legacy-seed' : 'room',
    updatedAt: new Date(0).toISOString(),
  })
}

export const lease: CollaborationLease = Object.freeze({
  fileId, generationId, protocolEpoch: 2, fencingToken: 1n,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), renewedAt: new Date().toISOString(),
})

export function claims(role: 'owner' | 'viewer' = 'owner'): VerifiedRoomTicketClaims {
  return Object.freeze({ subjectId, displayName, avatarUrl, fileId, role, generationId, protocolEpoch: 2, buildId: 'test-build', expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId, connectionNonce })
}

export class FakePeer implements RoomPeer {
  readonly messages: string[] = []
  readonly closes: Readonly<{ code: number; reason: string }>[] = []
  constructor(readonly connectionId = 'connection-1') {}
  send(message: string) { this.messages.push(message) }
  close(code: number, reason: string) { (this.closes as { code: number; reason: string }[]).push({ code, reason }) }
}

export class FakePersistence implements CollaborationPersistence {
  current = projection()
  ownerSubjectId = subjectId
  accessEpoch = 1n
  append?: (input: Parameters<CollaborationPersistence['appendOperation']>[0]) => Promise<AppendCollaborationOperationResult>
  readonly calls: string[] = []
  async registerGeneration() { this.calls.push('register'); return { status: 'registered' as const, generation: { fileId, generationId, protocolEpoch: 2, status: 'candidate' as const, fencingToken: null, createdAt: new Date(0).toISOString(), activatedAt: null, endedAt: null } } }
  async resolveAdmissionGeneration(input: Parameters<CollaborationPersistence['resolveAdmissionGeneration']>[0]) { this.calls.push('resolve-admission'); return { status: 'candidate' as const, generationId: input.generationId } }
  async acquireLease() { this.calls.push('acquire'); return { status: 'acquired' as const, lease } }
  async renewLease() { this.calls.push('renew'); return lease }
  async releaseLease() { this.calls.push('release'); return true }
  async getLease() { return lease }
  async bootstrapProjectionFromLegacy(): ReturnType<CollaborationPersistence['bootstrapProjectionFromLegacy']> { this.calls.push('bootstrap'); return { status: 'seeded' as const, projection: this.current, cutoverAuthority: 'snapshot-seed' as const } }
  async appendOperation(input: Parameters<CollaborationPersistence['appendOperation']>[0]) {
    this.calls.push(`append:${input.clientMutationId}`)
    if (input.expectedSubjectId !== this.ownerSubjectId) return { status: 'access-revoked' as const }
    if (input.expectedAccessEpoch !== this.accessEpoch) return { status: 'access-conflict' as const, currentAccessEpoch: this.accessEpoch }
    if (this.append) return this.append(input)
    const next = projection(input.projection.document, input.baseSequence + 1n)
    this.current = next
    return { status: 'committed' as const, projection: next, operation: { fileId, sequence: next.sequence, generationId, protocolEpoch: 2, fencingToken: 1n, subjectId: input.expectedSubjectId, clientId: input.clientId, clientMutationId: input.clientMutationId, operationType: input.operationType, operationPayload: input.operationPayload, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } }
  }
  async listOperationsAfter() { return [] }
  async getProjection() { return this.current }
  async pruneCoveredOperations(_input: Parameters<CollaborationPersistence['pruneCoveredOperations']>[0]) { return { status: 'pruned' as const, throughSequence: 0n, deletedCount: 0n } }
  async commitVerifiedCheckpoint() { this.calls.push('checkpoint'); return { status: 'committed' as const, checkpoint: { fileId, sequence: this.current.sequence, objectKey: 'checkpoint.json', objectDigest: this.current.documentDigest, documentDigest: this.current.documentDigest, compressedBytes: 1n, documentSchemaVersion: 7, generationId, fencingToken: 1n, committedAt: new Date(0).toISOString() } } }
  async getCheckpoint() { return null }
}

export const tickets = (role: 'owner' | 'viewer' = 'owner'): RoomTicketVerifier => ({
  async verify(context) { return Object.freeze({ claims: Object.freeze({ ...claims(role), clientId: context.clientId, connectionNonce: context.connectionNonce }) }) },
  async consume(authorization, input) { return authorization.claims.buildId === input.buildId && authorization.claims.expiresAtUnixMs > input.nowUnixMs ? authorization.claims : null },
  async isCurrent(value, nowUnixMs) { return value.expiresAtUnixMs > nowUnixMs },
})
export const projector: CollaborationProjector = { apply(value, command) { return Object.freeze({ ...value, revision: Number(value.revision) + 1, lastCommand: command.type }) as CollaborationPayload } }
export const checkpoints: CheckpointStore = { async write(value) { return { objectKey: 'checkpoint.json', objectDigest: value.documentDigest, documentDigest: value.documentDigest, compressedBytes: 1n } } }

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
