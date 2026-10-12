import { describe, expect, it, vi } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, childrenOf } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import type { Scene } from './canvas-scene'
import type { MeasuredNode, SceneGeometry } from './scene-geometry'
import type { Atom } from './types'
import { planGestureCommand } from './gesture-command-planner'
import type { GestureCommandSnapshot, GestureFinalIntent, ParentLocalRect } from './gesture-command-planner'

const px = (value: number) => ({ kind: 'px' as const, value })
const atoms: Atom[] = [
  { name: 'Parent', kind: 'atom', componentId: 'parent-component', path: 'src/Parent.tsx', exportName: 'Parent', fingerprint: 'parent', sourceHash: 'parent', status: 'bound', candidates: [], slots: ['children'], props: [{ name: 'children', type: 'ReactNode', optional: true }] },
  { name: 'Child', kind: 'atom', componentId: 'child-component', path: 'src/Child.tsx', exportName: 'Child', fingerprint: 'child', sourceHash: 'child', status: 'bound', candidates: [], props: [] },
]
const fixture = (): FileDocument => ({
  schemaVersion: 9,
  fileId: 'gesture-file',
  revision: 7,
  pages: [{ id: 'page', name: 'Page 1', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    group: { id: 'group', type: 'frame', name: 'Group', styles: { left: 10, top: 20, width: 120, height: 80, overflow: 'visible' } },
    leaf: { id: 'leaf', type: 'rectangle', name: 'Leaf', styles: { left: 5, top: 6, width: 20, height: 18 } },
    flex: {
      id: 'flex', type: 'frame', name: 'Flex', styles: { left: 200, top: 40, width: 300, height: 140 },
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    },
    a: { id: 'a', type: 'rectangle', name: 'A', styles: { left: 0, top: 0, width: 100, height: 40, rotation: 5 }, layout: { item: { position: { mode: 'flow' } } } },
    b: { id: 'b', type: 'rectangle', name: 'B', styles: { left: 0, top: 0, width: 60, height: 30 }, layout: { item: { position: { mode: 'flow' } } } },
    other: {
      id: 'other', type: 'frame', name: 'Other', styles: { left: 520, top: 40, width: 200, height: 100 },
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    },
    c: { id: 'c', type: 'rectangle', name: 'C', styles: { left: 0, top: 0, width: 50, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
    'component-parent': {
      id: 'component-parent', type: 'component', componentId: 'parent-component', exportName: 'Parent', props: {},
      layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    },
    'component-child': { id: 'component-child', type: 'component', componentId: 'child-component', exportName: 'Child', props: {}, layout: { item: { position: { mode: 'flow' } } } },
  },
  relationships: {
    group: { parentId: 'root', orderKey: 'V' },
    leaf: { parentId: 'group', orderKey: 'V' },
    flex: { parentId: 'root', orderKey: 'W' },
    a: { parentId: 'flex', orderKey: 'V' },
    b: { parentId: 'flex', orderKey: 'W' },
    other: { parentId: 'root', orderKey: 'X' },
    c: { parentId: 'other', orderKey: 'V' },
    'component-parent': { parentId: 'root', orderKey: 'Y' },
    'component-child': { parentId: 'component-parent', orderKey: 'V', slot: 'children' },
  },
  theme: { tokens: {} },
})

const measure = (file: FileDocument, id: string, rect: { x: number; y: number; width: number; height: number }): MeasuredNode => {
  const node = file.nodes[id]!
  const relationship = file.relationships[id]!
  const parent = file.nodes[relationship.parentId]!
  return {
    ...(node.type === 'component' ? { componentId: node.componentId, parentInstanceId: parent.type === 'component' ? parent.id : null } : { canvasKind: node.type as Exclude<typeof node.type, 'root' | 'component'> }),
    documentRevision: 7,
    layoutGeneration: 11,
    rect,
    worldAabb: rect,
    offset: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, origin: { x: rect.width / 2, y: rect.height / 2 } },
    offsetParentNodeId: parent.type === 'root' ? null : parent.id,
    directChild: true,
  }
}

const snapshot = (): GestureCommandSnapshot => {
  const file = fixture()
  const nodes: Record<string, MeasuredNode> = {
    group: measure(file, 'group', { x: 10, y: 20, width: 120, height: 80 }),
    leaf: measure(file, 'leaf', { x: 15, y: 26, width: 20, height: 18 }),
    flex: measure(file, 'flex', { x: 200, y: 40, width: 300, height: 140 }),
    a: measure(file, 'a', { x: 212, y: 54, width: 100, height: 40 }),
    b: measure(file, 'b', { x: 320, y: 54, width: 60, height: 30 }),
    other: measure(file, 'other', { x: 520, y: 40, width: 200, height: 100 }),
    c: measure(file, 'c', { x: 530, y: 50, width: 50, height: 20 }),
    'component-parent': measure(file, 'component-parent', { x: 40, y: 240, width: 260, height: 100 }),
    'component-child': measure(file, 'component-child', { x: 52, y: 252, width: 90, height: 36 }),
  }
  // Child offsets are parent-padding coordinates, unlike their scene/world rectangles.
  nodes.leaf!.offset = { x: 5, y: 6, width: 20, height: 18, origin: { x: 10, y: 9 } }
  nodes.a!.offset = { x: 12, y: 14, width: 100, height: 40, origin: { x: 50, y: 20 } }
  nodes.b!.offset = { x: 120, y: 14, width: 60, height: 30, origin: { x: 30, y: 15 } }
  nodes.c!.offset = { x: 10, y: 10, width: 50, height: 20, origin: { x: 25, y: 10 } }
  nodes['component-child']!.offset = { x: 12, y: 12, width: 90, height: 36, origin: { x: 45, y: 18 } }
  const sceneNodes = Object.entries(nodes).map(([id, measurement], order) => {
    const node = file.nodes[id]!
    const relationship = file.relationships[id]!
    if (node.type === 'root') throw new Error('Fixture scene cannot contain the page root')
    return { id, kind: node.type, name: node.type === 'component' ? node.exportName : node.name, parentId: file.nodes[relationship.parentId]!.type === 'root' ? null : relationship.parentId, rect: measurement.rect, rotation: 0, clip: false, depth: file.nodes[relationship.parentId]!.type === 'root' ? 0 : 1, order, flow: node.layout?.item.position.mode === 'flow', locked: false }
  })
  const scene: Scene = { nodes: sceneNodes, byId: new Map(sceneNodes.map(node => [node.id, node])) }
  const geometry: SceneGeometry = { nodes, revision: 19, documentRevision: 7, layoutGeneration: 11, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
  return { file, atoms, scene, geometry, layoutGeneration: 11, start: { fileId: 'gesture-file', fileRevision: 7, measurementRevision: 19, documentRevision: 7, layoutGeneration: 11 } }
}

const compositeSnapshot = (): GestureCommandSnapshot => {
  const source = snapshot()
  source.file.nodes.a = { id: 'a', type: 'frame', name: 'A', styles: { left: 0, top: 0, width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } }
  source.file.nodes['a-leaf'] = { id: 'a-leaf', type: 'rectangle', name: 'Leaf', styles: { left: 7, top: 8, width: 12, height: 10 } }
  source.file.relationships['a-leaf'] = { parentId: 'a', orderKey: 'V' }
  source.geometry.nodes.a = { ...source.geometry.nodes.a!, canvasKind: 'frame' }
  const aScene = source.scene.byId.get('a')!
  const replacement = { ...aScene, kind: 'frame' as const }
  source.scene.nodes[source.scene.nodes.indexOf(aScene)] = replacement
  source.scene.byId.set('a', replacement)
  return source
}

const structure = (file: FileDocument) => {
  const copy = structuredClone(file)
  copy.revision = 0
  return JSON.stringify(copy)
}
const rect = (x: number, y: number, width: number, height: number) => ({ coordinateSpace: 'parent-padding' as const, x, y, width, height })

const cloneMove = (
  clone: Extract<GestureFinalIntent, { kind: 'clone-source-and-move-original' }>['clone'],
  original: Extract<GestureFinalIntent, { kind: 'clone-source-and-move-original' }>['original'],
): Extract<GestureFinalIntent, { kind: 'clone-source-and-move-original' }> => ({
  kind: 'clone-source-and-move-original',
  nodeId: 'a',
  sourcePlacement: { parentId: 'flex', index: 0 },
  clone,
  original,
})

const assertClosedHistory = (source: GestureCommandSnapshot, command: FileCommand) => {
  const history = applyFileCommandWithHistory(source.file, command, atoms)
  const undone = applyFileCommand(history.file, history.undo, atoms)
  expect(structure(undone)).toBe(structure(source.file))
  const redone = applyFileCommand(undone, history.redo, atoms)
  expect(structure(redone)).toBe(structure(history.file))
  return history.file
}

describe('Phase 4 gesture command planner prerequisite', () => {

  it('drops a flow child as one exact absolute layout command without replacing its identity or order', () => {
    const source = snapshot()
    const plan = planGestureCommand(source, [{ kind: 'absolute-drop', nodeId: 'a', parentId: 'flex', rect: rect(37, 51, 100, 40) }], vi.fn())
    expect(plan).toStrictEqual({
      command: { type: 'batch', commands: [{ type: 'node.setLayout', nodeId: 'a', layout: { item: {
        position: { mode: 'absolute', left: px(37), top: px(51) },
      } } }, { type: 'node.setStyles', nodeId: 'a', styles: { width: 100, height: 40 } }] },
      selection: ['a'],
      duplicateIds: {},
    })
    const history = applyFileCommandWithHistory(source.file, plan!.command, atoms)
    expect(history.file.relationships.a).toEqual(source.file.relationships.a)
    expect(childrenOf(history.file, 'flex')).toEqual(['a', 'b'])
    expect(history.file.nodes.a!.id).toBe('a')
    expect((history.file.nodes.a as { layout?: unknown }).layout).toEqual({ item: { position: { mode: 'absolute', left: px(37), top: px(51) } } })
    expect(history.file.nodes.a).toMatchObject({ styles: { width: 100, height: 40, rotation: 5 } })
    expect(structure(applyFileCommand(history.file, history.undo, atoms))).toBe(structure(source.file))
  })

  it('stores component drop sizing in layout while retaining the component and slot identities', () => {
    const source = snapshot()
    const plan = planGestureCommand(source, [{ kind: 'absolute-drop', nodeId: 'component-child', parentId: 'component-parent', rect: rect(44, 19, 90, 36) }], vi.fn())
    expect(plan).toStrictEqual({
      command: { type: 'batch', commands: [{ type: 'node.setLayout', nodeId: 'component-child', layout: { item: {
        position: { mode: 'absolute', left: px(44), top: px(19) }, width: { value: px(90) }, height: { value: px(36) },
      } } }] },
      selection: ['component-child'],
      duplicateIds: {},
    })
    const next = applyFileCommand(source.file, plan!.command, atoms)
    expect(next.relationships['component-child']).toEqual({ parentId: 'component-parent', orderKey: 'V', slot: 'children' })
    expect(next.nodes['component-child']).toMatchObject({ id: 'component-child', componentId: 'child-component', layout: { item: { position: { mode: 'absolute', left: px(44), top: px(19) }, width: { value: px(90) }, height: { value: px(36) } } } })
  })

  it('keeps ordinary flow reorder identity and emits no duplicate identities', () => {
    const source = snapshot()
    const allocate = vi.fn()
    const plan = planGestureCommand(source, [{ kind: 'reorder', nodeId: 'b', placement: { parentId: 'flex', index: 0 } }], allocate)
    expect(plan).toStrictEqual({ command: { type: 'batch', commands: [{ type: 'node.reorder', nodeId: 'b', index: 0 }] }, selection: ['b'], duplicateIds: {} })
    expect(allocate).not.toHaveBeenCalled()
    const next = applyFileCommand(source.file, plan!.command, atoms)
    expect(childrenOf(next, 'flex')).toEqual(['b', 'a'])
    expect(next.nodes.b).toBeDefined()
    expect(next.nodes).not.toHaveProperty('copy-b')
  })

  it('clones the complete subtree at source, moves the original from before the target, and closes undo and redo', () => {
    const source = compositeSnapshot()
    const allocate = vi.fn((id: string) => `copy-${id}`)
    const plan = planGestureCommand(source, [cloneMove(
      { mode: 'flow' },
      { mode: 'flow', placement: { parentId: 'flex', index: 2 } },
    )], allocate)
    expect(allocate.mock.calls).toEqual([['a'], ['a-leaf']])
    expect(plan).toStrictEqual({
      command: { type: 'batch', commands: [
        { type: 'node.duplicate', nodeId: 'a', ids: { a: 'copy-a', 'a-leaf': 'copy-a-leaf' } },
        { type: 'node.reorder', nodeId: 'copy-a', index: 0 },
        { type: 'node.reorder', nodeId: 'a', index: 2 },
      ] },
      selection: ['a'],
      duplicateIds: { a: { a: 'copy-a', 'a-leaf': 'copy-a-leaf' } },
    })
    const next = assertClosedHistory(source, plan!.command)
    expect(childrenOf(next, 'flex')).toEqual(['copy-a', 'b', 'a'])
    expect(next.relationships['copy-a-leaf']).toEqual({ parentId: 'copy-a', orderKey: 'V' })
  })

  it('moves the original from after the target while leaving the clone at the captured source index', () => {
    const source = snapshot()
    const intent: GestureFinalIntent = {
      kind: 'clone-source-and-move-original',
      nodeId: 'b',
      sourcePlacement: { parentId: 'flex', index: 1 },
      clone: { mode: 'flow' },
      original: { mode: 'flow', placement: { parentId: 'flex', index: 0 } },
    }
    const plan = planGestureCommand(source, [intent], id => `copy-${id}`)
    expect(plan!.selection).toEqual(['b'])
    expect(plan!.command).toStrictEqual({ type: 'batch', commands: [
      { type: 'node.duplicate', nodeId: 'b', ids: { b: 'copy-b' } },
      { type: 'node.reorder', nodeId: 'copy-b', index: 1 },
      { type: 'node.reorder', nodeId: 'b', index: 0 },
    ] })
    const next = assertClosedHistory(source, plan!.command)
    expect(childrenOf(next, 'flex')).toEqual(['b', 'a', 'copy-b'])
  })

  it('keeps a source-zone raw gap as a valid composite no-op instead of discarding the duplication', () => {
    const source = compositeSnapshot()
    const plan = planGestureCommand(source, [cloneMove(
      { mode: 'flow' },
      { mode: 'flow', placement: { parentId: 'flex', index: 0 } },
    )], id => `copy-${id}`)!
    expect(plan.command).toStrictEqual({ type: 'batch', commands: [
      { type: 'node.duplicate', nodeId: 'a', ids: { a: 'copy-a', 'a-leaf': 'copy-a-leaf' } },
      { type: 'node.reorder', nodeId: 'copy-a', index: 0 },
      { type: 'node.reorder', nodeId: 'a', index: 1 },
    ] })
    expect(childrenOf(assertClosedHistory(source, plan.command), 'flex')).toEqual(['copy-a', 'a', 'b'])
  })

  it.each([
    ['flow clone and flow original', { mode: 'flow' as const }, { mode: 'flow' as const, placement: { parentId: 'flex', index: 2 } }, ['copy-a', 'b', 'a']],
    ['flow clone and absolute original', { mode: 'flow' as const }, { mode: 'absolute' as const, parentId: 'flex', rect: rect(37, 51, 100, 40) }, ['copy-a', 'a', 'b']],
    ['absolute clone and flow original', { mode: 'absolute' as const, rect: rect(15, 16, 100, 40) }, { mode: 'flow' as const, placement: { parentId: 'flex', index: 2 } }, ['copy-a', 'b', 'a']],
    ['absolute clone and absolute original', { mode: 'absolute' as const, rect: rect(15, 16, 100, 40) }, { mode: 'absolute' as const, parentId: 'flex', rect: rect(37, 51, 100, 40) }, ['copy-a', 'a', 'b']],
  ])('applies and history-closes %s', (_name, clone, original, expectedOrder) => {
    const source = compositeSnapshot()
    const plan = planGestureCommand(source, [cloneMove(clone, original)], id => `copy-${id}`)!
    expect(plan.selection).toEqual(['a'])
    const next = assertClosedHistory(source, plan.command)
    expect(childrenOf(next, 'flex')).toEqual(expectedOrder)
    expect((next.nodes['copy-a'] as { layout?: { item: { position: { mode: string } } } }).layout!.item.position.mode).toBe(clone.mode)
    expect((next.nodes.a as { layout?: { item: { position: { mode: string } } } }).layout!.item.position.mode).toBe(original.mode)
  })

  it('preserves a Component slot for both identities', () => {
    const source = snapshot()
    const intent: GestureFinalIntent = {
      kind: 'clone-source-and-move-original', nodeId: 'component-child',
      sourcePlacement: { parentId: 'component-parent', slot: 'children', index: 0 },
      clone: { mode: 'flow' },
      original: { mode: 'absolute', parentId: 'component-parent', rect: rect(44, 19, 90, 36) },
    }
    const plan = planGestureCommand(source, [intent], id => `copy-${id}`)!
    expect(plan.selection).toEqual(['component-child'])
    const next = assertClosedHistory(source, plan.command)
    expect(next.relationships['copy-component-child']).toMatchObject({ parentId: 'component-parent', slot: 'children' })
    expect(next.relationships['component-child']).toMatchObject({ parentId: 'component-parent', slot: 'children' })
  })

  it('detects the identity-reversal mutation that selects and moves the clone', () => {
    const source = compositeSnapshot()
    const correct = planGestureCommand(source, [cloneMove({ mode: 'flow' }, { mode: 'flow', placement: { parentId: 'flex', index: 2 } })], id => `copy-${id}`)!
    const mutated: FileCommand = { type: 'batch', commands: [
      { type: 'node.duplicate', nodeId: 'a', ids: { a: 'copy-a', 'a-leaf': 'copy-a-leaf' } },
      { type: 'node.reorder', nodeId: 'copy-a', index: 2 },
    ] }
    const wrong = applyFileCommand(source.file, mutated, atoms)
    const right = applyFileCommand(source.file, correct.command, atoms)
    expect(correct.selection).toEqual(['a'])
    expect(['copy-a']).not.toEqual(correct.selection)
    expect(childrenOf(wrong, 'flex')).toEqual(['a', 'b', 'copy-a'])
    expect(childrenOf(wrong, 'flex')).not.toEqual(childrenOf(right, 'flex'))
  })

  it('rejects stale, locked, margin, wrong-source-placement, and invalid geometry before allocating composite identities', () => {
    const cases: GestureCommandSnapshot[] = []
    const stale = compositeSnapshot(); (stale.start as { fileRevision: number }).fileRevision = 6; cases.push(stale)
    const locked = compositeSnapshot(); (locked.file.nodes['a-leaf'] as { isLocked?: boolean }).isLocked = true; cases.push(locked)
    const margin = compositeSnapshot()
    const marginNode = margin.file.nodes.a
    if (!marginNode || marginNode.type === 'root') throw new Error('Fixture needs a flow node')
    marginNode.layout = { ...marginNode.layout!, spacing: { margin: { top: 1, right: 1, bottom: 1, left: 1 } } }
    cases.push(margin)
    const geometry = compositeSnapshot(); geometry.geometry.nodes.a!.offset!.width = 99; cases.push(geometry)
    for (const source of cases) {
      const allocate = vi.fn(() => 'unused')
      expect(planGestureCommand(source, [cloneMove({ mode: 'flow' }, { mode: 'absolute', parentId: 'flex', rect: rect(37, 51, 100, 40) })], allocate)).toBeNull()
      expect(allocate).not.toHaveBeenCalled()
    }

    const wrongPlacement = compositeSnapshot()
    const allocate = vi.fn(() => 'unused')
    expect(planGestureCommand(wrongPlacement, [{ ...cloneMove({ mode: 'flow' }, { mode: 'absolute', parentId: 'flex', rect: rect(37, 51, 100, 40) }), sourcePlacement: { parentId: 'flex', index: 1 } }], allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
  })

  it('rejects allocator failures and identity collisions without returning a partial composite plan', () => {
    const source = compositeSnapshot()
    const intent = cloneMove({ mode: 'flow' }, { mode: 'absolute', parentId: 'flex', rect: rect(37, 51, 100, 40) })
    const throws = vi.fn(() => { throw new Error('allocator unavailable') })
    expect(planGestureCommand(source, [intent], throws)).toBeNull()
    expect(throws).toHaveBeenCalledTimes(1)
    const collision = vi.fn(() => 'b')
    expect(planGestureCommand(source, [intent], collision)).toBeNull()
    expect(collision).toHaveBeenCalledTimes(1)
    expect(source.file.nodes).not.toHaveProperty('copy-a')
  })

  it.each([
    ['file revision', (source: GestureCommandSnapshot) => ({ ...source, start: { ...source.start, fileRevision: 6 } })],
    ['measurement revision', (source: GestureCommandSnapshot) => ({ ...source, start: { ...source.start, measurementRevision: 18 } })],
    ['document revision', (source: GestureCommandSnapshot) => ({ ...source, geometry: { ...source.geometry, documentRevision: 6 } })],
    ['layout generation', (source: GestureCommandSnapshot) => ({ ...source, layoutGeneration: 12 })],
  ])('rejects a stale %s fence before identity allocation', (_name, mutate) => {
    const source = mutate(snapshot())
    const allocate = vi.fn(() => 'unused')
    expect(planGestureCommand(source, [cloneMove({ mode: 'flow' }, { mode: 'flow', placement: { parentId: 'flex', index: 2 } })], allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
  })

  it.each([
    ['missing geometry', (source: GestureCommandSnapshot) => { const nodes = { ...source.geometry.nodes }; delete nodes.a; return { ...source, geometry: { ...source.geometry, nodes } } }],
    ['indirect geometry', (source: GestureCommandSnapshot) => ({ ...source, geometry: { ...source.geometry, nodes: { ...source.geometry.nodes, a: { ...source.geometry.nodes.a!, directChild: false } } } })],
    ['wrong offset parent', (source: GestureCommandSnapshot) => ({ ...source, geometry: { ...source.geometry, nodes: { ...source.geometry.nodes, a: { ...source.geometry.nodes.a!, offsetParentNodeId: null } } } })],
  ])('rejects %s before allocation or document mutation', (_name, mutate) => {
    const source = mutate(snapshot())
    const before = structure(source.file)
    const allocate = vi.fn(() => 'unused')
    expect(planGestureCommand(source, [{ kind: 'absolute-drop', nodeId: 'a', parentId: 'flex', rect: rect(37, 51, 100, 40) }], allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
    expect(structure(source.file)).toBe(before)
  })

  it('rejects a wrong coordinate space, unsupported topology, and both direct and structural lock scope', () => {
    const wrongSpace = { ...rect(37, 51, 100, 40), coordinateSpace: 'world' } as unknown as ParentLocalRect
    const cases: [GestureCommandSnapshot, GestureFinalIntent][] = [
      [snapshot(), { kind: 'absolute-drop', nodeId: 'a', parentId: 'flex', rect: wrongSpace }],
      [snapshot(), { kind: 'absolute-drop', nodeId: 'a', parentId: 'flex', rect: rect(37, 51, 101, 40) }],
      [snapshot(), { kind: 'absolute-drop', nodeId: 'group', parentId: 'root', rect: rect(80, 90, 120, 80) }],
    ]
    const directLocked = snapshot(); (directLocked.file.nodes.a as { isLocked?: boolean }).isLocked = true
    cases.push([directLocked, { kind: 'absolute-drop', nodeId: 'a', parentId: 'flex', rect: rect(37, 51, 100, 40) }])
    const parentLocked = snapshot(); (parentLocked.file.nodes.flex as { isLocked?: boolean }).isLocked = true
    cases.push([parentLocked, { kind: 'absolute-drop', nodeId: 'a', parentId: 'flex', rect: rect(37, 51, 100, 40) }])
    for (const [source, intent] of cases) {
      const allocate = vi.fn(() => 'unused')
      expect(planGestureCommand(source, [intent], allocate)).toBeNull()
      expect(allocate).not.toHaveBeenCalled()
    }
  })

  it('preflights a later invalid batch target before allocating for an earlier valid duplicate', () => {
    const source = compositeSnapshot()
    const before = structure(source.file)
    const allocate = vi.fn((id: string) => `copy-${id}`)
    const intents: GestureFinalIntent[] = [
      cloneMove({ mode: 'flow' }, { mode: 'flow', placement: { parentId: 'flex', index: 2 } }),
      { kind: 'reorder', nodeId: 'c', placement: { parentId: 'other', index: 4 } },
    ]
    expect(planGestureCommand(source, intents, allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
    expect(structure(source.file)).toBe(before)
  })

  it('rejects duplicate allocated identities and leaves the immutable source untouched', () => {
    const source = compositeSnapshot()
    const before = structure(source.file)
    const allocate = vi.fn(() => 'same-id')
    expect(planGestureCommand(source, [cloneMove({ mode: 'flow' }, { mode: 'flow', placement: { parentId: 'flex', index: 2 } })], allocate)).toBeNull()
    expect(allocate).toHaveBeenCalledTimes(2)
    expect(structure(source.file)).toBe(before)
  })
})
