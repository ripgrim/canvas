import { primitiveKinds } from '@canvas/repo-engine/file-document'
import { validId } from '@canvas/repo-engine/document'
import type {
  FlowDragGeometry,
  FlowDragMatrix,
  FlowDragNodeKind,
  FlowDragPresentation as CanonicalFlowDragPresentation,
  FlowDragPresentationRetention,
  FlowDragQuad,
  FlowDragSourceOffsetParentPose as CanonicalFlowDragSourceOffsetParentPose,
} from '@canvas/sync-protocol/flow'
import type { Point, Rect, Size } from './canvas-math'
import { validFlowDragState } from './flow-drag-state'
import type { FlowDragFence, FlowDragSlotIdentity, FlowDragSourceRelationship, PaperFlowDragState } from './flow-drag-state'

export type FlowDragWorldQuad = FlowDragQuad
export type FlowDragWorldGeometry = FlowDragGeometry
export type FlowDragAffineMatrix = FlowDragMatrix

export type FlowDragSourceOffsetParentPose = CanonicalFlowDragSourceOffsetParentPose

export type FlowDragPresentationContract = Readonly<{
  ghost: Readonly<{ kind: 'fill-only'; color: 'oklch(0.67 0.17 258)'; alpha: 0.15 }>
  flowOriginal: Readonly<{ treatment: 'drag-dimmed'; opacity: 0.6; opacityPriority: 'important'; zIndex: null }>
  elevatedOriginal: Readonly<{ treatment: 'drag-elevated'; opacity: 0.6; opacityPriority: 'normal'; zIndex: 1000000 }>
  unchangedOriginal: Readonly<{ treatment: 'unchanged'; opacity: null; opacityPriority: 'normal'; zIndex: null }>
  target: Readonly<{ color: 'oklch(0.67 0.17 258)'; outlineWidthCssPx: 2; guideWidthCssPx: 4; guideStyle: 'solid' }>
  hud: Readonly<{ showDimensions: false; showSelectionOutline: false; showResizeHandles: false; showRotationHandles: false; interactiveHandleLayer: false }>
  mobileQuickActions: Readonly<{ mounted: true; hidden: true; inert: true; wonderDurationMs: 150; reducedMotionDurationMs: 0 }>
}>

export const flowDragPresentationContract: FlowDragPresentationContract = deepFreeze({
  ghost: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 },
  flowOriginal: { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null },
  elevatedOriginal: { treatment: 'drag-elevated', opacity: 0.6, opacityPriority: 'normal', zIndex: 1000000 },
  unchangedOriginal: { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
  target: { color: 'oklch(0.67 0.17 258)', outlineWidthCssPx: 2, guideWidthCssPx: 4, guideStyle: 'solid' },
  hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
  mobileQuickActions: { mounted: true, hidden: true, inert: true, wonderDurationMs: 150, reducedMotionDurationMs: 0 },
})

export type FlowDragPresentationPublicationIdentity = Readonly<{
  kind: 'flow-drag-presentation-publication'
  interactionId: string
  pageId: string
  pageRootId: string
  fence: FlowDragFence
  gestureGeneration: number
  sampleSequence: number
}>

export type FlowDragPresentationAuthority = Readonly<{
  kind: 'flow-drag-presentation-authority'
  publicationIdentity: FlowDragPresentationPublicationIdentity
  stateIdentity: PaperFlowDragState
  interactionId: string
  pageId: string
  pageRootId: string
  fence: FlowDragFence
  gestureGeneration: number
  sampleSequence: number
  retention: FlowDragPresentationRetention
  reducedMotion: boolean
  node: Readonly<{
    id: string
    documentKind: FlowDragNodeKind
    sceneKind: FlowDragNodeKind
    documentName: string
    sceneName: string
    sourceRelationship: FlowDragSourceRelationship
    sourceIndex: number
    source: FlowDragWorldGeometry
    current: FlowDragWorldGeometry
    absolutePose: Readonly<{
      offsetParentNodeId: string | null
      sourceOffsetParentPaddingToWorld: FlowDragAffineMatrix
      currentParentLocal: FlowDragAffineMatrix
    }> | null
  }>
  clone: Readonly<{
    role: 'inert-marker'
    layoutParticipation: 'none'
    generation: number
    sourceRelationship: FlowDragSourceRelationship
    sourceIndex: number
    entryMode: 'flow' | 'absolute'
    entryRect: Readonly<Rect & { coordinateSpace: 'parent-padding' }> | null
    world: FlowDragWorldGeometry
  }> | null
  target: Readonly<{
    parentId: string
    parentIsRoot: boolean
    slotPresence: FlowDragSlotIdentity['presence']
    slotValue: string | null
    rawIndex: number
    semanticIndex: number
    line: number
    parentWorld: FlowDragWorldGeometry | null
    guideWorld: Readonly<{ axis: 'x' | 'y'; position: number; start: number; end: number }> | null
  }> | null
  contract: FlowDragPresentationContract
}>

export type FlowDragPresentation = CanonicalFlowDragPresentation

export type ProjectFlowDragPresentationInput = Readonly<{
  state: PaperFlowDragState
  authority: FlowDragPresentationAuthority
  publicationIdentity: FlowDragPresentationPublicationIdentity
}>

const INPUT_KEYS = ['state', 'authority', 'publicationIdentity'] as const
const STATE_KEYS = ['kind', 'nodeId', 'selection', 'selectionDepthPrimary', 'sourceRelationship', 'sourceIndex', 'pointerDownWorld', 'currentWorld',
  'pointerDownViewport', 'currentViewport', 'pointerDownTime', 'currentTime', 'originalMode', 'altActive', 'primaryActive', 'thresholdCrossed',
  'gestureGeneration', 'cloneGeneration', 'clone', 'target', 'sampleSequence', 'fence'] as const
const AUTHORITY_KEYS = ['kind', 'publicationIdentity', 'stateIdentity', 'interactionId', 'pageId', 'pageRootId', 'fence', 'gestureGeneration', 'sampleSequence', 'retention',
  'reducedMotion', 'node', 'clone', 'target', 'contract'] as const
const NODE_KEYS = ['id', 'documentKind', 'sceneKind', 'documentName', 'sceneName', 'sourceRelationship', 'sourceIndex', 'source', 'current', 'absolutePose'] as const
const ABSOLUTE_POSE_KEYS = ['offsetParentNodeId', 'sourceOffsetParentPaddingToWorld', 'currentParentLocal'] as const
const CLONE_KEYS = ['role', 'layoutParticipation', 'generation', 'sourceRelationship', 'sourceIndex', 'entryMode', 'entryRect', 'world'] as const
const TARGET_KEYS = ['parentId', 'parentIsRoot', 'slotPresence', 'slotValue', 'rawIndex', 'semanticIndex', 'line', 'parentWorld', 'guideWorld'] as const
const STATE_CLONE_KEYS = ['generation', 'entryMode', 'entryGeometry', 'sourceRelationship', 'sourceIndex', 'startedAtWorld'] as const
const STATE_TARGET_KEYS = ['parentId', 'slotPresence', 'slotValue', 'rawIndex', 'semanticIndex', 'line', 'guideWorld', 'fence'] as const
const GEOMETRY_KEYS = ['coordinateSpace', 'quad', 'aabb', 'semanticSize'] as const
const POINT_KEYS = ['x', 'y'] as const
const RECT_KEYS = ['x', 'y', 'width', 'height'] as const
const SIZE_KEYS = ['width', 'height'] as const
const RELATIONSHIP_KEYS = ['parentId', 'orderKey', 'slot'] as const
const FENCE_KEYS = ['fileId', 'fileRevision', 'measurementRevision', 'documentRevision', 'layoutGeneration'] as const

const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function exactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every(key => {
    if (typeof key !== 'string' || !keys.includes(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  }) && keys.every(key => own(value, key))
}

function exactQuad(value: unknown): value is FlowDragWorldQuad {
  if (!Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 5 || !['0', '1', '2', '3', 'length'].every(key => keys.includes(key))) return false
  const length = Object.getOwnPropertyDescriptor(value, 'length')
  if (!length || !('value' in length) || length.enumerable || length.value !== 4) return false
  return ['0', '1', '2', '3'].every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor && validPoint(descriptor.value))
  })
}

function exactMatrix(value: unknown): value is FlowDragAffineMatrix {
  if (!Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 7 || !['0', '1', '2', '3', '4', '5', 'length'].every(key => keys.includes(key))) return false
  const length = Object.getOwnPropertyDescriptor(value, 'length')
  if (!length || !('value' in length) || length.enumerable || length.value !== 6) return false
  return ['0', '1', '2', '3', '4', '5'].every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor && finite(descriptor.value))
  })
}

function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true
  if (seen.has(value)) return true
  if (!Object.isFrozen(value)) return false
  seen.add(value)
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && 'value' in descriptor && deeplyFrozen(descriptor.value, seen))
  })
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const key of Reflect.ownKeys(object)) deepFreeze(Reflect.get(object, key), seen)
  return Object.freeze(value)
}

function validPoint(value: unknown): value is Readonly<Point> {
  return exactOwnKeys(value, POINT_KEYS) && finite(value.x) && finite(value.y)
}

function validRect(value: unknown): value is Readonly<Rect> {
  return exactOwnKeys(value, RECT_KEYS) && finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0
}

function validSize(value: unknown): value is Readonly<Size> {
  return exactOwnKeys(value, SIZE_KEYS) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0
}

function validSlot(value: unknown): value is FlowDragSlotIdentity {
  return exactOwnKeys(value, value && typeof value === 'object' && 'presence' in value && value.presence === 'present' ? ['presence', 'value'] : ['presence'])
    && (value.presence === 'absent' || value.presence === 'present' && typeof value.value === 'string' && value.value.length > 0)
}

function validRelationship(value: unknown): value is FlowDragSourceRelationship {
  return exactOwnKeys(value, RELATIONSHIP_KEYS) && validId(value.parentId) && typeof value.orderKey === 'string' && validSlot(value.slot)
}

function validFence(value: unknown): value is FlowDragFence {
  return exactOwnKeys(value, FENCE_KEYS) && validId(value.fileId) && generation(value.fileRevision) && generation(value.measurementRevision)
    && generation(value.documentRevision) && value.documentRevision === value.fileRevision && generation(value.layoutGeneration)
}

function sameFence(left: FlowDragFence, right: FlowDragFence): boolean {
  return left.fileId === right.fileId && left.fileRevision === right.fileRevision && left.measurementRevision === right.measurementRevision
    && left.documentRevision === right.documentRevision && left.layoutGeneration === right.layoutGeneration
}

function sameRelationship(left: FlowDragSourceRelationship, right: FlowDragSourceRelationship): boolean {
  return left.parentId === right.parentId && left.orderKey === right.orderKey && left.slot.presence === right.slot.presence
    && (left.slot.presence === 'absent' || right.slot.presence === 'present' && left.slot.value === right.slot.value)
}

function samePoint(left: Readonly<Point>, right: Readonly<Point>): boolean { return left.x === right.x && left.y === right.y }
function sameRect(left: Readonly<Rect>, right: Readonly<Rect>): boolean { return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height }
function sameSize(left: Readonly<Size>, right: Readonly<Size>): boolean { return left.width === right.width && left.height === right.height }

function quadAabb(quad: FlowDragWorldQuad): Rect | null {
  const top = { x: quad[1].x - quad[0].x, y: quad[1].y - quad[0].y }
  const left = { x: quad[3].x - quad[0].x, y: quad[3].y - quad[0].y }
  if (Math.abs(top.x * left.y - top.y * left.x) < 1e-12) return null
  const expectedQ2 = { x: quad[1].x + quad[3].x - quad[0].x, y: quad[1].y + quad[3].y - quad[0].y }
  if (!samePoint(expectedQ2, quad[2])) return null
  const xs = quad.map(point => point.x), ys = quad.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys)
  const result = { x, y, width: right - x, height: bottom - y }
  return validRect(result) ? result : null
}

function validGeometry(value: unknown): value is FlowDragWorldGeometry {
  if (!exactOwnKeys(value, GEOMETRY_KEYS) || value.coordinateSpace !== 'world' || !exactQuad(value.quad) || !validRect(value.aabb) || !validSize(value.semanticSize)) return false
  const aabb = quadAabb(value.quad)
  return Boolean(aabb && sameRect(aabb, value.aabb))
}

function translated(source: FlowDragWorldGeometry, delta: Readonly<Point>, candidate: FlowDragWorldGeometry): boolean {
  if (!sameSize(source.semanticSize, candidate.semanticSize)) return false
  const quad = source.quad.map(point => ({ x: point.x + delta.x, y: point.y + delta.y })) as unknown as FlowDragWorldQuad
  if (!quad.every((point, position) => samePoint(point, candidate.quad[position]!))) return false
  return candidate.aabb.x === source.aabb.x + delta.x && candidate.aabb.y === source.aabb.y + delta.y
    && candidate.aabb.width === source.aabb.width && candidate.aabb.height === source.aabb.height
}

function nonsingular(matrix: FlowDragAffineMatrix): boolean {
  return matrix[0] * matrix[3] - matrix[1] * matrix[2] !== 0
}

function compose(left: FlowDragAffineMatrix, right: FlowDragAffineMatrix): FlowDragAffineMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function matrixQuad(matrix: FlowDragAffineMatrix, size: Readonly<Size>): FlowDragWorldQuad {
  const map = (x: number, y: number): Readonly<Point> => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  })
  return [map(0, 0), map(size.width, 0), map(size.width, size.height), map(0, size.height)]
}

function exactStateShape(state: PaperFlowDragState): boolean {
  if (!exactOwnKeys(state, STATE_KEYS) || !validPoint(state.pointerDownWorld) || !validPoint(state.currentWorld)
    || !validPoint(state.pointerDownViewport) || !validPoint(state.currentViewport) || !validRelationship(state.sourceRelationship) || !validFence(state.fence)) return false
  if (!Array.isArray(state.selection) || state.selection.length !== 1 || Reflect.ownKeys(state.selection).length !== 2) return false
  if (state.clone) {
    if (!exactOwnKeys(state.clone, STATE_CLONE_KEYS) || !validRelationship(state.clone.sourceRelationship) || !validPoint(state.clone.startedAtWorld)) return false
    if (state.clone.entryGeometry !== null && !validRect(state.clone.entryGeometry)) return false
  }
  if (state.target) {
    if (!exactOwnKeys(state.target, STATE_TARGET_KEYS)) return false
    if (state.target.guideWorld && (!exactOwnKeys(state.target.guideWorld, ['axis', 'position', 'start', 'end'])
      || !finite(state.target.guideWorld.position) || !finite(state.target.guideWorld.start) || !finite(state.target.guideWorld.end))) return false
    if (!exactOwnKeys(state.target.fence, [...FENCE_KEYS, 'gestureGeneration', 'sampleSequence'])) return false
  }
  return true
}

function sameContract(contract: FlowDragPresentationContract): boolean {
  return exactOwnKeys(contract, ['ghost', 'flowOriginal', 'elevatedOriginal', 'unchangedOriginal', 'target', 'hud', 'mobileQuickActions'])
    && exactOwnKeys(contract.ghost, ['kind', 'color', 'alpha']) && contract.ghost.kind === 'fill-only' && contract.ghost.color === 'oklch(0.67 0.17 258)' && contract.ghost.alpha === 0.15
    && exactOwnKeys(contract.flowOriginal, ['treatment', 'opacity', 'opacityPriority', 'zIndex']) && contract.flowOriginal.treatment === 'drag-dimmed' && contract.flowOriginal.opacity === 0.6 && contract.flowOriginal.opacityPriority === 'important' && contract.flowOriginal.zIndex === null
    && exactOwnKeys(contract.elevatedOriginal, ['treatment', 'opacity', 'opacityPriority', 'zIndex']) && contract.elevatedOriginal.treatment === 'drag-elevated' && contract.elevatedOriginal.opacity === 0.6 && contract.elevatedOriginal.opacityPriority === 'normal' && contract.elevatedOriginal.zIndex === 1000000
    && exactOwnKeys(contract.unchangedOriginal, ['treatment', 'opacity', 'opacityPriority', 'zIndex']) && contract.unchangedOriginal.treatment === 'unchanged' && contract.unchangedOriginal.opacity === null && contract.unchangedOriginal.opacityPriority === 'normal' && contract.unchangedOriginal.zIndex === null
    && exactOwnKeys(contract.target, ['color', 'outlineWidthCssPx', 'guideWidthCssPx', 'guideStyle']) && contract.target.color === 'oklch(0.67 0.17 258)' && contract.target.outlineWidthCssPx === 2 && contract.target.guideWidthCssPx === 4 && contract.target.guideStyle === 'solid'
    && exactOwnKeys(contract.hud, ['showDimensions', 'showSelectionOutline', 'showResizeHandles', 'showRotationHandles', 'interactiveHandleLayer']) && Object.values(contract.hud).every(value => value === false)
    && exactOwnKeys(contract.mobileQuickActions, ['mounted', 'hidden', 'inert', 'wonderDurationMs', 'reducedMotionDurationMs'])
    && contract.mobileQuickActions.mounted === true && contract.mobileQuickActions.hidden === true && contract.mobileQuickActions.inert === true
    && contract.mobileQuickActions.wonderDurationMs === 150 && contract.mobileQuickActions.reducedMotionDurationMs === 0
}

function validAuthority(state: PaperFlowDragState, authority: FlowDragPresentationAuthority): boolean {
  if (!exactOwnKeys(authority, AUTHORITY_KEYS) || !deeplyFrozen(authority) || authority.stateIdentity !== state) return false
  if (authority.kind !== 'flow-drag-presentation-authority' || !validId(authority.interactionId) || !validId(authority.pageId) || !validId(authority.pageRootId)) return false
  if (!validFence(authority.fence) || !sameFence(authority.fence, state.fence) || authority.gestureGeneration !== state.gestureGeneration || authority.sampleSequence !== state.sampleSequence) return false
  if (!generation(authority.gestureGeneration) || !generation(authority.sampleSequence) || typeof authority.reducedMotion !== 'boolean') return false
  if (!exactOwnKeys(authority.publicationIdentity, ['kind', 'interactionId', 'pageId', 'pageRootId', 'fence', 'gestureGeneration', 'sampleSequence'])
    || authority.publicationIdentity.kind !== 'flow-drag-presentation-publication'
    || authority.publicationIdentity.interactionId !== authority.interactionId
    || authority.publicationIdentity.pageId !== authority.pageId
    || authority.publicationIdentity.pageRootId !== authority.pageRootId
    || !validFence(authority.publicationIdentity.fence)
    || !sameFence(authority.publicationIdentity.fence, authority.fence)
    || authority.publicationIdentity.gestureGeneration !== state.gestureGeneration
    || authority.publicationIdentity.sampleSequence !== state.sampleSequence) return false
  const retentionKeys = authority.retention.kind === 'terminal-retained'
    ? ['kind', 'gestureGeneration', 'sampleSequence', 'terminalReason', 'terminalSampleSequence', 'holdUntil']
    : ['kind', 'gestureGeneration', 'sampleSequence']
  if (!exactOwnKeys(authority.retention, retentionKeys) || !['active', 'terminal-retained'].includes(authority.retention.kind)
    || authority.retention.gestureGeneration !== state.gestureGeneration || authority.retention.sampleSequence !== state.sampleSequence) return false
  if (authority.retention.kind === 'terminal-retained'
    && (!['pointer-up', 'escape-after-threshold', 'pointercancel-after-threshold'].includes(authority.retention.terminalReason)
      || authority.retention.terminalSampleSequence !== state.sampleSequence
      || authority.retention.holdUntil !== 'authoritative-geometry')) return false
  if (!sameContract(authority.contract) || !exactOwnKeys(authority.node, NODE_KEYS)) return false
  const node = authority.node
  const kinds = ['component', ...primitiveKinds]
  if (node.id !== state.nodeId || !kinds.includes(node.documentKind) || node.sceneKind !== node.documentKind) return false
  if (typeof node.documentName !== 'string' || !node.documentName.trim() || node.sceneName !== node.documentName) return false
  if (!validRelationship(node.sourceRelationship) || !sameRelationship(node.sourceRelationship, state.sourceRelationship) || node.sourceIndex !== state.sourceIndex) return false
  if (!validGeometry(node.source) || !validGeometry(node.current)) return false
  const delta = { x: state.currentWorld.x - state.pointerDownWorld.x, y: state.currentWorld.y - state.pointerDownWorld.y }
  if (!translated(node.source, delta, node.current)) return false
  if (state.originalMode === 'flow') {
    if (node.absolutePose !== null) return false
  } else {
    if (!exactOwnKeys(node.absolutePose, ABSOLUTE_POSE_KEYS)) return false
    const expectedOffsetParent = state.sourceRelationship.parentId === authority.pageRootId ? null : state.sourceRelationship.parentId
    if (node.absolutePose.offsetParentNodeId !== expectedOffsetParent) return false
    const proof = node.absolutePose.sourceOffsetParentPaddingToWorld
    const local = node.absolutePose.currentParentLocal
    if (!exactMatrix(proof) || !nonsingular(proof) || !exactMatrix(local) || !nonsingular(local)) return false
    const projected = matrixQuad(compose(proof, local), node.current.semanticSize)
    if (!projected.every((point, position) => samePoint(point, node.current.quad[position]!))) return false
  }

  if ((authority.clone === null) !== (state.clone === null)) return false
  if (authority.clone && state.clone) {
    const clone = authority.clone
    if (!exactOwnKeys(clone, CLONE_KEYS) || clone.role !== 'inert-marker' || clone.layoutParticipation !== 'none'
      || clone.generation !== state.clone.generation || clone.entryMode !== state.clone.entryMode
      || clone.sourceIndex !== state.clone.sourceIndex || !validRelationship(clone.sourceRelationship) || !sameRelationship(clone.sourceRelationship, state.clone.sourceRelationship)) return false
    if (clone.entryMode === 'absolute') {
      if (!clone.entryRect || !state.clone.entryGeometry || !exactOwnKeys(clone.entryRect, [...RECT_KEYS, 'coordinateSpace'])
        || clone.entryRect.coordinateSpace !== 'parent-padding' || !validRect(state.clone.entryGeometry) || !sameRect(clone.entryRect, state.clone.entryGeometry)) return false
    } else if (clone.entryRect !== null || state.clone.entryGeometry !== null) return false
    if (!validGeometry(clone.world)) return false
    const cloneDelta = state.clone.entryMode === 'flow' ? { x: 0, y: 0 }
      : { x: state.clone.startedAtWorld.x - state.pointerDownWorld.x, y: state.clone.startedAtWorld.y - state.pointerDownWorld.y }
    if (!translated(node.source, cloneDelta, clone.world)) return false
  }

  if ((authority.target === null) !== (state.target === null)) return false
  if (authority.target && state.target) {
    const target = authority.target
    if (!exactOwnKeys(target, TARGET_KEYS) || target.parentId !== state.target.parentId || target.parentId === state.nodeId
      || target.parentIsRoot !== (target.parentId === authority.pageRootId) || target.slotPresence !== state.target.slotPresence || target.slotValue !== state.target.slotValue
      || target.rawIndex !== state.target.rawIndex || target.semanticIndex !== state.target.semanticIndex || target.line !== state.target.line) return false
    if (!index(target.rawIndex) || !index(target.semanticIndex) || !index(target.line)) return false
    if (target.parentIsRoot ? target.parentWorld !== null : !validGeometry(target.parentWorld)) return false
    if ((target.guideWorld === null) !== (state.target.guideWorld === null)) return false
    if (target.guideWorld && state.target.guideWorld) {
      if (!exactOwnKeys(target.guideWorld, ['axis', 'position', 'start', 'end']) || target.guideWorld.axis !== state.target.guideWorld.axis
        || target.guideWorld.position !== state.target.guideWorld.position || target.guideWorld.start !== state.target.guideWorld.start
        || target.guideWorld.end !== state.target.guideWorld.end || !finite(target.guideWorld.position) || !finite(target.guideWorld.start)
        || !finite(target.guideWorld.end) || target.guideWorld.end <= target.guideWorld.start) return false
    }
  }
  return true
}

function copyGeometry(geometry: FlowDragWorldGeometry): FlowDragWorldGeometry {
  return {
    coordinateSpace: 'world',
    quad: geometry.quad.map(point => ({ ...point })) as unknown as FlowDragWorldQuad,
    aabb: { ...geometry.aabb },
    semanticSize: { ...geometry.semanticSize },
  }
}

export function projectFlowDragPresentation(input: ProjectFlowDragPresentationInput): FlowDragPresentation | null {
  if (!exactOwnKeys(input, INPUT_KEYS)) return null
  const { state, authority, publicationIdentity } = input
  if (!deeplyFrozen(state) || !exactStateShape(state) || !validFlowDragState(state) || !state.thresholdCrossed || state.sampleSequence <= 0) return null
  if (!validAuthority(state, authority)) return null
  if (publicationIdentity !== authority.publicationIdentity) return null
  const source = copyGeometry(authority.node.source)
  const current = copyGeometry(authority.node.current)
  const differentNonRootTarget = Boolean(state.target && state.target.parentId !== state.sourceRelationship.parentId && state.target.parentId !== authority.pageRootId)
  const dom = state.originalMode === 'flow' ? structuredClone(authority.contract.flowOriginal)
    : differentNonRootTarget ? structuredClone(authority.contract.elevatedOriginal) : structuredClone(authority.contract.unchangedOriginal)
  const namePose = state.originalMode === 'flow' ? source : current
  const movingVisual: FlowDragPresentation['movingVisual'] = state.originalMode === 'flow'
    ? { kind: 'fill-ghost', documentNodeId: null, geometry: current, fill: structuredClone(authority.contract.ghost), hitTesting: 'none', a11y: 'hidden' }
    : { kind: 'document-node', documentNodeId: state.nodeId, geometry: current }
  const sourceOffsetParentPose: FlowDragPresentation['original']['sourceOffsetParentPose'] = authority.node.absolutePose ? {
    coordinateSpace: 'source-offset-parent',
    offsetParentNodeId: authority.node.absolutePose.offsetParentNodeId,
    sourceOffsetParentPaddingToWorld: [...authority.node.absolutePose.sourceOffsetParentPaddingToWorld],
    matrix: [...authority.node.absolutePose.currentParentLocal],
  } : null

  let supportClone: FlowDragPresentation['supportClone'] = null
  if (state.clone && authority.clone) {
    const key = {
      kind: 'flow-support-clone' as const,
      interactionId: authority.interactionId,
      gestureGeneration: state.gestureGeneration,
      cloneGeneration: state.clone.generation,
    }
    supportClone = {
      key, documentNodeId: null, role: authority.clone.role, layoutParticipation: authority.clone.layoutParticipation,
      generation: state.clone.generation, sourceRelationship: structuredClone(state.clone.sourceRelationship),
      sourceIndex: state.clone.sourceIndex, entryMode: state.clone.entryMode,
      entry: authority.clone.entryRect ? { ...authority.clone.entryRect } : null, world: copyGeometry(authority.clone.world),
      hiddenUntilCommit: true, hitTesting: 'none', a11y: 'hidden',
    }
  }

  let target: FlowDragPresentation['target'] = null
  if (state.target && authority.target) {
    const parentOutline = differentNonRootTarget && authority.target.parentWorld ? {
      coordinateSpace: 'world' as const,
      quad: authority.target.parentWorld.quad.map(point => ({ ...point })) as unknown as FlowDragWorldQuad,
      aabb: { ...authority.target.parentWorld.aabb },
      color: authority.contract.target.color,
      widthCssPx: authority.contract.target.outlineWidthCssPx,
    } : null
    const guide = authority.target.guideWorld
    const insertionGuide = guide ? { coordinateSpace: 'world' as const, ...guide, color: authority.contract.target.color,
      widthCssPx: authority.contract.target.guideWidthCssPx, style: authority.contract.target.guideStyle } : null
    target = {
      parentId: state.target.parentId,
      slot: state.target.slotPresence === 'present' ? { presence: 'present', value: state.target.slotValue! } : { presence: 'absent' },
      rawIndex: state.target.rawIndex, semanticIndex: state.target.semanticIndex, line: state.target.line, parentOutline, insertionGuide,
    }
  }

  return deepFreeze({
    kind: 'flow-drag' as const,
    coordinateSpace: 'world' as const,
    identity: { interactionId: authority.interactionId, gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence },
    fence: { ...state.fence, pageId: authority.pageId, pageRootId: authority.pageRootId },
    retention: structuredClone(authority.retention),
    pointer: { downWorld: { ...state.pointerDownWorld }, currentWorld: { ...state.currentWorld } },
    original: {
      documentNodeId: state.nodeId, kind: authority.node.documentKind, name: authority.node.documentName,
      sourceRelationship: structuredClone(state.sourceRelationship), sourceIndex: state.sourceIndex, mode: state.originalMode,
      source, current, sourceOffsetParentPose, dom, namePresentation: {
        visible: true as const,
        anchor: state.originalMode === 'flow' ? 'source' as const : 'current' as const,
        pose: copyGeometry(namePose),
      },
    },
    movingVisual,
    supportClone,
    target,
    hud: structuredClone(authority.contract.hud),
    mobileQuickActions: {
      mounted: true as const, hidden: true as const, inert: true as const,
      transition: { property: 'opacity' as const, durationMs: authority.reducedMotion ? authority.contract.mobileQuickActions.reducedMotionDurationMs : authority.contract.mobileQuickActions.wonderDurationMs, source: 'wonder' as const },
    },
  })
}
