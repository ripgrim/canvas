import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../../repo-engine/src/file-document'
import { createMemoryControlPlane } from '../src/memory'

describe('control-plane file documents', () => {
  it('AT-SHARE-003 exposes a read snapshot only after its owner enables link access', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Shared', null)
    expect(await store.getFileShare('owner', file.id)).toMatchObject({ fileId: file.id, access: 'private' })
    expect(await store.getFileShare('stranger', file.id)).toBeNull()
    expect(await store.getSharedFile(file.id)).toBeNull()
    expect(await store.setFileShare('stranger', file.id, 'view')).toBeNull()

    expect(await store.setFileShare('owner', file.id, 'view')).toMatchObject({ fileId: file.id, access: 'view' })
    expect(await store.getSharedFile(file.id)).toMatchObject({ file: { id: file.id, name: 'Shared', headRevision: 0 }, document: { fileId: file.id, revision: 0 } })

    await store.setFileShare('owner', file.id, 'private')
    expect(await store.getSharedFile(file.id)).toBeNull()
  })

  it('CLOUD-SYNC-AUTH-001 resolves only owner or viewer and bumps the epoch on effective share changes', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Access', null)
    expect(await store.resolveFileAccess('owner', file.id)).toEqual({ fileId: file.id, subjectUserId: 'owner', role: 'owner', accessEpoch: 1n })
    expect(await store.resolveFileAccess('viewer', file.id)).toBeNull()

    await store.setFileShare('owner', file.id, 'private')
    expect((await store.resolveFileAccess('owner', file.id))?.accessEpoch).toBe(1n)
    await store.setFileShare('owner', file.id, 'view')
    expect(await store.resolveFileAccess('viewer', file.id)).toEqual({ fileId: file.id, subjectUserId: 'viewer', role: 'viewer', accessEpoch: 2n })
    await store.setFileShare('owner', file.id, 'private')
    expect(await store.resolveFileAccess('viewer', file.id)).toBeNull()
    expect((await store.resolveFileAccess('owner', file.id))?.accessEpoch).toBe(3n)
  })

  it('CLOUD-SYNC-PG-001 stops legacy document writes after room authority cutover', async () => {
    const roomAuthority = new Set<string>()
    const store = createMemoryControlPlane({ isCollaborationAuthoritative: fileId => roomAuthority.has(fileId) })
    const file = await store.createFile('owner', 'Cutover', null)
    const initial = await store.getFileDocument('owner', file.id)
    expect((await store.saveFileDocument('owner', file.id, 0, { ...initial!.document, revision: 1, beforeCutover: true })).status).toBe('saved')
    const thumbnailKey = `thumbnails/${file.id}/versions/1/cutover.avif`
    expect((await store.setFileThumbnail('owner', file.id, 1, thumbnailKey, '"cutover"')).status).toBe('saved')

    roomAuthority.add(file.id)
    expect(await store.saveFileDocument('owner', file.id, 1, { ...initial!.document, revision: 2, afterCutover: true })).toEqual({ status: 'collaboration-authoritative' })
    expect(await store.saveFileDocument('other-owner', file.id, 1, { revision: 2 })).toEqual({ status: 'not-found' })
    expect(await store.getFileDocument('owner', file.id)).toMatchObject({ revision: 1, document: { beforeCutover: true } })
    expect(await store.getFileThumbnail('owner', file.id)).toMatchObject({ revision: 1, thumbnailKey })
    expect((await store.getFile('owner', file.id))?.headRevision).toBe(1)
  })

  it('FILE-ASSET-001 externalizes legacy bytes without changing semantic revision state', async () => {
    const roomAuthority = new Set<string>()
    const store = createMemoryControlPlane({ isCollaborationAuthoritative: fileId => roomAuthority.has(fileId) })
    const file = await store.createFile('owner', 'Legacy image', null)
    const initial = (await store.getFileDocumentForCapture(file.id))!
    const source = { ...initial.document, schemaVersion: 6, assets: { asset: { data: 'inline' } } }
    expect((await store.saveFileDocument('owner', file.id, 0, { ...source, revision: 1 })).status).toBe('saved')
    const stored = (await store.getFileDocumentForCapture(file.id))!
    const migrated = { ...stored.document, schemaVersion: 7 }
    delete (migrated as { assets?: unknown }).assets

    const saved = await store.externalizeLegacyFileDocument(file.id, 1, stored.document, migrated)
    expect(saved).toMatchObject({ status: 'saved', document: { revision: 1, document: { schemaVersion: 7, revision: 1 } } })
    expect((await store.getFile('owner', file.id))?.headRevision).toBe(1)
    expect(await store.externalizeLegacyFileDocument(file.id, 1, stored.document, migrated)).toMatchObject({ status: 'unchanged' })
    expect(await store.externalizeLegacyFileDocument(file.id, 0, stored.document, migrated)).toEqual({ status: 'conflict', currentRevision: 1 })
    expect(await store.externalizeLegacyFileDocument(file.id, 1, { ...stored.document, unexpected: true }, { ...migrated, unexpected: true })).toEqual({ status: 'conflict', currentRevision: 1 })

    roomAuthority.add(file.id)
    expect(await store.externalizeLegacyFileDocument(file.id, 1, migrated, { ...migrated, migratedAgain: true })).toEqual({ status: 'collaboration-authoritative' })
  })

  it('AT-THUMB-001 durably models idempotent leased capture work per committed revision', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Queued', null)
    const first = await store.claimThumbnailCaptureJob(new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:05:00.000Z'))
    expect(first).toMatchObject({ fileId: file.id, revision: 0, attempts: 1 })
    expect(await store.completeThumbnailCaptureJob(first!.id, crypto.randomUUID(), new Date())).toBe(false)
    expect(await store.releaseThumbnailCaptureJob(first!.id, first!.leaseId)).toBe(true)
    const retried = await store.claimThumbnailCaptureJob(new Date('2026-01-01T00:01:00.000Z'), new Date('2026-01-01T00:06:00.000Z'))
    expect(retried).toMatchObject({ id: first!.id, attempts: 2 })
    expect(await store.completeThumbnailCaptureJob(retried!.id, retried!.leaseId, new Date())).toBe(true)
    expect(await store.claimThumbnailCaptureJob(new Date(), new Date(Date.now() + 60_000))).toBeNull()
  })

  it('creates a canonical blank document accepted by the editor validator', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Blank', null)
    const opened = await store.getFileDocument('owner', file.id)
    expect(opened).not.toBeNull()
    const document = validateFileDocument(opened!.document, [])
    expect(document).toMatchObject({ schemaVersion: 7, fileId: file.id, revision: 0, pages: [{ name: 'Page 1' }], theme: { tokens: {} } })
    expect(Object.values(document.nodes)).toEqual([{ id: document.pages[0]!.rootNodeId, type: 'root' }])
  })

  it('AT-THUMB-001 updates, invalidates, and clears revision-bound thumbnail metadata', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Thumbnail', null)
    const key = `thumbnails/${file.id}/versions/0/nonce1234.avif`
    const stableKey = `thumbnails/${file.id}/thumbnail.avif`
    const etag = '"etag-0"'

    expect(await store.setFileThumbnail('owner', file.id, 0, key, etag)).toEqual({
      status: 'saved',
      thumbnail: { fileId: file.id, revision: 0, thumbnailKey: key, thumbnailEtag: etag },
    })
    expect(await store.setFileThumbnail('other-owner', file.id, 0, key, etag)).toEqual({ status: 'not-found' })
    expect((await store.getFile('owner', file.id))?.thumbnailKey).toBe(stableKey)
    expect(await store.getFileThumbnail('owner', file.id)).toEqual({ fileId: file.id, revision: 0, thumbnailKey: key, thumbnailEtag: etag })

    const opened = await store.getFileDocument('owner', file.id)
    expect(opened).not.toBeNull()
    const saved = await store.saveFileDocument('owner', file.id, 0, { ...opened!.document, revision: 1 })
    expect(saved.status).toBe('saved')
    expect((await store.getFile('owner', file.id))?.thumbnailKey).toBeNull()

    const nextKey = `thumbnails/${file.id}/versions/1/nonce5678.avif`
    expect((await store.setFileThumbnail('owner', file.id, 1, nextKey, '"etag-1"')).status).toBe('saved')
    expect(await store.setFileThumbnail('owner', file.id, 0, key, etag)).toEqual({ status: 'conflict', currentRevision: 1 })
    expect((await store.getFile('owner', file.id))?.thumbnailKey).toBe(stableKey)
  })
})
