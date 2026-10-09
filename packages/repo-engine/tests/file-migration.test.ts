import { describe, expect, it } from 'vitest'
import type { CanvasElement, DocumentNode, EditorDocument } from '../src/document.js'
import { childrenOf, legacyPageDocument, validateFileDocument } from '../src/file-document.js'
import type { ColorToken, ColorValue, ComponentNode, FileDocument, PrimitiveNode } from '../src/file-document.js'
import { isFileDocumentShape, isLegacyDocument, legacyBuiltInColor, legacyRootId, migrateLegacyPages, upgradeFileDocument } from '../src/file-migration.js'
import type { LegacyPage } from '../src/file-migration.js'
import { projectPreviewPage } from '../src/file-preview.js'
import type { Atom } from '../src/types.js'

const card: Atom = { name: 'Card', kind: 'atom', componentId: 'sample-card', exportName: 'Card', path: 'src/atoms/Card.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'heading', type: 'ReactNode', optional: true }] }
const button: Atom = { name: 'Button', kind: 'atom', componentId: 'sample-button', exportName: 'Button', path: 'src/atoms/Button.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'variant', type: '"primary" | "quiet" | undefined', optional: true }] }
const atoms: Atom[] = [card, button]

const element = (id: string, kind: CanvasElement['kind'], fill: string, extra: Partial<CanvasElement> = {}): CanvasElement => ({ id, kind, name: `${id} name`, x: 10, y: 20, width: 30, height: 40, rotation: 0, fill, ...(kind === 'text' ? { text: 'Hi' } : {}), ...extra })
const legacyPage = (id: string, name: string, input: { elements?: CanvasElement[]; tokens?: Record<string, string>; nodes?: DocumentNode[]; rootIds?: string[] }): LegacyPage => {
  const document: EditorDocument = {
    version: 1, revision: 3, rootIds: input.rootIds ?? [],
    nodes: Object.fromEntries((input.nodes ?? []).map(node => [node.id, node])),
    frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false },
    canvas: { elements: input.elements ?? [] },
    ...(input.tokens ? { tokens: input.tokens } : {}),
  }
  return { id, name, document }
}
const token = (id: string, kind: 'literal' | 'source', name: string, orderKey: string, value: string, property?: string): ColorToken => ({
  id, type: 'color', name, orderKey,
  value: kind === 'literal' ? { kind: 'literal', color: { kind: 'hex', hex: value } } : { kind: 'source', property: property!, fallback: { kind: 'hex', hex: value } },
})
const fillsOf = (node: unknown) => (node as PrimitiveNode).appearance?.fills
const lit = (hex: string): ColorValue => ({ kind: 'literal', color: { kind: 'hex', hex } })
const tok = (tokenId: string): ColorValue => ({ kind: 'token', tokenId })
/** Version 1 elements carried one fill, so each migrated node gets exactly one paint with id `<elementId>:fill:1`. */
const tokenFill = (nodeId: string, tokenId: string) => [{ id: `${nodeId}:fill:1`, type: 'solid', color: tok(tokenId) }]
const literalFill = (nodeId: string, hex: string) => [{ id: `${nodeId}:fill:1`, type: 'solid', color: lit(hex) }]
const center = { x: 0.5, y: 0.5 }
/** The exact error message, so a broader message with the same prefix cannot satisfy the assertion. */
const thrown = (action: () => unknown): string | null => { try { action() } catch (error) { return (error as Error).message } return null }

describe('legacy fill migration', () => {
  const migrated = () => migrateLegacyPages('file-1', [legacyPage('p1', 'Home', { elements: [
    element('hex-rect', 'rectangle', '#AABBCC'),
    element('surface-frame', 'frame', 'surface'),
    element('accent-rect', 'rectangle', 'accent'),
    element('ink-rect', 'rectangle', 'ink'),
    element('muted-rect', 'rectangle', 'muted'),
    element('brand-rect', 'rectangle', 'brand'),
  ] })], atoms)

  it('turns a hex fill into a lower case solid literal', () => {
    expect(fillsOf(migrated().file.nodes['hex-rect'])).toStrictEqual(literalFill('hex-rect', '#aabbcc'))
  })

  it('binds built-in names to source tokens with the sample fallbacks and muted to a literal token', () => {
    const { file } = migrated()
    expect(fillsOf(file.nodes['surface-frame'])).toStrictEqual(tokenFill('surface-frame', 'legacy:builtin:surface'))
    expect(fillsOf(file.nodes['accent-rect'])).toStrictEqual(tokenFill('accent-rect', 'legacy:builtin:accent'))
    expect(fillsOf(file.nodes['ink-rect'])).toStrictEqual(tokenFill('ink-rect', 'legacy:builtin:ink'))
    expect(fillsOf(file.nodes['muted-rect'])).toStrictEqual(tokenFill('muted-rect', 'legacy:builtin:muted'))
    expect(file.theme.tokens).toEqual({
      'legacy:builtin:surface': token('legacy:builtin:surface', 'source', 'surface', 'V', '#ffffff', '--surface'),
      'legacy:builtin:accent': token('legacy:builtin:accent', 'source', 'accent', 'W', '#685fff', '--accent'),
      'legacy:builtin:ink': token('legacy:builtin:ink', 'source', 'ink', 'X', '#202124', '--ink'),
      'legacy:builtin:muted': token('legacy:builtin:muted', 'literal', 'muted', 'Y', '#dddddd'),
    })
  })

  it('keeps a dangling token name as the rendered fallback literal and reports it once', () => {
    const { file, diagnostics } = migrated()
    expect(fillsOf(file.nodes['brand-rect'])).toStrictEqual(literalFill('brand-rect', '#dddddd'))
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('brand-rect')
    expect(diagnostics[0]).toContain('"brand"')
  })

  it('exposes the built-in fallbacks', () => {
    expect(legacyBuiltInColor('surface')).toEqual({ kind: 'hex', hex: '#ffffff' })
    expect(legacyBuiltInColor('muted')).toEqual({ kind: 'hex', hex: '#dddddd' })
    expect(legacyBuiltInColor('brand')).toBeNull()
  })
})

describe('page token lifting', () => {
  const migrated = () => migrateLegacyPages('file-1', [
    legacyPage('p1', 'Home', { tokens: { accent: '#111111', shared: '#ABCDEF' }, elements: [element('p1-accent', 'rectangle', 'accent'), element('p1-shared', 'rectangle', 'shared')] }),
    legacyPage('p2', 'Pricing', { tokens: { accent: '#222222', shared: '#abcdef' }, elements: [element('p2-accent', 'rectangle', 'accent'), element('p2-shared', 'rectangle', 'shared')] }),
  ], atoms)

  it('keeps conflicting values as separate tokens and points each page at its own', () => {
    const { file, diagnostics } = migrated()
    expect(diagnostics).toEqual([])
    expect(file.theme.tokens).toEqual({
      'legacy:accent': token('legacy:accent', 'literal', 'accent', 'V', '#111111'),
      'legacy:shared': token('legacy:shared', 'literal', 'shared', 'W', '#abcdef'),
      'legacy:accent:p2': token('legacy:accent:p2', 'literal', 'accent (Pricing)', 'X', '#222222'),
    })
    expect(fillsOf(file.nodes['p1-accent'])).toStrictEqual(tokenFill('p1-accent', 'legacy:accent'))
    expect(fillsOf(file.nodes['p2-accent'])).toStrictEqual(tokenFill('p2-accent', 'legacy:accent:p2'))
  })

  it('merges the same name with the same value across pages into one token', () => {
    const { file } = migrated()
    expect(fillsOf(file.nodes['p1-shared'])).toStrictEqual(tokenFill('p1-shared', 'legacy:shared'))
    expect(fillsOf(file.nodes['p2-shared'])).toStrictEqual(tokenFill('p2-shared', 'legacy:shared'))
  })

  it('prefers a page token over the built-in with the same name', () => {
    const { file } = migrateLegacyPages('file-1', [legacyPage('p1', 'Home', { tokens: { surface: '#000000' }, elements: [element('frame-1', 'frame', 'surface')] })], atoms)
    expect(fillsOf(file.nodes['frame-1'])).toStrictEqual(tokenFill('frame-1', 'legacy:surface'))
    expect(file.theme.tokens['legacy:builtin:surface']).toBeUndefined()
  })
})

describe('legacy gradient migration', () => {
  const gradient = (nodeId: string, accentId: string) => [{ id: `${nodeId}:fill:1`, type: 'gradient', shape: 'linear', angle: 135, center, length: 1, interpolation: 'srgb', stops: [
    { id: 'stop:0', position: 0, color: tok(accentId) },
    { id: 'stop:1', position: 1, color: tok('legacy:builtin:ink') },
  ] }]

  it('draws the gradient fill as accent to ink at 135 degrees, using the page accent when defined', () => {
    const { file } = migrateLegacyPages('file-1', [
      legacyPage('p1', 'Home', { tokens: { accent: '#111111' }, elements: [element('s1', 'shader', 'gradient')] }),
      legacyPage('p2', 'About', { elements: [element('s2', 'shader', 'gradient'), element('r2', 'rectangle', 'gradient')] }),
    ], atoms)
    expect(fillsOf(file.nodes.s1)).toStrictEqual(gradient('s1', 'legacy:accent'))
    expect(fillsOf(file.nodes.s2)).toStrictEqual(gradient('s2', 'legacy:builtin:accent'))
    expect(fillsOf(file.nodes.r2)).toStrictEqual(gradient('r2', 'legacy:builtin:accent'))
  })

  it('keeps a hex shader fill solid and turns any named shader fill into the gradient the old renderer drew', () => {
    const { file } = migrateLegacyPages('file-1', [legacyPage('p1', 'Home', { elements: [element('s1', 'shader', 'surface'), element('s2', 'shader', '#123456')] })], atoms)
    expect(fillsOf(file.nodes.s1)).toStrictEqual(gradient('s1', 'legacy:builtin:accent'))
    expect(fillsOf(file.nodes.s2)).toStrictEqual(literalFill('s2', '#123456'))
  })
})

describe('structure migration', () => {
  const page = () => legacyPage('p1', 'Home', {
    rootIds: ['card', 'solo'],
    nodes: [
      { id: 'card', componentId: 'sample-card', exportName: 'Card', name: 'Hero', props: {}, children: { children: ['btn-1', 'btn-2'], heading: ['title'] }, layout: { mode: 'absolute', x: 12, y: 34, width: 300 } },
      { id: 'btn-1', componentId: 'sample-button', exportName: 'Button', props: { children: 'One', variant: 'primary' }, children: {} },
      { id: 'btn-2', componentId: 'sample-button', exportName: 'Button', props: { children: 'Two' }, children: {} },
      { id: 'title', componentId: 'sample-button', exportName: 'Button', props: {}, children: {} },
      { id: 'solo', componentId: 'sample-button', exportName: 'Button', props: {}, children: {} },
    ],
    elements: [
      element('f1', 'frame', 'surface', { clip: false }),
      element('r1', 'rectangle', '#000000', { parentId: 'f1' }),
      element('f2', 'frame', 'surface'),
      element('r2', 'rectangle', '#000000', { parentId: 'f1', rotation: 15 }),
      element('t1', 'text', 'ink', { parentId: 'f2', text: 'Caption' }),
      element('r3', 'rectangle', '#000000', { parentId: null }),
    ],
  })

  it('creates one root per page and places component roots before primitives', () => {
    const { file } = migrateLegacyPages('file-1', [page()], atoms)
    expect(legacyRootId('p1')).toBe('root:p1')
    expect(file.pages).toEqual([{ id: 'p1', name: 'Home', rootNodeId: 'root:p1' }])
    expect(file.nodes['root:p1']).toEqual({ id: 'root:p1', type: 'root' })
    expect(file.relationships).toEqual({
      card: { parentId: 'root:p1', orderKey: 'V' },
      solo: { parentId: 'root:p1', orderKey: 'W' },
      f1: { parentId: 'root:p1', orderKey: 'X' },
      f2: { parentId: 'root:p1', orderKey: 'Y' },
      r3: { parentId: 'root:p1', orderKey: 'Z' },
      'btn-1': { parentId: 'card', orderKey: 'V', slot: 'children' },
      'btn-2': { parentId: 'card', orderKey: 'W', slot: 'children' },
      title: { parentId: 'card', orderKey: 'V', slot: 'heading' },
      r1: { parentId: 'f1', orderKey: 'V' },
      r2: { parentId: 'f1', orderKey: 'W' },
      t1: { parentId: 'f2', orderKey: 'V' },
    })
    expect(childrenOf(file, 'root:p1')).toEqual(['card', 'solo', 'f1', 'f2', 'r3'])
    expect(file.revision).toBe(0)
  })

  it('keeps component identity, props, name, and layout', () => {
    const { file } = migrateLegacyPages('file-1', [page()], atoms)
    expect(file.nodes.card).toStrictEqual({
      id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', name: 'Hero', props: {},
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 34 } }, width: { value: { kind: 'px', value: 300 } } } },
      themeMode: 'inherit',
    })
    expect(file.nodes['btn-1']).toStrictEqual({ id: 'btn-1', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'One', variant: 'primary' }, themeMode: 'inherit' })
    // The legacy page view still reads the five-field placement the version 1 page stored.
    expect(legacyPageDocument(file, 'p1').nodes.card!.layout).toStrictEqual({ mode: 'absolute', x: 12, y: 34, width: 300 })
    expect('layout' in legacyPageDocument(file, 'p1').nodes['btn-1']!).toBe(false)
  })

  it('maps clipping to overflow, keeps rotation only when non-zero, and carries text', () => {
    const { file } = migrateLegacyPages('file-1', [page()], atoms)
    expect((file.nodes.f1 as PrimitiveNode).styles).toEqual({ left: 10, top: 20, width: 30, height: 40, overflow: 'visible' })
    expect((file.nodes.f2 as PrimitiveNode).styles).toEqual({ left: 10, top: 20, width: 30, height: 40, overflow: 'clip' })
    expect((file.nodes.r1 as PrimitiveNode).styles).toEqual({ left: 10, top: 20, width: 30, height: 40 })
    expect((file.nodes.r2 as PrimitiveNode).styles).toEqual({ left: 10, top: 20, width: 30, height: 40, rotation: 15 })
    expect(file.nodes.t1).toEqual({ id: 't1', type: 'text', name: 't1 name', styles: { left: 10, top: 20, width: 30, height: 40 }, appearance: { fills: tokenFill('t1', 'legacy:builtin:ink') }, text: 'Caption', themeMode: 'inherit' })
  })

  it('produces a valid version 6 file deterministically', () => {
    const first = migrateLegacyPages('file-1', [page()], atoms)
    const second = migrateLegacyPages('file-1', [page()], atoms)
    expect(first.file.schemaVersion).toBe(6)
    expect(isFileDocumentShape(first.file)).toBe(true)
    expect(isLegacyDocument(first.file)).toBe(false)
    expect(isLegacyDocument(page().document)).toBe(true)
    expect(isFileDocumentShape(page().document)).toBe(false)
    expect(validateFileDocument(first.file, atoms)).toEqual(first.file)
    expect(second).toEqual(first)
  })

  it('rejects node ids that appear on more than one page', () => {
    expect(() => migrateLegacyPages('file-1', [
      legacyPage('p1', 'Home', { elements: [element('shared', 'rectangle', '#000000')] }),
      legacyPage('p2', 'About', { elements: [element('shared', 'rectangle', '#000000')] }),
    ], atoms)).toThrow('Node shared appears in more than one page')
    expect(() => migrateLegacyPages('file-1', [
      legacyPage('p1', 'Home', { rootIds: ['solo'], nodes: [{ id: 'solo', componentId: 'sample-button', exportName: 'Button', props: {}, children: {} }] }),
      legacyPage('p2', 'About', { rootIds: ['solo'], nodes: [{ id: 'solo', componentId: 'sample-button', exportName: 'Button', props: {}, children: {} }] }),
    ], atoms)).toThrow('Node solo appears in more than one page')
    expect(() => migrateLegacyPages('file-1', [], atoms)).toThrow('A file needs at least one page')
  })

  it('rejects components whose binding is unavailable unless allowed', () => {
    const missing = [card, { ...button, status: 'missing' as const }]
    expect(() => migrateLegacyPages('file-1', [page()], missing)).toThrow('Component binding needs review')
    expect(migrateLegacyPages('file-1', [page()], missing, { allowUnavailableBindings: true }).file.nodes.solo).toBeDefined()
  })
})

describe('migrated appearance', () => {
  const pages = () => [
    legacyPage('p1', 'Home', { tokens: { accent: '#111111' }, elements: [
      element('bg', 'frame', 'surface'),
      element('cta', 'rectangle', 'accent', { parentId: 'bg' }),
      element('hero', 'shader', 'gradient', { parentId: 'bg' }),
      element('note', 'text', 'muted'),
      element('flat', 'rectangle', '#FF8800'),
    ] }),
    legacyPage('p2', 'About', { elements: [element('bg2', 'frame', 'surface'), element('hero2', 'shader', 'gradient')] }),
  ]
  const appearances = (projection: ReturnType<typeof projectPreviewPage>) => Object.fromEntries(projection!.document.canvas.elements.map(entry => [entry.id, entry.appearance]))
  const flat = (color: string) => ({ fills: [{ type: 'solid', color }] })
  const ramp = (from: string, to: string) => ({ fills: [{ type: 'gradient', shape: 'linear', angle: 135, center, length: 1, interpolation: 'srgb', stops: [{ color: from, position: 0 }, { color: to, position: 1 }] }] })

  it('renders the sample fallbacks without a design palette', () => {
    const { file } = migrateLegacyPages('file-1', pages(), atoms)
    expect(appearances(projectPreviewPage(file, 'p1'))).toStrictEqual({ bg: flat('#ffffff'), cta: flat('#111111'), hero: ramp('#111111', '#202124'), note: flat('#dddddd'), flat: flat('#ff8800') })
    expect(appearances(projectPreviewPage(file, 'p2'))).toStrictEqual({ bg2: flat('#ffffff'), hero2: ramp('#685fff', '#202124') })
  })

  it('follows the active design palette for built-in names but not for page tokens', () => {
    const { file } = migrateLegacyPages('file-1', pages(), atoms)
    const sources = { '--surface': { kind: 'hex' as const, hex: '#242427' }, '--accent': { kind: 'hex' as const, hex: '#7c3aed' }, '--ink': { kind: 'hex' as const, hex: '#f1f1f1' } }
    expect(appearances(projectPreviewPage(file, 'p1', sources))).toStrictEqual({ bg: flat('#242427'), cta: flat('#111111'), hero: ramp('#111111', '#f1f1f1'), note: flat('#dddddd'), flat: flat('#ff8800') })
    expect(appearances(projectPreviewPage(file, 'p2', sources))).toStrictEqual({ bg2: flat('#242427'), hero2: ramp('#7c3aed', '#f1f1f1') })
  })
})

describe('version 2 upgrade', () => {
  const styles = { left: 0, top: 0, width: 10, height: 10 }
  /**
   * Version 2 stored fills top-first and drew the first visible paint. stack draws red (its first paint); under it sit a
   * hidden gradient and a brand solid. hidden draws blue because its first paint is hidden. caption draws brand. bare has
   * an empty fill list; btn and the root never had fills.
   */
  const v2 = () => ({
    schemaVersion: 2, fileId: 'file-1', revision: 5,
    pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }],
    nodes: {
      'root-1': { id: 'root-1', type: 'root' },
      stack: { id: 'stack', type: 'rectangle', name: 'Stack', styles, fills: [
        { type: 'solid', color: lit('#ff0000') },
        { type: 'linear-gradient', angle: 90, stops: [{ id: 'a', position: 0, color: tok('brand') }, { id: 'b', position: 1, color: lit('#000000') }], visible: false },
        { type: 'solid', color: tok('brand'), visible: true },
      ] },
      hidden: { id: 'hidden', type: 'rectangle', name: 'Hidden', styles, fills: [{ type: 'solid', color: lit('#00ff00'), visible: false }, { type: 'solid', color: lit('#0000ff') }] },
      caption: { id: 'caption', type: 'text', name: 'Caption', styles, fills: [{ type: 'solid', color: tok('brand') }], text: 'Hi' },
      bare: { id: 'bare', type: 'frame', name: 'Bare', styles, fills: [] },
      btn: { id: 'btn', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {} },
    },
    relationships: {
      stack: { parentId: 'root-1', orderKey: 'V' },
      hidden: { parentId: 'root-1', orderKey: 'W' },
      caption: { parentId: 'root-1', orderKey: 'X' },
      bare: { parentId: 'root-1', orderKey: 'Y' },
      btn: { parentId: 'root-1', orderKey: 'Z' },
    },
    theme: { tokens: { brand: { id: 'brand', type: 'color', name: 'Brand', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#3366cc' } } } } },
  })

  it('reverses fills to bottom-to-top, assigns ids from the stored order, and converts linear gradients in sRGB', () => {
    const input = v2()
    const upgraded = upgradeFileDocument(input) as FileDocument
    expect(upgraded.schemaVersion).toBe(6)
    expect(upgraded.nodes.stack).toStrictEqual({ id: 'stack', type: 'rectangle', name: 'Stack', styles, appearance: { fills: [
      { id: 'stack:fill:3', type: 'solid', color: tok('brand') },
      { id: 'stack:fill:2', type: 'gradient', shape: 'linear', angle: 90, center, length: 1, interpolation: 'srgb', stops: [{ id: 'a', position: 0, color: tok('brand') }, { id: 'b', position: 1, color: lit('#000000') }], visible: false },
      { id: 'stack:fill:1', type: 'solid', color: lit('#ff0000') },
    ] }, themeMode: 'inherit' })
    expect(upgraded.nodes.hidden).toStrictEqual({ id: 'hidden', type: 'rectangle', name: 'Hidden', styles, appearance: { fills: [{ id: 'hidden:fill:2', type: 'solid', color: lit('#0000ff') }, { id: 'hidden:fill:1', type: 'solid', color: lit('#00ff00'), visible: false }] }, themeMode: 'inherit' })
    expect(upgraded.nodes.caption).toStrictEqual({ id: 'caption', type: 'text', name: 'Caption', styles, appearance: { fills: [{ id: 'caption:fill:1', type: 'solid', color: tok('brand') }] }, text: 'Hi', themeMode: 'inherit' })
    expect(upgraded.nodes.bare).toStrictEqual({ id: 'bare', type: 'frame', name: 'Bare', styles, themeMode: 'inherit' })
    // The component had no fills to upgrade; the version 5 step still gives it a fresh record with the inherited theme mode.
    expect(upgraded.nodes.btn).not.toBe(input.nodes.btn)
    expect(upgraded.nodes.btn).toStrictEqual({ id: 'btn', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {}, themeMode: 'inherit' })
    expect(upgraded.nodes['root-1']).toBe(input.nodes['root-1'])
    expect({ ...upgraded, nodes: null, schemaVersion: null }).toStrictEqual({ ...input, nodes: null, schemaVersion: null })
    expect(input).toStrictEqual(v2())
    expect(validateFileDocument(upgraded, atoms)).toStrictEqual(upgraded)
  })

  it('keeps the color version 2 drew as the topmost visible fill', () => {
    const file = validateFileDocument(upgradeFileDocument(v2()), atoms)
    const projected = Object.fromEntries(projectPreviewPage(file, 'page-1')!.document.canvas.elements.map(entry => [entry.id, entry.appearance]))
    expect(projected).toStrictEqual({
      stack: { fills: [{ type: 'solid', color: '#3366cc' }, { type: 'solid', color: '#ff0000' }] },
      hidden: { fills: [{ type: 'solid', color: '#0000ff' }] },
      caption: { fills: [{ type: 'solid', color: '#3366cc' }] },
      bare: undefined,
    })
  })

  it('returns a version 6 file by reference, upgrades version 5, 4, and 3 files, and passes anything else through', () => {
    const current = { ...v2(), schemaVersion: 6 }
    expect(upgradeFileDocument(current)).toBe(current)
    const v5 = { ...v2(), schemaVersion: 5 }
    const upgradedV5 = upgradeFileDocument(v5)
    expect(upgradedV5).not.toBe(v5)
    expect(upgradedV5).toStrictEqual({ ...v5, schemaVersion: 6 })
    const v4 = {
      schemaVersion: 4, fileId: 'file-1', revision: 2,
      pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }],
      nodes: { 'root-1': { id: 'root-1', type: 'root' }, btn: { id: 'btn', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {} } },
      relationships: { btn: { parentId: 'root-1', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    const upgradedV4 = upgradeFileDocument(v4)
    expect(upgradedV4).not.toBe(v4)
    expect(upgradedV4).toStrictEqual({
      schemaVersion: 6, fileId: 'file-1', revision: 2,
      pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }],
      nodes: { 'root-1': { id: 'root-1', type: 'root' }, btn: { id: 'btn', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {}, themeMode: 'inherit' } },
      relationships: { btn: { parentId: 'root-1', orderKey: 'V' } },
      theme: { tokens: {} },
    })
    expect(v4.schemaVersion).toBe(4)
    expect(v4.nodes.btn).not.toHaveProperty('themeMode')
    const v3 = {
      schemaVersion: 3, fileId: 'file-1', revision: 2,
      pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }],
      nodes: { 'root-1': { id: 'root-1', type: 'root' }, btn: { id: 'btn', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {} } },
      relationships: { btn: { parentId: 'root-1', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    const upgraded = upgradeFileDocument(v3)
    expect(upgraded).not.toBe(v3)
    expect(upgraded).toStrictEqual({
      schemaVersion: 6, fileId: 'file-1', revision: 2,
      pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }],
      nodes: { 'root-1': { id: 'root-1', type: 'root' }, btn: { id: 'btn', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {}, themeMode: 'inherit' } },
      relationships: { btn: { parentId: 'root-1', orderKey: 'V' } },
      theme: { tokens: {} },
    })
    expect(v3.schemaVersion).toBe(3)
    const legacy = legacyPage('p1', 'Home', {}).document
    expect(upgradeFileDocument(legacy)).toBe(legacy)
    const broken = { schemaVersion: 2, nodes: [] }
    expect(upgradeFileDocument(broken)).toBe(broken)
    const brokenV3 = { schemaVersion: 3, nodes: [] }
    expect(upgradeFileDocument(brokenV3)).toBe(brokenV3)
    expect(upgradeFileDocument(null)).toBeNull()
    expect(upgradeFileDocument('file')).toBe('file')
    const future = { ...v2(), schemaVersion: 7 }
    expect(upgradeFileDocument(future)).toBe(future)
    expect(() => validateFileDocument(upgradeFileDocument(future), atoms)).toThrow('Unsupported design file version')
  })

  it('recognizes version 2 through 6 files as stored design files', () => {
    expect(isFileDocumentShape(v2())).toBe(true)
    expect(isFileDocumentShape({ ...v2(), schemaVersion: 3 })).toBe(true)
    expect(isFileDocumentShape({ ...v2(), schemaVersion: 4 })).toBe(true)
    expect(isFileDocumentShape({ ...v2(), schemaVersion: 5 })).toBe(true)
    expect(isFileDocumentShape({ ...v2(), schemaVersion: 6 })).toBe(true)
    expect(isFileDocumentShape({ ...v2(), schemaVersion: 7 })).toBe(false)
    expect(isFileDocumentShape({ ...v2(), schemaVersion: 1 })).toBe(false)
    expect(isFileDocumentShape({ ...v2(), schemaVersion: '4' })).toBe(false)
  })
})

describe('LAY-SCHEMA-001 version 3 to 4 layout upgrade', () => {
  const styles = { left: 0, top: 0, width: 10, height: 10 }
  const pixel = { id: 'img', name: 'Pixel', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' }
  /**
   * Hand-authored version 3 file. Page 1: card (absolute, 300 wide) holding cta (flow, 40 tall) in its children slot and
   * plain (no layout) in its heading slot, then a rectangle with an image fill under a brand solid plus an outline, then
   * a text node. Page 2: a lone button with no layout. Theme: brand literal and accent alias of brand.
   */
  const v3 = () => ({
    schemaVersion: 3, fileId: 'file-7', revision: 12,
    pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }, { id: 'page-2', name: 'About', rootNodeId: 'root-2' }],
    nodes: {
      'root-1': { id: 'root-1', type: 'root' },
      'root-2': { id: 'root-2', type: 'root' },
      card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', name: 'Hero', props: {}, layout: { mode: 'absolute', x: 12, y: 34, width: 300 } },
      cta: { id: 'cta', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Go', variant: 'primary' }, layout: { mode: 'flow', x: 0, y: 0, height: 40 } },
      plain: { id: 'plain', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Plain' } },
      lone: { id: 'lone', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {} },
      photo: { id: 'photo', type: 'rectangle', name: 'Photo', styles, appearance: {
        fills: [{ id: 'photo:fill:1', type: 'image', assetId: 'img', fit: 'cover' }, { id: 'photo:fill:2', type: 'solid', color: tok('brand') }],
        outline: { color: tok('accent'), width: 2, style: 'solid', offset: 1 },
      } },
      caption: { id: 'caption', type: 'text', name: 'Caption', styles, appearance: { fills: [{ id: 'caption:fill:1', type: 'solid', color: lit('#202124') }] }, text: 'Hello' },
    },
    relationships: {
      card: { parentId: 'root-1', orderKey: 'V' },
      cta: { parentId: 'card', orderKey: 'V', slot: 'children' },
      plain: { parentId: 'card', orderKey: 'V', slot: 'heading' },
      photo: { parentId: 'root-1', orderKey: 'W' },
      caption: { parentId: 'root-1', orderKey: 'X' },
      lone: { parentId: 'root-2', orderKey: 'V' },
    },
    theme: { tokens: {
      brand: { id: 'brand', type: 'color', name: 'Brand', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#3366cc' } } },
      accent: { id: 'accent', type: 'color', name: 'Accent', orderKey: 'W', value: { kind: 'alias', tokenId: 'brand' } },
    } },
    assets: { img: pixel },
  })

  it('converts component layouts to the version 4 record and otherwise only adds the version 5 theme mode', () => {
    const input = v3()
    const upgraded = upgradeFileDocument(input) as FileDocument
    expect(upgraded).not.toBe(input)
    expect(upgraded.schemaVersion).toBe(6)
    expect((upgraded.nodes.card as ComponentNode).layout).toStrictEqual({
      item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 34 } }, width: { value: { kind: 'px', value: 300 } } },
    })
    expect((upgraded.nodes.cta as ComponentNode).layout).toStrictEqual({ item: { position: { mode: 'flow' }, height: { value: { kind: 'px', value: 40 } } } })
    // Everything except the layout field of the two placed components is unchanged, apart from the theme mode every non-root node gains.
    expect({ ...upgraded.nodes.card, layout: null }).toStrictEqual({ ...input.nodes.card, layout: null, themeMode: 'inherit' })
    expect({ ...upgraded.nodes.cta, layout: null }).toStrictEqual({ ...input.nodes.cta, layout: null, themeMode: 'inherit' })
    expect(upgraded.nodes.plain).toStrictEqual({ id: 'plain', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Plain' }, themeMode: 'inherit' })
    expect(upgraded.nodes.lone).toStrictEqual({ id: 'lone', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {}, themeMode: 'inherit' })
    for (const id of ['photo', 'caption'] as const) expect(upgraded.nodes[id]).toStrictEqual({ ...input.nodes[id], themeMode: 'inherit' })
    for (const id of ['root-1', 'root-2'] as const) {
      expect(upgraded.nodes[id]).toStrictEqual(input.nodes[id])
      expect(upgraded.nodes[id]).toBe(input.nodes[id])
    }
    expect(Object.keys(upgraded.nodes)).toEqual(Object.keys(input.nodes))
    expect(upgraded.theme).toStrictEqual(input.theme)
    expect(upgraded.assets).toStrictEqual({ img: { id: 'img', name: 'Pixel', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' } })
    expect(upgraded.pages).toStrictEqual(input.pages)
    expect(upgraded.relationships).toStrictEqual(input.relationships)
    expect(upgraded.fileId).toBe('file-7')
    expect(upgraded.revision).toBe(12)
    expect(Object.keys(upgraded).sort()).toEqual(['assets', 'fileId', 'nodes', 'pages', 'relationships', 'revision', 'schemaVersion', 'theme'])
    expect(input).toStrictEqual(v3())
  })

  it('produces a file the current validator accepts as is, and upgrading it again is a no-op', () => {
    const upgraded = upgradeFileDocument(v3())
    expect(validateFileDocument(upgraded, atoms)).toStrictEqual(upgraded)
    expect(upgradeFileDocument(upgraded)).toBe(upgraded)
    // Positive control for the rejection below: the untouched version 3 file is refused outright.
    expect(() => validateFileDocument(v3(), atoms)).toThrow('Unsupported design file version')
  })

  it('keeps the placement the legacy page view and preview read', () => {
    const file = validateFileDocument(upgradeFileDocument(v3()), atoms)
    const legacy = legacyPageDocument(file, 'page-1')
    expect(legacy.nodes.card!.layout).toStrictEqual({ mode: 'absolute', x: 12, y: 34, width: 300 })
    expect(legacy.nodes.cta!.layout).toStrictEqual({ mode: 'flow', x: 0, y: 0, height: 40 })
    expect('layout' in legacy.nodes.plain!).toBe(false)
  })

  it('leaves a malformed version 3 layout as is for the validator to reject', () => {
    const input = v3()
    const malformed = { mode: 'absolute', x: 'a', y: 0 }
    input.nodes.card = { ...input.nodes.card, layout: malformed as never }
    const upgraded = upgradeFileDocument(input) as FileDocument
    expect(upgraded.schemaVersion).toBe(6)
    expect((upgraded.nodes.card as ComponentNode).layout).toBe(malformed)
    expect((upgraded.nodes.cta as ComponentNode).layout).toStrictEqual({ item: { position: { mode: 'flow' }, height: { value: { kind: 'px', value: 40 } } } })
    // The five-field keys are unknown to the version 4 record, so the validator names the field rather than the value.
    expect(thrown(() => validateFileDocument(upgraded, atoms))).toBe('Unsupported node layout field')
    // A layout that is not a record at all reaches the value check.
    const scalar = v3()
    scalar.nodes.card = { ...scalar.nodes.card, layout: 'absolute' as never }
    const kept = upgradeFileDocument(scalar) as FileDocument
    expect((kept.nodes.card as ComponentNode).layout).toBe('absolute')
    expect(thrown(() => validateFileDocument(kept, atoms))).toBe('Invalid component layout')
  })
})
