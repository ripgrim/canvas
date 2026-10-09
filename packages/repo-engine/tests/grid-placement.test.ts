import { describe, expect, it } from 'vitest'
import { isAutoPlacementEquivalent, minimumTracks, placeGridItems, projectGridLine, remapStartAfterTrackMove, repairAfterTrackRemoval } from '../src/grid-placement.js'
import type { GridCell, GridPlacement, GridPlacementInput } from '../src/grid-placement.js'

const cell = (column: number, row: number, columnSpan = 1, rowSpan = 1): GridCell => ({ column, row, columnSpan, rowSpan })
const asObject = (placement: GridPlacement): Record<string, GridCell> => Object.fromEntries(placement)
const rowFlow = (explicitColumns: number) => ({ autoFlow: 'row' as const, explicitColumns })

describe('grid auto-placement', () => {
  it('GRID-ALG-01: row flow fills the first row left to right', () => {
    const items: GridPlacementInput[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(1, 1), B: cell(2, 1), C: cell(3, 1) })
  })

  it('GRID-ALG-02: automatic items flow around an explicit item without backfilling past it', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 2, rowStart: 1 }, { id: 'B' }, { id: 'C' }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(2, 1), B: cell(1, 1), C: cell(3, 1) })
  })

  it('GRID-ALG-03: a spanning automatic item that cannot fit in row 1 drops to row 2', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 2, rowStart: 1, columnSpan: 2 }, { id: 'B', columnSpan: 2 }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(2, 1, 2, 1), B: cell(1, 2, 2, 1) })
  })

  it('GRID-ALG-04: a row-definite item is placed in its row before the automatic cursor starts', () => {
    const items: GridPlacementInput[] = [{ id: 'A', rowStart: 2, columnSpan: 2 }, { id: 'B' }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(1, 2, 2, 1), B: cell(1, 1) })
  })

  it('GRID-ALG-05: column flow fills the first column top to bottom, then the next column', () => {
    const items: GridPlacementInput[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    expect(asObject(placeGridItems(items, { autoFlow: 'column', explicitColumns: 1, explicitRows: 2 }))).toEqual({ A: cell(1, 1), B: cell(1, 2), C: cell(2, 1) })
  })

  it('GRID-ALG-06: explicit collisions are preserved and an automatic item avoids the occupied cell', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 1, rowStart: 1 }, { id: 'B', columnStart: 1, rowStart: 1 }, { id: 'C' }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(1, 1), B: cell(1, 1), C: cell(2, 1) })
  })

  it('GRID-ALG-negative: invalid starts (0, -1, 1.5, 1001) are treated as absent', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 0, rowStart: -1 }, { id: 'B', columnStart: 1.5 }, { id: 'C', rowStart: 1001 }]
    // All three are automatic, so this is the GRID-ALG-01 layout.
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(1, 1), B: cell(2, 1), C: cell(3, 1) })
  })

  it('GRID-ALG-negative: invalid spans (0, 2.5, 1001, -2) become 1', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnSpan: 0 }, { id: 'B', columnSpan: 2.5 }, { id: 'C', columnSpan: 1001, rowSpan: -2 }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(1, 1), B: cell(2, 1), C: cell(3, 1) })
  })

  it('GRID-ALG-negative: a row-definite item scans only columns, landing in the implicit column 4 instead of row 2', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 1, rowStart: 1, columnSpan: 3 }, { id: 'B', rowStart: 1 }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(1, 1, 3, 1), B: cell(4, 1) })
  })

  it('GRID-ALG-negative: the same occupied row sends a fully automatic item to row 2 instead', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 1, rowStart: 1, columnSpan: 3 }, { id: 'B' }]
    expect(asObject(placeGridItems(items, rowFlow(3)))).toEqual({ A: cell(1, 1, 3, 1), B: cell(1, 2) })
  })
})

describe('auto placement equivalence', () => {
  it('GRID-AUTO-01: explicit starts that match automatic placement are equivalent', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 1, rowStart: 1 }, { id: 'B', columnStart: 2, rowStart: 1 }, { id: 'C', columnStart: 3, rowStart: 1 }]
    expect(isAutoPlacementEquivalent(items, rowFlow(3))).toBe(true)
  })

  it('GRID-AUTO-02: the GRID-ALG-02 input is not equivalent (automatic placement would put A at column 1)', () => {
    const items: GridPlacementInput[] = [{ id: 'A', columnStart: 2, rowStart: 1 }, { id: 'B' }, { id: 'C' }]
    expect(isAutoPlacementEquivalent(items, rowFlow(3))).toBe(false)
  })

  it('GRID-AUTO-03: row flow with a row span is never equivalent, even when placement would be identical', () => {
    expect(isAutoPlacementEquivalent([{ id: 'A', columnStart: 1, rowStart: 1, rowSpan: 2 }, { id: 'B', columnStart: 2, rowStart: 1 }], rowFlow(3))).toBe(false)
    // No starts at all: both placements are trivially the same, so only the span guard can produce false.
    expect(isAutoPlacementEquivalent([{ id: 'A', rowSpan: 2 }], rowFlow(3))).toBe(false)
    // Negative control: the same lone item without the row span is equivalent.
    expect(isAutoPlacementEquivalent([{ id: 'A' }], rowFlow(3))).toBe(true)
    // A column span is allowed in row flow.
    expect(isAutoPlacementEquivalent([{ id: 'A', columnSpan: 2 }], rowFlow(3))).toBe(true)
  })

  it('GRID-AUTO-04: column flow with a column span is never equivalent', () => {
    const options = { autoFlow: 'column' as const, explicitColumns: 1, explicitRows: 3 }
    expect(isAutoPlacementEquivalent([{ id: 'A', columnSpan: 2 }], options)).toBe(false)
    // Negative controls: no span, and a row span (allowed in column flow).
    expect(isAutoPlacementEquivalent([{ id: 'A' }], options)).toBe(true)
    expect(isAutoPlacementEquivalent([{ id: 'A', rowSpan: 2 }], options)).toBe(true)
  })
})

describe('grid line projection', () => {
  it('LAY-GRID-002: projectGridLine emits start, span end, span start, or nothing', () => {
    expect(projectGridLine(2, 1)).toEqual({ start: '2', end: null })
    expect(projectGridLine(2, 3)).toEqual({ start: '2', end: 'span 3' })
    expect(projectGridLine(undefined, 2)).toEqual({ start: 'span 2', end: null })
    expect(projectGridLine(undefined, undefined)).toEqual({ start: null, end: null })
  })

  it('LAY-GRID-002 negative: invalid starts and spans are dropped from the projection', () => {
    expect(projectGridLine(0, 2)).toEqual({ start: 'span 2', end: null })
    expect(projectGridLine(1.5, undefined)).toEqual({ start: null, end: null })
    expect(projectGridLine(3, 0)).toEqual({ start: '3', end: null })
  })
})

describe('track removal and move repair', () => {
  it('LAY-GRID-003: removing column 2 of 4 shifts, shrinks, and clamps explicit starts', () => {
    // Remaining tracks after removal: 3.
    expect(repairAfterTrackRemoval({ id: 'A', columnStart: 3, columnSpan: 1 }, 'columns', 2, 3)).toEqual({ columnStart: 2, columnSpan: 1 })
    expect(repairAfterTrackRemoval({ id: 'B', columnStart: 1, columnSpan: 3 }, 'columns', 2, 3)).toEqual({ columnStart: 1, columnSpan: 2 })
    expect(repairAfterTrackRemoval({ id: 'C', columnStart: 2, columnSpan: 1 }, 'columns', 2, 3)).toEqual({ columnStart: 2, columnSpan: 1 })
    expect(repairAfterTrackRemoval({ id: 'D', columnStart: 4 }, 'columns', 2, 3)).toEqual({ columnStart: 3, columnSpan: 1 })
    expect(repairAfterTrackRemoval({ id: 'E', columnSpan: 2 }, 'columns', 2, 3)).toEqual({ columnStart: undefined, columnSpan: 2 })
  })

  it('LAY-GRID-003: removal on the rows axis touches only row fields', () => {
    const repaired = repairAfterTrackRemoval({ id: 'A', columnStart: 4, rowStart: 3, rowSpan: 1 }, 'rows', 1, 2)
    expect(repaired).toEqual({ rowStart: 2, rowSpan: 1 })
    expect(Object.hasOwn(repaired, 'columnStart')).toBe(false)
  })

  it('LAY-GRID-003 negative: an item before the removed track is not moved', () => {
    expect(repairAfterTrackRemoval({ id: 'A', columnStart: 1, columnSpan: 1 }, 'columns', 3, 3)).toEqual({ columnStart: 1, columnSpan: 1 })
  })

  it('LAY-GRID-003: remapStartAfterTrackMove follows the moved track and shifts the ones it passes', () => {
    expect([1, 2, 3, 4].map(start => remapStartAfterTrackMove(start, 1, 3))).toEqual([3, 1, 2, 4])
    expect([1, 2, 3, 4].map(start => remapStartAfterTrackMove(start, 4, 2))).toEqual([1, 3, 4, 2])
    expect(remapStartAfterTrackMove(undefined, 1, 3)).toBeUndefined()
    expect(remapStartAfterTrackMove(0, 1, 3)).toBeUndefined()
  })

  it('LAY-GRID-003: minimumTracks covers the furthest explicit end and the widest automatic span', () => {
    expect(minimumTracks([{ id: 'A', columnStart: 2, columnSpan: 3 }, { id: 'B', columnSpan: 2 }], 'columns')).toBe(4)
    // Negative controls: no items still needs one track; row fields do not affect the columns axis.
    expect(minimumTracks([], 'columns')).toBe(1)
    expect(minimumTracks([{ id: 'A', rowStart: 9, rowSpan: 2 }], 'columns')).toBe(1)
    expect(minimumTracks([{ id: 'A', rowStart: 9, rowSpan: 2 }], 'rows')).toBe(10)
  })
})
