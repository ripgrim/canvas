import { once } from 'node:events'
import { parseCollaborationServerMessage } from '@canvas/sync-protocol'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoomNetworkServer } from '../src/network.js'
import { createSemanticProjector } from '../src/projector.js'
import { CollaborationRoomCore } from '../src/room-core.js'
import { checkpoints, clientId, connectionNonce, FakePersistence, fileId, flowDocument, flowPresentation, generationId, projection, projector, ticket, tickets } from './support.js'

const origin = 'http://127.0.0.1:4317'

async function waitForWire(messages: readonly string[], predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const expiresAt = Date.now() + 1_000
  while (Date.now() < expiresAt) {
    const match = messages.map(message => JSON.parse(message) as Record<string, unknown>).find(predicate)
    if (match) return match
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Expected WebSocket message was not received')
}

async function openObservedSocket(port: number, nonce: string, socketClientId: string, requestId: string): Promise<Readonly<{ socket: WebSocket; messages: string[] }>> {
  const url = `ws://127.0.0.1:${port}/sync/${fileId}/${generationId}?clientId=${socketClientId}&connectionNonce=${nonce}`
  const socket = new WebSocket(url, { origin, headers: { Authorization: `Bearer ${ticket}` } })
  const messages: string[] = []
  socket.on('message', data => messages.push(data.toString()))
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId, fileId, clientId: socketClientId, buildId: 'test-build' }))
  await waitForWire(messages, value => value.type === 'presence.roster')
  return Object.freeze({ socket, messages })
}

describe('room network boundary', () => {
  let cleanup: (() => Promise<unknown>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('CLOUD-SYNC-DO-SEC-001 and CLOUD-SYNC-AUTH-001 bind authority at the real WebSocket boundary', async () => {
    let verificationCount = 0
    const verifier = tickets()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: {
        async verify(context) { verificationCount += 1; return verifier.verify(context) },
        async consume(authorization, input) { return verifier.consume(authorization, input) },
        async isCurrent(value, nowUnixMs) { return verifier.isCurrent(value, nowUnixMs) },
      },
      projector,
      checkpoints,
    })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await network.listen(0)
    cleanup = () => network.close()
    const base = `http://${address.hostname}:${address.port}`
    await expect(fetch(`${base}/readyz`).then(response => response.json())).resolves.toEqual({ ready: true, phase: 'accepting' })

    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1:4317', headers: { Authorization: `Bearer ${ticket}` } })
    const messages: string[] = []
    socket.on('message', data => messages.push(data.toString()))
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId: 'network-request', fileId, clientId, buildId: 'test-build' }))
    while (messages.length < 8) await once(socket, 'message')
    expect(messages.map(message => parseCollaborationServerMessage(message).type)).toEqual(['room.assigned', 'load.phase', 'snapshot.begin', 'snapshot.chunk', 'snapshot.end', 'load.phase', 'sync.ready', 'presence.roster'])
    expect(messages.slice(0, 7).map(message => parseCollaborationServerMessage(message)).every(message => 'requestId' in message && message.requestId === 'network-request')).toBe(true)
    expect(verificationCount).toBe(1)
    expect(messages.join('')).not.toContain(ticket)
    expect(messages.join('')).not.toMatch(/roomTicket|authorization|cookie|accessEpoch/i)

    const closed = once(socket, 'close')
    socket.send(JSON.stringify({
      type: 'operation.submit',
      clientId: 'forged-client',
      generationId: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
      operation: { mutationId: 'mutation-forged', baseSequence: '0', command: { type: 'node.rename', nodeId: 'node-1', name: 'Forged' } },
    }))
    const [code, reason] = await closed
    expect(code).toBe(1007)
    expect(reason.toString()).toBe('Invalid collaboration message')
    expect(verificationCount).toBe(1)
  })

  it('CLOUD-SYNC-DO-SEC-001 rejects non-exact query authority before ticket verification', async () => {
    let verificationCount = 0
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: {
        async verify() { verificationCount += 1; return null },
        async consume() { return null },
        async isCurrent() { return false },
      },
      projector,
      checkpoints,
    })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: [origin], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await network.listen(0)
    cleanup = () => network.close()
    const base = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}`
    const validQuery = `clientId=${clientId}&connectionNonce=${connectionNonce}`
    const invalid = [
      `${base}?${validQuery}&role=owner`,
      `${base}?${validQuery}&clientId=client-2`,
      `${base}?${validQuery}&connectionNonce=${'x'.repeat(24)}`,
      `${base}?connectionNonce=${connectionNonce}`,
      `${base}?clientId=${clientId}`,
      `${base}?clientId=%20client-1&connectionNonce=${connectionNonce}`,
      `${base}?clientId=${clientId}&connectionNonce=short`,
    ]
    for (const candidate of invalid) {
      const socket = new WebSocket(candidate, { origin, headers: { Authorization: `Bearer ${ticket}` } })
      const [error] = await once(socket, 'error')
      expect(String(error), candidate).toContain('404')
    }
    expect(verificationCount).toBe(0)
    expect(room.activeConnections).toBe(0)
  })

  it('CLOUD-SYNC-GESTURE-001-C2-LIVE and CLOUD-SYNC-SCHEMA-001-C2-LIVE carry flow leases through the room network WebSocket', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(flowDocument())
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: createSemanticProjector(), checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: [origin], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await network.listen(0)
    cleanup = () => network.close()

    const owner = await openObservedSocket(address.port, connectionNonce, clientId, 'live-owner')
    const observer = await openObservedSocket(address.port, 'O'.repeat(24), 'live-observer-client', 'live-observer')
    owner.messages.length = 0
    observer.messages.length = 0

    const acquired = flowPresentation()
    owner.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: acquired }))
    const grant = await waitForWire(owner.messages, value => value.type === 'interaction.result')
    expect(grant).toMatchObject({ action: 'acquire', status: 'granted', interactionId: 'flow-interaction', denialCode: null })
    const leaseId = String(grant.leaseId)
    const firstPeerSample = await waitForWire(observer.messages, value => value.type === 'interaction.sample')
    expect(firstPeerSample).toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 1 } } })

    owner.messages.length = 0
    observer.messages.length = 0
    const reservationPresentation = flowPresentation({ sequence: 2, targetParentId: 'disjoint-frame' })
    owner.socket.send(JSON.stringify({
      type: 'interaction.reserve', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2,
      targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' } }, presentation: reservationPresentation,
    }))
    await expect(waitForWire(owner.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ action: 'reserve', status: 'retained', leaseId, reservationGeneration: 2 })
    await expect(waitForWire(observer.messages, value => value.type === 'interaction.sample')).resolves.toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 2 } } })

    owner.messages.length = 0
    observer.messages.length = 0
    owner.socket.send(JSON.stringify({
      type: 'interaction.sample', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2,
      presentation: flowPresentation({ sequence: 3, targetParentId: 'disjoint-frame' }),
    }))
    await expect(waitForWire(observer.messages, value => value.type === 'interaction.sample')).resolves.toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 3 } } })
    expect(owner.messages).toEqual([])

    owner.socket.send(JSON.stringify({
      type: 'interaction.release', pageId: 'page-1', leaseId, interactionId: 'flow-interaction',
      localClaimGeneration: 1, reservationGeneration: 2, terminalSampleSequence: 3, reason: 'cancelled',
    }))
    await expect(waitForWire(owner.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ action: 'release', status: 'released', interactionId: 'flow-interaction' })

    const malformed = await openObservedSocket(address.port, 'P'.repeat(24), 'live-malformed-client', 'live-malformed')
    const malformedClosed = once(malformed.socket, 'close')
    malformed.socket.send('{')
    const [malformedCode, malformedReason] = await malformedClosed
    expect(malformedCode).toBe(1007)
    expect(malformedReason.toString()).toBe('Invalid collaboration message')

    const topology = await openObservedSocket(address.port, 'Q'.repeat(24), 'live-topology-client', 'live-topology')
    topology.messages.length = 0
    topology.socket.send(JSON.stringify({
      type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1,
      presentation: flowPresentation({ interactionId: 'missing-source', sourceNodeId: 'missing-source-node' }),
    }))
    await expect(waitForWire(topology.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ status: 'denied', denialCode: 'missing_node', leaseId: null })
    topology.messages.length = 0
    topology.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: flowPresentation({ interactionId: 'after-topology-denial' }) }))
    const topologyRecovery = await waitForWire(topology.messages, value => value.type === 'interaction.result')
    expect(topologyRecovery).toMatchObject({ status: 'granted', denialCode: null })
    topology.socket.send(JSON.stringify({
      type: 'interaction.release', pageId: 'page-1', leaseId: topologyRecovery.leaseId, interactionId: 'after-topology-denial',
      localClaimGeneration: 2, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled',
    }))
    await waitForWire(topology.messages, value => value.type === 'interaction.result' && value.action === 'release')

    const reservedSocket = await openObservedSocket(address.port, 'R'.repeat(24), 'live-reserved-client', 'live-reserved')
    const reservedClosed = once(reservedSocket.socket, 'close')
    reservedSocket.socket.send(JSON.stringify({
      type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1,
      presentation: flowPresentation({ interactionId: 'lease:11111111-1111-4111-8111-111111111111' }),
    }))
    const [reservedCode, reservedReason] = await reservedClosed
    expect(reservedCode).toBe(1007)
    expect(reservedReason.toString()).toBe('Invalid collaboration message')

    const recovery = await openObservedSocket(address.port, 'S'.repeat(24), 'live-reserved-recovery-client', 'live-reserved-recovery')
    recovery.messages.length = 0
    recovery.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'after-reserved-rejection' }) }))
    await expect(waitForWire(recovery.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ status: 'granted', denialCode: null })
  })

  it('rejects cross-origin upgrades and non-loopback binds', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence: new FakePersistence(), tickets: tickets(), projector, checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    cleanup = () => network.close()
    await expect(network.listen(0, '0.0.0.0')).rejects.toThrow('loopback')
    const address = await network.listen(0)
    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'https://wrong.example', headers: { Authorization: `Bearer ${ticket}` } })
    const [error] = await once(socket, 'error')
    expect(String(error)).toContain('403')
  })

  it('rejects an invalid capability before completing the WebSocket upgrade', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence: new FakePersistence(), tickets: { async verify() { return null }, async consume() { return null }, async isCurrent() { return false } }, projector, checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    cleanup = () => network.close()
    const address = await network.listen(0)
    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1:4317', headers: { Authorization: `Bearer ${ticket}` } })
    const [error] = await once(socket, 'error')
    expect(String(error)).toContain('401')
    expect(room.activeConnections).toBe(0)
  })

  it('CLOUD-SYNC-DO-SEC-001 closes an authorized socket that never sends room.open', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence: new FakePersistence(), tickets: tickets(), projector, checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 25 })
    cleanup = () => network.close()
    const address = await network.listen(0)
    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1:4317', headers: { Authorization: `Bearer ${ticket}` } })
    await once(socket, 'open')
    const [code, reason] = await once(socket, 'close')

    expect(code).toBe(4408)
    expect(reason.toString()).toBe('Room open timed out')
    expect(room.activeConnections).toBe(0)
  })
})
