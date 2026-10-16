import { describe, expect, it } from 'vitest'
import type { InstallationGrant, RepositoryGrantInput } from '@canvas/github-app'
import { createMemoryGitHubPersistence, roleAllowsProjectOperation } from '../src/github'

const now = 1_800_000_000_000
const installation: InstallationGrant = Object.freeze({
  tenantId: 'tenant-1',
  installation: Object.freeze({ id: '2001', account: Object.freeze({ id: '3001', login: 'canvas-team', type: 'Organization' }), contentsPermission: 'write' }),
  connectedByAccountId: 'user-1',
  connectedAt: now,
})
const repository: RepositoryGrantInput = Object.freeze({
  grantId: '00000000-0000-4000-8000-000000000077',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  installationId: '2001',
  repository: Object.freeze({ id: '4001', installationId: '2001', ownerId: '3001', ownerLogin: 'canvas-team', name: 'design-system', fullName: 'canvas-team/design-system', isPrivate: true, contentsPermission: 'write' }),
  linkedByAccountId: 'user-1',
  linkedAt: now,
})

describe('GitHub App persistence adapters', () => {
  it('AT-REPO-LINK-001 owns a monotonic repository grant generation across invalidation and relink', async () => {
    const persistence = createMemoryGitHubPersistence()
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'owner')
    await persistence.grants.saveInstallationGrant(installation)
    const first = await persistence.grants.saveRepositoryGrant(repository)
    expect(first.grantGeneration).toBe(1)
    await persistence.jobs.enqueue({ id: '00000000-0000-4000-8000-000000000080', actor: { accountId: 'user-1', providerUserId: '1001' }, tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan', installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now, repositoryGrantId: repository.grantId, repositoryGrantGeneration: 1, status: 'queued', createdAt: now, nextAttemptAt: now, attempt: 0 })
    await persistence.grants.invalidateRepositories({ installationId: '2001', repositoryIds: ['4001'], reason: 'removed', invalidatedAt: now + 1 })
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'viewer')
    await expect(persistence.grants.saveRepositoryGrant({ ...repository, grantId: '00000000-0000-4000-8000-000000000078' })).rejects.toThrow('not authorized')
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'owner')
    const second = await persistence.grants.saveRepositoryGrant({ ...repository, grantId: '00000000-0000-4000-8000-000000000079', linkedAt: now + 2 })
    expect(second.grantGeneration).toBe(2)
    await expect(persistence.jobs.claimScan({ id: '00000000-0000-4000-8000-000000000080', leaseId: '00000000-0000-4000-8000-000000000081', now: now + 3, leaseExpiresAt: now + 100 })).resolves.toBeNull()
    await persistence.jobs.enqueue({ id: '00000000-0000-4000-8000-000000000082', actor: { accountId: 'user-1', providerUserId: '1001' }, tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan', installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now + 2, repositoryGrantId: second.grantId, repositoryGrantGeneration: 2, status: 'queued', createdAt: now + 1, nextAttemptAt: now + 1, attempt: 0 })
    await expect(persistence.jobs.claimNextScan({ leaseId: '00000000-0000-4000-8000-000000000083', now: now + 3, leaseExpiresAt: now + 100 })).resolves.toMatchObject({ id: '00000000-0000-4000-8000-000000000082', status: 'running' })
  })

  it('AT-GHAPP-001 consumes installation state atomically and claims each delivery once', async () => {
    const persistence = createMemoryGitHubPersistence()
    const state = Object.freeze({ digest: 'a'.repeat(64), accountId: 'user-1', tenantId: 'tenant-1', purpose: 'install-app' as const, installationId: null, codeVerifierCiphertext: null, returnToUrl: 'https://editor.canvas.test/file/current', expiresAt: now + 60_000 })
    await persistence.states.put(state)
    expect(await persistence.states.consume({ digest: state.digest, accountId: 'attacker', purpose: state.purpose, now })).toBeNull()
    const consumed = await Promise.all([
      persistence.states.consume({ digest: state.digest, accountId: state.accountId, purpose: state.purpose, now }),
      persistence.states.consume({ digest: state.digest, accountId: state.accountId, purpose: state.purpose, now }),
    ])
    expect(consumed.filter(Boolean)).toEqual([state])

    const claims = await Promise.all([
      persistence.deliveries.claimDelivery({ deliveryId: 'delivery-001', eventName: 'installation', bodyDigest: 'b'.repeat(64), receivedAt: now, leaseExpiresAt: now + 60_000 }),
      persistence.deliveries.claimDelivery({ deliveryId: 'delivery-001', eventName: 'installation', bodyDigest: 'b'.repeat(64), receivedAt: now, leaseExpiresAt: now + 60_000 }),
    ])
    expect(claims[0]).toMatchObject({ leaseId: expect.any(String) })
    expect(claims[1]).toBeNull()
    await persistence.deliveries.completeDelivery({ deliveryId: 'delivery-001', leaseId: claims[0]!.leaseId, completedAt: now + 1 })
    expect(await persistence.deliveries.claimDelivery({ deliveryId: 'delivery-001', eventName: 'installation', bodyDigest: 'b'.repeat(64), receivedAt: now + 2, leaseExpiresAt: now + 60_002 })).toBeNull()
  })

  it('AT-GHAPP-001 rejects body replay under another delivery id and recovers an expired lease', async () => {
    const persistence = createMemoryGitHubPersistence()
    const first = await persistence.deliveries.claimDelivery({ deliveryId: 'delivery-101', eventName: 'installation', bodyDigest: 'c'.repeat(64), receivedAt: now, leaseExpiresAt: now + 10 })
    expect(first).not.toBeNull()
    expect(await persistence.deliveries.claimDelivery({ deliveryId: 'delivery-102', eventName: 'installation', bodyDigest: 'c'.repeat(64), receivedAt: now + 20, leaseExpiresAt: now + 40 })).toBeNull()
    const recovered = await persistence.deliveries.claimDelivery({ deliveryId: 'delivery-101', eventName: 'installation', bodyDigest: 'c'.repeat(64), receivedAt: now + 20, leaseExpiresAt: now + 40 })
    expect(recovered?.leaseId).not.toBe(first?.leaseId)
    await expect(persistence.deliveries.completeDelivery({ deliveryId: 'delivery-101', leaseId: first!.leaseId, completedAt: now + 21 })).rejects.toThrow('not claimed')
    await persistence.deliveries.completeDelivery({ deliveryId: 'delivery-101', leaseId: recovered!.leaseId, completedAt: now + 22 })
  })

  it('AT-REPO-SCAN-001 claims one repository worker and fences stale leases', async () => {
    const persistence = createMemoryGitHubPersistence()
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'owner')
    await persistence.grants.saveInstallationGrant(installation)
    await persistence.grants.saveRepositoryGrant(repository)
    const jobId = '00000000-0000-4000-8000-000000000001'
    const firstLease = '00000000-0000-4000-8000-000000000002'
    const secondLease = '00000000-0000-4000-8000-000000000003'
    await persistence.jobs.enqueue({
      id: jobId,
      actor: { accountId: 'user-1', providerUserId: '1001' },
      tenantId: 'tenant-1',
      projectId: 'project-1',
      operation: 'scan',
      installationId: '2001',
      repositoryId: '4001',
      repositoryLinkedAt: now,
      repositoryGrantId: repository.grantId,
      repositoryGrantGeneration: 1,
      status: 'queued',
      createdAt: now,
      nextAttemptAt: now,
      attempt: 0,
    })

    const claims = await Promise.all([
      persistence.jobs.claimScan({ id: jobId, leaseId: firstLease, now, leaseExpiresAt: now + 100 }),
      persistence.jobs.claimScan({ id: jobId, leaseId: secondLease, now, leaseExpiresAt: now + 100 }),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const winning = claims.find(claim => claim !== null)
    if (!winning || winning.status !== 'running') throw new Error('Expected one repository job lease.')
    const winningLease = winning.leaseId
    const recoveredLease = winningLease === firstLease ? secondLease : firstLease
    const recovered = await persistence.jobs.claimScan({ id: jobId, leaseId: recoveredLease, now: now + 101, leaseExpiresAt: now + 201 })
    expect(recovered).toMatchObject({ status: 'running', leaseId: recoveredLease, attempt: 2 })

    await persistence.jobs.retry({ id: jobId, leaseId: winningLease, nextAttemptAt: now + 200 })
    expect(await persistence.jobs.get(jobId)).toMatchObject({ status: 'running', leaseId: recoveredLease })
    const artifact = { sourceRevision: 'a'.repeat(40), scan: { adapterId: 'shadcn-v1' }, request: { version: 1 } }
    expect(await persistence.jobs.completeScan({ id: jobId, leaseId: winningLease, now: now + 102, result: artifact })).toBe(false)
    expect(await persistence.jobs.completeScan({ id: jobId, leaseId: recoveredLease, now: now + 102, result: artifact })).toBe(true)
    expect(await persistence.jobs.get(jobId)).toMatchObject({ status: 'completed', attempt: 2, result: artifact })
  })

  it('AT-REPO-SCAN-001 fences recovered results against current grant state', async () => {
    const persistence = createMemoryGitHubPersistence()
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'owner')
    await persistence.grants.saveInstallationGrant(installation)
    await persistence.grants.saveRepositoryGrant(repository)
    const jobId = '00000000-0000-4000-8000-000000000021'
    const leaseId = '00000000-0000-4000-8000-000000000022'
    await persistence.jobs.enqueue({
      id: jobId,
      actor: { accountId: 'user-1', providerUserId: '1001' },
      tenantId: 'tenant-1',
      projectId: 'project-1',
      operation: 'scan',
      installationId: '2001',
      repositoryId: '4001',
      repositoryLinkedAt: now,
      repositoryGrantId: repository.grantId,
      repositoryGrantGeneration: 1,
      status: 'queued',
      createdAt: now,
      nextAttemptAt: now,
      attempt: 0,
    })
    await persistence.jobs.claimScan({ id: jobId, leaseId, now, leaseExpiresAt: now + 100 })
    const artifact = { sourceRevision: 'a'.repeat(40), scan: { adapterId: 'shadcn-v1' }, request: { version: 1 } }
    expect(await persistence.jobs.completeScan({ id: jobId, leaseId, now: now + 1, result: artifact })).toBe(true)
    const scope = { actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now, repositoryGrantId: repository.grantId, repositoryGrantGeneration: 1 }
    await expect(persistence.jobs.latestCompletedScan(scope)).resolves.toMatchObject({ id: jobId, status: 'completed' })
    await expect(persistence.jobs.getAuthorized(jobId, 'user-1')).resolves.toMatchObject({ id: jobId })

    persistence.setProjectMembership('project-1', 'tenant-1', 'viewer-1', 'viewer')
    const writeJobId = '00000000-0000-4000-8000-000000000023'
    await persistence.jobs.enqueue({
      id: writeJobId,
      actor: { accountId: 'user-1', providerUserId: '1001' },
      tenantId: 'tenant-1',
      projectId: 'project-1',
      operation: 'write',
      installationId: '2001',
      repositoryId: '4001',
      repositoryLinkedAt: now,
      repositoryGrantId: repository.grantId,
      repositoryGrantGeneration: 1,
      status: 'queued',
      createdAt: now,
      nextAttemptAt: now,
      attempt: 0,
    })
    await expect(persistence.jobs.getAuthorized(writeJobId, 'user-1')).resolves.toMatchObject({ id: writeJobId })
    await expect(persistence.jobs.getAuthorized(writeJobId, 'viewer-1')).resolves.toBeNull()

    await persistence.grants.invalidateRepositories({ installationId: '2001', repositoryIds: ['4001'], reason: 'removed', invalidatedAt: now + 2 })
    await expect(persistence.jobs.latestCompletedScan(scope)).resolves.toBeNull()
    await expect(persistence.jobs.getAuthorized(jobId, 'user-1')).resolves.toBeNull()

    await persistence.grants.saveRepositoryGrant(Object.freeze({ ...repository, grantId: '00000000-0000-4000-8000-000000000078', linkedAt: now + 3 }))
    await expect(persistence.jobs.latestCompletedScan(scope)).resolves.toBeNull()
    await expect(persistence.jobs.getAuthorized(jobId, 'user-1')).resolves.toBeNull()
  })

  it('AT-GHAPP-001 invalidates repositories with their installation and by stable repository ID', async () => {
    const persistence = createMemoryGitHubPersistence()
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'owner')
    await persistence.grants.saveInstallationGrant(installation)
    await persistence.grants.saveRepositoryGrant(repository)
    await persistence.grants.invalidateRepositories({ installationId: '2001', repositoryIds: ['4001'], reason: 'removed', invalidatedAt: now + 1 })
    expect(await persistence.grants.getRepositoryGrant({ tenantId: 'tenant-1', projectId: 'project-1' })).toBeNull()

    await persistence.grants.saveRepositoryGrant(repository)
    await persistence.grants.invalidateInstallation({ installationId: '2001', reason: 'suspended', invalidatedAt: now + 2 })
    expect(await persistence.grants.getActiveInstallationGrant({ tenantId: 'tenant-1', installationId: '2001' })).toBeNull()
    expect(await persistence.grants.getRepositoryGrant({ tenantId: 'tenant-1', projectId: 'project-1' })).toBeNull()
  })

  it('AT-REPO-LINK-001 negative control rejects persistence after membership revocation', async () => {
    const persistence = createMemoryGitHubPersistence()
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'viewer')
    await expect(persistence.projectTenancy.resolveTenantForMember('project-1', 'user-1')).resolves.toBe('tenant-1')
    await expect(persistence.projectTenancy.resolveTenantForMember('project-1', 'unrelated')).resolves.toBeNull()
    await persistence.grants.saveInstallationGrant(installation)
    await expect(persistence.grants.saveRepositoryGrant(repository)).rejects.toThrow('not authorized')
    expect(await persistence.grants.getRepositoryGrant({ tenantId: 'tenant-1', projectId: 'project-1' })).toBeNull()
  })

  it('AT-REPO-LINK-001 enforces the role matrix and tenant membership independently', async () => {
    expect(roleAllowsProjectOperation('owner', 'write')).toBe(true)
    expect(roleAllowsProjectOperation('editor', 'link-repository')).toBe(true)
    expect(roleAllowsProjectOperation('reviewer', 'prepare-patch')).toBe(true)
    expect(roleAllowsProjectOperation('reviewer', 'write')).toBe(false)
    expect(roleAllowsProjectOperation('viewer', 'pull')).toBe(true)
    expect(roleAllowsProjectOperation('viewer', 'prepare-patch')).toBe(false)

    const persistence = createMemoryGitHubPersistence()
    persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'viewer')
    await expect(persistence.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan' })).resolves.toEqual({ isMember: true, roleAllowsOperation: true })
    await expect(persistence.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'write' })).resolves.toEqual({ isMember: true, roleAllowsOperation: false })
    await expect(persistence.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'user-1', tenantId: 'other-tenant', projectId: 'project-1', operation: 'scan' })).resolves.toEqual({ isMember: false, roleAllowsOperation: false })
    await expect(persistence.projectAuthorization.authorizeProjectOperation({ actorAccountId: 'unrelated', tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan' })).resolves.toEqual({ isMember: false, roleAllowsOperation: false })
  })

  it('COMP-V2-BINDING-001 authorizes and atomically commits current source bindings', async () => {
    const scenario = await bindingScenario()
    const committed = await scenario.persistence.sourceBindings.commitAuthorized(scenario.commit)
    expect(committed).toMatchObject({ status: 'committed', snapshot: { version: 1, authority: scenario.authority } })
    scenario.persistence.setProjectMembership('project-1', 'tenant-1', 'viewer-1', 'viewer')
    await expect(scenario.persistence.sourceBindings.getAuthorized({ actorAccountId: 'viewer-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' }))
      .resolves.toEqual(committed.status === 'committed' ? committed.snapshot : null)
    await expect(scenario.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'other-tenant', projectId: 'project-1', operation: 'pull' })).resolves.toBeNull()

    const concurrent = await Promise.all([
      scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, expectedVersion: 1, expectedAuthority: scenario.authority, candidate: { ...scenario.candidate, updatedAt: now + 20 } }),
      scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, expectedVersion: 1, expectedAuthority: scenario.authority, candidate: { ...scenario.candidate, updatedAt: now + 21 } }),
    ])
    expect(concurrent.map(result => result.status).sort()).toEqual(['committed', 'stale'])
  })

  it('COMP-V2-BINDING-001 serializes concurrent first creation and fences authority independently', async () => {
    const firstCreate = await bindingScenario()
    const race = await Promise.all([
      firstCreate.persistence.sourceBindings.commitAuthorized(firstCreate.commit),
      firstCreate.persistence.sourceBindings.commitAuthorized({ ...firstCreate.commit, candidate: { ...firstCreate.candidate, updatedAt: now + 13 } }),
    ])
    expect(race.map(result => result.status).sort()).toEqual(['committed', 'stale'])
    const committed = race.find(result => result.status === 'committed')
    const changedAuthority = { ...firstCreate.authority, registryFingerprint: `sha256:${'f'.repeat(64)}` }
    await expect(firstCreate.persistence.sourceBindings.commitAuthorized({ ...firstCreate.commit, expectedVersion: 1, expectedAuthority: changedAuthority, candidate: { ...firstCreate.candidate, updatedAt: now + 14 } })).resolves.toEqual({ status: 'stale' })
    await expect(firstCreate.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toEqual(committed?.status === 'committed' ? committed.snapshot : null)
  })

  it('COMP-V2-BINDING-001 rejects each altered current grant predicate without replacing last-good state', async () => {
    const scenario = await bindingScenario()
    const first = await scenario.persistence.sourceBindings.commitAuthorized(scenario.commit)
    const changes = [
      { installationId: '2002' },
      { repositoryId: '4002' },
      { repositoryLinkedAt: now + 1 },
      { repositoryGrantId: '00000000-0000-4000-8000-0000000000b1' },
      { repositoryGrantGeneration: 2 },
    ]
    for (const change of changes) {
      await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, grantScope: { ...scenario.commit.grantScope, ...change } })).resolves.toEqual({ status: 'unauthorized' })
    }
    await expect(scenario.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toEqual(first.status === 'committed' ? first.snapshot : null)
  })

  it('COMP-V2-BINDING-001 denies binding reads and commits after membership or grant revocation', async () => {
    const membership = await bindingScenario()
    await membership.persistence.sourceBindings.commitAuthorized(membership.commit)
    membership.persistence.removeProjectMembership('project-1', 'user-1')
    await expect(membership.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toBeNull()
    await expect(membership.persistence.sourceBindings.commitAuthorized(membership.commit)).resolves.toEqual({ status: 'unauthorized' })

    for (const revoke of ['repository', 'installation-suspended', 'installation-deleted'] as const) {
      const scenario = await bindingScenario()
      await scenario.persistence.sourceBindings.commitAuthorized(scenario.commit)
      if (revoke === 'repository') await scenario.persistence.grants.invalidateRepositories({ installationId: '2001', repositoryIds: ['4001'], reason: 'removed', invalidatedAt: now + 20 })
      else await scenario.persistence.grants.invalidateInstallation({ installationId: '2001', reason: revoke === 'installation-suspended' ? 'suspended' : 'deleted', invalidatedAt: now + 20 })
      await expect(scenario.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toBeNull()
      await expect(scenario.persistence.sourceBindings.commitAuthorized(scenario.commit)).resolves.toEqual({ status: 'unauthorized' })
    }
  })

  it('COMP-V2-BINDING-001 rejects malformed, stale, revoked, and mismatched scan writes without replacing last-good state', async () => {
    const scenario = await bindingScenario()
    const first = await scenario.persistence.sourceBindings.commitAuthorized(scenario.commit)
    expect(first.status).toBe('committed')
    const malformed = { ...scenario.candidate, records: [{ ...scenario.candidate.records[0], extra: true }] }
    await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, candidate: malformed as never })).rejects.toThrow(/invalid/i)
    await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, scanScope: { ...scenario.commit.scanScope, sourceRevision: 'b'.repeat(40) } }))
      .resolves.toEqual({ status: 'unauthorized' })
    await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, scanScope: { ...scenario.commit.scanScope, scanJobId: '00000000-0000-4000-8000-0000000000b2' } }))
      .resolves.toEqual({ status: 'unauthorized' })
    await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, scanScope: { ...scenario.commit.scanScope, registryFingerprint: `sha256:${'9'.repeat(64)}` } }))
      .resolves.toEqual({ status: 'unauthorized' })
    const queuedScanId = '00000000-0000-4000-8000-0000000000b3'
    await scenario.persistence.jobs.enqueue({ id: queuedScanId, actor: { accountId: 'user-1', providerUserId: '1001' }, tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan', installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now, repositoryGrantId: repository.grantId, repositoryGrantGeneration: 1, status: 'queued', createdAt: now + 15, nextAttemptAt: now + 15, attempt: 0 })
    const queuedAuthority = { ...scenario.authority, scanId: queuedScanId }
    await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, scanScope: { ...scenario.commit.scanScope, scanJobId: queuedScanId }, candidate: { ...scenario.candidate, authority: queuedAuthority, records: scenario.candidate.records.map(record => ({ ...record, authority: queuedAuthority })) } })).resolves.toEqual({ status: 'unauthorized' })
    const wrongProjectScanId = '00000000-0000-4000-8000-0000000000b4'
    const wrongProjectLeaseId = '00000000-0000-4000-8000-0000000000b5'
    scenario.persistence.setProjectMembership('project-2', 'tenant-1', 'user-1', 'owner')
    const projectTwoGrant = await scenario.persistence.grants.saveRepositoryGrant({ ...repository, projectId: 'project-2', grantId: '00000000-0000-4000-8000-0000000000b6' })
    await scenario.persistence.jobs.enqueue({ id: wrongProjectScanId, actor: { accountId: 'user-1', providerUserId: '1001' }, tenantId: 'tenant-1', projectId: 'project-2', operation: 'scan', installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now, repositoryGrantId: projectTwoGrant.grantId, repositoryGrantGeneration: 1, status: 'queued', createdAt: now + 16, nextAttemptAt: now + 16, attempt: 0 })
    await scenario.persistence.jobs.claimScan({ id: wrongProjectScanId, leaseId: wrongProjectLeaseId, now: now + 16, leaseExpiresAt: now + 100 })
    await scenario.persistence.jobs.completeScan({ id: wrongProjectScanId, leaseId: wrongProjectLeaseId, now: now + 17, result: { sourceRevision: 'a'.repeat(40), scan: { adapterId: 'shadcn-v1' }, request: { version: 1 } } })
    const wrongProjectAuthority = { ...scenario.authority, scanId: wrongProjectScanId }
    await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, scanScope: { ...scenario.commit.scanScope, scanJobId: wrongProjectScanId }, candidate: { ...scenario.candidate, authority: wrongProjectAuthority, records: scenario.candidate.records.map(record => ({ ...record, authority: wrongProjectAuthority })) } })).resolves.toEqual({ status: 'unauthorized' })
    await expect(scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, expectedVersion: 99, expectedAuthority: scenario.authority }))
      .resolves.toEqual({ status: 'stale' })
    await expect(scenario.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' }))
      .resolves.toEqual(first.status === 'committed' ? first.snapshot : null)

    await scenario.persistence.grants.invalidateRepositories({ installationId: '2001', repositoryIds: ['4001'], reason: 'removed', invalidatedAt: now + 30 })
    const relinked = await scenario.persistence.grants.saveRepositoryGrant({ ...repository, grantId: '00000000-0000-4000-8000-000000000099', linkedAt: now + 31 })
    expect(relinked.grantGeneration).toBe(2)
    await expect(scenario.persistence.sourceBindings.commitAuthorized(scenario.commit)).resolves.toEqual({ status: 'unauthorized' })
    await expect(scenario.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toEqual(first.status === 'committed' ? first.snapshot : null)

    const nextScanId = '00000000-0000-4000-8000-000000000094'
    const nextLeaseId = '00000000-0000-4000-8000-000000000095'
    await scenario.persistence.jobs.enqueue({ id: nextScanId, actor: { accountId: 'user-1', providerUserId: '1001' }, tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan', installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now + 31, repositoryGrantId: relinked.grantId, repositoryGrantGeneration: 2, status: 'queued', createdAt: now + 32, nextAttemptAt: now + 32, attempt: 0 })
    await scenario.persistence.jobs.claimScan({ id: nextScanId, leaseId: nextLeaseId, now: now + 32, leaseExpiresAt: now + 100 })
    await scenario.persistence.jobs.completeScan({ id: nextScanId, leaseId: nextLeaseId, now: now + 33, result: { sourceRevision: 'e'.repeat(40), scan: { adapterId: 'shadcn-v1' }, request: { version: 1 } } })
    const nextAuthority = { ...scenario.authority, scanId: nextScanId, sourceRevision: 'e'.repeat(40), grantGeneration: 2 }
    const nextCandidate = { authority: nextAuthority, records: scenario.candidate.records.map(record => ({ ...record, authority: nextAuthority })), updatedAt: now + 34 }
    await expect(scenario.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toEqual(first.status === 'committed' ? first.snapshot : null)
    const refreshed = await scenario.persistence.sourceBindings.commitAuthorized({ ...scenario.commit, expectedVersion: 1, expectedAuthority: scenario.authority, grantScope: { installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now + 31, repositoryGrantId: relinked.grantId, repositoryGrantGeneration: 2 }, scanScope: { scanJobId: nextScanId, sourceRevision: 'e'.repeat(40), registryFingerprint: scenario.commit.scanScope.registryFingerprint }, candidate: nextCandidate })
    expect(refreshed).toMatchObject({ status: 'committed', snapshot: { version: 2, authority: { grantGeneration: 2 }, records: [{ id: scenario.candidate.records[0]!.id }] } })
  })

  it('COMP-V2-BINDING-001 never carries prior identity across a different repository or installation', async () => {
    const repositoryChange = await bindingScenario()
    await repositoryChange.persistence.sourceBindings.commitAuthorized(repositoryChange.commit)
    await repositoryChange.persistence.grants.saveRepositoryGrant({ ...repository, grantId: '00000000-0000-4000-8000-0000000000a1', repository: { ...repository.repository, id: '4002', name: 'other', fullName: 'canvas-team/other' }, linkedAt: now + 40 })
    await expect(repositoryChange.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toBeNull()

    const installationChange = await bindingScenario()
    await installationChange.persistence.sourceBindings.commitAuthorized(installationChange.commit)
    await installationChange.persistence.grants.saveInstallationGrant({ ...installation, installation: { ...installation.installation, id: '2002' }, connectedAt: now + 41 })
    await installationChange.persistence.grants.saveRepositoryGrant({ ...repository, grantId: '00000000-0000-4000-8000-0000000000a2', installationId: '2002', repository: { ...repository.repository, installationId: '2002' }, linkedAt: now + 41 })
    await expect(installationChange.persistence.sourceBindings.getAuthorized({ actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' })).resolves.toBeNull()
  })
})

async function bindingScenario() {
  const persistence = createMemoryGitHubPersistence()
  persistence.setProjectMembership('project-1', 'tenant-1', 'user-1', 'owner')
  await persistence.grants.saveInstallationGrant(installation)
  const grant = await persistence.grants.saveRepositoryGrant(repository)
  const scanJobId = '00000000-0000-4000-8000-000000000091'
  const leaseId = '00000000-0000-4000-8000-000000000092'
  await persistence.jobs.enqueue({
    id: scanJobId,
    actor: { accountId: 'user-1', providerUserId: '1001' },
    tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan', installationId: grant.installationId,
    repositoryId: grant.repository.id, repositoryLinkedAt: grant.linkedAt, repositoryGrantId: grant.grantId,
    repositoryGrantGeneration: grant.grantGeneration, status: 'queued', createdAt: now + 10, nextAttemptAt: now + 10, attempt: 0,
  })
  await persistence.jobs.claimScan({ id: scanJobId, leaseId, now: now + 10, leaseExpiresAt: now + 100 })
  await persistence.jobs.completeScan({ id: scanJobId, leaseId, now: now + 11, result: { sourceRevision: 'a'.repeat(40), scan: { adapterId: 'shadcn-v1' }, request: { version: 1 } } })
  const authority = Object.freeze({
    repository: Object.freeze({ provider: 'github' as const, projectId: 'project-1', repositoryId: '4001' }),
    scanId: scanJobId, sourceRevision: 'a'.repeat(40), registryFingerprint: `sha256:${'b'.repeat(64)}`,
    grantGeneration: 1, adapterId: 'shadcn-v1',
  })
  const evidence = Object.freeze({ symbolKey: 'button', packageName: '@canvas/ui', path: 'src/button.tsx', exportName: 'Button', sourceHash: 'c'.repeat(64), fingerprint: 'd'.repeat(64) })
  const candidate = Object.freeze({ authority, records: Object.freeze([Object.freeze({ id: '00000000-0000-4000-8000-000000000093', repository: authority.repository, authority, evidence, status: 'bound' as const })]), updatedAt: now + 12 })
  const commit = Object.freeze({
    actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', operation: 'pull' as const,
    expectedVersion: null, expectedAuthority: null,
    grantScope: Object.freeze({ installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now, repositoryGrantId: repository.grantId, repositoryGrantGeneration: 1 }),
    scanScope: Object.freeze({ scanJobId, sourceRevision: 'a'.repeat(40), registryFingerprint: `sha256:${'b'.repeat(64)}` }),
    candidate,
  })
  return { persistence, grant, authority, candidate, commit }
}
