/** Canonical 2D affine transform in CSS/Figma order. */
export type TransformMatrix = readonly [number, number, number, number, number, number]
export type TransformPoint = Readonly<{ x: number; y: number }>
export type TransformSize = Readonly<{ width: number; height: number }>
export type TransformRect = Readonly<{ x: number; y: number; width: number; height: number }>

export const identityTransform: TransformMatrix = [1, 0, 0, 1, 0, 0]
export const translationTransform = (x: number, y: number): TransformMatrix => [1, 0, 0, 1, x, y]
export const scaleTransform = (x: number, y: number): TransformMatrix => [x, 0, 0, y, 0, 0]
export const skewXTransform = (radians: number): TransformMatrix => [1, 0, Math.tan(radians), 1, 0, 0]

export function rotationTransform(degrees: number): TransformMatrix {
  const radians = degrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return [cosine, sine, -sine, cosine, 0, 0]
}

/** `left * right`: the right transform is applied to a point first. */
export function multiplyTransforms(left: TransformMatrix, right: TransformMatrix): TransformMatrix {
  const [a1, b1, c1, d1, tx1, ty1] = left
  const [a2, b2, c2, d2, tx2, ty2] = right
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * tx2 + c1 * ty2 + tx1,
    b1 * tx2 + d1 * ty2 + ty1,
  ]
}

export const transformPoint = (matrix: TransformMatrix, point: TransformPoint): TransformPoint => ({
  x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
  y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
})

export const transformDeterminant = (matrix: TransformMatrix): number => matrix[0] * matrix[3] - matrix[1] * matrix[2]

export function invertTransform(matrix: TransformMatrix): TransformMatrix | null {
  const [a, b, c, d, tx, ty] = matrix
  const determinant = transformDeterminant(matrix)
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * ty - d * tx) / determinant, (b * tx - a * ty) / determinant]
}

export const isTransformMatrix = (value: unknown): value is TransformMatrix => Array.isArray(value)
  && value.length === 6
  && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
  && Math.abs(transformDeterminant(value as unknown as TransformMatrix)) >= 1e-12

/** Removes negative zero and insignificant floating noise without reducing authored precision. */
export function normalizeTransform(matrix: TransformMatrix, epsilon = 1e-12): TransformMatrix {
  return matrix.map(value => Math.abs(value) < epsilon ? 0 : value) as unknown as TransformMatrix
}

export function transformAround(matrix: TransformMatrix, origin: TransformPoint): TransformMatrix {
  return multiplyTransforms(translationTransform(origin.x, origin.y), multiplyTransforms(matrix, translationTransform(-origin.x, -origin.y)))
}

export function transformedBounds(matrix: TransformMatrix, size: TransformSize): TransformRect {
  const corners = [
    transformPoint(matrix, { x: 0, y: 0 }),
    transformPoint(matrix, { x: size.width, y: 0 }),
    transformPoint(matrix, { x: 0, y: size.height }),
    transformPoint(matrix, { x: size.width, y: size.height }),
  ]
  const xs = corners.map(point => point.x)
  const ys = corners.map(point => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** Hit testing is performed in local box space so rotation, reflection, and skew share one path. */
export function containsTransformedPoint(matrix: TransformMatrix, size: TransformSize, point: TransformPoint): boolean {
  const inverse = invertTransform(matrix)
  if (!inverse) return false
  const local = transformPoint(inverse, point)
  return local.x >= 0 && local.x <= size.width && local.y >= 0 && local.y <= size.height
}

export function parseTransformMatrix(value: string): TransformMatrix | null {
  if (value === 'none' || value === '') return identityTransform
  const match = /^matrix\(\s*([^)]+)\)$/.exec(value.trim())
  if (!match) return null
  const entries = match[1]!.split(',').map(entry => Number(entry.trim()))
  return isTransformMatrix(entries) ? entries : null
}

export type TransformDecomposition = {
  x: number
  y: number
  rotateDegrees: number
  scaleX: number
  scaleY: number
  skewX: number
}

/** Rebuilds the canonical `translation * rotation * skewX * scale` decomposition. */
export function composeTransform(parts: TransformDecomposition): TransformMatrix {
  const linear = multiplyTransforms(
    rotationTransform(parts.rotateDegrees),
    multiplyTransforms(skewXTransform(parts.skewX), scaleTransform(parts.scaleX, parts.scaleY)),
  )
  return normalizeTransform(multiplyTransforms(translationTransform(parts.x, parts.y), linear))
}

/** Stable QR-style affine decomposition. Skew is measured in radians and reflection is carried by `scaleY`. */
export function decomposeTransform(matrix: TransformMatrix): TransformDecomposition {
  const [a, b, c, d, x, y] = matrix
  const scaleX = Math.hypot(a, b)
  if (scaleX < 1e-12) return { x, y, rotateDegrees: 0, scaleX: 0, scaleY: Math.hypot(c, d), skewX: 0 }
  const determinant = transformDeterminant(matrix)
  const scaleY = determinant / scaleX
  const projectedSecondColumn = (a * c + b * d) / scaleX
  const skewX = Math.atan(projectedSecondColumn / scaleY)
  return { x, y, rotateDegrees: Math.atan2(b, a) * 180 / Math.PI, scaleX, scaleY, skewX }
}

/** Computes the child's local transform after a parent change without losing its world pose. */
export function reparentTransform(local: TransformMatrix, oldParentWorld: TransformMatrix, newParentWorld: TransformMatrix): TransformMatrix | null {
  const inverse = invertTransform(newParentWorld)
  return inverse ? normalizeTransform(multiplyTransforms(inverse, multiplyTransforms(oldParentWorld, local))) : null
}
