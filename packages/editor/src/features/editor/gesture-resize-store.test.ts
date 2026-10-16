import { describe, expect, it, vi } from 'vitest'
import type { Atom } from '@canvas/repo-engine/contracts'
import type { FileCommand, FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import type { EditorPersistenceIntent } from '../../capabilities'
import { captureGestureAuthority } from './gesture-authority'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { GestureFinalIntent } from './gesture-command-planner'
import { createDocumentStore } from './document-store'
import { resizeGeometryAuthority } from './layout-measure'
import type { ResizeProjectionSample } from './resize-projection'
import type { SceneGeometry } from './scene-geometry'

const revision = 7
const layoutGeneration = 0
const measurementRevision = 19
const selectedLayout = { item: { position: { mode: 'freeform' as const } } }

const fixture = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'resize-store-file',
  revision,
  pages: [
    { id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' },
    { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' },
  ],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    selected: { id: 'selected', type: 'rectangle', name: 'Selected', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 100, height: 80 }, layout: structuredClone(selectedLayout) },
    other: { id: 'other', type: 'rectangle', name: 'Other', styles: { relativeTransform: [1, 0, 0, 1, 160, 20], width: 30, height: 30 } },
    text: {
      id: 'text', type: 'text', name: 'Text', text: 'Edit me', styles: { relativeTransform: [1, 0, 0, 1, 20, 140], width: 90, height: 24 },
      textStyle: { fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
    },
    'page-2-node': { id: 'page-2-node', type: 'rectangle', name: 'Second page', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 20, height: 20 } },
  },
  relationships: {
    selected: { parentId: 'root-1', orderKey: 'A7' },
    other: { parentId: 'root-1', orderKey: 'B7' },
    text: { parentId: 'root-1', orderKey: 'C7' },
    'page-2-node': { parentId: 'root-2', orderKey: 'A7' },
  },
  theme: { tokens: {} },
})

const geometry = (file: FileDocument, generation: number): SceneGeometry => ({
  revision: measurementRevision,
  documentRevision: file.revision,
  layoutGeneration: generation,
  nodes: {
    selected: {
      canvasKind: 'rectangle',
      documentRevision: file.revision,
      layoutGeneration: generation,
      rect: { x: 10, y: 20, width: 100, height: 80 },
      worldAabb: { x: 10, y: 20, width: 100, height: 80 },
      offset: { x: 10, y: 20, width: 100, height: 80, origin: { x: 50, y: 40 } },
      offsetParentNodeId: null,
      offsetParentToRoot: [1, 0, 0, 1, 0, 0],
      directChild: true,
      transform: [1, 0, 0, 1, 0, 0],
      box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    },
  },
  unsupported: {},
  themeUnsupported: {},
  unownedPortals: 0,
})

const capture = (store: ReturnType<typeof createDocumentStore>): GestureAuthoritySnapshot => {
  const before = store.getSnapshot()
  if (!before.file) throw new Error('Fixture file is unavailable.')
  const measured = geometry(before.file, before.layoutGeneration)
  const captured = captureGestureAuthority(
    () => {
      const state = store.getSnapshot()
      return {
        file: state.file,
        pageId: state.pageId,
        atoms: state.atoms,
        layoutGeneration: state.layoutGeneration,
        viewport: state.viewport,
        viewportSize: state.viewportSize,
        selection: state.selection,
      }
    },
    () => measured,
  )
  if (!captured) throw new Error('Fixture gesture authority could not be captured.')
  return captured
}

const resizeSample = (rect = { x: -5, y: 12, width: 140, height: 96 }): ResizeProjectionSample => ({
  coordinateSpace: 'parent-padding',
  rect,
  contentLocked: false,
  affectedAxes: ['x', 'y'],
  effectiveHandle: 'bottom-right',
})

const resizeIntent = (snapshot: GestureAuthoritySnapshot, sample = resizeSample()): GestureFinalIntent => {
  const authority = resizeGeometryAuthority(snapshot, 'selected')
  if (!authority) throw new Error('Fixture resize authority could not be derived.')
  return { kind: 'resize', nodeId: 'selected', authority, sample }
}

const expectedCommand = (): Extract<FileCommand, { type: 'node.resizePresentation' }> => ({
  type: 'node.resizePresentation',
  entries: [{
    expected: {
      nodeId: 'selected', relationship: { parentId: 'root-1', orderKey: 'A7' },
      primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 100, height: 80 }, layout: structuredClone(selectedLayout),
    },
    source: {
      nodeId: 'selected', relationship: { parentId: 'root-1', orderKey: 'A7' },
      primitiveGeometry: { relativeTransform: [1, 0, 0, 1, -5, 12], width: 140, height: 96 }, layout: structuredClone(selectedLayout),
    },
  }],
})

const expectedPostFile = (): FileDocument => {
  const file = fixture()
  file.revision = revision + 1
  ;(file.nodes.selected as PrimitiveNode).styles = { relativeTransform: [1, 0, 0, 1, -5, 12], width: 140, height: 96 }
  return file
}

const stable = (file: FileDocument | null) => file === null ? null : { ...structuredClone(file), revision: 0 }

const stateRecord = (store: ReturnType<typeof createDocumentStore>) => {
  const state = store.getSnapshot()
  return {
    file: structuredClone(state.file), pageId: state.pageId, atoms: structuredClone(state.atoms), selection: [...state.selection],
    dirty: state.dirty, canUndo: state.canUndo, canRedo: state.canRedo, blocked: state.blocked, readOnly: state.readOnly,
    error: state.error, textEditing: state.textEditing, layoutGeneration: state.layoutGeneration,
    layoutOverrides: structuredClone(state.layoutOverrides), history: store.getHistory(),
  }
}

const createLoadedStore = (ids: readonly string[] = ['unexpected-resize-allocation']) => {
  const allocations: string[] = []
  let index = 0
  const store = createDocumentStore(() => {
    const id = ids[index++] ?? `unexpected-${index}`
    allocations.push(id)
    return id
  })
  store.load(fixture(), [])
  store.setViewportSize({ width: 800, height: 600 })
  store.select('selected')
  return { store, allocations }
}

const changedContent = (file: FileDocument): FileDocument => {
  const other = file.nodes.other
  if (!other || other.type === 'root' || other.type === 'component') throw new Error('Fixture node is unavailable.')
  return { ...structuredClone(file), nodes: { ...structuredClone(file.nodes), other: { ...structuredClone(other), name: 'Changed elsewhere' } } }
}

describe('resize gesture document-store transaction prerequisites', () => {
  it('AT-DOC-003 and CLOUD-SYNC-CLIENT-001 commit one direct aggregate leaf with exact persistence and undo/redo closure', async () => {
    const { store, allocations } = createLoadedStore()
    const snapshot = capture(store)
    const intent = resizeIntent(snapshot)
    const command = expectedCommand()
    const inputs = { snapshot: JSON.stringify(snapshot), intent: JSON.stringify(intent), command: JSON.stringify(command) }
    const writes: { file: FileDocument; expectedRevision: number; intent: EditorPersistenceIntent }[] = []
    store.configure({
      persist: async (file, expectedRevision, persistenceIntent) => {
        writes.push({ file: structuredClone(file), expectedRevision, intent: structuredClone(persistenceIntent) })
        return { ...structuredClone(file), revision: expectedRevision + 1 }
      },
    })

    const result = store.commands.commitGesture(snapshot, [intent])
    expect(result.committed).toBe(true)
    expect(result.persistence).not.toBeNull()
    await result.persistence

    expect(allocations).toStrictEqual([])
    expect(writes).toStrictEqual([{ file: expectedPostFile(), expectedRevision: 7, intent: { kind: 'commands', commands: [command] } }])
    expect(writes[0]!.intent.commands[0]!.type).toBe('node.resizePresentation')
    expect(writes[0]!.intent.commands[0]!.type).not.toBe('batch')
    expect(store.getSnapshot().file).toStrictEqual(expectedPostFile())
    expect(store.getSnapshot().selection).toStrictEqual(['selected'])
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.getHistory().past[0]!.redo).toStrictEqual(command)
    expect(store.getHistory().past[0]!.redo.type).not.toBe('batch')
    expect(JSON.stringify(snapshot)).toBe(inputs.snapshot)
    expect(JSON.stringify(intent)).toBe(inputs.intent)
    expect(JSON.stringify(command)).toBe(inputs.command)

    store.configure({})
    expect(store.undo()).toBe(true)
    expect(stable(store.getSnapshot().file)).toStrictEqual(stable(fixture()))
    expect(store.getSnapshot().selection).toStrictEqual(['selected'])
    expect(store.redo()).toBe(true)
    expect(stable(store.getSnapshot().file)).toStrictEqual(stable(expectedPostFile()))
    expect(store.getSnapshot().selection).toStrictEqual(['selected'])
  })

  it('AT-DOC-003 rejects missing file, read-only, blocked, and active text editing before resize planning', () => {
    const cases: Array<readonly [string, (store: ReturnType<typeof createDocumentStore>) => void]> = [
      ['missing file', store => store.clear()],
      ['read-only', store => store.setReadOnly(true)],
      ['blocked', store => { store.getSnapshot().blocked = true }],
      ['text editing', store => { expect(store.commands.text.begin('text')).toBe('text-session') }],
    ]
    for (const [name, arrange] of cases) {
      const { store, allocations } = createLoadedStore(['text-session'])
      const snapshot = capture(store)
      const intent = resizeIntent(snapshot)
      const persist = vi.fn()
      store.configure({ persist })
      arrange(store)
      const before = stateRecord(store)
      expect(store.commands.commitGesture(snapshot, [intent]), name).toStrictEqual({ committed: false, persistence: null })
      expect(persist, name).not.toHaveBeenCalled()
      expect(stateRecord(store), name).toStrictEqual(before)
      expect(allocations, name).toStrictEqual(name === 'text editing' ? ['text-session'] : [])
    }
  })

  it('CLOUD-SYNC-CLIENT-001 rejects persistence-blocked independently from the visible blocked flag', async () => {
    const { store, allocations } = createLoadedStore()
    const persist = vi.fn().mockRejectedValue(new Error('Revision conflict'))
    store.configure({ persist })
    expect(store.commands.rename('other', 'Queued change')).toBe(true)
    await store.waitForPersistence()
    store.getSnapshot().blocked = false
    const snapshot = capture(store)
    const intent = resizeIntent(snapshot)
    const before = stateRecord(store)
    expect(store.commands.commitGesture(snapshot, [intent])).toStrictEqual({ committed: false, persistence: null })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(allocations).toStrictEqual([])
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('PAPER-FLEX-006 rejects file identity, revision, content, atom, layout, page, and ordered-selection drift', () => {
    const driftedAtom: Atom = { name: 'Button', kind: 'atom', componentId: 'button-component', path: 'Button.tsx', exportName: 'Button', fingerprint: 'button', sourceHash: 'button', status: 'bound', candidates: [], props: [] }
    const cases: Array<readonly [string, (store: ReturnType<typeof createDocumentStore>) => void]> = [
      ['file identity', store => store.load({ ...structuredClone(store.getSnapshot().file!), fileId: 'replacement-file' }, [], { replace: true })],
      ['file revision', store => store.load({ ...structuredClone(store.getSnapshot().file!), revision: revision + 1 }, [], { replace: true })],
      ['file content', store => store.load(changedContent(store.getSnapshot().file!), [], { replace: true })],
      ['atoms', store => { expect(store.setAtoms([driftedAtom])).toBe(true) }],
      ['layout generation', store => store.commands.layout.gesture.begin()],
      ['open page', store => { expect(store.setPage('page-2')).toBe(true) }],
      ['ordered selection', store => store.select('other')],
    ]
    for (const [name, drift] of cases) {
      const { store, allocations } = createLoadedStore()
      const snapshot = capture(store)
      const intent = resizeIntent(snapshot)
      const persist = vi.fn()
      store.configure({ persist })
      drift(store)
      const before = stateRecord(store)
      expect(store.commands.commitGesture(snapshot, [intent]), name).toStrictEqual({ committed: false, persistence: null })
      expect(persist, name).not.toHaveBeenCalled()
      expect(allocations, name).toStrictEqual([])
      expect(stateRecord(store), name).toStrictEqual(before)
    }
  })

  it('CLOUD-SYNC-CLIENT-001 rechecks file replacement after policy returns and commits no resize state', () => {
    const { store } = createLoadedStore()
    const snapshot = capture(store)
    const intent = resizeIntent(snapshot)
    const persist = vi.fn()
    store.configure({ persist })
    store.setEditPolicy(() => store.load(changedContent(fixture()), [], { replace: true }))

    expect(store.commands.commitGesture(snapshot, [intent])).toStrictEqual({ committed: false, persistence: null })
    expect(persist).not.toHaveBeenCalled()
    expect(stable(store.getSnapshot().file)).toStrictEqual(stable(changedContent(fixture())))
    expect((store.getSnapshot().file!.nodes.selected as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 10, 20], width: 100, height: 80 })
    expect(store.getHistory()).toStrictEqual({ past: [], future: [] })
  })

  it('CLOUD-SYNC-CLIENT-001 rechecks selection, layout generation, read-only, and text editing after policy returns', () => {
    const cases: Array<readonly [string, (store: ReturnType<typeof createDocumentStore>) => void, (store: ReturnType<typeof createDocumentStore>) => void]> = [
      ['selection', store => store.select('other'), store => expect(store.getSnapshot().selection).toStrictEqual(['other'])],
      ['layout generation', store => store.commands.layout.gesture.begin(), store => expect(store.getSnapshot().layoutGeneration).toBe(1)],
      ['read-only', store => store.setReadOnly(true), store => expect(store.getSnapshot().readOnly).toBe(true)],
      ['text editing', store => { expect(store.commands.text.begin('text')).toBe('policy-session') }, store => expect(store.getSnapshot().textEditing?.nodeId).toBe('text')],
    ]
    for (const [name, mutate, assertMutation] of cases) {
      const { store } = createLoadedStore(['policy-session'])
      const snapshot = capture(store)
      const intent = resizeIntent(snapshot)
      const persist = vi.fn()
      store.configure({ persist })
      store.setEditPolicy(() => mutate(store))
      expect(store.commands.commitGesture(snapshot, [intent]), name).toStrictEqual({ committed: false, persistence: null })
      assertMutation(store)
      expect(persist, name).not.toHaveBeenCalled()
      expect((store.getSnapshot().file!.nodes.selected as PrimitiveNode).styles, name).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 10, 20], width: 100, height: 80 })
      expect(store.getHistory(), name).toStrictEqual({ past: [], future: [] })
    }
  })

  it('AT-DOC-003, PAPER-FLEX-006, and CLOUD-SYNC-CLIENT-001 recheck atoms, open page, and blocked state after policy returns', () => {
    const policyAtom: Atom = {
      name: 'Policy button', kind: 'atom', componentId: 'policy-button', path: 'PolicyButton.tsx', exportName: 'PolicyButton',
      fingerprint: 'policy-button-fingerprint', sourceHash: 'policy-button-source', status: 'bound', candidates: [], props: [],
    }
    const cases: Array<readonly [
      string,
      (store: ReturnType<typeof createDocumentStore>) => void,
      (store: ReturnType<typeof createDocumentStore>) => void,
    ]> = [
      [
        'atom catalog',
        store => { expect(store.setAtoms([policyAtom])).toBe(true) },
        store => expect(store.getSnapshot().atoms).toStrictEqual([policyAtom]),
      ],
      [
        'open page',
        store => { expect(store.setPage('page-2')).toBe(true) },
        store => {
          expect(store.getSnapshot().pageId).toBe('page-2')
          expect(store.getSnapshot().selection).toStrictEqual([])
        },
      ],
      [
        'blocked state',
        store => { store.getSnapshot().blocked = true },
        store => expect(store.getSnapshot().blocked).toBe(true),
      ],
    ]

    for (const [name, mutate, assertMutation] of cases) {
      const { store } = createLoadedStore()
      const snapshot = capture(store)
      const intent = resizeIntent(snapshot)
      const sourceInputs = { snapshot: JSON.stringify(snapshot), intent: JSON.stringify(intent) }
      const persist = vi.fn()
      store.configure({ persist })
      store.setEditPolicy(() => mutate(store))

      expect(store.commands.commitGesture(snapshot, [intent]), name).toStrictEqual({ committed: false, persistence: null })
      assertMutation(store)
      expect((store.getSnapshot().file!.nodes.selected as PrimitiveNode).styles, name).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 10, 20], width: 100, height: 80 })
      expect(store.getHistory(), name).toStrictEqual({ past: [], future: [] })
      expect(persist, name).not.toHaveBeenCalled()
      expect(JSON.stringify(snapshot), name).toBe(sourceInputs.snapshot)
      expect(JSON.stringify(intent), name).toBe(sourceInputs.intent)
    }
  })

  it('AT-DOC-003 rejects policy mutation of the candidate without exposing it to document state', () => {
    const { store } = createLoadedStore()
    const snapshot = capture(store)
    const intent = resizeIntent(snapshot)
    const persist = vi.fn()
    store.configure({ persist })
    store.setEditPolicy(candidate => { const node = candidate.nodes.selected as PrimitiveNode; const matrix = node.styles.relativeTransform; node.styles.relativeTransform = [matrix[0], matrix[1], matrix[2], matrix[3], 999, matrix[5]] })
    const before = stateRecord(store)
    expect(store.commands.commitGesture(snapshot, [intent])).toStrictEqual({ committed: false, persistence: null })
    expect(persist).not.toHaveBeenCalled()
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('AT-DOC-003 keeps planner no-op and malformed authority mutation-free', () => {
    const { store, allocations } = createLoadedStore()
    const snapshot = capture(store)
    const noOp = resizeIntent(snapshot, resizeSample({ x: 10, y: 20, width: 100, height: 80 }))
    const malformed = { ...resizeIntent(snapshot), untrustedExtra: true } as unknown as GestureFinalIntent
    const persist = vi.fn()
    store.configure({ persist })
    const before = stateRecord(store)
    expect(store.commands.commitGesture(snapshot, [noOp])).toStrictEqual({ committed: false, persistence: null })
    expect(store.commands.commitGesture(snapshot, [malformed])).toStrictEqual({ committed: false, persistence: null })
    expect(persist).not.toHaveBeenCalled()
    expect(allocations).toStrictEqual([])
    expect(stateRecord(store)).toStrictEqual(before)
  })

  it('CLOUD-SYNC-CLIENT-001 reports a denying policy through the existing error path without gesture mutation', () => {
    const { store } = createLoadedStore()
    const snapshot = capture(store)
    const intent = resizeIntent(snapshot)
    const persist = vi.fn()
    const onError = vi.fn()
    store.configure({ persist, onError })
    store.setEditPolicy(() => { throw new Error('Policy denied resize') })
    const beforeFile = structuredClone(store.getSnapshot().file)

    expect(store.commands.commitGesture(snapshot, [intent])).toStrictEqual({ committed: false, persistence: null })
    expect(store.getSnapshot().file).toStrictEqual(beforeFile)
    expect(store.getSnapshot().selection).toStrictEqual(['selected'])
    expect(store.getHistory()).toStrictEqual({ past: [], future: [] })
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getSnapshot().error).toBe('Policy denied resize')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Policy denied resize' }))
    expect(persist).not.toHaveBeenCalled()
  })
})
