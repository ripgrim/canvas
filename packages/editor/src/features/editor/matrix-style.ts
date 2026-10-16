import type { PrimitiveStyles, PrimitiveStylePatch } from '@canvas/repo-engine/file-document'
import { composeTransform, decomposeTransform, multiplyTransforms, normalizeTransform, rotationTransform, scaleTransform, transformAround, transformedBounds, transformPoint, translationTransform } from '@canvas/repo-engine/transform-matrix'
import type { TransformMatrix } from '@canvas/repo-engine/transform-matrix'

export const primitiveBounds = (styles: PrimitiveStyles) => transformedBounds(styles.relativeTransform, styles)

export const primitiveRotation = (styles: PrimitiveStyles) => decomposeTransform(styles.relativeTransform).rotateDegrees

export const translatedMatrix = (matrix: TransformMatrix, dx: number, dy: number): TransformMatrix =>
  normalizeTransform(multiplyTransforms(translationTransform(dx, dy), matrix))

export function positionedMatrix(styles: PrimitiveStyles, x: number, y: number): TransformMatrix {
  const bounds = primitiveBounds(styles)
  return translatedMatrix(styles.relativeTransform, x - bounds.x, y - bounds.y)
}

export function positionPatch(styles: PrimitiveStyles, axis: 'x' | 'y', value: number): PrimitiveStylePatch {
  const bounds = primitiveBounds(styles)
  return { relativeTransform: positionedMatrix(styles, axis === 'x' ? value : bounds.x, axis === 'y' ? value : bounds.y) }
}

export const nudgePatch = (styles: PrimitiveStyles, dx: number, dy: number): PrimitiveStylePatch => ({
  relativeTransform: translatedMatrix(styles.relativeTransform, dx, dy),
})

export function resizedGeometry(styles: PrimitiveStyles, rect: { x: number; y: number; width: number; height: number }) {
  return { relativeTransform: positionedMatrix(styles, rect.x, rect.y), width: rect.width, height: rect.height }
}

export function rotatedPatch(styles: PrimitiveStyles, degrees: number): PrimitiveStylePatch {
  const center = { x: styles.width / 2, y: styles.height / 2 }
  const worldCenter = transformPoint(styles.relativeTransform, center)
  const parts = decomposeTransform(styles.relativeTransform)
  const linear = composeTransform({ ...parts, x: 0, y: 0, rotateDegrees: degrees })
  const next = multiplyTransforms(
    translationTransform(worldCenter.x, worldCenter.y),
    multiplyTransforms(linear, translationTransform(-center.x, -center.y)),
  )
  return { relativeTransform: normalizeTransform(next) }
}

export function rotateQuarterPatch(styles: PrimitiveStyles): PrimitiveStylePatch {
  return rotatedPatch(styles, primitiveRotation(styles) + 90)
}

export function flipPatch(styles: PrimitiveStyles, axis: 'x' | 'y'): PrimitiveStylePatch {
  const scale = axis === 'x' ? scaleTransform(-1, 1) : scaleTransform(1, -1)
  return { relativeTransform: normalizeTransform(multiplyTransforms(styles.relativeTransform, transformAround(scale, { x: styles.width / 2, y: styles.height / 2 }))) }
}

export const reflectionState = (styles: PrimitiveStyles) => {
  const decomposition = decomposeTransform(styles.relativeTransform)
  return { x: decomposition.scaleX < 0, y: decomposition.scaleY < 0 }
}
