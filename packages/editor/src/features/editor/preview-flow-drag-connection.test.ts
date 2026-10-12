import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { PreviewFlowDragSourceFence } from '@canvas/preview-runtime/protocol'
import type { ProjectSnapshot } from './types'
import type { FlowDragPresentation } from './flow-drag-presentation'
import type { EditorCollaborationApi, EditorCollaborationRemoteFlowEvent, EditorCollaborationSnapshot } from '../../capabilities'
import { createPreviewConnection, type PreviewFlowDragRetirement } from './preview-service'
import { collaborationService } from '../collaboration/collaboration-service'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { sceneGeometry } from './scene-geometry'

const file = (revision = 0): FileDocument => ({
  schemaVersion: 9,
  fileId: 'file-flow-bridge',
  revision,
  pages: [
    { id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' },
    { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' },
  ],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 10, top: 20, width: 100, height: 50 } },
  },
  relationships: { frame: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})

const snapshot = (document: FileDocument, generation = 1): ProjectSnapshot => ({
  projectId: 'project-flow-bridge', fileId: document.fileId, atoms: [], sourceHashes: {},
  composition: { id: 'composition-flow-bridge', name: 'Flow bridge', componentId: null, children: [] },
  file: document, sourceHistory: [], conflict: null, phases: [{ name: 'Read source', completed: 1 }], tokens: [],
  preview: { status: 'ready', currentGeneration: generation, activeGeneration: generation, origin: 'https://preview.test', url: `https://preview.test/build/${generation}/index.html`, stale: false, diagnostics: [] },
  designThemes: [{ id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }],
})

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

const geometry = (x: number, y: number) => ({
  coordinateSpace: 'world' as const,
  quad: [{ x, y }, { x: x + 100, y }, { x: x + 100, y: y + 50 }, { x, y: y + 50 }] as const,
  aabb: { x, y, width: 100, height: 50 },
  semanticSize: { width: 100, height: 50 },
})

const relationship = { parentId: 'root-1', orderKey: 'V', slot: { presence: 'absent' as const } }

function presentation(fence: PreviewFlowDragSourceFence, patch: Readonly<{
  interactionId?: string
  gestureGeneration?: number
  sampleSequence?: number
  mode?: 'flow' | 'absolute'
  terminal?: boolean
  currentX?: number
  supportClone?: boolean
}> = {}): FlowDragPresentation {
  const interactionId = patch.interactionId ?? 'flow-drag-1'
  const gestureGeneration = patch.gestureGeneration ?? 1
  const sampleSequence = patch.sampleSequence ?? 1
  const currentX = patch.currentX ?? 15
  const mode = patch.mode ?? 'flow'
  const current = geometry(currentX, 25)
  return deepFreeze({
    kind: 'flow-drag',
    coordinateSpace: 'world',
    identity: { interactionId, gestureGeneration, sampleSequence },
    fence,
    retention: patch.terminal
      ? { kind: 'terminal-retained', gestureGeneration, sampleSequence, terminalReason: 'pointer-up', terminalSampleSequence: sampleSequence, holdUntil: 'authoritative-geometry' }
      : { kind: 'active', gestureGeneration, sampleSequence },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: currentX - 10, y: 5 } },
    original: {
      documentNodeId: 'frame', kind: 'frame', name: 'Frame', sourceRelationship: relationship, sourceIndex: 0, mode,
      source: geometry(10, 20), current,
      sourceOffsetParentPose: mode === 'absolute' ? {
        coordinateSpace: 'source-offset-parent', offsetParentNodeId: null,
        sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0] as const,
        matrix: [1, 0, 0, 1, currentX, 25] as const,
      } : null,
      dom: mode === 'flow'
        ? { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null }
        : { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
      namePresentation: { visible: true, anchor: mode === 'flow' ? 'source' : 'current', pose: mode === 'flow' ? geometry(10, 20) : current },
    },
    movingVisual: mode === 'flow'
      ? { kind: 'fill-ghost', documentNodeId: null, geometry: current, fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden' }
      : { kind: 'document-node', documentNodeId: 'frame', geometry: current },
    supportClone: patch.supportClone ? {
      key: { kind: 'flow-support-clone', interactionId, gestureGeneration, cloneGeneration: 1 },
      documentNodeId: null, role: 'inert-marker', layoutParticipation: 'none', generation: 1,
      sourceRelationship: relationship, sourceIndex: 0, entryMode: 'flow', entry: null, world: geometry(10, 20),
      hiddenUntilCommit: true, hitTesting: 'none', a11y: 'hidden',
    } : null,
    target: null,
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
  } as FlowDragPresentation)
}

type Harness = ReturnType<typeof harness>
const cleanups: (() => void)[] = []

function harness() {
  let nextFrame = 0
  let messageListener: ((event: MessageEvent) => void) | null = null
  const frames = new Map<number, FrameRequestCallback>()
  const target = { postMessage: vi.fn() }
  vi.stubGlobal('window', { document: { querySelector: vi.fn(() => null) }, addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') messageListener = listener }), removeEventListener: vi.fn() })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const flushAllFrames = () => {
    for (let turn = 0; frames.size && turn < 10; turn += 1) {
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
  const connection = createPreviewConnection()
  connection.start()
  connection.connect(target as unknown as Window)
  target.postMessage.mockClear()
  editorStore.set({ previewReady: true })
  flushAllFrames()
  const deliver = (data: unknown) => messageListener?.({ data, origin: 'https://preview.test', source: target } as unknown as MessageEvent)
  deliver({
    channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration, measurementRevision: 9, root: null,
    camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
    items: [{ instanceId: 'frame', source: 'canvas', canvasKind: 'frame', bounds: { x: 410, y: 320, width: 100, height: 50 }, worldAabb: { x: 410, y: 320, width: 100, height: 50 }, offset: { x: 10, y: 20, width: 100, height: 50, origin: { x: 50, y: 25 } }, offsetParentNodeId: null, directChild: true }],
  })
  const fence = deepFreeze<PreviewFlowDragSourceFence>({ fileId: document.fileId, fileRevision: 0, measurementRevision: 9, documentRevision: 0, layoutGeneration, pageId: 'page-1', pageRootId: 'root-1' })
  target.postMessage.mockClear()
  const cleanup = () => { connection.stop(); vi.unstubAllGlobals() }
  cleanups.push(cleanup)
  return { connection, target, frames, flushAllFrames, deliver, fence }
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  collaborationService.configure(undefined)
  editorStore.set({ snapshot: null, previewReady: false, previewThemeId: null, runtimeInstanceIds: null, compositionPreview: false, error: null })
  sceneGeometry.clear()
})

const commands = (h: Harness, type: string) => h.target.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === type)
const retirement = (value: FlowDragPresentation): PreviewFlowDragRetirement => deepFreeze({
  interactionId: value.identity.interactionId,
  gestureGeneration: value.identity.gestureGeneration,
  sequence: value.identity.sampleSequence,
  sourceFence: value.fence,
})

describe('PAPER-FLEX-006-BRIDGE-V8 and AT-CAN-005-BRIDGE-V8 live flow publication', () => {
  it('posts the exact frozen presentation synchronously with its proof and never uses a generic move channel', () => {
    const h = harness()
    const sample = presentation(h.fence, { mode: 'absolute', supportClone: true })
    ;(window.document.querySelector as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('DOM access is forbidden') })

    expect(h.connection.publishFlowDragPresentation(sample)).toBe(true)

    const posted = commands(h, 'apply-flow-drag-transaction')
    expect(posted).toHaveLength(1)
    expect(posted[0]!.version).toBe(8)
    expect(posted[0]!.transaction.operation.presentation).toBe(sample)
    expect(posted[0]!.transaction.operation.presentation.original.sourceOffsetParentPose.matrix).toBe(sample.original.sourceOffsetParentPose!.matrix)
    expect(posted[0]!.transaction.operation.presentation.supportClone).toBe(sample.supportClone)
    expect(commands(h, 'set-transient-move')).toEqual([])
    expect(commands(h, 'set-transient-presentations').flatMap(command => command.presentations).filter((item: { kind: string }) => item.kind === 'move-world')).toEqual([])
    expect(h.frames.size).toBe(0)
  })

  it('blocks late samples after release and rehydrates the same-sequence roster only after reconnect cleanup', () => {
    const h = harness()
    let current: EditorCollaborationSnapshot = {
      status: 'live', localClientId: 'local-client', localProfile: null, canMutate: true, canManageShare: false,
      participants: [], agents: [], error: null,
    }
    const listeners = new Set<() => void>()
    const remoteListeners = new Set<(event: EditorCollaborationRemoteFlowEvent) => void>()
    const api: EditorCollaborationApi = {
      getSnapshot: () => current,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      updateAwareness: () => undefined,
      updateFlowAuthority: () => undefined,
      subscribeRemoteFlow: listener => { remoteListeners.add(listener); return () => remoteListeners.delete(listener) },
    }
    collaborationService.configure(api)
    collaborationService.start()
    cleanups.push(() => collaborationService.stop())
    const remotePresentation = presentation(h.fence, { interactionId: 'lease:11111111-1111-4111-8111-111111111111', sampleSequence: 5 })
    const event = deepFreeze({ type: 'sample', source: 'roster', sample: {
      pageId: 'page-1', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'remote-client',
      leaseId: '11111111-1111-4111-8111-111111111111', localClaimGeneration: 1, reservationGeneration: 1,
      presentation: remotePresentation,
    } }) as unknown as Extract<EditorCollaborationRemoteFlowEvent, { type: 'sample' }>

    for (const listener of remoteListeners) listener(event)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([
      expect.objectContaining({ transaction: expect.objectContaining({ operation: { kind: 'publish', presentation: remotePresentation } }) }),
    ])

    const released = deepFreeze({ type: 'released', release: {
      presenceId: 'remote-presence', clientId: 'remote-client', leaseId: '11111111-1111-4111-8111-111111111111',
      interactionId: remotePresentation.identity.interactionId, localClaimGeneration: 1, reservationGeneration: 1,
      terminalSampleSequence: 10, reason: 'committed',
    } }) as unknown as EditorCollaborationRemoteFlowEvent
    for (const listener of remoteListeners) listener(released)
    expect(commands(h, 'apply-flow-drag-transaction').at(-1)).toEqual(expect.objectContaining({ transaction: expect.objectContaining({ operation: { kind: 'tombstone' } }) }))
    h.target.postMessage.mockClear()
    const latePresentation = presentation(h.fence, { interactionId: remotePresentation.identity.interactionId, sampleSequence: 6 })
    const lateEvent = deepFreeze({ ...event, sample: { ...event.sample, presentation: latePresentation } }) as unknown as EditorCollaborationRemoteFlowEvent
    for (const listener of remoteListeners) listener(lateEvent)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([])

    current = { ...current, status: 'reconnecting', canMutate: false }
    for (const listener of listeners) listener()
    current = { ...current, status: 'live', canMutate: true }
    for (const listener of listeners) listener()
    h.target.postMessage.mockClear()
    for (const listener of remoteListeners) listener(event)

    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([
      expect.objectContaining({ transaction: expect.objectContaining({ operation: { kind: 'publish', presentation: remotePresentation } }) }),
    ])
  })

  it.each([
    ['file', (fence: PreviewFlowDragSourceFence) => ({ ...fence, fileId: 'other-file' })],
    ['page', (fence: PreviewFlowDragSourceFence) => ({ ...fence, pageId: 'page-2' })],
    ['root', (fence: PreviewFlowDragSourceFence) => ({ ...fence, pageRootId: 'root-2' })],
    ['document', (fence: PreviewFlowDragSourceFence) => ({ ...fence, fileRevision: 1, documentRevision: 1 })],
    ['layout', (fence: PreviewFlowDragSourceFence) => ({ ...fence, layoutGeneration: fence.layoutGeneration + 1 })],
    ['measurement', (fence: PreviewFlowDragSourceFence) => ({ ...fence, measurementRevision: 10 })],
  ])('rejects stale %s authority without publishing or clearing another generation', (_label, mutate) => {
    const h = harness()
    expect(h.connection.publishFlowDragPresentation(presentation(deepFreeze(mutate(h.fence))))).toBe(false)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([])
  })

  it('rejects missing, mutable, singular, and world-mismatched absolute proof before transport', () => {
    const h = harness()
    const valid = presentation(h.fence, { mode: 'absolute' })
    const missing = deepFreeze({ ...valid, original: { ...valid.original, sourceOffsetParentPose: null } }) as FlowDragPresentation
    const mutable = structuredClone(valid) as FlowDragPresentation
    const singular = deepFreeze({ ...valid, original: { ...valid.original, sourceOffsetParentPose: { ...valid.original.sourceOffsetParentPose!, matrix: [0, 0, 0, 0, 15, 25] } } }) as FlowDragPresentation
    const mismatch = deepFreeze({ ...valid, original: { ...valid.original, sourceOffsetParentPose: { ...valid.original.sourceOffsetParentPose!, matrix: [1, 0, 0, 1, 16, 25] } } }) as FlowDragPresentation

    expect(h.connection.publishFlowDragPresentation(missing)).toBe(false)
    expect(h.connection.publishFlowDragPresentation(mutable)).toBe(false)
    expect(h.connection.publishFlowDragPresentation(singular)).toBe(false)
    expect(h.connection.publishFlowDragPresentation(mismatch)).toBe(false)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([])
  })

  it('rejects an accessor-backed proof without invoking it', () => {
    const h = harness()
    const valid = presentation(h.fence, { mode: 'absolute' })
    let reads = 0
    const hostilePose = Object.freeze({
      coordinateSpace: 'source-offset-parent' as const,
      offsetParentNodeId: null,
      sourceOffsetParentPaddingToWorld: valid.original.sourceOffsetParentPose!.sourceOffsetParentPaddingToWorld,
      get matrix() { reads += 1; return valid.original.sourceOffsetParentPose!.matrix },
    })
    const hostile = Object.freeze({ ...valid, original: Object.freeze({ ...valid.original, sourceOffsetParentPose: hostilePose }) }) as FlowDragPresentation

    expect(h.connection.publishFlowDragPresentation(hostile)).toBe(false)
    expect(reads).toBe(0)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([])
  })

  it('rejects same-sequence different contents and lower sequence or generation while keeping the newer publication', () => {
    const h = harness()
    const first = presentation(h.fence, { sampleSequence: 2 })
    expect(h.connection.publishFlowDragPresentation(first)).toBe(true)
    expect(h.connection.publishFlowDragPresentation(first)).toBe(true)
    expect(commands(h, 'apply-flow-drag-transaction')).toHaveLength(1)
    expect(h.connection.publishFlowDragPresentation(presentation(h.fence, { sampleSequence: 2, currentX: 16 }))).toBe(false)
    expect(h.connection.publishFlowDragPresentation(presentation(h.fence, { sampleSequence: 1 }))).toBe(false)
    expect(h.connection.publishFlowDragPresentation(presentation(h.fence, { gestureGeneration: 0, sampleSequence: 3 }))).toBe(false)
    expect(commands(h, 'apply-flow-drag-transaction')).toHaveLength(1)
  })

  it('requires an exact keyed tombstone and cannot let a stale sample clear a newer one', () => {
    const h = harness()
    const first = presentation(h.fence, { sampleSequence: 1 })
    const second = presentation(h.fence, { sampleSequence: 2 })
    expect(h.connection.publishFlowDragPresentation(first)).toBe(true)
    expect(h.connection.publishFlowDragPresentation(second)).toBe(true)
    h.target.postMessage.mockClear()

    expect(h.connection.clearFlowDragPresentation(retirement(first))).toBe(false)
    expect(h.connection.clearFlowDragPresentation(deepFreeze({}) as PreviewFlowDragRetirement)).toBe(false)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([])
    expect(h.connection.clearFlowDragPresentation(retirement(second))).toBe(true)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([
      expect.objectContaining({ transaction: { key: { interactionId: 'flow-drag-1', gestureGeneration: 1, sequence: 2 }, sourceFence: h.fence, operation: { kind: 'tombstone' } } }),
    ])
  })

  it('never lets the legacy local move channel coexist with an accepted flow transaction', () => {
    const h = harness()
    const sample = presentation(h.fence)
    expect(h.connection.publishFlowDragPresentation(sample)).toBe(true)
    h.target.postMessage.mockClear()
    documentStore.setTransient({ kind: 'move', rects: { frame: { x: 15, y: 25, width: 100, height: 50 } }, offset: { x: 5, y: 5 }, guides: [], targetFrameId: null, insertion: null })
    expect(commands(h, 'set-transient-move')).toEqual([])
    expect(h.connection.publishFlowDragPresentation(presentation(h.fence, { sampleSequence: 2 }))).toBe(false)
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([])
    documentStore.setTransient(null)
  })
})

describe('PAPER-FLEX-007-BRIDGE-V8 and CLOUD-SYNC-GESTURE-001-BRIDGE-V8 committed handoff', () => {
  it('posts terminal, handoff, document, and layout synchronously with matching retention policy', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 4, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()

    const receipt = h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })

    expect(h.target.postMessage.mock.calls.map(([command]) => command.type)).toStrictEqual(['apply-flow-drag-transaction', 'set-document', 'set-layout'])
    expect(commands(h, 'apply-flow-drag-transaction')[0]!.transaction.operation.kind).toBe('committed-handoff')
    expect(commands(h, 'set-document')[0]!.flowDragTerminalPolicy).toBe('preserve-matching-committed-handoff')
    expect(commands(h, 'set-layout')[0]!.flowDragTerminalPolicy).toBe('preserve-matching-committed-handoff')
    expect(receipt).toStrictEqual({ generation: 1, fileId: 'file-flow-bridge', pageId: 'page-1', documentRevision: 1,
      layoutGeneration: h.fence.layoutGeneration, afterMeasurementRevision: 10, interactionId: 'flow-drag-1', gestureGeneration: 1,
      terminalSequence: 4, sourceFence: h.fence })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(h.frames.size).toBe(0)
  })

  it('keeps the terminal ownership through stale geometry and releases only at the exact committed revision, layout, and measurement barrier', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 4, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).not.toBeNull()
    h.target.postMessage.mockClear()
    const nextFence = deepFreeze<PreviewFlowDragSourceFence>({ ...h.fence, fileRevision: 1, documentRevision: 1, measurementRevision: 10 })
    const next = presentation(nextFence, { interactionId: 'flow-drag-2', sampleSequence: 1 })

    h.deliver({ channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 1,
      layoutGeneration: h.fence.layoutGeneration, measurementRevision: 9, root: null, items: [] })
    expect(h.connection.publishFlowDragPresentation(next)).toBe(false)
    h.deliver({ channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 1,
      layoutGeneration: h.fence.layoutGeneration + 1, measurementRevision: 10, root: null, items: [] })
    expect(h.connection.publishFlowDragPresentation(next)).toBe(false)
    h.deliver({ channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 1,
      layoutGeneration: h.fence.layoutGeneration, measurementRevision: 10, root: null, items: [] })
    expect(h.connection.publishFlowDragPresentation(next)).toBe(true)
    expect(commands(h, 'apply-flow-drag-transaction').at(-1)!.transaction.operation.presentation).toBe(next)
  })

  it('rejects handoff when the source measurement fence advances after the terminal sample', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 4, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    h.deliver({ channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 0,
      layoutGeneration: h.fence.layoutGeneration, measurementRevision: 10, root: null, items: [] })
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()

    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toBeNull()
    expect(h.target.postMessage).not.toHaveBeenCalled()
  })

  it.each(['handoff', 'document', 'layout'] as const)('replays the exact handoff, document, and layout unit after a %s transport failure', failedType => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 5, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    const wireType = failedType === 'handoff' ? 'apply-flow-drag-transaction' : `set-${failedType}`
    let shouldThrow = true
    h.target.postMessage.mockImplementation(command => {
      if (command.type === wireType && shouldThrow) { shouldThrow = false; throw new Error(`${failedType} failed`) }
    })

    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toBeNull()
    expect(h.frames.size).toBe(1)
    const firstHandoff = commands(h, 'apply-flow-drag-transaction')[0]
    const firstDocument = commands(h, 'set-document')[0]
    const firstLayout = commands(h, 'set-layout')[0]
    const retryStart = h.target.postMessage.mock.calls.length
    h.flushAllFrames()
    const retried = h.target.postMessage.mock.calls.slice(retryStart).map(([command]) => command)
    expect(retried.map(command => command.type)).toStrictEqual(['apply-flow-drag-transaction', 'set-document', 'set-layout'])
    expect(retried[0]).toBe(firstHandoff)
    if (firstDocument) expect(retried[1]).toBe(firstDocument)
    if (firstLayout) expect(retried[2]).toBe(firstLayout)
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toEqual(expect.objectContaining({ terminalSequence: 5 }))
  })

  it('cancels recovery when the target changes and never replays the old unit to the replacement', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 6, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    h.target.postMessage.mockImplementationOnce(() => { throw new Error('handoff failed') })
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toBeNull()
    const replacement = { postMessage: vi.fn() }
    h.connection.connect(replacement as unknown as Window)
    editorStore.set({ previewReady: true })
    h.flushAllFrames()
    expect(replacement.postMessage.mock.calls.some(([command]) => command.type === 'apply-flow-drag-transaction' && command.transaction.operation.kind === 'committed-handoff')).toBe(false)
  })

  it('cancels recovery when a newer gesture generation advances the interaction and source fence', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 6, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    h.target.postMessage.mockImplementationOnce(() => { throw new Error('handoff failed') })
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toBeNull()
    documentStore.load(file(), [], { replace: true, pageId: 'page-1' })
    h.deliver({ channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 0,
      layoutGeneration: h.fence.layoutGeneration, measurementRevision: 10, root: null, items: [] })
    const advancedFence = deepFreeze<PreviewFlowDragSourceFence>({ ...h.fence, measurementRevision: 10 })
    expect(h.connection.publishFlowDragPresentation(presentation(advancedFence, { gestureGeneration: 2, sampleSequence: 1 }))).toBe(true)
    const retryStart = h.target.postMessage.mock.calls.length
    h.flushAllFrames()
    expect(h.target.postMessage.mock.calls.slice(retryStart).some(([command]) => command.type === 'apply-flow-drag-transaction' && command.transaction.operation.kind === 'committed-handoff')).toBe(false)
  })

  it('cancels recovery when the source measurement fence advances before retry', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 6, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    h.target.postMessage.mockImplementationOnce(() => { throw new Error('handoff failed') })
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toBeNull()
    h.deliver({ channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 0,
      layoutGeneration: h.fence.layoutGeneration, measurementRevision: 10, root: null, items: [] })
    const retryStart = h.target.postMessage.mock.calls.length
    h.flushAllFrames()
    expect(h.target.postMessage.mock.calls.slice(retryStart).some(([command]) => command.type === 'apply-flow-drag-transaction' && command.transaction.operation.kind === 'committed-handoff')).toBe(false)
  })

  it('cancels recovery when the committed document identity changes before retry', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 6, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    h.target.postMessage.mockImplementationOnce(() => { throw new Error('handoff failed') })
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toBeNull()
    documentStore.load(file(2), [], { replace: true, pageId: 'page-1' })
    const retryStart = h.target.postMessage.mock.calls.length
    h.flushAllFrames()
    expect(h.target.postMessage.mock.calls.slice(retryStart).some(([command]) => command.type === 'apply-flow-drag-transaction' && command.transaction.operation.kind === 'committed-handoff')).toBe(false)
  })

  it('cancels an orphaned committed hold when the document advances before its geometry barrier', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 8, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).not.toBeNull()
    h.target.postMessage.mockClear()
    documentStore.load(file(2), [], { replace: true, pageId: 'page-1' })
    h.flushAllFrames()
    expect(commands(h, 'apply-flow-drag-transaction')).toEqual([expect.objectContaining({ transaction: expect.objectContaining({ operation: { kind: 'tombstone' } }) })])
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: terminal })).toBeNull()

    h.deliver({ channel: 'design-editor-preview', version: 8, generation: 1, type: 'geometry', documentRevision: 2,
      layoutGeneration: h.fence.layoutGeneration, measurementRevision: 11, root: null, items: [] })
    const currentFence = deepFreeze<PreviewFlowDragSourceFence>({ ...h.fence, fileRevision: 2, documentRevision: 2, measurementRevision: 11 })
    expect(h.connection.publishFlowDragPresentation(presentation(currentFence, { interactionId: 'after-orphan', sampleSequence: 1 }))).toBe(true)
  })

  it('rejects a copied terminal, failed commit, stale committed document, and mismatched page before handoff', () => {
    const h = harness()
    const terminal = presentation(h.fence, { sampleSequence: 7, terminal: true })
    expect(h.connection.publishFlowDragPresentation(terminal)).toBe(true)
    documentStore.load(file(1), [], { replace: true, pageId: 'page-1' })
    const committed = documentStore.getSnapshot().file!
    h.target.postMessage.mockClear()
    const copied = deepFreeze(structuredClone(terminal)) as FlowDragPresentation
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: committed, terminalPresentation: copied })).toBeNull()
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: false }, committedFile: committed, terminalPresentation: terminal })).toBeNull()
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: file(1), terminalPresentation: terminal })).toBeNull()
    documentStore.setPage('page-2')
    expect(h.connection.syncCommittedFlowDrag({ commit: { committed: true }, committedFile: documentStore.getSnapshot().file, terminalPresentation: terminal })).toBeNull()
    expect(h.target.postMessage).not.toHaveBeenCalled()
  })
})
