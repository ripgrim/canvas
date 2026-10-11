import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const localRegistryRoot = resolve(workspaceRoot, '.design-editor/runtime')
export const localRegistryManifestPath = resolve(localRegistryRoot, 'verified-component-registry.json')
export const localRegistryRepositoryRoot = resolve(workspaceRoot, 'fixtures/component-repo')

export async function prepareLocalRegistry({
  root = workspaceRoot,
  repositoryRoot = resolve(root, 'fixtures/component-repo'),
  manifestPath = resolve(root, '.design-editor/runtime/verified-component-registry.json'),
} = {}) {
  const scannerUrl = pathToFileURL(resolve(root, 'packages/scanner/dist/preview-registry.js')).href
  const registryUrl = pathToFileURL(resolve(root, 'packages/preview-runtime/dist/verified-registry.mjs')).href
  const [{ scanShadcnPreviewRegistry }, { loadVerifiedRegistryManifest }] = await Promise.all([
    import(scannerUrl),
    import(registryUrl),
  ])
  const generated = await scanShadcnPreviewRegistry(repositoryRoot)
  if (!generated.request.components.length) throw new Error('The local verified component registry cannot be empty.')

  const directory = dirname(manifestPath)
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`
  const repositoryReference = relative(directory, repositoryRoot).replaceAll('\\', '/') || '.'
  await mkdir(directory, { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify({ repositoryRoot: repositoryReference, registry: generated.request }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await rm(manifestPath, { force: true })
    await rename(temporaryPath, manifestPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }

  const verified = await loadVerifiedRegistryManifest(manifestPath)
  if (!verified || verified.components.length < 1 || verified.fingerprint === 'sha256-empty') throw new Error('The generated local component registry did not verify as nonempty.')
  return Object.freeze({
    manifestPath: resolve(manifestPath),
    fingerprint: verified.fingerprint,
    componentCount: verified.components.length,
    componentIds: Object.freeze(verified.components.map(component => component.componentId)),
  })
}

export function localRegistryEnvironment(registry) {
  if (!registry?.manifestPath) throw new Error('A prepared local registry is required.')
  if (!registry?.fingerprint) throw new Error('A prepared local registry fingerprint is required.')
  return Object.freeze({
    CANVAS_VERIFIED_COMPONENT_REGISTRY: resolve(registry.manifestPath),
    CANVAS_VERIFIED_REGISTRY_FINGERPRINT: registry.fingerprint,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registry = await prepareLocalRegistry()
  process.stdout.write(`LOCAL_REGISTRY_EVIDENCE ${JSON.stringify(registry)}\n`)
}
