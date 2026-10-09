import { useSyncExternalStore } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { CanvasStageSurface } from '../../design-system/canvas-atoms'
import type { StageCursor } from '../../design-system/canvas-atoms'
import { canvasCopy as copy } from './canvas-copy'
import { canvasGestures, creationTools } from './canvas-gestures'
import { documentStore as store } from './document-store'
import type { CanvasElementKind } from '@canvas/repo-engine/document'

/** The single interaction plane over the workspace. The live preview beneath only receives input in Interact mode. */
export function CanvasStage() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const panReady = state.tool === 'hand' || state.spaceHeld
  const cursor: StageCursor = state.transient?.kind === 'pan' ? 'grabbing' : panReady ? 'grab' : creationTools.includes(state.tool as CanvasElementKind) ? 'crosshair' : state.transient?.kind === 'move' ? 'move' : 'default'
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
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
  return <CanvasStageSurface label={copy.stage} cursor={cursor} inactive={state.tool === 'interact' || !state.file} onPointerDown={onPointerDown} onPointerMove={event => canvasGestures.pointerMove(event)} onPointerUp={event => { canvasGestures.pointerUp(event); release(event) }} onPointerCancel={event => { canvasGestures.pointerCancel(event); release(event) }} onDoubleClick={event => canvasGestures.doubleClick(event)} onKeyDown={onKeyDown} />
}
