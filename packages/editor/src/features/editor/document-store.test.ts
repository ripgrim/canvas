import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Atom } from './types'
import type { Appearance, FileDocument, Paint, PrimitiveNode, Stroke } from '@canvas/repo-engine/file-document'
import type { ImageAssetReference } from '@canvas/repo-engine/appearance'
import { ancestorsOf, childrenOf, createBlankFile, descendantsOf, legacyTextProperties, nodeAppearance, nodeIsLocked, pageOfNode, worldPosition } from '@canvas/repo-engine/file-document'
import { codeComponentValueId } from '@canvas/repo-engine/component-admission'
import { componentDefaultProps, componentInsertionPoint, createDocumentStore } from './document-store'
import { connectedRegistryDefinitions } from './component-registry'
import { canvasComponentNode, mapParallelComponentSubtrees } from './component-canvas-link'
import type { Scene } from './canvas-scene'
import type { EditorPersistenceIntent } from '../../capabilities'

const atom = (name: string, componentId: string, props: Atom['props']): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props })
const atoms: Atom[] = [
  { ...atom('Card', 'card-component', [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'heading', type: 'ReactNode', optional: true }, { name: 'footer', type: 'ReactNode', optional: true }]), slots: ['children', 'heading', 'footer'] },
  { ...atom('Label', 'label-component', [{ name: 'children', type: 'ReactNode', optional: true }]), slots: ['children'] },
]
const hex = (value: string) => ({ kind: 'literal' as const, color: { kind: 'hex' as const, hex: value } })
const solid = (id: string, value: string) => ({ id, type: 'solid' as const, color: hex(value) })
const label = (id: string, text: string) => ({ id, type: 'component' as const, componentId: 'label-component', exportName: 'Label', props: { children: text } })

/**
 * Page 1: outer (100,50 400x300) > inner (20,30 200x100); box (600,400 50x40); card with three Labels in `children`
 * and one in `footer`. Page 2: other (0,0 80x80). Every primitive has one solid fill named `<id>-fill`.
 */
const fixture = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'file-1', revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    outer: { id: 'outer', type: 'frame', name: 'Outer', styles: { relativeTransform: [1, 0, 0, 1, 100, 50], width: 400, height: 300, overflow: 'clip' }, appearance: { fills: [solid('outer-fill', '#ffffff')] } },
    inner: { id: 'inner', type: 'frame', name: 'Inner', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 200, height: 100, overflow: 'clip' }, appearance: { fills: [solid('inner-fill', '#ffffff')] } },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 600, 400], width: 50, height: 40 }, appearance: { fills: [solid('box-fill', '#d9d9d9')] } },
    card: { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {} },
    label: label('label', 'Email'),
    hint: label('hint', 'Password'),
    note: label('note', 'Forgot'),
    'footer-label': label('footer-label', 'Footer'),
    other: { id: 'other', type: 'frame', name: 'Other', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 80, overflow: 'clip' }, appearance: { fills: [solid('other-fill', '#ffffff')] } },
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
const styles = (store: ReturnType<typeof createDocumentStore>, id: string) => { const node = file(store).nodes[id]; if (!node || node.type === 'root' || node.type === 'component') throw new Error(`${id} is not a primitive`); const { relativeTransform: transform, ...size } = node.styles; return { ...size, left: transform[4], top: transform[5] } }
const at = (left: number, top: number) => ({ relativeTransform: [1, 0, 0, 1, left, top] as const })
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
    expect(store.commands.setStyles('outer', { ...at(125, 50), width: 420 })).toBe(true)
    expect(styles(store, 'outer')).toMatchObject({ left: 125, top: 50, width: 420 })
    expect(store.commands.rename('outer', 'Locked frame')).toBe(true)
    expect(file(store).nodes.outer).toMatchObject({ name: 'Locked frame', isLocked: true })
  })

  it('AT-CAN-001 reparents a layer-tree selection in one undoable transaction', () => {
    const store = loaded()
    expect(store.commands.layerTreeDrop(['box'], { parentId: 'outer', index: 1 })).toBe(true)
    expect(file(store).relationships.box!.parentId).toBe('outer')
    expect(childrenOf(file(store), 'outer')).toEqual(['inner', 'box'])
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(file(store).relationships.box!.parentId).toBe('root-1')
  })

  it('AT-CAN-001 Alt-duplicates a subtree at the target without moving its source', () => {
    const store = loaded()
    expect(store.commands.layerTreeDrop(['box'], { parentId: 'outer', index: 1, duplicate: true })).toBe(true)
    expect(file(store).relationships.box!.parentId).toBe('root-1')
    expect(file(store).relationships['new-1']).toMatchObject({ parentId: 'outer' })
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(store.getHistory().past).toHaveLength(1)
  })

  it('AT-CAN-001 converts a child leaving Flex to freeform without changing its world position', () => {
    const source = fixture()
    const outer = source.nodes.outer!
    const inner = source.nodes.inner!
    if (outer.type !== 'frame' || inner.type !== 'frame') throw new Error('Fixture frames are missing')
    outer.layout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } }
    inner.layout = { item: { position: { mode: 'flow' } } }
    const store = loadedFrom(source)
    const before = worldPosition(file(store), 'inner')
    expect(store.commands.layerTreeDrop(['inner'], { parentId: null, index: 1 })).toBe(true)
    expect(file(store).nodes.inner).toMatchObject({ layout: { item: { position: { mode: 'freeform' } } } })
    expect(worldPosition(file(store), 'inner')).toEqual(before)
  })

  it('AT-CAN-001 rejects cyclic and type-invalid drops without creating history', () => {
    const store = loaded()
    expect(store.commands.layerTreeDrop(['outer'], { parentId: 'inner', index: 0 })).toBe(false)
    expect(store.commands.layerTreeDrop(['box'], { parentId: 'card', index: 0 })).toBe(false)
    expect(store.commands.setLocked('box', true)).toBe(true)
    const historyAfterLock = store.getHistory().past.length
    expect(store.commands.layerTreeDrop(['box'], { parentId: 'outer', index: 0 })).toBe(false)
    expect(store.getHistory().past).toHaveLength(historyAfterLock)
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

  it('COMP-V2-UI-017 duplicates and deletes page-scoped component records with their nodes', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'other' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `page-component-${++id}`)
    store.load(source, atoms)
    expect(store.setPage('page-2')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const sourceInstance = Object.values(file(store).componentModel.instances)[0]!

    const copyPageId = store.commands.duplicatePage('page-2')!
    const copiedInstance = Object.values(file(store).componentModel.instances).find(instance => instance.id !== sourceInstance.id)!
    expect(copiedInstance).toEqual({ id: copiedInstance.id, componentId: 'canvas', values: {} })
    expect(pageOfNode(file(store), copiedInstance.id)).toBe(copyPageId)

    expect(store.commands.deletePage(copyPageId)).toBe(true)
    expect(file(store).componentModel.instances[copiedInstance.id]).toBeUndefined()
    expect(file(store).nodes[copiedInstance.id]).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[copiedInstance.id]).toEqual(copiedInstance)
    expect(pageOfNode(file(store), copiedInstance.id)).toBe(copyPageId)
  })

  it('COMP-V2-UI-018 deletes page-owned masters without orphaning instances on other pages', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `delete-master-page-${++id}`)
    store.load(source, atoms)
    expect(store.setPage('page-2')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    expect(pageOfNode(file(store), instance.id)).toBe('page-2')

    expect(store.commands.deletePage('page-1')).toBe(true)
    expect(file(store).componentModel).toEqual({ definitions: {}, instances: {} })
    expect(file(store).nodes[instance.id]).toBeDefined()
    expect(canvasComponentNode(file(store), instance.id)).toBeNull()

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.canvas).toBeDefined()
    expect(file(store).componentModel.instances[instance.id]).toEqual(instance)
    expect(canvasComponentNode(file(store), instance.id)).toMatchObject({ role: 'instance' })
  })

  it('never deletes the last page', () => {
    const store = loaded()
    expect(store.commands.deletePage('page-2')).toBe(true)
    expect(store.commands.deletePage('page-1')).toBe(false)
    expect(file(store).pages.map(page => page.id)).toEqual(['page-1'])
  })
})

describe('component model editor commands', () => {
  it('COMP-V2-UI-002 creates a canvas master from the selected layer and reopens it', () => {
    const store = loaded()
    store.select('box')
    expect(store.commands.components.createFromSelection('Notice')).toBe(true)
    const definition = Object.values(file(store).componentModel.definitions)[0]!
    expect(definition).toMatchObject({ name: 'Notice', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0 })
    store.select('outer')
    expect(store.commands.components.openMaster(definition.id)).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['box'])
    expect(store.commands.components.createFromSelection('Duplicate')).toBe(false)
  })

  it('COMP-V2-UI-015 renames a canvas component without changing its identity or instances', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `rename-component-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!

    expect(store.commands.components.rename('canvas', '  Notice  ')).toBe(true)
    expect(file(store).componentModel.definitions.canvas).toMatchObject({ id: 'canvas', name: 'Notice', revision: 1, source: { kind: 'canvas', masterRootId: 'box' } })
    expect(file(store).componentModel.instances[instance.id]).toEqual(instance)
    expect(canvasComponentNode(file(store), 'box')).toMatchObject({ definition: { id: 'canvas', name: 'Notice' } })
    expect(canvasComponentNode(file(store), instance.id)).toMatchObject({ definition: { id: 'canvas', name: 'Notice' } })
    expect(store.commands.components.rename('canvas', 'Notice')).toBe(false)

    store.select('outer')
    expect(store.commands.components.createFromSelection('Other')).toBe(true)
    const other = Object.values(file(store).componentModel.definitions).find(definition => definition.id !== 'canvas')!
    expect(store.commands.components.rename(other.id, 'notice')).toBe(false)
    store.select('inner')
    expect(store.commands.components.createFromSelection('NOTICE')).toBe(false)

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions[other.id]).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.canvas).toMatchObject({ id: 'canvas', name: 'Canvas', revision: 0 })
    expect(file(store).componentModel.instances[instance.id]).toEqual(instance)
  })

  it('COMP-V2-UI-064 saves documentation details with a stable unique slug and one-step Undo', () => {
    const source = fixture()
    source.componentModel = { definitions: {
      primary: { id: 'primary', name: 'Primary button', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      secondary: { id: 'secondary', name: 'Primary-Button', source: { kind: 'canvas', masterRootId: 'inner' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore()
    store.load(source, atoms)

    expect(store.commands.components.setDetails('primary', { name: 'Primary button', description: 'Triggers the primary action.' })).toBe(true)
    expect(file(store).componentModel.definitions.primary).toMatchObject({ revision: 1, docs: { slug: 'primary-button-2', description: 'Triggers the primary action.' } })
    expect(store.commands.components.setDetails('primary', { name: 'Action button', description: 'Triggers the primary action.' })).toBe(true)
    expect(file(store).componentModel.definitions.primary).toMatchObject({ name: 'Action button', revision: 2, docs: { slug: 'primary-button-2', description: 'Triggers the primary action.' } })

    expect(store.commands.components.setDetails('secondary', { name: 'Primary-Button', description: 'Secondary action.' })).toBe(true)
    expect(file(store).componentModel.definitions.secondary).toMatchObject({ docs: { slug: 'primary-button', description: 'Secondary action.' } })
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.secondary).toMatchObject({ revision: 0, name: 'Primary-Button' })
    expect(file(store).componentModel.definitions.secondary).not.toHaveProperty('docs')
  })

  it('COMP-V2-UI-003 places code instances and keeps property overrides isolated', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      'label-component': {
        id: 'label-component', name: 'Label', source: { kind: 'code', bindingId: 'binding-label' }, revision: 0,
        properties: [{ id: 'text', name: 'children', type: 'text', defaultValue: 'Default' }], materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `model-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('label-component')).toBe(true)
    expect(store.commands.components.place('label-component')).toBe(true)
    const instances = Object.values(file(store).componentModel.instances)
    expect(instances).toHaveLength(2)
    expect(store.commands.components.setInstanceValue(instances[0]!.id, 'text', 'Changed')).toBe(true)
    expect(file(store).componentModel.instances[instances[0]!.id]!.values).toEqual({ text: 'Changed' })
    expect(file(store).componentModel.instances[instances[1]!.id]!.values).toEqual({})
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[instances[0]!.id]!.values).toEqual({})
  })

  it('COMP-V2-CODE-001 reconciles a verified code definition and projects model values and slots onto its real node', () => {
    let id = 0
    const source = fixture()
    const button: Atom = {
      componentId: 'component:button', name: 'Button', exportName: 'Button', path: 'components/ui/button.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom',
      props: [{ name: 'label', type: 'string', optional: false }, { name: 'tone', type: "'quiet' | 'solid'", optional: false }, { name: 'children', type: 'ReactNode', optional: true }],
      slots: ['children'],
    }
    const store = createDocumentStore(() => `code-model-${++id}`)
    store.load(source, [...atoms, button])
    expect(store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions([button]))).toBe(true)
    expect(store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions([button]))).toBe(true)
    expect(file(store).componentModel.definitions['component:button']).toMatchObject({ revision: 0, source: { kind: 'code', bindingId: 'component:button' } })

    expect(store.commands.components.place('component:button')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    expect(file(store).nodes[instance.id]).toMatchObject({ type: 'component', props: { label: '', tone: 'quiet' } })
    expect(store.commands.components.setInstanceValue(instance.id, 'property:label', 'Continue')).toBe(true)
    expect(store.commands.components.setInstanceValue(instance.id, 'property:tone', codeComponentValueId('solid'))).toBe(true)
    expect(file(store).nodes[instance.id]).toMatchObject({ type: 'component', props: { label: 'Continue', tone: 'solid' } })
    expect(store.commands.components.addSlotContent(instance.id, 'property:children', 'text')).toBe(true)
    expect(childrenOf(file(store), instance.id, 'children')).toHaveLength(1)
  })

  it('COMP-V2-UI-038 adopts existing verified code nodes into the semantic instance model', () => {
    const source = createBlankFile('legacy-code-instance', 'page', 'root', 'Page')
    const button: Atom = {
      componentId: 'component:button', name: 'Button', exportName: 'Button', path: 'components/ui/button.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom',
      props: [
        { name: 'label', type: 'string', optional: false },
        { name: 'tone', type: "'quiet' | 'solid'", optional: false },
        { name: 'count', type: 'number', optional: false },
      ],
    }
    source.nodes.instance = { id: 'instance', type: 'component', componentId: button.componentId, exportName: button.exportName, props: { label: 'Continue', tone: 'solid', count: 3 } }
    source.relationships.instance = { parentId: 'root', orderKey: 'V' }
    const store = createDocumentStore()
    store.load(source, [button])

    expect(store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions([button]), [button])).toBe(true)
    expect(file(store).componentModel.instances.instance).toEqual({
      id: 'instance',
      componentId: button.componentId,
      values: { 'property:label': 'Continue', 'property:tone': codeComponentValueId('solid') },
    })
    expect(file(store).nodes.instance).toMatchObject({ props: { label: 'Continue', tone: 'solid', count: 3 } })
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('COMP-V2-CODE-001 reconciles changed code schemas without remapping variants or retaining removed props', () => {
    let id = 0
    const source = createBlankFile('code-schema-file', 'page', 'root', 'Page')
    const button = (props: Atom['props']): Atom => ({
      componentId: 'component:button', name: 'Button', exportName: 'Button', path: 'components/ui/button.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom', props,
    })
    const original = button([{ name: 'label', type: 'string', optional: false }, { name: 'tone', type: "'quiet' | 'solid'", optional: false }])
    const updated = button([{ name: 'tone', type: "'quiet' | 'danger'", optional: false }])
    const store = createDocumentStore(() => `code-schema-${++id}`)
    const onError = vi.fn()
    store.configure({ onError })
    store.load(source, [...atoms, original])
    expect(store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions([original]))).toBe(true)
    expect(store.commands.components.place('component:button')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    expect(store.commands.components.setInstanceValue(instance.id, 'property:label', 'Continue')).toBe(true)
    expect(store.commands.components.setInstanceValue(instance.id, 'property:tone', codeComponentValueId('solid'))).toBe(true)

    const reconciled = store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions([updated]), [...atoms, updated])
    expect(onError.mock.calls).toEqual([])
    expect(reconciled).toBe(true)
    expect(file(store).componentModel.instances[instance.id]!.values).toEqual({})
    expect(file(store).nodes[instance.id]).toMatchObject({ type: 'component', props: { tone: 'quiet' } })
    expect(file(store).nodes[instance.id]).not.toHaveProperty('props.label')
    const tone = file(store).componentModel.definitions['component:button']!.properties[0]!
    expect(tone).toMatchObject({ type: 'variant', defaultValueId: codeComponentValueId('quiet') })

    expect(store.getSnapshot().atoms.find(candidate => candidate.componentId === 'component:button')?.props).toEqual(updated.props)
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('COMP-V2-UI-004 places a canvas component as an isolated instance beside its master', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `canvas-instance-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    expect(instance).toEqual({ id: 'canvas-instance-1', componentId: 'canvas', values: {} })
    expect(file(store).nodes[instance.id]).toMatchObject({ id: instance.id, type: 'rectangle', styles: { relativeTransform: [1, 0, 0, 1, 670, 400] } })
    expect(file(store).nodes.box).toMatchObject({ id: 'box', styles: { relativeTransform: [1, 0, 0, 1, 600, 400] } })
    expect(canvasComponentNode(file(store), 'box')).toMatchObject({ role: 'master', definition: { id: 'canvas', name: 'Canvas' } })
    expect(canvasComponentNode(file(store), instance.id)).toMatchObject({ role: 'instance', definition: { id: 'canvas', name: 'Canvas' } })
    expect(canvasComponentNode(file(store), 'outer')).toBeNull()
    expect(store.getSnapshot().selection).toEqual([instance.id])
    expect(store.commands.components.createFromSelection('Nested component')).toBe(false)
    expect(store.undo()).toBe(true)
    expect(file(store).nodes[instance.id]).toBeUndefined()
    expect(file(store).componentModel.instances).toEqual({})
  })

  it('COMP-V2-UI-017 preserves component identity and sparse values through duplication', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `duplicate-component-${++id}`)
    store.load(source, atoms)
    const propertyId = store.commands.components.addProperty('canvas', 'variant')!
    const valueId = store.commands.components.addVariantValue('canvas', propertyId)!
    expect(store.commands.components.place('canvas', { [propertyId]: valueId })).toBe(true)
    const sourceInstance = Object.values(file(store).componentModel.instances)[0]!

    expect(store.commands.duplicate(sourceInstance.id)).toBe(true)
    const copyId = store.getSnapshot().selection[0]!
    expect(file(store).componentModel.instances[copyId]).toEqual({ id: copyId, componentId: 'canvas', values: { [propertyId]: valueId } })
    expect(canvasComponentNode(file(store), copyId)).toMatchObject({ role: 'instance', definition: { id: 'canvas' } })

    expect(store.commands.commitMove([{ id: copyId, x: 820, y: 420 }], { duplicate: true }).committed).toBe(true)
    const movedCopyId = store.getSnapshot().selection[0]!
    expect(file(store).componentModel.instances[movedCopyId]).toEqual({ id: movedCopyId, componentId: 'canvas', values: { [propertyId]: valueId } })
    expect(canvasComponentNode(file(store), movedCopyId)).toMatchObject({ role: 'instance', definition: { id: 'canvas' } })

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[movedCopyId]).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[copyId]).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(Object.keys(file(store).componentModel.instances)).toEqual([sourceInstance.id, copyId, movedCopyId])
  })

  it('COMP-V2-UI-017 preserves nested component identities when placing an outer master', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      'outer-component': { id: 'outer-component', name: 'Outer', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      'badge-component': { id: 'badge-component', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `nested-place-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('badge-component')).toBe(true)
    const badge = Object.values(file(store).componentModel.instances)[0]!
    expect(store.commands.reparent(badge.id, 'outer')).toBe(true)

    expect(store.commands.components.place('outer-component')).toBe(true)
    const instances = Object.values(file(store).componentModel.instances)
    const outer = instances.find(instance => instance.componentId === 'outer-component')!
    const nestedBadge = instances.find(instance => instance.componentId === 'badge-component' && instance.id !== badge.id)!
    expect(outer).toBeDefined()
    expect(nestedBadge).toEqual({ id: nestedBadge.id, componentId: 'badge-component', values: {} })
    expect([outer.id, ...descendantsOf(file(store), outer.id)]).toContain(nestedBadge.id)
    expect(canvasComponentNode(file(store), nestedBadge.id)).toMatchObject({ role: 'instance', definition: { id: 'badge-component' } })

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[outer.id]).toBeUndefined()
    expect(file(store).componentModel.instances[nestedBadge.id]).toBeUndefined()
    expect(file(store).componentModel.instances[badge.id]).toBeDefined()
  })

  it('COMP-V2-UI-014 removes component semantics without deleting canvas content', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `remove-component-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instanceIds = Object.keys(file(store).componentModel.instances)
    expect(instanceIds).toHaveLength(2)

    expect(store.commands.components.remove('canvas')).toBe(true)
    expect(file(store).componentModel).toEqual({ definitions: {}, instances: {} })
    expect(file(store).nodes.box).toBeDefined()
    for (const instanceId of instanceIds) expect(file(store).nodes[instanceId]).toBeDefined()
    expect(canvasComponentNode(file(store), 'box')).toBeNull()
    for (const instanceId of instanceIds) expect(canvasComponentNode(file(store), instanceId)).toBeNull()

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.canvas).toBeDefined()
    expect(Object.keys(file(store).componentModel.instances).sort()).toEqual([...instanceIds].sort())
    expect(canvasComponentNode(file(store), 'box')).toMatchObject({ role: 'master' })
    for (const instanceId of instanceIds) expect(canvasComponentNode(file(store), instanceId)).toMatchObject({ role: 'instance' })
  })

  it('COMP-V2-UI-018 deletes an instance node and its semantic record together', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `delete-instance-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!

    expect(store.commands.delete([instance.id])).toBe(true)
    expect(file(store).nodes[instance.id]).toBeUndefined()
    expect(file(store).componentModel.instances[instance.id]).toBeUndefined()
    expect(file(store).componentModel.definitions.canvas).toBeDefined()

    expect(store.undo()).toBe(true)
    expect(file(store).nodes[instance.id]).toBeDefined()
    expect(file(store).componentModel.instances[instance.id]).toEqual(instance)
  })

  it('COMP-V2-UI-039 detaches one canvas instance without changing its subtree or nested component identities', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      outer: { id: 'outer', name: 'Outer', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      code: { id: 'code', name: 'Code', source: { kind: 'code', bindingId: 'code' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `detach-instance-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('badge')).toBe(true)
    const nestedSource = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'badge')!
    expect(store.commands.reparent(nestedSource.id, 'outer')).toBe(true)
    expect(store.commands.components.place('outer')).toBe(true)
    const outerInstance = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'outer')!
    const nestedInstanceId = mapParallelComponentSubtrees(file(store), 'outer', outerInstance.id)!.get(nestedSource.id)!
    const beforeNodes = structuredClone(file(store).nodes)
    const beforeRelationships = structuredClone(file(store).relationships)

    expect(store.commands.components.detach(outerInstance.id)).toBe(true)
    expect(file(store).componentModel.instances[outerInstance.id]).toBeUndefined()
    expect(file(store).componentModel.instances[nestedInstanceId]).toMatchObject({ componentId: 'badge' })
    expect(file(store).nodes).toEqual(beforeNodes)
    expect(file(store).relationships).toEqual(beforeRelationships)
    expect(canvasComponentNode(file(store), outerInstance.id)).toBeNull()
    expect(canvasComponentNode(file(store), nestedInstanceId)).toMatchObject({ role: 'instance', definition: { id: 'badge' } })
    expect(store.commands.components.detach('missing')).toBe(false)

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[outerInstance.id]).toEqual(outerInstance)
    expect(canvasComponentNode(file(store), outerInstance.id)).toMatchObject({ role: 'instance', definition: { id: 'outer' } })
  })

  it('COMP-V2-UI-041 resets every sparse instance value and its projection in one undoable transaction', () => {
    let id = 0
    const source = fixture()
    const base = structuredClone(nodeAppearance(source.nodes.box)!)
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0,
        properties: [
          { id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', currentValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'box', appearances: { default: base, hover: { ...base, opacity: 0.5 } } } },
          { id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'box' } },
        ],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `reset-instance-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas', { state: 'hover', visible: false })).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    expect(instance.values).toEqual({ state: 'hover', visible: false })
    expect(nodeAppearance(file(store).nodes[instance.id])).toMatchObject({ opacity: 0.5, visible: false })

    expect(store.commands.components.resetInstanceValues(instance.id)).toBe(true)
    expect(file(store).componentModel.instances[instance.id]!.values).toEqual({})
    expect(nodeAppearance(file(store).nodes[instance.id])).toEqual(base)
    expect(store.commands.components.resetInstanceValues(instance.id)).toBe(false)

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[instance.id]!.values).toEqual({ state: 'hover', visible: false })
    expect(nodeAppearance(file(store).nodes[instance.id])).toMatchObject({ opacity: 0.5, visible: false })
  })

  it('COMP-V2-UI-018 deletes a canvas master without orphaning its placed content', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `delete-master-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instances = Object.values(file(store).componentModel.instances)

    expect(store.commands.delete(['box'])).toBe(true)
    expect(file(store).nodes.box).toBeUndefined()
    expect(file(store).componentModel).toEqual({ definitions: {}, instances: {} })
    for (const instance of instances) {
      expect(file(store).nodes[instance.id]).toBeDefined()
      expect(canvasComponentNode(file(store), instance.id)).toBeNull()
    }

    expect(store.undo()).toBe(true)
    expect(file(store).nodes.box).toBeDefined()
    expect(file(store).componentModel.definitions.canvas).toBeDefined()
    for (const instance of instances) expect(file(store).componentModel.instances[instance.id]).toEqual(instance)
  })

  it('COMP-V2-UI-019 removes property, part, interaction, and override references with a deleted master layer', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0,
        properties: [{
          id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', currentValueId: 'default',
          values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }],
          binding: { kind: 'variant', nodeId: 'inner', appearances: { default: {}, hover: { opacity: 0.5 } } },
        }],
        materials: [{ id: 'surface', name: 'Surface', group: 'Layer', appearance: {} }],
        parts: [{ id: 'inner-part', name: 'Inner', nodeId: 'inner', materialId: 'surface' }],
        interactions: [{ id: 'hover-interaction', trigger: 'pointer-hover', propertyId: 'state', valueId: 'hover', transition: { type: 'instant' } }],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `delete-bound-layer-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas', { state: 'hover' })).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    const instanceInner = mapParallelComponentSubtrees(file(store), 'outer', instance.id)!.get('inner')!

    expect(store.commands.delete(['inner'])).toBe(true)
    expect(file(store).nodes.inner).toBeUndefined()
    expect(file(store).nodes[instanceInner]).toBeUndefined()
    expect(file(store).componentModel.definitions.canvas).toMatchObject({ revision: 1, properties: [], parts: [], interactions: [] })
    expect(file(store).componentModel.instances[instance.id]!.values).toEqual({})

    expect(store.undo()).toBe(true)
    expect(file(store).nodes.inner).toBeDefined()
    expect(file(store).nodes[instanceInner]).toBeDefined()
    expect(file(store).componentModel.definitions.canvas).toMatchObject({ revision: 0, properties: [{ id: 'state' }], parts: [{ id: 'inner-part' }], interactions: [{ propertyId: 'state' }] })
    expect(file(store).componentModel.instances[instance.id]!.values).toEqual({ state: 'hover' })
  })

  it('COMP-V2-UI-019 removes nested component records from deleted master branches and their mirrors', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      outer: { id: 'outer', name: 'Outer', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `delete-nested-branch-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('badge')).toBe(true)
    const sourceBadge = Object.values(file(store).componentModel.instances)[0]!
    expect(store.commands.reparent(sourceBadge.id, 'inner')).toBe(true)
    expect(store.commands.components.place('outer')).toBe(true)
    const outerInstance = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'outer')!
    const copiedBadge = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'badge' && instance.id !== sourceBadge.id)!
    expect([outerInstance.id, ...descendantsOf(file(store), outerInstance.id)]).toContain(copiedBadge.id)

    expect(store.commands.delete(['inner'])).toBe(true)
    expect(file(store).nodes[sourceBadge.id]).toBeUndefined()
    expect(file(store).nodes[copiedBadge.id]).toBeUndefined()
    expect(file(store).componentModel.instances[sourceBadge.id]).toBeUndefined()
    expect(file(store).componentModel.instances[copiedBadge.id]).toBeUndefined()
    expect(file(store).componentModel.instances[outerInstance.id]).toEqual(outerInstance)
    expect(file(store).componentModel.definitions.badge).toBeDefined()

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[sourceBadge.id]).toEqual(sourceBadge)
    expect(file(store).componentModel.instances[copiedBadge.id]).toEqual(copiedBadge)
  })

  it('COMP-V2-UI-020 protects linked instance structure while leaving slot content editable', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0,
        properties: [{ id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'inner' } }],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `protected-instance-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    const instanceInner = mapParallelComponentSubtrees(file(store), 'outer', instance.id)!.get('inner')!
    const history = store.getHistory().past.length

    expect(store.commands.delete([instanceInner])).toBe(false)
    expect(store.commands.duplicate(instanceInner)).toBe(false)
    expect(store.commands.reparent(instanceInner, null)).toBe(false)
    expect(store.commands.layerTreeDrop([instanceInner], { parentId: null, index: 0 })).toBe(false)
    expect(store.commands.commitMove([{ id: instanceInner, x: 800, y: 600 }]).committed).toBe(false)
    store.select(instanceInner)
    expect(store.commands.nudge(4, 6)).toBe(false)
    expect(store.commands.setStyles(instanceInner, { width: 240 })).toBe(false)
    expect(file(store).nodes[instanceInner]).toBeDefined()
    expect(store.getHistory().past).toHaveLength(history)

    expect(store.commands.components.addSlotContent(instance.id, 'content', 'frame')).toBe(true)
    const slotNode = childrenOf(file(store), instanceInner, 'content')[0]!
    expect(store.commands.delete([slotNode])).toBe(true)
    expect(file(store).nodes[slotNode]).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(file(store).nodes[slotNode]).toBeDefined()
  })

  it('COMP-V2-UI-005 keeps canvas instance content linked while preserving its root transform', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `linked-instance-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    const instanceRoot = file(store).nodes[instance.id]!
    const instanceChild = childrenOf(file(store), instance.id)[0]!
    store.select(instanceChild)
    expect(store.commands.components.createFromSelection('Nested component')).toBe(false)
    expect(instanceRoot.type).toBe('frame')
    if (instanceRoot.type === 'root' || instanceRoot.type === 'component') throw new Error('Expected a primitive canvas instance')
    const originalTransform = structuredClone(instanceRoot.styles.relativeTransform)

    expect(store.commands.rename('inner', 'Linked inner')).toBe(true)
    expect(file(store).nodes.inner).toMatchObject({ name: 'Linked inner' })
    expect(file(store).nodes[instanceChild]).toMatchObject({ name: 'Linked inner' })

    expect(store.commands.setStyles('outer', { width: 480, relativeTransform: [1, 0, 0, 1, 240, 260] })).toBe(true)
    const changedRoot = file(store).nodes[instance.id]!
    expect(changedRoot.type).not.toBe('component')
    if (changedRoot.type !== 'root' && changedRoot.type !== 'component') {
      expect(changedRoot.styles.width).toBe(480)
      expect(changedRoot.styles.relativeTransform).toEqual(originalTransform)
    }

    expect(store.undo()).toBe(true)
    const undoneRoot = file(store).nodes[instance.id]!
    if (undoneRoot.type !== 'root' && undoneRoot.type !== 'component') expect(undoneRoot.styles.width).toBe(400)
    expect(store.undo()).toBe(true)
    expect(file(store).nodes.inner).toMatchObject({ name: 'Inner' })
    expect(file(store).nodes[instanceChild]).toMatchObject({ name: 'Inner' })
  })

  it('COMP-V2-UI-006 mirrors structural master edits into every canvas instance', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `structure-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instances = Object.values(file(store).componentModel.instances)

    expect(store.commands.insertCanvas('rectangle', { x: 8, y: 12, width: 20, height: 30, parentId: 'outer' })).toBe(true)
    const insertedMasterId = store.getSnapshot().selection[0]!
    for (const instance of instances) {
      expect(childrenOf(file(store), instance.id)).toHaveLength(2)
      expect(file(store).nodes[childrenOf(file(store), instance.id)[1]!]!.type).toBe('rectangle')
    }

    expect(store.commands.reorderFlow(insertedMasterId, 0).committed).toBe(true)
    expect(childrenOf(file(store), 'outer')[0]).toBe(insertedMasterId)
    for (const instance of instances) expect(file(store).nodes[childrenOf(file(store), instance.id)[0]!]!.type).toBe('rectangle')

    store.select(insertedMasterId)
    expect(store.commands.duplicate()).toBe(true)
    expect(childrenOf(file(store), 'outer')).toHaveLength(3)
    for (const instance of instances) expect(childrenOf(file(store), instance.id)).toHaveLength(3)

    const duplicatedMasterId = store.getSnapshot().selection[0]!
    expect(store.commands.reparent(duplicatedMasterId, 'inner')).toBe(true)
    expect(childrenOf(file(store), 'outer')).toHaveLength(2)
    expect(childrenOf(file(store), 'inner')).toHaveLength(1)
    for (const instance of instances) {
      const instanceInner = childrenOf(file(store), instance.id).find(nodeId => file(store).nodes[nodeId]?.type === 'frame')!
      expect(childrenOf(file(store), instance.id)).toHaveLength(2)
      expect(childrenOf(file(store), instanceInner)).toHaveLength(1)
    }

    expect(store.commands.delete([insertedMasterId])).toBe(true)
    expect(childrenOf(file(store), 'outer')).toHaveLength(1)
    for (const instance of instances) expect(childrenOf(file(store), instance.id)).toHaveLength(1)

    expect(store.undo()).toBe(true)
    expect(childrenOf(file(store), 'outer')).toHaveLength(2)
    for (const instance of instances) expect(childrenOf(file(store), instance.id)).toHaveLength(2)
  })

  it('COMP-V2-UI-007 authors every component property type and sanitizes removed overrides', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `property-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    const variantId = store.commands.components.addProperty('canvas', 'variant')!
    const textId = store.commands.components.addProperty('canvas', 'text')!
    const booleanId = store.commands.components.addProperty('canvas', 'boolean')!
    const slotId = store.commands.components.addProperty('canvas', 'slot')!
    expect([variantId, textId, booleanId, slotId]).toHaveLength(4)

    const secondValueId = store.commands.components.addVariantValue('canvas', variantId)!
    const definition = file(store).componentModel.definitions.canvas!
    const variant = definition.properties.find(property => property.id === variantId)!
    expect(variant.type).toBe('variant')
    if (variant.type !== 'variant') throw new Error('Expected a variant property')
    expect(variant.currentValueId).toBe(secondValueId)
    expect(variant.binding?.appearances[secondValueId]).toEqual(variant.binding?.appearances[variant.defaultValueId])
    expect(store.commands.components.setProperty('canvas', { ...variant, name: 'State', defaultValueId: secondValueId, values: variant.values.map(value => value.id === secondValueId ? { ...value, name: 'Hover' } : value) })).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.properties.map(property => property.type)).toEqual(['variant', 'text', 'boolean', 'slot'])
    expect(file(store).componentModel.definitions.canvas!.revision).toBe(6)

    expect(store.commands.components.setInstanceValue(instance.id, variantId, secondValueId)).toBe(true)
    expect(file(store).componentModel.instances[instance.id]!.values[variantId]).toBe(secondValueId)
    expect(store.commands.components.setInteraction('canvas', 'pointer-hover', variantId, secondValueId)).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.interactions).toMatchObject([{ propertyId: variantId, valueId: secondValueId }])
    expect(store.commands.components.removeProperty('canvas', variantId)).toBe(true)
    expect(file(store).componentModel.instances[instance.id]!.values).not.toHaveProperty(variantId)
    expect(file(store).componentModel.definitions.canvas!.properties.map(property => property.type)).toEqual(['text', 'boolean', 'slot'])
    expect(file(store).componentModel.definitions.canvas!.interactions).toEqual([])
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.properties[0]).toMatchObject({ id: variantId, type: 'variant', name: 'State' })
    expect(file(store).componentModel.instances[instance.id]!.values[variantId]).toBe(secondValueId)
    expect(file(store).componentModel.definitions.canvas!.interactions).toMatchObject([{ propertyId: variantId, valueId: secondValueId }])
  })

  it('COMP-V2-UI-007 removes interactions targeting a deleted variant option', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `option-${++id}`)
    store.load(source, atoms)
    const variantId = store.commands.components.addProperty('canvas', 'variant')!
    const secondValueId = store.commands.components.addVariantValue('canvas', variantId)!
    expect(store.commands.components.setInteraction('canvas', 'pointer-hover', variantId, secondValueId)).toBe(true)
    const definition = file(store).componentModel.definitions.canvas!
    const variant = definition.properties.find(property => property.id === variantId)
    if (variant?.type !== 'variant') throw new Error('Expected a variant property')

    const values = variant.values.filter(value => value.id !== secondValueId)
    const binding = variant.binding ? { ...variant.binding, appearances: Object.fromEntries(values.map(value => [value.id, variant.binding!.appearances[value.id]!])) } : undefined
    expect(store.commands.components.setProperty('canvas', { ...variant, values, ...(binding ? { binding } : {}) })).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.interactions).toEqual([])
  })

  it('COMP-V2-UI-021 removes slot content and nested component records with the Slot property', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0,
        properties: [{ id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'inner' } }],
        materials: [], parts: [], interactions: [],
      },
      badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `remove-slot-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const hosts = Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'canvas')
    expect(store.commands.components.addSlotContent(hosts[0]!.id, 'content', 'frame')).toBe(true)
    const frameHost = mapParallelComponentSubtrees(file(store), 'outer', hosts[0]!.id)!.get('inner')!
    const frameContent = childrenOf(file(store), frameHost, 'content')[0]!
    expect(store.commands.components.addSlotComponent(hosts[1]!.id, 'content', 'badge')).toBe(true)
    const componentHost = mapParallelComponentSubtrees(file(store), 'outer', hosts[1]!.id)!.get('inner')!
    const componentContent = childrenOf(file(store), componentHost, 'content')[0]!
    expect(file(store).componentModel.instances[componentContent]).toMatchObject({ componentId: 'badge' })

    expect(store.commands.components.removeProperty('canvas', 'content')).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.properties).toEqual([])
    expect(file(store).nodes[frameContent]).toBeUndefined()
    expect(file(store).nodes[componentContent]).toBeUndefined()
    expect(file(store).componentModel.instances[componentContent]).toBeUndefined()

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.properties).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'content', type: 'slot' })]))
    expect(file(store).nodes[frameContent]).toBeDefined()
    expect(file(store).nodes[componentContent]).toBeDefined()
    expect(file(store).componentModel.instances[componentContent]).toMatchObject({ componentId: 'badge' })
  })

  it('COMP-V2-UI-023 resets canvas instance visuals when a bound property is removed', () => {
    let id = 0
    const source = fixture()
    source.nodes.caption = { id: 'caption', type: 'text', name: 'Caption', styles: { relativeTransform: [1, 0, 0, 1, 40, 40], width: 120, height: 20 }, text: 'Master label', ...legacyTextProperties() }
    source.relationships.caption = { parentId: 'outer', orderKey: 'W' }
    const defaultAppearance = structuredClone(nodeAppearance(source.nodes.outer) ?? {})
    const hoverAppearance = { ...structuredClone(defaultAppearance), opacity: 0.35 }
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0,
        properties: [
          { id: 'state', name: 'State', type: 'variant', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], defaultValueId: 'default', currentValueId: 'default', binding: { kind: 'variant', nodeId: 'outer', appearances: { default: defaultAppearance, hover: hoverAppearance } } },
          { id: 'label', name: 'Label', type: 'text', defaultValue: 'Master label', binding: { kind: 'text', nodeId: 'caption' } },
          { id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'inner' } },
        ],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `remove-property-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    const map = mapParallelComponentSubtrees(file(store), 'outer', instance.id)!
    const instanceCaption = map.get('caption')!
    const instanceInner = map.get('inner')!
    expect(store.commands.components.setInstanceValue(instance.id, 'state', 'hover')).toBe(true)
    expect(store.commands.components.setInstanceValue(instance.id, 'label', 'Override label')).toBe(true)
    expect(store.commands.components.setInstanceValue(instance.id, 'visible', false)).toBe(true)

    expect(store.commands.components.removeProperty('canvas', 'label')).toBe(true)
    expect(file(store).nodes[instanceCaption]).toMatchObject({ text: 'Master label' })
    expect(file(store).componentModel.instances[instance.id]!.values).not.toHaveProperty('label')
    expect(store.undo()).toBe(true)
    expect(file(store).nodes[instanceCaption]).toMatchObject({ text: 'Override label' })
    expect(file(store).componentModel.instances[instance.id]!.values.label).toBe('Override label')

    expect(store.commands.components.removeProperty('canvas', 'visible')).toBe(true)
    expect(nodeAppearance(file(store).nodes[instanceInner])?.visible).not.toBe(false)
    expect(file(store).componentModel.instances[instance.id]!.values).not.toHaveProperty('visible')
    expect(store.undo()).toBe(true)
    expect(nodeAppearance(file(store).nodes[instanceInner])?.visible).toBe(false)
    expect(file(store).componentModel.instances[instance.id]!.values.visible).toBe(false)

    expect(store.commands.components.removeProperty('canvas', 'state')).toBe(true)
    expect(nodeAppearance(file(store).nodes[instance.id])).toEqual(defaultAppearance)
    expect(file(store).componentModel.instances[instance.id]!.values).not.toHaveProperty('state')
    expect(store.undo()).toBe(true)
    expect(nodeAppearance(file(store).nodes[instance.id])).toEqual(hoverAppearance)
    expect(file(store).componentModel.instances[instance.id]!.values.state).toBe('hover')
  })

  it('COMP-V2-UI-024 resets the old instance layer when a bound property moves', () => {
    let id = 0
    const source = fixture()
    source.nodes.caption = { id: 'caption', type: 'text', name: 'Caption', styles: { relativeTransform: [1, 0, 0, 1, 40, 40], width: 120, height: 20 }, text: 'Primary', ...legacyTextProperties() }
    source.nodes.secondary = { id: 'secondary', type: 'text', name: 'Secondary', styles: { relativeTransform: [1, 0, 0, 1, 40, 80], width: 120, height: 20 }, text: 'Secondary', ...legacyTextProperties() }
    source.relationships.caption = { parentId: 'outer', orderKey: 'W' }
    source.relationships.secondary = { parentId: 'outer', orderKey: 'X' }
    const property = { id: 'label', name: 'Label', type: 'text' as const, defaultValue: 'Primary', binding: { kind: 'text' as const, nodeId: 'caption' } }
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [property], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `rebind-property-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    const map = mapParallelComponentSubtrees(file(store), 'outer', instance.id)!
    const instanceCaption = map.get('caption')!
    const instanceSecondary = map.get('secondary')!
    expect(store.commands.components.setInstanceValue(instance.id, 'label', 'Override')).toBe(true)
    expect(file(store).nodes[instanceCaption]).toMatchObject({ text: 'Override' })
    expect(file(store).nodes[instanceSecondary]).toMatchObject({ text: 'Secondary' })

    expect(store.commands.components.setProperty('canvas', { ...property, defaultValue: 'Secondary', binding: { kind: 'text', nodeId: 'secondary' } })).toBe(true)
    expect(file(store).nodes[instanceCaption]).toMatchObject({ text: 'Primary' })
    expect(file(store).nodes[instanceSecondary]).toMatchObject({ text: 'Override' })
    expect(file(store).componentModel.instances[instance.id]!.values.label).toBe('Override')

    expect(store.undo()).toBe(true)
    expect(file(store).nodes[instanceCaption]).toMatchObject({ text: 'Override' })
    expect(file(store).nodes[instanceSecondary]).toMatchObject({ text: 'Secondary' })
    expect(file(store).componentModel.definitions.canvas!.properties[0]).toEqual(property)
  })

  it('COMP-V2-UI-025 through COMP-V2-UI-031 preserve nested component identities, overrides, duplication, ordering, and extraction', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      'outer-component': { id: 'outer-component', name: 'Outer component', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      badge: {
        id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0,
        properties: [{ id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'box' } }],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `nested-master-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('outer-component')).toBe(true)
    expect(store.commands.components.place('outer-component')).toBe(true)
    const outerInstances = Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'outer-component')
    expect(outerInstances).toHaveLength(2)
    expect(store.commands.components.place('badge')).toBe(true)
    const badgeInstance = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'badge')!

    expect(store.commands.reparent(badgeInstance.id, 'outer')).toBe(true)
    const mirroredBadgeIds = outerInstances.map(instance => mapParallelComponentSubtrees(file(store), 'outer', instance.id)!.get(badgeInstance.id)!)
    for (const mirroredBadgeId of mirroredBadgeIds) expect(file(store).componentModel.instances[mirroredBadgeId]).toMatchObject({ id: mirroredBadgeId, componentId: 'badge', values: {} })

    expect(store.commands.components.setInstanceValue(mirroredBadgeIds[0]!, 'visible', false)).toBe(true)
    expect(file(store).componentModel.instances[mirroredBadgeIds[0]!]!.values.visible).toBe(false)
    expect(file(store).componentModel.instances[mirroredBadgeIds[1]!]!.values).toEqual({})
    expect(file(store).componentModel.instances[badgeInstance.id]!.values).toEqual({})
    expect(nodeAppearance(file(store).nodes[mirroredBadgeIds[0]!])?.visible).toBe(false)
    expect(nodeAppearance(file(store).nodes[mirroredBadgeIds[1]!])?.visible).not.toBe(false)
    expect(nodeAppearance(file(store).nodes[badgeInstance.id])?.visible).not.toBe(false)
    expect(store.undo()).toBe(true)
    for (const mirroredBadgeId of mirroredBadgeIds) expect(file(store).componentModel.instances[mirroredBadgeId]!.values).toEqual({})

    expect(store.commands.components.setInstanceValue(badgeInstance.id, 'visible', false)).toBe(true)
    expect(file(store).componentModel.instances[badgeInstance.id]!.values.visible).toBe(false)
    for (const mirroredBadgeId of mirroredBadgeIds) {
      expect(file(store).componentModel.instances[mirroredBadgeId]!.values.visible).toBe(false)
      expect(nodeAppearance(file(store).nodes[mirroredBadgeId])?.visible).toBe(false)
    }

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[badgeInstance.id]!.values).toEqual({})
    for (const mirroredBadgeId of mirroredBadgeIds) expect(file(store).componentModel.instances[mirroredBadgeId]!.values).toEqual({})

    expect(store.commands.components.setInstanceValue(badgeInstance.id, 'visible', false)).toBe(true)
    expect(store.commands.duplicate(badgeInstance.id)).toBe(true)
    const badgeInstances = Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'badge')
    expect(badgeInstances).toHaveLength(6)
    const masterBadgeInstances = badgeInstances.filter(instance => file(store).relationships[instance.id]?.parentId === 'outer')
    expect(masterBadgeInstances).toHaveLength(2)
    for (const outerInstance of outerInstances) expect(badgeInstances.filter(instance => file(store).relationships[instance.id]?.parentId === outerInstance.id)).toHaveLength(2)
    const duplicatedBadge = masterBadgeInstances.find(instance => instance.id !== badgeInstance.id)!
    const mirroredDuplicateIds = outerInstances.map(instance => mapParallelComponentSubtrees(file(store), 'outer', instance.id)!.get(duplicatedBadge.id)!)
    for (const instanceId of [badgeInstance.id, ...mirroredBadgeIds, duplicatedBadge.id, ...mirroredDuplicateIds]) {
      expect(file(store).componentModel.instances[instanceId]!.values.visible).toBe(false)
      expect(nodeAppearance(file(store).nodes[instanceId])?.visible).toBe(false)
    }
    expect(store.commands.components.setInstanceValue(duplicatedBadge.id, 'visible', true)).toBe(true)
    for (const instanceId of [duplicatedBadge.id, ...mirroredDuplicateIds]) {
      expect(file(store).componentModel.instances[instanceId]!.values.visible).toBe(true)
      expect(nodeAppearance(file(store).nodes[instanceId])?.visible).not.toBe(false)
    }
    for (const instanceId of [badgeInstance.id, ...mirroredBadgeIds]) {
      expect(file(store).componentModel.instances[instanceId]!.values.visible).toBe(false)
      expect(nodeAppearance(file(store).nodes[instanceId])?.visible).toBe(false)
    }
    expect(store.undo()).toBe(true)
    for (const instanceId of [duplicatedBadge.id, ...mirroredDuplicateIds]) expect(file(store).componentModel.instances[instanceId]!.values.visible).toBe(false)
    const semanticRecords = new Map([duplicatedBadge.id, ...mirroredDuplicateIds].map(instanceId => [instanceId, structuredClone(file(store).componentModel.instances[instanceId])]))

    expect(store.commands.reorderFlow(duplicatedBadge.id, 0).committed).toBe(true)
    expect(childrenOf(file(store), 'outer')[0]).toBe(duplicatedBadge.id)
    for (let index = 0; index < outerInstances.length; index += 1) {
      expect(childrenOf(file(store), outerInstances[index]!.id)[0]).toBe(mirroredDuplicateIds[index])
    }
    for (const [instanceId, record] of semanticRecords) expect(file(store).componentModel.instances[instanceId]).toEqual(record)

    expect(store.undo()).toBe(true)
    expect(childrenOf(file(store), 'outer').indexOf(badgeInstance.id)).toBeLessThan(childrenOf(file(store), 'outer').indexOf(duplicatedBadge.id))
    for (let index = 0; index < outerInstances.length; index += 1) {
      const children = childrenOf(file(store), outerInstances[index]!.id)
      expect(children.indexOf(mirroredBadgeIds[index]!)).toBeLessThan(children.indexOf(mirroredDuplicateIds[index]!))
    }
    for (const [instanceId, record] of semanticRecords) expect(file(store).componentModel.instances[instanceId]).toEqual(record)

    expect(store.undo()).toBe(true)
    expect(Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'badge').map(instance => instance.id).sort()).toEqual([badgeInstance.id, ...mirroredBadgeIds].sort())
    expect(store.undo()).toBe(true)
    for (const instanceId of [badgeInstance.id, ...mirroredBadgeIds]) expect(file(store).componentModel.instances[instanceId]!.values).toEqual({})

    expect(store.commands.reparent(badgeInstance.id, null)).toBe(true)
    expect(file(store).relationships[badgeInstance.id]?.parentId).toBe('root-1')
    for (const mirroredBadgeId of mirroredBadgeIds) {
      expect(file(store).nodes[mirroredBadgeId]).toBeUndefined()
      expect(file(store).componentModel.instances[mirroredBadgeId]).toBeUndefined()
    }
    expect(file(store).componentModel.instances[badgeInstance.id]).toBeDefined()
    expect(store.undo()).toBe(true)
    expect(file(store).relationships[badgeInstance.id]?.parentId).toBe('outer')
    for (const mirroredBadgeId of mirroredBadgeIds) {
      expect(file(store).nodes[mirroredBadgeId]).toBeDefined()
      expect(file(store).componentModel.instances[mirroredBadgeId]).toBeDefined()
    }

    expect(store.undo()).toBe(true)
    expect(file(store).relationships[badgeInstance.id]?.parentId).toBe('root-1')
    for (const mirroredBadgeId of mirroredBadgeIds) {
      expect(file(store).nodes[mirroredBadgeId]).toBeUndefined()
      expect(file(store).componentModel.instances[mirroredBadgeId]).toBeUndefined()
    }
  })

  it('COMP-V2-UI-030 rejects recursive component reparenting atomically', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      outer: { id: 'outer', name: 'Outer', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `recursive-${++id}`)
    store.load(source, atoms)

    expect(store.commands.components.place('outer')).toBe(true)
    const outerInstance = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'outer')!
    const beforeDirectCycle = structuredClone(file(store))
    expect(store.commands.reparent(outerInstance.id, 'outer')).toBe(false)
    expect(file(store)).toEqual(beforeDirectCycle)

    expect(store.commands.components.place('badge')).toBe(true)
    const badgeInstance = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'badge')!
    expect(store.commands.reparent(badgeInstance.id, 'outer')).toBe(true)
    const beforeIndirectCycle = structuredClone(file(store))
    expect(store.commands.reparent(outerInstance.id, 'box')).toBe(false)
    expect(file(store)).toEqual(beforeIndirectCycle)
  })

  it('COMP-V2-UI-032 synchronizes and removes components through a three-level tree', () => {
    let id = 0
    const source = fixture()
    source.nodes['b-master'] = { id: 'b-master', type: 'frame', name: 'B master', styles: { relativeTransform: [1, 0, 0, 1, 600, 0], width: 100, height: 100 } }
    source.nodes['c-master'] = { id: 'c-master', type: 'frame', name: 'C master', styles: { relativeTransform: [1, 0, 0, 1, 800, 0], width: 100, height: 100 } }
    source.nodes['c-label'] = { id: 'c-label', type: 'text', name: 'C label', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 20 }, text: 'Default C', ...legacyTextProperties() }
    source.relationships['b-master'] = { parentId: 'root-1', orderKey: 'X' }
    source.relationships['c-master'] = { parentId: 'root-1', orderKey: 'Y' }
    source.relationships['c-label'] = { parentId: 'c-master', orderKey: 'V' }
    source.componentModel = { definitions: {
      a: { id: 'a', name: 'A', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      b: { id: 'b', name: 'B', source: { kind: 'canvas', masterRootId: 'b-master' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      c: {
        id: 'c', name: 'C', source: { kind: 'canvas', masterRootId: 'c-master' }, revision: 0,
        properties: [
          { id: 'c-label-property', name: 'Label', type: 'text', defaultValue: 'Default C', binding: { kind: 'text', nodeId: 'c-label' } },
          {
            id: 'c-state-property', name: 'State', type: 'variant', defaultValueId: 'c-default', currentValueId: 'c-default',
            values: [{ id: 'c-default', name: 'Default' }, { id: 'c-hover', name: 'Hover' }],
            binding: { kind: 'variant', nodeId: 'c-master', appearances: { 'c-default': {}, 'c-hover': { opacity: 0.5 } } },
          },
        ],
        materials: [], parts: [], interactions: [{ id: 'c-hover-interaction', trigger: 'pointer-hover', propertyId: 'c-state-property', valueId: 'c-hover' }],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `deep-tree-${++id}`)
    store.load(source, atoms)

    expect(store.commands.components.place('a')).toBe(true)
    expect(store.commands.components.place('a')).toBe(true)
    const aInstances = Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'a')
    expect(aInstances).toHaveLength(2)
    expect(store.commands.components.place('b')).toBe(true)
    const bSource = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'b')!
    expect(store.commands.reparent(bSource.id, 'outer')).toBe(true)
    expect(Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'b')).toHaveLength(3)

    expect(store.commands.components.place('c')).toBe(true)
    const cSource = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'c')!
    expect(store.commands.reparent(cSource.id, 'b-master')).toBe(true)
    const cInstances = Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'c')
    expect(cInstances).toHaveLength(4)
    for (const instance of cInstances) expect(file(store).nodes[instance.id]).toBeDefined()

    const cLabels = new Map(cInstances.map(instance => [instance.id, mapParallelComponentSubtrees(file(store), 'c-master', instance.id)!.get('c-label')!]))
    const isolatedC = cInstances.find(instance => ancestorsOf(file(store), instance.id).includes(aInstances[0]!.id))!
    expect(store.commands.components.setInstanceValue(isolatedC.id, 'c-label-property', 'Deep override')).toBe(true)
    expect(file(store).nodes[cLabels.get(isolatedC.id)!]).toMatchObject({ text: 'Deep override' })
    const cDefinition = file(store).componentModel.definitions.c!
    const cProperty = cDefinition.properties[0]!
    if (cProperty.type !== 'text') throw new Error('Expected C Label to be a Text property')
    expect(store.commands.components.setProperty('c', { ...cProperty, defaultValue: 'Updated C' })).toBe(true)
    expect(file(store).nodes['c-label']).toMatchObject({ text: 'Default C' })
    for (const instance of cInstances) {
      const expected = instance.id === isolatedC.id ? 'Deep override' : 'Updated C'
      expect(file(store).nodes[cLabels.get(instance.id)!]).toMatchObject({ text: expected })
    }
    expect(store.commands.components.removeProperty('c', 'c-label-property')).toBe(true)
    for (const instance of cInstances) {
      expect(file(store).componentModel.instances[instance.id]!.values).toEqual({})
      expect(file(store).nodes[cLabels.get(instance.id)!]).toMatchObject({ text: 'Default C' })
    }
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[isolatedC.id]!.values['c-label-property']).toBe('Deep override')
    expect(file(store).nodes[cLabels.get(isolatedC.id)!]).toMatchObject({ text: 'Deep override' })

    expect(store.commands.components.setInstanceValue(isolatedC.id, 'c-state-property', 'c-hover')).toBe(true)
    expect(appearanceOf(store, isolatedC.id)?.opacity).toBe(0.5)
    const variant = file(store).componentModel.definitions.c!.properties.find(property => property.id === 'c-state-property')!
    expect(variant.type).toBe('variant')
    if (variant.type !== 'variant') throw new Error('Expected C State to be a Variant property')
    const remainingValues = variant.values.filter(value => value.id !== 'c-hover')
    const remainingBinding = variant.binding ? { ...variant.binding, appearances: Object.fromEntries(remainingValues.map(value => [value.id, variant.binding!.appearances[value.id]!])) } : undefined
    expect(store.commands.components.setProperty('c', { ...variant, values: remainingValues, ...(remainingBinding ? { binding: remainingBinding } : {}) })).toBe(true)
    expect(file(store).componentModel.instances[isolatedC.id]!.values).not.toHaveProperty('c-state-property')
    expect(file(store).componentModel.definitions.c!.interactions).toEqual([])
    expect(appearanceOf(store, isolatedC.id)?.opacity).not.toBe(0.5)
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[isolatedC.id]!.values['c-state-property']).toBe('c-hover')
    expect(file(store).componentModel.definitions.c!.interactions).toEqual([expect.objectContaining({ id: 'c-hover-interaction', valueId: 'c-hover' })])
    expect(appearanceOf(store, isolatedC.id)?.opacity).toBe(0.5)

    expect(store.commands.appearance.setBlending(['c-master'], { visible: false })).toBe(true)
    expect(appearanceOf(store, 'c-master')?.visible).toBe(false)
    for (const instance of cInstances) {
      if (instance.id === isolatedC.id) expect(appearanceOf(store, instance.id)?.visible).not.toBe(false)
      else expect(appearanceOf(store, instance.id)?.visible).toBe(false)
    }
    expect(store.undo()).toBe(true)
    expect(appearanceOf(store, 'c-master')?.visible).not.toBe(false)
    for (const instance of cInstances) expect(appearanceOf(store, instance.id)?.visible).not.toBe(false)

    const semanticBeforeRemoval = structuredClone(file(store).componentModel.instances)
    expect(store.commands.components.remove('c')).toBe(true)
    expect(file(store).componentModel.definitions.c).toBeUndefined()
    expect(Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'c')).toEqual([])
    expect(file(store).nodes['c-master']).toBeDefined()
    for (const instance of cInstances) expect(file(store).nodes[instance.id]).toBeDefined()
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.c).toBeDefined()
    expect(file(store).componentModel.instances).toEqual(semanticBeforeRemoval)
  })

  it('COMP-V2-UI-034 projects material captures through nested component instances and Undo', () => {
    let id = 0
    const source = fixture()
    source.nodes['c-master'] = { id: 'c-master', type: 'frame', name: 'C master', styles: { relativeTransform: [1, 0, 0, 1, 800, 0], width: 100, height: 100 } }
    source.nodes['c-face'] = { id: 'c-face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 40 }, appearance: { fills: [solid('c-face-fill', '#ff0000')] } }
    source.nodes['c-accent'] = { id: 'c-accent', type: 'rectangle', name: 'Accent', styles: { relativeTransform: [1, 0, 0, 1, 0, 50], width: 80, height: 20 }, appearance: { fills: [solid('c-accent-fill', '#ffffff')] } }
    source.relationships['c-master'] = { parentId: 'root-1', orderKey: 'X' }
    source.relationships['c-face'] = { parentId: 'c-master', orderKey: 'A' }
    source.relationships['c-accent'] = { parentId: 'c-master', orderKey: 'B' }
    source.componentModel = { definitions: {
      outer: { id: 'outer', name: 'Outer', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      c: {
        id: 'c', name: 'C', source: { kind: 'canvas', masterRootId: 'c-master' }, revision: 0, properties: [],
        materials: [{ id: 'surface', name: 'Surface', group: 'Layers', appearance: { fills: [solid('surface-fill', '#ff0000')] } }],
        parts: [
          { id: 'face-part', name: 'Face', nodeId: 'c-face', materialId: 'surface' },
          { id: 'accent-part', name: 'Accent', nodeId: 'c-accent', materialId: 'surface' },
        ],
        interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `deep-material-${++id}`)
    store.load(source, atoms)

    expect(store.commands.components.place('outer')).toBe(true)
    expect(store.commands.components.place('outer')).toBe(true)
    expect(store.commands.components.place('c')).toBe(true)
    const cSource = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'c')!
    expect(store.commands.reparent(cSource.id, 'outer')).toBe(true)
    const cInstances = Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'c')
    expect(cInstances).toHaveLength(3)
    const nodeIds = (sourceId: 'c-face' | 'c-accent') => [sourceId, ...cInstances.map(instance => mapParallelComponentSubtrees(file(store), 'c-master', instance.id)!.get(sourceId)!)]

    expect(store.commands.appearance.replaceFills(['c-face'], [solid('captured-fill', '#0000ff')])).toBe(true)
    expect(store.commands.components.captureMaterial('c', 'surface', 'c-face')).toBe(true)
    expect(file(store).componentModel.definitions.c!.materials[0]!.appearance.fills).toMatchObject([{ color: { color: { hex: '#0000ff' } } }])
    for (const nodeId of [...nodeIds('c-face'), ...nodeIds('c-accent')]) expect(fillsOf(store, nodeId)).toMatchObject([{ color: { color: { hex: '#0000ff' } } }])

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.c!.materials[0]!.appearance.fills).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])
    for (const nodeId of nodeIds('c-face')) expect(fillsOf(store, nodeId)).toMatchObject([{ color: { color: { hex: '#0000ff' } } }])
    for (const nodeId of nodeIds('c-accent')) expect(fillsOf(store, nodeId)).toMatchObject([{ color: { color: { hex: '#ffffff' } } }])

    expect(store.undo()).toBe(true)
    for (const nodeId of nodeIds('c-face')) expect(fillsOf(store, nodeId)).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])

    const definitionBeforeRemoval = structuredClone(file(store).componentModel.definitions.c!)
    expect(store.commands.components.removeMaterial('c', 'surface')).toBe(true)
    expect(file(store).componentModel.definitions.c!.materials).toEqual([])
    expect(file(store).componentModel.definitions.c!.parts).toEqual([
      { id: 'face-part', name: 'Face', nodeId: 'c-face' },
      { id: 'accent-part', name: 'Accent', nodeId: 'c-accent' },
    ])
    for (const nodeId of nodeIds('c-face')) expect(fillsOf(store, nodeId)).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])
    for (const nodeId of nodeIds('c-accent')) expect(fillsOf(store, nodeId)).toMatchObject([{ color: { color: { hex: '#ffffff' } } }])
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.c).toEqual(definitionBeforeRemoval)
  })

  it('COMP-V2-UI-022 moves existing slot content when the Slot binding changes', () => {
    let id = 0
    const source = fixture()
    const slot = { id: 'content', name: 'Content', type: 'slot' as const, binding: { kind: 'slot' as const, nodeId: 'inner' } }
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [slot], materials: [], parts: [], interactions: [] },
      badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `rebind-slot-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const hosts = Object.values(file(store).componentModel.instances).filter(instance => instance.componentId === 'canvas')
    expect(store.commands.components.addSlotContent(hosts[0]!.id, slot.id, 'frame')).toBe(true)
    expect(store.commands.components.addSlotComponent(hosts[1]!.id, slot.id, 'badge')).toBe(true)
    const content = hosts.map(host => {
      const map = mapParallelComponentSubtrees(file(store), 'outer', host.id)!
      return { source: map.get('inner')!, target: map.get('outer')!, nodeId: childrenOf(file(store), map.get('inner')!, slot.id)[0]! }
    })

    expect(store.commands.components.setProperty('canvas', { ...slot, binding: { kind: 'slot', nodeId: 'outer' } })).toBe(true)
    for (const item of content) {
      expect(childrenOf(file(store), item.source, slot.id)).toEqual([])
      expect(childrenOf(file(store), item.target, slot.id)).toContain(item.nodeId)
      expect(file(store).nodes[item.nodeId]).toBeDefined()
    }
    expect(file(store).componentModel.instances[content[1]!.nodeId]).toMatchObject({ componentId: 'badge' })

    expect(store.undo()).toBe(true)
    for (const item of content) {
      expect(childrenOf(file(store), item.source, slot.id)).toContain(item.nodeId)
      expect(childrenOf(file(store), item.target, slot.id)).toEqual([])
    }
  })

  it('COMP-V2-UI-075 places configured Slot drafts as one undoable component transaction', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      notice: { id: 'notice', name: 'Notice', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [{ id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'inner' } }], materials: [], parts: [], interactions: [] },
      badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'box' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: { nestedBadge: { id: 'nestedBadge', componentId: 'badge', values: {} } } }
    source.nodes.nestedBadge = { id: 'nestedBadge', type: 'rectangle', name: 'Nested badge', styles: { relativeTransform: [1, 0, 0, 1, 12, 12], width: 20, height: 20 } }
    source.relationships.nestedBadge = { parentId: 'outer', orderKey: 'Z' }
    const store = createDocumentStore(() => `configured-slot-${++id}`)
    store.load(source, atoms)
    const drafts = [
      { id: 'text', propertyId: 'content', content: { kind: 'text' as const } },
      { id: 'frame', propertyId: 'content', content: { kind: 'frame' as const } },
      { id: 'badge', propertyId: 'content', content: { kind: 'component' as const, componentId: 'badge' } },
    ]

    expect(store.commands.components.place('notice', {}, drafts)).toBe(true)
    const notice = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'notice')!
    const map = mapParallelComponentSubtrees(file(store), 'outer', notice.id)!
    const host = map.get('inner')!
    const content = childrenOf(file(store), host, 'content')
    expect(content).toHaveLength(3)
    expect(content.map(nodeId => file(store).nodes[nodeId]?.type)).toEqual(['text', 'frame', 'rectangle'])
    const nested = Object.values(file(store).componentModel.instances).find(instance => instance.componentId === 'badge' && file(store).relationships[instance.id]?.slot === 'content')!
    expect(content).toContain(nested.id)
    expect(store.getSnapshot().selection).toEqual([notice.id])
    expect(store.getHistory().past).toHaveLength(1)

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances).toEqual({ nestedBadge: { id: 'nestedBadge', componentId: 'badge', values: {} } })
    expect(content.every(nodeId => file(store).nodes[nodeId] === undefined)).toBe(true)
    expect(file(store).componentModel.definitions).toHaveProperty('badge')
  })

  it('COMP-V2-UI-NEG-002 rejects invalid Slot drafts without a partial placement', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      notice: { id: 'notice', name: 'Notice', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [{ id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'inner' } }], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `invalid-slot-${++id}`)
    store.load(source, atoms)
    const before = structuredClone(file(store))

    expect(store.commands.components.place('notice', {}, [{ id: 'recursive', propertyId: 'content', content: { kind: 'component', componentId: 'notice' } }])).toBe(false)
    expect(file(store)).toEqual(before)
    expect(store.getHistory().past).toEqual([])
  })

  it('COMP-V2-UI-009 keeps each variant option appearance independent', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `variant-state-${++id}`)
    store.load(source, atoms)
    const variantId = store.commands.components.addProperty('canvas', 'variant')!
    const initial = file(store).componentModel.definitions.canvas!.properties.find(property => property.id === variantId)
    if (initial?.type !== 'variant' || !initial.binding) throw new Error('Expected a bound variant property')
    const defaultValueId = initial.defaultValueId
    const defaultAppearance = structuredClone(initial.binding.appearances[defaultValueId])
    const hoverValueId = store.commands.components.addVariantValue('canvas', variantId)!

    expect(store.commands.appearance.updateFill(['outer'], 0, solid('hover-fill', '#ff0055'))).toBe(true)
    const edited = file(store).componentModel.definitions.canvas!.properties.find(property => property.id === variantId)
    if (edited?.type !== 'variant' || !edited.binding) throw new Error('Expected a bound variant property')
    expect(edited.binding.appearances[defaultValueId]).toEqual(defaultAppearance)
    expect(edited.binding.appearances[hoverValueId]).toEqual(appearanceOf(store, 'outer'))
    expect(edited.binding.appearances[hoverValueId]).not.toEqual(defaultAppearance)

    expect(store.commands.components.setVariantCurrent('canvas', variantId, defaultValueId)).toBe(true)
    expect(appearanceOf(store, 'outer')).toEqual(defaultAppearance)
    expect(store.commands.components.setVariantCurrent('canvas', variantId, hoverValueId)).toBe(true)
    expect(appearanceOf(store, 'outer')).toEqual(edited.binding.appearances[hoverValueId])
  })

  it('COMP-V2-UI-007 rejects ambiguous property and material names at the command boundary', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `definition-name-${++id}`)
    store.load(source, atoms)

    const firstPropertyId = store.commands.components.addProperty('canvas', 'variant')!
    const secondPropertyId = store.commands.components.addProperty('canvas', 'text')!
    const firstProperty = file(store).componentModel.definitions.canvas!.properties.find(property => property.id === firstPropertyId)!
    const secondProperty = file(store).componentModel.definitions.canvas!.properties.find(property => property.id === secondPropertyId)!
    expect(store.commands.components.setProperty('canvas', { ...firstProperty, name: 'State' })).toBe(true)
    expect(store.commands.components.setProperty('canvas', { ...secondProperty, name: 'state' })).toBe(false)

    const firstMaterialId = store.commands.components.addMaterial('canvas')!
    const secondMaterialId = store.commands.components.addMaterial('canvas')!
    expect(store.commands.components.setMaterial('canvas', firstMaterialId, { name: 'Quiet', group: 'Interaction' })).toBe(true)
    expect(store.commands.components.setMaterial('canvas', secondMaterialId, { name: 'quiet', group: 'interaction' })).toBe(false)
  })

  it('COMP-V2-UI-008 projects text and boolean overrides onto only the edited canvas instance', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      'label-component': { id: 'label-component', name: 'Label', source: { kind: 'code', bindingId: 'label-component' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
      'missing-code': { id: 'missing-code', name: 'Missing', source: { kind: 'code', bindingId: 'missing-code' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `override-${++id}`)
    store.load(source, atoms)
    store.select('box')
    expect(store.commands.components.createFromSelection('Badge')).toBe(true)
    const badgeDefinition = Object.values(file(store).componentModel.definitions).find(definition => definition.name === 'Badge')!
    expect(store.commands.insertCanvas('text', { x: 12, y: 16, parentId: 'outer' })).toBe(true)
    const masterTextId = store.getSnapshot().selection[0]!
    expect(store.commands.setText(masterTextId, 'Email')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instances = Object.values(file(store).componentModel.instances)
    const textId = store.commands.components.addProperty('canvas', 'text')!
    const booleanId = store.commands.components.addProperty('canvas', 'boolean')!
    const slotId = store.commands.components.addProperty('canvas', 'slot')!
    const firstLabel = childrenOf(file(store), instances[0]!.id).find(nodeId => file(store).nodes[nodeId]?.type === 'text')!
    const secondLabel = childrenOf(file(store), instances[1]!.id).find(nodeId => file(store).nodes[nodeId]?.type === 'text')!
    expect(file(store).componentModel.definitions.canvas!.properties).toMatchObject([
      { id: textId, type: 'text', defaultValue: 'Email', binding: { kind: 'text', nodeId: masterTextId } },
      { id: booleanId, type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'outer' } },
      { id: slotId, type: 'slot', binding: { kind: 'slot', nodeId: 'outer' } },
    ])

    expect(store.commands.components.setInstanceValue(instances[0]!.id, textId, 'Changed')).toBe(true)
    expect(file(store).nodes[firstLabel]).toMatchObject({ text: 'Changed' })
    expect(file(store).nodes[secondLabel]).toMatchObject({ text: 'Email' })
    expect(file(store).nodes[masterTextId]).toMatchObject({ text: 'Email' })

    expect(store.commands.components.setInstanceValue(instances[0]!.id, booleanId, false)).toBe(true)
    expect(appearanceOf(store, instances[0]!.id)?.visible).toBe(false)
    expect(appearanceOf(store, instances[1]!.id)?.visible).not.toBe(false)
    expect(appearanceOf(store, 'outer')?.visible).not.toBe(false)

    expect(store.commands.components.addSlotContent(instances[0]!.id, slotId, 'frame')).toBe(true)
    expect(childrenOf(file(store), instances[0]!.id, slotId)).toHaveLength(1)
    expect(childrenOf(file(store), instances[1]!.id, slotId)).toHaveLength(0)
    expect(childrenOf(file(store), 'outer', slotId)).toHaveLength(0)
    expect(store.commands.components.addSlotComponent(instances[0]!.id, slotId, 'canvas')).toBe(false)
    expect(store.commands.components.addSlotComponent(instances[0]!.id, slotId, badgeDefinition.id)).toBe(true)
    const nested = Object.values(file(store).componentModel.instances).find(candidate => candidate.componentId === badgeDefinition.id)!
    expect(nested).toBeDefined()
    expect(file(store).relationships[nested.id]).toMatchObject({ parentId: instances[0]!.id, slot: slotId })
    expect(childrenOf(file(store), instances[0]!.id, slotId)).toHaveLength(2)
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances[nested.id]).toBeUndefined()
    expect(childrenOf(file(store), instances[0]!.id, slotId)).toHaveLength(1)
    expect(store.commands.components.addSlotComponent(instances[0]!.id, slotId, 'label-component')).toBe(true)
    const codeNested = Object.values(file(store).componentModel.instances).find(candidate => candidate.componentId === 'label-component')!
    expect(file(store).nodes[codeNested.id]).toMatchObject({ type: 'component', componentId: 'label-component', exportName: 'Label' })
    expect(file(store).relationships[codeNested.id]).toMatchObject({ parentId: instances[0]!.id, slot: slotId })
    expect(store.commands.components.addSlotComponent(instances[0]!.id, slotId, 'missing-code')).toBe(false)

    expect(store.commands.setText(masterTextId, 'Master changed')).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.properties.find(property => property.id === textId)).toMatchObject({ type: 'text', defaultValue: 'Master changed' })
    expect(file(store).nodes[firstLabel]).toMatchObject({ text: 'Changed' })
    expect(file(store).nodes[secondLabel]).toMatchObject({ text: 'Master changed' })

    expect(store.commands.components.setInstanceValue(instances[0]!.id, textId, null)).toBe(true)
    expect(file(store).nodes[firstLabel]).toMatchObject({ text: 'Master changed' })
    expect(store.undo()).toBe(true)
    expect(file(store).nodes[firstLabel]).toMatchObject({ text: 'Changed' })
  })

  it('COMP-V2-UI-009 captures variant appearance states and targets them from interactions', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: { id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore(() => `variant-${++id}`)
    store.load(source, atoms)
    expect(store.commands.components.place('canvas')).toBe(true)
    expect(store.commands.components.place('canvas')).toBe(true)
    const instances = Object.values(file(store).componentModel.instances)
    const propertyId = store.commands.components.addProperty('canvas', 'variant')!
    const hoverId = store.commands.components.addVariantValue('canvas', propertyId)!
    expect(store.commands.components.setVariantCurrent('canvas', propertyId, hoverId)).toBe(true)
    expect(store.commands.appearance.replaceFills(['outer'], [solid('hover-fill', '#ff0000')])).toBe(true)

    const property = file(store).componentModel.definitions.canvas!.properties.find(candidate => candidate.id === propertyId)!
    expect(property.type).toBe('variant')
    if (property.type !== 'variant' || !property.binding) throw new Error('Expected a bound variant')
    expect(property.binding.appearances[hoverId]).toMatchObject({ fills: [{ color: { color: { hex: '#ff0000' } } }] })
    expect(fillsOf(store, instances[0]!.id)).toMatchObject([{ color: { color: { hex: '#ffffff' } } }])
    expect(fillsOf(store, instances[1]!.id)).toMatchObject([{ color: { color: { hex: '#ffffff' } } }])

    expect(store.commands.components.setInstanceValue(instances[0]!.id, propertyId, hoverId)).toBe(true)
    expect(fillsOf(store, instances[0]!.id)).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])
    expect(fillsOf(store, instances[1]!.id)).toMatchObject([{ color: { color: { hex: '#ffffff' } } }])
    expect(store.commands.components.setInteraction('canvas', 'pointer-hover', propertyId, hoverId)).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.interactions).toMatchObject([{ trigger: 'pointer-hover', propertyId, valueId: hoverId, transition: { type: 'smart-animate', durationMs: 300, easing: 'ease-out' } }])
    const interactionId = file(store).componentModel.definitions.canvas!.interactions[0]!.id
    expect(store.commands.components.setInteractionTransition('canvas', interactionId, { type: 'smart-animate', durationMs: 180, easing: 'ease-in-out' })).toBe(true)
    expect(store.commands.components.setInteraction('canvas', 'pointer-hover', propertyId, property.defaultValueId)).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.interactions).toMatchObject([{ trigger: 'pointer-hover', propertyId, valueId: property.defaultValueId, transition: { type: 'smart-animate', durationMs: 180, easing: 'ease-in-out' } }])

    const materialId = store.commands.components.addMaterial('canvas')!
    expect(store.commands.components.setMaterial('canvas', materialId, { name: 'Quiet', group: 'Interaction', description: 'Hover and selected states' })).toBe(true)
    expect(store.commands.components.assignMaterial('canvas', materialId, 'inner')).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.parts).toEqual(expect.arrayContaining([{ id: expect.any(String), name: 'Outer', nodeId: 'outer', materialId }, { id: expect.any(String), name: 'Inner', nodeId: 'inner', materialId }]))
    expect(fillsOf(store, 'inner')).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])
    for (const instance of instances) {
      const instanceInner = childrenOf(file(store), instance.id).find(nodeId => file(store).nodes[nodeId]?.type === 'frame')!
      expect(fillsOf(store, instanceInner)).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])
    }
    expect(store.commands.appearance.replaceFills(['inner'], [solid('material-fill', '#0000ff')])).toBe(true)
    expect(store.commands.components.captureMaterial('canvas', materialId, 'inner')).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.materials[0]).toMatchObject({ id: materialId, name: 'Quiet', group: 'Interaction', description: 'Hover and selected states', appearance: { fills: [{ color: { color: { hex: '#0000ff' } } }] } })
    expect(fillsOf(store, 'outer')).toMatchObject([{ color: { color: { hex: '#0000ff' } } }])
    for (const [index, instance] of instances.entries()) {
      const instanceInner = childrenOf(file(store), instance.id).find(nodeId => file(store).nodes[nodeId]?.type === 'frame')!
      expect(fillsOf(store, instance.id)).toMatchObject([{ color: { color: { hex: index === 0 ? '#0000ff' : '#ffffff' } } }])
      expect(fillsOf(store, instanceInner)).toMatchObject([{ color: { color: { hex: '#0000ff' } } }])
    }
    expect(store.commands.components.clearMaterial('canvas', 'inner')).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.parts.find(part => part.nodeId === 'inner')).toEqual(expect.objectContaining({ nodeId: 'inner', name: 'Inner' }))
    expect(file(store).componentModel.definitions.canvas!.parts.find(part => part.nodeId === 'inner')).not.toHaveProperty('materialId')
    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.definitions.canvas!.parts.find(part => part.nodeId === 'inner')).toMatchObject({ materialId })
  })

  it('COMP-V2-UI-010 places a configured playground or variant-sheet instance in one undoable transaction', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 1,
        properties: [{
          id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', currentValueId: 'default',
          values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }],
          binding: {
            kind: 'variant', nodeId: 'outer', appearances: {
              default: { fills: [solid('default-fill', '#ffffff')] },
              hover: { fills: [solid('hover-fill', '#ff0000')] },
            },
          },
        }],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `docs-${++id}`)
    store.load(source, atoms)

    expect(store.commands.components.place('canvas', { state: 'hover' })).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    expect(instance.values).toEqual({ state: 'hover' })
    expect(fillsOf(store, instance.id)).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])
    expect(store.getSnapshot().selection).toEqual([instance.id])

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances).toEqual({})
    expect(file(store).nodes[instance.id]).toBeUndefined()
  })

  it('COMP-V2-UI-037 places every canvas variant in one undoable sheet', () => {
    let id = 0
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 1,
        properties: [{
          id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', currentValueId: 'default',
          values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }],
          binding: {
            kind: 'variant', nodeId: 'outer', appearances: {
              default: { fills: [solid('default-fill', '#ffffff')] },
              hover: { fills: [solid('hover-fill', '#ff0000')] },
            },
          },
        }],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore(() => `sheet-${++id}`)
    store.load(source, atoms)

    expect(store.commands.components.placeVariantSheet('canvas')).toBe(true)
    const instances = Object.values(file(store).componentModel.instances)
    expect(instances.map(instance => instance.values)).toEqual([{}, { state: 'hover' }])
    const defaultInstance = instances.find(instance => !Object.hasOwn(instance.values, 'state'))!
    const hoverInstance = instances.find(instance => instance.values.state === 'hover')!
    const sheet = Object.values(file(store).nodes).find(node => node.type === 'frame' && node.name === 'Canvas variants')!
    const labels = Object.values(file(store).nodes).filter((node): node is PrimitiveNode => node.type === 'text' && file(store).relationships[node.id]?.parentId === sheet.id)
    expect(store.getSnapshot().selection).toEqual([sheet.id])
    expect(sheet).toMatchObject({ type: 'frame', name: 'Canvas variants', styles: { relativeTransform: [1, 0, 0, 1, 520, 50], width: 820, height: 328, overflow: 'visible' } })
    expect(labels.map(label => label.text)).toEqual(['State: Default', 'State: Hover'])
    expect(labels.map(label => label.styles.relativeTransform)).toEqual([[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 420, 0]])
    expect(file(store).relationships[defaultInstance.id]?.parentId).toBe(sheet.id)
    expect(file(store).relationships[hoverInstance.id]?.parentId).toBe(sheet.id)
    expect(worldPosition(file(store), defaultInstance.id)).toEqual({ x: 520, y: 78 })
    expect(worldPosition(file(store), hoverInstance.id)).toEqual({ x: 940, y: 78 })
    expect(fillsOf(store, defaultInstance.id)).toMatchObject([{ color: { color: { hex: '#ffffff' } } }])
    expect(fillsOf(store, hoverInstance.id)).toMatchObject([{ color: { color: { hex: '#ff0000' } } }])
    expect(store.getHistory().past).toHaveLength(1)

    expect(store.undo()).toBe(true)
    expect(file(store).componentModel.instances).toEqual({})
    expect(file(store).nodes[defaultInstance.id]).toBeUndefined()
    expect(file(store).nodes[hoverInstance.id]).toBeUndefined()
    expect(file(store).nodes[sheet.id]).toBeUndefined()
    for (const label of labels) expect(file(store).nodes[label.id]).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(Object.keys(file(store).componentModel.instances)).toEqual([defaultInstance.id, hoverInstance.id])
    expect(labels.every(label => file(store).nodes[label.id]?.type === 'text')).toBe(true)
  })

  it('COMP-V2-UI-058 refuses a Variant sheet with no bound Variant', () => {
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 1,
        properties: [{ id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }] }],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore()
    store.load(source, atoms)

    expect(store.commands.components.placeVariantSheet('canvas')).toBe(false)
    expect(file(store).componentModel.instances).toEqual({})
    expect(Object.values(file(store).nodes).some(node => node.type === 'frame' && node.name === 'Canvas variants')).toBe(false)
  })

  it('COMP-V2-UI-059 rejects configured values for unbound canvas properties', () => {
    const source = fixture()
    source.componentModel = { definitions: {
      canvas: {
        id: 'canvas', name: 'Canvas', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 1,
        properties: [{ id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }] }],
        materials: [], parts: [], interactions: [],
      },
    }, instances: {} }
    const store = createDocumentStore()
    store.load(source, atoms)

    expect(store.commands.components.place('canvas', { state: 'hover' })).toBe(false)
    expect(file(store).componentModel.instances).toEqual({})
    expect(store.commands.components.place('canvas')).toBe(true)
    const instance = Object.values(file(store).componentModel.instances)[0]!
    expect(store.commands.components.setInstanceValue(instance.id, 'state', 'hover')).toBe(false)
    expect(file(store).componentModel.instances[instance.id]?.values).toEqual({})
  })

  it('COMP-V2-UI-NEG-001 refuses unavailable component placement', () => {
    const source = fixture()
    source.componentModel = { definitions: {
      unavailable: { id: 'unavailable', name: 'Missing', source: { kind: 'code', bindingId: 'missing' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} }
    const store = createDocumentStore()
    store.load(source, atoms)
    expect(store.commands.components.place('unavailable')).toBe(false)
    expect(file(store).componentModel.instances).toEqual({})
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
    expect(file(store).nodes['new-1']).toEqual({ id: 'new-1', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 320, height: 240, overflow: 'clip' }, appearance: { fills: [{ id: 'new-2', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }] }, themeMode: 'inherit' })
    expect(file(store).relationships['new-1']!.parentId).toBe('root-1')
    expect(childrenOf(file(store), 'root-1')).toEqual(['outer', 'box', 'card', 'new-1'])
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(file(store).revision).toBe(1)
    expect(store.getSnapshot().dirty).toBe(true)
  })

  it('draws a rectangle inside a frame with rounded local bounds and a white literal fill', () => {
    const store = loaded()
    expect(store.commands.insertCanvas('rectangle', { x: 5.4, y: 6.6, width: 99.6, height: 0.2, parentId: 'outer' })).toBe(true)
    expect(file(store).nodes['new-1']).toEqual({ id: 'new-1', type: 'rectangle', name: 'Rectangle', styles: { relativeTransform: [1, 0, 0, 1, 5, 7], width: 100, height: 1 }, appearance: { fills: [{ id: 'new-2', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }] }, themeMode: 'inherit' })
    expect(file(store).relationships['new-1']!.parentId).toBe('outer')
    expect(Object.keys(file(store).theme.tokens)).toEqual([])
  })

  it('makes new nodes flow children when they are drawn inside a Flex frame', () => {
    const source = fixture()
    source.nodes.outer = { ...source.nodes.outer!, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'center', align: 'center' } } } } as FileDocument['nodes'][string]
    source.nodes.inner = { ...source.nodes.inner!, layout: { item: { position: { mode: 'flow' } } } } as FileDocument['nodes'][string]
    let id = 0
    const store = createDocumentStore(() => `new-${++id}`)
    store.load(source, atoms)

    expect(store.commands.insertCanvas('frame', { x: 40, y: 30, width: 80, height: 60, parentId: 'outer' })).toBe(true)
    expect(file(store).nodes['new-1']).toMatchObject({
      type: 'frame',
      layout: { item: { position: { mode: 'flow' } } },
    })

    expect(store.commands.insertCanvasText('point', { x: 60, y: 50, parentId: 'outer' })).toBe(true)
    expect(file(store).nodes['new-3']).toMatchObject({
      type: 'text',
      layout: { item: { position: { mode: 'flow' } } },
      textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } },
    })
  })

  it('PAPER-FILL-004: text Fill writes freeform constraints and Fixed removes the trailing constraint atomically', () => {
    const store = loaded()
    expect(store.commands.insertCanvasText('point', { x: 30, y: 40, parentId: 'outer' })).toBe(true)
    expect(store.commands.text.update(store.getSnapshot().textEditing!.sessionId, 'Text')).toBe(true)
    expect(store.commands.text.commit(store.getSnapshot().textEditing!.sessionId)).toBe(true)
    const filled = store.commands.text.setSizingModes([{ nodeId: 'new-1', axes: ['x'], mode: 'fill', measured: { width: 72 }, parent: { width: 400 }, local: { x: 30, y: 40 } }])
    expect(filled).toBe(true)
    expect(file(store).nodes['new-1']).toMatchObject({
      textSizing: { width: { mode: 'fill' } },
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 40 }, right: { kind: 'px', value: 0 } } } },
    })

    expect(store.commands.text.setSizingModes([{ nodeId: 'new-1', axes: ['x'], mode: 'fixed', measured: { width: 318 }, parent: { width: 400 }, local: { x: 0, y: 40 } }])).toBe(true)
    expect(file(store).nodes['new-1']).toMatchObject({
      styles: { width: 318 },
      textSizing: { width: { mode: 'fixed' } },
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 40 } } } },
    })
    expect((file(store).nodes['new-1'] as Exclude<FileDocument['nodes'][string], { type: 'root' }>).layout?.item.position).not.toHaveProperty('right')
  })

  it('PAPER-FILL-005: text Fill on the Flex main axis stores growth instead of relying on 100 percent width', () => {
    const source = fixture()
    source.nodes.outer = { ...source.nodes.outer!, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } } as FileDocument['nodes'][string]
    source.nodes.inner = { ...source.nodes.inner!, layout: { item: { position: { mode: 'flow' } } } } as FileDocument['nodes'][string]
    let id = 0
    const store = createDocumentStore(() => `new-${++id}`)
    store.load(source, atoms)
    expect(store.commands.insertCanvasText('point', { x: 30, y: 40, parentId: 'outer' })).toBe(true)
    expect(store.commands.text.update(store.getSnapshot().textEditing!.sessionId, 'Text')).toBe(true)
    expect(store.commands.text.commit(store.getSnapshot().textEditing!.sessionId)).toBe(true)
    const filled = store.commands.text.setSizingModes([{ nodeId: 'new-1', axes: ['x'], mode: 'fill', measured: { width: 72 }, parent: { width: 400 } }])
    expect(filled).toBe(true)
    expect(file(store).nodes['new-1']).toMatchObject({
      textSizing: { width: { mode: 'fill' } },
      layout: { item: { position: { mode: 'flow' }, flex: { grow: 1, shrink: 1, basis: { kind: 'px', value: 0 } } } },
    })
  })

  it('seeds a click-created rectangle at 500 x 500 white while a frame keeps 320 x 240', () => {
    const store = loaded()
    expect(store.commands.insertCanvas('rectangle', { x: 40, y: 60 })).toBe(true)
    expect(file(store).nodes['new-1']).toEqual({ id: 'new-1', type: 'rectangle', name: 'Rectangle', styles: { relativeTransform: [1, 0, 0, 1, 40, 60], width: 500, height: 500 }, appearance: { fills: [{ id: 'new-2', type: 'solid', color: hex('#ffffff') }] }, themeMode: 'inherit' })
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
    expect(file(store).nodes['new-7']).toMatchObject({ type: 'text', text: 'Text', ...legacyTextProperties(), appearance: { fills: [{ id: 'new-8', type: 'solid', color: hex('#000000') }] } })
  })

  it('uses the editor appearance for new text color', () => {
    const textColorIn = (mode: 'light' | 'dark') => {
      let id = 0
      const store = createDocumentStore(() => `new-${++id}`)
      store.configure({ editorMode: () => mode })
      store.load(fixture(), atoms)
      expect(store.commands.insertCanvasText('point', { x: 0, y: 0 })).toBe(true)
      return fillsOf(store, 'new-1')
    }

    expect(textColorIn('dark')).toEqual([{ id: 'new-2', type: 'solid', color: hex('#ffffff') }])
    expect(textColorIn('light')).toEqual([{ id: 'new-2', type: 'solid', color: hex('#000000') }])
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

  it('FLEX-REPARENT-001 adopts a freeform primitive into Flex flow and restores freeform when dragged back out', () => {
    const source = fixture()
    const inner = source.nodes.inner
    if (!inner || inner.type !== 'frame') throw new Error('Expected frame fixture')
    inner.layout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'center', align: 'center' } } }
    let id = 0
    const store = createDocumentStore(() => `flex-reparent-${++id}`)
    store.load(source, atoms)

    expect(store.commands.commitMove([{ id: 'box', x: 150, y: 110, parentId: 'inner' }]).committed).toBe(true)
    const adopted = file(store).nodes.box
    expect(adopted?.type === 'rectangle' ? adopted.layout?.item.position : null).toEqual({ mode: 'flow' })
    expect(file(store).relationships.box!.parentId).toBe('inner')

    expect(store.commands.layout.primitiveSizing('width', 'fill', [{ id: 'box', measuredPx: 50 }])).toBe(true)
    const filled = file(store).nodes.box
    expect(filled?.type === 'rectangle' ? filled.layout?.item : null).toMatchObject({
      width: { value: { kind: 'percent', value: 100 } },
      flex: { grow: 1, shrink: 1, basis: { kind: 'px', value: 0 } },
    })
    expect(store.commands.layout.primitiveSizing('height', 'fill', [{ id: 'box', measuredPx: 40 }])).toBe(true)
    const crossFit = file(store).nodes.box
    expect(crossFit?.type === 'rectangle' ? crossFit.layout?.item : null).toMatchObject({
      height: { value: { kind: 'percent', value: 100 } },
      flex: { grow: 1, shrink: 1, basis: { kind: 'px', value: 0 } },
    })
    expect(store.getSnapshot()).toMatchObject({ selection: ['box'], transient: null, error: null })
    expect(store.commands.rename('box', 'Button row')).toBe(true)

    expect(store.commands.commitMove([{ id: 'box', x: 700, y: 20, parentId: null }]).committed).toBe(true)
    const detached = file(store).nodes.box
    expect(detached?.type === 'rectangle' ? detached.layout?.item.position : null).toEqual({ mode: 'freeform' })
    expect(styles(store, 'box')).toMatchObject({ left: 700, top: 20 })
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

  it('retires the unfenced world-space resize command path', () => {
    const store = loaded()
    expect('commitResize' in store.commands).toBe(false)
  })

  it('duplicates a primitive 20 units to the right with a new id while the source keeps its own', () => {
    const store = loaded()
    store.select('box')
    expect(store.commands.duplicate()).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(file(store).nodes['new-1']).toMatchObject({ id: 'new-1', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 670, 400], width: 50, height: 40 } })
    expect(file(store).nodes.box).toMatchObject({ id: 'box', styles: { relativeTransform: [1, 0, 0, 1, 600, 400] } })
    expect(childrenOf(file(store), 'root-1')).toEqual(['outer', 'box', 'new-1', 'card'])
  })

  it('keeps the Alt-drag source fixed while the selected duplicate moves in one history step', () => {
    const store = loaded()
    store.select('box')
    expect(store.commands.commitMove([{ id: 'box', x: 720, y: 460, parentId: null }], { duplicate: true }).committed).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['new-1'])
    expect(styles(store, 'box')).toMatchObject({ left: 600, top: 400 })
    expect(file(store).nodes['new-1']).toMatchObject({ id: 'new-1', type: 'rectangle', styles: { relativeTransform: [1, 0, 0, 1, 720, 460], width: 50, height: 40 } })
    store.undo()
    expect(file(store).nodes['new-1']).toBeUndefined()
    expect(styles(store, 'box')).toMatchObject({ left: 600, top: 400 })
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
    expect(store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions(atoms), atoms), store.getSnapshot().error ?? '').toBe(true)
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
    expect(file(store).componentModel.instances['new-1']).toEqual({ id: 'new-1', componentId: 'card-component', values: {} })
  })

  it('keeps a slot insertion in component-owned flow even when a drop point is provided', () => {
    const store = loaded()
    expect(store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions(atoms), atoms), store.getSnapshot().error ?? '').toBe(true)
    expect(store.commands.insertAt('label-component', { x: 120, y: 80 }, { parentId: 'card', slot: 'footer' })).toBe(true)
    expect(file(store).nodes['new-1']).not.toHaveProperty('layout')
    expect(childrenOf(file(store), 'card', 'footer')).toEqual(['footer-label', 'new-1'])
    expect(store.getSnapshot().selection).toEqual(['new-1'])
  })

  it('inserts the real component identity into a slot and duplicates the nested tree with fresh ids', () => {
    const store = loaded()
    expect(store.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions(atoms), atoms), store.getSnapshot().error ?? '').toBe(true)
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
    expect(store.commands.setStyles('box', at(610, 400))).toBe(true)
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
    expect(store.commands.executeBatch([{ type: 'node.setStyles', nodeId: 'box', styles: at(1, 400) }, { type: 'node.rename', nodeId: 'box', name: 'Moved' }])).toBe(true)
    expect(file(store).nodes.box).toMatchObject({ name: 'Moved', styles: at(1, 400) })
    expect(file(store).revision).toBe(1)
    store.undo()
    expect(file(store).nodes.box).toMatchObject({ name: 'Box', styles: at(600, 400) })
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getSnapshot().canRedo).toBe(true)
    expect(store.commands.setStyles('box', at(600, 1))).toBe(true)
    expect(store.getSnapshot().canRedo).toBe(false)
  })

  it('ignores commands that do not change the file', () => {
    const store = loaded()
    const before = file(store)
    expect(store.commands.setStyles('box', at(600, 400))).toBe(false)
    expect(file(store)).toBe(before)
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getSnapshot().dirty).toBe(false)
  })
})

describe('AT-THEME file tokens', () => {
  it('AT-DOC-004 creates every Paper token type with a valid editable default', () => {
    const store = loaded()
    const types = ['color', 'opacity', 'radius', 'spacing', 'container', 'breakpoint', 'fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing'] as const
    const expected = [
      { kind: 'literal', color: { kind: 'hex', hex: '#d9d9d9' } }, { kind: 'literal', value: 0.5 }, { kind: 'literal', value: '8px' },
      { kind: 'literal', value: '8px' }, { kind: 'literal', value: '1200px' }, { kind: 'literal', value: '768px' }, { kind: 'literal', value: 'Inter' },
      { kind: 'literal', value: 400 }, { kind: 'literal', value: '16px' }, { kind: 'literal', value: 1.5 }, { kind: 'literal', value: '0px' },
    ]
    for (const type of types) expect(store.commands.theme.createToken(type)).toBeTruthy()
    expect(Object.values(file(store).theme.tokens).map(token => token.type)).toEqual(types)
    expect(Object.values(file(store).theme.tokens).map(token => token.value)).toEqual(expected)
  })

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

    store.commands.setStyles('box', at(610, 400))
    store.commands.executeBatch([
      { type: 'node.setStyles', nodeId: 'box', styles: at(610, 410) },
      { type: 'node.rename', nodeId: 'outer', name: 'Frame renamed' },
    ])
    store.commands.renamePage('page-1', 'Canvas')

    expect(writes).toHaveLength(1)
    expect(writes[0]!.intent).toEqual({ kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: at(610, 400) }] })
    release({ ...writes[0]!.file, revision: 1 })
    await settled(store)

    expect(writes).toHaveLength(3)
    expect(writes[1]!.expected).toBe(1)
    expect(writes[1]!.intent).toEqual({
      kind: 'commands',
      commands: [{
        type: 'batch',
        commands: [
          { type: 'node.setStyles', nodeId: 'box', styles: at(610, 410) },
          { type: 'node.rename', nodeId: 'outer', name: 'Frame renamed' },
        ],
      }],
    })
    expect(writes[2]).toMatchObject({ expected: 2, intent: { kind: 'commands', commands: [{ type: 'page.rename', pageId: 'page-1', name: 'Canvas' }] } })
    expect((writes[1]!.file.nodes.box as unknown as { styles: { relativeTransform: readonly [number, number, number, number, number, number] } }).styles.relativeTransform).toEqual([1, 0, 0, 1, 610, 410])
    expect((writes[1]!.file.nodes.outer as { name: string }).name).toBe('Frame renamed')
    expect(writes[2]!.file.pages[0]?.name).toBe('Canvas')
  })

  it('CLOUD-SYNC-CLIENT-001 persists undo and redo as semantic inverse commands', async () => {
    const store = loaded()
    const intents: EditorPersistenceIntent[] = []
    store.configure({ persist: async (next, expected, intent) => { intents.push(intent); return { ...next, revision: expected + 1 } } })
    store.commands.setStyles('box', at(610, 400))
    await settled(store)
    store.undo()
    await settled(store)
    store.redo()
    await settled(store)
    expect(intents).toEqual([
      { kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: at(610, 400) }] },
      { kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: at(600, 400) }] },
      { kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: at(610, 400) }] },
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
    store.commands.setStyles('box', at(610, 400))
    await settled(store)
    store.retryPersistence()
    await settled(store)
    expect(writes).toHaveLength(2)
    expect(writes[1]!.file).toBe(writes[0]!.file)
    expect(writes[1]!.expected).toBe(writes[0]!.expected)
    expect(writes[1]!.intent).toEqual(writes[0]!.intent)
    expect(writes[1]!.intent).toEqual({ kind: 'commands', commands: [{ type: 'node.setStyles', nodeId: 'box', styles: at(610, 400) }] })
  })

  it('sends the file with the saved revision and adopts the acknowledged revision', async () => {
    const store = loaded()
    const writes: [number, number][] = []
    store.configure({ persist: async (next, expected) => { writes.push([next.revision, expected]); return { ...next, revision: expected === 0 ? 7 : expected + 1 } } })
    store.commands.setStyles('box', at(610, 400))
    await settled(store)
    expect(file(store).revision).toBe(7)
    expect(store.getSnapshot().dirty).toBe(false)
    store.commands.setStyles('box', at(610, 410))
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
    store.commands.setStyles('box', at(610, 400))
    store.commands.setStyles('box', at(610, 410))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.expected).toBe(0)
    release({ ...writes[0]!.file, revision: 1 })
    await settled(store)
    expect(writes.map(write => write.expected)).toEqual([0, 1])
    expect((writes[1]!.file.nodes.box as { styles: unknown }).styles).toEqual({ relativeTransform: [1, 0, 0, 1, 610, 410], width: 50, height: 40 })
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
    store.commands.setStyles('box', at(610, 400))
    await settled(store)
    expect(store.getSnapshot().dirty).toBe(true)
    expect(store.getSnapshot().blocked).toBe(true)
    expect(store.getSnapshot().error).toBe('Revision conflict')
    expect(store.commands.setStyles('box', at(610, 410))).toBe(false)
    expect(store.undo()).toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
    store.retryPersistence()
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    expect(persist).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().blocked).toBe(false)
    expect(styles(store, 'box').left).toBe(610)
    expect(store.commands.setStyles('box', at(610, 410))).toBe(true)
  })

  it('does not replace a newer edit when acknowledging an earlier save', () => {
    const store = loaded()
    store.commands.setStyles('box', at(610, 400))
    const first = file(store)
    store.commands.setStyles('box', at(610, 410))
    store.markSaved({ ...first, revision: 1 })
    expect(styles(store, 'box')).toMatchObject({ left: 610, top: 410 })
    expect(file(store).revision).toBe(1)
    expect(store.getSnapshot().dirty).toBe(true)
  })

  it('rebases unsaved edits onto a newer source revision and keeps editing available', () => {
    const store = loaded()
    store.commands.setStyles('box', at(610, 400))
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
    expect(store.commands.setStyles('box', at(610, 410))).toBe(true)
    expect(styles(store, 'box')).toMatchObject({ left: 610, top: 410 })
  })

  it('retires local history when a remote revision is rebased under pending edits', () => {
    const store = loaded()
    store.commands.setStyles('box', at(610, 400))
    expect(store.getSnapshot().canUndo).toBe(true)
    const remote = fixture()
    remote.pages[0]!.name = 'Remote page'
    store.load({ ...remote, revision: 1 }, atoms)
    expect(styles(store, 'box').left).toBe(610)
    expect(store.getSnapshot()).toMatchObject({ dirty: true, blocked: false, canUndo: false, canRedo: false })
    expect(store.undo()).toBe(false)
    expect(store.commands.setStyles('box', at(610, 410))).toBe(true)
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
    original.commands.setStyles('box', at(610, 400))
    original.commands.setStyles('box', at(610, 410))
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
    ;(history.past[0]!.file.nodes.box as unknown as { styles: { relativeTransform: [number, number, number, number, number, number] } }).styles.relativeTransform[4] = 999
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
    store.commands.setStyles('box', at(610, 400))
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
    for (let left = 601; left <= 625; left++) store.commands.setStyles('box', at(left, 400))
    const history = store.getHistory()
    expect(history.past).toHaveLength(20)
    expect((history.past[0]!.file.nodes.box as unknown as { styles: { relativeTransform: [number, number, number, number, number, number] } }).styles.relativeTransform[4]).toBe(605)
    expect((history.past[19]!.file.nodes.box as unknown as { styles: { relativeTransform: [number, number, number, number, number, number] } }).styles.relativeTransform[4]).toBe(624)
    ;(history.past[19]!.file.nodes.box as unknown as { styles: { relativeTransform: [number, number, number, number, number, number] } }).styles.relativeTransform[4] = 999
    store.undo()
    expect(styles(store, 'box').left).toBe(624)
    expect(store.restoreHistory({ past: Array.from({ length: 21 }, () => ({ file: fixture(), pageId: 'page-1', selection: [] })), future: [] })).toBe(false)
    for (let index = 0; index < 24; index++) store.undo()
    const future = store.getHistory()
    expect(future.past).toEqual([])
    expect(future.future).toHaveLength(20)
    expect(future.future[19]!.redo).toEqual({ type: 'node.setStyles', nodeId: 'box', styles: at(601, 400) })
    expect(createDocumentStore().restoreHistory({ past: [], future: [] })).toBe(false)
  })
})
