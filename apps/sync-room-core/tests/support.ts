import { collaborationDocumentDigest } from '@canvas/database/collaboration'
import type {
  AppendCollaborationOperationResult,
  CollaborationLease,
  CollaborationPayload,
  CollaborationPersistence,
  CollaborationProjection,
} from '@canvas/database/collaboration'
import type { FlowDragPresentation, FlowDragSlot, VerifiedRoomTicketClaims } from '@canvas/sync-protocol'
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
    schemaVersion: 12,
    fileId,
    revision: 0,
    pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
    nodes: { 'root-1': { id: 'root-1', type: 'root' }, 'node-1': { id: 'node-1', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 100 } } },
    relationships: { 'node-1': { parentId: 'root-1', orderKey: 'V' } },
    theme: { tokens: {} },
    componentModel: { definitions: {}, instances: {} },
    ...extra,
  } as CollaborationPayload
}

export function flowDocument(): CollaborationPayload {
  const flex = { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } as const
  return document({
    nodes: {
      'root-1': { id: 'root-1', type: 'root' },
      'source-frame': { id: 'source-frame', type: 'frame', name: 'Source', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 300, height: 200 }, layout: { item: { position: { mode: 'freeform' } }, container: flex } },
      'target-frame': { id: 'target-frame', type: 'frame', name: 'Target', styles: { relativeTransform: [1, 0, 0, 1, 400, 0], width: 300, height: 200 }, layout: { item: { position: { mode: 'freeform' } }, container: flex } },
      'source-node': { id: 'source-node', type: 'rectangle', name: 'Source node', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 80 }, layout: { item: { position: { mode: 'flow' } } } },
      'target-child': { id: 'target-child', type: 'rectangle', name: 'Target child', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
      'disjoint-frame': { id: 'disjoint-frame', type: 'frame', name: 'Disjoint', styles: { relativeTransform: [1, 0, 0, 1, 800, 0], width: 200, height: 200 }, layout: { item: { position: { mode: 'freeform' } }, container: flex } },
      'disjoint-node': { id: 'disjoint-node', type: 'rectangle', name: 'Disjoint node', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 30, height: 30 }, layout: { item: { position: { mode: 'flow' } } } },
    },
    relationships: {
      'source-frame': { parentId: 'root-1', orderKey: 'V' },
      'target-frame': { parentId: 'root-1', orderKey: 'W' },
      'disjoint-frame': { parentId: 'root-1', orderKey: 'X' },
      'source-node': { parentId: 'source-frame', orderKey: 'V' },
      'target-child': { parentId: 'target-frame', orderKey: 'V' },
      'disjoint-node': { parentId: 'disjoint-frame', orderKey: 'V' },
    },
  })
}

const flowGeometry = (x: number, y: number) => ({
  coordinateSpace: 'world' as const,
  quad: [{ x, y }, { x: x + 100, y }, { x: x + 100, y: y + 80 }, { x, y: y + 80 }] as const,
  aabb: { x, y, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 },
})

export function flowPresentation(input: Readonly<{
  interactionId?: string
  sequence?: number
  gestureGeneration?: number
  sourceNodeId?: string
  sourceKind?: FlowDragPresentation['original']['kind']
  sourceParentId?: string
  sourceOrderKey?: string
  sourceSlot?: FlowDragSlot
  sourceIndex?: number
  targetParentId?: string | null
  targetIndex?: number
  targetRawIndex?: number
  targetSemanticIndex?: number
  terminal?: boolean
  supportClone?: boolean
  sourceMode?: 'flow' | 'absolute'
}> = {}): FlowDragPresentation {
  const interactionId = input.interactionId ?? 'flow-interaction'
  const gestureGeneration = input.gestureGeneration ?? 1
  const sequence = input.sequence ?? 1
  const sourceNodeId = input.sourceNodeId ?? 'source-node'
  const sourceParentId = input.sourceParentId ?? 'source-frame'
  const sourceOrderKey = input.sourceOrderKey ?? 'V'
  const sourceIndex = input.sourceIndex ?? 0
  const source = flowGeometry(0, 0)
  const current = flowGeometry(10, 20)
  const sourceSlot = input.sourceSlot ?? { presence: 'absent' as const }
  const relationship = { parentId: sourceParentId, orderKey: sourceOrderKey, slot: sourceSlot }
  const supportClone = input.supportClone ? {
    key: { kind: 'flow-support-clone' as const, interactionId, gestureGeneration, cloneGeneration: 1 },
    documentNodeId: null, generation: 1, sourceRelationship: relationship, sourceIndex, entryMode: 'flow' as const,
    entry: null, world: source, hiddenUntilCommit: true as const, role: 'inert-marker' as const,
    layoutParticipation: 'none' as const, hitTesting: 'none' as const, a11y: 'hidden' as const,
  } : null
  const targetParentId = input.targetParentId === undefined ? 'target-frame' : input.targetParentId
  return {
    kind: 'flow-drag', coordinateSpace: 'world', identity: { interactionId, gestureGeneration, sampleSequence: sequence },
    fence: { fileId, fileRevision: 0, measurementRevision: 1, documentRevision: 0, layoutGeneration: 1, pageId: 'page-1', pageRootId: 'root-1' },
    retention: input.terminal
      ? { kind: 'terminal-retained', gestureGeneration, sampleSequence: sequence, terminalReason: 'pointer-up', terminalSampleSequence: sequence, holdUntil: 'authoritative-geometry' }
      : { kind: 'active', gestureGeneration, sampleSequence: sequence },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
    original: {
      documentNodeId: sourceNodeId, kind: input.sourceKind ?? 'rectangle', name: 'Source node', sourceRelationship: relationship,
      sourceIndex, mode: input.sourceMode ?? 'flow', source, current, sourceOffsetParentPose: null,
      dom: { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null },
      namePresentation: { visible: true, anchor: 'source', pose: source },
    },
    movingVisual: { kind: 'fill-ghost', documentNodeId: null, geometry: current, fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden' },
    supportClone,
    target: targetParentId === null ? null : {
      parentId: targetParentId, slot: { presence: 'absent' },
      rawIndex: input.targetRawIndex ?? input.targetIndex ?? 0,
      semanticIndex: input.targetSemanticIndex ?? input.targetIndex ?? 0,
      line: 0,
      parentOutline: targetParentId === sourceParentId ? null : {
        coordinateSpace: 'world', quad: [{ x: 400, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 200 }, { x: 400, y: 200 }],
        aabb: { x: 400, y: 0, width: 300, height: 200 }, color: 'oklch(0.67 0.17 258)', widthCssPx: 2,
      },
      insertionGuide: null,
    },
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
  }
}

export function projection(value = document(), sequence = 0n): CollaborationProjection {
  return Object.freeze({
    fileId,
    sequence,
    documentSchemaVersion: 12,
    document: value,
    documentDigest: collaborationDocumentDigest(value),
    generationId,
    fencingToken: 1n,
    authority: sequence === 0n ? 'legacy-seed' : 'room',
    updatedAt: new Date(0).toISOString(),
  })
}

export const lease: CollaborationLease = Object.freeze({
  fileId, generationId, protocolEpoch: 4, fencingToken: 1n,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), renewedAt: new Date().toISOString(),
})

export function claims(role: 'owner' | 'viewer' = 'owner'): VerifiedRoomTicketClaims {
  return Object.freeze({ subjectId, displayName, avatarUrl, fileId, role, generationId, protocolEpoch: 4, buildId: 'test-build', expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId, connectionNonce })
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
  readonly committedMutations = new Map<string, Readonly<{
    fingerprint: string
    result: Extract<AppendCollaborationOperationResult, { status: 'committed' }>
  }>>()
  async registerGeneration() { this.calls.push('register'); return { status: 'registered' as const, generation: { fileId, generationId, protocolEpoch: 4, status: 'candidate' as const, fencingToken: null, createdAt: new Date(0).toISOString(), activatedAt: null, endedAt: null } } }
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
    const fingerprint = JSON.stringify({ operationType: input.operationType, operationPayload: input.operationPayload })
    const mutationKey = `${input.clientId}:${input.clientMutationId}`
    const committed = this.committedMutations.get(mutationKey)
    if (committed) return committed.fingerprint === fingerprint
      ? { status: 'replayed' as const, operation: committed.result.operation }
      : { status: 'mutation-conflict' as const }
    if (input.baseSequence !== this.current.sequence) return { status: 'sequence-conflict' as const, currentSequence: this.current.sequence }
    const next = projection(input.projection.document, input.baseSequence + 1n)
    this.current = next
    const result = { status: 'committed' as const, projection: next, operation: { fileId, sequence: next.sequence, generationId, protocolEpoch: 4, fencingToken: 1n, subjectId: input.expectedSubjectId, clientId: input.clientId, clientMutationId: input.clientMutationId, operationType: input.operationType, operationPayload: input.operationPayload, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } }
    this.committedMutations.set(mutationKey, { fingerprint, result })
    return result
  }
  async listOperationsAfter() { return [] }
  async getProjection() { return this.current }
  async pruneCoveredOperations(_input: Parameters<CollaborationPersistence['pruneCoveredOperations']>[0]) { return { status: 'pruned' as const, throughSequence: 0n, deletedCount: 0n } }
  async commitVerifiedCheckpoint() { this.calls.push('checkpoint'); return { status: 'committed' as const, checkpoint: { fileId, sequence: this.current.sequence, objectKey: 'checkpoint.json', objectDigest: this.current.documentDigest, documentDigest: this.current.documentDigest, compressedBytes: 1n, documentSchemaVersion: 12, generationId, fencingToken: 1n, committedAt: new Date(0).toISOString() } } }
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
