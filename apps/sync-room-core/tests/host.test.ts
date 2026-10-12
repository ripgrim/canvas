import { once } from 'node:events'
import { createHmac } from 'node:crypto'
import { maxCollaborationAvatarUrlBytes, maxCollaborationConnectionNonceLength, maxRoomTicketLength } from '@canvas/sync-protocol'
import type { CollaborationClientMessage, RoomOpenMessage, VerifiedRoomTicketClaims } from '@canvas/sync-protocol'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { RoomAuthorization, RoomIdentity, RoomTicketVerifier } from '../src/contracts.js'
import { createMultiRoomHost } from '../src/host.js'
import type { HostedCollaborationRoom, MultiRoomHost, MultiRoomHostOptions } from '../src/host.js'
import { createSemanticProjector } from '../src/projector.js'
import { CollaborationRoomCore } from '../src/room-core.js'
import type { RoomPeer, RoomPhase } from '../src/room-core.js'
import { HmacRoomTicketVerifier } from '../src/tickets.js'
import { checkpoints, clientId, connectionNonce, deferred, FakePersistence, fileId, flowDocument, flowPresentation, generationId, projection, projector } from './support.js'

const origin = 'http://127.0.0.1:4317'
const secondFileId = '11111111-1111-4111-8111-111111111111'
const secondGenerationId = '22222222-2222-4222-8222-222222222222'
const alternateGenerationId = '33333333-3333-4333-8333-333333333333'
const secret = Buffer.alloc(32, 9)

class FakeHostedRoom implements HostedCollaborationRoom {
  phase: RoomPhase = 'cold'
  starts = 0
  admissions = 0
  drains = 0
  readonly connections: string[] = []
  readonly requests: string[] = []

  constructor(
    readonly identity: RoomIdentity,
    readonly startWork: () => Promise<void> = async () => undefined,
    readonly admitWork: () => Promise<void> = async () => undefined,
    readonly drainWork: () => Promise<void> = async () => undefined,
  ) {}

  async start() {
    this.starts += 1
    this.phase = 'starting'
    try { await this.startWork(); this.phase = 'accepting' }
    catch (error) { this.phase = 'failed'; throw error }
  }

  async admitAuthorized(peer: RoomPeer, _authorization: RoomAuthorization, open: RoomOpenMessage) {
    if (this.phase !== 'accepting') return false
    this.admissions += 1
    await this.admitWork()
    if (this.phase !== 'accepting') return false
    this.connections.push(peer.connectionId)
    this.requests.push(open.requestId)
    return true
  }

  async receive(_connectionId: string, _message: CollaborationClientMessage) {}
  disconnect(connectionId: string) { const index = this.connections.indexOf(connectionId); if (index >= 0) this.connections.splice(index, 1) }
  async drain() { this.drains += 1; this.phase = 'draining'; await this.drainWork(); this.phase = 'stopped'; return { status: 'stopped' as const } }
}

function signedTicket(identity: RoomIdentity, nonce = connectionNonce, client = clientId, identityOverrides: Partial<Pick<VerifiedRoomTicketClaims, 'subjectId' | 'displayName' | 'avatarUrl'>> = {}): string {
  const claims: VerifiedRoomTicketClaims = {
    subjectId: 'subject-1',
    displayName: 'Alpha',
    avatarUrl: 'https://images.example/alpha.png',
    fileId: identity.fileId,
    role: 'owner',
    generationId: identity.generationId,
    protocolEpoch: 4,
    buildId: 'test-build',
    expiresAtUnixMs: Date.now() + 60_000,
    accessEpoch: '1',
    clientId: client,
    connectionNonce: nonce,
    ...identityOverrides,
  }
  const payload = Buffer.from(JSON.stringify(claims), 'utf8')
  return Buffer.concat([payload, createHmac('sha256', secret).update(payload).digest()]).toString('base64url')
}

function socketUrl(port: number, identity: RoomIdentity, nonce = connectionNonce, client = clientId): string {
  return `ws://127.0.0.1:${port}/sync/${identity.fileId}/${identity.generationId}?clientId=${client}&connectionNonce=${nonce}`
}

function roomOpen(identity: RoomIdentity, client = clientId, requestId = 'request-1') {
  return { type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId, fileId: identity.fileId, clientId: client, buildId: 'test-build' }
}

type HostOverrides = Partial<Pick<MultiRoomHostOptions, 'handshakeTimeoutMs' | 'maxPendingUpgrades' | 'maxRooms' | 'shutdownTimeoutMs' | 'startupTimeoutMs'>> & Readonly<{ tickets?: RoomTicketVerifier }>

function createHost(createRoom: (identity: RoomIdentity) => HostedCollaborationRoom, overrides: HostOverrides = {}) {
  const tickets = overrides.tickets ?? new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 1n } } })
  return createMultiRoomHost({
    allowedOrigins: [origin],
    maxMessageBytes: 256 * 1024,
    maxRooms: overrides.maxRooms ?? 8,
    maxPendingUpgrades: overrides.maxPendingUpgrades ?? 8,
    handshakeTimeoutMs: overrides.handshakeTimeoutMs ?? 2_000,
    startupTimeoutMs: overrides.startupTimeoutMs ?? 2_000,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 2_000,
    tickets,
    createRoom,
  })
}

async function openSocket(port: number, identity: RoomIdentity, nonce = connectionNonce, client = clientId): Promise<WebSocket> {
  const socket = new WebSocket(socketUrl(port, identity, nonce, client), {
    origin,
    headers: { Authorization: `Bearer ${signedTicket(identity, nonce, client)}` },
  })
  await once(socket, 'open')
  socket.send(JSON.stringify(roomOpen(identity, client)))
  await new Promise<void>(resolve => setImmediate(resolve))
  return socket
}

async function waitForHostWire(messages: readonly string[], predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const expiresAt = Date.now() + 1_000
  while (Date.now() < expiresAt) {
    const match = messages.map(message => JSON.parse(message) as Record<string, unknown>).find(predicate)
    if (match) return match
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Expected host WebSocket message was not received')
}

async function openObservedHostSocket(port: number, identity: RoomIdentity, nonce: string, socketClientId: string, requestId: string): Promise<Readonly<{ socket: WebSocket; messages: string[] }>> {
  const socket = new WebSocket(socketUrl(port, identity, nonce, socketClientId), {
    origin,
    headers: { Authorization: `Bearer ${signedTicket(identity, nonce, socketClientId)}` },
  })
  const messages: string[] = []
  socket.on('message', value => messages.push(value.toString()))
  await once(socket, 'open')
  socket.send(JSON.stringify(roomOpen(identity, socketClientId, requestId)))
  await waitForHostWire(messages, value => value.type === 'presence.roster')
  return Object.freeze({ socket, messages })
}

async function rejectedStatus(port: number, identity: RoomIdentity, token: string, nonce = connectionNonce, client = clientId): Promise<string> {
  const socket = new WebSocket(socketUrl(port, identity, nonce, client), { origin, headers: { Authorization: `Bearer ${token}` } })
  const [error] = await once(socket, 'error')
  return String(error)
}

describe('local multi-room host', () => {
  let host: MultiRoomHost | undefined
  afterEach(async () => { await host?.close(); host = undefined })

  it('DEV-STACK-001 rejects a forged ticket without allocating or starting a room', async () => {
    let creations = 0
    host = createHost(identity => { creations += 1; return new FakeHostedRoom(identity) })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }

    await expect(rejectedStatus(address.port, identity, 'X'.repeat(64))).resolves.toContain('401')
    expect(creations).toBe(0)
    expect(host.roomCount).toBe(0)
  })

  it('CLOUD-SYNC-DO-SEC-001 rejects extra, duplicate, missing, and malformed route query authority before room allocation', async () => {
    let creations = 0
    host = createHost(identity => { creations += 1; return new FakeHostedRoom(identity) })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const base = socketUrl(address.port, identity)
    const invalid = [
      `${base}&role=owner`,
      `${base}&clientId=client-2`,
      `${base}&connectionNonce=${'x'.repeat(24)}`,
      `ws://127.0.0.1:${address.port}/sync/${fileId}/${generationId}?connectionNonce=${connectionNonce}`,
      `ws://127.0.0.1:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}`,
      `ws://127.0.0.1:${address.port}/sync/${fileId}/${generationId}?clientId=%20client-1&connectionNonce=${connectionNonce}`,
      `ws://127.0.0.1:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=short`,
    ]
    for (const candidate of invalid) {
      const socket = new WebSocket(candidate, { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
      const [error] = await once(socket, 'error')
      expect(String(error), candidate).toContain('404')
    }
    expect(creations).toBe(0)
    expect(host.roomCount).toBe(0)
  })

  it('CLOUD-SYNC-AUTH-001 admits the worst-case bounded identity ticket through the host', async () => {
    let room: FakeHostedRoom | undefined
    host = createHost(identity => {
      room = new FakeHostedRoom(identity)
      return room
    })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const maxClientId = 'c'.repeat(128)
    const maxNonce = 'n'.repeat(maxCollaborationConnectionNonceLength)
    const avatarPrefix = 'https://images.example/'
    const token = signedTicket(identity, maxNonce, maxClientId, {
      subjectId: 's'.repeat(128),
      displayName: '😀'.repeat(80),
      avatarUrl: `${avatarPrefix}${'a'.repeat(maxCollaborationAvatarUrlBytes - avatarPrefix.length)}`,
    })
    expect(token.length).toBeLessThanOrEqual(maxRoomTicketLength)
    const socket = new WebSocket(socketUrl(address.port, identity, maxNonce, maxClientId), { origin, headers: { Authorization: `Bearer ${token}` } })
    await once(socket, 'open')
    socket.send(JSON.stringify(roomOpen(identity, maxClientId, 'worst-case-identity')))
    while (room?.admissions !== 1) await new Promise<void>(resolve => setImmediate(resolve))
    expect(room?.admissions).toBe(1)
    socket.close()
  })

  it('CLOUD-SYNC-AUTH-001 rechecks access after host verification and before the first snapshot byte', async () => {
    let accessEpoch = 1n
    let accessChecks = 0
    const verifier = new HmacRoomTicketVerifier(secret, { async resolve() { accessChecks += 1; return { role: 'owner', accessEpoch } } })
    let room: CollaborationRoomCore | undefined
    host = createHost(identity => {
      room = new CollaborationRoomCore({ identity, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000 }, { persistence: new FakePersistence(), tickets: verifier, projector, checkpoints })
      return room
    }, { tickets: verifier })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const socket = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    const messages: string[] = []
    socket.on('message', value => messages.push(value.toString()))
    await once(socket, 'open')
    expect(accessChecks).toBe(1)
    accessEpoch = 2n
    const closed = once(socket, 'close')
    socket.send(JSON.stringify(roomOpen(identity)))
    const [code] = await closed

    expect(code).toBe(4401)
    expect(accessChecks).toBe(2)
    expect(messages).toHaveLength(0)
    expect(room?.activeConnections).toBe(0)
  })

  it('CLOUD-SYNC-GESTURE-001-C2-LIVE and CLOUD-SYNC-SCHEMA-001-C2-LIVE carry flow leases through the multi-room host WebSocket', async () => {
    const verifier = new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 1n } } })
    host = createHost(identity => {
      const persistence = new FakePersistence()
      persistence.current = projection(flowDocument())
      return new CollaborationRoomCore(
        { identity, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000 },
        { persistence, tickets: verifier, projector: createSemanticProjector(), checkpoints },
      )
    }, { tickets: verifier })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const owner = await openObservedHostSocket(address.port, identity, connectionNonce, clientId, 'host-live-owner')
    const observer = await openObservedHostSocket(address.port, identity, 'T'.repeat(24), 'host-live-observer-client', 'host-live-observer')
    owner.messages.length = 0
    observer.messages.length = 0

    owner.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() }))
    const grant = await waitForHostWire(owner.messages, value => value.type === 'interaction.result')
    expect(grant).toMatchObject({ action: 'acquire', status: 'granted', interactionId: 'flow-interaction', denialCode: null })
    const leaseId = String(grant.leaseId)
    await expect(waitForHostWire(observer.messages, value => value.type === 'interaction.sample')).resolves.toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 1 } } })

    owner.messages.length = 0
    observer.messages.length = 0
    owner.socket.send(JSON.stringify({
      type: 'interaction.reserve', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2,
      targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' } },
      presentation: flowPresentation({ sequence: 2, targetParentId: 'disjoint-frame' }),
    }))
    await expect(waitForHostWire(owner.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ action: 'reserve', status: 'retained', leaseId, reservationGeneration: 2 })
    await expect(waitForHostWire(observer.messages, value => value.type === 'interaction.sample')).resolves.toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 2 } } })

    owner.messages.length = 0
    observer.messages.length = 0
    owner.socket.send(JSON.stringify({
      type: 'interaction.sample', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2,
      presentation: flowPresentation({ sequence: 3, targetParentId: 'disjoint-frame' }),
    }))
    await expect(waitForHostWire(observer.messages, value => value.type === 'interaction.sample')).resolves.toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 3 } } })
    expect(owner.messages).toEqual([])

    owner.socket.send(JSON.stringify({
      type: 'interaction.release', pageId: 'page-1', leaseId, interactionId: 'flow-interaction',
      localClaimGeneration: 1, reservationGeneration: 2, terminalSampleSequence: 3, reason: 'cancelled',
    }))
    await expect(waitForHostWire(owner.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ action: 'release', status: 'released', interactionId: 'flow-interaction' })

    const malformed = await openObservedHostSocket(address.port, identity, 'U'.repeat(24), 'host-live-malformed-client', 'host-live-malformed')
    const malformedClosed = once(malformed.socket, 'close')
    malformed.socket.send('{')
    const [malformedCode, malformedReason] = await malformedClosed
    expect(malformedCode).toBe(1007)
    expect(malformedReason.toString()).toBe('Invalid collaboration message')

    const topology = await openObservedHostSocket(address.port, identity, 'V'.repeat(24), 'host-live-topology-client', 'host-live-topology')
    topology.messages.length = 0
    topology.socket.send(JSON.stringify({
      type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1,
      presentation: flowPresentation({ interactionId: 'host-missing-source', sourceNodeId: 'host-missing-source-node' }),
    }))
    await expect(waitForHostWire(topology.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ status: 'denied', denialCode: 'missing_node', leaseId: null })
    topology.messages.length = 0
    topology.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: flowPresentation({ interactionId: 'host-after-topology-denial' }) }))
    const topologyRecovery = await waitForHostWire(topology.messages, value => value.type === 'interaction.result')
    expect(topologyRecovery).toMatchObject({ status: 'granted', denialCode: null })
    topology.socket.send(JSON.stringify({
      type: 'interaction.release', pageId: 'page-1', leaseId: topologyRecovery.leaseId, interactionId: 'host-after-topology-denial',
      localClaimGeneration: 2, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled',
    }))
    await waitForHostWire(topology.messages, value => value.type === 'interaction.result' && value.action === 'release')

    const reservedSocket = await openObservedHostSocket(address.port, identity, 'W'.repeat(24), 'host-live-reserved-client', 'host-live-reserved')
    const reservedClosed = once(reservedSocket.socket, 'close')
    reservedSocket.socket.send(JSON.stringify({
      type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1,
      presentation: flowPresentation({ interactionId: 'lease:44444444-4444-4444-8444-444444444444' }),
    }))
    const [reservedCode, reservedReason] = await reservedClosed
    expect(reservedCode).toBe(1007)
    expect(reservedReason.toString()).toBe('Invalid collaboration message')

    const recovery = await openObservedHostSocket(address.port, identity, 'X'.repeat(24), 'host-live-reserved-recovery-client', 'host-live-reserved-recovery')
    recovery.messages.length = 0
    recovery.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'host-after-reserved-rejection' }) }))
    await expect(waitForHostWire(recovery.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ status: 'granted', denialCode: null })
  })

  it('CLOUD-SYNC-AUTH-001 rejects an exact signed capability replay after disconnect', async () => {
    const verifier = new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 1n } } })
    let room: CollaborationRoomCore | undefined
    host = createHost(identity => {
      room = new CollaborationRoomCore({ identity, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000 }, { persistence: new FakePersistence(), tickets: verifier, projector, checkpoints })
      return room
    }, { tickets: verifier })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const token = signedTicket(identity)
    const first = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${token}` } })
    await once(first, 'open')
    first.send(JSON.stringify(roomOpen(identity)))
    while (room?.activeConnections !== 1) await new Promise<void>(resolve => setImmediate(resolve))
    first.close()
    await once(first, 'close')
    while (Number(room?.activeConnections) !== 0) await new Promise<void>(resolve => setImmediate(resolve))

    const replay = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${token}` } })
    await once(replay, 'open')
    const closed = once(replay, 'close')
    replay.send(JSON.stringify(roomOpen(identity)))
    const [code] = await closed
    expect(code).toBe(4401)
    expect(room?.activeConnections).toBe(0)
  })

  it('CLOUD-SYNC-AUTH-001 rejects a stale browser build before snapshot delivery', async () => {
    const verifier = new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 1n } } })
    let room: CollaborationRoomCore | undefined
    host = createHost(identity => {
      room = new CollaborationRoomCore({ identity, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000 }, { persistence: new FakePersistence(), tickets: verifier, projector, checkpoints })
      return room
    }, { tickets: verifier })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const socket = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    const messages: string[] = []
    socket.on('message', value => messages.push(value.toString()))
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send(JSON.stringify({ ...roomOpen(identity), buildId: 'stale-build' }))
    const [code, reason] = await closed

    expect(code).toBe(4401)
    expect(reason.toString()).toBe('Unauthorized')
    expect(messages).toHaveLength(0)
    expect(room?.activeConnections).toBe(0)
  })

  it('CLOUD-SYNC-DO-SEC-001 rejects any valid non-room.open first frame before admission', async () => {
    let room: FakeHostedRoom | undefined
    host = createHost(identity => {
      room = new FakeHostedRoom(identity)
      return room
    })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const socket = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send(JSON.stringify({ type: 'room.leave' }))

    const [code, reason] = await closed
    expect(code).toBe(1008)
    expect(reason.toString()).toBe('First message must be room.open')
    expect(room?.admissions).toBe(0)
    expect(host.pendingUpgradeCount).toBe(0)
  })

  it('CLOUD-SYNC-DO-SEC-001 releases pending capacity when a client never sends room.open', async () => {
    let room: FakeHostedRoom | undefined
    host = createHost(identity => {
      room = new FakeHostedRoom(identity)
      return room
    }, { handshakeTimeoutMs: 25, maxPendingUpgrades: 1 })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const silent = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    await once(silent, 'open')
    const [code, reason] = await once(silent, 'close')

    expect(code).toBe(4408)
    expect(reason.toString()).toBe('Room open timed out')
    expect(host.pendingUpgradeCount).toBe(0)
    expect(room?.admissions).toBe(0)

    const retry = await openSocket(address.port, identity, 'M'.repeat(24), 'retry-client')
    while (room?.admissions !== 1) await new Promise<void>(resolve => setImmediate(resolve))
    expect(room?.admissions).toBe(1)
    retry.close()
  })

  it('CLOUD-SYNC-DO-SEC-001 releases pending capacity when a client disconnects before room.open', async () => {
    let room: FakeHostedRoom | undefined
    host = createHost(identity => {
      room = new FakeHostedRoom(identity)
      return room
    })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const socket = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    await once(socket, 'open')
    socket.close()
    await once(socket, 'close')

    while (host.pendingUpgradeCount !== 0) await new Promise<void>(resolve => setImmediate(resolve))
    expect(room?.admissions).toBe(0)
  })

  it('CLOUD-SYNC-DO-SEC-001 releases pending capacity after invalid JSON before room.open', async () => {
    let room: FakeHostedRoom | undefined
    host = createHost(identity => {
      room = new FakeHostedRoom(identity)
      return room
    })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const socket = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('{')
    const [code, reason] = await closed

    expect(code).toBe(1007)
    expect(reason.toString()).toBe('Invalid collaboration message')
    expect(host.pendingUpgradeCount).toBe(0)
    expect(room?.admissions).toBe(0)
  })

  it('CLOUD-SYNC-DO-SEC-001 releases pending capacity after a binary first frame', async () => {
    let room: FakeHostedRoom | undefined
    host = createHost(identity => {
      room = new FakeHostedRoom(identity)
      return room
    })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const socket = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send(Buffer.from('room.open'), { binary: true })
    const [code, reason] = await closed

    expect(code).toBe(1003)
    expect(reason.toString()).toBe('First message must be room.open')
    expect(host.pendingUpgradeCount).toBe(0)
    expect(room?.admissions).toBe(0)
  })

  it('DEV-STACK-001 isolates exact room keys and reports host readiness', async () => {
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => { const room = new FakeHostedRoom(identity); rooms.push(room); return room })
    const address = await host.listen(0)
    const first = { fileId, generationId, protocolEpoch: 4 as const }
    const second = { fileId: secondFileId, generationId: secondGenerationId, protocolEpoch: 4 as const }

    const firstSocket = await openSocket(address.port, first)
    const secondSocket = await openSocket(address.port, second, 'C'.repeat(24), 'client-2')
    while (rooms.some(room => room.admissions !== 1)) await new Promise<void>(resolve => setImmediate(resolve))
    expect(rooms.map(room => room.identity)).toEqual([first, second])
    expect(rooms.map(room => room.admissions)).toEqual([1, 1])
    await expect(fetch(`http://127.0.0.1:${address.port}/readyz`).then(response => response.json())).resolves.toEqual({ ready: true, phase: 'accepting', rooms: 2 })
    firstSocket.close()
    secondSocket.close()
  })

  it('CLOUD-SYNC-CONTAINER-001 shares one startup promise across concurrent first upgrades', async () => {
    const startGate = deferred<void>()
    let creations = 0
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => {
      creations += 1
      const room = new FakeHostedRoom(identity, () => startGate.promise)
      rooms.push(room)
      return room
    })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const first = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    const secondNonce = 'D'.repeat(24)
    const second = new WebSocket(socketUrl(address.port, identity, secondNonce, 'client-2'), { origin, headers: { Authorization: `Bearer ${signedTicket(identity, secondNonce, 'client-2')}` } })
    while (host.pendingUpgradeCount < 2 || creations < 1) await new Promise<void>(resolve => setImmediate(resolve))
    expect(creations).toBe(1)
    expect(rooms[0]?.starts).toBe(1)
    startGate.resolve()
    await Promise.all([once(first, 'open'), once(second, 'open')])
    first.send(JSON.stringify(roomOpen(identity)))
    second.send(JSON.stringify(roomOpen(identity, 'client-2', 'request-2')))
    while (rooms[0]?.admissions !== 2) await new Promise<void>(resolve => setImmediate(resolve))
    expect(rooms[0]?.admissions).toBe(2)
    first.close()
    second.close()
  })

  it('DEV-STACK-001 keeps pending-upgrade capacity charged through room.open and snapshot admission', async () => {
    const snapshotGate = deferred<void>()
    let room: FakeHostedRoom | undefined
    host = createHost(identity => {
      room = new FakeHostedRoom(identity, async () => undefined, () => snapshotGate.promise)
      return room
    }, { handshakeTimeoutMs: 25, maxPendingUpgrades: 1 })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    const first = new WebSocket(socketUrl(address.port, identity), { origin, headers: { Authorization: `Bearer ${signedTicket(identity)}` } })
    await once(first, 'open')
    first.send(JSON.stringify(roomOpen(identity, clientId, 'snapshot-request')))
    while (host.pendingUpgradeCount !== 1 || room?.admissions !== 1) await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(first.readyState).toBe(WebSocket.OPEN)
    expect(host.pendingUpgradeCount).toBe(1)

    const secondNonce = 'I'.repeat(24)
    await expect(rejectedStatus(address.port, identity, signedTicket(identity, secondNonce, 'client-2'), secondNonce, 'client-2')).resolves.toContain('503')
    expect(host.pendingUpgradeCount).toBe(1)
    expect(room?.requests).toEqual([])
    snapshotGate.resolve()
    while (Number(host.pendingUpgradeCount) !== 0) await new Promise<void>(resolve => setImmediate(resolve))
    expect(room?.requests).toEqual(['snapshot-request'])
    first.close()
  })

  it('CLOUD-SYNC-CONTAINER-001 cleans up a failed startup so the same room can retry', async () => {
    let creations = 0
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => {
      creations += 1
      const room = new FakeHostedRoom(identity, creations === 1 ? async () => { throw new Error('startup failed') } : async () => undefined)
      rooms.push(room)
      return room
    })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }

    await expect(rejectedStatus(address.port, identity, signedTicket(identity))).resolves.toContain('503')
    expect(host.roomCount).toBe(0)
    const retryNonce = 'E'.repeat(24)
    const retry = await openSocket(address.port, identity, retryNonce, 'retry-client')
    expect(creations).toBe(2)
    expect(rooms.map(room => room.phase)).toEqual(['failed', 'accepting'])
    retry.close()
  })

  it('CLOUD-SYNC-CONTAINER-001 abandons a hung startup, permits retry, and closes without waiting for it', async () => {
    const never = new Promise<void>(() => undefined)
    let creations = 0
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => {
      creations += 1
      const room = new FakeHostedRoom(identity, creations === 1 ? () => never : async () => undefined)
      rooms.push(room)
      return room
    }, { startupTimeoutMs: 25 })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }

    await expect(rejectedStatus(address.port, identity, signedTicket(identity))).resolves.toContain('503')
    expect(host.roomCount).toBe(0)
    const retryNonce = 'H'.repeat(24)
    await openSocket(address.port, identity, retryNonce, 'retry-client')
    expect(creations).toBe(2)
    expect(host.roomCount).toBe(1)
    await expect(Promise.race([
      host.close(),
      new Promise((_, rejectClose) => setTimeout(() => rejectClose(new Error('host close timed out')), 500)),
    ])).resolves.toEqual({ status: 'stopped', roomCount: 1 })
    expect(rooms.map(room => room.drains)).toEqual([0, 1])
  })

  it('CLOUD-SYNC-CONTAINER-001 drains a late successful startup without disturbing its replacement', async () => {
    const lateStart = deferred<void>()
    let creations = 0
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => {
      creations += 1
      const room = new FakeHostedRoom(identity, creations === 1 ? () => lateStart.promise : async () => undefined)
      rooms.push(room)
      return room
    }, { startupTimeoutMs: 25 })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }

    await expect(rejectedStatus(address.port, identity, signedTicket(identity))).resolves.toContain('503')
    const retryNonce = 'J'.repeat(24)
    const replacement = await openSocket(address.port, identity, retryNonce, 'retry-client')
    lateStart.resolve()
    while (rooms[0]?.drains !== 1) await new Promise<void>(resolve => setImmediate(resolve))
    expect(rooms.map(room => room.phase)).toEqual(['stopped', 'accepting'])
    expect(rooms[1]?.admissions).toBe(1)
    expect(host.roomCount).toBe(1)
    replacement.close()
  })

  it('CLOUD-SYNC-CONTAINER-001 prunes terminal authority before starting a replacement generation', async () => {
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => { const room = new FakeHostedRoom(identity); rooms.push(room); return room })
    const address = await host.listen(0)
    const firstIdentity = { fileId, generationId, protocolEpoch: 4 as const }
    const replacementIdentity = { fileId, generationId: alternateGenerationId, protocolEpoch: 4 as const }
    const first = await openSocket(address.port, firstIdentity)
    rooms[0]!.phase = 'failed'

    const replacementNonce = 'K'.repeat(24)
    const replacement = await openSocket(address.port, replacementIdentity, replacementNonce, 'replacement-client')
    expect(rooms.map(room => room.identity)).toEqual([firstIdentity, replacementIdentity])
    expect(rooms[0]?.drains).toBe(1)
    expect(rooms[1]?.phase).toBe('accepting')
    expect(host.roomCount).toBe(1)
    first.close()
    replacement.close()
  })

  it('CLOUD-SYNC-CONTAINER-001 recovers room capacity held by a terminal room', async () => {
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => { const room = new FakeHostedRoom(identity); rooms.push(room); return room }, { maxRooms: 1 })
    const address = await host.listen(0)
    const firstIdentity = { fileId, generationId, protocolEpoch: 4 as const }
    const secondIdentity = { fileId: secondFileId, generationId: secondGenerationId, protocolEpoch: 4 as const }
    const first = await openSocket(address.port, firstIdentity)
    rooms[0]!.phase = 'stopped'

    const second = await openSocket(address.port, secondIdentity, 'L'.repeat(24), 'second-client')
    expect(rooms).toHaveLength(2)
    expect(host.roomCount).toBe(1)
    expect(rooms[1]?.phase).toBe('accepting')
    first.close()
    second.close()
  })

  it('CLOUD-SYNC-CONTAINER-001 rejects a concurrent losing generation for an active file', async () => {
    host = createHost(identity => new FakeHostedRoom(identity))
    const address = await host.listen(0)
    const winner = { fileId, generationId, protocolEpoch: 4 as const }
    const loser = { fileId, generationId: alternateGenerationId, protocolEpoch: 4 as const }
    const winnerSocket = await openSocket(address.port, winner)

    const loserNonce = 'F'.repeat(24)
    await expect(rejectedStatus(address.port, loser, signedTicket(loser, loserNonce, 'loser-client'), loserNonce, 'loser-client')).resolves.toContain('409')
    expect(host.roomCount).toBe(1)
    winnerSocket.close()
  })

  it('DEV-STACK-001 drains every active room during host shutdown', async () => {
    const rooms: FakeHostedRoom[] = []
    host = createHost(identity => { const room = new FakeHostedRoom(identity); rooms.push(room); return room })
    const address = await host.listen(0)
    const first = { fileId, generationId, protocolEpoch: 4 as const }
    const second = { fileId: secondFileId, generationId: secondGenerationId, protocolEpoch: 4 as const }
    await openSocket(address.port, first)
    await openSocket(address.port, second, 'G'.repeat(24), 'client-2')

    await expect(host.close()).resolves.toEqual({ status: 'stopped', roomCount: 2 })
    expect(rooms.map(room => room.drains)).toEqual([1, 1])
    expect(host.phase).toBe('stopped')
  })

  it('DEV-STACK-001 bounds shutdown when an injected room drain never settles', async () => {
    const never = new Promise<void>(() => undefined)
    host = createHost(identity => new FakeHostedRoom(identity, async () => undefined, async () => undefined, () => never), { shutdownTimeoutMs: 25 })
    const address = await host.listen(0)
    const identity = { fileId, generationId, protocolEpoch: 4 as const }
    await openSocket(address.port, identity)

    await expect(Promise.race([
      host.close(),
      new Promise((_, rejectClose) => setTimeout(() => rejectClose(new Error('host close timed out')), 500)),
    ])).resolves.toEqual({ status: 'room-drain-failed', roomCount: 1 })
    expect(host.phase).toBe('stopped')
  })
})
