import { useSyncExternalStore } from 'react'
import type { PointerEvent } from 'react'
import { CanvasHud, DimensionBadge, NodeLabel, NodeLabelEditor, ResizeHandles } from '../../design-system/canvas-atoms'
import type { HandleName } from '../../design-system/canvas-atoms'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { buildScene } from './canvas-scene'
import { canvasGestures, resizeHandles } from './canvas-gestures'
import { unionRects, worldRectToScreen } from './canvas-math'
import type { Rect } from './canvas-math'
import { canvasCopy as copy } from './canvas-copy'

/**
 * DOM part of the HUD: text (root labels, dimension badge, inline editors) and transparent handle hit targets.
 * Outlines, marquee, guides and handle visuals are painted by the HUD canvas (canvas-hud-painter).
 */
export function SelectionHud() {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot, documentStore.getSnapshot)
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  if (!state.file || !state.pageId) return null
  const scene = buildScene(state.file, state.pageId, geometry.nodes)
  const toScreen = (rect: Rect) => worldRectToScreen(rect, state.viewport, state.viewportSize)
  const transient = state.transient
  const liveRect = (id: string): Rect | null => (transient?.kind === 'move' || transient?.kind === 'resize' ? transient.rects[id] : undefined) ?? scene.byId.get(id)?.rect ?? null
  const selected = state.selection.filter(id => scene.byId.has(id))
  const selectedRects = selected.map(id => liveRect(id)!).filter(Boolean)
  const union = unionRects(selectedRects)
  const capture = (event: PointerEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId) }
  const release = (event: PointerEvent<HTMLButtonElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }
  const handlers = {
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => canvasGestures.pointerMove(event),
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerUp(event); release(event) },
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerCancel(event); release(event) },
  }
  const roots = scene.nodes.filter(node => node.parentId === null && (node.kind === 'frame' || node.kind === 'component'))
  const showHandles = selected.length === 1 && (state.tool === 'move' || state.tool === 'scale') && (!transient || transient.kind === 'resize') && state.renaming === null
  const renamingNode = state.renaming ? scene.byId.get(state.renaming) : undefined
  const singleSize = selected.length === 1 ? selectedRects[0] : union
  return <CanvasHud>
    {roots.map(node => {
      const rect = liveRect(node.id) ?? node.rect
      if (renamingNode?.id === node.id) return null
      return <NodeLabel key={node.id} id={node.id} rect={toScreen(rect)} name={node.name} selected={selected.includes(node.id)} onPointerDown={event => { if (canvasGestures.labelPointerDown(event, node.id)) capture(event) }} {...handlers} onDoubleClick={() => documentStore.setRenaming(node.id)} />
    })}
    {showHandles && selectedRects[0] && <ResizeHandles id={selected[0]!} rect={toScreen(selectedRects[0])} handles={resizeHandles} labelFor={handle => copy.resizeHandle(scene.byId.get(selected[0]!)!.name, handle)} onHandlePointerDown={(event, handle) => { if (canvasGestures.handlePointerDown(event, selected[0]!, handle as HandleName)) capture(event) }} {...handlers} />}
    {singleSize && selected.length > 0 && state.renaming === null && <DimensionBadge rect={toScreen(singleSize)}>{copy.dimensions(singleSize.width, singleSize.height)}</DimensionBadge>}
    {renamingNode && (renamingNode.kind === 'text'
      ? <NodeLabelEditor id={renamingNode.id} rect={toScreen(renamingNode.rect)} value={(() => { const node = state.file!.nodes[renamingNode.id]; return node && node.type === 'text' ? node.text ?? '' : '' })()} label={copy.editText} multiline onCommit={value => { documentStore.commands.setText(renamingNode.id, value); documentStore.setRenaming(null) }} onCancel={() => documentStore.setRenaming(null)} />
      : <NodeLabelEditor id={renamingNode.id} rect={toScreen(renamingNode.rect)} value={renamingNode.name} label={copy.renameLabel(renamingNode.name)} multiline={false} onCommit={value => { documentStore.commands.rename(renamingNode.id, value); documentStore.setRenaming(null) }} onCancel={() => documentStore.setRenaming(null)} />)}
  </CanvasHud>
}
