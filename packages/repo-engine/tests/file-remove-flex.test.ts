import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, validateFileCommand, validateFileDocument } from '../src/file-document.js'
import type { ComponentNode, FileCommand, FileDocument, NodeFlexState, NodeRemoveFlexGroup, NodeTextProperties, PrimitiveNode } from '../src/file-document.js'
import type { NodeLayout } from '../src/layout.js'
import type { Atom } from '../src/types.js'

const flex = (direction: 'row' | 'column' = 'row') => ({ direction, wrap: 'nowrap', justify: 'start', align: 'start' } as const)
const textProperties = (fontSize: number, width: 'fixed' | 'fit', height: 'fixed' | 'fit'): NodeTextProperties => ({
  textStyle: { fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
  textSizing: { width: { mode: width }, height: { mode: height } },
})
const absolute = (left: number, top: number): NodeLayout => ({ item: { position: { mode: 'absolute', left: { kind: 'px', value: left }, top: { kind: 'px', value: top } } } })
const withoutRevision = (file: FileDocument): FileDocument => ({ ...file, revision: 0 })
const expectBytes = (actual: unknown, expected: unknown) => expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
const expectUnchanged = (actual: FileDocument, expected: FileDocument) => { expect(actual).toStrictEqual(expected); expectBytes(actual, expected) }

const originalText = textProperties(16, 'fixed', 'fixed')
const removedText = textProperties(22, 'fit', 'fit')

function frameFixture(): FileDocument {
  const outer: PrimitiveNode = {
    id: 'outer', type: 'frame', name: 'Outer', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 800, height: 600 },
    layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: flex('column') } },
  }
  const parent: PrimitiveNode = {
    id: 'parent', type: 'frame', name: 'Parent', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 300, height: 200, overflow: 'clip' },
    layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: flex(), gap: { x: 12, y: 8 } }, spacing: { padding: 16, margin: { x: 4, y: 6 } } },
  }
  const rectangle: PrimitiveNode = { id: 'rectangle', type: 'rectangle', name: 'Rectangle', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 40 }, layout: { item: { position: { mode: 'flow' }, flex: { grow: 1 } } } }
  const existingAbsolute: PrimitiveNode = { id: 'existing-absolute', type: 'shape', name: 'Absolute', styles: { relativeTransform: [1, 0, 0, 1, 300, -40], width: 20, height: 20 }, layout: absolute(300, -40) }
  const text: PrimitiveNode = { id: 'text', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 140, height: 32 }, layout: { item: { position: { mode: 'flow' }, flex: { shrink: 0 } } }, text: 'Paper', ...originalText }
  return validateFileDocument({
    schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'remove-flex-frame', revision: 7,
    pages: [{ id: 'page', name: 'Page 1', rootNodeId: 'root' }],
    nodes: { root: { id: 'root', type: 'root' }, outer, parent, rectangle, 'existing-absolute': existingAbsolute, text },
    relationships: {
      outer: { parentId: 'root', orderKey: 'V' },
      parent: { parentId: 'outer', orderKey: 'V' },
      rectangle: { parentId: 'parent', orderKey: 'V' },
      'existing-absolute': { parentId: 'parent', orderKey: 'b' },
      text: { parentId: 'parent', orderKey: 'k' },
    },
    theme: { tokens: {} },
  }, [])
}

function frameRemoveGroup(): NodeRemoveFlexGroup {
  return {
    parent: {
      nodeId: 'parent', relationship: { parentId: 'outer', orderKey: 'V' }, primitiveSize: { width: 268, height: 164 },
      layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'intrinsic', value: 'fit-content' } } }, container: { display: 'freeform' }, spacing: { padding: 16, margin: { x: 4, y: 6 } } },
    },
    children: [
      { nodeId: 'rectangle', relationship: { parentId: 'parent', orderKey: 'V' }, layout: absolute(16, -60), primitiveSize: { width: 96, height: 44 } },
      { nodeId: 'text', relationship: { parentId: 'parent', orderKey: 'k' }, layout: absolute(628, 24), primitiveSize: { width: 156, height: 36 }, textProperties: removedText },
    ],
  }
}

const parentAtom: Atom = { componentId: 'component-parent', path: 'Parent.tsx', exportName: 'Parent', fingerprint: 'parent', sourceHash: 'parent', status: 'bound', candidates: [], name: 'Parent', kind: 'atom', props: [{ name: 'content', type: 'ReactNode', optional: true }], slots: ['content'] }
const childAtom: Atom = { componentId: 'component-child', path: 'Child.tsx', exportName: 'Child', fingerprint: 'child', sourceHash: 'child', status: 'bound', candidates: [], name: 'Child', kind: 'atom', props: [] }
const atoms = [parentAtom, childAtom]

function componentFixture(empty = false): FileDocument {
  const parent: ComponentNode = {
    id: 'component-parent-node', type: 'component', componentId: parentAtom.componentId, exportName: parentAtom.exportName, props: {},
    layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 40 }, top: { kind: 'px', value: 60 } } }, container: { display: 'flex', overflow: 'visible', flex: flex('column'), gap: 10 }, spacing: { padding: 12, margin: 3 } },
  }
  const child: ComponentNode = { id: 'component-child-node', type: 'component', componentId: childAtom.componentId, exportName: childAtom.exportName, props: {}, layout: { item: { position: { mode: 'flow' } } } }
  const nodes: FileDocument['nodes'] = { root: { id: 'root', type: 'root' }, 'component-parent-node': parent }
  const relationships: FileDocument['relationships'] = { 'component-parent-node': { parentId: 'root', orderKey: 'V' } }
  if (!empty) {
    nodes['component-child-node'] = child
    relationships['component-child-node'] = { parentId: 'component-parent-node', slot: 'content', orderKey: 'V' }
  }
  return validateFileDocument({ schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: empty ? 'empty-component-flex' : 'component-flex', revision: 2, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }], nodes, relationships, theme: { tokens: {} } }, atoms)
}

function componentRemoveGroup(empty = false): NodeRemoveFlexGroup {
  return {
    parent: {
      nodeId: 'component-parent-node', relationship: { parentId: 'root', orderKey: 'V' },
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 40 }, top: { kind: 'px', value: 60 } } }, container: { display: 'freeform', overflow: 'visible' }, spacing: { padding: 12, margin: 3 } },
    },
    children: empty ? [] : [{ nodeId: 'component-child-node', relationship: { parentId: 'component-parent-node', slot: 'content', orderKey: 'V' }, layout: absolute(-18, 720) }],
  }
}

describe('PAPER-FLEX-001/003/008 Remove Flex repository command', () => {
  it('removes Frame Flex atomically while preserving mixed sibling order, base spacing, overflow, and untouched absolute bytes', () => {
    const source = frameFixture()
    const sourceBytes = JSON.stringify(source)
    const absoluteBefore = structuredClone(source.nodes['existing-absolute'])
    const absoluteRelationshipBefore = structuredClone(source.relationships['existing-absolute'])
    const command: FileCommand = { type: 'node.removeFlex', groups: [frameRemoveGroup()] }
    const history = applyFileCommandWithHistory(source, command, [])

    expect(JSON.stringify(source)).toBe(sourceBytes)
    expect(history.file.revision).toBe(8)
    expect(history.file.nodes.parent).toStrictEqual({
      ...(source.nodes.parent as PrimitiveNode),
      styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 268, height: 164, overflow: 'clip' },
      layout: frameRemoveGroup().parent.layout,
    })
    expect(history.file.relationships).toStrictEqual(source.relationships)
    expect(history.file.nodes.rectangle).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 96, height: 44 }, layout: absolute(16, -60) })
    expect(history.file.nodes.text).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 156, height: 36 }, layout: absolute(628, 24), ...removedText })
    expectBytes(history.file.nodes['existing-absolute'], absoluteBefore)
    expectBytes(history.file.relationships['existing-absolute'], absoluteRelationshipBefore)
    expect(() => validateFileDocument(history.file, [])).not.toThrow()

    expect(history.undo.type).toBe('node.restoreFlex')
    const undone = applyFileCommand(history.file, history.undo, [])
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(source))
    expectBytes(withoutRevision(undone), withoutRevision(source))
    const redone = applyFileCommand(undone, history.redo, [])
    expect(withoutRevision(redone)).toStrictEqual(withoutRevision(history.file))
    expectBytes(withoutRevision(redone), withoutRevision(history.file))

    const restoreHistory = applyFileCommandWithHistory(history.file, history.undo, [])
    expect(restoreHistory.undo).toStrictEqual(command)
    expect(withoutRevision(applyFileCommand(restoreHistory.file, restoreHistory.undo, []))).toStrictEqual(withoutRevision(history.file))
  })

  it('supports Component parents, slot-preserving children, and empty Flex parents', () => {
    const populated = componentFixture()
    const populatedHistory = applyFileCommandWithHistory(populated, { type: 'node.removeFlex', groups: [componentRemoveGroup()] }, atoms)
    expect(populatedHistory.file.nodes['component-parent-node']).toMatchObject({ layout: componentRemoveGroup().parent.layout })
    expect(populatedHistory.file.nodes['component-child-node']).toMatchObject({ layout: absolute(-18, 720) })
    expect(populatedHistory.file.relationships['component-child-node']).toStrictEqual({ parentId: 'component-parent-node', slot: 'content', orderKey: 'V' })
    expect(withoutRevision(applyFileCommand(populatedHistory.file, populatedHistory.undo, atoms))).toStrictEqual(withoutRevision(populated))

    const empty = componentFixture(true)
    const emptyHistory = applyFileCommandWithHistory(empty, { type: 'node.removeFlex', groups: [componentRemoveGroup(true)] }, atoms)
    expect(emptyHistory.file.nodes['component-parent-node']).toMatchObject({ layout: componentRemoveGroup(true).parent.layout })
    expect(emptyHistory.undo).toMatchObject({ type: 'node.restoreFlex', groups: [{ expected: { children: [] }, source: { children: [] } }] })
    expect(withoutRevision(applyFileCommand(emptyHistory.file, emptyHistory.undo, atoms))).toStrictEqual(withoutRevision(empty))
  })

  it('keeps omitted sizing authorities byte-identical and rejects type-confused authorities', () => {
    const source = frameFixture()
    const group = frameRemoveGroup()
    delete group.parent.primitiveSize
    delete group.children[0]!.primitiveSize
    delete group.children[1]!.primitiveSize
    delete group.children[1]!.textProperties
    const result = applyFileCommand(source, { type: 'node.removeFlex', groups: [group] }, [])
    expect((result.nodes.parent as PrimitiveNode).styles).toStrictEqual((source.nodes.parent as PrimitiveNode).styles)
    expect((result.nodes.rectangle as PrimitiveNode).styles).toStrictEqual((source.nodes.rectangle as PrimitiveNode).styles)
    expect(result.nodes.text).toMatchObject(originalText)

    const wrongComponent = componentRemoveGroup()
    wrongComponent.parent.primitiveSize = { width: 10, height: 10 }
    const before = structuredClone(componentFixture())
    expect(() => applyFileCommand(before, { type: 'node.removeFlex', groups: [wrongComponent] }, atoms)).toThrow('Component Remove Flex state cannot carry primitive or text sizing')
    expectUnchanged(before, componentFixture())

    const wrongText = frameRemoveGroup()
    wrongText.children[0]!.textProperties = removedText
    const frameBefore = frameFixture()
    expect(() => applyFileCommand(frameBefore, { type: 'node.removeFlex', groups: [wrongText] }, [])).toThrow('Only text Remove Flex state can carry text properties')
    expectUnchanged(frameBefore, frameFixture())
  })

  it('rejects malformed, stale, duplicate, nested, overlapping, and unknown state before changing any input byte', () => {
    const mutations: Array<{ mutate: (group: NodeRemoveFlexGroup) => void; message: string }> = [
      { mutate: group => { group.children.pop() }, message: 'every direct flow child' },
      { mutate: group => { group.children.reverse() }, message: 'source order' },
      { mutate: group => { group.children[0]!.relationship.orderKey = 'z' }, message: 'relationship and order' },
      { mutate: group => { group.children[0]!.layout = { item: { position: { mode: 'absolute', top: { kind: 'px', value: 0 } } } } }, message: 'pixel leading insets' },
      { mutate: group => { group.parent.layout = { ...group.parent.layout!, spacing: { padding: 0, margin: { x: 4, y: 6 } } } }, message: 'preserve parent spacing' },
      { mutate: group => { group.parent.layout = { ...group.parent.layout!, container: { display: 'block' } } }, message: 'freeform parent target' },
    ]
    for (const mutation of mutations) {
      const source = frameFixture(), before = structuredClone(source), group = frameRemoveGroup()
      mutation.mutate(group)
      expect(() => applyFileCommand(source, { type: 'node.removeFlex', groups: [group] }, [])).toThrow(mutation.message)
      expectUnchanged(source, before)
    }

    const duplicateSource = frameFixture(), duplicateBefore = structuredClone(duplicateSource)
    expect(() => applyFileCommand(duplicateSource, { type: 'node.removeFlex', groups: [frameRemoveGroup(), frameRemoveGroup()] }, [])).toThrow('cannot overlap')
    expectUnchanged(duplicateSource, duplicateBefore)

    const duplicateChildSource = frameFixture(), duplicateChildBefore = structuredClone(duplicateChildSource), duplicateChildGroup = frameRemoveGroup()
    duplicateChildGroup.children.push(structuredClone(duplicateChildGroup.children[0]!))
    expect(() => applyFileCommand(duplicateChildSource, { type: 'node.removeFlex', groups: [duplicateChildGroup] }, [])).toThrow('cannot overlap')
    expectUnchanged(duplicateChildSource, duplicateChildBefore)

    const nestedSource = frameFixture(), nestedBefore = structuredClone(nestedSource), nestedChild = structuredClone(frameRemoveGroup().children[0]!)
    expect(() => applyFileCommand(nestedSource, { type: 'node.removeFlex', groups: [frameRemoveGroup(), { parent: nestedChild, children: [] }] }, [])).toThrow('cannot contain one another')
    expectUnchanged(nestedSource, nestedBefore)

    const wrongKind = frameFixture()
    const wrongKindGroup = frameRemoveGroup()
    wrongKindGroup.parent = { ...wrongKindGroup.parent, nodeId: 'existing-absolute', relationship: { parentId: 'parent', orderKey: 'b' } }
    expect(() => applyFileCommand(wrongKind, { type: 'node.removeFlex', groups: [wrongKindGroup] }, [])).toThrow('Frame or Component Flex parent')

    const unknownCommand = { type: 'node.removeFlex', groups: [frameRemoveGroup()], extra: true }
    const unknownGroup = { type: 'node.removeFlex', groups: [{ ...frameRemoveGroup(), extra: true }] }
    const unknownState = { type: 'node.removeFlex', groups: [{ ...frameRemoveGroup(), parent: { ...frameRemoveGroup().parent, extra: true } }] }
    for (const command of [unknownCommand, unknownGroup, unknownState]) expect(() => validateFileCommand(command)).toThrow('Invalid file command')
  })

  it('prevalidates every group and rejects a stale Restore expectation without mutating source or command', () => {
    const source = frameFixture(), sourceBefore = structuredClone(source)
    const first = frameRemoveGroup()
    const second: NodeRemoveFlexGroup = { parent: { nodeId: 'missing-parent', relationship: { parentId: 'root', orderKey: 'V' }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'freeform' } } }, children: [] }
    const command = { type: 'node.removeFlex', groups: [first, second] } as FileCommand
    const commandBytes = JSON.stringify(command)
    expect(() => applyFileCommand(source, command, [])).toThrow('Frame or Component Flex parent')
    expectUnchanged(source, sourceBefore)
    expect(JSON.stringify(command)).toBe(commandBytes)

    const history = applyFileCommandWithHistory(source, { type: 'node.removeFlex', groups: [frameRemoveGroup()] }, [])
    if (history.undo.type !== 'node.restoreFlex') throw new Error('Expected Restore Flex inverse')
    const stale = structuredClone(history.undo)
    stale.groups[0]!.expected.children[0]!.layout = absolute(17, -60)
    const removedBefore = structuredClone(history.file)
    expect(() => applyFileCommand(history.file, stale, [])).toThrow('expected state does not match')
    expectUnchanged(history.file, removedBefore)
  })

  it('bounds nonempty groups and aggregate children before detailed traversal', () => {
    expect(() => validateFileCommand({ type: 'node.removeFlex', groups: [] })).toThrow('Invalid file command')
    const group = componentRemoveGroup(true)
    const tooManyGroups = Array.from({ length: 5001 }, () => group)
    expect(() => validateFileCommand({ type: 'node.removeFlex', groups: tooManyGroups })).toThrow('Invalid file command')

    const child: NodeFlexState = { nodeId: 'child', relationship: { parentId: 'component-parent-node', slot: 'content', orderKey: 'V' }, layout: absolute(0, 0) }
    const tooManyChildren = { ...group, children: Array.from({ length: 5001 }, (_, index) => ({ ...child, nodeId: `child-${index}` })) }
    expect(() => validateFileCommand({ type: 'node.removeFlex', groups: [tooManyChildren] })).toThrow('Invalid file command')
  })
})
