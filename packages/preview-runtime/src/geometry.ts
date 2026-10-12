import { isLayoutStatus, type LayoutStatus } from './layout-protocol.js'
export type PreviewBounds = { x: number; y: number; width: number; height: number }
export type PreviewSides = { top: number; right: number; bottom: number; left: number }
/** CSS `matrix(a, b, c, d, e, f)` of the element's computed transform; absent when the element has none. */
export type PreviewMatrix = readonly [number, number, number, number, number, number]
/** Resolved Grid tracks, gaps and padding of a container whose computed display is grid, in CSS pixels. */
export type PreviewContentDistribution = 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly'
export const previewContentDistributions: readonly PreviewContentDistribution[] = ['start', 'center', 'end', 'stretch', 'space-between', 'space-around', 'space-evenly']
export type PreviewGridMeasure = { columns: number[]; rows: number[]; columnGap: number; rowGap: number; padding: PreviewSides; justifyContent?: PreviewContentDistribution; alignContent?: PreviewContentDistribution }
export type PreviewLayoutReport = { status: LayoutStatus; conflicts: string[] }
/** What the theme layer did for an instance's root or portal claims. */
export type PreviewThemeStatus = 'applied' | 'unsupported-ambiguous-root' | 'unsupported-no-root' | 'conflicting-portal'
export const previewThemeStatuses: readonly PreviewThemeStatus[] = ['applied', 'unsupported-ambiguous-root', 'unsupported-no-root', 'conflicting-portal']
export const isPreviewThemeStatus = (value: unknown): value is PreviewThemeStatus => typeof value === 'string' && (previewThemeStatuses as readonly string[]).includes(value)
/** Padding and border widths of a root in CSS pixels, so a parent's content box can be derived from its bounds. */
export type PreviewBoxMeasure = { padding: PreviewSides; border: PreviewSides }
/** Untransformed border box in layout pixels relative to the offset parent's padding edge, plus the transform origin. */
export type PreviewOffsetMeasure = { x: number; y: number; width: number; height: number; origin: { x: number; y: number } }
/** Used line height of a native canvas text node, resolved by the browser in CSS pixels. */
export type PreviewTextMeasure = { resolvedLineHeight: number }
type PreviewGeometryItemBase = {
  instanceId: string
  /** Component visual AABB, or a canvas primitive's untransformed border box centered on the transformed face. */
  bounds: PreviewBounds
  /** Raw visual viewport AABB from `getBoundingClientRect`, before primitive interaction-box normalization. */
  worldAabb: PreviewBounds
  box?: PreviewBoxMeasure
  offset?: PreviewOffsetMeasure
  /**
   * The verified editor node whose DOM root is this element's CSS offset parent. `null` means the runtime verified
   * the source-specific preview host. Absence means the offset-parent chain could not be proven.
   */
  offsetParentNodeId?: string | null
  /** Verified matrix from a top-level node's source-specific offset-parent padding edge into page-root coordinates. */
  offsetParentToRoot?: PreviewMatrix
  /** The mounted component whose root is this element's CSS offset parent; null when the offset parent is the host or another element. */
  offsetParentInstanceId?: string | null
  /** Closest mounted component ancestor, null for roots of the host. */
  parentInstanceId?: string | null
  /** True when the element is a direct DOM child of that ancestor's root (a real layout participant). */
  directChild?: boolean
  transform?: PreviewMatrix
  layout?: PreviewLayoutReport
  grid?: PreviewGridMeasure
  theme?: PreviewThemeStatus
}
export type PreviewGeometryItem = PreviewGeometryItemBase & (
  | { source: 'component'; componentId: string }
  | { source: 'canvas'; canvasKind: 'text'; text?: PreviewTextMeasure }
  | { source: 'canvas'; canvasKind: 'frame' | 'rectangle' | 'shape' | 'shader' }
)
export type PreviewRootGeometry = { componentId: string; bounds: PreviewBounds }
/**
 * Camera the preview rendered with when geometry was measured.
 * Screen = viewport center + (x, y) + world * zoom, in iframe viewport CSS pixels.
 */
export type PreviewCamera = { x: number; y: number; zoom: number; width: number; height: number }
/** Nodes whose layout could not be applied and which have no single measurable root (an ambiguous or missing root). */
export type PreviewUnsupportedLayout = { instanceId: string; status: LayoutStatus }
/** Theme statuses of nodes without a measurable root, plus portal-like roots that appeared without an owner claim. */
export type PreviewThemeDiagnostics = { nodes: { instanceId: string; status: PreviewThemeStatus }[]; unownedPortals: number }
export type PreviewGeometry = { items: PreviewGeometryItem[]; root: PreviewRootGeometry | null; documentRevision: number; layoutGeneration: number; unsupported?: PreviewUnsupportedLayout[]; theme?: PreviewThemeDiagnostics }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
const optional = (value: Record<string, unknown>, required: string[], optionalFields: string[]) => exact(value, [...required, ...optionalFields.filter(field => Object.hasOwn(value, field))])
const finiteWithin = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
export const isGeometryId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
export function isPreviewBounds(value: unknown): value is PreviewBounds {
  return record(value) && exact(value, ['x', 'y', 'width', 'height']) && ['x', 'y', 'width', 'height'].every(key => finiteWithin(value[key], 1_000_000)) && (value.width as number) >= 0 && (value.height as number) >= 0
}
export function isPreviewCamera(value: unknown): value is PreviewCamera {
  if (!record(value) || !exact(value, ['x', 'y', 'zoom', 'width', 'height'])) return false
  if (!['x', 'y', 'zoom', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))) return false
  return Math.abs(value.x as number) <= 100_000_000 && Math.abs(value.y as number) <= 100_000_000 && (value.zoom as number) >= 0.001 && (value.zoom as number) <= 10_000 && (value.width as number) >= 0 && (value.width as number) <= 100_000 && (value.height as number) >= 0 && (value.height as number) <= 100_000
}
export const isPreviewMatrix = (value: unknown): value is PreviewMatrix => Array.isArray(value) && value.length === 6 && value.every(part => finiteWithin(part, 1_000_000))
const isSides = (value: unknown): value is PreviewSides => record(value) && exact(value, ['top', 'right', 'bottom', 'left']) && ['top', 'right', 'bottom', 'left'].every(key => finiteWithin(value[key], 1_000_000) && (value[key] as number) >= 0)
const isTrackList = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 1000 && value.every(part => finiteWithin(part, 1_000_000) && part >= 0)
export function isPreviewGridMeasure(value: unknown): value is PreviewGridMeasure {
  if (!record(value) || !optional(value, ['columns', 'rows', 'columnGap', 'rowGap', 'padding'], ['justifyContent', 'alignContent'])) return false
  for (const key of ['justifyContent', 'alignContent']) if (Object.hasOwn(value, key) && !(previewContentDistributions as readonly unknown[]).includes(value[key])) return false
  return isTrackList(value.columns) && isTrackList(value.rows) && finiteWithin(value.columnGap, 1_000_000) && (value.columnGap as number) >= 0 && finiteWithin(value.rowGap, 1_000_000) && (value.rowGap as number) >= 0 && isSides(value.padding)
}
export function isPreviewLayoutReport(value: unknown): value is PreviewLayoutReport {
  return record(value) && exact(value, ['status', 'conflicts']) && isLayoutStatus(value.status) && Array.isArray(value.conflicts) && value.conflicts.length <= 64 && value.conflicts.every(name => typeof name === 'string' && /^[a-z-]{1,40}$/.test(name))
}
export const isPreviewBoxMeasure = (value: unknown): value is PreviewBoxMeasure => record(value) && exact(value, ['padding', 'border']) && isSides(value.padding) && isSides(value.border)
export const isPreviewOffsetMeasure = (value: unknown): value is PreviewOffsetMeasure => record(value) && exact(value, ['x', 'y', 'width', 'height', 'origin']) && ['x', 'y', 'width', 'height'].every(key => finiteWithin(value[key], 1_000_000)) && (value.width as number) >= 0 && (value.height as number) >= 0 && record(value.origin) && exact(value.origin, ['x', 'y']) && finiteWithin(value.origin.x, 1_000_000) && finiteWithin(value.origin.y, 1_000_000)
export const isPreviewTextMeasure = (value: unknown): value is PreviewTextMeasure => record(value) && exact(value, ['resolvedLineHeight']) && finiteWithin(value.resolvedLineHeight, 1_000_000) && (value.resolvedLineHeight as number) > 0
export function isPreviewGeometryItem(value: unknown): value is PreviewGeometryItem {
  if (!record(value)) return false
  const identity = value.source === 'component'
    ? { required: ['instanceId', 'source', 'componentId', 'bounds', 'worldAabb'], optional: ['box', 'offset', 'offsetParentNodeId', 'offsetParentToRoot', 'offsetParentInstanceId', 'parentInstanceId', 'directChild', 'transform', 'layout', 'grid', 'theme'] }
    : value.source === 'canvas'
      ? { required: ['instanceId', 'source', 'canvasKind', 'bounds', 'worldAabb'], optional: ['box', 'offset', 'offsetParentNodeId', 'offsetParentToRoot', 'directChild', 'transform', 'grid', ...(value.canvasKind === 'text' ? ['text'] : [])] }
      : null
  if (!identity || !optional(value, identity.required, identity.optional)) return false
  if (Object.hasOwn(value, 'theme') && !isPreviewThemeStatus(value.theme)) return false
  if (Object.hasOwn(value, 'box') && !isPreviewBoxMeasure(value.box)) return false
  if (Object.hasOwn(value, 'offset') && !isPreviewOffsetMeasure(value.offset)) return false
  if (Object.hasOwn(value, 'offsetParentNodeId') && value.offsetParentNodeId !== null && !isGeometryId(value.offsetParentNodeId)) return false
  if (Object.hasOwn(value, 'offsetParentToRoot') && !isPreviewMatrix(value.offsetParentToRoot)) return false
  if (Object.hasOwn(value, 'offsetParentInstanceId') && value.offsetParentInstanceId !== null && !isGeometryId(value.offsetParentInstanceId)) return false
  if (!isGeometryId(value.instanceId) || !isPreviewBounds(value.bounds) || !isPreviewBounds(value.worldAabb)) return false
  if (value.source === 'component' ? !isGeometryId(value.componentId) : !['frame', 'rectangle', 'shape', 'shader', 'text'].includes(String(value.canvasKind))) return false
  if (Object.hasOwn(value, 'text') && (value.source !== 'canvas' || value.canvasKind !== 'text' || !isPreviewTextMeasure(value.text))) return false
  if (Object.hasOwn(value, 'parentInstanceId') && value.parentInstanceId !== null && !isGeometryId(value.parentInstanceId)) return false
  if (Object.hasOwn(value, 'directChild') && typeof value.directChild !== 'boolean') return false
  if (Object.hasOwn(value, 'transform') && !isPreviewMatrix(value.transform)) return false
  if (Object.hasOwn(value, 'layout') && !isPreviewLayoutReport(value.layout)) return false
  if (Object.hasOwn(value, 'grid') && !isPreviewGridMeasure(value.grid)) return false
  return true
}
export function isPreviewGeometry(value: unknown): value is PreviewGeometry {
  if (!record(value) || !optional(value, ['items', 'root', 'documentRevision', 'layoutGeneration'], ['unsupported', 'theme']) || !Array.isArray(value.items) || value.items.length > 500 || !Number.isSafeInteger(value.documentRevision) || (value.documentRevision as number) < 0) return false
  if (Object.hasOwn(value, 'theme') && !(record(value.theme) && exact(value.theme, ['nodes', 'unownedPortals']) && Number.isSafeInteger(value.theme.unownedPortals) && (value.theme.unownedPortals as number) >= 0 && Array.isArray(value.theme.nodes) && value.theme.nodes.length <= 500 && value.theme.nodes.every(entry => record(entry) && exact(entry, ['instanceId', 'status']) && isGeometryId(entry.instanceId) && isPreviewThemeStatus(entry.status) && entry.status !== 'applied'))) return false
  if (!(Number.isSafeInteger(value.layoutGeneration) && (value.layoutGeneration as number) >= 0)) return false
  if (Object.hasOwn(value, 'unsupported') && !(Array.isArray(value.unsupported) && value.unsupported.length <= 500 && value.unsupported.every(entry => record(entry) && exact(entry, ['instanceId', 'status']) && isGeometryId(entry.instanceId) && isLayoutStatus(entry.status) && entry.status !== 'applied'))) return false
  const ids = new Set<string>()
  for (const item of value.items) {
    if (!isPreviewGeometryItem(item) || ids.has(item.instanceId)) return false
    ids.add(item.instanceId)
  }
  return value.root === null || (record(value.root) && exact(value.root, ['componentId', 'bounds']) && isGeometryId(value.root.componentId) && isPreviewBounds(value.root.bounds))
}
