import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, validateFileCommand } from '../src/file-document'
import type { FileCommand, FileDocument } from '../src/file-document'

const fixture = (): FileDocument => ({
  schemaVersion: 9,
  fileId: 'exact-reorder-history',
  revision: 12,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    a: { id: 'a', type: 'rectangle', name: 'A', styles: { left: 0, top: 0, width: 10, height: 10 } },
    b: { id: 'b', type: 'rectangle', name: 'B', styles: { left: 20, top: 0, width: 10, height: 10 } },
    c: { id: 'c', type: 'rectangle', name: 'C', styles: { left: 40, top: 0, width: 10, height: 10 } },
  },
  relationships: {
    a: { parentId: 'root', orderKey: 'A7' },
    b: { parentId: 'root', orderKey: 'mQ' },
    c: { parentId: 'root', orderKey: 'z9' },
  },
  theme: { tokens: {} },
})

const withoutRevision = (file: FileDocument) => ({ ...structuredClone(file), revision: 0 })

describe('exact relationship history for node reorder', () => {
  it('preserves literal non-regenerable order keys through undo and redo', () => {
    const source = fixture()
    const history = applyFileCommandWithHistory(source, { type: 'node.reorder', nodeId: 'a', index: 2 }, [])
    const moved = history.file.relationships.a!
    expect(moved.orderKey).not.toBe('A7')
    expect(history.undo).toStrictEqual({
      type: 'node.restoreRelationship', nodeId: 'a',
      expected: structuredClone(moved),
      source: { parentId: 'root', orderKey: 'A7' },
    })
    expect(history.redo).toStrictEqual({
      type: 'node.restoreRelationship', nodeId: 'a',
      expected: { parentId: 'root', orderKey: 'A7' },
      source: structuredClone(moved),
    })

    const undone = applyFileCommand(history.file, history.undo, [])
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(source))
    const redone = applyFileCommand(undone, history.redo, [])
    expect(withoutRevision(redone)).toStrictEqual(withoutRevision(history.file))
  })

  it('checks each restore in batch order and produces an exact batch inverse', () => {
    const source = fixture()
    const command: FileCommand = { type: 'batch', commands: [
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'H3' } },
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'H3' }, source: { parentId: 'root', orderKey: 'K5' } },
    ] }
    const history = applyFileCommandWithHistory(source, command, [])
    expect(history.file.relationships.a).toStrictEqual({ parentId: 'root', orderKey: 'K5' })
    expect(history.undo).toStrictEqual({ type: 'batch', commands: [
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'K5' }, source: { parentId: 'root', orderKey: 'H3' } },
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'H3' }, source: { parentId: 'root', orderKey: 'A7' } },
    ] })
    expect(withoutRevision(applyFileCommand(history.file, history.undo, []))).toStrictEqual(withoutRevision(source))
    expect(withoutRevision(applyFileCommand(source, history.redo, []))).toStrictEqual(withoutRevision(history.file))
  })

  it('fails closed for stale or missing relationships and never mutates the input', () => {
    const cases: FileCommand[] = [
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'wrong' }, source: { parentId: 'root', orderKey: 'H3' } },
      { type: 'node.restoreRelationship', nodeId: 'missing', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'H3' } },
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'a', orderKey: 'H3' } },
      { type: 'batch', commands: [
        { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'H3' } },
        { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'stale' }, source: { parentId: 'root', orderKey: 'K5' } },
      ] },
    ]
    for (const command of cases) {
      const source = fixture()
      const before = structuredClone(source)
      expect(() => applyFileCommand(source, command, [])).toThrow()
      expect(source).toStrictEqual(before)
    }
  })

  it('rejects a root target and an existing detached node without mutating either file', () => {
    const rootSource = fixture()
    const rootBefore = structuredClone(rootSource)
    const rootCommand: FileCommand = { type: 'node.restoreRelationship', nodeId: 'root', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'H3' } }
    expect(() => applyFileCommand(rootSource, rootCommand, [])).toThrow('History relationship is stale')
    expect(rootSource).toStrictEqual(rootBefore)

    const detachedSource = fixture()
    delete detachedSource.relationships.a
    const detachedBefore = structuredClone(detachedSource)
    const detachedCommand: FileCommand = { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'H3' } }
    expect(() => applyFileCommand(detachedSource, detachedCommand, [])).toThrow('A node has no parent')
    expect(detachedSource).toStrictEqual(detachedBefore)
  })

  it('rejects descendant, incompatible parent, and incompatible slot destinations', () => {
    const descendant = fixture()
    descendant.nodes.a = { id: 'a', type: 'frame', name: 'A', styles: { left: 0, top: 0, width: 10, height: 10 } }
    descendant.nodes.child = { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 1, top: 1, width: 5, height: 5 } }
    descendant.relationships.child = { parentId: 'a', orderKey: 'Q7' }
    const descendantBefore = structuredClone(descendant)
    expect(() => applyFileCommand(descendant, {
      type: 'node.restoreRelationship', nodeId: 'a',
      expected: { parentId: 'root', orderKey: 'A7' },
      source: { parentId: 'child', orderKey: 'H3' },
    }, [])).toThrow('History relationship is invalid')
    expect(descendant).toStrictEqual(descendantBefore)

    const incompatibleParent = fixture()
    const incompatibleParentBefore = structuredClone(incompatibleParent)
    expect(() => applyFileCommand(incompatibleParent, {
      type: 'node.restoreRelationship', nodeId: 'a',
      expected: { parentId: 'root', orderKey: 'A7' },
      source: { parentId: 'b', orderKey: 'H3' },
    }, [])).toThrow('History relationship is invalid')
    expect(incompatibleParent).toStrictEqual(incompatibleParentBefore)

    const incompatibleSlot = fixture()
    const incompatibleSlotBefore = structuredClone(incompatibleSlot)
    expect(() => applyFileCommand(incompatibleSlot, {
      type: 'node.restoreRelationship', nodeId: 'a',
      expected: { parentId: 'root', orderKey: 'A7' },
      source: { parentId: 'root', orderKey: 'H3', slot: 'children' },
    }, [])).toThrow('History relationship is invalid')
    expect(incompatibleSlot).toStrictEqual(incompatibleSlotBefore)
  })

  it('keeps both the exact input document and command immutable on success and failure', () => {
    const successFile = fixture()
    const successFileBefore = structuredClone(successFile)
    const successCommand: FileCommand = {
      type: 'node.restoreRelationship', nodeId: 'a',
      expected: { parentId: 'root', orderKey: 'A7' },
      source: { parentId: 'root', orderKey: 'H3' },
    }
    const successCommandBefore = structuredClone(successCommand)
    const result = applyFileCommand(successFile, successCommand, [])
    expect(result.relationships.a).toStrictEqual({ parentId: 'root', orderKey: 'H3' })
    expect(successFile).toStrictEqual(successFileBefore)
    expect(successCommand).toStrictEqual(successCommandBefore)

    const failureFile = fixture()
    const failureFileBefore = structuredClone(failureFile)
    const failureCommand: FileCommand = {
      type: 'node.restoreRelationship', nodeId: 'a',
      expected: { parentId: 'root', orderKey: 'H3' },
      source: { parentId: 'root', orderKey: 'K5' },
    }
    const failureCommandBefore = structuredClone(failureCommand)
    expect(() => applyFileCommand(failureFile, failureCommand, [])).toThrow('History relationship is stale')
    expect(failureFile).toStrictEqual(failureFileBefore)
    expect(failureCommand).toStrictEqual(failureCommandBefore)
  })

  it('keeps a late stale history batch atomic and leaves its exact inputs untouched', () => {
    const source = fixture()
    const sourceBefore = structuredClone(source)
    const command: FileCommand = { type: 'batch', commands: [
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'H3' } },
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'K5' } },
    ] }
    const commandBefore = structuredClone(command)
    expect(() => applyFileCommandWithHistory(source, command, [])).toThrow('History relationship is stale')
    expect(source).toStrictEqual(sourceBefore)
    expect(command).toStrictEqual(commandBefore)
  })

  it('rejects malformed relationship commands at the closed validator boundary', () => {
    const valid = { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'root', orderKey: 'A7' }, source: { parentId: 'root', orderKey: 'H3' } }
    expect(validateFileCommand(valid)).toStrictEqual(valid)
    const malformed = [
      { ...valid, extra: true },
      { ...valid, expected: { ...valid.expected, extra: true } },
      { ...valid, expected: { parentId: 'root', orderKey: 'A0' } },
      { ...valid, source: { parentId: 'root' } },
      { ...valid, source: { parentId: 'root', orderKey: 'H3', slot: '__proto__' } },
    ]
    for (const command of malformed) expect(() => validateFileCommand(command)).toThrow('Invalid file command')
  })
})
