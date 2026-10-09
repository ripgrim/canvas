import { describe, expect, it } from 'vitest'
import { parseGridTemplate, trackToCss, tracksToCss, validateGridTrack } from '../src/grid-tracks.js'
import type { GridTrack } from '../src/grid-tracks.js'

const rejection = (input: string): string | null => { const result = parseGridTemplate(input); return result.ok ? null : result.error }

describe('grid track parsing', () => {
  it('LAY-GRID-001: parses every supported track kind and expands repeat()', () => {
    // 5 single tracks plus repeat(2, 1fr 2fr) expanding to 4 tracks: 9 tracks in total.
    const expected: GridTrack[] = [
      { kind: 'fr', value: 1 },
      { kind: 'px', value: 200 },
      { kind: 'percent', value: 10 },
      { kind: 'auto' },
      { kind: 'minmax', min: { kind: 'px', value: 100 }, max: { kind: 'fr', value: 1 } },
      { kind: 'fr', value: 1 },
      { kind: 'fr', value: 2 },
      { kind: 'fr', value: 1 },
      { kind: 'fr', value: 2 },
    ]
    const result = parseGridTemplate('1fr 200px 10% auto minmax(100px, 1fr) repeat(2, 1fr 2fr)')
    expect(result).toEqual({ ok: true, tracks: expected })
  })

  it('LAY-GRID-001: tracksToCss reproduces the normalized (repeat-expanded) text', () => {
    const result = parseGridTemplate('1fr 200px 10% auto minmax(100px, 1fr) repeat(2, 1fr 2fr)')
    if (!result.ok) throw new Error(result.error)
    expect(tracksToCss(result.tracks)).toBe('1fr 200px 10% auto minmax(100px, 1fr) 1fr 2fr 1fr 2fr')
  })

  it('LAY-GRID-001: an fr track on a fixed axis keeps a 32px hit area; other kinds are unchanged', () => {
    expect(trackToCss({ kind: 'fr', value: 1 }, { fixedAxis: true })).toBe('minmax(32px, 1fr)')
    expect(trackToCss({ kind: 'fr', value: 1 })).toBe('1fr')
    expect(tracksToCss([{ kind: 'px', value: 40 }, { kind: 'fr', value: 2 }], { fixedAxis: true })).toBe('40px minmax(32px, 2fr)')
  })

  it('LAY-GRID-008: rejects unsupported syntax with a specific message', () => {
    expect(rejection('[a] 1fr')).toBe('Named grid lines are not supported')
    expect(rejection('repeat(auto-fill, 1fr)')).toBe('auto-fill and auto-fit are not supported')
    expect(rejection('repeat(0, 1fr)')).toBe('repeat() count must be between 1 and 100')
    expect(rejection('repeat(101, 1fr)')).toBe('repeat() count must be between 1 and 100')
    expect(rejection('repeat(3, repeat(2, 1fr))')).toBe('Nested repeat() is not supported')
    expect(rejection('subgrid')).toBe('subgrid is not supported')
    expect(rejection('fit-content(200px)')).toBe('fit-content() tracks are not supported')
    expect(rejection('-1fr')).toBe('Negative track sizes are not allowed')
    expect(rejection('minmax(1fr, 2fr)')).toBe('fr is not allowed as a minmax() minimum')
  })

  it('LAY-GRID-008: repeat() count boundaries 1 and 100 are accepted', () => {
    expect(parseGridTemplate('repeat(1, 1fr)')).toEqual({ ok: true, tracks: [{ kind: 'fr', value: 1 }] })
    const hundred = parseGridTemplate('repeat(100, 1fr)')
    expect(hundred.ok && hundred.tracks.length).toBe(100)
  })

  it('LAY-GRID-008: rejects input longer than 5000 characters and accepts exactly 5000', () => {
    const atLimit = '1fr' + ' '.repeat(4997)
    const overLimit = '1fr' + ' '.repeat(4998)
    expect(atLimit.length).toBe(5000)
    expect(overLimit.length).toBe(5001)
    expect(parseGridTemplate(atLimit)).toEqual({ ok: true, tracks: [{ kind: 'fr', value: 1 }] })
    expect(rejection(overLimit)).toBe('Track template is longer than 5000 characters')
  })

  it('LAY-GRID-008: rejects a single 65-character token and accepts a 64-character one', () => {
    const token64 = 'minmax(100px,' + ' '.repeat(47) + '1fr)'
    const token65 = 'minmax(100px,' + ' '.repeat(48) + '1fr)'
    expect(token64.length).toBe(64)
    expect(token65.length).toBe(65)
    expect(parseGridTemplate(token64)).toEqual({ ok: true, tracks: [{ kind: 'minmax', min: { kind: 'px', value: 100 }, max: { kind: 'fr', value: 1 } }] })
    expect(rejection(token65)).toMatch(/is longer than 64 characters$/)
  })

  it('LAY-GRID-008: rejects a template that expands past 200 tracks and accepts exactly 200', () => {
    expect(rejection('repeat(100, 1fr 1fr 1fr)')).toBe('Track template expands to more than 200 tracks')
    const twoHundred = parseGridTemplate('repeat(100, 1fr 1fr)')
    expect(twoHundred.ok && twoHundred.tracks.length).toBe(200)
  })
})

describe('grid track validation', () => {
  it('LAY-GRID-001: accepts each well-formed track kind', () => {
    expect(validateGridTrack({ kind: 'px', value: 0 })).toBe(true)
    expect(validateGridTrack({ kind: 'percent', value: 50 })).toBe(true)
    expect(validateGridTrack({ kind: 'fr', value: 1.5 })).toBe(true)
    expect(validateGridTrack({ kind: 'auto' })).toBe(true)
    expect(validateGridTrack({ kind: 'minmax', min: { kind: 'auto' }, max: { kind: 'fr', value: 1 } })).toBe(true)
  })

  it('LAY-GRID-008: rejects non-finite, negative, extra-key, nested minmax, fr minimum, and non-object tracks', () => {
    expect(validateGridTrack({ kind: 'px', value: Number.NaN })).toBe(false)
    expect(validateGridTrack({ kind: 'px', value: Number.POSITIVE_INFINITY })).toBe(false)
    expect(validateGridTrack({ kind: 'fr', value: -1 })).toBe(false)
    expect(validateGridTrack({ kind: 'px', value: 10, extra: true })).toBe(false)
    expect(validateGridTrack({ kind: 'auto', value: 1 })).toBe(false)
    expect(validateGridTrack({ kind: 'minmax', min: { kind: 'minmax', min: { kind: 'auto' }, max: { kind: 'auto' } }, max: { kind: 'auto' } })).toBe(false)
    expect(validateGridTrack({ kind: 'minmax', min: { kind: 'auto' }, max: { kind: 'minmax', min: { kind: 'auto' }, max: { kind: 'auto' } } })).toBe(false)
    expect(validateGridTrack({ kind: 'minmax', min: { kind: 'fr', value: 1 }, max: { kind: 'auto' } })).toBe(false)
    expect(validateGridTrack(null)).toBe(false)
    expect(validateGridTrack('1fr')).toBe(false)
    expect(validateGridTrack([{ kind: 'auto' }])).toBe(false)
    expect(validateGridTrack({ kind: 'em', value: 1 })).toBe(false)
  })
})
