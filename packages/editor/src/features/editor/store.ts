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
import type { EditorCapabilities, EditorPersistenceIntent } from '../../capabilities'
import type { EditorFileShare } from '../../capabilities'
import { failureDetails } from '../application/failure'
import { trackCanvasEvent } from '@canvas/tracking'

export type EditorState = {
  capabilities: EditorCapabilities;
  /** Editor chrome appearance: a user preference, never sent to the design preview. */
  mode: 'light' | 'dark'; tab: string; scope: PreparedChange['scope']; selected: string | null; zoom: number;
  snapshot: ProjectSnapshot | null; prepared: PreparedChange | null; approved: boolean; busy: string | null;
  error: string | null; notice: string | null; reviewOpen: boolean; shortcutOpen: boolean; shareOpen: boolean;
  shareAccess: 'private' | 'view' | null; shareDraft: 'private' | 'view'; shareBusy: boolean; shareError: string | null;
  padding: string; token: string; previewReady: boolean;
  runtimeInstanceIds: readonly string[] | null;
  compositionPreview: boolean;
  /** Design preview theme of the open file: a per-file viewing preference restored from view state. */
  previewThemeId: string | null;
}
type DocumentController = Pick<typeof documentStore, 'getSnapshot' | 'load' | 'clear' | 'getHistory' | 'restoreHistory' | 'setViewport' | 'requestFit' | 'selectMany' | 'setPage' | 'setReadOnly' | 'subscribe'>
/** Result of opening a file URL. Missing and invalid locations never create or substitute a file. */
export type FileLocationResult =
  | { status: 'ok'; fileId: string; pageId: string | null; fileName: string }
  | { status: 'missing-file'; fileId: string }
  | { status: 'missing-page'; fileId: string; pageId: string; fileName: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string; reference?: string }
  | { status: 'stale' }
/** Adapters that migrated an older record may hand over the page and preview theme it was saved with, once. */
type LegacyViewHandOff = { legacyView?: { activePageId: string; previewTheme?: string } }
const cameraWriteDelayMs = 250

function waitForSignal<Value>(operation: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(
      value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) },
    )
  })
}

class ProjectAccessUnavailableError extends Error {
  constructor() { super(editorCopy.projectAccessUnavailable) }
}

export type ShareUpdateResult =
  | Readonly<{ status: 'confirmed'; share: EditorFileShare; requested: boolean; updateError: unknown | null }>
  | Readonly<{ status: 'unconfirmed'; updateError: unknown; reconciliationError: unknown }>
  | Readonly<{ status: 'cancelled' }>

export async function reconcileShareUpdate(input: Readonly<{ requestedAccess: EditorFileShare['access']; setAccess(): Promise<EditorFileShare>; readAccess(): Promise<EditorFileShare>; canContinue?(): boolean }>): Promise<ShareUpdateResult> {
  if (input.canContinue && !input.canContinue()) return Object.freeze({ status: 'cancelled' })
  try {
    const share = await input.setAccess()
    if (input.canContinue && !input.canContinue()) return Object.freeze({ status: 'cancelled' })
    return Object.freeze({ status: 'confirmed', share, requested: share.access === input.requestedAccess, updateError: null })
  } catch (updateError) {
    if (input.canContinue && !input.canContinue()) return Object.freeze({ status: 'cancelled' })
    try {
      const share = await input.readAccess()
      if (input.canContinue && !input.canContinue()) return Object.freeze({ status: 'cancelled' })
      return Object.freeze({ status: 'confirmed', share, requested: share.access === input.requestedAccess, updateError })
    } catch (reconciliationError) {
      return Object.freeze({ status: 'unconfirmed', updateError, reconciliationError })
    }
  }
}

export function createEditorStore(api: () => DesignEditorApi | undefined, documents?: DocumentController, storage?: () => HistoryStorage) {
  const backing = createStore<EditorState>(() => ({ capabilities: api()?.capabilities ?? unavailableCapabilities, mode: readAppearance(), tab: 'design', scope: 'Shared component', selected: null, zoom: 100, snapshot: null, prepared: null, approved: false, busy: null, error: null, notice: null, reviewOpen: false, shortcutOpen: false, shareOpen: false, shareAccess: null, shareDraft: 'private', shareBusy: false, shareError: null, padding: '8px', token: '#009ff0', previewReady: false, compositionPreview: false, runtimeInstanceIds: null, previewThemeId: null }))
  const subscriptions = new Set<() => void>()
  const update = (patch: Partial<EditorState>) => backing.setState(patch)
  let generation = 0
  let locationGeneration = 0
  let shareGeneration = 0
  let shareAllowed = api()?.collaboration?.getSnapshot().canManageShare ?? true
  let historyProjectId: string | null = null
  let view: FileViewState | null = null
  let cameraTimer: ReturnType<typeof setTimeout> | null = null
  let stopCameraWatch: (() => void) | undefined
  const pendingExternalSnapshots = new Map<string, ProjectSnapshot>()
  const fileIdentity = (snapshot: ProjectSnapshot) => snapshot.fileId ?? snapshot.file.fileId ?? snapshot.projectId
  const connection = () => { const project = api(); if (!project) throw new ProjectAccessUnavailableError(); return project }
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
    documents.load(snapshot.file, snapshot.atoms, { replace: projectChanged, pageId, ...(snapshot.assetPreviews === undefined ? {} : { assetPreviews: snapshot.assetPreviews }) })
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
    persistFile: async (file: FileDocument, expectedRevision: number, intent?: EditorPersistenceIntent) => {
      const history = documents?.getHistory()
      const snapshot = await connection().saveFile(file, expectedRevision, intent)
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
    clearFile: () => {
      generation++
      locationGeneration++
      shareGeneration++
      pendingExternalSnapshots.clear()
      documents?.clear()
      update({ snapshot: null, prepared: null, approved: false, busy: null, error: null, notice: null, reviewOpen: false, shareOpen: false, shareAccess: null, shareDraft: 'private', shareBusy: false, shareError: null, selected: null, previewReady: false, runtimeInstanceIds: null, compositionPreview: false, previewThemeId: null })
    },
    openShare: async () => {
      if (!shareAllowed) return
      const current = ++shareGeneration
      const state = backing.getState()
      const project = connection()
      const fileId = state.snapshot ? fileIdentity(state.snapshot) : null
      update({ shareOpen: true, shareBusy: true, shareError: null, shareAccess: null, shareDraft: 'private' })
      if (!fileId || !project.getFileShare || !project.setFileShare || !project.shareUrl) {
        if (current === shareGeneration) update({ shareBusy: false, shareError: editorCopy.shareUnavailable })
        return
      }
      try {
        const share = await project.getFileShare(fileId)
        if (current === shareGeneration) update({ shareBusy: false, shareAccess: share.access, shareDraft: share.access })
      } catch (error) {
        if (current === shareGeneration) update({ shareBusy: false, shareError: failureDetails(error, editorCopy.error).message })
      }
    },
    setShareDraft: (shareDraft: 'private' | 'view') => { if (shareAllowed) update({ shareDraft, shareError: null }) },
    saveShare: async () => {
      if (!shareAllowed) return false
      const current = ++shareGeneration
      const state = backing.getState()
      const project = connection()
      const fileId = state.snapshot ? fileIdentity(state.snapshot) : null
      if (!fileId || !project.setFileShare) { update({ shareError: editorCopy.shareUnavailable }); return false }
      update({ shareBusy: true, shareError: null })
      const result = await reconcileShareUpdate({
        requestedAccess: state.shareDraft,
        setAccess: () => project.setFileShare!(fileId, state.shareDraft),
        readAccess: async () => {
          if (!project.getFileShare) throw new Error(editorCopy.shareUnavailable)
          return project.getFileShare(fileId)
        },
        canContinue: () => current === shareGeneration && shareAllowed,
      })
      if (current !== shareGeneration) return false
      if (result.status === 'cancelled') return false
      if (result.status === 'unconfirmed') {
        update({ shareBusy: false, shareAccess: null, shareError: `${editorCopy.shareUnconfirmed} ${failureDetails(result.reconciliationError, editorCopy.error).message}` })
        return false
      }
      update({ shareBusy: false, shareAccess: result.share.access, shareDraft: result.share.access, shareError: result.requested ? null : failureDetails(result.updateError, editorCopy.error).message })
      return result.requested
    },
    setShareAuthority: (allowed: boolean) => {
      if (shareAllowed === allowed) return
      shareAllowed = allowed
      if (!allowed) {
        shareGeneration++
        update({ shareOpen: false, shareBusy: false, shareAccess: null, shareDraft: 'private', shareError: null })
      }
    },
    shareUrl: () => {
      const state = backing.getState()
      const fileId = state.snapshot ? fileIdentity(state.snapshot) : null
      return fileId ? connection().shareUrl?.(fileId) ?? null : null
    },
    /**
     * Opens a file (and optionally one of its pages) for a route. Newer calls supersede older ones, so a slow load can never
     * land another file's data in the editor. Reopening the current location only switches the page or selection.
     */
    openLocation: async (fileId: string, pageId: string | null, nodeId: string | null = null, signal?: AbortSignal): Promise<FileLocationResult> => {
      const token = ++locationGeneration
      const current = backing.getState()
      const openFile = documents?.getSnapshot().file
      if (current.snapshot && fileIdentity(current.snapshot) === fileId && openFile && !current.busy && !documents?.getSnapshot().readOnly) {
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
        const files = await waitForSignal(active.listFiles(), signal)
        if (token !== locationGeneration) return { status: 'stale' }
        if (!files.some(file => file.id === fileId)) { update({ busy: null }); return { status: 'missing-file', fileId } }
        const loaded = await waitForSignal(active.openFile(fileId), signal)
        if (token !== locationGeneration) return { status: 'stale' }
        const snapshot = newestSnapshot(loaded)
        if (pageId !== null && !snapshot.file.pages.some(page => page.id === pageId)) { update({ busy: null }); return { status: 'missing-page', fileId, pageId, fileName: snapshot.composition.name } }
        if (connection() !== active) return { status: 'stale' }
        const received = receiveFile(snapshot, pageId)
        documents?.setReadOnly(false)
        const state = backing.getState()
        update({ snapshot, compositionPreview: received.modified && (!snapshot.composition.componentId || state.compositionPreview), token: snapshot.tokens[0]?.value ?? state.token, prepared: null, approved: false, previewReady: !received.projectChanged && state.snapshot?.preview.activeGeneration === snapshot.preview.activeGeneration && state.previewReady, runtimeInstanceIds: received.projectChanged ? null : state.runtimeInstanceIds, selected: received.projectChanged ? snapshot.composition.children[0]?.id ?? null : state.selected ?? snapshot.composition.children[0]?.id ?? null, notice: snapshot.conflict ? editorCopy.conflictHint : editorCopy.ready, busy: null })
        selectLocationNode(nodeId)
        return { status: 'ok', fileId, pageId: documents?.getSnapshot().pageId ?? null, fileName: snapshot.composition.name }
      } catch (error) {
        if (token !== locationGeneration) return { status: 'stale' }
        if (error instanceof ProjectAccessUnavailableError) throw error
        const failure = failureDetails(error, editorCopy.error)
        if (failure.code === 'unauthorized' || failure.code === 'not_found') { update({ busy: null }); return { status: 'missing-file', fileId } }
        trackCanvasEvent('operation_failed', { operation: 'open', error_code: failure.code, error_reference: failure.reference })
        update({ busy: null, error: failure.message })
        return { status: 'error', message: failure.message, reference: failure.reference }
      }
    },
    /** Opens a public-link view directly, without requiring the file to appear in the signed-in account listing. */
    openSharedLocation: async (fileId: string, pageId: string | null, nodeId: string | null = null, signal?: AbortSignal): Promise<FileLocationResult> => {
      const token = ++locationGeneration
      const active = connection()
      if (!active.openSharedFile) return { status: 'missing-file', fileId }
      generation++
      documents?.setReadOnly(true)
      update({ busy: editorCopy.opening, error: null, notice: null, approved: false, prepared: null })
      try {
        const loaded = await waitForSignal(active.openSharedFile(fileId), signal)
        if (token !== locationGeneration) return { status: 'stale' }
        if (!loaded) { update({ busy: null }); return { status: 'missing-file', fileId } }
        const snapshot = newestSnapshot(loaded)
        if (pageId !== null && !snapshot.file.pages.some(page => page.id === pageId)) { update({ busy: null }); return { status: 'missing-page', fileId, pageId, fileName: snapshot.composition.name } }
        if (connection() !== active) return { status: 'stale' }
        const received = receiveFile(snapshot, pageId)
        documents?.setReadOnly(true)
        const state = backing.getState()
        update({ snapshot, compositionPreview: received.modified && (!snapshot.composition.componentId || state.compositionPreview), token: snapshot.tokens[0]?.value ?? state.token, prepared: null, approved: false, previewReady: !received.projectChanged && state.snapshot?.preview.activeGeneration === snapshot.preview.activeGeneration && state.previewReady, runtimeInstanceIds: received.projectChanged ? null : state.runtimeInstanceIds, selected: received.projectChanged ? snapshot.composition.children[0]?.id ?? null : state.selected ?? snapshot.composition.children[0]?.id ?? null, notice: snapshot.conflict ? editorCopy.conflictHint : editorCopy.ready, busy: null })
        selectLocationNode(nodeId)
        return { status: 'ok', fileId, pageId: documents?.getSnapshot().pageId ?? null, fileName: snapshot.composition.name }
      } catch (error) {
        if (token !== locationGeneration) return { status: 'stale' }
        const failure = failureDetails(error, editorCopy.error)
        trackCanvasEvent('operation_failed', { operation: 'open_shared', error_code: failure.code, error_reference: failure.reference })
        update({ busy: null, error: failure.message })
        return { status: 'error', message: failure.message, reference: failure.reference }
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
      return { prepared, reviewOpen: true, approved: false }
    }),
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
    dispose: () => { generation++; locationGeneration++; shareGeneration++; pendingExternalSnapshots.clear(); if (cameraTimer) { clearTimeout(cameraTimer); cameraTimer = null }; rememberCamera(true); stopCameraWatch?.(); stopCameraWatch = undefined; for (const stop of subscriptions) stop() },
  }
}

let configuredApi: DesignEditorApi | undefined
function configurationGate() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>(next => { resolve = next })
  return { promise, resolve }
}
let configured = configurationGate()
export const configureEditorStore = (api: DesignEditorApi | undefined) => {
  const hadApi = configuredApi !== undefined
  configuredApi = api
  if (api) configured.resolve()
  else if (hadApi) configured = configurationGate()
  editorStore.set({ capabilities: api?.capabilities ?? unavailableCapabilities })
}
export const waitForEditorStoreConfiguration = (signal?: AbortSignal): Promise<void> => configuredApi ? Promise.resolve() : waitForSignal(configured.promise, signal)
export const withEditorStoreConfiguration = async <Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> => {
  for (;;) {
    await waitForEditorStoreConfiguration(signal)
    try { return await operation() }
    catch (error) {
      if (!(error instanceof ProjectAccessUnavailableError)) throw error
    }
  }
}
export const editorStore = createEditorStore(() => configuredApi, documentStore, () => window.localStorage)
