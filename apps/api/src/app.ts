import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { HostedAuth, HostedSessionUser } from '@canvas/auth/server'
import type { ControlPlaneStore, JsonValue } from '@canvas/database'
import { GitHubAppError } from '@canvas/github-app'
import { validateHostedFileDocument } from '@canvas/cloud-document'
import type { GitHubApiServices } from './github.js'
import { LegacyDocumentPreparationError, type LegacyDocumentExternalizer } from './legacy-assets.js'
import {
  collaborationAdmissionProtocolEpoch,
  collaborationAdmissionResponse,
  collaborationAdmissionWebSocketProtocol,
  type CollaborationAdmissionAuthority,
} from './collaboration-admission.js'

export type ApiAppOptions = Readonly<{
  auth: HostedAuth
  store: ControlPlaneStore
  serviceToken: string
  collaborationAdmissionServiceToken?: string
  collaborationBuildId?: string
  collaborationAllowedOrigins?: readonly string[]
  registryFingerprint: string
  thumbnailServiceToken?: string
  allowedOrigins?: readonly string[]
  github?: GitHubApiServices
  collaborationAuthority?: CollaborationAdmissionAuthority
  legacyDocumentExternalizer?: LegacyDocumentExternalizer
  reportError?: (report: ApiErrorReport) => void
}>

export type ApiErrorReport = Readonly<{
  requestId: string
  method: string
  pathname: string
  error: unknown
}>

export type ApiApp = (request: Request) => Promise<Response>

const jsonHeaders = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fileAccessValues = new Set(['read', 'write', 'sync'])
const requestIdPattern = /^[A-Za-z0-9:._-]{1,128}$/
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function requestId(request: Request): string {
  const supplied = request.headers.get('X-Canvas-Request-Id')
  return supplied && requestIdPattern.test(supplied) ? supplied : randomUUID()
}

function defaultErrorReporter(report: ApiErrorReport): void {
  const error = report.error instanceof Error
    ? {
        name: report.error.name,
        message: report.error.message,
        stack: report.error.stack,
        ...(report.error instanceof LegacyDocumentPreparationError ? {
          phase: report.error.phase,
          failure: report.error.failure,
          upstreamStatus: report.error.upstreamStatus,
          upstreamCode: report.error.upstreamCode,
        } : {}),
      }
    : { name: 'UnknownError', message: String(report.error) }
  console.error(JSON.stringify({ level: 'error', event: 'api_request_failed', requestId: report.requestId, method: report.method, pathname: report.pathname, error }))
}

export function createApiApp(options: ApiAppOptions): ApiApp {
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) throw new Error('API_SERVICE_TOKEN must contain at least 32 bytes.')
  if (options.collaborationAdmissionServiceToken !== undefined
    && new TextEncoder().encode(options.collaborationAdmissionServiceToken).byteLength < 32) {
    throw new Error('COLLABORATION_ADMISSION_SERVICE_TOKEN must contain at least 32 bytes.')
  }
  if (options.collaborationAdmissionServiceToken !== undefined
    && options.collaborationAdmissionServiceToken === options.serviceToken) {
    throw new Error('COLLABORATION_ADMISSION_SERVICE_TOKEN must differ from API_SERVICE_TOKEN.')
  }
  if (options.collaborationBuildId !== undefined && !identifierPattern.test(options.collaborationBuildId)) {
    throw new Error('COLLABORATION_BUILD_ID is invalid.')
  }
  const collaborationOrigins = new Set(options.collaborationAllowedOrigins ?? [])
  for (const origin of collaborationOrigins) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { throw new Error('Collaboration allowed origin is invalid.') }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== origin) {
      throw new Error('Collaboration allowed origin must be an exact HTTP origin.')
    }
  }
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(options.registryFingerprint)) throw new Error('CANVAS_VERIFIED_REGISTRY_FINGERPRINT is invalid.')
  if (options.thumbnailServiceToken !== undefined && new TextEncoder().encode(options.thumbnailServiceToken).byteLength < 32) throw new Error('THUMBNAIL_SERVICE_TOKEN must contain at least 32 bytes.')
  const origins = new Set(options.allowedOrigins ?? [])
  const reportError = options.reportError ?? defaultErrorReporter
  return async request => {
    const reference = requestId(request)
    const origin = request.headers.get('Origin')
    if (origin && !origins.has(origin)) return apiResponse(request, origins, errorBody('origin_forbidden', 'Origin is not allowed.'), reference, 403)
    if (request.method === 'OPTIONS') return preflight(request, origins, reference)
    let response: Response
    try {
      const url = new URL(request.url)
      response = url.pathname === '/healthz' && request.method === 'GET'
        ? json({ ok: true })
        : url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')
          ? await options.auth.handler(request)
          : await routeApi(request, url, options, reference, collaborationOrigins)
    } catch (error) {
      if (error instanceof ApiInputError) response = json(errorBody(error.code, error.message), error.status)
      else if (error instanceof LegacyDocumentPreparationError) {
        reportError({ requestId: reference, method: request.method, pathname: new URL(request.url).pathname, error })
        response = error.failure === 'invalid-document'
          ? json({ error: { code: 'unsupported_document', message: 'Update required.', requestId: reference } }, 426)
          : json({ error: { code: 'collaboration_unavailable', message: 'Collaboration is unavailable.', requestId: reference } }, 503)
      }
      else if (error instanceof GitHubAppError) response = githubError(error)
      else {
        reportError({ requestId: reference, method: request.method, pathname: new URL(request.url).pathname, error })
        response = json({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId: reference } }, 500)
      }
    }
    return apiResponse(request, origins, response, reference)
  }
}

async function routeApi(request: Request, url: URL, options: ApiAppOptions, reference: string, collaborationOrigins: ReadonlySet<string>): Promise<Response> {
  if (url.pathname === '/internal/collaboration/admission' && request.method === 'POST') return internalCollaborationAdmission(request, options, reference, collaborationOrigins)
  if (url.pathname === '/internal/file-access' && request.method === 'POST') return internalFileAccess(request, options)
  if (url.pathname === '/internal/thumbnail-source' && request.method === 'POST') return internalThumbnailSource(request, options)
  if (url.pathname === '/internal/thumbnail-access' && request.method === 'POST') return internalThumbnailAccess(request, options)
  if (url.pathname === '/internal/thumbnail-metadata' && request.method === 'POST') return internalThumbnailMetadata(request, options)
  if (url.pathname === '/internal/thumbnail-upload-access' && request.method === 'POST') return internalThumbnailUploadAccess(request, options)
  if (url.pathname === '/internal/thumbnail-commit' && request.method === 'POST') return internalThumbnailCommit(request, options)
  if (url.pathname === '/internal/thumbnail-jobs/claim' && request.method === 'POST') return claimThumbnailJob(request, options)
  const thumbnailJobComplete = routeId(url.pathname, '/internal/thumbnail-jobs/', '/complete')
  if (thumbnailJobComplete && request.method === 'POST') return finishThumbnailJob(request, options, thumbnailJobComplete, 'complete')
  const thumbnailJobRelease = routeId(url.pathname, '/internal/thumbnail-jobs/', '/release')
  if (thumbnailJobRelease && request.method === 'POST') return finishThumbnailJob(request, options, thumbnailJobRelease, 'release')
  const internalJobStart = routeId(url.pathname, '/internal/repository-jobs/', '/start')
  if (internalJobStart && request.method === 'POST') return internalRepositoryJob(request, options, internalJobStart, 'start')
  const internalJobWrite = routeId(url.pathname, '/internal/repository-jobs/', '/authorize-write')
  if (internalJobWrite && request.method === 'POST') return internalRepositoryJob(request, options, internalJobWrite, 'write')
  if (url.pathname === '/api/github/webhooks' && request.method === 'POST') return githubWebhook(request, options.github)
  const sharedFileId = routeId(url.pathname, '/api/shared/files/')
  if (sharedFileId && request.method === 'GET') {
    const shared = await options.store.getSharedFile(sharedFileId)
    return shared ? json({ file: shared.file, fileId: shared.document.fileId, revision: shared.document.revision, document: hostedDocumentForResponse(shared.document.document) }) : json(errorBody('not_found', 'Shared file not found.'), 404)
  }
  const user = await options.auth.getSession(request)
  if (!user) return json(errorBody('unauthorized', 'Sign in required.'), 401)
  if (url.pathname === '/api/session' && request.method === 'GET') return json({ user })
  if (url.pathname === '/api/github/installations/start' && request.method === 'POST') return startGitHubInstallation(options.github, user)
  if (url.pathname === '/api/github/installations/callback' && request.method === 'GET') return completeGitHubInstallation(url, options.github, user)
  if (url.pathname === '/api/github/authorization/callback' && request.method === 'GET') return completeGitHubAuthorization(url, options.github, user)
  if (url.pathname === '/api/projects') {
    if (request.method === 'GET') return json({ projects: await options.store.listProjects(user.id) })
    if (request.method === 'POST') {
      const input = await readObject(request, 16_384)
      const project = await options.store.createProject(user.id, readName(input.name))
      return json({ project }, 201)
    }
  }
  const projectId = routeId(url.pathname, '/api/projects/')
  if (projectId && request.method === 'GET') {
    const project = await options.store.getProject(user.id, projectId)
    return project ? json({ project }) : json(errorBody('not_found', 'Project not found.'), 404)
  }
  const repositoryProjectId = routeId(url.pathname, '/api/projects/', '/repository')
  if (repositoryProjectId && (request.method === 'GET' || request.method === 'PUT')) {
    return projectRepository(request, options.github, user, repositoryProjectId)
  }
  const repositoryJobProjectId = routeId(url.pathname, '/api/projects/', '/repository/jobs')
  if (repositoryJobProjectId && request.method === 'POST') return enqueueRepositoryJob(request, options.github, user, repositoryJobProjectId)
  if (url.pathname === '/api/files') {
    if (request.method === 'GET') return json({ files: await options.store.listFiles(user.id) })
    if (request.method === 'POST') {
      const input = await readObject(request, 16_384)
      const projectId = readNullableId(input.projectId, 'projectId')
      try {
        const file = await options.store.createFile(user.id, readName(input.name), projectId)
        return json({ file }, 201)
      } catch (error) {
        if (error instanceof Error && error.message === 'Project was not found.') return json(errorBody('not_found', 'Project not found.'), 404)
        throw error
      }
    }
  }
  const documentId = routeId(url.pathname, '/api/files/', '/document')
  if (documentId) {
    if (request.method === 'GET') {
      const document = await options.store.getFileDocument(user.id, documentId)
      return document ? json({ fileId: document.fileId, document: hostedDocumentForResponse(document.document), revision: document.revision }) : json(errorBody('not_found', 'File not found.'), 404)
    }
    if (request.method === 'PUT') return saveDocument(request, options.store, user, documentId)
  }
  const thumbnailId = routeId(url.pathname, '/api/files/', '/thumbnail')
  if (thumbnailId && request.method === 'PUT') return setThumbnail(request, options.store, user, thumbnailId)
  const shareId = routeId(url.pathname, '/api/files/', '/share')
  if (shareId) {
    if (request.method === 'GET') {
      const share = await options.store.getFileShare(user.id, shareId)
      return share ? json({ share }) : json(errorBody('not_found', 'File not found.'), 404)
    }
    if (request.method === 'PUT') {
      const input = await readObject(request, 16_384)
      if (Object.keys(input).join(',') !== 'access' || (input.access !== 'private' && input.access !== 'view')) throw new ApiInputError('invalid_share_access', 'Share access is invalid.')
      const share = await options.store.setFileShare(user.id, shareId, input.access)
      return share ? json({ share }) : json(errorBody('not_found', 'File not found.'), 404)
    }
  }
  const fileId = routeId(url.pathname, '/api/files/')
  if (fileId && request.method === 'GET') {
    const file = await options.store.getFile(user.id, fileId)
    return file ? json({ file }) : json(errorBody('not_found', 'File not found.'), 404)
  }
  return json(errorBody('not_found', 'Route not found.'), 404)
}

async function startGitHubInstallation(github: GitHubApiServices | undefined, user: HostedSessionUser): Promise<Response> {
  if (!github) return json(errorBody('not_found', 'Route not found.'), 404)
  const issued = await github.states.issue({ accountId: user.id, tenantId: user.id, purpose: 'install-app' })
  return json({ installationUrl: github.installationUrl(issued.state), expiresAt: new Date(issued.expiresAt).toISOString() }, 201)
}

async function completeGitHubInstallation(url: URL, github: GitHubApiServices | undefined, user: HostedSessionUser): Promise<Response> {
  if (!github) return json(errorBody('not_found', 'Route not found.'), 404)
  const state = singleQuery(url, 'state')
  const installationId = singleQuery(url, 'installation_id')
  const setupActions = url.searchParams.getAll('setup_action')
  const setupAction = setupActions[0]
  if (setupActions.length > 1 || (setupAction !== undefined && setupAction !== 'install' && setupAction !== 'update') || [...url.searchParams.keys()].some(key => !['state', 'installation_id', 'setup_action'].includes(key))) {
    throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  }
  const consumed = await github.states.consume(state, user.id, 'install-app')
  const authorization = await github.issueAuthorization({ accountId: user.id, tenantId: consumed.tenantId, installationId })
  return json({ authorizationUrl: authorization.authorizationUrl, expiresAt: new Date(authorization.expiresAt).toISOString() })
}

async function completeGitHubAuthorization(url: URL, github: GitHubApiServices | undefined, user: HostedSessionUser): Promise<Response> {
  if (!github) return json(errorBody('not_found', 'Route not found.'), 404)
  if ([...url.searchParams.keys()].some(key => !['state', 'code'].includes(key))) throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  const state = singleQuery(url, 'state')
  const code = singleQuery(url, 'code')
  const consumed = await github.states.consume(state, user.id, 'authorize-user')
  if (!consumed.installationId || !consumed.codeVerifierCiphertext) throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  const actor = await github.authorizeUser({ accountId: user.id, code, codeVerifierCiphertext: consumed.codeVerifierCiphertext })
  const grant = await github.grants.connectInstallation({ actor, tenantId: consumed.tenantId, installationId: consumed.installationId })
  return json({ installation: publicInstallation(grant.installation) })
}

async function projectRepository(request: Request, github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return json(errorBody('not_found', 'Route not found.'), 404)
  const tenantId = await github.resolveProjectTenant(projectId, user.id)
  if (!tenantId) return json(errorBody('not_found', 'Repository not found.'), 404)
  const actor = await github.resolveActor(user)
  if (!actor) return json(errorBody('not_found', 'Repository not found.'), 404)
  if (request.method === 'GET') {
    const grant = await github.grants.assertLiveRepositoryAccess({ actor, tenantId, projectId, operation: 'scan' })
    return json({ repository: publicRepository(grant.repository), installationId: grant.installationId })
  }
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'installationId,repositoryId') throw new ApiInputError('invalid_repository', 'Repository selection is invalid.')
  if (typeof input.installationId !== 'string' || typeof input.repositoryId !== 'string') throw new ApiInputError('invalid_repository', 'Repository selection is invalid.')
  const grant = await github.grants.linkRepository({
    actor,
    tenantId,
    projectId,
    installationId: input.installationId,
    repositoryId: input.repositoryId,
  })
  return json({ repository: publicRepository(grant.repository), installationId: grant.installationId })
}

async function enqueueRepositoryJob(request: Request, github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return json(errorBody('not_found', 'Route not found.'), 404)
  const tenantId = await github.resolveProjectTenant(projectId, user.id)
  const actor = await github.resolveActor(user)
  if (!tenantId || !actor) return json(errorBody('not_found', 'Repository not found.'), 404)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'operation' || (input.operation !== 'scan' && input.operation !== 'pull' && input.operation !== 'prepare-patch' && input.operation !== 'write')) throw new ApiInputError('invalid_repository_job', 'Repository operation is invalid.')
  const job = await github.jobs.enqueue({ actor, tenantId, projectId, operation: input.operation })
  return json({ job: { id: job.id, operation: job.operation, status: job.status } }, 202)
}

async function internalRepositoryJob(request: Request, options: ApiAppOptions, jobId: string, phase: 'start' | 'write'): Promise<Response> {
  if (!equalToken(request.headers.get('X-Canvas-Service-Token') ?? '', options.serviceToken)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const result = phase === 'start' ? await options.github.jobs.start(jobId) : await options.github.jobs.authorizeWrite(jobId)
  return json({ job: { id: result.job.id, operation: result.job.operation, status: result.job.status }, repository: { installationId: result.job.installationId, repositoryId: result.job.repositoryId }, access: result.access })
}

async function githubWebhook(request: Request, github: GitHubApiServices | undefined): Promise<Response> {
  if (!github) return json(errorBody('not_found', 'Route not found.'), 404)
  const deliveryId = request.headers.get('X-GitHub-Delivery') ?? ''
  const eventName = request.headers.get('X-GitHub-Event') ?? ''
  const signature = request.headers.get('X-Hub-Signature-256') ?? ''
  const body = await readRaw(request, 1024 * 1024)
  const result = await github.webhooks.handle({ deliveryId, eventName, signature, body })
  return json({ status: result.status }, 202)
}

function singleQuery(url: URL, name: string): string {
  const values = url.searchParams.getAll(name)
  if (values.length !== 1 || !values[0]) throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  return values[0]
}

function publicInstallation(installation: { id: string; account: { id: string; login: string; type: 'Organization' | 'User' } }) {
  return Object.freeze({ id: installation.id, account: Object.freeze({ ...installation.account }) })
}

function publicRepository(repository: { id: string; ownerLogin: string; name: string; fullName: string; isPrivate: boolean }) {
  return Object.freeze({ id: repository.id, ownerLogin: repository.ownerLogin, name: repository.name, fullName: repository.fullName, isPrivate: repository.isPrivate })
}

function githubError(error: GitHubAppError): Response {
  if (error.code === 'DUPLICATE_DELIVERY') return json(errorBody('duplicate_delivery', 'GitHub webhook was already received.'), 409)
  if (error.code === 'INVALID_WEBHOOK_SIGNATURE') return json(errorBody('invalid_webhook_signature', 'GitHub webhook could not be verified.'), 401)
  if (error.code === 'INVALID_WEBHOOK') return json(errorBody('invalid_webhook', 'GitHub webhook is invalid.'), 400)
  if (error.code === 'INVALID_STATE' || error.code === 'EXPIRED_STATE' || error.code === 'INVALID_IDENTITY') return json(errorBody('invalid_github_callback', 'GitHub connection could not be verified.'), 400)
  return json(errorBody('not_found', 'Repository not found.'), 404)
}

async function saveDocument(request: Request, store: ControlPlaneStore, user: HostedSessionUser, fileId: string): Promise<Response> {
  const input = await readObject(request, 5 * 1024 * 1024)
  const expectedRevision = readExpectedRevision(input.expectedRevision)
  const document = readDocument(input.document, fileId, expectedRevision)
  const savedDocument = Object.freeze({ ...document, revision: expectedRevision + 1 })
  const result = await store.saveFileDocument(user.id, fileId, expectedRevision, savedDocument)
  if (result.status === 'not-found') return json(errorBody('not_found', 'File not found.'), 404)
  if (result.status === 'conflict') return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: result.currentRevision } }, 409)
  if (result.status === 'collaboration-authoritative') return json(errorBody('collaboration_authoritative', 'File is live.'), 409)
  return json({ fileId: result.document.fileId, document: result.document.document, revision: result.document.revision })
}

async function setThumbnail(request: Request, store: ControlPlaneStore, user: HostedSessionUser, fileId: string): Promise<Response> {
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'expectedRevision,thumbnailEtag,thumbnailKey') throw new ApiInputError('invalid_thumbnail', 'Thumbnail metadata is invalid.')
  const expectedRevision = readExpectedRevision(input.expectedRevision)
  const thumbnailKey = readThumbnailKey(input.thumbnailKey, fileId, expectedRevision)
  const thumbnailEtag = readThumbnailEtag(input.thumbnailEtag)
  const result = await store.setFileThumbnail(user.id, fileId, expectedRevision, thumbnailKey, thumbnailEtag)
  if (result.status === 'not-found') return json(errorBody('not_found', 'File not found.'), 404)
  if (result.status === 'conflict') return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: result.currentRevision } }, 409)
  return json({ thumbnail: result.thumbnail })
}

async function internalFileAccess(request: Request, options: ApiAppOptions): Promise<Response> {
  const presented = request.headers.get('X-Canvas-Service-Token') ?? ''
  if (!equalToken(presented, options.serviceToken)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 16_384)
  const keys = Object.keys(input).sort().join(',')
  if (!['access,fileId', 'access,expectedRevision,fileId', 'access,fileId,resource', 'access,expectedRevision,fileId,resource'].includes(keys)) throw new ApiInputError('invalid_access_request', 'Access request is invalid.')
  const fileId = readId(input.fileId, 'fileId')
  if (typeof input.access !== 'string' || !fileAccessValues.has(input.access)) throw new ApiInputError('invalid_access', 'Access is invalid.')
  const resource = input.resource === undefined ? undefined : input.resource
  if (resource !== undefined && resource !== 'thumbnail') throw new ApiInputError('invalid_access_request', 'Access request is invalid.')
  const expectedRevision = input.expectedRevision === undefined ? undefined : readExpectedRevision(input.expectedRevision)
  if (expectedRevision !== undefined && input.access !== 'write') throw new ApiInputError('invalid_access_request', 'Access request is invalid.')
  const user = await options.auth.getSession(request)
  if (!user && input.access !== 'read') return json(errorBody('unauthorized', 'Sign in required.'), 401)
  if (resource === 'thumbnail') {
    if (!user) return json(errorBody('unauthorized', 'Sign in required.'), 401)
    if ((input.access === 'read') !== (expectedRevision === undefined)) throw new ApiInputError('invalid_access_request', 'Access request is invalid.')
    const thumbnail = await options.store.getFileThumbnail(user.id, fileId)
    if (!thumbnail) return json(errorBody('not_found', 'File not found.'), 404)
    if (expectedRevision !== undefined && thumbnail.revision !== expectedRevision) return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: thumbnail.revision } }, 409)
    return input.access === 'read'
      ? json({ userId: user.id, revision: thumbnail.revision, thumbnailKey: thumbnail.thumbnailKey, thumbnailEtag: thumbnail.thumbnailEtag })
      : json({ userId: user.id, revision: thumbnail.revision })
  }
  const file = user ? await options.store.getFile(user.id, fileId) : null
  if (!file) {
    if (input.access !== 'read' || expectedRevision !== undefined || resource !== undefined) return json(errorBody('not_found', 'File not found.'), 404)
    const shared = await options.store.getSharedFile(fileId)
    if (!shared) return json(errorBody('not_found', 'File not found.'), 404)
    return json({ userId: `public:${fileId}` })
  }
  if (expectedRevision !== undefined && file.headRevision !== expectedRevision) return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: file.headRevision } }, 409)
  if (!user) throw new Error('Private file access resolved without an authenticated user.')
  return json({ userId: user.id })
}

async function internalCollaborationAdmission(request: Request, options: ApiAppOptions, reference: string, collaborationOrigins: ReadonlySet<string>): Promise<Response> {
  const origin = request.headers.get('Origin')
  if (!origin || !collaborationOrigins.has(origin)) {
    return json(errorBody('origin_forbidden', 'Origin is not allowed.'), 403)
  }
  const admissionToken = options.collaborationAdmissionServiceToken
  const supportedBuildId = options.collaborationBuildId
  if (!admissionToken || !supportedBuildId || !options.collaborationAuthority || !options.legacyDocumentExternalizer) {
    return json(errorBody('collaboration_unavailable', 'Collaboration is unavailable.'), 503)
  }
  if (!equalToken(request.headers.get('X-Canvas-Collaboration-Token') ?? '', admissionToken)) {
    return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  }
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'buildId,clientId,fileId,protocolEpoch,webSocketProtocol') {
    throw new ApiInputError('invalid_admission_request', 'Admission request is invalid.')
  }
  const fileId = readId(input.fileId, 'fileId')
  const buildId = readIdentifier(input.buildId, 'buildId')
  const clientId = readIdentifier(input.clientId, 'clientId')
  if (input.protocolEpoch !== collaborationAdmissionProtocolEpoch
    || input.webSocketProtocol !== collaborationAdmissionWebSocketProtocol
    || buildId !== supportedBuildId) {
    return json({
      error: {
        code: 'unsupported_protocol',
        message: 'Update required.',
        compatibility: { status: 'incompatible', protocolEpoch: collaborationAdmissionProtocolEpoch, buildId: supportedBuildId },
      },
    }, 426)
  }

  const user = await options.auth.getSession(request)
  const subjectId = user?.id ?? `anonymous:${createHash('sha256').update(clientId).digest('hex')}`
  const access = await options.store.resolveFileAccess(subjectId, fileId)
  if (!access) return json(errorBody('not_found', 'File not found.'), 404)
  if (access.fileId !== fileId || access.subjectUserId !== subjectId) throw new Error('File access authority returned mismatched claims.')
  if (!user && access.role !== 'viewer') throw new Error('Anonymous file access returned a mutable role.')
  await options.legacyDocumentExternalizer.prepare(fileId, reference, {
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  })
  const generation = await options.collaborationAuthority.resolveGeneration({
    fileId,
    protocolEpoch: collaborationAdmissionProtocolEpoch,
  })
  return json(collaborationAdmissionResponse(access, generation, supportedBuildId, user ?? { name: 'Guest', image: null }))
}

async function internalThumbnailSource(request: Request, options: ApiAppOptions): Promise<Response> {
  const configured = options.thumbnailServiceToken
  if (!configured || !equalToken(request.headers.get('X-Canvas-Thumbnail-Service-Token') ?? '', configured)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'expectedRevision,fileId') throw new ApiInputError('invalid_thumbnail_source', 'Thumbnail source request is invalid.')
  const fileId = readId(input.fileId, 'fileId')
  const expectedRevision = readExpectedRevision(input.expectedRevision)
  const source = await options.store.getFileDocumentForCapture(fileId)
  if (!source) return json(errorBody('not_found', 'File not found.'), 404)
  if (source.revision !== expectedRevision) return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: source.revision } }, 409)
  let document
  try { document = validateHostedFileDocument(source.document) }
  catch { return json(errorBody('not_found', 'File not found.'), 404) }
  const pageId = document.pages[0]?.id
  if (!pageId) return json(errorBody('not_found', 'File not found.'), 404)
  return json({ fileId, revision: source.revision, pageId, registryFingerprint: options.registryFingerprint, document })
}

async function internalThumbnailAccess(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!thumbnailServiceAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'access,expectedRevision,fileId,resource' || input.access !== 'write' || input.resource !== 'thumbnail') throw new ApiInputError('invalid_access_request', 'Access request is invalid.')
  const fileId = readId(input.fileId, 'fileId')
  const expectedRevision = readExpectedRevision(input.expectedRevision)
  const thumbnail = await options.store.getFileThumbnailForCapture(fileId)
  if (!thumbnail) return json(errorBody('not_found', 'File not found.'), 404)
  if (thumbnail.revision !== expectedRevision) return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: thumbnail.revision } }, 409)
  return json({ userId: thumbnail.ownerUserId, revision: thumbnail.revision })
}

async function internalThumbnailMetadata(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!thumbnailServiceAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'expectedRevision,fileId,thumbnailEtag,thumbnailKey') throw new ApiInputError('invalid_thumbnail', 'Thumbnail metadata is invalid.')
  const fileId = readId(input.fileId, 'fileId')
  const expectedRevision = readExpectedRevision(input.expectedRevision)
  const thumbnailKey = readThumbnailKey(input.thumbnailKey, fileId, expectedRevision)
  const thumbnailEtag = readThumbnailEtag(input.thumbnailEtag)
  const result = await options.store.setFileThumbnailForCapture(fileId, expectedRevision, thumbnailKey, thumbnailEtag)
  if (result.status === 'not-found') return json(errorBody('not_found', 'File not found.'), 404)
  if (result.status === 'conflict') return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: result.currentRevision } }, 409)
  return json({ thumbnail: result.thumbnail })
}

async function internalThumbnailUploadAccess(request: Request, options: ApiAppOptions): Promise<Response> {
  const serviceAuthorized = equalToken(request.headers.get('X-Canvas-Service-Token') ?? '', options.serviceToken)
  if (!serviceAuthorized || !thumbnailServiceAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'expectedRevision,fileId') throw new ApiInputError('invalid_access_request', 'Access request is invalid.')
  const fileId = readId(input.fileId, 'fileId')
  const expectedRevision = readExpectedRevision(input.expectedRevision)
  const thumbnail = await options.store.getFileThumbnailForCapture(fileId)
  if (!thumbnail) return json(errorBody('not_found', 'File not found.'), 404)
  if (thumbnail.revision !== expectedRevision) return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: thumbnail.revision } }, 409)
  return json({ serviceId: 'thumbnail-renderer', revision: thumbnail.revision })
}

async function internalThumbnailCommit(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!equalToken(request.headers.get('X-Canvas-Service-Token') ?? '', options.serviceToken)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'fileId') throw new ApiInputError('invalid_thumbnail', 'Thumbnail request is invalid.')
  const thumbnail = await options.store.getFileThumbnailForCapture(readId(input.fileId, 'fileId'))
  if (!thumbnail) return json(errorBody('not_found', 'File not found.'), 404)
  return json({ revision: thumbnail.revision, thumbnailKey: thumbnail.thumbnailKey, thumbnailEtag: thumbnail.thumbnailEtag })
}

function thumbnailServiceAuthorized(request: Request, options: ApiAppOptions): boolean {
  return options.thumbnailServiceToken !== undefined && equalToken(request.headers.get('X-Canvas-Thumbnail-Service-Token') ?? '', options.thumbnailServiceToken)
}

async function claimThumbnailJob(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!thumbnailServiceAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).length !== 0) throw new ApiInputError('invalid_thumbnail_job', 'Thumbnail job request is invalid.')
  const now = new Date()
  const job = await options.store.claimThumbnailCaptureJob(now, new Date(now.getTime() + 5 * 60_000))
  return json({ job })
}

async function finishThumbnailJob(request: Request, options: ApiAppOptions, jobId: string, action: 'complete' | 'release'): Promise<Response> {
  if (!thumbnailServiceAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).join(',') !== 'leaseId') throw new ApiInputError('invalid_thumbnail_job', 'Thumbnail job request is invalid.')
  const leaseId = readId(input.leaseId, 'leaseId')
  const updated = action === 'complete'
    ? await options.store.completeThumbnailCaptureJob(jobId, leaseId, new Date())
    : await options.store.releaseThumbnailCaptureJob(jobId, leaseId)
  return updated ? json({ status: action === 'complete' ? 'completed' : 'released' }) : json(errorBody('not_found', 'Thumbnail job not found.'), 404)
}

function equalToken(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const size = Math.max(leftBytes.byteLength, rightBytes.byteLength, 1)
  const paddedLeft = new Uint8Array(size)
  const paddedRight = new Uint8Array(size)
  paddedLeft.set(leftBytes.subarray(0, size))
  paddedRight.set(rightBytes.subarray(0, size))
  return timingSafeEqual(paddedLeft, paddedRight) && leftBytes.byteLength === rightBytes.byteLength
}

function routeId(pathname: string, prefix: string, suffix = ''): string | null {
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) return null
  const value = pathname.slice(prefix.length, suffix ? -suffix.length : undefined)
  return uuidPattern.test(value) ? value : null
}

function readName(value: unknown): string {
  if (value === undefined) return 'Untitled'
  if (typeof value !== 'string') throw new ApiInputError('invalid_name', 'Name is invalid.')
  const name = value.trim()
  if (!name || name.length > 120) throw new ApiInputError('invalid_name', 'Name is invalid.')
  return name
}

function readId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new ApiInputError('invalid_id', `${field} is invalid.`)
  return value
}

function readIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) throw new ApiInputError('invalid_identifier', `${field} is invalid.`)
  return value
}

function readNullableId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return readId(value, field)
}

function readExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || value === Number.MAX_SAFE_INTEGER) throw new ApiInputError('invalid_revision', 'Expected revision is invalid.')
  return value as number
}

function readThumbnailKey(value: unknown, fileId: string, revision: number): string {
  if (typeof value !== 'string' || !new RegExp(`^thumbnails/${fileId}/versions/${revision}/[A-Za-z0-9_-]{8,128}\\.avif$`).test(value)) throw new ApiInputError('invalid_thumbnail_key', 'Thumbnail key is invalid.')
  return value
}

function readThumbnailEtag(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiInputError('invalid_thumbnail_etag', 'Thumbnail ETag is invalid.')
  return value
}

function readDocument(value: unknown, fileId: string, expectedRevision: number): Readonly<Record<string, JsonValue>> {
  let document
  try { document = validateHostedFileDocument(value) }
  catch { throw new ApiInputError('invalid_document', 'Document shape is invalid.') }
  if (document.fileId !== fileId || document.revision !== expectedRevision) throw new ApiInputError('invalid_document', 'Document identity or revision is invalid.')
  return Object.freeze(document as unknown as Readonly<Record<string, JsonValue>>)
}

function hostedDocumentForResponse(value: unknown): Readonly<Record<string, JsonValue>> {
  return Object.freeze(validateHostedFileDocument(value) as unknown as Readonly<Record<string, JsonValue>>)
}

async function readObject(request: Request, limit: number): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ApiInputError('unsupported_media_type', 'Content-Type must be application/json.', 415)
  const declared = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > limit) throw new ApiInputError('payload_too_large', 'Request is too large.', 413)
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > limit) throw new ApiInputError('payload_too_large', 'Request is too large.', 413)
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new ApiInputError('invalid_json', 'Request body is invalid JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiInputError('invalid_json', 'Request body must be a JSON object.')
  return value as Record<string, unknown>
}

async function readRaw(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > limit) throw new ApiInputError('payload_too_large', 'Request is too large.', 413)
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > limit) throw new ApiInputError('payload_too_large', 'Request is too large.', 413)
  return bytes
}

function preflight(request: Request, origins: ReadonlySet<string>, requestId: string): Response {
  const origin = request.headers.get('Origin')
  if (!origin || !origins.has(origin)) return apiResponse(request, origins, errorBody('origin_forbidden', 'Origin is not allowed.'), requestId, 403)
  const response = new Response(null, { status: 204 })
  return apiResponse(request, origins, response, requestId)
}

function apiResponse(request: Request, origins: ReadonlySet<string>, response: Response | object, requestId: string, status?: number): Response {
  const source = response instanceof Response ? response : json(response, status)
  const headers = new Headers(source.headers)
  headers.set('X-Canvas-Request-Id', requestId)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  const origin = request.headers.get('Origin')
  if (origin && origins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Canvas-Request-Id, X-Canvas-Service-Token, X-Canvas-Thumbnail-Service-Token')
    headers.set('Access-Control-Expose-Headers', 'X-Canvas-Request-Id')
    headers.append('Vary', 'Origin')
  }
  return new Response(source.body, { status: source.status, statusText: source.statusText, headers })
}

function json(body: object, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: jsonHeaders }) }
function errorBody(code: string, message: string) { return { error: { code, message } } }

class ApiInputError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
