CREATE TABLE IF NOT EXISTS app_hosted_preview_build_job (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL CHECK (char_length(owner_user_id) BETWEEN 1 AND 128),
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  file_revision bigint NOT NULL CHECK (file_revision >= 0),
  project_id uuid NOT NULL REFERENCES app_project(id) ON DELETE CASCADE,
  scan_job_id uuid NOT NULL REFERENCES app_github_repository_job(id) ON DELETE RESTRICT,
  artifact_id uuid NOT NULL UNIQUE,
  staging_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  error_id text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT app_hosted_preview_build_job_state_check CHECK (
    (status = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NOT NULL AND error_id IS NULL AND completed_at IS NULL AND failed_at IS NULL)
    OR
    (status = 'leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND next_attempt_at IS NULL AND error_id IS NULL AND completed_at IS NULL AND failed_at IS NULL)
    OR
    (status = 'completed' AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NULL AND error_id IS NULL AND completed_at IS NOT NULL AND failed_at IS NULL)
    OR
    (status = 'failed' AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NULL AND error_id ~ '^[a-z0-9-]{3,64}$' AND completed_at IS NULL AND failed_at IS NOT NULL)
  ),
  UNIQUE (file_id, file_revision, scan_job_id)
);

CREATE INDEX IF NOT EXISTS app_hosted_preview_build_job_claim_idx
  ON app_hosted_preview_build_job (status, next_attempt_at, lease_expires_at, created_at, id);

CREATE INDEX IF NOT EXISTS app_hosted_preview_build_job_file_idx
  ON app_hosted_preview_build_job (file_id, created_at DESC, id);
