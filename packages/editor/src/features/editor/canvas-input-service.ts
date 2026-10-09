import { documentStore } from './document-store'
import { wheelPanDelta, wheelZoomFactor } from './canvas-math'

/** Non-passive wheel ownership for the canvas viewport: Ctrl/Cmd (and pinch) zooms around the pointer, plain wheel pans. */
export function createCanvasInputService(host: Window) {
  let running = false
  const handleWheel = (event: WheelEvent) => {
    const viewport = event.target instanceof Element ? event.target.closest<HTMLElement>('.canvas-viewport') : null
    if (!viewport) return
    event.preventDefault()
    const state = documentStore.getSnapshot()
    if (event.ctrlKey || event.metaKey) {
      const bounds = viewport.getBoundingClientRect()
      documentStore.zoomAt(state.viewport.zoom * wheelZoomFactor(event.deltaY), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    } else {
      const delta = wheelPanDelta(event, state.viewportSize.height)
      documentStore.panBy(-delta.x, -delta.y)
    }
  }
  return {
    start: () => { if (!running) { host.addEventListener('wheel', handleWheel, { passive: false }); running = true } },
    stop: () => { if (running) { host.removeEventListener('wheel', handleWheel); running = false } },
  }
}
