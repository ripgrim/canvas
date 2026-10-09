import { describe, expect, it } from 'vitest'
import { findPlacementOrder } from '../src/grid-placement.js'
import type { GridCell, GridPlacementInput } from '../src/grid-placement.js'

// Order search for auto placement (LAY-GRID-004, LAY-GRID-005 support). Every target below is drawn by hand on a small
// grid; the expected order is the one a person reading the sparse row-major cursor would pick.
const cell = (column: number, row: number, columnSpan = 1, rowSpan = 1): GridCell => ({ column, row, columnSpan, rowSpan })
const target = (entries: Record<string, GridCell>) => new Map(Object.entries(entries))
const rows3 = { autoFlow: 'row' as const, explicitColumns: 3 }

describe('findPlacementOrder', () => {
  it('keeps the current order when it already reproduces the target', () => {
    const items: GridPlacementInput[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(findPlacementOrder(items, target({ a: cell(1, 1), b: cell(2, 1), c: cell(3, 1) }), rows3)).toEqual(['a', 'b', 'c'])
  })

  it('reorders auto items so b fills column 1 before a fills column 2', () => {
    const items: GridPlacementInput[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(findPlacementOrder(items, target({ a: cell(2, 1), b: cell(1, 1), c: cell(3, 1) }), rows3)).toEqual(['b', 'a', 'c'])
    // The sorted candidate alone finds it; no permutation search is needed.
    expect(findPlacementOrder(items, target({ a: cell(2, 1), b: cell(1, 1), c: cell(3, 1) }), rows3, 0)).toEqual(['b', 'a', 'c'])
  })

  it('leaves a fully explicit item in its list position and only moves the others', () => {
    const items: GridPlacementInput[] = [{ id: 'x', columnStart: 3, rowStart: 2 }, { id: 'a' }, { id: 'b' }]
    expect(findPlacementOrder(items, target({ x: cell(3, 2), a: cell(2, 1), b: cell(1, 1) }), rows3)).toEqual(['x', 'b', 'a'])
  })

  it('places a narrow item before a two-column item when the target puts it first', () => {
    const items: GridPlacementInput[] = [{ id: 'a', columnSpan: 2 }, { id: 'b' }]
    expect(findPlacementOrder(items, target({ b: cell(1, 1), a: cell(2, 1, 2, 1) }), rows3)).toEqual(['b', 'a'])
  })

  it('column flow fills a column top to bottom: b above a in column 1, c in column 2', () => {
    const items: GridPlacementInput[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(findPlacementOrder(items, target({ a: cell(1, 2), b: cell(1, 1), c: cell(2, 1) }), { autoFlow: 'column', explicitColumns: 1, explicitRows: 2 })).toEqual(['b', 'a', 'c'])
  })

  it('row-definite items scan their own row in source order', () => {
    const items: GridPlacementInput[] = [{ id: 'c', rowStart: 2 }, { id: 'd', rowStart: 2 }]
    expect(findPlacementOrder(items, target({ d: cell(1, 2), c: cell(2, 2) }), rows3)).toEqual(['d', 'c'])
  })

  it('returns null for a hole, a collision, or more items than cells in a sparse sequence', () => {
    // Sparse auto placement never leaves column 2 empty before column 3 in the same row.
    expect(findPlacementOrder([{ id: 'a' }, { id: 'b' }], target({ a: cell(3, 1), b: cell(1, 1) }), rows3)).toBeNull()
    // Two auto items never share a cell.
    expect(findPlacementOrder([{ id: 'a' }, { id: 'b' }], target({ a: cell(1, 1), b: cell(1, 1) }), rows3)).toBeNull()
    // Eight items with an unreachable target: the exhaustive search terminates and reports nothing.
    const eight: GridPlacementInput[] = Array.from({ length: 8 }, (_, index) => ({ id: `n${index}` }))
    const unreachable = target(Object.fromEntries(eight.map((item, index) => [item.id, cell(index === 0 ? 3 : 1, index + 1)])))
    expect(findPlacementOrder(eight, unreachable, rows3)).toBeNull()
  })
})
