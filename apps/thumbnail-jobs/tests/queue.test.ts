import { describe, expect, it, vi } from 'vitest'
import { createHttpThumbnailQueuePort, createThumbnailQueueProcessor, type ThumbnailQueueJob } from '../src/index.js'

const token = 'q'.repeat(48)
const fileId = '11111111-2222-4333-8444-555555555555'
const job: ThumbnailQueueJob = Object.freeze({
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  fileId,
  revision: 3,
  leaseId: 'ffffffff-1111-4222-8333-444444444444',
  leaseExpiresAt: '2026-10-09T12:05:00.000Z',
  attempts: 1,
})

describe('thumbnail queue worker', () => {
  it('AT-THUMB-001 claims, captures, and completes one leased revision', async () => {
    const calls: string[] = []
    const queue = {
      async claim() { calls.push('claim'); return job },
      async complete(id: string, leaseId: string) { calls.push(`complete:${id}:${leaseId}`) },
      async release() { calls.push('release') },
    }
    const run = vi.fn(async () => ({ fileId, revision: 3, thumbnailKey: 'key', thumbnailEtag: 'etag' }))
    const processor = createThumbnailQueueProcessor({ queue, service: { run } })
    await expect(processor.runOnce()).resolves.toBe('completed')
    expect(run).toHaveBeenCalledWith({ fileId, expectedRevision: 3 })
    expect(calls).toEqual(['claim', `complete:${job.id}:${job.leaseId}`])
  })

  it('AT-THUMB-001 releases the exact lease when capture fails', async () => {
    const released: string[] = []
    const processor = createThumbnailQueueProcessor({
      queue: {
        async claim() { return job },
        async complete() { throw new Error('must not complete') },
        async release(id, leaseId) { released.push(`${id}:${leaseId}`) },
      },
      service: { async run() { throw new Error('capture failed') } },
    })
    await expect(processor.runOnce()).rejects.toThrow('capture failed')
    expect(released).toEqual([`${job.id}:${job.leaseId}`])
  })

  it('AT-THUMB-001 authenticates every queue operation and rejects malformed claims', async () => {
    const requests: Request[] = []
    const responses = [
      Response.json({ job }),
      Response.json({ status: 'completed' }),
      Response.json({ status: 'released' }),
    ]
    const queue = createHttpThumbnailQueuePort({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: token,
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return responses.shift()!
      },
    })
    expect(await queue.claim()).toEqual(job)
    await queue.complete(job.id, job.leaseId)
    await queue.release(job.id, job.leaseId)
    expect(requests.map(request => request.headers.get('x-canvas-thumbnail-service-token'))).toEqual([token, token, token])
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/internal/thumbnail-jobs/claim',
      `/internal/thumbnail-jobs/${job.id}/complete`,
      `/internal/thumbnail-jobs/${job.id}/release`,
    ])

    const malformed = createHttpThumbnailQueuePort({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: token,
      fetch: async () => Response.json({ job: { ...job, revision: '3' } }),
    })
    await expect(malformed.claim()).rejects.toThrow('Invalid thumbnail queue job')
  })
})
