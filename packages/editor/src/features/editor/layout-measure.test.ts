import { describe, expect, it } from 'vitest'
import type { ComponentNode, FileDocument } from '@canvas/repo-engine/file-document'
import { availableModes, isRootChild, layoutReport, legacyHostContentWidth, localPoint, measuredChildren, measuredGrid, measuredPx, parentContentPx, parentDirection, sizingContext, sizingTargets } from './layout-measure'
import type { LayoutGeometry } from './layout-measure'

// Expected values below are worked out by hand from the literal rectangles and box sides, never by calling the
// production helpers: the card is 352 x 200 with a 1 px border and 28 px padding on every side.
const px = (value: number) => ({ kind: 'px' as const, value })
const label = (id: string, layout?: ComponentNode['layout']): ComponentNode => ({ id, type: 'component', componentId: 'sample-label', exportName: 'Label', props: {}, ...(layout ? { layout } : {}) })
const fixture = (): FileDocument => ({
  schemaVersion: 7, fileId: 'measure', revision: 0,
  pages: [{ id: 'page-1', name: 'Page', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    a: label('a', { item: { position: { mode: 'flow' }, width: { value: px(120) } } }),
    b: label('b', { item: { position: { mode: 'absolute', left: px(10), top: px(12) } } }),
    c: label('c'),
    bare: { id: 'bare', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {} },
    inner: label('inner'),
    flat: { id: 'flat', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {} },
    squeezed: label('squeezed'),
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' },
    a: { parentId: 'card', orderKey: 'V', slot: 'children' },
    b: { parentId: 'card', orderKey: 'W', slot: 'children' },
    c: { parentId: 'card', orderKey: 'X', slot: 'children' },
    bare: { parentId: 'root-1', orderKey: 'W' },
    inner: { parentId: 'bare', orderKey: 'V', slot: 'children' },
    flat: { parentId: 'root-1', orderKey: 'X' },
    squeezed: { parentId: 'flat', orderKey: 'V', slot: 'children' },
  },
  theme: { tokens: {} },
})
const sides = (top: number, right: number, bottom: number, left: number) => ({ top, right, bottom, left })
const geometry: LayoutGeometry = {
  nodes: {
    card: { componentId: 'sample-card', rect: { x: -176, y: -236, width: 352, height: 200 }, box: { padding: sides(28, 28, 28, 28), border: sides(1, 1, 1, 1) }, layout: { status: 'applied', conflicts: ['display'] }, grid: { columns: [100, 194], rows: [40], columnGap: 0, rowGap: 0, padding: sides(28, 28, 28, 28) } },
    a: { componentId: 'sample-label', rect: { x: -147, y: -207, width: 120, height: 26 }, box: { padding: sides(4, 0, 4, 0), border: sides(0, 0, 0, 0) } },
    b: { componentId: 'sample-label', rect: { x: -165, y: -223, width: 60, height: 26 } },
    // A parent measured without box sides cannot give a content size.
    bare: { componentId: 'sample-card', rect: { x: 0, y: 0, width: 300, height: 100 } },
    // A collapsed parent whose border and padding consume the whole box.
    flat: { componentId: 'sample-card', rect: { x: 0, y: 0, width: 20, height: 0 }, box: { padding: sides(0, 10, 0, 10), border: sides(0, 0, 0, 0) } },
  },
  unsupported: { inner: 'unsupported-no-root' },
}

describe('legacy host and parents', () => {
  it('the legacy host content width is 400 minus 24 padding on each side', () => {
    expect(legacyHostContentWidth).toBe(352)
  })
  it('root children are those whose parent is the page root', () => {
    const file = fixture()
    expect(isRootChild(file, 'card')).toBe(true)
    expect(isRootChild(file, 'a')).toBe(false)
    expect(isRootChild(file, 'missing')).toBe(false)
  })
})

describe('LAY-SIZE-001 and LAY-SIZE-004: parent content size per axis', () => {
  it('flow children resolve against the parent content box (rect minus border and padding)', () => {
    const file = fixture()
    expect(parentContentPx(file, geometry, 'a', 'width')).toBe(294)
    expect(parentContentPx(file, geometry, 'a', 'height')).toBe(142)
    // c has no measurement of its own, but its parent does.
    expect(parentContentPx(file, geometry, 'c', 'width')).toBe(294)
  })
  it('absolute children resolve against the parent padding box (rect minus border only)', () => {
    const file = fixture()
    expect(parentContentPx(file, geometry, 'b', 'width')).toBe(350)
    expect(parentContentPx(file, geometry, 'b', 'height')).toBe(198)
  })
  it('root children use the legacy host width and have no definite height', () => {
    const file = fixture()
    expect(parentContentPx(file, geometry, 'card', 'width')).toBe(352)
    expect(parentContentPx(file, geometry, 'card', 'height')).toBeUndefined()
  })
  it('a parent without box sides, a collapsed parent, or a missing parent never yields a number', () => {
    const file = fixture()
    expect(parentContentPx(file, geometry, 'inner', 'width')).toBeUndefined()
    expect(parentContentPx(file, geometry, 'squeezed', 'width')).toBeUndefined()
    expect(parentContentPx(file, geometry, 'squeezed', 'height')).toBeUndefined()
    expect(parentContentPx(file, geometry, 'root-1', 'width')).toBeUndefined()
  })
  it('measured sizes come from the node rectangle and are absent without a positive one', () => {
    expect(measuredPx(geometry, 'a', 'width')).toBe(120)
    expect(measuredPx(geometry, 'a', 'height')).toBe(26)
    expect(measuredPx(geometry, 'c', 'width')).toBeUndefined()
    expect(measuredPx(geometry, 'flat', 'height')).toBeUndefined()
  })
})

describe('LAY-SIZE-003: sizing targets for a selection', () => {
  it('gives every component its own measurement and parent direction, skipping non-components', () => {
    const file = fixture()
    expect(sizingTargets(file, geometry, ['a', 'b', 'card', 'root-1'], 'width')).toEqual([
      { id: 'a', layout: { item: { position: { mode: 'flow' }, width: { value: px(120) } } }, measurement: { measuredPx: 120, parentPx: 294 }, parentDirection: 'row' },
      { id: 'b', layout: { item: { position: { mode: 'absolute', left: px(10), top: px(12) } } }, measurement: { measuredPx: 60, parentPx: 350 }, parentDirection: 'row' },
      { id: 'card', layout: file.nodes.card!.type === 'component' ? (file.nodes.card as ComponentNode).layout : undefined, measurement: { measuredPx: 352, parentPx: 352 }, parentDirection: null },
    ])
  })
  it('a node with no measurement and an unmeasured parent carries an empty measurement', () => {
    expect(sizingTargets(fixture(), geometry, ['inner'], 'height')).toEqual([{ id: 'inner', layout: undefined, measurement: {}, parentDirection: null }])
  })
  it('parent direction only exists under a Flex parent', () => {
    const file = fixture()
    expect(parentDirection(file, 'a')).toBe('row')
    expect(parentDirection(file, 'card')).toBeNull()
    expect(parentDirection(file, 'inner')).toBeNull()
  })
})

describe('sizing availability', () => {
  it('root children have no layout parent; component nodes have intrinsic content', () => {
    const file = fixture()
    expect(sizingContext(file, 'card')).toEqual({ hasParent: false, intrinsicContent: true })
    expect(sizingContext(file, 'a')).toEqual({ hasParent: true, intrinsicContent: true })
  })
  it('offers the intersection of modes across the selection', () => {
    const file = fixture()
    expect(availableModes(file, ['a'])).toEqual(['fixed', 'relative', 'hug', 'fill', 'auto'])
    expect(availableModes(file, ['card'])).toEqual(['fixed', 'hug', 'auto'])
    expect(availableModes(file, ['a', 'card'])).toEqual(['fixed', 'hug', 'auto'])
    expect(availableModes(file, [])).toEqual([])
  })
})

describe('LAY-GEST-004: local point when leaving the flow', () => {
  it('nested nodes measure from the parent padding edge', () => {
    // a sits at the card's padding: -147 - (-176) - 1 border = 28, and -207 - (-236) - 1 = 28.
    expect(localPoint(fixture(), geometry, 'a')).toEqual({ x: 28, y: 28 })
  })
  it('root children use their world position', () => {
    expect(localPoint(fixture(), geometry, 'card')).toEqual({ x: -176, y: -236 })
  })
  it('is absent without a measurement of the node or its parent', () => {
    expect(localPoint(fixture(), geometry, 'c')).toBeUndefined()
  })
})

describe('container measurements', () => {
  it('lists measured children only, with the container box', () => {
    expect(measuredChildren(fixture(), geometry, 'card')).toEqual({
      container: { x: -176, y: -236, width: 352, height: 200 },
      children: { a: { x: -147, y: -207, width: 120, height: 26 }, b: { x: -165, y: -223, width: 60, height: 26 } },
      // The measured border travels along so conversions count insets from the padding edge.
      border: sides(1, 1, 1, 1),
    })
    expect(measuredChildren(fixture(), geometry, 'c')).toEqual({ container: null, children: {} })
  })
  it('a Grid measurement carries the resolved tracks, or is null when the node was not measured as a grid', () => {
    const grid = measuredGrid(fixture(), geometry, 'card')
    expect(grid?.grid.columns).toEqual([100, 194])
    expect(Object.keys(grid?.children ?? {})).toEqual(['a', 'b'])
    expect(measuredGrid(fixture(), geometry, 'bare')).toBeNull()
  })
  it('reports the runtime status, falling back to the unsupported list', () => {
    expect(layoutReport(geometry, 'card')).toEqual({ status: 'applied', conflicts: ['display'] })
    expect(layoutReport(geometry, 'inner')).toEqual({ status: 'unsupported-no-root', conflicts: [] })
    expect(layoutReport(geometry, 'a')).toBeNull()
  })
})
