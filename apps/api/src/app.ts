import { timingSafeEqual } from 'node:crypto'
import type { HostedAuth, HostedSessionUser } from '@canvas/auth/server'
import type { ControlPlaneStore, JsonValue } from '@canvas/database'
import { validateHostedFileDocument } from '@canvas/cloud-document'

export type ApiAppOptions = Readonly<{
  auth: HostedAuth
  store: ControlPlaneStore
  serviceToken: string
  allowedOrigins?: readonly string[]
}>

export type ApiApp = (request: Request) => Promise<Response>

const jsonHeaders = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fileAccessValues = new Set(['read', 'write', 'sync'])

export function createApiApp(options: ApiAppOptions): ApiApp {
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) throw new Error('API_SERVICE_TOKEN must contain at least 32 bytes.')
  const origins = new Set(options.allowedOrigins ?? [])
  return async request => {
    const origin = request.headers.get('Origin')
    if (origin && !origins.has(origin)) return apiResponse(request, origins, errorBody('origin_forbidden', 'Origin is not allowed.'), 403)
    if (request.method === 'OPTIONS') return preflight(request, origins)
    let response: Response
    try {
      const url = new URL(request.url)
      response = url.pathname === '/healthz' && request.method === 'GET'
        ? json({ ok: true })
        : url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')
          ? await options.auth.handler(request)
          : await routeApi(request, url, options)
    } catch (error) {
      if (error instanceof ApiInputError) response = json(errorBody(error.code, error.message), error.status)
      else response = json(errorBody('internal_error', 'Request could not be completed.'), 500)
    }
    return apiResponse(request, origins, response)
  }
}

async function routeApi(request: Request, url: URL, options: ApiAppOptions): Promise<Response> {
  if (url.pathname === '/internal/file-access' && request.method === 'POST') return internalFileAccess(request, options)
  const user = await options.auth.getSession(request)
  if (!user) return json(errorBody('unauthorized', 'Sign in required.'), 401)
  if (url.pathname === '/api/session' && request.method === 'GET') return json({ user })
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
      return document ? json({ fileId: document.fileId, document: document.document, revision: document.revision }) : json(errorBody('not_found', 'File not found.'), 404)
    }
    if (request.method === 'PUT') return saveDocument(request, options.store, user, documentId)
  }
  const fileId = routeId(url.pathname, '/api/files/')
  if (fileId && request.method === 'GET') {
    const file = await options.store.getFile(user.id, fileId)
    return file ? json({ file }) : json(errorBody('not_found', 'File not found.'), 404)
  }
  return json(errorBody('not_found', 'Route not found.'), 404)
}

async function saveDocument(request: Request, store: ControlPlaneStore, user: HostedSessionUser, fileId: string): Promise<Response> {
  const input = await readObject(request, 5 * 1024 * 1024)
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || input.expectedRevision === Number.MAX_SAFE_INTEGER) throw new ApiInputError('invalid_revision', 'Expected revision is invalid.')
  const expectedRevision = input.expectedRevision as number
  const document = readDocument(input.document, fileId, expectedRevision)
  const savedDocument = Object.freeze({ ...document, revision: expectedRevision + 1 })
  const result = await store.saveFileDocument(user.id, fileId, expectedRevision, savedDocument)
  if (result.status === 'not-found') return json(errorBody('not_found', 'File not found.'), 404)
  if (result.status === 'conflict') return json({ error: { code: 'revision_conflict', message: 'File changed.', currentRevision: result.currentRevision } }, 409)
  return json({ fileId: result.document.fileId, document: result.document.document, revision: result.document.revision })
}

async function internalFileAccess(request: Request, options: ApiAppOptions): Promise<Response> {
  const presented = request.headers.get('X-Canvas-Service-Token') ?? ''
  if (!equalToken(presented, options.serviceToken)) return json(errorBody('service_forbidden', 'Service access denied.'), 403)
  const user = await options.auth.getSession(request)
  if (!user) return json(errorBody('unauthorized', 'Sign in required.'), 401)
  const input = await readObject(request, 16_384)
  if (Object.keys(input).sort().join(',') !== 'access,fileId') throw new ApiInputError('invalid_access_request', 'Access request is invalid.')
  const fileId = readId(input.fileId, 'fileId')
  if (typeof input.access !== 'string' || !fileAccessValues.has(input.access)) throw new ApiInputError('invalid_access', 'Access is invalid.')
  const file = await options.store.getFile(user.id, fileId)
  return file ? json({ userId: user.id }) : json(errorBody('not_found', 'File not found.'), 404)
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

function readNullableId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return readId(value, field)
}

function readDocument(value: unknown, fileId: string, expectedRevision: number): Readonly<Record<string, JsonValue>> {
  let document
  try { document = validateHostedFileDocument(value) }
  catch { throw new ApiInputError('invalid_document', 'Document shape is invalid.') }
  if (document.fileId !== fileId || document.revision !== expectedRevision) throw new ApiInputError('invalid_document', 'Document identity or revision is invalid.')
  return Object.freeze(document as unknown as Readonly<Record<string, JsonValue>>)
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

function preflight(request: Request, origins: ReadonlySet<string>): Response {
  const origin = request.headers.get('Origin')
  if (!origin || !origins.has(origin)) return json(errorBody('origin_forbidden', 'Origin is not allowed.'), 403)
  const response = new Response(null, { status: 204 })
  return apiResponse(request, origins, response)
}

function apiResponse(request: Request, origins: ReadonlySet<string>, response: Response | object, status?: number): Response {
  const source = response instanceof Response ? response : json(response, status)
  const headers = new Headers(source.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  const origin = request.headers.get('Origin')
  if (origin && origins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Canvas-Service-Token')
    headers.append('Vary', 'Origin')
  }
  return new Response(source.body, { status: source.status, statusText: source.statusText, headers })
}

function json(body: object, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: jsonHeaders }) }
function errorBody(code: string, message: string) { return { error: { code, message } } }

class ApiInputError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
