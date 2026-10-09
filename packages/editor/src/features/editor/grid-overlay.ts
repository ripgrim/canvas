/**
 * Grid overlay geometry for the HUD and drag hit testing, derived only from what the preview measured: the container's
 * world rectangle, its border, and the resolved Grid tracks, gaps and padding. Nothing here reads the DOM.
 *
 * Track positions: the measurement carries resolved track sizes but not track offsets (computed style has no such
 * property). With `justify-content`/`align-content` at start, normal or stretch the offsets follow exactly from padding,
 * tracks and gaps (`positions: 'measured'`). With end, center or a space distribution the offsets are modelled from
 * the content box free space and the authored distribution (`positions: 'modelled'`), using the CSS Box Alignment
 * rules: space-between falls back to start with one track or no free space, space-around and space-evenly fall back
 * to start when the tracks overflow (safe center), center and end may go negative (unsafe, as browsers do). A
 * distribution set only by the component stylesheet is invisible to this model; the runtime would need to report
 * computed `justify-content`/`align-content` or track offsets for that case. Container transforms are ignored, so the
 * overlay assumes an axis-aligned container.
 */
import type { ContentDistribution } from '@canvas/repo-engine/layout'
import type { Point, Rect } from './canvas-math'
import type { GridAxis, MeasuredGrid } from './layout-grid-commands'

export type GridTrackSpan = { start: number; end: number }
/** Gutter `index` i lies between track i and track i + 1 (both one-based). */
export type GridGutter = { axis: GridAxis; index: number; rect: Rect }
export type GridOverlay = {
  /** Content box of the container in world coordinates. */
  content: Rect
  columns: GridTrackSpan[]
  rows: GridTrackSpan[]
  /** Both edges of every column track, in order: world x. */
  columnLines: number[]
  /** Both edges of every row track, in order: world y. */
  rowLines: number[]
  /** Cell rectangles indexed `[row - 1][column - 1]`. */
  cells: Rect[][]
  gutters: GridGutter[]
  /** Free space on each axis after tracks and gaps (negative when the tracks overflow the content box). */
  freeSpace: { columns: number; rows: number }
  positions: 'measured' | 'modelled'
}
export type GridHit = { column: number; row: number } | { axis: GridAxis; index: number }

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

function distribute(origin: number, size: number, tracks: readonly number[], gap: number, mode: ContentDistribution | undefined): { spans: GridTrackSpan[]; free: number; modelled: boolean } {
  const count = tracks.length
  const free = size - sum(tracks) - gap * Math.max(0, count - 1)
  let offset = 0, extra = 0
  switch (mode) {
    case 'end': offset = free; break
    case 'center': offset = free / 2; break
    case 'space-between': if (free > 0 && count > 1) extra = free / (count - 1); break
    case 'space-around': if (free > 0 && count > 0) { extra = free / count; offset = extra / 2 } break
    case 'space-evenly': if (free > 0) { extra = free / (count + 1); offset = extra } break
    default: break
  }
  const spans: GridTrackSpan[] = []
  let cursor = origin + offset
  for (const track of tracks) { spans.push({ start: cursor, end: cursor + track }); cursor += track + gap + extra }
  return { spans, free, modelled: offset !== 0 || extra !== 0 }
}

export function gridOverlay(measured: MeasuredGrid): GridOverlay {
  const { container, grid } = measured
  const border = measured.border ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const content: Rect = {
    x: container.x + border.left + grid.padding.left,
    y: container.y + border.top + grid.padding.top,
    width: container.width - border.left - border.right - grid.padding.left - grid.padding.right,
    height: container.height - border.top - border.bottom - grid.padding.top - grid.padding.bottom,
  }
  const columns = distribute(content.x, content.width, grid.columns, grid.columnGap, measured.distribution?.justifyContent)
  const rows = distribute(content.y, content.height, grid.rows, grid.rowGap, measured.distribution?.alignContent)
  const cells = rows.spans.map(row => columns.spans.map(column => ({ x: column.start, y: row.start, width: column.end - column.start, height: row.end - row.start })))
  const top = rows.spans[0]?.start ?? content.y, bottom = rows.spans.at(-1)?.end ?? content.y + content.height
  const left = columns.spans[0]?.start ?? content.x, right = columns.spans.at(-1)?.end ?? content.x + content.width
  const gutters: GridGutter[] = []
  columns.spans.slice(1).forEach((span, index) => { const start = columns.spans[index]!.end; if (span.start > start) gutters.push({ axis: 'columns', index: index + 1, rect: { x: start, y: top, width: span.start - start, height: bottom - top } }) })
  rows.spans.slice(1).forEach((span, index) => { const start = rows.spans[index]!.end; if (span.start > start) gutters.push({ axis: 'rows', index: index + 1, rect: { x: left, y: start, width: right - left, height: span.start - start } }) })
  return {
    content,
    columns: columns.spans, rows: rows.spans,
    columnLines: columns.spans.flatMap(span => [span.start, span.end]),
    rowLines: rows.spans.flatMap(span => [span.start, span.end]),
    cells, gutters,
    freeSpace: { columns: columns.free, rows: rows.free },
    positions: columns.modelled || rows.modelled ? 'modelled' : 'measured',
  }
}

type Location = { kind: 'track'; index: number } | { kind: 'gap'; index: number } | { kind: 'outside' }
function locate(spans: readonly GridTrackSpan[], value: number): Location {
  const last = spans.length - 1
  if (last < 0 || value < spans[0]!.start || value > spans[last]!.end) return { kind: 'outside' }
  for (let index = 0; index <= last; index++) {
    const span = spans[index]!
    if (value < span.end || index === last) return value >= span.start ? { kind: 'track', index: index + 1 } : { kind: 'gap', index }
  }
  return { kind: 'outside' }
}

/**
 * The cell under a point, or the gutter when the point lies in a gap (a column gap wins where a column gap and a row
 * gap cross). Null outside the tracks: padding, border and anything beyond the first and last line.
 */
export function overlayHit(overlay: GridOverlay, point: Point): GridHit | null {
  const column = locate(overlay.columns, point.x), row = locate(overlay.rows, point.y)
  if (column.kind === 'outside' || row.kind === 'outside') return null
  if (column.kind === 'gap') return { axis: 'columns', index: column.index }
  if (row.kind === 'gap') return { axis: 'rows', index: row.index }
  return { column: column.index, row: row.index }
}
export const gridCellAt = (measured: MeasuredGrid, point: Point): GridHit | null => overlayHit(gridOverlay(measured), point)
