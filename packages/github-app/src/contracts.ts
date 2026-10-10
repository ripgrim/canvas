export type GitHubActor = Readonly<{
  accountId: string
  providerUserId: string
}>

export type ProjectRepositoryOperation = 'link-repository' | 'scan' | 'pull' | 'prepare-patch' | 'write'

export type LiveRepositoryOperation = Exclude<ProjectRepositoryOperation, 'link-repository'>

export type ProjectAuthorizationDecision = Readonly<{
  isMember: boolean
  roleAllowsOperation: boolean
}>

export interface ProjectAuthorizationPort {
  authorizeProjectOperation(input: Readonly<{
    actorAccountId: string
    tenantId: string
    projectId: string
    operation: ProjectRepositoryOperation
  }>): Promise<ProjectAuthorizationDecision>
}

export type GitHubInstallationIdentity = Readonly<{
  id: string
  account: Readonly<{
    id: string
    login: string
    type: 'Organization' | 'User'
  }>
}>

export type GitHubRepositoryIdentity = Readonly<{
  id: string
  installationId: string
  ownerId: string
  ownerLogin: string
  name: string
  fullName: string
  isPrivate: boolean
}>

export type InstallationStateRecord = Readonly<{
  digest: string
  accountId: string
  tenantId: string
  expiresAt: number
}>

export interface InstallationStateStore {
  put(record: InstallationStateRecord): Promise<void>
  consumeByDigest(digest: string): Promise<InstallationStateRecord | null>
}

export interface GitHubProviderPort {
  listInstallationsForUser(actor: GitHubActor): Promise<readonly GitHubInstallationIdentity[]>
  getRepositoryForInstallation(input: Readonly<{
    actor: GitHubActor
    installationId: string
    repositoryId: string
  }>): Promise<GitHubRepositoryIdentity | null>
}

export type InstallationGrant = Readonly<{
  tenantId: string
  installation: GitHubInstallationIdentity
  connectedByAccountId: string
  connectedAt: number
}>

export type RepositoryGrant = Readonly<{
  tenantId: string
  projectId: string
  installationId: string
  repository: GitHubRepositoryIdentity
  linkedByAccountId: string
  linkedAt: number
}>

export type InstallationInvalidationReason = 'deleted' | 'suspended'

export interface GitHubGrantStore {
  saveInstallationGrant(grant: InstallationGrant): Promise<void>
  getActiveInstallationGrant(input: Readonly<{ tenantId: string; installationId: string }>): Promise<InstallationGrant | null>
  saveRepositoryGrant(grant: RepositoryGrant): Promise<void>
  getRepositoryGrant(input: Readonly<{ tenantId: string; projectId: string }>): Promise<RepositoryGrant | null>
  invalidateInstallation(input: Readonly<{
    installationId: string
    reason: InstallationInvalidationReason
    invalidatedAt: number
  }>): Promise<void>
  invalidateRepositories(input: Readonly<{
    installationId: string
    repositoryIds: readonly string[]
    reason: 'removed'
    invalidatedAt: number
  }>): Promise<void>
}

export interface WebhookDeliveryStore {
  claimDelivery(input: Readonly<{ deliveryId: string; receivedAt: number }>): Promise<boolean>
  completeDelivery(input: Readonly<{ deliveryId: string; completedAt: number }>): Promise<void>
  releaseDelivery(input: Readonly<{ deliveryId: string }>): Promise<void>
}
