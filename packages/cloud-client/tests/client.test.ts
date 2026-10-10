import { describe, expect, it, vi } from 'vitest'
import { CloudApiError, createCloudApiClient } from '../src/index'

const file = {
  id: '11111111-2222-4333-8444-555555555555', projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: null,
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('cloud api client', () => {
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
})
