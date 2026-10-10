import { describe, expect, it } from 'vitest'
import { applyFileEdits } from '../src/index.js'

describe('generic JSON file edits', () => {
  it('applies set, delete, and splice without mutating the input', () => {
    const input = { nodes: { card: { name: 'Card', optional: true } }, pages: [{ id: 'page-1' }] }
    const result = applyFileEdits(input, [
      { type: 'set', path: ['nodes', 'card', 'name'], value: 'Panel' },
      { type: 'delete', path: ['nodes', 'card', 'optional'] },
      { type: 'splice', path: ['pages'], index: 1, deleteCount: 0, values: [{ id: 'page-2' }] },
    ])
    expect(result).toEqual({ nodes: { card: { name: 'Panel' } }, pages: [{ id: 'page-1' }, { id: 'page-2' }] })
    expect(input).toEqual({ nodes: { card: { name: 'Card', optional: true } }, pages: [{ id: 'page-1' }] })
  })

  it('rejects missing paths, unsafe keys, and invalid array ranges', () => {
    expect(() => applyFileEdits({ nodes: {} }, [{ type: 'set', path: ['missing', 'value'], value: true }])).toThrow('does not exist')
    expect(() => applyFileEdits({ nodes: {} }, [{ type: 'set', path: ['__proto__'], value: true }])).toThrow('Unsafe edit path')
    expect(() => applyFileEdits({ pages: [] }, [{ type: 'splice', path: ['pages'], index: 1, deleteCount: 0, values: [] }])).toThrow('Invalid splice range')
  })
})
