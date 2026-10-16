import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../src/file-document.js'
import { isFileDocumentShape, upgradeFileDocument } from '../src/file-migration.js'

const version8 = () => ({
  schemaVersion: 8,
  fileId: 'file-1',
  revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 10, top: 20, width: 300, height: 200 }, themeMode: 'inherit' },
  },
  relationships: { frame: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})

describe('PAPER-FLEX-001: schema v8 to current migration', () => {
  it('changes only schemaVersion and does not materialize layout', () => {
    const input = version8()
    const before = JSON.stringify(input)
    const upgraded = upgradeFileDocument(input)
    expect(upgraded).toStrictEqual({ ...input, schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, nodes: { ...input.nodes, frame: { ...input.nodes.frame, styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 300, height: 200 } } } })
    expect(JSON.stringify(input)).toBe(before)
    expect((upgraded as typeof input).nodes.frame).not.toHaveProperty('layout')
    expect(input.schemaVersion).toBe(8)
    expect(validateFileDocument(upgraded, [])).toStrictEqual(upgraded)
    expect(isFileDocumentShape(input)).toBe(true)
    expect(isFileDocumentShape(upgraded)).toBe(true)
  })

  it('does not bless a v8 primitive or root layout that the v8 schema never admitted', () => {
    for (const nodeId of ['root-1', 'frame'] as const) {
      const input = version8()
      const nodes = input.nodes as unknown as Record<string, Record<string, unknown>>
      nodes[nodeId]!.layout = { item: { position: { mode: 'freeform' } } }
      const before = structuredClone(input)
      const upgraded = upgradeFileDocument(input)
      expect(upgraded).toStrictEqual(before)
      expect((upgraded as typeof input).schemaVersion).toBe(8)
      expect(() => validateFileDocument(upgraded, [])).toThrow('Unsupported design file version')
    }
  })

  it('keeps malformed v8 layout bytes untouched as a negative mutation control', () => {
    const input = version8()
    const nodes = input.nodes as unknown as Record<string, Record<string, unknown>>
    nodes.frame!.layout = { item: { position: { mode: 'flow' }, transform: { rotate: 10 } } }
    const before = JSON.stringify(input)
    expect(JSON.stringify(upgradeFileDocument(input))).toBe(before)
  })
})
