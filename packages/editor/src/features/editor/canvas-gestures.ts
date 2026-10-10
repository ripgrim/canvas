import type { PrimitiveKind } from '@canvas/repo-engine/file-document'
import { childrenOf as fileChildrenOf, pageRoot } from '@canvas/repo-engine/file-document'
import { documentStore } from './document-store'
import type { CanvasTransient, MoveCommit } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { ancestors, buildScene, childrenOf, clickTarget, containingFrameAt, descendants, drillTarget, marqueeTargets, symmetricDifference } from './canvas-scene'
import type { Scene, SceneNode } from './canvas-scene'
import { canvasCreationBounds } from './canvas-drawing'
import { dragThresholdCss, flowInsertIndex, handleDragThresholdCss, normalizeRect, resizeRect, roundRect, screenToWorld, snapRect, snapThresholdCss } from './canvas-math'
import type { Camera, Point, Rect, Size } from './canvas-math'
import { flexInsertIndex } from './flex-reorder'

export type ResizeHandle = 'top-left' | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left'
export const resizeHandles: readonly ResizeHandle[] = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left']
export const creationTools: readonly PrimitiveKind[] = ['frame', 'rectangle', 'shape', 'shader', 'text']

type PointerLike = { pointerId: number; clientX: number; clientY: number; button: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }
type Base = { pointerId: number; startClient: Point; startWorld: Point; camera: Camera; size: Size; scene: Scene; selection: string[]; moved: boolean }
type Gesture =
  | (Base & { kind: 'pan'; startCamera: Camera })
  | (Base & { kind: 'marquee' })
  | (Base & { kind: 'press'; target: SceneNode; dragTarget: SceneNode; deferred: boolean })
  | (Base & { kind: 'move'; ids: string[]; startRects: Record<string, Rect>; flow: { id: string; parentId: string } | null })
  | (Base & { kind: 'draw'; elementKind: PrimitiveKind })
  | (Base & { kind: 'resize'; id: string; handle: ResizeHandle; startRect: Rect })

/**
 * One gesture state machine for selection, marquee, freeform drag, flow reorder, nesting, drawing, resizing, and panning.
 * Every frame derives from the immutable pointer-down snapshot; cancel restores it exactly.
 */
export function createCanvasGestures(store = documentStore, geometry = sceneGeometry) {
  let element: HTMLElement | null = null
  let gesture: Gesture | null = null
  const viewportPoint = (event: Pick<PointerLike, 'clientX' | 'clientY'>): Point => { const rect = element?.getBoundingClientRect(); return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) } }
  const currentScene = () => { const state = store.getSnapshot(); return buildScene(state.file, state.pageId, geometry.getSnapshot().nodes) }
  const snapshot = (event: PointerLike): Base => {
    const state = store.getSnapshot()
    const client = viewportPoint(event)
    return { pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: screenToWorld(client, state.viewport, state.viewportSize), camera: state.viewport, size: state.viewportSize, scene: currentScene(), selection: [...state.selection], moved: false }
  }
  const worldAt = (base: Base, event: Pick<PointerLike, 'clientX' | 'clientY'>) => screenToWorld(viewportPoint(event), base.camera, base.size)
  const distance = (base: Base, event: Pick<PointerLike, 'clientX' | 'clientY'>) => Math.hypot(event.clientX - base.startClient.x, event.clientY - base.startClient.y)
  const deep = (event: Pick<PointerLike, 'ctrlKey' | 'metaKey'>) => event.ctrlKey || event.metaKey
  const movable = (scene: Scene, id: string) => { const node = scene.byId.get(id); return Boolean(node && !node.flow) }
  const setTransient = (transient: CanvasTransient | null) => store.setTransient(transient)
  const finish = () => { gesture = null; setTransient(null) }
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
      if (flex) { store.commands.reorderFlow(current.flow.id, flex.index); return }
      const siblings = childrenOf(current.scene, current.flow.parentId)
      const { index } = flowInsertIndex(worldAt(current, event), siblings, current.flow.id)
      // flowInsertIndex counts positions among the other siblings; reorderFlow expects a position that includes the dragged node.
      const position = siblings.findIndex(sibling => sibling.id === current.flow!.id)
      store.commands.reorderFlow(current.flow.id, position >= 0 && index >= position ? index + 1 : index)
      return
    }
    if (transient?.kind !== 'move') return
    const state = store.getSnapshot()
    const file = state.file
    const root = file && state.pageId ? pageRoot(file, state.pageId) : null
    if (!file || !root) return
    const moves = current.ids.flatMap((id): MoveCommit[] => {
      const rect = transient.rects[id]
      if (!rect) return []
      const node = current.scene.byId.get(id)
      if (!node) return []
      if (node.kind === 'component') return file.relationships[id]?.parentId === root ? [{ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height }] : []
      const parentId = transient.targetFrameId !== null && transient.targetFrameId !== id ? transient.targetFrameId : current.ids.includes(node.parentId ?? '') ? node.parentId ?? null : transient.targetFrameId
      return [{ id, x: rect.x, y: rect.y, parentId: parentId ?? null }]
    })
    store.commands.commitMove(moves)
  }
  const cancel = () => {
    if (!gesture) return
    const current = gesture
    gesture = null
    setTransient(null)
    if (current.kind === 'pan') store.setViewport(current.startCamera)
    else if (current.kind === 'marquee' || current.kind === 'press' || current.kind === 'move') store.selectMany(current.selection)
  }
  return {
    attach: (next: HTMLElement | null) => { element = next },
    get active() { return gesture !== null },
    cancel,
    /** Pointer down on the empty stage or over scene nodes. */
    stagePointerDown: (event: PointerLike): boolean => {
      const state = store.getSnapshot()
      if (!state.file || state.blocked) return false
      if (event.button === 1 || state.tool === 'hand' || state.spaceHeld) { gesture = { ...snapshot(event), kind: 'pan', startCamera: state.viewport }; setTransient({ kind: 'pan' }); return true }
      if (event.button !== 0) return false
      const base = snapshot(event)
      if (creationTools.includes(state.tool as PrimitiveKind)) {
        gesture = { ...base, kind: 'draw', elementKind: state.tool as PrimitiveKind }
        return true
      }
      if (state.tool !== 'move' && state.tool !== 'scale') return false
      const target = clickTarget(base.scene, base.startWorld, state.selection, deep(event))
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
      gesture = { ...base, kind: 'press', target, dragTarget, deferred }
      return true
    },
    /** Pointer down on a root label: Wonder drags the whole root from its label. */
    labelPointerDown: (event: PointerLike, id: string): boolean => {
      const state = store.getSnapshot()
      if (!state.file || state.blocked || event.button !== 0) return false
      const base = snapshot(event)
      const node = base.scene.byId.get(id)
      if (!node) return false
      if (!state.selection.includes(id)) store.select(id, { additive: event.shiftKey })
      gesture = { ...base, kind: 'press', target: node, dragTarget: node, deferred: state.selection.includes(id) }
      return true
    },
    handlePointerDown: (event: PointerLike, id: string, handle: ResizeHandle): boolean => {
      const state = store.getSnapshot()
      if (!state.file || state.blocked || event.button !== 0) return false
      const base = snapshot(event)
      const node = base.scene.byId.get(id)
      if (!node) return false
      gesture = { ...base, kind: 'resize', id, handle, startRect: node.rect }
      return true
    },
    pointerMove: (event: PointerLike) => {
      const current = gesture
      if (!current || current.pointerId !== event.pointerId) {
        const state = store.getSnapshot()
        if (!state.file || state.transient || !['move', 'scale'].includes(state.tool)) { if (state.hover) store.setHover(null); return }
        const scene = currentScene()
        const target = clickTarget(scene, screenToWorld(viewportPoint(event), state.viewport, state.viewportSize), state.selection, deep(event))
        store.setHover(target?.id ?? null)
        return
      }
      if (current.kind === 'pan') { store.setViewport({ ...current.startCamera, x: current.startCamera.x + event.clientX - current.startClient.x, y: current.startCamera.y + event.clientY - current.startClient.y }); return }
      if (current.kind === 'press') {
        if (distance(current, event) < dragThresholdCss) return
        const state = store.getSnapshot()
        const flow = current.dragTarget.flow && current.dragTarget.parentId ? { id: current.dragTarget.id, parentId: current.dragTarget.parentId } : null
        const ids = flow ? [current.dragTarget.id] : (state.selection.includes(current.dragTarget.id) ? state.selection : [current.dragTarget.id]).filter(id => movable(current.scene, id))
        if (!ids.length) return
        gesture = beginMove(current, ids, flow)
        store.setHover(null)
        movePreview(gesture as Extract<Gesture, { kind: 'move' }>, event)
        return
      }
      if (current.kind === 'move') { current.moved = true; movePreview(current, event); return }
      if (current.kind === 'marquee') {
        if (!current.moved && distance(current, event) < dragThresholdCss) return
        current.moved = true
        const brush = normalizeRect(current.startWorld, worldAt(current, event))
        const targets = marqueeTargets(current.scene, brush, deep(event))
        store.selectMany(event.shiftKey ? symmetricDifference(current.selection, targets) : targets)
        setTransient({ kind: 'marquee', rect: brush })
        return
      }
      if (current.kind === 'draw') {
        current.moved = true
        const bounds = canvasCreationBounds(current.elementKind, current.startWorld, worldAt(current, event), current.camera.zoom)
        const target = current.elementKind === 'frame' || true ? containingFrameAt(current.scene, current.startWorld) : null
        setTransient({ kind: 'draw', elementKind: current.elementKind, rect: bounds, targetFrameId: target?.id ?? null })
        return
      }
      if (current.kind === 'resize') {
        if (!current.moved && distance(current, event) < handleDragThresholdCss) return
        current.moved = true
        const world = worldAt(current, event)
        const delta = { x: world.x - current.startWorld.x, y: world.y - current.startWorld.y }
        const rect = roundRect(resizeRect(current.startRect, current.handle, delta, { symmetric: event.altKey, proportional: event.shiftKey }))
        setTransient({ kind: 'resize', rects: { [current.id]: rect } })
      }
    },
    pointerUp: (event: PointerLike) => {
      const current = gesture
      if (!current || current.pointerId !== event.pointerId) return
      gesture = null
      const transient = store.getSnapshot().transient
      if (current.kind === 'press') {
        if (current.deferred) { if (event.shiftKey) store.select(current.target.id, { additive: true }); else store.select(current.target.id) }
      } else if (current.kind === 'marquee') {
        if (!current.moved && !event.shiftKey) store.select(null)
      } else if (current.kind === 'move') {
        if (current.moved) commitMove(current, event)
      } else if (current.kind === 'draw') {
        const bounds = canvasCreationBounds(current.elementKind, current.startWorld, worldAt(current, event), current.camera.zoom)
        const parent = containingFrameAt(current.scene, current.startWorld)
        const local = parent ? { x: bounds.x - parent.rect.x, y: bounds.y - parent.rect.y } : { x: bounds.x, y: bounds.y }
        if (store.commands.insertCanvas(current.elementKind, { ...bounds, ...local, ...(parent ? { parentId: parent.id } : {}) })) store.setTool('move')
      } else if (current.kind === 'resize') {
        if (transient?.kind === 'resize' && transient.rects[current.id]) store.commands.commitResize(current.id, transient.rects[current.id]!)
      }
      setTransient(null)
    },
    pointerCancel: (event: PointerLike) => { if (gesture && gesture.pointerId === event.pointerId) cancel() },
    /** Double-click drills one level deeper; a second double-click on a selected node starts renaming (frames) or text editing. */
    doubleClick: (event: Pick<PointerLike, 'clientX' | 'clientY' | 'ctrlKey' | 'metaKey'>) => {
      const state = store.getSnapshot()
      if (!state.file || !['move', 'scale'].includes(state.tool)) return
      const scene = currentScene()
      const world = screenToWorld(viewportPoint(event), state.viewport, state.viewportSize)
      const target = drillTarget(scene, world, state.selection)
      if (!target) return
      if (state.selection.length === 1 && state.selection[0] === target.id) { if (target.kind === 'text' || target.parentId === null) store.setRenaming(target.id); return }
      store.select(target.id)
    },
  }
}
export const canvasGestures = createCanvasGestures()
