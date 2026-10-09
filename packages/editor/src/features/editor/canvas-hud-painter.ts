import { documentStore } from './document-store'
import type { DocumentState } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { buildScene } from './canvas-scene'
import { handleSizeCss, unionRects, worldRectToScreen, worldToScreen } from './canvas-math'
import type { Rect } from './canvas-math'
import { canvasCopy as copy } from './canvas-copy'

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
    return { accent: read('--color-1', '#9b4dff'), guide: read('--color-4', '#e864ff'), surface: read('--neutral-1', '#ffffff'), muted: read('--neutral-6', '#7a7a7a'), font: read('--font-ui', 'system-ui') }
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
    const moving = transient?.kind === 'move'
    const liveRect = (id: string): Rect | null => (transient?.kind === 'move' || transient?.kind === 'resize' ? transient.rects[id] : undefined) ?? scene.byId.get(id)?.rect ?? null
    const selected = state.selection.filter(id => scene.byId.has(id))
    context.save()
    context.font = `11px ${palette.font}`
    context.textBaseline = 'bottom'
    for (const node of scene.nodes.filter(candidate => candidate.parentId === null && (candidate.kind === 'frame' || candidate.kind === 'component'))) {
      if (state.renaming === node.id) continue
      if (moving && selected.includes(node.id)) continue
      const rect = liveRect(node.id) ?? node.rect
      const screen = toScreen(rect)
      context.fillStyle = selected.includes(node.id) ? palette.accent : palette.muted
      context.fillText(fitText(context, node.name, Math.max(48, screen.width)), Math.round(screen.x), Math.round(screen.y - 3), Math.max(48, screen.width))
    }
    context.restore()
    if (state.hover && !selected.includes(state.hover) && scene.byId.get(state.hover) && !transient) {
      painted.hover = state.hover
      strokeRect(context, toScreen(scene.byId.get(state.hover)!.rect), `color-mix(in srgb, ${palette.accent} 60%, transparent)`)
    }
    if (transient?.kind === 'move' && transient.targetFrameId && scene.byId.get(transient.targetFrameId)) strokeRect(context, toScreen(scene.byId.get(transient.targetFrameId)!.rect), palette.accent, 1, [4, 3])
    const selectedRects: Rect[] = []
    if (!moving) {
      for (const id of selected) {
        const rect = liveRect(id)
        if (!rect) continue
        const screen = toScreen(rect)
        painted.selected[id] = screen
        selectedRects.push(rect)
        strokeRect(context, screen, palette.accent)
      }
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
    const selectedUnion = selected.length === 1 ? selectedRects[0] : unionRects(selectedRects)
    if (selectedUnion && state.renaming === null) {
      const screen = toScreen(selectedUnion)
      const label = copy.dimensions(selectedUnion.width, selectedUnion.height)
      context.save()
      context.font = `10px ${palette.font}`
      context.textBaseline = 'middle'
      context.textAlign = 'center'
      const badgeWidth = Math.ceil(context.measureText(label).width) + 12
      const x = screen.x + screen.width / 2 - badgeWidth / 2
      const y = screen.y + screen.height + 10
      roundedRect(context, x, y, badgeWidth, 19, 4)
      context.fillStyle = palette.accent
      context.fill()
      context.fillStyle = '#ffffff'
      context.fillText(label, Math.round(x + badgeWidth / 2), Math.round(y + 10))
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
