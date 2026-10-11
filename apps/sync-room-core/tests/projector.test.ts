import { describe, expect, it } from 'vitest'
import { createSemanticProjector } from '../src/projector.js'
import { document } from './support.js'

describe('semantic projector', () => {
  it('applies a closed command without mutating the input projection', () => {
    const source = document()
    const next = createSemanticProjector().apply(source, { type: 'node.rename', nodeId: 'node-1', name: 'Renamed' })
    expect((source.nodes as Record<string, { name?: string }>)['node-1']?.name).toBe('Frame')
    expect((next.nodes as Record<string, { name?: string }>)['node-1']?.name).toBe('Renamed')
    expect(next.revision).toBe(1)
    expect(next).not.toBe(source)
  })

  it('uses repo-engine root, cycle, and token-reference semantics', () => {
    const projector = createSemanticProjector()
    expect(() => projector.apply(document(), { type: 'node.rename', nodeId: 'root-1', name: 'No' })).toThrow('Invalid node name')
    expect(() => projector.apply(document(), { type: 'node.reparent', nodeId: 'node-1', placement: { parentId: 'node-1' } })).toThrow('own subtree')
    const withTokens = document({ theme: { tokens: {
      base: { id: 'base', type: 'color', name: 'Base', orderKey: 'A', value: { kind: 'literal', color: { kind: 'hex', hex: '#000000' } } },
      alias: { id: 'alias', type: 'color', name: 'Alias', orderKey: 'B', value: { kind: 'alias', tokenId: 'base' } },
    } } })
    const next = projector.apply(withTokens, { type: 'token.delete', tokenIds: ['base'] })
    expect((next.theme as { tokens: Record<string, { value: unknown }> }).tokens.alias?.value).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#000000' } })
    expect(next.revision).toBe(1)
  })

  it('applies a semantic batch atomically and increments revision exactly once', () => {
    const literal = { kind: 'literal', color: { kind: 'hex', hex: '#112233' } } as const
    const next = createSemanticProjector().apply(document(), { type: 'batch', commands: [
      { type: 'page.setBackground', pageId: 'page-1', background: literal },
      { type: 'node.setStyles', nodeId: 'node-1', styles: { width: 240, height: 220 } },
      { type: 'node.fill.add', nodeId: 'node-1', paint: { id: 'fill-1', type: 'solid', color: literal } },
      { type: 'node.border.update', nodeId: 'node-1', side: 'all', stroke: { color: literal, width: 15, style: 'solid' } },
    ] })
    expect(next.revision).toBe(1)
    expect(next.pages).toEqual([{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1', background: literal }])
    expect((next.nodes as Record<string, { styles: { width: number; height: number }; appearance: unknown }>)['node-1']).toMatchObject({
      styles: { width: 240, height: 220 },
      appearance: { fills: [{ id: 'fill-1' }], borders: { all: { width: 15 } } },
    })
  })

  it('rejects non-canonical source documents instead of preserving arbitrary fields', () => {
    expect(() => createSemanticProjector().apply(document({ document: { replacement: true } }), { type: 'node.rename', nodeId: 'node-1', name: 'Renamed' })).toThrow('Unsupported design file field')
  })

  it('[COMPONENT-BINDING-SAVE-001] accepts the hosted catalog but does not derive component authority from a submitted command', () => {
    const projector = createSemanticProjector()
    const inserted = projector.apply(document(), {
      type: 'node.insert',
      node: { id: 'button', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Save', variant: 'primary' } },
      placement: { parentId: 'root-1' },
    })
    expect((inserted.nodes as Record<string, unknown>).button).toMatchObject({ componentId: 'sample-button', exportName: 'Button' })

    expect(() => projector.apply(document(), {
      type: 'node.insert',
      node: { id: 'component-1', type: 'component', componentId: 'new-component', exportName: 'NewComponent', props: {} },
      placement: { parentId: 'root-1' },
    })).toThrow('Component binding needs review')

    const withComponent = document({
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        'node-1': { id: 'node-1', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 100, height: 100 } },
        'button-1': { id: 'button-1', type: 'component', componentId: 'button-component', exportName: 'Button', props: { label: 'Save' } },
      },
      relationships: {
        'node-1': { parentId: 'root-1', orderKey: 'V' },
        'button-1': { parentId: 'root-1', orderKey: 'W' },
      },
    })
    expect(() => projector.apply(withComponent, { type: 'node.setProps', nodeId: 'button-1', props: { tone: 'danger' } })).toThrow('Unsupported value for Button.tone')
    expect(() => projector.apply(withComponent, {
      type: 'node.insert',
      node: { id: 'component-2', type: 'component', componentId: 'button-component', exportName: 'ForgedButton', props: { label: 'Copy' } },
      placement: { parentId: 'root-1' },
    })).toThrow('Component binding needs review')
  })
})
