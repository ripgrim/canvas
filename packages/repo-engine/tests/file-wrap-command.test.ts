import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, childrenOf, validateFileCommand, validateFileDocument } from '../src/file-document.js'
import type { FileCommand, FileDocument, NodeWrapGroup, PrimitiveNode } from '../src/file-document.js'
import type { NodeLayout } from '../src/layout.js'
import type { Atom } from '../src/types.js'

const card: Atom = { name: 'Card', kind: 'atom', componentId: 'card', exportName: 'Card', path: 'Card.tsx', fingerprint: 'card', sourceHash: 'card', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] }
const button: Atom = { name: 'Button', kind: 'atom', componentId: 'button', exportName: 'Button', path: 'Button.tsx', fingerprint: 'button', sourceHash: 'button', status: 'bound', candidates: [], props: [] }
const atoms = [card, button]

const rect = (id: string, left = 0, top = 0): PrimitiveNode => ({ id, type: 'rectangle', name: id, styles: { relativeTransform: [1, 0, 0, 1, left, top], width: 20, height: 20 } })
const frame = (id: string, left = 0, top = 0): PrimitiveNode => ({ id, type: 'frame', name: id, styles: { relativeTransform: [1, 0, 0, 1, left, top], width: 240, height: 160 } })
const flow = (): NodeLayout => ({ item: { position: { mode: 'flow' } } })
const absolute = (left: number, top: number, zIndex?: number): NodeLayout => ({ item: { position: { mode: 'absolute', left: { kind: 'px', value: left }, top: { kind: 'px', value: top }, ...(zIndex === undefined ? {} : { zIndex }) } } })
const flex = (position: NodeLayout['item']['position']): NodeLayout => ({ item: { position }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' }, gap: 12 }, spacing: { padding: 0 } })
const wrapper = (id: string, position: NodeLayout['item']['position']): NodeWrapGroup['wrapper'] => ({ ...frame(id, 30, 40), type: 'frame', styles: { ...frame(id, 30, 40).styles, overflow: 'visible' }, layout: flex(position) })

const blank = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'wrap-file',
  revision: 7,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
})
const add = (file: FileDocument, node: PrimitiveNode, parentId: string, orderKey: string, layout?: NodeLayout) => {
  file.nodes[node.id] = layout ? { ...node, layout } : node
  file.relationships[node.id] = { parentId, orderKey }
}
const checked = (file: FileDocument) => validateFileDocument(file, atoms)
const order = (file: FileDocument, parentId: string) => childrenOf(file, parentId)
const withoutRevision = (file: FileDocument) => ({ ...file, revision: 0 })

describe('PAPER-FLEX-001/003 closed Wrap transaction', () => {
  it('WRAP-02 replaces the highest selected sibling position and pairs fresh keys with analyzer order', () => {
    const source = blank()
    add(source, rect('u0'), 'root-1', 'V')
    add(source, rect('A'), 'root-1', 'W')
    add(source, rect('u1'), 'root-1', 'X')
    add(source, rect('B'), 'root-1', 'Y')
    add(source, rect('u2'), 'root-1', 'Z')
    const command: FileCommand = {
      type: 'node.wrap',
      groups: [{
        wrapper: wrapper('wrap-ab', { mode: 'freeform' }),
        parentId: 'root-1',
        children: [{ nodeId: 'B', targetLayout: flow() }, { nodeId: 'A', targetLayout: flow() }],
      }],
    }

    expect(validateFileCommand(command)).toStrictEqual(command)
    const result = applyFileCommandWithHistory(checked(source), command, atoms)
    expect(result.file.revision).toBe(8)
    expect(order(result.file, 'root-1')).toStrictEqual(['u0', 'u1', 'wrap-ab', 'u2'])
    expect(result.file.relationships['wrap-ab']).toStrictEqual({ parentId: 'root-1', orderKey: 'Y' })
    expect(order(result.file, 'wrap-ab')).toStrictEqual(['B', 'A'])
    expect(result.file.relationships.B).toStrictEqual({ parentId: 'wrap-ab', orderKey: 'V' })
    expect(result.file.relationships.A).toStrictEqual({ parentId: 'wrap-ab', orderKey: 'W' })
    expect(result.file.nodes['wrap-ab']).toStrictEqual({ ...wrapper('wrap-ab', { mode: 'freeform' }), themeMode: 'inherit' })
    expect(result.file.nodes.B).toStrictEqual({ ...rect('B'), layout: flow() })
    expect(result.file.nodes.A).toStrictEqual({ ...rect('A'), layout: flow() })
  })

  it('WRAP-03 lets only non-absolute selected siblings choose the insertion when flow is present', () => {
    const source = blank()
    add(source, { ...frame('parent'), layout: flex({ mode: 'freeform' }) }, 'root-1', 'V')
    add(source, rect('u0'), 'parent', 'A', flow())
    add(source, rect('absolute-early'), 'parent', 'B', absolute(10, 10, 1))
    add(source, rect('u1'), 'parent', 'C', flow())
    add(source, rect('flow-selected'), 'parent', 'D', flow())
    add(source, rect('u2'), 'parent', 'E', flow())
    add(source, rect('absolute-late'), 'parent', 'F', absolute(90, 10, 2))
    add(source, rect('u3'), 'parent', 'G', flow())
    const command: FileCommand = {
      type: 'node.wrap',
      groups: [{
        wrapper: wrapper('mixed-wrap', { mode: 'flow' }),
        parentId: 'parent',
        children: [
          { nodeId: 'absolute-late', targetLayout: flow() },
          { nodeId: 'flow-selected', targetLayout: flow() },
          { nodeId: 'absolute-early', targetLayout: flow() },
        ],
      }],
    }

    const wrongMode: FileCommand = { ...command, groups: [{ ...command.groups[0]!, wrapper: wrapper('wrong-mixed-wrap', { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } }) }] }
    expect(() => applyFileCommand(checked(source), wrongMode, atoms)).toThrow('Wrapper placement does not match its source siblings')

    const result = applyFileCommand(checked(source), command, atoms)
    expect(order(result, 'parent')).toStrictEqual(['u0', 'u1', 'mixed-wrap', 'u2', 'u3'])
    expect(result.relationships['mixed-wrap']).toStrictEqual({ parentId: 'parent', orderKey: 'D' })
    expect(order(result, 'mixed-wrap')).toStrictEqual(['absolute-late', 'flow-selected', 'absolute-early'])
    expect(result.nodes['mixed-wrap']).toMatchObject({ layout: { item: { position: { mode: 'flow' } } } })
    for (const id of ['absolute-late', 'flow-selected', 'absolute-early']) expect(result.nodes[id]).toMatchObject({ layout: { item: { position: { mode: 'flow' } } } })
  })

  it('WRAP-04 keeps an all-absolute wrapper absolute while every child enters clean flow', () => {
    const source = blank()
    add(source, rect('u0'), 'root-1', 'A')
    add(source, rect('absolute-a'), 'root-1', 'B', absolute(12, 14, 3))
    add(source, rect('u1'), 'root-1', 'C')
    add(source, rect('absolute-b'), 'root-1', 'D', absolute(72, 18, 9))
    add(source, rect('u2'), 'root-1', 'E')
    const command: FileCommand = {
      type: 'node.wrap',
      groups: [{
        wrapper: wrapper('absolute-wrap', { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 14 }, zIndex: 3 }),
        parentId: 'root-1',
        children: [{ nodeId: 'absolute-b', targetLayout: flow() }, { nodeId: 'absolute-a', targetLayout: flow() }],
      }],
    }

    const wrongWrapperMode: FileCommand = { ...command, groups: [{ ...command.groups[0]!, wrapper: wrapper('wrong-absolute-wrap', { mode: 'freeform' }) }] }
    expect(() => applyFileCommand(checked(source), wrongWrapperMode, atoms)).toThrow('Wrapper placement does not match its source siblings')
    const wrongChildMode: FileCommand = { ...command, groups: [{ ...command.groups[0]!, children: [{ nodeId: 'absolute-b', targetLayout: absolute(0, 0) }, { nodeId: 'absolute-a', targetLayout: flow() }] }] }
    expect(() => applyFileCommand(checked(source), wrongChildMode, atoms)).toThrow('Wrapped children must enter flow')

    const result = applyFileCommand(checked(source), command, atoms)
    expect(order(result, 'root-1')).toStrictEqual(['u0', 'u1', 'absolute-wrap', 'u2'])
    expect(result.relationships['absolute-wrap']).toStrictEqual({ parentId: 'root-1', orderKey: 'D' })
    expect(result.nodes['absolute-wrap']).toMatchObject({ layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 14 }, zIndex: 3 } } } })
    expect((result.nodes['absolute-a'] as PrimitiveNode).layout).toStrictEqual({ item: { position: { mode: 'flow' } } })
    expect((result.nodes['absolute-b'] as PrimitiveNode).layout).toStrictEqual({ item: { position: { mode: 'flow' } } })
  })

  it('WRAP-07 wraps two parents deterministically in one revision and one history entry', () => {
    const source = blank()
    add(source, frame('left-parent'), 'root-1', 'V')
    add(source, frame('right-parent'), 'root-1', 'W')
    add(source, rect('left-a'), 'left-parent', 'V')
    add(source, rect('left-b'), 'left-parent', 'W')
    add(source, rect('right-a'), 'right-parent', 'V')
    add(source, rect('right-b'), 'right-parent', 'W')
    const command: FileCommand = {
      type: 'node.wrap',
      groups: [
        { wrapper: wrapper('right-wrap', { mode: 'freeform' }), parentId: 'right-parent', children: [{ nodeId: 'right-b', targetLayout: flow() }, { nodeId: 'right-a', targetLayout: flow() }] },
        { wrapper: wrapper('left-wrap', { mode: 'freeform' }), parentId: 'left-parent', children: [{ nodeId: 'left-a', targetLayout: flow() }, { nodeId: 'left-b', targetLayout: flow() }] },
      ],
    }

    const result = applyFileCommandWithHistory(checked(source), command, atoms)
    expect(result.file.revision).toBe(8)
    expect(order(result.file, 'left-parent')).toStrictEqual(['left-wrap'])
    expect(order(result.file, 'right-parent')).toStrictEqual(['right-wrap'])
    expect(order(result.file, 'right-wrap')).toStrictEqual(['right-b', 'right-a'])
    expect(order(result.file, 'left-wrap')).toStrictEqual(['left-a', 'left-b'])
    expect(result.undo).toMatchObject({ type: 'node.unwrap', groups: [{ wrapperId: 'right-wrap' }, { wrapperId: 'left-wrap' }] })
    expect(result.redo).toStrictEqual(command)
  })

  it('WRAP-10 rejects component and slotted topology, cross-group overlap, nesting, and clipping atomically', () => {
    const componentChild = blank()
    componentChild.nodes.component = { id: 'component', type: 'component', componentId: 'button', exportName: 'Button', props: {} }
    componentChild.relationships.component = { parentId: 'root-1', orderKey: 'V' }
    add(componentChild, rect('primitive'), 'root-1', 'W')
    const mixed: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('mixed-wrap', { mode: 'freeform' }), parentId: 'root-1', children: [{ nodeId: 'primitive', targetLayout: flow() }, { nodeId: 'component', targetLayout: flow() }] }] }
    const mixedBefore = structuredClone(componentChild)
    expect(() => applyFileCommand(componentChild, mixed, atoms)).toThrow('Wrap accepts primitive nodes only')
    expect(componentChild).toStrictEqual(mixedBefore)

    const slot = blank()
    slot.nodes.card = { id: 'card', type: 'component', componentId: 'card', exportName: 'Card', props: {} }
    slot.nodes.button = { id: 'button', type: 'component', componentId: 'button', exportName: 'Button', props: {} }
    slot.relationships.card = { parentId: 'root-1', orderKey: 'V' }
    slot.relationships.button = { parentId: 'card', orderKey: 'V', slot: 'children' }
    const slotted: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('slot-wrap', { mode: 'flow' }), parentId: 'card', children: [{ nodeId: 'button', targetLayout: flow() }] }] }
    expect(() => applyFileCommand(checked(slot), slotted, atoms)).toThrow('Wrap needs a page or frame parent')

    const topology = blank()
    add(topology, frame('outer'), 'root-1', 'V')
    add(topology, rect('inner'), 'outer', 'V')
    add(topology, rect('peer'), 'root-1', 'W')
    const nested: FileCommand = { type: 'node.wrap', groups: [
      { wrapper: wrapper('outer-wrap', { mode: 'freeform' }), parentId: 'root-1', children: [{ nodeId: 'outer', targetLayout: flow() }] },
      { wrapper: wrapper('inner-wrap', { mode: 'freeform' }), parentId: 'outer', children: [{ nodeId: 'inner', targetLayout: flow() }] },
    ] }
    expect(() => applyFileCommand(checked(topology), nested, atoms)).toThrow('Wrap selections cannot contain one another')

    const duplicate: FileCommand = { type: 'node.wrap', groups: [
      { wrapper: wrapper('one-wrap', { mode: 'freeform' }), parentId: 'root-1', children: [{ nodeId: 'peer', targetLayout: flow() }] },
      { wrapper: wrapper('two-wrap', { mode: 'freeform' }), parentId: 'root-1', children: [{ nodeId: 'peer', targetLayout: flow() }] },
    ] }
    expect(() => applyFileCommand(checked(topology), duplicate, atoms)).toThrow('Wrap selections cannot overlap')

    const validFirstInvalidSecond: FileCommand = { type: 'node.wrap', groups: [
      { wrapper: wrapper('valid-wrap', { mode: 'freeform' }), parentId: 'root-1', children: [{ nodeId: 'peer', targetLayout: flow() }] },
      { wrapper: { ...wrapper('clip-wrap', { mode: 'freeform' }), styles: { ...wrapper('clip-wrap', { mode: 'freeform' }).styles, overflow: 'clip' } }, parentId: 'outer', children: [{ nodeId: 'inner', targetLayout: flow() }] },
    ] }
    const topologyBefore = structuredClone(topology)
    expect(() => validateFileCommand(validFirstInvalidSecond)).toThrow('Invalid file command')
    expect(() => applyFileCommand(topology, validFirstInvalidSecond, atoms)).toThrow('Invalid Wrap group')
    expect(topology).toStrictEqual(topologyBefore)

    const visible = wrapper('omitted-overflow-wrap', { mode: 'freeform' })
    const { overflow: _overflow, ...stylesWithoutOverflow } = visible.styles
    const omittedOverflow: FileCommand = { type: 'node.wrap', groups: [{ wrapper: { ...visible, styles: stylesWithoutOverflow }, parentId: 'root-1', children: [{ nodeId: 'peer', targetLayout: flow() }] }] }
    expect(() => validateFileCommand(omittedOverflow)).toThrow('Invalid file command')
    expect(() => applyFileCommand(topology, omittedOverflow, atoms)).toThrow('Invalid Wrap group')
    expect(topology).toStrictEqual(topologyBefore)
  })

  it('WRAP-11 restores exact relationships and layouts, deletes wrappers, and redoes byte-identically', () => {
    const source = blank()
    add(source, rect('before'), 'root-1', 'A')
    add(source, rect('absolute-a'), 'root-1', 'B', { item: { position: { mode: 'absolute', left: { kind: 'px', value: -8 }, right: { kind: 'percent', value: 12 }, top: { kind: 'px', value: 19 }, bottom: { kind: 'px', value: 4 }, zIndex: -2 } }, spacing: { margin: { top: 1, right: 2, bottom: 3, left: 4 } } })
    add(source, rect('middle'), 'root-1', 'C')
    add(source, rect('absolute-b'), 'root-1', 'D', absolute(81, -6, 12))
    add(source, rect('after'), 'root-1', 'E')
    const command: FileCommand = {
      type: 'node.wrap',
      groups: [{
        wrapper: wrapper('history-wrap', { mode: 'absolute', left: { kind: 'px', value: -8 }, top: { kind: 'px', value: -6 }, zIndex: -2 }),
        parentId: 'root-1',
        children: [{ nodeId: 'absolute-b', targetLayout: flow() }, { nodeId: 'absolute-a', targetLayout: flow() }],
      }],
    }
    const projected = applyFileCommandWithHistory(checked(source), command, atoms)
    expect(projected.undo).toStrictEqual({
      type: 'node.unwrap',
      groups: [{
        wrapperId: 'history-wrap',
        children: [
          { nodeId: 'absolute-b', relationship: { parentId: 'root-1', orderKey: 'D' }, layout: absolute(81, -6, 12) },
          { nodeId: 'absolute-a', relationship: { parentId: 'root-1', orderKey: 'B' }, layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: -8 }, right: { kind: 'percent', value: 12 }, top: { kind: 'px', value: 19 }, bottom: { kind: 'px', value: 4 }, zIndex: -2 } }, spacing: { margin: { top: 1, right: 2, bottom: 3, left: 4 } } } },
        ],
      }],
    })

    const undone = applyFileCommand(projected.file, projected.undo, atoms)
    expect(undone.nodes).not.toHaveProperty('history-wrap')
    expect(undone.relationships).not.toHaveProperty('history-wrap')
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(checked(source)))
    const redone = applyFileCommand(undone, projected.redo, atoms)
    expect(withoutRevision(redone)).toStrictEqual(withoutRevision(projected.file))
    expect(JSON.stringify(withoutRevision(redone))).toBe(JSON.stringify(withoutRevision(projected.file)))

    const inverse = applyFileCommandWithHistory(projected.file, projected.undo, atoms)
    expect(inverse.file.nodes).not.toHaveProperty('history-wrap')
    const inverseRedone = applyFileCommand(inverse.file, inverse.undo, atoms)
    expect(withoutRevision(inverseRedone)).toStrictEqual(withoutRevision(projected.file))
    expect(JSON.stringify(withoutRevision(inverseRedone))).toBe(JSON.stringify(withoutRevision(projected.file)))
  })

  it('WRAP-12 wraps 500 children as one leaf while the equivalent 1001-leaf batch is refused', () => {
    const source = blank()
    const children = Array.from({ length: 500 }, (_, index) => `child-${String(index).padStart(3, '0')}`)
    const keys = Array.from({ length: 500 }, (_, index) => `K${String(index).padStart(3, '0')}V`)
    for (const [index, id] of children.entries()) add(source, rect(id, index * 2, 0), 'root-1', keys[index]!)
    const wrap500: FileCommand = {
      type: 'node.wrap',
      groups: [{ wrapper: wrapper('wrap-500', { mode: 'freeform' }), parentId: 'root-1', children: children.map(nodeId => ({ nodeId, targetLayout: flow() })) }],
    }

    expect(validateFileCommand(wrap500)).toStrictEqual(wrap500)
    const result = applyFileCommandWithHistory(checked(source), wrap500, atoms)
    expect(result.file.revision).toBe(8)
    expect(order(result.file, 'root-1')).toStrictEqual(['wrap-500'])
    expect(order(result.file, 'wrap-500')).toStrictEqual(children)
    expect(result.undo).toMatchObject({ type: 'node.unwrap', groups: [{ wrapperId: 'wrap-500' }] })
    expect(validateFileCommand(result.undo)).toStrictEqual(result.undo)

    const expanded: FileCommand = {
      type: 'batch',
      commands: [
        { type: 'node.insert', node: wrapper('expanded-wrap', { mode: 'freeform' }), placement: { parentId: 'root-1' } },
        ...children.flatMap(nodeId => [
          { type: 'node.reparent', nodeId, placement: { parentId: 'expanded-wrap' } } as const,
          { type: 'node.setLayout', nodeId, layout: flow() } as const,
        ]),
      ],
    }
    expect(expanded.commands).toHaveLength(1001)
    expect(() => applyFileCommand(checked(source), expanded, atoms)).toThrow('Invalid command batch')
  })

  it('WRAP-12 rejects aggregate Wrap and Unwrap shapes above the document node limit', () => {
    const groupChildren = (prefix: string) => Array.from({ length: 3_000 }, (_, index) => ({ nodeId: `${prefix}-${index}`, targetLayout: flow() }))
    const wrapOverLimit = {
      type: 'node.wrap',
      groups: [
        { wrapper: wrapper('wrap-a', { mode: 'freeform' }), parentId: 'root-1', children: groupChildren('a') },
        { wrapper: wrapper('wrap-b', { mode: 'freeform' }), parentId: 'root-1', children: groupChildren('b') },
      ],
    }
    expect(() => validateFileCommand(wrapOverLimit)).toThrow('Invalid file command')

    const unwrapChildren = (prefix: string) => Array.from({ length: 3_000 }, (_, index) => ({ nodeId: `${prefix}-${index}`, relationship: { parentId: 'root-1', orderKey: 'V' }, layout: null }))
    const unwrapOverLimit = {
      type: 'node.unwrap',
      groups: [
        { wrapperId: 'wrap-a', children: unwrapChildren('a') },
        { wrapperId: 'wrap-b', children: unwrapChildren('b') },
      ],
    }
    expect(() => validateFileCommand(unwrapOverLimit)).toThrow('Invalid file command')
  })
})
