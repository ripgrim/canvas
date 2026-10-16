import { createHash } from 'node:crypto'
import { hostedPreviewCatalogFingerprint, type HostedPreviewArtifactExpectation } from '@canvas/preview-runtime/hosted-artifact'
import type { ShadcnPreviewRegistryRequest, ShadcnScan } from './contracts.js'
import { registryRequestFromShadcnScan, shadcnPreviewPropRule, shadcnPreviewRegistryComponent } from './preview-registry.js'

export type ShadcnScanArtifact = Readonly<{
  sourceRevision: string
  scan: ShadcnScan
  request: ShadcnPreviewRegistryRequest
}>

const sha = /^[a-f0-9]{64}$/
const integrity = /^sha256-[A-Za-z0-9+/]{43}=$/
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,512}$/u

export function parseShadcnScanArtifact(value: unknown): ShadcnScanArtifact {
  const artifact = exact(value, ['sourceRevision', 'scan', 'request'])
  const sourceRevision = text(artifact.sourceRevision, 40, /^[a-f0-9]{40}$/)
  const scan = parseScan(artifact.scan)
  const request = parseRequest(artifact.request)
  assertUniqueSources([...request.styles, ...(request.dependencies ?? [])])
  assertValidResolutions(request)
  if (JSON.stringify(request.dependencies ?? []) !== JSON.stringify(scan.previewDependencies ?? [])) invalid()
  if (JSON.stringify(request.resolutions ?? []) !== JSON.stringify(scan.previewResolutions ?? [])) invalid()
  const componentKeys = new Map(scan.components.map(component => [`${component.path}\0${component.exportName}`, component]))
  const requestIds = new Set<string>()
  for (const component of request.components) {
    if (requestIds.has(component.componentId)) invalid()
    requestIds.add(component.componentId)
    const scanned = componentKeys.get(`${component.entryPath}\0${component.exportName}`)
    if (!scanned || component.integrity !== sri(scanned.sourceHash)) invalid()
    const expectedId = `shadcn:${scanned.exportName}:${createHash('sha256').update(`${scanned.path}\0${scanned.exportName}`).digest('hex').slice(0, 16)}`
    if (component.componentId !== expectedId) invalid()
    if (component.slots.join('\0') !== scanned.slots.join('\0')) invalid()
    const slots = new Set(scanned.slots)
    const expectedProps = Object.fromEntries(scanned.props.filter(prop => !slots.has(prop.name)).map(prop => [prop.name, shadcnPreviewPropRule(prop.type, prop.optional)]))
    if (Object.values(expectedProps).some(rule => rule === null) || JSON.stringify(component.props) !== JSON.stringify(expectedProps)) invalid()
  }
  if (!requestIds.has(request.entry.componentId)) invalid()
  for (const source of [...request.styles, ...(request.dependencies ?? [])]) {
    if (scan.sourceHashes[source.path] === undefined || source.integrity !== sri(scan.sourceHashes[source.path]!)) invalid()
  }
  for (const alias of request.aliases ?? []) if (scan.sourceHashes[alias.configPath] === undefined || alias.integrity !== sri(scan.sourceHashes[alias.configPath]!)) invalid()
  if (request.provider && (scan.sourceHashes[request.provider.entryPath] === undefined || request.provider.integrity !== sri(scan.sourceHashes[request.provider.entryPath]!) || scan.sourceHashes[request.provider.evidence.configPath] === undefined || request.provider.evidence.integrity !== sri(scan.sourceHashes[request.provider.evidence.configPath]!))) invalid()
  for (const adapter of request.themeAdapters ?? []) if (scan.sourceHashes[adapter.entryPath] === undefined || adapter.integrity !== sri(scan.sourceHashes[adapter.entryPath]!) || scan.sourceHashes[adapter.evidence.configPath] === undefined || adapter.evidence.integrity !== sri(scan.sourceHashes[adapter.evidence.configPath]!)) invalid()
  const canonicalComponents = scan.components.flatMap(component => {
    const candidate = shadcnPreviewRegistryComponent(component)
    return candidate ? [candidate] : []
  })
  const { dependencies: _dependencies, resolutions: _resolutions, ...requestWithoutDependencies } = request
  if (!canonicalComponents.length || JSON.stringify(requestWithoutDependencies) !== JSON.stringify(registryRequestFromShadcnScan(scan, canonicalComponents))) invalid()
  return Object.freeze({ sourceRevision, scan, request })
}

/** Produces the only trusted admission expectation for a hosted build from a validated scan artifact. */
export function hostedPreviewExpectationFromShadcnScanArtifact(value: unknown): HostedPreviewArtifactExpectation {
  const artifact = parseShadcnScanArtifact(value)
  return Object.freeze({
    sourceRevision: artifact.sourceRevision,
    registryFingerprint: hostedPreviewCatalogFingerprint(artifact.request),
    components: Object.freeze(artifact.request.components.map(component => Object.freeze({ componentId: component.componentId, exportName: component.exportName }))),
  })
}

function parseScan(value: unknown): ShadcnScan {
  const scan = exact(value, ['adapterId', 'configs', 'components', 'tokens', 'sourceHashes', 'diagnostics'], ['previewDependencies', 'previewResolutions'])
  if (scan.adapterId !== 'shadcn-v1') invalid()
  const sourceHashes = dictionary(scan.sourceHashes, 10_000, entry => text(entry, 64, sha))
  const components = list(scan.components, 5_000, item => {
    const component = exact(item, ['path', 'exportName', 'declarationKind', 'props', 'slots', 'sourceHash', 'fingerprint'])
    const declarationKind = component.declarationKind
    if (!['function', 'variable', 'forwardRef', 'memo'].includes(String(declarationKind))) invalid()
    return Object.freeze({ path: path(component.path), exportName: name(component.exportName), declarationKind: declarationKind as 'function', props: list(component.props, 128, prop => { const record = exact(prop, ['name', 'type', 'optional']); if (typeof record.optional !== 'boolean') invalid(); return Object.freeze({ name: name(record.name), type: text(record.type, 512), optional: record.optional }) }), slots: uniqueStrings(component.slots, 64, 100), sourceHash: text(component.sourceHash, 64, sha), fingerprint: text(component.fingerprint, 64, sha) })
  })
  const configs = list(scan.configs, 64, item => {
    const config = exact(item, ['source', 'path', 'workspace', 'uiAlias', 'uiRoots', 'registryRoots', 'tokenFiles', 'registries', 'moduleConfig', 'previewProvider', 'themeAdapters'])
    if (config.source !== 'manifest' && config.source !== 'inferred') invalid()
    if (config.uiAlias !== null && typeof config.uiAlias !== 'string') invalid()
    return Object.freeze({ source: config.source, path: path(config.path), workspace: config.workspace === '' ? '' : path(config.workspace), uiAlias: config.uiAlias as string | null, uiRoots: pathList(config.uiRoots), registryRoots: pathList(config.registryRoots), tokenFiles: pathList(config.tokenFiles), registries: uniqueStrings(config.registries, 64, 256), moduleConfig: config.moduleConfig === null ? null : module(config.moduleConfig), previewProvider: config.previewProvider === null ? null : provider(config.previewProvider), themeAdapters: list(config.themeAdapters, 16, adapter) })
  })
  const tokens = list(scan.tokens, 20_000, item => { const token = exact(item, ['name', 'value', 'path', 'selector', 'atRules', 'theme', 'aliases', 'line', 'column']); return Object.freeze({ name: text(token.name, 512, /^--[A-Za-z0-9_-]+$/), value: text(token.value, 2_048), path: path(token.path), selector: text(token.selector, 512), atRules: uniqueStrings(token.atRules, 32, 512), theme: text(token.theme, 128), aliases: uniqueStrings(token.aliases, 64, 256), line: integer(token.line, 1, 10_000_000), column: integer(token.column, 1, 10_000) }) })
  const diagnostics = list(scan.diagnostics, 5_000, item => { const diagnostic = exact(item, ['code', 'path', 'message']); if (!['invalid-config', 'missing-css', 'missing-ui-root', 'unsupported-export', 'unsupported-preview-component'].includes(String(diagnostic.code))) invalid(); return Object.freeze({ code: diagnostic.code as 'invalid-config', path: path(diagnostic.path), message: text(diagnostic.message, 1_024) }) })
  const previewDependencies = scan.previewDependencies === undefined ? undefined : list(scan.previewDependencies, 10_000, item => { const source = exact(item, ['path', 'integrity']); return Object.freeze({ path: path(source.path), integrity: text(source.integrity, 51, integrity) }) })
  const previewResolutions = scan.previewResolutions === undefined ? undefined : list(scan.previewResolutions, 50_000, item => { const resolution = exact(item, ['importer', 'specifier', 'path']); return Object.freeze({ importer: path(resolution.importer), specifier: text(resolution.specifier, 512), path: path(resolution.path) }) })
  for (const component of components) if (sourceHashes[component.path] !== component.sourceHash) invalid()
  return Object.freeze({ adapterId: 'shadcn-v1', configs, components, tokens, sourceHashes, diagnostics, ...(previewDependencies ? { previewDependencies } : {}), ...(previewResolutions ? { previewResolutions } : {}) })
}

function parseRequest(value: unknown): ShadcnPreviewRegistryRequest {
  const request = exact(value, ['version', 'entry', 'components', 'styles'], ['aliases', 'dependencies', 'resolutions', 'provider', 'themeAdapters'])
  if (request.version !== 1) invalid()
  const entry = exact(request.entry, ['componentId'])
  const components = list(request.components, 5_000, item => {
    const component = exact(item, ['componentId', 'entryPath', 'exportName', 'integrity', 'props', 'slots'])
    const props = dictionary(component.props, 128, rule => { const record = exact(rule, ['kind', 'optional'], ['values']); if (!['string', 'number', 'boolean', 'enum'].includes(String(record.kind)) || typeof record.optional !== 'boolean') invalid(); if (record.kind === 'enum') { const values = list(record.values, 128, literal); if (!values.length) invalid(); return Object.freeze({ kind: 'enum' as const, values, optional: record.optional }) } if (record.values !== undefined) invalid(); return Object.freeze({ kind: record.kind as 'string', optional: record.optional }) })
    return Object.freeze({ componentId: text(component.componentId, 256), entryPath: path(component.entryPath), exportName: name(component.exportName), integrity: text(component.integrity, 51, integrity), props, slots: uniqueStrings(component.slots, 64, 100) })
  })
  const sources = (input: unknown) => list(input, 10_000, item => { const source = exact(item, ['path', 'integrity']); return Object.freeze({ path: path(source.path), integrity: text(source.integrity, 51, integrity) }) })
  const aliases = request.aliases === undefined ? undefined : list(request.aliases, 64, item => { const value = exact(item, ['configPath', 'integrity', 'baseUrl', 'paths']); return Object.freeze({ configPath: path(value.configPath), integrity: text(value.integrity, 51, integrity), baseUrl: path(value.baseUrl), paths: list(value.paths, 128, rule => { const record = exact(rule, ['pattern', 'target']); return Object.freeze({ pattern: text(record.pattern, 256), target: path(record.target) }) }) }) })
  const providerValue = request.provider === undefined ? undefined : (() => { const value = exact(request.provider, ['entryPath', 'exportName', 'props', 'integrity', 'evidence']); const evidence = exact(value.evidence, ['configPath', 'integrity']); return Object.freeze({ ...provider(value), integrity: text(value.integrity, 51, integrity), evidence: Object.freeze({ configPath: path(evidence.configPath), integrity: text(evidence.integrity, 51, integrity) }) }) })()
  const themeAdapters = request.themeAdapters === undefined ? undefined : list(request.themeAdapters, 16, item => { const value = exact(item, ['entryPath', 'exportName', 'integrity', 'evidence']); const evidence = exact(value.evidence, ['configPath', 'integrity']); return Object.freeze({ ...adapter(value), integrity: text(value.integrity, 51, integrity), evidence: Object.freeze({ configPath: path(evidence.configPath), integrity: text(evidence.integrity, 51, integrity) }) }) })
  const resolutions = request.resolutions === undefined ? undefined : list(request.resolutions, 50_000, item => { const value = exact(item, ['importer', 'specifier', 'path']); return Object.freeze({ importer: path(value.importer), specifier: text(value.specifier, 512), path: path(value.path) }) })
  return Object.freeze({ version: 1, entry: Object.freeze({ componentId: text(entry.componentId, 256) }), components, styles: sources(request.styles), ...(aliases ? { aliases } : {}), ...(request.dependencies === undefined ? {} : { dependencies: sources(request.dependencies) }), ...(resolutions ? { resolutions } : {}), ...(providerValue ? { provider: providerValue } : {}), ...(themeAdapters ? { themeAdapters } : {}) })
}

function module(value: unknown) { const record = exact(value, ['path', 'baseUrl', 'paths']); return Object.freeze({ path: path(record.path), baseUrl: path(record.baseUrl), paths: dictionary(record.paths, 128, entry => pathList(entry)) }) }
function provider(value: unknown) { const record = exact(value, ['entryPath', 'exportName', 'props'], ['integrity', 'evidence']); return Object.freeze({ entryPath: path(record.entryPath), exportName: name(record.exportName), props: dictionary(record.props, 128, literalOrNull) }) }
function adapter(value: unknown) { const record = exact(value, ['entryPath', 'exportName'], ['integrity', 'evidence']); return Object.freeze({ entryPath: path(record.entryPath), exportName: name(record.exportName) }) }
function literal(value: unknown): string | number | boolean { if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' || typeof value === 'number' && !Number.isFinite(value)) invalid(); return value }
function literalOrNull(value: unknown) { return value === null ? null : literal(value) }
function path(value: unknown) { return text(value, 512, safePath) }
function name(value: unknown) { return text(value, 128, /^[A-Za-z_$][A-Za-z0-9_$.-]*$/) }
function pathList(value: unknown) { return uniqueStrings(value, 256, 512, safePath) }
function uniqueStrings(value: unknown, maximum: number, length: number, pattern?: RegExp) { const values = list(value, maximum, item => text(item, length, pattern)); if (new Set(values).size !== values.length) invalid(); return values }
function assertUniqueSources(values: readonly Readonly<{ path: string }>[]) { if (new Set(values.map(value => value.path)).size !== values.length) invalid() }
function assertValidResolutions(request: ShadcnPreviewRegistryRequest) {
  const declared = new Set([
    ...request.components.map(component => component.entryPath),
    ...request.styles.map(source => source.path),
    ...(request.dependencies ?? []).map(source => source.path),
    ...(request.provider ? [request.provider.entryPath] : []),
    ...(request.themeAdapters ?? []).map(adapter => adapter.entryPath),
  ])
  const identities = new Set<string>()
  for (const resolution of request.resolutions ?? []) {
    const identity = `${resolution.importer}\0${resolution.specifier}`
    if (identities.has(identity) || !declared.has(resolution.importer) || !declared.has(resolution.path)) invalid()
    identities.add(identity)
  }
}
function dictionary<T>(value: unknown, maximum: number, parse: (value: unknown) => T): Readonly<Record<string, T>> { const record = exact(value, [], undefined, true); if (Object.keys(record).length > maximum) invalid(); return Object.freeze(Object.fromEntries(Object.entries(record).map(([key, entry]) => [text(key, 512), parse(entry)]))) }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = [], allowAny = false): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); const record = value as Record<string, unknown>; if (!allowAny && Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) invalid(); if (required.some(key => !(key in record))) invalid(); return record }
function list<T>(value: unknown, maximum: number, parse: (value: unknown) => T): readonly T[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return Object.freeze(value.map(parse)) }
function text(value: unknown, maximum: number, pattern?: RegExp): string { if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || pattern && !pattern.test(value)) invalid(); return value }
function integer(value: unknown, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(); return value as number }
function sri(hex: string) { return `sha256-${Buffer.from(hex, 'hex').toString('base64')}` }
function invalid(): never { throw new Error('Repository scan result is invalid.') }
