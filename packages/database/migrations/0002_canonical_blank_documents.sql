WITH legacy_blank AS (
  SELECT
    file_id,
    'page-' || file_id::text AS page_id,
    'root-' || file_id::text AS root_id
  FROM app_file_document
  WHERE revision = 0
    AND document = '{"schemaVersion":2,"pages":[]}'::jsonb
)
UPDATE app_file_document AS file_document
SET document = jsonb_build_object(
  'schemaVersion', 6,
  'fileId', legacy_blank.file_id::text,
  'revision', 0,
  'pages', jsonb_build_array(jsonb_build_object(
    'id', legacy_blank.page_id,
    'name', 'Page 1',
    'rootNodeId', legacy_blank.root_id
  )),
  'nodes', jsonb_build_object(legacy_blank.root_id, jsonb_build_object(
    'id', legacy_blank.root_id,
    'type', 'root'
  )),
  'relationships', '{}'::jsonb,
  'theme', jsonb_build_object('tokens', '{}'::jsonb)
)
FROM legacy_blank
WHERE file_document.file_id = legacy_blank.file_id;
