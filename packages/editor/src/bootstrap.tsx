import { createRoot } from 'react-dom/client'
import type { EditorProjectApi } from './capabilities'
import { EditorPage } from './pages/EditorPage'
import { previewConnection } from './features/editor/preview-service'
import { configureEditorStore, editorStore } from './features/editor/store'
import { documentStore } from './features/editor/document-store'
import { createCanvasInputService } from './features/editor/canvas-input-service'
import { canvasViewportService } from './features/editor/canvas-viewport-service'
import { createEditorKeyboardService } from './features/editor/keyboard-service'
import { createEditorClipboardService } from './features/editor/editor-clipboard-service'
import { canvasHudPainter } from './features/editor/canvas-hud-painter'
import { homeStore } from './features/home/store'
import { designSourcePalette, themeProjectionContext } from './features/editor/design-theme'
import { repositoryConnectionService } from './features/editor/repository-service'
import { hostedRepositoryService } from './features/editor/hosted-repository-service'
import { authSessionService } from './features/application/auth-service'
import { editorToast } from './design-system/toast-atoms'
import { collaborationService } from './features/collaboration/collaboration-service'
import { failureDetails } from './features/application/failure'
import { canvasCopy } from './features/editor/canvas-copy'
import { fontCatalogService } from './features/fonts/font-catalog-service'
import './design-system/theme.css'
import './design-system/styles.css'

export function prepareEditorUpdateRestart(timeoutMs = 10_000): Promise<void> {
  const ready = () => {
    const state = documentStore.getSnapshot()
    if (state.error || state.blocked) throw new Error('Resolve the document save error before restarting.')
    return !state.dirty && !state.saving && state.transient === null
  }
  try { if (ready()) return Promise.resolve() } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    const unsubscribe = documentStore.subscribe(() => {
      try { if (ready()) finish() } catch (error) { finish(error) }
    })
    const timeout = setTimeout(() => finish(new Error('The document is still saving. Wait for it to finish, then restart.')), timeoutMs)
  })
}

export function bindShareAuthority(api: Pick<EditorProjectApi, 'collaboration'>, target: Pick<typeof editorStore, 'setShareAuthority'> = editorStore): () => void {
  const collaboration = api.collaboration
  const publish = () => target.setShareAuthority(collaboration?.getSnapshot().canManageShare ?? true)
  publish()
  const unsubscribe = collaboration?.subscribe(publish)
  let active = true
  return () => {
    if (!active) return
    active = false
    unsubscribe?.()
  }
}

export function bindProjectFailures(api: Pick<EditorProjectApi, 'subscribeFailures'>, target: Pick<typeof editorToast, 'error'> = editorToast): () => void {
  const unsubscribe = api.subscribeFailures?.(failure => {
    const details = failureDetails(failure.error, canvasCopy.imageLoadFailed)
    target.error(canvasCopy.imageLoadFailed, details.message)
  })
  let active = true
  return () => {
    if (!active) return
    active = false
    unsubscribe?.()
  }
}

export function bindProjectFileUpdates(
  api: Pick<EditorProjectApi, 'subscribeFile'>,
  target: Pick<typeof editorStore, 'receiveExternalSnapshot' | 'clearFile'> = editorStore,
): () => void {
  return api.subscribeFile?.(snapshot => {
    if (snapshot) target.receiveExternalSnapshot(snapshot)
    else target.clearFile()
  }) ?? (() => undefined)
}

export function bindAuthFileClear(
  source: Pick<typeof authSessionService, 'getSnapshot' | 'subscribe'> = authSessionService,
  target: Pick<typeof editorStore, 'clearFile'> = editorStore,
): () => void {
  let priorStatus = source.getSnapshot().status
  return source.subscribe(() => {
    const status = source.getSnapshot().status
    if (priorStatus === 'signed-in' && status === 'signed-out') target.clearFile()
    priorStatus = status
  })
}

export function startEditorServices(api: EditorProjectApi): () => void {
  authSessionService.configure(api.auth)
  let stopWorkspace: (() => void) | undefined
  const startWorkspace = () => {
    if (stopWorkspace) return
    configureEditorStore(api)
    homeStore.configure(api)
    repositoryConnectionService.configure(api)
    hostedRepositoryService.configure(api)
    collaborationService.configure(api.collaboration)
    const stopShareAuthority = bindShareAuthority(api)
    const stopProjectFailures = bindProjectFailures(api)
    repositoryConnectionService.load()
    documentStore.configure({
      persist: editorStore.persistFile,
      ...(api.assets ? { uploadImage: api.assets.uploadImage } : {}),
      onChange: () => editorStore.documentChanged(),
      onSelection: ids => editorStore.set({ selected: ids[0] ?? null }),
      onPageChange: pageId => editorStore.pageChanged(pageId),
      onError: notice => editorToast.error(notice.title, notice.message),
      // Source tokens resolve against the design stylesheet palette of the file's preview theme, never editor chrome.
      sources: () => { const state = editorStore.getSnapshot(); return designSourcePalette(state.snapshot, state.previewThemeId) },
      themeContext: () => { const state = editorStore.getSnapshot(); return themeProjectionContext(state.snapshot, state.previewThemeId) },
      editorMode: () => editorStore.getSnapshot().mode,
    })
    previewConnection.start()
    const canvasInput = createCanvasInputService(window)
    canvasInput.start()
    canvasViewportService.start()
    canvasHudPainter.start()
    fontCatalogService.start()
    collaborationService.start()
    const keyboard = createEditorKeyboardService(window)
    keyboard.start()
    const clipboard = createEditorClipboardService(window)
    clipboard.start()
    homeStore.start()
    const stopFileSubscription = bindProjectFileUpdates(api)
    stopWorkspace = () => {
      stopFileSubscription()
      canvasInput.stop()
      canvasViewportService.stop()
      canvasHudPainter.stop()
      fontCatalogService.dispose()
      stopShareAuthority?.()
      stopProjectFailures()
      collaborationService.stop()
      keyboard.stop()
      clipboard.stop()
      previewConnection.stop()
      documentStore.dispose()
      homeStore.dispose()
      repositoryConnectionService.dispose()
      hostedRepositoryService.dispose()
      editorStore.dispose()
      editorToast.close()
      configureEditorStore(undefined)
      stopWorkspace = undefined
    }
  }
  const stopAuthFileClear = bindAuthFileClear()
  const reconcileWorkspace = () => {
    const status = authSessionService.getSnapshot().status
    if (status === 'signed-in' || (status === 'signed-out' && authSessionService.allowsSignedOutWorkspace()) || (status === 'unavailable' && authSessionService.allowsUnauthenticatedWorkspace())) startWorkspace()
    else stopWorkspace?.()
  }
  const unsubscribeAuth = authSessionService.subscribe(reconcileWorkspace)
  authSessionService.start()
  reconcileWorkspace()
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribeAuth()
    stopAuthFileClear()
    stopWorkspace?.()
    authSessionService.dispose()
  }
}

export function mountEditor(container: HTMLElement, api: EditorProjectApi): () => void {
  const disposeServices = startEditorServices(api)
  const root = createRoot(container)
  root.render(<EditorPage />)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeServices()
    root.unmount()
  }
}
