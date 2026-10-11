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
  expires_at_ms: string | number
}>

type JobRow = QueryResultRow & Readonly<{
  id: string; actor_account_id: string; actor_provider_user_id: string; tenant_id: string; project_id: string
  operation: 'scan' | 'pull' | 'prepare-patch' | 'write'; installation_id: string; repository_id: string
  status: 'queued' | 'running'; created_at: Date | string
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
        'INSERT INTO app_github_installation_state (digest, account_id, tenant_id, purpose, installation_id, code_verifier_ciphertext, expires_at) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))',
        [record.digest, record.accountId, record.tenantId, record.purpose, record.installationId, record.codeVerifierCiphertext, record.expiresAt],
      )
    },
    async consume(input) {
      const result = await pool.query<StateRow>(
        `DELETE FROM app_github_installation_state
         WHERE digest = $1 AND account_id = $2 AND purpose = $3 AND expires_at > to_timestamp($4 / 1000.0)
         RETURNING digest, account_id, tenant_id, purpose, installation_id, code_verifier_ciphertext, floor(extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms`,
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
          (project_id, tenant_id, installation_id, repository_id, owner_id, owner_login, repository_name, full_name, is_private, contents_permission, linked_by_account_id, linked_at, invalidated_at, invalidation_reason)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0), NULL, NULL
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
          invalidated_at = NULL,
          invalidation_reason = NULL`,
        [grant.projectId, grant.tenantId, grant.installationId, grant.repository.id, grant.repository.ownerId, grant.repository.ownerLogin, grant.repository.name, grant.repository.fullName, grant.repository.isPrivate, grant.repository.contentsPermission, grant.linkedByAccountId, grant.linkedAt],
      )
      if (result.rowCount !== 1) throw new Error('Project repository grant is not authorized.')
    },
    async getRepositoryGrant(input) {
      const result = await pool.query<RepositoryRow>(
        `SELECT tenant_id, project_id, installation_id, repository_id, owner_id, owner_login, repository_name, full_name, is_private, contents_permission, linked_by_account_id, linked_at
         FROM app_github_repository_grant
         WHERE tenant_id = $1 AND project_id = $2 AND invalidated_at IS NULL`,
        [input.tenantId, input.projectId],
      )
      return result.rows[0] ? repositoryFromRow(result.rows[0]) : null
    },
    async getAuthorizedRepositoryAccess(input) {
      const roles = allowedRoles(input.operation)
      const result = await pool.query<RepositoryRow & InstallationRow>(
        `SELECT repository.tenant_id, repository.project_id, repository.installation_id, repository.repository_id,
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
      await pool.query(
        `INSERT INTO app_github_repository_job
          (id, actor_account_id, actor_provider_user_id, tenant_id, project_id, operation, installation_id, repository_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', to_timestamp($9 / 1000.0))`,
        [job.id, job.actor.accountId, job.actor.providerUserId, job.tenantId, job.projectId, job.operation, job.installationId, job.repositoryId, job.createdAt],
      )
    },
    async get(id) {
      const result = await pool.query<JobRow>('SELECT id, actor_account_id, actor_provider_user_id, tenant_id, project_id, operation, installation_id, repository_id, status, created_at FROM app_github_repository_job WHERE id = $1', [id])
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    },
    async markRunning(id) { await pool.query("UPDATE app_github_repository_job SET status = 'running' WHERE id = $1", [id]) },
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
    async enqueue(job) { if (jobs.has(job.id)) throw new Error('Repository job already exists.'); jobs.set(job.id, Object.freeze({ ...job, actor: Object.freeze({ ...job.actor }) })) },
    async get(id) { return jobs.get(id) ?? null },
    async markRunning(id) { const job = jobs.get(id); if (job) jobs.set(id, Object.freeze({ ...job, status: 'running' })) },
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
  return Object.freeze({ digest: row.digest, accountId: row.account_id, tenantId: row.tenant_id, purpose: row.purpose, installationId: row.installation_id, codeVerifierCiphertext: row.code_verifier_ciphertext, expiresAt })
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
  return Object.freeze({
    id: row.id,
    actor: Object.freeze({ accountId: row.actor_account_id, providerUserId: row.actor_provider_user_id }),
    tenantId: row.tenant_id,
    projectId: row.project_id,
    operation: row.operation,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    status: row.status,
    createdAt: timestamp(row.created_at),
  })
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
