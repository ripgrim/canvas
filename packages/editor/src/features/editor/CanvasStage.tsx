import { useSyncExternalStore } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { CanvasStageSurface } from '../../design-system/canvas-atoms'
import type { StageCursor } from '../../design-system/canvas-atoms'
import { canvasCopy as copy } from './canvas-copy'
import { canvasGestures, creationTools } from './canvas-gestures'
import { documentStore as store } from './document-store'
import type { CanvasElementKind } from '@canvas/repo-engine/document'
import { screenToWorld } from './canvas-math'
import { collaborationService } from '../collaboration/collaboration-service'

/** The single interaction plane over the workspace. The live preview beneath only receives input in Interact mode. */
export function CanvasStage({ active = true, readOnly = false, onOpenContextMenu, onDismissContextMenu }: { active?: boolean; readOnly?: boolean; onOpenContextMenu: (position: { x: number; y: number }) => void; onDismissContextMenu: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const panReady = state.tool === 'hand' || state.spaceHeld
  const cursor: StageCursor = state.transient?.kind === 'pan' ? 'grabbing' : panReady ? 'grab' : creationTools.includes(state.tool as CanvasElementKind) ? 'crosshair' : state.transient?.kind === 'move' ? 'move' : 'default'
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    onDismissContextMenu()
    if (canvasGestures.stagePointerDown(event)) {
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }
  const release = (event: PointerEvent<HTMLDivElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && canvasGestures.active) { event.preventDefault(); event.stopPropagation(); canvasGestures.cancel() }
  }
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (readOnly || !state.file || !state.pageId) return
    const target = canvasGestures.contextMenuTarget(event)
    if (!target) return
    if (!state.selection.includes(target.id)) store.select(target.id)
    onOpenContextMenu({ x: event.clientX, y: event.clientY })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    collaborationService.updateCursor(screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, state.viewport, state.viewportSize))
    canvasGestures.pointerMove(event)
  }
  return <CanvasStageSurface label={copy.stage} cursor={cursor} inactive={!active || state.tool === 'interact' || !state.file} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={event => { canvasGestures.pointerUp(event); release(event) }} onPointerCancel={event => { canvasGestures.pointerCancel(event); release(event) }} onDoubleClick={event => canvasGestures.doubleClick(event)} onContextMenu={onContextMenu} onKeyDown={onKeyDown} />
}
