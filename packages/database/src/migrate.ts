import { pathToFileURL } from 'node:url'
import { applyMigrations, loadMigrations } from './migrations.js'
import { createPostgresPool } from './postgres.js'

export async function migrateDatabase(connectionString: string): Promise<readonly string[]> {
  const pool = createPostgresPool(connectionString)
  try { return await applyMigrations(pool, await loadMigrations()) } finally { await pool.end() }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim()
  if (!connectionString) throw new Error('DATABASE_URL is required.')
  const applied = await migrateDatabase(connectionString)
  process.stdout.write(applied.length ? `Applied ${applied.join(', ')}\n` : 'Database is current.\n')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })

export { applyMigrations, loadMigrations } from './migrations.js'
