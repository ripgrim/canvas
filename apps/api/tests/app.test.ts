import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { HostedAuth, HostedSessionUser } from '@canvas/auth/server'
import { createMemoryGitHubPersistence } from '@canvas/database/github'
import { createMemoryControlPlane } from '@canvas/database/memory'
import { GitHubGrantService, GitHubWebhookService, InstallationStateService, RepositoryJobService, type GitHubActor, type GitHubProviderPort } from '@canvas/github-app'
import { createApiApp } from '../src/app'
import { parseGitHubUserTokenPayload, type GitHubApiServices } from '../src/github'

const serviceToken = '0123456789abcdef0123456789abcdef'
const thumbnailServiceToken = 'abcdef0123456789abcdef0123456789'
const registryFingerprint = `sha256-${'A'.repeat(43)}=`
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
  schemaVersion: 9,
  fileId,
  revision,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
})

const githubInstallation = Object.freeze({ id: '2001', account: Object.freeze({ id: '3001', login: 'canvas-team', type: 'Organization' as const }), contentsPermission: 'write' as const })
const githubRepository = Object.freeze({ id: '4001', installationId: '2001', ownerId: '3001', ownerLogin: 'canvas-team', name: 'design-system', fullName: 'canvas-team/design-system', isPrivate: true, contentsPermission: 'write' as const })
const githubWebhookSecret = 'github-webhook-secret-with-enough-entropy'

function githubServices(input: Readonly<{ provider?: GitHubProviderPort }> = {}) {
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
  })
  const states = new InstallationStateService(persistence.states)
  const grants = new GitHubGrantService(provider, persistence.grants, states, persistence.projectAuthorization)
  const services: GitHubApiServices = Object.freeze({
    states,
    grants,
    webhooks: new GitHubWebhookService(githubWebhookSecret, persistence.deliveries, persistence.grants),
    jobs: new RepositoryJobService(grants, persistence.jobs, { async mint(input) { return { token: `ghs_test_${input.contentsPermission}`, expiresAt: Date.now() + 60_000, contentsPermission: input.contentsPermission } } }),
    async resolveActor(user) {
      return user.id === 'user-alpha'
        ? { accountId: user.id, providerUserId: '1001' }
        : user.id === 'user-beta' ? { accountId: user.id, providerUserId: '1002' } : null
    },
    async authorizeUser(input) { return input.accountId === 'user-alpha' ? { accountId: input.accountId, providerUserId: '1001' } : { accountId: input.accountId, providerUserId: '1002' } },
    async issueAuthorization(input) {
      const issued = await states.issue({ accountId: input.accountId, tenantId: input.tenantId, purpose: 'authorize-user', installationId: input.installationId, codeVerifierCiphertext: 'encrypted-verifier' })
      return { authorizationUrl: `https://github.com/login/oauth/authorize?state=${encodeURIComponent(issued.state)}`, expiresAt: issued.expiresAt }
    },
    resolveProjectTenant(projectId, userId) { return persistence.projectTenancy.resolveTenantForMember(projectId, userId) },
    installationUrl(state) { return `https://github.com/apps/comp-canvas/installations/new?state=${encodeURIComponent(state)}` },
  })
  return { persistence, providerCalls, services }
}

describe('hosted control-plane API', () => {
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
    expect(initial).toMatchObject({ fileId: file.id, revision: 0, document: { schemaVersion: 9, fileId: file.id, revision: 0, pages: [{ name: 'Page 1' }], theme: { tokens: {} } } })
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
    const legacy = { ...fileDocument(file.id, 1), schemaVersion: 6 }
    expect((await store.saveFileDocument(users.alpha.id, file.id, 0, legacy)).status).toBe('saved')
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint })

    const response = await app(request(`/api/files/${file.id}/document`, signed('alpha')))

    expect(response.status).toBe(200)
    expect(await body(response)).toMatchObject({ fileId: file.id, revision: 1, document: { schemaVersion: 9, fileId: file.id, revision: 1 } })
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
      { ...fileDocument(file.id), nodes: { 'root-1': { id: 'root-1', type: 'root' }, box: { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 0, top: 0, width: -1, height: 10 } } }, relationships: { box: { parentId: 'root-1', orderKey: 'V' } } },
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
    expect(sourceBody).toMatchObject({ fileId: file.id, revision: 0, registryFingerprint, document: { schemaVersion: 9, fileId: file.id, revision: 0 } })
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
    const github = githubServices()
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, github: github.services })
    const project = (await body(await app(request('/api/projects', signed('alpha', 'POST', { name: 'Source' }))))).project
    github.persistence.setProjectMembership(project.id, 'user-alpha', 'user-alpha', 'owner')

    const start = async (user: 'alpha' | 'beta') => {
      const response = await app(request('/api/github/installations/start', signed(user, 'POST')))
      expect(response.status).toBe(201)
      const result = await body(response)
      const state = new URL(result.installationUrl).searchParams.get('state')
      expect(state).toMatch(/^[A-Za-z0-9_-]{32,256}$/)
      return state as string
    }
    const callback = (user: 'alpha' | 'beta', state: string, installationId: string) => app(request(`/api/github/installations/callback?setup_action=install&installation_id=${installationId}&state=${encodeURIComponent(state)}`, signed(user)))
    const authorize = async (user: 'alpha' | 'beta', setup: Response) => {
      expect(setup.status).toBe(200)
      const state = new URL((await body(setup)).authorizationUrl).searchParams.get('state')!
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
    expect(connected.status).toBe(200)
    expect(await body(connected)).toEqual({ installation: { id: '2001', account: githubInstallation.account } })

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
    const enqueued = await app(request(`/api/projects/${project.id}/repository/jobs`, signed('alpha', 'POST', { operation: 'write' })))
    expect(enqueued.status).toBe(202)
    const jobId = (await body(enqueued)).job.id
    const internalJob = (path: string, token = serviceToken) => app(request(path, { method: 'POST', headers: { 'X-Canvas-Service-Token': token } }))
    expect((await internalJob(`/internal/repository-jobs/${jobId}/start`, 'wrong-but-deliberately-similar-token')).status).toBe(403)
    const started = await internalJob(`/internal/repository-jobs/${jobId}/start`)
    expect(await body(started)).toMatchObject({ job: { id: jobId, status: 'running' }, access: { contentsPermission: 'read' } })
    const writeAccess = await internalJob(`/internal/repository-jobs/${jobId}/authorize-write`)
    expect(await body(writeAccess)).toMatchObject({ access: { contentsPermission: 'write' }, repository: { installationId: '2001', repositoryId: '4001' } })

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
    expect(JSON.stringify(await body(invalidated))).not.toContain(githubRepository.fullName)
  })

  it('rejects untrusted browser origins before auth or data access', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, registryFingerprint, allowedOrigins: ['https://login.canvas.test'] })
    const response = await app(request('/api/session', { headers: { Origin: 'https://attacker.test', Authorization: 'Bearer alpha' } }))
    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
