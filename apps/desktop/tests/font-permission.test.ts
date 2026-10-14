import { describe, expect, it } from 'vitest'
import { canAccessLocalFonts } from '../src/main/font-permission'

describe('FONT-LOCAL-001 desktop permission', () => {
  const editorUrl = 'design-editor://app/index.html'

  it('allows local fonts only in the trusted main frame', () => {
    expect(canAccessLocalFonts('local-fonts', { isMainFrame: true, requestingUrl: 'design-editor://app/file/one' }, editorUrl)).toBe(true)
    expect(canAccessLocalFonts('local-fonts', { isMainFrame: false, requestingUrl: 'design-editor://app/file/one' }, editorUrl)).toBe(false)
    expect(canAccessLocalFonts('local-fonts', { isMainFrame: true, requestingUrl: 'https://canvas.ripgrim.com/file/one' }, editorUrl)).toBe(false)
  })

  it('denies every unrelated or malformed request', () => {
    expect(canAccessLocalFonts('notifications', { isMainFrame: true, requestingUrl: 'design-editor://app/file/one' }, editorUrl)).toBe(false)
    expect(canAccessLocalFonts('local-fonts', { isMainFrame: true, requestingUrl: 'invalid' }, editorUrl)).toBe(false)
    expect(canAccessLocalFonts('local-fonts', { isMainFrame: true }, editorUrl)).toBe(false)
  })
})
