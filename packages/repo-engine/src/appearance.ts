/**
 * Node appearance: blending (visibility, opacity, mix blend mode), ordered fills, one optional outline, and canonical
 * borders. Stored bottom-to-top for fills; logical defaults are omitted. Shared by primitives and component instances.
 */
import { colorToCss, isColor } from './color.js'
import type { Color } from './color.js'
import { record, validId } from './document.js'

export const blendModes = ['normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'plus-lighter', 'color-dodge', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const
export type BlendMode = typeof blendModes[number]
export type StoredBlendMode = Exclude<BlendMode, 'normal'>
export type GradientShape = 'linear' | 'radial' | 'conic'
/** `srgb` keeps gradients authored before interpolation existed pixel-identical; new gradients default to `oklab`. */
export type GradientInterpolation = 'oklab' | 'oklch' | 'srgb'
export type StrokeStyle = 'solid' | 'dashed' | 'dotted'
export type BorderSide = 'top' | 'bottom' | 'left' | 'right'
export const borderSides: readonly BorderSide[] = ['top', 'bottom', 'left', 'right']
export type ImageFit = 'cover' | 'contain' | 'stretch' | 'tile'
export type ColorValue = { kind: 'literal'; color: Color } | { kind: 'token'; tokenId: string }
export type GradientStop = { id: string; position: number; midpoint?: number; color: ColorValue }
export type SolidPaint = { id: string; type: 'solid'; color: ColorValue; visible?: false; blendMode?: StoredBlendMode; cache?: PaintCache }
export type GradientPaint = { id: string; type: 'gradient'; shape: GradientShape; angle: number; center: { x: number; y: number }; length: number; interpolation: GradientInterpolation; stops: GradientStop[]; visible?: false; blendMode?: StoredBlendMode; cache?: PaintCache }
export type ImagePaint = { id: string; type: 'image'; assetId: string; fit: ImageFit; visible?: false; blendMode?: StoredBlendMode; cache?: PaintCache }
export type Paint = SolidPaint | GradientPaint | ImagePaint
/** Type-specific state kept when a fill switches type, so switching back restores what the user had. */
export type PaintCache = { solid?: Pick<SolidPaint, 'color'>; gradient?: Pick<GradientPaint, 'shape' | 'angle' | 'center' | 'length' | 'interpolation' | 'stops'>; image?: Pick<ImagePaint, 'assetId' | 'fit'> }
export type Stroke = { color: ColorValue; width: number; style: StrokeStyle; visible?: false }
export type Outline = Stroke & { offset: number }
/** Either one record for every side or individual sides, never both. */
export type Borders = { all: Stroke } | { top?: Stroke; bottom?: Stroke; left?: Stroke; right?: Stroke }
export type Appearance = { visible?: false; opacity?: number; blendMode?: StoredBlendMode; fills?: Paint[]; outline?: Outline; borders?: Borders }
export type ImageAsset = { id: string; name: string; mime: ImageMime; width: number; height: number; bytes: number; data: string }
export const imageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMime = typeof imageMimes[number]
export type AppearanceKind = 'frame' | 'rectangle' | 'shape' | 'shader' | 'text' | 'component'
export type AppearanceSection = 'blending' | 'fill' | 'outline' | 'border'

export const appearanceLimits = { fills: 16, stops: 16, width: 1000, offset: 1000, assetBytes: 1_500_000, assetDimension: 16_384 }
const own = (object: object, key: string) => Object.hasOwn(object, key)
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const fail = (message: string): never => { throw new Error(message) }
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }

/** Which sections a node kind exposes. Text has no outline or border; Paper uses a separate text stroke there. */
export function eligibleSections(kind: AppearanceKind): readonly AppearanceSection[] {
  return kind === 'text' ? ['blending', 'fill'] : ['blending', 'fill', 'outline', 'border']
}

export function isColorValue(value: unknown): value is ColorValue {
  if (!record(value)) return false
  if (value.kind === 'literal') return Object.keys(value).length === 2 && isColor(value.color)
  if (value.kind === 'token') return Object.keys(value).length === 2 && validId(value.tokenId)
  return false
}

function exact(value: Record<string, unknown>, required: string[], optional: string[], label: string) {
  for (const key of required) if (!own(value, key)) fail(`Invalid ${label}`)
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(`Unsupported ${label} field`)
}
const visibleField = (value: Record<string, unknown>, label: string) => { if (own(value, 'visible') && value.visible !== false) fail(`Invalid ${label} visibility`) }
const blendField = (value: Record<string, unknown>, label: string) => { if (own(value, 'blendMode') && (value.blendMode === 'normal' || !(blendModes as readonly unknown[]).includes(value.blendMode))) fail(`Invalid ${label} blend mode`) }

export function validateStop(value: unknown): GradientStop {
  ensure(record(value), 'Invalid gradient stop')
  const stop = value as Record<string, unknown>
  exact(stop, ['id', 'position', 'color'], ['midpoint'], 'gradient stop')
  if (!validId(stop.id) || !finite(stop.position, 0, 1) || !isColorValue(stop.color)) fail('Invalid gradient stop')
  if (own(stop, 'midpoint') && !finite(stop.midpoint, 0, 1)) fail('Invalid gradient stop midpoint')
  return stop as unknown as GradientStop
}

function validateGradientBody(value: Record<string, unknown>) {
  if (!['linear', 'radial', 'conic'].includes(value.shape as string)) fail('Invalid gradient shape')
  if (!finite(value.angle, -360, 360) || !finite(value.length, 0.01, 10) || !['oklab', 'oklch', 'srgb'].includes(value.interpolation as string)) fail('Invalid gradient')
  if (!record(value.center) || Object.keys(value.center).length !== 2 || !finite(value.center.x, -2, 3) || !finite(value.center.y, -2, 3)) fail('Invalid gradient center')
  const stops = value.stops
  ensure(Array.isArray(stops) && stops.length >= 2 && stops.length <= appearanceLimits.stops, 'A gradient needs between 2 and 16 stops')
  const ids = new Set<string>()
  for (const stop of stops as unknown[]) { const checked = validateStop(stop); if (ids.has(checked.id)) fail('Gradient stops need unique identities'); ids.add(checked.id) }
}

function validateCache(value: unknown) {
  ensure(record(value), 'Invalid fill cache')
  exact(value, [], ['solid', 'gradient', 'image'], 'fill cache')
  if (own(value, 'solid')) { if (!record(value.solid) || Object.keys(value.solid).length !== 1 || !isColorValue(value.solid.color)) fail('Invalid fill cache') }
  if (own(value, 'gradient')) { ensure(record(value.gradient), 'Invalid fill cache'); exact(value.gradient, ['shape', 'angle', 'center', 'length', 'interpolation', 'stops'], [], 'fill cache'); validateGradientBody(value.gradient) }
  if (own(value, 'image')) { if (!record(value.image) || Object.keys(value.image).length !== 2 || !validId(value.image.assetId) || !['cover', 'contain', 'stretch', 'tile'].includes(value.image.fit as string)) fail('Invalid fill cache') }
}

export function validatePaint(value: unknown): Paint {
  ensure(record(value), 'Invalid fill')
  const paint = value as Record<string, unknown>
  const optional = ['visible', 'blendMode', 'cache']
  if (!validId(paint.id)) fail('Invalid fill identity')
  visibleField(paint, 'fill'); blendField(paint, 'fill')
  if (own(paint, 'cache')) validateCache(paint.cache)
  if (paint.type === 'solid') { exact(paint, ['id', 'type', 'color'], optional, 'fill'); if (!isColorValue(paint.color)) fail('Invalid fill color') }
  else if (paint.type === 'gradient') { exact(paint, ['id', 'type', 'shape', 'angle', 'center', 'length', 'interpolation', 'stops'], optional, 'fill'); validateGradientBody(paint) }
  else if (paint.type === 'image') { exact(paint, ['id', 'type', 'assetId', 'fit'], optional, 'fill'); if (!validId(paint.assetId) || !['cover', 'contain', 'stretch', 'tile'].includes(paint.fit as string)) fail('Invalid image fill') }
  else fail('Unsupported fill type')
  return paint as unknown as Paint
}

export function validateStroke(value: unknown, label = 'stroke'): Stroke {
  ensure(record(value), `Invalid ${label}`)
  const stroke = value as Record<string, unknown>
  exact(stroke, ['color', 'width', 'style'], ['visible', ...(label === 'outline' ? ['offset'] : [])], label)
  if (!isColorValue(stroke.color) || !finite(stroke.width, 0, appearanceLimits.width) || !['solid', 'dashed', 'dotted'].includes(stroke.style as string)) fail(`Invalid ${label}`)
  visibleField(stroke, label)
  return stroke as unknown as Stroke
}

export function validateOutline(value: unknown): Outline {
  const outline = validateStroke(value, 'outline') as Record<string, unknown>
  if (!own(outline, 'offset') || !finite(outline.offset, -appearanceLimits.offset, appearanceLimits.offset)) fail('Invalid outline offset')
  return outline as unknown as Outline
}

export function validateBorders(value: unknown): Borders {
  ensure(record(value), 'Invalid borders')
  const keys = Object.keys(value)
  if (!keys.length) fail('Borders need at least one side')
  if (own(value, 'all')) { if (keys.length !== 1) fail('Borders use either every side or individual sides'); validateStroke(value.all, 'border'); return value as unknown as Borders }
  for (const key of keys) { if (!(borderSides as readonly string[]).includes(key)) fail('Unsupported border side'); validateStroke(value[key], 'border') }
  return value as unknown as Borders
}

/** Validates the structure of an appearance record; token and asset existence are checked by the file validator. */
export function validateAppearance(value: unknown, kind: AppearanceKind): Appearance {
  ensure(record(value), 'Invalid appearance')
  const sections = eligibleSections(kind)
  exact(value, [], ['visible', 'opacity', 'blendMode', 'fills', 'outline', 'borders'], 'appearance')
  visibleField(value, 'node'); blendField(value, 'node')
  if (own(value, 'opacity') && (!finite(value.opacity, 0, 1) || value.opacity === 1)) fail('Invalid node opacity')
  if (own(value, 'fills')) {
    const fills = value.fills
    ensure(Array.isArray(fills) && fills.length > 0 && fills.length <= appearanceLimits.fills, 'Invalid fills')
    const ids = new Set<string>()
    for (const paint of fills as unknown[]) { const checked = validatePaint(paint); if (ids.has(checked.id)) fail('Fills need unique identities'); ids.add(checked.id) }
  }
  if (own(value, 'outline')) { if (!sections.includes('outline')) fail('This node has no outline'); validateOutline(value.outline) }
  if (own(value, 'borders')) { if (!sections.includes('border')) fail('This node has no borders'); validateBorders(value.borders) }
  return value as unknown as Appearance
}

export function validateImageAsset(value: unknown): ImageAsset {
  ensure(record(value), 'Invalid image asset')
  exact(value, ['id', 'name', 'mime', 'width', 'height', 'bytes', 'data'], [], 'image asset')
  if (!validId(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256) fail('Invalid image asset')
  if (!(imageMimes as readonly unknown[]).includes(value.mime)) fail('Unsupported image type')
  if (!finite(value.width, 1, appearanceLimits.assetDimension) || !finite(value.height, 1, appearanceLimits.assetDimension) || !Number.isInteger(value.width) || !Number.isInteger(value.height)) fail('Invalid image dimensions')
  if (typeof value.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || value.data.length % 4 !== 0 || value.data.length > appearanceLimits.assetBytes * 4 / 3 + 4) fail('Invalid image data')
  if (!finite(value.bytes, 1, appearanceLimits.assetBytes) || !Number.isInteger(value.bytes)) fail('Invalid image size')
  return value as unknown as ImageAsset
}

/** Every color reference inside an appearance record, in stable order: fills (and stops), outline, borders. */
export function appearanceColors(appearance: Appearance): ColorValue[] {
  const colors: ColorValue[] = []
  for (const paint of appearance.fills ?? []) {
    if (paint.type === 'solid') colors.push(paint.color)
    else if (paint.type === 'gradient') for (const stop of paint.stops) colors.push(stop.color)
    if (paint.cache?.solid) colors.push(paint.cache.solid.color)
    if (paint.cache?.gradient) for (const stop of paint.cache.gradient.stops) colors.push(stop.color)
  }
  if (appearance.outline) colors.push(appearance.outline.color)
  for (const stroke of borderStrokes(appearance.borders)) colors.push(stroke.color)
  return colors
}
export const borderStrokes = (borders: Borders | undefined): Stroke[] => !borders ? [] : 'all' in borders && borders.all ? [borders.all] : borderSides.map(side => (borders as Partial<Record<BorderSide, Stroke>>)[side]).filter((stroke): stroke is Stroke => Boolean(stroke))
export const assetReferences = (appearance: Appearance): string[] => (appearance.fills ?? []).flatMap(paint => [...(paint.type === 'image' ? [paint.assetId] : []), ...(paint.cache?.image ? [paint.cache.image.assetId] : [])])

/** Rewrites every color through `replace`, for token inlining. */
export function mapAppearanceColors(appearance: Appearance, replace: (value: ColorValue) => ColorValue): Appearance {
  const stroke = (value: Stroke): Stroke => ({ ...value, color: replace(value.color) })
  const stops = (list: GradientStop[]) => list.map(stop => ({ ...stop, color: replace(stop.color) }))
  const cache = (value: PaintCache | undefined): PaintCache | undefined => value ? { ...value, ...(value.solid ? { solid: { color: replace(value.solid.color) } } : {}), ...(value.gradient ? { gradient: { ...value.gradient, stops: stops(value.gradient.stops) } } : {}) } : undefined
  const paint = (value: Paint): Paint => {
    const shared = value.cache ? { cache: cache(value.cache)! } : {}
    if (value.type === 'solid') return { ...value, color: replace(value.color), ...shared }
    if (value.type === 'gradient') return { ...value, stops: stops(value.stops), ...shared }
    return { ...value, ...shared }
  }
  const borders = appearance.borders ? ('all' in appearance.borders && appearance.borders.all ? { all: stroke(appearance.borders.all) } : Object.fromEntries(Object.entries(appearance.borders as Partial<Record<BorderSide, Stroke>>).map(([side, value]) => [side, stroke(value!)]))) as Borders : undefined
  return { ...appearance, ...(appearance.fills ? { fills: appearance.fills.map(paint) } : {}), ...(appearance.outline ? { outline: { ...appearance.outline, color: replace(appearance.outline.color) } } : {}), ...(borders ? { borders } : {}) }
}

/** Drops logical defaults and empty sections. Returns undefined when nothing remains. */
export function canonicalAppearance(input: Appearance | undefined): Appearance | undefined {
  if (!input) return undefined
  const next: Appearance = {}
  if (input.visible === false) next.visible = false
  if (input.opacity !== undefined && input.opacity !== 1) next.opacity = input.opacity
  if (input.blendMode && input.blendMode !== ('normal' as string)) next.blendMode = input.blendMode
  if (input.fills?.length) next.fills = input.fills.map(canonicalPaint)
  if (input.outline) next.outline = canonicalStroke(input.outline) as Outline
  const borders = canonicalBorders(input.borders)
  if (borders) next.borders = borders
  return Object.keys(next).length ? next : undefined
}
const canonicalStroke = <T extends Stroke>(stroke: T): T => { const { visible, ...rest } = stroke; return (visible === false ? { ...rest, visible: false } : rest) as T }
export function canonicalPaint(paint: Paint): Paint {
  const { visible, blendMode, cache, ...rest } = paint
  const cleanCache = cache && Object.keys(cache).length ? { cache } : {}
  return { ...rest, ...(visible === false ? { visible: false } : {}), ...(blendMode && blendMode !== ('normal' as string) ? { blendMode } : {}), ...cleanCache } as Paint
}
/** An `all` record stays `all` and sides stay sides: four equal sides are the state before the user combines them. Empty records disappear. */
export function canonicalBorders(borders: Borders | undefined): Borders | undefined {
  if (!borders) return undefined
  if ('all' in borders && borders.all) return { all: canonicalStroke(borders.all) }
  const sides = borders as Partial<Record<BorderSide, Stroke>>
  const present = borderSides.filter(side => sides[side])
  if (!present.length) return undefined
  return Object.fromEntries(present.map(side => [side, canonicalStroke(sides[side]!)])) as Borders
}

// Defaults and transitions --------------------------------------------------------------------------------------------

const literal = (hex: string): ColorValue => ({ kind: 'literal', color: { kind: 'hex', hex } })
/** `+ Fill` seeds white on a frame and `#dddddd` elsewhere (Paper's measured defaults). */
export const defaultFillColor = (kind: AppearanceKind): ColorValue => literal(kind === 'frame' ? '#ffffff' : '#dddddd')
export const defaultStroke = (): Stroke => ({ color: literal('#000000'), width: 1, style: 'solid' })
export const defaultOutline = (): Outline => ({ ...defaultStroke(), offset: 0 })
export const defaultGradient = (color: ColorValue, second: ColorValue, ids: [string, string]): Omit<GradientPaint, 'id' | 'type'> => ({ shape: 'linear', angle: 180, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: [{ id: ids[0], position: 0, midpoint: 0.5, color }, { id: ids[1], position: 1, midpoint: 0.5, color: second }] })

/** The next border record after pressing `+`: empty, top, bottom, left, right, combine to all, then split to sides. */
export function nextBorders(borders: Borders | undefined, stroke: Stroke = defaultStroke()): Borders {
  if (!borders) return { top: stroke }
  if ('all' in borders && borders.all) return { top: borders.all, bottom: borders.all, left: borders.all, right: borders.all }
  const sides = borders as Partial<Record<BorderSide, Stroke>>
  const missing = borderSides.find(side => !sides[side])
  const inherited = borderStrokes(borders)[0] ?? stroke
  if (missing) return { ...sides, [missing]: inherited }
  return { all: inherited }
}

/** Switches a fill's type, restoring cached state for the destination and caching the current state. */
export function convertPaint(paint: Paint, type: Paint['type'], ids: () => string, resolveSecond: (color: ColorValue) => ColorValue): Paint {
  if (paint.type === type) return paint
  const cache: PaintCache = { ...(paint.cache ?? {}) }
  if (paint.type === 'solid') cache.solid = { color: paint.color }
  else if (paint.type === 'gradient') cache.gradient = { shape: paint.shape, angle: paint.angle, center: paint.center, length: paint.length, interpolation: paint.interpolation, stops: paint.stops }
  else cache.image = { assetId: paint.assetId, fit: paint.fit }
  const shared = { id: paint.id, ...(paint.visible === false ? { visible: false as const } : {}), ...(paint.blendMode ? { blendMode: paint.blendMode } : {}), cache }
  if (type === 'solid') {
    const color = cache.solid?.color ?? (paint.type === 'gradient' ? [...paint.stops].sort((left, right) => left.position - right.position)[0]!.color : literal('#dddddd'))
    delete cache.solid
    return { ...shared, type: 'solid', color }
  }
  if (type === 'gradient') {
    const body = cache.gradient ?? (paint.type === 'solid' ? defaultGradient(paint.color, resolveSecond(paint.color), [ids(), ids()]) : defaultGradient(literal('#dddddd'), literal('#a4a4a4'), [ids(), ids()]))
    delete cache.gradient
    return { ...shared, type: 'gradient', ...body }
  }
  const image = cache.image
  delete cache.image
  if (!image) fail('Choose an image first')
  return { ...shared, type: 'image', ...image! }
}

// Preview projection -----------------------------------------------------------------------------------------------

export type PreviewStop = { color: string; position: number; midpoint?: number }
export type PreviewFill =
  | { type: 'solid'; color: string; blendMode?: BlendMode }
  | { type: 'gradient'; shape: GradientShape; angle: number; center: { x: number; y: number }; length: number; interpolation: GradientInterpolation; stops: PreviewStop[]; blendMode?: BlendMode }
  | { type: 'image'; assetId: string; fit: ImageFit; blendMode?: BlendMode }
export type PreviewStroke = { color: string; width: number; style: StrokeStyle }
export type PreviewAppearance = { visible?: false; opacity?: number; blendMode?: BlendMode; fills?: PreviewFill[]; outline?: PreviewStroke & { offset: number }; borders?: Partial<Record<BorderSide, PreviewStroke>> }

/**
 * Render-ready appearance: colors resolved to CSS, hidden fills and strokes dropped, borders expanded to sides.
 * Fills keep storage order (bottom to top); the runtime reverses for CSS layer order.
 */
export function projectAppearance(appearance: Appearance | undefined, resolve: (value: ColorValue) => Color | null, hasAsset: (assetId: string) => boolean): PreviewAppearance | undefined {
  if (!appearance) return undefined
  const css = (value: ColorValue) => { const color = resolve(value); return color ? colorToCss(color) : null }
  const out: PreviewAppearance = {}
  if (appearance.visible === false) out.visible = false
  if (appearance.opacity !== undefined) out.opacity = appearance.opacity
  if (appearance.blendMode) out.blendMode = appearance.blendMode
  const fills: PreviewFill[] = []
  for (const paint of appearance.fills ?? []) {
    if (paint.visible === false) continue
    const blend = paint.blendMode ? { blendMode: paint.blendMode } : {}
    if (paint.type === 'solid') { const color = css(paint.color); if (color) fills.push({ type: 'solid', color, ...blend }) }
    else if (paint.type === 'gradient') {
      const stops = [...paint.stops].sort((left, right) => left.position - right.position).map(stop => { const color = css(stop.color); return color ? { color, position: stop.position, ...(stop.midpoint !== undefined && stop.midpoint !== 0.5 ? { midpoint: stop.midpoint } : {}) } : null })
      if (stops.every(Boolean)) fills.push({ type: 'gradient', shape: paint.shape, angle: paint.angle, center: paint.center, length: paint.length, interpolation: paint.interpolation, stops: stops as PreviewStop[], ...blend })
    } else if (hasAsset(paint.assetId)) fills.push({ type: 'image', assetId: paint.assetId, fit: paint.fit, ...blend })
  }
  if (fills.length) out.fills = fills
  const stroke = (value: Stroke): PreviewStroke | null => { if (value.visible === false || value.width <= 0) return null; const color = css(value.color); return color ? { color, width: value.width, style: value.style } : null }
  if (appearance.outline) { const outline = stroke(appearance.outline); if (outline) out.outline = { ...outline, offset: appearance.outline.offset } }
  if (appearance.borders) {
    const sides: Partial<Record<BorderSide, PreviewStroke>> = {}
    const source = 'all' in appearance.borders && appearance.borders.all ? Object.fromEntries(borderSides.map(side => [side, (appearance.borders as { all: Stroke }).all])) as Partial<Record<BorderSide, Stroke>> : appearance.borders as Partial<Record<BorderSide, Stroke>>
    for (const side of borderSides) { const value = source[side]; const projected = value ? stroke(value) : null; if (projected) sides[side] = projected }
    if (Object.keys(sides).length) out.borders = sides
  }
  // An authored fill list whose fills are all hidden still projects (as an empty record) so text renders transparent, not the legacy ink.
  return Object.keys(out).length || appearance.fills ? out : undefined
}
