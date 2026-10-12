import { createHash } from 'node:crypto'
import type { CollaborationPayload } from '@canvas/database/collaboration'
import { nodeChildDisplay, nodePositionMode } from '@canvas/repo-engine/file-document'
import type { FileDocument, FileNode, NodeRelationship } from '@canvas/repo-engine/file-document'
import type {
  FlowDragAuthoritativeSource,
  FlowDragLane,
  FlowDragPresentation,
  FlowDragSlot,
  FlowDragTargetTopology,
  FlowDragTopologyAuthority,
} from '@canvas/sync-protocol/flow'
import { flowDragResourceLimits } from '@canvas/sync-protocol/flow'

export type FlowLaneSnapshot = Readonly<{
  lane: FlowDragLane
  nodeIds: readonly string[]
}>

export type FlowTopologySnapshot = Readonly<{
  pageId: string
  pageRootId: string
  sourceNodeId: string
  sourceLane: FlowLaneSnapshot
  sourceSubtreeNodeIds: readonly string[]
  sourceAncestorNodeIds: readonly string[]
}>

const file = (document: CollaborationPayload): FileDocument => document as unknown as FileDocument
const slotOf = (relationship: NodeRelationship): FlowDragSlot => Object.hasOwn(relationship, 'slot')
  ? Object.freeze({ presence: 'present' as const, value: relationship.slot! })
  : Object.freeze({ presence: 'absent' as const })

export function sameFlowSlot(left: FlowDragSlot, right: FlowDragSlot): boolean {
  return left.presence === right.presence
    && (left.presence === 'absent' || right.presence === 'present' && left.value === right.value)
}

export function sameFlowLane(left: FlowDragLane, right: FlowDragLane): boolean {
  return left.parentId === right.parentId && sameFlowSlot(left.slot, right.slot)
}

export function flowLaneKey(lane: FlowDragLane): string {
  return `${lane.parentId}\0${lane.slot.presence === 'absent' ? 'a' : `p${lane.slot.value.length}:${lane.slot.value}`}`
}

export function flowPresentationDigest(presentation: FlowDragPresentation): string {
  return createHash('sha256').update(JSON.stringify(presentation)).digest('hex')
}

function page(document: FileDocument, pageId: string) {
  return document.pages.find(candidate => candidate.id === pageId) ?? null
}

function relationshipLane(relationship: NodeRelationship): FlowDragLane {
  return Object.freeze({ parentId: relationship.parentId, slot: slotOf(relationship) })
}

export function flowLaneSnapshot(document: CollaborationPayload, lane: FlowDragLane): FlowLaneSnapshot | null {
  const current = file(document)
  const parent = current.nodes[lane.parentId]
  if (!parent) return null
  const nodeIds = Object.entries(current.relationships)
    .filter(([, relationship]) => relationship.parentId === lane.parentId && sameFlowSlot(slotOf(relationship), lane.slot))
    .map(([id, relationship]) => ({ id, orderKey: relationship.orderKey }))
    .sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(entry => entry.id)
  return Object.freeze({ lane: Object.freeze({ parentId: lane.parentId, slot: Object.freeze({ ...lane.slot }) }), nodeIds: Object.freeze(nodeIds) })
}

function descendants(document: FileDocument, sourceNodeId: string): readonly string[] | null {
  const collected: string[] = []
  const children = new Map<string, string[]>()
  for (const [nodeId, relationship] of Object.entries(document.relationships)) {
    const siblings = children.get(relationship.parentId) ?? []
    siblings.push(nodeId)
    children.set(relationship.parentId, siblings)
  }
  const queue = [{ nodeId: sourceNodeId, depth: 0 }]
  const seen = new Set<string>()
  while (queue.length) {
    const { nodeId: current, depth } = queue.shift()!
    if (depth > flowDragResourceLimits.maxTopologyDepth) return null
    if (seen.has(current)) continue
    seen.add(current)
    collected.push(current)
    if (collected.length > flowDragResourceLimits.maxLaneComparisonNodes) return null
    for (const nodeId of children.get(current) ?? []) queue.push({ nodeId, depth: depth + 1 })
  }
  return Object.freeze(collected)
}

function ancestors(document: FileDocument, sourceNodeId: string, pageRootId: string): readonly string[] | null {
  const collected: string[] = []
  const seen = new Set<string>([sourceNodeId])
  let current = document.relationships[sourceNodeId]?.parentId ?? null
  while (current !== null) {
    if (collected.length >= flowDragResourceLimits.maxTopologyDepth) return null
    if (seen.has(current)) return null
    seen.add(current)
    collected.push(current)
    if (current === pageRootId) return Object.freeze(collected)
    current = document.relationships[current]?.parentId ?? null
  }
  return null
}

function nodeOnPage(document: FileDocument, nodeId: string, pageRootId: string): boolean {
  if (nodeId === pageRootId) return true
  return ancestors(document, nodeId, pageRootId) !== null
}

function authoritativeSource(document: FileDocument, pageRootId: string, nodeId: string): FlowDragAuthoritativeSource | null {
  const node = document.nodes[nodeId]
  const relationship = document.relationships[nodeId]
  if (!node || node.type === 'root' || !relationship || !nodeOnPage(document, nodeId, pageRootId)) return null
  const lane = relationshipLane(relationship)
  const snapshot = flowLaneSnapshot(document as unknown as CollaborationPayload, lane)
  const sourceIndex = snapshot?.nodeIds.indexOf(nodeId) ?? -1
  if (sourceIndex < 0) return null
  return Object.freeze({
    kind: node.type,
    relationship: Object.freeze({ parentId: relationship.parentId, orderKey: relationship.orderKey, slot: lane.slot }),
    sourceIndex,
  })
}

function targetNode(document: FileDocument, target: FlowDragTargetTopology): FileNode | null {
  const candidate = document.nodes[target.targetLane.parentId]
  return candidate ?? null
}

export function flowTargetDenial(document: CollaborationPayload, target: FlowDragTargetTopology): 'missing_page' | 'missing_node' | 'wrong_page' | 'invalid_topology' | 'component_slot_unverified' | 'capacity_refused' | null {
  const current = file(document)
  const currentPage = page(current, target.pageId)
  if (!currentPage || currentPage.rootNodeId !== target.pageRootId) return 'missing_page'
  const source = current.nodes[target.sourceNodeId]
  if (!source) return 'missing_node'
  if (!nodeOnPage(current, target.sourceNodeId, currentPage.rootNodeId)) return 'wrong_page'
  if (target.targetLane.parentId === currentPage.rootNodeId) return 'invalid_topology'
  const parent = targetNode(current, target)
  if (!parent) return 'missing_node'
  if (!nodeOnPage(current, target.targetLane.parentId, currentPage.rootNodeId)) return 'wrong_page'
  if (parent.type === 'component' || target.targetLane.slot.presence === 'present') return 'component_slot_unverified'
  if (parent.type !== 'frame' || nodeChildDisplay(parent) !== 'flex') return 'invalid_topology'
  const descendantsOfSource = descendants(current, target.sourceNodeId)
  if (!descendantsOfSource) return 'capacity_refused'
  const sourceSubtree = new Set(descendantsOfSource)
  if (sourceSubtree.has(target.targetLane.parentId)) return 'invalid_topology'
  const lane = flowLaneSnapshot(document, target.targetLane)
  if (!lane || target.rawIndex > lane.nodeIds.length || target.semanticIndex > lane.nodeIds.length) return 'invalid_topology'
  return null
}

export function createFlowTopologyAuthority(document: CollaborationPayload, pageId: string, fileRevision = file(document).revision): FlowDragTopologyAuthority | null {
  const current = file(document)
  const currentPage = page(current, pageId)
  if (!currentPage) return null
  return Object.freeze({
    fileId: current.fileId,
    fileRevision,
    pageId,
    pageRootId: currentPage.rootNodeId,
    source(nodeId: string) { return authoritativeSource(current, currentPage.rootNodeId, nodeId) },
    acceptsTarget(target: FlowDragTargetTopology) { return flowTargetDenial(document, target) === null },
  })
}

export function captureFlowTopology(document: CollaborationPayload, presentation: FlowDragPresentation): FlowTopologySnapshot | null {
  const current = file(document)
  const currentPage = page(current, presentation.fence.pageId)
  const sourceNodeId = presentation.original.documentNodeId
  if (!currentPage || currentPage.rootNodeId !== presentation.fence.pageRootId) return null
  const source = authoritativeSource(current, currentPage.rootNodeId, sourceNodeId)
  if (!source) return null
  const sourceLane = flowLaneSnapshot(document, { parentId: source.relationship.parentId, slot: source.relationship.slot })
  const sourceAncestors = ancestors(current, sourceNodeId, currentPage.rootNodeId)
  const sourceDescendants = descendants(current, sourceNodeId)
  if (!sourceLane || !sourceAncestors || !sourceDescendants) return null
  return Object.freeze({
    pageId: currentPage.id,
    pageRootId: currentPage.rootNodeId,
    sourceNodeId,
    sourceLane,
    sourceSubtreeNodeIds: sourceDescendants,
    sourceAncestorNodeIds: sourceAncestors,
  })
}

export function sourcePositionMode(document: CollaborationPayload, nodeId: string): 'flow' | 'absolute' | 'freeform' | null {
  const node = file(document).nodes[nodeId]
  return node ? nodePositionMode(node) : null
}
