/**
 * Camera, grid, zoom, and snapping math for the page canvas.
 *
 * Every pointer, threshold, and HUD value is in CSS pixels. World units are document pixels at 100%.
 * screen = viewportCenter + camera + world * zoom. Constants cite outputs/wonder-canvas-evidence.md.
 */
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

/** Resize from a handle with the opposite side anchored; Alt resizes around the center, Shift keeps the aspect ratio. */
export function resizeRect(start: Rect, handle: string, delta: Point, options: { symmetric: boolean; proportional: boolean; minimum?: number }): Rect {
  const minimum = options.minimum ?? 1
  const horizontal = handle.includes('left') ? -1 : handle.includes('right') ? 1 : 0
  const vertical = handle.includes('top') ? -1 : handle.includes('bottom') ? 1 : 0
  const factor = options.symmetric ? 2 : 1
  let width = Math.max(minimum, start.width + horizontal * delta.x * factor)
  let height = Math.max(minimum, start.height + vertical * delta.y * factor)
  if (options.proportional && horizontal !== 0 && vertical !== 0) {
    const ratio = start.width / Math.max(1, start.height)
    if (Math.abs(delta.x) >= Math.abs(delta.y)) height = Math.max(minimum, width / ratio)
    else width = Math.max(minimum, height * ratio)
  } else if (options.proportional && horizontal !== 0) {
    height = Math.max(minimum, width / (start.width / Math.max(1, start.height)))
  } else if (options.proportional && vertical !== 0) {
    width = Math.max(minimum, height * (start.width / Math.max(1, start.height)))
  }
  let x = start.x
  let y = start.y
  if (options.symmetric) { x = start.x - (width - start.width) / 2; y = start.y - (height - start.height) / 2 }
  else {
    if (horizontal < 0) x = start.x + start.width - width
    if (vertical < 0) y = start.y + start.height - height
    if (options.proportional && horizontal !== 0 && vertical === 0) y = start.y - (height - start.height) / 2
    if (options.proportional && vertical !== 0 && horizontal === 0) x = start.x - (width - start.width) / 2
  }
  return { x, y, width, height }
}

export const roundRect = (rect: Rect): Rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) })
