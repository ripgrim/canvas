/**
 * Design colors stored in a file. Hex keeps the project's existing six and eight digit literals untouched; OKLCH is
 * accepted for values authored in that space (as in Paper captures). Resolution always produces #rrggbb[aa] for the
 * preview protocol and sRGB CSS for rendering.
 */
export type Color =
  | { kind: 'hex'; hex: string }
  | { kind: 'oklch'; l: number; c: number; h: number; alpha?: number }

export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export function isColor(value: unknown): value is Color {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (record.kind === 'hex') return keys.length === 2 && isHexColor(record.hex)
  if (record.kind === 'oklch') {
    if (!keys.every(key => ['kind', 'l', 'c', 'h', 'alpha'].includes(key))) return false
    return finite(record.l, 0, 1) && finite(record.c, 0, 1) && finite(record.h, 0, 360) && (record.alpha === undefined || finite(record.alpha, 0, 1))
  }
  return false
}

export const hexColor = (hex: string): Color => ({ kind: 'hex', hex: hex.toLowerCase() })

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const channel = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, '0')
const gamma = (linear: number) => linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055

/** OKLCH to sRGB with simple channel clipping, matching how browsers display out of gamut values by default. */
export function oklchToHex(l: number, c: number, h: number, alpha = 1): string {
  const radians = (h * Math.PI) / 180
  const a = c * Math.cos(radians)
  const b = c * Math.sin(radians)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b
  const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3
  const red = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  const green = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  const blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
  const hex = `#${channel(gamma(red))}${channel(gamma(green))}${channel(gamma(blue))}`
  return alpha < 1 ? `${hex}${channel(alpha)}` : hex
}

/** #rrggbb or #rrggbbaa, lower case. */
export function colorToHex(color: Color): string {
  if (color.kind === 'hex') return color.hex.length === 9 && color.hex.toLowerCase().endsWith('ff') ? color.hex.slice(0, 7).toLowerCase() : color.hex.toLowerCase()
  return oklchToHex(color.l, color.c, color.h, color.alpha ?? 1)
}

/** CSS the browser renders: hex for hex literals, oklch() for OKLCH literals (alpha included when present). */
export function colorToCss(color: Color): string {
  if (color.kind === 'hex') return color.hex.toLowerCase()
  return color.alpha !== undefined && color.alpha < 1 ? `oklch(${color.l} ${color.c} ${color.h} / ${color.alpha})` : `oklch(${color.l} ${color.c} ${color.h})`
}

export const sameColor = (left: Color, right: Color) => colorToHex(left) === colorToHex(right)
