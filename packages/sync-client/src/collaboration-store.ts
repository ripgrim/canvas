import type { DurableSequence, PersistedSemanticCommand } from '@canvas/sync-protocol'

const databaseName = 'canvas-collaboration'
const databaseVersion = 1
const storeName = 'rooms'
const defaultMaxCheckpointBytes = 64 * 1024 * 1024
const defaultMaxPendingBytes = 8 * 1024 * 1024
const defaultMaxPendingMutations = 512
const defaultMaxRoomsPerAccount = 24

export type CollaborationStoreScope = Readonly<{
  accountId: string
  clientId: string
  fileId: string
  documentSchemaVersion: number
  protocolEpoch: number
}>

export type StoredCollaborationCheckpoint = Readonly<{
  snapshotId: string
  serverSequence: DurableSequence
  document: unknown
}>

export type StoredCollaborationMutation = Readonly<{
  mutationId: string
  baseSequence: DurableSequence | null
  command: PersistedSemanticCommand
  status: 'pending' | 'recoverable'
}>

export type StoredCollaborationRoom = Readonly<{
  scope: CollaborationStoreScope
  checkpoint: StoredCollaborationCheckpoint | null
  pending: readonly StoredCollaborationMutation[]
  updatedAt: number
}>

export type CollaborationStoreLimits = Readonly<{
  maxCheckpointBytes?: number
  maxPendingBytes?: number
  maxPendingMutations?: number
  maxRoomsPerAccount?: number
}>

export type CollaborationStoreDriver = Readonly<{
  read(key: string): Promise<unknown | null>
  update(key: string, updater: (current: unknown | null) => unknown | null): Promise<void>
  reserve(room: StoredCollaborationRoom, maxRooms: number): Promise<void>
  purgeAccount(accountId: string): Promise<void>
}>

export type CollaborationDurableStore = Readonly<{
  load(scope: CollaborationStoreScope): Promise<unknown | null>
  repair(scope: CollaborationStoreScope, room: StoredCollaborationRoom | null): Promise<void>
  enqueue(scope: CollaborationStoreScope, mutation: StoredCollaborationMutation): Promise<void>
  checkpoint(scope: CollaborationStoreScope, checkpoint: StoredCollaborationCheckpoint): Promise<void>
  acknowledge(scope: CollaborationStoreScope, mutationId: string, checkpoint: StoredCollaborationCheckpoint): Promise<void>
  markRecoverable(scope: CollaborationStoreScope, mutationId: string): Promise<void>
  clearCheckpoint(scope: CollaborationStoreScope): Promise<void>
  purgeAccount(accountId: string): Promise<void>
}>

function byteLength(value: unknown): number {
  let encoded: string
  try { encoded = JSON.stringify(value) }
  catch { throw new Error('Collaboration cache value is not serializable.') }
  return new TextEncoder().encode(encoded).byteLength
}

function scopeKey(scope: CollaborationStoreScope): string {
  return JSON.stringify([scope.accountId, scope.clientId, scope.fileId, scope.documentSchemaVersion, scope.protocolEpoch])
}

function emptyRoom(scope: CollaborationStoreScope): StoredCollaborationRoom {
  return Object.freeze({ scope: Object.freeze({ ...scope }), checkpoint: null, pending: Object.freeze([]), updatedAt: Date.now() })
}

function roomOrEmpty(value: unknown, scope: CollaborationStoreScope): StoredCollaborationRoom {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyRoom(scope)
  const record = value as Partial<StoredCollaborationRoom>
  if (JSON.stringify(record.scope) !== JSON.stringify(scope) || !Array.isArray(record.pending)) return emptyRoom(scope)
  return record as StoredCollaborationRoom
}

function reservableRoom(value: unknown, accountId: string): StoredCollaborationRoom | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Partial<StoredCollaborationRoom>
  if (typeof record.scope !== 'object' || record.scope === null || record.scope.accountId !== accountId || typeof record.scope.clientId !== 'string') return null
  if (!Array.isArray(record.pending) || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null
  return record as StoredCollaborationRoom
}

export function createCollaborationDurableStore(driver: CollaborationStoreDriver, limits: CollaborationStoreLimits = {}): CollaborationDurableStore {
  const maxCheckpointBytes = limits.maxCheckpointBytes ?? defaultMaxCheckpointBytes
  const maxPendingBytes = limits.maxPendingBytes ?? defaultMaxPendingBytes
  const maxMutations = limits.maxPendingMutations ?? defaultMaxPendingMutations
  const maxRooms = limits.maxRoomsPerAccount ?? defaultMaxRoomsPerAccount
  for (const [label, value] of [['checkpoint byte limit', maxCheckpointBytes], ['pending byte limit', maxPendingBytes], ['pending mutation limit', maxMutations], ['room limit', maxRooms]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Collaboration ${label} must be a positive integer.`)
  }

  const assertBounds = (room: StoredCollaborationRoom) => {
    if (room.pending.length > maxMutations) throw new Error('Too many pending collaboration changes.')
    if (room.checkpoint && byteLength(room.checkpoint.document) > maxCheckpointBytes) throw new Error('Collaboration checkpoint exceeds the storage limit.')
    if (byteLength(room.pending) > maxPendingBytes) throw new Error('Pending collaboration changes exceed the storage limit.')
  }

  const reserveRoom = async (scope: CollaborationStoreScope) => {
    await driver.reserve(emptyRoom(scope), maxRooms)
  }

  const update = async (scope: CollaborationStoreScope, updater: (room: StoredCollaborationRoom) => StoredCollaborationRoom | null) => {
    await reserveRoom(scope)
    const key = scopeKey(scope)
    await driver.update(key, current => {
      const next = updater(roomOrEmpty(current, scope))
      if (next) assertBounds(next)
      return next
    })
  }

  return Object.freeze({
    load(scope) { return driver.read(scopeKey(scope)) },
    repair(scope, room) { return update(scope, () => room) },
    enqueue(scope, mutation) {
      return update(scope, room => {
        if (room.pending.some(item => item.mutationId === mutation.mutationId)) throw new Error('Mutation id was already used.')
        return Object.freeze({ ...room, pending: Object.freeze([...room.pending, mutation]), updatedAt: Date.now() })
      })
    },
    checkpoint(scope, checkpoint) {
      return update(scope, room => Object.freeze({ ...room, checkpoint, updatedAt: Date.now() }))
    },
    acknowledge(scope, mutationId, checkpoint) {
      return update(scope, room => {
        const index = room.pending.findIndex(item => item.mutationId === mutationId)
        if (index < 0) return Object.freeze({ ...room, checkpoint, updatedAt: Date.now() })
        const pending = [...room.pending]
        pending.splice(index, 1)
        return Object.freeze({ ...room, checkpoint, pending: Object.freeze(pending), updatedAt: Date.now() })
      })
    },
    markRecoverable(scope, mutationId) {
      return update(scope, room => Object.freeze({
        ...room,
        pending: Object.freeze(room.pending.map(item => item.mutationId === mutationId ? Object.freeze({ ...item, status: 'recoverable' as const }) : item)),
        updatedAt: Date.now(),
      }))
    },
    clearCheckpoint(scope) {
      return update(scope, room => Object.freeze({ ...room, checkpoint: null, updatedAt: Date.now() }))
    },
    purgeAccount(accountId) { return driver.purgeAccount(accountId) },
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed.')), { once: true })
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.')), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('IndexedDB transaction failed.')), { once: true })
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(databaseName, databaseVersion)
  request.addEventListener('upgradeneeded', () => {
    const database = request.result
    if (database.objectStoreNames.contains(storeName)) return
    const store = database.createObjectStore(storeName, { keyPath: 'key' })
    store.createIndex('accountId', 'accountId')
  })
  return requestResult(request)
}

export function createIndexedDbCollaborationStore(factory: IDBFactory = indexedDB, limits?: CollaborationStoreLimits): CollaborationDurableStore {
  const database = openDatabase(factory)
  const driver: CollaborationStoreDriver = Object.freeze({
    async read(key) {
      const db = await database
      const transaction = db.transaction(storeName, 'readonly')
      const row = await requestResult(transaction.objectStore(storeName).get(key)) as { value?: unknown } | undefined
      await transactionDone(transaction)
      return row?.value ?? null
    },
    async update(key, updater) {
      const db = await database
      const transaction = db.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const current = await requestResult(store.get(key)) as { value?: unknown } | undefined
      const next = updater(current?.value ?? null)
      if (next === null) store.delete(key)
      else {
        const room = next as StoredCollaborationRoom
        store.put({ key, accountId: room.scope.accountId, value: next })
      }
      await transactionDone(transaction)
    },
    async reserve(room, maxRooms) {
      const db = await database
      const transaction = db.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const key = scopeKey(room.scope)
      const existing = await requestResult(store.get(key)) as { value?: unknown } | undefined
      if (existing) { await transactionDone(transaction); return }
      const rows = await requestResult(store.index('accountId').getAll(room.scope.accountId)) as Array<{ key?: string; value?: unknown }>
      const rooms: Array<{ key: string; value: StoredCollaborationRoom }> = []
      for (const row of rows) {
        if (typeof row.key !== 'string') continue
        const value = reservableRoom(row.value, room.scope.accountId)
        if (value) rooms.push({ key: row.key, value })
        else store.delete(row.key)
      }
      const cleanRooms = rooms
        .filter(row => row.value.pending.length === 0)
        .sort((left, right) => left.value.updatedAt - right.value.updatedAt)
      let roomCount = rooms.length
      while (roomCount >= maxRooms && cleanRooms.length > 0) {
        store.delete(cleanRooms.shift()!.key)
        roomCount -= 1
      }
      if (roomCount >= maxRooms) {
        transaction.abort()
        throw new Error('Collaboration cache is full of unsaved work.')
      }
      store.put({ key, accountId: room.scope.accountId, value: room })
      await transactionDone(transaction)
    },
    async purgeAccount(accountId) {
      const db = await database
      const transaction = db.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const keys = await requestResult(store.index('accountId').getAllKeys(accountId))
      for (const key of keys) store.delete(key)
      await transactionDone(transaction)
    },
  })
  return createCollaborationDurableStore(driver, limits)
}
