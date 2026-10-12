import { encodeCollaborationMessage, parseCollaborationClientMessage, parseCollaborationServerMessage } from '@canvas/sync-protocol'
import type { SemanticFileCommand, VerifiedRoomTicketClaims } from '@canvas/sync-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { RoomTicketContext, RoomTicketVerifier } from '../src/contracts.js'
import { createFlowTopologyAuthority, flowLaneSnapshot, flowPresentationDigest, sameFlowLane } from '../src/flow-authority.js'
import { assertCanonicalPeerFlowPresentation, canonicalPeerFlowPresentation, peerFlowInteractionId } from '../src/flow-reservations.js'
import { createSemanticProjector } from '../src/projector.js'
import { CollaborationRoomCore, RoomNotAcceptingError } from '../src/room-core.js'
import { checkpoints, clientId, connectionNonce, deferred, document, FakePeer, FakePersistence, fileId, flowDocument, flowPresentation, generationId, lease, projection, projector, subjectId, ticket, tickets } from './support.js'

const createRoom = (persistence = new FakePersistence(), role: 'owner' | 'viewer' = 'owner') => new CollaborationRoomCore({
  identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
}, { persistence, tickets: tickets(role), projector, checkpoints })

const createFlowRoom = (persistence = new FakePersistence(), role: 'owner' | 'viewer' = 'owner') => {
  persistence.current = projection(flowDocument())
  return new CollaborationRoomCore({
    identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
  }, { persistence, tickets: tickets(role), projector: createSemanticProjector(), checkpoints })
}

const createFlowRoomWith = (persistence: FakePersistence, value: ReturnType<typeof flowDocument>, verifier: RoomTicketVerifier = tickets()) => {
  persistence.current = projection(value)
  return new CollaborationRoomCore({
    identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
  }, { persistence, tickets: verifier, projector: createSemanticProjector(), checkpoints })
}

const open = (requestId = 'request-1', openFileId = fileId, openClientId = clientId) => ({
  type: 'room.open' as const,
  protocolEpoch: 4 as const,
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
    expect(messages[0]).toMatchObject({ type: 'room.assigned', replayScopeId: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(peer.messages[0]).not.toMatch(/accessEpoch|ticket|capability/i)
    expect(messages.map(message => 'requestId' in message ? message.requestId : null)).toEqual([...Array(7).fill('request-from-client'), null])
    expect(room.activeConnections).toBe(1)
    await expect(room.drain()).resolves.toEqual({ status: 'stopped' })
  })

  it('CLOUD-SYNC-REPLAY-001 binds the replay scope to the verified access grant', async () => {
    const assignedScope = async (input: Readonly<{ subject: string; role: 'owner' | 'viewer'; accessEpoch: string }>) => {
      const room = new CollaborationRoomCore({
        identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
      }, {
        persistence: new FakePersistence(),
        tickets: customTickets(
          async context => ({ subjectId: input.subject, displayName: 'Alpha', avatarUrl: null, fileId, role: input.role, generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: input.accessEpoch, clientId: context.clientId, connectionNonce: context.connectionNonce }),
          async () => true,
        ),
        projector,
        checkpoints,
      })
      await room.start()
      const peer = new FakePeer(`scope-${input.subject}-${input.role}-${input.accessEpoch}`)
      await expect(room.admit(admission(peer))).resolves.toBe(true)
      const assigned = parseCollaborationServerMessage(peer.messages[0]!)
      expect(assigned.type).toBe('room.assigned')
      await room.drain()
      return assigned.type === 'room.assigned' ? assigned.replayScopeId : ''
    }

    const original = await assignedScope({ subject: subjectId, role: 'owner', accessEpoch: '1' })
    expect(await assignedScope({ subject: subjectId, role: 'owner', accessEpoch: '1' })).toBe(original)
    expect(await assignedScope({ subject: subjectId, role: 'owner', accessEpoch: '2' })).not.toBe(original)
    expect(await assignedScope({ subject: subjectId, role: 'viewer', accessEpoch: '1' })).not.toBe(original)
    expect(await assignedScope({ subject: 'subject-2', role: 'owner', accessEpoch: '1' })).not.toBe(original)
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => { verificationCount += 1; return { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce } },
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
      async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
      async () => false,
    )
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
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

  it.fails('legacy presence lock is replaced by epoch-4 flow leases', async () => {
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

    await room.receive(first.connectionId, { type: 'presence.update', sequence: 3, data: { interaction: null } as never })
    expect(first.messages).toHaveLength(firstMessageCount + 1)
    await room.receive(second.connectionId, interaction(2, 'gesture-second', ['node-1'], [{ nodeId: 'node-1', dx: 3, dy: 4 }]))
    expect(first.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-second' }) }) }),
    }))
    await room.drain()
  })

  it.fails('legacy presence lock mutation is replaced by epoch-4 flow leases', async () => {
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
    await room.receive(second.connectionId, { type: 'presence.update', sequence: 2, data: { interaction: null } as never })
    await room.receive(second.connectionId, interaction(3, 'gesture-second-next', ['node-1']))
    expect(second.messages.map(message => parseCollaborationServerMessage(message))).toContainEqual(expect.objectContaining({
      type: 'presence.changed', participant: expect.objectContaining({ data: expect.objectContaining({ interaction: expect.objectContaining({ interactionId: 'gesture-second-next' }) }) }),
    }))
    expect(room.activeConnections).toBe(1)
    await room.drain()
  })

  it.fails('legacy presence command exclusion is replaced by epoch-4 structural reservations', async () => {
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

  it.fails('legacy descendant locks are replaced by epoch-4 structural reservations', async () => {
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

  it.fails('legacy node locks are replaced by epoch-4 topology validation', async () => {
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

  it.fails('legacy pending mutation locks are replaced by epoch-4 pending reservations', async () => {
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(async context => {
        if (revoked.has(context.clientId)) return null
        return { subjectId: context.clientId === clientId ? subjectId : 'subject-new', displayName: context.clientId === clientId ? 'Alpha' : 'New participant', avatarUrl: null, fileId, role: 'owner' as const, generationId, protocolEpoch: 4 as const, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000, maxMessageBytes: 2_048,
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000, maxMessageBytes: 1_024,
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
    pending.resolve({ status: 'committed', projection: next, operation: { fileId, sequence: 1n, generationId, protocolEpoch: 4, fencingToken: lease.fencingToken, subjectId, clientId, clientMutationId: 'mutation-1', operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Renamed' }, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } })
    await mutation
    expect(parseCollaborationServerMessage(sender.messages[0]!).type).toBe('operation.ack')
    expect(parseCollaborationServerMessage(recipient.messages[0]!).type).toBe('operation.applied')
    await room.drain()
  })

  it('routes an exact stale retry through persistence and returns a duplicate ACK', async () => {
    const persistence = new FakePersistence()
    persistence.current = { ...persistence.current, sequence: 1n, authority: 'room' }
    persistence.append = async input => ({ status: 'replayed', operation: { fileId, sequence: 1n, generationId, protocolEpoch: 4, fencingToken: 1n, subjectId, clientId, clientMutationId: input.clientMutationId, operationType: input.operationType, operationPayload: input.operationPayload, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } })
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
    pending.resolve({ status: 'committed', projection: next, operation: { fileId, sequence: 1n, generationId, protocolEpoch: 4, fencingToken: 1n, subjectId, clientId, clientMutationId: 'mutation-1', operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Renamed' }, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } })
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
          protocolEpoch: 4 as const,
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
      envelope: { protocolEpoch: 4, schemaVersion: 1, room: { fileId, generationId: '11111111-1111-4111-8111-111111111111' }, roomTicket: ticket },
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
          protocolEpoch: 4 as const,
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(
        async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
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

  it('AT-AUTH-003 reconnects an authorized owner when the transport ticket expires', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const persistence = new FakePersistence()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(
        async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: 1_100, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
        async () => true,
      ),
      projector,
      checkpoints,
    })
    try {
      await room.start()
      const peer = new FakePeer('expiring-owner')
      await room.admit(admission(peer))
      peer.messages.length = 0
      now = 1_100

      await room.receive(peer.connectionId, submit())

      expect(parseCollaborationServerMessage(peer.messages[0]!)).toMatchObject({ type: 'room.error', code: 'draining', retry: 'reconnect', message: 'Session refresh required.' })
      expect(peer.closes).toContainEqual({ code: 1012, reason: 'Session refresh required' })
      expect(persistence.calls.some(call => call.startsWith('append:'))).toBe(false)
      expect(room.activeConnections).toBe(0)
      await room.drain()
    } finally {
      dateNow.mockRestore()
    }
  })

  it('AT-AUTH-003 closes an idle revoked viewer during lease renewal', async () => {
    let revoked = false
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 100, leaseRenewalMs: 20, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: customTickets(
        async context => ({ subjectId: 'viewer-1', displayName: 'Viewer', avatarUrl: null, fileId, role: 'viewer', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        const verified = { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner' as const, generationId, protocolEpoch: 4 as const, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        const verified = { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner' as const, generationId, protocolEpoch: 4 as const, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
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
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence,
      tickets: customTickets(async context => {
        if (context.connectionNonce === recipientNonce) {
          return { subjectId: 'viewer-1', displayName: 'Viewer', avatarUrl: null, fileId, role: 'viewer', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
        }
        return { subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }
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

  it('CLOUD-SYNC-GESTURE-001-C2 and CLOUD-SYNC-LEASE-001-C2 issue one authoritative lease, deny overlap, and deliver samples only to peers', async () => {
    const room = createFlowRoom()
    await room.start()
    const owner = new FakePeer('flow-owner')
    const contender = new FakePeer('flow-contender')
    await room.admit(admission(owner))
    await room.admit(admission(contender, 'Y'.repeat(24), 'flow-contender-request', 'flow-contender-client'))
    owner.messages.length = 0
    contender.messages.length = 0

    const first = flowPresentation()
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: first })
    const granted = JSON.parse(owner.messages[0]!)
    expect(granted).toMatchObject({ type: 'interaction.result', action: 'acquire', status: 'granted', localClaimGeneration: 1, reservationGeneration: 1, sampleSequence: 1, denialCode: null })
    expect(granted.leaseId).toMatch(/^[0-9a-f-]{36}$/)
    expect(contender.messages.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'interaction.sample', leaseId: granted.leaseId, presentation: expect.objectContaining({ identity: { interactionId: peerFlowInteractionId(granted.leaseId), gestureGeneration: 1, sampleSequence: 1 } }) }))

    const ownerCount = owner.messages.length
    const peerCount = contender.messages.length
    const sample = flowPresentation({ sequence: 2 })
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: sample })
    expect(owner.messages).toHaveLength(ownerCount)
    expect(contender.messages).toHaveLength(peerCount + 1)
    expect(JSON.parse(contender.messages.at(-1)!)).toMatchObject({ type: 'interaction.sample', presentation: { identity: { sampleSequence: 2 } } })

    await room.receive(contender.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'competing-flow' }) })
    expect(JSON.parse(contender.messages.at(-1)!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'overlap', leaseId: null })

    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: sample })
    expect(JSON.parse(owner.messages.at(-1)!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'stale_sequence' })
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001-C2 gives colliding local interactions independent peer render identities and tombstones', async () => {
    const persistence = new FakePersistence()
    const value = flowDocument() as unknown as { nodes: Record<string, unknown>; relationships: Record<string, unknown> }
    value.nodes['second-target-frame'] = {
      id: 'second-target-frame', type: 'frame', name: 'Second target', styles: { left: 1040, top: 0, width: 200, height: 200 },
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    }
    value.relationships['second-target-frame'] = { parentId: 'root-1', orderKey: 'Y' }
    const room = createFlowRoomWith(persistence, value as never)
    await room.start()
    const firstOwner = new FakePeer('collision-owner-one')
    const secondOwner = new FakePeer('collision-owner-two')
    const observer = new FakePeer('collision-observer')
    await room.admit(admission(firstOwner))
    await room.admit(admission(secondOwner, 'J'.repeat(24), 'collision-owner-two-request', 'collision-owner-two-client'))
    await room.admit(admission(observer, 'L'.repeat(24), 'collision-observer-request', 'collision-observer-client'))
    firstOwner.messages.length = 0
    secondOwner.messages.length = 0
    observer.messages.length = 0

    const firstPresentation = flowPresentation({ interactionId: 'shared-local-interaction', supportClone: true })
    const secondPresentation = flowPresentation({
      interactionId: 'shared-local-interaction', sourceNodeId: 'disjoint-node', sourceParentId: 'disjoint-frame',
      targetParentId: 'second-target-frame',
    })
    const firstInput = structuredClone(firstPresentation)
    const secondInput = structuredClone(secondPresentation)
    const firstDigest = flowPresentationDigest(firstPresentation)
    const secondDigest = flowPresentationDigest(secondPresentation)

    await room.receive(firstOwner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: firstPresentation })
    await room.receive(secondOwner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: secondPresentation })
    const firstGrant = firstOwner.messages.map(message => JSON.parse(message)).find(message => message.type === 'interaction.result')
    const secondGrant = secondOwner.messages.map(message => JSON.parse(message)).find(message => message.type === 'interaction.result')
    expect(firstGrant).toMatchObject({ type: 'interaction.result', status: 'granted', interactionId: 'shared-local-interaction' })
    expect(secondGrant).toMatchObject({ type: 'interaction.result', status: 'granted', interactionId: 'shared-local-interaction' })
    if (!firstGrant?.leaseId || !secondGrant?.leaseId) throw new Error('Expected both flow leases')
    expect(secondGrant.leaseId).not.toBe(firstGrant.leaseId)

    const flowAuthority = createFlowTopologyAuthority(value as never, 'page-1')
    if (!flowAuthority) throw new Error('Expected flow topology authority')
    const peerSamples = observer.messages
      .filter(message => JSON.parse(message).type === 'interaction.sample')
      .map(message => parseCollaborationServerMessage(message, undefined, flowAuthority))
      .filter(message => message.type === 'interaction.sample')
    expect(peerSamples).toHaveLength(2)
    expect(peerSamples.map(message => [message.leaseId, message.presentation.identity.interactionId])).toEqual([
      [firstGrant.leaseId, peerFlowInteractionId(firstGrant.leaseId)],
      [secondGrant.leaseId, peerFlowInteractionId(secondGrant.leaseId)],
    ])
    expect(peerSamples[0]!.presentation.supportClone?.key.interactionId).toBe(peerFlowInteractionId(firstGrant.leaseId))
    expect(firstPresentation).toEqual(firstInput)
    expect(secondPresentation).toEqual(secondInput)
    expect(flowPresentationDigest(firstPresentation)).toBe(firstDigest)
    expect(flowPresentationDigest(secondPresentation)).toBe(secondDigest)

    const lateObserver = new FakePeer('collision-late-observer')
    await room.admit(admission(lateObserver, 'M'.repeat(24), 'collision-late-observer-request', 'collision-late-observer-client'))
    const rosterWire = lateObserver.messages.find(message => JSON.parse(message).type === 'interaction.roster')
    const roster = rosterWire ? parseCollaborationServerMessage(rosterWire, undefined, flowAuthority) : null
    expect(roster?.type).toBe('interaction.roster')
    if (!roster) throw new Error('Expected flow roster')
    if (roster.type !== 'interaction.roster') throw new Error('Expected parsed flow roster')
    expect(roster.interactions.map(entry => [entry.leaseId, entry.presentation.identity.interactionId])).toEqual([
      [firstGrant.leaseId, peerFlowInteractionId(firstGrant.leaseId)],
      [secondGrant.leaseId, peerFlowInteractionId(secondGrant.leaseId)],
    ])
    expect(roster.interactions[0]!.presentation.supportClone?.key.interactionId).toBe(peerFlowInteractionId(firstGrant.leaseId))

    observer.messages.length = 0
    await room.receive(firstOwner.connectionId, {
      type: 'interaction.release', pageId: 'page-1', leaseId: firstGrant.leaseId, interactionId: 'shared-local-interaction',
      localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled',
    })
    await room.receive(secondOwner.connectionId, {
      type: 'interaction.release', pageId: 'page-1', leaseId: secondGrant.leaseId, interactionId: 'shared-local-interaction',
      localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled',
    })
    const releases = observer.messages.map(message => JSON.parse(message)).filter(message => message.type === 'interaction.released')
    expect(releases.map(message => [message.leaseId, message.interactionId])).toEqual([
      [firstGrant.leaseId, peerFlowInteractionId(firstGrant.leaseId)],
      [secondGrant.leaseId, peerFlowInteractionId(secondGrant.leaseId)],
    ])
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 rejects reserved peer identities and detects incomplete nested canonicalization', async () => {
    const room = createFlowRoom()
    await room.start()
    const owner = new FakePeer('reserved-peer-identity-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    const forged = flowPresentation({ interactionId: 'lease:11111111-1111-4111-8111-111111111111', supportClone: true })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: forged })
    expect(parseCollaborationServerMessage(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'invalid_topology', leaseId: null })

    owner.messages.length = 0
    const nestedForged = structuredClone(flowPresentation({ interactionId: 'local-with-forged-nested-id', supportClone: true }))
    ;(nestedForged.supportClone!.key as { interactionId: string }).interactionId = 'lease:33333333-3333-4333-8333-333333333333'
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: nestedForged })
    expect(parseCollaborationServerMessage(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'invalid_topology', leaseId: null })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 3, presentation: flowPresentation({ interactionId: 'valid-after-reserved-denial' }) })
    expect(parseCollaborationServerMessage(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'granted', denialCode: null })

    const incomplete = structuredClone(flowPresentation({ interactionId: 'local-id', supportClone: true }))
    const leaseId = '22222222-2222-4222-8222-222222222222'
    ;(incomplete.identity as { interactionId: string }).interactionId = peerFlowInteractionId(leaseId)
    expect(() => assertCanonicalPeerFlowPresentation(incomplete, leaseId)).toThrow('non-canonical interaction identity')
    const canonical = canonicalPeerFlowPresentation(flowPresentation({ interactionId: 'local-id', supportClone: true }), leaseId)
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(Object.isFrozen(canonical.supportClone?.key)).toBe(true)
    expect(canonical.identity.interactionId).toBe(peerFlowInteractionId(leaseId))
    expect(canonical.supportClone?.key.interactionId).toBe(peerFlowInteractionId(leaseId))
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 retains only an exact acquire retry and returns the authoritative sequence without a duplicate peer sample', async () => {
    const room = createFlowRoom()
    await room.start()
    const owner = new FakePeer('retry-owner')
    const peer = new FakePeer('retry-peer')
    await room.admit(admission(owner))
    await room.admit(admission(peer, 'R'.repeat(24), 'retry-peer-request', 'retry-peer-client'))
    owner.messages.length = 0
    peer.messages.length = 0
    const original = flowPresentation()
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: original })
    const granted = JSON.parse(owner.messages[0]!)
    const peerSamples = peer.messages.map(message => JSON.parse(message)).filter(message => message.type === 'interaction.sample').length

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, presentation: original })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'retained', denialCode: null, sampleSequence: 1 })
    expect(peer.messages.map(message => JSON.parse(message)).filter(message => message.type === 'interaction.sample')).toHaveLength(peerSamples)

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, presentation: flowPresentation({ sequence: 2 }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'invalid_topology', sampleSequence: 1 })
    expect(peer.messages.map(message => JSON.parse(message)).filter(message => message.type === 'interaction.sample')).toHaveLength(peerSamples)
    await room.drain()
  })

  it('CLOUD-SYNC-READONLY-001-C2 denies viewer acquisition without allocating a lease', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoomWith(persistence, flowDocument(), customTickets(
      async context => ({
        subjectId, displayName: 'Alpha', avatarUrl: null, fileId,
        role: context.clientId === clientId ? 'viewer' : 'owner',
        generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000,
        accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce,
      }),
      async () => true,
    ))
    await room.start()
    const viewer = new FakePeer('flow-viewer')
    const owner = new FakePeer('flow-owner-after-viewer')
    await room.admit(admission(viewer))
    await room.admit(admission(owner, 'O'.repeat(24), 'flow-owner-request', 'flow-owner-client'))
    viewer.messages.length = 0
    owner.messages.length = 0
    await room.receive(viewer.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    expect(JSON.parse(viewer.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'read_only', leaseId: null })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'owner-after-viewer' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'granted', denialCode: null })
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 and PAPER-FLEX-007-C2 enforce Frame-only absent-slot Flex targets', async () => {
    const persistence = new FakePersistence()
    const value = flowDocument() as unknown as { nodes: Record<string, unknown>; relationships: Record<string, unknown> }
    value.nodes['component-target'] = { id: 'component-target', type: 'component', componentId: 'card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } }
    value.relationships['component-target'] = { parentId: 'root-1', orderKey: 'Y' }
    persistence.current = projection(value as never)
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: createSemanticProjector(), checkpoints })
    await room.start()
    const owner = new FakePeer('component-target-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    const forged = structuredClone(flowPresentation())
    ;(forged.target! as { parentId: string; slot: { presence: 'present'; value: string } }).parentId = 'component-target'
    ;(forged.target! as { parentId: string; slot: { presence: 'present'; value: string } }).slot = { presence: 'present', value: 'children' }
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: forged })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'component_slot_unverified' })

    owner.messages.length = 0
    const componentAbsent = structuredClone(flowPresentation())
    ;(componentAbsent.target! as { parentId: string }).parentId = 'component-target'
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: componentAbsent })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'component_slot_unverified' })

    owner.messages.length = 0
    const framePresent = structuredClone(flowPresentation())
    ;(framePresent.target! as { slot: { presence: 'present'; value: string } }).slot = { presence: 'present', value: 'children' }
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 3, presentation: framePresent })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'component_slot_unverified' })

    owner.messages.length = 0
    const root = structuredClone(flowPresentation())
    ;(root.target! as { parentId: string; parentOutline: null }).parentId = 'root-1'
    ;(root.target! as { parentId: string; parentOutline: null }).parentOutline = null
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 4, presentation: root })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'interaction.result', status: 'denied', denialCode: 'invalid_topology' })
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 refuses a target inside the selected subtree', async () => {
    const persistence = new FakePersistence()
    const value = flowDocument() as unknown as { nodes: Record<string, unknown>; relationships: Record<string, { parentId: string; orderKey: string }> }
    const flex = { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } as const
    value.nodes['source-node'] = { id: 'source-node', type: 'frame', name: 'Source subtree', styles: { left: 0, top: 0, width: 100, height: 80 }, layout: { item: { position: { mode: 'flow' } }, container: flex } }
    value.nodes['nested-target'] = { id: 'nested-target', type: 'frame', name: 'Nested target', styles: { left: 0, top: 0, width: 50, height: 40 }, layout: { item: { position: { mode: 'flow' } }, container: flex } }
    value.relationships['nested-target'] = { parentId: 'source-node', orderKey: 'V' }
    const room = createFlowRoomWith(persistence, value as never)
    await room.start()
    const owner = new FakePeer('subtree-target-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ sourceKind: 'frame', targetParentId: 'nested-target' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'invalid_topology', leaseId: null })
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 keeps reservations append-only, requires reserve for changes, and permits revisiting an unchanged lane', async () => {
    const room = createFlowRoom()
    await room.start()
    const owner = new FakePeer('reservation-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)

    owner.messages.length = 0
    const changed = flowPresentation({ sequence: 2, targetParentId: 'disjoint-frame' })
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: changed })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'stale_reservation' })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.reserve', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 3, targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' } }, presentation: changed })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'stale_reservation' })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.reserve', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 2, targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' } }, presentation: changed })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'retained', denialCode: null, reservationGeneration: 2 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.reserve', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 2, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } }, presentation: flowPresentation({ sequence: 3 }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'stale_reservation', reservationGeneration: 2 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.reserve', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 3, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } }, presentation: flowPresentation({ sequence: 4 }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'retained', denialCode: null, reservationGeneration: 3 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 3, presentation: flowPresentation({ sequence: 5 }) })
    expect(owner.messages).toEqual([])
    await room.drain()
  })

  it('CLOUD-SYNC-GESTURE-001-C2 binds terminal mutation semantics and literal post-projector lanes', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('terminal-owner')
    const peer = new FakePeer('terminal-peer')
    await room.admit(admission(owner))
    await room.admit(admission(peer, 'Z'.repeat(24), 'terminal-peer-request', 'terminal-peer-client'))
    owner.messages.length = 0
    peer.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)
    const terminal = flowPresentation({ sequence: 2, terminal: true })
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: terminal })
    owner.messages.length = 0
    peer.messages.length = 0
    await room.receive(owner.connectionId, {
      type: 'operation.submit',
      operation: {
        mutationId: 'flow-terminal-mutation', baseSequence: '0',
        command: { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'target-frame', orderKey: 'U' } },
        flowBinding: {
          leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1,
          terminalSampleSequence: 2, presentationDigest: flowPresentationDigest(terminal),
          sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } },
          targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } },
        },
      },
    })
    expect(persistence.calls).toContain('append:flow-terminal-mutation')
    expect((persistence.current.document.relationships as Record<string, { parentId: string }>)['source-node']).toMatchObject({ parentId: 'target-frame' })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'operation.ack', status: 'applied' })
    expect(peer.messages.map(message => JSON.parse(message))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'interaction.released', reason: 'committed', leaseId: granted.leaseId }),
      expect.objectContaining({ type: 'operation.applied', mutationId: 'flow-terminal-mutation' }),
    ]))
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 rejects wrong terminal digest before projector or persistence and permits disjoint edits', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('binding-owner')
    const disjoint = new FakePeer('binding-disjoint')
    await room.admit(admission(owner))
    await room.admit(admission(disjoint, 'K'.repeat(24), 'binding-disjoint-request', 'binding-disjoint-client'))
    owner.messages.length = 0
    disjoint.messages.length = 0
    const terminal = flowPresentation({ terminal: true })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)

    await room.receive(disjoint.connectionId, { type: 'operation.submit', operation: { mutationId: 'disjoint-edit', baseSequence: '0', command: { type: 'node.rename', nodeId: 'disjoint-node', name: 'Still disjoint' } } })
    expect(persistence.calls).toContain('append:disjoint-edit')

    owner.messages.length = 0
    await room.receive(owner.connectionId, {
      type: 'operation.submit', operation: {
        mutationId: 'wrong-flow-binding', baseSequence: '1', command: { type: 'node.reparent', nodeId: 'source-node', placement: { parentId: 'target-frame', index: 0 } },
        flowBinding: {
          leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1,
          terminalSampleSequence: 1, presentationDigest: '0'.repeat(64),
          sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } },
        },
      },
    })
    expect(persistence.calls).not.toContain('append:wrong-flow-binding')
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation', mutationId: 'wrong-flow-binding' })
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 rejects structural commands that overlap a reserved subtree, lane, container, or page', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('scope-owner')
    const contender = new FakePeer('scope-contender')
    await room.admit(admission(owner))
    await room.admit(admission(contender, 'G'.repeat(24), 'scope-contender-request', 'scope-contender-client'))
    owner.messages.length = 0
    contender.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })

    const commands: readonly Readonly<{ mutationId: string; command: SemanticFileCommand }>[] = [
      { mutationId: 'nested-source', command: { type: 'batch', commands: [{ type: 'batch', commands: [{ type: 'node.rename', nodeId: 'source-frame', name: 'Blocked' }] }] } },
      { mutationId: 'insert-target-lane', command: { type: 'node.insert', node: { id: 'inserted-node', type: 'rectangle', name: 'Inserted', styles: { left: 0, top: 0, width: 10, height: 10 }, layout: { item: { position: { mode: 'flow' } } } }, placement: { parentId: 'target-frame', index: 0 } } },
      { mutationId: 'reparent-target-lane', command: { type: 'node.reparent', nodeId: 'disjoint-node', placement: { parentId: 'target-frame', index: 0 } } },
      { mutationId: 'delete-page', command: { type: 'page.delete', pageId: 'page-1' } },
    ]
    for (const candidate of commands) {
      await room.receive(contender.connectionId, { type: 'operation.submit', operation: { mutationId: candidate.mutationId, baseSequence: '0', command: candidate.command } })
    }
    expect(persistence.calls.filter(call => call.startsWith('append:'))).toEqual([])
    expect(contender.messages.map(message => JSON.parse(message)).filter(message => message.type === 'room.error').map(message => message.mutationId)).toEqual([
      'nested-source', 'insert-target-lane', 'reparent-target-lane', 'delete-page',
    ])
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 prevents an older claim or disconnect from releasing a newer claim', async () => {
    const room = createFlowRoom()
    await room.start()
    const owner = new FakePeer('generation-owner')
    const peer = new FakePeer('generation-peer')
    await room.admit(admission(owner))
    await room.admit(admission(peer, 'H'.repeat(24), 'generation-peer-request', 'generation-peer-client'))
    owner.messages.length = 0
    peer.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const first = JSON.parse(owner.messages[0]!)
    owner.messages.length = 0
    const mutatedFence = structuredClone(flowPresentation({ sequence: 2 }))
    ;(mutatedFence.fence as { measurementRevision: number }).measurementRevision = 2
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: mutatedFence })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'invalid_topology', localClaimGeneration: 1, sampleSequence: 1 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', leaseId: first.leaseId, localClaimGeneration: 2, presentation: flowPresentation({ sequence: 2, sourceNodeId: 'disjoint-node', sourceParentId: 'disjoint-frame' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'invalid_topology', localClaimGeneration: 1, sampleSequence: 1 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', leaseId: first.leaseId, localClaimGeneration: 2, presentation: flowPresentation({ sequence: 2, targetParentId: 'disjoint-frame' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'stale_reservation', localClaimGeneration: 1, sampleSequence: 1 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', leaseId: first.leaseId, localClaimGeneration: 2, presentation: flowPresentation({ sequence: 2 }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'granted', leaseId: first.leaseId, localClaimGeneration: 2 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.release', pageId: 'page-1', leaseId: first.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled' })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'lease_not_found' })
    const peerCount = peer.messages.length
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: first.leaseId, localClaimGeneration: 2, reservationGeneration: 1, presentation: flowPresentation({ sequence: 3 }) })
    expect(peer.messages).toHaveLength(peerCount + 1)
    expect(JSON.parse(peer.messages.at(-1)!)).toMatchObject({ type: 'interaction.sample', localClaimGeneration: 2, presentation: { identity: { sampleSequence: 3 } } })
    await room.drain()
  })

  it('PAPER-FLEX-007-C2 commits support-clone identity as one literal duplicate lane transition', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('clone-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    const terminal = flowPresentation({ sequence: 1, terminal: true, supportClone: true, targetRawIndex: 1, targetSemanticIndex: 0 })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)
    owner.messages.length = 0
    await room.receive(owner.connectionId, {
      type: 'operation.submit', operation: {
        mutationId: 'clone-terminal', baseSequence: '0',
        command: { type: 'batch', commands: [
          { type: 'node.duplicate', nodeId: 'source-node', ids: { 'source-node': 'source-clone' } },
          { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'target-frame', orderKey: 'W' } },
        ] },
        flowBinding: {
          leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1,
          terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal),
          sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } },
        },
      },
    })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'operation.ack', status: 'applied' })
    const relationships = persistence.current.document.relationships as Record<string, { parentId: string }>
    expect(relationships['source-node']).toMatchObject({ parentId: 'target-frame', orderKey: 'W' })
    expect(relationships['source-clone']).toMatchObject({ parentId: 'source-frame' })
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 refuses a projector result whose literal lanes do not match the bound terminal transition', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(flowDocument())
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: { apply(value) { return value } }, checkpoints })
    await room.start()
    const owner = new FakePeer('mismatch-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    const terminal = flowPresentation({ terminal: true })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'mismatched-projector', baseSequence: '0', command: { type: 'node.reparent', nodeId: 'source-node', placement: { parentId: 'target-frame', index: 0 } },
      flowBinding: {
        leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1,
        terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal),
        sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } },
      },
    } })
    expect(persistence.calls).not.toContain('append:mismatched-projector')
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation', mutationId: 'mismatched-projector' })
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 distinguishes missing and cross-page sources before allocating a lease', async () => {
    const persistence = new FakePersistence()
    const value = structuredClone(flowDocument()) as unknown as { pages: unknown[]; nodes: Record<string, unknown>; relationships: Record<string, unknown> }
    value.pages.push({ id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' })
    value.nodes['root-2'] = { id: 'root-2', type: 'root' }
    value.nodes['page-2-node'] = { id: 'page-2-node', type: 'rectangle', name: 'Other page', styles: { left: 0, top: 0, width: 100, height: 80 }, layout: { item: { position: { mode: 'flow' } } } }
    value.relationships['page-2-node'] = { parentId: 'root-2', orderKey: 'V' }
    persistence.current = projection(value as never)
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: createSemanticProjector(), checkpoints })
    await room.start()
    const owner = new FakePeer('source-validation-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ sourceNodeId: 'missing-node' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'missing_node', leaseId: null })
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: flowPresentation({ sourceNodeId: 'page-2-node', sourceParentId: 'root-2' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'wrong_page', leaseId: null })
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 preserves an unchanged lease across a disjoint committed edit', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('disjoint-flow-owner')
    const editor = new FakePeer('disjoint-flow-editor')
    await room.admit(admission(owner))
    await room.admit(admission(editor, 'L'.repeat(24), 'disjoint-flow-request', 'disjoint-flow-client'))
    owner.messages.length = 0
    editor.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)
    await room.receive(editor.connectionId, { type: 'operation.submit', operation: { mutationId: 'disjoint-during-flow', baseSequence: '0', command: { type: 'node.rename', nodeId: 'disjoint-node', name: 'Disjoint update' } } })
    const peerSamplesBefore = editor.messages.map(message => JSON.parse(message)).filter(message => message.type === 'interaction.sample').length
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ sequence: 2 }) })
    expect(editor.messages.map(message => JSON.parse(message)).filter(message => message.type === 'interaction.sample')).toHaveLength(peerSamplesBefore + 1)
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 releases reservations on disconnect and protocol cleanup', async () => {
    const room = createFlowRoom()
    await room.start()
    const first = new FakePeer('cleanup-owner')
    const contender = new FakePeer('cleanup-contender')
    await room.admit(admission(first))
    await room.admit(admission(contender, 'M'.repeat(24), 'cleanup-contender-request', 'cleanup-contender-client'))
    first.messages.length = 0
    contender.messages.length = 0
    await room.receive(first.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    room.disconnect(first.connectionId)
    await waitUntil(() => contender.messages.some(message => JSON.parse(message).type === 'interaction.released'))
    contender.messages.length = 0
    await room.receive(contender.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'cleanup-contender-flow' }) })
    expect(contender.messages.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'interaction.result', status: 'granted', denialCode: null }))
    const contenderLease = JSON.parse(contender.messages[0]!).leaseId
    contender.messages.length = 0
    await room.receive(contender.connectionId, open('duplicate-open', fileId, 'cleanup-contender-client'))
    expect(contender.closes).toContainEqual({ code: 4400, reason: 'Duplicate room open' })
    const replacement = new FakePeer('cleanup-replacement')
    await room.admit(admission(replacement, 'N'.repeat(24), 'cleanup-replacement-request', 'cleanup-replacement-client'))
    replacement.messages.length = 0
    await room.receive(replacement.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'cleanup-replacement-flow' }) })
    expect(JSON.parse(replacement.messages[0]!)).toMatchObject({ status: 'granted', denialCode: null })
    expect(JSON.parse(replacement.messages[0]!).leaseId).not.toBe(contenderLease)
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 keeps a terminal reservation pending until persistence settles', async () => {
    const persistence = new FakePersistence()
    const pending = deferred<Awaited<ReturnType<NonNullable<typeof persistence.append>>>>()
    let appendInput: Parameters<NonNullable<typeof persistence.append>>[0] | null = null
    persistence.append = async input => { appendInput = input; return pending.promise }
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('pending-owner')
    const contender = new FakePeer('pending-contender')
    await room.admit(admission(owner))
    await room.admit(admission(contender, 'P'.repeat(24), 'pending-contender-request', 'pending-contender-client'))
    owner.messages.length = 0
    contender.messages.length = 0
    const terminal = flowPresentation({ terminal: true })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)
    owner.messages.length = 0
    contender.messages.length = 0
    const commit = room.receive(owner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'pending-terminal', baseSequence: '0', command: { type: 'node.reparent', nodeId: 'source-node', placement: { parentId: 'target-frame', index: 0 } },
      flowBinding: { leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } } },
    } })
    await waitUntil(() => persistence.calls.includes('append:pending-terminal'))
    const contenderAcquire = room.receive(contender.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'pending-contender-flow' }) })
    await new Promise(resolve => setImmediate(resolve))
    expect(contender.messages).toEqual([])
    const input = appendInput!
    const next = projection(input.projection.document, 1n)
    pending.resolve({ status: 'committed', projection: next, operation: { fileId, sequence: 1n, generationId, protocolEpoch: 4, fencingToken: 1n, subjectId, clientId, clientMutationId: 'pending-terminal', operationType: input.operationType, operationPayload: input.operationPayload, contentDigest: 'a'.repeat(64), committedAt: new Date(0).toISOString() } })
    await commit
    await contenderAcquire
    expect(contender.messages.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'interaction.result', status: 'denied', denialCode: 'invalid_topology' }))
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 releases a terminal reservation after persistence failure', async () => {
    const persistence = new FakePersistence()
    persistence.append = async () => { throw new Error('persistence failed') }
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('failure-owner')
    const contender = new FakePeer('failure-contender')
    await room.admit(admission(owner))
    await room.admit(admission(contender, 'Q'.repeat(24), 'failure-contender-request', 'failure-contender-client'))
    owner.messages.length = 0
    contender.messages.length = 0
    const terminal = flowPresentation({ terminal: true })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)
    await expect(room.receive(owner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'failed-terminal', baseSequence: '0', command: { type: 'node.reparent', nodeId: 'source-node', placement: { parentId: 'target-frame', index: 0 } },
      flowBinding: { leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } } },
    } })).rejects.toThrow('persistence failed')
    contender.messages.length = 0
    await room.receive(contender.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'failure-contender-flow' }) })
    expect(JSON.parse(contender.messages[0]!)).toMatchObject({ status: 'granted', denialCode: null })
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 rejects mutated lease, interaction, sequence, node, and lane bindings before projection', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('binding-mutation-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    const terminal = flowPresentation({ terminal: true })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)
    const validBinding = {
      leaseId: granted.leaseId as string, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1,
      terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal),
      sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' as const } },
      targetLane: { parentId: 'target-frame', slot: { presence: 'absent' as const } },
    }
    const attempts = [
      { mutationId: 'mutated-lease', binding: { ...validBinding, leaseId: '00000000-0000-4000-8000-000000000000' }, nodeId: 'source-node' },
      { mutationId: 'mutated-interaction', binding: { ...validBinding, interactionId: 'other-interaction' }, nodeId: 'source-node' },
      { mutationId: 'mutated-sequence', binding: { ...validBinding, terminalSampleSequence: 2 }, nodeId: 'source-node' },
      { mutationId: 'mutated-source-lane', binding: { ...validBinding, sourceLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' as const } } }, nodeId: 'source-node' },
      { mutationId: 'mutated-target-lane', binding: { ...validBinding, targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' as const } } }, nodeId: 'source-node' },
      { mutationId: 'mutated-node', binding: validBinding, nodeId: 'target-child' },
    ] as const
    owner.messages.length = 0
    for (const attempt of attempts) {
      await room.receive(owner.connectionId, { type: 'operation.submit', operation: {
        mutationId: attempt.mutationId, baseSequence: '0',
        command: { type: 'node.reparent', nodeId: attempt.nodeId, placement: { parentId: 'target-frame', index: 0 } },
        flowBinding: attempt.binding,
      } })
    }
    expect(persistence.calls.filter(call => call.startsWith('append:'))).toEqual([])
    expect(owner.messages.map(message => JSON.parse(message)).filter(message => message.type === 'room.error').map(message => message.mutationId)).toEqual(attempts.map(attempt => attempt.mutationId))
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 invalidates a lease when a targeted projector mutation changes a reserved lane', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(flowDocument())
    const semantic = createSemanticProjector()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: { apply(value, command) {
      const projected = semantic.apply(value, command)
      if (command.type !== 'node.rename' || command.nodeId !== 'disjoint-node') return projected
      const mutated = structuredClone(projected) as unknown as { relationships: Record<string, { parentId: string; orderKey: string }> }
      delete mutated.relationships['target-child']
      return mutated as never
    } }, checkpoints })
    await room.start()
    const owner = new FakePeer('lane-mutation-owner')
    const editor = new FakePeer('lane-mutation-editor')
    await room.admit(admission(owner))
    await room.admit(admission(editor, 'R'.repeat(24), 'lane-mutation-request', 'lane-mutation-client'))
    owner.messages.length = 0
    editor.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)
    await room.receive(editor.connectionId, { type: 'operation.submit', operation: { mutationId: 'mutate-reserved-lane', baseSequence: '0', command: { type: 'node.rename', nodeId: 'disjoint-node', name: 'Triggers mutation control' } } })
    expect(persistence.calls).not.toContain('append:mutate-reserved-lane')
    expect(editor.messages.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'room.error', mutationId: 'mutate-reserved-lane', code: 'invalid_operation' }))
    owner.messages.length = 0
    const editorCount = editor.messages.length
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ sequence: 2 }) })
    expect(owner.messages).toEqual([])
    expect(editor.messages).toHaveLength(editorCount + 1)
    expect(JSON.parse(editor.messages.at(-1)!)).toMatchObject({ type: 'interaction.sample', leaseId: granted.leaseId, presentation: { identity: { sampleSequence: 2 } } })
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 rejects a terminal batch that mutates an earlier non-active reserved lane', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('historical-lane-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)
    const terminal = flowPresentation({ sequence: 2, terminal: true, targetParentId: 'disjoint-frame' })
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.reserve', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 2, targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' } }, presentation: terminal })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'retained', reservationGeneration: 2 })

    owner.messages.length = 0
    const reclaimed = flowPresentation({ sequence: 3, terminal: true, targetParentId: 'disjoint-frame' })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 2, presentation: reclaimed })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'granted', localClaimGeneration: 2, reservationGeneration: 2, sampleSequence: 3 })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'mutate-historical-reserved-lane', baseSequence: '0', command: { type: 'batch', commands: [
        { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'disjoint-frame', orderKey: 'U' } },
        { type: 'node.delete', nodeIds: ['target-child'] },
      ] },
      flowBinding: { leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 2, reservationGeneration: 2, terminalSampleSequence: 3, presentationDigest: flowPresentationDigest(reclaimed), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' } } },
    } })
    expect(persistence.calls).not.toContain('append:mutate-historical-reserved-lane')
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 applies the flow sample burst limit without advancing the rejected sequence', async () => {
    const room = createFlowRoom()
    await room.start()
    const owner = new FakePeer('sample-limit-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)
    owner.messages.length = 0
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      for (let sequence = 2; sequence <= 481; sequence += 1) {
        await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ sequence }) })
      }
      expect(owner.messages).toEqual([])
      await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ sequence: 482 }) })
      expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'capacity_refused', sampleSequence: 482 })
    } finally {
      clock.mockRestore()
      await room.drain()
    }
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 requires a terminal presentation and exact support-clone semantics', async () => {
    const activePersistence = new FakePersistence()
    const activeRoom = createFlowRoom(activePersistence)
    await activeRoom.start()
    const activeOwner = new FakePeer('active-terminal-owner')
    await activeRoom.admit(admission(activeOwner))
    activeOwner.messages.length = 0
    const active = flowPresentation()
    await activeRoom.receive(activeOwner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: active })
    const activeLease = JSON.parse(activeOwner.messages[0]!)
    activeOwner.messages.length = 0
    await activeRoom.receive(activeOwner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'active-not-terminal', baseSequence: '0', command: { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'target-frame', orderKey: 'U' } },
      flowBinding: { leaseId: activeLease.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(active), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } } },
    } })
    expect(activePersistence.calls).not.toContain('append:active-not-terminal')
    expect(JSON.parse(activeOwner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })
    await activeRoom.drain()

    const clonePersistence = new FakePersistence()
    const cloneRoom = createFlowRoom(clonePersistence)
    await cloneRoom.start()
    const cloneOwner = new FakePeer('clone-binding-owner')
    await cloneRoom.admit(admission(cloneOwner))
    cloneOwner.messages.length = 0
    const terminalWithoutClone = flowPresentation({ terminal: true })
    await cloneRoom.receive(cloneOwner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminalWithoutClone })
    const cloneLease = JSON.parse(cloneOwner.messages[0]!)
    cloneOwner.messages.length = 0
    await cloneRoom.receive(cloneOwner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'clone-without-support', baseSequence: '0', command: { type: 'batch', commands: [
        { type: 'node.duplicate', nodeId: 'source-node', ids: { 'source-node': 'unbound-clone' } },
        { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'target-frame', orderKey: 'U' } },
      ] },
      flowBinding: { leaseId: cloneLease.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminalWithoutClone), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } } },
    } })
    expect(clonePersistence.calls).not.toContain('append:clone-without-support')
    expect(JSON.parse(cloneOwner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })
    await cloneRoom.receive(cloneOwner.connectionId, { type: 'interaction.release', pageId: 'page-1', leaseId: cloneLease.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled' })
    cloneOwner.messages.length = 0
    const terminalWithClone = flowPresentation({ terminal: true, supportClone: true, interactionId: 'support-move' })
    await cloneRoom.receive(cloneOwner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: terminalWithClone })
    const moveLease = JSON.parse(cloneOwner.messages[0]!)
    cloneOwner.messages.length = 0
    await cloneRoom.receive(cloneOwner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'move-with-support', baseSequence: '0', command: { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'target-frame', orderKey: 'U' } },
      flowBinding: { leaseId: moveLease.leaseId, interactionId: 'support-move', localClaimGeneration: 2, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminalWithClone), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } } },
    } })
    expect(clonePersistence.calls).not.toContain('append:move-with-support')
    expect(JSON.parse(cloneOwner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })
    await cloneRoom.drain()
  })

  it('PAPER-FLEX-007-C2 keeps the support clone at the source when the selected original moves within the same lane', async () => {
    const persistence = new FakePersistence()
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer('same-lane-clone-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    const terminal = flowPresentation({ terminal: true, supportClone: true, targetParentId: 'source-frame', targetRawIndex: 0, targetSemanticIndex: 0 })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'operation.submit', operation: {
      mutationId: 'same-lane-clone-terminal', baseSequence: '0', command: { type: 'batch', commands: [
        { type: 'node.duplicate', nodeId: 'source-node', ids: { 'source-node': 'same-lane-clone' } },
        { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'source-frame', orderKey: 'z' } },
      ] },
      flowBinding: { leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'source-frame', slot: { presence: 'absent' } } },
    } })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'operation.ack', status: 'applied' })
    const relationships = persistence.current.document.relationships as Record<string, { parentId: string; orderKey: string }>
    expect(relationships['same-lane-clone']).toMatchObject({ parentId: 'source-frame' })
    expect(relationships['source-node']).toMatchObject({ parentId: 'source-frame', orderKey: 'z' })
    await room.drain()
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 preserves present-named Component source lanes through acquisition and exact binding', async () => {
    for (const slotValue of ['children', 'heading']) {
      const persistence = new FakePersistence()
      const value = flowDocument() as unknown as { nodes: Record<string, unknown>; relationships: Record<string, { parentId: string; orderKey: string; slot?: string }> }
      value.nodes['source-component-parent'] = { id: 'source-component-parent', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {} }
      value.nodes['source-node'] = { id: 'source-node', type: 'component', componentId: 'sample-button', exportName: 'Button', props: {}, layout: { item: { position: { mode: 'flow' } } } }
      value.relationships['source-component-parent'] = { parentId: 'root-1', orderKey: 'Y' }
      value.relationships['source-node'] = { parentId: 'source-component-parent', orderKey: 'V', slot: slotValue }
      persistence.current = projection(value as never)
      const semantic = createSemanticProjector()
      let projectorCalls = 0
      const room = new CollaborationRoomCore({
        identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
      }, { persistence, tickets: tickets(), projector: { apply(document, command) { projectorCalls += 1; return semantic.apply(document, command) } }, checkpoints })
      await room.start()
      const owner = new FakePeer(`slot-${slotValue}-owner`)
      await room.admit(admission(owner))
      owner.messages.length = 0
      const sourceSlot = { presence: 'present' as const, value: slotValue }
      const terminal = flowPresentation({ terminal: true, sourceKind: 'component', sourceParentId: 'source-component-parent', sourceSlot })
      await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
      const granted = JSON.parse(owner.messages[0]!)
      expect(granted).toMatchObject({ status: 'granted', denialCode: null })
      const validBinding = { leaseId: granted.leaseId as string, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal), sourceLane: { parentId: 'source-component-parent', slot: sourceSlot }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' as const } } }

      owner.messages.length = 0
      await room.receive(owner.connectionId, { type: 'operation.submit', operation: {
        mutationId: `slot-${slotValue}-forged`, baseSequence: '0',
        command: { type: 'node.reparent', nodeId: 'source-node', placement: { parentId: 'target-frame', index: 0 } },
        flowBinding: { ...validBinding, sourceLane: { parentId: 'source-component-parent', slot: { presence: 'absent' as const } } },
      } })
      expect(projectorCalls).toBe(0)
      expect(persistence.calls).not.toContain(`append:slot-${slotValue}-forged`)
      expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })

      owner.messages.length = 0
      await room.receive(owner.connectionId, { type: 'operation.submit', operation: {
        mutationId: `slot-${slotValue}-valid`, baseSequence: '0',
        command: { type: 'node.reparent', nodeId: 'source-node', placement: { parentId: 'target-frame', index: 0 } },
        flowBinding: validBinding,
      } })
      expect(projectorCalls).toBe(1)
      expect(persistence.calls).not.toContain(`append:slot-${slotValue}-valid`)
      expect(JSON.parse(owner.messages[0]!)).toMatchObject({ type: 'room.error', code: 'invalid_operation' })
      await room.drain()
    }
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 keeps absent and legacy present-empty lanes distinct at the topology adapter boundary', () => {
    const value = flowDocument() as unknown as { relationships: Record<string, { parentId: string; orderKey: string; slot?: string }> }
    value.relationships['source-node'] = { parentId: 'source-frame', orderKey: 'V', slot: '' }
    const empty = flowLaneSnapshot(value as never, { parentId: 'source-frame', slot: { presence: 'present', value: '' } })
    const absent = flowLaneSnapshot(value as never, { parentId: 'source-frame', slot: { presence: 'absent' } })
    expect(empty?.nodeIds).toEqual(['source-node'])
    expect(absent?.nodeIds).toEqual([])
    expect(sameFlowLane(empty!.lane, absent!.lane)).toBe(false)
  })

  it('CLOUD-SYNC-SCHEMA-001-C2 rejects a forged source position mode without allocating a lease', async () => {
    const persistence = new FakePersistence()
    const value = flowDocument() as unknown as { nodes: Record<string, { layout?: { item: { position: { mode: string } } } }> }
    value.nodes['source-node']!.layout = { item: { position: { mode: 'freeform' } } }
    const room = createFlowRoomWith(persistence, value as never)
    await room.start()
    const owner = new FakePeer('mode-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'invalid_topology', leaseId: null })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: flowPresentation({ interactionId: 'mode-proof', sourceNodeId: 'disjoint-node', sourceParentId: 'disjoint-frame', targetParentId: 'target-frame' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'granted', denialCode: null })
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 rejects cross-page release while retaining the authoritative lease and permits cleanup after access loss', async () => {
    let current = true
    const persistence = new FakePersistence()
    const room = createFlowRoomWith(persistence, flowDocument(), customTickets(
      async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
      async () => current,
    ))
    await room.start()
    const owner = new FakePeer('release-page-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.release', pageId: 'page-2', leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled' })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'wrong_page', pageId: 'page-1', leaseId: granted.leaseId })

    current = false
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.release', pageId: 'page-1', leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled' })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'released', denialCode: null, pageId: 'page-1' })
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 releases reservations after ticket revocation so a contender can acquire', async () => {
    let revokedClient: string | null = null
    const persistence = new FakePersistence()
    const room = createFlowRoomWith(persistence, flowDocument(), customTickets(
      async context => ({ subjectId, displayName: 'Alpha', avatarUrl: null, fileId, role: 'owner', generationId, protocolEpoch: 4, expiresAtUnixMs: Date.now() + 60_000, accessEpoch: '1', clientId: context.clientId, connectionNonce: context.connectionNonce }),
      async claims => claims.clientId !== revokedClient,
    ))
    await room.start()
    const owner = new FakePeer('revoked-flow-owner')
    const contender = new FakePeer('revoked-flow-contender')
    await room.admit(admission(owner))
    await room.admit(admission(contender, 'V'.repeat(24), 'revoked-contender-request', 'revoked-contender-client'))
    owner.messages.length = 0
    contender.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    const granted = JSON.parse(owner.messages[0]!)
    revokedClient = clientId
    await room.receive(owner.connectionId, { type: 'interaction.sample', pageId: 'page-1', leaseId: granted.leaseId, localClaimGeneration: 1, reservationGeneration: 1, presentation: flowPresentation({ sequence: 2 }) })
    contender.messages.length = 0
    await room.receive(contender.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'after-revocation' }) })
    expect(contender.messages.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'interaction.result', status: 'granted', denialCode: null }))
    await room.drain()
  })

  it.each(['access-revoked', 'access-conflict'] as const)('CLOUD-SYNC-LEASE-001-C2 releases a terminal reservation after persistence returns %s', async status => {
    const persistence = new FakePersistence()
    persistence.append = async () => status === 'access-revoked'
      ? { status: 'access-revoked' as const }
      : { status: 'access-conflict' as const, currentAccessEpoch: 2n }
    const room = createFlowRoom(persistence)
    await room.start()
    const owner = new FakePeer(`${status}-owner`)
    const contender = new FakePeer(`${status}-contender`)
    await room.admit(admission(owner))
    await room.admit(admission(contender, 'X'.repeat(24), `${status}-request`, `${status}-client`))
    owner.messages.length = 0
    contender.messages.length = 0
    const terminal = flowPresentation({ terminal: true })
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: terminal })
    const granted = JSON.parse(owner.messages[0]!)
    await room.receive(owner.connectionId, { type: 'operation.submit', operation: {
      mutationId: `${status}-terminal`, baseSequence: '0', command: { type: 'node.restoreRelationship', nodeId: 'source-node', expected: { parentId: 'source-frame', orderKey: 'V' }, source: { parentId: 'target-frame', orderKey: 'U' } },
      flowBinding: { leaseId: granted.leaseId, interactionId: 'flow-interaction', localClaimGeneration: 1, reservationGeneration: 1, terminalSampleSequence: 1, presentationDigest: flowPresentationDigest(terminal), sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } } },
    } })
    contender.messages.length = 0
    await room.receive(contender.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: `${status}-contender-flow` }) })
    expect(contender.messages.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({ type: 'interaction.result', status: 'granted', denialCode: null }))
    await room.drain()
  })

  it('CLOUD-SYNC-LEASE-001-C2 refuses excessive source topology without partial allocation', async () => {
    const persistence = new FakePersistence()
    const value = flowDocument() as unknown as { nodes: Record<string, unknown>; relationships: Record<string, { parentId: string; orderKey: string }> }
    let parentId = 'source-node'
    for (let index = 0; index < 130; index += 1) {
      const nodeId = `deep-${index}`
      value.nodes[nodeId] = { id: nodeId, type: 'frame', name: nodeId, styles: { left: 0, top: 0, width: 10, height: 10 } }
      value.relationships[nodeId] = { parentId, orderKey: 'V' }
      parentId = nodeId
    }
    const room = createFlowRoomWith(persistence, value as never)
    await room.start()
    const owner = new FakePeer('deep-topology-owner')
    await room.admit(admission(owner))
    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'denied', denialCode: 'capacity_refused', leaseId: null })

    owner.messages.length = 0
    await room.receive(owner.connectionId, { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: flowPresentation({ interactionId: 'deep-capacity-proof', sourceNodeId: 'disjoint-node', sourceParentId: 'disjoint-frame', targetParentId: 'target-frame' }) })
    expect(JSON.parse(owner.messages[0]!)).toMatchObject({ status: 'granted', denialCode: null })
    await room.drain()
  })
})
