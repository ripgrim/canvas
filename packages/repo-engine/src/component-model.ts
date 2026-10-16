import { validateAppearance } from './appearance.js'
import type { Appearance } from './appearance.js'

export type ComponentSource =
  | Readonly<{ kind: 'canvas'; masterRootId: string }>
  | Readonly<{ kind: 'code'; bindingId: string }>

type ComponentPropertyBase = Readonly<{ id: string; name: string; description?: string; optional?: true }>
export type ComponentPropertyBinding =
  | Readonly<{ kind: 'variant'; nodeId: string; appearances: Readonly<Record<string, Appearance>> }>
  | Readonly<{ kind: 'text'; nodeId: string }>
  | Readonly<{ kind: 'visibility'; nodeId: string }>
  | Readonly<{ kind: 'slot'; nodeId: string }>
  | Readonly<{ kind: 'instance-swap'; nodeId: string }>
export type VariantProperty = ComponentPropertyBase & Readonly<{
  type: 'variant'
  defaultValueId: string
  values: readonly Readonly<{ id: string; name: string }>[]
  binding?: Extract<ComponentPropertyBinding, { kind: 'variant' }>
  currentValueId?: string
}>
export type TextProperty = ComponentPropertyBase & Readonly<{ type: 'text'; defaultValue: string; binding?: Extract<ComponentPropertyBinding, { kind: 'text' }> }>
export type BooleanProperty = ComponentPropertyBase & Readonly<{ type: 'boolean'; defaultValue: boolean; binding?: Extract<ComponentPropertyBinding, { kind: 'visibility' }> }>
export type SlotProperty = ComponentPropertyBase & Readonly<{ type: 'slot'; binding?: Extract<ComponentPropertyBinding, { kind: 'slot' }> }>
export type InstanceSwapProperty = ComponentPropertyBase & Readonly<{ type: 'instance-swap'; defaultValue: string; binding: Extract<ComponentPropertyBinding, { kind: 'instance-swap' }> }>
export type ComponentPropertyDefinition = VariantProperty | TextProperty | BooleanProperty | SlotProperty | InstanceSwapProperty

export type ComponentMaterial = Readonly<{
  id: string
  group: string
  name: string
  description?: string
  appearance: Appearance
}>

export type ComponentPart = Readonly<{
  id: string
  name: string
  nodeId: string
  materialId?: string
}>

export type ComponentInteraction = Readonly<{
  id: string
  trigger: 'pointer-hover' | 'pointer-press'
  propertyId: string
  valueId: string
  transition?: Readonly<{
    type: 'instant' | 'smart-animate'
    durationMs?: number
    easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
  }>
}>

export type ComponentDefinition = Readonly<{
  id: string
  name: string
  source: ComponentSource
  revision: number
  properties: readonly ComponentPropertyDefinition[]
  materials: readonly ComponentMaterial[]
  parts: readonly ComponentPart[]
  interactions: readonly ComponentInteraction[]
  docs?: Readonly<{ slug: string; description?: string }>
}>

export type ComponentScalarValue = string | boolean
export type ComponentInstanceValues = Readonly<Record<string, ComponentScalarValue>>
export type ComponentInstanceRecord = Readonly<{
  id: string
  componentId: string
  values: ComponentInstanceValues
}>

export type ComponentModelState = Readonly<{
  definitions: Readonly<Record<string, ComponentDefinition>>
  instances: Readonly<Record<string, ComponentInstanceRecord>>
}>

/** Atomic master-authoring transactions. A caller drafts a complete next definition, then replaces it at one checked revision. */
export type ComponentAuthoringCommand =
  | Readonly<{ type: 'component.create'; definition: ComponentDefinition }>
  | Readonly<{ type: 'component.replace'; componentId: string; expectedRevision: number; definition: ComponentDefinition }>
  | Readonly<{ type: 'component.delete'; componentId: string; expectedRevision: number }>
  /** Exact history primitive. `null` means the definition must be absent. */
  | Readonly<{ type: 'component.restore'; componentId: string; expected: ComponentDefinition | null; source: ComponentDefinition | null }>
  | Readonly<{ type: 'component.instance.create'; instance: ComponentInstanceRecord }>
  | Readonly<{ type: 'component.instance.replace'; instanceId: string; expected: ComponentInstanceRecord; instance: ComponentInstanceRecord }>
  | Readonly<{ type: 'component.instance.delete'; instanceId: string; expected: ComponentInstanceRecord }>
  /** Exact history primitive. `null` means the instance must be absent. */
  | Readonly<{ type: 'component.instance.restore'; instanceId: string; expected: ComponentInstanceRecord | null; source: ComponentInstanceRecord | null }>

export const emptyComponentModelState = (): ComponentModelState => ({ definitions: {}, instances: {} })

export type ComponentDocsManifest = Readonly<{
  componentId: string
  name: string
  slug: string
  route: string
  description?: string
  source: ComponentSource['kind']
  openInCanvas: Readonly<{ componentId: string }>
  usage: Readonly<{ status: 'available'; snippet: string }> | Readonly<{ status: 'unavailable'; reason: 'canvas-source' | 'source-adapter-required' }>
  controls: readonly Readonly<{
    id: string
    name: string
    description?: string
    optional?: true
    type: ComponentPropertyDefinition['type']
    defaultValue?: ComponentScalarValue
    options?: readonly Readonly<{ id: string; name: string }>[]
  }>[]
  combinations: readonly ComponentInstanceValues[]
}>

export type ComponentDocsCatalog = Readonly<{
  version: 1
  navigation: readonly Readonly<{ title: string; href: string; componentId: string }>[]
  components: readonly ComponentDocsManifest[]
}>

const idPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const modelLimits = { definitions: 500, instances: 5_000, properties: 64, variantValues: 64, materials: 128, parts: 5_000, interactions: 256, text: 10_000 }
export const componentDescriptionLimit = 500
const own = (value: object, key: string) => Object.hasOwn(value, key)
const invalid = (message: string): never => { throw new Error(message) }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asRecord = (value: unknown, message: string): Record<string, unknown> => { if (!record(value)) throw new Error(message); return value }
const asArray = (value: unknown, message: string): unknown[] => { if (!Array.isArray(value)) throw new Error(message); return value }
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string) => {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalid(`Invalid ${label}`)
}
const validId = (value: string, label: string) => { if (!idPattern.test(value)) invalid(`Invalid ${label}`) }
const validName = (value: string, label: string) => { if (!value.trim() || value.length > 128) invalid(`Invalid ${label}`) }
const unique = (values: readonly string[], label: string) => { if (new Set(values).size !== values.length) invalid(`Duplicate ${label}`) }
const validDescription = (value: unknown) => typeof value === 'string' && value.length <= componentDescriptionLimit
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function validateProperty(property: ComponentPropertyDefinition): void {
  validId(property.id, 'component property id')
  validName(property.name, 'component property name')
  if (property.type === 'instance-swap') validId(property.defaultValue, 'Instance swap component id')
  if (property.type !== 'variant') return
  if (!property.values.length) invalid('A variant property needs at least one value')
  unique(property.values.map(value => value.id), 'variant value id')
  unique(property.values.map(value => value.name.toLocaleLowerCase()), 'variant value name')
  for (const value of property.values) {
    validId(value.id, 'variant value id')
    validName(value.name, 'variant value name')
  }
  if (!property.values.some(value => value.id === property.defaultValueId)) invalid('Variant default value is missing')
}

function validatePropertyBinding(property: ComponentPropertyDefinition, value: unknown): void {
  const binding = asRecord(value, 'Invalid component property binding')
  exact(binding, ['kind', 'nodeId'], property.type === 'variant' ? ['appearances'] : [], 'component property binding')
  const nodeId = typeof binding.nodeId === 'string' ? binding.nodeId : invalid('Invalid component property binding')
  validId(nodeId, 'component property binding node id')
  const expected = property.type === 'variant' ? 'variant' : property.type === 'text' ? 'text' : property.type === 'boolean' ? 'visibility' : property.type === 'slot' ? 'slot' : property.type === 'instance-swap' ? 'instance-swap' : null
  if (binding.kind !== expected) invalid('Invalid component property binding')
  if (property.type === 'variant') {
    const appearances = asRecord(binding.appearances, 'Invalid component variant appearances')
    if (Object.keys(appearances).length !== property.values.length || property.values.some(option => !own(appearances, option.id))) invalid('Invalid component variant appearances')
    for (const [valueId, appearance] of Object.entries(appearances)) {
      if (!property.values.some(option => option.id === valueId)) invalid('Invalid component variant appearances')
      validateAppearance(appearance, 'component')
    }
  }
}

export function validateComponentDefinition(input: unknown): ComponentDefinition {
  if (!record(input)) throw new Error('Invalid component definition')
  const candidate = input
  exact(candidate, ['id', 'name', 'source', 'revision', 'properties', 'materials', 'parts', 'interactions'], ['docs'], 'component definition')
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0) invalid('Invalid component definition')
  const source = asRecord(candidate.source, 'Invalid component source')
  if (source.kind === 'canvas') {
    exact(source, ['kind', 'masterRootId'], [], 'component source')
    if (typeof source.masterRootId !== 'string') invalid('Invalid component source')
  } else if (source.kind === 'code') {
    exact(source, ['kind', 'bindingId'], [], 'component source')
    if (typeof source.bindingId !== 'string') invalid('Invalid component source')
  } else invalid('Invalid component source')
  const serializedProperties = asArray(candidate.properties, 'Invalid component definition')
  const materials = asArray(candidate.materials, 'Invalid component definition')
  const parts = asArray(candidate.parts, 'Invalid component definition')
  const interactions = asArray(candidate.interactions, 'Invalid component definition')
  if (serializedProperties.length > modelLimits.properties || materials.length > modelLimits.materials || parts.length > modelLimits.parts || interactions.length > modelLimits.interactions) invalid('Component definition exceeds the supported limit')
  for (const rawProperty of serializedProperties) {
    const property = asRecord(rawProperty, 'Invalid component property')
    if (typeof property.id !== 'string' || typeof property.name !== 'string') invalid('Invalid component property')
    const optional = ['description', 'optional']
    if (property.type === 'variant') {
      exact(property, ['id', 'name', 'type', 'defaultValueId', 'values'], [...optional, 'binding', 'currentValueId'], 'component property')
      if (typeof property.defaultValueId !== 'string') invalid('Invalid component property')
      const values = asArray(property.values, 'Invalid component property')
      if (values.length > modelLimits.variantValues) invalid('Component variant exceeds the supported limit')
      for (const rawValue of values) {
        const value = asRecord(rawValue, 'Invalid variant value')
        exact(value, ['id', 'name'], [], 'variant value')
        if (typeof value.id !== 'string' || typeof value.name !== 'string') invalid('Invalid variant value')
      }
      if (own(property, 'currentValueId') && typeof property.currentValueId !== 'string') invalid('Invalid component property')
    } else if (property.type === 'text') {
      exact(property, ['id', 'name', 'type', 'defaultValue'], [...optional, 'binding'], 'component property')
      if (typeof property.defaultValue !== 'string' || property.defaultValue.length > modelLimits.text) invalid('Invalid component property')
    } else if (property.type === 'boolean') {
      exact(property, ['id', 'name', 'type', 'defaultValue'], [...optional, 'binding'], 'component property')
      if (typeof property.defaultValue !== 'boolean') invalid('Invalid component property')
    } else if (property.type === 'slot') exact(property, ['id', 'name', 'type'], [...optional, 'binding'], 'component property')
    else if (property.type === 'instance-swap') {
      exact(property, ['id', 'name', 'type', 'defaultValue', 'binding'], optional, 'component property')
      if (typeof property.defaultValue !== 'string') invalid('Invalid component property')
    }
    else invalid('Invalid component property')
    if (own(property, 'description') && !validDescription(property.description)) invalid('Invalid component property description')
    if (own(property, 'optional') && property.optional !== true) invalid('Invalid component property optionality')
    if (own(property, 'binding')) validatePropertyBinding(property as unknown as ComponentPropertyDefinition, property.binding)
  }
  for (const rawMaterial of materials) {
    const material = asRecord(rawMaterial, 'Invalid component material')
    exact(material, ['id', 'group', 'name', 'appearance'], ['description'], 'component material')
    if (typeof material.id !== 'string' || typeof material.group !== 'string' || typeof material.name !== 'string') invalid('Invalid component material')
    if (own(material, 'description') && !validDescription(material.description)) invalid('Invalid component material description')
    validateAppearance(material.appearance, 'component')
  }
  for (const rawPart of parts) {
    const part = asRecord(rawPart, 'Invalid component part')
    exact(part, ['id', 'name', 'nodeId'], ['materialId'], 'component part')
    if (typeof part.id !== 'string' || typeof part.name !== 'string' || typeof part.nodeId !== 'string' || (own(part, 'materialId') && typeof part.materialId !== 'string')) invalid('Invalid component part')
  }
  for (const rawInteraction of interactions) {
    const interaction = asRecord(rawInteraction, 'Invalid component interaction')
    exact(interaction, ['id', 'trigger', 'propertyId', 'valueId'], ['transition'], 'component interaction')
    if (typeof interaction.id !== 'string' || !['pointer-hover', 'pointer-press'].includes(interaction.trigger as string) || typeof interaction.propertyId !== 'string' || typeof interaction.valueId !== 'string') invalid('Invalid component interaction')
    if (own(interaction, 'transition')) {
      const transition = asRecord(interaction.transition, 'Invalid component transition')
      exact(transition, ['type'], ['durationMs', 'easing'], 'component transition')
      if (!['instant', 'smart-animate'].includes(transition.type as string)) invalid('Invalid component transition')
      if (own(transition, 'durationMs') && typeof transition.durationMs !== 'number') invalid('Invalid component transition')
      if (own(transition, 'easing') && !['linear', 'ease-in', 'ease-out', 'ease-in-out'].includes(transition.easing as string)) invalid('Invalid component transition')
    }
  }
  if (own(candidate, 'docs')) {
    const docs = asRecord(candidate.docs, 'Invalid component docs')
    exact(docs, ['slug'], ['description'], 'component docs')
    if (typeof docs.slug !== 'string' || (own(docs, 'description') && !validDescription(docs.description))) invalid('Invalid component docs')
  }
  const definition = candidate as unknown as ComponentDefinition
  if (definition.source.kind !== 'code' && definition.properties.some(property => property.optional)) invalid('Canvas component properties cannot be optional')
  if (definition.source.kind === 'code' && definition.properties.some(property => property.type === 'instance-swap')) invalid('Code components cannot define Instance swap properties')
  validId(definition.id, 'component id')
  validName(definition.name, 'component name')
  if (definition.source.kind === 'canvas') validId(definition.source.masterRootId, 'component master root id')
  else validId(definition.source.bindingId, 'component source binding id')
  unique(definition.properties.map(property => property.id), 'component property id')
  unique(definition.properties.map(property => property.name.toLocaleLowerCase()), 'component property name')
  unique(definition.properties.filter((property): property is InstanceSwapProperty => property.type === 'instance-swap').map(property => property.binding.nodeId), 'component Instance swap binding')
  definition.properties.forEach(validateProperty)
  for (const property of definition.properties) {
    if (property.type === 'variant' && property.currentValueId !== undefined && !property.values.some(value => value.id === property.currentValueId)) invalid('Current variant value is missing')
  }
  unique(definition.materials.map(material => material.id), 'component material id')
  unique(definition.materials.map(material => `${material.group.toLocaleLowerCase()}\u0000${material.name.toLocaleLowerCase()}`), 'component material name')
  for (const material of definition.materials) {
    validId(material.id, 'component material id')
    validName(material.group, 'component material group')
    validName(material.name, 'component material name')
  }
  const materialIds = new Set(definition.materials.map(material => material.id))
  unique(definition.parts.map(part => part.id), 'component part id')
  unique(definition.parts.map(part => part.nodeId), 'component part node')
  for (const part of definition.parts) {
    validId(part.id, 'component part id')
    validId(part.nodeId, 'component part node id')
    validName(part.name, 'component part name')
    if (part.materialId !== undefined && !materialIds.has(part.materialId)) invalid('Component part references a missing material')
  }
  unique(definition.interactions.map(interaction => interaction.id), 'component interaction id')
  const propertyDefinitions = new Map(definition.properties.map(property => [property.id, property]))
  for (const interaction of definition.interactions) {
    validId(interaction.id, 'component interaction id')
    const property = propertyDefinitions.get(interaction.propertyId)
    if (property?.type !== 'variant' || !property.values.some(value => value.id === interaction.valueId)) invalid('Component interaction references a missing variant value')
    if (interaction.transition?.durationMs !== undefined && (!Number.isFinite(interaction.transition.durationMs) || interaction.transition.durationMs < 0 || interaction.transition.durationMs > 60_000)) invalid('Invalid component transition duration')
  }
  if (definition.docs && !slugPattern.test(definition.docs.slug)) invalid('Invalid component docs slug')
  return structuredClone(definition)
}

export function validateComponentModelState(input: unknown): ComponentModelState {
  if (!record(input)) throw new Error('Invalid component model state')
  const candidate = input
  exact(candidate, ['definitions', 'instances'], [], 'component model state')
  const serializedDefinitions = asRecord(candidate.definitions, 'Invalid component model state')
  const serializedInstances = asRecord(candidate.instances, 'Invalid component model state')
  if (Object.keys(serializedDefinitions).length > modelLimits.definitions || Object.keys(serializedInstances).length > modelLimits.instances) invalid('Component model state exceeds the supported limit')
  const definitions: Record<string, ComponentDefinition> = {}
  for (const [id, value] of Object.entries(serializedDefinitions)) {
    const definition = validateComponentDefinition(value)
    if (definition.id !== id) invalid('Invalid component definition identity')
    definitions[id] = definition
  }
  const instances: Record<string, ComponentInstanceRecord> = {}
  for (const [id, rawValue] of Object.entries(serializedInstances)) {
    const value = validateInstanceRecord(rawValue)
    if (value.id !== id) invalid('Invalid component instance')
    const componentId = value.componentId
    const definition = definitions[componentId]
    if (!definition) throw new Error('Component instance references a missing definition')
    resolveComponentInstanceValues(definition, value.values)
    instances[id] = value
  }
  for (const definition of Object.values(definitions)) {
    for (const property of definition.properties) {
      if (property.type !== 'instance-swap') continue
      validateInstanceSwapComponent(definitions, property.defaultValue)
    }
  }
  for (const instance of Object.values(instances)) {
    const definition = definitions[instance.componentId]!
    for (const property of definition.properties) {
      if (property.type !== 'instance-swap') continue
      validateInstanceSwapComponent(definitions, String(instance.values[property.id] ?? property.defaultValue))
    }
  }
  validateInstanceSwapCycles(definitions, instances)
  return { definitions, instances }
}

function validateInstanceSwapComponent(definitions: Readonly<Record<string, ComponentDefinition>>, componentId: string): void {
  const target = definitions[componentId]
  if (!target) invalid('Instance swap references a missing component definition')
  if (target?.source.kind !== 'canvas') invalid('Instance swap requires a canvas component definition')
}

function validateInstanceSwapCycles(definitions: Readonly<Record<string, ComponentDefinition>>, instances: Readonly<Record<string, ComponentInstanceRecord>>): void {
  const dependencies = new Map<string, Set<string>>()
  for (const definition of Object.values(definitions)) {
    const targets = new Set<string>()
    dependencies.set(definition.id, targets)
    for (const property of definition.properties) if (property.type === 'instance-swap') targets.add(property.defaultValue)
  }
  for (const instance of Object.values(instances)) {
    const definition = definitions[instance.componentId]!
    const targets = dependencies.get(definition.id)!
    for (const property of definition.properties) {
      if (property.type !== 'instance-swap') continue
      const value = instance.values[property.id]
      if (typeof value === 'string') targets.add(value)
    }
  }
  const visited = new Set<string>()
  const active = new Set<string>()
  const visit = (componentId: string): void => {
    if (active.has(componentId)) invalid('Components cannot contain themselves recursively')
    if (visited.has(componentId)) return
    active.add(componentId)
    for (const dependency of dependencies.get(componentId) ?? []) visit(dependency)
    active.delete(componentId)
    visited.add(componentId)
  }
  for (const componentId of dependencies.keys()) visit(componentId)
}

function validateInstanceRecord(input: unknown): ComponentInstanceRecord {
  const value = asRecord(input, 'Invalid component instance')
  exact(value, ['id', 'componentId', 'values'], [], 'component instance')
  const instanceId = typeof value.id === 'string' ? value.id : invalid('Invalid component instance')
  const componentId = typeof value.componentId === 'string' ? value.componentId : invalid('Invalid component instance')
  const values = record(value.values) ? value.values : invalid('Invalid component instance')
  validId(instanceId, 'component instance id')
  validId(componentId, 'component id')
  if (Object.keys(values).length > modelLimits.properties) invalid('Component instance exceeds the supported limit')
  for (const [propertyId, scalar] of Object.entries(values)) {
    validId(propertyId, 'component property id')
    if (typeof scalar !== 'string' && typeof scalar !== 'boolean' || typeof scalar === 'string' && scalar.length > modelLimits.text) invalid('Invalid component instance value')
  }
  return structuredClone(value) as unknown as ComponentInstanceRecord
}

export function validateComponentAuthoringCommand(input: unknown): ComponentAuthoringCommand {
  const command = asRecord(input, 'Invalid component authoring command')
  if (command.type === 'component.create') {
    exact(command, ['type', 'definition'], [], 'component authoring command')
    return { type: 'component.create', definition: validateComponentDefinition(command.definition) }
  }
  if (command.type === 'component.replace') {
    exact(command, ['type', 'componentId', 'expectedRevision', 'definition'], [], 'component authoring command')
    const componentId = command.componentId
    const expectedRevision = command.expectedRevision
    if (typeof componentId !== 'string' || !validRevision(expectedRevision)) throw new Error('Invalid component authoring command')
    validId(componentId, 'component id')
    return { type: 'component.replace', componentId, expectedRevision, definition: validateComponentDefinition(command.definition) }
  }
  if (command.type === 'component.delete') {
    exact(command, ['type', 'componentId', 'expectedRevision'], [], 'component authoring command')
    const componentId = command.componentId
    const expectedRevision = command.expectedRevision
    if (typeof componentId !== 'string' || !validRevision(expectedRevision)) throw new Error('Invalid component authoring command')
    validId(componentId, 'component id')
    return { type: 'component.delete', componentId, expectedRevision }
  }
  if (command.type === 'component.restore') {
    exact(command, ['type', 'componentId', 'expected', 'source'], [], 'component authoring command')
    const componentId = command.componentId
    if (typeof componentId !== 'string' || command.expected !== null && !record(command.expected) || command.source !== null && !record(command.source)) throw new Error('Invalid component authoring command')
    validId(componentId, 'component id')
    const expected = command.expected === null ? null : validateComponentDefinition(command.expected)
    const source = command.source === null ? null : validateComponentDefinition(command.source)
    if (expected !== null && expected.id !== componentId || source !== null && source.id !== componentId) invalid('Component identity cannot change')
    return {
      type: 'component.restore',
      componentId,
      expected,
      source,
    }
  }
  if (command.type === 'component.instance.create') {
    exact(command, ['type', 'instance'], [], 'component authoring command')
    return { type: 'component.instance.create', instance: validateInstanceRecord(command.instance) }
  }
  if (command.type === 'component.instance.replace') {
    exact(command, ['type', 'instanceId', 'expected', 'instance'], [], 'component authoring command')
    const instanceId = typeof command.instanceId === 'string' ? command.instanceId : invalid('Invalid component authoring command')
    validId(instanceId, 'component instance id')
    const expected = validateInstanceRecord(command.expected)
    const instance = validateInstanceRecord(command.instance)
    if (expected.id !== instanceId || instance.id !== instanceId) invalid('Component instance identity cannot change')
    return { type: 'component.instance.replace', instanceId, expected, instance }
  }
  if (command.type === 'component.instance.delete') {
    exact(command, ['type', 'instanceId', 'expected'], [], 'component authoring command')
    const instanceId = typeof command.instanceId === 'string' ? command.instanceId : invalid('Invalid component authoring command')
    validId(instanceId, 'component instance id')
    const expected = validateInstanceRecord(command.expected)
    if (expected.id !== instanceId) invalid('Component instance identity cannot change')
    return { type: 'component.instance.delete', instanceId, expected }
  }
  if (command.type === 'component.instance.restore') {
    exact(command, ['type', 'instanceId', 'expected', 'source'], [], 'component authoring command')
    const instanceId = typeof command.instanceId === 'string' ? command.instanceId : invalid('Invalid component authoring command')
    if (command.expected !== null && !record(command.expected) || command.source !== null && !record(command.source)) invalid('Invalid component authoring command')
    validId(instanceId, 'component instance id')
    const expected = command.expected === null ? null : validateInstanceRecord(command.expected)
    const source = command.source === null ? null : validateInstanceRecord(command.source)
    if (expected !== null && expected.id !== instanceId || source !== null && source.id !== instanceId) invalid('Component instance identity cannot change')
    if (expected !== null && source !== null && expected.componentId !== source.componentId) invalid('Component instance source cannot change')
    return { type: 'component.instance.restore', instanceId, expected, source }
  }
  return invalid('Invalid component authoring command')
}

export function applyComponentAuthoringCommand(input: ComponentModelState, rawCommand: ComponentAuthoringCommand): ComponentModelState {
  const state = validateComponentModelState(input)
  const command = validateComponentAuthoringCommand(rawCommand)
  const definitions = { ...state.definitions }
  const instances = { ...state.instances }
  if (command.type === 'component.instance.create') {
    if (instances[command.instance.id]) invalid('Component instance identity already exists')
    instances[command.instance.id] = command.instance
    return validateComponentModelState({ definitions, instances })
  }
  if (command.type === 'component.instance.replace') {
    const current = instances[command.instanceId]
    if (!structurallyEqual(current ?? null, command.expected)) invalid('Component instance changed before this edit')
    if (command.instance.componentId !== command.expected.componentId) invalid('Component instance source cannot change')
    instances[command.instanceId] = command.instance
    return validateComponentModelState({ definitions, instances })
  }
  if (command.type === 'component.instance.delete') {
    const current = instances[command.instanceId]
    if (!structurallyEqual(current ?? null, command.expected)) invalid('Component instance changed before this edit')
    delete instances[command.instanceId]
    return validateComponentModelState({ definitions, instances })
  }
  if (command.type === 'component.instance.restore') {
    const current = instances[command.instanceId]
    if (!structurallyEqual(current ?? null, command.expected)) invalid('Component instance changed before this edit')
    if (command.source === null) delete instances[command.instanceId]
    else instances[command.instanceId] = command.source
    return validateComponentModelState({ definitions, instances })
  }
  const current = definitions[command.type === 'component.create' ? command.definition.id : command.componentId]
  if (command.type === 'component.create') {
    if (current) invalid('Component identity already exists')
    if (command.definition.revision !== 0) invalid('A new component starts at revision 0')
    definitions[command.definition.id] = command.definition
  } else if (command.type === 'component.replace') {
    if (!current) throw new Error('Component definition is missing')
    if (current.revision !== command.expectedRevision) invalid('Component definition changed before this edit')
    if (command.definition.id !== command.componentId) invalid('Component identity cannot change')
    if (command.definition.source.kind !== current.source.kind || (command.definition.source.kind === 'canvas' && current.source.kind === 'canvas' && command.definition.source.masterRootId !== current.source.masterRootId) || (command.definition.source.kind === 'code' && current.source.kind === 'code' && command.definition.source.bindingId !== current.source.bindingId)) invalid('Component source identity cannot change')
    if (command.definition.revision !== command.expectedRevision + 1) invalid('Component revision must advance exactly once')
    definitions[command.componentId] = command.definition
  } else if (command.type === 'component.delete') {
    if (!current) throw new Error('Component definition is missing')
    if (current.revision !== command.expectedRevision) invalid('Component definition changed before this edit')
    if (Object.values(state.instances).some(instance => instance.componentId === command.componentId)) invalid('Remove component instances before deleting their definition')
    delete definitions[command.componentId]
  } else {
    if (!structurallyEqual(current ?? null, command.expected)) invalid('Component definition changed before this edit')
    if (command.source === null) {
      if (Object.values(state.instances).some(instance => instance.componentId === command.componentId)) invalid('Remove component instances before deleting their definition')
      delete definitions[command.componentId]
    } else {
      definitions[command.componentId] = command.source
    }
  }
  return validateComponentModelState({ definitions, instances })
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => structurallyEqual(value, right[index]))
  }
  if (!record(left) || !record(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]))
}

export function componentDefaultValues(definition: ComponentDefinition): ComponentInstanceValues {
  const values: Record<string, ComponentScalarValue> = {}
  for (const property of definition.properties) {
    if (property.type === 'variant') values[property.id] = property.defaultValueId
    if (property.type === 'text') values[property.id] = property.defaultValue
    if (property.type === 'boolean') values[property.id] = property.defaultValue
    if (property.type === 'instance-swap') values[property.id] = property.defaultValue
  }
  return values
}

export function resolveComponentInstanceValues(definition: ComponentDefinition, overrides: ComponentInstanceValues): ComponentInstanceValues {
  const values = { ...componentDefaultValues(definition) }
  const properties = new Map(definition.properties.map(property => [property.id, property]))
  for (const [propertyId, value] of Object.entries(overrides)) {
    const property = properties.get(propertyId)
    if (!property) throw new Error('Component instance references a missing scalar property')
    if (property.type === 'slot') throw new Error('Component instance references a missing scalar property')
    if (property.type === 'variant' && (typeof value !== 'string' || !property.values.some(option => option.id === value))) invalid('Component instance has an invalid variant value')
    if (property.type === 'text' && typeof value !== 'string') invalid('Component instance has an invalid text value')
    if (property.type === 'boolean' && typeof value !== 'boolean') invalid('Component instance has an invalid boolean value')
    if (property.type === 'instance-swap') {
      if (typeof value === 'string') validId(value, 'Instance swap component id')
      else invalid('Component instance has an invalid Instance swap value')
    }
    values[propertyId] = value
  }
  return values
}

export function componentVariantCombinations(definition: ComponentDefinition, limit = 256): readonly ComponentInstanceValues[] {
  const variants = definition.properties.filter((property): property is VariantProperty => property.type === 'variant')
  let combinations: Record<string, ComponentScalarValue>[] = [{}]
  for (const property of variants) {
    const next = combinations.flatMap(combination => property.values.map(value => ({ ...combination, [property.id]: value.id })))
    if (next.length > limit) invalid('Component variant combinations exceed the supported limit')
    combinations = next
  }
  return combinations.length ? combinations : [{}]
}

export function componentVariantCombinationLabel(definition: ComponentDefinition, combination: ComponentInstanceValues, fallback = 'Default'): string {
  return definition.properties.flatMap(property => {
    if (property.type !== 'variant') return []
    const valueId = String(combination[property.id] ?? property.defaultValueId)
    const value = property.values.find(candidate => candidate.id === valueId)
    return [`${property.name}: ${value?.name ?? valueId}`]
  }).join(', ') || fallback
}

export function componentDocsSlug(name: string, fallback = 'component'): string {
  const slug = name.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const safeFallback = fallback.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return slug || safeFallback || 'component'
}

export function componentDocsManifest(definition: ComponentDefinition, exactUsageSnippet?: string): ComponentDocsManifest {
  const valid = validateComponentDefinition(definition)
  const controls = valid.properties.map(property => ({
    id: property.id,
    name: property.name,
    ...(property.description ? { description: property.description } : {}),
    ...(property.optional ? { optional: true as const } : {}),
    type: property.type,
    ...(!property.optional && property.type === 'variant' ? { defaultValue: property.defaultValueId } : {}),
    ...(!property.optional && (property.type === 'text' || property.type === 'boolean') ? { defaultValue: property.defaultValue } : {}),
    ...(property.type === 'instance-swap' ? { defaultValue: property.defaultValue } : {}),
    ...(property.type === 'variant' ? { options: property.values.map(value => ({ ...value })) } : {}),
  }))
  const slug = valid.docs?.slug ?? componentDocsSlug(valid.name, valid.id)
  if (exactUsageSnippet !== undefined && (!exactUsageSnippet.trim() || exactUsageSnippet.length > modelLimits.text)) invalid('Invalid component usage snippet')
  return {
    componentId: valid.id,
    name: valid.name,
    slug,
    route: `/components/${slug}`,
    ...(valid.docs?.description ? { description: valid.docs.description } : {}),
    source: valid.source.kind,
    openInCanvas: { componentId: valid.id },
    usage: exactUsageSnippet === undefined
      ? { status: 'unavailable', reason: valid.source.kind === 'canvas' ? 'canvas-source' : 'source-adapter-required' }
      : { status: 'available', snippet: exactUsageSnippet },
    controls,
    combinations: componentVariantCombinations(valid),
  }
}

/** Deterministic, versioned input for the Blume navigation, playground, variant sheet, and canvas deep link. */
export function componentDocsCatalog(state: ComponentModelState, usageSnippets: Readonly<Record<string, string>> = {}): ComponentDocsCatalog {
  const valid = validateComponentModelState(state)
  const unknownUsage = Object.keys(usageSnippets).filter(componentId => !valid.definitions[componentId])
  if (unknownUsage.length) invalid('Component docs usage references a missing definition')
  const components = Object.values(valid.definitions)
    .map(definition => componentDocsManifest(definition, usageSnippets[definition.id]))
    .sort((left, right) => left.name.localeCompare(right.name) || left.componentId.localeCompare(right.componentId))
  unique(components.map(component => component.slug), 'component docs slug')
  return {
    version: 1,
    navigation: components.map(component => ({ title: component.name, href: component.route, componentId: component.componentId })),
    components,
  }
}
