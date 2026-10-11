ALTER TABLE app_file
  ADD COLUMN IF NOT EXISTS thumbnail_etag text;

ALTER TABLE app_file
  DROP CONSTRAINT IF EXISTS app_file_thumbnail_identity_check;

ALTER TABLE app_file
  ADD CONSTRAINT app_file_thumbnail_identity_check CHECK (
    (thumbnail_key IS NULL AND thumbnail_etag IS NULL)
    OR (thumbnail_key IS NOT NULL AND thumbnail_etag IS NOT NULL AND char_length(thumbnail_etag) BETWEEN 1 AND 512)
  );

ALTER TABLE app_github_installation_state
  ADD COLUMN IF NOT EXISTS purpose text,
  ADD COLUMN IF NOT EXISTS installation_id text,
  ADD COLUMN IF NOT EXISTS code_verifier_ciphertext text;

UPDATE app_github_installation_state SET purpose = 'install-app' WHERE purpose IS NULL;

ALTER TABLE app_github_installation_state
  ALTER COLUMN purpose SET NOT NULL,
  ADD CONSTRAINT app_github_installation_state_purpose_check CHECK (purpose IN ('authorize-user', 'install-app')),
  ADD CONSTRAINT app_github_installation_state_installation_check CHECK (installation_id IS NULL OR installation_id ~ '^[1-9][0-9]{0,31}$');

ALTER TABLE app_github_installation_grant
  ADD COLUMN IF NOT EXISTS contents_permission text NOT NULL DEFAULT 'none';
ALTER TABLE app_github_installation_grant
  ADD CONSTRAINT app_github_installation_contents_permission_check CHECK (contents_permission IN ('none', 'read', 'write'));

ALTER TABLE app_github_repository_grant
  ADD COLUMN IF NOT EXISTS contents_permission text NOT NULL DEFAULT 'none';
ALTER TABLE app_github_repository_grant
  ADD CONSTRAINT app_github_repository_contents_permission_check CHECK (contents_permission IN ('none', 'read', 'write'));

CREATE TABLE IF NOT EXISTS app_github_user_credential (
  account_id text PRIMARY KEY CHECK (char_length(account_id) BETWEEN 1 AND 200),
  provider_user_id text NOT NULL CHECK (provider_user_id ~ '^[1-9][0-9]{0,31}$'),
  access_token_ciphertext text NOT NULL CHECK (char_length(access_token_ciphertext) BETWEEN 16 AND 16384),
  refresh_token_ciphertext text NOT NULL CHECK (char_length(refresh_token_ciphertext) BETWEEN 16 AND 16384),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  token_version bigint NOT NULL DEFAULT 1 CHECK (token_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_github_webhook_delivery
  ADD COLUMN IF NOT EXISTS event_name text,
  ADD COLUMN IF NOT EXISTS body_digest text,
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE app_github_webhook_delivery
SET event_name = COALESCE(event_name, 'legacy'),
    body_digest = COALESCE(body_digest, lpad(md5(delivery_id), 64, '0')),
    lease_id = COALESCE(lease_id, gen_random_uuid()),
    lease_expires_at = COALESCE(lease_expires_at, received_at);

ALTER TABLE app_github_webhook_delivery
  ALTER COLUMN event_name SET NOT NULL,
  ALTER COLUMN body_digest SET NOT NULL,
  ALTER COLUMN lease_id SET NOT NULL,
  ALTER COLUMN lease_expires_at SET NOT NULL,
  ADD CONSTRAINT app_github_webhook_event_name_check CHECK (char_length(event_name) BETWEEN 1 AND 100),
  ADD CONSTRAINT app_github_webhook_body_digest_check CHECK (body_digest ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS app_github_webhook_event_body_idx
  ON app_github_webhook_delivery (event_name, body_digest);

CREATE TABLE IF NOT EXISTS app_github_repository_job (
  id uuid PRIMARY KEY,
  actor_account_id text NOT NULL CHECK (char_length(actor_account_id) BETWEEN 1 AND 200),
  actor_provider_user_id text NOT NULL CHECK (actor_provider_user_id ~ '^[1-9][0-9]{0,31}$'),
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  project_id uuid NOT NULL REFERENCES app_project(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('scan', 'pull', 'prepare-patch', 'write')),
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,31}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,31}$'),
  status text NOT NULL CHECK (status IN ('queued', 'running')),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS app_github_repository_job_project_idx ON app_github_repository_job (project_id, created_at DESC);
