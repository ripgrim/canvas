/**
 * Theme modes a design declares in its own stylesheet.
 *
 * The list is derived from the selectors that carry the design's custom properties: the stylesheet root is the base
 * theme and every `[data-theme=…]` selector is a further mode. Nothing here reads the editor's appearance, the operating
 * system, or `prefers-color-scheme`, so a design with a single root palette honestly exposes a single theme.
 */
export type DesignToken = { name: string; value: string; path: string; selector: string }
export type DesignTheme = {
  /** Stable identifier persisted with the design file. The stylesheet root is `default`; attribute modes use the attribute value. */
  id: string
  name: string
  selector: string
  /** Value written to `data-theme` on the preview document root, or null to clear the attribute for the base theme. */
  attribute: string | null
  /** Form controls and scrollbars follow this `color-scheme`. Attribute names containing dark/night/black are treated as dark. */
  colorScheme: 'light' | 'dark'
}

export const defaultDesignThemeId = 'default'
const attributeSelector = /^(?::root|html)?\[data-theme=(?:"([A-Za-z0-9_-]{1,40})"|'([A-Za-z0-9_-]{1,40})'|([A-Za-z0-9_-]{1,40}))\]$/
const baseSelectors = new Set([':root', 'html', 'body', ':root,body', 'html,body'])
const normalizeSelector = (selector: string) => selector.replace(/\s+/g, '').trim()
const isBaseSelector = (selector: string) => baseSelectors.has(normalizeSelector(selector))
const attributeOf = (selector: string): string | null => { const match = attributeSelector.exec(normalizeSelector(selector)); return match ? match[1] ?? match[2] ?? match[3] ?? null : null }
const themeName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]+/g, ' ')
const colorSchemeFor = (id: string): 'light' | 'dark' => /dark|night|black/i.test(id) ? 'dark' : 'light'
export const isDesignThemeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)

export function designThemesFromTokens(tokens: readonly DesignToken[]): DesignTheme[] {
  const themes: DesignTheme[] = [{ id: defaultDesignThemeId, name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }]
  for (const token of tokens) {
    const attribute = attributeOf(token.selector)
    if (!attribute || attribute === defaultDesignThemeId || themes.some(theme => theme.id === attribute)) continue
    themes.push({ id: attribute, name: themeName(attribute), selector: token.selector, attribute, colorScheme: colorSchemeFor(attribute) })
  }
  return themes
}

/** The persisted selection when it still names a declared theme, otherwise the base theme. */
export function resolveDesignTheme(themes: readonly DesignTheme[], selected: string | null | undefined): DesignTheme {
  return themes.find(theme => theme.id === selected) ?? themes.find(theme => theme.id === defaultDesignThemeId) ?? themes[0]!
}

/** Custom property values for one theme: base values overlaid by that theme's own declarations. Names drop the leading dashes. */
export function designTokenValues(tokens: readonly DesignToken[], theme: DesignTheme): Record<string, string> {
  const values: Record<string, string> = {}
  for (const token of tokens) if (isBaseSelector(token.selector)) values[token.name.replace(/^--/, '')] = token.value.trim()
  if (theme.attribute !== null) for (const token of tokens) if (attributeOf(token.selector) === theme.attribute) values[token.name.replace(/^--/, '')] = token.value.trim()
  return values
}

/** Custom property declarations from a flat stylesheet (no nesting), for runtimes without a CSS parser. */
export function extractCssTokens(css: string, path: string): DesignToken[] {
  const tokens: DesignToken[] = []
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let match = rule.exec(source); match; match = rule.exec(source)) {
    const selector = match[1]!.trim()
    if (selector.startsWith('@')) continue
    const declaration = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);?/g
    for (let found = declaration.exec(match[2]!); found; found = declaration.exec(match[2]!)) tokens.push({ name: found[1]!, value: found[2]!.trim(), path, selector })
  }
  return tokens
}
