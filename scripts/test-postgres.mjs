import { spawnSync } from 'node:child_process'
import { config as loadEnvironment } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvironment({ path: resolve(root, '.env'), quiet: true })
loadEnvironment({ path: resolve(root, '.env.local'), quiet: true, override: true })

const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm test:postgres.')
if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required in .env.local.')

run(['db:setup'])
run(['--filter', '@canvas/database', 'test:postgres'])
run(['--filter', '@canvas/database', 'test:collaboration:postgres'])
run(['--filter', '@canvas/sync-service', 'test:postgres'])

function run(args) {
  const result = spawnSync(process.execPath, [pnpm, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed.`)
}
