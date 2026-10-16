import { describe, expect, it } from 'vitest'
import { legacyPoseFromMatrix, matrixFromLegacyPose } from '../src/layout-pose.js'
import { transformPoint, transformedBounds } from '../src/transform-matrix.js'

describe('legacy pose migration', () => {
  it('MATRIX-LAYOUT-004 preserves the visual corners of a rotated and reflected legacy node', () => {
    const size = { width: 80, height: 40 }
    const matrix = matrixFromLegacyPose({ left: 10, top: 20, rotation: 90, flipX: true }, size)
    const corners = [
      transformPoint(matrix, { x: 0, y: 0 }),
      transformPoint(matrix, { x: 80, y: 0 }),
      transformPoint(matrix, { x: 0, y: 40 }),
      transformPoint(matrix, { x: 80, y: 40 }),
    ]
    expect(corners).toEqual([{ x: 70, y: 80 }, { x: 70, y: 0 }, { x: 30, y: 80 }, { x: 30, y: 0 }])
    expect(transformedBounds(matrix, size)).toEqual({ x: 30, y: 0, width: 40, height: 80 })
  })

  it('MATRIX-LAYOUT-005 keeps authored width and height separate from transform scale', () => {
    const size = { width: 120, height: 32 }
    const matrix = matrixFromLegacyPose({ left: 7, top: 9, rotation: 30 }, size)
    expect(size).toEqual({ width: 120, height: 32 })
    const roundTrip = legacyPoseFromMatrix(matrix, size)!
    expect(roundTrip.left).toBeCloseTo(7, 12)
    expect(roundTrip.top).toBeCloseTo(9, 12)
    expect(roundTrip.rotation).toBeCloseTo(30, 12)
    // A true scale cannot be disguised as resize when converting back to the legacy boundary.
    expect(legacyPoseFromMatrix([2, 0, 0, 1, 7, 9], size)).toBeNull()
  })
})
