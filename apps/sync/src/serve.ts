import { createInternalApiAuthorizer } from './internal-api-authorizer.js'
import { createSyncNetworkServer } from './network.js'
import { createPostgresSyncPool, PostgresSyncRepository } from './postgres-repository.js'

const integer = (name: string, fallback: number, maximum: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} is invalid`)
  return value
}
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value }
const origins = required('ALLOWED_ORIGINS').split(',').map(value => value.trim()).filter(Boolean)
const port = integer('PORT', 4321, 65_535)
const maxMessageBytes = integer('SYNC_MAX_MESSAGE_BYTES', 256 * 1024, 8 * 1024 * 1024)
const historyLimit = integer('SYNC_HISTORY_LIMIT', 1_000, 100_000)
const hostname = process.env.HOST?.trim() || '127.0.0.1'
const authorizer = createInternalApiAuthorizer({ apiBaseUrl: process.env.API_BASE_URL ?? 'http://127.0.0.1:4320', serviceToken: required('API_SERVICE_TOKEN') })
const pool = createPostgresSyncPool(required('DATABASE_URL'))
const runtime = createSyncNetworkServer({ repository: new PostgresSyncRepository(pool, { historyLimit }), authorizer, allowedOrigins: origins, maxMessageBytes })
try {
  await pool.query('SELECT 1')
  await runtime.listen(port, hostname)
} catch (error) {
  try { await pool.end() }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Sync startup and database cleanup both failed.') }
  throw error
}
process.stdout.write(`Sync: ws://${hostname}:${port}/sync/:fileId?tabId=:clientId\n`)

let stopping: Promise<void> | null = null
const stop = async () => {
  if (!stopping) stopping = (async () => { try { await runtime.close() } finally { await pool.end() } })()
  return stopping
}
const stopForSignal = () => {
  void stop().then(
    () => process.exit(0),
    error => { process.stderr.write(`Sync shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) },
  )
}
process.once('SIGINT', stopForSignal)
process.once('SIGTERM', stopForSignal)
