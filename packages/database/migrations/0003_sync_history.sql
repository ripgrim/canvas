CREATE TABLE IF NOT EXISTS app_file_edit_batch (
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 128),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 128),
  client_mutation_id text NOT NULL CHECK (char_length(client_mutation_id) BETWEEN 1 AND 128),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  server_revision bigint NOT NULL CHECK (server_revision = base_revision + 1),
  edits jsonb NOT NULL CHECK (jsonb_typeof(edits) = 'array' AND jsonb_array_length(edits) BETWEEN 1 AND 256),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, server_revision),
  UNIQUE (file_id, subject_id, client_mutation_id)
);

CREATE INDEX IF NOT EXISTS app_file_edit_batch_catchup_idx
  ON app_file_edit_batch (file_id, server_revision ASC);
