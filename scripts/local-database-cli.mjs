import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadLocalAuthEnvironment } from './local-auth-cli.mjs'

export function migrateLocalControlPlane(directory = process.cwd(), baseEnvironment = process.env) {
  const environment = loadLocalAuthEnvironment(directory, baseEnvironment)
  const pnpm = environment.npm_execpath
  if (!pnpm) throw new Error('Run database commands through pnpm.')
  const result = spawnSync(process.execPath, [pnpm, '--filter', '@canvas/database', 'migrate'], { cwd: directory, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('The control-plane migration failed.')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { migrateLocalControlPlane() } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 }
}
