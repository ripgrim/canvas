import { describe, expect, it } from 'vitest'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import type { LayoutGeometry } from './layout-measure'
import { createDocumentStore } from './document-store'

const rectangle = (id: string, left: number): PrimitiveNode => ({ id, type: 'rectangle', name: id, styles: { relativeTransform: [1, 0, 0, 1, left, 10], width: 20, height: 10 } })
const fixture = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'wrap-store', revision: 0,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: { root: { id: 'root', type: 'root' }, a: rectangle('a', 80), b: rectangle('b', 10) },
  relationships: { a: { parentId: 'root', orderKey: 'V' }, b: { parentId: 'root', orderKey: 'W' } },
  theme: { tokens: {} },
})
const geometry = (file: FileDocument, layoutGeneration: number): LayoutGeometry => ({
  documentRevision: file.revision, layoutGeneration, unsupported: {},
  nodes: Object.fromEntries(['a', 'b'].map(id => {
    const node = file.nodes[id] as PrimitiveNode
    return [id, { canvasKind: 'rectangle' as const, documentRevision: file.revision, layoutGeneration, rect: { x: node.styles.relativeTransform[4], y: node.styles.relativeTransform[5], width: 20, height: 10 }, worldAabb: { x: node.styles.relativeTransform[4], y: node.styles.relativeTransform[5], width: 20, height: 10 }, offset: { x: node.styles.relativeTransform[4], y: node.styles.relativeTransform[5], width: 20, height: 10, origin: { x: 10, y: 5 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0] as const, directChild: true }]
  })),
})

describe('Paper Wrap document-store seam', () => {
  it('WRAP-01/07 executes one semantic command, publishes once, selects wrappers, and undoes as one step', () => {
    const generated = ['wrapper-id']
    const store = createDocumentStore(() => generated.shift() ?? 'unexpected-id')
    const published: FileDocument[] = []
    store.configure({ onChange: file => published.push(structuredClone(file)) })
    const source = fixture()
    store.load(source, [])
    store.selectMany(['a', 'b', 'a'])

    const result = store.commands.layout.wrapSelection(geometry(source, store.getSnapshot().layoutGeneration))
    expect(result).toStrictEqual({ status: 'written', wrapperIds: ['wrapper-id'] })
    expect(published).toHaveLength(1)
    expect(store.getSnapshot().file!.revision).toBe(1)
    expect(store.getSnapshot().selection).toStrictEqual(['wrapper-id'])
    expect(store.getHistory()).toMatchObject({
      past: [{ redo: { type: 'node.wrap', groups: [{ wrapper: { id: 'wrapper-id' }, children: [{ nodeId: 'b' }, { nodeId: 'a' }] }] } }],
      future: [],
    })
    expect(Object.keys(store.getSnapshot().file!.nodes).sort()).toStrictEqual(['a', 'b', 'root', 'wrapper-id'])

    expect(store.undo()).toBe(true)
    expect(published).toHaveLength(2)
    expect(store.getSnapshot().file!.revision).toBe(2)
    expect(store.getSnapshot().selection).toStrictEqual(['a', 'b'])
    expect(store.getSnapshot().file!.nodes).not.toHaveProperty('wrapper-id')
    expect(store.getSnapshot().file!.relationships).toMatchObject(source.relationships)
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getSnapshot().canRedo).toBe(true)
  })

  it('WRAP-09 returns an actionable failure without file, history, selection, or publication changes', () => {
    const store = createDocumentStore(() => 'never-used')
    let publications = 0
    store.configure({ onChange: () => { publications++ } })
    const source = fixture()
    store.load(source, [])
    store.selectMany(['a', 'b'])
    const before = structuredClone(store.getSnapshot().file)
    const stale = geometry(source, store.getSnapshot().layoutGeneration)
    stale.documentRevision = -1

    expect(store.commands.layout.wrapSelection(stale)).toStrictEqual({ status: 'unavailable', reason: 'geometry', message: 'Wrap needs current canvas measurements. Wait for the canvas to finish updating, then try again.' })
    expect(store.getSnapshot().file).toStrictEqual(before)
    expect(store.getSnapshot().selection).toStrictEqual(['a', 'b'])
    expect(store.getHistory()).toStrictEqual({ past: [], future: [] })
    expect(publications).toBe(0)
  })
})
