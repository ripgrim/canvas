import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { HostedAuth, HostedSessionUser } from '@canvas/auth/server'
import { createMemoryControlPlane } from '@canvas/database/memory'
import type { CollaborationPersistence } from '@canvas/database'
import { maxCollaborationAvatarUrlBytes } from '@canvas/sync-protocol'
import { createApiApp } from '../src/app'
import { LegacyDocumentPreparationError } from '../src/legacy-assets'
import {
  collaborationAdmissionProtocolEpoch,
  collaborationAdmissionResponse,
  collaborationAdmissionWebSocketProtocol,
  createPostgresCollaborationAdmissionAuthority,
  type CollaborationAdmissionAuthority,
} from '../src/collaboration-admission'

const serviceToken = '0123456789abcdef0123456789abcdef'
const collaborationServiceToken = 'collaboration-admission-0123456789abcdef'
const collaborationBuildId = 'web-2026.10.10'
const collaborationOrigin = 'https://app.canvas.test'
const collaborationOptions = Object.freeze({
  collaborationAdmissionServiceToken: collaborationServiceToken,
  collaborationBuildId,
  collaborationAllowedOrigins: [collaborationOrigin],
  allowedOrigins: [collaborationOrigin],
  legacyDocumentExternalizer: Object.freeze({ prepare: vi.fn(async () => undefined) }),
})
const registryFingerprint = `sha256-${'A'.repeat(43)}=`
const users = Object.freeze({
  alpha: Object.freeze({ id: 'user-alpha', name: '  Alpha   Person  ', email: 'alpha@example.test', image: 'https://images.example/alpha.png' }),
  beta: Object.freeze({ id: 'user-beta', name: 'Beta', email: 'beta@example.test', image: null }),
}) satisfies Record<string, HostedSessionUser>

function auth(): HostedAuth {
  return Object.freeze({
    handler: async () => new Response(null, { status: 404 }),
    getSession: async request => request.headers.get('Authorization') === 'Bearer alpha'
      ? users.alpha
      : request.headers.get('Authorization') === 'Bearer beta' ? users.beta : null,
  })
}

function admissionRequest(
  payload: object,
  user: 'alpha' | 'beta' | null = 'alpha',
  token = collaborationServiceToken,
  origin: string | null = collaborationOrigin,
): Request {
  return new Request('https://api.canvas.test/internal/collaboration/admission', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Canvas-Collaboration-Token': token,
      ...(origin ? { Origin: origin } : {}),
      ...(user ? { Authorization: `Bearer ${user}` } : {}),
    },
    body: JSON.stringify(payload),
  })
}

const admissionBody = (fileId: string, extra: object = {}) => ({
  fileId,
  clientId: 'web-tab-1',
  protocolEpoch: collaborationAdmissionProtocolEpoch,
  webSocketProtocol: collaborationAdmissionWebSocketProtocol,
  buildId: collaborationBuildId,
  ...extra,
})

const responseBody = (response: Response) => response.json() as Promise<Record<string, any>>

function fixedAuthority(generationId = randomUUID(), status: 'active' | 'candidate' = 'active'): CollaborationAdmissionAuthority {
  return Object.freeze({ resolveGeneration: vi.fn(async () => Object.freeze({ generationId, status })) })
}

describe('epoch-4 collaboration admission', () => {
  it('CLOUD-SYNC-AUTH-001-C4-API rejects invalid trusted-session identity before signing', () => {
    const access = { subjectUserId: users.alpha.id, fileId: randomUUID(), role: 'owner' as const, accessEpoch: 1n }
    const generation = { generationId: randomUUID(), status: 'active' as const }
    expect(() => collaborationAdmissionResponse(access, generation, collaborationBuildId, { name: '   ', image: null })).toThrow('Invalid collaboration identity')
    expect(() => collaborationAdmissionResponse(access, generation, collaborationBuildId, { name: 'Alpha', image: 'http://images.example/alpha.png' })).toThrow('Invalid collaboration identity')
    expect(() => collaborationAdmissionResponse(access, generation, collaborationBuildId, { name: 'A'.repeat(81), image: null })).toThrow('Invalid collaboration identity')
    expect(() => collaborationAdmissionResponse(access, generation, collaborationBuildId, { name: 'Al\u202Epha', image: null })).toThrow('Invalid collaboration identity')
    expect(() => collaborationAdmissionResponse(access, generation, collaborationBuildId, { name: 'Al\u2067pha', image: null })).toThrow('Invalid collaboration identity')
    expect(() => collaborationAdmissionResponse(access, generation, collaborationBuildId, { name: 'Al\u200Bpha', image: null })).toThrow('Invalid collaboration identity')
    const avatarPrefix = 'https://images.example/'
    expect(() => collaborationAdmissionResponse(access, generation, collaborationBuildId, { name: 'Alpha', image: `${avatarPrefix}${'a'.repeat(maxCollaborationAvatarUrlBytes - avatarPrefix.length + 1)}` })).toThrow('Invalid collaboration identity')
  })

  it('CLOUD-SYNC-AUTH-001-C4-API rejects short, shared, or invalid configured collaboration authority', () => {
    const store = createMemoryControlPlane()
    const base = { auth: auth(), store, serviceToken, registryFingerprint, collaborationBuildId, collaborationAuthority: fixedAuthority() }

    expect(() => createApiApp({ ...base, collaborationAdmissionServiceToken: 'too-short' }))
      .toThrow('COLLABORATION_ADMISSION_SERVICE_TOKEN must contain at least 32 bytes.')
    expect(() => createApiApp({ ...base, collaborationAdmissionServiceToken: serviceToken }))
      .toThrow('COLLABORATION_ADMISSION_SERVICE_TOKEN must differ from API_SERVICE_TOKEN.')
    expect(() => createApiApp({ ...base, collaborationAdmissionServiceToken: collaborationServiceToken, collaborationBuildId: 'bad build id' }))
      .toThrow('COLLABORATION_BUILD_ID is invalid.')
    expect(() => createApiApp({ ...base, collaborationAdmissionServiceToken: collaborationServiceToken, collaborationAllowedOrigins: ['https://app.canvas.test/path'] }))
      .toThrow('Collaboration allowed origin must be an exact HTTP origin.')
  })

  it('CLOUD-SYNC-AUTH-001-C4-API and AT-AUTH-002-C4-API preserve signed owner authority with minimal epoch-4 claims', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Owner file', null)
    const generationId = randomUUID()
    const authority = fixedAuthority(generationId, 'candidate')
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority })

    const response = await app(admissionRequest(admissionBody(file.id)))
    expect(response.status).toBe(200)
    const result = await responseBody(response)
    expect(result).toEqual({
      claims: {
        subjectId: users.alpha.id,
        displayName: 'Alpha Person',
        avatarUrl: users.alpha.image,
        fileId: file.id,
        role: 'owner',
        generationId,
        protocolEpoch: 4,
        accessEpoch: '1',
      },
      generation: { status: 'candidate' },
      compatibility: { status: 'compatible', protocolEpoch: 4, buildId: 'web-2026.10.10' },
    })
    expect(authority.resolveGeneration).toHaveBeenCalledWith({ fileId: file.id, protocolEpoch: 4 })
    expect(JSON.stringify(result)).not.toMatch(/fence|lease|database|credential|token|email/i)
  })

  it('CLOUD-SYNC-READONLY-001-C4-API and AT-SHARE-003-C4-API preserve signed-in viewer role and reject role injection', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Shared file', null)
    await store.setFileShare(users.alpha.id, file.id, 'view')
    const authority = fixedAuthority()
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority })

    const viewer = await app(admissionRequest(admissionBody(file.id), 'beta'))
    expect(viewer.status).toBe(200)
    expect((await responseBody(viewer)).claims).toMatchObject({ subjectId: users.beta.id, displayName: users.beta.name, avatarUrl: null, role: 'viewer', accessEpoch: '2' })

    const escalation = await app(admissionRequest(admissionBody(file.id, { role: 'owner' }), 'beta'))
    expect(escalation.status).toBe(400)
    expect(await responseBody(escalation)).toEqual({ error: { code: 'invalid_admission_request', message: 'Admission request is invalid.' } })
    expect(authority.resolveGeneration).toHaveBeenCalledTimes(1)
  })

  it('CLOUD-SYNC-AUTH-001-C4-API rejects missing and invalid service credentials without leaking them', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Protected file', null)
    const authority = fixedAuthority()
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority })

    const wrongService = await app(admissionRequest(admissionBody(file.id), 'alpha', 'wrong-but-deliberately-similar-token'))
    expect(wrongService.status).toBe(403)
    expect(await responseBody(wrongService)).toEqual({ error: { code: 'service_forbidden', message: 'Service access denied.' } })

    const missingService = await app(admissionRequest(admissionBody(file.id), 'alpha', ''))
    expect(missingService.status).toBe(403)
    const missingServiceBody = await responseBody(missingService)
    expect(missingServiceBody).toEqual({ error: { code: 'service_forbidden', message: 'Service access denied.' } })
    expect(JSON.stringify(missingServiceBody)).not.toMatch(/collaboration-admission|0123456789abcdef/i)

    const signedOut = await app(admissionRequest(admissionBody(file.id), null))
    expect(signedOut.status).toBe(404)
    expect(await responseBody(signedOut)).toEqual({ error: { code: 'not_found', message: 'File not found.' } })
    expect(authority.resolveGeneration).not.toHaveBeenCalled()

    const unrelatedInternal = await app(new Request('https://api.canvas.test/internal/file-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Service-Token': collaborationServiceToken },
      body: JSON.stringify({ fileId: file.id }),
    }))
    expect(unrelatedInternal.status).toBe(403)
  })

  it('CLOUD-SYNC-READONLY-001-C4-API admits an anonymous public viewer with a stable non-user identity', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Public file', null)
    await store.setFileShare(users.alpha.id, file.id, 'view')
    const authority = fixedAuthority()
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority })

    const first = await app(admissionRequest(admissionBody(file.id, { clientId: 'web-anonymous-tab' }), null))
    const second = await app(admissionRequest(admissionBody(file.id, { clientId: 'web-anonymous-tab' }), null))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstClaims = (await responseBody(first)).claims
    const secondClaims = (await responseBody(second)).claims
    expect(firstClaims).toMatchObject({ displayName: 'Guest', avatarUrl: null, fileId: file.id, role: 'viewer', accessEpoch: '2' })
    expect(firstClaims.subjectId).toMatch(/^anonymous:[0-9a-f]{64}$/)
    expect(secondClaims.subjectId).toBe(firstClaims.subjectId)

    const escalation = await app(admissionRequest(admissionBody(file.id, { clientId: 'web-anonymous-tab', role: 'owner' }), null))
    expect(escalation.status).toBe(400)
    expect(authority.resolveGeneration).toHaveBeenCalledTimes(2)
  })

  it('AT-AUTH-003-C4-API masks revoked private and nonexistent files identically while preserving owner access', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Private file', null)
    await store.setFileShare(users.alpha.id, file.id, 'view')
    await store.setFileShare(users.alpha.id, file.id, 'private')
    const authority = fixedAuthority()
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority })

    const privateFile = await app(admissionRequest(admissionBody(file.id), 'beta'))
    const nonexistent = await app(admissionRequest(admissionBody(randomUUID()), 'beta'))
    const anonymousPrivate = await app(admissionRequest(admissionBody(file.id), null))
    const anonymousNonexistent = await app(admissionRequest(admissionBody(randomUUID()), null))
    expect(privateFile.status).toBe(404)
    expect(nonexistent.status).toBe(404)
    expect(anonymousPrivate.status).toBe(404)
    expect(anonymousNonexistent.status).toBe(404)
    expect(await responseBody(privateFile)).toEqual(await responseBody(nonexistent))
    expect(await responseBody(anonymousPrivate)).toEqual(await responseBody(anonymousNonexistent))
    expect(authority.resolveGeneration).not.toHaveBeenCalled()

    const owner = await app(admissionRequest(admissionBody(file.id), 'alpha'))
    expect(owner.status).toBe(200)
    expect((await responseBody(owner)).claims).toMatchObject({ role: 'owner', accessEpoch: '3' })
  })

  it('FILE-ASSET-001 prepares a legacy document before assigning a room generation', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Legacy file', null)
    const order: string[] = []
    const legacyDocumentExternalizer = Object.freeze({ prepare: vi.fn(async () => { order.push('prepare') }) })
    const authority: CollaborationAdmissionAuthority = Object.freeze({
      resolveGeneration: vi.fn(async () => {
        order.push('generation')
        return Object.freeze({ generationId: randomUUID(), status: 'candidate' as const })
      }),
    })
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, legacyDocumentExternalizer, collaborationAuthority: authority })

    expect((await app(admissionRequest(admissionBody(file.id)))).status).toBe(200)
    expect(order).toEqual(['prepare', 'generation'])
  })

  it('FILE-ASSET-SEC-001 never assigns a generation when migration fails', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Invalid legacy file', null)
    const authority = fixedAuthority()
    const reportError = vi.fn()
    const invalid = createApiApp({
      auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority,
      legacyDocumentExternalizer: Object.freeze({ prepare: async () => { throw new LegacyDocumentPreparationError('invalid-document') } }),
      reportError,
    })
    const unavailable = createApiApp({
      auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority,
      legacyDocumentExternalizer: Object.freeze({ prepare: async () => { throw new LegacyDocumentPreparationError('service-unavailable') } }),
    })

    const invalidResponse = await invalid(admissionRequest(admissionBody(file.id)))
    const unavailableResponse = await unavailable(admissionRequest(admissionBody(file.id)))
    expect(invalidResponse.status).toBe(426)
    expect(await responseBody(invalidResponse)).toMatchObject({ error: { code: 'unsupported_document', message: 'Update required.', requestId: expect.any(String) } })
    expect(unavailableResponse.status).toBe(503)
    expect(await responseBody(unavailableResponse)).toMatchObject({ error: { code: 'collaboration_unavailable', message: 'Collaboration is unavailable.', requestId: expect.any(String) } })
    expect(authority.resolveGeneration).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/internal/collaboration/admission', error: expect.objectContaining({ failure: 'invalid-document' }) }))
  })

  it('CLOUD-SYNC-SCHEMA-001-C4-API requires the exact epoch, WebSocket protocol, build, and request shape', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Validated file', null)
    const authority = fixedAuthority()
    const app = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority })

    for (const payload of [
      admissionBody('not-a-uuid'),
      { fileId: file.id, protocolEpoch: 4 },
      admissionBody(file.id, { buildId: 'bad build id' }),
      admissionBody(file.id, { generationId: randomUUID() }),
    ]) {
      const response = await app(admissionRequest(payload))
      expect(response.status).toBe(400)
    }

    const invalidJson = await app(new Request('https://api.canvas.test/internal/collaboration/admission', {
      method: 'POST',
      headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json', Origin: collaborationOrigin, 'X-Canvas-Collaboration-Token': collaborationServiceToken },
      body: '{',
    }))
    expect(invalidJson.status).toBe(400)
    expect(await responseBody(invalidJson)).toEqual({ error: { code: 'invalid_json', message: 'Request body is invalid JSON.' } })

    const wrongMedia = await app(new Request('https://api.canvas.test/internal/collaboration/admission', {
      method: 'POST',
      headers: { Authorization: 'Bearer alpha', 'Content-Type': 'text/plain', Origin: collaborationOrigin, 'X-Canvas-Collaboration-Token': collaborationServiceToken },
      body: JSON.stringify(admissionBody(file.id)),
    }))
    expect(wrongMedia.status).toBe(415)

    const stale = await app(admissionRequest(admissionBody(file.id, { protocolEpoch: 3 })))
    expect(stale.status).toBe(426)
    expect(await responseBody(stale)).toEqual({
      error: {
        code: 'unsupported_protocol',
        message: 'Update required.',
        compatibility: { status: 'incompatible', protocolEpoch: 4, buildId: 'web-2026.10.10' },
      },
    })
    expect(authority.resolveGeneration).not.toHaveBeenCalled()

    const staleBuild = await app(admissionRequest(admissionBody(file.id, { buildId: 'web-older' })))
    expect(staleBuild.status).toBe(426)
    expect(await responseBody(staleBuild)).toEqual({
      error: {
        code: 'unsupported_protocol',
        message: 'Update required.',
        compatibility: { status: 'incompatible', protocolEpoch: 4, buildId: collaborationBuildId },
      },
    })
    expect(authority.resolveGeneration).not.toHaveBeenCalled()

    const wrongSocketProtocol = await app(admissionRequest(admissionBody(file.id, { webSocketProtocol: 'canvas-sync-v3' })))
    expect(wrongSocketProtocol.status).toBe(426)
    expect(authority.resolveGeneration).not.toHaveBeenCalled()
  })

  it('CLOUD-SYNC-AUTH-001-C4-API rejects missing, hostile, and login-only origins before credential processing', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Origin-bound file', null)
    const authority = fixedAuthority()
    const app = createApiApp({
      auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: authority,
      allowedOrigins: [collaborationOrigin, 'https://login.canvas.test'],
    })

    for (const origin of [null, 'https://evil.example', 'https://login.canvas.test'] as const) {
      const response = await app(admissionRequest(admissionBody(file.id), 'alpha', '', origin))
      expect(response.status).toBe(403)
      expect(await responseBody(response)).toEqual({ error: { code: 'origin_forbidden', message: 'Origin is not allowed.' } })
    }
    expect(authority.resolveGeneration).not.toHaveBeenCalled()
  })

  it('CLOUD-SYNC-AUTH-001-C4-API fails closed without leaking unavailable authority details', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(users.alpha.id, 'Unavailable file', null)
    const unavailable = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions })
    const unavailableResponse = await unavailable(admissionRequest(admissionBody(file.id)))
    expect(unavailableResponse.status).toBe(503)
    expect(await responseBody(unavailableResponse)).toEqual({ error: { code: 'collaboration_unavailable', message: 'Collaboration is unavailable.' } })

    const reportError = vi.fn()
    const failingAuthority: CollaborationAdmissionAuthority = Object.freeze({ resolveGeneration: async () => { throw new Error('database connection secret') } })
    const failing = createApiApp({ auth: auth(), store, serviceToken, registryFingerprint, ...collaborationOptions, collaborationAuthority: failingAuthority, reportError })
    const failedResponse = await failing(admissionRequest(admissionBody(file.id)))
    expect(failedResponse.status).toBe(500)
    const failedBody = await responseBody(failedResponse)
    expect(failedBody).toMatchObject({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId: expect.any(String) } })
    expect(JSON.stringify(failedBody)).not.toContain('database connection secret')
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/internal/collaboration/admission', error: expect.any(Error) }))
  })
})

describe('PostgreSQL collaboration admission authority', () => {
  it('CLOUD-SYNC-AUTH-001-C4-API uses an active epoch-4 generation while treating the proposed identity as unused', async () => {
    const fileId = randomUUID()
    const generationId = randomUUID()
    const proposedId = randomUUID()
    const persistence = {
      resolveAdmissionGeneration: vi.fn(async () => ({ status: 'active' as const, generationId })),
    } satisfies Pick<CollaborationPersistence, 'resolveAdmissionGeneration'>
    const authority = createPostgresCollaborationAdmissionAuthority(persistence, () => proposedId)
    await expect(authority.resolveGeneration({ fileId, protocolEpoch: 4 })).resolves.toEqual({ generationId, status: 'active' })
    expect(persistence.resolveAdmissionGeneration).toHaveBeenCalledWith({ fileId, generationId: proposedId, protocolEpoch: 4, candidateTtlMs: 30_000 })
  })

  it('returns the atomic server-selected candidate when no active generation exists', async () => {
    const fileId = randomUUID()
    const generationId = randomUUID()
    const persistence = {
      resolveAdmissionGeneration: vi.fn(async input => ({ status: 'candidate' as const, generationId: input.generationId })),
    } satisfies Pick<CollaborationPersistence, 'resolveAdmissionGeneration'>
    const authority = createPostgresCollaborationAdmissionAuthority(persistence, () => generationId)
    await expect(authority.resolveGeneration({ fileId, protocolEpoch: 4 })).resolves.toEqual({ generationId, status: 'candidate' })
    expect(persistence.resolveAdmissionGeneration).toHaveBeenCalledWith({ fileId, generationId, protocolEpoch: 4, candidateTtlMs: 30_000 })
  })

  it('fails closed when persistence substitutes another generation identity', async () => {
    const fileId = randomUUID()
    const generationId = randomUUID()
    const persistence = {
      resolveAdmissionGeneration: vi.fn(async () => ({ status: 'candidate' as const, generationId: 'invalid' })),
    } satisfies Pick<CollaborationPersistence, 'resolveAdmissionGeneration'>
    const authority = createPostgresCollaborationAdmissionAuthority(persistence, () => generationId)
    await expect(authority.resolveGeneration({ fileId, protocolEpoch: 4 })).rejects.toThrow('Resolved collaboration generation is invalid.')
  })
})
