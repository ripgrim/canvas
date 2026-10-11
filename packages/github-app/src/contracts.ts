export type GitHubActor = Readonly<{ accountId: string; providerUserId: string }>
export type ProjectRepositoryOperation = 'link-repository' | 'scan' | 'pull' | 'prepare-patch' | 'write'
export type LiveRepositoryOperation = Exclude<ProjectRepositoryOperation, 'link-repository'>
export type RepositoryContentsPermission = 'none' | 'read' | 'write'
export type InstallationStatePurpose = 'authorize-user' | 'install-app'

export type ProjectAuthorizationDecision = Readonly<{ isMember: boolean; roleAllowsOperation: boolean }>
export interface ProjectAuthorizationPort {
  authorizeProjectOperation(input: Readonly<{ actorAccountId: string; tenantId: string; projectId: string; operation: ProjectRepositoryOperation }>): Promise<ProjectAuthorizationDecision>
}

export type GitHubInstallationIdentity = Readonly<{
  id: string
  account: Readonly<{ id: string; login: string; type: 'Organization' | 'User' }>
  contentsPermission: RepositoryContentsPermission
}>
export type GitHubRepositoryIdentity = Readonly<{
  id: string
  installationId: string
  ownerId: string
  ownerLogin: string
  name: string
  fullName: string
  isPrivate: boolean
  contentsPermission: RepositoryContentsPermission
}>

export type InstallationStateRecord = Readonly<{
  digest: string
  accountId: string
  tenantId: string
  purpose: InstallationStatePurpose
  installationId: string | null
  codeVerifierCiphertext: string | null
  expiresAt: number
}>
export interface InstallationStateStore {
  put(record: InstallationStateRecord): Promise<void>
  consume(input: Readonly<{ digest: string; accountId: string; purpose: InstallationStatePurpose; now: number }>): Promise<InstallationStateRecord | null>
}

export interface GitHubProviderPort {
  listInstallationsForUser(actor: GitHubActor): Promise<readonly GitHubInstallationIdentity[]>
  getRepositoryForInstallation(input: Readonly<{ actor: GitHubActor; installationId: string; repositoryId: string }>): Promise<GitHubRepositoryIdentity | null>
}

export type InstallationGrant = Readonly<{ tenantId: string; installation: GitHubInstallationIdentity; connectedByAccountId: string; connectedAt: number }>
export type RepositoryGrant = Readonly<{ tenantId: string; projectId: string; installationId: string; repository: GitHubRepositoryIdentity; linkedByAccountId: string; linkedAt: number }>
export type RepositoryAccessSnapshot = Readonly<{ grant: RepositoryGrant; installation: InstallationGrant }>
export type InstallationInvalidationReason = 'deleted' | 'suspended'

export interface GitHubGrantStore {
  saveInstallationGrant(grant: InstallationGrant): Promise<void>
  getActiveInstallationGrant(input: Readonly<{ tenantId: string; installationId: string }>): Promise<InstallationGrant | null>
  saveRepositoryGrant(grant: RepositoryGrant): Promise<void>
  getRepositoryGrant(input: Readonly<{ tenantId: string; projectId: string }>): Promise<RepositoryGrant | null>
  getAuthorizedRepositoryAccess(input: Readonly<{ actorAccountId: string; tenantId: string; projectId: string; operation: LiveRepositoryOperation }>): Promise<RepositoryAccessSnapshot | null>
  invalidateInstallation(input: Readonly<{ installationId: string; reason: InstallationInvalidationReason; invalidatedAt: number }>): Promise<void>
  invalidateRepositories(input: Readonly<{ installationId: string; repositoryIds: readonly string[]; reason: 'removed'; invalidatedAt: number }>): Promise<void>
}

export type WebhookDeliveryClaim = Readonly<{ leaseId: string }>
export interface WebhookDeliveryStore {
  claimDelivery(input: Readonly<{ deliveryId: string; eventName: string; bodyDigest: string; receivedAt: number; leaseExpiresAt: number }>): Promise<WebhookDeliveryClaim | null>
  completeDelivery(input: Readonly<{ deliveryId: string; leaseId: string; completedAt: number }>): Promise<void>
  releaseDelivery(input: Readonly<{ deliveryId: string; leaseId: string }>): Promise<void>
}

export type RepositoryJob = Readonly<{
  id: string
  actor: GitHubActor
  tenantId: string
  projectId: string
  operation: LiveRepositoryOperation
  installationId: string
  repositoryId: string
  status: 'queued' | 'running'
  createdAt: number
}>

export interface RepositoryJobStore {
  enqueue(job: RepositoryJob): Promise<void>
  get(id: string): Promise<RepositoryJob | null>
  markRunning(id: string): Promise<void>
}

export type InstallationAccessToken = Readonly<{ token: string; expiresAt: number; contentsPermission: 'read' | 'write' }>
export interface InstallationTokenPort {
  mint(input: Readonly<{ installationId: string; repositoryId: string; contentsPermission: 'read' | 'write' }>): Promise<InstallationAccessToken>
}
