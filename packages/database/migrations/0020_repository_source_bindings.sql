ALTER TABLE app_github_repository_grant
  ADD COLUMN IF NOT EXISTS grant_generation bigint NOT NULL DEFAULT 1;

ALTER TABLE app_github_repository_grant
  DROP CONSTRAINT IF EXISTS app_github_repository_grant_generation_check;
ALTER TABLE app_github_repository_grant
  ADD CONSTRAINT app_github_repository_grant_generation_check
  CHECK (grant_generation BETWEEN 1 AND 9223372036854775807);

ALTER TABLE app_github_repository_job
  ADD COLUMN IF NOT EXISTS repository_grant_generation bigint;

UPDATE app_github_repository_job AS job
SET repository_grant_generation = COALESCE(repository.grant_generation, 1)
FROM app_github_repository_grant AS repository
WHERE job.project_id = repository.project_id
  AND job.repository_grant_generation IS NULL;

UPDATE app_github_repository_job
SET repository_grant_generation = 1
WHERE repository_grant_generation IS NULL;

ALTER TABLE app_github_repository_job
  ALTER COLUMN repository_grant_generation SET NOT NULL;
ALTER TABLE app_github_repository_job
  DROP CONSTRAINT IF EXISTS app_github_repository_job_grant_generation_check;
ALTER TABLE app_github_repository_job
  ADD CONSTRAINT app_github_repository_job_grant_generation_check
  CHECK (repository_grant_generation BETWEEN 1 AND 9223372036854775807);

CREATE TABLE IF NOT EXISTS app_github_repository_source_binding (
  project_id uuid PRIMARY KEY REFERENCES app_project(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  installation_id text NOT NULL,
  repository_id text NOT NULL,
  repository_linked_at timestamptz NOT NULL,
  repository_grant_id uuid NOT NULL,
  repository_grant_generation bigint NOT NULL,
  scan_job_id uuid NOT NULL REFERENCES app_github_repository_job(id) ON DELETE RESTRICT,
  source_revision text NOT NULL,
  registry_fingerprint text NOT NULL,
  authority jsonb NOT NULL,
  version bigint NOT NULL,
  records jsonb NOT NULL,
  canonical_digest text NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, tenant_id) REFERENCES app_project(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT app_github_repository_source_binding_generation_check CHECK (repository_grant_generation BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT app_github_repository_source_binding_version_check CHECK (version BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT app_github_repository_source_binding_revision_check CHECK (source_revision ~ '^[a-f0-9]{40}$'),
  CONSTRAINT app_github_repository_source_binding_registry_check CHECK (registry_fingerprint ~ '^sha256:[a-f0-9]{64}$' OR registry_fingerprint ~ '^sha256-[A-Za-z0-9+/]{43}=$'),
  CONSTRAINT app_github_repository_source_binding_authority_check CHECK (jsonb_typeof(authority) = 'object' AND octet_length(authority::text) <= 16384),
  CONSTRAINT app_github_repository_source_binding_records_check CHECK (jsonb_typeof(records) = 'array' AND jsonb_array_length(records) <= 10000 AND octet_length(records::text) <= 10485760),
  CONSTRAINT app_github_repository_source_binding_digest_check CHECK (canonical_digest ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS app_github_repository_source_binding_lineage_idx
  ON app_github_repository_source_binding (tenant_id, repository_id, repository_grant_generation, scan_job_id);
