import { describe, expect, it } from 'vitest'
import { CollaborationRoomCore } from '../src/room-core.js'
import type { RoomPeer } from '../src/room-core.js'
import { checkpoints, clientId, connectionNonce, document, FakePersistence, fileId, generationId, projection, projector, ticket, tickets } from './support.js'

describe('large room memory boundary', () => {
  it('streams a 50 MiB projection in bounded frames without retaining document payloads in room logs', async () => {
    const payload = document({ payload: 'x'.repeat(50 * 1024 * 1024) })
    const persistence = new FakePersistence()
    persistence.current = projection(payload)
    const events: Readonly<Record<string, string | number | boolean | null>>[] = []
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 10_000,
    }, { persistence, tickets: tickets(), projector, checkpoints, logger: { event(value) { events.push(value) } } })
    await room.start()
    let chunks = 0
    let largestFrame = 0
    const peer: RoomPeer = {
      connectionId: 'memory-connection',
      send(message) {
        largestFrame = Math.max(largestFrame, Buffer.byteLength(message))
        if (message.includes('"type":"snapshot.chunk"')) chunks += 1
      },
      close() {},
    }
    const baseline = process.memoryUsage().rss
    await room.admit({
      peer,
      ticketContext: { token: ticket, fileId, generationId, clientId, connectionNonce, nowUnixMs: Date.now() },
      open: { type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId: 'memory-request', fileId, clientId, buildId: 'test-build' },
    })
    const delta = process.memoryUsage().rss - baseline
    expect(chunks).toBeGreaterThan(300)
    expect(largestFrame).toBeLessThan(256 * 1024)
    expect(delta).toBeLessThan(192 * 1024 * 1024)
    expect(JSON.stringify(events)).not.toContain('xxxxxxxx')
    room.disconnect(peer.connectionId)
    await room.drain()
  }, 30_000)
})
