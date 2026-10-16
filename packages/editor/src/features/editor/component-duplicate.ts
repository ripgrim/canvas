import { applyFileCommand, descendantsOf } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import { componentDocsSlug } from '@canvas/repo-engine/component-model'
import type { ComponentDefinition, ComponentInstanceRecord, ComponentPropertyDefinition } from '@canvas/repo-engine/component-model'
import type { Atom } from './types'

const limits = { definitions: 500, instances: 5_000, commands: 1_000 } as const

export type ComponentDuplicatePlan = Readonly<{
  baseFileId: string
  baseRevision: number
  baseGraph: string
  sourceRootId: string
  rootId: string
  ids: Readonly<Record<string, string>>
  commands: readonly FileCommand[]
  file: FileDocument
}>

export type ComponentDuplicateInput = Readonly<{
  file: FileDocument
  nodeId: string
  atoms: readonly Atom[]
  makeId: () => string
  offset?: Readonly<{ x: number; y: number }>
}>

const graphSnapshot = (file: FileDocument) => JSON.stringify({
  fileId: file.fileId,
  revision: file.revision,
  nodes: file.nodes,
  relationships: file.relationships,
  componentModel: file.componentModel,
})

const uniqueName = (used: Set<string>, base: string): string => {
  if (!used.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (used.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${base} ${suffix}`
}

const uniqueSlug = (used: Set<string>, name: string, fallback: string): string => {
  const base = componentDocsSlug(name, fallback)
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function semanticIds(file: FileDocument): Set<string> {
  const ids = new Set([...Object.keys(file.nodes), ...Object.keys(file.componentModel.definitions), ...Object.keys(file.componentModel.instances)])
  for (const definition of Object.values(file.componentModel.definitions)) {
    for (const property of definition.properties) {
      ids.add(property.id)
      if (property.type === 'variant') for (const value of property.values) ids.add(value.id)
    }
    for (const material of definition.materials) ids.add(material.id)
    for (const part of definition.parts) ids.add(part.id)
    for (const interaction of definition.interactions) ids.add(interaction.id)
  }
  return ids
}

function remapTupleKey(key: string, propertyIds: ReadonlyMap<string, string>, valueIds: ReadonlyMap<string, string>): string | null {
  const entries = key === '' ? [] : key.split('|')
  const mapped: string[] = []
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator < 1) return null
    const propertyId = propertyIds.get(entry.slice(0, separator))
    const valueId = valueIds.get(entry.slice(separator + 1))
    if (!propertyId || !valueId) return null
    mapped.push(`${propertyId}=${valueId}`)
  }
  return mapped.join('|')
}

type DefinitionRemap = Readonly<{
  definitionId: string
  propertyIds: ReadonlyMap<string, string>
  valueIds: ReadonlyMap<string, string>
  materialIds: ReadonlyMap<string, string>
  partIds: ReadonlyMap<string, string>
  interactionIds: ReadonlyMap<string, string>
}>

function cloneProperty(
  property: ComponentPropertyDefinition,
  remap: DefinitionRemap,
  nodeIds: Readonly<Record<string, string>>,
  definitionIds: ReadonlyMap<string, string>,
): ComponentPropertyDefinition | null {
  const id = remap.propertyIds.get(property.id)
  if (!id) return null
  const boundNodeId = property.binding ? nodeIds[property.binding.nodeId] : undefined
  if (property.binding && !boundNodeId) return null
  if (property.type === 'variant') {
    const values = property.values.map(value => ({ ...value, id: remap.valueIds.get(value.id)! }))
    if (values.some(value => !value.id)) return null
    const defaultValueId = remap.valueIds.get(property.defaultValueId)
    const currentValueId = property.currentValueId === undefined ? undefined : remap.valueIds.get(property.currentValueId)
    if (!defaultValueId || property.currentValueId !== undefined && !currentValueId) return null
    const variantBinding = property.binding && boundNodeId
      ? { ...structuredClone(property.binding), nodeId: boundNodeId, appearances: Object.fromEntries(Object.entries(property.binding.appearances).map(([valueId, appearance]) => [remap.valueIds.get(valueId), structuredClone(appearance)])) }
      : undefined
    if (variantBinding && Object.keys(variantBinding.appearances).some(valueId => valueId === 'undefined')) return null
    return { ...structuredClone(property), id, values, defaultValueId, ...(currentValueId ? { currentValueId } : {}), ...(variantBinding ? { binding: variantBinding } : {}) }
  }
  if (property.type === 'instance-swap') {
    if (!boundNodeId) return null
    return { ...structuredClone(property), id, defaultValue: definitionIds.get(property.defaultValue) ?? property.defaultValue, binding: { kind: 'instance-swap', nodeId: boundNodeId } }
  }
  const nextBinding = property.binding && boundNodeId ? { ...structuredClone(property.binding), nodeId: boundNodeId } : undefined
  return { ...structuredClone(property), id, ...(nextBinding ? { binding: nextBinding } : {}) } as ComponentPropertyDefinition
}

function cloneDefinition(
  source: ComponentDefinition,
  remap: DefinitionRemap,
  nodeIds: Readonly<Record<string, string>>,
  definitionIds: ReadonlyMap<string, string>,
  name: string,
  slug: string,
): ComponentDefinition | null {
  if (source.source.kind !== 'canvas') return null
  const masterRootId = nodeIds[source.source.masterRootId]
  if (!masterRootId) return null
  const properties = source.properties.map(property => cloneProperty(property, remap, nodeIds, definitionIds))
  if (properties.some(property => property === null)) return null
  const materials = source.materials.map(material => ({ ...structuredClone(material), id: remap.materialIds.get(material.id)! }))
  const parts = source.parts.map(part => ({
    ...structuredClone(part),
    id: remap.partIds.get(part.id)!,
    nodeId: nodeIds[part.nodeId]!,
    ...(part.materialId ? { materialId: remap.materialIds.get(part.materialId)! } : {}),
  }))
  if (materials.some(material => !material.id) || parts.some(part => !part.id || !part.nodeId || part.materialId === undefined && source.parts.find(sourcePart => sourcePart.id === part.id)?.materialId)) return null
  const interactions = source.interactions.map(interaction => ({
    ...structuredClone(interaction),
    id: remap.interactionIds.get(interaction.id)!,
    propertyId: remap.propertyIds.get(interaction.propertyId)!,
    valueId: remap.valueIds.get(interaction.valueId)!,
  }))
  if (interactions.some(interaction => !interaction.id || !interaction.propertyId || !interaction.valueId)) return null
  const variantAppearances = source.variantAppearances
    ? Object.fromEntries(Object.entries(source.variantAppearances).map(([nodeId, table]) => {
      const targetId = nodeIds[nodeId]
      if (!targetId) return [nodeId, null]
      const cells = Object.entries(table).map(([key, appearance]) => [remapTupleKey(key, remap.propertyIds, remap.valueIds), structuredClone(appearance)] as const)
      if (cells.some(([key]) => key === null)) return [targetId, null]
      return [targetId, Object.fromEntries(cells)]
    }))
    : undefined
  if (variantAppearances && Object.values(variantAppearances).some(table => table === null)) return null
  return {
    ...structuredClone(source),
    id: remap.definitionId,
    name,
    source: { kind: 'canvas', masterRootId },
    revision: 0,
    properties: properties as ComponentPropertyDefinition[],
    materials,
    parts,
    interactions,
    ...(variantAppearances ? { variantAppearances: variantAppearances as NonNullable<ComponentDefinition['variantAppearances']> } : {}),
    docs: source.docs ? { ...structuredClone(source.docs), slug } : { slug },
  }
}

function cloneInstance(
  source: ComponentInstanceRecord,
  nodeIds: Readonly<Record<string, string>>,
  definitionIds: ReadonlyMap<string, string>,
  remaps: ReadonlyMap<string, DefinitionRemap>,
  file: FileDocument,
): ComponentInstanceRecord | null {
  const id = nodeIds[source.id]
  if (!id) return null
  const componentId = definitionIds.get(source.componentId) ?? source.componentId
  const ownerRemap = remaps.get(source.componentId)
  if (!ownerRemap) return { ...structuredClone(source), id, componentId }
  const sourceDefinition = file.componentModel.definitions[source.componentId]
  if (!sourceDefinition) return null
  const propertyById = new Map(sourceDefinition.properties.map(property => [property.id, property]))
  const values: Record<string, string | boolean> = {}
  for (const [propertyId, value] of Object.entries(source.values)) {
    const nextPropertyId = ownerRemap.propertyIds.get(propertyId)
    const property = propertyById.get(propertyId)
    if (!nextPropertyId || !property) return null
    values[nextPropertyId] = property.type === 'variant' && typeof value === 'string'
      ? ownerRemap.valueIds.get(value) ?? value
      : property.type === 'instance-swap' && typeof value === 'string'
        ? definitionIds.get(value) ?? value
        : value
  }
  return { id, componentId, values }
}

function topologicalDefinitions(definitions: readonly ComponentDefinition[], definitionIds: ReadonlyMap<string, string>, instances: readonly ComponentInstanceRecord[], file: FileDocument): ComponentDefinition[] | null {
  const byId = new Map(definitions.map(definition => [definition.id, definition]))
  const ordered: ComponentDefinition[] = []
  const visited = new Set<string>()
  const active = new Set<string>()
  const visit = (definition: ComponentDefinition): boolean => {
    if (active.has(definition.id)) return false
    if (visited.has(definition.id)) return true
    active.add(definition.id)
    const dependencies = new Set(definition.properties.flatMap(property => property.type === 'instance-swap' ? [property.defaultValue] : []))
    if (definition.source.kind === 'canvas') {
      const subtree = new Set([definition.source.masterRootId, ...descendantsOf(file, definition.source.masterRootId)])
      for (const instance of instances) if (subtree.has(instance.id)) dependencies.add(instance.componentId)
    }
    for (const dependency of dependencies) {
      if (!definitionIds.has(dependency)) continue
      const target = byId.get(dependency)
      if (!target || !visit(target)) return false
    }
    active.delete(definition.id)
    visited.add(definition.id)
    ordered.push(definition)
    return true
  }
  return definitions.every(visit) ? ordered : null
}

/** Plans one closed physical and semantic clone. */
export function planComponentDuplicate(input: ComponentDuplicateInput): ComponentDuplicatePlan | null {
  const { file, nodeId, atoms, makeId, offset } = input
  const sourceNode = file.nodes[nodeId]
  if (!sourceNode || sourceNode.type === 'root') return null
  try {
    const sourceIds = [nodeId, ...descendantsOf(file, nodeId)]
    const sourceSet = new Set(sourceIds)
    if (sourceIds.some(id => !file.nodes[id] || !file.relationships[id])) return null
    const reserved = semanticIds(file)
    const fresh = (): string | null => {
      const id = makeId()
      if (!id || reserved.has(id)) return null
      reserved.add(id)
      return id
    }
    const ids: Record<string, string> = {}
    for (const id of sourceIds) {
      const next = fresh()
      if (!next) return null
      ids[id] = next
    }

    const sourceDefinitions = Object.values(file.componentModel.definitions).filter(definition => definition.source.kind === 'canvas' && sourceSet.has(definition.source.masterRootId))
    if (file.componentModel.definitions && Object.keys(file.componentModel.definitions).length + sourceDefinitions.length > limits.definitions) return null
    const definitionIds = new Map<string, string>()
    const remaps = new Map<string, DefinitionRemap>()
    for (const definition of sourceDefinitions) {
      const definitionId = fresh()
      if (!definitionId) return null
      definitionIds.set(definition.id, definitionId)
      const propertyIds = new Map<string, string>()
      const valueIds = new Map<string, string>()
      const materialIds = new Map<string, string>()
      const partIds = new Map<string, string>()
      const interactionIds = new Map<string, string>()
      for (const property of definition.properties) {
        const propertyId = fresh()
        if (!propertyId) return null
        propertyIds.set(property.id, propertyId)
        if (property.type === 'variant') for (const value of property.values) {
          const valueId = fresh()
          if (!valueId) return null
          valueIds.set(value.id, valueId)
        }
      }
      for (const material of definition.materials) { const id = fresh(); if (!id) return null; materialIds.set(material.id, id) }
      for (const part of definition.parts) { const id = fresh(); if (!id) return null; partIds.set(part.id, id) }
      for (const interaction of definition.interactions) { const id = fresh(); if (!id) return null; interactionIds.set(interaction.id, id) }
      remaps.set(definition.id, { definitionId, propertyIds, valueIds, materialIds, partIds, interactionIds })
    }

    const sourceInstances = Object.values(file.componentModel.instances).filter(instance => sourceSet.has(instance.id))
    if (Object.keys(file.componentModel.instances).length + sourceInstances.length > limits.instances) return null
    const orderedDefinitions = topologicalDefinitions(sourceDefinitions, definitionIds, sourceInstances, file)
    if (!orderedDefinitions) return null
    const usedNames = new Set(Object.values(file.componentModel.definitions).map(definition => definition.name.toLocaleLowerCase()))
    const usedSlugs = new Set(Object.values(file.componentModel.definitions).map(definition => definition.docs?.slug ?? componentDocsSlug(definition.name, definition.id)))
    const clonedDefinitions: ComponentDefinition[] = []
    const renameCommands: FileCommand[] = []
    for (const source of orderedDefinitions) {
      const remap = remaps.get(source.id)!
      const name = uniqueName(usedNames, `${source.name} copy`)
      usedNames.add(name.toLocaleLowerCase())
      const slug = uniqueSlug(usedSlugs, name, remap.definitionId)
      usedSlugs.add(slug)
      const definition = cloneDefinition(source, remap, ids, definitionIds, name, slug)
      if (!definition) return null
      clonedDefinitions.push(definition)
      renameCommands.push({ type: 'node.rename', nodeId: definition.source.kind === 'canvas' ? definition.source.masterRootId : '', name })
    }
    const clonedInstances = sourceInstances.map(instance => cloneInstance(instance, ids, definitionIds, remaps, file))
    if (clonedInstances.some(instance => instance === null)) return null
    const commands: FileCommand[] = [
      { type: 'node.duplicate', nodeId, ids, ...(offset ? { offset: { ...offset } } : {}) },
      ...renameCommands,
      ...clonedDefinitions.map(definition => ({ type: 'component.create' as const, definition })),
      ...(clonedInstances as ComponentInstanceRecord[]).map(instance => ({ type: 'component.instance.create' as const, instance })),
    ]
    if (commands.length > limits.commands) return null
    const command: FileCommand = commands.length === 1 ? commands[0]! : { type: 'batch', commands }
    const projected = applyFileCommand(file, command, [...atoms], { allowUnavailableBindings: true })
    return Object.freeze({
      baseFileId: file.fileId,
      baseRevision: file.revision,
      baseGraph: graphSnapshot(file),
      sourceRootId: nodeId,
      rootId: ids[nodeId]!,
      ids: Object.freeze({ ...ids }),
      commands: Object.freeze(commands.map(item => Object.freeze(item))),
      file: projected,
    })
  } catch {
    return null
  }
}

/** Requires the exact inspected graph. */
export function componentDuplicatePlanCurrent(file: FileDocument, plan: ComponentDuplicatePlan): boolean {
  return file.fileId === plan.baseFileId && file.revision === plan.baseRevision && graphSnapshot(file) === plan.baseGraph
}
