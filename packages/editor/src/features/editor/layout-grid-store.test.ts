import { describe, expect, it } from 'vitest'
import { childrenOf } from '@canvas/repo-engine/file-document'
import type { ComponentNode, FileDocument } from '@canvas/repo-engine/file-document'
import { layoutDeclarations } from '@canvas/repo-engine/file-preview'
import type { GridContainer, GridItem, NodeLayout } from '@canvas/repo-engine/layout'
import type { Atom } from './types'
import { createDocumentStore } from './document-store'
import type { MeasuredGrid } from './layout-grid-commands'

// Grid commands on the document store (LAY-GRID-003..006, LAY-GEST-005 drop target). Each fixture is a Card Grid with
// Label children in its `children` slot; every expected record, order and occupancy is drawn by hand on the grid.
const atom = (name: string, componentId: string): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] })
const atoms: Atom[] = [atom('Card', 'card-component'), atom('Label', 'label-component')]
const px = (value: number) => ({ kind: 'px' as const, value })
const fr = (value = 1) => ({ kind: 'fr' as const, value })
const auto = { kind: 'auto' as const }
const flow = { mode: 'flow' as const }
const gridLayout = (grid: GridContainer): NodeLayout => ({ item: { position: flow }, container: { display: 'grid', gap: 8, grid } })
const itemLayout = (grid: GridItem): NodeLayout => ({ item: { position: flow, grid } })
const keys = ['P', 'Q', 'R', 'S', 'T', 'U']

/** `card` is a Grid with the given children (null: no layout record); `other` is a Flex card with no children. */
function fixture(grid: GridContainer, items: [string, GridItem | null][]): FileDocument {
  const nodes: FileDocument['nodes'] = {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {}, layout: gridLayout(grid) },
    other: { id: 'other', type: 'component', componentId: 'card-component', exportName: 'Card', props: {}, layout: { item: { position: flow }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
  }
  const relationships: FileDocument['relationships'] = { card: { parentId: 'root-1', orderKey: 'V' }, other: { parentId: 'root-1', orderKey: 'W' } }
  items.forEach(([id, item], index) => {
    nodes[id] = { id, type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: id.toUpperCase() }, ...(item ? { layout: itemLayout(item) } : {}) }
    relationships[id] = { parentId: 'card', orderKey: keys[index]!, slot: 'children' }
  })
  return { schemaVersion: 5, fileId: 'file-1', revision: 0, pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }], nodes, relationships, theme: { tokens: {} } }
}
type Store = ReturnType<typeof createDocumentStore>
const load = (file: FileDocument) => { const store = createDocumentStore(() => 'unused'); store.load(file, atoms); return store }
const file = (store: Store) => store.getSnapshot().file!
const layoutOf = (store: Store, id: string) => (file(store).nodes[id] as ComponentNode).layout
const gridItem = (store: Store, id: string) => layoutOf(store, id)?.item.grid
const tracks = (store: Store) => layoutOf(store, 'card')!.container!.grid!
const order = (store: Store) => childrenOf(file(store), 'card')
const revision = (store: Store) => file(store).revision
const area = (column: number, row: number, columnSpan = 1, rowSpan = 1) => ({ column, row, columnSpan, rowSpan })
const grid3 = (rows: GridContainer['rows'] = [auto]): GridContainer => ({ columns: [fr(), fr(), fr()], rows, autoFlow: 'row' })

describe('LAY-GRID-003: track removal repairs children atomically', () => {
  const removal = () => load(fixture({ columns: [px(100), px(200), fr(1), fr(2)], rows: [auto], autoFlow: 'row' }, [
    ['a', { columnStart: 3 }],
    ['b', { columnStart: 2, columnSpan: 2 }],
    ['c', { columnStart: 1, columnSpan: 3 }],
    ['d', { rowStart: 2 }],
    ['e', null],
  ]))

  it('removing column 2 shifts later starts, shrinks crossing spans, and one undo restores everything', () => {
    const store = removal()
    // a ends at 3, b at 2 + 2 - 1 = 3, c at 1 + 3 - 1 = 3.
    expect(store.commands.layout.grid.minimumTracks('card', 'columns')).toBe(3)
    expect(store.commands.layout.grid.removeTrack('columns', 2, ['card', 'other'])).toBe(true)
    expect(revision(store)).toBe(1)
    expect(tracks(store).columns).toEqual([px(100), fr(1), fr(2)])
    // a: start 3 sat after the removed track, so it moves to 2.
    expect(gridItem(store, 'a')).toEqual({ columnStart: 2 })
    // b: columns 2..3 lose column 2, leaving old column 3, now column 2, as a single track.
    expect(gridItem(store, 'b')).toEqual({ columnStart: 2 })
    // c: columns 1..3 lose one track.
    expect(gridItem(store, 'c')).toEqual({ columnStart: 1, columnSpan: 2 })
    expect(gridItem(store, 'd')).toEqual({ rowStart: 2 })
    expect(layoutOf(store, 'e')).toBeUndefined()
    expect(store.commands.layout.grid.minimumTracks('card', 'columns')).toBe(2)
    store.undo()
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(tracks(store).columns).toEqual([px(100), px(200), fr(1), fr(2)])
    expect(gridItem(store, 'a')).toEqual({ columnStart: 3 })
    expect(gridItem(store, 'b')).toEqual({ columnStart: 2, columnSpan: 2 })
    expect(gridItem(store, 'c')).toEqual({ columnStart: 1, columnSpan: 3 })
  })

  it('is refused below the minimum the children need, and below one track', () => {
    const store = load(fixture({ columns: [px(100), px(200), fr()], rows: [auto], autoFlow: 'row' }, [['a', { columnStart: 3 }], ['b', null]]))
    expect(store.commands.layout.grid.removeTrack('columns', 1, ['card'])).toBe(false)
    expect(store.commands.layout.grid.removeTrack('rows', 1, ['card'])).toBe(false)
    expect(store.commands.layout.grid.removeTrack('columns', 4, ['card'])).toBe(false)
    expect(revision(store)).toBe(0)
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(tracks(store).columns).toEqual([px(100), px(200), fr()])
    // Negative control: once a only needs two columns the same removal goes through.
    expect(store.commands.layout.grid.setPlacement({ columnStart: 2 }, ['a'])).toBe(true)
    expect(store.commands.layout.grid.removeTrack('columns', 1, ['card'])).toBe(true)
    expect(tracks(store).columns).toEqual([px(200), fr()])
    expect(gridItem(store, 'a')).toEqual({ columnStart: 1 })
  })
})

describe('LAY-GRID-004: track move keeps explicit and automatic areas', () => {
  const moving = () => load(fixture({ columns: [px(100), px(200), px(300)], rows: [px(40), px(60)], autoFlow: 'row' }, [['a', null], ['b', null], ['c', null], ['d', { columnStart: 2, rowStart: 2 }]]))

  it('moving column 1 to 3 remaps the explicit start and reorders auto children so each stays on its track', () => {
    const store = moving()
    // Before: a on the 100 track, b on 200, c on 300, d explicit on 200 in row 2.
    expect(store.commands.layout.grid.occupancy('card')).toEqual({ d: area(2, 2), a: area(1, 1), b: area(2, 1), c: area(3, 1) })
    expect(store.commands.layout.grid.moveTrack('columns', 1, 3, ['card'])).toBe(true)
    expect(revision(store)).toBe(1)
    expect(tracks(store).columns).toEqual([px(200), px(300), px(100)])
    expect(gridItem(store, 'd')).toEqual({ columnStart: 1, rowStart: 2 })
    // After: 200 is column 1, 300 is column 2, 100 is column 3, so the auto order must be b, c, a.
    expect(order(store)).toEqual(['b', 'c', 'a', 'd'])
    expect(store.commands.layout.grid.occupancy('card')).toEqual({ d: area(1, 2), b: area(1, 1), c: area(2, 1), a: area(3, 1) })
    store.undo()
    expect(order(store)).toEqual(['a', 'b', 'c', 'd'])
    expect(tracks(store).columns).toEqual([px(100), px(200), px(300)])
    expect(gridItem(store, 'd')).toEqual({ columnStart: 2, rowStart: 2 })
  })

  it('when no order can keep auto children on their row, the track still moves and the order stays', () => {
    const store = moving()
    // a, b, c fill row 1; moving row 1 below row 2 would need them in row 2 with row 1 empty, which sparse auto placement never does.
    expect(store.commands.layout.grid.moveTrack('rows', 1, 2, ['card'])).toBe(true)
    expect(tracks(store).rows).toEqual([px(60), px(40)])
    expect(gridItem(store, 'd')).toEqual({ columnStart: 2, rowStart: 1 })
    expect(order(store)).toEqual(['a', 'b', 'c', 'd'])
    expect(store.commands.layout.grid.moveTrack('rows', 1, 1, ['card'])).toBe(false)
    expect(store.commands.layout.grid.moveTrack('rows', 1, 3, ['card'])).toBe(false)
    expect(revision(store)).toBe(1)
  })
})

describe('LAY-GRID-005: manual to auto', () => {
  it('clears starts and applies the sibling order that reproduces the occupancy, spans kept, in one undo step', () => {
    // b spans columns 1..2 of row 1, a sits in column 3, c opens row 2. Auto placement reproduces it only in the order b, a, c.
    const store = load(fixture(grid3(), [['a', { columnStart: 3, rowStart: 1 }], ['b', { columnStart: 1, rowStart: 1, columnSpan: 2 }], ['c', { columnStart: 1, rowStart: 2 }]]))
    expect(store.commands.layout.grid.isManual('card')).toBe(true)
    expect(store.commands.layout.grid.setManual('card', false, null)).toBe(true)
    expect(revision(store)).toBe(1)
    expect(layoutOf(store, 'a')).toEqual({ item: { position: flow } })
    expect(layoutOf(store, 'b')).toEqual({ item: { position: flow, grid: { columnSpan: 2 } } })
    expect(layoutOf(store, 'c')).toEqual({ item: { position: flow } })
    expect(order(store)).toEqual(['b', 'a', 'c'])
    expect(store.commands.layout.grid.isManual('card')).toBe(false)
    expect(store.commands.layout.grid.occupancy('card')).toEqual({ b: area(1, 1, 2, 1), a: area(3, 1), c: area(1, 2) })
    // Already automatic: nothing to do.
    expect(store.commands.layout.grid.setManual('card', false, null)).toBe(false)
    store.undo()
    expect(order(store)).toEqual(['a', 'b', 'c'])
    expect(gridItem(store, 'b')).toEqual({ columnStart: 1, rowStart: 1, columnSpan: 2 })
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('writes nothing when no order reproduces the occupancy', () => {
    const cases: [string, GridItem, GridItem][] = [
      // A hole in column 2: sparse auto placement never skips a free cell.
      ['hole', { columnStart: 1, rowStart: 1 }, { columnStart: 3, rowStart: 1 }],
      // An explicit collision: two auto items never share a cell.
      ['collision', { columnStart: 1, rowStart: 1 }, { columnStart: 1, rowStart: 1 }],
      // A span along the flow axis (row span in row flow) never converts back, as in Wonder.
      ['flow span', { columnStart: 1, rowStart: 1, rowSpan: 2 }, { columnStart: 2, rowStart: 1 }],
    ]
    for (const [, a, b] of cases) {
      const store = load(fixture(grid3([auto, auto]), [['a', a], ['b', b]]))
      expect(store.commands.layout.grid.setManual('card', false, null)).toBe(false)
      expect(revision(store)).toBe(0)
      expect(store.getSnapshot().canUndo).toBe(false)
      expect(gridItem(store, 'a')).toEqual(a)
      expect(gridItem(store, 'b')).toEqual(b)
    }
  })
})

describe('auto to manual from measurement', () => {
  // Container (100, 50) 332 x 132, padding 12, columns 200 and 100, rows 40 and 60, both gaps 8. Column lines 112, 312,
  // 320, 420; row lines 62, 102, 110, 170.
  const measured = (children: Record<string, { x: number; y: number; width: number; height: number }>): MeasuredGrid => ({
    container: { x: 100, y: 50, width: 332, height: 132 },
    grid: { columns: [200, 100], rows: [40, 60], columnGap: 8, rowGap: 8, padding: { top: 12, right: 12, bottom: 12, left: 12 } },
    children,
  })
  const rects = {
    // Stretched with a 3 px margin on every side: cell (1, 1).
    a: { x: 115, y: 65, width: 194, height: 34 },
    // Fills cell (2, 2).
    b: { x: 320, y: 110, width: 100, height: 60 },
    // Centred 50 x 20 box with centre (370, 82): the centre of cell (2, 1).
    c: { x: 345, y: 72, width: 50, height: 20 },
    // Outside every track.
    d: { x: 600, y: 300, width: 10, height: 10 },
    // Centred 400 wide box overflowing column 2 (centre 370): its left edge 170 is nearer column 1, its centre is not.
    e: { x: 170, y: 120, width: 400, height: 40 },
  }
  const manualFixture = () => load(fixture({ columns: [px(200), px(100)], rows: [px(40), px(60)], autoFlow: 'row' }, [['a', null], ['b', null], ['c', { justifySelf: 'center', alignSelf: 'center' }], ['d', null], ['e', { justifySelf: 'center' }], ['f', null]]))

  it('writes the nearest cell to every measurable child in one batch and reports the rest', () => {
    const store = manualFixture()
    expect(store.commands.layout.grid.isManual('card')).toBe(false)
    expect(store.commands.layout.grid.measureCells('card', measured(rects))).toEqual({ cells: { a: { column: 1, row: 1 }, b: { column: 2, row: 2 }, c: { column: 2, row: 1 }, e: { column: 2, row: 2 } }, unsupported: ['d', 'f'] })
    expect(store.commands.layout.grid.setManual('card', true, measured(rects))).toBe(true)
    expect(revision(store)).toBe(1)
    expect(gridItem(store, 'a')).toEqual({ columnStart: 1, rowStart: 1 })
    expect(gridItem(store, 'b')).toEqual({ columnStart: 2, rowStart: 2 })
    expect(gridItem(store, 'c')).toEqual({ justifySelf: 'center', alignSelf: 'center', columnStart: 2, rowStart: 1 })
    expect(gridItem(store, 'e')).toEqual({ justifySelf: 'center', columnStart: 2, rowStart: 2 })
    expect(layoutOf(store, 'd')).toBeUndefined()
    expect(layoutOf(store, 'f')).toBeUndefined()
    expect(store.commands.layout.grid.isManual('card')).toBe(true)
    // Without a measurement there is nothing to place.
    expect(store.commands.layout.grid.setManual('card', true, null)).toBe(false)
    store.undo()
    expect(gridItem(store, 'a')).toBeUndefined()
    expect(gridItem(store, 'c')).toEqual({ justifySelf: 'center', alignSelf: 'center' })
  })

  it('uses the authored distribution for track offsets when the measurement has none', () => {
    // space-between in a 500 wide container: content 476, free 168, column 2 spans 488..588.
    const store = manualFixture()
    expect(store.commands.layout.grid.setAlignment({ justifyContent: 'space-between' }, ['card'])).toBe(true)
    const wide = { ...measured({ b: { x: 488, y: 62, width: 100, height: 40 } }), container: { x: 100, y: 50, width: 500, height: 132 } }
    expect(store.commands.layout.grid.measureCells('card', wide).cells).toEqual({ b: { column: 2, row: 1 } })
    // Negative control: with start packing forced, the same rectangle is past every packed track.
    expect(store.commands.layout.grid.measureCells('card', { ...wide, distribution: {} }).unsupported).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})

describe('LAY-GRID-006 (model): explicit collisions persist and auto placement avoids occupied cells', () => {
  it('two children share cell (1, 1), the projected lines say so, and the auto child takes (2, 1)', () => {
    const store = load(fixture(grid3(), [['a', null], ['b', null], ['c', null]]))
    expect(store.commands.layout.grid.setPlacement({ columnStart: 1, rowStart: 1 }, ['a', 'b'])).toBe(true)
    expect(revision(store)).toBe(1)
    expect(gridItem(store, 'a')).toEqual({ columnStart: 1, rowStart: 1 })
    expect(gridItem(store, 'b')).toEqual({ columnStart: 1, rowStart: 1 })
    expect(layoutDeclarations(layoutOf(store, 'a'), 'grid')).toEqual({ 'grid-column-start': '1', 'grid-row-start': '1' })
    expect(layoutDeclarations(layoutOf(store, 'b'), 'grid')).toEqual({ 'grid-column-start': '1', 'grid-row-start': '1' })
    expect(store.commands.layout.grid.occupancy('card')).toEqual({ a: area(1, 1), b: area(1, 1), c: area(2, 1) })
    expect(store.commands.layout.grid.isManual('card')).toBe(true)
  })
})

describe('setPlacement and moveToCell', () => {
  it('partial start and span combinations store and project exactly', () => {
    const store = load(fixture(grid3(), [['a', null], ['b', null]]))
    const grid = store.commands.layout.grid
    expect(grid.setPlacement({ columnStart: 2 }, ['a'])).toBe(true)
    expect(gridItem(store, 'a')).toEqual({ columnStart: 2 })
    expect(layoutDeclarations(layoutOf(store, 'a'), 'grid')).toEqual({ 'grid-column-start': '2' })
    expect(grid.setPlacement({ columnSpan: 3 }, ['a'])).toBe(true)
    expect(gridItem(store, 'a')).toEqual({ columnStart: 2, columnSpan: 3 })
    expect(layoutDeclarations(layoutOf(store, 'a'), 'grid')).toEqual({ 'grid-column-start': '2', 'grid-column-end': 'span 3' })
    expect(grid.setPlacement({ columnStart: null }, ['a'])).toBe(true)
    expect(gridItem(store, 'a')).toEqual({ columnSpan: 3 })
    expect(layoutDeclarations(layoutOf(store, 'a'), 'grid')).toEqual({ 'grid-column-start': 'span 3' })
    expect(grid.setPlacement({ columnSpan: null, rowSpan: 2, alignSelf: 'center' }, ['a'])).toBe(true)
    expect(gridItem(store, 'a')).toEqual({ rowSpan: 2, alignSelf: 'center' })
    expect(layoutDeclarations(layoutOf(store, 'a'), 'grid')).toEqual({ 'grid-row-start': 'span 2', 'align-self': 'center' })
    expect(grid.setPlacement({ rowSpan: null, alignSelf: null }, ['a'])).toBe(true)
    expect(layoutOf(store, 'a')).toEqual({ item: { position: flow } })
    expect(layoutDeclarations(layoutOf(store, 'a'), 'grid')).toBeUndefined()
    expect(revision(store)).toBe(5)
    // Out of range, fractional, unknown alignment, a node outside any Grid, and a no-op: nothing is written.
    for (const bad of [{ columnStart: 0 }, { rowStart: 1001 }, { columnSpan: 1.5 }, { rowSpan: -1 }, { justifySelf: 'baseline' as never }]) expect(grid.setPlacement(bad, ['a', 'b'])).toBe(false)
    expect(grid.setPlacement({ columnStart: 1 }, ['card', 'other'])).toBe(false)
    expect(grid.setPlacement({ rowSpan: null }, ['a'])).toBe(false)
    expect(revision(store)).toBe(5)
  })

  it('moveToCell writes explicit starts, keeps spans, and turns an auto Grid manual', () => {
    const store = load(fixture(grid3([auto, auto]), [['a', null], ['b', null], ['c', { columnSpan: 2 }]]))
    const grid = store.commands.layout.grid
    expect(grid.isManual('card')).toBe(false)
    expect(grid.moveToCell('c', { column: 1, row: 2 })).toBe(true)
    expect(gridItem(store, 'c')).toEqual({ columnSpan: 2, columnStart: 1, rowStart: 2 })
    expect(grid.isManual('card')).toBe(true)
    expect(grid.occupancy('card')).toEqual({ c: area(1, 2, 2, 1), a: area(1, 1), b: area(2, 1) })
    expect(grid.moveToCell('c', { column: 1, row: 2 })).toBe(false)
    expect(grid.moveToCell('c', { column: 0, row: 2 })).toBe(false)
    expect(grid.moveToCell('card', { column: 1, row: 1 })).toBe(false)
    expect(revision(store)).toBe(1)
  })
})

describe('container edits', () => {
  it('tracks, flow and alignment each write one revision and skip non-Grid nodes', () => {
    const store = load(fixture(grid3(), [['a', null]]))
    const grid = store.commands.layout.grid
    expect(grid.addTrack('columns', ['card', 'other', 'a'])).toBe(true)
    expect(tracks(store).columns).toEqual([fr(), fr(), fr(), fr()])
    expect(grid.setTracks('rows', [], ['card'])).toBe(false)
    expect(grid.setTracks('rows', [{ kind: 'px', value: -1 }], ['card'])).toBe(false)
    expect(grid.setTracks('rows', [px(40), auto], ['card'])).toBe(true)
    expect(tracks(store).rows).toEqual([px(40), auto])
    expect(grid.setAutoFlow('column', ['card'])).toBe(true)
    expect(grid.setAutoFlow('column', ['card'])).toBe(false)
    expect(grid.setAlignment({ justifyContent: 'space-between', alignItems: 'center' }, ['card'])).toBe(true)
    expect(tracks(store)).toEqual({ columns: [fr(), fr(), fr(), fr()], rows: [px(40), auto], autoFlow: 'column', justifyContent: 'space-between', alignItems: 'center' })
    expect(grid.setAlignment({ alignItems: null }, ['card'])).toBe(true)
    expect(tracks(store).alignItems).toBeUndefined()
    expect(grid.setAlignment({ justifyItems: 'space-between' as never }, ['card'])).toBe(false)
    expect(grid.setAutoFlow('row', ['other'])).toBe(false)
    expect(revision(store)).toBe(5)
    expect(layoutOf(store, 'other')!.container!.display).toBe('flex')
  })
})
