import { createServer, type Server } from 'node:http'
import type { Atom } from '@canvas/repo-engine'
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createPreviewRuntime } from '@canvas/preview-runtime'
import type { PreviewBinding, PreviewSnapshot } from '@canvas/preview-runtime'
import { loadVerifiedRegistryManifest } from '@canvas/preview-runtime/verified-registry'
import type { ConnectedRepositoryRegistry } from './connected-registry'

type Runtime = ReturnType<typeof createPreviewRuntime>
type Route = Readonly<{ runtime: Runtime; registry: ConnectedRepositoryRegistry }>

const stopped: PreviewSnapshot = { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: [] }

export function connectedRegistryAtoms(registry: ConnectedRepositoryRegistry | null): Atom[] {
  return registry?.catalog.components.map(component => ({
    componentId: component.componentId,
    name: component.exportName,
    exportName: component.exportName,
    path: component.path,
    fingerprint: registry.fingerprint,
    sourceHash: component.sourceHash,
    status: 'bound',
    candidates: [],
    kind: 'atom',
    props: component.props.map(prop => ({ ...prop })),
    slots: [...component.slots],
  })) ?? []
}

function bindingFor(registry: ConnectedRepositoryRegistry, file?: FileDocument): PreviewBinding {
  if (!file) return registry.binding
  const projection = projectPreviewPage(file, file.pages[0]!.id)
  if (!projection) throw new Error('The open file has no previewable page.')
  if (projection.document.assets && Object.keys(projection.document.assets).length > 0) {
    throw new Error('Images in a connected repository preview are unavailable until their bytes are loaded.')
  }
  const { assets: _assets, ...sourceDocument } = projection.document
  return { ...registry.binding, sourceDocument }
}

async function assertRegistryCurrent(registry: ConnectedRepositoryRegistry): Promise<void> {
  const verified = await loadVerifiedRegistryManifest(registry.manifestPath)
  if (!verified || verified.fingerprint !== registry.fingerprint || verified.repositoryRoot !== registry.repositoryRoot) {
    throw new Error('The connected repository registry is stale.')
  }
}

/**
 * Owns a stable loopback origin while verified source builds live in disposable worker runtimes.
 * A candidate registry becomes active only after it compiles; a failed candidate cannot replace the last good route.
 */
export class ConnectedPreviewService {
  private server: Server | null = null
  private gatewayOrigin: string | null = null
  private active: { version: number; route: Route } | null = null
  private activeFile: FileDocument | null = null
  private readonly routes = new Map<number, Route>()
  private version = 0

  constructor(private readonly editorOrigin: string) {}

  async start(): Promise<string> {
    if (this.gatewayOrigin) return this.gatewayOrigin
    const server = createServer((request, response) => { void this.proxy(request.method ?? 'GET', request.url ?? '/', response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('The connected preview gateway did not bind.') }
    this.server = server
    this.gatewayOrigin = `http://127.0.0.1:${address.port}`
    return this.gatewayOrigin
  }

  async activate(registry: ConnectedRepositoryRegistry, file?: FileDocument): Promise<PreviewSnapshot> {
    await this.start()
    await assertRegistryCurrent(registry)
    const sourceFile = file ?? this.activeFile ?? undefined
    const candidate = createPreviewRuntime({ repositoryRoot: registry.repositoryRoot, editorOrigin: this.editorOrigin, executionTrust: 'fixture-only' })
    const built = await candidate.start(bindingFor(registry, sourceFile))
    if (built.status !== 'ready' || !built.url) {
      await candidate.dispose()
      throw new Error(built.diagnostics.join('\n') || 'The connected preview could not be built.')
    }
    const version = ++this.version
    const route = { runtime: candidate, registry }
    this.routes.set(version, route)
    const previous = this.active
    this.active = { version, route }
    if (file) this.activeFile = structuredClone(file)
    if (previous) {
      for (const [retiredVersion, retired] of this.routes) {
        if (retiredVersion === version || retiredVersion === previous.version) continue
        this.routes.delete(retiredVersion)
        void retired.runtime.dispose()
      }
    }
    return this.publicSnapshot(version, built)
  }

  async project(file: FileDocument): Promise<PreviewSnapshot> {
    const active = this.active
    if (!active) return stopped
    return this.activate(active.route.registry, file)
  }

  atoms(): Atom[] { return connectedRegistryAtoms(this.active?.route.registry ?? null) }
  registry(): ConnectedRepositoryRegistry | null { return this.active?.route.registry ?? null }
  snapshot(): PreviewSnapshot { return this.active ? this.publicSnapshot(this.active.version, this.active.route.runtime.snapshot()) : stopped }

  async dispose(): Promise<void> {
    const server = this.server
    this.server = null
    this.gatewayOrigin = null
    this.active = null
    this.activeFile = null
    const routes = [...new Set([...this.routes.values()].map(route => route.runtime))]
    this.routes.clear()
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await Promise.all(routes.map(runtime => runtime.dispose()))
  }

  private publicSnapshot(version: number, snapshot: PreviewSnapshot): PreviewSnapshot {
    if (!this.gatewayOrigin || !snapshot.url || !snapshot.origin) return { ...snapshot, origin: this.gatewayOrigin }
    const upstream = new URL(snapshot.url)
    return { ...snapshot, origin: this.gatewayOrigin, url: `${this.gatewayOrigin}/connected/${version}${upstream.pathname}` }
  }

  private async proxy(method: string, requestUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    try {
      if (!['GET', 'HEAD'].includes(method)) { response.writeHead(405); response.end(); return }
      const parsed = new URL(requestUrl, 'http://127.0.0.1')
      const match = /^\/connected\/(\d+)(\/build\/(\d+)\/.*)$/.exec(parsed.pathname)
      if (!match) { response.writeHead(404); response.end(); return }
      const version = Number(match[1])
      const route = this.routes.get(version)
      const upstreamOrigin = route?.runtime.snapshot().origin
      if (!route || !upstreamOrigin) { response.writeHead(404); response.end(); return }
      const upstream = await fetch(`${upstreamOrigin}${match[2]}`, { method, redirect: 'error' })
      if (!upstream.ok) { response.writeHead(upstream.status); response.end(); return }
      for (const name of ['content-security-policy', 'content-type', 'x-content-type-options', 'referrer-policy', 'cache-control']) {
        const value = upstream.headers.get(name)
        if (value) response.setHeader(name, value)
      }
      response.setHeader('Cache-Control', 'no-store')
      response.writeHead(upstream.status)
      if (method === 'HEAD') { response.end(); return }
      const type = upstream.headers.get('content-type') ?? ''
      const bytes = Buffer.from(await upstream.arrayBuffer())
      if (/^(?:text\/|application\/javascript)/.test(type)) {
        const internalBase = `/build/${match[3]}/`
        const publicBase = `/connected/${version}${internalBase}`
        response.end(bytes.toString('utf8').replaceAll(internalBase, publicBase))
      } else response.end(bytes)
    } catch {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    }
  }
}
