import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import type { CloudFile, CloudFileDocument, CloudFileSummary, CloudProject, ControlPlaneStore, DocumentInvariantRepairResult, DocumentSaveResult, FileAccessAuthorization, FileMetadataMutationResult, FileShare, FileThumbnailMetadata, HostedPreviewArtifactRecord, HostedPreviewBuildJob, InternalFileThumbnail, JsonValue, LegacyDocumentExternalizationResult, SharedFile, ThumbnailCaptureJob, ThumbnailUpdateResult } from './index.js'
import { emptyCanvasDocument } from './index.js'
import { canonicalCollaborationJson } from './collaboration.js'

type ProjectRow = QueryResultRow & Readonly<{ id: string; name: string; created_at: Date | string; updated_at: Date | string }>
type FileRow = QueryResultRow & Readonly<{ id: string; project_id: string | null; name: string; head_revision: string | number; thumbnail_key: string | null; thumbnail_etag: string | null; created_at: Date | string; updated_at: Date | string }>
type DocumentRow = QueryResultRow & Readonly<{ file_id: string; revision: unknown; document: Record<string, JsonValue>; updated_at: Date | string }>
type ProjectionAuthorityRow = QueryResultRow & Readonly<{ authority: 'legacy-seed' | 'room' }>
type RepairProjectionRow = ProjectionAuthorityRow & Readonly<{ file_id: string; document: Record<string, JsonValue>; document_digest: string; updated_at: Date | string }>
type RepairLeaseRow = QueryResultRow & Readonly<{ active: boolean }>
type ThumbnailRow = QueryResultRow & Readonly<{ id: string; head_revision: string | number; thumbnail_key: string | null; thumbnail_etag: string | null }>
type InternalThumbnailRow = ThumbnailRow & Readonly<{ owner_user_id: string }>
type CaptureJobRow = QueryResultRow & Readonly<{ id: string; file_id: string; revision: string | number; lease_id: string; lease_expires_at: Date | string; attempts: number }>
type ShareRow = QueryResultRow & Readonly<{ file_id: string; access: 'private' | 'view'; updated_at: Date | string }>
type AccessRow = QueryResultRow & Readonly<{ file_id: string; role: 'owner' | 'viewer'; access_epoch: string | number | bigint }>
type LockedShareRow = QueryResultRow & Readonly<{ file_id: string; access: 'private' | 'view'; updated_at: Date | string; access_epoch: string | number | bigint }>
type SharedFileRow = QueryResultRow & Readonly<{ id: string; name: string; head_revision: unknown; file_updated_at: Date | string; revision: unknown; document: Record<string, JsonValue>; document_updated_at: Date | string }>
type HostedPreviewArtifactRow = QueryResultRow & Readonly<{ artifact_id: string; file_id: string; file_revision: unknown; source_revision: string; registry_fingerprint: string; entrypoint: string }>
type HostedPreviewBuildJobRow = QueryResultRow & Readonly<{
  id: string; file_id: string; file_revision: unknown; project_id: string; scan_job_id: string; artifact_id: string; staging_id: string
  status: 'queued' | 'leased' | 'completed' | 'failed'; attempts: unknown; lease_id: string | null; lease_expires_at: Date | string | null
  next_attempt_at: Date | string | null; error_id: string | null; created_at: Date | string; completed_at: Date | string | null; failed_at: Date | string | null
}>

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
const hostedPreviewArtifactFromRow = (row: HostedPreviewArtifactRow): HostedPreviewArtifactRecord => Object.freeze({ artifactId: row.artifact_id, fileId: row.file_id, fileRevision: safeRevision(row.file_revision), sourceRevision: row.source_revision, registryFingerprint: row.registry_fingerprint, entrypoint: row.entrypoint })
const hostedPreviewBuildJobFromRow = (row: HostedPreviewBuildJobRow): HostedPreviewBuildJob => Object.freeze({
  id: row.id,
  fileId: row.file_id,
  fileRevision: safeRevision(row.file_revision),
  projectId: row.project_id,
  scanJobId: row.scan_job_id,
  artifactId: row.artifact_id,
  stagingId: row.staging_id,
  status: row.status,
  attempts: safeRevision(row.attempts),
  leaseId: row.lease_id,
  leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
  nextAttemptAt: row.next_attempt_at ? iso(row.next_attempt_at) : null,
  errorId: row.error_id,
  createdAt: iso(row.created_at),
  completedAt: row.completed_at ? iso(row.completed_at) : null,
  failedAt: row.failed_at ? iso(row.failed_at) : null,
})

const projectColumns = 'id, name, created_at, updated_at'
const fileColumns = 'id, project_id, name, head_revision, thumbnail_key, thumbnail_etag, created_at, updated_at'
const hostedPreviewBuildJobColumns = 'id, file_id, file_revision, project_id, scan_job_id, artifact_id, staging_id, status, attempts, lease_id, lease_expires_at, next_attempt_at, error_id, created_at, completed_at, failed_at'
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
        const id = randomUUID()
        let resolvedProjectId = projectId
        if (resolvedProjectId) {
          const project = await client.query('SELECT id FROM app_project WHERE id = $1 AND owner_user_id = $2 FOR SHARE', [projectId, ownerUserId])
          if (!project.rowCount) throw new Error('Project was not found.')
        } else {
          await client.query('INSERT INTO app_project (id, owner_user_id, name) VALUES ($1, $2, $3)', [id, ownerUserId, name])
          await client.query("INSERT INTO app_project_member (project_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ownerUserId])
          resolvedProjectId = id
        }
        const result = await client.query<FileRow>(`INSERT INTO app_file (id, project_id, owner_user_id, name) VALUES ($1, $2, $3, $4) RETURNING ${fileColumns}`, [id, resolvedProjectId, ownerUserId, name])
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
    async renameFile(ownerUserId, fileId, expectedRevision, name) {
      return renameFile(pool, ownerUserId, fileId, expectedRevision, name)
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
    async repairFileDocumentInvariant(fileId, expectedRevision, source, document) {
      return repairDocumentInvariant(pool, fileId, expectedRevision, source, document)
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
    async createHostedPreviewBuildJob(input) {
      const result = await pool.query<HostedPreviewBuildJobRow>(
        `INSERT INTO app_hosted_preview_build_job AS current
          (id, owner_user_id, file_id, file_revision, project_id, scan_job_id, artifact_id, staging_id, status, next_attempt_at, created_at)
         SELECT $1, $2, file.id, $4, file.project_id, $6, $7, $8, 'queued', $9, $9
         FROM app_file AS file
         LEFT JOIN app_collaboration_projection AS projection ON projection.file_id = file.id
         WHERE file.id = $3 AND file.owner_user_id = $2 AND file.project_id = $5
           AND CASE WHEN projection.authority = 'room'
             THEN jsonb_typeof(projection.document -> 'revision') = 'number' AND (projection.document ->> 'revision')::bigint = $4
             ELSE file.head_revision = $4
           END
         ON CONFLICT (file_id, file_revision, scan_job_id) DO UPDATE SET
           status = CASE WHEN current.status = 'failed' THEN 'queued' ELSE current.status END,
           next_attempt_at = CASE WHEN current.status = 'failed' THEN EXCLUDED.next_attempt_at ELSE current.next_attempt_at END,
           error_id = CASE WHEN current.status = 'failed' THEN NULL ELSE current.error_id END,
           failed_at = CASE WHEN current.status = 'failed' THEN NULL ELSE current.failed_at END
         RETURNING ${hostedPreviewBuildJobColumns}`,
        [input.id, input.ownerUserId, input.fileId, input.fileRevision, input.projectId, input.scanJobId, input.artifactId, input.stagingId, input.createdAt],
      )
      return result.rows[0] ? hostedPreviewBuildJobFromRow(result.rows[0]) : null
    },
    async getHostedPreviewBuildJob(ownerUserId, jobId) {
      const result = await pool.query<HostedPreviewBuildJobRow>(
        `SELECT ${hostedPreviewBuildJobColumns} FROM app_hosted_preview_build_job WHERE id = $1 AND owner_user_id = $2`,
        [jobId, ownerUserId],
      )
      return result.rows[0] ? hostedPreviewBuildJobFromRow(result.rows[0]) : null
    },
    async claimHostedPreviewBuildJob(now, leaseExpiresAt) {
      const result = await pool.query<HostedPreviewBuildJobRow>(
        `WITH candidate AS (
           SELECT id FROM app_hosted_preview_build_job
           WHERE (status = 'queued' AND next_attempt_at <= $1) OR (status = 'leased' AND lease_expires_at <= $1)
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE app_hosted_preview_build_job AS job
         SET status = 'leased', attempts = attempts + 1, lease_id = $3, lease_expires_at = $2, next_attempt_at = NULL
         FROM candidate WHERE job.id = candidate.id
         RETURNING ${hostedPreviewBuildJobColumns.split(', ').map(column => `job.${column}`).join(', ')}`,
        [now, leaseExpiresAt, randomUUID()],
      )
      return result.rows[0] ? hostedPreviewBuildJobFromRow(result.rows[0]) : null
    },
    async isCurrentHostedPreviewBuildLease(jobId, leaseId, now) {
      const result = await pool.query(
        `SELECT 1 FROM app_hosted_preview_build_job
         WHERE id = $1 AND status = 'leased' AND lease_id = $2 AND lease_expires_at > $3`,
        [jobId, leaseId, now],
      )
      return result.rowCount === 1
    },
    async completeHostedPreviewBuildJob(jobId, leaseId, completedAt) {
      const result = await pool.query(
        `UPDATE app_hosted_preview_build_job AS job SET status = 'completed', lease_id = NULL, lease_expires_at = NULL, completed_at = $3
         WHERE job.id = $1 AND job.status = 'leased' AND job.lease_id = $2 AND job.lease_expires_at > $3
           AND EXISTS (
             SELECT 1 FROM app_hosted_preview_artifact AS artifact
             WHERE artifact.artifact_id = job.artifact_id
               AND artifact.file_id = job.file_id
               AND artifact.file_revision = job.file_revision
           )`,
        [jobId, leaseId, completedAt],
      )
      return result.rowCount === 1
    },
    async retryHostedPreviewBuildJob(jobId, leaseId, retryAt, nextAttemptAt) {
      const result = await pool.query(
        `UPDATE app_hosted_preview_build_job SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, next_attempt_at = $4
         WHERE id = $1 AND status = 'leased' AND lease_id = $2 AND lease_expires_at > $3`,
        [jobId, leaseId, retryAt, nextAttemptAt],
      )
      return result.rowCount === 1
    },
    async failHostedPreviewBuildJob(jobId, leaseId, errorId, failedAt) {
      const result = await pool.query(
        `UPDATE app_hosted_preview_build_job SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, error_id = $3, failed_at = $4
         WHERE id = $1 AND status = 'leased' AND lease_id = $2 AND lease_expires_at > $4`,
        [jobId, leaseId, errorId, failedAt],
      )
      return result.rowCount === 1
    },
    async registerHostedPreviewArtifact(artifact) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const file = await client.query<{ head_revision: unknown }>('SELECT head_revision FROM app_file WHERE id = $1 FOR SHARE', [artifact.fileId])
        if (!file.rows[0]) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'not-found' })
        }
        const projection = await client.query<ProjectionAuthorityRow & Readonly<{ document: Record<string, JsonValue> }>>(
          'SELECT authority, document FROM app_collaboration_projection WHERE file_id = $1 FOR SHARE',
          [artifact.fileId],
        )
        const currentRevision = projection.rows[0]?.authority === 'room'
          ? safeRevision(projection.rows[0].document.revision)
          : safeRevision(file.rows[0].head_revision)
        if (currentRevision !== artifact.fileRevision) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'revision-conflict', currentRevision })
        }
        const inserted = await client.query<HostedPreviewArtifactRow>(
          `INSERT INTO app_hosted_preview_artifact (artifact_id, file_id, file_revision, source_revision, registry_fingerprint, entrypoint)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (artifact_id) DO NOTHING
           RETURNING artifact_id, file_id, file_revision, source_revision, registry_fingerprint, entrypoint`,
          [artifact.artifactId, artifact.fileId, artifact.fileRevision, artifact.sourceRevision, artifact.registryFingerprint, artifact.entrypoint],
        )
        const row = inserted.rows[0] ?? (await client.query<HostedPreviewArtifactRow>(
          'SELECT artifact_id, file_id, file_revision, source_revision, registry_fingerprint, entrypoint FROM app_hosted_preview_artifact WHERE artifact_id = $1',
          [artifact.artifactId],
        )).rows[0]
        if (!row) throw new Error('Hosted preview artifact registration was lost.')
        const stored = hostedPreviewArtifactFromRow(row)
        const unchanged = stored.fileId === artifact.fileId && stored.fileRevision === artifact.fileRevision && stored.sourceRevision === artifact.sourceRevision
          && stored.registryFingerprint === artifact.registryFingerprint && stored.entrypoint === artifact.entrypoint
        await client.query(unchanged ? 'COMMIT' : 'ROLLBACK')
        return unchanged
          ? Object.freeze({ status: inserted.rows[0] ? 'registered' : 'unchanged', artifact: stored })
          : Object.freeze({ status: 'identity-conflict' })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },
    async authorizeHostedPreviewArtifact(subjectUserId, fileId, artifactId) {
      if (subjectUserId.length < 1 || subjectUserId.length > 128) throw new Error('Subject user id must contain between 1 and 128 characters.')
      const result = await pool.query<HostedPreviewArtifactRow>(
        `SELECT artifact.artifact_id, artifact.file_id, artifact.file_revision, artifact.source_revision, artifact.registry_fingerprint, artifact.entrypoint
         FROM app_hosted_preview_artifact AS artifact
         JOIN app_file AS file ON file.id = artifact.file_id
         LEFT JOIN app_collaboration_projection AS projection ON projection.file_id = file.id
         LEFT JOIN app_file_share AS share ON share.file_id = file.id AND share.owner_user_id = file.owner_user_id
         WHERE artifact.artifact_id = $1 AND artifact.file_id = $2
           AND CASE WHEN projection.authority = 'room'
             THEN jsonb_typeof(projection.document -> 'revision') = 'number' AND (projection.document ->> 'revision')::bigint = artifact.file_revision
             ELSE file.head_revision = artifact.file_revision
           END
           AND (file.owner_user_id = $3 OR share.access = 'view')`,
        [artifactId, fileId, subjectUserId],
      )
      return result.rows[0] ? hostedPreviewArtifactFromRow(result.rows[0]) : null
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

async function repairDocumentInvariant(
  pool: Pool,
  fileId: string,
  expectedRevision: number,
  source: Readonly<Record<string, JsonValue>>,
  document: Readonly<Record<string, JsonValue>>,
): Promise<DocumentInvariantRepairResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const lease = await client.query<RepairLeaseRow>(
      `SELECT active_generation_id IS NOT NULL AND lease_expires_at > now() AS active
       FROM app_collaboration_lease WHERE file_id = $1 FOR UPDATE`,
      [fileId],
    )
    if (lease.rows[0]?.active) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'collaboration-active' })
    }
    const projectionResult = await client.query<RepairProjectionRow>(
      'SELECT file_id, authority, document, document_digest, updated_at FROM app_collaboration_projection WHERE file_id = $1 FOR UPDATE',
      [fileId],
    )
    const projection = projectionResult.rows[0]
    if (projection?.authority === 'room') {
      const revision = safeRevision(projection.document.revision)
      if (revision !== expectedRevision || !equalJson(projection.document, source)) {
        if (equalJson(projection.document, document)) {
          await client.query('COMMIT')
          return Object.freeze({ status: 'unchanged', document: documentFromRow({ file_id: fileId, revision, document: projection.document, updated_at: projection.updated_at }) })
        }
        await client.query('ROLLBACK')
        return Object.freeze({ status: 'conflict', currentRevision: revision })
      }
      const documentJson = canonicalCollaborationJson(document)
      const documentDigest = createHash('sha256').update(documentJson).digest('hex')
      const saved = await client.query<RepairProjectionRow>(
        `UPDATE app_collaboration_projection
         SET document = $3::jsonb, document_digest = $4, updated_at = now()
         WHERE file_id = $1 AND document = $2::jsonb AND document_digest = $5
         RETURNING file_id, authority, document, document_digest, updated_at`,
        [fileId, JSON.stringify(source), documentJson, documentDigest, projection.document_digest],
      )
      const row = saved.rows[0]
      if (!row) throw new Error('Collaboration projection changed during invariant repair.')
      await client.query('COMMIT')
      return Object.freeze({ status: 'saved', document: documentFromRow({ file_id: fileId, revision: expectedRevision, document: row.document, updated_at: row.updated_at }) })
    }

    const currentResult = await client.query<DocumentRow>('SELECT file_id, revision, document, updated_at FROM app_file_document WHERE file_id = $1 FOR UPDATE', [fileId])
    const current = currentResult.rows[0]
    if (!current) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'not-found' })
    }
    const revision = safeRevision(current.revision)
    if (revision !== expectedRevision || !equalJson(current.document, source)) {
      if (equalJson(current.document, document)) {
        await client.query('COMMIT')
        return Object.freeze({ status: 'unchanged', document: documentFromRow(current) })
      }
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'conflict', currentRevision: revision })
    }
    if (projection && !equalJson(projection.document, source) && !equalJson(projection.document, document)) {
      await client.query('ROLLBACK')
      return Object.freeze({ status: 'conflict', currentRevision: revision })
    }
    const saved = await client.query<DocumentRow>(
      'UPDATE app_file_document SET document = $3::jsonb WHERE file_id = $1 AND revision = $2 AND document = $4::jsonb RETURNING file_id, revision, document, updated_at',
      [fileId, expectedRevision, JSON.stringify(document), JSON.stringify(source)],
    )
    const row = saved.rows[0]
    if (!row) throw new Error('Legacy document changed during invariant repair.')
    if (projection && !equalJson(projection.document, document)) {
      const documentJson = canonicalCollaborationJson(document)
      const documentDigest = createHash('sha256').update(documentJson).digest('hex')
      const updated = await client.query(
        `UPDATE app_collaboration_projection SET document = $3::jsonb, document_digest = $4, updated_at = now()
         WHERE file_id = $1 AND document = $2::jsonb AND document_digest = $5`,
        [fileId, JSON.stringify(source), documentJson, documentDigest, projection.document_digest],
      )
      if (updated.rowCount !== 1) throw new Error('Legacy seed projection changed during invariant repair.')
    }
    await client.query('COMMIT')
    return Object.freeze({ status: 'saved', document: documentFromRow(row) })
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

async function renameFile(pool: Pool, ownerUserId: string, fileId: string, expectedRevision: number, name: string): Promise<FileMetadataMutationResult> {
  const saved = await pool.query<FileRow>(`UPDATE app_file SET name = $4, updated_at = now() WHERE id = $1 AND owner_user_id = $2 AND head_revision = $3 RETURNING ${fileColumns}`, [fileId, ownerUserId, expectedRevision, name])
  const row = saved.rows[0]
  if (row) return Object.freeze({ status: 'saved', file: fileFromRow(row) })
  const current = await pool.query<QueryResultRow & { head_revision: string | number }>('SELECT head_revision FROM app_file WHERE id = $1 AND owner_user_id = $2', [fileId, ownerUserId])
  return current.rows[0]
    ? Object.freeze({ status: 'conflict', currentRevision: safeRevision(current.rows[0].head_revision) })
    : Object.freeze({ status: 'not-found' })
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
