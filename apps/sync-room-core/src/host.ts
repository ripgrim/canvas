import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { maxRoomTicketLength, parseCollaborationClientMessage } from '@canvas/sync-protocol'
import type { CollaborationClientMessage, RoomOpenMessage, VerifiedRoomTicketClaims } from '@canvas/sync-protocol'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type { RoomAuthorization, RoomIdentity, RoomTicketContext, RoomTicketVerifier } from './contracts.js'
import { RoomAuthorityUnavailableError } from './room-core.js'
import type { RoomPeer, RoomPhase } from './room-core.js'

export interface HostedCollaborationRoom {
  readonly identity: RoomIdentity
  readonly phase: RoomPhase
  start(): Promise<void>
  admitAuthorized(peer: RoomPeer, authorization: RoomAuthorization, open: RoomOpenMessage): Promise<boolean>
  receive(connectionId: string, message: CollaborationClientMessage): Promise<void>
  disconnect(connectionId: string): void
  drain(): Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' | 'timeout' }>>
}

export type MultiRoomHostOptions = Readonly<{
  allowedOrigins: readonly string[]
  maxMessageBytes: number
  maxRooms: number
  maxPendingUpgrades: number
  handshakeTimeoutMs: number
  startupTimeoutMs: number
  shutdownTimeoutMs: number
  allowNonLoopback?: boolean
  tickets: RoomTicketVerifier
  createRoom(identity: RoomIdentity): HostedCollaborationRoom
  now?: () => number
}>

export type MultiRoomHost = Readonly<{
  server: Server
  readonly phase: 'accepting' | 'draining' | 'stopped'
  readonly roomCount: number
  readonly pendingUpgradeCount: number
  listen(port?: number, hostname?: string): Promise<Readonly<{ port: number; hostname: string }>>
  close(): Promise<Readonly<{ status: 'stopped' | 'room-drain-failed'; roomCount: number }>>
}>

type Route = Readonly<{ fileId: string; generationId: string; clientId: string; connectionNonce: string }>
type RoomEntry = { room: HostedCollaborationRoom; rawStartup: Promise<HostedCollaborationRoom>; startup: Promise<HostedCollaborationRoom>; abandoned: boolean }
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class HostCapacityError extends Error {}
class HostGenerationConflictError extends Error {}
class HostStartupTimeoutError extends Error {}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive.`)
  return value
}

function routeOf(request: IncomingMessage): Route | null {
  let url: URL
  try { url = new URL(request.url ?? '/', 'http://sync-room.local') } catch { return null }
  const match = /^\/sync\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
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
  const body = `${reason}\n`
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Content-Type-Options: nosniff\r\n\r\n${body}`)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}

function text(data: RawData): string | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}

function roomKey(identity: Pick<RoomIdentity, 'fileId' | 'generationId'>): string {
  return `${identity.fileId}:${identity.generationId}`
}

function matchesContext(claims: VerifiedRoomTicketClaims, context: RoomTicketContext): boolean {
  return claims.protocolEpoch === 2
    && claims.fileId === context.fileId
    && claims.generationId === context.generationId
    && claims.clientId === context.clientId
    && claims.connectionNonce === context.connectionNonce
    && claims.expiresAtUnixMs > context.nowUnixMs
}

export function createMultiRoomHost(options: MultiRoomHostOptions): MultiRoomHost {
  const allowedOrigins = new Set(options.allowedOrigins)
  if (!allowedOrigins.size) throw new Error('At least one allowed origin is required.')
  positiveInteger(options.maxMessageBytes, 'Message byte limit')
  positiveInteger(options.maxRooms, 'Room limit')
  positiveInteger(options.maxPendingUpgrades, 'Pending upgrade limit')
  positiveInteger(options.handshakeTimeoutMs, 'Handshake timeout')
  positiveInteger(options.startupTimeoutMs, 'Startup timeout')
  positiveInteger(options.shutdownTimeoutMs, 'Shutdown timeout')
  const now = options.now ?? Date.now
  const rooms = new Map<string, RoomEntry>()
  const generationByFile = new Map<string, string>()
  const pendingSockets = new Set<Duplex>()
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: options.maxMessageBytes, perMessageDeflate: false, clientTracking: true })
  let phase: MultiRoomHost['phase'] = 'accepting'
  let pendingUpgrades = 0
  let closing: Promise<Readonly<{ status: 'stopped' | 'room-drain-failed'; roomCount: number }>> | null = null

  const abandonEntry = (identity: RoomIdentity, entry: RoomEntry): Promise<void> => {
    if (entry.abandoned) return Promise.resolve()
    entry.abandoned = true
    const key = roomKey(identity)
    if (rooms.get(key) === entry) rooms.delete(key)
    if (generationByFile.get(identity.fileId) === identity.generationId) generationByFile.delete(identity.fileId)
    const cleanup = entry.rawStartup.then(room => room.drain()).then(() => undefined).catch(error => {
      process.stderr.write(`${JSON.stringify({ event: 'room_abandon_failed', fileId: identity.fileId, generationId: identity.generationId, error: error instanceof Error ? error.message : String(error) })}\n`)
    })
    void cleanup
    return cleanup
  }

  const getOrStartRoom = (identity: RoomIdentity): RoomEntry => {
    const key = roomKey(identity)
    let predecessorDrain: Promise<void> = Promise.resolve()
    for (const entry of rooms.values()) {
      if (entry.room.phase !== 'failed' && entry.room.phase !== 'stopped') continue
      const cleanup = abandonEntry(entry.room.identity, entry)
      if (entry.room.identity.fileId === identity.fileId) predecessorDrain = Promise.all([predecessorDrain, cleanup]).then(() => undefined)
    }
    const existing = rooms.get(key)
    if (existing) return existing
    const activeGeneration = generationByFile.get(identity.fileId)
    if (activeGeneration && activeGeneration !== identity.generationId) throw new HostGenerationConflictError()
    if (rooms.size >= options.maxRooms) throw new HostCapacityError()
    let room: HostedCollaborationRoom
    room = options.createRoom(identity)
    generationByFile.set(identity.fileId, identity.generationId)
    let entry: RoomEntry
    const rawStartup = predecessorDrain.then(() => room.start()).then(() => {
      if (room.phase !== 'accepting') throw new Error('Room did not become ready.')
      return room
    })
    let timer: NodeJS.Timeout | undefined
    const startup = Promise.race([
      rawStartup,
      new Promise<never>((_resolve, rejectStartup) => {
        timer = setTimeout(() => rejectStartup(new HostStartupTimeoutError()), options.startupTimeoutMs)
        timer.unref()
      }),
    ]).catch(error => {
      if (error instanceof HostStartupTimeoutError) abandonEntry(identity, entry)
      else {
        if (rooms.get(key) === entry) rooms.delete(key)
        if (generationByFile.get(identity.fileId) === identity.generationId) generationByFile.delete(identity.fileId)
      }
      throw error
    }).finally(() => {
      if (timer) clearTimeout(timer)
    })
    entry = { room, rawStartup, startup, abandoned: false }
    rooms.set(key, entry)
    return entry
  }

  const awaitStartup = (identity: RoomIdentity): Promise<HostedCollaborationRoom> => getOrStartRoom(identity).startup

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') { json(response, 200, { ok: true, phase, rooms: rooms.size }); return }
    if (request.method === 'GET' && request.url === '/readyz') { json(response, phase === 'accepting' ? 200 : 503, { ready: phase === 'accepting', phase, rooms: rooms.size }); return }
    json(response, 404, { error: { code: 'not_found', message: 'Not found.' } })
  })

  server.on('upgrade', (request, socket, head) => {
    socket.pause()
    if (phase !== 'accepting') { reject(socket, 503, 'Service Unavailable'); return }
    if (pendingUpgrades >= options.maxPendingUpgrades) { reject(socket, 503, 'Service Unavailable'); return }
    pendingUpgrades += 1
    pendingSockets.add(socket)
    void (async () => {
      const route = routeOf(request)
      if (!route) { reject(socket, 404, 'Not Found'); return }
      const origin = request.headers.origin
      if (!origin || !allowedOrigins.has(origin)) { reject(socket, 403, 'Forbidden'); return }
      const token = bearer(request)
      if (!token) { reject(socket, 401, 'Unauthorized'); return }
      const ticketContext: RoomTicketContext = { token, ...route, nowUnixMs: now() }
       const authorization = await options.tickets.verify(ticketContext)
       if (!authorization || !matchesContext(authorization.claims, ticketContext)) { reject(socket, 401, 'Unauthorized'); return }
      if (phase !== 'accepting') { reject(socket, 503, 'Service Unavailable'); return }
      const room = await awaitStartup({ fileId: route.fileId, generationId: route.generationId, protocolEpoch: 2 })
      if (phase !== 'accepting') { reject(socket, 503, 'Service Unavailable'); return }
      socket.resume()
      await new Promise<void>((resolveUpgrade, rejectUpgrade) => {
        try {
          webSockets.handleUpgrade(request, socket, head, webSocket => {
            pendingSockets.delete(socket)
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
            let upgradeComplete = false
            let handshakeTimer: NodeJS.Timeout | undefined
            const clearHandshakeTimer = () => {
              if (!handshakeTimer) return
              clearTimeout(handshakeTimer)
              handshakeTimer = undefined
            }
            const completeUpgrade = () => {
              if (upgradeComplete) return
              upgradeComplete = true
              clearHandshakeTimer()
              resolveUpgrade()
            }
            handshakeTimer = setTimeout(() => {
              webSocket.close(4408, 'Room open timed out')
              completeUpgrade()
            }, options.handshakeTimeoutMs)
            handshakeTimer.unref()
            const receive = (data: RawData, binary: boolean) => {
              if (binary) { webSocket.close(1003, 'Text messages only'); return }
              const source = text(data)
              if (source === 'ping') { webSocket.send('pong'); return }
              if (!source || Buffer.byteLength(source) > options.maxMessageBytes) { webSocket.close(1009, 'Message too large'); return }
              let message: CollaborationClientMessage
              try { message = parseCollaborationClientMessage(source, options.maxMessageBytes) }
              catch { webSocket.close(1007, 'Invalid collaboration message'); return }
              void room.receive(connectionId, message).catch(() => webSocket.close(1011, 'Room operation failed'))
            }
            const admit = (open: RoomOpenMessage) => {
              opening = true
              void (async () => {
                 const accepted = await room.admitAuthorized(peer, authorization, open)
                if (!accepted) { webSocket.close(4401, 'Unauthorized'); return }
                if (webSocket.readyState !== WebSocket.OPEN) { room.disconnect(connectionId); return }
                if (phase !== 'accepting') { webSocket.close(1012, 'Service unavailable'); return }
                admitted = true
                for (const frame of pending) receive(frame.data, frame.binary)
                pending.length = 0
                webSockets.emit('connection', webSocket, request)
              })().catch(() => webSocket.close(1013, 'Room unavailable')).finally(completeUpgrade)
            }
            webSocket.on('message', (data: RawData, binary: boolean) => {
              if (admitted) { receive(data, binary); return }
              if (!opening) {
                if (binary) { webSocket.close(1003, 'First message must be room.open'); completeUpgrade(); return }
                const source = text(data)
                if (!source || Buffer.byteLength(source) > options.maxMessageBytes) { webSocket.close(1009, 'Message too large'); completeUpgrade(); return }
                let message: CollaborationClientMessage
                try { message = parseCollaborationClientMessage(source, options.maxMessageBytes) }
                catch { webSocket.close(1007, 'Invalid collaboration message'); completeUpgrade(); return }
                if (message.type !== 'room.open') { webSocket.close(1008, 'First message must be room.open'); completeUpgrade(); return }
                clearHandshakeTimer()
                admit(message)
                return
              }
              const bytes = data instanceof ArrayBuffer ? data.byteLength : Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength
              pendingBytes += bytes
              if (pending.length >= 16 || pendingBytes > options.maxMessageBytes * 2) { webSocket.close(1009, 'Admission message queue exceeded'); return }
              pending.push({ data, binary })
            })
            const disconnected = () => { room.disconnect(connectionId); completeUpgrade() }
            webSocket.once('close', disconnected)
            webSocket.once('error', disconnected)
          })
        } catch (error) { rejectUpgrade(error) }
      })
    })().catch(error => {
      if (error instanceof HostGenerationConflictError || error instanceof RoomAuthorityUnavailableError) { reject(socket, 409, 'Conflict'); return }
      if (error instanceof HostCapacityError || error instanceof HostStartupTimeoutError) { reject(socket, 503, 'Service Unavailable'); return }
      reject(socket, 503, 'Service Unavailable')
    }).finally(() => { pendingSockets.delete(socket); pendingUpgrades -= 1 })
  })

  const host: MultiRoomHost = {
    server,
    get phase() { return phase },
    get roomCount() { return rooms.size },
    get pendingUpgradeCount() { return pendingUpgrades },
    listen(port = 4325, hostname = '127.0.0.1') {
      if (!options.allowNonLoopback && !['127.0.0.1', '::1', 'localhost'].includes(hostname)) return Promise.reject(new Error('Sync room host may only bind to a loopback hostname.'))
      return new Promise((resolve, rejectListen) => {
        const failed = (error: Error) => { server.off('listening', ready); rejectListen(error) }
        const ready = () => {
          server.off('error', failed)
          const address = server.address()
          if (!address || typeof address === 'string') { rejectListen(new Error('Room host did not bind a TCP port.')); return }
          resolve(Object.freeze({ port: address.port, hostname }))
        }
        server.once('error', failed); server.once('listening', ready); server.listen(port, hostname)
      })
    },
    close() {
      if (closing) return closing
      phase = 'draining'
      closing = (async () => {
        for (const socket of pendingSockets) reject(socket, 503, 'Service Unavailable')
        const entries = [...rooms.values()]
        for (const entry of entries) {
          if (entry.room.phase === 'cold' || entry.room.phase === 'starting') abandonEntry(entry.room.identity, entry)
        }
        const activeRooms = entries.filter(entry => !entry.abandoned && entry.room.phase !== 'stopped').map(entry => entry.room)
        let timer: NodeJS.Timeout | undefined
        const drained = await Promise.race([
          Promise.all(activeRooms.map(room => room.drain().catch(() => ({ status: 'checkpoint-failed' as const })))).then(results => ({ status: 'complete' as const, results })),
          new Promise<Readonly<{ status: 'timeout' }>>(resolveTimeout => {
            timer = setTimeout(() => resolveTimeout({ status: 'timeout' }), options.shutdownTimeoutMs)
            timer.unref()
          }),
        ]).finally(() => { if (timer) clearTimeout(timer) })
        for (const webSocket of webSockets.clients) webSocket.terminate()
        webSockets.close()
        await new Promise<void>((resolve, rejectClose) => server.close(error => error ? rejectClose(error) : resolve()))
        phase = 'stopped'
        return Object.freeze({ status: drained.status === 'complete' && drained.results.every(result => result.status === 'stopped') ? 'stopped' as const : 'room-drain-failed' as const, roomCount: activeRooms.length })
      })()
      return closing
    },
  }
  return Object.freeze(host)
}
