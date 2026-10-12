/**
 * Drop index for a flow child dragged inside a Flex parent. Siblings group into visual lines by cross-axis overlap, the
 * pointer picks the nearest line, and the main-axis position inside that line honours reversed directions. Siblings
 * without a usable rectangle stay in document order but take no part in the geometry.
 */
import type { FlexDirection, FlexWrap } from '@canvas/repo-engine/layout'
import type { Point, Rect } from './canvas-math'

export type FlexMeasurementAuthority = Readonly<{ measurementRevision: number; documentRevision: number; layoutGeneration: number }>
export type FlexReorderSibling<TKind extends string = string> = Readonly<{ id: string; rect: Rect; kind?: TKind }>
export type MeasuredFlexReorderInput<TKind extends string = string> = Readonly<{
  pointer: Point
  draggedId: string
  direction: FlexDirection
  wrap: FlexWrap
  expected: FlexMeasurementAuthority
  measurement: FlexMeasurementAuthority & Readonly<{ siblings: readonly FlexReorderSibling<TKind>[] }>
  /** Maximum world-space distance outside the nearest visual line. Omit for the legacy unbounded resolver. */
  crossAxisTolerance?: number
}>

export type FlexInsertGuide = { axis: 'x' | 'y'; position: number; start: number; end: number }
/**
 * `index` is a gap position among all siblings in document order, the dragged node included (0 is before the first,
 * `siblings.length` after the last), which is what `commands.reorderFlow` expects. `line` counts lines in document
 * order. `guide` is the insertion marker: a line across the main axis at `position`, spanning the line's cross extent.
 */
export type FlexInsertTarget = { index: number; line: number; guide: FlexInsertGuide | null }
export type MeasuredFlexInsertTarget =
  | Readonly<{ status: 'ready'; authority: FlexMeasurementAuthority; target: FlexInsertTarget }>
  | Readonly<{ status: 'stale'; expected: FlexMeasurementAuthority; actual: FlexMeasurementAuthority; target: null }>
  | Readonly<{ status: 'outside'; authority: FlexMeasurementAuthority; target: null }>

const usable = (rect: Rect | undefined): rect is Rect => Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)

const sameAuthority = (left: FlexMeasurementAuthority, right: FlexMeasurementAuthority) => left.measurementRevision === right.measurementRevision && left.documentRevision === right.documentRevision && left.layoutGeneration === right.layoutGeneration

function flexInsertTarget(pointer: Point, siblings: readonly FlexReorderSibling[], draggedId: string, direction: FlexDirection, wrap: FlexWrap, crossAxisTolerance?: number): FlexInsertTarget | null {
  const row = direction === 'row' || direction === 'row-reverse'
  const reverse = direction.endsWith('-reverse')
  const mainStart = (rect: Rect) => row ? rect.x : rect.y
  const mainSize = (rect: Rect) => row ? rect.width : rect.height
  const crossStart = (rect: Rect) => row ? rect.y : rect.x
  const crossSize = (rect: Rect) => row ? rect.height : rect.width
  const center = (rect: Rect) => mainStart(rect) + mainSize(rect) / 2
  // Keep the dragged child's measured box while reconstructing visual lines. It can be the cross-axis bridge that
  // proves two staggered siblings belong to one contiguous Flex line. Remove it only after the pointer picks a line.
  const entries = siblings.map((sibling, index) => ({ ...sibling, index })).filter(sibling => usable(sibling.rect))
  const insertionEntries = entries.filter(sibling => sibling.id !== draggedId)
  if (!insertionEntries.length) return { index: siblings.length, line: 0, guide: null }

  let lines: (typeof entries)[]
  if (wrap === 'nowrap') lines = [entries]
  else {
    lines = []
    for (const entry of entries) {
      const line = lines[lines.length - 1]
      if (line?.length) {
        const previous = line[line.length - 1]!
        const progressesOnMainAxis = reverse ? center(entry.rect) < center(previous.rect) : center(entry.rect) > center(previous.rect)
        const lineStart = Math.min(...line.map(item => crossStart(item.rect)))
        const lineEnd = Math.max(...line.map(item => crossStart(item.rect) + crossSize(item.rect)))
        const crossOverlap = Math.min(lineEnd, crossStart(entry.rect) + crossSize(entry.rect)) - Math.max(lineStart, crossStart(entry.rect))
        // CSS Flex lines contain a contiguous run of document children. Main-axis progress distinguishes a staggered
        // child on the same visual line from the first child after wrapping; positive cross overlap admits unequal
        // and baseline-offset children without assuming identical heights or widths.
        if (progressesOnMainAxis && crossOverlap > 0) { line.push(entry); continue }
      }
      lines.push([entry])
    }
  }
  // Document order inside and across lines; wrap-reverse only changes where a line sits, which the geometry already shows.
  for (const line of lines) line.sort((left, right) => left.index - right.index)
  lines.sort((left, right) => left[0]!.index - right[0]!.index)

  const pointerMain = row ? pointer.x : pointer.y, pointerCross = row ? pointer.y : pointer.x
  const extentOf = (line: typeof entries) => ({ start: Math.min(...line.map(entry => crossStart(entry.rect))), end: Math.max(...line.map(entry => crossStart(entry.rect) + crossSize(entry.rect))) })
  const distance = (line: typeof entries) => { const extent = extentOf(line); return pointerCross < extent.start ? extent.start - pointerCross : pointerCross > extent.end ? pointerCross - extent.end : 0 }
  let lineIndex = 0
  lines.forEach((line, index) => { if (distance(line) < distance(lines[lineIndex]!)) lineIndex = index })
  const line = lines[lineIndex]!
  if (crossAxisTolerance !== undefined && distance(line) > crossAxisTolerance) return null
  const candidates = line.filter(entry => entry.id !== draggedId)
  if (!candidates.length) {
    const dragged = entries.find(entry => entry.id === draggedId)
    return { index: Math.min((dragged?.index ?? siblings.length - 1) + 1, siblings.length), line: lineIndex, guide: null }
  }

  // Items that come earlier in document order sit before the pointer on the main axis, or after it when reversed.
  const before = candidates.filter(entry => reverse ? center(entry.rect) > pointerMain : center(entry.rect) < pointerMain).length
  const index = before < candidates.length ? candidates[before]!.index : candidates[candidates.length - 1]!.index + 1

  const lower = candidates.filter(entry => center(entry.rect) <= pointerMain).sort((left, right) => center(right.rect) - center(left.rect))[0]
  const upper = candidates.filter(entry => center(entry.rect) > pointerMain).sort((left, right) => center(left.rect) - center(right.rect))[0]
  const lowerEnd = lower ? mainStart(lower.rect) + mainSize(lower.rect) : null
  const upperStart = upper ? mainStart(upper.rect) : null
  const position = lowerEnd !== null && upperStart !== null ? (lowerEnd + upperStart) / 2 : lowerEnd ?? upperStart!
  const extent = extentOf(line)
  return { index, line: lineIndex, guide: { axis: row ? 'x' : 'y', position, start: extent.start, end: extent.end } }
}

/**
 * Authority-fenced Paper reorder result. Callers must handle `stale` before they can access a target, so rectangles
 * measured for an older document revision or layout generation cannot be applied to the current document.
 */
export function measuredFlexInsertIndex<TKind extends string>(input: MeasuredFlexReorderInput<TKind>): MeasuredFlexInsertTarget {
  const actual = { measurementRevision: input.measurement.measurementRevision, documentRevision: input.measurement.documentRevision, layoutGeneration: input.measurement.layoutGeneration }
  if (!sameAuthority(input.expected, actual)) return { status: 'stale', expected: input.expected, actual, target: null }
  const target = flexInsertTarget(input.pointer, input.measurement.siblings, input.draggedId, input.direction, input.wrap, input.crossAxisTolerance)
  if (!target) return { status: 'outside', authority: actual, target: null }
  return {
    status: 'ready',
    authority: actual,
    target,
  }
}

/** Compatibility seam for current gesture callers. New integrations must use `measuredFlexInsertIndex`. */
export function flexInsertIndex(pointer: Point, siblings: readonly FlexReorderSibling[], draggedId: string, direction: FlexDirection, wrap: FlexWrap): FlexInsertTarget {
  return flexInsertTarget(pointer, siblings, draggedId, direction, wrap)!
}
