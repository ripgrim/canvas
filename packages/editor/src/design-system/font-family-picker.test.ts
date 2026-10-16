import { describe, expect, it, vi } from 'vitest'
import { fontFamilyLabel, fontPickerEntries, fontPickerPortalContainer, fontSearchScore, mergeFontOptions, systemFontOptions } from './font-family-picker'

describe('PAPER-TEXT-006 font family catalog', () => {
  it('finds direct and fuzzy family matches while rejecting unrelated input', () => {
    expect(fontSearchScore('Times New Roman', 'new roman')).toBe(6)
    expect(fontSearchScore('Trebuchet MS', 'tbms')).toBeLessThan(Number.POSITIVE_INFINITY)
    expect(fontSearchScore('Georgia', 'mono')).toBe(Number.POSITIVE_INFINITY)
  })

  it('deduplicates families and preserves discovered styles', () => {
    expect(mergeFontOptions(
      [{ family: 'Inter', label: 'Inter', source: 'document' }],
      [{ family: 'inter', label: 'Inter', source: 'local', styles: [{ style: 'italic', weight: 500 }] }],
    )).toEqual([{ family: 'inter', label: 'Inter', source: 'local', styles: [{ style: 'italic', weight: 500 }] }])
    expect(fontFamilyLabel('"Courier New", monospace')).toBe('Courier New')
    expect(systemFontOptions.map(option => option.label)).toContain('System Sans-Serif')
  })

  it('keeps missing favorites visible and separates token labels from values', () => {
    expect(fontPickerEntries('favorites', [], [], ['Missing Sans'], '')[0]?.family).toMatchObject({ family: 'Missing Sans', source: 'document' })
    expect(fontPickerEntries('tokens', [], [{ id: 'font-brand', name: 'Brand', family: 'Inter' }], [], '')[0]).toMatchObject({ token: { name: 'Brand' }, family: { family: 'Inter', label: 'Brand' } })
  })

  it('keeps the picker inside the active mobile dialog', () => {
    const sheet = {} as HTMLElement
    const editor = {} as HTMLElement
    const closest = vi.fn((selector: string) => selector === '.mobile-sheet-popup' ? sheet : editor)
    const trigger = { closest } as unknown as HTMLElement

    expect(fontPickerPortalContainer(trigger)).toBe(sheet)
    expect(closest).toHaveBeenCalledTimes(1)
  })
})
