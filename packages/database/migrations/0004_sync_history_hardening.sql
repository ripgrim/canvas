ALTER TABLE app_file_edit_batch
  ADD COLUMN owner_user_id text;

UPDATE app_file_edit_batch AS batch
SET owner_user_id = file.owner_user_id
FROM app_file AS file
WHERE file.id = batch.file_id;

ALTER TABLE app_file_edit_batch
  ALTER COLUMN owner_user_id SET NOT NULL,
  ADD CONSTRAINT app_file_edit_batch_owner_fkey
    FOREIGN KEY (file_id, owner_user_id) REFERENCES app_file(id, owner_user_id) ON DELETE CASCADE;

DROP INDEX app_file_edit_batch_catchup_idx;

CREATE INDEX app_file_edit_batch_catchup_idx
  ON app_file_edit_batch (file_id, owner_user_id, server_revision ASC);

CREATE FUNCTION app_file_edit_batch_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app_file_edit_batch rows are immutable';
END
$$;

CREATE TRIGGER app_file_edit_batch_reject_update
BEFORE UPDATE ON app_file_edit_batch
FOR EACH ROW EXECUTE FUNCTION app_file_edit_batch_reject_update();
