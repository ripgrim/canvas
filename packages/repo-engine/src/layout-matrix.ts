/**
 * 2D affine matrices in CSS order `[a, b, c, d, e, f]` (x' = a x + c y + e; y' = b x + d y + f).
 * Reparenting multiplies a world pose by the inverse of the new parent's full world matrix instead of adding
 * ancestor translations, so nested rotation and scale stay exact.
 */
export type Matrix = readonly [number, number, number, number, number, number]
export type Point = { x: number; y: number }

export const identity: Matrix = [1, 0, 0, 1, 0, 0]
export const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export const scaling = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0]
export function rotation(degrees: number): Matrix {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians), sin = Math.sin(radians)
  return [cos, sin, -sin, cos, 0, 0]
}

/** `left` applied after `right`: multiply(parent, child) maps child-local points to the parent's space. */
export function multiply(left: Matrix, right: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = left
  const [a2, b2, c2, d2, e2, f2] = right
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1]
}

export function invert(matrix: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = matrix
  const determinant = a * d - b * c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant]
}

export const apply = (matrix: Matrix, point: Point): Point => ({ x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] })

/** A transform expressed about an origin inside the element box: translate(origin) T translate(-origin). */
export const aboutOrigin = (transform: Matrix, origin: Point): Matrix => multiply(translation(origin.x, origin.y), multiply(transform, translation(-origin.x, -origin.y)))

/** The matrix mapping an element's local box (origin at its border-box corner) to its parent's space. */
export function localMatrix(offset: Point, transform: Matrix, origin: Point): Matrix {
  return multiply(translation(offset.x, offset.y), aboutOrigin(transform, origin))
}

/** Parses a CSS `matrix(a, b, c, d, e, f)` string; `none` is identity; anything else (3D) is null. */
export function parseCssMatrix(value: string): Matrix | null {
  if (value === 'none' || value === '') return identity
  const match = /^matrix\(\s*([^)]+)\)$/.exec(value.trim())
  if (!match) return null
  const parts = match[1]!.split(',').map(part => Number(part.trim()))
  if (parts.length !== 6 || parts.some(part => !Number.isFinite(part))) return null
  return parts as unknown as Matrix
}

export const isFiniteMatrix = (value: unknown): value is Matrix => Array.isArray(value) && value.length === 6 && value.every(part => typeof part === 'number' && Number.isFinite(part))

/**
 * Local pose for a node after reparenting: world = oldParentWorld x oldLocal, so the new local is
 * inverse(newParentWorld) x world. Returns null when the new parent's matrix is singular.
 */
export function reparentLocal(oldLocal: Matrix, oldParentWorld: Matrix, newParentWorld: Matrix): Matrix | null {
  const inverse = invert(newParentWorld)
  if (!inverse) return null
  return multiply(inverse, multiply(oldParentWorld, oldLocal))
}

/** Translation and scale/rotation decomposition of an affine matrix (no skew), for authoring left/top/rotate/scale. */
export function decompose(matrix: Matrix): { x: number; y: number; rotateDegrees: number; scaleX: number; scaleY: number } {
  const [a, b, c, d, e, f] = matrix
  const scaleX = Math.hypot(a, b)
  const rotate = Math.atan2(b, a)
  const determinant = a * d - b * c
  const scaleY = scaleX === 0 ? 0 : determinant / scaleX
  return { x: e, y: f, rotateDegrees: (rotate * 180) / Math.PI, scaleX, scaleY }
}
