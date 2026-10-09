export type Color = { r: number; g: number; b: number; a: number }
export type Hsv = { h: number; s: number; v: number; a: number }
export type Hsl = { h: number; s: number; l: number; a: number }
export type Lch = { l: number; c: number; h: number; a: number }

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
  const functionName = /^(rgb|rgba|hsl|hsla|lch)\((.*)\)$/.exec(value)
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
  if (functionName[1] === 'lch') {
    const l = percent(values[0]!)
    const c = Number(values[1])
    const h = hue(values[2]!)
    return l === null || !inRange(c, 150) || h === null ? null : lchToRgb({ l, c, h, a: opacity })
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

const labCurve = (value: number) => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116
const inverseLabCurve = (value: number) => value ** 3 > 216 / 24389 ? value ** 3 : (116 * value - 16) / (24389 / 27)
const linearChannel = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const encodedChannel = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055

/** Converts an sRGB color to CSS Color 4 CIE LCH using a D50 reference white. */
export function rgbToLch(color: Color): Lch {
  const r = linearChannel(color.r / 255)
  const g = linearChannel(color.g / 255)
  const b = linearChannel(color.b / 255)
  const d65x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const d65y = r * 0.2126729 + g * 0.7151522 + b * 0.072175
  const d65z = r * 0.0193339 + g * 0.119192 + b * 0.9503041
  const x = d65x * 1.0479298 + d65y * 0.0229468 - d65z * 0.0501922
  const y = d65x * 0.0296278 + d65y * 0.9904345 - d65z * 0.0170738
  const z = -d65x * 0.009243 + d65y * 0.0150552 + d65z * 0.7518743
  const fx = labCurve(x / 0.96422)
  const fy = labCurve(y)
  const fz = labCurve(z / 0.82521)
  const l = 116 * fy - 16
  const a = 500 * (fx - fy)
  const labB = 200 * (fy - fz)
  const h = (Math.atan2(labB, a) * 180 / Math.PI + 360) % 360
  return { l, c: Math.sqrt(a * a + labB * labB), h, a: color.a }
}

/** Converts CSS Color 4 CIE LCH to the nearest displayable sRGB color. */
export function lchToRgb(value: Lch): Color {
  const radians = value.h * Math.PI / 180
  const labA = value.c * Math.cos(radians)
  const labB = value.c * Math.sin(radians)
  const fy = (value.l + 16) / 116
  const fx = fy + labA / 500
  const fz = fy - labB / 200
  const d50x = 0.96422 * inverseLabCurve(fx)
  const d50y = inverseLabCurve(fy)
  const d50z = 0.82521 * inverseLabCurve(fz)
  const x = d50x * 0.9554734 - d50y * 0.0230985 + d50z * 0.0632593
  const y = -d50x * 0.0283697 + d50y * 1.0099955 + d50z * 0.0210414
  const z = d50x * 0.012314 - d50y * 0.0205077 + d50z * 1.3303659
  const r = encodedChannel(x * 3.2404542 - y * 1.5371385 - z * 0.4985314)
  const g = encodedChannel(-x * 0.969266 + y * 1.8760108 + z * 0.041556)
  const b = encodedChannel(x * 0.0556434 - y * 0.2040259 + z * 1.0572252)
  return { r: byte(r * 255), g: byte(g * 255), b: byte(b * 255), a: value.a }
}

export function formatLch(color: Color): string {
  const lch = rgbToLch(color)
  const channels = `${decimal(lch.l)}% ${decimal(lch.c)} ${decimal(lch.h)}`
  return color.a >= 1 ? `lch(${channels})` : `lch(${channels} / ${decimal(color.a)})`
}
