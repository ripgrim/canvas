/**
 * World and local poses of mounted component roots from measurement, for reparenting that keeps the world pose
 * under nested rotation and scale. The runtime reports each root's untransformed box relative to its CSS offset
 * parent, its transform origin and its computed transform; chaining those up to the host gives an exact world matrix,
 * and the new local pose is inverse(newParentWorld) x world (never a sum of ancestor translations).
 */
import { aboutOrigin, apply, identity, invert, multiply, translation } from '@canvas/repo-engine/layout-matrix'
import type { Matrix, Point } from '@canvas/repo-engine/layout-matrix'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import type { MeasuredNode } from './scene-geometry'

export type Pose = { x: number; y: number; matrix: Matrix }
const epsilon = 1e-6
const paddingEdge = (node: MeasuredNode): Matrix => translation(node.box?.border.left ?? 0, node.box?.border.top ?? 0)

/** Local matrix of a root relative to its offset parent's padding edge; null without an offset measurement. */
export function localMatrixOf(node: MeasuredNode | undefined): Matrix | null {
  if (!node?.offset) return null
  const transform: Matrix = node.transform ? [...node.transform] as unknown as Matrix : identity
  return multiply(translation(node.offset.x, node.offset.y), aboutOrigin(transform, node.offset.origin))
}
/**
 * World matrix (world units, origin at the page origin): the chain of offset parents up to the host. Roots whose
 * offset parent is the host sit at `hostOrigin` plus their offset. Returns null when any link lacks measurement or
 * when an offset parent is not a mounted component root (then the chain cannot be rebuilt from the model).
 */
export function worldMatrixOf(nodes: Record<string, MeasuredNode>, id: string, hostOrigin: Point): Matrix | null {
  const seen = new Set<string>()
  let matrix: Matrix | null = null
  let current: string | null = id
  while (current !== null) {
    if (seen.has(current)) return null
    seen.add(current)
    const node: MeasuredNode | undefined = nodes[current]
    const local = localMatrixOf(node)
    if (!node || !local) return null
    // A child offset counts from its offset parent's padding edge, which sits inside that parent's border.
    matrix = matrix ? multiply(local, multiply(paddingEdge(node), matrix)) : local
    if (node.offsetParentInstanceId === undefined) return null
    current = node.offsetParentInstanceId
  }
  return multiply(translation(hostOrigin.x, hostOrigin.y), matrix ?? identity)
}
/** Splits a local matrix into the authored offset (border-box corner) and the transform about the given origin. */
export function poseFromLocal(local: Matrix, origin: Point): Pose {
  const linear: Matrix = [local[0], local[1], local[2], local[3], 0, 0]
  const shifted = apply(linear, origin)
  return { x: local[4] - (origin.x - shifted.x), y: local[5] - (origin.y - shifted.y), matrix: linear }
}
/**
 * The pose a node needs under `newParentId` to keep its world pose. `newParentId` null means the host. Returns null
 * when the measurement chain is incomplete or the new parent's matrix is singular.
 */
export function reparentPose(nodes: Record<string, MeasuredNode>, nodeId: string, newParentId: string | null, hostOrigin: Point): Pose | null {
  const node = nodes[nodeId]
  const world = worldMatrixOf(nodes, nodeId, hostOrigin)
  if (!node?.offset || !world) return null
  const parentWorld = newParentId === null ? translation(hostOrigin.x, hostOrigin.y) : worldMatrixOf(nodes, newParentId, hostOrigin)
  if (!parentWorld) return null
  // Insets under the new parent count from its padding edge.
  const inverse = invert(newParentId === null ? parentWorld : multiply(parentWorld, paddingEdge(nodes[newParentId]!)))
  if (!inverse) return null
  return poseFromLocal(multiply(inverse, world), node.offset.origin)
}
/** Writes a pose into a layout record as absolute px insets and one lossless affine transform (identity omitted). */
export function layoutWithPose(layout: NodeLayout | undefined, pose: Pose): NodeLayout {
  const base = layout ?? { item: { position: { mode: 'flow' } } }
  const item = { ...base.item, position: { mode: 'absolute' as const, left: { kind: 'px' as const, value: round(pose.x) }, top: { kind: 'px' as const, value: round(pose.y) } } }
  const matrix = pose.matrix.map(value => Math.abs(value) < epsilon ? 0 : value) as unknown as Matrix
  if (matrix.every((value, index) => Math.abs(value - identity[index]!) < epsilon)) delete item.transform
  else item.transform = { matrix }
  return { ...base, item }
}
const round = (value: number) => Math.round(value * 100) / 100
