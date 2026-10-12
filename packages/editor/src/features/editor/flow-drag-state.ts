import { validId } from '@canvas/repo-engine/document'
import { isOrderKey } from '@canvas/repo-engine/order-keys'
import type { Point, Rect } from './canvas-math'

export type FlowDragModifiers = Readonly<{ alt: boolean; primary: boolean }>
export type FlowDragPlatform = 'macos' | 'windows'
export type FlowDragRawModifiers = Readonly<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; altGraph?: boolean }>
export type FlowDragSlotIdentity = Readonly<{ presence: 'absent' }> | Readonly<{ presence: 'present'; value: string }>
export type FlowDragSourceRelationship = Readonly<{ parentId: string; orderKey: string; slot: FlowDragSlotIdentity }>
export type FlowDragFence = Readonly<{ fileId: string; fileRevision: number; measurementRevision: number; documentRevision: number; layoutGeneration: number }>
export type FlowDragAuthorityProof = FlowDragFence & Readonly<{ gestureGeneration: number; owned: boolean }>
export type FlowDragTarget = Readonly<{
  parentId: string
  slotPresence: FlowDragSlotIdentity['presence']
  slotValue: string | null
  rawIndex: number
  semanticIndex: number
  line: number
  guideWorld: Readonly<{ axis: 'x' | 'y'; position: number; start: number; end: number }> | null
  fence: FlowDragFence & Readonly<{ gestureGeneration: number; sampleSequence: number }>
}>

/** Compatibility descriptor used until the current terminal-intent seam is cut over. */
export type FlowDragClone = Readonly<{ generation: number; mode: 'flow' | 'absolute'; startedAtWorld: Readonly<Point> }>
export type LegacyFlowDragState = Readonly<{
  nodeId: string
  pointerDownWorld: Readonly<Point>
  currentWorld: Readonly<Point>
  initialMode: 'flow'
  originalMode: 'flow' | 'absolute'
  altActive: boolean
  primaryActive: boolean
  generation: number
  clone: FlowDragClone | null
  selection: readonly [string]
}>

export type PaperFlowDragClone = Readonly<{
  generation: number
  entryMode: 'flow' | 'absolute'
  entryGeometry: Readonly<Rect> | null
  sourceRelationship: FlowDragSourceRelationship
  sourceIndex: number
  startedAtWorld: Readonly<Point>
}>

export type PaperFlowDragState = Readonly<{
  kind: 'paper-flow-drag'
  nodeId: string
  selection: readonly [string]
  selectionDepthPrimary: boolean
  sourceRelationship: FlowDragSourceRelationship
  sourceIndex: number
  pointerDownWorld: Readonly<Point>
  currentWorld: Readonly<Point>
  pointerDownViewport: Readonly<Point>
  currentViewport: Readonly<Point>
  pointerDownTime: number
  currentTime: number
  originalMode: 'flow' | 'absolute'
  altActive: boolean
  primaryActive: boolean
  thresholdCrossed: boolean
  gestureGeneration: number
  cloneGeneration: number
  clone: PaperFlowDragClone | null
  target: FlowDragTarget | null
  sampleSequence: number
  fence: FlowDragFence
}>

/** Compatibility name used by the current terminal-intent seam. New flow gestures use `PaperFlowDragState`. */
export type FlowDragState = LegacyFlowDragState
export type BeginPaperFlowDragInput = Readonly<{
  nodeId: string
  pointerDownWorld: Readonly<Point>
  pointerDownViewport: Readonly<Point>
  pointerDownTime: number
  sourceRelationship: FlowDragSourceRelationship
  sourceIndex: number
  gestureGeneration: number
  selectionDepthPrimary: boolean
  fence: FlowDragFence
}>
export type SamplePaperFlowDragInput = Readonly<{
  world: Readonly<Point>
  viewport: Readonly<Point>
  timestamp: number
  modifiers: FlowDragRawModifiers
  platform: FlowDragPlatform
  authority: FlowDragAuthorityProof
  /** Geometry captured at the Alt edge when the selected original is already absolute. */
  entryGeometry?: Readonly<Rect> | null
  /** Called after modifier edges. It must not mutate its state argument. */
  resolveTarget: (state: PaperFlowDragState) => FlowDragTarget | null
}>

const finitePoint = (point: Readonly<Point> | null | undefined): point is Readonly<Point> => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
const finiteRect = (rect: Readonly<Rect>): boolean => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
const samePoint = (left: Readonly<Point>, right: Readonly<Point>): boolean => left.x === right.x && left.y === right.y
const generation = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
const index = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const PAPER_FLOW_DRAG_EARLY_THRESHOLD_CSS_PX = 5
const PAPER_FLOW_DRAG_HELD_THRESHOLD_CSS_PX = 1
const PAPER_FLOW_DRAG_HELD_DELAY_MS = 500
const own = (value: object, key: string) => Object.hasOwn(value, key)
const BEGIN_PAPER_FLOW_DRAG_KEYS = ['nodeId', 'pointerDownWorld', 'pointerDownViewport', 'pointerDownTime', 'sourceRelationship', 'sourceIndex',
  'gestureGeneration', 'selectionDepthPrimary', 'fence'] as const
const SAMPLE_PAPER_FLOW_DRAG_KEYS = ['world', 'viewport', 'timestamp', 'modifiers', 'platform', 'authority', 'resolveTarget'] as const

function exactOwnKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(value)
  return keys.every(key => typeof key === 'string' && allowed.has(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true)
    && required.every(key => own(value, key))
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function validSlot(slot: FlowDragSlotIdentity): boolean {
  return slot?.presence === 'absent'
    ? Object.keys(slot).length === 1
    : slot?.presence === 'present' && Object.keys(slot).length === 2 && typeof slot.value === 'string'
}
function validRelationship(relationship: FlowDragSourceRelationship): boolean {
  return Boolean(relationship && validId(relationship.parentId) && isOrderKey(relationship.orderKey) && validSlot(relationship.slot))
}
function sameRelationship(left: FlowDragSourceRelationship, right: FlowDragSourceRelationship): boolean {
  return left.parentId === right.parentId && left.orderKey === right.orderKey && left.slot.presence === right.slot.presence
    && (left.slot.presence === 'absent' || right.slot.presence === 'present' && left.slot.value === right.slot.value)
}
function validFence(fence: FlowDragFence): boolean {
  return Boolean(fence && validId(fence.fileId) && generation(fence.fileRevision) && generation(fence.measurementRevision)
    && generation(fence.documentRevision) && fence.documentRevision === fence.fileRevision && generation(fence.layoutGeneration))
}
function sameFence(left: FlowDragFence, right: FlowDragFence): boolean {
  return left.fileId === right.fileId && left.fileRevision === right.fileRevision && left.measurementRevision === right.measurementRevision && left.documentRevision === right.documentRevision && left.layoutGeneration === right.layoutGeneration
}
function validTarget(target: FlowDragTarget | null, state: Pick<PaperFlowDragState, 'gestureGeneration' | 'sampleSequence' | 'fence'>): boolean {
  if (target === null) return true
  const slot = target.slotPresence === 'absent' ? target.slotValue === null : target.slotPresence === 'present' && typeof target.slotValue === 'string'
  const guide = target.guideWorld === null || (['x', 'y'].includes(target.guideWorld.axis) && [target.guideWorld.position, target.guideWorld.start, target.guideWorld.end].every(Number.isFinite))
  return validId(target.parentId) && slot && index(target.rawIndex) && index(target.semanticIndex) && index(target.line) && guide && validFence(target.fence)
    && sameFence(target.fence, state.fence) && target.fence.gestureGeneration === state.gestureGeneration && target.fence.sampleSequence === state.sampleSequence
}
function validPaperFlowDragState(state: PaperFlowDragState): boolean {
  if (state.kind !== 'paper-flow-drag' || !validId(state.nodeId) || state.selection.length !== 1 || state.selection[0] !== state.nodeId) return false
  if (!validRelationship(state.sourceRelationship) || !index(state.sourceIndex) || !finitePoint(state.pointerDownWorld) || !finitePoint(state.currentWorld)
    || !finitePoint(state.pointerDownViewport) || !finitePoint(state.currentViewport)) return false
  if (!finiteNonnegative(state.pointerDownTime) || !finiteNonnegative(state.currentTime) || state.currentTime < state.pointerDownTime) return false
  if (typeof state.selectionDepthPrimary !== 'boolean' || typeof state.altActive !== 'boolean' || typeof state.primaryActive !== 'boolean') return false
  if (typeof state.thresholdCrossed !== 'boolean' || !generation(state.gestureGeneration) || !generation(state.cloneGeneration) || !generation(state.sampleSequence) || !validFence(state.fence)) return false
  if (state.originalMode !== (state.thresholdCrossed && state.primaryActive ? 'absolute' : 'flow')) return false
  if (state.clone ? !state.altActive || !state.thresholdCrossed : state.thresholdCrossed && state.altActive) return false
  if (state.clone) {
    if (state.clone.generation !== state.cloneGeneration || state.clone.generation <= 0 || !['flow', 'absolute'].includes(state.clone.entryMode)) return false
    if (!finitePoint(state.clone.startedAtWorld) || !validRelationship(state.clone.sourceRelationship) || !sameRelationship(state.clone.sourceRelationship, state.sourceRelationship) || state.clone.sourceIndex !== state.sourceIndex) return false
    if (state.clone.entryMode === 'absolute' ? !state.clone.entryGeometry || !finiteRect(state.clone.entryGeometry) : state.clone.entryGeometry !== null) return false
  }
  return validTarget(state.target, state)
}

export function validFlowDragState(state: FlowDragState | PaperFlowDragState): boolean {
  if ('kind' in state) return validPaperFlowDragState(state)
  if (!validId(state.nodeId) || state.initialMode !== 'flow' || !finitePoint(state.pointerDownWorld) || !finitePoint(state.currentWorld)) return false
  if (state.selection.length !== 1 || state.selection[0] !== state.nodeId) return false
  if (typeof state.altActive !== 'boolean' || typeof state.primaryActive !== 'boolean' || state.originalMode !== (state.primaryActive ? 'absolute' : 'flow')) return false
  if (!Number.isInteger(state.generation) || state.generation < 0 || state.altActive !== Boolean(state.clone)) return false
  if (!state.clone) return true
  return Number.isInteger(state.clone.generation) && state.clone.generation > 0 && state.clone.generation === state.generation
    && (state.clone.mode === 'flow' || state.clone.mode === 'absolute') && finitePoint(state.clone.startedAtWorld)
}

/** The browser's AltGraph chord is text input, not Paper's duplicate plus detach gesture. */
export function normalizeFlowDragModifiers(raw: FlowDragRawModifiers, platform: FlowDragPlatform): FlowDragModifiers | null {
  if (!raw || typeof raw.altKey !== 'boolean' || typeof raw.ctrlKey !== 'boolean' || typeof raw.metaKey !== 'boolean' || (own(raw, 'altGraph') && typeof raw.altGraph !== 'boolean')) return null
  if (platform !== 'macos' && platform !== 'windows') return null
  if (raw.altGraph === true) return Object.freeze({ alt: false, primary: false })
  return Object.freeze({ alt: raw.altKey, primary: platform === 'macos' ? raw.metaKey : raw.ctrlKey })
}

export function beginPaperFlowDrag(input: BeginPaperFlowDragInput): PaperFlowDragState | null {
  if (!exactOwnKeys(input, BEGIN_PAPER_FLOW_DRAG_KEYS)) return null
  if (!validId(input.nodeId) || !finitePoint(input.pointerDownWorld) || !finitePoint(input.pointerDownViewport) || !finiteNonnegative(input.pointerDownTime)
    || !validRelationship(input.sourceRelationship) || !index(input.sourceIndex)
    || !generation(input.gestureGeneration) || typeof input.selectionDepthPrimary !== 'boolean' || !validFence(input.fence)) return null
  const world = { ...input.pointerDownWorld }
  const viewport = { ...input.pointerDownViewport }
  return deepFreeze({ kind: 'paper-flow-drag' as const, nodeId: input.nodeId, selection: [input.nodeId] as [string], selectionDepthPrimary: input.selectionDepthPrimary,
    sourceRelationship: structuredClone(input.sourceRelationship), sourceIndex: input.sourceIndex, pointerDownWorld: world, currentWorld: world,
    pointerDownViewport: viewport, currentViewport: viewport, pointerDownTime: input.pointerDownTime, currentTime: input.pointerDownTime, originalMode: 'flow' as const,
    altActive: false, primaryActive: false, thresholdCrossed: false, gestureGeneration: input.gestureGeneration,
    cloneGeneration: 0, clone: null, target: null, sampleSequence: 0, fence: { ...input.fence } })
}

/** A delayed clear can remove only the generation that scheduled it. */
export function clearPaperFlowDragClone(state: PaperFlowDragState, cloneGeneration: number): PaperFlowDragState | null {
  if (!validPaperFlowDragState(state) || !generation(cloneGeneration)) return null
  if (!state.clone || state.clone.generation !== cloneGeneration) return state
  return deepFreeze({ ...state, altActive: false, clone: null, target: null })
}

/** Accepted samples run threshold, authority/ownership, normalization, Alt, primary, target, then insertion. */
export function samplePaperFlowDrag(state: PaperFlowDragState, input: SamplePaperFlowDragInput): PaperFlowDragState | null {
  if (!validPaperFlowDragState(state) || !exactOwnKeys(input, SAMPLE_PAPER_FLOW_DRAG_KEYS, ['entryGeometry'])) return null
  if (!finitePoint(input.world) || !finitePoint(input.viewport) || !finiteNonnegative(input.timestamp) || input.timestamp < state.currentTime
    || typeof input.resolveTarget !== 'function') return null
  const elapsed = input.timestamp - state.pointerDownTime
  const distanceCssPx = Math.hypot(input.viewport.x - state.pointerDownViewport.x, input.viewport.y - state.pointerDownViewport.y)
  if (!Number.isFinite(distanceCssPx)) return null
  const thresholdCssPx = elapsed > PAPER_FLOW_DRAG_HELD_DELAY_MS ? PAPER_FLOW_DRAG_HELD_THRESHOLD_CSS_PX : PAPER_FLOW_DRAG_EARLY_THRESHOLD_CSS_PX
  const thresholdCrossed = state.thresholdCrossed || distanceCssPx >= thresholdCssPx
  const authority = input.authority
  if (!authority || authority.owned !== true || authority.gestureGeneration !== state.gestureGeneration || !validFence(authority) || !sameFence(authority, state.fence)) return null
  const modifiers = normalizeFlowDragModifiers(input.modifiers, input.platform)
  if (!modifiers) return null

  let cloneGeneration = state.cloneGeneration
  let clone = state.clone
  const activatesClone = modifiers.alt && thresholdCrossed && (!state.altActive || !state.thresholdCrossed)
  if (activatesClone) {
      cloneGeneration += 1
      const entryMode = thresholdCrossed && state.primaryActive ? 'absolute' : 'flow'
      const entryGeometry = entryMode === 'absolute' && own(input, 'entryGeometry') ? input.entryGeometry ?? null : null
      if (entryMode === 'absolute' && (!entryGeometry || !finiteRect(entryGeometry))) return null
      clone = deepFreeze({ generation: cloneGeneration, entryMode, entryGeometry: entryGeometry ? { ...entryGeometry } : null,
        sourceRelationship: structuredClone(state.sourceRelationship), sourceIndex: state.sourceIndex, startedAtWorld: { ...input.world } })
  } else if (!modifiers.alt && state.altActive) clone = null

  const primaryActive = thresholdCrossed ? modifiers.primary : false
  const sampleSequence = state.sampleSequence + 1
  const edgeState = deepFreeze({ ...state, currentWorld: samePoint(input.world, state.currentWorld) ? state.currentWorld : { ...input.world },
    currentViewport: samePoint(input.viewport, state.currentViewport) ? state.currentViewport : { ...input.viewport }, currentTime: input.timestamp,
    originalMode: primaryActive ? 'absolute' as const : 'flow' as const, altActive: modifiers.alt, primaryActive, thresholdCrossed,
    cloneGeneration, clone, target: null, sampleSequence })
  const target = thresholdCrossed ? input.resolveTarget(edgeState) : null
  if (target && !validTarget(target, edgeState)) return null
  return deepFreeze({ ...edgeState, target: target ? structuredClone(target) : null })
}

/** Compatibility seam for the current terminal-intent integration. */
export function beginFlowDrag(nodeId: string, pointerDownWorld: Readonly<Point>): LegacyFlowDragState | null {
  if (!validId(nodeId) || !finitePoint(pointerDownWorld)) return null
  const point = Object.freeze({ ...pointerDownWorld })
  return Object.freeze({ nodeId, pointerDownWorld: point, currentWorld: point, initialMode: 'flow', originalMode: 'flow', altActive: false,
    primaryActive: false, generation: 0, clone: null, selection: Object.freeze([nodeId]) as readonly [string] })
}

/** Compatibility seam for the current terminal-intent integration. */
export function sampleFlowDrag(state: LegacyFlowDragState, world: Readonly<Point>, modifiers: FlowDragModifiers): LegacyFlowDragState | null {
  if (!validFlowDragState(state) || !finitePoint(world) || !modifiers || typeof modifiers.alt !== 'boolean' || typeof modifiers.primary !== 'boolean') return null
  let generation = state.generation
  let clone = state.clone
  if (modifiers.alt !== state.altActive) {
    if (modifiers.alt) { generation += 1; clone = Object.freeze({ generation, mode: state.primaryActive ? 'absolute' : 'flow', startedAtWorld: Object.freeze({ ...world }) }) }
    else clone = null
  }
  const point = samePoint(world, state.currentWorld) ? state.currentWorld : Object.freeze({ ...world })
  return Object.freeze({ nodeId: state.nodeId, pointerDownWorld: state.pointerDownWorld, currentWorld: point, initialMode: 'flow',
    originalMode: modifiers.primary ? 'absolute' : 'flow', altActive: modifiers.alt, primaryActive: modifiers.primary, generation, clone, selection: state.selection })
}
