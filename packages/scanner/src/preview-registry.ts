import { createHash } from 'node:crypto'
import { verifyRegistryDependencyClosure } from '@canvas/preview-runtime/verified-registry'
import type {
  ShadcnComponent,
  ShadcnPreviewPropRule,
  ShadcnPreviewRegistryComponent,
  ShadcnPreviewRegistryRequest,
  ShadcnScan,
} from './contracts.js'
import { scanShadcnRepository } from './shadcn.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const integrity = (hexDigest: string) => `sha256-${Buffer.from(hexDigest, 'hex').toString('base64')}`

export function shadcnPreviewComponentId(component: Pick<ShadcnComponent, 'path' | 'exportName'>): string {
  return `shadcn:${component.exportName}:${hash(`${component.path}\0${component.exportName}`).slice(0, 16)}`
}

function literalValue(source: string): string | number | boolean | undefined {
  const text = source.trim()
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    try { return JSON.parse(text.startsWith("'") ? `"${text.slice(1, -1).replaceAll('"', '\\"')}"` : text) as string } catch { return undefined }
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    const value = Number(text)
    return Number.isFinite(value) ? value : undefined
  }
  return undefined
}

export function shadcnPreviewPropRule(source: string, optional: boolean): ShadcnPreviewPropRule | null {
  const members = source.split('|').map(member => member.trim()).filter(member => member !== 'undefined' && member !== 'null')
  if (members.length === 1 && ['string', 'number', 'boolean'].includes(members[0]!)) return { kind: members[0] as 'string' | 'number' | 'boolean', optional }
  const values = members.map(literalValue)
  if (values.length && values.every((value): value is string | number | boolean => value !== undefined)) return { kind: 'enum', values, optional }
  return null
}

export function shadcnPreviewRegistryComponent(component: ShadcnComponent): ShadcnPreviewRegistryComponent | null {
  const slots = new Set(component.slots)
  const props: Record<string, ShadcnPreviewPropRule> = {}
  for (const prop of component.props) {
    if (slots.has(prop.name)) continue
    const rule = shadcnPreviewPropRule(prop.type, prop.optional)
    if (!rule) return null
    props[prop.name] = rule
  }
  return {
    componentId: shadcnPreviewComponentId(component),
    entryPath: component.path,
    exportName: component.exportName,
    integrity: integrity(component.sourceHash),
    props,
    slots: component.slots,
  }
}

export function registryRequestFromShadcnScan(scan: ShadcnScan, components: readonly ShadcnPreviewRegistryComponent[]): ShadcnPreviewRegistryRequest {
  const entry = components[0]!
  const tokenFiles = [...new Set(scan.configs.flatMap(config => config.tokenFiles))].sort()
  const aliases = scan.configs.flatMap(config => {
    const moduleConfig = config.moduleConfig
    if (!moduleConfig || !Object.keys(moduleConfig.paths).length) return []
    const paths = Object.entries(moduleConfig.paths).sort(([left], [right]) => left.localeCompare(right)).map(([pattern, targets]) => {
      if (targets.length !== 1) throw new Error(`Path alias ${pattern} must have exactly one verified target.`)
      const target = targets[0]!
      const patternWildcards = [...pattern].filter(character => character === '*').length
      const targetWildcards = [...target].filter(character => character === '*').length
      if (patternWildcards !== targetWildcards || patternWildcards > 1 || patternWildcards === 1 && (!pattern.endsWith('*') || !target.endsWith('*'))) {
        throw new Error(`Path alias ${pattern} uses an unsupported wildcard.`)
      }
      return { pattern, target }
    })
    return [{
      configPath: moduleConfig.path,
      integrity: integrity(scan.sourceHashes[moduleConfig.path]!),
      baseUrl: moduleConfig.baseUrl,
      paths,
    }]
  })
  const providers = scan.configs.flatMap(config => config.previewProvider ? [{ config, provider: config.previewProvider }] : [])
  if (providers.length > 1) throw new Error('More than one preview provider is explicitly configured.')
  const provider = providers[0]
  const themeAdapters = scan.configs.flatMap(config => config.themeAdapters.map(adapter => ({ config, adapter })))
  return {
    version: 1,
    entry: { componentId: entry.componentId },
    components,
    styles: tokenFiles.map(path => ({ path, integrity: integrity(scan.sourceHashes[path]!) })),
    ...(aliases.length ? { aliases } : {}),
    ...(provider ? { provider: {
      ...provider.provider,
      integrity: integrity(scan.sourceHashes[provider.provider.entryPath]!),
      evidence: { configPath: provider.config.path, integrity: integrity(scan.sourceHashes[provider.config.path]!) },
    } } : {}),
    ...(themeAdapters.length ? { themeAdapters: themeAdapters.map(({ config, adapter }) => ({
      ...adapter,
      integrity: integrity(scan.sourceHashes[adapter.entryPath]!),
      evidence: { configPath: config.path, integrity: integrity(scan.sourceHashes[config.path]!) },
    })) } : {}),
  }
}

export async function verifyShadcnPreviewRequestClosure(repositoryRoot: string, request: ShadcnPreviewRegistryRequest): Promise<void> {
  const closure = await verifyRegistryDependencyClosure(repositoryRoot, {
    roots: dependencyRoots(request),
    ...(request.aliases ? { aliases: request.aliases } : {}),
  })
  const dependencies = closure.dependencies.map(dependency => ({ path: dependency.path, integrity: dependency.integrity }))
  const resolutions = closure.resolutions.map(resolution => ({ importer: resolution.importer, specifier: resolution.specifier, path: resolution.path }))
  if (JSON.stringify(dependencies) !== JSON.stringify(request.dependencies ?? []) || JSON.stringify(resolutions) !== JSON.stringify(request.resolutions ?? [])) {
    throw new Error('Repository preview dependency closure changed.')
  }
}

function dependencyRoots(request: ShadcnPreviewRegistryRequest) {
  return [
    ...request.components.map(component => ({ path: component.entryPath, integrity: component.integrity })),
    ...request.styles,
    ...(request.provider ? [{ path: request.provider.entryPath, integrity: request.provider.integrity }] : []),
    ...(request.themeAdapters ?? []).map(adapter => ({ path: adapter.entryPath, integrity: adapter.integrity })),
  ].filter((root, index, all) => all.findIndex(candidate => candidate.path === root.path) === index)
}

/**
 * Converts scanner evidence into the same verified request consumed by the editor preview and thumbnail renderer.
 * Unsupported prop shapes are reported and excluded instead of being approximated.
 */
export async function scanShadcnPreviewRegistry(repositoryRoot: string): Promise<Readonly<{ scan: ShadcnScan; request: ShadcnPreviewRegistryRequest }>> {
  const scan = await scanShadcnRepository(repositoryRoot)
  const supported: ShadcnPreviewRegistryComponent[] = []
  const diagnostics = [...scan.diagnostics]
  for (const component of scan.components) {
    const generated = shadcnPreviewRegistryComponent(component)
    if (generated) supported.push(generated)
    else diagnostics.push({
      code: 'unsupported-preview-component',
      path: component.path,
      message: `${component.exportName} has props that cannot be represented by the verified preview contract.`,
    })
  }
  if (!supported.length) throw new Error('No scanned component can be represented by the verified preview contract.')
  const supportedScan = { ...scan, diagnostics }
  const baseRequest = registryRequestFromShadcnScan(supportedScan, supported)
  const closure = await verifyRegistryDependencyClosure(repositoryRoot, { roots: dependencyRoots(baseRequest), ...(baseRequest.aliases ? { aliases: baseRequest.aliases } : {}) })
  const dependencies = closure.dependencies.map(dependency => ({ path: dependency.path, integrity: dependency.integrity }))
  const resolutions = closure.resolutions.map(resolution => ({ importer: resolution.importer, specifier: resolution.specifier, path: resolution.path }))
  const sourceHashes = { ...supportedScan.sourceHashes, ...Object.fromEntries(closure.dependencies.map(dependency => [dependency.path, hash(dependency.bytes)])) }
  return {
    scan: { ...supportedScan, sourceHashes, previewDependencies: dependencies, previewResolutions: resolutions },
    request: { ...baseRequest, ...(dependencies.length ? { dependencies } : {}), ...(resolutions.length ? { resolutions } : {}) },
  }
}
