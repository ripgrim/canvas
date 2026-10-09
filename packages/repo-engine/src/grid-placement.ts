/**
 * Sparse CSS Grid auto-placement for the editor's own occupancy model: explicit items keep their cells (collisions
 * included), row-definite items scan only columns, automatic items advance a cursor in source order, and nothing
 * backfills earlier holes. Column flow transposes the inputs, runs the row algorithm, and transposes back.
 */
export type GridFlow = 'row' | 'column'
export type GridPlacementInput = { id: string; columnStart?: number | undefined; rowStart?: number | undefined; columnSpan?: number | undefined; rowSpan?: number | undefined }
export type GridCell = { column: number; row: number; columnSpan: number; rowSpan: number }
export type GridPlacement = Map<string, GridCell>
const limit = 1000

const start = (value: number | undefined): number | undefined => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= limit ? value : undefined
const span = (value: number | undefined): number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= limit ? (value as number) : 1

type Rect = { column: number; row: number; columnSpan: number; rowSpan: number }
const overlaps = (left: Rect, right: Rect) => left.column < right.column + right.columnSpan && right.column < left.column + left.columnSpan && left.row < right.row + right.rowSpan && right.row < left.row + left.rowSpan

const transposeItem = (item: GridPlacementInput): GridPlacementInput => ({ id: item.id, columnStart: item.rowStart, rowStart: item.columnStart, columnSpan: item.rowSpan, rowSpan: item.columnSpan })
const transposeCell = (cell: GridCell): GridCell => ({ column: cell.row, row: cell.column, columnSpan: cell.rowSpan, rowSpan: cell.columnSpan })

function placeRowFlow(items: readonly GridPlacementInput[], explicitColumns: number): GridPlacement {
  const placed: GridPlacement = new Map()
  const normalized = items.map(item => ({ id: item.id, columnStart: start(item.columnStart), rowStart: start(item.rowStart), columnSpan: span(item.columnSpan), rowSpan: span(item.rowSpan) }))
  let implicitColumns = Math.max(1, explicitColumns)
  // Pass 1: fully explicit items keep their cells, collisions and all.
  for (const item of normalized) if (item.columnStart !== undefined && item.rowStart !== undefined) placed.set(item.id, { column: item.columnStart, row: item.rowStart, columnSpan: item.columnSpan, rowSpan: item.rowSpan })
  for (const item of normalized) if (item.columnStart !== undefined) implicitColumns = Math.max(implicitColumns, item.columnStart + item.columnSpan - 1)
  // Pass 2: row-definite items scan right within their row from that row's cursor.
  const rowCursors = new Map<number, number>()
  for (const item of normalized) {
    if (item.rowStart === undefined || item.columnStart !== undefined) continue
    let column = rowCursors.get(item.rowStart) ?? 1
    for (;;) {
      const candidate = { column, row: item.rowStart, columnSpan: item.columnSpan, rowSpan: item.rowSpan }
      if (![...placed.values()].some(cell => overlaps(cell, candidate))) { placed.set(item.id, candidate); rowCursors.set(item.rowStart, column + item.columnSpan); implicitColumns = Math.max(implicitColumns, column + item.columnSpan - 1); break }
      column += 1
      if (column > limit) break
    }
  }
  // Pass 3: automatic items advance one cursor in source order; explicit columns can only move it forward or down.
  let cursor = { column: 1, row: 1 }
  for (const item of normalized) {
    if (item.rowStart !== undefined) continue
    if (item.columnStart !== undefined) {
      if (item.columnStart < cursor.column) cursor = { column: item.columnStart, row: cursor.row + 1 }
      else cursor = { ...cursor, column: item.columnStart }
    }
    const maxStart = implicitColumns - item.columnSpan + 1
    for (let guard = 0; guard < limit * limit; guard++) {
      const candidate = { column: cursor.column, row: cursor.row, columnSpan: item.columnSpan, rowSpan: item.rowSpan }
      const blocked = [...placed.values()].some(cell => overlaps(cell, candidate))
      if (!blocked && cursor.column <= maxStart) { placed.set(item.id, candidate); cursor = { column: cursor.column + item.columnSpan, row: cursor.row }; break }
      if (item.columnStart !== undefined) { cursor = { column: item.columnStart, row: cursor.row + 1 }; continue }
      if (blocked && cursor.column + 1 <= maxStart) { cursor = { column: cursor.column + 1, row: cursor.row }; continue }
      cursor = { column: 1, row: cursor.row + 1 }
    }
  }
  return placed
}

/** Places every item; `explicitCount` is the number of explicit tracks on the flow's cross axis (columns for row flow, rows for column flow). */
export function placeGridItems(items: readonly GridPlacementInput[], options: { autoFlow: GridFlow; explicitColumns: number; explicitRows?: number }): GridPlacement {
  if (options.autoFlow === 'column') {
    const transposed = placeRowFlow(items.map(transposeItem), Math.max(1, options.explicitRows ?? 1))
    return new Map([...transposed].map(([id, cell]) => [id, transposeCell(cell)]))
  }
  return placeRowFlow(items, options.explicitColumns)
}

/** True when clearing every explicit start reproduces the same occupancy. Spans on the flow axis never qualify. */
export function isAutoPlacementEquivalent(items: readonly GridPlacementInput[], options: { autoFlow: GridFlow; explicitColumns: number; explicitRows?: number }): boolean {
  if (items.some(item => options.autoFlow === 'row' ? span(item.rowSpan) > 1 : span(item.columnSpan) > 1)) return false
  const actual = placeGridItems(items, options)
  const automatic = placeGridItems(items.map(item => ({ id: item.id, columnSpan: item.columnSpan, rowSpan: item.rowSpan })), options)
  return items.every(item => { const left = actual.get(item.id), right = automatic.get(item.id); return Boolean(left && right) && left!.column === right!.column && left!.row === right!.row && left!.columnSpan === right!.columnSpan && left!.rowSpan === right!.rowSpan })
}

/** `grid-column` / `grid-row` longhands for one item, exactly as authored intent requires. */
export function projectGridLine(startValue: number | undefined, spanValue: number | undefined): { start: string | null; end: string | null } {
  const s = start(startValue), n = span(spanValue)
  if (s !== undefined) return { start: String(s), end: n > 1 ? `span ${n}` : null }
  return { start: n > 1 ? `span ${n}` : null, end: null }
}

export type TrackRepair = { columnStart?: number | undefined; rowStart?: number | undefined; columnSpan?: number | undefined; rowSpan?: number | undefined }
/**
 * Repairs item placement after removing track `index` (one-based) on an axis: starts after it shift up, starts on it
 * stay (clamped to the remaining tracks), and spans crossing the removed line shrink by one (never below 1).
 */
export function repairAfterTrackRemoval(item: GridPlacementInput, axis: 'columns' | 'rows', index: number, remainingTracks: number): TrackRepair {
  const key = axis === 'columns' ? 'columnStart' : 'rowStart'
  const spanKey = axis === 'columns' ? 'columnSpan' : 'rowSpan'
  const s = start(item[key]); const n = span(item[spanKey])
  if (s === undefined) return { [key]: undefined, [spanKey]: n }
  if (s > index) return { [key]: Math.max(1, Math.min(remainingTracks, s - 1)), [spanKey]: n }
  const crosses = s <= index && s + n - 1 >= index
  const nextSpan = crosses ? Math.max(1, n - 1) : n
  return { [key]: Math.max(1, Math.min(Math.max(1, remainingTracks - nextSpan + 1), s)), [spanKey]: nextSpan }
}

/** Remaps an explicit start after moving track `from` to position `to` (both one-based). */
export function remapStartAfterTrackMove(startValue: number | undefined, from: number, to: number): number | undefined {
  const s = start(startValue)
  if (s === undefined) return undefined
  if (s === from) return to
  if (from < to && s > from && s <= to) return s - 1
  if (to < from && s >= to && s < from) return s + 1
  return s
}

export type GridPlacementOptions = { autoFlow: GridFlow; explicitColumns: number; explicitRows?: number }
const sameCell = (left: GridCell | undefined, right: GridCell) => Boolean(left) && left!.column === right.column && left!.row === right.row && left!.columnSpan === right.columnSpan && left!.rowSpan === right.rowSpan
const reproduces = (items: readonly GridPlacementInput[], target: ReadonlyMap<string, GridCell>, options: GridPlacementOptions) => {
  const placed = placeGridItems(items, options)
  return [...target].every(([id, cell]) => sameCell(placed.get(id), cell))
}

/**
 * A source order of `items` whose placement puts every id of `target` on exactly its target cell, or null when none
 * does. Items with both starts are placed independently of order, so they keep their positions in the list; only the
 * others move. Tried in turn: the current order (no reorder needed), the others sorted by target position along the
 * flow (sparse placement only moves forward, so this is the order that can succeed), and, for at most `maxPermuted`
 * movable items, every permutation as a guard against cases the sorted order misses.
 */
export function findPlacementOrder(items: readonly GridPlacementInput[], target: ReadonlyMap<string, GridCell>, options: GridPlacementOptions, maxPermuted = 8): string[] | null {
  const movableSlots: number[] = []
  items.forEach((item, index) => { if (start(item.columnStart) === undefined || start(item.rowStart) === undefined) movableSlots.push(index) })
  const movable = movableSlots.map(index => items[index]!)
  const arrange = (ordered: readonly GridPlacementInput[]) => { const next = [...items]; movableSlots.forEach((slot, index) => { next[slot] = ordered[index]! }); return next }
  const ids = (list: readonly GridPlacementInput[]) => list.map(item => item.id)
  if (reproduces(items, target, options)) return ids(items)
  const flowKey = (item: GridPlacementInput): [number, number] => {
    const cell = target.get(item.id)
    if (!cell) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
    return options.autoFlow === 'row' ? [cell.row, cell.column] : [cell.column, cell.row]
  }
  const sorted = [...movable].sort((left, right) => { const a = flowKey(left), b = flowKey(right); return a[0] - b[0] || a[1] - b[1] })
  const greedy = arrange(sorted)
  if (reproduces(greedy, target, options)) return ids(greedy)
  if (movable.length > maxPermuted) return null
  const used = new Array<boolean>(movable.length).fill(false)
  const chosen: GridPlacementInput[] = []
  const search = (): GridPlacementInput[] | null => {
    if (chosen.length === movable.length) { const candidate = arrange(chosen); return reproduces(candidate, target, options) ? candidate : null }
    for (let index = 0; index < movable.length; index++) {
      if (used[index]) continue
      used[index] = true; chosen.push(movable[index]!)
      const found = search()
      used[index] = false; chosen.pop()
      if (found) return found
    }
    return null
  }
  const found = search()
  return found ? ids(found) : null
}

/** The minimum track count an axis needs to keep every placed item inside the explicit grid. */
export function minimumTracks(items: readonly GridPlacementInput[], axis: 'columns' | 'rows'): number {
  let required = 1
  for (const item of items) {
    const s = start(axis === 'columns' ? item.columnStart : item.rowStart)
    const n = span(axis === 'columns' ? item.columnSpan : item.rowSpan)
    required = Math.max(required, s === undefined ? n : s + n - 1)
  }
  return required
}
