import { describe, expect, it } from 'vitest'
import { gridCellAt, gridOverlay } from './grid-overlay'
import type { MeasuredGrid } from './layout-grid-commands'

// LAY-GRID-007 (overlay geometry) and LAY-GEST-005 (Grid cell and gutter hit targets). Every expected number is drawn
// by hand: a container at (100, 50) with 12 px padding, columns 200 and 100 with an 8 px gap, rows 40 and 60 with a
// 10 px gap. Column lines: 100 + 12 = 112, 112 + 200 = 312, 312 + 8 = 320, 320 + 100 = 420. Row lines: 50 + 12 = 62,
// 102, 112, 172. The container is 12 + 308 + 12 = 332 wide and 12 + 110 + 12 = 134 tall, so nothing is left over.
const padding = { top: 12, right: 12, bottom: 12, left: 12 }
const measured = (container: MeasuredGrid['container'], extra: Partial<MeasuredGrid> = {}, columns = [200, 100], rows = [40, 60]): MeasuredGrid => ({ container, grid: { columns, rows, columnGap: 8, rowGap: 10, padding }, children: {}, ...extra })
const packed = measured({ x: 100, y: 50, width: 332, height: 134 })
const spans = (pairs: [number, number][]) => pairs.map(([start, end]) => ({ start, end }))

describe('gridOverlay: start-packed tracks', () => {
  it('lines, cells and gutters come from padding, tracks and gaps', () => {
    const overlay = gridOverlay(packed)
    expect(overlay.content).toEqual({ x: 112, y: 62, width: 308, height: 110 })
    expect(overlay.columnLines).toEqual([112, 312, 320, 420])
    expect(overlay.rowLines).toEqual([62, 102, 112, 172])
    // Cell (column 2, row 1) is x 320..420, y 62..102.
    expect(overlay.cells[0]![1]).toEqual({ x: 320, y: 62, width: 100, height: 40 })
    expect(overlay.cells[1]![0]).toEqual({ x: 112, y: 112, width: 200, height: 60 })
    expect(overlay.gutters).toEqual([
      { axis: 'columns', index: 1, rect: { x: 312, y: 62, width: 8, height: 110 } },
      { axis: 'rows', index: 1, rect: { x: 112, y: 102, width: 308, height: 10 } },
    ])
    expect(overlay.freeSpace).toEqual({ columns: 0, rows: 0 })
    expect(overlay.positions).toBe('measured')
  })

  it('a 1 px border moves every line by 1', () => {
    const overlay = gridOverlay(measured({ x: 100, y: 50, width: 334, height: 136 }, { border: { top: 1, right: 1, bottom: 1, left: 1 } }))
    expect(overlay.columnLines).toEqual([113, 313, 321, 421])
    expect(overlay.rowLines).toEqual([63, 103, 113, 173])
  })

  it('zero gaps produce no gutters', () => {
    const overlay = gridOverlay({ ...packed, grid: { ...packed.grid, columnGap: 0, rowGap: 0 } })
    expect(overlay.gutters).toEqual([])
    expect(overlay.columnLines).toEqual([112, 312, 312, 412])
    // Cells are half-open: a shared line belongs to the following track.
    expect(gridCellAt({ ...packed, grid: { ...packed.grid, columnGap: 0, rowGap: 0 } }, { x: 312, y: 80 })).toEqual({ column: 2, row: 1 })
  })
})

describe('gridOverlay: content distribution (modelled offsets)', () => {
  // Container 500 wide: content 500 - 24 = 476, tracks and gap 308, free 168.
  const wide = (justifyContent: NonNullable<MeasuredGrid['distribution']>['justifyContent'], columns?: number[]) => gridOverlay(measured({ x: 100, y: 50, width: 500, height: 134 }, { distribution: { justifyContent } }, columns))
  it('each distribution places the columns where a hand layout puts them', () => {
    // space-between: the whole 168 goes into the one gap; column 2 ends at the content edge 588.
    expect(wide('space-between').columns).toEqual(spans([[112, 312], [488, 588]]))
    // center: offset 84.
    expect(wide('center').columns).toEqual(spans([[196, 396], [404, 504]]))
    // end: offset 168.
    expect(wide('end').columns).toEqual(spans([[280, 480], [488, 588]]))
    // space-around: 84 per track, 42 at each edge.
    expect(wide('space-around').columns).toEqual(spans([[154, 354], [446, 546]]))
    // space-evenly: 168 / 3 = 56 at each of three places.
    expect(wide('space-evenly').columns).toEqual(spans([[168, 368], [432, 532]]))
    expect(wide('space-between').positions).toBe('modelled')
    expect(wide('space-between').gutters[0]).toEqual({ axis: 'columns', index: 1, rect: { x: 312, y: 62, width: 176, height: 110 } })
  })

  it('start-like values and fallbacks keep the packed positions', () => {
    for (const mode of [undefined, 'start', 'stretch'] as const) {
      expect(wide(mode).columns).toEqual(spans([[112, 312], [320, 420]]))
      expect(wide(mode).positions).toBe('measured')
    }
    // One track: space-between has no gap to grow and falls back to start.
    expect(wide('space-between', [200]).columns).toEqual(spans([[112, 312]]))
    // Tracks 300 + 8 + 300 overflow the 476 content box by 132: space-around falls back to start, center goes negative.
    expect(wide('space-around', [300, 300]).columns).toEqual(spans([[112, 412], [420, 720]]))
    expect(wide('center', [300, 300]).columns).toEqual(spans([[46, 346], [354, 654]]))
  })

  it('align-content distributes rows the same way', () => {
    // Container 234 tall: content 210, rows and gap 110, free 100, all into the one gap.
    const overlay = gridOverlay(measured({ x: 100, y: 50, width: 332, height: 234 }, { distribution: { alignContent: 'space-between' } }))
    expect(overlay.rows).toEqual(spans([[62, 102], [212, 272]]))
    expect(overlay.freeSpace).toEqual({ columns: 0, rows: 100 })
  })
})

describe('LAY-GEST-005: gridCellAt', () => {
  it('maps points to cells, gap points to the gutter, and outside points to nothing', () => {
    expect(gridCellAt(packed, { x: 150, y: 80 })).toEqual({ column: 1, row: 1 })
    expect(gridCellAt(packed, { x: 419.5, y: 171 })).toEqual({ column: 2, row: 2 })
    expect(gridCellAt(packed, { x: 420, y: 172 })).toEqual({ column: 2, row: 2 })
    expect(gridCellAt(packed, { x: 320, y: 62 })).toEqual({ column: 2, row: 1 })
    expect(gridCellAt(packed, { x: 315, y: 80 })).toEqual({ axis: 'columns', index: 1 })
    expect(gridCellAt(packed, { x: 200, y: 105 })).toEqual({ axis: 'rows', index: 1 })
    // Where the two gaps cross, the column gutter wins.
    expect(gridCellAt(packed, { x: 315, y: 105 })).toEqual({ axis: 'columns', index: 1 })
    // Padding and beyond the last line.
    expect(gridCellAt(packed, { x: 105, y: 80 })).toBeNull()
    expect(gridCellAt(packed, { x: 421, y: 80 })).toBeNull()
    expect(gridCellAt(packed, { x: 150, y: 173 })).toBeNull()
  })

  it('a distributed gap is a gutter and the shifted column is hit where it really is', () => {
    const between = measured({ x: 100, y: 50, width: 500, height: 134 }, { distribution: { justifyContent: 'space-between' } })
    expect(gridCellAt(between, { x: 400, y: 80 })).toEqual({ axis: 'columns', index: 1 })
    expect(gridCellAt(between, { x: 500, y: 80 })).toEqual({ column: 2, row: 1 })
    // Negative control: without the distribution the same point lies past the last packed line.
    expect(gridCellAt({ ...between, distribution: {} }, { x: 500, y: 80 })).toBeNull()
  })
})
