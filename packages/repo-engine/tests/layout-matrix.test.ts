import { describe, expect, it } from 'vitest'
import { aboutOrigin, apply, decompose, identity, invert, multiply, parseCssMatrix, reparentLocal, rotation, scaling, translation } from '../src/layout-matrix.js'
import type { Matrix, Point } from '../src/layout-matrix.js'

const expectPoint = (actual: Point, expected: Point, digits = 9) => {
  expect(actual.x).toBeCloseTo(expected.x, digits)
  expect(actual.y).toBeCloseTo(expected.y, digits)
}
/** Elementwise, so a -0 from the inverse formula still matches a hand-written 0. */
const expectMatrix = (actual: Matrix | null, expected: readonly number[], digits = 9) => {
  expect(actual).not.toBeNull()
  expected.forEach((value, index) => expect(actual![index]).toBeCloseTo(value, digits))
}

describe('layout matrices', () => {
  it('LAY-GEST-003: multiply applies the right matrix first (scale then translate)', () => {
    // scale (1,1) by (2,3) -> (2,3); translate by (10,20) -> (12,23).
    expectPoint(apply(multiply(translation(10, 20), scaling(2, 3)), { x: 1, y: 1 }), { x: 12, y: 23 })
    // Negative control: the opposite order translates first, (11,21) scaled -> (22,63).
    expectPoint(apply(multiply(scaling(2, 3), translation(10, 20)), { x: 1, y: 1 }), { x: 22, y: 63 })
  })

  it('LAY-GEST-003: rotation(90) maps (1,0) to (0,1) in y-down CSS space', () => {
    expectPoint(apply(rotation(90), { x: 1, y: 0 }), { x: 0, y: 1 })
  })

  it('LAY-GEST-003: invert undoes a translation and rejects a singular matrix', () => {
    expectMatrix(invert(translation(5, -7)), [1, 0, 0, 1, -5, 7])
    expect(invert(scaling(0, 1))).toBeNull()
  })

  it('LAY-GEST-003: parseCssMatrix reads 2D matrix() and identity, and rejects 3D and short forms', () => {
    expect(parseCssMatrix('matrix(1, 0, 0, 1, 5, 6)')).toEqual([1, 0, 0, 1, 5, 6])
    expect(parseCssMatrix('none')).toEqual([1, 0, 0, 1, 0, 0])
    expect(parseCssMatrix('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')).toBeNull()
    expect(parseCssMatrix('matrix(1,2)')).toBeNull()
    expect(parseCssMatrix('matrix(1, 0, 0, 1, x, 6)')).toBeNull()
  })

  it('LAY-GEST-003: reparentLocal reproduces the Paper sample offset', () => {
    // inverse(newParent) = translation(174, 221); 174 - 156 = 18, 221 - 194 = 27.
    expectMatrix(reparentLocal(translation(-156, -194), identity, translation(-174, -221)), [1, 0, 0, 1, 18, 27])
  })

  it('LAY-GEST-003: reparentLocal keeps the world pose under nested rotation and scale', () => {
    const oldParent = multiply(translation(100, 100), multiply(rotation(30), scaling(2, 2)))
    const oldLocal = translation(10, 0)
    const newParent = multiply(translation(50, 50), rotation(-45))
    // World point of the local origin, by hand:
    //   oldLocal maps (0,0) to (10,0); scale 2 -> (20,0);
    //   rotate 30: (20 cos30, 20 sin30) = (17.3205, 10); translate (100,100) -> (117.3205, 110).
    const world = { x: 117.3205, y: 110 }
    // Local point (1,0): oldLocal -> (11,0); scale -> (22,0); rotate -> (19.0526, 11); translate -> (119.0526, 111).
    const worldOfUnitX = { x: 119.0526, y: 111 }
    const result = reparentLocal(oldLocal, oldParent, newParent)
    expect(result).not.toBeNull()
    const placed = multiply(newParent, result!)
    expectPoint(apply(placed, { x: 0, y: 0 }), world, 0)
    expectPoint(apply(placed, { x: 1, y: 0 }), worldOfUnitX, 0)
    // The new local origin, by hand: world - (50,50) = (67.3205, 60); undo rotate(-45) by rotating +45:
    //   x = (67.3205 - 60) * 0.70711 = 5.1764; y = (67.3205 + 60) * 0.70711 = 90.0292.
    expectPoint({ x: result![4], y: result![5] }, { x: 5.1764, y: 90.0292 }, 2)
    // World rotation 30 under a parent rotated -45 leaves 75 degrees locally; the scale of 2 carries over.
    const parts = decompose(result!)
    expect(parts.rotateDegrees).toBeCloseTo(75, 6)
    expect(parts.scaleX).toBeCloseTo(2, 9)
    expect(parts.scaleY).toBeCloseTo(2, 9)
  })

  it('LAY-GEST-003 negative: adding ancestor translations alone would miss the world point', () => {
    // A naive translate-only reparent of translation(10,0) from (100,100) to (50,50) gives local (60,50),
    // which under the rotated new parent does not land on (117.3205, 110).
    const newParent = multiply(translation(50, 50), rotation(-45))
    const naive = apply(multiply(newParent, translation(60, 50)), { x: 0, y: 0 })
    expect(Math.hypot(naive.x - 117.3205, naive.y - 110)).toBeGreaterThan(10)
  })

  it('LAY-GEST-003: reparentLocal returns null under a singular new parent', () => {
    expect(reparentLocal(translation(1, 2), identity, scaling(0, 1))).toBeNull()
  })

  it('LAY-GEST-003: decompose recovers translation, rotation, and per-axis scale', () => {
    const parts = decompose(multiply(translation(3, 4), multiply(rotation(90), scaling(2, 5))))
    expect(parts.x).toBeCloseTo(3, 9)
    expect(parts.y).toBeCloseTo(4, 9)
    expect(parts.rotateDegrees).toBeCloseTo(90, 9)
    expect(parts.scaleX).toBeCloseTo(2, 9)
    expect(parts.scaleY).toBeCloseTo(5, 9)
  })

  it('LAY-GEST-003: aboutOrigin rotates around the given origin', () => {
    // (0,0) - (10,10) = (-10,-10); rotate 180 -> (10,10); + (10,10) -> (20,20).
    expectPoint(apply(aboutOrigin(rotation(180), { x: 10, y: 10 }), { x: 0, y: 0 }), { x: 20, y: 20 })
    // Negative control: rotating about the corner leaves (0,0) in place.
    expectPoint(apply(rotation(180), { x: 0, y: 0 }), { x: 0, y: 0 })
  })
})
