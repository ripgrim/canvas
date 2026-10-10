import { useSyncExternalStore } from 'react'
import type { PointerEvent } from 'react'
import { CanvasHud, NodeLabel, NodeLabelEditor, ResizeHandles } from '../../design-system/canvas-atoms'
import type { HandleName } from '../../design-system/canvas-atoms'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { buildScene } from './canvas-scene'
import { canvasGestures, resizeHandles } from './canvas-gestures'
import { worldRectToScreen } from './canvas-math'
import type { Rect } from './canvas-math'
import { canvasCopy as copy } from './canvas-copy'
import { canvasHudChrome, nodeHudGeometry, topHudFace } from './canvas-hud-painter'
import type { HudOrientedRect } from './canvas-hud-painter'

type StaticHudState = Pick<ReturnType<typeof documentStore.getSnapshot>, 'file' | 'pageId' | 'viewport' | 'viewportSize' | 'selection' | 'tool' | 'renaming'>
let cachedSource: ReturnType<typeof documentStore.getSnapshot> | null = null
let cachedHud: StaticHudState | null = null
const hudSnapshot = (): StaticHudState => {
  const source = documentStore.getSnapshot()
  if (cachedSource && cachedHud && cachedSource.file === source.file && cachedSource.pageId === source.pageId && cachedSource.viewport === source.viewport && cachedSource.viewportSize === source.viewportSize && cachedSource.selection === source.selection && cachedSource.tool === source.tool && cachedSource.renaming === source.renaming) return cachedHud
  cachedSource = source
  cachedHud = { file: source.file, pageId: source.pageId, viewport: source.viewport, viewportSize: source.viewportSize, selection: source.selection, tool: source.tool, renaming: source.renaming }
  return cachedHud
}

/** DOM keeps only transparent pointer targets and the active inline editor. Visible chrome is Canvas2D. */
export function SelectionHud() {
  const state = useSyncExternalStore(documentStore.subscribe, hudSnapshot, hudSnapshot)
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  if (!state.file || !state.pageId) return null
  const scene = buildScene(state.file, state.pageId, geometry.nodes)
  const toScreen = (rect: Rect) => worldRectToScreen(rect, state.viewport, state.viewportSize)
  const oriented = (id: string, rect: Rect): HudOrientedRect => nodeHudGeometry(scene.byId.get(id)!, rect, geometry.nodes[id], state.viewport, state.viewportSize)
  const liveRect = (id: string): Rect | null => scene.byId.get(id)?.rect ?? null
  const selected = state.selection.filter(id => scene.byId.has(id))
  const selectedRects = selected.map(id => liveRect(id)!).filter(Boolean)
  const capture = (event: PointerEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId) }
  const release = (event: PointerEvent<HTMLButtonElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }
  const handlers = {
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => canvasGestures.pointerMove(event),
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerUp(event); release(event) },
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerCancel(event); release(event) },
  }
  const roots = scene.nodes.filter(node => node.parentId === null && (node.kind === 'frame' || node.kind === 'component'))
  const showHandles = selected.length === 1 && (state.tool === 'move' || state.tool === 'scale') && state.renaming === null
  const renamingNode = state.renaming ? scene.byId.get(state.renaming) : undefined
  return <CanvasHud>
    {roots.map(node => {
      const rect = liveRect(node.id) ?? node.rect
      if (renamingNode?.id === node.id) return null
      const face = topHudFace(oriented(node.id, rect).quad)
      const label = { x: face.start.x + face.normal.x * canvasHudChrome.labelGap, y: face.start.y + face.normal.y * canvasHudChrome.labelGap, width: Math.max(48, face.length), angle: face.angle }
      return <NodeLabel key={node.id} id={node.id} pose={label} name={node.name} selected={selected.includes(node.id)} onPointerDown={event => { if (canvasGestures.labelPointerDown(event, node.id)) capture(event) }} {...handlers} onDoubleClick={() => documentStore.setRenaming(node.id)} />
    })}
    {showHandles && selectedRects[0] && (() => { const selection = oriented(selected[0]!, selectedRects[0]); return <ResizeHandles id={selected[0]!} rect={selection.base} rotation={scene.byId.get(selected[0]!)!.rotation} handles={resizeHandles} labelFor={handle => copy.resizeHandle(scene.byId.get(selected[0]!)!.name, handle)} onHandlePointerDown={(event, handle) => { if (canvasGestures.handlePointerDown(event, selected[0]!, handle as HandleName)) capture(event) }} {...handlers} /> })()}
    {renamingNode && (renamingNode.kind === 'text'
      ? <NodeLabelEditor id={renamingNode.id} rect={toScreen(renamingNode.rect)} value={(() => { const node = state.file!.nodes[renamingNode.id]; return node && node.type === 'text' ? node.text ?? '' : '' })()} label={copy.editText} multiline onCommit={value => { documentStore.commands.setText(renamingNode.id, value); documentStore.setRenaming(null) }} onCancel={() => documentStore.setRenaming(null)} />
      : <NodeLabelEditor id={renamingNode.id} rect={toScreen(renamingNode.rect)} value={renamingNode.name} label={copy.renameLabel(renamingNode.name)} multiline={false} onCommit={value => { documentStore.commands.rename(renamingNode.id, value); documentStore.setRenaming(null) }} onCancel={() => documentStore.setRenaming(null)} />)}
  </CanvasHud>
}
