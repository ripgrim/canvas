/**
 * Pure layout edits for component nodes: positioning mode switches, insets, semantic sizing transitions, bounds,
 * aspect ratio and spacing. Every function returns the next v4 layout record for one node without touching the
 * store, so multi-selection edits can gather results and commit them as one batch (one undo entry).
 */
import { applyDefiniteMainAxis, autoLength, classifySizing, normalizeItem, transitionSizing } from '@canvas/repo-engine/layout'
import type { AxisSize, DisplayMode, FlexDirection, InsetLength, LayoutItem, LayoutLength, NodeLayout, NodeSpacing, SizingMode } from '@canvas/repo-engine/layout'

export type Axis = 'width' | 'height'
export type InsetSide = 'left' | 'right' | 'top' | 'bottom'
export type AxisMeasurement = { measuredPx?: number | undefined; parentPx?: number | undefined }
export type SizingTarget = { id: string; layout: NodeLayout | undefined; measurement: AxisMeasurement; parentDirection?: FlexDirection | null }

export const emptyLayout = (): NodeLayout => ({ item: { position: { mode: 'flow' } } })
const withItem = (layout: NodeLayout | undefined, item: LayoutItem): NodeLayout => ({ ...(layout ?? emptyLayout()), item })
const itemOf = (layout: NodeLayout | undefined): LayoutItem => layout?.item ?? emptyLayout().item

/** Flow to absolute: the node keeps its sizing and gains px left/top from its current parent-local position. */
export function positionAbsolute(layout: NodeLayout | undefined, local: { x: number; y: number }): NodeLayout {
  const item = itemOf(layout)
  if (item.position.mode === 'absolute') return layout ?? emptyLayout()
  return withItem(layout, { ...item, position: { mode: 'absolute', left: { kind: 'px', value: Math.round(local.x) }, top: { kind: 'px', value: Math.round(local.y) } } })
}
/** Absolute to flow: insets and z-index are stale in flow and drop; width, height, bounds and aspect survive (LAY-GEST-004). */
export function positionFlow(layout: NodeLayout | undefined, parentDisplay: DisplayMode | null): NodeLayout {
  const item = itemOf(layout)
  if (item.position.mode === 'flow') return layout ?? emptyLayout()
  return withItem(layout, normalizeItem({ ...item, position: { mode: 'flow' } }, parentDisplay))
}
/** Sets or clears one inset of an absolute node. Opposing insets are preserved (anchors stay as authored). */
export function setInset(layout: NodeLayout | undefined, side: InsetSide, length: InsetLength | null): NodeLayout | null {
  const item = itemOf(layout)
  if (item.position.mode !== 'absolute') return null
  const position = { ...item.position }
  if (length) position[side] = length
  else delete position[side]
  return withItem(layout, { ...item, position })
}
export function setZIndex(layout: NodeLayout | undefined, zIndex: number | null): NodeLayout | null {
  const item = itemOf(layout)
  if (item.position.mode !== 'absolute') return null
  const position = { ...item.position }
  if (zIndex === null) delete position.zIndex
  else position.zIndex = Math.round(zIndex)
  return withItem(layout, { ...item, position })
}

export const sizingModeOf = (layout: NodeLayout | undefined, axis: Axis): SizingMode => classifySizing(layout?.item[axis]?.value)
const isMainAxis = (axis: Axis, direction: FlexDirection | null | undefined) => direction ? (direction.startsWith('row') ? axis === 'width' : axis === 'height') : false

/**
 * Changes one axis to a sizing mode using this node's own measurement. Returns null when the transition has nothing
 * to store (Calculate without a source value). A definite main axis inside a Flex parent applies the shrink rule.
 */
export function setAxisSizing(layout: NodeLayout | undefined, axis: Axis, mode: SizingMode, measurement: AxisMeasurement, parentDirection: FlexDirection | null = null): NodeLayout | null {
  const item = itemOf(layout)
  const current = item[axis]
  const length = transitionSizing(mode, { current: current?.value, measuredPx: measurement.measuredPx, parentPx: measurement.parentPx })
  if (!length) return null
  const nextAxis: AxisSize = { ...(current ?? {}), value: length }
  let next: LayoutItem = { ...item, [axis]: nextAxis }
  if (isMainAxis(axis, parentDirection) && parentDirection) next = applyDefiniteMainAxis(next, parentDirection)
  return withItem(layout, next)
}
/** Multi-selection transition: per-node measurements, Relative skipped without a positive parent, one result map for one batch. */
export function setAxisSizingMany(targets: readonly SizingTarget[], axis: Axis, mode: SizingMode): Record<string, NodeLayout> {
  const results: Record<string, NodeLayout> = {}
  for (const target of targets) {
    const hasParent = typeof target.measurement.parentPx === 'number' && Number.isFinite(target.measurement.parentPx) && target.measurement.parentPx > 0
    const current = target.layout?.item[axis]?.value
    if (mode === 'relative' && !hasParent && current?.kind !== 'percent') continue
    const next = setAxisSizing(target.layout, axis, mode, target.measurement, target.parentDirection ?? null)
    if (next) results[target.id] = next
  }
  return results
}
/** Sets an explicit px length on an axis (inspector number field), keeping bounds. */
export function setAxisLength(layout: NodeLayout | undefined, axis: Axis, length: LayoutLength | null): NodeLayout {
  const item = itemOf(layout)
  const next: LayoutItem = { ...item }
  if (length === null) { if (item[axis]?.min || item[axis]?.max) next[axis] = { ...item[axis]!, value: autoLength }; else delete next[axis] }
  else next[axis] = { ...(item[axis] ?? {}), value: length }
  return withItem(layout, next)
}
export function setAxisBound(layout: NodeLayout | undefined, axis: Axis, bound: 'min' | 'max', length: LayoutLength | null): NodeLayout {
  const item = itemOf(layout)
  const current: AxisSize = item[axis] ?? { value: autoLength }
  const nextAxis: AxisSize = { ...current }
  if (length === null) delete nextAxis[bound]
  else nextAxis[bound] = length
  return withItem(layout, { ...item, [axis]: nextAxis })
}
export function setAspectRatio(layout: NodeLayout | undefined, ratio: number | null): NodeLayout {
  const item = { ...itemOf(layout) }
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) delete item.aspectRatio
  else item.aspectRatio = ratio
  return withItem(layout, item)
}
export function setSpacing(layout: NodeLayout | undefined, spacing: NodeSpacing | null): NodeLayout {
  const base = layout ?? emptyLayout()
  const next: NodeLayout = { ...base }
  if (!spacing || (spacing.padding === undefined && spacing.margin === undefined)) delete next.spacing
  else next.spacing = { ...(spacing.padding !== undefined ? { padding: spacing.padding } : {}), ...(spacing.margin !== undefined ? { margin: spacing.margin } : {}) }
  return next
}
