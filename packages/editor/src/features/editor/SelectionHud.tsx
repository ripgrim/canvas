import { useSyncExternalStore } from 'react'
import type { PointerEvent } from 'react'
import { CanvasHud, MobileSelectionActions, NodeLabel, NodeLabelEditor, ResizeHandles } from '../../design-system/canvas-atoms'
import { Button, Icon } from '../../design-system/atoms'
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
import { mobileQuickActionsPhaseSnapshot, mobileQuickActionsPosition } from './mobile-editor'
import { rotateTransformQuarter } from './layout-commands'

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

function MobileQuickActionsLayer({ id, name, tool, baseRect, viewportSize, geometryForRect, onRotate, onRemove }: { id: string; name: string; tool: ReturnType<typeof documentStore.getSnapshot>['tool']; baseRect: Rect; viewportSize: ReturnType<typeof documentStore.getSnapshot>['viewportSize']; geometryForRect: (rect: Rect) => HudOrientedRect; onRotate: () => void; onRemove: () => void }) {
  const phase = useSyncExternalStore(documentStore.subscribe, mobileQuickActionsPhaseSnapshot, mobileQuickActionsPhaseSnapshot)
  const selection = geometryForRect(baseRect)
  return <MobileSelectionActions label={copy.quickActions} phase={phase} visible={phase === 'idle'} position={mobileQuickActionsPosition(selection.bounds, viewportSize)}><Button label={copy.moveNode} active={tool === 'move'} onClick={() => documentStore.setTool('move')}><Icon name="move" /></Button><Button label={copy.scaleNode} active={tool === 'scale'} onClick={() => documentStore.setTool('scale')}><Icon name="scale" /></Button><Button label={copy.rotateClockwise} onClick={onRotate}><Icon name="refresh" /></Button><Button label={copy.deleteNode(name)} onClick={onRemove}><Icon name="trash" /></Button></MobileSelectionActions>
}

/** DOM keeps only transparent pointer targets and the active inline editor. Visible chrome is Canvas2D. */
export function SelectionHud({ mobile = false }: { mobile?: boolean }) {
  const state = useSyncExternalStore(documentStore.subscribe, hudSnapshot, hudSnapshot)
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  if (!state.file || !state.pageId) return null
  const scene = buildScene(state.file, state.pageId, geometry.nodes)
  const toScreen = (rect: Rect) => worldRectToScreen(rect, state.viewport, state.viewportSize)
  const oriented = (id: string, rect: Rect): HudOrientedRect => nodeHudGeometry(scene.byId.get(id)!, rect, geometry.nodes[id], state.viewport, state.viewportSize)
  const liveRect = (id: string): Rect | null => scene.byId.get(id)?.rect ?? null
  const selected = state.selection.filter(id => scene.byId.has(id))
  const selectedIds = new Set(selected)
  const selectedRects = selected.map(id => liveRect(id)!).filter(Boolean)
  const capture = (event: PointerEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId) }
  const release = (event: PointerEvent<HTMLButtonElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }
  const handlers = {
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => canvasGestures.pointerMove(event),
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerUp(event); release(event) },
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => { canvasGestures.pointerCancel(event); release(event) },
  }
  const roots = scene.nodes.filter(node => node.parentId === null && (node.kind === 'frame' || node.kind === 'component'))
  const selectedNode = selected.length === 1 ? scene.byId.get(selected[0]!) : undefined
  const showHandles = Boolean(selectedNode && !selectedNode.locked && (state.tool === 'move' || state.tool === 'scale') && state.renaming === null)
  const renamingNode = state.renaming ? scene.byId.get(state.renaming) : undefined
  const rotate = () => {
    const id = selected[0]
    const node = id ? state.file?.nodes[id] : undefined
    if (!id || !node || node.type === 'root') return
    if (node.type === 'component') documentStore.commands.layout.set(id, rotateTransformQuarter(node.layout))
    else documentStore.commands.setStyles(id, { rotation: ((node.styles.rotation ?? 0) + 90) % 360 })
  }
  const remove = () => { if (selected[0]) documentStore.commands.delete([selected[0]]) }
  return <><CanvasHud>
    {roots.map(node => {
      const rect = liveRect(node.id) ?? node.rect
      if (renamingNode?.id === node.id) return null
      const face = topHudFace(oriented(node.id, rect).quad)
      const label = { x: face.start.x + face.normal.x * canvasHudChrome.labelGap, y: face.start.y + face.normal.y * canvasHudChrome.labelGap, width: Math.max(48, face.length), angle: face.angle }
      return <NodeLabel key={node.id} id={node.id} pose={label} name={node.name} selected={selectedIds.has(node.id)} locked={node.locked} onPointerDown={event => { if (canvasGestures.labelPointerDown(event, node.id)) capture(event) }} {...handlers} onDoubleClick={() => documentStore.setRenaming(node.id)} />
    })}
    {showHandles && selectedRects[0] && (() => { const selection = oriented(selected[0]!, selectedRects[0]); return <ResizeHandles id={selected[0]!} rect={selection.base} rotation={scene.byId.get(selected[0]!)!.rotation} handles={resizeHandles} labelFor={handle => copy.resizeHandle(scene.byId.get(selected[0]!)!.name, handle)} onHandlePointerDown={(event, handle) => { if (canvasGestures.handlePointerDown(event, selected[0]!, handle as HandleName)) capture(event) }} {...handlers} /> })()}
    {renamingNode && (renamingNode.kind === 'text'
      ? <NodeLabelEditor id={renamingNode.id} rect={toScreen(renamingNode.rect)} value={(() => { const node = state.file!.nodes[renamingNode.id]; return node && node.type === 'text' ? node.text ?? '' : '' })()} label={copy.editText} multiline onCommit={value => { documentStore.commands.setText(renamingNode.id, value); documentStore.setRenaming(null) }} onCancel={() => documentStore.setRenaming(null)} />
      : <NodeLabelEditor id={renamingNode.id} rect={toScreen(renamingNode.rect)} value={renamingNode.name} label={copy.renameLabel(renamingNode.name)} multiline={false} onCommit={value => { documentStore.commands.rename(renamingNode.id, value); documentStore.setRenaming(null) }} onCancel={() => documentStore.setRenaming(null)} />)}
  </CanvasHud>{mobile && showHandles && selectedRects[0] && <MobileQuickActionsLayer id={selected[0]!} name={scene.byId.get(selected[0]!)!.name} tool={state.tool} baseRect={selectedRects[0]} viewportSize={state.viewportSize} geometryForRect={rect => oriented(selected[0]!, rect)} onRotate={rotate} onRemove={remove} />}</>
}
