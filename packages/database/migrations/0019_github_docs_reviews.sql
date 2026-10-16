CREATE TABLE IF NOT EXISTS app_github_docs_review (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  project_id uuid NOT NULL REFERENCES app_project(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  file_revision bigint NOT NULL CHECK (file_revision >= 0),
  file_document_sha256 text NOT NULL CHECK (file_document_sha256 ~ '^[a-f0-9]{64}$'),
  scan_job_id uuid NOT NULL REFERENCES app_github_repository_job(id) ON DELETE RESTRICT,
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,31}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,31}$'),
  repository_grant_id uuid NOT NULL,
  repository_linked_at timestamptz NOT NULL,
  created_by_account_id text NOT NULL CHECK (char_length(created_by_account_id) BETWEEN 1 AND 128),
  approved_by_account_id text,
  base_ref text NOT NULL CHECK (base_ref ~ '^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$'),
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40}$'),
  base_tree_sha text NOT NULL CHECK (base_tree_sha ~ '^[a-f0-9]{40}$'),
  adapter jsonb NOT NULL CHECK (jsonb_typeof(adapter) = 'object'),
  prepared_bundle jsonb,
  approval_digest text,
  status text NOT NULL CHECK (status IN ('queued_prepare', 'preparing', 'prepared', 'queued_save', 'saving', 'saved', 'stale', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_id uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  error_id text,
  created_at timestamptz NOT NULL,
  prepared_at timestamptz,
  approved_at timestamptz,
  proposed_commit_sha text CHECK (proposed_commit_sha IS NULL OR proposed_commit_sha ~ '^[a-f0-9]{40}$'),
  committed_sha text CHECK (committed_sha IS NULL OR committed_sha ~ '^[a-f0-9]{40}$'),
  completed_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT app_github_docs_review_bundle_check CHECK (
    prepared_bundle IS NULL OR (
      jsonb_typeof(prepared_bundle) = 'object'
      AND octet_length(prepared_bundle::text) <= 5242880
    )
  ),
  CONSTRAINT app_github_docs_review_approval_check CHECK (
    approval_digest IS NULL OR approval_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT app_github_docs_review_state_check CHECK (
    (status = 'queued_prepare' AND prepared_bundle IS NULL AND approval_digest IS NULL AND approved_by_account_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NOT NULL AND prepared_at IS NULL AND approved_at IS NULL AND proposed_commit_sha IS NULL AND committed_sha IS NULL AND completed_at IS NULL AND failed_at IS NULL AND error_id IS NULL)
    OR
    (status = 'preparing' AND prepared_bundle IS NULL AND approval_digest IS NULL AND approved_by_account_id IS NULL AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND next_attempt_at IS NULL AND prepared_at IS NULL AND approved_at IS NULL AND proposed_commit_sha IS NULL AND committed_sha IS NULL AND completed_at IS NULL AND failed_at IS NULL AND error_id IS NULL)
    OR
    (status = 'prepared' AND prepared_bundle IS NOT NULL AND approval_digest IS NOT NULL AND approved_by_account_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NULL AND prepared_at IS NOT NULL AND approved_at IS NULL AND proposed_commit_sha IS NULL AND committed_sha IS NULL AND completed_at IS NULL AND failed_at IS NULL AND error_id IS NULL)
    OR
    (status = 'queued_save' AND prepared_bundle IS NOT NULL AND approval_digest IS NOT NULL AND approved_by_account_id IS NOT NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NOT NULL AND prepared_at IS NOT NULL AND approved_at IS NOT NULL AND proposed_commit_sha IS NULL AND committed_sha IS NULL AND completed_at IS NULL AND failed_at IS NULL AND error_id IS NULL)
    OR
    (status = 'saving' AND prepared_bundle IS NOT NULL AND approval_digest IS NOT NULL AND approved_by_account_id IS NOT NULL AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND next_attempt_at IS NULL AND prepared_at IS NOT NULL AND approved_at IS NOT NULL AND committed_sha IS NULL AND completed_at IS NULL AND failed_at IS NULL AND error_id IS NULL)
    OR
    (status = 'saved' AND prepared_bundle IS NOT NULL AND approval_digest IS NOT NULL AND approved_by_account_id IS NOT NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NULL AND prepared_at IS NOT NULL AND approved_at IS NOT NULL AND proposed_commit_sha IS NOT NULL AND committed_sha = proposed_commit_sha AND completed_at IS NOT NULL AND failed_at IS NULL AND error_id IS NULL)
    OR
    (status IN ('stale', 'failed') AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NULL AND error_id ~ '^[a-z0-9-]{3,64}$' AND completed_at IS NULL AND failed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS app_github_docs_review_claim_idx
  ON app_github_docs_review (status, next_attempt_at, lease_expires_at, created_at, id);

CREATE INDEX IF NOT EXISTS app_github_docs_review_file_idx
  ON app_github_docs_review (file_id, created_at DESC, id);
