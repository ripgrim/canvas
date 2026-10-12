import { acceptsChild, childrenOf, descendantsOf, nodeIsLocked, nodePositionMode } from '@canvas/repo-engine/file-document'
import type { FileDocument, FileNode, NodeRelationship } from '@canvas/repo-engine/file-document'
import { getNodeSlots } from '@canvas/repo-engine/document'
import { flexDirections, flexWraps } from '@canvas/repo-engine/layout'
import type { Rect } from './canvas-math'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import { measuredFlexInsertIndex } from './flex-reorder'
import type { FlexReorderSibling } from './flex-reorder'
import { validFlowDragState } from './flow-drag-state'
import type { FlowDragSourceRelationship, FlowDragTarget, PaperFlowDragState } from './flow-drag-state'

export type ResolveFlowDragTargetInput = Readonly<{
  authority: GestureAuthoritySnapshot
  state: PaperFlowDragState
  hoveredNodeId: string
}>

const positiveRect = (rect: Readonly<Rect>): boolean => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
const sameRect = (left: Readonly<Rect>, right: Readonly<Rect>): boolean => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
const generation = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function sameSlot(relationship: NodeRelationship, source: FlowDragSourceRelationship): boolean {
  return source.slot.presence === 'absent'
    ? !Object.hasOwn(relationship, 'slot')
    : Object.hasOwn(relationship, 'slot') && relationship.slot === source.slot.value
}

function sameSourceRelationship(actual: NodeRelationship, expected: FlowDragSourceRelationship): boolean {
  return actual.parentId === expected.parentId && actual.orderKey === expected.orderKey && sameSlot(actual, expected)
}

function exactChildren(file: FileDocument, parentId: string, slot: FlowDragSourceRelationship['slot']): string[] {
  return childrenOf(file, parentId).filter(id => {
    const relationship = file.relationships[id]!
    return slot.presence === 'absent' ? !Object.hasOwn(relationship, 'slot') : relationship.slot === slot.value
  })
}

function currentAuthority(authority: GestureAuthoritySnapshot, state: PaperFlowDragState): boolean {
  const { file, geometry, start } = authority
  return generation(file.revision) && generation(geometry.revision) && generation(geometry.documentRevision) && generation(geometry.layoutGeneration)
    && generation(authority.layoutGeneration) && file.fileId === start.fileId && file.revision === start.fileRevision
    && geometry.revision === start.measurementRevision && geometry.documentRevision === start.documentRevision && start.documentRevision === file.revision
    && geometry.layoutGeneration === start.layoutGeneration && authority.layoutGeneration === start.layoutGeneration
    && state.fence.fileId === start.fileId && state.fence.fileRevision === start.fileRevision
    && state.fence.measurementRevision === start.measurementRevision && state.fence.documentRevision === start.documentRevision
    && state.fence.layoutGeneration === start.layoutGeneration
}

function componentSlot(authority: GestureAuthoritySnapshot, parent: Extract<FileNode, { type: 'component' }>, child: FileNode): FlowDragSourceRelationship['slot'] | null {
  if (child.type !== 'component') return null
  const declarations = authority.atoms.filter(atom => atom.status === 'bound' && atom.componentId === parent.componentId && atom.exportName === parent.exportName)
  if (declarations.length !== 1) return null
  const slots = getNodeSlots(declarations[0]!)
  if (slots.length !== 1 || !acceptsChild(parent, child, slots[0], [...authority.atoms])) return null
  return { presence: 'present', value: slots[0]! }
}

function candidateSlot(authority: GestureAuthoritySnapshot, parent: FileNode, child: FileNode): FlowDragSourceRelationship['slot'] | null {
  if (parent.type === 'frame') return child.type !== 'root' && child.type !== 'component' && acceptsChild(parent, child, undefined, [...authority.atoms]) ? { presence: 'absent' } : null
  if (parent.type === 'component') return componentSlot(authority, parent, child)
  return null
}

function exactSibling(authority: GestureAuthoritySnapshot, nodeId: string, parentId: string, slot: FlowDragSourceRelationship['slot']): FlexReorderSibling | null {
  const { file, geometry, scene } = authority
  const node = file.nodes[nodeId]
  const parent = file.nodes[parentId]
  const relationship = file.relationships[nodeId]
  const measurement = geometry.nodes[nodeId]
  const sceneNode = scene.byId.get(nodeId)
  const slotValue = slot.presence === 'present' ? slot.value : undefined
  if (!node || node.type === 'root' || !parent || !relationship || relationship.parentId !== parentId || !sameSlot(relationship, { parentId, orderKey: relationship.orderKey, slot })) return null
  if (!acceptsChild(parent, node, slotValue, [...authority.atoms]) || nodePositionMode(node) !== 'flow' || nodeIsLocked(file, nodeId)) return null
  if (!measurement || measurement.documentRevision !== file.revision || measurement.layoutGeneration !== authority.layoutGeneration || !positiveRect(measurement.rect)) return null
  if (measurement.directChild !== true || measurement.offsetParentNodeId !== parentId) return null
  if (!sceneNode || !scene.nodes.some(candidate => candidate === sceneNode) || scene.nodes.filter(candidate => candidate.id === nodeId).length !== 1) return null
  if (sceneNode.kind !== node.type || sceneNode.parentId !== parentId || !sceneNode.flow || sceneNode.locked || !sameRect(sceneNode.rect, measurement.rect)) return null
  if (node.type === 'component') {
    if (measurement.componentId !== node.componentId || measurement.parentInstanceId !== parentId || measurement.offsetParentInstanceId !== parentId) return null
  } else if (measurement.canvasKind !== node.type) return null
  return { id: nodeId, kind: node.type, rect: { ...measurement.rect } }
}

function findCandidate(authority: GestureAuthoritySnapshot, selectedId: string, hoveredNodeId: string): string | null {
  const { file } = authority
  if (!file.nodes[hoveredNodeId]) return null
  const selectedTree = new Set([selectedId, ...descendantsOf(file, selectedId)])
  let current: string | undefined = hoveredNodeId
  while (current && selectedTree.has(current)) current = file.relationships[current]?.parentId
  while (current) {
    if (nodeIsLocked(file, current)) return null
    const node = file.nodes[current]
    if (!node) return null
    if ((node.type === 'frame' || node.type === 'component') && node.layout?.container?.display === 'flex') return current
    current = file.relationships[current]?.parentId
  }
  return null
}

/** Resolves one exact, fenced Flex insertion from the post-modifier flow state. */
export function resolveFlowDragTarget(input: ResolveFlowDragTargetInput): FlowDragTarget | null {
  const { authority, state, hoveredNodeId } = input
  if (!validFlowDragState(state) || !currentAuthority(authority, state) || state.kind !== 'paper-flow-drag' || !state.thresholdCrossed || !generation(state.sampleSequence) || state.sampleSequence <= 0) return null
  const pointerWorld = state.currentWorld
  const cameraScale = authority.camera.zoom
  const duplicate = state.clone !== null
  if (!Number.isFinite(cameraScale) || cameraScale <= 0) return null
  const sourceNode = authority.file.nodes[state.nodeId]
  const sourceRelationship = authority.file.relationships[state.nodeId]
  if (!sourceNode || sourceNode.type === 'root' || !sourceRelationship || !sameSourceRelationship(sourceRelationship, state.sourceRelationship)) return null
  const sourceSiblings = exactChildren(authority.file, state.sourceRelationship.parentId, state.sourceRelationship.slot)
  if (sourceSiblings[state.sourceIndex] !== state.nodeId || nodeIsLocked(authority.file, state.nodeId)) return null

  const parentId = findCandidate(authority, state.nodeId, hoveredNodeId)
  if (!parentId || parentId === state.nodeId || descendantsOf(authority.file, state.nodeId).includes(parentId)) return null
  const parent = authority.file.nodes[parentId]
  if (!parent || (parent.type !== 'frame' && parent.type !== 'component')) return null
  const flex = parent.layout?.container?.display === 'flex' ? parent.layout.container.flex : undefined
  if (!flex || !flexDirections.includes(flex.direction) || !flexWraps.includes(flex.wrap)) return null
  const slot = candidateSlot(authority, parent, sourceNode)
  if (!slot) return null
  const siblingIds = exactChildren(authority.file, parentId, slot)
  const siblings: FlexReorderSibling[] = []
  for (const siblingId of siblingIds) {
    const sibling = exactSibling(authority, siblingId, parentId, slot)
    if (!sibling) return null
    siblings.push(sibling)
  }
  const measured = measuredFlexInsertIndex({
    pointer: pointerWorld,
    draggedId: state.nodeId,
    direction: flex.direction,
    wrap: flex.wrap,
    crossAxisTolerance: 8 / cameraScale,
    expected: { measurementRevision: state.fence.measurementRevision, documentRevision: state.fence.documentRevision, layoutGeneration: state.fence.layoutGeneration },
    measurement: { measurementRevision: authority.geometry.revision, documentRevision: authority.geometry.documentRevision!, layoutGeneration: authority.geometry.layoutGeneration!, siblings },
  })
  if (measured.status !== 'ready') return null

  const sameParent = parentId === state.sourceRelationship.parentId
    && (slot.presence === 'absent' ? state.sourceRelationship.slot.presence === 'absent' : state.sourceRelationship.slot.presence === 'present' && state.sourceRelationship.slot.value === slot.value)
  const rawIndex = measured.target.index
  const semanticIndex = sameParent && !duplicate && rawIndex > state.sourceIndex ? rawIndex - 1 : rawIndex
  return deepFreeze({
    parentId,
    slotPresence: slot.presence,
    slotValue: slot.presence === 'present' ? slot.value : null,
    rawIndex,
    semanticIndex,
    line: measured.target.line,
    guideWorld: measured.target.guide ? { ...measured.target.guide } : null,
    fence: { ...state.fence, gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence },
  })
}
