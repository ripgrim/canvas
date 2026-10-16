import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'
import { configureEditorStore, createEditorStore, waitForEditorStoreConfiguration, withEditorStoreConfiguration } from './store'
import type { HistoryStorage } from './document-history'
import type { DesignEditorApi, PreparedChange, ProjectSnapshot } from './types'
import type { EditorPersistenceIntent } from '../../capabilities'

const labelAtom = { name: 'Label', kind: 'atom' as const, componentId: 'label-component', path: 'src/Label.tsx', exportName: 'Label', fingerprint: 'f', sourceHash: 'h', status: 'bound' as const, candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] }
const file = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'file-a', revision: 3,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    'label-instance': { id: 'label-instance', type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: 'Email' } },
    note: { id: 'note', type: 'frame', name: 'Note', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 80, overflow: 'clip' }, appearance: { fills: [{ id: 'note-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }] } },
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
const projectFor = (fileId: string): ProjectSnapshot => {
  const snapshot = project()
  return { ...snapshot, fileId, file: { ...snapshot.file, fileId } }
}
const change: PreparedChange = { id: 'review-1', approvalDigest: 'digest-for-reviewed-input', scope: 'Shared component', summary: 'Update Label padding', files: [{ path: 'src/Label.tsx', before: 'padding: 0', after: 'padding: 8', diff: '-padding: 0\n+padding: 8' }], validation: [{ name: 'Parse', status: 'passed', detail: 'Parsed' }] }
const viewKey = 'design-editor.view-state.v1'
const historyKey = 'design-editor:document-history:v3:file-a'

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
  const openFile = vi.fn<NonNullable<DesignEditorApi['openFile']>>().mockImplementation(async () => project())
  const openSharedFile = vi.fn<NonNullable<DesignEditorApi['openSharedFile']>>().mockImplementation(async () => project())
  const listFiles = vi.fn<NonNullable<DesignEditorApi['listFiles']>>().mockResolvedValue([{ id: 'file-a', name: 'Login', location: 'local' }])
  const saveFile = vi.fn<DesignEditorApi['saveFile']>().mockImplementation(async (next, expected) => ({ ...project(), file: { ...structuredClone(next), revision: expected + 1 } }))
  const getFileShare = vi.fn<NonNullable<DesignEditorApi['getFileShare']>>().mockResolvedValue({ fileId: 'file-a', access: 'private', updatedAt: '2026-10-10T00:00:00.000Z' })
  const setFileShare = vi.fn<NonNullable<DesignEditorApi['setFileShare']>>().mockImplementation(async (fileId, access) => ({ fileId, access, updatedAt: '2026-10-10T00:00:01.000Z' }))
  const available = { available: true, reason: 'Fixture' }
  const unavailable = { available: false, reason: 'Unavailable' }
  const api: DesignEditorApi = {
    capabilities: { runtime: 'desktop', openLabel: 'Open fixture', files: { list: available, create: unavailable, open: available }, sourceWrites: { available: true, reason: 'Explicit test grant' }, localRepository: available, hostedExecution: unavailable, git: unavailable, mcp: unavailable, hostedProjects: unavailable },
    listFiles, openFile, openSharedFile, openProject: async () => project(), refresh, saveFile, getFileShare, setFileShare, shareUrl: fileId => `https://canvas.test/file/${fileId}`,
    prepareLabelPadding: prepare, prepareToken, preparePromotion: async () => ({ ...change, summary: 'Create LoginForm' }), prepareUndo: async () => change, prepareRedo: async () => change, savePrepared: save,
  }
  const storage = options.storage ?? memory()
  const documents = options.documents === false ? undefined : createDocumentStore(() => 'new-id')
  const store = createEditorStore(() => api, documents, () => storage.api)
  return { api, save, refresh, prepare, prepareToken, openFile, openSharedFile, listFiles, saveFile, getFileShare, setFileShare, storage, documents: documents!, store }
}
const storedView = (fileId: string, view: object) => ({ [viewKey]: JSON.stringify({ schemaVersion: 1, files: { [fileId]: view } }) })

describe('AT-FILE opening files into the document controller', () => {
  it('UI-COLLAB-READONLY-001 opens a public snapshot in the full editor with mutations denied', async () => {
    const { store, documents, openSharedFile, listFiles } = setup()
    expect(await store.openSharedLocation('file-a', 'page-1')).toEqual({ status: 'ok', fileId: 'file-a', pageId: 'page-1', fileName: 'Login' })
    expect(openSharedFile).toHaveBeenCalledWith('file-a')
    expect(listFiles).not.toHaveBeenCalled()
    expect(documents.getSnapshot().readOnly).toBe(true)
    expect(documents.commands.rename('label-instance', 'Changed')).toBe(false)
    expect(documents.getSnapshot().file?.nodes['label-instance']).not.toHaveProperty('name', 'Changed')
  })

  it('UI-COLLAB-READONLY-001 requires owned access before upgrading a public view', async () => {
    const { store, documents, openFile, listFiles } = setup()
    await store.openSharedLocation('file-a', 'page-1')

    expect(await store.openLocation('file-a', 'page-1')).toEqual({ status: 'ok', fileId: 'file-a', pageId: 'page-1', fileName: 'Login' })
    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(openFile).toHaveBeenCalledWith('file-a')
    expect(documents.getSnapshot().readOnly).toBe(false)
    expect(documents.commands.rename('label-instance', 'Changed')).toBe(true)
  })

  it('AT-AUTH-003 clears the rendered file when the authenticated session ends', async () => {
    const { store, documents } = setup()
    await store.openFile('file-a')
    expect(store.getSnapshot().snapshot?.fileId).toBe('file-a')
    expect(documents.getSnapshot().file?.fileId).toBe('file-a')

    store.clearFile()

    expect(store.getSnapshot().snapshot).toBeNull()
    expect(documents.getSnapshot().file).toBeNull()
    expect(documents.getSnapshot().selection).toEqual([])
  })

  it('AT-SHARE-003 loads access without changing it and saves only the selected update', async () => {
    const { store, getFileShare, setFileShare } = setup()
    await store.openFile('file-a')
    await store.openShare()
    expect(getFileShare).toHaveBeenCalledWith('file-a')
    expect(setFileShare).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({ shareOpen: true, shareAccess: 'private', shareDraft: 'private', shareBusy: false })

    store.setShareDraft('view')
    await store.saveShare()
    expect(setFileShare).toHaveBeenCalledWith('file-a', 'view')
    expect(store.getSnapshot()).toMatchObject({ shareAccess: 'view', shareDraft: 'view', shareError: null })
    expect(store.shareUrl()).toBe('https://canvas.test/file/file-a')
  })

  it('AT-SHARE-003 reconciles access when an update response is lost', async () => {
    const { store, getFileShare, setFileShare } = setup()
    await store.openFile('file-a')
    await store.openShare()
    store.setShareDraft('view')
    setFileShare.mockRejectedValueOnce(new Error('Could not update link access.'))
    getFileShare.mockResolvedValueOnce({ fileId: 'file-a', access: 'view', updatedAt: new Date().toISOString() })
    await expect(store.saveShare()).resolves.toBe(true)
    expect(store.getSnapshot()).toMatchObject({ shareAccess: 'view', shareDraft: 'view', shareBusy: false, shareError: null })
  })

  it('AT-SHARE-003 leaves access unconfirmed when update reconciliation also fails', async () => {
    const { store, getFileShare, setFileShare } = setup()
    await store.openFile('file-a')
    await store.openShare()
    store.setShareDraft('view')
    setFileShare.mockRejectedValueOnce(new Error('Could not update link access.'))
    getFileShare.mockRejectedValueOnce(new Error('Offline.'))
    await expect(store.saveShare()).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({ shareAccess: null, shareDraft: 'view', shareBusy: false, shareError: 'Access could not be confirmed. Offline.' })
  })

  it('CLOUD-SYNC-READONLY-001 denies share commands and invalidates an in-flight owner read after downgrade', async () => {
    const owner = setup()
    let resolveShare: ((value: { fileId: string; access: 'private'; updatedAt: string }) => void) | undefined
    owner.getFileShare.mockImplementationOnce(() => new Promise(resolve => { resolveShare = resolve }))
    await owner.store.openFile('file-a')
    owner.store.setShareAuthority(true)
    const pending = owner.store.openShare()
    expect(owner.store.getSnapshot()).toMatchObject({ shareOpen: true, shareBusy: true })

    owner.store.setShareAuthority(false)
    resolveShare?.({ fileId: 'file-a', access: 'private', updatedAt: '2026-10-10T00:00:00.000Z' })
    await pending
    expect(owner.store.getSnapshot()).toMatchObject({ shareOpen: false, shareBusy: false, shareAccess: null, shareDraft: 'private', shareError: null })

    await owner.store.openShare()
    owner.store.setShareDraft('view')
    await expect(owner.store.saveShare()).resolves.toBe(false)
    expect(owner.getFileShare).toHaveBeenCalledTimes(1)
    expect(owner.setFileShare).not.toHaveBeenCalled()
  })

  it('CLOUD-SYNC-READONLY-001 does not reconcile a rejected share update after authority downgrade', async () => {
    const owner = setup()
    let rejectUpdate: ((reason: Error) => void) | undefined
    await owner.store.openFile('file-a')
    owner.store.setShareAuthority(true)
    await owner.store.openShare()
    owner.store.setShareDraft('view')
    owner.setFileShare.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject }))

    const pending = owner.store.saveShare()
    expect(owner.store.getSnapshot().shareBusy).toBe(true)
    owner.store.setShareAuthority(false)
    rejectUpdate?.(new Error('Forbidden after downgrade.'))

    await expect(pending).resolves.toBe(false)
    expect(owner.getFileShare).toHaveBeenCalledTimes(1)
    expect(owner.store.getSnapshot()).toMatchObject({ shareOpen: false, shareBusy: false, shareAccess: null, shareDraft: 'private', shareError: null })
  })

  it('waits for authenticated project access before a file route opens', async () => {
    configureEditorStore(undefined)
    let ready = false
    const pending = waitForEditorStoreConfiguration().then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)

    configureEditorStore(setup().api)
    await pending
    expect(ready).toBe(true)
    configureEditorStore(undefined)
  })

  it('AT-FILE-ACCESS-001 waits again when project access disconnects during route startup', async () => {
    configureEditorStore(setup().api)
    const disconnected = createEditorStore(() => undefined)
    const expected = { status: 'ok' as const, fileId: 'file-a', pageId: 'page-1', fileName: 'Login' }
    let attempts = 0

    const result = await withEditorStoreConfiguration(async () => {
      attempts++
      if (attempts === 1) return disconnected.openLocation('file-a', 'page-1')
      return expected
    })

    expect(result).toEqual(expected)
    expect(attempts).toBe(2)
    configureEditorStore(undefined)
  })

  it('AT-FILE-ACCESS-001 does not retry an unrelated file failure', async () => {
    configureEditorStore(setup().api)
    const failure = new Error('File response was invalid')
    let attempts = 0

    await expect(withEditorStoreConfiguration(async () => {
      attempts++
      throw failure
    })).rejects.toBe(failure)

    expect(attempts).toBe(1)
    configureEditorStore(undefined)
  })

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

  it('FILE-ASSET-LIFECYCLE-001 hydrates open and remote snapshot sidecars before document notifications', async () => {
    const opened = project()
    const asset = { id: 'photo', name: 'photo.png', mime: 'image/png' as const, extension: 'png' as const, width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) }
    opened.file = { ...opened.file, assets: { photo: asset } }
    opened.assetPreviews = [{ assetId: 'photo', sha256: asset.sha256, mime: asset.mime, data: 'AAAA' }]
    const { store, documents, openFile } = setup()
    openFile.mockResolvedValueOnce(opened)
    const observed: unknown[] = []
    documents.subscribe(() => observed.push(documents.assetPreview('photo')))

    await store.openFile('file-a')
    expect(observed.at(-1)).toEqual({ mime: 'image/png', data: 'AAAA' })

    const remote = structuredClone(opened)
    remote.file.revision = 4
    remote.assetPreviews = [{ assetId: 'photo', sha256: asset.sha256, mime: asset.mime, data: 'AQID' }]
    expect(store.receiveExternalSnapshot(remote)).toBe(true)
    expect(observed.at(-1)).toEqual({ mime: 'image/png', data: 'AQID' })
    expect(documents.assetPreview('photo')).toEqual({ mime: 'image/png', data: 'AQID' })
  })

  it('opens the first page and requests a fit when no view was stored', async () => {
    const { store, documents, storage } = setup()
    await store.openFile('file-a')
    expect(documents.getSnapshot().pageId).toBe('page-1')
    expect(documents.getSnapshot().fitRequested).toBe('all')
    expect(store.getSnapshot().previewThemeId).toBe('default')
    expect(JSON.parse(storage.values.get(viewKey)!).files['file-a']).toEqual({ fileId: 'file-a', activePageId: 'page-1', previewThemeId: 'default', pageViews: {} })
  })

  it('CLOUD-SYNC-EDITOR-001 keeps a newer remote snapshot that arrives while the file is opening', async () => {
    const { store, documents, openFile } = setup()
    let finishOpen: (snapshot: ProjectSnapshot) => void = () => undefined
    openFile.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve }))
    const opening = store.openFile('file-a')
    const remote = project()
    remote.file.pages[0]!.name = 'Remote page'
    remote.file.revision = 4
    expect(store.receiveExternalSnapshot(remote)).toBe(false)
    finishOpen(project())
    await opening
    expect(documents.getSnapshot().file?.revision).toBe(4)
    expect(documents.getSnapshot().file?.pages[0]?.name).toBe('Remote page')
  })

  it('CLOUD-SYNC-EDITOR-001 queues the newest update for the destination during a file switch', async () => {
    const { store, documents, openFile } = setup()
    await store.openFile('file-a')
    let finishOpen: (snapshot: ProjectSnapshot) => void = () => undefined
    openFile.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve }))
    const opening = store.openFile('file-b')
    const newest = projectFor('file-b')
    newest.file.pages[0]!.name = 'Newest remote page'
    newest.file.revision = 5
    const older = projectFor('file-b')
    older.file.pages[0]!.name = 'Older remote page'
    older.file.revision = 4
    expect(store.receiveExternalSnapshot(newest)).toBe(false)
    expect(store.receiveExternalSnapshot(older)).toBe(false)
    finishOpen(projectFor('file-b'))
    await opening
    expect(documents.getSnapshot().file?.fileId).toBe('file-b')
    expect(documents.getSnapshot().file?.revision).toBe(5)
    expect(documents.getSnapshot().file?.pages[0]?.name).toBe('Newest remote page')
  })

  it('AT-UX-003 keeps the current file interactive while a different file is opening', async () => {
    const { store, documents, openFile } = setup()
    await store.openFile('file-a')
    documents.select('label-instance')
    let finishOpen: (snapshot: ProjectSnapshot) => void = () => undefined
    openFile.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve }))

    const opening = store.openFile('file-b')
    await vi.waitFor(() => expect(store.getSnapshot().busy).toBe('Reading source'))

    expect(documents.getSnapshot().file?.fileId).toBe('file-a')
    expect(documents.getSnapshot().selection).toEqual(['label-instance'])
    documents.select(null)
    expect(documents.getSnapshot().selection).toEqual([])

    finishOpen(projectFor('file-b'))
    await opening
    expect(documents.getSnapshot().file?.fileId).toBe('file-b')
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
  it('FILE-OPEN-SLOW-001 cancels a superseded open and ignores its late result', async () => {
    const { store, openFile, documents } = setup()
    let finishOpen: ((snapshot: ProjectSnapshot) => void) | undefined
    openFile.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve }))
    const controller = new AbortController()
    const pending = store.openLocation('file-a', null, null, controller.signal)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce())
    controller.abort(Object.assign(new Error('This file open was cancelled.'), { code: 'file_open_cancelled' }))

    const result = await pending
    expect(result).toMatchObject({ status: 'error', message: 'This file open was cancelled.' })
    expect(result.status === 'error' ? result.reference : null).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: 'This file open was cancelled.' })
    finishOpen?.(project())
    await Promise.resolve()
    expect(documents.getSnapshot().file).toBeNull()
    expect(store.getSnapshot()).toMatchObject({ snapshot: null, busy: null, error: 'This file open was cancelled.' })
  })

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
  it('CLOUD-SYNC-EDITOR-001 applies remote snapshots when the local document is clean', async () => {
    const { store, documents } = setup()
    await store.openFile('file-a')
    const remote = project()
    remote.file.pages[0]!.name = 'Remote page'
    remote.file.revision = 4
    expect(store.receiveExternalSnapshot(remote)).toBe(true)
    expect(documents.getSnapshot().file?.pages[0]?.name).toBe('Remote page')
    expect(store.getSnapshot().snapshot?.file.revision).toBe(4)
  })

  it('CLOUD-SYNC-EDITOR-001 ignores equal and older snapshots instead of rolling the document back', async () => {
    const { store, documents } = setup()
    await store.openFile('file-a')
    for (const revision of [3, 2]) {
      const stale = project()
      stale.file.pages[0]!.name = `Stale page ${revision}`
      stale.file.revision = revision
      expect(store.receiveExternalSnapshot(stale)).toBe(false)
    }
    expect(documents.getSnapshot().file?.revision).toBe(3)
    expect(documents.getSnapshot().file?.pages[0]?.name).toBe('Page 1')
  })

  it('CLOUD-SYNC-CONFLICT-001 rebases unsaved local edits when a remote snapshot arrives', async () => {
    const { store, documents } = setup()
    await store.openFile('file-a')
    documents.commands.setProps('label-instance', { children: 'Local edit' })
    const remote = project()
    remote.file.pages[0]!.name = 'Remote page'
    remote.file.revision = 4
    expect(store.receiveExternalSnapshot(remote)).toBe(true)
    expect(documents.getSnapshot().file?.nodes['label-instance']).toMatchObject({ props: { children: 'Local edit' } })
    expect(documents.getSnapshot().file?.pages[0]?.name).toBe('Remote page')
    expect(store.getSnapshot().snapshot?.conflict).toBeNull()
  })

  it('saves the file at the expected revision and caches semantic undo history under the version 3 key', async () => {
    const { store, documents, saveFile, storage } = setup()
    await store.openFile('file-a')
    documents.select('label-instance')
    expect(documents.commands.setProps('label-instance', { children: 'Username' })).toBe(true)
    const edited = documents.getSnapshot().file!
    const intent: EditorPersistenceIntent = { kind: 'commands', commands: [{ type: 'node.setProps', nodeId: 'label-instance', props: { children: 'Username' } }] }
    const saved = await store.persistFile(edited, 3, intent)
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile.mock.calls[0]![0]).toBe(edited)
    expect(saveFile.mock.calls[0]![1]).toBe(3)
    expect(saveFile.mock.calls[0]![2]).toBe(intent)
    expect(saved.revision).toBe(4)
    expect(store.getSnapshot().snapshot?.file.revision).toBe(4)
    const payload = JSON.parse(storage.values.get(historyKey)!)
    expect(Object.keys(payload)).toEqual(['version', 'fileId', 'currentFile', 'history'])
    expect(payload.version).toBe(3)
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
