import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ProjectSnapshot } from './types'
import { isPreviewDocument } from '@canvas/preview-runtime/protocol'
import { createPreviewConnection } from './preview-service'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { sceneGeometry } from './scene-geometry'
import { previewCameraStore } from './preview-camera-store'

const file = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'file-preview-assets',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    photo: { id: 'photo', type: 'rectangle', name: 'Photo', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 60 }, appearance: { fills: [{ id: 'photo-fill', type: 'image', assetId: 'photo-asset', fit: 'cover' }] } },
  },
  relationships: { photo: { parentId: 'root-1', orderKey: 'V' } },
  assets: { 'photo-asset': { id: 'photo-asset', name: 'photo.png', mime: 'image/png', extension: 'png', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) } },
  theme: { tokens: {} },
})

const snapshot = (document: FileDocument): ProjectSnapshot => ({
  projectId: 'project-preview-assets', fileId: document.fileId, atoms: [], sourceHashes: {},
  composition: { id: 'composition-preview-assets', name: 'Preview assets', componentId: null, children: [] },
  file: document, sourceHistory: [], conflict: null, phases: [{ name: 'Read source', completed: 1 }], tokens: [],
  preview: { status: 'ready', currentGeneration: 1, activeGeneration: 1, origin: 'https://preview.test', url: 'https://preview.test/build/1/index.html', stale: false, diagnostics: [] },
  designThemes: [{ id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }],
})

type ResolvedAsset = { mime: string; data: string } | null
const cleanups: (() => void)[] = []

function harness() {
  let asset: ResolvedAsset = null
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
  documentStore.load(document, [], { replace: true })
  editorStore.set({ snapshot: snapshot(document), previewReady: false, previewThemeId: 'default', runtimeInstanceIds: null, compositionPreview: true, error: null })
  const connection = createPreviewConnection({ resolveAsset: () => asset })
  connection.start()
  connection.connect(target as unknown as Window)
  target.postMessage.mockClear()
  const setSpy = vi.spyOn(editorStore, 'set')
  editorStore.set({ previewReady: true })
  const cleanup = () => { connection.stop(); setSpy.mockRestore(); vi.unstubAllGlobals() }
  cleanups.push(cleanup)
  return { connection, frames, flushAllFrames, setAsset: (next: ResolvedAsset) => { asset = next }, target, setSpy, deliver: (data: unknown) => messageListener?.({ data, origin: 'https://preview.test', source: target } as unknown as MessageEvent) }
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  editorStore.set({ snapshot: null, previewReady: false, previewThemeId: null, runtimeInstanceIds: null, compositionPreview: false, error: null })
  previewCameraStore.reset()
})

describe('FILE-ASSET-001 and ERROR-VISIBILITY-001 preview connection hydration', () => {
  it('AT-CAN-PAN-001 publishes only the newest camera once per frame during a pan', () => {
    const { deliver, flushAllFrames, setAsset, target } = harness()
    setAsset({ mime: 'image/png', data: 'AAAA' })
    flushAllFrames()
    target.postMessage.mockClear()

    documentStore.setTransient({ kind: 'pan' })
    documentStore.setViewport({ x: 10, y: 15, zoom: 1 })
    documentStore.setViewport({ x: 24, y: 31, zoom: 1 })

    expect(target.postMessage.mock.calls.filter(([command]) => command.type === 'set-camera')).toHaveLength(0)
    flushAllFrames()
    const cameras = target.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === 'set-camera')
    expect(cameras).toStrictEqual([expect.objectContaining({ sequence: expect.any(Number), camera: { x: 24, y: 31, zoom: 1, width: 0, height: 0 } })])
    const pending = { generation: 1, sentSequence: cameras[0]!.sequence, appliedSequence: -1, camera: null, settled: false }
    expect(previewCameraStore.getSnapshot()).toStrictEqual(pending)
    deliver({ channel: 'design-editor-preview', version: 9, generation: 1, type: 'camera-applied', sequence: cameras[0]!.sequence, camera: { x: 10, y: 15, zoom: 1, width: 0, height: 0 } })
    expect(previewCameraStore.getSnapshot()).toStrictEqual(pending)
    deliver({ channel: 'design-editor-preview', version: 9, generation: 1, type: 'camera-applied', sequence: cameras[0]!.sequence, camera: cameras[0]!.camera })
    expect(previewCameraStore.getSnapshot()).toStrictEqual({ generation: 1, sentSequence: cameras[0]!.sequence, appliedSequence: cameras[0]!.sequence, camera: cameras[0]!.camera, settled: true })
    documentStore.setTransient(null)
    flushAllFrames()
  })

  it('AT-CAN-005 forwards every distinct live transform without waiting for another animation frame', () => {
    const { flushAllFrames, setAsset, target } = harness()
    setAsset({ mime: 'image/png', data: 'AAAA' })
    flushAllFrames()
    target.postMessage.mockClear()

    documentStore.setTransient({ kind: 'move', rects: { photo: { x: 12, y: 8, width: 80, height: 60 } }, offset: { x: 12, y: 8 }, guides: [], targetFrameId: null, insertion: null })
    documentStore.setTransient({ kind: 'move', rects: { photo: { x: 19, y: 13, width: 80, height: 60 } }, offset: { x: 19, y: 13 }, guides: [], targetFrameId: null, insertion: null })

    expect(target.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === 'set-transient-move')).toEqual([
      expect.objectContaining({ items: [{ nodeId: 'photo', dx: 12, dy: 8 }] }),
      expect.objectContaining({ items: [{ nodeId: 'photo', dx: 19, dy: 13 }] }),
    ])
    documentStore.setTransient(null)
  })

  it('publishes no document for unavailable bytes, reports once, then recovers through the queued connection', () => {
    const { frames, flushAllFrames, setAsset, target, setSpy } = harness()
    const message = 'Image "photo.png" is unavailable in this session. Reattach it to preview this file.'
    flushAllFrames()

    expect(target.postMessage.mock.calls.some(([command]) => command.type === 'set-document')).toBe(false)
    expect(editorStore.getSnapshot().error).toBe(message)
    expect(setSpy.mock.calls.filter(([patch]) => patch.error === message)).toHaveLength(1)
    expect(frames.size).toBe(0)

    setAsset({ mime: 'image/png', data: 'AAAA' })
    editorStore.set({ notice: 'Retry preview hydration' })
    flushAllFrames()

    const documents = target.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === 'set-document')
    expect(documents).toHaveLength(1)
    expect(isPreviewDocument(documents[0]!.document)).toBe(true)
    expect(documents[0]!.flowDragTerminalPolicy).toBe('preserve-matching-committed-handoff')
    const layouts = target.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === 'set-layout')
    expect(layouts.at(-1)?.flowDragTerminalPolicy).toBe('preserve-matching-committed-handoff')
    expect(documents[0]!.document.assets).toEqual({ 'photo-asset': { mime: 'image/png', data: 'AAAA' } })
    expect(editorStore.getSnapshot().error).toBeNull()
    expect(setSpy.mock.calls.filter(([patch]) => patch.error === null)).toHaveLength(1)
    expect(frames.size).toBe(0)
  })

  it('does not clear a newer error owned by another operation when asset hydration recovers', () => {
    const { flushAllFrames, setAsset, target } = harness()
    flushAllFrames()
    expect(editorStore.getSnapshot().error).toContain('unavailable in this session')

    editorStore.set({ error: 'A newer save failure must remain visible.' })
    setAsset({ mime: 'image/png', data: 'AAAA' })
    flushAllFrames()

    expect(editorStore.getSnapshot().error).toBe('A newer save failure must remain visible.')
    expect(target.postMessage.mock.calls.filter(([command]) => command.type === 'set-document')).toHaveLength(1)
  })

  it('stores the exact accepted runtime measurement token and does not advance it for a rejected geometry event', () => {
    const { deliver, flushAllFrames, setAsset } = harness()
    setAsset({ mime: 'image/png', data: 'AAAA' })
    flushAllFrames()
    const before = sceneGeometry.getSnapshot().revision
    deliver({
      channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 1, layoutGeneration: 0, measurementRevision: 40, root: null, items: [],
    })
    expect(sceneGeometry.getSnapshot().revision).toBe(before)
    const acceptedPayload = {
      channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 41, root: null,
      camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
      items: [{ instanceId: 'photo', source: 'canvas', canvasKind: 'rectangle', bounds: { x: 400, y: 300, width: 80, height: 60 }, worldAabb: { x: 400, y: 300, width: 80, height: 60 }, offset: { x: 0, y: 0, width: 80, height: 60, origin: { x: 40, y: 30 } }, offsetParentNodeId: null, directChild: true }],
    }
    deliver(acceptedPayload)
    expect(sceneGeometry.getSnapshot()).toMatchObject({ documentRevision: 0, layoutGeneration: 0, revision: 41, nodes: { photo: { worldAabb: { x: 0, y: 0, width: 80, height: 60 }, offsetParentNodeId: null } } })
  })

  it('AT-APP-005 republishes an unchanged projection after a readiness interruption so geometry can recover', () => {
    const { deliver, flushAllFrames, setAsset, target } = harness()
    setAsset({ mime: 'image/png', data: 'AAAA' })
    flushAllFrames()
    deliver({
      channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 51, root: null,
      camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
      items: [{ instanceId: 'photo', source: 'canvas', canvasKind: 'rectangle', bounds: { x: 400, y: 300, width: 80, height: 60 }, worldAabb: { x: 400, y: 300, width: 80, height: 60 }, offset: { x: 0, y: 0, width: 80, height: 60, origin: { x: 40, y: 30 } }, offsetParentNodeId: null, directChild: true }],
    })
    expect(sceneGeometry.getSnapshot().revision).toBe(51)

    editorStore.set({ previewReady: false })
    expect(sceneGeometry.getSnapshot()).toMatchObject({ nodes: {}, gap: 'temporary' })
    target.postMessage.mockClear()
    editorStore.set({ previewReady: true })
    flushAllFrames()
    expect(target.postMessage.mock.calls.some(([command]) => command.type === 'set-document')).toBe(true)
    expect(target.postMessage.mock.calls.some(([command]) => command.type === 'set-layout')).toBe(true)

    deliver({
      channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 52, root: null,
      camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
      items: [{ instanceId: 'photo', source: 'canvas', canvasKind: 'rectangle', bounds: { x: 400, y: 300, width: 80, height: 60 }, worldAabb: { x: 400, y: 300, width: 80, height: 60 }, offset: { x: 0, y: 0, width: 80, height: 60, origin: { x: 40, y: 30 } }, offsetParentNodeId: null, directChild: true }],
    })
    expect(sceneGeometry.getSnapshot()).toMatchObject({ revision: 52, documentRevision: 0, layoutGeneration: 0, nodes: { photo: expect.any(Object) } })
    expect(sceneGeometry.getSnapshot().gap).toBeUndefined()
  })

  it('makes geometry unavailable on disconnect and accepts a reset runtime token from a replacement generation', () => {
    const { connection, deliver, flushAllFrames, setAsset, target } = harness()
    setAsset({ mime: 'image/png', data: 'AAAA' })
    flushAllFrames()
    deliver({ channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 73, root: null, items: [] })
    expect(sceneGeometry.getSnapshot()).toMatchObject({ revision: 73, documentRevision: 0, layoutGeneration: 0 })
    connection.disconnect()
    expect(sceneGeometry.getSnapshot()).toMatchObject({ revision: 0, documentRevision: null, layoutGeneration: null, nodes: {} })

    const current = editorStore.getSnapshot().snapshot!
    editorStore.set({ snapshot: { ...current, preview: { ...current.preview, currentGeneration: 2, activeGeneration: 2 } } })
    connection.connect(target as unknown as Window)
    deliver({ channel: 'design-editor-preview', version: 9, generation: 2, type: 'ready', componentId: 'preview-assets' })
    deliver({ channel: 'design-editor-preview', version: 9, generation: 2, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 1, root: null, items: [] })
    expect(sceneGeometry.getSnapshot()).toMatchObject({ revision: 0, documentRevision: null, layoutGeneration: null, nodes: {}, gap: 'temporary' })

    flushAllFrames()
    deliver({ channel: 'design-editor-preview', version: 9, generation: 2, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 1, root: null, items: [] })
    expect(sceneGeometry.getSnapshot()).toMatchObject({ revision: 1, documentRevision: 0, layoutGeneration: 0, nodes: {} })
  })

  it('AT-APP-005 rejects startup geometry until the replacement runtime receives the current projection', () => {
    const { connection, deliver, flushAllFrames, setAsset, target } = harness()
    setAsset({ mime: 'image/png', data: 'AAAA' })
    flushAllFrames()
    deliver({ channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 8, root: null, items: [] })
    expect(sceneGeometry.getSnapshot().revision).toBe(8)

    connection.connect(target as unknown as Window)
    deliver({ channel: 'design-editor-preview', version: 9, generation: 1, type: 'ready', componentId: 'preview-assets' })
    deliver({
      channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 1, root: null,
      camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
      items: [{ instanceId: 'photo', source: 'canvas', canvasKind: 'rectangle', bounds: { x: 400, y: 300, width: 80, height: 60 }, worldAabb: { x: 400, y: 300, width: 80, height: 60 } }],
    })
    expect(sceneGeometry.getSnapshot()).toMatchObject({ nodes: {}, revision: 0, documentRevision: null, layoutGeneration: null, gap: 'temporary' })

    flushAllFrames()
    expect(target.postMessage.mock.calls.some(([command]) => command.type === 'set-camera')).toBe(true)
    expect(target.postMessage.mock.calls.some(([command]) => command.type === 'set-document')).toBe(true)
    deliver({
      channel: 'design-editor-preview', version: 9, generation: 1, type: 'geometry', documentRevision: 0, layoutGeneration: 0, measurementRevision: 2, root: null,
      camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
      items: [{ instanceId: 'photo', source: 'canvas', canvasKind: 'rectangle', bounds: { x: 400, y: 300, width: 80, height: 60 }, worldAabb: { x: 400, y: 300, width: 80, height: 60 } }],
    })
    expect(sceneGeometry.getSnapshot()).toMatchObject({ revision: 2, documentRevision: 0, layoutGeneration: 0, nodes: { photo: expect.any(Object) } })
  })
})
