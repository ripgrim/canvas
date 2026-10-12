import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import type { CloudFile, CloudFileDocument, CloudFileSummary, CloudProject, ControlPlaneStore, DocumentSaveResult, FileAccessAuthorization, FileShare, FileThumbnailMetadata, InternalFileThumbnail, JsonValue, LegacyDocumentExternalizationResult, SharedFile, ThumbnailCaptureJob, ThumbnailUpdateResult } from './index.js'
import { emptyCanvasDocument } from './index.js'

type ProjectRow = QueryResultRow & Readonly<{ id: string; name: string; created_at: Date | string; updated_at: Date | string }>
type FileRow = QueryResultRow & Readonly<{ id: string; project_id: string | null; name: string; head_revision: string | number; thumbnail_key: string | null; thumbnail_etag: string | null; created_at: Date | string; updated_at: Date | string }>
type DocumentRow = QueryResultRow & Readonly<{ file_id: string; revision: unknown; document: Record<string, JsonValue>; updated_at: Date | string }>
type ProjectionAuthorityRow = QueryResultRow & Readonly<{ authority: 'legacy-seed' | 'room' }>
type ThumbnailRow = QueryResultRow & Readonly<{ id: string; head_revision: string | number; thumbnail_key: string | null; thumbnail_etag: string | null }>
type InternalThumbnailRow = ThumbnailRow & Readonly<{ owner_user_id: string }>
type CaptureJobRow = QueryResultRow & Readonly<{ id: string; file_id: string; revision: string | number; lease_id: string; lease_expires_at: Date | string; attempts: number }>
type ShareRow = QueryResultRow & Readonly<{ file_id: string; access: 'private' | 'view'; updated_at: Date | string }>
type AccessRow = QueryResultRow & Readonly<{ file_id: string; role: 'owner' | 'viewer'; access_epoch: string | number | bigint }>
type LockedShareRow = QueryResultRow & Readonly<{ file_id: string; access: 'private' | 'view'; updated_at: Date | string; access_epoch: string | number | bigint }>
type SharedFileRow = QueryResultRow & Readonly<{ id: string; name: string; head_revision: unknown; file_updated_at: Date | string; revision: unknown; document: Record<string, JsonValue>; document_updated_at: Date | string }>

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const maxSignedInt64 = 9_223_372_036_854_775_807n
const safeInt64 = (value: string | number | bigint, name: string): bigint => {
  const parsed = typeof value === 'bigint' ? value : BigInt(value)
  if (parsed < 0n || parsed > maxSignedInt64) throw new Error(`Database returned an invalid ${name}.`)
  return parsed
}
const safeRevision = (value: unknown) => {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Database returned an invalid revision.')
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Database returned an invalid revision.')
  return revision
}
const projectFromRow = (row: ProjectRow): CloudProject => Object.freeze({ id: row.id, name: row.name, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const fileFromRow = (row: FileRow): CloudFile => Object.freeze({ id: row.id, projectId: row.project_id, name: row.name, headRevision: safeRevision(row.head_revision), thumbnailKey: row.thumbnail_key ? `thumbnails/${row.id}/thumbnail.avif` : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const documentFromRow = (row: DocumentRow): CloudFileDocument => Object.freeze({ fileId: row.file_id, revision: safeRevision(row.revision), document: Object.freeze(row.document), updatedAt: iso(row.updated_at) })
const thumbnailFromRow = (row: ThumbnailRow): FileThumbnailMetadata => Object.freeze({ fileId: row.id, revision: safeRevision(row.head_revision), thumbnailKey: row.thumbnail_key, thumbnailEtag: row.thumbnail_etag })
const shareFromRow = (row: ShareRow): FileShare => Object.freeze({ fileId: row.file_id, access: row.access, updatedAt: iso(row.updated_at) })
const accessFromRow = (row: AccessRow, subjectUserId: string): FileAccessAuthorization => Object.freeze({ fileId: row.file_id, subjectUserId, role: row.role, accessEpoch: safeInt64(row.access_epoch, 'access epoch') })

const projectColumns = 'id, name, created_at, updated_at'
const fileColumns = 'id, project_id, name, head_revision, thumbnail_key, thumbnail_etag, created_at, updated_at'
const projectedRevision = "CASE WHEN jsonb_typeof(projection.document -> 'revision') = 'number' THEN projection.document ->> 'revision' ELSE NULL END"
const canonicalDocumentColumns = `legacy.file_id,
  CASE WHEN projection.authority = 'room' THEN ${projectedRevision} ELSE legacy.revision::text END AS revision,
  CASE WHEN projection.authority = 'room' THEN projection.document ELSE legacy.document END AS document,
  CASE WHEN projection.authority = 'room' THEN projection.updated_at ELSE legacy.updated_at END AS updated_at`

export function createPostgresPool(connectionString: string): Pool {
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.')
  return new Pool({ connectionString: url.toString(), max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })
}

export function createPostgresControlPlane(pool: Pool): ControlPlaneStore {
  const store: ControlPlaneStore = {
    async listProjects(ownerUserId) {
      const result = await pool.query<ProjectRow>(`SELECT ${projectColumns} FROM app_project WHERE owner_user_id = $1 ORDER BY updated_at DESC, id`, [ownerUserId])
      return Object.freeze(result.rows.map(projectFromRow))
    },
    async createProject(ownerUserId, name) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const id = randomUUID()
        const result = await client.query<ProjectRow>(`INSERT INTO app_project (id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING ${projectColumns}`, [id, ownerUserId, name])
        await client.query("INSERT INTO app_project_member (project_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ownerUserId])
        await client.query('COMMIT')
        return projectFromRow(result.rows[0]!)
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },
    async getProject(ownerUserId, projectId) {
      const result = await pool.query<ProjectRow>(`SELECT ${projectColumns} FROM app_project WHERE id = $1 AND owner_user_id = $2`, [projectId, ownerUserId])
      return result.rows[0] ? projectFromRow(result.rows[0]) : null
    },
    async listFiles(ownerUserId) {
      const result = await pool.query<FileRow>(`SELECT ${fileColumns} FROM app_file WHERE owner_user_id = $1 ORDER BY updated_at DESC, id`, [ownerUserId])
      return Object.freeze(result.rows.map(fileFromRow))
    },
    async createFile(ownerUserId, name, projectId) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (projectId) {
          const project = await client.query('SELECT id FROM app_project WHERE id = $1 AND owner_user_id = $2 FOR SHARE', [projectId, ownerUserId])
          if (!project.rowCount) throw new Error('Project was not found.')
        }
        const id = randomUUID()
        const result = await client.query<FileRow>(`INSERT INTO app_file (id, project_id, owner_user_id, name) VALUES ($1, $2, $3, $4) RETURNING ${fileColumns}`, [id, projectId, ownerUserId, name])
        await client.query('INSERT INTO app_file_document (file_id, owner_user_id, revision, document) VALUES ($1, $2, 0, $3::jsonb)', [id, ownerUserId, JSON.stringify(emptyCanvasDocument(id, randomUUID(), randomUUID()))])
        await client.query("INSERT INTO app_thumbnail_capture_job (id, file_id, revision, status) VALUES ($1, $2, 0, 'queued') ON CONFLICT (file_id, revision) DO NOTHING", [randomUUID(), id])
        await client.query('COMMIT')
        return fileFromRow(result.rows[0]!)
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },
    async getFile(ownerUserId, fileId) {
      const result = await pool.query<FileRow>(`SELECT ${fileColumns} FROM app_file WHERE id = $1 AND owner_user_id = $2`, [fileId, ownerUserId])
      return result.rows[0] ? fileFromRow(result.rows[0]) : null
    },
    async getFileThumbnail(ownerUserId, fileId) {
      const result = await pool.query<ThumbnailRow>('SELECT id, head_revision, thumbnail_key, thumbnail_etag FROM app_file WHERE id = $1 AND owner_user_id = $2', [fileId, ownerUserId])
      return result.rows[0] ? thumbnailFromRow(result.rows[0]) : null
    },
    async getFileThumbnailForCapture(fileId) {
      const result = await pool.query<InternalThumbnailRow>('SELECT id, owner_user_id, head_revision, thumbnail_key, thumbnail_etag FROM app_file WHERE id = $1', [fileId])
      const row = result.rows[0]
      return row ? Object.freeze({ ...thumbnailFromRow(row), ownerUserId: row.owner_user_id }) satisfies InternalFileThumbnail : null
    },
    async getFileDocument(ownerUserId, fileId) {
      const result = await pool.query<DocumentRow>(
        `SELECT ${canonicalDocumentColumns}
         FROM app_file_document AS legacy
         LEFT JOIN app_collaboration_projection AS projection ON projection.file_id = legacy.file_id
         WHERE legacy.file_id = $1 AND legacy.owner_user_id = $2`,
        [fileId, ownerUserId],
      )
      return result.rows[0] ? documentFromRow(result.rows[0]) : null
    },
    async getFileDocumentForCapture(fileId) {
      const result = await pool.query<DocumentRow>(
        `SELECT ${canonicalDocumentColumns}
         FROM app_file_document AS legacy
         LEFT JOIN app_collaboration_projection AS projection ON projection.file_id = legacy.file_id
         WHERE legacy.file_id = $1`,
        [fileId],
      )
      return result.rows[0] ? documentFromRow(result.rows[0]) : null
    },
    async getFileShare(ownerUserId, fileId) {
      const result = await pool.query<ShareRow>("SELECT f.id AS file_id, COALESCE(s.access, 'private') AS access, COALESCE(s.updated_at, f.updated_at) AS updated_at FROM app_file f LEFT JOIN app_file_share s ON s.file_id = f.id WHERE f.id = $1 AND f.owner_user_id = $2", [fileId, ownerUserId])
      return result.rows[0] ? shareFromRow(result.rows[0]) : null
    },
    async setFileShare(ownerUserId, fileId, access) {
      return setShareAccess(pool, ownerUserId, fileId, access)
    },
    async resolveFileAccess(subjectUserId, fileId) {
      if (subjectUserId.length < 1 || subjectUserId.length > 128) throw new Error('Subject user id must contain between 1 and 128 characters.')
      const result = await pool.query<AccessRow>(
        `SELECT file.id AS file_id,
                CASE WHEN file.owner_user_id = $1 THEN 'owner' ELSE 'viewer' END AS role,
                file.access_epoch
         FROM app_file AS file
         LEFT JOIN app_file_share AS share ON share.file_id = file.id AND share.owner_user_id = file.owner_user_id
         WHERE file.id = $2
           AND (file.owner_user_id = $1 OR share.access = 'view')`,
        [subjectUserId, fileId],
      )
      return result.rows[0] ? accessFromRow(result.rows[0], subjectUserId) : null
    },
    async getSharedFile(fileId) {
      const result = await pool.query<SharedFileRow>(
        `SELECT file.id, file.name,
                CASE WHEN projection.authority = 'room' THEN ${projectedRevision} ELSE file.head_revision::text END AS head_revision,
                file.updated_at AS file_updated_at,
                CASE WHEN projection.authority = 'room' THEN ${projectedRevision} ELSE legacy.revision::text END AS revision,
                CASE WHEN projection.authority = 'room' THEN projection.document ELSE legacy.document END AS document,
                CASE WHEN projection.authority = 'room' THEN projection.updated_at ELSE legacy.updated_at END AS document_updated_at
         FROM app_file_share AS share
         JOIN app_file AS file ON file.id = share.file_id AND file.owner_user_id = share.owner_user_id
         JOIN app_file_document AS legacy ON legacy.file_id = file.id AND legacy.owner_user_id = file.owner_user_id
         LEFT JOIN app_collaboration_projection AS projection ON projection.file_id = file.id
         WHERE share.file_id = $1 AND share.access = 'view'`,
        [fileId],
      )
      const row = result.rows[0]
      if (!row) return null
      return Object.freeze({
        file: Object.freeze({ id: row.id, name: row.name, headRevision: safeRevision(row.head_revision), updatedAt: iso(row.file_updated_at) }),
        document: Object.freeze({ fileId: row.id, revision: safeRevision(row.revision), document: Object.freeze(row.document), updatedAt: iso(row.document_updated_at) }),
      }) satisfies SharedFile
    },
    async externalizeLegacyFileDocument(fileId, expectedRevision, source, document) {
      return externalizeLegacyDocument(pool, fileId, expectedRevision, source, document)
    },
    async saveFileDocument(ownerUserId, fileId, expectedRevision, document) {
      return saveDocument(pool, ownerUserId, fileId, expectedRevision, document)
    },
    async setFileThumbnail(ownerUserId, fileId, expectedRevision, thumbnailKey, thumbnailEtag) {
      return setThumbnail(pool, ownerUserId, fileId, expectedRevision, thumbnailKey, thumbnailEtag)
    },
    async setFileThumbnailForCapture(fileId, expectedRevision, thumbnailKey, thumbnailEtag) {
      return setThumbnailForCapture(pool, fileId, expectedRevision, thumbnailKey, thumbnailEtag)
    },
    async claimThumbnailCaptureJob(now, leaseExpiresAt) { return claimCaptureJob(pool, now, leaseExpiresAt) },
    async completeThumbnailCaptureJob(jobId, leaseId, completedAt) {
      const result = await pool.query("UPDATE app_thumbnail_capture_job SET status = 'completed', lease_id = NULL, lease_expires_at = NULL, completed_at = $3 WHERE id = $1 AND status = 'leased' AND lease_id = $2", [jobId, leaseId, completedAt])
      return result.rowCount === 1
    },
    async releaseThumbnailCaptureJob(jobId, leaseId) {
      const result = await pool.query("UPDATE app_thumbnail_capture_job SET status = 'queued', lease_id = NULL, lease_expires_at = NULL WHERE id = $1 AND status = 'leased' AND lease_id = $2", [jobId, leaseId])
      return result.rowCount === 1
    },
  }
  return Object.freeze(store)
}

async function externalizeLegacyDocument(
  pool: Pool,
  fileId: string,
  expectedRevision: number,
  source: Readonly<Record<string, JsonValue>>,
  document: Readonly<Record<string, JsonValue>>,
): Promise<LegacyDocumentExternalizationResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query<DocumentRow>('SELECT file_id, revision, document, updated_at FROM app_file_document WHERE file_id = $1 FOR UPDATE', [fileId])
    const current = currentResult.rows[0]
    if (!current) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'not-found' })
    }
    const revision = safeRevision(current.revision)
    if (revision !== expectedRevision) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'conflict', currentRevision: revision })
    }
    if (equalJson(current.document, document)) {
      await client.query('COMMIT')
      return Object.freeze({ status: 'unchanged', document: documentFromRow(current) })
    }
    if (!equalJson(current.document, source)) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'conflict', currentRevision: revision })
    }
    const authority = await client.query<ProjectionAuthorityRow>('SELECT authority FROM app_collaboration_projection WHERE file_id = $1', [fileId])
    if (authority.rows[0]) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'collaboration-authoritative' })
    }
    const savedResult = await client.query<DocumentRow>(
      'UPDATE app_file_document SET document = $3::jsonb WHERE file_id = $1 AND revision = $2 AND document = $4::jsonb RETURNING file_id, revision, document, updated_at',
      [fileId, expectedRevision, JSON.stringify(document), JSON.stringify(source)],
    )
    const saved = savedResult.rows[0]
    if (!saved) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'conflict', currentRevision: revision })
    }
    await client.query('COMMIT')
    return Object.freeze({ status: 'saved', document: documentFromRow(saved) })
  } catch (error) {
    await rollback(client)
    throw error
  } finally {
    client.release()
  }
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]!))
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => key === rightEntries[index]![0] && equalJson(value, rightEntries[index]![1]))
}

async function setShareAccess(pool: Pool, ownerUserId: string, fileId: string, access: 'private' | 'view'): Promise<FileShare | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query<LockedShareRow>(
      `SELECT file.id AS file_id, COALESCE(share.access, 'private') AS access,
              COALESCE(share.updated_at, file.updated_at) AS updated_at, file.access_epoch
       FROM app_file AS file
       LEFT JOIN app_file_share AS share ON share.file_id = file.id AND share.owner_user_id = file.owner_user_id
       WHERE file.id = $1 AND file.owner_user_id = $2
       FOR UPDATE OF file`,
      [fileId, ownerUserId],
    )
    const current = currentResult.rows[0]
    if (!current) {
      await client.query('ROLLBACK')
      return null
    }
    if (current.access === access) {
      await client.query('COMMIT')
      return shareFromRow(current)
    }
    if (safeInt64(current.access_epoch, 'access epoch') === maxSignedInt64) throw new Error('File access epoch is exhausted.')
    const shareResult = await client.query<ShareRow>(
      `INSERT INTO app_file_share (file_id, owner_user_id, access)
       VALUES ($1, $2, $3)
       ON CONFLICT (file_id) DO UPDATE
         SET access = EXCLUDED.access, updated_at = now()
       RETURNING file_id, access, updated_at`,
      [fileId, ownerUserId, access],
    )
    const row = shareResult.rows[0]
    if (!row) throw new Error('File share mutation did not return a record.')
    await client.query('COMMIT')
    return shareFromRow(row)
  } catch (error) {
    await rollback(client)
    throw error
  } finally {
    client.release()
  }
}

async function setThumbnailForCapture(pool: Pool, fileId: string, expectedRevision: number, thumbnailKey: string, thumbnailEtag: string): Promise<ThumbnailUpdateResult> {
  const saved = await pool.query<ThumbnailRow>('UPDATE app_file SET thumbnail_key = $3, thumbnail_etag = $4 WHERE id = $1 AND head_revision = $2 RETURNING id, head_revision, thumbnail_key, thumbnail_etag', [fileId, expectedRevision, thumbnailKey, thumbnailEtag])
  const row = saved.rows[0]
  if (row) return Object.freeze({ status: 'saved', thumbnail: thumbnailFromRow(row) })
  const current = await pool.query<QueryResultRow & { head_revision: string | number }>('SELECT head_revision FROM app_file WHERE id = $1', [fileId])
  return current.rows[0] ? Object.freeze({ status: 'conflict', currentRevision: safeRevision(current.rows[0].head_revision) }) : Object.freeze({ status: 'not-found' })
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK') }
  catch (error) { console.error(JSON.stringify({ level: 'error', event: 'database_rollback_failed', message: error instanceof Error ? error.message : String(error) })) }
}

async function saveDocument(pool: Pool, ownerUserId: string, fileId: string, expectedRevision: number, document: Readonly<Record<string, JsonValue>>): Promise<DocumentSaveResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const ownedFile = await client.query('SELECT id FROM app_file WHERE id = $1 AND owner_user_id = $2 FOR UPDATE', [fileId, ownerUserId])
    if (!ownedFile.rowCount) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'not-found' })
    }
    const authority = await client.query<ProjectionAuthorityRow>('SELECT authority FROM app_collaboration_projection WHERE file_id = $1', [fileId])
    if (authority.rows[0]) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'collaboration-authoritative' })
    }
    const saved = await client.query<DocumentRow>('UPDATE app_file_document SET revision = revision + 1, document = $4::jsonb, updated_at = now() WHERE file_id = $1 AND owner_user_id = $2 AND revision = $3 RETURNING file_id, revision, document, updated_at', [fileId, ownerUserId, expectedRevision, JSON.stringify(document)])
    const row = saved.rows[0]
    if (!row) {
      const current = await client.query<QueryResultRow & { revision: string | number }>('SELECT revision FROM app_file_document WHERE file_id = $1 AND owner_user_id = $2', [fileId, ownerUserId])
      await client.query('ROLLBACK')
      return current.rows[0] ? Object.freeze({ status: 'conflict', currentRevision: safeRevision(current.rows[0].revision) }) : Object.freeze({ status: 'not-found' })
    }
    await client.query('UPDATE app_file SET head_revision = $3, thumbnail_key = NULL, thumbnail_etag = NULL, updated_at = $4 WHERE id = $1 AND owner_user_id = $2', [fileId, ownerUserId, row.revision, row.updated_at])
    await client.query("INSERT INTO app_thumbnail_capture_job (id, file_id, revision, status) VALUES ($1, $2, $3, 'queued') ON CONFLICT (file_id, revision) DO NOTHING", [randomUUID(), fileId, row.revision])
    await client.query('COMMIT')
    return Object.freeze({ status: 'saved', document: documentFromRow(row) })
  } catch (error) {
    await rollback(client)
    throw error
  } finally {
    client.release()
  }
}

async function claimCaptureJob(pool: Pool, now: Date, leaseExpiresAt: Date): Promise<ThumbnailCaptureJob | null> {
  const result = await pool.query<CaptureJobRow>(
    `WITH candidate AS (
       SELECT id FROM app_thumbnail_capture_job
       WHERE status = 'queued' OR (status = 'leased' AND lease_expires_at <= $1)
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE app_thumbnail_capture_job AS job
     SET status = 'leased', lease_id = gen_random_uuid(), lease_expires_at = $2, attempts = attempts + 1
     FROM candidate WHERE job.id = candidate.id
     RETURNING job.id, job.file_id, job.revision, job.lease_id, job.lease_expires_at, job.attempts`,
    [now, leaseExpiresAt],
  )
  const row = result.rows[0]
  return row ? Object.freeze({ id: row.id, fileId: row.file_id, revision: safeRevision(row.revision), leaseId: row.lease_id, leaseExpiresAt: iso(row.lease_expires_at), attempts: row.attempts }) : null
}

async function setThumbnail(pool: Pool, ownerUserId: string, fileId: string, expectedRevision: number, thumbnailKey: string, thumbnailEtag: string): Promise<ThumbnailUpdateResult> {
  const saved = await pool.query<ThumbnailRow>('UPDATE app_file SET thumbnail_key = $4, thumbnail_etag = $5 WHERE id = $1 AND owner_user_id = $2 AND head_revision = $3 RETURNING id, head_revision, thumbnail_key, thumbnail_etag', [fileId, ownerUserId, expectedRevision, thumbnailKey, thumbnailEtag])
  const row = saved.rows[0]
  if (row) return Object.freeze({ status: 'saved', thumbnail: thumbnailFromRow(row) })
  const current = await pool.query<QueryResultRow & { head_revision: string | number }>('SELECT head_revision FROM app_file WHERE id = $1 AND owner_user_id = $2', [fileId, ownerUserId])
  return current.rows[0]
    ? Object.freeze({ status: 'conflict', currentRevision: safeRevision(current.rows[0].head_revision) })
    : Object.freeze({ status: 'not-found' })
}
