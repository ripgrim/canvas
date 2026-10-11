import { resolve } from 'node:path'
import { createPostgresCollaborationPersistence } from '@canvas/database/collaboration'
import { createPostgresControlPlane, createPostgresPool } from '@canvas/database/postgres'
import { defaultMaxCollaborationMessageBytes } from '@canvas/sync-protocol'
import { FileCheckpointStore } from './checkpoints.js'
import { createMultiRoomHost } from './host.js'
import { migrateLegacyCollaborationDocument, validateLegacyCollaborationDocument } from './legacy-document.js'
import { createSemanticProjector } from './projector.js'
import { CollaborationRoomCore } from './room-core.js'
import { HmacRoomTicketVerifier } from './tickets.js'

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const integer = (name: string, fallback: number, maximum: number): number => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} is invalid.`)
  return value
}

const secret = required('SYNC_ROOM_TICKET_SECRET')
if (!/^[A-Za-z0-9_-]+$/.test(secret)) throw new Error('SYNC_ROOM_TICKET_SECRET must be base64url.')
const secretBytes = Buffer.from(secret, 'base64url')
if (secretBytes.byteLength < 32) throw new Error('SYNC_ROOM_TICKET_SECRET must decode to at least 32 bytes.')

const port = integer('PORT', 4325, 65_535)
const hostname = process.env.HOST?.trim() || '127.0.0.1'
const leaseDurationMs = integer('SYNC_ROOM_LEASE_DURATION_MS', 30_000, 600_000)
const leaseRenewalMs = integer('SYNC_ROOM_LEASE_RENEWAL_MS', 10_000, 300_000)
const drainTimeoutMs = integer('SYNC_ROOM_DRAIN_TIMEOUT_MS', 20_000, 300_000)
const maxMessageBytes = integer('SYNC_MAX_MESSAGE_BYTES', defaultMaxCollaborationMessageBytes, 8 * 1024 * 1024)
const maxRooms = integer('SYNC_HOST_MAX_ROOMS', 32, 1_024)
const maxPendingUpgrades = integer('SYNC_HOST_MAX_PENDING_UPGRADES', 64, 4_096)
const handshakeTimeoutMs = integer('SYNC_ROOM_HANDSHAKE_TIMEOUT_MS', 5_000, 30_000)
const startupTimeoutMs = integer('SYNC_HOST_STARTUP_TIMEOUT_MS', 10_000, 120_000)
const shutdownTimeoutMs = integer('SYNC_HOST_SHUTDOWN_TIMEOUT_MS', 30_000, 300_000)
const allowedOrigins = required('ALLOWED_ORIGINS').split(',').map(value => value.trim()).filter(Boolean)
const pool = createPostgresPool(required('DATABASE_URL'))
const controlPlane = createPostgresControlPlane(pool)
const persistence = createPostgresCollaborationPersistence(pool, {
  migrateLegacyDocument: migrateLegacyCollaborationDocument,
  validateLegacyDocument: validateLegacyCollaborationDocument,
})
const tickets = new HmacRoomTicketVerifier(secretBytes, {
  async resolve(input) {
    const access = await controlPlane.resolveFileAccess(input.subjectId, input.fileId)
    return access ? { role: access.role, accessEpoch: access.accessEpoch } : null
  },
})
const projector = createSemanticProjector()
const checkpoints = new FileCheckpointStore(resolve(required('SYNC_ROOM_CHECKPOINT_DIR')))
const logger = { event(event: Readonly<Record<string, string | number | boolean | null>>) { process.stdout.write(`${JSON.stringify(event)}\n`) } }
const host = createMultiRoomHost({
  allowedOrigins,
  maxMessageBytes,
  maxRooms,
  maxPendingUpgrades,
  handshakeTimeoutMs,
  startupTimeoutMs,
  shutdownTimeoutMs,
  tickets,
  createRoom(identity) {
    return new CollaborationRoomCore({ identity, leaseDurationMs, leaseRenewalMs, drainTimeoutMs, maxMessageBytes }, {
      persistence,
      tickets,
      projector,
      checkpoints,
      logger,
    })
  },
})

try {
  await pool.query('SELECT 1')
  await host.listen(port, hostname)
} catch (error) {
  try {
    await pool.end()
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Sync room host startup and database cleanup both failed.')
  }
  throw error
}

process.stdout.write(`Sync room host: ws://${hostname}:${port}/sync/:fileId/:generationId?clientId=:clientId&connectionNonce=:nonce\n`)

let stopping: Promise<void> | null = null
const stop = (): Promise<void> => {
  if (!stopping) stopping = (async () => {
    try {
      const result = await host.close()
      if (result.status !== 'stopped') throw new Error('One or more rooms failed to drain.')
    } finally {
      await pool.end()
    }
  })()
  return stopping
}
const stopForSignal = () => {
  void stop().then(
    () => process.exit(0),
    error => { process.stderr.write(`Sync room host shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) },
  )
}
process.once('SIGINT', stopForSignal)
process.once('SIGTERM', stopForSignal)
