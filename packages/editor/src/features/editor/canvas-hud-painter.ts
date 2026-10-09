import { documentStore } from './document-store'
import type { DocumentState } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { buildScene } from './canvas-scene'
import { handleSizeCss, unionRects, worldRectToScreen, worldToScreen } from './canvas-math'
import type { Rect } from './canvas-math'

/**
 * Paints selection, hover, marquee, snap, insertion, draw-preview, and handle visuals on one 2D canvas.
 * Strokes are crisp 1 px lines in CSS pixels; the backing store scales with devicePixelRatio, pointers never do.
 * DOM keeps only text (labels, badge, editors) and transparent hit targets.
 */
export type PaintedHud = { selected: Record<string, Rect>; hover: string | null; handles: string | null }

export function createCanvasHudPainter(store = documentStore, geometry = sceneGeometry) {
  let canvas: HTMLCanvasElement | null = null
  let observer: ResizeObserver | null = null
  let frame: number | null = null
  let stops: (() => void)[] = []
  const colors = () => {
    const root = canvas?.closest('.editor-root') ?? document.querySelector('.editor-root')
    const style = root ? getComputedStyle(root) : null
    const read = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback
    return { accent: read('--color-1', '#9b4dff'), guide: read('--color-4', '#e864ff'), surface: read('--neutral-1', '#ffffff') }
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
  const paint = () => {
    frame = null
    if (!canvas) return
    const state: DocumentState = store.getSnapshot()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr) }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    const painted: PaintedHud = { selected: {}, hover: null, handles: null }
    if (!state.file || !state.pageId) { canvas.dataset.hud = JSON.stringify(painted); return }
    const palette = colors()
    const scene = buildScene(state.file, state.pageId, geometry.getSnapshot().nodes)
    const toScreen = (rect: Rect) => worldRectToScreen(rect, state.viewport, state.viewportSize)
    const transient = state.transient
    const liveRect = (id: string): Rect | null => (transient?.kind === 'move' || transient?.kind === 'resize' ? transient.rects[id] : undefined) ?? scene.byId.get(id)?.rect ?? null
    const selected = state.selection.filter(id => scene.byId.has(id))
    if (state.hover && !selected.includes(state.hover) && scene.byId.get(state.hover) && !transient) {
      painted.hover = state.hover
      strokeRect(context, toScreen(scene.byId.get(state.hover)!.rect), `color-mix(in srgb, ${palette.accent} 60%, transparent)`)
    }
    if (transient?.kind === 'move' && transient.targetFrameId && scene.byId.get(transient.targetFrameId)) strokeRect(context, toScreen(scene.byId.get(transient.targetFrameId)!.rect), palette.accent, 1, [4, 3])
    const selectedRects: Rect[] = []
    for (const id of selected) {
      const rect = liveRect(id)
      if (!rect) continue
      const screen = toScreen(rect)
      painted.selected[id] = screen
      selectedRects.push(rect)
      strokeRect(context, screen, palette.accent)
    }
    if (selected.length > 1) { const union = unionRects(selectedRects); if (union) strokeRect(context, toScreen(union), `color-mix(in srgb, ${palette.accent} 45%, transparent)`) }
    if (transient?.kind === 'marquee') {
      const screen = toScreen(transient.rect)
      context.save()
      context.fillStyle = `color-mix(in srgb, ${palette.accent} 10%, transparent)`
      context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.round(screen.width), Math.round(screen.height))
      context.restore()
      strokeRect(context, screen, palette.accent)
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
        context.fillStyle = palette.accent
        context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.max(2, Math.round(screen.width)), Math.max(2, Math.round(screen.height)))
        context.restore()
      }
    }
    if (transient?.kind === 'draw') {
      const screen = toScreen(transient.rect)
      context.save()
      context.fillStyle = `color-mix(in srgb, ${palette.surface} 60%, transparent)`
      if (transient.elementKind === 'shape') { context.beginPath(); context.ellipse(screen.x + screen.width / 2, screen.y + screen.height / 2, Math.max(0, screen.width / 2), Math.max(0, screen.height / 2), 0, 0, Math.PI * 2); context.fill(); context.strokeStyle = palette.accent; context.lineWidth = 1; context.stroke() }
      else { context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.round(screen.width), Math.round(screen.height)); context.restore(); strokeRect(context, screen, palette.accent); context.save() }
      context.restore()
    }
    const showHandles = selected.length === 1 && (state.tool === 'move' || state.tool === 'scale') && (!transient || transient.kind === 'resize') && state.renaming === null
    if (showHandles && selectedRects[0]) {
      painted.handles = selected[0]!
      const screen = toScreen(selectedRects[0])
      const half = handleSizeCss / 2
      context.save()
      context.fillStyle = '#ffffff'
      context.strokeStyle = palette.accent
      context.lineWidth = 1
      for (const [x, y] of [[screen.x, screen.y], [screen.x + screen.width, screen.y], [screen.x + screen.width, screen.y + screen.height], [screen.x, screen.y + screen.height]]) {
        const left = Math.round(x! - half) + 0.5
        const top = Math.round(y! - half) + 0.5
        context.fillRect(left, top, handleSizeCss - 1, handleSizeCss - 1)
        context.strokeRect(left, top, handleSizeCss - 1, handleSizeCss - 1)
      }
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
