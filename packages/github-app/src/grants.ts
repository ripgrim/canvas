import type { GitHubActor, GitHubGrantStore, GitHubProviderPort, InstallationGrant, LiveRepositoryOperation, ProjectAuthorizationPort, ProjectRepositoryOperation, RepositoryGrant } from './contracts.js'
import type { InstallationStateService } from './state.js'
import { assertLiveRepositoryIntersection, GitHubAppError, githubId, opaqueId, validateActor, validateInstallation } from './validation.js'

export class GitHubGrantService {
  constructor(
    private readonly provider: GitHubProviderPort,
    private readonly store: GitHubGrantStore,
    private readonly states: InstallationStateService,
    private readonly projectAuthorization: ProjectAuthorizationPort,
    private readonly now: () => number = Date.now,
  ) {}

  async completeInstallation(input: Readonly<{
    state: string
    actor: GitHubActor
    installationId: string
  }>): Promise<InstallationGrant> {
    const actor = validateActor(input.actor)
    const installationId = githubId(input.installationId)
    const state = await this.states.consume(input.state, actor.accountId)
    const installations = (await this.provider.listInstallationsForUser(actor)).map(validateInstallation)
    const installation = installations.find(candidate => candidate.id === installationId)
    if (!installation) throw new GitHubAppError('INSTALLATION_NOT_VISIBLE', 'GitHub installation is not available.')
    const grant: InstallationGrant = {
      tenantId: state.tenantId,
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
    const grant: RepositoryGrant = {
      tenantId,
      projectId,
      installationId,
      repository: live.repository,
      linkedByAccountId: actor.accountId,
      linkedAt: this.now(),
    }
    await this.store.saveRepositoryGrant(grant)
    return grant
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
    await this.assertProjectAuthorization({ actor, tenantId, projectId, operation: input.operation })
    const grant = await this.store.getRepositoryGrant({ tenantId, projectId })
    if (!grant) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    const activeInstallation = await this.store.getActiveInstallationGrant({ tenantId, installationId: grant.installationId })
    if (!activeInstallation) throw new GitHubAppError('INSTALLATION_NOT_ACTIVE', 'GitHub installation is not available.')
    const live = await this.loadLiveIntersection(actor, grant.installationId, grant.repository.id)
    return { ...grant, repository: live.repository }
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

  private async loadLiveIntersection(actor: GitHubActor, installationId: string, repositoryId: string) {
    const visibleInstallations = await this.provider.listInstallationsForUser(actor)
    const visibleInstallation = visibleInstallations.map(validateInstallation).find(candidate => candidate.id === installationId)
    if (!visibleInstallation) throw new GitHubAppError('INSTALLATION_NOT_VISIBLE', 'GitHub installation is not available.')
    const repository = await this.provider.getRepositoryForInstallation({ actor, installationId, repositoryId })
    return assertLiveRepositoryIntersection({ installationId, repositoryId, visibleInstallations, repository })
  }
}
