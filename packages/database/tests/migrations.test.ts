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
    expect(migrations.map(migration => migration.name)).toEqual(['0001_control_plane.sql', '0002_canonical_blank_documents.sql', '0003_sync_history.sql', '0004_sync_history_hardening.sql', '0005_github_app_grants.sql', '0006_github_security_and_thumbnail_identity.sql', '0007_thumbnail_capture_jobs.sql', '0008_file_sharing.sql', '0009_collaboration_rooms.sql', '0010_collaboration_access_bootstrap.sql', '0011_collaboration_authority_cutover.sql'])
    expect(migrations.every(migration => /^[a-f0-9]{64}$/.test(migration.checksum))).toBe(true)
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
