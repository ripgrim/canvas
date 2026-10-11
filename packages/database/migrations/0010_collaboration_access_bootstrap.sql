ALTER TABLE app_file
  ADD COLUMN IF NOT EXISTS access_epoch bigint NOT NULL DEFAULT 1;

ALTER TABLE app_file
  DROP CONSTRAINT IF EXISTS app_file_access_epoch_check;

ALTER TABLE app_file
  ADD CONSTRAINT app_file_access_epoch_check
  CHECK (access_epoch BETWEEN 1 AND 9223372036854775807);

CREATE FUNCTION app_file_reject_owner_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'app_file owner identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER app_file_reject_owner_change
BEFORE UPDATE OF owner_user_id ON app_file
FOR EACH ROW EXECUTE FUNCTION app_file_reject_owner_change();

CREATE FUNCTION app_file_share_reject_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'app_file_share identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER app_file_share_reject_identity_change
BEFORE UPDATE OF file_id, owner_user_id ON app_file_share
FOR EACH ROW EXECUTE FUNCTION app_file_share_reject_identity_change();

CREATE FUNCTION app_file_bump_access_epoch_on_share_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.access IS DISTINCT FROM OLD.access THEN
    UPDATE app_file
    SET access_epoch = access_epoch + 1
    WHERE id = NEW.file_id AND access_epoch < 9223372036854775807;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'app_file access epoch is exhausted or file is missing';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER app_file_bump_access_epoch_on_share_change
AFTER INSERT OR UPDATE OF access ON app_file_share
FOR EACH ROW EXECUTE FUNCTION app_file_bump_access_epoch_on_share_change();

CREATE FUNCTION app_file_bump_access_epoch_before_share_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app_file
  SET access_epoch = access_epoch + 1
  WHERE id = OLD.file_id AND access_epoch < 9223372036854775807;
  IF NOT FOUND THEN
    PERFORM 1 FROM app_file WHERE id = OLD.file_id;
    IF FOUND THEN
      RAISE EXCEPTION 'app_file access epoch is exhausted';
    END IF;
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER app_file_bump_access_epoch_before_share_delete
BEFORE DELETE ON app_file_share
FOR EACH ROW EXECUTE FUNCTION app_file_bump_access_epoch_before_share_delete();

ALTER TABLE app_collaboration_projection
  ADD COLUMN IF NOT EXISTS authority text;

UPDATE app_collaboration_projection
SET authority = 'room'
WHERE authority IS NULL;

ALTER TABLE app_collaboration_projection
  ALTER COLUMN authority SET DEFAULT 'legacy-seed',
  ALTER COLUMN authority SET NOT NULL;

ALTER TABLE app_collaboration_projection
  DROP CONSTRAINT IF EXISTS app_collaboration_projection_authority_check;

ALTER TABLE app_collaboration_projection
  ADD CONSTRAINT app_collaboration_projection_authority_check
  CHECK (authority IN ('legacy-seed', 'room'));

CREATE FUNCTION app_file_document_reject_legacy_write_after_room_cutover() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_collaboration_projection
    WHERE file_id = OLD.file_id AND authority = 'room'
  ) THEN
    RAISE EXCEPTION 'app_file_document is collaboration authoritative';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER app_file_document_reject_legacy_write_after_room_cutover
BEFORE UPDATE OF revision, document ON app_file_document
FOR EACH ROW EXECUTE FUNCTION app_file_document_reject_legacy_write_after_room_cutover();
