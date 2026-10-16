import {
  parseSourceBindingReconcileCommand,
  parseSourceBindingSnapshot,
  type SourceBindingReconcileCommand,
  type SourceBindingSnapshot,
} from '@canvas/repository'

export type CloudUser = Readonly<{
  id: string
  name: string
  email: string
  image: string | null
}>

export type CloudFileSummary = Readonly<{
  id: string
  projectId: string | null
  name: string
  headRevision: number
  thumbnailKey: string | null
  createdAt: string
  updatedAt: string
}>

export type CloudDocument<TDocument> = Readonly<{
  fileId: string
  revision: number
  document: TDocument
}>

export type CloudThumbnailMetadata = Readonly<{
  fileId: string
  revision: number
  thumbnailKey: string | null
}>

export type CloudFileShare = Readonly<{
  fileId: string
  access: 'private' | 'view'
  updatedAt: string
}>

export type CloudRepository = Readonly<{
  id: string
  ownerLogin: string
  name: string
  fullName: string
  isPrivate: boolean
}>

export type CloudRepositoryConnection = Readonly<{ installationId: string; repository: CloudRepository }>
export type CloudSourceBindingSnapshot = SourceBindingSnapshot
export type CloudSourceBindingReconcileInput = SourceBindingReconcileCommand
export type CloudHostedPreview = Readonly<{
  artifactId: string
  url: string
  expiresAt: number
}>
export type CloudHostedPreviewBuildJob = Readonly<{
  id: string
  fileId: string
  fileRevision: number
  status: 'queued' | 'leased' | 'completed' | 'failed'
  attempts: number
  createdAt: string
  artifactId?: string
  completedAt?: string
  errorId?: string
  failedAt?: string
}>
export type CloudRepositoryScanJob = Readonly<{
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  attempt: number
  errorId?: string
  result: null | Readonly<{ sourceRevision: string; scan: Readonly<Record<string, unknown>>; request: Readonly<Record<string, unknown>> }>
}>
export type CloudRepositoryDocsReviewFile = Readonly<{ path: string; beforeSha256: string | null; after: string | null; diff: string }>
export type CloudRepositoryDocsReviewBundle = Readonly<{
  files: readonly CloudRepositoryDocsReviewFile[]
  omissions: readonly Readonly<{ componentId: string; reason: 'example-adapter-required' | 'usage-adapter-required' }>[]
  validation: readonly Readonly<{ name: string; detail: string }>[]
}>
export type CloudRepositoryDocsReview = Readonly<{
  id: string
  projectId: string
  fileId: string
  fileRevision: number
  status: 'queued_prepare' | 'preparing' | 'prepared' | 'queued_save' | 'saving' | 'saved' | 'stale' | 'failed'
  baseRef: string
  baseCommitSha: string
  approvalDigest: string | null
  preparedBundle: CloudRepositoryDocsReviewBundle | null
  committedSha: string | null
  errorId: string | null
}>

export type CloudSharedFile<TDocument> = Readonly<{
  file: Readonly<{ id: string; name: string; headRevision: number; updatedAt: string }>
  fileId: string
  revision: number
  document: TDocument
}>

export class CloudApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly requestId: string

  constructor(message: string, status: number, code: string | null = null, requestId: string = crypto.randomUUID(), options?: ErrorOptions) {
    super(message, options)
    this.name = 'CloudApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export type CloudApiClientOptions<TDocument> = Readonly<{
  apiOrigin: string
  hostedPreviewOrigin?: string
  fetch?: typeof fetch
  validateDocument(value: unknown): TDocument
}>

type JsonObject = Record<string, unknown>

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as JsonObject
}

function exact(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  if (!required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Unexpected response fields.')
}

function string(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${label}.`)
  return value
}

function identifier(value: unknown, label: string): string {
  const result = string(value, label, 80)
  if (!idPattern.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

function githubIdentifier(value: unknown, label: string): string {
  const result = string(value, label, 32)
  if (!/^[1-9][0-9]{0,31}$/.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

function accountIdentifier(value: unknown): string {
  const result = string(value, 'user id', 200)
  if (/\s|[\u0000-\u001f\u007f]/u.test(result)) throw new Error('Invalid user id.')
  return result
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}.`)
  return value as number
}

function nullableString(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : string(value, label, maximum)
}

function instant(value: unknown, label: string): string {
  const result = string(value, label, 64)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label}.`)
  return result
}

function parseOrigin(value: string): string {
  let result: URL
  try { result = new URL(value) } catch { throw new Error('API origin must be an HTTP or HTTPS origin.') }
  if (!['http:', 'https:'].includes(result.protocol) || result.origin !== value || result.username || result.password) throw new Error('API origin must be an HTTP or HTTPS origin.')
  if (result.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(result.hostname)) throw new Error('API origin must use HTTPS outside loopback.')
  return result.origin
}

function parseHostedPreview(value: unknown, artifactId: string, previewOrigin: string): CloudHostedPreview {
  const preview = object(value, 'hosted preview')
  exact(preview, ['artifactId', 'url', 'expiresAt'])
  const returnedArtifactId = identifier(preview.artifactId, 'hosted preview artifact id')
  if (returnedArtifactId !== artifactId) throw new Error('The server returned another hosted preview artifact.')
  const expiresAt = integer(preview.expiresAt, 'hosted preview expiry')
  const rawUrl = string(preview.url, 'hosted preview URL', 4_096)
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('Invalid hosted preview URL.') }
  if (url.origin !== previewOrigin || url.username || url.password || url.search || url.hash) throw new Error('Invalid hosted preview URL.')
  const segments = url.pathname.split('/')
  if (rawUrl !== url.toString() || artifactId !== artifactId.toLowerCase()
    || segments.length < 5 || segments[0] !== '' || segments[1] !== 'hosted' || segments[2] !== artifactId
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(segments[3]!)
    || segments.slice(4).some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw new Error('Invalid hosted preview URL.')
  return Object.freeze({ artifactId: returnedArtifactId, url: url.toString(), expiresAt })
}

function parseHostedPreviewBuildJob(value: unknown): CloudHostedPreviewBuildJob {
  const job = object(value, 'hosted preview build')
  const status = string(job.status, 'hosted preview build status')
  if (!['queued', 'leased', 'completed', 'failed'].includes(status)) throw new Error('Invalid hosted preview build status.')
  const optional = status === 'completed' ? ['artifactId', 'completedAt'] : status === 'failed' ? ['errorId', 'failedAt'] : []
  exact(job, ['id', 'fileId', 'fileRevision', 'status', 'attempts', 'createdAt'], optional)
  const result: CloudHostedPreviewBuildJob = {
    id: identifier(job.id, 'hosted preview build id'),
    fileId: identifier(job.fileId, 'hosted preview build file id'),
    fileRevision: integer(job.fileRevision, 'hosted preview build file revision'),
    status: status as CloudHostedPreviewBuildJob['status'],
    attempts: integer(job.attempts, 'hosted preview build attempts'),
    createdAt: instant(job.createdAt, 'hosted preview build created time'),
    ...(status === 'completed' ? {
      artifactId: identifier(job.artifactId, 'hosted preview artifact id'),
      completedAt: instant(job.completedAt, 'hosted preview build completed time'),
    } : {}),
    ...(status === 'failed' ? {
      errorId: string(job.errorId, 'hosted preview build error id', 64),
      failedAt: instant(job.failedAt, 'hosted preview build failed time'),
    } : {}),
  }
  return Object.freeze(result)
}

function parseSummary(value: unknown): CloudFileSummary {
  const result = object(value, 'file')
  exact(result, ['id', 'projectId', 'name', 'headRevision', 'thumbnailKey', 'createdAt', 'updatedAt'])
  return {
    id: identifier(result.id, 'file id'),
    projectId: result.projectId === null ? null : identifier(result.projectId, 'project id'),
    name: string(result.name, 'file name', 120),
    headRevision: integer(result.headRevision, 'file revision'),
    thumbnailKey: nullableString(result.thumbnailKey, 'thumbnail key', 240),
    createdAt: instant(result.createdAt, 'created time'),
    updatedAt: instant(result.updatedAt, 'updated time'),
  }
}

function parseThumbnail(value: unknown, fileId: string, expectedRevision: number): CloudThumbnailMetadata {
  const result = object(value, 'thumbnail')
  exact(result, ['fileId', 'revision', 'thumbnailKey'])
  const responseFileId = identifier(result.fileId, 'file id')
  const revision = integer(result.revision, 'thumbnail revision')
  if (responseFileId !== fileId) throw new Error('The server returned a thumbnail for another file.')
  if (revision !== expectedRevision) throw new Error('The server returned a thumbnail for another revision.')
  const thumbnailKey = nullableString(result.thumbnailKey, 'thumbnail key', 512)
  if (thumbnailKey !== null && thumbnailKey !== `thumbnails/${fileId}/thumbnail.avif`) throw new Error('The server returned an invalid thumbnail key.')
  return { fileId: responseFileId, revision, thumbnailKey }
}

function parseShare(value: unknown, expectedFileId: string): CloudFileShare {
  const result = object(value, 'share')
  exact(result, ['fileId', 'access', 'updatedAt'])
  const fileId = identifier(result.fileId, 'file id')
  if (fileId !== expectedFileId) throw new Error('The server returned sharing for another file.')
  if (result.access !== 'private' && result.access !== 'view') throw new Error('Invalid share access.')
  return { fileId, access: result.access, updatedAt: instant(result.updatedAt, 'updated time') }
}

function parseRepository(value: unknown): CloudRepository {
  const result = object(value, 'repository')
  exact(result, ['id', 'ownerLogin', 'name', 'fullName', 'isPrivate'])
  const ownerLogin = string(result.ownerLogin, 'repository owner', 39)
  const name = string(result.name, 'repository name', 100)
  const fullName = string(result.fullName, 'repository full name', 140)
  if (fullName !== `${ownerLogin}/${name}` || typeof result.isPrivate !== 'boolean') throw new Error('Invalid repository.')
  return { id: githubIdentifier(result.id, 'repository id'), ownerLogin, name, fullName, isPrivate: result.isPrivate }
}

function parseRepositoryScanJob(value: unknown): CloudRepositoryScanJob {
  const job = object(value, 'repository scan job')
  if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'completed' && job.status !== 'failed') throw new Error('Invalid repository scan status.')
  exact(job, ['id', 'operation', 'status', 'attempt'], job.status === 'completed' ? ['result', 'completedAt'] : job.status === 'failed' ? ['errorId', 'failedAt'] : [])
  if (job.operation !== 'scan') throw new Error('Invalid repository scan operation.')
  const id = identifier(job.id, 'repository job id')
  const attempt = integer(job.attempt, 'repository scan attempt')
  if (job.status === 'failed') { instant(job.failedAt, 'repository scan failure'); return { id, status: 'failed', attempt, errorId: string(job.errorId, 'repository scan error', 64), result: null } }
  if (job.status !== 'completed') return { id, status: job.status, attempt, result: null }
  const result = object(job.result, 'repository scan result')
  exact(result, ['sourceRevision', 'scan', 'request'])
  const sourceRevision = string(result.sourceRevision, 'repository source revision', 40)
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error('Invalid repository source revision.')
  const scan = object(result.scan, 'repository scanner result')
  const request = object(result.request, 'repository registry request')
  instant(job.completedAt, 'repository scan completion')
  return { id, status: 'completed', attempt, result: { sourceRevision, scan, request } }
}

export function parseCloudSourceBindingSnapshot(value: unknown, projectId: string): CloudSourceBindingSnapshot {
  const snapshot = parseSourceBindingSnapshot(value)
  if (snapshot.authority.repository.projectId !== projectId) throw new Error('The server returned source bindings for another project.')
  return snapshot
}

function parseRepositoryDocsReview(value: unknown): CloudRepositoryDocsReview {
  const review = object(value, 'repository documentation review')
  exact(review, ['id', 'projectId', 'fileId', 'fileRevision', 'status', 'baseRef', 'baseCommitSha', 'approvalDigest', 'preparedBundle', 'committedSha', 'errorId'])
  const status = string(review.status, 'repository documentation review status', 32)
  if (!['queued_prepare', 'preparing', 'prepared', 'queued_save', 'saving', 'saved', 'stale', 'failed'].includes(status)) throw new Error('Invalid repository documentation review status.')
  const baseRef = string(review.baseRef, 'repository documentation base ref', 266)
  const baseCommitSha = string(review.baseCommitSha, 'repository documentation base commit', 40)
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/.test(baseRef) || !/^[a-f0-9]{40}$/.test(baseCommitSha)) throw new Error('Invalid repository documentation source identity.')
  const approvalDigest = review.approvalDigest === null ? null : string(review.approvalDigest, 'repository documentation approval digest', 64)
  if (approvalDigest !== null && !/^[a-f0-9]{64}$/.test(approvalDigest)) throw new Error('Invalid repository documentation approval digest.')
  const errorId = review.errorId === null ? null : string(review.errorId, 'repository documentation error id', 64)
  const preparedBundle = review.preparedBundle === null ? null : parseRepositoryDocsReviewBundle(review.preparedBundle)
  const committedSha = review.committedSha === null ? null : string(review.committedSha, 'repository documentation commit', 40)
  if (committedSha !== null && !/^[a-f0-9]{40}$/.test(committedSha)) throw new Error('Invalid repository documentation commit.')
  if ((status === 'prepared' || status === 'queued_save' || status === 'saving' || status === 'saved') && (!approvalDigest || !preparedBundle)) throw new Error('Incomplete repository documentation review.')
  if ((status === 'saved') !== (committedSha !== null)) throw new Error('Incomplete repository documentation save result.')
  return Object.freeze({
    id: identifier(review.id, 'repository documentation review id'),
    projectId: identifier(review.projectId, 'project id'),
    fileId: identifier(review.fileId, 'file id'),
    fileRevision: integer(review.fileRevision, 'file revision'),
    status: status as CloudRepositoryDocsReview['status'],
    baseRef,
    baseCommitSha,
    approvalDigest,
    preparedBundle,
    committedSha,
    errorId,
  })
}

function parseRepositoryDocsReviewBundle(value: unknown): CloudRepositoryDocsReviewBundle {
  const bundle = object(value, 'repository documentation bundle')
  const required = ['version', 'projectId', 'fileId', 'fileRevision', 'fileDocumentSha256', 'scanJobId', 'installationId', 'repositoryId', 'repositoryGrantId', 'repositoryLinkedAt', 'baseRef', 'baseCommitSha', 'baseTreeSha', 'adapter', 'files', 'omissions', 'validation']
  exact(bundle, required)
  if (bundle.version !== 1 || !Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > 500 || !Array.isArray(bundle.omissions) || bundle.omissions.length > 500 || !Array.isArray(bundle.validation) || bundle.validation.length < 1 || bundle.validation.length > 32) throw new Error('Invalid repository documentation bundle.')
  const files = bundle.files.map(entry => {
    const file = object(entry, 'repository documentation file')
    exact(file, ['path', 'beforeSha256', 'after', 'diff'])
    const path = string(file.path, 'repository documentation path', 512)
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid repository documentation path.')
    const beforeSha256 = file.beforeSha256 === null ? null : string(file.beforeSha256, 'repository documentation source hash', 64)
    if (beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(beforeSha256)) throw new Error('Invalid repository documentation source hash.')
    const after = file.after === null ? null : string(file.after, 'repository documentation source', 5 * 1024 * 1024)
    return Object.freeze({ path, beforeSha256, after, diff: string(file.diff, 'repository documentation diff', 5 * 1024 * 1024) })
  })
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new Error('Invalid repository documentation bundle.')
  const omissions = bundle.omissions.map(entry => {
    const omission = object(entry, 'repository documentation omission')
    exact(omission, ['componentId', 'reason'])
    if (omission.reason !== 'example-adapter-required' && omission.reason !== 'usage-adapter-required') throw new Error('Invalid repository documentation omission.')
    return Object.freeze({ componentId: string(omission.componentId, 'component id', 128), reason: omission.reason })
  })
  const validation = bundle.validation.map(entry => {
    const check = object(entry, 'repository documentation validation')
    exact(check, ['name', 'detail'])
    return Object.freeze({ name: string(check.name, 'validation name', 100), detail: string(check.detail, 'validation detail', 2_000) })
  })
  return Object.freeze({ files: Object.freeze(files), omissions: Object.freeze(omissions), validation: Object.freeze(validation) })
}

async function responseJson(response: Response, requestId: string): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) throw new CloudApiError('The server returned an invalid response.', response.status, 'invalid_response', requestId)
  try { return await response.json() as unknown } catch (error) { throw new CloudApiError('The server returned invalid JSON.', response.status, 'invalid_response', requestId, { cause: error }) }
}

async function checked(response: Response, fallbackRequestId: string): Promise<unknown> {
  const headerRequestId = response.headers.get('X-Canvas-Request-Id')
  const requestId = headerRequestId && idPattern.test(headerRequestId) ? headerRequestId : fallbackRequestId
  const value = await responseJson(response, requestId)
  if (response.ok) return value
  const body = object(value, 'error response')
  const error = object(body.error, 'error response')
  const message = typeof error.message === 'string' && error.message.length <= 300 ? error.message : 'The request could not be completed.'
  const code = typeof error.code === 'string' && error.code.length <= 80 ? error.code : null
  throw new CloudApiError(message, response.status, code, requestId)
}

function jsonRequest(method: 'POST' | 'PUT' | 'PATCH', body: unknown): RequestInit {
  return { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function createCloudApiClient<TDocument>(options: CloudApiClientOptions<TDocument>) {
  const origin = parseOrigin(options.apiOrigin)
  const hostedPreviewOrigin = options.hostedPreviewOrigin === undefined ? null : parseOrigin(options.hostedPreviewOrigin)
  const request = options.fetch ?? fetch
  const call = async (path: string, init?: RequestInit) => {
    const requestId = crypto.randomUUID()
    const headers = new Headers(init?.headers)
    headers.set('X-Canvas-Request-Id', requestId)
    try {
      return await checked(await request(`${origin}${path}`, { credentials: 'include', ...init, headers }), requestId)
    } catch (error) {
      if (error instanceof CloudApiError) throw error
      throw new CloudApiError('The service could not be reached.', 0, 'network_error', requestId, { cause: error })
    }
  }

  return Object.freeze({
    async session(): Promise<CloudUser> {
      const body = object(await call('/api/session'), 'session response')
      exact(body, ['user'])
      const user = object(body.user, 'user')
      exact(user, ['id', 'name', 'email', 'image'])
      return { id: accountIdentifier(user.id), name: string(user.name, 'user name', 120), email: string(user.email, 'user email', 320), image: nullableString(user.image, 'user image', 2_048) }
    },
    async listFiles(): Promise<readonly CloudFileSummary[]> {
      const body = object(await call('/api/files'), 'files response')
      exact(body, ['files'])
      if (!Array.isArray(body.files) || body.files.length > 10_000) throw new Error('Invalid files response.')
      return body.files.map(parseSummary)
    },
    async createFile(input: Readonly<{ name?: string; projectId?: string | null }> = {}): Promise<CloudFileSummary> {
      if (input.name !== undefined && (input.name.trim().length === 0 || input.name.length > 120)) throw new Error('Invalid file name.')
      if (input.projectId !== undefined && input.projectId !== null) identifier(input.projectId, 'project id')
      const body = object(await call('/api/files', jsonRequest('POST', input)), 'file response')
      exact(body, ['file'])
      return parseSummary(body.file)
    },
    async openFile(fileId: string): Promise<CloudFileSummary> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}`), 'file response')
      exact(body, ['file'])
      return parseSummary(body.file)
    },
    async renameFile(fileId: string, name: string, expectedRevision: number): Promise<CloudFileSummary> {
      const id = identifier(fileId, 'file id')
      const resolvedName = string(name, 'file name', 120).trim()
      if (!resolvedName) throw new Error('Invalid file name.')
      integer(expectedRevision, 'expected revision')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}`, jsonRequest('PATCH', { expectedRevision, name: resolvedName })), 'file response')
      exact(body, ['file'])
      return parseSummary(body.file)
    },
    async openDocument(fileId: string): Promise<CloudDocument<TDocument>> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/document`), 'document response')
      exact(body, ['fileId', 'revision', 'document'])
      const responseFileId = identifier(body.fileId, 'file id')
      if (responseFileId !== id) throw new Error('The server returned a document for another file.')
      return { fileId: responseFileId, revision: integer(body.revision, 'document revision'), document: options.validateDocument(body.document) }
    },
    async saveDocument(fileId: string, document: TDocument, expectedRevision: number): Promise<CloudDocument<TDocument>> {
      const id = identifier(fileId, 'file id')
      integer(expectedRevision, 'expected revision')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/document`, jsonRequest('PUT', { expectedRevision, document })), 'document response')
      exact(body, ['fileId', 'revision', 'document'])
      const responseFileId = identifier(body.fileId, 'file id')
      if (responseFileId !== id) throw new Error('The server returned a document for another file.')
      return { fileId: responseFileId, revision: integer(body.revision, 'document revision'), document: options.validateDocument(body.document) }
    },
    async setThumbnail(fileId: string, expectedRevision: number, thumbnailKey: string): Promise<CloudThumbnailMetadata> {
      const id = identifier(fileId, 'file id')
      integer(expectedRevision, 'expected revision')
      if (thumbnailKey !== `thumbnails/${id}/thumbnail.avif`) throw new Error('Invalid thumbnail key.')
      return updateThumbnail(id, expectedRevision, thumbnailKey)
    },
    async clearThumbnail(fileId: string, expectedRevision: number): Promise<CloudThumbnailMetadata> {
      const id = identifier(fileId, 'file id')
      integer(expectedRevision, 'expected revision')
      return updateThumbnail(id, expectedRevision, null)
    },
    async getFileShare(fileId: string): Promise<CloudFileShare> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/share`), 'share response')
      exact(body, ['share'])
      return parseShare(body.share, id)
    },
    async setFileShare(fileId: string, access: 'private' | 'view'): Promise<CloudFileShare> {
      const id = identifier(fileId, 'file id')
      if (access !== 'private' && access !== 'view') throw new Error('Invalid share access.')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/share`, jsonRequest('PUT', { access })), 'share response')
      exact(body, ['share'])
      return parseShare(body.share, id)
    },
    async startGitHubInstallation(returnTo: string): Promise<Readonly<{ installationUrl: string; expiresAt: string }>> {
      let target: URL
      try { target = new URL(returnTo) } catch { throw new Error('Invalid return location.') }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid return location.')
      const body = object(await call('/api/github/installations/start', jsonRequest('POST', { returnTo: target.toString() })), 'GitHub installation response')
      exact(body, ['installationUrl', 'expiresAt'])
      const installationUrl = new URL(string(body.installationUrl, 'GitHub installation URL', 2_048))
      if (installationUrl.protocol !== 'https:' || installationUrl.hostname !== 'github.com') throw new Error('Invalid GitHub installation URL.')
      return { installationUrl: installationUrl.toString(), expiresAt: instant(body.expiresAt, 'GitHub installation expiry') }
    },
    async listGitHubRepositories(projectId: string, installationId: string): Promise<readonly CloudRepository[]> {
      const project = identifier(projectId, 'project id')
      const installation = githubIdentifier(installationId, 'installation id')
      const body = object(await call(`/api/projects/${encodeURIComponent(project)}/repositories?installationId=${encodeURIComponent(installation)}`), 'repositories response')
      exact(body, ['installationId', 'repositories'])
      if (githubIdentifier(body.installationId, 'installation id') !== installation || !Array.isArray(body.repositories) || body.repositories.length > 10_000) throw new Error('Invalid repositories response.')
      return body.repositories.map(parseRepository)
    },
    async getGitHubRepository(projectId: string): Promise<CloudRepositoryConnection> {
      const project = identifier(projectId, 'project id')
      const body = object(await call(`/api/projects/${encodeURIComponent(project)}/repository`), 'repository response')
      exact(body, ['repository', 'installationId'])
      return { installationId: githubIdentifier(body.installationId, 'installation id'), repository: parseRepository(body.repository) }
    },
    async linkGitHubRepository(projectId: string, installationId: string, repositoryId: string): Promise<CloudRepositoryConnection> {
      const project = identifier(projectId, 'project id')
      const installation = githubIdentifier(installationId, 'installation id')
      const repository = githubIdentifier(repositoryId, 'repository id')
      const body = object(await call(`/api/projects/${encodeURIComponent(project)}/repository`, jsonRequest('PUT', { installationId: installation, repositoryId: repository })), 'repository response')
      exact(body, ['repository', 'installationId'])
      if (githubIdentifier(body.installationId, 'installation id') !== installation) throw new Error('The server linked another installation.')
      const parsed = parseRepository(body.repository)
      if (parsed.id !== repository) throw new Error('The server linked another repository.')
      return { installationId: installation, repository: parsed }
    },
    async startGitHubRepositoryScan(projectId: string): Promise<CloudRepositoryScanJob> {
      const project = identifier(projectId, 'project id')
      const body = object(await call(`/api/projects/${encodeURIComponent(project)}/repository/jobs`, jsonRequest('POST', { operation: 'scan' })), 'repository scan response')
      exact(body, ['job'])
      return parseRepositoryScanJob(body.job)
    },
    async getGitHubRepositoryScan(jobId: string): Promise<CloudRepositoryScanJob> {
      const id = identifier(jobId, 'repository job id')
      const body = object(await call(`/api/repository-jobs/${encodeURIComponent(id)}`), 'repository scan response')
      exact(body, ['job'])
      return parseRepositoryScanJob(body.job)
    },
    async getLatestGitHubRepositoryScan(projectId: string): Promise<CloudRepositoryScanJob | null> {
      const project = identifier(projectId, 'project id')
      const body = object(await call(`/api/projects/${encodeURIComponent(project)}/repository/scan`), 'repository scan response')
      exact(body, ['job'])
      if (body.job === null) return null
      const job = parseRepositoryScanJob(body.job)
      if (job.status !== 'completed') throw new Error('The server returned an incomplete repository scan.')
      return job
    },
    async getGitHubSourceBindings(projectId: string): Promise<CloudSourceBindingSnapshot | null> {
      const project = identifier(projectId, 'project id')
      const value = await call(`/api/projects/${encodeURIComponent(project)}/repository/source-bindings`)
      return value === null ? null : parseCloudSourceBindingSnapshot(value, project)
    },
    async reconcileGitHubSourceBindings(projectId: string, input: CloudSourceBindingReconcileInput): Promise<CloudSourceBindingSnapshot> {
      const project = identifier(projectId, 'project id')
      const command = parseSourceBindingReconcileCommand(input)
      identifier(command.scanJobId, 'repository scan job id')
      const value = await call(`/api/projects/${encodeURIComponent(project)}/repository/source-bindings`, jsonRequest('PUT', command))
      return parseCloudSourceBindingSnapshot(value, project)
    },
    async startRepositoryDocsReview(input: Readonly<{ projectId: string; fileId: string; fileRevision: number; scanJobId: string }>): Promise<CloudRepositoryDocsReview> {
      const projectId = identifier(input.projectId, 'project id')
      const fileId = identifier(input.fileId, 'file id')
      const scanJobId = identifier(input.scanJobId, 'repository scan job id')
      integer(input.fileRevision, 'file revision')
      const body = object(await call(`/api/projects/${encodeURIComponent(projectId)}/repository/docs/reviews`, jsonRequest('POST', { fileId, fileRevision: input.fileRevision, scanJobId })), 'repository documentation review response')
      exact(body, ['review'])
      const review = parseRepositoryDocsReview(body.review)
      if (review.projectId !== projectId || review.fileId !== fileId || review.fileRevision !== input.fileRevision) throw new Error('The server returned another repository documentation review.')
      return review
    },
    async getLatestRepositoryDocsReview(projectId: string, fileId: string): Promise<CloudRepositoryDocsReview | null> {
      const project = identifier(projectId, 'project id')
      const file = identifier(fileId, 'file id')
      const body = object(await call(`/api/projects/${encodeURIComponent(project)}/repository/docs/reviews?fileId=${encodeURIComponent(file)}`), 'repository documentation review response')
      exact(body, ['review'])
      if (body.review === null) return null
      const review = parseRepositoryDocsReview(body.review)
      if (review.projectId !== project || review.fileId !== file) throw new Error('The server returned another repository documentation review.')
      return review
    },
    async getRepositoryDocsReview(reviewId: string): Promise<CloudRepositoryDocsReview> {
      const id = identifier(reviewId, 'repository documentation review id')
      const body = object(await call(`/api/repository-doc-reviews/${encodeURIComponent(id)}`), 'repository documentation review response')
      exact(body, ['review'])
      const review = parseRepositoryDocsReview(body.review)
      if (review.id !== id) throw new Error('The server returned another repository documentation review.')
      return review
    },
    async saveRepositoryDocsReview(reviewId: string, approvalDigest: string): Promise<CloudRepositoryDocsReview> {
      const id = identifier(reviewId, 'repository documentation review id')
      if (!/^[a-f0-9]{64}$/.test(approvalDigest)) throw new Error('Invalid repository documentation approval digest.')
      const body = object(await call(`/api/repository-doc-reviews/${encodeURIComponent(id)}/save`, jsonRequest('POST', { approvalDigest })), 'repository documentation review response')
      exact(body, ['review'])
      const review = parseRepositoryDocsReview(body.review)
      if (review.id !== id || review.approvalDigest !== approvalDigest) throw new Error('The server returned another repository documentation review.')
      return review
    },
    async getHostedPreview(fileId: string, artifactId: string): Promise<CloudHostedPreview> {
      if (!hostedPreviewOrigin) throw new Error('Hosted preview origin is not configured.')
      const file = identifier(fileId, 'file id')
      const artifact = identifier(artifactId, 'hosted preview artifact id')
      const body = object(await call(`/api/files/${encodeURIComponent(file)}/hosted-preview-capability`, jsonRequest('POST', { artifactId: artifact })), 'hosted preview response')
      exact(body, ['preview'])
      return parseHostedPreview(body.preview, artifact, hostedPreviewOrigin)
    },
    async startHostedPreviewBuild(fileId: string): Promise<CloudHostedPreviewBuildJob> {
      const file = identifier(fileId, 'file id')
      const body = object(await call(`/api/files/${encodeURIComponent(file)}/hosted-preview-builds`, jsonRequest('POST', {})), 'hosted preview build response')
      exact(body, ['job'])
      const job = parseHostedPreviewBuildJob(body.job)
      if (job.fileId !== file) throw new Error('The server returned another hosted preview build file.')
      return job
    },
    async getHostedPreviewBuild(jobId: string): Promise<CloudHostedPreviewBuildJob> {
      const id = identifier(jobId, 'hosted preview build id')
      const body = object(await call(`/api/hosted-preview-builds/${encodeURIComponent(id)}`), 'hosted preview build response')
      exact(body, ['job'])
      const job = parseHostedPreviewBuildJob(body.job)
      if (job.id !== id) throw new Error('The server returned another hosted preview build.')
      return job
    },
    async openSharedFile(fileId: string): Promise<CloudSharedFile<TDocument>> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/shared/files/${encodeURIComponent(id)}`), 'shared file response')
      exact(body, ['file', 'fileId', 'revision', 'document'])
      const file = object(body.file, 'shared file')
      exact(file, ['id', 'name', 'headRevision', 'updatedAt'])
      const responseFileId = identifier(body.fileId, 'file id')
      const metadataId = identifier(file.id, 'file id')
      if (responseFileId !== id || metadataId !== id) throw new Error('The server returned another shared file.')
      const revision = integer(body.revision, 'document revision')
      const headRevision = integer(file.headRevision, 'file revision')
      if (revision !== headRevision) throw new Error('The server returned mismatched shared revisions.')
      return {
        file: { id: metadataId, name: string(file.name, 'file name', 120), headRevision, updatedAt: instant(file.updatedAt, 'updated time') },
        fileId: responseFileId,
        revision,
        document: options.validateDocument(body.document),
      }
    },
  })

  async function updateThumbnail(fileId: string, expectedRevision: number, thumbnailKey: string | null): Promise<CloudThumbnailMetadata> {
    const body = object(await call(`/api/files/${encodeURIComponent(fileId)}/thumbnail`, jsonRequest('PUT', { expectedRevision, thumbnailKey })), 'thumbnail response')
    exact(body, ['thumbnail'])
    return parseThumbnail(body.thumbnail, fileId, expectedRevision)
  }
}
