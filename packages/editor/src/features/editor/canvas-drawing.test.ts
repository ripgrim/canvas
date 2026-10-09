import { describe, expect, it } from 'vitest'
import { canvasCreationBounds, canvasPointFromClient } from './canvas-drawing'

describe('canvas drawing geometry', () => {
  it('converts client coordinates through the rendered canvas bounds and zoom', () => {
    expect(canvasPointFromClient({ x: 460, y: 290 }, { left: 100, top: 50 }, 2)).toEqual({ x: 180, y: 120 })
  })

  it('normalizes a drag in either direction', () => {
    expect(canvasCreationBounds('rectangle', { x: 20, y: 30 }, { x: 160, y: 110 }, 1)).toEqual({ x: 20, y: 30, width: 140, height: 80 })
    expect(canvasCreationBounds('rectangle', { x: 160, y: 110 }, { x: 20, y: 30 }, 1)).toEqual({ x: 20, y: 30, width: 140, height: 80 })
  })

  it('measures the drag threshold in screen pixels at every zoom', () => {
    expect(canvasCreationBounds('frame', { x: 10, y: 20 }, { x: 11, y: 21 }, 2)).toEqual({ x: 10, y: 20, width: 320, height: 240 })
    expect(canvasCreationBounds('frame', { x: 10, y: 20 }, { x: 12, y: 22 }, 2)).toEqual({ x: 10, y: 20, width: 2, height: 2 })
  })
})
