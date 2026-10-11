import { encodeCollaborationMessage, parseCollaborationClientMessage, parseCollaborationServerMessage } from '@canvas/sync-protocol'
import type { VerifiedRoomTicketClaims } from '@canvas/sync-protocol'
import { describe, expect, it } from 'vitest'
import type { RoomTicketContext, RoomTicketVerifier } from '../src/contracts.js'
import { CollaborationRoomCore, RoomNotAcceptingError } from '../src/room-core.js'
import { checkpoints, clientId, connectionNonce, deferred, document, FakePeer, FakePersistence, fileId, generationId, lease, projection, projector, subjectId, ticket, tickets } from './support.js'

const createRoom = (persistence = new FakePersistence(), role: 'owner' | 'viewer' = 'owner') => new CollaborationRoomCore({
  identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
}, { persistence, tickets: tickets(role), projector, checkpoints })

const open = (requestId = 'request-1', openFileId = fileId, openClientId = clientId) => ({
  type: 'room.open' as const,
  protocolEpoch: 2 as const,
  schemaVersion: 1 as const,
  requestId,
  fileId: openFileId,
  clientId: openClientId,
  buildId: 'test-build',
})
const admission = (peer: FakePeer, nonce = connectionNonce, requestId = 'request-1', admissionClientId = nonce === connectionNonce ? clientId : `client-${nonce[0]!.toLowerCase()}`) => ({
  peer,
  ticketContext: { token: ticket, fileId, generationId, clientId: admissionClientId, connectionNonce: nonce, nowUnixMs: Date.now() },
  open: open(requestId, fileId, admissionClientId),
})
const submit = (mutationId = 'mutation-1', baseSequence = '0') => ({
  type: 'operation.submit' as const,
  operation: { mutationId, baseSequence, command: { type: 'node.rename' as const, nodeId: 'node-1', name: 'Renamed' } },
})
const interaction = (sequence: number, interactionId: string, nodeIds: readonly string[], transforms: readonly Readonly<{ nodeId: string; dx: number; dy: number }>[] = [], pageId = 'page-1') => ({
  type: 'presence.update' as const,
  sequence,
  data: { pageId, interaction: { interactionId, pageId, kind: 'move' as const, nodeIds, transforms } },
})
const waitUntil = async (condition: () => boolean, timeoutMs = 500): Promise<void> => {
  const expiresAt = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= expiresAt) throw new Error('Condition was not reached before timeout')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

type ClaimsWithoutBuild = Omit<VerifiedRoomTicketClaims, 'buildId'>
function customTickets(resolve: (context: RoomTicketContext) => Promise<ClaimsWithoutBuild | null>, current: (claims: VerifiedRoomTicketClaims, nowUnixMs: number) => Promise<boolean>): RoomTicketVerifier {
  const issued = new WeakSet<object>()
  return {
    async verify(context) {
      const value = await resolve(context)
      if (!value) return null
      const authorization = Object.freeze({ claims: Object.freeze({ ...value, buildId: 'test-build' }) })
      issued.add(authorization)
      return authorization
    },
    async consume(authorization, input) {
      if (!issued.delete(authorization) || authorization.claims.buildId !== input.buildId || !await current(authorization.claims, input.nowUnixMs)) return null
      return authorization.claims
    },
    isCurrent: current,
  }
}

describe('collaboration room authority', () => {
  it('CLOUD-SYNC-CLIENT-001 propagates the room.open request id through assignment and the full snapshot', async () => {
    const persistence = new FakePersistence()
    const room = createRoom(persistence)
    await room.start()
    const peer = new FakePeer()
    await expect(room.admit(admission(peer, connectionNonce, 'request-from-client'))).resolves.toBe(true)
    expect(persistence.calls.slice(0, 3)).toEqual(['register', 'acquire', 'bootstrap'])
    const messages = peer.messages.map(message => parseCollaborationServerMessage(message))
    expect(messages.map(message => message.type)).toEqual(['room.assigned', 'load.phase', 'snapshot.begin', 'snapshot.chunk', 'snapshot.end', 'load.phase', 'sync.ready', 'presence.roster'])
    expect(messages.map(message => 'requestId' in message ? message.requestId : null)).toEqual([...Array(7).fill('request-from-client'), null])
    expect(room.activeConnections).toBe(1)
    await expect(room.drain()).resolves.toEqual({ status: 'stopped' })
  })

  it('CLOUD-SYNC-DO-SEC-001 rejects room.open identities outside the authorized admission scope', async () => {
    const room = createRoom()
    await room.start()

    const wrongFile = new FakePeer('wrong-file')
    await expect(room.admit({ ...admission(wrongFile), open: open('request-wrong-file', '11111111-1111-4111-8111-111111111111') })).resolves.toBe(false)
    const wrongClient = new FakePeer('wrong-client')
    await expect(room.admit({ ...admission(wrongClient, 'C'.repeat(24)), open: open('request-wrong-client', fileId, 'other-client') })).resolves.toBe(false)

    expect(room.activeConnections).toBe(0)
    expect(wrongFile.messages).toHaveLength(0)
    expect(wrongClient.messages).toHaveLength(0)
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 rejects a duplicate participant client identity', async () => {
    const room = createRoom()
    await room.start()
    const first = new FakePeer('first')
    const duplicate = new FakePeer('duplicate')
    await expect(room.admit(admission(first))).resolves.toBe(true)
    await expect(room.admit(admission(duplicate, 'D'.repeat(24), 'duplicate-request', clientId))).resolves.toBe(false)
    expect(room.activeConnections).toBe(1)
    expect(duplicate.messages).toHaveLength(0)
    await room.drain()
  })

  it('CLOUD-SYNC-DO-SEC-001 verifies a capability once and consumes the resulting authorization once', async () => {
    let verificationCount = 0
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => { verificationCount += 1; return { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce } },
        async () => true,
      ),
      projector,
      checkpoints,
    })
    await room.start()
    const peer = new FakePeer('stale-authorization')
    const request = admission(peer)
    const authorization = await room.authorize(request.ticketContext)
    expect(authorization).not.toBeNull()
    await expect(room.admitAuthorized(peer, authorization!, request.open)).resolves.toBe(true)
    await expect(room.admitAuthorized(new FakePeer('reused'), authorization!, request.open)).resolves.toBe(false)
    expect(verificationCount).toBe(1)
    expect(room.activeConnections).toBe(1)
    await room.drain()
  })

  it('CLOUD-SYNC-AUTH-001 records a safe reason when capability consumption rejects admission', async () => {
    const events: Readonly<Record<string, string | number | boolean | null>>[] = []
    const verifier = customTickets(
      async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
      async () => false,
    )
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence: new FakePersistence(), tickets: verifier, projector, checkpoints, logger: { event(value) { events.push(value) } } })
    await room.start()
    const request = admission(new FakePeer('rejected'))
    const authorization = await room.authorize(request.ticketContext)
    expect(authorization).not.toBeNull()

    await expect(room.admitAuthorized(request.peer, authorization!, request.open)).resolves.toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ event: 'room_admission_rejected', reason: 'capability', fileId, generationId }))
    expect(JSON.stringify(events)).not.toContain(ticket)
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 does not query server-side access for each awareness sample', async () => {
    let current = true
    let currentChecks = 0
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
        async () => { currentChecks += 1; return current },
      ),
      projector,
      checkpoints,
    })
    await room.start()
    const peer = new FakePeer('identity-mutation')
    const observer = new FakePeer('presence-observer')
    await expect(room.admit(admission(peer))).resolves.toBe(true)
    await expect(room.admit(admission(observer, 'P'.repeat(24), 'observer-request', 'client-observer'))).resolves.toBe(true)
    const roster = parseCollaborationServerMessage(observer.messages.at(-1)!)
    expect(roster).toMatchObject({ type: 'presence.roster' })
    if (roster.type !== 'presence.roster') throw new Error('Expected presence roster')
    expect(roster.participants).toHaveLength(2)
    peer.messages.length = 0
    observer.messages.length = 0
    const checksAfterAdmission = currentChecks
    current = false

    for (let sequence = 1; sequence <= 200; sequence += 1) {
      await room.receive(peer.connectionId, { type: 'presence.update', sequence, data: { pageId: 'page-1', cursor: { pageId: 'page-1', x: sequence, y: sequence } } })
    }

    expect(currentChecks).toBe(checksAfterAdmission)
    expect(peer.messages).toHaveLength(0)
    expect(peer.closes).toHaveLength(0)
    expect(observer.messages).toHaveLength(200)
    expect(parseCollaborationServerMessage(observer.messages.at(-1)!)).toMatchObject({ type: 'presence.changed', participant: { sequence: 200, data: { cursor: { x: 200, y: 200 } } } })
    expect(room.activeConnections).toBe(2)
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001 grants the first overlapping interaction and releases it explicitly', async () => {
    const room = createRoom()
    await room.start()
    const first = new FakePeer('first-lock-owner')
    const second = new FakePeer('second-lock-contender')
    await room.admit(admission(first))
    await room.admit(admission(second, 'L'.repeat(24), 'second-lock-request', 'client-second'))
    first.messages.length = 0
    second.messages.length = 0

    await room.receive(first.connectionId, interaction(1, 'gesture-first', ['node-1'], [{ nodeId: 'node-1', dx: 1, dy: 2 }]))
    expect(first.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-first' }) }) }),
    }))
    expect(second.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-first' }) }) }),
    }))
    const firstMessageCount = first.messages.length
    const secondMessageCount = second.messages.length

    await room.receive(first.connectionId, interaction(2, 'gesture-first', ['node-1'], [{ nodeId: 'node-1', dx: 2, dy: 3 }]))
    expect(first.messages).toHaveLength(firstMessageCount)
    expect(second.messages).toHaveLength(secondMessageCount + 1)

    await room.receive(second.connectionId, interaction(1, 'gesture-second', ['node-1'], [{ nodeId: 'node-1', dx: 9, dy: 9 }]))
    expect(first.messages).toHaveLength(firstMessageCount)
    expect(second.messages).toHaveLength(secondMessageCount + 1)

    await room.receive(first.connectionId, { type: 'presence.update', sequence: 3, data: { interaction: null } })
    expect(first.messages).toHaveLength(firstMessageCount + 1)
    await room.receive(second.connectionId, interaction(2, 'gesture-second', ['node-1'], [{ nodeId: 'node-1', dx: 3, dy: 4 }]))
    expect(first.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-second' }) }) }),
    }))
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001 rejects lock mutation, permits disjoint nodes, and releases locks on disconnect', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(document({
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        'node-1': { id: 'node-1', type: 'frame', name: 'One', styles: { left: 0, top: 0, width: 100, height: 100 } },
        'node-2': { id: 'node-2', type: 'frame', name: 'Two', styles: { left: 150, top: 0, width: 100, height: 100 } },
      },
      relationships: {
        'node-1': { parentId: 'root-1', orderKey: 'V' },
        'node-2': { parentId: 'root-1', orderKey: 'W' },
      },
    }))
    const room = createRoom(persistence)
    await room.start()
    const first = new FakePeer('first-lock-owner')
    const second = new FakePeer('second-lock-contender')
    await room.admit(admission(first))
    await room.admit(admission(second, 'M'.repeat(24), 'second-lock-request', 'client-second'))
    first.messages.length = 0
    second.messages.length = 0

    await room.receive(first.connectionId, interaction(1, 'gesture-first', ['node-1']))
    const beforeMutation = second.messages.length
    await room.receive(first.connectionId, interaction(2, 'forged-gesture', ['node-2']))
    expect(second.messages).toHaveLength(beforeMutation)
    await room.receive(second.connectionId, interaction(1, 'gesture-second', ['node-2']))
    expect(first.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-second' }) }) }),
    }))

    room.disconnect(first.connectionId)
    await room.receive(second.connectionId, { type: 'presence.update', sequence: 2, data: { interaction: null } })
    await room.receive(second.connectionId, interaction(3, 'gesture-second-next', ['node-1']))
    expect(second.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-second-next' }) }) }),
    }))
    expect(room.activeConnections).toBe(1)
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001 rejects a losing semantic command while another session owns the node', async () => {
    const persistence = new FakePersistence()
    const room = createRoom(persistence)
    await room.start()
    const first = new FakePeer('first-lock-owner')
    const second = new FakePeer('second-lock-contender')
    await room.admit(admission(first))
    await room.admit(admission(second, 'N'.repeat(24), 'second-lock-request', 'client-second'))
    first.messages.length = 0
    second.messages.length = 0

    await room.receive(first.connectionId, interaction(1, 'gesture-first', ['node-1']))
    await room.receive(second.connectionId, submit('mutation-locked-node'))

    expect(persistence.calls).not.toContain('append:mutation-locked-node')
    expect(second.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'room.error', code: 'invalid_operation', mutationId: 'mutation-locked-node', message: 'Node is being edited in another session.',
    }))
    await room.receive(first.connectionId, submit('mutation-lock-owner'))
    expect(persistence.calls).toContain('append:mutation-lock-owner')
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001 protects locked descendants from ancestor, page, and nested batch commands', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(document({
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        parent: { id: 'parent', type: 'frame', name: 'Parent', styles: { left: 0, top: 0, width: 200, height: 200 } },
        child: { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 10, top: 10, width: 20, height: 20 } },
        spare: { id: 'spare', type: 'rectangle', name: 'Spare', styles: { left: 250, top: 10, width: 20, height: 20 } },
      },
      relationships: {
        parent: { parentId: 'root-1', orderKey: 'V' },
        child: { parentId: 'parent', orderKey: 'V' },
        spare: { parentId: 'root-1', orderKey: 'W' },
      },
    }))
    const room = createRoom(persistence)
    await room.start()
    const owner = new FakePeer('descendant-lock-owner')
    const contender = new FakePeer('ancestor-command-contender')
    await room.admit(admission(owner))
    await room.admit(admission(contender, 'Q'.repeat(24), 'ancestor-command-request', 'client-contender'))
    owner.messages.length = 0
    contender.messages.length = 0
    await room.receive(owner.connectionId, interaction(1, 'gesture-descendant', ['child']))

    await room.receive(contender.connectionId, {
      type: 'operation.submit',
      operation: {
        mutationId: 'mutation-nested-ancestor',
        baseSequence: '0',
        command: { type: 'batch', commands: [{ type: 'batch', commands: [{ type: 'node.setStyles', nodeId: 'parent', styles: { left: 25 } }] }] },
      },
    })
    await room.receive(contender.connectionId, {
      type: 'operation.submit',
      operation: { mutationId: 'mutation-page-delete', baseSequence: '0', command: { type: 'page.delete', pageId: 'page-1' } },
    })
    await room.receive(contender.connectionId, {
      type: 'operation.submit',
      operation: { mutationId: 'mutation-insert-locked-parent', baseSequence: '0', command: { type: 'node.insert', node: { id: 'inserted', type: 'rectangle', name: 'Inserted', styles: { left: 0, top: 0, width: 10, height: 10 } }, placement: { parentId: 'parent' } } },
    })
    await room.receive(contender.connectionId, {
      type: 'operation.submit',
      operation: { mutationId: 'mutation-reparent-locked-parent', baseSequence: '0', command: { type: 'node.reparent', nodeId: 'spare', placement: { parentId: 'parent' } } },
    })

    expect(persistence.calls).not.toContain('append:mutation-nested-ancestor')
    expect(persistence.calls).not.toContain('append:mutation-page-delete')
    expect(persistence.calls).not.toContain('append:mutation-insert-locked-parent')
    expect(persistence.calls).not.toContain('append:mutation-reparent-locked-parent')
    expect(contender.messages.map(message => parseCollaborationServerMessage(message))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'room.error', mutationId: 'mutation-nested-ancestor', code: 'invalid_operation' }),
      expect.objectContaining({ type: 'room.error', mutationId: 'mutation-page-delete', code: 'invalid_operation' }),
      expect.objectContaining({ type: 'room.error', mutationId: 'mutation-insert-locked-parent', code: 'invalid_operation' }),
      expect.objectContaining({ type: 'room.error', mutationId: 'mutation-reparent-locked-parent', code: 'invalid_operation' }),
    ]))
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001 rejects locks for missing nodes and nodes on another page', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(document({
      pages: [
        { id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' },
        { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' },
      ],
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        'node-1': { id: 'node-1', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 100, height: 100 } },
        'root-2': { id: 'root-2', type: 'root' },
        'node-2': { id: 'node-2', type: 'frame', name: 'Other', styles: { left: 0, top: 0, width: 100, height: 100 } },
      },
      relationships: {
        'node-1': { parentId: 'root-1', orderKey: 'V' },
        'node-2': { parentId: 'root-2', orderKey: 'V' },
      },
    }))
    const room = createRoom(persistence)
    await room.start()
    const owner = new FakePeer('invalid-lock-owner')
    const observer = new FakePeer('invalid-lock-observer')
    await room.admit(admission(owner))
    await room.admit(admission(observer, 'S'.repeat(24), 'invalid-lock-observer-request', 'client-observer'))
    owner.messages.length = 0
    observer.messages.length = 0

    await room.receive(owner.connectionId, interaction(1, 'missing-node-lock', ['missing']))
    await room.receive(owner.connectionId, interaction(2, 'cross-page-lock', ['node-2']))

    expect(owner.messages).toHaveLength(0)
    expect(observer.messages).toHaveLength(0)
    await room.receive(observer.connectionId, interaction(1, 'valid-node-lock', ['node-1']))
    expect(owner.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'valid-node-lock' }) }) }),
    }))
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001 does not grant a lock over a mutation waiting to commit', async () => {
    const persistence = new FakePersistence()
    const appendEntered = deferred<void>()
    const releaseAppend = deferred<void>()
    persistence.append = async input => {
      appendEntered.resolve()
      await releaseAppend.promise
      delete persistence.append
      return persistence.appendOperation(input)
    }
    const room = createRoom(persistence)
    await room.start()
    const writer = new FakePeer('pending-writer')
    const contender = new FakePeer('pending-lock-contender')
    await room.admit(admission(writer))
    await room.admit(admission(contender, 'R'.repeat(24), 'pending-lock-request', 'client-contender'))
    writer.messages.length = 0
    contender.messages.length = 0

    const pendingWrite = room.receive(writer.connectionId, submit('mutation-pending-lock'))
    await appendEntered.promise
    await room.receive(contender.connectionId, interaction(1, 'gesture-during-mutation', ['node-1']))
    expect(contender.messages.map(message => parseCollaborationServerMessage(message))).not.toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-during-mutation' }) }) }),
    }))

    releaseAppend.resolve()
    await pendingWrite
    await room.receive(contender.connectionId, interaction(1, 'gesture-after-mutation', ['node-1']))
    expect(contender.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-after-mutation' }) }) }),
    }))
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 prunes revoked sessions before constructing a new roster', async () => {
    const revoked = new Set<string>()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(async context => {
        if (revoked.has(context.clientId)) return null
        return { subjectId: context.clientId === clientId ? subjectId : 'subject-new', displayName: context.clientId === clientId ? 'Alpha' : 'New participant', avatarUrl: null, fileId, role: 'owner' as const, generationId, protocolEpoch: 2 as const, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
      }, async value => !revoked.has(value.clientId)),
      projector,
      checkpoints,
    })
    await room.start()
    const stale = new FakePeer('stale')
    const joining = new FakePeer('joining')
    await room.admit(admission(stale))
    stale.messages.length = 0
    revoked.add(clientId)

    await expect(room.admit(admission(joining, 'J'.repeat(24), 'joining-request', 'client-new'))).resolves.toBe(true)

    expect(stale.messages.map(message => parseCollaborationServerMessage(message).type)).toEqual(['room.error'])
    expect(stale.closes).toContainEqual({ code: 4403, reason: 'File access changed' })
    const roster = parseCollaborationServerMessage(joining.messages.at(-1)!)
    expect(roster).toMatchObject({ type: 'presence.roster', participants: [{ subjectId: 'subject-new', clientId: 'client-new' }] })
    expect(room.activeConnections).toBe(1)
    await room.drain()
  })

  it('CLOUD-SYNC-DO-SEC-001 rechecks the joining capability after roster pruning and before snapshot delivery', async () => {
    const joiningClientId = 'client-new'
    let revokeJoiningDuringPrune = false
    let armed = false
    const currentChecks: string[] = []
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
        async claims => {
          if (!armed) return true
          currentChecks.push(claims.clientId)
          if (claims.clientId === clientId) {
            revokeJoiningDuringPrune = true
            return true
          }
          return !revokeJoiningDuringPrune
        },
      ),
      projector,
      checkpoints,
    })
    await room.start()
    const existing = new FakePeer('existing')
    await expect(room.admit(admission(existing))).resolves.toBe(true)
    armed = true
    const joining = new FakePeer('joining-gap')

    await expect(room.admit(admission(joining, 'J'.repeat(24), 'joining-gap-request', joiningClientId))).resolves.toBe(false)

    expect(currentChecks).toEqual([joiningClientId, clientId, joiningClientId])
    expect(joining.messages.map(message => parseCollaborationServerMessage(message).type)).toEqual(['room.assigned'])
    expect(joining.messages.some(message => {
      const type = parseCollaborationServerMessage(message).type
      return type === 'load.phase' || type === 'snapshot.begin' || type === 'snapshot.chunk' || type === 'snapshot.end' || type === 'sync.ready'
    })).toBe(false)
    expect(room.activeConnections).toBe(1)
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 refuses an oversized aggregate roster before partial admission', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000, maxMessageBytes: 2_048,
    }, { persistence: new FakePersistence(), tickets: tickets(), projector, checkpoints })
    await room.start()
    let admitted = 0
    let refused: FakePeer | null = null
    for (let index = 0; index < 32; index += 1) {
      const peer = new FakePeer(`capacity-${index}`)
      const nonce = String(index).padStart(24, '0')
      const accepted = await room.admit(admission(peer, nonce, `request-${index}`, `client-${index}`))
      if (!accepted) {
        refused = peer
        break
      }
      admitted += 1
    }

    expect(admitted).toBeGreaterThan(1)
    expect(refused).not.toBeNull()
    expect(refused!.messages).toHaveLength(0)
    expect(room.activeConnections).toBe(admitted)
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 does not let a 600-byte awareness update poison the next admission', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000, maxMessageBytes: 1_024,
    }, { persistence: new FakePersistence(), tickets: tickets(), projector, checkpoints })
    await room.start()
    const sender = new FakePeer('sender')
    await expect(room.admit(admission(sender))).resolves.toBe(true)
    sender.messages.length = 0
    const nodeIds = [
      `n00${'x'.repeat(125)}`,
      `n01${'x'.repeat(125)}`,
      `n02${'x'.repeat(125)}`,
      `n03${'x'.repeat(91)}`,
    ]
    const update = {
      type: 'presence.update' as const,
      sequence: 1,
      data: { pageId: 'page-1', selection: { pageId: 'page-1', nodeIds } },
    }
    const wire = encodeCollaborationMessage(update)
    expect(Buffer.byteLength(wire, 'utf8')).toBe(600)
    const legalUpdate = parseCollaborationClientMessage(wire, 1_024)

    await room.receive(sender.connectionId, legalUpdate)

    expect(parseCollaborationServerMessage(sender.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })
    const joining = new FakePeer('joining')
    await expect(room.admit(admission(joining, 'J'.repeat(24), 'joining-request', 'client-joining'))).resolves.toBe(true)
    expect(joining.messages.at(-1)).toBeDefined()
    expect(parseCollaborationServerMessage(joining.messages.at(-1)!, 1_024)).toMatchObject({
      type: 'presence.roster',
      participants: expect.arrayContaining([
        expect.objectContaining({ clientId }),
        expect.objectContaining({ clientId: 'client-joining' }),
      ]),
    })
    expect(room.activeConnections).toBe(2)

    const refused = new FakePeer('refused')
    await expect(room.admit(admission(refused, 'K'.repeat(24), 'refused-request', 'client-refused'))).resolves.toBe(false)
    expect(refused.messages).toHaveLength(0)
    expect(room.activeConnections).toBe(2)
    await room.drain()
  })

  it('CLOUD-SYNC-DO-SEC-001 fails closed on a duplicate room.open', async () => {
    const room = createRoom()
    await room.start()
    const peer = new FakePeer()
    await room.admit(admission(peer))
    peer.messages.length = 0

    await room.receive(peer.connectionId, open())

    expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation', retry: 'none' })
    expect(peer.closes).toContainEqual({ code: 4400, reason: 'Duplicate room open' })
    expect(room.activeConnections).toBe(0)
    await room.drain()
  })

  it('CLOUD-SYNC-DO-SEC-001 binds resume and leave to the admitted server session', async () => {
    const room = createRoom()
    await room.start()
    const rejected = new FakePeer('wrong-request')
    await room.admit(admission(rejected))
    rejected.messages.length = 0
    await room.receive(rejected.connectionId, { type: 'room.resume', requestId: 'wrong-request', afterSequence: '0', pendingMutationIds: [] })
    expect(parseCollaborationServerMessage(rejected.messages[0]!)).toMatchObject({ type: 'room.error', code: 'room_scope_mismatch', retry: 'none' })
    expect(rejected.closes).toContainEqual({ code: 4403, reason: 'Room scope mismatch' })

    const valid = new FakePeer('valid-resume')
    await room.admit(admission(valid, 'G'.repeat(24), 'request-valid', clientId))
    valid.messages.length = 0
    await room.receive(valid.connectionId, { type: 'room.resume', requestId: 'request-valid', afterSequence: '0', pendingMutationIds: [] })
    expect(valid.messages).toHaveLength(0)
    expect(valid.closes).toHaveLength(0)
    await room.receive(valid.connectionId, { type: 'room.leave' })
    expect(valid.closes).toContainEqual({ code: 1000, reason: 'Room left' })
    expect(room.activeConnections).toBe(0)
    await room.drain()
  })

  it('durably appends before acknowledging and suppresses duplicate rebroadcasts', async () => {
    const persistence = new FakePersistence()
    const pending = deferred<Awaited<ReturnType<FakePersistence['appendOperation']>>>()
    persistence.append = () => pending.promise
    const room = createRoom(persistence)
    await room.start()
    const sender = new FakePeer('connection-1')
    const recipient = new FakePeer('connection-2')
    await room.admit(admission(sender))
    await room.admit(admission(recipient, 'C'.repeat(24)))
    sender.messages.length = 0
    recipient.messages.length = 0
    const mutation = room.receive(sender.connectionId, submit())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(persistence.calls).toContain('append:mutation-1')
    expect(sender.messages).toHaveLength(0)
    expect(recipient.messages).toHaveLength(0)
    const next = { ...persistence.current, sequence: 1n, authority: 'room' as const }
    pending.resolve({ status: 'committed', projection: next, operation: { fileId, sequence: 1n, generationId, protocolEpoch: 2, fencingToken: lease.fencingToken, subjectId, clientId, clientMutationId: 'mutation-1', operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Renamed' }, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } })
    await mutation
    expect(parseCollaborationServerMessage(sender.messages[0]!).type).toBe('operation.ack')
    expect(parseCollaborationServerMessage(recipient.messages[0]!).type).toBe('operation.applied')
    await room.drain()
  })

  it('routes an exact stale retry through persistence and returns a duplicate ACK', async () => {
    const persistence = new FakePersistence()
    persistence.current = { ...persistence.current, sequence: 1n, authority: 'room' }
    persistence.append = async input => ({ status: 'replayed', operation: { fileId, sequence: 1n, generationId, protocolEpoch: 2, fencingToken: 1n, subjectId, clientId, clientMutationId: input.clientMutationId, operationType: input.operationType, operationPayload: input.operationPayload, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } })
    const room = createRoom(persistence)
    await room.start()
    const peer = new FakePeer()
    await room.admit(admission(peer))
    peer.messages.length = 0
    await room.receive(peer.connectionId, submit('mutation-retry', '0'))
    expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'operation.ack', status: 'duplicate', sequence: '1' })
    await room.drain()
  })

  it('drains once, rejects new admissions, waits for mutations, checkpoints, then releases', async () => {
    const persistence = new FakePersistence()
    const pending = deferred<Awaited<ReturnType<FakePersistence['appendOperation']>>>()
    persistence.append = () => pending.promise
    const room = createRoom(persistence)
    await room.start()
    const peer = new FakePeer()
    await room.admit(admission(peer))
    const mutation = room.receive(peer.connectionId, submit())
    const draining = room.drain()
    await expect(room.admit(admission(new FakePeer('late')))).rejects.toBeInstanceOf(RoomNotAcceptingError)
    expect(persistence.calls).not.toContain('checkpoint')
    const next = { ...persistence.current, sequence: 1n, authority: 'room' as const }
    pending.resolve({ status: 'committed', projection: next, operation: { fileId, sequence: 1n, generationId, protocolEpoch: 2, fencingToken: 1n, subjectId, clientId, clientMutationId: 'mutation-1', operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Renamed' }, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } })
    await mutation
    await expect(draining).resolves.toEqual({ status: 'stopped' })
    expect(persistence.calls.slice(-2)).toEqual(['checkpoint', 'release'])
  })

  it('keeps viewer operations read only without touching persistence', async () => {
    const persistence = new FakePersistence()
    const room = createRoom(persistence, 'viewer')
    await room.start()
    const peer = new FakePeer()
    await room.admit(admission(peer))
    peer.messages.length = 0
    await room.receive(peer.connectionId, submit())
    expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'read_only' })
    expect(persistence.calls.some(call => call.startsWith('append:'))).toBe(false)
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 sends an authoritative roster, join, monotonic updates, and leave without persistence', async () => {
    const persistence = new FakePersistence()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        return {
          subjectId: context.clientId === 'client-viewer' ? 'viewer-1' : subjectId,
          displayName: context.clientId === 'client-viewer' ? 'Viewer' : 'Alpha',
          avatarUrl: null,
          fileId,
          role: context.clientId === 'client-viewer' ? 'viewer' as const : 'owner' as const,
          generationId,
          protocolEpoch: 2 as const,
          expiresAtUnixMs: Date.now() + 60_000,
          accessEpoch: '1',
          clientId: context.clientId,
          connectionNonce: context.connectionNonce,
        }
      }, async (value, nowUnixMs) => value.expiresAtUnixMs > nowUnixMs),
      projector,
      checkpoints,
    })
    await room.start()
    const owner = new FakePeer('owner')
    const viewer = new FakePeer('viewer')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.admit(admission(viewer, 'V'.repeat(24), 'viewer-request', 'client-viewer'))

    expect(owner.messages.map(message => parseCollaborationServerMessage(message))).toEqual([
      expect.objectContaining({ type: 'presence.join', participant: expect.objectContaining({ subjectId: 'viewer-1', clientId: 'client-viewer', role: 'viewer', sequence: null }) }),
    ])
    const viewerRoster = parseCollaborationServerMessage(viewer.messages.at(-1)!)
    expect(viewerRoster).toMatchObject({
      type: 'presence.roster',
      participants: [
        { subjectId, clientId, role: 'owner', sequence: null },
        { subjectId: 'viewer-1', clientId: 'client-viewer', role: 'viewer', sequence: null },
      ],
    })

    owner.messages.length = 0
    viewer.messages.length = 0
    const callsBeforePresence = [...persistence.calls]
    await room.receive(owner.connectionId, {
      type: 'presence.update',
      sequence: 1,
      data: {
        pageId: 'page-1',
        focused: true,
        selection: { pageId: 'page-1', nodeIds: ['node-1'] },
        camera: { pageId: 'page-1', x: 10, y: 20, zoom: 2 },
        cursor: { pageId: 'page-1', x: 30, y: 40 },
      },
    })
    expect(viewer.messages.map(message => parseCollaborationServerMessage(message))).toEqual([
      expect.objectContaining({
        type: 'presence.changed',
        participant: expect.objectContaining({ clientId, sequence: 1, data: expect.objectContaining({ pageId: 'page-1', focused: true }) }),
      }),
    ])
    expect(owner.messages).toHaveLength(0)
    expect(persistence.calls).toEqual(callsBeforePresence)

    viewer.messages.length = 0
    await room.receive(owner.connectionId, { type: 'presence.update', sequence: 1, data: { focused: false } })
    expect(viewer.messages).toHaveLength(0)

    await room.receive(viewer.connectionId, {
      type: 'presence.update', sequence: 1,
      data: { pageId: 'page-1', focused: true },
    })
    expect(parseCollaborationServerMessage(viewer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'read_only' })
    expect(owner.messages).toHaveLength(0)
    expect(persistence.calls).toEqual(callsBeforePresence)

    viewer.messages.length = 0
    room.disconnect(owner.connectionId)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(viewer.messages.map(message => parseCollaborationServerMessage(message))).toEqual([
      expect.objectContaining({ type: 'presence.leave', subjectId, clientId }),
    ])
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 rejects cross-page awareness without changing another participant', async () => {
    const persistence = new FakePersistence()
    const room = createRoom(persistence)
    await room.start()
    const sender = new FakePeer('sender')
    const observer = new FakePeer('observer')
    await room.admit(admission(sender))
    await room.admit(admission(observer, 'O'.repeat(24)))
    sender.messages.length = 0
    observer.messages.length = 0
    const callsBeforePresence = [...persistence.calls]

    await room.receive(sender.connectionId, {
      type: 'presence.update', sequence: 1,
      data: { pageId: 'page-1', cursor: { pageId: 'page-1', x: 1, y: 2 } },
    })
    observer.messages.length = 0
    await room.receive(sender.connectionId, {
      type: 'presence.update', sequence: 2,
      data: { cursor: { pageId: 'page-2', x: 3, y: 4 } },
    })
    expect(parseCollaborationServerMessage(sender.messages.at(-1)!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })
    expect(observer.messages).toHaveLength(0)
    expect(persistence.calls).toEqual(callsBeforePresence)

    await room.drain()
  })

  it('CLOUD-SYNC-DO-SEC-001 rejects client-supplied room and participant scope before room dispatch', async () => {
    const persistence = new FakePersistence()
    const room = createRoom(persistence)
    await room.start()
    const sender = new FakePeer('sender')
    const observer = new FakePeer('observer')
    await room.admit(admission(sender))
    await room.admit(admission(observer, 'G'.repeat(24)))
    sender.messages.length = 0
    observer.messages.length = 0
    const callsBeforePresence = [...persistence.calls]

    const forged = {
      type: 'presence.update',
      envelope: { protocolEpoch: 2, schemaVersion: 1, room: { fileId, generationId: '11111111-1111-4111-8111-111111111111' }, roomTicket: ticket },
      clientId: 'forged-client',
      sequence: 1,
      data: { pageId: 'page-1', cursor: { pageId: 'page-1', x: 1, y: 2 } },
    }
    expect(() => parseCollaborationClientMessage(JSON.stringify(forged))).toThrow('Invalid presence update')

    expect(sender.messages).toHaveLength(0)
    expect(observer.messages).toHaveLength(0)
    expect(persistence.calls).toEqual(callsBeforePresence)
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 discards a stale awareness sequence without an authority round trip', async () => {
    const persistence = new FakePersistence()
    let senderRevoked = false
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        return {
          subjectId: context.clientId === clientId ? subjectId : 'observer-1',
          displayName: context.clientId === clientId ? 'Alpha' : 'Observer',
          avatarUrl: null,
          fileId,
          role: 'owner' as const,
          generationId,
          protocolEpoch: 2 as const,
          expiresAtUnixMs: Date.now() + 60_000,
          accessEpoch: '1',
          clientId: context.clientId,
          connectionNonce: context.connectionNonce,
        }
      }, async value => !(senderRevoked && value.clientId === clientId)),
      projector,
      checkpoints,
    })
    await room.start()
    const sender = new FakePeer('sender')
    const observer = new FakePeer('observer')
    await room.admit(admission(sender))
    await room.admit(admission(observer, 'R'.repeat(24), 'observer-request', 'client-observer'))
    sender.messages.length = 0
    observer.messages.length = 0
    await room.receive(sender.connectionId, {
      type: 'presence.update', sequence: 2,
      data: { pageId: 'page-1', cursor: { pageId: 'page-1', x: 1, y: 2 } },
    })
    const changed = parseCollaborationServerMessage(observer.messages[0]!)
    expect(changed).toMatchObject({ type: 'presence.changed', participant: { clientId, sequence: 2 } })
    const presenceId = changed.type === 'presence.changed' ? changed.participant.presenceId : ''
    observer.messages.length = 0
    const callsBeforePresence = [...persistence.calls]
    senderRevoked = true

    await room.receive(sender.connectionId, {
      type: 'presence.update', sequence: 1,
      data: { focused: false },
    })
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(sender.messages).toHaveLength(0)
    expect(sender.closes).toHaveLength(0)
    expect(observer.messages.every(message => parseCollaborationServerMessage(message).type !== 'presence.changed')).toBe(true)
    expect(observer.messages.map(message => parseCollaborationServerMessage(message))).not.toContainEqual(expect.objectContaining({ type: 'presence.leave', presenceId, clientId }))
    expect(persistence.calls).toEqual(callsBeforePresence)
    await room.drain()
  })

  it('CLOUD-SYNC-PRESENCE-001 orders an old leave before a quick reconnect and distinguishes both sessions', async () => {
    const leaveStarted = deferred<void>()
    const releaseLeave = deferred<void>()
    class DelayedLeavePeer extends FakePeer {
      delayLeaves = false
      override async send(message: string) {
        if (this.delayLeaves && message.includes('"type":"presence.leave"')) {
          leaveStarted.resolve()
          await releaseLeave.promise
        }
        super.send(message)
      }
    }
    const room = createRoom()
    await room.start()
    const observer = new DelayedLeavePeer('observer')
    const oldPeer = new FakePeer('old-session')
    await room.admit(admission(observer))
    await room.admit(admission(oldPeer, 'O'.repeat(24), 'old-request', 'client-reconnect'))
    const oldJoin = observer.messages.map(message => parseCollaborationServerMessage(message)).find(message => message.type === 'presence.join')
    expect(oldJoin).toMatchObject({ type: 'presence.join', participant: { clientId: 'client-reconnect' } })
    const oldPresenceId = oldJoin?.type === 'presence.join' ? oldJoin.participant.presenceId : ''
    observer.messages.length = 0
    observer.delayLeaves = true

    room.disconnect(oldPeer.connectionId)
    await leaveStarted.promise
    const newPeer = new FakePeer('new-session')
    const reconnecting = room.admit(admission(newPeer, 'N'.repeat(24), 'new-request', 'client-reconnect'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(newPeer.messages).toHaveLength(0)
    releaseLeave.resolve()
    await expect(reconnecting).resolves.toBe(true)

    const events = observer.messages.map(message => parseCollaborationServerMessage(message)).filter(message => message.type === 'presence.leave' || message.type === 'presence.join')
    expect(events.map(message => message.type)).toEqual(['presence.leave', 'presence.join'])
    const leave = events[0]
    const join = events[1]
    expect(leave).toMatchObject({ type: 'presence.leave', presenceId: oldPresenceId, clientId: 'client-reconnect' })
    expect(join).toMatchObject({ type: 'presence.join', participant: { clientId: 'client-reconnect' } })
    if (join?.type !== 'presence.join') throw new Error('Expected reconnect join')
    expect(join.participant.presenceId).not.toBe(oldPresenceId)
    const roster = parseCollaborationServerMessage(newPeer.messages.at(-1)!)
    expect(roster).toMatchObject({ type: 'presence.roster', participants: expect.arrayContaining([expect.objectContaining({ presenceId: join.participant.presenceId, clientId: 'client-reconnect' })]) })
    await room.drain()
  })

  it('rechecks access before every operation and closes a revoked writer', async () => {
    const persistence = new FakePersistence()
    let revoked = false
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(
        async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
        async () => !revoked,
      ),
      projector,
      checkpoints,
    })
    await room.start()
    const peer = new FakePeer()
    await room.admit(admission(peer))
    peer.messages.length = 0
    revoked = true
    await room.receive(peer.connectionId, submit())
    expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'access_revoked' })
    expect(peer.closes).toContainEqual({ code: 4403, reason: 'File access changed' })
    expect(persistence.calls.some(call => call.startsWith('append:'))).toBe(false)
    await room.drain()
  })

  it('AT-AUTH-003 closes an idle revoked viewer during lease renewal', async () => {
    let revoked = false
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 100, leaseRenewalMs: 20, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => ({ subjectId: 'viewer-1', displayName: 'Viewer', avatarUrl: null, fileId, role: 'viewer', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
        async () => !revoked,
      ),
      projector,
      checkpoints,
    })
    await room.start()
    const peer = new FakePeer('idle-viewer')
    await room.admit(admission(peer))
    peer.messages.length = 0
    revoked = true

    await waitUntil(() => peer.closes.length > 0)

    expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'access_revoked' })
    expect(peer.closes).toContainEqual({ code: 4403, reason: 'File access changed' })
    expect(room.activeConnections).toBe(0)
    await room.drain()
  })

  it('CLOUD-SYNC-AUTH-001 handles revocation after the room check but before append', async () => {
    const persistence = new FakePersistence()
    let changeOwner = false
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        const verified = { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner' as const, generationId, protocolEpoch: 2 as const, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
        return verified
      }, async () => { if (changeOwner) { persistence.ownerSubjectId = 'replacement-owner'; changeOwner = false }; return true }),
      projector,
      checkpoints,
    })
    await room.start()
    const peer = new FakePeer()
    await room.admit(admission(peer))
    peer.messages.length = 0
    changeOwner = true

    await room.receive(peer.connectionId, submit())

    expect(persistence.calls).toContain('append:mutation-1')
    expect(persistence.current.sequence).toBe(0n)
    expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'access_revoked' })
    expect(peer.closes).toContainEqual({ code: 4403, reason: 'File access changed' })
    await room.drain()
  })

  it('CLOUD-SYNC-AUTH-001 handles an epoch change after the room check but before append', async () => {
    const persistence = new FakePersistence()
    let changeEpoch = false
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        const verified = { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner' as const, generationId, protocolEpoch: 2 as const, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
        return verified
      }, async () => { if (changeEpoch) { persistence.accessEpoch = 2n; changeEpoch = false }; return true }),
      projector,
      checkpoints,
    })
    await room.start()
    const peer = new FakePeer()
    await room.admit(admission(peer))
    peer.messages.length = 0
    changeEpoch = true

    await room.receive(peer.connectionId, submit())

    expect(persistence.calls).toContain('append:mutation-1')
    expect(persistence.current.sequence).toBe(0n)
    expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'access_revoked' })
    expect(peer.closes).toContainEqual({ code: 4403, reason: 'File access changed' })
    await room.drain()
  })

  it('releases its lease when checkpoint publication fails', async () => {
    const persistence = new FakePersistence()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector, checkpoints: { async write() { throw new Error('storage unavailable') } } })
    await room.start()
    await expect(room.drain()).resolves.toEqual({ status: 'checkpoint-failed' })
    expect(persistence.calls.at(-1)).toBe('release')
    expect(room.phase).toBe('failed')
  })

  it('rechecks recipients and withholds committed operations after viewer revocation', async () => {
    const persistence = new FakePersistence()
    const recipientNonce = 'C'.repeat(24)
    let recipientRevoked = false
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 2 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        if (context.connectionNonce === recipientNonce) {
          return { subjectId: 'viewer-1', displayName: 'Viewer', avatarUrl: null, fileId, role: 'viewer', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
        }
        return { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 2, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
      }, async value => !(recipientRevoked && value.connectionNonce === recipientNonce)),
      projector,
      checkpoints,
    })
    await room.start()
    const sender = new FakePeer('sender')
    const recipient = new FakePeer('recipient')
    await room.admit(admission(sender))
    await room.admit(admission(recipient, recipientNonce))
    sender.messages.length = 0
    recipient.messages.length = 0
    recipientRevoked = true
    await room.receive(sender.connectionId, submit())
    expect(parseCollaborationServerMessage(sender.messages[0]!)).toMatchObject({ type: 'operation.ack', status: 'applied' })
    expect(recipient.messages.map(message => parseCollaborationServerMessage(message).type)).toEqual(['room.error'])
    expect(recipient.closes).toContainEqual({ code: 4403, reason: 'File access changed' })
    await room.drain()
  })

  it('releases an acquired lease when projection bootstrap fails', async () => {
    const persistence = new FakePersistence()
    persistence.bootstrapProjectionFromLegacy = async () => ({ status: 'source-not-found' })
    const room = createRoom(persistence)
    await expect(room.start()).rejects.toThrow('source-not-found')
    expect(persistence.calls).toContain('release')
    expect(room.phase).toBe('failed')
  })

  it('serializes snapshot hydration before a concurrent live mutation', async () => {
    const persistence = new FakePersistence()
    const room = createRoom(persistence)
    await room.start()
    const sender = new FakePeer('sender')
    await room.admit(admission(sender))
    sender.messages.length = 0
    const blocked = deferred<void>()
    let held = false
    class BlockingPeer extends FakePeer {
      override send(message: string) {
        super.send(message)
        if (!held && message.includes('"type":"snapshot.chunk"')) { held = true; return blocked.promise }
      }
    }
    const joining = new BlockingPeer('joining')
    const joined = room.admit(admission(joining, 'D'.repeat(24)))
    while (!held) await new Promise<void>(resolve => setImmediate(resolve))
    const mutation = room.receive(sender.connectionId, submit())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(persistence.calls.some(call => call.startsWith('append:'))).toBe(false)
    blocked.resolve()
    await joined
    await mutation
    const messages = joining.messages.map(message => parseCollaborationServerMessage(message))
    expect(messages.map(message => message.type)).toEqual(['room.assigned', 'load.phase', 'snapshot.begin', 'snapshot.chunk', 'snapshot.end', 'load.phase', 'sync.ready', 'presence.roster', 'operation.applied'])
    expect(messages.find(message => message.type === 'sync.ready')).toMatchObject({ serverSequence: '0' })
    expect(messages.at(-1)).toMatchObject({ type: 'operation.applied', sequence: '1' })
    await room.drain()
  })

  it('continues broadcasting when the sender ACK or another recipient send fails', async () => {
    const persistence = new FakePersistence()
    const room = createRoom(persistence)
    await room.start()
    class FailingPeer extends FakePeer {
      failing = false
      override send(message: string) { if (this.failing) throw new Error('socket closed'); super.send(message) }
    }
    const sender = new FailingPeer('sender')
    const failingRecipient = new FailingPeer('failing-recipient')
    const healthyRecipient = new FakePeer('healthy-recipient')
    await room.admit(admission(sender))
    await room.admit(admission(failingRecipient, 'E'.repeat(24)))
    await room.admit(admission(healthyRecipient, 'F'.repeat(24)))
    sender.messages.length = 0
    failingRecipient.messages.length = 0
    healthyRecipient.messages.length = 0
    sender.failing = true
    failingRecipient.failing = true
    await room.receive(sender.connectionId, submit())
    expect(sender.closes).toContainEqual({ code: 1011, reason: 'Acknowledgement failed' })
    expect(failingRecipient.closes).toContainEqual({ code: 1011, reason: 'Operation delivery failed' })
    expect(healthyRecipient.messages.map(message => parseCollaborationServerMessage(message)).find(message => message.type === 'operation.applied')).toMatchObject({ type: 'operation.applied', sequence: '1' })
    await room.drain()
  })
})
