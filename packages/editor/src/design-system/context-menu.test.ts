import { describe, expect, it } from 'vitest'
import { contextSubmenuPosition } from './context-menu'

describe('context submenu portal placement', () => {
  it('opens beside the trigger when the right side has room', () => {
    expect(contextSubmenuPosition({ left: 100, right: 260, top: 80 }, 1200)).toEqual({ side: 'right', x: 260, y: 80 })
  })

  it('opens to the left when the right edge would clip it', () => {
    expect(contextSubmenuPosition({ left: 900, right: 1060, top: 80 }, 1100)).toEqual({ side: 'left', x: 900, y: 80 })
  })

  it('uses the roomier side when neither side fits the preferred width', () => {
    expect(contextSubmenuPosition({ left: 100, right: 260, top: 80 }, 420)).toEqual({ side: 'right', x: 260, y: 80 })
  })
})
