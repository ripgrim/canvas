import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { defaultMaxSyncMessageBytes } from '@canvas/sync-protocol'
import type { SyncAuthorizer, SyncRepository, SyncSocket } from './contracts.js'
import { createRevisionSyncService } from './service.js'

export type SyncNetworkServerOptions = Readonly<{
  repository: SyncRepository
  authorizer: SyncAuthorizer
  allowedOrigins: readonly string[]
  maxMessageBytes?: number
}>

export type SyncNetworkServer = Readonly<{
  server: Server
  listen(port?: number, hostname?: string): Promise<Readonly<{ port: number; hostname: string }>>
  close(): Promise<void>
}>

const clientPattern = /^[A-Za-z0-9:._-]{1,128}$/
const filePattern = /^[A-Za-z0-9:._-]{1,128}$/

function headersOf(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) if (typeof value === 'string') result[name.toLowerCase()] = value
  return result
}

function routeOf(request: IncomingMessage): { fileId: string; clientId: string } | null {
  let url: URL
  try { url = new URL(request.url ?? '/', 'http://sync.local') } catch { return null }
  const match = /^\/sync\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
  let fileId: string
  try { fileId = decodeURIComponent(match[1]!) } catch { return null }
  const clientId = url.searchParams.get('tabId')
  if (!filePattern.test(fileId) || !clientId || !clientPattern.test(clientId)) return null
  return { fileId, clientId }
}

function reject(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Content-Type-Options: nosniff\r\n\r\n${body}`)
}

function health(response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end('{"ok":true}')
}

export function createSyncNetworkServer(options: SyncNetworkServerOptions): SyncNetworkServer {
  const allowedOrigins = new Set(options.allowedOrigins)
  if (!allowedOrigins.size) throw new Error('At least one ALLOWED_ORIGINS entry is required')
  const maxMessageBytes = options.maxMessageBytes ?? defaultMaxSyncMessageBytes
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new Error('Message byte limit must be a positive integer')
  const service = createRevisionSyncService({ repository: options.repository, authorizer: options.authorizer, maxMessageBytes })
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes, perMessageDeflate: false, clientTracking: true })
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') { health(response); return }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); response.end('Not found\n')
  })

  const bind = (webSocket: WebSocket, peer: ReturnType<typeof service.connectAuthorized>) => {
    if (!peer) { webSocket.close(4401, 'Unauthorized'); return }
    webSocket.on('message', (data: RawData, binary: boolean) => {
      if (binary) { webSocket.close(1003, 'Text messages only'); return }
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
      if (bytes.toString() === 'ping') { webSocket.send('pong'); return }
      void peer.receive(bytes).catch(() => webSocket.close(1011, 'Sync failed'))
    })
    webSocket.on('close', () => peer.disconnect())
    webSocket.on('error', () => peer.disconnect())
  }

  server.on('upgrade', (request, socket, head) => {
    socket.pause()
    void (async () => {
      const route = routeOf(request)
      if (!route) { reject(socket, 404, 'Not Found'); return }
      const origin = request.headers.origin
      if (!origin || !allowedOrigins.has(origin)) { reject(socket, 403, 'Forbidden'); return }
      const connectionRequest = {
        url: request.url ?? '/',
        headers: headersOf(request.headers),
        origin,
        ...(request.socket.remoteAddress ? { remoteAddress: request.socket.remoteAddress } : {}),
        scopedFileId: route.fileId,
        scopedClientId: route.clientId,
      }
      const authorization = await service.authorizeConnection(connectionRequest)
      if (!authorization) { reject(socket, 401, 'Unauthorized'); return }
      socket.resume()
      webSockets.handleUpgrade(request, socket, head, webSocket => {
        const adapter: SyncSocket = {
          send(data) { if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data) },
          close(code, reason) { if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) webSocket.close(code, reason) },
        }
        const peer = service.connectAuthorized(adapter, connectionRequest, authorization)
        bind(webSocket, peer)
        webSockets.emit('connection', webSocket, request)
      })
    })().catch(() => reject(socket, 503, 'Service Unavailable'))
  })

  return {
    server,
    listen(port = 4321, hostname = '127.0.0.1') {
      return new Promise((resolve, rejectListen) => {
        const failed = (error: Error) => { server.off('listening', ready); rejectListen(error) }
        const ready = () => {
          server.off('error', failed)
          const address = server.address()
          if (!address || typeof address === 'string') { rejectListen(new Error('Sync server did not bind a TCP port')); return }
          resolve({ port: address.port, hostname })
        }
        server.once('error', failed); server.once('listening', ready); server.listen(port, hostname)
      })
    },
    close() {
      service.dispose()
      for (const socket of webSockets.clients) socket.terminate()
      webSockets.close()
      return new Promise((resolve, rejectClose) => server.close(error => error ? rejectClose(error) : resolve()))
    },
  }
}
