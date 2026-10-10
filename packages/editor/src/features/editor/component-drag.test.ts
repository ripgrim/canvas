import { describe, expect, it, vi } from 'vitest'
import { componentDragMime, encodeComponentDrag, hasComponentDrag, readComponentDrag } from './component-drag'

const transfer = (types: string[], value = '') => ({ types, getData: vi.fn((type: string) => type === componentDragMime ? value : '') })

describe('component canvas drag payload', () => {
  it('round trips a verified component identity and slot target', () => {
    const value = encodeComponentDrag({ componentId: 'atom-card', target: { parentId: 'login-card', slot: 'footer', index: 1 } })
    const data = transfer([componentDragMime], value)
    expect(readComponentDrag(data)).toEqual({ componentId: 'atom-card', target: { parentId: 'login-card', slot: 'footer', index: 1 } })
    expect(data.getData).toHaveBeenCalledWith(componentDragMime)
  })

  it('leaves unrelated drops untouched without reading their data', () => {
    const data = transfer(['text/plain'], 'atom-card')
    expect(hasComponentDrag(data)).toBe(false)
    expect(readComponentDrag(data)).toBeNull()
    expect(data.getData).not.toHaveBeenCalled()
  })

  it('rejects malformed, extra, and unbounded input', () => {
    expect(readComponentDrag(transfer([componentDragMime], '{'))).toBeNull()
    expect(readComponentDrag(transfer([componentDragMime], JSON.stringify({ componentId: 'atom-card', target: { parentId: null }, extra: true })))).toBeNull()
    expect(readComponentDrag(transfer([componentDragMime], JSON.stringify({ componentId: '../card', target: { parentId: null } })))).toBeNull()
    expect(readComponentDrag(transfer([componentDragMime], 'x'.repeat(513)))).toBeNull()
  })
})
