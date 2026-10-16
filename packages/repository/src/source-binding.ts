export type SourceRepositoryIdentity = Readonly<{
  provider: 'github'
  projectId: string
  repositoryId: string
}>

export type SourceScanAuthority = Readonly<{
  repository: SourceRepositoryIdentity
  scanId: string
  sourceRevision: string
  registryFingerprint: string
  grantGeneration: number
  adapterId: string
}>

export type SourceSymbolEvidence = Readonly<{
  /** Stable across verified locator continuity. */
  symbolKey: string
  packageName: string
  path: string
  exportName: string
  sourceHash: string
  fingerprint: string
}>

export type SourceBindingCandidate = SourceSymbolEvidence

type SourceBindingBase = Readonly<{
  id: string
  repository: SourceRepositoryIdentity
  authority: SourceScanAuthority
  evidence: SourceSymbolEvidence
}>

export type BoundSourceBinding = SourceBindingBase & Readonly<{
  status: 'bound'
}>

export type MissingSourceBinding = SourceBindingBase & Readonly<{
  status: 'missing'
}>

export type AmbiguousSourceBinding = SourceBindingBase & Readonly<{
  status: 'ambiguous'
  candidates: readonly SourceBindingCandidate[]
}>

export type SourceBindingRecord = BoundSourceBinding | MissingSourceBinding | AmbiguousSourceBinding

export type SourceBindingSeed = Readonly<{
  bindingId: string
  evidence: SourceSymbolEvidence
}>

export type SourceBindingAllocation = Readonly<{
  bindingId: string
  symbolKey: string
}>

export type SourceBindingRebind = Readonly<{
  bindingId: string
  expectedAuthority: SourceScanAuthority
  expectedEvidence: SourceSymbolEvidence
  replacement: SourceSymbolEvidence
}>

export type SourceBindingReconciliation = Readonly<{
  repository: SourceRepositoryIdentity
  authority: SourceScanAuthority
  records: readonly SourceBindingRecord[]
}>

const opaquePattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const packagePattern = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,126}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
const exportPattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/
const hashPattern = /^[a-f0-9]{64}$/
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const registryPattern = /^(?:sha256:[a-f0-9]{64}|sha256-[A-Za-z0-9+/]{43}=)$/
const adapterPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/

function invalid(message: string): never {
  throw new Error(message)
}
const own = (value: object, key: string) => Object.hasOwn(value, key)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function exact(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (!object(value)) invalid(`Invalid ${label}`)
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalid(`Invalid ${label}`)
  return value
}

function text(value: unknown, pattern: RegExp, label: string, limit = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > limit || value.trim() !== value || !pattern.test(value)) invalid(`Invalid ${label}`)
  return value
}

function repository(value: unknown): SourceRepositoryIdentity {
  const item = exact(value, ['provider', 'projectId', 'repositoryId'], [], 'source repository')
  if (item.provider !== 'github') invalid('Invalid source repository')
  return freeze({
    provider: 'github' as const,
    projectId: text(item.projectId, opaquePattern, 'source project id'),
    repositoryId: text(item.repositoryId, opaquePattern, 'source repository id'),
  })
}

function authority(value: unknown): SourceScanAuthority {
  const item = exact(value, ['repository', 'scanId', 'sourceRevision', 'registryFingerprint', 'grantGeneration', 'adapterId'], [], 'source scan authority')
  if (!Number.isSafeInteger(item.grantGeneration) || Number(item.grantGeneration) < 0) invalid('Invalid source grant generation')
  return freeze({
    repository: repository(item.repository),
    scanId: text(item.scanId, opaquePattern, 'source scan id'),
    sourceRevision: text(item.sourceRevision, revisionPattern, 'source revision', 64),
    registryFingerprint: text(item.registryFingerprint, registryPattern, 'source registry fingerprint', 80),
    grantGeneration: Number(item.grantGeneration),
    adapterId: text(item.adapterId, adapterPattern, 'source adapter id'),
  })
}

function evidence(value: unknown): SourceSymbolEvidence {
  const item = exact(value, ['symbolKey', 'packageName', 'path', 'exportName', 'sourceHash', 'fingerprint'], [], 'source symbol evidence')
  return freeze({
    symbolKey: text(item.symbolKey, opaquePattern, 'source symbol key'),
    packageName: text(item.packageName, packagePattern, 'source package name'),
    path: text(item.path, pathPattern, 'source path', 1_000),
    exportName: text(item.exportName, exportPattern, 'source export name'),
    sourceHash: text(item.sourceHash, hashPattern, 'source hash', 64),
    fingerprint: text(item.fingerprint, hashPattern, 'source fingerprint', 64),
  })
}

function record(value: unknown): SourceBindingRecord {
  const item = exact(value, ['id', 'repository', 'authority', 'evidence', 'status'], ['candidates'], 'source binding record')
  const base = freeze({
    id: text(item.id, opaquePattern, 'source binding id'),
    repository: repository(item.repository),
    authority: authority(item.authority),
    evidence: evidence(item.evidence),
  })
  if (item.status === 'bound' || item.status === 'missing') {
    if (own(item, 'candidates')) invalid('Invalid source binding record')
    return freeze({ ...base, status: item.status })
  }
  if (item.status !== 'ambiguous' || !Array.isArray(item.candidates) || item.candidates.length < 1 || item.candidates.length > 10_000) invalid('Invalid source binding record')
  const candidates = uniqueEvidence(item.candidates.map(evidence), 'source binding candidate')
  return freeze({ ...base, status: 'ambiguous' as const, candidates })
}

function seed(value: unknown): SourceBindingSeed {
  const item = exact(value, ['bindingId', 'evidence'], [], 'source binding seed')
  return freeze({ bindingId: text(item.bindingId, opaquePattern, 'source binding id'), evidence: evidence(item.evidence) })
}

function allocation(value: unknown): SourceBindingAllocation {
  const item = exact(value, ['bindingId', 'symbolKey'], [], 'source binding allocation')
  return freeze({
    bindingId: text(item.bindingId, opaquePattern, 'source binding id'),
    symbolKey: text(item.symbolKey, opaquePattern, 'source symbol key'),
  })
}

function rebind(value: unknown): SourceBindingRebind {
  const item = exact(value, ['bindingId', 'expectedAuthority', 'expectedEvidence', 'replacement'], [], 'source binding rebind')
  return freeze({
    bindingId: text(item.bindingId, opaquePattern, 'source binding id'),
    expectedAuthority: authority(item.expectedAuthority),
    expectedEvidence: evidence(item.expectedEvidence),
    replacement: evidence(item.replacement),
  })
}

function sameRepository(left: SourceRepositoryIdentity, right: SourceRepositoryIdentity): boolean {
  return left.provider === right.provider && left.projectId === right.projectId && left.repositoryId === right.repositoryId
}

function sameAuthority(left: SourceScanAuthority, right: SourceScanAuthority): boolean {
  return sameRepository(left.repository, right.repository)
    && left.scanId === right.scanId
    && left.sourceRevision === right.sourceRevision
    && left.registryFingerprint === right.registryFingerprint
    && left.grantGeneration === right.grantGeneration
    && left.adapterId === right.adapterId
}

function sameEvidence(left: SourceSymbolEvidence, right: SourceSymbolEvidence): boolean {
  return left.symbolKey === right.symbolKey
    && left.packageName === right.packageName
    && left.path === right.path
    && left.exportName === right.exportName
    && left.sourceHash === right.sourceHash
    && left.fingerprint === right.fingerprint
}

function locator(value: SourceSymbolEvidence): string {
  return `${value.packageName}\0${value.path}\0${value.exportName}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareEvidence(left: SourceSymbolEvidence, right: SourceSymbolEvidence): number {
  return compareText(locator(left), locator(right)) || compareText(left.symbolKey, right.symbolKey)
}

function uniqueEvidence(values: readonly SourceSymbolEvidence[], label: string): readonly SourceSymbolEvidence[] {
  const keys = new Set<string>()
  const locators = new Set<string>()
  for (const value of values) {
    if (keys.has(value.symbolKey) || locators.has(locator(value))) invalid(`Duplicate ${label}`)
    keys.add(value.symbolKey)
    locators.add(locator(value))
  }
  return freeze([...values].sort(compareEvidence))
}

function freeze<Value extends object>(value: Value): Readonly<Value> {
  return Object.freeze(value)
}

function bind(id: string, repo: SourceRepositoryIdentity, scan: SourceScanAuthority, symbol: SourceSymbolEvidence): BoundSourceBinding {
  return freeze({ id, repository: repo, authority: scan, evidence: symbol, status: 'bound' as const })
}

export function reconcileSourceBindings(input: unknown): SourceBindingReconciliation {
  const value = exact(input, ['repository', 'scan', 'previous', 'seeds', 'allocations', 'rebinds'], [], 'source binding reconciliation')
  const repo = repository(value.repository)
  const scan = exact(value.scan, ['authority', 'symbols'], [], 'source binding scan')
  const currentAuthority = authority(scan.authority)
  if (!sameRepository(repo, currentAuthority.repository)) invalid('Source scan repository mismatch')
  if (!Array.isArray(scan.symbols) || scan.symbols.length > 10_000) invalid('Invalid source binding symbols')
  const symbols = uniqueEvidence(scan.symbols.map(evidence), 'source symbol')
  if (!Array.isArray(value.seeds) || !Array.isArray(value.allocations) || !Array.isArray(value.rebinds)
    || value.seeds.length > 10_000 || value.allocations.length > 10_000 || value.rebinds.length > 10_000) invalid('Invalid source binding reconciliation')
  const seeds = value.seeds.map(seed)
  const allocations = value.allocations.map(allocation)
  const rebinds = value.rebinds.map(rebind)
  let prior: readonly SourceBindingRecord[] = []
  let previousAuthority: SourceScanAuthority | undefined
  if (value.previous !== null) {
    const previous = exact(value.previous, ['authority', 'records'], [], 'previous source bindings')
    previousAuthority = authority(previous.authority)
    if (!sameRepository(repo, previousAuthority.repository)) invalid('Previous source repository mismatch')
    if (!Array.isArray(previous.records) || previous.records.length > 10_000) invalid('Invalid previous source bindings')
    prior = previous.records.map(record)
    if (seeds.length) invalid('Source binding seeds can only be applied once')
    for (const binding of prior) {
      if (!sameRepository(repo, binding.repository) || !sameAuthority(previousAuthority, binding.authority)) invalid('Stale source binding authority')
    }
  }
  if (previousAuthority?.scanId === currentAuthority.scanId && !sameAuthority(previousAuthority, currentAuthority)) invalid('Source scan authority mismatch')
  if (previousAuthority && currentAuthority.grantGeneration < previousAuthority.grantGeneration) invalid('Stale source grant generation')
  if (previousAuthority && sameAuthority(previousAuthority, currentAuthority)) {
    const knownByKey = new Map<string, SourceSymbolEvidence>()
    for (const item of prior.flatMap(binding => binding.status === 'bound' ? [binding.evidence] : binding.status === 'ambiguous' ? binding.candidates : [])) {
      const existing = knownByKey.get(item.symbolKey)
      if (existing && !sameEvidence(existing, item)) invalid('Duplicate previous source symbol')
      knownByKey.set(item.symbolKey, item)
    }
    const known = [...knownByKey.values()].sort(compareEvidence)
    if (known.length !== symbols.length || known.some((item, index) => !sameEvidence(item, symbols[index]!))) invalid('Source scan evidence changed under immutable authority')
  }

  const ids = new Set<string>()
  const priorLocators = new Set<string>()
  const priorSymbolKeys = new Set<string>()
  for (const binding of prior) {
    if (ids.has(binding.id)
      || priorLocators.has(locator(binding.evidence))
      || priorSymbolKeys.has(binding.evidence.symbolKey)) invalid('Duplicate previous source binding')
    ids.add(binding.id)
    priorLocators.add(locator(binding.evidence))
    priorSymbolKeys.add(binding.evidence.symbolKey)
  }
  const byKey = new Map(symbols.map(symbol => [symbol.symbolKey, symbol]))
  const byLocator = new Map(symbols.map(symbol => [locator(symbol), symbol]))
  const consumed = new Set<string>()
  const records: SourceBindingRecord[] = []

  for (const item of seeds) {
    if (ids.has(item.bindingId)) invalid('Source binding id collision')
    const symbol = byKey.get(item.evidence.symbolKey)
    if (!symbol || !sameEvidence(symbol, item.evidence) || consumed.has(symbol.symbolKey)) invalid('Source binding seed does not match the scan')
    ids.add(item.bindingId)
    consumed.add(symbol.symbolKey)
    records.push(bind(item.bindingId, repo, currentAuthority, symbol))
  }

  const unmatched: SourceBindingRecord[] = []
  for (const binding of prior) {
    const direct = byLocator.get(locator(binding.evidence))
    if (binding.status === 'bound'
      && direct?.symbolKey === binding.evidence.symbolKey
      && !consumed.has(direct.symbolKey)) {
      consumed.add(direct.symbolKey)
      records.push(bind(binding.id, repo, currentAuthority, direct))
    } else unmatched.push(binding)
  }

  const candidates = new Map<string, readonly SourceSymbolEvidence[]>()
  for (const binding of unmatched) {
    const matches = symbols.filter(symbol => !consumed.has(symbol.symbolKey)
      && symbol.packageName === binding.evidence.packageName
      && symbol.fingerprint === binding.evidence.fingerprint)
    candidates.set(binding.id, matches)
  }

  const unmatchedById = new Map(unmatched.map(binding => [binding.id, binding]))
  const rebindById = new Map<string, SourceBindingRebind>()
  for (const item of rebinds) {
    if (rebindById.has(item.bindingId)) invalid('Duplicate source binding rebind')
    const binding = unmatchedById.get(item.bindingId)
    if (!binding) invalid('Source binding is not eligible for rebind')
    if (!previousAuthority || !sameAuthority(item.expectedAuthority, previousAuthority)
      || !sameEvidence(item.expectedEvidence, binding.evidence)) invalid('Stale source binding rebind')
    const replacement = byKey.get(item.replacement.symbolKey)
    const matches = candidates.get(binding.id) ?? []
    if (!replacement || !sameEvidence(replacement, item.replacement)
      || replacement.packageName !== binding.evidence.packageName
      || matches.length !== 1 || matches[0]!.symbolKey !== replacement.symbolKey) invalid('Source binding rebind target is not unique')
    if (consumed.has(replacement.symbolKey)) invalid('Source binding rebind collision')
    consumed.add(replacement.symbolKey)
    rebindById.set(item.bindingId, item)
    records.push(bind(binding.id, repo, currentAuthority, replacement))
  }

  const uncertain = new Set<string>()
  for (const binding of unmatched) {
    if (rebindById.has(binding.id)) continue
    const matches = (candidates.get(binding.id) ?? []).filter(match => !consumed.has(match.symbolKey))
    if (!matches.length) {
      records.push(freeze({ id: binding.id, repository: repo, authority: currentAuthority, evidence: binding.evidence, status: 'missing' as const }))
    } else {
      for (const match of matches) uncertain.add(match.symbolKey)
      records.push(freeze({ ...binding, repository: repo, authority: currentAuthority, status: 'ambiguous' as const, candidates: freeze([...matches].sort(compareEvidence)) }))
    }
  }

  const newSymbols = symbols.filter(symbol => !consumed.has(symbol.symbolKey) && !uncertain.has(symbol.symbolKey))
  const allocationBySymbol = new Map<string, SourceBindingAllocation>()
  for (const item of allocations) {
    if (allocationBySymbol.has(item.symbolKey) || ids.has(item.bindingId)) invalid('Source binding allocation collision')
    if (!byKey.has(item.symbolKey) || uncertain.has(item.symbolKey) || consumed.has(item.symbolKey)) invalid('Source binding allocation is not new')
    allocationBySymbol.set(item.symbolKey, item)
    ids.add(item.bindingId)
  }
  if (allocationBySymbol.size !== newSymbols.length || newSymbols.some(symbol => !allocationBySymbol.has(symbol.symbolKey))) invalid('New source symbols need opaque binding ids')
  for (const symbol of newSymbols) records.push(bind(allocationBySymbol.get(symbol.symbolKey)!.bindingId, repo, currentAuthority, symbol))

  return freeze({
    repository: repo,
    authority: currentAuthority,
    records: freeze(records.sort((left, right) => compareText(left.id, right.id))),
  })
}
