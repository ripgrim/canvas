import { describe, expect, it } from 'vitest'
import { applyDocumentCommand, validateDocument } from '../src/document.js'
import type { EditorDocument } from '../src/document.js'
import type { Atom } from '../src/index.js'

const atoms: Atom[] = [{ name: 'Button', kind: 'atom', componentId: 'button', path: 'src/Button.tsx', exportName: 'Button', fingerprint: 'b', sourceHash: 'b', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] }]
const fixture = (): EditorDocument => ({ version: 1, revision: 0, rootIds: ['save'], nodes: { save: { id: 'save', componentId: 'button', exportName: 'Button', props: { children: 'Save' }, children: {} } }, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false }, canvas: { elements: [
  { id: 'frame', kind: 'frame', name: 'Frame', x: -213, y: -276, width: 438, height: 560, rotation: 0, fill: 'surface' },
  { id: 'rect', kind: 'rectangle', name: 'Rectangle', x: 10, y: 10, width: 100, height: 40, rotation: 0, fill: 'accent', parentId: 'frame' },
] } })

describe('page model: tokens, names, clipping', () => {
  it('accepts token references, literal overrides, document tokens and frame clipping, and rejects malformed ones', () => {
    const doc = fixture()
    expect(validateDocument(doc, atoms)).toEqual(doc)
    const withTokens = applyDocumentCommand(doc, { type: 'update-token', name: 'accent', value: '#7c3aed' }, atoms)
    expect(withTokens.tokens).toEqual({ accent: '#7c3aed' })
    const literal = applyDocumentCommand(withTokens, { type: 'update-canvas-element', elementId: 'rect', patch: { fill: '#F1F5F9' } }, atoms)
    expect(literal.canvas!.elements[1]!.fill).toBe('#F1F5F9')
    const unclipped = applyDocumentCommand(literal, { type: 'update-canvas-element', elementId: 'frame', patch: { clip: false } }, atoms)
    expect(unclipped.canvas!.elements[0]!.clip).toBe(false)
    expect(validateDocument(JSON.parse(JSON.stringify(unclipped)), atoms)).toEqual(unclipped)
    expect(() => applyDocumentCommand(doc, { type: 'update-canvas-element', elementId: 'rect', patch: { fill: 'Red' } }, atoms)).toThrow('Invalid canvas element update')
    expect(() => applyDocumentCommand(doc, { type: 'update-canvas-element', elementId: 'rect', patch: { clip: true } }, atoms)).toThrow('Invalid canvas element update')
    expect(() => applyDocumentCommand(doc, { type: 'update-token', name: 'Accent', value: '#7c3aed' }, atoms)).toThrow('Invalid document token')
    expect(() => applyDocumentCommand(doc, { type: 'update-token', name: 'accent', value: 'oklch(59% 0.2 315)' }, atoms)).toThrow('Invalid document token')
    expect(() => validateDocument({ ...doc, tokens: { accent: 'purple' } }, atoms)).toThrow('Invalid document tokens')
  })

  it('removes token overrides without touching the fills that referenced them', () => {
    const doc = applyDocumentCommand(fixture(), { type: 'update-token', name: 'accent', value: '#7c3aed' }, atoms)
    const removed = applyDocumentCommand(doc, { type: 'remove-token', name: 'accent' }, atoms)
    expect(removed.tokens).toBeUndefined()
    expect(removed.canvas!.elements[1]!.fill).toBe('accent')
    expect(() => applyDocumentCommand(removed, { type: 'remove-token', name: 'accent' }, atoms)).toThrow('existing document token')
  })

  it('renames component nodes as mutable display metadata while identity, props and bindings stay unchanged', () => {
    const renamed = applyDocumentCommand(fixture(), { type: 'rename-node', nodeId: 'save', name: 'Primary action' }, atoms)
    expect(renamed.nodes.save).toMatchObject({ id: 'save', componentId: 'button', exportName: 'Button', name: 'Primary action', props: { children: 'Save' } })
    expect(validateDocument(JSON.parse(JSON.stringify(renamed)), atoms)).toEqual(renamed)
    expect(() => applyDocumentCommand(fixture(), { type: 'rename-node', nodeId: 'save', name: '  ' }, atoms)).toThrow('Invalid component name')
    expect(() => validateDocument({ ...fixture(), nodes: { save: { ...fixture().nodes.save!, name: 'x'.repeat(129) } } }, atoms)).toThrow('Invalid component name')
  })
})
