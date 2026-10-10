import type { ShadcnToken } from '@canvas/scanner/contracts'
import { colorToCss, hexColor } from '@canvas/repo-engine/color'
import type { Color } from '@canvas/repo-engine/color'
import { formatHex, parseColor } from './color'
import { normalizeCssColor } from './design-theme'

export type RepositoryColorToken = Readonly<{
  property: string
  name: string
  fallback: Color
  color: string
  themes: readonly string[]
  paths: readonly string[]
}>

export type RepositoryTokenCatalog = Readonly<{
  colors: readonly RepositoryColorToken[]
  hidden: number
}>

const cssVariable = /^--[A-Za-z0-9_-]+$/
const simpleAlias = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)$/

function oklch(value: string): Color | null {
  const match = /^oklch\(\s*(\d*\.?\d+)(%)?\s+(\d*\.?\d+)\s+(\d*\.?\d+)(?:deg)?(?:\s*\/\s*(\d*\.?\d+)(%)?)?\s*\)$/i.exec(value)
  if (!match) return null
  const lightness = Number(match[1]) / (match[2] ? 100 : 1)
  const chroma = Number(match[3])
  const hue = Number(match[4])
  const opacity = match[5] === undefined ? undefined : Number(match[5]) / (match[6] ? 100 : 1)
  if (![lightness, chroma, hue, opacity ?? 1].every(Number.isFinite) || lightness < 0 || lightness > 1 || chroma < 0 || chroma > 1 || hue < 0 || hue > 360 || opacity !== undefined && (opacity < 0 || opacity > 1)) return null
  return { kind: 'oklch', l: lightness, c: chroma, h: hue, ...(opacity === undefined ? {} : { alpha: opacity }) }
}

function literalColor(value: string): Color | null {
  const trimmed = value.trim()
  if (/\bvar\(/i.test(trimmed)) return null
  if (trimmed === 'transparent') return hexColor('#00000000')
  const parsedOklch = oklch(trimmed)
  if (parsedOklch) return parsedOklch
  const parsed = parseColor(trimmed)
  if (parsed) return hexColor(formatHex(parsed))
  if (typeof CSS !== 'undefined' && CSS.supports('color', trimmed)) {
    const normalized = normalizeCssColor(trimmed)
    if (normalized) return hexColor(normalized)
  }
  return null
}

function displayName(property: string): string {
  const words = property.slice(2).split('-').filter(Boolean)
  const label = words.join(' ')
  return label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : property
}

function preferred(tokens: readonly ShadcnToken[], theme?: string): ShadcnToken | undefined {
  return theme ? tokens.find(token => token.theme === theme) ?? tokens.find(token => token.theme === 'base') ?? tokens[0] : tokens.find(token => token.theme === 'base') ?? tokens[0]
}

function resolveColor(property: string, grouped: ReadonlyMap<string, readonly ShadcnToken[]>, theme: string | undefined, seen = new Set<string>()): Color | null {
  if (seen.has(property)) return null
  const token = preferred(grouped.get(property) ?? [], theme)
  if (!token) return null
  const direct = literalColor(token.value)
  if (direct) return direct
  const alias = simpleAlias.exec(token.value.trim())
  if (!alias) return null
  const next = alias[1]!
  const nested = new Set(seen).add(property)
  return resolveColor(next, grouped, token.theme, nested) ?? (alias[2] ? literalColor(alias[2]) : null)
}

/** One compact, importable color entry per CSS custom property. Theme variants remain one source-backed design token. */
export function repositoryTokenCatalog(tokens: readonly ShadcnToken[]): RepositoryTokenCatalog {
  const grouped = new Map<string, ShadcnToken[]>()
  for (const token of tokens) {
    if (!cssVariable.test(token.name)) continue
    const entries = grouped.get(token.name) ?? []
    entries.push(token)
    grouped.set(token.name, entries)
  }
  const colors: RepositoryColorToken[] = []
  for (const [property, entries] of grouped) {
    const fallback = resolveColor(property, grouped, undefined)
    if (!fallback) continue
    colors.push({
      property,
      name: displayName(property),
      fallback,
      color: colorToCss(fallback),
      themes: [...new Set(entries.map(token => token.theme))],
      paths: [...new Set(entries.map(token => token.path))],
    })
  }
  colors.sort((left, right) => left.name.localeCompare(right.name))
  return { colors, hidden: grouped.size - colors.length }
}
