import { describe, expect, it } from 'vitest'
import { rotation } from '@canvas/repo-engine/layout-matrix'
import { advanceResizeGesture, beginResizeGesture as beginAffineResizeGesture, effectiveResizeHandle, fitCamera, flowInsertIndex, gridBackground, gridVisible, resizeHandleCenter as affineResizeHandleCenter, resizeRect, resizeRectResult, resizeTransformedRectResult, screenToWorld, snapRect, stepZoom, wheelPanDelta, wheelZoomFactor, worldToScreen, zoomAtPoint, zoomPresets } from './canvas-math'

const beginResizeGesture = (start: Parameters<typeof beginAffineResizeGesture>[0], handle: Parameters<typeof beginAffineResizeGesture>[1], pointer: Parameters<typeof beginAffineResizeGesture>[2], degrees: number) => beginAffineResizeGesture(start, handle, pointer, rotation(degrees))
const resizeRotatedRectResult = (start: Parameters<typeof resizeTransformedRectResult>[0], handle: Parameters<typeof resizeTransformedRectResult>[1], delta: Parameters<typeof resizeTransformedRectResult>[2], degrees: number, options: Parameters<typeof resizeTransformedRectResult>[4]) => resizeTransformedRectResult(start, handle, delta, rotation(degrees), options)
const resizeRotatedRect = (...args: Parameters<typeof resizeRotatedRectResult>) => resizeRotatedRectResult(...args).rect
const resizeHandleCenter = (rect: Parameters<typeof affineResizeHandleCenter>[0], handle: Parameters<typeof affineResizeHandleCenter>[1], degrees: number) => affineResizeHandleCenter(rect, handle, rotation(degrees))

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

  it('matches the audited Shift, Alt, and combined right-handle resize rectangles', () => {
    const start = { x: 0, y: 0, width: 100, height: 50 }
    expect(resizeRectResult(start, 'right', { x: 20, y: 0 }, { symmetric: false, proportional: true }).rect).toEqual({ x: 0, y: -5, width: 120, height: 60 })
    expect(resizeRectResult(start, 'right', { x: 20, y: 0 }, { symmetric: true, proportional: false }).rect).toEqual({ x: -20, y: 0, width: 140, height: 50 })
    expect(resizeRectResult(start, 'right', { x: 20, y: 0 }, { symmetric: true, proportional: true }).rect).toEqual({ x: -20, y: -10, width: 140, height: 70 })
  })

  it('freezes size while Space moves, rebases on release, and resumes resize without a jump', () => {
    const options = { symmetric: false, proportional: false }
    let state = beginResizeGesture({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: 0, y: 0 }, 0)
    state = advanceResizeGesture(state, { pointer: { x: 20, y: 0 }, spaceHeld: false, options })
    expect(state.rect).toEqual({ x: 0, y: 0, width: 120, height: 50 })

    state = advanceResizeGesture(state, { pointer: { x: 50, y: 10 }, spaceHeld: true, options })
    expect(state.phase).toBe('space-move')
    expect(state.rect).toEqual({ x: 30, y: 10, width: 120, height: 50 })

    state = advanceResizeGesture(state, { pointer: { x: 50, y: 10 }, spaceHeld: false, options })
    expect(state.phase).toBe('resize')
    expect(state.rect).toEqual({ x: 30, y: 10, width: 120, height: 50 })

    state = advanceResizeGesture(state, { pointer: { x: 60, y: 10 }, spaceHeld: false, options })
    expect(state.rect).toEqual({ x: 30, y: 10, width: 130, height: 50 })
  })

  it('gives Space release precedence over pointer and modifier changes for that frame', () => {
    const plain = { symmetric: false, proportional: false }
    let state = beginResizeGesture({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: 0, y: 0 }, 0)
    state = advanceResizeGesture(state, { pointer: { x: 20, y: 0 }, spaceHeld: false, options: plain })
    state = advanceResizeGesture(state, { pointer: { x: 50, y: 10 }, spaceHeld: true, options: plain })

    state = advanceResizeGesture(state, { pointer: { x: 75, y: 25 }, spaceHeld: false, options: { symmetric: true, proportional: true } })
    expect(state.phase).toBe('resize')
    expect(state.pointer).toEqual({ x: 75, y: 25 })
    expect(state.rect).toEqual({ x: 30, y: 10, width: 120, height: 50 })
    // Mutation control: falling through to Shift+Alt resize on the release frame uses the stale pre-Space origin.
    expect(state.rect).not.toEqual({ x: -75, y: -37.5, width: 250, height: 125 })
  })

  it('keeps affected axes authoritative when Shift is pressed on a Space-release frame', () => {
    const plain = { symmetric: false, proportional: false }
    let state = beginResizeGesture({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: 0, y: 0 }, 0)
    state = advanceResizeGesture(state, { pointer: { x: 20, y: 0 }, spaceHeld: false, options: plain })
    expect(state.affectedAxes).toEqual(['x'])

    state = advanceResizeGesture(state, { pointer: { x: 50, y: 10 }, spaceHeld: true, options: plain })
    expect(state.affectedAxes).toEqual(['x'])

    state = advanceResizeGesture(state, { pointer: { x: 55, y: 15 }, spaceHeld: true, options: { symmetric: false, proportional: true } })
    expect(state.rect).toEqual({ x: 35, y: 15, width: 120, height: 50 })
    expect(state.affectedAxes).toEqual(['x'])

    state = advanceResizeGesture(state, { pointer: { x: 55, y: 15 }, spaceHeld: false, options: { symmetric: false, proportional: true } })
    expect(state.rect).toEqual({ x: 35, y: 15, width: 120, height: 50 })
    expect(state.affectedAxes).toEqual(['x'])

    state = advanceResizeGesture(state, { pointer: { x: 65, y: 15 }, spaceHeld: false, options: { symmetric: false, proportional: true } })
    expect(state.rect).toEqual({ x: 35, y: 7.5, width: 130, height: 65 })
    expect(state.affectedAxes).toEqual(['x', 'y'])
  })

  it('uses the Alt state at Space entry for Paper rebase and ignores Alt toggled after entry', () => {
    const plain = { symmetric: false, proportional: false }
    const symmetric = { symmetric: true, proportional: false }
    const start = { x: 0, y: 0, width: 100, height: 50 }
    const pointerDown = { x: 100, y: 25 }
    const begin = () => advanceResizeGesture(beginResizeGesture(start, 'right', pointerDown, 0), { pointer: { x: 25, y: 25 }, spaceHeld: false, options: plain })

    let enteredWithAlt = advanceResizeGesture(begin(), { pointer: { x: 25, y: 25 }, spaceHeld: true, options: symmetric })
    expect(enteredWithAlt.spaceEntrySymmetric).toBe(true)
    expect(enteredWithAlt.resizeOriginPointer).toEqual({ x: 125, y: 25 })
    enteredWithAlt = advanceResizeGesture(enteredWithAlt, { pointer: { x: 55, y: 35 }, spaceHeld: true, options: plain })
    expect(enteredWithAlt.resizeOriginPointer).toEqual({ x: 125, y: 25 })
    expect(enteredWithAlt.rect).toEqual({ x: 30, y: 10, width: 25, height: 50 })
    const altRelease = advanceResizeGesture(enteredWithAlt, { pointer: { x: 55, y: 35 }, spaceHeld: false, options: symmetric })
    expect(altRelease.resizeOriginPointer).toEqual({ x: 155, y: 35 })
    expect(altRelease.resizeOriginRect).toEqual({ x: 30, y: 10, width: 100, height: 50 })
    expect(advanceResizeGesture(altRelease, { pointer: { x: 65, y: 35 }, spaceHeld: false, options: symmetric }).rect).toEqual({ x: 40, y: 10, width: 80, height: 50 })
    expect(advanceResizeGesture(altRelease, { pointer: { x: 65, y: 35 }, spaceHeld: false, options: plain }).rect).toEqual({ x: 30, y: 10, width: 10, height: 50 })

    let enteredWithoutAlt = advanceResizeGesture(begin(), { pointer: { x: 25, y: 25 }, spaceHeld: true, options: plain })
    expect(enteredWithoutAlt.spaceEntrySymmetric).toBe(false)
    expect(enteredWithoutAlt.resizeOriginPointer).toEqual({ x: 100, y: 25 })
    enteredWithoutAlt = advanceResizeGesture(enteredWithoutAlt, { pointer: { x: 55, y: 35 }, spaceHeld: true, options: symmetric })
    expect(enteredWithoutAlt.resizeOriginPointer).toEqual({ x: 100, y: 25 })
    const plainRelease = advanceResizeGesture(enteredWithoutAlt, { pointer: { x: 55, y: 35 }, spaceHeld: false, options: symmetric })
    expect(plainRelease.resizeOriginPointer).toEqual({ x: 130, y: 35 })
    expect(advanceResizeGesture(plainRelease, { pointer: { x: 65, y: 35 }, spaceHeld: false, options: symmetric }).rect).toEqual({ x: 65, y: 10, width: 30, height: 50 })
    expect(advanceResizeGesture(plainRelease, { pointer: { x: 65, y: 35 }, spaceHeld: false, options: plain }).rect).toEqual({ x: 30, y: 10, width: 35, height: 50 })

    // Mutation control: sampling Alt continuously would make both entry branches share one pointer origin and result.
    expect(altRelease.resizeOriginPointer).not.toEqual(plainRelease.resizeOriginPointer)
  })

  it('projects 90- and 180-degree pointer deltas into local axes', () => {
    const options = { symmetric: false, proportional: false }
    const quarterTurn = resizeRotatedRectResult({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: 0, y: 20 }, 90, options)
    expect(quarterTurn.localDelta.x).toBeCloseTo(20, 12)
    expect(quarterTurn.localDelta.y).toBeCloseTo(0, 12)
    expect(quarterTurn.rect).toEqual({ x: -10, y: 10, width: 120, height: 50 })
    // Mutation control: applying world dx=0 as local x would leave the width at 100.
    expect(quarterTurn.rect.width).not.toBe(100)

    const halfTurn = resizeRotatedRectResult({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: -20, y: 0 }, 180, options)
    expect(halfTurn.localDelta.x).toBeCloseTo(20, 12)
    expect(halfTurn.localDelta.y).toBeCloseTo(0, 12)
    expect(halfTurn.rect).toEqual({ x: -20, y: 0, width: 120, height: 50 })
    // Mutation control: world-space right resize would shrink to 80 instead of growing to 120.
    expect(halfTurn.rect.width).not.toBe(80)
  })

  it('MATRIX-LAYOUT-008 projects scaled and skewed pointer deltas through the full affine inverse', () => {
    const transform = [2, 0, 0.5, 1, 0, 0] as const
    const result = resizeTransformedRectResult({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: 40, y: 0 }, transform, { symmetric: false, proportional: false })
    expect(result.localDelta).toEqual({ x: 20, y: 0 })
    expect(result.rect).toEqual({ x: 10, y: 0, width: 120, height: 50 })
    expect(result.rect.width).not.toBe(140)
  })

  it('maps a crossed handle to the visual side that remains under the pointer', () => {
    const start = { x: 0, y: 0, width: 100, height: 50 }
    const result = resizeRotatedRectResult(start, 'right', { x: 0, y: -125 }, 90, { symmetric: false, proportional: false })
    expect(result.crossedX).toBe(true)
    expect(result.effectiveHandle).toBe('left')
    expect(effectiveResizeHandle('bottom-right', true, true)).toBe('top-left')

    const initialHandle = resizeHandleCenter(start, 'right', 90)
    const pointer = { x: initialHandle.x, y: initialHandle.y - 125 }
    const effectiveCenter = resizeHandleCenter(result.rect, result.effectiveHandle, 90)
    const screenDistanceAtTwoX = Math.hypot(effectiveCenter.x - pointer.x, effectiveCenter.y - pointer.y) * 2
    expect(screenDistanceAtTwoX).toBeLessThanOrEqual(0.5)

    // Mutation control: retaining the original handle after crossing puts the HUD on the opposite side.
    const staleCenter = resizeHandleCenter(result.rect, 'right', 90)
    expect(Math.hypot(staleCenter.x - pointer.x, staleCenter.y - pointer.y) * 2).toBeGreaterThan(0.5)
  })

  it('switches the effective handle within half a CSS pixel of an axis crossing', () => {
    const start = { x: 0, y: 0, width: 100, height: 50 }
    const pointer = { x: -0.25, y: 25 }
    const result = resizeRotatedRectResult(start, 'right', { x: -100.25, y: 0 }, 0, { symmetric: false, proportional: false, minimum: 0.5 })
    expect(result.crossedX).toBe(true)
    expect(result.effectiveHandle).toBe('left')
    expect(result.rect).toEqual({ x: -0.5, y: 0, width: 0.5, height: 50 })
    const effectiveCenter = resizeHandleCenter(result.rect, result.effectiveHandle, 0)
    expect(Math.hypot(effectiveCenter.x - pointer.x, effectiveCenter.y - pointer.y) * 2).toBe(0.5)

    // Mutation control: failing to swap the handle leaves it on the far side of the minimum-size rectangle.
    const staleCenter = resizeHandleCenter(result.rect, 'right', 0)
    expect(Math.hypot(staleCenter.x - pointer.x, staleCenter.y - pointer.y) * 2).toBe(0.5)
    expect(staleCenter.x).not.toBe(effectiveCenter.x)
  })

  it('uses the newest pure sample so a one-unit final pointer change cannot reuse the previous rectangle', () => {
    const options = { symmetric: false, proportional: false }
    let state = beginResizeGesture({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: 0, y: 0 }, 0)
    state = advanceResizeGesture(state, { pointer: { x: 20, y: 0 }, spaceHeld: false, options })
    const penultimate = state.rect
    state = advanceResizeGesture(state, { pointer: { x: 21, y: 0 }, spaceHeld: false, options })
    expect(penultimate).toEqual({ x: 0, y: 0, width: 120, height: 50 })
    expect(state.rect).toEqual({ x: 0, y: 0, width: 121, height: 50 })
    expect(state.rect).not.toEqual(penultimate)
  })
})
