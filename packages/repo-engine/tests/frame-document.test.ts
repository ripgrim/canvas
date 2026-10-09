import { describe, expect, it } from 'vitest'
import { applyDocumentCommand, validateDocument } from '../src/document'
import type { Atom } from '../src/types'
const atoms: Atom[] = [{ name: 'Button', kind: 'atom', componentId: 'button', path: 'Button.tsx', exportName: 'Button', fingerprint: 'button', sourceHash: 'button', status: 'bound', candidates: [], props: [{ name: 'children', type: 'string', optional: true }, { name: 'disabled', type: 'boolean', optional: true }] }]
const fixture = () => ({ version: 1 as const, revision: 4, rootIds: ['first', 'second'], nodes: { first: { id: 'first', componentId: 'button', exportName: 'Button', props: { children: 'Save' }, children: {} }, second: { id: 'second', componentId: 'button', exportName: 'Button', props: { children: 'Cancel' }, children: {} } }, frame: { width: 400, height: 500, gap: 16, padding: 24, direction: 'column' as const, clip: false } })
describe('frame metadata and atomic prop batches', () => {
  it('accepts existing nameless documents and preserves explicit frame metadata', () => {
    expect(validateDocument(fixture(), atoms).frame.width).toBe(400)
    const next = applyDocumentCommand(fixture(), { type: 'update-frame', frame: { name: 'Account form', width: 64, height: 8192, gap: 8192, padding: 0 } }, atoms)
    expect(next.frame).toEqual({ name: 'Account form', width: 64, height: 8192, gap: 8192, padding: 0, direction: 'column', clip: false })
    expect(next.revision).toBe(5)
  })
  it.each(['', '   ', ' trailing ', 'x'.repeat(129)])('rejects invalid frame name %j without changing input', name => {
    const input = fixture(); const before = JSON.stringify(input)
    expect(() => applyDocumentCommand(input, { type: 'update-frame', frame: { name } }, atoms)).toThrow('Invalid frame name')
    expect(JSON.stringify(input)).toBe(before)
  })
  it('updates two instances with one revision and leaves original bytes unchanged', () => {
    const input = fixture(); const before = JSON.stringify(input)
    const result = applyDocumentCommand(input, { type: 'update-many-props', updates: [{ nodeId: 'first', props: { disabled: true } }, { nodeId: 'second', props: { children: 'Dismiss', disabled: true } }] }, atoms)
    expect(result.nodes.first!.props).toEqual({ children: 'Save', disabled: true })
    expect(result.nodes.second!.props).toEqual({ children: 'Dismiss', disabled: true })
    expect(result.revision).toBe(5); expect(JSON.stringify(input)).toBe(before)
  })
  it('rejects a partially valid batch atomically and rejects duplicated targets', () => {
    const input = fixture(); const before = JSON.stringify(input)
    expect(() => applyDocumentCommand(input, { type: 'update-many-props', updates: [{ nodeId: 'first', props: { disabled: true } }, { nodeId: 'second', props: { disabled: 'invalid' } }] }, atoms)).toThrow()
    expect(JSON.stringify(input)).toBe(before)
    expect(() => applyDocumentCommand(input, { type: 'update-many-props', updates: [{ nodeId: 'first', props: {} }, { nodeId: 'first', props: {} }] }, atoms)).toThrow('Invalid prop batch')
  })
})


