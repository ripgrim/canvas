import { documentStore } from './document-store'
import type { DocumentState } from './document-store'
import { canvasHudProjectionService } from './canvas-hud-projection-service'
import { currentHudProjectionFrame, currentHudProjectionSnapshot } from './canvas-hud-projection-service'
import type { CanvasHudProjectionSnapshot } from './canvas-hud-projection-service'
import type { HudFlowDragProjection, HudProjectionFrame, HudQuad } from './canvas-hud-projection'
import { editorMobileBreakpoint } from './mobile-editor'
import { worldRectToScreen, worldToScreen } from './canvas-math'
import type { Rect } from './canvas-math'

export type PaintedHud = {
  projectionGeneration: number
  projectionFrame: HudProjectionFrame | null
  selected: Record<string, Rect>
  quads: Record<string, HudQuad>
  hover: string | null
  handles: string | null
  effectiveHandle: string | null
  flowDragIdentity: HudFlowDragProjection['identity'] | null
  flowMovingVisualOwner: 'preview-runtime' | null
}

/** Screen-space selection chrome measured from Paper's canvas renderer. */
export const canvasHudChrome = {
  outlineWidth: 1,
  handleSize: 7,
  badgeHeight: 20,
  badgePaddingX: 6,
  badgeRadius: 3,
} as const

export const canvasHudChromeForViewport = (width: number) => width <= editorMobileBreakpoint
  ? { ...canvasHudChrome, outlineWidth: 2, handleSize: 12 }
  : canvasHudChrome

/** Selects one coherent publication before any Canvas2D chrome reads it. */
export const canvasHudPaintProjection = (observed: CanvasHudProjectionSnapshot, current: CanvasHudProjectionSnapshot): CanvasHudProjectionSnapshot => currentHudProjectionSnapshot(observed, current)
  ?? Object.freeze({ generation: current.generation, frame: null })

const roundHudDimension = (value: number) => String(Math.round(value * 100) / 100)
export const formatHudDimensions = (width: number, height: number) => `${roundHudDimension(width)}\u2004\u00d7\u2004${roundHudDimension(height)}`

/** The projector owns the badge anchor; text measurement only determines its rendered width. */
export const selectionBadgeRect = (anchor: Readonly<{ x: number; y: number }>, textWidth: number): Rect => {
  const width = Math.ceil(textWidth) + canvasHudChrome.badgePaddingX * 2
  return { x: anchor.x - width / 2, y: anchor.y, width, height: canvasHudChrome.badgeHeight }
}

type HudPalette = Readonly<{
  selection: string
  guide: string
  surface: string
  contrast: string
  muted: string
  font: string
  dataFont: string
  labelSize: string
  badgeSize: string
  regularWeight: string
  mediumWeight: string
  dataWeight: string
}>

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

const roundedRect = (context: CanvasRenderingContext2D, rect: Rect, radius: number) => {
  context.beginPath()
  context.roundRect(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height), radius)
}

const fitText = (context: CanvasRenderingContext2D, text: string, width: number) => {
  if (context.measureText(text).width <= width) return text
  let end = text.length
  while (end > 1 && context.measureText(`${text.slice(0, end)}…`).width > width) end -= 1
  return `${text.slice(0, end)}…`
}

/** Paints only literal projector poses. It never reconstructs node geometry from scene rectangles or transforms. */
export function paintProjectedHud(
  context: CanvasRenderingContext2D,
  projection: CanvasHudProjectionSnapshot,
  palette: HudPalette,
  renaming: string | null,
  transientKind: string | null,
  currentProjection: CanvasHudProjectionSnapshot = projection,
): PaintedHud {
  const frame = currentHudProjectionFrame(projection, currentProjection)
  const painted: PaintedHud = {
    projectionGeneration: projection.generation,
    projectionFrame: frame,
    selected: {},
    quads: {},
    hover: null,
    handles: null,
    effectiveHandle: null,
    flowDragIdentity: null,
    flowMovingVisualOwner: null,
  }
  if (!frame) return painted
  painted.flowDragIdentity = frame.flowDrag?.identity ?? null
  painted.flowMovingVisualOwner = frame.flowDrag?.movingVisualOwner ?? null
  const outlineWidth = frame.key.mobile ? 2 : canvasHudChrome.outlineWidth

  context.save()
  context.textBaseline = 'bottom'
  for (const entry of frame.entries) {
    if (!entry.policy.showLabel || renaming === entry.nodeId) continue
    context.font = `${entry.policy.selected ? palette.mediumWeight : palette.regularWeight} ${palette.labelSize} ${palette.font}`
    context.fillStyle = entry.policy.selected ? palette.selection : palette.muted
    const label = fitText(context, entry.name, entry.label.maxWidth)
    context.save()
    context.translate(entry.label.origin.x, entry.label.origin.y)
    context.rotate(entry.label.angle)
    context.fillText(label, 0, 0, entry.label.maxWidth)
    context.restore()
  }
  context.restore()

  if (frame.flowDrag) {
    const flow = frame.flowDrag
    context.save()
    context.textBaseline = 'bottom'
    context.font = `${palette.mediumWeight} ${palette.labelSize} ${palette.font}`
    context.fillStyle = palette.selection
    const label = fitText(context, flow.name.text, flow.name.pose.maxWidth)
    context.translate(flow.name.pose.origin.x, flow.name.pose.origin.y)
    context.rotate(flow.name.pose.angle)
    context.fillText(label, 0, 0, flow.name.pose.maxWidth)
    context.restore()
    if (flow.target?.parentOutline) strokeQuad(
      context,
      flow.target.parentOutline.quad,
      flow.target.parentOutline.color,
      flow.target.parentOutline.widthCssPx,
    )
    if (flow.target?.insertionGuide) {
      const guide = flow.target.insertionGuide
      context.save()
      context.strokeStyle = guide.color
      context.lineWidth = guide.widthCssPx
      context.setLineDash([])
      context.beginPath()
      context.moveTo(guide.start.x, guide.start.y)
      context.lineTo(guide.end.x, guide.end.y)
      context.stroke()
      context.restore()
    }
  }

  for (const entry of frame.entries) {
    if (entry.policy.hovered && !entry.policy.selected && transientKind === null) {
      painted.hover = entry.nodeId
      strokeQuad(context, entry.screenQuad, `color-mix(in srgb, ${palette.selection} 60%, transparent)`, outlineWidth)
    }
    if (!entry.policy.selected) continue
    painted.selected[entry.nodeId] = entry.screenAabb
    painted.quads[entry.nodeId] = entry.screenQuad
    if (entry.policy.showOutline) strokeQuad(context, entry.screenQuad, palette.selection, outlineWidth)
  }

  const selected = frame.entries.find(entry => entry.policy.selected)
  if (selected?.policy.showHandles && renaming === null) {
    painted.handles = selected.nodeId
    painted.effectiveHandle = selected.effectiveHandle
    context.save()
    context.lineWidth = outlineWidth
    for (const handle of selected.controls) {
      if (!handle.handle.includes('-')) continue
      context.fillStyle = handle.active ? palette.selection : palette.contrast
      context.strokeStyle = handle.active ? palette.contrast : palette.selection
      context.fillRect(handle.rect.x, handle.rect.y, handle.size, handle.size)
      context.strokeRect(handle.rect.x, handle.rect.y, handle.size, handle.size)
    }
    context.restore()
  }

  if (selected?.policy.showDimensions && renaming === null) {
    const label = formatHudDimensions(selected.dimension.width, selected.dimension.height)
    context.save()
    context.font = `${palette.dataWeight} ${palette.badgeSize} ${palette.dataFont}`
    context.textBaseline = 'middle'
    context.textAlign = 'center'
    const badge = selectionBadgeRect(selected.dimension.anchor, context.measureText(label).width)
    roundedRect(context, badge, canvasHudChrome.badgeRadius)
    context.fillStyle = palette.selection
    context.fill()
    context.fillStyle = palette.contrast
    context.fillText(label, selected.dimension.anchor.x, selected.dimension.anchor.y + canvasHudChrome.badgeHeight / 2)
    context.restore()
  }
  return painted
}

export function createCanvasHudPainter(store = documentStore, projections = canvasHudProjectionService) {
  let canvas: HTMLCanvasElement | null = null
  let observer: ResizeObserver | null = null
  let animationFrame: number | null = null
  let stops: (() => void)[] = []
  const colors = (): HudPalette => {
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
  const strokeRect = (context: CanvasRenderingContext2D, rect: Rect, color: string, width = 1) => {
    context.save()
    context.strokeStyle = color
    context.lineWidth = width
    context.strokeRect(crisp(rect.x), crisp(rect.y), Math.max(0, Math.round(rect.width)), Math.max(0, Math.round(rect.height)))
    context.restore()
  }
  const paint = () => {
    animationFrame = null
    if (!canvas) return
    const state: DocumentState = store.getSnapshot()
    const observedProjection = projections.getSnapshot()
    const currentProjection = projections.getSnapshot()
    const projection = canvasHudPaintProjection(observedProjection, currentProjection)
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    const palette = colors()
    const transient = state.transient
    const outlineWidth = projection.frame?.key.mobile ? 2 : 1

    if (transient?.kind === 'marquee') {
      const screen = worldRectToScreen(transient.rect, state.viewport, state.viewportSize)
      context.save()
      context.fillStyle = `color-mix(in srgb, ${palette.selection} 10%, transparent)`
      context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.round(screen.width), Math.round(screen.height))
      context.restore()
      strokeRect(context, screen, palette.selection, outlineWidth)
    }
    if (transient?.kind === 'move' && !projection.frame?.flowDrag) {
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
        const screen = worldRectToScreen(transient.insertion.rect, state.viewport, state.viewportSize)
        context.save()
        context.fillStyle = palette.selection
        context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.max(2, Math.round(screen.width)), Math.max(2, Math.round(screen.height)))
        context.restore()
      }
      if (transient.targetFrameId) {
        const target = projection.frame?.byNodeId[transient.targetFrameId]
        if (target) strokeQuad(context, target.screenQuad, palette.selection, outlineWidth, [4, 3])
      }
    }
    if (transient?.kind === 'draw') {
      const screen = worldRectToScreen(transient.rect, state.viewport, state.viewportSize)
      context.save()
      context.fillStyle = `color-mix(in srgb, ${palette.surface} 60%, transparent)`
      if (transient.elementKind === 'shape') {
        context.beginPath()
        context.ellipse(screen.x + screen.width / 2, screen.y + screen.height / 2, Math.max(0, screen.width / 2), Math.max(0, screen.height / 2), 0, 0, Math.PI * 2)
        context.fill()
        context.strokeStyle = palette.selection
        context.lineWidth = outlineWidth
        context.stroke()
      } else {
        context.fillRect(Math.round(screen.x), Math.round(screen.y), Math.round(screen.width), Math.round(screen.height))
        context.restore()
        strokeRect(context, screen, palette.selection, outlineWidth)
        context.save()
      }
      context.restore()
    }

    const painted = paintProjectedHud(context, projection, palette, state.renaming, transient?.kind ?? null, projection)
    canvas.dataset.hud = JSON.stringify({
      projectionGeneration: painted.projectionGeneration,
      selected: painted.selected,
      quads: painted.quads,
      hover: painted.hover,
      handles: painted.handles,
      effectiveHandle: painted.effectiveHandle,
      flowDragIdentity: painted.flowDragIdentity,
      flowMovingVisualOwner: painted.flowMovingVisualOwner,
    })
  }
  const schedule = () => { if (canvas && animationFrame === null) animationFrame = requestAnimationFrame(paint) }
  return {
    attach(next: HTMLCanvasElement | null) {
      if (canvas === next) return
      observer?.disconnect()
      canvas = next
      if (canvas) {
        observer = new ResizeObserver(schedule)
        observer.observe(canvas)
        schedule()
      }
    },
    start() {
      if (stops.length) return
      projections.start()
      stops = [store.subscribe(schedule), projections.subscribe(schedule)]
      const onResize = () => schedule()
      window.addEventListener('resize', onResize)
      stops.push(() => window.removeEventListener('resize', onResize))
    },
    stop() {
      for (const stop of stops) stop()
      stops = []
      projections.stop()
      observer?.disconnect()
      observer = null
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
      animationFrame = null
      canvas = null
    },
    repaint: schedule,
  }
}

export const canvasHudPainter = createCanvasHudPainter()
