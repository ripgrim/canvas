import { builtinModules } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const normalize = name => path.posix.normalize(name.replaceAll('\\', '/'))
const isTest = name => /(?:^|\/)__tests__\//.test(name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
const serverOnly = name => /(?:^|\/)server\//.test(name) || /\.server(?:\.[^/]*)?$/.test(name)
const privilegedFile = name => /^apps\/desktop\/(?:src\/)?(?:main|preload)(?:\/|\.|$)/.test(name) || /^packages\/(?:repo-engine|preview-runtime)\/(?:src|dist)\/index\.[cm]?[jt]s$/.test(name)
const browserEntry = name => /^(?:packages\/editor\/src|apps\/web\/(?:src|preview)|apps\/desktop\/src\/renderer)\//.test(name) && !isTest(name) && !serverOnly(name)
const assets = /\.(?:css|scss|sass|less|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|mp4|webm|json)(?:[?#].*)?$/i

function prohibited(specifier) {
  if (specifier === 'server-only') return 'Server-only module import is forbidden in browser code'
  if (specifier.startsWith('node:') || builtins.has(specifier.split('?')[0])) return 'Node built-in import is forbidden in browser code'
  if (specifier === 'electron' || specifier.startsWith('electron/')) return 'Electron import is forbidden in browser code'
  if ((specifier === '@canvas/repo-engine' || specifier.startsWith('@canvas/repo-engine/')) && !['@canvas/repo-engine/document', '@canvas/repo-engine/contracts', '@canvas/repo-engine/design-themes', '@canvas/repo-engine/file-document', '@canvas/repo-engine/appearance', '@canvas/repo-engine/file-migration', '@canvas/repo-engine/file-preview', '@canvas/repo-engine/color', '@canvas/repo-engine/order-keys', '@canvas/repo-engine/layout', '@canvas/repo-engine/grid-tracks', '@canvas/repo-engine/grid-placement', '@canvas/repo-engine/flex-inference', '@canvas/repo-engine/layout-matrix', '@canvas/repo-engine/layout-css', '@canvas/repo-engine/node-theme'].includes(specifier)) return 'Use a browser-safe repo-engine contract subpath'
  if ((specifier === '@canvas/preview-runtime' || specifier.startsWith('@canvas/preview-runtime/')) && !['@canvas/preview-runtime/protocol', '@canvas/preview-runtime/browser', '@canvas/preview-runtime/browser-contracts'].includes(specifier)) return 'Use a browser-safe preview-runtime subpath'
  if (specifier === '@canvas/auth/electron' || specifier === '@canvas/auth/server' || specifier === '@canvas/auth/hosted') return 'Privileged auth implementation is forbidden in browser code'
  if (serverOnly(specifier)) return 'Server-only module import is forbidden in browser code'
  if (/^(?:pg|postgres)(?:\/|$)/.test(specifier) || specifier === 'better-auth' || /^better-auth\/(?:adapters|node)(?:\/|$)/.test(specifier)) return 'Hosted database or auth server import is forbidden in browser code'
  return null
}

function importEdges(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const declarations = new Map()
  const bindingCounts = new Map()
  const mutated = new Set()
  const aliases = new Set(['require'])
  const edges = []
  const assignments = []
  const unwrap = expression => {
    while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression))) expression = expression.expression
    return expression
  }
  const memberName = expression => ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : null
  const loader = value => {
    const expression = unwrap(value)
    if (!expression) return false
    if (ts.isIdentifier(expression)) return aliases.has(expression.text)
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && memberName(expression) === 'require' && ['module', 'globalThis', 'window'].includes(expression.expression.getText(file))) return true
    if (ts.isCallExpression(expression) && memberName(expression.expression) === 'bind') return loader(expression.expression.expression)
    return false
  }
  function gather(node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) bindingCounts.set(node.name.text, (bindingCounts.get(node.name.text) ?? 0) + 1)
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        if (ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) declarations.set(node.name.text, node.initializer)
        assignments.push([node.name.text, node.initializer])
      } else if (ts.isObjectBindingPattern(node.name) && ['module', 'globalThis', 'window'].includes(node.initializer.getText(file))) {
        for (const binding of node.name.elements) if ((binding.propertyName?.getText(file).replace(/^['"]|['"]$/g, '') ?? binding.name.getText(file)) === 'require' && ts.isIdentifier(binding.name)) aliases.add(binding.name.text)
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) { assignments.push([node.left.text, node.right]); mutated.add(node.left.text) }
    ts.forEachChild(node, gather)
  }
  gather(file)
  for (let pass = 0; pass <= assignments.length; pass++) {
    let changed = false
    for (const [name, value] of assignments) if (!aliases.has(name) && loader(value)) { aliases.add(name); changed = true }
    if (!changed) break
  }
  function literal(value, active = new Set()) {
    const expression = unwrap(value)
    if (!expression) return null
    if (ts.isStringLiteralLike(expression)) return expression.text
    if (ts.isIdentifier(expression) && declarations.has(expression.text) && bindingCounts.get(expression.text) === 1 && !mutated.has(expression.text) && !active.has(expression.text)) {
      const next = new Set(active).add(expression.text)
      return literal(declarations.get(expression.text), next)
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(expression.left, active), right = literal(expression.right, active)
      return left === null || right === null ? null : left + right
    }
    if (ts.isTemplateExpression(expression)) {
      let result = expression.head.text
      for (const span of expression.templateSpans) {
        const value = literal(span.expression, active)
        if (value === null) return null
        result += value + span.literal.text
      }
      return result
    }
    return null
  }
  const add = (node, expression, kind) => edges.push({ specifier: literal(expression), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, kind })
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node, node.moduleSpecifier, 'static')
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression, 'require')
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal, 'type')
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], 'dynamic')
      else if (['glob', 'globEager'].includes(memberName(node.expression)) && node.expression.expression.getText(file) === 'import.meta') add(node, undefined, 'glob')
      else if (loader(node.expression)) add(node, node.arguments[0], 'require')
      else if (['call', 'apply', 'resolve'].includes(memberName(node.expression)) && loader(node.expression.expression)) {
        const member = memberName(node.expression)
        const argument = member === 'call' ? node.arguments[1] : member === 'apply' && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) ? node.arguments[1].elements[0] : member === 'resolve' ? node.arguments[0] : undefined
        add(node, argument, 'require')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { edges, parseErrors: file.parseDiagnostics.map(error => ({ line: file.getLineAndCharacterOfPosition(error.start ?? 0).line + 1, message: ts.flattenDiagnosticMessageText(error.messageText, ' ') })) }
}

function sourceCandidate(sources, candidate) {
  const target = normalize(candidate)
  const candidates = [target]
  if (/\.[cm]?jsx?$/.test(target)) candidates.push(...extensions.map(extension => target.replace(/\.[cm]?jsx?$/, extension)))
  if (/\.d\.[cm]?ts$/.test(target)) candidates.push(target.replace(/\.d\.[cm]?ts$/, '.ts'))
  if (!extensions.some(extension => target.endsWith(extension))) candidates.push(...extensions.map(extension => target + extension), ...extensions.map(extension => `${target}/index${extension}`))
  return candidates.find(name => sources.has(name)) ?? null
}

function packageTarget(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') for (const condition of ['browser', 'source', 'import', 'default', 'types']) if (condition in value) {
    const target = packageTarget(value[condition])
    if (target) return target
  }
  return null
}

function graphResolver(sources) {
  const packages = new Map()
  const aliases = []
  for (const [filename, source] of sources) if (/^(?:packages|apps)\/[^/]+\/package\.json$/.test(filename)) {
    const manifest = JSON.parse(source)
    if (typeof manifest.name === 'string') packages.set(manifest.name, { directory: path.posix.dirname(filename), exports: manifest.exports })
  }
  for (const [filename, source] of sources) if (/(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(filename)) {
    const config = ts.parseConfigFileTextToJson(filename, source).config
    const directory = path.posix.dirname(filename)
    for (const [pattern, targets] of Object.entries(config?.compilerOptions?.paths ?? {})) if (Array.isArray(targets)) aliases.push({ directory, pattern, targets, base: normalize(path.posix.join(directory, config.compilerOptions.baseUrl ?? '.')) })
  }
  aliases.sort((left, right) => right.directory.length - left.directory.length)
  const known = {
    '@canvas/repo-engine/document': 'packages/repo-engine/src/document.ts',
    '@canvas/repo-engine/contracts': 'packages/repo-engine/src/contracts.ts',
    '@canvas/repo-engine/design-themes': 'packages/repo-engine/src/design-themes.ts',
    '@canvas/repo-engine/file-document': 'packages/repo-engine/src/file-document.ts',
    '@canvas/repo-engine/appearance': 'packages/repo-engine/src/appearance.ts',
    '@canvas/repo-engine/file-migration': 'packages/repo-engine/src/file-migration.ts',
    '@canvas/repo-engine/file-preview': 'packages/repo-engine/src/file-preview.ts',
    '@canvas/repo-engine/color': 'packages/repo-engine/src/color.ts',
    '@canvas/repo-engine/order-keys': 'packages/repo-engine/src/order-keys.ts',
    '@canvas/repo-engine/layout': 'packages/repo-engine/src/layout.ts',
    '@canvas/repo-engine/grid-tracks': 'packages/repo-engine/src/grid-tracks.ts',
    '@canvas/repo-engine/grid-placement': 'packages/repo-engine/src/grid-placement.ts',
    '@canvas/repo-engine/flex-inference': 'packages/repo-engine/src/flex-inference.ts',
    '@canvas/repo-engine/layout-matrix': 'packages/repo-engine/src/layout-matrix.ts',
    '@canvas/repo-engine/layout-css': 'packages/repo-engine/src/layout-css.ts',
    '@canvas/repo-engine/node-theme': 'packages/repo-engine/src/node-theme.ts',
    '@canvas/preview-runtime/protocol': 'packages/preview-runtime/src/protocol.ts',
    '@canvas/preview-runtime/browser': 'packages/preview-runtime/src/browser-runtime.mjs',
    '@canvas/preview-runtime/browser-contracts': 'packages/preview-runtime/src/browser-contracts.ts',
  }
  return (from, specifier) => {
    const clean = specifier.split(/[?#]/)[0]
    if (clean.startsWith('.')) return sourceCandidate(sources, path.posix.join(path.posix.dirname(from), clean))
    for (const alias of aliases) {
      if (alias.directory !== '.' && !from.startsWith(`${alias.directory}/`)) continue
      const [prefix, suffix = ''] = alias.pattern.split('*')
      const matches = alias.pattern.includes('*') ? specifier.startsWith(prefix) && specifier.endsWith(suffix) : specifier === alias.pattern
      if (!matches) continue
      const captured = alias.pattern.includes('*') ? specifier.slice(prefix.length, suffix ? -suffix.length : undefined) : ''
      const candidates = alias.targets.filter(target => typeof target === 'string').map(target => normalize(path.posix.join(alias.base, target.replace('*', captured))))
      for (const candidate of candidates) { const found = sourceCandidate(sources, candidate); if (found) return found }
      return candidates[0] ?? null
    }
    if (known[clean]) return sourceCandidate(sources, known[clean])
    for (const [name, metadata] of packages) if (clean === name || clean.startsWith(`${name}/`)) {
      const subpath = clean === name ? '.' : `.${clean.slice(name.length)}`
      const exported = metadata.exports && typeof metadata.exports === 'object' && Object.keys(metadata.exports).some(key => key.startsWith('.')) ? metadata.exports[subpath] : subpath === '.' ? metadata.exports : undefined
      const target = packageTarget(exported)
      if (target) return sourceCandidate(sources, path.posix.join(metadata.directory, target.replace(/^\.\/dist\//, './src/')))
    }
    return null
  }
}

export function checkRuntimeGraph(input, options = {}) {
  const sources = new Map([...(input instanceof Map ? input : Object.entries(input))].map(([name, source]) => [normalize(name), source]))
  const resolve = options.resolve ?? graphResolver(sources)
  const entries = options.entries ?? [...sources.keys()].filter(name => browserEntry(name) && extensions.some(extension => name.endsWith(extension)))
  const diagnostics = []
  const visited = new Set()
  function visit(filename, chain) {
    const name = normalize(filename)
    if (visited.has(name)) return
    visited.add(name)
    if (!sources.has(name)) { diagnostics.push(`${name}:1: Unresolved browser entry`); return }
    const parsed = importEdges(sources.get(name), name)
    for (const error of parsed.parseErrors) diagnostics.push(`${name}:${error.line}: Invalid browser module syntax: ${error.message}`)
    for (const edge of parsed.edges) {
      const at = `${name}:${edge.line}`
      if (edge.specifier === null) { diagnostics.push(`${at}: Nonliteral ${edge.kind} import cannot be verified`); continue }
      const forbidden = prohibited(edge.specifier)
      if (forbidden) { diagnostics.push(`${at}: ${forbidden}: ${edge.specifier}`); continue }
      if (assets.test(edge.specifier)) continue
      const resolved = resolve(name, edge.specifier)
      if (!resolved) {
        if (/^(?:\.|\/|#|@\/|@design-editor\/|[A-Za-z]:[\\/]|file:)/.test(edge.specifier)) diagnostics.push(`${at}: Unresolved first-party import: ${edge.specifier}`)
        continue
      }
      const target = normalize(resolved)
      if (serverOnly(target)) {
        diagnostics.push(`${at}: Server-only module reached through browser graph: ${[...chain, name, target].join(' -> ')}`); continue
      }
      if (privilegedFile(target)) { diagnostics.push(`${at}: Privileged desktop or engine module reached through browser graph: ${target}`); continue }
      if (isTest(target)) { diagnostics.push(`${at}: Browser module imports test-only code: ${target}`); continue }
      visit(target, [...chain, name])
    }
  }
  for (const entry of entries) if (!isTest(entry)) visit(entry, [])
  return [...new Set(diagnostics)]
}

export async function readRuntimeSources(directory = root) {
  const sources = new Map()
  async function scan(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'coverage', '.git', '.design-editor', '.output', '.tanstack'].includes(entry.name) || entry.isSymbolicLink()) continue
      const filename = path.join(current, entry.name)
      if (entry.isDirectory()) await scan(filename)
      else if (extensions.some(extension => entry.name.endsWith(extension)) || entry.name === 'package.json' || /^tsconfig(?:\..*)?\.json$/.test(entry.name)) sources.set(normalize(path.relative(directory, filename)), await readFile(filename, 'utf8'))
    }
  }
  await scan(directory)
  return sources
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkRuntimeGraph(await readRuntimeSources())
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exitCode = 1
  } else console.log('Browser runtime boundaries passed')
}
