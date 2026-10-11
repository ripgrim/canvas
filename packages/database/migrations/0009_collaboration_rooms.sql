CREATE TABLE IF NOT EXISTS app_collaboration_generation (
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL,
  protocol_epoch integer NOT NULL CHECK (protocol_epoch > 0),
  status text NOT NULL CHECK (status IN ('candidate', 'active', 'draining', 'released', 'expired', 'failed')),
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  ended_at timestamptz,
  PRIMARY KEY (file_id, generation_id),
  UNIQUE (file_id, generation_id, fencing_token),
  UNIQUE (file_id, generation_id, protocol_epoch, fencing_token),
  CHECK (
    (status = 'candidate' AND fencing_token IS NULL AND activated_at IS NULL AND ended_at IS NULL)
    OR (status IN ('active', 'draining') AND fencing_token IS NOT NULL AND activated_at IS NOT NULL AND ended_at IS NULL)
    OR (status IN ('released', 'expired', 'failed') AND ended_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS app_collaboration_generation_file_created_idx
  ON app_collaboration_generation (file_id, created_at DESC, generation_id);

CREATE TABLE IF NOT EXISTS app_collaboration_lease (
  file_id uuid PRIMARY KEY REFERENCES app_file(id) ON DELETE CASCADE,
  active_generation_id uuid,
  protocol_epoch integer CHECK (protocol_epoch IS NULL OR protocol_epoch > 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at timestamptz,
  renewed_at timestamptz,
  FOREIGN KEY (file_id, active_generation_id, protocol_epoch, fencing_token)
    REFERENCES app_collaboration_generation(file_id, generation_id, protocol_epoch, fencing_token)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (active_generation_id IS NULL AND protocol_epoch IS NULL AND lease_expires_at IS NULL AND renewed_at IS NULL)
    OR (active_generation_id IS NOT NULL AND protocol_epoch IS NOT NULL AND lease_expires_at IS NOT NULL AND renewed_at IS NOT NULL AND fencing_token > 0)
  )
);

CREATE TABLE IF NOT EXISTS app_collaboration_projection (
  file_id uuid PRIMARY KEY REFERENCES app_file(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  document_schema_version integer NOT NULL CHECK (document_schema_version > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_digest text NOT NULL CHECK (document_digest ~ '^[0-9a-f]{64}$'),
  generation_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (file_id, generation_id, fencing_token)
    REFERENCES app_collaboration_generation(file_id, generation_id, fencing_token)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS app_collaboration_operation (
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  generation_id uuid NOT NULL,
  protocol_epoch integer NOT NULL CHECK (protocol_epoch > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 128),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 128),
  client_mutation_id text NOT NULL CHECK (char_length(client_mutation_id) BETWEEN 1 AND 128),
  operation_type text NOT NULL CHECK (char_length(operation_type) BETWEEN 1 AND 128),
  operation_payload jsonb NOT NULL CHECK (jsonb_typeof(operation_payload) = 'object'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, sequence),
  UNIQUE (file_id, client_id, client_mutation_id),
  FOREIGN KEY (file_id, generation_id, protocol_epoch, fencing_token)
    REFERENCES app_collaboration_generation(file_id, generation_id, protocol_epoch, fencing_token)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS app_collaboration_operation_catchup_idx
  ON app_collaboration_operation (file_id, sequence ASC);

CREATE TABLE IF NOT EXISTS app_collaboration_checkpoint (
  file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
  checkpoint_sequence bigint NOT NULL CHECK (checkpoint_sequence >= 0),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  object_digest text NOT NULL CHECK (object_digest ~ '^[0-9a-f]{64}$'),
  document_digest text NOT NULL CHECK (document_digest ~ '^[0-9a-f]{64}$'),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes > 0),
  document_schema_version integer NOT NULL CHECK (document_schema_version > 0),
  generation_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, checkpoint_sequence),
  UNIQUE (object_key),
  FOREIGN KEY (file_id, generation_id, fencing_token)
    REFERENCES app_collaboration_generation(file_id, generation_id, fencing_token)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS app_collaboration_checkpoint_head (
  file_id uuid PRIMARY KEY REFERENCES app_file(id) ON DELETE CASCADE,
  checkpoint_sequence bigint NOT NULL CHECK (checkpoint_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (file_id, checkpoint_sequence)
    REFERENCES app_collaboration_checkpoint(file_id, checkpoint_sequence)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION app_collaboration_operation_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app_collaboration_operation rows are immutable';
END
$$;

CREATE TRIGGER app_collaboration_operation_reject_update
BEFORE UPDATE ON app_collaboration_operation
FOR EACH ROW EXECUTE FUNCTION app_collaboration_operation_reject_update();

CREATE FUNCTION app_collaboration_checkpoint_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app_collaboration_checkpoint rows are immutable';
END
$$;

CREATE TRIGGER app_collaboration_checkpoint_reject_update
BEFORE UPDATE ON app_collaboration_checkpoint
FOR EACH ROW EXECUTE FUNCTION app_collaboration_checkpoint_reject_update();
