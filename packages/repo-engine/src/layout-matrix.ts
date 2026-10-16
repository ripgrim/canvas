/**
 * 2D affine matrices in CSS order `[a, b, c, d, e, f]` (x' = a x + c y + e; y' = b x + d y + f).
 * Reparenting multiplies a world pose by the inverse of the new parent's full world matrix instead of adding
 * ancestor translations, so nested rotation and scale stay exact.
 */
import { composeTransform, decomposeTransform, identityTransform, invertTransform, isTransformMatrix, multiplyTransforms, parseTransformMatrix, reparentTransform, rotationTransform, scaleTransform, transformAround, transformPoint, translationTransform } from './transform-matrix.js'
import type { TransformMatrix, TransformPoint } from './transform-matrix.js'

export type Matrix = TransformMatrix
export type Point = TransformPoint

export const identity = identityTransform
export const translation = translationTransform
export const scaling = scaleTransform
export const rotation = rotationTransform

/** `left` applied after `right`: multiply(parent, child) maps child-local points to the parent's space. */
export const multiply = multiplyTransforms

export const invert = invertTransform

export const apply = transformPoint

/** A transform expressed about an origin inside the element box: translate(origin) T translate(-origin). */
export const aboutOrigin = transformAround

/** The matrix mapping an element's local box (origin at its border-box corner) to its parent's space. */
export function localMatrix(offset: Point, transform: Matrix, origin: Point): Matrix {
  return multiply(translation(offset.x, offset.y), aboutOrigin(transform, origin))
}

/** Parses a CSS `matrix(a, b, c, d, e, f)` string; `none` is identity; anything else (3D) is null. */
export const parseCssMatrix = parseTransformMatrix

export const isFiniteMatrix = isTransformMatrix

/**
 * Local pose for a node after reparenting: world = oldParentWorld x oldLocal, so the new local is
 * inverse(newParentWorld) x world. Returns null when the new parent's matrix is singular.
 */
export const reparentLocal = reparentTransform

/** Lossless canonical decomposition for authoring translation, rotation, scale, reflection, and skew. */
export const decompose = decomposeTransform
export const compose = composeTransform
