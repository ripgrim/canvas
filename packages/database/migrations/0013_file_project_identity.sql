INSERT INTO app_project (id, owner_user_id, name, created_at, updated_at)
SELECT file.id, file.owner_user_id, file.name, file.created_at, file.updated_at
FROM app_file AS file
WHERE file.project_id IS NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_project_member (project_id, user_id, role)
SELECT project.id, project.owner_user_id, 'owner'
FROM app_project AS project
JOIN app_file AS file ON file.id = project.id AND file.project_id IS NULL
ON CONFLICT (project_id, user_id) DO NOTHING;

UPDATE app_file
SET project_id = id
WHERE project_id IS NULL;

ALTER TABLE app_file
  ALTER COLUMN project_id SET NOT NULL;
