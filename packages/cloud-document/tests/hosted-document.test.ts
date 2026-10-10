import { describe, expect, it } from 'vitest'
import { validateHostedFileDocument } from '../src/index.js'

const blank = () => ({
  schemaVersion: 6,
  fileId: 'file-1',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
})

describe('hosted document validation', () => {
  it('accepts a canonical blank document', () => {
    expect(validateHostedFileDocument(blank())).toEqual(blank())
  })

  it('checks the complete primitive graph instead of only the envelope', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).box = { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 0, top: 0, width: -1, height: 10 } }
    ;(input.relationships as Record<string, unknown>).box = { parentId: 'root-1', orderKey: 'a0' }
    expect(() => validateHostedFileDocument(input)).toThrow('Invalid node geometry')
  })

  it('allows unavailable hosted component bindings but rejects unsafe props', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).button = { id: 'button', type: 'component', componentId: 'button-component', exportName: 'Button', props: { children: 'Save' } }
    ;(input.relationships as Record<string, unknown>).button = { parentId: 'root-1', orderKey: 'V' }
    expect(validateHostedFileDocument(input).nodes.button).toMatchObject({ componentId: 'button-component', props: { children: 'Save' } })
    ;((input.nodes as Record<string, Record<string, unknown>>).button!.props as Record<string, unknown>).onClick = 'alert(1)'
    expect(() => validateHostedFileDocument(input)).toThrow('Unsupported prop onClick')
  })

  it('validates hosted Card slot relationships without claiming a source binding', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).card = { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {} }
    ;(input.nodes as Record<string, unknown>).button = { id: 'button', type: 'component', componentId: 'button-component', exportName: 'Button', props: { children: 'Save' } }
    ;(input.relationships as Record<string, unknown>).card = { parentId: 'root-1', orderKey: 'V' }
    ;(input.relationships as Record<string, unknown>).button = { parentId: 'card', orderKey: 'V', slot: 'footer' }
    expect(validateHostedFileDocument(input).relationships.button).toEqual({ parentId: 'card', orderKey: 'V', slot: 'footer' })
  })

  it('rejects one component identity bound to different exports', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).one = { id: 'one', type: 'component', componentId: 'shared', exportName: 'Button', props: {} }
    ;(input.nodes as Record<string, unknown>).two = { id: 'two', type: 'component', componentId: 'shared', exportName: 'Input', props: {} }
    ;(input.relationships as Record<string, unknown>).one = { parentId: 'root-1', orderKey: 'a0' }
    ;(input.relationships as Record<string, unknown>).two = { parentId: 'root-1', orderKey: 'a1' }
    expect(() => validateHostedFileDocument(input)).toThrow('Component identity is inconsistent')
  })
})
