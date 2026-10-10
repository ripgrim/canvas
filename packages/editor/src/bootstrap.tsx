import { createRoot } from 'react-dom/client'
import type { EditorProjectApi } from './capabilities'
import { EditorPage } from './pages/EditorPage'
import { previewConnection } from './features/editor/preview-service'
import { configureEditorStore, editorStore } from './features/editor/store'
import { documentStore } from './features/editor/document-store'
import { createCanvasInputService } from './features/editor/canvas-input-service'
import { canvasViewportService } from './features/editor/canvas-viewport-service'
import { createEditorKeyboardService } from './features/editor/keyboard-service'
import { canvasHudPainter } from './features/editor/canvas-hud-painter'
import { homeStore } from './features/home/store'
import { designSourcePalette, themeProjectionContext } from './features/editor/design-theme'
import { repositoryConnectionService } from './features/editor/repository-service'
import { authSessionService } from './features/application/auth-service'
import './design-system/theme.css'
import './design-system/styles.css'

export function startEditorServices(api: EditorProjectApi): () => void {
  authSessionService.configure(api.auth)
  let stopWorkspace: (() => void) | undefined
  const startWorkspace = () => {
    if (stopWorkspace) return
    configureEditorStore(api)
    homeStore.configure(api)
    repositoryConnectionService.configure(api)
    repositoryConnectionService.load()
    documentStore.configure({
      persist: editorStore.persistFile,
      onChange: () => editorStore.documentChanged(),
      onSelection: ids => editorStore.set({ selected: ids[0] ?? null }),
      onPageChange: pageId => editorStore.pageChanged(pageId),
      // Source tokens resolve against the design stylesheet palette of the file's preview theme, never editor chrome.
      sources: () => { const state = editorStore.getSnapshot(); return designSourcePalette(state.snapshot, state.previewThemeId) },
      themeContext: () => { const state = editorStore.getSnapshot(); return themeProjectionContext(state.snapshot, state.previewThemeId) },
    })
    previewConnection.start()
    const canvasInput = createCanvasInputService(window)
    canvasInput.start()
    canvasViewportService.start()
    canvasHudPainter.start()
    const keyboard = createEditorKeyboardService(window)
    keyboard.start()
    homeStore.start()
    const stopFileSubscription = api.subscribeFile?.(snapshot => editorStore.receiveExternalSnapshot(snapshot))
    stopWorkspace = () => {
      stopFileSubscription?.()
      canvasInput.stop()
      canvasViewportService.stop()
      canvasHudPainter.stop()
      keyboard.stop()
      previewConnection.stop()
      documentStore.dispose()
      homeStore.dispose()
      repositoryConnectionService.dispose()
      editorStore.dispose()
      configureEditorStore(undefined)
      stopWorkspace = undefined
    }
  }
  const reconcileWorkspace = () => {
    const status = authSessionService.getSnapshot().status
    if (status === 'signed-in' || (status === 'unavailable' && authSessionService.allowsUnauthenticatedWorkspace())) startWorkspace()
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
