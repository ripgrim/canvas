import { describe, expect, it, vi } from 'vitest'
import { CloudApiError, createCloudApiClient } from '../src/index'

const file = {
  id: '11111111-2222-4333-8444-555555555555', projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: null,
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('cloud api client', () => {
  it('accepts the opaque account ids issued by the auth service', async () => {
    const user = { id: 'better-auth-user_01', name: 'Ada', email: 'ada@example.test', image: null }
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ user })) as typeof fetch, validateDocument: value => value })

    await expect(client.session()).resolves.toEqual(user)
  })

  it('rejects unsafe account ids returned by the auth service', async () => {
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ user: { id: 'user\nforeign', name: 'Ada', email: 'ada@example.test', image: null } })) as typeof fetch, validateDocument: value => value })

    await expect(client.session()).rejects.toThrow('Invalid user id')
  })

  it('uses fixed credentialed routes for file metadata and revisioned documents', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/api/files')) return response(init?.method === 'POST' ? { file } : { files: [file] }, init?.method === 'POST' ? 201 : 200)
      if (String(url).endsWith('/document')) return response({ fileId: file.id, revision: init?.method === 'PUT' ? 1 : 0, document: { schemaVersion: 2 } })
      return response({ file })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value as { schemaVersion: number } })
    expect(await client.listFiles()).toEqual([file])
    expect(await client.createFile()).toEqual(file)
    expect(await client.openFile(file.id)).toEqual(file)
    expect(await client.openDocument(file.id)).toEqual({ fileId: file.id, revision: 0, document: { schemaVersion: 2 } })
    expect(await client.saveDocument(file.id, { schemaVersion: 2 }, 0)).toEqual({ fileId: file.id, revision: 1, document: { schemaVersion: 2 } })
    expect(requests.map(item => item.url)).toEqual([
      'https://api.canvas.test/api/files',
      'https://api.canvas.test/api/files',
      'https://api.canvas.test/api/files/11111111-2222-4333-8444-555555555555',
      'https://api.canvas.test/api/files/11111111-2222-4333-8444-555555555555/document',
      'https://api.canvas.test/api/files/11111111-2222-4333-8444-555555555555/document',
    ])
    expect(requests.every(item => item.init?.credentials === 'include')).toBe(true)
  })

  it('rejects non-loopback HTTP origins and path-like ids before fetch', async () => {
    expect(() => createCloudApiClient({ apiOrigin: 'http://api.canvas.test', validateDocument: value => value })).toThrow('HTTPS')
    const fetcher = vi.fn()
    const client = createCloudApiClient({ apiOrigin: 'http://127.0.0.1:4320', fetch: fetcher as typeof fetch, validateDocument: value => value })
    await expect(client.openFile('../foreign')).rejects.toThrow('Invalid file id')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('surfaces stale revisions without accepting malformed success payloads', async () => {
    const conflict = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ error: { code: 'stale_revision', message: 'Document conflict.' } }, 409)) as typeof fetch, validateDocument: value => value })
    await expect(conflict.saveDocument(file.id, {}, 0)).rejects.toMatchObject({ status: 409, code: 'stale_revision' } satisfies Partial<CloudApiError>)
    const wrongFile = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', revision: 1, document: {} })) as typeof fetch, validateDocument: value => value })
    await expect(wrongFile.openDocument(file.id)).rejects.toThrow('another file')
  })

  it('ERROR-VISIBILITY-001 carries one request id through the request and public API failure', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestId = new Headers(init?.headers).get('X-Canvas-Request-Id')
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
      return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'X-Canvas-Request-Id': requestId! },
      })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })
    await expect(client.listFiles()).rejects.toMatchObject({ status: 500, code: 'internal_error', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } satisfies Partial<CloudApiError>)
  })

  it('ERROR-VISIBILITY-001 assigns a request id when the network fails before a response', async () => {
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch, validateDocument: value => value })
    await expect(client.listFiles()).rejects.toMatchObject({ status: 0, code: 'network_error', message: 'The service could not be reached.', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } satisfies Partial<CloudApiError>)
  })

  it('AT-THUMB-001 sets and clears only the stable thumbnail key for the expected revision', async () => {
    const key = `thumbnails/${file.id}/thumbnail.avif`
    const requests: Array<{ url: string; body: unknown }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { expectedRevision: number; thumbnailKey: string | null }
      requests.push({ url: String(url), body: input })
      return response({ thumbnail: { fileId: file.id, revision: input.expectedRevision, thumbnailKey: input.thumbnailKey } })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })

    expect(await client.setThumbnail(file.id, 3, key)).toEqual({ fileId: file.id, revision: 3, thumbnailKey: key })
    expect(await client.clearThumbnail(file.id, 3)).toEqual({ fileId: file.id, revision: 3, thumbnailKey: null })
    expect(requests).toEqual([
      { url: `https://api.canvas.test/api/files/${file.id}/thumbnail`, body: { expectedRevision: 3, thumbnailKey: key } },
      { url: `https://api.canvas.test/api/files/${file.id}/thumbnail`, body: { expectedRevision: 3, thumbnailKey: null } },
    ])
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'include' && init.method === 'PUT')).toBe(true)

    await expect(client.setThumbnail(file.id, 3, '../thumbnail.avif')).rejects.toThrow('Invalid thumbnail key')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('AT-THUMB-001 rejects thumbnail metadata for another file or revision', async () => {
    const key = `thumbnails/${file.id}/thumbnail.avif`
    const wrongRevision = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ thumbnail: { fileId: file.id, revision: 4, thumbnailKey: key } })) as typeof fetch, validateDocument: value => value })
    await expect(wrongRevision.setThumbnail(file.id, 3, key)).rejects.toThrow('another revision')
    const wrongFile = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ thumbnail: { fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', revision: 3, thumbnailKey: key } })) as typeof fetch, validateDocument: value => value })
    await expect(wrongFile.setThumbnail(file.id, 3, key)).rejects.toThrow('another file')
  })

  it('AT-SHARE-003 uses exact credentialed share routes and validates the read snapshot', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const input = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), method, body: input })
      if (String(url).endsWith('/share')) return response({ share: { fileId: file.id, access: input?.access ?? 'private', updatedAt: file.updatedAt } })
      return response({ file: { id: file.id, name: file.name, headRevision: 0, updatedAt: file.updatedAt }, fileId: file.id, revision: 0, document: { schemaVersion: 9 } })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value as { schemaVersion: number } })

    expect(await client.getFileShare(file.id)).toMatchObject({ access: 'private' })
    expect(await client.setFileShare(file.id, 'view')).toMatchObject({ access: 'view' })
    expect(await client.openSharedFile(file.id)).toMatchObject({ file: { id: file.id, name: file.name }, fileId: file.id, revision: 0, document: { schemaVersion: 9 } })
    expect(calls).toEqual([
      { url: `https://api.canvas.test/api/files/${file.id}/share`, method: 'GET', body: null },
      { url: `https://api.canvas.test/api/files/${file.id}/share`, method: 'PUT', body: { access: 'view' } },
      { url: `https://api.canvas.test/api/shared/files/${file.id}`, method: 'GET', body: null },
    ])
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true)
  })
})
