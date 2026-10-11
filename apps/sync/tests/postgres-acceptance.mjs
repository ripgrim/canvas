import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PostgresSyncRepository } from '../dist/postgres-repository.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required for the PostgreSQL sync acceptance test.')

const pool = new Pool({ connectionString })
const syncPool = new Pool({ connectionString, application_name: `sync-acceptance-${process.pid}` })
const fileId = randomUUID()
const ownerId = `sync-acceptance:${randomUUID()}`
const unrelatedOwnerId = `sync-acceptance:${randomUUID()}`
const pageId = `page-${fileId}`
const rootId = `root-${fileId}`
const functionName = `sync_reject_${fileId.replaceAll('-', '')}`
const triggerName = `sync_reject_${fileId.replaceAll('-', '')}`
const document = {
  schemaVersion: 7,
  fileId,
  revision: 0,
  pages: [{ id: pageId, name: 'Page 1', rootNodeId: rootId }],
  nodes: { [rootId]: { id: rootId, type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
}

const editName = (name) => [{ type: 'set', path: ['pages', 0, 'name'], value: name }]
const commit = (overrides = {}) => ({
  fileId,
  subjectId: ownerId,
  clientId: 'acceptance-client',
  clientMutationId: randomUUID(),
  baseRevision: 0,
  edits: editName('Persisted page'),
  ...overrides,
})

try {
  await pool.query('INSERT INTO app_file (id, owner_user_id, name) VALUES ($1, $2, $3)', [fileId, ownerId, 'Sync acceptance'])
  await pool.query('INSERT INTO app_file_document (file_id, owner_user_id, revision, document) VALUES ($1, $2, 0, $3::jsonb)', [fileId, ownerId, JSON.stringify(document)])

  const first = new PostgresSyncRepository(syncPool, { historyLimit: 2 })
  const bootstrap = await first.open(fileId)
  assert.equal(bootstrap.status, 'payload', 'CLOUD-SYNC-PG-001 bootstrap returns the canonical payload')
  if (bootstrap.status !== 'payload') throw new Error('Expected bootstrap payload.')
  assert.equal(bootstrap.payload.document.revision, 0)

  const crossTenant = await first.commit(commit({ subjectId: unrelatedOwnerId, clientMutationId: 'cross-tenant' }))
  assert.equal(crossTenant.status, 'not_found', 'CLOUD-SYNC-PG-SEC-001 tenant ownership is enforced inside the write transaction')

  const original = commit({ clientMutationId: 'mutation-1' })
  const applied = await first.commit(original)
  assert.equal(applied.status, 'applied', 'CLOUD-SYNC-PG-001 commit succeeds')
  if (applied.status !== 'applied') throw new Error('Expected applied edit.')
  assert.equal(applied.batch.serverRevision, 1)

  const reopened = new PostgresSyncRepository(syncPool, { historyLimit: 2 })
  const catchup = await reopened.open(fileId, 0)
  assert.equal(catchup.status, 'catchup', 'CLOUD-SYNC-PG-001 catch-up survives a repository instance')
  if (catchup.status !== 'catchup') throw new Error('Expected catch-up payload.')
  assert.deepEqual(catchup.batches.map(batch => batch.clientMutationId), ['mutation-1'])
  const payload = await reopened.open(fileId)
  assert.equal(payload.status, 'payload')
  if (payload.status !== 'payload') throw new Error('Expected reopened payload.')
  assert.equal(payload.payload.document.pages[0].name, 'Persisted page')
  assert.equal(payload.payload.document.revision, 1)

  const duplicate = await reopened.commit(original)
  assert.equal(duplicate.status, 'duplicate', 'CLOUD-SYNC-PG-CONFLICT-001 exact replay is idempotent')
  const reused = await reopened.commit({ ...original, edits: editName('Different replay') })
  assert.equal(reused.status, 'mutation_id_reused', 'CLOUD-SYNC-PG-CONFLICT-001 changed replay is rejected')
  const stale = await reopened.commit(commit({ clientMutationId: 'stale-mutation' }))
  assert.equal(stale.status, 'conflict', 'CLOUD-SYNC-PG-CONFLICT-001 stale base conflicts')
  if (stale.status !== 'conflict') throw new Error('Expected revision conflict.')
  assert.equal(stale.serverRevision, 1)
  assert.deepEqual(stale.batches?.map(batch => batch.serverRevision), [1])

  const [left, right] = await Promise.all([
    first.commit(commit({ clientMutationId: 'racing-left', baseRevision: 1, edits: editName('Left wins') })),
    reopened.commit(commit({ clientMutationId: 'racing-right', baseRevision: 1, edits: editName('Right wins') })),
  ])
  assert.deepEqual([left.status, right.status].sort(), ['applied', 'conflict'], 'CLOUD-SYNC-PG-CONFLICT-001 row locking serializes concurrent writers')

  const afterRace = await reopened.open(fileId)
  if (afterRace.status !== 'payload') throw new Error('Expected payload after racing writers.')
  const retained = await reopened.commit(commit({ clientMutationId: 'retained-third', baseRevision: afterRace.payload.serverRevision, edits: editName('Retained third') }))
  assert.equal(retained.status, 'applied')
  const retainedRows = await pool.query('SELECT owner_user_id, server_revision FROM app_file_edit_batch WHERE file_id = $1 ORDER BY server_revision', [fileId])
  assert.deepEqual(retainedRows.rows.map(row => [row.owner_user_id, Number(row.server_revision)]), [[ownerId, 2], [ownerId, 3]], 'CLOUD-SYNC-PG-RETENTION-001 retains only the configured owner-scoped suffix')
  const expiredCatchup = await reopened.open(fileId, 0)
  assert.equal(expiredCatchup.status, 'payload', 'CLOUD-SYNC-PG-RETENTION-001 expired catch-up falls back to a full validated payload')
  if (expiredCatchup.status !== 'payload') throw new Error('Expected retained-history fallback payload.')
  assert.equal(expiredCatchup.reason, 'history_unavailable')
  const expiredReplay = await reopened.commit(original)
  assert.equal(expiredReplay.status, 'conflict', 'CLOUD-SYNC-PG-RETENTION-001 expired idempotency keys cannot replay a pruned mutation')
  if (expiredReplay.status !== 'conflict') throw new Error('Expected expired replay conflict.')
  assert.equal(expiredReplay.batches, null)
  await assert.rejects(
    () => pool.query('UPDATE app_file_edit_batch SET client_id = $2 WHERE file_id = $1 AND server_revision = 3', [fileId, 'tampered-client']),
    /app_file_edit_batch rows are immutable/,
    'CLOUD-SYNC-PG-APPEND-001 persisted history cannot be rewritten',
  )

  const apiClient = await pool.connect()
  try {
    await apiClient.query('BEGIN')
    const apiDocument = structuredClone(expiredCatchup.payload.document)
    apiDocument.revision = 4
    apiDocument.pages[0].name = 'API wins'
    await apiClient.query('UPDATE app_file_document SET revision = 4, document = $2::jsonb, updated_at = now() WHERE file_id = $1 AND revision = 3', [fileId, JSON.stringify(apiDocument)])
    const concurrentSync = reopened.commit(commit({ clientMutationId: 'api-race', baseRevision: 3, edits: editName('Sync loses') }))
    let waiting = false
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      const activity = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' LIMIT 1", [`sync-acceptance-${process.pid}`])
      waiting = activity.rowCount === 1
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(waiting, true, 'CLOUD-SYNC-PG-CAS-001 sync waits on the document CAS lock held by the API writer')
    await apiClient.query('UPDATE app_file SET head_revision = 4, updated_at = now() WHERE id = $1', [fileId])
    await apiClient.query('COMMIT')
    const apiRace = await concurrentSync
    assert.equal(apiRace.status, 'conflict', 'CLOUD-SYNC-PG-CAS-001 API and sync writes serialize without deadlock')
    if (apiRace.status !== 'conflict') throw new Error('Expected API race conflict.')
    assert.equal(apiRace.serverRevision, 4)
    assert.equal(apiRace.batches, null, 'CLOUD-SYNC-PG-CAS-001 an API revision gap requires a full payload instead of false catch-up')
  } catch (error) {
    await apiClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    apiClient.release()
  }

  const beforeFailure = await pool.query('SELECT file.head_revision, document.revision, document.document FROM app_file AS file INNER JOIN app_file_document AS document ON document.file_id = file.id WHERE file.id = $1', [fileId])
  const stableRevision = Number(beforeFailure.rows[0].head_revision)
  const stableDocument = beforeFailure.rows[0].document
  const stableBatchCount = Number((await pool.query('SELECT count(*) FROM app_file_edit_batch WHERE file_id = $1', [fileId])).rows[0].count)
  await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sync acceptance rollback'; END $$`)
  await pool.query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON app_file FOR EACH ROW WHEN (NEW.id = '${fileId}'::uuid) EXECUTE FUNCTION ${functionName}()`)
  await assert.rejects(
    () => reopened.commit(commit({ clientMutationId: 'must-roll-back', baseRevision: stableRevision, edits: editName('Must not persist') })),
    /sync acceptance rollback/,
    'CLOUD-SYNC-PG-ATOMIC-001 injected head failure rejects the transaction',
  )
  await pool.query(`DROP TRIGGER ${triggerName} ON app_file`)
  await pool.query(`DROP FUNCTION ${functionName}()`)
  const afterFailure = await pool.query('SELECT file.head_revision, document.revision, document.document FROM app_file AS file INNER JOIN app_file_document AS document ON document.file_id = file.id WHERE file.id = $1', [fileId])
  assert.equal(Number(afterFailure.rows[0].head_revision), stableRevision, 'CLOUD-SYNC-PG-ATOMIC-001 head rolls back')
  assert.equal(Number(afterFailure.rows[0].revision), stableRevision, 'CLOUD-SYNC-PG-ATOMIC-001 document revision rolls back')
  assert.deepEqual(afterFailure.rows[0].document, stableDocument, 'CLOUD-SYNC-PG-ATOMIC-001 document bytes roll back')
  assert.equal(Number((await pool.query('SELECT count(*) FROM app_file_edit_batch WHERE file_id = $1', [fileId])).rows[0].count), stableBatchCount, 'CLOUD-SYNC-PG-ATOMIC-001 edit log rolls back')

  const invalid = await reopened.commit(commit({ clientMutationId: 'invalid-schema', baseRevision: stableRevision, edits: [{ type: 'delete', path: ['schemaVersion'] }] }))
  assert.equal(invalid.status, 'invalid_edit', 'CLOUD-SYNC-PG-ATOMIC-001 invalid documents fail closed')
  await pool.query("UPDATE app_file_document SET document = jsonb_set(document, '{revision}', to_jsonb(revision + 1)) WHERE file_id = $1", [fileId])
  await assert.rejects(
    () => reopened.open(fileId),
    /Document identity does not match its sync record/,
    'CLOUD-SYNC-PG-VALIDATION-001 mismatched stored document revisions are never normalized or returned',
  )
  await pool.query('UPDATE app_file_document SET document = $2::jsonb WHERE file_id = $1', [fileId, JSON.stringify(afterFailure.rows[0].document)])
  await pool.query("UPDATE app_file_document SET document = jsonb_set(document, '{pages}', '[]'::jsonb) WHERE file_id = $1", [fileId])
  await assert.rejects(() => reopened.open(fileId), undefined, 'CLOUD-SYNC-PG-VALIDATION-001 malformed stored document structure is never returned')
  await pool.query('UPDATE app_file_document SET document = $2::jsonb WHERE file_id = $1', [fileId, JSON.stringify(afterFailure.rows[0].document)])
  process.stdout.write('PostgreSQL sync acceptance passed: CLOUD-SYNC-PG-001, CLOUD-SYNC-PG-SEC-001, CLOUD-SYNC-PG-CONFLICT-001, CLOUD-SYNC-PG-RETENTION-001, CLOUD-SYNC-PG-APPEND-001, CLOUD-SYNC-PG-CAS-001, CLOUD-SYNC-PG-ATOMIC-001, CLOUD-SYNC-PG-VALIDATION-001.\n')
} finally {
  await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON app_file`).catch(() => undefined)
  await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined)
  await pool.query('DELETE FROM app_file WHERE id = $1', [fileId]).catch(() => undefined)
  await Promise.all([syncPool.end(), pool.end()])
}
