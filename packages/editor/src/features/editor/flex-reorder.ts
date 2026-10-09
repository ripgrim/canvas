/**
 * Drop index for a flow child dragged inside a Flex parent. Siblings group into visual lines by cross-axis overlap, the
 * pointer picks the nearest line, and the main-axis position inside that line honours reversed directions. Siblings
 * without a usable rectangle stay in document order but take no part in the geometry.
 */
import type { FlexDirection, FlexWrap } from '@canvas/repo-engine/layout'
import type { Point, Rect } from './canvas-math'

export type FlexInsertGuide = { axis: 'x' | 'y'; position: number; start: number; end: number }
/**
 * `index` is a gap position among all siblings in document order, the dragged node included (0 is before the first,
 * `siblings.length` after the last), which is what `commands.reorderFlow` expects. `line` counts lines in document
 * order. `guide` is the insertion marker: a line across the main axis at `position`, spanning the line's cross extent.
 */
export type FlexInsertTarget = { index: number; line: number; guide: FlexInsertGuide | null }

const usable = (rect: Rect | undefined): rect is Rect => Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)

export function flexInsertIndex(pointer: Point, siblings: readonly { id: string; rect: Rect }[], draggedId: string, direction: FlexDirection, wrap: FlexWrap): FlexInsertTarget {
  const row = direction === 'row' || direction === 'row-reverse'
  const reverse = direction.endsWith('-reverse')
  const mainStart = (rect: Rect) => row ? rect.x : rect.y
  const mainSize = (rect: Rect) => row ? rect.width : rect.height
  const crossStart = (rect: Rect) => row ? rect.y : rect.x
  const crossSize = (rect: Rect) => row ? rect.height : rect.width
  const center = (rect: Rect) => mainStart(rect) + mainSize(rect) / 2
  const entries = siblings.map((sibling, index) => ({ ...sibling, index })).filter(sibling => sibling.id !== draggedId && usable(sibling.rect))
  if (!entries.length) return { index: siblings.length, line: 0, guide: null }

  let lines: (typeof entries)[]
  if (wrap === 'nowrap') lines = [entries]
  else {
    lines = []
    const byCross = [...entries].sort((left, right) => crossStart(left.rect) - crossStart(right.rect) || mainStart(left.rect) - mainStart(right.rect))
    for (const entry of byCross) {
      const head = lines[lines.length - 1]?.[0]
      if (head) {
        const overlap = Math.min(crossStart(head.rect) + crossSize(head.rect), crossStart(entry.rect) + crossSize(entry.rect)) - Math.max(crossStart(head.rect), crossStart(entry.rect))
        if (overlap >= 0.5 * Math.min(crossSize(head.rect), crossSize(entry.rect))) { lines[lines.length - 1]!.push(entry); continue }
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

  // Items that come earlier in document order sit before the pointer on the main axis, or after it when reversed.
  const before = line.filter(entry => reverse ? center(entry.rect) > pointerMain : center(entry.rect) < pointerMain).length
  const index = before < line.length ? line[before]!.index : line[line.length - 1]!.index + 1

  const lower = line.filter(entry => center(entry.rect) <= pointerMain).sort((left, right) => center(right.rect) - center(left.rect))[0]
  const upper = line.filter(entry => center(entry.rect) > pointerMain).sort((left, right) => center(left.rect) - center(right.rect))[0]
  const lowerEnd = lower ? mainStart(lower.rect) + mainSize(lower.rect) : null
  const upperStart = upper ? mainStart(upper.rect) : null
  const position = lowerEnd !== null && upperStart !== null ? (lowerEnd + upperStart) / 2 : lowerEnd ?? upperStart!
  const extent = extentOf(line)
  return { index, line: lineIndex, guide: { axis: row ? 'x' : 'y', position, start: extent.start, end: extent.end } }
}
