import { validateComponentDefinition } from './component-model.js'
import type { ComponentDefinition, ComponentPropertyDefinition, ComponentScalarValue } from './component-model.js'

export type ComponentRepositoryAccess = Readonly<{
  provider: 'github'
  projectId: string
  repositoryId: string
}>

export type CodeComponentBinding = Readonly<{
  id: string
  access: ComponentRepositoryAccess
  adapterId: string
  path: string
  exportName: string
  sourceHash: string
  registryFingerprint: string
}>

export type VerifiedCodeComponent = Readonly<{
  componentId: string
  path: string
  exportName: string
  sourceHash: string
  registryFingerprint: string
  props: Readonly<Record<string, Readonly<{ kind: 'string' | 'number' | 'boolean'; optional: boolean }> | Readonly<{ kind: 'enum'; values: readonly (string | number | boolean)[]; optional: boolean }>>>
  slots: readonly string[]
}>

export type CodeComponentAdmission = Readonly<{
  componentId: string
  binding: CodeComponentBinding
  component: VerifiedCodeComponent
  defaults: Readonly<Record<string, ComponentScalarValue>>
  docs?: Readonly<{ slug: string; description?: string }>
}>

export type ScannedCodeComponentProperty = Readonly<{
  name: string
  type: string
  optional: boolean
}>

export type VerifiedCodeComponentCatalogEntry = Readonly<{
  componentId: string
  path: string
  exportName: string
  sourceHash: string
  props: readonly ScannedCodeComponentProperty[]
  slots: readonly string[]
}>

const idPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
const sourceHashPattern = /^[a-f0-9]{64}$/
const registryFingerprintPattern = /^(?:sha256:[a-f0-9]{64}|sha256-[A-Za-z0-9+/]{43}=)$/
const sourcePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._/@+-]+)*$/
const exportNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/
const adapterIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/

const invalid = (message: string): never => { throw new Error(message) }
const own = (value: object, key: string) => Object.hasOwn(value, key)
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string) => {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalid(`Invalid ${label}`)
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown, limit = 128): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit

function validateAccess(input: unknown): ComponentRepositoryAccess {
  const candidate = record(input) ? input : invalid('Invalid component repository access')
  exact(candidate, ['provider', 'projectId', 'repositoryId'], [], 'component repository access')
  if (candidate.provider !== 'github' || !nonEmpty(candidate.projectId) || !nonEmpty(candidate.repositoryId)) invalid('Invalid component repository access')
  return structuredClone(candidate) as unknown as ComponentRepositoryAccess
}

export function validateCodeComponentBinding(input: unknown): CodeComponentBinding {
  const candidate = record(input) ? input : invalid('Invalid code component binding')
  exact(candidate, ['id', 'access', 'adapterId', 'path', 'exportName', 'sourceHash', 'registryFingerprint'], [], 'code component binding')
  if (!nonEmpty(candidate.id) || !idPattern.test(candidate.id) || !nonEmpty(candidate.adapterId) || !adapterIdPattern.test(candidate.adapterId)
    || !nonEmpty(candidate.path, 1_000) || !sourcePathPattern.test(candidate.path) || !nonEmpty(candidate.exportName) || !exportNamePattern.test(candidate.exportName)
    || typeof candidate.sourceHash !== 'string' || !sourceHashPattern.test(candidate.sourceHash)
    || typeof candidate.registryFingerprint !== 'string' || !registryFingerprintPattern.test(candidate.registryFingerprint)) invalid('Invalid code component binding')
  return { ...structuredClone(candidate), access: validateAccess(candidate.access) } as unknown as CodeComponentBinding
}

function validateEvidence(input: unknown): VerifiedCodeComponent {
  const candidate = record(input) ? input : invalid('Invalid verified component evidence')
  exact(candidate, ['componentId', 'path', 'exportName', 'sourceHash', 'registryFingerprint', 'props', 'slots'], [], 'verified component evidence')
  if (!nonEmpty(candidate.componentId) || !idPattern.test(candidate.componentId) || !nonEmpty(candidate.path, 1_000) || !sourcePathPattern.test(candidate.path)
    || !nonEmpty(candidate.exportName) || !exportNamePattern.test(candidate.exportName) || typeof candidate.sourceHash !== 'string' || !sourceHashPattern.test(candidate.sourceHash)
    || typeof candidate.registryFingerprint !== 'string' || !registryFingerprintPattern.test(candidate.registryFingerprint)
    || !record(candidate.props) || !Array.isArray(candidate.slots)) invalid('Invalid verified component evidence')
  const props = candidate.props as Record<string, unknown>
  const slots = candidate.slots as unknown[]
  const names = new Set<string>()
  for (const [name, untrustedRule] of Object.entries(props)) {
    if (!exportNamePattern.test(name) || names.has(name)) invalid('Invalid verified component property')
    names.add(name)
    const rawRule = record(untrustedRule) ? untrustedRule : invalid('Invalid verified component property')
    if (rawRule.kind === 'enum') {
      exact(rawRule, ['kind', 'values', 'optional'], [], 'verified component property')
      if (!Array.isArray(rawRule.values) || !rawRule.values.length || rawRule.values.length > 64 || rawRule.values.some((value: unknown) => !['string', 'number', 'boolean'].includes(typeof value))) invalid('Invalid verified component property')
    } else {
      exact(rawRule, ['kind', 'optional'], [], 'verified component property')
      if (!['string', 'number', 'boolean'].includes(rawRule.kind as string)) invalid('Invalid verified component property')
    }
    if (typeof rawRule.optional !== 'boolean') invalid('Invalid verified component property')
  }
  for (const slot of slots) {
    if (typeof slot !== 'string' || !exportNamePattern.test(slot) || names.has(slot)) invalid('Invalid verified component slot')
    names.add(slot as string)
  }
  if (new Set(slots).size !== slots.length) invalid('Invalid verified component slot')
  return structuredClone(candidate) as unknown as VerifiedCodeComponent
}

export const codeComponentValueId = (value: string | number | boolean) => {
  const bytes = new TextEncoder().encode(`${typeof value}:${String(value)}`)
  return `value:${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

const quotedString = /^(?:'([^']*)'|"([^"]*)")$/

function ruleFromScannedProperty(prop: ScannedCodeComponentProperty): VerifiedCodeComponent['props'][string] | null {
  const members = prop.type.split('|').map(member => member.trim()).filter(member => member !== 'undefined' && member !== 'null')
  if (members.length === 1 && ['string', 'number', 'boolean'].includes(members[0]!)) {
    return { kind: members[0] as 'string' | 'number' | 'boolean', optional: prop.optional }
  }
  const values = members.map(member => quotedString.exec(member)).map(match => match?.[1] ?? match?.[2])
  if (values.length > 1 && values.length <= 64 && values.every((value): value is string => value !== undefined)) {
    return { kind: 'enum', values, optional: prop.optional }
  }
  return null
}

/** Projects scanner facts into the subset the canvas can represent without inventing source behavior. */
export function codeComponentPropertiesFromScan(
  scannedProps: readonly ScannedCodeComponentProperty[],
  scannedSlots: readonly string[],
): ComponentPropertyDefinition[] {
  const slots = new Set(scannedSlots)
  const properties = scannedProps.flatMap((prop): ComponentPropertyDefinition[] => {
    if (slots.has(prop.name) || !exportNamePattern.test(prop.name)) return []
    const id = `property:${prop.name}`
    if (id.length > 128) return []
    const optional = prop.optional ? { optional: true as const } : {}
    const rule = ruleFromScannedProperty(prop)
    if (rule?.kind === 'string') return [{ id, name: prop.name, type: 'text', defaultValue: '', ...optional }]
    if (rule?.kind === 'boolean') return [{ id, name: prop.name, type: 'boolean', defaultValue: false, ...optional }]
    if (rule?.kind === 'enum' && rule.values.every((value): value is string => typeof value === 'string')) {
      return [{
        id,
        name: prop.name,
        type: 'variant',
        defaultValueId: codeComponentValueId(rule.values[0]!),
        values: rule.values.map(name => ({ id: codeComponentValueId(name), name })),
        ...optional,
      }]
    }
    return []
  })
  for (const name of slots) {
    const id = `property:${name}`
    if (exportNamePattern.test(name) && id.length <= 128) properties.push({ id, name, type: 'slot', optional: true })
  }
  return properties
}

/** Converts an exact verified catalog entry into the closed evidence accepted by component admission. */
export function verifiedCodeComponentFromCatalog(registryFingerprint: string, component: VerifiedCodeComponentCatalogEntry): VerifiedCodeComponent {
  if (!registryFingerprintPattern.test(registryFingerprint)) invalid('Invalid verified component registry fingerprint')
  const slots = new Set(component.slots)
  const props: Record<string, VerifiedCodeComponent['props'][string]> = {}
  for (const prop of component.props) {
    if (slots.has(prop.name)) continue
    const rule = ruleFromScannedProperty(prop)
    props[prop.name] = rule ?? invalid('Verified component property cannot be represented')
  }
  return validateEvidence({
    componentId: component.componentId,
    path: component.path,
    exportName: component.exportName,
    sourceHash: component.sourceHash,
    registryFingerprint,
    props,
    slots: component.slots,
  })
}

function scalarProperties(component: VerifiedCodeComponent, defaults: Readonly<Record<string, ComponentScalarValue>>): ComponentPropertyDefinition[] {
  const expectedDefaults = new Set(Object.entries(component.props).flatMap(([name, rule]) => rule.optional ? [] : [name]))
  if (Object.keys(defaults).some(name => !expectedDefaults.has(name)) || [...expectedDefaults].some(name => !own(defaults, name))) invalid('Component admission defaults do not match the verified props')
  const properties: ComponentPropertyDefinition[] = []
  for (const [name, rule] of Object.entries(component.props)) {
    const defaultValue = defaults[name]
    if (rule.kind === 'string') {
      if (!rule.optional && typeof defaultValue !== 'string') invalid('Component admission default does not match the verified prop')
      properties.push({ id: `property:${name}`, name, type: 'text', defaultValue: rule.optional ? '' : defaultValue as string, ...(rule.optional ? { optional: true } : {}) })
    } else if (rule.kind === 'boolean') {
      if (!rule.optional && typeof defaultValue !== 'boolean') invalid('Component admission default does not match the verified prop')
      properties.push({ id: `property:${name}`, name, type: 'boolean', defaultValue: rule.optional ? false : defaultValue as boolean, ...(rule.optional ? { optional: true } : {}) })
    } else if (rule.kind === 'enum') {
      if (!rule.values.every(value => typeof value === 'string') || (!rule.optional && (typeof defaultValue !== 'string' || !rule.values.includes(defaultValue)))) invalid('Component admission enum cannot be represented without changing source values')
      const representedDefault = rule.optional ? rule.values[0] as string : defaultValue as string
      properties.push({
        id: `property:${name}`,
        name,
        type: 'variant',
        defaultValueId: codeComponentValueId(representedDefault),
        values: rule.values.map(value => ({ id: codeComponentValueId(value), name: String(value) })),
        ...(rule.optional ? { optional: true } : {}),
      })
    } else invalid('Numeric component props need an explicit adapter')
  }
  return properties
}

function assertEvidenceMatchesBinding(binding: CodeComponentBinding, component: VerifiedCodeComponent): void {
  if (binding.path !== component.path || binding.exportName !== component.exportName || binding.sourceHash !== component.sourceHash || binding.registryFingerprint !== component.registryFingerprint) {
    invalid('Component source evidence changed before admission')
  }
}

/** Admits only exact, already-authorized scanner evidence. It never infers repository access or source defaults. */
export function admitCodeComponent(input: CodeComponentAdmission): Readonly<{ binding: CodeComponentBinding; definition: ComponentDefinition }> {
  const serialized = record(input) ? input : invalid('Invalid code component admission')
  exact(serialized, ['componentId', 'binding', 'component', 'defaults'], ['docs'], 'code component admission')
  if (typeof input.componentId !== 'string' || !idPattern.test(input.componentId) || !record(input.defaults)) invalid('Invalid code component admission')
  const binding = validateCodeComponentBinding(input.binding)
  const component = validateEvidence(input.component)
  assertEvidenceMatchesBinding(binding, component)
  const definition = validateComponentDefinition({
    id: input.componentId,
    name: component.exportName,
    source: { kind: 'code', bindingId: binding.id },
    revision: 0,
    properties: [...scalarProperties(component, input.defaults), ...component.slots.map(name => ({ id: `property:${name}`, name, type: 'slot' as const, optional: true as const }))],
    materials: [],
    parts: [],
    interactions: [],
    ...(input.docs ? { docs: input.docs } : {}),
  })
  return { binding, definition }
}

/** Applies an explicitly reviewed source move or rename while preserving the persistent binding identity. */
export function rebindCodeComponent(bindingInput: CodeComponentBinding, expectedInput: VerifiedCodeComponent, componentInput: VerifiedCodeComponent): CodeComponentBinding {
  const binding = validateCodeComponentBinding(bindingInput)
  const expected = validateEvidence(expectedInput)
  const component = validateEvidence(componentInput)
  assertEvidenceMatchesBinding(binding, expected)
  return validateCodeComponentBinding({
    ...binding,
    path: component.path,
    exportName: component.exportName,
    sourceHash: component.sourceHash,
    registryFingerprint: component.registryFingerprint,
  })
}
