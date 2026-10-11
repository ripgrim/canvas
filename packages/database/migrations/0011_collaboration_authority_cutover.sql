CREATE OR REPLACE FUNCTION app_file_document_reject_legacy_write_after_room_cutover() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_collaboration_projection
    WHERE file_id = OLD.file_id
  ) THEN
    RAISE EXCEPTION 'app_file_document is collaboration authoritative';
  END IF;
  RETURN NEW;
END
$$;
