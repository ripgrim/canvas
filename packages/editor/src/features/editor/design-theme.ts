import { designTokenValues, resolveDesignTheme } from '@canvas/repo-engine/design-themes'
import type { DesignTheme } from '@canvas/repo-engine/design-themes'
import type { SourcePalette } from '@canvas/repo-engine/file-document'
import type { ThemeProjectionContext } from '@canvas/repo-engine/file-preview'
import type { PreviewTheme } from '@canvas/preview-runtime/protocol'
import type { EditorProjectSnapshot } from '../../capabilities'

/**
 * The design preview theme is a per-file viewing preference, resolved against the themes the design stylesheet
 * declares. The editor's appearance plays no part here.
 */
export function activeDesignTheme(snapshot: Pick<EditorProjectSnapshot, 'designThemes'> | null | undefined, previewThemeId: string | null | undefined): DesignTheme | null {
  const themes = snapshot?.designThemes ?? []
  return themes.length ? resolveDesignTheme(themes, previewThemeId) : null
}

export function designThemeOptions(snapshot: Pick<EditorProjectSnapshot, 'designThemes'> | null | undefined): { value: string; label: string }[] {
  return (snapshot?.designThemes ?? []).map(theme => ({ value: theme.id, label: theme.name }))
}

/** The message shape the preview runtime applies to its document root. */
export function previewThemeMessage(theme: DesignTheme | null): PreviewTheme {
  return theme ? { attribute: theme.attribute, colorScheme: theme.colorScheme } : { attribute: null, colorScheme: 'light' }
}

let colorScratch: CanvasRenderingContext2D | null | undefined

/** Normalizes any CSS color (including oklch) to #rrggbb for the preview protocol and inspector fields. */
export function normalizeCssColor(value: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase()
  if (/^#[0-9a-fA-F]{8}$/.test(value)) return value.slice(0, 7).toLowerCase()
  if (colorScratch === undefined) colorScratch = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!colorScratch) return null
  colorScratch.fillStyle = '#000000'
  colorScratch.fillStyle = value
  const normalized = colorScratch.fillStyle
  if (typeof normalized === 'string' && /^#[0-9a-fA-F]{6}$/.test(normalized)) return normalized.toLowerCase()
  if (typeof normalized === 'string' && /^#[0-9a-fA-F]{8}$/.test(normalized)) return normalized.slice(0, 7).toLowerCase()
  colorScratch.clearRect(0, 0, 1, 1)
  colorScratch.fillRect(0, 0, 1, 1)
  const [red, green, blue] = colorScratch.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue].map(channel => channel!.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Design stylesheet custom properties of the active design theme as colors, keyed by property name (`--surface`).
 * File tokens of kind `source` resolve against this palette; the editor chrome never contributes.
 */
export function designSourcePalette(snapshot: Pick<EditorProjectSnapshot, 'designThemes' | 'tokens'> | null | undefined, previewThemeId: string | null | undefined): SourcePalette {
  const theme = activeDesignTheme(snapshot, previewThemeId)
  if (!theme || !snapshot) return {}
  return paletteOfTheme(snapshot, theme)
}
function paletteOfTheme(snapshot: Pick<EditorProjectSnapshot, 'tokens'>, theme: DesignTheme): SourcePalette {
  const palette: SourcePalette = {}
  for (const [name, value] of Object.entries(designTokenValues(snapshot.tokens, theme))) {
    const color = normalizeCssColor(value)
    if (color) palette[`--${name}`] = { kind: 'hex', hex: color }
  }
  return palette
}
/**
 * Everything the projection needs to resolve each node against its own effective theme: the declared themes, the
 * file's preview choice (the fallback), and a palette per concrete theme, computed once per theme per context.
 */
export function themeProjectionContext(snapshot: Pick<EditorProjectSnapshot, 'designThemes' | 'tokens'> | null | undefined, previewThemeId: string | null | undefined): ThemeProjectionContext {
  const palettes = new Map<string, SourcePalette>()
  return {
    themes: snapshot?.designThemes ?? [],
    previewThemeId: previewThemeId ?? null,
    palette: theme => { let palette = palettes.get(theme.id); if (!palette) { palette = snapshot ? paletteOfTheme(snapshot, theme) : {}; palettes.set(theme.id, palette) } return palette },
  }
}
