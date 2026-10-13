import type { PrimitiveKind } from '@canvas/repo-engine/file-document'
import { childrenOf as fileChildrenOf, descendantsOf as fileDescendantsOf, nodeIsLocked, pageRoot } from '@canvas/repo-engine/file-document'
import { documentStore } from './document-store'
import type { CanvasTransient, DocumentState, MoveCommit, PersistenceCommit } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { ancestors, buildScene, childrenOf, containingFrameAt, descendants, symmetricDifference } from './canvas-scene'
import type { Scene, SceneNode } from './canvas-scene'
import { currentCanvasHitFrame, projectedClickTarget, projectedDrillTarget, projectedFrameMatchesScene, projectedMarqueeTargets } from './canvas-hud-hit-testing'
import type { CanvasHudProjectionSource } from './canvas-hud-hit-testing'
import { canvasHudProjectionService } from './canvas-hud-projection-service'
import type { HudProjectionFrame } from './canvas-hud-projection'
import { canvasCreationBounds, canvasCreationIntent } from './canvas-drawing'
import { dragThresholdCss, flowInsertIndex, handleDragThresholdCss, normalizeRect, roundRect, screenToWorld, snapRect, snapThresholdCss } from './canvas-math'
import type { Camera, Point, Rect, ResizeHandle, Size } from './canvas-math'
import { flexInsertIndex } from './flex-reorder'
import { collaborationService } from '../collaboration/collaboration-service'
import { collaborationTransforms, previewTransientMoves } from './preview-transient'
import type { EditorCollaborationTransform } from '../../capabilities'
import { captureGestureAuthority } from './gesture-authority'
import type { GestureAuthoritySnapshot, ResizeGeometryAuthority } from './gesture-authority'
import { resizeGeometryAuthority } from './layout-measure'
import { projectResizeRectToWorld } from './layout-measure'
import { beginLiveResizeInteraction, sampleLiveResizeInteraction } from './live-resize-interaction'
import type { LiveResizeInteraction, LiveResizeSample } from './live-resize-interaction'
import type { ResizePresentation } from './resize-projection'
import { previewConnection } from './preview-service'
import type { PreviewCommittedDocumentHandoff, PreviewCommittedDocumentReceipt, PreviewCommittedFlowDragReceipt, PreviewFlowDragRetirement, PreviewResizeSample } from './preview-service'
import { beginPaperFlowDrag, samplePaperFlowDrag } from './flow-drag-state'
import type { PaperFlowDragState } from './flow-drag-state'
import { resolveFlowDragTarget } from './flow-drag-target'
import { buildFlowDragPresentationAuthority, captureFlowDragAuthorityMeasurement } from './flow-drag-authority'
import { projectFlowDragPresentation } from './flow-drag-presentation'
import type { FlowDragPresentation } from './flow-drag-presentation'
import { derivePaperFlowTerminalIntent } from './gesture-terminal-intent'
import { paperFlowAbsoluteDropGeometry } from './layout-measure'
import type { LocalFlowClaimToken } from '../collaboration/collaboration-service'
import { projectRotationPresentation, rotationDegreesFromPointer } from './rotation-projection'
import type { RotationCorner } from './rotation-projection'
import { setTransformRotation } from './layout-commands'

export type { ResizeHandle } from './canvas-math'
export const resizeHandles: readonly ResizeHandle[] = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left']
export const creationTools: readonly PrimitiveKind[] = ['frame', 'rectangle', 'shape', 'shader', 'text']
const resizeHandleAxes = (handle: ResizeHandle) => [...(handle.includes('left') || handle.includes('right') ? ['x'] as const : []), ...(handle.includes('top') || handle.includes('bottom') ? ['y'] as const : [])]

export type CanvasInteractionController = Readonly<{
  beginInteraction(kind: 'move' | 'resize', nodeIds: readonly string[]): string | null
  updateInteraction(interactionId: string, transforms: readonly EditorCollaborationTransform[]): boolean
  canCommitInteraction(interactionId: string): boolean
  waitForCommitInteraction?: (interactionId: string) => Promise<boolean>
  endInteraction(interactionId: string): void
  hasInteraction?: (interactionId: string) => boolean
  subscribe?: (listener: () => void) => () => void
  isNodeLocked?: (nodeId: string) => boolean
}>
let localInteractionSequence = 0
const localInteractions: CanvasInteractionController = Object.freeze({ beginInteraction: () => `local-${++localInteractionSequence}`, updateInteraction: () => true, canCommitInteraction: () => true, endInteraction: () => undefined })

type PointerLike = { pointerId: number; clientX: number; clientY: number; button: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; timeStamp?: number; getModifierState?: (key: 'AltGraph') => boolean }
type Base = { pointerId: number; startClient: Point; startViewport: Point; startWorld: Point; camera: Camera; size: Size; scene: Scene; selection: string[]; moved: boolean }
type ResizeBase = Base & {
  kind: 'resize'
  id: string
  claimId: string
  lockedIds: readonly string[]
  atoms: DocumentState['atoms']
  compatibleFile: NonNullable<DocumentState['file']>
  fileSignature: string
  live: LiveResizeInteraction
  last: LiveResizeSample | null
  phaseActive: boolean
}
type PendingResize = {
  kind: 'pending-resize'
  id: string
  handle: ResizeHandle
  pointerId: number
  start: PointerLike
  latest: PointerLike
  claimId: string
  lockedIds: readonly string[]
  file: NonNullable<DocumentState['file']>
  fileSignature: string
  atoms: DocumentState['atoms']
  pageId: string
  layoutGeneration: number
}
type RotationBase = Base & {
  kind: 'rotation'
  id: string
  corner: RotationCorner
  claimId: string
  lockedIds: readonly string[]
  atoms: DocumentState['atoms']
  compatibleFile: NonNullable<DocumentState['file']>
  fileSignature: string
  authority: GestureAuthoritySnapshot
  resizeAuthority: ResizeGeometryAuthority
  center: Point
  startRotation: number
  targetRotation: number
  presentationId: string
  phaseActive: boolean
}
type Gesture =
  | (Base & { kind: 'pan'; startCamera: Camera })
  | (Base & { kind: 'marquee' })
  | (Base & { kind: 'press'; target: SceneNode; dragTarget: SceneNode; deferred: boolean; paperFlow: PaperFlowPending | null })
  | (Base & { kind: 'move'; ids: string[]; startRects: Record<string, Rect>; flow: { id: string; parentId: string } | null })
  | PaperFlowGesture
  | (Base & { kind: 'draw'; elementKind: PrimitiveKind })
  | ResizeBase
  | PendingResize
  | RotationBase

type ResizeHudTarget = CanvasHudProjectionSource & Readonly<{
  publishResizePresentation?: (presentation: ResizePresentation, fence: GestureAuthoritySnapshot['start']) => boolean
  clearResizePresentation?: () => void
  beginCommittedResizeHold?: () => boolean
  completeCommittedResizeHold?: (receipt: PreviewCommittedDocumentReceipt | null) => boolean
  publishFlowDragPresentation?: (presentation: FlowDragPresentation) => boolean
  clearFlowDragPresentation?: (identity: FlowDragPresentation['identity']) => boolean
  completeCommittedFlowDragHold?: (receipt: PreviewCommittedFlowDragReceipt) => boolean
  retireFailedFlowDragHold?: (retirement: Readonly<{ kind: 'terminal-flow-failure'; interactionId: string; gestureGeneration: number; terminalSequence: number; sourceFence: FlowDragPresentation['fence'] }>) => boolean
}>

type ResizePreviewTarget = Readonly<{
  publishResizePresentation(input: PreviewResizeSample): boolean
  clearResizePresentation(): boolean
  syncCommittedDocument(handoff: PreviewCommittedDocumentHandoff): PreviewCommittedDocumentReceipt | null
  publishRotationPreview?: (nodeId: string, rotationDelta: number) => boolean
  clearRotationPreview?: () => boolean
  publishFlowDragPresentation?: (presentation: FlowDragPresentation) => boolean
  clearFlowDragPresentation?: (retirement: PreviewFlowDragRetirement) => boolean
  syncCommittedFlowDrag?: (handoff: Readonly<{ commit: Readonly<{ committed: boolean }>; committedFile: NonNullable<DocumentState['file']> | null; terminalPresentation: FlowDragPresentation }>) => PreviewCommittedFlowDragReceipt | null
}>

type PaperFlowPending = Readonly<{ authority: GestureAuthoritySnapshot; state: PaperFlowDragState; interactionId: string }>
type PaperFlowGesture = Base & {
  kind: 'paper-flow'
  authority: GestureAuthoritySnapshot
  state: PaperFlowDragState
  interactionId: string
  presentation: FlowDragPresentation | null
  claim: LocalFlowClaimToken | null
  claimReady: Promise<boolean> | null
  claimGranted: boolean
  reservation: Promise<boolean> | null
  reservationPending: boolean
  reservedLane: string | null
  collaborative: boolean
}

let resizePresentationSequence = 0
const nextResizePresentationId = () => `resize-presentation-${++resizePresentationSequence}`
let rotationPresentationSequence = 0
const nextRotationPresentationId = () => `rotation-presentation-${++rotationPresentationSequence}`
let flowPresentationSequence = 0
const nextFlowPresentationId = () => `flow-presentation-${++flowPresentationSequence}`

/**
 * One gesture state machine for selection, marquee, freeform drag, flow reorder, nesting, drawing, resizing, and panning.
 * Every frame derives from the immutable pointer-down snapshot; cancel restores it exactly.
 */
export function createCanvasGestures(
  store = documentStore,
  geometry = sceneGeometry,
  interactions: CanvasInteractionController = store === documentStore ? collaborationService : localInteractions,
  projections: ResizeHudTarget = canvasHudProjectionService,
  resizePreview: ResizePreviewTarget = store === documentStore ? previewConnection : {
    publishResizePresentation: () => true,
    clearResizePresentation: () => true,
    syncCommittedDocument: () => null,
  },
) {
  const noPersistenceCommit: PersistenceCommit = Object.freeze({ committed: false, persistence: null })
  let element: HTMLElement | null = null
  let gesture: Gesture | null = null
  let interactionId: string | null = null
  let stopPendingGeometry: (() => void) | null = null
  let stopResizeLock: (() => void) | null = null
  let stopResizeAuthority: (() => void) | null = null
  let stopFlowAuthority: (() => void) | null = null
  const viewportPoint = (event: Pick<PointerLike, 'clientX' | 'clientY'>): Point => { const rect = element?.getBoundingClientRect(); return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) } }
  const currentScene = () => { const state = store.getSnapshot(); return buildScene(state.file, state.pageId, geometry.getSnapshot().nodes, state.layoutGeneration) }
  const snapshot = (event: PointerLike, state: DocumentState = store.getSnapshot(), scene: Scene = currentScene()): Base => {
    const client = viewportPoint(event)
    return { pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startViewport: client, startWorld: screenToWorld(client, state.viewport, state.viewportSize), camera: state.viewport, size: state.viewportSize, scene, selection: [...state.selection], moved: false }
  }
  const currentHitContext = (): { state: DocumentState; scene: Scene; frame: HudProjectionFrame } | null => {
    const state = store.getSnapshot(), measured = geometry.getSnapshot()
    if (!state.file || !state.pageId || measured.documentRevision === null || measured.layoutGeneration === null) return null
    const scene = buildScene(state.file, state.pageId, measured.nodes, state.layoutGeneration)
    const frame = currentCanvasHitFrame(projections, {
      fileId: state.file.fileId, pageId: state.pageId, fileRevision: state.file.revision,
      measurementRevision: measured.revision, documentRevision: measured.documentRevision, layoutGeneration: measured.layoutGeneration,
      camera: state.viewport, size: state.viewportSize, selection: state.selection, tool: state.tool, readOnly: state.readOnly,
    })
    return frame && projectedFrameMatchesScene(scene, frame) ? { state, scene, frame } : null
  }
  const worldAt = (base: Base, event: Pick<PointerLike, 'clientX' | 'clientY'>) => screenToWorld(viewportPoint(event), base.camera, base.size)
  const distance = (base: Base, event: Pick<PointerLike, 'clientX' | 'clientY'>) => Math.hypot(event.clientX - base.startClient.x, event.clientY - base.startClient.y)
  const deep = (event: Pick<PointerLike, 'ctrlKey' | 'metaKey'>) => event.ctrlKey || event.metaKey
  const movable = (scene: Scene, id: string) => { const node = scene.byId.get(id); return Boolean(node && !node.flow && !node.locked) }
  const setTransient = (transient: CanvasTransient | null) => store.setTransient(transient)
  const syncInteraction = (transient: CanvasTransient | null = store.getSnapshot().transient) => {
    const state = store.getSnapshot()
    return interactionId !== null && interactions.updateInteraction(interactionId, collaborationTransforms(previewTransientMoves(state.file, state.pageId, transient)))
  }
  const finishInteraction = (activeInteractionId: string, commitAction: () => PersistenceCommit) => {
    let commit = noPersistenceCommit
    try { commit = commitAction() }
    finally {
      setTransient(null)
      if (commit.committed && commit.persistence) void commit.persistence.then(() => interactions.endInteraction(activeInteractionId), () => interactions.endInteraction(activeInteractionId))
      else interactions.endInteraction(activeInteractionId)
    }
  }
  const finish = () => { gesture = null; setTransient(null) }
  const authorityState = () => {
    const state = store.getSnapshot()
    return {
      file: state.file,
      pageId: state.pageId,
      atoms: state.atoms,
      layoutGeneration: state.layoutGeneration,
      viewport: state.viewport,
      viewportSize: state.viewportSize,
      selection: state.selection,
    }
  }
  const captureResizeAuthority = (id: string) => {
    const state = authorityState()
    const authority = captureGestureAuthority(() => state, geometry.getSnapshot)
    if (!authority || authority.selection.length !== 1 || authority.selection[0] !== id) return null
    const resize = resizeGeometryAuthority(authority, id)
    return resize ? { authority, resize, atoms: state.atoms } : null
  }
  const resizeBase = (authority: GestureAuthoritySnapshot, event: PointerLike): Base => {
    const client = viewportPoint(event)
    return {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startViewport: client,
      startWorld: screenToWorld(client, authority.camera, authority.size),
      camera: authority.camera,
      size: authority.size,
      scene: authority.scene,
      selection: [...authority.selection],
      moved: false,
    }
  }
  const frozenStartMatches = (current: ResizeBase) => {
    const state = store.getSnapshot(), measured = geometry.getSnapshot(), start = current.live.authority.start
    if (state.file !== current.compatibleFile) {
      if (!state.file
        || state.file.fileId !== start.fileId
        || state.file.revision !== start.fileRevision
        || JSON.stringify(state.file) !== current.fileSignature) return false
      current.compatibleFile = state.file
    }
    return state.file.fileId === start.fileId
      && state.file.revision === start.fileRevision
      && state.pageId === current.live.authority.pageId
      && state.layoutGeneration === start.layoutGeneration
      && state.viewport.x === current.live.authority.camera.x
      && state.viewport.y === current.live.authority.camera.y
      && state.viewport.zoom === current.live.authority.camera.zoom
      && state.viewportSize.width === current.live.authority.size.width
      && state.viewportSize.height === current.live.authority.size.height
      && state.selection.length === 1
      && state.selection[0] === current.id
      && (state.tool === 'move' || state.tool === 'scale')
      && !state.readOnly
      && !state.blocked
      && !state.textEditing
      && (current.phaseActive
        ? state.transient?.kind === 'resize' && state.transient.interactionId === current.live.presentationId
        : state.transient === null)
      && state.atoms === current.atoms
      && measured.documentRevision === start.documentRevision
      && measured.layoutGeneration === start.layoutGeneration
      && measured.revision === start.measurementRevision
      && !current.lockedIds.some(nodeId => interactions.isNodeLocked?.(nodeId))
  }
  const frozenRotationStartMatches = (current: RotationBase) => {
    const state = store.getSnapshot(), measured = geometry.getSnapshot(), start = current.authority.start
    if (state.file !== current.compatibleFile) {
      if (!state.file
        || state.file.fileId !== start.fileId
        || state.file.revision !== start.fileRevision
        || JSON.stringify(state.file) !== current.fileSignature) return false
      current.compatibleFile = state.file
    }
    return state.file.fileId === start.fileId
      && state.file.revision === start.fileRevision
      && state.pageId === current.authority.pageId
      && state.layoutGeneration === start.layoutGeneration
      && state.viewport.x === current.authority.camera.x
      && state.viewport.y === current.authority.camera.y
      && state.viewport.zoom === current.authority.camera.zoom
      && state.viewportSize.width === current.authority.size.width
      && state.viewportSize.height === current.authority.size.height
      && state.selection.length === 1
      && state.selection[0] === current.id
      && (state.tool === 'move' || state.tool === 'scale')
      && !state.readOnly
      && !state.blocked
      && !state.textEditing
      && (current.phaseActive ? state.transient?.kind === 'resize' && state.transient.interactionId === current.presentationId : state.transient === null)
      && state.atoms === current.atoms
      && measured.documentRevision === start.documentRevision
      && measured.layoutGeneration === start.layoutGeneration
      && measured.revision === start.measurementRevision
      && !current.lockedIds.some(nodeId => interactions.isNodeLocked?.(nodeId))
  }
  const presentationTransforms = (presentation: ResizePresentation): readonly EditorCollaborationTransform[] => Object.freeze(presentation.items.map(item => Object.freeze({
    nodeId: item.nodeId,
    dx: item.rect.x - item.startRect.x,
    dy: item.rect.y - item.startRect.y,
    width: item.rect.width,
    height: item.rect.height,
  })))
  const stopResizeObservers = () => {
    stopPendingGeometry?.()
    stopPendingGeometry = null
    stopResizeLock?.()
    stopResizeLock = null
    stopResizeAuthority?.()
    stopResizeAuthority = null
  }
  const stopFlowObservers = () => {
    stopFlowAuthority?.()
    stopFlowAuthority = null
  }
  const clearResizePresentation = (current?: ResizeBase) => {
    resizePreview.clearResizePresentation()
    projections.clearResizePresentation?.()
    const transient = store.getSnapshot().transient
    if (!current || (transient?.kind === 'resize' && transient.interactionId === current.live.presentationId)) setTransient(null)
  }
  const publishResizeSample = (current: ResizeBase, event: PointerLike): boolean => {
    if (!frozenStartMatches(current)) return false
    const sampled = sampleLiveResizeInteraction(current.live, worldAt(current, event), {
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      spaceHeld: store.getSnapshot().spaceHeld,
    })
    if (!sampled) return false
    current.live = sampled.interaction
    current.last = sampled
    if (!interactions.updateInteraction(current.claimId, presentationTransforms(sampled.presentation))) return false
    if (!current.phaseActive) {
      current.phaseActive = true
      setTransient({ kind: 'resize', interactionId: current.live.presentationId })
    }
    try {
      const hudPublished = projections.publishResizePresentation?.(sampled.presentation, current.live.authority.start) ?? true
      const previewPublished = resizePreview.publishResizePresentation({
        presentation: sampled.presentation,
        start: current.live.authority.start,
        interactionId: current.live.presentationId,
        sampleSequence: sampled.interaction.sampleSequence,
        pageRootNodeId: current.live.resizeAuthority.pageRootId,
      })
      return hudPublished && previewPublished
    } catch {
      return false
    }
  }
  const clearRotationPresentation = (current?: RotationBase) => {
    resizePreview.clearRotationPreview?.()
    projections.clearResizePresentation?.()
    const transient = store.getSnapshot().transient
    if (!current || (transient?.kind === 'resize' && transient.interactionId === current.presentationId)) setTransient(null)
  }
  const publishRotationSample = (current: RotationBase, event: PointerLike): boolean => {
    if (!frozenRotationStartMatches(current)) return false
    const targetRotation = rotationDegreesFromPointer(current.startRotation, current.center, current.startWorld, worldAt(current, event), event.shiftKey)
    const presentation = projectRotationPresentation(current.resizeAuthority, targetRotation)
    if (!presentation || !interactions.updateInteraction(current.claimId, [{ nodeId: current.id, dx: 0, dy: 0 }])) return false
    current.targetRotation = targetRotation
    if (!current.phaseActive) {
      current.phaseActive = true
      setTransient({ kind: 'resize', interactionId: current.presentationId })
    }
    return (projections.publishResizePresentation?.(presentation, current.authority.start) ?? true)
      && (resizePreview.publishRotationPreview?.(current.id, targetRotation - current.startRotation) ?? true)
  }
  const activateRotation = (id: string, corner: RotationCorner, event: PointerLike, claimId: string, lockedIds: readonly string[], captured = captureResizeAuthority(id)): RotationBase | null => {
    if (!captured) return null
    const world = projectResizeRectToWorld(captured.resize, captured.resize.startRect)
    if (!world) return null
    const center = world.quad.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 })
    const base = resizeBase(captured.authority, event)
    const current: RotationBase = {
      ...base,
      kind: 'rotation', id, corner, claimId, lockedIds, atoms: captured.atoms,
      compatibleFile: captured.authority.file,
      fileSignature: JSON.stringify(captured.authority.file),
      authority: captured.authority,
      resizeAuthority: captured.resize,
      center,
      startRotation: captured.resize.rotationDegrees,
      targetRotation: captured.resize.rotationDegrees,
      presentationId: nextRotationPresentationId(),
      phaseActive: false,
    }
    stopResizeLock?.()
    stopResizeLock = interactions.subscribe?.(() => {
      if (gesture === current && ((interactions.hasInteraction && !interactions.hasInteraction(current.claimId))
        || current.lockedIds.some(nodeId => interactions.isNodeLocked?.(nodeId)))) cancel()
    }) ?? null
    const authorityChanged = () => { if (gesture === current && !frozenRotationStartMatches(current)) cancel() }
    const authorityStops = [store.subscribe(authorityChanged), geometry.subscribe(authorityChanged)]
    stopResizeAuthority = () => { for (const stop of authorityStops) stop() }
    return current
  }
  const activateResize = (id: string, handle: ResizeHandle, event: PointerLike, claimId: string, lockedIds: readonly string[], captured = captureResizeAuthority(id)): ResizeBase | null => {
    if (!captured) return null
    const base = resizeBase(captured.authority, event)
    const live = beginLiveResizeInteraction(captured.authority, captured.resize, handle, base.startWorld, nextResizePresentationId())
    if (!live) return null
    const current: ResizeBase = {
      ...base,
      kind: 'resize', id, claimId, lockedIds, atoms: captured.atoms,
      compatibleFile: captured.authority.file,
      fileSignature: JSON.stringify(captured.authority.file),
      live, last: null, phaseActive: false,
    }
    stopResizeLock?.()
    stopResizeLock = interactions.subscribe?.(() => {
      if (gesture === current && ((interactions.hasInteraction && !interactions.hasInteraction(current.claimId))
        || current.lockedIds.some(nodeId => interactions.isNodeLocked?.(nodeId)))) cancel()
    }) ?? null
    const authorityChanged = () => { if (gesture === current && !frozenStartMatches(current)) cancel() }
    const authorityStops = [store.subscribe(authorityChanged), geometry.subscribe(authorityChanged)]
    stopResizeAuthority = () => { for (const stop of authorityStops) stop() }
    return current
  }
  const resolvePendingResize = () => {
    const pending = gesture
    if (!pending || pending.kind !== 'pending-resize') return
    const state = store.getSnapshot()
    if (!state.file
      || state.file.fileId !== pending.file.fileId
      || state.file.revision !== pending.file.revision
      || (state.file !== pending.file && JSON.stringify(state.file) !== pending.fileSignature)
      || state.pageId !== pending.pageId
      || state.layoutGeneration !== pending.layoutGeneration
      || state.atoms !== pending.atoms
      || state.selection.length !== 1
      || state.selection[0] !== pending.id
      || state.readOnly
      || state.blocked
      || state.textEditing
      || state.transient
      || pending.lockedIds.some(nodeId => interactions.isNodeLocked?.(nodeId))) {
      cancel()
      return
    }
    const current = activateResize(pending.id, pending.handle, pending.start, pending.claimId, pending.lockedIds)
    if (!current) return
    stopPendingGeometry?.()
    stopPendingGeometry = null
    gesture = current
    if (Math.hypot(pending.latest.clientX - pending.start.clientX, pending.latest.clientY - pending.start.clientY) < handleDragThresholdCss) return
    current.moved = true
    if (!publishResizeSample(current, pending.latest)) cancel()
  }
  const beginPendingResize = (id: string, handle: ResizeHandle, event: PointerLike, claimId: string, lockedIds: readonly string[], state: DocumentState) => {
    if (!state.file || !state.pageId) return false
    const copy = { ...event }
    const pending: PendingResize = {
      kind: 'pending-resize', id, handle, pointerId: event.pointerId, start: copy, latest: copy, claimId, lockedIds,
      file: state.file, fileSignature: JSON.stringify(state.file), atoms: state.atoms, pageId: state.pageId, layoutGeneration: state.layoutGeneration,
    }
    gesture = pending
    stopPendingGeometry?.()
    const pendingStops = [geometry.subscribe(resolvePendingResize), store.subscribe(resolvePendingResize)]
    stopPendingGeometry = () => { for (const stop of pendingStops) stop() }
    stopResizeLock?.()
    stopResizeLock = interactions.subscribe?.(() => {
      if (gesture === pending && ((interactions.hasInteraction && !interactions.hasInteraction(pending.claimId))
        || pending.lockedIds.some(nodeId => interactions.isNodeLocked?.(nodeId)))) cancel()
    }) ?? null
    resolvePendingResize()
    return true
  }
  const eventTime = (event: PointerLike) => Number.isFinite(event.timeStamp) ? event.timeStamp! : (typeof performance === 'object' ? performance.now() : Date.now())
  const flowPlatform = (): 'macos' | 'windows' => typeof navigator === 'object' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'macos' : 'windows'
  const flowLaneKey = (presentation: FlowDragPresentation) => {
    const target = presentation.target
    if (!target) return null
    return `${target.parentId}:${target.slot.presence === 'present' ? `slot:${target.slot.value}` : 'default'}`
  }
  const flowAuthorityCurrent = (current: PaperFlowGesture) => {
    const state = store.getSnapshot(), measured = geometry.getSnapshot(), start = current.authority.start
    return state.file === current.authority.file
      && state.pageId === current.authority.pageId
      && state.layoutGeneration === start.layoutGeneration
      && state.selection.length === 1
      && state.selection[0] === current.state.nodeId
      && !state.readOnly
      && !state.blocked
      && !state.textEditing
      && state.transient === null
      && measured.revision === start.measurementRevision
      && measured.documentRevision === start.documentRevision
      && measured.layoutGeneration === start.layoutGeneration
  }
  const flowTarget = (authority: GestureAuthoritySnapshot, state: PaperFlowDragState) => {
    const hovered = containingFrameAt(authority.scene, state.currentWorld, state.nodeId)?.id ?? pageRoot(authority.file, authority.pageId) ?? state.sourceRelationship.parentId
    return resolveFlowDragTarget({ authority, state, hoveredNodeId: hovered })
  }
  const flowSample = (current: PaperFlowGesture, event: PointerLike) => {
    const world = worldAt(current, event)
    const detachedToCanvas = containingFrameAt(current.authority.scene, world, current.state.nodeId) === null
    const entryGeometry = current.state.primaryActive && event.altKey && !current.state.altActive
      ? paperFlowAbsoluteDropGeometry({
        file: current.authority.file,
        scene: current.authority.scene,
        geometry: current.authority.geometry,
        fence: current.authority.start,
        childId: current.state.nodeId,
        parentId: current.state.sourceRelationship.parentId,
        pointerDownWorld: current.state.pointerDownWorld,
        terminalWorld: world,
      })
      : undefined
    return samplePaperFlowDrag(current.state, {
      world,
      viewport: viewportPoint(event),
      timestamp: Math.max(eventTime(event), current.state.currentTime),
      modifiers: { altKey: event.altKey, ctrlKey: event.ctrlKey || flowPlatform() === 'windows' && detachedToCanvas, metaKey: event.metaKey || flowPlatform() === 'macos' && detachedToCanvas, altGraph: event.getModifierState?.('AltGraph') ?? false },
      platform: flowPlatform(),
      authority: { ...current.state.fence, gestureGeneration: current.state.gestureGeneration, owned: true },
      ...(entryGeometry ? { entryGeometry } : {}),
      resolveTarget: edge => flowTarget(current.authority, edge),
    })
  }
  const flowPresentation = (current: PaperFlowGesture, state: PaperFlowDragState, terminalReason?: 'pointer-up' | 'escape-after-threshold' | 'pointercancel-after-threshold') => {
    const measurement = captureFlowDragAuthorityMeasurement(current.authority, state)
    if (!measurement) return null
    const retention = terminalReason
      ? { kind: 'terminal-retained' as const, gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence, terminalReason, terminalSampleSequence: state.sampleSequence, holdUntil: 'authoritative-geometry' as const }
      : { kind: 'active' as const, gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence }
    const authority = buildFlowDragPresentationAuthority({
      snapshot: current.authority,
      state,
      interactionId: current.interactionId,
      retention,
      reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
      measurement,
    })
    return authority ? projectFlowDragPresentation({ state, authority, publicationIdentity: authority.publicationIdentity }) : null
  }
  const reserveAndSampleFlow = async (current: PaperFlowGesture, presentation: FlowDragPresentation): Promise<boolean> => {
    if (!current.claim) return true
    const key = flowLaneKey(presentation)
    const sourceKey = `${current.state.sourceRelationship.parentId}:${current.state.sourceRelationship.slot.presence === 'present' ? `slot:${current.state.sourceRelationship.slot.value}` : 'default'}`
    if (!key || key === sourceKey || key === current.reservedLane) return collaborationService.sampleFlow(current.claim, presentation)
    const target = presentation.target!
    const result = await collaborationService.reserveFlow(current.claim, { parentId: target.parentId, slot: target.slot }, presentation)
    if (result.status !== 'granted') return false
    current.reservedLane = key
    return true
  }
  const publishPaperFlow = (current: PaperFlowGesture, presentation: FlowDragPresentation): boolean => {
    current.presentation = presentation
    if (current.collaborative) {
      let acquired = false
      if (!current.claim) {
        acquired = true
        const acquisition = collaborationService.acquireFlow(presentation)
        current.claim = acquisition.token
        const acquiredLane = flowLaneKey(presentation)
          ?? `${current.state.sourceRelationship.parentId}:${current.state.sourceRelationship.slot.presence === 'present' ? `slot:${current.state.sourceRelationship.slot.value}` : 'default'}`
        current.claimReady = acquisition.result.then(result => {
          const granted = result.status === 'granted'
          if (granted) { current.claimGranted = true; current.reservedLane = acquiredLane }
          if (!granted && gesture === current) hardCancelPaperFlow(current, 'failed')
          return granted
        })
      }
      const prior = current.reservation ?? current.claimReady
      if (prior) {
        const operation = acquired ? prior
          : current.claimGranted && !current.reservationPending
            ? reserveAndSampleFlow(current, presentation)
            : prior.then(ready => ready && reserveAndSampleFlow(current, presentation))
        current.reservationPending = !acquired
        current.reservation = operation
        void operation.then(ok => {
          if (current.reservation === operation) current.reservationPending = false
          if (!ok && gesture === current) hardCancelPaperFlow(current, 'failed')
        })
      }
    }
    const hud = projections.publishFlowDragPresentation?.(presentation) ?? true
    const preview = resizePreview.publishFlowDragPresentation?.(presentation) ?? true
    return hud && preview
  }
  const retirePaperFlow = (current: PaperFlowGesture, reason: 'cancelled' | 'failed') => {
    stopFlowObservers()
    const presentation = current.presentation
    if (current.claim) void collaborationService.releaseFlow(current.claim, reason)
    if (!presentation) return
    if (presentation.retention.kind === 'active') projections.clearFlowDragPresentation?.(presentation.identity)
    const retirement = Object.freeze({
      interactionId: presentation.identity.interactionId,
      gestureGeneration: presentation.identity.gestureGeneration,
      sequence: presentation.identity.sampleSequence,
      sourceFence: presentation.fence,
    })
    resizePreview.clearFlowDragPresentation?.(retirement)
    if (presentation.retention.kind === 'terminal-retained') projections.retireFailedFlowDragHold?.(Object.freeze({
      kind: 'terminal-flow-failure' as const,
      interactionId: presentation.identity.interactionId,
      gestureGeneration: presentation.identity.gestureGeneration,
      terminalSequence: presentation.identity.sampleSequence,
      sourceFence: presentation.fence,
    }))
  }
  function hardCancelPaperFlow(current: PaperFlowGesture, reason: 'cancelled' | 'failed') {
    if (gesture === current) gesture = null
    retirePaperFlow(current, reason)
    store.selectMany(current.selection)
  }
  const capturePaperFlow = (target: SceneNode, event: PointerLike): PaperFlowPending | null => {
    if (!target.flow || !target.parentId) return null
    const authority = captureGestureAuthority(authorityState, geometry.getSnapshot)
    if (!authority || authority.selection.length !== 1 || authority.selection[0] !== target.id) return null
    const relationship = authority.file.relationships[target.id]
    if (!relationship || relationship.parentId !== target.parentId) return null
    const siblingIds = fileChildrenOf(authority.file, relationship.parentId, relationship.slot)
    const sourceIndex = siblingIds.indexOf(target.id)
    if (sourceIndex < 0) return null
    const state = beginPaperFlowDrag({
      nodeId: target.id,
      pointerDownWorld: screenToWorld(viewportPoint(event), authority.camera, authority.size),
      pointerDownViewport: viewportPoint(event),
      pointerDownTime: eventTime(event),
      sourceRelationship: {
        parentId: relationship.parentId,
        orderKey: relationship.orderKey,
        slot: Object.hasOwn(relationship, 'slot') ? { presence: 'present', value: relationship.slot! } : { presence: 'absent' },
      },
      sourceIndex,
      gestureGeneration: ++flowPresentationSequence,
      selectionDepthPrimary: deep(event),
      fence: authority.start,
    })
    return state ? { authority, state, interactionId: nextFlowPresentationId() } : null
  }
  const activatePaperFlow = (base: Extract<Gesture, { kind: 'press' }>, pending: PaperFlowPending, state: PaperFlowDragState): PaperFlowGesture => {
    const current: PaperFlowGesture = {
      ...base,
      kind: 'paper-flow',
      authority: pending.authority,
      state,
      interactionId: pending.interactionId,
      presentation: null,
      claim: null,
      claimReady: null,
      claimGranted: false,
      reservation: null,
      reservationPending: false,
      reservedLane: null,
      collaborative: store === documentStore && collaborationService.getSnapshot().status === 'live' && collaborationService.getSnapshot().canMutate,
      moved: true,
    }
    const authorityChanged = () => { if (gesture === current && !flowAuthorityCurrent(current)) hardCancelPaperFlow(current, 'failed') }
    const stops = [store.subscribe(authorityChanged), geometry.subscribe(authorityChanged)]
    stopFlowAuthority = () => { for (const stop of stops) stop() }
    return current
  }
  const beginMove = (base: Base, ids: string[], flow: { id: string; parentId: string } | null): Gesture => {
    const startRects: Record<string, Rect> = {}
    for (const id of ids) { const node = base.scene.byId.get(id); if (node) startRects[id] = node.rect }
    return { ...base, kind: 'move', ids, startRects, flow }
  }
  /**
   * A component child of a Flex component reorders by visual lines (wrap and reverse aware). Siblings come from the
   * file's slot so the index matches `reorderFlow`; a sibling without a measured rectangle keeps its place in the order.
   */
  const flexDrop = (current: Extract<Gesture, { kind: 'move' }>, world: Point) => {
    const flow = current.flow
    const file = store.getSnapshot().file
    if (!flow || !file) return null
    const child = file.nodes[flow.id], parent = file.nodes[flow.parentId]
    const flex = parent?.type === 'component' && parent.layout?.container?.display === 'flex' ? parent.layout.container.flex : undefined
    if (child?.type !== 'component' || !flex) return null
    const missing: Rect = { x: 0, y: 0, width: 0, height: 0 }
    const siblings = fileChildrenOf(file, flow.parentId, file.relationships[flow.id]?.slot).map(id => ({ id, rect: current.scene.byId.get(id)?.rect ?? missing }))
    return flexInsertIndex(world, siblings, flow.id, flex.direction, flex.wrap)
  }
  const movePreview = (current: Extract<Gesture, { kind: 'move' }>, event: PointerLike) => {
    const state = store.getSnapshot()
    const world = worldAt(current, event)
    if (current.flow) {
      const flex = flexDrop(current, world)
      if (flex) {
        const thickness = 2 / state.viewport.zoom
        const guide = flex.guide
        const insertion = guide ? { axis: guide.axis, rect: guide.axis === 'x' ? { x: guide.position - thickness / 2, y: guide.start, width: thickness, height: guide.end - guide.start } : { x: guide.start, y: guide.position - thickness / 2, width: guide.end - guide.start, height: thickness } } : null
        const rect = current.startRects[current.flow.id]!
        const offset = { x: world.x - current.startWorld.x, y: world.y - current.startWorld.y }
        setTransient({ kind: 'move', rects: { [current.flow.id]: { ...rect, x: rect.x + offset.x, y: rect.y + offset.y } }, offset, guides: [], targetFrameId: null, insertion })
        return
      }
      const parent = current.scene.byId.get(current.flow.parentId)
      const siblings = childrenOf(current.scene, current.flow.parentId)
      const { index, axis } = flowInsertIndex(world, siblings, current.flow.id)
      const others = siblings.filter(sibling => sibling.id !== current.flow!.id)
      const anchor = others[index] ?? others[others.length - 1]
      const after = index >= others.length
      let insertion: { axis: 'x' | 'y'; rect: Rect } | null = null
      if (anchor && parent) {
        const thickness = 2 / state.viewport.zoom
        insertion = axis === 'y'
          ? { axis, rect: { x: parent.rect.x, y: (after ? anchor.rect.y + anchor.rect.height : anchor.rect.y) - thickness / 2, width: parent.rect.width, height: thickness } }
          : { axis, rect: { x: (after ? anchor.rect.x + anchor.rect.width : anchor.rect.x) - thickness / 2, y: parent.rect.y, width: thickness, height: parent.rect.height } }
      }
      const rect = current.startRects[current.flow.id]!
      const delta = { x: world.x - current.startWorld.x, y: world.y - current.startWorld.y }
      setTransient({ kind: 'move', rects: { [current.flow.id]: { ...rect, x: rect.x + delta.x, y: rect.y + delta.y } }, offset: delta, guides: [], targetFrameId: null, insertion })
      return
    }
    const delta = { x: world.x - current.startWorld.x, y: world.y - current.startWorld.y }
    if (event.shiftKey) { if (Math.abs(delta.x) >= Math.abs(delta.y)) delta.y = 0; else delta.x = 0 }
    const excluded = new Set(current.ids.flatMap(id => [id, ...descendants(current.scene, id).map(node => node.id)]))
    const primary = current.scene.byId.get(current.ids[0]!)
    const primitives = current.ids.filter(id => current.scene.byId.get(id)?.kind !== 'component')
    const targetFrame = primitives.length ? containingFrameAt(current.scene, world, current.ids[0]) : null
    const targetFrameId = targetFrame?.id ?? null
    const candidates = current.scene.nodes.filter(node => !excluded.has(node.id) && ((node.parentId ?? null) === (targetFrameId ?? primary?.parentId ?? null) || node.id === targetFrameId)).map(node => node.rect)
    const moving = primary ? { ...current.startRects[primary.id]!, x: current.startRects[primary.id]!.x + delta.x, y: current.startRects[primary.id]!.y + delta.y } : null
    const snap = moving ? snapRect(moving, candidates, snapThresholdCss / current.camera.zoom) : { dx: 0, dy: 0, guides: [] }
    const rects: Record<string, Rect> = {}
    for (const id of current.ids) { const rect = current.startRects[id]; if (rect) rects[id] = roundRect({ ...rect, x: rect.x + delta.x + snap.dx, y: rect.y + delta.y + snap.dy }) }
    const offset = primary && rects[primary.id] ? { x: rects[primary.id]!.x - current.startRects[primary.id]!.x, y: rects[primary.id]!.y - current.startRects[primary.id]!.y } : { x: delta.x + snap.dx, y: delta.y + snap.dy }
    setTransient({ kind: 'move', rects, offset, guides: snap.guides, targetFrameId: primitives.length ? targetFrameId : null, insertion: null })
  }
  const commitMove = (current: Extract<Gesture, { kind: 'move' }>, event: PointerLike) => {
    const transient = store.getSnapshot().transient
    if (current.flow) {
      const flex = flexDrop(current, worldAt(current, event))
      if (flex) return store.commands.reorderFlow(current.flow.id, flex.index)
      const siblings = childrenOf(current.scene, current.flow.parentId)
      const { index } = flowInsertIndex(worldAt(current, event), siblings, current.flow.id)
      // flowInsertIndex counts positions among the other siblings; reorderFlow expects a position that includes the dragged node.
      const position = siblings.findIndex(sibling => sibling.id === current.flow!.id)
      return store.commands.reorderFlow(current.flow.id, position >= 0 && index >= position ? index + 1 : index)
    }
    if (transient?.kind !== 'move') return noPersistenceCommit
    const state = store.getSnapshot()
    const file = state.file
    const root = file && state.pageId ? pageRoot(file, state.pageId) : null
    if (!file || !root) return noPersistenceCommit
    const moves = current.ids.flatMap((id): MoveCommit[] => {
      const rect = transient.rects[id]
      if (!rect) return []
      const node = current.scene.byId.get(id)
      if (!node) return []
      if (node.kind === 'component') return file.relationships[id]?.parentId === root ? [{ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height }] : []
      const parentId = transient.targetFrameId !== null && transient.targetFrameId !== id ? transient.targetFrameId : current.ids.includes(node.parentId ?? '') ? node.parentId ?? null : transient.targetFrameId
      return [{ id, x: rect.x, y: rect.y, parentId: parentId ?? null }]
    })
    const duplicate = event.altKey && event.getModifierState?.('AltGraph') !== true
    return store.commands.commitMove(moves, { duplicate })
  }
  const commitPaperFlow = async (current: PaperFlowGesture, terminal: FlowDragPresentation) => {
    if (current.claim) {
      const granted = await (current.claimReady ?? Promise.resolve(false))
      const priorSamplesSettled = await (current.reservation ?? Promise.resolve(granted))
      if (!granted || !priorSamplesSettled || !await reserveAndSampleFlow(current, terminal)
        || !collaborationService.markFlowTerminal(current.claim, terminal, 'committed')) {
        retirePaperFlow(current, 'failed')
        return
      }
    }
    current.presentation = terminal
    const hudPublished = projections.publishFlowDragPresentation?.(terminal) ?? true
    const previewPublished = resizePreview.publishFlowDragPresentation?.(terminal) ?? true
    const intent = derivePaperFlowTerminalIntent({ authority: current.authority, state: current.state })
    if (!hudPublished || !previewPublished || !intent) {
      retirePaperFlow(current, 'failed')
      return
    }
    const commit = store.commands.commitGesture(current.authority, [intent], current.claim
      ? command => collaborationService.flowPersistenceIntent(current.claim!, [command])
      : undefined)
    if (!commit.committed) {
      retirePaperFlow(current, 'failed')
      return
    }
    const receipt = resizePreview.syncCommittedFlowDrag?.({ commit, committedFile: store.getSnapshot().file, terminalPresentation: terminal }) ?? null
    if (!receipt || !projections.completeCommittedFlowDragHold?.(receipt)) {
      retirePaperFlow(current, 'failed')
      return
    }
    if (current.claim) {
      const release = () => { void collaborationService.releaseFlow(current.claim!, 'committed') }
      if (commit.persistence) void commit.persistence.then(release, () => retirePaperFlow(current, 'failed'))
      else release()
    }
  }
  const finalizePaperFlow = (current: PaperFlowGesture, reason: 'pointer-up' | 'escape-after-threshold' | 'pointercancel-after-threshold', event?: PointerLike) => {
    const sampled = event ? flowSample(current, event) : current.state
    if (!sampled || !sampled.thresholdCrossed) { hardCancelPaperFlow(current, 'cancelled'); return }
    current.state = sampled
    const terminal = flowPresentation(current, sampled, reason)
    gesture = null
    stopFlowObservers()
    if (!terminal) { retirePaperFlow(current, 'failed'); return }
    void commitPaperFlow(current, terminal)
  }
  const cancel = () => {
    if (!gesture) return
    const current = gesture
    if (current.kind === 'paper-flow' && current.state.thresholdCrossed) {
      finalizePaperFlow(current, 'escape-after-threshold')
      return
    }
    gesture = null
    const activeInteractionId = current.kind === 'resize' || current.kind === 'pending-resize' || current.kind === 'rotation' ? current.claimId : interactionId
    interactionId = null
    stopResizeObservers()
    if (activeInteractionId) interactions.endInteraction(activeInteractionId)
    if (current.kind === 'resize') clearResizePresentation(current)
    else if (current.kind === 'pending-resize') clearResizePresentation()
    else if (current.kind === 'rotation') clearRotationPresentation(current)
    else setTransient(null)
    if (current.kind === 'pan') store.setViewport(current.startCamera)
    else if (current.kind === 'marquee' || current.kind === 'press' || current.kind === 'move') store.selectMany(current.selection)
  }
  const releaseClaimAfterCommit = (claimId: string, commit: PersistenceCommit) => {
    if (commit.committed && commit.persistence) void commit.persistence.then(() => interactions.endInteraction(claimId), () => interactions.endInteraction(claimId))
    else interactions.endInteraction(claimId)
  }
  const discardTerminalResize = (current: ResizeBase) => {
    clearResizePresentation(current)
    interactions.endInteraction(current.claimId)
  }
  const commitTerminalResize = (current: ResizeBase) => {
    const terminal = current.last
    if (!terminal || !frozenStartMatches(current) || !projections.beginCommittedResizeHold?.()) {
      discardTerminalResize(current)
      return
    }
    setTransient(null)
    let commit: PersistenceCommit
    try {
      commit = store.commands.commitGesture(current.live.authority, [{
        kind: 'resize',
        nodeId: current.id,
        authority: current.live.resizeAuthority,
        sample: terminal.sample,
      }])
    } catch (error) {
      projections.completeCommittedResizeHold?.(null)
      resizePreview.clearResizePresentation()
      interactions.endInteraction(current.claimId)
      throw error
    }
    if (!commit.committed) {
      projections.completeCommittedResizeHold?.(null)
      resizePreview.clearResizePresentation()
      interactions.endInteraction(current.claimId)
      return
    }
    const receipt = resizePreview.syncCommittedDocument({
      commit,
      committedFile: store.getSnapshot().file,
      start: current.live.authority.start,
      interactionId: current.live.presentationId,
      sampleSequence: terminal.interaction.sampleSequence,
    })
    projections.completeCommittedResizeHold?.(receipt)
    if (!receipt) resizePreview.clearResizePresentation()
    releaseClaimAfterCommit(current.claimId, commit)
  }
  const commitTerminalRotation = (current: RotationBase) => {
    if (!frozenRotationStartMatches(current)) { clearRotationPresentation(current); interactions.endInteraction(current.claimId); return }
    const state = store.getSnapshot()
    const node = state.file?.nodes[current.id]
    clearRotationPresentation(current)
    if (!node || node.type === 'root') { interactions.endInteraction(current.claimId); return }
    const normalized = ((current.targetRotation % 360) + 360) % 360
    if (node.type === 'component') store.commands.layout.set(node.id, setTransformRotation(node.layout, normalized))
    else store.commands.setStyles(node.id, { rotation: normalized })
    interactions.endInteraction(current.claimId)
  }
  return {
    attach: (next: HTMLElement | null) => { element = next },
    get active() { return gesture !== null },
    cancel,
    /** Pointer down on the empty stage or over scene nodes. */
    stagePointerDown: (event: PointerLike): boolean => {
      let state = store.getSnapshot()
      if (!state.file || state.blocked) return false
      if (event.button === 1 || state.tool === 'hand' || state.spaceHeld) { gesture = { ...snapshot(event), kind: 'pan', startCamera: state.viewport }; setTransient({ kind: 'pan' }); return true }
      if (event.button !== 0) return false
      if (state.readOnly) {
        const context = currentHitContext()
        if (!context) return false
        const base = snapshot(event, context.state, context.scene)
        const target = projectedClickTarget(base.scene, context.frame, base.startViewport, context.state.selection, deep(event))
        if (target) store.select(target.id, { additive: event.shiftKey })
        else store.selectMany([])
        return true
      }
      if (creationTools.includes(state.tool as PrimitiveKind)) {
        gesture = { ...snapshot(event), kind: 'draw', elementKind: state.tool as PrimitiveKind }
        return true
      }
      if (state.tool !== 'move' && state.tool !== 'scale') return false
      const context = currentHitContext()
      if (!context) return false
      state = context.state
      const base = snapshot(event, state, context.scene)
      const target = projectedClickTarget(base.scene, context.frame, base.startViewport, state.selection, deep(event))
      if (!target) { gesture = { ...base, kind: 'marquee' }; return true }
      const selectedContainer = !event.shiftKey && !deep(event) && state.selection.length === 1
        ? base.scene.byId.get(state.selection[0]!)
        : undefined
      const dragTarget = selectedContainer
        && (selectedContainer.kind === 'frame' || selectedContainer.kind === 'component')
        && ancestors(base.scene, target.id).some(node => node.id === selectedContainer.id)
        ? selectedContainer
        : target
      const deferred = state.selection.includes(target.id) || dragTarget.id !== target.id
      if (!deferred) store.select(target.id, { additive: event.shiftKey })
      gesture = { ...base, kind: 'press', target, dragTarget, deferred, paperFlow: event.shiftKey ? null : capturePaperFlow(dragTarget, event) }
      return true
    },
    /** Pointer down on a root label: Wonder drags the whole root from its label. */
    labelPointerDown: (event: PointerLike, id: string): boolean => {
      const state = store.getSnapshot()
      if (!state.file || state.blocked || event.button !== 0) return false
      const base = snapshot(event)
      const node = base.scene.byId.get(id)
      if (!node || node.locked) return false
      if (!state.selection.includes(id)) store.select(id, { additive: event.shiftKey })
      gesture = { ...base, kind: 'press', target: node, dragTarget: node, deferred: state.selection.includes(id), paperFlow: event.shiftKey ? null : capturePaperFlow(node, event) }
      return true
    },
    handlePointerDown: (event: PointerLike, id: string, handle: ResizeHandle): boolean => {
      const state = store.getSnapshot()
      if (gesture || !state.file || !state.pageId || state.readOnly || state.blocked || state.textEditing || state.transient || event.button !== 0) return false
      if (state.selection.length !== 1 || state.selection[0] !== id || nodeIsLocked(state.file, id)) return false
      const lockedIds = Object.freeze([id, ...fileDescendantsOf(state.file, id)])
      const captured = captureResizeAuthority(id)
      const measured = geometry.getSnapshot()
      const pendingFreshGeometry = !captured
        && measured.documentRevision !== null
        && measured.documentRevision < state.file.revision
        && measured.layoutGeneration === state.layoutGeneration
      if (!captured && !pendingFreshGeometry) return false
      const acquired = interactions.beginInteraction('resize', lockedIds)
      if (!acquired) return false
      const current = captured ? activateResize(id, handle, event, acquired, lockedIds, captured) : null
      if (current) gesture = current
      else if (!pendingFreshGeometry || !beginPendingResize(id, handle, event, acquired, lockedIds, state)) { interactions.endInteraction(acquired); return false }
      return true
    },
    rotationPointerDown: (event: PointerLike, id: string, corner: RotationCorner): boolean => {
      const state = store.getSnapshot()
      if (gesture || !state.file || !state.pageId || state.readOnly || state.blocked || state.textEditing || state.transient || event.button !== 0) return false
      if (state.selection.length !== 1 || state.selection[0] !== id || nodeIsLocked(state.file, id)) return false
      const lockedIds = Object.freeze([id, ...fileDescendantsOf(state.file, id)])
      const captured = captureResizeAuthority(id)
      if (!captured) return false
      const acquired = interactions.beginInteraction('resize', lockedIds)
      if (!acquired) return false
      const current = activateRotation(id, corner, event, acquired, lockedIds, captured)
      if (!current) { interactions.endInteraction(acquired); return false }
      gesture = current
      return true
    },
    handleDoubleClick: (id: string, handle: ResizeHandle, fill: boolean): boolean => {
      const state = store.getSnapshot()
      const node = state.file?.nodes[id]
      if (!state.file || state.readOnly || state.blocked || !node || node.type !== 'text') return false
      if (fill) {
        const parentId = state.file.relationships[id]?.parentId
        const rootId = state.pageId ? pageRoot(state.file, state.pageId) : null
        if (!parentId || parentId === rootId) return false
      }
      return store.commands.text.setSizingMode(id, resizeHandleAxes(handle), fill ? 'fill' : 'fit')
    },
    pointerMove: (event: PointerLike) => {
      const current = gesture
      if (!current || current.pointerId !== event.pointerId) {
        const state = store.getSnapshot()
        if (!state.file || state.transient || !['move', 'scale'].includes(state.tool)) { if (state.hover) store.setHover(null); return }
        const context = currentHitContext()
        if (!context) { if (state.hover) store.setHover(null); return }
        const target = projectedClickTarget(context.scene, context.frame, viewportPoint(event), context.state.selection, deep(event))
        store.setHover(target?.id ?? null)
        return
      }
      if (current.kind === 'pending-resize') {
        current.latest = { ...event }
        resolvePendingResize()
        return
      }
      if (current.kind === 'pan') { store.setViewport({ ...current.startCamera, x: current.startCamera.x + event.clientX - current.startClient.x, y: current.startCamera.y + event.clientY - current.startClient.y }); return }
      if (current.kind === 'press') {
        if (current.paperFlow) {
          const draft: PaperFlowGesture = {
            ...current,
            kind: 'paper-flow',
            authority: current.paperFlow.authority,
            state: current.paperFlow.state,
            interactionId: current.paperFlow.interactionId,
            presentation: null,
            claim: null,
            claimReady: null,
            claimGranted: false,
            reservation: null,
            reservationPending: false,
            reservedLane: null,
            collaborative: store === documentStore && collaborationService.getSnapshot().status === 'live' && collaborationService.getSnapshot().canMutate,
          }
          const sampled = flowSample(draft, event)
          if (!sampled) { gesture = null; return }
          if (!sampled.thresholdCrossed) {
            current.paperFlow = { ...current.paperFlow, state: sampled }
            return
          }
          const flowing = activatePaperFlow(current, current.paperFlow, sampled)
          const presentation = flowPresentation(flowing, sampled)
          gesture = flowing
          store.setHover(null)
          if (!presentation || !publishPaperFlow(flowing, presentation)) hardCancelPaperFlow(flowing, 'failed')
          return
        }
        if (distance(current, event) < dragThresholdCss) return
        const state = store.getSnapshot()
        const flow = current.dragTarget.flow && current.dragTarget.parentId ? { id: current.dragTarget.id, parentId: current.dragTarget.parentId } : null
        const ids = flow ? [current.dragTarget.id] : (state.selection.includes(current.dragTarget.id) ? state.selection : [current.dragTarget.id]).filter(id => movable(current.scene, id))
        if (!ids.length) return
        const lockedIds = [...new Set(ids.flatMap(id => [id, ...descendants(current.scene, id).map(descendant => descendant.id)]))]
        const acquired = interactions.beginInteraction('move', lockedIds)
        if (!acquired) { gesture = null; return }
        interactionId = acquired
        const moving = beginMove(current, ids, flow) as Extract<Gesture, { kind: 'move' }>
        moving.moved = true
        gesture = moving
        store.setHover(null)
        movePreview(moving, event)
        if (!syncInteraction()) cancel()
        return
      }
      if (current.kind === 'paper-flow') {
        const sampled = flowSample(current, event)
        if (!sampled) { hardCancelPaperFlow(current, 'failed'); return }
        current.state = sampled
        const presentation = flowPresentation(current, sampled)
        if (!presentation || !publishPaperFlow(current, presentation)) hardCancelPaperFlow(current, 'failed')
        return
      }
      if (current.kind === 'move') { current.moved = true; movePreview(current, event); if (!syncInteraction()) cancel(); return }
      if (current.kind === 'marquee') {
        if (!current.moved && distance(current, event) < dragThresholdCss) return
        const context = currentHitContext()
        if (!context) return
        const pointer = viewportPoint(event)
        const screenBrush = normalizeRect(current.startViewport, pointer)
        const targets = projectedMarqueeTargets(context.scene, context.frame, screenBrush, deep(event))
        current.moved = true
        const brush = normalizeRect(current.startWorld, screenToWorld(pointer, current.camera, current.size))
        store.selectMany(event.shiftKey ? symmetricDifference(current.selection, targets) : targets)
        setTransient({ kind: 'marquee', rect: brush })
        return
      }
      if (current.kind === 'draw') {
        current.moved = true
        const world = worldAt(current, event)
        const intent = canvasCreationIntent(current.startWorld, world, current.camera.zoom)
        if (current.elementKind === 'text' && intent === 'point') { setTransient(null); return }
        const bounds = canvasCreationBounds(current.elementKind, current.startWorld, world, current.camera.zoom)
        const target = current.elementKind === 'frame' || true ? containingFrameAt(current.scene, current.startWorld) : null
        setTransient({ kind: 'draw', elementKind: current.elementKind, rect: bounds, targetFrameId: target?.id ?? null })
        return
      }
      if (current.kind === 'resize') {
        if (!current.moved && distance(current, event) < handleDragThresholdCss) return
        current.moved = true
        if (!publishResizeSample(current, event)) cancel()
        return
      }
      if (current.kind === 'rotation') {
        if (!current.moved && distance(current, event) < handleDragThresholdCss) return
        current.moved = true
        if (!publishRotationSample(current, event)) cancel()
      }
    },
    pointerUp: (event: PointerLike) => {
      const current = gesture
      if (!current || current.pointerId !== event.pointerId) return
      if (current.kind === 'pending-resize') { cancel(); return }
      if (current.kind === 'resize' && !current.moved && distance(current, event) >= handleDragThresholdCss) current.moved = true
      if (current.kind === 'resize' && current.moved) {
        if (!publishResizeSample(current, event)) { cancel(); return }
      }
      if (current.kind === 'rotation' && !current.moved && distance(current, event) >= handleDragThresholdCss) current.moved = true
      if (current.kind === 'rotation' && current.moved && !publishRotationSample(current, event)) { cancel(); return }
      if (current.kind === 'paper-flow') {
        finalizePaperFlow(current, 'pointer-up', event)
        return
      }
      gesture = null
      stopResizeObservers()
      const activeInteractionId = current.kind === 'resize' || current.kind === 'rotation' ? current.claimId : interactionId
      interactionId = null
      if (current.kind === 'press') {
        if (current.deferred) { if (event.shiftKey) store.select(current.target.id, { additive: true }); else store.select(current.target.id) }
      } else if (current.kind === 'marquee') {
        if (!current.moved && !event.shiftKey) store.select(null)
      } else if (current.kind === 'draw') {
        const world = worldAt(current, event)
        const intent = canvasCreationIntent(current.startWorld, world, current.camera.zoom)
        const bounds = canvasCreationBounds(current.elementKind, current.startWorld, world, current.camera.zoom)
        const parent = containingFrameAt(current.scene, current.startWorld)
        const local = parent ? { x: bounds.x - parent.rect.x, y: bounds.y - parent.rect.y } : { x: bounds.x, y: bounds.y }
        if (current.elementKind === 'text') {
          store.commands.insertCanvasText(intent, intent === 'point'
            ? { ...local, ...(parent ? { parentId: parent.id } : {}) }
            : { ...bounds, ...local, ...(parent ? { parentId: parent.id } : {}) })
        } else if (store.commands.insertCanvas(current.elementKind, { ...bounds, ...local, ...(parent ? { parentId: parent.id } : {}) })) store.setTool('move')
      } else if (current.kind === 'resize' && current.moved) {
        const commitAction = () => commitTerminalResize(current)
        if (interactions.canCommitInteraction(current.claimId)) commitAction()
        else if (interactions.waitForCommitInteraction) void interactions.waitForCommitInteraction(current.claimId).then(allowed => allowed ? commitAction() : discardTerminalResize(current))
        else discardTerminalResize(current)
        return
      } else if (current.kind === 'rotation' && current.moved) {
        commitTerminalRotation(current)
        return
      } else if (current.kind === 'move' && activeInteractionId && current.moved) {
        const pointerUpEvent = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, button: event.button, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey }
        const commitAction = () => commitMove(current, pointerUpEvent)
        if (interactions.canCommitInteraction(activeInteractionId)) finishInteraction(activeInteractionId, commitAction)
        else if (interactions.waitForCommitInteraction) void interactions.waitForCommitInteraction(activeInteractionId).then(allowed => finishInteraction(activeInteractionId, allowed ? commitAction : () => noPersistenceCommit))
        else finishInteraction(activeInteractionId, () => noPersistenceCommit)
        return
      }
      setTransient(null)
      if (activeInteractionId) interactions.endInteraction(activeInteractionId)
    },
    pointerCancel: (event: PointerLike) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return
      if (gesture.kind === 'paper-flow' && gesture.state.thresholdCrossed) finalizePaperFlow(gesture, 'pointercancel-after-threshold', event)
      else cancel()
    },
    /** Double-click drills one level deeper; a second double-click on a selected node starts renaming (frames) or text editing. */
    doubleClick: (event: Pick<PointerLike, 'clientX' | 'clientY' | 'ctrlKey' | 'metaKey'>) => {
      const state = store.getSnapshot()
      if (!state.file || !['move', 'scale'].includes(state.tool)) return
      const context = currentHitContext()
      if (!context) return
      const target = projectedDrillTarget(context.scene, context.frame, viewportPoint(event), context.state.selection)
      if (!target) return
      if (context.state.selection.length === 1 && context.state.selection[0] === target.id) {
        if (!context.state.readOnly && target.kind === 'text') store.commands.text.begin(target.id)
        else if (!context.state.readOnly && target.parentId === null) store.setRenaming(target.id)
        return
      }
      store.select(target.id)
    },
    /** Context-menu targeting shares the exact same canonical screen-quad resolver as click and hover. */
    contextMenuTarget: (event: Pick<PointerLike, 'clientX' | 'clientY' | 'ctrlKey' | 'metaKey'>): SceneNode | null => {
      const context = currentHitContext()
      if (!context || context.state.readOnly || context.state.blocked) return null
      return projectedClickTarget(context.scene, context.frame, viewportPoint(event), context.state.selection, deep(event))
    },
  }
}
export const canvasGestures = createCanvasGestures()
