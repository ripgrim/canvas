import { describe, expect, it } from 'vitest'
import { fitCamera, flowInsertIndex, gridBackground, gridVisible, resizeRect, resizeRotatedRect, screenToWorld, snapRect, stepZoom, wheelPanDelta, wheelZoomFactor, worldToScreen, zoomAtPoint, zoomPresets } from './canvas-math'

const size = { width: 1200, height: 800 }

describe('camera transforms', () => {
  it('maps world and screen through the viewport center and camera offset', () => {
    const camera = { x: 40, y: -20, zoom: 2 }
    expect(worldToScreen({ x: 100, y: -50 }, camera, size)).toEqual({ x: 840, y: 280 })
    expect(screenToWorld({ x: 840, y: 280 }, camera, size)).toEqual({ x: 100, y: -50 })
  })

  it('keeps the world point under the pointer fixed while zooming', () => {
    const camera = { x: 0, y: 0, zoom: 2 }
    const anchor = { x: 800, y: 300 }
    const before = screenToWorld(anchor, camera, size)
    const next = zoomAtPoint(camera, 4, anchor, size)
    expect(next.zoom).toBe(4)
    expect(worldToScreen(before, next, size)).toEqual(anchor)
  })

  it('uses the recovered wheel zoom gain and clamps to the preset range', () => {
    expect(wheelZoomFactor(-10)).toBeCloseTo(1.002 ** 80, 10)
    expect(wheelZoomFactor(100)).toBeCloseTo(1.002 ** -100, 10)
    expect(zoomAtPoint({ x: 0, y: 0, zoom: 0.06 }, 0.0001, { x: 0, y: 0 }, size).zoom).toBe(0.05)
    expect(zoomAtPoint({ x: 0, y: 0, zoom: 150 }, 9999, { x: 0, y: 0 }, size).zoom).toBe(200)
  })

  it('steps through the Wonder zoom presets', () => {
    expect(zoomPresets[0]).toBe(0.05)
    expect(stepZoom(1, 'in')).toBe(2)
    expect(stepZoom(1, 'out')).toBe(0.5)
    expect(stepZoom(1.58, 'in')).toBe(2)
    expect(stepZoom(1.58, 'out')).toBe(1)
    expect(stepZoom(200, 'in')).toBe(200)
  })

  it('scrolls lines as 20 px and swaps axes with Shift', () => {
    expect(wheelPanDelta({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, 800)).toEqual({ x: 0, y: 60 })
    expect(wheelPanDelta({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true }, 800)).toEqual({ x: 40, y: 0 })
  })

  it('fits the padded union without capping at 100% and reproduces the observed 158%', () => {
    const camera = fitCamera({ x: -213, y: -276, width: 400, height: 409 }, { width: 696, height: 870 })!
    expect(Math.round(camera.zoom * 100)).toBe(158)
    const centered = worldToScreen({ x: -213 + 200, y: -276 + 204.5 }, camera, { width: 696, height: 870 })
    expect(centered.x).toBeCloseTo(348, 6)
    expect(centered.y).toBeCloseTo(435, 6)
  })
})

describe('pixel grid', () => {
  it('shows at 8x, keeps showing until 7.5x, and anchors lines to world integers', () => {
    expect(gridVisible(7.9, false)).toBe(false)
    expect(gridVisible(8, false)).toBe(true)
    expect(gridVisible(7.6, true)).toBe(true)
    expect(gridVisible(7.4, true)).toBe(false)
    const background = gridBackground({ x: 13, y: -7, zoom: 10 }, size, 2)
    expect(background.size).toBe('10px 10px')
    expect(background.position).toBe('3px 3px')
    expect(background.lineWidth).toBe('0.5px')
  })
})

describe('snapping, flow insertion, and resizing', () => {
  it('snaps the nearest edge within the threshold and reports a guide across both rects', () => {
    const result = snapRect({ x: 23, y: -158, width: 101, height: 101 }, [{ x: -177, y: -161, width: 101, height: 101 }], 4)
    expect(result.dy).toBe(-3)
    expect(result.dx).toBe(0)
    expect(result.guides).toEqual([{ axis: 'y', position: -161, start: -177, end: 124 }])
    expect(snapRect({ x: 23, y: -150, width: 101, height: 101 }, [{ x: -177, y: -161, width: 101, height: 101 }], 4).guides).toEqual([])
  })

  it('inserts by sibling midpoints along the dominant axis', () => {
    const siblings = [{ id: 'a', rect: { x: 0, y: 0, width: 100, height: 20 } }, { id: 'b', rect: { x: 0, y: 30, width: 100, height: 20 } }, { id: 'c', rect: { x: 0, y: 60, width: 100, height: 20 } }]
    expect(flowInsertIndex({ x: 50, y: 5 }, siblings, 'c')).toEqual({ index: 0, axis: 'y' })
    expect(flowInsertIndex({ x: 50, y: 45 }, siblings, 'a')).toEqual({ index: 1, axis: 'y' })
    expect(flowInsertIndex({ x: 50, y: 95 }, siblings, 'a')).toEqual({ index: 2, axis: 'y' })
  })

  it('anchors the opposite side, mirrors with Alt, and keeps the aspect ratio with Shift', () => {
    const start = { x: 0, y: 0, width: 100, height: 50 }
    expect(resizeRect(start, 'right', { x: 20, y: 0 }, { symmetric: false, proportional: false })).toEqual({ x: 0, y: 0, width: 120, height: 50 })
    expect(resizeRect(start, 'right', { x: 20, y: 0 }, { symmetric: true, proportional: false })).toEqual({ x: -20, y: 0, width: 140, height: 50 })
    expect(resizeRect(start, 'top-left', { x: -10, y: -10 }, { symmetric: false, proportional: false })).toEqual({ x: -10, y: -10, width: 110, height: 60 })
    expect(resizeRect(start, 'bottom-right', { x: 100, y: 0 }, { symmetric: false, proportional: true })).toEqual({ x: 0, y: 0, width: 200, height: 100 })
    expect(resizeRect(start, 'right', { x: 20, y: 0 }, { symmetric: false, proportional: true })).toEqual({ x: 0, y: -5, width: 120, height: 60 })
    expect(resizeRect(start, 'bottom', { x: 0, y: 25 }, { symmetric: false, proportional: true })).toEqual({ x: -25, y: 0, width: 150, height: 75 })
    expect(resizeRect(start, 'right', { x: 20, y: 0 }, { symmetric: true, proportional: true })).toEqual({ x: -20, y: -10, width: 140, height: 70 })
  })

  it('keeps the opposite visual corner fixed while resizing rotated nodes', () => {
    const start = { x: 0, y: 0, width: 100, height: 50 }
    expect(resizeRotatedRect(start, 'top-left', { x: 10, y: 20 }, 180, { symmetric: false, proportional: false })).toEqual({ x: 0, y: 0, width: 110, height: 70 })
    expect(resizeRotatedRect(start, 'top-left', { x: 10, y: -20 }, 90, { symmetric: false, proportional: false })).toEqual({ x: -5, y: -15, width: 120, height: 60 })
  })

  it('keeps the node center fixed for symmetric rotated resize', () => {
    const resized = resizeRotatedRect({ x: 10, y: 20, width: 100, height: 50 }, 'right', { x: 0, y: 20 }, 90, { symmetric: true, proportional: false })
    expect(resized).toEqual({ x: -10, y: 20, width: 140, height: 50 })
    expect({ x: resized.x + resized.width / 2, y: resized.y + resized.height / 2 }).toEqual({ x: 60, y: 45 })
  })
})
