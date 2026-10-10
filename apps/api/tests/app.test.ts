import { describe, expect, it } from 'vitest'
import type { HostedAuth, HostedSessionUser } from '@canvas/auth/server'
import { createMemoryControlPlane } from '@canvas/database/memory'
import { createApiApp } from '../src/app'

const serviceToken = '0123456789abcdef0123456789abcdef'
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
  schemaVersion: 6,
  fileId,
  revision,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
})

describe('hosted control-plane API', () => {
  it('AUTH-HOST-001 delegates provider endpoints and protects session state', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken })
    const provider = await app(request('/api/auth/sign-in/social', { method: 'POST' }))
    expect(provider.status).toBe(200)
    expect(await body(provider)).toEqual({ provider: 'github' })
    expect((await app(request('/api/session'))).status).toBe(401)
    const session = await app(request('/api/session', signed('alpha')))
    expect(session.status).toBe(200)
    expect(await body(session)).toEqual({ user: users.alpha })
  })

  it('CLOUD-FILES-001 creates, lists, opens, and saves canonical file data', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken })
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
    expect(initial).toMatchObject({ fileId: file.id, revision: 0, document: { schemaVersion: 6, fileId: file.id, revision: 0, pages: [{ name: 'Page 1' }], theme: { tokens: {} } } })
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
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken })
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

  it('CLOUD-FILES-SEC-001 rejects document identity, revision, and shape substitution', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken })
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
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken })
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

  it('FILE-ASSET-SEC-001 requires the service secret and exact user ownership', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken })
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

  it('rejects untrusted browser origins before auth or data access', async () => {
    const app = createApiApp({ auth: auth(), store: createMemoryControlPlane(), serviceToken, allowedOrigins: ['https://login.canvas.test'] })
    const response = await app(request('/api/session', { headers: { Origin: 'https://attacker.test', Authorization: 'Bearer alpha' } }))
    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
