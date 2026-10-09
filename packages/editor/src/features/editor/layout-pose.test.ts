import { describe, expect, it } from 'vitest'
import { apply, multiply, rotation, scaling, translation } from '@canvas/repo-engine/layout-matrix'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import { layoutWithPose, localMatrixOf, poseFromLocal, reparentPose, worldMatrixOf } from './layout-pose'
import type { MeasuredNode } from './scene-geometry'

// LAY-GEST-003: reparenting from measured poses. Fixtures are synthetic measurements (rects are not used by the pose
// chain, so they are placeholders); every expected number is worked out by hand in the comments.
const host = { x: -176, y: -236 }
const rect = { x: 0, y: 0, width: 10, height: 10 }
const node = (offset: { x: number; y: number }, offsetParentInstanceId: string | null, transform?: Matrix, origin = { x: 0, y: 0 }): MeasuredNode => ({ componentId: 'c', rect, offset: { ...offset, width: 100, height: 40, origin }, offsetParentInstanceId, ...(transform ? { transform } : {}) })
const close = (actual: { x: number; y: number }, expected: { x: number; y: number }, tolerance = 0.5) => { expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance); expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance) }

describe('world matrices from measurement', () => {
  it('counts a child offset from the padding edge inside the parent border', () => {
    // card border 3 left and 2 top: child world corner = host + (20 + 3 + 5, 30 + 2 + 7) = (-148, -197).
    const card = { ...node({ x: 20, y: 30 }, null), box: { padding: { top: 0, right: 0, bottom: 0, left: 0 }, border: { top: 2, right: 0, bottom: 0, left: 3 } } }
    const nodes = { card, child: node({ x: 5, y: 7 }, 'card') }
    expect(apply(worldMatrixOf(nodes, 'child', host)!, { x: 0, y: 0 })).toEqual({ x: -148, y: -197 })
    // Moving a host-level node at the same world corner under the card lands on the same (5, 7) insets.
    expect(reparentPose({ ...nodes, loose: node({ x: 28, y: 39 }, null) }, 'loose', 'card', host)).toEqual({ x: 5, y: 7, rotate: 0, scale: { x: 1, y: 1 } })
  })
  it('chains offset parents up to the host origin', () => {
    const nodes = { card: node({ x: 20, y: 30 }, null), child: node({ x: 5, y: 7 }, 'card') }
    // child world corner = host + card offset + child offset = (-176 + 20 + 5, -236 + 30 + 7) = (-151, -199)
    expect(apply(worldMatrixOf(nodes, 'child', host)!, { x: 0, y: 0 })).toEqual({ x: -151, y: -199 })
    expect(worldMatrixOf(nodes, 'missing', host)).toBeNull()
    expect(worldMatrixOf({ loose: { componentId: 'c', rect } }, 'loose', host)).toBeNull()
    // An offset parent that is not a mounted root (undefined link) cannot be rebuilt.
    expect(worldMatrixOf({ ...nodes, child: { ...nodes.child, offsetParentInstanceId: 'ghost' } }, 'child', host)).toBeNull()
  })
  it('folds a rotated and scaled parent into the child world pose', () => {
    // card at (100, 100) with transform rotate(30deg) scale(2) about its corner; child at (10, 0) inside.
    // child corner world = host + (100, 100) + R30 S2 (10, 0) = host + (100 + 20cos30, 100 + 20sin30) = host + (117.32, 110).
    const nodes = { card: node({ x: 100, y: 100 }, null, multiply(rotation(30), scaling(2, 2))), child: node({ x: 10, y: 0 }, 'card') }
    close(apply(worldMatrixOf(nodes, 'child', host)!, { x: 0, y: 0 }), { x: host.x + 117.32, y: host.y + 110 }, 0.01)
    expect(localMatrixOf(nodes.card)).toEqual(multiply(translation(100, 100), multiply(rotation(30), scaling(2, 2))))
  })
})

describe('reparent pose', () => {
  it('matches the Paper sample: a node at world (-156, -194) under a parent at (-174, -221) sits at local (18, 27)', () => {
    // Host-relative offsets: node (-156 - host.x, -194 - host.y) = (20, 42); parent (-174 - host.x, -221 - host.y) = (2, 15).
    const nodes = { parent: node({ x: 2, y: 15 }, null), moving: node({ x: 20, y: 42 }, null) }
    const pose = reparentPose(nodes, 'moving', 'parent', host)!
    expect(pose).toEqual({ x: 18, y: 27, rotate: 0, scale: { x: 1, y: 1 } })
    expect(layoutWithPose(undefined, pose)).toEqual({ item: { position: { mode: 'absolute', left: { kind: 'px', value: 18 }, top: { kind: 'px', value: 27 } } } })
  })
  it('keeps the world pose within 0.5 px when the new parent is rotated and the old parent was rotated and scaled', () => {
    const oldParent = node({ x: 100, y: 100 }, null, multiply(rotation(30), scaling(2, 2)))
    const newParent = node({ x: 50, y: 50 }, null, rotation(-45))
    const moving = node({ x: 10, y: 0 }, 'old')
    const nodes = { old: oldParent, next: newParent, moving }
    const before = worldMatrixOf(nodes, 'moving', host)!
    const pose = reparentPose(nodes, 'moving', 'next', host)!
    // Hand check of the corner: world corner relative to host is (117.32, 110); in the new parent frame that is
    // R45 x (67.32, 60) = (67.32 cos45 - 60 sin45, 67.32 sin45 + 60 cos45) = (5.18, 90.03).
    close({ x: pose.x, y: pose.y }, { x: 5.18, y: 90.03 }, 0.01)
    expect(pose.rotate).toBeCloseTo(75, 6)
    expect(pose.scale.x).toBeCloseTo(2, 6)
    expect(pose.scale.y).toBeCloseTo(2, 6)
    // Re-measuring with the written pose reproduces the old world matrix for every corner of the 100 x 40 box.
    const written = layoutWithPose(undefined, pose)
    const position = written.item.position as { left: { value: number }; top: { value: number } }
    const transform = written.item.transform as { rotate: number; scale: number }
    const after = worldMatrixOf({ ...nodes, moving: node({ x: position.left.value, y: position.top.value }, 'next', multiply(rotation(transform.rotate), scaling(transform.scale, transform.scale))) }, 'moving', host)!
    for (const corner of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 40 }, { x: 100, y: 40 }]) close(apply(after, corner), apply(before, corner))
  })
  it('respects a transform origin inside the box when splitting a local matrix into offset and transform', () => {
    // A 100 x 40 box rotated 90 degrees about its center (50, 20) at offset (10, 10): local = T(10,10) T(50,20) R90 T(-50,-20).
    const origin = { x: 50, y: 20 }
    const local = multiply(translation(10, 10), multiply(translation(50, 20), multiply(rotation(90), translation(-50, -20))))
    const pose = poseFromLocal(local, origin)
    close({ x: pose.x, y: pose.y }, { x: 10, y: 10 }, 1e-9)
    expect(pose.rotate).toBeCloseTo(90, 9)
  })
  it('returns null without measurement or with a singular parent', () => {
    expect(reparentPose({ moving: node({ x: 1, y: 1 }, null) }, 'moving', 'parent', host)).toBeNull()
    expect(reparentPose({ moving: node({ x: 1, y: 1 }, null), parent: node({ x: 0, y: 0 }, null, scaling(0, 1)) }, 'moving', 'parent', host)).toBeNull()
    expect(reparentPose({ moving: { componentId: 'c', rect } }, 'moving', null, host)).toBeNull()
  })
  it('moving back to the host keeps the world pose and omits an identity transform', () => {
    const nodes = { card: node({ x: 20, y: 30 }, null), child: node({ x: 5, y: 7 }, 'card') }
    expect(reparentPose(nodes, 'child', null, host)).toEqual({ x: 25, y: 37, rotate: 0, scale: { x: 1, y: 1 } })
    expect(layoutWithPose({ item: { position: { mode: 'flow' }, width: { value: { kind: 'px', value: 80 } }, transform: { rotate: 5 } } }, { x: 25, y: 37, rotate: 0, scale: { x: 1, y: 1 } })).toEqual({ item: { position: { mode: 'absolute', left: { kind: 'px', value: 25 }, top: { kind: 'px', value: 37 } }, width: { value: { kind: 'px', value: 80 } } } })
    expect(layoutWithPose(undefined, { x: 1.234, y: 2, rotate: 12.345, scale: { x: 2, y: 3 } }).item.transform).toEqual({ rotate: 12.35, scale: { x: 2, y: 3 } })
  })
})
