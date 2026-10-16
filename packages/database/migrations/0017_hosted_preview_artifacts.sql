CREATE TABLE IF NOT EXISTS app_hosted_preview_artifact (
  artifact_id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  file_revision bigint NOT NULL CHECK (file_revision >= 0),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  registry_fingerprint text NOT NULL CHECK (registry_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  entrypoint text NOT NULL CHECK (
    char_length(entrypoint) BETWEEN 1 AND 256
    AND entrypoint ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND entrypoint !~ '(^|/)\.{1,2}(/|$)'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, file_id)
);

CREATE INDEX IF NOT EXISTS app_hosted_preview_artifact_file_revision_idx
  ON app_hosted_preview_artifact (file_id, file_revision, created_at DESC, artifact_id);
