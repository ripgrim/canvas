import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, legacyTextProperties, nodeChildDisplay, nodePositionMode, validateFileDocument } from '../src/file-document.js'
import type { ComponentNode, FileCommand, FileDocument, PrimitiveNode } from '../src/file-document.js'
import type { LayoutContainer } from '../src/layout.js'
import type { Atom } from '../src/types.js'

const card: Atom = { name: 'Card', kind: 'atom', componentId: 'sample-card', exportName: 'Card', path: 'src/atoms/Card.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [] }
const frame = (id: string): PrimitiveNode => ({ id, type: 'frame', name: id, styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 300, height: 200 } })
const rectangle = (id: string): PrimitiveNode => ({ id, type: 'rectangle', name: id, styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 80, height: 60 } })
const component = (id: string): ComponentNode => ({ id, type: 'component', componentId: card.componentId, exportName: card.exportName, props: {} })
const fixture = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'file-1',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' }, frame: frame('frame'), child: rectangle('child'), card: component('card') },
  relationships: { frame: { parentId: 'root-1', orderKey: 'V' }, child: { parentId: 'frame', orderKey: 'V' }, card: { parentId: 'root-1', orderKey: 'W' } },
  theme: { tokens: {} },
})
const checked = (file: FileDocument) => validateFileDocument(file, [card])

describe('PAPER-FLEX-001: schema v9 primitive layout contract', () => {
  it('keeps absence defaults explicit without materializing stored layout', () => {
    const file = checked(fixture())
    expect(nodePositionMode(file.nodes['root-1']!)).toBeNull()
    expect(nodePositionMode(file.nodes.frame!)).toBe('freeform')
    expect(nodePositionMode(file.nodes.card!)).toBe('flow')
    expect(nodeChildDisplay(file.nodes['root-1']!)).toBe('block')
    expect(nodeChildDisplay(file.nodes.frame!)).toBe('freeform')
    expect(file.nodes.frame).not.toHaveProperty('layout')
    expect(file.nodes.card).not.toHaveProperty('layout')
  })

  it('admits a frame flex container with a flow child and matching flex item', () => {
    const file = fixture()
    file.nodes.frame = { ...frame('frame'), layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } } } }
    file.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'flow' }, flex: { grow: 1 } } } }
    expect(checked(file).nodes.child).toMatchObject({ layout: { item: { position: { mode: 'flow' }, flex: { grow: 1 } } } })
  })

  it('rejects each competing primitive authority and a freeform component', () => {
    const mutations: Array<[string, (file: FileDocument) => void, string]> = [
      ['frame container overflow', file => { file.nodes.frame = { ...frame('frame'), layout: { item: { position: { mode: 'freeform' } }, container: { display: 'freeform', overflow: 'clip' } } } }, 'Frame layout cannot override clipping'],
      ['non-frame container', file => { file.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'freeform' } }, container: { display: 'block' } } } }, 'Only frames can carry a layout container'],
      ['primitive transform', file => {
        file.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'absolute' }, transform: { matrix: [1, 0, 0, 1, 0, 0] } } } }
      }, 'Primitive layout cannot override its transform'],
      ['duplicate fixed primitive sizing', file => { file.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'freeform' }, width: { value: { kind: 'px', value: 80 } } } } } }, 'Fixed primitive sizing belongs in node styles'],
      ['freeform component', file => { file.nodes.card = { ...component('card'), layout: { item: { position: { mode: 'freeform' } } } } }, 'Components cannot use freeform layout'],
    ]
    for (const [label, mutate, message] of mutations) {
      const file = fixture()
      mutate(file)
      expect(() => checked(file), label).toThrow(message)
    }

    const text = fixture()
    text.nodes.child = { id: 'child', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 80, height: 24 }, text: 'Text', ...legacyTextProperties(), layout: { item: { position: { mode: 'absolute' }, width: { value: { kind: 'px', value: 80 } } } } }
    expect(() => checked(text)).toThrow('Text layout cannot override text sizing')
  })

  it('requires flow and mode-specific item records to agree with the parent', () => {
    const rootFlow = fixture()
    rootFlow.relationships.child = { parentId: 'root-1', orderKey: 'X' }
    rootFlow.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'flow' } } } }
    expect(() => checked(rootFlow)).toThrow('Primitive flow nodes cannot live on a page root')

    const rootAbsolute = fixture()
    rootAbsolute.relationships.child = { parentId: 'root-1', orderKey: 'X' }
    rootAbsolute.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } } } }
    expect(checked(rootAbsolute)).toBeTruthy()

    const rootFreeform = fixture()
    rootFreeform.relationships.child = { parentId: 'root-1', orderKey: 'X' }
    rootFreeform.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'freeform' } } } }
    expect(checked(rootFreeform)).toBeTruthy()
    expect(checked(fixture()).nodes.card).not.toHaveProperty('layout')

    const flowInFreeform = fixture()
    flowInFreeform.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'flow' } } } }
    expect(() => checked(flowInFreeform)).toThrow('Flow nodes need a flow layout parent')

    const flex = fixture()
    flex.nodes.frame = { ...frame('frame'), layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } }
    flex.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'flow' }, flex: { grow: 1 } } } }
    expect(checked(flex)).toBeTruthy()
    ;(flex.nodes.frame as PrimitiveNode).layout!.container = { display: 'block' }
    expect(() => checked(flex)).toThrow('Flex item properties need a flex parent')

    const grid = fixture()
    grid.nodes.frame = { ...frame('frame'), layout: { item: { position: { mode: 'freeform' } }, container: { display: 'grid', grid: { columns: [{ kind: 'fr', value: 1 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } } } }
    grid.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'flow' }, grid: { columnStart: 1 } } } }
    expect(checked(grid)).toBeTruthy()
    ;(grid.nodes.frame as PrimitiveNode).layout!.container = { display: 'block' }
    expect(() => checked(grid)).toThrow('Grid item properties need a grid parent')
  })

  it('keeps absolute placement valid under freeform, block, flex, and grid parents', () => {
    const containers: LayoutContainer[] = [
      { display: 'freeform' },
      { display: 'block' },
      { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } },
      { display: 'grid', grid: { columns: [{ kind: 'fr', value: 1 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } },
    ]
    for (const container of containers) {
      const file = fixture()
      file.nodes.frame = { ...frame('frame'), layout: { item: { position: { mode: 'freeform' } }, container } }
      file.nodes.child = { ...rectangle('child'), layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 18 } } } } }
      expect(checked(file).nodes.child).toMatchObject({ layout: { item: { position: { mode: 'absolute' } } } })
    }
  })

  it('sets layout on any non-root and preserves exact layout absence through semantic undo', () => {
    const before = checked(fixture())
    const command = { type: 'node.setLayout', nodeId: 'child', layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 40 }, top: { kind: 'px', value: 50 } } } } } as const
    const history = applyFileCommandWithHistory(before, command, [card])
    expect(history.file.nodes.child).toHaveProperty('layout')
    expect(history.undo).toStrictEqual({ type: 'node.setLayout', nodeId: 'child', layout: null })
    const restored = applyFileCommand(history.file, history.undo, [card])
    expect(restored.nodes.child).not.toHaveProperty('layout')
    expect(() => applyFileCommand(before, { type: 'node.setLayout', nodeId: 'root-1', layout: command.layout }, [card])).toThrow('Select a design node')
  })

  it.each(['parent-first', 'child-first'] as const)('treats coupled %s flex conversion history as one atomic transaction', order => {
    const source = checked(fixture())
    const parent = { type: 'node.setLayout', nodeId: 'frame', layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } } } } as const
    const child = { type: 'node.setLayout', nodeId: 'child', layout: { item: { position: { mode: 'flow' }, flex: { grow: 1 } } } } as const
    const commands = order === 'parent-first' ? [parent, child] : [child, parent]
    const result = applyFileCommandWithHistory(source, { type: 'batch', commands }, [card])

    expect(result.file.revision).toBe(source.revision + 1)
    expect(result.file.nodes.frame).toMatchObject({ layout: { container: { display: 'flex' } } })
    expect(result.file.nodes.child).toMatchObject({ layout: { item: { position: { mode: 'flow' }, flex: { grow: 1 } } } })
    expect(result.redo).toStrictEqual({ type: 'batch', commands })
    expect(result.undo).toStrictEqual({ type: 'batch', commands: commands.map(command => ({ type: 'node.setLayout', nodeId: command.nodeId, layout: null })).reverse() })

    const undone = applyFileCommand(result.file, result.undo, [card])
    expect({ ...undone, revision: source.revision }).toStrictEqual(source)
    const redone = applyFileCommand(undone, result.redo, [card])
    expect({ ...redone, revision: result.file.revision }).toStrictEqual(result.file)
  })

  it('rejects a malformed final layout transaction atomically', () => {
    const source = checked(fixture())
    const before = structuredClone(source)
    const command: FileCommand = { type: 'batch', commands: [{ type: 'node.setLayout', nodeId: 'frame', layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } }] }
    expect(() => applyFileCommandWithHistory(source, command, [card])).toThrow('Freeform nodes need a freeform parent')
    expect(source).toStrictEqual(before)
  })
})
