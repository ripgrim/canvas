import { describe, expect, it } from 'vitest'
import { syncProtocolVersion } from '@canvas/sync-protocol'
import type { ServerSyncMessage } from '@canvas/sync-protocol'
import { createRevisionSyncService, InMemorySyncRepository } from '../src/index.js'
import type { SyncAuthorizer, SyncConnectionRequest, SyncPeer, SyncSocket } from '../src/index.js'

class TestSocket implements SyncSocket {
  readonly messages: ServerSyncMessage[] = []
  readonly closes: { code: number; reason: string }[] = []
  send(data: string) { this.messages.push(JSON.parse(data) as ServerSyncMessage) }
  close(code: number, reason: string) { this.closes.push({ code, reason }) }
}

const file = (name = 'Untitled') => ({ fileId: 'file-1', document: { schemaVersion: 1, name, pages: [] } })
const allow: SyncAuthorizer = {
  authorizeConnection: async request => request.headers.authorization === 'Bearer valid' ? { subjectId: 'user-1' } : null,
  authorizeFile: async ({ fileId }) => fileId === 'file-1',
}
const request = (patch: Partial<SyncConnectionRequest> = {}): SyncConnectionRequest => ({ url: 'wss://sync.example/sync/file-1?tabId=tab-1', headers: { authorization: 'Bearer valid' }, scopedFileId: 'file-1', ...patch })
const subscribe = (requestId: string, clientId: string, afterRevision?: number) => JSON.stringify({ type: 'file.subscribe', protocolVersion: syncProtocolVersion, requestId, fileId: 'file-1', clientId, ...(afterRevision === undefined ? {} : { afterRevision }) })
const edit = (clientId: string, clientMutationId: string, baseRevision: number, name: string) => JSON.stringify({ type: 'file.edit.batch', protocolVersion: syncProtocolVersion, fileId: 'file-1', clientId, clientMutationId, baseRevision, edits: [{ type: 'set', path: ['name'], value: name }] })

async function connected(service: ReturnType<typeof createRevisionSyncService>, socket: TestSocket, input = request()): Promise<SyncPeer> {
  const peer = await service.connect(socket, input)
  if (!peer) throw new Error('Expected the test connection to be authorized')
  return peer
}

describe('revision sync service', () => {
  it('SYNC-001 commits ordered batches, acknowledges each revision, and broadcasts canonical edits', async () => {
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const authorSocket = new TestSocket(); const observerSocket = new TestSocket()
    const author = await connected(service, authorSocket, request({ scopedClientId: 'tab-author' }))
    const observer = await connected(service, observerSocket, request({ scopedClientId: 'tab-observer' }))
    await author.receive(subscribe('subscribe-author', 'tab-author'))
    await observer.receive(subscribe('subscribe-observer', 'tab-observer'))

    await author.receive(edit('tab-author', 'mutation-1', 0, 'First'))
    await author.receive(edit('tab-author', 'mutation-2', 1, 'Second'))

    expect(authorSocket.messages.filter(message => message.type === 'file.ack')).toEqual([
      expect.objectContaining({ clientMutationId: 'mutation-1', baseRevision: 0, serverRevision: 1, status: 'applied' }),
      expect.objectContaining({ clientMutationId: 'mutation-2', baseRevision: 1, serverRevision: 2, status: 'applied' }),
    ])
    expect(observerSocket.messages.filter(message => message.type === 'file.edit.applied').map(message => message.type === 'file.edit.applied' ? message.batch.serverRevision : -1)).toEqual([1, 2])
    expect(await repository.load('file-1')).toMatchObject({ serverRevision: 2, document: { name: 'Second' } })
  })

  it('SYNC-002 catches a reconnecting client up from its last server revision', async () => {
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const firstSocket = new TestSocket(); const first = await connected(service, firstSocket, request({ scopedClientId: 'tab-1' }))
    await first.receive(subscribe('initial', 'tab-1'))
    await first.receive(edit('tab-1', 'mutation-1', 0, 'First'))
    await first.receive(edit('tab-1', 'mutation-2', 1, 'Second'))
    first.disconnect()

    const reconnectSocket = new TestSocket(); const reconnect = await connected(service, reconnectSocket, request({ scopedClientId: 'tab-2' }))
    await reconnect.receive(subscribe('reconnect', 'tab-2', 0))

    expect(reconnectSocket.messages).toEqual([expect.objectContaining({ type: 'file.catchup', requestId: 'reconnect', fromRevision: 0, serverRevision: 2, batches: [expect.objectContaining({ serverRevision: 1 }), expect.objectContaining({ serverRevision: 2 })] })])
  })

  it('SYNC-002 falls back to a full payload when retained history cannot bridge the revision', async () => {
    const repository = new InMemorySyncRepository([file()], { historyLimit: 1 })
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const writerSocket = new TestSocket(); const writer = await connected(service, writerSocket, request({ scopedClientId: 'writer' }))
    await writer.receive(subscribe('writer-subscribe', 'writer'))
    await writer.receive(edit('writer', 'mutation-1', 0, 'First'))
    await writer.receive(edit('writer', 'mutation-2', 1, 'Second'))
    const reconnectSocket = new TestSocket(); const reconnect = await connected(service, reconnectSocket, request({ scopedClientId: 'reader' }))
    await reconnect.receive(subscribe('reader-subscribe', 'reader', 0))
    expect(reconnectSocket.messages).toEqual([expect.objectContaining({ type: 'file.payload', reason: 'history_unavailable', payload: expect.objectContaining({ serverRevision: 2, document: expect.objectContaining({ name: 'Second' }) }) })])
  })

  it('SYNC-CONFLICT-001 returns stale catch-up and makes an identical retry idempotent', async () => {
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const socket = new TestSocket(); const peer = await connected(service, socket, request({ scopedClientId: 'tab-1' }))
    await peer.receive(subscribe('subscribe', 'tab-1'))
    await peer.receive(edit('tab-1', 'mutation-1', 0, 'First'))
    await peer.receive(edit('tab-1', 'mutation-1', 0, 'First'))
    await peer.receive(edit('tab-1', 'stale-mutation', 0, 'Stale'))

    expect(socket.messages.filter(message => message.type === 'file.ack')).toEqual([
      expect.objectContaining({ status: 'applied', serverRevision: 1 }),
      expect.objectContaining({ status: 'duplicate', serverRevision: 1 }),
    ])
    expect(socket.messages).toContainEqual(expect.objectContaining({ type: 'file.conflict', clientMutationId: 'stale-mutation', baseRevision: 0, serverRevision: 1, retry: 'resubscribe', batches: [expect.objectContaining({ clientMutationId: 'mutation-1' })] }))
    expect((await repository.load('file-1'))?.serverRevision).toBe(1)
  })

  it('SYNC-CONFLICT-001 refuses reuse of a mutation identity for different content', async () => {
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const socket = new TestSocket(); const peer = await connected(service, socket, request({ scopedClientId: 'tab-1' }))
    await peer.receive(subscribe('subscribe', 'tab-1'))
    await peer.receive(edit('tab-1', 'mutation-1', 0, 'First'))
    await peer.receive(edit('tab-1', 'mutation-1', 0, 'Different'))
    expect(socket.messages.at(-1)).toMatchObject({ type: 'error', code: 'mutation_id_reused', clientMutationId: 'mutation-1' })
    expect((await repository.load('file-1'))?.document.name).toBe('First')
  })

  it('SYNC-CONFLICT-001 serializes concurrent commits so only one can claim a base revision', async () => {
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const leftSocket = new TestSocket(); const rightSocket = new TestSocket()
    const left = await connected(service, leftSocket, request({ scopedClientId: 'left' })); const right = await connected(service, rightSocket, request({ scopedClientId: 'right' }))
    await left.receive(subscribe('left-subscribe', 'left')); await right.receive(subscribe('right-subscribe', 'right'))
    await Promise.all([left.receive(edit('left', 'left-mutation', 0, 'Left')), right.receive(edit('right', 'right-mutation', 0, 'Right'))])
    const outcomes = [...leftSocket.messages, ...rightSocket.messages].filter(message => message.type === 'file.ack' || message.type === 'file.conflict')
    expect(outcomes.filter(message => message.type === 'file.ack' && message.status === 'applied')).toHaveLength(1)
    expect(outcomes.filter(message => message.type === 'file.conflict')).toHaveLength(1)
    expect((await repository.load('file-1'))?.serverRevision).toBe(1)
  })

  it('SYNC-SEC-001 rejects unauthenticated connections before file access', async () => {
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const socket = new TestSocket()
    const peer = await service.connect(socket, request({ headers: {} }))
    expect(peer).toBeNull()
    expect(socket.messages).toEqual([expect.objectContaining({ type: 'error', code: 'unauthorized' })])
    expect(socket.closes).toEqual([{ code: 4401, reason: 'Unauthorized' }])
  })

  it('SYNC-SEC-001 checks file grants and route scope before subscription', async () => {
    const repository = new InMemorySyncRepository([file()])
    const denied: SyncAuthorizer = { authorizeConnection: allow.authorizeConnection, authorizeFile: async () => false }
    const deniedService = createRevisionSyncService({ repository, authorizer: denied })
    const deniedSocket = new TestSocket(); const deniedPeer = await connected(deniedService, deniedSocket, request({ scopedClientId: 'tab-1' }))
    await deniedPeer.receive(subscribe('denied', 'tab-1'))
    expect(deniedSocket.messages).toEqual([expect.objectContaining({ type: 'error', code: 'forbidden', requestId: 'denied' })])

    const scopedService = createRevisionSyncService({ repository, authorizer: allow })
    const scopedSocket = new TestSocket(); const scopedPeer = await connected(scopedService, scopedSocket, request({ scopedFileId: 'another-file' }))
    await scopedPeer.receive(subscribe('wrong-file', 'tab-1'))
    expect(scopedSocket.messages).toEqual([expect.objectContaining({ type: 'error', code: 'file_scope_mismatch' })])
    expect(scopedSocket.closes).toEqual([{ code: 4403, reason: 'File scope mismatch' }])
  })

  it('SYNC-SEC-001 stops broadcasts when a subscribed reader loses its file grant', async () => {
    let readerAllowed = true
    const authorizer: SyncAuthorizer = {
      authorizeConnection: async input => input.headers.authorization === 'Bearer reader' ? { subjectId: 'reader' } : { subjectId: 'writer' },
      authorizeFile: async ({ principal }) => principal.subjectId !== 'reader' || readerAllowed,
    }
    const repository = new InMemorySyncRepository([file()]); const service = createRevisionSyncService({ repository, authorizer })
    const writerSocket = new TestSocket(); const readerSocket = new TestSocket()
    const writer = await connected(service, writerSocket, request({ scopedClientId: 'writer' })); const reader = await connected(service, readerSocket, request({ scopedClientId: 'reader', headers: { authorization: 'Bearer reader' } }))
    await writer.receive(subscribe('writer-subscribe', 'writer')); await reader.receive(subscribe('reader-subscribe', 'reader'))
    readerAllowed = false
    await writer.receive(edit('writer', 'mutation-1', 0, 'Private'))
    expect(readerSocket.messages.filter(message => message.type === 'file.edit.applied')).toEqual([])
    expect(readerSocket.messages.at(-1)).toMatchObject({ type: 'error', code: 'forbidden' })
    expect(readerSocket.closes).toEqual([{ code: 4403, reason: 'File access revoked' }])
  })

  it('keeps presence ephemeral and suppresses out-of-order presence', async () => {
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const senderSocket = new TestSocket(); const receiverSocket = new TestSocket()
    const sender = await connected(service, senderSocket, request({ scopedClientId: 'sender' })); const receiver = await connected(service, receiverSocket, request({ scopedClientId: 'receiver' }))
    await sender.receive(subscribe('sender-subscribe', 'sender')); await receiver.receive(subscribe('receiver-subscribe', 'receiver'))
    const presence = (sequence: number) => JSON.stringify({ type: 'file.presence', protocolVersion: 1, fileId: 'file-1', clientId: 'sender', sequence, data: { cursor: { x: sequence, y: 4 } } })
    await sender.receive(presence(2)); await sender.receive(presence(1))
    expect(receiverSocket.messages.filter(message => message.type === 'file.presence')).toEqual([expect.objectContaining({ type: 'file.presence', subjectId: 'user-1', sequence: 2 })])
    expect(await repository.changesSince('file-1', 0)).toEqual([])
    expect((await repository.load('file-1'))?.serverRevision).toBe(0)
  })

  it('bounds queued messages while a scoped authorization check is pending', async () => {
    let release = () => {}
    const gate = new Promise<boolean>(resolve => { release = () => resolve(true) })
    const authorizer: SyncAuthorizer = { authorizeConnection: allow.authorizeConnection, authorizeFile: () => gate }
    const service = createRevisionSyncService({ repository: new InMemorySyncRepository([file()]), authorizer, maxPendingMessages: 1 })
    const socket = new TestSocket(); const peer = await connected(service, socket, request({ scopedClientId: 'tab-1' }))
    const first = peer.receive(subscribe('first', 'tab-1'))
    await Promise.resolve()
    await peer.receive(subscribe('second', 'tab-1'))
    expect(socket.closes).toEqual([{ code: 1013, reason: 'Too many pending messages' }])
    release()
    await first
    expect(socket.messages).toEqual([])
  })

  it('bounds a slow socket outbound queue without blocking other peers', async () => {
    let release = () => {}
    let hold = false
    const gate = new Promise<void>(resolve => { release = resolve })
    class SlowSocket extends TestSocket {
      override async send(data: string) {
        super.send(data)
        if (hold) await gate
      }
    }
    const repository = new InMemorySyncRepository([file()])
    const service = createRevisionSyncService({ repository, authorizer: allow, maxPendingOutboundMessages: 1 })
    const slowSocket = new SlowSocket(); const slow = await connected(service, slowSocket, request({ scopedClientId: 'slow' }))
    await slow.receive(subscribe('slow-subscribe', 'slow'))
    hold = true
    const leftSocket = new TestSocket(); const rightSocket = new TestSocket()
    const left = await connected(service, leftSocket, request({ scopedClientId: 'left' }))
    const right = await connected(service, rightSocket, request({ scopedClientId: 'right' }))
    await left.receive(subscribe('left-subscribe', 'left'))
    await right.receive(subscribe('right-subscribe', 'right'))
    const first = left.receive(JSON.stringify({ type: 'file.presence', protocolVersion: 1, fileId: 'file-1', clientId: 'left', sequence: 1, data: {} }))
    await Promise.resolve()
    await right.receive(JSON.stringify({ type: 'file.presence', protocolVersion: 1, fileId: 'file-1', clientId: 'right', sequence: 1, data: {} }))
    expect(slowSocket.closes).toContainEqual({ code: 1013, reason: 'Too many pending outbound messages' })
    release()
    await first
  })

  it('bounds retained mutation identities with the retained edit history', async () => {
    const repository = new InMemorySyncRepository([file()], { historyLimit: 1 })
    const service = createRevisionSyncService({ repository, authorizer: allow })
    const socket = new TestSocket(); const peer = await connected(service, socket, request({ scopedClientId: 'tab-1' }))
    await peer.receive(subscribe('subscribe', 'tab-1'))
    await peer.receive(edit('tab-1', 'mutation-1', 0, 'First'))
    await peer.receive(edit('tab-1', 'mutation-2', 1, 'Second'))
    await peer.receive(edit('tab-1', 'mutation-1', 0, 'First'))
    expect(socket.messages.at(-1)).toMatchObject({ type: 'file.conflict', clientMutationId: 'mutation-1', serverRevision: 2 })
  })
})
