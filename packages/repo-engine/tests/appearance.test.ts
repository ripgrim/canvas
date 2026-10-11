import { describe, expect, it } from 'vitest'
import {
  appearanceColors, assetReferences, canonicalAppearance, canonicalBorders, convertPaint, defaultFillColor, mapAppearanceColors, nextBorders,
  projectAppearance, validateAppearance, validateImageAssetReference,
} from '../src/appearance.js'
import type { Appearance, AppearanceKind, Borders, ColorValue, GradientPaint, ImageAssetReference, Outline, Paint, Stroke } from '../src/appearance.js'
import type { Color } from '../src/color.js'

const hex = (value: string): Color => ({ kind: 'hex', hex: value })
const lit = (value: string): ColorValue => ({ kind: 'literal', color: hex(value) })
const tok = (tokenId: string): ColorValue => ({ kind: 'token', tokenId })
const stroke = (value: string, width = 1, style: Stroke['style'] = 'solid'): Stroke => ({ color: lit(value), width, style })
const gradientBody = (): Omit<GradientPaint, 'id' | 'type'> => ({ shape: 'radial', angle: 45, center: { x: 0.25, y: 0.75 }, length: 1.5, interpolation: 'oklch', stops: [{ id: 'a', position: 0, color: lit('#000000') }, { id: 'b', position: 1, midpoint: 0.3, color: tok('brand') }] })
const pixel = (): ImageAssetReference => ({ id: 'img', name: 'Pixel', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) })

/** One fill of each type, each carrying a cache of the other two types, plus every blending field, an outline, and `all` borders. */
const full = (): Appearance => ({
  visible: false, opacity: 0.4, blendMode: 'multiply',
  fills: [
    { id: 'f1', type: 'solid', color: lit('#112233'), opacity: 0.65, blendMode: 'screen', cache: { gradient: gradientBody(), image: { assetId: 'img', fit: 'tile' } } },
    { id: 'f2', type: 'gradient', ...gradientBody(), visible: false, cache: { solid: { color: tok('brand'), opacity: 0.4 }, image: { assetId: 'img', fit: 'stretch' } } },
    { id: 'f3', type: 'image', assetId: 'img', fit: 'contain', cache: { solid: { color: lit('#abcdef') }, gradient: gradientBody() } },
  ],
  outline: { color: lit('#ff0000'), width: 2, style: 'dashed', offset: -3, visible: false },
  borders: { all: stroke('#00ff00', 4, 'dotted') },
})
type Mutable = Record<string, unknown> & { fills: Record<string, unknown>[]; outline: Record<string, unknown>; borders: Record<string, unknown> }
const mutate = (change: (value: Mutable) => void): unknown => { const value = full() as unknown as Mutable; change(value); return value }
const gradientFill = (value: Mutable) => value.fills[1]!
/** The exact error message, so a broader message with the same prefix cannot satisfy the assertion. */
const thrown = (run: () => unknown): string | null => { try { run() } catch (error) { return (error as Error).message } return null }
const stops = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `s${index}`, position: index / (count - 1), color: lit('#000000') }))

describe('appearance validation', () => {
  it('accepts a full record with blending, a fill of each type with caches, an outline, and every-side borders', () => {
    expect(validateAppearance(full(), 'frame')).toEqual(full())
    expect(validateAppearance(full(), 'component')).toEqual(full())
  })

  it('accepts per-side borders and the inclusive range limits', () => {
    const sides = { ...full(), borders: { top: stroke('#000000', 0), left: { ...stroke('#111111', 1000), visible: false as const } } }
    expect(validateAppearance(sides, 'rectangle')).toEqual(sides)
    const limits = mutate(value => {
      Object.assign(gradientFill(value), { angle: -360, length: 0.01, center: { x: -2, y: 3 } })
      Object.assign(value.outline, { width: 1000, offset: -1000 })
      value.opacity = 0
    })
    expect(() => validateAppearance(limits, 'frame')).not.toThrow()
    expect(() => validateAppearance(mutate(value => { Object.assign(gradientFill(value), { angle: 360, length: 10 }) }), 'frame')).not.toThrow()
    expect(() => validateAppearance({ fills: Array.from({ length: 16 }, (_, index) => ({ id: `f${index}`, type: 'solid', color: lit('#000000') })) }, 'shape')).not.toThrow()
    expect(() => validateAppearance({ fills: [{ id: 'g', type: 'gradient', ...gradientBody(), stops: stops(16) }] }, 'shape')).not.toThrow()
    expect(() => validateAppearance({}, 'shader')).not.toThrow()
  })

  it('accepts fills and blending on text', () => {
    const value = { opacity: 0.5, fills: [{ id: 'f', type: 'solid', color: tok('ink') }] }
    expect(validateAppearance(value, 'text')).toEqual(value)
  })

  const rejects: [string, (value: Mutable) => void, string][] = [
    ['a stored visible true on the node', value => { value.visible = true }, 'Invalid node visibility'],
    ['a stored visible true on a fill', value => { value.fills[0]!.visible = true }, 'Invalid fill visibility'],
    ['a stored visible true on the outline', value => { value.outline.visible = true }, 'Invalid outline visibility'],
    ['a stored opacity of 1', value => { value.opacity = 1 }, 'Invalid node opacity'],
    ['an opacity above 1', value => { value.opacity = 1.5 }, 'Invalid node opacity'],
    ['a negative opacity', value => { value.opacity = -0.1 }, 'Invalid node opacity'],
    ['a stored normal node blend mode', value => { value.blendMode = 'normal' }, 'Invalid node blend mode'],
    ['a stored normal fill blend mode', value => { value.fills[0]!.blendMode = 'normal' }, 'Invalid fill blend mode'],
    ['an unknown blend mode', value => { value.blendMode = 'add' }, 'Invalid node blend mode'],
    ['an unknown appearance key', value => { value.shadow = 1 }, 'Unsupported appearance field'],
    ['a stored fill opacity of 1', value => { value.fills[0]!.opacity = 1 }, 'Invalid fill opacity'],
    ['a fill opacity above 1', value => { value.fills[0]!.opacity = 1.5 }, 'Invalid fill opacity'],
    ['a negative fill opacity', value => { value.fills[0]!.opacity = -0.1 }, 'Invalid fill opacity'],
    ['opacity on a gradient', value => { value.fills[1]!.opacity = 0.5 }, 'Unsupported fill field'],
    ['an unknown fill key', value => { value.fills[0]!.blur = 0.5 }, 'Unsupported fill field'],
    ['an unknown stop key', value => { (gradientFill(value).stops as Record<string, unknown>[])[0]!.alpha = 1 }, 'Unsupported gradient stop field'],
    ['an unknown cache key', value => { (value.fills[0]!.cache as Record<string, unknown>).pattern = {} }, 'Unsupported fill cache field'],
    ['an offset on a border', value => { value.borders = { all: { ...stroke('#000000'), offset: 1 } } }, 'Unsupported border field'],
    ['an unknown fill type', value => { value.fills[0]!.type = 'pattern' }, 'Unsupported fill type'],
    ['an unknown gradient shape', value => { gradientFill(value).shape = 'diamond' }, 'Invalid gradient shape'],
    ['an unknown interpolation', value => { gradientFill(value).interpolation = 'hsl' }, 'Invalid gradient'],
    ['an unknown stroke style', value => { value.outline.style = 'double' }, 'Invalid outline'],
    ['an outline wider than 1000', value => { value.outline.width = 1001 }, 'Invalid outline'],
    ['a negative outline width', value => { value.outline.width = -1 }, 'Invalid outline'],
    ['a border wider than 1000', value => { value.borders = { top: stroke('#000000', 1001) } }, 'Invalid border'],
    ['an outline offset past 1000', value => { value.outline.offset = 1001 }, 'Invalid outline offset'],
    ['an outline without an offset', value => { delete value.outline.offset }, 'Invalid outline offset'],
    ['an angle past 360', value => { gradientFill(value).angle = 361 }, 'Invalid gradient'],
    ['a zero length', value => { gradientFill(value).length = 0 }, 'Invalid gradient'],
    ['a length past 10', value => { gradientFill(value).length = 10.5 }, 'Invalid gradient'],
    ['a center past 3', value => { gradientFill(value).center = { x: 3.5, y: 0 } }, 'Invalid gradient center'],
    ['a center with an extra key', value => { gradientFill(value).center = { x: 0, y: 0, z: 0 } }, 'Invalid gradient center'],
    ['a stop position past 1', value => { (gradientFill(value).stops as Record<string, unknown>[])[1]!.position = 1.5 }, 'Invalid gradient stop'],
    ['a stop midpoint past 1', value => { (gradientFill(value).stops as Record<string, unknown>[])[1]!.midpoint = 1.2 }, 'Invalid gradient stop midpoint'],
    ['duplicate fill ids', value => { value.fills[2]!.id = 'f1' }, 'Fills need unique identities'],
    ['duplicate stop ids', value => { (gradientFill(value).stops as Record<string, unknown>[])[1]!.id = 'a' }, 'Gradient stops need unique identities'],
    ['a gradient with one stop', value => { gradientFill(value).stops = stops(2).slice(0, 1) }, 'A gradient needs between 2 and 16 stops'],
    ['a gradient with seventeen stops', value => { gradientFill(value).stops = stops(17) }, 'A gradient needs between 2 and 16 stops'],
    ['seventeen fills', value => { value.fills = Array.from({ length: 17 }, (_, index) => ({ id: `f${index}`, type: 'solid', color: lit('#000000') })) }, 'Invalid fills'],
    ['an empty fill list', value => { value.fills = [] }, 'Invalid fills'],
    ['borders with all and a side', value => { value.borders = { all: stroke('#000000'), top: stroke('#000000') } }, 'Borders use either every side or individual sides'],
    ['empty borders', value => { value.borders = {} }, 'Borders need at least one side'],
    ['an unknown border side', value => { value.borders = { middle: stroke('#000000') } }, 'Unsupported border side'],
    ['an image fill with an unknown fit', value => { value.fills[2]!.fit = 'fill' }, 'Invalid image fill'],
    ['a malformed literal color', value => { value.fills[0]!.color = { kind: 'literal', color: { kind: 'hex', hex: 'red' } } }, 'Invalid fill color'],
    ['a malformed cached image', value => { (value.fills[0]!.cache as Record<string, unknown>).image = { assetId: 'img', fit: 'fill' } }, 'Invalid fill cache'],
    ['a default cached fill opacity', value => { (value.fills[1]!.cache as Record<string, unknown>).solid = { color: tok('brand'), opacity: 1 } }, 'Invalid fill cache'],
  ]
  it.each(rejects)('rejects %s', (_label, change, message) => {
    expect(thrown(() => validateAppearance(mutate(change), 'frame'))).toBe(message)
  })

  it.each([
    ['an outline', { outline: { ...stroke('#000000'), offset: 0 } }, 'This node has no outline'],
    ['borders', { borders: { top: stroke('#000000') } }, 'This node has no borders'],
  ])('rejects %s on text but accepts it on every other kind', (_label, value, message) => {
    expect(thrown(() => validateAppearance(value, 'text'))).toBe(message)
    for (const kind of ['frame', 'rectangle', 'shape', 'shader', 'component'] as AppearanceKind[]) expect(validateAppearance(value, kind)).toEqual(value)
  })

  it('accepts exact immutable image asset metadata', () => {
    expect(validateImageAssetReference(pixel())).toEqual(pixel())
    expect(validateImageAssetReference({ ...pixel(), mime: 'image/webp', extension: 'webp', width: 4096, height: 4096 })).toMatchObject({ width: 4096, height: 4096 })
  })

  it.each([
    ['an svg mime type', { mime: 'image/svg+xml' }, 'Unsupported image type'],
    ['a MIME-extension mismatch', { mime: 'image/webp' }, 'Image type does not match its extension'],
    ['an uppercase digest', { sha256: 'A'.repeat(64) }, 'Invalid image digest'],
    ['a short digest', { sha256: 'a'.repeat(63) }, 'Invalid image digest'],
    ['a zero width', { width: 0 }, 'Invalid image dimensions'],
    ['a fractional height', { height: 1.5 }, 'Invalid image dimensions'],
    ['a width past 16384', { width: 16_385 }, 'Invalid image dimensions'],
    ['too many decoded pixels', { width: 4097, height: 4096 }, 'Invalid image dimensions'],
    ['a zero byte size', { bytes: 0 }, 'Invalid image size'],
    ['a blank name', { name: ' ' }, 'Invalid image asset reference'],
    ['inline data', { data: 'AAAA' }, 'Unsupported image asset reference field'],
    ['a URL', { url: 'https://example.com/a.png' }, 'Unsupported image asset reference field'],
    ['an object key', { objectKey: 'file/img.png' }, 'Unsupported image asset reference field'],
    ['an ETag', { etag: 'opaque' }, 'Unsupported image asset reference field'],
  ] as [string, Record<string, unknown>, string][])('rejects an image asset reference with %s', (_label, patch, message) => {
    expect(thrown(() => validateImageAssetReference({ ...pixel(), ...patch }))).toBe(message)
  })
})

describe('appearance canonicalization', () => {
  it('drops logical defaults and empty sections, returning undefined when nothing remains', () => {
    expect(canonicalAppearance(undefined)).toBeUndefined()
    expect(canonicalAppearance({})).toBeUndefined()
    expect(canonicalAppearance({ opacity: 1, blendMode: 'normal' as never, fills: [] })).toBeUndefined()
    expect(canonicalAppearance({ opacity: 1, fills: [{ id: 'f', type: 'solid', color: lit('#000000'), blendMode: 'normal' as never, cache: {} }] })).toStrictEqual({ fills: [{ id: 'f', type: 'solid', color: lit('#000000') }] })
  })

  it('keeps an invisible fill as visible false and drops an explicit undefined visibility', () => {
    const hidden = canonicalAppearance({ fills: [{ id: 'f', type: 'solid', color: lit('#000000'), visible: false }] })
    expect(hidden).toStrictEqual({ fills: [{ id: 'f', type: 'solid', color: lit('#000000'), visible: false }] })
    const outline = canonicalAppearance({ outline: { ...stroke('#000000'), offset: 2, visible: undefined } as unknown as Outline })
    expect(outline).toStrictEqual({ outline: { color: lit('#000000'), width: 1, style: 'solid', offset: 2 } })
  })

  it('keeps a non-default solid opacity and drops the logical default', () => {
    expect(canonicalAppearance({ fills: [{ id: 'f', type: 'solid', color: tok('brand'), opacity: 0.65 }] })).toStrictEqual({ fills: [{ id: 'f', type: 'solid', color: tok('brand'), opacity: 0.65 }] })
    expect(canonicalAppearance({ fills: [{ id: 'f', type: 'solid', color: tok('brand'), opacity: 1 }] })).toStrictEqual({ fills: [{ id: 'f', type: 'solid', color: tok('brand') }] })
  })

  it('keeps every non-default field of a full record', () => {
    expect(canonicalAppearance(full())).toEqual(full())
  })

  it('keeps four equal sides as four sides, since combining to all is an explicit user step', () => {
    const black = stroke('#000000')
    expect(canonicalBorders({ top: black, bottom: black, left: black, right: black })).toStrictEqual({ top: black, bottom: black, left: black, right: black })
    expect(canonicalAppearance({ borders: { top: black, bottom: black, left: black, right: black } })).toStrictEqual({ borders: { top: black, bottom: black, left: black, right: black } })
  })

  it('keeps all as all, keeps partial and differing sides, and drops empty records', () => {
    const black = stroke('#000000')
    expect(canonicalBorders({ all: black })).toStrictEqual({ all: black })
    expect(canonicalBorders({ top: black, bottom: black, left: black, right: stroke('#000000', 2) })).toStrictEqual({ top: black, bottom: black, left: black, right: stroke('#000000', 2) })
    expect(canonicalBorders({ top: black, left: black })).toStrictEqual({ top: black, left: black })
    expect(canonicalBorders({ top: undefined } as unknown as Borders)).toBeUndefined()
    expect(canonicalBorders(undefined)).toBeUndefined()
  })

  it('strips visible true from border strokes and keeps visible false', () => {
    const black = stroke('#000000')
    expect(canonicalBorders({ top: { ...black, visible: true } as unknown as Stroke, left: { ...black, visible: false } })).toStrictEqual({ top: black, left: { ...black, visible: false } })
    expect(canonicalBorders({ all: { ...black, visible: true } as unknown as Stroke })).toStrictEqual({ all: black })
  })
})

describe('border sequence', () => {
  const a = stroke('#aa0000', 2)
  it('walks empty, top, bottom, left, right, all, then four sides with the same stroke', () => {
    const first = nextBorders(undefined, a)
    expect(first).toStrictEqual({ top: a })
    const second = nextBorders(first)
    expect(second).toStrictEqual({ top: a, bottom: a })
    const third = nextBorders(second)
    expect(third).toStrictEqual({ top: a, bottom: a, left: a })
    const fourth = nextBorders(third)
    expect(fourth).toStrictEqual({ top: a, bottom: a, left: a, right: a })
    const all = nextBorders(fourth)
    expect(all).toStrictEqual({ all: a })
    expect(nextBorders(all)).toStrictEqual({ top: a, bottom: a, left: a, right: a })
  })

  it('seeds a 1px solid black top border by default', () => {
    expect(nextBorders(undefined)).toStrictEqual({ top: { color: lit('#000000'), width: 1, style: 'solid' } })
  })

  it('fills the first missing side with the first existing stroke in top, bottom, left, right order', () => {
    const b = stroke('#00bb00', 3)
    const c = stroke('#0000cc', 4)
    expect(nextBorders({ left: c, bottom: b })).toStrictEqual({ left: c, bottom: b, top: b })
    expect(nextBorders({ top: a, right: c })).toStrictEqual({ top: a, right: c, bottom: a })
    expect(nextBorders({ right: c })).toStrictEqual({ right: c, top: c })
  })
})

describe('fill type conversion', () => {
  const counter = () => { let next = 0; const ids = () => `g${++next}`; return Object.assign(ids, { count: () => next }) }

  it('turns a solid into a default gradient from the color and the resolved second stop, caching the solid', () => {
    const solid: Paint = { id: 'f1', type: 'solid', color: lit('#336699'), opacity: 0.65, visible: false, blendMode: 'overlay' }
    const ids = counter()
    const seen: ColorValue[] = []
    const result = convertPaint(solid, 'gradient', ids, color => { seen.push(color); return lit('#aabbcc') })
    expect(result).toStrictEqual({
      id: 'f1', visible: false, blendMode: 'overlay', cache: { solid: { color: lit('#336699'), opacity: 0.65 } },
      type: 'gradient', shape: 'linear', angle: 180, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab',
      stops: [{ id: 'g1', position: 0, midpoint: 0.5, color: lit('#336699') }, { id: 'g2', position: 1, midpoint: 0.5, color: lit('#aabbcc') }],
    })
    expect(seen).toEqual([lit('#336699')])
    expect(solid).toStrictEqual({ id: 'f1', type: 'solid', color: lit('#336699'), opacity: 0.65, visible: false, blendMode: 'overlay' })
  })

  it('restores the cached solid when converting a gradient back, and the cached gradient after that', () => {
    const ids = counter()
    const gradient = convertPaint({ id: 'f1', type: 'solid', color: tok('brand') }, 'gradient', ids, () => lit('#ffffff'))
    const back = convertPaint(gradient, 'solid', ids, () => lit('#000000'))
    const body = { shape: 'linear', angle: 180, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: [{ id: 'g1', position: 0, midpoint: 0.5, color: tok('brand') }, { id: 'g2', position: 1, midpoint: 0.5, color: lit('#ffffff') }] }
    expect(back).toStrictEqual({ id: 'f1', type: 'solid', color: tok('brand'), cache: { gradient: body } })
    const again = convertPaint(back, 'gradient', ids, () => { throw new Error('the cached gradient should be restored') })
    expect(again).toStrictEqual({ id: 'f1', type: 'gradient', ...body, cache: { solid: { color: tok('brand') } } })
    expect(ids.count()).toBe(2)
  })

  it('uses the lowest positioned stop when a gradient has no cached solid', () => {
    const gradient: Paint = { id: 'g', type: 'gradient', ...gradientBody(), stops: [{ id: 'hi', position: 0.8, color: lit('#111111') }, { id: 'lo', position: 0.2, color: lit('#222222') }] }
    expect(convertPaint(gradient, 'solid', counter(), () => lit('#000000'))).toMatchObject({ type: 'solid', color: lit('#222222') })
  })

  it('switches between image and solid through the cache, preserving visibility and blend mode', () => {
    const image: Paint = { id: 'i', type: 'image', assetId: 'img', fit: 'tile', blendMode: 'darken', cache: { solid: { color: lit('#123456') } } }
    const solid = convertPaint(image, 'solid', counter(), () => lit('#000000'))
    expect(solid).toStrictEqual({ id: 'i', blendMode: 'darken', type: 'solid', color: lit('#123456'), cache: { image: { assetId: 'img', fit: 'tile' } } })
    expect(convertPaint(solid, 'image', counter(), () => lit('#000000'))).toStrictEqual({ id: 'i', blendMode: 'darken', type: 'image', assetId: 'img', fit: 'tile', cache: { solid: { color: lit('#123456') } } })
  })

  it('refuses to convert to an image without a cached image and returns the same paint for the same type', () => {
    const solid: Paint = { id: 'f', type: 'solid', color: lit('#000000') }
    expect(() => convertPaint(solid, 'image', counter(), () => lit('#000000'))).toThrow('Choose an image first')
    expect(convertPaint(solid, 'solid', counter(), () => lit('#000000'))).toBe(solid)
  })
})

describe('appearance helpers', () => {
  it('seeds white on frames and #dddddd on every other kind', () => {
    expect(defaultFillColor('frame')).toEqual(lit('#ffffff'))
    for (const kind of ['rectangle', 'shape', 'shader', 'text', 'component'] as AppearanceKind[]) expect(defaultFillColor(kind)).toEqual(lit('#dddddd'))
  })

  it('lists colors in fill, stop, cache, outline, border order and asset references from fills and caches', () => {
    const value: Appearance = {
      fills: [
        { id: 's', type: 'solid', color: tok('one'), cache: { gradient: { ...gradientBody(), stops: [{ id: 'x', position: 0, color: tok('two') }, { id: 'y', position: 1, color: tok('three') }] }, image: { assetId: 'cached', fit: 'cover' } } },
        { id: 'i', type: 'image', assetId: 'shown', fit: 'cover', cache: { solid: { color: tok('four') } } },
      ],
      outline: { color: tok('five'), width: 1, style: 'solid', offset: 0 },
      borders: { left: { ...stroke('#000000'), color: tok('seven') }, top: { ...stroke('#000000'), color: tok('six') } },
    }
    expect(appearanceColors(value)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map(tok))
    expect(assetReferences(value)).toEqual(['cached', 'shown'])
  })

  it('rewrites fill, stop, cached, outline, and every border color, leaving the input untouched', () => {
    const body = (first: ColorValue) => ({ shape: 'linear' as const, angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb' as const, stops: [{ id: 'c1', position: 0, color: first }, { id: 'c2', position: 1, color: lit('#111111') }] })
    const input = (): Appearance => ({
      opacity: 0.5,
      fills: [
        { id: 's', type: 'solid', color: tok('old'), cache: { gradient: body(tok('old')), image: { assetId: 'img', fit: 'cover' } } },
        { id: 'g', type: 'gradient', ...body(tok('old')), cache: { solid: { color: tok('old') } } },
        { id: 'i', type: 'image', assetId: 'img', fit: 'cover', cache: { solid: { color: tok('keep') } } },
      ],
      outline: { color: tok('old'), width: 1, style: 'solid', offset: 2 },
      borders: { top: { ...stroke('#000000'), color: tok('old') }, left: { ...stroke('#000000'), color: tok('keep') }, right: { ...stroke('#000000'), color: tok('old') } },
    })
    const blue = lit('#0000ff')
    const source = input()
    const mapped = mapAppearanceColors(source, value => value.kind === 'token' && value.tokenId === 'old' ? blue : value)
    expect(mapped).toStrictEqual({
      opacity: 0.5,
      fills: [
        { id: 's', type: 'solid', color: blue, cache: { gradient: body(blue), image: { assetId: 'img', fit: 'cover' } } },
        { id: 'g', type: 'gradient', ...body(blue), cache: { solid: { color: blue } } },
        { id: 'i', type: 'image', assetId: 'img', fit: 'cover', cache: { solid: { color: tok('keep') } } },
      ],
      outline: { color: blue, width: 1, style: 'solid', offset: 2 },
      borders: { top: { ...stroke('#000000'), color: blue }, left: { ...stroke('#000000'), color: tok('keep') }, right: { ...stroke('#000000'), color: blue } },
    })
    expect(source).toStrictEqual(input())
    expect(mapAppearanceColors({ borders: { all: { ...stroke('#000000'), color: tok('old') } } }, () => blue)).toStrictEqual({ borders: { all: { ...stroke('#000000'), color: blue } } })
  })
})

describe('appearance projection', () => {
  const palette: Record<string, Color> = { brand: hex('#3366cc') }
  const resolve = (value: ColorValue): Color | null => value.kind === 'literal' ? value.color : palette[value.tokenId] ?? null
  const hasAsset = (assetId: string) => assetId === 'img'
  const base = { shape: 'conic' as const, angle: 30, center: { x: 0.2, y: 0.8 }, length: 2, interpolation: 'oklch' as const }

  it('resolves colors, sorts stops, drops hidden and unresolvable fills, and expands all borders to four sides', () => {
    const projected = projectAppearance({
      visible: false, opacity: 0.5, blendMode: 'multiply',
      fills: [
        { id: '1', type: 'solid', color: lit('#ABCDEF') },
        { id: '2', type: 'solid', color: lit('#ff0000'), visible: false },
        { id: '3', type: 'solid', color: tok('ghost') },
        { id: '4', type: 'gradient', ...base, blendMode: 'screen', stops: [{ id: 'z', position: 1, midpoint: 0.5, color: tok('brand') }, { id: 'y', position: 0, midpoint: 0.25, color: lit('#000000') }] },
        { id: '5', type: 'gradient', ...base, stops: [{ id: 'z', position: 1, color: tok('ghost') }, { id: 'y', position: 0, color: lit('#000000') }] },
        { id: '6', type: 'image', assetId: 'img', fit: 'tile' },
        { id: '7', type: 'image', assetId: 'gone', fit: 'cover' },
        { id: '8', type: 'solid', color: { kind: 'literal', color: { kind: 'oklch', l: 0.7, c: 0.1, h: 30, alpha: 0.5 } } },
      ],
      outline: { color: tok('brand'), width: 2, style: 'dashed', offset: -1 },
      borders: { all: stroke('#00ff00', 3, 'dotted') },
    }, resolve, hasAsset)
    const side = { color: '#00ff00', width: 3, style: 'dotted' }
    expect(projected).toStrictEqual({
      visible: false, opacity: 0.5, blendMode: 'multiply',
      fills: [
        { type: 'solid', color: '#abcdef' },
        { type: 'gradient', ...base, stops: [{ color: '#000000', position: 0, midpoint: 0.25 }, { color: '#3366cc', position: 1 }], blendMode: 'screen' },
        { type: 'image', assetId: 'img', fit: 'tile' },
        { type: 'solid', color: 'oklch(0.7 0.1 30 / 0.5)' },
      ],
      outline: { color: '#3366cc', width: 2, style: 'dashed', offset: -1 },
      borders: { top: side, bottom: side, left: side, right: side },
    })
  })

  it('drops hidden, zero width, and unresolvable strokes per side', () => {
    const projected = projectAppearance({
      outline: { ...stroke('#000000', 0), offset: 1 },
      borders: { top: stroke('#000000', 0), bottom: { ...stroke('#000000', 2), visible: false }, left: { ...stroke('#000000', 2), color: tok('ghost') }, right: stroke('#123456', 2) },
    }, resolve, hasAsset)
    expect(projected).toStrictEqual({ borders: { right: { color: '#123456', width: 2, style: 'solid' } } })
    expect(projectAppearance({ outline: { ...stroke('#000000', 4), offset: 0, visible: false } }, resolve, hasAsset)).toBeUndefined()
  })

  it('returns an empty record when authored fills all drop, so text renders transparent instead of the legacy ink', () => {
    expect(projectAppearance({ fills: [{ id: 'f', type: 'solid', color: lit('#000000'), visible: false }] }, resolve, hasAsset)).toStrictEqual({})
    expect(projectAppearance({ fills: [{ id: 'f', type: 'image', assetId: 'gone', fit: 'cover' }] }, resolve, hasAsset)).toStrictEqual({})
    expect(projectAppearance({ fills: [{ id: 'f', type: 'solid', color: tok('ghost') }] }, resolve, hasAsset)).toStrictEqual({})
  })

  it('returns undefined when there is no appearance or no fill list and nothing else projects', () => {
    expect(projectAppearance(undefined, resolve, hasAsset)).toBeUndefined()
    expect(projectAppearance({}, resolve, hasAsset)).toBeUndefined()
    expect(projectAppearance({ borders: { top: { ...stroke('#000000'), visible: false } } }, resolve, hasAsset)).toBeUndefined()
  })

  it('multiplies a solid fill override into the resolved color alpha without changing the token', () => {
    const appearance: Appearance = { fills: [{ id: 'brand', type: 'solid', color: tok('brand'), opacity: 0.65 }, { id: 'scrim', type: 'solid', color: lit('#11223380'), opacity: 0.5 }] }
    expect(projectAppearance(appearance, resolve, hasAsset)).toStrictEqual({ fills: [{ type: 'solid', color: '#3366cca6' }, { type: 'solid', color: '#11223340' }] })
    expect(appearance).toStrictEqual({ fills: [{ id: 'brand', type: 'solid', color: tok('brand'), opacity: 0.65 }, { id: 'scrim', type: 'solid', color: lit('#11223380'), opacity: 0.5 }] })
  })
})
