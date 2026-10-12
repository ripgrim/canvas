import { randomUUID } from 'node:crypto'
import type { CollaborationPayload } from '@canvas/database/collaboration'
import type { SemanticFileCommand } from '@canvas/sync-protocol'
import { flowDragResourceLimits } from '@canvas/sync-protocol/flow'
import type {
  FlowDragDenialCode,
  FlowDragLane,
  FlowDragPresentation,
  FlowDragTerminalBinding,
  InteractionReleaseReason,
} from '@canvas/sync-protocol'
import {
  captureFlowTopology,
  flowLaneSnapshot,
  flowPresentationDigest,
  flowTargetDenial,
  sameFlowLane,
} from './flow-authority.js'
import type { FlowLaneSnapshot, FlowTopologySnapshot } from './flow-authority.js'

export type FlowLeaseOwner = Readonly<{
  connectionId: string
  presenceId: string
  subjectId: string
  clientId: string
}>

export type FlowLease = Readonly<{
  leaseId: string
  owner: FlowLeaseOwner
  pageId: string
  interactionId: string
  localClaimGeneration: number
  reservationGeneration: number
  latestSequence: number
  topology: FlowTopologySnapshot
  lanes: readonly FlowLaneSnapshot[]
  activeTargetLane: FlowDragLane
  presentation: FlowDragPresentation
  presentationDigest: string
  pendingMutationIds: ReadonlySet<string>
  sampleTokens: number
  sampleTokensUpdatedAtMs: number
}>

export type FlowDecision = Readonly<{
  status: 'granted' | 'retained' | 'released' | 'denied'
  denialCode: FlowDragDenialCode | null
  lease: FlowLease | null
}>

export type FlowCommandScope = Readonly<{ nodeIds: ReadonlySet<string>; parentIds: ReadonlySet<string>; pageIds: ReadonlySet<string> }>

const denied = (code: FlowDragDenialCode, lease: FlowLease | null = null): FlowDecision => Object.freeze({ status: 'denied', denialCode: code, lease })
const accepted = (status: 'granted' | 'retained' | 'released', lease: FlowLease | null): FlowDecision => Object.freeze({ status, denialCode: null, lease })
const laneEquals = (left: FlowLaneSnapshot, right: FlowLaneSnapshot): boolean => sameFlowLane(left.lane, right.lane)
  && left.nodeIds.length === right.nodeIds.length && left.nodeIds.every((nodeId, index) => nodeId === right.nodeIds[index])
const setIntersects = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => [...left].some(value => right.has(value))

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value)
  }
  return value
}

export const peerFlowInteractionPrefix = 'lease:'

export function peerFlowInteractionId(leaseId: string): string {
  return `${peerFlowInteractionPrefix}${leaseId}`
}

export function isReservedPeerFlowInteractionId(interactionId: string): boolean {
  return interactionId.startsWith(peerFlowInteractionPrefix)
}

export function containsReservedPeerFlowInteractionId(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) continue
    if (key === 'interactionId' && typeof descriptor.value === 'string' && isReservedPeerFlowInteractionId(descriptor.value)) return true
    if (containsReservedPeerFlowInteractionId(descriptor.value)) return true
  }
  return false
}

function rewriteInteractionIds(value: unknown, interactionId: string): void {
  if (value === null || typeof value !== 'object') return
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) continue
    if (key === 'interactionId') {
      Object.defineProperty(value, key, { ...descriptor, value: interactionId })
      continue
    }
    rewriteInteractionIds(descriptor.value, interactionId)
  }
}

export function assertCanonicalPeerFlowPresentation(presentation: FlowDragPresentation, leaseId: string): void {
  const expected = peerFlowInteractionId(leaseId)
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) continue
      if (key === 'interactionId' && descriptor.value !== expected) throw new Error('Peer flow presentation contains a non-canonical interaction identity')
      visit(descriptor.value)
    }
  }
  visit(presentation)
}

export function canonicalPeerFlowPresentation(presentation: FlowDragPresentation, leaseId: string): FlowDragPresentation {
  const canonical = structuredClone(presentation)
  rewriteInteractionIds(canonical, peerFlowInteractionId(leaseId))
  assertCanonicalPeerFlowPresentation(canonical, leaseId)
  return deepFreeze(canonical)
}

function retainedPresentation(value: FlowDragPresentation): FlowDragPresentation {
  return deepFreeze(structuredClone(value))
}

function presentationFits(value: FlowDragPresentation): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= flowDragResourceLimits.maxSamplePayloadBytes
}

function reservationBytes(leases: Iterable<FlowLease>): number {
  let total = 0
  for (const lease of leases) total += Buffer.byteLength(JSON.stringify(lease.lanes), 'utf8')
  return total
}

function reservedNodeIds(leases: Iterable<FlowLease>): number {
  let total = 0
  for (const lease of leases) total += lease.lanes.reduce((sum, lane) => sum + lane.nodeIds.length, 0)
  return total
}

function withLease(lease: FlowLease, patch: Partial<Omit<FlowLease, 'leaseId' | 'owner' | 'pageId' | 'interactionId' | 'localClaimGeneration' | 'topology'>>): FlowLease {
  return Object.freeze({ ...lease, ...patch })
}

function targetLane(presentation: FlowDragPresentation): FlowDragLane {
  return presentation.target
    ? Object.freeze({ parentId: presentation.target.parentId, slot: Object.freeze({ ...presentation.target.slot }) })
    : Object.freeze({ parentId: presentation.original.sourceRelationship.parentId, slot: Object.freeze({ ...presentation.original.sourceRelationship.slot }) })
}

function leaseNodes(lease: FlowLease): ReadonlySet<string> {
  return new Set([...lease.topology.sourceSubtreeNodeIds, ...lease.topology.sourceAncestorNodeIds.filter(nodeId => nodeId !== lease.topology.pageRootId), ...lease.lanes.flatMap(lane => lane.nodeIds), ...lease.lanes.map(lane => lane.lane.parentId).filter(nodeId => nodeId !== lease.topology.pageRootId)])
}

function overlaps(left: FlowLease, right: FlowTopologySnapshot, rightLanes: readonly FlowLaneSnapshot[]): boolean {
  if (left.pageId !== right.pageId) return false
  if (left.lanes.some(existing => rightLanes.some(candidate => sameFlowLane(existing.lane, candidate.lane)))) return true
  const leftNodes = leaseNodes(left)
  const rightNodes = new Set([...right.sourceSubtreeNodeIds, ...right.sourceAncestorNodeIds.filter(nodeId => nodeId !== right.pageRootId), ...rightLanes.flatMap(lane => lane.nodeIds), ...rightLanes.map(lane => lane.lane.parentId).filter(nodeId => nodeId !== right.pageRootId)])
  return setIntersects(leftNodes, rightNodes)
}

function immutablePending(values: Iterable<string>): ReadonlySet<string> { return new Set(values) }

function topologyCurrent(document: CollaborationPayload, lease: FlowLease): boolean {
  const current = captureFlowTopology(document, lease.presentation)
  if (!current || current.pageId !== lease.topology.pageId || current.pageRootId !== lease.topology.pageRootId
    || current.sourceNodeId !== lease.topology.sourceNodeId) return false
  if (!laneEquals(current.sourceLane, lease.topology.sourceLane)) return false
  return lease.lanes.every(expected => {
    const actual = flowLaneSnapshot(document, expected.lane)
    return Boolean(actual && laneEquals(actual, expected))
  })
}

function commandScope(document: CollaborationPayload, command: SemanticFileCommand, scope: { nodeIds: Set<string>; parentIds: Set<string>; pageIds: Set<string> } = { nodeIds: new Set(), parentIds: new Set(), pageIds: new Set() }): FlowCommandScope {
  if (command.type === 'batch') {
    for (const nested of command.commands) commandScope(document, nested, scope)
    return scope
  }
  if ('pageId' in command && typeof command.pageId === 'string') scope.pageIds.add(command.pageId)
  if ('nodeId' in command && typeof command.nodeId === 'string') scope.nodeIds.add(command.nodeId)
  if (command.type === 'node.insert') { scope.nodeIds.add(command.node.id); scope.parentIds.add(command.placement.parentId) }
  if (command.type === 'node.delete') command.nodeIds.forEach(nodeId => scope.nodeIds.add(nodeId))
  if (command.type === 'node.reparent') scope.parentIds.add(command.placement.parentId)
  if (command.type === 'node.restoreRelationship') {
    scope.parentIds.add(command.expected.parentId)
    scope.parentIds.add(command.source.parentId)
  }
  if (command.type === 'node.duplicate') Object.values(command.ids).forEach(nodeId => scope.nodeIds.add(nodeId))
  if (command.type === 'node.resizePresentation') command.entries.forEach(entry => {
    scope.nodeIds.add(entry.expected.nodeId)
    scope.nodeIds.add(entry.source.nodeId)
    scope.parentIds.add(entry.expected.relationship.parentId)
    scope.parentIds.add(entry.source.relationship.parentId)
  })
  if (command.type === 'node.wrap') command.groups.forEach(group => {
    scope.nodeIds.add(group.wrapper.id)
    scope.parentIds.add(group.parentId)
    group.children.forEach(child => scope.nodeIds.add(child.nodeId))
  })
  if (command.type === 'node.unwrap') command.groups.forEach(group => {
    scope.nodeIds.add(group.wrapperId)
    group.children.forEach(child => { scope.nodeIds.add(child.nodeId); scope.parentIds.add(child.relationship.parentId) })
  })
  const addFlexGroup = (group: { parent: { nodeId: string; relationship: { parentId: string } }; children: readonly { nodeId: string; relationship: { parentId: string } }[] }) => {
    scope.nodeIds.add(group.parent.nodeId)
    scope.parentIds.add(group.parent.relationship.parentId)
    group.children.forEach(child => { scope.nodeIds.add(child.nodeId); scope.parentIds.add(child.relationship.parentId) })
  }
  if (command.type === 'node.removeFlex') command.groups.forEach(addFlexGroup)
  if (command.type === 'node.restoreFlex') command.groups.forEach(group => { addFlexGroup(group.expected); addFlexGroup(group.source) })
  return scope
}

function touches(lease: FlowLease, scope: FlowCommandScope): boolean {
  if (scope.pageIds.has(lease.pageId)) return true
  const protectedNodes = leaseNodes(lease)
  return setIntersects(protectedNodes, scope.nodeIds) || setIntersects(protectedNodes, scope.parentIds)
}

type StructuralTerminal = Readonly<{ kind: 'move'; nodeId: string }> | Readonly<{ kind: 'clone'; nodeId: string; cloneId: string }>
function terminalStructure(command: SemanticFileCommand, sourceNodeId: string): StructuralTerminal | null {
  let sourceMoves = 0
  const cloneIds: string[] = []
  const visit = (candidate: SemanticFileCommand) => {
    if (candidate.type === 'batch') { candidate.commands.forEach(visit); return }
    if ((candidate.type === 'node.reparent' || candidate.type === 'node.reorder' || candidate.type === 'node.restoreRelationship') && candidate.nodeId === sourceNodeId) sourceMoves += 1
    if (candidate.type === 'node.duplicate' && candidate.nodeId === sourceNodeId && candidate.ids[sourceNodeId]) cloneIds.push(candidate.ids[sourceNodeId]!)
  }
  visit(command)
  if (sourceMoves !== 1 || cloneIds.length > 1) return null
  return cloneIds.length === 1 ? { kind: 'clone', nodeId: sourceNodeId, cloneId: cloneIds[0]! } : { kind: 'move', nodeId: sourceNodeId }
}

function inserted(ids: readonly string[], nodeId: string, index: number): readonly string[] {
  const copy = [...ids]
  copy.splice(Math.min(index, copy.length), 0, nodeId)
  return copy
}

function removed(ids: readonly string[], nodeId: string): readonly string[] { return ids.filter(id => id !== nodeId) }

function expectedTerminalLanes(lease: FlowLease, structural: StructuralTerminal): readonly FlowLaneSnapshot[] | null {
  const source = lease.topology.sourceLane
  const target = lease.lanes.find(candidate => sameFlowLane(candidate.lane, lease.activeTargetLane))
  if (!target) return null
  const same = sameFlowLane(source.lane, target.lane)
  const destinationId = structural.nodeId
  const presentedIndex = structural.kind === 'clone'
    ? lease.presentation.target?.rawIndex
    : lease.presentation.target?.semanticIndex
  let index = Math.min(presentedIndex ?? source.nodeIds.indexOf(structural.nodeId), same && structural.kind === 'move' ? Math.max(0, target.nodeIds.length - 1) : target.nodeIds.length)
  if (same && structural.kind === 'clone' && index === source.nodeIds.indexOf(structural.nodeId)) index += 1
  if (same) {
    const withoutOriginal = removed(source.nodeIds, structural.nodeId)
    const base = structural.kind === 'clone'
      ? inserted(withoutOriginal, structural.cloneId, Math.max(0, source.nodeIds.indexOf(structural.nodeId)))
      : withoutOriginal
    const transitioned = Object.freeze({ lane: source.lane, nodeIds: Object.freeze(inserted(base, destinationId, index)) })
    return Object.freeze([transitioned, ...lease.lanes.filter(lane => !sameFlowLane(lane.lane, transitioned.lane))])
  }
  const transitioned = [
    Object.freeze({ lane: source.lane, nodeIds: Object.freeze(structural.kind === 'clone'
      ? inserted(removed(source.nodeIds, structural.nodeId), structural.cloneId, Math.max(0, source.nodeIds.indexOf(structural.nodeId)))
      : removed(source.nodeIds, structural.nodeId)) }),
    Object.freeze({ lane: target.lane, nodeIds: Object.freeze(inserted(target.nodeIds, destinationId, index)) }),
  ]
  return Object.freeze([...transitioned, ...lease.lanes.filter(lane => !transitioned.some(changed => sameFlowLane(lane.lane, changed.lane)))])
}

export class FlowReservationAuthority {
  readonly #leases = new Map<string, FlowLease>()
  readonly #connectionLeaseIds = new Map<string, Set<string>>()

  roster(): readonly FlowLease[] { return Object.freeze([...this.#leases.values()]) }
  find(leaseId: string): FlowLease | null { return this.#leases.get(leaseId) ?? null }

  acquire(document: CollaborationPayload, owner: FlowLeaseOwner, localClaimGeneration: number, presentation: FlowDragPresentation, requestedLeaseId?: string): FlowDecision {
    if (!presentationFits(presentation)) return denied('capacity_refused')
    const ownedLeases = [...this.#leases.values()].filter(lease => lease.owner.connectionId === owner.connectionId)
    const byIdentity = [...this.#leases.values()].find(lease => lease.owner.connectionId === owner.connectionId
      && lease.interactionId === presentation.identity.interactionId) ?? null
    const existing = requestedLeaseId ? this.#leases.get(requestedLeaseId) ?? null : byIdentity
    if (requestedLeaseId && !existing) return denied('lease_not_found')
    if (existing) {
      if (existing.owner.connectionId !== owner.connectionId || existing.interactionId !== presentation.identity.interactionId) return denied('lease_not_found')
      if (localClaimGeneration < existing.localClaimGeneration) return denied('stale_generation', existing)
      if (localClaimGeneration === existing.localClaimGeneration) {
        return flowPresentationDigest(presentation) === existing.presentationDigest
          ? accepted('retained', existing)
          : denied('invalid_topology', existing)
      }
    }
    if (!existing && this.#leases.size >= flowDragResourceLimits.maxClaimsPerRoom) return denied('capacity_refused')
    if (!existing && ownedLeases.length >= flowDragResourceLimits.maxClaimsPerLease) return denied('capacity_refused')
    const topology = captureFlowTopology(document, presentation)
    if (!topology) return denied('invalid_topology')
    const candidateTarget = targetLane(presentation)
    const topologyTarget = presentation.target ? {
      pageId: topology.pageId, pageRootId: topology.pageRootId, sourceNodeId: topology.sourceNodeId,
      sourceLane: topology.sourceLane.lane, targetLane: candidateTarget,
      rawIndex: presentation.target.rawIndex, semanticIndex: presentation.target.semanticIndex, line: presentation.target.line,
    } : null
    if (topologyTarget) {
      const targetError = flowTargetDenial(document, topologyTarget)
      if (targetError) return denied(targetError)
    }
    const targetSnapshot = flowLaneSnapshot(document, candidateTarget)
    if (!targetSnapshot) return denied('invalid_topology')
    const lanes = sameFlowLane(topology.sourceLane.lane, targetSnapshot.lane) ? [topology.sourceLane] : [topology.sourceLane, targetSnapshot]
    if (lanes.some(lane => lane.nodeIds.length > flowDragResourceLimits.maxNodeIdsPerLane)) return denied('capacity_refused')
    if (existing) {
      const reservedTarget = existing.lanes.find(lane => sameFlowLane(lane.lane, candidateTarget))
      const fence = presentation.fence
      const retainedFence = existing.presentation.fence
      if (!topologyCurrent(document, existing)
        || topology.pageId !== existing.topology.pageId || topology.pageRootId !== existing.topology.pageRootId
        || topology.sourceNodeId !== existing.topology.sourceNodeId || !laneEquals(topology.sourceLane, existing.topology.sourceLane)
        || fence.fileId !== retainedFence.fileId || fence.fileRevision !== retainedFence.fileRevision
        || fence.measurementRevision !== retainedFence.measurementRevision || fence.documentRevision !== retainedFence.documentRevision
        || fence.layoutGeneration !== retainedFence.layoutGeneration || fence.pageId !== retainedFence.pageId
        || fence.pageRootId !== retainedFence.pageRootId
        || presentation.identity.gestureGeneration !== existing.presentation.identity.gestureGeneration) return denied('invalid_topology', existing)
      if (presentation.identity.sampleSequence <= existing.latestSequence) return denied('stale_sequence', existing)
      if (!sameFlowLane(candidateTarget, existing.activeTargetLane) || !reservedTarget || !laneEquals(reservedTarget, targetSnapshot)) return denied('stale_reservation', existing)
      const retained = retainedPresentation(presentation)
      const replacement = Object.freeze({
        ...existing,
        localClaimGeneration,
        latestSequence: presentation.identity.sampleSequence,
        presentation: retained,
        presentationDigest: flowPresentationDigest(retained),
      })
      this.#leases.set(existing.leaseId, replacement)
      return accepted('granted', replacement)
    }
    for (const lease of this.#leases.values()) {
      if (overlaps(lease, topology, lanes)) return denied('overlap')
    }
    const retained = retainedPresentation(presentation)
    const lease: FlowLease = Object.freeze({
      leaseId: requestedLeaseId ?? randomUUID(), owner, pageId: topology.pageId,
      interactionId: presentation.identity.interactionId, localClaimGeneration,
      reservationGeneration: 1, latestSequence: presentation.identity.sampleSequence,
      topology, lanes: Object.freeze(lanes), activeTargetLane: candidateTarget,
      presentation: retained, presentationDigest: flowPresentationDigest(retained), pendingMutationIds: immutablePending([]),
      sampleTokens: flowDragResourceLimits.maxSampleBurst,
      sampleTokensUpdatedAtMs: Date.now(),
    })
    const nextLeases = [...this.#leases.values(), lease]
    if (nextLeases.reduce((sum, candidate) => sum + candidate.lanes.length, 0) > flowDragResourceLimits.maxReservationsPerRoom
      || reservedNodeIds(nextLeases) > flowDragResourceLimits.maxReservedIdsPerSession
      || reservationBytes(nextLeases) > flowDragResourceLimits.maxReservationBytesPerSession) return denied('capacity_refused')
    this.#leases.set(lease.leaseId, lease)
    const ids = this.#connectionLeaseIds.get(owner.connectionId) ?? new Set<string>()
    ids.add(lease.leaseId); this.#connectionLeaseIds.set(owner.connectionId, ids)
    return accepted('granted', lease)
  }

  reserve(document: CollaborationPayload, owner: FlowLeaseOwner, leaseId: string, localClaimGeneration: number, reservationGeneration: number, requestedTarget: FlowDragLane, presentation: FlowDragPresentation): FlowDecision {
    if (!presentationFits(presentation)) return denied('capacity_refused')
    const lease = this.#owned(owner, leaseId, localClaimGeneration, presentation.identity.interactionId)
    if (!lease) return denied('lease_not_found')
    if (localClaimGeneration !== lease.localClaimGeneration) return denied('stale_generation', lease)
    if (reservationGeneration !== lease.reservationGeneration + 1) return denied('stale_reservation', lease)
    if (presentation.identity.sampleSequence <= lease.latestSequence) return denied('stale_sequence', lease)
    if (!topologyCurrent(document, lease)) return denied('invalid_topology', lease)
    if (!presentation.target || !sameFlowLane(requestedTarget, targetLane(presentation))) return denied('invalid_topology', lease)
    const targetError = flowTargetDenial(document, {
      pageId: lease.pageId, pageRootId: lease.topology.pageRootId, sourceNodeId: lease.topology.sourceNodeId,
      sourceLane: lease.topology.sourceLane.lane, targetLane: requestedTarget,
      rawIndex: presentation.target.rawIndex, semanticIndex: presentation.target.semanticIndex, line: presentation.target.line,
    })
    if (targetError) return denied(targetError, lease)
    const snapshot = flowLaneSnapshot(document, requestedTarget)
    if (!snapshot || snapshot.nodeIds.length > flowDragResourceLimits.maxNodeIdsPerLane) return denied('capacity_refused', lease)
    const reserved = lease.lanes.find(existing => sameFlowLane(existing.lane, requestedTarget))
    if (reserved && !laneEquals(reserved, snapshot)) return denied('invalid_topology', lease)
    if (!reserved && lease.lanes.length >= flowDragResourceLimits.maxLanesPerReservation) return denied('capacity_refused', lease)
    for (const candidate of this.#leases.values()) {
      if (candidate.leaseId !== lease.leaseId && overlaps(candidate, lease.topology, [snapshot])) return denied('overlap', lease)
    }
    const retained = retainedPresentation(presentation)
    const next = withLease(lease, {
      reservationGeneration, latestSequence: presentation.identity.sampleSequence,
      lanes: reserved ? lease.lanes : Object.freeze([...lease.lanes, snapshot]), activeTargetLane: requestedTarget,
      presentation: retained, presentationDigest: flowPresentationDigest(retained),
    })
    const replacement = [...this.#leases.values()].map(candidate => candidate.leaseId === leaseId ? next : candidate)
    if (replacement.reduce((sum, candidate) => sum + candidate.lanes.length, 0) > flowDragResourceLimits.maxReservationsPerRoom
      || reservedNodeIds(replacement) > flowDragResourceLimits.maxReservedIdsPerSession
      || reservationBytes(replacement) > flowDragResourceLimits.maxReservationBytesPerSession) return denied('capacity_refused', lease)
    this.#leases.set(leaseId, next)
    return accepted('retained', next)
  }

  sample(document: CollaborationPayload, owner: FlowLeaseOwner, leaseId: string, localClaimGeneration: number, reservationGeneration: number, presentation: FlowDragPresentation): FlowDecision {
    if (!presentationFits(presentation)) return denied('capacity_refused')
    const lease = this.#owned(owner, leaseId, localClaimGeneration, presentation.identity.interactionId)
    if (!lease) return denied('lease_not_found')
    if (localClaimGeneration !== lease.localClaimGeneration) return denied('stale_generation', lease)
    if (reservationGeneration !== lease.reservationGeneration) return denied('stale_reservation', lease)
    if (presentation.identity.sampleSequence <= lease.latestSequence) return denied('stale_sequence', lease)
    if (!topologyCurrent(document, lease)) return denied('invalid_topology', lease)
    const currentTarget = targetLane(presentation)
    if (!sameFlowLane(currentTarget, lease.activeTargetLane)) return denied('stale_reservation', lease)
    const now = Date.now()
    const replenishedTokens = Math.min(
      flowDragResourceLimits.maxSampleBurst,
      lease.sampleTokens + Math.max(0, now - lease.sampleTokensUpdatedAtMs) * flowDragResourceLimits.maxSamplesPerSecond / 1_000,
    )
    if (replenishedTokens < 1) return denied('capacity_refused', lease)
    const retained = retainedPresentation(presentation)
    const next = withLease(lease, {
      latestSequence: presentation.identity.sampleSequence,
      presentation: retained, presentationDigest: flowPresentationDigest(retained),
      sampleTokens: replenishedTokens - 1,
      sampleTokensUpdatedAtMs: now,
    })
    this.#leases.set(leaseId, next)
    return accepted('retained', next)
  }

  operationPreflight(document: CollaborationPayload, owner: FlowLeaseOwner, mutationId: string, command: SemanticFileCommand, binding?: FlowDragTerminalBinding): Readonly<{ status: 'allowed'; lease: FlowLease | null; expectedPostLanes: readonly FlowLaneSnapshot[] | null }> | Readonly<{ status: 'denied'; code: FlowDragDenialCode }> {
    const scope = commandScope(document, command)
    const touched = [...this.#leases.values()].filter(lease => touches(lease, scope))
    const owned = touched.filter(lease => lease.owner.connectionId === owner.connectionId)
    if (touched.some(lease => lease.owner.connectionId !== owner.connectionId)) return { status: 'denied', code: 'overlap' }
    if (!touched.length) return binding ? { status: 'denied', code: 'lease_not_found' } : { status: 'allowed', lease: null, expectedPostLanes: null }
    if (owned.length !== 1 || !binding) return { status: 'denied', code: 'lease_not_found' }
    const lease = owned[0]!
    if (binding.leaseId !== lease.leaseId || binding.interactionId !== lease.interactionId
      || binding.localClaimGeneration !== lease.localClaimGeneration || binding.reservationGeneration !== lease.reservationGeneration
      || binding.terminalSampleSequence !== lease.latestSequence || binding.presentationDigest !== lease.presentationDigest
      || !sameFlowLane(binding.sourceLane, lease.topology.sourceLane.lane) || !sameFlowLane(binding.targetLane, lease.activeTargetLane)) return { status: 'denied', code: 'invalid_topology' }
    if (lease.presentation.retention.kind !== 'terminal-retained'
      || lease.presentation.retention.terminalSampleSequence !== lease.latestSequence
      || !topologyCurrent(document, lease) || lease.pendingMutationIds.size) return { status: 'denied', code: 'invalid_topology' }
    const structural = terminalStructure(command, lease.topology.sourceNodeId)
    if (structural?.kind === 'clone' && lease.presentation.supportClone === null) return { status: 'denied', code: 'invalid_topology' }
    if (structural?.kind === 'move' && lease.presentation.supportClone !== null) return { status: 'denied', code: 'invalid_topology' }
    const expectedPostLanes = structural ? expectedTerminalLanes(lease, structural) : null
    if (!structural || !expectedPostLanes) return { status: 'denied', code: 'invalid_topology' }
    const pending = immutablePending([...lease.pendingMutationIds, mutationId])
    this.#leases.set(lease.leaseId, withLease(lease, { pendingMutationIds: pending }))
    return { status: 'allowed', lease: this.#leases.get(lease.leaseId)!, expectedPostLanes }
  }

  operationPostflight(document: CollaborationPayload, leaseId: string, mutationId: string, expected: readonly FlowLaneSnapshot[]): boolean {
    const lease = this.#leases.get(leaseId)
    if (!lease || !lease.pendingMutationIds.has(mutationId)) return false
    return expected.every(lane => {
      const current = flowLaneSnapshot(document, lane.lane)
      return Boolean(current && laneEquals(current, lane))
    })
  }

  reservationsCurrent(document: CollaborationPayload, excludingLeaseId?: string): boolean {
    return [...this.#leases.values()].every(lease => lease.leaseId === excludingLeaseId || topologyCurrent(document, lease))
  }

  settleMutation(leaseId: string, mutationId: string, release: boolean): FlowLease | null {
    const lease = this.#leases.get(leaseId)
    if (!lease || !lease.pendingMutationIds.has(mutationId)) return null
    const pending = new Set(lease.pendingMutationIds); pending.delete(mutationId)
    if (release && pending.size === 0) { this.#delete(lease); return lease }
    const next = withLease(lease, { pendingMutationIds: immutablePending(pending) })
    this.#leases.set(leaseId, next)
    return next
  }

  release(owner: FlowLeaseOwner, pageId: string, leaseId: string, interactionId: string, localClaimGeneration: number, reservationGeneration: number, terminalSampleSequence: number, _reason: InteractionReleaseReason): FlowDecision {
    const lease = this.#owned(owner, leaseId, localClaimGeneration, interactionId)
    if (!lease) return denied('lease_not_found')
    if (pageId !== lease.pageId) return denied('wrong_page', lease)
    if (localClaimGeneration !== lease.localClaimGeneration) return denied('stale_generation', lease)
    if (reservationGeneration !== lease.reservationGeneration) return denied('stale_reservation', lease)
    if (terminalSampleSequence !== lease.latestSequence) return denied('stale_sequence', lease)
    if (lease.pendingMutationIds.size) return accepted('retained', lease)
    this.#delete(lease)
    return accepted('released', lease)
  }

  releaseConnection(connectionId: string): readonly FlowLease[] {
    const ids = [...(this.#connectionLeaseIds.get(connectionId) ?? [])]
    const released: FlowLease[] = []
    for (const id of ids) {
      const lease = this.#leases.get(id)
      if (lease && lease.owner.connectionId === connectionId) { released.push(lease); this.#delete(lease) }
    }
    return Object.freeze(released)
  }

  invalidate(owner: FlowLeaseOwner, leaseId: string, interactionId: string, localClaimGeneration: number): FlowLease | null {
    const lease = this.#owned(owner, leaseId, localClaimGeneration, interactionId)
    if (!lease || lease.localClaimGeneration !== localClaimGeneration) return null
    this.#delete(lease)
    return lease
  }

  invalidateAll(): readonly FlowLease[] {
    const released = Object.freeze([...this.#leases.values()])
    this.#leases.clear(); this.#connectionLeaseIds.clear()
    return released
  }

  #owned(owner: FlowLeaseOwner, leaseId: string, localClaimGeneration: number, interactionId: string): FlowLease | null {
    const lease = this.#leases.get(leaseId)
    return lease && lease.owner.connectionId === owner.connectionId && lease.owner.presenceId === owner.presenceId
      && lease.owner.subjectId === owner.subjectId && lease.owner.clientId === owner.clientId
      && lease.interactionId === interactionId && localClaimGeneration >= lease.localClaimGeneration ? lease : null
  }

  #delete(lease: FlowLease): void {
    if (this.#leases.get(lease.leaseId) !== lease) return
    this.#leases.delete(lease.leaseId)
    const ids = this.#connectionLeaseIds.get(lease.owner.connectionId)
    ids?.delete(lease.leaseId)
    if (!ids?.size) this.#connectionLeaseIds.delete(lease.owner.connectionId)
  }
}
