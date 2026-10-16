ALTER TABLE app_github_repository_job
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE app_github_repository_job
SET status = 'queued', lease_id = NULL, lease_expires_at = NULL
WHERE status = 'running';

ALTER TABLE app_github_repository_job
  ADD CONSTRAINT app_github_repository_job_attempt_check CHECK (attempt >= 0),
  ADD CONSTRAINT app_github_repository_job_lease_check CHECK (
    (status = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL)
    OR
    (status = 'running' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS app_github_repository_job_claim_idx
  ON app_github_repository_job (operation, status, lease_expires_at, created_at);
