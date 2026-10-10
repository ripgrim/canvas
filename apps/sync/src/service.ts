import { defaultMaxSyncMessageBytes, encodeServerSyncMessage, parseClientSyncMessage, syncProtocolVersion } from '@canvas/sync-protocol'
import type { ClientSyncMessage, PersistedFileEditBatch, ServerSyncMessage, SyncErrorCode } from '@canvas/sync-protocol'
import type { SyncAuthorizer, SyncConnectionRequest, SyncPrincipal, SyncRepository, SyncSocket } from './contracts.js'

export type SyncPeer = Readonly<{
  receive(data: string | Uint8Array): Promise<void>
  disconnect(): void
}>

type PeerState = {
  socket: SyncSocket
  principal: SyncPrincipal
  request: SyncConnectionRequest
  fileId: string | null
  clientId: string | null
  presenceSequence: number
  disconnected: boolean
  queue: Promise<void>
  outbound: Promise<void>
  pendingMessages: number
  pendingOutboundMessages: number
}

const closeCodes = { unauthorized: 4401, forbidden: 4403 } as const
const principalId = /^[A-Za-z0-9:._-]{1,128}$/

export function createRevisionSyncService(options: Readonly<{ repository: SyncRepository; authorizer: SyncAuthorizer; maxMessageBytes?: number; maxPendingMessages?: number; maxPendingOutboundMessages?: number }>) {
  const peersByFile = new Map<string, Set<PeerState>>()
  const authorizations = new WeakMap<object, Readonly<{ request: SyncConnectionRequest; principal: SyncPrincipal }>>()
  const maxMessageBytes = options.maxMessageBytes ?? defaultMaxSyncMessageBytes
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new Error('Message byte limit must be a positive integer')
  const maxPendingMessages = options.maxPendingMessages ?? 64
  if (!Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1) throw new Error('Pending message limit must be a positive integer')
  const maxPendingOutboundMessages = options.maxPendingOutboundMessages ?? 64
  if (!Number.isSafeInteger(maxPendingOutboundMessages) || maxPendingOutboundMessages < 1) throw new Error('Pending outbound message limit must be a positive integer')

  const send = (peer: PeerState, message: ServerSyncMessage) => {
    if (peer.disconnected) return Promise.resolve()
    if (peer.pendingOutboundMessages >= maxPendingOutboundMessages) {
      peer.socket.close(1013, 'Too many pending outbound messages')
      leave(peer)
      return Promise.resolve()
    }
    const data = encodeServerSyncMessage(message)
    peer.pendingOutboundMessages += 1
    const delivery = peer.outbound
      .catch(() => undefined)
      .then(async () => { if (!peer.disconnected) await peer.socket.send(data) })
    peer.outbound = delivery
      .catch(() => {
        if (!peer.disconnected) peer.socket.close(1011, 'Send failed')
        leave(peer)
      })
      .finally(() => { peer.pendingOutboundMessages -= 1 })
    return peer.outbound
  }
  const error = (peer: PeerState, code: SyncErrorCode, message: string, ids: Readonly<{ requestId?: string; clientMutationId?: string }> = {}) => send(peer, { type: 'error', protocolVersion: syncProtocolVersion, code, message, ...ids })
  const leave = (peer: PeerState) => {
    if (peer.disconnected) return
    peer.disconnected = true
    if (peer.fileId) { const peers = peersByFile.get(peer.fileId); peers?.delete(peer); if (peers?.size === 0) peersByFile.delete(peer.fileId) }
  }
  const join = (peer: PeerState, fileId: string, clientId: string) => {
    if (peer.fileId && peer.fileId !== fileId) throw new Error('A sync connection cannot switch files')
    peer.fileId = fileId; peer.clientId = clientId
    let peers = peersByFile.get(fileId)
    if (!peers) { peers = new Set(); peersByFile.set(fileId, peers) }
    peers.add(peer)
  }
  const scopeMatches = (peer: PeerState, message: ClientSyncMessage): boolean => {
    if (peer.request.scopedFileId && peer.request.scopedFileId !== message.fileId) return false
    if (peer.request.scopedClientId && peer.request.scopedClientId !== message.clientId) return false
    if (peer.fileId && peer.fileId !== message.fileId) return false
    if (peer.clientId && peer.clientId !== message.clientId) return false
    return true
  }
  const authorized = (peer: PeerState, fileId: string, action: 'read' | 'write' | 'presence') => options.authorizer.authorizeFile({ principal: peer.principal, request: peer.request, fileId, action })
  const broadcastToReaders = async (source: PeerState, fileId: string, message: ServerSyncMessage) => {
    const recipients = [...(peersByFile.get(fileId) ?? [])].filter(candidate => candidate !== source)
    await Promise.all(recipients.map(async peer => {
      if (await authorized(peer, fileId, 'read')) { await send(peer, message); return }
      await error(peer, 'forbidden', 'This session can no longer read the file.')
      peer.socket.close(closeCodes.forbidden, 'File access revoked')
      leave(peer)
    }))
  }
  const validCatchUp = (batches: readonly PersistedFileEditBatch[], fileId: string, fromRevision: number, serverRevision: number) => {
    let expected = fromRevision
    for (const batch of batches) { if (batch.fileId !== fileId || batch.baseRevision !== expected || batch.serverRevision !== expected + 1) return false; expected = batch.serverRevision }
    return expected === serverRevision
  }

  const subscribe = async (peer: PeerState, message: Extract<ClientSyncMessage, { type: 'file.subscribe' }>) => {
    if (!await authorized(peer, message.fileId, 'read')) { await error(peer, 'forbidden', 'This session cannot read the file.', { requestId: message.requestId }); return }
    if (peer.disconnected) return
    const opened = await options.repository.open(message.fileId, message.afterRevision)
    if (peer.disconnected) return
    if (opened.status === 'not_found') { await error(peer, 'file_not_found', 'The file does not exist.', { requestId: message.requestId }); return }
    if (opened.status === 'ahead') { await error(peer, 'invalid_message', 'The requested revision is newer than the file.', { requestId: message.requestId }); return }
    if (opened.status === 'payload' && (opened.payload.fileId !== message.fileId || opened.payload.serverRevision < 0)) throw new Error('Repository returned the wrong file payload')
    if (opened.status === 'ready' && opened.fileId !== message.fileId) throw new Error('Repository returned the wrong file readiness')
    if (opened.status === 'catchup' && (opened.fileId !== message.fileId || !validCatchUp(opened.batches, message.fileId, opened.fromRevision, opened.serverRevision))) throw new Error('Repository returned a discontinuous edit log')
    join(peer, message.fileId, message.clientId)
    if (opened.status === 'payload') await send(peer, { type: 'file.payload', protocolVersion: syncProtocolVersion, requestId: message.requestId, payload: opened.payload, reason: opened.reason })
    else if (opened.status === 'ready') await send(peer, { type: 'file.ready', protocolVersion: syncProtocolVersion, requestId: message.requestId, fileId: opened.fileId, serverRevision: opened.serverRevision })
    else await send(peer, { type: 'file.catchup', protocolVersion: syncProtocolVersion, requestId: message.requestId, fileId: opened.fileId, fromRevision: opened.fromRevision, serverRevision: opened.serverRevision, batches: opened.batches })
  }

  const edit = async (peer: PeerState, message: Extract<ClientSyncMessage, { type: 'file.edit.batch' }>) => {
    if (peer.fileId !== message.fileId || peer.clientId !== message.clientId) { await error(peer, 'not_subscribed', 'Subscribe to the file before editing.', { clientMutationId: message.clientMutationId }); return }
    if (!await authorized(peer, message.fileId, 'write')) { await error(peer, 'forbidden', 'This session cannot edit the file.', { clientMutationId: message.clientMutationId }); return }
    if (peer.disconnected) return
    const result = await options.repository.commit({ fileId: message.fileId, subjectId: peer.principal.subjectId, clientId: message.clientId, clientMutationId: message.clientMutationId, baseRevision: message.baseRevision, edits: message.edits })
    if (result.status === 'not_found') { await error(peer, 'file_not_found', 'The file does not exist.', { clientMutationId: message.clientMutationId }); return }
    if (result.status === 'mutation_id_reused') { await error(peer, 'mutation_id_reused', 'The mutation identity was already used for different edits.', { clientMutationId: message.clientMutationId }); return }
    if (result.status === 'invalid_edit') { await error(peer, 'invalid_edit', 'The edit could not be applied to the current file.', { clientMutationId: message.clientMutationId }); return }
    if (result.status === 'conflict') {
      if (result.batches && !validCatchUp(result.batches, message.fileId, message.baseRevision, result.serverRevision)) throw new Error('Repository returned a discontinuous conflict log')
      await send(peer, { type: 'file.conflict', protocolVersion: syncProtocolVersion, fileId: message.fileId, clientMutationId: message.clientMutationId, baseRevision: message.baseRevision, serverRevision: result.serverRevision, code: 'stale_revision', retry: 'resubscribe', ...(result.batches ? { batches: result.batches } : {}) })
      return
    }
    if (result.batch.fileId !== message.fileId || result.batch.subjectId !== peer.principal.subjectId || result.batch.clientId !== message.clientId || result.batch.clientMutationId !== message.clientMutationId || result.batch.baseRevision !== message.baseRevision || result.batch.serverRevision !== message.baseRevision + 1) throw new Error('Repository returned the wrong committed edit')
    await send(peer, { type: 'file.ack', protocolVersion: syncProtocolVersion, fileId: message.fileId, clientMutationId: message.clientMutationId, baseRevision: result.batch.baseRevision, serverRevision: result.batch.serverRevision, status: result.status })
    if (result.status === 'applied') {
      const broadcast = { type: 'file.edit.applied', protocolVersion: syncProtocolVersion, batch: result.batch } as const
      await broadcastToReaders(peer, message.fileId, broadcast)
    }
  }

  const presence = async (peer: PeerState, message: Extract<ClientSyncMessage, { type: 'file.presence' }>) => {
    if (peer.fileId !== message.fileId || peer.clientId !== message.clientId) { await error(peer, 'not_subscribed', 'Subscribe to the file before sending presence.'); return }
    if (!await authorized(peer, message.fileId, 'presence')) { await error(peer, 'forbidden', 'This session cannot share presence.'); return }
    if (peer.disconnected) return
    if (message.sequence <= peer.presenceSequence) return
    peer.presenceSequence = message.sequence
    const broadcast = { type: 'file.presence', protocolVersion: syncProtocolVersion, fileId: message.fileId, subjectId: peer.principal.subjectId, clientId: message.clientId, sequence: message.sequence, data: message.data } as const
    await broadcastToReaders(peer, message.fileId, broadcast)
  }

  const dispatch = async (peer: PeerState, data: string | Uint8Array) => {
    let message: ClientSyncMessage
    try { message = parseClientSyncMessage(data, maxMessageBytes) } catch (reason) {
      const unsupported = reason instanceof Error && reason.message.includes('protocol version')
      await error(peer, unsupported ? 'unsupported_protocol' : 'invalid_message', reason instanceof Error ? reason.message : 'Invalid sync message')
      return
    }
    if (!scopeMatches(peer, message)) { await error(peer, 'file_scope_mismatch', 'The message does not match this sync connection.'); peer.socket.close(closeCodes.forbidden, 'File scope mismatch'); leave(peer); return }
    try {
      if (message.type === 'file.subscribe') await subscribe(peer, message)
      else if (message.type === 'file.edit.batch') await edit(peer, message)
      else await presence(peer, message)
    } catch {
      await error(peer, 'internal_error', 'The sync service could not process the message.')
    }
  }

  const authorizeConnection = async (request: SyncConnectionRequest): Promise<object | null> => {
    let principal: SyncPrincipal | null = null
    try { principal = await options.authorizer.authorizeConnection(request) } catch { return null }
    if (!principal || !principalId.test(principal.subjectId)) return null
    const authorization = {}
    authorizations.set(authorization, { request, principal })
    return authorization
  }

  const connectAuthorized = (socket: SyncSocket, request: SyncConnectionRequest, authorization: object): SyncPeer | null => {
    const accepted = authorizations.get(authorization)
    authorizations.delete(authorization)
    const principal = accepted?.request === request ? accepted.principal : null
    if (!principal || !principalId.test(principal.subjectId)) {
      socket.close(closeCodes.unauthorized, 'Unauthorized')
      return null
    }
    const peer: PeerState = { socket, principal, request, fileId: null, clientId: null, presenceSequence: -1, disconnected: false, queue: Promise.resolve(), outbound: Promise.resolve(), pendingMessages: 0, pendingOutboundMessages: 0 }
    return {
      receive(data) {
        if (peer.disconnected) return Promise.resolve()
        if (peer.pendingMessages >= maxPendingMessages) { peer.socket.close(1013, 'Too many pending messages'); leave(peer); return Promise.resolve() }
        peer.pendingMessages += 1
        peer.queue = peer.queue.then(() => dispatch(peer, data), () => dispatch(peer, data))
        return peer.queue.finally(() => { peer.pendingMessages -= 1 })
      },
      disconnect: () => leave(peer),
    }
  }

  return {
    async connect(socket: SyncSocket, request: SyncConnectionRequest): Promise<SyncPeer | null> {
      const authorization = await authorizeConnection(request)
      if (!authorization) {
        await socket.send(encodeServerSyncMessage({ type: 'error', protocolVersion: syncProtocolVersion, code: 'unauthorized', message: 'Sign in to sync this file.' }))
        socket.close(closeCodes.unauthorized, 'Unauthorized')
        return null
      }
      return connectAuthorized(socket, request, authorization)
    },
    authorizeConnection,
    connectAuthorized,
    dispose() {
      for (const peers of peersByFile.values()) for (const peer of peers) { peer.socket.close(1001, 'Service stopped'); leave(peer) }
      peersByFile.clear()
    },
  }
}
