import { childrenOf, nodeIsLocked, nodePositionMode } from '@canvas/repo-engine/file-document'
import type { Appearance, FileDocument, FileNode, ImageGeometry, ImagePaint } from '@canvas/repo-engine/file-document'
import { aboutOrigin, apply, invert, isFiniteMatrix, multiply, translation } from '@canvas/repo-engine/layout-matrix'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import type { Point, Rect, ResizeAxis, ResizeHandle } from './canvas-math'
import type { GestureAuthoritySnapshot, ResizeGeometryAuthority } from './gesture-authority'
import { projectResizeRectToWorld, resizeDescendantPresentationAuthority, resizeGeometryAuthority } from './layout-measure'
import type { ResizeWorldProjection } from './layout-measure'

export type ResizeProjectionSample = Readonly<{
  coordinateSpace: 'parent-padding'
  rect: Readonly<Rect>
  contentLocked: boolean
  affectedAxes: readonly ResizeAxis[]
  effectiveHandle: ResizeHandle
}>

export type ResizePresentationItem = Readonly<{
  nodeId: string
  parentId: string
  coordinateSpace: 'parent-padding'
  startRect: Readonly<Rect>
  rect: Readonly<Rect>
  nodeTransform: Matrix
  transformOrigin: Readonly<Point>
  world: ResizeWorldProjection
  appearance?: Appearance
}>

export type ResizePresentation = Readonly<{
  selectedNodeId: string
  contentLocked: boolean
  affectedAxes: readonly ResizeAxis[]
  effectiveHandle: ResizeHandle
  items: readonly ResizePresentationItem[]
  byNodeId: Readonly<Record<string, ResizePresentationItem>>
}>

const epsilon = 1e-6
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const positive = (value: unknown): value is number => finite(value) && value > 0
const finitePoint = (point: Readonly<Point>): boolean => finite(point.x) && finite(point.y)
const finiteRect = (rect: Readonly<Rect>): boolean => finite(rect.x) && finite(rect.y) && positive(rect.width) && positive(rect.height)
const close = (left: number, right: number, tolerance = epsilon) => Math.abs(left - right) <= tolerance
const samePoint = (left: Readonly<Point>, right: Readonly<Point>, tolerance = epsilon) => close(left.x, right.x, tolerance) && close(left.y, right.y, tolerance)
const sameRect = (left: Readonly<Rect>, right: Readonly<Rect>) => close(left.x, right.x) && close(left.y, right.y) && close(left.width, right.width) && close(left.height, right.height)
const sameMatrix = (left: Matrix, right: Matrix) => left.every((value, index) => close(value, right[index]!))
const cloneRect = (rect: Readonly<Rect>): Rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function exactAuthority(left: ResizeGeometryAuthority, right: ResizeGeometryAuthority): boolean {
  return left.coordinateSpace === right.coordinateSpace
    && left.fileId === right.fileId
    && left.pageId === right.pageId
    && left.pageRootId === right.pageRootId
    && left.nodeId === right.nodeId
    && left.parentId === right.parentId
    && Object.keys(left.fence).length === Object.keys(right.fence).length
    && Object.entries(left.fence).every(([key, value]) => right.fence[key as keyof typeof right.fence] === value)
    && sameRect(left.startRect, right.startRect)
    && sameMatrix(left.groupToWorld, right.groupToWorld)
    && sameMatrix(left.worldToGroup, right.worldToGroup)
    && sameMatrix(left.nodeTransform, right.nodeTransform)
    && samePoint(left.transformOrigin, right.transformOrigin)
}

function childAuthority(snapshot: GestureAuthoritySnapshot, nodeId: string, parentId: string, expectedGroupToWorld: Matrix): ResizeGeometryAuthority | null {
  return resizeDescendantPresentationAuthority(snapshot, nodeId, parentId, expectedGroupToWorld)
}

function nodeResizeWritable(node: FileNode, context: 'selected' | 'inherited'): boolean {
  if (node.type === 'root') return false
  const position = node.layout?.item.position
  const mode = nodePositionMode(node)
  if (mode === 'flow') return context === 'selected'
  if (mode === 'freeform') return node.type !== 'component'
  return mode === 'absolute'
    && position?.mode === 'absolute'
    && position.left?.kind === 'px'
    && position.top?.kind === 'px'
    && position.right === undefined
    && position.bottom === undefined
}

function nodeBorderToWorld(groupToWorld: Matrix, rect: Readonly<Rect>, nodeTransform: Matrix): Matrix | null {
  if (!isFiniteMatrix(groupToWorld) || !finiteRect(rect) || !isFiniteMatrix(nodeTransform)) return null
  const center = { x: rect.width / 2, y: rect.height / 2 }
  const result = multiply(groupToWorld, multiply(translation(rect.x, rect.y), aboutOrigin(nodeTransform, center)))
  return isFiniteMatrix(result) ? result : null
}

function projectedAuthority(authority: ResizeGeometryAuthority, groupToWorld: Matrix): ResizeGeometryAuthority | null {
  const inverse = invert(groupToWorld)
  if (!inverse || !isFiniteMatrix(inverse)) return null
  return { ...authority, groupToWorld, worldToGroup: inverse }
}

function imageRect(paint: ImagePaint, asset: { width: number; height: number }, bounds: Readonly<Rect>): ImageGeometry | null {
  if (!positive(asset.width) || !positive(asset.height) || !finiteRect(bounds)) return null
  if (paint.geometry) return finiteRect(paint.geometry) ? { ...paint.geometry } : null
  if (paint.fit === 'stretch') return { x: 0, y: 0, width: bounds.width, height: bounds.height }
  if (paint.fit === 'tile') return { x: 0, y: 0, width: asset.width, height: asset.height }
  const scale = paint.fit === 'contain'
    ? Math.min(bounds.width / asset.width, bounds.height / asset.height)
    : Math.max(bounds.width / asset.width, bounds.height / asset.height)
  const width = asset.width * scale, height = asset.height * scale
  const result = { x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width, height }
  return finiteRect(result) ? result : null
}

function rectQuad(matrix: Matrix, rect: Readonly<Rect>): readonly [Point, Point, Point, Point] | null {
  if (!isFiniteMatrix(matrix) || !finiteRect(rect)) return null
  const points: [Point, Point, Point, Point] = [
    apply(matrix, { x: rect.x, y: rect.y }),
    apply(matrix, { x: rect.x + rect.width, y: rect.y }),
    apply(matrix, { x: rect.x + rect.width, y: rect.y + rect.height }),
    apply(matrix, { x: rect.x, y: rect.y + rect.height }),
  ]
  return points.every(finitePoint) ? points : null
}

function axisAlignedRect(quad: readonly [Point, Point, Point, Point]): ImageGeometry | null {
  if (!close(quad[0].y, quad[1].y) || !close(quad[1].x, quad[2].x) || !close(quad[2].y, quad[3].y) || !close(quad[3].x, quad[0].x)) return null
  const x = Math.min(...quad.map(point => point.x)), y = Math.min(...quad.map(point => point.y))
  const right = Math.max(...quad.map(point => point.x)), bottom = Math.max(...quad.map(point => point.y))
  const result = { x, y, width: right - x, height: bottom - y }
  return finiteRect(result) ? result : null
}

function resizeAppearance(
  file: FileDocument,
  node: Exclude<FileNode, { type: 'root' }>,
  start: Readonly<Rect>,
  next: Readonly<Rect>,
  contentLocked: boolean,
  oldNodeToWorld: Matrix,
  newNodeToWorld: Matrix,
): Appearance | undefined | null {
  const appearance = node.appearance
  if (!appearance?.fills?.some(fill => fill.type === 'image')) return undefined
  const inverseNew = contentLocked ? invert(newNodeToWorld) : null
  if (contentLocked && (!inverseNew || !isFiniteMatrix(inverseNew))) return null
  let changed = false
  const fills = appearance.fills.map(fill => {
    if (fill.type !== 'image') return fill
    const asset = file.assets?.[fill.assetId]
    if (!asset || asset.id !== fill.assetId || !positive(asset.width) || !positive(asset.height)) return null
    if (!contentLocked && !fill.geometry) return fill
    const geometry = imageRect(fill, asset, start)
    if (!geometry) return null
    let nextGeometry: ImageGeometry
    if (contentLocked) {
      const oldWorld = rectQuad(oldNodeToWorld, geometry)
      if (!oldWorld || !inverseNew) return null
      const local = oldWorld.map(point => apply(inverseNew, point)) as unknown as [Point, Point, Point, Point]
      if (!local.every(finitePoint)) return null
      const rect = axisAlignedRect(local)
      if (!rect) return null
      nextGeometry = rect
    } else {
      const scaleX = next.width / start.width, scaleY = next.height / start.height
      nextGeometry = { x: geometry.x * scaleX, y: geometry.y * scaleY, width: geometry.width * scaleX, height: geometry.height * scaleY }
      if (!finiteRect(nextGeometry)) return null
    }
    changed = true
    return { ...fill, geometry: nextGeometry }
  })
  if (fills.some(fill => fill === null)) return null
  return changed ? structuredClone({ ...appearance, fills: fills as NonNullable<Appearance['fills']> }) : undefined
}

function verifiedItem(
  file: FileDocument,
  authority: ResizeGeometryAuthority,
  rect: Readonly<Rect>,
  groupToWorld: Matrix,
  contentLocked: boolean,
  context: 'selected' | 'inherited',
): ResizePresentationItem | null {
  const node = file.nodes[authority.nodeId]
  if (!node || node.type === 'root' || (context === 'selected' && nodeIsLocked(file, node.id)) || !finiteRect(rect) || !nodeResizeWritable(node, context)) return null
  const oldNodeToWorld = nodeBorderToWorld(authority.groupToWorld, authority.startRect, authority.nodeTransform)
  const newNodeToWorld = nodeBorderToWorld(groupToWorld, rect, authority.nodeTransform)
  const projected = projectedAuthority(authority, groupToWorld)
  if (!oldNodeToWorld || !newNodeToWorld || !projected) return null
  const world = projectResizeRectToWorld(projected, rect)
  if (!world) return null
  const appearance = resizeAppearance(file, node, authority.startRect, rect, contentLocked, oldNodeToWorld, newNodeToWorld)
  if (appearance === null) return null
  return {
    nodeId: node.id,
    parentId: authority.parentId,
    coordinateSpace: 'parent-padding',
    startRect: cloneRect(authority.startRect),
    rect: cloneRect(rect),
    nodeTransform: [...authority.nodeTransform] as Matrix,
    transformOrigin: { x: rect.width / 2, y: rect.height / 2 },
    world,
    ...(appearance ? { appearance } : {}),
  }
}

function borderOf(snapshot: GestureAuthoritySnapshot, nodeId: string) {
  const border = snapshot.geometry.nodes[nodeId]?.box?.border
  return border && [border.top, border.right, border.bottom, border.left].every(value => finite(value) && value >= 0) ? border : null
}

function ordinaryChildRect(parentStart: Readonly<Rect>, parentNext: Readonly<Rect>, parentBorder: NonNullable<ReturnType<typeof borderOf>>, childStart: Readonly<Rect>): Rect | null {
  const oldWidth = parentStart.width - parentBorder.left - parentBorder.right
  const oldHeight = parentStart.height - parentBorder.top - parentBorder.bottom
  const nextWidth = parentNext.width - parentBorder.left - parentBorder.right
  const nextHeight = parentNext.height - parentBorder.top - parentBorder.bottom
  if (![oldWidth, oldHeight, nextWidth, nextHeight].every(positive)) return null
  const scaleX = nextWidth / oldWidth, scaleY = nextHeight / oldHeight
  const result = { x: childStart.x * scaleX, y: childStart.y * scaleY, width: childStart.width * scaleX, height: childStart.height * scaleY }
  return finiteRect(result) ? result : null
}

function fixedChildRect(authority: ResizeGeometryAuthority, oldGroup: Matrix, newGroup: Matrix): Rect | null {
  if (!sameMatrix(authority.groupToWorld, oldGroup)) return null
  const old = projectResizeRectToWorld(authority, authority.startRect)
  const inverse = invert(newGroup)
  if (!old || !inverse || !isFiniteMatrix(inverse)) return null
  const worldCenter = old.quad.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 })
  const localCenter = apply(inverse, worldCenter)
  if (!finitePoint(localCenter)) return null
  return {
    x: localCenter.x - authority.startRect.width / 2,
    y: localCenter.y - authority.startRect.height / 2,
    width: authority.startRect.width,
    height: authority.startRect.height,
  }
}

function sameQuad(left: ResizeWorldProjection, right: ResizeWorldProjection): boolean {
  return left.quad.every((point, index) => samePoint(point, right.quad[index]!, 0.5))
}

/**
 * Builds one immutable, coordinate-explicit resize presentation from pointer-down authority and a terminal local sample.
 * It performs no store reads or writes. World rectangles are projections only; semantic rectangles remain parent-local.
 */
export function projectResizePresentation(
  snapshot: GestureAuthoritySnapshot,
  authority: ResizeGeometryAuthority,
  sample: ResizeProjectionSample,
): ResizePresentation | null {
  const resizeHandles: readonly ResizeHandle[] = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left']
  if (
    sample.coordinateSpace !== 'parent-padding'
    || !finiteRect(sample.rect)
    || typeof sample.contentLocked !== 'boolean'
    || !resizeHandles.includes(sample.effectiveHandle)
    || !Array.isArray(sample.affectedAxes)
    || sample.affectedAxes.length < 1
    || sample.affectedAxes.length > 2
    || sample.affectedAxes.some(axis => axis !== 'x' && axis !== 'y')
    || new Set(sample.affectedAxes).size !== sample.affectedAxes.length
  ) return null
  const selected = resizeGeometryAuthority(snapshot, authority.nodeId)
  if (!selected || !exactAuthority(selected, authority)) return null
  const selectedNode = snapshot.file.nodes[selected.nodeId]
  if (!selectedNode || selectedNode.type === 'root' || !nodeResizeWritable(selectedNode, 'selected')) return null

  const selectedItem = verifiedItem(snapshot.file, selected, sample.rect, selected.groupToWorld, sample.contentLocked, 'selected')
  if (!selectedItem) return null
  const items: ResizePresentationItem[] = [selectedItem]
  const selectedOldBorderToWorld = nodeBorderToWorld(selected.groupToWorld, selected.startRect, selected.nodeTransform)
  const selectedNewBorderToWorld = nodeBorderToWorld(selected.groupToWorld, sample.rect, selected.nodeTransform)
  if (!selectedOldBorderToWorld || !selectedNewBorderToWorld) return null

  if (selectedNode.type === 'frame') {
    const walkOrdinary = (parentId: string, parentStart: Rect, parentNext: Rect, oldBorderToWorld: Matrix, newBorderToWorld: Matrix): boolean => {
      const border = borderOf(snapshot, parentId)
      if (!border) return childrenOf(snapshot.file, parentId).length === 0
      const oldChildGroup = multiply(oldBorderToWorld, translation(border.left, border.top))
      const newChildGroup = multiply(newBorderToWorld, translation(border.left, border.top))
      for (const childId of childrenOf(snapshot.file, parentId)) {
        const child = snapshot.file.nodes[childId]
        if (!child || child.type === 'root') return false
        const mode = nodePositionMode(child)
        if (mode === 'flow') continue
        if (mode !== 'freeform' && mode !== 'absolute') return false
        const current = childAuthority(snapshot, childId, parentId, oldChildGroup)
        if (!current || !sameMatrix(current.groupToWorld, oldChildGroup)) return false
        const rect = ordinaryChildRect(parentStart, parentNext, border, current.startRect)
        if (!rect || !nodeResizeWritable(child, 'inherited')) return false
        const item = verifiedItem(snapshot.file, current, rect, newChildGroup, false, 'inherited')
        if (!item) return false
        items.push(item)
        if (child.type === 'frame') {
          const oldNode = nodeBorderToWorld(oldChildGroup, current.startRect, current.nodeTransform)
          const nextNode = nodeBorderToWorld(newChildGroup, rect, current.nodeTransform)
          if (!oldNode || !nextNode || !walkOrdinary(childId, current.startRect as Rect, rect, oldNode, nextNode)) return false
        }
      }
      return true
    }

    const holdDirectChildren = (): boolean => {
      const border = borderOf(snapshot, selected.nodeId)
      if (!border) return childrenOf(snapshot.file, selected.nodeId).length === 0
      const oldGroup = multiply(selectedOldBorderToWorld, translation(border.left, border.top))
      const nextGroup = multiply(selectedNewBorderToWorld, translation(border.left, border.top))
      for (const childId of childrenOf(snapshot.file, selected.nodeId)) {
        const child = snapshot.file.nodes[childId]
        if (!child || child.type === 'root') return false
        const mode = nodePositionMode(child)
        if (mode === 'flow') continue
        if (mode !== 'freeform' && mode !== 'absolute') return false
        const current = childAuthority(snapshot, childId, selected.nodeId, oldGroup)
        if (!current || !sameMatrix(current.groupToWorld, oldGroup)) return false
        const rect = fixedChildRect(current, oldGroup, nextGroup)
        if (!rect || !nodeResizeWritable(child, 'inherited')) return false
        const item = verifiedItem(snapshot.file, current, rect, nextGroup, false, 'inherited')
        const oldWorld = projectResizeRectToWorld(current, current.startRect)
        if (!item || !oldWorld || !sameQuad(item.world, oldWorld)) return false
        items.push(item)
      }
      return true
    }

    const descendantsValid = sample.contentLocked
      ? holdDirectChildren()
      : walkOrdinary(selected.nodeId, selected.startRect as Rect, sample.rect as Rect, selectedOldBorderToWorld, selectedNewBorderToWorld)
    if (!descendantsValid) return null
  }

  const byNodeId: Record<string, ResizePresentationItem> = {}
  for (const item of items) {
    if (byNodeId[item.nodeId]) return null
    byNodeId[item.nodeId] = item
  }
  return deepFreeze({
    selectedNodeId: selected.nodeId,
    contentLocked: sample.contentLocked,
    affectedAxes: [...sample.affectedAxes],
    effectiveHandle: sample.effectiveHandle,
    items,
    byNodeId,
  })
}
