import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { handleRequest } from '../../apps/sync-worker/dist/index.js'
import { mintRoomTicket, openInternalAdmission } from '../../apps/sync-coordinator/src/tickets.ts'

const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
const port = Number(process.env.PORT ?? 4521)
const runtimeOrigin = new URL(required('SYNC_ROOM_RUNTIME_ORIGIN'))
const decodeSecret = name => Uint8Array.from(Buffer.from(required(name), 'base64url'))
const coordinatorSecret = decodeSecret('SYNC_COORDINATOR_INTERNAL_SECRET')
const ticketSecret = decodeSecret('SYNC_ROOM_TICKET_SECRET')
const consumedAdmissions = new Set()
const upgradeServer = new WebSocketServer({ noServer: true })

const env = {
  API_ORIGIN: required('API_ORIGIN'),
  ALLOWED_ORIGINS: required('ALLOWED_ORIGINS'),
  COLLABORATION_BUILD_ID: required('COLLABORATION_BUILD_ID'),
  COLLABORATION_ADMISSION_SERVICE_TOKEN: required('COLLABORATION_ADMISSION_SERVICE_TOKEN'),
  SYNC_COORDINATOR_INTERNAL_SECRET: required('SYNC_COORDINATOR_INTERNAL_SECRET'),
  SYNC_ROOMS: Object.freeze({
    idFromName: name => name,
    get: () => Object.freeze({
      fetch: async request => {
        env.capturedRequest = request
        return new Response(null, { status: 204 })
      },
    }),
  }),
  capturedRequest: null,
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  response.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: { code: 'upgrade_required', message: 'WebSocket upgrade required.' } }))
})

server.on('upgrade', async (incoming, socket, head) => {
  try {
    env.capturedRequest = null
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else if (value !== undefined) headers.set(name, value)
    }
    const result = await handleRequest(new Request(new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? `127.0.0.1:${port}`}`), { method: 'GET', headers }), env)
    const forwarded = env.capturedRequest
    if (result.status !== 204 || !forwarded) {
      const body = await result.text()
      socket.end(`HTTP/1.1 ${result.status} ${statusText(result.status)}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      return
    }
    const admissionToken = forwarded.headers.get('X-Canvas-Sync-Admission')
    const admission = admissionToken ? await openInternalAdmission(admissionToken, coordinatorSecret, Date.now()) : null
    if (!admission || consumedAdmissions.has(admission.admissionId)) throw new Error('The Worker admission envelope was rejected.')
    consumedAdmissions.add(admission.admissionId)
    const connectionNonce = randomUUID().replaceAll('-', '')
    const ticket = await mintRoomTicket({ ...admission.claims, expiresAtUnixMs: Date.now() + 300_000, clientId: admission.clientId, connectionNonce }, ticketSecret)
    const upstreamUrl = new URL(`/sync/${encodeURIComponent(admission.claims.fileId)}/${encodeURIComponent(admission.claims.generationId)}`, runtimeOrigin)
    upstreamUrl.protocol = runtimeOrigin.protocol === 'https:' ? 'wss:' : 'ws:'
    upstreamUrl.searchParams.set('clientId', admission.clientId)
    upstreamUrl.searchParams.set('connectionNonce', connectionNonce)
    const origin = forwarded.headers.get('Origin') ?? ''
    const protocol = forwarded.headers.get('Sec-WebSocket-Protocol')
    const upstream = new WebSocket(upstreamUrl, protocol ? protocol.split(',').map(value => value.trim()) : undefined, { origin, headers: { Authorization: `Bearer ${ticket}` } })
    upstream.once('open', () => upgradeServer.handleUpgrade(incoming, socket, head, client => bridge(client, upstream)))
    upstream.once('unexpected-response', (_request, response) => socket.end(`HTTP/1.1 ${response.statusCode ?? 503} ${response.statusMessage ?? 'Service Unavailable'}\r\nConnection: close\r\n\r\n`))
    upstream.once('error', error => { if (!socket.destroyed) socket.destroy(error) })
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'stage6_sync_edge_failed', reason: error instanceof Error ? error.message : String(error) })}\n`)
    if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
  }
})

function bridge(client, upstream) {
  const forward = target => (data, binary) => {
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary })
  }
  client.on('message', forward(upstream))
  upstream.on('message', forward(client))
  client.on('close', (code, reason) => { if (upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason) })
  upstream.on('close', (code, reason) => { if (client.readyState < WebSocket.CLOSING) client.close(code, reason) })
  client.on('error', () => upstream.terminate())
  upstream.on('error', () => client.terminate())
}

function statusText(status) {
  if (status === 401) return 'Unauthorized'
  if (status === 403) return 'Forbidden'
  if (status === 404) return 'Not Found'
  if (status === 426) return 'Upgrade Required'
  return 'Service Unavailable'
}

server.listen(port, '127.0.0.1', () => process.stdout.write(`Stage 6 sync edge: ws://127.0.0.1:${port}/\n`))

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const client of upgradeServer.clients) client.terminate()
  server.close(() => process.exit(0))
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
