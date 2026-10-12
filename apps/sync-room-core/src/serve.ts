import { resolve } from 'node:path'
import { createPostgresCollaborationPersistence } from '@canvas/database/collaboration'
import { createPostgresControlPlane, createPostgresPool } from '@canvas/database/postgres'
import { collaborationProtocolEpoch, defaultMaxCollaborationMessageBytes } from '@canvas/sync-protocol'
import { FileCheckpointStore } from './checkpoints.js'
import { migrateLegacyCollaborationDocument, validateLegacyCollaborationDocument } from './legacy-document.js'
import { createRoomNetworkServer } from './network.js'
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

const uuid = (name: string): string => {
  const value = required(name)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID.`)
  return value
}

const secret = required('SYNC_ROOM_TICKET_SECRET')
if (!/^[A-Za-z0-9_-]+$/.test(secret)) throw new Error('SYNC_ROOM_TICKET_SECRET must be base64url.')
const secretBytes = Buffer.from(secret, 'base64url')
if (secretBytes.byteLength < 32) throw new Error('SYNC_ROOM_TICKET_SECRET must decode to at least 32 bytes.')

const port = integer('PORT', 4322, 65_535)
const hostname = process.env.HOST?.trim() || '127.0.0.1'
const leaseDurationMs = integer('SYNC_ROOM_LEASE_DURATION_MS', 30_000, 600_000)
const leaseRenewalMs = integer('SYNC_ROOM_LEASE_RENEWAL_MS', 10_000, 300_000)
const drainTimeoutMs = integer('SYNC_ROOM_DRAIN_TIMEOUT_MS', 20_000, 300_000)
const maxMessageBytes = integer('SYNC_MAX_MESSAGE_BYTES', defaultMaxCollaborationMessageBytes, 8 * 1024 * 1024)
const handshakeTimeoutMs = integer('SYNC_ROOM_HANDSHAKE_TIMEOUT_MS', 5_000, 30_000)
const allowedOrigins = required('ALLOWED_ORIGINS').split(',').map(value => value.trim()).filter(Boolean)
const pool = createPostgresPool(required('DATABASE_URL'))
const controlPlane = createPostgresControlPlane(pool)
const room = new CollaborationRoomCore({
  identity: { fileId: uuid('SYNC_ROOM_FILE_ID'), generationId: uuid('SYNC_ROOM_GENERATION_ID'), protocolEpoch: collaborationProtocolEpoch },
  leaseDurationMs,
  leaseRenewalMs,
  drainTimeoutMs,
  maxMessageBytes,
}, {
  persistence: createPostgresCollaborationPersistence(pool, {
    migrateLegacyDocument: migrateLegacyCollaborationDocument,
    validateLegacyDocument: validateLegacyCollaborationDocument,
  }),
  tickets: new HmacRoomTicketVerifier(secretBytes, {
    async resolve(input) {
      const access = await controlPlane.resolveFileAccess(input.subjectId, input.fileId)
      return access ? { role: access.role, accessEpoch: access.accessEpoch } : null
    },
  }),
  projector: createSemanticProjector(),
  checkpoints: new FileCheckpointStore(resolve(required('SYNC_ROOM_CHECKPOINT_DIR'))),
  logger: { event(event) { process.stdout.write(`${JSON.stringify(event)}\n`) } },
})
const network = createRoomNetworkServer({ room, allowedOrigins, maxMessageBytes, handshakeTimeoutMs })

try {
  await pool.query('SELECT 1')
  await room.start()
  await network.listen(port, hostname)
} catch (error) {
  try {
    await pool.end()
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Sync room startup and database cleanup both failed.')
  }
  throw error
}

process.stdout.write(`Sync room: ws://${hostname}:${port}/sync/:fileId/:generationId?clientId=:clientId&connectionNonce=:nonce\n`)

let stopping: Promise<void> | null = null
const stop = (): Promise<void> => {
  if (!stopping) stopping = (async () => { try { await network.close() } finally { await pool.end() } })()
  return stopping
}
const stopForSignal = () => {
  void stop().then(
    () => process.exit(room.phase === 'stopped' ? 0 : 1),
    error => { process.stderr.write(`Sync room shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) },
  )
}
process.once('SIGINT', stopForSignal)
process.once('SIGTERM', stopForSignal)
