import { describe, expect, it } from 'vitest'
import type { InstallationGrant, RepositoryGrant } from '@canvas/github-app'
import { createMemoryGitHubPersistence, roleAllowsProjectOperation } from '../src/github'

const now = 1_800_000_000_000
const installation: InstallationGrant = Object.freeze({
  tenantId: 'tenant-1',
  installation: Object.freeze({ id: '2001', account: Object.freeze({ id: '3001', login: 'canvas-team', type: 'Organization' }), contentsPermission: 'write' }),
  connectedByAccountId: 'user-1',
  connectedAt: now,
})
const repository: RepositoryGrant = Object.freeze({
  grantId: '00000000-0000-4000-8000-000000000077',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  installationId: '2001',
  repository: Object.freeze({ id: '4001', installationId: '2001', ownerId: '3001', ownerLogin: 'canvas-team', name: 'design-system', fullName: 'canvas-team/design-system', isPrivate: true, contentsPermission: 'write' }),
  linkedByAccountId: 'user-1',
  linkedAt: now,
})

describe('GitHub App persistence adapters', () => {
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
      status: 'queued',
      createdAt: now,
      nextAttemptAt: now,
      attempt: 0,
    })
    await persistence.jobs.claimScan({ id: jobId, leaseId, now, leaseExpiresAt: now + 100 })
    const artifact = { sourceRevision: 'a'.repeat(40), scan: { adapterId: 'shadcn-v1' }, request: { version: 1 } }
    expect(await persistence.jobs.completeScan({ id: jobId, leaseId, now: now + 1, result: artifact })).toBe(true)
    const scope = { actorAccountId: 'user-1', tenantId: 'tenant-1', projectId: 'project-1', installationId: '2001', repositoryId: '4001', repositoryLinkedAt: now, repositoryGrantId: repository.grantId }
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
})
