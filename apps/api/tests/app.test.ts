import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { HostedAuth, HostedSessionUser } from '@canvas/auth/server'
import { createMemoryGitHubPersistence } from '@canvas/database/github'
import { createMemoryControlPlane } from '@canvas/database/memory'
import { GitHubGrantService, GitHubWebhookService, HostedSourceBindingConflictError, HostedSourceBindingService, InstallationStateService, RepositoryDocsReviewService, RepositoryJobService, type GitHubActor, type GitHubProviderPort, type RepositoryDocsReview, type RepositoryDocsReviewStore } from '@canvas/github-app'
import { verifyHostedPreviewCapability } from '@canvas/preview-runtime/hosted-capability'
import { verifyHostedPreviewWriteCapability } from '@canvas/preview-runtime/hosted-write-capability'
import { createApiApp } from '../src/app'
import { parseGitHubUserTokenPayload, type GitHubApiServices } from '../src/github'

const serviceToken = '0123456789abcdef0123456789abcdef'
const repositoryJobServiceToken = 'repository-job-0123456789abcdef0123456789'
const hostedPreviewBuildServiceToken = 'hosted-preview-build-0123456789abcdef012345'
const hostedPreviewWriteSecret = 'hosted-preview-write-0123456789abcdef012345'
const assetsOrigin = 'https://assets.canvas.test'
const thumbnailServiceToken = 'abcdef0123456789abcdef0123456789'
const registryFingerprint = `sha256-${'A'.repeat(43)}=`
const hostedPreviewPublisherToken = 'hosted-preview-publisher-token-0123456789abcdef'
const hostedPreviewCapabilitySecret = 'hosted-preview-capability-secret-0123456789abcdef'
const hostedPreviewOrigin = 'https://preview.canvas.test'
const users = Object.freeze({
  alpha: Object.freeze({ id: 'user-alpha', name: 'Alpha', email: 'alpha@example.test', image: null }),
  beta: Object.freeze({ id: 'user-beta', name: 'Beta', email: 'beta@example.test', image: null }),
}) satisfies Record<string, HostedSessionUser>

function auth(): HostedAuth {
  return Object.freeze({
    handler: async () => new Response(JSON.stringify({ provider: 'github' }), { headers: { 'Content-Type': 'application/json' } }),
    getSession: async request => {
      const authorization = request.headers.get('Authorization')
      return authorization === 'Bearer alpha' ? users.alpha : authorization === 'Bearer beta' ? users.beta : null
    },
  })
}

const request = (path: string, init: RequestInit = {}) => new Request(`https://api.canvas.test${path}`, init)
const signed = (user: 'alpha' | 'beta', method = 'GET', body?: object): RequestInit => ({
  method,
  headers: { Authorization: `Bearer ${user}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
const body = async (response: Response) => response.json() as Promise<Record<string, any>>
const fileDocument = (fileId: string, revision = 0): Record<string, any> => ({
  schemaVersion: 13,
  fileId,
  revision,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
  componentModel: { definitions: {}, instances: {} },
})
const legacyFileDocument = (fileId: string, revision: number, schemaVersion: number): Record<string, any> => {
  const { componentModel: _componentModel, ...document } = fileDocument(fileId, revision)
  return { ...document, schemaVersion }
}

const githubInstallation = Object.freeze({ id: '2001', account: Object.freeze({ id: '3001', login: 'canvas-team', type: 'Organization' as const }), contentsPermission: 'write' as const })
const githubRepository = Object.freeze({ id: '4001', installationId: '2001', ownerId: '3001', ownerLogin: 'canvas-team', name: 'design-system', fullName: 'canvas-team/design-system', isPrivate: true, contentsPermission: 'write' as const })
const githubWebhookSecret = 'github-webhook-secret-with-enough-entropy'

function githubServices(input: Readonly<{ provider?: GitHubProviderPort; beforeInstallationToken?: () => Promise<void> }> = {}) {
  const persistence = createMemoryGitHubPersistence()
  const providerCalls = { installations: 0, repositories: 0 }
  const provider: GitHubProviderPort = input.provider ?? Object.freeze({
    async listInstallationsForUser(actor: GitHubActor) {
      providerCalls.installations += 1
      return actor.providerUserId === '1001' ? [githubInstallation] : []
    },
    async getRepositoryForInstallation({ actor }: Readonly<{ actor: GitHubActor; installationId: string; repositoryId: string }>) {
      providerCalls.repositories += 1
      return actor.providerUserId === '1001' ? githubRepository : null
    },
    async listRepositoriesForInstallation({ actor }: Readonly<{ actor: GitHubActor; installationId: string }>) {
      providerCalls.repositories += 1
      return actor.providerUserId === '1001' ? [githubRepository] : []
    },
  })
  const states = new InstallationStateService(persistence.states)
  const grants = new GitHubGrantService(provider, persistence.grants, states, persistence.projectAuthorization)
  let docsReview: RepositoryDocsReview | null = null
  const docsStore: RepositoryDocsReviewStore = {
    async enqueuePrepare(review) {
      docsReview = Object.freeze({ ...review, approvedByAccountId: null, preparedBundle: null, approvalDigest: null, status: 'queued_prepare', attempt: 0, leaseId: null, leaseExpiresAt: null, nextAttemptAt: review.createdAt, errorId: null, preparedAt: null, approvedAt: null, proposedCommitSha: null, committedSha: null, completedAt: null, failedAt: null })
      return docsReview
    },
    async get() { return docsReview },
    async getAuthorized() { return docsReview },
    async getLatestAuthorized(projectId, fileId) { return docsReview?.projectId === projectId && docsReview.fileId === fileId ? docsReview : null },
    async claimNextPrepare(input) {
      if (!docsReview || docsReview.status !== 'queued_prepare') return null
      docsReview = Object.freeze({ ...docsReview, status: 'preparing', attempt: docsReview.attempt + 1, leaseId: input.leaseId, leaseExpiresAt: input.leaseExpiresAt, nextAttemptAt: null })
      return docsReview
    },
    async isCurrentLease(input) { return Boolean(docsReview?.id === input.id && docsReview.status === input.status && docsReview.leaseId === input.leaseId && (docsReview.leaseExpiresAt ?? 0) > input.now) },
    async completePrepare(input) {
      if (!docsReview || docsReview.status !== 'preparing' || docsReview.leaseId !== input.leaseId) return false
      docsReview = Object.freeze({ ...docsReview, status: 'prepared', leaseId: null, leaseExpiresAt: null, preparedBundle: input.preparedBundle, approvalDigest: input.approvalDigest, preparedAt: input.now })
      return true
    },
    async approveSave(input) {
      if (!docsReview || docsReview.status !== 'prepared' || docsReview.approvalDigest !== input.approvalDigest) return false
      docsReview = Object.freeze({ ...docsReview, status: 'queued_save', approvedByAccountId: input.actorAccountId, approvedAt: input.now, nextAttemptAt: input.now })
      return true
    },
    async claimNextSave(input) {
      if (!docsReview || docsReview.status !== 'queued_save') return null
      docsReview = Object.freeze({ ...docsReview, status: 'saving', attempt: docsReview.attempt + 1, leaseId: input.leaseId, leaseExpiresAt: input.leaseExpiresAt, nextAttemptAt: null })
      return docsReview
    },
    async setProposedCommit(input) {
      if (!docsReview || docsReview.status !== 'saving' || docsReview.leaseId !== input.leaseId) return false
      docsReview = Object.freeze({ ...docsReview, proposedCommitSha: input.proposedCommitSha })
      return true
    },
    async completeSave(input) {
      if (!docsReview || docsReview.status !== 'saving' || docsReview.leaseId !== input.leaseId || docsReview.proposedCommitSha !== input.committedSha) return false
      docsReview = Object.freeze({ ...docsReview, status: 'saved', committedSha: input.committedSha, completedAt: input.now, leaseId: null, leaseExpiresAt: null })
      return true
    },
    async markTerminal(input) {
      if (!docsReview || docsReview.leaseId !== input.leaseId) return false
      docsReview = Object.freeze({ ...docsReview, status: input.status, errorId: input.errorId, failedAt: input.now, leaseId: null, leaseExpiresAt: null, nextAttemptAt: null })
      return true
    },
  }
  const installationTokens = { async mint(tokenInput: Readonly<{ contentsPermission: 'read' | 'write' }>) {
    await input.beforeInstallationToken?.()
    return { token: `ghs_test_${tokenInput.contentsPermission}`, expiresAt: Date.now() + 60_000, contentsPermission: tokenInput.contentsPermission }
  } }
  const jobs = new RepositoryJobService(grants, persistence.jobs, installationTokens)
  const services: GitHubApiServices = Object.freeze({
    states,
    grants,
    webhooks: new GitHubWebhookService(githubWebhookSecret, persistence.deliveries, persistence.grants),
    jobs,
    docs: new RepositoryDocsReviewService(grants, docsStore, installationTokens),
    sourceBindings: new HostedSourceBindingService(grants, jobs, persistence.sourceBindings),
    async resolveActor(user) {
      return user.id === 'user-alpha'
        ? { accountId: user.id, providerUserId: '1001' }
        : user.id === 'user-beta' ? { accountId: user.id, providerUserId: '1002' } : null
    },
    async authorizeUser(input) { return input.accountId === 'user-alpha' ? { accountId: input.accountId, providerUserId: '1001' } : { accountId: input.accountId, providerUserId: '1002' } },
    async issueAuthorization(input) {
      const issued = await states.issue({ accountId: input.accountId, tenantId: input.tenantId, purpose: 'authorize-user', installationId: input.installationId, codeVerifierCiphertext: 'encrypted-verifier', returnToUrl: input.returnToUrl })
      return { authorizationUrl: `https://github.com/login/oauth/authorize?state=${encodeURIComponent(issued.state)}`, expiresAt: issued.expiresAt }
    },
    resolveProjectTenant(projectId, userId) { return persistence.projectTenancy.resolveTenantForMember(projectId, userId) },
    installationUrl(state) { return `https://github.com/apps/comp-canvas/installations/new?state=${encodeURIComponent(state)}` },
    async resolveRepositoryBase(input) { return { baseRef: 'refs/heads/main', baseCommitSha: input.expectedSourceRevision, baseTreeSha: 'e'.repeat(40) } },
    async readRepositoryTextFile() { return JSON.stringify({ version: 1, renderer: 'blume', layout: { docsDirectory: 'apps/docs/content/docs/components', examplesDirectory: 'apps/docs/registry/comp', metaPath: 'apps/docs/content/docs/components/meta.ts', manifestPath: 'apps/docs/registry/comp/components.json' }, components: [] }) },
    async downloadRepositoryArchive() { return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'application/gzip', 'Content-Length': '1' } }) },
  })
  return { persistence, providerCalls, services }
}

describe('hosted control-plane API', () => {
  it('COMP-V2-CODE-007 registers one immutable file-revision artifact and mints only authorized capabilities', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Preview', null)
    const artifactId = '00000000-0000-4000-8000-000000000701'
    const artifact = {
      artifactId,
      fileId: file.id,
      fileRevision: 0,
      sourceRevision: 'a'.repeat(40),
      registryFingerprint: `sha256:${'b'.repeat(64)}`,
      entrypoint: 'index.html',
    }
    const app = createApiApp({
      auth: auth(), store, serviceToken, registryFingerprint,
      hostedPreviewPublisherServiceToken: hostedPreviewPublisherToken,
      hostedPreviewCapabilitySecret,
      hostedPreviewOrigin,
      hostedPreviewNow: () => 1_800_000_000,
    })
    const rejectedRegistration = await app(request('/internal/hosted-previews/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(artifact) }))
    expect(rejectedRegistration.status).toBe(403)
    const registration = await app(request('/internal/hosted-previews/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Hosted-Preview-Publisher-Token': hostedPreviewPublisherToken },
      body: JSON.stringify(artifact),
    }))
    expect(registration.status).toBe(201)
    expect(await body(registration)).toEqual({ artifact })

    const owner = await app(request(`/api/files/${file.id}/hosted-preview-capability`, signed('alpha', 'POST', { artifactId })))
    expect(owner.status).toBe(201)
    const preview = (await body(owner)).preview
    expect(preview).toMatchObject({ artifactId, expiresAt: 1_800_000_120 })
    const previewUrl = new URL(preview.url)
    const capability = previewUrl.pathname.split('/')[3]!
    await expect(verifyHostedPreviewCapability({ token: capability, artifactId, audience: hostedPreviewOrigin, secret: hostedPreviewCapabilitySecret, now: 1_800_000_001 })).resolves.toMatchObject({ artifactId })

    const privateViewer = await app(request(`/api/files/${file.id}/hosted-preview-capability`, signed('beta', 'POST', { artifactId })))
    expect(privateViewer.status).toBe(404)
    await store.setFileShare(users.alpha.id, file.id, 'view')
    const sharedViewer = await app(request(`/api/files/${file.id}/hosted-preview-capability`, signed('beta', 'POST', { artifactId })))
    expect(sharedViewer.status).toBe(201)

    await store.saveFileDocument(users.alpha.id, file.id, 0, fileDocument(file.id, 1))
    const stale = await app(request(`/api/files/${file.id}/hosted-preview-capability`, signed('alpha', 'POST', { artifactId })))
    expect(stale.status).toBe(404)
  })

  it('COMP-V2-CODE-007 refuses artifact identity rebinding and stale publication', async () => {
    const store = createMemoryControlPlane()
    const first = await store.createFile(users.alpha.id, 'First', null)
    const second = await store.createFile(users.alpha.id, 'Second', null)
    const app = createApiApp({
      auth: auth(), store, serviceToken, registryFingerprint,
      hostedPreviewPublisherServiceToken: hostedPreviewPublisherToken,
      hostedPreviewCapabilitySecret,
      hostedPreviewOrigin,
    })
    const headers = { 'Content-Type': 'application/json', 'X-Canvas-Hosted-Preview-Publisher-Token': hostedPreviewPublisherToken }
    const artifact = {
      artifactId: '00000000-0000-4000-8000-000000000702',
      fileId: first.id,
      fileRevision: 0,
      sourceRevision: 'c'.repeat(40),
      registryFingerprint: `sha256:${'d'.repeat(64)}`,
      entrypoint: 'index.html',
    }
    expect((await app(request('/internal/hosted-previews/register', { method: 'POST', headers, body: JSON.stringify(artifact) }))).status).toBe(201)
    expect((await app(request('/internal/hosted-previews/register', { method: 'POST', headers, body: JSON.stringify(artifact) }))).status).toBe(200)
    expect((await app(request('/internal/hosted-previews/register', { method: 'POST', headers, body: JSON.stringify({ ...artifact, fileId: second.id }) }))).status).toBe(409)
    await store.saveFileDocument(users.alpha.id, second.id, 0, fileDocument(second.id, 1))
    expect((await app(request('/internal/hosted-previews/register', { method: 'POST', headers, body: JSON.stringify({ ...artifact, artifactId: '00000000-0000-4000-8000-000000000703', fileId: second.id }) }))).status).toBe(409)
  })

  it('COMP-V2-CODE-007 requires complete separated hosted preview credentials', () => {
    const base = { auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint }
    expect(() => createApiApp({ ...base, hostedPreviewOrigin })).toThrow('configuration must be complete')
    expect(() => createApiApp({
      ...base,
      hostedPreviewPublisherServiceToken: serviceToken,
      hostedPreviewCapabilitySecret,
      hostedPreviewOrigin,
    })).toThrow('must differ')
    expect(() => createApiApp({
      ...base,
      hostedPreviewPublisherServiceToken: hostedPreviewPublisherToken,
      hostedPreviewCapabilitySecret: hostedPreviewPublisherToken,
      hostedPreviewOrigin,
    })).toThrow('HOSTED_PREVIEW_CAPABILITY_SECRET must differ from HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN')
    expect(() => createApiApp({
      ...base,
      hostedPreviewPublisherServiceToken: hostedPreviewPublisherToken,
      hostedPreviewCapabilitySecret: serviceToken,
      hostedPreviewOrigin,
    })).toThrow('HOSTED_PREVIEW_CAPABILITY_SECRET must differ from API_SERVICE_TOKEN')
  })

  it('DEPLOY-STAGING-001 reports the exact deployed revision without authentication', async () => {
    const revision = 'a'.repeat(40)
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint, deploymentRevision: revision })
    const response = await app(request('/healthz/deployment'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await body(response)).toEqual({ revision })
  })

  it('ERROR-VISIBILITY-001 logs an unexpected failure and returns the same safe request id', async () => {
    const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const reportError = vi.fn()
    const store = { ...createMemoryControlPlane(), listFiles: async () => { throw new Error('database password leaked here') } }
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, reportError })
    const response = await app(request('/api/files', { headers: { Authorization: 'Bearer alpha', 'X-Canvas-Request-Id': requestId } }))
    const responseBody = await body(response)
    expect(response.status).toBe(500)
    expect(response.headers.get('X-Canvas-Request-Id')).toBe(requestId)
    expect(responseBody).toEqual({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId } })
    expect(JSON.stringify(responseBody)).not.toContain('database password')
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ requestId, method: 'GET', pathname: '/api/files', error: expect.any(Error) }))
  })

  it('AT-GHAPP-001 rejects OAuth App and installation token classes for GitHub App user authorization', () => {
    const payload = { refresh_token: 'ghr_refresh', expires_in: 28_800, refresh_token_expires_in: 15_897_600 }
    expect(() => parseGitHubUserTokenPayload({ ...payload, access_token: 'gho_oauth' }, 1_800_000_000_000)).toThrow('invalid user token')
    expect(() => parseGitHubUserTokenPayload({ ...payload, access_token: 'ghs_installation' }, 1_800_000_000_000)).toThrow('invalid user token')
    expect(parseGitHubUserTokenPayload({ ...payload, access_token: 'ghu_user' }, 1_800_000_000_000).accessToken).toBe('ghu_user')
    expect(() => createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, repositoryJobServiceToken: 'too-short', registryFingerprint })).toThrow('REPOSITORY_JOB_SERVICE_TOKEN')
    expect(() => createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, repositoryJobServiceToken: serviceToken, registryFingerprint })).toThrow('must differ')
    expect(() => createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, hostedPreviewBuildServiceToken: 'too-short', registryFingerprint })).toThrow('HOSTED_PREVIEW_BUILD_SERVICE_TOKEN')
    expect(() => createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, repositoryJobServiceToken, hostedPreviewBuildServiceToken: repositoryJobServiceToken, hostedPreviewWriteSecret, assetsOrigin, registryFingerprint })).toThrow('must differ')
  })

  it('AT-GHAPP-LOCAL-001 reports missing GitHub App configuration without disguising it as a missing route', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint, allowedOrigins: ['https://editor.canvas.test'] })
    const response = await app(request('/api/github/installations/start', signed('alpha', 'POST', { returnTo: 'https://editor.canvas.test/file/current' })))
    expect(response.status).toBe(503)
    expect(await body(response)).toEqual({ error: { code: 'github_not_configured', message: 'Repository connection is not configured for this environment.' } })
  })
  it('AUTH-HOST-001 delegates provider endpoints and protects session state', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const provider = await app(request('/api/auth/sign-in/social', { method: 'POST' }))
    expect(provider.status).toBe(200)
    expect(await body(provider)).toEqual({ provider: 'github' })
    expect((await app(request('/api/session'))).status).toBe(401)
    const session = await app(request('/api/session', signed('alpha')))
    expect(session.status).toBe(200)
    expect(await body(session)).toEqual({ user: users.alpha })
  })

  it('AT-AUTH-001 accepts the fixed desktop origin and rejects an untrusted origin', async () => {
    const desktopOrigin = 'com.comp-canvas.desktop:/'
    const app = createApiApp({
      auth: auth(),
      store: createMemoryControlPlane(),
      serviceToken,
      registryFingerprint,
      allowedOrigins: [desktopOrigin],
    })
    const desktop = await app(request('/api/auth/get-session', { headers: { Origin: desktopOrigin } }))
    expect(desktop.status).toBe(200)
    expect(desktop.headers.get('Access-Control-Allow-Origin')).toBe(desktopOrigin)
    expect(await body(desktop)).toEqual({ provider: 'github' })

    const untrusted = await app(request('/api/auth/get-session', { headers: { Origin: 'https://attacker.example' } }))
    expect(untrusted.status).toBe(403)
    expect(untrusted.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(await body(untrusted)).toEqual({ error: { code: 'origin_forbidden', message: 'Origin is not allowed.' } })
  })

  it('CLOUD-FILES-001 creates, lists, opens, and saves canonical file data', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const projectResponse = await app(request('/api/projects', signed('alpha', 'POST', { name: 'Product' })))
    expect(projectResponse.status).toBe(201)
    const project = (await body(projectResponse)).project
    expect(project.name).toBe('Product')

    const createdResponse = await app(request('/api/files', signed('alpha', 'POST', { name: 'Flows', projectId: project.id })))
    expect(createdResponse.status).toBe(201)
    const file = (await body(createdResponse)).file
    expect(file).toMatchObject({ name: 'Flows', projectId: project.id, headRevision: 0 })
    expect(file.id).toMatch(/^[0-9a-f-]{36}$/)

    const listed = await body(await app(request('/api/files', signed('alpha'))))
    expect(listed.files).toHaveLength(1)
    expect(listed.files[0].id).toBe(file.id)
    expect((await body(await app(request(`/api/files/${file.id}`, signed('alpha'))))).file.name).toBe('Flows')

    const initial = await body(await app(request(`/api/files/${file.id}/document`, signed('alpha'))))
    expect(Object.keys(initial).sort()).toEqual(['document', 'fileId', 'revision'])
    expect(initial).toMatchObject({ fileId: file.id, revision: 0, document: { schemaVersion: 13, fileId: file.id, revision: 0, pages: [{ name: 'Page 1' }], theme: { tokens: {} }, componentModel: { definitions: {}, instances: {} } } })
    const nextDocument = fileDocument(file.id)
    nextDocument.pages.push({ id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' })
    nextDocument.nodes['root-2'] = { id: 'root-2', type: 'root' }
    const saved = await app(request(`/api/files/${file.id}/document`, signed('alpha', 'PUT', { expectedRevision: 0, document: nextDocument })))
    expect(saved.status).toBe(200)
    const savedBody = await body(saved)
    expect(Object.keys(savedBody).sort()).toEqual(['document', 'fileId', 'revision'])
    expect(savedBody).toMatchObject({ fileId: file.id, revision: 1, document: { fileId: file.id, revision: 1, pages: [{ id: 'page-1' }, { id: 'page-2' }] } })
    expect((await body(await app(request(`/api/files/${file.id}`, signed('alpha'))))).file.headRevision).toBe(1)
  })

  it('CLOUD-FILES-CONFLICT-001 rejects stale compare-and-swap saves', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Conflict' }))))).file
    const firstDocument = fileDocument(file.id)
    firstDocument.theme.tokens = { first: { id: 'first', type: 'color', name: 'First', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } } }
    const first = await app(request(`/api/files/${file.id}/document`, signed('alpha', 'PUT', { expectedRevision: 0, document: firstDocument })))
    expect(first.status).toBe(200)
    const stale = await app(request(`/api/files/${file.id}/document`, signed('alpha', 'PUT', { expectedRevision: 0, document: fileDocument(file.id) })))
    expect(stale.status).toBe(409)
    expect(await body(stale)).toEqual({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: 1 } })
    expect((await body(await app(request(`/api/files/${file.id}/document`, signed('alpha'))))).document).toMatchObject({ revision: 1, theme: { tokens: { first: { id: 'first' } } } })
  })

  it('CLOUD-SYNC-SCHEMA-001 upgrades an asset-free version 6 document before returning it', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Legacy', null)
    const legacy = legacyFileDocument(file.id, 1, 6)
    expect((await store.saveFileDocument(users.alpha.id, file.id, 0, legacy)).status).toBe('saved')
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint })

    const response = await app(request(`/api/files/${file.id}/document`, signed('alpha')))

    expect(response.status).toBe(200)
    expect(await body(response)).toMatchObject({ fileId: file.id, revision: 1, document: { schemaVersion: 13, fileId: file.id, revision: 1 } })
  })

  it('rejects legacy saves after collaboration becomes authoritative', async () => {
    const base = createMemoryControlPlane()
    const store = { ...base, saveFileDocument: async () => ({ status: 'collaboration-authoritative' as const }) }
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint })
    const fileId = crypto.randomUUID()
    const response = await app(request(`/api/files/${fileId}/document`, signed('alpha', 'PUT', {
      expectedRevision: 0,
      document: fileDocument(fileId),
    })))

    expect(response.status).toBe(409)
    expect(await body(response)).toEqual({ error: { code: 'collaboration_authoritative', message: 'File is live.' } })
  })

  it('AT-THUMB-001 authorizes revision-bound thumbnail updates without leaking file existence', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Thumbnail' }))))).file
    const key = `thumbnails/${file.id}/versions/0/nonce1234.avif`
    const stableKey = `thumbnails/${file.id}/thumbnail.avif`
    const update = (authorization: 'alpha' | 'beta' | null, expectedRevision: number, thumbnailKey: string, extra?: object) => app(request(`/api/files/${file.id}/thumbnail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
      body: JSON.stringify({ expectedRevision, thumbnailKey, thumbnailEtag: '"etag"', ...extra }),
    }))

    const saved = await update('alpha', 0, key)
    expect(saved.status).toBe(200)
    expect(await body(saved)).toEqual({ thumbnail: { fileId: file.id, revision: 0, thumbnailKey: key, thumbnailEtag: '"etag"' } })

    for (const invalidKey of ['../thumbnail.avif', `thumbnails/${crypto.randomUUID()}/thumbnail.avif`, `${key}/extra`, '']) {
      const invalid = await update('alpha', 0, invalidKey)
      expect(invalid.status).toBe(400)
      expect(await body(invalid)).toEqual({ error: { code: 'invalid_thumbnail_key', message: 'Thumbnail key is invalid.' } })
    }
    expect((await update('alpha', 0, key, { extra: true })).status).toBe(400)
    expect((await update('beta', 0, key)).status).toBe(404)
    expect((await update(null, 0, key)).status).toBe(401)
    expect((await body(await app(request(`/api/files/${file.id}`, signed('alpha'))))).file.thumbnailKey).toBe(stableKey)

    const documentSave = await app(request(`/api/files/${file.id}/document`, signed('alpha', 'PUT', { expectedRevision: 0, document: fileDocument(file.id) })))
    expect(documentSave.status).toBe(200)
    expect((await body(await app(request(`/api/files/${file.id}`, signed('alpha'))))).file.thumbnailKey).toBeNull()

    const nextKey = `thumbnails/${file.id}/versions/1/nonce5678.avif`
    expect((await update('alpha', 1, nextKey)).status).toBe(200)
    const staleClear = await update('alpha', 0, key)
    expect(staleClear.status).toBe(409)
    expect(await body(staleClear)).toEqual({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: 1 } })
    expect((await body(await app(request(`/api/files/${file.id}`, signed('alpha'))))).file.thumbnailKey).toBe(stableKey)
  })

  it('CLOUD-FILES-SEC-001 rejects document identity, revision, and shape substitution', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Validated' }))))).file
    const cases = [
      { ...fileDocument(file.id), fileId: crypto.randomUUID() },
      { ...fileDocument(file.id), revision: 1 },
      { ...fileDocument(file.id), pages: [] },
      { ...fileDocument(file.id), extra: true },
      { ...fileDocument(file.id), nodes: { 'root-1': { id: 'root-1', type: 'root' }, box: { id: 'box', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: -1, height: 10 } } }, relationships: { box: { parentId: 'root-1', orderKey: 'V' } } },
    ]
    for (const document of cases) {
      const response = await app(request(`/api/files/${file.id}/document`, signed('alpha', 'PUT', { expectedRevision: 0, document })))
      expect(response.status).toBe(400)
      expect(await body(response)).toMatchObject({ error: { code: 'invalid_document' } })
    }
    expect((await body(await app(request(`/api/files/${file.id}/document`, signed('alpha'))))).revision).toBe(0)
  })

  it('CLOUD-FILES-SEC-001 denies cross-user file and project access without leaking existence', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const project = (await body(await app(request('/api/projects', signed('alpha', 'POST', { name: 'Private' }))))).project
    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { projectId: project.id }))))).file
    for (const path of [`/api/projects/${project.id}`, `/api/files/${file.id}`, `/api/files/${file.id}/document`]) {
      const response = await app(request(path, signed('beta')))
      expect(response.status, path).toBe(404)
      expect(await body(response)).toEqual({ error: { code: 'not_found', message: path.includes('projects') ? 'Project not found.' : 'File not found.' } })
    }
    expect((await app(request(`/api/files/${file.id}/document`, signed('beta', 'PUT', { expectedRevision: 0, document: fileDocument(file.id) })))).status).toBe(404)
    expect((await app(request('/api/files', signed('beta', 'POST', { projectId: project.id })))).status).toBe(404)
    expect((await body(await app(request('/api/files', signed('beta'))))).files).toEqual([])
  })

  it('AT-SHARE-003 enforces owner changes and public read-only links', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Link view' }))))).file
    const sharePath = `/api/files/${file.id}/share`
    const readPath = `/api/shared/files/${file.id}`
    const assetRead = (authorization?: 'Bearer beta') => app(request('/internal/file-access', {
      method: 'POST',
      headers: { ...(authorization ? { Authorization: authorization } : {}), 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
      body: JSON.stringify({ fileId: file.id, access: 'read' }),
    }))

    expect(await body(await app(request(sharePath, signed('alpha'))))).toMatchObject({ share: { fileId: file.id, access: 'private' } })
    expect((await app(request(sharePath, signed('beta', 'PUT', { access: 'view' })))).status).toBe(404)
    expect((await app(request(readPath))).status).toBe(404)
    expect((await assetRead()).status).toBe(404)
    const privateRead = await app(request(readPath, signed('beta')))
    expect(privateRead.status).toBe(404)
    expect(await body(privateRead)).toEqual({ error: { code: 'not_found', message: 'Shared file not found.' } })

    const enabled = await app(request(sharePath, signed('alpha', 'PUT', { access: 'view' })))
    expect(enabled.status).toBe(200)
    expect(await body(enabled)).toMatchObject({ share: { fileId: file.id, access: 'view' } })
    const viewer = await app(request(readPath, signed('beta')))
    expect(viewer.status).toBe(200)
    const viewerBody = await body(viewer)
    expect(Object.keys(viewerBody).sort()).toEqual(['document', 'file', 'fileId', 'revision'])
    expect(viewerBody).toMatchObject({ file: { id: file.id, name: 'Link view', headRevision: 0 }, fileId: file.id, revision: 0 })
    expect(viewerBody.file).not.toHaveProperty('projectId')
    expect(viewerBody.file).not.toHaveProperty('ownerUserId')
    const signedOutViewer = await app(request(readPath))
    expect(signedOutViewer.status).toBe(200)
    expect(await body(signedOutViewer)).toEqual(viewerBody)
    expect(await body(await assetRead())).toEqual({ userId: `public:${file.id}` })
    expect(await body(await assetRead('Bearer beta'))).toEqual({ userId: `public:${file.id}` })
    expect((await app(request(`/api/files/${file.id}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, document: fileDocument(file.id) }) }))).status).toBe(401)
    expect((await app(request(`/api/files/${file.id}/document`, signed('beta', 'PUT', { expectedRevision: 0, document: fileDocument(file.id) })))).status).toBe(404)

    expect((await app(request(sharePath, signed('alpha', 'PUT', { access: 'private' })))).status).toBe(200)
    const revoked = await app(request(readPath, signed('beta')))
    const unknown = await app(request(`/api/shared/files/${crypto.randomUUID()}`, signed('beta')))
    expect(revoked.status).toBe(404)
    expect((await assetRead()).status).toBe(404)
    expect(await body(revoked)).toEqual(await body(unknown))
  })

  it('FILE-ASSET-SEC-001 requires the service secret and exact user ownership', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint })
    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Asset owner' }))))).file
    const call = (user: 'alpha' | 'beta', token: string) => app(request('/internal/file-access', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json', 'X-Canvas-Service-Token': token },
      body: JSON.stringify({ fileId: file.id, access: 'sync' }),
    }))
    expect((await call('alpha', 'wrong-but-deliberately-similar-token')).status).toBe(403)
    expect((await call('beta', serviceToken)).status).toBe(404)
    const allowed = await call('alpha', serviceToken)
    expect(allowed.status).toBe(200)
    expect(await body(allowed)).toEqual({ userId: 'user-alpha' })

    const revisionAccess = (expectedRevision: number) => app(request('/internal/file-access', {
      method: 'POST',
      headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
      body: JSON.stringify({ fileId: file.id, access: 'write', expectedRevision }),
    }))
    expect((await revisionAccess(0)).status).toBe(200)
    const stale = await revisionAccess(1)
    expect(stale.status).toBe(409)
    expect(await body(stale)).toEqual({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: 0 } })
    const revisionOnRead = await app(request('/internal/file-access', {
      method: 'POST',
      headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
      body: JSON.stringify({ fileId: file.id, access: 'read', expectedRevision: 0 }),
    }))
    expect(revisionOnRead.status).toBe(400)

    const legacy = await app(request('/internal/file-access', {
      method: 'POST',
      headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
      body: JSON.stringify({ fileId: file.id, operation: 'read' }),
    }))
    expect(legacy.status).toBe(400)
    const extended = await app(request('/internal/file-access', {
      method: 'POST',
      headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken },
      body: JSON.stringify({ fileId: file.id, access: 'read', extra: true }),
    }))
    expect(extended.status).toBe(400)
  })

  it('AT-THUMB-001 exposes only revision-matched thumbnail metadata and validated capture source', async () => {
    const store = createMemoryControlPlane()
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, thumbnailServiceToken })
    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Capture source' }))))).file
    const thumbnailRead = (user: 'alpha' | 'beta', payload: object) => app(request('/internal/file-access', {
      method: 'POST', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken }, body: JSON.stringify(payload),
    }))
    const empty = await thumbnailRead('alpha', { fileId: file.id, access: 'read', resource: 'thumbnail' })
    expect(await body(empty)).toEqual({ userId: 'user-alpha', revision: 0, thumbnailKey: null, thumbnailEtag: null })
    const write = await thumbnailRead('alpha', { fileId: file.id, access: 'write', resource: 'thumbnail', expectedRevision: 0 })
    expect(await body(write)).toEqual({ userId: 'user-alpha', revision: 0 })
    expect((await thumbnailRead('alpha', { fileId: file.id, access: 'write', resource: 'thumbnail', expectedRevision: 1 })).status).toBe(409)
    expect((await thumbnailRead('beta', { fileId: file.id, access: 'read', resource: 'thumbnail' })).status).toBe(404)

    const capture = (token: string, fileId = file.id, expectedRevision = 0) => app(request('/internal/thumbnail-source', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Thumbnail-Service-Token': token }, body: JSON.stringify({ fileId, expectedRevision }),
    }))
    expect((await capture('wrong-but-deliberately-similar-token')).status).toBe(403)
    expect((await capture(thumbnailServiceToken, crypto.randomUUID())).status).toBe(404)
    expect((await capture(thumbnailServiceToken, file.id, 1)).status).toBe(409)
    const source = await capture(thumbnailServiceToken)
    expect(source.status).toBe(200)
    const sourceBody = await body(source)
    expect(Object.keys(sourceBody).sort()).toEqual(['document', 'fileId', 'pageId', 'registryFingerprint', 'revision'])
    expect(sourceBody).toMatchObject({ fileId: file.id, revision: 0, registryFingerprint, document: { schemaVersion: 13, fileId: file.id, revision: 0 } })
    expect(sourceBody.pageId).toBe(sourceBody.document.pages[0].id)

    const serviceCall = (path: string, payload: object, token = thumbnailServiceToken) => app(request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Thumbnail-Service-Token': token }, body: JSON.stringify(payload) }))
    expect((await serviceCall('/internal/thumbnail-jobs/claim', {}, 'wrong-but-deliberately-similar-token')).status).toBe(403)
    const firstClaim = await body(await serviceCall('/internal/thumbnail-jobs/claim', {}))
    expect(firstClaim.job).toMatchObject({ fileId: file.id, revision: 0, attempts: 1 })
    expect((await serviceCall(`/internal/thumbnail-jobs/${firstClaim.job.id}/complete`, { leaseId: crypto.randomUUID() })).status).toBe(404)
    expect(await body(await serviceCall(`/internal/thumbnail-jobs/${firstClaim.job.id}/release`, { leaseId: firstClaim.job.leaseId }))).toEqual({ status: 'released' })
    const secondClaim = await body(await serviceCall('/internal/thumbnail-jobs/claim', {}))
    expect(secondClaim.job).toMatchObject({ id: firstClaim.job.id, attempts: 2 })
    expect(await body(await serviceCall(`/internal/thumbnail-jobs/${secondClaim.job.id}/complete`, { leaseId: secondClaim.job.leaseId }))).toEqual({ status: 'completed' })
    expect(await body(await serviceCall('/internal/thumbnail-jobs/claim', {}))).toEqual({ job: null })
    const accessPayload = { fileId: file.id, expectedRevision: 0, resource: 'thumbnail', access: 'write' }
    expect((await serviceCall('/internal/thumbnail-access', accessPayload, 'wrong-but-deliberately-similar-token')).status).toBe(403)
    expect(await body(await serviceCall('/internal/thumbnail-access', accessPayload))).toEqual({ userId: 'user-alpha', revision: 0 })
    expect((await serviceCall('/internal/thumbnail-access', { ...accessPayload, expectedRevision: 1 })).status).toBe(409)
    expect((await serviceCall('/internal/thumbnail-access', { ...accessPayload, access: 'read' })).status).toBe(400)

    const thumbnailKey = `thumbnails/${file.id}/versions/0/service123.avif`
    const metadataPayload = { fileId: file.id, expectedRevision: 0, thumbnailKey, thumbnailEtag: '"service-etag"' }
    expect((await serviceCall('/internal/thumbnail-metadata', metadataPayload, 'wrong-but-deliberately-similar-token')).status).toBe(403)
    expect(await body(await serviceCall('/internal/thumbnail-metadata', metadataPayload))).toEqual({ thumbnail: { fileId: file.id, revision: 0, thumbnailKey, thumbnailEtag: '"service-etag"' } })
    expect((await serviceCall('/internal/thumbnail-metadata', { ...metadataPayload, expectedRevision: 1, thumbnailKey: `thumbnails/${file.id}/versions/1/service456.avif` })).status).toBe(409)
    const missingId = crypto.randomUUID()
    expect((await serviceCall('/internal/thumbnail-metadata', { ...metadataPayload, fileId: missingId, thumbnailKey: `thumbnails/${missingId}/versions/0/missing12.avif` })).status).toBe(404)

    const workerCall = (path: string, payload: object, apiToken = serviceToken, captureToken = thumbnailServiceToken) => app(request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Service-Token': apiToken, 'X-Canvas-Thumbnail-Service-Token': captureToken },
      body: JSON.stringify(payload),
    }))
    expect((await workerCall('/internal/thumbnail-upload-access', { fileId: file.id, expectedRevision: 0 }, 'wrong-but-deliberately-similar-token')).status).toBe(403)
    expect((await workerCall('/internal/thumbnail-upload-access', { fileId: file.id, expectedRevision: 0 }, serviceToken, 'wrong-but-deliberately-similar-token')).status).toBe(403)
    expect(await body(await workerCall('/internal/thumbnail-upload-access', { fileId: file.id, expectedRevision: 0 }))).toEqual({ serviceId: 'thumbnail-renderer', revision: 0 })
    expect((await workerCall('/internal/thumbnail-upload-access', { fileId: file.id, expectedRevision: 1 })).status).toBe(409)

    expect((await workerCall('/internal/thumbnail-commit', { fileId: file.id }, 'wrong-but-deliberately-similar-token')).status).toBe(403)
    expect(await body(await workerCall('/internal/thumbnail-commit', { fileId: file.id }))).toEqual({ revision: 0, thumbnailKey, thumbnailEtag: '"service-etag"' })
    expect((await workerCall('/internal/thumbnail-commit', { fileId: missingId })).status).toBe(404)
  })

  it('AT-GHAPP-001 and AT-REPO-LINK-001 persist verified grants and deny hidden repositories', async () => {
    const store = createMemoryControlPlane()
    let authorizationPause: Promise<void> | null = null
    let signalAuthorizationStarted: (() => void) | null = null
    let installationTokenFailure: Error | null = null
    const github = githubServices({ beforeInstallationToken: async () => {
      if (installationTokenFailure) throw installationTokenFailure
      const pause = authorizationPause
      if (!pause) return
      signalAuthorizationStarted?.()
      await pause
    } })
    let hostedBuildNow = Date.now()
    const editorOrigin = 'https://editor.canvas.test'
    const returnTo = `${editorOrigin}/file/current?pageId=page-1`
    const app = createApiApp({
      auth: auth(),
      store,
      serviceToken,
      repositoryJobServiceToken,
      hostedPreviewBuildServiceToken,
      hostedPreviewWriteSecret,
      assetsOrigin,
      registryFingerprint,
      github: github.services,
      allowedOrigins: [editorOrigin],
      hostedPreviewPublisherServiceToken: hostedPreviewPublisherToken,
      hostedPreviewCapabilitySecret,
      hostedPreviewOrigin,
      hostedPreviewNow: () => hostedBuildNow,
    })
    const rejectedReturn = await app(request('/api/github/installations/start', signed('alpha', 'POST', { returnTo: 'https://attacker.test/file/current' })))
    expect(rejectedReturn.status).toBe(400)
    expect(await body(rejectedReturn)).toEqual({ error: { code: 'invalid_return_url', message: 'Return location is invalid.' } })
    const project = (await body(await app(request('/api/projects', signed('alpha', 'POST', { name: 'Source' }))))).project
    github.persistence.setProjectMembership(project.id, 'user-alpha', 'user-alpha', 'owner')

    const start = async (user: 'alpha' | 'beta') => {
      const response = await app(request('/api/github/installations/start', signed(user, 'POST', { returnTo })))
      expect(response.status).toBe(201)
      const result = await body(response)
      const state = new URL(result.installationUrl).searchParams.get('state')
      expect(state).toMatch(/^[A-Za-z0-9_-]{32,256}$/)
      return state as string
    }
    const callback = (user: 'alpha' | 'beta', state: string, installationId: string) => app(request(`/api/github/installations/callback?setup_action=install&installation_id=${installationId}&state=${encodeURIComponent(state)}`, signed(user)))
    const authorize = async (user: 'alpha' | 'beta', setup: Response) => {
      expect(setup.status).toBe(303)
      const state = new URL(setup.headers.get('Location')!).searchParams.get('state')!
      return app(request(`/api/github/authorization/callback?code=temporary-code-123&state=${encodeURIComponent(state)}`, signed(user)))
    }

    const spoofedState = await start('alpha')
    const spoofed = await authorize('alpha', await callback('alpha', spoofedState, '9999'))
    expect(spoofed.status).toBe(404)
    expect(JSON.stringify(await body(spoofed))).not.toContain(githubRepository.fullName)
    expect((await callback('alpha', spoofedState, '2001')).status).toBe(400)

    const otherUserState = await start('beta')
    const otherUser = await authorize('beta', await callback('beta', otherUserState, '2001'))
    expect(otherUser.status).toBe(404)
    expect(JSON.stringify(await body(otherUser))).not.toContain(githubRepository.fullName)

    const validState = await start('alpha')
    const connected = await authorize('alpha', await callback('alpha', validState, '2001'))
    expect(connected.status).toBe(303)
    expect(connected.headers.get('Location')).toBe(`${returnTo}&github=connected&installationId=2001`)

    const choices = await app(request(`/api/projects/${project.id}/repositories?installationId=2001`, signed('alpha')))
    expect(choices.status).toBe(200)
    expect(await body(choices)).toEqual({ installationId: '2001', repositories: [{ id: '4001', ownerLogin: 'canvas-team', name: 'design-system', fullName: 'canvas-team/design-system', isPrivate: true }] })
    const beforeHiddenChoices = { ...github.providerCalls }
    expect((await app(request(`/api/projects/${project.id}/repositories?installationId=2001`, signed('beta')))).status).toBe(404)
    expect(github.providerCalls).toEqual(beforeHiddenChoices)

    const beforeDenied = { ...github.providerCalls }
    const denied = await app(request(`/api/projects/${project.id}/repository`, signed('beta', 'PUT', { installationId: '2001', repositoryId: '4001' })))
    expect(denied.status).toBe(404)
    expect(await body(denied)).toEqual({ error: { code: 'not_found', message: 'Repository not found.' } })
    expect(github.providerCalls).toEqual(beforeDenied)

    const linked = await app(request(`/api/projects/${project.id}/repository`, signed('alpha', 'PUT', { installationId: '2001', repositoryId: '4001' })))
    expect(linked.status).toBe(200)
    const linkedBody = await body(linked)
    expect(linkedBody).toEqual({ repository: { id: '4001', ownerLogin: 'canvas-team', name: 'design-system', fullName: 'canvas-team/design-system', isPrivate: true }, installationId: '2001' })
    const current = await app(request(`/api/projects/${project.id}/repository`, signed('alpha')))
    expect(current.status).toBe(200)
    expect(await body(current)).toEqual(linkedBody)

    expect((await app(request(`/api/projects/${project.id}/repository/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'write' }) }))).status).toBe(401)
    expect((await app(request(`/api/projects/${project.id}/repository/jobs`, signed('beta', 'POST', { operation: 'write' })))).status).toBe(404)
    const unavailableOperation = await app(request(`/api/projects/${project.id}/repository/jobs`, signed('alpha', 'POST', { operation: 'write' })))
    expect(unavailableOperation.status).toBe(400)
    expect(await body(unavailableOperation)).toEqual({ error: { code: 'invalid_repository_job', message: 'Repository operation is invalid.' } })
    const enqueued = await app(request(`/api/projects/${project.id}/repository/jobs`, signed('alpha', 'POST', { operation: 'scan' })))
    expect(enqueued.status).toBe(202)
    const jobId = (await body(enqueued)).job.id
    expect(await body(await app(request(`/api/projects/${project.id}/repository/scan`, signed('alpha'))))).toEqual({ job: null })
    const internalJob = (path: string, token = repositoryJobServiceToken, payload?: object) => app(request(path, { method: 'POST', headers: { 'X-Canvas-Service-Token': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }))
    expect((await internalJob('/internal/repository-jobs/claim', 'wrong-but-deliberately-similar-token', {})).status).toBe(403)
    expect((await internalJob(`/internal/repository-jobs/${jobId}/start`, serviceToken)).status).toBe(403)
    const started = await internalJob('/internal/repository-jobs/claim', repositoryJobServiceToken, {})
    const startedBody = await body(started)
    expect(startedBody).toMatchObject({ job: { id: jobId, status: 'running', attempt: 1 }, lease: { id: expect.any(String), expiresAt: expect.any(Number) }, access: { contentsPermission: 'read' } })
    expect(await body(await internalJob('/internal/repository-jobs/claim', repositoryJobServiceToken, {}))).toEqual({ job: null })
    expect((await internalJob(`/internal/repository-jobs/${jobId}/authorize-write`, serviceToken)).status).toBe(401)
    const sourceHash = 'b'.repeat(64)
    const componentId = 'shadcn:Button:8f9171d59b1041d3'
    const artifact = {
      sourceRevision: 'a'.repeat(40),
      scan: { adapterId: 'shadcn-v1', configs: [], components: [{ path: 'src/button.tsx', exportName: 'Button', packageName: '@acme/ui', declarationKind: 'function', props: [], slots: [], sourceHash, fingerprint: 'c'.repeat(64) }], tokens: [], sourceHashes: { 'src/button.tsx': sourceHash }, diagnostics: [] },
      request: { version: 1, entry: { componentId }, components: [{ componentId, entryPath: 'src/button.tsx', exportName: 'Button', integrity: `sha256-${Buffer.from(sourceHash, 'hex').toString('base64')}`, props: {}, slots: [] }], styles: [] },
    }
    expect((await internalJob(`/internal/repository-jobs/${jobId}/complete`, repositoryJobServiceToken, { leaseId: startedBody.lease.id, result: { sourceRevision: 'a'.repeat(40), scan: { adapterId: 'shadcn-v1' }, request: { version: 1 } } })).status).toBe(400)
    expect((await internalJob(`/internal/repository-jobs/${jobId}/complete`, repositoryJobServiceToken, { leaseId: crypto.randomUUID(), result: artifact })).status).toBe(404)
    const completed = await internalJob(`/internal/repository-jobs/${jobId}/complete`, repositoryJobServiceToken, { leaseId: startedBody.lease.id, result: artifact })
    expect(completed.status).toBe(200)
    expect(await body(completed)).toEqual({ job: { id: jobId, operation: 'scan', status: 'completed', attempt: 1 } })
    const otherProject = (await body(await app(request('/api/projects', signed('alpha', 'POST', { name: 'Other source' }))))).project
    github.persistence.setProjectMembership(otherProject.id, 'user-alpha', 'user-alpha', 'owner')
    expect((await app(request(`/api/projects/${otherProject.id}/repository`, signed('alpha', 'PUT', { installationId: '2001', repositoryId: '4001' })))).status).toBe(200)
    const otherEnqueued = await app(request(`/api/projects/${otherProject.id}/repository/jobs`, signed('alpha', 'POST', { operation: 'scan' })))
    expect(otherEnqueued.status).toBe(202)
    const otherJobId = (await body(otherEnqueued)).job.id
    const otherStartedBody = await body(await internalJob('/internal/repository-jobs/claim', repositoryJobServiceToken, {}))
    expect(otherStartedBody.job.id).toBe(otherJobId)
    expect((await internalJob(`/internal/repository-jobs/${otherJobId}/complete`, repositoryJobServiceToken, { leaseId: otherStartedBody.lease.id, result: artifact })).status).toBe(200)
    const visibleResult = await app(request(`/api/repository-jobs/${jobId}`, signed('alpha')))
    expect(visibleResult.status).toBe(200)
    expect(await body(visibleResult)).toMatchObject({ job: { id: jobId, status: 'completed', result: artifact } })
    const latestResult = await app(request(`/api/projects/${project.id}/repository/scan`, signed('alpha')))
    expect(latestResult.status).toBe(200)
    expect(await body(latestResult)).toMatchObject({ job: { id: jobId, status: 'completed', result: artifact } })
    expect((await app(request(`/api/projects/${project.id}/repository/scan`, signed('beta')))).status).toBe(404)
    expect((await app(request(`/api/repository-jobs/${jobId}`, signed('beta')))).status).toBe(404)

    const sourceBindingsPath = `/api/projects/${project.id}/repository/source-bindings`
    expect((await app(request(sourceBindingsPath))).status).toBe(401)
    expect((await app(request(sourceBindingsPath, signed('beta')))).status).toBe(404)
    expect(await body(await app(request(sourceBindingsPath, signed('alpha'))))).toBeNull()
    const initialBindingCommand = { scanJobId: jobId, expectedVersion: null, expectedAuthority: null, rebinds: [] }
    const unsupportedMedia = await app(request(sourceBindingsPath, { method: 'PUT', headers: { Authorization: 'Bearer alpha', 'Content-Type': 'text/plain' }, body: '{}' }))
    expect(unsupportedMedia.status).toBe(415)
    expect(await body(unsupportedMedia)).toEqual({ error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' } })
    const declaredOversized = await app(request(sourceBindingsPath, { method: 'PUT', headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json', 'Content-Length': String(5 * 1024 * 1024 + 1) }, body: '{}' }))
    expect(declaredOversized.status).toBe(413)
    expect(await body(declaredOversized)).toEqual({ error: { code: 'payload_too_large', message: 'Request is too large.' } })
    const actualOversized = await app(request(sourceBindingsPath, { method: 'PUT', headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...initialBindingCommand, padding: 'x'.repeat(5 * 1024 * 1024) }) }))
    expect(actualOversized.status).toBe(413)
    expect(await body(actualOversized)).toEqual({ error: { code: 'payload_too_large', message: 'Request is too large.' } })
    const malformedJson = await app(request(sourceBindingsPath, { method: 'PUT', headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json' }, body: '{' }))
    expect(malformedJson.status).toBe(400)
    expect(await body(malformedJson)).toEqual({ error: { code: 'invalid_json', message: 'Request body is invalid JSON.' } })
    const invalidCommand = await app(request(sourceBindingsPath, signed('alpha', 'PUT', { scanJobId: jobId })))
    expect(invalidCommand.status).toBe(400)
    expect(await body(invalidCommand)).toEqual({ error: { code: 'invalid_source_bindings', message: 'Source binding request is invalid.' } })
    const malformedRebind = await app(request(sourceBindingsPath, signed('alpha', 'PUT', { ...initialBindingCommand, rebinds: [{ bindingId: 'missing-fields' }] })))
    expect(malformedRebind.status).toBe(400)
    expect(await body(malformedRebind)).toEqual({ error: { code: 'invalid_source_bindings', message: 'Source binding request is invalid.' } })
    for (const injected of [
      { unknown: true },
      { installationId: '2001' },
      { repositoryId: '4001' },
      { repositoryGrantId: crypto.randomUUID() },
      { repositoryGrantGeneration: 1 },
      { tenantId: 'user-alpha' },
      { allocations: [] },
    ]) {
      const rejected = await app(request(sourceBindingsPath, signed('alpha', 'PUT', { ...initialBindingCommand, ...injected })))
      expect(rejected.status).toBe(400)
      expect(await body(rejected)).toEqual({ error: { code: 'invalid_source_bindings', message: 'Source binding request is invalid.' } })
    }
    const wrongScan = await app(request(sourceBindingsPath, signed('alpha', 'PUT', { ...initialBindingCommand, scanJobId: otherJobId })))
    expect(wrongScan.status).toBe(404)
    expect(await body(wrongScan)).toEqual({ error: { code: 'not_found', message: 'Repository not found.' } })
    const reconciledBindings = await app(request(sourceBindingsPath, signed('alpha', 'PUT', initialBindingCommand)))
    expect(reconciledBindings.status).toBe(200)
    const bindingSnapshot = await body(reconciledBindings)
    expect(Object.keys(bindingSnapshot).sort()).toEqual(['authority', 'records', 'updatedAt', 'version'])
    expect(bindingSnapshot).toMatchObject({ version: 1, authority: { repository: { provider: 'github', projectId: project.id, repositoryId: '4001' }, scanId: jobId, grantGeneration: 1 }, records: [{ status: 'bound' }] })
    expect(await body(await app(request(sourceBindingsPath, signed('alpha'))))).toEqual(bindingSnapshot)
    let roleSnapshot = bindingSnapshot
    for (const role of ['owner', 'editor', 'reviewer', 'viewer'] as const) {
      github.persistence.setProjectMembership(project.id, 'user-alpha', 'user-alpha', role)
      expect((await app(request(sourceBindingsPath, signed('alpha')))).status).toBe(200)
      const roleReconcile = await app(request(sourceBindingsPath, signed('alpha', 'PUT', { scanJobId: jobId, expectedVersion: roleSnapshot.version, expectedAuthority: roleSnapshot.authority, rebinds: [] })))
      expect(roleReconcile.status).toBe(200)
      roleSnapshot = await body(roleReconcile)
    }
    github.persistence.setProjectMembership(project.id, 'other-tenant', 'user-beta', 'viewer')
    expect((await app(request(sourceBindingsPath, signed('beta')))).status).toBe(404)
    github.persistence.removeProjectMembership(project.id, 'user-alpha')
    expect((await app(request(sourceBindingsPath, signed('alpha')))).status).toBe(404)
    const revokedMembershipWrite = await app(request(sourceBindingsPath, signed('alpha', 'PUT', { scanJobId: jobId, expectedVersion: roleSnapshot.version, expectedAuthority: roleSnapshot.authority, rebinds: [] })))
    expect(revokedMembershipWrite.status).toBe(404)
    expect(await body(revokedMembershipWrite)).toEqual({ error: { code: 'not_found', message: 'Repository not found.' } })
    github.persistence.setProjectMembership(project.id, 'user-alpha', 'user-alpha', 'owner')
    const staleVersion = await app(request(sourceBindingsPath, signed('alpha', 'PUT', initialBindingCommand)))
    expect(staleVersion.status).toBe(409)
    expect(await body(staleVersion)).toEqual({ error: { code: 'source_bindings_changed', message: 'Repository source bindings changed.' } })
    const staleAuthority = await app(request(sourceBindingsPath, signed('alpha', 'PUT', { ...initialBindingCommand, expectedVersion: roleSnapshot.version, expectedAuthority: { ...roleSnapshot.authority, sourceRevision: 'f'.repeat(40) } })))
    expect(staleAuthority.status).toBe(409)
    expect(await body(staleAuthority)).toEqual({ error: { code: 'source_bindings_changed', message: 'Repository source bindings changed.' } })

    const file = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Hosted preview', projectId: project.id }))))).file
    expect((await app(request(`/api/files/${file.id}/hosted-preview-builds`, signed('beta', 'POST', {})))).status).toBe(404)
    const docsAdapter = {
      version: 1,
      renderer: 'blume',
      layout: { docsDirectory: 'apps/docs/content/docs/components', examplesDirectory: 'apps/docs/registry/comp', metaPath: 'apps/docs/content/docs/components/meta.ts', manifestPath: 'apps/docs/registry/comp/components.json' },
      components: [],
    }
    const docsReview = await app(request(`/api/projects/${project.id}/repository/docs/reviews`, signed('alpha', 'POST', { fileId: file.id, fileRevision: 0, scanJobId: jobId })))
    expect(docsReview.status).toBe(202)
    const docsReviewBody = await body(docsReview)
    expect(docsReviewBody).toMatchObject({ review: { projectId: project.id, fileId: file.id, fileRevision: 0, status: 'queued_prepare', baseRef: 'refs/heads/main', baseCommitSha: artifact.sourceRevision, approvalDigest: null, preparedBundle: null, committedSha: null } })
    const docsReviewId = docsReviewBody.review.id
    expect(await body(await app(request(`/api/repository-doc-reviews/${docsReviewId}`, signed('alpha'))))).toEqual(docsReviewBody)
    expect(await body(await app(request(`/api/projects/${project.id}/repository/docs/reviews?fileId=${file.id}`, signed('alpha'))))).toEqual(docsReviewBody)
    expect((await app(request(`/api/projects/${project.id}/repository/docs/reviews`, signed('alpha', 'POST', { fileId: file.id, fileRevision: 0, scanJobId: jobId, adapter: docsAdapter })))).status).toBe(400)
    expect((await internalJob('/internal/repository-doc-reviews/claim-prepare', 'wrong-but-deliberately-similar-token', {})).status).toBe(403)
    const docsClaim = await body(await internalJob('/internal/repository-doc-reviews/claim-prepare', repositoryJobServiceToken, {}))
    expect(docsClaim).toMatchObject({ review: { id: docsReviewId, fileId: file.id, scanJobId: jobId, leaseId: expect.any(String), document: { schemaVersion: 13 }, scan: artifact } })
    const docsLeaseId = docsClaim.review.leaseId
    const sourceResponse = await internalJob(`/internal/repository-doc-reviews/${docsReviewId}/source`, repositoryJobServiceToken, { leaseId: docsLeaseId })
    expect(sourceResponse.status).toBe(200)
    expect(sourceResponse.headers.get('Content-Type')).toBe('application/gzip')
    const docsBundle = {
      version: 1,
      projectId: project.id,
      fileId: file.id,
      fileRevision: 0,
      fileDocumentSha256: docsClaim.review.fileDocumentSha256,
      scanJobId: jobId,
      installationId: '2001',
      repositoryId: '4001',
      repositoryGrantId: docsClaim.review.repositoryGrantId,
      repositoryLinkedAt: docsClaim.review.repositoryLinkedAt,
      baseRef: 'refs/heads/main',
      baseCommitSha: artifact.sourceRevision,
      baseTreeSha: 'e'.repeat(40),
      adapter: docsAdapter,
      files: [{ path: 'apps/docs/content/docs/components/meta.ts', beforeSha256: null, after: 'export default {}\n', diff: '+export default {}\n' }],
      omissions: [],
      validation: [{ name: 'Documentation build', detail: 'The staged documentation candidate built successfully.' }],
    }
    const docsCompleted = await body(await internalJob(`/internal/repository-doc-reviews/${docsReviewId}/complete-prepare`, repositoryJobServiceToken, { leaseId: docsLeaseId, bundle: docsBundle }))
    expect(docsCompleted).toMatchObject({ review: { id: docsReviewId, status: 'prepared', approvalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect((await app(request(`/api/repository-doc-reviews/${docsReviewId}/save`, signed('alpha', 'POST', { approvalDigest: 'f'.repeat(64) })))).status).toBe(404)
    const docsApproved = await app(request(`/api/repository-doc-reviews/${docsReviewId}/save`, signed('alpha', 'POST', { approvalDigest: docsCompleted.review.approvalDigest })))
    expect(docsApproved.status).toBe(202)
    expect(await body(docsApproved)).toMatchObject({ review: { id: docsReviewId, status: 'queued_save', approvalDigest: docsCompleted.review.approvalDigest } })
    expect((await internalJob('/internal/repository-doc-reviews/claim-save', 'wrong-but-deliberately-similar-token', {})).status).toBe(403)
    const docsSaveClaim = await body(await internalJob('/internal/repository-doc-reviews/claim-save', repositoryJobServiceToken, {}))
    expect(docsSaveClaim).toMatchObject({
      review: { id: docsReviewId, leaseId: expect.any(String), repositoryId: '4001', baseCommitSha: artifact.sourceRevision, preparedBundle: docsBundle },
      access: { contentsPermission: 'write', token: 'ghs_test_write' },
    })
    const docsSaveLeaseId = docsSaveClaim.review.leaseId
    const proposedCommitSha = 'f'.repeat(40)
    expect(await body(await internalJob(`/internal/repository-doc-reviews/${docsReviewId}/proposed-commit`, repositoryJobServiceToken, { leaseId: docsSaveLeaseId, proposedCommitSha }))).toEqual({ review: { id: docsReviewId, status: 'saving', proposedCommitSha } })
    expect((await internalJob(`/internal/repository-doc-reviews/${docsReviewId}/complete-save`, repositoryJobServiceToken, { leaseId: docsSaveLeaseId, committedSha: '0'.repeat(40) })).status).toBe(404)
    expect(await body(await internalJob(`/internal/repository-doc-reviews/${docsReviewId}/complete-save`, repositoryJobServiceToken, { leaseId: docsSaveLeaseId, committedSha: proposedCommitSha }))).toEqual({ review: { id: docsReviewId, status: 'saved', committedSha: proposedCommitSha } })
    expect(await body(await app(request(`/api/repository-doc-reviews/${docsReviewId}`, signed('alpha'))))).toMatchObject({ review: { id: docsReviewId, status: 'saved', committedSha: proposedCommitSha } })
    for (const suppliedIdentity of [
      { repositoryId: githubRepository.id },
      { scanJobId: jobId },
      { fileRevision: 0 },
      { artifactId: crypto.randomUUID() },
      { stagingId: crypto.randomUUID() },
      { leaseId: crypto.randomUUID() },
    ]) {
      expect((await app(request(`/api/files/${file.id}/hosted-preview-builds`, signed('alpha', 'POST', suppliedIdentity)))).status).toBe(400)
    }
    const buildEnqueued = await app(request(`/api/files/${file.id}/hosted-preview-builds`, signed('alpha', 'POST', {})))
    expect(buildEnqueued.status).toBe(202)
    const buildJob = (await body(buildEnqueued)).job
    expect(buildJob).toMatchObject({ fileId: file.id, fileRevision: 0, status: 'queued', attempts: 0 })
    expect(buildJob).not.toHaveProperty('artifactId')
    const sameBuild = await body(await app(request(`/api/files/${file.id}/hosted-preview-builds`, signed('alpha', 'POST', {}))))
    expect(sameBuild.job.id).toBe(buildJob.id)

    expect((await internalJob('/internal/hosted-preview-builds/claim', repositoryJobServiceToken, {})).status).toBe(403)
    expect((await internalJob('/internal/repository-jobs/claim', hostedPreviewBuildServiceToken, {})).status).toBe(403)
    let releaseAuthorization!: () => void
    authorizationPause = new Promise<void>(resolve => { releaseAuthorization = resolve })
    const authorizationStarted = new Promise<void>(resolve => { signalAuthorizationStarted = resolve })
    const staleClaimPromise = internalJob('/internal/hosted-preview-builds/claim', hostedPreviewBuildServiceToken, {})
    await authorizationStarted
    hostedBuildNow += 5 * 60_000
    authorizationPause = null
    signalAuthorizationStarted = null
    const buildClaim = await body(await internalJob('/internal/hosted-preview-builds/claim', hostedPreviewBuildServiceToken, {}))
    releaseAuthorization()
    expect(await body(await staleClaimPromise)).toEqual({ job: null })
    expect(buildClaim).toMatchObject({
      job: {
        id: buildJob.id,
        fileId: file.id,
        fileRevision: 0,
        projectId: project.id,
        scanJobId: jobId,
        artifactId: expect.any(String),
        stagingId: expect.any(String),
        status: 'leased',
        attempts: 2,
      },
      lease: { id: expect.any(String), expiresAt: expect.any(String) },
      repository: { repositoryId: githubRepository.id },
      access: { contentsPermission: 'read' },
      scan: artifact,
      artifactAccess: { origin: assetsOrigin, token: expect.any(String), expiresAt: expect.any(Number) },
    })
    await expect(verifyHostedPreviewWriteCapability({
      jobId: buildClaim.job.id,
      leaseId: buildClaim.lease.id,
      artifactId: buildClaim.job.artifactId,
      stagingId: buildClaim.job.stagingId,
      audience: assetsOrigin,
      secret: hostedPreviewWriteSecret,
      token: buildClaim.artifactAccess.token,
      now: Math.floor(hostedBuildNow / 1000),
    })).resolves.toMatchObject({ artifactId: buildClaim.job.artifactId, stagingId: buildClaim.job.stagingId })
    expect((await internalJob(`/internal/hosted-preview-builds/${buildJob.id}/complete`, repositoryJobServiceToken, { leaseId: buildClaim.lease.id })).status).toBe(403)
    expect((await internalJob(`/internal/hosted-preview-builds/${buildJob.id}/complete`, hostedPreviewBuildServiceToken, { leaseId: crypto.randomUUID() })).status).toBe(404)
    expect((await internalJob(`/internal/hosted-preview-builds/${buildJob.id}/complete`, hostedPreviewBuildServiceToken, { leaseId: buildClaim.lease.id })).status).toBe(404)
    expect((await app(request('/internal/hosted-previews/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Hosted-Preview-Publisher-Token': hostedPreviewPublisherToken },
      body: JSON.stringify({
        artifactId: buildClaim.job.artifactId,
        fileId: file.id,
        fileRevision: 0,
        sourceRevision: artifact.sourceRevision,
        registryFingerprint: `sha256:${'d'.repeat(64)}`,
        entrypoint: 'index.html',
      }),
    }))).status).toBe(201)
    expect((await internalJob(`/internal/hosted-preview-builds/${buildJob.id}/complete`, hostedPreviewBuildServiceToken, { leaseId: buildClaim.lease.id })).status).toBe(200)
    const completedBuild = await body(await app(request(`/api/hosted-preview-builds/${buildJob.id}`, signed('alpha'))))
    expect(completedBuild.job).toMatchObject({ id: buildJob.id, status: 'completed', artifactId: expect.any(String), completedAt: expect.any(String) })
    expect((await app(request(`/api/hosted-preview-builds/${buildJob.id}`, signed('beta')))).status).toBe(404)
    const transientFile = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Transient preview', projectId: project.id }))))).file
    const transientJob = (await body(await app(request(`/api/files/${transientFile.id}/hosted-preview-builds`, signed('alpha', 'POST', {}))))).job
    installationTokenFailure = new TypeError('fetch failed')
    expect((await internalJob('/internal/hosted-preview-builds/claim', hostedPreviewBuildServiceToken, {})).status).toBe(500)
    expect((await body(await app(request(`/api/hosted-preview-builds/${transientJob.id}`, signed('alpha'))))).job).toMatchObject({ id: transientJob.id, status: 'queued', attempts: 1 })
    installationTokenFailure = null
    hostedBuildNow += 2_000
    const recoveredTransientClaim = await body(await internalJob('/internal/hosted-preview-builds/claim', hostedPreviewBuildServiceToken, {}))
    expect(recoveredTransientClaim.job).toMatchObject({ id: transientJob.id, status: 'leased', attempts: 2 })
    expect((await internalJob(`/internal/hosted-preview-builds/${transientJob.id}/fail`, hostedPreviewBuildServiceToken, { leaseId: recoveredTransientClaim.lease.id, errorId: 'test-finished' })).status).toBe(200)
    const retryFile = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Retry preview', projectId: project.id }))))).file
    const retryBuildJob = (await body(await app(request(`/api/files/${retryFile.id}/hosted-preview-builds`, signed('alpha', 'POST', {}))))).job
    const retryClaim = await body(await internalJob('/internal/hosted-preview-builds/claim', hostedPreviewBuildServiceToken, {}))
    expect(retryClaim.job.id).toBe(retryBuildJob.id)
    expect((await internalJob(`/internal/hosted-preview-builds/${retryBuildJob.id}/fail`, hostedPreviewBuildServiceToken, { leaseId: retryClaim.lease.id, errorId: 'builder-failed' })).status).toBe(200)
    const requeued = await body(await app(request(`/api/files/${retryFile.id}/hosted-preview-builds`, signed('alpha', 'POST', {}))))
    expect(requeued.job).toMatchObject({ id: retryBuildJob.id, status: 'queued', attempts: 1 })
    const secondRetryClaim = await body(await internalJob('/internal/hosted-preview-builds/claim', hostedPreviewBuildServiceToken, {}))
    expect(secondRetryClaim.job).toMatchObject({ id: retryBuildJob.id, status: 'leased', attempts: 2 })
    expect((await app(request('/internal/hosted-previews/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Hosted-Preview-Publisher-Token': hostedPreviewPublisherToken },
      body: JSON.stringify({
        artifactId: secondRetryClaim.job.artifactId,
        fileId: retryFile.id,
        fileRevision: 0,
        sourceRevision: artifact.sourceRevision,
        registryFingerprint: `sha256:${'e'.repeat(64)}`,
        entrypoint: 'index.html',
      }),
    }))).status).toBe(201)
    expect((await internalJob(`/internal/hosted-preview-builds/${retryBuildJob.id}/complete`, hostedPreviewBuildServiceToken, { leaseId: secondRetryClaim.lease.id })).status).toBe(200)
    const secondFile = (await body(await app(request('/api/files', signed('alpha', 'POST', { name: 'Revoked preview', projectId: project.id }))))).file
    const revokedBuildJob = (await body(await app(request(`/api/files/${secondFile.id}/hosted-preview-builds`, signed('alpha', 'POST', {}))))).job

    const webhookBody = JSON.stringify({ action: 'suspend', installation: { id: 2001 } })
    const signature = `sha256=${createHmac('sha256', githubWebhookSecret).update(webhookBody).digest('hex')}`
    const webhook = (suppliedSignature: string) => app(request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'X-GitHub-Delivery': 'delivery-1001', 'X-GitHub-Event': 'installation', 'X-Hub-Signature-256': suppliedSignature },
      body: webhookBody,
    }))
    expect((await webhook(`sha256=${'0'.repeat(64)}`)).status).toBe(401)
    expect((await webhook(signature)).status).toBe(202)
    expect((await webhook(signature)).status).toBe(409)
    const invalidated = await app(request(`/api/projects/${project.id}/repository`, signed('alpha')))
    expect(invalidated.status).toBe(404)
    expect((await app(request(`/api/projects/${project.id}/repository/scan`, signed('alpha')))).status).toBe(404)
    expect((await app(request(sourceBindingsPath, signed('alpha')))).status).toBe(404)
    expect((await internalJob('/internal/hosted-preview-builds/claim', hostedPreviewBuildServiceToken, {})).status).toBe(404)
    const revokedBuild = await body(await app(request(`/api/hosted-preview-builds/${revokedBuildJob.id}`, signed('alpha'))))
    expect(revokedBuild.job).toMatchObject({ status: 'failed', errorId: 'repository-access-changed', failedAt: expect.any(String) })
    expect(JSON.stringify(await body(invalidated))).not.toContain(githubRepository.fullName)
  })

  it('COMP-V2-BINDING-001 keeps malformed persisted bindings behind the generic request-id error boundary', async () => {
    const store = createMemoryControlPlane()
    const github = githubServices()
    const project = await store.createProject(users.alpha.id, 'Malformed bindings')
    github.persistence.setProjectMembership(project.id, users.alpha.id, users.alpha.id, 'owner')
    const reportError = vi.fn()
    const sourceBindings = Object.freeze({
      async get() { throw new Error('persisted binding contained private-repository-name') },
      async reconcile() { throw new Error('persisted binding contained private-repository-name') },
    }) as unknown as HostedSourceBindingService
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, github: Object.freeze({ ...github.services, sourceBindings }), reportError })
    const response = await app(request(`/api/projects/${project.id}/repository/source-bindings`, signed('alpha')))
    expect(response.status).toBe(500)
    expect(await body(response)).toEqual({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } })
    expect(reportError).toHaveBeenCalledOnce()
  })

  it('AT-GHAPP-001 AT-AUTH-003 hides source bindings after independent repository and installation revocation', async () => {
    for (const revoked of ['repository', 'installation'] as const) {
      const store = createMemoryControlPlane()
      const github = githubServices()
      const project = await store.createProject(users.alpha.id, `Revoked ${revoked}`)
      github.persistence.setProjectMembership(project.id, users.alpha.id, users.alpha.id, 'owner')
      const connectedAt = Date.now()
      await github.persistence.grants.saveInstallationGrant({
        tenantId: users.alpha.id,
        installation: githubInstallation,
        connectedByAccountId: users.alpha.id,
        connectedAt,
      })
      await github.persistence.grants.saveRepositoryGrant({
        grantId: crypto.randomUUID(),
        tenantId: users.alpha.id,
        projectId: project.id,
        installationId: githubInstallation.id,
        repository: githubRepository,
        linkedByAccountId: users.alpha.id,
        linkedAt: connectedAt,
      })
      const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, github: github.services })
      const path = `/api/projects/${project.id}/repository/source-bindings`
      expect(await body(await app(request(path, signed('alpha'))))).toBeNull()

      if (revoked === 'repository') {
        await github.persistence.grants.invalidateRepositories({ installationId: githubInstallation.id, repositoryIds: [githubRepository.id], reason: 'removed', invalidatedAt: connectedAt + 1 })
      } else {
        await github.persistence.grants.invalidateInstallation({ installationId: githubInstallation.id, reason: 'deleted', invalidatedAt: connectedAt + 1 })
      }

      for (const init of [
        signed('alpha'),
        signed('alpha', 'PUT', { scanJobId: crypto.randomUUID(), expectedVersion: null, expectedAuthority: null, rebinds: [] }),
      ]) {
        const response = await app(request(path, init))
        expect(response.status).toBe(404)
        expect(await body(response)).toEqual({ error: { code: 'not_found', message: 'Repository not found.' } })
      }
    }
  })

  it('COMP-V2-BINDING-001 transports checked rebind success and conflicts without exposing current state', async () => {
    const store = createMemoryControlPlane()
    const github = githubServices()
    const project = await store.createProject(users.alpha.id, 'Checked rebind transport')
    github.persistence.setProjectMembership(project.id, users.alpha.id, users.alpha.id, 'owner')
    const authority = { repository: { provider: 'github' as const, projectId: project.id, repositoryId: '4001' }, scanId: crypto.randomUUID(), sourceRevision: 'a'.repeat(40), registryFingerprint: `sha256:${'b'.repeat(64)}`, grantGeneration: 1, adapterId: 'shadcn-v1' }
    const priorEvidence = { symbolKey: 'button-prior', packageName: '@acme/ui', path: 'src/button.tsx', exportName: 'Button', sourceHash: 'c'.repeat(64), fingerprint: 'd'.repeat(64) }
    const replacement = { ...priorEvidence, symbolKey: 'button-moved', path: 'src/moved-button.tsx', exportName: 'MovedButton', sourceHash: 'e'.repeat(64) }
    const reconcile = vi.fn(async (input: { rebinds: readonly { bindingId: string }[] }) => {
      const bindingId = input.rebinds[0]?.bindingId
      if (bindingId !== 'binding-success') throw new HostedSourceBindingConflictError('Repository source bindings changed.')
      return { version: 2, authority, records: [{ id: bindingId, repository: authority.repository, authority, evidence: replacement, status: 'bound' as const }], updatedAt: 1_800_000_000_000 }
    })
    const sourceBindings = Object.freeze({ async get() { return null }, reconcile }) as unknown as HostedSourceBindingService
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, github: Object.freeze({ ...github.services, sourceBindings }) })
    const path = `/api/projects/${project.id}/repository/source-bindings`
    const command = (bindingId: string) => ({
      scanJobId: authority.scanId,
      expectedVersion: 1,
      expectedAuthority: authority,
      rebinds: [{ bindingId, expectedAuthority: authority, expectedEvidence: priorEvidence, nextSymbolKey: replacement.symbolKey }],
    })
    const success = await app(request(path, signed('alpha', 'PUT', command('binding-success'))))
    expect(success.status).toBe(200)
    expect(await body(success)).toMatchObject({ version: 2, records: [{ id: 'binding-success', evidence: replacement, status: 'bound' }] })
    for (const bindingId of ['binding-stale-evidence', 'binding-ineligible', 'binding-non-unique']) {
      const conflict = await app(request(path, signed('alpha', 'PUT', command(bindingId))))
      expect(conflict.status).toBe(409)
      expect(await body(conflict)).toEqual({ error: { code: 'source_bindings_changed', message: 'Repository source bindings changed.' } })
    }
    const malformed = await app(request(path, signed('alpha', 'PUT', { ...command('binding-success'), rebinds: [{ bindingId: 'binding-success' }] })))
    expect(malformed.status).toBe(400)
    expect(await body(malformed)).toEqual({ error: { code: 'invalid_source_bindings', message: 'Source binding request is invalid.' } })
    for (const injected of [
      { replacement },
      { path: replacement.path },
      { exportName: replacement.exportName },
      { sourceHash: replacement.sourceHash },
      { fingerprint: replacement.fingerprint },
    ]) {
      const rejected = await app(request(path, signed('alpha', 'PUT', {
        ...command('binding-success'),
        rebinds: [{ ...command('binding-success').rebinds[0], ...injected }],
      })))
      expect(rejected.status).toBe(400)
      expect(await body(rejected)).toEqual({ error: { code: 'invalid_source_bindings', message: 'Source binding request is invalid.' } })
    }
    const unsupported = await app(request(path, signed('alpha', 'POST', command('binding-success'))))
    expect(unsupported.status).toBe(404)
    expect(await body(unsupported)).toEqual({ error: { code: 'not_found', message: 'Route not found.' } })
    expect(reconcile).toHaveBeenCalledTimes(4)
  })

  it('rejects untrusted browser origins before auth or data access', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint, allowedOrigins: ['https://login.canvas.test'] })
    const response = await app(request('/api/session', { headers: { Origin: 'https://attacker.test', Authorization: 'Bearer alpha' } }))
    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
