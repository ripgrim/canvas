import { createHash } from 'node:crypto'
import { hostedPreviewCatalogFingerprint, type HostedPreviewArtifactExpectation } from '@canvas/preview-runtime/hosted-artifact'
import type { ShadcnPreviewRegistryRequest, ShadcnScan } from './contracts.js'
import { registryRequestFromShadcnScan, shadcnPreviewPropRule, shadcnPreviewRegistryComponent } from './preview-registry.js'
import { parseShadcnPreviewRegistryRequest, parseShadcnScan } from './strict-contract.js'

export { parseShadcnPreviewRegistryRequest, parseShadcnScan } from './strict-contract.js'

export type ShadcnScanArtifact = Readonly<{
  sourceRevision: string
  scan: ShadcnScan
  request: ShadcnPreviewRegistryRequest
}>

export function parseShadcnScanArtifact(value: unknown): ShadcnScanArtifact {
  const artifact = envelope(value)
  const sourceRevision = revision(artifact.sourceRevision)
  const scan = parseShadcnScan(artifact.scan)
  const request = parseShadcnPreviewRegistryRequest(artifact.request)
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

function envelope(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'sourceRevision') || !Object.hasOwn(record, 'scan') || !Object.hasOwn(record, 'request') || Object.keys(record).some(key => !['sourceRevision', 'scan', 'request'].includes(key))) invalid()
  return record
}

function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) invalid()
  return value
}

function assertUniqueSources(values: readonly Readonly<{ path: string }>[]): void {
  if (new Set(values.map(value => value.path)).size !== values.length) invalid()
}

function assertValidResolutions(request: ShadcnPreviewRegistryRequest): void {
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

function sri(hex: string): string {
  return `sha256-${Buffer.from(hex, 'hex').toString('base64')}`
}

function invalid(): never {
  throw new Error('Repository scan result is invalid.')
}
