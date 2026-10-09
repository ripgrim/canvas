import { describe, expect, it } from 'vitest'
import type { Atom } from './types'
import type { ComponentNode, FileDocument } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'

// Layout commands on the document store: every multi-node edit is one batch and one undo entry, transient layout
// overrides never reach the file, and the stored records are hand-written v4 literals.
const atom = (name: string, componentId: string, props: Atom['props']): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props })
const atoms: Atom[] = [
  atom('Card', 'card-component', [{ name: 'children', type: 'ReactNode', optional: true }]),
  atom('Label', 'label-component', [{ name: 'children', type: 'ReactNode', optional: true }]),
]
const px = (value: number) => ({ kind: 'px' as const, value })
const percent = (value: number) => ({ kind: 'percent' as const, value })
const label = (id: string, text: string): ComponentNode => ({ id, type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: text } })
/** card (flex row container) holds a, b, c; d is an absolute root with width 200. */
const fixture = (): FileDocument => ({
  schemaVersion: 6, fileId: 'file-1', revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    a: label('a', 'A'), b: label('b', 'B'), c: label('c', 'C'),
    d: { ...label('d', 'D'), layout: { item: { position: { mode: 'absolute', left: px(40), top: px(60), right: px(4), zIndex: 2 }, width: { value: px(200) } } } },
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' },
    a: { parentId: 'card', orderKey: 'V', slot: 'children' }, b: { parentId: 'card', orderKey: 'W', slot: 'children' }, c: { parentId: 'card', orderKey: 'X', slot: 'children' },
    d: { parentId: 'root-1', orderKey: 'W' },
  },
  theme: { tokens: {} },
})
const loaded = () => { const store = createDocumentStore(() => 'unused'); store.load(fixture(), atoms); return store }
const layoutOf = (store: ReturnType<typeof createDocumentStore>, id: string) => (store.getSnapshot().file!.nodes[id] as ComponentNode).layout
const revision = (store: ReturnType<typeof createDocumentStore>) => store.getSnapshot().file!.revision

describe('LAY-SIZE-003 and LAY-BATCH-001: sizing across a selection', () => {
  it('stores one measured percent per node in one revision and undoes them together', () => {
    const store = loaded()
    expect(store.commands.layout.sizing('width', 'relative', [
      { id: 'a', layout: undefined, measurement: { measuredPx: 100, parentPx: 400 }, parentDirection: 'row' },
      { id: 'b', layout: undefined, measurement: { measuredPx: 300, parentPx: 400 }, parentDirection: 'row' },
      { id: 'c', layout: undefined, measurement: { measuredPx: 300 }, parentDirection: 'row' },
    ])).toBe(true)
    expect(revision(store)).toBe(1)
    // A definite main axis in a row Flex parent also stops the item shrinking.
    expect(layoutOf(store, 'a')).toEqual({ item: { position: { mode: 'flow' }, width: { value: percent(25) }, flex: { shrink: 0 } } })
    expect(layoutOf(store, 'b')).toEqual({ item: { position: { mode: 'flow' }, width: { value: percent(75) }, flex: { shrink: 0 } } })
    expect(layoutOf(store, 'c')).toBeUndefined()
    expect(store.getSnapshot().canUndo).toBe(true)
    store.undo()
    expect(revision(store)).toBe(0)
    expect(layoutOf(store, 'a')).toBeUndefined()
    expect(layoutOf(store, 'b')).toBeUndefined()
    expect(store.getSnapshot().canUndo).toBe(false)
  })
  it('a selection with nothing to change makes no revision', () => {
    const store = loaded()
    expect(store.commands.layout.sizing('width', 'calculate', [{ id: 'a', layout: undefined, measurement: {} }])).toBe(false)
    expect(store.commands.layout.sizing('width', 'relative', [{ id: 'c', layout: undefined, measurement: { measuredPx: 10 } }])).toBe(false)
    expect(store.commands.layout.sizing('height', 'fixed', [{ id: 'root-1', layout: undefined, measurement: { measuredPx: 10 } }])).toBe(false)
    expect(revision(store)).toBe(0)
  })
})

describe('LAY-GEST-004: positioning round trip', () => {
  it('absolute to flow drops insets and z-index, keeps the width, and flow to absolute restores a position from the measured local point, each as one undo step', () => {
    const store = loaded()
    expect(store.commands.layout.position('flow', [{ id: 'd' }])).toBe(true)
    expect(layoutOf(store, 'd')).toEqual({ item: { position: { mode: 'flow' }, width: { value: px(200) } } })
    expect(store.commands.layout.position('absolute', [{ id: 'd', local: { x: 12.4, y: 99.6 } }])).toBe(true)
    expect(layoutOf(store, 'd')).toEqual({ item: { position: { mode: 'absolute', left: px(12), top: px(100) }, width: { value: px(200) } } })
    expect(revision(store)).toBe(2)
    store.undo(); store.undo()
    expect(layoutOf(store, 'd')).toEqual({ item: { position: { mode: 'absolute', left: px(40), top: px(60), right: px(4), zIndex: 2 }, width: { value: px(200) } } })
    // Already in the requested mode: nothing is written.
    expect(store.commands.layout.position('absolute', [{ id: 'd', local: { x: 1, y: 1 } }])).toBe(false)
  })
  it('insets, z-index, bounds, aspect and spacing write one revision each and reject flow-only edits', () => {
    const store = loaded()
    expect(store.commands.layout.inset('bottom', percent(10), ['d'])).toBe(true)
    expect(layoutOf(store, 'd')!.item.position).toEqual({ mode: 'absolute', left: px(40), top: px(60), right: px(4), bottom: percent(10), zIndex: 2 })
    expect(store.commands.layout.inset('left', px(1), ['a'])).toBe(false)
    expect(store.commands.layout.zIndex(null, ['d'])).toBe(true)
    expect(layoutOf(store, 'd')!.item.position.zIndex).toBeUndefined()
    expect(store.commands.layout.bound('width', 'max', px(600), ['a', 'b'])).toBe(true)
    expect(layoutOf(store, 'a')!.item.width).toEqual({ value: { kind: 'auto' }, max: px(600) })
    expect(layoutOf(store, 'b')!.item.width).toEqual({ value: { kind: 'auto' }, max: px(600) })
    expect(store.commands.layout.aspectRatio(1.5, ['card'])).toBe(true)
    expect(layoutOf(store, 'card')!.item.aspectRatio).toBe(1.5)
    expect(layoutOf(store, 'card')!.container).toEqual({ display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } })
    expect(store.commands.layout.spacing({ padding: { x: 8, y: 4 }, margin: 'auto' }, ['card'])).toBe(true)
    expect(layoutOf(store, 'card')!.spacing).toEqual({ padding: { x: 8, y: 4 }, margin: 'auto' })
    expect(revision(store)).toBe(5)
  })
})

describe('LAY-GEST-003: reparent keeps the world pose from measurement', () => {
  const measured = (offset: { x: number; y: number }, offsetParentInstanceId: string | null) => ({ componentId: 'c', rect: { x: 0, y: 0, width: 10, height: 10 }, offset: { ...offset, width: 100, height: 40, origin: { x: 0, y: 0 } }, offsetParentInstanceId })
  it('moves a root under a card as one batch with the local insets from the measured chain and undoes in one step', () => {
    const store = loaded()
    // Host-relative offsets: card at (20, 30) with no border, d at (28, 39): the new local corner is (8, 9).
    const nodes = { card: measured({ x: 20, y: 30 }, null), d: measured({ x: 28, y: 39 }, null) }
    expect(store.commands.layout.reparent('d', { parentId: 'card', slot: 'children' }, nodes)).toBe(true)
    expect(revision(store)).toBe(1)
    expect(store.getSnapshot().file!.relationships.d).toMatchObject({ parentId: 'card', slot: 'children' })
    expect(layoutOf(store, 'd')).toEqual({ item: { position: { mode: 'absolute', left: px(8), top: px(9) }, width: { value: px(200) } } })
    store.undo()
    expect(revision(store)).toBe(0)
    expect(store.getSnapshot().file!.relationships.d).toEqual({ parentId: 'root-1', orderKey: 'W' })
    expect(layoutOf(store, 'd')!.item.position).toEqual({ mode: 'absolute', left: px(40), top: px(60), right: px(4), zIndex: 2 })
    // Without measurement nothing is written; a primitive target is refused.
    expect(store.commands.layout.reparent('d', { parentId: 'card', slot: 'children' }, {})).toBe(false)
    expect(store.commands.layout.reparent('d', { parentId: 'a' }, nodes)).toBe(false)
    expect(revision(store)).toBe(0)
  })
})

describe('LAY-GEST-001: transient layout never touches the file', () => {
  it('preview changes only the override state and the generation; cancel clears without a revision; commit writes one batch', () => {
    const store = loaded()
    const gesture = store.commands.layout.gesture
    expect(store.getSnapshot().layoutGeneration).toBe(0)
    gesture.begin()
    expect(store.getSnapshot().layoutGeneration).toBe(1)
    gesture.preview({ a: { item: { position: { mode: 'flow' }, width: { value: px(50) } } } })
    expect(store.getSnapshot().layoutOverrides).toEqual({ a: { item: { position: { mode: 'flow' }, width: { value: px(50) } } } })
    expect(layoutOf(store, 'a')).toBeUndefined()
    expect(revision(store)).toBe(0)
    gesture.cancel()
    expect(store.getSnapshot().layoutOverrides).toBeNull()
    expect(store.getSnapshot().layoutGeneration).toBe(2)
    expect(revision(store)).toBe(0)
    expect(store.getSnapshot().canUndo).toBe(false)
    // Preview without begin is ignored.
    gesture.preview({ a: { item: { position: { mode: 'flow' }, width: { value: px(50) } } } })
    expect(store.getSnapshot().layoutOverrides).toBeNull()
    gesture.begin()
    gesture.preview({ a: { item: { position: { mode: 'flow' }, width: { value: px(50) } } }, b: { item: { position: { mode: 'flow' }, width: { value: px(60) } } }, 'root-1': null })
    expect(gesture.commit()).toBe(true)
    expect(revision(store)).toBe(1)
    expect(layoutOf(store, 'a')!.item.width).toEqual({ value: px(50) })
    expect(layoutOf(store, 'b')!.item.width).toEqual({ value: px(60) })
    expect(store.getSnapshot().layoutOverrides).toBeNull()
    store.undo()
    expect(layoutOf(store, 'a')).toBeUndefined()
    expect(layoutOf(store, 'b')).toBeUndefined()
  })
})
