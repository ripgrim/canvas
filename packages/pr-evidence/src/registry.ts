import { createHash } from "node:crypto"

export type EvidenceKind = "visual" | "nonvisual"
export type EvidenceAdapter = "browser" | "electron"

export type CapabilityDefinition = Readonly<{
  id: string
  paths: readonly string[]
  evidence: EvidenceKind
  reason?: string
}>

export type EvidenceScenarioDefinition = Readonly<{
  id: string
  title: string
  capabilities: readonly string[]
  adapters: readonly EvidenceAdapter[]
  assertions: readonly string[]
  screenshots: readonly string[]
  video: boolean
}>

export type ChangedPath = Readonly<{
  path: string
  previousPath?: string
}>

export type EvidencePlan = Readonly<{
  files: readonly Readonly<{
    path: string
    capabilities: readonly string[]
    evidence: EvidenceKind
    reason?: string
  }>[]
  scenarios: readonly EvidenceScenarioDefinition[]
  adapters: readonly EvidenceAdapter[]
  registryDigest: string
}>

export function parseGitNameStatus(value: string): readonly ChangedPath[] {
  const fields = value.split("\0")
  if (fields.at(-1) === "") fields.pop()
  const changes: ChangedPath[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (!status) throw new Error("Invalid git diff status.")
    if (/^[RC]\d+$/u.test(status)) {
      const previousPath = fields[index++]
      const path = fields[index++]
      if (!path || !previousPath) throw new Error("Invalid git rename record.")
      changes.push(Object.freeze({ path: repositoryPath(path), previousPath: repositoryPath(previousPath) }))
      continue
    }
    const path = fields[index++]
    if (!/^[AMDTUXB]$/u.test(status) || !path) throw new Error(`Unsupported git diff status: ${status}`)
    changes.push(Object.freeze({ path: repositoryPath(path) }))
  }
  return Object.freeze(changes)
}

const ID = /^[a-z0-9][a-z0-9.-]{0,127}$/u

export function parseEvidenceRegistry(value: unknown): Readonly<{
  capabilities: readonly CapabilityDefinition[]
  scenarios: readonly EvidenceScenarioDefinition[]
  titles: Readonly<Record<string, string>>
}> {
  const root = exactObject(value, ["capabilities", "scenarios"], "registry")
  const capabilities = unknownArray(root.capabilities, "capabilities").map((value, index) => {
    const item = exactObject(value, ["id", "paths", "evidence", "reason"], `capability ${index}`, ["reason"])
    if (item.evidence !== "visual" && item.evidence !== "nonvisual") throw new Error("Invalid capability evidence kind.")
    return defineCapability({
      id: text(item.id, "capability id"),
      paths: stringArray(item.paths, "capability paths"),
      evidence: item.evidence,
      ...(item.reason === undefined ? {} : { reason: text(item.reason, "capability reason") }),
    })
  })
  const scenarios = unknownArray(root.scenarios, "scenarios").map((value, index) => {
    const item = exactObject(value, ["id", "title", "capabilities", "adapters", "assertions", "screenshots", "video"], `scenario ${index}`)
    const adapters = stringArray(item.adapters, "scenario adapters")
    if (adapters.some(value => value !== "browser" && value !== "electron")) throw new Error("Invalid scenario adapter.")
    if (typeof item.video !== "boolean") throw new Error("Invalid scenario video setting.")
    return defineEvidenceScenario({
      id: text(item.id, "scenario id"),
      title: text(item.title, "scenario title"),
      capabilities: stringArray(item.capabilities, "scenario capabilities"),
      adapters: adapters as readonly EvidenceAdapter[],
      assertions: stringArray(item.assertions, "scenario assertions"),
      screenshots: stringArray(item.screenshots, "scenario screenshots"),
      video: item.video,
    })
  })
  validateCapabilities(capabilities)
  validateScenarios(scenarios, capabilities)
  return Object.freeze({ capabilities: Object.freeze(capabilities), scenarios: Object.freeze(scenarios), titles: Object.freeze(Object.fromEntries(scenarios.map(scenario => [scenario.id, scenario.title]))) })
}

export function defineCapability(input: CapabilityDefinition): CapabilityDefinition {
  validId(input.id, "capability")
  if (!input.paths.length) throw new Error(`Capability ${input.id} requires source paths.`)
  const paths = sortedUnique(input.paths.map(pattern))
  if (input.evidence === "nonvisual" && !input.reason?.trim()) throw new Error(`Capability ${input.id} requires a nonvisual reason.`)
  if (input.evidence === "visual" && input.reason !== undefined) throw new Error(`Visual capability ${input.id} cannot have a nonvisual reason.`)
  return Object.freeze({ id: input.id, paths, evidence: input.evidence, ...(input.reason ? { reason: input.reason.trim() } : {}) })
}

export function defineEvidenceScenario(input: EvidenceScenarioDefinition): EvidenceScenarioDefinition {
  validId(input.id, "scenario")
  if (!input.title.trim()) throw new Error(`Scenario ${input.id} requires a title.`)
  const capabilities = sortedUnique(input.capabilities.map(id => validId(id, "capability")))
  const adapters = sortedUnique(input.adapters)
  const assertions = sortedUnique(input.assertions.map(id => validId(id, "assertion")))
  const screenshots = sortedUnique(input.screenshots.map(id => validId(id, "checkpoint")))
  if (!capabilities.length || !adapters.length || !assertions.length) throw new Error(`Scenario ${input.id} is incomplete.`)
  if (!screenshots.length && !input.video) throw new Error(`Scenario ${input.id} requires visual evidence.`)
  return Object.freeze({ id: input.id, title: input.title.trim(), capabilities, adapters, assertions, screenshots, video: input.video })
}

export function planEvidence(input: Readonly<{
  changed: readonly ChangedPath[]
  capabilities: readonly CapabilityDefinition[]
  scenarios: readonly EvidenceScenarioDefinition[]
}>): EvidencePlan {
  const capabilities = validateCapabilities(input.capabilities)
  const scenarios = validateScenarios(input.scenarios, capabilities)
  const files = new Map<string, { capabilities: Set<string>; evidence: Set<EvidenceKind>; reasons: Set<string> }>()
  for (const change of input.changed) {
    for (const candidate of [change.path, change.previousPath].filter((value): value is string => value !== undefined)) {
      const path = repositoryPath(candidate)
      const matched = capabilities.filter(capability => capability.paths.some(candidatePattern => matches(candidatePattern, path)))
      if (!matched.length) throw new Error(`Unmapped changed path: ${path}`)
      const prior = files.get(path) ?? { capabilities: new Set(), evidence: new Set(), reasons: new Set() }
      for (const capability of matched) {
        prior.capabilities.add(capability.id)
        prior.evidence.add(capability.evidence)
        if (capability.reason) prior.reasons.add(capability.reason)
      }
      files.set(path, prior)
    }
  }
  const visualCapabilities = new Set<string>()
  const plannedFiles = [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => {
    const evidence = value.evidence.has("visual") ? "visual" : "nonvisual"
    for (const id of value.capabilities) if (capabilities.find(capability => capability.id === id)?.evidence === "visual") visualCapabilities.add(id)
    return Object.freeze({
      path,
      capabilities: Object.freeze([...value.capabilities].sort()),
      evidence,
      ...(evidence === "nonvisual" ? { reason: [...value.reasons].sort().join(" ") } : {}),
    })
  })
  const selected = scenarios.filter(scenario => scenario.capabilities.some(id => visualCapabilities.has(id)))
  for (const capability of visualCapabilities) {
    if (!selected.some(scenario => scenario.capabilities.includes(capability))) throw new Error(`Visual capability has no scenario: ${capability}`)
  }
  const adapters = sortedUnique(selected.flatMap(scenario => scenario.adapters))
  const registryDigest = digest({ capabilities, scenarios })
  return Object.freeze({ files: Object.freeze(plannedFiles), scenarios: Object.freeze(selected), adapters: Object.freeze(adapters), registryDigest })
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value))}\n`
}

function validateCapabilities(input: readonly CapabilityDefinition[]): readonly CapabilityDefinition[] {
  const values = input.map(defineCapability).sort((left, right) => left.id.localeCompare(right.id))
  duplicate(values.map(value => value.id), "capability")
  return Object.freeze(values)
}

function validateScenarios(input: readonly EvidenceScenarioDefinition[], capabilities: readonly CapabilityDefinition[]): readonly EvidenceScenarioDefinition[] {
  const known = new Set(capabilities.map(value => value.id))
  const values = input.map(defineEvidenceScenario).sort((left, right) => left.id.localeCompare(right.id))
  duplicate(values.map(value => value.id), "scenario")
  for (const scenario of values) {
    for (const capability of scenario.capabilities) if (!known.has(capability)) throw new Error(`Scenario ${scenario.id} uses unknown capability ${capability}.`)
    if (scenario.capabilities.some(id => capabilities.find(value => value.id === id)?.evidence === "nonvisual")) {
      throw new Error(`Scenario ${scenario.id} uses a nonvisual capability.`)
    }
  }
  return Object.freeze(values)
}

function matches(candidatePattern: string, path: string): boolean {
  const source = candidatePattern.split("/").map((segment, index, segments) => {
    if (segment === "**") return index === segments.length - 1 ? ".*" : "(?:[^/]+/)*"
    return segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*")
  }).join("/")
  return new RegExp(`^${source}$`, "u").test(path)
}

function pattern(value: string): string {
  const normalized = repositoryPath(value)
  if (normalized.includes("***")) throw new Error(`Invalid source pattern: ${value}`)
  return normalized
}

function repositoryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) || normalized.includes("\0") || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid repository path: ${value}`)
  }
  return normalized
}

function validId(value: string, label: string): string {
  if (!ID.test(value)) throw new Error(`Invalid ${label} id: ${value}`)
  return value
}

function duplicate(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} id.`)
}

function sortedUnique<Value extends string>(values: readonly Value[]): readonly Value[] {
  return Object.freeze([...new Set(values)].sort())
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortValue(item)]))
}

function exactObject(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !keys.includes(key)) || keys.some(key => !optional.includes(key) && !(key in item))) throw new Error(`Invalid ${label} keys.`)
  return item
}

function unknownArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  return unknownArray(value, label).map(item => text(item, label))
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`)
  return value
}
