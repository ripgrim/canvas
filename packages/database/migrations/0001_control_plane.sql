CREATE TABLE IF NOT EXISTS app_project (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_project_owner_updated_idx
  ON app_project (owner_user_id, updated_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS app_project_identity_owner_idx
  ON app_project (id, owner_user_id);

CREATE TABLE IF NOT EXISTS app_file (
  id uuid PRIMARY KEY,
  project_id uuid,
  owner_user_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  head_revision bigint NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
  thumbnail_key text CHECK (thumbnail_key IS NULL OR char_length(thumbnail_key) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, owner_user_id) REFERENCES app_project(id, owner_user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS app_file_owner_updated_idx
  ON app_file (owner_user_id, updated_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS app_file_identity_owner_idx
  ON app_file (id, owner_user_id);

CREATE INDEX IF NOT EXISTS app_file_project_owner_updated_idx
  ON app_file (project_id, owner_user_id, updated_at DESC, id)
  WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_file_document (
  file_id uuid PRIMARY KEY,
  owner_user_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (file_id, owner_user_id) REFERENCES app_file(id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_file_document_owner_idx
  ON app_file_document (owner_user_id, file_id);
