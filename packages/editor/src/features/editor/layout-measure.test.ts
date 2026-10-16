import { describe, expect, it } from 'vitest'
import type { ComponentNode, FileDocument } from '@canvas/repo-engine/file-document'
import { inferFlexLayout } from '@canvas/repo-engine/flex-inference'
import { apply } from '@canvas/repo-engine/layout-matrix'
import { availableModes, isRootChild, layoutReport, legacyHostContentWidth, localPoint, measuredChildren, measuredGrid, measuredPx, paperDirectAddGeometry, paperFlexInput, paperRemoveFlexGeometry, paperWrapGeometry, parentContentPx, parentDirection, sizingContext, sizingTargets } from './layout-measure'
import type { LayoutGeometry } from './layout-measure'

// Expected values below are worked out by hand from the literal rectangles and box sides, never by calling the
// production helpers: the card is 352 x 200 with a 1 px border and 28 px padding on every side.
const px = (value: number) => ({ kind: 'px' as const, value })
const paperTextStyle = {
  fontFamily: 'Inter, system-ui, sans-serif', fontStyle: 'normal', fontWeight: 400, fontSize: 16,
  lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top',
  case: 'none', wrap: 'normal', keepWords: false,
} as const
const label = (id: string, layout?: ComponentNode['layout']): ComponentNode => ({ id, type: 'component', componentId: 'sample-label', exportName: 'Label', props: {}, ...(layout ? { layout } : {}) })
const fixture = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'measure', revision: 0,
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
      { id: 'a', layout: { item: { position: { mode: 'flow' }, width: { value: px(120) } } }, measurement: { measuredPx: 120, parentPx: 294 }, parentDirection: 'row', parentDisplay: 'flex', local: { x: 28, y: 28 } },
      { id: 'b', layout: { item: { position: { mode: 'absolute', left: px(10), top: px(12) } } }, measurement: { measuredPx: 60, parentPx: 350 }, parentDirection: 'row', parentDisplay: 'flex', local: { x: 10, y: 12 } },
      { id: 'card', layout: file.nodes.card!.type === 'component' ? (file.nodes.card as ComponentNode).layout : undefined, measurement: { measuredPx: 352, parentPx: 352 }, parentDirection: null, parentDisplay: null, local: { x: -176, y: -236 } },
    ])
  })
  it('a node with no measurement and an unmeasured parent carries an empty measurement', () => {
    expect(sizingTargets(fixture(), geometry, ['inner'], 'height')).toEqual([{ id: 'inner', layout: undefined, measurement: {}, parentDirection: null, parentDisplay: 'freeform' }])
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

const paperFile = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'paper-measure', revision: 11,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [0.866025403784, 0.5, -0.5, 0.866025403784, 81.43593539449, -63.923048454133], width: 320, height: 240 }, layout: { item: { position: { mode: 'absolute', left: px(0), top: px(0) } }, container: { display: 'freeform' } } },
    a: { id: 'a', type: 'rectangle', name: 'A', styles: { relativeTransform: [0, 1, -1, 0, 330, -5], width: 40, height: 20 }, layout: { item: { position: { mode: 'absolute', left: px(300), top: px(5) } } } },
    b: { id: 'b', type: 'rectangle', name: 'B', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 30, height: 10 }, layout: { item: { position: { mode: 'absolute', right: px(10), bottom: px(20) } } } },
  },
  relationships: { frame: { parentId: 'root', orderKey: 'V' }, a: { parentId: 'frame', orderKey: 'V' }, b: { parentId: 'frame', orderKey: 'W' } },
  theme: { tokens: {} },
})
const paperGeometry = (): LayoutGeometry => ({
  documentRevision: 11, layoutGeneration: 8, unsupported: {},
  nodes: {
    frame: { canvasKind: 'frame', documentRevision: 11, layoutGeneration: 8, rect: { x: -100, y: -80, width: 400, height: 360 }, worldAabb: { x: -100, y: -80, width: 400, height: 360 }, offset: { x: 0, y: 0, width: 320, height: 240, origin: { x: 160, y: 120 } }, offsetParentNodeId: null, directChild: true },
    a: { canvasKind: 'rectangle', documentRevision: 11, layoutGeneration: 8, rect: { x: 0, y: 0, width: 40, height: 20 }, worldAabb: { x: 80, y: 0, width: 40, height: 20 }, offset: { x: 10, y: 20, width: 40, height: 20, origin: { x: 20, y: 10 } }, offsetParentNodeId: 'frame', directChild: true, transform: [0, 1, -1, 0, 0, 0] },
    b: { canvasKind: 'rectangle', documentRevision: 11, layoutGeneration: 8, rect: { x: 200, y: 0, width: 30, height: 10 }, worldAabb: { x: 85, y: 105, width: 30, height: 10 }, offset: { x: 130, y: 80, width: 30, height: 10, origin: { x: 15, y: 5 } }, offsetParentNodeId: 'frame', directChild: true },
  },
})

describe('PAPER-FLEX-001/002 strict Paper analyzer geometry', () => {
  it('preserves tree order while keeping visual, authored, resolved-local, and transformed-parent-local channels distinct', () => {
    const input = paperFlexInput(paperFile(), paperGeometry(), 'frame', 'direct-add', 8)
    expect(input).not.toBeNull()
    expect(input!.children.map(child => child.id)).toEqual(['a', 'b'])
    expect(input!.children[0]).toMatchObject({ authoredPosition: { x: 300, y: 5 }, authoredSize: { width: 40, height: 20 }, parentLocalCenter: { x: 30, y: 30 }, worldAabb: { x: 80, y: 0, width: 40, height: 20 } })
    // Right/bottom anchoring has no definite leading inset, so the resolved DOM offset is authoritative.
    expect(input!.children[1]!.authoredPosition).toEqual({ x: 130, y: 80 })
    // All four rotated border-box corners are unioned in the parent padding-box coordinate system.
    expect(input!.directAddLeadingInset).toEqual({ x: 20, y: 10 })
  })

  it('keeps parent-local padding geometry invariant when only the rotated parent world bounds change', () => {
    const first = paperFlexInput(paperFile(), paperGeometry(), 'frame', 'direct-add', 8)!
    const changed = paperGeometry()
    changed.nodes.frame = { ...changed.nodes.frame!, rect: { x: 900, y: -700, width: 600, height: 500 }, worldAabb: { x: 900, y: -700, width: 600, height: 500 } }
    const second = paperFlexInput(paperFile(), changed, 'frame', 'direct-add', 8)!
    expect(second.children.map(child => child.parentLocalCenter)).toEqual(first.children.map(child => child.parentLocalCenter))
    expect(second.directAddLeadingInset).toEqual(first.directAddLeadingInset)
  })

  it('uses raw visual AABBs for direction instead of reconstructing them from interaction rectangles', () => {
    const input = paperFlexInput(paperFile(), paperGeometry(), 'frame', 'direct-add', 8)!
    expect(inferFlexLayout(input).direction).toBe('column')
    const mutated = { ...input, children: input.children.map(child => ({ ...child, worldAabb: paperGeometry().nodes[child.id]!.rect })) }
    expect(inferFlexLayout(mutated).direction).toBe('row')
  })

  it('rejects stale revisions, stale generations, missing offset-parent proof, and indirect roots', () => {
    const staleRevision = paperGeometry(); staleRevision.documentRevision = 10
    expect(paperFlexInput(paperFile(), staleRevision, 'frame', 'direct-add', 8)).toBeNull()
    const staleGeneration = paperGeometry(); staleGeneration.layoutGeneration = 7
    expect(paperFlexInput(paperFile(), staleGeneration, 'frame', 'direct-add', 8)).toBeNull()
    const missingProof = paperGeometry(); delete missingProof.nodes.a!.offsetParentNodeId
    expect(paperFlexInput(paperFile(), missingProof, 'frame', 'direct-add', 8)).toBeNull()

    const rootFile: FileDocument = { ...paperFile(), nodes: { root: { id: 'root', type: 'root' }, card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {} } }, relationships: { card: { parentId: 'root', orderKey: 'V' } } }
    const rootNode = { componentId: 'sample-card', documentRevision: 11, layoutGeneration: 8, rect: { x: 0, y: 0, width: 100, height: 50 }, worldAabb: { x: 0, y: 0, width: 100, height: 50 }, offset: { x: 20, y: 30, width: 100, height: 50, origin: { x: 50, y: 25 } }, offsetParentNodeId: null as null, offsetParentToRoot: [1, 0, 0, 1, 0, 0] as const, parentInstanceId: null as null, directChild: true }
    const rootGeometry: LayoutGeometry = { documentRevision: 11, layoutGeneration: 8, unsupported: {}, nodes: { card: rootNode } }
    expect(paperFlexInput(rootFile, rootGeometry, 'root', 'wrap', 8)?.children[0]?.id).toBe('card')
    rootGeometry.nodes.card = { ...rootNode, directChild: false }
    expect(paperFlexInput(rootFile, rootGeometry, 'root', 'wrap', 8)).toBeNull()
  })

  it('allows only an empty primitive frame to fall back to authored container size', () => {
    const file = paperFile()
    delete file.nodes.a; delete file.nodes.b; delete file.relationships.a; delete file.relationships.b
    expect(paperFlexInput(file, { documentRevision: 11, layoutGeneration: 8, nodes: {}, unsupported: {} }, 'frame', 'direct-add', 8)).toEqual({ containerSize: { width: 320, height: 240 }, children: [], directAddLeadingInset: { x: 0, y: 0 }, kind: 'direct-add', isRoot: false })
  })

  it('normalizes mixed component-host and primitive-host root children before order, gap, and padding analysis', () => {
    const file: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'mixed-root', revision: 11,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        box: { id: 'box', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 50, -190], width: 40, height: 20 } },
        card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {} },
      },
      // Deliberately put the primitive first in tree order. Authored root coordinates put the component first.
      relationships: { box: { parentId: 'root', orderKey: 'V' }, card: { parentId: 'root', orderKey: 'W' } },
      theme: { tokens: {} },
    }
    const geometry: LayoutGeometry = {
      documentRevision: 11, layoutGeneration: 8, unsupported: {},
      nodes: {
        box: { canvasKind: 'rectangle', documentRevision: 11, layoutGeneration: 8, rect: { x: 50, y: -190, width: 40, height: 20 }, worldAabb: { x: 50, y: -190, width: 40, height: 20 }, offset: { x: 50, y: -190, width: 40, height: 20, origin: { x: 20, y: 10 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true },
        card: { componentId: 'sample-card', documentRevision: 11, layoutGeneration: 8, rect: { x: -156, y: -206, width: 100, height: 50 }, worldAabb: { x: -156, y: -206, width: 100, height: 50 }, offset: { x: 20, y: 30, width: 100, height: 50, origin: { x: 50, y: 25 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, -176, -236], parentInstanceId: null, directChild: true },
      },
    }
    const input = paperFlexInput(file, geometry, 'root', 'wrap', 8)
    expect(input?.children.map(child => ({ id: child.id, authoredPosition: child.authoredPosition, parentLocalCenter: child.parentLocalCenter }))).toEqual([
      { id: 'box', authoredPosition: { x: 50, y: -190 }, parentLocalCenter: { x: 70, y: -180 } },
      { id: 'card', authoredPosition: { x: -156, y: -206 }, parentLocalCenter: { x: -106, y: -181 } },
    ])
    expect(inferFlexLayout(input!)).toMatchObject({ direction: 'row', order: ['card', 'box'], gap: 106, padding: { x: 0, y: 0 } })

    delete geometry.nodes.card!.offsetParentToRoot
    expect(paperFlexInput(file, geometry, 'root', 'wrap', 8)).toBeNull()
  })

  it('preserves explicit root component leading insets while normalizing resolved far-edge offsets', () => {
    const file: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'absolute-root-components', revision: 11,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        leading: {
          id: 'leading', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {},
          layout: { item: { position: { mode: 'absolute', left: px(50), top: px(70) } } },
        },
        trailing: {
          id: 'trailing', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {},
          layout: { item: { position: { mode: 'absolute', right: px(10), bottom: px(20) } } },
        },
      },
      relationships: { leading: { parentId: 'root', orderKey: 'V' }, trailing: { parentId: 'root', orderKey: 'W' } },
      theme: { tokens: {} },
    }
    const hostToRoot = [1, 0, 0, 1, -176, -236] as const
    const geometry: LayoutGeometry = {
      documentRevision: 11, layoutGeneration: 8, unsupported: {},
      nodes: {
        // file-preview subtracts the host origin before writing the leading CSS inset. The resulting DOM offset is
        // host-local, while the authored left/top values remain semantic root coordinates.
        leading: { componentId: 'sample-card', documentRevision: 11, layoutGeneration: 8, rect: { x: 50, y: 70, width: 100, height: 50 }, worldAabb: { x: 50, y: 70, width: 100, height: 50 }, offset: { x: 226, y: 306, width: 100, height: 50, origin: { x: 50, y: 25 } }, offsetParentNodeId: null, offsetParentToRoot: hostToRoot, parentInstanceId: null, directChild: true },
        // Right/bottom do not provide a definite leading inset, so their measured host-local offset must be mapped
        // through the proven host transform to become a semantic root position.
        trailing: { componentId: 'sample-card', documentRevision: 11, layoutGeneration: 8, rect: { x: 44, y: 94, width: 80, height: 40 }, worldAabb: { x: 44, y: 94, width: 80, height: 40 }, offset: { x: 220, y: 330, width: 80, height: 40, origin: { x: 40, y: 20 } }, offsetParentNodeId: null, offsetParentToRoot: hostToRoot, parentInstanceId: null, directChild: true },
      },
    }

    expect(paperFlexInput(file, geometry, 'root', 'wrap', 8)?.children.map(child => ({ id: child.id, authoredPosition: child.authoredPosition }))).toEqual([
      { id: 'leading', authoredPosition: { x: 50, y: 70 } },
      { id: 'trailing', authoredPosition: { x: 44, y: 94 } },
    ])
  })
})

const textPaperFile = (locked = false): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'paper-text-measure', revision: 21,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 240, height: 120 }, ...(locked ? { isLocked: true } : {}), layout: { item: { position: { mode: 'freeform' } }, container: { display: 'freeform' } } },
    exact: { id: 'exact', type: 'text', name: 'Exact', text: 'Exact', styles: { relativeTransform: [1, 0, 0, 1, 8, 10], width: 90, height: 30 }, textStyle: structuredClone(paperTextStyle), textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } } },
    over: { id: 'over', type: 'text', name: 'Over', text: 'Over', styles: { relativeTransform: [1, 0, 0, 1, 112, 10], width: 90, height: 30.002 }, textStyle: structuredClone(paperTextStyle), textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } } },
  },
  relationships: { frame: { parentId: 'root', orderKey: 'V' }, exact: { parentId: 'frame', orderKey: 'V' }, over: { parentId: 'frame', orderKey: 'W' } },
  theme: { tokens: {} },
})
const textPaperGeometry = (): LayoutGeometry => ({
  documentRevision: 21, layoutGeneration: 13, unsupported: {},
  nodes: {
    frame: { canvasKind: 'frame', documentRevision: 21, layoutGeneration: 13, rect: { x: -20, y: -10, width: 280, height: 160 }, worldAabb: { x: -20, y: -10, width: 280, height: 160 }, offset: { x: 0, y: 0, width: 240, height: 120, origin: { x: 120, y: 60 } }, offsetParentNodeId: null, directChild: true },
    exact: { canvasKind: 'text', documentRevision: 21, layoutGeneration: 13, rect: { x: 8, y: 10, width: 90, height: 30 }, worldAabb: { x: 8, y: 10, width: 90, height: 30 }, offset: { x: 8, y: 10, width: 90, height: 30, origin: { x: 45, y: 15 } }, offsetParentNodeId: 'frame', directChild: true, text: { resolvedLineHeight: 20 } },
    over: { canvasKind: 'text', documentRevision: 21, layoutGeneration: 13, rect: { x: 112, y: 10, width: 90, height: 30.002 }, worldAabb: { x: 112, y: 10, width: 90, height: 30.002 }, offset: { x: 112, y: 10, width: 90, height: 30.002, origin: { x: 45, y: 15.001 } }, offsetParentNodeId: 'frame', directChild: true, text: { resolvedLineHeight: 20 } },
  },
})

describe('PAPER-FLEX-001/002/003 authoritative sizing capture', () => {
  it('uses offset dimensions for sizing snapshots and raw world AABBs only for inference', () => {
    const geometry = paperGeometry()
    geometry.nodes.a = { ...geometry.nodes.a!, rect: { x: 0, y: 0, width: 20, height: 40 }, worldAabb: { x: 70, y: -10, width: 20, height: 40 } }
    const captured = paperDirectAddGeometry(paperFile(), geometry, 'frame', 8)
    expect(captured?.parentSnapshot.measured).toStrictEqual({ width: 320, height: 240 })
    expect(captured?.childSnapshots.a?.measured).toStrictEqual({ width: 40, height: 20 })
    expect(captured?.input.children[0]!.worldAabb).toStrictEqual({ x: 70, y: -10, width: 20, height: 40 })
  })

  it('carries the fenced resolved line height into the strict multiline threshold and honors lock ancestry', () => {
    const unlocked = paperDirectAddGeometry(textPaperFile(), textPaperGeometry(), 'frame', 13)
    expect(unlocked?.childSnapshots.exact?.text).toStrictEqual({ editable: true, multiline: false })
    expect(unlocked?.childSnapshots.over?.text).toStrictEqual({ editable: true, multiline: true })
    const locked = paperDirectAddGeometry(textPaperFile(true), textPaperGeometry(), 'frame', 13)
    expect(locked?.childSnapshots.exact?.text).toStrictEqual({ editable: false, multiline: false })
    expect(locked?.childSnapshots.over?.text).toStrictEqual({ editable: false, multiline: true })
  })

  it('fails the whole capture for a missing text metric or any stale or mixed participant projection', () => {
    const missingMetric = textPaperGeometry(); delete missingMetric.nodes.exact!.text
    expect(paperDirectAddGeometry(textPaperFile(), missingMetric, 'frame', 13)).toBeNull()
    missingMetric.nodes.frame!.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    expect(paperWrapGeometry(textPaperFile(), missingMetric, 'frame', ['exact'], 13)).toBeNull()
    const invalidMetric = textPaperGeometry(); invalidMetric.nodes.exact!.text = { resolvedLineHeight: 0 }
    expect(paperDirectAddGeometry(textPaperFile(), invalidMetric, 'frame', 13)).toBeNull()
    const staleDocument = textPaperGeometry(); staleDocument.nodes.over!.documentRevision = 20
    expect(paperDirectAddGeometry(textPaperFile(), staleDocument, 'frame', 13)).toBeNull()
    const staleGeneration = textPaperGeometry(); staleGeneration.nodes.frame!.layoutGeneration = 12
    expect(paperDirectAddGeometry(textPaperFile(), staleGeneration, 'frame', 13)).toBeNull()
    const indirect = textPaperGeometry(); indirect.nodes.frame!.directChild = false
    expect(paperDirectAddGeometry(textPaperFile(), indirect, 'frame', 13)).toBeNull()
  })

  it('proves selected and child Component instance parent identities from the same projection', () => {
    const file: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'component-capture', revision: 4, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        card: { id: 'card', type: 'component', componentId: 'card-source', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'freeform' } } },
        child: { id: 'child', type: 'component', componentId: 'label-source', exportName: 'Label', props: {} },
      },
      relationships: { card: { parentId: 'root', orderKey: 'V' }, child: { parentId: 'card', orderKey: 'V', slot: 'children' } }, theme: { tokens: {} },
    }
    const node = (id: 'card' | 'child', parent: string | null, width: number, height: number) => ({
      componentId: id === 'card' ? 'card-source' : 'label-source', documentRevision: 4, layoutGeneration: 2,
      rect: { x: 0, y: 0, width, height }, worldAabb: { x: 0, y: 0, width, height }, offset: { x: 0, y: 0, width, height, origin: { x: width / 2, y: height / 2 } },
      offsetParentNodeId: parent, parentInstanceId: parent, directChild: true,
    })
    const geometry: LayoutGeometry = { documentRevision: 4, layoutGeneration: 2, unsupported: {}, nodes: { card: node('card', null, 200, 100), child: node('child', 'card', 80, 24) } }
    expect(paperDirectAddGeometry(file, geometry, 'card', 2)?.childSnapshots.child?.kind).toBe('component')
    geometry.nodes.child = { ...geometry.nodes.child!, parentInstanceId: null }
    expect(paperDirectAddGeometry(file, geometry, 'card', 2)).toBeNull()
  })

  it('captures an empty Frame from its positive stored fallback without preview geometry', () => {
    const file = paperFile()
    delete file.nodes.a; delete file.nodes.b; delete file.relationships.a; delete file.relationships.b
    const sourceFrame = file.nodes.frame!
    const captured = paperDirectAddGeometry(file, { documentRevision: 11, layoutGeneration: 8, nodes: {}, unsupported: {} }, 'frame', 8)
    expect(captured).toStrictEqual({
      input: { containerSize: { width: 320, height: 240 }, children: [], directAddLeadingInset: { x: 0, y: 0 }, kind: 'direct-add', isRoot: false },
      parentSnapshot: {
        nodeId: 'frame', kind: 'primitive', fromFamily: 'freeform', measured: { width: 320, height: 240 }, sourceLayout: sourceFrame.type === 'frame' ? sourceFrame.layout! : null,
        sourcePosition: { mode: 'absolute', left: px(0), top: px(0) },
        axes: { width: { intent: 'fixed', measured: 320, fixedPx: 320 }, height: { intent: 'fixed', measured: 240, fixedPx: 240 } },
        primitiveSize: { width: 320, height: 240 },
      },
      childSnapshots: {},
    })
  })

  it('does not mutate Direct Add or Wrap document and geometry inputs at byte level', () => {
    const file = textPaperFile()
    const geometry = textPaperGeometry()
    const beforeFile = JSON.stringify(file)
    const beforeGeometry = JSON.stringify(geometry)
    expect(paperDirectAddGeometry(file, geometry, 'frame', 13)).not.toBeNull()
    expect(JSON.stringify(file)).toBe(beforeFile)
    expect(JSON.stringify(geometry)).toBe(beforeGeometry)
    geometry.nodes.frame!.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const beforeWrapGeometry = JSON.stringify(geometry)
    expect(paperWrapGeometry(file, geometry, 'frame', ['over'], 13)?.childSnapshots).toHaveProperty('over')
    expect(JSON.stringify(file)).toBe(beforeFile)
    expect(JSON.stringify(geometry)).toBe(beforeWrapGeometry)
  })
})

const removeFlexFile = (locked = false): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'remove-flex-measure', revision: 31,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    frame: {
      id: 'frame', type: 'frame', name: 'Frame', ...(locked ? { isLocked: true } : {}),
      styles: { relativeTransform: [1, 0, 0, 1, 40, 50], width: 300, height: 180 },
      layout: { item: { position: { mode: 'absolute', left: px(40), top: px(50) } }, container: { display: 'flex', gap: 12, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } }, spacing: { padding: 16 } },
    },
    first: { id: 'first', type: 'rectangle', name: 'First', styles: { relativeTransform: [0, 1, -1, 0, 60, -20], width: 80, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
    absolute: { id: 'absolute', type: 'shape', name: 'Absolute', styles: { relativeTransform: [1, 0, 0, 1, 200, 120], width: 30, height: 20 }, layout: { item: { position: { mode: 'absolute', left: px(200), top: px(120) } } } },
    copy: { id: 'copy', type: 'text', name: 'Copy', text: 'Two lines', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 42 }, textStyle: structuredClone(paperTextStyle), textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } }, layout: { item: { position: { mode: 'flow' } } } },
  },
  relationships: {
    frame: { parentId: 'root', orderKey: 'V' },
    copy: { parentId: 'frame', orderKey: 'X' },
    absolute: { parentId: 'frame', orderKey: 'W' },
    first: { parentId: 'frame', orderKey: 'V' },
  },
  theme: { tokens: {} },
})

const removeFlexGeometry = (): LayoutGeometry => ({
  documentRevision: 31, layoutGeneration: 17, unsupported: {},
  nodes: {
    frame: {
      canvasKind: 'frame', documentRevision: 31, layoutGeneration: 17,
      rect: { x: 40, y: 50, width: 300, height: 180 }, worldAabb: { x: 40, y: 50, width: 300, height: 180 },
      offset: { x: 40, y: 50, width: 300, height: 180, origin: { x: 150, y: 90 } },
      box: { padding: sides(24, 16, 24, 16), border: sides(1, 2, 3, 4) }, offsetParentNodeId: null, directChild: true,
    },
    first: {
      canvasKind: 'rectangle', documentRevision: 31, layoutGeneration: 17,
      rect: { x: 12, y: 24, width: 40, height: 80 }, worldAabb: { x: -999, y: -777, width: 40, height: 80 },
      offset: { x: 12, y: 24, width: 80, height: 40, origin: { x: 40, y: 20 } }, offsetParentNodeId: 'frame', directChild: true,
    },
    copy: {
      canvasKind: 'text', documentRevision: 31, layoutGeneration: 17,
      rect: { x: 110, y: 24, width: 120, height: 42 }, worldAabb: { x: 110, y: 24, width: 120, height: 42 },
      offset: { x: 110, y: 24, width: 120, height: 42, origin: { x: 60, y: 21 } }, offsetParentNodeId: 'frame', directChild: true,
      text: { resolvedLineHeight: 20 },
    },
  },
})

describe('PAPER-FLEX-001/002/003/008 strict Remove geometry', () => {
  it('captures exactly the direct flow children in document order from offset authority', () => {
    const result = paperRemoveFlexGeometry(removeFlexFile(), removeFlexGeometry(), 'frame', 17)
    expect(result?.parentSnapshot.measured).toStrictEqual({ width: 300, height: 180 })
    expect(result?.parentBorderBox).toStrictEqual({ width: 300, height: 180 })
    expect(result?.parentBorder).toStrictEqual({ top: 1, right: 2, bottom: 3, left: 4 })
    expect(result?.parentResolvedPadding).toStrictEqual({ top: 24, right: 16, bottom: 24, left: 16 })
    expect(result?.parentSnapshot.sourceLayout?.spacing).toStrictEqual({ padding: 16 })
    expect(result?.flowChildren.map(child => ({
      nodeId: child.nodeId,
      relationship: child.sourceRelationship,
      position: child.parentLocalPosition,
      measured: child.measured,
      snapshotMeasured: child.snapshot.measured,
    }))).toStrictEqual([
      { nodeId: 'first', relationship: { parentId: 'frame', orderKey: 'V' }, position: { x: 12, y: 24 }, measured: { width: 80, height: 40 }, snapshotMeasured: { width: 80, height: 40 } },
      { nodeId: 'copy', relationship: { parentId: 'frame', orderKey: 'X' }, position: { x: 110, y: 24 }, measured: { width: 120, height: 42 }, snapshotMeasured: { width: 120, height: 42 } },
    ])
    expect(result?.flowChildren.some(child => child.nodeId === 'absolute')).toBe(false)
  })

  it('preserves finite negative and out-of-bounds local positions without clamping', () => {
    const geometry = removeFlexGeometry()
    geometry.nodes.first!.offset = { ...geometry.nodes.first!.offset!, x: 16, y: -60 }
    geometry.nodes.copy!.offset = { ...geometry.nodes.copy!.offset!, x: 760, y: 24 }
    expect(paperRemoveFlexGeometry(removeFlexFile(), geometry, 'frame', 17)?.flowChildren.map(child => child.parentLocalPosition)).toStrictEqual([
      { x: 16, y: -60 },
      { x: 760, y: 24 },
    ])
  })

  it('uses the fenced text metric and lock ancestry without requiring absolute-child geometry', () => {
    const unlocked = paperRemoveFlexGeometry(removeFlexFile(), removeFlexGeometry(), 'frame', 17)
    expect(unlocked?.flowChildren[1]?.snapshot.text).toStrictEqual({ editable: true, multiline: true })
    const locked = paperRemoveFlexGeometry(removeFlexFile(true), removeFlexGeometry(), 'frame', 17)
    expect(locked?.flowChildren[1]?.snapshot.text).toStrictEqual({ editable: false, multiline: true })
  })

  it('accepts an empty measured Flex Frame but never a root or non-Flex parent', () => {
    const file = removeFlexFile()
    delete file.nodes.first; delete file.relationships.first
    delete file.nodes.absolute; delete file.relationships.absolute
    delete file.nodes.copy; delete file.relationships.copy
    const geometry = removeFlexGeometry()
    delete geometry.nodes.first; delete geometry.nodes.copy
    expect(paperRemoveFlexGeometry(file, geometry, 'frame', 17)?.flowChildren).toStrictEqual([])
    expect(paperRemoveFlexGeometry(file, geometry, 'root', 17)).toBeNull()
    if (file.nodes.frame?.type === 'frame') file.nodes.frame.layout!.container = { display: 'freeform' }
    expect(paperRemoveFlexGeometry(file, geometry, 'frame', 17)).toBeNull()
  })

  it('fails closed for a stale geometry root, parent, or one flow child', () => {
    const candidates = [removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry()]
    candidates[0]!.documentRevision = 30
    candidates[1]!.nodes.frame!.layoutGeneration = 16
    candidates[2]!.nodes.copy!.documentRevision = 30
    for (const geometry of candidates) expect(paperRemoveFlexGeometry(removeFlexFile(), geometry, 'frame', 17)).toBeNull()
  })

  it('fails closed for missing or invalid offset geometry and current-child cardinality drift', () => {
    const candidates = [removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry()]
    delete candidates[0]!.nodes.frame!.offset
    candidates[1]!.nodes.frame!.offset!.height = 0
    candidates[2]!.nodes.first!.offset!.width = 0
    candidates[3]!.nodes.copy!.offset!.x = Number.NaN
    delete candidates[4]!.nodes.copy
    delete candidates[5]!.nodes.frame!.box
    for (const geometry of candidates) expect(paperRemoveFlexGeometry(removeFlexFile(), geometry, 'frame', 17)).toBeNull()
  })

  it('fails closed when a primitive measurement reports the wrong canvas kind', () => {
    const wrongParent = removeFlexGeometry()
    wrongParent.nodes.frame!.canvasKind = 'shape'
    expect(paperRemoveFlexGeometry(removeFlexFile(), wrongParent, 'frame', 17)).toBeNull()

    const wrongChild = removeFlexGeometry()
    wrongChild.nodes.first!.canvasKind = 'shape'
    expect(paperRemoveFlexGeometry(removeFlexFile(), wrongChild, 'frame', 17)).toBeNull()

    const wrongText = removeFlexGeometry()
    wrongText.nodes.copy!.canvasKind = 'rectangle'
    expect(paperRemoveFlexGeometry(removeFlexFile(), wrongText, 'frame', 17)).toBeNull()
  })

  it('fails closed for indirect parentage, relationship drift, and a missing text metric', () => {
    const candidates = [removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry(), removeFlexGeometry()]
    candidates[0]!.nodes.frame!.directChild = false
    candidates[1]!.nodes.first!.directChild = false
    candidates[2]!.nodes.first!.offsetParentNodeId = 'other'
    delete candidates[3]!.nodes.copy!.text
    candidates[4]!.nodes.copy!.text = { resolvedLineHeight: 0 }
    for (const geometry of candidates) expect(paperRemoveFlexGeometry(removeFlexFile(), geometry, 'frame', 17)).toBeNull()
    const missingParentRelationship = removeFlexFile(); delete missingParentRelationship.relationships.frame
    expect(paperRemoveFlexGeometry(missingParentRelationship, removeFlexGeometry(), 'frame', 17)).toBeNull()
  })

  it('proves selected and child Component parent-instance identities', () => {
    const file: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'remove-component', revision: 7, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        card: { id: 'card', type: 'component', componentId: 'card-source', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
        child: { id: 'child', type: 'component', componentId: 'label-source', exportName: 'Label', props: {} },
      },
      relationships: { card: { parentId: 'root', orderKey: 'V' }, child: { parentId: 'card', orderKey: 'V', slot: 'children' } }, theme: { tokens: {} },
    }
    const geometry: LayoutGeometry = {
      documentRevision: 7, layoutGeneration: 4, unsupported: {},
      nodes: {
        card: { componentId: 'card-source', documentRevision: 7, layoutGeneration: 4, rect: { x: 0, y: 0, width: 200, height: 100 }, offset: { x: 0, y: 0, width: 200, height: 100, origin: { x: 100, y: 50 } }, box: { padding: sides(0, 0, 0, 0), border: sides(0, 0, 0, 0) }, offsetParentNodeId: null, parentInstanceId: null, directChild: true },
        child: { componentId: 'label-source', documentRevision: 7, layoutGeneration: 4, rect: { x: 10, y: 12, width: 80, height: 24 }, offset: { x: 10, y: 12, width: 80, height: 24, origin: { x: 40, y: 12 } }, offsetParentNodeId: 'card', parentInstanceId: 'card', directChild: true },
      },
    }
    expect(paperRemoveFlexGeometry(file, geometry, 'card', 4)?.flowChildren[0]?.snapshot.kind).toBe('component')
    const missingParentIdentity = structuredClone(geometry); delete missingParentIdentity.nodes.card!.parentInstanceId
    expect(paperRemoveFlexGeometry(file, missingParentIdentity, 'card', 4)).toBeNull()
    const wrongChildIdentity = structuredClone(geometry); wrongChildIdentity.nodes.child!.parentInstanceId = null
    expect(paperRemoveFlexGeometry(file, wrongChildIdentity, 'card', 4)).toBeNull()
    const wrongParentSource = structuredClone(geometry); wrongParentSource.nodes.card!.componentId = 'other-card-source'
    expect(paperRemoveFlexGeometry(file, wrongParentSource, 'card', 4)).toBeNull()
    const wrongChildSource = structuredClone(geometry); wrongChildSource.nodes.child!.componentId = 'other-label-source'
    expect(paperRemoveFlexGeometry(file, wrongChildSource, 'card', 4)).toBeNull()
  })

  it('does not mutate successful or rejected file and geometry inputs', () => {
    const file = removeFlexFile(), geometry = removeFlexGeometry()
    const beforeFile = structuredClone(file), beforeGeometry = structuredClone(geometry)
    const fileBytes = JSON.stringify(file), geometryBytes = JSON.stringify(geometry)
    expect(paperRemoveFlexGeometry(file, geometry, 'frame', 17)).not.toBeNull()
    expect(file).toStrictEqual(beforeFile); expect(geometry).toStrictEqual(beforeGeometry)
    expect(JSON.stringify(file)).toBe(fileBytes); expect(JSON.stringify(geometry)).toBe(geometryBytes)
    delete geometry.nodes.copy!.text
    const rejectedBytes = JSON.stringify(geometry)
    expect(paperRemoveFlexGeometry(file, geometry, 'frame', 17)).toBeNull()
    expect(file).toStrictEqual(beforeFile); expect(JSON.stringify(file)).toBe(fileBytes); expect(JSON.stringify(geometry)).toBe(rejectedBytes)
  })
})

describe('WRAP-08/09 strict selected-sibling geometry', () => {
  it('feeds only selected siblings to Wrap and returns a verified parent-padding inverse', () => {
    const file = paperFile()
    const geometry = paperGeometry()
    geometry.nodes.frame!.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const result = paperWrapGeometry(file, geometry, 'frame', ['b'], 8)
    expect(result?.input).toStrictEqual({
      containerSize: { width: 320, height: 240 },
      children: [{ id: 'b', worldAabb: { x: 85, y: 105, width: 30, height: 10 }, authoredPosition: { x: 130, y: 80 }, authoredSize: { width: 30, height: 10 }, parentLocalCenter: { x: 145, y: 85 }, sourcePosition: 'absolute' }],
      directAddLeadingInset: { x: 0, y: 0 }, kind: 'wrap', isRoot: false,
    })
    expect(result?.childSnapshots).toStrictEqual({
      b: {
        nodeId: 'b', kind: 'primitive', fromFamily: 'freeform', measured: { width: 30, height: 10 },
        sourceLayout: { item: { position: { mode: 'absolute', right: px(10), bottom: px(20) } } },
        sourcePosition: { mode: 'absolute', right: px(10), bottom: px(20) },
        axes: { width: { intent: 'fixed', measured: 30, fixedPx: 30 }, height: { intent: 'fixed', measured: 10, fixedPx: 10 } },
        primitiveSize: { width: 30, height: 10 },
      },
    })
    expect(apply(result!.worldToParentPadding, { x: 13, y: -7 })).toStrictEqual({ x: 13, y: -7 })
  })

  it('rejects stale, indirect, incomplete, and singular parent projections', () => {
    const file = paperFile()
    const candidates = [paperGeometry(), paperGeometry(), paperGeometry(), paperGeometry()]
    candidates[0]!.nodes.frame!.offsetParentToRoot = [1, 0, 0, 1, 0, 0]; candidates[0]!.nodes.a!.layoutGeneration = 7
    candidates[1]!.nodes.frame!.offsetParentToRoot = [1, 0, 0, 1, 0, 0]; candidates[1]!.nodes.a!.directChild = false
    candidates[2]!.nodes.frame!.offsetParentToRoot = [1, 0, 0, 1, 0, 0]; delete candidates[2]!.nodes.a!.offset
    candidates[3]!.nodes.frame!.offsetParentToRoot = [0, 0, 0, 0, 0, 0]
    for (const geometry of candidates) expect(paperWrapGeometry(file, geometry, 'frame', ['a'], 8)).toBeNull()
  })

  it('rejects root siblings whose source hosts do not share one verified projection', () => {
    const file: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'root-wrap', revision: 3, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: { root: { id: 'root', type: 'root' }, a: { id: 'a', type: 'rectangle', name: 'A', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 } }, b: { id: 'b', type: 'rectangle', name: 'B', styles: { relativeTransform: [1, 0, 0, 1, 20, 0], width: 10, height: 10 } } },
      relationships: { a: { parentId: 'root', orderKey: 'V' }, b: { parentId: 'root', orderKey: 'W' } }, theme: { tokens: {} },
    }
    const child = (id: 'a' | 'b', matrix: readonly [number, number, number, number, number, number]) => ({ canvasKind: 'rectangle' as const, documentRevision: 3, layoutGeneration: 8, rect: { x: id === 'a' ? 0 : 20, y: 0, width: 10, height: 10 }, worldAabb: { x: id === 'a' ? 0 : 20, y: 0, width: 10, height: 10 }, offset: { x: id === 'a' ? 0 : 20, y: 0, width: 10, height: 10, origin: { x: 5, y: 5 } }, offsetParentNodeId: null, offsetParentToRoot: matrix, directChild: true })
    const geometry: LayoutGeometry = { documentRevision: 3, layoutGeneration: 8, unsupported: {}, nodes: { a: child('a', [1, 0, 0, 1, 0, 0]), b: child('b', [1, 0, 0, 1, 1, 0]) } }
    expect(paperWrapGeometry(file, geometry, 'root', ['a', 'b'], 8)).toBeNull()
  })

  it('proves Component parent-instance identity for both root and frame Wrap parents', () => {
    const componentCase = (nested: boolean) => {
      const parentId = nested ? 'frame' : 'root'
      const file: FileDocument = {
        schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: `component-wrap-${parentId}`, revision: 5, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
        nodes: {
          root: { id: 'root', type: 'root' },
          ...(nested ? { frame: { id: 'frame', type: 'frame' as const, name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 200, height: 100 } } } : {}),
          card: { id: 'card', type: 'component', componentId: 'card-source', exportName: 'Card', props: {} },
        },
        relationships: {
          ...(nested ? { frame: { parentId: 'root', orderKey: 'V' } } : {}),
          card: { parentId, orderKey: 'W' },
        },
        theme: { tokens: {} },
      }
      const geometry: LayoutGeometry = {
        documentRevision: 5, layoutGeneration: 3, unsupported: {},
        nodes: {
          ...(nested ? { frame: { canvasKind: 'frame' as const, documentRevision: 5, layoutGeneration: 3, rect: { x: 0, y: 0, width: 200, height: 100 }, worldAabb: { x: 0, y: 0, width: 200, height: 100 }, offset: { x: 0, y: 0, width: 200, height: 100, origin: { x: 100, y: 50 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0] as const, directChild: true } } : {}),
          card: { componentId: 'card-source', documentRevision: 5, layoutGeneration: 3, rect: { x: 20, y: 10, width: 80, height: 40 }, worldAabb: { x: 20, y: 10, width: 80, height: 40 }, offset: { x: 20, y: 10, width: 80, height: 40, origin: { x: 40, y: 20 } }, offsetParentNodeId: nested ? 'frame' : null, ...(nested ? {} : { offsetParentToRoot: [1, 0, 0, 1, 0, 0] as const }), parentInstanceId: null, directChild: true },
        },
      }
      return { file, geometry, parentId }
    }

    for (const nested of [false, true]) {
      const { file, geometry, parentId } = componentCase(nested)
      const beforeFile = JSON.stringify(file), beforeGeometry = JSON.stringify(geometry)
      expect(paperWrapGeometry(file, geometry, parentId, ['card'], 3)?.childSnapshots.card?.kind).toBe('component')
      expect(JSON.stringify(file)).toBe(beforeFile)
      expect(JSON.stringify(geometry)).toBe(beforeGeometry)
      const missing = structuredClone(geometry); delete missing.nodes.card!.parentInstanceId
      expect(paperWrapGeometry(file, missing, parentId, ['card'], 3)).toBeNull()
      const wrong = structuredClone(geometry); wrong.nodes.card!.parentInstanceId = 'other-component'
      expect(paperWrapGeometry(file, wrong, parentId, ['card'], 3)).toBeNull()
    }
  })

  it('rejects duplicate selected identities before producing inference children or collapsed snapshots', () => {
    const file = paperFile(), geometry = paperGeometry()
    geometry.nodes.frame!.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const beforeFile = JSON.stringify(file), beforeGeometry = JSON.stringify(geometry)
    expect(paperWrapGeometry(file, geometry, 'frame', ['a', 'a'], 8)).toBeNull()
    expect(JSON.stringify(file)).toBe(beforeFile)
    expect(JSON.stringify(geometry)).toBe(beforeGeometry)
  })
})
