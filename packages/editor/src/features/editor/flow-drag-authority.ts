import { childrenOf, descendantsOf, nodeIsLocked, nodePositionMode, pageOfNode, pageRoot } from '@canvas/repo-engine/file-document'
import { apply, identity, invert, localMatrix, multiply, translation } from '@canvas/repo-engine/layout-matrix'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import { validId } from '@canvas/repo-engine/document'
import type { FlowDragPresentationRetention } from '@canvas/sync-protocol/flow'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { MeasuredNode } from './scene-geometry'
import { validFlowDragState } from './flow-drag-state'
import type { FlowDragFence, PaperFlowDragState } from './flow-drag-state'
import { flowDragPresentationContract } from './flow-drag-presentation'
import type { FlowDragPresentationAuthority, FlowDragWorldGeometry } from './flow-drag-presentation'
import { resolveFlowDragTarget } from './flow-drag-target'

export type FlowDragAuthorityMeasurementFence = FlowDragFence & Readonly<{
  pageId: string
  pageRootId: string
}>

export type FlowDragAuthorityMeasurementProof = Readonly<{
  fence: FlowDragAuthorityMeasurementFence
  nodeId: string
  source: FlowDragWorldGeometry
  current: FlowDragWorldGeometry
  sourceOffsetParent: Readonly<{
    offsetParentNodeId: string | null
    paddingToWorld: Matrix
    sourceParentLocal: Matrix
  }>
  currentParentLocal: Matrix | null
  clone: Readonly<{
    role: 'inert-marker'
    layoutParticipation: 'none'
    generation: number
    entryMode: 'flow' | 'absolute'
    entryRect: Readonly<{ coordinateSpace: 'parent-padding'; x: number; y: number; width: number; height: number }> | null
    world: FlowDragWorldGeometry
  }> | null
  target: Readonly<{
    parentId: string
    outline: FlowDragWorldGeometry | null
    insertionGuide: Readonly<{ axis: 'x' | 'y'; position: number; start: number; end: number }> | null
  }> | null
}>

export type BuildFlowDragPresentationAuthorityInput = Readonly<{
  snapshot: GestureAuthoritySnapshot
  state: PaperFlowDragState
  interactionId: string
  retention: FlowDragPresentationRetention
  reducedMotion: boolean
  measurement: FlowDragAuthorityMeasurementProof
}>

const INPUT_KEYS = ['snapshot', 'state', 'interactionId', 'retention', 'reducedMotion', 'measurement'] as const
const SNAPSHOT_KEYS = ['file', 'atoms', 'scene', 'geometry', 'layoutGeneration', 'start', 'pageId', 'camera', 'size', 'selection'] as const
const MEASUREMENT_KEYS = ['fence', 'nodeId', 'source', 'current', 'sourceOffsetParent', 'currentParentLocal', 'clone', 'target'] as const
const MEASUREMENT_FENCE_KEYS = ['fileId', 'fileRevision', 'measurementRevision', 'documentRevision', 'layoutGeneration', 'pageId', 'pageRootId'] as const
const SOURCE_PARENT_KEYS = ['offsetParentNodeId', 'paddingToWorld', 'sourceParentLocal'] as const
const CLONE_KEYS = ['role', 'layoutParticipation', 'generation', 'entryMode', 'entryRect', 'world'] as const
const ENTRY_RECT_KEYS = ['coordinateSpace', 'x', 'y', 'width', 'height'] as const
const TARGET_KEYS = ['parentId', 'outline', 'insertionGuide'] as const
const GUIDE_KEYS = ['axis', 'position', 'start', 'end'] as const
const GEOMETRY_KEYS = ['coordinateSpace', 'quad', 'aabb', 'semanticSize'] as const
const RECT_KEYS = ['x', 'y', 'width', 'height'] as const
const SIZE_KEYS = ['width', 'height'] as const
const POINT_KEYS = ['x', 'y'] as const
const ACTIVE_RETENTION_KEYS = ['kind', 'gestureGeneration', 'sampleSequence'] as const
const TERMINAL_RETENTION_KEYS = ['kind', 'gestureGeneration', 'sampleSequence', 'terminalReason', 'terminalSampleSequence', 'holdUntil'] as const
const STATE_KEYS = ['kind', 'nodeId', 'selection', 'selectionDepthPrimary', 'sourceRelationship', 'sourceIndex', 'pointerDownWorld', 'currentWorld',
  'pointerDownViewport', 'currentViewport', 'pointerDownTime', 'currentTime', 'originalMode', 'altActive', 'primaryActive', 'thresholdCrossed',
  'gestureGeneration', 'cloneGeneration', 'clone', 'target', 'sampleSequence', 'fence'] as const
const STATE_RELATIONSHIP_KEYS = ['parentId', 'orderKey', 'slot'] as const
const STATE_CLONE_KEYS = ['generation', 'entryMode', 'entryGeometry', 'sourceRelationship', 'sourceIndex', 'startedAtWorld'] as const
const STATE_TARGET_KEYS = ['parentId', 'slotPresence', 'slotValue', 'rawIndex', 'semanticIndex', 'line', 'guideWorld', 'fence'] as const
const STATE_FENCE_KEYS = ['fileId', 'fileRevision', 'measurementRevision', 'documentRevision', 'layoutGeneration'] as const
const STATE_TARGET_FENCE_KEYS = [...STATE_FENCE_KEYS, 'gestureGeneration', 'sampleSequence'] as const

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const equal = (left: number, right: number): boolean => Object.is(left, right) || left === right

function exactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every(key => {
    if (typeof key !== 'string' || !keys.includes(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  })
}

function safeDataGraph(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return true
  if (typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype === Map.prototype) {
    if (Reflect.ownKeys(value).length !== 0) return false
    for (const [key, entry] of Map.prototype.entries.call(value) as IterableIterator<[unknown, unknown]>) {
      if (!safeDataGraph(key, seen) || !safeDataGraph(entry, seen)) return false
    }
    return true
  }
  const array = Array.isArray(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return false
    if (array && key === 'length') {
      if (descriptor.enumerable || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return false
      continue
    }
    if (typeof key !== 'string' || !descriptor.enumerable || !safeDataGraph(descriptor.value, seen)) return false
  }
  return true
}

function exactArray(value: unknown, length: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1 || !keys.includes('length')) return false
  return Array.from({ length }, (_, index) => String(index)).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  })
}

function validMatrix(value: unknown): value is Matrix {
  if (!exactArray(value, 6) || !value.every(finite)) return false
  return invert(value as Matrix) !== null
}

function validPoint(value: unknown): value is Readonly<{ x: number; y: number }> {
  return exactOwnKeys(value, POINT_KEYS) && finite(value.x) && finite(value.y)
}

function validRect(value: unknown): value is Readonly<{ x: number; y: number; width: number; height: number }> {
  return exactOwnKeys(value, RECT_KEYS) && finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0
}

function validSize(value: unknown): value is Readonly<{ width: number; height: number }> {
  return exactOwnKeys(value, SIZE_KEYS) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0
}

function validGuide(value: unknown): value is Readonly<{ axis: 'x' | 'y'; position: number; start: number; end: number }> {
  return exactOwnKeys(value, GUIDE_KEYS) && (value.axis === 'x' || value.axis === 'y') && finite(value.position) && finite(value.start) && finite(value.end)
}

function geometryAabb(quad: readonly Readonly<{ x: number; y: number }>[]) {
  const xs = quad.map(point => point.x)
  const ys = quad.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys)
  return { x, y, width: right - x, height: bottom - y }
}

function validGeometry(value: unknown): value is FlowDragWorldGeometry {
  if (!exactOwnKeys(value, GEOMETRY_KEYS) || value.coordinateSpace !== 'world' || !exactArray(value.quad, 4)
    || !value.quad.every(validPoint) || !validRect(value.aabb) || !validSize(value.semanticSize)) return false
  const [q0, q1, q2, q3] = value.quad
  if (!q0 || !q1 || !q2 || !q3 || !equal(q2.x, q1.x + q3.x - q0.x) || !equal(q2.y, q1.y + q3.y - q0.y)) return false
  const determinant = (q1.x - q0.x) * (q3.y - q0.y) - (q1.y - q0.y) * (q3.x - q0.x)
  if (!finite(determinant) || Math.abs(determinant) < 1e-12) return false
  const aabb = geometryAabb(value.quad)
  return equal(aabb.x, value.aabb.x) && equal(aabb.y, value.aabb.y) && equal(aabb.width, value.aabb.width) && equal(aabb.height, value.aabb.height)
}

function samePoint(left: Readonly<{ x: number; y: number }>, right: Readonly<{ x: number; y: number }>) {
  return equal(left.x, right.x) && equal(left.y, right.y)
}

function sameRect(left: Readonly<{ x: number; y: number; width: number; height: number }>, right: Readonly<{ x: number; y: number; width: number; height: number }>) {
  return equal(left.x, right.x) && equal(left.y, right.y) && equal(left.width, right.width) && equal(left.height, right.height)
}

function sameGuide(left: Readonly<{ axis: 'x' | 'y'; position: number; start: number; end: number }> | null,
  right: Readonly<{ axis: 'x' | 'y'; position: number; start: number; end: number }> | null) {
  return left === null ? right === null : right !== null && left.axis === right.axis && equal(left.position, right.position)
    && equal(left.start, right.start) && equal(left.end, right.end)
}

function sameGeometry(left: FlowDragWorldGeometry, right: FlowDragWorldGeometry) {
  return left.quad.every((point, index) => samePoint(point, right.quad[index]!)) && sameRect(left.aabb, right.aabb)
    && equal(left.semanticSize.width, right.semanticSize.width) && equal(left.semanticSize.height, right.semanticSize.height)
}

function sameMatrix(left: readonly number[], right: readonly number[]) {
  return left.length === 6 && right.length === 6 && left.every((value, index) => equal(value, right[index]!))
}

function matrixGeometry(matrix: Matrix, semanticSize: Readonly<{ width: number; height: number }>): FlowDragWorldGeometry {
  const quad = [apply(matrix, { x: 0, y: 0 }), apply(matrix, { x: semanticSize.width, y: 0 }),
    apply(matrix, { x: semanticSize.width, y: semanticSize.height }), apply(matrix, { x: 0, y: semanticSize.height })] as const
  return { coordinateSpace: 'world', quad, aabb: geometryAabb(quad), semanticSize: { ...semanticSize } }
}

function measuredGeometry(measurement: MeasuredNode): Readonly<{ geometry: FlowDragWorldGeometry; parentToWorld: Matrix; parentLocal: Matrix }> | null {
  const offset = measurement.offset
  const parentToWorld = measurement.offsetParentToRoot
  const transform = measurement.transform ?? identity
  if (!offset || !exactOwnKeys(offset, ['x', 'y', 'width', 'height', 'origin']) || !validPoint(offset.origin)
    || !finite(offset.x) || !finite(offset.y) || !finite(offset.width) || !finite(offset.height) || offset.width <= 0 || offset.height <= 0
    || !validMatrix(parentToWorld) || !validMatrix(transform)) return null
  const parentLocal = localMatrix({ x: offset.x, y: offset.y }, transform, offset.origin)
  if (!validMatrix(parentLocal)) return null
  const geometry = matrixGeometry(multiply(parentToWorld, parentLocal), { width: offset.width, height: offset.height })
  if (!measurement.worldAabb || !validRect(measurement.worldAabb) || !sameRect(measurement.worldAabb, geometry.aabb)) return null
  return { geometry, parentToWorld, parentLocal }
}

function translatedGeometry(source: FlowDragWorldGeometry, x: number, y: number): FlowDragWorldGeometry {
  return {
    coordinateSpace: 'world',
    quad: source.quad.map(point => ({ x: point.x + x, y: point.y + y })) as unknown as FlowDragWorldGeometry['quad'],
    aabb: { x: source.aabb.x + x, y: source.aabb.y + y, width: source.aabb.width, height: source.aabb.height },
    semanticSize: { ...source.semanticSize },
  }
}

function validStateShape(state: unknown): state is PaperFlowDragState {
  if (!exactOwnKeys(state, STATE_KEYS) || !exactArray(state.selection, 1) || !exactOwnKeys(state.sourceRelationship, STATE_RELATIONSHIP_KEYS)) return false
  const slotKeys = state.sourceRelationship.slot && typeof state.sourceRelationship.slot === 'object'
    && Object.getOwnPropertyDescriptor(state.sourceRelationship.slot, 'presence')?.value === 'present' ? ['presence', 'value'] : ['presence']
  if (!exactOwnKeys(state.sourceRelationship.slot, slotKeys) || !validPoint(state.pointerDownWorld) || !validPoint(state.currentWorld)
    || !validPoint(state.pointerDownViewport) || !validPoint(state.currentViewport)) return false
  if (!exactOwnKeys(state.fence, STATE_FENCE_KEYS)) return false
  if (state.clone !== null && (!exactOwnKeys(state.clone, STATE_CLONE_KEYS) || !validPoint(state.clone.startedAtWorld)
    || !exactOwnKeys(state.clone.sourceRelationship, STATE_RELATIONSHIP_KEYS)
    || !exactOwnKeys(state.clone.sourceRelationship.slot, state.clone.sourceRelationship.slot
      && Object.getOwnPropertyDescriptor(state.clone.sourceRelationship.slot, 'presence')?.value === 'present' ? ['presence', 'value'] : ['presence'])
    || state.clone.entryGeometry !== null && !validRect(state.clone.entryGeometry))) return false
  if (state.target !== null && (!exactOwnKeys(state.target, STATE_TARGET_KEYS)
    || !exactOwnKeys(state.target.fence, STATE_TARGET_FENCE_KEYS)
    || state.target.guideWorld !== null && !validGuide(state.target.guideWorld))) return false
  return validFlowDragState(state as unknown as PaperFlowDragState)
}

function validRetention(retention: unknown, state: PaperFlowDragState): retention is FlowDragPresentationRetention {
  if (retention && typeof retention === 'object' && Object.getOwnPropertyDescriptor(retention, 'kind')?.value === 'active') {
    return exactOwnKeys(retention, ACTIVE_RETENTION_KEYS) && retention.gestureGeneration === state.gestureGeneration && retention.sampleSequence === state.sampleSequence
  }
  return exactOwnKeys(retention, TERMINAL_RETENTION_KEYS) && retention.kind === 'terminal-retained'
    && retention.gestureGeneration === state.gestureGeneration && retention.sampleSequence === state.sampleSequence
    && retention.terminalSampleSequence === state.sampleSequence && retention.holdUntil === 'authoritative-geometry'
    && (retention.terminalReason === 'pointer-up' || retention.terminalReason === 'escape-after-threshold' || retention.terminalReason === 'pointercancel-after-threshold')
}

function sameFence(left: FlowDragFence, right: FlowDragFence) {
  return left.fileId === right.fileId && left.fileRevision === right.fileRevision && left.measurementRevision === right.measurementRevision
    && left.documentRevision === right.documentRevision && left.layoutGeneration === right.layoutGeneration
}

function validMeasurementShape(value: unknown): value is FlowDragAuthorityMeasurementProof {
  if (!exactOwnKeys(value, MEASUREMENT_KEYS) || !exactOwnKeys(value.fence, MEASUREMENT_FENCE_KEYS) || !validGeometry(value.source)
    || !validGeometry(value.current) || !exactOwnKeys(value.sourceOffsetParent, SOURCE_PARENT_KEYS)
    || !validMatrix(value.sourceOffsetParent.paddingToWorld) || !validMatrix(value.sourceOffsetParent.sourceParentLocal)
    || value.currentParentLocal !== null && !validMatrix(value.currentParentLocal)) return false
  if (value.clone !== null && (!exactOwnKeys(value.clone, CLONE_KEYS) || value.clone.role !== 'inert-marker' || value.clone.layoutParticipation !== 'none'
    || !generation(value.clone.generation) || value.clone.entryMode !== 'flow' && value.clone.entryMode !== 'absolute'
    || value.clone.entryRect !== null && (!exactOwnKeys(value.clone.entryRect, ENTRY_RECT_KEYS) || value.clone.entryRect.coordinateSpace !== 'parent-padding'
      || !validRect({ x: value.clone.entryRect.x, y: value.clone.entryRect.y, width: value.clone.entryRect.width, height: value.clone.entryRect.height }))
    || !validGeometry(value.clone.world))) return false
  if (value.target !== null && (!exactOwnKeys(value.target, TARGET_KEYS) || !validId(value.target.parentId)
    || value.target.outline !== null && !validGeometry(value.target.outline)
    || value.target.insertionGuide !== null && !validGuide(value.target.insertionGuide))) return false
  return true
}

function clone<T>(value: T): T { return structuredClone(value) }
function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true
  if (!Object.isFrozen(value)) return false
  seen.add(value)
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && 'value' in descriptor && deeplyFrozen(descriptor.value, seen))
  })
}
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) freeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function validSceneIndex(snapshot: GestureAuthoritySnapshot): boolean {
  if (snapshot.scene.byId.size !== snapshot.scene.nodes.length) return false
  const seen = new Set<string>()
  for (const node of snapshot.scene.nodes) {
    if (seen.has(node.id) || Map.prototype.get.call(snapshot.scene.byId, node.id) !== node) return false
    seen.add(node.id)
  }
  for (const key of Map.prototype.keys.call(snapshot.scene.byId) as IterableIterator<unknown>) {
    if (typeof key !== 'string' || !seen.has(key)) return false
  }
  return true
}

function validMeasuredTopology(snapshot: GestureAuthoritySnapshot, nodeId: string, measurement: MeasuredNode,
  sceneNode: GestureAuthoritySnapshot['scene']['nodes'][number], rootId: string): boolean {
  const node = snapshot.file.nodes[nodeId]
  const relationship = snapshot.file.relationships[nodeId]
  if (!node || node.type === 'root' || !relationship || sceneNode.id !== nodeId || measurement.directChild !== true
    || measurement.documentRevision !== snapshot.start.documentRevision
    || measurement.layoutGeneration !== snapshot.start.layoutGeneration) return false
  const parent = snapshot.file.nodes[relationship.parentId]
  if (!parent) return false
  const expectedOffsetParentNodeId = relationship.parentId === rootId ? null : relationship.parentId
  if (measurement.offsetParentNodeId !== expectedOffsetParentNodeId || sceneNode.parentId !== expectedOffsetParentNodeId
    || sceneNode.kind !== node.type) return false
  if (node.type === 'component') {
    const expectedParentInstanceId = parent.type === 'component' ? parent.id : null
    return measurement.componentId === node.componentId && measurement.parentInstanceId === expectedParentInstanceId
  }
  return measurement.canvasKind === node.type
}

/** Derives the complete presentation proof from the same frozen authority used by targeting and terminal planning. */
export function captureFlowDragAuthorityMeasurement(snapshot: GestureAuthoritySnapshot, state: PaperFlowDragState): FlowDragAuthorityMeasurementProof | null {
  if (!validStateShape(state) || !Object.isFrozen(snapshot) || snapshot.selection.length !== 1 || snapshot.selection[0] !== state.nodeId) return null
  const rootId = pageRoot(snapshot.file, snapshot.pageId)
  const sourceMeasurement = snapshot.geometry.nodes[state.nodeId]
  const sourceScene = snapshot.scene.byId.get(state.nodeId)
  if (!rootId || !sourceMeasurement || !sourceScene || !validMeasuredTopology(snapshot, state.nodeId, sourceMeasurement, sourceScene, rootId)) return null
  const source = measuredGeometry(sourceMeasurement)
  if (!source) return null
  const delta = { x: state.currentWorld.x - state.pointerDownWorld.x, y: state.currentWorld.y - state.pointerDownWorld.y }
  const current = translatedGeometry(source.geometry, delta.x, delta.y)
  let currentParentLocal: Matrix | null = null
  if (state.originalMode === 'absolute') {
    const worldToParent = invert(source.parentToWorld)
    if (!worldToParent) return null
    currentParentLocal = multiply(worldToParent, multiply(translation(delta.x, delta.y), multiply(source.parentToWorld, source.parentLocal)))
  }
  const cloneProof = state.clone ? {
    role: 'inert-marker' as const,
    layoutParticipation: 'none' as const,
    generation: state.clone.generation,
    entryMode: state.clone.entryMode,
    entryRect: state.clone.entryGeometry ? { coordinateSpace: 'parent-padding' as const, ...state.clone.entryGeometry } : null,
    world: state.clone.entryMode === 'flow'
      ? clone(source.geometry)
      : translatedGeometry(source.geometry, state.clone.startedAtWorld.x - state.pointerDownWorld.x, state.clone.startedAtWorld.y - state.pointerDownWorld.y),
  } : null
  let targetProof: FlowDragAuthorityMeasurementProof['target'] = null
  if (state.target) {
    const targetMeasurement = snapshot.geometry.nodes[state.target.parentId]
    const targetScene = snapshot.scene.byId.get(state.target.parentId)
    if (!targetMeasurement || !targetScene || !validMeasuredTopology(snapshot, state.target.parentId, targetMeasurement, targetScene, rootId)) return null
    const target = measuredGeometry(targetMeasurement)
    if (!target) return null
    targetProof = { parentId: state.target.parentId, outline: target.geometry, insertionGuide: state.target.guideWorld ? { ...state.target.guideWorld } : null }
  }
  return freeze({
    fence: { ...state.fence, pageId: snapshot.pageId, pageRootId: rootId },
    nodeId: state.nodeId,
    source: clone(source.geometry),
    current,
    sourceOffsetParent: { offsetParentNodeId: sourceMeasurement.offsetParentNodeId ?? null, paddingToWorld: clone(source.parentToWorld), sourceParentLocal: clone(source.parentLocal) },
    currentParentLocal,
    clone: cloneProof,
    target: targetProof,
  })
}

/** Builds the peer-safe flow presentation authority from one pointer-down snapshot and one fenced geometry proof. */
export function buildFlowDragPresentationAuthority(input: BuildFlowDragPresentationAuthorityInput): FlowDragPresentationAuthority | null {
  if (!safeDataGraph(input) || !exactOwnKeys(input, INPUT_KEYS)) return null
  const { snapshot, state, measurement } = input
  if (!exactOwnKeys(snapshot, SNAPSHOT_KEYS) || !Object.isFrozen(snapshot) || !validStateShape(state) || !deeplyFrozen(state)
    || !validId(input.interactionId) || typeof input.reducedMotion !== 'boolean' || !validRetention(input.retention, state)
    || !validMeasurementShape(measurement) || !validSceneIndex(snapshot)) return null

  const rootId = pageRoot(snapshot.file, snapshot.pageId)
  if (!rootId || measurement.fence.pageId !== snapshot.pageId || measurement.fence.pageRootId !== rootId
    || snapshot.pageId !== measurement.fence.pageId || snapshot.file.fileId !== state.fence.fileId || snapshot.file.revision !== state.fence.fileRevision
    || snapshot.start.fileId !== state.fence.fileId || snapshot.start.fileRevision !== state.fence.fileRevision
    || snapshot.start.measurementRevision !== state.fence.measurementRevision || snapshot.start.documentRevision !== state.fence.documentRevision
    || snapshot.start.layoutGeneration !== state.fence.layoutGeneration || snapshot.layoutGeneration !== state.fence.layoutGeneration
    || snapshot.geometry.revision !== state.fence.measurementRevision || snapshot.geometry.documentRevision !== state.fence.documentRevision
    || snapshot.geometry.layoutGeneration !== state.fence.layoutGeneration || !sameFence(measurement.fence, state.fence)) return null
  if (measurement.nodeId !== state.nodeId || snapshot.selection.length !== 1 || snapshot.selection[0] !== state.nodeId || state.selection[0] !== state.nodeId) return null

  const node = snapshot.file.nodes[state.nodeId]
  const relationship = snapshot.file.relationships[state.nodeId]
  const sceneNode = snapshot.scene.nodes.find(candidate => candidate.id === state.nodeId)
  const nodeMeasurement = snapshot.geometry.nodes[state.nodeId]
  if (!node || node.type === 'root' || !relationship || !sceneNode || !nodeMeasurement || nodeIsLocked(snapshot.file, state.nodeId)
    || nodeIsLocked(snapshot.file, relationship.parentId) || pageOfNode(snapshot.file, state.nodeId) !== snapshot.pageId
    || relationship.parentId !== state.sourceRelationship.parentId || relationship.orderKey !== state.sourceRelationship.orderKey
    || (relationship.slot === undefined ? state.sourceRelationship.slot.presence !== 'absent'
      : state.sourceRelationship.slot.presence !== 'present' || state.sourceRelationship.slot.value !== relationship.slot)
    || nodePositionMode(node) !== 'flow'
    || sceneNode.name.length === 0 || sceneNode.locked
    || !validMeasuredTopology(snapshot, state.nodeId, nodeMeasurement, sceneNode, rootId)
    || !sameRect(sceneNode.rect, nodeMeasurement.rect)) return null
  if ((node.type === 'frame' || node.type === 'component') && descendantsOf(snapshot.file, state.nodeId).some(id => nodeIsLocked(snapshot.file, id))) return null
  const sourceSiblings = childrenOf(snapshot.file, relationship.parentId, relationship.slot)
  if (sourceSiblings[state.sourceIndex] !== state.nodeId) return null

  const expectedOffsetParent = relationship.parentId === rootId ? null : relationship.parentId
  const canonicalSource = measuredGeometry(nodeMeasurement)
  if (!canonicalSource) return null
  if (measurement.sourceOffsetParent.offsetParentNodeId !== expectedOffsetParent
    || nodeMeasurement.offsetParentNodeId !== expectedOffsetParent
    || !sameMatrix(canonicalSource.parentToWorld, measurement.sourceOffsetParent.paddingToWorld)
    || !sameMatrix(canonicalSource.parentLocal, measurement.sourceOffsetParent.sourceParentLocal)
    || !sameGeometry(canonicalSource.geometry, measurement.source)) return null
  const delta = { x: state.currentWorld.x - state.pointerDownWorld.x, y: state.currentWorld.y - state.pointerDownWorld.y }
  const canonicalCurrent = matrixGeometry(multiply(translation(delta.x, delta.y), multiply(canonicalSource.parentToWorld, canonicalSource.parentLocal)), canonicalSource.geometry.semanticSize)
  if (!sameGeometry(measurement.current, canonicalCurrent)) return null
  if (state.originalMode === 'absolute') {
    if (!measurement.currentParentLocal) return null
    const worldToParent = invert(measurement.sourceOffsetParent.paddingToWorld)
    if (!worldToParent) return null
    const expectedCurrentParentLocal = multiply(worldToParent, multiply(translation(delta.x, delta.y),
      multiply(measurement.sourceOffsetParent.paddingToWorld, measurement.sourceOffsetParent.sourceParentLocal)))
    if (!sameMatrix(expectedCurrentParentLocal, measurement.currentParentLocal)) return null
    const currentFromProof = matrixGeometry(multiply(measurement.sourceOffsetParent.paddingToWorld, measurement.currentParentLocal), measurement.current.semanticSize)
    if (!sameGeometry(currentFromProof, measurement.current)) return null
  } else if (measurement.currentParentLocal !== null) return null

  let canonicalClone: FlowDragWorldGeometry | null = null
  if (state.clone === null ? measurement.clone !== null : measurement.clone === null) return null
  if (state.clone && measurement.clone) {
    const entryRect = state.clone.entryGeometry ? { coordinateSpace: 'parent-padding' as const, ...state.clone.entryGeometry } : null
    const cloneDelta = state.clone.entryMode === 'flow' ? { x: 0, y: 0 } : {
      x: state.clone.startedAtWorld.x - state.pointerDownWorld.x,
      y: state.clone.startedAtWorld.y - state.pointerDownWorld.y,
    }
    canonicalClone = translatedGeometry(canonicalSource.geometry, cloneDelta.x, cloneDelta.y)
    if (measurement.clone.generation !== state.clone.generation || measurement.clone.entryMode !== state.clone.entryMode
      || (measurement.clone.entryRect === null ? entryRect !== null : entryRect === null
        || measurement.clone.entryRect.coordinateSpace !== entryRect.coordinateSpace || !sameRect(measurement.clone.entryRect, entryRect))
      || !sameGeometry(measurement.clone.world, canonicalClone)) return null
  }

  let canonicalTargetWorld: FlowDragWorldGeometry | null = null
  if (state.target === null ? measurement.target !== null : measurement.target === null) return null
  if (state.target && measurement.target) {
    const resolvedTarget = resolveFlowDragTarget({ authority: snapshot, state, hoveredNodeId: state.target.parentId })
    if (!resolvedTarget || resolvedTarget.parentId !== state.target.parentId || resolvedTarget.slotPresence !== state.target.slotPresence
      || resolvedTarget.slotValue !== state.target.slotValue || resolvedTarget.rawIndex !== state.target.rawIndex
      || resolvedTarget.semanticIndex !== state.target.semanticIndex || resolvedTarget.line !== state.target.line
      || !sameGuide(resolvedTarget.guideWorld, state.target.guideWorld)) return null
    const targetNode = snapshot.file.nodes[state.target.parentId]
    if (!targetNode || state.target.parentId === state.nodeId || pageOfNode(snapshot.file, state.target.parentId) !== snapshot.pageId
      || nodeIsLocked(snapshot.file, state.target.parentId) || measurement.target.parentId !== state.target.parentId
      || !sameGuide(measurement.target.insertionGuide, state.target.guideWorld)) return null
    let ancestor: string | undefined = state.target.parentId
    while (ancestor) {
      if (ancestor === state.nodeId) return null
      ancestor = snapshot.file.relationships[ancestor]?.parentId
    }
    if (state.target.parentId === rootId) {
      if (measurement.target.outline !== null) return null
    } else {
      const targetScene = snapshot.scene.nodes.find(candidate => candidate.id === state.target!.parentId)
      const targetMeasurement = snapshot.geometry.nodes[state.target.parentId]
      const targetRelationship = snapshot.file.relationships[state.target.parentId]
      const targetTopologyValid = targetMeasurement && targetScene
        ? validMeasuredTopology(snapshot, state.target.parentId, targetMeasurement, targetScene, rootId)
        : false
      const canonicalTarget = targetTopologyValid ? measuredGeometry(targetMeasurement!) : null
      if (!measurement.target.outline || !targetScene || !targetMeasurement || targetScene.locked
        || !targetRelationship || !targetTopologyValid
        || !canonicalTarget || !sameGeometry(measurement.target.outline, canonicalTarget.geometry)
        || !sameRect(targetScene.rect, targetMeasurement.rect)) return null
      canonicalTargetWorld = canonicalTarget.geometry
    }
  }

  const publicationIdentity = {
    kind: 'flow-drag-presentation-publication' as const,
    interactionId: input.interactionId,
    pageId: snapshot.pageId,
    pageRootId: rootId,
    fence: clone(state.fence),
    gestureGeneration: state.gestureGeneration,
    sampleSequence: state.sampleSequence,
  }
  return freeze({
    kind: 'flow-drag-presentation-authority' as const,
    publicationIdentity,
    stateIdentity: state,
    interactionId: input.interactionId,
    pageId: snapshot.pageId,
    pageRootId: rootId,
    fence: clone(state.fence),
    gestureGeneration: state.gestureGeneration,
    sampleSequence: state.sampleSequence,
    retention: clone(input.retention),
    reducedMotion: input.reducedMotion,
    node: {
      id: state.nodeId,
      documentKind: node.type,
      sceneKind: sceneNode.kind,
      documentName: node.type === 'component' ? node.name ?? node.exportName : node.type === 'text' ? sceneNode.name : node.name,
      sceneName: sceneNode.name,
      sourceRelationship: clone(state.sourceRelationship),
      sourceIndex: state.sourceIndex,
      source: clone(canonicalSource.geometry),
      current: clone(canonicalCurrent),
      absolutePose: state.originalMode === 'absolute' ? {
        offsetParentNodeId: measurement.sourceOffsetParent.offsetParentNodeId,
        sourceOffsetParentPaddingToWorld: clone(measurement.sourceOffsetParent.paddingToWorld),
        currentParentLocal: clone(measurement.currentParentLocal!),
      } : null,
    },
    clone: state.clone && measurement.clone ? {
      role: 'inert-marker' as const,
      layoutParticipation: 'none' as const,
      generation: state.clone.generation,
      sourceRelationship: clone(state.clone.sourceRelationship),
      sourceIndex: state.clone.sourceIndex,
      entryMode: state.clone.entryMode,
      entryRect: clone(measurement.clone.entryRect),
      world: clone(canonicalClone!),
    } : null,
    target: state.target && measurement.target ? {
      parentId: state.target.parentId,
      parentIsRoot: state.target.parentId === rootId,
      slotPresence: state.target.slotPresence,
      slotValue: state.target.slotValue,
      rawIndex: state.target.rawIndex,
      semanticIndex: state.target.semanticIndex,
      line: state.target.line,
      parentWorld: clone(canonicalTargetWorld),
      guideWorld: clone(measurement.target.insertionGuide),
    } : null,
    contract: flowDragPresentationContract,
  })
}
