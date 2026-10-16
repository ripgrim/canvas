import { describe, expect, it } from 'vitest'
import { canvasHudVisible, canvasPlaceholderVisible } from './CanvasWorkspace'

describe('canvas workspace startup', () => {
  it('does not cover a valid preview while its handshake starts', () => {
    expect(canvasPlaceholderVisible('http://127.0.0.1:4318/?file=file')).toBe(false)
  })

  it('shows the unavailable surface only without a preview URL', () => {
    expect(canvasPlaceholderVisible(undefined)).toBe(true)
  })

  it('keeps the HUD mounted while an existing preview reconnects', () => {
    expect(canvasHudVisible('http://127.0.0.1:4318/?file=file')).toBe(true)
    expect(canvasHudVisible(undefined)).toBe(false)
  })
})
