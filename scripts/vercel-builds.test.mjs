import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { statSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'deploy/vercel-projects.json'), 'utf8'))
const pnpm = process.env.npm_execpath

if (!pnpm) throw new Error('Run the Vercel build acceptance through pnpm.')

const acceptedCommands = new Map([
  ['pnpm --filter @canvas/web... build', ['--filter', '@canvas/web...', 'build']],
  ['pnpm --filter @canvas/login... build', ['--filter', '@canvas/login...', 'build']],
  ['pnpm --filter @canvas/api... build', ['--filter', '@canvas/api...', 'build']],
  ['pnpm --dir ../.. run build:preview:vercel', ['--dir', '../..', 'run', 'build:preview:vercel']],
  ['pnpm --dir ../.. run build:thumbnail-renderer:vercel', ['--dir', '../..', 'run', 'build:thumbnail-renderer:vercel']],
])

for (const project of manifest.projects) {
  test(`${project.service} Vercel build succeeds from its configured root`, () => {
    const args = acceptedCommands.get(project.buildCommand)
    assert.ok(args, `Unreviewed Vercel build command: ${project.buildCommand}`)
    const cwd = resolve(root, project.rootDirectory)
    const result = spawnSync(process.execPath, [pnpm, ...args], {
      cwd,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(statSync(resolve(cwd, project.outputDirectory)).isDirectory(), true)
  })
}

test('the renderer Vercel build is integrity-bound to a generated registry', () => {
  const renderer = manifest.projects.find(project => project.service === 'thumbnail-renderer')
  assert.ok(renderer)
  assert.match(renderer.buildCommand, /build:thumbnail-renderer:vercel/)
  const script = readFileSync(resolve(root, 'scripts/with-local-registry.mjs'), 'utf8')
  assert.match(script, /prepareLocalRegistry/)
  assert.match(script, /localRegistryEnvironment/)
})

test('the preview Vercel build is integrity-bound to a generated registry', () => {
  const preview = manifest.projects.find(project => project.service === 'preview')
  assert.ok(preview)
  assert.match(preview.buildCommand, /build:preview:vercel/)
  const script = readFileSync(resolve(root, 'scripts/with-local-registry.mjs'), 'utf8')
  assert.match(script, /prepareLocalRegistry/)
  assert.match(script, /localRegistryEnvironment/)
})
