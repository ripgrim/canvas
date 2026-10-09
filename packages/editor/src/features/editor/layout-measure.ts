/**
 * Pure derivations from the last preview measurement for the layout inspector: per-node sizing targets (measured size
 * and parent content size per axis), the parent-local point used when a node leaves the flow, measured children and
 * Grid tracks for container conversions, and the sizing availability context. Nothing here reads the DOM or a store.
 */
import { childrenOf, flowHost } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { availableSizingModes, sizingModes } from '@canvas/repo-engine/layout'
import type { FlexDirection, NodeLayout, SizingContext, SizingMode } from '@canvas/repo-engine/layout'
import type { LayoutStatus, PreviewLayoutReport } from '@canvas/preview-runtime/protocol'
import type { Axis, SizingTarget } from './layout-commands'
import type { MeasuredChildren } from './layout-flex-commands'
import type { MeasuredGrid } from './layout-grid-commands'
import type { MeasuredNode } from './scene-geometry'

/** The measurement the inspector reads: measured roots plus the statuses of nodes without one. */
export type LayoutGeometry = { nodes: Record<string, MeasuredNode>; unsupported: Record<string, LayoutStatus> }

/** Root children sit in the legacy flow host; its content box is the host width minus its padding, with no definite height. */
export const legacyHostContentWidth = flowHost.width - flowHost.padding * 2

const positive = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
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
    return { id, layout: layoutOf(file, id), measurement: { ...(measured !== undefined ? { measuredPx: measured } : {}), ...(parent !== undefined ? { parentPx: parent } : {}) }, parentDirection: parentDirection(file, id) }
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
