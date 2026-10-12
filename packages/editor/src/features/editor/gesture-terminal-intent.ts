import { acceptsChild, childrenOf, nodeIsLocked, nodePositionMode, pageOfNode } from '@canvas/repo-engine/file-document'
import { flexDirections, flexWraps } from '@canvas/repo-engine/layout'
import type { Point, Rect } from './canvas-math'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { GestureFinalIntent } from './gesture-command-planner'
import { measuredFlexInsertIndex } from './flex-reorder'
import type { FlexInsertTarget, FlexReorderSibling } from './flex-reorder'
import { validFlowDragState } from './flow-drag-state'
import type { FlowDragState, FlowDragTarget, PaperFlowDragState } from './flow-drag-state'
import { paperFlowAbsoluteDropGeometry, paperFlowCrossParentAbsoluteDropGeometry } from './layout-measure'
import { resolveFlowDragTarget } from './flow-drag-target'

export type GestureTerminalIntentInput = Readonly<{
  authority: GestureAuthoritySnapshot
  nodeId: string
  pointerDownWorld: Readonly<Point>
  terminalWorld: Readonly<Point>
  dragState: FlowDragState
}>

export type PaperFlowTerminalIntentInput = Readonly<{
  authority: GestureAuthoritySnapshot
  state: PaperFlowDragState
}>

export type GestureTerminalIntentResult = Readonly<{
  intent: GestureFinalIntent
  insertionTarget: Readonly<FlexInsertTarget> | null
}>

const finitePoint = (point: Readonly<Point>): boolean => Number.isFinite(point.x) && Number.isFinite(point.y)
const samePoint = (left: Readonly<Point>, right: Readonly<Point>): boolean => left.x === right.x && left.y === right.y
const positiveRect = (rect: Readonly<Rect>): boolean => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
const sameRect = (left: Readonly<Rect>, right: Readonly<Rect>): boolean => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
const generation = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord), rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]))
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

const relationshipSlot = (target: FlowDragTarget): { slot?: string } => target.slotPresence === 'present' ? { slot: target.slotValue! } : {}

function currentAuthority(authority: GestureAuthoritySnapshot): boolean {
  const { file, geometry, start } = authority
  return generation(file.revision)
    && generation(geometry.revision)
    && generation(geometry.documentRevision)
    && generation(geometry.layoutGeneration)
    && generation(authority.layoutGeneration)
    && file.fileId === start.fileId
    && file.revision === start.fileRevision
    && geometry.revision === start.measurementRevision
    && geometry.documentRevision === start.documentRevision
    && start.documentRevision === file.revision
    && geometry.layoutGeneration === start.layoutGeneration
    && authority.layoutGeneration === start.layoutGeneration
}

function exactSibling(authority: GestureAuthoritySnapshot, nodeId: string, parentId: string, slot: string | undefined): FlexReorderSibling | null {
  const { file, geometry, scene } = authority
  const node = file.nodes[nodeId]
  const parent = file.nodes[parentId]
  const relationship = file.relationships[nodeId]
  const measurement = geometry.nodes[nodeId]
  const sceneNode = scene.byId.get(nodeId)
  if (!node || node.type === 'root' || !parent || !relationship || relationship.parentId !== parentId || relationship.slot !== slot) return null
  if (!acceptsChild(parent, node, slot, [...authority.atoms])) return null
  if (nodePositionMode(node) !== 'flow' || nodeIsLocked(file, nodeId)) return null
  if (!measurement || measurement.documentRevision !== file.revision || measurement.layoutGeneration !== authority.layoutGeneration) return null
  if (measurement.directChild !== true || measurement.offsetParentNodeId !== parentId || !positiveRect(measurement.rect)) return null
  if (!sceneNode || !scene.nodes.some(candidate => candidate === sceneNode) || scene.nodes.filter(candidate => candidate.id === nodeId).length !== 1) return null
  if (sceneNode.kind !== node.type || sceneNode.parentId !== parentId || !sceneNode.flow || sceneNode.locked || !sameRect(sceneNode.rect, measurement.rect)) return null
  if (node.type === 'component') {
    if (measurement.componentId !== node.componentId || measurement.parentInstanceId !== parentId || measurement.offsetParentInstanceId !== parentId) return null
  } else if (measurement.canvasKind !== node.type) return null
  return { id: nodeId, kind: node.type, rect: { ...measurement.rect } }
}

function placement(parentId: string, slot: string | undefined, index: number) {
  return Object.freeze({ parentId, ...(slot !== undefined ? { slot } : {}), index })
}

function frozenTarget(target: FlexInsertTarget): Readonly<FlexInsertTarget> {
  return Object.freeze({ ...target, guide: target.guide ? Object.freeze({ ...target.guide }) : null })
}

function result(intent: GestureFinalIntent, insertionTarget: FlexInsertTarget | null): GestureTerminalIntentResult {
  return Object.freeze({ intent: Object.freeze(intent), insertionTarget: insertionTarget ? frozenTarget(insertionTarget) : null })
}

function absoluteRect(authority: GestureAuthoritySnapshot, nodeId: string, parentId: string, pointerDownWorld: Readonly<Point>, terminalWorld: Readonly<Point>) {
  const rect = paperFlowAbsoluteDropGeometry({
    file: authority.file,
    scene: authority.scene,
    geometry: authority.geometry,
    fence: authority.start,
    childId: nodeId,
    parentId,
    pointerDownWorld,
    terminalWorld,
  })
  return rect ? Object.freeze({ ...rect }) : null
}

/** Closes the reviewed Paper flow state into one exact terminal intent without allocating identities or mutating input. */
export function derivePaperFlowTerminalIntent(input: PaperFlowTerminalIntentInput): Extract<GestureFinalIntent, { kind: 'paper-flow-terminal' }> | null {
  const { authority, state } = input
  if (!currentAuthority(authority) || !validFlowDragState(state) || state.kind !== 'paper-flow-drag' || !state.thresholdCrossed || !state.target) return null
  if (authority.selection.length !== 1 || authority.selection[0] !== state.nodeId || state.selection[0] !== state.nodeId) return null
  if (pageOfNode(authority.file, state.nodeId) !== authority.pageId || pageOfNode(authority.file, state.target.parentId) !== authority.pageId) return null
  if (state.fence.fileId !== authority.start.fileId || state.fence.fileRevision !== authority.start.fileRevision
    || state.fence.measurementRevision !== authority.start.measurementRevision || state.fence.documentRevision !== authority.start.documentRevision
    || state.fence.layoutGeneration !== authority.start.layoutGeneration) return null
  const relationship = authority.file.relationships[state.nodeId]
  if (!relationship) return null
  const exactSource = {
    parentId: relationship.parentId,
    orderKey: relationship.orderKey,
    slot: Object.hasOwn(relationship, 'slot') ? { presence: 'present' as const, value: relationship.slot! } : { presence: 'absent' as const },
  }
  if (!sameValue(exactSource, state.sourceRelationship)) return null
  const sourceSiblings = childrenOf(authority.file, relationship.parentId, relationship.slot)
  if (sourceSiblings[state.sourceIndex] !== state.nodeId) return null
  const resolved = resolveFlowDragTarget({ authority, state, hoveredNodeId: state.target.parentId })
  if (!resolved || !sameValue(resolved, state.target)) return null
  if (!state.clone && state.originalMode === 'flow' && state.target.parentId === relationship.parentId
    && state.target.slotPresence === state.sourceRelationship.slot.presence
    && (state.target.slotPresence === 'absent' || state.sourceRelationship.slot.presence === 'present' && state.target.slotValue === state.sourceRelationship.slot.value)
    && state.target.semanticIndex === state.sourceIndex) return null

  const targetSlot = relationshipSlot(state.target)
  const terminalRect = state.originalMode === 'absolute'
    ? state.target.parentId === relationship.parentId
      ? paperFlowAbsoluteDropGeometry({ file: authority.file, scene: authority.scene, geometry: authority.geometry, fence: authority.start,
        childId: state.nodeId, parentId: relationship.parentId, pointerDownWorld: state.pointerDownWorld, terminalWorld: state.currentWorld })
      : paperFlowCrossParentAbsoluteDropGeometry({ snapshot: authority, childId: state.nodeId, targetParentId: state.target.parentId,
        ...targetSlot, pointerDownWorld: state.pointerDownWorld, terminalWorld: state.currentWorld })
    : null
  if (state.originalMode === 'absolute' && !terminalRect) return null

  let clone: Extract<GestureFinalIntent, { kind: 'paper-flow-terminal' }>['clone'] = null
  if (state.clone) {
    if (!sameValue(state.clone.sourceRelationship, state.sourceRelationship) || state.clone.sourceIndex !== state.sourceIndex) return null
    let entryRect = null
    if (state.clone.entryMode === 'absolute') {
      const derived = paperFlowAbsoluteDropGeometry({ file: authority.file, scene: authority.scene, geometry: authority.geometry, fence: authority.start,
        childId: state.nodeId, parentId: relationship.parentId, pointerDownWorld: state.pointerDownWorld, terminalWorld: state.clone.startedAtWorld })
      if (!derived || !state.clone.entryGeometry || !sameRect(derived, state.clone.entryGeometry)) return null
      entryRect = derived
    }
    clone = { generation: state.clone.generation, mode: state.clone.entryMode, rect: entryRect }
  }
  return deepFreeze({
    kind: 'paper-flow-terminal' as const,
    nodeId: state.nodeId,
    selection: [state.nodeId] as const,
    sourceRelationship: structuredClone(state.sourceRelationship),
    sourceIndex: state.sourceIndex,
    target: structuredClone(state.target),
    mode: state.originalMode,
    rect: terminalRect ? { ...terminalRect } : null,
    clone,
    state: structuredClone(state),
  })
}

/** Derives one terminal semantic intent from one pointer-down authority and one final pointer sample. */
export function deriveGestureTerminalIntent(input: GestureTerminalIntentInput): GestureTerminalIntentResult | null {
  const { authority, nodeId, pointerDownWorld, terminalWorld, dragState } = input
  if (!currentAuthority(authority) || !finitePoint(pointerDownWorld) || !finitePoint(terminalWorld)) return null
  if (!dragState || !validFlowDragState(dragState) || dragState.nodeId !== nodeId) return null
  if (!samePoint(dragState.pointerDownWorld, pointerDownWorld) || !samePoint(dragState.currentWorld, terminalWorld)) return null

  const { file } = authority
  const node = file.nodes[nodeId]
  const relationship = file.relationships[nodeId]
  const parent = relationship ? file.nodes[relationship.parentId] : undefined
  if (!node || node.type === 'root' || !relationship || !parent || (parent.type !== 'frame' && parent.type !== 'component')) return null
  if (!acceptsChild(parent, node, relationship.slot, [...authority.atoms]) || nodePositionMode(node) !== 'flow') return null
  if (nodeIsLocked(file, nodeId) || nodeIsLocked(file, relationship.parentId)) return null
  const flex = parent.layout?.container?.display === 'flex' ? parent.layout.container.flex : undefined
  if (!flex || !flexDirections.includes(flex.direction) || !flexWraps.includes(flex.wrap)) return null

  const siblingIds = childrenOf(file, relationship.parentId, relationship.slot)
  if (!siblingIds.includes(nodeId) || siblingIds.length === 0) return null
  const siblings: FlexReorderSibling[] = []
  for (const siblingId of siblingIds) {
    const sibling = exactSibling(authority, siblingId, relationship.parentId, relationship.slot)
    if (!sibling) return null
    siblings.push(sibling)
  }

  const sourceIndex = siblingIds.indexOf(nodeId)
  const target = () => measuredFlexInsertIndex({
    pointer: terminalWorld,
    draggedId: nodeId,
    direction: flex.direction,
    wrap: flex.wrap,
    expected: {
      measurementRevision: authority.start.measurementRevision,
      documentRevision: authority.start.documentRevision,
      layoutGeneration: authority.start.layoutGeneration,
    },
    measurement: {
      measurementRevision: authority.geometry.revision,
      documentRevision: authority.geometry.documentRevision as number,
      layoutGeneration: authority.geometry.layoutGeneration as number,
      siblings,
    },
  })

  if (!dragState.clone) {
    if (dragState.originalMode === 'absolute') {
      const rect = absoluteRect(authority, nodeId, relationship.parentId, pointerDownWorld, terminalWorld)
      return rect ? result({ kind: 'absolute-drop', nodeId, parentId: relationship.parentId, rect }, null) : null
    }
    const measured = target()
    if (measured.status !== 'ready') return null
    const finalIndex = measured.target.index > sourceIndex ? measured.target.index - 1 : measured.target.index
    if (finalIndex === sourceIndex || finalIndex < 0 || finalIndex >= siblingIds.length) return null
    return result({ kind: 'reorder', nodeId, placement: placement(relationship.parentId, relationship.slot, finalIndex) }, measured.target)
  }

  const clone = dragState.clone.mode === 'flow'
    ? Object.freeze({ mode: 'flow' as const })
    : (() => {
      const rect = absoluteRect(authority, nodeId, relationship.parentId, pointerDownWorld, dragState.clone!.startedAtWorld)
      return rect ? Object.freeze({ mode: 'absolute' as const, rect }) : null
    })()
  if (!clone) return null
  const sourcePlacement = placement(relationship.parentId, relationship.slot, sourceIndex)
  if (dragState.originalMode === 'absolute') {
    const rect = absoluteRect(authority, nodeId, relationship.parentId, pointerDownWorld, terminalWorld)
    if (!rect) return null
    return result({
      kind: 'clone-source-and-move-original',
      nodeId,
      sourcePlacement,
      clone,
      original: Object.freeze({ mode: 'absolute' as const, parentId: relationship.parentId, rect }),
    }, null)
  }
  const measured = target()
  if (measured.status !== 'ready') return null
  return result({
    kind: 'clone-source-and-move-original',
    nodeId,
    sourcePlacement,
    clone,
    original: Object.freeze({ mode: 'flow' as const, placement: placement(relationship.parentId, relationship.slot, measured.target.index) }),
  }, measured.target)
}
