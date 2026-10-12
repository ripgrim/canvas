import { describe, expect, it } from 'vitest'
import { encodeSemanticCommandForPersistence } from '@canvas/sync-protocol'
import {
  createCollaborationDurableStore,
  type CollaborationStoreDriver,
  type CollaborationStoreScope,
  type StoredCollaborationRoom,
} from '../src/collaboration-store.js'

const firstScope: CollaborationStoreScope = Object.freeze({
  accountId: 'account-a',
  clientId: 'client-a',
  fileId: '11111111-1111-4111-8111-111111111111',
  documentSchemaVersion: 6,
  protocolEpoch: 4,
})

const secondScope: CollaborationStoreScope = Object.freeze({ ...firstScope, accountId: 'account-b' })

function key(scope: CollaborationStoreScope): string {
  return JSON.stringify([scope.accountId, scope.clientId, scope.fileId, scope.documentSchemaVersion, scope.protocolEpoch])
}

function memoryDriver(seed: Readonly<Record<string, unknown>> = {}) {
  const values = new Map(Object.entries(seed))
  let chain = Promise.resolve()
  const driver: CollaborationStoreDriver = {
    async read(value) { return values.get(value) ?? null },
    update(value, updater) {
      const result = chain.then(() => {
        const next = updater(values.get(value) ?? null)
        if (next === null) values.delete(value)
        else values.set(value, structuredClone(next))
      })
      chain = result.then(() => undefined, () => undefined)
      return result
    },
    reserve(room, maxRooms) {
      const result = chain.then(() => {
        const roomKey = key(room.scope)
        if (values.has(roomKey)) return
        const rooms = [...values.entries()].filter((entry) => {
          const value = entry[1]
          if (typeof value !== 'object' || value === null || Reflect.get(Reflect.get(value, 'scope') ?? {}, 'accountId') !== room.scope.accountId) return false
          if (!Array.isArray(Reflect.get(value, 'pending')) || typeof Reflect.get(value, 'updatedAt') !== 'number') { values.delete(entry[0]); return false }
          return true
        }) as Array<[string, StoredCollaborationRoom]>
        const cleanRooms = rooms.filter(([, value]) => value.pending.length === 0).sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        let roomCount = rooms.length
        while (roomCount >= maxRooms && cleanRooms.length > 0) { values.delete(cleanRooms.shift()![0]); roomCount -= 1 }
        if (roomCount >= maxRooms) throw new Error('Collaboration cache is full of unsaved work.')
        values.set(roomKey, structuredClone(room))
      })
      chain = result.then(() => undefined, () => undefined)
      return result
    },
    async purgeAccount(accountId) {
      for (const [value, room] of values) {
        if (typeof room === 'object' && room !== null && Reflect.get(Reflect.get(room, 'scope') ?? {}, 'accountId') === accountId) values.delete(value)
      }
    },
  }
  return { driver, values }
}

function mutation(mutationId: string, status: 'pending' | 'recoverable' = 'pending') {
  return Object.freeze({
    mutationId,
    baseSequence: null,
    command: encodeSemanticCommandForPersistence({ type: 'node.rename', nodeId: 'node-1', name: mutationId }),
    status,
    replayScopeId: 'a'.repeat(64),
    flowBinding: null,
  })
}

function checkpoint(title: string, replayScopeId = 'a'.repeat(64)) {
  return Object.freeze({ snapshotId: 'projection:1', serverSequence: '1', document: { title }, replayScopeId })
}

describe('durable collaboration store', () => {
  it('CLOUD-SYNC-CACHE-001 scopes records by account, tab client, file, document schema, and protocol epoch', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver)
    await store.enqueue(firstScope, mutation('mutation-account-a'))
    await store.enqueue(secondScope, mutation('mutation-account-b'))

    expect(await store.load(firstScope)).toMatchObject({ scope: firstScope, pending: [{ mutationId: 'mutation-account-a' }] })
    expect(await store.load(secondScope)).toMatchObject({ scope: secondScope, pending: [{ mutationId: 'mutation-account-b' }] })

    expect(await store.load({ ...firstScope, documentSchemaVersion: 7 })).toBeNull()
    expect(await store.load({ ...firstScope, protocolEpoch: 2 })).toBeNull()

    const secondTab = Object.freeze({ ...firstScope, clientId: 'client-b' })
    await store.enqueue(secondTab, mutation('mutation-client-b'))
    expect(await store.load(firstScope)).toMatchObject({ pending: [{ mutationId: 'mutation-account-a' }] })
    expect(await store.load(secondTab)).toMatchObject({ pending: [{ mutationId: 'mutation-client-b' }] })

    const accountKeyRemoved = JSON.stringify([firstScope.fileId, firstScope.documentSchemaVersion, firstScope.protocolEpoch])
    expect(memory.values.has(accountKeyRemoved)).toBe(false)
    expect(memory.values.size).toBe(3)
  })

  it('CLOUD-SYNC-STATE-001 atomically checkpoints an acknowledgement and removes only that mutation', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver)
    await store.enqueue(firstScope, mutation('mutation-first'))
    await store.enqueue(firstScope, mutation('mutation-second'))
    await store.acknowledge(firstScope, 'mutation-first', checkpoint('After first'))

    expect(await store.load(firstScope)).toMatchObject({
      checkpoint: { snapshotId: 'projection:1', serverSequence: '1', document: { title: 'After first' } },
      pending: [{ mutationId: 'mutation-second' }],
    })
  })

  it('CLOUD-SYNC-REPLAY-001 preserves insertion order and rejected work for recovery', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver)
    await store.enqueue(firstScope, mutation('mutation-first'))
    await store.enqueue(firstScope, mutation('mutation-second'))
    await store.markRecoverable(firstScope, 'mutation-first')

    expect(await store.load(firstScope)).toMatchObject({
      pending: [
        { mutationId: 'mutation-first', status: 'recoverable' },
        { mutationId: 'mutation-second', status: 'pending' },
      ],
    })
  })

  it('CLOUD-SYNC-LIFECYCLE-002 atomically revokes the checkpoint and every pending mutation', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver)
    await store.checkpoint(firstScope, checkpoint('Private'))
    await store.enqueue(firstScope, mutation('mutation-first'))
    await store.enqueue(firstScope, mutation('mutation-second'))

    await store.markAllRecoverable(firstScope, { clearCheckpoint: true })

    expect(await store.load(firstScope)).toMatchObject({
      checkpoint: null,
      pending: [
        { mutationId: 'mutation-first', status: 'recoverable' },
        { mutationId: 'mutation-second', status: 'recoverable' },
      ],
    })
  })

  it('CLOUD-SYNC-REPLAY-001 atomically quarantines mutations and cached bytes from another replay scope', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver)
    await store.enqueue(firstScope, mutation('mutation-old'))
    await store.enqueue(firstScope, Object.freeze({ ...mutation('mutation-current'), replayScopeId: 'b'.repeat(64) }))
    await store.checkpoint(firstScope, checkpoint('Private'))

    await store.reconcileReplayScope(firstScope, 'b'.repeat(64))

    expect(await store.load(firstScope)).toMatchObject({
      checkpoint: null,
      pending: [
        { mutationId: 'mutation-old', status: 'recoverable', replayScopeId: 'a'.repeat(64) },
        { mutationId: 'mutation-current', status: 'pending', replayScopeId: 'b'.repeat(64) },
      ],
    })
  })

  it('CLOUD-SYNC-CACHE-001 purges one account without disclosing or deleting another account', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver)
    await store.enqueue(firstScope, mutation('mutation-account-a'))
    await store.enqueue(secondScope, mutation('mutation-account-b'))
    await store.purgeAccount(firstScope.accountId)

    expect(await store.load(firstScope)).toBeNull()
    expect(await store.load(secondScope)).toMatchObject({ pending: [{ mutationId: 'mutation-account-b' }] })
  })

  it('CLOUD-SYNC-CACHE-001 enforces queue and byte bounds before replacing durable state', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver, { maxPendingMutations: 1, maxPendingBytes: 1_024, maxCheckpointBytes: 32 })
    await store.enqueue(firstScope, mutation('mutation-first'))

    await expect(store.enqueue(firstScope, mutation('mutation-second'))).rejects.toThrow('Too many pending')
    await expect(store.checkpoint(firstScope, { ...checkpoint('x'.repeat(100)), snapshotId: 'projection:0', serverSequence: '0' })).rejects.toThrow('storage limit')
    expect(await store.load(firstScope)).toMatchObject({ checkpoint: null, pending: [{ mutationId: 'mutation-first' }] })
  })

  it('CLOUD-SYNC-CACHE-001 never evicts a room that became dirty before the atomic reservation', async () => {
    const memory = memoryDriver()
    const store = createCollaborationDurableStore(memory.driver, { maxRoomsPerAccount: 1 })
    await store.enqueue(firstScope, mutation('mutation-unsaved'))
    const anotherFile = Object.freeze({ ...firstScope, fileId: '22222222-2222-4222-8222-222222222222' })

    await expect(store.checkpoint(anotherFile, { ...checkpoint('Other'), snapshotId: 'projection:0', serverSequence: '0' })).rejects.toThrow('full of unsaved work')
    expect(await store.load(firstScope)).toMatchObject({ pending: [{ mutationId: 'mutation-unsaved' }] })
    expect(await store.load(anotherFile)).toBeNull()
  })

  it('CLOUD-SYNC-CACHE-001 removes a corrupt sibling instead of blocking a new room', async () => {
    const corruptScope = Object.freeze({ ...firstScope, fileId: '33333333-3333-4333-8333-333333333333' })
    const memory = memoryDriver({ [key(corruptScope)]: { scope: corruptScope, checkpoint: null, pending: null, updatedAt: Date.now() } })
    const store = createCollaborationDurableStore(memory.driver, { maxRoomsPerAccount: 1 })
    const freshScope = Object.freeze({ ...firstScope, fileId: '44444444-4444-4444-8444-444444444444' })

    await store.checkpoint(freshScope, { ...checkpoint('Fresh'), snapshotId: 'projection:0', serverSequence: '0' })

    expect(await store.load(corruptScope)).toBeNull()
    expect(await store.load(freshScope)).toMatchObject({ checkpoint: { document: { title: 'Fresh' } }, pending: [] })
  })
})
