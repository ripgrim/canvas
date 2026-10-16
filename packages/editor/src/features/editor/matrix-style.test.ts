import { describe, expect, it } from 'vitest'
import type { PrimitiveStyles } from '@canvas/repo-engine/file-document'
import { composeTransform, decomposeTransform, multiplyTransforms, rotationTransform, transformAround, transformPoint } from '@canvas/repo-engine/transform-matrix'
import { positionPatch, primitiveBounds, rotateQuarterPatch, rotatedPatch } from './matrix-style'

const closeMatrix = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 10))
}

const closePoint = (actual: Readonly<{ x: number; y: number }>, expected: Readonly<{ x: number; y: number }>) => {
  expect(actual.x).toBeCloseTo(expected.x, 10)
  expect(actual.y).toBeCloseTo(expected.y, 10)
}

const styles = (): PrimitiveStyles => ({
  relativeTransform: composeTransform({ x: 41, y: -17, rotateDegrees: 28, scaleX: 1.75, scaleY: -0.6, skewX: 0.31 }),
  width: 120,
  height: 54,
})

describe('primitive matrix inspector edits', () => {
  it('MATRIX-LAYOUT-007 moves the rendered bounds without changing scale, reflection, rotation, or skew', () => {
    const before = styles()
    const beforeParts = decomposeTransform(before.relativeTransform)
    const next = positionPatch(before, 'x', 300).relativeTransform!
    const nextParts = decomposeTransform(next)

    expect(primitiveBounds({ ...before, relativeTransform: next }).x).toBeCloseTo(300, 10)
    closeMatrix(next.slice(0, 4), before.relativeTransform.slice(0, 4))
    expect(nextParts.rotateDegrees).toBeCloseTo(beforeParts.rotateDegrees, 10)
    expect(nextParts.scaleX).toBeCloseTo(beforeParts.scaleX, 10)
    expect(nextParts.scaleY).toBeCloseTo(beforeParts.scaleY, 10)
    expect(nextParts.skewX).toBeCloseTo(beforeParts.skewX, 10)
  })

  it('MATRIX-LAYOUT-007 sets canonical rotation while preserving the rendered center and remaining affine parts', () => {
    const before = styles()
    const center = { x: before.width / 2, y: before.height / 2 }
    const beforeCenter = transformPoint(before.relativeTransform, center)
    const beforeParts = decomposeTransform(before.relativeTransform)
    const target = -37
    const next = rotatedPatch(before, target).relativeTransform!
    const nextParts = decomposeTransform(next)

    closePoint(transformPoint(next, center), beforeCenter)
    expect(nextParts.rotateDegrees).toBeCloseTo(target, 10)
    expect(nextParts.scaleX).toBeCloseTo(beforeParts.scaleX, 10)
    expect(nextParts.scaleY).toBeCloseTo(beforeParts.scaleY, 10)
    expect(nextParts.skewX).toBeCloseTo(beforeParts.skewX, 10)

    const oldShortcut = multiplyTransforms(before.relativeTransform, transformAround(rotationTransform(target - beforeParts.rotateDegrees), center))
    expect(decomposeTransform(oldShortcut).rotateDegrees).not.toBeCloseTo(target, 3)
  })

  it('MATRIX-LAYOUT-007 routes quarter turns through the same lossless inspector transform', () => {
    const before = styles()
    const center = { x: before.width / 2, y: before.height / 2 }
    const beforeParts = decomposeTransform(before.relativeTransform)
    const next = rotateQuarterPatch(before).relativeTransform!
    const nextParts = decomposeTransform(next)

    closePoint(transformPoint(next, center), transformPoint(before.relativeTransform, center))
    expect(nextParts.rotateDegrees).toBeCloseTo(beforeParts.rotateDegrees + 90, 10)
    expect(nextParts.scaleX).toBeCloseTo(beforeParts.scaleX, 10)
    expect(nextParts.scaleY).toBeCloseTo(beforeParts.scaleY, 10)
    expect(nextParts.skewX).toBeCloseTo(beforeParts.skewX, 10)
  })
})
