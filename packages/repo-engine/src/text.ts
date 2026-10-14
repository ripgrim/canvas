/** Typography and sizing intent stored by every text node. Geometry remains the measured canvas bounds; letter spacing is a percentage of font size. */
export const textHorizontalAlignments = ['left', 'center', 'right', 'justify'] as const
export const textVerticalAlignments = ['top', 'middle', 'bottom'] as const
export const textCases = ['none', 'uppercase', 'lowercase', 'capitalize'] as const
export const textWrapModes = ['normal', 'pretty', 'balance'] as const
export const textFontStyles = ['normal', 'italic', 'oblique'] as const
export const textSizingModes = ['fixed', 'fit', 'fill', 'relative'] as const

export type TextHorizontalAlignment = typeof textHorizontalAlignments[number]
export type TextVerticalAlignment = typeof textVerticalAlignments[number]
export type TextCase = typeof textCases[number]
export type TextWrapMode = typeof textWrapModes[number]
export type TextFontStyle = typeof textFontStyles[number]
export type TextLineHeightLiteral =
  | { kind: 'normal' }
  | { kind: 'unitless'; value: number }
  | { kind: 'percent'; value: number }
  | { kind: 'px'; value: number }
  | { kind: 'em'; value: number }
export type TextLineHeight = TextLineHeightLiteral | { kind: 'source'; property: string; fallback: TextLineHeightLiteral }
export type TextAxisSizing =
  | { mode: 'fixed' | 'fit' | 'fill' }
  | { mode: 'relative'; value: number }
export type TextSizing = { width: TextAxisSizing; height: TextAxisSizing }
export type TextFontFeatures = Readonly<Record<string, boolean>>
export type TextStyle = {
  fontFamily: string
  fontStyle: TextFontStyle
  fontWeight: number
  fontSize: number
  lineHeight: TextLineHeight
  letterSpacing: number
  horizontalAlign: TextHorizontalAlignment
  verticalAlign: TextVerticalAlignment
  case: TextCase
  wrap: TextWrapMode
  keepWords: boolean
  fontFeatures?: TextFontFeatures
  maxLines?: number
}

/** Exact typography used by schema v7 and the pre-v8 preview runtime. */
export const legacyTextStyle: TextStyle = {
  fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontStyle: 'normal',
  fontWeight: 400,
  fontSize: 16,
  lineHeight: { kind: 'unitless', value: 1.25 },
  letterSpacing: 0,
  horizontalAlign: 'left',
  verticalAlign: 'top',
  case: 'none',
  wrap: 'normal',
  keepWords: false,
}
export const legacyTextSizing: TextSizing = { width: { mode: 'fixed' }, height: { mode: 'fixed' } }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const exactFields = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => typeof value === 'string' && (options as readonly string[]).includes(value)
const sourceProperty = (value: unknown): value is string => typeof value === 'string' && /^--[A-Za-z0-9_-]{1,64}$/.test(value)
const fontFeatureTag = (value: string): boolean => /^[A-Za-z0-9]{4}$/.test(value)

export function validateTextFontFeatures(value: unknown): value is TextFontFeatures {
  return record(value) && Object.keys(value).length <= 256 && Object.entries(value).every(([tag, enabled]) => fontFeatureTag(tag) && typeof enabled === 'boolean')
}

export function validateTextLineHeightLiteral(value: unknown): value is TextLineHeightLiteral {
  if (!record(value) || !oneOf(value.kind, ['normal', 'unitless', 'percent', 'px', 'em'])) return false
  if (value.kind === 'normal') return exactFields(value, ['kind'])
  if (!exactFields(value, ['kind', 'value'])) return false
  if (value.kind === 'percent') return finite(value.value, 1, 10_000)
  if (value.kind === 'px') return finite(value.value, 0.1, 10_000)
  return finite(value.value, 0.01, 100)
}

export function validateTextLineHeight(value: unknown): value is TextLineHeight {
  if (!record(value)) return false
  if (value.kind === 'source') return exactFields(value, ['kind', 'property', 'fallback']) && sourceProperty(value.property) && validateTextLineHeightLiteral(value.fallback)
  return validateTextLineHeightLiteral(value)
}

export function validateTextAxisSizing(value: unknown): value is TextAxisSizing {
  if (!record(value) || !oneOf(value.mode, textSizingModes)) return false
  if (value.mode === 'relative') return exactFields(value, ['mode', 'value']) && finite(value.value, 0.01, 1000)
  return exactFields(value, ['mode'])
}

export function validateTextSizing(value: unknown): value is TextSizing {
  return record(value) && exactFields(value, ['width', 'height']) && validateTextAxisSizing(value.width) && validateTextAxisSizing(value.height)
}

export function validateTextStyle(value: unknown): value is TextStyle {
  if (!record(value) || !exactFields(value, ['fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing', 'horizontalAlign', 'verticalAlign', 'case', 'wrap', 'keepWords'], ['fontFeatures', 'maxLines'])) return false
  if (typeof value.fontFamily !== 'string' || value.fontFamily.trim() !== value.fontFamily || value.fontFamily.length < 1 || value.fontFamily.length > 256 || /[\u0000-\u001f\u007f]/.test(value.fontFamily)) return false
  if (!oneOf(value.fontStyle, textFontStyles) || !Number.isInteger(value.fontWeight) || !finite(value.fontWeight, 1, 1000)) return false
  if (!finite(value.fontSize, 1, 10_000) || !validateTextLineHeight(value.lineHeight) || !finite(value.letterSpacing, -10_000, 10_000)) return false
  if (!oneOf(value.horizontalAlign, textHorizontalAlignments) || !oneOf(value.verticalAlign, textVerticalAlignments) || !oneOf(value.case, textCases) || !oneOf(value.wrap, textWrapModes)) return false
  if (typeof value.keepWords !== 'boolean') return false
  if (Object.hasOwn(value, 'fontFeatures') && !validateTextFontFeatures(value.fontFeatures)) return false
  return !Object.hasOwn(value, 'maxLines') || Number.isInteger(value.maxLines) && finite(value.maxLines, 1, 10_000)
}

/** Paper exposes truncation only for Fit-height text; presence of maxLines is the stored truncation switch. */
export function textStyleMatchesSizing(style: TextStyle, sizing: TextSizing): boolean {
  return style.maxLines === undefined || sizing.height.mode === 'fit'
}

export const legacyTextProperties = (): { textStyle: TextStyle; textSizing: TextSizing } => ({
  textStyle: { ...legacyTextStyle, lineHeight: { ...legacyTextStyle.lineHeight } },
  textSizing: { width: { ...legacyTextSizing.width }, height: { ...legacyTextSizing.height } },
})
