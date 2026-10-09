import { describe, expect, it } from 'vitest'
import { blendModes } from '@canvas/repo-engine/appearance'
import type { Appearance, ColorValue, GradientPaint, Outline, Paint, Stroke } from '@canvas/repo-engine/appearance'
import type { ColorToken, FileDocument, FileNode, FileTheme } from '@canvas/repo-engine/file-document'
import type { DesignTheme } from '@canvas/repo-engine/design-themes'
import { aggregateBlending, aggregateBorders, aggregateFills, aggregateOutline, bindingState, blendModeGroups, borderEntries, changedFillFields, colorAt, colorAtSlot, colorTokenOptions, darkerHex, editStroke, effectiveAppearance, eligibleFor, gradientBarCss, mergePaint, midpointAt, midpointHandles, mixHex, moveItem, overridesFor, rebindColor, stableKey, storageIndex, tokenStatus, unlinkColor, UnresolvedTokenError, withBorder, withColorAtSlot, withFill, withFills, withPaintBlend, withPaintVisibility } from './appearance-adapters'
import type { ColorSlot } from './appearance-adapters'
import { createDocumentStore } from './document-store'

const hex = (value: string) => ({ kind: 'literal' as const, color: { kind: 'hex' as const, hex: value } })
const solid = (id: string, value: string, extra: Partial<Paint> = {}): Paint => ({ id, type: 'solid', color: hex(value), ...extra } as Paint)
const gradient = (id: string, stops: [number, string, number?][]): GradientPaint => ({ id, type: 'gradient', shape: 'linear', angle: 180, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: stops.map(([position, color, midpoint], index) => ({ id: `${id}-s${index}`, position, color: hex(color), ...(midpoint === undefined ? {} : { midpoint }) })) })
const stroke = (value: string, width = 1, extra: Partial<Stroke> = {}): Stroke => ({ color: hex(value), width, style: 'solid', ...extra })
const node = (id: string, type: FileNode['type'], appearance?: Appearance): FileNode => type === 'root' ? { id, type } : type === 'component' ? { id, type, componentId: 'c', exportName: 'Button', props: {}, ...(appearance ? { appearance } : {}) } : { id, type, name: id, styles: { left: 0, top: 0, width: 10, height: 10 }, ...(appearance ? { appearance } : {}) }

describe('eligibility', () => {
  it('intersects sections across the selection in inspector order', () => {
    expect(eligibleFor([node('a', 'frame'), node('b', 'component')])).toEqual(['blending', 'fill', 'outline', 'border'])
    expect(eligibleFor([node('a', 'frame'), node('b', 'text')])).toEqual(['blending', 'fill'])
    expect(eligibleFor([node('r', 'root')])).toEqual([])
    expect(eligibleFor([])).toEqual([])
  })

  it('prefers a live gesture override, including an override that clears the record', () => {
    const stored = node('a', 'rectangle', { opacity: 0.5 })
    expect(effectiveAppearance(stored, null)).toEqual({ opacity: 0.5 })
    expect(effectiveAppearance(stored, { a: { opacity: 0.25 } })).toEqual({ opacity: 0.25 })
    expect(effectiveAppearance(stored, { a: null })).toBeUndefined()
    expect(effectiveAppearance(stored, { b: null })).toEqual({ opacity: 0.5 })
  })
})

describe('blending', () => {
  it('fills logical defaults and reports which fields differ', () => {
    expect(aggregateBlending([undefined, {}])).toEqual({ state: 'uniform', value: { visible: true, opacity: 1, blendMode: 'normal' } })
    expect(aggregateBlending([{ opacity: 0.4 }, { opacity: 0.4, visible: false }])).toEqual({ state: 'field-mixed', value: { visible: true, opacity: 0.4, blendMode: 'normal' }, mixed: ['visible'] })
    expect(aggregateBlending([{ blendMode: 'multiply' }, {}])).toMatchObject({ state: 'field-mixed', mixed: ['blendMode'] })
    expect(aggregateBlending([])).toEqual({ state: 'absent' })
  })

  it('groups every blend mode exactly once in Paper order', () => {
    expect(blendModeGroups.flat()).toEqual([...blendModes])
    expect(blendModeGroups.map(group => group.length)).toEqual([1, 3, 4, 3, 2, 4])
  })
})

describe('fills', () => {
  it('is absent when no node has fills', () => {
    expect(aggregateFills([undefined, { opacity: 0.5 }])).toEqual({ state: 'absent' })
  })

  it('ignores identities and caches when everything visible matches', () => {
    const left = { fills: [solid('a', '#ff0000')] }
    const right = { fills: [solid('b', '#ff0000', { cache: { image: { assetId: 'asset', fit: 'cover' } } })] }
    expect(aggregateFills([left, right])).toEqual({ state: 'uniform', value: left.fills })
  })

  it('reports field differences per storage index when structure matches', () => {
    const a = { fills: [solid('a1', '#ff0000'), solid('a2', '#00ff00')] }
    const b = { fills: [solid('b1', '#ff0000'), solid('b2', '#0000ff', { visible: false })] }
    expect(aggregateFills([a, b])).toEqual({ state: 'field-mixed', value: a.fills, mixed: [[], ['visible', 'color']] })
  })

  it('treats different counts or types as structure mixed and offers the first non-empty list', () => {
    const one = { fills: [solid('a', '#ff0000')] }
    const two = { fills: [solid('b', '#ff0000'), solid('c', '#00ff00')] }
    expect(aggregateFills([undefined, two, one])).toEqual({ state: 'structure-mixed', value: two.fills })
    expect(aggregateFills([one, { fills: [gradient('g', [[0, '#000000'], [1, '#ffffff']])] }])).toMatchObject({ state: 'structure-mixed', value: one.fills })
  })

  it('treats an absent midpoint as the default half', () => {
    const left = { fills: [gradient('g', [[0, '#000000', 0.5], [1, '#ffffff']])] }
    const right = { fills: [gradient('h', [[0, '#000000'], [1, '#ffffff']])] }
    expect(aggregateFills([left, right]).state).toBe('uniform')
  })

  it('maps UI rows to reversed storage indexes', () => {
    expect([0, 1, 2].map(row => storageIndex(row, 3))).toEqual([2, 1, 0])
    expect(storageIndex(0, 1)).toBe(0)
  })

  it('moves an item to a destination index', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('omits logical defaults when toggling visibility and blend', () => {
    const hidden = withPaintVisibility(solid('a', '#ff0000'), false)
    expect(hidden).toEqual({ id: 'a', type: 'solid', color: hex('#ff0000'), visible: false })
    expect(withPaintVisibility(hidden, true)).toEqual({ id: 'a', type: 'solid', color: hex('#ff0000') })
    expect(withPaintBlend(solid('a', '#ff0000', { blendMode: 'screen' }), 'normal')).toEqual({ id: 'a', type: 'solid', color: hex('#ff0000') })
  })

  it('merges only the edited field into each node and keeps its identity', () => {
    const before = solid('a', '#ff0000')
    const after = withPaintVisibility(before, false)
    expect(changedFillFields(before, after)).toEqual(['visible'])
    expect(mergePaint(solid('b', '#00ff00', { blendMode: 'multiply' }), before, after)).toEqual({ id: 'b', type: 'solid', color: hex('#00ff00'), blendMode: 'multiply', visible: false })
    const recolored = { ...before, color: hex('#123456') } as Paint
    expect(mergePaint(solid('c', '#00ff00', { visible: false }), before, recolored)).toEqual({ id: 'c', type: 'solid', color: hex('#123456'), visible: false })
  })

  it('replaces the fill at a storage index and drops empty lists', () => {
    const appearance = { opacity: 0.5, fills: [solid('a', '#ff0000'), solid('b', '#00ff00')] }
    expect(withFill(appearance, 1, paint => withPaintVisibility(paint, false))?.fills?.[1]).toEqual({ id: 'b', type: 'solid', color: hex('#00ff00'), visible: false })
    expect(withFill(appearance, 5, paint => paint)).toBe(appearance)
    expect(withFills(appearance, [])).toEqual({ opacity: 0.5 })
  })
})

describe('outline', () => {
  const outline = (value: string, extra: Partial<Outline> = {}): Outline => ({ ...stroke(value), offset: 0, ...extra })

  it('distinguishes absent, uniform, field and structure mixed', () => {
    expect(aggregateOutline([undefined, {}])).toEqual({ state: 'absent' })
    expect(aggregateOutline([{ outline: outline('#000000') }, { outline: outline('#000000') }])).toEqual({ state: 'uniform', value: outline('#000000') })
    expect(aggregateOutline([{ outline: outline('#000000') }, { outline: outline('#000000', { offset: 2, visible: false }) }])).toEqual({ state: 'field-mixed', value: outline('#000000'), mixed: ['visible', 'offset'] })
    expect(aggregateOutline([{}, { outline: outline('#ff0000') }])).toEqual({ state: 'structure-mixed', value: outline('#ff0000') })
  })

  it('turns a stroke back on when any field other than the eye is edited', () => {
    expect(editStroke(outline('#000000', { visible: false }), { width: 3 })).toEqual({ color: hex('#000000'), width: 3, style: 'solid', offset: 0 })
  })
})

describe('borders', () => {
  it('lists canonical rows in side order and keeps four sides as four rows', () => {
    const line = stroke('#000000')
    expect(borderEntries({ right: line, left: line, bottom: line, top: line }).map(entry => entry.side)).toEqual(['top', 'bottom', 'left', 'right'])
    expect(borderEntries({ all: { ...line, visible: false } })).toEqual([{ side: 'all', stroke: { ...line, visible: false } }])
    expect(borderEntries({ right: line, top: line })).toEqual([{ side: 'top', stroke: line }, { side: 'right', stroke: line }])
    expect(borderEntries(undefined)).toEqual([])
  })

  it('compares canonical forms across the selection', () => {
    const line = stroke('#000000')
    expect(aggregateBorders([{}, undefined])).toEqual({ state: 'absent' })
    expect(aggregateBorders([{ borders: { all: line } }, { borders: { all: { ...line } } }])).toEqual({ state: 'uniform', value: [{ side: 'all', stroke: line }] })
    expect(aggregateBorders([{ borders: { all: line } }, { borders: { top: line, bottom: line, left: line, right: line } }])).toEqual({ state: 'structure-mixed', value: [{ side: 'all', stroke: line }] })
    expect(aggregateBorders([{ borders: { top: line } }, { borders: { top: stroke('#000000', 4) } }])).toEqual({ state: 'field-mixed', value: [{ side: 'top', stroke: line }], mixed: [['width']] })
    expect(aggregateBorders([{ borders: { top: line } }, { borders: { bottom: line } }])).toEqual({ state: 'structure-mixed', value: [{ side: 'top', stroke: line }] })
    expect(aggregateBorders([{}, { borders: { left: line } }])).toEqual({ state: 'structure-mixed', value: [{ side: 'left', stroke: line }] })
  })

  it('updates one row and keeps the others', () => {
    const line = stroke('#000000')
    expect(withBorder({ borders: { top: line, left: line } }, 'left', current => ({ ...current, width: 5 }))).toEqual({ borders: { top: line, left: { ...line, width: 5 } } })
    expect(withBorder({ borders: { top: line } }, 'bottom', current => current)).toEqual({ borders: { top: line } })
  })
})

describe('batch overrides', () => {
  it('canonicalizes each node and clears empty records with null', () => {
    const targets = [{ id: 'a', appearance: { fills: [solid('a1', '#ff0000')] } as Appearance | undefined }, { id: 'b', appearance: undefined }]
    expect(overridesFor(targets, appearance => withFills(appearance, []))).toEqual({ a: null, b: null })
    expect(overridesFor(targets, appearance => ({ ...appearance, opacity: 1 }))).toEqual({ a: { fills: [solid('a1', '#ff0000')] }, b: null })
  })

  it('compares keys regardless of order', () => {
    expect(stableKey({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(stableKey({ a: [2, { c: 4, d: 3 }], b: 1 }))
  })
})

describe('gradients', () => {
  it('places midpoints between stops in position order', () => {
    const paint = gradient('g', [[1, '#ffffff'], [0, '#000000', 0.25], [0.5, '#888888']])
    expect(midpointHandles(paint.stops)).toEqual([{ stopIndex: 1, position: 0.125 }, { stopIndex: 2, position: 0.75 }])
    expect(midpointAt(paint.stops, 1, 0.4)).toBe(0.8)
    expect(midpointAt(paint.stops, 1, 0.9)).toBe(0.99)
    expect(midpointAt(paint.stops, 0, 0.9)).toBe(0.5)
  })

  it('interpolates new stop colors in sRGB', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(colorAt([{ position: 0, hex: '#ff0000' }, { position: 1, hex: '#0000ff' }], 0.25)).toBe('#bf0040')
    expect(colorAt([{ position: 0.2, hex: '#ff0000' }, { position: 0.8, hex: '#0000ff' }], 0.9)).toBe('#0000ff')
  })

  it('writes the bar background with color hints only for moved midpoints', () => {
    expect(gradientBarCss([{ position: 1, css: '#fff' }, { position: 0, midpoint: 0.25, css: '#000' }])).toBe('linear-gradient(90deg, #000 0%, 25%, #fff 100%)')
    expect(gradientBarCss([{ position: 0, css: 'red' }, { position: 1, css: 'blue' }])).toBe('linear-gradient(90deg, red 0%, blue 100%)')
  })

  it('seeds the second stop 20 lightness points darker', () => {
    expect(darkerHex('#dddddd')).toBe('#aaaaaa')
    expect(darkerHex('#ff0000')).toBe('#990000')
    expect(darkerHex('#000000')).toBe('#000000')
  })
})

// Token bindings --------------------------------------------------------------------------------------------------
// Every expected value below is written out by hand; none is recomputed with the helpers under test.

const bound = (tokenId: string): ColorValue => ({ kind: 'token', tokenId })
const colorToken = (id: string, name: string, orderKey: string, value: ColorToken['value']): ColorToken => ({ id, type: 'color', name, orderKey, value })
const literalToken = (id: string, name: string, orderKey: string, hexValue: string) => colorToken(id, name, orderKey, { kind: 'literal', color: { kind: 'hex', hex: hexValue } })
const aliasToken = (id: string, name: string, orderKey: string, target: string) => colorToken(id, name, orderKey, { kind: 'alias', tokenId: target })
const themeOf = (...tokens: ColorToken[]): FileTheme => ({ tokens: Object.fromEntries(tokens.map(token => [token.id, token])) })
/** `count` tokens where each aliases the next and the last is a literal: chain-1 -> chain-2 -> ... -> chain-<count>. */
const chain = (count: number): ColorToken[] => Array.from({ length: count }, (_, index) => index === count - 1 ? literalToken(`chain-${index + 1}`, `Chain ${index + 1}`, 'V', '#123456') : aliasToken(`chain-${index + 1}`, `Chain ${index + 1}`, 'V', `chain-${index + 2}`))

describe('CC-TB-005: unlink computes each node\'s literal in its own effective theme', () => {
  const themes: DesignTheme[] = [
    { id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' },
    { id: 'dark', name: 'Dark', selector: "[data-theme='dark']", attribute: 'dark', colorScheme: 'dark' },
  ]
  // Light keeps an eight-digit hex; dark is OKLCH with alpha. Neither may collapse to six digits.
  const palettes: Record<string, Record<string, { kind: 'hex'; hex: string } | { kind: 'oklch'; l: number; c: number; h: number; alpha: number }>> = {
    default: { '--scrim': { kind: 'hex', hex: '#11223380' } },
    dark: { '--scrim': { kind: 'oklch', l: 0.2, c: 0.05, h: 250, alpha: 0.4 } },
  }
  const fill = (id: string): Paint => ({ id, type: 'solid', color: bound('scrim') })
  const fixture = (): FileDocument => ({
    schemaVersion: 5, fileId: 'file-1', revision: 2,
    pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
    nodes: {
      'root-1': { id: 'root-1', type: 'root' },
      light: { id: 'light', type: 'rectangle', name: 'Light', themeMode: 'light', styles: { left: 0, top: 0, width: 10, height: 10 }, appearance: { fills: [fill('light-fill')] } },
      dark: { id: 'dark', type: 'rectangle', name: 'Dark', themeMode: 'dark', styles: { left: 20, top: 0, width: 10, height: 10 }, appearance: { fills: [fill('dark-fill')], opacity: 0.5 } },
    },
    relationships: { light: { parentId: 'root-1', orderKey: 'V' }, dark: { parentId: 'root-1', orderKey: 'W' } },
    theme: { tokens: { scrim: colorToken('scrim', 'Scrim', 'V', { kind: 'source', property: '--scrim', fallback: { kind: 'hex', hex: '#000000' } }) } },
  })
  const loaded = () => {
    const store = createDocumentStore(() => 'unused')
    store.configure({ themeContext: () => ({ themes, previewThemeId: 'default', palette: theme => palettes[theme.id] ?? {} }), sources: () => palettes.default! })
    store.load(fixture(), [])
    return store
  }
  const slot: ColorSlot = { kind: 'fill', index: 0 }

  it('resolves the same token to the exact stored color of each node\'s palette, alpha included', () => {
    const store = loaded()
    const file = store.getSnapshot().file!
    expect(unlinkColor(file, 'light', bound('scrim'), store.paletteFor('light'))).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#11223380' } })
    expect(unlinkColor(file, 'dark', bound('scrim'), store.paletteFor('dark'))).toEqual({ kind: 'literal', color: { kind: 'oklch', l: 0.2, c: 0.05, h: 250, alpha: 0.4 } })
  })

  it('writes both literals in one batch and one undo step, leaving everything else as stored', () => {
    const store = loaded()
    const file = store.getSnapshot().file!
    const targets = ['light', 'dark'].map(id => ({ id, appearance: (file.nodes[id] as { appearance?: Appearance }).appearance }))
    const gesture = store.commands.appearance.gesture
    gesture.begin()
    gesture.preview(overridesFor(targets, (appearance, target) => withColorAtSlot(appearance, slot, unlinkColor(file, target.id, colorAtSlot(appearance, slot)!, store.paletteFor(target.id)))))
    expect(gesture.commit()).toBe(true)
    const after = store.getSnapshot().file!
    expect(after.revision).toBe(3)
    expect((after.nodes.light as { appearance?: Appearance }).appearance).toEqual({ fills: [{ id: 'light-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#11223380' } } }] })
    expect((after.nodes.dark as { appearance?: Appearance }).appearance).toEqual({ fills: [{ id: 'dark-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'oklch', l: 0.2, c: 0.05, h: 250, alpha: 0.4 } } }], opacity: 0.5 })
    expect(store.undo()).toBe(true)
    expect(store.getSnapshot().canUndo).toBe(false)
    expect((store.getSnapshot().file!.nodes.dark as { appearance?: Appearance }).appearance?.fills?.[0]).toEqual({ id: 'dark-fill', type: 'solid', color: { kind: 'token', tokenId: 'scrim' } })
  })

  it('negative control: the file fallback palette would give both nodes the light color', () => {
    const store = loaded()
    const file = store.getSnapshot().file!
    expect(unlinkColor(file, 'dark', bound('scrim'), store.sources())).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#11223380' } })
    expect(unlinkColor(file, 'dark', bound('scrim'), store.paletteFor('dark'))).not.toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#11223380' } })
  })
})

describe('CC-TB-006: binding writes touch only the color at the slot', () => {
  const original = (): Appearance => ({
    opacity: 0.4,
    fills: [
      { id: 'f0', type: 'solid', color: bound('accent'), visible: false, blendMode: 'multiply', cache: { image: { assetId: 'asset-1', fit: 'cover' } } },
      { id: 'f1', type: 'gradient', shape: 'radial', angle: 45, center: { x: 0.25, y: 0.75 }, length: 1.5, interpolation: 'srgb', stops: [{ id: 's0', position: 0, midpoint: 0.3, color: bound('accent') }, { id: 's1', position: 1, color: hex('#ffffff80') }] },
      { id: 'f2', type: 'image', assetId: 'asset-1', fit: 'contain' },
    ],
    outline: { color: bound('accent'), width: 3, style: 'dashed', offset: 2, visible: false },
    borders: { top: { color: bound('accent'), width: 2, style: 'dotted', visible: false }, left: { color: hex('#000000'), width: 1, style: 'solid' } },
  })
  const next: ColorValue = { kind: 'literal', color: { kind: 'hex', hex: '#7c3aed80' } }

  it('patches a solid fill, a stop, the outline and one border side byte for byte', () => {
    const cases: [ColorSlot, (expected: any) => void][] = [
      [{ kind: 'fill', index: 0 }, expected => { expected.fills[0].color = next }],
      [{ kind: 'stop', index: 1, stop: 0 }, expected => { expected.fills[1].stops[0].color = next }],
      [{ kind: 'outline' }, expected => { expected.outline.color = next }],
      [{ kind: 'border', side: 'top' }, expected => { expected.borders.top.color = next }],
    ]
    for (const [slot, edit] of cases) {
      const expected = structuredClone(original())
      edit(expected)
      expect(JSON.stringify(withColorAtSlot(original(), slot, next))).toBe(JSON.stringify(expected))
    }
  })

  it('keeps hidden strokes hidden (an edit through editStroke would not)', () => {
    expect(withColorAtSlot(original(), { kind: 'outline' }, next)?.outline?.visible).toBe(false)
    expect(editStroke(original().outline!, { color: next }).visible).toBeUndefined()
  })

  it('leaves appearances without that slot untouched, including image fills', () => {
    const appearance = original()
    for (const slot of [{ kind: 'fill', index: 2 }, { kind: 'fill', index: 1 }, { kind: 'stop', index: 0, stop: 0 }, { kind: 'stop', index: 1, stop: 5 }, { kind: 'border', side: 'right' }] as ColorSlot[]) {
      expect(colorAtSlot(appearance, slot)).toBeUndefined()
      expect(withColorAtSlot(appearance, slot, next)).toBe(appearance)
    }
    expect(withColorAtSlot(undefined, { kind: 'outline' }, next)).toBeUndefined()
  })

  it('reads the color stored at each slot', () => {
    const appearance = original()
    expect(colorAtSlot(appearance, { kind: 'fill', index: 0 })).toEqual({ kind: 'token', tokenId: 'accent' })
    expect(colorAtSlot(appearance, { kind: 'stop', index: 1, stop: 1 })).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#ffffff80' } })
    expect(colorAtSlot({ borders: { all: stroke('#00ff00') } }, { kind: 'border', side: 'all' })).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#00ff00' } })
  })
})

describe('CC-TB-009: aliases stay bound by their own id', () => {
  const theme = themeOf(literalToken('brand', 'Brand', 'V', '#7c3aed'), aliasToken('primary', 'Primary', 'W', 'brand'))

  it('rebinding stores the alias id, never the resolved target', () => {
    expect(rebindColor(hex('#000000'), 'primary')).toEqual({ kind: 'token', tokenId: 'primary' })
    expect(withColorAtSlot({ fills: [solid('f', '#000000')] }, { kind: 'fill', index: 0 }, rebindColor(hex('#000000'), 'primary'))?.fills?.[0]).toEqual({ id: 'f', type: 'solid', color: { kind: 'token', tokenId: 'primary' } })
  })

  it('shows the alias token itself and names its target', () => {
    const state = bindingState([{ nodeId: 'a', value: bound('primary') }], { theme })
    expect(state).toEqual({ kind: 'bound', tokenId: 'primary', token: theme.tokens.primary, aliasOf: theme.tokens.brand })
  })

  it('unlinks an alias to the target\'s color', () => {
    expect(unlinkColor({ theme }, 'a', bound('primary'), {})).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#7c3aed' } })
  })

  it('returns the same binding object for a no-op rebind', () => {
    const value = bound('primary')
    expect(rebindColor(value, 'primary')).toBe(value)
    expect(rebindColor(value, 'brand')).toEqual({ kind: 'token', tokenId: 'brand' })
  })
})

describe('CC-TB-010: unresolvable bindings are classified, never silently detached', () => {
  const gradientToken = { id: 'shade', type: 'gradient', name: 'Shade', orderKey: 'Z', value: { kind: 'literal', color: { kind: 'hex', hex: '#000000' } } } as unknown as ColorToken
  const theme = themeOf(
    literalToken('ink', 'Ink', 'X', '#202124'),
    aliasToken('loop-a', 'Loop A', 'Y', 'loop-b'), aliasToken('loop-b', 'Loop B', 'Y1', 'loop-a'),
    aliasToken('self', 'Self', 'Y2', 'self'),
    aliasToken('dangling', 'Dangling', 'Y3', 'gone'),
    aliasToken('to-shade', 'To shade', 'Y4', 'shade'),
    colorToken('surface', 'Surface', 'W', { kind: 'source', property: '--surface', fallback: { kind: 'hex', hex: '#ffffff' } }),
    gradientToken,
  )

  it('names each failure', () => {
    expect(tokenStatus(theme, 'ink').status).toBe('ok')
    expect(tokenStatus(theme, 'surface').status).toBe('ok')
    expect(tokenStatus(theme, 'nowhere')).toEqual({ status: 'missing', token: null })
    expect(tokenStatus(theme, 'loop-a').status).toBe('cycle')
    expect(tokenStatus(theme, 'self').status).toBe('cycle')
    expect(tokenStatus(theme, 'dangling').status).toBe('missing-target')
    expect(tokenStatus(theme, 'shade').status).toBe('incompatible')
    expect(tokenStatus(theme, 'to-shade').status).toBe('incompatible')
  })

  it('treats an alias chain past the engine limit as a depth failure; 65 links still resolve', () => {
    expect(tokenStatus(themeOf(...chain(65)), 'chain-1').status).toBe('ok')
    expect(tokenStatus(themeOf(...chain(66)), 'chain-1').status).toBe('depth')
    expect(tokenStatus(themeOf(...chain(66)), 'chain-2').status).toBe('ok')
  })

  it('maps single-token selections to missing, unresolved and incompatible states', () => {
    expect(bindingState([{ nodeId: 'a', value: bound('nowhere') }], { theme })).toEqual({ kind: 'missing', tokenId: 'nowhere' })
    expect(bindingState([{ nodeId: 'a', value: bound('loop-b') }], { theme })).toEqual({ kind: 'unresolved', tokenId: 'loop-b', token: theme.tokens['loop-b'], problem: 'cycle' })
    expect(bindingState([{ nodeId: 'a', value: bound('dangling') }], { theme })).toEqual({ kind: 'unresolved', tokenId: 'dangling', token: theme.tokens.dangling, problem: 'missing-target' })
    expect(bindingState([{ nodeId: 'a', value: bound('shade') }], { theme })).toEqual({ kind: 'incompatible', tokenId: 'shade', token: gradientToken })
  })

  it('refuses to unlink with a typed error instead of falling back to a color', () => {
    const attempt = (tokenId: string) => { try { unlinkColor({ theme }, 'node-1', bound(tokenId), { '--surface': { kind: 'hex', hex: '#eeeeee' } }); return null } catch (error) { return error } }
    for (const [tokenId, problem] of [['nowhere', 'missing'], ['loop-a', 'cycle'], ['dangling', 'missing-target'], ['shade', 'incompatible']] as const) {
      const error = attempt(tokenId)
      expect(error).toBeInstanceOf(UnresolvedTokenError)
      expect(error).toMatchObject({ nodeId: 'node-1', tokenId, problem })
    }
    const deep = themeOf(...chain(66))
    expect(() => unlinkColor({ theme: deep }, 'node-1', bound('chain-1'), {})).toThrow(UnresolvedTokenError)
    expect(attempt('surface')).toBeNull()
  })

  it('offers only color tokens in theme order and disables the ones that cannot resolve', () => {
    expect(colorTokenOptions({ theme })).toEqual([
      { value: 'surface', label: 'Surface' },
      { value: 'ink', label: 'Ink' },
      { value: 'loop-a', label: 'Loop A', disabled: true },
      { value: 'loop-b', label: 'Loop B', disabled: true },
      { value: 'self', label: 'Self', disabled: true },
      { value: 'dangling', label: 'Dangling', disabled: true },
      { value: 'to-shade', label: 'To shade', disabled: true },
    ])
  })
})

describe('CC-TB-011: selection states for one color slot', () => {
  const theme = themeOf(literalToken('accent', 'Accent', 'V', '#7c3aed'), literalToken('ink', 'Ink', 'W', '#202124'), aliasToken('loop-a', 'Loop A', 'X', 'loop-b'), aliasToken('loop-b', 'Loop B', 'X1', 'loop-a'))
  const entry = (nodeId: string, value: ColorValue) => ({ nodeId, value })

  it('one literal, equal literals, and different literals', () => {
    expect(bindingState([entry('a', hex('#ff0000'))], { theme })).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#ff0000' } })
    expect(bindingState([entry('a', hex('#ff0000')), entry('b', hex('#ff0000'))], { theme })).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#ff0000' } })
    expect(bindingState([entry('a', hex('#ff0000')), entry('b', hex('#ff000080'))], { theme })).toEqual({ kind: 'mixed-literals' })
  })

  it('the same token across nodes is one bound state', () => {
    expect(bindingState([entry('a', bound('accent')), entry('b', bound('accent'))], { theme })).toEqual({ kind: 'bound', tokenId: 'accent', token: theme.tokens.accent, aliasOf: null })
  })

  it('different tokens are mixed tokens; a token with a literal is mixed sources', () => {
    expect(bindingState([entry('a', bound('accent')), entry('b', bound('ink')), entry('c', bound('accent'))], { theme })).toEqual({ kind: 'mixed-tokens', tokenIds: ['accent', 'ink'], unlinkable: true })
    expect(bindingState([entry('a', bound('accent')), entry('b', hex('#ff0000'))], { theme })).toEqual({ kind: 'mixed-sources', tokenIds: ['accent'], unlinkable: true })
  })

  it('a broken token anywhere in a mixed selection blocks Unlink', () => {
    expect(bindingState([entry('a', bound('accent')), entry('b', bound('loop-a'))], { theme })).toEqual({ kind: 'mixed-tokens', tokenIds: ['accent', 'loop-a'], unlinkable: false })
    expect(bindingState([entry('a', bound('gone')), entry('b', hex('#ff0000'))], { theme })).toEqual({ kind: 'mixed-sources', tokenIds: ['gone'], unlinkable: false })
  })

  it('an empty selection has no state', () => {
    expect(bindingState([], { theme })).toEqual({ kind: 'empty' })
  })
})
