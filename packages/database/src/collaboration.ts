import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

export type CollaborationJson = string | number | boolean | null | readonly CollaborationJson[] | Readonly<{ [key: string]: CollaborationJson }>
export type CollaborationPayload = Readonly<Record<string, CollaborationJson>>
export type CollaborationGenerationStatus = 'candidate' | 'active' | 'draining' | 'released' | 'expired' | 'failed'
export type CollaborationProjectionAuthority = 'legacy-seed' | 'room'
export type CollaborationCutoverAuthority = 'snapshot-seed' | 'room-authority'

export type CollaborationGeneration = Readonly<{
  fileId: string
  generationId: string
  protocolEpoch: number
  status: CollaborationGenerationStatus
  fencingToken: bigint | null
  createdAt: string
  activatedAt: string | null
  endedAt: string | null
}>

export type CollaborationLease = Readonly<{
  fileId: string
  generationId: string
  protocolEpoch: number
  fencingToken: bigint
  expiresAt: string
  renewedAt: string
}>

export type CollaborationOperation = Readonly<{
  fileId: string
  sequence: bigint
  generationId: string
  protocolEpoch: number
  fencingToken: bigint
  subjectId: string
  clientId: string
  clientMutationId: string
  operationType: string
  operationPayload: CollaborationPayload
  contentDigest: string
  committedAt: string
}>

export type CollaborationProjection = Readonly<{
  fileId: string
  sequence: bigint
  documentSchemaVersion: number
  document: CollaborationPayload
  documentDigest: string
  generationId: string
  fencingToken: bigint
  authority: CollaborationProjectionAuthority
  updatedAt: string
}>

export type CollaborationCheckpoint = Readonly<{
  fileId: string
  sequence: bigint
  objectKey: string
  objectDigest: string
  documentDigest: string
  compressedBytes: bigint
  documentSchemaVersion: number
  generationId: string
  fencingToken: bigint
  committedAt: string
}>

export type RegisterGenerationResult =
  | Readonly<{ status: 'registered' | 'replayed'; generation: CollaborationGeneration }>
  | Readonly<{ status: 'generation-conflict'; generation: CollaborationGeneration }>

export type ResolveCollaborationAdmissionGenerationResult = Readonly<{
  status: 'active' | 'candidate'
  generationId: string
}>

export type AcquireCollaborationLeaseResult =
  | Readonly<{ status: 'acquired'; lease: CollaborationLease }>
  | Readonly<{ status: 'held'; lease: CollaborationLease }>
  | Readonly<{ status: 'invalid-generation' }>

export type AppendCollaborationOperationResult =
  | Readonly<{ status: 'committed'; operation: CollaborationOperation; projection: CollaborationProjection }>
  | Readonly<{ status: 'replayed'; operation: CollaborationOperation }>
  | Readonly<{ status: 'access-revoked' }>
  | Readonly<{ status: 'access-conflict'; currentAccessEpoch: bigint }>
  | Readonly<{ status: 'stale-fence' }>
  | Readonly<{ status: 'mutation-conflict' }>
  | Readonly<{ status: 'sequence-conflict'; currentSequence: bigint }>

export type CommitCollaborationCheckpointResult =
  | Readonly<{ status: 'committed' | 'replayed'; checkpoint: CollaborationCheckpoint }>
  | Readonly<{ status: 'stale-fence' }>
  | Readonly<{ status: 'projection-conflict'; currentSequence: bigint | null }>
  | Readonly<{ status: 'checkpoint-conflict' }>

export type PruneCollaborationOperationsResult =
  | Readonly<{ status: 'pruned'; throughSequence: bigint; deletedCount: bigint }>
  | Readonly<{ status: 'stale-fence' }>
  | Readonly<{ status: 'no-committed-checkpoint' }>
  | Readonly<{ status: 'beyond-checkpoint'; checkpointSequence: bigint }>

export type BootstrapCollaborationProjectionResult =
  | Readonly<{ status: 'seeded' | 'replayed'; projection: CollaborationProjection; cutoverAuthority: 'snapshot-seed' }>
  | Readonly<{ status: 'existing-projection'; projection: CollaborationProjection; cutoverAuthority: CollaborationCutoverAuthority }>
  | Readonly<{ status: 'stale-fence' }>
  | Readonly<{ status: 'source-not-found' }>
  | Readonly<{ status: 'invalid-source'; reason: 'file-identity' | 'schema-version' | 'asset-externalization' | 'document-invalid' }>

export type CollaborationLegacyDocumentMigrationResult =
  | Readonly<{ status: 'migrated'; document: CollaborationPayload }>
  | Readonly<{ status: 'unsupported'; reason: 'schema-version' | 'asset-externalization' | 'document-invalid' }>

export type CollaborationLegacyDocumentValidationResult =
  | Readonly<{ status: 'valid' }>
  | Readonly<{ status: 'invalid'; reason: 'file-identity' | 'schema-version' | 'asset-externalization' | 'document-invalid' }>

export type CollaborationPersistenceOptions = Readonly<{
  migrateLegacyDocument?: (document: CollaborationPayload, targetSchemaVersion: number) => CollaborationLegacyDocumentMigrationResult
  validateLegacyDocument?: (input: Readonly<{
    sourceDocument: CollaborationPayload
    document: CollaborationPayload
    targetSchemaVersion: number
  }>) => CollaborationLegacyDocumentValidationResult
}>

export interface CollaborationPersistence {
  registerGeneration(input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number }>): Promise<RegisterGenerationResult>
  resolveAdmissionGeneration(input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number; candidateTtlMs: number }>): Promise<ResolveCollaborationAdmissionGenerationResult>
  acquireLease(input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number; leaseDurationMs: number }>): Promise<AcquireCollaborationLeaseResult>
  renewLease(input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number; fencingToken: bigint; leaseDurationMs: number }>): Promise<CollaborationLease | null>
  releaseLease(input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number; fencingToken: bigint }>): Promise<boolean>
  getLease(fileId: string): Promise<CollaborationLease | null>
  bootstrapProjectionFromLegacy(input: Readonly<{
    fileId: string
    generationId: string
    protocolEpoch: number
    fencingToken: bigint
    documentSchemaVersion: number
  }>): Promise<BootstrapCollaborationProjectionResult>
  appendOperation(input: Readonly<{
    fileId: string
    generationId: string
    protocolEpoch: number
    fencingToken: bigint
    expectedSubjectId: string
    expectedAccessEpoch: bigint
    clientId: string
    clientMutationId: string
    operationType: string
    operationPayload: CollaborationPayload
    baseSequence: bigint
    projection: Readonly<{ documentSchemaVersion: number; document: CollaborationPayload }>
  }>): Promise<AppendCollaborationOperationResult>
  listOperationsAfter(fileId: string, sequence: bigint, limit: number): Promise<readonly CollaborationOperation[]>
  getProjection(fileId: string): Promise<CollaborationProjection | null>
  pruneCoveredOperations(input: Readonly<{
    fileId: string
    generationId: string
    protocolEpoch: number
    fencingToken: bigint
    throughSequence: bigint
  }>): Promise<PruneCollaborationOperationsResult>
  commitVerifiedCheckpoint(input: Readonly<{
    fileId: string
    generationId: string
    protocolEpoch: number
    fencingToken: bigint
    sequence: bigint
    objectKey: string
    objectDigest: string
    documentDigest: string
    compressedBytes: bigint
    documentSchemaVersion: number
  }>): Promise<CommitCollaborationCheckpointResult>
  getCheckpoint(fileId: string): Promise<CollaborationCheckpoint | null>
}

type GenerationRow = QueryResultRow & Readonly<{
  file_id: string
  generation_id: string
  protocol_epoch: number
  status: CollaborationGenerationStatus
  fencing_token: string | number | bigint | null
  created_at: Date | string
  activated_at: Date | string | null
  ended_at: Date | string | null
}>
type LeaseRow = QueryResultRow & Readonly<{
  file_id: string
  active_generation_id: string | null
  protocol_epoch: number | null
  fencing_token: string | number | bigint
  lease_expires_at: Date | string | null
  renewed_at: Date | string | null
  is_active?: boolean
}>
type OperationRow = QueryResultRow & Readonly<{
  file_id: string
  sequence: string | number | bigint
  generation_id: string
  protocol_epoch: number
  fencing_token: string | number | bigint
  subject_id: string
  client_id: string
  client_mutation_id: string
  operation_type: string
  operation_payload: CollaborationPayload
  content_digest: string
  committed_at: Date | string
}>
type ProjectionRow = QueryResultRow & Readonly<{
  file_id: string
  sequence: string | number | bigint
  document_schema_version: number
  document: CollaborationPayload
  document_digest: string
  generation_id: string
  fencing_token: string | number | bigint
  authority: CollaborationProjectionAuthority
  updated_at: Date | string
}>
type LegacyDocumentRow = QueryResultRow & Readonly<{ file_id: string; document: CollaborationPayload }>
type CheckpointRow = QueryResultRow & Readonly<{
  file_id: string
  checkpoint_sequence: string | number | bigint
  object_key: string
  object_digest: string
  document_digest: string
  compressed_bytes: string | number | bigint
  document_schema_version: number
  generation_id: string
  fencing_token: string | number | bigint
  committed_at: Date | string
}>
type CheckpointHeadRow = QueryResultRow & Readonly<{ checkpoint_sequence: string | number | bigint }>
type DeletedCountRow = QueryResultRow & Readonly<{ deleted_count: string | number | bigint }>

const generationColumns = 'file_id, generation_id, protocol_epoch, status, fencing_token, created_at, activated_at, ended_at'
const leaseColumns = 'file_id, active_generation_id, protocol_epoch, fencing_token, lease_expires_at, renewed_at'
const operationColumns = 'file_id, sequence, generation_id, protocol_epoch, fencing_token, subject_id, client_id, client_mutation_id, operation_type, operation_payload, content_digest, committed_at'
const projectionColumns = 'file_id, sequence, document_schema_version, document, document_digest, generation_id, fencing_token, authority, updated_at'
const checkpointColumns = 'file_id, checkpoint_sequence, object_key, object_digest, document_digest, compressed_bytes, document_schema_version, generation_id, fencing_token, committed_at'
const digestPattern = /^[0-9a-f]{64}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const dangerousJsonKeys = new Set(['__proto__', 'constructor', 'prototype'])
const maxSignedInt64 = 9_223_372_036_854_775_807n
const maxPostgresInteger = 2_147_483_647

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const optionalIso = (value: Date | string | null): string | null => value === null ? null : iso(value)
const integer = (value: string | number | bigint, name: string): bigint => {
  const parsed = typeof value === 'bigint' ? value : BigInt(value)
  if (parsed < 0n || parsed > maxSignedInt64) throw new Error(`Database returned an invalid ${name}.`)
  return parsed
}
const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maxPostgresInteger) throw new Error(`${name} must be between 1 and ${maxPostgresInteger}.`)
  return value
}
const nonnegativeBigint = (value: bigint, name: string): bigint => {
  if (value < 0n || value > maxSignedInt64) throw new Error(`${name} must be between 0 and ${maxSignedInt64}.`)
  return value
}
const positiveBigint = (value: bigint, name: string): bigint => {
  if (value <= 0n || value > maxSignedInt64) throw new Error(`${name} must be between 1 and ${maxSignedInt64}.`)
  return value
}
const boundedText = (value: string, name: string, maximum: number): string => {
  if (value.length < 1 || value.length > maximum) throw new Error(`${name} must contain between 1 and ${maximum} characters.`)
  return value
}
const uuid = (value: string, name: string): string => {
  if (!uuidPattern.test(value)) throw new Error(`${name} must be a UUID.`)
  return value
}
const digest = (value: string, name: string): string => {
  if (!digestPattern.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest.`)
  return value
}
const duration = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000) throw new Error('Lease duration must be between 1 second and 24 hours.')
  return value
}

const generationFromRow = (row: GenerationRow): CollaborationGeneration => Object.freeze({
  fileId: row.file_id,
  generationId: row.generation_id,
  protocolEpoch: row.protocol_epoch,
  status: row.status,
  fencingToken: row.fencing_token === null ? null : integer(row.fencing_token, 'fencing token'),
  createdAt: iso(row.created_at),
  activatedAt: optionalIso(row.activated_at),
  endedAt: optionalIso(row.ended_at),
})

const leaseFromRow = (row: LeaseRow): CollaborationLease => {
  if (!row.active_generation_id || row.protocol_epoch === null || !row.lease_expires_at || !row.renewed_at) throw new Error('Database returned an incomplete collaboration lease.')
  return Object.freeze({
    fileId: row.file_id,
    generationId: row.active_generation_id,
    protocolEpoch: row.protocol_epoch,
    fencingToken: integer(row.fencing_token, 'fencing token'),
    expiresAt: iso(row.lease_expires_at),
    renewedAt: iso(row.renewed_at),
  })
}

const operationFromRow = (row: OperationRow): CollaborationOperation => Object.freeze({
  fileId: row.file_id,
  sequence: integer(row.sequence, 'operation sequence'),
  generationId: row.generation_id,
  protocolEpoch: row.protocol_epoch,
  fencingToken: integer(row.fencing_token, 'fencing token'),
  subjectId: row.subject_id,
  clientId: row.client_id,
  clientMutationId: row.client_mutation_id,
  operationType: row.operation_type,
  operationPayload: Object.freeze(row.operation_payload),
  contentDigest: row.content_digest,
  committedAt: iso(row.committed_at),
})

const projectionFromRow = (row: ProjectionRow): CollaborationProjection => Object.freeze({
  fileId: row.file_id,
  sequence: integer(row.sequence, 'projection sequence'),
  documentSchemaVersion: row.document_schema_version,
  document: Object.freeze(row.document),
  documentDigest: row.document_digest,
  generationId: row.generation_id,
  fencingToken: integer(row.fencing_token, 'fencing token'),
  authority: row.authority,
  updatedAt: iso(row.updated_at),
})

const checkpointFromRow = (row: CheckpointRow): CollaborationCheckpoint => Object.freeze({
  fileId: row.file_id,
  sequence: integer(row.checkpoint_sequence, 'checkpoint sequence'),
  objectKey: row.object_key,
  objectDigest: row.object_digest,
  documentDigest: row.document_digest,
  compressedBytes: integer(row.compressed_bytes, 'compressed byte count'),
  documentSchemaVersion: row.document_schema_version,
  generationId: row.generation_id,
  fencingToken: integer(row.fencing_token, 'fencing token'),
  committedAt: iso(row.committed_at),
})

export function canonicalCollaborationJson(value: CollaborationJson): string {
  return canonicalize(value, new WeakSet<object>())
}

function cloneCollaborationJson(value: CollaborationJson): CollaborationJson {
  return JSON.parse(canonicalCollaborationJson(value)) as CollaborationJson
}

export function collaborationOperationDigest(input: Readonly<{ protocolEpoch: number; operationType: string; operationPayload: CollaborationPayload }>): string {
  positiveInteger(input.protocolEpoch, 'Protocol epoch')
  boundedText(input.operationType, 'Operation type', 128)
  requirePayloadObject(input.operationPayload, 'Operation payload')
  return operationDigestFromPayloadJson(input.protocolEpoch, input.operationType, canonicalCollaborationJson(input.operationPayload))
}

export function collaborationDocumentDigest(document: CollaborationPayload): string {
  requirePayloadObject(document, 'Document')
  return createHash('sha256').update(canonicalCollaborationJson(document)).digest('hex')
}

export function createPostgresCollaborationPersistence(pool: Pool, options: CollaborationPersistenceOptions = {}): CollaborationPersistence {
  const persistence: CollaborationPersistence = {
    async registerGeneration(input) {
      validateRoomIdentity(input)
      const inserted = await pool.query<GenerationRow>(
        `INSERT INTO app_collaboration_generation (file_id, generation_id, protocol_epoch, status)
         VALUES ($1, $2, $3, 'candidate')
         ON CONFLICT (file_id, generation_id) DO NOTHING
         RETURNING ${generationColumns}`,
        [input.fileId, input.generationId, input.protocolEpoch],
      )
      if (inserted.rows[0]) return Object.freeze({ status: 'registered', generation: generationFromRow(inserted.rows[0]) })
      const existing = await pool.query<GenerationRow>(`SELECT ${generationColumns} FROM app_collaboration_generation WHERE file_id = $1 AND generation_id = $2`, [input.fileId, input.generationId])
      const row = existing.rows[0]
      if (!row) throw new Error('Generation registration did not return a record.')
      const generation = generationFromRow(row)
      return Object.freeze({ status: generation.protocolEpoch === input.protocolEpoch ? 'replayed' : 'generation-conflict', generation })
    },

    async resolveAdmissionGeneration(input) {
      validateRoomIdentity(input)
      duration(input.candidateTtlMs)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const file = await client.query('SELECT id FROM app_file WHERE id = $1 FOR UPDATE', [input.fileId])
        if (!file.rowCount) throw new Error('Collaboration file was not found.')
        await client.query('INSERT INTO app_collaboration_lease (file_id) VALUES ($1) ON CONFLICT (file_id) DO NOTHING', [input.fileId])
        const currentResult = await client.query<LeaseRow>(
          `SELECT ${leaseColumns}, lease_expires_at IS NOT NULL AND lease_expires_at > now() AS is_active
           FROM app_collaboration_lease WHERE file_id = $1 FOR UPDATE`,
          [input.fileId],
        )
        const current = currentResult.rows[0]
        if (!current) throw new Error('Collaboration lease row was not created.')
        if (current.is_active && current.active_generation_id) {
          if (current.protocol_epoch !== input.protocolEpoch) throw new Error('Active collaboration generation uses another protocol epoch.')
          await client.query('COMMIT')
          return Object.freeze({ status: 'active', generationId: uuid(current.active_generation_id, 'Active generation id') })
        }
        await client.query(
          `UPDATE app_collaboration_generation
           SET status = 'failed', ended_at = now()
           WHERE file_id = $1 AND status = 'candidate'
             AND (protocol_epoch <> $2 OR created_at <= now() - ($3 * interval '1 millisecond'))`,
          [input.fileId, input.protocolEpoch, input.candidateTtlMs],
        )
        const reusable = await client.query<GenerationRow>(
          `SELECT ${generationColumns} FROM app_collaboration_generation
           WHERE file_id = $1 AND protocol_epoch = $2 AND status = 'candidate'
             AND created_at > now() - ($3 * interval '1 millisecond')
           ORDER BY created_at, generation_id
           LIMIT 1`,
          [input.fileId, input.protocolEpoch, input.candidateTtlMs],
        )
        const candidate = reusable.rows[0]
        if (candidate) {
          const generation = generationFromRow(candidate)
          await client.query('COMMIT')
          return Object.freeze({ status: 'candidate', generationId: generation.generationId })
        }
        const inserted = await client.query<GenerationRow>(
          `INSERT INTO app_collaboration_generation (file_id, generation_id, protocol_epoch, status)
           VALUES ($1, $2, $3, 'candidate')
           RETURNING ${generationColumns}`,
          [input.fileId, input.generationId, input.protocolEpoch],
        )
        const generation = inserted.rows[0]
        if (!generation) throw new Error('Collaboration generation registration failed.')
        await client.query('COMMIT')
        return Object.freeze({ status: 'candidate', generationId: generationFromRow(generation).generationId })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },

    async acquireLease(input) {
      validateRoomIdentity(input)
      duration(input.leaseDurationMs)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('INSERT INTO app_collaboration_lease (file_id) VALUES ($1) ON CONFLICT (file_id) DO NOTHING', [input.fileId])
        const currentResult = await client.query<LeaseRow>(
          `SELECT ${leaseColumns}, lease_expires_at IS NOT NULL AND lease_expires_at > now() AS is_active
           FROM app_collaboration_lease WHERE file_id = $1 FOR UPDATE`,
          [input.fileId],
        )
        const current = currentResult.rows[0]
        if (!current) throw new Error('Collaboration lease row was not created.')
        if (current.is_active && current.active_generation_id) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'held', lease: leaseFromRow(current) })
        }

        if (current.active_generation_id) {
          await client.query(
            `UPDATE app_collaboration_generation
             SET status = 'expired', ended_at = now()
             WHERE file_id = $1 AND generation_id = $2 AND fencing_token = $3 AND status IN ('active', 'draining')`,
            [input.fileId, current.active_generation_id, String(current.fencing_token)],
          )
        }

        const nextFence = integer(current.fencing_token, 'fencing token') + 1n
        positiveBigint(nextFence, 'Fencing token')
        const activated = await client.query<GenerationRow>(
          `UPDATE app_collaboration_generation
           SET status = 'active', fencing_token = $4, activated_at = now(), ended_at = NULL
           WHERE file_id = $1 AND generation_id = $2 AND protocol_epoch = $3 AND status = 'candidate'
           RETURNING ${generationColumns}`,
          [input.fileId, input.generationId, input.protocolEpoch, nextFence.toString()],
        )
        if (!activated.rowCount) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'invalid-generation' })
        }

        const leased = await client.query<LeaseRow>(
          `UPDATE app_collaboration_lease
           SET active_generation_id = $2, protocol_epoch = $3, fencing_token = $4,
               lease_expires_at = now() + ($5 * interval '1 millisecond'), renewed_at = now()
           WHERE file_id = $1
           RETURNING ${leaseColumns}`,
          [input.fileId, input.generationId, input.protocolEpoch, nextFence.toString(), input.leaseDurationMs],
        )
        const row = leased.rows[0]
        if (!row) throw new Error('Collaboration lease acquisition failed.')
        await client.query('COMMIT')
        return Object.freeze({ status: 'acquired', lease: leaseFromRow(row) })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },

    async renewLease(input) {
      validateLeaseIdentity(input)
      duration(input.leaseDurationMs)
      const renewed = await pool.query<LeaseRow>(
        `UPDATE app_collaboration_lease
         SET lease_expires_at = now() + ($5 * interval '1 millisecond'), renewed_at = now()
         WHERE file_id = $1 AND active_generation_id = $2 AND protocol_epoch = $3
           AND fencing_token = $4 AND lease_expires_at > now()
         RETURNING ${leaseColumns}`,
        [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString(), input.leaseDurationMs],
      )
      return renewed.rows[0] ? leaseFromRow(renewed.rows[0]) : null
    },

    async releaseLease(input) {
      validateLeaseIdentity(input)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const current = await client.query<LeaseRow>(`SELECT ${leaseColumns} FROM app_collaboration_lease WHERE file_id = $1 FOR UPDATE`, [input.fileId])
        const row = current.rows[0]
        if (!row
          || row.active_generation_id !== input.generationId
          || row.protocol_epoch !== input.protocolEpoch
          || integer(row.fencing_token, 'fencing token') !== input.fencingToken) {
          const released = await client.query<GenerationRow>(
            `SELECT ${generationColumns} FROM app_collaboration_generation
             WHERE file_id = $1 AND generation_id = $2 AND protocol_epoch = $3 AND fencing_token = $4 AND status = 'released'`,
            [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString()],
          )
          await client.query('ROLLBACK')
          return released.rowCount === 1
        }
        const ended = await client.query(
          `UPDATE app_collaboration_generation SET status = 'released', ended_at = now()
           WHERE file_id = $1 AND generation_id = $2 AND protocol_epoch = $3 AND fencing_token = $4 AND status IN ('active', 'draining')`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString()],
        )
        if (ended.rowCount !== 1) throw new Error('Active generation changed during lease release.')
        const cleared = await client.query(
          `UPDATE app_collaboration_lease
           SET active_generation_id = NULL, protocol_epoch = NULL, lease_expires_at = NULL, renewed_at = NULL
           WHERE file_id = $1 AND active_generation_id = $2 AND protocol_epoch = $3 AND fencing_token = $4`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString()],
        )
        if (cleared.rowCount !== 1) throw new Error('Collaboration lease changed during release.')
        await client.query('COMMIT')
        return true
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },

    async getLease(fileId) {
      uuid(fileId, 'File id')
      const result = await pool.query<LeaseRow>(
        `SELECT ${leaseColumns} FROM app_collaboration_lease
         WHERE file_id = $1 AND active_generation_id IS NOT NULL AND lease_expires_at > now()`,
        [fileId],
      )
      return result.rows[0] ? leaseFromRow(result.rows[0]) : null
    },

    async bootstrapProjectionFromLegacy(input) {
      validateLeaseIdentity(input)
      positiveInteger(input.documentSchemaVersion, 'Document schema version')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (!await lockActiveRoom(client, input)) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'stale-fence' })
        }
        const existingResult = await client.query<ProjectionRow>(
          `SELECT ${projectionColumns} FROM app_collaboration_projection WHERE file_id = $1 FOR UPDATE`,
          [input.fileId],
        )
        const existing = existingResult.rows[0] ? projectionFromRow(existingResult.rows[0]) : null
        const replayCandidate = existing?.sequence === 0n
          && existing.authority === 'legacy-seed'
          && existing.generationId === input.generationId
          && existing.fencingToken === input.fencingToken
          && existing.documentSchemaVersion === input.documentSchemaVersion
        if (existing && !replayCandidate) {
          await client.query('ROLLBACK')
          return Object.freeze({
            status: 'existing-projection',
            projection: existing,
            cutoverAuthority: existing.authority === 'room' ? 'room-authority' : 'snapshot-seed',
          })
        }
        const sourceResult = await client.query<LegacyDocumentRow>(
          'SELECT file_id, document FROM app_file_document WHERE file_id = $1 FOR UPDATE',
          [input.fileId],
        )
        const source = sourceResult.rows[0]
        if (!source) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'source-not-found' })
        }
        if (source.document.fileId !== input.fileId) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'invalid-source', reason: 'file-identity' })
        }
        const persistedSourceJson = canonicalCollaborationJson(source.document)
        const sourceBaseline = cloneCollaborationJson(source.document) as LegacyDocumentRow['document']
        let sourceDocument = cloneCollaborationJson(source.document) as LegacyDocumentRow['document']
        if (sourceBaseline.schemaVersion !== input.documentSchemaVersion) {
          const migration = options.migrateLegacyDocument?.(sourceDocument, input.documentSchemaVersion)
          if (!migration || migration.status === 'unsupported') {
            await client.query('ROLLBACK')
            return Object.freeze({ status: 'invalid-source', reason: migration?.reason ?? 'schema-version' })
          }
          sourceDocument = cloneCollaborationJson(migration.document) as LegacyDocumentRow['document']
          if (sourceDocument.fileId !== input.fileId) {
            await client.query('ROLLBACK')
            return Object.freeze({ status: 'invalid-source', reason: 'file-identity' })
          }
          if (sourceDocument.schemaVersion !== input.documentSchemaVersion) {
            await client.query('ROLLBACK')
            return Object.freeze({ status: 'invalid-source', reason: 'schema-version' })
          }
        }
        const validation = options.validateLegacyDocument?.({
          sourceDocument: cloneCollaborationJson(sourceBaseline) as LegacyDocumentRow['document'],
          document: cloneCollaborationJson(sourceDocument) as LegacyDocumentRow['document'],
          targetSchemaVersion: input.documentSchemaVersion,
        })
        if (!validation || validation.status === 'invalid') {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'invalid-source', reason: validation?.reason ?? 'document-invalid' })
        }
        if (sourceBaseline.schemaVersion !== input.documentSchemaVersion) {
          const migratedDocumentJson = canonicalCollaborationJson(sourceDocument)
          const migrated = await client.query(
            `UPDATE app_file_document
             SET document = $2::jsonb
             WHERE file_id = $1 AND document = $3::jsonb`,
            [input.fileId, migratedDocumentJson, persistedSourceJson],
          )
          if (migrated.rowCount !== 1) throw new Error('Legacy document changed during collaboration migration.')
        }
        const documentJson = canonicalCollaborationJson(sourceDocument)
        const documentDigest = createHash('sha256').update(documentJson).digest('hex')
        if (existing) {
          await client.query('ROLLBACK')
          if (existing.documentDigest === documentDigest) {
            return Object.freeze({ status: 'replayed', projection: existing, cutoverAuthority: 'snapshot-seed' })
          }
          return Object.freeze({
            status: 'existing-projection',
            projection: existing,
            cutoverAuthority: existing.authority === 'room' ? 'room-authority' : 'snapshot-seed',
          })
        }
        const inserted = await client.query<ProjectionRow>(
          `INSERT INTO app_collaboration_projection
             (file_id, sequence, document_schema_version, document, document_digest, generation_id, fencing_token, authority)
           SELECT $1, 0, $5, $6::jsonb, $7, $2, $4, 'legacy-seed'
           FROM app_collaboration_lease AS lease
           WHERE lease.file_id = $1 AND lease.active_generation_id = $2 AND lease.protocol_epoch = $3
             AND lease.fencing_token = $4 AND lease.lease_expires_at > now()
           ON CONFLICT (file_id) DO NOTHING
           RETURNING ${projectionColumns}`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString(), input.documentSchemaVersion, documentJson, documentDigest],
        )
        const row = inserted.rows[0]
        if (!row) throw new Error('Active collaboration lease or projection changed during legacy bootstrap.')
        await client.query('COMMIT')
        return Object.freeze({ status: 'seeded', projection: projectionFromRow(row), cutoverAuthority: 'snapshot-seed' })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },

    async appendOperation(input) {
      validateAppendInput(input)
      const operationPayloadJson = canonicalCollaborationJson(input.operationPayload)
      const projectionDocumentJson = canonicalCollaborationJson(input.projection.document)
      const operationDigest = operationDigestFromPayloadJson(input.protocolEpoch, input.operationType, operationPayloadJson)
      const projectionDigest = createHash('sha256').update(projectionDocumentJson).digest('hex')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const authorization = await lockActiveRoomForAppend(client, input)
        if (authorization.status === 'stale-fence') {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'stale-fence' })
        }
        if (authorization.status === 'access-revoked') {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'access-revoked' })
        }
        if (authorization.status === 'access-conflict') {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'access-conflict', currentAccessEpoch: authorization.currentAccessEpoch })
        }

        const existing = await client.query<OperationRow>(
          `SELECT ${operationColumns} FROM app_collaboration_operation
           WHERE file_id = $1 AND client_id = $2 AND client_mutation_id = $3`,
          [input.fileId, input.clientId, input.clientMutationId],
        )
        if (existing.rows[0]) {
          await client.query('ROLLBACK')
          const operation = operationFromRow(existing.rows[0])
          return operation.subjectId === input.expectedSubjectId && operation.contentDigest === operationDigest
            ? Object.freeze({ status: 'replayed', operation })
            : Object.freeze({ status: 'mutation-conflict' })
        }

        const currentProjection = await client.query<ProjectionRow>(
          `SELECT ${projectionColumns} FROM app_collaboration_projection WHERE file_id = $1 FOR UPDATE`,
          [input.fileId],
        )
        const currentSequence = currentProjection.rows[0] ? integer(currentProjection.rows[0].sequence, 'projection sequence') : 0n
        if (currentSequence !== input.baseSequence) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'sequence-conflict', currentSequence })
        }

        const sequence = currentSequence + 1n
        const inserted = await client.query<OperationRow>(
          `INSERT INTO app_collaboration_operation
             (file_id, sequence, generation_id, protocol_epoch, fencing_token, subject_id, client_id,
              client_mutation_id, operation_type, operation_payload, content_digest)
           SELECT $1, $5, $2, $3, $4, $6, $7, $8, $9, $10::jsonb, $11
           FROM app_collaboration_lease AS lease
           WHERE lease.file_id = $1 AND lease.active_generation_id = $2 AND lease.protocol_epoch = $3
             AND lease.fencing_token = $4 AND lease.lease_expires_at > now()
           RETURNING ${operationColumns}`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString(), sequence.toString(), input.expectedSubjectId, input.clientId, input.clientMutationId, input.operationType, operationPayloadJson, operationDigest],
        )
        const operationRow = inserted.rows[0]
        if (!operationRow) throw new Error('Active collaboration lease was lost before operation append.')

        const projected = await client.query<ProjectionRow>(
          `INSERT INTO app_collaboration_projection
             (file_id, sequence, document_schema_version, document, document_digest, generation_id, fencing_token, authority)
           SELECT $1, $6, $7, $8::jsonb, $9, $2, $4, 'room'
           FROM app_collaboration_lease AS lease
           WHERE lease.file_id = $1 AND lease.active_generation_id = $2 AND lease.protocol_epoch = $3
             AND lease.fencing_token = $4 AND lease.lease_expires_at > now()
           ON CONFLICT (file_id) DO UPDATE
             SET sequence = EXCLUDED.sequence,
                 document_schema_version = EXCLUDED.document_schema_version,
                 document = EXCLUDED.document,
                 document_digest = EXCLUDED.document_digest,
                 generation_id = EXCLUDED.generation_id,
                 fencing_token = EXCLUDED.fencing_token,
                  authority = 'room',
                 updated_at = now()
           WHERE app_collaboration_projection.sequence = $5
           RETURNING ${projectionColumns}`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString(), input.baseSequence.toString(), sequence.toString(), input.projection.documentSchemaVersion, projectionDocumentJson, projectionDigest],
        )
        const projectionRow = projected.rows[0]
        if (!projectionRow) throw new Error('Projection changed during collaboration append.')
        await client.query('COMMIT')
        return Object.freeze({ status: 'committed', operation: operationFromRow(operationRow), projection: projectionFromRow(projectionRow) })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },

    async listOperationsAfter(fileId, sequence, limit) {
      uuid(fileId, 'File id')
      nonnegativeBigint(sequence, 'Sequence')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Operation limit must be between 1 and 1000.')
      const result = await pool.query<OperationRow>(
        `SELECT ${operationColumns} FROM app_collaboration_operation
         WHERE file_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`,
        [fileId, sequence.toString(), limit],
      )
      return Object.freeze(result.rows.map(operationFromRow))
    },

    async getProjection(fileId) {
      uuid(fileId, 'File id')
      const result = await pool.query<ProjectionRow>(`SELECT ${projectionColumns} FROM app_collaboration_projection WHERE file_id = $1`, [fileId])
      return result.rows[0] ? projectionFromRow(result.rows[0]) : null
    },

    async pruneCoveredOperations(input) {
      validateLeaseIdentity(input)
      nonnegativeBigint(input.throughSequence, 'Prune sequence')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (!await lockActiveRoom(client, input)) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'stale-fence' })
        }
        const headResult = await client.query<CheckpointHeadRow>(
          `SELECT head.checkpoint_sequence
           FROM app_collaboration_checkpoint_head AS head
           JOIN app_collaboration_checkpoint AS checkpoint
             ON checkpoint.file_id = head.file_id AND checkpoint.checkpoint_sequence = head.checkpoint_sequence
           WHERE head.file_id = $1
           FOR SHARE OF head, checkpoint`,
          [input.fileId],
        )
        const head = headResult.rows[0]
        if (!head) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'no-committed-checkpoint' })
        }
        const checkpointSequence = integer(head.checkpoint_sequence, 'checkpoint sequence')
        if (input.throughSequence > checkpointSequence) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'beyond-checkpoint', checkpointSequence })
        }
        const deleted = await client.query<DeletedCountRow>(
          `WITH active_checkpoint AS (
             SELECT head.checkpoint_sequence
             FROM app_collaboration_lease AS lease
             JOIN app_collaboration_checkpoint_head AS head ON head.file_id = lease.file_id
             JOIN app_collaboration_checkpoint AS checkpoint
               ON checkpoint.file_id = head.file_id AND checkpoint.checkpoint_sequence = head.checkpoint_sequence
             WHERE lease.file_id = $1 AND lease.active_generation_id = $2 AND lease.protocol_epoch = $3
               AND lease.fencing_token = $4 AND lease.lease_expires_at > now()
               AND head.checkpoint_sequence >= $5
           ), removed AS (
             DELETE FROM app_collaboration_operation AS operation
             USING active_checkpoint
             WHERE operation.file_id = $1
               AND operation.sequence <= $5
               AND operation.sequence <= active_checkpoint.checkpoint_sequence
             RETURNING operation.sequence
           )
           SELECT count(*)::bigint AS deleted_count FROM removed`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString(), input.throughSequence.toString()],
        )
        const row = deleted.rows[0]
        if (!row) throw new Error('Operation pruning did not return a count.')
        await client.query('COMMIT')
        return Object.freeze({ status: 'pruned', throughSequence: input.throughSequence, deletedCount: integer(row.deleted_count, 'deleted operation count') })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },

    async commitVerifiedCheckpoint(input) {
      validateCheckpointInput(input)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (!await lockActiveRoom(client, input)) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'stale-fence' })
        }
        const existingResult = await client.query<CheckpointRow>(
          `SELECT ${checkpointColumns} FROM app_collaboration_checkpoint WHERE file_id = $1 AND checkpoint_sequence = $2`,
          [input.fileId, input.sequence.toString()],
        )
        const existing = existingResult.rows[0] ? checkpointFromRow(existingResult.rows[0]) : null
        if (existing) {
          await client.query('ROLLBACK')
          return sameCheckpoint(existing, input)
            ? Object.freeze({ status: 'replayed', checkpoint: existing })
            : Object.freeze({ status: 'checkpoint-conflict' })
        }

        const projectionResult = await client.query<ProjectionRow>(
          `SELECT ${projectionColumns} FROM app_collaboration_projection WHERE file_id = $1 FOR UPDATE`,
          [input.fileId],
        )
        const projection = projectionResult.rows[0] ? projectionFromRow(projectionResult.rows[0]) : null
        if (!projection
          || projection.authority !== 'room'
          || projection.generationId !== input.generationId
          || projection.fencingToken !== input.fencingToken
          || projection.sequence !== input.sequence
          || projection.documentDigest !== input.documentDigest
          || projection.documentSchemaVersion !== input.documentSchemaVersion) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'projection-conflict', currentSequence: projection?.sequence ?? null })
        }

        const inserted = await client.query<CheckpointRow>(
          `INSERT INTO app_collaboration_checkpoint
             (file_id, checkpoint_sequence, object_key, object_digest, document_digest, compressed_bytes,
              document_schema_version, generation_id, fencing_token)
           SELECT $1, $5, $6, $7, $8, $9, $10, $2, $4
           FROM app_collaboration_lease AS lease
           WHERE lease.file_id = $1 AND lease.active_generation_id = $2 AND lease.protocol_epoch = $3
             AND lease.fencing_token = $4 AND lease.lease_expires_at > now()
           RETURNING ${checkpointColumns}`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString(), input.sequence.toString(), input.objectKey, input.objectDigest, input.documentDigest, input.compressedBytes.toString(), input.documentSchemaVersion],
        )
        const row = inserted.rows[0]
        if (!row) throw new Error('Active collaboration lease was lost before checkpoint commit.')
        const checkpoint = checkpointFromRow(row)

        const advanced = await client.query(
          `INSERT INTO app_collaboration_checkpoint_head
             (file_id, checkpoint_sequence)
           SELECT $1, $5
           FROM app_collaboration_lease AS lease
           WHERE lease.file_id = $1 AND lease.active_generation_id = $2 AND lease.protocol_epoch = $3
             AND lease.fencing_token = $4 AND lease.lease_expires_at > now()
           ON CONFLICT (file_id) DO UPDATE
             SET checkpoint_sequence = EXCLUDED.checkpoint_sequence,
                 updated_at = now()
           WHERE app_collaboration_checkpoint_head.checkpoint_sequence <= EXCLUDED.checkpoint_sequence
           RETURNING file_id`,
          [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString(), input.sequence.toString()],
        )
        if (!advanced.rowCount) throw new Error('Checkpoint head did not advance.')
        await client.query('COMMIT')
        return Object.freeze({ status: 'committed', checkpoint })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },

    async getCheckpoint(fileId) {
      uuid(fileId, 'File id')
      const result = await pool.query<CheckpointRow>(
        `SELECT ${checkpointColumns.split(', ').map(column => `checkpoint.${column}`).join(', ')}
         FROM app_collaboration_checkpoint_head AS head
         JOIN app_collaboration_checkpoint AS checkpoint
           ON checkpoint.file_id = head.file_id AND checkpoint.checkpoint_sequence = head.checkpoint_sequence
         WHERE head.file_id = $1`,
        [fileId],
      )
      return result.rows[0] ? checkpointFromRow(result.rows[0]) : null
    },
  }
  return Object.freeze(persistence)
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Collaboration JSON cannot contain a non-finite number.')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error(`Collaboration JSON cannot contain ${typeof value} values.`)
  if (seen.has(value)) throw new Error('Collaboration JSON cannot contain a cycle.')
  seen.add(value)
  try {
    if (Array.isArray(value)) return canonicalizeArray(value, seen)
    if (isProxy(value)) throw new Error('Collaboration JSON cannot contain proxy objects.')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Collaboration JSON objects must use a plain prototype.')
    const entries: string[] = []
    for (const key of Reflect.ownKeys(value).sort(comparePropertyKeys)) {
      if (typeof key === 'symbol') throw new Error('Collaboration JSON cannot contain symbol keys.')
      if (dangerousJsonKeys.has(key)) throw new Error(`Collaboration JSON cannot contain the ${key} key.`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) throw new Error('Collaboration JSON property metadata changed during validation.')
      if ('get' in descriptor || 'set' in descriptor) throw new Error('Collaboration JSON cannot contain accessor properties.')
      if (!descriptor.enumerable) throw new Error('Collaboration JSON cannot contain non-enumerable properties.')
      entries.push(`${JSON.stringify(key)}:${canonicalize(descriptor.value, seen)}`)
    }
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function canonicalizeArray(value: readonly unknown[], seen: WeakSet<object>): string {
  if (isProxy(value)) throw new Error('Collaboration JSON cannot contain proxy objects.')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.value !== value.length) throw new Error('Collaboration JSON array length is invalid.')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error('Collaboration JSON cannot contain symbol keys.')
    if (key === 'length') continue
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) throw new Error('Collaboration JSON arrays cannot contain named properties.')
  }
  const items: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor) throw new Error('Collaboration JSON arrays cannot be sparse.')
    if ('get' in descriptor || 'set' in descriptor) throw new Error('Collaboration JSON cannot contain accessor properties.')
    items.push(canonicalize(descriptor.value, seen))
  }
  return `[${items.join(',')}]`
}

function validateRoomIdentity(input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number }>): void {
  uuid(input.fileId, 'File id')
  uuid(input.generationId, 'Generation id')
  positiveInteger(input.protocolEpoch, 'Protocol epoch')
}

function validateLeaseIdentity(input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number; fencingToken: bigint }>): void {
  validateRoomIdentity(input)
  positiveBigint(input.fencingToken, 'Fencing token')
}

function validateAppendInput(input: Parameters<CollaborationPersistence['appendOperation']>[0]): void {
  validateLeaseIdentity(input)
  boundedText(input.expectedSubjectId, 'Expected subject id', 128)
  positiveBigint(input.expectedAccessEpoch, 'Expected access epoch')
  boundedText(input.clientId, 'Client id', 128)
  boundedText(input.clientMutationId, 'Client mutation id', 128)
  boundedText(input.operationType, 'Operation type', 128)
  nonnegativeBigint(input.baseSequence, 'Base sequence')
  positiveInteger(input.projection.documentSchemaVersion, 'Document schema version')
  requirePayloadObject(input.operationPayload, 'Operation payload')
  requirePayloadObject(input.projection.document, 'Projection document')
}

type AppendAuthorizationResult =
  | Readonly<{ status: 'authorized' }>
  | Readonly<{ status: 'access-revoked' }>
  | Readonly<{ status: 'access-conflict'; currentAccessEpoch: bigint }>
  | Readonly<{ status: 'stale-fence' }>

type AppendFileAuthorizationRow = QueryResultRow & Readonly<{
  id: string
  owner_user_id: string
  access_epoch: string | number | bigint
}>

async function lockActiveRoomForAppend(
  client: PoolClient,
  input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number; fencingToken: bigint; expectedSubjectId: string; expectedAccessEpoch: bigint }>,
): Promise<AppendAuthorizationResult> {
  const file = await client.query<AppendFileAuthorizationRow>(
    'SELECT id, owner_user_id, access_epoch FROM app_file WHERE id = $1 FOR UPDATE',
    [input.fileId],
  )
  const lease = await client.query(
    `SELECT file_id FROM app_collaboration_lease
     WHERE file_id = $1 AND active_generation_id = $2 AND protocol_epoch = $3
       AND fencing_token = $4 AND lease_expires_at > now()
     FOR UPDATE`,
    [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString()],
  )
  if (file.rowCount !== 1 || lease.rowCount !== 1) return Object.freeze({ status: 'stale-fence' })
  const current = file.rows[0]!
  if (current.owner_user_id !== input.expectedSubjectId) return Object.freeze({ status: 'access-revoked' })
  const currentAccessEpoch = integer(current.access_epoch, 'access epoch')
  return currentAccessEpoch === input.expectedAccessEpoch
    ? Object.freeze({ status: 'authorized' })
    : Object.freeze({ status: 'access-conflict', currentAccessEpoch })
}

function validateCheckpointInput(input: Parameters<CollaborationPersistence['commitVerifiedCheckpoint']>[0]): void {
  validateLeaseIdentity(input)
  nonnegativeBigint(input.sequence, 'Checkpoint sequence')
  boundedText(input.objectKey, 'Checkpoint object key', 1_024)
  digest(input.objectDigest, 'Checkpoint object digest')
  digest(input.documentDigest, 'Checkpoint document digest')
  positiveBigint(input.compressedBytes, 'Compressed byte count')
  positiveInteger(input.documentSchemaVersion, 'Document schema version')
}

async function lockActiveRoom(client: PoolClient, input: Readonly<{ fileId: string; generationId: string; protocolEpoch: number; fencingToken: bigint }>): Promise<boolean> {
  const file = await client.query('SELECT id FROM app_file WHERE id = $1 FOR UPDATE', [input.fileId])
  if (file.rowCount !== 1) return false
  const lease = await client.query(
    `SELECT file_id FROM app_collaboration_lease
     WHERE file_id = $1 AND active_generation_id = $2 AND protocol_epoch = $3
       AND fencing_token = $4 AND lease_expires_at > now()
     FOR UPDATE`,
    [input.fileId, input.generationId, input.protocolEpoch, input.fencingToken.toString()],
  )
  return lease.rowCount === 1
}

function sameCheckpoint(existing: CollaborationCheckpoint, input: Parameters<CollaborationPersistence['commitVerifiedCheckpoint']>[0]): boolean {
  return existing.generationId === input.generationId
    && existing.fencingToken === input.fencingToken
    && existing.objectKey === input.objectKey
    && existing.objectDigest === input.objectDigest
    && existing.documentDigest === input.documentDigest
    && existing.compressedBytes === input.compressedBytes
    && existing.documentSchemaVersion === input.documentSchemaVersion
}

function comparePropertyKeys(left: string | symbol, right: string | symbol): number {
  const leftText = String(left)
  const rightText = String(right)
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
}

function requirePayloadObject(value: unknown, name: string): asserts value is CollaborationPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object.`)
}

function operationDigestFromPayloadJson(protocolEpoch: number, operationType: string, operationPayloadJson: string): string {
  const content = `{"operationPayload":${operationPayloadJson},"operationType":${JSON.stringify(operationType)},"protocolEpoch":${protocolEpoch}}`
  return createHash('sha256').update(content).digest('hex')
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK') }
  catch (error) { console.error(JSON.stringify({ level: 'error', event: 'collaboration_database_rollback_failed', message: error instanceof Error ? error.message : String(error) })) }
}
