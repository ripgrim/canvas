CREATE TABLE IF NOT EXISTS app_file_share (
  file_id uuid PRIMARY KEY,
  owner_user_id text NOT NULL,
  access text NOT NULL CHECK (access IN ('private', 'view')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (file_id, owner_user_id) REFERENCES app_file(id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_file_share_public_idx
  ON app_file_share (file_id)
  WHERE access = 'view';
