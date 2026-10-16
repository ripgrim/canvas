import { open, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { scanShadcnPreviewRegistry } from '@canvas/scanner/preview-registry'
import type { ShadcnPreviewRegistryRequest, ShadcnScan } from '@canvas/scanner/contracts'
import { x } from 'tar'
import type { ReadEntry } from 'tar'

export type HostedRepositorySnapshotRequest = Readonly<{
  repositoryId: string
  accessToken: string
  sourceRevision?: string
}>

export type HostedRepositoryScan = Readonly<{
  sourceRevision: string
  scan: ShadcnScan
  request: ShadcnPreviewRegistryRequest
}>

export type HostedRepositorySnapshot = Readonly<{
  root: string
  sourceRevision: string
  dispose(): Promise<void>
}>

export interface HostedRepositorySnapshotPort {
  open(input: HostedRepositorySnapshotRequest): Promise<HostedRepositorySnapshot>
}

export type HostedDocsSourceRequest = Readonly<{ reviewId: string; leaseId: string; sourceRevision: string }>
export interface HostedDocsSnapshotPort {
  open(input: HostedDocsSourceRequest): Promise<HostedRepositorySnapshot>
}

export type HostedRepositoryQueueJob = Readonly<{
  id: string
  repositoryId: string
  accessToken: string
  leaseId: string
  attempt: number
}>

export interface HostedRepositoryQueuePort {
  claim(): Promise<HostedRepositoryQueueJob | null>
  complete(jobId: string, leaseId: string, result: HostedRepositoryScan): Promise<void>
  retry(jobId: string, leaseId: string, nextAttemptAt: number): Promise<void>
  fail(jobId: string, leaseId: string, errorId: string): Promise<void>
}

const githubOrigin = 'https://api.github.com'
const maximumJsonBytes = 1024 * 1024
const maximumArchiveBytes = 50 * 1024 * 1024
const maximumExpandedArchiveBytes = 64 * 1024 * 1024
const maximumFiles = 5_000
const maximumEntries = 10_000
const maximumFileBytes = 2 * 1024 * 1024
const maximumRepositoryBytes = 50 * 1024 * 1024
const apiRequestTimeoutMs = 15_000
const archiveRequestTimeoutMs = 60_000

class TransientRepositoryError extends Error {}

export function createGitHubRepositorySnapshotPort(options: Readonly<{ fetch?: typeof globalThis.fetch; createTemporaryRoot?: () => Promise<string> }> = {}): HostedRepositorySnapshotPort {
  const request = options.fetch ?? globalThis.fetch
  const createTemporaryRoot = options.createTemporaryRoot ?? (() => mkdtemp(path.join(tmpdir(), 'canvas-repository-')))
  const readApi = async (pathname: string, token: string): Promise<unknown> => {
    const response = await request(new URL(pathname, githubOrigin), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(apiRequestTimeoutMs),
      headers: apiHeaders(token),
    })
    if (response.status === 429 || response.status >= 500) throw new TransientRepositoryError(`GitHub repository source returned ${response.status}.`)
    if (!response.ok || isRedirect(response)) throw new Error('GitHub repository source is unavailable.')
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) throw new Error('GitHub returned an invalid repository response.')
    return readJson(response, maximumJsonBytes)
  }

  const snapshot: HostedRepositorySnapshotPort = {
    async open(input: HostedRepositorySnapshotRequest): Promise<HostedRepositorySnapshot> {
      const repositoryId = identifier(input.repositoryId, 'repository id')
      const token = secret(input.accessToken)
      const repository = record(await readApi(`/repositories/${repositoryId}`, token), 'repository')
      if (identifier(repository.id, 'repository id') !== repositoryId) throw new Error('GitHub returned another repository.')
      const fullName = repositoryName(repository.full_name)
      let sourceRevision: string
      if (input.sourceRevision) sourceRevision = shaValue(input.sourceRevision)
      else {
        const branch = branchName(repository.default_branch)
        const commit = record(await readApi(`/repositories/${repositoryId}/commits/${encodeURIComponent(branch)}`, token), 'repository revision')
        sourceRevision = shaValue(commit.sha)
      }
      const redirect = await request(new URL(`/repositories/${repositoryId}/tarball/${sourceRevision}`, githubOrigin), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(apiRequestTimeoutMs),
        headers: apiHeaders(token),
      })
      const archiveUrl = archiveRedirect(redirect, fullName, sourceRevision)
      const archive = await request(archiveUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(archiveRequestTimeoutMs),
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'Canvas repository scanner',
        },
      })
      if (archive.status === 429 || archive.status >= 500) throw new TransientRepositoryError(`GitHub repository archive returned ${archive.status}.`)
      if (!archive.ok || isRedirect(archive)) throw new Error('GitHub repository archive is unavailable.')
      const contentType = (archive.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (!contentType || !['application/gzip', 'application/octet-stream', 'application/x-gzip'].includes(contentType)) throw new Error('GitHub returned an invalid repository archive.')

      return materializeArchive(archive, sourceRevision, createTemporaryRoot)
    },
  }
  return Object.freeze(snapshot)
}

export function createHttpHostedDocsSnapshotPort(options: Readonly<{ apiOrigin: string; serviceToken: string; fetch?: typeof globalThis.fetch; createTemporaryRoot?: () => Promise<string> }>): HostedDocsSnapshotPort {
  const origin = httpOrigin(options.apiOrigin)
  const serviceToken = serviceSecret(options.serviceToken)
  const request = options.fetch ?? globalThis.fetch
  const createTemporaryRoot = options.createTemporaryRoot ?? (() => mkdtemp(path.join(tmpdir(), 'canvas-docs-review-')))
  return Object.freeze({
    async open(input: HostedDocsSourceRequest): Promise<HostedRepositorySnapshot> {
      const reviewId = uuid(input.reviewId, 'review id')
      const leaseId = uuid(input.leaseId, 'lease id')
      const sourceRevision = shaValue(input.sourceRevision)
      const response = await request(new URL(`/internal/repository-doc-reviews/${reviewId}/source`, origin), {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
        body: JSON.stringify({ leaseId }),
      })
      const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (!response.ok || isRedirect(response) || !contentType || !['application/gzip', 'application/octet-stream', 'application/x-gzip'].includes(contentType)) throw new Error('Documentation review source is unavailable.')
      return materializeArchive(response, sourceRevision, createTemporaryRoot)
    },
  })
}

async function materializeArchive(archive: Response, sourceRevision: string, createTemporaryRoot: () => Promise<string>): Promise<HostedRepositorySnapshot> {
  const ownedRoot = await createTemporaryRoot()
  const archivePath = path.join(ownedRoot, 'source.tar.gz')
  const expandedArchivePath = path.join(ownedRoot, 'source.tar')
  const sourceRoot = path.join(ownedRoot, 'source')
  try {
    await writeResponse(archive, archivePath, maximumArchiveBytes)
    await expandArchive(archivePath, expandedArchivePath)
    await extractArchive(expandedArchivePath, sourceRoot)
    let disposed = false
    return Object.freeze({
      root: sourceRoot,
      sourceRevision,
      async dispose() {
        if (disposed) return
        await rm(ownedRoot, { recursive: true, force: true })
        disposed = true
      },
    })
  } catch (error) {
    await rm(ownedRoot, { recursive: true, force: true })
    throw error
  }
}

export function createHostedRepositoryScanner(snapshot: HostedRepositorySnapshotPort = createGitHubRepositorySnapshotPort()) {
  return Object.freeze({
    async scan(input: HostedRepositorySnapshotRequest): Promise<HostedRepositoryScan> {
      const source = await snapshot.open(input)
      try {
        const result = await scanShadcnPreviewRegistry(source.root)
        return Object.freeze({ ...result, sourceRevision: source.sourceRevision })
      } finally {
        await source.dispose()
      }
    },
  })
}

export function createHttpHostedRepositoryQueue(options: Readonly<{ apiOrigin: string; serviceToken: string; fetch?: typeof globalThis.fetch }>): HostedRepositoryQueuePort {
  const origin = httpOrigin(options.apiOrigin)
  const serviceToken = serviceSecret(options.serviceToken)
  const fetchRequest = options.fetch ?? globalThis.fetch
  const request = async (pathname: string, body: object): Promise<Record<string, unknown>> => {
    const response = await fetchRequest(new URL(pathname, origin), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
      body: JSON.stringify(body),
    })
    if (response.status >= 300 && response.status < 400 || !response.ok) throw new Error(`Repository queue returned ${response.status}.`)
    const value = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Repository queue returned an invalid response.')
    return value as Record<string, unknown>
  }
  const queue: HostedRepositoryQueuePort = {
    async claim() {
      const body = await request('/internal/repository-jobs/claim', {})
      if (body.job === null) return null
      const job = queueRecord(body.job, 'job')
      const repository = queueRecord(body.repository, 'repository')
      const lease = queueRecord(body.lease, 'lease')
      const access = queueRecord(body.access, 'access')
      return Object.freeze({
        id: uuid(job.id, 'job id'),
        repositoryId: identifier(repository.repositoryId, 'repository id'),
        accessToken: serviceAccessToken(access.token),
        leaseId: uuid(lease.id, 'lease id'),
        attempt: queueInteger(job.attempt, 'attempt'),
      })
    },
    async complete(jobId, leaseId, result) {
      const body = await request(`/internal/repository-jobs/${uuid(jobId, 'job id')}/complete`, { leaseId: uuid(leaseId, 'lease id'), result })
      const job = queueRecord(body.job, 'completed job')
      if (job.status !== 'completed' || job.id !== jobId) throw new Error('Repository queue completion was not confirmed.')
    },
    async retry(jobId, leaseId, nextAttemptAt) {
      const body = await request(`/internal/repository-jobs/${uuid(jobId, 'job id')}/retry`, { leaseId: uuid(leaseId, 'lease id'), nextAttemptAt })
      if (body.status !== 'queued') throw new Error('Repository queue retry was not confirmed.')
    },
    async fail(jobId, leaseId, errorId) {
      const body = await request(`/internal/repository-jobs/${uuid(jobId, 'job id')}/fail`, { leaseId: uuid(leaseId, 'lease id'), errorId })
      if (body.status !== 'failed') throw new Error('Repository queue failure was not confirmed.')
    },
  }
  return Object.freeze(queue)
}

export function createHostedRepositoryQueueProcessor(options: Readonly<{ queue: HostedRepositoryQueuePort; scanner: ReturnType<typeof createHostedRepositoryScanner> }>) {
  return Object.freeze({
    async runOnce(): Promise<'idle' | 'completed'> {
      const job = await options.queue.claim()
      if (!job) return 'idle'
      try {
        const result = await options.scanner.scan({ repositoryId: job.repositoryId, accessToken: job.accessToken })
        await options.queue.complete(job.id, job.leaseId, result)
        return 'completed'
      } catch (error) {
        if (job.attempt < 3 && retryable(error)) await options.queue.retry(job.id, job.leaseId, Date.now() + Math.min(30_000, 1_000 * 2 ** job.attempt))
        else await options.queue.fail(job.id, job.leaseId, errorId(error))
        throw error
      }
    },
  })
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const paths = new Set<string>()
  let archiveRoot: string | undefined
  let validationError: Error | undefined
  let entries = 0
  let files = 0
  let totalBytes = 0
  await mkdir(destination)
  await x({
    file: archivePath,
    cwd: destination,
    gzip: false,
    strip: 1,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    unlink: true,
    maxDepth: 64,
    filter(rawPath, rawEntry) {
      if (validationError) return false
      try {
        const entry = rawEntry as ReadEntry
        if (!Number.isInteger(entry.mode) || entry.mode! < 0 || entry.mode! > 0o777) throw new Error('Repository archive contains an unsupported source mode.')
        entries += 1
        if (entries > maximumEntries) throw new Error('Repository archive exceeds the supported entry limit.')
        const parsed = archivePathValue(rawPath)
        archiveRoot ??= parsed.root
        if (parsed.root !== archiveRoot) throw new Error('Repository archive contains multiple source roots.')
        if (!parsed.relative) {
          if (entry.type !== 'Directory') throw new Error('Repository archive has an invalid source root.')
          return true
        }
        const sourcePath = sourcePathValue(parsed.relative)
        const collisionKey = sourcePath.toLowerCase()
        if (paths.has(collisionKey)) throw new Error('Repository archive contains duplicate source paths.')
        paths.add(collisionKey)
        if (entry.type === 'Directory') return true
        if (entry.type !== 'File' && entry.type !== 'OldFile') throw new Error('Repository archive contains an unsupported source entry.')
        if (entry.size > maximumFileBytes) throw new Error('Repository archive contains an oversized source file.')
        files += 1
        totalBytes += entry.size
        if (files > maximumFiles || totalBytes > maximumRepositoryBytes) throw new Error('Repository archive exceeds the supported source limits.')
        return true
      } catch (error) {
        validationError = error instanceof Error ? error : new Error('Repository archive is invalid.')
        return false
      }
    },
  })
  if (validationError) throw validationError
}

async function expandArchive(source: string, destination: string): Promise<void> {
  let total = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength
      callback(total > maximumExpandedArchiveBytes ? new Error('Repository archive exceeds the supported expanded size.') : null, chunk)
    },
  })
  await pipeline(createReadStream(source), createGunzip(), limiter, createWriteStream(destination, { flags: 'wx' }))
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const bytes = await readResponse(response, limit, 'GitHub response')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error('GitHub returned invalid JSON.')
  }
}

async function writeResponse(response: Response, destination: string, limit: number): Promise<void> {
  const handle = await open(destination, 'wx')
  try {
    for await (const chunk of responseReader(response, limit, 'GitHub repository archive')) await handle.write(chunk)
  } finally {
    await handle.close()
  }
}

async function readResponse(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of responseReader(response, limit, label)) {
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function* responseReader(response: Response, limit: number, label: string): AsyncGenerator<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > limit)) throw new Error(`${label} exceeds the supported size.`)
  if (!response.body) throw new Error(`${label} is empty.`)
  const reader = response.body.getReader()
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > limit) throw new Error(`${label} exceeds the supported size.`)
      yield result.value
    }
  } finally {
    try { await reader.cancel() }
    catch (error) { console.error(JSON.stringify({ level: 'error', event: 'repository_response_cancel_failed', message: error instanceof Error ? error.message : String(error) })) }
  }
}

function apiHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Canvas repository scanner',
  }
}

function archiveRedirect(response: Response, fullName: string, sourceRevision: string): URL {
  if (![302, 307].includes(response.status)) throw new Error('GitHub repository archive redirect is unavailable.')
  const location = response.headers.get('location')
  if (!location) throw new Error('GitHub repository archive redirect is unavailable.')
  let url: URL
  try {
    url = new URL(location)
  } catch {
    throw new Error('GitHub returned an invalid repository archive redirect.')
  }
  const expectedPath = `/${fullName}/legacy.tar.gz/${sourceRevision}`
  if (url.protocol !== 'https:' || url.hostname !== 'codeload.github.com' || url.port || url.username || url.password || url.hash || url.search || url.pathname !== expectedPath) throw new Error('GitHub returned an invalid repository archive redirect.')
  return url
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`GitHub returned an invalid ${label}.`)
  return value as Record<string, unknown>
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Invalid ${label}.`)
  const result = String(value)
  if (!/^[1-9][0-9]{0,31}$/.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

function secret(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2_048 || /\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid repository access token.')
  return value
}

function branchName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('GitHub returned an invalid default branch.')
  return value
}

function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) throw new Error('GitHub returned an invalid repository name.')
  return value
}

function archivePathValue(value: unknown): Readonly<{ root: string; relative: string }> {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 1_024 || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Repository archive contains an invalid source path.')
  const segments = value.split('/')
  if (segments.at(-1) === '') segments.pop()
  if (segments.length < 1 || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Repository archive contains an invalid source path.')
  return Object.freeze({ root: segments[0]!, relative: segments.slice(1).join('/') })
}

function sourcePathValue(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 512 || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Repository archive contains an invalid source path.')
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) throw new Error('Repository archive contains an invalid source path.')
  return value
}

function shaValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('GitHub returned an invalid source identity.')
  return value
}

function httpOrigin(value: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('API origin is invalid.')
  return url.origin
}

function serviceSecret(value: string): string {
  if (new TextEncoder().encode(value).byteLength < 32 || /[\r\n]/.test(value)) throw new Error('Repository service token is invalid.')
  return value
}

function serviceAccessToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2_048 || /\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Repository queue returned an invalid access token.')
  return value
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Repository queue returned an invalid ${label}.`)
  return value
}

function queueRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Repository queue returned an invalid ${label}.`)
  return value as Record<string, unknown>
}

function queueInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000) throw new Error(`Repository queue returned an invalid ${label}.`)
  return value as number
}

function retryable(error: unknown): boolean {
  if (error instanceof TransientRepositoryError || error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError') return true
  return error instanceof Error && /(?:returned|queue returned) (?:429|5\d\d)\b/.test(error.message)
}

function errorId(error: unknown): string {
  if (error instanceof Error && /No scanned component/.test(error.message)) return 'no-supported-components'
  if (error instanceof Error && /archive|source|repository|GitHub/.test(error.message)) return 'repository-scan-failed'
  return 'repository-scan-failed'
}
