import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { localRegistryEnvironment } from './local-registry.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'deploy/vercel-projects.json'), 'utf8'))

const expected = [
  ['web', 'comp-canvas-web', 'apps/web', 'pnpm --filter @canvas/web... build', 'dist/client'],
  ['login', 'comp-canvas-login', 'apps/login', 'pnpm --filter @canvas/login... build', 'dist'],
  ['api', 'comp-canvas-api', 'apps/api', 'pnpm --filter @canvas/api... build', 'public'],
  ['preview', 'comp-canvas-preview', 'apps/preview', 'pnpm --dir ../.. run build:preview:vercel', 'dist'],
  ['thumbnail-renderer', 'comp-canvas-thumbnail-renderer', 'apps/thumbnail-renderer', 'pnpm --dir ../.. run build:thumbnail-renderer:vercel', 'dist'],
]

test('pins one isolated Vercel project per hosted HTTP surface', () => {
  assert.equal(manifest.scope, 'grims-projects-c1f684ea')
  assert.equal(manifest.repository, 'https://github.com/ripgrim/comp-canvas.git')
  assert.equal(manifest.gitDeployments, 'enabled')
  assert.equal(manifest.deploymentProtection, 'disabled')
  assert.equal(manifest.productionBranch, 'main')
  assert.equal(manifest.stagingBranch, 'staging')
  assert.deepEqual(
    manifest.projects.map(project => [project.service, project.name, project.rootDirectory, project.buildCommand, project.outputDirectory]),
    expected,
  )
})

test('assigns one stable staging branch domain to every Vercel surface', () => {
  assert.deepEqual(manifest.projects.map(project => project.stagingDomain), [
    'staging.canvas.ripgrim.com',
    'login-staging.canvas.ripgrim.com',
    'api-staging.canvas.ripgrim.com',
    'preview-staging.canvas.ripgrim.com',
    'thumbnails-staging.canvas.ripgrim.com',
  ])
  assert.equal(new Set(manifest.projects.flatMap(project => [project.productionDomain, project.stagingDomain])).size, manifest.projects.length * 2)
})

test('keeps every checked-in Vercel build contract aligned with the manifest', async () => {
  for (const project of manifest.projects) {
    const config = JSON.parse(await readFile(resolve(root, project.rootDirectory, 'vercel.json'), 'utf8'))
    const ignore = await readFile(resolve(root, project.rootDirectory, '.gitignore'), 'utf8')
    assert.equal(config.buildCommand, project.buildCommand, `${project.service} build command`)
    assert.equal(config.outputDirectory, project.outputDirectory, `${project.service} output directory`)
    assert.deepEqual(config.git?.deploymentEnabled, { '*': false, main: true, staging: true }, `${project.service} branch deployment filter`)
    assert.equal(ignore.includes('.env*'), false, `${project.service} must not hide checked-in environment templates`)
    assert.equal(ignore.includes('.env.local'), true, `${project.service} must ignore downloaded local credentials`)
  }
})

test('keeps stateful and privileged services off the static Vercel plan', () => {
  assert.deepEqual(
    manifest.externalServices.map(service => [service.service, service.platform]),
    [
      ['assets', 'cloudflare-workers'],
      ['sync', 'cloudflare-containers'],
      ['thumbnail-jobs', 'cloudflare-containers'],
      ['desktop', 'desktop-release'],
    ],
  )
})

test('declares every environment value required directly by the hosted API runtime', async () => {
  const api = manifest.projects.find(project => project.service === 'api')
  assert.ok(api)
  const runtimePath = resolve(root, 'apps/api/src/runtime.ts')
  const requiredNames = requiredEnvironmentNames(await readFile(runtimePath, 'utf8'), runtimePath)
  assert.ok(requiredNames.has('CANVAS_VERIFIED_REGISTRY_FINGERPRINT'))
  assert.deepEqual([...requiredNames].filter(name => !api.environment.includes(name)), [])
})

test('generates every build environment value consumed by the thumbnail renderer', async () => {
  const renderer = manifest.projects.find(project => project.service === 'thumbnail-renderer')
  assert.ok(renderer)
  assert.equal(renderer.buildCommand, 'pnpm --dir ../.. run build:thumbnail-renderer:vercel')
  const configPath = resolve(root, 'apps/thumbnail-renderer/vite.config.ts')
  const consumed = processEnvironmentNames(await readFile(configPath, 'utf8'), configPath)
  const generated = Object.keys(localRegistryEnvironment({ manifestPath: 'registry.json', fingerprint: 'sha256-test' }))
  assert.deepEqual([...consumed].filter(name => !renderer.environment.includes(name) && !generated.includes(name)), [])
})

function requiredEnvironmentNames(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set()
  visit(file, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'required') return
    const [environment, name] = node.arguments
    if (ts.isIdentifier(environment) && environment.text === 'environment' && ts.isStringLiteral(name)) names.add(name.text)
  })
  return names
}

function processEnvironmentNames(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set()
  visit(file, node => {
    if (!ts.isPropertyAccessExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
    if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process' && node.expression.name.text === 'env') names.add(node.name.text)
  })
  return names
}

function visit(node, callback) {
  callback(node)
  node.forEachChild(child => visit(child, callback))
}
