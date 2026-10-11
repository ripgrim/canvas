import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  loadVerifiedRegistryManifest,
  registryRequestFromPreviewBinding,
  verifyComponentRegistry,
} from '@canvas/preview-runtime/verified-registry'
import type { PreviewBinding } from '@canvas/preview-runtime'
import type { RepositoryConnection } from '@canvas/repository'
import type { ShadcnComponentCatalog, ShadcnPreviewRegistryRequest, ShadcnScan } from '@canvas/scanner/contracts'
import { shadcnPreviewComponentId } from '@canvas/scanner/preview-registry'

export type ConnectedRepositoryRegistry = Readonly<{
  repositoryRoot: string
  manifestPath: string
  fingerprint: string
  binding: PreviewBinding
  catalog: ShadcnComponentCatalog
}>

type ConnectedPreviewBinding = PreviewBinding & Readonly<{
  aliases?: ShadcnPreviewRegistryRequest['aliases']
  dependencies?: ShadcnPreviewRegistryRequest['dependencies']
}>

const manifestName = (connection: RepositoryConnection, fingerprint: string) => `${createHash('sha256').update(`${connection.repository.id}\0${connection.rootPath}`).digest('hex')}.${fingerprint.replace(/^sha256-/, '').replaceAll(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}.json`

function previewBinding(request: ShadcnPreviewRegistryRequest): ConnectedPreviewBinding {
  const entry = request.components.find(component => component.componentId === request.entry.componentId)
  if (!entry) throw new Error('The generated registry entry is missing.')
  return {
    componentId: entry.componentId,
    entryPath: entry.entryPath,
    exportName: entry.exportName,
    styles: request.styles.map(style => style.path),
    props: {},
    ...(request.provider ? { provider: { ...request.provider, props: { ...(request.provider.props ?? {}) } } } : {}),
    ...(request.themeAdapters ? { themeAdapters: request.themeAdapters.map(adapter => ({ ...adapter })) } : {}),
    ...(request.aliases ? { aliases: request.aliases } : {}),
    ...(request.dependencies ? { dependencies: request.dependencies } : {}),
    registry: request.components.map(({ componentId, entryPath, exportName, props, slots }) => ({
      componentId,
      entryPath,
      exportName,
      props: props ?? {},
      slots: slots ?? [],
    })),
  }
}

function componentCatalog(scan: ShadcnScan, request: ShadcnPreviewRegistryRequest, fingerprint: string): ShadcnComponentCatalog {
  const scanned = new Map(scan.components.map(component => [shadcnPreviewComponentId(component), component]))
  return {
    fingerprint,
    components: request.components.map(component => {
      const source = scanned.get(component.componentId)
      if (!source || source.path !== component.entryPath || source.exportName !== component.exportName) throw new Error('The verified registry component is missing from the scanner result.')
      const propNames = new Set(Object.keys(component.props ?? {}))
      const slots = [...(component.slots ?? [])]
      const slotNames = new Set(slots)
      const props = source.props.filter(prop => propNames.has(prop.name) || slotNames.has(prop.name))
      if (props.length !== propNames.size + slotNames.size) throw new Error('The verified component schema does not match the scanner result.')
      return { componentId: component.componentId, path: source.path, exportName: source.exportName, sourceHash: source.sourceHash, props, slots }
    }),
  }
}

function assertConsumerParity(request: ShadcnPreviewRegistryRequest, binding: PreviewBinding): void {
  const consumer = registryRequestFromPreviewBinding(binding)
  const expected = {
    version: request.version,
    entry: request.entry,
    components: request.components.map(({ integrity: _integrity, ...component }) => component),
    styles: request.styles.map(style => ({ path: style.path })),
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.themeAdapters ? { themeAdapters: request.themeAdapters } : {}),
    ...(request.aliases ? { aliases: request.aliases } : {}),
    ...(request.dependencies ? { dependencies: request.dependencies } : {}),
  }
  if (JSON.stringify(consumer) !== JSON.stringify(expected)) throw new Error('The generated registry does not match the preview consumer contract.')
}

/** Persists generated metadata under app data only. Repository source remains read-only. */
export class ConnectedRegistryStore {
  private readonly root: string

  constructor(userDataRoot: string) {
    this.root = join(userDataRoot, 'verified-component-registries')
  }

  async install(connection: RepositoryConnection, scan: ShadcnScan, request: ShadcnPreviewRegistryRequest, signal?: AbortSignal): Promise<ConnectedRepositoryRegistry> {
    signal?.throwIfAborted()
    const discovered = await verifyComponentRegistry(connection.rootPath, request)
    const pinnedRequest: ShadcnPreviewRegistryRequest = {
      ...request,
      dependencies: discovered.dependencies.map(({ path, integrity }) => ({ path, integrity })),
    }
    const verified = await verifyComponentRegistry(connection.rootPath, pinnedRequest)
    const binding = previewBinding(pinnedRequest)
    assertConsumerParity(pinnedRequest, binding)
    signal?.throwIfAborted()
    await mkdir(this.root, { recursive: true })
    const manifestPath = join(this.root, manifestName(connection, verified.fingerprint))
    const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ repositoryRoot: connection.rootPath, registry: pinnedRequest }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal })
      signal?.throwIfAborted()
      await rename(temporary, manifestPath)
    } catch (error) {
      try { await rm(temporary, { force: true }) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'The component registry write and cleanup both failed.') }
      throw error
    }
    const loaded = await loadVerifiedRegistryManifest(manifestPath)
    if (!loaded || loaded.fingerprint !== verified.fingerprint) throw new Error('The persisted component registry could not be verified.')
    return { repositoryRoot: loaded.repositoryRoot, manifestPath, fingerprint: loaded.fingerprint, binding, catalog: componentCatalog(scan, pinnedRequest, loaded.fingerprint) }
  }
}
