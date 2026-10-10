import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'dotenv'

const commands = Object.freeze({
  migrate: ['migrate', '--config', resolve('packages/auth/auth.ts'), '--yes'],
  generate: ['generate', '--config', resolve('packages/auth/auth.ts'), '--output', resolve('packages/auth/schema.sql'), '--yes'],
  check: ['check', '--config', resolve('packages/auth/auth.ts')],
})

export function assertLocalDatabaseURL(raw, expectedPort = '54329') {
  if (!raw) throw new Error('DATABASE_URL is required for local database commands.')
  const url = new URL(raw)
  const expected = `postgresql://design_editor:design_editor_local@127.0.0.1:${expectedPort}/design_editor`
  if (url.toString() !== expected) {
    throw new Error(`Local database commands require the Docker database at 127.0.0.1:${expectedPort}/design_editor.`)
  }
  return url
}

const libpqVariables = ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGAPPNAME']

export function localAuthEnvironment(baseEnvironment, localEnvironment) {
  const environment = { ...baseEnvironment, ...localEnvironment }
  for (const name of libpqVariables) delete environment[name]
  assertLocalDatabaseURL(environment.DATABASE_URL)
  return environment
}

export function loadLocalAuthEnvironment(directory = process.cwd(), baseEnvironment = process.env) {
  const sharedPath = resolve(directory, '.env')
  const localPath = resolve(directory, '.env.local')
  if (!existsSync(localPath)) throw new Error('Missing .env.local. Copy .env.local.example before running local database commands.')
  const sharedEnvironment = existsSync(sharedPath) ? parse(readFileSync(sharedPath)) : {}
  const localEnvironment = parse(readFileSync(localPath))
  return localAuthEnvironment({ ...sharedEnvironment, ...baseEnvironment }, localEnvironment)
}

function run() {
  const environment = loadLocalAuthEnvironment()
  const command = process.argv[2]
  const args = commands[command]
  if (!args || process.argv.length !== 3) throw new Error('Expected one of: migrate, generate, check.')
  const pnpm = process.env.npm_execpath
  if (!pnpm) throw new Error('Run database commands through pnpm.')
  const result = spawnSync(process.execPath, [pnpm, 'exec', 'auth', ...args], { env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) run()
