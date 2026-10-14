import { documentStore } from './document-store'
import { captureGestureAuthority } from './gesture-authority'
import type { GestureAuthorityDocumentState, GestureAuthoritySnapshot } from './gesture-authority'
import { mobileViewport } from './mobile-editor'
import { projectHudFrame } from './canvas-hud-projection'
import type { HudFlowDragCommittedReceipt, HudMovePresentation, HudProjectionFrame, HudProjectionView } from './canvas-hud-projection'
import type { FlowDragPresentation } from './flow-drag-presentation'
import type { ResizePresentation } from './resize-projection'
import type { PreviewCommittedDocumentReceipt } from './preview-service'
import { sceneGeometry } from './scene-geometry'
import type { SceneGeometry } from './scene-geometry'
import { previewCameraStore } from './preview-camera-store'
import type { PreviewCameraSnapshot } from './preview-camera-store'

type DocumentSource = Readonly<{
  getSnapshot: () => GestureAuthorityDocumentState & ReturnType<typeof documentStore.getSnapshot>
  subscribe: (listener: () => void) => () => void
}>

type GeometrySource = Readonly<{
  getSnapshot: () => SceneGeometry
  subscribe: (listener: () => void) => () => void
}>

type MobileSource = Readonly<{
  getSnapshot: () => boolean
  subscribe: (listener: () => void) => () => void
}>

type CameraSource = Readonly<{
  getSnapshot: () => PreviewCameraSnapshot
  subscribe: (listener: () => void) => () => void
}>

type Projection = (input: Readonly<{
  authority: GestureAuthoritySnapshot
  view: HudProjectionView
  movePresentation?: HudMovePresentation | null
  resizePresentation?: ResizePresentation | null
  resizeFence?: GestureAuthoritySnapshot['start']
  flowDragPresentation?: FlowDragPresentation | null
  flowDragReceipt?: HudFlowDragCommittedReceipt | null
}>) => HudProjectionFrame | null

type ActiveResize = Readonly<{
  presentation: ResizePresentation
  fence: GestureAuthoritySnapshot['start']
}>

type ActiveFlowDrag = Readonly<{
  presentation: FlowDragPresentation
  authority: GestureAuthoritySnapshot
  receipt: HudFlowDragCommittedReceipt | null
}>

export type HudFlowDragFailureRetirement = Readonly<{
  kind: 'terminal-flow-failure'
  interactionId: string
  gestureGeneration: number
  terminalSequence: number
  sourceFence: FlowDragPresentation['fence']
}>

export type CanvasHudProjectionSnapshot = Readonly<{
  generation: number
  frame: HudProjectionFrame | null
}>

/** Returns the exact current service publication. Value-equivalent copies are not renderer authority. */
export const currentHudProjectionSnapshot = (observed: CanvasHudProjectionSnapshot, current: CanvasHudProjectionSnapshot): CanvasHudProjectionSnapshot | null => observed === current && observed.generation === current.generation ? observed : null

/** Exact identity gate shared by renderer consumers. A copied or split-generation snapshot fails closed. */
export const currentHudProjectionFrame = (observed: CanvasHudProjectionSnapshot, current: CanvasHudProjectionSnapshot): HudProjectionFrame | null => currentHudProjectionSnapshot(observed, current)?.frame ?? null

type AuthorityInputs = Readonly<{
  file: GestureAuthorityDocumentState['file']
  pageId: GestureAuthorityDocumentState['pageId']
  atoms: GestureAuthorityDocumentState['atoms']
  layoutGeneration: number
  viewport: GestureAuthorityDocumentState['viewport']
  viewportSize: GestureAuthorityDocumentState['viewportSize']
  selection: GestureAuthorityDocumentState['selection']
  geometry: SceneGeometry
  presentedCamera: PreviewCameraSnapshot
}>

type FrameInputs = Readonly<{
  authority: GestureAuthoritySnapshot | null
  hover: string | null
  tool: ReturnType<typeof documentStore.getSnapshot>['tool']
  readOnly: boolean
  mobile: boolean
  resizeActive: boolean
  activeMove: HudMovePresentation | null
  activeResize: ActiveResize | null
  activeFlowDrag: ActiveFlowDrag | null
}>

const sameAuthorityInputs = (left: AuthorityInputs | null, right: AuthorityInputs): boolean => Boolean(left
  && left.file === right.file
  && left.pageId === right.pageId
  && left.atoms === right.atoms
  && left.layoutGeneration === right.layoutGeneration
  && left.viewport === right.viewport
  && left.viewportSize === right.viewportSize
  && left.selection === right.selection
  && left.geometry === right.geometry
  && left.presentedCamera === right.presentedCamera)

const sameFrameInputs = (left: FrameInputs | null, right: FrameInputs): boolean => Boolean(left
  && left.authority === right.authority
  && left.hover === right.hover
  && left.tool === right.tool
  && left.readOnly === right.readOnly
  && left.mobile === right.mobile
  && left.resizeActive === right.resizeActive
  && left.activeMove === right.activeMove
  && left.activeResize === right.activeResize
  && left.activeFlowDrag === right.activeFlowDrag)

const freezeSnapshot = (generation: number, frame: HudProjectionFrame | null): CanvasHudProjectionSnapshot => Object.freeze({ generation, frame })
const failureRetirementKeys = ['kind', 'interactionId', 'gestureGeneration', 'terminalSequence', 'sourceFence'] as const
const sourceFenceKeys = ['fileId', 'fileRevision', 'measurementRevision', 'documentRevision', 'layoutGeneration', 'pageId', 'pageRootId'] as const

function exactFrozenDataValues(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.isFrozen(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null
    const values: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      values[key] = descriptor.value
    }
    return values
  } catch { return null }
}

function validFailureRetirement(value: unknown): HudFlowDragFailureRetirement | null {
  const fields = exactFrozenDataValues(value, failureRetirementKeys)
  if (!fields || fields.kind !== 'terminal-flow-failure' || typeof fields.interactionId !== 'string' || fields.interactionId.length === 0
    || fields.interactionId.startsWith('lease:') || !Number.isSafeInteger(fields.gestureGeneration) || (fields.gestureGeneration as number) < 0
    || !Number.isSafeInteger(fields.terminalSequence) || (fields.terminalSequence as number) <= 0) return null
  const fence = exactFrozenDataValues(fields.sourceFence, sourceFenceKeys)
  if (!fence || typeof fence.fileId !== 'string' || fence.fileId.length === 0 || typeof fence.pageId !== 'string' || fence.pageId.length === 0
    || typeof fence.pageRootId !== 'string' || fence.pageRootId.length === 0
    || !sourceFenceKeys.slice(1, 5).every(key => Number.isSafeInteger(fence[key]) && (fence[key] as number) >= 0)) return null
  return value as HudFlowDragFailureRetirement
}

const sameSourceFence = (left: FlowDragPresentation['fence'], right: FlowDragPresentation['fence']): boolean => left.fileId === right.fileId
  && left.fileRevision === right.fileRevision && left.measurementRevision === right.measurementRevision
  && left.documentRevision === right.documentRevision && left.layoutGeneration === right.layoutGeneration
  && left.pageId === right.pageId && left.pageRootId === right.pageRootId

/**
 * Sole lifecycle owner for renderer-neutral HUD projection frames.
 * It caches one immutable frame per coherent document/measurement/view generation and never owns document data.
 */
export function createCanvasHudProjectionService(
  documents: DocumentSource = documentStore,
  geometry: GeometrySource = sceneGeometry,
  mobile: MobileSource = mobileViewport,
  project: Projection = projectHudFrame,
  cameras: CameraSource = previewCameraStore,
) {
  let authorityInputs: AuthorityInputs | null = null
  let authority: GestureAuthoritySnapshot | null = null
  let frameInputs: FrameInputs | null = null
  let activeResize: ActiveResize | null = null
  let activeFlowDrag: ActiveFlowDrag | null = null
  let committedResizeHold = false
  let committedResizeReceipt: PreviewCommittedDocumentReceipt | null = null
  let snapshot = freezeSnapshot(0, null)
  let stops: readonly (() => void)[] = []
  let disposed = false
  const listeners = new Set<() => void>()

  const recompute = (notify = true) => {
    if (disposed) return
    const state = documents.getSnapshot()
    const measured = geometry.getSnapshot()
    const presentedCamera = cameras.getSnapshot()
    const projectionState = presentedCamera?.camera ? {
      ...state,
      viewport: { x: presentedCamera.camera.x, y: presentedCamera.camera.y, zoom: presentedCamera.camera.zoom },
      viewportSize: { width: presentedCamera.camera.width, height: presentedCamera.camera.height },
    } : state
    if (activeFlowDrag?.receipt) {
      const receipt = activeFlowDrag.receipt
      const settled = state.file?.fileId === receipt.fileId
        && state.pageId === receipt.pageId
        && state.file.revision === receipt.documentRevision
        && state.layoutGeneration === receipt.layoutGeneration
        && measured.documentRevision === receipt.documentRevision
        && measured.layoutGeneration === receipt.layoutGeneration
        && measured.revision >= receipt.afterMeasurementRevision
      if (settled) {
        activeFlowDrag = null
        authorityInputs = null
        authority = null
        frameInputs = null
      }
    }
    if (committedResizeHold) {
      const receipt = committedResizeReceipt
      const settled = Boolean(receipt
        && state.file?.fileId === receipt.fileId
        && state.pageId === receipt.pageId
        && state.file.revision === receipt.documentRevision
        && state.layoutGeneration === receipt.layoutGeneration
        && measured.documentRevision === receipt.documentRevision
        && measured.layoutGeneration === receipt.layoutGeneration
        && measured.revision > receipt.afterMeasurementRevision)
      if (!settled) return
      committedResizeHold = false
      committedResizeReceipt = null
      activeResize = null
    }
    const nextAuthorityInputs: AuthorityInputs = {
      file: state.file,
      pageId: state.pageId,
      atoms: state.atoms,
      layoutGeneration: state.layoutGeneration,
      viewport: projectionState.viewport,
      viewportSize: projectionState.viewportSize,
      selection: state.selection,
      geometry: measured,
      presentedCamera,
    }
    if (!activeFlowDrag && !sameAuthorityInputs(authorityInputs, nextAuthorityInputs)) {
      authorityInputs = nextAuthorityInputs
      authority = captureGestureAuthority(() => projectionState, geometry.getSnapshot)
    }
    if (activeFlowDrag) authority = activeFlowDrag.authority
    const editingNodeId = state.textEditing?.nodeId
    const heldTextFrame = snapshot.frame
    const canHoldTextEditor = Boolean(
      !authority
      && editingNodeId
      && heldTextFrame
      && state.file
      && heldTextFrame.key.fileId === state.file.fileId
      && heldTextFrame.key.pageId === state.pageId
      && heldTextFrame.key.fileRevision < state.file.revision
      && heldTextFrame.key.layoutGeneration === state.layoutGeneration
      && measured.documentRevision !== null
      && measured.documentRevision < state.file.revision,
    )
    if (canHoldTextEditor) return
    const resizeActive = state.transient?.kind === 'resize'
    const activeMove = state.transient?.kind === 'move' ? state.transient : null
    if (!resizeActive) activeResize = null
    const nextFrameInputs: FrameInputs = {
      authority,
      hover: state.hover,
      tool: state.tool,
      readOnly: state.readOnly,
      mobile: mobile.getSnapshot(),
      resizeActive,
      activeMove,
      activeResize,
      activeFlowDrag,
    }
    if (sameFrameInputs(frameInputs, nextFrameInputs)) return
    frameInputs = nextFrameInputs
    let frame: HudProjectionFrame | null = null
    if (authority && (!nextFrameInputs.resizeActive || activeResize) && !(activeResize && activeFlowDrag)) {
      const view: HudProjectionView = {
        fileId: authority.start.fileId,
        pageId: authority.pageId,
        fileRevision: authority.start.fileRevision,
        measurementRevision: authority.start.measurementRevision,
        documentRevision: authority.start.documentRevision,
        layoutGeneration: authority.start.layoutGeneration,
        camera: authority.camera,
        size: authority.size,
        selection: authority.selection,
        hover: state.hover,
        tool: state.tool,
        readOnly: state.readOnly,
        mobile: nextFrameInputs.mobile,
      }
      frame = project({
        authority,
        view,
        ...(activeMove ? { movePresentation: activeMove } : {}),
        ...(activeResize ? { resizePresentation: activeResize.presentation, resizeFence: activeResize.fence } : {}),
        ...(activeFlowDrag ? { flowDragPresentation: activeFlowDrag.presentation, flowDragReceipt: activeFlowDrag.receipt } : {}),
      })
    }
    snapshot = freezeSnapshot(snapshot.generation + 1, frame)
    if (notify) for (const listener of listeners) listener()
  }

  recompute(false)
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      if (disposed || stops.length) return
      stops = [documents.subscribe(recompute), geometry.subscribe(recompute), mobile.subscribe(recompute), cameras.subscribe(recompute)]
      recompute()
    },
    stop() {
      for (const stop of stops) stop()
      stops = []
    },
    publishResizePresentation(presentation: ResizePresentation, resizeFence: GestureAuthoritySnapshot['start']) {
      if (disposed) return false
      if (documents.getSnapshot().transient?.kind !== 'resize') return false
      committedResizeHold = false
      committedResizeReceipt = null
      activeResize = Object.freeze({ presentation, fence: Object.freeze({ ...resizeFence }) })
      recompute()
      return snapshot.frame !== null
    },
    clearResizePresentation() {
      if (!activeResize || disposed) return
      committedResizeHold = false
      committedResizeReceipt = null
      activeResize = null
      recompute()
    },
    publishFlowDragPresentation(presentation: FlowDragPresentation) {
      if (disposed || !Object.isFrozen(presentation)) return false
      const current = activeFlowDrag?.presentation
      const sameInteraction = current?.identity.interactionId === presentation.identity.interactionId
      const currentAuthority = sameInteraction ? activeFlowDrag!.authority : captureGestureAuthority(documents.getSnapshot, geometry.getSnapshot)
      if (!currentAuthority) return false
      if (current) {
        if (sameInteraction && presentation.identity.gestureGeneration < current.identity.gestureGeneration) return false
        if (sameInteraction && presentation.identity.gestureGeneration === current.identity.gestureGeneration
          && presentation.identity.sampleSequence < current.identity.sampleSequence) return false
        if (sameInteraction && presentation.identity.gestureGeneration === current.identity.gestureGeneration
          && presentation.identity.sampleSequence === current.identity.sampleSequence && presentation !== current
          && !(current.retention.kind === 'active' && presentation.retention.kind === 'terminal-retained')) return false
        if (presentation === current) return true
      }
      activeResize = null
      committedResizeHold = false
      committedResizeReceipt = null
      activeFlowDrag = Object.freeze({ presentation, authority: currentAuthority, receipt: null })
      recompute()
      return snapshot.frame?.flowDrag?.identity.interactionId === presentation.identity.interactionId
        && snapshot.frame.flowDrag.identity.gestureGeneration === presentation.identity.gestureGeneration
        && snapshot.frame.flowDrag.identity.sampleSequence === presentation.identity.sampleSequence
    },
    clearFlowDragPresentation(identity: FlowDragPresentation['identity']) {
      if (disposed || !activeFlowDrag) return false
      const current = activeFlowDrag.presentation
      if (current.identity.interactionId !== identity.interactionId
        || current.identity.gestureGeneration !== identity.gestureGeneration
        || current.identity.sampleSequence !== identity.sampleSequence
        || current.retention.kind === 'terminal-retained') return false
      activeFlowDrag = null
      authorityInputs = null
      authority = null
      frameInputs = null
      recompute()
      return true
    },
    completeCommittedFlowDragHold(receipt: HudFlowDragCommittedReceipt) {
      if (disposed || !activeFlowDrag || activeFlowDrag.presentation.retention.kind !== 'terminal-retained' || !Object.isFrozen(receipt)) return false
      const presentation = activeFlowDrag.presentation
      const terminal = presentation.retention
      if (terminal.kind !== 'terminal-retained') return false
      if (receipt.interactionId !== presentation.identity.interactionId
        || receipt.gestureGeneration !== presentation.identity.gestureGeneration
        || receipt.terminalSequence !== terminal.terminalSampleSequence
        || receipt.sourceFence.fileId !== presentation.fence.fileId
        || receipt.sourceFence.pageId !== presentation.fence.pageId
        || receipt.sourceFence.pageRootId !== presentation.fence.pageRootId
        || receipt.sourceFence.fileRevision !== presentation.fence.fileRevision
        || receipt.sourceFence.measurementRevision !== presentation.fence.measurementRevision
        || receipt.sourceFence.documentRevision !== presentation.fence.documentRevision
        || receipt.sourceFence.layoutGeneration !== presentation.fence.layoutGeneration
        || receipt.fileId !== presentation.fence.fileId
        || receipt.pageId !== presentation.fence.pageId
        || receipt.documentRevision <= presentation.fence.documentRevision
        || receipt.layoutGeneration < presentation.fence.layoutGeneration
        || receipt.afterMeasurementRevision <= presentation.fence.measurementRevision) return false
      activeFlowDrag = Object.freeze({ ...activeFlowDrag, receipt })
      recompute()
      return true
    },
    retireFailedFlowDragHold(retirement: HudFlowDragFailureRetirement) {
      if (disposed || !activeFlowDrag || activeFlowDrag.receipt !== null) return false
      const exact = validFailureRetirement(retirement)
      if (!exact) return false
      const presentation = activeFlowDrag.presentation
      const terminal = presentation.retention
      if (terminal.kind !== 'terminal-retained' || presentation.identity.interactionId.startsWith('lease:')
        || exact.interactionId !== presentation.identity.interactionId
        || exact.gestureGeneration !== presentation.identity.gestureGeneration
        || exact.gestureGeneration !== terminal.gestureGeneration
        || exact.terminalSequence !== presentation.identity.sampleSequence
        || exact.terminalSequence !== terminal.terminalSampleSequence
        || !sameSourceFence(exact.sourceFence, presentation.fence)) return false
      activeFlowDrag = null
      authorityInputs = null
      authority = null
      frameInputs = null
      recompute()
      return true
    },
    /** Freezes the terminal projected frame across the synchronous document commit. */
    beginCommittedResizeHold() {
      if (disposed || !activeResize || snapshot.frame === null) return false
      committedResizeHold = true
      committedResizeReceipt = null
      return true
    },
    /** Retires the terminal frame only after the matching committed document has fresh measured geometry. */
    completeCommittedResizeHold(receipt: PreviewCommittedDocumentReceipt | null) {
      if (disposed || !committedResizeHold || !receipt) {
        committedResizeHold = false
        committedResizeReceipt = null
        activeResize = null
        recompute()
        return false
      }
      committedResizeReceipt = receipt
      recompute()
      return true
    },
    dispose() {
      if (disposed) return
      for (const stop of stops) stop()
      stops = []
      disposed = true
      activeResize = null
      activeFlowDrag = null
      committedResizeHold = false
      committedResizeReceipt = null
      authority = null
      authorityInputs = null
      frameInputs = null
      snapshot = freezeSnapshot(snapshot.generation + 1, null)
      listeners.clear()
    },
  }
}

export const canvasHudProjectionService = createCanvasHudProjectionService()
