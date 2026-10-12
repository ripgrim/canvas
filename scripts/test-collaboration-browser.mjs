import { spawn, spawnSync } from 'node:child_process'
import { config as loadEnvironment } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
loadEnvironment({ path: resolve(root, '.env'), quiet: true })
loadEnvironment({ path: resolve(root, '.env.local'), quiet: true, override: true })
const pnpm = [process.env.npm_execpath, process.env.APPDATA ? resolve(process.env.APPDATA, 'npm/node_modules/pnpm/bin/pnpm.cjs') : null].find(candidate => candidate && existsSync(candidate))
if (!pnpm) throw new Error('pnpm could not be located.')
if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required in .env.local.')

function run(args) {
  const result = spawnSync(process.execPath, [pnpm, ...args], { cwd: root, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed.`)
}

if (process.env.STAGE6_SKIP_PREP !== 'true') {
  run(['db:setup'])
  for (const packageName of ['@canvas/sync-protocol', '@canvas/preview-runtime', '@canvas/repo-engine', '@canvas/scanner', '@canvas/database', '@canvas/cloud-document', '@canvas/api', '@canvas/sync-client', '@canvas/sync-worker', '@canvas/sync-room-core']) run(['--filter', packageName, 'build'])
}

globalThis.__stage6Spawn = (args, environment) => {
  const command = args[0] === 'node_modules/.bin/pnpm' ? [pnpm, ...args.slice(1)] : [args[0], ...args.slice(1)]
  const child = spawn(process.execPath, command, { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stage6Label = args.includes('@canvas/sync-room-core') ? 'room' : args.includes('@canvas/sync-coordinator') ? 'coordinator' : args.includes('@canvas/sync-worker') ? 'worker' : args.includes('dev:preview') ? 'preview' : args.includes('@canvas/web') ? 'web' : 'api'
  return child
}
globalThis.__stage6Stop = child => new Promise(resolveStop => {
  if (!child.pid || child.exitCode !== null) { resolveStop(); return }
  if (process.platform !== 'win32') { child.once('exit', resolveStop); child.kill('SIGTERM'); return }
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  killer.once('error', () => { child.kill(); resolveStop() })
  killer.once('exit', () => resolveStop())
})

await import('../tests/collaboration-browser/run.mjs')
