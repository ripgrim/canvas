import type { ComponentDefinition, ComponentInstanceRecord, InstanceSwapProperty } from '@canvas/repo-engine/component-model'
import { applyFileCommand, descendantsOf } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import { mapParallelComponentSubtrees } from './component-canvas-link'
import { componentPropertyProjectionCommands } from './component-property-projection'
import { eligibleSlotDraftComponents } from './component-configured-instance'
import type { Atom } from './types'

export type ComponentInstanceSwapPlan = Readonly<{
  commands: readonly FileCommand[]
  file: FileDocument
  rootId: string
}>

function newIdsFor(file: FileDocument, nodeId: string, rootId: string, makeId: () => string): Record<string, string> {
  return Object.fromEntries([nodeId, ...descendantsOf(file, nodeId)].map(id => [id, id === nodeId ? rootId : makeId()]))
}

function duplicatedInstanceCommands(file: FileDocument, ids: Readonly<Record<string, string>>): FileCommand[] {
  return Object.entries(ids).flatMap(([sourceId, id]) => {
    const instance = file.componentModel.instances[sourceId]
    return instance ? [{ type: 'component.instance.create' as const, instance: { ...structuredClone(instance), id } }] : []
  })
}

function deletedInstanceCommands(file: FileDocument, rootId: string): FileCommand[] {
  const ids = new Set([rootId, ...descendantsOf(file, rootId)])
  return Object.values(file.componentModel.instances)
    .filter(instance => ids.has(instance.id))
    .map(instance => ({ type: 'component.instance.delete' as const, instanceId: instance.id, expected: structuredClone(instance) }))
}

function rootLayout(source: NodeLayout | undefined, pose: NodeLayout | undefined): NodeLayout | null {
  if (!source && !pose) return null
  if (!source) return pose ? { item: { position: structuredClone(pose.item.position) } } : null
  const position = pose?.item.position ?? source.item.position
  const item: NodeLayout['item'] = { ...source.item, position: structuredClone(position) }
  return { ...structuredClone(source), ...(Object.keys(item).length ? { item } : {}) }
}

function swapRoot(file: FileDocument, owner: ComponentDefinition, ownerRootId: string, property: InstanceSwapProperty): string | null {
  if (owner.source.kind !== 'canvas') return null
  if (ownerRootId === owner.source.masterRootId) return property.binding.nodeId
  return mapParallelComponentSubtrees(file, owner.source.masterRootId, ownerRootId, { includeOverriddenSwapRoots: true })?.get(property.binding.nodeId) ?? null
}

export function eligibleInstanceSwapComponents(file: FileDocument, owner: ComponentDefinition): ComponentDefinition[] {
  return eligibleSlotDraftComponents(file, owner)
}

export function planComponentInstanceSwap(input: Readonly<{
  file: FileDocument
  owner: ComponentDefinition
  ownerRootId: string
  propertyId: string
  componentId: string
  atoms: readonly Atom[]
  makeId: () => string
  transientMaster?: boolean
}>): ComponentInstanceSwapPlan | null {
  if (input.owner.source.kind !== 'canvas') return null
  const property = input.owner.properties.find((candidate): candidate is InstanceSwapProperty => candidate.id === input.propertyId && candidate.type === 'instance-swap')
  const candidate = input.file.componentModel.definitions[input.componentId]
  if (!property || !candidate || candidate.source.kind !== 'canvas') return null
  if (!eligibleInstanceSwapComponents(input.file, input.owner).some(definition => definition.id === candidate.id)) return null
  const rootId = swapRoot(input.file, input.owner, input.ownerRootId, property)
  const currentNode = rootId ? input.file.nodes[rootId] : undefined
  const relationship = rootId ? input.file.relationships[rootId] : undefined
  const currentInstance = rootId ? input.file.componentModel.instances[rootId] : undefined
  const candidateMaster = input.file.nodes[candidate.source.masterRootId]
  if (!rootId || !currentNode || currentNode.type === 'root' || !relationship || !currentInstance || !candidateMaster || candidateMaster.type === 'root') return null

  const ownerInstance = input.ownerRootId === input.owner.source.masterRootId ? null : input.file.componentModel.instances[input.ownerRootId]
  if (ownerInstance && ownerInstance.componentId !== input.owner.id) return null
  if (!ownerInstance && input.ownerRootId !== input.owner.source.masterRootId) return null
  if (input.transientMaster !== true && !ownerInstance) return null
  if (input.transientMaster === true && input.ownerRootId !== input.owner.source.masterRootId) return null

  const resolvedCurrent = ownerInstance?.values[property.id] ?? property.defaultValue
  if (currentInstance.componentId !== resolvedCurrent) return null
  if (currentInstance.componentId === candidate.id) return { commands: [], file: input.file, rootId }

  const ids = newIdsFor(input.file, candidateMaster.id, rootId, input.makeId)
  const commands: FileCommand[] = [
    ...deletedInstanceCommands(input.file, rootId),
    { type: 'node.delete', nodeIds: [rootId] },
    { type: 'node.duplicate', nodeId: candidateMaster.id, ids },
    ...duplicatedInstanceCommands(input.file, ids),
    { type: 'component.instance.create', instance: { id: rootId, componentId: candidate.id, values: {} } },
    { type: 'node.reparent', nodeId: rootId, placement: structuredClone(relationship) },
  ]
  if (currentNode.type !== 'component' && candidateMaster.type !== 'component') commands.push({ type: 'node.setStyles', nodeId: rootId, styles: { relativeTransform: structuredClone((currentNode as PrimitiveNode).styles.relativeTransform) } })
  const nextLayout = rootLayout(candidateMaster.layout, currentNode.layout)
  commands.push({ type: 'node.setLayout', nodeId: rootId, layout: nextLayout })

  if (ownerInstance) {
    const values = { ...ownerInstance.values }
    if (candidate.id === property.defaultValue) delete values[property.id]
    else values[property.id] = candidate.id
    const replacement: ComponentInstanceRecord = { ...ownerInstance, values }
    commands.push({ type: 'component.instance.replace', instanceId: ownerInstance.id, expected: ownerInstance, instance: replacement })
  } else {
    const properties = input.owner.properties.map(existing => existing.id === property.id ? { ...property, defaultValue: candidate.id } : existing)
    commands.push({ type: 'component.replace', componentId: input.owner.id, expectedRevision: input.owner.revision, definition: { ...input.owner, revision: input.owner.revision + 1, properties } })
  }

  try {
    const base = applyFileCommand(input.file, { type: 'batch', commands }, [...input.atoms], { allowUnavailableBindings: true })
    const nested = base.componentModel.instances[rootId]
    if (!nested) return null
    const projections = componentPropertyProjectionCommands(base, candidate, nested)
    const all = [...commands, ...projections]
    const file = projections.length ? applyFileCommand(input.file, { type: 'batch', commands: all }, [...input.atoms], { allowUnavailableBindings: true }) : base
    return { commands: all, file, rootId }
  } catch {
    return null
  }
}
