import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from '../src/migrations'

describe('control-plane migrations', () => {
  it('keeps metadata and canonical document payloads in separate owner-indexed tables', async () => {
    const sql = await readFile(new URL('../migrations/0001_control_plane.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_file (')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_file_document (')
    expect(sql).toContain('app_file_owner_updated_idx')
    expect(sql).toContain('WHERE project_id IS NOT NULL')
    expect(sql).toContain("jsonb_typeof(document) = 'object'")
    expect(sql).not.toContain('SELECT *')
  })

  it('loads deterministic checksummed migrations', async () => {
    const migrations = await loadMigrations(new URL('../migrations/', import.meta.url))
    expect(migrations.map(migration => migration.name)).toEqual(['0001_control_plane.sql', '0002_canonical_blank_documents.sql', '0003_sync_history.sql', '0004_sync_history_hardening.sql', '0005_github_app_grants.sql', '0006_github_security_and_thumbnail_identity.sql', '0007_thumbnail_capture_jobs.sql', '0008_file_sharing.sql', '0009_collaboration_rooms.sql', '0010_collaboration_access_bootstrap.sql', '0011_collaboration_authority_cutover.sql', '0012_github_return_handoff.sql', '0013_file_project_identity.sql', '0014_repository_job_leases.sql', '0015_repository_scan_results.sql', '0016_repository_scan_terminal_states.sql', '0017_hosted_preview_artifacts.sql', '0018_hosted_preview_build_jobs.sql', '0019_github_docs_reviews.sql', '0020_repository_source_bindings.sql'])
    expect(migrations.every(migration => /^[a-f0-9]{64}$/.test(migration.checksum))).toBe(true)
  })

  it('COMP-V2-BINDING-001 persists grant generations and current source binding snapshots', async () => {
    const sql = await readFile(new URL('../migrations/0020_repository_source_bindings.sql', import.meta.url), 'utf8')
    expect(sql).toContain('grant_generation bigint NOT NULL DEFAULT 1')
    expect(sql).toContain('repository_grant_generation bigint')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_github_repository_source_binding')
    expect(sql).toContain('project_id uuid PRIMARY KEY')
    expect(sql).toContain('canonical_digest text NOT NULL')
    expect(sql).toContain("jsonb_typeof(records) = 'array'")
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).not.toContain('DROP COLUMN')
  })

  it('COMP-V2-DOCS-004 persists review and save as separate states', async () => {
    const sql = await readFile(new URL('../migrations/0019_github_docs_reviews.sql', import.meta.url), 'utf8')
    expect(sql).toContain("status IN ('queued_prepare', 'preparing', 'prepared', 'queued_save', 'saving', 'saved', 'stale', 'failed')")
    expect(sql).toContain('prepared_bundle jsonb')
    expect(sql).toContain('approval_digest text')
    expect(sql).toContain('committed_sha = proposed_commit_sha')
    expect(sql).toContain('octet_length(prepared_bundle::text) <= 5242880')
  })

  it('COMP-V2-CODE-007 binds immutable hosted artifacts to one file revision', async () => {
    const sql = await readFile(new URL('../migrations/0017_hosted_preview_artifacts.sql', import.meta.url), 'utf8')
    expect(sql).toContain('artifact_id uuid PRIMARY KEY')
    expect(sql).toContain('file_id uuid NOT NULL REFERENCES app_file(id) ON DELETE CASCADE')
    expect(sql).toContain('file_revision bigint NOT NULL')
    expect(sql).toContain('app_hosted_preview_artifact_file_revision_idx')
  })

  it('COMP-V2-CODE-011 leases one hosted preview build per file revision and verified scan', async () => {
    const sql = await readFile(new URL('../migrations/0018_hosted_preview_build_jobs.sql', import.meta.url), 'utf8')
    expect(sql).toContain('UNIQUE (file_id, file_revision, scan_job_id)')
    expect(sql).toContain("status IN ('queued', 'leased', 'completed', 'failed')")
    expect(sql).toContain("status = 'leased' AND lease_id IS NOT NULL")
    expect(sql).toContain('artifact_id uuid NOT NULL UNIQUE')
    expect(sql).toContain('staging_id uuid NOT NULL UNIQUE')
  })

  it('AT-REPO-SCAN-001 leases repository jobs atomically', async () => {
    const sql = await readFile(new URL('../migrations/0014_repository_job_leases.sql', import.meta.url), 'utf8')
    expect(sql).toContain('lease_id uuid')
    expect(sql).toContain('lease_expires_at timestamptz')
    expect(sql).toContain("status = 'running' AND lease_id IS NOT NULL")
    expect(sql).toContain('app_github_repository_job_claim_idx')
  })

  it('AT-REPO-SCAN-001 stores only complete scan result objects', async () => {
    const sql = await readFile(new URL('../migrations/0015_repository_scan_results.sql', import.meta.url), 'utf8')
    expect(sql).toContain("status IN ('queued', 'running', 'completed')")
    expect(sql).toContain("jsonb_typeof(scan_result) = 'object'")
    expect(sql).toContain('app_github_repository_job_completed_idx')
  })

  it('AT-REPO-SCAN-001 fences grant lineage and terminal scan failures', async () => {
    const sql = await readFile(new URL('../migrations/0016_repository_scan_terminal_states.sql', import.meta.url), 'utf8')
    expect(sql).toContain('repository_linked_at timestamptz')
    expect(sql).toContain("status IN ('queued', 'running', 'completed', 'failed')")
    expect(sql).toContain('next_attempt_at timestamptz')
    expect(sql).toContain("status = 'failed'")
  })

  it('AT-GHAPP-001 keeps the editor return location in one-use GitHub state', async () => {
    const sql = await readFile(new URL('../migrations/0012_github_return_handoff.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS return_to_url text')
    expect(sql).toContain('char_length(return_to_url) BETWEEN 8 AND 4096')
  })

  it('AT-REPO-LINK-001 gives every file a repository authorization boundary', async () => {
    const sql = await readFile(new URL('../migrations/0013_file_project_identity.sql', import.meta.url), 'utf8')
    expect(sql).toContain('SELECT file.id, file.owner_user_id, file.name')
    expect(sql).toContain("SELECT project.id, project.owner_user_id, 'owner'")
    expect(sql).toContain('ALTER COLUMN project_id SET NOT NULL')
  })

  it('CLOUD-SYNC-AUTH-001 and CLOUD-SYNC-PG-001 add revocation epochs and explicit projection authority', async () => {
    const sql = await readFile(new URL('../migrations/0010_collaboration_access_bootstrap.sql', import.meta.url), 'utf8')
    expect(sql).toContain('access_epoch bigint NOT NULL DEFAULT 1')
    expect(sql).toContain('access_epoch BETWEEN 1 AND 9223372036854775807')
    expect(sql).toContain('app_file_reject_owner_change')
    expect(sql).toContain('app_file_share_reject_identity_change')
    expect(sql).toContain('app_file_bump_access_epoch_on_share_change')
    expect(sql).toContain('app_file_bump_access_epoch_before_share_delete')
    expect(sql).toContain("authority IN ('legacy-seed', 'room')")
    expect(sql).toContain("SET authority = 'room'")
    expect(sql).toContain('app_file_document_reject_legacy_write_after_room_cutover')
  })

  it('CLOUD-SYNC-SCHEMA-001 rejects legacy document writes after any collaboration projection exists', async () => {
    const sql = await readFile(new URL('../migrations/0011_collaboration_authority_cutover.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION app_file_document_reject_legacy_write_after_room_cutover()')
    expect(sql).toContain('FROM app_collaboration_projection')
    expect(sql).not.toContain("authority = 'room'")
  })

  it('AT-SHARE-003 stores public access separately from file ownership', async () => {
    const sql = await readFile(new URL('../migrations/0008_file_sharing.sql', import.meta.url), 'utf8')
    expect(sql).toContain("access IN ('private', 'view')")
    expect(sql).toContain('FOREIGN KEY (file_id, owner_user_id) REFERENCES app_file(id, owner_user_id) ON DELETE CASCADE')
  })

  it('queues one durable leased thumbnail capture per file revision', async () => {
    const sql = await readFile(new URL('../migrations/0007_thumbnail_capture_jobs.sql', import.meta.url), 'utf8')
    expect(sql).toContain('UNIQUE (file_id, revision)')
    expect(sql).toContain("status IN ('queued', 'leased', 'completed')")
    expect(sql).toContain('lease_expires_at')
  })

  it('hardens GitHub credentials, webhook leases, repository jobs, and thumbnail identity', async () => {
    const sql = await readFile(new URL('../migrations/0006_github_security_and_thumbnail_identity.sql', import.meta.url), 'utf8')
    expect(sql).toContain('app_github_user_credential')
    expect(sql).toContain('ON app_github_webhook_delivery (event_name, body_digest)')
    expect(sql).toContain('app_github_repository_job')
    expect(sql).toContain('thumbnail_etag')
  })

  it('AT-GHAPP-001 stores one-use state, durable deliveries, grants, and project roles', async () => {
    const sql = await readFile(new URL('../migrations/0005_github_app_grants.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_github_installation_state')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_github_webhook_delivery')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_github_installation_grant')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_github_repository_grant')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_project_member')
    expect(sql).toContain("role IN ('owner', 'editor', 'reviewer', 'viewer')")
    expect(sql).toContain('FOREIGN KEY (project_id, tenant_id)')
    expect(sql).not.toContain('SELECT *')
  })

  it('upgrades only the exact obsolete empty document shape', async () => {
    const sql = await readFile(new URL('../migrations/0002_canonical_blank_documents.sql', import.meta.url), 'utf8')
    expect(sql).toContain(`document = '{"schemaVersion":2,"pages":[]}'::jsonb`)
    expect(sql).toContain("'schemaVersion', 6")
    expect(sql).toContain("'fileId', legacy_blank.file_id::text")
    expect(sql).toContain("'revision', 0")
  })

  it('keeps sync revisions append-only and idempotent per user mutation', async () => {
    const sql = await readFile(new URL('../migrations/0003_sync_history.sql', import.meta.url), 'utf8')
    const hardening = await readFile(new URL('../migrations/0004_sync_history_hardening.sql', import.meta.url), 'utf8')
    expect(sql).toContain('PRIMARY KEY (file_id, server_revision)')
    expect(sql).toContain('UNIQUE (file_id, subject_id, client_mutation_id)')
    expect(sql).toContain('server_revision = base_revision + 1')
    expect(sql).toContain("jsonb_typeof(edits) = 'array'")
    expect(hardening).toContain('FOREIGN KEY (file_id, owner_user_id) REFERENCES app_file(id, owner_user_id)')
    expect(hardening).toContain('BEFORE UPDATE ON app_file_edit_batch')
  })
})
