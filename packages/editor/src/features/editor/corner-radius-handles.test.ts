import { describe, expect, it } from 'vitest'
import type { HudProjectionEntry, HudQuad } from './canvas-hud-projection'
import { cornerRadiusHandlePoses, radiusFromPointer, resolveAmbiguousCorner } from './corner-radius-handles'

const radii = (value: number) => ({ topLeft: value, topRight: value, bottomRight: value, bottomLeft: value })

function entry(screenQuad: HudQuad, dimensions = { width: 100, height: 80 }): HudProjectionEntry {
  const xs = screenQuad.map(point => point.x), ys = screenQuad.map(point => point.y)
  return {
    screenQuad,
    screenAabb: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    dimensions,
  } as HudProjectionEntry
}

describe('AT-CAN-003 canvas corner radius handles', () => {
  it('keeps zero-radius controls twelve screen pixels inside every transformed edge', () => {
    const poses = cornerRadiusHandlePoses(entry([{ x: 10, y: 20 }, { x: 210, y: 20 }, { x: 210, y: 180 }, { x: 10, y: 180 }]), radii(0))
    expect(poses.map(pose => [pose.corner, pose.center])).toEqual([
      ['topLeft', { x: 22, y: 32 }],
      ['topRight', { x: 198, y: 32 }],
      ['bottomRight', { x: 198, y: 168 }],
      ['bottomLeft', { x: 22, y: 168 }],
    ])
    expect(poses[0]?.screenScale).toBeCloseTo(Math.SQRT2 * 2)
  })

  it('follows rotation and converges maximum-radius handles without exceeding half the short side', () => {
    const diamond: HudQuad = [{ x: 100, y: 0 }, { x: 180, y: 80 }, { x: 100, y: 160 }, { x: 20, y: 80 }]
    const poses = cornerRadiusHandlePoses(entry(diamond, { width: 80, height: 80 }), radii(40))
    for (const pose of poses) expect(pose.center).toEqual({ x: 100, y: 80 })
    expect(poses.every(pose => pose.maxRadius === 40)).toBe(true)
  })

  it('hides controls when the selected node is too small on screen', () => {
    expect(cornerRadiusHandlePoses(entry([{ x: 0, y: 0 }, { x: 52, y: 0 }, { x: 52, y: 40 }, { x: 0, y: 40 }]), radii(0))).toEqual([])
  })

  it('resolves a converged pill handle from drag direction after the ambiguity threshold', () => {
    const square = entry([{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }], { width: 80, height: 80 })
    const poses = cornerRadiusHandlePoses(square, radii(40))
    expect(resolveAmbiguousCorner(poses, 'topLeft', { x: 1, y: 1 })).toBe('topLeft')
    expect(resolveAmbiguousCorner(poses, 'topLeft', { x: -10, y: 10 })).toBe('topRight')
  })

  it('projects pointer travel onto the inward bisector, snaps by five, and clamps', () => {
    const pose = cornerRadiusHandlePoses(entry([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]), radii(10))[0]!
    expect(radiusFromPointer(10, { x: 10, y: 10 }, pose, false)).toBeCloseTo(20)
    expect(radiusFromPointer(10, { x: 13, y: 13 }, pose, true)).toBe(25)
    expect(radiusFromPointer(10, { x: -100, y: -100 }, pose, false)).toBe(0)
    expect(radiusFromPointer(10, { x: 100, y: 100 }, pose, false)).toBe(40)
  })
})
