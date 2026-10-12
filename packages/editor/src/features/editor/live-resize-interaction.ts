import { advanceResizeGesture, beginResizeGesture } from './canvas-math'
import type { Point, ResizeGestureState, ResizeHandle } from './canvas-math'
import type { GestureAuthoritySnapshot, ResizeGeometryAuthority } from './gesture-authority'
import { resizeWorldPointToGroup } from './layout-measure'
import { projectResizePresentation } from './resize-projection'
import type { ResizePresentation, ResizeProjectionSample } from './resize-projection'

export type LiveResizeInteraction = Readonly<{
  authority: GestureAuthoritySnapshot
  resizeAuthority: ResizeGeometryAuthority
  state: ResizeGestureState
  presentationId: string
  sampleSequence: number
}>

export type LiveResizeModifiers = Readonly<{
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  spaceHeld: boolean
}>

export type LiveResizeSample = Readonly<{
  interaction: LiveResizeInteraction
  sample: ResizeProjectionSample
  presentation: ResizePresentation
}>

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

const freezeResizeState = (state: ResizeGestureState): ResizeGestureState => deepFreeze({ ...state })

/** Starts the resize in the selected node's verified parent-padding coordinate space. */
export function beginLiveResizeInteraction(
  authority: GestureAuthoritySnapshot,
  resizeAuthority: ResizeGeometryAuthority,
  handle: ResizeHandle,
  startWorld: Readonly<Point>,
  presentationId: string,
): LiveResizeInteraction | null {
  const start = resizeWorldPointToGroup(resizeAuthority, startWorld)
  const fence = resizeAuthority.fence
  const captured = authority.start
  if (!start
    || fence.fileId !== captured.fileId
    || fence.fileRevision !== captured.fileRevision
    || fence.measurementRevision !== captured.measurementRevision
    || fence.documentRevision !== captured.documentRevision
    || fence.layoutGeneration !== captured.layoutGeneration
    || resizeAuthority.nodeId !== authority.selection[0]
    || authority.selection.length !== 1) return null
  return Object.freeze({
    authority,
    resizeAuthority,
    state: freezeResizeState(beginResizeGesture(resizeAuthority.startRect, handle, start, resizeAuthority.rotationDegrees)),
    presentationId,
    sampleSequence: -1,
  })
}

/** Advances the pure Paper resize state exactly once, then projects that exact sample exactly once. */
export function sampleLiveResizeInteraction(
  interaction: LiveResizeInteraction,
  pointerWorld: Readonly<Point>,
  modifiers: LiveResizeModifiers,
): LiveResizeSample | null {
  const pointer = resizeWorldPointToGroup(interaction.resizeAuthority, pointerWorld)
  if (!pointer) return null
  const state = advanceResizeGesture(interaction.state, {
    pointer,
    spaceHeld: modifiers.spaceHeld,
    options: {
      symmetric: modifiers.altKey,
      proportional: modifiers.shiftKey,
      minimum: 1 / interaction.authority.camera.zoom,
    },
  })
  const sample: ResizeProjectionSample = deepFreeze({
    coordinateSpace: 'parent-padding' as const,
    rect: { ...state.rect },
    contentLocked: modifiers.ctrlKey || modifiers.metaKey,
    affectedAxes: [...state.affectedAxes],
    effectiveHandle: state.effectiveHandle,
  })
  const presentation = projectResizePresentation(interaction.authority, interaction.resizeAuthority, sample)
  if (!presentation) return null
  return Object.freeze({
    interaction: Object.freeze({
      ...interaction,
      state: freezeResizeState(state),
      sampleSequence: interaction.sampleSequence + 1,
    }),
    sample,
    presentation,
  })
}
