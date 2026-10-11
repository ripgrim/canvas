import { randomUUID } from 'node:crypto'
import type { GitHubActor, InstallationAccessToken, InstallationTokenPort, LiveRepositoryOperation, RepositoryJob, RepositoryJobStore } from './contracts.js'
import type { GitHubGrantService } from './grants.js'
import { GitHubAppError, opaqueId, validateActor } from './validation.js'

export class RepositoryJobService {
  constructor(
    private readonly grants: GitHubGrantService,
    private readonly jobs: RepositoryJobStore,
    private readonly tokens: InstallationTokenPort,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  async enqueue(input: Readonly<{ actor: GitHubActor; tenantId: string; projectId: string; operation: LiveRepositoryOperation }>): Promise<RepositoryJob> {
    const actor = validateActor(input.actor)
    const tenantId = opaqueId(input.tenantId)
    const projectId = opaqueId(input.projectId)
    const grant = await this.grants.assertLiveRepositoryAccess({ actor, tenantId, projectId, operation: input.operation })
    const job = Object.freeze({ id: this.createId(), actor, tenantId, projectId, operation: input.operation, installationId: grant.installationId, repositoryId: grant.repository.id, status: 'queued' as const, createdAt: this.now() })
    await this.jobs.enqueue(job)
    return job
  }

  async start(id: string): Promise<Readonly<{ job: RepositoryJob; access: InstallationAccessToken }>> {
    const job = await this.load(id)
    const grant = await this.grants.assertLiveRepositoryAccess({ actor: job.actor, tenantId: job.tenantId, projectId: job.projectId, operation: job.operation })
    assertStable(job, grant.installationId, grant.repository.id)
    const access = await this.tokens.mint({ installationId: job.installationId, repositoryId: job.repositoryId, contentsPermission: 'read' })
    await this.jobs.markRunning(job.id)
    return Object.freeze({ job: Object.freeze({ ...job, status: 'running' }), access })
  }

  async authorizeWrite(id: string): Promise<Readonly<{ job: RepositoryJob; access: InstallationAccessToken }>> {
    const job = await this.load(id)
    if (job.operation !== 'write' || job.status !== 'running') throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    const grant = await this.grants.assertLiveRepositoryAccess({ actor: job.actor, tenantId: job.tenantId, projectId: job.projectId, operation: 'write' })
    assertStable(job, grant.installationId, grant.repository.id)
    const access = await this.tokens.mint({ installationId: job.installationId, repositoryId: job.repositoryId, contentsPermission: 'write' })
    return Object.freeze({ job, access })
  }

  private async load(id: string): Promise<RepositoryJob> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    const job = await this.jobs.get(id)
    if (!job) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
    return job
  }
}

function assertStable(job: RepositoryJob, installationId: string, repositoryId: string): void {
  if (job.installationId !== installationId || job.repositoryId !== repositoryId) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
}
