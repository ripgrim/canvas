CREATE TABLE IF NOT EXISTS app_project_member (
  project_id uuid NOT NULL REFERENCES app_project(id) ON DELETE CASCADE,
  user_id text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'reviewer', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

INSERT INTO app_project_member (project_id, user_id, role)
SELECT id, owner_user_id, 'owner'
FROM app_project
ON CONFLICT (project_id, user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS app_project_member_user_idx
  ON app_project_member (user_id, project_id);

CREATE TABLE IF NOT EXISTS app_github_installation_state (
  digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 200),
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_github_installation_state_expiry_idx
  ON app_github_installation_state (expires_at);

CREATE TABLE IF NOT EXISTS app_github_installation_grant (
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,31}$'),
  account_id text NOT NULL CHECK (account_id ~ '^[1-9][0-9]{0,31}$'),
  account_login text NOT NULL CHECK (char_length(account_login) BETWEEN 1 AND 39),
  account_type text NOT NULL CHECK (account_type IN ('Organization', 'User')),
  connected_by_account_id text NOT NULL CHECK (char_length(connected_by_account_id) BETWEEN 1 AND 200),
  connected_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text CHECK (invalidation_reason IS NULL OR invalidation_reason IN ('deleted', 'suspended')),
  PRIMARY KEY (tenant_id, installation_id),
  CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS app_github_installation_grant_installation_idx
  ON app_github_installation_grant (installation_id);

CREATE TABLE IF NOT EXISTS app_github_repository_grant (
  project_id uuid PRIMARY KEY REFERENCES app_project(id) ON DELETE CASCADE,
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,31}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,31}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[1-9][0-9]{0,31}$'),
  owner_login text NOT NULL CHECK (char_length(owner_login) BETWEEN 1 AND 39),
  repository_name text NOT NULL CHECK (char_length(repository_name) BETWEEN 1 AND 100),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 140),
  is_private boolean NOT NULL,
  linked_by_account_id text NOT NULL CHECK (char_length(linked_by_account_id) BETWEEN 1 AND 200),
  linked_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text CHECK (invalidation_reason IS NULL OR invalidation_reason IN ('installation_deleted', 'installation_suspended', 'removed')),
  FOREIGN KEY (tenant_id, installation_id)
    REFERENCES app_github_installation_grant(tenant_id, installation_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, tenant_id)
    REFERENCES app_project(id, owner_user_id) ON DELETE CASCADE,
  CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS app_github_repository_grant_installation_repo_idx
  ON app_github_repository_grant (installation_id, repository_id);

CREATE TABLE IF NOT EXISTS app_github_webhook_delivery (
  delivery_id text PRIMARY KEY CHECK (char_length(delivery_id) BETWEEN 8 AND 128),
  status text NOT NULL CHECK (status IN ('claimed', 'completed')),
  received_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((status = 'claimed' AND completed_at IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS app_github_webhook_delivery_received_idx
  ON app_github_webhook_delivery (received_at);
