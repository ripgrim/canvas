import type { CornerRadiusKey } from '@canvas/repo-engine/appearance'
import type { HudProjectionEntry, HudQuad } from './canvas-hud-projection'
import type { Point } from './canvas-math'

export const cornerRadiusHandles = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const satisfies readonly CornerRadiusKey[]
export const cornerRadiusMinimumInset = 12
export const cornerRadiusMinimumNodeSize = 53
export const cornerRadiusAmbiguityThreshold = 2

export type CornerRadiusHandlePose = Readonly<{
  corner: CornerRadiusKey
  center: Readonly<Point>
  inward: Readonly<Point>
  angle: number
  screenScale: number
  maxRadius: number
}>

const cornerIndex: Readonly<Record<CornerRadiusKey, number>> = {
  topLeft: 0,
  topRight: 1,
  bottomRight: 2,
  bottomLeft: 3,
}

const length = (point: Readonly<Point>) => Math.hypot(point.x, point.y)
const subtract = (to: Readonly<Point>, from: Readonly<Point>): Point => ({ x: to.x - from.x, y: to.y - from.y })
const normalize = (point: Readonly<Point>): Point | null => {
  const magnitude = length(point)
  return magnitude > 1e-6 ? { x: point.x / magnitude, y: point.y / magnitude } : null
}

function cornerVectors(quad: HudQuad, index: number): Readonly<{ corner: Readonly<Point>; first: Point; second: Point; firstLength: number; secondLength: number }> | null {
  const corner = quad[index]!
  const previous = subtract(quad[(index + 3) % 4]!, corner)
  const next = subtract(quad[(index + 1) % 4]!, corner)
  const firstLength = length(previous), secondLength = length(next)
  if (firstLength <= 1e-6 || secondLength <= 1e-6) return null
  return { corner, first: { x: previous.x / firstLength, y: previous.y / firstLength }, second: { x: next.x / secondLength, y: next.y / secondLength }, firstLength, secondLength }
}

/** Screen-space radius controls derived from the same projected quad that owns resize and rotation chrome. */
export function cornerRadiusHandlePoses(entry: HudProjectionEntry, radii: Readonly<Record<CornerRadiusKey, number>>): readonly CornerRadiusHandlePose[] {
  if (Math.max(entry.screenAabb.width, entry.screenAabb.height) < cornerRadiusMinimumNodeSize) return []
  const width = entry.dimensions.width, height = entry.dimensions.height
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return []
  const maxRadius = Math.min(width, height) / 2
  return cornerRadiusHandles.flatMap(corner => {
    const vectors = cornerVectors(entry.screenQuad, cornerIndex[corner])
    if (!vectors) return []
    const inward = normalize({ x: vectors.first.x + vectors.second.x, y: vectors.first.y + vectors.second.y })
    if (!inward) return []
    const firstIsVertical = corner === 'topLeft' || corner === 'bottomRight'
    const firstDimension = firstIsVertical ? height : width
    const secondDimension = firstIsVertical ? width : height
    const firstScale = vectors.firstLength / firstDimension
    const secondScale = vectors.secondLength / secondDimension
    const screenScale = firstScale * (vectors.first.x * inward.x + vectors.first.y * inward.y)
      + secondScale * (vectors.second.x * inward.x + vectors.second.y * inward.y)
    if (!Number.isFinite(screenScale) || screenScale <= 1e-6) return []
    const radius = Math.max(0, Math.min(maxRadius, radii[corner]))
    const firstInset = Math.min(vectors.firstLength / 2, Math.max(cornerRadiusMinimumInset, radius * firstScale))
    const secondInset = Math.min(vectors.secondLength / 2, Math.max(cornerRadiusMinimumInset, radius * secondScale))
    return [{
      corner,
      center: {
        x: vectors.corner.x + vectors.first.x * firstInset + vectors.second.x * secondInset,
        y: vectors.corner.y + vectors.first.y * firstInset + vectors.second.y * secondInset,
      },
      inward,
      angle: Math.atan2(inward.y, inward.x),
      screenScale,
      maxRadius,
    }]
  })
}

export function resolveAmbiguousCorner(poses: readonly CornerRadiusHandlePose[], pressed: CornerRadiusKey, delta: Readonly<Point>): CornerRadiusKey {
  const source = poses.find(pose => pose.corner === pressed)
  if (!source || Math.hypot(delta.x, delta.y) <= cornerRadiusAmbiguityThreshold) return pressed
  const candidates = poses.filter(pose => Math.hypot(pose.center.x - source.center.x, pose.center.y - source.center.y) <= 1)
  if (candidates.length < 2) return pressed
  return candidates.reduce((best, pose) => pose.inward.x * delta.x + pose.inward.y * delta.y > best.inward.x * delta.x + best.inward.y * delta.y ? pose : best).corner
}

export function radiusFromPointer(startRadius: number, delta: Readonly<Point>, pose: CornerRadiusHandlePose, snap: boolean): number {
  const projected = (delta.x * pose.inward.x + delta.y * pose.inward.y) / pose.screenScale
  const unclamped = Math.max(0, Math.min(pose.maxRadius, startRadius + projected))
  return snap ? Math.max(0, Math.min(pose.maxRadius, Math.round(unclamped / 5) * 5)) : unclamped
}
