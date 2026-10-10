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
    expect(migrations.map(migration => migration.name)).toEqual(['0001_control_plane.sql', '0002_canonical_blank_documents.sql', '0003_sync_history.sql', '0004_sync_history_hardening.sql'])
    expect(migrations.every(migration => /^[a-f0-9]{64}$/.test(migration.checksum))).toBe(true)
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
