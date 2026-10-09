import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'
import { createEditorStore } from './store'
import type { HistoryStorage } from './document-history'
import type { DesignEditorApi, PreparedChange, ProjectSnapshot } from './types'

const labelAtom = { name: 'Label', kind: 'atom' as const, componentId: 'label-component', path: 'src/Label.tsx', exportName: 'Label', fingerprint: 'f', sourceHash: 'h', status: 'bound' as const, candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] }
const file = (): FileDocument => ({
  schemaVersion: 6, fileId: 'file-a', revision: 3,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    'label-instance': { id: 'label-instance', type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: 'Email' } },
    note: { id: 'note', type: 'frame', name: 'Note', styles: { left: 0, top: 0, width: 120, height: 80, overflow: 'clip' }, appearance: { fills: [{ id: 'note-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }] } },
  },
  relationships: { 'label-instance': { parentId: 'root-1', orderKey: 'V' }, note: { parentId: 'root-2', orderKey: 'V' } },
  theme: { tokens: {} },
})
const project = (): ProjectSnapshot => ({
  projectId: 'fixture-project', fileId: 'file-a', atoms: [labelAtom], sourceHashes: { 'src/Label.tsx': 'h' },
  composition: { id: 'login', name: 'Login', componentId: null, children: [{ id: 'label-instance', componentId: 'label-component', exportName: 'Label', props: { children: 'Email' } }] },
  file: file(), sourceHistory: [], conflict: null, phases: [{ name: 'Read source', completed: 1 }], tokens: [],
  preview: { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: [] },
  designThemes: [{ id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }, { id: 'dark', name: 'Dark', selector: '[data-theme=dark]', attribute: 'dark', colorScheme: 'dark' }],
})
const change: PreparedChange = { id: 'review-1', approvalDigest: 'digest-for-reviewed-input', scope: 'Shared component', summary: 'Update Label padding', files: [{ path: 'src/Label.tsx', before: 'padding: 0', after: 'padding: 8', diff: '-padding: 0\n+padding: 8' }], validation: [{ name: 'Parse', status: 'passed', detail: 'Parsed' }] }
const viewKey = 'design-editor.view-state.v1'
const historyKey = 'design-editor:document-history:v2:file-a'

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const api: HistoryStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
  return { values, api }
}

function setup(options: { storage?: ReturnType<typeof memory>; documents?: boolean } = {}) {
  const save = vi.fn<DesignEditorApi['savePrepared']>().mockResolvedValue({ status: 'saved', transactionId: 'transaction-1', message: 'Saved Label padding', snapshot: project() })
  const refresh = vi.fn<DesignEditorApi['refresh']>().mockResolvedValue(project())
  const prepare = vi.fn<DesignEditorApi['prepareLabelPadding']>().mockResolvedValue(change)
  const prepareToken = vi.fn<DesignEditorApi['prepareToken']>().mockResolvedValue({ ...change, scope: 'Token' })
  const undo = vi.fn<DesignEditorApi['prepareUndo']>().mockResolvedValue(change)
  const redo = vi.fn<DesignEditorApi['prepareRedo']>().mockResolvedValue(change)
  const openFile = vi.fn<NonNullable<DesignEditorApi['openFile']>>().mockImplementation(async () => project())
  const listFiles = vi.fn<NonNullable<DesignEditorApi['listFiles']>>().mockResolvedValue([{ id: 'file-a', name: 'Login', location: 'local' }])
  const saveFile = vi.fn<DesignEditorApi['saveFile']>().mockImplementation(async (next, expected) => ({ ...project(), file: { ...structuredClone(next), revision: expected + 1 } }))
  const available = { available: true, reason: 'Fixture' }
  const unavailable = { available: false, reason: 'Unavailable' }
  const api: DesignEditorApi = {
    capabilities: { runtime: 'desktop', openLabel: 'Open fixture', files: { list: available, create: unavailable, open: available }, sourceWrites: { available: true, reason: 'Explicit test grant' }, localRepository: available, hostedExecution: unavailable, git: unavailable, mcp: unavailable, hostedProjects: unavailable },
    listFiles, openFile, openProject: async () => project(), refresh, saveFile,
    prepareLabelPadding: prepare, prepareToken, preparePromotion: async () => ({ ...change, summary: 'Create LoginForm' }), prepareUndo: undo, prepareRedo: redo, savePrepared: save,
  }
  const storage = options.storage ?? memory()
  const documents = options.documents === false ? undefined : createDocumentStore(() => 'new-id')
  const store = createEditorStore(() => api, documents, () => storage.api)
  return { api, save, refresh, prepare, prepareToken, undo, redo, openFile, listFiles, saveFile, storage, documents: documents!, store }
}
const storedView = (fileId: string, view: object) => ({ [viewKey]: JSON.stringify({ schemaVersion: 1, files: { [fileId]: view } }) })

describe('AT-FILE opening files into the document controller', () => {
  it('loads the snapshot file on the stored view page with its camera and preview theme', async () => {
    const storage = memory(storedView('file-a', { fileId: 'file-a', activePageId: 'page-2', previewThemeId: 'dark', pageViews: { 'page-2': { camera: { x: 12, y: -8, zoom: 2 } } } }))
    const { store, documents, openFile } = setup({ storage })
    await store.openFile('file-a')
    expect(openFile.mock.calls).toEqual([['file-a']])
    expect(documents.getSnapshot().file).toEqual(file())
    expect(documents.getSnapshot().pageId).toBe('page-2')
    expect(documents.getSnapshot().viewport).toEqual({ x: 12, y: -8, zoom: 2 })
    expect(store.getSnapshot().previewThemeId).toBe('dark')
    expect(store.getSnapshot().snapshot?.fileId).toBe('file-a')
    expect(store.getSnapshot().error).toBeNull()
    expect(store.getSnapshot().busy).toBeNull()
  })

  it('opens the first page and requests a fit when no view was stored', async () => {
    const { store, documents, storage } = setup()
    await store.openFile('file-a')
    expect(documents.getSnapshot().pageId).toBe('page-1')
    expect(documents.getSnapshot().fitRequested).toBe('all')
    expect(store.getSnapshot().previewThemeId).toBe('default')
    expect(JSON.parse(storage.values.get(viewKey)!).files['file-a']).toEqual({ fileId: 'file-a', activePageId: 'page-1', previewThemeId: 'default', pageViews: {} })
  })

  it('ignores a stored page that no longer exists', async () => {
    const storage = memory(storedView('file-a', { fileId: 'file-a', activePageId: 'page-gone', previewThemeId: 'default', pageViews: {} }))
    const { store, documents } = setup({ storage })
    await store.openFile('file-a')
    expect(documents.getSnapshot().pageId).toBe('page-1')
  })

  it('remembers the page a page change moves to', async () => {
    const { store, documents, storage } = setup()
    await store.openFile('file-a')
    documents.setViewport({ x: 5, y: 6, zoom: 1.5 })
    documents.setPage('page-2')
    store.pageChanged('page-2')
    const view = JSON.parse(storage.values.get(viewKey)!).files['file-a']
    expect(view.activePageId).toBe('page-2')
    expect(view.pageViews['page-1']).toEqual({ camera: { x: 5, y: 6, zoom: 1.5 } })
  })
})

describe('AT-FILE file locations', () => {
  it('reports a missing file without opening anything', async () => {
    const { store, openFile, documents } = setup()
    expect(await store.openLocation('file-missing', null)).toEqual({ status: 'missing-file', fileId: 'file-missing' })
    expect(openFile).not.toHaveBeenCalled()
    expect(documents.getSnapshot().file).toBeNull()
    expect(store.getSnapshot().busy).toBeNull()
  })

  it('reports a missing page without loading the file', async () => {
    const { store, documents } = setup()
    expect(await store.openLocation('file-a', 'page-x')).toEqual({ status: 'missing-page', fileId: 'file-a', pageId: 'page-x', fileName: 'Login' })
    expect(documents.getSnapshot().file).toBeNull()
  })

  it('opens the requested page and selects the named node', async () => {
    const { store, documents, openFile } = setup()
    expect(await store.openLocation('file-a', 'page-2', 'note')).toEqual({ status: 'ok', fileId: 'file-a', pageId: 'page-2', fileName: 'Login' })
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(documents.getSnapshot().pageId).toBe('page-2')
    expect(documents.getSnapshot().selection).toEqual(['note'])
  })

  it('switches pages on the open file without reloading it', async () => {
    const { store, documents, openFile } = setup()
    await store.openLocation('file-a', 'page-2', 'note')
    const setPage = vi.spyOn(documents, 'setPage')
    const loaded = documents.getSnapshot().file
    expect(await store.openLocation('file-a', 'page-1', 'label-instance')).toEqual({ status: 'ok', fileId: 'file-a', pageId: 'page-1', fileName: 'Login' })
    expect(setPage.mock.calls).toEqual([['page-1']])
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(documents.getSnapshot().file).toBe(loaded)
    expect(documents.getSnapshot().selection).toEqual(['label-instance'])
    // An unknown node id leaves the selection alone.
    expect(await store.openLocation('file-a', null, 'ghost')).toEqual({ status: 'ok', fileId: 'file-a', pageId: 'page-1', fileName: 'Login' })
    expect(documents.getSnapshot().selection).toEqual(['label-instance'])
    expect(await store.openLocation('file-a', 'page-x')).toEqual({ status: 'missing-page', fileId: 'file-a', pageId: 'page-x', fileName: 'Login' })
    expect(documents.getSnapshot().pageId).toBe('page-1')
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable file access when the adapter cannot list files', async () => {
    const { api } = setup()
    const { listFiles: _listFiles, ...withoutListing } = api
    const store = createEditorStore(() => withoutListing, createDocumentStore())
    expect(await store.openLocation('file-a', null)).toEqual({ status: 'unavailable', reason: 'Fixture' })
  })
})

describe('AT-FILE preview theme view state', () => {
  it('accepts only declared design themes and writes the choice to view state', async () => {
    const { store, storage } = setup()
    expect(store.setPreviewTheme('dark')).toBe(false)
    await store.openFile('file-a')
    expect(store.setPreviewTheme('sepia')).toBe(false)
    expect(store.getSnapshot().previewThemeId).toBe('default')
    expect(store.setPreviewTheme('dark')).toBe(true)
    expect(store.getSnapshot().previewThemeId).toBe('dark')
    expect(JSON.parse(storage.values.get(viewKey)!).files['file-a'].previewThemeId).toBe('dark')
    expect(store.setPreviewTheme('dark')).toBe(false)
  })

  it('keeps editor appearance separate from the preview theme', async () => {
    const { store } = setup()
    await store.openFile('file-a')
    store.setAppearance('dark')
    expect(store.getSnapshot().mode).toBe('dark')
    expect(store.getSnapshot().previewThemeId).toBe('default')
  })
})

describe('AT-CAN whole-file persistence', () => {
  it('saves the file at the expected revision and caches undo history under the version 2 key', async () => {
    const { store, documents, saveFile, storage } = setup()
    await store.openFile('file-a')
    documents.select('label-instance')
    expect(documents.commands.setProps('label-instance', { children: 'Username' })).toBe(true)
    const edited = documents.getSnapshot().file!
    const saved = await store.persistFile(edited, 3)
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile.mock.calls[0]![0]).toBe(edited)
    expect(saveFile.mock.calls[0]![1]).toBe(3)
    expect(saved.revision).toBe(4)
    expect(store.getSnapshot().snapshot?.file.revision).toBe(4)
    const payload = JSON.parse(storage.values.get(historyKey)!)
    expect(Object.keys(payload)).toEqual(['version', 'fileId', 'currentFile', 'history'])
    expect(payload.version).toBe(2)
    expect(payload.fileId).toBe('file-a')
    expect(payload.currentFile.revision).toBe(4)
    expect(payload.currentFile.nodes['label-instance'].props.children).toBe('Username')
    expect(payload.history.past).toHaveLength(1)
    expect(payload.history.past[0].file.nodes['label-instance'].props.children).toBe('Email')
    expect(payload.history.past[0].pageId).toBe('page-1')
    expect(payload.history.past[0].selection).toEqual(['label-instance'])
    expect(payload.history.future).toEqual([])
  })

  it('does not cache history when the save is rejected', async () => {
    const { store, documents, saveFile, storage } = setup()
    await store.openFile('file-a')
    documents.commands.setProps('label-instance', { children: 'Username' })
    saveFile.mockRejectedValueOnce(new Error('Revision conflict'))
    await expect(store.persistFile(documents.getSnapshot().file!, 3)).rejects.toThrow('Revision conflict')
    expect(storage.values.has(historyKey)).toBe(false)
  })
})

describe('AT-REVIEW renderer review command gates', () => {
  it('reports unavailable project access without requiring a desktop host', async () => {
    const store = createEditorStore(() => undefined)
    await store.open()
    expect(store.getSnapshot().snapshot).toBeNull()
    expect(store.getSnapshot().busy).toBeNull()
    expect(store.getSnapshot().error).toBe('Project access is unavailable. Reload the editor to reconnect.')
  })

  it('does not invoke a source write before explicit review approval', async () => {
    const { store, save } = setup()
    await store.open()
    await store.prepare()
    expect(store.getSnapshot().prepared?.id).toBe('review-1')
    await store.save()
    expect(save).not.toHaveBeenCalled()
    expect(store.getSnapshot().error).toBe('Prepare a change to review its source diff.')
    store.approve(true)
    await store.save()
    expect(save.mock.calls).toEqual([['review-1', 'digest-for-reviewed-input']])
    expect(store.getSnapshot().notice).toBe('Saved Label padding')
  })

  it('prepares source undo and redo without bypassing explicit approval', async () => {
    const { store, save, undo, redo } = setup()
    await store.open()
    await store.prepareSourceHistory('undo', 'saved-forward-1')
    await store.save()
    expect(undo.mock.calls).toEqual([['saved-forward-1']])
    expect(save).not.toHaveBeenCalled()
    await store.prepareSourceHistory('redo', 'saved-reverse-1')
    expect(redo.mock.calls).toEqual([['saved-reverse-1']])
    expect(store.getSnapshot().approved).toBe(false)
  })

  it('clears source approval when the composition document changes', async () => {
    const { store, save } = setup()
    await store.open()
    await store.prepare()
    store.approve(true)
    store.documentChanged()
    await store.save()
    expect(store.getSnapshot().compositionPreview).toBe(true)
    expect(store.getSnapshot().prepared).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('invalidates reviewed input when padding or scope changes', async () => {
    const { store, save } = setup()
    await store.open()
    await store.prepare()
    store.approve(true)
    store.edit({ padding: '12px', scope: 'Token' })
    expect(store.getSnapshot().prepared).toBeNull()
    expect(store.getSnapshot().approved).toBe(false)
    await store.save()
    expect(save).not.toHaveBeenCalled()
  })

  it('routes Token scope to the token preparation and Instance scope to no source change', async () => {
    const { store, prepare, prepareToken } = setup()
    await store.open()
    store.edit({ scope: 'Token', token: '#123456' })
    await store.prepare()
    expect(prepareToken.mock.calls).toEqual([['#123456']])
    expect(prepare).not.toHaveBeenCalled()
    store.edit({ scope: 'Instance' })
    await store.prepare()
    expect(store.getSnapshot().prepared).toBeNull()
    expect(store.getSnapshot().error).toBe('Instance edits are saved in this document. Create a component to save them as code.')
  })

  it('withholds shared Label changes for an unrelated selection', async () => {
    const { store, prepare } = setup()
    await store.open()
    store.set({ selected: 'unrelated-button-component' })
    await store.prepare()
    expect(prepare).not.toHaveBeenCalled()
    expect(store.getSnapshot().error).toBe('Select Label to edit its shared padding.')
  })

  it('withholds source changes when source writes are unavailable', async () => {
    const { api } = setup()
    const store = createEditorStore(() => ({ ...api, capabilities: { ...api.capabilities!, sourceWrites: { available: false, reason: 'Read-only fixture' } } }))
    await store.open()
    await store.promote()
    expect(store.getSnapshot().prepared).toBeNull()
    expect(store.getSnapshot().error).toBe('Read-only fixture')
  })

  it('prepares a promotion for review without saving it', async () => {
    const { store, save } = setup()
    await store.open()
    await store.promote()
    expect(store.getSnapshot().prepared?.summary).toBe('Create LoginForm')
    expect(store.getSnapshot().preparedKind).toBe('promotion')
    expect(store.getSnapshot().reviewOpen).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects Save if any required validation has not run', async () => {
    const { store, prepare, save } = setup()
    prepare.mockResolvedValue({ ...change, validation: [{ name: 'Types', status: 'not-run', detail: 'Unavailable' }] })
    await store.open()
    await store.prepare()
    store.approve(true)
    await store.save()
    expect(save).not.toHaveBeenCalled()
  })

  it('clears review and displays a conflict after source refresh', async () => {
    const { store, refresh } = setup()
    await store.open()
    await store.prepare()
    store.approve(true)
    refresh.mockResolvedValue({ ...project(), conflict: { kind: 'external-change', message: 'Label changed outside the editor', paths: ['src/Label.tsx'] } })
    await store.refresh()
    expect(store.getSnapshot().snapshot?.conflict?.message).toBe('Label changed outside the editor')
    expect(store.getSnapshot().notice).toBe('Review was cleared. Sync with source before preparing another change.')
    expect(store.getSnapshot().prepared).toBeNull()
    expect(store.getSnapshot().approved).toBe(false)
  })

  it('returns stable snapshots and removes real subscribers', () => {
    const { store } = setup()
    const observed: number[] = []
    const stop = store.subscribe(() => observed.push(store.getSnapshot().zoom))
    expect(store.getSnapshot()).toBe(store.getSnapshot())
    store.set({ zoom: 125 })
    stop()
    store.set({ zoom: 150 })
    expect(observed).toEqual([125])
  })

  it('disposes every subscription without mutating a previously returned snapshot', () => {
    const { store } = setup()
    const original = store.getSnapshot()
    const first: number[] = []
    const second: number[] = []
    const stopFirst = store.subscribe(() => first.push(store.getSnapshot().zoom))
    const stopSecond = store.subscribe(() => second.push(store.getSnapshot().zoom))
    store.set({ zoom: 125 })
    expect(original.zoom).toBe(100)
    expect(store.getSnapshot()).not.toBe(original)
    store.dispose()
    store.set({ zoom: 150 })
    stopFirst()
    stopSecond()
    expect(first).toEqual([125])
    expect(second).toEqual([125])
  })

  it('ignores an outstanding open result after disposal', async () => {
    const { api } = setup()
    let resolve: (snapshot: ProjectSnapshot) => void = () => {}
    const pending = new Promise<ProjectSnapshot>(complete => { resolve = complete })
    const documents = createDocumentStore()
    const pendingApi: DesignEditorApi = { ...api, openProject: () => pending }
    const store = createEditorStore(() => pendingApi, documents)
    const observed = vi.fn()
    store.subscribe(observed)
    const opening = store.open()
    const inFlight = store.getSnapshot()
    expect(inFlight.snapshot).toBeNull()
    expect(observed).toHaveBeenCalledTimes(1)
    store.dispose()
    resolve(project())
    await opening
    expect(store.getSnapshot()).toBe(inFlight)
    expect(store.getSnapshot().snapshot).toBeNull()
    expect(observed).toHaveBeenCalledTimes(1)
    expect(documents.getSnapshot().file).toBeNull()
  })
})
