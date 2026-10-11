import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createRevisionSyncClient, SyncClientConflictError, SyncClientMessageTooLargeError } from '../src/index'
import type { SyncClientSnapshot, SyncWebSocket, WebSocketEventMap } from '../src/index'

type Document = { title: string; count?: number }

const sockets: WebSocket[] = []
const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  vi.useRealTimers()
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

class TestSocket implements SyncWebSocket {
  readyState = 0
  readonly sent: string[] = []
  readonly closed: Array<{ code: number | undefined; reason: string | undefined }> = []
  private readonly listeners = new Map<keyof WebSocketEventMap, Set<(event: never) => void>>()

  send(data: string) { this.sent.push(data) }

  close(code?: number, reason?: string) {
    this.readyState = 3
    this.closed.push({ code, reason })
  }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener as (event: never) => void)
    this.listeners.set(type, listeners)
  }

  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void) {
    this.listeners.get(type)?.delete(listener as (event: never) => void)
  }

  open() {
    this.readyState = 1
    this.emit('open', new Event('open'))
  }

  serverMessage(data: unknown) {
    this.emit('message', new MessageEvent('message', { data }))
  }

  serverClose(code: number, reason = '') {
    this.readyState = 3
    this.emit('close', { code, reason } as CloseEvent)
  }

  private emit<K extends keyof WebSocketEventMap>(type: K, event: WebSocketEventMap[K]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
}

class TestLifecycleTarget {
  private readonly listeners = new Map<'online' | 'offline' | 'visibilitychange', Set<() => void>>()

  addEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: 'online' | 'offline' | 'visibilitychange') {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

function readyTestSocket(socket: TestSocket) {
  socket.open()
  const subscribe = JSON.parse(socket.sent.at(-1)!) as { requestId: string }
  socket.serverMessage(JSON.stringify({ type: 'file.ready', protocolVersion: 1, requestId: subscribe.requestId, fileId: 'file-1', serverRevision: 0 }))
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

  it('CLOUD-SYNC-LIFECYCLE-002 keeps retrying past the configured delay table and ignores stale sockets', async () => {
    vi.useFakeTimers()
    const created: TestSocket[] = []
    const client = createRevisionSyncClient<Document>({
      syncOrigin: 'ws://127.0.0.1:4321',
      createWebSocket: () => { const socket = new TestSocket(); created.push(socket); return socket },
      validateDocument: value => value as Document,
      reconnectDelaysMs: [1, 2],
      random: () => 0.5,
      createId: () => crypto.randomUUID(),
    })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    for (let index = 0; index < 7; index += 1) {
      const current = created.at(-1)!
      current.serverClose(1012, 'Restart')
      await vi.advanceTimersByTimeAsync(index === 0 ? 1 : 2)
    }
    expect(created).toHaveLength(8)
    expect(state(client)).toMatchObject({ status: 'reconnecting', reconnectAttempt: 7, error: null })

    const current = created.at(-1)!
    const stale = created[0]!
    stale.serverClose(1012, 'Stale close')
    stale.serverMessage('not-json')
    await vi.advanceTimersByTimeAsync(10)
    expect(created.at(-1)).toBe(current)
    expect(state(client).error).toBeNull()

    client.dispose()
    const count = created.length
    await vi.runAllTimersAsync()
    expect(created).toHaveLength(count)
    expect(state(client).status).toBe('disposed')
  })

  it('CLOUD-SYNC-LIFECYCLE-002 uses raw ping and pong frames and reconnects when the pong is missing', async () => {
    vi.useFakeTimers()
    const created: TestSocket[] = []
    const client = createRevisionSyncClient<Document>({
      syncOrigin: 'ws://127.0.0.1:4321',
      createWebSocket: () => { const socket = new TestSocket(); created.push(socket); return socket },
      validateDocument: value => value as Document,
      reconnectDelaysMs: [10],
      random: () => 0.5,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 25,
      createId: () => crypto.randomUUID(),
    })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    const first = created[0]!
    readyTestSocket(first)
    await vi.advanceTimersByTimeAsync(100)
    expect(first.sent.at(-1)).toBe('ping')
    first.serverMessage('pong')
    await vi.advanceTimersByTimeAsync(99)
    expect(first.sent.filter(frame => frame === 'ping')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(first.sent.filter(frame => frame === 'ping')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(25)
    expect(first.closed).toContainEqual({ code: 4000, reason: 'Heartbeat timeout' })
    expect(created).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(created).toHaveLength(2)
    expect(first.sent.filter(frame => frame === 'ping')).toHaveLength(2)
    client.dispose()
  })

  it('CLOUD-SYNC-LIFECYCLE-002 jitters reconnects and does not retry terminal authorization failures', async () => {
    vi.useFakeTimers()
    const lifecycle = new TestLifecycleTarget()
    const created: TestSocket[] = []
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
    const client = createRevisionSyncClient<Document>({
      syncOrigin: 'ws://127.0.0.1:4321',
      createWebSocket: () => { const socket = new TestSocket(); created.push(socket); return socket },
      validateDocument: value => value as Document,
      lifecycleTarget: lifecycle,
      reconnectDelaysMs: [100],
      random,
      createId: () => crypto.randomUUID(),
    })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    created[0]!.serverClose(1012, 'Restart')
    await vi.advanceTimersByTimeAsync(49)
    expect(created).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(created).toHaveLength(2)

    created[1]!.serverClose(1012, 'Restart')
    await vi.advanceTimersByTimeAsync(149)
    expect(created).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(created).toHaveLength(3)

    created[2]!.serverClose(4403, 'Untrusted server reason')
    lifecycle.dispatch('online')
    lifecycle.dispatch('visibilitychange')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(created).toHaveLength(3)
    expect(state(client)).toMatchObject({ status: 'error', error: 'You no longer have access to this file.' })
    client.dispose()
  })

  it('CLOUD-SYNC-LIFECYCLE-002 pauses while offline, probes on visibility, and removes lifecycle listeners on dispose', async () => {
    vi.useFakeTimers()
    const lifecycle = new TestLifecycleTarget()
    const created: TestSocket[] = []
    let online = true
    let visible = true
    const client = createRevisionSyncClient<Document>({
      syncOrigin: 'ws://127.0.0.1:4321',
      createWebSocket: () => { const socket = new TestSocket(); created.push(socket); return socket },
      validateDocument: value => value as Document,
      lifecycleTarget: lifecycle,
      isOnline: () => online,
      isVisible: () => visible,
      reconnectDelaysMs: [1],
      random: () => 0.5,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 25,
      createId: () => crypto.randomUUID(),
    })
    client.start({ fileId: 'file-1', clientId: 'tab-1', revision: 0, document: { title: 'Initial' } })
    readyTestSocket(created[0]!)

    online = false
    lifecycle.dispatch('offline')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(created).toHaveLength(1)
    expect(state(client).status).toBe('reconnecting')

    online = true
    visible = false
    lifecycle.dispatch('online')
    expect(created).toHaveLength(2)
    readyTestSocket(created[1]!)
    await vi.advanceTimersByTimeAsync(500)
    expect(created[1]!.sent).not.toContain('ping')

    visible = true
    lifecycle.dispatch('visibilitychange')
    await vi.advanceTimersByTimeAsync(0)
    expect(created[1]!.sent.at(-1)).toBe('ping')

    client.dispose()
    const count = created.length
    lifecycle.dispatch('online')
    lifecycle.dispatch('visibilitychange')
    await vi.runAllTimersAsync()
    expect(created).toHaveLength(count)
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
