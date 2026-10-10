import { acceptPreviewEvent, protocolVersion } from '@canvas/preview-runtime/protocol'
import type { PreviewCamera, PreviewEvent } from '@canvas/preview-runtime/protocol'
type PreviewGeometryItem = Extract<PreviewEvent, { type: 'geometry' }>['items'][number]
type PreviewTransientMove = { nodeId: string; dx: number; dy: number }
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import type { Appearance, FileDocument } from '@canvas/repo-engine/file-document'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import { editorStore } from './store'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import type { MeasuredNode } from './scene-geometry'
import type { CanvasTransient } from './document-store'
import { wheelPanDelta, wheelZoomFactor } from './canvas-math'
import { activeDesignTheme, normalizeCssColor, previewThemeMessage, themeProjectionContext } from './design-theme'
export { normalizeCssColor }

/** A gesture's live appearance preview rides on a shallow copy of the file; the authoritative file is untouched until commit. */
function withOverrides(file: FileDocument, overrides: Record<string, Appearance | null> | null, layouts: Record<string, NodeLayout | null> | null): FileDocument {
  if ((!overrides || !Object.keys(overrides).length) && (!layouts || !Object.keys(layouts).length)) return file
  const nodes = { ...file.nodes }
  for (const [nodeId, appearance] of Object.entries(overrides ?? {})) {
    const node = nodes[nodeId]
    if (!node || node.type === 'root') continue
    const { appearance: _current, ...rest } = node
    nodes[nodeId] = (appearance ? { ...rest, appearance } : rest) as typeof node
  }
  for (const [nodeId, layout] of Object.entries(layouts ?? {})) {
    const node = nodes[nodeId]
    if (!node || node.type !== 'component') continue
    const { layout: _current, ...rest } = node
    nodes[nodeId] = layout ? { ...rest, layout } : rest
  }
  return { ...file, nodes }
}

/** Measured preview geometry arrives in preview-local pixels; the editor keeps world rectangles. */
function unprojectGeometry(items: PreviewGeometryItem[], camera: PreviewCamera): Record<string, MeasuredNode> {
  const measured: Record<string, MeasuredNode> = {}
  for (const item of items) {
    const rect = { x: (item.bounds.x - camera.width / 2 - camera.x) / camera.zoom, y: (item.bounds.y - camera.height / 2 - camera.y) / camera.zoom, width: item.bounds.width / camera.zoom, height: item.bounds.height / camera.zoom }
    // Computed-style measurements (tracks, gaps, padding, transform) are layout pixels, which are world units already.
    measured[item.instanceId] = { componentId: item.componentId, rect, ...(item.theme ? { theme: item.theme } : {}), ...(item.box ? { box: item.box } : {}), ...(item.offset ? { offset: item.offset } : {}), ...(item.offsetParentInstanceId !== undefined ? { offsetParentInstanceId: item.offsetParentInstanceId } : {}), ...(item.parentInstanceId !== undefined ? { parentInstanceId: item.parentInstanceId } : {}), ...(item.directChild !== undefined ? { directChild: item.directChild } : {}), ...(item.transform ? { transform: item.transform } : {}), ...(item.layout ? { layout: item.layout } : {}), ...(item.grid ? { grid: item.grid } : {}) }
  }
  return measured
}

/** Translates only the highest selected roots so a selected parent never moves its selected descendants twice. */
export function previewTransientMoves(file: FileDocument | null, pageId: string | null, transient: CanvasTransient | null): PreviewTransientMove[] {
  if (!file || !pageId || transient?.kind !== 'move') return []
  const moved = new Set(Object.keys(transient.rects))
  const roots = [...moved].filter(id => {
    let parentId = file.relationships[id]?.parentId ?? null
    while (parentId) {
      if (moved.has(parentId)) return false
      parentId = file.relationships[parentId]?.parentId ?? null
    }
    return true
  })
  return roots.map(nodeId => ({ nodeId, dx: transient.offset.x, dy: transient.offset.y }))
}

/**
 * Projects the open page of the file onto the preview iframe: resolved CSS fills, component slots, layout, selection,
 * camera, and the file's design preview theme. Editor appearance never enters here.
 */
export function createPreviewConnection() {
  let target: Window | null = null
  let listening = false
  let signature = ''
  let cameraSignature = ''
  let transientSignature = '[]'
  let transientFrame: number | null = null
  let pendingTransient: { target: Window; origin: string; envelope: { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number }; items: PreviewTransientMove[]; signature: string } | null = null
  let geometryGeneration: number | null = null
  let stopEditor: (() => void) | undefined
  let stopDocument: (() => void) | undefined
  const cancelTransientFrame = () => {
    if (transientFrame !== null) cancelAnimationFrame(transientFrame)
    transientFrame = null
    pendingTransient = null
  }
  /** Pointer events can outpace paint. Keep only the latest visual offset for the next frame. */
  const queueTransient = (pending: NonNullable<typeof pendingTransient>) => {
    pendingTransient = pending
    if (transientFrame !== null) return
    transientFrame = requestAnimationFrame(() => {
      transientFrame = null
      const next = pendingTransient
      pendingTransient = null
      if (!next || target !== next.target) return
      transientSignature = next.signature
      next.target.postMessage({ ...next.envelope, type: 'set-transient-move', items: next.items }, next.origin)
    })
  }
  const sync = () => {
    const state = editorStore.getSnapshot()
    const document = documentStore.getSnapshot()
    const preview = state.snapshot?.preview
    if (geometryGeneration !== (preview?.activeGeneration ?? null)) { geometryGeneration = preview?.activeGeneration ?? null; cancelTransientFrame(); transientSignature = '[]'; sceneGeometry.clear() }
    if (!state.previewReady || !target || !preview?.origin || preview.activeGeneration === null) { sceneGeometry.clear(); return }
    const envelope = { channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration } as const
    const camera = { x: document.viewport.x, y: document.viewport.y, zoom: document.viewport.zoom, width: document.viewportSize.width, height: document.viewportSize.height }
    const nextCamera = JSON.stringify(camera)
    if (nextCamera !== cameraSignature) { cameraSignature = nextCamera; target.postMessage({ ...envelope, type: 'set-camera', camera }, preview.origin) }
    const transientMoves = previewTransientMoves(document.file, document.pageId, document.transient)
    const nextTransient = JSON.stringify(transientMoves)
    if (document.transient) {
      if (document.transient.kind === 'move' && nextTransient !== transientSignature) queueTransient({ target, origin: preview.origin, envelope, items: transientMoves, signature: nextTransient })
      // A live canvas gesture owns only camera and transient style. Do not rebuild or stringify the document projection.
      return
    }
    cancelTransientFrame()
    // The editor root supplies only the selection chrome color; the design theme comes from the file's view state.
    const themeRoot = window.document.querySelector('.editor-root')
    const color = themeRoot ? getComputedStyle(themeRoot).getPropertyValue('--color-4').trim() : ''
    const designTheme = previewThemeMessage(activeDesignTheme(state.snapshot, state.previewThemeId))
    const projection = document.file && document.pageId ? projectPreviewPage(withOverrides(document.file, document.appearanceOverrides, document.layoutOverrides), document.pageId, themeProjectionContext(state.snapshot, state.previewThemeId)) : null
    const bound = state.runtimeInstanceIds !== null
    const nodeIds = projection && (state.compositionPreview || bound) ? document.selection.filter(id => Object.hasOwn(projection.document.nodes, id) || projection.document.canvas.elements.some(element => element.id === id)) : []
    const interactionMode = document.tool === 'hand' ? 'pan' : document.tool === 'interact' ? 'interact' : 'select'
    const next = JSON.stringify({ generation: preview.activeGeneration, theme: designTheme, mode: interactionMode, document: projection?.document ?? null, layout: projection?.layout ?? [], layoutGeneration: document.layoutGeneration, nodeIds, color })
    if (signature !== next) {
      signature = next
      target.postMessage({ ...envelope, type: 'set-theme', theme: designTheme }, preview.origin)
      target.postMessage({ ...envelope, type: 'set-interaction-mode', mode: interactionMode }, preview.origin)
      if (projection) target.postMessage({ ...envelope, type: 'set-document', document: projection.document, theme: designTheme }, preview.origin)
      target.postMessage({ ...envelope, type: 'set-layout', items: projection?.layout ?? [], layoutGeneration: document.layoutGeneration }, preview.origin)
      if (/^#[0-9a-fA-F]{6}$/.test(color)) target.postMessage({ ...envelope, type: 'set-selection', nodeIds, color, renderChrome: false }, preview.origin)
    }
    if (transientSignature !== '[]') { transientSignature = '[]'; target.postMessage({ ...envelope, type: 'set-transient-move', items: [] }, preview.origin) }
  }
  const handleMessage = (event: MessageEvent) => {
    const preview = editorStore.getSnapshot().snapshot?.preview
    if (!preview?.origin || preview.activeGeneration === null || !target) return
    const accepted = acceptPreviewEvent(event, preview.origin, target, preview.activeGeneration)
    if (!accepted) return
    if (accepted.type === 'source-bindings') {
      const current = documentStore.getSnapshot().file
      const snapshot = editorStore.getSnapshot().snapshot
      if (current && snapshot && accepted.instanceIds.every(id => current.nodes[id]?.type === 'component')) {
        documentStore.setEditPolicy(undefined)
        editorStore.set({ runtimeInstanceIds: accepted.instanceIds, compositionPreview: false })
      }
    }
    if (accepted.type === 'geometry') {
      const current = documentStore.getSnapshot()
      const camera = accepted.camera ?? { x: current.viewport.x, y: current.viewport.y, zoom: current.viewport.zoom, width: current.viewportSize.width, height: current.viewportSize.height }
      sceneGeometry.update(unprojectGeometry(accepted.items, camera), accepted.layoutGeneration ?? null, Object.fromEntries((accepted.unsupported ?? []).map(entry => [entry.instanceId, entry.status])), { themeUnsupported: Object.fromEntries((accepted.theme?.nodes ?? []).map(entry => [entry.instanceId, entry.status])), unownedPortals: accepted.theme?.unownedPortals ?? 0 })
    }
    if (accepted.type === 'wheel') {
      const wheel = accepted.wheel
      const current = documentStore.getSnapshot()
      if (wheel.ctrlKey || wheel.metaKey) documentStore.zoomAt(current.viewport.zoom * wheelZoomFactor(wheel.deltaY), { x: wheel.clientX, y: wheel.clientY })
      else { const delta = wheelPanDelta(wheel, current.viewportSize.height); documentStore.panBy(-delta.x, -delta.y) }
    }
    if (accepted.type === 'ready') editorStore.set({ previewReady: true })
    if (accepted.type === 'diagnostic') editorStore.set({ error: accepted.message })
    if (accepted.type === 'selected') {
      if (accepted.instanceId) documentStore.select(accepted.instanceId)
      else editorStore.set({ selected: accepted.componentId })
    }
  }
  return {
    start: () => {
      if (listening) return
      window.addEventListener('message', handleMessage)
      listening = true
      stopEditor = editorStore.subscribe(sync)
      stopDocument = documentStore.subscribe(sync)
    },
    stop: () => { window.removeEventListener('message', handleMessage); stopEditor?.(); stopDocument?.(); stopEditor = undefined; stopDocument = undefined; listening = false; cancelTransientFrame(); target = null; signature = ''; cameraSignature = ''; transientSignature = '[]'; geometryGeneration = null; sceneGeometry.clear(); documentStore.setEditPolicy(undefined) },
    sync,
    disconnect: () => {
      target = null
      sceneGeometry.clear()
      documentStore.setEditPolicy(undefined)
      signature = ''
      cameraSignature = ''
      cancelTransientFrame()
      transientSignature = '[]'
      editorStore.set({ previewReady: false, runtimeInstanceIds: null })
    },
    connect: (frame: Window | null) => {
      target = frame
      sceneGeometry.clear()
      documentStore.setEditPolicy(undefined)
      signature = ''
      cameraSignature = ''
      cancelTransientFrame()
      transientSignature = '[]'
      const preview = editorStore.getSnapshot().snapshot?.preview
      if (!frame || !preview?.origin || preview.activeGeneration === null) return
      editorStore.set({ previewReady: false, runtimeInstanceIds: null })
      frame.postMessage({ channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration, type: 'ping' }, preview.origin)
    },
  }
}
export const previewConnection = createPreviewConnection()
