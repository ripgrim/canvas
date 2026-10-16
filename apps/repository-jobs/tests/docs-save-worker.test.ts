import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hostedDocsReview } from '@canvas/repo-engine/hosted-source-review'
import { createGitHubHostedDocsWriter, createHostedDocsSaveProcessor, type HostedDocsSaveJob } from '../src/docs-save-worker.js'

const baseCommitSha = 'a'.repeat(40)
const baseTreeSha = 'b'.repeat(40)
const blobSha = 'c'.repeat(40)
const treeSha = 'd'.repeat(40)
const commitSha = 'e'.repeat(40)

function job(overrides: Partial<HostedDocsSaveJob> = {}): HostedDocsSaveJob {
  const bundle = hostedDocsReview({
    version: 1,
    projectId: '00000000-0000-4000-8000-000000000010',
    fileId: '00000000-0000-4000-8000-000000000011',
    fileRevision: 4,
    fileDocumentSha256: createHash('sha256').update('document').digest('hex'),
    scanJobId: '00000000-0000-4000-8000-000000000012',
    installationId: '2001',
    repositoryId: '4001',
    repositoryGrantId: '00000000-0000-4000-8000-000000000013',
    repositoryLinkedAt: 1_800_000_000_000,
    baseRef: 'refs/heads/main',
    baseCommitSha,
    baseTreeSha,
    adapter: { version: 1, renderer: 'blume', layout: { docsDirectory: 'apps/docs/content/docs/components', examplesDirectory: 'apps/docs/registry/comp', metaPath: 'apps/docs/content/docs/components/meta.ts', manifestPath: 'apps/docs/registry/comp/components.json' }, components: [] },
    files: [
      { path: 'apps/docs/content/docs/components/button.mdx', beforeSha256: null, after: '# Button\n', diff: '+# Button\n' },
      { path: 'apps/docs/content/docs/components/old.mdx', beforeSha256: createHash('sha256').update('old').digest('hex'), after: null, diff: '-old\n' },
    ],
    omissions: [],
    validation: [{ name: 'docs-build', detail: 'passed' }],
  })
  return Object.freeze({
    reviewId: '00000000-0000-4000-8000-000000000001',
    leaseId: '00000000-0000-4000-8000-000000000002',
    leaseExpiresAt: 1_800_000_300_000,
    repositoryId: '4001',
    baseRef: 'refs/heads/main',
    baseCommitSha,
    baseTreeSha,
    proposedCommitSha: null,
    approvalDigest: bundle.approvalDigest,
    bundle: bundle.bundle,
    accessToken: 'ghs_write_token',
    accessExpiresAt: 1_800_000_300_000,
    ...overrides,
  })
}

describe('hosted documentation save writer', () => {
  it('COMP-V2-DOCS-005 creates one commit and records it before atomically moving the branch', async () => {
    const events: string[] = []
    const bodies: unknown[] = []
    const request: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      const method = init?.method ?? 'GET'
      events.push(`${method} ${url.pathname}`)
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      if (method === 'GET' && url.pathname.includes('/git/ref/')) return response({ object: { sha: baseCommitSha } })
      if (method === 'GET' && url.pathname.includes('/git/commits/')) return response({ tree: { sha: baseTreeSha } })
      if (url.pathname.endsWith('/git/blobs')) return response({ sha: blobSha }, 201)
      if (url.pathname.endsWith('/git/trees')) return response({ sha: treeSha }, 201)
      if (url.pathname.endsWith('/git/commits')) return response({ sha: commitSha }, 201)
      if (method === 'PATCH' && url.pathname.includes('/git/ref/')) return response({ object: { sha: commitSha } })
      return response({ message: 'unexpected' }, 500)
    }
    const writer = createGitHubHostedDocsWriter({ fetch: request, now: () => 1_800_000_000_000 })
    const result = await writer.save(job(), async sha => { events.push(`PROPOSE ${sha}`) })

    expect(result).toEqual({ status: 'saved', commitSha })
    expect(events).toEqual([
      'GET /repositories/4001/git/ref/heads/main',
      `GET /repositories/4001/git/commits/${baseCommitSha}`,
      'POST /repositories/4001/git/blobs',
      'POST /repositories/4001/git/trees',
      'POST /repositories/4001/git/commits',
      `PROPOSE ${commitSha}`,
      'PATCH /repositories/4001/git/ref/heads/main',
    ])
    expect(bodies.at(-3)).toEqual({ base_tree: baseTreeSha, tree: [
      { path: 'apps/docs/content/docs/components/button.mdx', mode: '100644', type: 'blob', sha: blobSha },
      { path: 'apps/docs/content/docs/components/old.mdx', mode: '100644', type: 'blob', sha: null },
    ] })
  })

  it('COMP-V2-DOCS-NEG-002 refuses to move a branch that changed after review', async () => {
    const methods: string[] = []
    const request: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? 'GET')
      return response({ object: { sha: 'f'.repeat(40) } })
    }
    const writer = createGitHubHostedDocsWriter({ fetch: request, now: () => 1_800_000_000_000 })
    await expect(writer.save(job(), async () => { throw new Error('should not propose') })).resolves.toEqual({ status: 'stale' })
    expect(methods).toEqual(['GET'])
  })

  it('COMP-V2-DOCS-005 resumes after a successful ref update without creating another commit', async () => {
    const request: typeof fetch = async () => response({ object: { sha: commitSha } })
    const writer = createGitHubHostedDocsWriter({ fetch: request, now: () => 1_800_000_000_000 })
    await expect(writer.save(job({ proposedCommitSha: commitSha }), async () => { throw new Error('should not propose') })).resolves.toEqual({ status: 'saved', commitSha })
  })

  it('ERROR-VISIBILITY-001 makes a permanent write failure terminal with a stable error id', async () => {
    const failed: string[] = []
    const processor = createHostedDocsSaveProcessor({
      queue: {
        async claim() { return job() },
        async proposed() { throw new Error('unexpected proposal') },
        async complete() { throw new Error('unexpected completion') },
        async stale() { throw new Error('unexpected stale result') },
        async fail(_job, errorId) { failed.push(errorId) },
      },
      writer: { async save() { throw new Error('GitHub documentation save returned 403.') } },
    })
    await expect(processor.runOnce()).resolves.toBe('completed')
    expect(failed).toEqual(['repository-docs-save-failed'])
  })

  it('COMP-V2-DOCS-005 retains the lease for retry after a transient GitHub failure', async () => {
    const failed: string[] = []
    const processor = createHostedDocsSaveProcessor({
      queue: {
        async claim() { return job() },
        async proposed() { throw new Error('unexpected proposal') },
        async complete() { throw new Error('unexpected completion') },
        async stale() { throw new Error('unexpected stale result') },
        async fail(_job, errorId) { failed.push(errorId) },
      },
      writer: { async save() { throw new Error('GitHub documentation save returned 503.') } },
    })
    await expect(processor.runOnce()).rejects.toThrow('returned 503')
    expect(failed).toEqual([])
  })
})

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}
