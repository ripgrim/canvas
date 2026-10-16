// @vitest-environment happy-dom

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { childrenOf, createBlankFile } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { encodeInternalClipboardPayload } from './clipboard-codec'
import { createEditorClipboardService } from './editor-clipboard-service'
import { createInternalClipboardPayload } from './clipboard-internal'
import { documentStore } from './document-store'
import { internalClipboardBuffer } from './clipboard-internal-buffer'
import type { EditorAssetUpload, EditorAssetUploadResult, EditorPersistenceIntent } from '../../capabilities'

const paste = (text: string) => {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { types: ['text/plain'], files: [], getData: (type: string) => type === 'text/plain' ? text : '' } })
  return event
}

const copy = (values: Map<string, string>) => {
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => values.set(type, value) } })
  return event
}

const cut = (values: Map<string, string>) => {
  const event = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => values.set(type, value) } })
  return event
}

const pasteData = (values: ReadonlyMap<string, string>) => {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { types: [...values.keys()], files: [], getData: (type: string) => values.get(type) ?? '' } })
  return event
}

const pasteImage = (file: File) => {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { types: ['Files'], files: [file], getData: () => '' } })
  return event
}

const dropText = (text: string, clientX: number, clientY: number) => {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperties(event, {
    dataTransfer: { value: { types: ['text/plain'], files: [], getData: (type: string) => type === 'text/plain' ? text : '' } },
    clientX: { value: clientX },
    clientY: { value: clientY },
  })
  return event
}

afterEach(() => {
  documentStore.configure({})
  documentStore.setReadOnly(false)
  documentStore.load(createBlankFile('cleanup', 'cleanup-page', 'cleanup-root'), [], { replace: true })
  internalClipboardBuffer.clear()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
afterAll(() => documentStore.dispose())

describe('PAPER-CLIP-005 editor clipboard lifecycle', () => {
  it('turns one real paste event into one selected, undoable text node', async () => {
    documentStore.load(createBlankFile('file', 'page', 'root'), [])
    documentStore.setViewportSize({ width: 600, height: 400 })
    const service = createEditorClipboardService(window)
    service.start()
    const event = paste('From clipboard')
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(documentStore.getSnapshot().selection).toHaveLength(1))
    const state = documentStore.getSnapshot()
    const id = state.selection[0]!
    expect(state.file?.nodes[id]).toMatchObject({ type: 'text', text: 'From clipboard', styles: { relativeTransform: [1, 0, 0, 1, 0, 0] } })
    expect(state.canUndo).toBe(true)
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().file?.nodes[id]).toBeUndefined()
    service.stop()
  })

  it('places a real text drop at the pointer position inside the canvas viewport', async () => {
    documentStore.load(createBlankFile('drop-file', 'page', 'root'), [], { replace: true })
    documentStore.setViewportSize({ width: 600, height: 400 })
    const viewport = document.createElement('div')
    viewport.className = 'canvas-viewport'
    viewport.getBoundingClientRect = () => ({ left: 100, top: 50, right: 700, bottom: 450, x: 100, y: 50, width: 600, height: 400, toJSON: () => ({}) })
    document.body.append(viewport)
    const service = createEditorClipboardService(window)
    service.start()
    const event = dropText('At pointer', 250, 150)
    viewport.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(documentStore.getSnapshot().selection).toHaveLength(1))
    const state = documentStore.getSnapshot()
    expect(state.file?.nodes[state.selection[0]!]).toMatchObject({ type: 'text', text: 'At pointer', styles: { relativeTransform: [1, 0, 0, 1, -150, -100] } })
    expect(state.canUndo).toBe(true)
    service.stop()
  })

  it('inserts allowlisted HTML as structured text through the real clipboard event boundary', async () => {
    documentStore.load(createBlankFile('html-file', 'page', 'root'), [], { replace: true })
    documentStore.setViewportSize({ width: 600, height: 400 })
    const service = createEditorClipboardService(window)
    service.start()
    const event = paste('<p>Hello <strong>team</strong></p><ul><li>First</li><li>Second</li></ul>')
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(documentStore.getSnapshot().selection).toHaveLength(1))
    const state = documentStore.getSnapshot()
    expect(state.file?.nodes[state.selection[0]!]).toMatchObject({ type: 'text', text: 'Hello team\n• First\n• Second' })
    service.stop()
  })

  it('copies and pastes a validated same-file canvas subtree as one undo step', async () => {
    const file = createBlankFile('file', 'page', 'root')
    file.nodes.frame = { id: 'frame', type: 'frame', name: 'Card', styles: { relativeTransform: [1, 0, 0, 1, 40, 50], width: 120, height: 80 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'freeform' } } }
    file.nodes.label = { id: 'label', type: 'text', name: 'Label', text: 'Hello', styles: { relativeTransform: [1, 0, 0, 1, 10, 12], width: 50, height: 20 }, textStyle: { fontFamily: 'Arial', fontSize: 16, fontWeight: 400, fontStyle: 'normal', lineHeight: { kind: 'unitless', value: 1.2 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false }, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, layout: { item: { position: { mode: 'freeform' } } } }
    file.relationships.frame = { parentId: 'root', orderKey: 'V' }
    file.relationships.label = { parentId: 'frame', orderKey: 'V' }
    documentStore.load(file, [])
    documentStore.select('frame')
    const beforeCopy = documentStore.getSnapshot()
    expect(beforeCopy.selection).toEqual(['frame'])
    expect(() => createInternalClipboardPayload(beforeCopy.file!, beforeCopy.pageId!, beforeCopy.selection, beforeCopy.atoms)).not.toThrow()
    const service = createEditorClipboardService(window)
    service.start()
    const values = new Map<string, string>()
    const copied = copy(values)
    document.body.dispatchEvent(copied)
    expect(copied.defaultPrevented).toBe(true)
    expect(values.get('text/html')).toContain('design-editor-clipboard:v1')

    const pasted = pasteData(values)
    document.body.dispatchEvent(pasted)
    expect(pasted.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(Object.keys(documentStore.getSnapshot().file?.nodes ?? {})).toHaveLength(5))
    const state = documentStore.getSnapshot()
    expect(state.selection).toHaveLength(1)
    expect(state.file?.nodes[state.selection[0]!]).toMatchObject({ type: 'frame', styles: { relativeTransform: [1, 0, 0, 1, 180, 50] } })
    expect(documentStore.undo()).toBe(true)
    expect(Object.keys(documentStore.getSnapshot().file?.nodes ?? {})).toHaveLength(3)
    service.stop()
  })

  it('pastes a cross-file tree and its token closure through the real clipboard event boundary', async () => {
    const source = createBlankFile('source-file', 'source-page', 'source-root')
    source.theme.tokens.ink = { id: 'ink', type: 'color', name: 'Ink', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#123456' } } }
    source.nodes.card = { id: 'card', type: 'rectangle', name: 'Card', styles: { relativeTransform: [1, 0, 0, 1, 40, 50], width: 120, height: 80 }, appearance: { fills: [{ id: 'fill', type: 'solid', color: { kind: 'token', tokenId: 'ink' } }] } }
    source.relationships.card = { parentId: 'source-root', orderKey: 'V' }
    const payload = createInternalClipboardPayload(source, 'source-page', ['card'])
    const encoded = encodeInternalClipboardPayload(payload, 'Card')
    const onChange = vi.fn()
    documentStore.configure({ onChange })
    documentStore.load(createBlankFile('target-file', 'target-page', 'target-root'), [], { replace: true })
    const service = createEditorClipboardService(window)
    service.start()
    const event = pasteData(new Map([['text/html', encoded.html], ['text/plain', encoded.text]]))
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(documentStore.getSnapshot().selection).toHaveLength(1))
    const state = documentStore.getSnapshot()
    expect(state.file?.theme.tokens.ink).toEqual(source.theme.tokens.ink)
    expect(state.file?.nodes[state.selection[0]!]).toMatchObject({ type: 'rectangle', name: 'Card', appearance: { fills: [{ color: { kind: 'token', tokenId: 'ink' } }] } })
    expect(onChange).toHaveBeenCalledOnce()
    expect(state.canUndo).toBe(true)
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().file?.theme.tokens.ink).toBeUndefined()
    service.stop()
  })

  it('moves verified image bytes across files and commits the asset plus node as one undo step', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const data = btoa(String.fromCharCode(...bytes))
    const asset = { id: 'source-asset', name: 'Photo', mime: 'image/png' as const, extension: 'png' as const, bytes: 4, width: 1, height: 1, sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' }
    const source = createBlankFile('source-image-file', 'source-page', 'source-root')
    source.assets = { [asset.id]: asset }
    source.nodes.photo = { id: 'photo', type: 'rectangle', name: 'Photo', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 80, height: 60 }, appearance: { fills: [{ id: 'photo-fill', type: 'image', assetId: asset.id, fit: 'cover' }] } }
    source.relationships.photo = { parentId: 'source-root', orderKey: 'V' }
    const uploadImage = vi.fn(async (input: EditorAssetUpload): Promise<EditorAssetUploadResult> => ({
      asset: input.asset,
      preview: { assetId: input.asset.id, sha256: input.asset.sha256, mime: input.asset.mime, data: btoa(String.fromCharCode(...input.bytes)) },
    }))
    const onChange = vi.fn()
    const writes: { file: FileDocument; expectedRevision: number; intent: EditorPersistenceIntent }[] = []
    documentStore.configure({ uploadImage, onChange, persist: async (file, expectedRevision, intent) => {
      writes.push({ file, expectedRevision, intent })
      return { ...file, revision: expectedRevision + 1 }
    } })
    documentStore.load(source, [], { replace: true, assetPreviews: [{ assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data }] })
    documentStore.select('photo')
    const service = createEditorClipboardService(window)
    service.start()
    const values = new Map<string, string>()
    document.body.dispatchEvent(copy(values))
    documentStore.load(createBlankFile('target-image-file', 'target-page', 'target-root'), [], { replace: true })
    const event = pasteData(values)
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(Object.keys(documentStore.getSnapshot().file?.assets ?? {})).toHaveLength(1))
    const state = documentStore.getSnapshot()
    const targetAsset = Object.values(state.file?.assets ?? {})[0]!
    expect(uploadImage).toHaveBeenCalledOnce()
    expect(uploadImage.mock.calls[0]?.[0]).toMatchObject({ fileId: 'target-image-file', bytes })
    expect(state.file?.nodes[state.selection[0]!]).toMatchObject({ appearance: { fills: [{ type: 'image', assetId: targetAsset.id }] } })
    await documentStore.waitForPersistence()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ expectedRevision: 0, intent: { kind: 'commands', commands: [{ type: 'batch' }] } })
    expect(state.canUndo).toBe(true)
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().file?.assets).toBeUndefined()
    expect(Object.keys(documentStore.getSnapshot().file?.nodes ?? {})).toEqual(['target-root'])
    service.stop()
  })

  it('does not attach a cross-file image before upload verification or after target authority changes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const data = btoa(String.fromCharCode(...bytes))
    const asset = { id: 'source-asset', name: 'Photo', mime: 'image/png' as const, extension: 'png' as const, bytes: 4, width: 1, height: 1, sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' }
    const source = createBlankFile('source-image-file', 'source-page', 'source-root')
    source.assets = { [asset.id]: asset }
    source.nodes.photo = { id: 'photo', type: 'rectangle', name: 'Photo', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 80, height: 60 }, appearance: { fills: [{ id: 'photo-fill', type: 'image', assetId: asset.id, fit: 'cover' }] } }
    source.relationships.photo = { parentId: 'source-root', orderKey: 'V' }
    let finishUpload: ((value: EditorAssetUploadResult) => void) | undefined
    const uploadImage = vi.fn((_input: EditorAssetUpload) => new Promise<EditorAssetUploadResult>(resolve => { finishUpload = resolve }))
    documentStore.configure({ uploadImage })
    documentStore.load(source, [], { replace: true, assetPreviews: [{ assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data }] })
    documentStore.select('photo')
    const service = createEditorClipboardService(window)
    service.start()
    const values = new Map<string, string>()
    document.body.dispatchEvent(copy(values))
    documentStore.load(createBlankFile('target-image-file', 'target-page', 'target-root'), [], { replace: true })
    document.body.dispatchEvent(pasteData(values))
    await vi.waitFor(() => expect(uploadImage).toHaveBeenCalledOnce())
    expect(documentStore.getSnapshot().file?.assets).toBeUndefined()
    expect(Object.keys(documentStore.getSnapshot().file?.nodes ?? {})).toEqual(['target-root'])
    documentStore.load(createBlankFile('next-file', 'next-page', 'next-root'), [], { replace: true })
    const uploaded = uploadImage.mock.calls[0]![0].asset
    finishUpload?.({ asset: uploaded, preview: { assetId: uploaded.id, sha256: uploaded.sha256, mime: uploaded.mime, data } })
    await vi.waitFor(() => expect(documentStore.getSnapshot().file?.fileId).toBe('next-file'))
    await Promise.resolve()
    expect(documentStore.getSnapshot().file?.assets).toBeUndefined()
    expect(Object.keys(documentStore.getSnapshot().file?.nodes ?? {})).toEqual(['next-root'])
    service.stop()
  })

  it('writes the internal payload before deleting a cut subtree and restores it with one undo', () => {
    const file = createBlankFile('cut-file', 'page', 'root')
    file.nodes.frame = { id: 'frame', type: 'frame', name: 'Card', styles: { relativeTransform: [1, 0, 0, 1, 40, 50], width: 120, height: 80 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'freeform' } } }
    file.relationships.frame = { parentId: 'root', orderKey: 'V' }
    documentStore.load(file, [], { replace: true })
    documentStore.select('frame')
    const service = createEditorClipboardService(window)
    service.start()
    const values = new Map<string, string>()
    const event = cut(values)
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(values.get('text/html')).toContain('design-editor-clipboard:v1')
    expect(documentStore.getSnapshot().file?.nodes.frame).toBeUndefined()
    expect(documentStore.getSnapshot().canUndo).toBe(true)
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().file?.nodes.frame).toMatchObject({ type: 'frame', name: 'Card' })
    service.stop()
  })

  it.each([
    ['selection', () => documentStore.select('other')],
    ['read-only policy', () => documentStore.setReadOnly(true)],
    ['document generation', () => documentStore.load(structuredClone(documentStore.getSnapshot().file!), [], { replace: true })],
    ['file identity', () => {
      const next = structuredClone(documentStore.getSnapshot().file!)
      next.fileId = 'other-authority-file'
      documentStore.load(next, [], { replace: true })
    }],
    ['page', () => documentStore.setPage('page-two')],
    ['layout generation', () => documentStore.commands.layout.gesture.begin()],
  ])('does not cut the captured roots after %s changes while clipboard bytes are written', (_label, drift) => {
    const file = createBlankFile('authority-file', 'page', 'root')
    file.pages.push({ id: 'page-two', name: 'Page two', rootNodeId: 'root-two' })
    file.nodes['root-two'] = { id: 'root-two', type: 'root' }
    file.nodes.frame = { id: 'frame', type: 'rectangle', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 40, height: 20 } }
    file.nodes.other = { id: 'other', type: 'rectangle', name: 'Other', styles: { relativeTransform: [1, 0, 0, 1, 80, 10], width: 40, height: 20 } }
    file.relationships.frame = { parentId: 'root', orderKey: 'A' }
    file.relationships.other = { parentId: 'root', orderKey: 'B' }
    documentStore.load(file, [], { replace: true })
    documentStore.select('frame')
    const service = createEditorClipboardService(window)
    service.start()
    const values = new Map<string, string>()
    let writes = 0
    const event = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => {
      values.set(type, value)
      if (++writes === 1) drift()
    } } })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(values.get('text/html')).toContain('design-editor-clipboard:v1')
    expect(documentStore.getSnapshot().file?.nodes.frame).toBeDefined()
    expect(documentStore.getSnapshot().file?.nodes.other).toBeDefined()
    expect(documentStore.getSnapshot().canUndo).toBe(false)
    service.stop()
  })

  it('does not cut the captured roots after the file revision changes', () => {
    const file = createBlankFile('revision-file', 'page', 'root')
    file.nodes.frame = { id: 'frame', type: 'rectangle', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 40, height: 20 } }
    file.nodes.other = { id: 'other', type: 'rectangle', name: 'Other', styles: { relativeTransform: [1, 0, 0, 1, 80, 10], width: 40, height: 20 } }
    file.relationships.frame = { parentId: 'root', orderKey: 'A' }
    file.relationships.other = { parentId: 'root', orderKey: 'B' }
    documentStore.load(file, [], { replace: true })
    documentStore.select('frame')
    const service = createEditorClipboardService(window)
    service.start()
    let writes = 0
    const event = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: { setData: () => {
      if (++writes === 1) documentStore.commands.execute({ type: 'node.rename', nodeId: 'other', name: 'Changed' })
    } } })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(documentStore.getSnapshot().file?.nodes.frame).toBeDefined()
    expect(documentStore.getSnapshot().file?.nodes.other).toMatchObject({ name: 'Changed' })
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getHistory().past).toHaveLength(1)
    service.stop()
  })

  it('drops prepared image work after the open document changes', async () => {
    const pending: { release?: (value: { width: number; height: number; close(): void }) => void } = {}
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { pending.release = resolve })))
    documentStore.load(createBlankFile('source-file', 'page', 'root'), [], { replace: true })
    const service = createEditorClipboardService(window)
    service.start()
    const event = pasteImage(new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' }))
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    documentStore.load(createBlankFile('next-file', 'next-page', 'next-root'), [], { replace: true })
    pending.release?.({ width: 12, height: 8, close() {} })
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalled())
    await Promise.resolve()
    expect(documentStore.getSnapshot().file?.fileId).toBe('next-file')
    expect(documentStore.getSnapshot().file?.assets).toBeUndefined()
    expect(Object.keys(documentStore.getSnapshot().file?.nodes ?? {})).toEqual(['next-root'])
    service.stop()
  })

  it('turns an image ClipboardEvent into one selected, undoable image layer', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 12, height: 8, close() {} })))
    documentStore.load(createBlankFile('image-file', 'page', 'root'), [], { replace: true })
    documentStore.setViewportSize({ width: 600, height: 400 })
    const service = createEditorClipboardService(window)
    service.start()
    const event = pasteImage(new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' }))
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(Object.keys(documentStore.getSnapshot().file?.assets ?? {})).toHaveLength(1))
    const state = documentStore.getSnapshot()
    expect(state.selection).toHaveLength(1)
    expect(state.file?.nodes[state.selection[0]!]).toMatchObject({ type: 'rectangle', name: 'photo', styles: { width: 12, height: 8 }, appearance: { fills: [{ type: 'image', fit: 'cover' }] } })
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().file?.assets).toBeUndefined()
    service.stop()
  })

  it('pastes text and an image into Flex in source order with one mutation and an exact semantic undo and redo', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const data = btoa(String.fromCharCode(...bytes))
    const asset = { id: 'source-flex-asset', name: 'Photo', mime: 'image/png' as const, extension: 'png' as const, bytes: 4, width: 1, height: 1, sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' }
    const source = createBlankFile('source-flex-file', 'source-page', 'source-root')
    source.assets = { [asset.id]: asset }
    source.nodes['source-text'] = {
      id: 'source-text', type: 'text', name: 'Label', text: 'Pasted label',
      styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 90, height: 24 },
      textStyle: { fontFamily: 'Arial', fontSize: 16, fontWeight: 400, fontStyle: 'normal', lineHeight: { kind: 'unitless', value: 1.2 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
    }
    source.nodes['source-photo'] = {
      id: 'source-photo', type: 'rectangle', name: 'Photo', styles: { relativeTransform: [1, 0, 0, 1, 130, 30], width: 80, height: 60 },
      appearance: { fills: [{ id: 'source-photo-fill', type: 'image', assetId: asset.id, fit: 'cover' }] },
    }
    source.relationships['source-text'] = { parentId: 'source-root', orderKey: 'A' }
    source.relationships['source-photo'] = { parentId: 'source-root', orderKey: 'B' }

    documentStore.load(source, [], { replace: true, assetPreviews: [{ assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data }] })
    documentStore.selectMany(['source-text', 'source-photo'])
    const service = createEditorClipboardService(window)
    service.start()
    const values = new Map<string, string>()
    const copied = copy(values)
    document.body.dispatchEvent(copied)
    expect(copied.defaultPrevented).toBe(true)

    const target = createBlankFile('target-flex-file', 'target-page', 'target-root')
    target.nodes.flex = {
      id: 'flex', type: 'frame', name: 'Flex', styles: { relativeTransform: [1, 0, 0, 1, 100, 100], width: 400, height: 120 },
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    }
    target.nodes.existing = {
      id: 'existing', type: 'rectangle', name: 'Existing', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 40 },
      layout: { item: { position: { mode: 'flow' } } },
    }
    target.relationships.flex = { parentId: 'target-root', orderKey: 'A' }
    target.relationships.existing = { parentId: 'flex', orderKey: 'A' }
    documentStore.load(target, [], { replace: true })
    documentStore.select('existing')
    const changes: FileDocument[] = []
    documentStore.configure({
      onChange: file => changes.push(file),
      uploadImage: async input => ({ asset: input.asset, preview: { assetId: input.asset.id, sha256: input.asset.sha256, mime: input.asset.mime, data } }),
    })
    const beforePaste = structuredClone(documentStore.getSnapshot().file!)

    const pasted = pasteData(values)
    document.body.dispatchEvent(pasted)
    expect(pasted.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(documentStore.getSnapshot().selection).toHaveLength(2))
    const pastedState = documentStore.getSnapshot()
    const [textId, photoId] = pastedState.selection
    expect(changes).toHaveLength(1)
    expect(documentStore.getHistory().past).toHaveLength(1)
    expect(childrenOf(pastedState.file!, 'flex')).toEqual(['existing', textId, photoId])
    expect(pastedState.file?.nodes[textId!]).toMatchObject({ type: 'text', text: 'Pasted label', styles: { relativeTransform: [1, 0, 0, 1, 0, 0] }, layout: { item: { position: { mode: 'flow' } } } })
    expect(pastedState.file?.nodes[photoId!]).toMatchObject({ type: 'rectangle', styles: { relativeTransform: [1, 0, 0, 1, 0, 0] }, layout: { item: { position: { mode: 'flow' } } }, appearance: { fills: [{ type: 'image' }] } })
    const afterPaste = structuredClone(pastedState.file!)
    const semantic = (file: FileDocument) => ({ ...structuredClone(file), revision: 0 })

    expect(documentStore.undo()).toBe(true)
    expect(semantic(documentStore.getSnapshot().file!)).toEqual(semantic(beforePaste))
    expect(documentStore.getSnapshot().selection).toEqual(['existing'])
    expect(documentStore.redo()).toBe(true)
    expect(semantic(documentStore.getSnapshot().file!)).toEqual(semantic(afterPaste))
    expect(documentStore.getSnapshot().selection).toEqual([textId, photoId])
    service.stop()
  })
})
