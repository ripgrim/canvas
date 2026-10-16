import { resolveComponentInstanceValues } from '@canvas/repo-engine/component-model'
import type { ComponentDefinition, ComponentInstanceRecord, ComponentPropertyDefinition } from '@canvas/repo-engine/component-model'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import { childrenOf, nodeAppearance } from '@canvas/repo-engine/file-document'
import { mapParallelComponentSubtrees } from './component-canvas-link'

export function componentConfigurableDefinition(definition: ComponentDefinition): ComponentDefinition {
  if (definition.source.kind === 'code') return definition
  const properties = definition.properties.filter(property => Boolean(property.binding))
  if (properties.length === definition.properties.length) return definition
  const propertyIds = new Set(properties.map(property => property.id))
  return { ...definition, properties, interactions: definition.interactions.filter(interaction => propertyIds.has(interaction.propertyId)) }
}

/** Adopts an existing verified code node without inventing values the component model cannot represent. */
export function codeComponentInstanceValues(file: FileDocument, definition: ComponentDefinition, nodeId: string): ComponentInstanceRecord['values'] | null {
  if (definition.source.kind !== 'code') return null
  const node = file.nodes[nodeId]
  if (node?.type !== 'component' || node.componentId !== definition.id) return null
  const values: Record<string, string | boolean> = {}
  for (const property of definition.properties) {
    if (property.type === 'slot') continue
    const value = node.props[property.name]
    if (property.type === 'text' && typeof value === 'string' && (property.optional || value !== property.defaultValue)) values[property.id] = value
    if (property.type === 'boolean' && typeof value === 'boolean' && (property.optional || value !== property.defaultValue)) values[property.id] = value
    if (property.type === 'variant' && typeof value === 'string') {
      const option = property.values.find(candidate => candidate.name === value)
      if (option && (property.optional || option.id !== property.defaultValueId)) values[property.id] = option.id
    }
  }
  return values
}

export function componentSlotRebindingCommands(file: FileDocument, definition: ComponentDefinition, property: ComponentPropertyDefinition): FileCommand[] {
  if (definition.source.kind !== 'canvas' || property.type !== 'slot' || !property.binding) return []
  const previous = definition.properties.find(candidate => candidate.id === property.id)
  if (previous?.type !== 'slot' || !previous.binding || previous.binding.nodeId === property.binding.nodeId) return []
  const commands: FileCommand[] = []
  for (const instance of Object.values(file.componentModel.instances)) {
    if (instance.componentId !== definition.id) continue
    const map = mapParallelComponentSubtrees(file, definition.source.masterRootId, instance.id)
    const sourceId = map?.get(previous.binding.nodeId)
    const targetId = map?.get(property.binding.nodeId)
    if (!sourceId || !targetId) continue
    for (const [index, nodeId] of childrenOf(file, sourceId, property.id).entries()) commands.push({ type: 'node.reparent', nodeId, placement: { parentId: targetId, slot: property.id, index } })
  }
  return commands
}

export function componentPropertyRemovalResetCommands(file: FileDocument, definition: ComponentDefinition, property: ComponentPropertyDefinition): FileCommand[] {
  if (definition.source.kind !== 'canvas' || property.type === 'slot' || !property.binding) return []
  const masterNode = file.nodes[property.binding.nodeId]
  if (!masterNode || masterNode.type === 'root') return []
  const commands: FileCommand[] = []
  for (const instance of Object.values(file.componentModel.instances)) {
    if (instance.componentId !== definition.id) continue
    const nodeId = mapParallelComponentSubtrees(file, definition.source.masterRootId, instance.id)?.get(property.binding.nodeId)
    if (!nodeId) continue
    if (property.type === 'text' && masterNode.type === 'text') commands.push({ type: 'node.setText', nodeId, text: masterNode.text ?? '' })
    if (property.type === 'boolean') commands.push({ type: 'node.setBlending', nodeId, visible: nodeAppearance(masterNode)?.visible !== false })
    if (property.type === 'variant') commands.push({ type: 'node.setAppearance', nodeId, appearance: structuredClone(nodeAppearance(masterNode) ?? {}) })
  }
  return commands
}

export function componentPropertyRebindingResetCommands(file: FileDocument, definition: ComponentDefinition, property: ComponentPropertyDefinition): FileCommand[] {
  const previous = definition.properties.find(candidate => candidate.id === property.id)
  if (!previous?.binding || previous.type === 'slot' || previous.binding.nodeId === property.binding?.nodeId) return []
  return componentPropertyRemovalResetCommands(file, definition, previous)
}

export function componentPropertyProjectionCommands(file: FileDocument, definition: ComponentDefinition, instance: ComponentInstanceRecord, properties: readonly ComponentPropertyDefinition[] = definition.properties): FileCommand[] {
  if (definition.source.kind === 'code') {
    const node = file.nodes[instance.id]
    if (node?.type !== 'component' || node.componentId !== definition.id) return []
    const values = resolveComponentInstanceValues(definition, instance.values)
    const remove: string[] = []
    const props: Record<string, string | boolean> = Object.fromEntries(properties.flatMap(property => {
      if (property.type === 'slot') return []
      if (property.optional && !Object.hasOwn(instance.values, property.id)) { remove.push(property.name); return [] }
      if (property.type === 'variant') {
        const selected = property.values.find(value => value.id === values[property.id])
        return selected ? [[property.name, selected.name]] : []
      }
      const value = values[property.id]
      return typeof value === 'string' || typeof value === 'boolean' ? [[property.name, value]] : []
    }))
    return Object.keys(props).length || remove.length ? [{ type: 'node.setProps', nodeId: instance.id, props, ...(remove.length ? { remove } : {}) }] : []
  }
  const map = mapParallelComponentSubtrees(file, definition.source.masterRootId, instance.id)
  if (!map) return []
  const values = resolveComponentInstanceValues(definition, instance.values)
  return properties.flatMap((property): FileCommand[] => {
    if (property.type === 'variant' && property.binding) {
      const nodeId = map.get(property.binding.nodeId)
      const valueId = values[property.id]
      const appearance = typeof valueId === 'string' ? property.binding.appearances[valueId] : undefined
      return nodeId && appearance ? [{ type: 'node.setAppearance', nodeId, appearance: structuredClone(appearance) }] : []
    }
    if (property.type === 'text' && property.binding) {
      const nodeId = map.get(property.binding.nodeId)
      return nodeId ? [{ type: 'node.setText', nodeId, text: String(values[property.id]) }] : []
    }
    if (property.type === 'boolean' && property.binding) {
      const nodeId = map.get(property.binding.nodeId)
      return nodeId ? [{ type: 'node.setBlending', nodeId, visible: Boolean(values[property.id]) }] : []
    }
    return []
  })
}
