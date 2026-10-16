import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { config as loadEnvironment } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvironment({ path: resolve(root, '.env'), quiet: true })
loadEnvironment({ path: resolve(root, '.env.local'), quiet: true, override: true })

const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm test:postgres.')
if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required in .env.local.')

const sourceUrl = new URL(process.env.DATABASE_URL)
if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.')
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(sourceUrl.hostname)) throw new Error('PostgreSQL acceptance only creates disposable databases on loopback.')
if ([...sourceUrl.searchParams].length) throw new Error('PostgreSQL acceptance does not permit connection-string query parameters.')
if (!/^[a-z][a-z0-9_]*$/.test(decodeURIComponent(sourceUrl.username))) throw new Error('DATABASE_URL has an unsupported PostgreSQL user.')

const suffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const controlDatabase = `design_editor_postgres_test_${suffix}`
const collaborationDatabase = `design_editor_collab_test_${suffix}`
const controlUrl = databaseUrl(sourceUrl, controlDatabase)
const collaborationUrl = databaseUrl(sourceUrl, collaborationDatabase)
const compose = ['compose', '--env-file', '.env.local']
const databaseUser = decodeURIComponent(sourceUrl.username)
const created = []

try {
  run('docker', [...compose, 'up', '-d', '--wait', 'postgres'])
  for (const database of [controlDatabase, collaborationDatabase]) {
    run('docker', [...compose, 'exec', '-T', 'postgres', 'createdb', '-U', databaseUser, database])
    created.push(database)
  }

  const environment = {
    ...process.env,
    DATABASE_URL: controlUrl,
    POSTGRES_TEST_ALLOW_DISPOSABLE: '1',
    COLLABORATION_TEST_DATABASE_URL: collaborationUrl,
    COLLABORATION_TEST_ALLOW_DISPOSABLE: '1',
  }
  runPnpm(['--filter', '@canvas/database', 'test:postgres'], environment)
  runPnpm(['--filter', '@canvas/database', 'test:collaboration:postgres'], environment)
  runPnpm(['--filter', '@canvas/database', 'migrate'], environment)
  runPnpm(['--filter', '@canvas/sync-service', 'test:postgres'], environment)
} finally {
  for (const database of created.reverse()) {
    run('docker', [...compose, 'exec', '-T', 'postgres', 'dropdb', '--if-exists', '-U', databaseUser, database])
  }
}

function databaseUrl(source, database) {
  const value = new URL(source)
  value.pathname = `/${database}`
  return value.toString()
}

function runPnpm(args, environment) {
  run(process.execPath, [pnpm, ...args], environment)
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`)
}
