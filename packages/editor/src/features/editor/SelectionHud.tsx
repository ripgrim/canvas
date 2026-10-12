import { memo, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { nodeIsLocked } from '@canvas/repo-engine/file-document'
import type { TextLineHeight, TextSizing, TextStyle } from '@canvas/repo-engine/file-document'
import { CanvasHud, MobileSelectionActions, NodeLabel, NodeNameEditor, ResizeHandles, RotationHandles } from '../../design-system/canvas-atoms'
import type { HandleName, ResizeHandlePose, RotationHandlePose } from '../../design-system/canvas-atoms'
import { Button, Icon } from '../../design-system/atoms'
import { documentStore } from './document-store'
import { canvasGestures } from './canvas-gestures'
import { canvasCopy as copy } from './canvas-copy'
import { canvasHudProjectionService } from './canvas-hud-projection-service'
import { currentHudProjectionFrame } from './canvas-hud-projection-service'
import type { CanvasHudProjectionSnapshot } from './canvas-hud-projection-service'
import type { HudProjectionEntry, HudQuad } from './canvas-hud-projection'
import { createStableMobileQuickActionsStore, mobileQuickActionsPhase, mobileQuickActionsPosition, shouldMountMobileQuickActions } from './mobile-editor'
import type { MobileQuickActionsPhase } from './mobile-editor'
import { rotateTransformQuarter } from './layout-commands'

const lineHeightCss = (value: TextLineHeight): string | number => {
  if (value.kind === 'normal') return 'normal'
  if (value.kind === 'source') return `var(${value.property}, ${lineHeightCss(value.fallback)})`
  if (value.kind === 'percent') return `${value.value}%`
  if (value.kind === 'px') return `${value.value}px`
  if (value.kind === 'em') return `${value.value}em`
  return value.value
}

/** Retained for the text-editing controller. This renderer does not use it until the projector owns an exact editor pose. */
export function canvasTextEditorStyle(base: { x: number; y: number; width: number; height: number }, rotation: number, zoom: number, text: TextStyle, sizing: TextSizing): CSSProperties {
  const safeZoom = Math.max(0.0001, zoom)
  const width = base.width / safeZoom
  const height = base.height / safeZoom
  const fitWidth = sizing.width.mode === 'fit'
  return {
    left: base.x + (base.width - width) / 2,
    top: base.y + (base.height - height) / 2,
    width,
    height,
    transform: `rotate(${rotation}deg) scale(${safeZoom})`,
    fontFamily: text.fontFamily,
    fontStyle: text.fontStyle,
    fontWeight: text.fontWeight,
    fontSize: `${text.fontSize}px`,
    lineHeight: lineHeightCss(text.lineHeight),
    letterSpacing: `${text.fontSize * text.letterSpacing / 100}px`,
    textAlign: text.horizontalAlign,
    alignContent: text.verticalAlign === 'top' ? 'start' : text.verticalAlign === 'middle' ? 'center' : 'end',
    textTransform: text.case === 'none' ? 'none' : text.case,
    whiteSpace: fitWidth ? 'pre' : 'pre-wrap',
    textWrap: fitWidth ? 'nowrap' : text.wrap === 'normal' ? 'wrap' : text.wrap,
    overflowWrap: text.keepWords ? 'normal' : 'anywhere',
    wordBreak: 'normal',
    overflow: sizing.height.mode === 'fit' ? 'visible' : 'hidden',
    ...(text.maxLines !== undefined ? { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: String(text.maxLines), overflow: 'hidden' } : {}),
  }
}

const angleOf = (from: Readonly<{ x: number; y: number }>, to: Readonly<{ x: number; y: number }>) => Math.atan2(to.y - from.y, to.x - from.x)
const cursorForAngle = (angle: number): CSSProperties['cursor'] => {
  const degrees = ((angle * 180 / Math.PI) % 180 + 180) % 180
  if (degrees < 22.5 || degrees >= 157.5) return 'ew-resize'
  if (degrees < 67.5) return 'nwse-resize'
  if (degrees < 112.5) return 'ns-resize'
  return 'nesw-resize'
}

function handleAxis(quad: HudQuad, handle: HandleName): readonly [Readonly<{ x: number; y: number }>, Readonly<{ x: number; y: number }>] {
  if (handle === 'top' || handle === 'bottom') return [quad[0], quad[3]]
  if (handle === 'left' || handle === 'right') return [quad[0], quad[1]]
  if (handle === 'top-left' || handle === 'bottom-right') return [quad[0], quad[2]]
  return [quad[1], quad[3]]
}

function handleEdgeAngle(quad: HudQuad, handle: HandleName): number {
  if (handle === 'top' || handle === 'bottom') return angleOf(quad[0], quad[1])
  if (handle === 'left' || handle === 'right') return angleOf(quad[0], quad[3])
  return 0
}

/** Uses literal projected centers. Only cursor and transparent hit-target orientation are derived from projected axes. */
export function resizeHandlePoses(entry: HudProjectionEntry): readonly ResizeHandlePose[] {
  return entry.controls.map(control => {
    const axis = handleAxis(entry.screenQuad, control.handle)
    return {
      handle: control.handle,
      center: control.center,
      angle: handleEdgeAngle(entry.screenQuad, control.handle),
      cursor: cursorForAngle(angleOf(axis[0], axis[1])),
      active: control.handle === entry.effectiveHandle,
    }
  })
}

export function rotationHandlePoses(entry: HudProjectionEntry): readonly RotationHandlePose[] {
  const center = { x: (entry.screenQuad[0].x + entry.screenQuad[2].x) / 2, y: (entry.screenQuad[0].y + entry.screenQuad[2].y) / 2 }
  const corners = [
    ['top-left', entry.screenQuad[0]],
    ['top-right', entry.screenQuad[1]],
    ['bottom-right', entry.screenQuad[2]],
    ['bottom-left', entry.screenQuad[3]],
  ] as const
  return corners.map(([handle, corner]) => {
    const length = Math.hypot(corner.x - center.x, corner.y - center.y) || 1
    return { handle, center: { x: corner.x + (corner.x - center.x) * 12 / length, y: corner.y + (corner.y - center.y) * 12 / length } }
  })
}

type QuickActionsSnapshot = Readonly<{ phase: MobileQuickActionsPhase; projection: CanvasHudProjectionSnapshot }>
const quickActionsStore = createStableMobileQuickActionsStore<QuickActionsSnapshot['projection']>(
  () => {
    const projection = canvasHudProjectionService.getSnapshot()
    return { phase: mobileQuickActionsPhase(documentStore.getSnapshot().transient, projection.frame), projection }
  },
  listener => {
    const update = () => listener()
    const stops = [documentStore.subscribe(update), canvasHudProjectionService.subscribe(update)]
    return () => stops.forEach(stop => stop())
  },
  value => value.frame !== null,
)

const MobileQuickActionsLayer = memo(function MobileQuickActionsLayer({ id, tool }: { id: string; tool: ReturnType<typeof documentStore.getSnapshot>['tool'] }) {
  const snapshot = useSyncExternalStore(quickActionsStore.subscribe, quickActionsStore.getSnapshot, quickActionsStore.getSnapshot)
  const entry = snapshot.projection.frame?.byNodeId[id]
  if (!snapshot.projection.frame?.key.mobile || !entry?.policy.showQuickActions) return null
  const rotate = () => {
    const node = documentStore.getSnapshot().file?.nodes[id]
    if (!node || node.type === 'root') return
    if (node.type === 'component') documentStore.commands.layout.set(id, rotateTransformQuarter(node.layout))
    else documentStore.commands.setStyles(id, { rotation: ((node.styles.rotation ?? 0) + 90) % 360 })
  }
  const remove = () => documentStore.commands.delete([id])
  const position = mobileQuickActionsPosition(entry.screenAabb, snapshot.projection.frame!.key.size, entry.dimension)
  return <MobileSelectionActions label={copy.quickActions} phase={snapshot.phase} visible={snapshot.phase === 'idle'} position={position} generation={snapshot.projection.generation}><Button label={copy.moveNode} active={tool === 'move'} onClick={() => documentStore.setTool('move')}><Icon name="move" /></Button><Button label={copy.scaleNode} active={tool === 'scale'} onClick={() => documentStore.setTool('scale')}><Icon name="scale" /></Button><Button label={copy.rotateClockwise} onClick={rotate}><Icon name="refresh" /></Button><Button label={copy.deleteNode(entry.name)} onClick={remove}><Icon name="trash" /></Button></MobileSelectionActions>
})

type ProjectionSource = Pick<typeof canvasHudProjectionService, 'getSnapshot' | 'subscribe'>
type DocumentViewSource = Pick<typeof documentStore, 'getViewSnapshot' | 'subscribe'>

type ActiveCanvasGesture = Readonly<{ active: boolean; cancel: () => void }>

/** A normal pointer-up releases capture after the gesture has already committed, so only an active gesture is cancelled. */
export function cancelActiveGestureAfterCaptureLoss(gestures: ActiveCanvasGesture = canvasGestures) {
  if (gestures.active) gestures.cancel()
}

/** DOM renders only canonical transparent targets and exact projector-owned label editing poses. Visible chrome is Canvas2D. */
export function SelectionHud({ projections = canvasHudProjectionService, documents = documentStore }: { projections?: ProjectionSource; documents?: DocumentViewSource } = {}) {
  const projection = useSyncExternalStore(projections.subscribe, projections.getSnapshot, projections.getSnapshot)
  const state = useSyncExternalStore(documents.subscribe, documents.getViewSnapshot, documents.getViewSnapshot)
  const frame = currentHudProjectionFrame(projection, projections.getSnapshot())
  const quickNodeId = state.selection.length === 1 ? state.selection[0] : undefined
  const quickNode = quickNodeId ? state.file?.nodes[quickNodeId] : undefined
  if (!frame || !state.file || !state.pageId
    || frame.key.fileId !== state.file.fileId
    || frame.key.pageId !== state.pageId
    || frame.key.fileRevision !== state.file.revision
    || frame.key.layoutGeneration !== state.layoutGeneration
    || frame.key.selection.length !== state.selection.length
    || !frame.key.selection.every((id, index) => state.selection[index] === id)) return null
  const mobileQuickActionsEligible = projections === canvasHudProjectionService && documents === documentStore
    && quickNodeId && quickNode && quickNode.type !== 'root'
    && !state.readOnly && !nodeIsLocked(state.file, quickNodeId)
  const mobileQuickActions = quickNode && shouldMountMobileQuickActions(frame, Boolean(mobileQuickActionsEligible))
    ? <MobileQuickActionsLayer id={quickNode.id} tool={state.tool} />
    : null

  const capture = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.addEventListener('lostpointercapture', () => cancelActiveGestureAfterCaptureLoss(), { once: true })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const release = (event: PointerEvent<HTMLButtonElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }
  const handlers = {
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => canvasGestures.pointerMove(event),
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerUp(event); release(event) },
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerCancel(event); release(event) },
  }
  const selected = frame.entries.find(entry => entry.policy.selected)
  const renaming = state.renaming ? frame.byNodeId[state.renaming] : undefined
  const editableLabels = frame.entries.filter(entry => entry.policy.showLabel && !entry.policy.readOnly && !entry.policy.locked && renaming?.nodeId !== entry.nodeId)
  const namePose = renaming && renaming.kind !== 'text' && !renaming.policy.readOnly && !renaming.policy.locked
    ? { x: renaming.label.origin.x, y: renaming.label.origin.y, width: renaming.label.maxWidth, angle: renaming.label.angle }
    : null
  const controls = selected?.policy.showHandles && state.renaming === null ? resizeHandlePoses(selected) : []
  const rotationControls = selected?.policy.showHandles && state.renaming === null && !frame.key.mobile ? rotationHandlePoses(selected) : []

  return <><CanvasHud generation={projection.generation}>
    {editableLabels.map(entry => <NodeLabel key={entry.nodeId} id={entry.nodeId} pose={{ x: entry.label.origin.x, y: entry.label.origin.y, width: entry.label.maxWidth, angle: entry.label.angle }} name={entry.name} selected={entry.policy.selected} locked={false} onPointerDown={event => { if (canvasGestures.labelPointerDown(event, entry.nodeId)) capture(event) }} {...handlers} onDoubleClick={() => documentStore.setRenaming(entry.nodeId)} />)}
    {selected && controls.length > 0 && <ResizeHandles id={selected.nodeId} generation={projection.generation} poses={controls} labelFor={handle => copy.resizeHandle(selected.name, handle)} onHandlePointerDown={(event, handle) => { if (canvasGestures.handlePointerDown(event, selected.nodeId, handle)) capture(event) }} onHandleDoubleClick={(event, handle) => { event.preventDefault(); event.stopPropagation(); canvasGestures.handleDoubleClick(selected.nodeId, handle, event.altKey) }} {...handlers} />}
    {selected && rotationControls.length > 0 && <RotationHandles id={selected.nodeId} generation={projection.generation} poses={rotationControls} labelFor={handle => copy.rotationHandle(selected.name, handle)} onHandlePointerDown={(event, handle) => { if (canvasGestures.rotationPointerDown(event, selected.nodeId, handle)) capture(event) }} {...handlers} />}
    {renaming && namePose && <NodeNameEditor id={renaming.nodeId} pose={namePose} value={renaming.name} label={copy.renameLabel(renaming.name)} onCommit={value => { documentStore.commands.rename(renaming.nodeId, value); documentStore.setRenaming(null) }} onCancel={() => documentStore.setRenaming(null)} />}
  </CanvasHud>{mobileQuickActions}</>
}
