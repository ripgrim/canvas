import { describe, expect, it, vi } from 'vitest'
import { createMemoryControlPlane } from '@canvas/database/memory'
import {
  createHostedLegacyAssetUploader,
  createLegacyDocumentExternalizer,
  LegacyDocumentPreparationError,
} from '../src/legacy-assets'

const serviceToken = '0123456789abcdef0123456789abcdef'
const requestId = '11111111-1111-4111-8111-111111111111'

describe('legacy hosted asset migration', () => {
  it('FILE-ASSET-SEC-001 uploads exact validated bytes through the service-only asset route', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://assets.canvas.test/internal/file-assets/legacy/file-1/photo.jpg')
      expect(request.method).toBe('PUT')
      expect(request.redirect).toBe('error')
      expect(request.headers.get('X-Canvas-Service-Token')).toBe(serviceToken)
      expect(request.headers.get('X-Canvas-Request-Id')).toBe(requestId)
      expect(request.headers.get('Authorization')).toBe('Bearer owner')
      expect(request.headers.get('X-Canvas-Asset-Width')).toBe('1')
      expect(request.headers.get('X-Canvas-Asset-Height')).toBe('1')
      expect(request.headers.get('Content-Type')).toBe('image/jpeg')
      expect(Buffer.from(await request.arrayBuffer())).toEqual(Buffer.from([0, 0, 0]))
      return Response.json(
        { asset: { id: 'photo', mime: 'image/jpeg', extension: 'jpg', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) } },
        { headers: { 'X-Canvas-Request-Id': requestId } },
      )
    }) as unknown as typeof globalThis.fetch
    const upload = createHostedLegacyAssetUploader({ assetsOrigin: 'https://assets.canvas.test', serviceToken, fetch })

    await expect(upload({
      fileId: 'file-1',
      asset: { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', bytes: 3, width: 1, height: 1, data: 'AAAA' },
    }, requestId, { authorization: 'Bearer owner', cookie: null })).resolves.toEqual({ id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('FILE-ASSET-SEC-001 rejects unsafe origins and untrusted worker responses', async () => {
    expect(() => createHostedLegacyAssetUploader({ assetsOrigin: 'http://assets.canvas.test', serviceToken })).toThrow('HTTPS')
    expect(() => createHostedLegacyAssetUploader({ assetsOrigin: 'https://assets.canvas.test/path', serviceToken })).toThrow('origin')
    const upload = createHostedLegacyAssetUploader({
      assetsOrigin: 'https://assets.canvas.test', serviceToken,
      fetch: async () => Response.json(
        { asset: { id: 'other', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) } },
        { headers: { 'X-Canvas-Request-Id': requestId } },
      ),
    })
    await expect(upload({
      fileId: 'file-1',
      asset: { id: 'photo', name: 'photo.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, data: 'AAAA' },
    }, requestId, { authorization: null, cookie: 'session=owner' })).rejects.toMatchObject({ failure: 'service-unavailable' })

    const offline = createHostedLegacyAssetUploader({
      assetsOrigin: 'https://assets.canvas.test', serviceToken,
      fetch: async () => { throw new Error('network secret') },
    })
    await expect(offline({
      fileId: 'file-1',
      asset: { id: 'photo', name: 'photo.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, data: 'AAAA' },
    }, requestId, { authorization: null, cookie: null })).rejects.toMatchObject({ failure: 'service-unavailable' })

    const invalidMedia = createHostedLegacyAssetUploader({
      assetsOrigin: 'https://assets.canvas.test', serviceToken,
      fetch: async () => Response.json(
        { error: 'unsupported_media_type', message: 'Invalid image data' },
        { status: 415, headers: { 'X-Canvas-Request-Id': requestId } },
      ),
    })
    await expect(invalidMedia({
      fileId: 'file-1',
      asset: { id: 'photo', name: 'photo.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, data: 'AAAA' },
    }, requestId, { authorization: 'Bearer owner', cookie: null })).rejects.toMatchObject({
      failure: 'invalid-document',
      phase: 'legacy_asset_externalization',
      upstreamStatus: 415,
      upstreamCode: 'unsupported_media_type',
    })

    const mismatchedCorrelation = createHostedLegacyAssetUploader({
      assetsOrigin: 'https://assets.canvas.test', serviceToken,
      fetch: async () => Response.json(
        { asset: { id: 'photo', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) } },
        { headers: { 'X-Canvas-Request-Id': 'different-request' } },
      ),
    })
    await expect(mismatchedCorrelation({
      fileId: 'file-1',
      asset: { id: 'photo', name: 'photo.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, data: 'AAAA' },
    }, requestId, { authorization: 'Bearer owner', cookie: null })).rejects.toMatchObject({
      failure: 'service-unavailable',
      upstreamCode: 'correlation_mismatch',
    })
  })

  it('FILE-ASSET-001 externalizes a stored schema-6 document once without a semantic revision', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Legacy image', null)
    const initial = (await store.getFileDocumentForCapture(file.id))!
    const source = {
      ...initial.document,
      schemaVersion: 6,
      assets: { photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' } },
    }
    expect((await store.saveFileDocument('owner', file.id, 0, { ...source, revision: 1 })).status).toBe('saved')
    const upload = vi.fn(async () => ({ id: 'photo', name: 'photo.png', mime: 'image/png' as const, extension: 'png' as const, width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) }))
    const externalizer = createLegacyDocumentExternalizer({ store, upload })

    await externalizer.prepare(file.id, requestId, { authorization: 'Bearer owner', cookie: null })
    await externalizer.prepare(file.id, requestId, { authorization: 'Bearer owner', cookie: null })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(await store.getFileDocumentForCapture(file.id)).toMatchObject({
      revision: 1,
      document: { schemaVersion: 7, revision: 1, assets: { photo: { sha256: 'a'.repeat(64) } } },
    })
    expect((await store.getFile('owner', file.id))?.headRevision).toBe(1)
  })

  it('FILE-ASSET-SEC-001 classifies invalid source graphs without uploading', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Invalid image', null)
    const initial = (await store.getFileDocumentForCapture(file.id))!
    const source = { ...initial.document, schemaVersion: 6, relationships: { ghost: { parentId: 'missing', orderKey: 'V' } }, assets: { photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' } } }
    expect((await store.saveFileDocument('owner', file.id, 0, { ...source, revision: 1 })).status).toBe('saved')
    const upload = vi.fn()
    const externalizer = createLegacyDocumentExternalizer({ store, upload })

    await expect(externalizer.prepare(file.id, requestId, { authorization: 'Bearer owner', cookie: null })).rejects.toEqual(expect.objectContaining({
      name: LegacyDocumentPreparationError.name,
      failure: 'invalid-document',
    }))
    expect(upload).not.toHaveBeenCalled()
  })

  it('FILE-ASSET-SEC-001 binds the stored document identity to the admitted file before upload', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Mismatched legacy image', null)
    const initial = (await store.getFileDocumentForCapture(file.id))!
    const source = {
      ...initial.document,
      fileId: 'other-file',
      schemaVersion: 6,
      assets: { photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' } },
    }
    expect((await store.saveFileDocument('owner', file.id, 0, { ...source, revision: 1 })).status).toBe('saved')
    const upload = vi.fn()
    const externalizer = createLegacyDocumentExternalizer({ store, upload })

    await expect(externalizer.prepare(file.id, requestId, { authorization: 'Bearer owner', cookie: null })).rejects.toMatchObject({
      failure: 'invalid-document',
    })
    expect(upload).not.toHaveBeenCalled()
  })

  it('FILE-ASSET-SEC-001 refuses room admission when collaboration authority blocks legacy persistence', async () => {
    let collaborationAuthoritative = false
    const store = createMemoryControlPlane({ isCollaborationAuthoritative: () => collaborationAuthoritative })
    const file = await store.createFile('owner', 'Legacy room image', null)
    const initial = (await store.getFileDocumentForCapture(file.id))!
    const source = {
      ...initial.document,
      schemaVersion: 6,
      assets: { photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' } },
    }
    expect((await store.saveFileDocument('owner', file.id, 0, { ...source, revision: 1 })).status).toBe('saved')
    collaborationAuthoritative = true
    const upload = vi.fn(async () => ({ id: 'photo', name: 'photo.png', mime: 'image/png' as const, extension: 'png' as const, width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) }))
    const externalizer = createLegacyDocumentExternalizer({ store, upload })

    await expect(externalizer.prepare(file.id, requestId, { authorization: 'Bearer owner', cookie: null })).rejects.toMatchObject({
      name: LegacyDocumentPreparationError.name,
      failure: 'service-unavailable',
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect((await store.getFileDocumentForCapture(file.id))!.document).toMatchObject({ schemaVersion: 6 })
  })
})
