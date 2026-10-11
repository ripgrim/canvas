import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ProjectSnapshot } from './types'
import { isPreviewDocument } from '@canvas/preview-runtime/protocol'
import { createPreviewConnection } from './preview-service'
import { documentStore } from './document-store'
import { editorStore } from './store'

const file = (): FileDocument => ({
  schemaVersion: 7,
  fileId: 'file-preview-assets',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    photo: { id: 'photo', type: 'rectangle', name: 'Photo', styles: { left: 0, top: 0, width: 80, height: 60 }, appearance: { fills: [{ id: 'photo-fill', type: 'image', assetId: 'photo-asset', fit: 'cover' }] } },
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
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('window', { document: { querySelector: () => null }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
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
  const target = { postMessage: vi.fn() }
  const connection = createPreviewConnection({ resolveAsset: () => asset })
  connection.start()
  connection.connect(target as unknown as Window)
  target.postMessage.mockClear()
  const setSpy = vi.spyOn(editorStore, 'set')
  editorStore.set({ previewReady: true })
  const cleanup = () => { connection.stop(); setSpy.mockRestore(); vi.unstubAllGlobals() }
  cleanups.push(cleanup)
  return { frames, flushAllFrames, setAsset: (next: ResolvedAsset) => { asset = next }, target, setSpy }
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  editorStore.set({ snapshot: null, previewReady: false, previewThemeId: null, runtimeInstanceIds: null, compositionPreview: false, error: null })
})

describe('FILE-ASSET-001 and ERROR-VISIBILITY-001 preview connection hydration', () => {
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
})
