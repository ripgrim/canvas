import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPostgresControlPlane } from '../dist/postgres.js'
import { createPostgresGitHubPersistence } from '../dist/github.js'
import { applyMigrations, loadMigrations } from '../dist/migrations.js'

runSafetyGuardAssertions()

if (process.argv.includes('--safety-only')) {
  process.stdout.write('PostgreSQL acceptance safety guards passed without connecting to a database.\n')
} else {
  await runDisposableAcceptance()
}

async function runControlPlaneAcceptance(pool) {
  const store = createPostgresControlPlane(pool)
  const github = createPostgresGitHubPersistence(pool)
  const project = await store.createProject('acceptance-owner', 'Private project')
  const file = await store.createFile('acceptance-owner', 'Source file', project.id)
  const initialCapture = await store.claimThumbnailCaptureJob(new Date(), new Date(Date.now() + 60_000))
  assert.equal(initialCapture?.fileId, file.id)
  assert.equal(initialCapture?.revision, 0)
  assert.equal(await store.completeThumbnailCaptureJob(initialCapture.id, initialCapture.leaseId, new Date()), true)
  assert.equal(file.headRevision, 0)
  const initial = await store.getFileDocument('acceptance-owner', file.id)
  assert.equal(initial?.document.schemaVersion, 9)
  assert.equal(initial?.document.fileId, file.id)
  assert.equal(initial?.document.revision, 0)
  assert.equal(initial?.document.pages.length, 1)
  assert.equal(await store.getProject('different-user', project.id), null)
  assert.equal(await store.getFile('different-user', file.id), null)
  assert.equal(await store.getFileDocument('different-user', file.id), null)
  assert.deepEqual(await store.saveFileDocument('different-user', file.id, 0, { schemaVersion: 9 }), { status: 'not-found' })
  assert.equal((await store.getFileShare('acceptance-owner', file.id))?.access, 'private')
  assert.equal(await store.getFileShare('different-user', file.id), null)
  assert.equal(await store.getSharedFile(file.id), null)
  assert.equal(await store.setFileShare('different-user', file.id, 'view'), null)
  assert.equal((await store.setFileShare('acceptance-owner', file.id, 'view'))?.access, 'view')
  assert.equal((await store.getSharedFile(file.id))?.document.fileId, file.id)
  assert.equal((await store.setFileShare('acceptance-owner', file.id, 'private'))?.access, 'private')
  assert.equal(await store.getSharedFile(file.id), null)
  const thumbnailKey = `thumbnails/${file.id}/versions/0/acceptance0.avif`
  const stableThumbnailKey = `thumbnails/${file.id}/thumbnail.avif`
  assert.deepEqual(await store.setFileThumbnail('acceptance-owner', file.id, 0, thumbnailKey, '"etag-0"'), {
    status: 'saved',
    thumbnail: { fileId: file.id, revision: 0, thumbnailKey, thumbnailEtag: '"etag-0"' },
  })
  assert.deepEqual(await store.setFileThumbnail('different-user', file.id, 0, thumbnailKey, '"etag-0"'), { status: 'not-found' })
  assert.equal((await store.getFile('acceptance-owner', file.id))?.thumbnailKey, stableThumbnailKey)
  const savedDocument = { ...initial.document, revision: 1 }
  const saved = await store.saveFileDocument('acceptance-owner', file.id, 0, savedDocument)
  assert.equal(saved.status, 'saved')
  if (saved.status !== 'saved') throw new Error('Expected document save to succeed.')
  assert.equal(saved.document.revision, 1)
  assert.equal(saved.document.document.revision, 1)
  const externalizedDocument = { ...saved.document.document, formatExternalized: true }
  const externalized = await store.externalizeLegacyFileDocument(file.id, 1, saved.document.document, externalizedDocument)
  assert.equal(externalized.status, 'saved')
  if (externalized.status !== 'saved') throw new Error('Expected format-only externalization to succeed.')
  assert.equal(externalized.document.revision, 1)
  assert.equal(externalized.document.updatedAt, saved.document.updatedAt)
  assert.equal(externalized.document.document.formatExternalized, true)
  assert.equal((await store.getFile('acceptance-owner', file.id))?.headRevision, 1)
  assert.equal((await store.externalizeLegacyFileDocument(file.id, 1, saved.document.document, externalizedDocument)).status, 'unchanged')
  assert.deepEqual(await store.externalizeLegacyFileDocument(file.id, 0, saved.document.document, externalizedDocument), { status: 'conflict', currentRevision: 1 })
  const nextCapture = await store.claimThumbnailCaptureJob(new Date(), new Date(Date.now() + 60_000))
  assert.equal(nextCapture?.fileId, file.id)
  assert.equal(nextCapture?.revision, 1)
  assert.equal(await store.releaseThumbnailCaptureJob(nextCapture.id, nextCapture.leaseId), true)
  const leaseStart = new Date('2026-10-09T12:00:00.000Z')
  const expiringCapture = await store.claimThumbnailCaptureJob(leaseStart, new Date(leaseStart.getTime() + 10))
  assert.equal(expiringCapture?.revision, 1)
  const recoveredCapture = await store.claimThumbnailCaptureJob(new Date(leaseStart.getTime() + 20), new Date(leaseStart.getTime() + 60_000))
  assert.equal(recoveredCapture?.id, expiringCapture?.id)
  assert.notEqual(recoveredCapture?.leaseId, expiringCapture?.leaseId)
  assert.equal(await store.completeThumbnailCaptureJob(expiringCapture.id, expiringCapture.leaseId, new Date()), false)
  assert.equal(await store.releaseThumbnailCaptureJob(expiringCapture.id, expiringCapture.leaseId), false)
  assert.equal(await store.completeThumbnailCaptureJob(recoveredCapture.id, recoveredCapture.leaseId, new Date()), true)
  assert.equal((await store.getFile('acceptance-owner', file.id))?.thumbnailKey, null)
  const nextThumbnailKey = `thumbnails/${file.id}/versions/1/acceptance1.avif`
  assert.equal((await store.setFileThumbnail('acceptance-owner', file.id, 1, nextThumbnailKey, '"etag-1"')).status, 'saved')
  assert.deepEqual(await store.setFileThumbnail('acceptance-owner', file.id, 0, thumbnailKey, '"etag-0"'), { status: 'conflict', currentRevision: 1 })
  assert.equal((await store.getFile('acceptance-owner', file.id))?.thumbnailKey, stableThumbnailKey)
  assert.deepEqual(await store.getFileThumbnailForCapture(file.id), { fileId: file.id, revision: 1, thumbnailKey: nextThumbnailKey, thumbnailEtag: '"etag-1"', ownerUserId: 'acceptance-owner' })
  assert.deepEqual(await store.saveFileDocument('acceptance-owner', file.id, 0, savedDocument), { status: 'conflict', currentRevision: 1 })
  assert.equal((await store.getFile('acceptance-owner', file.id))?.headRevision, 1)

  const state = {
    digest: createHash('sha256').update(randomUUID()).digest('hex'),
    accountId: 'acceptance-owner',
    tenantId: 'acceptance-owner',
    purpose: 'install-app',
    installationId: null,
    codeVerifierCiphertext: null,
    expiresAt: Date.now() + 60_000,
  }
  await github.states.put(state)
  assert.equal(await github.states.consume({ digest: state.digest, accountId: 'attacker', purpose: state.purpose, now: Date.now() }), null)
  assert.deepEqual(await github.states.consume({ digest: state.digest, accountId: state.accountId, purpose: state.purpose, now: Date.now() }), state)
  assert.equal(await github.states.consume({ digest: state.digest, accountId: state.accountId, purpose: state.purpose, now: Date.now() }), null)

  const deliveryId = `delivery-${randomUUID()}`
  const digest = createHash('sha256').update(deliveryId).digest('hex')
  const claimed = await github.deliveries.claimDelivery({ deliveryId, eventName: 'installation', bodyDigest: digest, receivedAt: Date.now(), leaseExpiresAt: Date.now() + 60_000 })
  assert.ok(claimed)
  assert.equal(await github.deliveries.claimDelivery({ deliveryId, eventName: 'installation', bodyDigest: digest, receivedAt: Date.now(), leaseExpiresAt: Date.now() + 60_000 }), null)
  assert.equal(await github.deliveries.claimDelivery({ deliveryId: `${deliveryId}-replay`, eventName: 'installation', bodyDigest: digest, receivedAt: Date.now(), leaseExpiresAt: Date.now() + 60_000 }), null)
  await github.deliveries.completeDelivery({ deliveryId, leaseId: claimed.leaseId, completedAt: Date.now() })

  const installation = {
    tenantId: 'acceptance-owner',
    installation: { id: '9000000001', account: { id: '9000000002', login: 'acceptance-team', type: 'Organization' }, contentsPermission: 'write' },
    connectedByAccountId: 'acceptance-owner',
    connectedAt: Date.now(),
  }
  const repository = {
    tenantId: 'acceptance-owner',
    projectId: project.id,
    installationId: installation.installation.id,
    repository: { id: '9000000003', installationId: installation.installation.id, ownerId: installation.installation.account.id, ownerLogin: 'acceptance-team', name: 'private-repo', fullName: 'acceptance-team/private-repo', isPrivate: true, contentsPermission: 'write' },
    linkedByAccountId: 'acceptance-owner',
    linkedAt: Date.now(),
  }
  await github.grants.saveInstallationGrant(installation)
  await github.grants.saveRepositoryGrant(repository)
  await pool.query("INSERT INTO app_project_member (project_id, user_id, role) VALUES ($1, 'acceptance-viewer', 'viewer'), ($1, 'acceptance-reviewer', 'reviewer')", [project.id])
  assert.deepEqual(await github.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'acceptance-owner', tenantId: 'acceptance-owner', projectId: project.id, operation: 'write' }), { isMember: true, roleAllowsOperation: true })
  assert.equal(await github.projectTenancy.resolveTenantForMember(project.id, 'acceptance-owner'), 'acceptance-owner')
  assert.equal(await github.projectTenancy.resolveTenantForMember(project.id, 'different-user'), null)
  assert.deepEqual(await github.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'acceptance-viewer', tenantId: 'acceptance-owner', projectId: project.id, operation: 'pull' }), { isMember: true, roleAllowsOperation: true })
  assert.deepEqual(await github.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'acceptance-viewer', tenantId: 'acceptance-owner', projectId: project.id, operation: 'write' }), { isMember: true, roleAllowsOperation: false })
  assert.deepEqual(await github.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'acceptance-reviewer', tenantId: 'acceptance-owner', projectId: project.id, operation: 'prepare-patch' }), { isMember: true, roleAllowsOperation: true })
  assert.deepEqual(await github.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'different-user', tenantId: 'acceptance-owner', projectId: project.id, operation: 'scan' }), { isMember: false, roleAllowsOperation: false })
  await assert.rejects(github.grants.saveRepositoryGrant({ ...repository, linkedByAccountId: 'different-user' }), /not authorized/)
  assert.equal((await github.grants.getRepositoryGrant({ tenantId: 'acceptance-owner', projectId: project.id }))?.repository.id, repository.repository.id)
  await github.grants.invalidateRepositories({ installationId: installation.installation.id, repositoryIds: [repository.repository.id], reason: 'removed', invalidatedAt: Date.now() })
  assert.equal(await github.grants.getRepositoryGrant({ tenantId: 'acceptance-owner', projectId: project.id }), null)
}

async function runDisposableAcceptance() {
  const rawConnectionString = process.env.DATABASE_URL
  if (!rawConnectionString) throw new Error('DATABASE_URL is required for the PostgreSQL acceptance test.')
  if (process.env.POSTGRES_TEST_ALLOW_DISPOSABLE !== '1') throw new Error('Set POSTGRES_TEST_ALLOW_DISPOSABLE=1 to confirm this is a disposable test database.')
  const { connectionUrl, databaseName } = validateDisposablePostgresUrl(rawConnectionString)
  const schemaName = `control_plane_acceptance_${randomUUID().replaceAll('-', '')}`
  const quotedSchema = quoteIdentifier(schemaName)
  const admin = new Pool({ connectionString: connectionUrl.toString(), max: 1 })
  let testPool
  let schemaCreated = false
  let acceptanceError

  try {
    const identity = await admin.query('SELECT current_database() AS database_name')
    assert.equal(identity.rows[0]?.database_name, databaseName)
    await admin.query(`CREATE SCHEMA ${quotedSchema}`)
    schemaCreated = true
    testPool = new Pool({ connectionString: connectionUrl.toString(), options: `-c search_path=${schemaName}`, max: 10 })
    assert.equal((await testPool.query('SELECT current_schema() AS schema_name')).rows[0]?.schema_name, schemaName)
    await applyMigrations(testPool, await loadMigrations(new URL('../migrations/', import.meta.url)))
    await runControlPlaneAcceptance(testPool)
  } catch (error) {
    acceptanceError = error
  }

  const cleanupErrors = []
  if (testPool) {
    try { await testPool.end() }
    catch (error) { cleanupErrors.push(error) }
  }
  if (schemaCreated) {
    try { await admin.query(`DROP SCHEMA ${quotedSchema} CASCADE`) }
    catch (error) { cleanupErrors.push(error) }
  }
  try { await admin.end() }
  catch (error) { cleanupErrors.push(error) }

  const failures = [...(acceptanceError ? [acceptanceError] : []), ...cleanupErrors]
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'PostgreSQL acceptance or disposable-schema cleanup failed.')
  process.stdout.write(`PostgreSQL control-plane and GitHub acceptance passed and removed disposable schema ${schemaName}.\n`)
}

function validateDisposablePostgresUrl(rawConnectionString) {
  let connectionUrl
  try { connectionUrl = new URL(rawConnectionString) }
  catch { throw new Error('DATABASE_URL must be a valid URL.') }
  if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) throw new Error('The PostgreSQL acceptance test URL must use PostgreSQL.')
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(connectionUrl.hostname)) throw new Error('The PostgreSQL acceptance test only permits loopback databases.')
  if ([...connectionUrl.searchParams].length > 0) throw new Error('The PostgreSQL acceptance test does not permit connection-string query parameters.')
  const databaseName = decodeURIComponent(connectionUrl.pathname.slice(1))
  if (!/^design_editor_postgres_test(?:_[a-z0-9_]+)?$/.test(databaseName)) throw new Error('The PostgreSQL acceptance test requires a database named design_editor_postgres_test or design_editor_postgres_test_<suffix>.')
  return { connectionUrl, databaseName }
}

function runSafetyGuardAssertions() {
  assert.throws(() => validateDisposablePostgresUrl('https://127.0.0.1/design_editor_postgres_test'), /must use PostgreSQL/)
  assert.throws(() => validateDisposablePostgresUrl('postgresql://tester@database.example/design_editor_postgres_test'), /only permits loopback/)
  assert.throws(() => validateDisposablePostgresUrl('postgresql://tester@127.0.0.1/production'), /requires a database named/)
  assert.throws(() => validateDisposablePostgresUrl('postgresql://tester@127.0.0.1/design_editor_postgres_test?host=database.example'), /does not permit connection-string query parameters/)
  assert.equal(validateDisposablePostgresUrl('postgresql://tester@127.0.0.1/design_editor_postgres_test').databaseName, 'design_editor_postgres_test')
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]+$/.test(value)) throw new Error('Unsafe disposable schema name.')
  return `"${value}"`
}
