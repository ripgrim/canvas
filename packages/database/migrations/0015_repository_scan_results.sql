ALTER TABLE app_github_repository_job
  DROP CONSTRAINT IF EXISTS app_github_repository_job_status_check,
  DROP CONSTRAINT IF EXISTS app_github_repository_job_lease_check,
  ADD COLUMN IF NOT EXISTS source_revision text,
  ADD COLUMN IF NOT EXISTS scan_result jsonb,
  ADD COLUMN IF NOT EXISTS registry_request jsonb,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE app_github_repository_job
  ADD CONSTRAINT app_github_repository_job_status_check CHECK (status IN ('queued', 'running', 'completed')),
  ADD CONSTRAINT app_github_repository_job_result_check CHECK (
    (status = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL AND source_revision IS NULL AND scan_result IS NULL AND registry_request IS NULL AND completed_at IS NULL)
    OR
    (status = 'running' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND source_revision IS NULL AND scan_result IS NULL AND registry_request IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND lease_id IS NULL AND lease_expires_at IS NULL AND source_revision ~ '^[a-f0-9]{40}$' AND jsonb_typeof(scan_result) = 'object' AND jsonb_typeof(registry_request) = 'object' AND completed_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS app_github_repository_job_completed_idx
  ON app_github_repository_job (project_id, completed_at DESC)
  WHERE status = 'completed';
