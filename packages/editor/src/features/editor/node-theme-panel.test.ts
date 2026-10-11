import { describe, expect, it } from 'vitest'
import { themeAvailabilityNote } from './NodeThemePanel'

describe('THEME-CLARITY-001 theme availability copy', () => {
  it('summarizes a file with no mode variants once', () => {
    expect(themeAvailabilityNote({ light: 'missing', dark: 'missing' })).toBe('No light or dark themes')
  })

  it('names the one unavailable variant', () => {
    expect(themeAvailabilityNote({ dark: 'missing' })).toBe('No dark theme')
  })

  it('distinguishes missing themes from ambiguous primary mappings', () => {
    expect(themeAvailabilityNote({ light: 'missing', dark: 'ambiguous' })).toBe('No light theme. Choose a primary dark theme')
    expect(themeAvailabilityNote({ light: 'ambiguous', dark: 'ambiguous' })).toBe('Choose primary light and dark themes')
  })

  it('adds no message when both variants are available', () => {
    expect(themeAvailabilityNote({})).toBeUndefined()
  })
})
