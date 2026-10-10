import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { SyncWebSocket, WebSocketEventMap } from '@canvas/sync-client'
import { createCloudAdapter } from './cloud'

const metadata = {
  id: '11111111-2222-4333-8444-555555555555', projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: 'thumbnails/11111111-2222-4333-8444-555555555555/thumbnail.avif',
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
}
const document = createBlankFile(metadata.id, 'page_cloud', 'root_cloud', 'Page 1')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

class ScriptedSocket implements SyncWebSocket {
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<keyof WebSocketEventMap, Set<(event: never) => void>>()
  onSend: (message: Record<string, unknown>) => void = () => undefined

  constructor() { queueMicrotask(() => { this.readyState = 1; this.emit('open', new Event('open')) }) }
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void) {
    let listeners = this.listeners.get(type)
    if (!listeners) { listeners = new Set(); this.listeners.set(type, listeners) }
    listeners.add(listener as (event: never) => void)
  }
  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void) { this.listeners.get(type)?.delete(listener as (event: never) => void) }
  send(data: string) { const message = JSON.parse(data) as Record<string, unknown>; this.sent.push(message); this.onSend(message) }
  close() { this.readyState = 3 }
  message(value: unknown) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) })) }
  private emit<K extends keyof WebSocketEventMap>(type: K, event: WebSocketEventMap[K]) { for (const listener of this.listeners.get(type) ?? []) listener(event as never) }
}

const waitFor = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (ready()) return; await new Promise(resolve => setTimeout(resolve, 1)) }
  throw new Error('Timed out waiting for the scripted socket.')
}

describe('cloud adapter', () => {
  it('lists, creates, opens, and saves the account file through the fixed cloud API', async () => {
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/api/files') && init?.method === 'POST') return json({ file: metadata }, 201)
      if (url.endsWith('/api/files')) return json({ files: [metadata] })
      if (url.endsWith('/document') && init?.method === 'PUT') return json({ fileId: metadata.id, revision: 1, document: { ...document, revision: 1 } })
      if (url.endsWith('/document')) return json({ fileId: metadata.id, revision: 0, document })
      return json({ file: metadata })
    }) as typeof fetch
    const adapter = createCloudAdapter({ apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test', fetch: fetcher })
    expect(await adapter.listFiles?.()).toEqual([{ id: metadata.id, name: metadata.name, location: 'Cloud', updatedAt: metadata.updatedAt, thumbnailUrl: 'https://assets.canvas.test/file-assets/thumbnails/11111111-2222-4333-8444-555555555555' }])
    expect((await adapter.createFile?.())?.id).toBe(metadata.id)
    const opened = await adapter.openFile?.(metadata.id)
    expect(opened?.file).toEqual(document)
    const saved = await adapter.saveFile({ ...document, revision: 0 }, 0)
    expect(saved.file?.revision).toBe(1)
    expect(calls).toContain('PUT https://api.canvas.test/api/files/11111111-2222-4333-8444-555555555555/document')
  })

  it('rejects mismatched file and revision responses', async () => {
    const mismatched = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/document')
        ? json({ fileId: metadata.id, revision: 2, document })
        : json({ file: metadata })) as typeof fetch,
    })
    await expect(mismatched.openFile?.(metadata.id)).rejects.toThrow('mismatched document revisions')
  })

  it('gates the cloud workspace on the hosted session and opens the dedicated login app', async () => {
    const navigated: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      loginOrigin: 'https://login.canvas.test',
      navigate: url => navigated.push(url),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/api/session')) return json({ error: { code: 'unauthorized', message: 'Sign in required.' } }, 401)
        if (String(input).endsWith('/api/auth/sign-out') && init?.method === 'POST') return json({ success: true })
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })
    const auth = adapter.auth
    expect(auth).toBeDefined()
    if (!auth) throw new Error('Cloud auth was not configured')
    expect((await auth.getSession()).status).toBe('signed-out')
    expect((await auth.signInWithGitHub()).status).toBe('signing-in')
    expect(navigated).toEqual(['https://login.canvas.test'])
    expect((await auth.signOut()).status).toBe('signed-out')
  })

  it('CLOUD-SYNC-EDITOR-001 suppresses the acknowledged self echo and publishes the next remote update', async () => {
    const sockets: ScriptedSocket[] = []
    const calls: string[] = []
    const remoteSnapshots: number[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      syncOrigin: 'wss://sync.canvas.test',
      syncClientId: 'tab-1',
      createWebSocket: url => {
        expect(url).toBe(`wss://sync.canvas.test/sync/${metadata.id}?tabId=tab-1`)
        const socket = new ScriptedSocket()
        socket.onSend = message => {
          if (message.type === 'file.subscribe') socket.message({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: metadata.id, serverRevision: 0 })
          if (message.type === 'file.edit.batch') socket.message({ type: 'file.ack', protocolVersion: 1, fileId: metadata.id, clientMutationId: message.clientMutationId, baseRevision: 0, serverRevision: 1, status: 'applied' })
        }
        sockets.push(socket)
        return socket
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/document')) return json({ fileId: metadata.id, revision: 0, document })
        return json({ file: metadata })
      }) as typeof fetch,
    })
    adapter.subscribeFile?.(snapshot => remoteSnapshots.push(snapshot.file.revision))
    await adapter.openFile?.(metadata.id)
    await waitFor(() => sockets[0]?.sent.some(message => message.type === 'file.subscribe') ?? false)
    const saved = await adapter.saveFile(document, 0)
    expect(saved.file.revision).toBe(1)
    expect(calls.some(call => call.startsWith('PUT '))).toBe(false)
    sockets[0]!.message({
      type: 'file.edit.applied', protocolVersion: 1,
      batch: { fileId: metadata.id, subjectId: 'other', clientId: 'tab-2', clientMutationId: 'remote-1', baseRevision: 1, serverRevision: 2, edits: [{ type: 'set', path: ['revision'], value: 2 }, { type: 'set', path: ['pages', 0, 'name'], value: 'Remote page' }], committedAt: '2026-10-09T00:00:00.000Z' },
    })
    expect(remoteSnapshots).toEqual([2])
    expect((await adapter.refresh()).file).toMatchObject({ revision: 2, pages: [{ name: 'Remote page' }] })
  })

  it('CLOUD-SYNC-CONFLICT-001 rejects a stale save so the document controller keeps the unsaved local file', async () => {
    let socket: ScriptedSocket | null = null
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1',
      createWebSocket: () => {
        socket = new ScriptedSocket()
        socket.onSend = message => {
          if (message.type === 'file.subscribe') socket!.message({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: metadata.id, serverRevision: 0 })
          if (message.type === 'file.edit.batch') socket!.message({ type: 'file.conflict', protocolVersion: 1, fileId: metadata.id, clientMutationId: message.clientMutationId, baseRevision: 0, serverRevision: 1, code: 'stale_revision', retry: 'resubscribe' })
        }
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/document') ? json({ fileId: metadata.id, revision: 0, document }) : json({ file: metadata })) as typeof fetch,
    })
    await adapter.openFile?.(metadata.id)
    await waitFor(() => socket?.sent.some(message => message.type === 'file.subscribe') ?? false)
    await expect(adapter.saveFile({ ...document, revision: 1 }, 0)).rejects.toThrow('This file changed in another session')
  })

  it('CLOUD-SYNC-EDITOR-001 lets only the newest overlapping open activate live sync', async () => {
    const firstMetadata = { ...metadata, id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'First' }
    const secondMetadata = { ...metadata, id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'Second' }
    const firstDocument = createBlankFile(firstMetadata.id, 'page_first', 'root_first', 'First')
    const secondDocument = createBlankFile(secondMetadata.id, 'page_second', 'root_second', 'Second')
    const firstGate = deferred<Response>()
    const socketUrls: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1',
      createWebSocket: url => {
        socketUrls.push(url)
        const socket = new ScriptedSocket()
        socket.onSend = message => { if (message.type === 'file.subscribe') socket.message({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: secondMetadata.id, serverRevision: 0 }) }
        return socket
      },
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        const isDocument = url.endsWith('/document')
        if (url.includes(firstMetadata.id)) return isDocument ? firstGate.promise : json({ file: firstMetadata })
        if (url.includes(secondMetadata.id)) return isDocument ? json({ fileId: secondMetadata.id, revision: 0, document: secondDocument }) : json({ file: secondMetadata })
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })
    const firstOpen = adapter.openFile?.(firstMetadata.id)
    const secondOpen = adapter.openFile?.(secondMetadata.id)
    await secondOpen
    firstGate.resolve(json({ fileId: firstMetadata.id, revision: 0, document: firstDocument }))
    await firstOpen
    await waitFor(() => socketUrls.length > 0)
    expect(socketUrls).toEqual([`wss://sync.canvas.test/sync/${secondMetadata.id}?tabId=tab-1`])
    adapter.dispose()
  })

  it('CLOUD-SYNC-LIFECYCLE-001 does not activate an open that finishes after disposal', async () => {
    const responseGate = deferred<Response>()
    const socketUrls: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1',
      createWebSocket: url => { socketUrls.push(url); return new ScriptedSocket() },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/document') ? responseGate.promise : json({ file: metadata })) as typeof fetch,
    })
    const opening = adapter.openFile?.(metadata.id)
    adapter.dispose()
    responseGate.resolve(json({ fileId: metadata.id, revision: 0, document }))
    await opening
    expect(socketUrls).toEqual([])
    expect(adapter.subscribeFile?.(() => undefined)).toBeTypeOf('function')
  })

  it('falls back to the revision-checked document API when one live edit cannot fit the sync frame', async () => {
    const calls: string[] = []
    const sockets: ScriptedSocket[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1', syncMaxMessageBytes: 1,
      createWebSocket: () => {
        const socket = new ScriptedSocket()
        socket.onSend = message => { if (message.type === 'file.subscribe') socket.message({ type: 'file.ready', protocolVersion: 1, requestId: message.requestId, fileId: metadata.id, serverRevision: sockets.length === 1 ? 0 : 1 }) }
        sockets.push(socket)
        return socket
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/document') && init?.method === 'PUT') return json({ fileId: metadata.id, revision: 1, document: { ...document, revision: 1 } })
        if (url.endsWith('/document')) return json({ fileId: metadata.id, revision: 0, document })
        return json({ file: metadata })
      }) as typeof fetch,
    })
    await adapter.openFile?.(metadata.id)
    await waitFor(() => sockets[0]?.sent.some(message => message.type === 'file.subscribe') ?? false)
    expect((await adapter.saveFile(document, 0)).file.revision).toBe(1)
    expect(calls).toContain(`PUT https://api.canvas.test/api/files/${metadata.id}/document`)
    expect(sockets).toHaveLength(2)
    adapter.dispose()
  })
})
