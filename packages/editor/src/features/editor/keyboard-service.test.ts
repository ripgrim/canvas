import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { documentStore } from './document-store'
import { directAddFlexCopy, directAddFlexToCurrentSelection, editorKeyDown } from './keyboard-service'
import { sceneGeometry } from './scene-geometry'
import { editorStore } from './store'
import { canvasGestures } from './canvas-gestures'
import { toastManager } from '../../design-system/toast-atoms'

const file = (withChild = false): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: withChild ? 'shortcut-measured' : 'shortcut-empty',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 101, height: 100 } },
    ...(withChild ? { child: { id: 'child', type: 'rectangle' as const, name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 20, height: 20 } } } : {}),
  },
  relationships: {
    frame: { parentId: 'root-1', orderKey: 'V' },
    ...(withChild ? { child: { parentId: 'frame', orderKey: 'V' } } : {}),
  },
  theme: { tokens: {} },
})

const componentFile = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'shortcut-component',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'freeform' } } },
    other: { id: 'other', type: 'rectangle', name: 'Other', styles: { relativeTransform: [1, 0, 0, 1, 120, 0], width: 20, height: 20 } },
  },
  relationships: { card: { parentId: 'root-1', orderKey: 'V' }, other: { parentId: 'root-1', orderKey: 'W' } },
  theme: { tokens: {} },
})

const componentAtoms = [{ name: 'Card', kind: 'atom' as const, componentId: 'card', path: 'src/Card.tsx', exportName: 'Card', fingerprint: 'f', sourceHash: 'h', status: 'bound' as const, candidates: [], props: [] }]

const key = (overrides: Partial<Parameters<typeof editorKeyDown>[0]> = {}) => {
  const preventDefault = vi.fn()
  return { event: { key: 'A', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, defaultPrevented: false, target: null, preventDefault, ...overrides }, preventDefault }
}

const publishNodeGeometry = (nodeId: 'frame' | 'card', width = 100, height = 100) => {
  const state = documentStore.getSnapshot()
  const node = state.file?.nodes[nodeId]
  if (!state.file || !node || node.type === 'root') throw new Error('Expected a loaded canvas node')
  sceneGeometry.update({
    [nodeId]: {
      ...(node.type === 'component' ? { componentId: node.componentId, parentInstanceId: null } : { canvasKind: node.type }),
      directChild: true,
      offsetParentNodeId: null,
      offsetParentToRoot: [1, 0, 0, 1, 0, 0],
      documentRevision: state.file.revision,
      layoutGeneration: state.layoutGeneration,
      rect: { x: 0, y: 0, width, height },
      offset: { x: 0, y: 0, width, height, origin: { x: width / 2, y: height / 2 } },
      box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    },
  }, { documentRevision: state.file.revision, layoutGeneration: state.layoutGeneration, measurementRevision: 1 })
}

afterEach(() => {
  documentStore.clear()
  sceneGeometry.clear()
  editorStore.set({ shareOpen: false, shortcutOpen: false, reviewOpen: false })
  editorStore.set({ busy: null })
  vi.unstubAllGlobals()
})

describe('PAPER-FLEX-001 Shift+A Direct Add', () => {
  it('recovers Add flex as soon as fresh matching geometry is published', () => {
    documentStore.load(file(), [], { replace: true })
    documentStore.select('frame')
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    const unavailable = key()
    editorKeyDown(unavailable.event)
    expect(unavailable.preventDefault).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)

    publishNodeGeometry('frame', 101, 100)
    const { event, preventDefault } = key()
    editorKeyDown(event)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(geometry).toHaveBeenCalledTimes(2)
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getSnapshot().file?.nodes.frame).toMatchObject({ layout: { container: { display: 'flex', gap: 16, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } } } })
    documentStore.undo()
    expect(documentStore.getSnapshot().file?.nodes.frame).not.toHaveProperty('layout')
  })

  it('does not mutate a non-empty frame when the exact current projection is unavailable', () => {
    documentStore.load(file(true), [], { replace: true })
    documentStore.select('frame')
    const { event, preventDefault } = key()
    editorKeyDown(event)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().file?.nodes.frame).not.toHaveProperty('layout')
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })

  it('adds Flex to an explicitly freeform Component through Shift+A in one semantic revision', () => {
    documentStore.load(componentFile(), componentAtoms, { replace: true })
    documentStore.select('card')
    const generation = documentStore.getSnapshot().layoutGeneration
    sceneGeometry.update({
      card: {
        componentId: 'card',
        parentInstanceId: null,
        directChild: true,
        offsetParentNodeId: null,
        documentRevision: 0,
        layoutGeneration: generation,
        rect: { x: 0, y: 0, width: 100, height: 100 },
        offset: { x: 0, y: 0, width: 100, height: 100, origin: { x: 50, y: 50 } },
      },
    }, { documentRevision: 0, layoutGeneration: generation, measurementRevision: 1 })

    const { event, preventDefault } = key()
    editorKeyDown(event)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getSnapshot().canUndo).toBe(true)
    expect(documentStore.getSnapshot().canRedo).toBe(false)
    expect(documentStore.getSnapshot().file?.nodes.card).toEqual({
      id: 'card',
      type: 'component',
      componentId: 'card',
      exportName: 'Card',
      props: {},
      layout: {
        item: { position: { mode: 'flow' }, width: { value: { kind: 'intrinsic', value: 'fit-content' } }, height: { value: { kind: 'intrinsic', value: 'fit-content' } } },
        container: { display: 'flex', gap: 16, flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } },
        spacing: { padding: { x: 16, y: 16 } },
      },
    })
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().file?.nodes.card).toEqual(componentFile().nodes.card)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
    expect(documentStore.getSnapshot().canRedo).toBe(true)
  })

  it('uses the measured conversion path for a block Component', () => {
    const source = componentFile()
    const card = source.nodes.card
    if (!card || card.type !== 'component') throw new Error('Expected component fixture')
    card.layout = { item: { position: { mode: 'flow' } }, container: { display: 'block' } }
    documentStore.load(source, componentAtoms, { replace: true })
    documentStore.select('card')
    publishNodeGeometry('card')
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    const shortcut = key()
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).toHaveBeenCalledOnce()
    expect(geometry).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getSnapshot().file?.nodes.card).toMatchObject({ layout: { container: { display: 'flex' } } })
  })

  it('leaves read-only Flex shortcuts unclaimed', () => {
    documentStore.load(file(), [], { replace: true })
    documentStore.select('frame')
    documentStore.setReadOnly(true)
    const shortcut = key()
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
  })

  it('adds Flex to a Grid Component through the measured conversion path', () => {
    const source = componentFile()
    const card = source.nodes.card
    if (!card || card.type !== 'component') throw new Error('Expected component fixture')
    card.layout = { item: { position: { mode: 'flow' } }, container: { display: 'grid', grid: { columns: [{ kind: 'fr', value: 1 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } } }
    documentStore.load(source, componentAtoms, { replace: true })
    documentStore.select('card')
    publishNodeGeometry('card')
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    const shortcut = key()
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).toHaveBeenCalledOnce()
    expect(geometry).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.nodes.card).toMatchObject({ layout: { container: { display: 'flex' } } })
  })

  it('wraps a selected flow child under a Flex parent through Shift+A', () => {
    const source = file(true)
    const frame = source.nodes.frame
    const child = source.nodes.child
    if (!frame || frame.type !== 'frame' || !child || child.type !== 'rectangle') throw new Error('Expected frame fixture')
    frame.layout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', gap: 0, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } }
    child.layout = { item: { position: { mode: 'flow' } } }
    documentStore.load(source, [], { replace: true })
    documentStore.select('child')
    const generation = documentStore.getSnapshot().layoutGeneration
    sceneGeometry.update({
      frame: { canvasKind: 'frame', directChild: true, offsetParentNodeId: null, documentRevision: 0, layoutGeneration: generation, rect: { x: 0, y: 0, width: 101, height: 100 }, worldAabb: { x: 0, y: 0, width: 101, height: 100 }, offset: { x: 0, y: 0, width: 101, height: 100, origin: { x: 50.5, y: 50 } }, offsetParentToRoot: [1, 0, 0, 1, 0, 0] },
      child: { canvasKind: 'rectangle', directChild: true, offsetParentNodeId: 'frame', documentRevision: 0, layoutGeneration: generation, rect: { x: 10, y: 10, width: 20, height: 20 }, worldAabb: { x: 10, y: 10, width: 20, height: 20 }, offset: { x: 10, y: 10, width: 20, height: 20, origin: { x: 10, y: 10 } } },
    }, { documentRevision: 0, layoutGeneration: generation, measurementRevision: 1 })
    const shortcut = key()
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getHistory().past).toHaveLength(1)
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().selection).toStrictEqual(['child'])
  })

  it('leaves a single selected Flex parent unclaimed for plain Shift+A', () => {
    const source = file()
    const frame = source.nodes.frame
    if (!frame || frame.type !== 'frame') throw new Error('Expected frame fixture')
    frame.layout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', gap: 0, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } }
    documentStore.load(source, [], { replace: true })
    documentStore.select('frame')
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    const shortcut = key()
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).not.toHaveBeenCalled()
    expect(geometry).not.toHaveBeenCalled()
  })

  it('omits nested Flex removal before claiming the shortcut or reading geometry', () => {
    const flexContainer = { display: 'flex' as const, gap: 0, flex: { direction: 'row' as const, wrap: 'nowrap' as const, justify: 'start' as const, align: 'start' as const } }
    const source: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'nested-remove', revision: 0,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: { root: { id: 'root', type: 'root' }, outer: { id: 'outer', type: 'frame', name: 'Outer', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 100 }, layout: { item: { position: { mode: 'freeform' } }, container: flexContainer } }, inner: { id: 'inner', type: 'frame', name: 'Inner', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 20, height: 20 }, layout: { item: { position: { mode: 'flow' } }, container: flexContainer } } },
      relationships: { outer: { parentId: 'root', orderKey: 'A' }, inner: { parentId: 'outer', orderKey: 'A' } }, theme: { tokens: {} },
    }
    documentStore.load(source, [], { replace: true })
    documentStore.selectMany(['outer', 'inner'])
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    const toast = vi.spyOn(toastManager, 'add')
    const shortcut = key({ altKey: true })
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).not.toHaveBeenCalled()
    expect(geometry).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })

  it.each([
    [{ busy: 'Saving' }], [{ reviewOpen: true }], [{ shareOpen: true }], [{ shortcutOpen: true }],
  ])('does not claim Flex while an editor-owned blocking scope is active', state => {
    documentStore.load(file(), [], { replace: true })
    documentStore.select('frame')
    editorStore.set(state)
    const shortcut = key()
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
  })

  it('leaves shortcuts inside a semantic dialog or popover to that owner', () => {
    class SemanticElement { closest(selector: string) { return selector.includes('role="dialog"') ? this : null } }
    vi.stubGlobal('Element', SemanticElement)
    documentStore.load(file(), [], { replace: true })
    documentStore.select('frame')
    const shortcut = key({ target: new SemanticElement() as unknown as EventTarget })
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
  })

  it('cancels an active gesture with Escape before modal suppression', () => {
    editorStore.set({ shareOpen: true, busy: 'Saving' })
    const active = vi.spyOn(canvasGestures, 'active', 'get').mockReturnValue(true)
    const cancel = vi.spyOn(canvasGestures, 'cancel').mockImplementation(() => undefined)
    const shortcut = key({ key: 'Escape', shiftKey: false })
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    active.mockRestore()
  })

  it('claims geometry failures and shows action-specific Add, Wrap, and Remove errors', () => {
    const toast = vi.spyOn(toastManager, 'add')
    documentStore.load(file(true), [], { replace: true })
    documentStore.select('frame')
    const add = key()
    editorKeyDown(add.event)
    expect(add.preventDefault).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Couldn't add flex" }))

    documentStore.select('child')
    const wrap = key()
    editorKeyDown(wrap.event)
    expect(wrap.preventDefault).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Couldn't wrap in flex" }))

    documentStore.clear()
    const source = file()
    const frame = source.nodes.frame
    if (!frame || frame.type !== 'frame') throw new Error('Expected frame fixture')
    frame.layout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', gap: 0, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } }
    documentStore.load(source, [], { replace: true })
    documentStore.select('frame')
    const remove = key({ altKey: true })
    editorKeyDown(remove.event)
    expect(remove.preventDefault).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Couldn't remove flex", description: expect.stringContaining('Remove flex') }))
  })

  it('removes only eligible Flex parents from a mixed selection and preserves exact selection through undo and redo', () => {
    const px = (value: number) => ({ kind: 'px' as const, value })
    const source: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'keyboard-remove', revision: 0,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        parent: { id: 'parent', type: 'frame', name: 'Parent', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 200, height: 100 }, layout: { item: { position: { mode: 'absolute', left: px(20), top: px(30) } }, container: { display: 'flex', gap: 10, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
        child: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
        other: { id: 'other', type: 'rectangle', name: 'Other', styles: { relativeTransform: [1, 0, 0, 1, 300, 0], width: 30, height: 30 } },
      },
      relationships: { parent: { parentId: 'root', orderKey: 'A' }, child: { parentId: 'parent', orderKey: 'A' }, other: { parentId: 'root', orderKey: 'B' } }, theme: { tokens: {} },
    }
    documentStore.load(source, [], { replace: true })
    const originalSelection = ['other', 'parent']
    documentStore.selectMany(originalSelection)
    const generation = documentStore.getSnapshot().layoutGeneration
    sceneGeometry.update({
      parent: { canvasKind: 'frame', documentRevision: 0, layoutGeneration: generation, rect: { x: 20, y: 30, width: 200, height: 100 }, offset: { x: 20, y: 30, width: 200, height: 100, origin: { x: 100, y: 50 } }, box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }, offsetParentNodeId: null, directChild: true },
      child: { canvasKind: 'rectangle', documentRevision: 0, layoutGeneration: generation, rect: { x: 20, y: 30, width: 40, height: 20 }, offset: { x: 0, y: 0, width: 40, height: 20, origin: { x: 20, y: 10 } }, offsetParentNodeId: 'parent', directChild: true },
    }, { documentRevision: 0, layoutGeneration: generation, measurementRevision: 1 })
    const shortcut = key({ altKey: true })
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getSnapshot().file?.nodes.parent).toMatchObject({ layout: { container: { display: 'freeform' } } })
    expect(documentStore.getSnapshot().file?.nodes.other).toStrictEqual(source.nodes.other)
    expect(documentStore.getSnapshot().selection).toStrictEqual(originalSelection)
    expect(documentStore.getHistory().past).toHaveLength(1)
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().selection).toStrictEqual(originalSelection)
    expect(documentStore.redo()).toBe(true)
    expect(documentStore.getSnapshot().selection).toStrictEqual(originalSelection)
  })

  it('leaves a mixed Component and non-container selection unclaimed and unchanged', () => {
    documentStore.load(componentFile(), componentAtoms, { replace: true })
    documentStore.selectMany(['card', 'other'])
    const before = structuredClone(documentStore.getSnapshot().file)
    const { event, preventDefault } = key()

    editorKeyDown(event)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file).toEqual(before)
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
    expect(documentStore.getSnapshot().canRedo).toBe(false)
  })

  it('bypasses editable targets and does not claim Shift+Alt+A', () => {
    class InputElement { tagName = 'INPUT'; isContentEditable = false }
    vi.stubGlobal('HTMLElement', InputElement)
    documentStore.load(file(), [], { replace: true })
    documentStore.select('frame')
    const editable = key({ target: new InputElement() as unknown as EventTarget })
    editorKeyDown(editable.event)
    expect(editable.preventDefault).not.toHaveBeenCalled()
    const oldShortcut = key({ altKey: true })
    editorKeyDown(oldShortcut.event)
    expect(oldShortcut.preventDefault).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
  })

  it('reads scene geometry exactly once and rejects a stale final layout-generation fence before writing', () => {
    documentStore.load(file(), [], { replace: true })
    documentStore.select('frame')
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    const current = documentStore.getSnapshot()
    const snapshot = vi.spyOn(documentStore, 'getSnapshot')
      .mockReturnValueOnce(current)
      .mockReturnValueOnce({ ...current, layoutGeneration: current.layoutGeneration + 1 })
      .mockImplementation(() => current)
    const result = directAddFlexToCurrentSelection()
    snapshot.mockRestore()
    expect(result).toEqual({ status: 'unavailable', message: directAddFlexCopy.unavailable })
    expect(geometry).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })

  it('rejects an ancestor and descendant container selection before reading geometry', () => {
    const nested: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'nested-add', revision: 0,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        outer: { id: 'outer', type: 'frame', name: 'Outer', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 200, height: 200 } },
        inner: { id: 'inner', type: 'frame', name: 'Inner', styles: { relativeTransform: [1, 0, 0, 1, 20, 20], width: 100, height: 100 } },
      },
      relationships: { outer: { parentId: 'root-1', orderKey: 'V' }, inner: { parentId: 'outer', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    documentStore.load(nested, [], { replace: true })
    documentStore.selectMany(['outer', 'inner'])
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    expect(directAddFlexToCurrentSelection()).toEqual({ status: 'unavailable', message: directAddFlexCopy.nested })
    expect(geometry).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
  })

  it('keeps a multi-container action atomic when a later component capture is unavailable', () => {
    const source: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'atomic-add', revision: 0,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 100 } },
        card: { id: 'card', type: 'component', componentId: 'card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'freeform' } } },
      },
      relationships: { frame: { parentId: 'root-1', orderKey: 'V' }, card: { parentId: 'root-1', orderKey: 'W' } },
      theme: { tokens: {} },
    }
    documentStore.load(source, componentAtoms, { replace: true })
    documentStore.selectMany(['frame', 'card'])
    const result = directAddFlexToCurrentSelection()
    expect(result).toEqual({ status: 'unavailable', message: directAddFlexCopy.unavailable })
    expect(documentStore.getSnapshot().file).toEqual(source)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })

  it('rejects a text child when the otherwise-current measurement omits resolved line height', () => {
    const style = { fontFamily: 'Inter', fontStyle: 'normal' as const, fontWeight: 400, fontSize: 16, lineHeight: { kind: 'px' as const, value: 20 }, letterSpacing: 0, horizontalAlign: 'left' as const, verticalAlign: 'top' as const, case: 'none' as const, wrap: 'normal' as const, keepWords: false }
    const source: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'missing-text-metric', revision: 0,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 200, height: 100 } },
        text: { id: 'text', type: 'text', name: 'Text', text: 'Missing metric', styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 100, height: 40 }, textStyle: style, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } } },
      },
      relationships: { frame: { parentId: 'root-1', orderKey: 'V' }, text: { parentId: 'frame', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    documentStore.load(source, [], { replace: true })
    documentStore.select('frame')
    const generation = documentStore.getSnapshot().layoutGeneration
    sceneGeometry.update({
      frame: { directChild: true, offsetParentNodeId: null, documentRevision: 0, layoutGeneration: generation, rect: { x: 0, y: 0, width: 200, height: 100 }, offset: { x: 0, y: 0, width: 200, height: 100, origin: { x: 100, y: 50 } } },
      text: { directChild: true, offsetParentNodeId: 'frame', documentRevision: 0, layoutGeneration: generation, rect: { x: 10, y: 10, width: 100, height: 40 }, worldAabb: { x: 10, y: 10, width: 100, height: 40 }, offset: { x: 10, y: 10, width: 100, height: 40, origin: { x: 50, y: 20 } } },
    }, { documentRevision: 0, layoutGeneration: generation, measurementRevision: 1 })
    expect(directAddFlexToCurrentSelection()).toEqual({ status: 'unavailable', message: directAddFlexCopy.unavailable })
    expect(documentStore.getSnapshot().file).toEqual(source)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })
})

describe('COMP-V2-UI-062 source review shortcut', () => {
  it('does not claim Ctrl+S without a prepared source transaction', () => {
    const shortcut = key({ key: 's', ctrlKey: true, shiftKey: false })
    editorKeyDown(shortcut.event)
    expect(shortcut.preventDefault).not.toHaveBeenCalled()
    expect(editorStore.getSnapshot().reviewOpen).toBe(false)
  })
})
