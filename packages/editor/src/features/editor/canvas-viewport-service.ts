import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { childrenOf } from '@canvas/repo-engine/file-document'
import { buildScene } from './canvas-scene'
import { unionRects } from './canvas-math'

/**
 * Owns the canvas viewport element: tracks its CSS pixel size for the camera and resolves fit requests
 * once the scene (including measured component roots) is available.
 */
export function createCanvasViewportService(store = documentStore, geometry = sceneGeometry) {
  let element: HTMLElement | null = null
  let observer: ResizeObserver | null = null
  let stopStore: (() => void) | undefined
  let stopGeometry: (() => void) | undefined
  let deadline: ReturnType<typeof setTimeout> | null = null
  const measure = () => { if (element) store.setViewportSize({ width: element.clientWidth, height: element.clientHeight }) }
  const resolve = (force: boolean) => {
    const state = store.getSnapshot()
    if (!state.fitRequested || !element || state.viewportSize.width <= 0) return
    if (!state.file || !state.pageId) { clearDeadline(); store.resolveFit(null); return }
    const measured = geometry.getSnapshot().nodes
    const root = state.file.pages.find(page => page.id === state.pageId)?.rootNodeId
    const unmeasuredRoots = root ? childrenOf(state.file, root).filter(id => state.file!.nodes[id]?.type === 'component' && !measured[id]) : []
    if (unmeasuredRoots.length && !force) { if (!deadline) deadline = setTimeout(() => { deadline = null; resolve(true) }, 1500); return }
    clearDeadline()
    const scene = buildScene(state.file, state.pageId, measured)
    const ids = state.fitRequested === 'selection' && state.selection.length ? state.selection : scene.nodes.filter(node => node.parentId === null).map(node => node.id)
    const rects = ids.map(id => scene.byId.get(id)?.rect).filter((rect): rect is NonNullable<typeof rect> => Boolean(rect))
    store.resolveFit(rects.length ? unionRects(rects) : null)
  }
  const clearDeadline = () => { if (deadline) { clearTimeout(deadline); deadline = null } }
  return {
    attach: (next: HTMLElement | null) => {
      if (element === next) return
      observer?.disconnect()
      element = next
      if (element) { observer = new ResizeObserver(measure); observer.observe(element); measure(); resolve(false) }
    },
    start: () => {
      if (stopStore) return
      stopStore = store.subscribe(() => resolve(false))
      stopGeometry = geometry.subscribe(() => resolve(false))
    },
    stop: () => { stopStore?.(); stopGeometry?.(); stopStore = undefined; stopGeometry = undefined; observer?.disconnect(); observer = null; element = null; clearDeadline() },
  }
}
export const canvasViewportService = createCanvasViewportService()
