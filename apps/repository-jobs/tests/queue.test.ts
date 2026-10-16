import { describe, expect, it, vi } from 'vitest'
import { createHostedRepositoryQueueProcessor, createHttpHostedRepositoryQueue } from '../src/index.js'

const job = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  repositoryId: '4001',
  accessToken: 'ghs_repository_read_token',
  leaseId: '00000000-0000-4000-8000-000000000002',
  attempt: 1,
})
const result = Object.freeze({ sourceRevision: 'a'.repeat(40), scan: Object.freeze({ adapterId: 'shadcn-v1' }), request: Object.freeze({ version: 1 }) }) as never

describe('hosted repository queue', () => {
  it('AT-REPO-SCAN-001 commits the immutable scan through its lease', async () => {
    const complete = vi.fn(async () => undefined)
    const retry = vi.fn(async (_jobId: string, _leaseId: string, _nextAttemptAt: number) => undefined)
    const fail = vi.fn(async () => undefined)
    const processor = createHostedRepositoryQueueProcessor({
      queue: { claim: vi.fn(async () => job), complete, retry, fail },
      scanner: { scan: vi.fn(async () => result) },
    })

    await expect(processor.runOnce()).resolves.toBe('completed')
    expect(complete).toHaveBeenCalledWith(job.id, job.leaseId, result)
    expect(retry).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('AT-REPO-SCAN-001 terminates a permanent scan failure', async () => {
    const fail = vi.fn(async () => undefined)
    const processor = createHostedRepositoryQueueProcessor({
      queue: { claim: vi.fn(async () => job), complete: vi.fn(), retry: vi.fn(), fail },
      scanner: { scan: vi.fn(async () => { throw new Error('scan failed') }) },
    })

    await expect(processor.runOnce()).rejects.toThrow('scan failed')
    expect(fail).toHaveBeenCalledWith(job.id, job.leaseId, 'repository-scan-failed')
  })

  it('AT-REPO-SCAN-001 delays a transient failure before the bounded retry', async () => {
    const retry = vi.fn(async (_jobId: string, _leaseId: string, _nextAttemptAt: number) => undefined)
    const processor = createHostedRepositoryQueueProcessor({
      queue: { claim: vi.fn(async () => job), complete: vi.fn(), retry, fail: vi.fn() },
      scanner: { scan: vi.fn(async () => { throw new TypeError('fetch failed') }) },
    })

    const before = Date.now()
    await expect(processor.runOnce()).rejects.toThrow('fetch failed')
    expect(retry).toHaveBeenCalledTimes(1)
    const retryAt = retry.mock.calls[0]?.[2]
    expect(retryAt).toBeGreaterThanOrEqual(before + 2_000)
    expect(retryAt).toBeLessThanOrEqual(before + 3_000)
  })

  it('keeps the installation token inside the worker queue contract', async () => {
    const calls: string[] = []
    const bodies: string[] = []
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url.pathname)
      if (init?.body) bodies.push(String(init.body))
      if (url.pathname.endsWith('/claim')) return new Response(JSON.stringify({
        job: { id: job.id, operation: 'scan', status: 'running', attempt: 1 },
        repository: { installationId: '2001', repositoryId: job.repositoryId },
        lease: { id: job.leaseId, expiresAt: Date.now() + 60_000 },
        access: { token: job.accessToken, expiresAt: Date.now() + 60_000, contentsPermission: 'read' },
      }), { headers: { 'Content-Type': 'application/json' } })
      const request = JSON.parse(String(init?.body)) as { result?: unknown }
      return new Response(JSON.stringify(url.pathname.endsWith('/complete') ? { job: { id: job.id, operation: 'scan', status: 'completed', attempt: 1 } } : { status: 'released', request }), { headers: { 'Content-Type': 'application/json' } })
    })
    const queue = createHttpHostedRepositoryQueue({ apiOrigin: 'http://127.0.0.1:4320', serviceToken: 'repository-job-0123456789abcdef0123456789', fetch })

    expect(await queue.claim()).toEqual(job)
    await queue.complete(job.id, job.leaseId, result)
    expect(calls).toEqual(['/internal/repository-jobs/claim', `/internal/repository-jobs/${job.id}/complete`])
    expect(bodies.join('\n')).not.toContain(job.accessToken)
  })
})
