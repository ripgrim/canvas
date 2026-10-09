import { describe, expect, it } from 'vitest'
import { formatHex, formatHsl, formatLch, formatRgb, hslToRgb, hsvToRgb, lchToRgb, parseColor, rgbToHsl, rgbToHsv, rgbToLch } from './color'

describe('color input', () => {
  it('parses HEX lengths and alpha without losing the byte value', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('#0f08')).toEqual({ r: 0, g: 255, b: 0, a: 136 / 255 })
    expect(parseColor('#12345678')).toEqual({ r: 18, g: 52, b: 86, a: 120 / 255 })
    expect(formatHex({ r: 18, g: 52, b: 86, a: 120 / 255 })).toBe('#12345678')
    expect(formatHex({ r: 0, g: 159, b: 240, a: 1 })).toBe('#009ff0')
  })

  it('parses bounded RGB and HSL spellings into known colors', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('rgba(0, 0, 255, 0.5)')).toEqual({ r: 0, g: 0, b: 255, a: 0.5 })
    expect(parseColor('rgb(100% 0% 0% / 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
    expect(parseColor('hsl(120, 100%, 50%)')).toEqual({ r: 0, g: 255, b: 0, a: 1 })
    expect(parseColor('hsla(240deg, 100%, 50%, 0.25)')).toEqual({ r: 0, g: 0, b: 255, a: 0.25 })
    expect(formatRgb({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('rgba(255, 0, 0, 0.5)')
    expect(formatHsl({ r: 255, g: 0, b: 0, a: 1 })).toBe('hsl(0deg, 100%, 50%)')
  })

  it('converts HSV and HSL primaries with independent expected channels', () => {
    expect(hsvToRgb({ h: 60, s: 100, v: 100, a: 1 })).toEqual({ r: 255, g: 255, b: 0, a: 1 })
    expect(hslToRgb({ h: 180, s: 100, l: 50, a: 1 })).toEqual({ r: 0, g: 255, b: 255, a: 1 })
    expect(rgbToHsv({ r: 0, g: 0, b: 255, a: 0.5 })).toEqual({ h: 240, s: 100, v: 100, a: 0.5 })
    expect(rgbToHsl({ r: 255, g: 255, b: 0, a: 1 })).toEqual({ h: 60, s: 100, l: 50, a: 1 })
  })

  it('round-trips sRGB through D50 LCH with independently known red coordinates', () => {
    const red = rgbToLch({ r: 255, g: 0, b: 0, a: 0.5 })
    expect(red.l).toBeCloseTo(54.29, 1)
    expect(red.c).toBeCloseTo(106.84, 1)
    expect(red.h).toBeCloseTo(40.85, 1)
    expect(lchToRgb(red)).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
    expect(formatLch({ r: 255, g: 0, b: 0, a: 1 })).toMatch(/^lch\(54\.29\d% 106\.8\d+ 40\.85\d\)$/)
    const parsed = parseColor('lch(54.292% 106.839 40.853 / 50%)')
    expect(parsed).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
  })

  it('rejects overflow, incomplete values, and injected CSS', () => {
    for (const value of ['#ggg', '#12345', 'rgb(256, 0, 0)', 'rgb(-1, 0, 0)', 'rgba(1, 2, 3, 1.1)', 'hsl(361, 50%, 50%)', 'hsl(0, 101%, 50%)', 'lch(50% 151 20)', 'var(--color-1)', '#fff; color: red', 'rgb(1, 2, 3, 4)']) {
      expect(parseColor(value), value).toBeNull()
    }
  })
})
