import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPostgresControlPlane } from '../dist/postgres.js'
import { createPostgresGitHubPersistence } from '../dist/github.js'
import { createPostgresRepositoryDocsReviewStore } from '../dist/github-docs.js'
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
  assert.equal(initial?.document.schemaVersion, 12)
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

  const firstArtifact = {
    artifactId: randomUUID(),
    fileId: file.id,
    fileRevision: 1,
    sourceRevision: 'a'.repeat(40),
    registryFingerprint: `sha256:${'b'.repeat(64)}`,
    entrypoint: 'index.html',
  }
  assert.equal((await store.registerHostedPreviewArtifact(firstArtifact)).status, 'registered')
  assert.equal((await store.authorizeHostedPreviewArtifact('acceptance-owner', file.id, firstArtifact.artifactId))?.artifactId, firstArtifact.artifactId)
  assert.equal(await store.authorizeHostedPreviewArtifact('different-user', file.id, firstArtifact.artifactId), null)
  assert.equal(await store.authorizeHostedPreviewArtifact('acceptance-owner', randomUUID(), firstArtifact.artifactId), null)
  await store.setFileShare('acceptance-owner', file.id, 'view')
  assert.equal((await store.authorizeHostedPreviewArtifact('different-user', file.id, firstArtifact.artifactId))?.artifactId, firstArtifact.artifactId)
  await store.setFileShare('acceptance-owner', file.id, 'private')
  assert.equal(await store.authorizeHostedPreviewArtifact('different-user', file.id, firstArtifact.artifactId), null)

  const concurrentArtifact = { ...firstArtifact, artifactId: randomUUID() }
  const concurrent = await Promise.all([
    store.registerHostedPreviewArtifact(concurrentArtifact),
    store.registerHostedPreviewArtifact(concurrentArtifact),
  ])
  assert.deepEqual(concurrent.map(result => result.status).sort(), ['registered', 'unchanged'])

  const generationId = randomUUID()
  const roomDocument = { ...saved.document.document, revision: 2 }
  await pool.query(
    "INSERT INTO app_collaboration_generation (file_id, generation_id, protocol_epoch, status, fencing_token, activated_at) VALUES ($1, $2, 1, 'active', 1, now())",
    [file.id, generationId],
  )
  await pool.query(
    "INSERT INTO app_collaboration_projection (file_id, sequence, document_schema_version, document, document_digest, generation_id, fencing_token, authority) VALUES ($1, 0, 11, $2::jsonb, $3, $4, 1, 'room')",
    [file.id, JSON.stringify(roomDocument), createHash('sha256').update(JSON.stringify(roomDocument)).digest('hex'), generationId],
  )
  const repairedRoomDocument = { ...roomDocument, invariantRepairMarker: 'repaired' }
  const invariantRepair = await store.repairFileDocumentInvariant(file.id, 2, roomDocument, repairedRoomDocument)
  assert.equal(invariantRepair.status, 'saved')
  assert.equal(invariantRepair.document.revision, 2)
  assert.equal((await store.getFileDocumentForCapture(file.id))?.document.invariantRepairMarker, 'repaired')
  assert.equal((await store.repairFileDocumentInvariant(file.id, 2, roomDocument, repairedRoomDocument)).status, 'unchanged')
  assert.deepEqual(await store.repairFileDocumentInvariant(file.id, 1, repairedRoomDocument, { ...repairedRoomDocument, other: true }), { status: 'conflict', currentRevision: 2 })
  await pool.query(
    "INSERT INTO app_collaboration_lease (file_id, active_generation_id, protocol_epoch, fencing_token, lease_expires_at, renewed_at) VALUES ($1, $2, 1, 1, now() + interval '1 minute', now())",
    [file.id, generationId],
  )
  assert.deepEqual(await store.repairFileDocumentInvariant(file.id, 2, repairedRoomDocument, { ...repairedRoomDocument, other: true }), { status: 'collaboration-active' })
  await pool.query('DELETE FROM app_collaboration_lease WHERE file_id = $1', [file.id])
  assert.equal(await store.authorizeHostedPreviewArtifact('acceptance-owner', file.id, firstArtifact.artifactId), null)
  assert.deepEqual(await store.registerHostedPreviewArtifact({ ...firstArtifact, artifactId: randomUUID() }), { status: 'revision-conflict', currentRevision: 2 })

  const roomArtifact = { ...firstArtifact, artifactId: randomUUID(), fileRevision: 2 }
  assert.equal((await store.registerHostedPreviewArtifact(roomArtifact)).status, 'registered')
  assert.equal((await store.authorizeHostedPreviewArtifact('acceptance-owner', file.id, roomArtifact.artifactId))?.fileRevision, 2)
  const lock = await pool.connect()
  const raceApplicationName = `hosted_preview_registration_${randomUUID().replaceAll('-', '')}`
  const raceSchema = (await pool.query('SELECT current_schema() AS schema_name')).rows[0]?.schema_name
  if (typeof raceSchema !== 'string' || !/^[a-z][a-z0-9_]+$/.test(raceSchema)) throw new Error('Hosted preview race schema is invalid.')
  const racePool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: raceApplicationName, options: `-c search_path=${raceSchema}`, max: 1 })
  const raceStore = createPostgresControlPlane(racePool)
  try {
    await lock.query('BEGIN')
    await lock.query('SELECT file_id FROM app_collaboration_projection WHERE file_id = $1 FOR UPDATE', [file.id])
    const nextRoomDocument = { ...roomDocument, revision: 3 }
    await lock.query('UPDATE app_collaboration_projection SET document = $2::jsonb, document_digest = $3 WHERE file_id = $1', [file.id, JSON.stringify(nextRoomDocument), createHash('sha256').update(JSON.stringify(nextRoomDocument)).digest('hex')])
    const registration = raceStore.registerHostedPreviewArtifact({ ...firstArtifact, artifactId: randomUUID(), fileRevision: 2 })
    await waitForDatabaseLock(pool, raceApplicationName)
    await lock.query('COMMIT')
    assert.deepEqual(await registration, { status: 'revision-conflict', currentRevision: 3 })
  } finally {
    try { await lock.query('ROLLBACK') } catch { }
    lock.release()
    await racePool.end()
  }
  assert.equal(await store.authorizeHostedPreviewArtifact('acceptance-owner', file.id, roomArtifact.artifactId), null)

  const state = {
    digest: createHash('sha256').update(randomUUID()).digest('hex'),
    accountId: 'acceptance-owner',
    tenantId: 'acceptance-owner',
    purpose: 'install-app',
    installationId: null,
    codeVerifierCiphertext: null,
    returnToUrl: 'https://editor.canvas.test/file/current',
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
    grantId: randomUUID(),
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
  const repositoryJobId = randomUUID()
  const firstLeaseId = randomUUID()
  const secondLeaseId = randomUUID()
  const claimTime = Date.now()
  await github.jobs.enqueue({
    id: repositoryJobId,
    actor: { accountId: 'acceptance-owner', providerUserId: '9000000004' },
    tenantId: 'acceptance-owner',
    projectId: project.id,
    operation: 'scan',
    installationId: installation.installation.id,
    repositoryId: repository.repository.id,
    repositoryLinkedAt: repository.linkedAt,
    repositoryGrantId: repository.grantId,
    status: 'queued',
    createdAt: claimTime,
    nextAttemptAt: claimTime,
    attempt: 0,
  })
  const repositoryClaims = await Promise.all([
    github.jobs.claimScan({ id: repositoryJobId, leaseId: firstLeaseId, now: claimTime, leaseExpiresAt: claimTime + 10 }),
    github.jobs.claimScan({ id: repositoryJobId, leaseId: secondLeaseId, now: claimTime, leaseExpiresAt: claimTime + 10 }),
  ])
  assert.equal(repositoryClaims.filter(Boolean).length, 1)
  const winningRepositoryClaim = repositoryClaims.find(Boolean)
  if (!winningRepositoryClaim || winningRepositoryClaim.status !== 'running') throw new Error('Expected exactly one running repository scan lease.')
  const winningRepositoryLease = winningRepositoryClaim.leaseId
  const recoveredRepositoryLease = winningRepositoryLease === firstLeaseId ? secondLeaseId : firstLeaseId
  assert.equal(await github.jobs.isCurrentLease({ id: repositoryJobId, leaseId: winningRepositoryLease, now: claimTime + 1 }), true)
  const recoveredRepositoryClaim = await github.jobs.claimScan({ id: repositoryJobId, leaseId: recoveredRepositoryLease, now: claimTime + 11, leaseExpiresAt: claimTime + 100 })
  assert.equal(recoveredRepositoryClaim?.status, 'running')
  assert.equal(recoveredRepositoryClaim?.attempt, 2)
  assert.equal(await github.jobs.isCurrentLease({ id: repositoryJobId, leaseId: winningRepositoryLease, now: claimTime + 12 }), false)
  const relinkedRepository = { ...repository, grantId: randomUUID(), linkedAt: repository.linkedAt + 1 }
  await github.grants.saveRepositoryGrant(relinkedRepository)
  assert.equal(await github.jobs.completeScan({ id: repositoryJobId, leaseId: recoveredRepositoryLease, now: claimTime + 12, result: { sourceRevision: 'a'.repeat(40), scan: {}, request: {} } }), false)
  assert.equal((await github.jobs.get(repositoryJobId))?.status, 'running')
  await github.jobs.retry({ id: repositoryJobId, leaseId: winningRepositoryLease, nextAttemptAt: claimTime + 50 })
  assert.equal(await github.jobs.isCurrentLease({ id: repositoryJobId, leaseId: recoveredRepositoryLease, now: claimTime + 12 }), true)
  await github.jobs.retry({ id: repositoryJobId, leaseId: recoveredRepositoryLease, nextAttemptAt: claimTime + 50 })
  assert.equal((await github.jobs.get(repositoryJobId))?.status, 'queued')

  const completedScanId = randomUUID()
  const completedScanLeaseId = randomUUID()
  const completedScanTime = claimTime + 200
  await github.jobs.enqueue({
    id: completedScanId,
    actor: { accountId: 'acceptance-owner', providerUserId: '9000000004' },
    tenantId: 'acceptance-owner',
    projectId: project.id,
    operation: 'scan',
    installationId: installation.installation.id,
    repositoryId: relinkedRepository.repository.id,
    repositoryLinkedAt: relinkedRepository.linkedAt,
    repositoryGrantId: relinkedRepository.grantId,
    status: 'queued',
    createdAt: completedScanTime,
    nextAttemptAt: completedScanTime,
    attempt: 0,
  })
  assert.equal((await github.jobs.claimScan({ id: completedScanId, leaseId: completedScanLeaseId, now: completedScanTime, leaseExpiresAt: completedScanTime + 100 }))?.status, 'running')
  assert.equal(await github.jobs.completeScan({ id: completedScanId, leaseId: completedScanLeaseId, now: completedScanTime + 1, result: { sourceRevision: 'b'.repeat(40), scan: { adapterId: 'acceptance' }, request: { version: 1 } } }), true)
  const completedScanScope = {
    actorAccountId: 'acceptance-owner',
    tenantId: 'acceptance-owner',
    projectId: project.id,
    installationId: installation.installation.id,
    repositoryId: relinkedRepository.repository.id,
    repositoryLinkedAt: relinkedRepository.linkedAt,
    repositoryGrantId: relinkedRepository.grantId,
  }
  assert.equal((await github.jobs.latestCompletedScan(completedScanScope))?.id, completedScanId)
  assert.equal((await github.jobs.getAuthorized(completedScanId, 'acceptance-viewer'))?.id, completedScanId)
  await pool.query("DELETE FROM app_project_member WHERE project_id = $1 AND user_id = 'acceptance-viewer'", [project.id])
  assert.equal(await github.jobs.getAuthorized(completedScanId, 'acceptance-viewer'), null)
  assert.equal(await github.jobs.latestCompletedScan({ ...completedScanScope, actorAccountId: 'acceptance-viewer' }), null)
  await pool.query("INSERT INTO app_project_member (project_id, user_id, role) VALUES ($1, 'acceptance-viewer', 'viewer')", [project.id])

  const hostedBuildInput = {
    id: randomUUID(),
    ownerUserId: 'acceptance-owner',
    fileId: file.id,
    fileRevision: 3,
    projectId: project.id,
    scanJobId: completedScanId,
    artifactId: randomUUID(),
    stagingId: randomUUID(),
    createdAt: new Date(completedScanTime + 10),
  }
  assert.equal((await store.createHostedPreviewBuildJob(hostedBuildInput))?.status, 'queued')
  const hostedClaimTime = new Date(completedScanTime + 20)
  const hostedClaims = await Promise.all([
    store.claimHostedPreviewBuildJob(hostedClaimTime, new Date(completedScanTime + 30)),
    store.claimHostedPreviewBuildJob(hostedClaimTime, new Date(completedScanTime + 30)),
  ])
  assert.equal(hostedClaims.filter(Boolean).length, 1)
  const firstHostedLease = hostedClaims.find(Boolean)
  if (!firstHostedLease?.leaseId) throw new Error('Expected exactly one hosted preview build lease.')
  const recoveredHostedLease = await store.claimHostedPreviewBuildJob(new Date(completedScanTime + 31), new Date(completedScanTime + 100))
  assert.equal(recoveredHostedLease?.id, hostedBuildInput.id)
  assert.notEqual(recoveredHostedLease?.leaseId, firstHostedLease.leaseId)
  assert.equal(await store.isCurrentHostedPreviewBuildLease(hostedBuildInput.id, firstHostedLease.leaseId, new Date(completedScanTime + 32)), false)
  assert.equal((await store.registerHostedPreviewArtifact({
    artifactId: hostedBuildInput.artifactId,
    fileId: file.id,
    fileRevision: 3,
    sourceRevision: 'b'.repeat(40),
    registryFingerprint: `sha256:${'c'.repeat(64)}`,
    entrypoint: 'index.html',
  })).status, 'registered')
  assert.equal(await store.completeHostedPreviewBuildJob(hostedBuildInput.id, firstHostedLease.leaseId, new Date(completedScanTime + 33)), false)
  assert.equal(await store.completeHostedPreviewBuildJob(hostedBuildInput.id, recoveredHostedLease.leaseId, new Date(completedScanTime + 33)), true)

  const writeJobId = randomUUID()
  await github.jobs.enqueue({
    id: writeJobId,
    actor: { accountId: 'acceptance-owner', providerUserId: '9000000004' },
    tenantId: 'acceptance-owner',
    projectId: project.id,
    operation: 'write',
    installationId: installation.installation.id,
    repositoryId: repository.repository.id,
    repositoryLinkedAt: relinkedRepository.linkedAt,
    repositoryGrantId: relinkedRepository.grantId,
    status: 'queued',
    createdAt: claimTime,
    nextAttemptAt: claimTime,
    attempt: 0,
  })
  assert.equal((await github.jobs.getAuthorized(writeJobId, 'acceptance-owner'))?.id, writeJobId)
  assert.equal(await github.jobs.getAuthorized(writeJobId, 'acceptance-viewer'), null)
  assert.equal(await github.jobs.claimScan({ id: writeJobId, leaseId: randomUUID(), now: claimTime, leaseExpiresAt: claimTime + 100 }), null)

  const docs = createPostgresRepositoryDocsReviewStore(pool)
  const docsReviewId = randomUUID()
  const docsCreatedAt = completedScanTime + 500
  const queuedDocsReview = await docs.enqueuePrepare({
    id: docsReviewId,
    tenantId: 'acceptance-owner',
    projectId: project.id,
    fileId: file.id,
    fileRevision: 1,
    fileDocumentSha256: 'd'.repeat(64),
    scanJobId: completedScanId,
    installationId: installation.installation.id,
    repositoryId: relinkedRepository.repository.id,
    repositoryGrantId: relinkedRepository.grantId,
    repositoryLinkedAt: relinkedRepository.linkedAt,
    createdByAccountId: 'acceptance-owner',
    baseRef: 'refs/heads/main',
    baseCommitSha: 'b'.repeat(40),
    baseTreeSha: 'c'.repeat(40),
    adapter: { version: 1 },
    createdAt: docsCreatedAt,
  })
  assert.equal(queuedDocsReview.status, 'queued_prepare')
  const prepareLeaseId = randomUUID()
  assert.equal((await docs.claimNextPrepare({ leaseId: prepareLeaseId, now: docsCreatedAt, leaseExpiresAt: docsCreatedAt + 100 }))?.status, 'preparing')
  assert.equal(await docs.completePrepare({ id: docsReviewId, leaseId: prepareLeaseId, now: docsCreatedAt + 1, preparedBundle: { version: 1 }, approvalDigest: 'e'.repeat(64) }), true)
  assert.equal(await docs.approveSave({ id: docsReviewId, actorAccountId: 'acceptance-reviewer', approvalDigest: 'e'.repeat(64), now: docsCreatedAt + 2 }), false)
  assert.equal(await docs.approveSave({ id: docsReviewId, actorAccountId: 'acceptance-owner', approvalDigest: 'e'.repeat(64), now: docsCreatedAt + 2 }), true)
  const saveLeaseId = randomUUID()
  const competingSaveLeaseId = randomUUID()
  const saveClaims = await Promise.all([
    docs.claimNextSave({ leaseId: saveLeaseId, now: docsCreatedAt + 2, leaseExpiresAt: docsCreatedAt + 102 }),
    docs.claimNextSave({ leaseId: competingSaveLeaseId, now: docsCreatedAt + 2, leaseExpiresAt: docsCreatedAt + 102 }),
  ])
  assert.equal(saveClaims.filter(Boolean).length, 1)
  const saveLease = saveClaims.find(Boolean)?.leaseId
  if (!saveLease) throw new Error('Expected exactly one documentation save lease.')
  const proposedCommitSha = 'f'.repeat(40)
  assert.equal(await docs.setProposedCommit({ id: docsReviewId, leaseId: saveLease, now: docsCreatedAt + 3, proposedCommitSha }), true)
  assert.equal(await docs.completeSave({ id: docsReviewId, leaseId: saveLease, now: docsCreatedAt + 4, committedSha: '0'.repeat(40) }), false)
  assert.equal(await docs.completeSave({ id: docsReviewId, leaseId: saveLease, now: docsCreatedAt + 4, committedSha: proposedCommitSha }), true)
  const savedDocsReview = await docs.get(docsReviewId)
  assert.equal(savedDocsReview?.status, 'saved')
  assert.equal(savedDocsReview?.proposedCommitSha, proposedCommitSha)
  assert.equal(savedDocsReview?.committedSha, proposedCommitSha)
  assert.equal((await docs.getLatestAuthorized(project.id, file.id, 'acceptance-owner'))?.id, docsReviewId)
  assert.equal(await docs.getLatestAuthorized(project.id, file.id, 'acceptance-viewer'), null)

  await github.grants.saveRepositoryGrant({ ...relinkedRepository, grantId: randomUUID(), linkedAt: relinkedRepository.linkedAt + 1 })
  assert.equal(await github.jobs.getAuthorized(completedScanId, 'acceptance-owner'), null)
  assert.equal(await github.jobs.latestCompletedScan(completedScanScope), null)
  await github.grants.invalidateRepositories({ installationId: installation.installation.id, repositoryIds: [repository.repository.id], reason: 'removed', invalidatedAt: Date.now() })
  assert.equal(await github.grants.getRepositoryGrant({ tenantId: 'acceptance-owner', projectId: project.id }), null)
}

async function waitForDatabaseLock(pool, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await pool.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'",
      [applicationName],
    )
    if (activity.rows.some(row => row.wait_event_type === 'Lock')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Hosted preview registration did not block on the projection lock.')
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
