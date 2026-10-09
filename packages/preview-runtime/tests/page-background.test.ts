import { describe, expect, it } from 'vitest'
import { applyPageBackground } from '../src/page-background.mjs'

describe('page preview background', () => {
  it('applies the projected page color to the viewport and clears it when absent', () => {
    const ownerDocument = { documentElement: { style: { background: '' } }, body: { style: { background: '' } } }
    applyPageBackground(ownerDocument, '#123456')
    expect(ownerDocument.documentElement.style.background).toBe('#123456')
    expect(ownerDocument.body.style.background).toBe('#123456')
    applyPageBackground(ownerDocument, undefined)
    expect(ownerDocument.documentElement.style.background).toBe('transparent')
    expect(ownerDocument.body.style.background).toBe('transparent')
  })
})
