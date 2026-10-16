import { randomUUID } from 'node:crypto'
import type { GitHubActor, InstallationAccessToken, InstallationTokenPort, RepositoryDocsReview, RepositoryDocsReviewStore } from './contracts.js'
import type { GitHubGrantService } from './grants.js'
import { GitHubAppError, opaqueId, validateActor } from './validation.js'

export class RepositoryDocsReviewService {
  constructor(
    private readonly grants: Pick<GitHubGrantService, 'assertLiveRepositoryAccess'>,
    private readonly reviews: RepositoryDocsReviewStore,
    private readonly tokens: InstallationTokenPort,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly createLeaseId: () => string = randomUUID,
  ) {}

  async enqueuePrepare(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
    fileId: string
    fileRevision: number
    fileDocumentSha256: string
    scanJobId: string
    baseRef: string
    baseCommitSha: string
    baseTreeSha: string
    adapter: Readonly<Record<string, unknown>>
  }>): Promise<RepositoryDocsReview> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = repositoryReviewId(input.projectId)
    const grant = await this.grants.assertLiveRepositoryAccess({ actor, tenantId, projectId, operation: 'prepare-patch' })
    const createdAt = this.now()
    return this.reviews.enqueuePrepare({
      id: repositoryReviewId(this.createId()),
      tenantId,
      projectId,
      fileId: repositoryReviewId(input.fileId),
      fileRevision: nonnegativeInteger(input.fileRevision),
      fileDocumentSha256: digest(input.fileDocumentSha256),
      scanJobId: repositoryReviewId(input.scanJobId),
      installationId: grant.installationId,
      repositoryId: grant.repository.id,
      repositoryGrantId: grant.grantId,
      repositoryLinkedAt: grant.linkedAt,
      createdByAccountId: actor.accountId,
      baseRef: branch(input.baseRef),
      baseCommitSha: gitSha(input.baseCommitSha),
      baseTreeSha: gitSha(input.baseTreeSha),
      adapter: input.adapter,
      createdAt,
    })
  }

  async read(id: string, actorInput: GitHubActor): Promise<RepositoryDocsReview> {
    const actor = validateActor(actorInput)
    const review = await this.reviews.getAuthorized(repositoryReviewId(id), actor.accountId)
    if (!review) throw unavailable()
    await this.assertCurrent(review, actor, 'prepare-patch')
    return review
  }

  async readLatest(projectId: string, fileId: string, actorInput: GitHubActor): Promise<RepositoryDocsReview | null> {
    const actor = validateActor(actorInput)
    const review = await this.reviews.getLatestAuthorized(repositoryReviewId(projectId), repositoryReviewId(fileId), actor.accountId)
    if (!review) return null
    await this.assertCurrent(review, actor, 'prepare-patch')
    return review
  }

  async claimNextPrepare(): Promise<RepositoryDocsReview | null> {
    const claimedAt = this.now()
    return this.reviews.claimNextPrepare({ leaseId: this.createLeaseId(), now: claimedAt, leaseExpiresAt: claimedAt + 5 * 60_000 })
  }

  async authorizePrepareLease(id: string, leaseId: string): Promise<RepositoryDocsReview> {
    const reviewId = repositoryReviewId(id)
    const lease = repositoryReviewId(leaseId)
    const now = this.now()
    if (!await this.reviews.isCurrentLease({ id: reviewId, leaseId: lease, now, status: 'preparing' })) throw unavailable()
    const review = await this.reviews.get(reviewId)
    if (!review || review.status !== 'preparing' || review.leaseId !== lease || review.leaseExpiresAt === null || review.leaseExpiresAt <= now) throw unavailable()
    return review
  }

  async completePrepare(id: string, leaseId: string, preparedBundle: Readonly<Record<string, unknown>>, approvalDigest: string): Promise<void> {
    const reviewId = repositoryReviewId(id)
    const lease = repositoryReviewId(leaseId)
    const now = this.now()
    if (!await this.reviews.completePrepare({ id: reviewId, leaseId: lease, now, preparedBundle, approvalDigest: digest(approvalDigest) })) throw unavailable()
  }

  async markPrepareStale(id: string, leaseId: string, errorId: string): Promise<void> {
    if (!/^[a-z0-9-]{3,64}$/.test(errorId) || !await this.reviews.markTerminal({ id: repositoryReviewId(id), leaseId: repositoryReviewId(leaseId), status: 'stale', errorId, now: this.now() })) throw unavailable()
  }

  async approveSave(id: string, actorInput: GitHubActor, approvalDigest: string): Promise<RepositoryDocsReview> {
    const actor = validateActor(actorInput)
    const reviewId = repositoryReviewId(id)
    const review = await this.reviews.getAuthorized(reviewId, actor.accountId)
    if (!review || review.status !== 'prepared' || review.approvalDigest !== digest(approvalDigest)) throw unavailable()
    await this.assertCurrent(review, actor, 'write')
    if (!await this.reviews.approveSave({ id: reviewId, actorAccountId: actor.accountId, approvalDigest, now: this.now() })) throw unavailable()
    const approved = await this.reviews.getAuthorized(reviewId, actor.accountId)
    if (!approved || approved.status !== 'queued_save') throw unavailable()
    return approved
  }

  async claimNextSave(): Promise<Readonly<{ review: RepositoryDocsReview; access: InstallationAccessToken }> | null> {
    const claimedAt = this.now()
    const review = await this.reviews.claimNextSave({ leaseId: this.createLeaseId(), now: claimedAt, leaseExpiresAt: claimedAt + 5 * 60_000 })
    if (!review) return null
    if (review.status !== 'saving' || !review.leaseId || !review.leaseExpiresAt) throw unavailable()
    const access = await this.tokens.mint({ installationId: review.installationId, repositoryId: review.repositoryId, contentsPermission: 'write' })
    return Object.freeze({ review, access })
  }

  async setProposedCommit(id: string, leaseId: string, proposedCommitSha: string): Promise<void> {
    const now = this.now()
    if (!await this.reviews.setProposedCommit({ id: repositoryReviewId(id), leaseId: repositoryReviewId(leaseId), now, proposedCommitSha: gitSha(proposedCommitSha) })) throw unavailable()
  }

  async completeSave(id: string, leaseId: string, committedSha: string): Promise<void> {
    const now = this.now()
    if (!await this.reviews.completeSave({ id: repositoryReviewId(id), leaseId: repositoryReviewId(leaseId), now, committedSha: gitSha(committedSha) })) throw unavailable()
  }

  async markSaveStale(id: string, leaseId: string, errorId: string): Promise<void> {
    if (!/^[a-z0-9-]{3,64}$/.test(errorId) || !await this.reviews.markTerminal({ id: repositoryReviewId(id), leaseId: repositoryReviewId(leaseId), status: 'stale', errorId, now: this.now() })) throw unavailable()
  }

  async markSaveFailed(id: string, leaseId: string, errorId: string): Promise<void> {
    if (!/^[a-z0-9-]{3,64}$/.test(errorId) || !await this.reviews.markTerminal({ id: repositoryReviewId(id), leaseId: repositoryReviewId(leaseId), status: 'failed', errorId, now: this.now() })) throw unavailable()
  }

  private async assertCurrent(review: RepositoryDocsReview, actor: GitHubActor, operation: 'prepare-patch' | 'write'): Promise<void> {
    const grant = await this.grants.assertLiveRepositoryAccess({ actor, tenantId: review.tenantId, projectId: review.projectId, operation })
    if (grant.installationId !== review.installationId || grant.repository.id !== review.repositoryId || grant.grantId !== review.repositoryGrantId || grant.linkedAt !== review.repositoryLinkedAt) throw unavailable()
  }
}

function repositoryReviewId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw unavailable()
  return value
}

function nonnegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw unavailable()
  return value
}

function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw unavailable()
  return value
}

function gitSha(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw unavailable()
  return value
}

function branch(value: string): string {
  if (!/^refs\/heads\/(?!.*(?:^|\/)\.\.?$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/.test(value)) throw unavailable()
  return value
}

function unavailable(): GitHubAppError {
  return new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
}
