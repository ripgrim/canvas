import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { syncProtocolVersion } from '@canvas/sync-protocol'
import { createRevisionSyncClient } from '@canvas/sync-client'
import { createInternalApiAuthorizer, createSyncNetworkServer, InMemorySyncRepository } from '../src/index.js'
import type { SyncNetworkServer } from '../src/index.js'

const fileId = '3f31d908-b9ed-4ca2-a6c7-50c78496d24f'
const serviceToken = '0123456789abcdef0123456789abcdef'
const allowedOrigin = 'http://127.0.0.1:4317'
const openServers: SyncNetworkServer[] = []
const openApis: ReturnType<typeof createServer>[] = []
const openSockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate()
  await Promise.all(openServers.splice(0).map(server => server.close()))
  await Promise.all(openApis.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
})

async function accessApi() {
  const calls: { url: string; method: string | undefined; headers: Record<string, string | string[] | undefined>; body: unknown }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const source = Buffer.concat(chunks).toString('utf8')
      calls.push({ url: request.url ?? '', method: request.method, headers: request.headers, body: source ? JSON.parse(source) : null })
      const allowed = request.url === '/internal/file-access'
        && request.method === 'POST'
        && request.headers['x-canvas-service-token'] === serviceToken
        && request.headers.authorization === 'Bearer allowed'
      response.writeHead(allowed ? 200 : 401, { 'Content-Type': 'application/json' })
      response.end(allowed ? '{"userId":"user-1"}' : '{"error":{"code":"unauthorized"}}')
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  openApis.push(server)
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, calls }
}

async function syncRuntime(maxMessageBytes = 256 * 1024) {
  const api = await accessApi()
  const repository = new InMemorySyncRepository([{ fileId, document: { schemaVersion: 1, title: 'Untitled' } }])
  const runtime = createSyncNetworkServer({ repository, authorizer: createInternalApiAuthorizer({ apiBaseUrl: api.url, serviceToken }), allowedOrigins: [allowedOrigin], maxMessageBytes })
  const address = await runtime.listen(0)
  openServers.push(runtime)
  return { url: `ws://127.0.0.1:${address.port}`, repository, calls: api.calls }
}

function connect(url: string, authorization = 'Bearer allowed', origin = allowedOrigin): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, headers: { Authorization: authorization, Cookie: 'session=test' } })
    openSockets.push(socket)
    socket.once('open', () => resolve(socket)); socket.once('error', reject)
  })
}

function nextMessage(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    socket.once('message', data => { try { resolve(JSON.parse(data.toString()) as Record<string, any>) } catch (error) { reject(error) } })
    socket.once('error', reject)
  })
}

function rejectedStatus(url: string, authorization = 'Bearer allowed', origin = allowedOrigin): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, headers: { Authorization: authorization } })
    openSockets.push(socket)
    socket.once('unexpected-response', (_request, response) => { const status = response.statusCode ?? 0; response.resume(); resolve(status) })
    socket.once('open', () => reject(new Error('Expected the WebSocket upgrade to be rejected')))
    socket.once('error', error => { if (!String(error).includes('Unexpected server response')) reject(error) })
  })
}

describe('sync network runtime', () => {
  it('CLOUD-SYNC-LIFECYCLE-002 answers transport heartbeats without entering the JSON protocol', async () => {
    const runtime = await syncRuntime()
    const client = createRevisionSyncClient({
      syncOrigin: runtime.url,
      createWebSocket: url => new WebSocket(url, { origin: allowedOrigin, headers: { Authorization: 'Bearer allowed' } }) as never,
      validateDocument: value => value as { schemaVersion: number; title: string },
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 5,
      reconnectDelaysMs: [1],
      random: () => 0.5,
      lifecycleTarget: null,
      createId: () => crypto.randomUUID(),
    })
    client.start({ fileId, clientId: 'heartbeat-tab', revision: 0, document: { schemaVersion: 1, title: 'Untitled' } })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Sync client did not become ready.')), 1_000)
      const unsubscribe = client.subscribe(() => {
        if (client.getSnapshot().status !== 'ready') return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(client.getSnapshot().status).toBe('ready')
    expect(runtime.calls.map(call => (call.body as any).access)).toEqual(['read', 'read'])
    client.dispose()
  })

  it('SYNC-NET-001 subscribes and acknowledges a canonical edit over a real WebSocket', async () => {
    const runtime = await syncRuntime()
    const socket = await connect(`${runtime.url}/sync/${fileId}?tabId=tab-1`)
    const payloadPromise = nextMessage(socket)
    socket.send(JSON.stringify({ type: 'file.subscribe', protocolVersion: syncProtocolVersion, requestId: 'subscribe-1', fileId, clientId: 'tab-1' }))
    expect(await payloadPromise).toMatchObject({ type: 'file.payload', requestId: 'subscribe-1', payload: { fileId, serverRevision: 0, document: { title: 'Untitled' } } })

    const ackPromise = nextMessage(socket)
    socket.send(JSON.stringify({ type: 'file.edit.batch', protocolVersion: syncProtocolVersion, fileId, clientId: 'tab-1', clientMutationId: 'mutation-1', baseRevision: 0, edits: [{ type: 'set', path: ['title'], value: 'Synced' }] }))
    expect(await ackPromise).toMatchObject({ type: 'file.ack', status: 'applied', clientMutationId: 'mutation-1', serverRevision: 1 })
    expect(await runtime.repository.load(fileId)).toMatchObject({ serverRevision: 1, document: { title: 'Synced' } })
    expect(runtime.calls.length).toBeGreaterThanOrEqual(3)
    expect(runtime.calls.every(call => call.url === '/internal/file-access' && call.method === 'POST' && call.headers['x-canvas-service-token'] === serviceToken && call.headers.authorization === 'Bearer allowed' && call.body && (call.body as any).fileId === fileId)).toBe(true)
    expect(runtime.calls.map(call => (call.body as any).access)).toEqual(['read', 'read', 'write'])
    expect(runtime.calls.every(call => call.headers.cookie === undefined)).toBe(true)
  })

  it('SYNC-NET-SEC-001 rejects wrong origins, malformed routes, and denied sessions before upgrade', async () => {
    const runtime = await syncRuntime()
    expect(await rejectedStatus(`${runtime.url}/sync/${fileId}?tabId=tab-1`, 'Bearer allowed', 'https://attacker.test')).toBe(403)
    expect(await rejectedStatus(`${runtime.url}/wrong/${fileId}?tabId=tab-1`)).toBe(404)
    expect(await rejectedStatus(`${runtime.url}/sync/${fileId}`)).toBe(404)
    expect(await rejectedStatus(`${runtime.url}/sync/${fileId}?tabId=tab-1`, 'Bearer denied')).toBe(401)
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]).toMatchObject({ body: { fileId, access: 'read' } })
  })

  it('SYNC-NET-SEC-001 closes a socket that exceeds the configured message limit', async () => {
    const runtime = await syncRuntime(256)
    const socket = await connect(`${runtime.url}/sync/${fileId}?tabId=tab-1`)
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    socket.send(JSON.stringify({ type: 'file.presence', protocolVersion: 1, fileId, clientId: 'tab-1', sequence: 1, data: { value: 'x'.repeat(1_000) } }))
    expect(await closed).toBe(1009)
    expect((await runtime.repository.load(fileId))?.serverRevision).toBe(0)
  })
})
