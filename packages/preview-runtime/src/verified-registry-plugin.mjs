import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

export const verifiedRegistryModuleId = 'virtual:canvas-verified-component-registry'
const resolvedModuleId = `\0${verifiedRegistryModuleId}`
const resolvedFontCssId = '\0virtual:canvas-verified-component-fonts.css'

const literal = value => value === undefined ? 'undefined' : JSON.stringify(value).replaceAll('<', '\\u003c')

function inside(root, candidate) {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function publicFileName(path) {
  return path.replace(/^\/+/, '')
}

function integrity(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`
}

async function verifiedBytes(file) {
  const bytes = await readFile(file.absolutePath)
  if (integrity(bytes) !== file.integrity) throw new Error(`Verified registry input changed before build: ${file.absolutePath}`)
  return bytes
}

function basePublicPath(base, path) {
  return `${base.endsWith('/') ? base : `${base}/`}${publicFileName(path)}`
}

function fontCss(registry, base) {
  return registry.fonts.map(font => {
    const asset = registry.assets.find(candidate => candidate.assetId === font.assetId)
    const format = asset.mime === 'font/woff2' ? 'woff2' : asset.mime === 'font/woff' ? 'woff' : asset.mime === 'font/ttf' ? 'truetype' : 'opentype'
    return `@font-face{font-family:${literal(font.family)};src:url(${literal(basePublicPath(base, asset.publicPath))}) format(${literal(format)});font-weight:${font.weight};font-style:${font.style};font-display:${font.display}}`
  }).join('\n')
}

/**
 * Generates one virtual runtime module from the already verified contract. Both editor preview and thumbnail builds use
 * this module, so component identities and repository resources cannot drift between the two services.
 */
export function verifiedRegistryPlugin(registry) {
  let base = '/'
  return {
    name: 'design-editor-verified-component-registry',
    enforce: /** @type {'pre'} */ ('pre'),
    resolveId(source) {
      if (source === verifiedRegistryModuleId) return resolvedModuleId
      if (source === resolvedFontCssId.slice(1)) return resolvedFontCssId
      return null
    },
    configResolved(config) {
      base = config.base
    },
    load(id) {
      if (id === resolvedFontCssId) return fontCss(registry, base)
      if (id !== resolvedModuleId) return null
      const entryIndex = registry.entry ? registry.components.findIndex(component => component.componentId === registry.entry.componentId) : -1
      const imports = registry.components.map((component, index) => `import { ${component.exportName} as Component${index} } from ${literal(component.absolutePath)};`).join('\n')
      const styles = registry.styles.map(style => `import ${literal(style.absolutePath)};`).join('\n')
      const provider = registry.provider ? `import { ${registry.provider.exportName} as ProviderValue } from ${literal(registry.provider.absolutePath)};` : 'const ProviderValue = undefined;'
      const adapters = registry.themeAdapters.map((adapter, index) => `import { ${adapter.exportName} as ThemeAdapter${index} } from ${literal(adapter.absolutePath)};`).join('\n')
      const fonts = registry.fonts.length ? `import ${literal(resolvedFontCssId.slice(1))};` : ''
      return `${imports}\n${styles}\n${provider}\n${adapters}\n${fonts}
export const registryContract = Object.freeze(${literal({ version: registry.version, fingerprint: registry.fingerprint, entry: registry.entry ? { componentId: registry.entry.componentId, exportName: registry.entry.exportName } : null, components: registry.components.map(({ componentId, entryPath, exportName, integrity, props, slots }) => ({ componentId, entryPath, exportName, integrity, props, slots })), styles: registry.styles.map(({ path, integrity }) => ({ path, integrity })), assets: registry.assets.map(({ assetId, sourcePath, publicPath, mime, integrity }) => ({ assetId, sourcePath, publicPath, mime, integrity })), fonts: registry.fonts })});
export const registry = Object.freeze([${registry.components.map((component, index) => `{componentId:${literal(component.componentId)},exportName:${literal(component.exportName)},Component:Component${index},props:${literal(component.props)},slots:${literal(component.slots)}}`).join(',')}]);
export const RegistryEntry = ${entryIndex < 0 ? 'null' : `Component${entryIndex}`};
export const RegistryProvider = ProviderValue;
export const registryProviderProps = Object.freeze(${literal(registry.provider?.props ?? {})});
export const registryThemeAdapters = Object.freeze([${registry.themeAdapters.map((_, index) => `ThemeAdapter${index}`).join(',')}]);
export const registryAssets = Object.freeze(${literal(Object.fromEntries(registry.assets.map(asset => [asset.assetId, basePublicPath(base, asset.publicPath)])))});
`
    },
    configureServer(server) {
      const assets = new Map(registry.assets.map(asset => [asset.publicPath, asset]))
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
        const asset = assets.get(pathname)
        if (!asset) return next()
        if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) { response.statusCode = 405; response.end(); return }
        response.setHeader('Content-Type', asset.mime)
        response.setHeader('Cache-Control', 'no-store')
        response.statusCode = 200
        response.end(request.method === 'HEAD' ? undefined : asset.bytes)
      })
    },
    async generateBundle() {
      for (const asset of registry.assets) this.emitFile({ type: 'asset', fileName: publicFileName(asset.publicPath), source: await verifiedBytes(asset) })
    },
  }
}

/** Refuses source modules that resolve outside the granted repository, except published dependencies and runtime files. */
export function verifiedModuleBoundaryPlugin(registry, allowedRoots = [], allowedEntryRoutes = []) {
  let base = '/'
  const roots = allowedRoots.map(path => path.replaceAll('\\', '/'))
  const entryRoutes = new Set(allowedEntryRoutes)
  const declared = new Map([
    ...registry.components,
    ...registry.styles,
    ...(registry.provider ? [registry.provider] : []),
    ...(registry.provider?.evidence ? [registry.provider.evidence] : []),
    ...registry.themeAdapters,
    ...registry.themeAdapters.flatMap(adapter => adapter.evidence ? [adapter.evidence] : []),
    ...(registry.aliases ?? []),
    ...(registry.dependencies ?? []),
    ...(registry.assets ?? []),
  ].map(file => [file.absolutePath.replaceAll('\\', '/'), file]))
  const resolutions = new Map((registry.resolutions ?? []).map(item => [`${item.importer}\0${item.specifier}`, item.absolutePath]))
  const bareResolutions = new Map((registry.packageResolution?.specifiers ?? []).map(item => [item.specifier, item.absolutePath]))
  const packageRoots = (registry.packageResolution?.packages ?? []).map(item => item.root.replaceAll('\\', '/'))
  const assets = new Map((registry.assets ?? []).map(item => [item.absolutePath.replaceAll('\\', '/'), item.publicPath]))
  return {
    name: 'design-editor-verified-module-boundary',
    enforce: /** @type {'pre'} */ ('pre'),
    configResolved(config) {
      base = config.base
    },
    resolveId(source, importer) {
      if (!importer) return null
      const importerPath = importer.split('?')[0].replaceAll('\\', '/')
      const relativeImporter = relative(registry.repositoryRoot, importerPath).replaceAll('\\', '/')
      const resolved = resolutions.get(`${relativeImporter}\0${source}`)
      if (resolved) return resolved
      if (declared.has(importerPath) && bareResolutions.has(source)) return null
      return null
    },
    async buildStart() {
      if (!registry.packageResolution) return
      await verifiedBytes(registry.packageResolution.manifest)
      await verifiedBytes(registry.packageResolution.lockfile)
      for (const item of registry.packageResolution.packages) await verifiedBytes(item)
    },
    async load(id) {
      const path = id.split('?')[0].replaceAll('\\', '/')
      if (entryRoutes.has(path)) return null
      if (path.startsWith('\0')) return null
      const file = declared.get(path)
      if (file) {
        const bytes = await verifiedBytes(file)
        const publicPath = assets.get(path)
        if (publicPath) return `export default ${literal(basePublicPath(base, publicPath))};`
        return bytes.toString('utf8')
      }
      if (roots.some(root => inside(root, path))) return null
      if (packageRoots.some(root => inside(root, path) || root === path)) return null
      throw new Error(`Preview import escaped the verified repository: ${path}`)
    },
  }
}

export function emptyVerifiedRegistry(repositoryRoot) {
  return Object.freeze({ version: 1, repositoryRoot, fingerprint: 'sha256-empty', entry: null, components: Object.freeze([]), styles: Object.freeze([]), provider: undefined, themeAdapters: Object.freeze([]), aliases: Object.freeze([]), dependencies: Object.freeze([]), resolutions: Object.freeze([]), packageResolution: undefined, assets: Object.freeze([]), fonts: Object.freeze([]) })
}
