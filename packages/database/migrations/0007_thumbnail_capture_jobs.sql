CREATE TABLE IF NOT EXISTS app_thumbnail_capture_job (
  id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0),
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'completed')),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (file_id, revision),
  CHECK (
    (status = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (status = 'leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND lease_id IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS app_thumbnail_capture_job_claim_idx
  ON app_thumbnail_capture_job (status, lease_expires_at, created_at, id);

INSERT INTO app_thumbnail_capture_job (id, file_id, revision, status)
SELECT gen_random_uuid(), id, head_revision, 'queued'
FROM app_file
ON CONFLICT (file_id, revision) DO NOTHING;
