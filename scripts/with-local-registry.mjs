import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localRegistryEnvironment, prepareLocalRegistry } from './local-registry.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm.')
if (!process.argv[2]) throw new Error('A pnpm command is required after with-local-registry.mjs.')

for (const packageName of ['@canvas/scanner', '@canvas/preview-runtime']) {
  const result = spawnSync(process.execPath, [pnpm, '--filter', packageName, 'build'], { cwd: root, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Building ${packageName} failed.`)
}

const registry = await prepareLocalRegistry({ root })
const environment = { ...process.env, ...localRegistryEnvironment(registry) }
process.stdout.write(`LOCAL_REGISTRY_EVIDENCE ${JSON.stringify(registry)}\n`)

const child = spawn(process.execPath, [pnpm, ...process.argv.slice(2)], { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' })
child.once('error', error => { throw error })
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
