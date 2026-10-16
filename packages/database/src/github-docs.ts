import type { RepositoryDocsReview, RepositoryDocsReviewCreate, RepositoryDocsReviewStore } from '@canvas/github-app'
import type { Pool, QueryResultRow } from 'pg'

type ReviewRow = QueryResultRow & Readonly<{
  id: string
  tenant_id: string
  project_id: string
  file_id: string
  file_revision: string | number
  file_document_sha256: string
  scan_job_id: string
  installation_id: string
  repository_id: string
  repository_grant_id: string
  repository_linked_at_ms: string | number
  created_by_account_id: string
  approved_by_account_id: string | null
  base_ref: string
  base_commit_sha: string
  base_tree_sha: string
  adapter: unknown
  prepared_bundle: unknown
  approval_digest: string | null
  status: RepositoryDocsReview['status']
  attempt: number
  lease_id: string | null
  lease_expires_at_ms: string | number | null
  next_attempt_at_ms: string | number | null
  error_id: string | null
  created_at_ms: string | number
  prepared_at_ms: string | number | null
  approved_at_ms: string | number | null
  proposed_commit_sha: string | null
  committed_sha: string | null
  completed_at_ms: string | number | null
  failed_at_ms: string | number | null
}>

const columns = `review.id, review.tenant_id, review.project_id, review.file_id, review.file_revision, review.file_document_sha256,
  review.scan_job_id, review.installation_id, review.repository_id, review.repository_grant_id,
  floor(extract(epoch FROM review.repository_linked_at) * 1000)::bigint AS repository_linked_at_ms,
  review.created_by_account_id, review.approved_by_account_id, review.base_ref, review.base_commit_sha, review.base_tree_sha,
  review.adapter, review.prepared_bundle, review.approval_digest, review.status, review.attempt, review.lease_id,
  CASE WHEN review.lease_expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM review.lease_expires_at) * 1000)::bigint END AS lease_expires_at_ms,
  CASE WHEN review.next_attempt_at IS NULL THEN NULL ELSE floor(extract(epoch FROM review.next_attempt_at) * 1000)::bigint END AS next_attempt_at_ms,
  review.error_id, floor(extract(epoch FROM review.created_at) * 1000)::bigint AS created_at_ms,
  CASE WHEN review.prepared_at IS NULL THEN NULL ELSE floor(extract(epoch FROM review.prepared_at) * 1000)::bigint END AS prepared_at_ms,
  CASE WHEN review.approved_at IS NULL THEN NULL ELSE floor(extract(epoch FROM review.approved_at) * 1000)::bigint END AS approved_at_ms,
  review.proposed_commit_sha, review.committed_sha,
  CASE WHEN review.completed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM review.completed_at) * 1000)::bigint END AS completed_at_ms,
  CASE WHEN review.failed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM review.failed_at) * 1000)::bigint END AS failed_at_ms`

export function createPostgresRepositoryDocsReviewStore(pool: Pool): RepositoryDocsReviewStore {
  const store: RepositoryDocsReviewStore = {
    async enqueuePrepare(input) {
      const result = await pool.query<ReviewRow>(
        `INSERT INTO app_github_docs_review (
          id, tenant_id, project_id, file_id, file_revision, file_document_sha256, scan_job_id,
          installation_id, repository_id, repository_grant_id, repository_linked_at, created_by_account_id,
          base_ref, base_commit_sha, base_tree_sha, adapter, status, attempt, next_attempt_at, created_at
        )
        SELECT $1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7::uuid,
          $8, $9, $10::uuid, to_timestamp($11 / 1000.0), $12,
          $13, $14, $15, $16::jsonb, 'queued_prepare', 0, to_timestamp($17 / 1000.0), to_timestamp($17 / 1000.0)
        FROM app_file AS file
        JOIN app_project_member AS member ON member.project_id = file.project_id AND member.user_id = $12
        JOIN app_github_repository_job AS scan ON scan.id = $7::uuid
        JOIN app_github_repository_grant AS repository
          ON repository.tenant_id = $2 AND repository.project_id = $3::uuid
         AND repository.installation_id = $8 AND repository.repository_id = $9
         AND repository.grant_id = $10::uuid AND repository.linked_at = to_timestamp($11 / 1000.0)
        JOIN app_github_installation_grant AS installation
          ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
        WHERE file.id = $4::uuid AND file.project_id = $3::uuid AND file.head_revision = $5
          AND member.role IN ('owner', 'editor', 'reviewer')
          AND scan.operation = 'scan' AND scan.status = 'completed' AND scan.tenant_id = $2 AND scan.project_id = $3::uuid
          AND scan.installation_id = $8 AND scan.repository_id = $9 AND scan.repository_grant_id = $10::uuid
          AND scan.repository_linked_at = to_timestamp($11 / 1000.0) AND scan.source_revision = $14
          AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
        RETURNING ${columns.replaceAll('review.', 'app_github_docs_review.')}`,
        [input.id, input.tenantId, input.projectId, input.fileId, input.fileRevision, input.fileDocumentSha256, input.scanJobId, input.installationId, input.repositoryId, input.repositoryGrantId, input.repositoryLinkedAt, input.createdByAccountId, input.baseRef, input.baseCommitSha, input.baseTreeSha, JSON.stringify(input.adapter), input.createdAt],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Documentation review is not authorized.')
      return reviewFromRow(row)
    },
    async get(id) {
      const result = await pool.query<ReviewRow>(`SELECT ${columns} FROM app_github_docs_review AS review WHERE review.id = $1::uuid`, [id])
      return result.rows[0] ? reviewFromRow(result.rows[0]) : null
    },
    async getAuthorized(id, actorAccountId) {
      const result = await pool.query<ReviewRow>(
        `SELECT ${columns}
         FROM app_github_docs_review AS review
         JOIN app_project_member AS member ON member.project_id = review.project_id AND member.user_id = $2
         JOIN app_github_repository_grant AS repository
           ON repository.tenant_id = review.tenant_id AND repository.project_id = review.project_id
          AND repository.installation_id = review.installation_id AND repository.repository_id = review.repository_id
          AND repository.grant_id = review.repository_grant_id AND repository.linked_at = review.repository_linked_at
         JOIN app_github_installation_grant AS installation
           ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
         WHERE review.id = $1::uuid AND member.role IN ('owner', 'editor', 'reviewer')
           AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL`,
        [id, actorAccountId],
      )
      return result.rows[0] ? reviewFromRow(result.rows[0]) : null
    },
    async getLatestAuthorized(projectId, fileId, actorAccountId) {
      const result = await pool.query<ReviewRow>(
        `SELECT ${columns}
         FROM app_github_docs_review AS review
         JOIN app_project_member AS member ON member.project_id = review.project_id AND member.user_id = $3
         JOIN app_github_repository_grant AS repository
           ON repository.tenant_id = review.tenant_id AND repository.project_id = review.project_id
          AND repository.installation_id = review.installation_id AND repository.repository_id = review.repository_id
          AND repository.grant_id = review.repository_grant_id AND repository.linked_at = review.repository_linked_at
         JOIN app_github_installation_grant AS installation
           ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
         WHERE review.project_id = $1::uuid AND review.file_id = $2::uuid
           AND member.role IN ('owner', 'editor', 'reviewer')
           AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
         ORDER BY review.created_at DESC, review.id DESC LIMIT 1`,
        [projectId, fileId, actorAccountId],
      )
      return result.rows[0] ? reviewFromRow(result.rows[0]) : null
    },
    async claimNextPrepare(input) {
      const result = await pool.query<ReviewRow>(
        `WITH candidate AS (
           SELECT review.id
           FROM app_github_docs_review AS review
           JOIN app_project_member AS member ON member.project_id = review.project_id AND member.user_id = review.created_by_account_id
           JOIN app_github_repository_grant AS repository
             ON repository.tenant_id = review.tenant_id AND repository.project_id = review.project_id
            AND repository.installation_id = review.installation_id AND repository.repository_id = review.repository_id
            AND repository.grant_id = review.repository_grant_id AND repository.linked_at = review.repository_linked_at
           JOIN app_github_installation_grant AS installation
             ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
           WHERE ((review.status = 'queued_prepare' AND review.next_attempt_at <= to_timestamp($2 / 1000.0))
             OR (review.status = 'preparing' AND review.lease_expires_at <= to_timestamp($2 / 1000.0)))
             AND member.role IN ('owner', 'editor', 'reviewer')
             AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
           ORDER BY review.created_at, review.id FOR UPDATE OF review SKIP LOCKED LIMIT 1
         )
         UPDATE app_github_docs_review AS review
         SET status = 'preparing', lease_id = $1::uuid, lease_expires_at = to_timestamp($3 / 1000.0),
             next_attempt_at = NULL, attempt = attempt + 1
         FROM candidate WHERE review.id = candidate.id
         RETURNING ${columns}`,
        [input.leaseId, input.now, input.leaseExpiresAt],
      )
      return result.rows[0] ? reviewFromRow(result.rows[0]) : null
    },
    async isCurrentLease(input) {
      const result = await pool.query(
        `SELECT 1 FROM app_github_docs_review AS review
         JOIN app_project_member AS member ON member.project_id = review.project_id
          AND member.user_id = CASE WHEN review.status = 'preparing' THEN review.created_by_account_id ELSE review.approved_by_account_id END
         JOIN app_github_repository_grant AS repository
           ON repository.tenant_id = review.tenant_id AND repository.project_id = review.project_id
          AND repository.installation_id = review.installation_id AND repository.repository_id = review.repository_id
          AND repository.grant_id = review.repository_grant_id AND repository.linked_at = review.repository_linked_at
         JOIN app_github_installation_grant AS installation
           ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
         WHERE review.id = $1::uuid AND review.status = $2 AND review.lease_id = $3::uuid AND review.lease_expires_at > to_timestamp($4 / 1000.0)
           AND (review.status = 'preparing' AND member.role IN ('owner', 'editor', 'reviewer')
             OR review.status = 'saving' AND member.role IN ('owner', 'editor') AND repository.contents_permission = 'write' AND installation.contents_permission = 'write')
           AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL`,
        [input.id, input.status, input.leaseId, input.now],
      )
      return result.rowCount === 1
    },
    async completePrepare(input) {
      const result = await pool.query(
        `UPDATE app_github_docs_review AS review
         SET status = 'prepared', prepared_bundle = $4::jsonb, approval_digest = $5,
             prepared_at = to_timestamp($3 / 1000.0), lease_id = NULL, lease_expires_at = NULL
         WHERE review.id = $1::uuid AND review.status = 'preparing' AND review.lease_id = $2::uuid
           AND review.lease_expires_at > to_timestamp($3 / 1000.0)
           AND EXISTS (
             SELECT 1 FROM app_project_member AS member
             JOIN app_github_repository_grant AS repository
               ON repository.tenant_id = review.tenant_id AND repository.project_id = review.project_id
              AND repository.installation_id = review.installation_id AND repository.repository_id = review.repository_id
              AND repository.grant_id = review.repository_grant_id AND repository.linked_at = review.repository_linked_at
             JOIN app_github_installation_grant AS installation
               ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
             WHERE member.project_id = review.project_id AND member.user_id = review.created_by_account_id
               AND member.role IN ('owner', 'editor', 'reviewer')
               AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
           )`,
        [input.id, input.leaseId, input.now, JSON.stringify(input.preparedBundle), input.approvalDigest],
      )
      return result.rowCount === 1
    },
    async approveSave(input) {
      const result = await pool.query(
        `UPDATE app_github_docs_review AS review
         SET status = 'queued_save', approved_by_account_id = $2, approved_at = to_timestamp($4 / 1000.0), next_attempt_at = to_timestamp($4 / 1000.0)
         WHERE review.id = $1::uuid AND review.status = 'prepared' AND review.approval_digest = $3
           AND EXISTS (
             SELECT 1 FROM app_file AS file
             JOIN app_project_member AS member ON member.project_id = file.project_id AND member.user_id = $2
             JOIN app_github_repository_grant AS repository
               ON repository.tenant_id = review.tenant_id AND repository.project_id = review.project_id
              AND repository.installation_id = review.installation_id AND repository.repository_id = review.repository_id
              AND repository.grant_id = review.repository_grant_id AND repository.linked_at = review.repository_linked_at
             JOIN app_github_installation_grant AS installation
               ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
             WHERE file.id = review.file_id AND file.project_id = review.project_id AND file.head_revision = review.file_revision
               AND member.role IN ('owner', 'editor')
               AND repository.contents_permission = 'write' AND installation.contents_permission = 'write'
               AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
           )`,
        [input.id, input.actorAccountId, input.approvalDigest, input.now],
      )
      return result.rowCount === 1
    },
    async claimNextSave(input) {
      const result = await pool.query<ReviewRow>(
        `WITH candidate AS (
           SELECT review.id
           FROM app_github_docs_review AS review
           JOIN app_project_member AS member ON member.project_id = review.project_id AND member.user_id = review.approved_by_account_id
           JOIN app_github_repository_grant AS repository
             ON repository.tenant_id = review.tenant_id AND repository.project_id = review.project_id
            AND repository.installation_id = review.installation_id AND repository.repository_id = review.repository_id
            AND repository.grant_id = review.repository_grant_id AND repository.linked_at = review.repository_linked_at
           JOIN app_github_installation_grant AS installation
             ON installation.tenant_id = repository.tenant_id AND installation.installation_id = repository.installation_id
           WHERE ((review.status = 'queued_save' AND review.next_attempt_at <= to_timestamp($2 / 1000.0))
             OR (review.status = 'saving' AND review.lease_expires_at <= to_timestamp($2 / 1000.0)))
             AND member.role IN ('owner', 'editor')
             AND repository.contents_permission = 'write' AND installation.contents_permission = 'write'
             AND repository.invalidated_at IS NULL AND installation.invalidated_at IS NULL
           ORDER BY review.approved_at, review.id FOR UPDATE OF review SKIP LOCKED LIMIT 1
         )
         UPDATE app_github_docs_review AS review
         SET status = 'saving', lease_id = $1::uuid, lease_expires_at = to_timestamp($3 / 1000.0),
             next_attempt_at = NULL, attempt = attempt + 1
         FROM candidate WHERE review.id = candidate.id
         RETURNING ${columns}`,
        [input.leaseId, input.now, input.leaseExpiresAt],
      )
      return result.rows[0] ? reviewFromRow(result.rows[0]) : null
    },
    async setProposedCommit(input) {
      const result = await pool.query(
        `UPDATE app_github_docs_review
         SET proposed_commit_sha = $4
         WHERE id = $1::uuid AND status = 'saving' AND lease_id = $2::uuid
           AND lease_expires_at > to_timestamp($3 / 1000.0)
           AND (proposed_commit_sha IS NULL OR proposed_commit_sha = $4)`,
        [input.id, input.leaseId, input.now, input.proposedCommitSha],
      )
      return result.rowCount === 1
    },
    async completeSave(input) {
      const result = await pool.query(
        `UPDATE app_github_docs_review
         SET status = 'saved', committed_sha = $4, completed_at = to_timestamp($3 / 1000.0),
             lease_id = NULL, lease_expires_at = NULL
         WHERE id = $1::uuid AND status = 'saving' AND lease_id = $2::uuid
           AND lease_expires_at > to_timestamp($3 / 1000.0) AND proposed_commit_sha = $4`,
        [input.id, input.leaseId, input.now, input.committedSha],
      )
      return result.rowCount === 1
    },
    async markTerminal(input) {
      const result = await pool.query(
        `UPDATE app_github_docs_review
         SET status = $3, error_id = $4, failed_at = to_timestamp($5 / 1000.0), lease_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL
         WHERE id = $1::uuid AND lease_id = $2::uuid AND status IN ('preparing', 'saving')`,
        [input.id, input.leaseId, input.status, input.errorId, input.now],
      )
      return result.rowCount === 1
    },
  }
  return Object.freeze(store)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Database returned an invalid documentation review.')
  return Object.freeze(value as Record<string, unknown>)
}

function time(value: string | number | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('Database returned an invalid documentation review timestamp.')
  return parsed
}

function reviewFromRow(row: ReviewRow): RepositoryDocsReview {
  const fileRevision = Number(row.file_revision)
  if (!Number.isSafeInteger(fileRevision) || fileRevision < 0) throw new Error('Database returned an invalid documentation review revision.')
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    fileId: row.file_id,
    fileRevision,
    fileDocumentSha256: row.file_document_sha256,
    scanJobId: row.scan_job_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    repositoryGrantId: row.repository_grant_id,
    repositoryLinkedAt: time(row.repository_linked_at_ms)!,
    createdByAccountId: row.created_by_account_id,
    approvedByAccountId: row.approved_by_account_id,
    baseRef: row.base_ref,
    baseCommitSha: row.base_commit_sha,
    baseTreeSha: row.base_tree_sha,
    adapter: record(row.adapter),
    preparedBundle: row.prepared_bundle === null ? null : record(row.prepared_bundle),
    approvalDigest: row.approval_digest,
    status: row.status,
    attempt: row.attempt,
    leaseId: row.lease_id,
    leaseExpiresAt: time(row.lease_expires_at_ms),
    nextAttemptAt: time(row.next_attempt_at_ms),
    errorId: row.error_id,
    createdAt: time(row.created_at_ms)!,
    preparedAt: time(row.prepared_at_ms),
    approvedAt: time(row.approved_at_ms),
    proposedCommitSha: row.proposed_commit_sha,
    committedSha: row.committed_sha,
    completedAt: time(row.completed_at_ms),
    failedAt: time(row.failed_at_ms),
  })
}
