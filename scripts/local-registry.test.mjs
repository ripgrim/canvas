import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { prepareLocalRegistry, workspaceRoot } from './local-registry.mjs'

const temporary = new Set()
const verifiedRegistryUrl = pathToFileURL(resolve(workspaceRoot, 'packages/preview-runtime/dist/verified-registry.mjs')).href

test.afterEach(async () => {
  await Promise.all([...temporary].map(directory => rm(directory, { recursive: true, force: true })))
  temporary.clear()
})

test('[AT-P0-001] generates a nonempty integrity-bound registry outside repository source', async () => {
  const directory = await temporaryDirectory()
  const manifestPath = resolve(directory, 'verified-component-registry.json')
  const registry = await prepareLocalRegistry({ manifestPath })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  assert.notEqual(registry.fingerprint, 'sha256-empty')
  assert.ok(registry.componentCount > 0)
  assert.equal(resolve(dirname(manifestPath), manifest.repositoryRoot), resolve(workspaceRoot, 'fixtures/component-repo'))
  assert.ok(manifest.registry.components.length > 0)
})

test('[AT-PRV-001] missing manifests fail both preview startup configs', () => {
  for (const [directory, config] of [
    ['apps/web', 'vite.preview.config.ts'],
    ['apps/thumbnail-renderer', 'vite.config.ts'],
  ]) {
    const result = loadViteConfig(directory, config, undefined)
    assert.notEqual(result.status, 0, `${config} unexpectedly accepted a missing registry`)
    assert.match(`${result.stdout}\n${result.stderr}`, /CANVAS_VERIFIED_COMPONENT_REGISTRY is required/)
  }
})

test('[AT-PRV-001] malformed manifests fail both preview startup configs', async () => {
  const directory = await temporaryDirectory()
  const manifestPath = resolve(directory, 'invalid.json')
  await writeFile(manifestPath, '{}\n', 'utf8')
  for (const [packageDirectory, config] of [
    ['apps/web', 'vite.preview.config.ts'],
    ['apps/thumbnail-renderer', 'vite.config.ts'],
  ]) {
    const result = loadViteConfig(packageDirectory, config, manifestPath)
    assert.notEqual(result.status, 0, `${config} unexpectedly accepted a malformed registry`)
    assert.match(`${result.stdout}\n${result.stderr}`, /Invalid generated registry manifest/)
  }
})

test('[AT-PRV-001] stale source integrity fails before a preview config can consume it', async () => {
  const directory = await temporaryDirectory()
  const repositoryRoot = resolve(directory, 'component-repo')
  const manifestPath = resolve(directory, 'verified-component-registry.json')
  await cp(resolve(workspaceRoot, 'fixtures/component-repo'), repositoryRoot, {
    recursive: true,
    filter: source => !['node_modules', 'dist'].includes(source.split(/[\\/]/).at(-1)),
  })
  await symlink(
    resolve(workspaceRoot, 'fixtures/component-repo/node_modules'),
    resolve(repositoryRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await prepareLocalRegistry({ repositoryRoot, manifestPath })
  const componentPath = resolve(repositoryRoot, 'src/components/LoginForm.tsx')
  await writeFile(componentPath, `${await readFile(componentPath, 'utf8')}\n`, 'utf8')

  const { loadVerifiedRegistryManifest } = await import(verifiedRegistryUrl)
  await assert.rejects(loadVerifiedRegistryManifest(manifestPath), /changed after the registry was generated/)
})

test('[AT-PRV-001][AT-THUMB-001] preview and thumbnail configs consume one nonempty fingerprint', async () => {
  const directory = await temporaryDirectory()
  const manifestPath = resolve(directory, 'verified-component-registry.json')
  const registry = await prepareLocalRegistry({ manifestPath })
  const preview = loadViteConfig('apps/web', 'vite.preview.config.ts', manifestPath)
  const thumbnail = loadViteConfig('apps/thumbnail-renderer', 'vite.config.ts', manifestPath)

  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(thumbnail.status, 0, thumbnail.stderr)
  assert.equal(fingerprintFrom(preview.stdout), registry.fingerprint)
  assert.equal(fingerprintFrom(thumbnail.stdout), registry.fingerprint)
  assert.notEqual(fingerprintFrom(preview.stdout), 'sha256-empty')
  assert.equal(previewHmrFrom(preview.stdout), false)
})

async function temporaryDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), 'design-editor-local-registry-'))
  temporary.add(directory)
  return directory
}

function loadViteConfig(directory, config, manifestPath) {
  const code = `import { loadConfigFromFile } from 'vite'; const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, process.argv[1], process.cwd()); if (!loaded) throw new Error('Vite config did not load.'); console.log('CONFIG_FINGERPRINT ' + JSON.parse(loaded.config.define.__CANVAS_VERIFIED_REGISTRY_FINGERPRINT__)); console.log('CONFIG_HMR ' + JSON.stringify(loaded.config.server?.hmr));`
  const environment = { ...process.env }
  if (manifestPath) environment.CANVAS_VERIFIED_COMPONENT_REGISTRY = manifestPath
  else delete environment.CANVAS_VERIFIED_COMPONENT_REGISTRY
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, config], {
    cwd: resolve(workspaceRoot, directory),
    env: environment,
    encoding: 'utf8',
  })
}

function fingerprintFrom(output) {
  const match = output.match(/^CONFIG_FINGERPRINT (.+)$/m)
  assert.ok(match, `Missing config fingerprint in output: ${output}`)
  return match[1].trim()
}

function previewHmrFrom(output) {
  const match = output.match(/^CONFIG_HMR (.+)$/m)
  assert.ok(match, `Missing preview HMR value in output: ${output}`)
  return JSON.parse(match[1].trim())
}
