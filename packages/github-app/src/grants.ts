import type { GitHubActor, GitHubComponentAdmissionAccess, GitHubGrantStore, GitHubProviderPort, GitHubRepositoryIdentity, InstallationGrant, LiveRepositoryOperation, ProjectAuthorizationPort, ProjectRepositoryOperation, RepositoryAccessSnapshot, RepositoryGrant } from './contracts.js'
import type { InstallationStateService } from './state.js'
import { randomUUID } from 'node:crypto'
import { assertLiveRepositoryIntersection, GitHubAppError, githubId, opaqueId, validateActor, validateInstallation, validateRepository } from './validation.js'

export class GitHubGrantService {
  constructor(
    private readonly provider: GitHubProviderPort,
    private readonly store: GitHubGrantStore,
    private readonly states: InstallationStateService,
    private readonly projectAuthorization: ProjectAuthorizationPort,
    private readonly now: () => number = Date.now,
    private readonly createGrantId: () => string = randomUUID,
  ) {}

  async completeInstallation(input: Readonly<{
    state: string
    actor: GitHubActor
    installationId: string
  }>): Promise<InstallationGrant> {
    const actor = validateActor(input.actor)
    const installationId = githubId(input.installationId)
    const state = await this.states.consume(input.state, actor.accountId, 'authorize-user')
    if (state.installationId !== installationId) throw new GitHubAppError('INVALID_STATE', 'GitHub connection could not be verified.')
    return this.connectInstallation({ actor, tenantId: state.tenantId, installationId })
  }

  async connectInstallation(input: Readonly<{ actor: GitHubActor; tenantId: string; installationId: string }>): Promise<InstallationGrant> {
    const actor = validateActor(input.actor)
    const installationId = githubId(input.installationId)
    const tenantId = opaqueId(input.tenantId)
    const installations = (await this.provider.listInstallationsForUser(actor)).map(validateInstallation)
    const installation = installations.find(candidate => candidate.id === installationId)
    if (!installation) throw new GitHubAppError('INSTALLATION_NOT_VISIBLE', 'GitHub installation is not available.')
    const grant: InstallationGrant = {
      tenantId,
      installation,
      connectedByAccountId: actor.accountId,
      connectedAt: this.now(),
    }
    await this.store.saveInstallationGrant(grant)
    return grant
  }

  async linkRepository(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
    installationId: string
    repositoryId: string
  }>): Promise<RepositoryGrant> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = opaqueId(input.projectId)
    const installationId = githubId(input.installationId)
    const repositoryId = githubId(input.repositoryId)
    await this.assertProjectAuthorization({ actor, tenantId, projectId, operation: 'link-repository' })
    const installationGrant = await this.store.getActiveInstallationGrant({ tenantId, installationId })
    if (!installationGrant) throw new GitHubAppError('INSTALLATION_NOT_ACTIVE', 'GitHub installation is not available.')
    const live = await this.loadLiveIntersection(actor, installationId, repositoryId)
    assertPermissionIntersection(live.installation.contentsPermission, live.repository.contentsPermission, 'scan')
    const grant = {
      grantId: this.createGrantId(),
      tenantId,
      projectId,
      installationId,
      repository: live.repository,
      linkedByAccountId: actor.accountId,
      linkedAt: this.now(),
    }
    const stored = await this.store.saveRepositoryGrant(grant)
    if (!sameGrantInput(stored, grant) || !Number.isSafeInteger(stored.grantGeneration) || stored.grantGeneration < 1) {
      throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    }
    return stored
  }

  async listLinkableRepositories(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
    installationId: string
  }>): Promise<readonly GitHubRepositoryIdentity[]> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = opaqueId(input.projectId)
    const installationId = githubId(input.installationId)
    await this.assertProjectAuthorization({ actor, tenantId, projectId, operation: 'link-repository' })
    const installationGrant = await this.store.getActiveInstallationGrant({ tenantId, installationId })
    if (!installationGrant) throw new GitHubAppError('INSTALLATION_NOT_ACTIVE', 'GitHub installation is not available.')
    const visible = (await this.provider.listInstallationsForUser(actor)).map(validateInstallation).find(candidate => candidate.id === installationId)
    if (!visible || visible.contentsPermission === 'none' || !this.provider.listRepositoriesForInstallation) throw new GitHubAppError('INSTALLATION_NOT_VISIBLE', 'GitHub installation is not available.')
    const repositories = (await this.provider.listRepositoriesForInstallation({ actor, installationId })).map(validateRepository)
    if (repositories.some(repository => repository.installationId !== installationId) || new Set(repositories.map(repository => repository.id)).size !== repositories.length) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    return Object.freeze(repositories.filter(repository => repository.contentsPermission !== 'none').sort((left, right) => left.fullName.localeCompare(right.fullName)))
  }

  async assertLiveRepositoryAccess(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
    operation: LiveRepositoryOperation
  }>): Promise<RepositoryGrant> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = opaqueId(input.projectId)
    const before = await this.authorizedSnapshot(actor, tenantId, projectId, input.operation)
    const live = await this.loadLiveIntersection(actor, before.grant.installationId, before.grant.repository.id)
    assertPermissionIntersection(live.installation.contentsPermission, live.repository.contentsPermission, input.operation)
    const after = await this.authorizedSnapshot(actor, tenantId, projectId, input.operation)
    if (!sameSnapshot(before, after)) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    return { ...after.grant, repository: live.repository }
  }

  async authorizeComponentAdmission(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
  }>): Promise<GitHubComponentAdmissionAccess> {
    const grant = await this.assertLiveRepositoryAccess({ ...input, operation: 'scan' })
    return { provider: 'github', projectId: grant.projectId, repositoryId: grant.repository.id }
  }

  private async assertProjectAuthorization(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
    operation: ProjectRepositoryOperation
  }>): Promise<void> {
    const decision = await this.projectAuthorization.authorizeProjectOperation({
      actorAccountId: input.actor.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      operation: input.operation,
    })
    if (!decision.isMember || !decision.roleAllowsOperation) {
      throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    }
  }

  private async authorizedSnapshot(actor: GitHubActor, tenantId: string, projectId: string, operation: LiveRepositoryOperation): Promise<RepositoryAccessSnapshot> {
    const snapshot = await this.store.getAuthorizedRepositoryAccess({ actorAccountId: actor.accountId, tenantId, projectId, operation })
    if (!snapshot) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    return snapshot
  }

  private async loadLiveIntersection(actor: GitHubActor, installationId: string, repositoryId: string) {
    const visibleInstallations = await this.provider.listInstallationsForUser(actor)
    const visibleInstallation = visibleInstallations.map(validateInstallation).find(candidate => candidate.id === installationId)
    if (!visibleInstallation) throw new GitHubAppError('INSTALLATION_NOT_VISIBLE', 'GitHub installation is not available.')
    const repository = await this.provider.getRepositoryForInstallation({ actor, installationId, repositoryId })
    return assertLiveRepositoryIntersection({ installationId, repositoryId, visibleInstallations, repository })
  }
}

function assertPermission(permission: 'none' | 'read' | 'write', operation: LiveRepositoryOperation): void {
  const allowed = operation === 'write' ? permission === 'write' : permission === 'read' || permission === 'write'
  if (!allowed) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
}

function assertPermissionIntersection(
  installationPermission: 'none' | 'read' | 'write',
  repositoryPermission: 'none' | 'read' | 'write',
  operation: LiveRepositoryOperation,
): void {
  assertPermission(installationPermission, operation)
  assertPermission(repositoryPermission, operation)
}

function sameSnapshot(left: RepositoryAccessSnapshot, right: RepositoryAccessSnapshot): boolean {
  return left.grant.grantId === right.grant.grantId
    && left.grant.tenantId === right.grant.tenantId
    && left.grant.projectId === right.grant.projectId
    && left.grant.installationId === right.grant.installationId
    && left.grant.repository.id === right.grant.repository.id
    && left.grant.linkedAt === right.grant.linkedAt
    && left.grant.grantGeneration === right.grant.grantGeneration
    && left.installation.installation.id === right.installation.installation.id
}

function sameGrantInput(left: RepositoryGrant, right: Omit<RepositoryGrant, 'grantGeneration'>): boolean {
  return left.grantId === right.grantId
    && left.tenantId === right.tenantId
    && left.projectId === right.projectId
    && left.installationId === right.installationId
    && left.repository.id === right.repository.id
    && left.repository.installationId === right.repository.installationId
    && left.linkedByAccountId === right.linkedByAccountId
    && left.linkedAt === right.linkedAt
}
