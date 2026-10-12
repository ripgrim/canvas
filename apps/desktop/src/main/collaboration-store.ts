import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { createCollaborationDurableStore } from '@canvas/sync-client'
import type { CollaborationStoreDriver, StoredCollaborationRoom } from '@canvas/sync-client'

type CacheRow = Readonly<{ key: string; accountId: string; value: unknown }>

function cacheDirectory(value: string): string {
  const directory = resolve(value)
  if (!isAbsolute(value) || directory === parse(directory).root) throw new Error('Invalid collaboration cache directory.')
  return directory
}

function cacheName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`
}

function row(value: unknown): CacheRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<CacheRow>
  if (typeof candidate.key !== 'string' || typeof candidate.accountId !== 'string' || !Object.hasOwn(candidate, 'value')) return null
  return candidate as CacheRow
}

function room(value: unknown): StoredCollaborationRoom | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<StoredCollaborationRoom>
  if (!candidate.scope || typeof candidate.scope.accountId !== 'string' || !Array.isArray(candidate.pending) || typeof candidate.updatedAt !== 'number') return null
  return candidate as StoredCollaborationRoom
}

export function createDesktopCollaborationStore(path: string) {
  const directory = cacheDirectory(path)
  let transaction = Promise.resolve()
  const locked = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = transaction.then(operation)
    transaction = result.then(() => undefined, () => undefined)
    return result
  }
  const readRow = async (key: string): Promise<CacheRow | null> => {
    try {
      const parsed = JSON.parse(await readFile(join(directory, cacheName(key)), 'utf8'))
      const current = row(parsed)
      return current?.key === key ? current : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  }
  const writeRow = async (value: CacheRow): Promise<void> => {
    await mkdir(directory, { recursive: true })
    const target = join(directory, cacheName(value.key))
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  }
  const driver: CollaborationStoreDriver = Object.freeze({
    read: key => locked(async () => (await readRow(key))?.value ?? null),
    update: (key, updater) => locked(async () => {
      const current = await readRow(key)
      const next = updater(current?.value ?? null)
      if (next === null) { await rm(join(directory, cacheName(key)), { force: true }); return }
      const nextRoom = room(next)
      if (!nextRoom) throw new Error('Invalid collaboration cache update.')
      await writeRow({ key, accountId: nextRoom.scope.accountId, value: next })
    }),
    reserve: (candidate, maxRooms) => locked(async () => {
      const key = JSON.stringify([candidate.scope.accountId, candidate.scope.clientId, candidate.scope.fileId, candidate.scope.documentSchemaVersion, candidate.scope.protocolEpoch])
      if (await readRow(key)) return
      await mkdir(directory, { recursive: true })
      const entries = await readdir(directory, { withFileTypes: true })
      const rooms: Array<{ key: string; room: StoredCollaborationRoom }> = []
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
        try {
          const current = row(JSON.parse(await readFile(join(directory, entry.name), 'utf8')))
          const cachedRoom = room(current?.value)
          if (!current || !cachedRoom || current.accountId !== candidate.scope.accountId) continue
          rooms.push({ key: current.key, room: cachedRoom })
        } catch { continue }
      }
      const clean = rooms.filter(item => item.room.pending.length === 0).sort((left, right) => left.room.updatedAt - right.room.updatedAt)
      let count = rooms.length
      while (count >= maxRooms && clean.length) {
        await rm(join(directory, cacheName(clean.shift()!.key)), { force: true })
        count -= 1
      }
      if (count >= maxRooms) throw new Error('Collaboration cache is full of unsaved work.')
      await writeRow({ key, accountId: candidate.scope.accountId, value: candidate })
    }),
    purgeAccount: accountId => locked(async () => {
      await mkdir(directory, { recursive: true })
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
        try {
          const current = row(JSON.parse(await readFile(join(directory, entry.name), 'utf8')))
          if (current?.accountId === accountId) await rm(join(directory, entry.name), { force: true })
        } catch { continue }
      }
    }),
  })
  return createCollaborationDurableStore(driver)
}

export async function desktopCollaborationClientId(path: string): Promise<string> {
  const target = resolve(path)
  if (!isAbsolute(path) || target === parse(target).root) throw new Error('Invalid collaboration client identity path.')
  try {
    const value = (await readFile(target, 'utf8')).trim()
    if (/^desktop-[0-9a-f-]{36}$/i.test(value)) return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(resolve(target, '..'), { recursive: true })
  const value = `desktop-${randomUUID()}`
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  return value
}
