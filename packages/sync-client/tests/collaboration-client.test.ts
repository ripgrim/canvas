import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  collaborationDocumentSchemaVersion,
  collaborationEnvelopeSchemaVersion,
  collaborationProtocolEpoch,
  encodeCollaborationMessage,
  maxSnapshotChunkBytes,
} from '@canvas/sync-protocol'
import type { CollaborationClientMessage, CollaborationServerMessage, PresenceState, SemanticFileCommand, ServerRoomEnvelope } from '@canvas/sync-protocol'
import { createCollaborationClient } from '../src/collaboration-client.js'
import type { CollaborationSocketEventMap, CollaborationWebSocket } from '../src/collaboration-client.js'
import { createCollaborationDurableStore } from '../src/collaboration-store.js'
import type { CollaborationDurableStore, CollaborationStoreDriver, StoredCollaborationRoom } from '../src/collaboration-store.js'

const fileId = '11111111-1111-4111-8111-111111111111'
const generationId = '22222222-2222-4222-8222-222222222222'
const secondGenerationId = '33333333-3333-4333-8333-333333333333'
const secondFileId = '44444444-4444-4444-8444-444444444444'

type Document = { title: string }

const noPresence: PresenceState = Object.freeze({ pageId: null, focused: false, selection: null, camera: null, cursor: null })

function participant(clientId: string, subjectId: string, sequence: number | null = null, data = noPresence, issuedPresenceId?: string) {
  const digest = createHash('sha256').update(`${clientId}:${subjectId}`).digest('hex')
  const presenceId = issuedPresenceId ?? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  return { presenceId, clientId, subjectId, displayName: subjectId, avatarUrl: null, role: 'owner' as const, sequence, data }
}

class MockSocket implements CollaborationWebSocket {
  readyState = 0
  failSend: Error | null = null
  readonly sent: string[] = []
  readonly closes: Readonly<{ code?: number; reason?: string }>[] = []
  readonly listeners = new Map<keyof CollaborationSocketEventMap, Set<(event: never) => void>>()

  send(data: string): void { if (this.failSend) throw this.failSend; this.sent.push(data) }
  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException('Invalid WebSocket close code.', 'InvalidAccessError')
    this.readyState = 3
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
  }
  addEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void): void {
    const current = this.listeners.get(type) ?? new Set()
    current.add(listener as (event: never) => void)
    this.listeners.set(type, current)
  }
  removeEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void): void {
    this.listeners.get(type)?.delete(listener as (event: never) => void)
  }
  open(): void { this.readyState = 1; this.emit('open', new Event('open')) }
  server(message: CollaborationServerMessage): void { this.serverData(JSON.stringify(message)) }
  serverData(data: unknown): void { this.emit('message', { data } as MessageEvent<unknown>) }
  serverClose(code = 1006, reason = ''): void { this.readyState = 3; this.emit('close', { code, reason } as CloseEvent) }
  listenerCount(): number { return [...this.listeners.values()].reduce((count, values) => count + values.size, 0) }
  private emit<K extends keyof CollaborationSocketEventMap>(type: K, event: CollaborationSocketEventMap[K]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
}

function envelope(generation = generationId, fenceToken = '9'): ServerRoomEnvelope {
  return {
    protocolEpoch: collaborationProtocolEpoch,
    schemaVersion: collaborationEnvelopeSchemaVersion,
    room: { fileId, generationId: generation },
    fenceToken,
  }
}

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `generated-${index}`
}

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

function validateDocument(value: unknown): Document {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof Reflect.get(value, 'title') !== 'string') throw new Error('Invalid document.')
  return Object.freeze({ title: Reflect.get(value, 'title') as string })
}

function applyCommand(document: Document, command: SemanticFileCommand): Document {
  if (command.type !== 'node.rename' || command.name === null) throw new Error('Unsupported test command.')
  return { ...document, title: command.name }
}

function createMemoryDurableStore() {
  const values = new Map<string, unknown>()
  let chain = Promise.resolve()
  const driver: CollaborationStoreDriver = {
    async read(key) { return structuredClone(values.get(key) ?? null) },
    update(key, updater) {
      const result = chain.then(() => {
        const next = updater(structuredClone(values.get(key) ?? null))
        if (next === null) values.delete(key)
        else values.set(key, structuredClone(next))
      })
      chain = result.then(() => undefined, () => undefined)
      return result
    },
    reserve(room, maxRooms) {
      const result = chain.then(() => {
        const key = JSON.stringify([room.scope.accountId, room.scope.fileId, room.scope.documentSchemaVersion, room.scope.protocolEpoch])
        if (values.has(key)) return
        const rooms = [...values.entries()].filter(entry => {
          const value = entry[1]
          return typeof value === 'object' && value !== null && Reflect.get(Reflect.get(value, 'scope') ?? {}, 'accountId') === room.scope.accountId
        }) as Array<[string, StoredCollaborationRoom]>
        const cleanRooms = rooms.filter(([, value]) => value.pending.length === 0).sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        let roomCount = rooms.length
        while (roomCount >= maxRooms && cleanRooms.length > 0) { values.delete(cleanRooms.shift()![0]); roomCount -= 1 }
        if (roomCount >= maxRooms) throw new Error('Collaboration cache is full of unsaved work.')
        values.set(key, structuredClone(room))
      })
      chain = result.then(() => undefined, () => undefined)
      return result
    },
    async purgeAccount(accountId) {
      for (const [key, value] of values) if (typeof value === 'object' && value !== null && Reflect.get(Reflect.get(value, 'scope') ?? {}, 'accountId') === accountId) values.delete(key)
    },
  }
  return { store: createCollaborationDurableStore(driver), values }
}

function createHarness(input: Readonly<{
  role?: 'owner' | 'viewer'
  ids?: readonly string[]
  maxMessageBytes?: number
  reportError?: (error: unknown, operation: 'room.leave') => void
  durableStore?: CollaborationDurableStore
  cache?: false | Readonly<{ accountId: string; documentSchemaVersion: number }>
}> = {}) {
  const sockets: MockSocket[] = []
  const appliedCommands: SemanticFileCommand[] = []
  const urls: string[] = []
  const protocols: string[] = []
  const timers: Array<Readonly<{ callback: () => void; delay: number; token: ReturnType<typeof setTimeout> }>> = []
  const cancelled = new Set<ReturnType<typeof setTimeout>>()
  const client = createCollaborationClient<Document>({
    syncOrigin: 'ws://127.0.0.1:4321',
    buildId: 'build-1',
    clientId: 'tab-1',
    validateDocument,
    applyCommand(document, command) {
      appliedCommands.push(command)
      return applyCommand(document, command)
    },
    createId: ids(...(input.ids ?? ['request-0001', 'request-0002'])),
    createWebSocket(url, protocol) {
      urls.push(url)
      protocols.push(protocol)
      const socket = new MockSocket()
      sockets.push(socket)
      return socket
    },
    reconnectDelaysMs: [0],
    random: () => 0.5,
    setTimer(callback, delay) {
      const token = Object.freeze({}) as ReturnType<typeof setTimeout>
      timers.push({ callback, delay, token })
      return token
    },
    clearTimer(token) { cancelled.add(token) },
    ...(input.maxMessageBytes === undefined ? {} : { maxMessageBytes: input.maxMessageBytes }),
    ...(input.reportError === undefined ? {} : { reportError: input.reportError }),
    ...(input.durableStore === undefined ? {} : { durableStore: input.durableStore }),
  })

  function openAssigned(index = 0, generation = generationId, fence = '9') {
    const socket = sockets[index]!
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as CollaborationClientMessage
    if (open.type !== 'room.open') throw new Error('Expected room.open.')
    socket.server({ type: 'room.assigned', envelope: envelope(generation, fence), requestId: open.requestId, role: input.role ?? 'owner' })
    return { socket, requestId: open.requestId }
  }

  function streamDocument(socket: MockSocket, requestId: string, document: Document, sequence = '0', room = envelope()) {
    const documentBeforeStream = client.getSnapshot().document
    const text = JSON.stringify(document)
    const bytes = new TextEncoder().encode(text)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const snapshotId = `projection:${sequence}`
    socket.server({ type: 'load.phase', envelope: room, requestId, phase: 'stream' })
    socket.server({
      type: 'snapshot.begin', envelope: room, requestId, snapshotId,
      documentSchemaVersion: collaborationDocumentSchemaVersion, baseSequence: sequence,
      compression: 'none', contentEncoding: 'utf-8', storedByteLength: bytes.byteLength,
      documentByteLength: bytes.byteLength, objectDigest: digest, documentDigest: digest, chunkCount: 1,
    })
    socket.server({ type: 'snapshot.chunk', envelope: room, requestId, snapshotId, chunkIndex: 0, chunkCount: 1, data: Buffer.from(bytes).toString('base64') })
    socket.server({ type: 'snapshot.end', envelope: room, requestId, snapshotId })
    socket.server({ type: 'load.phase', envelope: room, requestId, phase: 'apply' })
    expect(client.getSnapshot().document).toBe(documentBeforeStream)
    socket.server({ type: 'sync.ready', envelope: room, requestId, snapshotId, serverSequence: sequence, role: input.role ?? 'owner' })
  }

  const started = client.start({ fileId, cache: input.cache ?? false })
  return { client, sockets, urls, protocols, timers, cancelled, appliedCommands, openAssigned, streamDocument, started }
}

describe('protocol epoch 2 collaboration client transport', () => {
  it('ERROR-VISIBILITY-001 reports a failed leave frame while still completing local shutdown', () => {
    const reportError = vi.fn()
    const harness = createHarness({ reportError })
    const { socket } = harness.openAssigned()
    const failure = new Error('socket closed during leave')
    socket.failSend = failure

    expect(() => harness.client.stop()).not.toThrow()
    expect(reportError).toHaveBeenCalledWith(failure, 'room.leave')
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'closed', participants: [] })
  })

  it('opens the scoped public route and atomically publishes a verified snapshot', () => {
    const harness = createHarness()
    expect(harness.urls).toEqual([`ws://127.0.0.1:4321/sync/${fileId}?tabId=tab-1`])
    expect(harness.protocols).toEqual(['canvas-sync-v2'])

    const { socket, requestId } = harness.openAssigned()
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'room.open', protocolEpoch: 2, schemaVersion: 1, requestId: 'request-0001', fileId, clientId: 'tab-1', buildId: 'build-1',
    })
    harness.streamDocument(socket, requestId, { title: 'Before' })

    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'live', mode: 'editable', role: 'owner', document: { title: 'Before' }, snapshotId: 'projection:0', serverSequence: '0' })
  })

  it.each([
    ['file', { ...envelope(), room: { fileId: '44444444-4444-4444-8444-444444444444', generationId } }],
    ['generation', envelope(secondGenerationId, '9')],
    ['fence', envelope(generationId, '10')],
  ] as const)('rejects a stale %s scope without changing the document', (_label, staleEnvelope) => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })

    socket.server({ type: 'operation.applied', envelope: staleEnvelope, mutationId: 'mutation-stale', sequence: '1', subjectId: 'other-user', command: { type: 'node.rename', nodeId: 'node-1', name: 'After' } })

    expect(harness.client.getSnapshot().document).toEqual({ title: 'Before' })
    expect(socket.closes.at(-1)?.code).toBe(4008)
    expect(harness.client.getSnapshot().error).toContain('stale collaboration message')
  })

  it('does not publish any part of a snapshot that fails digest verification', () => {
    const harness = createHarness()
    const publishedDocuments: Array<Document | null> = []
    harness.client.subscribe(() => publishedDocuments.push(harness.client.getSnapshot().document))
    const { socket, requestId } = harness.openAssigned()
    const bytes = new TextEncoder().encode('{"title":"Never"}')
    const snapshotId = 'projection:0'
    socket.server({ type: 'load.phase', envelope: envelope(), requestId, phase: 'stream' })
    socket.server({
      type: 'snapshot.begin', envelope: envelope(), requestId, snapshotId,
      documentSchemaVersion: collaborationDocumentSchemaVersion, baseSequence: '0', compression: 'none', contentEncoding: 'utf-8',
      storedByteLength: bytes.byteLength, documentByteLength: bytes.byteLength,
      objectDigest: '0'.repeat(64), documentDigest: '0'.repeat(64), chunkCount: 1,
    })
    socket.server({ type: 'snapshot.chunk', envelope: envelope(), requestId, snapshotId, chunkIndex: 0, chunkCount: 1, data: Buffer.from(bytes).toString('base64') })
    socket.server({ type: 'snapshot.end', envelope: envelope(), requestId, snapshotId })

    expect(harness.client.getSnapshot()).toMatchObject({ document: null, snapshotId: null })
    expect(publishedDocuments.every(document => document === null)).toBe(true)
    expect(socket.closes.at(-1)?.code).toBe(4008)
  })

  it('keeps the visible document, sequence, and pending queue when a reconnect snapshot has a corrupt later chunk', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ ids: ['request-0001', 'request-0002'], durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const first = harness.openAssigned()
    harness.streamDocument(first.socket, first.requestId, { title: 'Before' }, '1')
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const pending = harness.client.submit({
      mutationId: 'local-mutation-0001',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Local' },
    })
    void pending.catch(() => undefined)
    await vi.waitFor(() => expect(harness.client.getSnapshot().pendingMutationIds).toEqual(['local-mutation-0001']))
    first.socket.serverClose(1006, 'Reconnect')
    harness.timers[0]!.callback()

    const second = harness.openAssigned(1, secondGenerationId, '10')
    const room = envelope(secondGenerationId, '10')
    const bytes = new TextEncoder().encode(JSON.stringify({ title: 'S'.repeat(maxSnapshotChunkBytes) }))
    const split = maxSnapshotChunkBytes
    const firstChunk = bytes.slice(0, split)
    const corruptChunk = bytes.slice(split)
    corruptChunk[0] = corruptChunk[0]! ^ 1
    const digest = createHash('sha256').update(bytes).digest('hex')
    const snapshotId = 'projection:2'
    second.socket.server({ type: 'load.phase', envelope: room, requestId: second.requestId, phase: 'stream' })
    second.socket.server({
      type: 'snapshot.begin', envelope: room, requestId: second.requestId, snapshotId,
      documentSchemaVersion: collaborationDocumentSchemaVersion, baseSequence: '2', compression: 'none', contentEncoding: 'utf-8',
      storedByteLength: bytes.byteLength, documentByteLength: bytes.byteLength,
      objectDigest: digest, documentDigest: digest, chunkCount: 2,
    })
    second.socket.server({ type: 'snapshot.chunk', envelope: room, requestId: second.requestId, snapshotId, chunkIndex: 0, chunkCount: 2, data: Buffer.from(firstChunk).toString('base64') })
    second.socket.server({ type: 'snapshot.chunk', envelope: room, requestId: second.requestId, snapshotId, chunkIndex: 1, chunkCount: 2, data: Buffer.from(corruptChunk).toString('base64') })
    second.socket.server({ type: 'snapshot.end', envelope: room, requestId: second.requestId, snapshotId })

    await vi.waitFor(() => expect(second.socket.closes.at(-1)?.code).toBe(4008))
    expect(second.socket.closes.at(-1)?.code).toBe(4008)
    expect(harness.client.getSnapshot()).toMatchObject({
      document: { title: 'Before' },
      serverSequence: '1',
      pendingMutationIds: ['local-mutation-0001'],
    })
  })

  it('publishes typed remote operation metadata with the authoritative document', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({
      type: 'operation.applied',
      envelope: envelope(),
      mutationId: 'remote-mutation-0001',
      sequence: '1',
      subjectId: 'collaborator-1',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Remote' },
    })

    expect(harness.client.getSnapshot()).toMatchObject({
      document: { title: 'Remote' },
      serverSequence: '1',
      lastOperation: {
        source: 'remote',
        mutationId: 'remote-mutation-0001',
        sequence: '1',
        subjectId: 'collaborator-1',
        command: { type: 'node.rename', name: 'Remote' },
      },
    })
  })

  it('suppresses single-player awareness and sends one full state when a collaborator joins', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local')] })

    const sentBeforePresence = socket.sent.length
    harness.client.updatePresence({
      pageId: 'page-1',
      focused: true,
      cursor: { pageId: 'page-1', x: 10, y: 20 },
    })
    expect(harness.timers).toHaveLength(0)
    expect(socket.sent).toHaveLength(sentBeforePresence)

    socket.server({ type: 'presence.join', envelope: envelope(), participant: participant('tab-2', 'user-remote') })
    expect(harness.client.getSnapshot().participants.map(value => value.clientId)).toEqual(['tab-1', 'tab-2'])
    expect(harness.timers.at(-1)?.delay).toBe(0)
    harness.timers.at(-1)!.callback()

    const update = JSON.parse(socket.sent.at(-1)!) as CollaborationClientMessage
    expect(update).toMatchObject({
      type: 'presence.update',
      sequence: 1,
      data: {
        pageId: 'page-1',
        focused: true,
        selection: null,
        camera: null,
        cursor: { pageId: 'page-1', x: 10, y: 20 },
      },
    })
  })

  it('CLOUD-SYNC-AUTH-001 never sends the assigned room authority or client identity in later frames', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    await vi.waitFor(() => expect(harness.client.getSnapshot().participants).toHaveLength(2))
    harness.timers.at(-1)?.callback()
    harness.client.updatePresence({ pageId: 'page-1', focused: true })
    harness.timers.at(-1)!.callback()
    const pending = harness.client.submit({ mutationId: 'mutation-credential-check', command: { type: 'node.rename', nodeId: 'node-1', name: 'After' } })
    await vi.waitFor(() => expect(socket.sent.map(frame => JSON.parse(frame).type)).toContain('operation.submit'))
    harness.client.stop()
    await expect(pending).rejects.toThrow('Collaboration client stopped')

    const laterFrames = socket.sent.slice(1)
    expect(laterFrames.map(frame => JSON.parse(frame).type)).toContain('operation.submit')
    expect(laterFrames.map(frame => JSON.parse(frame).type)).toContain('presence.update')
    expect(laterFrames.map(frame => JSON.parse(frame).type)).toContain('room.leave')
    for (const frame of laterFrames) {
      expect(frame).not.toMatch(/roomTicket|ticket_|token|cookie|authorization|accessEpoch|fenceToken|generationId|clientId/i)
    }
  })

  it('coalesces awareness to a 33Hz frame and ignores stale remote presence', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({
      type: 'presence.roster',
      envelope: envelope(),
      participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote', 2, { ...noPresence, pageId: 'page-1', focused: true })],
    })
    harness.timers.at(-1)!.callback()
    const sentAfterInitialState = socket.sent.length

    harness.client.updatePresence({ pageId: 'page-1', focused: true, cursor: { pageId: 'page-1', x: 1, y: 2 } })
    harness.client.updatePresence({ cursor: { pageId: 'page-1', x: 3, y: 4 } })
    expect(harness.client.getSnapshot().participants.find(value => value.clientId === 'tab-1')?.data.cursor).toEqual({ pageId: 'page-1', x: 3, y: 4 })
    const presenceTimer = harness.timers.at(-1)!
    expect(presenceTimer.delay).toBe(30)
    expect(socket.sent).toHaveLength(sentAfterInitialState)
    presenceTimer.callback()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'presence.update',
      sequence: 2,
      data: { cursor: { pageId: 'page-1', x: 3, y: 4 } },
    })

    socket.server({
      type: 'presence.changed',
      envelope: envelope(),
      participant: participant('tab-2', 'user-remote', 3, { ...noPresence, pageId: 'page-1', focused: true, cursor: { pageId: 'page-1', x: 30, y: 40 } }),
    })
    socket.server({
      type: 'presence.changed',
      envelope: envelope(),
      participant: participant('tab-2', 'user-remote', 2, { ...noPresence, pageId: 'page-1', focused: true, cursor: { pageId: 'page-1', x: 0, y: 0 } }),
    })
    expect(harness.client.getSnapshot().participants.find(value => value.clientId === 'tab-2')?.data.cursor).toEqual({ pageId: 'page-1', x: 30, y: 40 })
  })

  it('CLOUD-SYNC-PRESENCE-001 clears page-scoped awareness when the page changes or becomes null', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    harness.timers.at(-1)!.callback()

    harness.client.updatePresence({
      pageId: 'page-1',
      focused: true,
      selection: { pageId: 'page-1', nodeIds: ['node-1'] },
      camera: { pageId: 'page-1', x: 1, y: 2, zoom: 1 },
      cursor: { pageId: 'page-1', x: 3, y: 4 },
    })
    harness.client.updatePresence({ pageId: 'page-2' })
    expect(harness.client.getSnapshot().participants.find(value => value.clientId === 'tab-1')?.data).toMatchObject({
      pageId: 'page-2', selection: null, camera: null, cursor: null, interaction: null,
    })
    harness.timers.at(-1)!.callback()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'presence.update',
      data: { pageId: 'page-2', selection: null, camera: null, cursor: null, interaction: null },
    })

    harness.client.updatePresence({ pageId: null })
    expect(harness.client.getSnapshot().participants.find(value => value.clientId === 'tab-1')?.data.pageId).toBeNull()
    harness.timers.at(-1)!.callback()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'presence.update', data: { pageId: null } })
  })

  it('streams every gesture transform immediately while cursor-only awareness stays frame limited', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    harness.timers.at(-1)!.callback()
    const before = socket.sent.length
    const base = { interactionId: 'gesture-0001', pageId: 'page-1', kind: 'move' as const, nodeIds: ['node-1'] }
    harness.client.updatePresence({ pageId: 'page-1', interaction: { ...base, transforms: [{ nodeId: 'node-1', dx: 1, dy: 2 }] } }, { immediate: true })
    harness.client.updatePresence({ interaction: { ...base, transforms: [{ nodeId: 'node-1', dx: 3, dy: 4 }] } }, { immediate: true })
    const frames = socket.sent.slice(before).map(value => JSON.parse(value) as CollaborationClientMessage)
    expect(frames).toHaveLength(2)
    expect(frames.map(frame => frame.type === 'presence.update' ? frame.data.interaction?.transforms[0] : null)).toEqual([
      { nodeId: 'node-1', dx: 1, dy: 2 },
      { nodeId: 'node-1', dx: 3, dy: 4 },
    ])
  })

  it('sends interaction frames in single-player mode and waits for the authoritative echo', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    const local = participant('tab-1', 'user-local')
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [local] })
    const before = socket.sent.length
    const interaction = { interactionId: 'gesture-solo-0001', pageId: 'page-1', kind: 'move' as const, nodeIds: ['node-1'], transforms: [{ nodeId: 'node-1', dx: 2, dy: 3 }] }

    harness.client.updatePresence({ pageId: 'page-1', interaction }, { immediate: true })

    expect(socket.sent.slice(before).map(value => JSON.parse(value))).toEqual([expect.objectContaining({
      type: 'presence.update', sequence: 1, data: { pageId: 'page-1', interaction },
    })])
    expect(harness.client.getSnapshot().participants.find(value => value.clientId === 'tab-1')?.data.interaction).toBeUndefined()

    socket.server({
      type: 'presence.changed',
      envelope: envelope(),
      participant: { ...local, sequence: 1, data: { ...local.data, pageId: 'page-1', interaction } },
    })
    expect(harness.client.getSnapshot().participants.find(value => value.clientId === 'tab-1')?.data.interaction).toEqual(interaction)
  })

  it('CLOUD-SYNC-PRESENCE-001 keeps queued cursor traffic frame limited while interactions stream immediately', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    harness.timers.at(-1)!.callback()
    const before = socket.sent.length
    harness.client.updatePresence({ pageId: 'page-1', cursor: { pageId: 'page-1', x: 1, y: 2 } })
    const cursorTimer = harness.timers.at(-1)!
    const interaction = { interactionId: 'gesture-0002', pageId: 'page-1', kind: 'move' as const, nodeIds: ['node-1'], transforms: [{ nodeId: 'node-1', dx: 4, dy: 5 }] }

    harness.client.updatePresence({ interaction }, { immediate: true })

    const immediateFrames = socket.sent.slice(before).map(value => JSON.parse(value) as CollaborationClientMessage)
    expect(immediateFrames).toHaveLength(1)
    expect(immediateFrames[0]).toMatchObject({ type: 'presence.update', data: { interaction } })
    expect(immediateFrames[0]).not.toMatchObject({ data: { cursor: expect.anything() } })
    cursorTimer.callback()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'presence.update', data: { pageId: 'page-1', cursor: { x: 1, y: 2 } } })
  })

  it('CLOUD-SYNC-PRESENCE-001 refuses to bypass the frame limit for cursor traffic', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    harness.timers.at(-1)!.callback()

    expect(() => harness.client.updatePresence({ cursor: { pageId: 'page-1', x: 1, y: 2 } }, { immediate: true })).toThrow('Only interaction presence')
  })

  it('CLOUD-SYNC-GESTURE-001 tears down a failed release and does not replay the stale interaction after reconnect', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    const local = participant('tab-1', 'user-local')
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [local] })
    const interaction = { interactionId: 'gesture-failed-send', pageId: 'page-1', kind: 'move' as const, nodeIds: ['node-1'], transforms: [] }
    harness.client.updatePresence({ pageId: 'page-1', interaction }, { immediate: true })
    socket.failSend = new Error('send failed')

    expect(() => harness.client.updatePresence({ interaction: null }, { immediate: true })).toThrow('send failed')
    expect(socket.closes.at(-1)?.code).toBe(4011)
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', participants: [] })

    harness.timers.at(-1)!.callback()
    const second = harness.openAssigned(1, secondGenerationId, '10')
    harness.streamDocument(second.socket, second.requestId, { title: 'Before' }, '0', envelope(secondGenerationId, '10'))
    second.socket.server({
      type: 'presence.roster',
      envelope: envelope(secondGenerationId, '10'),
      participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')],
    })
    harness.timers.at(-1)!.callback()
    const fullState = JSON.parse(second.socket.sent.at(-1)!) as CollaborationClientMessage
    expect(fullState).toMatchObject({ type: 'presence.update', data: { interaction: null } })
    expect(fullState).not.toMatchObject({ data: { interaction: { interactionId: 'gesture-failed-send' } } })
  })

  it('does not remove a reconnected participant when an old session leave arrives late', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    const oldSession = participant('tab-2', 'user-remote')
    const newSession = { ...participant('tab-2', 'user-remote', null, noPresence, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), displayName: 'Updated remote', avatarUrl: 'https://images.test/updated.png', role: 'viewer' as const }
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), oldSession] })
    socket.server({ type: 'presence.join', envelope: envelope(), participant: newSession })
    expect(harness.client.getSnapshot().participants.filter(value => value.clientId === 'tab-2')).toEqual([newSession])

    socket.server({ type: 'presence.leave', envelope: envelope(), presenceId: oldSession.presenceId, subjectId: oldSession.subjectId, clientId: oldSession.clientId })

    expect(harness.client.getSnapshot().participants.filter(value => value.clientId === 'tab-2')).toEqual([newSession])
  })

  it('rejects a reconnect that reuses a client id for a different subject', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    socket.server({ type: 'presence.join', envelope: envelope(), participant: participant('tab-2', 'different-user', null, noPresence, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') })
    expect(socket.closes.at(-1)?.code).toBe(4008)
    expect(harness.client.getSnapshot().error).toContain('Presence subject changed')
  })

  it('rejects identity changes for active presence and mismatched leave frames', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    const remote = participant('tab-2', 'user-remote', 1)
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), remote] })

    socket.server({
      type: 'presence.changed',
      envelope: envelope(),
      participant: { ...remote, subjectId: 'different-user', sequence: 2 },
    })

    expect(socket.closes.at(-1)?.code).toBe(4008)
    expect(harness.client.getSnapshot()).toMatchObject({ document: { title: 'Before' }, participants: [] })
    expect(harness.client.getSnapshot().error).toContain('Presence identity changed')

    const second = createHarness()
    const opened = second.openAssigned()
    second.streamDocument(opened.socket, opened.requestId, { title: 'Before' })
    opened.socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), remote] })
    opened.socket.server({ type: 'presence.leave', envelope: envelope(), presenceId: remote.presenceId, subjectId: 'different-user', clientId: remote.clientId })

    expect(opened.socket.closes.at(-1)?.code).toBe(4008)
    expect(second.client.getSnapshot()).toMatchObject({ document: { title: 'Before' }, participants: [] })
    expect(second.client.getSnapshot().error).toContain('Presence leave identity')
  })

  it('cancels a queued awareness frame when the connection is lost', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    harness.timers.at(-1)!.callback()
    harness.client.updatePresence({ cursor: { pageId: 'page-1', x: 3, y: 4 } })
    const queued = harness.timers.at(-1)!

    socket.serverClose(1006, 'Network lost')

    expect(harness.cancelled.has(queued.token)).toBe(true)
    const sentBeforeStaleCallback = socket.sent.length
    queued.callback()
    expect(socket.sent).toHaveLength(sentBeforeStaleCallback)
  })

  it('keeps viewers receive-only and clears the roster when the connection is lost', () => {
    const harness = createHarness({ role: 'viewer' })
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    expect(harness.client.getSnapshot().participants).toHaveLength(2)
    expect(() => harness.client.updatePresence({ focused: true })).toThrow('read only')

    socket.serverClose(1006, 'Network lost')
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', participants: [] })
  })

  it('keeps a stable mutation id across a lost ACK and treats duplicate replay as success', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const harness = createHarness({ ids: ['request-0001', 'request-0002'], durableStore: memory.store, cache })
    await harness.started
    const first = harness.openAssigned()
    harness.streamDocument(first.socket, first.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))

    const command = { type: 'node.rename', nodeId: 'node-1', name: 'After' } as SemanticFileCommand
    const receipt = harness.client.submit({ mutationId: 'mutation-0001', command })
    await vi.waitFor(() => expect(first.socket.sent.map(value => JSON.parse(value).type)).toContain('operation.submit'))
    const firstSubmit = JSON.parse(first.socket.sent.at(-1)!) as CollaborationClientMessage
    expect(firstSubmit).toMatchObject({ type: 'operation.submit', operation: { mutationId: 'mutation-0001', baseSequence: '0' } })
    Reflect.set(command, 'name', 'Tampered after submission')
    first.socket.serverClose(1006, 'Lost ACK')
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', pendingMutationIds: ['mutation-0001'] })

    harness.timers[0]!.callback()
    const second = harness.openAssigned(1, secondGenerationId, '10')
    await vi.waitFor(() => expect(second.socket.sent).toHaveLength(2))
    const resume = JSON.parse(second.socket.sent[1]!) as CollaborationClientMessage
    expect(resume).toMatchObject({ type: 'room.resume', afterSequence: '0', pendingMutationIds: ['mutation-0001'] })
    harness.streamDocument(second.socket, second.requestId, { title: 'After' }, '1', envelope(secondGenerationId, '10'))
    await vi.waitFor(() => expect(second.socket.sent.map(value => JSON.parse(value).type)).toContain('operation.submit'))
    const replay = JSON.parse(second.socket.sent.at(-1)!) as CollaborationClientMessage
    expect(replay).toMatchObject({ type: 'operation.submit', operation: { mutationId: 'mutation-0001', baseSequence: '1', command: { name: 'After' } } })
    second.socket.server({ type: 'operation.ack', envelope: envelope(secondGenerationId, '10'), mutationId: 'mutation-0001', sequence: '1', status: 'duplicate' })

    await expect(receipt).resolves.toEqual({ mutationId: 'mutation-0001', sequence: '1', status: 'duplicate' })
    expect(harness.appliedCommands).toHaveLength(0)
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'live', document: { title: 'After' }, serverSequence: '1', pendingMutationIds: [] })
    await vi.waitFor(async () => {
      await expect(memory.store.load({ ...cache, clientId: 'tab-1', fileId, protocolEpoch: collaborationProtocolEpoch })).resolves.toMatchObject({ pending: [] })
    })
  })

  it('uses the caller-owned mutation id and rejects reuse before sending', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))

    const receipt = harness.client.submit({
      mutationId: 'durable-mutation-0001',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'After' },
    })
    await vi.waitFor(() => expect(socket.sent.map(value => JSON.parse(value).type)).toContain('operation.submit'))
    const submission = JSON.parse(socket.sent.at(-1)!) as CollaborationClientMessage
    expect(submission).toMatchObject({
      type: 'operation.submit',
      operation: { mutationId: 'durable-mutation-0001', baseSequence: '0' },
    })
    socket.server({
      type: 'operation.ack',
      envelope: envelope(),
      mutationId: 'durable-mutation-0001',
      sequence: '1',
      status: 'applied',
    })
    await expect(receipt).resolves.toMatchObject({ mutationId: 'durable-mutation-0001' })

    const sentBeforeReuse = socket.sent.length
    await expect(harness.client.submit({
      mutationId: 'durable-mutation-0001',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Different' },
    })).rejects.toThrow('already used')
    expect(socket.sent).toHaveLength(sentBeforeReuse)
  })

  it('does not discard a pending command for an applied acknowledgement at an already visible sequence', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const receipt = harness.client.submit({
      mutationId: 'local-mutation-0001',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Local' },
    })
    await vi.waitFor(() => expect(harness.client.getSnapshot().pendingMutationIds).toEqual(['local-mutation-0001']))
    socket.server({
      type: 'operation.applied',
      envelope: envelope(),
      mutationId: 'remote-mutation-0001',
      sequence: '1',
      subjectId: 'user-remote',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Remote' },
    })

    socket.server({
      type: 'operation.ack',
      envelope: envelope(),
      mutationId: 'local-mutation-0001',
      sequence: '1',
      status: 'applied',
    })

    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(4008))
    expect(socket.closes.at(-1)?.code).toBe(4008)
    expect(harness.client.getSnapshot()).toMatchObject({
      document: { title: 'Remote' },
      serverSequence: '1',
      pendingMutationIds: ['local-mutation-0001'],
    })
    let settled = false
    void receipt.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it('retains queued commands in caller order and advances each base sequence after acknowledgement', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))

    const first = harness.client.submit({
      mutationId: 'durable-mutation-0001',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'First' },
    })
    const second = harness.client.submit({
      mutationId: 'durable-mutation-0002',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Second' },
    })

    await vi.waitFor(() => expect(harness.client.getSnapshot().pendingMutationIds).toEqual([
      'durable-mutation-0001',
      'durable-mutation-0002',
    ]))
    expect(socket.sent.filter(value => JSON.parse(value).type === 'operation.submit')).toHaveLength(1)

    socket.server({
      type: 'operation.ack',
      envelope: envelope(),
      mutationId: 'durable-mutation-0001',
      sequence: '1',
      status: 'applied',
    })
    await expect(first).resolves.toMatchObject({ sequence: '1' })
    const submissions = socket.sent
      .map(value => JSON.parse(value) as CollaborationClientMessage)
      .filter(value => value.type === 'operation.submit')
    expect(submissions).toHaveLength(2)
    expect(submissions[1]).toMatchObject({
      operation: { mutationId: 'durable-mutation-0002', baseSequence: '1' },
    })

    socket.server({
      type: 'operation.ack',
      envelope: envelope(),
      mutationId: 'durable-mutation-0002',
      sequence: '2',
      status: 'applied',
    })
    await expect(second).resolves.toMatchObject({ sequence: '2' })
    expect(harness.client.getSnapshot()).toMatchObject({
      document: { title: 'Second' },
      serverSequence: '2',
      pendingMutationIds: [],
    })
  })

  it('applies a remote command before acknowledging a pending local command', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const local = harness.client.submit({
      mutationId: 'local-mutation-0001',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Local' },
    })
    await vi.waitFor(() => expect(harness.client.getSnapshot().pendingMutationIds).toEqual(['local-mutation-0001']))

    socket.server({
      type: 'operation.applied',
      envelope: envelope(),
      mutationId: 'remote-mutation-0001',
      sequence: '1',
      subjectId: 'collaborator-1',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'Remote' },
    })
    await vi.waitFor(() => expect(harness.client.getSnapshot().serverSequence).toBe('1'))
    expect(harness.client.getSnapshot()).toMatchObject({
      document: { title: 'Remote' },
      serverSequence: '1',
      pendingMutationIds: ['local-mutation-0001'],
    })

    socket.server({
      type: 'operation.rebase_required',
      envelope: envelope(),
      mutationId: 'local-mutation-0001',
      baseSequence: '0',
      authoritativeSequence: '1',
      retry: 'resync',
    })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('reconnecting'))
    expect(harness.client.getSnapshot()).toMatchObject({
      lifecycle: 'reconnecting',
      pendingMutationIds: ['local-mutation-0001'],
    })
    void local.catch(() => undefined)
  })

  it('AT-AUTH-003 keeps an authorized owner recoverable while refreshing an expired transport ticket', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before refresh' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const local = harness.client.submit({
      mutationId: 'ticket-refresh-mutation',
      command: { type: 'node.rename', nodeId: 'node-1', name: 'After refresh' },
    })
    await vi.waitFor(() => expect(harness.client.getSnapshot().pendingMutationIds).toEqual(['ticket-refresh-mutation']))

    socket.server({ type: 'room.error', envelope: envelope(), code: 'draining', message: 'Session refresh required.', retry: 'reconnect', retryAfterMs: 250 })

    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('reconnecting'))
    expect(harness.client.getSnapshot()).toMatchObject({
      lifecycle: 'reconnecting',
      document: { title: 'Before refresh' },
      pendingMutationIds: ['ticket-refresh-mutation'],
    })
    expect(harness.client.getSnapshot().lifecycle).not.toBe('access-revoked')

    harness.timers.at(-1)!.callback()
    const next = harness.openAssigned(1)
    harness.streamDocument(next.socket, next.requestId, { title: 'Before refresh' })
    await vi.waitFor(() => expect(next.socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).some(message => message.type === 'operation.submit' && message.operation.mutationId === 'ticket-refresh-mutation')).toBe(true))
    next.socket.server({ type: 'operation.ack', envelope: envelope(), mutationId: 'ticket-refresh-mutation', sequence: '1', status: 'applied' })

    await expect(local).resolves.toMatchObject({ mutationId: 'ticket-refresh-mutation', sequence: '1', status: 'applied' })
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'live', document: { title: 'After refresh' }, pendingMutationIds: [] })
  })

  it('rejects mutation submission locally when the assigned role is read only', async () => {
    const harness = createHarness({ role: 'viewer' })
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Read only' })
    const sentBefore = socket.sent.length

    await expect(harness.client.submit({ mutationId: 'mutation-0001', command: { type: 'node.rename', nodeId: 'node-1', name: 'Nope' } })).rejects.toThrow('read only')
    expect(socket.sent).toHaveLength(sentBefore)
    expect(harness.client.getSnapshot().lifecycle).toBe('read-only')
  })

  it('rejects an oversized outbound command without retaining or retrying it', async () => {
    const harness = createHarness({ maxMessageBytes: 1024 })
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })

    await expect(harness.client.submit({ mutationId: 'mutation-0001', command: { type: 'node.setText', nodeId: 'node-1', text: 'x'.repeat(2_000) } })).rejects.toThrow('exceeds the byte limit')
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'live', pendingMutationIds: [] })
    expect(harness.timers).toHaveLength(0)
  })

  it('CLOUD-SYNC-REPLAY-001 refuses editable submission when durable storage is unavailable', async () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    const sentBefore = socket.sent.length

    await expect(harness.client.submit({ mutationId: 'mutation-no-store', command: { type: 'node.rename', nodeId: 'node-1', name: 'After' } })).rejects.toThrow('storage is required')
    expect(socket.sent).toHaveLength(sentBefore)
    expect(harness.client.getSnapshot().pendingMutationIds).toEqual([])
  })

  it('CLOUD-SYNC-SCHEMA-001 reserves maximum sequence width before durable enqueue', async () => {
    const command = { type: 'node.setText' as const, nodeId: 'node-1', text: 'x'.repeat(1_000) }
    const mutationId = 'mutation-size-reservation'
    const zeroBytes = new TextEncoder().encode(encodeCollaborationMessage({ type: 'operation.submit', operation: { mutationId, baseSequence: '0', command } })).byteLength
    const maximumBytes = new TextEncoder().encode(encodeCollaborationMessage({ type: 'operation.submit', operation: { mutationId, baseSequence: '9223372036854775807', command } })).byteLength
    expect(maximumBytes).toBeGreaterThan(zeroBytes)
    const memory = createMemoryDurableStore()
    const enqueue = vi.fn(memory.store.enqueue)
    const durableStore: CollaborationDurableStore = { ...memory.store, enqueue }
    const harness = createHarness({
      maxMessageBytes: maximumBytes - 1,
      durableStore,
      cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion },
    })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))

    await expect(harness.client.submit({ mutationId, command })).rejects.toThrow('exceeds the byte limit')
    expect(enqueue).not.toHaveBeenCalled()
    expect(socket.sent.map(value => JSON.parse(value).type)).not.toContain('operation.submit')
  })

  it('CLOUD-SYNC-REPLAY-001 releases a mutation id after durable enqueue fails', async () => {
    const memory = createMemoryDurableStore()
    let enqueueAttempts = 0
    const durableStore: CollaborationDurableStore = {
      ...memory.store,
      async enqueue(scope, mutation) {
        enqueueAttempts += 1
        if (enqueueAttempts === 1) throw new Error('storage unavailable')
        await memory.store.enqueue(scope, mutation)
      },
    }
    const harness = createHarness({ durableStore, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const input = { mutationId: 'mutation-retry-after-store', command: { type: 'node.rename' as const, nodeId: 'node-1', name: 'After' } }

    await expect(harness.client.submit(input)).rejects.toThrow('storage unavailable')
    const retried = harness.client.submit(input)
    await vi.waitFor(() => expect(socket.sent.map(value => JSON.parse(value).type)).toContain('operation.submit'))
    socket.server({ type: 'operation.ack', envelope: envelope(), mutationId: input.mutationId, sequence: '1', status: 'applied' })
    await expect(retried).resolves.toMatchObject({ sequence: '1' })
    expect(enqueueAttempts).toBe(2)
  })

  it('CLOUD-SYNC-CACHE-001 rejects corrupt and mismatched cached state before publication', async () => {
    const repair = vi.fn(async () => undefined)
    const scope = { accountId: 'other-account', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch }
    const durableStore: CollaborationDurableStore = {
      load: async () => ({
        scope,
        checkpoint: { snapshotId: 'projection:7', serverSequence: '7', document: { title: 42 } },
        pending: [{ mutationId: 'mutation-forged', baseSequence: null, command: { operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Leaked' } }, status: 'pending' }],
        updatedAt: Date.now(),
      }),
      repair,
      enqueue: async () => undefined,
      checkpoint: async () => undefined,
      acknowledge: async () => undefined,
      markRecoverable: async () => undefined,
      clearCheckpoint: async () => undefined,
      purgeAccount: async () => undefined,
    }
    const harness = createHarness({
      durableStore,
      cache: { accountId: 'current-account', documentSchemaVersion: collaborationDocumentSchemaVersion },
    })
    await harness.started

    expect(harness.client.getSnapshot()).toMatchObject({ document: null, snapshotId: null, serverSequence: '0', pendingMutationIds: [] })
    expect(repair).toHaveBeenCalledOnce()
  })

  it('CLOUD-SYNC-CACHE-001 drops corrupt checkpoint bytes while retaining independently valid queued work', async () => {
    const repair = vi.fn(async () => undefined)
    const durableStore: CollaborationDurableStore = {
      load: async () => ({
        scope: { accountId: 'current-account', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch },
        checkpoint: { snapshotId: 'projection:7', serverSequence: '7', document: '{not valid document bytes' },
        pending: [{
          mutationId: 'mutation-valid-0001',
          baseSequence: null,
          command: { operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Recovered' } },
          status: 'pending',
        }],
        updatedAt: Date.now(),
      }),
      repair,
      enqueue: async () => undefined,
      checkpoint: async () => undefined,
      acknowledge: async () => undefined,
      markRecoverable: async () => undefined,
      clearCheckpoint: async () => undefined,
      purgeAccount: async () => undefined,
    }
    const harness = createHarness({ durableStore, cache: { accountId: 'current-account', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started

    expect(harness.client.getSnapshot()).toMatchObject({
      document: null,
      snapshotId: null,
      serverSequence: '0',
      pendingMutationIds: ['mutation-valid-0001'],
    })
    expect(repair).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ checkpoint: null, pending: [expect.objectContaining({ mutationId: 'mutation-valid-0001' })] }))
  })

  it('CLOUD-SYNC-CACHE-001 keeps a delayed file A mutation out of file B after switching rooms', async () => {
    const memory = createMemoryDurableStore()
    const enqueueStarted = deferred()
    const releaseEnqueue = deferred()
    const durableStore: CollaborationDurableStore = {
      ...memory.store,
      async enqueue(scope, mutation) {
        enqueueStarted.resolve()
        await releaseEnqueue.promise
        await memory.store.enqueue(scope, mutation)
      },
    }
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const harness = createHarness({ durableStore, cache })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'File A' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))

    const save = harness.client.submit({ mutationId: 'mutation-file-a', command: { type: 'node.rename', nodeId: 'node-1', name: 'Changed A' } })
    await enqueueStarted.promise
    expect(socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(value => value.type === 'operation.submit')).toHaveLength(0)
    harness.client.stop()
    const restarted = harness.client.start({ fileId: secondFileId, cache })
    releaseEnqueue.resolve()

    await expect(save).rejects.toThrow('stopped after the change was saved for recovery')
    await restarted
    expect(harness.client.getSnapshot()).toMatchObject({ fileId: secondFileId, document: null, pendingMutationIds: [] })
    expect(socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(value => value.type === 'operation.submit')).toHaveLength(0)
    expect(harness.sockets[1]!.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(value => value.type === 'operation.submit')).toHaveLength(0)
    await expect(memory.store.load({ accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch })).resolves.toMatchObject({ pending: [{ mutationId: 'mutation-file-a' }] })
    await expect(memory.store.load({ accountId: 'account-a', clientId: 'tab-1', fileId: secondFileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch })).resolves.toBeNull()
  })

  it('CLOUD-SYNC-STATE-001 ignores a delayed file A checkpoint publication after opening file B', async () => {
    const memory = createMemoryDurableStore()
    const checkpointStarted = deferred()
    const releaseCheckpoint = deferred()
    const durableStore: CollaborationDurableStore = {
      ...memory.store,
      async checkpoint(scope, checkpoint) {
        checkpointStarted.resolve()
        await releaseCheckpoint.promise
        await memory.store.checkpoint(scope, checkpoint)
      },
    }
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const harness = createHarness({ durableStore, cache })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'File A' })
    await checkpointStarted.promise

    harness.client.stop()
    const restarted = harness.client.start({ fileId: secondFileId, cache })
    releaseCheckpoint.resolve()
    await restarted

    expect(harness.client.getSnapshot()).toMatchObject({ fileId: secondFileId, document: null, snapshotId: null, pendingMutationIds: [] })
    await expect(memory.store.load({ accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch })).resolves.toMatchObject({ checkpoint: { document: { title: 'File A' } } })
  })

  it('CLOUD-SYNC-CACHE-001 clears revoked checkpoint disclosure while retaining unsent work for recovery', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const harness = createHarness({ durableStore: memory.store, cache })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Private' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const save = harness.client.submit({ mutationId: 'mutation-revoked', command: { type: 'node.rename', nodeId: 'node-1', name: 'Unsaved' } })
    await vi.waitFor(() => expect(harness.client.getSnapshot().pendingMutationIds).toEqual(['mutation-revoked']))

    socket.server({ type: 'room.error', envelope: envelope(), code: 'access_revoked', message: 'Access was removed.', retry: 'none' })
    await expect(save).rejects.toThrow('Access was removed.')
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'access-revoked', document: null, snapshotId: null, recoverableMutationIds: ['mutation-revoked'] })
    await vi.waitFor(async () => {
      await expect(memory.store.load({ accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch })).resolves.toMatchObject({
        checkpoint: null,
        pending: [{ mutationId: 'mutation-revoked', status: 'recoverable' }],
      })
    })
  })

  it('CLOUD-SYNC-REPLAY-001 retains durable work across stop and replays it in original order after restart', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const first = createHarness({ durableStore: memory.store, cache })
    await first.started
    const firstRoom = first.openAssigned()
    first.streamDocument(firstRoom.socket, firstRoom.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(first.client.getSnapshot().lifecycle).toBe('live'))

    const firstReceipt = first.client.submit({ mutationId: 'durable-mutation-0001', command: { type: 'node.rename', nodeId: 'node-1', name: 'First' } })
    const secondReceipt = first.client.submit({ mutationId: 'durable-mutation-0002', command: { type: 'node.rename', nodeId: 'node-1', name: 'Second' } })
    void firstReceipt.catch(() => undefined)
    void secondReceipt.catch(() => undefined)
    await vi.waitFor(() => expect(first.client.getSnapshot().pendingMutationIds).toEqual(['durable-mutation-0001', 'durable-mutation-0002']))
    await vi.waitFor(async () => {
      await expect(memory.store.load({
        accountId: 'account-a',
        clientId: 'tab-1',
        fileId,
        documentSchemaVersion: collaborationDocumentSchemaVersion,
        protocolEpoch: collaborationProtocolEpoch,
      })).resolves.toMatchObject({
        pending: [
          { mutationId: 'durable-mutation-0001' },
          { mutationId: 'durable-mutation-0002' },
        ],
      })
    })
    first.client.stop()

    const second = createHarness({ durableStore: memory.store, cache, ids: ['request-restart-0001'] })
    await second.started
    expect(second.client.getSnapshot()).toMatchObject({
      document: { title: 'Before' },
      snapshotId: 'projection:0',
      pendingMutationIds: ['durable-mutation-0001', 'durable-mutation-0002'],
    })
    const secondRoom = second.openAssigned()
    await vi.waitFor(() => expect(secondRoom.socket.sent.some(value => (JSON.parse(value) as CollaborationClientMessage).type === 'room.resume')).toBe(true))
    second.streamDocument(secondRoom.socket, secondRoom.requestId, { title: 'Before' })
    await vi.waitFor(() => {
      const submissions = secondRoom.socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(value => value.type === 'operation.submit')
      expect(submissions).toHaveLength(1)
      expect(submissions[0]).toMatchObject({ operation: { mutationId: 'durable-mutation-0001' } })
    })
    secondRoom.socket.server({ type: 'operation.ack', envelope: envelope(), mutationId: 'durable-mutation-0001', sequence: '1', status: 'applied' })
    await vi.waitFor(() => {
      const submissions = secondRoom.socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(value => value.type === 'operation.submit')
      expect(submissions.at(-1)).toMatchObject({ operation: { mutationId: 'durable-mutation-0002', baseSequence: '1' } })
    })
    secondRoom.socket.server({ type: 'operation.ack', envelope: envelope(), mutationId: 'durable-mutation-0002', sequence: '2', status: 'applied' })
    await vi.waitFor(() => expect(second.client.getSnapshot()).toMatchObject({ document: { title: 'Second' }, serverSequence: '2', pendingMutationIds: [] }))
  })

  it('does not reconnect after a terminal compatibility failure', () => {
    const harness = createHarness()
    const socket = harness.sockets[0]!
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as CollaborationClientMessage
    if (open.type !== 'room.open') throw new Error('Expected room.open.')

    socket.server({ type: 'request.error', protocolEpoch: 2, schemaVersion: 1, requestId: open.requestId, code: 'incompatible_build', message: 'Update required.', retry: 'refresh' })

    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'incompatible-build', error: 'Update required.' })
    expect(harness.timers).toHaveLength(0)
    expect(socket.closes.at(-1)?.code).toBe(4008)
  })

  it('CLOUD-SYNC-STATE-001 closes and restarts after a terminal capacity refusal', async () => {
    const harness = createHarness()
    const firstSocket = harness.sockets[0]!
    firstSocket.open()
    const firstOpen = JSON.parse(firstSocket.sent[0]!) as CollaborationClientMessage
    if (firstOpen.type !== 'room.open') throw new Error('Expected room.open.')

    firstSocket.server({
      type: 'request.error', protocolEpoch: 2, schemaVersion: 1, requestId: firstOpen.requestId,
      code: 'capacity_refused', message: 'This room is full.', retry: 'retry', retryAfterMs: 250,
    })
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'capacity-refused', error: 'This room is full.' })

    harness.client.stop()
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'closed' })
    await harness.client.start({ fileId, cache: false })
    expect(harness.sockets).toHaveLength(2)
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'authorizing', error: null })
  })

  it('removes socket listeners, cancels reconnect timers, and closes on dispose', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.serverClose(1006, 'Network lost')
    expect(harness.timers).toHaveLength(1)
    expect(socket.listenerCount()).toBe(0)

    harness.client.dispose()

    expect(harness.cancelled).toContain(harness.timers[0]!.token)
    expect(harness.client.getSnapshot()).toMatchObject({ disposed: true, lifecycle: 'closed' })
    expect(() => harness.client.start({ fileId, cache: false })).toThrow('disposed')

    const active = createHarness()
    const activeSocket = active.sockets[0]!
    expect(activeSocket.listenerCount()).toBe(4)
    active.client.dispose()
    expect(activeSocket.listenerCount()).toBe(0)
    expect(activeSocket.closes.at(-1)).toMatchObject({ code: 1000 })
  })

  it.each([
    ['binary', new Uint8Array([1, 2, 3]), 4003],
    ['oversized', 'x'.repeat(1025), 4009],
  ] as const)('rejects %s socket input before protocol handling', (_label, data, expectedCloseCode) => {
    const harness = createHarness({ maxMessageBytes: 1024 })
    const socket = harness.sockets[0]!
    socket.open()
    socket.serverData(data)

    expect(socket.closes.at(-1)?.code).toBe(expectedCloseCode)
    expect(harness.client.getSnapshot().document).toBeNull()
  })
})
