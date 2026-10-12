import type { ResizeGeometryAuthority } from './gesture-authority'
import { projectResizeRectToWorld } from './layout-measure'
import type { ResizePresentation } from './resize-projection'

export type RotationCorner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'

const freezeGraph = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) freezeGraph(child, seen)
  return Object.freeze(value)
}

/** Projects one live rotation sample through the same captured geometry authority used by resize. */
export function projectRotationPresentation(authority: ResizeGeometryAuthority, rotationDegrees: number): ResizePresentation | null {
  if (!Number.isFinite(rotationDegrees)) return null
  const world = projectResizeRectToWorld({ ...authority, rotationDegrees }, authority.startRect)
  if (!world) return null
  const item = {
    nodeId: authority.nodeId,
    parentId: authority.parentId,
    coordinateSpace: 'parent-padding' as const,
    startRect: { ...authority.startRect },
    rect: { ...authority.startRect },
    world,
  }
  return freezeGraph({
    selectedNodeId: authority.nodeId,
    contentLocked: false,
    affectedAxes: ['x', 'y'] as const,
    effectiveHandle: 'top-left' as const,
    items: [item],
    byNodeId: { [authority.nodeId]: item },
  })
}

export function rotationDegreesFromPointer(startDegrees: number, center: Readonly<{ x: number; y: number }>, start: Readonly<{ x: number; y: number }>, current: Readonly<{ x: number; y: number }>, snap: boolean): number {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  const currentAngle = Math.atan2(current.y - center.y, current.x - center.x)
  const degrees = startDegrees + (currentAngle - startAngle) * 180 / Math.PI
  return snap ? Math.round(degrees / 15) * 15 : degrees
}
