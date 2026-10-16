import type { SourceBindingSnapshot, SourceScanAuthority, SourceSymbolEvidence } from '@canvas/repository'
import type { ShadcnComponentCatalogEntry, ShadcnProp } from '@canvas/scanner/contracts'
import type { EditorHostedRepositoryScan } from '../../capabilities'

export type HostedSourceComponentProjection =
  | Readonly<{
    bindingId: string
    status: 'bound'
    name: string
    props: readonly ShadcnProp[]
    slots: readonly string[]
  }>
  | Readonly<{ bindingId: string; status: 'missing' }>
  | Readonly<{
    bindingId: string
    status: 'ambiguous'
    candidates: readonly Readonly<{ choiceToken: string; name: string }>[]
  }>

export type HostedSourceBindingProjection = Readonly<{
  authority: Readonly<{
    version: number
    projectId: string
    repositoryId: string
    scanId: string
    sourceRevision: string
    registryFingerprint: string
    grantGeneration: number
    adapterId: string
    updatedAt: number
  }>
  components: readonly HostedSourceComponentProjection[]
}>

type HostedScanWithAdapter = EditorHostedRepositoryScan & Readonly<{ adapterId: string }>

const own = (value: object, key: string): boolean => Object.hasOwn(value, key)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOwn = (value: object, keys: readonly string[]): boolean => keys.every(key => own(value, key))

function sameRepository(left: SourceScanAuthority['repository'], right: SourceScanAuthority['repository']): boolean {
  return left.provider === 'github'
    && right.provider === 'github'
    && left.projectId === right.projectId
    && left.repositoryId === right.repositoryId
}

function sameAuthority(left: SourceScanAuthority, right: SourceScanAuthority): boolean {
  return sameRepository(left.repository, right.repository)
    && left.scanId === right.scanId
    && left.sourceRevision === right.sourceRevision
    && left.registryFingerprint === right.registryFingerprint
    && left.grantGeneration === right.grantGeneration
    && left.adapterId === right.adapterId
}

function sameEvidence(left: SourceSymbolEvidence, right: ShadcnComponentCatalogEntry): boolean {
  return left.symbolKey === right.symbolKey
    && left.packageName === right.packageName
    && left.path === right.path
    && left.exportName === right.exportName
    && left.sourceHash === right.sourceHash
    && left.fingerprint === right.fingerprint
}

function validAuthority(value: unknown): value is SourceScanAuthority {
  if (!object(value) || !hasOwn(value, ['repository', 'scanId', 'sourceRevision', 'registryFingerprint', 'grantGeneration', 'adapterId'])
    || !object(value.repository) || !hasOwn(value.repository, ['provider', 'projectId', 'repositoryId'])) return false
  const repository = value.repository
  return repository.provider === 'github'
    && typeof repository.projectId === 'string'
    && typeof repository.repositoryId === 'string'
    && typeof value.scanId === 'string'
    && typeof value.sourceRevision === 'string'
    && typeof value.registryFingerprint === 'string'
    && Number.isSafeInteger(value.grantGeneration) && Number(value.grantGeneration) >= 1
    && typeof value.adapterId === 'string'
}

function validEvidence(value: unknown): value is SourceSymbolEvidence {
  return object(value)
    && hasOwn(value, ['symbolKey', 'packageName', 'path', 'exportName', 'sourceHash', 'fingerprint'])
    && typeof value.symbolKey === 'string'
    && typeof value.packageName === 'string'
    && typeof value.path === 'string'
    && typeof value.exportName === 'string'
    && typeof value.sourceHash === 'string'
    && typeof value.fingerprint === 'string'
}

function safeComponent(component: ShadcnComponentCatalogEntry): Readonly<{
  name: string
  props: readonly ShadcnProp[]
  slots: readonly string[]
}> | null {
  if (!object(component) || typeof component.exportName !== 'string' || !Array.isArray(component.props) || !Array.isArray(component.slots)) return null
  const propNames = new Set<string>()
  const props: ShadcnProp[] = []
  for (const prop of component.props) {
    if (!object(prop) || typeof prop.name !== 'string' || typeof prop.type !== 'string' || typeof prop.optional !== 'boolean' || propNames.has(prop.name)) return null
    propNames.add(prop.name)
    props.push(Object.freeze({ name: prop.name, type: prop.type, optional: prop.optional }))
  }
  const slots: string[] = []
  const slotNames = new Set<string>()
  for (const slot of component.slots) {
    if (typeof slot !== 'string' || slotNames.has(slot)) return null
    slotNames.add(slot)
    slots.push(slot)
  }
  return Object.freeze({ name: component.exportName, props: Object.freeze(props), slots: Object.freeze(slots) })
}

/** Projects verified hosted source bindings without exposing repository locators or transport authority. */
export function projectHostedSourceBindings(input: Readonly<{
  projectId: string
  snapshot: SourceBindingSnapshot
  scan: HostedScanWithAdapter
}>): HostedSourceBindingProjection | null {
  const { projectId, snapshot, scan } = input
  if (typeof projectId !== 'string' || !object(snapshot) || !validAuthority(snapshot.authority)
    || !Number.isSafeInteger(snapshot.version) || Number(snapshot.version) < 1
    || !Number.isSafeInteger(snapshot.updatedAt) || Number(snapshot.updatedAt) < 0
    || !Array.isArray(snapshot.records) || !object(scan) || !object(scan.registry)
    || typeof scan.jobId !== 'string' || typeof scan.sourceRevision !== 'string'
    || typeof scan.adapterId !== 'string' || !Number.isSafeInteger(scan.componentCount)
    || typeof scan.registry.fingerprint !== 'string' || !Array.isArray(scan.registry.components)) return null

  const authority = snapshot.authority
  if (authority.repository.projectId !== projectId
    || authority.scanId !== scan.jobId
    || authority.sourceRevision !== scan.sourceRevision
    || authority.registryFingerprint !== scan.registry.fingerprint
    || authority.adapterId !== scan.adapterId
    || scan.componentCount !== scan.registry.components.length) return null

  const catalogByKey = new Map<string, ShadcnComponentCatalogEntry>()
  for (const component of scan.registry.components) {
    if (!object(component) || typeof component.symbolKey !== 'string' || catalogByKey.has(component.symbolKey)) return null
    const catalogComponent = component as unknown as ShadcnComponentCatalogEntry
    catalogByKey.set(catalogComponent.symbolKey, catalogComponent)
  }

  const bindingIds = new Set<string>()
  const boundSymbols = new Set<string>()
  const candidateSymbols = new Set<string>()
  const coveredSymbols = new Set<string>()
  const components: HostedSourceComponentProjection[] = []
  for (const record of snapshot.records) {
    if (!object(record) || typeof record.id !== 'string' || bindingIds.has(record.id)
      || !validAuthority(record.authority) || !sameAuthority(authority, record.authority)
      || !object(record.repository) || !hasOwn(record.repository, ['provider', 'projectId', 'repositoryId'])
      || !validEvidence(record.evidence)) return null
    const sourceRecord = record as unknown as SourceBindingSnapshot['records'][number]
    if (!sameRepository(authority.repository, sourceRecord.repository)) return null
    bindingIds.add(sourceRecord.id)

    if (sourceRecord.status === 'bound') {
      const catalog = catalogByKey.get(sourceRecord.evidence.symbolKey)
      if (!catalog || !sameEvidence(sourceRecord.evidence, catalog)
        || boundSymbols.has(catalog.symbolKey) || candidateSymbols.has(catalog.symbolKey)) return null
      const safe = safeComponent(catalog)
      if (!safe) return null
      boundSymbols.add(catalog.symbolKey)
      coveredSymbols.add(catalog.symbolKey)
      components.push(Object.freeze({ bindingId: sourceRecord.id, status: 'bound', ...safe }))
      continue
    }
    if (sourceRecord.status === 'missing') {
      components.push(Object.freeze({ bindingId: sourceRecord.id, status: 'missing' }))
      continue
    }
    if (sourceRecord.status !== 'ambiguous' || !Array.isArray(sourceRecord.candidates) || sourceRecord.candidates.length < 1) return null
    const candidates: Array<Readonly<{ choiceToken: string; name: string }>> = []
    const recordCandidates = new Set<string>()
    for (const [index, candidate] of sourceRecord.candidates.entries()) {
      if (!validEvidence(candidate)) return null
      const sourceCandidate = candidate
      const catalog = catalogByKey.get(sourceCandidate.symbolKey)
      if (!catalog || !sameEvidence(sourceCandidate, catalog)
        || boundSymbols.has(catalog.symbolKey) || recordCandidates.has(catalog.symbolKey)) return null
      const safe = safeComponent(catalog)
      if (!safe) return null
      recordCandidates.add(catalog.symbolKey)
      candidateSymbols.add(catalog.symbolKey)
      coveredSymbols.add(catalog.symbolKey)
      candidates.push(Object.freeze({ choiceToken: `candidate:${index + 1}`, name: safe.name }))
    }
    components.push(Object.freeze({ bindingId: sourceRecord.id, status: 'ambiguous', candidates: Object.freeze(candidates) }))
  }

  if (coveredSymbols.size !== catalogByKey.size) return null
  return Object.freeze({
    authority: Object.freeze({
      version: snapshot.version,
      projectId,
      repositoryId: authority.repository.repositoryId,
      scanId: authority.scanId,
      sourceRevision: authority.sourceRevision,
      registryFingerprint: authority.registryFingerprint,
      grantGeneration: authority.grantGeneration,
      adapterId: authority.adapterId,
      updatedAt: snapshot.updatedAt,
    }),
    components: Object.freeze(components),
  })
}
