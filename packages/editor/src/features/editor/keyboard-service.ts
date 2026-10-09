import { editorStore } from './store'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { buildScene } from './canvas-scene'
import { canvasGestures } from './canvas-gestures'

type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean; target: EventTarget | null; preventDefault: () => void }

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)

/** Shared editor shortcut policy for both the focused editor root and the window when focus sits on the document body. */
export function editorKeyDown(event: KeyLike) {
  if (editable(event.target) || event.defaultPrevented) return
  const state = editorStore.getSnapshot()
  if (state.shareOpen || state.shortcutOpen) return
  if (event.key === ' ') { event.preventDefault(); documentStore.setSpaceHeld(true); return }
  const command = event.ctrlKey || event.metaKey
  if (command && event.key.toLowerCase() === 's') { event.preventDefault(); editorStore.set({ reviewOpen: true }) }
  if (command && event.shiftKey && event.key.toLowerCase() === 'r') { event.preventDefault(); void editorStore.refresh() }
  if (event.key === 'Escape' && state.reviewOpen) { event.preventDefault(); editorStore.set({ reviewOpen: false }); return }
  if (event.key === 'Escape' && canvasGestures.active) { event.preventDefault(); canvasGestures.cancel(); return }
  const { file, pageId } = documentStore.getSnapshot()
  const scene = file && pageId ? buildScene(file, pageId, sceneGeometry.getSnapshot().nodes) : undefined
  if (documentStore.handleKey(event, /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other', scene)) event.preventDefault()
}

export function editorKeyUp(event: Pick<KeyLike, 'key'>) { if (event.key === ' ') documentStore.setSpaceHeld(false) }

/** Window-level fallback so shortcuts work right after opening a file, before anything inside the editor has focus. */
export function createEditorKeyboardService(host: Window) {
  let running = false
  const outsideEditor = (event: KeyboardEvent) => !(event.target instanceof Element) || !event.target.closest('.editor-root')
  const down = (event: KeyboardEvent) => { if (outsideEditor(event)) editorKeyDown(event) }
  const up = (event: KeyboardEvent) => { if (outsideEditor(event)) editorKeyUp(event) }
  // Losing focus (alt-tab, devtools, iframe focus) releases Space and any in-flight gesture so the hand tool never sticks.
  const release = () => { documentStore.setSpaceHeld(false); canvasGestures.cancel() }
  return {
    start: () => { if (!running) { host.addEventListener('keydown', down); host.addEventListener('keyup', up); host.addEventListener('blur', release); running = true } },
    stop: () => { if (running) { host.removeEventListener('keydown', down); host.removeEventListener('keyup', up); host.removeEventListener('blur', release); running = false } },
  }
}
