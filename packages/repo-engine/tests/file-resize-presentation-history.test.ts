import { describe, expect, it, vi } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, validateFileCommand, validateFileDocument } from '../src/file-document.js'
import type { FileCommand, FileDocument, NodeResizePresentationEntry, NodeResizeState } from '../src/file-document.js'
import type { Atom } from '../src/types.js'
import { matrixFromLegacyPose } from '../src/layout-pose.js'

const hostAtom: Atom = {
  componentId: 'host-component', path: 'Host.tsx', exportName: 'Host', fingerprint: 'host-fingerprint', sourceHash: 'host-hash',
  status: 'bound', candidates: [], name: 'Host', kind: 'atom', props: [{ name: 'content', type: 'ReactNode', optional: true }], slots: ['content'],
}
const cardAtom: Atom = {
  componentId: 'card-component', path: 'Card.tsx', exportName: 'Card', fingerprint: 'card-fingerprint', sourceHash: 'card-hash',
  status: 'bound', candidates: [], name: 'Card', kind: 'atom', props: [{ name: 'label', type: 'string', optional: false }],
}
const atoms = [hostAtom, cardAtom]
const black = { kind: 'literal', color: { kind: 'hex', hex: '#111111' } } as const
const blue = { kind: 'literal', color: { kind: 'hex', hex: '#3366ff' } } as const
const frameLayout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' }, gap: 8 }, spacing: { padding: 12 } } as const
const textLayout = { item: { position: { mode: 'flow' }, flex: { grow: 1 } } } as const
const componentLayout = { item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 50 } } } } as const
const textStyle = {
  fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0,
  horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false,
} as const
const textSizing = { width: { mode: 'fixed' }, height: { mode: 'fixed' } } as const

const fixture = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'resize-presentation-history',
  revision: 41,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    frame: {
      id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: matrixFromLegacyPose({ left: -20, top: 15, rotation: 12 }, { width: 320, height: 180 }), width: 320, height: 180, overflow: 'visible' },
      layout: frameLayout,
      appearance: { opacity: 0.8, fills: [{ id: 'frame-fill', type: 'solid', color: black }] },
    },
    text: {
      id: 'text', type: 'text', name: 'Text', styles: { relativeTransform: matrixFromLegacyPose({ left: 5, top: 7, rotation: -4 }, { width: 120, height: 30 }), width: 120, height: 30 }, text: 'Hello',
      textStyle, textSizing, layout: textLayout, appearance: { opacity: 0.7 },
    },
    rectangle: {
      id: 'rectangle', type: 'rectangle', name: 'Rectangle', styles: { relativeTransform: matrixFromLegacyPose({ left: 140, top: 7, flipX: true }, { width: 70, height: 50 }), width: 70, height: 50 },
      layout: { item: { position: { mode: 'flow' } } }, appearance: { fills: [{ id: 'rectangle-fill', type: 'solid', color: blue }] },
    },
    host: { id: 'host', type: 'component', componentId: 'host-component', exportName: 'Host', props: {} },
    card: {
      id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', name: 'Card instance', props: { label: 'Keep me' },
      layout: componentLayout, appearance: { opacity: 0.6 },
    },
  },
  relationships: {
    frame: { parentId: 'root', orderKey: 'A7' },
    text: { parentId: 'frame', orderKey: 'mQ' },
    rectangle: { parentId: 'frame', orderKey: 'z9' },
    host: { parentId: 'root', orderKey: 'r4' },
    card: { parentId: 'host', slot: 'content', orderKey: 'Q2' },
  },
  theme: { tokens: {} },
})

const frameExpected: NodeResizeState = {
  nodeId: 'frame', relationship: { parentId: 'root', orderKey: 'A7' },
  primitiveGeometry: { relativeTransform: matrixFromLegacyPose({ left: -20, top: 15, rotation: 12 }, { width: 320, height: 180 }), width: 320, height: 180 }, layout: frameLayout,
  appearance: { opacity: 0.8, fills: [{ id: 'frame-fill', type: 'solid', color: black }] },
}
const frameSource: NodeResizeState = {
  nodeId: 'frame', relationship: { parentId: 'root', orderKey: 'A7' },
  primitiveGeometry: { relativeTransform: matrixFromLegacyPose({ left: -52.5, top: 4.25, rotation: 12 }, { width: 412.75, height: 240.5 }), width: 412.75, height: 240.5 },
  layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'center', align: 'stretch' }, gap: 11 }, spacing: { padding: 18 } },
  appearance: { opacity: 0.55, fills: [{ id: 'frame-fill', type: 'solid', color: blue }] },
}
const textExpected: NodeResizeState = {
  nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' },
  primitiveGeometry: { relativeTransform: matrixFromLegacyPose({ left: 5, top: 7, rotation: -4 }, { width: 120, height: 30 }), width: 120, height: 30 }, layout: textLayout,
  textProperties: { textStyle, textSizing }, appearance: { opacity: 0.7 },
}
const textSource: NodeResizeState = {
  nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' },
  primitiveGeometry: { relativeTransform: matrixFromLegacyPose({ left: -3, top: 9, rotation: -4 }, { width: 188.5, height: 44 }), width: 188.5, height: 44 }, layout: { item: { position: { mode: 'flow' }, flex: { grow: 0, shrink: 1 } } },
  textProperties: {
    textStyle: { ...textStyle, fontSize: 22, lineHeight: { kind: 'px', value: 28 }, maxLines: 2 },
    textSizing: { width: { mode: 'fill' }, height: { mode: 'fit' } },
  },
  appearance: { opacity: 0.45 },
}
const componentExpected: NodeResizeState = {
  nodeId: 'card', relationship: { parentId: 'host', slot: 'content', orderKey: 'Q2' }, layout: componentLayout, appearance: { opacity: 0.6 },
}
const componentSource: NodeResizeState = {
  nodeId: 'card', relationship: { parentId: 'host', slot: 'content', orderKey: 'Q2' },
  layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 65 } } }, spacing: { margin: { x: 6, y: 3 } } }, appearance: { opacity: 0.35 },
}
const command = (): FileCommand => ({
  type: 'node.resizePresentation',
  entries: [
    { expected: structuredClone(frameExpected), source: structuredClone(frameSource) },
    { expected: structuredClone(textExpected), source: structuredClone(textSource) },
    { expected: structuredClone(componentExpected), source: structuredClone(componentSource) },
  ],
})

const withoutRevision = (file: FileDocument): FileDocument => ({ ...structuredClone(file), revision: 0 })

describe('AT-DOC-003 and PAPER-FLEX-006: node.resizePresentation exact checked history prerequisites', () => {
  it('AT-DOC-003 commits the complete resize domain as one leaf and closes exact undo and redo', () => {
    const source = validateFileDocument(fixture(), atoms)
    const sourceBefore = structuredClone(source)
    const resize = command()
    const resizeBefore = structuredClone(resize)
    const history = applyFileCommandWithHistory(source, resize, atoms)

    expect(history.redo).toStrictEqual(command())
    expect(history.undo).toStrictEqual({
      type: 'node.resizePresentation',
      entries: [
        { expected: frameSource, source: frameExpected },
        { expected: textSource, source: textExpected },
        { expected: componentSource, source: componentExpected },
      ],
    })
    expect(history.file.nodes.frame).toStrictEqual({
      id: 'frame', type: 'frame', name: 'Frame', styles: { ...frameSource.primitiveGeometry!, overflow: 'visible' },
      layout: frameSource.layout, appearance: frameSource.appearance,
    })
    expect(history.file.nodes.text).toStrictEqual({
      id: 'text', type: 'text', name: 'Text', styles: textSource.primitiveGeometry!, text: 'Hello',
      textStyle: textSource.textProperties!.textStyle, textSizing: textSource.textProperties!.textSizing,
      layout: textSource.layout, appearance: textSource.appearance,
    })
    expect(history.file.nodes.card).toStrictEqual({
      id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', name: 'Card instance', props: { label: 'Keep me' },
      layout: componentSource.layout, appearance: componentSource.appearance,
    })
    expect(history.file.relationships).toStrictEqual(source.relationships)
    expect(history.file.nodes.rectangle).toStrictEqual(source.nodes.rectangle)
    expect(source).toStrictEqual(sourceBefore)
    expect(resize).toStrictEqual(resizeBefore)

    const undone = applyFileCommand(history.file, history.undo, atoms)
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(source))
    const redone = applyFileCommand(undone, history.redo, atoms)
    expect(withoutRevision(redone)).toStrictEqual(withoutRevision(history.file))
  })

  it('clears exact nullable authorities and restores their prior presence', () => {
    const source = validateFileDocument(fixture(), atoms)
    const clear: FileCommand = {
      type: 'node.resizePresentation',
      entries: [{
        expected: {
          nodeId: 'card', relationship: { parentId: 'host', slot: 'content', orderKey: 'Q2' },
          layout: componentLayout, appearance: { opacity: 0.6 },
        },
        source: { nodeId: 'card', relationship: { parentId: 'host', slot: 'content', orderKey: 'Q2' }, layout: null, appearance: null },
      }],
    }
    const history = applyFileCommandWithHistory(source, clear, atoms)
    expect(history.file.nodes.card).not.toHaveProperty('layout')
    expect(history.file.nodes.card).not.toHaveProperty('appearance')
    expect(history.file.nodes.card).toMatchObject({ componentId: 'card-component', exportName: 'Card', props: { label: 'Keep me' } })
    expect(history.file.relationships.card).toStrictEqual({ parentId: 'host', slot: 'content', orderKey: 'Q2' })
    expect(applyFileCommand(history.file, history.undo, atoms).nodes.card).toStrictEqual(source.nodes.card)
    expect(applyFileCommand(source, history.redo, atoms).nodes.card).toStrictEqual(history.file.nodes.card)
  })

  it('checks every expected authority and the exact relationship before any write', () => {
    const staleEntries: NodeResizePresentationEntry[] = [
      { expected: { ...structuredClone(frameExpected), primitiveGeometry: { relativeTransform: [1, 0, 0, 1, -19, 15], width: 320, height: 180 } }, source: structuredClone(frameSource) },
      { expected: { ...structuredClone(frameExpected), layout: { item: { position: { mode: 'freeform' } }, container: { display: 'block' } } }, source: structuredClone(frameSource) },
      { expected: { ...structuredClone(textExpected), textProperties: { textStyle: { ...textStyle, fontSize: 17 }, textSizing } }, source: structuredClone(textSource) },
      { expected: { ...structuredClone(frameExpected), appearance: { opacity: 0.75 } }, source: structuredClone(frameSource) },
      { expected: { ...structuredClone(frameExpected), relationship: { parentId: 'root', orderKey: 'wrong' } }, source: { ...structuredClone(frameSource), relationship: { parentId: 'root', orderKey: 'wrong' } } },
    ]
    for (const entry of staleEntries) {
      const source = fixture()
      const before = structuredClone(source)
      const stale: FileCommand = { type: 'node.resizePresentation', entries: [entry] }
      const staleBefore = structuredClone(stale)
      expect(() => applyFileCommand(source, stale, atoms)).toThrow('Resize presentation expected state does not match the file')
      expect(source).toStrictEqual(before)
      expect(stale).toStrictEqual(staleBefore)
    }
  })

  it('rejects a stale later entry atomically through checked history', () => {
    const source = fixture()
    const before = structuredClone(source)
    const late: FileCommand = {
      type: 'node.resizePresentation',
      entries: [
        { expected: structuredClone(frameExpected), source: structuredClone(frameSource) },
        { expected: { ...structuredClone(textExpected), appearance: { opacity: 0.2 } }, source: structuredClone(textSource) },
      ],
    }
    const commandBefore = structuredClone(late)
    expect(() => applyFileCommandWithHistory(source, late, atoms)).toThrow('Resize presentation expected state does not match the file')
    expect(source).toStrictEqual(before)
    expect(late).toStrictEqual(commandBefore)
  })

  it('rejects a late stale 5,000-entry aggregate before the history path clones the file', () => {
    const nodes: FileDocument['nodes'] = { root: { id: 'root', type: 'root' } }
    const relationships: FileDocument['relationships'] = {}
    const entries: NodeResizePresentationEntry[] = []
    for (let index = 0; index < 5_000; index += 1) {
      const nodeId = `large-node-${index}`
      nodes[nodeId] = { id: nodeId, type: 'rectangle', name: nodeId, styles: { relativeTransform: [1, 0, 0, 1, index, 0], width: 10, height: 10 } }
      relationships[nodeId] = { parentId: 'root', orderKey: 'K1' }
      entries.push({
        expected: { nodeId, relationship: { parentId: 'root', orderKey: 'K1' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, index, 0], width: 10, height: 10 } },
        source: { nodeId, relationship: { parentId: 'root', orderKey: 'K1' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, index + 1, 0], width: 10, height: 10 } },
      })
    }
    entries[4_999] = {
      expected: { nodeId: 'large-node-4999', relationship: { parentId: 'root', orderKey: 'K1' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, -1, 0], width: 10, height: 10 } },
      source: { nodeId: 'large-node-4999', relationship: { parentId: 'root', orderKey: 'K1' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 5000, 0], width: 10, height: 10 } },
    }
    const source: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'preflight-before-clone', revision: 8, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }], nodes, relationships, theme: { tokens: {} },
    }
    const resize: FileCommand = { type: 'node.resizePresentation', entries }
    const nativeClone = globalThis.structuredClone
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(((value: unknown) => {
      if (value === source) throw new Error('History cloned the file before resize preflight')
      return nativeClone(value)
    }) as typeof structuredClone)
    let clonedSource = false
    try {
      expect(() => applyFileCommandWithHistory(source, resize, [])).toThrow('Resize presentation expected state does not match the file')
      clonedSource = cloneSpy.mock.calls.some(([value]) => value === source)
    } finally {
      cloneSpy.mockRestore()
    }
    expect(clonedSource).toBe(false)
  })

  it('rejects authority and node-kind mismatches without touching inputs', () => {
    const cases: FileCommand[] = [
      {
        type: 'node.resizePresentation', entries: [{
          expected: { nodeId: 'card', relationship: { parentId: 'host', slot: 'content', orderKey: 'Q2' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 } },
          source: { nodeId: 'card', relationship: { parentId: 'host', slot: 'content', orderKey: 'Q2' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 1, 2], width: 20, height: 20 } },
        }],
      },
      {
        type: 'node.resizePresentation', entries: [{
          expected: { nodeId: 'rectangle', relationship: { parentId: 'frame', orderKey: 'z9' }, textProperties: { textStyle, textSizing } },
          source: { nodeId: 'rectangle', relationship: { parentId: 'frame', orderKey: 'z9' }, textProperties: { textStyle: { ...textStyle, fontSize: 20 }, textSizing } },
        }],
      },
      {
        type: 'node.resizePresentation', entries: [{
          expected: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, appearance: { opacity: 0.7 } },
          source: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, appearance: { borders: { all: { color: black, width: 1, style: 'solid' } } } },
        }],
      },
      {
        type: 'node.resizePresentation', entries: [
          { expected: structuredClone(frameExpected), source: structuredClone(frameSource) },
          {
            expected: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, appearance: { opacity: 0.7 } },
            source: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, appearance: { borders: { all: { color: black, width: 1, style: 'solid' } } } },
          },
        ],
      },
    ]
    for (const candidate of cases) {
      const source = fixture()
      const before = structuredClone(source)
      const candidateBefore = structuredClone(candidate)
      expect(() => applyFileCommand(source, candidate, atoms)).toThrow()
      expect(source).toStrictEqual(before)
      expect(candidate).toStrictEqual(candidateBefore)
    }
  })

  it('rejects malformed closed-state commands, duplicate nodes, and authority presence drift', () => {
    const valid = command()
    expect(validateFileCommand(valid)).toStrictEqual(valid)
    const first = (valid as Extract<FileCommand, { type: 'node.resizePresentation' }>).entries[0]!
    const missingSourceAppearance = structuredClone(first)
    delete missingSourceAppearance.source.appearance
    const missingExpectedAppearance = structuredClone(first)
    delete missingExpectedAppearance.expected.appearance
    const malformed: unknown[] = [
      { ...valid, extra: true },
      { type: 'node.resizePresentation', entries: [{ ...first, extra: true }] },
      { type: 'node.resizePresentation', entries: [{ expected: { ...first.expected, extra: true }, source: first.source }] },
      { type: 'node.resizePresentation', entries: [{ expected: { nodeId: 'frame', relationship: { parentId: 'root', orderKey: 'A7' } }, source: { nodeId: 'frame', relationship: { parentId: 'root', orderKey: 'A7' } } }] },
      { type: 'node.resizePresentation', entries: [missingSourceAppearance] },
      { type: 'node.resizePresentation', entries: [missingExpectedAppearance] },
      { type: 'node.resizePresentation', entries: [{ expected: first.expected, source: { ...first.source, nodeId: 'different-node' } }] },
      { type: 'node.resizePresentation', entries: [{ expected: first.expected, source: { ...first.source, relationship: { parentId: 'root', orderKey: 'B8' } } }] },
      { type: 'node.resizePresentation', entries: [first, structuredClone(first)] },
      { type: 'node.resizePresentation', entries: [{ expected: { ...first.expected, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 0, height: 10 } }, source: first.source }] },
      { type: 'node.resizePresentation', entries: [{ expected: { ...first.expected, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10 } }, source: first.source }] },
      {
        type: 'node.resizePresentation', entries: [{
          expected: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, textStyle, textSizing },
          source: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, textStyle, textSizing },
        }],
      },
      {
        type: 'node.resizePresentation', entries: [{
          expected: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, textProperties: { textStyle } },
          source: { nodeId: 'text', relationship: { parentId: 'frame', orderKey: 'mQ' }, textProperties: { textStyle } },
        }],
      },
      JSON.parse('{"type":"node.resizePresentation","entries":[],"__proto__":{"polluted":true}}'),
      Object.assign(Object.create({ inherited: true }), valid),
    ]
    for (const candidate of malformed) expect(() => validateFileCommand(candidate)).toThrow('Invalid file command')
  })

  it('PAPER-FLEX-006 rejects named-slot absence and name drift against the current relationship', () => {
    const candidates: FileCommand[] = [
      {
        type: 'node.resizePresentation', entries: [{
          expected: { nodeId: 'card', relationship: { parentId: 'host', orderKey: 'Q2' }, layout: componentLayout },
          source: { nodeId: 'card', relationship: { parentId: 'host', orderKey: 'Q2' }, layout: componentSource.layout! },
        }],
      },
      {
        type: 'node.resizePresentation', entries: [{
          expected: { nodeId: 'card', relationship: { parentId: 'host', slot: 'other', orderKey: 'Q2' }, layout: componentLayout },
          source: { nodeId: 'card', relationship: { parentId: 'host', slot: 'other', orderKey: 'Q2' }, layout: componentSource.layout! },
        }],
      },
    ]
    for (const candidate of candidates) {
      const source = fixture()
      const before = structuredClone(source)
      expect(() => applyFileCommandWithHistory(source, candidate, atoms)).toThrow('Resize presentation expected state does not match the file')
      expect(source).toStrictEqual(before)
    }
  })

  it('AT-DOC-003 accepts 1,001 checked entries as one history leaf beyond the generic batch limit', () => {
    const nodes: FileDocument['nodes'] = { root: { id: 'root', type: 'root' } }
    const relationships: FileDocument['relationships'] = {}
    const entries: NodeResizePresentationEntry[] = []
    for (let index = 0; index < 1_001; index += 1) {
      const nodeId = `node-${index}`
      nodes[nodeId] = { id: nodeId, type: 'rectangle', name: nodeId, styles: { relativeTransform: [1, 0, 0, 1, index, 0], width: 10, height: 10 } }
      relationships[nodeId] = { parentId: 'root', orderKey: 'K1' }
      entries.push({
        expected: { nodeId, relationship: { parentId: 'root', orderKey: 'K1' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, index, 0], width: 10, height: 10 } },
        source: { nodeId, relationship: { parentId: 'root', orderKey: 'K1' }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, index + 0.5, 1], width: 12, height: 11 } },
      })
    }
    const source: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'large-resize', revision: 2, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }], nodes, relationships, theme: { tokens: {} },
    }
    const history = applyFileCommandWithHistory(source, { type: 'node.resizePresentation', entries }, [])
    expect(history.redo.type).toBe('node.resizePresentation')
    expect(history.undo.type).toBe('node.resizePresentation')
    expect(history.file.nodes['node-1000']).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 1000.5, 1], width: 12, height: 11 } })
    expect(withoutRevision(applyFileCommand(history.file, history.undo, []))).toStrictEqual(withoutRevision(source))
  })

  it('rejects an entry count above the document node limit', () => {
    const expected = Array.from({ length: 5_001 }, (_, index) => ({
      expected: { nodeId: `node-${index}`, relationship: { parentId: 'root', orderKey: `K${index}` }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 } },
      source: { nodeId: `node-${index}`, relationship: { parentId: 'root', orderKey: `K${index}` }, primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 1, 0], width: 10, height: 10 } },
    }))
    expect(() => validateFileCommand({ type: 'node.resizePresentation', entries: expected })).toThrow('Invalid file command')
  })
})
