import { describe, expect, it } from 'vitest'
import type { Atom } from '../src/types.js'
import type { DesignTheme } from '../src/design-themes.js'
import { validateFileDocument } from '../src/file-document.js'
import type { FileDocument, SourcePalette } from '../src/file-document.js'
import { nodeThemeProjection, projectPreviewPage } from '../src/file-preview.js'
import type { ThemeProjectionContext } from '../src/file-preview.js'

// Slice C: every node resolves against its own effective theme. Two palettes are hand-built so the expected colors
// are literal: the light surface is #ffffff and the dark surface is #242427; the brand literal never changes.
const atom = (name: string, componentId: string): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] })
const atoms = [atom('Card', 'sample-card'), atom('Button', 'sample-button')]
const hex = (value: string) => ({ kind: 'hex' as const, hex: value })
const themes: DesignTheme[] = [
  { id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' },
  { id: 'dark', name: 'Dark', selector: "[data-theme='dark']", attribute: 'dark', colorScheme: 'dark' },
]
const palettes: Record<string, SourcePalette> = { default: { '--surface': hex('#ffffff'), '--ink': hex('#202124') }, dark: { '--surface': hex('#242427'), '--ink': hex('#eeeeef') } }
const context = (previewThemeId: string, list: DesignTheme[] = themes): ThemeProjectionContext => ({ themes: list, previewThemeId, palette: theme => palettes[theme.id] ?? {} })
const surfaceFill = (id: string) => ({ fills: [{ id, type: 'solid' as const, color: { kind: 'token' as const, tokenId: 'surface' } }] })

/** root > card (dark) > inner (inherit) with a surface-bound fill; root > plain (inherit) with the same fill; root > box rectangle (light) bound too. */
const file = (): FileDocument => validateFileDocument({
  schemaVersion: 9, fileId: 'file-1', revision: 1,
  pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {}, themeMode: 'dark', appearance: surfaceFill('card:fill:1') },
    inner: { id: 'inner', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {}, themeMode: 'inherit', appearance: surfaceFill('inner:fill:1') },
    plain: { id: 'plain', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {}, themeMode: 'inherit', appearance: { fills: [{ id: 'plain:fill:1', type: 'solid', color: { kind: 'token', tokenId: 'surface' } }, { id: 'plain:fill:2', type: 'solid', color: { kind: 'literal', color: hex('#3366cc80') } }] } },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 0, top: 0, width: 10, height: 10 }, themeMode: 'light', appearance: surfaceFill('box:fill:1') },
  },
  relationships: { card: { parentId: 'root-1', orderKey: 'V' }, inner: { parentId: 'card', orderKey: 'V', slot: 'children' }, plain: { parentId: 'root-1', orderKey: 'W' }, box: { parentId: 'root-1', orderKey: 'X' } },
  theme: { tokens: { surface: { id: 'surface', type: 'color', name: 'Surface', orderKey: 'V', value: { kind: 'source', property: '--surface', fallback: hex('#123456') } } } },
}, atoms)

const fillColor = (projection: ReturnType<typeof projectPreviewPage>, id: string) => (projection!.document.nodes[id]!.appearance as { fills: { color: string }[] }).fills[0]!.color
const elementColor = (projection: ReturnType<typeof projectPreviewPage>, id: string) => (projection!.document.canvas.elements.find(element => element.id === id)!.appearance as { fills: { color: string }[] }).fills[0]!.color

describe('CC-TB-003 and CC-NT-003: one source token, two effective themes', () => {
  it('resolves the same token to the light surface for a fallback node and the dark surface inside a dark card', () => {
    const projection = projectPreviewPage(file(), 'page-1', context('default'))!
    expect(fillColor(projection, 'card')).toBe('#242427')
    expect(fillColor(projection, 'inner')).toBe('#242427')
    expect(fillColor(projection, 'plain')).toBe('#ffffff')
    expect(elementColor(projection, 'box')).toBe('#ffffff')
    // The literal fill is untouched by theme and keeps its alpha.
    expect((projection.document.nodes.plain!.appearance as { fills: { color: string }[] }).fills[1]!.color).toBe('#3366cc80')
    expect(projection.themeDiagnostics).toEqual([])
  })
  it('switching the file fallback to dark flips only the inheriting fallback node; explicit nodes keep their scheme', () => {
    const projection = projectPreviewPage(file(), 'page-1', context('dark'))!
    expect(fillColor(projection, 'plain')).toBe('#242427')
    expect(fillColor(projection, 'card')).toBe('#242427')
    expect(elementColor(projection, 'box')).toBe('#ffffff')
  })
  it('resolves a page background token against the selected file fallback theme', () => {
    const themed = file()
    themed.pages[0]!.background = { kind: 'token', tokenId: 'surface' }
    expect(projectPreviewPage(themed, 'page-1', context('default'))!.document.background).toBe('#ffffff')
    expect(projectPreviewPage(themed, 'page-1', context('dark'))!.document.background).toBe('#242427')
  })
  it('projects the effective theme on every component node and marks only the self override as explicit', () => {
    const projection = projectPreviewPage(file(), 'page-1', context('default'))!
    expect(projection.document.nodes.card!.theme).toEqual({ mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: true })
    expect(projection.document.nodes.inner!.theme).toEqual({ mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: false })
    expect(projection.document.nodes.plain!.theme).toEqual({ mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false })
  })
  it('a plain palette (no themes) keeps the single-palette behaviour for every node', () => {
    const projection = projectPreviewPage(file(), 'page-1', palettes.default)!
    expect(fillColor(projection, 'card')).toBe('#ffffff')
    expect(fillColor(projection, 'inner')).toBe('#ffffff')
    expect(projection.document.nodes.card!.theme).toEqual({ mode: 'dark', designThemeId: 'default', attribute: null, colorScheme: 'dark', explicit: true })
  })
  it('an empty theme context uses the default theme for the page palette', () => {
    const themed = file()
    themed.pages[0]!.background = { kind: 'token', tokenId: 'surface' }
    const requestedThemes: string[] = []
    const projection = projectPreviewPage(themed, 'page-1', {
      themes: [],
      previewThemeId: null,
      palette: theme => { requestedThemes.push(theme.id); return palettes.default! },
    })!
    expect(projection.document.background).toBe('#ffffff')
    expect(requestedThemes).toEqual(['default', 'default', 'default', 'default', 'default'])
  })
})

describe('CC-NT-009: unresolvable schemes render with the fallback and a diagnostic', () => {
  it('reports a missing dark theme and an ambiguous one without picking arbitrarily', () => {
    const lightOnly = projectPreviewPage(file(), 'page-1', context('default', [themes[0]!]))!
    expect(fillColor(lightOnly, 'card')).toBe('#ffffff')
    expect(lightOnly.document.nodes.card!.theme).toEqual({ mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: true })
    // Children project before their parent, so compare as a set.
    expect([...lightOnly.themeDiagnostics].sort((left, right) => left.nodeId.localeCompare(right.nodeId))).toEqual([{ nodeId: 'card', reason: 'missing-theme' }, { nodeId: 'inner', reason: 'missing-theme' }])
    const twoDarks = projectPreviewPage(file(), 'page-1', context('default', [...themes, { id: 'midnight', name: 'Midnight', selector: "[data-theme='midnight']", attribute: 'midnight', colorScheme: 'dark' }]))!
    // The theme literally named "dark" is the deterministic mapping, so no ambiguity remains here.
    expect(twoDarks.themeDiagnostics).toEqual([])
    const unnamed = projectPreviewPage(file(), 'page-1', context('default', [themes[0]!, { id: 'night', name: 'Night', selector: "[data-theme='night']", attribute: 'night', colorScheme: 'dark' }, { id: 'midnight', name: 'Midnight', selector: "[data-theme='midnight']", attribute: 'midnight', colorScheme: 'dark' }]))!
    expect(unnamed.themeDiagnostics.find(entry => entry.nodeId === 'card')).toEqual({ nodeId: 'card', reason: 'ambiguous-theme', candidates: ['night', 'midnight'] })
    expect(fillColor(unnamed, 'card')).toBe('#ffffff')
  })
  it('a base-theme override inside an attributed subtree is flagged because custom properties keep inheriting', () => {
    const nested = file()
    ;(nested.nodes.inner as { themeMode?: string }).themeMode = 'light'
    const projected = projectPreviewPage(nested, 'page-1', context('default'))!
    expect(projected.document.nodes.inner!.theme).toEqual({ mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: true })
    expect(projected.themeDiagnostics).toEqual([{ nodeId: 'inner', reason: 'base-theme-inside-attribute' }])
    // The palette still resolves the token in the light theme for the editor; only the DOM cannot reset.
    expect(fillColor(projected, 'inner')).toBe('#ffffff')
    // Under a dark file fallback the same happens for a light override at the top level; a dark override inside light does not.
    expect(projectPreviewPage(file(), 'page-1', context('dark'))!.themeDiagnostics).toEqual([{ nodeId: 'box', reason: 'base-theme-inside-attribute' }])
    expect(projectPreviewPage(file(), 'page-1', context('default'))!.themeDiagnostics).toEqual([])
  })
  it('nodeThemeProjection exposes the same resolution for the inspector', () => {
    const resolved = nodeThemeProjection(file(), 'inner', context('default'))
    expect(resolved.theme.designThemeId).toBe('dark')
    expect(resolved.palette).toBe(palettes.dark)
    expect(resolved.diagnostic).toBeNull()
    expect(nodeThemeProjection(file(), 'ghost', context('default')).diagnostic).toEqual({ nodeId: 'ghost', reason: 'missing-node' })
  })
})
