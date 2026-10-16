import { createHash, randomUUID } from 'node:crypto'
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
  RepositorySourceBindingCandidate,
  RepositorySourceBindingStore,
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
  sourceBindings: RepositorySourceBindingStore
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
  grant_generation: string | number
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
  repository_grant_generation: string | number
  lease_id: string | null; lease_expires_at_ms: string | number | null
  source_revision: string | null; scan_result: unknown; registry_request: unknown; completed_at_ms: string | number | null
  error_id: string | null; failed_at_ms: string | number | null
}>

type SourceBindingRow = QueryResultRow & Readonly<{
  project_id: string
  tenant_id: string
  installation_id: string
  repository_id: string
  repository_linked_at: Date | string
  repository_grant_id: string
  repository_grant_generation: string | number
  scan_job_id: string
  source_revision: string
  registry_fingerprint: string
  authority: unknown
  version: string | number
  records: unknown
  canonical_digest: string
  updated_at: Date | string
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
      const result = await pool.query<RepositoryRow>(
        `INSERT INTO app_github_repository_grant
          (project_id, tenant_id, installation_id, repository_id, owner_id, owner_login, repository_name, full_name, is_private, contents_permission, linked_by_account_id, linked_at, grant_id, grant_generation, invalidated_at, invalidation_reason)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0), $13::uuid, 1, NULL, NULL
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
          grant_generation = app_github_repository_grant.grant_generation + 1,
          invalidated_at = NULL,
          invalidation_reason = NULL
         RETURNING grant_id, tenant_id, project_id, installation_id, repository_id, owner_id, owner_login, repository_name, full_name, is_private, contents_permission, linked_by_account_id, linked_at, grant_generation`,
        [grant.projectId, grant.tenantId, grant.installationId, grant.repository.id, grant.repository.ownerId, grant.repository.ownerLogin, grant.repository.name, grant.repository.fullName, grant.repository.isPrivate, grant.repository.contentsPermission, grant.linkedByAccountId, grant.linkedAt, grant.grantId],
      )
      if (result.rowCount !== 1) throw new Error('Project repository grant is not authorized.')
      return repositoryFromRow(result.rows[0]!)
    },
    async getRepositoryGrant(input) {
      const result = await pool.query<RepositoryRow>(
        `SELECT grant_id, tenant_id, project_id, installation_id, repository_id, owner_id, owner_login, repository_name, full_name, is_private, contents_permission, linked_by_account_id, linked_at, grant_generation
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
                repository.is_private, repository.contents_permission, repository.linked_by_account_id, repository.linked_at, repository.grant_generation,
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
          (id, actor_account_id, actor_provider_user_id, tenant_id, project_id, operation, installation_id, repository_id, repository_linked_at, repository_grant_id, repository_grant_generation, status, created_at, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0), $10::uuid, $11, 'queued', to_timestamp($12 / 1000.0), to_timestamp($13 / 1000.0))`,
        [job.id, job.actor.accountId, job.actor.providerUserId, job.tenantId, job.projectId, job.operation, job.installationId, job.repositoryId, job.repositoryLinkedAt, job.repositoryGrantId, job.repositoryGrantGeneration, job.createdAt, job.nextAttemptAt],
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
          AND repository.grant_generation = job.repository_grant_generation
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
          AND repository.grant_generation = job.repository_grant_generation
         JOIN app_github_installation_grant AS installation
           ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
         JOIN app_project_member AS member
           ON member.project_id = repository.project_id AND member.user_id = $8
         WHERE job.tenant_id = $1 AND job.project_id = $2 AND job.installation_id = $3 AND job.repository_id = $4
           AND job.repository_linked_at = to_timestamp($5 / 1000.0) AND job.repository_grant_id = $6::uuid
           AND job.repository_grant_generation = $7
           AND job.operation = 'scan' AND job.status = 'completed'
           AND member.role = ANY($9::text[])
           AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
         ORDER BY job.completed_at DESC, job.created_at DESC, job.id DESC LIMIT 1`,
        [scope.tenantId, scope.projectId, scope.installationId, scope.repositoryId, scope.repositoryLinkedAt, scope.repositoryGrantId, scope.repositoryGrantGeneration, scope.actorAccountId, allowedRoles('scan')],
      )
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async claimScan(input) {
      const result = await pool.query<JobRow>(
        `UPDATE app_github_repository_job AS job
         SET status = 'running', lease_id = $2, lease_expires_at = to_timestamp($4 / 1000.0), next_attempt_at = NULL, attempt = attempt + 1
         WHERE job.id = $1 AND job.operation = 'scan'
           AND ((job.status = 'queued' AND job.next_attempt_at <= to_timestamp($3 / 1000.0)) OR (job.status = 'running' AND job.lease_expires_at <= to_timestamp($3 / 1000.0)))
           AND ${currentJobAuthorizationSql('job')}
         RETURNING job.id, job.actor_account_id, job.actor_provider_user_id, job.tenant_id, job.project_id, job.operation, job.installation_id, job.repository_id, job.repository_linked_at, job.repository_grant_id, job.repository_grant_generation, job.status, job.created_at, job.attempt, job.lease_id, floor(extract(epoch FROM job.lease_expires_at) * 1000)::bigint AS lease_expires_at_ms, NULL::bigint AS next_attempt_at_ms, job.source_revision, job.scan_result, job.registry_request, NULL::bigint AS completed_at_ms, job.error_id, NULL::bigint AS failed_at_ms`,
        [input.id, input.leaseId, input.now, input.leaseExpiresAt],
      )
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async claimNextScan(input) {
      const result = await pool.query<JobRow>(
        `WITH candidate AS (
           SELECT job.id FROM app_github_repository_job AS job
           WHERE job.operation = 'scan' AND ((job.status = 'queued' AND job.next_attempt_at <= to_timestamp($2 / 1000.0)) OR (job.status = 'running' AND job.lease_expires_at <= to_timestamp($2 / 1000.0)))
             AND ${currentJobAuthorizationSql('job')}
           ORDER BY job.created_at, job.id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE app_github_repository_job AS job
         SET status = 'running', lease_id = $1, lease_expires_at = to_timestamp($3 / 1000.0), next_attempt_at = NULL, attempt = attempt + 1
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.id, job.actor_account_id, job.actor_provider_user_id, job.tenant_id, job.project_id, job.operation, job.installation_id, job.repository_id, job.repository_linked_at, job.repository_grant_id, job.repository_grant_generation, job.status, job.created_at, job.attempt, job.lease_id, floor(extract(epoch FROM job.lease_expires_at) * 1000)::bigint AS lease_expires_at_ms, NULL::bigint AS next_attempt_at_ms, job.source_revision, job.scan_result, job.registry_request, NULL::bigint AS completed_at_ms, job.error_id, NULL::bigint AS failed_at_ms`,
        [input.leaseId, input.now, input.leaseExpiresAt],
      )
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async isCurrentLease(input) {
      const result = await pool.query(
        `SELECT 1 FROM app_github_repository_job AS job
         WHERE job.id = $1 AND job.operation = 'scan' AND job.status = 'running' AND job.lease_id = $2 AND job.lease_expires_at > to_timestamp($3 / 1000.0)
           AND ${currentJobAuthorizationSql('job')}`,
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
               AND repository.grant_generation = job.repository_grant_generation
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

  const sourceBindings: RepositorySourceBindingStore = {
    async getAuthorized(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query<SourceBindingRow>(
          `${sourceBindingColumns}
           FROM app_github_repository_source_binding AS binding
           JOIN app_github_repository_grant AS repository
             ON repository.project_id = binding.project_id AND repository.tenant_id = binding.tenant_id
            AND repository.installation_id = binding.installation_id AND repository.repository_id = binding.repository_id
            AND binding.repository_grant_generation <= repository.grant_generation
           JOIN app_github_installation_grant AS installation
             ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
           JOIN app_github_repository_job AS scan
             ON scan.id = binding.scan_job_id AND scan.tenant_id = binding.tenant_id AND scan.project_id = binding.project_id
            AND scan.installation_id = binding.installation_id AND scan.repository_id = binding.repository_id
            AND scan.repository_linked_at = binding.repository_linked_at AND scan.repository_grant_id = binding.repository_grant_id
            AND scan.repository_grant_generation = binding.repository_grant_generation
            AND scan.operation = 'scan' AND scan.status = 'completed' AND scan.source_revision = binding.source_revision
           JOIN app_project_member AS member
             ON member.project_id = repository.project_id AND member.user_id = $3
           WHERE binding.tenant_id = $1 AND binding.project_id = $2
             AND member.role = ANY($4::text[]) AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
           FOR SHARE OF binding, repository, installation, scan`,
          [input.tenantId, input.projectId, input.actorAccountId, allowedRoles(input.operation)],
        )
        const snapshot = result.rows[0] ? sourceBindingFromRow(result.rows[0]) : null
        await client.query('COMMIT')
        return snapshot
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
    },
    async commitAuthorized(input) {
      const candidate = sourceBindingCandidate(input.candidate)
      const expectedVersion = input.expectedVersion === null ? null : positiveInputInteger(input.expectedVersion)
      const expectedAuthority = input.expectedAuthority === null ? null : bindingAuthority(input.expectedAuthority)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const access = await client.query<RepositoryRow>(
          `SELECT repository.grant_id, repository.tenant_id, repository.project_id, repository.installation_id, repository.repository_id,
                  repository.owner_id, repository.owner_login, repository.repository_name, repository.full_name, repository.is_private,
                  repository.contents_permission, repository.linked_by_account_id, repository.linked_at, repository.grant_generation
           FROM app_github_repository_grant AS repository
           JOIN app_github_installation_grant AS installation
             ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
           JOIN app_project_member AS member
             ON member.project_id = repository.project_id AND member.user_id = $3
           WHERE repository.tenant_id = $1 AND repository.project_id = $2
             AND member.role = ANY($4::text[]) AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
           FOR UPDATE OF repository`,
          [input.tenantId, input.projectId, input.actorAccountId, allowedRoles(input.operation)],
        )
        const grant = access.rows[0] ? repositoryFromRow(access.rows[0]) : null
        if (!grant || !sameGrantScope(grant, input.grantScope) || !candidateMatchesScopes(candidate, input.projectId, input.grantScope, input.scanScope)) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'unauthorized' as const })
        }
        const scan = await client.query<JobRow>(
          `${jobColumns} FROM app_github_repository_job
           WHERE id = $1 AND tenant_id = $2 AND project_id = $3 AND operation = 'scan' AND status = 'completed'
             AND installation_id = $4 AND repository_id = $5 AND repository_linked_at = to_timestamp($6 / 1000.0)
             AND repository_grant_id = $7::uuid AND repository_grant_generation = $8`,
          [input.scanScope.scanJobId, input.tenantId, input.projectId, input.grantScope.installationId, input.grantScope.repositoryId, input.grantScope.repositoryLinkedAt, input.grantScope.repositoryGrantId, input.grantScope.repositoryGrantGeneration],
        )
        const scanJob = scan.rows[0] ? jobFromRow(scan.rows[0]) : null
        if (!scanJob || scanJob.status !== 'completed' || scanJob.result.sourceRevision !== input.scanScope.sourceRevision) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'unauthorized' as const })
        }
        const currentResult = await client.query<SourceBindingRow & { scan_matches: boolean }>(
          `${sourceBindingColumns}, EXISTS (
             SELECT 1 FROM app_github_repository_job AS prior_scan
             WHERE prior_scan.id = binding.scan_job_id AND prior_scan.tenant_id = binding.tenant_id AND prior_scan.project_id = binding.project_id
               AND prior_scan.installation_id = binding.installation_id AND prior_scan.repository_id = binding.repository_id
               AND prior_scan.repository_linked_at = binding.repository_linked_at AND prior_scan.repository_grant_id = binding.repository_grant_id
               AND prior_scan.repository_grant_generation = binding.repository_grant_generation
               AND prior_scan.operation = 'scan' AND prior_scan.status = 'completed' AND prior_scan.source_revision = binding.source_revision
           ) AS scan_matches
           FROM app_github_repository_source_binding AS binding WHERE binding.project_id = $1 FOR UPDATE`,
          [input.projectId],
        )
        const currentRow = currentResult.rows[0]
        if (currentRow && sameStableGrantScope(currentRow, input.grantScope) && !currentRow.scan_matches) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'unauthorized' as const })
        }
        if (currentRow && sameStableGrantScope(currentRow, input.grantScope)
          && positiveInteger(currentRow.repository_grant_generation, 'repository source binding grant generation') > input.grantScope.repositoryGrantGeneration) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'unauthorized' as const })
        }
        const current = currentRow && sourceBindingRowCompatibleWithGrant(currentRow, input.grantScope) ? sourceBindingFromRow(currentRow) : null
        if (!matchesExpectedSnapshot(current, expectedVersion, expectedAuthority)) {
          await client.query('ROLLBACK')
          return Object.freeze({ status: 'stale' as const })
        }
        const snapshot = sourceBindingSnapshot((current?.version ?? 0) + 1, candidate)
        const digest = sourceBindingDigest(snapshot)
        await client.query(
          `INSERT INTO app_github_repository_source_binding
            (project_id, tenant_id, installation_id, repository_id, repository_linked_at, repository_grant_id, repository_grant_generation,
             scan_job_id, source_revision, registry_fingerprint, authority, version, records, canonical_digest, updated_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6::uuid, $7, $8::uuid, $9, $10, $11::jsonb, $12, $13::jsonb, $14, to_timestamp($15 / 1000.0))
           ON CONFLICT (project_id) DO UPDATE SET
             tenant_id = EXCLUDED.tenant_id, installation_id = EXCLUDED.installation_id, repository_id = EXCLUDED.repository_id,
             repository_linked_at = EXCLUDED.repository_linked_at, repository_grant_id = EXCLUDED.repository_grant_id,
             repository_grant_generation = EXCLUDED.repository_grant_generation, scan_job_id = EXCLUDED.scan_job_id,
             source_revision = EXCLUDED.source_revision, registry_fingerprint = EXCLUDED.registry_fingerprint,
             authority = EXCLUDED.authority, version = EXCLUDED.version, records = EXCLUDED.records,
             canonical_digest = EXCLUDED.canonical_digest, updated_at = EXCLUDED.updated_at`,
          [input.projectId, input.tenantId, input.grantScope.installationId, input.grantScope.repositoryId, input.grantScope.repositoryLinkedAt,
            input.grantScope.repositoryGrantId, input.grantScope.repositoryGrantGeneration, input.scanScope.scanJobId, input.scanScope.sourceRevision,
            input.scanScope.registryFingerprint, JSON.stringify(snapshot.authority), snapshot.version, JSON.stringify(snapshot.records), digest, snapshot.updatedAt],
        )
        await client.query('COMMIT')
        return Object.freeze({ status: 'committed' as const, snapshot })
      } catch (error) {
        await rollback(client)
        throw error
      } finally {
        client.release()
      }
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

  return Object.freeze({ states: Object.freeze(states), grants: Object.freeze(grants), deliveries: Object.freeze(deliveries), jobs: Object.freeze(jobs), sourceBindings: Object.freeze(sourceBindings), projectAuthorization: Object.freeze(projectAuthorization), projectTenancy })
}

export function createMemoryGitHubPersistence(): GitHubPersistence & Readonly<{
  setProjectMembership(projectId: string, tenantId: string, userId: string, role: ProjectMembershipRole): void
  removeProjectMembership(projectId: string, userId: string): void
}> {
  const stateRecords = new Map<string, InstallationStateRecord>()
  const installationGrants = new Map<string, InstallationGrant>()
  const repositoryGrants = new Map<string, RepositoryGrant>()
  const repositoryGrantGenerations = new Map<string, number>()
  const bindingSnapshots = new Map<string, Readonly<{
    snapshot: unknown
    grantScope: Readonly<{ installationId: string; repositoryId: string; repositoryLinkedAt: number; repositoryGrantId: string; repositoryGrantGeneration: number }>
    scanScope: Readonly<{ scanJobId: string; sourceRevision: string; registryFingerprint: string }>
    canonicalDigest: string
  }>>()
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
      const key = grantKey(grant.tenantId, grant.projectId)
      const grantGeneration = (repositoryGrantGenerations.get(key) ?? 0) + 1
      repositoryGrantGenerations.set(key, grantGeneration)
      const saved = frozenRepository({ ...grant, grantGeneration })
      repositoryGrants.set(key, saved)
      return saved
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
        || grant.grantGeneration !== scope.repositoryGrantGeneration
        || !installationGrants.has(grantKey(scope.tenantId, scope.installationId))) return null
      return [...jobs.values()].flatMap(job => job.status === 'completed' ? [job] : []).filter(job => job.tenantId === scope.tenantId
        && job.projectId === scope.projectId
        && job.installationId === scope.installationId
        && job.repositoryId === scope.repositoryId
        && job.repositoryLinkedAt === scope.repositoryLinkedAt
        && job.repositoryGrantId === scope.repositoryGrantId
        && job.repositoryGrantGeneration === scope.repositoryGrantGeneration)
        .sort((left, right) => right.completedAt - left.completedAt || right.createdAt - left.createdAt || compareText(right.id, left.id))[0] ?? null
    },
    async claimScan(input) {
      const job = jobs.get(input.id)
      if (!job || !isAuthorizedCurrentJob(job, job.actor.accountId) || job.operation !== 'scan' || job.status === 'queued' && job.nextAttemptAt > input.now || job.status === 'running' && job.leaseExpiresAt > input.now || job.status === 'completed' || job.status === 'failed') return null
      const claimed = Object.freeze({ ...job, status: 'running' as const, leaseId: input.leaseId, leaseExpiresAt: input.leaseExpiresAt, attempt: job.attempt + 1 })
      jobs.set(input.id, claimed)
      return claimed
    },
    async claimNextScan(input) {
      const queued = [...jobs.values()]
        .filter(job => isAuthorizedCurrentJob(job, job.actor.accountId) && job.operation === 'scan' && (job.status === 'queued' && job.nextAttemptAt <= input.now || job.status === 'running' && job.leaseExpiresAt <= input.now))
        .sort((left, right) => left.createdAt - right.createdAt || compareText(left.id, right.id))[0]
      return queued ? jobStore.claimScan({ ...input, id: queued.id }) : null
    },
    async isCurrentLease(input) {
      const job = jobs.get(input.id)
      return Boolean(job?.operation === 'scan' && job.status === 'running' && job.leaseId === input.leaseId && job.leaseExpiresAt > input.now && isAuthorizedCurrentJob(job, job.actor.accountId))
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
      && grant.grantGeneration === job.repositoryGrantGeneration
      && installationGrants.has(grantKey(job.tenantId, job.installationId)))
  }
  const sourceBindings: RepositorySourceBindingStore = {
    async getAuthorized(input) {
      const membership = memberships.get(grantKey(input.projectId, input.actorAccountId))
      if (membership?.tenantId !== input.tenantId || !roleAllowsProjectOperation(membership.role, input.operation)) return null
      const grant = repositoryGrants.get(grantKey(input.tenantId, input.projectId))
      if (!grant || !installationGrants.has(grantKey(input.tenantId, grant.installationId))) return null
      const stored = bindingSnapshots.get(grantKey(input.tenantId, input.projectId))
      if (stored === undefined) return null
      const snapshot = sourceBindingSnapshotFromUnknown(stored.snapshot)
      const scan = jobs.get(stored.scanScope.scanJobId)
      return compatibleStoredGrantScope(grant, stored.grantScope)
        && scan?.status === 'completed' && scan.result.sourceRevision === stored.scanScope.sourceRevision
        && scan.tenantId === input.tenantId && scan.projectId === input.projectId
        && scan.repositoryGrantGeneration === stored.grantScope.repositoryGrantGeneration
        && candidateMatchesScopes({ authority: snapshot.authority, records: snapshot.records, updatedAt: snapshot.updatedAt }, input.projectId, stored.grantScope, stored.scanScope)
        && sourceBindingDigest(snapshot) === stored.canonicalDigest ? snapshot : null
    },
    async commitAuthorized(input) {
      const candidate = sourceBindingCandidate(input.candidate)
      const expectedVersion = input.expectedVersion === null ? null : positiveInputInteger(input.expectedVersion)
      const expectedAuthority = input.expectedAuthority === null ? null : bindingAuthority(input.expectedAuthority)
      const membership = memberships.get(grantKey(input.projectId, input.actorAccountId))
      const grant = repositoryGrants.get(grantKey(input.tenantId, input.projectId))
      if (membership?.tenantId !== input.tenantId || !roleAllowsProjectOperation(membership.role, input.operation)
        || !grant || !installationGrants.has(grantKey(input.tenantId, grant.installationId))
        || !sameGrantScope(grant, input.grantScope) || !candidateMatchesScopes(candidate, input.projectId, input.grantScope, input.scanScope)) {
        return Object.freeze({ status: 'unauthorized' as const })
      }
      const scan = jobs.get(input.scanScope.scanJobId)
      if (!scan || scan.status !== 'completed' || scan.tenantId !== input.tenantId || scan.projectId !== input.projectId
        || scan.installationId !== input.grantScope.installationId || scan.repositoryId !== input.grantScope.repositoryId
        || scan.repositoryLinkedAt !== input.grantScope.repositoryLinkedAt || scan.repositoryGrantId !== input.grantScope.repositoryGrantId
        || scan.repositoryGrantGeneration !== input.grantScope.repositoryGrantGeneration || scan.result.sourceRevision !== input.scanScope.sourceRevision) {
        return Object.freeze({ status: 'unauthorized' as const })
      }
      const key = grantKey(input.tenantId, input.projectId)
      const stored = bindingSnapshots.get(key)
      if (stored && compatibleStableGrantScopes(stored.grantScope, input.grantScope)
        && stored.grantScope.repositoryGrantGeneration > input.grantScope.repositoryGrantGeneration) return Object.freeze({ status: 'unauthorized' as const })
      const current = stored === undefined || !compatibleGrantScopes(stored.grantScope, input.grantScope)
        ? null : sourceBindingSnapshotFromUnknown(stored.snapshot)
      if (!matchesExpectedSnapshot(current, expectedVersion, expectedAuthority)) return Object.freeze({ status: 'stale' as const })
      const snapshot = sourceBindingSnapshot((current?.version ?? 0) + 1, candidate)
      bindingSnapshots.set(key, deepFreeze({ snapshot, grantScope: { ...input.grantScope }, scanScope: { ...input.scanScope }, canonicalDigest: sourceBindingDigest(snapshot) }))
      return Object.freeze({ status: 'committed' as const, snapshot })
    },
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
    sourceBindings: Object.freeze(sourceBindings),
    projectAuthorization: Object.freeze(projectAuthorization),
    projectTenancy,
    setProjectMembership(projectId, tenantId, userId, role) { memberships.set(grantKey(projectId, userId), Object.freeze({ tenantId, role })) },
    removeProjectMembership(projectId, userId) { memberships.delete(grantKey(projectId, userId)) },
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
  const grantGeneration = positiveInteger(row.grant_generation, 'repository grant generation')
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
    grantGeneration,
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
    repositoryGrantGeneration: positiveInteger(row.repository_grant_generation, 'repository job grant generation'),
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

const jobColumns = 'SELECT id, actor_account_id, actor_provider_user_id, tenant_id, project_id, operation, installation_id, repository_id, repository_linked_at, repository_grant_id, repository_grant_generation, status, created_at, attempt, lease_id, CASE WHEN lease_expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM lease_expires_at) * 1000)::bigint END AS lease_expires_at_ms, CASE WHEN next_attempt_at IS NULL THEN NULL ELSE floor(extract(epoch FROM next_attempt_at) * 1000)::bigint END AS next_attempt_at_ms, source_revision, scan_result, registry_request, CASE WHEN completed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM completed_at) * 1000)::bigint END AS completed_at_ms, error_id, CASE WHEN failed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM failed_at) * 1000)::bigint END AS failed_at_ms'
const authorizedJobColumns = 'SELECT job.id, job.actor_account_id, job.actor_provider_user_id, job.tenant_id, job.project_id, job.operation, job.installation_id, job.repository_id, job.repository_linked_at, job.repository_grant_id, job.repository_grant_generation, job.status, job.created_at, job.attempt, job.lease_id, CASE WHEN job.lease_expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.lease_expires_at) * 1000)::bigint END AS lease_expires_at_ms, CASE WHEN job.next_attempt_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.next_attempt_at) * 1000)::bigint END AS next_attempt_at_ms, job.source_revision, job.scan_result, job.registry_request, CASE WHEN job.completed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.completed_at) * 1000)::bigint END AS completed_at_ms, job.error_id, CASE WHEN job.failed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM job.failed_at) * 1000)::bigint END AS failed_at_ms'
const sourceBindingColumns = `SELECT binding.project_id, binding.tenant_id, binding.installation_id, binding.repository_id,
  binding.repository_linked_at, binding.repository_grant_id, binding.repository_grant_generation, binding.scan_job_id,
  binding.source_revision, binding.registry_fingerprint, binding.authority, binding.version, binding.records,
  binding.canonical_digest, binding.updated_at`

function scanArtifact(sourceRevision: string, scan: unknown, request: unknown): RepositoryScanArtifact {
  if (!scan || typeof scan !== 'object' || Array.isArray(scan) || !request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Database returned an invalid repository scan result.')
  return Object.freeze({ sourceRevision, scan: scan as Readonly<Record<string, unknown>>, request: request as Readonly<Record<string, unknown>> })
}

type BindingAuthority = RepositorySourceBindingCandidate['authority']
type BindingRecord = RepositorySourceBindingCandidate['records'][number]
type BindingSnapshot = Readonly<{ version: number; authority: BindingAuthority; records: readonly BindingRecord[]; updatedAt: number }>
type BindingCandidate = Readonly<{ authority: BindingAuthority; records: readonly BindingRecord[]; updatedAt: number }>

function sourceBindingCandidate(input: unknown): BindingCandidate {
  const value = exactObject(input, ['authority', 'records', 'updatedAt'], 'repository source binding candidate')
  if (!Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0 || !Array.isArray(value.records) || value.records.length > 10_000) throw invalidBinding()
  const authority = bindingAuthority(value.authority)
  const records = value.records.map(item => bindingRecord(item, authority))
  const ids = new Set<string>()
  const symbols = new Set<string>()
  const locators = new Set<string>()
  for (const record of records) {
    const locator = `${record.evidence.packageName}\0${record.evidence.path}\0${record.evidence.exportName}`
    if (ids.has(record.id) || symbols.has(record.evidence.symbolKey) || locators.has(locator)) throw invalidBinding()
    ids.add(record.id); symbols.add(record.evidence.symbolKey); locators.add(locator)
  }
  records.sort((left, right) => compareText(left.id, right.id))
  const candidate = deepFreeze({ authority, records, updatedAt: Number(value.updatedAt) })
  if (Buffer.byteLength(JSON.stringify(authority), 'utf8') > 16_384 || Buffer.byteLength(JSON.stringify(records), 'utf8') > 10_485_760) throw invalidBinding()
  return candidate
}

function sourceBindingSnapshot(version: number, candidate: BindingCandidate): BindingSnapshot {
  if (!Number.isSafeInteger(version) || version < 1) throw invalidBinding()
  return deepFreeze({ version, authority: candidate.authority, records: [...candidate.records], updatedAt: candidate.updatedAt })
}

function sourceBindingSnapshotFromUnknown(input: unknown): BindingSnapshot {
  const value = exactObject(input, ['version', 'authority', 'records', 'updatedAt'], 'repository source binding snapshot')
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) throw invalidBinding()
  return sourceBindingSnapshot(Number(value.version), sourceBindingCandidate({ authority: value.authority, records: value.records, updatedAt: value.updatedAt }))
}

function sourceBindingFromRow(row: SourceBindingRow): BindingSnapshot {
  const version = positiveInteger(row.version, 'repository source binding version')
  const snapshot = sourceBindingSnapshotFromUnknown({ version, authority: row.authority, records: row.records, updatedAt: timestamp(row.updated_at) })
  const authority = snapshot.authority
  if (authority.repository.projectId !== row.project_id || authority.repository.repositoryId !== row.repository_id
    || authority.grantGeneration !== positiveInteger(row.repository_grant_generation, 'repository source binding grant generation')
    || authority.scanId !== row.scan_job_id || authority.sourceRevision !== row.source_revision
    || authority.registryFingerprint !== row.registry_fingerprint || sourceBindingDigest(snapshot) !== row.canonical_digest) throw invalidBinding()
  return snapshot
}

function bindingAuthority(input: unknown): BindingAuthority {
  const value = exactObject(input, ['repository', 'scanId', 'sourceRevision', 'registryFingerprint', 'grantGeneration', 'adapterId'], 'source binding authority')
  const repository = exactObject(value.repository, ['provider', 'projectId', 'repositoryId'], 'source binding repository')
  if (repository.provider !== 'github' || !opaque(repository.projectId) || !opaque(repository.repositoryId)
    || !opaque(value.scanId) || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceRevision)
    || typeof value.registryFingerprint !== 'string' || !/^(?:sha256:[a-f0-9]{64}|sha256-[A-Za-z0-9+/]{43}=)$/.test(value.registryFingerprint)
    || !Number.isSafeInteger(value.grantGeneration) || Number(value.grantGeneration) < 1
    || typeof value.adapterId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(value.adapterId)) throw invalidBinding()
  return deepFreeze({
    repository: { provider: 'github' as const, projectId: repository.projectId as string, repositoryId: repository.repositoryId as string },
    scanId: value.scanId as string,
    sourceRevision: value.sourceRevision,
    registryFingerprint: value.registryFingerprint,
    grantGeneration: Number(value.grantGeneration),
    adapterId: value.adapterId,
  })
}

function bindingRecord(input: unknown, authority: BindingAuthority): BindingRecord {
  const value = exactObject(input, ['id', 'repository', 'authority', 'evidence', 'status'], ['candidates'], 'source binding record')
  const recordAuthority = bindingAuthority(value.authority)
  const repository = exactObject(value.repository, ['provider', 'projectId', 'repositoryId'], 'source binding repository')
  const evidence = bindingEvidence(value.evidence)
  if (!opaque(value.id) || canonicalJson(recordAuthority) !== canonicalJson(authority)
    || canonicalJson(repository) !== canonicalJson(authority.repository)) throw invalidBinding()
  const base = { id: value.id as string, repository: authority.repository, authority, evidence }
  if (value.status === 'bound' || value.status === 'missing') {
    if (Object.hasOwn(value, 'candidates')) throw invalidBinding()
    return deepFreeze({ ...base, status: value.status }) as BindingRecord
  }
  if (value.status !== 'ambiguous' || !Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 10_000) throw invalidBinding()
  const candidates = value.candidates.map(bindingEvidence)
  const candidateKeys = new Set<string>()
  const candidateLocators = new Set<string>()
  for (const candidate of candidates) {
    const locator = `${candidate.packageName}\0${candidate.path}\0${candidate.exportName}`
    if (candidateKeys.has(candidate.symbolKey) || candidateLocators.has(locator)) throw invalidBinding()
    candidateKeys.add(candidate.symbolKey); candidateLocators.add(locator)
  }
  candidates.sort((left, right) => compareText(`${left.packageName}\0${left.path}\0${left.exportName}`, `${right.packageName}\0${right.path}\0${right.exportName}`) || compareText(left.symbolKey, right.symbolKey))
  return deepFreeze({ ...base, status: 'ambiguous' as const, candidates }) as BindingRecord
}

function bindingEvidence(input: unknown) {
  const value = exactObject(input, ['symbolKey', 'packageName', 'path', 'exportName', 'sourceHash', 'fingerprint'], 'source binding evidence')
  const packagePattern = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,126}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
  const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
  if (!opaque(value.symbolKey) || typeof value.packageName !== 'string' || value.packageName.length > 128 || !packagePattern.test(value.packageName)
    || typeof value.path !== 'string' || value.path.length > 1_000 || !pathPattern.test(value.path)
    || typeof value.exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(value.exportName)
    || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw invalidBinding()
  return deepFreeze({ symbolKey: value.symbolKey as string, packageName: value.packageName, path: value.path, exportName: value.exportName, sourceHash: value.sourceHash, fingerprint: value.fingerprint })
}

function sameGrantScope(grant: RepositoryGrant, scope: Readonly<{ installationId: string; repositoryId: string; repositoryLinkedAt: number; repositoryGrantId: string; repositoryGrantGeneration: number }>): boolean {
  return grant.installationId === scope.installationId && grant.repository.id === scope.repositoryId
    && grant.linkedAt === scope.repositoryLinkedAt && grant.grantId === scope.repositoryGrantId
    && grant.grantGeneration === scope.repositoryGrantGeneration
}

function compatibleStoredGrantScope(grant: RepositoryGrant, stored: Readonly<{ installationId: string; repositoryId: string; repositoryGrantGeneration: number }>): boolean {
  return grant.installationId === stored.installationId && grant.repository.id === stored.repositoryId
    && stored.repositoryGrantGeneration <= grant.grantGeneration
}

function compatibleGrantScopes(left: Readonly<{ installationId: string; repositoryId: string; repositoryGrantGeneration: number }>, right: Readonly<{ installationId: string; repositoryId: string; repositoryGrantGeneration: number }>): boolean {
  return compatibleStableGrantScopes(left, right)
    && left.repositoryGrantGeneration <= right.repositoryGrantGeneration
}

function compatibleStableGrantScopes(left: Readonly<{ installationId: string; repositoryId: string }>, right: Readonly<{ installationId: string; repositoryId: string }>): boolean {
  return left.installationId === right.installationId && left.repositoryId === right.repositoryId
}

function sourceBindingRowCompatibleWithGrant(row: SourceBindingRow, scope: Readonly<{ installationId: string; repositoryId: string; repositoryGrantGeneration: number }>): boolean {
  return sameStableGrantScope(row, scope)
    && positiveInteger(row.repository_grant_generation, 'repository source binding grant generation') <= scope.repositoryGrantGeneration
}

function sameStableGrantScope(row: SourceBindingRow, scope: Readonly<{ installationId: string; repositoryId: string }>): boolean {
  return row.installation_id === scope.installationId && row.repository_id === scope.repositoryId
}

function candidateMatchesScopes(candidate: BindingCandidate, projectId: string,
  grant: Readonly<{ repositoryId: string; repositoryGrantGeneration: number }>,
  scan: Readonly<{ scanJobId: string; sourceRevision: string; registryFingerprint: string }>): boolean {
  return candidate.authority.repository.provider === 'github' && candidate.authority.repository.projectId === projectId
    && candidate.authority.repository.repositoryId === grant.repositoryId && candidate.authority.grantGeneration === grant.repositoryGrantGeneration
    && candidate.authority.scanId === scan.scanJobId && candidate.authority.sourceRevision === scan.sourceRevision
    && candidate.authority.registryFingerprint === scan.registryFingerprint
}

function matchesExpectedSnapshot(current: BindingSnapshot | null, version: number | null, authority: BindingAuthority | null): boolean {
  if (current === null) return version === null && authority === null
  return version === current.version && authority !== null && canonicalJson(authority) === canonicalJson(current.authority)
}

function sourceBindingDigest(snapshot: BindingSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compareText).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function exactObject(input: unknown, required: readonly string[], label: string): Record<string, unknown>
function exactObject(input: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown>
function exactObject(input: unknown, required: readonly string[], optionalOrLabel: readonly string[] | string, maybeLabel?: string): Record<string, unknown> {
  const optional = typeof optionalOrLabel === 'string' ? [] : optionalOrLabel
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidBinding()
  const value = input as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Invalid ${typeof optionalOrLabel === 'string' ? optionalOrLabel : maybeLabel}.`)
  return value
}

function opaque(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value)
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function invalidBinding(): Error { return new Error('Repository source bindings are invalid.') }

function currentJobAuthorizationSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM app_github_repository_grant AS repository
    JOIN app_github_installation_grant AS installation
      ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
    JOIN app_project_member AS member ON member.project_id = repository.project_id
    WHERE repository.tenant_id = ${alias}.tenant_id AND repository.project_id = ${alias}.project_id
      AND repository.installation_id = ${alias}.installation_id AND repository.repository_id = ${alias}.repository_id
      AND repository.linked_at = ${alias}.repository_linked_at AND repository.grant_id = ${alias}.repository_grant_id
      AND repository.grant_generation = ${alias}.repository_grant_generation
      AND member.user_id = ${alias}.actor_account_id
      AND (member.role IN ('owner', 'editor')
        OR member.role = 'reviewer' AND ${alias}.operation IN ('scan', 'pull', 'prepare-patch')
        OR member.role = 'viewer' AND ${alias}.operation IN ('scan', 'pull'))
      AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
  )`
}

function positiveInteger(value: string | number, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Database returned an invalid ${label}.`)
  return result
}

function positiveInputInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalidBinding()
  return Number(value)
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

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
