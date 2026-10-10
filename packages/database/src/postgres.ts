import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import type { CloudFile, CloudFileDocument, CloudFileSummary, CloudProject, ControlPlaneStore, DocumentSaveResult, JsonValue } from './index.js'
import { emptyCanvasDocument } from './index.js'

type ProjectRow = QueryResultRow & Readonly<{ id: string; name: string; created_at: Date | string; updated_at: Date | string }>
type FileRow = QueryResultRow & Readonly<{ id: string; project_id: string | null; name: string; head_revision: string | number; thumbnail_key: string | null; created_at: Date | string; updated_at: Date | string }>
type DocumentRow = QueryResultRow & Readonly<{ file_id: string; revision: string | number; document: Record<string, JsonValue>; updated_at: Date | string }>

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const safeRevision = (value: number | string) => {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Database returned an invalid revision.')
  return revision
}
const projectFromRow = (row: ProjectRow): CloudProject => Object.freeze({ id: row.id, name: row.name, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const fileFromRow = (row: FileRow): CloudFile => Object.freeze({ id: row.id, projectId: row.project_id, name: row.name, headRevision: safeRevision(row.head_revision), thumbnailKey: row.thumbnail_key, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const documentFromRow = (row: DocumentRow): CloudFileDocument => Object.freeze({ fileId: row.file_id, revision: safeRevision(row.revision), document: Object.freeze(row.document), updatedAt: iso(row.updated_at) })

const projectColumns = 'id, name, created_at, updated_at'
const fileColumns = 'id, project_id, name, head_revision, thumbnail_key, created_at, updated_at'

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
      const result = await pool.query<ProjectRow>(`INSERT INTO app_project (id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING ${projectColumns}`, [randomUUID(), ownerUserId, name])
      return projectFromRow(result.rows[0]!)
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
    async getFileDocument(ownerUserId, fileId) {
      const result = await pool.query<DocumentRow>('SELECT file_id, revision, document, updated_at FROM app_file_document WHERE file_id = $1 AND owner_user_id = $2', [fileId, ownerUserId])
      return result.rows[0] ? documentFromRow(result.rows[0]) : null
    },
    async saveFileDocument(ownerUserId, fileId, expectedRevision, document) {
      return saveDocument(pool, ownerUserId, fileId, expectedRevision, document)
    },
  }
  return Object.freeze(store)
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK') } catch { /* The original transaction error remains authoritative. */ }
}

async function saveDocument(pool: Pool, ownerUserId: string, fileId: string, expectedRevision: number, document: Readonly<Record<string, JsonValue>>): Promise<DocumentSaveResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const saved = await client.query<DocumentRow>('UPDATE app_file_document SET revision = revision + 1, document = $4::jsonb, updated_at = now() WHERE file_id = $1 AND owner_user_id = $2 AND revision = $3 RETURNING file_id, revision, document, updated_at', [fileId, ownerUserId, expectedRevision, JSON.stringify(document)])
    const row = saved.rows[0]
    if (!row) {
      const current = await client.query<QueryResultRow & { revision: string | number }>('SELECT revision FROM app_file_document WHERE file_id = $1 AND owner_user_id = $2', [fileId, ownerUserId])
      await client.query('ROLLBACK')
      return current.rows[0] ? Object.freeze({ status: 'conflict', currentRevision: safeRevision(current.rows[0].revision) }) : Object.freeze({ status: 'not-found' })
    }
    await client.query('UPDATE app_file SET head_revision = $3, updated_at = $4 WHERE id = $1 AND owner_user_id = $2', [fileId, ownerUserId, row.revision, row.updated_at])
    await client.query('COMMIT')
    return Object.freeze({ status: 'saved', document: documentFromRow(row) })
  } catch (error) {
    await rollback(client)
    throw error
  } finally {
    client.release()
  }
}
