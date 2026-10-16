import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, validateFileCommand, validateFileDocument } from '../src/file-document.js'
import type { FileCommand, FileDocument } from '../src/file-document.js'
import { upgradeFileDocument } from '../src/file-migration.js'
import { layoutDeclarations } from '../src/file-preview.js'
import { isLayoutDeclarations, isSourceLayoutStyle, rejectedSourceDeclaration } from '../src/layout-css.js'
import { crossAlignments, projectContainerStyle, validateFlexContainer } from '../src/layout.js'
import type { Atom } from '../src/types.js'

const firstBaseline = { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'baseline' } as const
const lastBaseline = { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'last baseline' } as const
const file = (align: 'baseline' | 'last baseline' = 'baseline'): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'baseline-file',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: {
      id: 'frame',
      type: 'frame',
      name: 'Frame',
      styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 320, height: 200 },
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { ...lastBaseline, align } } },
    },
  },
  relationships: { frame: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})

const setLastBaseline = {
  type: 'node.setLayout',
  nodeId: 'frame',
  layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: lastBaseline } },
} as const satisfies FileCommand

const card: Atom = {
  componentId: 'card-component',
  name: 'Card',
  kind: 'atom',
  path: 'src/Card.tsx',
  exportName: 'Card',
  fingerprint: 'card',
  sourceHash: 'hash',
  status: 'bound',
  candidates: [],
  props: [],
}

describe('PAPER-FLEX-005 last baseline model and persistence', () => {
  it('keeps first and last baseline as distinct closed values and rejects lookalike strings', () => {
    expect(crossAlignments).toEqual(['start', 'center', 'end', 'stretch', 'baseline', 'last baseline'])
    expect(validateFlexContainer(firstBaseline)).toBe(true)
    expect(validateFlexContainer(lastBaseline)).toBe(true)
    expect(validateFlexContainer({ ...lastBaseline, align: 'last-baseline' })).toBe(false)
    expect(validateFlexContainer({ ...lastBaseline, align: 'first baseline' })).toBe(false)
  })

  it('serializes the exact CSS value through both component and primitive preview projections', () => {
    const container = { display: 'flex', flex: lastBaseline } as const
    expect(projectContainerStyle(container).alignItems).toBe('last baseline')
    const layout = { item: { position: { mode: 'flow' as const } }, container }
    expect(layoutDeclarations(layout, null)).toEqual({
      display: 'flex',
      'flex-direction': 'row',
      'flex-wrap': 'nowrap',
      'justify-content': 'flex-start',
      'align-items': 'last baseline',
    })
    expect(isLayoutDeclarations({ 'align-items': 'last baseline' })).toBe(true)
    expect(isSourceLayoutStyle({ 'align-items': 'last baseline' })).toBe(true)
    expect(rejectedSourceDeclaration({ 'align-items': 'last baseline' })).toBeNull()
    expect(isLayoutDeclarations({ 'align-items': 'last-baseline' })).toBe(false)
    expect(isSourceLayoutStyle({ 'align-items': 'first baseline' })).toBe(false)
  })

  it('round-trips a semantic command through exact undo and redo without mutating the source', () => {
    const source = validateFileDocument(file(), [])
    const sourceBytes = JSON.stringify(source)
    const history = applyFileCommandWithHistory(source, setLastBaseline, [])
    expect(JSON.stringify(source)).toBe(sourceBytes)
    expect(history.file.revision).toBe(1)
    expect(history.file.nodes.frame).toMatchObject({ layout: { container: { flex: lastBaseline } } })
    expect(history.undo).toEqual({
      type: 'node.setLayout',
      nodeId: 'frame',
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: firstBaseline } },
    })
    expect(history.redo).toEqual(setLastBaseline)

    const undone = applyFileCommand(history.file, history.undo, [])
    expect(undone.nodes.frame).toMatchObject({ layout: { container: { flex: firstBaseline } } })
    const redone = applyFileCommand(undone, history.redo, [])
    expect(redone.nodes.frame).toMatchObject({ layout: { container: { flex: lastBaseline } } })
    expect(validateFileDocument(JSON.parse(JSON.stringify(redone)), []).nodes.frame).toMatchObject({ layout: { container: { flex: lastBaseline } } })
  })

  it('keeps version 8 first-baseline files valid through migration', () => {
    const legacy = {
      schemaVersion: 8,
      fileId: 'legacy-baseline',
      revision: 4,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        card: { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: firstBaseline } } },
      },
      relationships: { card: { parentId: 'root-1', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    const upgraded = validateFileDocument(upgradeFileDocument(legacy), [card])
    expect(upgraded.schemaVersion).toBe(13)
    expect(upgraded.revision).toBe(4)
    expect(upgraded.nodes.card).toMatchObject({ layout: { container: { flex: firstBaseline } } })
  })

  it('rejects an unsupported alignment before applying any file mutation', () => {
    const source = file()
    const sourceBytes = JSON.stringify(source)
    const invalid = structuredClone(setLastBaseline) as unknown as { layout: { container: { flex: { align: string } } } }
    invalid.layout.container.flex.align = 'last-baseline'
    expect(() => validateFileCommand(invalid)).toThrow('Invalid file command')
    expect(() => applyFileCommand(source, invalid as unknown as FileCommand, [])).toThrow('Invalid primitive layout')
    expect(JSON.stringify(source)).toBe(sourceBytes)
  })
})
