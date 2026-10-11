import { acceptPreviewEvent, isPreviewAssets, isPreviewDocument, previewAssetByteLimit, previewImageMimes, protocolVersion } from '@canvas/preview-runtime/protocol'
import type { PreviewAsset, PreviewCamera, PreviewDocument, PreviewEvent } from '@canvas/preview-runtime/protocol'
type PreviewGeometryItem = Extract<PreviewEvent, { type: 'geometry' }>['items'][number]
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import type { PreviewPageDocument } from '@canvas/repo-engine/file-preview'
import type { Appearance, FileDocument } from '@canvas/repo-engine/file-document'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import { editorStore } from './store'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import type { MeasuredNode } from './scene-geometry'
import { collaborationService } from '../collaboration/collaboration-service'
import { previewTransientMoves } from './preview-transient'
import type { PreviewTransientMove } from './preview-transient'
export { previewTransientMoves } from './preview-transient'
import { wheelPanDelta, wheelZoomFactor } from './canvas-math'
import { activeDesignTheme, normalizeCssColor, previewThemeMessage, themeProjectionContext } from './design-theme'
import { createFrameQueue } from './frame-queue'
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

export class PreviewAssetHydrationError extends Error {
  constructor(message: string) { super(message); this.name = 'PreviewAssetHydrationError' }
}

const decodedBase64Bytes = (data: string) => data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

/** Hydrates reference-only schema-v7 assets for the isolated renderer or fails before a fill can disappear. */
export function hydratePreviewDocument(document: PreviewPageDocument, resolve: (assetId: string) => { mime: string; data: string } | null): PreviewDocument {
  const supported = new Set<PreviewAsset['mime']>(previewImageMimes)
  const isPreviewMime = (mime: string): mime is PreviewAsset['mime'] => supported.has(mime as PreviewAsset['mime'])
  const entries = Object.entries(document.assets ?? {}).map(([assetId, reference]) => {
    if (reference.bytes > previewAssetByteLimit) throw new PreviewAssetHydrationError(`Image "${reference.name}" exceeds the preview transfer limit. Reimport it to create a preview-safe copy.`)
    const asset = resolve(assetId)
    if (!asset) throw new PreviewAssetHydrationError(`Image "${reference.name}" is unavailable in this session. Reattach it to preview this file.`)
    if (!isPreviewMime(asset.mime) || asset.mime !== reference.mime) throw new PreviewAssetHydrationError(`Image "${reference.name}" has preview bytes that do not match its file reference. Reattach it to preview this file.`)
    return [assetId, { mime: asset.mime, data: asset.data }] as const
  })
  const assets: Record<string, PreviewAsset> = Object.fromEntries(entries)
  if (!isPreviewAssets(assets)) throw new PreviewAssetHydrationError('One or more image previews exceed the runtime transfer limits. Reimport the affected image.')
  for (const [assetId, reference] of Object.entries(document.assets ?? {})) {
    if (decodedBase64Bytes(assets[assetId]!.data) !== reference.bytes) throw new PreviewAssetHydrationError(`Image "${reference.name}" has incomplete preview bytes. Reattach it to preview this file.`)
  }
  const { assets: _assets, ...rest } = document
  const hydrated: PreviewDocument = { ...rest, ...(Object.keys(assets).length ? { assets } : {}) }
  if (!isPreviewDocument(hydrated)) throw new PreviewAssetHydrationError('The image preview message exceeds the runtime limits. Reimport the affected image.')
  return hydrated
}

/**
 * Projects the open page of the file onto the preview iframe: resolved CSS fills, component slots, layout, selection,
 * camera, and the file's design preview theme. Editor appearance never enters here.
 */
export function createPreviewConnection(options: { resolveAsset?: (assetId: string) => { mime: string; data: string } | null } = {}) {
  const resolveAsset = options.resolveAsset ?? documentStore.assetPreview
  let target: Window | null = null
  let listening = false
  let signature = ''
  let cameraSignature = ''
  let transientSignature = '[]'
  let projectedDocument: PreviewDocument | null = null
  let assetHydrationError: string | null = null
  let geometryGeneration: number | null = null
  let stopEditor: (() => void) | undefined
  let stopDocument: (() => void) | undefined
  let stopCollaboration: (() => void) | undefined
  /** Pointer input is already browser-coalesced. Forward every distinct sample without adding another frame of latency. */
  const publishTransient = (pending: { target: Window; origin: string; envelope: { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number }; items: PreviewTransientMove[]; signature: string }) => {
    if (target !== pending.target) return
    transientSignature = pending.signature
    pending.target.postMessage({ ...pending.envelope, type: 'set-transient-move', items: pending.items }, pending.origin)
  }
  const sync = () => {
    const state = editorStore.getSnapshot()
    const document = documentStore.getSnapshot()
    const preview = state.snapshot?.preview
    if (geometryGeneration !== (preview?.activeGeneration ?? null)) { geometryGeneration = preview?.activeGeneration ?? null; transientSignature = '[]'; sceneGeometry.clear() }
    if (!state.previewReady || !target || !preview?.origin || preview.activeGeneration === null) { sceneGeometry.clear(); return }
    const envelope = { channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration } as const
    const camera = { x: document.viewport.x, y: document.viewport.y, zoom: document.viewport.zoom, width: document.viewportSize.width, height: document.viewportSize.height }
    const nextCamera = JSON.stringify(camera)
    if (nextCamera !== cameraSignature) { cameraSignature = nextCamera; target.postMessage({ ...envelope, type: 'set-camera', camera }, preview.origin) }
    const remoteMoves: PreviewTransientMove[] = collaborationService.getSnapshot().participants.flatMap(participant => {
      if (participant.clientId === collaborationService.getSnapshot().localClientId || participant.awareness.interaction?.pageId !== document.pageId) return []
      return participant.awareness.interaction.transforms.map(transform => ({ ...transform }))
    })
    const transientMoves = [...previewTransientMoves(document.file, document.pageId, document.transient, projectedDocument), ...remoteMoves]
    const nextTransient = JSON.stringify(transientMoves)
    if (nextTransient !== '[]' && nextTransient !== transientSignature) publishTransient({ target, origin: preview.origin, envelope, items: transientMoves, signature: nextTransient })
    if (document.transient) {
      // A live canvas gesture owns only camera and transient style. Do not rebuild or stringify the document projection.
      return
    }
    // The editor root supplies only the selection chrome color; the design theme comes from the file's view state.
    const themeRoot = window.document.querySelector('.editor-root')
    const color = themeRoot ? getComputedStyle(themeRoot).getPropertyValue('--color-4').trim() : ''
    const designTheme = previewThemeMessage(activeDesignTheme(state.snapshot, state.previewThemeId))
    const projection = document.file && document.pageId ? projectPreviewPage(withOverrides(document.file, document.appearanceOverrides, document.layoutOverrides), document.pageId, themeProjectionContext(state.snapshot, state.previewThemeId)) : null
    try { projectedDocument = projection ? hydratePreviewDocument(projection.document, resolveAsset) : null }
    catch (error) {
      projectedDocument = null
      const message = error instanceof Error ? error.message : 'An image could not be prepared for preview.'
      assetHydrationError = message
      if (state.error !== message) editorStore.set({ error: message })
      return
    }
    if (assetHydrationError) {
      const resolvedError = assetHydrationError
      assetHydrationError = null
      if (state.error === resolvedError) editorStore.set({ error: null })
    }
    const bound = state.runtimeInstanceIds !== null
    const nodeIds = projection && (state.compositionPreview || bound) ? document.selection.filter(id => Object.hasOwn(projection.document.nodes, id) || projection.document.canvas.elements.some(element => element.id === id)) : []
    const interactionMode = document.tool === 'hand' ? 'pan' : document.tool === 'interact' ? 'interact' : 'select'
    const next = JSON.stringify({ generation: preview.activeGeneration, theme: designTheme, mode: interactionMode, document: projectedDocument, layout: projection?.layout ?? [], layoutGeneration: document.layoutGeneration, nodeIds, color })
    if (signature !== next) {
      signature = next
      target.postMessage({ ...envelope, type: 'set-theme', theme: designTheme }, preview.origin)
      target.postMessage({ ...envelope, type: 'set-interaction-mode', mode: interactionMode }, preview.origin)
      if (projectedDocument) target.postMessage({ ...envelope, type: 'set-document', document: projectedDocument, theme: designTheme }, preview.origin)
      target.postMessage({ ...envelope, type: 'set-layout', items: projection?.layout ?? [], layoutGeneration: document.layoutGeneration }, preview.origin)
      if (/^#[0-9a-fA-F]{6}$/.test(color)) target.postMessage({ ...envelope, type: 'set-selection', nodeIds, color, renderChrome: false }, preview.origin)
    }
    if (nextTransient === '[]' && transientSignature !== '[]') { transientSignature = '[]'; target.postMessage({ ...envelope, type: 'set-transient-move', items: [] }, preview.origin) }
  }
  // Inspector scrubs can publish faster than the browser paints. Project and serialize only the newest state per frame.
  const syncFrames = createFrameQueue(sync, callback => requestAnimationFrame(callback), frame => cancelAnimationFrame(frame))
  const syncDocument = () => {
    // Canvas move and resize already have their own latest-frame transient queue. Feeding that queue immediately avoids
    // adding a second frame of latency while inspector-only previews take the coalesced projection path.
    if (documentStore.getSnapshot().transient) sync()
    else syncFrames.request()
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
      stopEditor = editorStore.subscribe(syncFrames.request)
      stopDocument = documentStore.subscribe(syncDocument)
      stopCollaboration = collaborationService.subscribe(sync)
    },
    stop: () => { window.removeEventListener('message', handleMessage); stopEditor?.(); stopDocument?.(); stopCollaboration?.(); stopEditor = undefined; stopDocument = undefined; stopCollaboration = undefined; listening = false; syncFrames.cancel(); target = null; signature = ''; cameraSignature = ''; transientSignature = '[]'; projectedDocument = null; assetHydrationError = null; geometryGeneration = null; sceneGeometry.clear(); documentStore.setEditPolicy(undefined) },
    sync,
    disconnect: () => {
      target = null
      sceneGeometry.clear()
      documentStore.setEditPolicy(undefined)
      signature = ''
      cameraSignature = ''
      transientSignature = '[]'
      editorStore.set({ previewReady: false, runtimeInstanceIds: null })
    },
    connect: (frame: Window | null) => {
      target = frame
      sceneGeometry.clear()
      documentStore.setEditPolicy(undefined)
      signature = ''
      cameraSignature = ''
      transientSignature = '[]'
      const preview = editorStore.getSnapshot().snapshot?.preview
      if (!frame || !preview?.origin || preview.activeGeneration === null) return
      editorStore.set({ previewReady: false, runtimeInstanceIds: null })
      frame.postMessage({ channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration, type: 'ping' }, preview.origin)
    },
  }
}
export const previewConnection = createPreviewConnection()
