import { describe, expect, it } from 'vitest'
import { createHttpThumbnailMetadataPort, createHttpThumbnailSourcePort } from '../src/index.js'

const token = 't'.repeat(48)
const fileId = '11111111-2222-4333-8444-555555555555'
const registryFingerprint = `sha256-${'a'.repeat(43)}=`

describe('thumbnail job service ports', () => {
  it('AT-THUMB-001 reads only an exact revision-bound source with the dedicated service credential', async () => {
    const requests: Request[] = []
    const source = createHttpThumbnailSourcePort({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: token,
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ fileId, revision: 3, pageId: 'page_1', registryFingerprint, document: { fileId, revision: 3 } })
      },
    })
    expect(await source.read(fileId, 3)).toEqual({ fileId, revision: 3, pageId: 'page_1', registryFingerprint, document: { fileId, revision: 3 } })
    expect(requests[0]?.headers.get('x-canvas-thumbnail-service-token')).toBe(token)
    expect(requests[0]?.redirect).toBe('manual')
  })

  it('AT-THUMB-001 rejects redirected or mismatched sources', async () => {
    const redirected = createHttpThumbnailSourcePort({ apiOrigin: 'https://api.canvas.test', serviceToken: token, fetch: async () => new Response(null, { status: 307 }) })
    await expect(redirected.read(fileId, 2)).rejects.toThrow('redirects are not allowed')
    const mismatched = createHttpThumbnailSourcePort({ apiOrigin: 'https://api.canvas.test', serviceToken: token, fetch: async () => Response.json({ fileId, revision: 4, pageId: 'page_1', registryFingerprint, document: {} }) })
    await expect(mismatched.read(fileId, 2)).rejects.toThrow('identity does not match')
    const missingFingerprint = createHttpThumbnailSourcePort({ apiOrigin: 'https://api.canvas.test', serviceToken: token, fetch: async () => Response.json({ fileId, revision: 2, pageId: 'page_1', document: {} }) })
    await expect(missingFingerprint.read(fileId, 2)).rejects.toThrow('Invalid thumbnail source')
    const invalidFingerprint = createHttpThumbnailSourcePort({ apiOrigin: 'https://api.canvas.test', serviceToken: token, fetch: async () => Response.json({ fileId, revision: 2, pageId: 'page_1', registryFingerprint: 'sha256-invalid', document: {} }) })
    await expect(invalidFingerprint.read(fileId, 2)).rejects.toThrow('identity does not match')
  })

  it('AT-THUMB-001 commits the exact uploaded key and ETag through service-only CAS', async () => {
    const key = `thumbnails/${fileId}/versions/3/nonce_123.avif`
    const metadata = createHttpThumbnailMetadataPort({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: token,
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get('x-canvas-thumbnail-service-token')).toBe(token)
        return Response.json({ thumbnail: { fileId, revision: 3, thumbnailKey: key, thumbnailEtag: 'etag-1' } })
      },
    })
    expect(await metadata.commit({ fileId, expectedRevision: 3, thumbnailKey: key, thumbnailEtag: 'etag-1' })).toEqual({ fileId, revision: 3, thumbnailKey: key, thumbnailEtag: 'etag-1' })
  })

  it('FILE-ASSET-SEC-001 rejects weak credentials and plaintext remote origins', () => {
    expect(() => createHttpThumbnailSourcePort({ apiOrigin: 'http://api.canvas.test', serviceToken: token })).toThrow('HTTPS outside loopback')
    expect(() => createHttpThumbnailSourcePort({ apiOrigin: 'https://api.canvas.test', serviceToken: 'short' })).toThrow('invalid')
  })
})
