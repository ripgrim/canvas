import { describe, expect, it } from 'vitest'
import type { DesignTheme } from '../src/design-themes.js'
import { fallbackScheme, isNodeThemeMode, nodeThemeMode, resolveEffectiveNodeTheme, resolveThemeForMode } from '../src/node-theme.js'

// Effective theme resolution walks the relationship graph; every expected value is read off the hand-drawn tree below.
// root > card (dark) > row (inherit) > label (inherit); root > solo (inherit); root > pane (light) > chip (dark) > leaf (inherit).
type Graph = { nodes: Record<string, { id: string; type: string; themeMode?: 'inherit' | 'light' | 'dark' }>; relationships: Record<string, { parentId: string }> }
const graph = (): Graph => ({
  nodes: {
    root: { id: 'root', type: 'root' },
    card: { id: 'card', type: 'component', themeMode: 'dark' as const },
    row: { id: 'row', type: 'component', themeMode: 'inherit' as const },
    label: { id: 'label', type: 'component' },
    solo: { id: 'solo', type: 'rectangle', themeMode: 'inherit' as const },
    pane: { id: 'pane', type: 'frame', themeMode: 'light' as const },
    chip: { id: 'chip', type: 'component', themeMode: 'dark' as const },
    leaf: { id: 'leaf', type: 'text' },
  },
  relationships: {
    card: { parentId: 'root' }, row: { parentId: 'card' }, label: { parentId: 'row' },
    solo: { parentId: 'root' },
    pane: { parentId: 'root' }, chip: { parentId: 'pane' }, leaf: { parentId: 'chip' },
  },
})
const theme = (id: string, colorScheme: 'light' | 'dark', attribute: string | null = id === 'default' ? null : id): DesignTheme => ({ id, name: id, selector: attribute === null ? ':root' : `[data-theme='${attribute}']`, attribute, colorScheme })

describe('stored modes', () => {
  it('reads a missing field and the root as inherit and validates the three modes', () => {
    expect(nodeThemeMode(graph().nodes.label)).toBe('inherit')
    expect(nodeThemeMode(graph().nodes.root)).toBe('inherit')
    expect(nodeThemeMode(graph().nodes.card)).toBe('dark')
    expect(nodeThemeMode(undefined)).toBe('inherit')
    for (const mode of ['inherit', 'light', 'dark']) expect(isNodeThemeMode(mode)).toBe(true)
    for (const bad of ['auto', 'DARK', '', null, 1, undefined]) expect(isNodeThemeMode(bad)).toBe(false)
  })
})

describe('CC-NT-003 and CC-NT-004: effective theme from the nearest explicit ancestor', () => {
  it('an inheriting node takes the nearest explicit ancestor before the file fallback', () => {
    expect(resolveEffectiveNodeTheme(graph(), 'label', 'light')).toEqual({ mode: 'dark', source: { kind: 'ancestor', nodeId: 'card' } })
    expect(resolveEffectiveNodeTheme(graph(), 'row', 'light')).toEqual({ mode: 'dark', source: { kind: 'ancestor', nodeId: 'card' } })
    expect(resolveEffectiveNodeTheme(graph(), 'solo', 'light')).toEqual({ mode: 'light', source: { kind: 'fallback' } })
    expect(resolveEffectiveNodeTheme(graph(), 'solo', 'dark')).toEqual({ mode: 'dark', source: { kind: 'fallback' } })
  })
  it('a nested explicit override wins for itself and its inheriting descendants', () => {
    expect(resolveEffectiveNodeTheme(graph(), 'chip', 'light')).toEqual({ mode: 'dark', source: { kind: 'self' } })
    expect(resolveEffectiveNodeTheme(graph(), 'leaf', 'light')).toEqual({ mode: 'dark', source: { kind: 'ancestor', nodeId: 'chip' } })
    expect(resolveEffectiveNodeTheme(graph(), 'pane', 'dark')).toEqual({ mode: 'light', source: { kind: 'self' } })
  })
  it('CC-NT-005: reparenting changes only the effective theme, read from the new relationships', () => {
    const moved = graph()
    moved.relationships.label = { parentId: 'chip' }
    expect(resolveEffectiveNodeTheme(moved, 'label', 'light')).toEqual({ mode: 'dark', source: { kind: 'ancestor', nodeId: 'chip' } })
    moved.relationships.label = { parentId: 'root' }
    expect(resolveEffectiveNodeTheme(moved, 'label', 'light')).toEqual({ mode: 'light', source: { kind: 'fallback' } })
    expect(moved.nodes.label).toEqual(graph().nodes.label)
  })
  it('reports a cycle or a missing node and returns the fallback instead of looping', () => {
    // The cycle members all inherit, so the walk cannot stop at an explicit mode before noticing the loop.
    const cyclic = graph()
    cyclic.nodes.card = { id: 'card', type: 'component', themeMode: 'inherit' }
    cyclic.relationships.card = { parentId: 'label' }
    expect(resolveEffectiveNodeTheme(cyclic, 'label', 'light')).toEqual({ mode: 'light', source: { kind: 'fallback' }, diagnostic: 'cycle' })
    const dangling = graph()
    dangling.relationships.row = { parentId: 'ghost' }
    expect(resolveEffectiveNodeTheme(dangling, 'label', 'dark')).toEqual({ mode: 'dark', source: { kind: 'fallback' }, diagnostic: 'missing-node' })
    expect(resolveEffectiveNodeTheme(graph(), 'nobody', 'light')).toEqual({ mode: 'light', source: { kind: 'fallback' }, diagnostic: 'missing-node' })
    // Negative control: the same walk without the cycle resolves normally.
    expect(resolveEffectiveNodeTheme(graph(), 'label', 'light').diagnostic).toBeUndefined()
  })
})

describe('CC-NT-009: concrete theme for a scheme', () => {
  const themes = [theme('default', 'light'), theme('dark', 'dark'), theme('midnight', 'dark'), theme('paper', 'light')]
  it('prefers the active preview theme when it has the requested scheme', () => {
    expect(resolveThemeForMode(themes, 'midnight', 'dark')).toEqual({ status: 'resolved', theme: themes[2] })
    expect(resolveThemeForMode(themes, 'paper', 'light')).toEqual({ status: 'resolved', theme: themes[3] })
  })
  it('then a theme whose id is the scheme, then the base theme for light, then the sole theme with that scheme', () => {
    expect(resolveThemeForMode(themes, 'paper', 'dark')).toEqual({ status: 'resolved', theme: themes[1] })
    expect(resolveThemeForMode([theme('default', 'light'), theme('midnight', 'dark')], 'midnight', 'light')).toEqual({ status: 'resolved', theme: theme('default', 'light') })
    expect(resolveThemeForMode([theme('default', 'light'), theme('midnight', 'dark')], 'default', 'dark')).toEqual({ status: 'resolved', theme: theme('midnight', 'dark') })
  })
  it('is missing without any theme of that scheme and ambiguous with several unresolved candidates', () => {
    expect(resolveThemeForMode([theme('default', 'light')], 'default', 'dark')).toEqual({ status: 'missing' })
    expect(resolveThemeForMode([theme('default', 'light'), theme('midnight', 'dark'), theme('ink', 'dark')], 'default', 'dark')).toEqual({ status: 'ambiguous', candidates: ['midnight', 'ink'] })
    // Negative control: naming one of them as the preview theme resolves the ambiguity.
    expect(resolveThemeForMode([theme('default', 'light'), theme('midnight', 'dark'), theme('ink', 'dark')], 'ink', 'dark')).toEqual({ status: 'resolved', theme: theme('ink', 'dark') })
    // A theme literally called "dark" that is a light scheme does not count as the dark mapping.
    expect(resolveThemeForMode([theme('default', 'light'), theme('dark', 'light')], 'default', 'dark')).toEqual({ status: 'missing' })
  })
  it('the file fallback scheme follows the preview theme, the base theme, or light', () => {
    expect(fallbackScheme(themes, 'midnight')).toBe('dark')
    expect(fallbackScheme(themes, 'nope')).toBe('light')
    expect(fallbackScheme([theme('ink', 'dark')], null)).toBe('dark')
    expect(fallbackScheme([], null)).toBe('light')
  })
})
