import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm test:hosted-builder.')

run(process.execPath, [pnpm, '--filter', '@canvas/preview-runtime', 'build'])
run(process.execPath, [pnpm, '--filter', '@canvas/scanner', 'build'])
const image = run('docker', ['build', '--quiet', '-f', 'infra/hosted-preview-builder/Dockerfile', '.']).trim()
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker did not return an immutable hosted preview builder image ID.')

run(process.execPath, [pnpm, 'exec', 'vitest', 'run', 'apps/repository-jobs/tests'], {
  ...process.env,
  HOSTED_PREVIEW_BUILDER_IMAGE: image,
})

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`)
  return result.stdout ?? ''
}
