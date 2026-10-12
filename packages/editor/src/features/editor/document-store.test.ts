import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Atom } from './types'
import type { Appearance, FileDocument, Paint, Stroke } from '@canvas/repo-engine/file-document'
import type { ImageAssetReference } from '@canvas/repo-engine/appearance'
import { childrenOf, nodeAppearance, nodeIsLocked, worldPosition } from '@canvas/repo-engine/file-document'
import { componentDefaultProps, componentInsertionPoint, createDocumentStore } from './document-store'
import type { Scene } from './canvas-scene'
import type { EditorPersistenceIntent } from '../../capabilities'

const atom = (name: string, componentId: string, props: Atom['props']): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props })
const atoms: Atom[] = [
  atom('Card', 'card-component', [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'heading', type: 'ReactNode', optional: true }, { name: 'footer', type: 'ReactNode', optional: true }]),
  atom('Label', 'label-component', [{ name: 'children', type: 'ReactNode', optional: true }]),
]
const hex = (value: string) => ({ kind: 'literal' as const, color: { kind: 'hex' as const, hex: value } })
const solid = (id: string, value: string) => ({ id, type: 'solid' as const, color: hex(value) })
const label = (id: string, text: string) => ({ id, type: 'component' as const, componentId: 'label-component', exportName: 'Label', props: { children: text } })

/**
 * Page 1: outer (100,50 400x300) > inner (20,30 200x100); box (600,400 50x40); card with three Labels in `children`
 * and one in `footer`. Page 2: other (0,0 80x80). Every primitive has one solid fill named `<id>-fill`.
 */
const fixture = (): FileDocument => ({
  schemaVersion: 7, fileId: 'file-1', revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    outer: { id: 'outer', type: 'frame', name: 'Outer', styles: { left: 100, top: 50, width: 400, height: 300, overflow: 'clip' }, appearance: { fills: [solid('outer-fill', '#ffffff')] } },
    inner: { id: 'inner', type: 'frame', name: 'Inner', styles: { left: 20, top: 30, width: 200, height: 100, overflow: 'clip' }, appearance: { fills: [solid('inner-fill', '#ffffff')] } },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 600, top: 400, width: 50, height: 40 }, appearance: { fills: [solid('box-fill', '#d9d9d9')] } },
    card: { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {} },
    label: label('label', 'Email'),
    hint: label('hint', 'Password'),
    note: label('note', 'Forgot'),
    'footer-label': label('footer-label', 'Footer'),
    other: { id: 'other', type: 'frame', name: 'Other', styles: { left: 0, top: 0, width: 80, height: 80, overflow: 'clip' }, appearance: { fills: [solid('other-fill', '#ffffff')] } },
  },
  relationships: {
    outer: { parentId: 'root-1', orderKey: 'V' },
    inner: { parentId: 'outer', orderKey: 'V' },
    box: { parentId: 'root-1', orderKey: 'W' },
    card: { parentId: 'root-1', orderKey: 'X' },
    label: { parentId: 'card', orderKey: 'V', slot: 'children' },
    hint: { parentId: 'card', orderKey: 'W', slot: 'children' },
    note: { parentId: 'card', orderKey: 'X', slot: 'children' },
    'footer-label': { parentId: 'card', orderKey: 'Y', slot: 'footer' },
    other: { parentId: 'root-2', orderKey: 'V' },
  },
  theme: { tokens: {} },
})
const pageOneOrder = ['outer', 'inner', 'box', 'card', 'label', 'hint', 'note', 'footer-label']
const loaded = (settings?: { pageId?: string }) => { let id = 0; const store = createDocumentStore(() => `new-${++id}`); store.load(fixture(), atoms, settings); return store }
const file = (store: ReturnType<typeof createDocumentStore>) => store.getSnapshot().file!
const styles = (store: ReturnType<typeof createDocumentStore>, id: string) => { const node = file(store).nodes[id]; if (!node || node.type === 'root' || node.type === 'component') throw new Error(`${id} is not a primitive`); return node.styles }
const key = (name: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key: name, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers })
const settled = (store: ReturnType<typeof createDocumentStore>) => vi.waitFor(() => expect(store.getSnapshot().saving).toBe(false))
const appearanceOf = (store: ReturnType<typeof createDocumentStore>, id: string) => nodeAppearance(file(store).nodes[id])
const fillsOf = (store: ReturnType<typeof createDocumentStore>, id: string) => appearanceOf(store, id)?.fills
const onePixelPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0xda, 0x63, 0x64, 0x60, 0xf8, 0x5f, 0x0f, 0x00, 0x02, 0x87, 0x01, 0x80, 0xeb, 0x47, 0xba, 0x92, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])
const onePixelPreview = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('AT-CAN file loading and pages', () => {
  it('opens the requested page, falling back to the first page for unknown ids', () => {
    expect(loaded().getSnapshot().pageId).toBe('page-1')
    expect(loaded({ pageId: 'page-2' }).getSnapshot().pageId).toBe('page-2')
    expect(loaded({ pageId: 'page-404' }).getSnapshot().pageId).toBe('page-1')
    const store = loaded()
    expect(file(store).fileId).toBe('file-1')
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('switches pages as a view change: selection clears, onPageChange fires, history is untouched', () => {
    const store = loaded()
    const onPageChange = vi.fn()
    const onSelection = vi.fn()
    const onChange = vi.fn()
    store.configure({ onPageChange, onSelection, onChange })
    store.select('box')
    expect(store.getSnapshot().selection).toEqual(['box'])
    const before = file(store)
    expect(store.setPage('page-2')).toBe(true)
    expect(store.getSnapshot().pageId).toBe('page-2')
    expect(store.getSnapshot().selection).toEqual([])
    expect(onPageChange.mock.calls).toEqual([['page-2']])
    expect(onSelection.mock.calls.at(-1)).toEqual([[]])
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().dirty).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(store.setPage('page-2')).toBe(false)
    expect(store.setPage('page-404')).toBe(false)
    expect(onPageChange).toHaveBeenCalledTimes(1)
    // Selection is page scoped: a node on another page cannot be selected.
    store.select('box')
    expect(store.getSnapshot().selection).toEqual([])
    store.select('other')
    expect(store.getSnapshot().selection).toEqual(['other'])
  })

  it('UI-COLLAB-READONLY-001 keeps view controls active while rejecting semantic edits and history', () => {
    const store = loaded()
    store.setReadOnly(true)
    expect(store.getSnapshot().readOnly).toBe(true)
    expect(store.commands.rename('box', 'Changed')).toBe(false)
    expect(file(store).nodes.box).toMatchObject({ name: 'Box' })
    expect(store.undo()).toBe(false)
    expect(store.setPage('page-2')).toBe(true)
    store.setViewport({ x: 30, y: 40, zoom: 1.5 })
    expect(store.getSnapshot()).toMatchObject({ pageId: 'page-2', viewport: { x: 30, y: 40, zoom: 1.5 }, dirty: false })
    store.setReadOnly(false)
    expect(store.commands.rename('other', 'Changed')).toBe(true)
  })

  it('AT-CAN-001 locks pointer manipulation without blocking inspector commands', () => {
    const store = loaded()
    expect(store.commands.setLocked('outer', true)).toBe(true)
    expect(nodeIsLocked(file(store), 'outer')).toBe(true)
    expect(nodeIsLocked(file(store), 'inner')).toBe(true)
    expect(store.commands.setStyles('outer', { left: 125, width: 420 })).toBe(true)
    expect(styles(store, 'outer')).toMatchObject({ left: 125, width: 420 })
    expect(store.commands.rename('outer', 'Locked frame')).toBe(true)
    expect(file(store).nodes.outer).toMatchObject({ name: 'Locked frame', isLocked: true })
  })

  it('creates, renames, duplicates, reorders, and deletes pages with page-scoped undo', () => {
    const store = loaded()
    const created = store.commands.createPage()
    expect(created).toBe('new-1')
    expect(file(store).pages.map(page => [page.id, page.name, page.rootNodeId])).toEqual([['page-1', 'Page 1', 'root-1'], ['page-2', 'Page 2', 'root-2'], ['new-1', 'Page 3', 'new-2']])
    expect(store.getSnapshot().pageId).toBe('new-1')
    expect(store.commands.renamePage('new-1', '  Drafts  ')).toBe(true)
    expect(file(store).pages[2]!.name).toBe('Drafts')
    expect(store.commands.renamePage('new-1', '   ')).toBe(false)
    const copy = store.commands.duplicatePage('page-2')
    // Ids are drawn for the copied `other` frame first, then the page and its root.
    expect(copy).toBe('new-4')
    expect(file(store).pages.map(page => page.name)).toEqual(['Page 1', 'Page 2', 'Page 2 copy', 'Drafts'])
    expect(file(store).nodes['new-3']).toMatchObject({ type: 'frame', name: 'Other' })
    expect(file(store).relationships['new-3']!.parentId).toBe('new-5')
    expect(file(store).relationships.other!.parentId).toBe('root-2')
    expect(store.commands.reorderPage('new-1', 0)).toBe(true)
    expect(file(store).pages.map(page => page.id)).toEqual(['new-1', 'page-1', 'page-2', 'new-4'])
    store.setPage('page-2')
    expect(store.commands.deletePage('page-2')).toBe(true)
    expect(file(store).pages.map(page => page.id)).toEqual(['new-1', 'page-1', 'new-4'])
    expect(file(store).nodes.other).toBeUndefined()
    expect(store.getSnapshot().pageId).toBe('page-1')
    store.undo()
    expect(file(store).nodes.other).toBeDefined()
    expect(store.getSnapshot().pageId).toBe('page-2')
  })

  it('sets and undoes a page background while duplicated pages retain it', () => {
    const store = loaded()
    expect(store.commands.setPageBackground('page-2', hex('#123456'))).toBe(true)
    expect(file(store).pages[1]!.background).toEqual(hex('#123456'))
    const copy = store.commands.duplicatePage('page-2')
    expect(copy).toBe('new-2')
    expect(file(store).pages.find(page => page.id === copy)!.background).toEqual(hex('#123456'))
    store.undo()
    expect(file(store).pages.map(page => page.id)).toEqual(['page-1', 'page-2'])
    store.undo()
    expect(file(store).pages[1]).not.toHaveProperty('background')
  })

  it('never deletes the last page', () => {
    const store = loaded()
    expect(store.commands.deletePage('page-2')).toBe(true)
    expect(store.commands.deletePage('page-1')).toBe(false)
    expect(file(store).pages.map(page => page.id)).toEqual(['page-1'])
  })
})

describe('AT-REPO-TOKEN-002 repository token import', () => {
  it('imports source tokens atomically, skips existing properties, and undoes the batch once', () => {
    const store = loaded()
    expect(store.commands.theme.importSourceTokens([
      { property: '--background', name: 'Background', fallback: { kind: 'hex', hex: '#ffffff' } },
      { property: '--accent', name: 'Accent', fallback: { kind: 'oklch', l: 0.6, c: 0.2, h: 300 } },
      { property: '--accent', name: 'Duplicate accent', fallback: { kind: 'hex', hex: '#000000' } },
    ])).toBe(2)
    expect(Object.values(file(store).theme.tokens).map(token => ({ name: token.name, value: token.value }))).toEqual([
      { name: 'Background', value: { kind: 'source', property: '--background', fallback: { kind: 'hex', hex: '#ffffff' } } },
      { name: 'Accent', value: { kind: 'source', property: '--accent', fallback: { kind: 'oklch', l: 0.6, c: 0.2, h: 300 } } },
    ])
    expect(store.commands.theme.importSourceTokens([{ property: '--accent', name: 'Accent', fallback: { kind: 'hex', hex: '#000000' } }])).toBe(0)
    store.undo()
    expect(file(store).theme.tokens).toEqual({})
  })
})

describe('AT-CAN primitive canvas commands', () => {
  it('draws a frame under the page root with a white literal fill and selects it', () => {
    const store = loaded()
    expect(store.commands.insertCanvas('frame', { x: 10, y: 20 })).toBe(true)
    // The node takes the first id, its seeded fill the second.
    expect(file(store).nodes['new-1']).toEqual({ id: 'new-1', type: 'frame', name: 'Frame', styles: { left: 10, top: 20, width: 320, height: 240, overflow: 'clip' }, appearance: { fills: [{ id: 'new-2', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }] }, themeMode: 'inherit' })
    expect(file(store).relationships['new-1']!.parentId).toBe('root-1')
    expect(childrenOf(file(store), 'root-1')).toEqual(['outer', 'box', 'card', 'new-1'])
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(file(store).revision).toBe(1)
    expect(store.getSnapshot().dirty).toBe(true)
  })

  it('draws a rectangle inside a frame with rounded local bounds and a white literal fill', () => {
    const store = loaded()
    expect(store.commands.insertCanvas('rectangle', { x: 5.4, y: 6.6, width: 99.6, height: 0.2, parentId: 'outer' })).toBe(true)
    expect(file(store).nodes['new-1']).toEqual({ id: 'new-1', type: 'rectangle', name: 'Rectangle', styles: { left: 5, top: 7, width: 100, height: 1 }, appearance: { fills: [{ id: 'new-2', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }] }, themeMode: 'inherit' })
    expect(file(store).relationships['new-1']!.parentId).toBe('outer')
    expect(Object.keys(file(store).theme.tokens)).toEqual([])
  })

  it('seeds a click-created rectangle at 500 x 500 white while a frame keeps 320 x 240', () => {
    const store = loaded()
    expect(store.commands.insertCanvas('rectangle', { x: 40, y: 60 })).toBe(true)
    expect(file(store).nodes['new-1']).toEqual({ id: 'new-1', type: 'rectangle', name: 'Rectangle', styles: { left: 40, top: 60, width: 500, height: 500 }, appearance: { fills: [{ id: 'new-2', type: 'solid', color: hex('#ffffff') }] }, themeMode: 'inherit' })
    expect(store.commands.insertCanvas('frame', { x: 0, y: 0 })).toBe(true)
    expect(styles(store, 'new-3')).toEqual({ left: 0, top: 0, width: 320, height: 240, overflow: 'clip' })
    expect(fillsOf(store, 'new-3')).toEqual([{ id: 'new-4', type: 'solid', color: hex('#ffffff') }])
  })

  it('seeds shape, shader, and text defaults with an identity on every fill and gradient stop', () => {
    const store = loaded()
    store.commands.insertCanvas('shape', { x: 0, y: 0 })
    expect(fillsOf(store, 'new-1')).toEqual([{ id: 'new-2', type: 'solid', color: hex('#d9d9d9') }])
    store.commands.insertCanvas('shader', { x: 0, y: 0 })
    // Fill id first, then the two stops in order.
    expect(fillsOf(store, 'new-3')).toEqual([{ id: 'new-4', type: 'gradient', shape: 'linear', angle: 135, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ id: 'new-5', position: 0, color: hex('#685fff') }, { id: 'new-6', position: 1, color: hex('#202124') }] }])
    store.commands.insertCanvas('text', { x: 0, y: 0 })
    expect(file(store).nodes['new-7']).toMatchObject({ type: 'text', text: 'Text', appearance: { fills: [{ id: 'new-8', type: 'solid', color: hex('#202124') }] } })
  })

  it('commits a move into a nested frame keeping the world position, and back out to the page', () => {
    const store = loaded()
    // inner sits at world (100 + 20, 50 + 30) = (120, 80); dropping box at world (150, 110) makes it local (30, 30).
    expect(store.commands.commitMove([{ id: 'box', x: 150, y: 110, parentId: 'inner' }]).committed).toBe(true)
    expect(file(store).relationships.box!.parentId).toBe('inner')
    expect(styles(store, 'box')).toEqual({ left: 30, top: 30, width: 50, height: 40 })
    expect(worldPosition(file(store), 'box')).toEqual({ x: 150, y: 110 })
    expect(store.commands.commitMove([{ id: 'box', x: 700, y: 20, parentId: null }]).committed).toBe(true)
    expect(file(store).relationships.box!.parentId).toBe('root-1')
    expect(styles(store, 'box')).toMatchObject({ left: 700, top: 20 })
    store.undo()
    expect(file(store).relationships.box!.parentId).toBe('inner')
    expect(styles(store, 'box')).toMatchObject({ left: 30, top: 30 })
  })

  it('refuses to move a primitive into a component instance', () => {
    const store = loaded()
    const before = file(store)
    expect(store.commands.commitMove([{ id: 'box', x: 0, y: 0, parentId: 'card' }]).committed).toBe(false)
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('reparents a primitive while preserving its world position', () => {
    const store = loaded()
    // box world (600, 400) minus inner world (120, 80).
    expect(store.commands.reparent('box', 'inner')).toBe(true)
    expect(styles(store, 'box')).toMatchObject({ left: 480, top: 320 })
    expect(store.commands.reparent('box', 'card')).toBe(false)
    expect(store.commands.reparent('card', 'outer')).toBe(false)
  })

  it('commits a resize in world geometry as parent-local styles', () => {
    const store = loaded()
    expect(store.commands.commitResize('box', { x: 10.4, y: 20.6, width: 70.5, height: 0.3 }).committed).toBe(true)
    expect(styles(store, 'box')).toEqual({ left: 10, top: 21, width: 71, height: 1 })
    // outer sits at world (100, 50).
    expect(store.commands.commitResize('inner', { x: 130, y: 90, width: 50, height: 60 }).committed).toBe(true)
    expect(styles(store, 'inner')).toEqual({ left: 30, top: 40, width: 50, height: 60, overflow: 'clip' })
  })

  it('AT-CAN-006 holds direct freeform children in world space during a Mod resize and undoes once', () => {
    const store = loaded()
    expect(worldPosition(file(store), 'inner')).toEqual({ x: 120, y: 80 })
    expect(store.commands.commitResize('outer', { x: 80, y: 40, width: 440, height: 320 }, undefined, true, { x: 100, y: 50, width: 400, height: 300 }).committed).toBe(true)
    expect(styles(store, 'outer')).toMatchObject({ left: 80, top: 40, width: 440, height: 320 })
    expect(styles(store, 'inner')).toMatchObject({ left: 40, top: 40 })
    expect(worldPosition(file(store), 'inner')).toEqual({ x: 120, y: 80 })
    expect(store.getHistory().past).toHaveLength(1)
    store.undo()
    expect(styles(store, 'outer')).toMatchObject({ left: 100, top: 50, width: 400, height: 300 })
    expect(styles(store, 'inner')).toMatchObject({ left: 20, top: 30 })
  })

  it('AT-CAN-006 scales freeform descendants during an unmodified frame resize', () => {
    const store = loaded()
    expect(store.commands.commitResize('outer', { x: 100, y: 50, width: 800, height: 600 }, undefined, false, { x: 100, y: 50, width: 400, height: 300 }).committed).toBe(true)
    expect(styles(store, 'inner')).toMatchObject({ left: 40, top: 60, width: 400, height: 200 })
  })

  it('duplicates a primitive 20 units to the right with a new id while the source keeps its own', () => {
    const store = loaded()
    store.select('box')
    expect(store.commands.duplicate()).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(file(store).nodes['new-1']).toMatchObject({ id: 'new-1', type: 'rectangle', name: 'Box', styles: { left: 670, top: 400, width: 50, height: 40 } })
    expect(file(store).nodes.box).toMatchObject({ id: 'box', styles: { left: 600, top: 400 } })
    expect(childrenOf(file(store), 'root-1')).toEqual(['outer', 'box', 'new-1', 'card'])
  })

  it('duplicates a frame subtree once even when a descendant is also selected', () => {
    const store = loaded()
    store.select('outer')
    store.select('inner', { additive: true })
    expect(store.commands.duplicate()).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(Object.keys(file(store).nodes)).toHaveLength(Object.keys(fixture().nodes).length + 2)
    expect(styles(store, 'new-1')).toMatchObject({ left: 520, top: 50 })
    expect(styles(store, 'new-2')).toMatchObject({ left: 20, top: 30 })
    expect(file(store).relationships['new-2']!.parentId).toBe('new-1')
    expect(file(store).relationships.inner!.parentId).toBe('outer')
    store.undo()
    expect(Object.keys(file(store).nodes)).toHaveLength(Object.keys(fixture().nodes).length)
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('deletes whole subtrees and restores identities and selection with undo', () => {
    const store = loaded()
    store.select('outer')
    expect(store.commands.delete()).toBe(true)
    expect(file(store).nodes.outer).toBeUndefined()
    expect(file(store).nodes.inner).toBeUndefined()
    expect(file(store).relationships.inner).toBeUndefined()
    expect(store.getSnapshot().selection).toEqual([])
    expect(store.commands.delete(['root-1'])).toBe(false)
    store.undo()
    expect(file(store).relationships.inner).toEqual({ parentId: 'outer', orderKey: 'V' })
    expect(store.getSnapshot().selection).toEqual(['outer'])
    store.redo()
    expect(file(store).nodes.outer).toBeUndefined()
    expect(store.getSnapshot().canRedo).toBe(false)
  })

  it('nudges selected primitives as one step and moves a flowing component root using its measured rect', () => {
    const store = loaded()
    store.selectMany(['box', 'inner'])
    expect(store.commands.nudge(5, -3)).toBe(true)
    expect(styles(store, 'box')).toMatchObject({ left: 605, top: 397 })
    expect(styles(store, 'inner')).toMatchObject({ left: 25, top: 27 })
    store.undo()
    expect(styles(store, 'box')).toMatchObject({ left: 600, top: 400 })
    expect(styles(store, 'inner')).toMatchObject({ left: 20, top: 30 })
    expect(store.getSnapshot().canUndo).toBe(false)

    store.select('card')
    expect(store.commands.nudge(4, 6)).toBe(false)
    const scene: Scene = { nodes: [], byId: new Map([['card', { id: 'card', kind: 'component', name: 'Card', parentId: null, rect: { x: 10.2, y: 20.7, width: 300.4, height: 200 }, rotation: 0, clip: false, depth: 0, order: 0, flow: false, locked: false }]]) }
    expect(store.commands.nudge(4, 6, scene)).toBe(true)
    expect((file(store).nodes.card as { layout?: unknown }).layout).toEqual({
      item: { position: { mode: 'absolute', left: { kind: 'px', value: 14 }, top: { kind: 'px', value: 27 } }, width: { value: { kind: 'px', value: 300 } } },
    })
  })
})

describe('AT-CAN component instances in slots', () => {
  it('derives defaults only for required verified scalar props and never invents slot content', () => {
    const verified: Atom = {
      ...atom('LoginForm', 'login-form', []),
      slots: ['children'],
      props: [
        { name: 'title', type: 'string', optional: false },
        { name: 'attempts', type: 'number', optional: false },
        { name: 'enabled', type: 'boolean', optional: false },
        { name: 'variant', type: "'compact' | 'wide'", optional: true },
        { name: 'children', type: 'ReactNode', optional: false },
      ],
    }
    expect(componentDefaultProps(verified)).toEqual({ title: '', attempts: 0, enabled: false })
  })

  it('inserts a root instance at a deterministic world point and selects the same persistent id', () => {
    const store = loaded()
    store.setViewport({ x: 40, y: -20, zoom: 2 })
    store.setViewportSize({ width: 800, height: 600 })
    expect(componentInsertionPoint(store.getSnapshot())).toEqual({ x: -20, y: 10 })
    expect(store.commands.insertAt('card-component', componentInsertionPoint(store.getSnapshot()))).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(file(store).nodes['new-1']).toEqual({
      id: 'new-1', type: 'component', componentId: 'card-component', exportName: 'Card', props: {}, themeMode: 'inherit',
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: -20 }, top: { kind: 'px', value: 10 } } } },
    })
    expect(file(store).relationships['new-1']!.parentId).toBe('root-1')
  })

  it('keeps a slot insertion in component-owned flow even when a drop point is provided', () => {
    const store = loaded()
    expect(store.commands.insertAt('label-component', { x: 120, y: 80 }, { parentId: 'card', slot: 'footer' })).toBe(true)
    expect(file(store).nodes['new-1']).not.toHaveProperty('layout')
    expect(childrenOf(file(store), 'card', 'footer')).toEqual(['footer-label', 'new-1'])
    expect(store.getSnapshot().selection).toEqual(['new-1'])
  })

  it('inserts the real component identity into a slot and duplicates the nested tree with fresh ids', () => {
    const store = loaded()
    expect(store.commands.insert('label-component', { parentId: 'card', slot: 'footer' }, { children: 'Create account' })).toBe(true)
    expect(file(store).nodes['new-1']).toEqual({ id: 'new-1', type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: 'Create account' }, themeMode: 'inherit' })
    expect(childrenOf(file(store), 'card', 'footer')).toEqual(['footer-label', 'new-1'])
    expect(store.commands.insert('label-component')).toBe(true)
    expect(file(store).nodes['new-2']).toMatchObject({ props: {} })
    expect(file(store).relationships['new-2']!.parentId).toBe('root-1')
    expect(store.commands.insert('missing-component')).toBe(false)

    expect(store.commands.duplicate('card')).toBe(true)
    const copied = childrenOf(file(store), 'new-3', 'children')
    expect(copied).toEqual(['new-4', 'new-5', 'new-6'])
    expect(copied.map(id => (file(store).nodes[id] as unknown as { props: { children: string } }).props.children)).toEqual(['Email', 'Password', 'Forgot'])
    expect(childrenOf(file(store), 'new-3', 'footer')).toEqual(['new-7', 'new-8'])
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['label', 'hint', 'note'])
    // A flowing component copy stays in the flow instead of being offset.
    expect(file(store).nodes['new-3']).not.toHaveProperty('layout')
  })

  it('reorders flow children within their own slot using insertion indexes', () => {
    const store = loaded()
    expect(store.commands.reorderFlow('note', 0).committed).toBe(true)
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['note', 'label', 'hint'])
    expect(store.commands.reorderFlow('note', 0).committed).toBe(false)
    // Dropping before index 3 (after the last sibling) moves label to the end.
    expect(store.commands.reorderFlow('label', 3).committed).toBe(true)
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['note', 'hint', 'label'])
    expect(childrenOf(file(store), 'card', 'footer')).toEqual(['footer-label'])
    expect(store.commands.moveBy('hint', -1)).toBe(true)
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['hint', 'note', 'label'])
    expect(store.commands.moveBy('hint', -1)).toBe(false)
    store.undo()
    store.undo()
    store.undo()
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['label', 'hint', 'note'])
  })

  it('rejects invalid slots and self nesting without corrupting state or locking later edits', () => {
    const store = loaded()
    const before = file(store)
    expect(store.commands.move('hint', { parentId: 'box' })).toBe(false)
    expect(file(store)).toBe(before)
    expect(store.commands.move('card', { parentId: 'card', slot: 'footer' })).toBe(false)
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().error).not.toBeNull()
    expect(store.commands.move('hint', { parentId: 'card', slot: 'footer' })).toBe(true)
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['label', 'note'])
    expect(childrenOf(file(store), 'card', 'footer')).toEqual(['footer-label', 'hint'])
    expect(store.getSnapshot().error).toBeNull()
  })

  it('keeps flow order when a slotted component gains an absolute layout', () => {
    const store = loaded()
    expect(store.commands.setLayout('hint', { mode: 'absolute', x: 24, y: 36, width: 140, height: 44 })).toBe(true)
    expect((file(store).nodes.hint as { layout?: unknown }).layout).toEqual({
      item: {
        position: { mode: 'absolute', left: { kind: 'px', value: 24 }, top: { kind: 'px', value: 36 } },
        width: { value: { kind: 'px', value: 140 } },
        height: { value: { kind: 'px', value: 44 } },
      },
    })
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['label', 'hint', 'note'])
    expect(store.commands.setProps('hint', { children: 'Secret' })).toBe(true)
    expect(store.commands.removeProps('hint', ['children'])).toBe(true)
    expect(file(store).nodes.hint).toMatchObject({ props: {} })
  })

  it('keeps an existing container when a five-field placement moves and resizes the node', () => {
    const base = fixture()
    const withContainer: FileDocument = {
      ...base,
      nodes: { ...base.nodes, card: { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'block' } } } },
    }
    const store = createDocumentStore(() => 'unused')
    store.load(withContainer, atoms)
    expect(store.getSnapshot().error).toBeNull()
    expect(store.commands.setLayout('card', { mode: 'absolute', x: 40, y: 12, width: 220, height: 90 })).toBe(true)
    expect((file(store).nodes.card as { layout?: unknown }).layout).toEqual({
      item: {
        position: { mode: 'absolute', left: { kind: 'px', value: 40 }, top: { kind: 'px', value: 12 } },
        width: { value: { kind: 'px', value: 220 } },
        height: { value: { kind: 'px', value: 90 } },
      },
      container: { display: 'block' },
    })
    expect(store.commands.setLayout('card', { mode: 'flow', x: 0, y: 0 })).toBe(true)
    expect((file(store).nodes.card as { layout?: unknown }).layout).toEqual({ item: { position: { mode: 'flow' } }, container: { display: 'block' } })
    store.undo()
    store.undo()
    expect((file(store).nodes.card as { layout?: unknown }).layout).toEqual({ item: { position: { mode: 'flow' } }, container: { display: 'block' } })
    expect(store.getSnapshot().canUndo).toBe(false)
  })
})

describe('AT-CAN undo and redo', () => {
  it('restores the file, the page, and the selection for each command', () => {
    const store = loaded()
    store.select('box')
    expect(store.commands.setStyles('box', { left: 610 })).toBe(true)
    expect(store.getSnapshot().canUndo).toBe(true)
    expect(store.getSnapshot().canRedo).toBe(false)
    store.setPage('page-2')
    store.select('other')
    expect(store.commands.rename('other', 'Renamed')).toBe(true)
    store.select(null)

    expect(store.undo()).toBe(true)
    expect(file(store).nodes.other).toMatchObject({ name: 'Other' })
    expect(store.getSnapshot().pageId).toBe('page-2')
    expect(store.getSnapshot().selection).toEqual(['other'])

    expect(store.undo()).toBe(true)
    expect(styles(store, 'box').left).toBe(600)
    expect(store.getSnapshot().pageId).toBe('page-1')
    expect(store.getSnapshot().selection).toEqual(['box'])
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getSnapshot().canRedo).toBe(true)
    expect(store.undo()).toBe(false)

    // Redo returns to the state the second undo left: box moved, page 2, other selected.
    expect(store.redo()).toBe(true)
    expect(styles(store, 'box').left).toBe(610)
    expect(file(store).nodes.other).toMatchObject({ name: 'Other' })
    expect(store.getSnapshot().pageId).toBe('page-2')
    expect(store.getSnapshot().selection).toEqual(['other'])
    expect(store.redo()).toBe(true)
    expect(file(store).nodes.other).toMatchObject({ name: 'Renamed' })
    expect(store.getSnapshot().canRedo).toBe(false)
    expect(store.redo()).toBe(false)
  })

  it('records a batch as one undo step and clears redo after a new command', () => {
    const store = loaded()
    expect(store.commands.executeBatch([{ type: 'node.setStyles', nodeId: 'box', styles: { left: 1 } }, { type: 'node.rename', nodeId: 'box', name: 'Moved' }])).toBe(true)
    expect(file(store).nodes.box).toMatchObject({ name: 'Moved', styles: { left: 1 } })
    expect(file(store).revision).toBe(1)
    store.undo()
    expect(file(store).nodes.box).toMatchObject({ name: 'Box', styles: { left: 600 } })
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getSnapshot().canRedo).toBe(true)
    expect(store.commands.setStyles('box', { top: 1 })).toBe(true)
    expect(store.getSnapshot().canRedo).toBe(false)
  })

  it('ignores commands that do not change the file', () => {
    const store = loaded()
    const before = file(store)
    expect(store.commands.setStyles('box', { left: 600 })).toBe(false)
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getSnapshot().dirty).toBe(false)
  })
})

describe('AT-THEME file tokens', () => {
  it('creates uniquely named tokens and keeps fill references through a rename', () => {
    const store = loaded()
    expect(store.commands.theme.createToken()).toBe('new-1')
    expect(store.commands.theme.createToken({ kind: 'hex', hex: '#123456' })).toBe('new-2')
    expect(file(store).theme.tokens['new-1']).toEqual({ id: 'new-1', type: 'color', name: 'Untitled', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#d9d9d9' } } })
    expect(file(store).theme.tokens['new-2']).toMatchObject({ name: 'Untitled 2', orderKey: 'W', value: { kind: 'literal', color: { kind: 'hex', hex: '#123456' } } })
    expect(store.commands.appearance.updateFill(['box'], 0, { id: 'box-fill', type: 'solid', color: { kind: 'token', tokenId: 'new-1' } })).toBe(true)
    expect(store.commands.theme.renameToken('new-1', '  Brand  ')).toBe(true)
    expect(file(store).theme.tokens['new-1']!.name).toBe('Brand')
    expect(store.commands.theme.renameToken('new-1', '   ')).toBe(false)
    expect(fillsOf(store, 'box')).toEqual([{ id: 'box-fill', type: 'solid', color: { kind: 'token', tokenId: 'new-1' } }])
    expect(store.commands.theme.createToken()).toBe('new-3')
    expect(file(store).theme.tokens['new-3']!.name).toBe('Untitled')
    expect(store.commands.theme.duplicateToken('new-1')).toBe('new-4')
    expect(file(store).theme.tokens['new-4']).toMatchObject({ name: 'Brand copy', value: { kind: 'literal', color: { kind: 'hex', hex: '#d9d9d9' } } })
  })

  it('inlines the resolved color of a deleted alias token into a bound fill as one undo step', () => {
    const store = loaded()
    const alias = store.commands.theme.createToken()!
    const target = store.commands.theme.createToken({ kind: 'hex', hex: '#123456' })!
    expect(store.commands.theme.setTokenValue(alias, { kind: 'alias', tokenId: target })).toBe(true)
    expect(store.commands.theme.resolve(alias)).toEqual({ kind: 'hex', hex: '#123456' })
    expect(store.commands.appearance.updateFill(['box'], 0, { id: 'box-fill', type: 'solid', color: { kind: 'token', tokenId: alias } })).toBe(true)
    expect(store.commands.theme.deleteTokens([alias])).toBe(true)
    expect(file(store).theme.tokens[alias]).toBeUndefined()
    expect(fillsOf(store, 'box')).toEqual([{ id: 'box-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#123456' } } }])
    store.undo()
    expect(file(store).theme.tokens[alias]).toBeDefined()
    expect(fillsOf(store, 'box')).toEqual([{ id: 'box-fill', type: 'solid', color: { kind: 'token', tokenId: alias } }])
  })

  it('resolves source tokens through the configured design palette when deleting, with the fallback otherwise', () => {
    const run = (palette: Record<string, { kind: 'hex'; hex: string }> | null) => {
      const store = loaded()
      if (palette) store.configure({ sources: () => palette })
      const token = store.commands.theme.createToken()!
      store.commands.theme.setTokenValue(token, { kind: 'source', property: '--surface', fallback: { kind: 'hex', hex: '#000000' } })
      expect(store.commands.appearance.updateFill(['box'], 0, { id: 'box-fill', type: 'solid', color: { kind: 'token', tokenId: token } })).toBe(true)
      expect(store.commands.theme.deleteTokens([token])).toBe(true)
      return fillsOf(store, 'box')
    }
    expect(run({ '--surface': { kind: 'hex', hex: '#fafafa' } })).toEqual([{ id: 'box-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#fafafa' } } }])
    expect(run(null)).toEqual([{ id: 'box-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#000000' } } }])
  })
})

const thin: Stroke = { color: hex('#333333'), width: 2, style: 'solid' }
const plusDefault: Stroke = { color: hex('#000000'), width: 1, style: 'solid' }
/** The base fixture with two fills (bottom first) and top plus bottom borders on `outer` and `box`. */
const layered = (): FileDocument => {
  const next = fixture()
  next.nodes.outer = { ...next.nodes.outer, appearance: { fills: [solid('outer-bottom', '#ffffff'), solid('outer-top', '#000000')], borders: { top: thin, bottom: thin } } } as FileDocument['nodes'][string]
  next.nodes.box = { ...next.nodes.box, appearance: { fills: [solid('box-bottom', '#d9d9d9'), solid('box-top', '#ff0000')], borders: { top: thin, bottom: thin } } } as FileDocument['nodes'][string]
  return next
}
const loadedFrom = (source: FileDocument) => { let id = 0; const store = createDocumentStore(() => `new-${++id}`); store.load(source, atoms); return store }
type Store = ReturnType<typeof createDocumentStore>
type MultiCase = { name: string; source: () => FileDocument; run: (store: Store) => boolean; outer: Appearance; box: Appearance }

const multiCases: MultiCase[] = [
  { name: 'setBlending', source: fixture, run: store => store.commands.appearance.setBlending(['outer', 'box'], { opacity: 0.5, blendMode: 'multiply' }),
    outer: { opacity: 0.5, blendMode: 'multiply', fills: [solid('outer-fill', '#ffffff')] }, box: { opacity: 0.5, blendMode: 'multiply', fills: [solid('box-fill', '#d9d9d9')] } },
  // Appended topmost (last in storage) with the kind default: white on a frame, #dddddd elsewhere. Ids are drawn in node order.
  { name: 'addFill', source: fixture, run: store => store.commands.appearance.addFill(['outer', 'box']),
    outer: { fills: [solid('outer-fill', '#ffffff'), solid('new-1', '#ffffff')] }, box: { fills: [solid('box-fill', '#d9d9d9'), solid('new-2', '#dddddd')] } },
  { name: 'replaceFills', source: fixture, run: store => store.commands.appearance.replaceFills(['outer', 'box'], [solid('shared', '#123456')]),
    outer: { fills: [solid('new-1', '#123456')] }, box: { fills: [solid('new-2', '#123456')] } },
  // The paint id passed in is ignored; each node keeps the id of its own fill at that storage index.
  { name: 'updateFill', source: fixture, run: store => store.commands.appearance.updateFill(['outer', 'box'], 0, solid('ignored', '#00ff00')),
    outer: { fills: [solid('outer-fill', '#00ff00')] }, box: { fills: [solid('box-fill', '#00ff00')] } },
  { name: 'moveFill', source: layered, run: store => store.commands.appearance.moveFill(['outer', 'box'], 1, 0),
    outer: { fills: [solid('outer-top', '#000000'), solid('outer-bottom', '#ffffff')], borders: { top: thin, bottom: thin } }, box: { fills: [solid('box-top', '#ff0000'), solid('box-bottom', '#d9d9d9')], borders: { top: thin, bottom: thin } } },
  { name: 'removeFill', source: layered, run: store => store.commands.appearance.removeFill(['outer', 'box'], 0),
    outer: { fills: [solid('outer-top', '#000000')], borders: { top: thin, bottom: thin } }, box: { fills: [solid('box-top', '#ff0000')], borders: { top: thin, bottom: thin } } },
  { name: 'setOutline', source: fixture, run: store => store.commands.appearance.setOutline(['outer', 'box'], { color: hex('#0000ff'), width: 3, style: 'dashed', offset: 4 }),
    outer: { fills: [solid('outer-fill', '#ffffff')], outline: { color: hex('#0000ff'), width: 3, style: 'dashed', offset: 4 } }, box: { fills: [solid('box-fill', '#d9d9d9')], outline: { color: hex('#0000ff'), width: 3, style: 'dashed', offset: 4 } } },
  { name: 'addBorder', source: fixture, run: store => store.commands.appearance.addBorder(['outer', 'box']),
    outer: { fills: [solid('outer-fill', '#ffffff')], borders: { top: plusDefault } }, box: { fills: [solid('box-fill', '#d9d9d9')], borders: { top: plusDefault } } },
  { name: 'setBorders', source: fixture, run: store => store.commands.appearance.setBorders(['outer', 'box'], { left: thin }),
    outer: { fills: [solid('outer-fill', '#ffffff')], borders: { left: thin } }, box: { fills: [solid('box-fill', '#d9d9d9')], borders: { left: thin } } },
  { name: 'updateBorder', source: layered, run: store => store.commands.appearance.updateBorder(['outer', 'box'], 'bottom', plusDefault),
    outer: { fills: [solid('outer-bottom', '#ffffff'), solid('outer-top', '#000000')], borders: { top: thin, bottom: plusDefault } }, box: { fills: [solid('box-bottom', '#d9d9d9'), solid('box-top', '#ff0000')], borders: { top: thin, bottom: plusDefault } } },
  { name: 'removeBorder', source: layered, run: store => store.commands.appearance.removeBorder(['outer', 'box'], 'top'),
    outer: { fills: [solid('outer-bottom', '#ffffff'), solid('outer-top', '#000000')], borders: { bottom: thin } }, box: { fills: [solid('box-bottom', '#d9d9d9'), solid('box-top', '#ff0000')], borders: { bottom: thin } } },
  { name: 'moveBorderSide', source: layered, run: store => store.commands.appearance.moveBorderSide(['outer', 'box'], 'top', 'left'),
    outer: { fills: [solid('outer-bottom', '#ffffff'), solid('outer-top', '#000000')], borders: { bottom: thin, left: thin } }, box: { fills: [solid('box-bottom', '#d9d9d9'), solid('box-top', '#ff0000')], borders: { bottom: thin, left: thin } } },
]

describe('AT-APP-004 appearance commands', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it.each(multiCases)('$name on two selected nodes is one history entry that undo reverts for both', ({ source, run, outer, box }) => {
    const store = loadedFrom(source())
    const before = { outer: appearanceOf(store, 'outer'), box: appearanceOf(store, 'box') }
    expect(run(store)).toBe(true)
    expect(appearanceOf(store, 'outer')).toEqual(outer)
    expect(appearanceOf(store, 'box')).toEqual(box)
    expect(file(store).revision).toBe(1)
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(appearanceOf(store, 'outer')).toEqual(before.outer)
    expect(appearanceOf(store, 'box')).toEqual(before.box)
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('records one entry per call, so two single-node edits are two undo steps (negative control)', () => {
    const store = loaded()
    store.commands.appearance.updateFill(['outer'], 0, solid('ignored', '#00ff00'))
    store.commands.appearance.updateFill(['box'], 0, solid('ignored', '#00ff00'))
    expect(store.getHistory().past).toHaveLength(2)
    store.undo()
    expect(fillsOf(store, 'outer')).toEqual([solid('outer-fill', '#00ff00')])
    expect(fillsOf(store, 'box')).toEqual([solid('box-fill', '#d9d9d9')])
  })

  it('skips nodes without a fill at the storage index and refuses when no node has one', () => {
    const store = loadedFrom(layered())
    // inner has one fill, so index 1 only exists on outer.
    expect(store.commands.appearance.updateFill(['outer', 'inner'], 1, solid('ignored', '#abcdef'))).toBe(true)
    expect(fillsOf(store, 'outer')).toEqual([solid('outer-bottom', '#ffffff'), solid('outer-top', '#abcdef')])
    expect(fillsOf(store, 'inner')).toEqual([solid('inner-fill', '#ffffff')])
    const after = file(store)
    expect(store.commands.appearance.updateFill(['inner', 'card'], 1, solid('ignored', '#abcdef'))).toBe(false)
    expect(file(store)).toBe(after)
    expect(store.getHistory().past).toHaveLength(1)
  })

  it('drops the fills key with the last fill, and the appearance key when nothing else remains', () => {
    const store = loaded()
    expect(store.commands.appearance.removeFill(['box'], 0)).toBe(true)
    expect(file(store).nodes.box).not.toHaveProperty('appearance')
    expect(store.commands.appearance.setBlending(['outer'], { opacity: 0.25 })).toBe(true)
    expect(store.commands.appearance.removeFill(['outer'], 0)).toBe(true)
    expect(appearanceOf(store, 'outer')).toEqual({ opacity: 0.25 })
    expect(appearanceOf(store, 'outer')).not.toHaveProperty('fills')
  })

  it('walks the border plus sequence: top, top and bottom, left, right, all, then four sides', () => {
    const store = loaded()
    const seen: unknown[] = []
    for (let press = 0; press < 6; press++) { store.commands.appearance.addBorder(['box']); seen.push(appearanceOf(store, 'box')?.borders) }
    expect(seen).toEqual([
      { top: plusDefault },
      { top: plusDefault, bottom: plusDefault },
      { top: plusDefault, bottom: plusDefault, left: plusDefault },
      { top: plusDefault, bottom: plusDefault, left: plusDefault, right: plusDefault },
      { all: plusDefault },
      { top: plusDefault, bottom: plusDefault, left: plusDefault, right: plusDefault },
    ])
  })

  it('refuses to move a border side onto an occupied side without a history entry', () => {
    const store = loadedFrom(layered())
    const before = file(store)
    expect(store.commands.appearance.moveBorderSide(['box'], 'top', 'bottom')).toBe(false)
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().canUndo).toBe(false)
    // Negative control: an empty destination moves.
    expect(store.commands.appearance.moveBorderSide(['box'], 'top', 'right')).toBe(true)
    expect(appearanceOf(store, 'box')?.borders).toEqual({ bottom: thin, right: thin })
  })

  it('refuses an outline on a text node through validation and reports the error', () => {
    const store = loaded()
    store.commands.insertCanvas('text', { x: 0, y: 0 })
    const before = file(store)
    const outline = { color: hex('#0000ff'), width: 1, style: 'solid' as const, offset: 0 }
    expect(store.commands.appearance.setOutline(['new-1'], outline)).toBe(false)
    expect(store.getSnapshot().error).toBe('This node has no outline')
    expect(file(store)).toBe(before)
    expect(store.getHistory().past).toHaveLength(1)
    // Negative control: the same outline on a rectangle is accepted and clears the error.
    expect(store.commands.appearance.setOutline(['box'], outline)).toBe(true)
    expect(store.getSnapshot().error).toBeNull()
    expect(appearanceOf(store, 'box')?.outline).toEqual(outline)
  })

  it('previews a gesture outside the file and history, then commits it as one batch', () => {
    const store = loaded()
    const before = file(store)
    store.commands.appearance.gesture.preview({ box: { fills: [solid('box-fill', '#ff0000')] } })
    // Without begin, a preview is ignored.
    expect(store.getSnapshot().appearanceOverrides).toBeNull()
    store.commands.appearance.gesture.begin()
    expect(store.getSnapshot().appearanceOverrides).toEqual({})
    store.commands.appearance.gesture.preview({ box: { fills: [solid('box-fill', '#ff0000')] } })
    store.commands.appearance.gesture.preview({ box: { fills: [solid('box-fill', '#00ff00')] }, outer: { opacity: 0.25, fills: [solid('outer-fill', '#ffffff')] } })
    expect(store.getSnapshot().appearanceOverrides).toEqual({ box: { fills: [solid('box-fill', '#00ff00')] }, outer: { opacity: 0.25, fills: [solid('outer-fill', '#ffffff')] } })
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getSnapshot().dirty).toBe(false)

    expect(store.commands.appearance.gesture.commit()).toBe(true)
    expect(store.getSnapshot().appearanceOverrides).toBeNull()
    expect(fillsOf(store, 'box')).toEqual([solid('box-fill', '#00ff00')])
    expect(appearanceOf(store, 'outer')).toEqual({ opacity: 0.25, fills: [solid('outer-fill', '#ffffff')] })
    expect(file(store).revision).toBe(1)
    expect(store.getHistory().past).toHaveLength(1)
    store.undo()
    expect(fillsOf(store, 'box')).toEqual([solid('box-fill', '#d9d9d9')])
    expect(appearanceOf(store, 'outer')).toEqual({ fills: [solid('outer-fill', '#ffffff')] })
  })

  it('AT-PERF-001 keeps the editor shell snapshot stable through live outline previews', () => {
    const store = loaded()
    const shell = store.getShellSnapshot()
    const view = store.getViewSnapshot()
    store.commands.appearance.gesture.begin()
    const afterBegin = store.getShellSnapshot()
    expect(afterBegin).toBe(shell)
    for (let width = 1; width <= 120; width++) {
      store.commands.appearance.gesture.preview({ box: { fills: [solid('box-fill', '#d9d9d9')], outline: { color: hex('#00ff00'), width, style: 'solid', offset: 0 } } })
      expect(store.getShellSnapshot()).toBe(shell)
    }
    expect(store.getViewSnapshot()).not.toBe(view)
    expect(store.commands.appearance.gesture.commit()).toBe(true)
    expect(store.getShellSnapshot()).not.toBe(shell)
    expect(appearanceOf(store, 'box')?.outline?.width).toBe(120)
    expect(store.getHistory().past).toHaveLength(1)
  })

  it('cancels a gesture leaving the file and history untouched', () => {
    const store = loaded()
    const before = file(store)
    store.commands.appearance.gesture.begin()
    store.commands.appearance.gesture.preview({ box: null })
    expect(store.getSnapshot().appearanceOverrides).toEqual({ box: null })
    store.commands.appearance.gesture.cancel()
    expect(store.getSnapshot().appearanceOverrides).toBeNull()
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().canUndo).toBe(false)
    // A commit after cancel has nothing to write.
    expect(store.commands.appearance.gesture.commit()).toBe(false)
    expect(file(store)).toBe(before)
  })

  it('stores a canonical PNG reference with render bytes in the session sidecar and refuses referenced removal', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })))
    const store = loaded()
    expect(await store.commands.assets.add(new File([onePixelPng], 'dot.png', { type: 'image/png' }))).toBe('new-1')
    expect(file(store).assets).toEqual({ 'new-1': { id: 'new-1', name: 'dot.png', mime: 'image/png', extension: 'png', width: 1, height: 1, bytes: 70, sha256: '497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581' } })
    expect(file(store).assets!['new-1']).not.toHaveProperty('data')
    expect(store.assetPreview('new-1')).toEqual({ mime: 'image/png', data: onePixelPreview })

    const image: Paint = { id: 'ignored', type: 'image', assetId: 'new-1', fit: 'cover' }
    expect(store.commands.appearance.updateFill(['box'], 0, image)).toBe(true)
    const referenced = file(store)
    expect(store.commands.assets.remove('new-1')).toBe(false)
    expect(store.getSnapshot().error).toBe('That image is still used by a fill')
    expect(file(store)).toBe(referenced)
    expect(store.getHistory().past).toHaveLength(2)

    // Negative control: once no fill references it, the asset goes and the empty asset map is dropped.
    expect(store.commands.appearance.updateFill(['box'], 0, solid('ignored', '#d9d9d9'))).toBe(true)
    expect(store.commands.assets.remove('new-1')).toBe(true)
    expect(file(store)).not.toHaveProperty('assets')
  })

  it('refuses an unsupported image type before reading it', async () => {
    const decode = vi.fn(async () => ({ width: 1, height: 1, close() {} }))
    vi.stubGlobal('createImageBitmap', decode)
    const store = loaded()
    expect(await store.commands.assets.add(new File(['hello'], 'note.txt', { type: 'text/plain' }))).toBeNull()
    expect(store.getSnapshot().error).toBe('Choose an image up to 25 MB.')
    expect(decode).not.toHaveBeenCalled()
    expect(file(store)).not.toHaveProperty('assets')
  })

  it('ERROR-VISIBILITY-001 reports an image above the import limit before decoding it', async () => {
    const decode = vi.fn(async () => ({ width: 1, height: 1, close() {} }))
    const onError = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const store = loaded()
    store.configure({ onError })
    const image = new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })

    expect(await store.commands.assets.add(image)).toBeNull()
    expect(decode).not.toHaveBeenCalled()
    expect(store.getSnapshot().error).toBe('Choose an image up to 25 MB.')
    expect(onError).toHaveBeenCalledWith({ title: "Image couldn't be added", message: 'Choose an image up to 25 MB.' })
  })

  it('FILE-ASSET-LIFECYCLE-001 uploads before attach and installs verified bytes before document subscribers run', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })))
    const store = loaded()
    const order: string[] = []
    store.configure({
      uploadImage: async input => {
        order.push('upload')
        expect(file(store).assets).toBeUndefined()
        expect(input.fileId).toBe('file-1')
        expect(input.bytes).toEqual(onePixelPng)
        return { asset: input.asset, preview: { assetId: input.asset.id, sha256: input.asset.sha256, mime: input.asset.mime, data: onePixelPreview } }
      },
    })
    store.subscribe(() => {
      if (file(store).assets?.['new-1']) order.push(store.assetPreview('new-1') ? 'attach-with-preview' : 'attach-without-preview')
    })

    await expect(store.commands.assets.add(new File([onePixelPng], 'dot.png', { type: 'image/png' }))).resolves.toBe('new-1')
    expect(order).toEqual(['upload', 'attach-with-preview'])
  })

  it('FILE-ASSET-LIFECYCLE-001 leaves no document reference and reports the upload error when durable upload fails', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })))
    const store = loaded()
    const onError = vi.fn()
    store.configure({ uploadImage: async () => { throw new Error('Image storage is unavailable. Try again.') }, onError })

    await expect(store.commands.assets.add(new File([onePixelPng], 'dot.png', { type: 'image/png' }))).resolves.toBeNull()
    expect(file(store).assets).toBeUndefined()
    expect(store.assetPreview('new-1')).toBeNull()
    expect(onError).toHaveBeenCalledWith({ title: "Image couldn't be added", message: 'Image storage is unavailable. Try again.' })
  })

  it('FILE-ASSET-LIFECYCLE-001 removes installed render bytes when attach is rejected', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })))
    const store = loaded()
    let uploadedAsset: ImageAssetReference | null = null
    store.configure({
      uploadImage: async input => {
        uploadedAsset = input.asset
        return { asset: input.asset, preview: { assetId: input.asset.id, sha256: input.asset.sha256, mime: input.asset.mime, data: onePixelPreview } }
      },
    })
    store.setEditPolicy(() => { throw new Error('Editing is no longer allowed.') })

    await expect(store.commands.assets.add(new File([onePixelPng], 'dot.png', { type: 'image/png' }))).resolves.toBeNull()
    expect(uploadedAsset).not.toBeNull()
    expect(file(store).assets).toBeUndefined()

    store.setEditPolicy(undefined)
    store.load({ ...fixture(), assets: { [uploadedAsset!.id]: uploadedAsset! } }, atoms, { replace: true })
    expect(store.assetPreview(uploadedAsset!.id)).toBeNull()
  })

  it('FILE-ASSET-LIFECYCLE-001 ignores an upload result after the open file generation changes', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })))
    const store = loaded()
    let uploadStarted = false
    let finishUpload: () => void = () => undefined
    store.configure({
      uploadImage: input => new Promise(resolve => { uploadStarted = true; finishUpload = () => resolve({ asset: input.asset, preview: { assetId: input.asset.id, sha256: input.asset.sha256, mime: input.asset.mime, data: onePixelPreview } }) }),
    })
    const adding = store.commands.assets.add(new File([onePixelPng], 'dot.png', { type: 'image/png' }))
    await vi.waitFor(() => expect(uploadStarted).toBe(true))
    const next = { ...fixture(), fileId: 'file-2' }
    store.load(next, atoms, { replace: true })
    finishUpload()

    await expect(adding).resolves.toBeNull()
    expect(file(store).fileId).toBe('file-2')
    expect(file(store).assets).toBeUndefined()
    expect(store.assetPreview('new-1')).toBeNull()
  })

  it('FILE-ASSET-002 hydrates sidecars before notify, rejects mismatches, and clears them on file switch', () => {
    const store = loaded()
    const asset = { id: 'photo', name: 'photo.png', mime: 'image/png' as const, extension: 'png' as const, width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) }
    const hydrated = { ...fixture(), fileId: 'file-hydrated', assets: { photo: asset } }
    const preview = { assetId: 'photo', sha256: asset.sha256, mime: asset.mime, data: 'AAAA' }
    const observed: unknown[] = []
    store.subscribe(() => observed.push(store.assetPreview('photo')))
    store.load(hydrated, atoms, { replace: true, assetPreviews: [preview] })
    expect(observed.at(-1)).toEqual({ mime: 'image/png', data: 'AAAA' })
    expect(store.assetPreview('photo')).toEqual({ mime: 'image/png', data: 'AAAA' })

    const before = file(store)
    expect(() => store.load(hydrated, atoms, { replace: true, assetPreviews: [preview, preview] })).toThrow('Choose an image up to 25 MB.')
    expect(file(store)).toBe(before)
    expect(() => store.load(hydrated, atoms, { replace: true, assetPreviews: [{ ...preview, sha256: 'b'.repeat(64) }] })).toThrow('Choose an image up to 25 MB.')
    expect(file(store)).toBe(before)

    store.load({ ...fixture(), fileId: 'file-empty' }, atoms, { replace: true })
    expect(store.assetPreview('photo')).toBeNull()
  })
})

describe('AT-CAN keyboard shortcuts', () => {
  it('selects every node of the open page in layer order', () => {
    const store = loaded()
    expect(store.handleKey(key('a', { ctrlKey: true }))).toBe(true)
    expect(store.getSnapshot().selection).toEqual(pageOneOrder)
    store.setPage('page-2')
    store.handleKey(key('a', { metaKey: true }), 'mac')
    expect(store.getSnapshot().selection).toEqual(['other'])
  })

  it('undoes, redoes, deletes, escapes, nudges, and reorders from the keyboard', () => {
    const store = loaded()
    store.select('box')
    expect(store.handleKey(key('ArrowRight', { shiftKey: true }))).toBe(true)
    expect(styles(store, 'box').left).toBe(610)
    store.handleKey(key('ArrowUp'))
    expect(styles(store, 'box').top).toBe(399)
    expect(store.handleKey(key('z', { ctrlKey: true }))).toBe(true)
    expect(styles(store, 'box').top).toBe(400)
    expect(store.handleKey(key('z', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(styles(store, 'box').top).toBe(399)
    store.handleKey(key('z', { ctrlKey: true }))
    expect(store.handleKey(key('y', { ctrlKey: true }))).toBe(true)
    expect(styles(store, 'box').top).toBe(399)

    expect(store.handleKey(key('Delete'))).toBe(true)
    expect(file(store).nodes.box).toBeUndefined()
    const afterDelete = file(store)
    expect(store.handleKey(key('Backspace'))).toBe(true)
    expect(file(store)).toBe(afterDelete)

    store.select('hint')
    expect(store.handleKey(key('ArrowUp', { altKey: true }))).toBe(true)
    expect(childrenOf(file(store), 'card', 'children')).toEqual(['hint', 'label', 'note'])

    store.setRenaming('hint')
    expect(store.handleKey(key('Escape'))).toBe(true)
    expect(store.getSnapshot().renaming).toBeNull()
    expect(store.getSnapshot().selection).toEqual(['hint'])
    store.handleKey(key('Escape'))
    expect(store.getSnapshot().selection).toEqual([])
  })

  it('uses the platform command modifier and switches tools', () => {
    const store = loaded()
    store.select('box')
    const count = Object.keys(file(store).nodes).length
    expect(store.handleKey(key('d', { metaKey: true }), 'other')).toBe(false)
    expect(Object.keys(file(store).nodes)).toHaveLength(count)
    expect(store.handleKey(key('d', { ctrlKey: true }), 'other')).toBe(true)
    expect(Object.keys(file(store).nodes)).toHaveLength(count + 1)
    expect(store.handleKey(key('z', { ctrlKey: true }), 'mac')).toBe(false)
    expect(store.handleKey(key('z', { metaKey: true }), 'mac')).toBe(true)
    expect(Object.keys(file(store).nodes)).toHaveLength(count)
    expect(store.getSnapshot().canRedo).toBe(true)
    store.commands.setStyles('box', { width: 60 })
    expect(store.getSnapshot().canRedo).toBe(false)
    const onToolChange = vi.fn()
    store.configure({ onToolChange })
    expect(store.handleKey(key('i'))).toBe(true)
    expect(store.getSnapshot().tool).toBe('interact')
    expect(onToolChange.mock.calls).toEqual([['interact']])
  })
})

describe('document store snapshots and viewport', () => {
  it('caches immutable snapshots and cleans subscriptions', () => {
    const store = loaded()
    const before = store.getSnapshot()
    expect(store.getSnapshot()).toBe(before)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.commands.setStyles('box', { width: 60 })
    expect((before.file!.nodes.box as { styles: { width: number } }).styles.width).toBe(50)
    expect(styles(store, 'box').width).toBe(60)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.pan(10, 20)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('disposes every subscription and clears command persistence callbacks', () => {
    const store = loaded()
    const first: number[] = []
    const changed = vi.fn()
    const persist = vi.fn(async (next: FileDocument, expected: number) => ({ ...next, revision: expected + 1 }))
    const stop = store.subscribe(() => first.push(store.getSnapshot().viewport.x))
    store.configure({ onChange: changed, persist })
    store.pan(10, 20)
    store.dispose()
    store.pan(30, 40)
    store.commands.setStyles('box', { width: 60 })
    stop()
    expect(first).toEqual([10])
    expect(changed).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it('keeps viewport edits transient and anchors zoom to the pointer', () => {
    const store = loaded()
    const onChange = vi.fn()
    store.configure({ onChange })
    const before = file(store)
    store.pan(10, 20)
    store.zoomAt(2, { x: 100, y: 100 })
    expect(store.getSnapshot().viewport).toEqual({ x: -80, y: -60, zoom: 2 })
    store.fit(null)
    expect(store.getSnapshot().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    store.setViewportSize({ width: 1200, height: 800 })
    // 5% padding of the shorter side (20) on each edge: 440 x 449.
    store.fit({ x: -213, y: -276, width: 400, height: 409 })
    expect(store.getSnapshot().viewport.zoom).toBeCloseTo(800 / 449, 6)
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().dirty).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('AT-CAN document persistence boundaries', () => {
  it('CLOUD-SYNC-CLIENT-001 keeps exact commands and batch order across an in-flight save', async () => {
    const store = loaded()
    let release: (next: FileDocument) => void = () => {}
    const first = new Promise<FileDocument>(resolve => { release = resolve })
    const writes: { file: FileDocument; expected: number; intent: EditorPersistenceIntent }[] = []
    store.configure({ persist: async (next, expected, intent) => {
      writes.push({ file: next, expected, intent })
      if (writes.length === 1) return first
      return { ...next, revision: expected + 1 }
    } })

    store.commands.setStyles('box', { left: 610 })
    store.commands.executeBatch([
      { type: 'node.setStyles', nodeId: 'box', styles: { top: 410 } },
      { type: 'node.rename', nodeId: 'outer', name: 'Frame renamed' },
    ])
    store.commands.renamePage('page-1', 'Canvas')

    expect(writes).toHaveLength(1)
    expect(writes[0]!.intent).toEqual({ kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: { left: 610 } }] })
    release({ ...writes[0]!.file, revision: 1 })
    await settled(store)

    expect(writes).toHaveLength(3)
    expect(writes[1]!.expected).toBe(1)
    expect(writes[1]!.intent).toEqual({
      kind: 'commands',
      commands: [{
        type: 'batch',
        commands: [
          { type: 'node.setStyles', nodeId: 'box', styles: { top: 410 } },
          { type: 'node.rename', nodeId: 'outer', name: 'Frame renamed' },
        ],
      }],
    })
    expect(writes[2]).toMatchObject({ expected: 2, intent: { kind: 'commands', commands: [{ type: 'page.rename', pageId: 'page-1', name: 'Canvas' }] } })
    expect((writes[1]!.file.nodes.box as { styles: { left: number; top: number } }).styles).toMatchObject({ left: 610, top: 410 })
    expect((writes[1]!.file.nodes.outer as { name: string }).name).toBe('Frame renamed')
    expect(writes[2]!.file.pages[0]?.name).toBe('Canvas')
  })

  it('CLOUD-SYNC-CLIENT-001 persists undo and redo as semantic inverse commands', async () => {
    const store = loaded()
    const intents: EditorPersistenceIntent[] = []
    store.configure({ persist: async (next, expected, intent) => { intents.push(intent); return { ...next, revision: expected + 1 } } })
    store.commands.setStyles('box', { left: 610 })
    await settled(store)
    store.undo()
    await settled(store)
    store.redo()
    await settled(store)
    expect(intents).toEqual([
      { kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: { left: 610 } }] },
      { kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: { left: 600 } }] },
      { kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: { left: 610 } }] },
    ])
  })

  it('CLOUD-SYNC-CLIENT-001 retries the same file and semantic commands after rejection', async () => {
    const store = loaded()
    const writes: { file: FileDocument; expected: number; intent: EditorPersistenceIntent }[] = []
    store.configure({ persist: async (next, expected, intent) => {
      writes.push({ file: next, expected, intent })
      if (writes.length === 1) throw new Error('Revision conflict')
      return { ...next, revision: expected + 1 }
    } })
    store.commands.setStyles('box', { left: 610 })
    await settled(store)
    store.retryPersistence()
    await settled(store)
    expect(writes).toHaveLength(2)
    expect(writes[1]!.file).toBe(writes[0]!.file)
    expect(writes[1]!.expected).toBe(writes[0]!.expected)
    expect(writes[1]!.intent).toEqual(writes[0]!.intent)
    expect(writes[1]!.intent).toEqual({ kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: { left: 610 } }] })
  })

  it('sends the file with the saved revision and adopts the acknowledged revision', async () => {
    const store = loaded()
    const writes: [number, number][] = []
    store.configure({ persist: async (next, expected) => { writes.push([next.revision, expected]); return { ...next, revision: expected === 0 ? 7 : expected + 1 } } })
    store.commands.setStyles('box', { left: 610 })
    await settled(store)
    expect(file(store).revision).toBe(7)
    expect(store.getSnapshot().dirty).toBe(false)
    store.commands.setStyles('box', { top: 410 })
    await settled(store)
    expect(writes).toEqual([[1, 0], [8, 7]])
    expect(file(store).revision).toBe(8)
    expect(styles(store, 'box')).toMatchObject({ left: 610, top: 410 })
  })

  it('serializes concurrent edits against acknowledged revisions without dropping the latest file', async () => {
    const store = loaded()
    let release: (next: FileDocument) => void = () => {}
    const first = new Promise<FileDocument>(resolve => { release = resolve })
    const writes: { file: FileDocument; expected: number }[] = []
    store.configure({ persist: async (next, expected) => { writes.push({ file: next, expected }); if (writes.length === 1) return first; return { ...next, revision: expected + 1 } } })
    store.commands.setStyles('box', { left: 610 })
    store.commands.setStyles('box', { top: 410 })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.expected).toBe(0)
    release({ ...writes[0]!.file, revision: 1 })
    await settled(store)
    expect(writes.map(write => write.expected)).toEqual([0, 1])
    expect((writes[1]!.file.nodes.box as { styles: unknown }).styles).toEqual({ left: 610, top: 410, width: 50, height: 40 })
    expect(file(store).revision).toBe(2)
    expect(store.getSnapshot().dirty).toBe(false)
    store.undo()
    await settled(store)
    expect(writes[2]!.expected).toBe(2)
    expect(styles(store, 'box').top).toBe(400)
  })

  it('blocks further edits after a rejected save until persistence is retried', async () => {
    const store = loaded()
    const persist = vi.fn().mockRejectedValueOnce(new Error('Revision conflict')).mockImplementation(async (next: FileDocument, expected: number) => ({ ...next, revision: expected + 1 }))
    store.configure({ persist })
    store.commands.setStyles('box', { left: 610 })
    await settled(store)
    expect(store.getSnapshot().dirty).toBe(true)
    expect(store.getSnapshot().blocked).toBe(true)
    expect(store.getSnapshot().error).toBe('Revision conflict')
    expect(store.commands.setStyles('box', { top: 410 })).toBe(false)
    expect(store.undo()).toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
    store.retryPersistence()
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    expect(persist).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().blocked).toBe(false)
    expect(styles(store, 'box').left).toBe(610)
    expect(store.commands.setStyles('box', { top: 410 })).toBe(true)
  })

  it('does not replace a newer edit when acknowledging an earlier save', () => {
    const store = loaded()
    store.commands.setStyles('box', { left: 610 })
    const first = file(store)
    store.commands.setStyles('box', { top: 410 })
    store.markSaved({ ...first, revision: 1 })
    expect(styles(store, 'box')).toMatchObject({ left: 610, top: 410 })
    expect(file(store).revision).toBe(1)
    expect(store.getSnapshot().dirty).toBe(true)
  })

  it('rebases unsaved edits onto a newer source revision and keeps editing available', () => {
    const store = loaded()
    store.commands.setStyles('box', { left: 610 })
    store.load({ ...fixture(), revision: 0 }, atoms)
    expect(store.getSnapshot().blocked).toBe(false)
    expect(styles(store, 'box').left).toBe(610)
    const remote = fixture()
    remote.pages[0]!.name = 'Remote page'
    store.load({ ...remote, revision: 1 }, atoms)
    expect(styles(store, 'box').left).toBe(610)
    expect(store.getSnapshot().file?.pages[0]?.name).toBe('Remote page')
    expect(store.getSnapshot().dirty).toBe(true)
    expect(store.getSnapshot().blocked).toBe(false)
    expect(store.getSnapshot().error).toBeNull()
    expect(store.commands.setStyles('box', { top: 410 })).toBe(true)
    expect(styles(store, 'box')).toMatchObject({ left: 610, top: 410 })
  })
})

describe('AT-CAN-005 drag subscription isolation', () => {
  it('keeps the React view snapshot stable while only pointer transient geometry changes', () => {
    const store = loaded()
    const baseline = store.getViewSnapshot()
    store.setTransient({ kind: 'pan' })
    expect(store.getViewSnapshot()).toBe(baseline)
    store.setTransient({ kind: 'move', rects: { box: { x: 610, y: 400, width: 50, height: 40 } }, offset: { x: 10, y: 0 }, guides: [], targetFrameId: null, insertion: null })
    expect(store.getViewSnapshot()).toBe(baseline)
    store.setHover('box')
    expect(store.getViewSnapshot()).not.toBe(baseline)
  })
})

describe('AT-CAN document history transfer', () => {
  it('restores checked undo and redo history after reopening without replacing the current file', () => {
    const original = loaded()
    original.commands.setStyles('box', { left: 610 })
    original.commands.setStyles('box', { top: 410 })
    original.undo()
    const saved = { ...file(original), revision: 7 }
    const history = original.getHistory()
    const reopened = createDocumentStore()
    reopened.load(saved, atoms)
    const beforeRestore = file(reopened)
    expect(reopened.restoreHistory(history)).toBe(true)
    expect(file(reopened)).toBe(beforeRestore)
    expect(reopened.getSnapshot().canUndo).toBe(true)
    expect(reopened.getSnapshot().canRedo).toBe(true)
    ;(history.past[0]!.file.nodes.box as { styles: { left: number } }).styles.left = 999
    reopened.undo()
    expect(styles(reopened, 'box')).toEqual({ left: 600, top: 400, width: 50, height: 40 })
    expect(file(reopened).revision).toBe(8)
    reopened.redo()
    expect(styles(reopened, 'box')).toMatchObject({ left: 610, top: 400 })
    reopened.redo()
    expect(styles(reopened, 'box')).toMatchObject({ left: 610, top: 410 })
    expect(reopened.getSnapshot().canRedo).toBe(false)
  })

  it('rejects stale component bindings and invalid selections without replacing existing history', () => {
    const store = loaded()
    store.commands.setStyles('box', { left: 610 })
    const invalid = store.getHistory()
    ;(invalid.past[0]!.file.nodes.label as { componentId: string }).componentId = 'missing-atom'
    expect(store.restoreHistory(invalid)).toBe(false)
    expect(store.getSnapshot().error).toBe('Document history could not be restored.')
    const invalidSelection = store.getHistory()
    invalidSelection.past[0]!.selection = ['missing-node']
    expect(store.restoreHistory(invalidSelection)).toBe(false)
    const missingPage = store.getHistory()
    missingPage.past[0]!.pageId = 'page-404'
    expect(store.restoreHistory(missingPage)).toBe(false)
    expect(styles(store, 'box').left).toBe(610)
    expect(store.getSnapshot().canUndo).toBe(true)
    store.undo()
    expect(styles(store, 'box').left).toBe(600)
    expect(store.getSnapshot().blocked).toBe(false)
    expect(store.getSnapshot().error).toBeNull()
  })

  it('clones and bounds exported history to the nearest twenty entries and rejects oversized input', () => {
    const store = loaded()
    for (let left = 601; left <= 625; left++) store.commands.setStyles('box', { left })
    const history = store.getHistory()
    expect(history.past).toHaveLength(20)
    expect((history.past[0]!.file.nodes.box as { styles: { left: number } }).styles.left).toBe(605)
    expect((history.past[19]!.file.nodes.box as { styles: { left: number } }).styles.left).toBe(624)
    ;(history.past[19]!.file.nodes.box as { styles: { left: number } }).styles.left = 999
    store.undo()
    expect(styles(store, 'box').left).toBe(624)
    expect(store.restoreHistory({ past: Array.from({ length: 21 }, () => ({ file: fixture(), pageId: 'page-1', selection: [] })), future: [] })).toBe(false)
    for (let index = 0; index < 24; index++) store.undo()
    const future = store.getHistory()
    expect(future.past).toEqual([])
    expect(future.future).toHaveLength(20)
    expect(future.future[19]!.redo).toEqual({ type: 'node.setStyles', nodeId: 'box', styles: { left: 601 } })
    expect(createDocumentStore().restoreHistory({ past: [], future: [] })).toBe(false)
  })
})
