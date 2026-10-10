import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  GitHubAppError,
  GitHubGrantService,
  GitHubWebhookService,
  InstallationStateService,
  type GitHubActor,
  type GitHubGrantStore,
  type GitHubInstallationIdentity,
  type GitHubProviderPort,
  type GitHubRepositoryIdentity,
  type InstallationGrant,
  type InstallationStateRecord,
  type InstallationStateStore,
  type ProjectAuthorizationPort,
  type RepositoryGrant,
  type WebhookDeliveryStore,
} from '../src/index.js'

const now = 1_800_000_000_000
const stateValue = 'state_value_that_is_long_enough_1234567890'
const actor: GitHubActor = { accountId: 'account-1', providerUserId: '1001' }
const installation: GitHubInstallationIdentity = { id: '2001', account: { id: '3001', login: 'canvas-team', type: 'Organization' } }
const repository: GitHubRepositoryIdentity = {
  id: '4001',
  installationId: installation.id,
  ownerId: installation.account.id,
  ownerLogin: installation.account.login,
  name: 'design-system',
  fullName: 'canvas-team/design-system',
  isPrivate: true,
}
const allowProjectAccess: ProjectAuthorizationPort = {
  async authorizeProjectOperation() {
    return { isMember: true, roleAllowsOperation: true }
  },
}

class MemoryStateStore implements InstallationStateStore {
  readonly records = new Map<string, InstallationStateRecord>()

  async put(record: InstallationStateRecord) {
    this.records.set(record.digest, record)
  }

  async consumeByDigest(digest: string) {
    const record = this.records.get(digest) ?? null
    this.records.delete(digest)
    return record
  }
}

class MemoryGrantStore implements GitHubGrantStore {
  installationGrant: InstallationGrant | null = null
  repositoryGrant: RepositoryGrant | null = null
  activeInstallationReads = 0
  repositoryGrantReads = 0
  readonly installationInvalidations: Array<{ installationId: string; reason: string }> = []
  readonly repositoryInvalidations: Array<{ installationId: string; repositoryIds: readonly string[] }> = []

  async saveInstallationGrant(grant: InstallationGrant) {
    this.installationGrant = grant
  }

  async getActiveInstallationGrant(input: { tenantId: string; installationId: string }) {
    this.activeInstallationReads += 1
    const grant = this.installationGrant
    return grant?.tenantId === input.tenantId && grant.installation.id === input.installationId ? grant : null
  }

  async saveRepositoryGrant(grant: RepositoryGrant) {
    this.repositoryGrant = grant
  }

  async getRepositoryGrant(input: { tenantId: string; projectId: string }) {
    this.repositoryGrantReads += 1
    const grant = this.repositoryGrant
    return grant?.tenantId === input.tenantId && grant.projectId === input.projectId ? grant : null
  }

  async invalidateInstallation(input: { installationId: string; reason: 'deleted' | 'suspended' }) {
    this.installationInvalidations.push(input)
    if (this.installationGrant?.installation.id === input.installationId) this.installationGrant = null
  }

  async invalidateRepositories(input: { installationId: string; repositoryIds: readonly string[] }) {
    this.repositoryInvalidations.push(input)
    if (this.repositoryGrant?.installationId === input.installationId && input.repositoryIds.includes(this.repositoryGrant.repository.id)) this.repositoryGrant = null
  }
}

class MemoryDeliveryStore implements WebhookDeliveryStore {
  readonly claimed = new Set<string>()
  readonly completed = new Set<string>()

  async claimDelivery(input: { deliveryId: string }) {
    if (this.claimed.has(input.deliveryId) || this.completed.has(input.deliveryId)) return false
    this.claimed.add(input.deliveryId)
    return true
  }

  async completeDelivery(input: { deliveryId: string }) {
    this.claimed.delete(input.deliveryId)
    this.completed.add(input.deliveryId)
  }

  async releaseDelivery(input: { deliveryId: string }) {
    this.claimed.delete(input.deliveryId)
  }
}

function provider(input: Readonly<{
  installations?: readonly GitHubInstallationIdentity[]
  repository?: GitHubRepositoryIdentity | null
}> = {}): GitHubProviderPort {
  return {
    async listInstallationsForUser() {
      return input.installations ?? [installation]
    },
    async getRepositoryForInstallation() {
      return input.repository === undefined ? repository : input.repository
    },
  }
}

async function connectedService(providerPort: GitHubProviderPort = provider(), projectAuthorization: ProjectAuthorizationPort = allowProjectAccess) {
  const stateStore = new MemoryStateStore()
  const grantStore = new MemoryGrantStore()
  const states = new InstallationStateService(stateStore, { now: () => now, createState: () => stateValue })
  const grants = new GitHubGrantService(providerPort, grantStore, states, projectAuthorization, () => now)
  const issued = await states.issue({ accountId: actor.accountId, tenantId: 'tenant-1' })
  await grants.completeInstallation({ state: issued.state, actor, installationId: installation.id })
  return { grants, grantStore, states }
}

function errorCode(error: unknown) {
  return error instanceof GitHubAppError ? error.code : null
}

function body(payload: unknown) {
  return JSON.stringify(payload)
}

const webhookSecret = 'webhook-secret-with-enough-entropy'

function signature(payload: string) {
  return `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`
}

describe('single-use installation state', () => {
  it('consumes a valid state exactly once', async () => {
    const store = new MemoryStateStore()
    const states = new InstallationStateService(store, { now: () => now, createState: () => stateValue })
    const issued = await states.issue({ accountId: actor.accountId, tenantId: 'tenant-1' })

    await expect(states.consume(issued.state, actor.accountId)).resolves.toEqual({ tenantId: 'tenant-1' })
    await expect(states.consume(issued.state, actor.accountId)).rejects.toSatisfy(error => errorCode(error) === 'INVALID_STATE')
  })

  it('rejects malformed, altered, wrong-account, and expired state', async () => {
    const store = new MemoryStateStore()
    let currentTime = now
    const states = new InstallationStateService(store, { now: () => currentTime, createState: () => stateValue, ttlMs: 60_000 })

    await expect(states.consume('short', actor.accountId)).rejects.toSatisfy(error => errorCode(error) === 'INVALID_STATE')
    await expect(states.consume(`${stateValue.slice(0, -1)}x`, actor.accountId)).rejects.toSatisfy(error => errorCode(error) === 'INVALID_STATE')
    const wrongAccount = await states.issue({ accountId: actor.accountId, tenantId: 'tenant-1' })
    await expect(states.consume(wrongAccount.state, 'account-2')).rejects.toSatisfy(error => errorCode(error) === 'INVALID_STATE')
    const expired = await states.issue({ accountId: actor.accountId, tenantId: 'tenant-1' })
    currentTime += 60_001
    await expect(states.consume(expired.state, actor.accountId)).rejects.toSatisfy(error => errorCode(error) === 'EXPIRED_STATE')
  })
})

describe('installation and repository grants', () => {
  it('rejects a spoofed callback installation unless it is live-visible to the same user', async () => {
    const stateStore = new MemoryStateStore()
    const grantStore = new MemoryGrantStore()
    const states = new InstallationStateService(stateStore, { now: () => now, createState: () => stateValue })
    const grants = new GitHubGrantService(provider({ installations: [] }), grantStore, states, allowProjectAccess, () => now)
    const issued = await states.issue({ accountId: actor.accountId, tenantId: 'tenant-1' })

    await expect(grants.completeInstallation({ state: issued.state, actor, installationId: '9999' })).rejects.toSatisfy(error => errorCode(error) === 'INSTALLATION_NOT_VISIBLE')
    expect(grantStore.installationGrant).toBeNull()
    await expect(grants.completeInstallation({ state: issued.state, actor, installationId: '9999' })).rejects.toSatisfy(error => errorCode(error) === 'INVALID_STATE')
  })

  it('rejects an installation visible to a different provider user', async () => {
    const stateStore = new MemoryStateStore()
    const grantStore = new MemoryGrantStore()
    const states = new InstallationStateService(stateStore, { now: () => now, createState: () => stateValue })
    const scopedProvider: GitHubProviderPort = {
      async listInstallationsForUser(currentActor) {
        return currentActor.providerUserId === actor.providerUserId ? [installation] : []
      },
      async getRepositoryForInstallation() {
        return repository
      },
    }
    const grants = new GitHubGrantService(scopedProvider, grantStore, states, allowProjectAccess, () => now)
    const issued = await states.issue({ accountId: 'account-2', tenantId: 'tenant-1' })

    await expect(grants.completeInstallation({ state: issued.state, actor: { accountId: 'account-2', providerUserId: '1002' }, installationId: installation.id })).rejects.toSatisfy(error => errorCode(error) === 'INSTALLATION_NOT_VISIBLE')
  })

  it('links and rechecks a stable repository identity through the active installation', async () => {
    const { grants, grantStore } = await connectedService()
    const linked = await grants.linkRepository({ actor, tenantId: 'tenant-1', projectId: 'project-1', installationId: installation.id, repositoryId: repository.id })

    expect(linked.repository).toEqual(repository)
    await expect(grants.assertLiveRepositoryAccess({ actor, tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan' })).resolves.toMatchObject({ repository })
    grantStore.installationGrant = null
    await expect(grants.assertLiveRepositoryAccess({ actor, tenantId: 'tenant-1', projectId: 'project-1', operation: 'scan' })).rejects.toSatisfy(error => errorCode(error) === 'INSTALLATION_NOT_ACTIVE')
  })

  it('rejects a repository returned from another installation', async () => {
    const wrongRepository = { ...repository, installationId: '2999' }
    const { grants, grantStore } = await connectedService(provider({ repository: wrongRepository }))

    await expect(grants.linkRepository({ actor, tenantId: 'tenant-1', projectId: 'project-1', installationId: installation.id, repositoryId: repository.id })).rejects.toSatisfy(error => errorCode(error) === 'REPOSITORY_NOT_VISIBLE')
    expect(grantStore.repositoryGrant).toBeNull()
  })

  it('negative control rejects a plausible repository when the live installation intersection is empty', async () => {
    let repositoryLookupCount = 0
    const mutationSeam: GitHubProviderPort = {
      async listInstallationsForUser() {
        return []
      },
      async getRepositoryForInstallation() {
        repositoryLookupCount += 1
        return repository
      },
    }
    const grantStore = new MemoryGrantStore()
    grantStore.installationGrant = { tenantId: 'tenant-1', installation, connectedByAccountId: actor.accountId, connectedAt: now }
    const hardened = new GitHubGrantService(mutationSeam, grantStore, new InstallationStateService(new MemoryStateStore(), { now: () => now }), allowProjectAccess, () => now)

    await expect(hardened.linkRepository({ actor, tenantId: 'tenant-1', projectId: 'project-1', installationId: installation.id, repositoryId: repository.id })).rejects.toSatisfy(error => errorCode(error) === 'INSTALLATION_NOT_VISIBLE')
    expect(repositoryLookupCount).toBe(0)
  })

  it('AT-REPO-LINK-001 negative control rejects a non-member before reading grants or querying GitHub', async () => {
    const authorization = vi.fn<ProjectAuthorizationPort['authorizeProjectOperation']>().mockResolvedValue({ isMember: false, roleAllowsOperation: true })
    const listInstallationsForUser = vi.fn<GitHubProviderPort['listInstallationsForUser']>().mockResolvedValue([installation])
    const getRepositoryForInstallation = vi.fn<GitHubProviderPort['getRepositoryForInstallation']>().mockResolvedValue(repository)
    const grantStore = new MemoryGrantStore()
    grantStore.installationGrant = { tenantId: 'tenant-1', installation, connectedByAccountId: actor.accountId, connectedAt: now }
    const grants = new GitHubGrantService(
      { listInstallationsForUser, getRepositoryForInstallation },
      grantStore,
      new InstallationStateService(new MemoryStateStore(), { now: () => now }),
      { authorizeProjectOperation: authorization },
      () => now,
    )
    const unrelatedActor = { accountId: 'account-2', providerUserId: '1002' }

    await expect(grants.linkRepository({ actor: unrelatedActor, tenantId: 'tenant-1', projectId: 'project-1', installationId: installation.id, repositoryId: repository.id })).rejects.toSatisfy(error => errorCode(error) === 'REPOSITORY_NOT_VISIBLE')
    expect(authorization).toHaveBeenCalledWith({ actorAccountId: unrelatedActor.accountId, tenantId: 'tenant-1', projectId: 'project-1', operation: 'link-repository' })
    expect(grantStore.activeInstallationReads).toBe(0)
    expect(grantStore.repositoryGrant).toBeNull()
    expect(listInstallationsForUser).not.toHaveBeenCalled()
    expect(getRepositoryForInstallation).not.toHaveBeenCalled()
  })

  it('AT-REPO-LINK-001 negative control rejects a member whose role cannot write before reading or returning a grant', async () => {
    const authorization = vi.fn<ProjectAuthorizationPort['authorizeProjectOperation']>().mockResolvedValue({ isMember: true, roleAllowsOperation: false })
    const listInstallationsForUser = vi.fn<GitHubProviderPort['listInstallationsForUser']>().mockResolvedValue([installation])
    const getRepositoryForInstallation = vi.fn<GitHubProviderPort['getRepositoryForInstallation']>().mockResolvedValue(repository)
    const grantStore = new MemoryGrantStore()
    grantStore.installationGrant = { tenantId: 'tenant-1', installation, connectedByAccountId: actor.accountId, connectedAt: now }
    grantStore.repositoryGrant = { tenantId: 'tenant-1', projectId: 'project-1', installationId: installation.id, repository, linkedByAccountId: actor.accountId, linkedAt: now }
    const grants = new GitHubGrantService(
      { listInstallationsForUser, getRepositoryForInstallation },
      grantStore,
      new InstallationStateService(new MemoryStateStore(), { now: () => now }),
      { authorizeProjectOperation: authorization },
      () => now,
    )

    await expect(grants.assertLiveRepositoryAccess({ actor, tenantId: 'tenant-1', projectId: 'project-1', operation: 'write' })).rejects.toSatisfy(error => errorCode(error) === 'REPOSITORY_NOT_VISIBLE')
    expect(authorization).toHaveBeenCalledWith({ actorAccountId: actor.accountId, tenantId: 'tenant-1', projectId: 'project-1', operation: 'write' })
    expect(grantStore.repositoryGrantReads).toBe(0)
    expect(grantStore.activeInstallationReads).toBe(0)
    expect(listInstallationsForUser).not.toHaveBeenCalled()
    expect(getRepositoryForInstallation).not.toHaveBeenCalled()
  })
})

describe('webhook verification and lifecycle invalidation', () => {
  it('rejects an invalid signature before claiming the delivery', async () => {
    const deliveries = new MemoryDeliveryStore()
    const grants = new MemoryGrantStore()
    const service = new GitHubWebhookService(webhookSecret, deliveries, grants, () => now)
    const payload = body({ action: 'suspend', installation: { id: 2001 } })

    await expect(service.handle({ deliveryId: 'delivery-0001', eventName: 'installation', signature: `sha256=${'0'.repeat(64)}`, body: payload })).rejects.toSatisfy(error => errorCode(error) === 'INVALID_WEBHOOK_SIGNATURE')
    expect(deliveries.claimed.size).toBe(0)
    expect(deliveries.completed.size).toBe(0)
  })

  it('rejects duplicate deliveries', async () => {
    const deliveries = new MemoryDeliveryStore()
    const grants = new MemoryGrantStore()
    const service = new GitHubWebhookService(webhookSecret, deliveries, grants, () => now)
    const payload = body({ action: 'suspend', installation: { id: 2001 } })
    const request = { deliveryId: 'delivery-0002', eventName: 'installation', signature: signature(payload), body: payload }

    await expect(service.handle(request)).resolves.toMatchObject({ status: 'applied' })
    await expect(service.handle(request)).rejects.toSatisfy(error => errorCode(error) === 'DUPLICATE_DELIVERY')
    expect(grants.installationInvalidations).toHaveLength(1)
  })

  it('invalidates suspended and deleted installations and removed repositories', async () => {
    const deliveries = new MemoryDeliveryStore()
    const grants = new MemoryGrantStore()
    const service = new GitHubWebhookService(webhookSecret, deliveries, grants, () => now)
    const suspend = body({ action: 'suspend', installation: { id: 2001 } })
    const deleted = body({ action: 'deleted', installation: { id: 2002 } })
    const removed = body({ action: 'removed', installation: { id: 2001 }, repositories_removed: [{ id: 4001 }, { id: 4002 }] })

    await service.handle({ deliveryId: 'delivery-0003', eventName: 'installation', signature: signature(suspend), body: suspend })
    await service.handle({ deliveryId: 'delivery-0004', eventName: 'installation', signature: signature(deleted), body: deleted })
    await service.handle({ deliveryId: 'delivery-0005', eventName: 'installation_repositories', signature: signature(removed), body: removed })

    expect(grants.installationInvalidations).toEqual([
      { installationId: '2001', reason: 'suspended', invalidatedAt: now },
      { installationId: '2002', reason: 'deleted', invalidatedAt: now },
    ])
    expect(grants.repositoryInvalidations).toEqual([{ installationId: '2001', repositoryIds: ['4001', '4002'], reason: 'removed', invalidatedAt: now }])
  })
})
