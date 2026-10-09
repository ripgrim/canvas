/**
 * Schema v4 node layout: strict tagged unions instead of CSS strings, validated deny-by-default and bounded, with
 * pure helpers for sizing classification/transitions, stale-field normalization, CSS longhand projection, and the
 * adapters that keep the legacy five-field placement (`mode`, `x`, `y`, `width`, `height`) working on top of it.
 * Nothing here touches the DOM; the browser remains the layout engine.
 */
import { fields, record } from './document.js'
import type { DocumentNodeLayout } from './document.js'
import { validateGridTrack } from './grid-tracks.js'
import type { GridTrack } from './grid-tracks.js'

const limit = 1_000_000
export const expressionLimit = 256
const own = (object: object, key: string) => Object.hasOwn(object, key)
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max

// Lengths -------------------------------------------------------------------------------------------------------------

export type IntrinsicKeyword = 'fit-content' | 'min-content' | 'max-content'
export const intrinsicKeywords: readonly IntrinsicKeyword[] = ['fit-content', 'min-content', 'max-content']
export type LayoutLength =
  | { kind: 'px'; value: number }
  | { kind: 'percent'; value: number }
  | { kind: 'intrinsic'; value: IntrinsicKeyword }
  | { kind: 'auto' }
  | { kind: 'expression'; raw: string }
export type InsetLength = Extract<LayoutLength, { kind: 'px' | 'percent' }>
export type LayoutValidationOptions = {
  /** Calculate (authored expressions) stays disabled until its grammar and source serialization are secure. */
  expressions?: boolean
}
export type LengthRules = { allowNegative?: boolean; allowIntrinsic?: boolean; allowAuto?: boolean; maxPercent?: number }
const safeExpression = /^[0-9a-z%.()+\-*/ ,]*$/i

export const px = (value: number): InsetLength => ({ kind: 'px', value })
export const percent = (value: number): InsetLength => ({ kind: 'percent', value })
export const autoLength: LayoutLength = { kind: 'auto' }
export const intrinsic = (value: IntrinsicKeyword = 'fit-content'): LayoutLength => ({ kind: 'intrinsic', value })

export function validateLength(value: unknown, rules: LengthRules = {}, options: LayoutValidationOptions = {}): value is LayoutLength {
  if (!record(value) || typeof value.kind !== 'string') return false
  const min = rules.allowNegative ? -limit : 0
  switch (value.kind) {
    case 'px': return keys(value, ['kind', 'value']) && finite(value.value, min, limit)
    case 'percent': return keys(value, ['kind', 'value']) && finite(value.value, rules.allowNegative ? -(rules.maxPercent ?? 10_000) : 0, rules.maxPercent ?? 10_000)
    case 'intrinsic': return rules.allowIntrinsic !== false && keys(value, ['kind', 'value']) && (intrinsicKeywords as readonly unknown[]).includes(value.value)
    case 'auto': return rules.allowAuto !== false && keys(value, ['kind'])
    case 'expression': return options.expressions === true && keys(value, ['kind', 'raw']) && typeof value.raw === 'string' && value.raw.length > 0 && value.raw.length <= expressionLimit && safeExpression.test(value.raw) && balanced(value.raw)
    default: return false
  }
}
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => own(value, key))
function balanced(raw: string): boolean {
  let depth = 0
  for (const char of raw) { if (char === '(') depth += 1; else if (char === ')') { depth -= 1; if (depth < 0) return false } }
  return depth === 0
}

export function lengthToCss(length: LayoutLength | undefined): string | null {
  if (!length) return null
  switch (length.kind) {
    case 'px': return `${length.value}px`
    case 'percent': return `${length.value}%`
    case 'intrinsic': return length.value
    case 'auto': return 'auto'
    case 'expression': return `calc(${length.raw})`
  }
}
export const sameLength = (left: LayoutLength | undefined, right: LayoutLength | undefined): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

// Sizing --------------------------------------------------------------------------------------------------------------

export type AxisSize = { value: LayoutLength; min?: LayoutLength; max?: LayoutLength }
export type SizingMode = 'fixed' | 'relative' | 'hug' | 'fill' | 'auto' | 'calculate'
export const sizingModes: readonly SizingMode[] = ['fixed', 'relative', 'hug', 'fill', 'auto', 'calculate']
/** What the node and its surroundings offer; drives which modes the inspector may offer (Paper's intersection rule). */
export type SizingContext = { hasParent: boolean; intrinsicContent: boolean; expressions?: boolean }

const sizeRules: LengthRules = { maxPercent: 100 }
const boundRules: LengthRules = { maxPercent: 10_000, allowIntrinsic: true, allowAuto: true }
export function validateAxisSize(value: unknown, options: LayoutValidationOptions = {}): value is AxisSize {
  if (!record(value)) return false
  fields(value, ['value', ...(own(value, 'min') ? ['min'] : []), ...(own(value, 'max') ? ['max'] : [])], 'axis size')
  if (!validateLength(value.value, sizeRules, options)) return false
  for (const key of ['min', 'max'] as const) if (own(value, key) && !validateLength(value[key], boundRules, options)) return false
  return true
}

/** `100%` is always Fill; any other percent is Relative; intrinsic keywords are Hug; a missing length is Auto. */
export function classifySizing(length: LayoutLength | undefined): SizingMode {
  if (!length) return 'auto'
  switch (length.kind) {
    case 'px': return 'fixed'
    case 'percent': return length.value === 100 ? 'fill' : 'relative'
    case 'intrinsic': return 'hug'
    case 'auto': return 'auto'
    case 'expression': return 'calculate'
  }
}

export function availableSizingModes(context: SizingContext): SizingMode[] {
  const modes: SizingMode[] = ['fixed']
  if (context.hasParent) modes.push('relative', 'fill')
  if (context.intrinsicContent) modes.push('hug')
  if (context.hasParent || context.intrinsicContent) modes.push('auto')
  if (context.expressions) modes.push('calculate')
  return modes
}

export type SizingTransition = {
  /** The length stored today, if any. */
  current?: LayoutLength | undefined
  /** Measured border-box size on this axis in px, when the preview has one. */
  measuredPx?: number | undefined
  /** Measured parent content-box size on this axis in px, when available and positive. */
  parentPx?: number | undefined
}
const positive = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The length a sizing mode change should store. Mirrors the observed Wonder transitions: Fixed takes the measured
 * size (fallback 100), Relative keeps a percent or derives the measured/parent ratio clamped to 0..99 (fallback 50),
 * Hug keeps an intrinsic keyword or picks `fit-content`, Fill is exactly `100%`, Auto is `auto`. Never produces NaN.
 */
export function transitionSizing(mode: SizingMode, input: SizingTransition): LayoutLength | null {
  const { current } = input
  switch (mode) {
    case 'fixed': return px(positive(input.measuredPx) ? Math.max(1, Math.round(input.measuredPx)) : current?.kind === 'px' && current.value > 0 ? current.value : 100)
    case 'relative': {
      if (current?.kind === 'percent' && current.value !== 100) return percent(Math.min(99, Math.max(0, Math.round(current.value))))
      if (positive(input.measuredPx) && positive(input.parentPx)) return percent(Math.min(99, Math.max(0, Math.round((input.measuredPx / input.parentPx) * 100))))
      return percent(50)
    }
    case 'hug': return current?.kind === 'intrinsic' ? current : intrinsic('fit-content')
    case 'fill': return percent(100)
    case 'auto': return autoLength
    case 'calculate': {
      if (current?.kind === 'expression') return current
      if (current?.kind === 'px') return { kind: 'expression', raw: `${current.value}px` }
      if (current?.kind === 'percent') return { kind: 'expression', raw: `${current.value}%` }
      if (positive(input.measuredPx)) return { kind: 'expression', raw: `${Math.round(input.measuredPx)}px` }
      return null
    }
  }
}

/** Multi-selection: every node transitions with its own measurement; Relative skips nodes with no positive parent. */
export function transitionSizingMany(mode: SizingMode, inputs: readonly ({ id: string } & SizingTransition)[]): { id: string; length: LayoutLength }[] {
  const results: { id: string; length: LayoutLength }[] = []
  for (const input of inputs) {
    if (mode === 'relative' && !positive(input.parentPx) && input.current?.kind !== 'percent') continue
    const length = transitionSizing(mode, input)
    if (length) results.push({ id: input.id, length })
  }
  return results
}

export function axisSizeToCss(axis: AxisSize | undefined, property: 'width' | 'height'): Record<string, string | null> {
  const capital = property === 'width' ? 'Width' : 'Height'
  // Missing min/max stay null: the component stylesheet keeps its own bounds until the user authors one (Wonder writes auto/none; here the component is the baseline).
  return { [property]: lengthToCss(axis?.value), [`min${capital}`]: axis?.min ? lengthToCss(axis.min) : null, [`max${capital}`]: axis?.max ? lengthToCss(axis.max) : null }
}

// Spacing -------------------------------------------------------------------------------------------------------------

export type SpacingSides<T> = { top: T; right: T; bottom: T; left: T }
export type SpacingValue = number | { x: number; y: number } | SpacingSides<number>
export type MarginSide = number | 'auto'
export type MarginValue = MarginSide | { x: MarginSide; y: MarginSide } | SpacingSides<MarginSide>
export type NodeSpacing = { padding?: SpacingValue; margin?: MarginValue }

function validateSpacingValue(value: unknown, allowAuto: boolean, allowNegative: boolean): boolean {
  const side = (part: unknown) => (allowAuto && part === 'auto') || finite(part, allowNegative ? -limit : 0, limit)
  if (side(value)) return true
  if (!record(value)) return false
  const names = Object.keys(value).sort().join(',')
  if (names === 'x,y') return side(value.x) && side(value.y)
  if (names === 'bottom,left,right,top') return ['top', 'right', 'bottom', 'left'].every(key => side(value[key]))
  return false
}
export function validateSpacing(value: unknown): value is NodeSpacing {
  if (!record(value)) return false
  fields(value, [...(own(value, 'padding') ? ['padding'] : []), ...(own(value, 'margin') ? ['margin'] : [])], 'spacing')
  if (own(value, 'padding') && !validateSpacingValue(value.padding, false, false)) return false
  if (own(value, 'margin') && !validateSpacingValue(value.margin, true, true)) return false
  return true
}

export function spacingSides<T extends number | string>(value: T | { x: T; y: T } | SpacingSides<T>): SpacingSides<T> {
  if (typeof value !== 'object' || value === null) return { top: value, right: value, bottom: value, left: value }
  if ('x' in value) return { top: value.y, right: value.x, bottom: value.y, left: value.x }
  const sides = value as SpacingSides<T>
  return { top: sides.top, right: sides.right, bottom: sides.bottom, left: sides.left }
}
/** Always writes all four longhands so a zero clears whatever the component stylesheet left behind. */
export function spacingToCss(value: SpacingValue | MarginValue | undefined, property: 'padding' | 'margin'): Record<string, string | null> {
  const sides = value === undefined ? null : spacingSides<MarginSide>(value)
  const css = (side: MarginSide) => side === 'auto' ? 'auto' : `${side}px`
  return { [`${property}Top`]: sides ? css(sides.top) : null, [`${property}Right`]: sides ? css(sides.right) : null, [`${property}Bottom`]: sides ? css(sides.bottom) : null, [`${property}Left`]: sides ? css(sides.left) : null }
}

// Containers ----------------------------------------------------------------------------------------------------------

export type DisplayMode = 'freeform' | 'block' | 'flex' | 'grid'
export const displayModes: readonly DisplayMode[] = ['freeform', 'block', 'flex', 'grid']
export type FlexDirection = 'row' | 'row-reverse' | 'column' | 'column-reverse'
export type FlexWrap = 'nowrap' | 'wrap' | 'wrap-reverse'
export type MainDistribution = 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly'
export type CrossAlignment = 'start' | 'center' | 'end' | 'stretch' | 'baseline'
export type ContentDistribution = 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly'
export type ItemAlignment = 'start' | 'center' | 'end' | 'stretch'
export type LayoutGap = number | { x: number; y: number }
export type FlexContainer = { direction: FlexDirection; wrap: FlexWrap; justify: MainDistribution; align: CrossAlignment; alignContent?: ContentDistribution }
export type GridContainer = { columns: GridTrack[]; rows: GridTrack[]; autoFlow: 'row' | 'column'; justifyItems?: ItemAlignment; alignItems?: ItemAlignment; justifyContent?: ContentDistribution; alignContent?: ContentDistribution }
export type LayoutContainer = { display: DisplayMode; overflow?: 'visible' | 'hidden' | 'clip' | 'auto' | 'scroll'; gap?: LayoutGap; flex?: FlexContainer; grid?: GridContainer }

export const flexDirections: readonly FlexDirection[] = ['row', 'row-reverse', 'column', 'column-reverse']
export const flexWraps: readonly FlexWrap[] = ['nowrap', 'wrap', 'wrap-reverse']
export const mainDistributions: readonly MainDistribution[] = ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly']
export const crossAlignments: readonly CrossAlignment[] = ['start', 'center', 'end', 'stretch', 'baseline']
export const contentDistributions: readonly ContentDistribution[] = ['start', 'center', 'end', 'stretch', 'space-between', 'space-around', 'space-evenly']
export const itemAlignments: readonly ItemAlignment[] = ['start', 'center', 'end', 'stretch']
export const maxGridTracks = 200
const oneOf = <T>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value)
const optionalKeys = (value: Record<string, unknown>, required: string[], optional: string[], label: string) => fields(value, [...required, ...optional.filter(key => own(value, key))], label)

function validateGap(value: unknown): value is LayoutGap {
  if (finite(value, 0, limit)) return true
  return record(value) && Object.keys(value).sort().join(',') === 'x,y' && finite(value.x, 0, limit) && finite(value.y, 0, limit)
}
export function validateFlexContainer(value: unknown): value is FlexContainer {
  if (!record(value)) return false
  optionalKeys(value, ['direction', 'wrap', 'justify', 'align'], ['alignContent'], 'flex container')
  return oneOf(flexDirections, value.direction) && oneOf(flexWraps, value.wrap) && oneOf(mainDistributions, value.justify) && oneOf(crossAlignments, value.align) && (!own(value, 'alignContent') || oneOf(contentDistributions, value.alignContent))
}
export function validateGridContainer(value: unknown): value is GridContainer {
  if (!record(value)) return false
  optionalKeys(value, ['columns', 'rows', 'autoFlow'], ['justifyItems', 'alignItems', 'justifyContent', 'alignContent'], 'grid container')
  for (const axis of ['columns', 'rows'] as const) {
    const tracks = value[axis]
    if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > maxGridTracks || !tracks.every(track => validateGridTrack(track))) return false
  }
  if (!oneOf(['row', 'column'] as const, value.autoFlow)) return false
  for (const key of ['justifyItems', 'alignItems'] as const) if (own(value, key) && !oneOf(itemAlignments, value[key])) return false
  for (const key of ['justifyContent', 'alignContent'] as const) if (own(value, key) && !oneOf(contentDistributions, value[key])) return false
  return true
}
export function validateContainer(value: unknown): value is LayoutContainer {
  if (!record(value)) return false
  optionalKeys(value, ['display'], ['overflow', 'gap', 'flex', 'grid'], 'layout container')
  if (!oneOf(displayModes, value.display)) return false
  if (own(value, 'overflow') && !oneOf(['visible', 'hidden', 'clip', 'auto', 'scroll'] as const, value.overflow)) return false
  if (own(value, 'gap') && !validateGap(value.gap)) return false
  if (own(value, 'flex') && !validateFlexContainer(value.flex)) return false
  if (own(value, 'grid') && !validateGridContainer(value.grid)) return false
  // Mode-specific records only belong to their own mode, so a stored container never carries stale state.
  if (own(value, 'flex') && value.display !== 'flex') return false
  if (own(value, 'grid') && value.display !== 'grid') return false
  if (own(value, 'gap') && value.display !== 'flex' && value.display !== 'grid') return false
  if (value.display === 'flex' && !own(value, 'flex')) return false
  if (value.display === 'grid' && !own(value, 'grid')) return false
  return true
}

export const defaultFlexContainer: FlexContainer = { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' }
export const defaultGridContainer = (): GridContainer => ({ columns: [{ kind: 'fr', value: 1 }], rows: [{ kind: 'auto' }], autoFlow: 'row' })

// Items ---------------------------------------------------------------------------------------------------------------

export type PositionMode = 'flow' | 'absolute'
export type NodePosition = { mode: PositionMode; left?: InsetLength; right?: InsetLength; top?: InsetLength; bottom?: InsetLength; zIndex?: number }
export type FlexItem = { grow?: number; shrink?: number; basis?: LayoutLength }
export type GridItem = { columnStart?: number; rowStart?: number; columnSpan?: number; rowSpan?: number; justifySelf?: ItemAlignment; alignSelf?: ItemAlignment }
export type NodeTransform = { rotate?: number; scale?: number | { x: number; y: number } }
export type LayoutItem = { position: NodePosition; width?: AxisSize; height?: AxisSize; aspectRatio?: number; flex?: FlexItem; grid?: GridItem; transform?: NodeTransform }
/** The v4 layout record stored on component nodes. `item` describes the node; `container` only exists for containers. */
export type NodeLayout = { item: LayoutItem; container?: LayoutContainer; spacing?: NodeSpacing }
export const maxGridLine = 1000
const insetRules: LengthRules = { allowNegative: true, allowIntrinsic: false, allowAuto: false }

export function validatePosition(value: unknown, options: LayoutValidationOptions = {}): value is NodePosition {
  if (!record(value)) return false
  optionalKeys(value, ['mode'], ['left', 'right', 'top', 'bottom', 'zIndex'], 'node position')
  if (!oneOf(['flow', 'absolute'] as const, value.mode)) return false
  for (const key of ['left', 'right', 'top', 'bottom'] as const) {
    if (!own(value, key)) continue
    if (value.mode !== 'absolute' || !validateLength(value[key], insetRules, options)) return false
  }
  if (own(value, 'zIndex') && (value.mode !== 'absolute' || !integer(value.zIndex, -10_000, 10_000))) return false
  return true
}
export function validateFlexItem(value: unknown, options: LayoutValidationOptions = {}): value is FlexItem {
  if (!record(value)) return false
  optionalKeys(value, [], ['grow', 'shrink', 'basis'], 'flex item')
  for (const key of ['grow', 'shrink'] as const) if (own(value, key) && !finite(value[key], 0, 1000)) return false
  return !own(value, 'basis') || validateLength(value.basis, { allowIntrinsic: true, allowAuto: true, maxPercent: 10_000 }, options)
}
export function validateGridItem(value: unknown): value is GridItem {
  if (!record(value)) return false
  optionalKeys(value, [], ['columnStart', 'rowStart', 'columnSpan', 'rowSpan', 'justifySelf', 'alignSelf'], 'grid item')
  for (const key of ['columnStart', 'rowStart', 'columnSpan', 'rowSpan'] as const) if (own(value, key) && !integer(value[key], 1, maxGridLine)) return false
  for (const key of ['justifySelf', 'alignSelf'] as const) if (own(value, key) && !oneOf(itemAlignments, value[key])) return false
  return true
}
export function validateTransform(value: unknown): value is NodeTransform {
  if (!record(value)) return false
  optionalKeys(value, [], ['rotate', 'scale'], 'node transform')
  if (own(value, 'rotate') && !finite(value.rotate, -3600, 3600)) return false
  if (own(value, 'scale') && !(finite(value.scale, -1000, 1000) || (record(value.scale) && Object.keys(value.scale).sort().join(',') === 'x,y' && finite(value.scale.x, -1000, 1000) && finite(value.scale.y, -1000, 1000)))) return false
  return true
}
export function validateItem(value: unknown, options: LayoutValidationOptions = {}): value is LayoutItem {
  if (!record(value)) return false
  optionalKeys(value, ['position'], ['width', 'height', 'aspectRatio', 'flex', 'grid', 'transform'], 'layout item')
  if (!validatePosition(value.position, options)) return false
  for (const key of ['width', 'height'] as const) if (own(value, key) && !validateAxisSize(value[key], options)) return false
  if (own(value, 'aspectRatio') && !finite(value.aspectRatio, 1e-6, limit)) return false
  if (own(value, 'flex') && !validateFlexItem(value.flex, options)) return false
  if (own(value, 'grid') && !validateGridItem(value.grid)) return false
  if (own(value, 'transform') && !validateTransform(value.transform)) return false
  return true
}
/** Validates a stored v4 layout. Throws on unknown keys (via `fields`) and returns false on any bad value. */
export function validateLayout(value: unknown, options: LayoutValidationOptions = {}): value is NodeLayout {
  if (!record(value)) return false
  optionalKeys(value, ['item'], ['container', 'spacing'], 'node layout')
  if (!validateItem(value.item, options)) return false
  if (own(value, 'container') && !validateContainer(value.container)) return false
  if (own(value, 'spacing') && !validateSpacing(value.spacing)) return false
  return true
}
/** Same checks, but malformed shapes (including unknown keys) return false instead of throwing. */
export function isValidLayout(value: unknown, options: LayoutValidationOptions = {}): value is NodeLayout {
  try { return validateLayout(value, options) } catch { return false }
}

// Normalization -------------------------------------------------------------------------------------------------------

const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, part]) => part !== undefined)) as T

/** Drops container state that does not belong to the display mode (Wonder's cleanup maps) and fills required records. */
export function normalizeContainer(container: LayoutContainer): LayoutContainer {
  const next: LayoutContainer = { display: container.display, ...(container.overflow !== undefined ? { overflow: container.overflow } : {}) }
  if (container.display === 'flex') { next.flex = container.flex ?? defaultFlexContainer; if (container.gap !== undefined) next.gap = container.gap }
  if (container.display === 'grid') { next.grid = container.grid ?? defaultGridContainer(); if (container.gap !== undefined) next.gap = container.gap }
  return next
}
/** Flow items keep no insets or z-index; items only keep flex or grid fields when the parent uses that mode. */
export function normalizeItem(item: LayoutItem, parentDisplay: DisplayMode | null): LayoutItem {
  const position: NodePosition = item.position.mode === 'absolute' ? { ...item.position } : { mode: 'flow' }
  const next: LayoutItem = { ...item, position }
  if (parentDisplay !== 'flex') delete next.flex
  if (parentDisplay !== 'grid') delete next.grid
  if (next.flex && Object.keys(next.flex).length === 0) delete next.flex
  if (next.grid && Object.keys(next.grid).length === 0) delete next.grid
  return compact(next)
}
export function normalizeLayout(layout: NodeLayout, parentDisplay: DisplayMode | null): NodeLayout {
  const next: NodeLayout = { item: normalizeItem(layout.item, parentDisplay) }
  if (layout.container) next.container = normalizeContainer(layout.container)
  if (layout.spacing && (layout.spacing.padding !== undefined || layout.spacing.margin !== undefined)) next.spacing = compact({ ...layout.spacing })
  return next
}
export const containerDisplay = (layout: NodeLayout | undefined): DisplayMode | null => layout?.container?.display ?? null

/**
 * Flex children with a definite main-axis length stop shrinking unless an explicit triple was authored; a newly
 * definite main axis also clears stale grow and basis (observed Wonder rule).
 */
export function applyDefiniteMainAxis(item: LayoutItem, direction: FlexDirection): LayoutItem {
  const axis = direction.startsWith('row') ? item.width?.value : item.height?.value
  const definite = axis !== undefined && (axis.kind === 'px' || axis.kind === 'percent')
  if (!definite) return item
  const flex = item.flex ?? {}
  const explicitTriple = flex.grow !== undefined && flex.shrink !== undefined && flex.basis !== undefined
  if (explicitTriple) return item
  return { ...item, flex: { shrink: 0 } }
}

// CSS projection ------------------------------------------------------------------------------------------------------

export type StyleProjection = Record<string, string | null>
const gapToCss = (gap: LayoutGap | undefined): StyleProjection => gap === undefined ? { columnGap: null, rowGap: null } : typeof gap === 'number' ? { columnGap: `${gap}px`, rowGap: `${gap}px` } : { columnGap: `${gap.x}px`, rowGap: `${gap.y}px` }
const css = (value: string | undefined) => value === undefined ? null : value === 'start' || value === 'end' ? `flex-${value}` : value
const plain = (value: string | undefined) => value ?? null

/** Longhand declarations for a container; `null` clears the longhand so stale stylesheet state cannot leak through. */
export function projectContainerStyle(container: LayoutContainer | undefined): StyleProjection {
  const projection: StyleProjection = { display: null, flexDirection: null, flexWrap: null, justifyContent: null, alignItems: null, alignContent: null, justifyItems: null, gridTemplateColumns: null, gridTemplateRows: null, gridAutoFlow: null, overflow: null, ...gapToCss(undefined) }
  if (!container) return projection
  if (container.overflow) projection.overflow = container.overflow
  switch (container.display) {
    case 'freeform': return projection
    case 'block': return { ...projection, display: 'block' }
    case 'flex': {
      const flex = container.flex ?? defaultFlexContainer
      return { ...projection, ...gapToCss(container.gap), display: 'flex', flexDirection: flex.direction, flexWrap: flex.wrap, justifyContent: css(flex.justify), alignItems: css(flex.align), alignContent: css(flex.alignContent) }
    }
    case 'grid': {
      const grid = container.grid ?? defaultGridContainer()
      return { ...projection, ...gapToCss(container.gap), display: 'grid', gridTemplateColumns: grid.columns.map(track => trackCss(track)).join(' '), gridTemplateRows: grid.rows.map(track => trackCss(track)).join(' '), gridAutoFlow: grid.autoFlow, justifyItems: plain(grid.justifyItems), alignItems: plain(grid.alignItems), justifyContent: plain(grid.justifyContent), alignContent: plain(grid.alignContent) }
    }
  }
}
function trackCss(track: GridTrack): string {
  switch (track.kind) {
    case 'px': return `${track.value}px`
    case 'percent': return `${track.value}%`
    case 'fr': return `${track.value}fr`
    case 'auto': return 'auto'
    case 'minmax': return `minmax(${trackCss(track.min)}, ${trackCss(track.max)})`
  }
}

/** Longhand declarations for an item in a parent of `parentDisplay`. Flow nodes clear every inset. */
export function projectItemStyle(item: LayoutItem, parentDisplay: DisplayMode | null): StyleProjection {
  const projection: StyleProjection = { position: null, left: null, right: null, top: null, bottom: null, zIndex: null, flexGrow: null, flexShrink: null, flexBasis: null, gridColumnStart: null, gridColumnEnd: null, gridRowStart: null, gridRowEnd: null, justifySelf: null, alignSelf: null, aspectRatio: null, transform: null, ...axisSizeToCss(item.width, 'width'), ...axisSizeToCss(item.height, 'height') }
  if (item.position.mode === 'absolute') {
    projection.position = 'absolute'
    for (const key of ['left', 'right', 'top', 'bottom'] as const) projection[key] = lengthToCss(item.position[key])
    if (item.position.zIndex !== undefined) projection.zIndex = String(item.position.zIndex)
  }
  if (item.aspectRatio !== undefined) projection.aspectRatio = String(item.aspectRatio)
  if (parentDisplay === 'flex' && item.flex) {
    if (item.flex.grow !== undefined) projection.flexGrow = String(item.flex.grow)
    if (item.flex.shrink !== undefined) projection.flexShrink = String(item.flex.shrink)
    if (item.flex.basis !== undefined) projection.flexBasis = item.flex.basis.kind === 'px' && item.flex.basis.value === 0 ? '0%' : lengthToCss(item.flex.basis)
  }
  if (parentDisplay === 'grid' && item.grid) {
    const column = gridLine(item.grid.columnStart, item.grid.columnSpan), row = gridLine(item.grid.rowStart, item.grid.rowSpan)
    projection.gridColumnStart = column.start; projection.gridColumnEnd = column.end
    projection.gridRowStart = row.start; projection.gridRowEnd = row.end
    projection.justifySelf = plain(item.grid.justifySelf); projection.alignSelf = plain(item.grid.alignSelf)
  }
  if (item.transform) {
    const parts: string[] = []
    if (item.transform.rotate) parts.push(`rotate(${item.transform.rotate}deg)`)
    if (item.transform.scale !== undefined) parts.push(typeof item.transform.scale === 'number' ? `scale(${item.transform.scale})` : `scale(${item.transform.scale.x}, ${item.transform.scale.y})`)
    if (parts.length) projection.transform = parts.join(' ')
  }
  return projection
}
/** Exact partial-start projection: start N (+ `span S` end when S > 1), or `span S` start with no end, or nothing. */
export function gridLine(start: number | undefined, span: number | undefined): { start: string | null; end: string | null } {
  const count = integer(span, 2, maxGridLine) ? span : 1
  if (integer(start, 1, maxGridLine)) return { start: String(start), end: count > 1 ? `span ${count}` : null }
  return { start: count > 1 ? `span ${count}` : null, end: null }
}
export function projectSpacingStyle(spacing: NodeSpacing | undefined): StyleProjection {
  return { ...spacingToCss(spacing?.padding, 'padding'), ...spacingToCss(spacing?.margin, 'margin') }
}

// Legacy adapters -----------------------------------------------------------------------------------------------------

/** The five-field placement the runtime, inspector, and preview projection still consume, derived from v4. */
export function legacyLayout(layout: NodeLayout | undefined): DocumentNodeLayout {
  if (!layout) return { mode: 'flow', x: 0, y: 0 }
  const { item } = layout
  const result: DocumentNodeLayout = { mode: item.position.mode, x: item.position.left?.kind === 'px' ? item.position.left.value : 0, y: item.position.top?.kind === 'px' ? item.position.top.value : 0 }
  if (item.width?.value.kind === 'px') result.width = item.width.value.value
  if (item.height?.value.kind === 'px') result.height = item.height.value.value
  return result
}
/** Writes a five-field placement into a v4 record, keeping container, spacing and the item's other fields intact. */
export function layoutFromLegacy(legacy: DocumentNodeLayout, previous?: NodeLayout): NodeLayout {
  const item: LayoutItem = { ...(previous?.item ?? {}), position: legacy.mode === 'absolute' ? { ...(previous?.item.position.mode === 'absolute' ? previous.item.position : {}), mode: 'absolute', left: px(legacy.x), top: px(legacy.y) } : { mode: 'flow' } }
  if (legacy.width !== undefined) item.width = { ...(previous?.item.width ?? {}), value: px(legacy.width) }
  else if (previous?.item.width?.value.kind === 'px') delete item.width
  if (legacy.height !== undefined) item.height = { ...(previous?.item.height ?? {}), value: px(legacy.height) }
  else if (previous?.item.height?.value.kind === 'px') delete item.height
  const next: NodeLayout = { item }
  if (previous?.container) next.container = previous.container
  if (previous?.spacing) next.spacing = previous.spacing
  return next
}
/** True when a v4 record carries nothing beyond what the five-field placement expresses. */
export function isLegacyOnlyLayout(layout: NodeLayout): boolean {
  if (layout.container || layout.spacing) return false
  const { item } = layout
  if (item.aspectRatio !== undefined || item.flex || item.grid || item.transform) return false
  const position = item.position
  if (position.right || position.bottom || position.zIndex !== undefined || (position.left && position.left.kind !== 'px') || (position.top && position.top.kind !== 'px')) return false
  for (const axis of [item.width, item.height]) if (axis && (axis.min || axis.max || axis.value.kind !== 'px')) return false
  return true
}
