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
  returnToUrl: string | null
  expiresAt: number
}>
export interface InstallationStateStore {
  put(record: InstallationStateRecord): Promise<void>
  consume(input: Readonly<{ digest: string; accountId: string; purpose: InstallationStatePurpose; now: number }>): Promise<InstallationStateRecord | null>
}

export interface GitHubProviderPort {
  listInstallationsForUser(actor: GitHubActor): Promise<readonly GitHubInstallationIdentity[]>
  listRepositoriesForInstallation?(input: Readonly<{ actor: GitHubActor; installationId: string }>): Promise<readonly GitHubRepositoryIdentity[]>
  getRepositoryForInstallation(input: Readonly<{ actor: GitHubActor; installationId: string; repositoryId: string }>): Promise<GitHubRepositoryIdentity | null>
}

export type InstallationGrant = Readonly<{ tenantId: string; installation: GitHubInstallationIdentity; connectedByAccountId: string; connectedAt: number }>
export type RepositoryGrant = Readonly<{ grantId: string; tenantId: string; projectId: string; installationId: string; repository: GitHubRepositoryIdentity; linkedByAccountId: string; linkedAt: number }>
export type RepositoryAccessSnapshot = Readonly<{ grant: RepositoryGrant; installation: InstallationGrant }>
export type GitHubComponentAdmissionAccess = Readonly<{ provider: 'github'; projectId: string; repositoryId: string }>
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

type RepositoryJobBase = Readonly<{
  id: string
  actor: GitHubActor
  tenantId: string
  projectId: string
  operation: LiveRepositoryOperation
  installationId: string
  repositoryId: string
  repositoryLinkedAt: number
  repositoryGrantId: string
  createdAt: number
  attempt: number
}>

export type RepositoryScanArtifact = Readonly<{
  sourceRevision: string
  scan: Readonly<Record<string, unknown>>
  request: Readonly<Record<string, unknown>>
}>

export type RepositoryJob = RepositoryJobBase & (
  | Readonly<{ status: 'queued'; nextAttemptAt: number; leaseId?: never; leaseExpiresAt?: never }>
  | Readonly<{ status: 'running'; leaseId: string; leaseExpiresAt: number }>
  | Readonly<{ status: 'completed'; result: RepositoryScanArtifact; completedAt: number; leaseId?: never; leaseExpiresAt?: never }>
  | Readonly<{ status: 'failed'; errorId: string; failedAt: number; leaseId?: never; leaseExpiresAt?: never }>
)

export type RepositoryJobClaimInput = Readonly<{ id: string; leaseId: string; now: number; leaseExpiresAt: number }>
export type RepositoryJobQueueClaimInput = Omit<RepositoryJobClaimInput, 'id'>
export type RepositoryJobLeaseInput = Readonly<{ id: string; leaseId: string }>
export type RepositoryJobCompleteInput = RepositoryJobLeaseInput & Readonly<{ now: number; result: RepositoryScanArtifact }>
export type RepositoryJobRetryInput = RepositoryJobLeaseInput & Readonly<{ nextAttemptAt: number }>
export type RepositoryJobFailInput = RepositoryJobLeaseInput & Readonly<{ now: number; errorId: string }>
export type RepositoryJobScope = Readonly<{
  actorAccountId: string
  tenantId: string
  projectId: string
  installationId: string
  repositoryId: string
  repositoryLinkedAt: number
  repositoryGrantId: string
}>

export type RepositoryDocsReviewStatus = 'queued_prepare' | 'preparing' | 'prepared' | 'queued_save' | 'saving' | 'saved' | 'stale' | 'failed'
export type RepositoryDocsReview = Readonly<{
  id: string
  tenantId: string
  projectId: string
  fileId: string
  fileRevision: number
  fileDocumentSha256: string
  scanJobId: string
  installationId: string
  repositoryId: string
  repositoryGrantId: string
  repositoryLinkedAt: number
  createdByAccountId: string
  approvedByAccountId: string | null
  baseRef: string
  baseCommitSha: string
  baseTreeSha: string
  adapter: Readonly<Record<string, unknown>>
  preparedBundle: Readonly<Record<string, unknown>> | null
  approvalDigest: string | null
  status: RepositoryDocsReviewStatus
  attempt: number
  leaseId: string | null
  leaseExpiresAt: number | null
  nextAttemptAt: number | null
  errorId: string | null
  createdAt: number
  preparedAt: number | null
  approvedAt: number | null
  proposedCommitSha: string | null
  committedSha: string | null
  completedAt: number | null
  failedAt: number | null
}>

export type RepositoryDocsReviewCreate = Omit<RepositoryDocsReview, 'approvedByAccountId' | 'preparedBundle' | 'approvalDigest' | 'status' | 'attempt' | 'leaseId' | 'leaseExpiresAt' | 'nextAttemptAt' | 'errorId' | 'preparedAt' | 'approvedAt' | 'proposedCommitSha' | 'committedSha' | 'completedAt' | 'failedAt'>

export interface RepositoryDocsReviewStore {
  enqueuePrepare(input: RepositoryDocsReviewCreate): Promise<RepositoryDocsReview>
  get(id: string): Promise<RepositoryDocsReview | null>
  getAuthorized(id: string, actorAccountId: string): Promise<RepositoryDocsReview | null>
  getLatestAuthorized(projectId: string, fileId: string, actorAccountId: string): Promise<RepositoryDocsReview | null>
  claimNextPrepare(input: Readonly<{ leaseId: string; now: number; leaseExpiresAt: number }>): Promise<RepositoryDocsReview | null>
  isCurrentLease(input: Readonly<{ id: string; leaseId: string; now: number; status: 'preparing' | 'saving' }>): Promise<boolean>
  completePrepare(input: Readonly<{ id: string; leaseId: string; now: number; preparedBundle: Readonly<Record<string, unknown>>; approvalDigest: string }>): Promise<boolean>
  approveSave(input: Readonly<{ id: string; actorAccountId: string; approvalDigest: string; now: number }>): Promise<boolean>
  claimNextSave(input: Readonly<{ leaseId: string; now: number; leaseExpiresAt: number }>): Promise<RepositoryDocsReview | null>
  setProposedCommit(input: Readonly<{ id: string; leaseId: string; now: number; proposedCommitSha: string }>): Promise<boolean>
  completeSave(input: Readonly<{ id: string; leaseId: string; now: number; committedSha: string }>): Promise<boolean>
  markTerminal(input: Readonly<{ id: string; leaseId: string; status: 'stale' | 'failed'; errorId: string; now: number }>): Promise<boolean>
}

export interface RepositoryJobStore {
  enqueue(job: RepositoryJob): Promise<void>
  get(id: string): Promise<RepositoryJob | null>
  getAuthorized(id: string, actorAccountId: string): Promise<RepositoryJob | null>
  latestCompletedScan(scope: RepositoryJobScope): Promise<RepositoryJob | null>
  claimScan(input: RepositoryJobClaimInput): Promise<RepositoryJob | null>
  claimNextScan(input: RepositoryJobQueueClaimInput): Promise<RepositoryJob | null>
  isCurrentLease(input: RepositoryJobLeaseInput & Readonly<{ now: number }>): Promise<boolean>
  completeScan(input: RepositoryJobCompleteInput): Promise<boolean>
  retry(input: RepositoryJobRetryInput): Promise<void>
  fail(input: RepositoryJobFailInput): Promise<void>
}

export type InstallationAccessToken = Readonly<{ token: string; expiresAt: number; contentsPermission: 'read' | 'write' }>
export interface InstallationTokenPort {
  mint(input: Readonly<{ installationId: string; repositoryId: string; contentsPermission: 'read' | 'write' }>): Promise<InstallationAccessToken>
}
