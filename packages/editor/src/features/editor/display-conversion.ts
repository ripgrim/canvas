/**
 * Semantic display conversions between Freeform, Block, Flex and Grid. A conversion
 * rewrites the container and its children together: order, margins, padding, gaps and child placement change so the
 * result keeps the measured appearance where the target mode can express it. Pure: measurements come from the caller.
 */
import { inferFlexLayout } from '@canvas/repo-engine/flex-inference'
import type { FlexInferenceInput } from '@canvas/repo-engine/flex-inference'
import { availableSizingModes, normalizeContainer, normalizeLayout, spacingSides } from '@canvas/repo-engine/layout'
import type { DisplayMode, FlexContainer, FlexDirection, GridContainer, LayoutContainer, LayoutGap, LayoutItem, NodeLayout } from '@canvas/repo-engine/layout'
import { planPaperAddSizing, reconcilePaperSizing } from '@canvas/repo-engine/paper-sizing'
import type { PaperSizingCapabilities, PaperSizingParent, PaperSizingSnapshot } from '@canvas/repo-engine/paper-sizing'
import type { NodePrimitiveSize, NodeTextProperties } from '@canvas/repo-engine/file-document'
import type { GridTrack } from '@canvas/repo-engine/grid-tracks'
import type { Rect } from './canvas-math'
import type { MeasuredChildren } from './layout-flex-commands'
import type { PaperDirectAddGeometry } from './layout-measure'

export type ConversionNode = { id: string; layout: NodeLayout | undefined; defaultPosition?: LayoutItem['position']['mode'] }
export type DisplayMeasurement = {
  /** Border boxes retained for Block, Grid and legacy Freeform conversions. */
  boxes: MeasuredChildren | null
  /** Legacy field retained for non-Direct callers while Direct Add uses one closed capture. */
  flexInput?: FlexInferenceInput | null
  /** Exact, revision-bound inference and sizing capture for Paper Direct Add. */
  directAdd?: PaperDirectAddGeometry | null
}
export type DisplayConversionInput = {
  container: ConversionNode & { parentDisplay?: DisplayMode | null; parentFlexDirection?: FlexDirection; hasNonRootParent?: boolean }
  /** Modeled children in document order. */
  children: readonly ConversionNode[]
  measured: DisplayMeasurement | null
  to: DisplayMode
}
/** Each target map is independent because text may require all three authorities in the same transaction. */
export type DisplayConversion = {
  layouts: Record<string, NodeLayout>
  primitiveSizes?: Record<string, NodePrimitiveSize>
  textProperties?: Record<string, NodeTextProperties>
  order?: string[]
  unsupported?: string
}

export const conversionCopy = {
  unmeasured: 'Some children have no measured position',
  tooManyTracks: 'Too many rows or columns for a Grid',
} as const

const bucket = 4
const tolerance = 2
const maxTracks = 200
const round4 = (value: number) => Math.round(value / bucket) * bucket
const fr: GridTrack = { kind: 'fr', value: 1 }
const autoTrack: GridTrack = { kind: 'auto' }
const emptyLayout = (position: LayoutItem['position']['mode'] = 'flow'): NodeLayout => ({ item: { position: { mode: position } } })

export const displayOf = (layout: NodeLayout | undefined): DisplayMode => layout?.container?.display ?? 'freeform'
const rowGapOf = (gap: LayoutGap | undefined) => gap === undefined ? 0 : typeof gap === 'number' ? gap : gap.y
const reversed = (flex: FlexContainer | undefined) => Boolean(flex?.direction.endsWith('-reverse'))
const validRect = (rect: Rect | null | undefined): rect is Rect => Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)

/** Absolute insets and padding count from the padding edge, so the container border is removed when it was measured. */
function paddingBox(measured: MeasuredChildren | null): Rect | null {
  const box = measured?.container
  if (!validRect(box)) return null
  const border = measured?.border ?? { top: 0, right: 0, bottom: 0, left: 0 }
  return { x: box.x + border.left, y: box.y + border.top, width: Math.max(0, box.width - border.left - border.right), height: Math.max(0, box.height - border.top - border.bottom) }
}
/** The smaller opposing inset per axis, bucketed to 4 px and never negative (the flex inference rule). */
function inferPadding(box: Rect, rects: readonly Rect[]): { x: number; y: number } {
  const minX = Math.min(...rects.map(rect => rect.x)), maxX = Math.max(...rects.map(rect => rect.x + rect.width))
  const minY = Math.min(...rects.map(rect => rect.y)), maxY = Math.max(...rects.map(rect => rect.y + rect.height))
  return { x: round4(Math.max(0, Math.min(minX - box.x, box.x + box.width - maxX))), y: round4(Math.max(0, Math.min(minY - box.y, box.y + box.height - maxY))) }
}
/** Gaps under 2 px vote for zero; others vote in 4 px buckets; the winning bucket's raw values are averaged. */
function commonGap(raws: readonly number[]): number {
  if (!raws.length) return 0
  const votes = new Map<number, number[]>()
  for (const raw of raws) { const key = raw < tolerance ? 0 : Math.round(raw / bucket); (votes.get(key) ?? votes.set(key, []).get(key)!).push(raw) }
  const winner = [...votes.entries()].sort((left, right) => right[1].length - left[1].length || left[0] - right[0])[0]!
  return winner[0] === 0 ? 0 : Math.round(winner[1].reduce((sum, raw) => sum + raw, 0) / winner[1].length)
}
/** Clusters rectangles along one axis: an item joins the current cluster when it overlaps the cluster's first item by half of the smaller size. */
function clusters<T extends { rect: Rect }>(items: readonly T[], axis: 'x' | 'y'): T[][] {
  const start = (rect: Rect) => axis === 'x' ? rect.x : rect.y
  const size = (rect: Rect) => axis === 'x' ? rect.width : rect.height
  const other = (rect: Rect) => axis === 'x' ? rect.y : rect.x
  const sorted = [...items].sort((left, right) => start(left.rect) - start(right.rect) || other(left.rect) - other(right.rect))
  const result: T[][] = []
  for (const item of sorted) {
    const head = result[result.length - 1]?.[0]
    if (head) {
      const overlap = Math.min(start(head.rect) + size(head.rect), start(item.rect) + size(item.rect)) - Math.max(start(head.rect), start(item.rect))
      if (overlap >= 0.5 * Math.min(size(head.rect), size(item.rect))) { result[result.length - 1]!.push(item); continue }
    }
    result.push([item])
  }
  return result
}

const withContainer = (layout: NodeLayout, container: LayoutContainer): NodeLayout => ({ ...layout, container: normalizeContainer(container) })
const withPadding = (layout: NodeLayout, padding: { x: number; y: number }): NodeLayout => ({ ...layout, spacing: { ...(layout.spacing ?? {}), padding } })
/** Margin top on one child; the other sides keep their authored values (zero when none were authored). */
function withMarginTop(layout: NodeLayout, top: number): NodeLayout {
  const margin = layout.spacing?.margin
  const sides = margin === undefined ? { top: 0, right: 0, bottom: 0, left: 0 } : spacingSides(margin)
  return { ...layout, spacing: { ...(layout.spacing ?? {}), margin: { top, right: sides.right, bottom: sides.bottom, left: sides.left } } }
}
const toFlow = (layout: NodeLayout): NodeLayout => ({ ...layout, item: { ...layout.item, position: { mode: 'flow' } } })
function withoutGridStarts(item: LayoutItem): LayoutItem {
  if (!item.grid) return item
  const grid = { ...item.grid }
  delete grid.columnStart; delete grid.rowStart
  const next: LayoutItem = { ...item, grid }
  if (!Object.keys(grid).length) delete next.grid
  return next
}

const explicitCapabilities = (fit: boolean, fill: boolean, relative: boolean, constrained: boolean): PaperSizingCapabilities => ({
  width: { fit, fill, relative, constrained },
  height: { fit, fill, relative, constrained },
})
const flexChildCapabilities = (snapshot: PaperSizingSnapshot): PaperSizingCapabilities => snapshot.kind === 'text'
  ? explicitCapabilities(true, true, true, false)
  : explicitCapabilities(true, true, true, true)
function parentCapabilities(hasParent: boolean): PaperSizingCapabilities {
  const modes = availableSizingModes({ hasParent, intrinsicContent: true })
  return explicitCapabilities(modes.includes('hug'), modes.includes('fill'), modes.includes('relative'), true)
}
function surroundingParent(input: DisplayConversionInput): PaperSizingParent {
  const display = input.container.parentDisplay ?? 'freeform'
  return display === 'flex'
    ? { display, flexDirection: input.container.parentFlexDirection ?? 'row' }
    : { display }
}

export function convertDisplay(input: DisplayConversionInput): DisplayConversion {
  const from = displayOf(input.container.layout)
  const to = input.to
  if (from === to) return { layouts: {} }
  const boxes = input.measured?.boxes ?? null
  const base = input.container.layout ?? emptyLayout(input.container.defaultPosition)
  const previous: LayoutContainer = base.container ?? { display: 'freeform' }
  const overflow = previous.overflow !== undefined ? { overflow: previous.overflow } : {}
  const documentOrder = input.children.map(child => child.id)
  const children = new Map(input.children.map(child => [child.id, child.layout ?? emptyLayout(child.defaultPosition)]))
  const box = paddingBox(boxes)
  const rectOf = (id: string) => { const rect = boxes?.children[id]; return validRect(rect) ? rect : null }
  const measured = input.children.flatMap(child => { const rect = rectOf(child.id); return rect ? [{ id: child.id, rect }] : [] })
  const unmeasured = documentOrder.filter(id => !rectOf(id))
  let container: NodeLayout = base
  let order = documentOrder
  const issues: string[] = []

  if (to === 'freeform') {
    // Children leave the flow at their measured place; an unmeasured child has no place to keep and stays in flow.
    container = withContainer(base, { display: 'freeform', ...overflow })
    for (const id of documentOrder) {
      const layout = children.get(id)!
      const rect = rectOf(id)
      if (layout.item.position.mode === 'absolute') continue
      if (!rect || !box) { issues.push(conversionCopy.unmeasured); continue }
      children.set(id, { ...layout, item: { ...layout.item, position: { mode: 'absolute', left: { kind: 'px', value: Math.round(rect.x - box.x) }, top: { kind: 'px', value: Math.round(rect.y - box.y) } } } })
    }
  } else if (to === 'block') {
    container = withContainer(base, { display: 'block', ...overflow })
    if (from === 'flex' || from === 'grid') {
      if (from === 'flex' && reversed(previous.flex)) order = [...documentOrder].reverse()
      // Only a vertical stacking gap survives as block spacing: a column Flex row gap or a Grid row gap.
      const stacked = from === 'grid' || !previous.flex || previous.flex.direction.startsWith('column')
      const gap = rowGapOf(previous.gap)
      if (stacked && gap > 0) for (const id of order.slice(1)) children.set(id, withMarginTop(children.get(id)!, gap))
    } else {
      // Freeform: visual reading order, padding from the content inset, margins from the measured vertical gaps.
      const sorted = [...measured].sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x)
      order = [...sorted.map(child => child.id), ...unmeasured]
      if (box && sorted.length) container = withPadding(container, inferPadding(box, sorted.map(child => child.rect)))
      for (let index = 1; index < sorted.length; index++) {
        const above = sorted[index - 1]!.rect, current = sorted[index]!
        const gap = Math.round(current.rect.y - (above.y + above.height))
        if (gap > 0) children.set(current.id, withMarginTop(children.get(current.id)!, gap))
      }
      if (unmeasured.length) issues.push(conversionCopy.unmeasured)
    }
    for (const id of documentOrder) children.set(id, toFlowIfFreeform(from, children.get(id)!))
  } else if (to === 'flex') {
    if (from === 'freeform') {
      const capture = input.measured?.directAdd ?? null
      if (!capture || capture.input.kind !== 'direct-add' || capture.input.isRoot) return { layouts: {}, unsupported: conversionCopy.unmeasured }
      const inference = inferFlexLayout(capture.input)
      const plans = new Map(inference.synthetic.children.map(child => [child.id, child]))
      const snapshots = documentOrder.map(id => capture.childSnapshots[id])
      if (capture.parentSnapshot.nodeId !== input.container.id || plans.size !== documentOrder.length || documentOrder.some(id => !plans.has(id)) || inference.order.length !== documentOrder.length || snapshots.some(snapshot => !snapshot)) return { layouts: {}, unsupported: conversionCopy.unmeasured }
      try {
        const targetParent = surroundingParent(input)
        const parentCaps = parentCapabilities(input.container.hasNonRootParent ?? input.container.parentDisplay !== null)
        const sizingPlan = planPaperAddSizing({
          parent: capture.parentSnapshot,
          direction: inference.direction.startsWith('row') ? 'row' : 'column',
          inferred: { width: inference.synthetic.container.width, height: inference.synthetic.container.height },
          parentIsFlexChild: targetParent.display === 'flex' && capture.parentSnapshot.sourcePosition.mode === 'flow',
          parentCapabilities: parentCaps,
          children: snapshots.map(snapshot => ({ snapshot: snapshot!, capabilities: flexChildCapabilities(snapshot!) })),
        })
        const parentTarget = reconcilePaperSizing({
          operation: 'add',
          snapshot: capture.parentSnapshot,
          targetPosition: capture.parentSnapshot.sourcePosition,
          targetParent,
          capabilities: parentCaps,
          overrides: sizingPlan.parentAxes,
        })
        container = withPadding(withContainer(parentTarget.layout, {
          display: 'flex',
          ...overflow,
          gap: inference.gap,
          flex: { direction: inference.direction, wrap: inference.wrap, justify: inference.justify, align: inference.align },
        }), inference.padding)
        const layouts: Record<string, NodeLayout> = { [input.container.id]: container }
        const primitiveSizes: Record<string, NodePrimitiveSize> = {}
        const textProperties: Record<string, NodeTextProperties> = {}
        if (parentTarget.styles) primitiveSizes[input.container.id] = parentTarget.styles
        if (parentTarget.textProperties) textProperties[input.container.id] = parentTarget.textProperties
        const childAxes = new Map(sizingPlan.childAxes.map(child => [child.nodeId, child.axes]))
        const flexParent: PaperSizingParent = { display: 'flex', flexDirection: inference.direction }
        for (const snapshot of snapshots as PaperSizingSnapshot[]) {
          const target = reconcilePaperSizing({
            operation: 'add',
            snapshot,
            targetPosition: plans.get(snapshot.nodeId)!.position === 'absolute' ? snapshot.sourcePosition : { mode: 'flow' },
            targetParent: flexParent,
            capabilities: flexChildCapabilities(snapshot),
            ...(childAxes.get(snapshot.nodeId) ? { overrides: childAxes.get(snapshot.nodeId)! } : {}),
          })
          layouts[snapshot.nodeId] = target.layout
          if (target.styles) primitiveSizes[snapshot.nodeId] = target.styles
          if (target.textProperties) textProperties[snapshot.nodeId] = target.textProperties
        }
        order = [...inference.order]
        const changedOrder = order.some((id, index) => id !== documentOrder[index])
        return {
          layouts,
          ...(Object.keys(primitiveSizes).length ? { primitiveSizes } : {}),
          ...(Object.keys(textProperties).length ? { textProperties } : {}),
          ...(changedOrder ? { order } : {}),
        }
      } catch {
        return { layouts: {}, unsupported: conversionCopy.unmeasured }
      }
    } else if (from === 'grid') {
      container = withContainer(base, { display: 'flex', ...overflow, flex: { direction: 'row', wrap: 'wrap', justify: 'start', align: 'start' }, ...(previous.gap !== undefined ? { gap: previous.gap } : {}) })
    } else {
      container = withContainer(base, { display: 'flex', ...overflow, flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } })
    }
  } else {
    let grid: GridContainer
    let gap: LayoutGap | undefined
    const starts = new Map<string, { columnStart: number; rowStart: number }>()
    if (from === 'flex') {
      const flex = previous.flex
      if (reversed(flex)) order = [...documentOrder].reverse()
      let columns = Math.max(1, documentOrder.length)
      if (!flex || flex.direction.startsWith('column')) columns = 1
      else if (flex.wrap !== 'nowrap' && measured.length) columns = Math.max(...clusters(measured, 'y').map(line => line.length))
      columns = Math.min(maxTracks, columns)
      const rows = Math.min(maxTracks, Math.max(1, Math.ceil(documentOrder.length / columns)))
      grid = { columns: Array.from({ length: columns }, () => fr), rows: Array.from({ length: rows }, () => autoTrack), autoFlow: 'row' }
      gap = previous.gap
    } else if (from === 'freeform' && measured.length) {
      const columnClusters = clusters(measured, 'x'), rowClusters = clusters(measured, 'y')
      if (columnClusters.length > maxTracks || rowClusters.length > maxTracks) return { layouts: {}, unsupported: conversionCopy.tooManyTracks }
      columnClusters.forEach((cluster, column) => { for (const child of cluster) starts.set(child.id, { columnStart: column + 1, rowStart: 0 }) })
      rowClusters.forEach((cluster, row) => { for (const child of cluster) starts.get(child.id)!.rowStart = row + 1 })
      const extent = (cluster: readonly { rect: Rect }[], axis: 'x' | 'y') => ({ start: Math.min(...cluster.map(child => axis === 'x' ? child.rect.x : child.rect.y)), end: Math.max(...cluster.map(child => axis === 'x' ? child.rect.x + child.rect.width : child.rect.y + child.rect.height)) })
      const spacing: number[] = []
      for (const [list, axis] of [[columnClusters, 'x'], [rowClusters, 'y']] as const) for (let index = 1; index < list.length; index++) spacing.push(Math.max(0, extent(list[index]!, axis).start - extent(list[index - 1]!, axis).end))
      const common = commonGap(spacing)
      if (common > 0) gap = common
      grid = { columns: columnClusters.map(() => fr), rows: rowClusters.map(() => autoTrack), autoFlow: 'row' }
      const documentIndex = new Map(documentOrder.map((id, index) => [id, index]))
      const placed = [...starts.entries()].sort((left, right) => left[1].rowStart - right[1].rowStart || left[1].columnStart - right[1].columnStart || documentIndex.get(left[0])! - documentIndex.get(right[0])!)
      order = [...placed.map(([id]) => id), ...unmeasured]
      if (box) container = withPadding(container, inferPadding(box, measured.map(child => child.rect)))
      if (unmeasured.length) issues.push(conversionCopy.unmeasured)
    } else {
      // Block (and an unmeasured Freeform): one column, one auto row per child.
      grid = { columns: [fr], rows: Array.from({ length: Math.min(maxTracks, Math.max(1, documentOrder.length)) }, () => autoTrack), autoFlow: 'row' }
      if (from === 'freeform') issues.push(conversionCopy.unmeasured)
    }
    container = withContainer(container, { display: 'grid', ...overflow, grid, ...(gap !== undefined ? { gap } : {}) })
    for (const id of documentOrder) {
      let layout = toFlowIfFreeform(from, children.get(id)!)
      layout = { ...layout, item: withoutGridStarts(layout.item) }
      const start = starts.get(id)
      if (start) layout = { ...layout, item: { ...layout.item, grid: { ...(layout.item.grid ?? {}), ...start } } }
      children.set(id, layout)
    }
  }

  // The container's own item is only normalized when the caller knows its parent's display.
  const layouts: Record<string, NodeLayout> = { [input.container.id]: input.container.parentDisplay === undefined ? container : normalizeLayout(container, input.container.parentDisplay) }
  for (const id of documentOrder) layouts[id] = normalizeLayout(children.get(id)!, to)
  const changedOrder = order.some((id, index) => id !== documentOrder[index])
  const unique = [...new Set(issues)]
  return { layouts, ...(changedOrder ? { order } : {}), ...(unique.length ? { unsupported: unique.join('. ') } : {}) }
}
/** Children of a Freeform container were placed by insets; any flow mode drops them (and their z-index). */
const toFlowIfFreeform = (from: DisplayMode, layout: NodeLayout): NodeLayout => from === 'freeform' ? toFlow(layout) : layout
