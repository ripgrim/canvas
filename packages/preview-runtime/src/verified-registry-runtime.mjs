import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const identifier = /^[A-Za-z_$][\w$]{0,127}$/
const componentId = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const forbiddenIds = new Set(['__proto__', 'constructor', 'prototype'])
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx'])
const styleExtensions = new Set(['.css'])
const configExtensions = new Set(['.json'])
const executableExtensions = new Set(sourceExtensions)
const privilegedPackages = new Set([...builtinModules.map(name => name.replace(/^node:/, '')), 'electron'])
const assetMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'font/woff2', 'font/woff', 'font/ttf', 'font/otf'])
const mimeExtensions = new Map([
  ['image/png', new Set(['.png'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/gif', new Set(['.gif'])],
  ['image/webp', new Set(['.webp'])],
  ['image/avif', new Set(['.avif'])],
  ['image/svg+xml', new Set(['.svg'])],
  ['font/woff2', new Set(['.woff2'])],
  ['font/woff', new Set(['.woff'])],
  ['font/ttf', new Set(['.ttf'])],
  ['font/otf', new Set(['.otf'])],
])
const extensionMimes = new Map([...mimeExtensions].flatMap(([mime, extensions]) => [...extensions].map(extension => [extension, mime])))
const dependencyExtensions = new Set([...sourceExtensions, ...styleExtensions, '.json', ...[...mimeExtensions.values()].flatMap(extensions => [...extensions])])
const supportedLockfiles = ['pnpm-lock.yaml', 'package-lock.json']

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function inside(root, candidate) {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function exact(value, required, optional = []) {
  if (!plain(value)) return false
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function jsonValue(value, depth = 0) {
  if (depth > 8) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => jsonValue(item, depth + 1))
  return plain(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && jsonValue(item, depth + 1))
}

function immutableJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson))
  if (plain(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJson(item)])))
  return value
}

function validId(value) {
  return typeof value === 'string' && componentId.test(value) && !forbiddenIds.has(value)
}

function validExport(value) {
  return typeof value === 'string' && identifier.test(value) && !forbiddenIds.has(value)
}

function verifiedProps(value) {
  if (!plain(value) || Object.keys(value).length > 100) throw new Error('Invalid component prop rules')
  const output = {}
  for (const [name, rule] of Object.entries(value)) {
    if (!identifier.test(name) || !exact(rule, ['kind'], ['values', 'optional']) || !['string', 'number', 'boolean', 'enum'].includes(rule.kind) || (Object.hasOwn(rule, 'optional') && typeof rule.optional !== 'boolean')) throw new Error('Invalid component prop rule')
    if (rule.kind === 'enum') {
      if (!Array.isArray(rule.values) || rule.values.length < 1 || rule.values.length > 100 || rule.values.some(item => !['string', 'number', 'boolean'].includes(typeof item) || typeof item === 'number' && !Number.isFinite(item))) throw new Error('Invalid component enum prop rule')
      output[name] = Object.freeze({ kind: 'enum', values: Object.freeze([...rule.values]), ...(Object.hasOwn(rule, 'optional') ? { optional: rule.optional } : {}) })
    } else {
      if (Object.hasOwn(rule, 'values')) throw new Error('Invalid component prop rule')
      output[name] = Object.freeze({ kind: rule.kind, ...(Object.hasOwn(rule, 'optional') ? { optional: rule.optional } : {}) })
    }
  }
  return Object.freeze(output)
}

function verifiedSlots(value) {
  if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length || value.some(item => typeof item !== 'string' || !identifier.test(item))) throw new Error('Invalid component slots')
  return Object.freeze([...value])
}

function safePublicPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.includes('?') && !value.includes('#') && !value.split('/').includes('..') && value.length <= 512
}

function hash(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function sourceHasNamedExport(source, filename, exportName) {
  const kind = ['.tsx', '.jsx'].includes(extname(filename)) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind)
  for (const statement of file.statements) {
    const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    const isDefault = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    if (exported && !isDefault && ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === exportName)) return true
    if (exported && !isDefault && ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === exportName)) return true
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (statement.exportClause.elements.some(element => element.name.text === exportName)) return true
    }
  }
  return false
}

function sourceSpecifiers(source, filename) {
  const kind = ['.tsx', '.jsx'].includes(extname(filename)) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind)
  const specifiers = []
  const inspect = specifier => {
    if (typeof specifier !== 'string') throw new Error(`Dynamic imports need a verified adapter: ${filename}`)
    const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    if (/^(node:|https?:|file:|data:)/i.test(specifier) || isAbsolute(specifier) || privilegedPackages.has(packageName)) throw new Error(`Privileged import is not available in the isolated preview: ${specifier}`)
    specifiers.push(specifier)
  }
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) inspect(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) inspect(node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression) ? node.moduleReference.expression.text : undefined)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) inspect(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

function barePackageName(specifier) {
  if (localSpecifier(specifier)) return null
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  const name = specifier.split('/')[0]
  return name && !specifier.startsWith('/') ? name : null
}

function cssSpecifiers(source, filename) {
  const specifiers = []
  let index = 0
  const whitespace = character => /\s/.test(character)
  const quoted = start => {
    const quote = source[start]
    let value = ''
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') {
        if (cursor + 1 >= source.length) throw new Error(`Invalid stylesheet dependency: ${filename}`)
        value += source[cursor + 1]
        cursor += 1
      } else if (source[cursor] === quote) return { value, end: cursor + 1 }
      else value += source[cursor]
    }
    throw new Error(`Invalid stylesheet dependency: ${filename}`)
  }
  while (index < source.length) {
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) throw new Error(`Invalid stylesheet dependency: ${filename}`)
      index = end + 2
      continue
    }
    const importMatch = source.slice(index).match(/^@import\b/i)
    let urlMatch = source.slice(index).match(/^url\s*\(/i)
    if (!importMatch && !urlMatch) { index += 1; continue }
    index += (importMatch ?? urlMatch)[0].length
    while (index < source.length && whitespace(source[index])) index += 1
    if (importMatch && source.slice(index).match(/^url\s*\(/i)) {
      urlMatch = source.slice(index).match(/^url\s*\(/i)
      index += urlMatch[0].length
      while (index < source.length && whitespace(source[index])) index += 1
    }
    let value = ''
    if (source[index] === '"' || source[index] === "'") {
      const result = quoted(index)
      value = result.value
      index = result.end
    } else {
      if (!urlMatch) throw new Error(`Invalid stylesheet dependency: ${filename}`)
      const closing = source.indexOf(')', index)
      if (closing < 0) throw new Error(`Invalid stylesheet dependency: ${filename}`)
      value = source.slice(index, closing).trim().split(/\s/)[0]
      index = closing + 1
    }
    if (/^(https?:|file:)/i.test(value)) throw new Error(`Privileged import is not available in the isolated preview: ${value}`)
    if (value) specifiers.push(value)
  }
  return specifiers
}

async function verifiedFile(root, path, extensions, expectedIntegrity, kind) {
  if (typeof path !== 'string' || isAbsolute(path)) throw new Error(`${kind} must use a repository-relative path`)
  const candidate = resolve(root, path)
  if (!inside(root, candidate)) throw new Error(`${kind} escapes the verified repository`)
  const absolute = await realpath(candidate)
  if (!inside(root, absolute) || !(await stat(absolute)).isFile()) throw new Error(`${kind} escapes the verified repository`)
  if (!extensions.has(extname(absolute).toLowerCase())) throw new Error(`${kind} has an unsupported file type`)
  const bytes = await readFile(absolute)
  const integrity = hash(bytes)
  if (expectedIntegrity !== undefined && expectedIntegrity !== integrity) throw new Error(`${kind} changed after the registry was generated`)
  return { path: relative(root, absolute).replaceAll('\\', '/'), absolute, integrity, bytes }
}

function localSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

async function resolveDependencyCandidate(root, base) {
  const extension = extname(base).toLowerCase()
  const candidates = extension
    ? [base, ...(extension === '.js' ? ['.ts', '.tsx', '.jsx'].map(next => base.slice(0, -3) + next) : [])]
    : [base, ...[...dependencyExtensions].map(next => base + next), ...[...dependencyExtensions].map(next => resolve(base, `index${next}`))]
  for (const candidate of candidates) {
    try {
      const absolute = await realpath(candidate)
      const details = await stat(absolute)
      if (!inside(root, absolute)) throw new Error('Repository import escapes the verified repository')
      if (!details.isFile() || !dependencyExtensions.has(extname(absolute).toLowerCase())) continue
      return absolute
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      throw error
    }
  }
  return null
}

function aliasMatch(pattern, specifier) {
  if (!pattern.includes('*')) return pattern === specifier ? { capture: '', specificity: pattern.length } : null
  const prefix = pattern.slice(0, -1)
  return specifier.startsWith(prefix) ? { capture: specifier.slice(prefix.length), specificity: prefix.length } : null
}

async function resolveLocalDependency(root, importer, specifier, aliases) {
  if (specifier.includes('?') || specifier.includes('#')) throw new Error(`Repository import needs a verified adapter: ${specifier}`)
  if (localSpecifier(specifier)) {
    const resolved = await resolveDependencyCandidate(root, resolve(dirname(importer), specifier))
    if (!resolved) throw new Error(`Repository import could not be verified: ${specifier}`)
    return resolved
  }
  const candidates = []
  for (const alias of aliases) {
    if (!inside(alias.scopeAbsolute, importer) && alias.scopeAbsolute !== dirname(importer)) continue
    for (const rule of alias.paths) {
      const match = aliasMatch(rule.pattern, specifier)
      if (match) candidates.push({ alias, rule, ...match })
    }
  }
  if (!candidates.length) {
    if (specifier.startsWith('@/') || specifier.startsWith('~/')) throw new Error(`Repository alias has no verified configuration: ${specifier}`)
    return null
  }
  candidates.sort((left, right) => right.alias.scopeAbsolute.length - left.alias.scopeAbsolute.length || right.specificity - left.specificity)
  const selected = candidates[0]
  const competing = candidates[1]
  if (competing && competing.alias.scopeAbsolute.length === selected.alias.scopeAbsolute.length && competing.specificity === selected.specificity) throw new Error(`Repository alias is ambiguous: ${specifier}`)
  const target = selected.rule.target.includes('*') ? selected.rule.target.slice(0, -1) + selected.capture : selected.rule.target
  const resolved = await resolveDependencyCandidate(root, resolve(selected.alias.baseAbsolute, target))
  if (!resolved) throw new Error(`Repository alias target could not be verified: ${specifier}`)
  return resolved
}

async function verifyDependencyGraph(root, roots, aliases) {
  const verifiedRoots = new Map(roots.map(file => [file.absolute, file.integrity]))
  const visited = new Map()
  const resolutions = []
  const cssReferences = []
  const visit = async absolute => {
    if (visited.has(absolute)) return
    const bytes = await readFile(absolute)
    const integrity = hash(bytes)
    if (verifiedRoots.has(absolute) && verifiedRoots.get(absolute) !== integrity) throw new Error(`Registry input changed while its dependency graph was verified: ${absolute}`)
    const path = relative(root, absolute).replaceAll('\\', '/')
    const extension = extname(absolute).toLowerCase()
    const dependency = Object.freeze({ path, absolutePath: absolute, integrity, bytes })
    visited.set(absolute, dependency)
    let specifiers = []
    if (executableExtensions.has(extension)) specifiers = sourceSpecifiers(bytes.toString('utf8'), path)
    else if (extension === '.css') specifiers = cssSpecifiers(bytes.toString('utf8'), path)
    for (const specifier of specifiers) {
      const resolved = await resolveLocalDependency(root, absolute, specifier, aliases)
      if (extension === '.css') cssReferences.push(Object.freeze({ importer: path, specifier, resolvedPath: resolved ? relative(root, resolved).replaceAll('\\', '/') : null }))
      if (resolved) {
        resolutions.push(Object.freeze({ importer: path, specifier, path: relative(root, resolved).replaceAll('\\', '/'), absolutePath: resolved }))
        await visit(resolved)
      }
    }
  }
  for (const rootFile of roots) await visit(rootFile.absolute)
  const bareSpecifiers = new Set()
  for (const absolute of visited.keys()) {
    const dependency = visited.get(absolute)
    if (!executableExtensions.has(extname(absolute).toLowerCase())) continue
    for (const specifier of sourceSpecifiers(dependency.bytes.toString('utf8'), dependency.path)) {
      if (!resolutions.some(item => item.importer === dependency.path && item.specifier === specifier)) {
        const name = barePackageName(specifier)
        if (name) bareSpecifiers.add(specifier)
      }
    }
  }
  return Object.freeze({
    dependencies: Object.freeze([...visited.values()].filter(file => !verifiedRoots.has(file.absolutePath)).sort((left, right) => left.path.localeCompare(right.path))),
    resolutions: Object.freeze(resolutions.sort((left, right) => left.importer.localeCompare(right.importer) || left.specifier.localeCompare(right.specifier))),
    cssReferences: Object.freeze(cssReferences),
    bareSpecifiers: Object.freeze([...bareSpecifiers].sort()),
  })
}

export async function verifyRegistryDependencyClosure(repositoryRoot, request) {
  const root = await realpath(repositoryRoot)
  if (!exact(request, ['roots'], ['aliases']) || !Array.isArray(request.roots) || request.roots.length < 1 || request.roots.length > 10_000) throw new Error('Invalid registry dependency roots')
  const aliases = await verifyAliases(root, request.aliases)
  const roots = []
  const paths = new Set()
  for (const item of request.roots) {
    if (!exact(item, ['path', 'integrity']) || paths.has(item.path)) throw new Error('Invalid registry dependency root')
    paths.add(item.path)
    roots.push(await verifiedFile(root, item.path, dependencyExtensions, item.integrity, 'Registry dependency root'))
  }
  const graph = await verifyDependencyGraph(root, roots, aliases)
  return Object.freeze({ dependencies: graph.dependencies, resolutions: graph.resolutions })
}

function verifiedAliasRule(pattern, target) {
  if (typeof pattern !== 'string' || typeof target !== 'string' || !pattern || !target || isAbsolute(target)) throw new Error('Invalid repository path alias')
  const patternWildcards = [...pattern].filter(character => character === '*').length
  const targetWildcards = [...target].filter(character => character === '*').length
  if (patternWildcards !== targetWildcards || patternWildcards > 1 || patternWildcards === 1 && (!pattern.endsWith('*') || !target.endsWith('*'))) throw new Error(`Repository path alias uses an unsupported wildcard: ${pattern}`)
  return Object.freeze({ pattern, target })
}

async function verifyAliases(root, request) {
  if (!Array.isArray(request ?? []) || (request?.length ?? 0) > 32) throw new Error('Invalid repository path aliases')
  const output = []
  const scopes = new Set()
  for (const item of request ?? []) {
    if (!exact(item, ['configPath', 'baseUrl', 'paths'], ['integrity']) || typeof item.baseUrl !== 'string' || !Array.isArray(item.paths) || item.paths.length < 1 || item.paths.length > 64) throw new Error('Invalid repository path alias configuration')
    const file = await verifiedFile(root, item.configPath, configExtensions, item.integrity, 'Repository module configuration')
    const parsed = ts.parseConfigFileTextToJson(file.path, file.bytes.toString('utf8'))
    if (parsed.error || !plain(parsed.config)) throw new Error('Repository module configuration is invalid')
    const compiler = plain(parsed.config.compilerOptions) ? parsed.config.compilerOptions : {}
    const actualBase = relative(root, resolve(dirname(file.absolute), typeof compiler.baseUrl === 'string' ? compiler.baseUrl : '.')).replaceAll('\\', '/') || '.'
    if (actualBase !== item.baseUrl) throw new Error('Repository module configuration baseUrl does not match its evidence')
    const actualPaths = plain(compiler.paths) ? compiler.paths : {}
    const actualRules = []
    for (const [pattern, targets] of Object.entries(actualPaths)) {
      if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string') throw new Error(`Repository path alias is ambiguous: ${pattern}`)
      actualRules.push(verifiedAliasRule(pattern, targets[0]))
    }
    actualRules.sort((left, right) => left.pattern.localeCompare(right.pattern))
    const requestedRules = item.paths.map(rule => {
      if (!exact(rule, ['pattern', 'target'])) throw new Error('Invalid repository path alias')
      return verifiedAliasRule(rule.pattern, rule.target)
    }).sort((left, right) => left.pattern.localeCompare(right.pattern))
    if (canonicalJson(actualRules) !== canonicalJson(requestedRules)) throw new Error('Repository path aliases do not match their configuration evidence')
    const scopeAbsolute = dirname(file.absolute)
    if (scopes.has(scopeAbsolute)) throw new Error('Repository path alias configuration is ambiguous')
    scopes.add(scopeAbsolute)
    const baseAbsolute = resolve(root, item.baseUrl)
    if (!inside(root, baseAbsolute) && baseAbsolute !== root) throw new Error('Repository path alias baseUrl escapes the verified repository')
    output.push(Object.freeze({ configPath: file.path, absolutePath: file.absolute, integrity: file.integrity, bytes: file.bytes, baseUrl: item.baseUrl, baseAbsolute, scopeAbsolute, paths: Object.freeze(requestedRules) }))
  }
  return Object.freeze(output)
}

function packageManifestDependencies(parsed) {
  const output = new Map()
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = parsed[section]
    if (!plain(dependencies)) continue
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === 'string') output.set(name, range)
    }
  }
  return output
}

function packageFromLockKey(value) {
  const key = value.replace(/^['"]|['"]$/g, '').replace(/^\//, '')
  if (key.startsWith('@')) {
    const separator = key.indexOf('@', key.indexOf('/') + 1)
    return separator > 0 ? { name: key.slice(0, separator), version: key.slice(separator + 1).split('(')[0] } : null
  }
  const separator = key.indexOf('@')
  return separator > 0 ? { name: key.slice(0, separator), version: key.slice(separator + 1).split('(')[0] } : null
}

function addLockedPackage(packages, name, version) {
  if (!name || !version) return
  const versions = packages.get(name) ?? new Set()
  versions.add(version)
  packages.set(name, versions)
}

function pnpmLockedPackages(source) {
  if (!/^lockfileVersion:\s*['"]?[0-9.]+['"]?\s*$/m.test(source) || !/^packages:\s*$/m.test(source)) throw new Error('Repository pnpm lockfile is invalid')
  const packages = new Map()
  let inPackages = false
  for (const line of source.split(/\r?\n/)) {
    if (/^[A-Za-z][\w-]*:\s*$/.test(line)) { inPackages = line === 'packages:'; continue }
    if (!inPackages) continue
    const match = line.match(/^ {2}([^\s].*?):(?:\s.*)?$/)
    if (!match) continue
    const entry = packageFromLockKey(match[1])
    if (entry) addLockedPackage(packages, entry.name, entry.version)
  }
  return packages
}

function packageLockPackages(source) {
  let parsed
  try { parsed = JSON.parse(source) } catch { throw new Error('Repository npm lockfile is invalid') }
  if (!plain(parsed) || !Number.isSafeInteger(parsed.lockfileVersion) || parsed.lockfileVersion < 2 || !plain(parsed.packages)) throw new Error('Repository npm lockfile is invalid')
  const packages = new Map()
  for (const [path, value] of Object.entries(parsed.packages)) {
    if (!path.startsWith('node_modules/') || !plain(value) || typeof value.version !== 'string') continue
    const remainder = path.slice('node_modules/'.length)
    const name = remainder.startsWith('@') ? remainder.split('/').slice(0, 2).join('/') : remainder.split('/')[0]
    if (name) addLockedPackage(packages, name, value.version)
  }
  return packages
}

async function findInstalledPackage(resolvedEntry, expectedName) {
  let directory = dirname(resolvedEntry)
  while (true) {
    const manifestPath = resolve(directory, 'package.json')
    try {
      const absolutePath = await realpath(manifestPath)
      const bytes = await readFile(absolutePath)
      const parsed = JSON.parse(bytes.toString('utf8'))
      if (parsed?.name === expectedName) return Object.freeze({ name: expectedName, root: await realpath(directory), absolutePath, integrity: hash(bytes), bytes, parsed })
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && !(error instanceof SyntaxError)) throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Installed package could not be verified: ${expectedName}`)
    directory = parent
  }
}

async function verifyPackageResolution(root, bareSpecifiers) {
  if (!bareSpecifiers.length) return undefined
  const packageFile = await verifiedFile(root, 'package.json', configExtensions, undefined, 'Repository package manifest')
  let packageManifest
  try { packageManifest = JSON.parse(packageFile.bytes.toString('utf8')) } catch { throw new Error('Repository package manifest is invalid') }
  if (!plain(packageManifest)) throw new Error('Repository package manifest is invalid')
  const declared = packageManifestDependencies(packageManifest)
  const directNames = new Set(bareSpecifiers.map(barePackageName))
  if ([...directNames].some(name => !name || !declared.has(name))) throw new Error('Bare preview imports must be declared by the repository package manifest')

  let lockFile
  for (const lockName of supportedLockfiles) {
    try {
      lockFile = await verifiedFile(root, lockName, new Set(['.yaml', '.json']), undefined, 'Repository package lockfile')
      break
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
  if (!lockFile) throw new Error('Bare preview imports require a supported repository lockfile')
  const lockText = lockFile.bytes.toString('utf8')
  const lockedPackages = lockFile.path.endsWith('.json') ? packageLockPackages(lockText) : pnpmLockedPackages(lockText)
  for (const name of directNames) if (!lockedPackages.has(name)) throw new Error(`Bare preview import is not pinned by the repository lockfile: ${name}`)

  const requireFromRepository = createRequire(packageFile.absolute)
  const specifiers = []
  const installed = new Map()
  const queue = []
  for (const specifier of bareSpecifiers) {
    let resolvedEntry
    try { resolvedEntry = await realpath(requireFromRepository.resolve(specifier)) } catch { throw new Error(`Bare preview import could not be resolved from the repository: ${specifier}`) }
    const name = barePackageName(specifier)
    const details = await findInstalledPackage(resolvedEntry, name)
    if (!lockedPackages.get(name)?.has(details.parsed.version)) throw new Error(`Installed preview package does not match the repository lockfile: ${name}`)
    specifiers.push(Object.freeze({ specifier, packageName: name, absolutePath: resolvedEntry, packageRoot: details.root }))
    if (!installed.has(details.root)) { installed.set(details.root, details); queue.push(details) }
  }
  while (queue.length) {
    const current = queue.shift()
    const dependencies = packageManifestDependencies(current.parsed)
    const requireFromPackage = createRequire(current.absolutePath)
    for (const name of dependencies.keys()) {
      if (!lockedPackages.has(name)) continue
      let resolvedEntry
      try { resolvedEntry = await realpath(requireFromPackage.resolve(name)) } catch { continue }
      const details = await findInstalledPackage(resolvedEntry, name)
      if (!lockedPackages.get(name)?.has(details.parsed.version)) throw new Error(`Installed preview package does not match the repository lockfile: ${name}`)
      if (!installed.has(details.root)) { installed.set(details.root, details); queue.push(details) }
    }
  }
  const packages = [...installed.values()].map(({ parsed: _parsed, ...details }) => Object.freeze(details)).sort((left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root))
  return Object.freeze({
    manifest: Object.freeze({ path: packageFile.path, absolutePath: packageFile.absolute, integrity: packageFile.integrity, bytes: packageFile.bytes }),
    lockfile: Object.freeze({ path: lockFile.path, absolutePath: lockFile.absolute, integrity: lockFile.integrity, bytes: lockFile.bytes }),
    specifiers: Object.freeze(specifiers.sort((left, right) => left.specifier.localeCompare(right.specifier))),
    packages: Object.freeze(packages),
  })
}

async function verifyPreviewEvidence(root, evidence) {
  if (!exact(evidence, ['configPath'], ['integrity'])) throw new Error('Preview integration needs explicit scanner configuration evidence')
  const file = await verifiedFile(root, evidence.configPath, configExtensions, evidence.integrity, 'Preview scanner configuration')
  let config
  try { config = JSON.parse(file.bytes.toString('utf8')) } catch { throw new Error('Preview scanner configuration is invalid') }
  const preview = config?.designEditor?.preview
  if (!plain(preview)) throw new Error('Preview integration is not declared by scanner configuration')
  return { file, preview }
}

/**
 * Turns a repository-relative registry request into an immutable, hash-bound build contract. This function reads files
 * only. It never loads repository configuration, executes source, installs packages, or invokes package scripts.
 */
export async function verifyComponentRegistry(repositoryRoot, request) {
  const root = await realpath(repositoryRoot)
  if (!exact(request, ['version', 'entry', 'components'], ['styles', 'provider', 'themeAdapters', 'aliases', 'dependencies', 'resolutions', 'assets', 'fonts']) || request.version !== 1) throw new Error('Invalid verified component registry')
  const aliases = await verifyAliases(root, request.aliases)
  if (!Array.isArray(request.components) || request.components.length > 500 || request.components.length < 1) throw new Error('A verified component registry needs at least one component')
  if (!exact(request.entry, ['componentId'])) throw new Error('Invalid registry entry')
  const ids = new Set()
  const components = []
  const graphRoots = []
  for (const item of request.components) {
    if (!exact(item, ['componentId', 'entryPath', 'exportName', 'props', 'slots'], ['integrity']) || !validId(item.componentId) || !validExport(item.exportName) || ids.has(item.componentId)) throw new Error('Invalid or duplicate component binding')
    ids.add(item.componentId)
    const file = await verifiedFile(root, item.entryPath, sourceExtensions, item.integrity, `Component ${item.componentId}`)
    const source = file.bytes.toString('utf8')
    sourceSpecifiers(source, item.entryPath)
    if (!sourceHasNamedExport(source, item.entryPath, item.exportName)) throw new Error(`Component export could not be verified: ${item.exportName}`)
    const props = verifiedProps(item.props)
    const slots = verifiedSlots(item.slots)
    components.push(Object.freeze({ componentId: item.componentId, entryPath: item.entryPath, exportName: item.exportName, absolutePath: file.absolute, integrity: file.integrity, bytes: file.bytes, props, slots }))
    graphRoots.push(file)
  }
  if (!validId(request.entry.componentId) || !ids.has(request.entry.componentId)) throw new Error('Registry entry does not name a verified component')
  const styles = []
  for (const item of request.styles ?? []) {
    if (!exact(item, ['path'], ['integrity'])) throw new Error('Invalid registry stylesheet')
    const file = await verifiedFile(root, item.path, styleExtensions, item.integrity, 'Registry stylesheet')
    styles.push(Object.freeze({ path: item.path, absolutePath: file.absolute, integrity: file.integrity, bytes: file.bytes }))
    graphRoots.push(file)
  }
  let provider
  if (request.provider !== undefined) {
    if (!exact(request.provider, ['entryPath', 'exportName', 'evidence'], ['props', 'integrity']) || !validExport(request.provider.exportName) || !plain(request.provider.props ?? {}) || !jsonValue(request.provider.props ?? {})) throw new Error('Invalid registry provider')
    const evidence = await verifyPreviewEvidence(root, request.provider.evidence)
    if (canonicalJson(evidence.preview.provider ?? null) !== canonicalJson({ entryPath: request.provider.entryPath, exportName: request.provider.exportName, props: request.provider.props ?? {} })) throw new Error('Registry provider does not match scanner configuration evidence')
    const file = await verifiedFile(root, request.provider.entryPath, sourceExtensions, request.provider.integrity, 'Registry provider')
    const source = file.bytes.toString('utf8')
    sourceSpecifiers(source, request.provider.entryPath)
    if (!sourceHasNamedExport(source, request.provider.entryPath, request.provider.exportName)) throw new Error(`Provider export could not be verified: ${request.provider.exportName}`)
    provider = Object.freeze({ entryPath: request.provider.entryPath, exportName: request.provider.exportName, props: immutableJson(request.provider.props ?? {}), absolutePath: file.absolute, integrity: file.integrity, bytes: file.bytes, evidence: Object.freeze({ configPath: evidence.file.path, absolutePath: evidence.file.absolute, integrity: evidence.file.integrity, bytes: evidence.file.bytes }) })
    graphRoots.push(file)
  }
  const themeAdapters = []
  if (!Array.isArray(request.themeAdapters ?? []) || (request.themeAdapters?.length ?? 0) > 16) throw new Error('Invalid registry theme adapters')
  for (const item of request.themeAdapters ?? []) {
    if (!exact(item, ['entryPath', 'exportName', 'evidence'], ['integrity']) || !validExport(item.exportName)) throw new Error('Invalid registry theme adapter')
    const evidence = await verifyPreviewEvidence(root, item.evidence)
    if (!Array.isArray(evidence.preview.themeAdapters) || !evidence.preview.themeAdapters.some(adapter => canonicalJson(adapter) === canonicalJson({ entryPath: item.entryPath, exportName: item.exportName }))) throw new Error('Registry theme adapter does not match scanner configuration evidence')
    const file = await verifiedFile(root, item.entryPath, sourceExtensions, item.integrity, 'Registry theme adapter')
    const source = file.bytes.toString('utf8')
    sourceSpecifiers(source, item.entryPath)
    if (!sourceHasNamedExport(source, item.entryPath, item.exportName)) throw new Error(`Theme adapter export could not be verified: ${item.exportName}`)
    themeAdapters.push(Object.freeze({ entryPath: item.entryPath, exportName: item.exportName, absolutePath: file.absolute, integrity: file.integrity, bytes: file.bytes, evidence: Object.freeze({ configPath: evidence.file.path, absolutePath: evidence.file.absolute, integrity: evidence.file.integrity, bytes: evidence.file.bytes }) }))
    graphRoots.push(file)
  }
  const assets = []
  const assetIds = new Set()
  const publicPaths = new Set()
  if (!Array.isArray(request.assets ?? []) || (request.assets?.length ?? 0) > 256) throw new Error('Invalid registry assets')
  for (const item of request.assets ?? []) {
    if (!exact(item, ['assetId', 'sourcePath', 'publicPath', 'mime'], ['integrity']) || !validId(item.assetId) || assetIds.has(item.assetId) || publicPaths.has(item.publicPath) || !safePublicPath(item.publicPath) || !assetMimes.has(item.mime)) throw new Error('Invalid or duplicate registry asset')
    assetIds.add(item.assetId)
    publicPaths.add(item.publicPath)
    const file = await verifiedFile(root, item.sourcePath, mimeExtensions.get(item.mime), item.integrity, `Registry asset ${item.assetId}`)
    assets.push(Object.freeze({ ...item, absolutePath: file.absolute, integrity: file.integrity, bytes: file.bytes }))
  }
  const fonts = []
  if (!Array.isArray(request.fonts ?? []) || (request.fonts?.length ?? 0) > 64) throw new Error('Invalid registry fonts')
  for (const item of request.fonts ?? []) {
    if (!exact(item, ['family', 'assetId'], ['weight', 'style', 'display']) || typeof item.family !== 'string' || !/^[\w .-]{1,128}$/.test(item.family) || !assetIds.has(item.assetId) || (item.weight !== undefined && (typeof item.weight !== 'string' || !/^([1-9]00)( ([1-9]00))?$/.test(item.weight))) || (item.style !== undefined && !['normal', 'italic', 'oblique'].includes(item.style)) || (item.display !== undefined && !['auto', 'block', 'swap', 'fallback', 'optional'].includes(item.display))) throw new Error('Invalid registry font')
    const asset = assets.find(candidate => candidate.assetId === item.assetId)
    if (!asset?.mime.startsWith('font/')) throw new Error('Registry font must reference a font asset')
    fonts.push(Object.freeze({ family: item.family, assetId: item.assetId, weight: item.weight ?? '400', style: item.style ?? 'normal', display: item.display ?? 'swap' }))
  }
  const entry = components.find(item => item.componentId === request.entry.componentId)
  const graph = await verifyDependencyGraph(root, graphRoots, aliases)
  const packageResolution = await verifyPackageResolution(root, [...new Set([
    ...graph.bareSpecifiers,
    'react',
    'react-dom',
    'react-dom/client',
  ])])
  const dependencies = graph.dependencies
  if (request.dependencies !== undefined) {
    if (!Array.isArray(request.dependencies) || request.dependencies.length > 2_000) throw new Error('Invalid verified dependency pins')
    const pins = request.dependencies.map(item => {
      if (!exact(item, ['path', 'integrity']) || typeof item.path !== 'string' || typeof item.integrity !== 'string') throw new Error('Invalid verified dependency pin')
      return item
    }).sort((left, right) => left.path.localeCompare(right.path))
    const discovered = dependencies.map(({ path, integrity }) => ({ path, integrity }))
    if (canonicalJson(pins) !== canonicalJson(discovered)) throw new Error('Verified dependency graph changed after the registry was generated')
  }
  if (request.resolutions !== undefined) {
    if (!Array.isArray(request.resolutions) || request.resolutions.length > 50_000) throw new Error('Invalid verified import resolutions')
    const requested = request.resolutions.map(item => {
      if (!exact(item, ['importer', 'specifier', 'path']) || typeof item.importer !== 'string' || typeof item.specifier !== 'string' || typeof item.path !== 'string') throw new Error('Invalid verified import resolution')
      return item
    })
    const discovered = graph.resolutions.map(({ importer, specifier, path }) => ({ importer, specifier, path }))
    if (canonicalJson(requested) !== canonicalJson(discovered)) throw new Error('Verified import resolutions changed after the registry was generated')
  }
  const staticallyReferenced = new Set([
    ...graph.cssReferences.map(reference => reference.specifier),
    ...graph.resolutions.map(resolution => resolution.path),
  ])
  for (const asset of assets) {
    if (!staticallyReferenced.has(asset.publicPath) && !staticallyReferenced.has(asset.sourcePath)) throw new Error(`Registry asset is not statically referenced by the verified graph: ${asset.sourcePath}`)
  }
  const declaredAssetPaths = new Set(assets.map(asset => asset.sourcePath))
  for (const dependency of dependencies) {
    const mime = extensionMimes.get(extname(dependency.path).toLowerCase())
    if (!mime || declaredAssetPaths.has(dependency.path)) continue
    const extension = extname(dependency.path).toLowerCase()
    const assetId = `asset:${shortHash(dependency.path)}`
    const publicPath = `/registry-assets/${shortHash(dependency.path)}${extension}`
    assets.push(Object.freeze({ assetId, sourcePath: dependency.path, publicPath, mime, absolutePath: dependency.absolutePath, integrity: dependency.integrity, bytes: dependency.bytes }))
    declaredAssetPaths.add(dependency.path)
  }
  const contract = { version: 1, entry: { componentId: entry.componentId }, components: components.map(({ componentId, entryPath, exportName, integrity, props, slots }) => ({ componentId, entryPath, exportName, integrity, props, slots })), styles: styles.map(({ path, integrity }) => ({ path, integrity })), provider: provider ? { entryPath: provider.entryPath, exportName: provider.exportName, integrity: provider.integrity, props: provider.props, evidence: { configPath: provider.evidence.configPath, integrity: provider.evidence.integrity } } : null, themeAdapters: themeAdapters.map(({ entryPath, exportName, integrity, evidence }) => ({ entryPath, exportName, integrity, evidence: { configPath: evidence.configPath, integrity: evidence.integrity } })), aliases: aliases.map(({ configPath, integrity, baseUrl, paths }) => ({ configPath, integrity, baseUrl, paths })), dependencies: dependencies.map(({ path, integrity }) => ({ path, integrity })), resolutions: graph.resolutions.map(({ importer, specifier, path }) => ({ importer, specifier, path })), packageResolution: packageResolution ? { manifest: { path: packageResolution.manifest.path, integrity: packageResolution.manifest.integrity }, lockfile: { path: packageResolution.lockfile.path, integrity: packageResolution.lockfile.integrity }, specifiers: packageResolution.specifiers.map(({ specifier, packageName }) => ({ specifier, packageName })), packages: packageResolution.packages.map(({ name, integrity }) => ({ name, integrity })) } : null, assets: assets.map(({ assetId, sourcePath, publicPath, mime, integrity }) => ({ assetId, sourcePath, publicPath, mime, integrity })), fonts }
  const fingerprint = hash(Buffer.from(canonicalJson(contract)))
  return Object.freeze({ version: 1, repositoryRoot: root, fingerprint, entry, components: Object.freeze(components), styles: Object.freeze(styles), provider, themeAdapters: Object.freeze(themeAdapters), aliases, dependencies, resolutions: graph.resolutions, packageResolution, assets: Object.freeze(assets), fonts: Object.freeze(fonts) })
}

export function registryRequestFromPreviewBinding(binding) {
  const repeatedEntry = (binding.registry ?? []).find(item => item.componentId === binding.componentId)
  if (repeatedEntry && (repeatedEntry.entryPath !== binding.entryPath || repeatedEntry.exportName !== binding.exportName)) throw new Error('Registry entry conflicts with the selected component binding')
  if (!repeatedEntry || !Object.hasOwn(repeatedEntry, 'props') || !Object.hasOwn(repeatedEntry, 'slots')) throw new Error('Selected component binding needs explicit props and slots')
  const components = [{ componentId: binding.componentId, entryPath: binding.entryPath, exportName: binding.exportName, props: repeatedEntry.props, slots: repeatedEntry.slots }, ...(binding.registry ?? []).filter(item => item.componentId !== binding.componentId)]
  return {
    version: 1,
    entry: { componentId: binding.componentId },
    components,
    styles: (binding.styles ?? []).map(path => ({ path })),
    ...(binding.provider ? { provider: binding.provider } : {}),
    ...(binding.themeAdapters ? { themeAdapters: binding.themeAdapters } : {}),
    ...(binding.aliases ? { aliases: binding.aliases } : {}),
    ...(binding.dependencies ? { dependencies: binding.dependencies } : {}),
    ...(binding.resolutions ? { resolutions: binding.resolutions } : {}),
    ...(binding.assets ? { assets: binding.assets } : {}),
    ...(binding.fonts ? { fonts: binding.fonts } : {}),
  }
}

/** Loads a generated registry JSON file. Missing paths return null so production builds can stay empty and honest. */
export async function loadVerifiedRegistryManifest(manifestPath) {
  if (!manifestPath) return null
  const absoluteManifest = await realpath(resolve(manifestPath))
  const request = JSON.parse(await readFile(absoluteManifest, 'utf8'))
  if (!exact(request, ['repositoryRoot', 'registry']) || typeof request.repositoryRoot !== 'string') throw new Error('Invalid generated registry manifest')
  const repositoryRoot = resolve(dirname(absoluteManifest), request.repositoryRoot)
  return verifyComponentRegistry(repositoryRoot, request.registry)
}
