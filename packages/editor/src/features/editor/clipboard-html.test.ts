// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { clipboardHtmlToText } from './clipboard-html'

describe('PAPER-CLIP-005 supported HTML insertion', () => {
  it('preserves block, break, and list structure without inventing rich text runs', () => {
    expect(clipboardHtmlToText('<h2>Release</h2><p>Hello <strong>team</strong><br>Today</p><ul><li>First</li><li>Second</li></ul><ol><li>Third</li></ol>'))
      .toBe('Release\nHello team\nToday\n• First\n• Second\n1. Third')
  })

  it('normalizes surrounding whitespace and empty blocks', () => {
    expect(clipboardHtmlToText('<div>  One  </div><div><span>Two</span></div><p></p>')).toBe('One\nTwo')
  })
})
