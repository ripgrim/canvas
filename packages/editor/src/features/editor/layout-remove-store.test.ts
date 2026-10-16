import { describe, expect, it } from 'vitest'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import type { LayoutGeometry } from './layout-measure'
import { createDocumentStore } from './document-store'
import { paperRemoveFlexCopy } from './layout-remove-planner'

const px = (value: number) => ({ kind: 'px' as const, value })
const withoutRevision = (file: FileDocument) => ({ ...structuredClone(file), revision: 0 })

function fixture(): { file: FileDocument; geometry: LayoutGeometry } {
  const parent: PrimitiveNode = {
    id: 'parent', type: 'frame', name: 'Parent', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 200, height: 100, overflow: 'clip' },
    layout: {
      item: { position: { mode: 'absolute', left: px(20), top: px(30) }, width: { value: { kind: 'intrinsic', value: 'fit-content' } } },
      container: { display: 'flex', gap: 10, flex: { direction: 'row', wrap: 'nowrap', justify: 'center', align: 'end' } },
      spacing: { padding: 12 },
    },
  }
  const child: PrimitiveNode = {
    id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 20 },
    layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 100 } } } },
  }
  const absolute: PrimitiveNode = {
    id: 'absolute', type: 'shape', name: 'Absolute', styles: { relativeTransform: [1, 0, 0, 1, 140, 60], width: 30, height: 20 },
    layout: { item: { position: { mode: 'absolute', left: px(140), top: px(60) } } },
  }
  const file: FileDocument = {
    schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'remove-store', revision: 0, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: { root: { id: 'root', type: 'root' }, parent, child, absolute },
    relationships: { parent: { parentId: 'root', orderKey: 'V' }, absolute: { parentId: 'parent', orderKey: 'W' }, child: { parentId: 'parent', orderKey: 'V' } },
    theme: { tokens: {} },
  }
  const geometry: LayoutGeometry = {
    documentRevision: 0, layoutGeneration: 0, unsupported: {}, nodes: {
      parent: {
        canvasKind: 'frame', documentRevision: 0, layoutGeneration: 0, rect: { x: 20, y: 30, width: 240, height: 100 },
        offset: { x: 20, y: 30, width: 240, height: 100, origin: { x: 120, y: 50 } },
        box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 12, right: 12, bottom: 12, left: 12 } },
        offsetParentNodeId: null, directChild: true,
      },
      child: {
        canvasKind: 'rectangle', documentRevision: 0, layoutGeneration: 0, rect: { x: -8, y: 14, width: 120, height: 20 },
        offset: { x: -8, y: 14, width: 120, height: 20, origin: { x: 60, y: 10 } },
        offsetParentNodeId: 'parent', directChild: true,
      },
    },
  }
  return { file, geometry }
}

describe('Paper Remove Flex document-store seam', () => {
  it('PAPER-FLEX-001/003 AT-DOC-002/003 writes one command, publishes once, preserves selection, and round-trips one history entry', () => {
    const store = createDocumentStore(() => 'unused')
    const publications: FileDocument[] = []
    store.configure({ onChange: file => publications.push(structuredClone(file)) })
    const { file, geometry } = fixture()
    store.load(file, [])
    store.selectMany(['parent'])

    expect(store.commands.layout.removeFlexSelection(geometry, ['parent'])).toStrictEqual({ status: 'written', parentIds: ['parent'] })
    const removed = structuredClone(store.getSnapshot().file!)
    expect(publications).toHaveLength(1)
    expect(removed.revision).toBe(1)
    expect(store.getSnapshot().selection).toStrictEqual(['parent'])
    expect(store.getHistory()).toMatchObject({
      past: [{
        selection: ['parent'], afterSelection: ['parent'],
        redo: { type: 'node.removeFlex', groups: [{ parent: { nodeId: 'parent' }, children: [{ nodeId: 'child' }] }] },
        undo: { type: 'node.restoreFlex', groups: [{ expected: { parent: { nodeId: 'parent' } }, source: { parent: { nodeId: 'parent' } } }] },
      }],
      future: [],
    })
    expect((removed.nodes.parent as PrimitiveNode).layout).toStrictEqual({
      item: { position: { mode: 'absolute', left: px(20), top: px(30) } },
      container: { display: 'freeform' }, spacing: { padding: 12 },
    })
    expect((removed.nodes.parent as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 20, 30], width: 240, height: 100, overflow: 'clip' })
    expect((removed.nodes.child as PrimitiveNode).layout).toStrictEqual({ item: { position: { mode: 'absolute', left: px(-8), top: px(14) } } })
    expect((removed.nodes.child as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 20 })
    expect(removed.nodes.absolute).toStrictEqual(file.nodes.absolute)

    expect(store.undo()).toBe(true)
    expect(publications).toHaveLength(2)
    expect(store.getSnapshot().file!.revision).toBe(2)
    expect(store.getSnapshot().selection).toStrictEqual(['parent'])
    expect(withoutRevision(store.getSnapshot().file!)).toStrictEqual(withoutRevision(file))
    expect(store.getHistory()).toMatchObject({ past: [], future: [{ selection: ['parent'], afterSelection: ['parent'] }] })

    expect(store.redo()).toBe(true)
    expect(publications).toHaveLength(3)
    expect(store.getSnapshot().file!.revision).toBe(3)
    expect(store.getSnapshot().selection).toStrictEqual(['parent'])
    expect(withoutRevision(store.getSnapshot().file!)).toStrictEqual(withoutRevision(removed))
    expect(store.getHistory()).toMatchObject({ past: [{ selection: ['parent'], afterSelection: ['parent'] }], future: [] })
  })

  it('PAPER-FLEX-001 AT-DOC-002 preserves a mixed reversed selection while mutating only requested Flex parents', () => {
    const store = createDocumentStore(() => 'unused')
    const { file, geometry } = fixture()
    const second: PrimitiveNode = {
      id: 'second', type: 'frame', name: 'Second', styles: { relativeTransform: [1, 0, 0, 1, 360, 0], width: 100, height: 80 },
      layout: { item: { position: { mode: 'absolute', left: px(360), top: px(0) } }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    }
    const other: PrimitiveNode = { id: 'other', type: 'rectangle', name: 'Other', styles: { relativeTransform: [1, 0, 0, 1, 520, 0], width: 30, height: 30 } }
    file.nodes.second = second
    file.nodes.other = other
    file.relationships.second = { parentId: 'root', orderKey: 'W' }
    file.relationships.other = { parentId: 'root', orderKey: 'X' }
    store.load(file, [])
    const originalSelection = ['other', 'second', 'absolute', 'parent']
    store.selectMany(originalSelection)
    const secondBytes = JSON.stringify(file.nodes.second), otherBytes = JSON.stringify(file.nodes.other), absoluteBytes = JSON.stringify(file.nodes.absolute)

    expect(store.commands.layout.removeFlexSelection(geometry, ['parent'])).toStrictEqual({ status: 'written', parentIds: ['parent'] })
    const removed = structuredClone(store.getSnapshot().file!)
    expect(store.getSnapshot().selection).toStrictEqual(originalSelection)
    expect(JSON.stringify(removed.nodes.second)).toBe(secondBytes)
    expect(JSON.stringify(removed.nodes.other)).toBe(otherBytes)
    expect(JSON.stringify(removed.nodes.absolute)).toBe(absoluteBytes)
    expect((removed.nodes.parent as PrimitiveNode).layout?.container).toStrictEqual({ display: 'freeform' })

    expect(store.undo()).toBe(true)
    expect(store.getSnapshot().selection).toStrictEqual(originalSelection)
    expect(withoutRevision(store.getSnapshot().file!)).toStrictEqual(withoutRevision(file))
    expect(store.redo()).toBe(true)
    expect(store.getSnapshot().selection).toStrictEqual(originalSelection)
    expect(withoutRevision(store.getSnapshot().file!)).toStrictEqual(withoutRevision(removed))
  })

  it('PAPER-FLEX-008 AT-DOC-002 fails a later parent atomically without file, history, selection, or publication changes', () => {
    const store = createDocumentStore(() => 'unused')
    let publications = 0
    store.configure({ onChange: () => { publications++ } })
    const first = fixture()
    const second: PrimitiveNode = {
      id: 'second', type: 'frame', name: 'Second', styles: { relativeTransform: [1, 0, 0, 1, 400, 0], width: 100, height: 80 },
      layout: { item: { position: { mode: 'absolute', left: px(400), top: px(0) } }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    }
    first.file.nodes.second = second
    first.file.relationships.second = { parentId: 'root', orderKey: 'W' }
    first.geometry.nodes.second = {
      canvasKind: 'frame', documentRevision: 0, layoutGeneration: -1, rect: { x: 400, y: 0, width: 100, height: 80 },
      offset: { x: 400, y: 0, width: 100, height: 80, origin: { x: 50, y: 40 } },
      box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      offsetParentNodeId: null, directChild: true,
    }
    store.load(first.file, [])
    store.selectMany(['absolute', 'parent'])
    const beforeFile = structuredClone(store.getSnapshot().file), beforeSelection = [...store.getSnapshot().selection]
    const fileBytes = JSON.stringify(store.getSnapshot().file), geometryBytes = JSON.stringify(first.geometry)

    expect(store.commands.layout.removeFlexSelection(first.geometry, ['second', 'parent'])).toStrictEqual({ status: 'unavailable', reason: 'geometry', message: paperRemoveFlexCopy.geometry })
    expect(store.getSnapshot().file).toStrictEqual(beforeFile)
    expect(store.getSnapshot().selection).toStrictEqual(beforeSelection)
    expect(store.getHistory()).toStrictEqual({ past: [], future: [] })
    expect(publications).toBe(0)
    expect(JSON.stringify(store.getSnapshot().file)).toBe(fileBytes)
    expect(JSON.stringify(first.geometry)).toBe(geometryBytes)
  })

  it('PAPER-FLEX-008 rejects an invalid requested target independently of the current selection', () => {
    const store = createDocumentStore(() => 'unused')
    let publications = 0
    store.configure({ onChange: () => { publications++ } })
    const { file, geometry } = fixture()
    store.load(file, [])
    const originalSelection = ['absolute', 'parent']
    store.selectMany(originalSelection)
    const before = structuredClone(store.getSnapshot().file)
    const fileBytes = JSON.stringify(store.getSnapshot().file), geometryBytes = JSON.stringify(geometry)

    expect(store.commands.layout.removeFlexSelection(geometry, ['absolute'])).toStrictEqual({ status: 'unavailable', reason: 'topology', message: paperRemoveFlexCopy.topology })
    expect(store.getSnapshot().file).toStrictEqual(before)
    expect(store.getSnapshot().selection).toStrictEqual(originalSelection)
    expect(store.getHistory()).toStrictEqual({ past: [], future: [] })
    expect(publications).toBe(0)
    expect(JSON.stringify(store.getSnapshot().file)).toBe(fileBytes)
    expect(JSON.stringify(geometry)).toBe(geometryBytes)
  })

  it('AT-DOC-003 reports write failure without changing a read-only store', () => {
    const store = createDocumentStore(() => 'unused')
    let publications = 0
    store.configure({ onChange: () => { publications++ } })
    const { file, geometry } = fixture()
    store.load(file, [])
    store.selectMany(['parent'])
    store.setReadOnly(true)
    const before = structuredClone(store.getSnapshot().file)

    expect(store.commands.layout.removeFlexSelection(geometry, ['parent'])).toStrictEqual({ status: 'unavailable', reason: 'write', message: paperRemoveFlexCopy.write })
    expect(store.getSnapshot().file).toStrictEqual(before)
    expect(store.getSnapshot().selection).toStrictEqual(['parent'])
    expect(store.getHistory()).toStrictEqual({ past: [], future: [] })
    expect(publications).toBe(0)
  })
})
