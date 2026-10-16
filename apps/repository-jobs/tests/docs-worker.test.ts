import { describe, expect, it, vi } from 'vitest'
import { createHostedDocsPrepareProcessor, createHttpHostedDocsPrepareQueue, type HostedDocsPrepareJob } from '../src/docs-worker.js'
import type { HostedDocsReviewBundle } from '@canvas/repo-engine/hosted-source-review'

const job: HostedDocsPrepareJob = Object.freeze({
  reviewId: '00000000-0000-4000-8000-000000000001',
  leaseId: '00000000-0000-4000-8000-000000000002',
  leaseExpiresAt: 1_800_000_300_000,
  sourceRevision: 'a'.repeat(40),
  projectId: '00000000-0000-4000-8000-000000000003',
  fileId: '00000000-0000-4000-8000-000000000004',
  fileRevision: 12,
  fileDocumentSha256: 'b'.repeat(64),
  scanJobId: '00000000-0000-4000-8000-000000000005',
  installationId: '2001',
  repositoryId: '4001',
  repositoryGrantId: '00000000-0000-4000-8000-000000000006',
  repositoryLinkedAt: 1_800_000_000_000,
  baseRef: 'refs/heads/main',
  baseCommitSha: 'a'.repeat(40),
  baseTreeSha: 'c'.repeat(40),
  adapter: Object.freeze({ version: 1 }),
  document: Object.freeze({ schemaVersion: 12 }),
  scan: Object.freeze({ sourceRevision: 'a'.repeat(40) }),
})

const bundle = Object.freeze({
  version: 1,
  projectId: job.projectId,
  fileId: job.fileId,
  fileRevision: job.fileRevision,
  fileDocumentSha256: job.fileDocumentSha256,
  scanJobId: job.scanJobId,
  installationId: job.installationId,
  repositoryId: job.repositoryId,
  repositoryGrantId: job.repositoryGrantId,
  repositoryLinkedAt: job.repositoryLinkedAt,
  baseRef: job.baseRef,
  baseCommitSha: job.baseCommitSha,
  baseTreeSha: job.baseTreeSha,
  adapter: { version: 1, renderer: 'blume', layout: { docsDirectory: 'docs', examplesDirectory: 'examples', metaPath: 'docs/meta.ts', manifestPath: 'docs/components.json' }, components: [] },
  files: [{ path: 'docs/meta.ts', beforeSha256: null, after: 'export default {}\n', diff: '+export default {}\n' }],
  omissions: [],
  validation: [{ name: 'Documentation build', detail: 'Passed.' }],
}) as HostedDocsReviewBundle

describe('hosted documentation prepare worker', () => {
  it('COMP-V2-DOCS-005 prepares from a brokered snapshot and always disposes it', async () => {
    const dispose = vi.fn(async () => undefined)
    const complete = vi.fn(async () => undefined)
    const prepare = vi.fn(async () => bundle)
    const processor = createHostedDocsPrepareProcessor({
      queue: { claim: vi.fn(async () => job), complete },
      snapshot: { open: vi.fn(async input => ({ root: 'C:/owned/repository', sourceRevision: input.sourceRevision, dispose })) },
      preparer: { prepare },
    })

    await expect(processor.runOnce()).resolves.toBe('completed')
    expect(prepare).toHaveBeenCalledWith(job, 'C:/owned/repository')
    expect(complete).toHaveBeenCalledWith(job, bundle)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('COMP-V2-DOCS-NEG-002 sends no GitHub credential through the prepare queue', async () => {
    const token = 'repository-job-0123456789abcdef0123456789'
    const requests: string[] = []
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(`${new Headers(init?.headers).get('X-Canvas-Service-Token')}\n${String(init?.body)}`)
      return new Response(JSON.stringify({ review: null }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch
    const queue = createHttpHostedDocsPrepareQueue({ apiOrigin: 'http://127.0.0.1:4320', serviceToken: token, fetch })

    await expect(queue.claim()).resolves.toBeNull()
    expect(requests).toEqual([`${token}\n{}`])
    expect(requests[0]).not.toContain('ghs_')
    expect(requests[0]).not.toContain('github')
  })
})
