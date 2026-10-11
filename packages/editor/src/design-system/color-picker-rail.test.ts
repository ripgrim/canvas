import { describe, expect, it } from 'vitest'
import { colorRailPosition, colorRailValue } from './color-picker-rail'

describe('AT-COLOR-001 color rail geometry', () => {
  it('places the HSV hue thumb over the matching top-to-bottom spectrum color', () => {
    expect(colorRailPosition(0, 360, 'forward')).toBe(0)
    expect(colorRailPosition(120, 360, 'forward')).toBeCloseTo(100 / 3)
    expect(colorRailPosition(240, 360, 'forward')).toBeCloseTo(200 / 3)
    expect(colorRailPosition(360, 360, 'forward')).toBe(100)
  })

  it('keeps full opacity at the top and transparent at the bottom', () => {
    expect(colorRailPosition(100, 100, 'reverse')).toBe(0)
    expect(colorRailPosition(50, 100, 'reverse')).toBe(50)
    expect(colorRailPosition(0, 100, 'reverse')).toBe(100)
  })

  it('maps pointer positions to the same values and clamps outside the rail', () => {
    expect(colorRailValue(20, 20, 300, 360, 'forward')).toBe(0)
    expect(colorRailValue(120, 20, 300, 360, 'forward')).toBe(120)
    expect(colorRailValue(320, 20, 300, 360, 'forward')).toBe(360)
    expect(colorRailValue(-20, 20, 300, 100, 'reverse')).toBe(100)
    expect(colorRailValue(500, 20, 300, 100, 'reverse')).toBe(0)
  })
})
