// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { ImageAssetReference } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'

const source = (name: string) => new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' })
const idFactory = () => { let id = 0; return () => `new-${++id}` }
const stores: ReturnType<typeof createDocumentStore>[] = []
const store = () => {
  const value = createDocumentStore(idFactory())
  stores.push(value)
  value.load(createBlankFile('file', 'page', 'root'), [], { replace: true })
  value.setViewportSize({ width: 600, height: 400 })
  return value
}
const preview = (asset: ImageAssetReference) => ({ assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data: btoa(String.fromCharCode(1, 2, 3, 4)) })

afterEach(() => {
  for (const value of stores.splice(0)) value.dispose()
  vi.unstubAllGlobals()
})

describe('PAPER-CLIP-006 and PAPER-CLIP-008 atomic clipboard image insertion', () => {
  it('attaches assets and inserts every image in one undoable document batch', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 20, close() {} })))
    const value = store()
    const onChange = vi.fn()
    value.configure({ uploadImage: async input => ({ asset: input.asset, preview: preview(input.asset) }), onChange })
    const result = await value.commands.assets.insertClipboard([{ file: source('photo.png'), width: 10, height: 20 }])
    expect(result).toEqual({ inserted: ['new-2'], failures: [] })
    expect(value.getSnapshot().file?.assets?.['new-1']).toMatchObject({ name: 'photo.png', width: 10, height: 20 })
    expect(value.getSnapshot().file?.nodes['new-2']).toMatchObject({ type: 'rectangle', appearance: { fills: [{ assetId: 'new-1' }] } })
    expect(value.getHistory().past).toHaveLength(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(value.undo()).toBe(true)
    expect(value.getSnapshot().file?.assets).toBeUndefined()
    expect(value.getSnapshot().file?.nodes['new-2']).toBeUndefined()
  })

  it('waits for all uploads, then commits successful images once and reports partial failure', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 20, close() {} })))
    const value = store()
    let resolveGood: () => void = () => undefined
    let goodReady = false
    let goodStarted = false
    value.configure({ uploadImage: input => input.asset.name === 'bad.png'
      ? Promise.reject(new Error('Upload failed'))
      : new Promise(resolve => { goodStarted = true; resolveGood = () => { goodReady = true; resolve({ asset: input.asset, preview: preview(input.asset) }) } }) })
    const inserting = value.commands.assets.insertClipboard([
      { file: source('good.png'), width: 10, height: 20 },
      { file: source('bad.png'), width: 10, height: 20 },
    ])
    await vi.waitFor(() => expect(goodStarted).toBe(true))
    expect(value.getSnapshot().file?.assets).toBeUndefined()
    expect(value.getHistory().past).toHaveLength(0)
    resolveGood()
    const result = await inserting
    expect(goodReady).toBe(true)
    expect(result.inserted).toHaveLength(1)
    expect(result.failures).toEqual([{ name: 'bad.png', diagnostic: 'Upload failed' }])
    expect(value.getHistory().past).toHaveLength(1)
  })

  it('drops staged uploads when document authority changes before commit', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 20, close() {} })))
    const value = store()
    let finish: () => void = () => undefined
    let started = false
    value.configure({ uploadImage: input => new Promise(resolve => { started = true; finish = () => resolve({ asset: input.asset, preview: preview(input.asset) }) }) })
    const inserting = value.commands.assets.insertClipboard([{ file: source('photo.png'), width: 10, height: 20 }])
    await vi.waitFor(() => expect(started).toBe(true))
    expect(value.commands.insertCanvas('rectangle', { x: 0, y: 0 })).toBe(true)
    finish()
    const result = await inserting
    expect(result.inserted).toEqual([])
    expect(result.failures[0]?.diagnostic).toBe('The canvas changed before the images were ready.')
    expect(value.getSnapshot().file?.assets).toBeUndefined()
    expect(value.getHistory().past).toHaveLength(1)
  })

  it('rejects an invalid candidate during semantic preflight before upload or decode', async () => {
    const decode = vi.fn()
    const uploadImage = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const value = store()
    value.configure({ uploadImage })
    const result = await value.commands.assets.insertClipboard([{ file: new File(['nope'], 'note.txt', { type: 'text/plain' }), width: 10, height: 20 }])
    expect(result.inserted).toEqual([])
    expect(result.failures).toHaveLength(1)
    expect(uploadImage).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
    expect(value.getHistory().past).toHaveLength(0)
  })
})
