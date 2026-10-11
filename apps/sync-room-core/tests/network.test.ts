import { once } from 'node:events'
import { parseCollaborationServerMessage } from '@canvas/sync-protocol'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoomNetworkServer } from '../src/network.js'
import { CollaborationRoomCore } from '../src/room-core.js'
import { checkpoints, clientId, connectionNonce, FakePersistence, fileId, generationId, projector, ticket, tickets } from './support.js'

describe('room network boundary', () => {
  let cleanup: (() => Promise<unknown>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('CLOUD-SYNC-DO-SEC-001 and CLOUD-SYNC-AUTH-001 bind authority at the real WebSocket boundary', async () => {
    let verificationCount = 0
    const verifier = tickets()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
    socket.send(JSON.stringify({ type: 'room.open', protocolEpoch: 2, schemaVersion: 1, requestId: 'network-request', fileId, clientId, buildId: 'test-build' }))
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

  it('rejects cross-origin upgrades and non-loopback binds', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
