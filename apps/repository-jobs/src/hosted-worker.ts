import { parseShadcnScanArtifact, type ShadcnScanArtifact } from '@canvas/scanner/artifact'
import { HostedPreviewArtifactReconciliationError } from '@canvas/preview-runtime/hosted-artifact'
import type { HostedRepositorySnapshotPort } from './index.js'

export type HostedPreviewBuildQueueJob = Readonly<{
  id: string
  fileId: string
  fileRevision: number
  artifactId: string
  stagingId: string
  repositoryId: string
  accessToken: string
  leaseId: string
  attempts: number
  scan: ShadcnScanArtifact
  artifactOrigin: string
  artifactCapability: string
}>

export interface HostedPreviewBuildQueuePort {
  claim(): Promise<HostedPreviewBuildQueueJob | null>
  complete(jobId: string, leaseId: string): Promise<void>
  retry(jobId: string, leaseId: string, nextAttemptAt: number): Promise<void>
  fail(jobId: string, leaseId: string, errorId: string): Promise<void>
}

export type HostedPreviewBuildPublisher = Readonly<{
  build(input: Readonly<{
    artifactId: string
    stagingId: string
    fileId: string
    fileRevision: number
    repositoryRoot: string
    scan: ShadcnScanArtifact
  }>): Promise<Readonly<{ artifactId: string; entrypoint: string }>>
}>

export function createHttpHostedPreviewBuildQueue(options: Readonly<{
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}>): HostedPreviewBuildQueuePort {
  const origin = httpOrigin(options.apiOrigin)
  const serviceToken = serviceSecret(options.serviceToken)
  const fetchRequest = options.fetch ?? globalThis.fetch
  const request = async (pathname: string, body: object): Promise<Record<string, unknown>> => {
    const response = await fetchRequest(new URL(pathname, origin), {
      method: 'POST',
      credentials: 'omit',
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
      body: JSON.stringify(body),
    })
    if (!response.ok || response.status >= 300 && response.status < 400) throw new Error(`Hosted preview build queue returned ${response.status}.`)
    const value = await readBoundedJson(response, 6 * 1024 * 1024)
    if (!record(value)) throw new Error('Hosted preview build queue returned an invalid response.')
    return value
  }
  const queue: HostedPreviewBuildQueuePort = {
    async claim() {
      const body = await request('/internal/hosted-preview-builds/claim', {})
      if (body.job === null) {
        if (Object.keys(body).join(',') !== 'job') invalidQueueResponse()
        return null
      }
      if (Object.keys(body).sort().join(',') !== 'access,artifactAccess,job,lease,repository,scan') invalidQueueResponse()
      const job = exactRecord(body.job, ['id', 'fileId', 'fileRevision', 'projectId', 'scanJobId', 'artifactId', 'stagingId', 'status', 'attempts'])
      const lease = exactRecord(body.lease, ['id', 'expiresAt'])
      const repository = exactRecord(body.repository, ['repositoryId'])
      const access = exactRecord(body.access, ['token', 'expiresAt', 'contentsPermission'])
      const artifactAccess = exactRecord(body.artifactAccess, ['origin', 'token', 'expiresAt'])
      const now = Date.now()
      const leaseExpiresAt = typeof lease.expiresAt === 'string' ? Date.parse(lease.expiresAt) : Number.NaN
      if (job.status !== 'leased' || access.contentsPermission !== 'read' || !futureEpochMilliseconds(access.expiresAt, now)
        || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now
        || !boundedFutureEpochSeconds(artifactAccess.expiresAt, now, leaseExpiresAt)) invalidQueueResponse()
      return Object.freeze({
        id: uuid(job.id),
        fileId: uuid(job.fileId),
        fileRevision: nonnegativeInteger(job.fileRevision),
        artifactId: uuid(job.artifactId),
        stagingId: uuid(job.stagingId),
        repositoryId: identifier(repository.repositoryId),
        accessToken: accessToken(access.token),
        leaseId: uuid(lease.id),
        attempts: positiveInteger(job.attempts),
        scan: parseShadcnScanArtifact(body.scan),
        artifactOrigin: httpOrigin(text(artifactAccess.origin)),
        artifactCapability: capability(artifactAccess.token),
      })
    },
    async complete(jobId, leaseId) {
      const body = await request(`/internal/hosted-preview-builds/${uuid(jobId)}/complete`, { leaseId: uuid(leaseId) })
      if (JSON.stringify(body) !== JSON.stringify({ status: 'completed' })) invalidQueueResponse()
    },
    async retry(jobId, leaseId, nextAttemptAt) {
      const body = await request(`/internal/hosted-preview-builds/${uuid(jobId)}/retry`, { leaseId: uuid(leaseId), nextAttemptAt })
      if (JSON.stringify(body) !== JSON.stringify({ status: 'queued' })) invalidQueueResponse()
    },
    async fail(jobId, leaseId, errorId) {
      if (!/^[a-z0-9-]{3,64}$/.test(errorId)) throw new Error('Hosted preview build error identity is invalid.')
      const body = await request(`/internal/hosted-preview-builds/${uuid(jobId)}/fail`, { leaseId: uuid(leaseId), errorId })
      if (JSON.stringify(body) !== JSON.stringify({ status: 'failed' })) invalidQueueResponse()
    },
  }
  return Object.freeze(queue)
}

export function createHostedPreviewBuildQueueProcessor(options: Readonly<{
  queue: HostedPreviewBuildQueuePort
  snapshot: HostedRepositorySnapshotPort
  publisher(job: HostedPreviewBuildQueueJob): HostedPreviewBuildPublisher
}>) {
  return Object.freeze({
    async runOnce(): Promise<'idle' | 'completed'> {
      const job = await options.queue.claim()
      if (!job) return 'idle'
      try {
        const source = await options.snapshot.open({ repositoryId: job.repositoryId, accessToken: job.accessToken, sourceRevision: job.scan.sourceRevision })
        try {
          if (source.sourceRevision !== job.scan.sourceRevision) throw new Error('Hosted preview source revision changed.')
          await options.publisher(job).build({
            artifactId: job.artifactId,
            stagingId: job.stagingId,
            fileId: job.fileId,
            fileRevision: job.fileRevision,
            repositoryRoot: source.root,
            scan: job.scan,
          })
        } finally {
          await source.dispose()
        }
        await options.queue.complete(job.id, job.leaseId)
        return 'completed'
      } catch (error) {
        if (job.attempts < 3 && retryable(error)) await options.queue.retry(job.id, job.leaseId, Date.now() + Math.min(30_000, 1_000 * 2 ** job.attempts))
        else await options.queue.fail(job.id, job.leaseId, buildErrorId(error))
        throw error
      }
    },
  })
}

function retryable(error: unknown): boolean {
  if (error instanceof HostedPreviewArtifactReconciliationError) return true
  if (error instanceof TypeError || error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) return true
  return error instanceof Error && /(?:returned|returning) (?:408|425|429|5\d\d)\b/.test(error.message)
}

function buildErrorId(error: unknown): string {
  if (error instanceof Error && /source revision changed/i.test(error.message)) return 'source-revision-changed'
  if (error instanceof Error && /sandbox/i.test(error.message)) return 'preview-build-failed'
  if (error instanceof Error && /artifact/i.test(error.message)) return 'preview-artifact-invalid'
  return 'preview-build-failed'
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalidQueueResponse()
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalidQueueResponse()
  return value.toLowerCase()
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,31}$/.test(value)) invalidQueueResponse()
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string') invalidQueueResponse()
  return value
}

function accessToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2_048 || /\s|[\u0000-\u001f\u007f]/u.test(value)) invalidQueueResponse()
  return value
}

function capability(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) invalidQueueResponse()
  return value
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalidQueueResponse()
  return Number(value)
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidQueueResponse()
  return Number(value)
}

function futureEpochMilliseconds(value: unknown, now: number): boolean {
  return Number.isSafeInteger(value) && Number(value) > now
}

function boundedFutureEpochSeconds(value: unknown, now: number, leaseExpiresAt: number): boolean {
  const seconds = Number(value)
  const nowSeconds = Math.floor(now / 1_000)
  return Number.isSafeInteger(value) && seconds > nowSeconds && seconds <= Math.min(nowSeconds + 300, Math.floor(leaseExpiresAt / 1_000))
}

function httpOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Hosted preview build origin is invalid.') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('Hosted preview build origin is invalid.')
  return url.origin
}

function serviceSecret(value: string): string {
  if (new TextEncoder().encode(value).byteLength < 32 || /[\r\n]/.test(value)) throw new Error('Hosted preview build service token is invalid.')
  return value
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !response.body) invalidQueueResponse()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > maximumBytes) invalidQueueResponse()
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { invalidQueueResponse() }
}

function invalidQueueResponse(): never {
  throw new Error('Hosted preview build queue returned an invalid response.')
}
