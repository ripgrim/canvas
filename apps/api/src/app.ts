import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { HostedAuth, HostedSessionUser } from '@canvas/auth/server'
import type { ControlPlaneStore, HostedPreviewBuildJob, JsonValue } from '@canvas/database'
import { GitHubAppError, HostedSourceBindingConflictError } from '@canvas/github-app'
import { parseSourceBindingReconcileCommand } from '@canvas/repository'
import { parseShadcnScanArtifact } from '@canvas/scanner'
import { issueHostedPreviewCapability } from '@canvas/preview-runtime/hosted-capability'
import { issueHostedPreviewWriteCapability } from '@canvas/preview-runtime/hosted-write-capability'
import { parseBlumeDocsAdapter } from '@canvas/repo-engine/component-docs-adapter'
import { hostedDocsReview } from '@canvas/repo-engine/hosted-source-review'
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
  repositoryJobServiceToken?: string
  hostedPreviewBuildServiceToken?: string
  hostedPreviewWriteSecret?: string
  assetsOrigin?: string
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
  deploymentRevision?: string
  hostedPreviewPublisherServiceToken?: string
  hostedPreviewCapabilitySecret?: string
  hostedPreviewOrigin?: string
  hostedPreviewNow?: () => number
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
  if (options.repositoryJobServiceToken !== undefined && new TextEncoder().encode(options.repositoryJobServiceToken).byteLength < 32) throw new Error('REPOSITORY_JOB_SERVICE_TOKEN must contain at least 32 bytes.')
  if (options.repositoryJobServiceToken !== undefined && equalToken(options.repositoryJobServiceToken, options.serviceToken)) throw new Error('REPOSITORY_JOB_SERVICE_TOKEN must differ from API_SERVICE_TOKEN.')
  if (options.hostedPreviewBuildServiceToken !== undefined && (new TextEncoder().encode(options.hostedPreviewBuildServiceToken).byteLength < 32 || /[\r\n]/.test(options.hostedPreviewBuildServiceToken))) throw new Error('HOSTED_PREVIEW_BUILD_SERVICE_TOKEN must contain at least 32 safe bytes.')
  if (options.hostedPreviewWriteSecret !== undefined && (new TextEncoder().encode(options.hostedPreviewWriteSecret).byteLength < 32 || /[\r\n]/.test(options.hostedPreviewWriteSecret))) throw new Error('HOSTED_PREVIEW_WRITE_SECRET must contain at least 32 safe bytes.')
  if ((options.hostedPreviewBuildServiceToken === undefined) !== (options.hostedPreviewWriteSecret === undefined) || (options.hostedPreviewBuildServiceToken === undefined) !== (options.assetsOrigin === undefined)) throw new Error('Hosted preview build transport configuration must be complete.')
  if (options.assetsOrigin !== undefined) exactHttpOrigin(options.assetsOrigin, 'ASSETS_ORIGIN')
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
  const hostedPreviewConfigured = [options.hostedPreviewPublisherServiceToken, options.hostedPreviewCapabilitySecret, options.hostedPreviewOrigin].filter(value => value !== undefined).length
  if (hostedPreviewConfigured !== 0 && hostedPreviewConfigured !== 3) throw new Error('Hosted preview API configuration must be complete.')
  if (options.hostedPreviewPublisherServiceToken !== undefined) {
    if (new TextEncoder().encode(options.hostedPreviewPublisherServiceToken).byteLength < 32 || /[\r\n]/.test(options.hostedPreviewPublisherServiceToken)) throw new Error('HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN must contain at least 32 safe bytes.')
  }
  if (options.hostedPreviewCapabilitySecret !== undefined && (new TextEncoder().encode(options.hostedPreviewCapabilitySecret).byteLength < 32 || /[\r\n]/.test(options.hostedPreviewCapabilitySecret))) throw new Error('HOSTED_PREVIEW_CAPABILITY_SECRET must contain at least 32 safe bytes.')
  const bearerTokens = [
    ['API_SERVICE_TOKEN', options.serviceToken],
    ['REPOSITORY_JOB_SERVICE_TOKEN', options.repositoryJobServiceToken],
    ['HOSTED_PREVIEW_BUILD_SERVICE_TOKEN', options.hostedPreviewBuildServiceToken],
    ['COLLABORATION_ADMISSION_SERVICE_TOKEN', options.collaborationAdmissionServiceToken],
    ['THUMBNAIL_SERVICE_TOKEN', options.thumbnailServiceToken],
  ] as const
  const configuredBearerTokens: Array<readonly [string, string]> = []
  for (const [name, token] of bearerTokens) if (token !== undefined) configuredBearerTokens.push([name, token])
  for (let left = 0; left < configuredBearerTokens.length; left += 1) {
    for (let right = left + 1; right < configuredBearerTokens.length; right += 1) {
      if (equalToken(configuredBearerTokens[left]![1], configuredBearerTokens[right]![1])) {
        throw new Error(`${configuredBearerTokens[left]![0]} must differ from ${configuredBearerTokens[right]![0]}.`)
      }
    }
  }
  if (options.hostedPreviewPublisherServiceToken !== undefined) {
    for (const [name, token] of bearerTokens) if (token !== undefined && equalToken(options.hostedPreviewPublisherServiceToken, token)) throw new Error(`HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN must differ from ${name}.`)
  }
  if (options.hostedPreviewCapabilitySecret !== undefined) {
    for (const [name, token] of [...bearerTokens, ['HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN', options.hostedPreviewPublisherServiceToken] as const]) {
      if (token !== undefined && equalToken(options.hostedPreviewCapabilitySecret, token)) throw new Error(`HOSTED_PREVIEW_CAPABILITY_SECRET must differ from ${name}.`)
    }
  }
  if (options.hostedPreviewWriteSecret !== undefined) {
    for (const [name, token] of [...bearerTokens, ['HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN', options.hostedPreviewPublisherServiceToken] as const, ['HOSTED_PREVIEW_CAPABILITY_SECRET', options.hostedPreviewCapabilitySecret] as const]) {
      if (token !== undefined && equalToken(options.hostedPreviewWriteSecret, token)) throw new Error(`HOSTED_PREVIEW_WRITE_SECRET must differ from ${name}.`)
    }
  }
  if (options.hostedPreviewOrigin !== undefined) exactHttpOrigin(options.hostedPreviewOrigin, 'HOSTED_PREVIEW_ORIGIN')
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
        : url.pathname === '/healthz/deployment' && request.method === 'GET'
          ? json({ revision: options.deploymentRevision ?? null })
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
      else if (error instanceof HostedSourceBindingConflictError) response = json(errorBody('source_bindings_changed', 'Repository source bindings changed.'), 409)
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
  if (url.pathname === '/internal/hosted-previews/register' && request.method === 'POST') return registerHostedPreviewArtifact(request, options)
  if (url.pathname === '/internal/repository-doc-reviews/claim-prepare' && request.method === 'POST') return claimRepositoryDocsPrepare(request, options)
  if (url.pathname === '/internal/repository-doc-reviews/claim-save' && request.method === 'POST') return claimRepositoryDocsSave(request, options)
  const internalDocsSourceId = routeId(url.pathname, '/internal/repository-doc-reviews/', '/source')
  if (internalDocsSourceId && request.method === 'POST') return repositoryDocsSource(request, options, internalDocsSourceId)
  const internalDocsCompleteId = routeId(url.pathname, '/internal/repository-doc-reviews/', '/complete-prepare')
  if (internalDocsCompleteId && request.method === 'POST') return completeRepositoryDocsPrepare(request, options, internalDocsCompleteId)
  const internalDocsProposedCommitId = routeId(url.pathname, '/internal/repository-doc-reviews/', '/proposed-commit')
  if (internalDocsProposedCommitId && request.method === 'POST') return setRepositoryDocsProposedCommit(request, options, internalDocsProposedCommitId)
  const internalDocsCompleteSaveId = routeId(url.pathname, '/internal/repository-doc-reviews/', '/complete-save')
  if (internalDocsCompleteSaveId && request.method === 'POST') return completeRepositoryDocsSave(request, options, internalDocsCompleteSaveId)
  const internalDocsStaleSaveId = routeId(url.pathname, '/internal/repository-doc-reviews/', '/stale-save')
  if (internalDocsStaleSaveId && request.method === 'POST') return staleRepositoryDocsSave(request, options, internalDocsStaleSaveId)
  const internalDocsFailSaveId = routeId(url.pathname, '/internal/repository-doc-reviews/', '/fail-save')
  if (internalDocsFailSaveId && request.method === 'POST') return failRepositoryDocsSave(request, options, internalDocsFailSaveId)
  const thumbnailJobComplete = routeId(url.pathname, '/internal/thumbnail-jobs/', '/complete')
  if (thumbnailJobComplete && request.method === 'POST') return finishThumbnailJob(request, options, thumbnailJobComplete, 'complete')
  const thumbnailJobRelease = routeId(url.pathname, '/internal/thumbnail-jobs/', '/release')
  if (thumbnailJobRelease && request.method === 'POST') return finishThumbnailJob(request, options, thumbnailJobRelease, 'release')
  const internalJobStart = routeId(url.pathname, '/internal/repository-jobs/', '/start')
  if (internalJobStart && request.method === 'POST') return internalRepositoryJob(request, options, internalJobStart)
  if (url.pathname === '/internal/repository-jobs/claim' && request.method === 'POST') return claimInternalRepositoryJob(request, options)
  if (url.pathname === '/internal/hosted-preview-builds/claim' && request.method === 'POST') return claimHostedPreviewBuild(request, options)
  const internalJobComplete = routeId(url.pathname, '/internal/repository-jobs/', '/complete')
  if (internalJobComplete && request.method === 'POST') return completeInternalRepositoryJob(request, options, internalJobComplete)
  const internalJobRetry = routeId(url.pathname, '/internal/repository-jobs/', '/retry')
  if (internalJobRetry && request.method === 'POST') return finishInternalRepositoryJob(request, options, internalJobRetry, 'retry')
  const internalJobFail = routeId(url.pathname, '/internal/repository-jobs/', '/fail')
  if (internalJobFail && request.method === 'POST') return finishInternalRepositoryJob(request, options, internalJobFail, 'fail')
  const internalPreviewBuildComplete = routeId(url.pathname, '/internal/hosted-preview-builds/', '/complete')
  if (internalPreviewBuildComplete && request.method === 'POST') return finishHostedPreviewBuild(request, options, internalPreviewBuildComplete, 'complete')
  const internalPreviewBuildRetry = routeId(url.pathname, '/internal/hosted-preview-builds/', '/retry')
  if (internalPreviewBuildRetry && request.method === 'POST') return finishHostedPreviewBuild(request, options, internalPreviewBuildRetry, 'retry')
  const internalPreviewBuildFail = routeId(url.pathname, '/internal/hosted-preview-builds/', '/fail')
  if (internalPreviewBuildFail && request.method === 'POST') return finishHostedPreviewBuild(request, options, internalPreviewBuildFail, 'fail')
  if (url.pathname === '/api/github/webhooks' && request.method === 'POST') return githubWebhook(request, options.github)
  const sharedFileId = routeId(url.pathname, '/api/shared/files/')
  if (sharedFileId && request.method === 'GET') {
    const shared = await options.store.getSharedFile(sharedFileId)
    return shared ? json({ file: shared.file, fileId: shared.document.fileId, revision: shared.document.revision, document: hostedDocumentForResponse(shared.document.document) }) : json(errorBody('not_found', 'Shared file not found.'), 404)
  }
  const user = await options.auth.getSession(request)
  if (!user) return json(errorBody('unauthorized', 'Sign in required.'), 401)
  if (url.pathname === '/api/session' && request.method === 'GET') return json({ user })
  if (url.pathname === '/api/github/installations/start' && request.method === 'POST') return startGitHubInstallation(request, options.github, user, origins(options.allowedOrigins))
  if (url.pathname === '/api/github/installations/callback' && request.method === 'GET') return completeGitHubInstallation(url, options.github, user, origins(options.allowedOrigins))
  if (url.pathname === '/api/github/authorization/callback' && request.method === 'GET') return completeGitHubAuthorization(url, options.github, user, origins(options.allowedOrigins))
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
  const repositoryChoicesProjectId = routeId(url.pathname, '/api/projects/', '/repositories')
  if (repositoryChoicesProjectId && request.method === 'GET') return projectRepositories(url, options.github, user, repositoryChoicesProjectId)
  const repositoryScanProjectId = routeId(url.pathname, '/api/projects/', '/repository/scan')
  if (repositoryScanProjectId && request.method === 'GET') return readLatestRepositoryScan(options.github, user, repositoryScanProjectId)
  const repositorySourceBindingsProjectId = routeId(url.pathname, '/api/projects/', '/repository/source-bindings')
  if (repositorySourceBindingsProjectId && (request.method === 'GET' || request.method === 'PUT')) return repositorySourceBindings(request, options.github, user, repositorySourceBindingsProjectId)
  const repositoryJobProjectId = routeId(url.pathname, '/api/projects/', '/repository/jobs')
  if (repositoryJobProjectId && request.method === 'POST') return enqueueRepositoryJob(request, options.github, user, repositoryJobProjectId)
  const repositoryDocsProjectId = routeId(url.pathname, '/api/projects/', '/repository/docs/reviews')
  if (repositoryDocsProjectId && request.method === 'POST') return enqueueRepositoryDocsReview(request, options, user, repositoryDocsProjectId)
  if (repositoryDocsProjectId && request.method === 'GET') return readLatestRepositoryDocsReview(url, options.github, user, repositoryDocsProjectId)
  const repositoryJobId = routeId(url.pathname, '/api/repository-jobs/')
  if (repositoryJobId && request.method === 'GET') return readRepositoryJob(options.github, user, repositoryJobId)
  const repositoryDocsSaveId = routeId(url.pathname, '/api/repository-doc-reviews/', '/save')
  if (repositoryDocsSaveId && request.method === 'POST') return approveRepositoryDocsReview(request, options.github, user, repositoryDocsSaveId)
  const repositoryDocsReviewId = routeId(url.pathname, '/api/repository-doc-reviews/')
  if (repositoryDocsReviewId && request.method === 'GET') return readRepositoryDocsReview(options.github, user, repositoryDocsReviewId)
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
  const hostedPreviewFileId = routeId(url.pathname, '/api/files/', '/hosted-preview-capability')
  if (hostedPreviewFileId && request.method === 'POST') return hostedPreviewCapability(request, options, user, hostedPreviewFileId)
  const hostedPreviewBuildFileId = routeId(url.pathname, '/api/files/', '/hosted-preview-builds')
  if (hostedPreviewBuildFileId && request.method === 'POST') return enqueueHostedPreviewBuild(request, options, user, hostedPreviewBuildFileId)
  const hostedPreviewBuildId = routeId(url.pathname, '/api/hosted-preview-builds/')
  if (hostedPreviewBuildId && request.method === 'GET') return readHostedPreviewBuild(options.store, user, hostedPreviewBuildId)
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
  if (fileId) {
    if (request.method === 'GET') {
      const file = await options.store.getFile(user.id, fileId)
      return file ? json({ file }) : json(errorBody('not_found', 'File not found.'), 404)
    }
    if (request.method === 'PATCH') {
      const input = await readObject(request, 16_384)
      if (Object.keys(input).sort().join(',') !== 'expectedRevision,name') throw new ApiInputError('invalid_file_metadata', 'File metadata is invalid.')
      const result = await options.store.renameFile(user.id, fileId, readExpectedRevision(input.expectedRevision), readName(input.name))
      if (result.status === 'saved') return json({ file: result.file })
      if (result.status === 'conflict') return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: result.currentRevision } }, 409)
      return json(errorBody('not_found', 'File not found.'), 404)
    }
  }
  return json(errorBody('not_found', 'Route not found.'), 404)
}

async function startGitHubInstallation(request: Request, github: GitHubApiServices | undefined, user: HostedSessionUser, allowedOrigins: ReadonlySet<string>): Promise<Response> {
  if (!github) return githubUnavailable()
  const input = await readObject(request, 16_384)
  if (Object.keys(input).join(',') !== 'returnTo' || typeof input.returnTo !== 'string') throw new ApiInputError('invalid_return_url', 'Return location is invalid.')
  const returnToUrl = trustedReturnUrl(input.returnTo, allowedOrigins)
  const issued = await github.states.issue({ accountId: user.id, tenantId: user.id, purpose: 'install-app', returnToUrl })
  return json({ installationUrl: github.installationUrl(issued.state), expiresAt: new Date(issued.expiresAt).toISOString() }, 201)
}

async function completeGitHubInstallation(url: URL, github: GitHubApiServices | undefined, user: HostedSessionUser, allowedOrigins: ReadonlySet<string>): Promise<Response> {
  if (!github) return githubUnavailable()
  const state = singleQuery(url, 'state')
  const installationId = singleQuery(url, 'installation_id')
  const setupActions = url.searchParams.getAll('setup_action')
  const setupAction = setupActions[0]
  if (setupActions.length > 1 || (setupAction !== undefined && setupAction !== 'install' && setupAction !== 'update') || [...url.searchParams.keys()].some(key => !['state', 'installation_id', 'setup_action'].includes(key))) {
    throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  }
  const consumed = await github.states.consume(state, user.id, 'install-app')
  if (!consumed.returnToUrl) throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  const returnToUrl = trustedReturnUrl(consumed.returnToUrl, allowedOrigins)
  const authorization = await github.issueAuthorization({ accountId: user.id, tenantId: consumed.tenantId, installationId, returnToUrl })
  return redirect(authorization.authorizationUrl)
}

async function completeGitHubAuthorization(url: URL, github: GitHubApiServices | undefined, user: HostedSessionUser, allowedOrigins: ReadonlySet<string>): Promise<Response> {
  if (!github) return githubUnavailable()
  if ([...url.searchParams.keys()].some(key => !['state', 'code'].includes(key))) throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  const state = singleQuery(url, 'state')
  const code = singleQuery(url, 'code')
  const consumed = await github.states.consume(state, user.id, 'authorize-user')
  if (!consumed.installationId || !consumed.codeVerifierCiphertext || !consumed.returnToUrl) throw new ApiInputError('invalid_github_callback', 'GitHub connection could not be verified.')
  const actor = await github.authorizeUser({ accountId: user.id, code, codeVerifierCiphertext: consumed.codeVerifierCiphertext })
  const grant = await github.grants.connectInstallation({ actor, tenantId: consumed.tenantId, installationId: consumed.installationId })
  const returnTo = new URL(trustedReturnUrl(consumed.returnToUrl, allowedOrigins))
  returnTo.searchParams.set('github', 'connected')
  returnTo.searchParams.set('installationId', grant.installation.id)
  return redirect(returnTo.toString())
}

function trustedReturnUrl(value: string, allowedOrigins: ReadonlySet<string>): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ApiInputError('invalid_return_url', 'Return location is invalid.') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !allowedOrigins.has(url.origin)) {
    throw new ApiInputError('invalid_return_url', 'Return location is invalid.')
  }
  return url.toString()
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

function origins(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(values ?? [])
}

async function projectRepository(request: Request, github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return githubUnavailable()
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

async function repositorySourceBindings(request: Request, github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const tenantId = await github.resolveProjectTenant(projectId, user.id)
  if (!tenantId) return json(errorBody('not_found', 'Repository not found.'), 404)
  const actor = await github.resolveActor(user)
  if (!actor) return json(errorBody('not_found', 'Repository not found.'), 404)
  if (request.method === 'GET') {
    const snapshot = await github.sourceBindings.get({ actor, tenantId, projectId })
    return snapshot === null ? jsonNull() : json(snapshot)
  }
  const input = await readObject(request, 5 * 1024 * 1024)
  let command: ReturnType<typeof parseSourceBindingReconcileCommand>
  try {
    command = parseSourceBindingReconcileCommand(input)
    readId(command.scanJobId, 'scanJobId')
  } catch { throw new ApiInputError('invalid_source_bindings', 'Source binding request is invalid.') }
  return json(await github.sourceBindings.reconcile({ actor, tenantId, projectId, ...command }))
}

async function enqueueRepositoryJob(request: Request, github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const tenantId = await github.resolveProjectTenant(projectId, user.id)
  const actor = await github.resolveActor(user)
  if (!tenantId || !actor) return json(errorBody('not_found', 'Repository not found.'), 404)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'operation' || input.operation !== 'scan') throw new ApiInputError('invalid_repository_job', 'Repository operation is invalid.')
  const job = await github.jobs.enqueue({ actor, tenantId, projectId, operation: 'scan' })
  return json({ job: { id: job.id, operation: job.operation, status: job.status, attempt: job.attempt } }, 202)
}

async function enqueueRepositoryDocsReview(request: Request, options: ApiAppOptions, user: HostedSessionUser, projectId: string): Promise<Response> {
  const github = options.github
  if (!github) return githubUnavailable()
  const tenantId = await github.resolveProjectTenant(projectId, user.id)
  const actor = await github.resolveActor(user)
  if (!tenantId || !actor) return json(errorBody('not_found', 'Repository not found.'), 404)
  const input = await readObject(request, 128 * 1024)
  if (Object.keys(input).sort().join(',') !== 'fileId,fileRevision,scanJobId' || typeof input.fileId !== 'string' || typeof input.scanJobId !== 'string' || !Number.isSafeInteger(input.fileRevision)) throw new ApiInputError('invalid_repository_docs_review', 'Documentation review request is invalid.')
  const file = await options.store.getFile(user.id, input.fileId)
  const document = await options.store.getFileDocument(user.id, input.fileId)
  if (!file || !document || file.projectId !== projectId || document.revision !== input.fileRevision) return json(errorBody('not_found', 'File not found.'), 404)
  const scan = await github.jobs.read(input.scanJobId, actor)
  if (scan.status !== 'completed' || scan.operation !== 'scan' || scan.projectId !== projectId) return json(errorBody('not_found', 'Repository scan not found.'), 404)
  const grant = await github.grants.assertLiveRepositoryAccess({ actor, tenantId, projectId, operation: 'prepare-patch' })
  const base = await github.resolveRepositoryBase({ installationId: grant.installationId, repositoryId: grant.repository.id, expectedSourceRevision: scan.result.sourceRevision })
  const adapterSource = await github.readRepositoryTextFile({ installationId: grant.installationId, repositoryId: grant.repository.id, sourceRevision: base.baseCommitSha, path: '.canvas/blume.json', maximumBytes: 64 * 1024 })
  if (adapterSource === null) return json(errorBody('repository_docs_adapter_required', 'Add .canvas/blume.json to prepare component docs.'), 409)
  let adapter
  try { adapter = parseBlumeDocsAdapter(JSON.parse(adapterSource)) }
  catch { throw new ApiInputError('invalid_repository_docs_adapter', 'The repository documentation adapter is invalid.') }
  const review = await github.docs.enqueuePrepare({
    actor,
    tenantId,
    projectId,
    fileId: input.fileId,
    fileRevision: input.fileRevision as number,
    fileDocumentSha256: createHash('sha256').update(canonicalJson(document.document)).digest('hex'),
    scanJobId: scan.id,
    ...base,
    adapter,
  })
  return json({ review: publicRepositoryDocsReview(review) }, 202)
}

async function readRepositoryDocsReview(github: GitHubApiServices | undefined, user: HostedSessionUser, reviewId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const actor = await github.resolveActor(user)
  if (!actor) return json(errorBody('not_found', 'Documentation review not found.'), 404)
  return json({ review: publicRepositoryDocsReview(await github.docs.read(reviewId, actor)) })
}

async function readLatestRepositoryDocsReview(url: URL, github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const actor = await github.resolveActor(user)
  if (!actor) return json(errorBody('not_found', 'Repository documentation review not found.'), 404)
  const fileId = readId(url.searchParams.get('fileId'), 'fileId')
  const review = await github.docs.readLatest(projectId, fileId, actor)
  return json({ review: review ? publicRepositoryDocsReview(review) : null })
}

async function approveRepositoryDocsReview(request: Request, github: GitHubApiServices | undefined, user: HostedSessionUser, reviewId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const actor = await github.resolveActor(user)
  if (!actor) return json(errorBody('not_found', 'Documentation review not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).join(',') !== 'approvalDigest' || typeof input.approvalDigest !== 'string') throw new ApiInputError('invalid_repository_docs_review', 'Documentation review approval is invalid.')
  return json({ review: publicRepositoryDocsReview(await github.docs.approveSave(reviewId, actor, input.approvalDigest)) }, 202)
}

function publicRepositoryDocsReview(review: Awaited<ReturnType<GitHubApiServices['docs']['read']>>) {
  return Object.freeze({
    id: review.id,
    projectId: review.projectId,
    fileId: review.fileId,
    fileRevision: review.fileRevision,
    status: review.status,
    baseRef: review.baseRef,
    baseCommitSha: review.baseCommitSha,
    approvalDigest: review.approvalDigest,
    preparedBundle: review.preparedBundle,
    committedSha: review.committedSha,
    errorId: review.errorId,
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function readRepositoryJob(github: GitHubApiServices | undefined, user: HostedSessionUser, jobId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const actor = await github.resolveActor(user)
  if (!actor) return json(errorBody('not_found', 'Repository job not found.'), 404)
  const job = await github.jobs.read(jobId, actor)
  return json({ job: {
    id: job.id,
    operation: job.operation,
    status: job.status,
    attempt: job.attempt,
    ...(job.status === 'completed' ? { result: job.result, completedAt: new Date(job.completedAt).toISOString() } : {}),
    ...(job.status === 'failed' ? { errorId: job.errorId, failedAt: new Date(job.failedAt).toISOString() } : {}),
  } })
}

async function readLatestRepositoryScan(github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const tenantId = await github.resolveProjectTenant(projectId, user.id)
  const actor = await github.resolveActor(user)
  if (!tenantId || !actor) return json(errorBody('not_found', 'Repository scan not found.'), 404)
  const job = await github.jobs.latestScan({ actor, tenantId, projectId })
  return json({ job: job ? {
    id: job.id,
    operation: job.operation,
    status: job.status,
    attempt: job.attempt,
    result: job.status === 'completed' ? job.result : null,
    completedAt: job.status === 'completed' ? new Date(job.completedAt).toISOString() : null,
  } : null })
}

async function enqueueHostedPreviewBuild(request: Request, options: ApiAppOptions, user: HostedSessionUser, fileId: string): Promise<Response> {
  if (!options.github) return githubUnavailable()
  const input = await readObject(request, 1_024)
  if (Object.keys(input).length !== 0) throw new ApiInputError('invalid_hosted_preview_build', 'Hosted preview build request is invalid.')
  const file = await options.store.getFile(user.id, fileId)
  const document = await options.store.getFileDocument(user.id, fileId)
  if (!file?.projectId || !document) return json(errorBody('not_found', 'File not found.'), 404)
  const tenantId = await options.github.resolveProjectTenant(file.projectId, user.id)
  const actor = await options.github.resolveActor(user)
  if (!tenantId || !actor) return json(errorBody('not_found', 'Repository scan not found.'), 404)
  const scan = await options.github.jobs.latestScan({ actor, tenantId, projectId: file.projectId })
  if (!scan || scan.status !== 'completed') return json(errorBody('repository_scan_required', 'Scan the repository before building a preview.'), 409)
  const createdAt = new Date(options.hostedPreviewNow?.() ?? Date.now())
  const job = await options.store.createHostedPreviewBuildJob({
    id: randomUUID(),
    ownerUserId: user.id,
    fileId,
    fileRevision: document.revision,
    projectId: file.projectId,
    scanJobId: scan.id,
    artifactId: randomUUID(),
    stagingId: randomUUID(),
    createdAt,
  })
  return job ? json({ job: publicHostedPreviewBuild(job) }, job.status === 'queued' ? 202 : 200) : json(errorBody('not_found', 'File not found.'), 404)
}

async function readHostedPreviewBuild(store: ControlPlaneStore, user: HostedSessionUser, jobId: string): Promise<Response> {
  const job = await store.getHostedPreviewBuildJob(user.id, readId(jobId, 'jobId'))
  return job ? json({ job: publicHostedPreviewBuild(job) }) : json(errorBody('not_found', 'Hosted preview build not found.'), 404)
}

async function claimHostedPreviewBuild(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!hostedPreviewBuildAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).length !== 0) throw new ApiInputError('invalid_hosted_preview_build', 'Hosted preview build request is invalid.')
  const now = new Date(options.hostedPreviewNow?.() ?? Date.now())
  const job = await options.store.claimHostedPreviewBuildJob(now, new Date(now.getTime() + 5 * 60_000))
  if (!job || job.status !== 'leased' || !job.leaseId) return json({ job: null })
  try {
    const source = await options.github.jobs.authorizeCompletedScan(job.scanJobId)
    if (source.job.projectId !== job.projectId || source.job.result.sourceRevision.length !== 40) throw new Error('Hosted preview build source is invalid.')
    const authorizedAt = new Date(options.hostedPreviewNow?.() ?? Date.now())
    if (!await options.store.isCurrentHostedPreviewBuildLease(job.id, job.leaseId, authorizedAt)) return json({ job: null })
    const leaseExpiresAt = new Date(job.leaseExpiresAt!).getTime()
    const lifetimeSeconds = Math.min(300, Math.floor((leaseExpiresAt - authorizedAt.getTime()) / 1000))
    if (lifetimeSeconds < 1 || !options.hostedPreviewWriteSecret || !options.assetsOrigin) return json({ job: null })
    const writeToken = await issueHostedPreviewWriteCapability({
      jobId: job.id,
      leaseId: job.leaseId,
      artifactId: job.artifactId,
      stagingId: job.stagingId,
      audience: options.assetsOrigin,
      secret: options.hostedPreviewWriteSecret,
      now: Math.floor(authorizedAt.getTime() / 1000),
      lifetimeSeconds,
    })
    return json({
      job: internalHostedPreviewBuild(job),
      lease: { id: job.leaseId, expiresAt: job.leaseExpiresAt },
      repository: { repositoryId: source.job.repositoryId },
      access: source.access,
      scan: source.job.result,
      artifactAccess: { origin: options.assetsOrigin, token: writeToken, expiresAt: Math.floor(authorizedAt.getTime() / 1000) + lifetimeSeconds },
    })
  } catch (error) {
    const failedAt = new Date(options.hostedPreviewNow?.() ?? Date.now())
    if (error instanceof GitHubAppError) {
      await options.store.failHostedPreviewBuildJob(job.id, job.leaseId, 'repository-access-changed', failedAt)
    } else if (job.attempts < 3 && transientHostedPreviewSourceFailure(error)) {
      const delay = Math.min(30_000, 1_000 * 2 ** job.attempts)
      await options.store.retryHostedPreviewBuildJob(job.id, job.leaseId, failedAt, new Date(failedAt.getTime() + delay))
    } else {
      await options.store.failHostedPreviewBuildJob(job.id, job.leaseId, 'repository-provider-failed', failedAt)
    }
    throw error
  }
}

function transientHostedPreviewSourceFailure(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true
  return error instanceof Error && /status (?:429|5\d\d)\b/.test(error.message)
}

async function finishHostedPreviewBuild(request: Request, options: ApiAppOptions, jobId: string, outcome: 'complete' | 'retry' | 'fail'): Promise<Response> {
  if (!hostedPreviewBuildAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const input = await readObject(request, 1_024)
  const expected = outcome === 'retry' ? 'leaseId,nextAttemptAt' : outcome === 'fail' ? 'errorId,leaseId' : 'leaseId'
  if (Object.keys(input).sort().join(',') !== expected) throw new ApiInputError('invalid_hosted_preview_build', 'Hosted preview build request is invalid.')
  const leaseId = readId(input.leaseId, 'leaseId')
  const now = new Date(options.hostedPreviewNow?.() ?? Date.now())
  let changed = false
  if (outcome === 'complete') changed = await options.store.completeHostedPreviewBuildJob(readId(jobId, 'jobId'), leaseId, now)
  else if (outcome === 'retry') {
    if (!Number.isSafeInteger(input.nextAttemptAt) || Number(input.nextAttemptAt) <= now.getTime() || Number(input.nextAttemptAt) > now.getTime() + 60_000) throw new ApiInputError('invalid_hosted_preview_build', 'Hosted preview build retry is invalid.')
    changed = await options.store.retryHostedPreviewBuildJob(readId(jobId, 'jobId'), leaseId, now, new Date(Number(input.nextAttemptAt)))
  } else {
    if (typeof input.errorId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(input.errorId)) throw new ApiInputError('invalid_hosted_preview_build', 'Hosted preview build failure is invalid.')
    changed = await options.store.failHostedPreviewBuildJob(readId(jobId, 'jobId'), leaseId, input.errorId, now)
  }
  return changed ? json({ status: outcome === 'complete' ? 'completed' : outcome === 'retry' ? 'queued' : 'failed' }) : json(errorBody('not_found', 'Hosted preview build not found.'), 404)
}

function publicHostedPreviewBuild(job: HostedPreviewBuildJob) {
  return {
    id: job.id,
    fileId: job.fileId,
    fileRevision: job.fileRevision,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
    ...(job.status === 'completed' ? { artifactId: job.artifactId, completedAt: job.completedAt } : {}),
    ...(job.status === 'failed' ? { errorId: job.errorId, failedAt: job.failedAt } : {}),
  }
}

function internalHostedPreviewBuild(job: HostedPreviewBuildJob) {
  return {
    id: job.id,
    fileId: job.fileId,
    fileRevision: job.fileRevision,
    projectId: job.projectId,
    scanJobId: job.scanJobId,
    artifactId: job.artifactId,
    stagingId: job.stagingId,
    status: job.status,
    attempts: job.attempts,
  }
}

async function projectRepositories(url: URL, github: GitHubApiServices | undefined, user: HostedSessionUser, projectId: string): Promise<Response> {
  if (!github) return githubUnavailable()
  const tenantId = await github.resolveProjectTenant(projectId, user.id)
  const actor = await github.resolveActor(user)
  if (!tenantId || !actor) return json(errorBody('not_found', 'Repository not found.'), 404)
  const installationId = singleQuery(url, 'installationId')
  const repositories = await github.grants.listLinkableRepositories({ actor, tenantId, projectId, installationId })
  return json({ installationId, repositories: repositories.map(publicRepository) })
}

async function internalRepositoryJob(request: Request, options: ApiAppOptions, jobId: string): Promise<Response> {
  const expectedToken = options.repositoryJobServiceToken
  if (!expectedToken || !equalToken(request.headers.get('X-Canvas-Service-Token') ?? '', expectedToken)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const result = await options.github.jobs.start(jobId)
  return json({ job: { id: result.job.id, operation: result.job.operation, status: result.job.status, attempt: result.job.attempt }, repository: { installationId: result.job.installationId, repositoryId: result.job.repositoryId }, lease: result.job.status === 'running' ? { id: result.job.leaseId, expiresAt: result.job.leaseExpiresAt } : null, access: result.access })
}

async function claimInternalRepositoryJob(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).length !== 0) throw new ApiInputError('invalid_repository_job', 'Repository job request is invalid.')
  const result = await options.github.jobs.claimNext()
  if (!result) return json({ job: null })
  return json({ job: { id: result.job.id, operation: result.job.operation, status: result.job.status, attempt: result.job.attempt }, repository: { installationId: result.job.installationId, repositoryId: result.job.repositoryId }, lease: result.job.status === 'running' ? { id: result.job.leaseId, expiresAt: result.job.leaseExpiresAt } : null, access: result.access })
}

async function claimRepositoryDocsPrepare(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).length !== 0) throw new ApiInputError('invalid_repository_docs_review', 'Documentation review request is invalid.')
  const review = await options.github.docs.claimNextPrepare()
  if (!review) return json({ review: null })
  if (!review.leaseId || !review.leaseExpiresAt) throw new Error('Documentation review lease is invalid.')
  const document = await options.store.getFileDocumentForCapture(review.fileId)
  const scan = await options.github.jobs.currentCompletedScan(review.scanJobId)
  const documentHash = document ? createHash('sha256').update(canonicalJson(document.document)).digest('hex') : null
  const valid = document && document.revision === review.fileRevision && documentHash === review.fileDocumentSha256
    && scan.projectId === review.projectId && scan.tenantId === review.tenantId
    && scan.installationId === review.installationId && scan.repositoryId === review.repositoryId
    && scan.repositoryGrantId === review.repositoryGrantId && scan.repositoryLinkedAt === review.repositoryLinkedAt
    && scan.result.sourceRevision === review.baseCommitSha
  if (!valid) {
    await options.github.docs.markPrepareStale(review.id, review.leaseId, 'review-input-changed')
    return json(errorBody('repository_docs_review_stale', 'Documentation review inputs changed.'), 409)
  }
  return json({ review: {
    id: review.id,
    leaseId: review.leaseId,
    leaseExpiresAt: review.leaseExpiresAt,
    projectId: review.projectId,
    fileId: review.fileId,
    fileRevision: review.fileRevision,
    fileDocumentSha256: review.fileDocumentSha256,
    scanJobId: review.scanJobId,
    installationId: review.installationId,
    repositoryId: review.repositoryId,
    repositoryGrantId: review.repositoryGrantId,
    repositoryLinkedAt: review.repositoryLinkedAt,
    baseRef: review.baseRef,
    baseCommitSha: review.baseCommitSha,
    baseTreeSha: review.baseTreeSha,
    adapter: review.adapter,
    document: document!.document,
    scan: scan.result,
  } })
}

async function claimRepositoryDocsSave(request: Request, options: ApiAppOptions): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).length !== 0) throw new ApiInputError('invalid_repository_docs_review', 'Documentation review request is invalid.')
  const claim = await options.github.docs.claimNextSave()
  if (!claim) return json({ review: null })
  const { review, access } = claim
  if (!review.leaseId || !review.leaseExpiresAt || !review.preparedBundle || !review.approvalDigest) throw new Error('Documentation save lease is invalid.')
  const document = await options.store.getFileDocumentForCapture(review.fileId)
  const documentHash = document ? createHash('sha256').update(canonicalJson(document.document)).digest('hex') : null
  if (!document || document.revision !== review.fileRevision || documentHash !== review.fileDocumentSha256) {
    await options.github.docs.markSaveStale(review.id, review.leaseId, 'review-input-changed')
    return json({ review: null })
  }
  let prepared
  try { prepared = hostedDocsReview(review.preparedBundle) }
  catch {
    await options.github.docs.markSaveStale(review.id, review.leaseId, 'review-result-invalid')
    return json({ review: null })
  }
  if (prepared.approvalDigest !== review.approvalDigest) {
    await options.github.docs.markSaveStale(review.id, review.leaseId, 'review-digest-changed')
    return json({ review: null })
  }
  const bundle = prepared.bundle
  const matches = bundle.projectId === review.projectId && bundle.fileId === review.fileId && bundle.fileRevision === review.fileRevision
    && bundle.fileDocumentSha256 === review.fileDocumentSha256 && bundle.scanJobId === review.scanJobId
    && bundle.installationId === review.installationId && bundle.repositoryId === review.repositoryId
    && bundle.repositoryGrantId === review.repositoryGrantId && bundle.repositoryLinkedAt === review.repositoryLinkedAt
    && bundle.baseRef === review.baseRef && bundle.baseCommitSha === review.baseCommitSha && bundle.baseTreeSha === review.baseTreeSha
    && canonicalJson(bundle.adapter) === canonicalJson(review.adapter)
  if (!matches) {
    await options.github.docs.markSaveStale(review.id, review.leaseId, 'review-result-mismatch')
    return json({ review: null })
  }
  return json({
    review: {
      id: review.id,
      leaseId: review.leaseId,
      leaseExpiresAt: review.leaseExpiresAt,
      repositoryId: review.repositoryId,
      baseRef: review.baseRef,
      baseCommitSha: review.baseCommitSha,
      baseTreeSha: review.baseTreeSha,
      proposedCommitSha: review.proposedCommitSha,
      approvalDigest: review.approvalDigest,
      preparedBundle: bundle,
    },
    access,
  })
}

async function repositoryDocsSource(request: Request, options: ApiAppOptions, reviewId: string): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).join(',') !== 'leaseId' || typeof input.leaseId !== 'string') throw new ApiInputError('invalid_repository_docs_review', 'Documentation review request is invalid.')
  const review = await options.github.docs.authorizePrepareLease(reviewId, input.leaseId)
  const archive = await options.github.downloadRepositoryArchive({ installationId: review.installationId, repositoryId: review.repositoryId, sourceRevision: review.baseCommitSha })
  return new Response(archive.body, { status: 200, headers: { 'Content-Type': archive.headers.get('content-type')!, 'Content-Length': archive.headers.get('content-length')!, 'Cache-Control': 'no-store' } })
}

async function completeRepositoryDocsPrepare(request: Request, options: ApiAppOptions, reviewId: string): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 6 * 1024 * 1024)
  if (Object.keys(input).sort().join(',') !== 'bundle,leaseId' || typeof input.leaseId !== 'string') throw new ApiInputError('invalid_repository_docs_review', 'Documentation review result is invalid.')
  const review = await options.github.docs.authorizePrepareLease(reviewId, input.leaseId)
  let prepared
  try { prepared = hostedDocsReview(input.bundle) }
  catch { throw new ApiInputError('invalid_repository_docs_review', 'Documentation review result is invalid.') }
  const bundle = prepared.bundle
  const matches = bundle.projectId === review.projectId && bundle.fileId === review.fileId && bundle.fileRevision === review.fileRevision
    && bundle.fileDocumentSha256 === review.fileDocumentSha256 && bundle.scanJobId === review.scanJobId
    && bundle.installationId === review.installationId && bundle.repositoryId === review.repositoryId
    && bundle.repositoryGrantId === review.repositoryGrantId && bundle.repositoryLinkedAt === review.repositoryLinkedAt
    && bundle.baseRef === review.baseRef && bundle.baseCommitSha === review.baseCommitSha && bundle.baseTreeSha === review.baseTreeSha
    && canonicalJson(bundle.adapter) === canonicalJson(review.adapter)
  if (!matches) {
    await options.github.docs.markPrepareStale(review.id, input.leaseId, 'review-result-mismatch')
    return json(errorBody('repository_docs_review_stale', 'Documentation review inputs changed.'), 409)
  }
  await options.github.docs.completePrepare(review.id, input.leaseId, bundle as unknown as Readonly<Record<string, unknown>>, prepared.approvalDigest)
  return json({ review: { id: review.id, status: 'prepared', approvalDigest: prepared.approvalDigest } })
}

async function setRepositoryDocsProposedCommit(request: Request, options: ApiAppOptions, reviewId: string): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).sort().join(',') !== 'leaseId,proposedCommitSha' || typeof input.leaseId !== 'string' || typeof input.proposedCommitSha !== 'string') throw new ApiInputError('invalid_repository_docs_review', 'Documentation review result is invalid.')
  await options.github.docs.setProposedCommit(reviewId, input.leaseId, input.proposedCommitSha)
  return json({ review: { id: reviewId, status: 'saving', proposedCommitSha: input.proposedCommitSha } })
}

async function completeRepositoryDocsSave(request: Request, options: ApiAppOptions, reviewId: string): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).sort().join(',') !== 'committedSha,leaseId' || typeof input.leaseId !== 'string' || typeof input.committedSha !== 'string') throw new ApiInputError('invalid_repository_docs_review', 'Documentation review result is invalid.')
  await options.github.docs.completeSave(reviewId, input.leaseId, input.committedSha)
  return json({ review: { id: reviewId, status: 'saved', committedSha: input.committedSha } })
}

async function staleRepositoryDocsSave(request: Request, options: ApiAppOptions, reviewId: string): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).sort().join(',') !== 'errorId,leaseId' || typeof input.leaseId !== 'string' || typeof input.errorId !== 'string') throw new ApiInputError('invalid_repository_docs_review', 'Documentation review result is invalid.')
  await options.github.docs.markSaveStale(reviewId, input.leaseId, input.errorId)
  return json({ review: { id: reviewId, status: 'stale', errorId: input.errorId } })
}

async function failRepositoryDocsSave(request: Request, options: ApiAppOptions, reviewId: string): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).sort().join(',') !== 'errorId,leaseId' || typeof input.leaseId !== 'string' || typeof input.errorId !== 'string') throw new ApiInputError('invalid_repository_docs_review', 'Documentation review result is invalid.')
  await options.github.docs.markSaveFailed(reviewId, input.leaseId, input.errorId)
  return json({ review: { id: reviewId, status: 'failed', errorId: input.errorId } })
}

async function completeInternalRepositoryJob(request: Request, options: ApiAppOptions, jobId: string): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 5 * 1024 * 1024)
  if (Object.keys(input).sort().join(',') !== 'leaseId,result') throw new ApiInputError('invalid_repository_scan', 'Repository scan result is invalid.')
  const result = readRepositoryScanArtifact(input.result)
  const completed = await options.github.jobs.completeScan(jobId, readId(input.leaseId, 'leaseId'), result)
  return json({ job: { id: completed.id, operation: completed.operation, status: completed.status, attempt: completed.attempt } })
}

async function finishInternalRepositoryJob(request: Request, options: ApiAppOptions, jobId: string, outcome: 'retry' | 'fail'): Promise<Response> {
  if (!repositoryJobAuthorized(request, options)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  if (!options.github) return json(errorBody('not_found', 'Route not found.'), 404)
  const input = await readObject(request, 1_024)
  const expected = outcome === 'retry' ? 'leaseId,nextAttemptAt' : 'errorId,leaseId'
  if (Object.keys(input).sort().join(',') !== expected) throw new ApiInputError('invalid_repository_job', 'Repository job request is invalid.')
  const leaseId = readId(input.leaseId, 'leaseId')
  if (outcome === 'retry') {
    if (!Number.isSafeInteger(input.nextAttemptAt)) throw new ApiInputError('invalid_repository_job', 'Repository job request is invalid.')
    await options.github.jobs.retryScan(jobId, leaseId, input.nextAttemptAt as number)
    return json({ status: 'queued' })
  }
  if (typeof input.errorId !== 'string') throw new ApiInputError('invalid_repository_job', 'Repository job request is invalid.')
  await options.github.jobs.failScan(jobId, leaseId, input.errorId)
  return json({ status: 'failed' })
}

function repositoryJobAuthorized(request: Request, options: ApiAppOptions): boolean {
  const expectedToken = options.repositoryJobServiceToken
  return Boolean(expectedToken && equalToken(request.headers.get('X-Canvas-Service-Token') ?? '', expectedToken))
}

function hostedPreviewBuildAuthorized(request: Request, options: ApiAppOptions): boolean {
  const expectedToken = options.hostedPreviewBuildServiceToken
  const suppliedToken = request.headers.get('X-Canvas-Service-Token') ?? ''
  return expectedToken !== undefined && equalToken(suppliedToken, expectedToken)
}

function readRepositoryScanArtifact(value: unknown) {
  try { return parseShadcnScanArtifact(value) }
  catch { throw new ApiInputError('invalid_repository_scan', 'Repository scan result is invalid.') }
}

async function githubWebhook(request: Request, github: GitHubApiServices | undefined): Promise<Response> {
  if (!github) return githubUnavailable()
  const deliveryId = request.headers.get('X-GitHub-Delivery') ?? ''
  const eventName = request.headers.get('X-GitHub-Event') ?? ''
  const signature = request.headers.get('X-Hub-Signature-256') ?? ''
  const body = await readRaw(request, 1024 * 1024)
  const result = await github.webhooks.handle({ deliveryId, eventName, signature, body })
  return json({ status: result.status }, 202)
}

function githubUnavailable(): Response {
  return json(errorBody('github_not_configured', 'Repository connection is not configured for this environment.'), 503)
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

async function registerHostedPreviewArtifact(request: Request, options: ApiAppOptions): Promise<Response> {
  const configured = options.hostedPreviewPublisherServiceToken
  if (!configured || !equalToken(request.headers.get('X-Canvas-Hosted-Preview-Publisher-Token') ?? '', configured)) {
    return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  }
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'artifactId,entrypoint,fileId,fileRevision,registryFingerprint,sourceRevision') {
    throw new ApiInputError('invalid_hosted_preview', 'Hosted preview registration is invalid.')
  }
  const artifact = Object.freeze({
    artifactId: readId(input.artifactId, 'artifactId'),
    fileId: readId(input.fileId, 'fileId'),
    fileRevision: readExpectedRevision(input.fileRevision),
    sourceRevision: readPattern(input.sourceRevision, /^[a-f0-9]{40}$/, 'sourceRevision'),
    registryFingerprint: readPattern(input.registryFingerprint, /^sha256:[a-f0-9]{64}$/, 'registryFingerprint'),
    entrypoint: readArtifactPath(input.entrypoint),
  })
  const result = await options.store.registerHostedPreviewArtifact(artifact)
  if (result.status === 'not-found') return json(errorBody('not_found', 'File not found.'), 404)
  if (result.status === 'revision-conflict') return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: result.currentRevision } }, 409)
  if (result.status === 'identity-conflict') return json(errorBody('artifact_conflict', 'Hosted preview identity is already bound.'), 409)
  return json({ artifact: result.artifact }, result.status === 'registered' ? 201 : 200)
}

async function hostedPreviewCapability(request: Request, options: ApiAppOptions, user: HostedSessionUser, fileId: string): Promise<Response> {
  const secret = options.hostedPreviewCapabilitySecret
  const previewOrigin = options.hostedPreviewOrigin
  if (!secret || !previewOrigin || !options.hostedPreviewPublisherServiceToken) return json(errorBody('hosted_preview_unavailable', 'Hosted preview is unavailable.'), 503)
  const input = await readObject(request, 1_024)
  if (Object.keys(input).join(',') !== 'artifactId') throw new ApiInputError('invalid_hosted_preview', 'Hosted preview request is invalid.')
  const artifactId = readId(input.artifactId, 'artifactId')
  const artifact = await options.store.authorizeHostedPreviewArtifact(user.id, fileId, artifactId)
  if (!artifact || artifact.fileId !== fileId || artifact.artifactId !== artifactId) return json(errorBody('not_found', 'Hosted preview not found.'), 404)
  const now = options.hostedPreviewNow?.() ?? Math.floor(Date.now() / 1000)
  const expiresAt = now + 120
  const capability = await issueHostedPreviewCapability({ artifactId, audience: previewOrigin, secret, now, lifetimeSeconds: 120 })
  return json({ preview: { artifactId, url: `${previewOrigin}/hosted/${artifactId}/${capability}/${artifact.entrypoint}`, expiresAt } }, 201)
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

function readPattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ApiInputError('invalid_hosted_preview', `${field} is invalid.`)
  return value
}

function readArtifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.startsWith('/') || value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new ApiInputError('invalid_hosted_preview', 'entrypoint is invalid.')
  }
  return value
}

function exactHttpOrigin(value: string, name: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${name} must be an exact HTTPS or loopback HTTP origin.`) }
  if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`${name} must be an exact HTTPS or loopback HTTP origin.`)
  }
  return url.origin
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
function jsonNull(): Response { return new Response('null', { headers: jsonHeaders }) }
function errorBody(code: string, message: string) { return { error: { code, message } } }

class ApiInputError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
