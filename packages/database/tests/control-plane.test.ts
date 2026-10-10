import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../../repo-engine/src/file-document'
import { createMemoryControlPlane } from '../src/memory'

describe('control-plane file documents', () => {
  it('creates a canonical blank document accepted by the editor validator', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Blank', null)
    const opened = await store.getFileDocument('owner', file.id)
    expect(opened).not.toBeNull()
    const document = validateFileDocument(opened!.document, [])
    expect(document).toMatchObject({ schemaVersion: 6, fileId: file.id, revision: 0, pages: [{ name: 'Page 1' }], theme: { tokens: {} } })
    expect(Object.values(document.nodes)).toEqual([{ id: document.pages[0]!.rootNodeId, type: 'root' }])
  })

  it('AT-THUMB-001 updates, invalidates, and clears revision-bound thumbnail metadata', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Thumbnail', null)
    const key = `thumbnails/${file.id}/thumbnail.avif`

    expect(await store.setFileThumbnail('owner', file.id, 0, key)).toEqual({
      status: 'saved',
      thumbnail: { fileId: file.id, revision: 0, thumbnailKey: key },
    })
    expect(await store.setFileThumbnail('other-owner', file.id, 0, null)).toEqual({ status: 'not-found' })
    expect((await store.getFile('owner', file.id))?.thumbnailKey).toBe(key)

    const opened = await store.getFileDocument('owner', file.id)
    expect(opened).not.toBeNull()
    const saved = await store.saveFileDocument('owner', file.id, 0, { ...opened!.document, revision: 1 })
    expect(saved.status).toBe('saved')
    expect((await store.getFile('owner', file.id))?.thumbnailKey).toBeNull()

    expect((await store.setFileThumbnail('owner', file.id, 1, key)).status).toBe('saved')
    expect(await store.setFileThumbnail('owner', file.id, 0, null)).toEqual({ status: 'conflict', currentRevision: 1 })
    expect((await store.getFile('owner', file.id))?.thumbnailKey).toBe(key)
    expect(await store.setFileThumbnail('owner', file.id, 1, null)).toEqual({
      status: 'saved',
      thumbnail: { fileId: file.id, revision: 1, thumbnailKey: null },
    })
    expect((await store.getFile('owner', file.id))?.thumbnailKey).toBeNull()
  })
})
