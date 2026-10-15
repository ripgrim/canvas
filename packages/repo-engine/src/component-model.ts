import type { Appearance } from './appearance.js'

export type ComponentSource =
  | Readonly<{ kind: 'canvas'; masterRootId: string }>
  | Readonly<{ kind: 'code'; bindingId: string }>

type ComponentPropertyBase = Readonly<{ id: string; name: string; description?: string }>
export type VariantProperty = ComponentPropertyBase & Readonly<{
  type: 'variant'
  defaultValueId: string
  values: readonly Readonly<{ id: string; name: string }>[]
}>
export type TextProperty = ComponentPropertyBase & Readonly<{ type: 'text'; defaultValue: string }>
export type BooleanProperty = ComponentPropertyBase & Readonly<{ type: 'boolean'; defaultValue: boolean }>
export type SlotProperty = ComponentPropertyBase & Readonly<{ type: 'slot' }>
export type ComponentPropertyDefinition = VariantProperty | TextProperty | BooleanProperty | SlotProperty

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

export type ComponentDocsManifest = Readonly<{
  componentId: string
  name: string
  slug: string
  description?: string
  source: ComponentSource['kind']
  controls: readonly Readonly<{
    id: string
    name: string
    type: ComponentPropertyDefinition['type']
    options?: readonly Readonly<{ id: string; name: string }>[]
  }>[]
  combinations: readonly ComponentInstanceValues[]
}>

const idPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const own = (value: object, key: string) => Object.hasOwn(value, key)
const invalid = (message: string): never => { throw new Error(message) }
const validId = (value: string, label: string) => { if (!idPattern.test(value)) invalid(`Invalid ${label}`) }
const validName = (value: string, label: string) => { if (!value.trim() || value.length > 128) invalid(`Invalid ${label}`) }
const unique = (values: readonly string[], label: string) => { if (new Set(values).size !== values.length) invalid(`Duplicate ${label}`) }

function validateProperty(property: ComponentPropertyDefinition): void {
  validId(property.id, 'component property id')
  validName(property.name, 'component property name')
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

export function validateComponentDefinition(input: ComponentDefinition): ComponentDefinition {
  validId(input.id, 'component id')
  validName(input.name, 'component name')
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) invalid('Invalid component revision')
  if (input.source.kind === 'canvas') validId(input.source.masterRootId, 'component master root id')
  else validId(input.source.bindingId, 'component source binding id')
  unique(input.properties.map(property => property.id), 'component property id')
  unique(input.properties.map(property => property.name.toLocaleLowerCase()), 'component property name')
  input.properties.forEach(validateProperty)
  unique(input.materials.map(material => material.id), 'component material id')
  unique(input.materials.map(material => `${material.group.toLocaleLowerCase()}\u0000${material.name.toLocaleLowerCase()}`), 'component material name')
  for (const material of input.materials) {
    validId(material.id, 'component material id')
    validName(material.group, 'component material group')
    validName(material.name, 'component material name')
  }
  const materialIds = new Set(input.materials.map(material => material.id))
  unique(input.parts.map(part => part.id), 'component part id')
  unique(input.parts.map(part => part.nodeId), 'component part node')
  for (const part of input.parts) {
    validId(part.id, 'component part id')
    validId(part.nodeId, 'component part node id')
    validName(part.name, 'component part name')
    if (part.materialId !== undefined && !materialIds.has(part.materialId)) invalid('Component part references a missing material')
  }
  unique(input.interactions.map(interaction => interaction.id), 'component interaction id')
  const properties = new Map(input.properties.map(property => [property.id, property]))
  for (const interaction of input.interactions) {
    validId(interaction.id, 'component interaction id')
    const property = properties.get(interaction.propertyId)
    if (property?.type !== 'variant' || !property.values.some(value => value.id === interaction.valueId)) invalid('Component interaction references a missing variant value')
    if (interaction.transition?.durationMs !== undefined && (!Number.isFinite(interaction.transition.durationMs) || interaction.transition.durationMs < 0 || interaction.transition.durationMs > 60_000)) invalid('Invalid component transition duration')
  }
  if (input.docs && !slugPattern.test(input.docs.slug)) invalid('Invalid component docs slug')
  return structuredClone(input)
}

export function componentDefaultValues(definition: ComponentDefinition): ComponentInstanceValues {
  const values: Record<string, ComponentScalarValue> = {}
  for (const property of definition.properties) {
    if (property.type === 'variant') values[property.id] = property.defaultValueId
    if (property.type === 'text') values[property.id] = property.defaultValue
    if (property.type === 'boolean') values[property.id] = property.defaultValue
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

export function componentDocsManifest(definition: ComponentDefinition): ComponentDocsManifest {
  const valid = validateComponentDefinition(definition)
  const controls = valid.properties.map(property => ({
    id: property.id,
    name: property.name,
    type: property.type,
    ...(property.type === 'variant' ? { options: property.values.map(value => ({ ...value })) } : {}),
  }))
  return {
    componentId: valid.id,
    name: valid.name,
    slug: valid.docs?.slug ?? valid.name.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    ...(valid.docs?.description ? { description: valid.docs.description } : {}),
    source: valid.source.kind,
    controls,
    combinations: componentVariantCombinations(valid),
  }
}
