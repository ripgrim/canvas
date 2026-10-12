import { describe, expect, it } from 'vitest'
import type { Atom } from './types'
import { validateFileDocument } from '@canvas/repo-engine/file-document'
import type { ComponentNode, FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import type { FlexContainer, NodeLayout } from '@canvas/repo-engine/layout'
import type { FlexInferenceInput } from '@canvas/repo-engine/flex-inference'
import { snapshotPaperSizing } from '@canvas/repo-engine/paper-sizing'
import { createDocumentStore } from './document-store'
import { paperDirectAddGeometry, paperFlexInput } from './layout-measure'

// Flex and Block commands on the document store: conversions write the container, child patches and order as one
// revision and one undo entry; every expected record is a hand-written literal.
const atom = (name: string, componentId: string): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] })
const atoms: Atom[] = [atom('Card', 'card-component'), atom('Label', 'label-component')]
const px = (value: number) => ({ kind: 'px' as const, value })
const flow = { mode: 'flow' as const }
const label = (id: string, layout?: NodeLayout): ComponentNode => ({ id, type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: id }, ...(layout ? { layout } : {}) })
const card = (id: string, layout: NodeLayout): ComponentNode => ({ id, type: 'component', componentId: 'card-component', exportName: 'Card', props: {}, layout })
const flexLayout = (flex: FlexContainer, gap?: number): NodeLayout => ({ item: { position: flow }, container: { display: 'flex', flex, ...(gap !== undefined ? { gap } : {}) } })
/**
 * card: Flex column, gap 12, children a b c. row: Flex row (justify end, align center) with child r.
 * panel: Block with child p. frame: Freeform with absolute children f1 f2. d: a root label.
 */
const fixture = (cardFlex: FlexContainer = { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' }): FileDocument => ({
  schemaVersion: 9, fileId: 'file-1', revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: card('card', flexLayout(cardFlex, 12)),
    a: label('a', { item: { position: flow, flex: { grow: 1 } } }), b: label('b', { item: { position: flow, height: { value: px(40) } } }), c: label('c'),
    row: card('row', flexLayout({ direction: 'row', wrap: 'nowrap', justify: 'end', align: 'center' })),
    r: label('r'),
    panel: card('panel', { item: { position: flow }, container: { display: 'block' } }),
    p: label('p'),
    frame: card('frame', { item: { position: flow }, container: { display: 'freeform' } }),
    f1: label('f1', { item: { position: { mode: 'absolute', left: px(100), top: px(10), zIndex: 2 } } }),
    f2: label('f2', { item: { position: { mode: 'absolute', left: px(10), top: px(10) } } }),
    d: label('d'),
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' },
    a: { parentId: 'card', orderKey: 'V', slot: 'children' }, b: { parentId: 'card', orderKey: 'W', slot: 'children' }, c: { parentId: 'card', orderKey: 'X', slot: 'children' },
    row: { parentId: 'root-1', orderKey: 'W' }, r: { parentId: 'row', orderKey: 'V', slot: 'children' },
    panel: { parentId: 'root-1', orderKey: 'X' }, p: { parentId: 'panel', orderKey: 'V', slot: 'children' },
    frame: { parentId: 'root-1', orderKey: 'Y' }, f1: { parentId: 'frame', orderKey: 'V', slot: 'children' }, f2: { parentId: 'frame', orderKey: 'W', slot: 'children' },
    d: { parentId: 'root-1', orderKey: 'Z' },
  },
  theme: { tokens: {} },
})
const loaded = (file = fixture()) => { const store = createDocumentStore(() => 'unused'); store.load(file, atoms); return store }
type Store = ReturnType<typeof loaded>
const layoutOf = (store: Store, id: string) => (store.getSnapshot().file!.nodes[id] as ComponentNode).layout
const revision = (store: Store) => store.getSnapshot().file!.revision
/** Child ids of a parent sorted by their stored order keys (plain string order). */
const orderOf = (store: Store, parentId: string) => Object.entries(store.getSnapshot().file!.relationships).filter(([, relationship]) => relationship.parentId === parentId).sort((left, right) => (left[1].orderKey < right[1].orderKey ? -1 : left[1].orderKey > right[1].orderKey ? 1 : 0)).map(([id]) => id)
const margin12 = { margin: { top: 12, right: 0, bottom: 0, left: 0 } }
const textStyle = { fontFamily: 'Inter', fontStyle: 'normal' as const, fontWeight: 400, fontSize: 16, lineHeight: { kind: 'px' as const, value: 10 }, letterSpacing: 0, horizontalAlign: 'left' as const, verticalAlign: 'top' as const, case: 'none' as const, wrap: 'normal' as const, keepWords: false }
const analysisChild = (id: string, x: number, y: number, width: number, height: number) => ({ id, worldAabb: { x, y, width, height }, authoredPosition: { x, y }, authoredSize: { width, height }, parentLocalCenter: { x: x + width / 2, y: y + height / 2 }, sourcePosition: 'freeform' as const })
const directCapture = (file: FileDocument, containerId: string, input: FlexInferenceInput) => {
  const snapshot = (node: Exclude<FileNode, { type: 'root' }>, measured: { width: number; height: number }) => node.type === 'component'
    ? snapshotPaperSizing({ nodeId: node.id, kind: 'component', layout: node.layout ?? null, measured })
    : snapshotPaperSizing({ nodeId: node.id, kind: 'primitive', layout: node.layout ?? null, styles: { width: node.styles.width, height: node.styles.height }, measured })
  const parent = file.nodes[containerId]!
  if (parent.type === 'root') throw new Error('test container must not be root')
  return {
    input,
    parentSnapshot: snapshot(parent, input.containerSize),
    childSnapshots: Object.fromEntries(input.children.map(child => {
      const node = file.nodes[child.id]!
      if (node.type === 'root') throw new Error('test child must not be root')
      return [child.id, snapshot(node, child.authoredSize)]
    })),
  }
}

const primitiveFixture = (width = 100, height = 100, withChildren = false): FileDocument => ({
  schemaVersion: 9, fileId: 'primitive-file', revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width, height } },
    ...(withChildren ? {
      ordinary: { id: 'ordinary', type: 'rectangle' as const, name: 'Ordinary', styles: { left: 80, top: 10, width: 40, height: 20 } },
      pinned: { id: 'pinned', type: 'rectangle' as const, name: 'Pinned', styles: { left: 8, top: 4, width: 40, height: 20 }, layout: { item: { position: { mode: 'absolute' as const, left: px(8), right: { kind: 'percent' as const, value: 12 }, top: px(4), bottom: px(6), zIndex: 7 } } } },
    } : {}),
  },
  relationships: {
    frame: { parentId: 'root-1', orderKey: 'V' },
    ...(withChildren ? { ordinary: { parentId: 'frame', orderKey: 'V' }, pinned: { parentId: 'frame', orderKey: 'W' } } : {}),
  },
  theme: { tokens: {} },
})

describe('LAY-BLOCK-001 store: Flex to Block in one revision', () => {
  it('writes the Block container, child margins and cleared flex fields in one revision; one undo restores everything', () => {
    const store = loaded()
    expect(store.commands.layout.setDisplay('block', ['card'], {})).toBe(true)
    expect(revision(store)).toBe(1)
    expect(layoutOf(store, 'card')).toEqual({ item: { position: flow }, container: { display: 'block' } })
    expect(layoutOf(store, 'a')).toEqual({ item: { position: flow } })
    expect(layoutOf(store, 'b')).toEqual({ item: { position: flow, height: { value: px(40) } }, spacing: margin12 })
    expect(layoutOf(store, 'c')).toEqual({ item: { position: flow }, spacing: margin12 })
    expect(orderOf(store, 'card')).toEqual(['a', 'b', 'c'])
    store.undo()
    expect(revision(store)).toBe(2)
    expect(layoutOf(store, 'card')).toEqual(flexLayout({ direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' }, 12))
    expect(layoutOf(store, 'a')).toEqual({ item: { position: flow, flex: { grow: 1 } } })
    expect(layoutOf(store, 'c')).toBeUndefined()
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('column-reverse becomes the document order c b a, with margins on b and a, still one revision and one undo', () => {
    const store = loaded(fixture({ direction: 'column-reverse', wrap: 'nowrap', justify: 'start', align: 'start' }))
    expect(store.commands.layout.setDisplay('block', ['card'], {})).toBe(true)
    expect(revision(store)).toBe(1)
    expect(orderOf(store, 'card')).toEqual(['c', 'b', 'a'])
    expect(layoutOf(store, 'c')).toBeUndefined()
    expect(layoutOf(store, 'b')!.spacing).toEqual(margin12)
    expect(layoutOf(store, 'a')).toEqual({ item: { position: flow }, spacing: margin12 })
    store.undo()
    expect(orderOf(store, 'card')).toEqual(['a', 'b', 'c'])
    expect(layoutOf(store, 'a')).toEqual({ item: { position: flow, flex: { grow: 1 } } })
  })

  it('Freeform to Flex consumes the Paper analysis once, preserves explicit absolute children and writes one revision', () => {
    const store = loaded()
    // f2 sits left of f1 (x 10 vs 100) in a 300 x 60 frame, both 50 x 40 at y 10: a row, order f2 f1, gap 100 - 60 = 40.
    const input = {
        containerSize: { width: 300, height: 60 }, directAddLeadingInset: { x: 10, y: 10 }, kind: 'direct-add' as const, isRoot: false,
        children: [
          { id: 'f1', worldAabb: { x: 100, y: 10, width: 50, height: 40 }, authoredPosition: { x: 100, y: 10 }, authoredSize: { width: 50, height: 40 }, parentLocalCenter: { x: 125, y: 30 }, sourcePosition: 'absolute' as const },
          { id: 'f2', worldAabb: { x: 10, y: 10, width: 50, height: 40 }, authoredPosition: { x: 10, y: 10 }, authoredSize: { width: 50, height: 40 }, parentLocalCenter: { x: 35, y: 30 }, sourcePosition: 'absolute' as const },
        ],
      }
    const measured = { frame: { boxes: null, directAdd: directCapture(store.getSnapshot().file!, 'frame', input) } }
    const preview = store.commands.layout.displayConversion('flex', 'frame', measured.frame)
    expect(preview?.order).toEqual(['f2', 'f1'])
    expect(revision(store)).toBe(0)
    expect(store.commands.layout.setDisplay('flex', ['frame'], measured)).toBe(true)
    expect(revision(store)).toBe(1)
    expect(orderOf(store, 'frame')).toEqual(['f2', 'f1'])
    expect(layoutOf(store, 'f1')).toEqual({ item: { position: { mode: 'absolute', left: px(100), top: px(10), zIndex: 2 }, width: { value: { kind: 'auto' } }, height: { value: { kind: 'auto' } } } })
    expect(layoutOf(store, 'f2')).toEqual({ item: { position: { mode: 'absolute', left: px(10), top: px(10) }, width: { value: { kind: 'auto' } }, height: { value: { kind: 'auto' } } } })
    expect(layoutOf(store, 'frame')!.container).toMatchObject({ display: 'flex', gap: 40, flex: { direction: 'row' } })
  })
})

describe('PAPER-FLEX-001/002 direct Add', () => {
  it('adds Flex to an empty primitive frame with Paper defaults in one revision and one undo', () => {
    const file = primitiveFixture(100, 100)
    const store = createDocumentStore(() => 'unused')
    store.load(file, [])
    const geometry = { nodes: {}, unsupported: {}, documentRevision: file.revision, layoutGeneration: store.getSnapshot().layoutGeneration }
    const directAdd = paperDirectAddGeometry(file, geometry, 'frame', store.getSnapshot().layoutGeneration)
    expect(directAdd).not.toBeNull()
    expect(store.commands.layout.setDisplay('flex', ['frame'], { frame: { boxes: null, directAdd } })).toBe(true)
    expect(revision(store)).toBe(1)
    expect(layoutOf(store, 'frame')).toEqual({ item: { position: { mode: 'freeform' }, height: { value: { kind: 'intrinsic', value: 'fit-content' } } }, container: { display: 'flex', gap: 16, flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } }, spacing: { padding: { x: 16, y: 16 } } })
    store.undo()
    expect(revision(store)).toBe(2)
    expect(layoutOf(store, 'frame')).toBeUndefined()
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('switches a primitive Flex frame between Fit and measured Fixed in one undo step each', () => {
    const file = primitiveFixture(100, 100)
    const sourceFrame = file.nodes.frame!
    if (sourceFrame.type !== 'frame') throw new Error('fixture frame is missing')
    sourceFrame.layout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } }
    const store = createDocumentStore(() => 'unused')
    store.load(file, [])

    expect(store.commands.layout.primitiveSizing('width', 'hug', [{ id: 'frame', measuredPx: 100 }])).toBe(true)
    expect((store.getSnapshot().file!.nodes.frame as Exclude<FileNode, { type: 'root' | 'component' }>).layout?.item.width).toEqual({ value: { kind: 'intrinsic', value: 'fit-content' } })
    expect(revision(store)).toBe(1)

    expect(store.commands.layout.primitiveSizing('width', 'fixed', [{ id: 'frame', measuredPx: 240 }])).toBe(true)
    const fixed = store.getSnapshot().file!.nodes.frame as Exclude<FileNode, { type: 'root' | 'component' }>
    expect(fixed.layout?.item.width).toBeUndefined()
    expect(fixed.styles.width).toBe(240)
    expect(revision(store)).toBe(2)
    store.undo()
    expect((store.getSnapshot().file!.nodes.frame as Exclude<FileNode, { type: 'root' | 'component' }>).layout?.item.width).toEqual({ value: { kind: 'intrinsic', value: 'fit-content' } })
  })

  it('uses the analyzer order for ordinary children and preserves complete absolute placement', () => {
    const file = primitiveFixture(200, 100, true)
    const store = createDocumentStore(() => 'unused')
    store.load(file, [])
    const input = {
      containerSize: { width: 200, height: 100 }, directAddLeadingInset: { x: 8, y: 4 }, kind: 'direct-add' as const, isRoot: false,
      children: [
        { id: 'ordinary', worldAabb: { x: 80, y: 10, width: 40, height: 20 }, authoredPosition: { x: 80, y: 10 }, authoredSize: { width: 40, height: 20 }, parentLocalCenter: { x: 100, y: 20 }, sourcePosition: 'freeform' as const },
        { id: 'pinned', worldAabb: { x: 8, y: 4, width: 40, height: 20 }, authoredPosition: { x: 8, y: 4 }, authoredSize: { width: 40, height: 20 }, parentLocalCenter: { x: 28, y: 14 }, sourcePosition: 'absolute' as const },
      ],
    }
    expect(store.commands.layout.setDisplay('flex', ['frame'], { frame: { boxes: null, directAdd: directCapture(file, 'frame', input) } })).toBe(true)
    expect(orderOf(store, 'frame')).toEqual(['pinned', 'ordinary'])
    expect(layoutOf(store, 'ordinary')).toEqual({ item: { position: flow } })
    expect(layoutOf(store, 'pinned')).toEqual({ item: { position: { mode: 'absolute', left: px(8), right: { kind: 'percent', value: 12 }, top: px(4), bottom: px(6), zIndex: 7 } } })
    expect(revision(store)).toBe(1)
  })

  it('keeps stale or missing projection input observable and non-mutating', () => {
    const file = primitiveFixture(200, 100, true)
    const store = createDocumentStore(() => 'unused')
    store.load(file, [])
    const stale = { nodes: {}, unsupported: {}, documentRevision: file.revision - 1, layoutGeneration: store.getSnapshot().layoutGeneration }
    const missing = { nodes: {}, unsupported: {}, documentRevision: file.revision, layoutGeneration: null }
    for (const geometry of [stale, missing]) {
      const flexInput = paperFlexInput(file, geometry, 'frame', 'direct-add', store.getSnapshot().layoutGeneration)
      expect(flexInput).toBeNull()
      const measurement = { boxes: null, flexInput }
      expect(store.commands.layout.displayConversion('flex', 'frame', measurement)).toEqual({ layouts: {}, unsupported: 'Some children have no measured position' })
      expect(store.commands.layout.setDisplay('flex', ['frame'], { frame: measurement })).toBe(false)
    }
    expect(revision(store)).toBe(0)
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('writes row multiline text layout, primitive fallback, and text sizing in one valid reversible batch without mutating the captured input', () => {
    const source: FileDocument = {
      schemaVersion: 9, fileId: 'text-add', revision: 0,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 200, height: 100 } },
        text: { id: 'text', type: 'text', name: 'Text', text: 'Two lines', styles: { left: 10, top: 10, width: 80, height: 40 }, textStyle, textSizing: { width: { mode: 'fit' }, height: { mode: 'fixed' } } },
      },
      relationships: { frame: { parentId: 'root-1', orderKey: 'V' }, text: { parentId: 'frame', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    const input: FlexInferenceInput = { containerSize: { width: 200, height: 100 }, directAddLeadingInset: { x: 10, y: 10 }, kind: 'direct-add', isRoot: false, children: [analysisChild('text', 10, 10, 40, 40)] }
    const capture = {
      input,
      parentSnapshot: snapshotPaperSizing({ nodeId: 'frame', kind: 'primitive', layout: null, styles: { width: 200, height: 100 }, measured: { width: 200, height: 100 } }),
      childSnapshots: {
        text: snapshotPaperSizing({ nodeId: 'text', kind: 'text', layout: null, styles: { width: 80, height: 40 }, textStyle, textSizing: { width: { mode: 'fit' }, height: { mode: 'fixed' } }, measured: { width: 40, height: 40 }, resolvedLineHeight: 10, editable: true }),
      },
    }
    const beforeCapture = JSON.stringify(capture)
    const beforeFile = structuredClone(source)
    const store = createDocumentStore(() => 'unused')
    store.load(source, [])
    expect(store.commands.layout.setDisplay('flex', ['frame'], { frame: { boxes: null, directAdd: capture } })).toBe(true)
    expect(JSON.stringify(capture)).toBe(beforeCapture)
    expect(revision(store)).toBe(1)
    expect(store.getSnapshot().canUndo).toBe(true)
    expect(store.getSnapshot().file?.nodes.text).toEqual({
      id: 'text', type: 'text', name: 'Text', text: 'Two lines',
      styles: { left: 10, top: 10, width: 40, height: 40 },
      layout: { item: { position: flow } },
      textStyle,
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
    })
    expect(() => validateFileDocument(store.getSnapshot().file, [])).not.toThrow()
    expect(store.undo()).toBe(true)
    expect(store.getSnapshot().file).toEqual({ ...beforeFile, revision: 2 })
    expect(store.getSnapshot().canUndo).toBe(false)
  })
})

describe('LAY-FLEX-002 store: direction switch keeps the anchor', () => {
  it('row end/center becomes column center/end and back; a reverse within the family keeps both', () => {
    const store = loaded()
    expect(store.commands.layout.setDirection('column', ['row'])).toBe(true)
    expect(layoutOf(store, 'row')!.container!.flex).toEqual({ direction: 'column', wrap: 'nowrap', justify: 'center', align: 'end' })
    expect(store.commands.layout.setDirection('row-reverse', ['row'])).toBe(true)
    expect(layoutOf(store, 'row')!.container!.flex).toEqual({ direction: 'row-reverse', wrap: 'nowrap', justify: 'end', align: 'center' })
    expect(store.commands.layout.setDirection('row', ['row'])).toBe(true)
    expect(layoutOf(store, 'row')!.container!.flex).toEqual({ direction: 'row', wrap: 'nowrap', justify: 'end', align: 'center' })
    expect(revision(store)).toBe(3)
  })

  it('space distributions stay on the main axis; stretch cannot become a main position and baseline has no column cross axis', () => {
    const store = loaded()
    store.commands.layout.setAlignment({ justify: 'space-between', align: 'end' }, ['row'])
    store.commands.layout.setDirection('column', ['row'])
    expect(layoutOf(store, 'row')!.container!.flex).toMatchObject({ justify: 'space-between', align: 'end' })
    store.commands.layout.setDirection('row', ['row'])
    store.commands.layout.setAlignment({ justify: 'center', align: 'stretch' }, ['row'])
    store.commands.layout.setDirection('column', ['row'])
    expect(layoutOf(store, 'row')!.container!.flex).toMatchObject({ justify: 'start', align: 'center' })
    store.commands.layout.setDirection('row', ['row'])
    store.commands.layout.setAlignment({ justify: 'space-around', align: 'baseline' }, ['row'])
    store.commands.layout.setDirection('column', ['row'])
    expect(layoutOf(store, 'row')!.container!.flex).toMatchObject({ justify: 'space-around', align: 'start' })
  })

  it('negative control: setAlignment alone does not swap anything', () => {
    const store = loaded()
    store.commands.layout.setAlignment({ align: 'end' }, ['row'])
    expect(layoutOf(store, 'row')!.container!.flex).toEqual({ direction: 'row', wrap: 'nowrap', justify: 'end', align: 'end' })
  })
})

describe('LAY-FLEX-003 store: gaps, wrap, align-content, overflow', () => {
  it('stores an independent x/y gap, clears it with null, and leaves a Block container alone', () => {
    const store = loaded()
    expect(store.commands.layout.setGap({ x: 8, y: 20 }, ['card', 'panel'])).toBe(true)
    expect(layoutOf(store, 'card')!.container!.gap).toEqual({ x: 8, y: 20 })
    expect(layoutOf(store, 'panel')).toEqual({ item: { position: flow }, container: { display: 'block' } })
    expect(store.commands.layout.setGap(null, ['card'])).toBe(true)
    expect(layoutOf(store, 'card')!.container).toEqual({ display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } })
    expect(store.commands.layout.setGap(-1, ['card'])).toBe(false)
    expect(revision(store)).toBe(2)
  })

  it('wrap, align-content and overflow write one revision each across a selection', () => {
    const store = loaded()
    expect(store.commands.layout.setWrap('wrap-reverse', ['card', 'row'])).toBe(true)
    expect(revision(store)).toBe(1)
    expect(layoutOf(store, 'card')!.container!.flex!.wrap).toBe('wrap-reverse')
    expect(layoutOf(store, 'row')!.container!.flex!.wrap).toBe('wrap-reverse')
    expect(store.commands.layout.setAlignContent('space-between', ['card'])).toBe(true)
    expect(layoutOf(store, 'card')!.container!.flex!.alignContent).toBe('space-between')
    expect(store.commands.layout.setAlignContent(null, ['card'])).toBe(true)
    expect(layoutOf(store, 'card')!.container!.flex).toEqual({ direction: 'column', wrap: 'wrap-reverse', justify: 'start', align: 'start' })
    expect(store.commands.layout.setOverflow('hidden', ['panel'])).toBe(true)
    expect(layoutOf(store, 'panel')!.container).toEqual({ display: 'block', overflow: 'hidden' })
    expect(revision(store)).toBe(4)
  })
})

describe('child flex fields', () => {
  it('setItemFlex writes children of Flex parents only, in one revision, and null clears', () => {
    const store = loaded()
    expect(store.commands.layout.setItemFlex({ grow: 2, shrink: 0, basis: px(0) }, ['b', 'r', 'p', 'd'])).toBe(true)
    expect(revision(store)).toBe(1)
    expect(layoutOf(store, 'b')).toEqual({ item: { position: flow, height: { value: px(40) }, flex: { grow: 2, shrink: 0, basis: px(0) } } })
    expect(layoutOf(store, 'r')).toEqual({ item: { position: flow, flex: { grow: 2, shrink: 0, basis: px(0) } } })
    // p has a Block parent and d sits on the page root: both skipped.
    expect(layoutOf(store, 'p')).toBeUndefined()
    expect(layoutOf(store, 'd')).toBeUndefined()
    expect(store.commands.layout.setItemFlex(null, ['r'])).toBe(true)
    expect(layoutOf(store, 'r')).toEqual({ item: { position: flow } })
  })

  it('a selection of only non-Flex children writes nothing', () => {
    const store = loaded()
    expect(store.commands.layout.setItemFlex({ grow: 1 }, ['p', 'd'])).toBe(false)
    expect(revision(store)).toBe(0)
  })
})

describe('no-op calls return false and make no revision', () => {
  it('same display, same wrap, same alignment, same direction, non-Flex targets, clearing what is absent', () => {
    const store = loaded()
    expect(store.commands.layout.setDisplay('flex', ['card'], {})).toBe(false)
    expect(store.commands.layout.setDisplay('block', ['panel'], {})).toBe(false)
    expect(store.commands.layout.setWrap('nowrap', ['card'])).toBe(false)
    expect(store.commands.layout.setAlignment({ justify: 'start', align: 'start' }, ['card'])).toBe(false)
    expect(store.commands.layout.setDirection('column', ['card'])).toBe(false)
    expect(store.commands.layout.setDirection('row', ['panel', 'd'])).toBe(false)
    expect(store.commands.layout.setAlignContent(null, ['card'])).toBe(false)
    expect(store.commands.layout.setOverflow(null, ['card'])).toBe(false)
    expect(store.commands.layout.setItemFlex(null, ['c'])).toBe(false)
    expect(store.commands.layout.setGap(12, ['card'])).toBe(false)
    expect(revision(store)).toBe(0)
    expect(store.getSnapshot().canUndo).toBe(false)
  })
})
