import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(process.env.COMP_V3_ROOT?.trim() || resolve(root, '..', 'comp-v3'))
if (!existsSync(resolve(repositoryRoot, 'apps/docs/blume.config.ts'))) {
  throw new Error(`Comp v3 documentation fixture is missing at ${repositoryRoot}. Set COMP_V3_ROOT to its checkout.`)
}

const image = run('docker', ['build', '--quiet', '--tag', 'comp-canvas-hosted-docs-validator:test', '--file', 'infra/hosted-docs-validator/Dockerfile', '.'], undefined).trim()
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker did not return an immutable documentation validator image ID.')
const profile = JSON.parse(readFileSync(resolve(root, 'infra/hosted-docs-validator/comp-v3.profile.json'), 'utf8'))
const containerName = `canvas-docs-test-${randomUUID()}`
const contract = JSON.stringify({ files: {}, changedPaths: [], profile })
try {
  const result = run('docker', [
    'run', '--rm', '--interactive', '--pull=never', '--network=none', '--read-only',
    `--name=${containerName}`, '--stop-timeout=1', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2147483648', '--memory-swap=2147483648', '--cpus=2',
    '--ulimit=nofile=1024:1024', '--user=65532:65532',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=268435456',
    '--tmpfs=/validator/repository:rw,noexec,nosuid,size=1073741824,mode=1777',
    `--mount=type=bind,source=${repositoryRoot},target=/workspace,readonly`,
    '--env=HOME=/tmp/home', '--env=CI=1', image,
  ], contract)
  const evidence = JSON.parse(result)
  if (evidence.ok !== true || evidence.profileId !== profile.id || JSON.stringify(evidence.phases) !== '["check","build"]') {
    throw new Error('Documentation validator returned incomplete evidence.')
  }
  process.stdout.write(`HOSTED_DOCS_VALIDATOR_EVIDENCE ${JSON.stringify({ image, repositoryRoot, ...evidence })}\n`)
} catch (error) {
  spawnSync('docker', ['rm', '--force', containerName], { cwd: root, stdio: 'ignore' })
  throw error
}

function run(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 200_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim().slice(-2_048)}`)
  return result.stdout
}
