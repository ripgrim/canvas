import { describe, expect, it } from 'vitest'
import { rotation } from '@canvas/repo-engine/layout-matrix'
import { resizeRectResult, resizeTransformedRectResult } from './canvas-math'

const resizeRotatedRectResult = (start: Parameters<typeof resizeTransformedRectResult>[0], handle: Parameters<typeof resizeTransformedRectResult>[1], delta: Parameters<typeof resizeTransformedRectResult>[2], degrees: number, options: Parameters<typeof resizeTransformedRectResult>[4]) => resizeTransformedRectResult(start, handle, delta, rotation(degrees), options)

const free = { symmetric: false, proportional: false }

describe('PAPER-TEXT-006 Paper-style resize math', () => {
  it('projects a 90-degree right-handle drag onto the local horizontal axis', () => {
    const result = resizeRotatedRectResult({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: 0, y: 20 }, 90, free)
    expect(result.localDelta).toEqual({ x: 20, y: 0 })
    expect(result.rect).toEqual({ x: -10, y: 10, width: 120, height: 50 })
    expect(result.affectedAxes).toEqual(['x'])
    expect(result.effectiveHandle).toBe('right')

    // Negative control: treating the world x delta as local x would leave the node unchanged.
    expect(result.rect).not.toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('keeps the opposite world point fixed for a 180-degree resize', () => {
    const result = resizeRotatedRectResult({ x: 0, y: 0, width: 100, height: 50 }, 'right', { x: -20, y: 0 }, 180, free)
    expect(result.localDelta).toEqual({ x: 20, y: 0 })
    expect(result.rect).toEqual({ x: -20, y: 0, width: 120, height: 50 })
    expect(result.rect.x + result.rect.width).toBe(100)

    // Negative control: anchoring the unrotated left edge would incorrectly keep x=0.
    expect(result.rect.x).not.toBe(0)
  })

  it('uses candidate aspect ratio rather than the larger raw delta for a 4:1 Shift resize', () => {
    const result = resizeRectResult({ x: 0, y: 0, width: 400, height: 100 }, 'bottom-right', { x: 100, y: 40 }, { symmetric: false, proportional: true })
    expect(result.rect).toEqual({ x: 0, y: 0, width: 560, height: 140 })
    expect(result.rect.width / result.rect.height).toBe(4)

    // Negative control for the old abs(dx) >= abs(dy) branch: 500 x 125 misses the pointer's candidate height.
    expect(result.rect).not.toEqual({ x: 0, y: 0, width: 500, height: 125 })
  })

  it('anchors an Alt side resize at the node center', () => {
    const result = resizeRectResult({ x: 10, y: 20, width: 100, height: 50 }, 'right', { x: 15, y: 0 }, { symmetric: true, proportional: false })
    expect(result.rect).toEqual({ x: -5, y: 20, width: 130, height: 50 })
    expect({ x: result.rect.x + result.rect.width / 2, y: result.rect.y + result.rect.height / 2 }).toEqual({ x: 60, y: 45 })

    // Negative control: opposite-side anchoring would produce a 115-wide rectangle at x=10.
    expect(result.rect).not.toEqual({ x: 10, y: 20, width: 115, height: 50 })
  })

  it('crosses an opposite edge and crosses back without a one-pixel dead zone', () => {
    const start = { x: 0, y: 0, width: 100, height: 50 }
    const crossed = resizeRectResult(start, 'right', { x: -125, y: 0 }, free)
    expect(crossed.rect).toEqual({ x: -25, y: 0, width: 25, height: 50 })
    expect(crossed.crossedX).toBe(true)
    expect(crossed.crossedY).toBe(false)
    expect(crossed.effectiveHandle).toBe('left')

    const crossedBack = resizeRectResult(start, 'right', { x: -75, y: 0 }, free)
    expect(crossedBack.rect).toEqual({ x: 0, y: 0, width: 25, height: 50 })
    expect(crossedBack.crossedX).toBe(false)
    expect(crossedBack.effectiveHandle).toBe('right')

    // Negative control for the old clamp: neither side sticks at one pixel after passing the anchor.
    expect(crossed.rect.width).not.toBe(1)
    expect(crossedBack.rect.width).not.toBe(1)
  })

  it('keeps both dimensions positive and flips both handle axes after a corner crossing', () => {
    const result = resizeRectResult({ x: 0, y: 0, width: 100, height: 50 }, 'bottom-right', { x: -130, y: -80 }, free)
    expect(result.rect).toEqual({ x: -30, y: -30, width: 30, height: 30 })
    expect(result.affectedAxes).toEqual(['x', 'y'])
    expect(result.crossedX).toBe(true)
    expect(result.crossedY).toBe(true)
    expect(result.effectiveHandle).toBe('top-left')
    expect(result.rect.width).toBeGreaterThan(0)
    expect(result.rect.height).toBeGreaterThan(0)
  })
})
