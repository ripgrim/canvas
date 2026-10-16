import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  collaborationDocumentSchemaVersion,
  collaborationEnvelopeSchemaVersion,
  collaborationProtocolEpoch,
  encodeCollaborationMessage,
  maxSnapshotChunkBytes,
} from '@canvas/sync-protocol'
import type { CollaborationClientMessage, CollaborationServerMessage, FlowDragPresentation, FlowDragSlot, FlowDragTopologyAuthority, PresenceState, SemanticFileCommand, ServerRoomEnvelope } from '@canvas/sync-protocol'
import { createCollaborationClient } from '../src/collaboration-client.js'
import type { CollaborationClientLifecycleTarget, CollaborationSocketEventMap, CollaborationWebSocket } from '../src/collaboration-client.js'
import { createCollaborationDurableStore } from '../src/collaboration-store.js'
import type { CollaborationDurableStore, CollaborationStoreDriver, StoredCollaborationRoom } from '../src/collaboration-store.js'

const fileId = '11111111-1111-4111-8111-111111111111'
const generationId = '22222222-2222-4222-8222-222222222222'
const secondGenerationId = '33333333-3333-4333-8333-333333333333'
const secondFileId = '44444444-4444-4444-8444-444444444444'
const replayScopeId = 'a'.repeat(64)
const leaseId = '55555555-5555-4555-8555-555555555555'
const secondLeaseId = '66666666-6666-4666-8666-666666666666'
const peerInteractionId = (serverLeaseId: string) => `lease:${serverLeaseId}`

type Document = { title: string }

const noPresence: PresenceState = Object.freeze({ pageId: null, focused: false, selection: null, camera: null, cursor: null })

const flowGeometry = (x: number, y: number) => ({
  coordinateSpace: 'world' as const,
  quad: [{ x, y }, { x: x + 100, y }, { x: x + 100, y: y + 80 }, { x, y: y + 80 }] as const,
  aabb: { x, y, width: 100, height: 80 },
  semanticSize: { width: 100, height: 80 },
})

function flowPresentation(input: Readonly<{
  interactionId?: string
  sequence?: number
  gestureGeneration?: number
  sourceNodeId?: string
  sourceParentId?: string
  sourceSlot?: FlowDragSlot
  targetParentId?: string | null
  terminal?: boolean
}> = {}): FlowDragPresentation {
  const interactionId = input.interactionId ?? 'flow-interaction'
  const gestureGeneration = input.gestureGeneration ?? 1
  const sequence = input.sequence ?? 1
  const sourceNodeId = input.sourceNodeId ?? 'source-node'
  const sourceParentId = input.sourceParentId ?? 'source-frame'
  const sourceSlot = input.sourceSlot ?? { presence: 'absent' as const }
  const source = flowGeometry(0, 0)
  const current = flowGeometry(10, 20)
  const relationship = { parentId: sourceParentId, orderKey: 'V', slot: sourceSlot }
  const targetParentId = input.targetParentId === undefined ? 'target-frame' : input.targetParentId
  return Object.freeze({
    kind: 'flow-drag', coordinateSpace: 'world', identity: { interactionId, gestureGeneration, sampleSequence: sequence },
    fence: { fileId, fileRevision: 0, measurementRevision: 1, documentRevision: 0, layoutGeneration: 1, pageId: 'page-1', pageRootId: 'root-1' },
    retention: input.terminal
      ? { kind: 'terminal-retained', gestureGeneration, sampleSequence: sequence, terminalReason: 'pointer-up', terminalSampleSequence: sequence, holdUntil: 'authoritative-geometry' }
      : { kind: 'active', gestureGeneration, sampleSequence: sequence },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
    original: {
      documentNodeId: sourceNodeId, kind: 'rectangle', name: 'Source node', sourceRelationship: relationship, sourceIndex: 0,
      mode: 'flow', source, current, sourceOffsetParentPose: null,
      dom: { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null },
      namePresentation: { visible: true, anchor: 'source', pose: source },
    },
    movingVisual: { kind: 'fill-ghost', documentNodeId: null, geometry: current, fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden' },
    supportClone: null,
    target: targetParentId === null ? null : {
      parentId: targetParentId, slot: { presence: 'absent' }, rawIndex: 0, semanticIndex: 0, line: 0,
      parentOutline: targetParentId === sourceParentId ? null : {
        coordinateSpace: 'world', quad: [{ x: 400, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 200 }, { x: 400, y: 200 }],
        aabb: { x: 400, y: 0, width: 300, height: 200 }, color: 'oklch(0.67 0.17 258)', widthCssPx: 2,
      },
      insertionGuide: null,
    },
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
  }) as FlowDragPresentation
}

const trustedFlowAuthority: FlowDragTopologyAuthority = Object.freeze({
  fileId,
  fileRevision: 0,
  pageId: 'page-1',
  pageRootId: 'root-1',
  source(nodeId) {
    if (nodeId !== 'source-node' && nodeId !== 'alternate-source') return null
    return Object.freeze({
      kind: 'rectangle' as const,
      relationship: Object.freeze({ parentId: 'source-frame', orderKey: 'V', slot: Object.freeze({ presence: 'absent' as const }) }),
      sourceIndex: 0,
    })
  },
  acceptsTarget(target) {
    return target.sourceNodeId === 'source-node' || target.sourceNodeId === 'alternate-source'
      ? target.targetLane.parentId === 'target-frame' && target.targetLane.slot.presence === 'absent'
        && target.rawIndex === 0 && target.semanticIndex === 0 && target.line === 0
      : false
  },
})

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

class MockLifecycleTarget implements CollaborationClientLifecycleTarget {
  readonly listeners = new Map<'online' | 'offline' | 'visibilitychange', Set<() => void>>()

  addEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void): void {
    const current = this.listeners.get(type) ?? new Set()
    current.add(listener)
    this.listeners.set(type, current)
  }
  removeEventListener(type: 'online' | 'offline' | 'visibilitychange', listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: 'online' | 'offline' | 'visibilitychange'): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
  snapshot(type: 'online' | 'offline' | 'visibilitychange'): readonly (() => void)[] {
    return [...(this.listeners.get(type) ?? [])]
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
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
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  maxPreAdmissionFailures?: number
  socketFactoryFailures?: number
  failSocketSendOnCreate?: boolean
  lifecycleTarget?: CollaborationClientLifecycleTarget | null
  isOnline?: () => boolean
  isVisible?: () => boolean
}> = {}) {
  const sockets: MockSocket[] = []
  const appliedCommands: SemanticFileCommand[] = []
  const urls: string[] = []
  const protocols: string[] = []
  const timers: Array<Readonly<{ callback: () => void; delay: number; token: ReturnType<typeof setTimeout> }>> = []
  const cancelled = new Set<ReturnType<typeof setTimeout>>()
  let socketFactoryCalls = 0
  const client = createCollaborationClient<Document>({
    syncOrigin: 'ws://127.0.0.1:4321',
    buildId: 'build-1',
    clientId: 'tab-1',
    validateDocument,
    applyCommand(document, command) {
      appliedCommands.push(command)
      return applyCommand(document, command)
    },
    resolveFlowAuthority(_document, pageId) { return pageId === 'page-1' ? trustedFlowAuthority : null },
    createId: ids(...(input.ids ?? ['request-0001', 'request-0002'])),
    createWebSocket(url, protocol) {
      socketFactoryCalls += 1
      urls.push(url)
      protocols.push(protocol)
      if (socketFactoryCalls <= (input.socketFactoryFailures ?? 0)) throw new Error('socket factory failed')
      const socket = new MockSocket()
      if (input.failSocketSendOnCreate === true) socket.failSend = new Error('room.open send failed')
      sockets.push(socket)
      return socket
    },
    reconnectDelaysMs: [0],
    random: () => 0.5,
    ...(input.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: input.heartbeatIntervalMs }),
    ...(input.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: input.heartbeatTimeoutMs }),
    ...(input.maxPreAdmissionFailures === undefined ? {} : { maxPreAdmissionFailures: input.maxPreAdmissionFailures }),
    ...(input.lifecycleTarget === undefined ? { lifecycleTarget: null } : { lifecycleTarget: input.lifecycleTarget }),
    ...(input.isOnline === undefined ? {} : { isOnline: input.isOnline }),
    ...(input.isVisible === undefined ? {} : { isVisible: input.isVisible }),
    setTimer(callback, delay) {
      const token = Object.freeze({}) as ReturnType<typeof setTimeout>
      if (delay !== 15_000) timers.push({ callback, delay, token })
      return token
    },
    clearTimer(token) { cancelled.add(token) },
    ...(input.maxMessageBytes === undefined ? {} : { maxMessageBytes: input.maxMessageBytes }),
    ...(input.reportError === undefined ? {} : { reportError: input.reportError }),
    ...(input.durableStore === undefined ? {} : { durableStore: input.durableStore }),
  })

  function openAssigned(index = 0, generation = generationId, fence = '9', assignedReplayScopeId = replayScopeId) {
    const socket = sockets[index]!
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as CollaborationClientMessage
    if (open.type !== 'room.open') throw new Error('Expected room.open.')
    socket.server({ type: 'room.assigned', envelope: envelope(generation, fence), requestId: open.requestId, role: input.role ?? 'owner', replayScopeId: assignedReplayScopeId })
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

describe('protocol epoch 4 collaboration client transport', () => {
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
    expect(harness.protocols).toEqual(['canvas-sync-v4'])

    const { socket, requestId } = harness.openAssigned()
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'room.open', protocolEpoch: collaborationProtocolEpoch, schemaVersion: 1, requestId: 'request-0001', fileId, clientId: 'tab-1', buildId: 'build-1',
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

  it('CLOUD-FILES-001 surfaces a deterministic stored-document validation failure without reconnecting forever', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    const bytes = new TextEncoder().encode('{}')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const snapshotId = 'projection:0'
    socket.server({ type: 'load.phase', envelope: envelope(), requestId, phase: 'stream' })
    socket.server({
      type: 'snapshot.begin', envelope: envelope(), requestId, snapshotId,
      documentSchemaVersion: collaborationDocumentSchemaVersion, baseSequence: '0', compression: 'none', contentEncoding: 'utf-8',
      storedByteLength: bytes.byteLength, documentByteLength: bytes.byteLength,
      objectDigest: digest, documentDigest: digest, chunkCount: 1,
    })
    socket.server({ type: 'snapshot.chunk', envelope: envelope(), requestId, snapshotId, chunkIndex: 0, chunkCount: 1, data: Buffer.from(bytes).toString('base64') })
    socket.server({ type: 'snapshot.end', envelope: envelope(), requestId, snapshotId })

    expect(harness.client.getSnapshot()).toMatchObject({
      lifecycle: 'connection-failed',
      document: null,
      snapshotId: null,
      error: 'This file contains invalid data. Error ID: invalid-file-document',
    })
    expect(harness.timers).toHaveLength(0)
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
      pageId: 'page-2', selection: null, camera: null, cursor: null,
    })
    harness.timers.at(-1)!.callback()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'presence.update',
      data: { pageId: 'page-2', selection: null, camera: null, cursor: null },
    })

    harness.client.updatePresence({ pageId: null })
    expect(harness.client.getSnapshot().participants.find(value => value.clientId === 'tab-1')?.data.pageId).toBeNull()
    harness.timers.at(-1)!.callback()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'presence.update', data: { pageId: null } })
  })

  it('CLOUD-SYNC-PRESENCE-001 refuses to bypass the frame limit for cursor traffic', () => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    harness.timers.at(-1)!.callback()

    expect(() => harness.client.updatePresence({ cursor: { pageId: 'page-1', x: 1, y: 2 } }, { immediate: true })).toThrow('frame limited')
  })

  it('CLOUD-SYNC-CLIENT-001-C3A resolves explicit acquire denial and a release queued before grant', async () => {
    const deniedHarness = createHarness()
    const deniedRoom = deniedHarness.openAssigned()
    deniedHarness.streamDocument(deniedRoom.socket, deniedRoom.requestId, { title: 'Before' })
    const denied = deniedHarness.client.acquireInteraction({ presentation: flowPresentation() })
    deniedRoom.socket.server({
      type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'denied', interactionId: denied.claim.interactionId,
      leaseId: null, localClaimGeneration: denied.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: 'overlap',
    })
    await expect(denied.result).resolves.toMatchObject({ status: 'denied', denialCode: 'overlap' })
    expect(deniedHarness.client.getFlowClaims()).toEqual([])

    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const request = harness.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'queued-release' }) })
    const release = harness.client.releaseInteraction({ claim: request.claim, terminalSampleSequence: 1, reason: 'cancelled' })
    expect(room.socket.sent.map(value => JSON.parse(value).type).filter(type => type.startsWith('interaction.'))).toEqual(['interaction.acquire'])
    room.socket.server({
      type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: request.claim.interactionId,
      leaseId, localClaimGeneration: request.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null,
    })
    await expect(request.result).resolves.toMatchObject({ status: 'granted', leaseId })
    expect(JSON.parse(room.socket.sent.at(-1)!)).toMatchObject({ type: 'interaction.release', leaseId, localClaimGeneration: request.claim.localClaimGeneration })
    room.socket.server({
      type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'release', status: 'released', interactionId: request.claim.interactionId,
      leaseId, localClaimGeneration: request.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null,
    })
    await expect(release).resolves.toMatchObject({ action: 'release', status: 'released' })
  })

  it('CLOUD-SYNC-PRESENCE-001-C3A streams samples separately without flushing queued cursor awareness', async () => {
    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    room.socket.server({ type: 'presence.roster', envelope: envelope(), participants: [participant('tab-1', 'user-local'), participant('tab-2', 'user-remote')] })
    harness.client.updatePresence({ pageId: 'page-1', cursor: { pageId: 'page-1', x: 9, y: 10 } })
    const cursorTimer = harness.timers.at(-1)!
    const request = harness.client.acquireInteraction({ presentation: flowPresentation() })
    const acquireFrame = JSON.parse(room.socket.sent.at(-1)!)
    expect(acquireFrame).toMatchObject({ type: 'interaction.acquire' })
    expect(acquireFrame).not.toHaveProperty('data.cursor')
    room.socket.server({
      type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: request.claim.interactionId,
      leaseId, localClaimGeneration: request.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null,
    })
    await request.result
    harness.client.sampleInteraction({ claim: request.claim, presentation: flowPresentation({ sequence: 2 }) })
    expect(JSON.parse(room.socket.sent.at(-1)!)).toMatchObject({ type: 'interaction.sample', presentation: { identity: { sampleSequence: 2 } } })
    cursorTimer.callback()
    expect(JSON.parse(room.socket.sent.at(-1)!)).toMatchObject({ type: 'presence.update', data: { cursor: { x: 9, y: 10 } } })
  })

  it('PAPER-FLEX-007-C3A advances reservations only from an exact explicit server result', async () => {
    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const acquire = harness.client.acquireInteraction({ presentation: flowPresentation() })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: acquire.claim.interactionId,
      leaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await acquire.result
    const reserve = harness.client.reserveInteraction({ claim: acquire.claim, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } }, presentation: flowPresentation({ sequence: 2 }) })
    expect(JSON.parse(room.socket.sent.at(-1)!)).toMatchObject({ type: 'interaction.reserve', reservationGeneration: 2, targetLane: { parentId: 'target-frame' } })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'reserve', status: 'granted', interactionId: acquire.claim.interactionId,
      leaseId: secondLeaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 2, sampleSequence: 2, denialCode: null })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'reserve', status: 'granted', interactionId: acquire.claim.interactionId,
      leaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 2, denialCode: null })
    expect(harness.client.getFlowClaims()[0]).toMatchObject({ reservationGeneration: 2, sampleSequence: 2, latestAcceptedPresentation: { identity: { sampleSequence: 1 } } })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'reserve', status: 'retained', interactionId: acquire.claim.interactionId,
      leaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 2, sampleSequence: 2, denialCode: null })
    await expect(reserve).resolves.toMatchObject({ action: 'reserve', status: 'retained', reservationGeneration: 2 })
    expect(harness.client.getFlowClaims()[0]).toMatchObject({ currentTargetLane: { parentId: 'target-frame' }, latestAcceptedPresentation: { identity: { sampleSequence: 2 } } })
  })

  it('PAPER-FLEX-007-C3A rejects an overlapping reservation without stranding the active waiter', async () => {
    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const acquire = harness.client.acquireInteraction({ presentation: flowPresentation() })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: acquire.claim.interactionId,
      leaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await acquire.result
    const first = harness.client.reserveInteraction({ claim: acquire.claim, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } }, presentation: flowPresentation({ sequence: 2 }) })
    await expect(harness.client.reserveInteraction({ claim: acquire.claim, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } }, presentation: flowPresentation({ sequence: 3 }) })).rejects.toThrow('already pending')
    expect(room.socket.sent.map(value => JSON.parse(value)).filter(value => value.type === 'interaction.reserve')).toHaveLength(1)
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'reserve', status: 'granted', interactionId: acquire.claim.interactionId,
      leaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 2, sampleSequence: 2, denialCode: null })
    await expect(first).resolves.toMatchObject({ action: 'reserve', status: 'granted', reservationGeneration: 2 })
  })

  it('PAPER-FLEX-007-C3A hydrates remote leases and emits each accepted peer sample without owner echo', async () => {
    const events: unknown[] = []
    const harness = createHarness()
    const unsubscribe = harness.client.subscribeRemoteFlow(event => events.push(event))
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const remotePresentation = flowPresentation({ interactionId: peerInteractionId(leaseId) })
    room.socket.server({
      type: 'interaction.roster', envelope: envelope(), interactions: [{ pageId: 'page-1', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-2', leaseId,
        localClaimGeneration: 1, reservationGeneration: 1, presentation: remotePresentation }],
    })
    expect(harness.client.getSnapshot().remoteInteractions).toHaveLength(1)
    expect(events).toHaveLength(1)
    room.socket.server({
      type: 'interaction.sample', envelope: envelope(), pageId: 'page-1', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-2', leaseId,
      localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ interactionId: peerInteractionId(leaseId), sequence: 2 }),
    })
    room.socket.server({
      type: 'interaction.sample', envelope: envelope(), pageId: 'page-1', presenceId: 'local-presence', subjectId: 'local-user', clientId: 'tab-1', leaseId: secondLeaseId,
      localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ interactionId: peerInteractionId(secondLeaseId), sequence: 2 }),
    })
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'sample', source: 'live', sample: { presentation: { identity: { sampleSequence: 2 } } } })
    unsubscribe()
  })

  it('PAPER-FLEX-007-C3A fails closed when a peer lease changes its interaction or source identity', () => {
    const events: unknown[] = []
    const harness = createHarness()
    harness.client.subscribeRemoteFlow(event => events.push(event))
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    room.socket.server({
      type: 'interaction.roster', envelope: envelope(), interactions: [{ pageId: 'page-1', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-2', leaseId,
        localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ interactionId: peerInteractionId(leaseId) }) }],
    })
    room.socket.server({
      type: 'interaction.sample', envelope: envelope(), pageId: 'page-1', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-2', leaseId,
      localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ interactionId: peerInteractionId(leaseId), sourceNodeId: 'alternate-source', sequence: 2 }),
    })
    room.socket.server({
      type: 'interaction.sample', envelope: envelope(), pageId: 'page-1', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-2', leaseId,
      localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ interactionId: peerInteractionId(secondLeaseId), sequence: 3 }),
    })
    expect(events).toHaveLength(1)
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', remoteInteractions: [] })
    expect(room.socket.closes.at(-1)?.code).toBe(4008)
  })

  it('CLOUD-SYNC-CLIENT-001-C3A rejects flow topology that is not authorized by the current document', async () => {
    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const valid = flowPresentation()
    const forged = {
      ...valid,
      original: { ...valid.original, sourceRelationship: { ...valid.original.sourceRelationship, parentId: 'forged-parent' } },
    } as FlowDragPresentation
    const request = harness.client.acquireInteraction({ presentation: forged })
    await expect(request.result).rejects.toThrow('Interaction send failed')
    expect(room.socket.closes.at(-1)?.code).toBe(4011)
  })

  it('CLOUD-SYNC-GESTURE-001-C3A closes with 4011 when release transport fails and clears ephemeral flow state', async () => {
    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const request = harness.client.acquireInteraction({ presentation: flowPresentation() })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: request.claim.interactionId,
      leaseId, localClaimGeneration: request.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await request.result
    room.socket.failSend = new Error('release failed')
    const release = harness.client.releaseInteraction({ claim: request.claim, terminalSampleSequence: 1, reason: 'cancelled' })
    await expect(release).rejects.toThrow('Interaction send failed')
    expect(room.socket.closes.at(-1)?.code).toBe(4011)
    expect(harness.client.getFlowClaims()).toEqual([])
    expect(harness.client.getSnapshot().remoteInteractions).toEqual([])
  })

  it('CLOUD-SYNC-GESTURE-001-C3A ignores stale results and keeps newer claims when an older claim release is denied', async () => {
    const harness = createHarness()
    const results: unknown[] = []
    harness.client.subscribeInteractionResults(result => results.push(result))
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const first = harness.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'multi-claim' }) })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'wrong-page', action: 'acquire', status: 'granted', interactionId: first.claim.interactionId,
      leaseId, localClaimGeneration: first.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: first.claim.interactionId,
      leaseId, localClaimGeneration: first.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 2, denialCode: null })
    expect(results).toEqual([])
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: first.claim.interactionId,
      leaseId, localClaimGeneration: first.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await first.result

    const second = harness.client.acquireInteraction({ leaseId, presentation: flowPresentation({ interactionId: 'multi-claim', sequence: 2 }) })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: second.claim.interactionId,
      leaseId, localClaimGeneration: second.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 2, denialCode: null })
    await second.result
    const releaseFirst = harness.client.releaseInteraction({ claim: first.claim, terminalSampleSequence: 1, reason: 'cancelled' })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'release', status: 'denied', interactionId: first.claim.interactionId,
      leaseId, localClaimGeneration: first.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: 'stale_generation' })
    await expect(releaseFirst).resolves.toMatchObject({ status: 'denied', denialCode: 'stale_generation' })
    expect(harness.client.getFlowClaims().map(value => value.claim.localClaimGeneration)).toContain(second.claim.localClaimGeneration)
  })

  it('CLOUD-SYNC-GESTURE-001-C3A a successful release settles only its exact local claim generation', async () => {
    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const first = harness.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'multi-release' }) })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: first.claim.interactionId,
      leaseId, localClaimGeneration: first.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await first.result
    const second = harness.client.acquireInteraction({ leaseId, presentation: flowPresentation({ interactionId: 'multi-release', sequence: 2 }) })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'retained', interactionId: second.claim.interactionId,
      leaseId, localClaimGeneration: second.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 2, denialCode: null })
    await second.result
    const release = harness.client.releaseInteraction({ claim: first.claim, terminalSampleSequence: 1, reason: 'cancelled' })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'release', status: 'released', interactionId: first.claim.interactionId,
      leaseId, localClaimGeneration: first.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await release
    expect(harness.client.getFlowClaims().map(value => value.claim.localClaimGeneration)).toEqual([second.claim.localClaimGeneration])
  })

  it('CLOUD-SYNC-CLIENT-001-C3A rejects flow waiters and ignores callbacks from the old socket after reconnect', async () => {
    const harness = createHarness()
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    const oldMessage = [...room.socket.listeners.get('message')!][0]!
    const request = harness.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'old-socket' }) })
    room.socket.serverClose(1006, 'lost')
    await expect(request.result).rejects.toThrow('lost')
    harness.timers.at(-1)!.callback()
    const second = harness.openAssigned(1, secondGenerationId, '10')
    harness.streamDocument(second.socket, second.requestId, { title: 'Before' }, '0', envelope(secondGenerationId, '10'))
    ;(oldMessage as unknown as (event: MessageEvent<unknown>) => void)({ data: JSON.stringify({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: request.claim.interactionId,
      leaseId, localClaimGeneration: request.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null }) } as MessageEvent<unknown>)
    expect(harness.client.getFlowClaims()).toEqual([])
  })

  it('CLOUD-SYNC-CLIENT-001-C3A settles failed acquire and reserve sends and tears down a failed sample send', async () => {
    const acquireHarness = createHarness()
    const acquireRoom = acquireHarness.openAssigned()
    acquireHarness.streamDocument(acquireRoom.socket, acquireRoom.requestId, { title: 'Before' })
    acquireRoom.socket.failSend = new Error('acquire failed')
    const acquire = acquireHarness.client.acquireInteraction({ presentation: flowPresentation() })
    await expect(acquire.result).rejects.toThrow('Interaction send failed')
    expect(acquireRoom.socket.closes.at(-1)?.code).toBe(4011)

    const reserveHarness = createHarness()
    const reserveRoom = reserveHarness.openAssigned()
    reserveHarness.streamDocument(reserveRoom.socket, reserveRoom.requestId, { title: 'Before' })
    const reserveAcquire = reserveHarness.client.acquireInteraction({ presentation: flowPresentation() })
    reserveRoom.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: reserveAcquire.claim.interactionId,
      leaseId, localClaimGeneration: reserveAcquire.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await reserveAcquire.result
    reserveRoom.socket.failSend = new Error('reserve failed')
    const reserve = reserveHarness.client.reserveInteraction({ claim: reserveAcquire.claim, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } }, presentation: flowPresentation({ sequence: 2 }) })
    await expect(reserve).rejects.toThrow('Interaction send failed')
    expect(reserveRoom.socket.closes.at(-1)?.code).toBe(4011)

    const sampleHarness = createHarness()
    const sampleRoom = sampleHarness.openAssigned()
    sampleHarness.streamDocument(sampleRoom.socket, sampleRoom.requestId, { title: 'Before' })
    const sampleAcquire = sampleHarness.client.acquireInteraction({ presentation: flowPresentation() })
    sampleRoom.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: sampleAcquire.claim.interactionId,
      leaseId, localClaimGeneration: sampleAcquire.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await sampleAcquire.result
    sampleRoom.socket.failSend = new Error('sample failed')
    expect(() => sampleHarness.client.sampleInteraction({ claim: sampleAcquire.claim, presentation: flowPresentation({ sequence: 2 }) })).toThrow('sample failed')
    expect(sampleRoom.socket.closes.at(-1)?.code).toBe(4011)
  })

  it('CLOUD-SYNC-REPLAY-001-C3A quarantines an interaction-bound mutation across reconnect until an exact fresh binding is supplied', async () => {
    const memory = createMemoryDurableStore()
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-1', documentSchemaVersion: 13 } })
    await harness.started
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const acquire = harness.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'bound-flow' }) })
    room.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: acquire.claim.interactionId,
      leaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await acquire.result
    harness.client.sampleInteraction({ claim: acquire.claim, presentation: flowPresentation({ interactionId: 'bound-flow', sequence: 2, terminal: true }) })
    const firstBinding = {
      leaseId, interactionId: acquire.claim.interactionId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 1,
      terminalSampleSequence: 2, presentationDigest: 'b'.repeat(64),
      sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' as const } },
      targetLane: { parentId: 'target-frame', slot: { presence: 'absent' as const } },
    }
    const submission = harness.client.submit({ mutationId: 'bound-mutation-0001', command: { type: 'node.rename', nodeId: 'node-1', name: 'After' }, flowBinding: firstBinding })
    void submission.catch(() => undefined)
    await vi.waitFor(() => expect(room.socket.sent.map(value => JSON.parse(value)).some(value => value.type === 'operation.submit' && value.operation.flowBinding?.leaseId === leaseId)).toBe(true))
    room.socket.serverClose(1006, 'reconnect')
    harness.timers.at(-1)!.callback()
    const next = harness.openAssigned(1, secondGenerationId, '10')
    harness.streamDocument(next.socket, next.requestId, { title: 'Before' }, '0', envelope(secondGenerationId, '10'))
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    expect(next.socket.sent.map(value => JSON.parse(value)).filter(value => value.type === 'operation.submit')).toEqual([])

    const fresh = harness.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'bound-flow', gestureGeneration: 2, sequence: 3 }) })
    next.socket.server({ type: 'interaction.result', envelope: envelope(secondGenerationId, '10'), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: fresh.claim.interactionId,
      leaseId: secondLeaseId, localClaimGeneration: fresh.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 3, denialCode: null })
    await fresh.result
    harness.client.sampleInteraction({ claim: fresh.claim, presentation: flowPresentation({ interactionId: 'bound-flow', gestureGeneration: 2, sequence: 4, terminal: true }) })
    harness.client.rebindInteractionMutation('bound-mutation-0001', {
      ...firstBinding, leaseId: secondLeaseId, localClaimGeneration: fresh.claim.localClaimGeneration, terminalSampleSequence: 4,
    })
    expect(JSON.parse(next.socket.sent.at(-1)!)).toMatchObject({ type: 'operation.submit', operation: { mutationId: 'bound-mutation-0001', flowBinding: { leaseId: secondLeaseId } } })
  })

  it('CLOUD-SYNC-REPLAY-001-C3A persists an interaction binding and quarantines it after process restart', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-1', documentSchemaVersion: 13 }
    const first = createHarness({ durableStore: memory.store, cache })
    await first.started
    const firstRoom = first.openAssigned()
    first.streamDocument(firstRoom.socket, firstRoom.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(first.client.getSnapshot().lifecycle).toBe('live'))
    const acquire = first.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'restart-flow' }) })
    firstRoom.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: acquire.claim.interactionId,
      leaseId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    await acquire.result
    first.client.sampleInteraction({ claim: acquire.claim, presentation: flowPresentation({ interactionId: 'restart-flow', sequence: 2, terminal: true }) })
    const binding = {
      leaseId, interactionId: acquire.claim.interactionId, localClaimGeneration: acquire.claim.localClaimGeneration, reservationGeneration: 1,
      terminalSampleSequence: 2, presentationDigest: 'c'.repeat(64),
      sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' as const } },
      targetLane: { parentId: 'target-frame', slot: { presence: 'absent' as const } },
    }
    const submitted = first.client.submit({ mutationId: 'bound-restart-0001', command: { type: 'node.rename', nodeId: 'node-1', name: 'After' }, flowBinding: binding })
    void submitted.catch(() => undefined)
    const scope = { accountId: cache.accountId, clientId: 'tab-1', fileId, documentSchemaVersion: cache.documentSchemaVersion, protocolEpoch: collaborationProtocolEpoch }
    await vi.waitFor(async () => expect(await memory.store.load(scope)).toMatchObject({
      pending: [{ mutationId: 'bound-restart-0001', flowBinding: { leaseId, interactionId: 'restart-flow' } }],
    }))
    first.client.stop()

    const restarted = createHarness({ durableStore: memory.store, cache })
    await restarted.started
    const restartedRoom = restarted.openAssigned()
    restarted.streamDocument(restartedRoom.socket, restartedRoom.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(restarted.client.getSnapshot()).toMatchObject({ lifecycle: 'live', pendingMutationIds: ['bound-restart-0001'] }))
    expect(restartedRoom.socket.sent.map(value => JSON.parse(value)).filter(value => value.type === 'operation.submit')).toEqual([])

    const fresh = restarted.client.acquireInteraction({ presentation: flowPresentation({ interactionId: 'restart-flow', gestureGeneration: 2, sequence: 3 }) })
    restartedRoom.socket.server({ type: 'interaction.result', envelope: envelope(), pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: fresh.claim.interactionId,
      leaseId: secondLeaseId, localClaimGeneration: fresh.claim.localClaimGeneration, reservationGeneration: 1, sampleSequence: 3, denialCode: null })
    await fresh.result
    restarted.client.sampleInteraction({ claim: fresh.claim, presentation: flowPresentation({ interactionId: 'restart-flow', gestureGeneration: 2, sequence: 4, terminal: true }) })
    restarted.client.rebindInteractionMutation('bound-restart-0001', {
      ...binding, leaseId: secondLeaseId, localClaimGeneration: fresh.claim.localClaimGeneration, terminalSampleSequence: 4,
    })
    expect(JSON.parse(restartedRoom.socket.sent.at(-1)!)).toMatchObject({ type: 'operation.submit', operation: { mutationId: 'bound-restart-0001', flowBinding: { leaseId: secondLeaseId } } })
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
      async enqueue(scope, mutation, resolveStatus) {
        enqueueAttempts += 1
        if (enqueueAttempts === 1) throw new Error('storage unavailable')
        await memory.store.enqueue(scope, mutation, resolveStatus)
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
        checkpoint: { snapshotId: 'projection:7', serverSequence: '7', document: { title: 42 }, replayScopeId },
        pending: [{ mutationId: 'mutation-forged', baseSequence: null, command: { operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Leaked' } }, status: 'pending' }],
        updatedAt: Date.now(),
      }),
      repair,
      enqueue: async () => undefined,
      checkpoint: async () => undefined,
      acknowledge: async () => undefined,
      markRecoverable: async () => undefined,
      markAllRecoverable: async () => undefined,
      reconcileReplayScope: async () => undefined,
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
        checkpoint: { snapshotId: 'projection:7', serverSequence: '7', document: '{not valid document bytes', replayScopeId },
        pending: [{
          mutationId: 'mutation-valid-0001',
          baseSequence: null,
          command: { operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Recovered' } },
          status: 'pending',
          replayScopeId,
        }],
        updatedAt: Date.now(),
      }),
      repair,
      enqueue: async () => undefined,
      checkpoint: async () => undefined,
      acknowledge: async () => undefined,
      markRecoverable: async () => undefined,
      markAllRecoverable: async () => undefined,
      reconcileReplayScope: async () => undefined,
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

  it('CLOUD-SYNC-CACHE-001 never publishes a legacy unscoped checkpoint before authorization', async () => {
    const repair = vi.fn(async () => undefined)
    const durableStore: CollaborationDurableStore = {
      load: async () => ({
        scope: { accountId: 'current-account', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch },
        checkpoint: { snapshotId: 'projection:7', serverSequence: '7', document: { title: 'Private' } },
        pending: [],
        updatedAt: Date.now(),
      }),
      repair,
      enqueue: async () => undefined,
      checkpoint: async () => undefined,
      acknowledge: async () => undefined,
      markRecoverable: async () => undefined,
      markAllRecoverable: async () => undefined,
      reconcileReplayScope: async () => undefined,
      clearCheckpoint: async () => undefined,
      purgeAccount: async () => undefined,
    }
    const harness = createHarness({ durableStore, cache: { accountId: 'current-account', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    const observed: Array<Document | null> = []
    const unsubscribe = harness.client.subscribe(() => observed.push(harness.client.getSnapshot().document))

    await harness.started

    expect(observed).not.toContainEqual({ title: 'Private' })
    expect(harness.client.getSnapshot()).toMatchObject({ document: null, snapshotId: null, serverSequence: '0' })
    expect(repair).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ checkpoint: null }))
    unsubscribe()
  })

  it('CLOUD-SYNC-CACHE-001 publishes a scoped checkpoint only after a matching verified room assignment', async () => {
    const memory = createMemoryDurableStore()
    const scope = { accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch }
    await memory.store.checkpoint(scope, { snapshotId: 'projection:7', serverSequence: '7', document: { title: 'Private' }, replayScopeId })
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    const observed: Array<Document | null> = []
    const unsubscribe = harness.client.subscribe(() => observed.push(harness.client.getSnapshot().document))

    await harness.started
    expect(harness.client.getSnapshot()).toMatchObject({ document: null, snapshotId: null, serverSequence: '0' })
    expect(observed).not.toContainEqual({ title: 'Private' })

    harness.openAssigned()
    await vi.waitFor(() => expect(harness.client.getSnapshot()).toMatchObject({ document: { title: 'Private' }, snapshotId: 'projection:7', serverSequence: '7' }))
    unsubscribe()
  })

  it('CLOUD-SYNC-CACHE-001 does not write durable state when the assigned scope already matches', async () => {
    const memory = createMemoryDurableStore()
    const scope = { accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch }
    await memory.store.checkpoint(scope, { snapshotId: 'projection:7', serverSequence: '7', document: { title: 'Private' }, replayScopeId })
    const reconcileReplayScope = vi.fn(async () => { throw new Error('read-only storage') })
    const harness = createHarness({ durableStore: { ...memory.store, reconcileReplayScope }, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started

    harness.openAssigned()

    await vi.waitFor(() => expect(harness.client.getSnapshot()).toMatchObject({ document: { title: 'Private' }, snapshotId: 'projection:7', serverSequence: '7' }))
    expect(reconcileReplayScope).not.toHaveBeenCalled()
  })

  it('CLOUD-SYNC-CACHE-001 atomically discards a checkpoint from an earlier access grant before resume', async () => {
    const memory = createMemoryDurableStore()
    const scope = { accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch }
    await memory.store.checkpoint(scope, { snapshotId: 'projection:7', serverSequence: '7', document: { title: 'Private' }, replayScopeId })
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    const observed: Array<Document | null> = []
    const unsubscribe = harness.client.subscribe(() => observed.push(harness.client.getSnapshot().document))

    await harness.started
    const { socket } = harness.openAssigned(0, generationId, '9', 'b'.repeat(64))

    await vi.waitFor(async () => {
      expect(harness.client.getSnapshot()).toMatchObject({ document: null, snapshotId: null, serverSequence: '0' })
      await expect(memory.store.load(scope)).resolves.toMatchObject({ checkpoint: null })
      expect(socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(message => message.type === 'room.resume')).toEqual([])
    })
    expect(observed).not.toContainEqual({ title: 'Private' })
    unsubscribe()
  })

  it('CLOUD-SYNC-CACHE-001 removes an in-memory checkpoint when reconnect authorization changes scope', async () => {
    const memory = createMemoryDurableStore()
    const scope = { accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch }
    const harness = createHarness({ durableStore: memory.store, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started
    const first = harness.openAssigned()
    harness.streamDocument(first.socket, first.requestId, { title: 'Private' }, '7')
    await vi.waitFor(async () => {
      expect(harness.client.getSnapshot().document).toEqual({ title: 'Private' })
      await expect(memory.store.load(scope)).resolves.toMatchObject({ checkpoint: { replayScopeId } })
    })

    first.socket.serverClose()
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('reconnecting'))
    harness.timers.at(-1)!.callback()
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(2))
    harness.openAssigned(1, secondGenerationId, '10', 'b'.repeat(64))

    await vi.waitFor(async () => {
      expect(harness.client.getSnapshot()).toMatchObject({ document: null, snapshotId: null, serverSequence: '0' })
      await expect(memory.store.load(scope)).resolves.toMatchObject({ checkpoint: null })
    })
  })

  it('CLOUD-SYNC-CACHE-001 makes a failed required scope reconciliation terminal instead of reconnecting forever', async () => {
    const memory = createMemoryDurableStore()
    const scope = { accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch }
    await memory.store.checkpoint(scope, { snapshotId: 'projection:7', serverSequence: '7', document: { title: 'Private' }, replayScopeId })
    const harness = createHarness({
      durableStore: { ...memory.store, reconcileReplayScope: async () => { throw new Error('cache write failed') } },
      cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion },
    })
    await harness.started

    harness.openAssigned(0, generationId, '9', 'b'.repeat(64))

    await vi.waitFor(() => expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'connection-failed', document: null, error: 'cache write failed' }))
    expect(harness.timers).toEqual([])
  })

  it('CLOUD-SYNC-CACHE-001 fences a delayed file A scope reconciliation from file B', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const firstScope = { ...cache, clientId: 'tab-1', fileId, protocolEpoch: collaborationProtocolEpoch }
    await memory.store.checkpoint(firstScope, { snapshotId: 'projection:7', serverSequence: '7', document: { title: 'Private A' }, replayScopeId })
    const reconciliationStarted = deferred()
    const releaseReconciliation = deferred()
    const durableStore: CollaborationDurableStore = {
      ...memory.store,
      async reconcileReplayScope(scope, assignedReplayScopeId) {
        reconciliationStarted.resolve()
        await releaseReconciliation.promise
        await memory.store.reconcileReplayScope(scope, assignedReplayScopeId)
      },
    }
    const harness = createHarness({ durableStore, cache })
    await harness.started
    harness.openAssigned(0, generationId, '9', 'b'.repeat(64))
    await reconciliationStarted.promise

    harness.client.stop()
    const restarted = harness.client.start({ fileId: secondFileId, cache })
    releaseReconciliation.resolve()
    await restarted

    await vi.waitFor(() => expect(harness.client.getSnapshot()).toMatchObject({ fileId: secondFileId, document: null, snapshotId: null, serverSequence: '0' }))
    expect(harness.sockets[1]!.sent).toEqual([])
  })

  it('CLOUD-SYNC-REPLAY-001 quarantines legacy unscoped queued work before any room can replay it', async () => {
    const repair = vi.fn(async () => undefined)
    const durableStore: CollaborationDurableStore = {
      load: async () => ({
        scope: { accountId: 'current-account', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch },
        checkpoint: null,
        pending: [{
          mutationId: 'mutation-legacy-unscoped',
          baseSequence: null,
          command: { operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Legacy' } },
          status: 'pending',
        }],
        updatedAt: Date.now(),
      }),
      repair,
      enqueue: async () => undefined,
      checkpoint: async () => undefined,
      acknowledge: async () => undefined,
      markRecoverable: async () => undefined,
      markAllRecoverable: async () => undefined,
      reconcileReplayScope: async () => undefined,
      clearCheckpoint: async () => undefined,
      purgeAccount: async () => undefined,
    }
    const harness = createHarness({ durableStore, cache: { accountId: 'current-account', documentSchemaVersion: collaborationDocumentSchemaVersion } })
    await harness.started

    expect(harness.client.getSnapshot()).toMatchObject({ pendingMutationIds: [], recoverableMutationIds: ['mutation-legacy-unscoped'] })
    expect(repair).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pending: [expect.objectContaining({ mutationId: 'mutation-legacy-unscoped', status: 'recoverable', replayScopeId: null })],
    }))
    const room = harness.openAssigned()
    harness.streamDocument(room.socket, room.requestId, { title: 'Current' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    expect(room.socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(message => message.type === 'operation.submit')).toEqual([])
  })

  it('CLOUD-SYNC-CACHE-001 keeps a delayed file A mutation out of file B after switching rooms', async () => {
    const memory = createMemoryDurableStore()
    const enqueueStarted = deferred()
    const releaseEnqueue = deferred()
    const durableStore: CollaborationDurableStore = {
      ...memory.store,
      async enqueue(scope, mutation, resolveStatus) {
        enqueueStarted.resolve()
        await releaseEnqueue.promise
        await memory.store.enqueue(scope, mutation, resolveStatus)
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
    await expect(memory.store.load({ accountId: 'account-a', clientId: 'tab-1', fileId, documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch })).resolves.toMatchObject({ pending: [{ mutationId: 'mutation-file-a', status: 'pending' }] })
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

  it('CLOUD-SYNC-REPLAY-001 marks an enqueue that finishes after revocation as recoverable', async () => {
    const memory = createMemoryDurableStore()
    const enqueueStarted = deferred()
    const releaseEnqueue = deferred()
    const durableStore: CollaborationDurableStore = {
      ...memory.store,
      async enqueue(scope, mutation, resolveStatus) {
        enqueueStarted.resolve()
        await releaseEnqueue.promise
        await memory.store.enqueue(scope, mutation, resolveStatus)
      },
    }
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const harness = createHarness({ durableStore, cache })
    await harness.started
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Private' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))

    const save = harness.client.submit({ mutationId: 'mutation-revoked-race', command: { type: 'node.rename', nodeId: 'node-1', name: 'Unsaved' } })
    await enqueueStarted.promise
    socket.server({ type: 'room.error', envelope: envelope(), code: 'access_revoked', message: 'Access was removed.', retry: 'none' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('access-revoked'))
    harness.client.stop()
    const restarted = harness.client.start({ fileId, cache })
    releaseEnqueue.resolve()

    await expect(save).rejects.toThrow('stopped after the change was saved for recovery')
    await restarted
    expect(harness.client.getSnapshot()).toMatchObject({ pendingMutationIds: [], recoverableMutationIds: ['mutation-revoked-race'] })
    await vi.waitFor(async () => {
      await expect(memory.store.load({
        accountId: 'account-a', clientId: 'tab-1', fileId,
        documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch,
      })).resolves.toMatchObject({ checkpoint: null, pending: [{ mutationId: 'mutation-revoked-race', status: 'recoverable' }] })
    })
  })

  it('CLOUD-SYNC-LIFECYCLE-001 removes lifecycle listeners when durable hydration fails', async () => {
    const lifecycle = new MockLifecycleTarget()
    const memory = createMemoryDurableStore()
    const durableStore: CollaborationDurableStore = { ...memory.store, load: async () => { throw new Error('cache failed') } }
    const harness = createHarness({ lifecycleTarget: lifecycle, durableStore, cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion } })

    await expect(harness.started).rejects.toThrow('cache failed')
    expect(lifecycle.listenerCount()).toBe(0)
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
      document: null,
      snapshotId: null,
      pendingMutationIds: ['durable-mutation-0001', 'durable-mutation-0002'],
    })
    const secondRoom = second.openAssigned()
    await vi.waitFor(() => expect(second.client.getSnapshot()).toMatchObject({ document: { title: 'Before' }, snapshotId: 'projection:0' }))
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

    socket.server({ type: 'request.error', protocolEpoch: collaborationProtocolEpoch, schemaVersion: 1, requestId: open.requestId, code: 'incompatible_build', message: 'Update required.', retry: 'refresh' })

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
      type: 'request.error', protocolEpoch: collaborationProtocolEpoch, schemaVersion: 1, requestId: firstOpen.requestId,
      code: 'capacity_refused', message: 'This room is full.', retry: 'retry', retryAfterMs: 250,
    })
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'capacity-refused', error: 'This room is full.' })

    harness.client.stop()
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'closed' })
    await harness.client.start({ fileId, cache: false })
    expect(harness.sockets).toHaveLength(2)
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'authorizing', error: null })
  })

  it('CLOUD-SYNC-LIFECYCLE-002 reconnects after a missing raw pong and ignores stale heartbeat callbacks', () => {
    const harness = createHarness({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 25 })
    const { socket, requestId } = harness.openAssigned()
    expect(harness.timers.filter(timer => timer.delay === 100)).toHaveLength(0)
    harness.streamDocument(socket, requestId, { title: 'Before' })
    const firstHeartbeat = harness.timers.find(timer => timer.delay === 100)!

    firstHeartbeat.callback()
    expect(socket.sent.at(-1)).toBe('ping')
    const firstTimeout = harness.timers.find(timer => timer.delay === 25)!
    socket.serverData('pong')
    expect(harness.cancelled).toContain(firstTimeout.token)

    const secondHeartbeat = harness.timers.filter(timer => timer.delay === 100).at(-1)!
    secondHeartbeat.callback()
    const secondTimeout = harness.timers.filter(timer => timer.delay === 25).at(-1)!
    secondTimeout.callback()

    expect(socket.closes.at(-1)).toMatchObject({ code: 4012, reason: 'Heartbeat timeout' })
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', reconnectAttempt: 1 })
    expect(harness.timers.at(-1)?.delay).toBe(0)
    const sentAfterTimeout = socket.sent.length
    firstHeartbeat.callback()
    expect(socket.sent).toHaveLength(sentAfterTimeout)
  })

  it('CLOUD-SYNC-LIFECYCLE-002 resumes clients that start offline or hidden without reopening authorizing', async () => {
    const offlineLifecycle = new MockLifecycleTarget()
    let online = false
    const offline = createHarness({ lifecycleTarget: offlineLifecycle, isOnline: () => online })
    await offline.started
    expect(offline.sockets).toHaveLength(0)
    expect(offline.client.getSnapshot()).toMatchObject({ lifecycle: 'offline-clean', error: 'Collaboration is offline.' })

    online = true
    offlineLifecycle.emit('online')
    expect(offline.sockets).toHaveLength(1)
    expect(offline.client.getSnapshot().lifecycle).toBe('authorizing')

    const hiddenLifecycle = new MockLifecycleTarget()
    let visible = false
    const hidden = createHarness({ lifecycleTarget: hiddenLifecycle, isVisible: () => visible })
    await hidden.started
    expect(hidden.sockets).toHaveLength(0)
    expect(hidden.client.getSnapshot()).toMatchObject({ lifecycle: 'parked', error: 'Collaboration paused while hidden.' })

    visible = true
    hiddenLifecycle.emit('visibilitychange')
    expect(hidden.sockets).toHaveLength(1)
    expect(hidden.client.getSnapshot().lifecycle).toBe('authorizing')
  })

  it('CLOUD-SYNC-LIFECYCLE-001 stops capped pre-admission failures as an honest connection failure', () => {
    const lifecycle = new MockLifecycleTarget()
    const harness = createHarness({ lifecycleTarget: lifecycle, maxPreAdmissionFailures: 2, ids: ['request-0001', 'request-0002'] })
    harness.sockets[0]!.serverClose(1006)
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', reconnectAttempt: 1 })
    harness.timers.at(-1)!.callback()
    expect(harness.sockets).toHaveLength(2)

    harness.sockets[1]!.serverClose(1006)
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'connection-failed', error: 'Collaboration could not be reached. Try again.' })
    expect(lifecycle.listenerCount()).toBe(0)
  })

  it('CLOUD-SYNC-LIFECYCLE-003 keeps reconnecting after an admitted room survives a dev-server restart', async () => {
    const harness = createHarness({ maxPreAdmissionFailures: 2, ids: ['request-0001', 'request-0002', 'request-0003', 'request-0004'] })
    const first = harness.openAssigned()
    harness.streamDocument(first.socket, first.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))

    first.socket.serverClose(1006, 'Dev server restarted')
    for (let index = 1; index <= 2; index += 1) {
      harness.timers.at(-1)!.callback()
      harness.sockets[index]!.serverClose(1006, 'Dev server unavailable')
      expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', reconnectAttempt: index + 1, document: { title: 'Before' } })
    }

    harness.timers.at(-1)!.callback()
    const recovered = harness.openAssigned(3, secondGenerationId, '10')
    harness.streamDocument(recovered.socket, recovered.requestId, { title: 'After restart' }, '1', envelope(secondGenerationId, '10'))
    await vi.waitFor(() => expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'live', reconnectAttempt: 0, document: { title: 'After restart' } }))
  })

  it('CLOUD-SYNC-LIFECYCLE-001 caps socket factory failures before admission', () => {
    const harness = createHarness({ maxPreAdmissionFailures: 2, socketFactoryFailures: 2, ids: ['request-0001', 'request-0002'] })
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', reconnectAttempt: 1 })
    harness.timers.at(-1)!.callback()
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'connection-failed', error: 'Collaboration could not be reached. Try again.' })
    expect(harness.sockets).toHaveLength(0)
  })

  it('CLOUD-SYNC-LIFECYCLE-001 caps room.open send failures before admission', () => {
    const harness = createHarness({ maxPreAdmissionFailures: 2, failSocketSendOnCreate: true, ids: ['request-0001', 'request-0002'] })
    harness.sockets[0]!.open()
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'reconnecting', reconnectAttempt: 1 })
    harness.timers.at(-1)!.callback()
    harness.sockets[1]!.open()
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'connection-failed', error: 'Collaboration could not be reached. Try again.' })
  })

  it('CLOUD-SYNC-REPLAY-001 leaves durable edits pending after connection attempts are exhausted', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const scope = { ...cache, accountId: 'account-a', clientId: 'tab-1', fileId, protocolEpoch: collaborationProtocolEpoch }
    await memory.store.enqueue(scope, {
      mutationId: 'mutation-network-retry', baseSequence: null,
      command: { operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Unsaved' } }, status: 'pending',
      replayScopeId,
      flowBinding: null,
    })
    const harness = createHarness({ durableStore: memory.store, cache, maxPreAdmissionFailures: 2, socketFactoryFailures: 2, ids: ['request-0001', 'request-0002'] })
    await harness.started
    harness.timers.at(-1)!.callback()
    expect(harness.client.getSnapshot().lifecycle).toBe('connection-failed')
    await expect(memory.store.load(scope)).resolves.toMatchObject({ pending: [{ mutationId: 'mutation-network-retry', status: 'pending' }] })
  })

  it('CLOUD-SYNC-LIFECYCLE-002 quarantines an old access grant before resume or replay', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const scope = { ...cache, clientId: 'tab-1', fileId, protocolEpoch: collaborationProtocolEpoch }
    await memory.store.enqueue(scope, {
      mutationId: 'mutation-old-access', baseSequence: null,
      command: { operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Old grant' } },
      status: 'pending', replayScopeId, flowBinding: null,
    })
    const harness = createHarness({ durableStore: memory.store, cache })
    await harness.started
    expect(harness.client.getSnapshot().pendingMutationIds).toEqual(['mutation-old-access'])
    await expect(memory.store.load(scope)).resolves.toMatchObject({ pending: [{ mutationId: 'mutation-old-access', status: 'pending', replayScopeId }] })
    const room = harness.openAssigned(0, generationId, '9', 'b'.repeat(64))
    await vi.waitFor(() => expect(harness.client.getSnapshot()).toMatchObject({ pendingMutationIds: [], recoverableMutationIds: ['mutation-old-access'] }))
    expect(room.socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(message => message.type === 'room.resume' || message.type === 'operation.submit')).toHaveLength(0)
    await expect(memory.store.load(scope)).resolves.toMatchObject({ pending: [{ mutationId: 'mutation-old-access', status: 'recoverable', replayScopeId }] })
  })

  it('CLOUD-SYNC-LIFECYCLE-002 survives teardown after pending status resolves but before its transaction commits', async () => {
    const memory = createMemoryDurableStore()
    const cache = { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion }
    const statusResolved = deferred()
    const commitPending = deferred()
    const processGone = deferred()
    const firstStore: CollaborationDurableStore = {
      ...memory.store,
      async enqueue(scope, mutation, resolveStatus) {
        const staged = Object.freeze({ ...mutation, status: resolveStatus?.() ?? mutation.status })
        statusResolved.resolve()
        await commitPending.promise
        await memory.store.enqueue(scope, staged)
      },
      async markAllRecoverable() { await processGone.promise },
    }
    const first = createHarness({ durableStore: firstStore, cache })
    await first.started
    const firstRoom = first.openAssigned()
    first.streamDocument(firstRoom.socket, firstRoom.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(first.client.getSnapshot().lifecycle).toBe('live'))

    const save = first.client.submit({ mutationId: 'mutation-commit-gap', command: { type: 'node.rename', nodeId: 'node-1', name: 'Old grant' } })
    await statusResolved.promise
    firstRoom.socket.server({ type: 'room.error', envelope: envelope(), code: 'access_revoked', message: 'Access was removed.', retry: 'none' })
    first.client.dispose()
    commitPending.resolve()
    await expect(save).rejects.toThrow('stopped after the change was saved for recovery')

    const scope = { ...cache, clientId: 'tab-1', fileId, protocolEpoch: collaborationProtocolEpoch }
    await expect(memory.store.load(scope)).resolves.toMatchObject({ pending: [{ mutationId: 'mutation-commit-gap', status: 'pending', replayScopeId }] })

    const second = createHarness({ durableStore: memory.store, cache, ids: ['request-second-context'] })
    await second.started
    const secondRoom = second.openAssigned(0, generationId, '10', 'b'.repeat(64))
    await vi.waitFor(() => expect(second.client.getSnapshot()).toMatchObject({ pendingMutationIds: [], recoverableMutationIds: ['mutation-commit-gap'] }))
    const replayFrames = secondRoom.socket.sent.map(value => JSON.parse(value) as CollaborationClientMessage).filter(message => message.type === 'room.resume' || message.type === 'operation.submit')
    expect(replayFrames).toEqual([])
  })

  it.each([
    ['incompatible_build', 'incompatible-build'],
    ['capacity_refused', 'capacity-refused'],
  ] as const)('CLOUD-SYNC-LIFECYCLE-001 enters terminal %s state after assignment', (code, lifecycle) => {
    const harness = createHarness()
    const { socket, requestId } = harness.openAssigned()
    harness.streamDocument(socket, requestId, { title: 'Before' })
    socket.server({
      type: 'room.error', envelope: envelope(), code, message: 'Terminal room failure.',
      retry: code === 'incompatible_build' ? 'refresh' : 'reconnect',
      ...(code === 'capacity_refused' ? { retryAfterMs: 250 } : {}),
    })
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle, error: 'Terminal room failure.' })
  })

  it('CLOUD-SYNC-LIFECYCLE-002 CLOUD-SYNC-CLIENT-001 CLOUD-SYNC-REPLAY-001 parks hidden clients, waits offline, and replays durable mutation ids in order after resume', async () => {
    const lifecycle = new MockLifecycleTarget()
    const memory = createMemoryDurableStore()
    let online = true
    let visible = true
    const harness = createHarness({
      durableStore: memory.store,
      cache: { accountId: 'account-a', documentSchemaVersion: collaborationDocumentSchemaVersion },
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 25,
      lifecycleTarget: lifecycle,
      isOnline: () => online,
      isVisible: () => visible,
    })
    await harness.started
    const firstRoom = harness.openAssigned()
    harness.streamDocument(firstRoom.socket, firstRoom.requestId, { title: 'Before' })
    await vi.waitFor(() => expect(harness.client.getSnapshot().lifecycle).toBe('live'))
    const staleHeartbeat = harness.timers.filter(timer => timer.delay === 100).at(-1)!

    const firstReceipt = harness.client.submit({ mutationId: 'lifecycle-mutation-0001', command: { type: 'node.rename', nodeId: 'node-1', name: 'First' } })
    const secondReceipt = harness.client.submit({ mutationId: 'lifecycle-mutation-0002', command: { type: 'node.rename', nodeId: 'node-1', name: 'Second' } })
    await vi.waitFor(() => expect(harness.client.getSnapshot().pendingMutationIds).toEqual(['lifecycle-mutation-0001', 'lifecycle-mutation-0002']))
    await vi.waitFor(async () => {
      await expect(memory.store.load({
        accountId: 'account-a', clientId: 'tab-1', fileId,
        documentSchemaVersion: collaborationDocumentSchemaVersion, protocolEpoch: collaborationProtocolEpoch,
      })).resolves.toMatchObject({ pending: [{ mutationId: 'lifecycle-mutation-0001' }, { mutationId: 'lifecycle-mutation-0002' }] })
    })

    online = false
    lifecycle.emit('offline')
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'offline-dirty', pendingMutationIds: ['lifecycle-mutation-0001', 'lifecycle-mutation-0002'] })
    expect(harness.sockets).toHaveLength(1)
    const sentWhileOffline = firstRoom.socket.sent.length
    staleHeartbeat.callback()
    expect(firstRoom.socket.sent).toHaveLength(sentWhileOffline)
    expect(harness.timers.filter(timer => timer.delay === 0 && !harness.cancelled.has(timer.token))).toHaveLength(0)

    online = true
    lifecycle.emit('online')
    expect(harness.sockets).toHaveLength(2)
    const secondRoom = harness.openAssigned(1)
    harness.streamDocument(secondRoom.socket, secondRoom.requestId, { title: 'Before' })
    await vi.waitFor(() => {
      const submissions = secondRoom.socket.sent.filter(frame => frame.startsWith('{')).map(frame => JSON.parse(frame) as CollaborationClientMessage).filter(message => message.type === 'operation.submit')
      expect(submissions).toEqual([expect.objectContaining({ operation: expect.objectContaining({ mutationId: 'lifecycle-mutation-0001', baseSequence: '0' }) })])
    })
    secondRoom.socket.server({ type: 'operation.ack', envelope: envelope(), mutationId: 'lifecycle-mutation-0001', sequence: '1', status: 'applied' })
    await vi.waitFor(() => {
      const submissions = secondRoom.socket.sent.filter(frame => frame.startsWith('{')).map(frame => JSON.parse(frame) as CollaborationClientMessage).filter(message => message.type === 'operation.submit')
      expect(submissions.at(-1)).toMatchObject({ operation: { mutationId: 'lifecycle-mutation-0002', baseSequence: '1' } })
    })
    secondRoom.socket.server({ type: 'operation.ack', envelope: envelope(), mutationId: 'lifecycle-mutation-0002', sequence: '2', status: 'applied' })
    await expect(firstReceipt).resolves.toMatchObject({ mutationId: 'lifecycle-mutation-0001', sequence: '1' })
    await expect(secondReceipt).resolves.toMatchObject({ mutationId: 'lifecycle-mutation-0002', sequence: '2' })

    const hiddenHeartbeat = harness.timers.filter(timer => timer.delay === 100).at(-1)!
    visible = false
    lifecycle.emit('visibilitychange')
    expect(harness.client.getSnapshot()).toMatchObject({ lifecycle: 'parked', pendingMutationIds: [] })
    const sentWhileHidden = secondRoom.socket.sent.length
    hiddenHeartbeat.callback()
    expect(secondRoom.socket.sent).toHaveLength(sentWhileHidden)
    expect(harness.sockets).toHaveLength(2)

    visible = true
    lifecycle.emit('visibilitychange')
    expect(harness.sockets).toHaveLength(3)
    expect(harness.client.getSnapshot().lifecycle).toBe('authorizing')
  })

  it('CLOUD-SYNC-LIFECYCLE-001 disposal removes lifecycle listeners and makes queued callbacks inert', () => {
    const lifecycle = new MockLifecycleTarget()
    const harness = createHarness({ lifecycleTarget: lifecycle, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 25 })
    const socket = harness.sockets[0]!
    const staleOnline = lifecycle.snapshot('online')[0]!
    const staleVisibility = lifecycle.snapshot('visibilitychange')[0]!
    socket.serverClose(1006, 'Network lost')
    const reconnect = harness.timers.find(timer => timer.delay === 0)!

    harness.client.dispose()
    const socketsAfterDispose = harness.sockets.length
    reconnect.callback()
    staleOnline()
    staleVisibility()

    expect(lifecycle.listenerCount()).toBe(0)
    expect(socket.listenerCount()).toBe(0)
    expect(harness.cancelled).toContain(reconnect.token)
    expect(harness.sockets).toHaveLength(socketsAfterDispose)
    expect(harness.client.getSnapshot()).toMatchObject({ disposed: true, lifecycle: 'closed' })
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
