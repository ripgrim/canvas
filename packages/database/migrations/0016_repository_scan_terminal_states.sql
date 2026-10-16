ALTER TABLE app_github_repository_job
  DROP CONSTRAINT IF EXISTS app_github_repository_job_status_check,
  DROP CONSTRAINT IF EXISTS app_github_repository_job_result_check,
  DROP CONSTRAINT IF EXISTS app_github_repository_job_lease_check,
  ADD COLUMN IF NOT EXISTS repository_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_id text,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

ALTER TABLE app_github_repository_grant
  ADD COLUMN IF NOT EXISTS grant_id uuid;

UPDATE app_github_repository_grant
SET grant_id = gen_random_uuid()
WHERE grant_id IS NULL;

ALTER TABLE app_github_repository_grant
  ALTER COLUMN grant_id SET NOT NULL,
  ADD CONSTRAINT app_github_repository_grant_id_unique UNIQUE (grant_id);

ALTER TABLE app_github_repository_job
  ADD COLUMN IF NOT EXISTS repository_grant_id uuid;

UPDATE app_github_repository_job AS job
SET repository_linked_at = repository.linked_at
FROM app_github_repository_grant AS repository
WHERE repository.project_id = job.project_id AND job.repository_linked_at IS NULL;

UPDATE app_github_repository_job AS job
SET repository_grant_id = repository.grant_id
FROM app_github_repository_grant AS repository
WHERE repository.project_id = job.project_id AND job.repository_grant_id IS NULL;

UPDATE app_github_repository_job
SET next_attempt_at = created_at
WHERE status = 'queued' AND next_attempt_at IS NULL;

ALTER TABLE app_github_repository_job
  ALTER COLUMN repository_linked_at SET NOT NULL,
  ALTER COLUMN repository_grant_id SET NOT NULL,
  ADD CONSTRAINT app_github_repository_job_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  ADD CONSTRAINT app_github_repository_job_result_check CHECK (
    (status = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NOT NULL AND source_revision IS NULL AND scan_result IS NULL AND registry_request IS NULL AND completed_at IS NULL AND error_id IS NULL AND failed_at IS NULL)
    OR
    (status = 'running' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND next_attempt_at IS NULL AND source_revision IS NULL AND scan_result IS NULL AND registry_request IS NULL AND completed_at IS NULL AND error_id IS NULL AND failed_at IS NULL)
    OR
    (status = 'completed' AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NULL AND source_revision ~ '^[a-f0-9]{40}$' AND jsonb_typeof(scan_result) = 'object' AND jsonb_typeof(registry_request) = 'object' AND completed_at IS NOT NULL AND error_id IS NULL AND failed_at IS NULL)
    OR
    (status = 'failed' AND lease_id IS NULL AND lease_expires_at IS NULL AND next_attempt_at IS NULL AND source_revision IS NULL AND scan_result IS NULL AND registry_request IS NULL AND completed_at IS NULL AND error_id ~ '^[a-z0-9-]{3,64}$' AND failed_at IS NOT NULL)
  );

DROP INDEX IF EXISTS app_github_repository_job_claim_idx;
CREATE INDEX app_github_repository_job_claim_idx
  ON app_github_repository_job (operation, status, next_attempt_at, lease_expires_at, created_at);
