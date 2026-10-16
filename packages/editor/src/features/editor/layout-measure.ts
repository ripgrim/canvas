/**
 * Pure derivations from the last preview measurement for the layout inspector: per-node sizing targets (measured size
 * and parent content size per axis), the parent-local point used when a node leaves the flow, measured children and
 * Grid tracks for container conversions, and the sizing availability context. Nothing here reads the DOM or a store.
 */
import { acceptsChild, childrenOf, descendantsOf, flowHost, nodeChildDisplay, nodeIsLocked, nodePositionMode, pageRoot } from '@canvas/repo-engine/file-document'
import type { FileDocument, NodeRelationship } from '@canvas/repo-engine/file-document'
import { validId } from '@canvas/repo-engine/document'
import type { FlexAnalysisChild, FlexAnalysisKind, FlexInferenceInput, Point, Rect, Size } from '@canvas/repo-engine/flex-inference'
import { aboutOrigin, apply, identity, invert, isFiniteMatrix, multiply, translation } from '@canvas/repo-engine/layout-matrix'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import { availableSizingModes, sizingModes } from '@canvas/repo-engine/layout'
import type { FlexDirection, LayoutLength, NodeLayout, SizingContext, SizingMode } from '@canvas/repo-engine/layout'
import { snapshotPaperSizing } from '@canvas/repo-engine/paper-sizing'
import type { PaperSizingSnapshot } from '@canvas/repo-engine/paper-sizing'
import type { LayoutStatus, PreviewLayoutReport } from '@canvas/preview-runtime/protocol'
import type { Axis, SizingTarget } from './layout-commands'
import type { MeasuredChildren } from './layout-flex-commands'
import type { MeasuredGrid } from './layout-grid-commands'
import type { Scene } from './canvas-scene'
import type { GestureAuthoritySnapshot, ResizeGeometryAuthority } from './gesture-authority'
import type { MeasuredNode, SceneGeometry } from './scene-geometry'
import { localMatrixOf } from './layout-pose'
import { transformedBounds } from '@canvas/repo-engine/transform-matrix'

/** The measurement the inspector reads: measured roots plus the statuses of nodes without one. */
export type LayoutGeometry = { nodes: Record<string, MeasuredNode>; unsupported: Record<string, LayoutStatus>; documentRevision?: number | null; layoutGeneration?: number | null }

export type PaperDirectAddGeometry = Readonly<{
  input: FlexInferenceInput
  parentSnapshot: PaperSizingSnapshot
  childSnapshots: Readonly<Record<string, PaperSizingSnapshot>>
}>

export type PaperRemoveFlexChildGeometry = Readonly<{
  nodeId: string
  snapshot: PaperSizingSnapshot
  sourceRelationship: Readonly<NodeRelationship>
  parentLocalPosition: Readonly<Point>
  measured: Readonly<Size>
}>

export type PaperRemoveFlexGeometry = Readonly<{
  parentSnapshot: PaperSizingSnapshot
  parentBorderBox: Readonly<Size>
  parentBorder: Readonly<{ top: number; right: number; bottom: number; left: number }>
  /** Browser-resolved padding for geometry only. Authored base padding remains in `parentSnapshot.sourceLayout.spacing`. */
  parentResolvedPadding: Readonly<{ top: number; right: number; bottom: number; left: number }>
  flowChildren: readonly PaperRemoveFlexChildGeometry[]
}>

export type PaperFlowAbsoluteDropFence = Readonly<{
  fileId: string
  fileRevision: number
  measurementRevision: number
  documentRevision: number
  layoutGeneration: number
}>

export type PaperFlowAbsoluteDropInput = Readonly<{
  file: FileDocument
  scene: Scene
  geometry: SceneGeometry
  fence: PaperFlowAbsoluteDropFence
  childId: string
  parentId: string
  pointerDownWorld: Readonly<Point>
  terminalWorld: Readonly<Point>
}>

export type PaperParentPaddingRect = Readonly<Rect & { coordinateSpace: 'parent-padding' }>

export type PaperFlowCrossParentAbsoluteDropInput = Readonly<{
  snapshot: GestureAuthoritySnapshot
  childId: string
  targetParentId: string
  targetSlot?: string
  pointerDownWorld: Readonly<Point>
  terminalWorld: Readonly<Point>
}>

export type ResizeWorldQuad = readonly [Readonly<Point>, Readonly<Point>, Readonly<Point>, Readonly<Point>]
export type ResizeWorldProjection = Readonly<{ quad: ResizeWorldQuad; aabb: Readonly<Rect> }>

/** Preview AABBs are serialized layout pixels, so subpixel browser rounding may differ by at most half a pixel. */
export const resizeGeometryAabbTolerance = 0.5

/** Root children sit in the legacy flow host; its content box is the host width minus its padding, with no definite height. */
export const legacyHostContentWidth = flowHost.width - flowHost.padding * 2

const positive = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value)
const positiveOffset = (measurement: MeasuredNode): measurement is MeasuredNode & { offset: NonNullable<MeasuredNode['offset']> } => Boolean(
  measurement.offset
  && finite(measurement.offset.x)
  && finite(measurement.offset.y)
  && positive(measurement.offset.width)
  && positive(measurement.offset.height),
)
const parentIdOf = (file: FileDocument, id: string): string | null => file.relationships[id]?.parentId ?? null
export const isRootChild = (file: FileDocument, id: string): boolean => { const parentId = parentIdOf(file, id); return parentId !== null && file.nodes[parentId]?.type === 'root' }
export const layoutOf = (file: FileDocument, id: string): NodeLayout | undefined => { const node = file.nodes[id]; return node?.type === 'component' ? node.layout : undefined }
const sidesOf = (axis: Axis) => axis === 'width' ? (['left', 'right'] as const) : (['top', 'bottom'] as const)

/** Measured border-box size of a node on one axis, when the preview reported a positive one. */
export function measuredPx(geometry: LayoutGeometry, id: string, axis: Axis): number | undefined {
  const rect = geometry.nodes[id]?.rect
  const size = rect ? (axis === 'width' ? rect.width : rect.height) : undefined
  return positive(size) ? size : undefined
}

/**
 * The size a percentage on this node resolves against: the parent content box for flow nodes and the parent padding
 * box for absolute nodes (percent insets and sizes of absolute boxes use the containing block's padding edge).
 */
export function parentContentPx(file: FileDocument, geometry: LayoutGeometry, id: string, axis: Axis): number | undefined {
  const parentId = parentIdOf(file, id)
  if (parentId === null) return undefined
  if (file.nodes[parentId]?.type === 'root') return axis === 'width' ? legacyHostContentWidth : undefined
  const parent = geometry.nodes[parentId]
  if (!parent?.box) return undefined
  const [start, end] = sidesOf(axis)
  const absolute = layoutOf(file, id)?.item.position.mode === 'absolute'
  const outer = axis === 'width' ? parent.rect.width : parent.rect.height
  const inner = outer - parent.box.border[start] - parent.box.border[end] - (absolute ? 0 : parent.box.padding[start] + parent.box.padding[end])
  return positive(inner) ? inner : undefined
}

/** Direction of a Flex parent, so a definite main axis can apply the shrink rule; null for any other parent. */
export function parentDirection(file: FileDocument, id: string): FlexDirection | null {
  const parentId = parentIdOf(file, id)
  const container = parentId ? layoutOf(file, parentId)?.container : undefined
  return container?.display === 'flex' ? container.flex?.direction ?? null : null
}

/** One sizing target per selected component node, each with its own measurement (LAY-SIZE-003). */
export function sizingTargets(file: FileDocument, geometry: LayoutGeometry, ids: readonly string[], axis: Axis): SizingTarget[] {
  return ids.filter(id => file.nodes[id]?.type === 'component').map(id => {
    const measured = measuredPx(geometry, id, axis)
    const parent = parentContentPx(file, geometry, id, axis)
    const parentId = parentIdOf(file, id)
    const parentDisplay = parentId ? file.nodes[parentId]?.type === 'root' ? null : file.nodes[parentId]?.layout?.container?.display ?? 'freeform' : null
    const local = localPoint(file, geometry, id)
    return { id, layout: layoutOf(file, id), measurement: { ...(measured !== undefined ? { measuredPx: measured } : {}), ...(parent !== undefined ? { parentPx: parent } : {}) }, parentDisplay, parentDirection: parentDirection(file, id), ...(local ? { local } : {}) }
  })
}

/** A node in the legacy host has no layout parent; component nodes always have intrinsic content of their own. */
export function sizingContext(file: FileDocument, id: string): SizingContext {
  return { hasParent: parentIdOf(file, id) !== null && !isRootChild(file, id), intrinsicContent: file.nodes[id]?.type === 'component' }
}

/** Sizing modes every selected node supports (the intersection rule), in the canonical order. */
export function availableModes(file: FileDocument, ids: readonly string[]): SizingMode[] {
  const sets = ids.map(id => availableSizingModes(sizingContext(file, id)))
  return sizingModes.filter(mode => sets.length > 0 && sets.every(set => set.includes(mode)))
}

/**
 * Where a node sits relative to the box its insets count from: the parent padding edge for nested nodes (node rect
 * minus parent rect minus the parent border) and the world position for root children, whose px insets the preview
 * projection shifts by the host origin.
 */
export function localPoint(file: FileDocument, geometry: LayoutGeometry, id: string): { x: number; y: number } | undefined {
  const rect = geometry.nodes[id]?.rect
  if (!rect) return undefined
  if (isRootChild(file, id)) return { x: rect.x, y: rect.y }
  const parentId = parentIdOf(file, id)
  const parent = parentId ? geometry.nodes[parentId] : undefined
  if (!parent) return undefined
  return { x: rect.x - parent.rect.x - (parent.box?.border.left ?? 0), y: rect.y - parent.rect.y - (parent.box?.border.top ?? 0) }
}

/** The container's measured box and each modeled child that has a measured root. */
export function measuredChildren(file: FileDocument, geometry: LayoutGeometry, containerId: string): MeasuredChildren {
  const children: MeasuredChildren['children'] = {}
  for (const id of childrenOf(file, containerId)) { const rect = geometry.nodes[id]?.rect; if (rect) children[id] = rect }
  const border = geometry.nodes[containerId]?.box?.border
  return { container: geometry.nodes[containerId]?.rect ?? null, children, ...(border ? { border } : {}) }
}

/** Resolved Grid tracks and child rectangles, or null when the preview has not measured this node as a grid. */
export function measuredGrid(file: FileDocument, geometry: LayoutGeometry, containerId: string): MeasuredGrid | null {
  const node = geometry.nodes[containerId]
  if (!node?.grid) return null
  // Measured content alignment wins over the authored record, so stylesheet-only distributions model correctly.
  const distribution = { ...(node.grid.justifyContent !== undefined ? { justifyContent: node.grid.justifyContent } : {}), ...(node.grid.alignContent !== undefined ? { alignContent: node.grid.alignContent } : {}) }
  return { container: node.rect, grid: node.grid, children: measuredChildren(file, geometry, containerId).children, ...(node.box ? { border: node.box.border } : {}), ...(Object.keys(distribution).length ? { distribution } : {}) }
}

/** What the runtime reported for a node's authored layout; nodes without a measurable root report through `unsupported`. */
export function layoutReport(geometry: LayoutGeometry, id: string): PreviewLayoutReport | null {
  const reported = geometry.nodes[id]?.layout
  if (reported) return reported
  const status = geometry.unsupported[id]
  return status ? { status, conflicts: [] } : null
}

const exactProjection = (measurement: MeasuredNode | undefined, file: FileDocument, geometry: LayoutGeometry, expectedLayoutGeneration: number): measurement is MeasuredNode => Boolean(
  measurement
  && geometry.documentRevision === file.revision
  && geometry.layoutGeneration === expectedLayoutGeneration
  && measurement.documentRevision === file.revision
  && measurement.layoutGeneration === expectedLayoutGeneration,
)
const directMeasurement = (file: FileDocument, nodeId: string, measurement: MeasuredNode, expectedParentId: string): boolean => {
  const parent = file.nodes[expectedParentId]
  const node = file.nodes[nodeId]
  if (!parent || !node || node.type === 'root' || measurement.directChild !== true) return false
  if (node.type === 'component') {
    if (measurement.componentId !== node.componentId) return false
  } else if (measurement.canvasKind !== node.type) return false
  const expectedOffsetParent = parent.type === 'root' ? null : expectedParentId
  if (measurement.offsetParentNodeId === undefined || measurement.offsetParentNodeId !== expectedOffsetParent) return false
  if (node.type !== 'component') return true
  const expectedComponentParent = parent.type === 'component' ? expectedParentId : null
  return measurement.parentInstanceId !== undefined && measurement.parentInstanceId === expectedComponentParent
}

function paperSizingSnapshot(file: FileDocument, nodeId: string, measurement: MeasuredNode, measured: Size): PaperSizingSnapshot | null {
  const node = file.nodes[nodeId]
  if (!node || node.type === 'root') return null
  try {
    if (node.type === 'component') return snapshotPaperSizing({ nodeId, kind: 'component', layout: node.layout ?? null, measured })
    if (node.type === 'text') {
      if (!node.textStyle || !node.textSizing || !measurement.text) return null
      return snapshotPaperSizing({
        nodeId,
        kind: 'text',
        layout: node.layout ?? null,
        styles: { width: node.styles.width, height: node.styles.height },
        textStyle: node.textStyle,
        textSizing: node.textSizing,
        measured,
        resolvedLineHeight: measurement.text.resolvedLineHeight,
        editable: !nodeIsLocked(file, nodeId),
      })
    }
    return snapshotPaperSizing({ nodeId, kind: 'primitive', layout: node.layout ?? null, styles: { width: node.styles.width, height: node.styles.height }, measured })
  } catch {
    return null
  }
}
const sameMatrix = (left: Matrix, right: Matrix): boolean => left.every((value, index) => Math.abs(value - right[index]!) < 1e-9)
const paddingEdge = (measurement: MeasuredNode): Matrix => translation(measurement.box?.border.left ?? 0, measurement.box?.border.top ?? 0)

/**
 * Border-box-to-root matrix for a native document node. Unlike the component-only pose adapter, Wrap follows the
 * generic modeled parent chain and verifies every link against the same document/layout projection.
 */
function borderToRoot(file: FileDocument, geometry: LayoutGeometry, nodeId: string, expectedLayoutGeneration: number, visiting = new Set<string>()): Matrix | null {
  if (visiting.has(nodeId)) return null
  const node = file.nodes[nodeId]
  const measurement = geometry.nodes[nodeId]
  const relationship = file.relationships[nodeId]
  if (!node || node.type === 'root' || !relationship || !exactProjection(measurement, file, geometry, expectedLayoutGeneration) || measurement.directChild !== true) return null
  const local = localMatrixOf(measurement)
  if (!local) return null
  const parent = file.nodes[relationship.parentId]
  const expectedOffsetParent = parent?.type === 'root' ? null : relationship.parentId
  if (!parent || measurement.offsetParentNodeId === undefined || measurement.offsetParentNodeId !== expectedOffsetParent) return null
  if (expectedOffsetParent === null) {
    const hostToRoot = measurement.offsetParentToRoot ? [...measurement.offsetParentToRoot] as Matrix : null
    return hostToRoot ? multiply(hostToRoot, local) : null
  }
  visiting.add(nodeId)
  const parentToRoot = borderToRoot(file, geometry, relationship.parentId, expectedLayoutGeneration, visiting)
  visiting.delete(nodeId)
  return parentToRoot ? multiply(parentToRoot, multiply(paddingEdge(geometry.nodes[relationship.parentId]!), local)) : null
}

/** A proven inverse from semantic root/world coordinates into one parent frame's padding box. */
function worldToParentPadding(file: FileDocument, geometry: LayoutGeometry, parentId: string, expectedLayoutGeneration: number): Matrix | null {
  const parent = file.nodes[parentId]
  if (!parent) return null
  if (parent.type === 'root') return identity
  if (parent.type !== 'frame') return null
  const parentToRoot = borderToRoot(file, geometry, parentId, expectedLayoutGeneration)
  return parentToRoot ? invert(multiply(parentToRoot, paddingEdge(geometry.nodes[parentId]!))) : null
}

const finitePoint = (point: Readonly<Point>): boolean => finite(point.x) && finite(point.y)
const finiteRect = (rect: Readonly<Rect>): boolean => finite(rect.x) && finite(rect.y) && positive(rect.width) && positive(rect.height)
const sceneRectTolerance = resizeGeometryAabbTolerance
const sameRect = (left: Readonly<Rect>, right: Readonly<Rect>): boolean => (
  close(left.x, right.x, sceneRectTolerance)
  && close(left.y, right.y, sceneRectTolerance)
  && close(left.width, right.width, sceneRectTolerance)
  && close(left.height, right.height, sceneRectTolerance)
)

function exactSceneMeasurement(file: FileDocument, scene: Scene, geometry: SceneGeometry, nodeId: string): boolean {
  const node = file.nodes[nodeId]
  const relationship = file.relationships[nodeId]
  const measurement = geometry.nodes[nodeId]
  const sceneNode = scene.byId.get(nodeId)
  if (!node || node.type === 'root' || !relationship || !measurement || !sceneNode) return false
  if (!scene.nodes.some(candidate => candidate === sceneNode) || scene.nodes.filter(candidate => candidate.id === nodeId).length !== 1) return false
  const parent = file.nodes[relationship.parentId]
  if (!parent || !directMeasurement(file, nodeId, measurement, relationship.parentId)) return false
  const expectedSceneParent = parent.type === 'root' ? null : relationship.parentId
  if (sceneNode.kind !== node.type || sceneNode.parentId !== expectedSceneParent || sceneNode.locked !== nodeIsLocked(file, nodeId)) return false
  if (!finiteRect(sceneNode.rect) || !finiteRect(measurement.rect) || !sameRect(sceneNode.rect, measurement.rect)) return false
  if (node.type === 'component') {
    const expectedOffsetParentInstance = parent.type === 'component' ? relationship.parentId : null
    if (measurement.offsetParentInstanceId === undefined || measurement.offsetParentInstanceId !== expectedOffsetParentInstance) return false
  }
  return true
}

function strictBorderToRoot(file: FileDocument, scene: Scene, geometry: SceneGeometry, nodeId: string, fence: PaperFlowAbsoluteDropFence, visiting = new Set<string>()): Matrix | null {
  if (visiting.has(nodeId)) return null
  const relationship = file.relationships[nodeId]
  const measurement = geometry.nodes[nodeId]
  if (!relationship || !measurement || !exactProjection(measurement, file, geometry, fence.layoutGeneration)) return null
  if (!exactSceneMeasurement(file, scene, geometry, nodeId) || !positiveOffset(measurement) || !finitePoint(measurement.offset.origin)) return null
  if (measurement.transform && !isFiniteMatrix(measurement.transform)) return null
  const local = localMatrixOf(measurement)
  if (!local || !isFiniteMatrix(local)) return null
  const parent = file.nodes[relationship.parentId]
  if (!parent) return null
  if (parent.type === 'root') {
    const hostToRoot = measurement.offsetParentToRoot ? [...measurement.offsetParentToRoot] as Matrix : null
    return hostToRoot && isFiniteMatrix(hostToRoot) ? multiply(hostToRoot, local) : null
  }
  visiting.add(nodeId)
  const parentToRoot = strictBorderToRoot(file, scene, geometry, relationship.parentId, fence, visiting)
  visiting.delete(nodeId)
  if (!parentToRoot) return null
  const parentMeasurement = geometry.nodes[relationship.parentId]
  const border = parentMeasurement?.box?.border
  if (!parentMeasurement || !border || ![border.top, border.right, border.bottom, border.left].every(value => finite(value) && value >= 0)) return null
  const result = multiply(parentToRoot, multiply(paddingEdge(parentMeasurement), local))
  return isFiniteMatrix(result) ? result : null
}

const matrixEpsilon = 1e-6
const close = (left: number, right: number, tolerance = matrixEpsilon) => Math.abs(left - right) <= tolerance
const exactZero = (value: number) => Object.is(value, -0) || value === 0 ? 0 : value
const copyMatrix = (matrix: Matrix): Matrix => Object.freeze(matrix.map(exactZero)) as unknown as Matrix
const freezePoint = (point: Readonly<Point>): Readonly<Point> => Object.freeze({ x: point.x, y: point.y })
const freezeRect = (rect: Readonly<Rect>): Readonly<Rect> => Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })

function authoredNodeTransform(file: FileDocument, nodeId: string, measurement: MeasuredNode): Matrix | null {
  const node = file.nodes[nodeId]
  if (!node || node.type === 'root') return null
  let expected: Matrix
  if (node.type === 'component') {
    expected = node.layout?.item.transform?.matrix ?? identity
  } else {
    if (node.layout?.item.transform !== undefined) return null
    expected = [node.styles.relativeTransform[0], node.styles.relativeTransform[1], node.styles.relativeTransform[2], node.styles.relativeTransform[3], 0, 0]
  }
  const measured = measurement.transform === undefined ? identity : measurement.transform
  if (!isFiniteMatrix(measured) || !close(measured[4], 0) || !close(measured[5], 0)) return null
  return expected.every((value, index) => close(value, measured[index]!)) ? copyMatrix(expected) : null
}

function resizeParentPaddingToRoot(
  snapshot: GestureAuthoritySnapshot,
  nodeId: string,
  parentId: string,
  pageRootId: string,
): Matrix | null {
  const { file, scene, geometry, start } = snapshot
  const measurement = geometry.nodes[nodeId]
  const parent = file.nodes[parentId]
  if (!measurement || !parent) return null
  if (parent.type === 'root') {
    if (parentId !== pageRootId) return null
    const hostToRoot = measurement.offsetParentToRoot ? [...measurement.offsetParentToRoot] as Matrix : null
    return hostToRoot && isFiniteMatrix(hostToRoot) ? hostToRoot : null
  }
  const parentToRoot = strictBorderToRoot(file, scene, geometry, parentId, start)
  const border = geometry.nodes[parentId]?.box?.border
  if (!parentToRoot || !border || ![border.top, border.right, border.bottom, border.left].every(value => finite(value) && value >= 0)) return null
  const result = multiply(parentToRoot, translation(border.left, border.top))
  return isFiniteMatrix(result) ? result : null
}

function belongsToPageRoot(file: FileDocument, nodeId: string, pageRootId: string): boolean {
  const visited = new Set<string>()
  let current = nodeId
  while (!visited.has(current)) {
    visited.add(current)
    const relationship = file.relationships[current]
    if (!relationship) return false
    const parent = file.nodes[relationship.parentId]
    if (!parent) return false
    if (parent.type === 'root') return relationship.parentId === pageRootId
    current = relationship.parentId
  }
  return false
}

function quadAabb(quad: ResizeWorldQuad): Readonly<Rect> | null {
  const xs = quad.map(point => point.x)
  const ys = quad.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys)
  const result = { x, y, width: right - x, height: bottom - y }
  return finiteRect(result) ? freezeRect(result) : null
}

function projectRect(
  groupToWorld: Matrix,
  rect: Readonly<Rect>,
  nodeTransform: Matrix,
  origin: Readonly<Point>,
): ResizeWorldProjection | null {
  if (!isFiniteMatrix(groupToWorld) || !finiteRect(rect) || !isFiniteMatrix(nodeTransform) || !close(nodeTransform[4], 0) || !close(nodeTransform[5], 0) || !finitePoint(origin)) return null
  const transform = multiply(groupToWorld, multiply(translation(rect.x, rect.y), aboutOrigin(nodeTransform, origin)))
  if (!isFiniteMatrix(transform)) return null
  const points = [
    apply(transform, { x: 0, y: 0 }),
    apply(transform, { x: rect.width, y: 0 }),
    apply(transform, { x: rect.width, y: rect.height }),
    apply(transform, { x: 0, y: rect.height }),
  ] as const
  if (!points.every(finitePoint)) return null
  const quad = Object.freeze(points.map(freezePoint)) as ResizeWorldQuad
  const aabb = quadAabb(quad)
  return aabb ? Object.freeze({ quad, aabb }) : null
}

/** Maps one world sample through the immutable inverse captured at pointer down. */
export function resizeWorldPointToGroup(authority: ResizeGeometryAuthority, point: Readonly<Point>): Readonly<Point> | null {
  if (!finitePoint(point) || !isFiniteMatrix(authority.worldToGroup)) return null
  const mapped = apply(authority.worldToGroup, point)
  return finitePoint(mapped) ? freezePoint(mapped) : null
}

/** Maps a world movement as two points, avoiding the affine translation error caused by treating a delta as a point. */
export function resizeWorldDeltaToGroup(
  authority: ResizeGeometryAuthority,
  startWorld: Readonly<Point>,
  terminalWorld: Readonly<Point>,
): Readonly<Point> | null {
  const start = resizeWorldPointToGroup(authority, startWorld)
  const terminal = resizeWorldPointToGroup(authority, terminalWorld)
  if (!start || !terminal) return null
  return freezePoint({ x: terminal.x - start.x, y: terminal.y - start.y })
}

/** Projects a resized parent-padding rectangle through its captured group matrix and full affine node transform. */
export function projectResizeRectToWorld(authority: ResizeGeometryAuthority, rect: Readonly<Rect>): ResizeWorldProjection | null {
  if (!finiteRect(rect)) return null
  return projectRect(authority.groupToWorld, rect, authority.nodeTransform, { x: rect.width / 2, y: rect.height / 2 })
}

/**
 * Derives the exact untransformed resize box and parent-padding coordinate system from one pointer-down snapshot.
 * No live store or geometry is read here; every returned object and matrix is a detached frozen value.
 */
type ResizeAuthorityContext =
  | Readonly<{ kind: 'direct-selection' }>
  | Readonly<{ kind: 'selected-ancestor-descendant'; parentId: string; expectedGroupToWorld: Matrix }>

function descendsFrom(file: FileDocument, nodeId: string, ancestorId: string): boolean {
  const visited = new Set<string>()
  let current = nodeId
  while (!visited.has(current)) {
    visited.add(current)
    const relationship = file.relationships[current]
    if (!relationship) return false
    if (relationship.parentId === ancestorId) return true
    const parent = file.nodes[relationship.parentId]
    if (!parent || parent.type === 'root') return false
    current = relationship.parentId
  }
  return false
}

function deriveResizeGeometryAuthority(snapshot: GestureAuthoritySnapshot, nodeId: string, context: ResizeAuthorityContext): ResizeGeometryAuthority | null {
  const { file, scene, geometry, start } = snapshot
  if (
    start.fileId !== file.fileId
    || start.fileRevision !== file.revision
    || start.documentRevision !== file.revision
    || start.measurementRevision !== geometry.revision
    || geometry.documentRevision !== start.documentRevision
    || geometry.layoutGeneration !== start.layoutGeneration
    || snapshot.layoutGeneration !== start.layoutGeneration
  ) return null

  const pageRootId = pageRoot(file, snapshot.pageId)
  const node = file.nodes[nodeId]
  const relationship = file.relationships[nodeId]
  const measurement = geometry.nodes[nodeId]
  if (!pageRootId || !node || node.type === 'root' || !relationship || !measurement) return null
  const parent = file.nodes[relationship.parentId]
  if (!parent || !acceptsChild(parent, node, relationship.slot, [...snapshot.atoms])) return null
  if (context.kind === 'direct-selection') {
    if (snapshot.selection.length !== 1 || snapshot.selection[0] !== nodeId || nodeIsLocked(file, nodeId)) return null
  } else {
    const selectedId = snapshot.selection.length === 1 ? snapshot.selection[0] : undefined
    const selected = selectedId ? file.nodes[selectedId] : undefined
    if (
      !selectedId
      || !selected
      || selected.type === 'root'
      || selectedId === nodeId
      || nodeIsLocked(file, selectedId)
      || relationship.parentId !== context.parentId
      || !isFiniteMatrix(context.expectedGroupToWorld)
      || !descendsFrom(file, nodeId, selectedId)
    ) return null
  }
  if (!belongsToPageRoot(file, nodeId, pageRootId)) return null
  if (!exactProjection(measurement, file, geometry, start.layoutGeneration) || !positiveOffset(measurement)) return null
  if (!directMeasurement(file, nodeId, measurement, relationship.parentId) || !exactSceneMeasurement(file, scene, geometry, nodeId)) return null
  if (!measurement.worldAabb || !finiteRect(measurement.worldAabb) || !finitePoint(measurement.offset.origin)) return null
  const origin = measurement.offset.origin
  if (
    origin.x <= 0
    || origin.y <= 0
    || !close(origin.x, measurement.offset.width / 2, sceneRectTolerance)
    || !close(origin.y, measurement.offset.height / 2, sceneRectTolerance)
  ) return null
  const nodeTransform = authoredNodeTransform(file, nodeId, measurement)
  if (nodeTransform === null) return null

  const groupToWorld = resizeParentPaddingToRoot(snapshot, nodeId, relationship.parentId, pageRootId)
  if (!groupToWorld || !isFiniteMatrix(groupToWorld)) return null
  if (context.kind === 'selected-ancestor-descendant' && !groupToWorld.every((value, index) => close(value, context.expectedGroupToWorld[index]!))) return null
  const worldToGroup = invert(groupToWorld)
  if (!worldToGroup || !isFiniteMatrix(worldToGroup)) return null
  const startRect = { x: measurement.offset.x, y: measurement.offset.y, width: measurement.offset.width, height: measurement.offset.height }
  const projected = projectRect(groupToWorld, startRect, nodeTransform, origin)
  if (!projected) return null
  const measuredAabb = measurement.worldAabb
  if (
    !close(projected.aabb.x, measuredAabb.x, resizeGeometryAabbTolerance)
    || !close(projected.aabb.y, measuredAabb.y, resizeGeometryAabbTolerance)
    || !close(projected.aabb.width, measuredAabb.width, resizeGeometryAabbTolerance)
    || !close(projected.aabb.height, measuredAabb.height, resizeGeometryAabbTolerance)
  ) return null

  const fence = Object.freeze({ ...start })
  return Object.freeze({
    coordinateSpace: 'parent-padding' as const,
    fileId: file.fileId,
    pageId: snapshot.pageId,
    pageRootId,
    nodeId,
    parentId: relationship.parentId,
    fence,
    startRect: freezeRect(startRect),
    groupToWorld: copyMatrix(groupToWorld),
    worldToGroup: copyMatrix(worldToGroup),
    nodeTransform,
    transformOrigin: freezePoint(origin),
  })
}

export function resizeGeometryAuthority(snapshot: GestureAuthoritySnapshot, nodeId: string): ResizeGeometryAuthority | null {
  return deriveResizeGeometryAuthority(snapshot, nodeId, { kind: 'direct-selection' })
}

/** Revalidates one descendant against an already-selected ancestor and the exact parent-padding matrix used for projection. */
export function resizeDescendantPresentationAuthority(
  snapshot: GestureAuthoritySnapshot,
  nodeId: string,
  parentId: string,
  expectedGroupToWorld: Matrix,
): ResizeGeometryAuthority | null {
  return deriveResizeGeometryAuthority(snapshot, nodeId, { kind: 'selected-ancestor-descendant', parentId, expectedGroupToWorld })
}

/**
 * Converts one verified flow drag into the exact absolute rectangle expected by the semantic gesture command. The
 * offset box remains the untransformed size authority. Both pointer samples cross the same proven inverse, so rotated
 * or scaled parents change only the local drag delta and never substitute a world AABB for parent-padding geometry.
 */
export function paperFlowAbsoluteDropGeometry(input: PaperFlowAbsoluteDropInput): PaperParentPaddingRect | null {
  const { file, scene, geometry, fence, childId, parentId, pointerDownWorld, terminalWorld } = input
  if (
    fence.fileId !== file.fileId
    || fence.fileRevision !== file.revision
    || fence.documentRevision !== file.revision
    || fence.measurementRevision !== geometry.revision
    || geometry.documentRevision !== fence.documentRevision
    || geometry.layoutGeneration !== fence.layoutGeneration
    || !finitePoint(pointerDownWorld)
    || !finitePoint(terminalWorld)
  ) return null

  const child = file.nodes[childId]
  const parent = file.nodes[parentId]
  const relationship = file.relationships[childId]
  const childMeasurement = geometry.nodes[childId]
  const parentMeasurement = geometry.nodes[parentId]
  if (!child || child.type === 'root' || !parent || (parent.type !== 'frame' && parent.type !== 'component')) return null
  if (!relationship || relationship.parentId !== parentId) return null
  const validChildTopology = parent.type === 'frame'
    ? child.type !== 'component' && relationship.slot === undefined
    : child.type === 'component' && validId(relationship.slot)
  if (!validChildTopology) return null
  if (nodeChildDisplay(parent) !== 'flex' || !parent.layout?.container?.flex) return null
  if (nodePositionMode(child) !== 'flow' || child.layout?.spacing?.margin !== undefined) return null
  if (nodeIsLocked(file, childId) || nodeIsLocked(file, parentId)) return null
  if (!exactProjection(childMeasurement, file, geometry, fence.layoutGeneration) || !positiveOffset(childMeasurement)) return null
  if (!exactProjection(parentMeasurement, file, geometry, fence.layoutGeneration) || !positiveOffset(parentMeasurement)) return null
  if (!exactSceneMeasurement(file, scene, geometry, childId) || !exactSceneMeasurement(file, scene, geometry, parentId)) return null
  const childScene = scene.byId.get(childId)
  if (!childScene?.flow || childScene.locked) return null

  const parentToRoot = strictBorderToRoot(file, scene, geometry, parentId, fence)
  if (!parentToRoot) return null
  const border = parentMeasurement.box?.border
  if (!border || ![border.top, border.right, border.bottom, border.left].every(value => finite(value) && value >= 0)) return null
  const parentPaddingToRoot = multiply(parentToRoot, paddingEdge(parentMeasurement))
  if (!isFiniteMatrix(parentPaddingToRoot)) return null
  const inverse = invert(parentPaddingToRoot)
  if (!inverse || !isFiniteMatrix(inverse)) return null
  const start = apply(inverse, pointerDownWorld)
  const terminal = apply(inverse, terminalWorld)
  if (!finitePoint(start) || !finitePoint(terminal)) return null
  const result = {
    coordinateSpace: 'parent-padding' as const,
    x: childMeasurement.offset.x + terminal.x - start.x,
    y: childMeasurement.offset.y + terminal.y - start.y,
    width: childMeasurement.offset.width,
    height: childMeasurement.offset.height,
  }
  return finiteRect(result) ? result : null
}

/** Converts a verified flow child into one different Flex parent's padding coordinates without using a world AABB. */
export function paperFlowCrossParentAbsoluteDropGeometry(input: PaperFlowCrossParentAbsoluteDropInput): PaperParentPaddingRect | null {
  const { snapshot, childId, targetParentId, targetSlot, pointerDownWorld, terminalWorld } = input
  const { file, scene, geometry, start } = snapshot
  if (
    start.fileId !== file.fileId
    || start.fileRevision !== file.revision
    || start.documentRevision !== file.revision
    || start.measurementRevision !== geometry.revision
    || geometry.documentRevision !== start.documentRevision
    || geometry.layoutGeneration !== start.layoutGeneration
    || snapshot.layoutGeneration !== start.layoutGeneration
    || !finitePoint(pointerDownWorld)
    || !finitePoint(terminalWorld)
  ) return null

  const child = file.nodes[childId]
  const sourceRelationship = file.relationships[childId]
  const sourceParent = sourceRelationship ? file.nodes[sourceRelationship.parentId] : undefined
  const targetParent = file.nodes[targetParentId]
  const childMeasurement = geometry.nodes[childId]
  const sourceParentMeasurement = sourceRelationship ? geometry.nodes[sourceRelationship.parentId] : undefined
  const targetParentMeasurement = geometry.nodes[targetParentId]
  const openRoot = pageRoot(file, snapshot.pageId)
  const targetIsRoot = targetParentId === openRoot
  if (!child || child.type === 'root' || !sourceRelationship || !sourceParent || (sourceParent.type !== 'frame' && sourceParent.type !== 'component') || !targetParent || (!targetIsRoot && targetParent.type !== 'frame' && targetParent.type !== 'component')) return null
  if (sourceRelationship.parentId === targetParentId || targetParentId === childId || descendantsOf(file, childId).includes(targetParentId)) return null
  const validSourceTopology = sourceParent.type === 'frame'
    ? sourceRelationship.slot === undefined && child.type !== 'component'
    : child.type === 'component' && validId(sourceRelationship.slot)
  if (!validSourceTopology) return null
  if (!acceptsChild(sourceParent, child, sourceRelationship.slot, [...snapshot.atoms])) return null
  if (!acceptsChild(targetParent, child, targetSlot, [...snapshot.atoms])) return null
  if (nodeChildDisplay(sourceParent) !== 'flex' || !sourceParent.layout?.container?.flex) return null
  if (!targetIsRoot) {
    if (targetParent.type !== 'frame' && targetParent.type !== 'component') return null
    if (nodeChildDisplay(targetParent) !== 'flex' || !targetParent.layout?.container?.flex) return null
  }
  if (nodePositionMode(child) !== 'flow' || child.layout?.spacing?.margin !== undefined || nodeIsLocked(file, childId) || nodeIsLocked(file, sourceRelationship.parentId) || nodeIsLocked(file, targetParentId)) return null
  if (!exactProjection(childMeasurement, file, geometry, start.layoutGeneration) || !positiveOffset(childMeasurement)) return null
  if (!exactProjection(sourceParentMeasurement, file, geometry, start.layoutGeneration) || !positiveOffset(sourceParentMeasurement)) return null
  if (!targetIsRoot && (!exactProjection(targetParentMeasurement, file, geometry, start.layoutGeneration) || !positiveOffset(targetParentMeasurement))) return null
  if (!exactSceneMeasurement(file, scene, geometry, childId) || !exactSceneMeasurement(file, scene, geometry, sourceRelationship.parentId) || !targetIsRoot && !exactSceneMeasurement(file, scene, geometry, targetParentId)) return null
  const childScene = scene.byId.get(childId)
  if (!childScene?.flow || childScene.locked) return null
  if (!openRoot || !belongsToPageRoot(file, childId, openRoot) || !targetIsRoot && !belongsToPageRoot(file, targetParentId, openRoot)) return null

  const sourceParentToRoot = strictBorderToRoot(file, scene, geometry, sourceRelationship.parentId, start)
  const targetParentToRoot = targetIsRoot ? identity : strictBorderToRoot(file, scene, geometry, targetParentId, start)
  const sourceBorder = sourceParentMeasurement.box?.border
  const targetBorder = targetIsRoot ? { top: 0, right: 0, bottom: 0, left: 0 } : targetParentMeasurement?.box?.border
  if (!sourceParentToRoot || !targetParentToRoot || !sourceBorder || !targetBorder) return null
  if (![sourceBorder.top, sourceBorder.right, sourceBorder.bottom, sourceBorder.left, targetBorder.top, targetBorder.right, targetBorder.bottom, targetBorder.left].every(value => finite(value) && value >= 0)) return null
  const sourcePaddingToRoot = multiply(sourceParentToRoot, paddingEdge(sourceParentMeasurement))
  const targetPaddingToRoot = targetIsRoot ? targetParentToRoot : multiply(targetParentToRoot, paddingEdge(targetParentMeasurement!))
  const rootToSourcePadding = invert(sourcePaddingToRoot)
  const worldToTargetPadding = invert(targetPaddingToRoot)
  if (!isFiniteMatrix(sourcePaddingToRoot) || !rootToSourcePadding || !isFiniteMatrix(rootToSourcePadding)
    || !isFiniteMatrix(targetPaddingToRoot) || !worldToTargetPadding || !isFiniteMatrix(worldToTargetPadding)) return null
  const sourceOriginWorld = apply(sourcePaddingToRoot, { x: childMeasurement.offset.x, y: childMeasurement.offset.y })
  const sourceOrigin = apply(worldToTargetPadding, sourceOriginWorld)
  const pointerStart = apply(worldToTargetPadding, pointerDownWorld)
  const pointerEnd = apply(worldToTargetPadding, terminalWorld)
  if (![sourceOrigin, pointerStart, pointerEnd].every(finitePoint)) return null
  const result = {
    coordinateSpace: 'parent-padding' as const,
    x: sourceOrigin.x + pointerEnd.x - pointerStart.x,
    y: sourceOrigin.y + pointerEnd.y - pointerStart.y,
    width: childMeasurement.offset.width,
    height: childMeasurement.offset.height,
  }
  return finiteRect(result) ? Object.freeze(result) : null
}
const definitePx = (value: { value: LayoutLength } | undefined): number | undefined => value?.value.kind === 'px' ? value.value.value : undefined

function authoredAxisSize(file: FileDocument, id: string, measurement: MeasuredNode, axis: 'width' | 'height'): number | null {
  const node = file.nodes[id]
  if (!node || node.type === 'root' || !measurement.offset) return null
  const layoutPx = definitePx(node.layout?.item[axis])
  if (layoutPx !== undefined) return layoutPx
  if (node.type === 'component') return measurement.offset[axis]
  if (node.type === 'text' && node.textSizing?.[axis].mode !== 'fixed') return measurement.offset[axis]
  const authored = node.styles[axis]
  const dynamic = node.layout?.item[axis]?.value
  return dynamic && dynamic.kind !== 'px' ? measurement.offset[axis] : authored
}

function authoredPosition(file: FileDocument, id: string, measurement: MeasuredNode, parentToRoot: Matrix | null): Point | null {
  const node = file.nodes[id]
  if (!node || node.type === 'root' || !measurement.offset) return null
  const mode = nodePositionMode(node)
  if (mode === 'freeform' && node.type !== 'component') {
    const position = { x: node.styles.relativeTransform[4], y: node.styles.relativeTransform[5] }
    return parentToRoot ? apply(parentToRoot, position) : position
  }
  const position = node.layout?.item.position
  const resolved = parentToRoot ? apply(parentToRoot, { x: measurement.offset.x, y: measurement.offset.y }) : { x: measurement.offset.x, y: measurement.offset.y }
  // Root px leading insets are already semantic page coordinates. Projection subtracts the component-host origin before
  // writing CSS, so applying that origin again here would double-transform them. Unresolved axes still use measured DOM
  // offsets normalized through the proven host matrix (right/bottom, percentages, flow and intrinsic placement).
  return {
    x: position?.mode === 'absolute' && position.left?.kind === 'px' ? position.left.value : resolved.x,
    y: position?.mode === 'absolute' && position.top?.kind === 'px' ? position.top.value : resolved.y,
  }
}

function transformedBorderBox(measurement: MeasuredNode, parentToRoot: Matrix | null): { center: Point; bounds: Rect } | null {
  if (!measurement.offset) return null
  const local = localMatrixOf(measurement)
  if (!local) return null
  const matrix = parentToRoot ? multiply(parentToRoot, local) : local
  const { width, height } = measurement.offset
  const corners = [apply(matrix, { x: 0, y: 0 }), apply(matrix, { x: width, y: 0 }), apply(matrix, { x: width, y: height }), apply(matrix, { x: 0, y: height })]
  const left = Math.min(...corners.map(point => point.x)), top = Math.min(...corners.map(point => point.y))
  const right = Math.max(...corners.map(point => point.x)), bottom = Math.max(...corners.map(point => point.y))
  return { center: apply(matrix, { x: width / 2, y: height / 2 }), bounds: { x: left, y: top, width: right - left, height: bottom - top } }
}

/**
 * Strict geometry adapter for Paper's Add/Wrap analyzer. Every non-empty child must come from the same accepted
 * document/layout projection and prove that its measured offset box belongs directly to the modeled parent (or the
 * source-specific preview host for a page root). Visual AABBs are consumed exactly as measured, never rebuilt from
 * the interaction rectangle and authored rotation.
 */
type PaperFlexCapture = Readonly<{
  input: FlexInferenceInput
  parentSnapshot?: PaperSizingSnapshot
  childSnapshots: Readonly<Record<string, PaperSizingSnapshot>>
}>

function capturePaperFlexGeometry(file: FileDocument, geometry: LayoutGeometry, containerId: string, kind: FlexAnalysisKind, expectedLayoutGeneration: number, captureSizing: boolean): PaperFlexCapture | null {
  const container = file.nodes[containerId]
  if (!container || (container.type !== 'root' && container.type !== 'frame' && container.type !== 'component')) return null
  const isRoot = container.type === 'root'
  const childIds = childrenOf(file, containerId)
  const containerMeasurement = geometry.nodes[containerId]
  const exactContainer = exactProjection(containerMeasurement, file, geometry, expectedLayoutGeneration)
  let containerSize: Size | null = null
  if (isRoot) containerSize = { width: flowHost.width, height: flowHost.height }
  else if (exactContainer && containerMeasurement.offset) containerSize = { width: containerMeasurement.offset.width, height: containerMeasurement.offset.height }
  else if (childIds.length === 0 && container.type === 'frame') containerSize = { width: container.styles.width, height: container.styles.height }
  if (!containerSize) return null

  let parentSnapshot: PaperSizingSnapshot | undefined
  if (captureSizing) {
    if (isRoot) return null
    const relationship = file.relationships[containerId]
    const direct = relationship && exactContainer && containerMeasurement.offset && directMeasurement(file, containerId, containerMeasurement, relationship.parentId)
    if (direct) parentSnapshot = paperSizingSnapshot(file, containerId, containerMeasurement, { width: containerMeasurement.offset!.width, height: containerMeasurement.offset!.height }) ?? undefined
    else if (childIds.length === 0 && container.type === 'frame') {
      const fallbackMeasurement: MeasuredNode = { canvasKind: 'frame', rect: transformedBounds(container.styles.relativeTransform, container.styles) }
      parentSnapshot = paperSizingSnapshot(file, containerId, fallbackMeasurement, { width: container.styles.width, height: container.styles.height }) ?? undefined
    }
    if (!parentSnapshot) return null
  }

  const children: FlexAnalysisChild[] = []
  const childSnapshots: Record<string, PaperSizingSnapshot> = {}
  const localBounds: Rect[] = []
  for (const id of childIds) {
    const node = file.nodes[id]
    const measurement = geometry.nodes[id]
    if (!node || node.type === 'root' || !exactProjection(measurement, file, geometry, expectedLayoutGeneration) || !measurement.worldAabb || !measurement.offset) return null
    if (!directMeasurement(file, id, measurement, containerId)) return null
    const parentToRoot = isRoot ? measurement.offsetParentToRoot ? [...measurement.offsetParentToRoot] as Matrix : null : null
    if (isRoot && !parentToRoot) return null
    const position = authoredPosition(file, id, measurement, parentToRoot)
    const width = authoredAxisSize(file, id, measurement, 'width'), height = authoredAxisSize(file, id, measurement, 'height')
    const local = transformedBorderBox(measurement, parentToRoot)
    const sourcePosition = nodePositionMode(node)
    if (!position || width === null || height === null || !local || sourcePosition === null) return null
    if (captureSizing) {
      const snapshot = paperSizingSnapshot(file, id, measurement, { width: measurement.offset.width, height: measurement.offset.height })
      if (!snapshot) return null
      childSnapshots[id] = snapshot
    }
    children.push({ id, worldAabb: measurement.worldAabb, authoredPosition: position, authoredSize: { width, height }, parentLocalCenter: local.center, sourcePosition })
    localBounds.push(local.bounds)
  }
  const directAddLeadingInset = localBounds.length === 0
    ? { x: 0, y: 0 }
    : { x: Math.min(...localBounds.map(bounds => bounds.x)), y: Math.min(...localBounds.map(bounds => bounds.y)) }
  return { input: { containerSize, children, directAddLeadingInset, kind, isRoot }, ...(parentSnapshot ? { parentSnapshot } : {}), childSnapshots }
}

export function paperFlexInput(file: FileDocument, geometry: LayoutGeometry, containerId: string, kind: FlexAnalysisKind, expectedLayoutGeneration: number): FlexInferenceInput | null {
  return capturePaperFlexGeometry(file, geometry, containerId, kind, expectedLayoutGeneration, false)?.input ?? null
}

/**
 * One authoritative Direct Add capture. Inference channels and sizing snapshots are derived from the same immutable
 * projection in one child traversal; callers never need a second measured-children pass.
 */
export function paperDirectAddGeometry(file: FileDocument, geometry: LayoutGeometry, containerId: string, expectedLayoutGeneration: number): PaperDirectAddGeometry | null {
  const captured = capturePaperFlexGeometry(file, geometry, containerId, 'direct-add', expectedLayoutGeneration, true)
  return captured?.parentSnapshot ? { input: captured.input, parentSnapshot: captured.parentSnapshot, childSnapshots: captured.childSnapshots } : null
}

/**
 * One strict Remove capture. Only the current direct flow children participate; existing absolute children are not
 * measured or returned. Offset boxes are the sizing and parent-local position authority, while the shared projection
 * and direct-parent proofs prevent a stale or cross-instance measurement from entering the later semantic command.
 */
export function paperRemoveFlexGeometry(file: FileDocument, geometry: LayoutGeometry, containerId: string, expectedLayoutGeneration: number): PaperRemoveFlexGeometry | null {
  const parent = file.nodes[containerId]
  if (!parent || (parent.type !== 'frame' && parent.type !== 'component') || parent.layout?.container?.display !== 'flex' || !parent.layout.container.flex) return null
  const parentRelationship = file.relationships[containerId]
  const parentMeasurement = geometry.nodes[containerId]
  if (!parentRelationship || !exactProjection(parentMeasurement, file, geometry, expectedLayoutGeneration) || !positiveOffset(parentMeasurement)) return null
  if (!directMeasurement(file, containerId, parentMeasurement, parentRelationship.parentId)) return null
  const parentSnapshot = paperSizingSnapshot(file, containerId, parentMeasurement, { width: parentMeasurement.offset.width, height: parentMeasurement.offset.height })
  if (!parentSnapshot) return null

  const parentBox = parentMeasurement.box
  if (!parentBox) return null
  const { border, padding } = parentBox
  if (![border.top, border.right, border.bottom, border.left, padding.top, padding.right, padding.bottom, padding.left].every(value => finite(value) && value >= 0)) return null
  const flowChildren: PaperRemoveFlexChildGeometry[] = []
  for (const nodeId of childrenOf(file, containerId)) {
    const node = file.nodes[nodeId]
    if (!node || node.type === 'root') return null
    if (nodePositionMode(node) !== 'flow') continue
    const sourceRelationship = file.relationships[nodeId]
    const measurement = geometry.nodes[nodeId]
    if (!sourceRelationship || sourceRelationship.parentId !== containerId) return null
    if (!exactProjection(measurement, file, geometry, expectedLayoutGeneration) || !positiveOffset(measurement)) return null
    if (!directMeasurement(file, nodeId, measurement, containerId)) return null
    const measured = { width: measurement.offset.width, height: measurement.offset.height }
    const snapshot = paperSizingSnapshot(file, nodeId, measurement, measured)
    if (!snapshot) return null
    flowChildren.push({
      nodeId,
      snapshot,
      sourceRelationship: { ...sourceRelationship },
      parentLocalPosition: { x: measurement.offset.x, y: measurement.offset.y },
      measured,
    })
  }

  return {
    parentSnapshot,
    parentBorderBox: { width: parentMeasurement.offset.width, height: parentMeasurement.offset.height },
    parentBorder: { top: border.top, right: border.right, bottom: border.bottom, left: border.left },
    parentResolvedPadding: { top: padding.top, right: padding.right, bottom: padding.bottom, left: padding.left },
    flowChildren,
  }
}

export type PaperWrapGeometry = Readonly<{ input: FlexInferenceInput; worldToParentPadding: Matrix; childSnapshots: Readonly<Record<string, PaperSizingSnapshot>> }>

/**
 * Strict selection-scoped geometry for Paper Wrap. Only the selected direct siblings enter the analyzer. The returned
 * inverse is proven from the same immutable projection and maps the centroid-derived root/world origin into the
 * modeled parent's padding box. Root coordinates are already semantic document coordinates.
 */
export function paperWrapGeometry(file: FileDocument, geometry: LayoutGeometry, parentId: string, selectedIds: readonly string[], expectedLayoutGeneration: number): PaperWrapGeometry | null {
  const parent = file.nodes[parentId]
  if (!parent || (parent.type !== 'root' && parent.type !== 'frame') || selectedIds.length === 0 || new Set(selectedIds).size !== selectedIds.length) return null
  const isRoot = parent.type === 'root'
  const parentInverse = worldToParentPadding(file, geometry, parentId, expectedLayoutGeneration)
  if (!parentInverse) return null
  const children: FlexAnalysisChild[] = []
  const childSnapshots: Record<string, PaperSizingSnapshot> = {}
  let rootProjection: Matrix | null = null
  for (const id of selectedIds) {
    const node = file.nodes[id]
    const relationship = file.relationships[id]
    const measurement = geometry.nodes[id]
    if (!node || node.type === 'root' || !relationship || relationship.parentId !== parentId || relationship.slot !== undefined) return null
    if (!exactProjection(measurement, file, geometry, expectedLayoutGeneration) || !measurement.worldAabb || !measurement.offset) return null
    if (!directMeasurement(file, id, measurement, parentId)) return null
    const parentToRoot = isRoot ? measurement.offsetParentToRoot ? [...measurement.offsetParentToRoot] as Matrix : null : null
    if (isRoot && !parentToRoot) return null
    if (parentToRoot) {
      if (rootProjection && !sameMatrix(rootProjection, parentToRoot)) return null
      rootProjection = parentToRoot
    }
    const position = authoredPosition(file, id, measurement, parentToRoot)
    const width = authoredAxisSize(file, id, measurement, 'width')
    const height = authoredAxisSize(file, id, measurement, 'height')
    const local = transformedBorderBox(measurement, parentToRoot)
    const sourcePosition = nodePositionMode(node)
    if (!position || width === null || height === null || !local || sourcePosition === null) return null
    const snapshot = paperSizingSnapshot(file, id, measurement, { width: measurement.offset.width, height: measurement.offset.height })
    if (!snapshot) return null
    childSnapshots[id] = snapshot
    children.push({ id, worldAabb: measurement.worldAabb, authoredPosition: position, authoredSize: { width, height }, parentLocalCenter: local.center, sourcePosition })
  }
  const containerSize = isRoot
    ? { width: flowHost.width, height: flowHost.height }
    : (() => {
        const measurement = geometry.nodes[parentId]
        return exactProjection(measurement, file, geometry, expectedLayoutGeneration) && measurement.offset
          ? { width: measurement.offset.width, height: measurement.offset.height }
          : null
      })()
  if (!containerSize) return null
  return { input: { containerSize, children, directAddLeadingInset: { x: 0, y: 0 }, kind: 'wrap', isRoot }, worldToParentPadding: parentInverse, childSnapshots }
}
