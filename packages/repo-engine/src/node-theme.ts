/**
 * Per-node theme modes: a node stores `inherit`, `light` or `dark`; the effective scheme walks the document
 * relationships (never the DOM) to the nearest explicit ancestor and falls back to the file's design-preview theme.
 * Changing a mode never touches tokens, colors, appearance, layout or source; it only selects which design theme's
 * palette resolves source-backed tokens for that subtree.
 */
import type { DesignTheme } from './design-themes.js'
import { defaultDesignThemeId } from './design-themes.js'

export type NodeThemeMode = 'inherit' | 'light' | 'dark'
export type ColorScheme = 'light' | 'dark'
export const nodeThemeModes: readonly NodeThemeMode[] = ['inherit', 'light', 'dark']
export const isNodeThemeMode = (value: unknown): value is NodeThemeMode => (nodeThemeModes as readonly unknown[]).includes(value)
export const isColorScheme = (value: unknown): value is ColorScheme => value === 'light' || value === 'dark'

type ThemedNode = { id: string; type: string; themeMode?: NodeThemeMode | undefined }
type ThemeGraph = { nodes: Record<string, ThemedNode>; relationships: Record<string, { parentId: string }> }

/** The stored mode of any node; roots and nodes written before the field existed count as `inherit`. */
export const nodeThemeMode = (node: ThemedNode | undefined): NodeThemeMode => node && node.type !== 'root' && node.themeMode !== undefined ? node.themeMode : 'inherit'

export type EffectiveNodeTheme = {
  mode: ColorScheme
  /** Where the scheme came from: the node itself, the nearest explicit ancestor, or the file fallback. */
  source: { kind: 'self' } | { kind: 'ancestor'; nodeId: string } | { kind: 'fallback' }
  /** Set when the relationship walk could not be trusted; the fallback scheme is returned in that case. */
  diagnostic?: 'cycle' | 'missing-node'
}

/** Nearest explicit mode up the relationship graph, else the fallback. A cycle or dangling parent is reported, not followed. */
export function resolveEffectiveNodeTheme(graph: ThemeGraph, nodeId: string, fallback: ColorScheme): EffectiveNodeTheme {
  const seen = new Set<string>()
  let current: string | undefined = nodeId
  while (current !== undefined) {
    if (seen.has(current)) return { mode: fallback, source: { kind: 'fallback' }, diagnostic: 'cycle' }
    seen.add(current)
    const node = graph.nodes[current]
    if (!node) return { mode: fallback, source: { kind: 'fallback' }, diagnostic: 'missing-node' }
    const mode = nodeThemeMode(node)
    if (mode !== 'inherit') return { mode, source: current === nodeId ? { kind: 'self' } : { kind: 'ancestor', nodeId: current } }
    if (node.type === 'root') break
    current = graph.relationships[current]?.parentId
    if (current === undefined && node.type !== 'root') return { mode: fallback, source: { kind: 'fallback' }, diagnostic: 'missing-node' }
  }
  return { mode: fallback, source: { kind: 'fallback' } }
}

export type ThemeForMode =
  | { status: 'resolved'; theme: DesignTheme }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: string[] }

/**
 * The concrete design theme for a scheme, deterministically: the active preview theme when it has that scheme, then a
 * theme whose id is the scheme itself, then the base theme for `light`, then the sole theme with that scheme. Several
 * remaining candidates are ambiguous rather than a silent first pick.
 */
export function resolveThemeForMode(themes: readonly DesignTheme[], previewThemeId: string | null | undefined, mode: ColorScheme): ThemeForMode {
  const active = themes.find(theme => theme.id === previewThemeId)
  if (active && active.colorScheme === mode) return { status: 'resolved', theme: active }
  const named = themes.find(theme => theme.id === mode)
  if (named && named.colorScheme === mode) return { status: 'resolved', theme: named }
  if (mode === 'light') { const base = themes.find(theme => theme.id === defaultDesignThemeId); if (base && base.colorScheme === 'light') return { status: 'resolved', theme: base } }
  const candidates = themes.filter(theme => theme.colorScheme === mode)
  if (candidates.length === 1) return { status: 'resolved', theme: candidates[0]! }
  if (candidates.length === 0) return { status: 'missing' }
  return { status: 'ambiguous', candidates: candidates.map(theme => theme.id) }
}

/** The scheme the file fallback renders in, from the active preview theme (or the base theme when nothing is declared). */
export const fallbackScheme = (themes: readonly DesignTheme[], previewThemeId: string | null | undefined): ColorScheme => (themes.find(theme => theme.id === previewThemeId) ?? themes.find(theme => theme.id === defaultDesignThemeId) ?? themes[0])?.colorScheme ?? 'light'
