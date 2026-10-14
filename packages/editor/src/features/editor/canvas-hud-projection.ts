import { nodeIsLocked, pageRoot } from '@canvas/repo-engine/file-document'
import { apply, invert, isFiniteMatrix, multiply, translation } from '@canvas/repo-engine/layout-matrix'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import type { CanvasTool } from './document-store'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import { localMatrixOf } from './layout-pose'
import type { Point, Rect, ResizeHandle, Size } from './canvas-math'
import type { ResizePresentation, ResizePresentationItem } from './resize-projection'
import type { MeasuredNode } from './scene-geometry'
import type { FlowDragPresentation, FlowDragWorldGeometry } from './flow-drag-presentation'

export type HudQuad = readonly [Readonly<Point>, Readonly<Point>, Readonly<Point>, Readonly<Point>]

export type HudProjectionKey = Readonly<{
  fileId: string
  pageId: string
  fileRevision: number
  measurementRevision: number
  documentRevision: number
  layoutGeneration: number
  camera: Readonly<{ x: number; y: number; zoom: number }>
  size: Readonly<Size>
  selection: readonly string[]
  hover: string | null
  tool: CanvasTool
  readOnly: boolean
  mobile: boolean
}>

export type HudProjectionView = HudProjectionKey

export type HudHandleAnchor = 'q0' | 'q0-q1' | 'q1' | 'q1-q2' | 'q2' | 'q2-q3' | 'q3' | 'q3-q0'

export type HudHandlePose = Readonly<{
  handle: ResizeHandle
  anchor: HudHandleAnchor
  center: Readonly<Point>
  rect: Readonly<Rect>
  size: number
  active: boolean
}>

export type HudLabelPose = Readonly<{
  start: Readonly<Point>
  end: Readonly<Point>
  normal: Readonly<Point>
  origin: Readonly<Point>
  angle: number
  maxWidth: number
}>

export type HudDimensionPose = Readonly<{
  anchor: Readonly<Point>
  width: number
  height: number
}>

export type HudNodePolicy = Readonly<{
  selected: boolean
  hovered: boolean
  locked: boolean
  readOnly: boolean
  showOutline: boolean
  showLabel: boolean
  showDimensions: boolean
  showHandles: boolean
  showQuickActions: boolean
}>

export type HudProjectionEntry = Readonly<{
  nodeId: string
  name: string
  kind: GestureAuthoritySnapshot['scene']['nodes'][number]['kind']
  parentId: string | null
  worldQuad: HudQuad
  worldAabb: Readonly<Rect>
  screenQuad: HudQuad
  screenAabb: Readonly<Rect>
  dimensions: Readonly<Size>
  policy: HudNodePolicy
  label: HudLabelPose
  dimension: HudDimensionPose
  handles: readonly [HudHandlePose, HudHandlePose, HudHandlePose, HudHandlePose, HudHandlePose, HudHandlePose, HudHandlePose, HudHandlePose]
  /** Empty for locked, read-only, multi-selection, and non-transform tools. */
  controls: readonly HudHandlePose[]
  effectiveHandle: ResizeHandle | null
}>

export type HudFlowDragCommittedReceipt = Readonly<{
  generation: number
  fileId: string
  pageId: string
  documentRevision: number
  layoutGeneration: number
  afterMeasurementRevision: number
  interactionId: string
  gestureGeneration: number
  terminalSequence: number
  sourceFence: FlowDragPresentation['fence']
}>

export type HudFlowDragProjection = Readonly<{
  kind: 'flow-drag-hud'
  identity: FlowDragPresentation['identity']
  retention: FlowDragPresentation['retention']
  movingVisualOwner: 'preview-runtime'
  movingVisualKind: FlowDragPresentation['movingVisual']['kind']
  supportCloneOwner: 'preview-runtime' | null
  documentNodeId: string
  currentSelectionQuad: HudQuad
  currentSelectionAabb: Readonly<Rect>
  name: Readonly<{
    nodeId: string
    text: string
    anchor: 'source' | 'current'
    quad: HudQuad
    pose: HudLabelPose
  }>
  target: Readonly<{
    parentId: string
    parentOutline: Readonly<{ quad: HudQuad; aabb: Readonly<Rect>; color: 'oklch(0.67 0.17 258)'; widthCssPx: 2 }> | null
    insertionGuide: Readonly<{ start: Readonly<Point>; end: Readonly<Point>; color: 'oklch(0.67 0.17 258)'; widthCssPx: 4; style: 'solid' }> | null
  }> | null
  hud: FlowDragPresentation['hud']
  mobileQuickActions: FlowDragPresentation['mobileQuickActions']
  terminalHold: Readonly<{
    kind: 'awaiting-committed-receipt' | 'awaiting-authoritative-geometry'
    receipt: HudFlowDragCommittedReceipt | null
  }> | null
}>

export type HudProjectionFrame = Readonly<{
  key: HudProjectionKey
  entries: readonly HudProjectionEntry[]
  byNodeId: Readonly<Record<string, HudProjectionEntry>>
  flowDrag: HudFlowDragProjection | null
}>

export type HudMovePresentation = Readonly<{
  rects: Readonly<Record<string, Readonly<Rect>>>
  offset: Readonly<Point>
}>

export type HudProjectionInput = Readonly<{
  authority: GestureAuthoritySnapshot
  view: HudProjectionView
  movePresentation?: HudMovePresentation | null
  resizePresentation?: ResizePresentation | null
  /** The exact pointer-down fence that produced `resizePresentation`. */
  resizeFence?: GestureAuthoritySnapshot['start']
  flowDragPresentation?: FlowDragPresentation | null
  flowDragReceipt?: HudFlowDragCommittedReceipt | null
}>

const desktopHandleSize = 7
const mobileHandleSize = 12
const labelGap = 7
const dimensionGap = 6
const aabbTolerance = 0.5
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const finitePoint = (point: Readonly<Point>): boolean => finite(point.x) && finite(point.y)
const finiteSize = (size: Readonly<Size>): boolean => finite(size.width) && finite(size.height) && size.width > 0 && size.height > 0
const finiteRect = (rect: Readonly<Rect>): boolean => finite(rect.x) && finite(rect.y) && finiteSize(rect)
const sameSize = (left: Readonly<Size>, right: Readonly<Size>) => left.width === right.width && left.height === right.height
const sameCamera = (left: HudProjectionKey['camera'], right: HudProjectionKey['camera']) => left.x === right.x && left.y === right.y && left.zoom === right.zoom
const sameOrdered = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index])
const close = (left: number, right: number, tolerance = aabbTolerance) => Math.abs(left - right) <= tolerance
const determinant = (matrix: Matrix) => matrix[0] * matrix[3] - matrix[1] * matrix[2]
const usableMatrix = (matrix: unknown): matrix is Matrix => isFiniteMatrix(matrix) && Math.abs(determinant(matrix)) >= 1e-12 && invert(matrix) !== null
const midpoint = (left: Readonly<Point>, right: Readonly<Point>): Point => ({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 })
const tools: readonly CanvasTool[] = ['move', 'scale', 'hand', 'frame', 'shader', 'text', 'rectangle', 'shape', 'interact']
const cleanZero = (value: number) => Object.is(value, -0) ? 0 : value

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

function usableQuad(quad: HudQuad): boolean {
  if (!quad.every(finitePoint)) return false
  const top = { x: quad[1].x - quad[0].x, y: quad[1].y - quad[0].y }
  const left = { x: quad[3].x - quad[0].x, y: quad[3].y - quad[0].y }
  return Math.abs(top.x * left.y - top.y * left.x) >= 1e-12
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function quadAabb(quad: HudQuad): Rect | null {
  if (!usableQuad(quad)) return null
  const xs = quad.map(point => point.x), ys = quad.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys)
  const rect = { x, y, width: right - x, height: bottom - y }
  return finiteRect(rect) ? rect : null
}

function sameAabb(left: Readonly<Rect>, right: Readonly<Rect>): boolean {
  return close(left.x, right.x) && close(left.y, right.y) && close(left.width, right.width) && close(left.height, right.height)
}

function sameExactAabb(left: Readonly<Rect>, right: Readonly<Rect>): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function measurementMatchesNode(snapshot: GestureAuthoritySnapshot, nodeId: string, measurement: MeasuredNode): boolean {
  const node = snapshot.file.nodes[nodeId]
  const sceneNode = snapshot.scene.byId.get(nodeId)
  const relationship = snapshot.file.relationships[nodeId]
  if (!node || node.type === 'root' || !sceneNode || !relationship || measurement.directChild !== true) return false
  if (!snapshot.scene.nodes.some(candidate => candidate === sceneNode) || snapshot.scene.nodes.filter(candidate => candidate.id === nodeId).length !== 1) return false
  if (measurement.documentRevision !== snapshot.start.documentRevision || measurement.layoutGeneration !== snapshot.start.layoutGeneration) return false
  if (node.type === 'component') {
    if (measurement.componentId !== node.componentId) return false
  } else if (measurement.canvasKind !== node.type) return false
  const parent = snapshot.file.nodes[relationship.parentId]
  if (!parent) return false
  const expectedParentNodeId = parent.type === 'root' ? null : parent.id
  if (sceneNode.parentId !== expectedParentNodeId || sceneNode.kind !== node.type || sceneNode.locked !== nodeIsLocked(snapshot.file, nodeId)) return false
  if (measurement.offsetParentNodeId === undefined || measurement.offsetParentNodeId !== expectedParentNodeId) return false
  if (node.type === 'component') {
    const expectedInstanceParent = parent.type === 'component' ? parent.id : null
    if (measurement.parentInstanceId === undefined || measurement.parentInstanceId !== expectedInstanceParent) return false
    if (measurement.offsetParentInstanceId === undefined || measurement.offsetParentInstanceId !== expectedInstanceParent) return false
  }
  if (!finiteRect(sceneNode.rect) || !finiteRect(measurement.rect)) return false
  return sameAabb(sceneNode.rect, measurement.rect)
}

function identityTransform(matrix: Matrix | undefined): boolean {
  return matrix === undefined || matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 && matrix[3] === 1 && matrix[4] === 0 && matrix[5] === 0
}

function measuredRectProjection(snapshot: GestureAuthoritySnapshot, nodeId: string): { quad: HudQuad; aabb: Rect; dimensions: Size } | null {
  const sceneNode = snapshot.scene.byId.get(nodeId)
  const measurement = snapshot.geometry.nodes[nodeId]
  const documentNode = snapshot.file.nodes[nodeId]
  if (!sceneNode || !measurement || !documentNode || documentNode.type === 'root' || !measurement.offset || !measurement.worldAabb) return null
  if (measurement.documentRevision !== snapshot.start.documentRevision || measurement.layoutGeneration !== snapshot.start.layoutGeneration || measurement.directChild !== true) return null
  if (documentNode.type === 'component' ? measurement.componentId !== documentNode.componentId : measurement.canvasKind !== documentNode.type) return null
  if (!finiteRect(sceneNode.rect) || !finiteRect(measurement.rect) || !finiteRect(measurement.worldAabb) || !finiteSize(measurement.offset)) return null
  if (!sameAabb(sceneNode.rect, measurement.rect)) return null
  if (!close(sceneNode.rect.width, measurement.offset.width) || !close(sceneNode.rect.height, measurement.offset.height)) return null
  let current = sceneNode.parentId ? snapshot.scene.byId.get(sceneNode.parentId) : undefined
  while (current) {
    if (current.rotation !== 0 || !identityTransform(snapshot.geometry.nodes[current.id]?.transform)) return null
    current = current.parentId ? snapshot.scene.byId.get(current.parentId) : undefined
  }
  const { x, y, width, height } = sceneNode.rect
  const transform = measurement.transform ?? [1, 0, 0, 1, 0, 0]
  if (!usableMatrix(transform) || !finitePoint(measurement.offset.origin)) return null
  const { origin } = measurement.offset
  const matrix = multiply(translation(x, y), multiply(translation(origin.x, origin.y), multiply(transform, translation(-origin.x, -origin.y))))
  const quad = [apply(matrix, { x: 0, y: 0 }), apply(matrix, { x: width, y: 0 }), apply(matrix, { x: width, y: height }), apply(matrix, { x: 0, y: height })] as HudQuad
  const aabb = quadAabb(quad)
  if (!aabb || !sameAabb(aabb, measurement.worldAabb)) return null
  return { quad, aabb, dimensions: { width, height } }
}

/** Exact measured border-box matrix. Every modeled ancestor and runtime topology edge must prove the same fence. */
function measuredBorderToWorld(snapshot: GestureAuthoritySnapshot, nodeId: string, visiting = new Set<string>()): Matrix | null {
  if (visiting.has(nodeId)) return null
  const measurement = snapshot.geometry.nodes[nodeId]
  const relationship = snapshot.file.relationships[nodeId]
  if (!measurement || !relationship || !measurementMatchesNode(snapshot, nodeId, measurement)) return null
  if (!measurement.offset || !finite(measurement.offset.x) || !finite(measurement.offset.y) || !finiteSize(measurement.offset) || !finitePoint(measurement.offset.origin)) return null
  if (measurement.transform !== undefined && !usableMatrix(measurement.transform)) return null
  const local = localMatrixOf(measurement)
  if (!local || !usableMatrix(local)) return null
  const parent = snapshot.file.nodes[relationship.parentId]
  if (!parent) return null
  if (parent.type === 'root') {
    const hostToWorld = measurement.offsetParentToRoot
    if (!usableMatrix(hostToWorld)) return null
    const result = multiply(hostToWorld, local)
    return usableMatrix(result) ? result : null
  }
  visiting.add(nodeId)
  const parentToWorld = measuredBorderToWorld(snapshot, parent.id, visiting)
  visiting.delete(nodeId)
  const border = snapshot.geometry.nodes[parent.id]?.box?.border
  if (!parentToWorld || !border || ![border.top, border.right, border.bottom, border.left].every(value => finite(value) && value >= 0)) return null
  const result = multiply(parentToWorld, multiply(translation(border.left, border.top), local))
  return usableMatrix(result) ? result : null
}

function measuredProjection(snapshot: GestureAuthoritySnapshot, nodeId: string): { quad: HudQuad; aabb: Rect; dimensions: Size } | null {
  const measurement = snapshot.geometry.nodes[nodeId]
  const matrix = measuredBorderToWorld(snapshot, nodeId)
  if (!measurement?.offset || !measurement.worldAabb || !matrix || !finiteRect(measurement.worldAabb)) return measuredRectProjection(snapshot, nodeId)
  const { width, height } = measurement.offset
  const points = [
    apply(matrix, { x: 0, y: 0 }),
    apply(matrix, { x: width, y: 0 }),
    apply(matrix, { x: width, y: height }),
    apply(matrix, { x: 0, y: height }),
  ] as const
  if (!points.every(finitePoint)) return null
  const quad = points as HudQuad
  const aabb = quadAabb(quad)
  if (!aabb || !sameAabb(aabb, measurement.worldAabb)) return measuredRectProjection(snapshot, nodeId)
  return { quad, aabb, dimensions: { width, height } }
}

function resizeProjection(item: ResizePresentationItem): { quad: HudQuad; aabb: Rect; dimensions: Size } | null {
  const quad = item.world.quad
  if (!finiteRect(item.rect) || !finiteRect(item.world.aabb) || !usableQuad(quad)) return null
  const aabb = quadAabb(quad)
  if (!aabb || !sameExactAabb(aabb, item.world.aabb)) return null
  const detached = quad.map(point => ({ x: point.x, y: point.y })) as unknown as HudQuad
  return { quad: detached, aabb, dimensions: { width: item.rect.width, height: item.rect.height } }
}

function moveProjection(
  projected: Readonly<{ quad: HudQuad; aabb: Rect; dimensions: Size }>,
  offset: Readonly<Point>,
): { quad: HudQuad; aabb: Rect; dimensions: Size } {
  return {
    quad: projected.quad.map(point => ({ x: point.x + offset.x, y: point.y + offset.y })) as unknown as HudQuad,
    aabb: { ...projected.aabb, x: projected.aabb.x + offset.x, y: projected.aabb.y + offset.y },
    dimensions: projected.dimensions,
  }
}

function toScreen(point: Readonly<Point>, camera: GestureAuthoritySnapshot['camera'], size: GestureAuthoritySnapshot['size']): Point {
  return {
    x: size.width / 2 + camera.x + point.x * camera.zoom,
    y: size.height / 2 + camera.y + point.y * camera.zoom,
  }
}

function flowGeometryToScreen(geometry: FlowDragWorldGeometry, camera: GestureAuthoritySnapshot['camera'], size: GestureAuthoritySnapshot['size']): { quad: HudQuad; aabb: Rect } | null {
  const quad = geometry.quad.map(point => toScreen(point, camera, size)) as unknown as HudQuad
  const aabb = quadAabb(quad)
  return aabb ? { quad, aabb } : null
}

function topFace(quad: HudQuad): Omit<HudLabelPose, 'origin'> {
  const winding = quad.reduce((area, point, index) => {
    const next = quad[(index + 1) % 4]!
    return area + point.x * next.y - next.x * point.y
  }, 0)
  const faces = quad.map((start, index) => {
    const end = quad[(index + 1) % 4]!
    const dx = end.x - start.x, dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    const rawNormal = winding > 0 ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length }
    const normal = { x: cleanZero(rawNormal.x), y: cleanZero(rawNormal.y) }
    return { start, end, normal, angle: Math.atan2(dy, dx), maxWidth: Math.max(48, length) }
  })
  let face = faces[0]!
  for (const candidate of faces.slice(1)) if (candidate.normal.y < face.normal.y) face = candidate
  if (Math.cos(face.angle) >= 0) return face
  return { ...face, start: face.end, end: face.start, angle: face.angle > 0 ? face.angle - Math.PI : face.angle + Math.PI }
}

function handles(quad: HudQuad, size: number, effectiveHandle: ResizeHandle | null): HudProjectionEntry['handles'] {
  const anchors = [quad[0], midpoint(quad[0], quad[1]), quad[1], midpoint(quad[1], quad[2]), quad[2], midpoint(quad[2], quad[3]), quad[3], midpoint(quad[3], quad[0])] as const
  const names = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left'] as const
  const semantic = ['q0', 'q0-q1', 'q1', 'q1-q2', 'q2', 'q2-q3', 'q3', 'q3-q0'] as const
  return anchors.map((center, index) => ({
    handle: names[index]!, anchor: semantic[index]!, center,
    rect: { x: center.x - size / 2, y: center.y - size / 2, width: size, height: size },
    size, active: names[index] === effectiveHandle,
  })) as unknown as HudProjectionEntry['handles']
}

function validView(authority: GestureAuthoritySnapshot, view: HudProjectionView): boolean {
  return view.fileId === authority.start.fileId
    && view.fileId === authority.file.fileId
    && view.pageId === authority.pageId
    && view.fileRevision === authority.start.fileRevision
    && view.fileRevision === authority.file.revision
    && view.measurementRevision === authority.start.measurementRevision
    && view.measurementRevision === authority.geometry.revision
    && view.documentRevision === authority.start.documentRevision
    && view.documentRevision === authority.geometry.documentRevision
    && view.layoutGeneration === authority.start.layoutGeneration
    && view.layoutGeneration === authority.layoutGeneration
    && generation(view.fileRevision)
    && generation(view.measurementRevision)
    && generation(view.documentRevision)
    && generation(view.layoutGeneration)
    && finite(view.camera.x)
    && finite(view.camera.y)
    && finite(view.camera.zoom)
    && view.camera.zoom > 0
    && finiteSize(view.size)
    && sameCamera(view.camera, authority.camera)
    && sameSize(view.size, authority.size)
    && sameOrdered(view.selection, authority.selection)
    && tools.includes(view.tool)
    && typeof view.readOnly === 'boolean'
    && typeof view.mobile === 'boolean'
}

function validResize(authority: GestureAuthoritySnapshot, resize: ResizePresentation | null | undefined, fence: GestureAuthoritySnapshot['start'] | undefined): boolean {
  if (!resize) return fence === undefined
  const fenceKeys: readonly (keyof GestureAuthoritySnapshot['start'])[] = ['fileId', 'fileRevision', 'measurementRevision', 'documentRevision', 'layoutGeneration']
  if (!fence || Object.keys(fence).length !== fenceKeys.length || !fenceKeys.every(key => fence[key] === authority.start[key])) return false
  if (authority.selection.length !== 1 || resize.selectedNodeId !== authority.selection[0] || resize.items.length < 1) return false
  if (resize.byNodeId[resize.selectedNodeId] === undefined) return false
  if (Object.keys(resize.byNodeId).length !== resize.items.length) return false
  return resize.items.every(item => {
    const relationship = authority.file.relationships[item.nodeId]
    return resize.byNodeId[item.nodeId] === item
      && authority.scene.byId.has(item.nodeId)
      && item.coordinateSpace === 'parent-padding'
      && relationship?.parentId === item.parentId
  })
}

function validMove(authority: GestureAuthoritySnapshot, move: HudMovePresentation | null | undefined): boolean {
  if (!move) return true
  if (!finitePoint(move.offset)) return false
  const entries = Object.entries(move.rects)
  if (!entries.length || entries.length > authority.selection.length) return false
  const selection = new Set(authority.selection)
  return entries.every(([nodeId, rect]) => {
    const node = authority.scene.byId.get(nodeId)
    return selection.has(nodeId) && Boolean(node) && finiteRect(rect)
      && close(rect.width, node!.rect.width) && close(rect.height, node!.rect.height)
      && close(rect.x, node!.rect.x + move.offset.x) && close(rect.y, node!.rect.y + move.offset.y)
  })
}

function sameFence(presentation: FlowDragPresentation, authority: GestureAuthoritySnapshot): boolean {
  return presentation.fence.fileId === authority.start.fileId
    && presentation.fence.pageId === authority.pageId
    && presentation.fence.pageRootId === pageRoot(authority.file, authority.pageId)
    && presentation.fence.fileRevision === authority.start.fileRevision
    && presentation.fence.measurementRevision === authority.start.measurementRevision
    && presentation.fence.documentRevision === authority.start.documentRevision
    && presentation.fence.layoutGeneration === authority.start.layoutGeneration
}

function sameFlowGeometry(left: FlowDragWorldGeometry, right: FlowDragWorldGeometry): boolean {
  return left.coordinateSpace === 'world' && right.coordinateSpace === 'world'
    && left.quad.every((point, index) => point.x === right.quad[index]!.x && point.y === right.quad[index]!.y)
    && left.aabb.x === right.aabb.x && left.aabb.y === right.aabb.y && left.aabb.width === right.aabb.width && left.aabb.height === right.aabb.height
    && left.semanticSize.width === right.semanticSize.width && left.semanticSize.height === right.semanticSize.height
}

function validFlowDrag(authority: GestureAuthoritySnapshot, presentation: FlowDragPresentation | null | undefined, receipt: HudFlowDragCommittedReceipt | null | undefined): boolean {
  if (!presentation) return receipt === undefined || receipt === null
  if (!deeplyFrozen(presentation) || !sameFence(presentation, authority)) return false
  if (authority.selection.length !== 1 || authority.selection[0] !== presentation.original.documentNodeId) return false
  const node = authority.scene.byId.get(presentation.original.documentNodeId)
  if (!node || node.kind !== presentation.original.kind || node.name !== presentation.original.name) return false
  const duplicatePreview = presentation.supportClone !== null && presentation.movingVisual.kind === 'document-node'
  const expectedNameAnchor = presentation.original.mode === 'flow' ? 'source' : 'current'
  const expectedNameGeometry = presentation.original.mode === 'flow' ? presentation.original.source : presentation.original.current
  if (presentation.original.namePresentation.visible !== true
    || presentation.original.namePresentation.anchor !== expectedNameAnchor
    || !sameFlowGeometry(presentation.original.namePresentation.pose, expectedNameGeometry)) return false
  if (duplicatePreview) {
    if (presentation.movingVisual.kind !== 'document-node' || presentation.movingVisual.documentNodeId !== presentation.original.documentNodeId
      || !sameFlowGeometry(presentation.movingVisual.geometry, presentation.original.current)) return false
  } else if (presentation.original.mode === 'flow') {
    if (presentation.movingVisual.kind !== 'fill-ghost' || !sameFlowGeometry(presentation.movingVisual.geometry, presentation.original.current)) return false
  } else if (presentation.movingVisual.kind !== 'document-node' || presentation.movingVisual.documentNodeId !== presentation.original.documentNodeId
    || !sameFlowGeometry(presentation.movingVisual.geometry, presentation.original.current)) return false
  if (presentation.hud.showDimensions || presentation.hud.showSelectionOutline || presentation.hud.showResizeHandles
    || presentation.hud.showRotationHandles || presentation.hud.interactiveHandleLayer
    || !presentation.mobileQuickActions.mounted || !presentation.mobileQuickActions.hidden || !presentation.mobileQuickActions.inert) return false
  if (presentation.identity.gestureGeneration !== presentation.retention.gestureGeneration
    || presentation.identity.sampleSequence !== presentation.retention.sampleSequence) return false
  if (presentation.retention.kind === 'active') return receipt === undefined || receipt === null
  if (!receipt) return true
  return deeplyFrozen(receipt)
    && receipt.interactionId === presentation.identity.interactionId
    && receipt.gestureGeneration === presentation.identity.gestureGeneration
    && receipt.terminalSequence === presentation.retention.terminalSampleSequence
    && receipt.sourceFence.fileId === presentation.fence.fileId
    && receipt.sourceFence.pageId === presentation.fence.pageId
    && receipt.sourceFence.pageRootId === presentation.fence.pageRootId
    && receipt.sourceFence.fileRevision === presentation.fence.fileRevision
    && receipt.sourceFence.measurementRevision === presentation.fence.measurementRevision
    && receipt.sourceFence.documentRevision === presentation.fence.documentRevision
    && receipt.sourceFence.layoutGeneration === presentation.fence.layoutGeneration
}

function flowDragProjection(authority: GestureAuthoritySnapshot, presentation: FlowDragPresentation, receipt: HudFlowDragCommittedReceipt | null | undefined): HudFlowDragProjection | null {
  const current = flowGeometryToScreen(presentation.original.current, authority.camera, authority.size)
  const name = flowGeometryToScreen(presentation.original.namePresentation.pose, authority.camera, authority.size)
  if (!current || !name) return null
  const face = topFace(name.quad)
  let target: HudFlowDragProjection['target'] = null
  if (presentation.target) {
    const outline = presentation.target.parentOutline
      ? flowGeometryToScreen({
          coordinateSpace: 'world',
          quad: presentation.target.parentOutline.quad,
          aabb: presentation.target.parentOutline.aabb,
          semanticSize: { width: presentation.target.parentOutline.aabb.width, height: presentation.target.parentOutline.aabb.height },
        }, authority.camera, authority.size)
      : null
    if (presentation.target.parentOutline && !outline) return null
    const guide = presentation.target.insertionGuide
    const insertionGuide = guide ? {
      start: toScreen(guide.axis === 'x' ? { x: guide.position, y: guide.start } : { x: guide.start, y: guide.position }, authority.camera, authority.size),
      end: toScreen(guide.axis === 'x' ? { x: guide.position, y: guide.end } : { x: guide.end, y: guide.position }, authority.camera, authority.size),
      color: guide.color,
      widthCssPx: guide.widthCssPx,
      style: guide.style,
    } as const : null
    target = {
      parentId: presentation.target.parentId,
      parentOutline: outline && presentation.target.parentOutline ? {
        quad: outline.quad,
        aabb: outline.aabb,
        color: presentation.target.parentOutline.color,
        widthCssPx: presentation.target.parentOutline.widthCssPx,
      } : null,
      insertionGuide,
    }
  }
  return {
    kind: 'flow-drag-hud',
    identity: structuredClone(presentation.identity),
    retention: structuredClone(presentation.retention),
    movingVisualOwner: 'preview-runtime',
    movingVisualKind: presentation.movingVisual.kind,
    supportCloneOwner: presentation.supportClone ? 'preview-runtime' : null,
    documentNodeId: presentation.original.documentNodeId,
    currentSelectionQuad: current.quad,
    currentSelectionAabb: current.aabb,
    name: {
      nodeId: presentation.original.documentNodeId,
      text: presentation.original.name,
      anchor: presentation.original.namePresentation.anchor,
      quad: name.quad,
      pose: { ...face, origin: { x: face.start.x + face.normal.x * labelGap, y: face.start.y + face.normal.y * labelGap } },
    },
    target,
    hud: structuredClone(presentation.hud),
    mobileQuickActions: structuredClone(presentation.mobileQuickActions),
    terminalHold: presentation.retention.kind === 'terminal-retained' ? {
      kind: receipt ? 'awaiting-authoritative-geometry' : 'awaiting-committed-receipt',
      receipt: receipt ? structuredClone(receipt) : null,
    } : null,
  }
}

/**
 * Builds the sole renderer-neutral HUD geometry frame from one coherent authority snapshot.
 * Any fence, view, topology, or quad failure rejects the whole frame so renderers never mix generations.
 */
export function projectHudFrame(input: HudProjectionInput): HudProjectionFrame | null {
  const { authority, view, movePresentation, resizePresentation, resizeFence, flowDragPresentation, flowDragReceipt } = input
  if (!validView(authority, view) || !validMove(authority, movePresentation) || !validResize(authority, resizePresentation, resizeFence) || !validFlowDrag(authority, flowDragPresentation, flowDragReceipt)) return null
  if ([movePresentation, resizePresentation, flowDragPresentation].filter(Boolean).length > 1) return null
  if (view.hover !== null && !authority.scene.byId.has(view.hover)) return null
  const selection = new Set(view.selection)
  if (selection.size !== view.selection.length || view.selection.some(id => !authority.scene.byId.has(id))) return null
  const flowDrag = flowDragPresentation ? flowDragProjection(authority, flowDragPresentation, flowDragReceipt) : null
  if (flowDragPresentation && !flowDrag) return null
  const key: HudProjectionKey = {
    fileId: view.fileId, pageId: view.pageId, fileRevision: view.fileRevision,
    measurementRevision: view.measurementRevision, documentRevision: view.documentRevision,
    layoutGeneration: view.layoutGeneration, camera: { ...view.camera }, size: { ...view.size },
    selection: [...view.selection], hover: view.hover, tool: view.tool, readOnly: view.readOnly, mobile: view.mobile,
  }
  const entries: HudProjectionEntry[] = []
  const byNodeId: Record<string, HudProjectionEntry> = {}
  for (const node of authority.scene.nodes) {
    const activeItem = resizePresentation?.byNodeId[node.id]
    const activeFlowNode = flowDrag && node.id === flowDrag.documentNodeId
    const baseProjection = activeFlowNode
      ? { quad: flowDragPresentation!.original.current.quad, aabb: flowDragPresentation!.original.current.aabb, dimensions: {
          width: flowDragPresentation!.original.current.semanticSize.width,
          height: flowDragPresentation!.original.current.semanticSize.height,
        } }
      : activeItem ? resizeProjection(activeItem) : measuredProjection(authority, node.id)
    const moved = movePresentation?.rects[node.id]
    const projected = baseProjection && moved ? moveProjection(baseProjection, movePresentation!.offset) : baseProjection
    if (!projected) return null
    const screenQuad = projected.quad.map(point => toScreen(point, authority.camera, authority.size)) as unknown as HudQuad
    const screenAabb = quadAabb(screenQuad)
    if (!screenAabb) return null
    const selected = selection.has(node.id), hovered = view.hover === node.id
    const locked = nodeIsLocked(authority.file, node.id)
    if (locked !== node.locked) return null
    const singleSelection = selected && view.selection.length === 1
    const transforms = view.tool === 'move' || view.tool === 'scale'
    const interactive = singleSelection && transforms && !view.readOnly && !locked
    const effectiveHandle = activeItem && node.id === resizePresentation?.selectedNodeId ? resizePresentation.effectiveHandle : null
    const handlePoses = handles(screenQuad, view.mobile ? mobileHandleSize : desktopHandleSize, effectiveHandle)
    const face = topFace(screenQuad)
    const policy: HudNodePolicy = activeFlowNode ? {
      selected, hovered: false, locked, readOnly: view.readOnly,
      showOutline: flowDragPresentation!.hud.showSelectionOutline,
      showLabel: false,
      showDimensions: flowDragPresentation!.hud.showDimensions,
      showHandles: flowDragPresentation!.hud.showResizeHandles || flowDragPresentation!.hud.showRotationHandles,
      showQuickActions: false,
    } : {
      selected, hovered, locked, readOnly: view.readOnly,
      showOutline: selected || hovered,
      showLabel: node.parentId === null && (node.kind === 'frame' || node.kind === 'component'),
      showDimensions: singleSelection,
      showHandles: interactive,
      showQuickActions: interactive && view.mobile,
    }
    const entry: HudProjectionEntry = {
      nodeId: node.id, name: node.name, kind: node.kind, parentId: node.parentId,
      worldQuad: projected.quad, worldAabb: projected.aabb,
      screenQuad, screenAabb, dimensions: projected.dimensions, policy,
      label: activeFlowNode ? flowDrag!.name.pose : { ...face, origin: { x: face.start.x + face.normal.x * labelGap, y: face.start.y + face.normal.y * labelGap } },
      dimension: { anchor: { x: screenAabb.x + screenAabb.width / 2, y: screenAabb.y + screenAabb.height + dimensionGap }, ...projected.dimensions },
      handles: handlePoses,
      controls: activeFlowNode || !interactive ? [] : handlePoses,
      effectiveHandle,
    }
    entries.push(entry)
    byNodeId[node.id] = entry
  }
  return deepFreeze({ key, entries, byNodeId, flowDrag })
}
