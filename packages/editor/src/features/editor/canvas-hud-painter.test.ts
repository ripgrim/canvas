import { describe, expect, it } from 'vitest'
import { canvasHudChrome, formatHudDimensions, quadBounds, rotatedRectQuad, selectionBadgeRect, topHudFace } from './canvas-hud-painter'

describe('AT-APP-005 canvas selection chrome', () => {
  it('keeps Paper-measured outline, handle, and badge geometry in screen pixels', () => {
    expect(canvasHudChrome).toMatchObject({
      outlineWidth: 1,
      handleSize: 7,
      labelGap: 7,
      badgeGap: 6,
      badgeHeight: 20,
      badgePaddingX: 6,
      badgeRadius: 3,
    })
    expect(selectionBadgeRect({ x: 100, y: 40, width: 480, height: 320 }, 45.2)).toEqual({
      x: 311,
      y: 366,
      width: 58,
      height: 20,
    })
  })

  it('uses Paper-style multiplication typography and preserves useful precision', () => {
    expect(formatHudDimensions(480, 320)).toBe('480\u2004\u00d7\u2004320')
    expect(formatHudDimensions(31.125, 8.004)).toBe('31.13\u2004\u00d7\u20048')
  })

  it('rotates the outline and moves the readable label to the visually top face', () => {
    const ninety = rotatedRectQuad({ x: 100, y: 100, width: 200, height: 100 }, 90)
    expect(quadBounds(ninety)).toEqual({ x: 150, y: 50, width: 100, height: 200 })
    expect(topHudFace(ninety)).toMatchObject({ start: { x: 150, y: 50 }, end: { x: 250, y: 50 }, normal: { x: 0, y: -1 }, angle: 0, length: 100 })

    const thirty = topHudFace(rotatedRectQuad({ x: 0, y: 0, width: 200, height: 100 }, 30))
    expect(thirty.angle).toBeCloseTo(Math.PI / 6)
    expect(thirty.normal.x).toBeCloseTo(0.5)
    expect(thirty.normal.y).toBeCloseTo(-Math.sqrt(3) / 2)
  })
})
