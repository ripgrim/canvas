import { documentStore } from './document-store'
import type { DocumentState } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { buildScene } from './canvas-scene'
import { handleSizeCss, unionRects, worldRectToScreen, worldToScreen } from './canvas-math'
import type { Camera, Point, Rect, Size } from './canvas-math'
import type { SceneNode } from './canvas-scene'
import type { MeasuredNode } from './scene-geometry'

/**
 * Paints selection, hover, marquee, snap, insertion, draw-preview, and handle visuals on one 2D canvas.
 * Strokes are crisp 1 px lines in CSS pixels; the backing store scales with devicePixelRatio, pointers never do.
 * DOM keeps only text (labels, badge, editors) and transparent hit targets.
 */
export type PaintedHud = { selected: Record<string, Rect>; quads: Record<string, HudQuad>; hover: string | null; handles: string | null }
export type HudQuad = readonly [Point, Point, Point, Point]
export type HudFace = { start: Point; end: Point; normal: Point; angle: number; length: number }
export type HudOrientedRect = { bounds: Rect; base: Rect; quad: HudQuad }

/** Screen-space selection chrome measured from Paper's canvas renderer. */
export const canvasHudChrome = {
  outlineWidth: 1,
  handleSize: handleSizeCss,
  labelGap: 7,
  badgeGap: 6,
  badgeHeight: 20,
  badgePaddingX: 6,
  badgeRadius: 3,
} as const

export const canvasHudChromeForViewport = (width: number) => width <= 760 ? { ...canvasHudChrome, outlineWidth: 2, handleSize: 12 } : canvasHudChrome

const roundHudDimension = (value: number) => String(Math.round(value * 100) / 100)
export const formatHudDimensions = (width: number, height: number) => `${roundHudDimension(width)}\u2004\u00d7\u2004${roundHudDimension(height)}`
export const selectionBadgeRect = (selection: Rect, textWidth: number): Rect => {
  const width = Math.ceil(textWidth) + canvasHudChrome.badgePaddingX * 2
  return {
    x: selection.x + selection.width / 2 - width / 2,
    y: selection.y + selection.height + canvasHudChrome.badgeGap,
    width,
    height: canvasHudChrome.badgeHeight,
  }
}

/** Four screen-space corners rotated clockwise around the box center. */
export function rotatedRectQuad(rect: Rect, rotation: number): HudQuad {
  const radians = rotation * Math.PI / 180
  const cosine = Math.cos(radians), sine = Math.sin(radians)
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  const rotate = (point: Point): Point => {
    const x = point.x - center.x, y = point.y - center.y
    return { x: center.x + x * cosine - y * sine, y: center.y + x * sine + y * cosine }
  }
  return [rotate({ x: rect.x, y: rect.y }), rotate({ x: rect.x + rect.width, y: rect.y }), rotate({ x: rect.x + rect.width, y: rect.y + rect.height }), rotate({ x: rect.x, y: rect.y + rect.height })]
}

export function quadBounds(quad: HudQuad): Rect {
  const xs = quad.map(point => point.x), ys = quad.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** One source of truth for painter geometry and the transparent DOM hit targets. */
export function nodeHudGeometry(node: SceneNode, rect: Rect, measurement: MeasuredNode | undefined, viewport: Camera, viewportSize: Size): HudOrientedRect {
  const bounds = worldRectToScreen(rect, viewport, viewportSize)
  if (!node.rotation) return { bounds, base: bounds, quad: rotatedRectQuad(bounds, 0) }
  const matrix = node.kind === 'component' ? measurement?.transform : undefined
  const scaleX = matrix ? Math.hypot(matrix[0], matrix[1]) : 1
  const scaleY = matrix ? Math.hypot(matrix[2], matrix[3]) : 1
  const baseWidth = node.kind === 'component' && measurement?.offset ? measurement.offset.width * viewport.zoom * scaleX : bounds.width
  const baseHeight = node.kind === 'component' && measurement?.offset ? measurement.offset.height * viewport.zoom * scaleY : bounds.height
  const base = { x: bounds.x + (bounds.width - baseWidth) / 2, y: bounds.y + (bounds.height - baseHeight) / 2, width: baseWidth, height: baseHeight }
  const quad = rotatedRectQuad(base, node.rotation)
  return { bounds: quadBounds(quad), base, quad }
}

/** Face whose outward normal points furthest upward; its direction is normalized for readable text. */
export function topHudFace(quad: HudQuad): HudFace {
  const faces = quad.map((start, index) => {
    const end = quad[(index + 1) % quad.length]!
    const dx = end.x - start.x, dy = end.y - start.y
    const length = Math.hypot(dx, dy) || 1
    return { start, end, normal: { x: dy / length, y: -dx / length }, angle: Math.atan2(dy, dx), length }
  })
  const face = faces.reduce((top, candidate) => candidate.normal.y < top.normal.y ? candidate : top)
  if (Math.cos(face.angle) >= 0) return face
  return { ...face, start: face.end, end: face.start, angle: face.angle > 0 ? face.angle - Math.PI : face.angle + Math.PI }
}

export function createCanvasHudPainter(store = documentStore, geometry = sceneGeometry) {
  let canvas: HTMLCanvasElement | null = null
  let observer: ResizeObserver | null = null
  let frame: number | null = null
  let stops: (() => void)[] = []
  const colors = () => {
    const root = canvas?.closest('.editor-root') ?? document.querySelector('.editor-root')
    const style = root ? getComputedStyle(root) : null
    const read = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback
    return {
      selection: read('--color-4', '#e864ff'),
      guide: read('--color-4', '#e864ff'),
      surface: read('--neutral-1', '#ffffff'),
      contrast: read('--cte-accent-text', '#ffffff'),
      muted: read('--cte-text-muted', '#6c6c6c'),
      font: read('--font-ui', 'system-ui'),
      dataFont: read('--font-data', 'monospace'),
      labelSize: read('--size-xs', '12px'),
      badgeSize: read('--size-xxs', '11px'),
      regularWeight: read('--weight-ui-regular', '400'),
      mediumWeight: read('--weight-ui-medium', '500'),
      dataWeight: read('--weight-data-regular', '400'),
    }
  }
  const crisp = (value: number) => Math.round(value) + 0.5
  const strokeRect = (context: CanvasRenderingContext2D, rect: Rect, color: string, width = 1, dash: number[] = []) => {
    context.save()
    context.strokeStyle = color
    context.lineWidth = width
    context.setLineDash(dash)
    context.strokeRect(crisp(rect.x), crisp(rect.y), Math.max(0, Math.round(rect.width)), Math.max(0, Math.round(rect.height)))
    context.restore()
  }
  const strokeQuad = (context: CanvasRenderingContext2D, quad: HudQuad, color: string, width = 1, dash: number[] = []) => {
    context.save()
    context.strokeStyle = color
    context.lineWidth = width
    context.setLineDash(dash)
    context.beginPath()
    context.moveTo(quad[0].x, quad[0].y)
    for (const point of quad.slice(1)) context.lineTo(point.x, point.y)
    context.closePath()
    context.stroke()
    context.restore()
  }
  const roundedRect = (context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) => {
    context.beginPath()
    context.roundRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height), radius)
  }
  const fitText = (context: CanvasRenderingContext2D, text: string, width: number) => {
    if (context.measureText(text).width <= width) return text
    let end = text.length
    while (end > 1 && context.measureText(`${text.slice(0, end)}…`).width > width) end -= 1
    return `${text.slice(0, end)}…`
  }
  const paint = () => {
    frame = null
    if (!canvas) return
    const state: DocumentState = store.getSnapshot()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const chrome = canvasHudChromeForViewport(width)
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr) }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    const painted: PaintedHud = { selected: {}, quads: {}, hover: null, handles: null }
    if (!state.file || !state.pageId) { canvas.dataset.hud = JSON.stringify(painted); return }
    const palette = colors()
    const scene = buildScene(state.file, state.pageId, geometry.getSnapshot().nodes)
    const measured = geometry.getSnapshot().nodes
    const toScreen = (rect: Rect) => worldRectToScreen(rect, state.viewport, state.viewportSize)
    const oriented = (node: SceneNode, rect: Rect) => nodeHudGeometry(node, rect, measured[node.id], state.viewport, state.viewportSize)
    const transient = state.transient
    const moving = transient?.kind === 'move'
    const liveRect = (id: string): Rect | null => (transient?.kind === 'move' || transient?.kind === 'resize' ? transient.rects[id] : undefined) ?? scene.byId.get(id)?.rect ?? null
    const selected = state.selection.filter(id => scene.byId.has(id))
    const selectedIds = new Set(selected)
    context.save()
    context.textBaseline = 'bottom'
    for (const node of scene.nodes.filter(candidate => candidate.parentId === null && (candidate.kind === 'frame' || candidate.kind === 'component'))) {
      if (state.renaming === node.id) continue
      if (moving && selectedIds.has(node.id)) continue
      const rect = liveRect(node.id) ?? node.rect
      const screen = oriented(node, rect)
      const isSelected = selectedIds.has(node.id)
      context.font = `${isSelected ? palette.mediumWeight : palette.regularWeight} ${palette.labelSize} ${palette.font}`
      context.fillStyle = isSelected ? palette.selection : palette.muted
      const face = topHudFace(screen.quad)
      const label = fitText(context, node.name, Math.max(48, face.length))
      context.save()
      context.translate(face.start.x + face.normal.x * chrome.labelGap, face.start.y + face.normal.y * chrome.labelGap)
      context.rotate(face.angle)
      context.fillText(label, 0, 0, Math.max(48, face.length))
      context.restore()
    }
    context.restore()
    if (state.hover && !selectedIds.has(state.hover) && scene.byId.get(state.hover) && !transient) {
      painted.hover = state.hover
      const node = scene.byId.get(state.hover)!
      strokeQuad(context, oriented(node, node.rect).quad, `color-mix(in srgb, ${palette.selection} 60%, transparent)`)
    }
    if (transient?.kind === 'move' && transient.targetFrameId && scene.byId.get(transient.targetFrameId)) { const node = scene.byId.get(transient.targetFrameId)!; strokeQuad(context, oriented(node, node.rect).quad, palette.selection, chrome.outlineWidth, [4, 3]) }
    const selectedRects: Rect[] = []
    const selectedGeometry: HudOrientedRect[] = []
    if (!moving) {
      for (const id of selected) {
        const rect = liveRect(id)
        if (!rect) continue
        const node = scene.byId.get(id)!
        const screen = oriented(node, rect)
        painted.selected[id] = screen.bounds
        painted.quads[id] = screen.quad
        selectedRects.push(rect)
        selectedGeometry.push(screen)
        strokeQuad(context, screen.quad, palette.selection, chrome.outlineWidth)
      }
    }
    if (selected.length > 1) { const union = unionRects(selectedRects); if (union) strokeRect(context, toScreen(union), `color-mix(in srgb, ${palette.selection} 45%, transparent)`) }
    if (transient?.kind === 'marquee') {
      const screen = toScreen(transient.rect)
      context.save()
      context.fillStyle = `color-mix(in srgb, ${palette.selection} 10%, transparent)`
      context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.round(screen.width), Math.round(screen.height))
      context.restore()
      strokeRect(context, screen, palette.selection, chrome.outlineWidth)
    }
    if (transient?.kind === 'move') {
      context.save()
      context.strokeStyle = palette.guide
      context.lineWidth = 1
      for (const guide of transient.guides) {
        const start = worldToScreen(guide.axis === 'x' ? { x: guide.position, y: guide.start } : { x: guide.start, y: guide.position }, state.viewport, state.viewportSize)
        const end = worldToScreen(guide.axis === 'x' ? { x: guide.position, y: guide.end } : { x: guide.end, y: guide.position }, state.viewport, state.viewportSize)
        context.beginPath()
        if (guide.axis === 'x') { context.moveTo(crisp(start.x), Math.round(start.y)); context.lineTo(crisp(start.x), Math.round(end.y)) }
        else { context.moveTo(Math.round(start.x), crisp(start.y)); context.lineTo(Math.round(end.x), crisp(start.y)) }
        context.stroke()
      }
      context.restore()
      if (transient.insertion) {
        const screen = toScreen(transient.insertion.rect)
        context.save()
        context.fillStyle = palette.selection
        context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.max(2, Math.round(screen.width)), Math.max(2, Math.round(screen.height)))
        context.restore()
      }
    }
    if (transient?.kind === 'draw') {
      const screen = toScreen(transient.rect)
      context.save()
      context.fillStyle = `color-mix(in srgb, ${palette.surface} 60%, transparent)`
      if (transient.elementKind === 'shape') { context.beginPath(); context.ellipse(screen.x + screen.width / 2, screen.y + screen.height / 2, Math.max(0, screen.width / 2), Math.max(0, screen.height / 2), 0, 0, Math.PI * 2); context.fill(); context.strokeStyle = palette.selection; context.lineWidth = chrome.outlineWidth; context.stroke() }
      else { context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.round(screen.width), Math.round(screen.height)); context.restore(); strokeRect(context, screen, palette.selection, chrome.outlineWidth); context.save() }
      context.restore()
    }
    const showHandles = selected.length === 1 && (state.tool === 'move' || state.tool === 'scale') && (!transient || transient.kind === 'resize') && state.renaming === null
    if (showHandles && selectedGeometry[0]) {
      painted.handles = selected[0]!
      const half = chrome.handleSize / 2
      context.save()
      context.fillStyle = palette.contrast
      context.strokeStyle = palette.selection
      context.lineWidth = chrome.outlineWidth
      for (const point of selectedGeometry[0].quad) {
        const left = Math.round(point.x) - half
        const top = Math.round(point.y) - half
        context.fillRect(left, top, chrome.handleSize, chrome.handleSize)
        context.strokeRect(left, top, chrome.handleSize, chrome.handleSize)
      }
      context.restore()
    }
    const selectedUnion = selected.length === 1 ? selectedRects[0] : unionRects(selectedRects)
    if (selectedUnion && state.renaming === null) {
      const screen = toScreen(selectedUnion)
      const label = formatHudDimensions(selectedUnion.width, selectedUnion.height)
      context.save()
      context.font = `${palette.dataWeight} ${palette.badgeSize} ${palette.dataFont}`
      context.textBaseline = 'middle'
      context.textAlign = 'center'
      const badge = selectionBadgeRect(screen, context.measureText(label).width)
      roundedRect(context, badge.x, badge.y, badge.width, badge.height, canvasHudChrome.badgeRadius)
      context.fillStyle = palette.selection
      context.fill()
      context.fillStyle = palette.contrast
      context.fillText(label, Math.round(badge.x + badge.width / 2), Math.round(badge.y + badge.height / 2))
      context.restore()
    }
    canvas.dataset.hud = JSON.stringify(painted)
  }
  const schedule = () => { if (canvas && frame === null) frame = requestAnimationFrame(paint) }
  return {
    attach: (next: HTMLCanvasElement | null) => {
      if (canvas === next) return
      observer?.disconnect()
      canvas = next
      if (canvas) { observer = new ResizeObserver(schedule); observer.observe(canvas); schedule() }
    },
    start: () => {
      if (stops.length) return
      stops = [store.subscribe(schedule), geometry.subscribe(schedule)]
      const onResize = () => schedule()
      window.addEventListener('resize', onResize)
      stops.push(() => window.removeEventListener('resize', onResize))
    },
    stop: () => { for (const stop of stops) stop(); stops = []; observer?.disconnect(); observer = null; if (frame !== null) cancelAnimationFrame(frame); frame = null; canvas = null },
    repaint: schedule,
  }
}
export const canvasHudPainter = createCanvasHudPainter()
