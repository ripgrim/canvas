import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { BuildGenerations } from './generation.js'
import { isPreviewDocument, type PreviewDocument, isJsonValue, type JsonValue, type PreviewRegistryBinding } from './protocol.js'
import { registryRequestFromPreviewBinding, verifyComponentRegistry } from './verified-registry.mjs'

export type PreviewBinding = {
  componentId: string
  entryPath: string
  exportName: string
  styles?: string[]
  props?: Record<string, JsonValue>
  provider?: { entryPath: string; exportName: string; props?: Record<string, JsonValue>; integrity?: string }
  /** Verified theme adapters (provider boundaries and portal ownership) exported by repository modules. */
  themeAdapters?: { entryPath: string; exportName: string; integrity?: string }[]
  /** Static browser assets copied into the isolated build without executing repository tooling. */
  assets?: { assetId: string; sourcePath: string; publicPath: string; mime: string; integrity?: string }[]
  /** Font faces backed by an explicitly declared font asset. */
  fonts?: { family: string; assetId: string; weight?: string; style?: 'normal' | 'italic' | 'oblique'; display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional' }[]
  registry?: PreviewRegistryBinding[]
  sourceDocument?: PreviewDocument
}

export type PreviewSnapshot = {
  status: 'stopped' | 'building' | 'ready' | 'error' | 'disposed'
  currentGeneration: number
  activeGeneration: number | null
  origin: string | null
  url: string | null
  stale: boolean
  diagnostics: readonly string[]
}

export type PreviewOptions = { repositoryRoot: string; editorOrigin: string; executionTrust: 'fixture-only'; buildTimeoutMs?: number }

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' }
const literal = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function createPreviewRuntime(options: PreviewOptions) {
  if (options.executionTrust !== 'fixture-only') throw new Error('This adapter requires scoped fixture execution trust. Arbitrary repository execution needs an OS sandbox.')
  const editorUrl = new URL(options.editorOrigin)
  const standardDesktopOrigin = options.editorOrigin === 'design-editor://app'
  if (!standardDesktopOrigin && (editorUrl.origin !== options.editorOrigin || !['http:', 'https:'].includes(editorUrl.protocol))) throw new Error('A concrete HTTP or registered desktop editor origin is required')
  const generations = new BuildGenerations<string>()
  const subscribers = new Set<() => void>()
  const workers = new Set<ChildProcess>()
  const acceptedRoots = new Map<number, string>()
  let server: Server | null = null
  let workRoot: string | null = null
  let disposed = false
  let stopping = false
  let setup: Promise<void> | null = null
  let snapshot: PreviewSnapshot = { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: [] }
  const publish = (next: PreviewSnapshot) => { snapshot = next; for (const notify of subscribers) notify() }

  async function grantedPath(root: string, path: string): Promise<string> {
    if (isAbsolute(path)) throw new Error('Preview bindings must use repository-relative paths')
    const candidate = await realpath(resolve(root, path))
    if (!inside(root, candidate)) throw new Error('Preview binding escapes the granted repository')
    if (!(await stat(candidate)).isFile()) throw new Error('Preview binding must name a file')
    return candidate
  }

  async function ensureServer() {
    if (setup) return setup
    if (server) return
    setup = (async () => {
      workRoot = await mkdtemp(join(tmpdir(), 'design-editor-preview-'))
      server = createServer((request, response) => {
        void (async () => {
          response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-ancestors ${options.editorOrigin}; base-uri 'none'; form-action 'none'`)
          response.setHeader('X-Content-Type-Options', 'nosniff')
          response.setHeader('Referrer-Policy', 'no-referrer')
          response.setHeader('Cache-Control', 'no-store')
          if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
          const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
          const match = /^\/build\/(\d+)\/(.*)$/.exec(path)
          const root = match ? acceptedRoots.get(Number(match[1])) : undefined
          if (!root || !match) { response.writeHead(404); response.end(); return }
          const asset = decodeURIComponent(match[2] || 'index.html')
          const candidate = await realpath(resolve(root, asset))
          if (!inside(root, candidate) || !(await stat(candidate)).isFile()) { response.writeHead(404); response.end(); return }
          response.setHeader('Content-Type', contentTypes[extname(candidate)] ?? 'application/octet-stream')
          response.writeHead(200)
          response.end(request.method === 'HEAD' ? undefined : await readFile(candidate))
        })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end() })
      })
      await new Promise<void>((resolveListen, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolveListen() }) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Preview server did not bind')
      publish({ ...snapshot, origin: `http://127.0.0.1:${address.port}` })
    })()
    try { await setup } finally { setup = null }
  }

  async function rebuild(binding: PreviewBinding): Promise<PreviewSnapshot> {
    if (disposed || stopping) throw new Error('Preview service is not available')
    const generation = generations.request()
    publish({ ...snapshot, status: 'building', currentGeneration: generation, stale: snapshot.activeGeneration !== null, diagnostics: [] })
    try {
      await ensureServer()
      const root = await realpath(options.repositoryRoot)
      if (!/^[A-Za-z_$][\w$]*$/.test(binding.exportName) || !binding.componentId || binding.componentId.length > 200 || !isJsonValue(binding.props ?? {})) throw new Error('Invalid component binding')
      if (binding.registry && (!Array.isArray(binding.registry) || binding.registry.length > 500)) throw new Error('Invalid preview registry')
      const verified = await verifyComponentRegistry(root, registryRequestFromPreviewBinding(binding))
      if (!verified.entry) throw new Error('Registry entry does not name a verified component')
      const entry = verified.entry.absolutePath
      const registry = verified.components.map(item => ({ componentId: item.componentId, exportName: item.exportName, entryPath: item.absolutePath, ...(item.props ? { props: item.props } : {}), ...(item.slots ? { slots: item.slots } : {}) }))
      if (binding.sourceDocument && !isPreviewDocument(binding.sourceDocument, registry)) throw new Error('Invalid source binding document')
      const styles = verified.styles.map(item => item.absolutePath)
      const provider = verified.provider ? { ...verified.provider, entryPath: verified.provider.absolutePath } : undefined
      if (provider && (!/^[A-Za-z_$][\w$]*$/.test(provider.exportName) || !isJsonValue(provider.props ?? {}))) throw new Error('Invalid provider binding')
      const themeAdapters = verified.themeAdapters.map(adapter => ({ exportName: adapter.exportName, entryPath: adapter.absolutePath }))
      const buildRoot = join(workRoot!, `generation-${generation}`)
      const outputRoot = join(buildRoot, 'output')
      await mkdir(buildRoot, { recursive: true })
      const requireFromRepo = createRequire(join(root, 'package.json'))
      const alias = Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom'].map(name => [name, requireFromRepo.resolve(name)]))
      const browserRuntime = fileURLToPath(new URL('./browser-runtime.mjs', import.meta.url))
      const bootstrap = `import { startPreview } from ${literal(browserRuntime)};\nimport { ${binding.exportName} as Component } from ${literal(entry)};\n${registry.map((item, index) => `import { ${item.exportName} as Atom${index} } from ${literal(item.entryPath)};`).join('\n')}\n${styles.map(path => `import ${literal(path)};`).join('\n')}\n${provider ? `import { ${provider.exportName} as Provider } from ${literal(provider.entryPath)};` : ''}\n${themeAdapters.map((adapter, index) => `import { ${adapter.exportName} as ThemeAdapter${index} } from ${literal(adapter.entryPath)};`).join('\n')}\nstartPreview({ Component, ${provider ? 'Provider,' : ''} providerProps: ${literal(provider?.props ?? {})}, initialProps: ${literal(binding.props ?? {})}, sourceDocument: ${literal(binding.sourceDocument ?? null)}, generation: ${generation}, editorOrigin: ${literal(options.editorOrigin)}, componentId: ${literal(binding.componentId)}, registry: [${registry.map((item, index) => `{componentId:${literal(item.componentId)},exportName:${literal(item.exportName)},Component:Atom${index}}`).join(',')}], themeAdapters: [${themeAdapters.map((_, index) => `ThemeAdapter${index}`).join(',')}] });\n`
      await writeFile(join(buildRoot, 'entry.jsx'), bootstrap)
      await writeFile(join(buildRoot, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="preview-root"></div><script type="module" src="/entry.jsx"></script></body></html>')
      const settingsPath = join(buildRoot, 'settings.json')
      const registryForWorker = { ...verified, entry: { ...verified.entry }, components: verified.components.map(item => ({ ...item })), styles: verified.styles.map(item => ({ ...item })), provider: verified.provider ? { ...verified.provider } : undefined, themeAdapters: verified.themeAdapters.map(item => ({ ...item })), assets: verified.assets.map(({ bytes: _bytes, ...item }) => item), fonts: verified.fonts.map(item => ({ ...item })) }
      await writeFile(settingsPath, JSON.stringify({ generation, repositoryRoot: root, workRoot: buildRoot, outputRoot, htmlPath: join(buildRoot, 'index.html'), alias, sourceBindings: binding.sourceDocument ? registry : [], bindingRuntime: fileURLToPath(new URL('./source-bindings.mjs', import.meta.url)), browserRuntime, runtimeRoot: dirname(browserRuntime), verifiedRegistry: registryForWorker }))
      if (disposed || stopping || generation !== generations.current()) return snapshot
      await compile(settingsPath)
      if (disposed || stopping || !generations.accept(generation, outputRoot)) { await rm(buildRoot, { recursive: true, force: true }); return snapshot }
      acceptedRoots.set(generation, outputRoot)
      publish({ ...snapshot, status: 'ready', activeGeneration: generation, url: `${snapshot.origin}/build/${generation}/index.html`, stale: false, diagnostics: [] })
    } catch (error) {
      if (generation === generations.current() && !disposed && !stopping) publish({ ...snapshot, status: 'error', stale: snapshot.activeGeneration !== null, diagnostics: [error instanceof Error ? error.message : 'Preview build failed'] })
    }
    return snapshot
  }

  function compile(settingsPath: string): Promise<void> {
    return new Promise((resolveBuild, reject) => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' }
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
      const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), settingsPath], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      workers.add(worker)
      let output = ''
      let errorOutput = ''
      const timer = setTimeout(() => { worker.kill(); reject(new Error('Preview build timed out')) }, options.buildTimeoutMs ?? 30_000)
      worker.stdout?.on('data', chunk => { if (output.length < 100_000) output += String(chunk) })
      worker.stderr?.on('data', chunk => { if (errorOutput.length < 4000) errorOutput += String(chunk) })
      worker.once('error', error => { clearTimeout(timer); workers.delete(worker); reject(error) })
      worker.once('close', code => {
        clearTimeout(timer)
        workers.delete(worker)
        try { const result = JSON.parse(output); if (code === 0 && result.ok === true) resolveBuild(); else reject(new Error(String(result.message ?? 'Preview build failed'))) }
        catch { reject(new Error(errorOutput || 'Preview worker did not return a valid result')) }
      })
    })
  }

  async function stop() {
    if (stopping) return
    stopping = true
    generations.request()
    await Promise.all([...workers].map(worker => new Promise<void>(resolveExit => { worker.once('close', () => resolveExit()); worker.kill() })))
    let setupError: unknown
    try { await setup }
    catch (error) { setupError = error }
    if (server) { const closing = server; server = null; closing.closeAllConnections(); await new Promise<void>(resolveClose => closing.close(() => resolveClose())) }
    if (workRoot) { const path = workRoot; workRoot = null; await rm(path, { recursive: true, force: true }) }
    acceptedRoots.clear()
    publish({ status: disposed ? 'disposed' : 'stopped', currentGeneration: generations.current(), activeGeneration: null, origin: null, url: null, stale: false, diagnostics: [] })
    stopping = false
    if (setupError) throw setupError
  }

  return {
    start: rebuild,
    rebuild,
    snapshot: () => snapshot,
    subscribe: (notify: () => void) => { subscribers.add(notify); return () => { subscribers.delete(notify) } },
    releaseGeneration: async (generation: number) => {
      if (generation === snapshot.activeGeneration) throw new Error('The active preview cannot be released')
      const root = acceptedRoots.get(generation)
      if (root) { acceptedRoots.delete(generation); await rm(dirname(root), { recursive: true, force: true }) }
    },
    stop,
    dispose: async () => { disposed = true; await stop(); subscribers.clear() },
  }
}

export async function validatePreviewFiles(options: PreviewOptions, binding: PreviewBinding, files: Record<string, string>): Promise<void> {
  const repositoryRoot = await realpath(options.repositoryRoot)
  const stagingRoot = await mkdtemp(join(tmpdir(), 'design-editor-preview-validation-'))
  const service = createPreviewRuntime({ ...options, repositoryRoot: stagingRoot })
  try {
    await writeFile(join(stagingRoot, 'package.json'), await readFile(join(repositoryRoot, 'package.json')))
    await cp(join(repositoryRoot, 'pnpm-lock.yaml'), join(stagingRoot, 'pnpm-lock.yaml'))
    await symlink(await realpath(join(repositoryRoot, 'node_modules')), join(stagingRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const [path, source] of Object.entries(files)) {
      const destination = resolve(stagingRoot, path)
      if (isAbsolute(path) || !inside(stagingRoot, destination) || !path.replaceAll('\\', '/').startsWith('src/')) throw new Error('Preview validation accepts only repository-relative src files')
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, source)
    }
    const result = await service.start(binding)
    if (result.status !== 'ready') throw new Error(result.diagnostics.join('\n') || 'Preview validation failed')
  } finally {
    await service.dispose()
    await rm(stagingRoot, { recursive: true, force: true })
  }
}
