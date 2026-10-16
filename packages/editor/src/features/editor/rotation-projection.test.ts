import { describe, expect, it } from 'vitest'
import type { ResizeGeometryAuthority } from './gesture-authority'
import { projectRotationPresentation, rotationDegreesFromPointer } from './rotation-projection'

const authority: ResizeGeometryAuthority = Object.freeze({
  coordinateSpace: 'parent-padding', fileId: 'file', pageId: 'page', pageRootId: 'root', nodeId: 'node', parentId: 'root',
  fence: Object.freeze({ fileId: 'file', fileRevision: 1, measurementRevision: 2, documentRevision: 1, layoutGeneration: 3 }),
  startRect: Object.freeze({ x: 0, y: 0, width: 100, height: 40 }),
  groupToWorld: Object.freeze([1, 0, 0, 1, 10, 20] as const), worldToGroup: Object.freeze([1, 0, 0, 1, -10, -20] as const),
  nodeTransform: Object.freeze([1, 0, 0, 1, 0, 0] as const), transformOrigin: Object.freeze({ x: 50, y: 20 }),
})

describe('corner rotation projection', () => {
  it('rotates the live outline around the captured center without changing semantic bounds', () => {
    const projected = projectRotationPresentation(authority, 90)!
    expect(projected.items[0]!.rect).toEqual({ x: 0, y: 0, width: 100, height: 40 })
    expect(projected.items[0]!.nodeTransform).toEqual([0, 1, -1, 0, 0, 0])
    expect(projected.items[0]!.world.quad).toEqual([
      { x: 80, y: -10 }, { x: 80, y: 90 }, { x: 40, y: 90 }, { x: 40, y: -10 },
    ])
    expect(Object.isFrozen(projected.items[0]!.world.quad)).toBe(true)
  })

  it('MATRIX-LAYOUT-009 preserves scale, reflection, and skew while replacing rotation', () => {
    const transformed = { ...authority, nodeTransform: Object.freeze([2, 0, -0.5, -1, 0, 0] as const) }
    const projected = projectRotationPresentation(transformed, 90)!
    expect(projected.items[0]!.nodeTransform[0]).toBeCloseTo(0)
    expect(projected.items[0]!.nodeTransform[1]).toBeCloseTo(2)
    expect(projected.items[0]!.nodeTransform[2]).toBeCloseTo(1)
    expect(projected.items[0]!.nodeTransform[3]).toBeCloseTo(-0.5)
  })

  it('derives continuous rotation and snaps Shift samples to 15 degrees', () => {
    expect(rotationDegreesFromPointer(0, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, false)).toBeCloseTo(90)
    expect(rotationDegreesFromPointer(0, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 9, y: 4 }, true)).toBe(30)
  })

  it('rejects non-finite rotation instead of publishing invalid geometry', () => {
    expect(projectRotationPresentation(authority, Number.NaN)).toBeNull()
  })
})
