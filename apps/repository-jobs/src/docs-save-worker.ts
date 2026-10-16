import { hostedDocsReview, type HostedDocsReviewBundle } from '@canvas/repo-engine/hosted-source-review'

export type HostedDocsSaveJob = Readonly<{
  reviewId: string
  leaseId: string
  leaseExpiresAt: number
  repositoryId: string
  baseRef: string
  baseCommitSha: string
  baseTreeSha: string
  proposedCommitSha: string | null
  approvalDigest: string
  bundle: HostedDocsReviewBundle
  accessToken: string
  accessExpiresAt: number
}>

export interface HostedDocsSaveQueuePort {
  claim(): Promise<HostedDocsSaveJob | null>
  proposed(job: HostedDocsSaveJob, commitSha: string): Promise<void>
  complete(job: HostedDocsSaveJob, commitSha: string): Promise<void>
  stale(job: HostedDocsSaveJob, errorId: string): Promise<void>
  fail(job: HostedDocsSaveJob, errorId: string): Promise<void>
}

export interface HostedDocsWriter {
  save(job: HostedDocsSaveJob, proposed: (commitSha: string) => Promise<void>): Promise<Readonly<{ status: 'saved'; commitSha: string }> | Readonly<{ status: 'stale' }>>
}

export function createHostedDocsSaveProcessor(options: Readonly<{ queue: HostedDocsSaveQueuePort; writer: HostedDocsWriter }>) {
  return Object.freeze({
    async runOnce(): Promise<'idle' | 'completed'> {
      const job = await options.queue.claim()
      if (!job) return 'idle'
      try {
        const result = await options.writer.save(job, commitSha => options.queue.proposed(job, commitSha))
        if (result.status === 'stale') await options.queue.stale(job, 'repository-source-changed')
        else await options.queue.complete(job, result.commitSha)
      } catch (error) {
        if (retryable(error)) throw error
        await options.queue.fail(job, 'repository-docs-save-failed')
      }
      return 'completed'
    },
  })
}

export function createGitHubHostedDocsWriter(options: Readonly<{ fetch?: typeof globalThis.fetch; now?: () => number }> = {}): HostedDocsWriter {
  const request = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const writer: HostedDocsWriter = {
    async save(job, proposed) {
      if (job.accessExpiresAt <= now() + 15_000) throw new Error('Documentation save access expired.')
      const branch = job.baseRef.slice('refs/heads/'.length)
      const referencePath = `/repositories/${job.repositoryId}/git/ref/heads/${encodeURIComponent(branch)}`
      const currentCommitSha = await readReference(request, job.accessToken, referencePath)
      if (job.proposedCommitSha) {
        if (currentCommitSha === job.proposedCommitSha) return Object.freeze({ status: 'saved' as const, commitSha: job.proposedCommitSha })
        if (currentCommitSha !== job.baseCommitSha) return Object.freeze({ status: 'stale' as const })
        const updated = await updateReference(request, job.accessToken, referencePath, job.proposedCommitSha)
        return updated ? Object.freeze({ status: 'saved' as const, commitSha: job.proposedCommitSha }) : Object.freeze({ status: 'stale' as const })
      }
      if (currentCommitSha !== job.baseCommitSha) return Object.freeze({ status: 'stale' as const })
      const baseTreeSha = await readCommitTree(request, job.accessToken, job.repositoryId, job.baseCommitSha)
      if (baseTreeSha !== job.baseTreeSha) return Object.freeze({ status: 'stale' as const })
      const entries: Array<Readonly<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }>> = []
      for (const file of job.bundle.files) {
        const sha = file.after === null ? null : await createBlob(request, job.accessToken, job.repositoryId, file.after)
        entries.push(Object.freeze({ path: file.path, mode: '100644', type: 'blob', sha }))
      }
      const treeSha = await createTree(request, job.accessToken, job.repositoryId, job.baseTreeSha, entries)
      const commitSha = await createCommit(request, job.accessToken, job.repositoryId, job.baseCommitSha, treeSha)
      await proposed(commitSha)
      const updated = await updateReference(request, job.accessToken, referencePath, commitSha)
      return updated ? Object.freeze({ status: 'saved' as const, commitSha }) : Object.freeze({ status: 'stale' as const })
    },
  }
  return Object.freeze(writer)
}

export function createHttpHostedDocsSaveQueue(options: Readonly<{ apiOrigin: string; serviceToken: string; fetch?: typeof globalThis.fetch }>): HostedDocsSaveQueuePort {
  const origin = apiOrigin(options.apiOrigin)
  const token = serviceToken(options.serviceToken)
  const request = options.fetch ?? globalThis.fetch
  const call = async (pathname: string, body: object): Promise<Record<string, unknown>> => {
    const response = await request(new URL(pathname, origin), { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Canvas-Service-Token': token }, body: JSON.stringify(body) })
    if (!response.ok || response.status >= 300) throw new Error(`Documentation save queue returned ${response.status}.`)
    return record(await response.json(), 'documentation save response')
  }
  const queue: HostedDocsSaveQueuePort = {
    async claim() {
      const response = await call('/internal/repository-doc-reviews/claim-save', {})
      if (response.review === null) return null
      return saveJob(response.review, response.access)
    },
    async proposed(job, commitSha) {
      const response = await call(`/internal/repository-doc-reviews/${job.reviewId}/proposed-commit`, { leaseId: job.leaseId, proposedCommitSha: commitSha })
      confirm(response, job.reviewId, 'saving')
    },
    async complete(job, commitSha) {
      const response = await call(`/internal/repository-doc-reviews/${job.reviewId}/complete-save`, { leaseId: job.leaseId, committedSha: commitSha })
      confirm(response, job.reviewId, 'saved')
    },
    async stale(job, errorId) {
      const response = await call(`/internal/repository-doc-reviews/${job.reviewId}/stale-save`, { leaseId: job.leaseId, errorId })
      confirm(response, job.reviewId, 'stale')
    },
    async fail(job, errorId) {
      const response = await call(`/internal/repository-doc-reviews/${job.reviewId}/fail-save`, { leaseId: job.leaseId, errorId })
      confirm(response, job.reviewId, 'failed')
    },
  }
  return Object.freeze(queue)
}

async function readReference(request: typeof globalThis.fetch, token: string, pathname: string): Promise<string> {
  const response = await github(request, token, pathname)
  const object = record(response.object, 'GitHub reference object')
  return sha(object.sha)
}

async function readCommitTree(request: typeof globalThis.fetch, token: string, repositoryId: string, commitSha: string): Promise<string> {
  const response = await github(request, token, `/repositories/${repositoryId}/git/commits/${commitSha}`)
  return sha(record(response.tree, 'GitHub commit tree').sha)
}

async function createBlob(request: typeof globalThis.fetch, token: string, repositoryId: string, content: string): Promise<string> {
  const response = await github(request, token, `/repositories/${repositoryId}/git/blobs`, 'POST', { content, encoding: 'utf-8' })
  return sha(response.sha)
}

async function createTree(request: typeof globalThis.fetch, token: string, repositoryId: string, baseTreeSha: string, tree: readonly Readonly<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }>[]): Promise<string> {
  const response = await github(request, token, `/repositories/${repositoryId}/git/trees`, 'POST', { base_tree: baseTreeSha, tree })
  return sha(response.sha)
}

async function createCommit(request: typeof globalThis.fetch, token: string, repositoryId: string, baseCommitSha: string, treeSha: string): Promise<string> {
  const response = await github(request, token, `/repositories/${repositoryId}/git/commits`, 'POST', { message: 'Update component documentation', tree: treeSha, parents: [baseCommitSha] })
  return sha(response.sha)
}

async function updateReference(request: typeof globalThis.fetch, token: string, pathname: string, commitSha: string): Promise<boolean> {
  const response = await request(new URL(pathname, 'https://api.github.com'), { method: 'PATCH', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: githubHeaders(token), body: JSON.stringify({ sha: commitSha, force: false }) })
  if (response.status === 409 || response.status === 422) return false
  if (!response.ok || response.status >= 300) throw new Error(`GitHub documentation save returned ${response.status}.`)
  const value = record(await response.json(), 'GitHub reference')
  return sha(record(value.object, 'GitHub reference object').sha) === commitSha
}

async function github(request: typeof globalThis.fetch, token: string, pathname: string, method: 'GET' | 'POST' = 'GET', body?: object): Promise<Record<string, unknown>> {
  const response = await request(new URL(pathname, 'https://api.github.com'), { method, redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: githubHeaders(token), ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok || response.status >= 300) throw new Error(`GitHub documentation save returned ${response.status}.`)
  return record(await response.json(), 'GitHub response')
}

function githubHeaders(token: string): HeadersInit {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken(token)}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Canvas documentation writer' }
}

function saveJob(reviewInput: unknown, accessInput: unknown): HostedDocsSaveJob {
  const review = exactRecord(reviewInput, ['id', 'leaseId', 'leaseExpiresAt', 'repositoryId', 'baseRef', 'baseCommitSha', 'baseTreeSha', 'proposedCommitSha', 'approvalDigest', 'preparedBundle'])
  const access = exactRecord(accessInput, ['token', 'expiresAt', 'contentsPermission'])
  if (access.contentsPermission !== 'write') throw new Error('Documentation save queue returned an invalid access grant.')
  const prepared = hostedDocsReview(review.preparedBundle)
  const approvalDigest = digest(review.approvalDigest)
  if (prepared.approvalDigest !== approvalDigest) throw new Error('Documentation save queue returned a changed review.')
  return Object.freeze({
    reviewId: uuid(review.id),
    leaseId: uuid(review.leaseId),
    leaseExpiresAt: integer(review.leaseExpiresAt),
    repositoryId: githubId(review.repositoryId),
    baseRef: branch(review.baseRef),
    baseCommitSha: sha(review.baseCommitSha),
    baseTreeSha: sha(review.baseTreeSha),
    proposedCommitSha: review.proposedCommitSha === null ? null : sha(review.proposedCommitSha),
    approvalDigest,
    bundle: prepared.bundle,
    accessToken: accessToken(access.token),
    accessExpiresAt: integer(access.expiresAt),
  })
}

function confirm(response: Record<string, unknown>, id: string, status: string): void {
  const review = record(response.review, 'documentation save result')
  if (review.id !== id || review.status !== status) throw new Error('Documentation save was not confirmed.')
}

function apiOrigin(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('API origin is invalid.'); return url.origin }
function serviceToken(value: string): string { if (new TextEncoder().encode(value).byteLength < 32 || /[\r\n]/.test(value)) throw new Error('Service token is invalid.'); return value }
function accessToken(value: unknown): string { if (typeof value !== 'string' || value.length < 8 || value.length > 2_048 || /\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Documentation save access token is invalid.'); return value }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`); return value as Record<string, unknown> }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> { const result = record(value, 'documentation save job'); if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) throw new Error('Documentation save queue returned an invalid job.'); return result }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Documentation save queue returned an invalid job.'); return value as number }
function uuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Documentation save queue returned an invalid job.'); return value }
function githubId(value: unknown): string { if (typeof value !== 'string' || !/^[1-9][0-9]{0,31}$/.test(value)) throw new Error('Documentation save queue returned an invalid job.'); return value }
function sha(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Documentation save queue returned an invalid Git identity.'); return value }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Documentation save queue returned an invalid review digest.'); return value }
function branch(value: unknown): string { if (typeof value !== 'string' || !/^refs\/heads\/(?!.*(?:^|\/)\.\.?$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/.test(value)) throw new Error('Documentation save queue returned an invalid branch.'); return value }
function retryable(error: unknown): boolean { return error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError' || error instanceof Error && /returned (?:429|5\d\d)\b/.test(error.message) }
