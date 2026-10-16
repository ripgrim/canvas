import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, validateFileCommand, validateFileDocument } from '../src/file-document.js'
import type { FileCommand, FileDocument, NodeTextProperties, NodeWrapGroup, PrimitiveNode } from '../src/file-document.js'
import type { NodeLayout } from '../src/layout.js'

const frame = (id: string): PrimitiveNode => ({ id, type: 'frame', name: id, styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 180, height: 120 } })
const rectangle = (id: string): PrimitiveNode => ({ id, type: 'rectangle', name: id, styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 80, height: 60 } })
const flow = (): NodeLayout => ({ item: { position: { mode: 'flow' } } })
const wrapper = (id: string): NodeWrapGroup['wrapper'] => ({
  ...frame(id),
  type: 'frame',
  styles: { ...frame(id).styles, overflow: 'visible' },
  layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' }, gap: 8 }, spacing: { padding: 0 } },
})
const textProperties = (fontSize: number, width: 'fixed' | 'fit', height: 'fixed' | 'fit'): NodeTextProperties => ({
  textStyle: { fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
  textSizing: { width: { mode: width }, height: { mode: height } },
})
const fixture = (node: PrimitiveNode): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'wrap-sizing-file',
  revision: 9,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' }, [node.id]: node },
  relationships: { [node.id]: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})
const withoutRevision = (file: FileDocument) => ({ ...file, revision: 0 })
const expectUnchanged = (actual: FileDocument, expected: FileDocument) => {
  expect(actual).toStrictEqual(expected)
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
}

describe('PAPER-FLEX-001/003 Wrap sizing authority', () => {
  it('applies and restores full primitive dimensions in the same Wrap history leaf', () => {
    const source = validateFileDocument(fixture(rectangle('box')), [])
    const command: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('wrap-box'), parentId: 'root-1', children: [{ nodeId: 'box', targetLayout: flow(), targetPrimitiveSize: { width: 132, height: 44 } }] }] }
    const projected = applyFileCommandWithHistory(source, command, [])

    expect((projected.file.nodes.box as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 20, 30], width: 132, height: 44 })
    expect(projected.undo).toStrictEqual({ type: 'node.unwrap', groups: [{ wrapperId: 'wrap-box', children: [{ nodeId: 'box', relationship: { parentId: 'root-1', orderKey: 'V' }, layout: null, restorePrimitiveSize: { width: 80, height: 60 } }] }] })
    const undone = applyFileCommand(projected.file, projected.undo, [])
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(source))
    const redone = applyFileCommand(undone, projected.redo, [])
    expect(JSON.stringify(withoutRevision(redone))).toBe(JSON.stringify(withoutRevision(projected.file)))

    const inverse = applyFileCommandWithHistory(projected.file, projected.undo, [])
    expect(inverse.undo).toMatchObject({ type: 'node.wrap', groups: [{ children: [{ nodeId: 'box', targetPrimitiveSize: { width: 132, height: 44 } }] }] })
    expect(JSON.stringify(withoutRevision(applyFileCommand(inverse.file, inverse.undo, [])))).toBe(JSON.stringify(withoutRevision(projected.file)))
  })

  it('applies and restores full textStyle and textSizing in the same Wrap history leaf', () => {
    const original = textProperties(16, 'fixed', 'fixed')
    const target = textProperties(24, 'fit', 'fit')
    const text: PrimitiveNode = { id: 'text', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 180, height: 40 }, text: 'Paper', ...original }
    const source = validateFileDocument(fixture(text), [])
    const command: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('wrap-text'), parentId: 'root-1', children: [{ nodeId: 'text', targetLayout: flow(), targetTextProperties: target }] }] }
    const projected = applyFileCommandWithHistory(source, command, [])

    expect(projected.file.nodes.text).toMatchObject(target)
    expect(projected.undo).toStrictEqual({ type: 'node.unwrap', groups: [{ wrapperId: 'wrap-text', children: [{ nodeId: 'text', relationship: { parentId: 'root-1', orderKey: 'V' }, layout: null, restoreTextProperties: original }] }] })
    const undone = applyFileCommand(projected.file, projected.undo, [])
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(source))
    const redone = applyFileCommand(undone, projected.redo, [])
    expect(JSON.stringify(withoutRevision(redone))).toBe(JSON.stringify(withoutRevision(projected.file)))

    const inverse = applyFileCommandWithHistory(projected.file, projected.undo, [])
    expect(inverse.undo).toMatchObject({ type: 'node.wrap', groups: [{ children: [{ nodeId: 'text', targetTextProperties: target }] }] })
    expect(JSON.stringify(withoutRevision(applyFileCommand(inverse.file, inverse.undo, [])))).toBe(JSON.stringify(withoutRevision(projected.file)))
  })

  it('atomically applies and restores text numeric geometry with full text properties through wrap, undo, and redo', () => {
    const original = textProperties(16, 'fixed', 'fixed')
    const target = textProperties(24, 'fit', 'fit')
    const text: PrimitiveNode = { id: 'text-both', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 180, height: 40 }, text: 'Paper', ...original }
    const source = validateFileDocument(fixture(text), [])
    const command: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('wrap-text-both'), parentId: 'root-1', children: [{ nodeId: 'text-both', targetLayout: flow(), targetPrimitiveSize: { width: 172, height: 42 }, targetTextProperties: target }] }] }
    const projected = applyFileCommandWithHistory(source, command, [])

    expect(projected.file.nodes['text-both']).toStrictEqual({
      id: 'text-both', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 172, height: 42 }, text: 'Paper', ...target,
      layout: { item: { position: { mode: 'flow' } } },
    })
    expect(projected.undo).toStrictEqual({ type: 'node.unwrap', groups: [{ wrapperId: 'wrap-text-both', children: [{
      nodeId: 'text-both', relationship: { parentId: 'root-1', orderKey: 'V' }, layout: null,
      restorePrimitiveSize: { width: 180, height: 40 }, restoreTextProperties: original,
    }] }] })

    const undone = applyFileCommand(projected.file, projected.undo, [])
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(source))
    const redone = applyFileCommand(undone, projected.redo, [])
    expect(JSON.stringify(withoutRevision(redone))).toBe(JSON.stringify(withoutRevision(projected.file)))

    const inverse = applyFileCommandWithHistory(projected.file, projected.undo, [])
    expect(inverse.undo).toStrictEqual({ type: 'node.wrap', groups: [{
      wrapper: { ...wrapper('wrap-text-both'), themeMode: 'inherit' }, parentId: 'root-1',
      children: [{
        nodeId: 'text-both', targetLayout: flow(), targetPrimitiveSize: { width: 172, height: 42 },
        targetTextProperties: target,
      }],
    }] })
    expect(JSON.stringify(withoutRevision(applyFileCommand(inverse.file, inverse.undo, [])))).toBe(JSON.stringify(withoutRevision(projected.file)))
  })

  it('allows a text Wrap to carry only numeric fallback geometry', () => {
    const original = textProperties(16, 'fixed', 'fixed')
    const text: PrimitiveNode = { id: 'text-size', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 180, height: 40 }, text: 'Paper', ...original }
    const source = validateFileDocument(fixture(text), [])
    const command: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('wrap-text-size'), parentId: 'root-1', children: [{ nodeId: 'text-size', targetLayout: flow(), targetPrimitiveSize: { width: 144, height: 36 } }] }] }
    const projected = applyFileCommandWithHistory(source, command, [])

    expect((projected.file.nodes['text-size'] as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 20, 30], width: 144, height: 36 })
    expect(projected.file.nodes['text-size']).toMatchObject(original)
    expect(projected.undo).toStrictEqual({ type: 'node.unwrap', groups: [{ wrapperId: 'wrap-text-size', children: [{ nodeId: 'text-size', relationship: { parentId: 'root-1', orderKey: 'V' }, layout: null, restorePrimitiveSize: { width: 180, height: 40 } }] }] })
    expect(withoutRevision(applyFileCommand(projected.file, projected.undo, []))).toStrictEqual(withoutRevision(source))
  })

  it('leaves primitive and text sizing byte-identical when the optional sizing target is absent', () => {
    const originalText = textProperties(16, 'fixed', 'fixed')
    const cases: PrimitiveNode[] = [
      rectangle('box'),
      { id: 'text', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 180, height: 40 }, text: 'Paper', ...originalText },
    ]
    for (const node of cases) {
      const source = validateFileDocument(fixture(node), [])
      const beforeSizing = node.type === 'text'
        ? JSON.stringify({ textStyle: node.textStyle, textSizing: node.textSizing, styles: node.styles })
        : JSON.stringify(node.styles)
      const result = applyFileCommand(source, { type: 'node.wrap', groups: [{ wrapper: wrapper(`wrap-${node.id}`), parentId: 'root-1', children: [{ nodeId: node.id, targetLayout: flow() }] }] }, [])
      const changed = result.nodes[node.id] as PrimitiveNode
      const afterSizing = changed.type === 'text'
        ? JSON.stringify({ textStyle: changed.textStyle, textSizing: changed.textSizing, styles: changed.styles })
        : JSON.stringify(changed.styles)
      expect(afterSizing).toBe(beforeSizing)
    }
  })

  it('rejects malformed and type-mismatched full targets before mutating the file', () => {
    const primitiveSource = validateFileDocument(fixture(rectangle('box')), [])
    const text = { id: 'text', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 180, height: 40 }, text: 'Paper', ...textProperties(16, 'fixed', 'fixed') } satisfies PrimitiveNode
    const textSource = validateFileDocument(fixture(text), [])
    const validTextTarget = textProperties(24, 'fit', 'fit')
    const malformedShapes: unknown[] = [
      { type: 'node.wrap', groups: [{ wrapper: wrapper('wrap'), parentId: 'root-1', children: [{ nodeId: 'box', targetLayout: flow(), targetPrimitiveSize: { width: 10 } }] }] },
      { type: 'node.wrap', groups: [{ wrapper: wrapper('wrap'), parentId: 'root-1', children: [{ nodeId: 'text', targetLayout: flow(), targetTextProperties: { ...validTextTarget, textStyle: { ...validTextTarget.textStyle, maxLines: 2 }, textSizing: { width: { mode: 'fit' }, height: { mode: 'fixed' } } } }] }] },
    ]
    for (const command of malformedShapes) expect(() => validateFileCommand(command)).toThrow('Invalid file command')

    for (const command of malformedShapes) {
      const before = structuredClone(primitiveSource)
      expect(() => applyFileCommand(primitiveSource, command as FileCommand, [])).toThrow('Invalid Wrap group')
      expectUnchanged(primitiveSource, before)
    }

    const primitiveWithText: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('primitive-text-wrap'), parentId: 'root-1', children: [{ nodeId: 'box', targetLayout: flow(), targetTextProperties: validTextTarget }] }] }
    const primitiveBefore = structuredClone(primitiveSource)
    expect(() => applyFileCommand(primitiveSource, primitiveWithText, [])).toThrow('Primitive Wrap sizing must use primitive dimensions')
    expectUnchanged(primitiveSource, primitiveBefore)

    const wrapped = applyFileCommand(primitiveSource, { type: 'node.wrap', groups: [{ wrapper: wrapper('unwrap-type-wrap'), parentId: 'root-1', children: [{ nodeId: 'box', targetLayout: flow() }] }] }, [])
    const mismatchedUnwrap: FileCommand = { type: 'node.unwrap', groups: [{ wrapperId: 'unwrap-type-wrap', children: [{ nodeId: 'box', relationship: { parentId: 'root-1', orderKey: 'V' }, layout: null, restoreTextProperties: validTextTarget }] }] }
    const wrappedBefore = structuredClone(wrapped)
    expect(() => applyFileCommand(wrapped, mismatchedUnwrap, [])).toThrow('Primitive Unwrap sizing must use primitive dimensions')
    expectUnchanged(wrapped, wrappedBefore)

    const malformedUnwraps = [
      { type: 'node.unwrap', groups: [{ wrapperId: 'unwrap-type-wrap', children: [{ nodeId: 'box', relationship: { parentId: 'root-1', orderKey: 'V' }, layout: null, restorePrimitiveSize: { width: 80 } }] }] },
    ]
    for (const command of malformedUnwraps) {
      const before = structuredClone(wrapped)
      expect(() => applyFileCommand(wrapped, command as FileCommand, [])).toThrow('Unwrap groups cannot overlap')
      expectUnchanged(wrapped, before)
    }

    const primitiveWithBoth: FileCommand = { type: 'node.wrap', groups: [{ wrapper: wrapper('primitive-both-wrap'), parentId: 'root-1', children: [{ nodeId: 'box', targetLayout: flow(), targetPrimitiveSize: { width: 70, height: 50 }, targetTextProperties: validTextTarget }] }] }
    const bothBefore = structuredClone(primitiveSource)
    expect(() => applyFileCommand(primitiveSource, primitiveWithBoth, [])).toThrow('Primitive Wrap sizing must use primitive dimensions')
    expectUnchanged(primitiveSource, bothBefore)
  })

  it('prevalidates every group before a failed Wrap or Unwrap can mutate any byte', () => {
    const first = rectangle('first')
    const second = { ...rectangle('second'), styles: { relativeTransform: [1, 0, 0, 1, 120, 30], width: 70, height: 50 } }
    const source = validateFileDocument({
      ...fixture(first),
      nodes: { 'root-1': { id: 'root-1', type: 'root' }, first, second },
      relationships: { first: { parentId: 'root-1', orderKey: 'V' }, second: { parentId: 'root-1', orderKey: 'k' } },
    }, [])
    const invalidWrap: FileCommand = { type: 'node.wrap', groups: [
      { wrapper: wrapper('wrap-first'), parentId: 'root-1', children: [{ nodeId: 'first', targetLayout: flow(), targetPrimitiveSize: { width: 81, height: 61 } }] },
      { wrapper: wrapper('wrap-second'), parentId: 'root-1', children: [{ nodeId: 'second', targetLayout: flow(), targetTextProperties: textProperties(20, 'fit', 'fit') }] },
    ] }
    const beforeWrap = structuredClone(source)
    expect(() => applyFileCommand(source, invalidWrap, [])).toThrow('Primitive Wrap sizing must use primitive dimensions')
    expectUnchanged(source, beforeWrap)

    const validWrap: FileCommand = { type: 'node.wrap', groups: [
      { wrapper: wrapper('wrap-first'), parentId: 'root-1', children: [{ nodeId: 'first', targetLayout: flow(), targetPrimitiveSize: { width: 81, height: 61 } }] },
      { wrapper: wrapper('wrap-second'), parentId: 'root-1', children: [{ nodeId: 'second', targetLayout: flow(), targetPrimitiveSize: { width: 71, height: 51 } }] },
    ] }
    const wrapped = applyFileCommandWithHistory(source, validWrap, [])
    const invalidUnwrap = structuredClone(wrapped.undo)
    if (invalidUnwrap.type !== 'node.unwrap') throw new Error('Expected an Unwrap inverse')
    invalidUnwrap.groups[1]!.children[0]!.restoreTextProperties = textProperties(20, 'fit', 'fit')
    const beforeUnwrap = structuredClone(wrapped.file)
    expect(() => applyFileCommand(wrapped.file, invalidUnwrap, [])).toThrow('Primitive Unwrap sizing must use primitive dimensions')
    expectUnchanged(wrapped.file, beforeUnwrap)
  })
})
