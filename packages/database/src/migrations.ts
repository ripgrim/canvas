import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'

export type Migration = Readonly<{ name: string; checksum: string; sql: string }>

export async function loadMigrations(directory = new URL('../migrations/', import.meta.url)): Promise<readonly Migration[]> {
  const names = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
  const migrations = await Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8')
    return Object.freeze({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }))
  if (new Set(names).size !== names.length) throw new Error('Migration names must be unique.')
  return Object.freeze(migrations)
}

export async function applyMigrations(pool: Pool, migrations: readonly Migration[]): Promise<readonly string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [1_807_754_191])
    await client.query('CREATE TABLE IF NOT EXISTS app_schema_migration (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
    const existing = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM app_schema_migration ORDER BY name')
    const checksums = new Map(existing.rows.map(row => [row.name, row.checksum]))
    for (const migration of migrations) {
      const checksum = checksums.get(migration.name)
      if (checksum && checksum !== migration.checksum) throw new Error(`Applied migration changed: ${migration.name}`)
      if (checksum) continue
      await applyOne(client, migration)
      applied.push(migration.name)
    }
    return Object.freeze(applied)
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [1_807_754_191]) } finally { client.release() }
  }
}

async function applyOne(client: PoolClient, migration: Migration): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query('INSERT INTO app_schema_migration (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum])
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') }
    catch (rollbackError) { console.error(JSON.stringify({ level: 'error', event: 'migration_rollback_failed', message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) })) }
    throw error
  }
}
