import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { classifyPaperFlexAction, executePaperFlexAction, paperFlexActionCandidates } from './layout-flex-actions'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { canvasGestures } from './canvas-gestures'
import { editorStore } from './store'

const fixture = (): FileDocument => ({
  schemaVersion: 9,
  fileId: 'flex-actions',
  revision: 0,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    free: { id: 'free', type: 'frame', name: 'Free', styles: { left: 0, top: 0, width: 100, height: 100 } },
    flex: { id: 'flex', type: 'frame', name: 'Flex', styles: { left: 120, top: 0, width: 100, height: 100 }, layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 120 }, top: { kind: 'px', value: 0 } } }, container: { display: 'flex', gap: 0, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    nestedFlex: { id: 'nestedFlex', type: 'frame', name: 'Nested flex', styles: { left: 0, top: 0, width: 40, height: 40 }, layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', gap: 0, flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    rect: { id: 'rect', type: 'rectangle', name: 'Rect', styles: { left: 0, top: 0, width: 20, height: 20 } },
    flow: { id: 'flow', type: 'rectangle', name: 'Flow', styles: { left: 0, top: 0, width: 20, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
    card: { id: 'card', type: 'component', componentId: 'card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'grid', grid: { columns: [{ kind: 'px', value: 100 }], rows: [{ kind: 'px', value: 100 }], autoFlow: 'row' } } } },
  },
  relationships: {
    free: { parentId: 'root', orderKey: 'A' }, flex: { parentId: 'root', orderKey: 'B' }, rect: { parentId: 'root', orderKey: 'C' }, card: { parentId: 'root', orderKey: 'D' }, flow: { parentId: 'flex', orderKey: 'A' }, nestedFlex: { parentId: 'flex', orderKey: 'B' },
  },
  theme: { tokens: {} },
})

afterEach(() => { documentStore.clear(); sceneGeometry.clear(); editorStore.set({ busy: null }) })

describe('Paper Flex action authority', () => {
  it.each([
    [[], false, false, null],
    [['missing'], false, false, null],
    [['root'], false, false, null],
    [['free'], true, false, null],
    [['free'], false, true, null],
    [['free'], false, false, 'add-flex-to-node'],
    [['card'], false, false, 'add-flex-to-node'],
    [['flex'], false, false, 'remove-flex'],
    [['rect'], false, false, 'wrap-in-flex'],
    [['rect', 'free'], false, false, 'wrap-in-flex'],
    [['flex', 'rect'], false, false, 'wrap-in-flex-or-remove-flex'],
  ] as const)('classifies selection %j without conflating structural support', (selection, readOnly, pointerBusy, expected) => {
    expect(classifyPaperFlexAction({ file: fixture(), selection, readOnly, pointerBusy })).toBe(expected)
  })

  it('omits unsupported mixed Component wrapping while retaining eligible removal', () => {
    expect(paperFlexActionCandidates({ file: fixture(), selection: ['flex', 'card'], readOnly: false, pointerBusy: false })).toStrictEqual([
      { action: 'remove-flex', targetIds: ['flex'] },
    ])
  })

  it('offers separate Wrap and Remove candidates for a supported combined selection', () => {
    expect(paperFlexActionCandidates({ file: fixture(), selection: ['flex', 'rect'], readOnly: false, pointerBusy: false })).toStrictEqual([
      { action: 'wrap-in-flex', targetIds: ['flex', 'rect'] },
      { action: 'remove-flex', targetIds: ['flex'] },
    ])
  })

  it('omits Remove for nested selected Flex parents', () => {
    expect(paperFlexActionCandidates({ file: fixture(), selection: ['flex', 'nestedFlex'], readOnly: false, pointerBusy: false })).toStrictEqual([])
  })

  it('allows an ordinary child already flowing under Flex to be wrapped', () => {
    expect(paperFlexActionCandidates({ file: fixture(), selection: ['flow'], readOnly: false, pointerBusy: false })).toStrictEqual([
      { action: 'wrap-in-flex', targetIds: ['flow'] },
    ])
  })

  it('keeps Wrap available for valid sibling groups under different parents', () => {
    expect(paperFlexActionCandidates({ file: fixture(), selection: ['rect', 'flow'], readOnly: false, pointerBusy: false })).toStrictEqual([
      { action: 'wrap-in-flex', targetIds: ['rect', 'flow'] },
    ])
  })

  it('executes valid multi-parent Wrap groups in one revision from one geometry snapshot', () => {
    const file = fixture()
    delete file.nodes.card
    delete file.relationships.card
    documentStore.load(file, [], { replace: true })
    documentStore.selectMany(['rect', 'flow'])
    const generation = documentStore.getSnapshot().layoutGeneration
    sceneGeometry.update({
      flex: { canvasKind: 'frame', directChild: true, offsetParentNodeId: null, documentRevision: 0, layoutGeneration: generation, rect: { x: 120, y: 0, width: 100, height: 100 }, worldAabb: { x: 120, y: 0, width: 100, height: 100 }, offset: { x: 120, y: 0, width: 100, height: 100, origin: { x: 50, y: 50 } }, offsetParentToRoot: [1, 0, 0, 1, 0, 0] },
      rect: { canvasKind: 'rectangle', directChild: true, offsetParentNodeId: null, documentRevision: 0, layoutGeneration: generation, rect: { x: 0, y: 0, width: 20, height: 20 }, worldAabb: { x: 0, y: 0, width: 20, height: 20 }, offset: { x: 0, y: 0, width: 20, height: 20, origin: { x: 10, y: 10 } }, offsetParentToRoot: [1, 0, 0, 1, 0, 0] },
      flow: { canvasKind: 'rectangle', directChild: true, offsetParentNodeId: 'flex', documentRevision: 0, layoutGeneration: generation, rect: { x: 130, y: 10, width: 20, height: 20 }, worldAabb: { x: 130, y: 10, width: 20, height: 20 }, offset: { x: 10, y: 10, width: 20, height: 20, origin: { x: 10, y: 10 } } },
    }, { documentRevision: 0, layoutGeneration: generation, measurementRevision: 1 })
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    expect(executePaperFlexAction('wrap-in-flex')).toStrictEqual({ status: 'written', action: 'wrap-in-flex' })
    expect(geometry).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getHistory().past).toHaveLength(1)
    expect(documentStore.getSnapshot().selection).toHaveLength(2)
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().selection).toStrictEqual(['rect', 'flow'])
  })

  it('does not mutate classifier inputs', () => {
    const file = fixture()
    const input = { file, selection: ['flex', 'rect'], readOnly: false, pointerBusy: false } as const
    const before = JSON.stringify(input)
    paperFlexActionCandidates(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each([
    ['file object replacement', (state: ReturnType<typeof documentStore.getSnapshot>) => ({ ...state, file: structuredClone(state.file) })],
    ['ordered selection drift', (state: ReturnType<typeof documentStore.getSnapshot>) => ({ ...state, selection: ['rect', 'free'] })],
    ['layout-generation drift', (state: ReturnType<typeof documentStore.getSnapshot>) => ({ ...state, layoutGeneration: state.layoutGeneration + 1 })],
    ['read-only transition', (state: ReturnType<typeof documentStore.getSnapshot>) => ({ ...state, readOnly: true })],
  ] as const)('fails closed after geometry capture on %s', (_label, drift) => {
    const file = fixture()
    delete file.nodes.card
    delete file.relationships.card
    documentStore.load(file, [], { replace: true })
    documentStore.select('free')
    const current = documentStore.getSnapshot()
    const snapshot = vi.spyOn(documentStore, 'getSnapshot').mockReturnValueOnce(current).mockReturnValueOnce(drift(current)).mockImplementation(() => current)
    expect(executePaperFlexAction('add-flex-to-node')).toStrictEqual({ status: 'unavailable', action: 'add-flex-to-node', message: 'The document or selection changed before Flex could be applied. Try again.' })
    snapshot.mockRestore()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })

  it.each([['fileId', 'changed-file'], ['revision', 9]] as const)('fences in-place %s drift against captured scalar authority', (field, value) => {
    const file = fixture()
    delete file.nodes.card
    delete file.relationships.card
    documentStore.load(file, [], { replace: true })
    documentStore.select('free')
    const current = documentStore.getSnapshot()
    const original = current.file![field]
    const snapshot = vi.spyOn(documentStore, 'getSnapshot').mockReturnValueOnce(current).mockImplementationOnce(() => {
      Object.assign(current.file!, { [field]: value })
      return current
    }).mockImplementation(() => current)
    expect(executePaperFlexAction('add-flex-to-node').status).toBe('unavailable')
    Object.assign(current.file!, { [field]: original })
    snapshot.mockRestore()
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })

  it('fences a pointer-busy transition after the one geometry capture', () => {
    const file = fixture()
    delete file.nodes.card
    delete file.relationships.card
    documentStore.load(file, [], { replace: true })
    documentStore.select('free')
    const active = vi.spyOn(canvasGestures, 'active', 'get').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')
    expect(executePaperFlexAction('add-flex-to-node').status).toBe('unavailable')
    expect(geometry).toHaveBeenCalledOnce()
    active.mockRestore()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
  })

  it('does not inspect geometry or write while an editor operation is already busy', () => {
    const source = fixture()
    delete source.nodes.card
    delete source.relationships.card
    documentStore.load(source, [], { replace: true })
    documentStore.select('free')
    editorStore.set({ busy: 'Saving' })
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot')

    expect(executePaperFlexAction('add-flex-to-node')).toStrictEqual({ status: 'ineligible', action: 'add-flex-to-node' })
    expect(geometry).not.toHaveBeenCalled()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().selection).toStrictEqual(['free'])
    expect(documentStore.getHistory().past).toHaveLength(0)
  })

  it('fences a busy transition after geometry capture without changing document or history', () => {
    const source = fixture()
    delete source.nodes.card
    delete source.relationships.card
    documentStore.load(source, [], { replace: true })
    documentStore.select('free')
    const capturedGeometry = sceneGeometry.getSnapshot()
    const geometry = vi.spyOn(sceneGeometry, 'getSnapshot').mockImplementationOnce(() => {
      editorStore.set({ busy: 'Saving' })
      return capturedGeometry
    })

    expect(executePaperFlexAction('add-flex-to-node')).toStrictEqual({
      status: 'unavailable',
      action: 'add-flex-to-node',
      message: 'The document or selection changed before Flex could be applied. Try again.',
    })
    expect(geometry).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().selection).toStrictEqual(['free'])
    expect(documentStore.getHistory().past).toHaveLength(0)
  })
})
