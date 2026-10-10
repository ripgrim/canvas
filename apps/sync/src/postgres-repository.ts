import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import { validateHostedFileDocument } from '@canvas/cloud-document'
import { parseClientSyncMessage, syncProtocolVersion } from '@canvas/sync-protocol'
import type { FileEdit, JsonObject, PersistedFileEditBatch } from '@canvas/sync-protocol'
import type { CommitFileEditInput, CommitFileEditResult, OpenFileSyncResult, SyncRepository } from './contracts.js'
import { applyFileEdits } from './json-edits.js'

type FileRow = QueryResultRow & Readonly<{
  owner_user_id: string
  head_revision: string | number
  document_revision: string | number
  document: JsonObject
}>

type DocumentRow = QueryResultRow & Readonly<{
  owner_user_id: string
  document_revision: string | number
  document: JsonObject
}>

type HeadRow = QueryResultRow & Readonly<{
  head_revision: string | number
}>

type BatchRow = QueryResultRow & Readonly<{
  file_id: string
  owner_user_id: string
  subject_id: string
  client_id: string
  client_mutation_id: string
  base_revision: string | number
  server_revision: string | number
  edits: unknown
  committed_at: Date | string
}>

type ApplyEdits = (document: JsonObject, edits: readonly FileEdit[]) => JsonObject

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const identity = /^[A-Za-z0-9:._-]{1,128}$/

function revision(value: string | number): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Database returned an invalid sync revision.')
  return result
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new Error('Database returned an invalid commit time.')
  return date.toISOString()
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function checkedEdits(fileId: string, clientId: string, clientMutationId: string, baseRevision: number, edits: unknown): readonly FileEdit[] {
  const message = parseClientSyncMessage(JSON.stringify({ type: 'file.edit.batch', protocolVersion: syncProtocolVersion, fileId, clientId, clientMutationId, baseRevision, edits }))
  if (message.type !== 'file.edit.batch') throw new Error('Database returned an invalid edit batch.')
  return message.edits
}

function batchFromRow(row: BatchRow, ownerUserId: string): PersistedFileEditBatch {
  const baseRevision = revision(row.base_revision)
  const serverRevision = revision(row.server_revision)
  if (row.owner_user_id !== ownerUserId || serverRevision !== baseRevision + 1 || !identity.test(row.subject_id)) throw new Error('Database returned a malformed edit batch.')
  return Object.freeze({
    fileId: row.file_id,
    subjectId: row.subject_id,
    clientId: row.client_id,
    clientMutationId: row.client_mutation_id,
    baseRevision,
    serverRevision,
    edits: checkedEdits(row.file_id, row.client_id, row.client_mutation_id, baseRevision, row.edits),
    committedAt: iso(row.committed_at),
  })
}

function validateDocument(fileId: string, serverRevision: number, input: JsonObject): JsonObject {
  const candidate = structuredClone(input)
  const validated = validateHostedFileDocument(candidate)
  if (validated.fileId !== fileId || validated.revision !== serverRevision) throw new Error('Document identity does not match its sync record.')
  return validated as unknown as JsonObject
}

function validateNextDocument(fileId: string, serverRevision: number, input: JsonObject): JsonObject {
  const candidate = structuredClone(input)
  candidate.revision = serverRevision
  return validateDocument(fileId, serverRevision, candidate)
}

function validateInput(input: CommitFileEditInput): void {
  if (!uuid.test(input.fileId) || !identity.test(input.subjectId)) throw new Error('Invalid sync commit identity.')
  checkedEdits(input.fileId, input.clientId, input.clientMutationId, input.baseRevision, input.edits)
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK') } catch { /* Preserve the original transaction error. */ }
}

export class PostgresSyncRepository implements SyncRepository {
  readonly #pool: Pool
  readonly #historyLimit: number
  readonly #apply: ApplyEdits

  constructor(pool: Pool, options: Readonly<{ historyLimit?: number; apply?: ApplyEdits }> = {}) {
    this.#pool = pool
    this.#historyLimit = options.historyLimit ?? 1_000
    this.#apply = options.apply ?? applyFileEdits
    if (!Number.isSafeInteger(this.#historyLimit) || this.#historyLimit < 1 || this.#historyLimit > 100_000) throw new Error('History limit must be an integer between 1 and 100000.')
  }

  async open(fileId: string, afterRevision?: number): Promise<OpenFileSyncResult> {
    if (!uuid.test(fileId)) return { status: 'not_found' }
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) throw new Error('Invalid requested revision.')
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const result = await client.query<FileRow>(`SELECT file.owner_user_id, file.head_revision, document.revision AS document_revision, document.document
        FROM app_file AS file
        INNER JOIN app_file_document AS document ON document.file_id = file.id AND document.owner_user_id = file.owner_user_id
        WHERE file.id = $1`, [fileId])
      const row = result.rows[0]
      if (!row) { await client.query('COMMIT'); return { status: 'not_found' } }
      const serverRevision = revision(row.head_revision)
      if (revision(row.document_revision) !== serverRevision) throw new Error('File head and document revisions disagree.')
      const document = validateDocument(fileId, serverRevision, row.document)
      if (afterRevision === undefined) { await client.query('COMMIT'); return { status: 'payload', payload: { fileId, serverRevision, document }, reason: 'bootstrap' } }
      if (afterRevision > serverRevision) { await client.query('COMMIT'); return { status: 'ahead', serverRevision } }
      if (afterRevision === serverRevision) { await client.query('COMMIT'); return { status: 'ready', fileId, serverRevision } }
      const batches = await this.#changes(client, fileId, row.owner_user_id, afterRevision, serverRevision)
      await client.query('COMMIT')
      return batches
        ? { status: 'catchup', fileId, fromRevision: afterRevision, serverRevision, batches }
        : { status: 'payload', payload: { fileId, serverRevision, document }, reason: 'history_unavailable' }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async commit(input: CommitFileEditInput): Promise<CommitFileEditResult> {
    validateInput(input)
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const lockedDocument = await client.query<DocumentRow>(`SELECT owner_user_id, revision AS document_revision, document
        FROM app_file_document
        WHERE file_id = $1 AND owner_user_id = $2
        FOR UPDATE`, [input.fileId, input.subjectId])
      const documentRow = lockedDocument.rows[0]
      if (!documentRow) { await client.query('COMMIT'); return { status: 'not_found' } }
      const lockedFile = await client.query<HeadRow>(`SELECT head_revision
        FROM app_file
        WHERE id = $1 AND owner_user_id = $2
        FOR UPDATE`, [input.fileId, input.subjectId])
      const fileRow = lockedFile.rows[0]
      if (!fileRow) throw new Error('File document has no matching owner-scoped file record.')
      const serverRevision = revision(fileRow.head_revision)
      if (revision(documentRow.document_revision) !== serverRevision) throw new Error('File head and document revisions disagree.')
      const currentDocument = validateDocument(input.fileId, serverRevision, documentRow.document)

      const replay = await client.query<BatchRow>(`SELECT file_id, owner_user_id, subject_id, client_id, client_mutation_id, base_revision, server_revision, edits, committed_at
        FROM app_file_edit_batch WHERE file_id = $1 AND owner_user_id = $2 AND subject_id = $2 AND client_mutation_id = $3`, [input.fileId, input.subjectId, input.clientMutationId])
      const existing = replay.rows[0] ? batchFromRow(replay.rows[0], documentRow.owner_user_id) : null
      if (existing) {
        await client.query('COMMIT')
        return existing.clientId === input.clientId && existing.baseRevision === input.baseRevision && canonical(existing.edits) === canonical(input.edits)
          ? { status: 'duplicate', batch: existing }
          : { status: 'mutation_id_reused', serverRevision }
      }

      if (input.baseRevision !== serverRevision) {
        const batches = await this.#changes(client, input.fileId, documentRow.owner_user_id, input.baseRevision, serverRevision)
        await client.query('COMMIT')
        return { status: 'conflict', serverRevision, batches }
      }

      let document: JsonObject
      try { document = validateNextDocument(input.fileId, serverRevision + 1, this.#apply(currentDocument, input.edits)) } catch {
        await client.query('ROLLBACK')
        return { status: 'invalid_edit', serverRevision }
      }
      const inserted = await client.query<BatchRow>(`INSERT INTO app_file_edit_batch
        (file_id, owner_user_id, subject_id, client_id, client_mutation_id, base_revision, server_revision, edits)
        VALUES ($1, $2, $2, $3, $4, $5, $6, $7::jsonb)
        RETURNING file_id, owner_user_id, subject_id, client_id, client_mutation_id, base_revision, server_revision, edits, committed_at`,
      [input.fileId, documentRow.owner_user_id, input.clientId, input.clientMutationId, serverRevision, serverRevision + 1, JSON.stringify(input.edits)])
      const savedDocument = await client.query('UPDATE app_file_document SET revision = $3, document = $4::jsonb, updated_at = now() WHERE file_id = $1 AND owner_user_id = $2', [input.fileId, documentRow.owner_user_id, serverRevision + 1, JSON.stringify(document)])
      const savedFile = await client.query('UPDATE app_file SET head_revision = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2', [input.fileId, documentRow.owner_user_id, serverRevision + 1])
      if (savedDocument.rowCount !== 1 || savedFile.rowCount !== 1) throw new Error('Locked sync records changed ownership during commit.')
      await client.query('DELETE FROM app_file_edit_batch WHERE file_id = $1 AND owner_user_id = $2 AND server_revision <= $3', [input.fileId, documentRow.owner_user_id, serverRevision + 1 - this.#historyLimit])
      await client.query('COMMIT')
      return { status: 'applied', batch: batchFromRow(inserted.rows[0]!, documentRow.owner_user_id) }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async #changes(client: PoolClient, fileId: string, ownerUserId: string, afterRevision: number, serverRevision: number): Promise<readonly PersistedFileEditBatch[] | null> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > serverRevision || serverRevision - afterRevision > this.#historyLimit) return null
    const result = await client.query<BatchRow>(`SELECT file_id, owner_user_id, subject_id, client_id, client_mutation_id, base_revision, server_revision, edits, committed_at
      FROM app_file_edit_batch WHERE file_id = $1 AND owner_user_id = $2 AND server_revision > $3 AND server_revision <= $4
      ORDER BY server_revision ASC LIMIT $5`, [fileId, ownerUserId, afterRevision, serverRevision, this.#historyLimit + 1])
    const batches = result.rows.map(row => batchFromRow(row, ownerUserId))
    let expected = afterRevision
    for (const batch of batches) { if (batch.baseRevision !== expected || batch.serverRevision !== expected + 1) return null; expected = batch.serverRevision }
    return expected === serverRevision ? Object.freeze(batches) : null
  }
}

export function createPostgresSyncPool(connectionString: string): Pool {
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.')
  return new Pool({ connectionString: url.toString(), max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })
}
