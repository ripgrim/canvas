import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createRevisionSyncClient, SyncClientConflictError, SyncClientMessageTooLargeError } from '../src/index'
import type { SyncClientSnapshot, SyncWebSocket } from '../src/index'

type Document = { title: string; count?: number }

const sockets: WebSocket[] = []
const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(servers.splice(0).map(server => server.close()))
})

function waitFor<T>(read: () => T, ready: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const inspect = () => {
      const value = read()
      if (ready(value)) { resolve(value); return }
      if (Date.now() - started > timeoutMs) { reject(new Error('Timed out waiting for sync state.')); return }
      setTimeout(inspect, 5)
    }
    inspect()
  })
}

async function webSocketFixture(receive: (socket: WebSocket, message: Record<string, unknown>) => void, connected?: (socket: WebSocket, url: string) => void) {
  const server = createServer()
  const webSockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, webSocket => {
      sockets.push(webSocket)
      connected?.(webSocket, request.url ?? '')
      webSocket.on('message', data => receive(webSocket, JSON.parse(data.toString()) as Record<string, unknown>))
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const close = async () => {
    for (const socket of webSockets.clients) socket.terminate()
    webSockets.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  servers.push({ close })
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function browserSocket(url: string): SyncWebSocket {
  return new WebSocket(url) as unknown as SyncWebSocket
}

function state(client: ReturnType<typeof createRevisionSyncClient<Document>>): SyncClientSnapshot<Document> {
  return client.getSnapshot()
}

describe('revision sync client', () => {
  it('CLOUD-SYNC-CLIENT-001 performs catch-up, applies remote edits, and commits only after an ACK over a real WebSocket', async () => {
    const frames: Record<string, unknown>[] = []
    const origin = await webSocketFixture((socket, message) => {
      frames.push(message)
      if (message.type === 'file.subscribe') socket.send(JSON.stringify({
        type: 'file.catchup', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', fromRevision: 0, serverRevision: 1,
        batches: [{ fileId: 'file-1', subjectId: 'other', clientId: 'tab-other', clientMutationId: 'remote-1', baseRevision: 0, serverRevision: 1, edits: [{ type: 'set', path: ['title'], value: 'Caught up' }], committedAt: '2026-10-09T00:00:00.000Z' }],
      }))
      if (message.type === 'file.edit.batch') socket.send(JSON.stringify({ type: 'file.ack', protocolVersion: 1, fileId: 'file-1', clientMutationId: message.clientMutationId, baseRevision: 2, serverRevision: 3, status: 'applied' }))
    }, socket => {
      setTimeout(() => socket.send(JSON.stringify({
        type: 'file.edit.applied', protocolVersion: 1,
        batch: { fileId: 'file-1', subjectId: 'other', clientId: 'tab-other', clientMutationId: 'remote-2', baseRevision: 1, serverRevision: 2, edits: [{ type: 'set', path: ['title'], value: 'Remote' }], committedAt: '2026-10-09T00:00:01.000Z' },
      })), 25)
    })
    const client = createRevisionSyncClient<Document>({ syncOrigin: origin, createWebSocket: browserSocket, validateDocument: value => value as Document, createId: (() => { let value = 0; return () => `id-${++value}` })() })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    expect(await waitFor(() => state(client), value => value.status === 'ready' && value.revision === 2)).toMatchObject({ document: { title: 'Remote' }, revision: 2 })
    const saving = client.submit([{ type: 'set', path: ['title'], value: 'Saved' }], 2)
    expect(state(client).document).toEqual({ title: 'Remote' })
    await expect(saving).resolves.toMatchObject({ status: 'ready', revision: 3, document: { title: 'Saved' } })
    expect(frames).toEqual([
      expect.objectContaining({ type: 'file.subscribe', afterRevision: 0 }),
      expect.objectContaining({ type: 'file.edit.batch', baseRevision: 2 }),
    ])
    client.dispose()
  })

  it('CLOUD-SYNC-CONFLICT-001 surfaces a stale revision and never applies the rejected local edit', async () => {
    const origin = await webSocketFixture((socket, message) => {
      if (message.type === 'file.subscribe') socket.send(JSON.stringify({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', serverRevision: 0 }))
      if (message.type === 'file.edit.batch') socket.send(JSON.stringify({ type: 'file.conflict', protocolVersion: 1, fileId: 'file-1', clientMutationId: message.clientMutationId, baseRevision: 0, serverRevision: 1, code: 'stale_revision', retry: 'resubscribe' }))
    })
    const client = createRevisionSyncClient<Document>({ syncOrigin: origin, createWebSocket: browserSocket, validateDocument: value => value as Document, createId: () => crypto.randomUUID() })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Canonical' } })
    await waitFor(() => state(client), value => value.status === 'ready')
    await expect(client.submit([{ type: 'set', path: ['title'], value: 'Rejected' }], 0)).rejects.toBeInstanceOf(SyncClientConflictError)
    expect(state(client)).toMatchObject({ status: 'conflict', revision: 0, document: { title: 'Canonical' }, conflict: { baseRevision: 0, serverRevision: 1 } })
    client.dispose()
  })

  it('CLOUD-SYNC-CLIENT-001 recovers an applied mutation when the acknowledgement is lost', async () => {
    let connection = 0
    let mutationId = ''
    let editFrames = 0
    const origin = await webSocketFixture((socket, message) => {
      if (message.type === 'file.subscribe' && connection === 1) socket.send(JSON.stringify({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', serverRevision: 0 }))
      if (message.type === 'file.edit.batch' && connection === 1) {
        editFrames += 1
        mutationId = String(message.clientMutationId)
        socket.close(1012, 'ACK lost')
      }
      if (message.type === 'file.subscribe' && connection === 2) socket.send(JSON.stringify({
        type: 'file.catchup', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', fromRevision: 0, serverRevision: 1,
        batches: [{ fileId: 'file-1', subjectId: 'self', clientId: 'tab-1', clientMutationId: mutationId, baseRevision: 0, serverRevision: 1, edits: [{ type: 'set', path: ['title'], value: 'Saved once' }], committedAt: '2026-10-09T00:00:00.000Z' }],
      }))
    }, () => { connection += 1 })
    const client = createRevisionSyncClient<Document>({ syncOrigin: origin, createWebSocket: browserSocket, validateDocument: value => value as Document, reconnectDelaysMs: [0], createId: (() => { let value = 0; return () => `id-${++value}` })() })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    await waitFor(() => state(client), value => value.status === 'ready')
    await expect(client.submit([{ type: 'set', path: ['title'], value: 'Saved once' }], 0)).resolves.toMatchObject({ revision: 1, document: { title: 'Saved once' } })
    expect(editFrames).toBe(1)
    expect(connection).toBe(2)
    client.dispose()
  })

  it('CLOUD-SYNC-CLIENT-001 rejects a discontinuous catch-up atomically without acknowledging a pending save', async () => {
    let connection = 0
    let mutationId = ''
    const origin = await webSocketFixture((socket, message) => {
      if (message.type === 'file.subscribe' && connection === 1) socket.send(JSON.stringify({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', serverRevision: 0 }))
      if (message.type === 'file.edit.batch' && connection === 1) { mutationId = String(message.clientMutationId); socket.close(1012, 'ACK lost') }
      if (message.type === 'file.subscribe' && connection === 2) socket.send(JSON.stringify({
        type: 'file.catchup', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', fromRevision: 0, serverRevision: 3,
        batches: [
          { fileId: 'file-1', subjectId: 'self', clientId: 'tab-1', clientMutationId: mutationId, baseRevision: 0, serverRevision: 1, edits: [{ type: 'set', path: ['title'], value: 'Must not land' }], committedAt: '2026-10-09T00:00:00.000Z' },
          { fileId: 'file-1', subjectId: 'other', clientId: 'tab-2', clientMutationId: 'broken', baseRevision: 2, serverRevision: 3, edits: [{ type: 'set', path: ['title'], value: 'Broken' }], committedAt: '2026-10-09T00:00:01.000Z' },
        ],
      }))
    }, () => { connection += 1 })
    const client = createRevisionSyncClient<Document>({ syncOrigin: origin, createWebSocket: browserSocket, validateDocument: value => value as Document, reconnectDelaysMs: [0], createId: (() => { let value = 0; return () => `id-${++value}` })() })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    await waitFor(() => state(client), value => value.status === 'ready')
    await expect(client.submit([{ type: 'set', path: ['title'], value: 'Must not land' }], 0)).rejects.toThrow('discontinuous')
    expect(state(client)).toMatchObject({ status: 'error', revision: 0, document: { title: 'Initial' } })
    client.dispose()
  })

  it('CLOUD-SYNC-AUTH-001 puts only scoped file and tab identifiers in the URL and exposes no header or token input', async () => {
    const urls: string[] = []
    const origin = await webSocketFixture((socket, message) => {
      if (message.type === 'file.subscribe') socket.send(JSON.stringify({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', serverRevision: 0 }))
    })
    const factory = vi.fn((url: string) => { urls.push(url); return browserSocket(url) })
    const client = createRevisionSyncClient<Document>({ syncOrigin: origin, createWebSocket: factory, validateDocument: value => value as Document, createId: () => 'request-1' })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    await waitFor(() => state(client), value => value.status === 'ready')
    expect(urls).toEqual([`${origin}/sync/file-1?tabId=tab-1`])
    expect(urls[0]).not.toMatch(/token|authorization|cookie|session/i)
    expect(factory.mock.calls[0]).toHaveLength(1)
    client.dispose()
  })

  it('CLOUD-SYNC-LIFECYCLE-001 bounds reconnects and dispose removes scheduled and socket work', async () => {
    let connections = 0
    const origin = await webSocketFixture(() => undefined, socket => { connections += 1; socket.close(1012, 'Restart') })
    const client = createRevisionSyncClient<Document>({ syncOrigin: origin, createWebSocket: browserSocket, validateDocument: value => value as Document, reconnectDelaysMs: [0, 0], createId: () => crypto.randomUUID() })
    const snapshots: SyncClientSnapshot<Document>[] = []
    const unsubscribe = client.subscribe(() => snapshots.push(client.getSnapshot()))
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    await waitFor(() => state(client), value => value.status === 'error')
    expect(connections).toBe(3)
    expect(state(client).error).toBe('Live sync could not reconnect.')
    const delivered = snapshots.length
    client.dispose()
    unsubscribe()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(connections).toBe(3)
    expect(snapshots).toHaveLength(delivered + 1)
    expect(state(client).status).toBe('disposed')
  })

  it('CLOUD-SYNC-LIFECYCLE-001 rejects an oversized edit before send without starting a reconnect loop', async () => {
    let editFrames = 0
    const origin = await webSocketFixture((socket, message) => {
      if (message.type === 'file.subscribe') socket.send(JSON.stringify({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: 'file-1', serverRevision: 0 }))
      if (message.type === 'file.edit.batch') editFrames += 1
    })
    const client = createRevisionSyncClient<Document>({ syncOrigin: origin, createWebSocket: browserSocket, validateDocument: value => value as Document, maxMessageBytes: 256, reconnectDelaysMs: [0], createId: () => crypto.randomUUID() })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    await waitFor(() => state(client), value => value.status === 'ready')
    await expect(client.submit([{ type: 'set', path: ['title'], value: 'x'.repeat(1_000) }], 0)).rejects.toBeInstanceOf(SyncClientMessageTooLargeError)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(editFrames).toBe(0)
    expect(state(client)).toMatchObject({ status: 'ready', revision: 0, reconnectAttempt: 0, document: { title: 'Initial' } })
    client.dispose()
  })
})
