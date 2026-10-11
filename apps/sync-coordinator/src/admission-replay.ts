import type { DurableObjectStorage } from './platform.js'

const replayPrefix = 'admission:'
const cleanupBatchSize = 64

export async function consumeAdmission(storage: DurableObjectStorage, admissionId: string, expiresAtUnixMs: number, nowUnixMs: number): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(admissionId)
    || !Number.isSafeInteger(expiresAtUnixMs) || expiresAtUnixMs <= nowUnixMs) return false
  const key = `${replayPrefix}${admissionId}`
  const accepted = await storage.transaction(async transaction => {
    const consumedUntil = await transaction.get<number>(key)
    if (consumedUntil !== undefined && consumedUntil > nowUnixMs) return false
    await transaction.put(key, expiresAtUnixMs)
    return true
  })
  if (!accepted) return false
  const candidates = await storage.list<number>({ prefix: replayPrefix, limit: cleanupBatchSize })
  const expired = [...candidates].filter(([, expiry]) => expiry <= nowUnixMs).map(([candidate]) => candidate)
  if (expired.length > 0) await storage.delete(expired)
  return true
}
