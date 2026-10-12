export const flowDragCoordinateLimit = 1_000_000
export const flowDragIntegerLimit = 2_147_483_647

export type FlowDragPoint = Readonly<{ x: number; y: number }>
export type FlowDragRect = Readonly<{ x: number; y: number; width: number; height: number }>
export type FlowDragSize = Readonly<{ width: number; height: number }>
export type FlowDragQuad = readonly [FlowDragPoint, FlowDragPoint, FlowDragPoint, FlowDragPoint]
export type FlowDragMatrix = readonly [number, number, number, number, number, number]
export type FlowDragSlot = Readonly<{ presence: 'absent' }> | Readonly<{ presence: 'present'; value: string }>
export type FlowDragLane = Readonly<{ parentId: string; slot: FlowDragSlot }>
export type FlowDragRelationship = Readonly<{ parentId: string; orderKey: string; slot: FlowDragSlot }>
export type FlowDragGeometry = Readonly<{
  coordinateSpace: 'world'
  quad: FlowDragQuad
  aabb: FlowDragRect
  semanticSize: FlowDragSize
}>

export type FlowDragSourceFence = Readonly<{
  fileId: string
  fileRevision: number
  measurementRevision: number
  documentRevision: number
  layoutGeneration: number
  pageId: string
  pageRootId: string
}>

export type FlowDragPresentationKey = Readonly<{
  interactionId: string
  gestureGeneration: number
  sequence: number
}>

export type FlowDragPresentationRetention = Readonly<{
  kind: 'active'
  gestureGeneration: number
  sampleSequence: number
}> | Readonly<{
  kind: 'terminal-retained'
  gestureGeneration: number
  sampleSequence: number
  terminalReason: 'pointer-up' | 'escape-after-threshold' | 'pointercancel-after-threshold'
  terminalSampleSequence: number
  holdUntil: 'authoritative-geometry'
}>

export type FlowDragSourceOffsetParentPose = Readonly<{
  coordinateSpace: 'source-offset-parent'
  offsetParentNodeId: string | null
  sourceOffsetParentPaddingToWorld: FlowDragMatrix
  matrix: FlowDragMatrix
}>

export type FlowDragNodeKind = 'component' | 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'

export type FlowDragPresentation = Readonly<{
  kind: 'flow-drag'
  coordinateSpace: 'world'
  identity: Readonly<{ interactionId: string; gestureGeneration: number; sampleSequence: number }>
  fence: FlowDragSourceFence
  retention: FlowDragPresentationRetention
  pointer: Readonly<{ downWorld: FlowDragPoint; currentWorld: FlowDragPoint }>
  original: Readonly<{
    documentNodeId: string
    kind: FlowDragNodeKind
    name: string
    sourceRelationship: FlowDragRelationship
    sourceIndex: number
    mode: 'flow' | 'absolute'
    source: FlowDragGeometry
    current: FlowDragGeometry
    sourceOffsetParentPose: FlowDragSourceOffsetParentPose | null
    dom: Readonly<{
      treatment: 'drag-dimmed' | 'drag-elevated' | 'unchanged'
      opacity: 0.6 | null
      opacityPriority: 'important' | 'normal'
      zIndex: 1000000 | null
    }>
    namePresentation: Readonly<{ visible: true; anchor: 'source' | 'current'; pose: FlowDragGeometry }>
  }>
  movingVisual: Readonly<{
    kind: 'fill-ghost'
    documentNodeId: null
    geometry: FlowDragGeometry
    fill: Readonly<{ kind: 'fill-only'; color: 'oklch(0.67 0.17 258)'; alpha: 0.15 }>
    hitTesting: 'none'
    a11y: 'hidden'
  }> | Readonly<{ kind: 'document-node'; documentNodeId: string; geometry: FlowDragGeometry }>
  supportClone: Readonly<{
    key: Readonly<{ kind: 'flow-support-clone'; interactionId: string; gestureGeneration: number; cloneGeneration: number }>
    documentNodeId: null
    generation: number
    sourceRelationship: FlowDragRelationship
    sourceIndex: number
    entryMode: 'flow' | 'absolute'
    entry: Readonly<FlowDragRect & { coordinateSpace: 'parent-padding' }> | null
    world: FlowDragGeometry
    hiddenUntilCommit: true
    role: 'inert-marker'
    layoutParticipation: 'none'
    hitTesting: 'none'
    a11y: 'hidden'
  }> | null
  target: Readonly<{
    parentId: string
    slot: FlowDragSlot
    rawIndex: number
    semanticIndex: number
    line: number
    parentOutline: Readonly<{
      coordinateSpace: 'world'
      quad: FlowDragQuad
      aabb: FlowDragRect
      color: 'oklch(0.67 0.17 258)'
      widthCssPx: 2
    }> | null
    insertionGuide: Readonly<{
      coordinateSpace: 'world'
      axis: 'x' | 'y'
      position: number
      start: number
      end: number
      color: 'oklch(0.67 0.17 258)'
      widthCssPx: 4
      style: 'solid'
    }> | null
  }> | null
  hud: Readonly<{
    showDimensions: false
    showSelectionOutline: false
    showResizeHandles: false
    showRotationHandles: false
    interactiveHandleLayer: false
  }>
  mobileQuickActions: Readonly<{
    mounted: true
    hidden: true
    inert: true
    transition: Readonly<{ property: 'opacity'; durationMs: 0 | 150; source: 'wonder' }>
  }>
}>

export type FlowDragAuthoritativeSource = Readonly<{
  kind: FlowDragNodeKind
  relationship: Readonly<{ parentId: string; orderKey: string | null; slot: FlowDragSlot }>
  sourceIndex: number
}>

export type FlowDragTargetTopology = Readonly<{
  pageId: string
  pageRootId: string
  sourceNodeId: string
  sourceLane: FlowDragLane
  targetLane: FlowDragLane
  rawIndex: number
  semanticIndex: number
  line: number
}>

/** Trusted document topology adapter. Target policy remains with the adapter. */
export type FlowDragTopologyAuthority = Readonly<{
  fileId: string
  fileRevision: number
  pageId: string
  pageRootId: string
  source(nodeId: string): FlowDragAuthoritativeSource | null
  acceptsTarget(target: FlowDragTargetTopology): boolean
}>

export const flowDragDenialCodes = [
  'read_only', 'missing_file', 'missing_page', 'missing_node', 'wrong_page', 'overlap', 'invalid_topology',
  'component_slot_unverified', 'capacity_refused', 'stale_generation', 'stale_sequence', 'stale_reservation', 'lease_not_found',
] as const
export type FlowDragDenialCode = typeof flowDragDenialCodes[number]

export type FlowDragServerLeaseId = string
export type FlowDragLocalClaimGeneration = number
export type FlowDragReservationGeneration = number

export type FlowDragTerminalBinding = Readonly<{
  leaseId: FlowDragServerLeaseId
  interactionId: string
  localClaimGeneration: FlowDragLocalClaimGeneration
  reservationGeneration: FlowDragReservationGeneration
  terminalSampleSequence: number
  presentationDigest: string
  sourceLane: FlowDragLane
  targetLane: FlowDragLane
}>

export const flowDragResourceLimits = Object.freeze({
  maxClaimsPerLease: 16,
  maxLanesPerReservation: 8,
  maxNodeIdsPerLane: 4096,
  maxReservedIdsPerSession: 16_384,
  maxReservationBytesPerSession: 512 * 1024,
  maxReservationsPerRoom: 512,
  maxClaimsPerRoom: 2048,
  maxSamplesPerSecond: 240,
  maxSampleBurst: 480,
  maxSamplePayloadBytes: 64 * 1024,
  maxTopologyDepth: 128,
  maxLaneComparisonNodes: 8192,
  maxTerminalGeometryItems: 32,
  maxRetainedSettlementReceipts: 512,
} as const)
export type FlowDragResourceLimits = typeof flowDragResourceLimits

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const blockedIdentifiers = new Set(['__proto__', 'constructor', 'prototype'])
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && identifierPattern.test(value) && !blockedIdentifiers.has(value)
const finiteWithin = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= flowDragCoordinateLimit
const flowInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= flowDragIntegerLimit

function dataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  })
}

function exactDataObject(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!dataRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === names.length && names.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  }) && keys.every(key => typeof key === 'string' && names.includes(key))
}

function exactDataArray(value: unknown, length: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const keys = Reflect.ownKeys(value)
  const expected = [...Array.from({ length }, (_, index) => String(index)), 'length']
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) return false
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.enumerable || lengthDescriptor.value !== length) return false
  return expected.slice(0, -1).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  })
}

function point(value: unknown): value is FlowDragPoint {
  return exactDataObject(value, ['x', 'y']) && finiteWithin(value.x) && finiteWithin(value.y)
}

function rect(value: unknown): value is FlowDragRect {
  return exactDataObject(value, ['x', 'y', 'width', 'height']) && finiteWithin(value.x) && finiteWithin(value.y)
    && finiteWithin(value.width) && (value.width as number) > 0 && finiteWithin(value.height) && (value.height as number) > 0
}

function size(value: unknown): value is FlowDragSize {
  return exactDataObject(value, ['width', 'height']) && finiteWithin(value.width) && (value.width as number) > 0
    && finiteWithin(value.height) && (value.height as number) > 0
}

function quad(value: unknown): value is unknown[] & FlowDragQuad {
  return exactDataArray(value, 4) && point(value[0]) && point(value[1]) && point(value[2]) && point(value[3])
}

function matrix(value: unknown): value is unknown[] & FlowDragMatrix {
  return exactDataArray(value, 6) && finiteWithin(value[0]) && finiteWithin(value[1]) && finiteWithin(value[2])
    && finiteWithin(value[3]) && finiteWithin(value[4]) && finiteWithin(value[5])
    && Math.abs((value[0] as number) * (value[3] as number) - (value[1] as number) * (value[2] as number)) >= 1e-12
}

function composeMatrix(left: FlowDragMatrix, right: FlowDragMatrix): FlowDragMatrix {
  return [
    left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function matrixQuad(value: FlowDragMatrix, dimensions: FlowDragSize): FlowDragQuad {
  const map = (x: number, y: number): FlowDragPoint => ({ x: value[0] * x + value[2] * y + value[4], y: value[1] * x + value[3] * y + value[5] })
  return [map(0, 0), map(dimensions.width, 0), map(dimensions.width, dimensions.height), map(0, dimensions.height)]
}

function samePoint(left: FlowDragPoint, right: FlowDragPoint): boolean { return left.x === right.x && left.y === right.y }
function sameRect(left: FlowDragRect, right: FlowDragRect): boolean { return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height }
function sameSize(left: FlowDragSize, right: FlowDragSize): boolean { return left.width === right.width && left.height === right.height }

function quadAabb(value: FlowDragQuad): FlowDragRect | null {
  const expected = { x: value[1].x + value[3].x - value[0].x, y: value[1].y + value[3].y - value[0].y }
  if (!samePoint(expected, value[2])) return null
  const topX = value[1].x - value[0].x, topY = value[1].y - value[0].y
  const leftX = value[3].x - value[0].x, leftY = value[3].y - value[0].y
  if (Math.abs(topX * leftY - topY * leftX) < 1e-12) return null
  const xs = [value[0].x, value[1].x, value[2].x, value[3].x]
  const ys = [value[0].y, value[1].y, value[2].y, value[3].y]
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

function geometry(value: unknown): value is FlowDragGeometry {
  if (!exactDataObject(value, ['coordinateSpace', 'quad', 'aabb', 'semanticSize']) || value.coordinateSpace !== 'world'
    || !quad(value.quad) || !rect(value.aabb) || !size(value.semanticSize)) return false
  const aabb = quadAabb(value.quad)
  return Boolean(aabb && sameRect(aabb, value.aabb))
}

function sameGeometry(left: FlowDragGeometry, right: FlowDragGeometry): boolean {
  return sameRect(left.aabb, right.aabb) && sameSize(left.semanticSize, right.semanticSize)
    && samePoint(left.quad[0], right.quad[0]) && samePoint(left.quad[1], right.quad[1])
    && samePoint(left.quad[2], right.quad[2]) && samePoint(left.quad[3], right.quad[3])
}

function translatedGeometry(source: FlowDragGeometry, delta: FlowDragPoint, current: FlowDragGeometry): boolean {
  return sameSize(source.semanticSize, current.semanticSize)
    && samePoint({ x: source.quad[0].x + delta.x, y: source.quad[0].y + delta.y }, current.quad[0])
    && samePoint({ x: source.quad[1].x + delta.x, y: source.quad[1].y + delta.y }, current.quad[1])
    && samePoint({ x: source.quad[2].x + delta.x, y: source.quad[2].y + delta.y }, current.quad[2])
    && samePoint({ x: source.quad[3].x + delta.x, y: source.quad[3].y + delta.y }, current.quad[3])
    && current.aabb.x === source.aabb.x + delta.x && current.aabb.y === source.aabb.y + delta.y
    && current.aabb.width === source.aabb.width && current.aabb.height === source.aabb.height
}

export function isFlowDragSlot(value: unknown): value is FlowDragSlot {
  if (exactDataObject(value, ['presence']) && value.presence === 'absent') return true
  return exactDataObject(value, ['presence', 'value']) && value.presence === 'present'
    && typeof value.value === 'string' && value.value.length <= 128
}

export function isFlowDragLane(value: unknown): value is FlowDragLane {
  return exactDataObject(value, ['parentId', 'slot']) && validId(value.parentId) && isFlowDragSlot(value.slot)
}

function relationship(value: unknown): value is FlowDragRelationship {
  return exactDataObject(value, ['parentId', 'orderKey', 'slot']) && validId(value.parentId)
    && typeof value.orderKey === 'string' && value.orderKey.length >= 1 && value.orderKey.length <= 256 && isFlowDragSlot(value.slot)
}

export function isFlowDragSourceFence(value: unknown): value is FlowDragSourceFence {
  return exactDataObject(value, ['fileId', 'fileRevision', 'measurementRevision', 'documentRevision', 'layoutGeneration', 'pageId', 'pageRootId'])
    && validId(value.fileId) && validId(value.pageId) && validId(value.pageRootId)
    && flowInteger(value.fileRevision) && flowInteger(value.measurementRevision) && flowInteger(value.documentRevision)
    && value.fileRevision === value.documentRevision && flowInteger(value.layoutGeneration)
}

export function isFlowDragPresentationKey(value: unknown): value is FlowDragPresentationKey {
  return exactDataObject(value, ['interactionId', 'gestureGeneration', 'sequence']) && validId(value.interactionId)
    && flowInteger(value.gestureGeneration) && flowInteger(value.sequence) && (value.sequence as number) > 0
}

function sameFence(left: FlowDragSourceFence, right: FlowDragSourceFence): boolean {
  return left.fileId === right.fileId && left.fileRevision === right.fileRevision && left.measurementRevision === right.measurementRevision
    && left.documentRevision === right.documentRevision && left.layoutGeneration === right.layoutGeneration
    && left.pageId === right.pageId && left.pageRootId === right.pageRootId
}

function sameSlot(left: FlowDragSlot, right: FlowDragSlot): boolean {
  return left.presence === right.presence && (left.presence === 'absent' || right.presence === 'present' && left.value === right.value)
}

function sameRelationship(left: FlowDragRelationship, right: FlowDragRelationship): boolean {
  return left.parentId === right.parentId && left.orderKey === right.orderKey && sameSlot(left.slot, right.slot)
}

function retention(value: unknown, gestureGeneration: number, sampleSequence: number): boolean {
  if (exactDataObject(value, ['kind', 'gestureGeneration', 'sampleSequence']) && value.kind === 'active') {
    return value.gestureGeneration === gestureGeneration && value.sampleSequence === sampleSequence
  }
  return exactDataObject(value, ['kind', 'gestureGeneration', 'sampleSequence', 'terminalReason', 'terminalSampleSequence', 'holdUntil'])
    && value.kind === 'terminal-retained' && value.gestureGeneration === gestureGeneration && value.sampleSequence === sampleSequence
    && value.terminalSampleSequence === sampleSequence && ['pointer-up', 'escape-after-threshold', 'pointercancel-after-threshold'].includes(value.terminalReason as string)
    && value.holdUntil === 'authoritative-geometry'
}

function domTreatment(value: unknown, expected: 'drag-dimmed' | 'drag-elevated' | 'unchanged'): boolean {
  if (!exactDataObject(value, ['treatment', 'opacity', 'opacityPriority', 'zIndex']) || value.treatment !== expected) return false
  if (expected === 'drag-dimmed') return value.opacity === 0.6 && value.opacityPriority === 'important' && value.zIndex === null
  if (expected === 'drag-elevated') return value.opacity === 0.6 && value.opacityPriority === 'normal' && value.zIndex === 1000000
  return value.opacity === null && value.opacityPriority === 'normal' && value.zIndex === null
}

function authoritativeSource(value: unknown): value is FlowDragAuthoritativeSource {
  return exactDataObject(value, ['kind', 'relationship', 'sourceIndex'])
    && ['component', 'frame', 'rectangle', 'shape', 'shader', 'text'].includes(value.kind as string)
    && exactDataObject(value.relationship, ['parentId', 'orderKey', 'slot']) && validId(value.relationship.parentId)
    && (value.relationship.orderKey === null || typeof value.relationship.orderKey === 'string' && value.relationship.orderKey.length >= 1 && value.relationship.orderKey.length <= 256)
    && isFlowDragSlot(value.relationship.slot) && flowInteger(value.sourceIndex)
}

function authorityMatchesFence(authority: FlowDragTopologyAuthority, fence: FlowDragSourceFence): boolean {
  return authority.fileId === fence.fileId && authority.fileRevision === fence.fileRevision
    && authority.pageId === fence.pageId && authority.pageRootId === fence.pageRootId
}

function validateFlowDragPresentationWire(
  value: unknown,
  key: FlowDragPresentationKey,
  sourceFence: FlowDragSourceFence,
  authority?: FlowDragTopologyAuthority,
): value is FlowDragPresentation {
  if (!isFlowDragPresentationKey(key) || !isFlowDragSourceFence(sourceFence)
    || authority !== undefined && !authorityMatchesFence(authority, sourceFence)) return false
  if (!exactDataObject(value, ['kind', 'coordinateSpace', 'identity', 'fence', 'retention', 'pointer', 'original', 'movingVisual', 'supportClone', 'target', 'hud', 'mobileQuickActions'])
    || value.kind !== 'flow-drag' || value.coordinateSpace !== 'world') return false
  if (!exactDataObject(value.identity, ['interactionId', 'gestureGeneration', 'sampleSequence'])
    || value.identity.interactionId !== key.interactionId || value.identity.gestureGeneration !== key.gestureGeneration || value.identity.sampleSequence !== key.sequence) return false
  if (!isFlowDragSourceFence(value.fence) || !sameFence(value.fence, sourceFence) || !retention(value.retention, key.gestureGeneration, key.sequence)) return false
  if (!exactDataObject(value.pointer, ['downWorld', 'currentWorld']) || !point(value.pointer.downWorld) || !point(value.pointer.currentWorld)) return false
  if (!exactDataObject(value.original, ['documentNodeId', 'kind', 'name', 'sourceRelationship', 'sourceIndex', 'mode', 'source', 'current', 'sourceOffsetParentPose', 'dom', 'namePresentation'])) return false
  const original = value.original
  const source = original.source
  const current = original.current
  if (!validId(original.documentNodeId) || !['component', 'frame', 'rectangle', 'shape', 'shader', 'text'].includes(original.kind as string)
    || typeof original.name !== 'string' || original.name.trim() !== original.name || original.name.length < 1 || original.name.length > 256
    || !relationship(original.sourceRelationship) || !flowInteger(original.sourceIndex) || !['flow', 'absolute'].includes(original.mode as string)
    || !geometry(source) || !geometry(current)) return false
  if (authority !== undefined) {
    const topology = authority.source(original.documentNodeId as string)
    if (!authoritativeSource(topology) || topology.kind !== original.kind || topology.sourceIndex !== original.sourceIndex
      || topology.relationship.parentId !== original.sourceRelationship.parentId || !sameSlot(topology.relationship.slot, original.sourceRelationship.slot)
      || topology.relationship.orderKey !== null && topology.relationship.orderKey !== original.sourceRelationship.orderKey) return false
  }
  const delta = { x: value.pointer.currentWorld.x - value.pointer.downWorld.x, y: value.pointer.currentWorld.y - value.pointer.downWorld.y }
  if (!translatedGeometry(source, delta, current)) return false
  if (original.mode === 'flow') {
    if (original.sourceOffsetParentPose !== null || !domTreatment(original.dom, 'drag-dimmed')) return false
  } else {
    if (!exactDataObject(original.sourceOffsetParentPose, ['coordinateSpace', 'offsetParentNodeId', 'sourceOffsetParentPaddingToWorld', 'matrix'])
      || original.sourceOffsetParentPose.coordinateSpace !== 'source-offset-parent'
      || !matrix(original.sourceOffsetParentPose.sourceOffsetParentPaddingToWorld) || !matrix(original.sourceOffsetParentPose.matrix)) return false
    const expectedParent = original.sourceRelationship.parentId === sourceFence.pageRootId ? null : original.sourceRelationship.parentId
    if (original.sourceOffsetParentPose.offsetParentNodeId !== expectedParent) return false
    const projected = matrixQuad(composeMatrix(original.sourceOffsetParentPose.sourceOffsetParentPaddingToWorld, original.sourceOffsetParentPose.matrix), current.semanticSize)
    if (!samePoint(projected[0], current.quad[0]) || !samePoint(projected[1], current.quad[1])
      || !samePoint(projected[2], current.quad[2]) || !samePoint(projected[3], current.quad[3])) return false
    const elevated = value.target !== null && dataRecord(value.target) && value.target.parentId !== original.sourceRelationship.parentId && value.target.parentId !== sourceFence.pageRootId
    if (!domTreatment(original.dom, elevated ? 'drag-elevated' : 'unchanged')) return false
  }
  if (!exactDataObject(original.namePresentation, ['visible', 'anchor', 'pose']) || original.namePresentation.visible !== true
    || original.namePresentation.anchor !== (original.mode === 'flow' ? 'source' : 'current') || !geometry(original.namePresentation.pose)
    || !sameGeometry(original.namePresentation.pose, original.mode === 'flow' ? source : current)) return false

  if (!dataRecord(value.movingVisual)) return false
  if (original.mode === 'flow') {
    if (!exactDataObject(value.movingVisual, ['kind', 'documentNodeId', 'geometry', 'fill', 'hitTesting', 'a11y'])
      || value.movingVisual.kind !== 'fill-ghost' || value.movingVisual.documentNodeId !== null || !geometry(value.movingVisual.geometry)
      || !sameGeometry(value.movingVisual.geometry, current) || value.movingVisual.hitTesting !== 'none' || value.movingVisual.a11y !== 'hidden'
      || !exactDataObject(value.movingVisual.fill, ['kind', 'color', 'alpha']) || value.movingVisual.fill.kind !== 'fill-only'
      || value.movingVisual.fill.color !== 'oklch(0.67 0.17 258)' || value.movingVisual.fill.alpha !== 0.15) return false
  } else if (!exactDataObject(value.movingVisual, ['kind', 'documentNodeId', 'geometry']) || value.movingVisual.kind !== 'document-node'
    || value.movingVisual.documentNodeId !== original.documentNodeId || !geometry(value.movingVisual.geometry)
    || !sameGeometry(value.movingVisual.geometry, current)) return false

  if (value.supportClone !== null) {
    if (!exactDataObject(value.supportClone, ['key', 'documentNodeId', 'generation', 'sourceRelationship', 'sourceIndex', 'entryMode', 'entry', 'world', 'hiddenUntilCommit', 'role', 'layoutParticipation', 'hitTesting', 'a11y'])
      || !exactDataObject(value.supportClone.key, ['kind', 'interactionId', 'gestureGeneration', 'cloneGeneration'])
      || value.supportClone.key.kind !== 'flow-support-clone' || value.supportClone.key.interactionId !== key.interactionId
      || value.supportClone.key.gestureGeneration !== key.gestureGeneration || !flowInteger(value.supportClone.key.cloneGeneration)
      || value.supportClone.generation !== value.supportClone.key.cloneGeneration || value.supportClone.documentNodeId !== null
      || !relationship(value.supportClone.sourceRelationship) || !flowInteger(value.supportClone.sourceIndex)
      || !['flow', 'absolute'].includes(value.supportClone.entryMode as string) || !geometry(value.supportClone.world)
      || value.supportClone.hiddenUntilCommit !== true || value.supportClone.role !== 'inert-marker' || value.supportClone.layoutParticipation !== 'none'
      || value.supportClone.hitTesting !== 'none' || value.supportClone.a11y !== 'hidden'
      || value.supportClone.sourceIndex !== original.sourceIndex || !sameRelationship(value.supportClone.sourceRelationship, original.sourceRelationship)) return false
    if (value.supportClone.entryMode === 'flow') {
      if (value.supportClone.entry !== null) return false
    } else if (!exactDataObject(value.supportClone.entry, ['x', 'y', 'width', 'height', 'coordinateSpace'])
      || value.supportClone.entry.coordinateSpace !== 'parent-padding'
      || !rect({ x: value.supportClone.entry.x, y: value.supportClone.entry.y, width: value.supportClone.entry.width, height: value.supportClone.entry.height })) return false
  }

  if (value.target !== null) {
    if (!exactDataObject(value.target, ['parentId', 'slot', 'rawIndex', 'semanticIndex', 'line', 'parentOutline', 'insertionGuide'])
      || !validId(value.target.parentId) || value.target.parentId === original.documentNodeId || !isFlowDragSlot(value.target.slot)
      || !flowInteger(value.target.rawIndex) || !flowInteger(value.target.semanticIndex) || !flowInteger(value.target.line)) return false
    const targetTopology: FlowDragTargetTopology = {
      pageId: sourceFence.pageId,
      pageRootId: sourceFence.pageRootId,
      sourceNodeId: original.documentNodeId as string,
      sourceLane: { parentId: original.sourceRelationship.parentId, slot: original.sourceRelationship.slot },
      targetLane: { parentId: value.target.parentId as string, slot: value.target.slot },
      rawIndex: value.target.rawIndex as number,
      semanticIndex: value.target.semanticIndex as number,
      line: value.target.line as number,
    }
    if (authority !== undefined && !authority.acceptsTarget(targetTopology)) return false
    const differentNonRoot = value.target.parentId !== original.sourceRelationship.parentId && value.target.parentId !== sourceFence.pageRootId
    if (differentNonRoot) {
      if (!exactDataObject(value.target.parentOutline, ['coordinateSpace', 'quad', 'aabb', 'color', 'widthCssPx'])
        || value.target.parentOutline.coordinateSpace !== 'world' || !quad(value.target.parentOutline.quad) || !rect(value.target.parentOutline.aabb)
        || value.target.parentOutline.color !== 'oklch(0.67 0.17 258)' || value.target.parentOutline.widthCssPx !== 2) return false
      const outlineAabb = quadAabb(value.target.parentOutline.quad)
      if (!outlineAabb || !sameRect(outlineAabb, value.target.parentOutline.aabb)) return false
    } else if (value.target.parentOutline !== null) return false
    if (value.target.insertionGuide !== null && (!exactDataObject(value.target.insertionGuide, ['coordinateSpace', 'axis', 'position', 'start', 'end', 'color', 'widthCssPx', 'style'])
      || value.target.insertionGuide.coordinateSpace !== 'world' || !['x', 'y'].includes(value.target.insertionGuide.axis as string)
      || !finiteWithin(value.target.insertionGuide.position) || !finiteWithin(value.target.insertionGuide.start)
      || !finiteWithin(value.target.insertionGuide.end) || (value.target.insertionGuide.end as number) <= (value.target.insertionGuide.start as number)
      || value.target.insertionGuide.color !== 'oklch(0.67 0.17 258)' || value.target.insertionGuide.widthCssPx !== 4 || value.target.insertionGuide.style !== 'solid')) return false
  }
  if (!exactDataObject(value.hud, ['showDimensions', 'showSelectionOutline', 'showResizeHandles', 'showRotationHandles', 'interactiveHandleLayer'])
    || Object.values(value.hud).some(entry => entry !== false)) return false
  return exactDataObject(value.mobileQuickActions, ['mounted', 'hidden', 'inert', 'transition'])
    && value.mobileQuickActions.mounted === true && value.mobileQuickActions.hidden === true && value.mobileQuickActions.inert === true
    && exactDataObject(value.mobileQuickActions.transition, ['property', 'durationMs', 'source'])
    && value.mobileQuickActions.transition.property === 'opacity' && [0, 150].includes(value.mobileQuickActions.transition.durationMs as number)
    && value.mobileQuickActions.transition.source === 'wonder'
}

/** Exact descriptor-safe wire validation before a trusted document topology is available. */
export function validateFlowDragPresentationStructure(
  value: unknown,
  key: FlowDragPresentationKey,
  sourceFence: FlowDragSourceFence,
): value is FlowDragPresentation {
  return validateFlowDragPresentationWire(value, key, sourceFence)
}

/** Exact wire validation plus trusted document topology and target policy. */
export function validateFlowDragPresentation(
  value: unknown,
  key: FlowDragPresentationKey,
  sourceFence: FlowDragSourceFence,
  authority: FlowDragTopologyAuthority,
): value is FlowDragPresentation {
  return validateFlowDragPresentationWire(value, key, sourceFence, authority)
}
