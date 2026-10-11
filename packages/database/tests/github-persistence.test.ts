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
    const state = Object.freeze({ digest: 'a'.repeat(64), accountId: 'user-1', tenantId: 'tenant-1', purpose: 'install-app' as const, installationId: null, codeVerifierCiphertext: null, expiresAt: now + 60_000 })
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
