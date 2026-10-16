import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { maxRoomTicketLength, parseCollaborationClientMessage } from '@canvas/sync-protocol'
import type { CollaborationClientMessage, RoomOpenMessage } from '@canvas/sync-protocol'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type { CollaborationRoomCore, RoomPeer } from './room-core.js'

export type RoomNetworkOptions = Readonly<{
  room: CollaborationRoomCore
  allowedOrigins: readonly string[]
  maxMessageBytes: number
  handshakeTimeoutMs: number
  now?: () => number
}>

export type RoomNetworkServer = Readonly<{
  server: Server
  listen(port?: number, hostname?: string): Promise<Readonly<{ port: number; hostname: string }>>
  close(): Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' | 'timeout' }>>
}>

type Route = Readonly<{ fileId: string; generationId: string; clientId: string; connectionNonce: string }>
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const routeQueryKeys = Object.freeze(['clientId', 'connectionNonce'] as const)

function routeOf(request: IncomingMessage): Route | null {
  let url: URL
  try { url = new URL(request.url ?? '/', 'http://sync-room.local') } catch { return null }
  const match = /^\/sync\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
  const queryKeys = [...url.searchParams.keys()]
  if (queryKeys.length !== routeQueryKeys.length
    || queryKeys.some(key => !routeQueryKeys.includes(key as (typeof routeQueryKeys)[number]))
    || routeQueryKeys.some(key => url.searchParams.getAll(key).length !== 1)) return null
  let fileId: string
  let generationId: string
  try { fileId = decodeURIComponent(match[1]!); generationId = decodeURIComponent(match[2]!) } catch { return null }
  const clientId = url.searchParams.get('clientId')
  const connectionNonce = url.searchParams.get('connectionNonce')
  return uuid.test(fileId) && uuid.test(generationId) && clientId && identifier.test(clientId) && connectionNonce && /^[A-Za-z0-9_-]{16,512}$/.test(connectionNonce)
    ? { fileId, generationId, clientId, connectionNonce }
    : null
}

function bearer(request: IncomingMessage): string | null {
  const value = request.headers.authorization
  if (!value?.startsWith('Bearer ')) return null
  const token = value.slice(7)
  return new RegExp(`^[A-Za-z0-9_-]{16,${maxRoomTicketLength}}$`).test(token) ? token : null
}

function reject(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return
  const body = `${reason}\n`
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Content-Type-Options: nosniff\r\n\r\n${body}`)
}

function json(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

function text(data: RawData): string | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}

export function createRoomNetworkServer(options: RoomNetworkOptions): RoomNetworkServer {
  const allowedOrigins = new Set(options.allowedOrigins)
  if (!allowedOrigins.size) throw new Error('At least one allowed origin is required.')
  if (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes < 1) throw new Error('Message byte limit must be positive.')
  if (!Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs < 1) throw new Error('Handshake timeout must be positive.')
  const now = options.now ?? Date.now
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: options.maxMessageBytes, perMessageDeflate: false, clientTracking: true })
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') { json(response, 200, '{"ok":true}'); return }
    if (request.method === 'GET' && request.url === '/readyz') {
      const ready = options.room.phase === 'accepting'
      json(response, ready ? 200 : 503, JSON.stringify({ ready, phase: options.room.phase }))
      return
    }
    json(response, 404, '{"error":{"code":"not_found","message":"Not found."}}')
  })

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => undefined)
    socket.pause()
    void (async () => {
      const route = routeOf(request)
      if (!route) { reject(socket, 404, 'Not Found'); return }
      if (route.fileId !== options.room.identity.fileId || route.generationId !== options.room.identity.generationId) { reject(socket, 404, 'Not Found'); return }
      const origin = request.headers.origin
      if (!origin || !allowedOrigins.has(origin)) { reject(socket, 403, 'Forbidden'); return }
      const token = bearer(request)
      if (!token) { reject(socket, 401, 'Unauthorized'); return }
      const ticketContext = { token, ...route, nowUnixMs: now() }
      const authorization = await options.room.authorize(ticketContext)
      if (!authorization) { reject(socket, 401, 'Unauthorized'); return }
      socket.resume()
      webSockets.handleUpgrade(request, socket, head, webSocket => {
        const connectionId = crypto.randomUUID()
        const peer: RoomPeer = {
          connectionId,
          send(message) {
            if (webSocket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WebSocket is not open.'))
            if (webSocket.bufferedAmount > options.maxMessageBytes * 4) return Promise.reject(new Error('WebSocket backpressure limit exceeded.'))
            return new Promise<void>((resolve, rejectSend) => webSocket.send(message, error => error ? rejectSend(error) : resolve()))
          },
          close(code, reason) { if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) webSocket.close(code, reason) },
        }
        let admitted = false
        let opening = false
        const pending: { data: RawData; binary: boolean }[] = []
        let pendingBytes = 0
        const handshakeTimer = setTimeout(() => webSocket.close(4408, 'Room open timed out'), options.handshakeTimeoutMs)
        handshakeTimer.unref()
        const receive = (data: RawData, binary: boolean) => {
            if (binary) { webSocket.close(1003, 'Text messages only'); return }
            const source = text(data)
            if (source === 'ping') { webSocket.send('pong'); return }
            if (!source || Buffer.byteLength(source) > options.maxMessageBytes) { webSocket.close(1009, 'Message too large'); return }
            let message
            try { message = parseCollaborationClientMessage(source, options.maxMessageBytes) }
            catch { webSocket.close(1007, 'Invalid collaboration message'); return }
            void options.room.receive(connectionId, message).catch(() => webSocket.close(1011, 'Room operation failed'))
        }
        const admit = (open: RoomOpenMessage) => {
          opening = true
          void (async () => {
            const accepted = await options.room.admitAuthorized(peer, authorization, open)
            if (!accepted) { webSocket.close(4401, 'Unauthorized'); return }
            if (webSocket.readyState !== WebSocket.OPEN) { options.room.disconnect(connectionId); return }
            admitted = true
            clearTimeout(handshakeTimer)
            for (const frame of pending) receive(frame.data, frame.binary)
            pending.length = 0
            webSockets.emit('connection', webSocket, request)
          })().catch(() => webSocket.close(1013, 'Room unavailable'))
        }
        webSocket.on('message', (data: RawData, binary: boolean) => {
          if (admitted) { receive(data, binary); return }
          if (!opening) {
            if (binary) { webSocket.close(1003, 'First message must be room.open'); return }
            const source = text(data)
            if (!source || Buffer.byteLength(source) > options.maxMessageBytes) { webSocket.close(1009, 'Message too large'); return }
            let message: CollaborationClientMessage
            try { message = parseCollaborationClientMessage(source, options.maxMessageBytes) }
            catch { webSocket.close(1007, 'Invalid collaboration message'); return }
            if (message.type !== 'room.open') { webSocket.close(1008, 'First message must be room.open'); return }
            clearTimeout(handshakeTimer)
            admit(message)
            return
          }
          const bytes = data instanceof ArrayBuffer ? data.byteLength : Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength
          pendingBytes += bytes
          if (pending.length >= 16 || pendingBytes > options.maxMessageBytes * 2) { webSocket.close(1009, 'Admission message queue exceeded'); return }
          pending.push({ data, binary })
        })
        const disconnected = () => { clearTimeout(handshakeTimer); options.room.disconnect(connectionId) }
        webSocket.once('close', disconnected)
        webSocket.once('error', disconnected)
      })
    })().catch(() => reject(socket, 503, 'Service Unavailable'))
  })

  return Object.freeze({
    server,
    listen(port = 4322, hostname = '127.0.0.1') {
      if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) return Promise.reject(new Error('Sync room core may only bind to a loopback hostname.'))
      return new Promise((resolve, rejectListen) => {
        const failed = (error: Error) => { server.off('listening', ready); rejectListen(error) }
        const ready = () => {
          server.off('error', failed)
          const address = server.address()
          if (!address || typeof address === 'string') { rejectListen(new Error('Room server did not bind a TCP port.')); return }
          resolve(Object.freeze({ port: address.port, hostname }))
        }
        server.once('error', failed); server.once('listening', ready); server.listen(port, hostname)
      })
    },
    async close() {
      const drained = await options.room.drain()
      for (const webSocket of webSockets.clients) webSocket.terminate()
      webSockets.close()
      await new Promise<void>((resolve, rejectClose) => server.close(error => error ? rejectClose(error) : resolve()))
      return drained
    },
  })
}
