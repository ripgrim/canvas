export type Color = { r: number; g: number; b: number; a: number }
export type Hsv = { h: number; s: number; v: number; a: number }
export type Hsl = { h: number; s: number; l: number; a: number }

const inRange = (value: number, max: number) => Number.isFinite(value) && value >= 0 && value <= max
const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
const decimal = (value: number) => Number(value.toFixed(3))

function alpha(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(%)?$/.exec(value.trim())
  if (!match) return null
  const number = Number(match[1])
  const limit = match[2] ? 100 : 1
  return inRange(number, limit) ? number / limit : null
}

function parts(value: string): string[] | null {
  if (value.includes(',')) {
    if (value.includes('/')) return null
    const values = value.split(',').map(part => part.trim())
    return values.length === 3 || values.length === 4 ? values : null
  }
  const halves = value.split('/')
  if (halves.length > 2) return null
  const values = halves[0]!.trim().split(/\s+/)
  if (values.length !== 3 || halves.length === 2 && !halves[1]?.trim()) return null
  if (halves.length === 2) values.push(halves[1]!.trim())
  return values
}

function channel(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(%)?$/.exec(value)
  if (!match) return null
  const number = Number(match[1])
  const limit = match[2] ? 100 : 255
  return inRange(number, limit) ? byte(match[2] ? number * 255 / 100 : number) : null
}

function percent(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?|\.\d+)%$/.exec(value)
  const number = Number(match?.[1])
  return match && inRange(number, 100) ? number : null
}

function hue(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(?:deg)?$/.exec(value)
  const number = Number(match?.[1])
  return match && inRange(number, 360) ? number % 360 : null
}

export function parseColor(input: string): Color | null {
  const value = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1]
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map(digit => digit + digit).join('') : hex
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16), g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16), a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    }
  }
  const functionName = /^(rgb|rgba|hsl|hsla)\((.*)\)$/.exec(value)
  if (!functionName) return null
  const values = parts(functionName[2]!)
  if (!values || functionName[1]!.endsWith('a') && values.length !== 4) return null
  const opacity = values.length === 4 ? alpha(values[3]!) : 1
  if (opacity === null) return null
  if (functionName[1]!.startsWith('rgb')) {
    const channels = values.slice(0, 3).map(channel)
    if (channels.some(part => part === null)) return null
    return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: opacity }
  }
  const h = hue(values[0]!)
  const s = percent(values[1]!)
  const l = percent(values[2]!)
  return h === null || s === null || l === null ? null : hslToRgb({ h, s, l, a: opacity })
}

export function formatHex(color: Color, includeAlpha = color.a < 1): string {
  const channels = [color.r, color.g, color.b, ...(includeAlpha ? [color.a * 255] : [])]
  return `#${channels.map(value => byte(value).toString(16).padStart(2, '0')).join('')}`
}

export function formatRgb(color: Color): string {
  const channels = `${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}`
  return color.a >= 1 ? `rgb(${channels})` : `rgba(${channels}, ${decimal(color.a)})`
}

export function rgbToHsv(color: Color): Hsv {
  const r = color.r / 255, g = color.g / 255, b = color.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), difference = max - min
  let h = 0
  if (difference > 0) {
    if (max === r) h = ((g - b) / difference) % 6
    else if (max === g) h = (b - r) / difference + 2
    else h = (r - g) / difference + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: max === 0 ? 0 : difference / max * 100, v: max * 100, a: color.a }
}

export function hsvToRgb(value: Hsv): Color {
  const h = ((value.h % 360) + 360) % 360
  const s = value.s / 100, v = value.v / 100
  const chroma = v * s, x = chroma * (1 - Math.abs((h / 60) % 2 - 1)), offset = v - chroma
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x]
  return { r: byte((r + offset) * 255), g: byte((g + offset) * 255), b: byte((b + offset) * 255), a: value.a }
}

export function rgbToHsl(color: Color): Hsl {
  const r = color.r / 255, g = color.g / 255, b = color.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), difference = max - min
  const l = (max + min) / 2
  let h = 0, s = 0
  if (difference > 0) {
    s = difference / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / difference) % 6
    else if (max === g) h = (b - r) / difference + 2
    else h = (r - g) / difference + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: s * 100, l: l * 100, a: color.a }
}

export function hslToRgb(value: Hsl): Color {
  const h = ((value.h % 360) + 360) % 360
  const s = value.s / 100, l = value.l / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s, x = chroma * (1 - Math.abs((h / 60) % 2 - 1)), offset = l - chroma / 2
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x]
  return { r: byte((r + offset) * 255), g: byte((g + offset) * 255), b: byte((b + offset) * 255), a: value.a }
}

export function formatHsl(color: Color): string {
  const hsl = rgbToHsl(color)
  const channels = `${decimal(hsl.h)}deg, ${decimal(hsl.s)}%, ${decimal(hsl.l)}%`
  return color.a >= 1 ? `hsl(${channels})` : `hsla(${channels}, ${decimal(color.a)})`
}
