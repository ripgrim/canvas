import { describe, expect, it } from 'vitest'
import type { GitHubActor, RepositoryDocsReview, RepositoryDocsReviewStore } from '../src/contracts.js'
import { RepositoryDocsReviewService } from '../src/docs.js'
import { GitHubAppError } from '../src/validation.js'

const now = 1_800_000_000_000
const owner: GitHubActor = { accountId: 'owner-1', providerUserId: '1001' }
const reviewer: GitHubActor = { accountId: 'reviewer-1', providerUserId: '1002' }
const reviewId = '00000000-0000-4000-8000-000000000001'
const leaseId = '00000000-0000-4000-8000-000000000002'

function fixture() {
  let record: RepositoryDocsReview | null = null
  const store: RepositoryDocsReviewStore = {
    async enqueuePrepare(input) {
      record = Object.freeze({ ...input, approvedByAccountId: null, preparedBundle: null, approvalDigest: null, status: 'queued_prepare', attempt: 0, leaseId: null, leaseExpiresAt: null, nextAttemptAt: input.createdAt, errorId: null, preparedAt: null, approvedAt: null, proposedCommitSha: null, committedSha: null, completedAt: null, failedAt: null })
      return record
    },
    async get() { return record },
    async getAuthorized(_id, actorAccountId) { return actorAccountId === owner.accountId || actorAccountId === reviewer.accountId ? record : null },
    async getLatestAuthorized(_projectId, _fileId, actorAccountId) { return actorAccountId === owner.accountId || actorAccountId === reviewer.accountId ? record : null },
    async claimNextPrepare(input) {
      if (!record || record.status !== 'queued_prepare') return null
      record = Object.freeze({ ...record, status: 'preparing', attempt: 1, leaseId: input.leaseId, leaseExpiresAt: input.leaseExpiresAt, nextAttemptAt: null })
      return record
    },
    async isCurrentLease() { return true },
    async completePrepare(input) {
      if (!record || record.status !== 'preparing' || record.leaseId !== input.leaseId) return false
      record = Object.freeze({ ...record, status: 'prepared', leaseId: null, leaseExpiresAt: null, preparedBundle: input.preparedBundle, approvalDigest: input.approvalDigest, preparedAt: input.now })
      return true
    },
    async approveSave(input) {
      if (!record || record.status !== 'prepared' || record.approvalDigest !== input.approvalDigest) return false
      record = Object.freeze({ ...record, status: 'queued_save', approvedByAccountId: input.actorAccountId, approvedAt: input.now, nextAttemptAt: input.now })
      return true
    },
    async claimNextSave(input) {
      if (!record || record.status !== 'queued_save') return null
      record = Object.freeze({ ...record, status: 'saving', attempt: record.attempt + 1, leaseId: input.leaseId, leaseExpiresAt: input.leaseExpiresAt, nextAttemptAt: null })
      return record
    },
    async setProposedCommit(input) {
      if (!record || record.status !== 'saving' || record.leaseId !== input.leaseId) return false
      record = Object.freeze({ ...record, proposedCommitSha: input.proposedCommitSha })
      return true
    },
    async completeSave(input) {
      if (!record || record.status !== 'saving' || record.leaseId !== input.leaseId || record.proposedCommitSha !== input.committedSha) return false
      record = Object.freeze({ ...record, status: 'saved', leaseId: null, leaseExpiresAt: null, committedSha: input.committedSha, completedAt: input.now })
      return true
    },
    async markTerminal() { return true },
  }
  let grantId = '00000000-0000-4000-8000-000000000077'
  const grants = {
    async assertLiveRepositoryAccess(input: { actor: GitHubActor; operation: string }) {
      if (input.operation === 'write' && input.actor.accountId !== owner.accountId) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
      return { grantId, installationId: '2001', repository: { id: '4001' }, linkedAt: now }
    },
  }
  const tokens = { async mint() { return { token: 'ghs_write_token', expiresAt: now + 60_000, contentsPermission: 'write' as const } } }
  const service = new RepositoryDocsReviewService(grants as never, store, tokens, () => now, () => reviewId, () => leaseId)
  return { service, record: () => record, changeGrant: () => { grantId = '00000000-0000-4000-8000-000000000078' } }
}

const prepareInput = (actor: GitHubActor) => ({
  actor,
  tenantId: 'tenant-1',
  projectId: '00000000-0000-4000-8000-000000000010',
  fileId: '00000000-0000-4000-8000-000000000011',
  fileRevision: 12,
  fileDocumentSha256: 'a'.repeat(64),
  scanJobId: '00000000-0000-4000-8000-000000000012',
  baseRef: 'refs/heads/main',
  baseCommitSha: 'b'.repeat(40),
  baseTreeSha: 'c'.repeat(40),
  adapter: { version: 1 },
})

describe('repository documentation review service', () => {
  it('COMP-V2-DOCS-004 separates prepare from explicit owner save approval', async () => {
    const { service, record } = fixture()
    await expect(service.enqueuePrepare(prepareInput(reviewer))).resolves.toMatchObject({ status: 'queued_prepare', repositoryGrantId: expect.any(String) })
    await expect(service.readLatest(prepareInput(owner).projectId, prepareInput(owner).fileId, owner)).resolves.toMatchObject({ id: reviewId, status: 'queued_prepare' })
    await expect(service.claimNextPrepare()).resolves.toMatchObject({ status: 'preparing', leaseId })
    await service.completePrepare(reviewId, leaseId, { version: 1, files: [] }, 'd'.repeat(64))
    expect(record()).toMatchObject({ status: 'prepared', approvedByAccountId: null })
    await expect(service.approveSave(reviewId, reviewer, 'd'.repeat(64))).rejects.toMatchObject({ code: 'REPOSITORY_NOT_VISIBLE' })
    await expect(service.approveSave(reviewId, owner, 'd'.repeat(64))).resolves.toMatchObject({ status: 'queued_save', approvedByAccountId: owner.accountId })
    await expect(service.claimNextSave()).resolves.toMatchObject({ review: { status: 'saving', leaseId }, access: { contentsPermission: 'write' } })
    await service.setProposedCommit(reviewId, leaseId, 'e'.repeat(40))
    await service.completeSave(reviewId, leaseId, 'e'.repeat(40))
    expect(record()).toMatchObject({ status: 'saved', proposedCommitSha: 'e'.repeat(40), committedSha: 'e'.repeat(40) })
  })

  it('COMP-V2-DOCS-NEG-002 invalidates approval after repository relinking', async () => {
    const { service, changeGrant } = fixture()
    await service.enqueuePrepare(prepareInput(owner))
    await service.claimNextPrepare()
    await service.completePrepare(reviewId, leaseId, { version: 1, files: [] }, 'd'.repeat(64))
    changeGrant()

    await expect(service.approveSave(reviewId, owner, 'd'.repeat(64))).rejects.toMatchObject({ code: 'REPOSITORY_NOT_VISIBLE' })
  })
})
