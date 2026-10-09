import { describe, expect, it } from 'vitest'
import { colorToCss, colorToHex, hexColor, isColor, isHexColor, oklchToHex, sameColor } from '../src/color.js'

const channels = (hex: string) => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16))
const expectNearHex = (actual: string, expected: string) => {
  expect(actual).toMatch(/^#[0-9a-f]{6}$/)
  const got = channels(actual)
  channels(expected).forEach((value, index) => expect(Math.abs(got[index]! - value)).toBeLessThanOrEqual(1))
}

describe('oklch to hex', () => {
  it('maps white and black exactly', () => {
    expect(oklchToHex(1, 0, 29.235)).toBe('#ffffff')
    expect(oklchToHex(0, 0, 0)).toBe('#000000')
  })

  // Reference coordinates are the CSS Color 4 published OKLCH values of the sRGB primaries.
  it('maps the sRGB primaries back to their hex values', () => {
    expectNearHex(oklchToHex(0.62796, 0.25768, 29.235), '#ff0000')
    expectNearHex(oklchToHex(0.86644, 0.29483, 142.4953), '#00ff00')
    expectNearHex(oklchToHex(0.45201, 0.31321, 264.052), '#0000ff')
  })

  it('is not lenient about hue (negative control)', () => {
    const shifted = channels(oklchToHex(0.87234, 0.25097, 148.234))
    expect(shifted[0]).toBeLessThanOrEqual(1)
    expect(shifted[1]).toBeGreaterThanOrEqual(254)
    // This hue lands near #00ff6b, far from pure green, so a broken hue rotation would not pass the primary checks above.
    expect(shifted[2]).toBeGreaterThan(90)
  })

  it('clips out of gamut channels instead of producing NaN', () => {
    expect(oklchToHex(0.5, 0.4, 0)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('appends two alpha digits only when alpha is below 1', () => {
    expect(oklchToHex(1, 0, 0, 0.5)).toBe('#ffffff80')
    expect(oklchToHex(0, 0, 0, 0)).toBe('#00000000')
    expect(oklchToHex(1, 0, 0, 1)).toBe('#ffffff')
  })
})

describe('color values', () => {
  it('normalizes hex to lower case and drops an opaque alpha', () => {
    expect(colorToHex({ kind: 'hex', hex: '#AABBCCFF' })).toBe('#aabbcc')
    expect(colorToHex({ kind: 'hex', hex: '#AABBCC80' })).toBe('#aabbcc80')
    expect(colorToHex({ kind: 'hex', hex: '#AbCdEf' })).toBe('#abcdef')
    expect(colorToHex({ kind: 'oklch', l: 1, c: 0, h: 0, alpha: 0.5 })).toBe('#ffffff80')
    expect(hexColor('#ABCDEF')).toEqual({ kind: 'hex', hex: '#abcdef' })
  })

  it('accepts well formed colors', () => {
    expect(isColor({ kind: 'hex', hex: '#a1b2c3' })).toBe(true)
    expect(isColor({ kind: 'hex', hex: '#a1b2c3d4' })).toBe(true)
    expect(isColor({ kind: 'oklch', l: 0.5, c: 0.1, h: 200 })).toBe(true)
    expect(isColor({ kind: 'oklch', l: 0.5, c: 0.1, h: 200, alpha: 0.4 })).toBe(true)
  })

  it.each([
    ['hex with an extra key', { kind: 'hex', hex: '#a1b2c3', name: 'x' }],
    ['three digit hex', { kind: 'hex', hex: '#abc' }],
    ['hex without hash', { kind: 'hex', hex: 'a1b2c3' }],
    ['oklch with an extra key', { kind: 'oklch', l: 0.5, c: 0.1, h: 200, space: 'p3' }],
    ['lightness above 1', { kind: 'oklch', l: 1.2, c: 0.1, h: 200 }],
    ['negative lightness', { kind: 'oklch', l: -0.1, c: 0.1, h: 200 }],
    ['non-finite chroma', { kind: 'oklch', l: 0.5, c: Number.NaN, h: 200 }],
    ['infinite hue', { kind: 'oklch', l: 0.5, c: 0.1, h: Number.POSITIVE_INFINITY }],
    ['hue above 360', { kind: 'oklch', l: 0.5, c: 0.1, h: 361 }],
    ['alpha above 1', { kind: 'oklch', l: 0.5, c: 0.1, h: 200, alpha: 2 }],
    ['string channel', { kind: 'oklch', l: '0.5', c: 0.1, h: 200 }],
    ['unknown kind', { kind: 'rgb', r: 1, g: 1, b: 1 }],
    ['array', ['hex', '#a1b2c3']],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isColor(value)).toBe(false)
  })

  it('validates hex strings', () => {
    expect(isHexColor('#00ff00')).toBe(true)
    expect(isHexColor('#00ff0')).toBe(false)
    expect(isHexColor('00ff00')).toBe(false)
  })

  it('emits css for hex and oklch, with alpha only when translucent', () => {
    expect(colorToCss({ kind: 'hex', hex: '#AABBCC' })).toBe('#aabbcc')
    expect(colorToCss({ kind: 'oklch', l: 0.7, c: 0.15, h: 250, alpha: 0.5 })).toBe('oklch(0.7 0.15 250 / 0.5)')
    expect(colorToCss({ kind: 'oklch', l: 0.7, c: 0.15, h: 250 })).toBe('oklch(0.7 0.15 250)')
    expect(colorToCss({ kind: 'oklch', l: 0.7, c: 0.15, h: 250, alpha: 1 })).toBe('oklch(0.7 0.15 250)')
  })

  it('compares colors by their resolved hex', () => {
    expect(sameColor({ kind: 'hex', hex: '#FFFFFF' }, { kind: 'oklch', l: 1, c: 0, h: 0 })).toBe(true)
    expect(sameColor({ kind: 'hex', hex: '#fffffe' }, { kind: 'oklch', l: 1, c: 0, h: 0 })).toBe(false)
  })
})
