import type { DesignEditorApi, PreparedChange, ProjectSnapshot } from './types'
import { editorCopy } from './copy'
import { createDocument } from '@canvas/repo-engine/document'
import { legacyPageDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { resolveDesignTheme } from '@canvas/repo-engine/design-themes'
import { documentStore } from './document-store'
import { loadDocumentHistory, saveDocumentHistory } from './document-history'
import type { HistoryStorage } from './document-history'
import { readFileView, writeFileView } from './view-state'
import type { FileViewState } from './view-state'
import { createStore } from 'zustand/vanilla'
import { readAppearance, writeAppearance } from '../application/appearance'
import type { EditorAppearance } from '../application/appearance'
import { unavailableCapabilities, UnavailableCapabilityError } from '../../capabilities'
import type { EditorCapabilities } from '../../capabilities'

export type EditorState = {
  capabilities: EditorCapabilities;
  /** Editor chrome appearance: a user preference, never sent to the design preview. */
  mode: 'light' | 'dark'; tab: string; scope: PreparedChange['scope']; selected: string | null; zoom: number;
  snapshot: ProjectSnapshot | null; prepared: PreparedChange | null; approved: boolean; busy: string | null;
  error: string | null; notice: string | null; reviewOpen: boolean; shortcutOpen: boolean; shareOpen: boolean;
  padding: string; token: string; componentName: string; previewReady: boolean;
  runtimeInstanceIds: readonly string[] | null;
  compositionPreview: boolean; preparedKind: 'edit' | 'promotion' | 'reverse' | null;
  /** Design preview theme of the open file: a per-file viewing preference restored from view state. */
  previewThemeId: string | null;
}
type DocumentController = Pick<typeof documentStore, 'getSnapshot' | 'load' | 'getHistory' | 'restoreHistory' | 'setViewport' | 'requestFit' | 'selectMany' | 'setPage' | 'subscribe'>
/** Result of opening a file URL. Missing and invalid locations never create or substitute a file. */
export type FileLocationResult =
  | { status: 'ok'; fileId: string; pageId: string | null; fileName: string }
  | { status: 'missing-file'; fileId: string }
  | { status: 'missing-page'; fileId: string; pageId: string; fileName: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }
  | { status: 'stale' }
/** Adapters that migrated an older record may hand over the page and preview theme it was saved with, once. */
type LegacyViewHandOff = { legacyView?: { activePageId: string; previewTheme?: string } }
const cameraWriteDelayMs = 250

export function createEditorStore(api: () => DesignEditorApi | undefined, documents?: DocumentController, storage?: () => HistoryStorage) {
  const backing = createStore<EditorState>(() => ({ capabilities: api()?.capabilities ?? unavailableCapabilities, mode: readAppearance(), tab: 'Layers', scope: 'Shared component', selected: null, zoom: 100, snapshot: null, prepared: null, approved: false, busy: null, error: null, notice: null, reviewOpen: false, shortcutOpen: false, shareOpen: false, padding: '8px', token: '#009ff0', componentName: 'LoginForm', previewReady: false, compositionPreview: false, runtimeInstanceIds: null, preparedKind: null, previewThemeId: null }))
  const subscriptions = new Set<() => void>()
  const update = (patch: Partial<EditorState>) => backing.setState(patch)
  let generation = 0
  let locationGeneration = 0
  let historyProjectId: string | null = null
  let view: FileViewState | null = null
  let cameraTimer: ReturnType<typeof setTimeout> | null = null
  let stopCameraWatch: (() => void) | undefined
  const pendingExternalSnapshots = new Map<string, ProjectSnapshot>()
  const fileIdentity = (snapshot: ProjectSnapshot) => snapshot.fileId ?? snapshot.file.fileId ?? snapshot.projectId
  const connection = () => { const project = api(); if (!project) throw new Error(editorCopy.projectAccessUnavailable); return project }
  const sourceConnection = () => { const bridge = connection(); if (!bridge.capabilities?.sourceWrites.available) throw new UnavailableCapabilityError(bridge.capabilities?.sourceWrites.reason ?? editorCopy.sourceUnavailable); return bridge }
  const queueExternalSnapshot = (snapshot: ProjectSnapshot) => {
    const identity = fileIdentity(snapshot)
    const pending = pendingExternalSnapshots.get(identity)
    if (!pending || snapshot.file.revision > pending.file.revision) pendingExternalSnapshots.set(identity, snapshot)
  }
  const newestSnapshot = (snapshot: ProjectSnapshot) => {
    const identity = fileIdentity(snapshot)
    const pending = pendingExternalSnapshots.get(identity)
    pendingExternalSnapshots.delete(identity)
    if (!pending) return snapshot
    return pending.file.revision > snapshot.file.revision ? pending : snapshot
  }
  const viewStorage = () => { try { return storage?.() ?? null } catch { return null } }
  const persistView = () => { if (view) writeFileView(view, viewStorage()) }
  /** Captures the current camera for the open page without writing on every pan frame. */
  const rememberCamera = (immediate = false) => {
    const current = documents?.getSnapshot()
    if (!view || !current?.pageId || !current.file || current.file.fileId !== view.fileId) return
    view = { ...view, pageViews: { ...view.pageViews, [current.pageId]: { camera: { ...current.viewport } } } }
    if (cameraTimer) clearTimeout(cameraTimer)
    if (immediate) { cameraTimer = null; persistView(); return }
    cameraTimer = setTimeout(() => { cameraTimer = null; persistView() }, cameraWriteDelayMs)
  }
  const applyCamera = (pageId: string) => {
    const camera = view?.pageViews[pageId]?.camera
    if (camera) documents?.setViewport(camera)
    else documents?.requestFit('all')
  }
  /** A node named by the URL becomes the selection when it exists on the open page; unknown ids leave the selection alone. */
  const selectLocationNode = (nodeId: string | null) => {
    if (!nodeId || !documents) return
    const state = documents.getSnapshot()
    const present = Boolean(state.file?.nodes[nodeId] && state.file.nodes[nodeId]!.type !== 'root')
    if (present && !state.selection.includes(nodeId)) documents.selectMany([nodeId])
  }
  const receiveFile = (snapshot: ProjectSnapshot & LegacyViewHandOff, requestedPageId: string | null = null) => {
    if (!documents) return { modified: false, projectChanged: false }
    const identity = fileIdentity(snapshot)
    const projectChanged = historyProjectId !== null && historyProjectId !== identity
    if (historyProjectId !== null && projectChanged) rememberCamera(true)
    if (historyProjectId === null || projectChanged) {
      const stored = readFileView(identity, viewStorage())
      const themes = snapshot.designThemes ?? []
      const defaultTheme = themes.length ? resolveDesignTheme(themes, stored?.previewThemeId ?? snapshot.legacyView?.previewTheme).id : 'default'
      // Older records settle on the page and preview theme they were last saved with, exactly once.
      const next = stored ?? { fileId: identity, activePageId: snapshot.legacyView?.activePageId ?? snapshot.file.pages[0]!.id, previewThemeId: defaultTheme, pageViews: {} }
      view = themes.some(theme => theme.id === next.previewThemeId) ? next : { ...next, previewThemeId: defaultTheme }
    }
    const pageId = [requestedPageId, view?.activePageId].find(candidate => candidate && snapshot.file.pages.some(page => page.id === candidate)) ?? snapshot.file.pages[0]!.id
    documents.load(snapshot.file, snapshot.atoms, { replace: projectChanged, pageId })
    const baseline = createDocument(snapshot.atoms, snapshot.composition, { allowUnavailableBindings: true })
    const firstPage = legacyPageDocument(snapshot.file, snapshot.file.pages[0]!.id)
    const modified = JSON.stringify({ ...firstPage, revision: 0 }) !== JSON.stringify({ ...baseline, revision: 0 })
    if (historyProjectId === null || projectChanged) applyCamera(pageId)
    if (view) { view = { ...view, activePageId: pageId }; persistView() }
    update({ previewThemeId: view?.previewThemeId ?? null })
    if (storage && historyProjectId !== identity) {
      historyProjectId = identity
      try {
        const history = loadDocumentHistory(storage(), identity, snapshot.file, snapshot.atoms)
        if (history) documents.restoreHistory(history)
      } catch { update({ error: editorCopy.historyLoadFailed }) }
    }
    return { modified, projectChanged }
  }
  const run = async (phase: string, task: () => Promise<Partial<EditorState>>) => {
    const state = backing.getState()
    if (state.busy) return false
    const current = ++generation
    // Saving keeps the reviewed change and its approval; every other phase starts from a clean review state.
    update({ busy: phase, error: null, notice: null, ...(phase === editorCopy.saving ? {} : { prepared: null, approved: false }) })
    try { const result = await task(); if (current === generation) update(result); return current === generation }
    catch (error) { if (current === generation) update({ error: error instanceof Error ? error.message : editorCopy.error }); return false }
    finally { if (current === generation) update({ busy: null }) }
  }
  const load = (refresh: boolean, fileId?: string) => run(refresh ? editorCopy.syncing : editorCopy.opening, async () => {
    const active = connection()
    const started = generation
    const loaded = refresh ? await active.refresh() : fileId ? await (active.openFile ?? (() => { throw new Error(active.capabilities?.files.open.reason ?? editorCopy.projectAccessUnavailable) }))(fileId) : await active.openProject()
    // A result that lands after disposal or a newer operation must not touch the document, view state, or history.
    if (connection() !== active || started !== generation) return {}
    const snapshot = newestSnapshot(loaded)
    const received = receiveFile(snapshot)
    const state = backing.getState()
    return { snapshot, compositionPreview: received.modified && (!snapshot.composition.componentId || state.compositionPreview), token: snapshot.tokens[0]?.value ?? state.token, prepared: null, approved: false, previewReady: !received.projectChanged && state.snapshot?.preview.activeGeneration === snapshot.preview.activeGeneration && state.previewReady, runtimeInstanceIds: received.projectChanged ? null : state.runtimeInstanceIds, selected: received.projectChanged ? snapshot.composition.children[0]?.id ?? null : state.selected ?? snapshot.composition.children[0]?.id ?? null, notice: snapshot.conflict ? editorCopy.conflictHint : editorCopy.ready }
  })
  const watchCamera = () => {
    if (stopCameraWatch || !documents) return
    let lastViewport = documents.getSnapshot().viewport
    stopCameraWatch = documents.subscribe(() => { const next = documents.getSnapshot().viewport; if (next !== lastViewport) { lastViewport = next; rememberCamera() } })
  }
  watchCamera()
  return {
    getSnapshot: backing.getState,
    subscribe: (listener: () => void) => {
      const stop = backing.subscribe(listener)
      const unsubscribe = () => { stop(); subscriptions.delete(unsubscribe) }
      subscriptions.add(unsubscribe)
      return unsubscribe
    },
    set: (patch: Partial<EditorState>) => update(patch),
    /** Editor chrome appearance: a user preference that never reaches the design preview. */
    setAppearance: (mode: EditorAppearance) => { writeAppearance(mode); update({ mode }) },
    /** Design preview theme for the open file: a view-state change, never a document change. */
    setPreviewTheme: (themeId: string): boolean => {
      const snapshot = backing.getState().snapshot
      if (!snapshot || !view || !snapshot.designThemes?.some(theme => theme.id === themeId) || view.previewThemeId === themeId) return false
      view = { ...view, previewThemeId: themeId }
      persistView()
      update({ previewThemeId: themeId })
      return true
    },
    /** Called by the document store when the open page changes: swap cameras and remember the page. */
    pageChanged: (pageId: string) => {
      if (!view) return
      // The previous page's camera is still the live viewport until the new page applies its own.
      const previous = view.activePageId
      if (previous !== pageId) { const current = documents?.getSnapshot(); if (current) view = { ...view, pageViews: { ...view.pageViews, [previous]: { camera: { ...current.viewport } } } } }
      view = { ...view, activePageId: pageId }
      applyCamera(pageId)
      persistView()
    },
    edit: (patch: Partial<EditorState>) => { if (!backing.getState().busy) update({ ...patch, prepared: null, approved: false }) },
    documentChanged: () => update({ prepared: null, approved: false, compositionPreview: backing.getState().runtimeInstanceIds === null }),
    /** Persists the whole file; the acknowledged file is the new base revision. History is cached only after success. */
    persistFile: async (file: FileDocument, expectedRevision: number) => {
      const history = documents?.getHistory()
      const snapshot = await connection().saveFile(file, expectedRevision)
      update({ snapshot, prepared: null, approved: false })
      if (storage && history) {
        try { saveDocumentHistory(storage(), fileIdentity(snapshot), snapshot.file, history) }
        catch { update({ error: editorCopy.historySaveFailed }) }
      }
      return snapshot.file
    },
    receiveExternalSnapshot: (snapshot: ProjectSnapshot) => {
      const state = backing.getState()
      if (state.busy === editorCopy.opening || state.busy === editorCopy.syncing) {
        queueExternalSnapshot(snapshot)
        return false
      }
      if (!state.snapshot || fileIdentity(state.snapshot) !== fileIdentity(snapshot)) return false
      if (snapshot.file.revision <= state.snapshot.file.revision) return false
      const localFile = documents?.getSnapshot().file
      const localChanged = Boolean(localFile && JSON.stringify(localFile) !== JSON.stringify(state.snapshot.file))
      if (state.busy || localChanged) {
        update({
          snapshot: { ...state.snapshot, conflict: { kind: 'external-change', message: editorCopy.liveConflict, paths: [] } },
          prepared: null,
          approved: false,
          notice: editorCopy.conflictHint,
        })
        return false
      }
      const received = receiveFile(snapshot)
      update({
        snapshot,
        compositionPreview: received.modified && (!snapshot.composition.componentId || state.compositionPreview),
        token: snapshot.tokens[0]?.value ?? state.token,
        prepared: null,
        approved: false,
        previewReady: !received.projectChanged && state.snapshot.preview.activeGeneration === snapshot.preview.activeGeneration && state.previewReady,
        runtimeInstanceIds: received.projectChanged ? null : state.runtimeInstanceIds,
        selected: received.projectChanged ? snapshot.composition.children[0]?.id ?? null : state.selected ?? snapshot.composition.children[0]?.id ?? null,
        notice: snapshot.conflict ? editorCopy.conflictHint : editorCopy.ready,
      })
      return true
    },
    open: () => load(false), openFile: (fileId: string) => load(false, fileId), refresh: () => load(true),
    /**
     * Opens a file (and optionally one of its pages) for a route. Newer calls supersede older ones, so a slow load can never
     * land another file's data in the editor. Reopening the current location only switches the page or selection.
     */
    openLocation: async (fileId: string, pageId: string | null, nodeId: string | null = null): Promise<FileLocationResult> => {
      const token = ++locationGeneration
      const current = backing.getState()
      const openFile = documents?.getSnapshot().file
      if (current.snapshot && fileIdentity(current.snapshot) === fileId && openFile && !current.busy) {
        if (pageId !== null && !openFile.pages.some(page => page.id === pageId)) return { status: 'missing-page', fileId, pageId, fileName: current.snapshot.composition.name }
        if (pageId !== null) documents!.setPage(pageId)
        selectLocationNode(nodeId)
        return { status: 'ok', fileId, pageId: documents!.getSnapshot().pageId, fileName: current.snapshot.composition.name }
      }
      const active = connection()
      if (!active.openFile || !active.listFiles) return { status: 'unavailable', reason: active.capabilities?.files.open.reason ?? editorCopy.projectAccessUnavailable }
      generation++
      update({ busy: editorCopy.opening, error: null, notice: null, approved: false, prepared: null })
      try {
        const files = await active.listFiles()
        if (token !== locationGeneration) return { status: 'stale' }
        if (!files.some(file => file.id === fileId)) { update({ busy: null }); return { status: 'missing-file', fileId } }
        const loaded = await active.openFile(fileId)
        if (token !== locationGeneration) return { status: 'stale' }
        const snapshot = newestSnapshot(loaded)
        if (pageId !== null && !snapshot.file.pages.some(page => page.id === pageId)) { update({ busy: null }); return { status: 'missing-page', fileId, pageId, fileName: snapshot.composition.name } }
        if (connection() !== active) return { status: 'stale' }
        const received = receiveFile(snapshot, pageId)
        const state = backing.getState()
        update({ snapshot, compositionPreview: received.modified && (!snapshot.composition.componentId || state.compositionPreview), token: snapshot.tokens[0]?.value ?? state.token, prepared: null, approved: false, previewReady: !received.projectChanged && state.snapshot?.preview.activeGeneration === snapshot.preview.activeGeneration && state.previewReady, runtimeInstanceIds: received.projectChanged ? null : state.runtimeInstanceIds, selected: received.projectChanged ? snapshot.composition.children[0]?.id ?? null : state.selected ?? snapshot.composition.children[0]?.id ?? null, notice: snapshot.conflict ? editorCopy.conflictHint : editorCopy.ready, busy: null })
        selectLocationNode(nodeId)
        return { status: 'ok', fileId, pageId: documents?.getSnapshot().pageId ?? null, fileName: snapshot.composition.name }
      } catch (error) {
        if (token !== locationGeneration) return { status: 'stale' }
        const message = error instanceof Error ? error.message : editorCopy.error
        update({ busy: null, error: message })
        return { status: 'error', message }
      }
    },
    prepare: () => run(editorCopy.preparing, async () => {
      const state = backing.getState()
      if (!state.snapshot) throw new Error(editorCopy.initial)
      if (state.scope === 'Instance') throw new Error(editorCopy.instanceHint)
      if (state.scope === 'Shared component') {
        const child = state.snapshot.composition.children.find(item => item.id === state.selected)
        const node = documents?.getSnapshot().file?.nodes[state.selected ?? '']
        const componentId = node?.type === 'component' ? node.componentId : undefined
        const selected = state.snapshot.atoms.find(atom => atom.componentId === (componentId ?? child?.componentId ?? state.selected))
        if (selected?.exportName !== 'Label' || selected.status !== 'bound') throw new Error(editorCopy.selectLabel)
      }
      const prepared = await (state.scope === 'Token' ? sourceConnection().prepareToken(state.token) : sourceConnection().prepareLabelPadding(state.padding))
      return { prepared, preparedKind: 'edit', reviewOpen: true, approved: false }
    }),
    promote: () => run(editorCopy.preparing, async () => ({ prepared: await sourceConnection().preparePromotion(backing.getState().componentName), preparedKind: 'promotion', reviewOpen: true, approved: false })),
    prepareSourceHistory: (action: 'undo' | 'redo', transactionId: string) => run(editorCopy.preparing, async () => ({ prepared: await (action === 'undo' ? sourceConnection().prepareUndo(transactionId) : sourceConnection().prepareRedo(transactionId)), preparedKind: 'reverse', reviewOpen: true, approved: false })),
    approve: (approved: boolean) => update({ approved }),
    save: () => run(editorCopy.saving, async () => {
      const state = backing.getState()
      if (!state.prepared || !state.approved) throw new Error(editorCopy.noReview)
      if (state.prepared.validation.some(item => item.status !== 'passed')) throw new Error(editorCopy.validationIncomplete)
      const result = await sourceConnection().savePrepared(state.prepared.id, state.prepared.approvalDigest)
      if (result.status !== 'saved') return { notice: result.message, prepared: null, approved: false, reviewOpen: false }
      receiveFile(result.snapshot)
      return { snapshot: result.snapshot, prepared: null, approved: false, reviewOpen: false, previewReady: false, runtimeInstanceIds: null, notice: result.message }
    }),
    dispose: () => { generation++; locationGeneration++; pendingExternalSnapshots.clear(); if (cameraTimer) { clearTimeout(cameraTimer); cameraTimer = null }; rememberCamera(true); stopCameraWatch?.(); stopCameraWatch = undefined; for (const stop of subscriptions) stop() },
  }
}

let configuredApi: DesignEditorApi | undefined
export const configureEditorStore = (api: DesignEditorApi | undefined) => { configuredApi = api; editorStore.set({ capabilities: api?.capabilities ?? unavailableCapabilities }) }
export const editorStore = createEditorStore(() => configuredApi, documentStore, () => window.localStorage)
