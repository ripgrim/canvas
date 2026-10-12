import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createApiApp } from '../../apps/api/dist/app.js'
import { createPostgresCollaborationAdmissionAuthority } from '../../apps/api/dist/collaboration-admission.js'
import { createPostgresCollaborationPersistence } from '../../packages/database/dist/collaboration.js'
import { createPostgresControlPlane, createPostgresPool } from '../../packages/database/dist/postgres.js'

const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const users = Object.freeze({
  owner: Object.freeze({ id: required('COLLABORATION_TEST_OWNER_ID'), name: 'Stage 6 owner', email: 'stage6-owner@example.invalid', image: null }),
  viewer: Object.freeze({ id: required('COLLABORATION_TEST_VIEWER_ID'), name: 'Stage 6 viewer', email: 'stage6-viewer@example.invalid', image: null }),
})
const cookieName = 'canvas-stage6-session'
const session = request => {
  const cookies = Object.fromEntries((request.headers.get('Cookie') ?? '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2))
  return users[cookies[cookieName]] ?? null
}
const auth = Object.freeze({
  getSession: async request => session(request),
  handler: async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Route not found.' } }), { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }),
})
const pool = createPostgresPool(required('DATABASE_URL'))
const store = createPostgresControlPlane(pool)
const collaboration = createPostgresCollaborationPersistence(pool)
const app = createApiApp({
  auth,
  store,
  serviceToken: required('API_SERVICE_TOKEN'),
  collaborationAdmissionServiceToken: required('COLLABORATION_ADMISSION_SERVICE_TOKEN'),
  collaborationBuildId: required('COLLABORATION_BUILD_ID'),
  registryFingerprint: required('CANVAS_VERIFIED_REGISTRY_FINGERPRINT'),
  collaborationAuthority: createPostgresCollaborationAdmissionAuthority(collaboration),
  legacyDocumentExternalizer: Object.freeze({ prepare: async () => undefined }),
  allowedOrigins: [required('APP_URL')],
})
const port = Number(process.env.PORT ?? 4320)
const server = createServer(async (incoming, outgoing) => {
  try {
    const response = await app(await webRequest(incoming))
    outgoing.statusCode = response.status
    response.headers.forEach((value, name) => outgoing.setHeader(name, value))
    if (!response.body) { outgoing.end(); return }
    Readable.fromWeb(response.body).pipe(outgoing)
  } catch (error) {
    const requestId = randomUUID()
    process.stderr.write(`${JSON.stringify({ event: 'stage6_api_transport_failed', requestId, error: error instanceof Error ? error.message : String(error) })}\n`)
    outgoing.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'X-Canvas-Request-Id': requestId })
    outgoing.end(JSON.stringify({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId } }))
  }
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`Stage 6 API: http://127.0.0.1:${port}/\n`))

async function webRequest(incoming) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : await readBody(incoming, 6 * 1024 * 1024)
  return new Request(new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? `127.0.0.1:${port}`}`), {
    method: incoming.method ?? 'GET',
    headers,
    ...(body ? { body: Uint8Array.from(body).buffer } : {}),
  })
}

async function readBody(incoming, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of incoming) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) throw new Error('Request body is too large.')
    chunks.push(bytes)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  server.close(() => void pool.end().finally(() => process.exit(0)))
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
