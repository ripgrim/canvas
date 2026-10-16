import { randomUUID } from 'node:crypto'
import type { GitHubActor, InstallationAccessToken, InstallationTokenPort, LiveRepositoryOperation, RepositoryJob, RepositoryJobStore, RepositoryScanArtifact } from './contracts.js'
import type { GitHubGrantService } from './grants.js'
import { GitHubAppError, opaqueId, validateActor } from './validation.js'

export class RepositoryJobService {
  constructor(
    private readonly grants: GitHubGrantService,
    private readonly jobs: RepositoryJobStore,
    private readonly tokens: InstallationTokenPort,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly createLeaseId: () => string = randomUUID,
  ) {}

  async enqueue(input: Readonly<{ actor: GitHubActor; tenantId: string; projectId: string; operation: LiveRepositoryOperation }>): Promise<RepositoryJob> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = opaqueId(input.projectId)
    const grant = await this.grants.assertLiveRepositoryAccess({ actor, tenantId, projectId, operation: input.operation })
    const createdAt = this.now()
    const job = Object.freeze({ id: this.createId(), actor, tenantId, projectId, operation: input.operation, installationId: grant.installationId, repositoryId: grant.repository.id, repositoryLinkedAt: grant.linkedAt, repositoryGrantId: grant.grantId, repositoryGrantGeneration: grant.grantGeneration, status: 'queued' as const, createdAt, nextAttemptAt: createdAt, attempt: 0 })
    await this.jobs.enqueue(job)
    return job
  }

  async start(id: string): Promise<Readonly<{ job: RepositoryJob; access: InstallationAccessToken }>> {
    const jobId = repositoryJobId(id)
    const claimedAt = this.now()
    const leaseId = this.createLeaseId()
    const leaseExpiresAt = claimedAt + 5 * 60_000
    const job = await this.jobs.claimScan({ id: jobId, leaseId, now: claimedAt, leaseExpiresAt })
    if (!job || job.status !== 'running' || job.leaseId !== leaseId || job.leaseExpiresAt !== leaseExpiresAt) throw unavailable()
    try {
      const grant = await this.grants.assertLiveRepositoryAccess({ actor: job.actor, tenantId: job.tenantId, projectId: job.projectId, operation: job.operation })
      assertStable(job, grant.installationId, grant.repository.id, grant.linkedAt, grant.grantId, grant.grantGeneration)
      const access = await this.tokens.mint({ installationId: job.installationId, repositoryId: job.repositoryId, contentsPermission: 'read' })
      if (!await this.jobs.isCurrentLease({ id: job.id, leaseId, now: this.now() })) throw unavailable()
      return Object.freeze({ job, access })
    } catch (error) {
      await this.finishAccessFailure(job, leaseId, error)
      throw error
    }
  }

  async claimNext(): Promise<Readonly<{ job: RepositoryJob; access: InstallationAccessToken }> | null> {
    const claimedAt = this.now()
    const leaseId = this.createLeaseId()
    const leaseExpiresAt = claimedAt + 5 * 60_000
    const job = await this.jobs.claimNextScan({ leaseId, now: claimedAt, leaseExpiresAt })
    if (!job || job.status !== 'running') return null
    try {
      const grant = await this.grants.assertLiveRepositoryAccess({ actor: job.actor, tenantId: job.tenantId, projectId: job.projectId, operation: job.operation })
      assertStable(job, grant.installationId, grant.repository.id, grant.linkedAt, grant.grantId, grant.grantGeneration)
      const access = await this.tokens.mint({ installationId: job.installationId, repositoryId: job.repositoryId, contentsPermission: 'read' })
      if (!await this.jobs.isCurrentLease({ id: job.id, leaseId, now: this.now() })) throw unavailable()
      return Object.freeze({ job, access })
    } catch (error) {
      await this.finishAccessFailure(job, leaseId, error)
      throw error
    }
  }

  async retryScan(id: string, leaseId: string, nextAttemptAt: number): Promise<void> {
    if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt <= this.now() || nextAttemptAt > this.now() + 60_000) throw unavailable()
    await this.jobs.retry({ id: repositoryJobId(id), leaseId: repositoryJobId(leaseId), nextAttemptAt })
  }

  async failScan(id: string, leaseId: string, errorId: string): Promise<void> {
    if (!/^[a-z0-9-]{3,64}$/.test(errorId)) throw unavailable()
    await this.jobs.fail({ id: repositoryJobId(id), leaseId: repositoryJobId(leaseId), now: this.now(), errorId })
  }

  async read(id: string, actor: GitHubActor): Promise<RepositoryJob> {
    const validActor = validateActor(actor)
    const job = await this.jobs.getAuthorized(repositoryJobId(id), validActor.accountId)
    if (!job) throw unavailable()
    const grant = await this.grants.assertLiveRepositoryAccess({ actor: validActor, tenantId: job.tenantId, projectId: job.projectId, operation: job.operation })
    assertStable(job, grant.installationId, grant.repository.id, grant.linkedAt, grant.grantId, grant.grantGeneration)
    return job
  }

  async latestScan(input: Readonly<{ actor: GitHubActor; tenantId: string; projectId: string }>): Promise<RepositoryJob | null> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = opaqueId(input.projectId)
    const grant = await this.grants.assertLiveRepositoryAccess({ actor, tenantId, projectId, operation: 'scan' })
    const job = await this.jobs.latestCompletedScan({
      actorAccountId: actor.accountId,
      tenantId,
      projectId,
      installationId: grant.installationId,
      repositoryId: grant.repository.id,
      repositoryLinkedAt: grant.linkedAt,
      repositoryGrantId: grant.grantId,
      repositoryGrantGeneration: grant.grantGeneration,
    })
    if (job && job.status !== 'completed') throw unavailable()
    if (job) assertStable(job, grant.installationId, grant.repository.id, grant.linkedAt, grant.grantId, grant.grantGeneration)
    return job
  }

  async authorizeCompletedScan(id: string): Promise<Readonly<{ job: RepositoryJob & Readonly<{ status: 'completed' }>; access: InstallationAccessToken }>> {
    const job = await this.currentCompletedScan(id)
    const access = await this.tokens.mint({ installationId: job.installationId, repositoryId: job.repositoryId, contentsPermission: 'read' })
    return Object.freeze({ job, access })
  }

  async currentCompletedScan(id: string): Promise<RepositoryJob & Readonly<{ status: 'completed' }>> {
    const job = await this.jobs.get(repositoryJobId(id))
    if (!job || job.operation !== 'scan' || job.status !== 'completed') throw unavailable()
    const grant = await this.grants.assertLiveRepositoryAccess({ actor: job.actor, tenantId: job.tenantId, projectId: job.projectId, operation: 'scan' })
    assertStable(job, grant.installationId, grant.repository.id, grant.linkedAt, grant.grantId, grant.grantGeneration)
    return job
  }

  async readAuthorizedCompletedScan(input: Readonly<{
    id: string
    actor: GitHubActor
    tenantId: string
    projectId: string
  }>): Promise<RepositoryJob & Readonly<{ status: 'completed' }>> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = opaqueId(input.projectId)
    const job = await this.jobs.getAuthorized(repositoryJobId(input.id), actor.accountId)
    if (!job || job.operation !== 'scan' || job.status !== 'completed'
      || job.tenantId !== tenantId || job.projectId !== projectId) throw unavailable()
    const grant = await this.grants.assertLiveRepositoryAccess({ actor, tenantId, projectId, operation: 'scan' })
    assertStable(job, grant.installationId, grant.repository.id, grant.linkedAt, grant.grantId, grant.grantGeneration)
    return job
  }

  async completeScan(id: string, leaseId: string, result: RepositoryScanArtifact): Promise<RepositoryJob> {
    const jobId = repositoryJobId(id)
    const lease = repositoryJobId(leaseId)
    const job = await this.jobs.get(jobId)
    if (!job || job.status !== 'running' || job.leaseId !== lease || job.leaseExpiresAt <= this.now()) throw unavailable()
    const grant = await this.grants.assertLiveRepositoryAccess({ actor: job.actor, tenantId: job.tenantId, projectId: job.projectId, operation: 'scan' })
    assertStable(job, grant.installationId, grant.repository.id, grant.linkedAt, grant.grantId, grant.grantGeneration)
    if (!await this.jobs.completeScan({ id: jobId, leaseId: lease, now: this.now(), result })) throw unavailable()
    const completed = await this.jobs.get(jobId)
    if (!completed || completed.status !== 'completed') throw unavailable()
    return completed
  }

  private async finishAccessFailure(job: RepositoryJob & Readonly<{ status: 'running' }>, leaseId: string, error: unknown): Promise<void> {
    const failedAt = this.now()
    if (error instanceof GitHubAppError) await this.jobs.fail({ id: job.id, leaseId, now: failedAt, errorId: 'repository-access-changed' })
    else if (job.attempt < 3 && transientProviderFailure(error)) await this.jobs.retry({ id: job.id, leaseId, nextAttemptAt: failedAt + Math.min(30_000, 1_000 * 2 ** job.attempt) })
    else await this.jobs.fail({ id: job.id, leaseId, now: failedAt, errorId: 'repository-provider-failed' })
  }

}

function transientProviderFailure(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true
  return error instanceof Error && /status (?:429|5\d\d)\b/.test(error.message)
}

function repositoryJobId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw unavailable()
  return value
}

function unavailable(): GitHubAppError {
  return new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
}

function assertStable(job: RepositoryJob, installationId: string, repositoryId: string, linkedAt?: number, grantId?: string, grantGeneration?: number): void {
  if (job.installationId !== installationId || job.repositoryId !== repositoryId
    || linkedAt !== undefined && job.repositoryLinkedAt !== linkedAt
    || grantId !== undefined && job.repositoryGrantId !== grantId
    || grantGeneration !== undefined && job.repositoryGrantGeneration !== grantGeneration) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
}
