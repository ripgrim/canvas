import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { canonicalCollaborationJson, collaborationDocumentDigest, createPostgresCollaborationPersistence } from '../dist/collaboration.js'
import { applyMigrations, loadMigrations } from '../dist/migrations.js'
import { createPostgresControlPlane } from '../dist/postgres.js'

const rawConnectionString = process.env.COLLABORATION_TEST_DATABASE_URL
if (!rawConnectionString) throw new Error('COLLABORATION_TEST_DATABASE_URL is required.')
if (process.env.COLLABORATION_TEST_ALLOW_DISPOSABLE !== '1') throw new Error('Set COLLABORATION_TEST_ALLOW_DISPOSABLE=1 to confirm this is a disposable test database.')

const connectionUrl = new URL(rawConnectionString)
if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) throw new Error('The collaboration test URL must use PostgreSQL.')
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(connectionUrl.hostname)) throw new Error('The collaboration PostgreSQL acceptance test only permits loopback databases.')
if ([...connectionUrl.searchParams].length > 0) throw new Error('The collaboration PostgreSQL acceptance test does not permit connection-string query parameters.')
const databaseName = decodeURIComponent(connectionUrl.pathname.slice(1))
if (!/^design_editor_collab_test(?:_[a-z0-9_]+)?$/.test(databaseName)) throw new Error('The collaboration PostgreSQL acceptance test requires a database named design_editor_collab_test or design_editor_collab_test_<suffix>.')

const schemaName = `collaboration_acceptance_${randomUUID().replaceAll('-', '')}`
const quotedSchema = quoteIdentifier(schemaName)
const admin = new Pool({ connectionString: connectionUrl.toString(), max: 1 })
let testPool
let schemaCreated = false

try {
  const identity = await admin.query('SELECT current_database() AS database_name')
  assert.equal(identity.rows[0]?.database_name, databaseName)

  await admin.query(`CREATE SCHEMA ${quotedSchema}`)
  schemaCreated = true
  testPool = new Pool({ connectionString: connectionUrl.toString(), options: `-c search_path=${schemaName}`, max: 8 })
  assert.equal((await testPool.query('SELECT current_schema() AS schema_name')).rows[0]?.schema_name, schemaName)
  await applyMigrations(testPool, await loadMigrations(new URL('../migrations/', import.meta.url)))
  await runAcceptance(testPool)
  process.stdout.write(`PostgreSQL collaboration persistence acceptance slice passed in disposable schema ${schemaName}.\n`)
} finally {
  if (testPool) await testPool.end()
  if (schemaCreated) await admin.query(`DROP SCHEMA ${quotedSchema} CASCADE`)
  await admin.end()
}

async function runAcceptance(pool) {
  const persistence = currentSchemaPersistence(pool)
  const controlPlane = createPostgresControlPlane(pool)
  await assertCloudSyncClientCanonicalProjectionReads(pool, persistence, controlPlane)
  await assertBootstrapCutoverRace(pool, persistence, controlPlane)
  await assertUniformLockOrderRace(pool)
  await assertAdmissionLockOrderRace(pool, controlPlane)
  await assertAdmissionReplacementRollback(pool, controlPlane)
  await assertLegacyMigrationRollback(pool, controlPlane)
  const admissionFile = await controlPlane.createFile('admission-owner', 'Admission convergence', null)
  const proposedAdmissionA = randomUUID()
  const proposedAdmissionB = randomUUID()
  const admissionResults = await Promise.all([
    persistence.resolveAdmissionGeneration({ fileId: admissionFile.id, generationId: proposedAdmissionA, protocolEpoch: 3, candidateTtlMs: 30_000 }),
    persistence.resolveAdmissionGeneration({ fileId: admissionFile.id, generationId: proposedAdmissionB, protocolEpoch: 3, candidateTtlMs: 30_000 }),
  ])
  assert.equal(admissionResults[0].status, 'candidate')
  assert.equal(admissionResults[1].status, 'candidate')
  assert.equal(admissionResults[0].generationId, admissionResults[1].generationId)
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM app_collaboration_generation WHERE file_id = $1 AND status = 'candidate'", [admissionFile.id])).rows[0].count, 1)
  await pool.query("UPDATE app_collaboration_generation SET created_at = now() - interval '1 minute' WHERE file_id = $1 AND status = 'candidate'", [admissionFile.id])
  const replacementAdmissionId = randomUUID()
  const replacementAdmission = await persistence.resolveAdmissionGeneration({ fileId: admissionFile.id, generationId: replacementAdmissionId, protocolEpoch: 3, candidateTtlMs: 30_000 })
  assert.deepEqual(replacementAdmission, { status: 'candidate', generationId: replacementAdmissionId })
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM app_collaboration_generation WHERE file_id = $1 AND status = 'failed'", [admissionFile.id])).rows[0].count, 1)
  const file = await controlPlane.createFile('collaboration-acceptance', 'Collaboration acceptance', null)
  const fileId = file.id
  const candidateA = randomUUID()
  const candidateB = randomUUID()
  const replacementGeneration = randomUUID()
  assert.deepEqual(await controlPlane.resolveFileAccess('collaboration-acceptance', fileId), { fileId, subjectUserId: 'collaboration-acceptance', role: 'owner', accessEpoch: 1n })
  assert.equal(await controlPlane.resolveFileAccess('collaboration-viewer', fileId), null)
  await controlPlane.setFileShare('collaboration-acceptance', fileId, 'view')
  assert.deepEqual(await controlPlane.resolveFileAccess('collaboration-viewer', fileId), { fileId, subjectUserId: 'collaboration-viewer', role: 'viewer', accessEpoch: 2n })
  await controlPlane.setFileShare('collaboration-acceptance', fileId, 'view')
  assert.equal((await controlPlane.resolveFileAccess('collaboration-acceptance', fileId)).accessEpoch, 2n)
  await controlPlane.setFileShare('collaboration-acceptance', fileId, 'private')
  assert.equal(await controlPlane.resolveFileAccess('collaboration-viewer', fileId), null)
  assert.equal((await controlPlane.resolveFileAccess('collaboration-acceptance', fileId)).accessEpoch, 3n)
  const immutableOwnerFile = await controlPlane.createFile('first-owner', 'Immutable owner', null)
  await pool.query("UPDATE app_file SET name = 'Renamed without ownership change' WHERE id = $1", [immutableOwnerFile.id])
  assert.equal((await controlPlane.resolveFileAccess('first-owner', immutableOwnerFile.id)).accessEpoch, 1n)
  await assert.rejects(pool.query("UPDATE app_file SET owner_user_id = 'second-owner' WHERE id = $1", [immutableOwnerFile.id]), /owner identity is immutable/)
  assert.equal((await controlPlane.resolveFileAccess('first-owner', immutableOwnerFile.id)).role, 'owner')
  assert.equal(await controlPlane.resolveFileAccess('second-owner', immutableOwnerFile.id), null)

  const shareMoveSource = await controlPlane.createFile('share-owner', 'Share source', null)
  const shareMoveTarget = await controlPlane.createFile('share-owner', 'Share target', null)
  await controlPlane.setFileShare('share-owner', shareMoveSource.id, 'view')
  await assert.rejects(pool.query('UPDATE app_file_share SET file_id = $2 WHERE file_id = $1', [shareMoveSource.id, shareMoveTarget.id]), /app_file_share identity is immutable/)
  await assert.rejects(pool.query("UPDATE app_file_share SET owner_user_id = 'different-owner' WHERE file_id = $1", [shareMoveSource.id]), /app_file_share identity is immutable/)
  assert.equal((await controlPlane.resolveFileAccess('share-viewer', shareMoveSource.id)).accessEpoch, 2n)
  assert.equal(await controlPlane.resolveFileAccess('share-viewer', shareMoveTarget.id), null)
  assert.equal((await controlPlane.resolveFileAccess('share-owner', shareMoveTarget.id)).accessEpoch, 1n)

  const maxEpochFile = await controlPlane.createFile('max-owner', 'Maximum epoch', null)
  await controlPlane.setFileShare('max-owner', maxEpochFile.id, 'view')
  await pool.query('UPDATE app_file SET access_epoch = 9223372036854775807 WHERE id = $1', [maxEpochFile.id])
  await assert.rejects(pool.query('DELETE FROM app_file_share WHERE file_id = $1', [maxEpochFile.id]), /access epoch is exhausted/)
  assert.equal((await controlPlane.resolveFileAccess('max-viewer', maxEpochFile.id)).role, 'viewer')
  assert.equal((await controlPlane.resolveFileAccess('max-owner', maxEpochFile.id)).accessEpoch, 9_223_372_036_854_775_807n)
  await pool.query('DELETE FROM app_file WHERE id = $1', [maxEpochFile.id])
  assert.equal(await controlPlane.resolveFileAccess('max-owner', maxEpochFile.id), null)
  await Promise.all([
    persistence.registerGeneration({ fileId, generationId: candidateA, protocolEpoch: 3 }),
    persistence.registerGeneration({ fileId, generationId: candidateB, protocolEpoch: 3 }),
  ])

  const raced = await Promise.all([
    persistence.acquireLease({ fileId, generationId: candidateA, protocolEpoch: 3, leaseDurationMs: 30_000 }),
    persistence.acquireLease({ fileId, generationId: candidateB, protocolEpoch: 3, leaseDurationMs: 30_000 }),
  ])
  const acquired = raced.filter(result => result.status === 'acquired')
  const held = raced.filter(result => result.status === 'held')
  assert.equal(acquired.length, 1)
  assert.equal(held.length, 1)
  const winner = acquired[0].lease
  const waitingGeneration = winner.generationId === candidateA ? candidateB : candidateA
  assert.equal(held[0].lease.generationId, winner.generationId)
  assert.equal((await persistence.renewLease({ fileId, generationId: winner.generationId, protocolEpoch: 3, fencingToken: winner.fencingToken, leaseDurationMs: 30_000 }))?.fencingToken, winner.fencingToken)
  assert.equal(await persistence.releaseLease({ fileId, generationId: winner.generationId, protocolEpoch: 3, fencingToken: winner.fencingToken }), true)
  assert.equal(await persistence.releaseLease({ fileId, generationId: winner.generationId, protocolEpoch: 3, fencingToken: winner.fencingToken }), true)

  const expiring = await persistence.acquireLease({ fileId, generationId: waitingGeneration, protocolEpoch: 3, leaseDurationMs: 1_000 })
  assert.equal(expiring.status, 'acquired')
  await pool.query("UPDATE app_collaboration_lease SET lease_expires_at = now() - interval '1 second' WHERE file_id = $1", [fileId])
  assert.equal((await persistence.registerGeneration({ fileId, generationId: replacementGeneration, protocolEpoch: 3 })).status, 'registered')
  const replacement = await persistence.acquireLease({ fileId, generationId: replacementGeneration, protocolEpoch: 3, leaseDurationMs: 30_000 })
  assert.equal(replacement.status, 'acquired')
  assert.ok(replacement.lease.fencingToken > expiring.lease.fencingToken)
  assert.equal(await persistence.renewLease({ fileId, generationId: waitingGeneration, protocolEpoch: 3, fencingToken: expiring.lease.fencingToken, leaseDurationMs: 30_000 }), null)

  const staleAppend = await persistence.appendOperation(operationInput({ fileId, lease: expiring.lease, mutationId: 'stale-append', baseSequence: 0n, revision: 1, name: 'Stale', expectedAccessEpoch: 3n }))
  assert.equal(staleAppend.status, 'stale-fence')
  assert.equal((await persistence.bootstrapProjectionFromLegacy({ fileId, generationId: waitingGeneration, protocolEpoch: 3, fencingToken: expiring.lease.fencingToken, documentSchemaVersion: 9 })).status, 'stale-fence')
  const staleCheckpoint = await persistence.commitVerifiedCheckpoint({
    fileId,
    generationId: waitingGeneration,
    protocolEpoch: 3,
    fencingToken: expiring.lease.fencingToken,
    sequence: 0n,
    objectKey: `checkpoints/${fileId}/stale.zst`,
    objectDigest: 'f'.repeat(64),
    documentDigest: 'e'.repeat(64),
    compressedBytes: 64n,
    documentSchemaVersion: 9,
  })
  assert.equal(staleCheckpoint.status, 'stale-fence')

  const legacyInitial = await controlPlane.getFileDocument('collaboration-acceptance', fileId)
  const legacyBeforeCutover = { ...legacyInitial.document, revision: 1, beforeCutover: true }
  assert.equal((await controlPlane.saveFileDocument('collaboration-acceptance', fileId, 0, legacyBeforeCutover)).status, 'saved')
  const legacyThumbnailKey = `thumbnails/${fileId}/versions/1/before-cutover.avif`
  assert.equal((await controlPlane.setFileThumbnail('collaboration-acceptance', fileId, 1, legacyThumbnailKey, '"before-cutover"')).status, 'saved')

  const bootstrapInput = { fileId, generationId: replacementGeneration, protocolEpoch: 3, fencingToken: replacement.lease.fencingToken, documentSchemaVersion: 9 }
  const bootstrapped = await Promise.all([
    persistence.bootstrapProjectionFromLegacy(bootstrapInput),
    persistence.bootstrapProjectionFromLegacy(bootstrapInput),
  ])
  assert.deepEqual(bootstrapped.map(result => result.status).sort(), ['replayed', 'seeded'])
  assert.ok(bootstrapped.every(result => result.cutoverAuthority === 'snapshot-seed'))
  assert.ok(bootstrapped.every(result => result.projection.sequence === 0n && result.projection.authority === 'legacy-seed'))
  assert.deepEqual(await controlPlane.saveFileDocument('collaboration-acceptance', fileId, 1, { ...legacyBeforeCutover, revision: 2, afterBootstrap: true }), { status: 'collaboration-authoritative' })

  const priorAuthorization = await controlPlane.resolveFileAccess('collaboration-acceptance', fileId)
  assert.equal(priorAuthorization.accessEpoch, 3n)
  await controlPlane.setFileShare('collaboration-acceptance', fileId, 'view')
  const racedAuthorizationInput = operationInput({ fileId, lease: replacement.lease, mutationId: 'mutation-raced-authorization', baseSequence: 0n, revision: 1, name: 'Rejected', expectedAccessEpoch: priorAuthorization.accessEpoch })
  assert.deepEqual(await persistence.appendOperation(racedAuthorizationInput), { status: 'access-conflict', currentAccessEpoch: 4n })
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM app_collaboration_operation WHERE file_id = $1 AND client_mutation_id = 'mutation-raced-authorization'", [fileId])).rows[0].count, 0)
  assert.equal((await persistence.getProjection(fileId)).sequence, 0n)

  const firstInput = operationInput({ fileId, lease: replacement.lease, mutationId: 'mutation-1', baseSequence: 0n, revision: 1, name: 'Card', expectedAccessEpoch: 4n })
  assert.equal((await persistence.appendOperation(firstInput)).status, 'committed')
  const authoritativeProjection = await persistence.getProjection(fileId)
  assert.equal(authoritativeProjection.authority, 'room')
  const canonicalDocument = await controlPlane.getFileDocument('collaboration-acceptance', fileId)
  assert.deepEqual(await controlPlane.saveFileDocument('collaboration-acceptance', fileId, 1, { ...canonicalDocument.document, revision: 2, legacyAfterCutover: true }), { status: 'collaboration-authoritative' })
  assert.deepEqual(await controlPlane.saveFileDocument('different-user', fileId, 1, { revision: 2 }), { status: 'not-found' })
  const canonicalAfterRejectedSave = await controlPlane.getFileDocument('collaboration-acceptance', fileId)
  assert.equal(canonicalAfterRejectedSave.revision, 1)
  assert.equal(canonicalAfterRejectedSave.document.name, 'Card')
  assert.equal(canonicalAfterRejectedSave.document.beforeCutover, undefined)
  assert.equal(canonicalAfterRejectedSave.document.legacyAfterCutover, undefined)
  const staleLegacyDocument = (await pool.query('SELECT document FROM app_file_document WHERE file_id = $1', [fileId])).rows[0].document
  assert.equal(staleLegacyDocument.beforeCutover, true)
  assert.equal(staleLegacyDocument.name, undefined)
  assert.equal((await controlPlane.getFile('collaboration-acceptance', fileId)).headRevision, 1)
  assert.equal((await controlPlane.getFileThumbnail('collaboration-acceptance', fileId)).thumbnailKey, legacyThumbnailKey)
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM app_thumbnail_capture_job WHERE file_id = $1 AND revision = 2', [fileId])).rows[0].count, 0)
  await assert.rejects(pool.query('UPDATE app_file_document SET revision = 2 WHERE file_id = $1', [fileId]), /collaboration authoritative/)
  const preserved = await persistence.bootstrapProjectionFromLegacy(bootstrapInput)
  assert.equal(preserved.status, 'existing-projection')
  assert.equal(preserved.cutoverAuthority, 'room-authority')
  assert.equal(preserved.projection.documentDigest, authoritativeProjection.documentDigest)
  assert.equal((await persistence.appendOperation({ ...firstInput, operationPayload: { name: 'Card', kind: 'rename' } })).status, 'replayed')
  assert.equal((await persistence.appendOperation({ ...firstInput, operationPayload: { kind: 'rename', name: 'Different' } })).status, 'mutation-conflict')

  const secondInput = operationInput({ fileId, lease: replacement.lease, mutationId: 'mutation-2', baseSequence: 1n, revision: 2, name: 'Panel', expectedAccessEpoch: 4n })
  assert.equal((await persistence.appendOperation(secondInput)).status, 'committed')

  await pool.query(`CREATE FUNCTION collaboration_acceptance_fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.document ->> 'failureMarker' = 'rollback' THEN
        RAISE EXCEPTION 'forced projection failure';
      END IF;
      RETURN NEW;
    END
  $$`)
  await pool.query('CREATE TRIGGER collaboration_acceptance_fail_projection BEFORE INSERT OR UPDATE ON app_collaboration_projection FOR EACH ROW EXECUTE FUNCTION collaboration_acceptance_fail_projection()')
  const rollbackInput = operationInput({ fileId, lease: replacement.lease, mutationId: 'mutation-rollback', baseSequence: 2n, revision: 3, name: 'Rollback', failureMarker: 'rollback', expectedAccessEpoch: 4n })
  await assert.rejects(persistence.appendOperation(rollbackInput), /forced projection failure/)
  const rolledBack = await pool.query("SELECT count(*)::int AS count FROM app_collaboration_operation WHERE file_id = $1 AND client_mutation_id = 'mutation-rollback'", [fileId])
  assert.equal(rolledBack.rows[0].count, 0)
  assert.equal((await persistence.getProjection(fileId)).sequence, 2n)

  assert.equal((await persistence.pruneCoveredOperations({ fileId, generationId: replacementGeneration, protocolEpoch: 3, fencingToken: replacement.lease.fencingToken, throughSequence: 1n })).status, 'no-committed-checkpoint')
  const projection = await persistence.getProjection(fileId)
  const checkpointInput = {
    fileId,
    generationId: replacementGeneration,
    protocolEpoch: 3,
    fencingToken: replacement.lease.fencingToken,
    sequence: 2n,
    objectKey: `checkpoints/${fileId}/2.zst`,
    objectDigest: 'a'.repeat(64),
    documentDigest: projection.documentDigest,
    compressedBytes: 256n,
    documentSchemaVersion: 9,
  }
  assert.equal((await persistence.commitVerifiedCheckpoint(checkpointInput)).status, 'committed')
  assert.equal((await persistence.commitVerifiedCheckpoint(checkpointInput)).status, 'replayed')
  assert.equal((await persistence.commitVerifiedCheckpoint({ ...checkpointInput, objectKey: `checkpoints/${fileId}/different.zst` })).status, 'checkpoint-conflict')
  assert.equal((await persistence.getCheckpoint(fileId)).sequence, 2n)

  const thirdInput = operationInput({ fileId, lease: replacement.lease, mutationId: 'mutation-3', baseSequence: 2n, revision: 3, name: 'Toolbar', expectedAccessEpoch: 4n })
  assert.equal((await persistence.appendOperation(thirdInput)).status, 'committed')
  const beyond = await persistence.pruneCoveredOperations({ fileId, generationId: replacementGeneration, protocolEpoch: 3, fencingToken: replacement.lease.fencingToken, throughSequence: 3n })
  assert.deepEqual(beyond, { status: 'beyond-checkpoint', checkpointSequence: 2n })
  const stalePrune = await persistence.pruneCoveredOperations({ fileId, generationId: waitingGeneration, protocolEpoch: 3, fencingToken: expiring.lease.fencingToken, throughSequence: 2n })
  assert.equal(stalePrune.status, 'stale-fence')
  const pruned = await persistence.pruneCoveredOperations({ fileId, generationId: replacementGeneration, protocolEpoch: 3, fencingToken: replacement.lease.fencingToken, throughSequence: 2n })
  assert.deepEqual(pruned, { status: 'pruned', throughSequence: 2n, deletedCount: 2n })
  const remaining = await persistence.listOperationsAfter(fileId, 0n, 10)
  assert.deepEqual(remaining.map(operation => operation.sequence), [3n])
}

async function assertCloudSyncClientCanonicalProjectionReads(pool, persistence, controlPlane) {
  const ownerUserId = 'canonical-read-owner'
  const file = await controlPlane.createFile(ownerUserId, 'Canonical projection read', null)
  const initial = await controlPlane.getFileDocument(ownerUserId, file.id)
  const legacyDocument = {
    ...initial.document,
    revision: 1,
    pages: initial.document.pages.map((page, index) => index === 0 ? { ...page, name: 'Seed' } : page),
  }
  assert.equal((await controlPlane.saveFileDocument(ownerUserId, file.id, 0, legacyDocument)).status, 'saved')
  await pool.query("UPDATE app_file_document SET updated_at = now() - interval '1 day' WHERE file_id = $1", [file.id])
  await controlPlane.setFileShare(ownerUserId, file.id, 'view')

  const generationId = randomUUID()
  assert.equal((await persistence.registerGeneration({ fileId: file.id, generationId, protocolEpoch: 3 })).status, 'registered')
  const acquired = await persistence.acquireLease({ fileId: file.id, generationId, protocolEpoch: 3, leaseDurationMs: 30_000 })
  assert.equal(acquired.status, 'acquired')
  const bootstrapInput = { fileId: file.id, generationId, protocolEpoch: 3, fencingToken: acquired.lease.fencingToken, documentSchemaVersion: 9 }
  assert.equal((await persistence.bootstrapProjectionFromLegacy(bootstrapInput)).status, 'seeded')

  const unpublishedDocument = {
    ...legacyDocument,
    revision: 999,
    pages: legacyDocument.pages.map((page, index) => index === 0 ? { ...page, name: 'Unpublished projection' } : page),
  }
  await pool.query(
    'UPDATE app_collaboration_projection SET document = $2::jsonb, document_digest = $3 WHERE file_id = $1',
    [file.id, JSON.stringify(unpublishedDocument), collaborationDocumentDigest(unpublishedDocument)],
  )
  const legacySeedRead = await controlPlane.getFileDocument(ownerUserId, file.id)
  assert.equal(legacySeedRead.revision, 1)
  assert.equal(legacySeedRead.document.pages[0].name, 'Seed')
  const legacySeedCapture = await controlPlane.getFileDocumentForCapture(file.id)
  assert.equal(legacySeedCapture.revision, 1)
  assert.equal(legacySeedCapture.document.pages[0].name, 'Seed')
  const legacySeedShared = await controlPlane.getSharedFile(file.id)
  assert.equal(legacySeedShared.file.headRevision, 1)
  assert.equal(legacySeedShared.document.revision, 1)
  assert.equal(legacySeedShared.document.document.pages[0].name, 'Seed')

  const liveDocument = {
    ...legacyDocument,
    revision: 7,
    pages: legacyDocument.pages.map((page, index) => index === 0 ? { ...page, name: 'Live' } : page),
  }
  const appended = await persistence.appendOperation({
    fileId: file.id,
    generationId,
    protocolEpoch: 3,
    fencingToken: acquired.lease.fencingToken,
    expectedSubjectId: ownerUserId,
    expectedAccessEpoch: 2n,
    clientId: 'canonical-read-client',
    clientMutationId: 'canonical-read-mutation',
    operationType: 'page.rename',
    operationPayload: { pageId: legacyDocument.pages[0].id, name: 'Live' },
    baseSequence: 0n,
    projection: { documentSchemaVersion: 9, document: liveDocument },
  })
  assert.equal(appended.status, 'committed')

  const staleLegacyRow = (await pool.query('SELECT revision, document, updated_at FROM app_file_document WHERE file_id = $1', [file.id])).rows[0]
  const projectionRow = (await pool.query('SELECT document, document_digest, updated_at FROM app_collaboration_projection WHERE file_id = $1', [file.id])).rows[0]
  assert.equal(Number(staleLegacyRow.revision), 1)
  assert.equal(staleLegacyRow.document.pages[0].name, 'Seed')

  const ownerRead = await controlPlane.getFileDocument(ownerUserId, file.id)
  assert.equal(ownerRead.revision, 7)
  assert.equal(ownerRead.document.revision, 7)
  assert.equal(ownerRead.document.pages[0].name, 'Live')
  assert.equal(ownerRead.updatedAt, new Date(projectionRow.updated_at).toISOString())
  assert.notEqual(ownerRead.updatedAt, new Date(staleLegacyRow.updated_at).toISOString())
  assert.notEqual(ownerRead.document.pages[0].name, staleLegacyRow.document.pages[0].name)
  assert.equal(await controlPlane.getFileDocument('canonical-read-other-owner', file.id), null)

  const captureRead = await controlPlane.getFileDocumentForCapture(file.id)
  assert.equal(captureRead.revision, 7)
  assert.equal(captureRead.document.pages[0].name, 'Live')
  assert.equal(captureRead.updatedAt, new Date(projectionRow.updated_at).toISOString())

  const sharedRead = await controlPlane.getSharedFile(file.id)
  assert.equal(sharedRead.file.headRevision, 7)
  assert.equal(sharedRead.document.revision, 7)
  assert.equal(sharedRead.document.document.pages[0].name, 'Live')
  assert.equal(sharedRead.document.updatedAt, new Date(projectionRow.updated_at).toISOString())

  const { revision: _revision, ...missingRevision } = liveDocument
  for (const malformed of [missingRevision, { ...liveDocument, revision: '' }, { ...liveDocument, revision: '7' }, { ...liveDocument, revision: '   ' }, { ...liveDocument, revision: 7.5 }]) {
    await pool.query('UPDATE app_collaboration_projection SET document = $2::jsonb WHERE file_id = $1', [file.id, JSON.stringify(malformed)])
    await assert.rejects(controlPlane.getFileDocument(ownerUserId, file.id), /invalid revision/)
    await assert.rejects(controlPlane.getFileDocumentForCapture(file.id), /invalid revision/)
    await assert.rejects(controlPlane.getSharedFile(file.id), /invalid revision/)
  }
  await pool.query(
    'UPDATE app_collaboration_projection SET document = $2::jsonb, document_digest = $3, updated_at = $4 WHERE file_id = $1',
    [file.id, JSON.stringify(projectionRow.document), projectionRow.document_digest, projectionRow.updated_at],
  )
}

async function assertAdmissionLockOrderRace(pool, controlPlane) {
  const persistence = currentSchemaPersistence(pool)
  const file = await controlPlane.createFile('admission-lock-owner', 'Admission lock order', null)
  await pool.query('INSERT INTO app_collaboration_lease (file_id) VALUES ($1)', [file.id])
  const blocker = await pool.connect()
  await blocker.query('BEGIN')
  await blocker.query('SELECT id FROM app_file WHERE id = $1 FOR UPDATE', [file.id])
  try {
    const resolution = persistence.resolveAdmissionGeneration({ fileId: file.id, generationId: randomUUID(), protocolEpoch: 3, candidateTtlMs: 30_000 })
    await waitForRowLockWaiter(pool)
    await blocker.query('SELECT file_id FROM app_collaboration_lease WHERE file_id = $1 FOR UPDATE', [file.id])
    await blocker.query('COMMIT')
    assert.equal((await bounded(resolution, 'admission lock-order race')).status, 'candidate')
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
  }
}

async function assertAdmissionReplacementRollback(pool, controlPlane) {
  const persistence = currentSchemaPersistence(pool)
  const file = await controlPlane.createFile('admission-rollback-owner', 'Admission rollback', null)
  const staleId = randomUUID()
  assert.equal((await persistence.registerGeneration({ fileId: file.id, generationId: staleId, protocolEpoch: 3 })).status, 'registered')
  await pool.query("UPDATE app_collaboration_generation SET created_at = now() - interval '1 minute' WHERE file_id = $1 AND generation_id = $2", [file.id, staleId])
  await pool.query(`CREATE FUNCTION collaboration_acceptance_fail_admission_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.file_id = '${file.id}'::uuid THEN
        RAISE EXCEPTION 'forced admission insertion failure';
      END IF;
      RETURN NEW;
    END
  $$`)
  await pool.query('CREATE TRIGGER collaboration_acceptance_fail_admission_insert BEFORE INSERT ON app_collaboration_generation FOR EACH ROW EXECUTE FUNCTION collaboration_acceptance_fail_admission_insert()')
  try {
    await assert.rejects(
      persistence.resolveAdmissionGeneration({ fileId: file.id, generationId: randomUUID(), protocolEpoch: 3, candidateTtlMs: 30_000 }),
      /forced admission insertion failure/,
    )
    assert.equal((await pool.query('SELECT status FROM app_collaboration_generation WHERE file_id = $1 AND generation_id = $2', [file.id, staleId])).rows[0].status, 'candidate')
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS collaboration_acceptance_fail_admission_insert ON app_collaboration_generation')
    await pool.query('DROP FUNCTION IF EXISTS collaboration_acceptance_fail_admission_insert()')
  }
}

async function assertBootstrapCutoverRace(pool, persistence, controlPlane) {
  const file = await controlPlane.createFile('cutover-race-owner', 'Cutover race', null)
  const generationId = randomUUID()
  assert.equal((await persistence.registerGeneration({ fileId: file.id, generationId, protocolEpoch: 3 })).status, 'registered')
  const acquired = await persistence.acquireLease({ fileId: file.id, generationId, protocolEpoch: 3, leaseDurationMs: 30_000 })
  assert.equal(acquired.status, 'acquired')

  const advisoryKey = 1_143_920_117
  const blocker = await pool.connect()
  await blocker.query('BEGIN')
  await blocker.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey])
  await pool.query(`CREATE FUNCTION collaboration_acceptance_pause_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${advisoryKey});
      RETURN NEW;
    END
  $$`)
  await pool.query('CREATE TRIGGER collaboration_acceptance_pause_projection BEFORE INSERT ON app_collaboration_projection FOR EACH ROW EXECUTE FUNCTION collaboration_acceptance_pause_projection()')

  try {
    const bootstrap = persistence.bootstrapProjectionFromLegacy({
      fileId: file.id,
      generationId,
      protocolEpoch: 3,
      fencingToken: acquired.lease.fencingToken,
      documentSchemaVersion: 9,
    })
    await waitForAdvisoryWaiter(pool)
    const source = await controlPlane.getFileDocument('cutover-race-owner', file.id)
    const legacySave = controlPlane.saveFileDocument('cutover-race-owner', file.id, 0, { ...source.document, revision: 1, racedLegacySave: true })
    await blocker.query('COMMIT')

    assert.equal((await bootstrap).status, 'seeded')
    assert.deepEqual(await legacySave, { status: 'collaboration-authoritative' })
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    await pool.query('DROP TRIGGER IF EXISTS collaboration_acceptance_pause_projection ON app_collaboration_projection')
    await pool.query('DROP FUNCTION IF EXISTS collaboration_acceptance_pause_projection()')
  }

  const preserved = await controlPlane.getFileDocument('cutover-race-owner', file.id)
  assert.equal(preserved.revision, 0)
  assert.equal(preserved.document.racedLegacySave, undefined)
  await assert.rejects(pool.query('UPDATE app_file_document SET revision = 1 WHERE file_id = $1', [file.id]), /collaboration authoritative/)
}

async function assertUniformLockOrderRace(pool) {
  const persistence = currentSchemaPersistence(pool)
  const controlPlane = createPostgresControlPlane(pool)
  const file = await controlPlane.createFile('lock-order-owner', 'Lock order race', null)
  const generationId = randomUUID()
  assert.equal((await persistence.registerGeneration({ fileId: file.id, generationId, protocolEpoch: 3 })).status, 'registered')
  const acquired = await persistence.acquireLease({ fileId: file.id, generationId, protocolEpoch: 3, leaseDurationMs: 30_000 })
  assert.equal(acquired.status, 'acquired')
  const lease = acquired.lease
  const bootstrapInput = { fileId: file.id, generationId, protocolEpoch: 3, fencingToken: lease.fencingToken, documentSchemaVersion: 9 }
  assert.equal((await persistence.bootstrapProjectionFromLegacy(bootstrapInput)).status, 'seeded')
  const firstInput = operationInput({ fileId: file.id, lease, mutationId: 'lock-order-mutation', baseSequence: 0n, revision: 1, name: 'Lock order', expectedSubjectId: 'lock-order-owner', expectedAccessEpoch: 1n })
  assert.equal((await persistence.appendOperation(firstInput)).status, 'committed')
  const projection = await persistence.getProjection(file.id)
  const checkpointInput = {
    fileId: file.id,
    generationId,
    protocolEpoch: 3,
    fencingToken: lease.fencingToken,
    sequence: 1n,
    objectKey: `checkpoints/${file.id}/lock-order.zst`,
    objectDigest: 'c'.repeat(64),
    documentDigest: projection.documentDigest,
    compressedBytes: 128n,
    documentSchemaVersion: 9,
  }

  const appendBarrier = queryBarrier()
  const appendPersistence = currentSchemaPersistence(instrumentedPool(pool, appendBarrier))
  const checkpointPersistence = currentSchemaPersistence(instrumentedPool(pool))
  const replayAttempt = appendPersistence.appendOperation(firstInput)
  await appendBarrier.wait()
  const checkpointAttempt = checkpointPersistence.commitVerifiedCheckpoint(checkpointInput)
  await waitForRowLockWaiter(pool)
  appendBarrier.open()
  const [replay, checkpoint] = await bounded(Promise.all([replayAttempt, checkpointAttempt]), 'append and checkpoint lock-order race')
  assert.equal(replay.status, 'replayed')
  assert.equal(checkpoint.status, 'committed')

  const bootstrapBarrier = queryBarrier()
  const bootstrapPersistence = currentSchemaPersistence(instrumentedPool(pool, bootstrapBarrier))
  const prunePersistence = currentSchemaPersistence(instrumentedPool(pool))
  const bootstrapAttempt = bootstrapPersistence.bootstrapProjectionFromLegacy(bootstrapInput)
  await bootstrapBarrier.wait()
  const pruneAttempt = prunePersistence.pruneCoveredOperations({ fileId: file.id, generationId, protocolEpoch: 3, fencingToken: lease.fencingToken, throughSequence: 1n })
  await waitForRowLockWaiter(pool)
  bootstrapBarrier.open()
  const [bootstrap, prune] = await bounded(Promise.all([bootstrapAttempt, pruneAttempt]), 'bootstrap and prune lock-order race')
  assert.equal(bootstrap.status, 'existing-projection')
  assert.deepEqual(prune, { status: 'pruned', throughSequence: 1n, deletedCount: 1n })
}

async function assertLegacyMigrationRollback(pool, controlPlane) {
  const file = await controlPlane.createFile('legacy-migration-owner', 'Legacy migration rollback', null)
  const generationId = randomUUID()
  const current = await controlPlane.getFileDocument('legacy-migration-owner', file.id)
  const source = { ...current.document, schemaVersion: 6, assets: {}, migrationRollbackMarker: 'rollback' }
  const { assets: _assets, ...assetFreeSource } = source
  const expected = { ...assetFreeSource, schemaVersion: 9 }
  await pool.query('UPDATE app_file_document SET document = $2::jsonb WHERE file_id = $1', [file.id, JSON.stringify(source)])
  const persistence = createPostgresCollaborationPersistence(pool, {
    migrateLegacyDocument(document, targetSchemaVersion) {
      if (canonicalCollaborationJson(document) !== canonicalCollaborationJson(source) || targetSchemaVersion !== 9) return { status: 'unsupported', reason: 'document-invalid' }
      return { status: 'migrated', document: expected }
    },
    validateLegacyDocument({ sourceDocument, document, targetSchemaVersion }) {
      const valid = targetSchemaVersion === 9
        && canonicalCollaborationJson(sourceDocument) === canonicalCollaborationJson(source)
        && canonicalCollaborationJson(document) === canonicalCollaborationJson(expected)
      return valid ? { status: 'valid' } : { status: 'invalid', reason: 'document-invalid' }
    },
  })
  assert.equal((await persistence.registerGeneration({ fileId: file.id, generationId, protocolEpoch: 3 })).status, 'registered')
  const acquired = await persistence.acquireLease({ fileId: file.id, generationId, protocolEpoch: 3, leaseDurationMs: 30_000 })
  assert.equal(acquired.status, 'acquired')
  const input = { fileId: file.id, generationId, protocolEpoch: 3, fencingToken: acquired.lease.fencingToken, documentSchemaVersion: 9 }

  await pool.query(`CREATE FUNCTION collaboration_acceptance_fail_legacy_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.file_id = '${file.id}'::uuid THEN
        RAISE EXCEPTION 'forced legacy projection failure';
      END IF;
      RETURN NEW;
    END
  $$`)
  await pool.query('CREATE TRIGGER collaboration_acceptance_fail_legacy_projection BEFORE INSERT ON app_collaboration_projection FOR EACH ROW EXECUTE FUNCTION collaboration_acceptance_fail_legacy_projection()')
  try {
    await assert.rejects(persistence.bootstrapProjectionFromLegacy(input), /forced legacy projection failure/)
    const rolledBack = await pool.query('SELECT document FROM app_file_document WHERE file_id = $1', [file.id])
    assert.deepEqual(rolledBack.rows[0]?.document, source)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app_collaboration_projection WHERE file_id = $1', [file.id])).rows[0]?.count, 0)
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS collaboration_acceptance_fail_legacy_projection ON app_collaboration_projection')
    await pool.query('DROP FUNCTION IF EXISTS collaboration_acceptance_fail_legacy_projection()')
  }

  assert.equal((await persistence.bootstrapProjectionFromLegacy(input)).status, 'seeded')
  assert.deepEqual((await pool.query('SELECT document FROM app_file_document WHERE file_id = $1', [file.id])).rows[0]?.document, expected)

  const hostileFile = await controlPlane.createFile('legacy-migration-owner', 'In-place migration isolation', null)
  const hostileGenerationId = randomUUID()
  const hostileCurrent = await controlPlane.getFileDocument('legacy-migration-owner', hostileFile.id)
  const hostileSource = { ...hostileCurrent.document, schemaVersion: 6, assets: {} }
  await pool.query('UPDATE app_file_document SET document = $2::jsonb WHERE file_id = $1', [hostileFile.id, JSON.stringify(hostileSource)])
  const hostile = createPostgresCollaborationPersistence(pool, {
    migrateLegacyDocument(document) {
      document.schemaVersion = 9
      document.revision = 999
      return { status: 'migrated', document }
    },
    validateLegacyDocument({ sourceDocument, document }) {
      return canonicalCollaborationJson(sourceDocument) === canonicalCollaborationJson(document)
        ? { status: 'valid' }
        : { status: 'invalid', reason: 'document-invalid' }
    },
  })
  assert.equal((await hostile.registerGeneration({ fileId: hostileFile.id, generationId: hostileGenerationId, protocolEpoch: 3 })).status, 'registered')
  const hostileLease = await hostile.acquireLease({ fileId: hostileFile.id, generationId: hostileGenerationId, protocolEpoch: 3, leaseDurationMs: 30_000 })
  assert.equal(hostileLease.status, 'acquired')
  assert.deepEqual(await hostile.bootstrapProjectionFromLegacy({ fileId: hostileFile.id, generationId: hostileGenerationId, protocolEpoch: 3, fencingToken: hostileLease.lease.fencingToken, documentSchemaVersion: 9 }), { status: 'invalid-source', reason: 'document-invalid' })
  assert.deepEqual((await pool.query('SELECT document FROM app_file_document WHERE file_id = $1', [hostileFile.id])).rows[0]?.document, hostileSource)
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM app_collaboration_projection WHERE file_id = $1', [hostileFile.id])).rows[0]?.count, 0)
}

function currentSchemaPersistence(pool) {
  return createPostgresCollaborationPersistence(pool, {
    validateLegacyDocument({ sourceDocument, document, targetSchemaVersion }) {
      const valid = sourceDocument.schemaVersion === targetSchemaVersion
        && document.schemaVersion === targetSchemaVersion
        && sourceDocument.fileId === document.fileId
        && canonicalCollaborationJson(sourceDocument) === canonicalCollaborationJson(document)
      return valid ? { status: 'valid' } : { status: 'invalid', reason: 'document-invalid' }
    },
  })
}

function instrumentedPool(pool, barrier) {
  return {
    async connect() {
      const client = await pool.connect()
      let paused = false
      return {
        async query(sql, parameters) {
          const result = await client.query(sql, parameters)
          if (sql === 'BEGIN') await client.query("SET LOCAL lock_timeout = '2s'")
          if (barrier && !paused && typeof sql === 'string' && sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) {
            paused = true
            await barrier.pause()
          }
          return result
        },
        release() { client.release() },
      }
    },
  }
}

function queryBarrier() {
  let markReached
  let release
  const reached = new Promise(resolve => { markReached = resolve })
  const opened = new Promise(resolve => { release = resolve })
  return {
    async pause() {
      markReached()
      await opened
    },
    wait() { return bounded(reached, 'file lock barrier') },
    open() { release() },
  }
}

async function waitForRowLockWaiter(pool) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype IN ('transactionid', 'tuple') AND NOT granted")
    if (waiting.rows[0]?.count > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for a collaboration mutation to block on the file row.')
}

async function bounded(promise, name) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${name} timed out.`)), 5_000) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForAdvisoryWaiter(pool) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")
    if (waiting.rows[0]?.count > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for collaboration bootstrap to reach the cutover barrier.')
}

function operationInput({ fileId, lease, mutationId, baseSequence, revision, name, failureMarker, expectedSubjectId = 'collaboration-acceptance', expectedAccessEpoch }) {
  const document = { schemaVersion: 9, fileId, revision, name, ...(failureMarker ? { failureMarker } : {}) }
  return {
    fileId,
    generationId: lease.generationId,
    protocolEpoch: lease.protocolEpoch,
    fencingToken: lease.fencingToken,
    expectedSubjectId,
    expectedAccessEpoch,
    clientId: 'acceptance-client',
    clientMutationId: mutationId,
    operationType: 'document.edit',
    operationPayload: { kind: 'rename', name },
    baseSequence,
    projection: { documentSchemaVersion: 9, document },
  }
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]+$/.test(value)) throw new Error('Unsafe disposable schema name.')
  return `"${value}"`
}

