import assert from 'node:assert/strict'
import { createPostgresControlPlane, createPostgresPool } from '../dist/postgres.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required for the PostgreSQL acceptance test.')
const pool = createPostgresPool(connectionString)
try {
  const store = createPostgresControlPlane(pool)
  const project = await store.createProject('acceptance-owner', 'Private project')
  const file = await store.createFile('acceptance-owner', 'Source file', project.id)
  assert.equal(file.headRevision, 0)
  const initial = await store.getFileDocument('acceptance-owner', file.id)
  assert.equal(initial?.document.schemaVersion, 6)
  assert.equal(initial?.document.fileId, file.id)
  assert.equal(initial?.document.revision, 0)
  assert.equal(initial?.document.pages.length, 1)
  assert.equal(await store.getProject('different-user', project.id), null)
  assert.equal(await store.getFile('different-user', file.id), null)
  assert.equal(await store.getFileDocument('different-user', file.id), null)
  assert.deepEqual(await store.saveFileDocument('different-user', file.id, 0, { schemaVersion: 6 }), { status: 'not-found' })
  const savedDocument = { ...initial.document, revision: 1 }
  const saved = await store.saveFileDocument('acceptance-owner', file.id, 0, savedDocument)
  assert.equal(saved.status, 'saved')
  if (saved.status !== 'saved') throw new Error('Expected document save to succeed.')
  assert.equal(saved.document.revision, 1)
  assert.equal(saved.document.document.revision, 1)
  assert.deepEqual(await store.saveFileDocument('acceptance-owner', file.id, 0, savedDocument), { status: 'conflict', currentRevision: 1 })
  assert.equal((await store.getFile('acceptance-owner', file.id))?.headRevision, 1)
  process.stdout.write('PostgreSQL control-plane acceptance passed.\n')
} finally {
  await pool.end()
}
