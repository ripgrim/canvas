/**
 * Camera, grid, zoom, and snapping math for the page canvas.
 *
 * Every pointer, threshold, and HUD value is in CSS pixels. World units are document pixels at 100%.
 * screen = viewportCenter + camera + world * zoom. Constants cite outputs/wonder-canvas-evidence.md.
 */
import { apply, invert, isFiniteMatrix } from '@canvas/repo-engine/layout-matrix'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'

export type Camera = { x: number; y: number; zoom: number }
export type Size = { width: number; height: number }
export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }

/** Wonder hosted renderer: zoom presets in percent (constants chunk, `dt`). */
export const zoomPresets: readonly number[] = [5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 20000].map(percent => percent / 100)
export const minZoom = zoomPresets[0]!
/** Wonder hosted renderer: wheel zoom and fit both clamp to a 200x maximum. */
export const maxZoom = 200
/** Wonder hosted renderer: fit pads the union by 5% of its shorter side (constants chunk, `ft`). */
export const fitPaddingRatio = 0.05
/** Wonder hosted renderer: pixel grid shows at 8x and hides below 7.5x (background grid service). */
export const pixelGridShowZoom = 8
export const pixelGridHideZoom = 7.5
/** Wonder hosted renderer: grid alpha 0.4 * 0.8 drawn with one-pixel lines. */
export const pixelGridAlpha = 0.32
/** Wonder hosted renderer: viewport drag threshold 5 CSS pixels; handle drags commit after 3. */
export const dragThresholdCss = 5
export const handleDragThresholdCss = 3
/** Wonder hosted renderer: handle double-tap window. */
export const doubleClickWindowMs = 300
/** Paper production bundle QX=4; Wonder's snap distance was not recoverable (observed correction of 3 px). */
export const snapThresholdCss = 4
/** Paper production bundle SC=7 corner squares; Wonder draws comparable squares but the size was not recoverable. */
export const handleSizeCss = 7
/** Wonder hosted renderer: dimension badge metrics (11 px text, 6/4 padding, radius 4, 10 px below). */
export const badgeOffsetCss = 10
/** Observed in Wonder: arrow nudges 1 px, Shift+arrow 10 px. */
export const nudgeStep = 1
export const nudgeStepLarge = 10

export const clampZoom = (zoom: number) => Math.min(maxZoom, Math.max(minZoom, zoom))

/** Wonder hosted renderer camera chunk: 1.002 ** (-deltaY * (|deltaY| > 25 ? 1 : 8)). */
export function wheelZoomFactor(deltaY: number): number {
  const gain = Math.abs(deltaY) > 25 ? 1 : 8
  return 1.002 ** (-deltaY * gain)
}

/** Wonder hosted renderer: line deltas scroll 20 px, page deltas one viewport height, Shift swaps axes. */
export function wheelPanDelta(wheel: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }, viewportHeight: number): Point {
  const unit = wheel.deltaMode === 1 ? 20 : wheel.deltaMode === 2 ? viewportHeight : 1
  const swap = wheel.shiftKey && Math.abs(wheel.deltaY) > Math.abs(wheel.deltaX)
  return { x: (swap ? wheel.deltaY : wheel.deltaX) * unit, y: (swap ? 0 : wheel.deltaY) * unit }
}

export const worldOrigin = (camera: Camera, size: Size): Point => ({ x: size.width / 2 + camera.x, y: size.height / 2 + camera.y })
export const worldToScreen = (point: Point, camera: Camera, size: Size): Point => { const origin = worldOrigin(camera, size); return { x: origin.x + point.x * camera.zoom, y: origin.y + point.y * camera.zoom } }
export const screenToWorld = (point: Point, camera: Camera, size: Size): Point => { const origin = worldOrigin(camera, size); return { x: (point.x - origin.x) / camera.zoom, y: (point.y - origin.y) / camera.zoom } }
export const worldRectToScreen = (rect: Rect, camera: Camera, size: Size): Rect => { const corner = worldToScreen(rect, camera, size); return { x: corner.x, y: corner.y, width: rect.width * camera.zoom, height: rect.height * camera.zoom } }
export const screenRectToWorld = (rect: Rect, camera: Camera, size: Size): Rect => { const corner = screenToWorld(rect, camera, size); return { x: corner.x, y: corner.y, width: rect.width / camera.zoom, height: rect.height / camera.zoom } }

/** Pointer-anchored zoom: newOrigin = anchor - (anchor - oldOrigin) * ratio. */
export function zoomAtPoint(camera: Camera, nextZoom: number, anchor: Point, size: Size): Camera {
  const zoom = clampZoom(nextZoom)
  const ratio = zoom / camera.zoom
  const origin = worldOrigin(camera, size)
  const nextOrigin = { x: anchor.x - (anchor.x - origin.x) * ratio, y: anchor.y - (anchor.y - origin.y) * ratio }
  return { x: nextOrigin.x - size.width / 2, y: nextOrigin.y - size.height / 2, zoom }
}

/** Wonder hosted renderer camera chunk: step to the nearest preset, then one further in the requested direction. */
export function stepZoom(zoom: number, direction: 'in' | 'out'): number {
  let nearest = 0
  for (let index = 1; index < zoomPresets.length; index++) if (Math.abs(zoomPresets[index]! - zoom) < Math.abs(zoomPresets[nearest]! - zoom)) nearest = index
  let target = nearest
  if (direction === 'in') target = zoom < zoomPresets[nearest]! ? nearest : nearest + 1
  else target = zoom > zoomPresets[nearest]! ? nearest : nearest - 1
  return zoomPresets[Math.max(0, Math.min(target, zoomPresets.length - 1))]!
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  const visible = rects.filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
  if (!visible.length) return null
  const left = Math.min(...visible.map(rect => rect.x))
  const top = Math.min(...visible.map(rect => rect.y))
  const right = Math.max(...visible.map(rect => rect.x + rect.width))
  const bottom = Math.max(...visible.map(rect => rect.y + rect.height))
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Wonder hosted renderer camera chunk: pad by ratio of the shorter side, fit the padded box, center on it. */
export function fitCamera(bounds: Rect, size: Size, ratio = fitPaddingRatio): Camera | null {
  const pad = Math.min(bounds.width, bounds.height) * ratio
  const padded = { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 }
  if (padded.width <= 0 || padded.height <= 0 || size.width <= 0 || size.height <= 0) return null
  const zoom = clampZoom(Math.min(size.width / padded.width, size.height / padded.height))
  const center = { x: padded.x + padded.width / 2, y: padded.y + padded.height / 2 }
  return { x: -center.x * zoom, y: -center.y * zoom, zoom }
}

export function gridVisible(zoom: number, previous: boolean): boolean {
  if (!previous && zoom >= pixelGridShowZoom) return true
  if (previous && zoom < pixelGridHideZoom) return false
  return previous
}

/** World-anchored pixel grid: one cell per world pixel, origin at the projected world origin. */
export function gridBackground(camera: Camera, size: Size, devicePixelRatio: number): { size: string; position: string; lineWidth: string } {
  const origin = worldOrigin(camera, size)
  const modulo = (value: number) => ((value % camera.zoom) + camera.zoom) % camera.zoom
  return { size: `${camera.zoom}px ${camera.zoom}px`, position: `${modulo(origin.x)}px ${modulo(origin.y)}px`, lineWidth: `${1 / Math.max(1, devicePixelRatio)}px` }
}

export const pointInRect = (point: Point, rect: Rect) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
export const rectContains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
export const rectsIntersect = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
export const normalizeRect = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) })

export type SnapGuide = { axis: 'x' | 'y'; position: number; start: number; end: number }
export type SnapResult = { dx: number; dy: number; guides: SnapGuide[] }

/** Edge and center alignment against candidate rects; the smallest correction per axis wins, ties favor the first candidate. */
export function snapRect(moving: Rect, candidates: readonly Rect[], thresholdWorld: number): SnapResult {
  const edges = (rect: Rect, axis: 'x' | 'y') => axis === 'x' ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width] : [rect.y, rect.y + rect.height / 2, rect.y + rect.height]
  const result: SnapResult = { dx: 0, dy: 0, guides: [] }
  for (const axis of ['x', 'y'] as const) {
    let best: { delta: number; position: number; candidate: Rect } | null = null
    for (const candidate of candidates) for (const target of edges(candidate, axis)) for (const own of edges(moving, axis)) {
      const delta = target - own
      if (Math.abs(delta) <= thresholdWorld && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, position: target, candidate }
    }
    if (!best) continue
    if (axis === 'x') result.dx = best.delta
    else result.dy = best.delta
    const span = axis === 'x'
      ? [Math.min(moving.y + result.dy, best.candidate.y), Math.max(moving.y + moving.height + result.dy, best.candidate.y + best.candidate.height)]
      : [Math.min(moving.x + result.dx, best.candidate.x), Math.max(moving.x + moving.width + result.dx, best.candidate.x + best.candidate.width)]
    result.guides.push({ axis, position: best.position, start: span[0]!, end: span[1]! })
  }
  return result
}

/** Sibling-midpoint insertion for flow children: count siblings whose center precedes the pointer along the layout axis. */
export function flowInsertIndex(pointer: Point, siblings: readonly { id: string; rect: Rect }[], draggedId: string): { index: number; axis: 'x' | 'y' } {
  const others = siblings.filter(sibling => sibling.id !== draggedId)
  const centers = others.map(sibling => ({ x: sibling.rect.x + sibling.rect.width / 2, y: sibling.rect.y + sibling.rect.height / 2 }))
  const spread = (axis: 'x' | 'y') => centers.length < 2 ? 0 : Math.max(...centers.map(center => center[axis])) - Math.min(...centers.map(center => center[axis]))
  const axis: 'x' | 'y' = spread('x') > spread('y') ? 'x' : 'y'
  const index = centers.filter(center => center[axis] < pointer[axis]).length
  return { index, axis }
}

export type ResizeAxis = 'x' | 'y'
export type ResizeHandle = 'top-left' | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left'
export type ResizeOptions = { symmetric: boolean; proportional: boolean; minimum?: number }
export type ResizeResult = {
  rect: Rect
  /** Pointer movement after it has been projected onto the node's rotated local axes. */
  localDelta: Point
  /** Axes directly controlled by the original handle. Shift may derive the other dimension too. */
  affectedAxes: readonly ResizeAxis[]
  crossedX: boolean
  crossedY: boolean
  /** Local handle identity after crossing. The rotated HUD makes this the effective visual handle. */
  effectiveHandle: ResizeHandle
}

export type ResizeGesturePhase = 'resize' | 'space-move'
export type ResizeGestureState = Readonly<{
  phase: ResizeGesturePhase
  pointer: Point
  rect: Rect
  nodeTransform: Matrix
  /** Handle used by the current rebased resize origin. */
  handle: ResizeHandle
  /** Handle currently under the pointer after any axis crossings. */
  effectiveHandle: ResizeHandle
  resizeOriginPointer: Point
  resizeOriginRect: Rect
  spaceOriginPointer: Point
  spaceOriginRect: Rect
  /** Alt is sampled once when Space begins; later changes do not replace Paper's chosen rebase anchor. */
  spaceEntrySymmetric: boolean | null
  localDelta: Point
  affectedAxes: readonly ResizeAxis[]
  crossedX: boolean
  crossedY: boolean
}>

export type ResizeGestureSample = Readonly<{
  pointer: Point
  spaceHeld: boolean
  options: ResizeOptions
}>

type ResizeDirection = -1 | 0 | 1

const resizeDirection = (handle: ResizeHandle, negative: string, positive: string): ResizeDirection => handle.includes(negative) ? -1 : handle.includes(positive) ? 1 : 0
const positiveResizeLength = (value: number, minimum: number) => Math.max(minimum, Math.abs(value))

function resizeHandle(horizontal: ResizeDirection, vertical: ResizeDirection): ResizeHandle {
  const x = horizontal < 0 ? 'left' : horizontal > 0 ? 'right' : ''
  const y = vertical < 0 ? 'top' : vertical > 0 ? 'bottom' : ''
  return (y && x ? `${y}-${x}` : y || x) as ResizeHandle
}

/** Exact local handle identity after the dragged side crosses either opposite side. */
export function effectiveResizeHandle(handle: ResizeHandle, crossedX: boolean, crossedY: boolean): ResizeHandle {
  const horizontal = resizeDirection(handle, 'left', 'right')
  const vertical = resizeDirection(handle, 'top', 'bottom')
  const effectiveHorizontal = horizontal === 0 ? 0 : (horizontal * (crossedX ? -1 : 1)) as ResizeDirection
  const effectiveVertical = vertical === 0 ? 0 : (vertical * (crossedY ? -1 : 1)) as ResizeDirection
  return resizeHandle(effectiveHorizontal, effectiveVertical)
}

const linearTransform = (matrix: Matrix): Matrix => [matrix[0], matrix[1], matrix[2], matrix[3], 0, 0]

/** Parent-space center of a visual resize handle after applying the node's full affine linear transform. */
export function resizeHandleCenter(rect: Rect, handle: ResizeHandle, nodeTransform: Matrix): Point {
  const horizontal = resizeDirection(handle, 'left', 'right')
  const vertical = resizeDirection(handle, 'top', 'bottom')
  const local = { x: horizontal * rect.width / 2, y: vertical * rect.height / 2 }
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  const transformed = apply(linearTransform(nodeTransform), local)
  return { x: center.x + transformed.x, y: center.y + transformed.y }
}

function resizeLocalRect(start: Rect, handle: ResizeHandle, localDelta: Point, options: ResizeOptions): ResizeResult {
  const minimum = Math.max(Number.EPSILON, options.minimum ?? Number.EPSILON)
  const horizontal = resizeDirection(handle, 'left', 'right')
  const vertical = resizeDirection(handle, 'top', 'bottom')
  const factor = options.symmetric ? 2 : 1
  const signedWidth = start.width + horizontal * localDelta.x * factor
  const signedHeight = start.height + vertical * localDelta.y * factor
  const crossedX = horizontal !== 0 && signedWidth < 0
  const crossedY = vertical !== 0 && signedHeight < 0
  const effectiveHorizontal = horizontal === 0 ? 0 : (horizontal * (crossedX ? -1 : 1)) as ResizeDirection
  const effectiveVertical = vertical === 0 ? 0 : (vertical * (crossedY ? -1 : 1)) as ResizeDirection
  let width = horizontal === 0 ? start.width : positiveResizeLength(signedWidth, minimum)
  let height = vertical === 0 ? start.height : positiveResizeLength(signedHeight, minimum)

  if (options.proportional && (horizontal !== 0 || vertical !== 0)) {
    const ratio = start.width / Math.max(Number.EPSILON, start.height)
    if (horizontal !== 0 && vertical !== 0) {
      const candidateRatio = width / Math.max(Number.EPSILON, height)
      if (candidateRatio > ratio) height = Math.max(minimum, width / ratio)
      else width = Math.max(minimum, height * ratio)
    } else if (horizontal !== 0) height = Math.max(minimum, width / ratio)
    else width = Math.max(minimum, height * ratio)
  }

  const localCenter = (direction: ResizeDirection, effectiveDirection: ResizeDirection, startLength: number, nextLength: number) => {
    if (direction === 0 || options.symmetric) return 0
    const fixedAnchor = -direction * startLength / 2
    return fixedAnchor + effectiveDirection * nextLength / 2
  }
  const center = {
    x: localCenter(horizontal, effectiveHorizontal, start.width, width),
    y: localCenter(vertical, effectiveVertical, start.height, height),
  }
  const rect = {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  }
  const affectedAxes: readonly ResizeAxis[] = options.proportional && (horizontal !== 0 || vertical !== 0)
    ? ['x', 'y']
    : [...(horizontal === 0 ? [] : ['x'] as const), ...(vertical === 0 ? [] : ['y'] as const)]
  return {
    rect,
    localDelta,
    affectedAxes,
    crossedX,
    crossedY,
    effectiveHandle: effectiveResizeHandle(handle, crossedX, crossedY),
  }
}

/** Detailed unrotated resize state for HUD identity and crossing-aware gesture integration. */
export function resizeRectResult(start: Rect, handle: ResizeHandle, delta: Point, options: ResizeOptions): ResizeResult {
  const localStart = { x: -start.width / 2, y: -start.height / 2, width: start.width, height: start.height }
  const result = resizeLocalRect(localStart, handle, delta, options)
  const startCenter = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
  return { ...result, rect: { ...result.rect, x: startCenter.x + result.rect.x, y: startCenter.y + result.rect.y } }
}

/** Resize from a handle with the opposite side anchored; Alt resizes around the center, Shift keeps the aspect ratio. */
export function resizeRect(start: Rect, handle: ResizeHandle, delta: Point, options: ResizeOptions): Rect {
  return resizeRectResult(start, handle, delta, options).rect
}

/** Detailed affine resize state. Geometry is calculated in node-local axes, then projected back to parent space. */
export function resizeTransformedRectResult(start: Rect, handle: ResizeHandle, delta: Point, nodeTransform: Matrix, options: ResizeOptions): ResizeResult {
  const linear = linearTransform(nodeTransform)
  const inverse = isFiniteMatrix(linear) ? invert(linear) : null
  if (!inverse) throw new Error('Resize transform must be finite and invertible')
  const projectedDelta = apply(inverse, delta)
  const localDelta = {
    x: Math.abs(projectedDelta.x) < 1e-12 ? 0 : projectedDelta.x,
    y: Math.abs(projectedDelta.y) < 1e-12 ? 0 : projectedDelta.y,
  }
  const localStart = { x: -start.width / 2, y: -start.height / 2, width: start.width, height: start.height }
  const result = resizeLocalRect(localStart, handle, localDelta, options)
  const localCenter = { x: result.rect.x + result.rect.width / 2, y: result.rect.y + result.rect.height / 2 }
  const parentCenterShift = apply(linear, localCenter)
  const center = { x: start.x + start.width / 2 + parentCenterShift.x, y: start.y + start.height / 2 + parentCenterShift.y }
  return {
    ...result,
    rect: { x: center.x - result.rect.width / 2, y: center.y - result.rect.height / 2, width: result.rect.width, height: result.rect.height },
  }
}

const axesForHandle = (handle: ResizeHandle): readonly ResizeAxis[] => [
  ...(resizeDirection(handle, 'left', 'right') === 0 ? [] : ['x'] as const),
  ...(resizeDirection(handle, 'top', 'bottom') === 0 ? [] : ['y'] as const),
]

/** Starts the pure resize/Space-move state machine at the pointer-down sample. */
export function beginResizeGesture(start: Rect, handle: ResizeHandle, pointer: Point, nodeTransform: Matrix): ResizeGestureState {
  if (!isFiniteMatrix(linearTransform(nodeTransform))) throw new Error('Resize transform must be finite and invertible')
  return {
    phase: 'resize', pointer, rect: start, nodeTransform: linearTransform(nodeTransform), handle, effectiveHandle: handle,
    resizeOriginPointer: pointer, resizeOriginRect: start,
    spaceOriginPointer: pointer, spaceOriginRect: start,
    spaceEntrySymmetric: null,
    localDelta: { x: 0, y: 0 }, affectedAxes: axesForHandle(handle), crossedX: false, crossedY: false,
  }
}

/**
 * Advances Paper's resize gesture without relying on mutable UI state. Holding Space freezes the current size and
 * translates it in world axes. Releasing Space keeps that exact rectangle and rebases the resize origin, preventing
 * a jump before subsequent local-axis resizing continues.
 */
export function advanceResizeGesture(state: ResizeGestureState, sample: ResizeGestureSample): ResizeGestureState {
  if (sample.spaceHeld) {
    const entering = state.phase === 'resize'
    const originPointer = entering ? state.pointer : state.spaceOriginPointer
    const originRect = entering ? state.rect : state.spaceOriginRect
    const delta = { x: sample.pointer.x - originPointer.x, y: sample.pointer.y - originPointer.y }
    const activeControl = entering ? resizeHandleCenter(state.rect, state.effectiveHandle, state.nodeTransform) : null
    const oppositeControl = entering && sample.options.symmetric
      ? resizeHandleCenter(state.rect, effectiveResizeHandle(state.effectiveHandle, true, true), state.nodeTransform)
      : activeControl
    const resizeOriginPointer = activeControl && oppositeControl
      ? {
          x: state.resizeOriginPointer.x + activeControl.x - oppositeControl.x,
          y: state.resizeOriginPointer.y + activeControl.y - oppositeControl.y,
        }
      : state.resizeOriginPointer
    return {
      ...state,
      phase: 'space-move', pointer: sample.pointer,
      rect: { ...originRect, x: originRect.x + delta.x, y: originRect.y + delta.y },
      spaceOriginPointer: originPointer, spaceOriginRect: originRect,
      resizeOriginPointer,
      spaceEntrySymmetric: entering ? sample.options.symmetric : state.spaceEntrySymmetric,
    }
  }

  if (state.phase === 'space-move') {
    const move = { x: state.pointer.x - state.spaceOriginPointer.x, y: state.pointer.y - state.spaceOriginPointer.y }
    return {
      ...state,
      phase: 'resize', pointer: sample.pointer,
      handle: state.effectiveHandle,
      resizeOriginPointer: { x: state.resizeOriginPointer.x + move.x, y: state.resizeOriginPointer.y + move.y },
      resizeOriginRect: { ...state.resizeOriginRect, x: state.resizeOriginRect.x + move.x, y: state.resizeOriginRect.y + move.y },
      spaceOriginPointer: sample.pointer, spaceOriginRect: state.rect,
      spaceEntrySymmetric: null,
      localDelta: { x: 0, y: 0 }, crossedX: false, crossedY: false,
    }
  }

  const delta = { x: sample.pointer.x - state.resizeOriginPointer.x, y: sample.pointer.y - state.resizeOriginPointer.y }
  const result = resizeTransformedRectResult(state.resizeOriginRect, state.handle, delta, state.nodeTransform, sample.options)
  return {
    ...state,
    pointer: sample.pointer, rect: result.rect, effectiveHandle: result.effectiveHandle,
    localDelta: result.localDelta, affectedAxes: result.affectedAxes,
    crossedX: result.crossedX, crossedY: result.crossedY,
  }
}

export const roundRect = (rect: Rect): Rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) })
