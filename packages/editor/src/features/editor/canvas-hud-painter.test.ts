import { describe, expect, it, vi } from 'vitest'
import type { HudFlowDragProjection, HudHandlePose, HudProjectionFrame, HudQuad } from './canvas-hud-projection'
import type { CanvasHudProjectionSnapshot } from './canvas-hud-projection-service'
import { canvasHudChrome, canvasHudChromeForViewport, canvasHudPaintProjection, formatHudDimensions, paintProjectedHud, releaseCanvasHudBitmap, selectionBadgeRect } from './canvas-hud-painter'

const screenQuad: HudQuad = [{ x: 470, y: 300 }, { x: 470, y: 440 }, { x: 270, y: 440 }, { x: 270, y: 300 }]
const names = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left'] as const
const anchors = ['q0', 'q0-q1', 'q1', 'q1-q2', 'q2', 'q2-q3', 'q3', 'q3-q0'] as const
const centers = [screenQuad[0], { x: 470, y: 370 }, screenQuad[1], { x: 370, y: 440 }, screenQuad[2], { x: 270, y: 370 }, screenQuad[3], { x: 370, y: 300 }] as const

const frame = (mobile = false, zoom = 2): HudProjectionFrame => {
  const size = mobile ? 12 : 7
  const handles = names.map((handle, index): HudHandlePose => ({
    handle,
    anchor: anchors[index]!,
    center: centers[index]!,
    rect: { x: centers[index]!.x - size / 2, y: centers[index]!.y - size / 2, width: size, height: size },
    size,
    active: handle === 'top-left',
  })) as unknown as HudProjectionFrame['entries'][number]['handles']
  const entry: HudProjectionFrame['entries'][number] = {
    nodeId: 'selected', name: 'Selected', kind: 'rectangle', parentId: null,
    worldQuad: [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }],
    worldAabb: { x: -70, y: 10, width: 100, height: 70 },
    screenQuad, screenAabb: { x: 270, y: 300, width: 200, height: 140 }, dimensions: { width: 35, height: 50 },
    policy: { selected: true, hovered: false, locked: false, readOnly: false, showOutline: true, showLabel: true, showDimensions: true, showHandles: true, showQuickActions: mobile },
    label: { start: screenQuad[3], end: screenQuad[0], normal: { x: 0, y: -1 }, origin: { x: 270, y: 293 }, angle: 0, maxWidth: 200 },
    dimension: { anchor: { x: 370, y: 446 }, width: 35, height: 50 }, handles, controls: handles, effectiveHandle: 'top-left',
  }
  return Object.freeze({
    key: { fileId: 'file', pageId: 'page', fileRevision: 4, measurementRevision: 12, documentRevision: 4, layoutGeneration: 8, camera: { x: 10, y: -20, zoom }, size: { width: 800, height: 600 }, selection: ['selected'], hover: null, tool: 'scale', readOnly: false, mobile },
    entries: [entry], byNodeId: { selected: entry }, flowDrag: null,
  })
}

function context() {
  const target = {
    save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(),
    translate: vi.fn(), rotate: vi.fn(), fillText: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), roundRect: vi.fn(), fill: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    textBaseline: 'alphabetic', textAlign: 'start', font: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
  }
  return target as unknown as CanvasRenderingContext2D & typeof target
}

const palette = { selection: '#f0f', guide: '#f0f', surface: '#fff', contrast: '#fff', muted: '#777', font: 'Inter', dataFont: 'Mono', labelSize: '12px', badgeSize: '11px', regularWeight: '400', mediumWeight: '500', dataWeight: '400' }

function flowFrame(): HudProjectionFrame {
  const base = frame(true)
  const hidden = {
    ...base.byNodeId.selected!,
    policy: { ...base.byNodeId.selected!.policy, showOutline: false, showLabel: false, showDimensions: false, showHandles: false, showQuickActions: false },
    controls: [],
  }
  const flowDrag = {
    kind: 'flow-drag-hud', identity: { interactionId: 'drag-1', gestureGeneration: 3, sampleSequence: 8 },
    retention: { kind: 'active', gestureGeneration: 3, sampleSequence: 8 },
    movingVisualOwner: 'preview-runtime', movingVisualKind: 'fill-ghost', supportCloneOwner: null,
    documentNodeId: 'selected', currentSelectionQuad: screenQuad, currentSelectionAabb: hidden.screenAabb,
    name: { nodeId: 'selected', text: 'Selected', anchor: 'source', quad: screenQuad, pose: { start: screenQuad[3], end: screenQuad[0], normal: { x: 0, y: -1 }, origin: { x: 270, y: 293 }, angle: 0, maxWidth: 200 } },
    target: {
      parentId: 'target',
      parentOutline: { quad: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 80 }, { x: 10, y: 80 }], aabb: { x: 10, y: 20, width: 100, height: 60 }, color: 'oklch(0.67 0.17 258)', widthCssPx: 2 },
      insertionGuide: { start: { x: 48, y: 30 }, end: { x: 48, y: 70 }, color: 'oklch(0.67 0.17 258)', widthCssPx: 4, style: 'solid' },
    },
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
    terminalHold: null,
  } as const satisfies HudFlowDragProjection
  return Object.freeze({ ...base, entries: [hidden], byNodeId: { selected: hidden }, flowDrag })
}

describe('PAPER-FLEX-006-HUD shared Canvas2D HUD consumer', () => {
  it('paints only Paper flow name, target outline, and guide while preview runtime owns the moving visual', () => {
    const projected = flowFrame()
    const snapshot: CanvasHudProjectionSnapshot = Object.freeze({ generation: 12, frame: projected })
    const canvas = context()
    const painted = paintProjectedHud(canvas, snapshot, palette, null, 'move')

    expect(painted.flowDragIdentity).toStrictEqual({ interactionId: 'drag-1', gestureGeneration: 3, sampleSequence: 8 })
    expect(painted.flowMovingVisualOwner).toBe('preview-runtime')
    expect(canvas.fillText).toHaveBeenCalledTimes(1)
    expect(canvas.fillText).toHaveBeenCalledWith('Selected', 0, 0, 200)
    expect(canvas.fillRect).not.toHaveBeenCalled()
    expect(canvas.strokeRect).not.toHaveBeenCalled()
    expect(canvas.moveTo).toHaveBeenCalledWith(10, 20)
    expect(canvas.moveTo).toHaveBeenCalledWith(48, 30)
    expect(canvas.lineTo).toHaveBeenCalledWith(48, 70)
    expect(canvas.strokeStyle).toBe('oklch(0.67 0.17 258)')
    expect(canvas.lineWidth).toBe(4)
  })
  it('keeps Paper-measured outline, handle, and badge geometry in screen pixels', () => {
    expect(canvasHudChrome).toEqual({ outlineWidth: 1, handleSize: 7, badgeHeight: 20, badgePaddingX: 6, badgeRadius: 3 })
    expect(selectionBadgeRect({ x: 370, y: 446 }, 45.2)).toEqual({ x: 341, y: 446, width: 58, height: 20 })
    expect(canvasHudChromeForViewport(390)).toMatchObject({ outlineWidth: 2, handleSize: 12 })
    expect(canvasHudChromeForViewport(1440)).toBe(canvasHudChrome)
  })

  it('uses the literal projected quad, semantic dimensions, and active handle without rect reconstruction', () => {
    const projected = frame()
    const snapshot: CanvasHudProjectionSnapshot = Object.freeze({ generation: 9, frame: projected })
    const canvas = context()
    const painted = paintProjectedHud(canvas, snapshot, palette, null, null)

    expect(painted.projectionFrame).toBe(projected)
    expect(painted.projectionGeneration).toBe(9)
    expect(painted.quads.selected).toBe(screenQuad)
    expect(painted.selected.selected).toBe(projected.byNodeId.selected!.screenAabb)
    expect(painted.effectiveHandle).toBe('top-left')
    expect(canvas.moveTo).toHaveBeenCalledWith(470, 300)
    expect(canvas.lineTo).toHaveBeenCalledWith(470, 440)
    expect(canvas.fillText).toHaveBeenCalledWith('35\u2004\u00d7\u200450', 370, 456)
    expect(canvas.fillRect).toHaveBeenCalledWith(466.5, 296.5, 7, 7)
  })

  it('fails closed for a copied split-generation observation even when its values match', () => {
    const projected = frame()
    const observed: CanvasHudProjectionSnapshot = Object.freeze({ generation: 9, frame: projected })
    const split: CanvasHudProjectionSnapshot = Object.freeze({ generation: 9, frame: projected })
    const canvas = context()
    const wrapperProjection = canvasHudPaintProjection(observed, split)
    const painted = paintProjectedHud(canvas, observed, palette, null, null, split)

    expect(wrapperProjection.frame).toBeNull()
    expect(wrapperProjection.generation).toBe(split.generation)
    expect(painted.projectionFrame).toBeNull()
    expect(canvas.moveTo).not.toHaveBeenCalled()
    expect(canvas.fillRect).not.toHaveBeenCalled()
  })

  it('does not scale visible handles when camera zoom or backing DPR changes', () => {
    for (const [zoom, mobile, expected] of [[0.25, false, 7], [8, false, 7], [0.25, true, 12], [8, true, 12]] as const) {
      const projected = frame(mobile, zoom)
      const snapshot: CanvasHudProjectionSnapshot = Object.freeze({ generation: zoom * 100, frame: projected })
      const canvas = context()
      paintProjectedHud(canvas, snapshot, palette, null, null)
      expect(canvas.fillRect.mock.calls[0]?.slice(2)).toEqual([expected, expected])
    }
  })

  it('uses Paper multiplication typography and preserves useful precision', () => {
    expect(formatHudDimensions(480, 320)).toBe('480\u2004\u00d7\u2004320')
    expect(formatHudDimensions(31.125, 8.004)).toBe('31.13\u2004\u00d7\u20048')
  })

  it('AT-PERF-001 clears the retired bitmap before Chromium can retain its desktop compositor surface', () => {
    const clearRect = vi.fn()
    const canvas = {
      width: 2400,
      height: 1600,
      dataset: { hud: '{"selected":{}}' },
      getContext: vi.fn(() => ({ clearRect })),
    } as unknown as HTMLCanvasElement

    releaseCanvasHudBitmap(canvas)

    expect(clearRect).toHaveBeenCalledWith(0, 0, 2400, 1600)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(canvas.dataset.hud).toBeUndefined()
  })
})
