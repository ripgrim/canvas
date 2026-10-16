import { describe, expect, it } from 'vitest'
import { composeTransform, containsTransformedPoint, decomposeTransform, identityTransform, invertTransform, isTransformMatrix, multiplyTransforms, normalizeTransform, rotationTransform, scaleTransform, transformPoint, transformedBounds, translationTransform } from '../src/transform-matrix.js'

describe('canonical transform matrix', () => {
  it('normalizes affine matrix math into the canonical tuple representation', () => {
    const matrix = normalizeTransform(multiplyTransforms(translationTransform(20, 30), rotationTransform(90)))
    expect(matrix).toEqual([0, 1, -1, 0, 20, 30])
    expect(isTransformMatrix(matrix)).toBe(true)
  })

  it('MATRIX-LAYOUT-002 composes nested transforms in parent-to-child order', () => {
    const parent = multiplyTransforms(translationTransform(100, 50), rotationTransform(90))
    const child = translationTransform(10, 5)
    expect(transformPoint(multiplyTransforms(parent, child), { x: 0, y: 0 })).toEqual({ x: 95, y: 60 })
    // Negative control: reversing the multiplication lands somewhere else.
    expect(transformPoint(multiplyTransforms(child, parent), { x: 0, y: 0 })).not.toEqual({ x: 95, y: 60 })
  })

  it('MATRIX-LAYOUT-003 inverse mapping round-trips points and drives rotated hit geometry', () => {
    const matrix = multiplyTransforms(translationTransform(50, 20), rotationTransform(90))
    const inverse = invertTransform(matrix)
    expect(inverse).not.toBeNull()
    const local = { x: 8, y: 4 }
    expect(transformPoint(inverse!, transformPoint(matrix, local))).toEqual(local)
    expect(containsTransformedPoint(matrix, { width: 10, height: 6 }, transformPoint(matrix, local))).toBe(true)
    expect(containsTransformedPoint(matrix, { width: 10, height: 6 }, transformPoint(matrix, { x: 11, y: 4 }))).toBe(false)
    expect(transformedBounds(matrix, { width: 10, height: 6 })).toEqual({ x: 44, y: 20, width: 6, height: 10 })
  })

  it('MATRIX-LAYOUT-NEG-001 rejects malformed, singular, and non-finite matrices', () => {
    expect(isTransformMatrix(identityTransform)).toBe(true)
    expect(isTransformMatrix([1, 0, 0, 1, 0])).toBe(false)
    expect(isTransformMatrix([1, 0, 0, 1, Number.NaN, 0])).toBe(false)
    expect(isTransformMatrix(scaleTransform(0, 1))).toBe(false)
    expect(invertTransform(scaleTransform(0, 1))).toBeNull()
  })

  it('MATRIX-LAYOUT-006 losslessly decomposes non-uniform reflected skew for inspector boundaries', () => {
    const matrix = [0, 2, 3, -1.5, 12, -7] as const
    const parts = decomposeTransform(matrix)

    expect(parts.x).toBe(12)
    expect(parts.y).toBe(-7)
    expect(parts.rotateDegrees).toBe(90)
    expect(parts.scaleX).toBe(2)
    expect(parts.scaleY).toBe(-3)
    expect(parts.skewX).toBeCloseTo(Math.atan(0.5), 12)
    composeTransform(parts).forEach((value, index) => expect(value).toBeCloseTo(matrix[index]!, 12))
    expect(transformPoint(matrix, { x: 4, y: 2 })).toEqual({ x: 18, y: -2 })

    const withoutSkew = composeTransform({ ...parts, skewX: 0 })
    expect(transformPoint(withoutSkew, { x: 4, y: 2 })).not.toEqual({ x: 18, y: -2 })
  })
})
