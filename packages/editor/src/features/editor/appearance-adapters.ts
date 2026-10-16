/**
 * Pure selection logic for the appearance inspector: eligibility, aggregation across a multi-selection, mixed states,
 * and per-node patches. Fills are stored bottom to top; the inspector lists them top to bottom.
 */
import { borderSides, canonicalAppearance, canonicalBorders, eligibleSections } from '@canvas/repo-engine/appearance'
import type { Appearance, AppearanceKind, AppearanceSection, BlendMode, BorderSide, Borders, ColorValue, GradientPaint, GradientStop, Outline, Paint, SolidPaint, Stroke } from '@canvas/repo-engine/appearance'
import { resolveToken } from '@canvas/repo-engine/file-document'
import type { ColorToken, FileDocument, FileNode, FileTheme, FileToken, SourcePalette } from '@canvas/repo-engine/file-document'
import type { Color } from '@canvas/repo-engine/color'
import { compareOrder } from '@canvas/repo-engine/order-keys'
import { formatHex, hslToRgb, parseColor, rgbToHsl } from './color'

export type StyledNode = Exclude<FileNode, { type: 'root' }>
export type Aggregate<T, M = never> =
  | { state: 'absent' }
  | { state: 'uniform'; value: T }
  | { state: 'field-mixed'; value: T; mixed: M }
  | { state: 'structure-mixed'; value: T }

export const sectionOrder: readonly AppearanceSection[] = ['blending', 'fill', 'outline', 'border']

export const appearanceKind = (node: FileNode): AppearanceKind | null => node.type === 'root' ? null : node.type

/** Sections every selected node supports, in inspector order. */
export function eligibleFor(nodes: readonly FileNode[]): AppearanceSection[] {
  if (!nodes.length) return []
  return sectionOrder.filter(section => nodes.every(node => { const kind = appearanceKind(node); return kind !== null && eligibleSections(kind).includes(section) }))
}

/** The appearance the inspector should show: a live gesture override wins over the stored record. */
export function effectiveAppearance(node: FileNode, overrides: Record<string, Appearance | null> | null): Appearance | undefined {
  if (node.type === 'root') return undefined
  if (overrides && Object.hasOwn(overrides, node.id)) return overrides[node.id] ?? undefined
  return node.appearance
}

/** JSON with sorted keys so equal records compare equal regardless of key order. */
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
const differs = (values: readonly unknown[]) => values.some(value => stableKey(value) !== stableKey(values[0]))

// Blending ---------------------------------------------------------------------------------------------------------

export type Blending = { visible: boolean; opacity: number; blendMode: BlendMode }
export type BlendingField = keyof Blending
export const blendingOf = (appearance: Appearance | undefined): Blending => ({ visible: appearance?.visible !== false, opacity: appearance?.opacity ?? 1, blendMode: appearance?.blendMode ?? 'normal' })

export function aggregateBlending(list: readonly (Appearance | undefined)[]): Aggregate<Blending, BlendingField[]> {
  if (!list.length) return { state: 'absent' }
  const values = list.map(blendingOf)
  const mixed = (['visible', 'opacity', 'blendMode'] as const).filter(field => differs(values.map(value => value[field])))
  return mixed.length ? { state: 'field-mixed', value: values[0]!, mixed } : { state: 'uniform', value: values[0]! }
}

/** Grouped as in Paper's blend menu; separators fall between groups. */
export const blendModeGroups: readonly (readonly BlendMode[])[] = [
  ['normal'],
  ['darken', 'multiply', 'color-burn'],
  ['lighten', 'screen', 'plus-lighter', 'color-dodge'],
  ['overlay', 'soft-light', 'hard-light'],
  ['difference', 'exclusion'],
  ['hue', 'saturation', 'color', 'luminosity'],
]

// Fills -------------------------------------------------------------------------------------------------------------

export type FillField = 'type' | 'visible' | 'blendMode' | 'color' | 'opacity' | 'shape' | 'angle' | 'center' | 'length' | 'interpolation' | 'stops' | 'assetId' | 'fit' | 'geometry'

/** The user-visible fields of a paint; identities and type caches never count as a difference. */
export function paintFields(paint: Paint): Partial<Record<FillField, unknown>> {
  const shared = { type: paint.type, visible: paint.visible !== false, blendMode: paint.blendMode ?? 'normal' }
  if (paint.type === 'solid') return { ...shared, color: paint.color, opacity: paint.opacity ?? 1 }
  if (paint.type === 'image') return { ...shared, assetId: paint.assetId, fit: paint.fit, geometry: paint.geometry }
  return { ...shared, shape: paint.shape, angle: paint.angle, center: paint.center, length: paint.length, interpolation: paint.interpolation, stops: paint.stops.map(stop => ({ position: stop.position, midpoint: stop.midpoint ?? 0.5, color: stop.color })) }
}

export function changedFillFields(before: Paint, after: Paint): FillField[] {
  const left = paintFields(before)
  const right = paintFields(after)
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])] as FillField[]
  return fields.filter(field => stableKey(left[field]) !== stableKey(right[field]))
}

/**
 * Uniform: every node has the same count and per-index types and equal fields. Field mixed: same structure, some
 * fields differ (`mixed[i]` lists them for storage index i). Structure mixed otherwise; its value is the first non-empty
 * fill list, which "replace mixed fills" copies.
 */
export function aggregateFills(list: readonly (Appearance | undefined)[]): Aggregate<Paint[], FillField[][]> {
  const fills = list.map(appearance => appearance?.fills ?? [])
  if (!fills.length || fills.every(entry => !entry.length)) return { state: 'absent' }
  const first = fills[0]!
  const same = fills.every(entry => entry.length === first.length && entry.every((paint, index) => paint.type === first[index]!.type))
  if (!same) return { state: 'structure-mixed', value: fills.find(entry => entry.length)! }
  const mixed = first.map((paint, index) => {
    const fields = Object.keys(paintFields(paint)) as FillField[]
    return fields.filter(field => differs(fills.map(entry => paintFields(entry[index]!)[field])))
  })
  return mixed.some(fields => fields.length) ? { state: 'field-mixed', value: first, mixed } : { state: 'uniform', value: first }
}

/** UI rows run top to bottom; storage runs bottom to top. The mapping is its own inverse. */
export const storageIndex = (row: number, count: number) => count - 1 - row

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length) return next
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item!)
  return next
}

export const withPaintVisibility = (paint: Paint, visible: boolean): Paint => {
  const { visible: _visible, ...rest } = paint
  return (visible ? rest : { ...rest, visible: false }) as Paint
}
export const withPaintBlend = (paint: Paint, blendMode: BlendMode): Paint => {
  const { blendMode: _blend, ...rest } = paint
  return (blendMode === 'normal' ? rest : { ...rest, blendMode }) as Paint
}
export const withPaintOpacity = (paint: SolidPaint, opacity: number): SolidPaint => {
  const { opacity: _opacity, ...rest } = paint
  return opacity === 1 ? rest : { ...rest, opacity }
}

/**
 * Applies the fields that changed between `before` and `after` onto `target`, keeping the target's other fields and
 * identity. A type change replaces the paint (keeping the target id).
 */
export function mergePaint(target: Paint, before: Paint, after: Paint): Paint {
  if (before.type !== after.type || target.type !== after.type) return { ...structuredClone(after), id: target.id }
  let next: Paint = { ...target }
  for (const field of changedFillFields(before, after)) {
    if (field === 'visible') next = withPaintVisibility(next, after.visible !== false)
    else if (field === 'blendMode') next = withPaintBlend(next, after.blendMode ?? 'normal')
    else if (field === 'opacity' && next.type === 'solid' && after.type === 'solid') next = withPaintOpacity(next, after.opacity ?? 1)
    else (next as Record<string, unknown>)[field] = structuredClone((after as Record<string, unknown>)[field])
  }
  return next
}

/** Replaces the fill at a storage index; returns the appearance unchanged when that fill does not exist. */
export function withFill(appearance: Appearance | undefined, index: number, update: (paint: Paint) => Paint): Appearance | undefined {
  const fills = appearance?.fills
  const paint = fills?.[index]
  if (!fills || !paint) return appearance
  return { ...appearance, fills: fills.map((current, position) => position === index ? update(current) : current) }
}

export function withFills(appearance: Appearance | undefined, fills: Paint[]): Appearance | undefined {
  const { fills: _fills, ...rest } = appearance ?? {}
  return fills.length ? { ...rest, fills } : rest
}

// Strokes, outline, borders -------------------------------------------------------------------------------------------

export type StrokeField = 'color' | 'width' | 'style' | 'visible'
export type OutlineField = StrokeField | 'offset'
const strokeFields = (stroke: Stroke): Record<StrokeField, unknown> => ({ color: stroke.color, width: stroke.width, style: stroke.style, visible: stroke.visible !== false })
const outlineFields = (outline: Outline): Record<OutlineField, unknown> => ({ ...strokeFields(outline), offset: outline.offset })

export function aggregateOutline(list: readonly (Appearance | undefined)[]): Aggregate<Outline, OutlineField[]> {
  const outlines = list.map(appearance => appearance?.outline)
  const present = outlines.filter((outline): outline is Outline => Boolean(outline))
  if (!present.length) return { state: 'absent' }
  if (present.length !== outlines.length) return { state: 'structure-mixed', value: present[0]! }
  const fields = present.map(outlineFields)
  const mixed = (['color', 'width', 'style', 'visible', 'offset'] as const).filter(field => differs(fields.map(value => value[field])))
  return mixed.length ? { state: 'field-mixed', value: present[0]!, mixed } : { state: 'uniform', value: present[0]! }
}

export type BorderKey = BorderSide | 'all'
export type BorderEntry = { side: BorderKey; stroke: Stroke }

/** Canonical border rows: one `all` row, or present sides in top, bottom, left, right order. */
export function borderEntries(borders: Borders | undefined): BorderEntry[] {
  const canonical = canonicalBorders(borders)
  if (!canonical) return []
  if ('all' in canonical && canonical.all) return [{ side: 'all', stroke: canonical.all }]
  const sides = canonical as Partial<Record<BorderSide, Stroke>>
  return borderSides.filter(side => sides[side]).map(side => ({ side, stroke: sides[side]! }))
}

/** Compares canonical forms: equal side sets with differing strokes are field mixed; different side sets are structure mixed. */
export function aggregateBorders(list: readonly (Appearance | undefined)[]): Aggregate<BorderEntry[], StrokeField[][]> {
  const entries = list.map(appearance => borderEntries(appearance?.borders))
  if (!entries.length || entries.every(entry => !entry.length)) return { state: 'absent' }
  const first = entries[0]!
  const sides = (entry: BorderEntry[]) => entry.map(item => item.side).join(',')
  if (!first.length || entries.some(entry => sides(entry) !== sides(first))) return { state: 'structure-mixed', value: entries.find(entry => entry.length)! }
  const mixed = first.map((_, index) => (['color', 'width', 'style', 'visible'] as const).filter(field => differs(entries.map(entry => strokeFields(entry[index]!.stroke)[field]))))
  return mixed.some(fields => fields.length) ? { state: 'field-mixed', value: first, mixed } : { state: 'uniform', value: first }
}

export const entriesToBorders = (entries: readonly BorderEntry[]): Borders | null => {
  if (!entries.length) return null
  const all = entries.find(entry => entry.side === 'all')
  return all ? { all: all.stroke } : Object.fromEntries(entries.map(entry => [entry.side, entry.stroke])) as Borders
}

export const withStrokeVisibility = <T extends Stroke>(stroke: T, visible: boolean): T => {
  const { visible: _visible, ...rest } = stroke
  return (visible ? rest : { ...rest, visible: false }) as T
}

/** Any edit other than the eye turns the stroke back on, as Paper does. */
export const editStroke = <T extends Stroke>(stroke: T, patch: Partial<Omit<T, 'visible'>>): T => withStrokeVisibility({ ...stroke, ...patch }, true)

export function withOutline(appearance: Appearance | undefined, outline: Outline | null): Appearance | undefined {
  const { outline: _outline, ...rest } = appearance ?? {}
  return outline ? { ...rest, outline } : rest
}

/** Replaces one border row's stroke. Rows come from `borderEntries`, so the side exists in canonical form. */
export function withBorder(appearance: Appearance | undefined, side: BorderKey, update: (stroke: Stroke) => Stroke): Appearance | undefined {
  const entries = borderEntries(appearance?.borders)
  if (!entries.some(entry => entry.side === side)) return appearance
  const borders = entriesToBorders(entries.map(entry => entry.side === side ? { side, stroke: update(entry.stroke) } : entry))
  const { borders: _borders, ...rest } = appearance ?? {}
  return borders ? { ...rest, borders } : rest
}

/** Live preview or batch overrides: one canonical appearance (or null) per node. */
export function overridesFor<T extends { id: string; appearance: Appearance | undefined }>(targets: readonly T[], update: (appearance: Appearance | undefined, target: T) => Appearance | undefined): Record<string, Appearance | null> {
  return Object.fromEntries(targets.map(target => [target.id, canonicalAppearance(update(target.appearance, target)) ?? null]))
}

// Gradients ---------------------------------------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits

/** Stop array indexes ordered by position (stable for equal positions). */
export const stopOrder = (stops: readonly GradientStop[]): number[] => stops.map((_, index) => index).sort((left, right) => stops[left]!.position - stops[right]!.position || left - right)

export type MidpointHandle = { stopIndex: number; position: number }
/** A stop's midpoint sits between it and the next stop by position. */
export function midpointHandles(stops: readonly GradientStop[]): MidpointHandle[] {
  const order = stopOrder(stops)
  return order.slice(0, -1).map((index, rank) => {
    const from = stops[index]!
    const to = stops[order[rank + 1]!]!
    return { stopIndex: index, position: round(from.position + (to.position - from.position) * (from.midpoint ?? 0.5)) }
  })
}

/** Converts an absolute track position into the stop's relative midpoint, kept inside the interval. */
export function midpointAt(stops: readonly GradientStop[], stopIndex: number, position: number): number {
  const order = stopOrder(stops)
  const rank = order.indexOf(stopIndex)
  const from = stops[stopIndex]
  const to = stops[order[rank + 1] ?? -1]
  if (!from || !to || to.position <= from.position) return 0.5
  return round(clamp((position - from.position) / (to.position - from.position), 0.01, 0.99))
}

export const withStop = (paint: GradientPaint, stopIndex: number, patch: Partial<Omit<GradientStop, 'id'>>): GradientPaint => ({ ...paint, stops: paint.stops.map((stop, index) => index === stopIndex ? { ...stop, ...patch } : stop) })
export const withoutStop = (paint: GradientPaint, stopIndex: number): GradientPaint => paint.stops.length <= 2 ? paint : { ...paint, stops: paint.stops.filter((_, index) => index !== stopIndex) }

const hexChannels = (hex: string) => { const color = parseColor(hex); return color ? [color.r, color.g, color.b, color.a] : [0, 0, 0, 1] }
/** Straight sRGB interpolation of two #rrggbb[aa] colors. */
export function mixHex(left: string, right: string, amount: number): string {
  const a = hexChannels(left)
  const b = hexChannels(right)
  const [r, g, bl, alpha] = a.map((channel, index) => channel + (b[index]! - channel) * clamp(amount, 0, 1)) as [number, number, number, number]
  return formatHex({ r, g, b: bl, a: alpha })
}

/** The color a new stop at `position` should take: interpolated between its neighbours, or the nearest end color. */
export function colorAt(stops: readonly { position: number; hex: string }[], position: number): string {
  const sorted = [...stops].sort((left, right) => left.position - right.position)
  if (!sorted.length) return '#000000'
  if (position <= sorted[0]!.position) return mixHex(sorted[0]!.hex, sorted[0]!.hex, 0)
  for (let index = 1; index < sorted.length; index++) {
    const from = sorted[index - 1]!
    const to = sorted[index]!
    if (position <= to.position) return mixHex(from.hex, to.hex, to.position === from.position ? 0 : (position - from.position) / (to.position - from.position))
  }
  return mixHex(sorted[sorted.length - 1]!.hex, sorted[sorted.length - 1]!.hex, 0)
}

/** Left-to-right CSS for the gradient bar, with midpoints as color hints. */
export function gradientBarCss(stops: readonly { position: number; midpoint?: number; css: string }[]): string {
  const sorted = [...stops].sort((left, right) => left.position - right.position)
  const parts: string[] = []
  sorted.forEach((stop, index) => {
    parts.push(`${stop.css} ${round(stop.position * 100, 2)}%`)
    const next = sorted[index + 1]
    const midpoint = stop.midpoint ?? 0.5
    if (next && midpoint !== 0.5) parts.push(`${round((stop.position + (next.position - stop.position) * midpoint) * 100, 2)}%`)
  })
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

/** The second stop seeded when a solid becomes a gradient: the same color with HSL lightness 20 points lower. */
export function darkerHex(hex: string): string {
  const color = parseColor(hex)
  if (!color) return hex
  const hsl = rgbToHsl(color)
  return formatHex(hslToRgb({ ...hsl, l: Math.max(0, hsl.l - 20) }), color.a < 1)
}

// Token bindings ------------------------------------------------------------------------------------------------------

/** One color location in an appearance: a solid fill, one gradient stop, the outline, or one border row. */
export type ColorSlot =
  | { kind: 'fill'; index: number }
  | { kind: 'stop'; index: number; stop: number }
  | { kind: 'outline' }
  | { kind: 'border'; side: BorderKey }

/** The color stored at a slot, or undefined when this appearance has nothing there (another type, no outline, ...). */
export function colorAtSlot(appearance: Appearance | undefined, slot: ColorSlot): ColorValue | undefined {
  if (slot.kind === 'fill') { const paint = appearance?.fills?.[slot.index]; return paint?.type === 'solid' ? paint.color : undefined }
  if (slot.kind === 'stop') { const paint = appearance?.fills?.[slot.index]; return paint?.type === 'gradient' ? paint.stops[slot.stop]?.color : undefined }
  if (slot.kind === 'outline') return appearance?.outline?.color
  return borderEntries(appearance?.borders).find(entry => entry.side === slot.side)?.stroke.color
}

/**
 * Replaces only the color at a slot; every other field (visibility, width, ids, caches, other paints) stays as stored.
 * An appearance without that slot comes back unchanged.
 */
export function withColorAtSlot(appearance: Appearance | undefined, slot: ColorSlot, color: ColorValue): Appearance | undefined {
  if (colorAtSlot(appearance, slot) === undefined) return appearance
  if (slot.kind === 'fill') return withFill(appearance, slot.index, paint => paint.type === 'solid' ? { ...paint, color } : paint)
  if (slot.kind === 'stop') return withFill(appearance, slot.index, paint => paint.type === 'gradient' ? withStop(paint, slot.stop, { color }) : paint)
  // Spreading in place keeps key order, so the record differs from the stored one only at the color.
  if (slot.kind === 'outline') return { ...appearance, outline: { ...appearance!.outline!, color } }
  const borders = appearance!.borders as Partial<Record<BorderKey, Stroke>>
  return { ...appearance, borders: { ...borders, [slot.side]: { ...borders[slot.side]!, color } } as Borders }
}

/** Why a bound token produces no color. `missing-target` is an alias whose target no longer exists. */
export type TokenProblem = 'missing' | 'missing-target' | 'cycle' | 'depth' | 'incompatible'
export type TokenStatus =
  | { status: 'ok'; token: ColorToken; aliasOf: ColorToken | null }
  | { status: Exclude<TokenProblem, 'missing' | 'incompatible'>; token: ColorToken }
  | { status: 'incompatible'; token: FileToken }
  | { status: 'missing'; token: null }

const isColorToken = (token: FileToken): token is ColorToken => token.type === 'color'

/**
 * Classifies a token without a palette: source tokens always fall back, so only structure can fail. Missing links,
 * loops and type mismatches come from walking the alias chain; a chain longer than the engine accepts is detected by
 * asking the engine's own resolver, so the limit is never restated here.
 */
export function tokenStatus(theme: FileTheme, tokenId: string): TokenStatus {
  const token = theme.tokens[tokenId]
  if (!token) return { status: 'missing', token: null }
  if (!isColorToken(token)) return { status: 'incompatible', token }
  const seen = new Set([tokenId])
  let current = token
  while (current.value.kind === 'alias') {
    const next = theme.tokens[current.value.tokenId]
    if (!next) return { status: 'missing-target', token }
    if (seen.has(next.id)) return { status: 'cycle', token }
    if (!isColorToken(next)) return { status: 'incompatible', token }
    seen.add(next.id)
    current = next
  }
  if (resolveToken(theme, tokenId, {}) === null) return { status: 'depth', token }
  const alias = token.value.kind === 'alias' ? theme.tokens[token.value.tokenId] : undefined
  return { status: 'ok', token, aliasOf: alias && isColorToken(alias) ? alias : null }
}

export type BindingEntry = Readonly<{ nodeId: string; value: ColorValue }>
/** What one color slot shows across the selection. */
export type BindingState =
  | { kind: 'empty' }
  | { kind: 'literal'; color: Color }
  | { kind: 'mixed-literals' }
  | { kind: 'bound'; tokenId: string; token: ColorToken; aliasOf: ColorToken | null }
  | { kind: 'missing'; tokenId: string }
  | { kind: 'unresolved'; tokenId: string; token: ColorToken; problem: 'missing-target' | 'cycle' | 'depth' }
  | { kind: 'incompatible'; tokenId: string; token: FileToken }
  | { kind: 'mixed-tokens'; tokenIds: string[]; unlinkable: boolean }
  | { kind: 'mixed-sources'; tokenIds: string[]; unlinkable: boolean }

export function bindingState(values: readonly BindingEntry[], file: Pick<FileDocument, 'theme'>): BindingState {
  if (!values.length) return { kind: 'empty' }
  const tokenIds = [...new Set(values.flatMap(entry => entry.value.kind === 'token' ? [entry.value.tokenId] : []))]
  const literals = values.flatMap(entry => entry.value.kind === 'literal' ? [entry.value.color] : [])
  if (!tokenIds.length) return literals.every(color => stableKey(color) === stableKey(literals[0])) ? { kind: 'literal', color: literals[0]! } : { kind: 'mixed-literals' }
  const unlinkable = tokenIds.every(tokenId => tokenStatus(file.theme, tokenId).status === 'ok')
  if (literals.length) return { kind: 'mixed-sources', tokenIds, unlinkable }
  if (tokenIds.length > 1) return { kind: 'mixed-tokens', tokenIds, unlinkable }
  const tokenId = tokenIds[0]!
  const status = tokenStatus(file.theme, tokenId)
  if (status.status === 'ok') return { kind: 'bound', tokenId, token: status.token, aliasOf: status.aliasOf }
  if (status.status === 'missing') return { kind: 'missing', tokenId }
  if (status.status === 'incompatible') return { kind: 'incompatible', tokenId, token: status.token }
  return { kind: 'unresolved', tokenId, token: status.token, problem: status.status }
}

/** Thrown when Unlink is asked to detach a binding that cannot produce a color; nothing is written. */
export class UnresolvedTokenError extends Error {
  readonly nodeId: string
  readonly tokenId: string
  readonly problem: TokenProblem
  constructor(nodeId: string, tokenId: string, problem: TokenProblem) {
    super(`Token ${tokenId} on node ${nodeId} cannot be unlinked: ${problem}`)
    this.name = 'UnresolvedTokenError'
    this.nodeId = nodeId
    this.tokenId = tokenId
    this.problem = problem
  }
}

/**
 * The literal a binding detaches to in one node's own effective theme: the resolved `Color` as stored (hex with its
 * alpha pair, or OKLCH with alpha), never re-encoded. Literals come back unchanged.
 */
export function unlinkColor(file: Pick<FileDocument, 'theme'>, nodeId: string, value: ColorValue, palette: SourcePalette): ColorValue {
  if (value.kind === 'literal') return value
  const status = tokenStatus(file.theme, value.tokenId)
  const color = status.status === 'ok' ? resolveToken(file.theme, value.tokenId, palette) : null
  if (!color) throw new UnresolvedTokenError(nodeId, value.tokenId, status.status === 'ok' ? 'depth' : status.status)
  return { kind: 'literal', color: structuredClone(color) }
}

/** A binding to `tokenId`; an existing binding to the same token comes back as the same object, so callers can skip no-ops. */
export const rebindColor = (value: ColorValue, tokenId: string): ColorValue => value.kind === 'token' && value.tokenId === tokenId ? value : { kind: 'token', tokenId }

export type TokenOption = Readonly<{ value: string; label: string; disabled?: boolean }>
/** Rebind targets: color tokens in theme order. Tokens that cannot resolve stay listed but cannot be chosen. */
export function colorTokenOptions(file: Pick<FileDocument, 'theme'>): TokenOption[] {
  return Object.values(file.theme.tokens).filter(isColorToken).sort(compareOrder).map(token => tokenStatus(file.theme, token.id).status === 'ok' ? { value: token.id, label: token.name } : { value: token.id, label: token.name, disabled: true })
}
