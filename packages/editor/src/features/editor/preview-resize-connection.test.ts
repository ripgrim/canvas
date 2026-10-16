import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ProjectSnapshot } from './types'
import { createPreviewConnection } from './preview-service'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { sceneGeometry } from './scene-geometry'
import { collaborationService } from '../collaboration/collaboration-service'
import type { GestureStartFence } from './gesture-command-planner'
import type { ResizePresentation } from './resize-projection'

const file = (revision = 0): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'file-resize-bridge',
  revision,
  pages: [
    { id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' },
    { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' },
  ],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 100, height: 50 } },
  },
  relationships: { frame: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})

const snapshot = (document: FileDocument, generation = 1): ProjectSnapshot => ({
  projectId: 'project-resize-bridge', fileId: document.fileId, atoms: [], sourceHashes: {},
  composition: { id: 'composition-resize-bridge', name: 'Resize bridge', componentId: null, children: [] },
  file: document, sourceHistory: [], conflict: null, phases: [{ name: 'Read source', completed: 1 }], tokens: [],
  preview: { status: 'ready', currentGeneration: generation, activeGeneration: generation, origin: 'https://preview.test', url: `https://preview.test/build/${generation}/index.html`, stale: false, diagnostics: [] },
  designThemes: [{ id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }],
})

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

const presentation = (appearance?: ResizePresentation['items'][number]['appearance']): ResizePresentation => deepFreeze({
  selectedNodeId: 'frame',
  contentLocked: false,
  affectedAxes: ['x', 'y'],
  effectiveHandle: 'bottom-right',
  items: [{
    nodeId: 'frame', parentId: 'root-1', coordinateSpace: 'parent-padding',
    startRect: { x: 10, y: 20, width: 100, height: 50 },
    rect: { x: 10, y: 20, width: 140, height: 80 },
    nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 70, y: 40 },
    world: { quad: [{ x: 10, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 100 }, { x: 10, y: 100 }], aabb: { x: 10, y: 20, width: 140, height: 80 } },
    ...(appearance ? { appearance } : {}),
  }],
  byNodeId: {},
} as ResizePresentation)

type Harness = ReturnType<typeof harness>
const cleanups: (() => void)[] = []

function harness(options: Parameters<typeof createPreviewConnection>[0] = {}) {
  let nextFrame = 0
  let messageListener: ((event: MessageEvent) => void) | null = null
  const frames = new Map<number, FrameRequestCallback>()
  const target = { postMessage: vi.fn() }
  vi.stubGlobal('window', { document: { querySelector: () => null }, addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') messageListener = listener }), removeEventListener: vi.fn() })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const flushAllFrames = () => {
    for (let turn = 0; frames.size > 0 && turn < 10; turn++) {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(turn)
    }
    if (frames.size) throw new Error('Preview frame queue did not settle')
  }
  const document = file()
  documentStore.load(document, [], { replace: true, pageId: 'page-1' })
  const layoutGeneration = documentStore.getSnapshot().layoutGeneration
  editorStore.set({ snapshot: snapshot(document), previewReady: false, previewThemeId: 'default', runtimeInstanceIds: null, compositionPreview: true, error: null })
  const connection = createPreviewConnection(options)
  connection.start()
  connection.connect(target as unknown as Window)
  target.postMessage.mockClear()
  editorStore.set({ previewReady: true })
  flushAllFrames()
  const deliver = (data: unknown) => messageListener?.({ data, origin: 'https://preview.test', source: target } as unknown as MessageEvent)
  deliver({
    channel: 'design-editor-preview', version: 10, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration, measurementRevision: 9, root: null,
    camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
    items: [{ instanceId: 'frame', source: 'canvas', canvasKind: 'frame', bounds: { x: 410, y: 320, width: 100, height: 50 }, worldAabb: { x: 410, y: 320, width: 100, height: 50 }, offset: { x: 10, y: 20, width: 100, height: 50, origin: { x: 50, y: 25 } }, offsetParentNodeId: null, directChild: true }],
  })
  const start = deepFreeze<GestureStartFence>({ fileId: document.fileId, fileRevision: 0, documentRevision: 0, layoutGeneration, measurementRevision: 9 })
  const sample = (patch: Partial<{ presentation: ResizePresentation; start: GestureStartFence; interactionId: string; sampleSequence: number; pageRootNodeId: string }> = {}) => ({ presentation: presentation(), start, interactionId: 'resize-1', sampleSequence: 1, pageRootNodeId: 'root-1', ...patch })
  target.postMessage.mockClear()
  const cleanup = () => { connection.stop(); vi.unstubAllGlobals() }
  cleanups.push(cleanup)
  const handoff = (input = sample(), committed = true, committedFile = documentStore.getSnapshot().file) => ({ commit: { committed }, committedFile, start: input.start, interactionId: input.interactionId, sampleSequence: input.sampleSequence })
  return { connection, target, frames, flushAllFrames, deliver, start, sample, handoff }
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  collaborationService.configure(undefined)
  editorStore.set({ snapshot: null, previewReady: false, previewThemeId: null, runtimeInstanceIds: null, compositionPreview: false, error: null })
  sceneGeometry.clear()
})

const commands = (h: Harness, type: string) => h.target.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === type)

describe('AT-CAN-005/006 and PAPER-FLEX-006 strict resize preview bridge', () => {
  it('posts each accepted pointer sample synchronously as one exact v9 presentation without scheduling or writing the file', () => {
    const h = harness()
    const before = documentStore.getSnapshot().file
    const input = h.sample()

    expect(h.connection.publishResizePresentation(input)).toBe(true)

    expect(commands(h, 'set-transient-presentations')).toStrictEqual([{
      channel: 'design-editor-preview', version: 10, generation: 1, type: 'set-transient-presentations',
      presentations: [{
        kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-1', sampleSequence: 1,
        fence: { documentRevision: 0, layoutGeneration: h.start.layoutGeneration, measurementRevision: 9 },
        items: [{ nodeId: 'frame', parentNodeId: null, startRect: { x: 10, y: 20, width: 100, height: 50 }, rect: { x: 10, y: 20, width: 140, height: 80 }, nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 70, y: 40 } }],
      }],
    }])
    expect(h.frames.size).toBe(0)
    expect(documentStore.getSnapshot().file).toBe(before)
    expect(input.presentation.items[0]!.rect).toStrictEqual({ x: 10, y: 20, width: 140, height: 80 })
    expect(Object.isFrozen(input.presentation)).toBe(true)
    expect(Object.isFrozen(input.start)).toBe(true)
  })

  it.each([
    ['file', (h: Harness) => h.sample({ start: deepFreeze({ ...h.start, fileId: 'other-file' }) })],
    ['document revision', (h: Harness) => h.sample({ start: deepFreeze({ ...h.start, fileRevision: 1, documentRevision: 1 }) })],
    ['layout', (h: Harness) => h.sample({ start: deepFreeze({ ...h.start, layoutGeneration: 1 }) })],
    ['measurement', (h: Harness) => h.sample({ start: deepFreeze({ ...h.start, measurementRevision: 10 }) })],
    ['page', (h: Harness) => h.sample({ pageRootNodeId: 'root-2' })],
  ])('fails closed and clears an active presentation for stale %s authority', (_label, stale) => {
    const h = harness()
    expect(h.connection.publishResizePresentation(h.sample())).toBe(true)
    h.target.postMessage.mockClear()

    expect(h.connection.publishResizePresentation(stale(h))).toBe(false)
    expect(commands(h, 'set-transient-presentations')).toStrictEqual([
      expect.objectContaining({ presentations: [] }),
    ])
  })

  it('fails closed when the active preview generation or connected target changes and never replays the old sample', () => {
    const h = harness()
    const input = h.sample()
    expect(h.connection.publishResizePresentation(input)).toBe(true)
    h.target.postMessage.mockClear()
    const current = editorStore.getSnapshot().snapshot!
    editorStore.set({ snapshot: { ...current, preview: { ...current.preview, currentGeneration: 2, activeGeneration: 2 } } })

    expect(h.connection.publishResizePresentation(input)).toBe(false)
    expect(commands(h, 'set-transient-presentations')).toStrictEqual([expect.objectContaining({ generation: 1, presentations: [] })])

    const replacement = { postMessage: vi.fn() }
    h.connection.connect(replacement as unknown as Window)
    editorStore.set({ previewReady: true })
    expect(h.connection.publishResizePresentation(input)).toBe(false)
    expect(replacement.postMessage.mock.calls.some(([command]) => command.type === 'set-transient-presentations' && command.presentations.length)).toBe(false)
  })

  it('rejects an invalid image-geometry adapter result and clears the active presentation', () => {
    const h = harness()
    expect(h.connection.publishResizePresentation(h.sample())).toBe(true)
    h.target.postMessage.mockClear()
    const invalid = presentation({ fills: [{ id: 'fill', type: 'image', assetId: 'missing', fit: 'cover', geometry: { x: 0, y: 0, width: 10, height: 10 } }] })

    expect(h.connection.publishResizePresentation(h.sample({ presentation: invalid, sampleSequence: 2 }))).toBe(false)
    expect(commands(h, 'set-transient-presentations')).toStrictEqual([expect.objectContaining({ presentations: [] })])
  })

  it('rejects a mutable projector result before it can cross the preview boundary', () => {
    const h = harness()
    const mutable = structuredClone(presentation())

    expect(h.connection.publishResizePresentation(h.sample({ presentation: mutable }))).toBe(false)
    expect(commands(h, 'set-transient-presentations')).toEqual([])
  })

  it('clears an older active presentation when frozen input access or transport throws', () => {
    const h = harness()
    expect(h.connection.publishResizePresentation(h.sample())).toBe(true)
    h.target.postMessage.mockClear()
    const hostile = Object.freeze({
      selectedNodeId: 'frame', contentLocked: false, affectedAxes: Object.freeze(['x', 'y']), effectiveHandle: 'bottom-right',
      get items() { throw new Error('hostile getter') },
      byNodeId: Object.freeze({}),
    }) as unknown as ResizePresentation
    expect(h.connection.publishResizePresentation(h.sample({ presentation: hostile, sampleSequence: 2 }))).toBe(false)
    expect(commands(h, 'set-transient-presentations')).toEqual([expect.objectContaining({ presentations: [] })])

    h.target.postMessage.mockClear()
    expect(h.connection.publishResizePresentation(h.sample({ interactionId: 'resize-transport', sampleSequence: 1 }))).toBe(true)
    h.target.postMessage.mockImplementation(() => { throw new Error('target closed') })
    expect(h.connection.publishResizePresentation(h.sample({ interactionId: 'resize-transport', sampleSequence: 2 }))).toBe(false)
    h.target.postMessage.mockImplementation(() => undefined)
    expect(h.connection.publishResizePresentation(h.sample({ interactionId: 'resize-transport', sampleSequence: 2 }))).toBe(true)
  })

  it('suppresses an identical sample, rejects replay or lower sequence fail-closed, and accepts a distinct interaction', () => {
    const h = harness()
    const first = h.sample({ sampleSequence: 3 })
    expect(h.connection.publishResizePresentation(first)).toBe(true)
    expect(h.connection.publishResizePresentation(first)).toBe(true)
    expect(commands(h, 'set-transient-presentations')).toHaveLength(1)

    expect(h.connection.publishResizePresentation(h.sample({ sampleSequence: 2 }))).toBe(false)
    expect(commands(h, 'set-transient-presentations').at(-1)).toEqual(expect.objectContaining({ presentations: [] }))
    h.target.postMessage.mockClear()
    expect(h.connection.publishResizePresentation(h.sample({ interactionId: 'resize-2', sampleSequence: 0 }))).toBe(true)
    expect(commands(h, 'set-transient-presentations')).toEqual([expect.objectContaining({ presentations: [expect.objectContaining({ interactionId: 'resize-2', sampleSequence: 0 })] })])
  })

  it('disconnects and reconnects without replaying an old presentation', () => {
    const h = harness()
    const old = h.sample()
    expect(h.connection.publishResizePresentation(old)).toBe(true)
    h.target.postMessage.mockClear()
    h.connection.disconnect()
    expect(commands(h, 'set-transient-presentations')).toEqual([expect.objectContaining({ presentations: [] })])

    h.connection.connect(h.target as unknown as Window)
    editorStore.set({ previewReady: true })
    h.connection.sync()
    expect(h.connection.publishResizePresentation(old)).toBe(false)
    expect(commands(h, 'set-transient-presentations').some(command => command.presentations.length)).toBe(false)
  })

  it('stops and restarts without replaying an old presentation', () => {
    const h = harness()
    const old = h.sample()
    expect(h.connection.publishResizePresentation(old)).toBe(true)
    h.target.postMessage.mockClear()
    h.connection.stop()
    expect(commands(h, 'set-transient-presentations')).toEqual([expect.objectContaining({ presentations: [] })])

    h.connection.start()
    h.connection.connect(h.target as unknown as Window)
    editorStore.set({ previewReady: true })
    h.connection.sync()
    h.deliver({ channel: 'design-editor-preview', version: 10, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: h.start.layoutGeneration, measurementRevision: 9, root: null, items: [] })
    expect(h.connection.publishResizePresentation(old)).toBe(false)
    expect(commands(h, 'set-transient-presentations').some(command => command.presentations.length)).toBe(false)
  })

  it('clears strict presentations without clearing the separately owned legacy move channel', () => {
    const h = harness()
    documentStore.setTransient({ kind: 'move', rects: { frame: { x: 15, y: 25, width: 100, height: 50 } }, offset: { x: 5, y: 5 }, guides: [], targetFrameId: null, insertion: null })
    h.target.postMessage.mockClear()
    expect(h.connection.publishResizePresentation(h.sample())).toBe(true)
    h.target.postMessage.mockClear()

    expect(h.connection.clearResizePresentation()).toBe(true)
    expect(commands(h, 'set-transient-presentations')).toEqual([expect.objectContaining({ presentations: [] })])
    expect(commands(h, 'set-transient-move')).toEqual([])
    documentStore.setTransient(null)
  })
})

describe('AT-CAN-006 and CLOUD-SYNC-GESTURE-001 committed resize handoff prerequisite', () => {
  it('orders the terminal presentation before the authoritative document and layout without waiting a frame', () => {
    const h = harness()
    expect(h.connection.publishResizePresentation(h.sample({ sampleSequence: 4 }))).toBe(true)
    const committed = file(1)
    committed.nodes.frame = { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 140, height: 80 } }
    documentStore.load(committed, [], { replace: true, pageId: 'page-1' })

    const receipt = h.connection.syncCommittedDocument(h.handoff(h.sample({ sampleSequence: 4 })))
    const relevant = h.target.postMessage.mock.calls.map(([command]) => command).filter(command => ['set-transient-presentations', 'set-document', 'set-layout'].includes(command.type))
    expect(relevant.map(command => command.type)).toStrictEqual(['set-transient-presentations', 'set-document', 'set-layout'])
    expect(relevant[1]!.document.revision).toBe(1)
    expect(relevant[1]!.document.canvas.elements.find((element: { id: string }) => element.id === 'frame')).toMatchObject({ relativeTransform: [1, 0, 0, 1, 10, 20], width: 140, height: 80 })
    expect(relevant[2]).toMatchObject({ layoutGeneration: h.start.layoutGeneration })
    expect(receipt).toStrictEqual({ generation: 1, fileId: 'file-resize-bridge', pageId: 'page-1', documentRevision: 1, layoutGeneration: h.start.layoutGeneration, afterMeasurementRevision: 9 })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(h.frames.size).toBe(0)
    h.flushAllFrames()
    expect(h.target.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === 'set-document')).toHaveLength(1)
  })

  it('does not revive legacy roster transforms after the authoritative handoff clears runtime overlays', () => {
    const h = harness()
    collaborationService.configure({
      getSnapshot: () => ({
        status: 'live', localClientId: 'local', localProfile: null, canMutate: true, canManageShare: false, agents: [], error: null,
        participants: [{ presenceId: 'remote-presence', subjectId: 'remote-user', displayName: 'Remote', avatarUrl: null, clientId: 'remote', role: 'owner', isHeadless: false, sequence: 1, awareness: { pageId: 'page-1', focused: true, selection: null, camera: null, cursor: null, interaction: { interactionId: 'remote-move', pageId: 'page-1', kind: 'move', nodeIds: ['frame'], transforms: [{ nodeId: 'frame', dx: 7, dy: 11 }] } } }],
      }),
      subscribe: () => () => {},
      updateAwareness: vi.fn(),
    })
    h.target.postMessage.mockClear()
    expect(h.connection.publishResizePresentation(h.sample({ sampleSequence: 5 }))).toBe(true)
    const committed = file(1)
    documentStore.load(committed, [], { replace: true, pageId: 'page-1' })

    expect(h.connection.syncCommittedDocument(h.handoff(h.sample({ sampleSequence: 5 })))).not.toBeNull()
    expect(h.target.postMessage.mock.calls.map(([command]) => command.type).filter(type => ['set-transient-presentations', 'set-document', 'set-layout', 'set-transient-move'].includes(type))).toStrictEqual([
      'set-transient-presentations', 'set-document', 'set-layout',
    ])
    expect(commands(h, 'set-transient-move')).toHaveLength(0)
  })

  it('does not hand off a failed commit at the API boundary', () => {
    const h = harness()
    expect(h.connection.publishResizePresentation(h.sample())).toBe(true)
    h.target.postMessage.mockClear()

    expect(h.connection.syncCommittedDocument(h.handoff(h.sample(), false))).toBeNull()
    expect(h.target.postMessage).not.toHaveBeenCalled()
  })

  it('does not retire a page-one terminal after the committed document switches to page two', () => {
    const h = harness()
    const terminal = h.sample({ sampleSequence: 2 })
    expect(h.connection.publishResizePresentation(terminal)).toBe(true)
    const committed = file(1)
    documentStore.load(committed, [], { replace: true, pageId: 'page-1' })
    const expectedCommit = documentStore.getSnapshot().file!
    expect(documentStore.setPage('page-2')).toBe(true)
    h.target.postMessage.mockClear()

    expect(h.connection.syncCommittedDocument(h.handoff(terminal, true, expectedCommit))).toBeNull()
    expect(commands(h, 'set-document')).toEqual([])
    expect(commands(h, 'set-layout')).toEqual([])
  })

  it('does not hand off a later intervening document as the resize commit', () => {
    const h = harness()
    const terminal = h.sample({ sampleSequence: 2 })
    expect(h.connection.publishResizePresentation(terminal)).toBe(true)
    const committed = file(1)
    documentStore.load(committed, [], { replace: true, pageId: 'page-1' })
    const expectedCommit = documentStore.getSnapshot().file!
    documentStore.load(file(2), [], { replace: true, pageId: 'page-1' })
    h.target.postMessage.mockClear()

    expect(h.connection.syncCommittedDocument(h.handoff(terminal, true, expectedCommit))).toBeNull()
    expect(commands(h, 'set-document')).toEqual([])
    expect(commands(h, 'set-layout')).toEqual([])
  })

  it('requires the active terminal interaction, sequence, and pointer-down fence before retiring it', () => {
    const h = harness()
    const terminal = h.sample({ interactionId: 'terminal', sampleSequence: 6 })
    expect(h.connection.publishResizePresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    h.target.postMessage.mockClear()

    expect(h.connection.syncCommittedDocument({ ...h.handoff(terminal), sampleSequence: 5 })).toBeNull()
    expect(h.connection.syncCommittedDocument({ ...h.handoff(terminal), interactionId: 'other' })).toBeNull()
    expect(h.connection.syncCommittedDocument({ ...h.handoff(terminal), start: deepFreeze({ ...terminal.start, measurementRevision: 10 }) })).toBeNull()
    expect(h.target.postMessage).not.toHaveBeenCalled()
    expect(h.connection.syncCommittedDocument(h.handoff(terminal))).not.toBeNull()
    expect(commands(h, 'set-document')).toHaveLength(1)
  })

  it('rejects handoff without an active terminal presentation', () => {
    const h = harness()
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    h.target.postMessage.mockClear()

    expect(h.connection.syncCommittedDocument(h.handoff())).toBeNull()
    expect(h.target.postMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['target', (h: Harness) => h.connection.disconnect()],
    ['generation', (_h: Harness) => { const current = editorStore.getSnapshot().snapshot!; editorStore.set({ snapshot: { ...current, preview: { ...current.preview, currentGeneration: 2, activeGeneration: 2 } } }) }],
    ['page', (_h: Harness) => { documentStore.setPage('page-2') }],
    ['file', (_h: Harness) => { documentStore.load(file(1), [], { replace: true, pageId: 'page-1' }) }],
    ['layout', (_h: Harness) => { documentStore.commands.layout.gesture.begin(); documentStore.commands.layout.gesture.cancel() }],
    ['terminal', (h: Harness) => { h.connection.clearResizePresentation() }],
  ])('rechecks %s authority after asset hydration reentrancy', (_label, mutate) => {
    let reenter = () => {}
    const h = harness({ resolveAsset: () => { reenter(); return { mime: 'image/png', data: 'AAAA' } } })
    const terminal = h.sample({ interactionId: 'asset-terminal', sampleSequence: 3 })
    expect(h.connection.publishResizePresentation(terminal)).toBe(true)
    const committed = file(1)
    committed.nodes.frame = { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 140, height: 80 }, appearance: { fills: [{ id: 'fill', type: 'image', assetId: 'asset', fit: 'cover' }] } }
    committed.assets = { asset: { id: 'asset', name: 'asset.png', mime: 'image/png', extension: 'png', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) } }
    documentStore.load(committed, [], { replace: true, pageId: 'page-1' })
    const expectedCommit = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    reenter = () => mutate(h)

    expect(h.connection.syncCommittedDocument(h.handoff(terminal, true, expectedCommit))).toBeNull()
    expect(commands(h, 'set-document')).toEqual([])
    expect(commands(h, 'set-layout')).toEqual([])
  })

  it('recovers with a forced authoritative resync when transport fails after set-document', () => {
    const h = harness()
    collaborationService.configure({
      getSnapshot: () => ({
        status: 'live', localClientId: 'local', localProfile: null, canMutate: true, canManageShare: false, agents: [], error: null,
        participants: [{ presenceId: 'remote-presence', subjectId: 'remote-user', displayName: 'Remote', avatarUrl: null, clientId: 'remote', role: 'owner', isHeadless: false, sequence: 1, awareness: { pageId: 'page-1', focused: true, selection: null, camera: null, cursor: null, interaction: { interactionId: 'remote-move', pageId: 'page-1', kind: 'move', nodeIds: ['frame'], transforms: [{ nodeId: 'frame', dx: 7, dy: 11 }] } } }],
      }),
      subscribe: () => () => {},
      updateAwareness: vi.fn(),
    })
    const terminal = h.sample({ sampleSequence: 7 })
    expect(h.connection.publishResizePresentation(terminal)).toBe(true)
    const committed = file(1)
    documentStore.load(committed, [], { replace: true, pageId: 'page-1' })
    const expectedCommit = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    let throwLayout = true
    h.target.postMessage.mockImplementation(command => {
      if (command.type === 'set-layout' && throwLayout) {
        throwLayout = false
        throw new Error('layout transport failed')
      }
    })

    expect(h.connection.syncCommittedDocument(h.handoff(terminal, true, expectedCommit))).toBeNull()
    expect(commands(h, 'set-document')).toHaveLength(1)
    expect(commands(h, 'set-layout')).toHaveLength(1)
    expect(h.frames.size).toBe(1)

    const retryStart = h.target.postMessage.mock.calls.length
    h.flushAllFrames()
    expect(commands(h, 'set-document')).toHaveLength(2)
    expect(commands(h, 'set-layout')).toHaveLength(2)
    expect(h.target.postMessage.mock.calls.slice(retryStart).map(([command]) => command.type)).toStrictEqual(['set-document', 'set-layout'])
    expect(commands(h, 'set-transient-move')).toHaveLength(0)
    expect(h.connection.publishResizePresentation(terminal)).toBe(false)
  })

  it('retries the authoritative projection when the first set-document transport fails', () => {
    const h = harness()
    const terminal = h.sample({ sampleSequence: 8 })
    expect(h.connection.publishResizePresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const expectedCommit = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    let throwDocument = true
    h.target.postMessage.mockImplementation(command => {
      if (command.type === 'set-document' && throwDocument) {
        throwDocument = false
        throw new Error('document transport failed')
      }
    })

    expect(h.connection.syncCommittedDocument(h.handoff(terminal, true, expectedCommit))).toBeNull()
    expect(commands(h, 'set-document')).toHaveLength(1)
    expect(commands(h, 'set-layout')).toHaveLength(0)
    expect(h.frames.size).toBe(1)

    const retryStart = h.target.postMessage.mock.calls.length
    h.flushAllFrames()
    expect(h.target.postMessage.mock.calls.slice(retryStart).map(([command]) => command.type)).toStrictEqual(['set-document', 'set-layout'])
    expect(commands(h, 'set-document')).toHaveLength(2)
    expect(commands(h, 'set-layout')).toHaveLength(1)
  })
})
