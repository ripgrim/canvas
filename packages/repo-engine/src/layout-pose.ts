import { decomposeTransform, identityTransform, multiplyTransforms, normalizeTransform, rotationTransform, scaleTransform, transformAround, translationTransform } from './transform-matrix.js'
import type { TransformMatrix, TransformSize } from './transform-matrix.js'

export type LegacyPrimitivePose = Readonly<{
  left: number
  top: number
  rotation?: number
  flipX?: boolean
  flipY?: boolean
}>

/**
 * Preserves the legacy CSS visual: position the untransformed box, then rotate/reflect around its center.
 * The returned matrix maps the node's top-left local box coordinates directly into parent space.
 */
export function matrixFromLegacyPose(pose: LegacyPrimitivePose, size: TransformSize): TransformMatrix {
  const rotate = pose.rotation ?? 0
  const scaleX = pose.flipX ? -1 : 1
  const scaleY = pose.flipY ? -1 : 1
  const authored = multiplyTransforms(rotationTransform(rotate), scaleTransform(scaleX, scaleY))
  const centered = transformAround(authored, { x: size.width / 2, y: size.height / 2 })
  return normalizeTransform(multiplyTransforms(translationTransform(pose.left, pose.top), centered))
}

/** Exact only for legacy poses, which admit rotation and reflection but not arbitrary scale or skew. */
export function legacyPoseFromMatrix(matrix: TransformMatrix, size: TransformSize): LegacyPrimitivePose | null {
  const parts = decomposeTransform(matrix)
  if (Math.abs(parts.skewX) > 1e-9 || Math.abs(Math.abs(parts.scaleX) - 1) > 1e-9 || Math.abs(Math.abs(parts.scaleY) - 1) > 1e-9) return null
  const flipX = parts.scaleX < 0
  const flipY = parts.scaleY < 0
  const linear = multiplyTransforms(rotationTransform(parts.rotateDegrees), scaleTransform(flipX ? -1 : 1, flipY ? -1 : 1))
  const centered = transformAround(linear, { x: size.width / 2, y: size.height / 2 })
  const left = matrix[4] - centered[4]
  const top = matrix[5] - centered[5]
  return {
    left: Math.abs(left) < 1e-12 ? 0 : left,
    top: Math.abs(top) < 1e-12 ? 0 : top,
    ...(Math.abs(parts.rotateDegrees) > 1e-12 ? { rotation: parts.rotateDegrees } : {}),
    ...(flipX ? { flipX: true } : {}),
    ...(flipY ? { flipY: true } : {}),
  }
}

export const rootPose = (): TransformMatrix => identityTransform
