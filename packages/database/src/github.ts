import { randomUUID } from 'node:crypto'
import type {
  GitHubGrantStore,
  InstallationGrant,
  InstallationStateRecord,
  InstallationStateStore,
  ProjectAuthorizationDecision,
  ProjectAuthorizationPort,
  ProjectRepositoryOperation,
  RepositoryJob,
  RepositoryJobStore,
  RepositoryScanArtifact,
  RepositoryGrant,
  WebhookDeliveryStore,
} from '@canvas/github-app'
import type { Pool, QueryResultRow } from 'pg'

export type ProjectMembershipRole = 'owner' | 'editor' | 'reviewer' | 'viewer'

export type GitHubPersistence = Readonly<{
  states: InstallationStateStore
  grants: GitHubGrantStore
  deliveries: WebhookDeliveryStore
  projectAuthorization: ProjectAuthorizationPort
  jobs: RepositoryJobStore
  projectTenancy: Readonly<{ resolveTenantForMember(projectId: string, userId: string): Promise<string | null> }>
}>

type InstallationRow = QueryResultRow & Readonly<{
  tenant_id: string
  installation_id: string
  account_id: string
  account_login: string
  account_type: 'Organization' | 'User'
  connected_by_account_id: string
  connected_at: Date | string
  contents_permission: 'none' | 'read' | 'write'
}>

type RepositoryRow = QueryResultRow & Readonly<{
  grant_id: string
  tenant_id: string
  project_id: string
  installation_id: string
  repository_id: string
  owner_id: string
  owner_login: string
  repository_name: string
  full_name: string
  is_private: boolean
  linked_by_account_id: string
  linked_at: Date | string
  contents_permission: 'none' | 'read' | 'write'
}>

type StateRow = QueryResultRow & Readonly<{
  digest: string
  account_id: string
  tenant_id: string
  purpose: 'authorize-user' | 'install-app'
  installation_id: string | null
  code_verifier_ciphertext: string | null
  return_to_url: string | null
  expires_at_ms: string | number
}>

type JobRow = QueryResultRow & Readonly<{
  id: string; actor_account_id: string; actor_provider_user_id: string; tenant_id: string; project_id: string
  operation: 'scan' | 'pull' | 'prepare-patch' | 'write'; installation_id: string; repository_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'; created_at: Date | string; attempt: number
  repository_linked_at: Date | string; next_attempt_at_ms: string | number | null
  repository_grant_id: string
  lease_id: string | null; lease_expires_at_ms: string | number | null
  source_revision: string | null; scan_result: unknown; registry_request: unknown; completed_at_ms: string | number | null
  error_id: string | null; failed_at_ms: string | number | null
}>

export function roleAllowsProjectOperation(role: ProjectMembershipRole, operation: ProjectRepositoryOperation): boolean {
  if (role === 'owner' || role === 'editor') return true
  if (role === 'reviewer') return operation === 'scan' || operation === 'pull' || operation === 'prepare-patch'
  return operation === 'scan' || operation === 'pull'
}

export function createPostgresGitHubPersistence(pool: Pool): GitHubPersistence {
  const states: InstallationStateStore = {
    async put(record) {
      await pool.query(
        'INSERT INTO app_github_installation_state (digest, account_id, tenant_id, purpose, installation_id, code_verifier_ciphertext, return_to_url, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))',
        [record.digest, record.accountId, record.tenantId, record.purpose, record.installationId, record.codeVerifierCiphertext, record.returnToUrl, record.expiresAt],
      )
    },
    async consume(input) {
      const result = await pool.query<StateRow>(
        `DELETE FROM app_github_installation_state
         WHERE digest = $1 AND account_id = $2 AND purpose = $3 AND expires_at > to_timestamp($4 / 1000.0)
         RETURNING digest, account_id, tenant_id, purpose, installation_id, code_verifier_ciphertext, return_to_url, floor(extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms`,
        [input.digest, input.accountId, input.purpose, input.now],
      )
      const row = result.rows[0]
      return row ? stateFromRow(row) : null
    },
  }

  const grants: GitHubGrantStore = {
    async saveInstallationGrant(grant) {
      await pool.query(
        `INSERT INTO app_github_installation_grant
          (tenant_id, installation_id, account_id, account_login, account_type, contents_permission, connected_by_account_id, connected_at, invalidated_at, invalidation_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), NULL, NULL)
         ON CONFLICT (tenant_id, installation_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          account_login = EXCLUDED.account_login,
          account_type = EXCLUDED.account_type,
          contents_permission = EXCLUDED.contents_permission,
          connected_by_account_id = EXCLUDED.connected_by_account_id,
          connected_at = EXCLUDED.connected_at,
          invalidated_at = NULL,
          invalidation_reason = NULL`,
        [grant.tenantId, grant.installation.id, grant.installation.account.id, grant.installation.account.login, grant.installation.account.type, grant.installation.contentsPermission, grant.connectedByAccountId, grant.connectedAt],
      )
    },
    async getActiveInstallationGrant(input) {
      const result = await pool.query<InstallationRow>(
        `SELECT tenant_id, installation_id, account_id, account_login, account_type, contents_permission, connected_by_account_id, connected_at
         FROM app_github_installation_grant
         WHERE tenant_id = $1 AND installation_id = $2 AND invalidated_at IS NULL`,
        [input.tenantId, input.installationId],
      )
      return result.rows[0] ? installationFromRow(result.rows[0]) : null
    },
    async saveRepositoryGrant(grant) {
      const result = await pool.query(
        `INSERT INTO app_github_repository_grant
          (project_id, tenant_id, installation_id, repository_id, owner_id, owner_login, repository_name, full_name, is_private, contents_permission, linked_by_account_id, linked_at, grant_id, invalidated_at, invalidation_reason)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0), $13::uuid, NULL, NULL
         FROM app_project AS project
         JOIN app_project_member AS member ON member.project_id = project.id
         JOIN app_github_installation_grant AS installation ON installation.tenant_id = $2 AND installation.installation_id = $3 AND installation.invalidated_at IS NULL
         WHERE project.id = $1
           AND project.owner_user_id = $2
           AND member.user_id = $11
           AND member.role IN ('owner', 'editor')
         ON CONFLICT (project_id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          installation_id = EXCLUDED.installation_id,
          repository_id = EXCLUDED.repository_id,
          owner_id = EXCLUDED.owner_id,
          owner_login = EXCLUDED.owner_login,
          repository_name = EXCLUDED.repository_name,
          full_name = EXCLUDED.full_name,
          is_private = EXCLUDED.is_private,
          contents_permission = EXCLUDED.contents_permission,
          linked_by_account_id = EXCLUDED.linked_by_account_id,
          linked_at = EXCLUDED.linked_at,
          grant_id = EXCLUDED.grant_id,
          invalidated_at = NULL,
          invalidation_reason = NULL`,
        [grant.projectId, grant.tenantId, grant.installationId, grant.repository.id, grant.repository.ownerId, grant.repository.ownerLogin, grant.repository.name, grant.repository.fullName, grant.repository.isPrivate, grant.repository.contentsPermission, grant.linkedByAccountId, grant.linkedAt, grant.grantId],
      )
      if (result.rowCount !== 1) throw new Error('Project repository grant is not authorized.')
    },
    async getRepositoryGrant(input) {
      const result = await pool.query<RepositoryRow>(
        `SELECT grant_id, tenant_id, project_id, installation_id, repository_id, owner_id, owner_login, repository_name, full_name, is_private, contents_permission, linked_by_account_id, linked_at
         FROM app_github_repository_grant
         WHERE tenant_id = $1 AND project_id = $2 AND invalidated_at IS NULL`,
        [input.tenantId, input.projectId],
      )
      return result.rows[0] ? repositoryFromRow(result.rows[0]) : null
    },
    async getAuthorizedRepositoryAccess(input) {
      const roles = allowedRoles(input.operation)
      const result = await pool.query<RepositoryRow & InstallationRow>(
        `SELECT repository.grant_id, repository.tenant_id, repository.project_id, repository.installation_id, repository.repository_id,
                repository.owner_id, repository.owner_login, repository.repository_name, repository.full_name,
                repository.is_private, repository.contents_permission, repository.linked_by_account_id, repository.linked_at,
                installation.account_id, installation.account_login, installation.account_type,
                installation.contents_permission AS installation_contents_permission,
                installation.connected_by_account_id, installation.connected_at
         FROM app_github_repository_grant AS repository
         JOIN app_github_installation_grant AS installation
           ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
         JOIN app_project_member AS member ON member.project_id = repository.project_id
         WHERE repository.tenant_id = $1 AND repository.project_id = $2 AND member.user_id = $3
           AND member.role = ANY($4::text[]) AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL`,
        [input.tenantId, input.projectId, input.actorAccountId, roles],
      )
      const row = result.rows[0] as (RepositoryRow & InstallationRow & { installation_contents_permission: 'none' | 'read' | 'write' }) | undefined
      if (!row) return null
      return Object.freeze({ grant: repositoryFromRow(row), installation: installationFromRow({ ...row, contents_permission: row.installation_contents_permission }) })
    },
    async invalidateInstallation(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE app_github_installation_grant
           SET invalidated_at = to_timestamp($2 / 1000.0), invalidation_reason = $3
           WHERE installation_id = $1 AND invalidated_at IS NULL`,
          [input.installationId, input.invalidatedAt, input.reason],
        )
        await client.query(
          `UPDATE app_github_repository_grant
           SET invalidated_at = to_timestamp($2 / 1000.0), invalidation_reason = $3
           WHERE installation_id = $1 AND invalidated_at IS NULL`,
          [input.installationId, input.invalidatedAt, `installation_${input.reason}`],
        )
        await client.query('COMMIT')
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },
    async invalidateRepositories(input) {
      await pool.query(
        `UPDATE app_github_repository_grant
         SET invalidated_at = to_timestamp($3 / 1000.0), invalidation_reason = $4
         WHERE installation_id = $1 AND repository_id = ANY($2::text[]) AND invalidated_at IS NULL`,
        [input.installationId, input.repositoryIds, input.invalidatedAt, input.reason],
      )
    },
  }

  const deliveries: WebhookDeliveryStore = {
    async claimDelivery(input) {
      const result = await pool.query<QueryResultRow & { lease_id: string }>(
        `WITH reclaimed AS (
           UPDATE app_github_webhook_delivery SET lease_id = gen_random_uuid(), lease_expires_at = to_timestamp($5 / 1000.0), received_at = to_timestamp($4 / 1000.0)
           WHERE delivery_id = $1 AND status = 'claimed' AND lease_expires_at <= to_timestamp($4 / 1000.0)
             AND event_name = $2 AND body_digest = $3
           RETURNING lease_id
         ), inserted AS (
           INSERT INTO app_github_webhook_delivery (delivery_id, event_name, body_digest, status, lease_id, lease_expires_at, received_at)
           SELECT $1, $2, $3, 'claimed', gen_random_uuid(), to_timestamp($5 / 1000.0), to_timestamp($4 / 1000.0)
           WHERE NOT EXISTS (SELECT 1 FROM app_github_webhook_delivery WHERE delivery_id = $1)
           ON CONFLICT DO NOTHING
           RETURNING lease_id
         )
         SELECT lease_id FROM reclaimed UNION ALL SELECT lease_id FROM inserted LIMIT 1`,
        [input.deliveryId, input.eventName, input.bodyDigest, input.receivedAt, input.leaseExpiresAt],
      )
      return result.rows[0] ? Object.freeze({ leaseId: result.rows[0].lease_id }) : null
    },
    async completeDelivery(input) {
      const result = await pool.query(
        `UPDATE app_github_webhook_delivery
         SET status = 'completed', completed_at = to_timestamp($3 / 1000.0)
         WHERE delivery_id = $1 AND lease_id = $2 AND status = 'claimed'`,
        [input.deliveryId, input.leaseId, input.completedAt],
      )
      if (result.rowCount !== 1) throw new Error('GitHub webhook delivery was not claimed.')
    },
    async releaseDelivery(input) {
      await pool.query("UPDATE app_github_webhook_delivery SET lease_expires_at = now() WHERE delivery_id = $1 AND lease_id = $2 AND status = 'claimed'", [input.deliveryId, input.leaseId])
    },
  }

  const jobs: RepositoryJobStore = {
    async enqueue(job) {
      if (job.status !== 'queued') throw new Error('Repository job must be queued.')
      await pool.query(
        `INSERT INTO app_github_repository_job
          (id, actor_account_id, actor_provider_user_id, tenant_id, project_id, operation, installation_id, repository_id, repository_linked_at, repository_grant_id, status, created_at, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0), $10::uuid, 'queued', to_timestamp($11 / 1000.0), to_timestamp($12 / 1000.0))`,
        [job.id, job.actor.accountId, job.actor.providerUserId, job.tenantId, job.projectId, job.operation, job.installationId, job.repositoryId, job.repositoryLinkedAt, job.repositoryGrantId, job.createdAt, job.nextAttemptAt],
      )
    },
    async get(id) {
      const result = await pool.query<JobRow>(`${jobColumns} FROM app_github_repository_job WHERE id = $1`, [id])
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async getAuthorized(id, actorAccountId) {
      const result = await pool.query<JobRow>(
        `${authorizedJobColumns}
         FROM app_github_repository_job AS job
         JOIN app_github_repository_grant AS repository
           ON repository.tenant_id = job.tenant_id AND repository.project_id = job.project_id
          AND repository.installation_id = job.installation_id AND repository.repository_id = job.repository_id
          AND repository.linked_at = job.repository_linked_at AND repository.grant_id = job.repository_grant_id
         JOIN app_github_installation_grant AS installation
           ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
         JOIN app_project_member AS member
           ON member.project_id = repository.project_id AND member.user_id = $2
         WHERE job.id = $1
           AND (member.role IN ('owner', 'editor')
             OR member.role = 'reviewer' AND job.operation IN ('scan', 'pull', 'prepare-patch')
             OR member.role = 'viewer' AND job.operation IN ('scan', 'pull'))
           AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL`,
        [id, actorAccountId],
      )
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async latestCompletedScan(scope) {
      const result = await pool.query<JobRow>(
        `${authorizedJobColumns}
         FROM app_github_repository_job AS job
         JOIN app_github_repository_grant AS repository
           ON repository.tenant_id = job.tenant_id AND repository.project_id = job.project_id
          AND repository.installation_id = job.installation_id AND repository.repository_id = job.repository_id
          AND repository.linked_at = job.repository_linked_at AND repository.grant_id = job.repository_grant_id
         JOIN app_github_installation_grant AS installation
           ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
         JOIN app_project_member AS member
           ON member.project_id = repository.project_id AND member.user_id = $7
         WHERE job.tenant_id = $1 AND job.project_id = $2 AND job.installation_id = $3 AND job.repository_id = $4
           AND job.repository_linked_at = to_timestamp($5 / 1000.0) AND job.repository_grant_id = $6::uuid
           AND job.operation = 'scan' AND job.status = 'completed'
           AND member.role = ANY($8::text[])
           AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
         ORDER BY job.completed_at DESC, job.created_at DESC, job.id DESC LIMIT 1`,
        [scope.tenantId, scope.projectId, scope.installationId, scope.repositoryId, scope.repositoryLinkedAt, scope.repositoryGrantId, scope.actorAccountId, allowedRoles('scan')],
      )
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async claimScan(input) {
      const result = await pool.query<JobRow>(
        `UPDATE app_github_repository_job
         SET status = 'running', lease_id = $2, lease_expires_at = to_timestamp($4 / 1000.0), next_attempt_at = NULL, attempt = attempt + 1
         WHERE id = $1 AND operation = 'scan' AND ((status = 'queued' AND next_attempt_at <= to_timestamp($3 / 1000.0)) OR (status = 'running' AND lease_expires_at <= to_timestamp($3 / 1000.0)))
         RETURNING id, actor_account_id, actor_provider_user_id, tenant_id, project_id, operation, installation_id, repository_id, repository_linked_at, repository_grant_id, status, created_at, attempt, lease_id, floor(extract(epoch FROM lease_expires_at) * 1000)::bigint AS lease_expires_at_ms, NULL::bigint AS next_attempt_at_ms, source_revision, scan_result, registry_request, NULL::bigint AS completed_at_ms, error_id, NULL::bigint AS failed_at_ms`,
        [input.id, input.leaseId, input.now, input.leaseExpiresAt],
      )
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async claimNextScan(input) {
      const result = await pool.query<JobRow>(
        `WITH candidate AS (
           SELECT id FROM app_github_repository_job
           WHERE operation = 'scan' AND ((status = 'queued' AND next_attempt_at <= to_timestamp($2 / 1000.0)) OR (status = 'running' AND lease_expires_at <= to_timestamp($2 / 1000.0)))
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE app_github_repository_job AS job
         SET status = 'running', lease_id = $1, lease_expires_at = to_timestamp($3 / 1000.0), next_attempt_at = NULL, attempt = attempt + 1
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.id, job.actor_account_id, job.actor_provider_user_id, job.tenant_id, job.project_id, job.operation, job.installation_id, job.repository_id, job.repository_linked_at, job.repository_grant_id, job.status, job.created_at, job.attempt, job.lease_id, floor(extract(epoch FROM job.lease_expires_at) * 1000)::bigint AS lease_expires_at_ms, NULL::bigint AS next_attempt_at_ms, job.source_revision, job.scan_result, job.registry_request, NULL::bigint AS completed_at_ms, job.error_id, NULL::bigint AS failed_at_ms`,
        [input.leaseId, input.now, input.leaseExpiresAt],
      )
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async isCurrentLease(input) {
      const result = await pool.query(
        `SELECT 1 FROM app_github_repository_job
         WHERE id = $1 AND operation = 'scan' AND status = 'running' AND lease_id = $2 AND lease_expires_at > to_timestamp($3 / 1000.0)`,
        [input.id, input.leaseId, input.now],
      )
      return result.rowCount === 1
    },
    async completeScan(input) {
      const result = await pool.query(
        `UPDATE app_github_repository_job AS job
         SET status = 'completed', lease_id = NULL, lease_expires_at = NULL,
             source_revision = $4, scan_result = $5::jsonb, registry_request = $6::jsonb,
             completed_at = to_timestamp($3 / 1000.0)
         WHERE job.id = $1 AND job.operation = 'scan' AND job.status = 'running'
           AND job.lease_id = $2 AND job.lease_expires_at > to_timestamp($3 / 1000.0)
           AND EXISTS (
             SELECT 1 FROM app_github_repository_grant AS repository
             JOIN app_github_installation_grant AS installation
               ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
             JOIN app_project_member AS member ON member.project_id = repository.project_id
             WHERE repository.tenant_id = job.tenant_id AND repository.project_id = job.project_id
               AND repository.installation_id = job.installation_id AND repository.repository_id = job.repository_id
               AND repository.linked_at = job.repository_linked_at
               AND repository.grant_id = job.repository_grant_id
               AND member.user_id = job.actor_account_id AND member.role = ANY($7::text[])
               AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
           )`,
        [input.id, input.leaseId, input.now, input.result.sourceRevision, JSON.stringify(input.result.scan), JSON.stringify(input.result.request), allowedRoles('scan')],
      )
      return result.rowCount === 1
    },
    async retry(input) {
      await pool.query(
        `UPDATE app_github_repository_job SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, next_attempt_at = to_timestamp($3 / 1000.0)
         WHERE id = $1 AND status = 'running' AND lease_id = $2`,
        [input.id, input.leaseId, input.nextAttemptAt],
      )
    },
    async fail(input) {
      await pool.query(
        `UPDATE app_github_repository_job SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, error_id = $3, failed_at = to_timestamp($4 / 1000.0)
         WHERE id = $1 AND status = 'running' AND lease_id = $2`,
        [input.id, input.leaseId, input.errorId, input.now],
      )
    },
  }

  const projectAuthorization: ProjectAuthorizationPort = {
    async authorizeProjectOperation(input) {
      const result = await pool.query<QueryResultRow & { role: ProjectMembershipRole }>(
        `SELECT member.role
         FROM app_project AS project
         JOIN app_project_member AS member ON member.project_id = project.id
         WHERE project.id = $1 AND project.owner_user_id = $2 AND member.user_id = $3`,
        [input.projectId, input.tenantId, input.actorAccountId],
      )
      return authorizationDecision(result.rows[0]?.role, input.operation)
    },
  }

  const projectTenancy = Object.freeze({
    async resolveTenantForMember(projectId: string, userId: string): Promise<string | null> {
      const result = await pool.query<QueryResultRow & { tenant_id: string }>(
        `SELECT project.owner_user_id AS tenant_id
         FROM app_project AS project
         JOIN app_project_member AS member ON member.project_id = project.id
         WHERE project.id = $1 AND member.user_id = $2`,
        [projectId, userId],
      )
      return result.rows[0]?.tenant_id ?? null
    },
  })

  return Object.freeze({ states: Object.freeze(states), grants: Object.freeze(grants), deliveries: Object.freeze(deliveries), jobs: Object.freeze(jobs), projectAuthorization: Object.freeze(projectAuthorization), projectTenancy })
}

export function createMemoryGitHubPersistence(): GitHubPersistence & Readonly<{
  setProjectMembership(projectId: string, tenantId: string, userId: string, role: ProjectMembershipRole): void
}> {
  const stateRecords = new Map<string, InstallationStateRecord>()
  const installationGrants = new Map<string, InstallationGrant>()
  const repositoryGrants = new Map<string, RepositoryGrant>()
  const deliveries = new Map<string, Readonly<{ status: 'claimed' | 'completed'; eventName: string; bodyDigest: string; leaseId: string; leaseExpiresAt: number }>>()
  const jobs = new Map<string, RepositoryJob>()
  const memberships = new Map<string, Readonly<{ tenantId: string; role: ProjectMembershipRole }>>()

  const states: InstallationStateStore = {
    async put(record) {
      if (stateRecords.has(record.digest)) throw new Error('GitHub installation state already exists.')
      stateRecords.set(record.digest, Object.freeze({ ...record }))
    },
    async consume(input) {
      const record = stateRecords.get(input.digest)
      if (!record || record.accountId !== input.accountId || record.purpose !== input.purpose || record.expiresAt <= input.now) return null
      stateRecords.delete(input.digest)
      return record
    },
  }
  const grants: GitHubGrantStore = {
    async saveInstallationGrant(grant) { installationGrants.set(grantKey(grant.tenantId, grant.installation.id), frozenInstallation(grant)) },
    async getActiveInstallationGrant(input) { return installationGrants.get(grantKey(input.tenantId, input.installationId)) ?? null },
    async saveRepositoryGrant(grant) {
      const membership = memberships.get(grantKey(grant.projectId, grant.linkedByAccountId))
      const installation = installationGrants.get(grantKey(grant.tenantId, grant.installationId))
      if (!installation || membership?.tenantId !== grant.tenantId || (membership.role !== 'owner' && membership.role !== 'editor')) throw new Error('Project repository grant is not authorized.')
      repositoryGrants.set(grantKey(grant.tenantId, grant.projectId), frozenRepository(grant))
    },
    async getRepositoryGrant(input) { return repositoryGrants.get(grantKey(input.tenantId, input.projectId)) ?? null },
    async getAuthorizedRepositoryAccess(input) {
      const membership = memberships.get(grantKey(input.projectId, input.actorAccountId))
      if (membership?.tenantId !== input.tenantId || !roleAllowsProjectOperation(membership.role, input.operation)) return null
      const grant = repositoryGrants.get(grantKey(input.tenantId, input.projectId))
      if (!grant) return null
      const installation = installationGrants.get(grantKey(input.tenantId, grant.installationId))
      return installation ? Object.freeze({ grant, installation }) : null
    },
    async invalidateInstallation(input) {
      for (const [key, grant] of installationGrants) if (grant.installation.id === input.installationId) installationGrants.delete(key)
      for (const [key, grant] of repositoryGrants) if (grant.installationId === input.installationId) repositoryGrants.delete(key)
    },
    async invalidateRepositories(input) {
      const removed = new Set(input.repositoryIds)
      for (const [key, grant] of repositoryGrants) if (grant.installationId === input.installationId && removed.has(grant.repository.id)) repositoryGrants.delete(key)
    },
  }
  const deliveryStore: WebhookDeliveryStore = {
    async claimDelivery(input) {
      for (const [id, delivery] of deliveries) if (id !== input.deliveryId && delivery.eventName === input.eventName && delivery.bodyDigest === input.bodyDigest) return null
      const current = deliveries.get(input.deliveryId)
      if (current && (current.status === 'completed' || current.leaseExpiresAt > input.receivedAt || current.eventName !== input.eventName || current.bodyDigest !== input.bodyDigest)) return null
      const leaseId = randomUUID()
      deliveries.set(input.deliveryId, Object.freeze({ status: 'claimed', eventName: input.eventName, bodyDigest: input.bodyDigest, leaseId, leaseExpiresAt: input.leaseExpiresAt }))
      return Object.freeze({ leaseId })
    },
    async completeDelivery(input) {
      const current = deliveries.get(input.deliveryId)
      if (current?.status !== 'claimed' || current.leaseId !== input.leaseId) throw new Error('GitHub webhook delivery was not claimed.')
      deliveries.set(input.deliveryId, Object.freeze({ ...current, status: 'completed' }))
    },
    async releaseDelivery(input) {
      const current = deliveries.get(input.deliveryId)
      if (current?.status === 'claimed' && current.leaseId === input.leaseId) deliveries.set(input.deliveryId, Object.freeze({ ...current, leaseExpiresAt: 0 }))
    },
  }
  const jobStore: RepositoryJobStore = {
    async enqueue(job) { if (job.status !== 'queued') throw new Error('Repository job must be queued.'); if (jobs.has(job.id)) throw new Error('Repository job already exists.'); jobs.set(job.id, Object.freeze({ ...job, actor: Object.freeze({ ...job.actor }) })) },
    async get(id) { return jobs.get(id) ?? null },
    async getAuthorized(id, actorAccountId) {
      const job = jobs.get(id)
      return job && isAuthorizedCurrentJob(job, actorAccountId) ? job : null
    },
    async latestCompletedScan(scope) {
      const membership = memberships.get(grantKey(scope.projectId, scope.actorAccountId))
      if (membership?.tenantId !== scope.tenantId || !roleAllowsProjectOperation(membership.role, 'scan')) return null
      const grant = repositoryGrants.get(grantKey(scope.tenantId, scope.projectId))
      if (!grant || grant.installationId !== scope.installationId || grant.repository.id !== scope.repositoryId
        || grant.linkedAt !== scope.repositoryLinkedAt || grant.grantId !== scope.repositoryGrantId
        || !installationGrants.has(grantKey(scope.tenantId, scope.installationId))) return null
      return [...jobs.values()].flatMap(job => job.status === 'completed' ? [job] : []).filter(job => job.tenantId === scope.tenantId
        && job.projectId === scope.projectId
        && job.installationId === scope.installationId
        && job.repositoryId === scope.repositoryId
        && job.repositoryLinkedAt === scope.repositoryLinkedAt
        && job.repositoryGrantId === scope.repositoryGrantId)
        .sort((left, right) => right.completedAt - left.completedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0] ?? null
    },
    async claimScan(input) {
      const job = jobs.get(input.id)
      if (!job || job.operation !== 'scan' || job.status === 'queued' && job.nextAttemptAt > input.now || job.status === 'running' && job.leaseExpiresAt > input.now || job.status === 'completed' || job.status === 'failed') return null
      const claimed = Object.freeze({ ...job, status: 'running' as const, leaseId: input.leaseId, leaseExpiresAt: input.leaseExpiresAt, attempt: job.attempt + 1 })
      jobs.set(input.id, claimed)
      return claimed
    },
    async claimNextScan(input) {
      const queued = [...jobs.values()]
        .filter(job => job.operation === 'scan' && (job.status === 'queued' && job.nextAttemptAt <= input.now || job.status === 'running' && job.leaseExpiresAt <= input.now))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0]
      return queued ? jobStore.claimScan({ ...input, id: queued.id }) : null
    },
    async isCurrentLease(input) {
      const job = jobs.get(input.id)
      return Boolean(job?.operation === 'scan' && job.status === 'running' && job.leaseId === input.leaseId && job.leaseExpiresAt > input.now)
    },
    async completeScan(input) {
      const job = jobs.get(input.id)
      if (job?.status !== 'running' || job.leaseId !== input.leaseId || job.leaseExpiresAt <= input.now || !isAuthorizedCurrentJob(job, job.actor.accountId)) return false
      const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...base } = job
      jobs.set(input.id, Object.freeze({ ...base, status: 'completed' as const, result: input.result, completedAt: input.now }))
      return true
    },
    async retry(input) {
      const job = jobs.get(input.id)
      if (job?.status === 'running' && job.leaseId === input.leaseId) {
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...base } = job
        jobs.set(input.id, Object.freeze({ ...base, status: 'queued' as const, nextAttemptAt: input.nextAttemptAt }))
      }
    },
    async fail(input) {
      const job = jobs.get(input.id)
      if (job?.status === 'running' && job.leaseId === input.leaseId) {
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...base } = job
        jobs.set(input.id, Object.freeze({ ...base, status: 'failed' as const, errorId: input.errorId, failedAt: input.now }))
      }
    },
  }

  function isAuthorizedCurrentJob(job: RepositoryJob, actorAccountId: string): boolean {
    const membership = memberships.get(grantKey(job.projectId, actorAccountId))
    if (membership?.tenantId !== job.tenantId || !roleAllowsProjectOperation(membership.role, job.operation)) return false
    const grant = repositoryGrants.get(grantKey(job.tenantId, job.projectId))
    return Boolean(grant
      && grant.installationId === job.installationId
      && grant.repository.id === job.repositoryId
      && grant.linkedAt === job.repositoryLinkedAt
      && grant.grantId === job.repositoryGrantId
      && installationGrants.has(grantKey(job.tenantId, job.installationId)))
  }
  const projectAuthorization: ProjectAuthorizationPort = {
    async authorizeProjectOperation(input) {
      const membership = memberships.get(grantKey(input.projectId, input.actorAccountId))
      return membership?.tenantId === input.tenantId
        ? authorizationDecision(membership.role, input.operation)
        : Object.freeze({ isMember: false, roleAllowsOperation: false })
    },
  }
  const projectTenancy = Object.freeze({
    async resolveTenantForMember(projectId: string, userId: string): Promise<string | null> {
      return memberships.get(grantKey(projectId, userId))?.tenantId ?? null
    },
  })
  return Object.freeze({
    states: Object.freeze(states),
    grants: Object.freeze(grants),
    deliveries: Object.freeze(deliveryStore),
    jobs: Object.freeze(jobStore),
    projectAuthorization: Object.freeze(projectAuthorization),
    projectTenancy,
    setProjectMembership(projectId, tenantId, userId, role) { memberships.set(grantKey(projectId, userId), Object.freeze({ tenantId, role })) },
  })
}

function authorizationDecision(role: ProjectMembershipRole | undefined, operation: ProjectRepositoryOperation): ProjectAuthorizationDecision {
  return Object.freeze({ isMember: role !== undefined, roleAllowsOperation: role !== undefined && roleAllowsProjectOperation(role, operation) })
}

function stateFromRow(row: StateRow): InstallationStateRecord {
  const expiresAt = Number(row.expires_at_ms)
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Database returned an invalid GitHub installation state expiry.')
  return Object.freeze({ digest: row.digest, accountId: row.account_id, tenantId: row.tenant_id, purpose: row.purpose, installationId: row.installation_id, codeVerifierCiphertext: row.code_verifier_ciphertext, returnToUrl: row.return_to_url, expiresAt })
}

function installationFromRow(row: InstallationRow): InstallationGrant {
  return Object.freeze({
    tenantId: row.tenant_id,
    installation: Object.freeze({ id: row.installation_id, account: Object.freeze({ id: row.account_id, login: row.account_login, type: row.account_type }), contentsPermission: row.contents_permission }),
    connectedByAccountId: row.connected_by_account_id,
    connectedAt: timestamp(row.connected_at),
  })
}

function repositoryFromRow(row: RepositoryRow): RepositoryGrant {
  return Object.freeze({
    grantId: row.grant_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    installationId: row.installation_id,
    repository: Object.freeze({
      id: row.repository_id,
      installationId: row.installation_id,
      ownerId: row.owner_id,
      ownerLogin: row.owner_login,
      name: row.repository_name,
      fullName: row.full_name,
      isPrivate: row.is_private,
      contentsPermission: row.contents_permission,
    }),
    linkedByAccountId: row.linked_by_account_id,
    linkedAt: timestamp(row.linked_at),
  })
}

function jobFromRow(row: JobRow): RepositoryJob {
  if (!Number.isSafeInteger(row.attempt) || row.attempt < 0) throw new Error('Database returned an invalid repository job attempt.')
  const base = {
    id: row.id,
    actor: Object.freeze({ accountId: row.actor_account_id, providerUserId: row.actor_provider_user_id }),
    tenantId: row.tenant_id,
    projectId: row.project_id,
    operation: row.operation,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    repositoryLinkedAt: timestamp(row.repository_linked_at),
    repositoryGrantId: row.repository_grant_id,
    createdAt: timestamp(row.created_at),
    attempt: row.attempt,
  }
  if (row.status === 'queued') {
    const nextAttemptAt = Number(row.next_attempt_at_ms)
    if (!Number.isSafeInteger(nextAttemptAt)) throw new Error('Database returned an invalid repository job retry time.')
    return Object.freeze({ ...base, status: 'queued', nextAttemptAt })
  }
  if (row.status === 'completed') {
    const completedAt = Number(row.completed_at_ms)
    if (!row.source_revision || !/^[a-f0-9]{40}$/.test(row.source_revision) || !Number.isSafeInteger(completedAt)) throw new Error('Database returned an invalid repository scan result.')
    return Object.freeze({ ...base, status: 'completed', result: scanArtifact(row.source_revision, row.scan_result, row.registry_request), completedAt })
  }
  if (row.status === 'failed') {
    const failedAt = Number(row.failed_at_ms)
    if (!row.error_id || !/^[a-z0-9-]{3,64}$/.test(row.error_id) || !Number.isSafeInteger(failedAt)) throw new Error('Database returned an invalid repository job failure.')
    return Object.freeze({ ...base, status: 'failed', errorId: row.error_id, failedAt })
  }
  if (!row.lease_id || row.lease_expires_at_ms === null) throw new Error('Database returned an invalid repository job lease.')
  const leaseExpiresAt = Number(row.lease_expires_at_ms)
  if (!Number.isSafeInteger(leaseExpiresAt)) throw new Error('Database returned an invalid repository job lease expiry.')
  return Object.freeze({ ...base, status: 'running', leaseId: row.lease_id, leaseExpiresAt })
}

const jobColumns = 'SELECT id, actor_account_id, actor_provider_user_id, tenant_id, project_id, operation, installation_id, repository_id, repository_linked_at, repository_grant_id, status, created_at, attempt, lease_id, CASE WHEN lease_expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM lease_expires_at) * 1000)::bigint END AS lease_expires_at_ms, CASE WHEN next_attempt_at IS NULL THEN NULL ELSE floor(extract(epoch FROM next_attempt_at) * 1000)::bigint END AS next_attempt_at_ms, source_revision, scan_result, registry_request, CASE WHEN completed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM completed_at) * 1000)::bigint END AS completed_at_ms, error_id, CASE WHEN failed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM failed_at) * 1000)::bigint END AS failed_at_ms'
const authorizedJobColumns = 'SELECT job.id, job.actor_account_id, job.actor_provider_user_id, job.tenant_id, job.project_id, job.operation, job.installation_id, job.repository_id, job.repository_linked_at, job.repository_grant_id, job.status, job.created_at, job.attempt, job.lease_id, CASE WHEN job.lease_expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.lease_expires_at) * 1000)::bigint END AS lease_expires_at_ms, CASE WHEN job.next_attempt_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.next_attempt_at) * 1000)::bigint END AS next_attempt_at_ms, job.source_revision, job.scan_result, job.registry_request, CASE WHEN job.completed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.completed_at) * 1000)::bigint END AS completed_at_ms, job.error_id, CASE WHEN job.failed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.failed_at) * 1000)::bigint END AS failed_at_ms'

function scanArtifact(sourceRevision: string, scan: unknown, request: unknown): RepositoryScanArtifact {
  if (!scan || typeof scan !== 'object' || Array.isArray(scan) || !request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Database returned an invalid repository scan result.')
  return Object.freeze({ sourceRevision, scan: scan as Readonly<Record<string, unknown>>, request: request as Readonly<Record<string, unknown>> })
}

function allowedRoles(operation: ProjectRepositoryOperation): readonly ProjectMembershipRole[] {
  if (operation === 'link-repository' || operation === 'write') return ['owner', 'editor']
  if (operation === 'prepare-patch') return ['owner', 'editor', 'reviewer']
  return ['owner', 'editor', 'reviewer', 'viewer']
}

function timestamp(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isSafeInteger(result)) throw new Error('Database returned an invalid timestamp.')
  return result
}

function grantKey(left: string, right: string): string { return `${left}\u0000${right}` }
function frozenInstallation(grant: InstallationGrant): InstallationGrant { return Object.freeze({ ...grant, installation: Object.freeze({ ...grant.installation, account: Object.freeze({ ...grant.installation.account }) }) }) }
function frozenRepository(grant: RepositoryGrant): RepositoryGrant { return Object.freeze({ ...grant, repository: Object.freeze({ ...grant.repository }) }) }
async function rollback(client: { query(sql: string): Promise<unknown> }): Promise<void> {
  try { await client.query('ROLLBACK') }
  catch (error) { console.error(JSON.stringify({ level: 'error', event: 'github_grant_rollback_failed', message: error instanceof Error ? error.message : String(error) })) }
}
