import { useSyncExternalStore } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { CanvasStageSurface } from '../../design-system/canvas-atoms'
import type { StageCursor } from '../../design-system/canvas-atoms'
import { canvasCopy as copy } from './canvas-copy'
import { canvasGestures, creationTools } from './canvas-gestures'
import { documentStore as store } from './document-store'
import type { CanvasElementKind } from '@canvas/repo-engine/document'
import { screenToWorld } from './canvas-math'
import { buildScene, clickTarget } from './canvas-scene'
import { sceneGeometry } from './scene-geometry'
import { hasComponentDrag, readComponentDrag } from './component-drag'
import { componentSyncQueue } from './component-sync-queue'
import { editorStore } from './store'

/** The single interaction plane over the workspace. The live preview beneath only receives input in Interact mode. */
export function CanvasStage({ active = true, onOpenContextMenu, onDismissContextMenu }: { active?: boolean; onOpenContextMenu: (position: { x: number; y: number }) => void; onDismissContextMenu: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const runtime = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().capabilities.runtime, () => editorStore.getSnapshot().capabilities.runtime)
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
    if (!state.file || !state.pageId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const world = screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, state.viewport, state.viewportSize)
    const scene = buildScene(state.file, state.pageId, sceneGeometry.getSnapshot().nodes)
    const target = clickTarget(scene, world, state.selection, event.ctrlKey || event.metaKey)
    if (!target) return
    if (!state.selection.includes(target.id)) store.select(target.id)
    onOpenContextMenu({ x: event.clientX, y: event.clientY })
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasComponentDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasComponentDrag(event.dataTransfer)) return
    event.preventDefault()
    const payload = readComponentDrag(event.dataTransfer)
    if (!payload) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const point = screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, state.viewport, state.viewportSize)
    const inserted = store.commands.insertAt(payload.componentId, point, payload.target)
    if (inserted && runtime === 'browser' && state.file) componentSyncQueue.queueBrowserUse(state.file.fileId, payload.componentId)
  }
  return <CanvasStageSurface label={copy.stage} cursor={cursor} inactive={!active || state.tool === 'interact' || !state.file} onPointerDown={onPointerDown} onPointerMove={event => canvasGestures.pointerMove(event)} onPointerUp={event => { canvasGestures.pointerUp(event); release(event) }} onPointerCancel={event => { canvasGestures.pointerCancel(event); release(event) }} onDoubleClick={event => canvasGestures.doubleClick(event)} onContextMenu={onContextMenu} onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop} />
}
