import { describe, expect, it, vi } from 'vitest'
import type { EditorPersistenceIntent } from '../../capabilities'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import { validateFlowDragPresentationStructure } from '@canvas/sync-protocol/flow'
import type { FlowDragPresentation } from '@canvas/sync-protocol/flow'
import type { Scene } from './canvas-scene'
import { createDocumentStore } from './document-store'
import type { GesturePersistenceBinder } from './document-store'
import { beginPaperFlowDrag, samplePaperFlowDrag } from './flow-drag-state'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { GestureCommandSnapshot, GestureFinalIntent } from './gesture-command-planner'
import { derivePaperFlowTerminalIntent } from './gesture-terminal-intent'
import { resolveFlowDragTarget } from './flow-drag-target'
import type { MeasuredNode, SceneGeometry } from './scene-geometry'

const fixture = (): FileDocument => ({
  schemaVersion: 9,
  fileId: 'gesture-store-file',
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
    a: { id: 'a', type: 'rectangle', name: 'A', styles: { left: 0, top: 0, width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
    b: { id: 'b', type: 'rectangle', name: 'B', styles: { left: 0, top: 0, width: 60, height: 30 }, layout: { item: { position: { mode: 'flow' } } } },
    text: {
      id: 'text', type: 'text', name: 'Text', text: 'Edit me', styles: { left: 20, top: 160, width: 90, height: 24 },
      textStyle: { fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
    },
  },
  relationships: {
    group: { parentId: 'root', orderKey: 'V' },
    leaf: { parentId: 'group', orderKey: 'V' },
    flex: { parentId: 'root', orderKey: 'W' },
    a: { parentId: 'flex', orderKey: 'V' },
    b: { parentId: 'flex', orderKey: 'W' },
    text: { parentId: 'root', orderKey: 'X' },
  },
  theme: { tokens: {} },
})

const measured = (file: FileDocument, id: 'group' | 'flex' | 'a' | 'b' | 'text', rect: { x: number; y: number; width: number; height: number }): MeasuredNode => {
  const node = file.nodes[id]!
  const parentId = file.relationships[id]!.parentId
  return {
    canvasKind: node.type as 'frame' | 'rectangle' | 'text',
    documentRevision: file.revision,
    layoutGeneration: 0,
    rect,
    offset: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, origin: { x: rect.width / 2, y: rect.height / 2 } },
    offsetParentNodeId: file.nodes[parentId]!.type === 'root' ? null : parentId,
    directChild: true,
  }
}

const gestureSnapshot = (file: FileDocument, layoutGeneration = 0): GestureCommandSnapshot => {
  const nodes: Record<string, MeasuredNode> = {
    group: measured(file, 'group', { x: 10, y: 20, width: 120, height: 80 }),
    flex: measured(file, 'flex', { x: 200, y: 40, width: 300, height: 140 }),
    a: measured(file, 'a', { x: 212, y: 54, width: 100, height: 40 }),
    b: measured(file, 'b', { x: 320, y: 54, width: 60, height: 30 }),
    text: measured(file, 'text', { x: 20, y: 160, width: 90, height: 24 }),
  }
  nodes.a!.offset = { x: 12, y: 14, width: 100, height: 40, origin: { x: 50, y: 20 } }
  nodes.b!.offset = { x: 120, y: 14, width: 60, height: 30, origin: { x: 30, y: 15 } }
  for (const node of Object.values(nodes)) node.layoutGeneration = layoutGeneration
  const sceneNodes = Object.entries(nodes).map(([id, measurement], order) => {
    const node = file.nodes[id]!
    const parentId = file.relationships[id]!.parentId
    if (node.type === 'root' || node.type === 'component') throw new Error('The fixture scene contains primitives only')
    return { id, kind: node.type, name: node.name, parentId: file.nodes[parentId]!.type === 'root' ? null : parentId, rect: measurement.rect, rotation: 0, clip: false, depth: file.nodes[parentId]!.type === 'root' ? 0 : 1, order, flow: node.layout?.item.position.mode === 'flow', locked: false }
  })
  const scene: Scene = { nodes: sceneNodes, byId: new Map(sceneNodes.map(node => [node.id, node])) }
  const geometry: SceneGeometry = { nodes, revision: 19, documentRevision: file.revision, layoutGeneration, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
  return {
    file,
    atoms: [],
    scene,
    geometry,
    layoutGeneration,
    start: { fileId: file.fileId, fileRevision: file.revision, measurementRevision: 19, documentRevision: file.revision, layoutGeneration },
  }
}

const duplicateIntent: GestureFinalIntent = {
  kind: 'clone-source-and-move-original',
  nodeId: 'a',
  sourcePlacement: { parentId: 'flex', index: 0 },
  clone: { mode: 'flow' },
  original: { mode: 'flow', placement: { parentId: 'flex', index: 2 } },
}
const expectedBatch: FileCommand = {
  type: 'batch',
  commands: [
    { type: 'node.duplicate', nodeId: 'a', ids: { a: 'copy-a' } },
    { type: 'node.reorder', nodeId: 'copy-a', index: 2 },
  ],
}
const expectedHistoryRedo: FileCommand = {
  type: 'batch',
  commands: [
    { type: 'node.duplicate', nodeId: 'a', ids: { a: 'copy-a' } },
    { type: 'node.restoreRelationship', nodeId: 'copy-a', expected: { parentId: 'flex', orderKey: 'VV' }, source: { parentId: 'flex', orderKey: 'X' } },
  ],
}
const expectedPostFile = (): FileDocument => {
  const file = fixture()
  file.revision = 8
  file.nodes['copy-a'] = { id: 'copy-a', type: 'rectangle', name: 'A', styles: { left: 0, top: 0, width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } }
  file.relationships['copy-a'] = { parentId: 'flex', orderKey: 'X' }
  return file
}
const stable = (file: FileDocument | null) => {
  if (!file) return null
  const copy = structuredClone(file)
  copy.revision = 0
  return copy
}
const stateRecord = (store: ReturnType<typeof createDocumentStore>) => {
  const state = store.getSnapshot()
  return { file: stable(state.file), atoms: structuredClone(state.atoms), selection: [...state.selection], dirty: state.dirty, canUndo: state.canUndo, canRedo: state.canRedo, blocked: state.blocked, error: state.error, layoutGeneration: state.layoutGeneration, layoutOverrides: state.layoutOverrides, history: store.getHistory() }
}
const createLoadedStore = (ids: readonly string[] = ['copy-a']) => {
  const allocated: string[] = []
  let index = 0
  const store = createDocumentStore(() => {
    const id = ids[index++] ?? `unexpected-${index}`
    allocated.push(id)
    return id
  })
  store.load(fixture(), [])
  return { store, allocated }
}
const changedContent = (file: FileDocument): FileDocument => {
  const group = file.nodes.group
  if (!group || group.type === 'root' || group.type === 'component') throw new Error('Fixture group is unavailable')
  return { ...file, nodes: { ...file.nodes, group: { ...group, name: 'Changed elsewhere' } } }
}
const paperFlowGesture = (file: FileDocument): Readonly<{ authority: GestureAuthoritySnapshot; intent: Extract<GestureFinalIntent, { kind: 'paper-flow-terminal' }> }> => {
  const snapshot = gestureSnapshot(file)
  const authority: GestureAuthoritySnapshot = {
    ...snapshot,
    pageId: 'page',
    camera: { x: 0, y: 0, zoom: 1 },
    size: { width: 900, height: 600 },
    selection: ['a'],
  }
  const started = beginPaperFlowDrag({
    nodeId: 'a', pointerDownWorld: { x: 220, y: 60 }, pointerDownViewport: { x: 220, y: 60 }, pointerDownTime: 0,
    sourceRelationship: { parentId: 'flex', orderKey: 'V', slot: { presence: 'absent' } }, sourceIndex: 0,
    gestureGeneration: 1, selectionDepthPrimary: false, fence: authority.start,
  })!
  const state = samplePaperFlowDrag(started, {
    world: { x: 390, y: 60 }, viewport: { x: 390, y: 60 }, timestamp: 1,
    modifiers: { altKey: false, ctrlKey: false, metaKey: false }, platform: 'windows',
    authority: { ...authority.start, gestureGeneration: 1, owned: true },
    resolveTarget: edge => resolveFlowDragTarget({ authority, state: edge, hoveredNodeId: 'flex' }),
  })!
  const intent = derivePaperFlowTerminalIntent({ authority, state })
  if (!intent) throw new Error('The Paper flow fixture did not produce a terminal intent')
  return { authority, intent }
}
const freezeData = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in descriptor) freezeData(descriptor.value, seen)
  return Object.freeze(value)
}
const validFlowBinding = (): NonNullable<EditorPersistenceIntent['flow']> => {
  const interactionId = 'flow-drag-1'
  const gestureGeneration = 2
  const sampleSequence = 4
  const source = {
    coordinateSpace: 'world' as const,
    quad: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }] as const,
    aabb: { x: 0, y: 0, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 },
  }
  const current = {
    coordinateSpace: 'world' as const,
    quad: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 100 }, { x: 10, y: 100 }] as const,
    aabb: { x: 10, y: 20, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 },
  }
  const terminalPresentation: FlowDragPresentation = freezeData({
    kind: 'flow-drag' as const, coordinateSpace: 'world' as const,
    identity: { interactionId, gestureGeneration, sampleSequence },
    fence: { fileId: 'gesture-store-file', fileRevision: 7, measurementRevision: 19, documentRevision: 7, layoutGeneration: 0, pageId: 'page', pageRootId: 'root' },
    retention: { kind: 'terminal-retained' as const, gestureGeneration, sampleSequence, terminalReason: 'pointer-up' as const, terminalSampleSequence: sampleSequence, holdUntil: 'authoritative-geometry' as const },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
    original: {
      documentNodeId: 'a', kind: 'rectangle' as const, name: 'A',
      sourceRelationship: { parentId: 'flex', orderKey: 'V', slot: { presence: 'absent' as const } },
      sourceIndex: 0, mode: 'flow' as const, source, current, sourceOffsetParentPose: null,
      dom: { treatment: 'drag-dimmed' as const, opacity: 0.6, opacityPriority: 'important' as const, zIndex: null },
      namePresentation: { visible: true, anchor: 'source' as const, pose: source },
    },
    movingVisual: {
      kind: 'fill-ghost' as const, documentNodeId: null, geometry: current,
      fill: { kind: 'fill-only' as const, color: 'oklch(0.67 0.17 258)' as const, alpha: 0.15 as const },
      hitTesting: 'none' as const, a11y: 'hidden' as const,
    },
    supportClone: null,
    target: null,
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity' as const, durationMs: 150, source: 'wonder' as const } },
  })
  expect(validateFlowDragPresentationStructure(terminalPresentation, { interactionId, gestureGeneration, sequence: sampleSequence }, terminalPresentation.fence)).toBe(true)
  return freezeData({
    claim: { pageId: 'page', interactionId, sourceNodeId: 'a', localClaimGeneration: 1 },
    terminalPresentation,
  })
}

describe('Phase 4 gesture document-store transaction seam', () => {
  it('commits the planner batch once, selects its result, and preserves exact undo and redo', async () => {
    const { store, allocated } = createLoadedStore()
    store.select('text')
    const writes: { expectedRevision: number; intent: EditorPersistenceIntent }[] = []
    store.configure({ persist: async (next, expectedRevision, intent) => {
      writes.push({ expectedRevision, intent })
      return { ...next, revision: expectedRevision + 1 }
    } })
    const result = store.commands.commitGesture(gestureSnapshot(store.getSnapshot().file!), [duplicateIntent])
    expect(result.committed).toBe(true)
    expect(result.persistence).not.toBeNull()
    await result.persistence
    expect(allocated).toEqual(['copy-a'])
    expect(writes).toStrictEqual([{ expectedRevision: 7, intent: { kind: 'commands', commands: [expectedBatch] } }])
    expect(store.getSnapshot().selection).toEqual(['copy-a'])
    expect(store.getSnapshot().canUndo).toBe(true)
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.getHistory().past[0]!.redo).toStrictEqual(expectedHistoryRedo)
    expect(store.getSnapshot().file).toStrictEqual(expectedPostFile())

    store.configure({})
    expect(store.undo()).toBe(true)
    expect(stable(store.getSnapshot().file)).toStrictEqual(stable(fixture()))
    expect(store.getSnapshot().file!.revision).toBe(9)
    expect(store.getSnapshot().selection).toEqual(['text'])
    expect(store.redo()).toBe(true)
    expect(stable(store.getSnapshot().file)).toStrictEqual(stable(expectedPostFile()))
    expect(store.getSnapshot().file!.revision).toBe(10)
    expect(store.getSnapshot().selection).toEqual(['copy-a'])
  })

  it('passes the already planned command to one synchronous binder and persists that exact intent once', async () => {
    const { store } = createLoadedStore()
    store.select('text')
    const source = gestureSnapshot(store.getSnapshot().file!)
    const sourceBefore = structuredClone(source)
    const intents = [structuredClone(duplicateIntent)] as const
    const intentsBefore = structuredClone(intents)
    let boundIntent: EditorPersistenceIntent | null = null
    let boundCommand: FileCommand | null = null
    const binder: GesturePersistenceBinder = vi.fn(command => {
      boundCommand = command
      boundIntent = Object.freeze({ kind: 'commands' as const, commands: Object.freeze([command]) })
      return boundIntent
    })
    const writes: EditorPersistenceIntent[] = []
    store.configure({ persist: async (file, expectedRevision, intent) => {
      writes.push(intent)
      return { ...file, revision: expectedRevision + 1 }
    } })

    const result = store.commands.commitGesture(source, intents, binder)
    expect(result).toMatchObject({ committed: true })
    await result.persistence
    expect(binder).toHaveBeenCalledTimes(1)
    expect(boundCommand).toStrictEqual(expectedBatch)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe(boundIntent)
    expect(writes[0]!.commands).toHaveLength(1)
    expect(writes[0]!.commands[0]).toBe(boundCommand)
    expect(Object.isFrozen(writes[0])).toBe(true)
    expect(Object.isFrozen(writes[0]!.commands)).toBe(true)
    expect(Object.isFrozen(writes[0]!.commands[0])).toBe(true)
    expect(() => { (writes[0]!.commands as FileCommand[])[0] = { type: 'node.rename', nodeId: 'a', name: 'Mutated' } }).toThrow()
    expect(writes[0]!.commands[0]).toBe(boundCommand)
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.getSnapshot().file).toStrictEqual(expectedPostFile())
    expect(store.undo()).toBe(true)
    expect(stable(store.getSnapshot().file)).toStrictEqual(stable(fixture()))
    expect(source).toStrictEqual(sourceBefore)
    expect(intents).toStrictEqual(intentsBefore)
  })

  it.each([
    ['missing binding', () => null],
    ['throwing binder', () => { throw new Error('stale flow claim') }],
    ['async binder', (command: FileCommand) => Promise.resolve({ kind: 'commands' as const, commands: [command] })],
    ['deep-equal replacement command', (command: FileCommand) => freezeData({ kind: 'commands' as const, commands: [structuredClone(command)] })],
    ['extra command', (command: FileCommand) => freezeData({ kind: 'commands' as const, commands: [command, command] })],
  ])('rejects a %s before document, history, selection, snapshot, or persistence mutation', async (_name, bind) => {
    const { store } = createLoadedStore()
    store.select('text')
    const persist = vi.fn()
    store.configure({ persist })
    const source = gestureSnapshot(store.getSnapshot().file!)
    const sourceBefore = structuredClone(source)
    const intents = [structuredClone(duplicateIntent)] as const
    const intentsBefore = structuredClone(intents)
    const before = stateRecord(store)

    const result = store.commands.commitGesture(source, intents, bind as unknown as GesturePersistenceBinder)
    expect(result).toEqual({ committed: false, persistence: null })
    await Promise.resolve()
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
    expect(source).toStrictEqual(sourceBefore)
    expect(intents).toStrictEqual(intentsBefore)
  })

  it('rejects binder reentrancy after planning without applying its command or persistence', () => {
    const { store, allocated } = createLoadedStore()
    store.select('text')
    const source = gestureSnapshot(store.getSnapshot().file!)
    const persist = vi.fn()
    store.configure({ persist })
    const beforeFile = structuredClone(store.getSnapshot().file)
    const binder: GesturePersistenceBinder = vi.fn(command => {
      store.commands.layout.gesture.begin()
      return Object.freeze({ kind: 'commands' as const, commands: Object.freeze([command]) })
    })

    expect(store.commands.commitGesture(source, [duplicateIntent], binder)).toEqual({ committed: false, persistence: null })
    expect(binder).toHaveBeenCalledTimes(1)
    expect(allocated).toEqual(['copy-a'])
    expect(store.getSnapshot().file).toStrictEqual(beforeFile)
    expect(store.getSnapshot().selection).toEqual(['text'])
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getHistory()).toEqual({ past: [], future: [] })
    expect(persist).not.toHaveBeenCalled()
  })

  it('freezes an isolated planned command before the binder and rejects in-place mutation without touching input or store', () => {
    const { store } = createLoadedStore()
    store.select('text')
    const persist = vi.fn()
    store.configure({ persist })
    const source = gestureSnapshot(store.getSnapshot().file!)
    const sourceBefore = structuredClone(source)
    const intents = [structuredClone(duplicateIntent)] as const
    const intentsBefore = structuredClone(intents)
    const before = stateRecord(store)
    const binder = vi.fn((command: FileCommand) => {
      expect(Object.isFrozen(command)).toBe(true)
      expect(Object.isFrozen((command as Extract<FileCommand, { type: 'batch' }>).commands)).toBe(true)
      ;(command as { type: string }).type = 'node.rename'
      return freezeData({ kind: 'commands' as const, commands: [command] })
    })

    expect(store.commands.commitGesture(source, intents, binder)).toEqual({ committed: false, persistence: null })
    expect(binder).toHaveBeenCalledTimes(1)
    expect(stateRecord(store)).toStrictEqual(before)
    expect(persist).not.toHaveBeenCalled()
    expect(source).toStrictEqual(sourceBefore)
    expect(intents).toStrictEqual(intentsBefore)
  })

  it('rejects accessor, hidden, symbol, mutable, custom-prototype, and proxy binder results without reading values', () => {
    const cases: Array<Readonly<{ name: string; make(command: FileCommand): { value: unknown; reads: () => number } }>> = [
      { name: 'commands accessor', make: command => {
        let reads = 0
        const value = Object.defineProperty({ kind: 'commands' }, 'commands', { enumerable: true, get: () => { reads += 1; return [command] } })
        return { value: Object.freeze(value), reads: () => reads }
      } },
      { name: 'hidden extra key', make: command => {
        const value = { kind: 'commands' as const, commands: Object.freeze([command]) }
        Object.defineProperty(value, 'hidden', { value: true, enumerable: false })
        return { value: Object.freeze(value), reads: () => 0 }
      } },
      { name: 'symbol extra key', make: command => ({ value: Object.freeze({ kind: 'commands' as const, commands: Object.freeze([command]), [Symbol('hidden')]: true }), reads: () => 0 }) },
      { name: 'mutable result', make: command => ({ value: { kind: 'commands' as const, commands: Object.freeze([command]) }, reads: () => 0 }) },
      { name: 'mutable commands', make: command => ({ value: Object.freeze({ kind: 'commands' as const, commands: [command] }), reads: () => 0 }) },
      { name: 'custom prototype', make: command => {
        const value = Object.create({ inherited: true }) as { kind: 'commands'; commands: readonly FileCommand[] }
        value.kind = 'commands'; value.commands = Object.freeze([command])
        return { value: Object.freeze(value), reads: () => 0 }
      } },
      { name: 'proxy result', make: command => {
        let reads = 0
        const target = Object.freeze({ kind: 'commands' as const, commands: Object.freeze([command]) })
        return { value: new Proxy(target, { get(source, key, receiver) { reads += 1; return Reflect.get(source, key, receiver) } }), reads: () => reads }
      } },
    ]
    for (const current of cases) {
      const { store } = createLoadedStore()
      store.select('text')
      const source = gestureSnapshot(store.getSnapshot().file!)
      const before = stateRecord(store)
      let reads = () => 0
      const binder = ((command: FileCommand) => { const malformed = current.make(command); reads = malformed.reads; return malformed.value }) as unknown as GesturePersistenceBinder
      expect(store.commands.commitGesture(source, [duplicateIntent], binder), current.name).toEqual({ committed: false, persistence: null })
      expect(reads(), current.name).toBe(0)
      expect(stateRecord(store), current.name).toStrictEqual(before)
    }
  })

  it('rejects a proxy nested inside a flow binding without invoking its value trap', () => {
    const { store } = createLoadedStore()
    store.select('a')
    const { authority, intent } = paperFlowGesture(store.getSnapshot().file!)
    const before = stateRecord(store)
    let reads = 0
    const binder: GesturePersistenceBinder = command => {
      const flow = validFlowBinding()
      const terminalPresentation = new Proxy(flow.terminalPresentation, {
        get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver) },
      })
      return Object.freeze({
        kind: 'commands' as const,
        commands: Object.freeze([command]),
        flow: Object.freeze({ claim: flow.claim, terminalPresentation }),
      })
    }

    expect(store.commands.commitGesture(authority, [intent], binder)).toEqual({ committed: false, persistence: null })
    expect(reads).toBe(0)
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('requires a supplied Paper flow binder to return the exact planned command and a flow binding', async () => {
    const cases: ReadonlyArray<Readonly<{ name: string; bind: GesturePersistenceBinder }>> = [
      { name: 'missing claim', bind: () => null },
      { name: 'unbound generic persistence', bind: command => freezeData({ kind: 'commands', commands: [command] }) },
      { name: 'wrong planned command', bind: command => freezeData({ kind: 'commands', commands: [structuredClone(command)], flow: validFlowBinding() }) },
      { name: 'claim and presentation mismatch', bind: command => {
        const flow = structuredClone(validFlowBinding())
        ;(flow.claim as { interactionId: string }).interactionId = 'different-interaction'
        return freezeData({ kind: 'commands', commands: [command], flow })
      } },
    ]
    for (const current of cases) {
      const { store } = createLoadedStore()
      store.select('a')
      const { authority, intent } = paperFlowGesture(store.getSnapshot().file!)
      const before = stateRecord(store)
      const persist = vi.fn()
      store.configure({ persist })
      expect(store.commands.commitGesture(authority, [intent], current.bind), current.name).toEqual({ committed: false, persistence: null })
      await Promise.resolve()
      expect(stateRecord(store), current.name).toStrictEqual(before)
      expect(persist, current.name).not.toHaveBeenCalled()
    }

    const { store } = createLoadedStore()
    store.select('a')
    const { authority, intent } = paperFlowGesture(store.getSnapshot().file!)
    let exactIntent: EditorPersistenceIntent | null = null
    const persist = vi.fn(async (file: FileDocument, expectedRevision: number, persistenceIntent: EditorPersistenceIntent) => {
      expect(persistenceIntent).toBe(exactIntent)
      return { ...file, revision: expectedRevision + 1 }
    })
    store.configure({ persist })
    const binder: GesturePersistenceBinder = vi.fn(command => {
      exactIntent = Object.freeze({
        kind: 'commands' as const,
        commands: Object.freeze([command]),
        flow: validFlowBinding(),
      })
      return exactIntent
    })
    const result = store.commands.commitGesture(authority, [intent], binder)
    expect(result.committed).toBe(true)
    await result.persistence
    expect(binder).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(store.getHistory().past).toHaveLength(1)
  })

  it('keeps the optional no-binder path for a local Paper flow gesture', async () => {
    const { store } = createLoadedStore()
    store.select('a')
    const { authority, intent } = paperFlowGesture(store.getSnapshot().file!)
    const writes: EditorPersistenceIntent[] = []
    store.configure({ persist: async (file, expectedRevision, persistenceIntent) => {
      writes.push(persistenceIntent)
      return { ...file, revision: expectedRevision + 1 }
    } })

    const result = store.commands.commitGesture(authority, [intent])
    expect(result.committed).toBe(true)
    await result.persistence
    expect(writes).toHaveLength(1)
    expect(writes[0]).toStrictEqual({ kind: 'commands', commands: [{
      type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'flex', orderKey: 'V' }, source: { parentId: 'flex', orderKey: 'X' },
    }] })
    expect(writes[0]!.flow).toBeUndefined()
  })

  it('rejects a missing current file before allocation or any state, history, or persistence change', () => {
    const { store, allocated } = createLoadedStore()
    const source = gestureSnapshot(store.getSnapshot().file!)
    store.clear()
    const persist = vi.fn()
    store.configure({ persist })
    const before = stateRecord(store)
    expect(store.commands.commitGesture(source, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual([])
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('rejects atom catalog drift before allocation or any state, history, or persistence change', () => {
    const { store, allocated } = createLoadedStore()
    const source = gestureSnapshot(store.getSnapshot().file!)
    const driftedAtom = { name: 'Button', kind: 'atom' as const, componentId: 'button-component', path: 'src/Button.tsx', exportName: 'Button', fingerprint: 'button-fingerprint', sourceHash: 'button-hash', status: 'bound' as const, candidates: [], props: [] }
    expect(store.setAtoms([driftedAtom])).toBe(true)
    const persist = vi.fn()
    store.configure({ persist })
    const before = stateRecord(store)
    expect(store.commands.commitGesture(source, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual([])
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('rejects after allocator reentrancy replaces authority without adding gesture history, selection, or persistence', () => {
    const allocated: string[] = []
    const ids = ['copy-a']
    let replaced = false
    let store!: ReturnType<typeof createDocumentStore>
    store = createDocumentStore(() => {
      const id = ids[allocated.length]!
      allocated.push(id)
      if (!replaced) {
        replaced = true
        store.load(changedContent(structuredClone(store.getSnapshot().file!)), [], { replace: true })
      }
      return id
    })
    store.load(fixture(), [])
    store.select('text')
    const source = gestureSnapshot(store.getSnapshot().file!)
    const persist = vi.fn()
    store.configure({ persist })
    expect(store.commands.commitGesture(source, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual(['copy-a'])
    expect(persist).not.toHaveBeenCalled()
    expect(stable(store.getSnapshot().file)).toStrictEqual(stable(changedContent(fixture())))
    expect(store.getSnapshot().file!.nodes['copy-a']).toBeUndefined()
    expect(store.getSnapshot().selection).toEqual(['text'])
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getHistory()).toEqual({ past: [], future: [] })
  })

  it('rejects the blocked state while persistence remains independently unblocked', () => {
    const { store, allocated } = createLoadedStore()
    const source = gestureSnapshot(store.getSnapshot().file!)
    const persist = vi.fn()
    store.configure({ persist })
    store.getSnapshot().blocked = true
    const before = stateRecord(store)
    expect(store.commands.commitGesture(source, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual([])
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it.each([
    ['different file identity', (file: FileDocument) => ({ ...file, fileId: 'replacement-file' })],
    ['different revision', (file: FileDocument) => ({ ...file, revision: 8 })],
    ['different content at the same revision', changedContent],
  ])('rejects a caller-held snapshot after the authoritative file has %s', (_name, replace) => {
    const { store, allocated } = createLoadedStore()
    const source = gestureSnapshot(store.getSnapshot().file!)
    store.load(replace(structuredClone(store.getSnapshot().file!)), [], { replace: true })
    const before = stateRecord(store)
    const persist = vi.fn()
    store.configure({ persist })
    expect(store.commands.commitGesture(source, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual([])
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('rejects a stale layout generation before allocation or any store change', () => {
    const { store, allocated } = createLoadedStore()
    const persist = vi.fn()
    store.configure({ persist })
    const source = gestureSnapshot(store.getSnapshot().file!)
    store.commands.layout.gesture.begin()
    const before = stateRecord(store)
    expect(store.commands.commitGesture(source, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual([])
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('rejects read-only and active text-editing states before allocation', () => {
    const readOnly = createLoadedStore()
    const readOnlyPersist = vi.fn()
    readOnly.store.configure({ persist: readOnlyPersist })
    const readOnlySource = gestureSnapshot(readOnly.store.getSnapshot().file!)
    readOnly.store.setReadOnly(true)
    const readOnlyBefore = stateRecord(readOnly.store)
    expect(readOnly.store.commands.commitGesture(readOnlySource, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(readOnly.allocated).toEqual([])
    expect(readOnlyPersist).not.toHaveBeenCalled()
    expect(stateRecord(readOnly.store)).toStrictEqual(readOnlyBefore)

    const editing = createLoadedStore(['session', 'copy-a'])
    const editingPersist = vi.fn()
    editing.store.configure({ persist: editingPersist })
    const editingSource = gestureSnapshot(editing.store.getSnapshot().file!)
    expect(editing.store.commands.text.begin('text')).toBe('session')
    const editingBefore = stateRecord(editing.store)
    expect(editing.store.commands.commitGesture(editingSource, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(editing.allocated).toEqual(['session'])
    expect(editingPersist).not.toHaveBeenCalled()
    expect(stateRecord(editing.store)).toStrictEqual(editingBefore)
  })

  it('rejects persistence-blocked state without a second allocation, history step, or write', async () => {
    const { store, allocated } = createLoadedStore()
    const persist = vi.fn().mockRejectedValue(new Error('Revision conflict'))
    store.configure({ persist })
    expect(store.commands.rename('group', 'Changed')).toBe(true)
    await store.waitForPersistence()
    expect(store.getSnapshot().blocked).toBe(true)
    const source = gestureSnapshot(store.getSnapshot().file!)
    const before = stateRecord(store)
    expect(store.commands.commitGesture(source, [duplicateIntent])).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual([])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('preflights a later invalid target without allocating or partially mutating the store', () => {
    const { store, allocated } = createLoadedStore()
    const persist = vi.fn()
    store.configure({ persist })
    const source = gestureSnapshot(store.getSnapshot().file!)
    const before = stateRecord(store)
    const intents: GestureFinalIntent[] = [
      duplicateIntent,
      { kind: 'reorder', nodeId: 'b', placement: { parentId: 'flex', index: 4 } },
    ]
    expect(store.commands.commitGesture(source, intents)).toEqual({ committed: false, persistence: null })
    expect(allocated).toEqual([])
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
  })
})
