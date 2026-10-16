import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { posix, relative, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import { hostedPreviewDefaultProps } from './contract.mjs'

const workspace = '/workspace'
const outputRoot = '/tmp/canvas-hosted-preview'
const maximumInputBytes = 4 * 1024 * 1024
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,512}$/u

const input = await readInput()
const request = exact(input.request, ['version', 'entry', 'components', 'styles'], ['aliases', 'dependencies', 'resolutions', 'provider', 'themeAdapters'])
if (input.artifactId === undefined || !/^[0-9a-f-]{36}$/.test(input.artifactId) || !/^[a-f0-9]{40}$/.test(input.sourceRevision)
  || !/^sha256:[a-f0-9]{64}$/.test(input.registryFingerprint) || request.version !== 1) invalid('Build contract is invalid.')
const components = list(request.components, 5_000).map(component => exact(component, ['componentId', 'entryPath', 'exportName', 'integrity', 'props', 'slots']))
if (!components.length || !components.some(component => component.componentId === request.entry?.componentId)) invalid('Build contract is invalid.')
const styles = list(request.styles, 10_000).map(source)
const dependencies = list(request.dependencies ?? [], 10_000).map(source)
const aliases = list(request.aliases ?? [], 64).map(alias => exact(alias, ['configPath', 'integrity', 'baseUrl', 'paths']))
const resolutions = list(request.resolutions ?? [], 50_000).map(resolution => exact(resolution, ['importer', 'specifier', 'path']))
const provider = request.provider === undefined ? undefined : exact(request.provider, ['entryPath', 'exportName', 'props', 'integrity', 'evidence'])
const themeAdapters = list(request.themeAdapters ?? [], 16).map(adapter => exact(adapter, ['entryPath', 'exportName', 'integrity', 'evidence']))
const verifiedSources = new Map()

for (const component of components) await cacheSource(component.entryPath, component.integrity)
for (const item of [...styles, ...dependencies]) await cacheSource(item.path, item.integrity)
for (const alias of aliases) await cacheSource(alias.configPath, alias.integrity)
if (provider) {
  await cacheSource(provider.entryPath, provider.integrity)
  await cacheSource(provider.evidence.configPath, provider.evidence.integrity)
}
for (const adapter of themeAdapters) {
  await cacheSource(adapter.entryPath, adapter.integrity)
  await cacheSource(adapter.evidence.configPath, adapter.evidence.integrity)
}

const entrySource = createEntrySource({ components, styles, provider })
const result = await build({
  stdin: { contents: entrySource, loader: 'tsx', resolveDir: workspace, sourcefile: 'canvas-hosted-preview.tsx' },
  absWorkingDir: workspace,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  write: false,
  outdir: `${outputRoot}/assets`,
  entryNames: 'components',
  assetNames: '[name]-[hash]',
  nodePaths: ['/builder/node_modules'],
  loader: { '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.svg': 'file', '.webp': 'file', '.woff2': 'file' },
  plugins: [verifiedWorkspacePlugin(aliases, resolutions, verifiedSources)],
  logLevel: 'silent',
})

const output = new Map()
for (const file of result.outputFiles) {
  const path = relative(outputRoot, file.path).split(sep).join('/')
  if (!pathPattern.test(path) || output.has(path)) invalid('Build output is invalid.')
  output.set(path, new Uint8Array(file.contents))
}
if (!output.has('assets/components.js')) invalid('Build output is invalid.')
const stylesheet = output.has('assets/components.css') ? '<link rel="stylesheet" href="./components.css">' : ''
output.set('index.html', new TextEncoder().encode(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="./assets/">${stylesheet}</head><body><div id="root"></div><script type="module" src="./components.js"></script></body></html>`))

const files = [...output].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
  path,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.byteLength,
  contentType: contentType(path),
}))
const manifest = {
  version: 1,
  sourceRevision: input.sourceRevision,
  registryFingerprint: input.registryFingerprint,
  entrypoint: 'index.html',
  files,
  components: components.map(component => ({ componentId: component.componentId, modulePath: 'assets/components.js', exportName: component.exportName })),
}
process.stdout.write(JSON.stringify({ manifest, files: [...output].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString('base64') })) }))

function createEntrySource(options) {
  const lines = [
    "import React from 'react'",
    "import { createRoot } from 'react-dom/client'",
    ...options.styles.map(item => `import ${JSON.stringify(`/workspace/${item.path}`)}`),
    ...options.components.map((component, index) => `import { ${component.exportName} as Component${index} } from ${JSON.stringify(`/workspace/${component.entryPath}`)}`),
  ]
  if (options.provider) lines.push(`import { ${options.provider.exportName} as PreviewProvider } from ${JSON.stringify(`/workspace/${options.provider.entryPath}`)}`)
  lines.push(`const registry = {${options.components.map((component, index) => `${JSON.stringify(component.componentId)}: Component${index}`).join(',')}}`)
  lines.push('Object.defineProperty(window, "__COMP_CANVAS_COMPONENTS__", { value: Object.freeze(registry), configurable: false })')
  const entryIndex = options.components.findIndex(component => component.componentId === request.entry.componentId)
  const props = hostedPreviewDefaultProps(options.components[entryIndex].props)
  const component = `React.createElement(Component${entryIndex}, ${JSON.stringify(props)})`
  const rendered = options.provider ? `React.createElement(PreviewProvider, ${JSON.stringify(options.provider.props)}, ${component})` : component
  lines.push(`createRoot(document.getElementById('root')).render(${rendered})`)
  return lines.join('\n')
}

function verifiedWorkspacePlugin(values, resolutionValues, sources) {
  const rules = values.flatMap(alias => {
    const scope = posix.dirname(alias.configPath)
    return list(alias.paths, 128).map(rule => exact(rule, ['pattern', 'target'])).map(rule => ({ ...rule, scope }))
  })
  const resolutions = new Map()
  for (const resolution of resolutionValues) {
    if (!pathPattern.test(resolution.importer) || typeof resolution.specifier !== 'string' || resolution.specifier.length < 1 || resolution.specifier.length > 512 || !pathPattern.test(resolution.path)) invalid('Build contract is invalid.')
    const identity = `${resolution.importer}\0${resolution.specifier}`
    if (resolutions.has(identity) || !sources.has(resolution.importer) || !sources.has(resolution.path)) invalid('Build contract is invalid.')
    resolutions.set(identity, resolution.path)
  }
  return { name: 'canvas-verified-aliases', setup(context) {
    context.onResolve({ filter: /.*/ }, args => {
      let candidate
      if (args.path.startsWith(`${workspace}/`)) candidate = args.path.slice(workspace.length + 1)
      else {
        const importer = args.importer.startsWith(`${workspace}/`) ? args.importer.slice(workspace.length + 1) : null
        if (!importer) return
        candidate = resolutions.get(`${importer}\0${args.path}`)
        if (!candidate) {
          const localOrAlias = args.path.startsWith('.') || rules.some(rule => aliasScopeContains(rule.scope, importer) && aliasPatternMatches(rule.pattern, args.path))
          if (localOrAlias) throw new Error(`Hosted preview import is undeclared: ${args.path}`)
          return
        }
      }
      const resolved = resolveDeclared(candidate, sources)
      if (!resolved) throw new Error(`Hosted preview import is undeclared: ${args.path}`)
      return { path: `${workspace}/${resolved}`, namespace: 'verified-workspace' }
    })
    context.onLoad({ filter: /.*/, namespace: 'verified-workspace' }, args => {
      const relative = args.path.slice(workspace.length + 1)
      const bytes = sources.get(relative)
      if (!bytes) throw new Error(`Hosted preview source is undeclared: ${relative}`)
      return { contents: bytes, loader: loader(relative), resolveDir: `${workspace}/${posix.dirname(relative)}` }
    })
  } }
}

function aliasScopeContains(scope, importer) {
  return scope === '.' || importer.startsWith(`${scope}/`)
}

function aliasPatternMatches(pattern, specifier) {
  const star = pattern.indexOf('*')
  return star < 0 ? pattern === specifier : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
}

function resolveDeclared(candidate, sources) {
  if (!pathPattern.test(candidate)) return null
  if (sources.has(candidate)) return candidate
  if (posix.extname(candidate)) return null
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff2']) {
    if (sources.has(`${candidate}${extension}`)) return `${candidate}${extension}`
    const index = posix.join(candidate, `index${extension}`)
    if (sources.has(index)) return index
  }
  return null
}

function loader(path) {
  const extension = posix.extname(path).toLowerCase()
  const loaders = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js', '.json': 'json', '.css': 'css', '.svg': 'file', '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.webp': 'file', '.woff2': 'file' }
  const selected = loaders[extension]
  if (!selected) invalid('Build input type is unsupported.')
  return selected
}

async function cacheSource(path, integrity) {
  if (typeof path !== 'string' || !pathPattern.test(path) || typeof integrity !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(integrity)) invalid('Build contract is invalid.')
  const candidate = resolve(workspace, ...path.split('/'))
  const canonical = await realpath(candidate)
  if (canonical !== workspace && !canonical.startsWith(`${workspace}${sep}`)) invalid('Build source is invalid.')
  const bytes = await readFile(canonical)
  if (`sha256-${createHash('sha256').update(bytes).digest('base64')}` !== integrity) invalid('Build source integrity changed.')
  const prior = verifiedSources.get(path)
  if (prior && !Buffer.from(prior).equals(bytes)) invalid('Build source identity changed.')
  verifiedSources.set(path, new Uint8Array(bytes))
}

function source(value) { return exact(value, ['path', 'integrity']) }
function list(value, maximum) { if (!Array.isArray(value) || value.length > maximum) invalid('Build contract is invalid.'); return value }
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Build contract is invalid.')
  const keys = Object.keys(value)
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) invalid('Build contract is invalid.')
  return value
}
function contentType(path) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' }
  const type = types[posix.extname(path).toLowerCase()]
  if (!type) invalid('Build output type is unsupported.')
  return type
}
async function readInput() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) { length += chunk.byteLength; if (length > maximumInputBytes) invalid('Build input is too large.'); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { invalid('Build input is invalid.') }
}
function invalid(message) { throw new Error(message) }
