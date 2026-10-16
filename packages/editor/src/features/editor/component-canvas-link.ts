import { ancestorsOf, applyFileCommand, childrenOf, descendantsOf, nodeAppearance } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import type { Atom } from './types'

type LinkedNodeMap = ReadonlyMap<string, string>
type LinkedCanvasInstance = Readonly<{ masterRootId: string; instanceRootId: string; map: LinkedNodeMap }>

export type CanvasComponentNode = Readonly<{
  definition: ComponentDefinition
  role: 'master' | 'instance'
}>

/** Resolves the semantic component identity carried by a physical canvas node. */
export function canvasComponentNode(file: FileDocument, nodeId: string): CanvasComponentNode | null {
  const instance = file.componentModel.instances[nodeId]
  if (instance) {
    const definition = file.componentModel.definitions[instance.componentId]
    return definition ? { definition, role: 'instance' } : null
  }
  const definition = Object.values(file.componentModel.definitions).find(candidate => candidate.source.kind === 'canvas' && candidate.source.masterRootId === nodeId)
  return definition ? { definition, role: 'master' } : null
}

/** Refuses a component whose identity already appears in the owning instance chain. */
export function canNestComponentInstance(file: FileDocument, hostInstanceId: string, componentId: string): boolean {
  return [hostInstanceId, ...ancestorsOf(file, hostInstanceId)].every(nodeId => file.componentModel.instances[nodeId]?.componentId !== componentId)
}

const nodeCommandTypes = new Set<FileCommand['type']>([
  'node.rename',
  'node.setLocked',
  'node.setStyles',
  'node.setText',
  'node.setTextProperties',
  'node.setAppearance',
  'node.setBlending',
  'node.fill.add',
  'node.fill.update',
  'node.fill.move',
  'node.fill.remove',
  'node.fill.replace',
  'node.outline.set',
  'node.borders.set',
  'node.border.update',
  'node.border.remove',
  'node.setLayout',
  'node.setThemeMode',
])
const appearanceCommandTypes = new Set<FileCommand['type']>([
  'node.setAppearance', 'node.setBlending', 'node.fill.add', 'node.fill.update', 'node.fill.move', 'node.fill.remove', 'node.fill.replace', 'node.outline.set', 'node.borders.set', 'node.border.update', 'node.border.remove',
])
const snapshotSafeBatchCommandTypes = new Set<FileCommand['type']>([
  'node.rename',
  'node.setLocked',
  'node.setStyles',
  'node.setTextProperties',
  'node.setLayout',
  'node.setThemeMode',
  'node.reorder',
])

export function mapParallelComponentSubtrees(file: FileDocument, masterRootId: string, instanceRootId: string): LinkedNodeMap | null {
  const map = new Map<string, string>()
  const visit = (masterId: string, instanceId: string): boolean => {
    const master = file.nodes[masterId]
    const instance = file.nodes[instanceId]
    if (!master || !instance || master.type !== instance.type) return false
    map.set(masterId, instanceId)
    const masterChildren = childrenOf(file, masterId).filter(nodeId => file.relationships[nodeId]?.slot === undefined)
    const instanceChildren = childrenOf(file, instanceId).filter(nodeId => file.relationships[nodeId]?.slot === undefined)
    if (masterChildren.length !== instanceChildren.length) return false
    for (let index = 0; index < masterChildren.length; index += 1) {
      const masterChild = masterChildren[index]!
      const instanceChild = instanceChildren[index]!
      if (file.relationships[masterChild]?.slot !== file.relationships[instanceChild]?.slot || !visit(masterChild, instanceChild)) return false
    }
    return true
  }
  return visit(masterRootId, instanceRootId) ? map : null
}

function linkedRootLayout(layout: NodeLayout | null, instanceLayout: NodeLayout | undefined): NodeLayout | null {
  const instancePosition = instanceLayout?.item.position
  if (layout === null) return instancePosition ? { item: { position: structuredClone(instancePosition) } } : null
  const { position: _masterPosition, ...masterItem } = layout.item ?? {}
  const item: NodeLayout['item'] = { ...masterItem, position: structuredClone(instancePosition ?? layout.item.position) }
  return { ...structuredClone(layout), ...(Object.keys(item).length ? { item } : {}) }
}

function mirrorNodeCommand(command: FileCommand, nodeId: string, instanceId: string, masterRootId: string, file: FileDocument): FileCommand | null {
  if (!nodeCommandTypes.has(command.type) || !('nodeId' in command) || command.nodeId !== nodeId) return null
  if (command.type === 'node.setStyles' && nodeId === masterRootId) {
    const { relativeTransform: _relativeTransform, ...styles } = command.styles
    return Object.keys(styles).length ? { ...command, nodeId: instanceId, styles } : null
  }
  if (command.type === 'node.setLayout' && nodeId === masterRootId) {
    const instance = file.nodes[instanceId]
    if (!instance || instance.type === 'root') return null
    return { ...command, nodeId: instanceId, layout: linkedRootLayout(command.layout, instance.layout) }
  }
  return { ...command, nodeId: instanceId }
}

function linkedInstances(file: FileDocument): LinkedCanvasInstance[] {
  const links: LinkedCanvasInstance[] = []
  for (const definition of Object.values(file.componentModel.definitions)) {
    if (definition.source.kind !== 'canvas') continue
    for (const instance of Object.values(file.componentModel.instances)) {
      if (instance.componentId !== definition.id) continue
      const map = mapParallelComponentSubtrees(file, definition.source.masterRootId, instance.id)
      if (map) links.push({ masterRootId: definition.source.masterRootId, instanceRootId: instance.id, map })
    }
  }
  return links
}

function structuralMirrors(file: FileDocument, command: FileCommand, link: LinkedCanvasInstance, makeId: () => string): FileCommand[] {
  const { masterRootId, map } = link
  if (command.type === 'node.insert') {
    const parentId = map.get(command.placement.parentId)
    if (!parentId) return []
    const id = makeId()
    return [{ type: 'node.insert', node: { ...structuredClone(command.node), id }, placement: { ...command.placement, parentId } }]
  }
  if (command.type === 'node.delete') {
    const nodeIds = command.nodeIds.flatMap(nodeId => nodeId === masterRootId ? [] : map.get(nodeId) ?? [])
    return nodeIds.length ? [{ type: 'node.delete', nodeIds }] : []
  }
  if (command.type === 'node.duplicate') {
    if (command.nodeId === masterRootId) return []
    const nodeId = map.get(command.nodeId)
    if (!nodeId) return []
    const ids = Object.fromEntries(Object.keys(command.ids).map(masterId => [map.get(masterId), makeId()]).filter((entry): entry is [string, string] => typeof entry[0] === 'string'))
    return Object.keys(ids).length ? [{ type: 'node.duplicate', nodeId, ids, ...(command.offset ? { offset: command.offset } : {}) }] : []
  }
  if (command.type === 'node.reorder') {
    if (command.nodeId === masterRootId) return []
    const nodeId = map.get(command.nodeId)
    return nodeId ? [{ ...command, nodeId }] : []
  }
  if (command.type !== 'node.reparent' || command.nodeId === masterRootId) return []
  const nodeId = map.get(command.nodeId)
  const parentId = map.get(command.placement.parentId)
  if (nodeId && parentId) return [{ ...command, nodeId, placement: { ...command.placement, parentId } }]
  if (nodeId && !parentId) {
    const removedIds = [nodeId, ...descendantsOf(file, nodeId)]
    const instances: FileCommand[] = removedIds.flatMap(id => {
      const instance = file.componentModel.instances[id]
      return instance ? [{ type: 'component.instance.delete', instanceId: id, expected: instance }] : []
    })
    return [...instances, { type: 'node.delete', nodeIds: [nodeId] }]
  }
  if (!nodeId && parentId) {
    const sourceIds = [command.nodeId, ...descendantsOf(file, command.nodeId)]
    const ids = Object.fromEntries(sourceIds.map(sourceId => [sourceId, makeId()]))
    const copyId = ids[command.nodeId]!
    const instances: FileCommand[] = sourceIds.flatMap(sourceId => {
      const instance = file.componentModel.instances[sourceId]
      const id = ids[sourceId]
      return instance && id ? [{ type: 'component.instance.create', instance: { ...structuredClone(instance), id } }] : []
    })
    return [
      { type: 'node.duplicate', nodeId: command.nodeId, ids },
      { type: 'node.reparent', nodeId: copyId, placement: { ...command.placement, parentId } },
      ...instances,
    ]
  }
  return []
}

function semanticMirrors(file: FileDocument, command: FileCommand, links: readonly LinkedCanvasInstance[]): FileCommand[] {
  if (command.type !== 'component.instance.create' && command.type !== 'component.instance.replace') return []
  const sourceId = command.type === 'component.instance.create' ? command.instance.id : command.instanceId
  const commands: FileCommand[] = []
  const mirroredIds = new Set<string>()
  for (const link of links) {
    const instanceId = link.map.get(sourceId)
    if (!instanceId || mirroredIds.has(instanceId)) continue
    mirroredIds.add(instanceId)
    const current = file.componentModel.instances[instanceId]
    if (command.type === 'component.instance.create') {
      if (!current) commands.push({ type: 'component.instance.create', instance: { ...structuredClone(command.instance), id: instanceId } })
      continue
    }
    if (current) commands.push({ type: 'component.instance.replace', instanceId, expected: current, instance: { ...structuredClone(command.instance), id: instanceId } })
  }
  return commands
}

function boundDefaultCommands(file: FileDocument, command: FileCommand, atoms: Atom[]): FileCommand[] {
  const targetId = 'nodeId' in command ? command.nodeId : null
  const updatesText = command.type === 'node.setText'
  const updatesBoolean = command.type === 'node.setBlending' && command.visible !== undefined
  const updatesAppearance = Boolean(targetId && appearanceCommandTypes.has(command.type))
  if (!updatesText && !updatesBoolean && !updatesAppearance) return []
  const projected = updatesAppearance ? applyFileCommand(file, command, atoms, { allowUnavailableBindings: true }) : null
  const appearance = targetId && projected ? structuredClone(nodeAppearance(projected.nodes[targetId]) ?? {}) : null
  const commands: FileCommand[] = []
  for (const definition of Object.values(file.componentModel.definitions)) {
    if (definition.source.kind !== 'canvas') continue
    const properties = definition.properties.map(property => {
      if (updatesText && command.type === 'node.setText' && property.type === 'text' && property.binding?.nodeId === command.nodeId) return { ...property, defaultValue: command.text }
      if (updatesBoolean && command.type === 'node.setBlending' && property.type === 'boolean' && property.binding?.nodeId === command.nodeId) return { ...property, defaultValue: command.visible! }
      if (appearance && property.type === 'variant' && property.binding?.nodeId === targetId) {
        const valueId = property.currentValueId ?? property.defaultValueId
        if (JSON.stringify(property.binding.appearances[valueId]) === JSON.stringify(appearance)) return property
        return { ...property, binding: { ...property.binding, appearances: { ...property.binding.appearances, [valueId]: appearance } } }
      }
      return property
    })
    if (properties.every((property, index) => property === definition.properties[index])) continue
    commands.push({ type: 'component.replace', componentId: definition.id, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, properties } })
    for (const instance of Object.values(file.componentModel.instances)) {
      if (instance.componentId !== definition.id) continue
      const map = mapParallelComponentSubtrees(file, definition.source.masterRootId, instance.id)
      if (!map) continue
      for (const property of properties) {
        if (property.type === 'variant' && property.binding) {
          const valueId = typeof instance.values[property.id] === 'string' ? instance.values[property.id] as string : property.defaultValueId
          const nodeId = map.get(property.binding.nodeId)
          const state = property.binding.appearances[valueId]
          if (nodeId && state) commands.push({ type: 'node.setAppearance', nodeId, appearance: structuredClone(state) })
          continue
        }
        if (property.type !== 'text' && property.type !== 'boolean') continue
        const override = instance.values[property.id]
        if (override === undefined || !property.binding) continue
        const nodeId = map.get(property.binding.nodeId)
        if (!nodeId) continue
        if (property.type === 'text' && typeof override === 'string') commands.push({ type: 'node.setText', nodeId, text: override })
        if (property.type === 'boolean' && typeof override === 'boolean') commands.push({ type: 'node.setBlending', nodeId, visible: override })
      }
    }
  }
  return commands
}

function mirrorsFor(file: FileDocument, command: FileCommand, atoms: Atom[], makeId: () => string): FileCommand[] {
  const mirrors: FileCommand[] = []
  const links = linkedInstances(file)
  for (const link of links) {
    if (nodeCommandTypes.has(command.type) && 'nodeId' in command) {
      const instanceId = link.map.get(command.nodeId)
      if (instanceId) {
        const mirror = mirrorNodeCommand(command, command.nodeId, instanceId, link.masterRootId, file)
        if (mirror) mirrors.push(mirror)
      }
    }
    mirrors.push(...structuralMirrors(file, command, link, makeId))
  }
  mirrors.push(...semanticMirrors(file, command, links))
  mirrors.push(...boundDefaultCommands(file, command, atoms))
  return mirrors
}

/**
 * Expands master edits into the same semantic transaction for every linked canvas instance.
 * Root transforms remain instance-owned, while master content, appearance, and sizing stay shared.
 */
export function linkCanvasComponentCommand(file: FileDocument, command: FileCommand, atoms: Atom[], makeId: () => string): FileCommand {
  if (command.type !== 'batch') {
    const mirrors = mirrorsFor(file, command, atoms, makeId)
    return mirrors.length ? { type: 'batch', commands: [command, ...mirrors] } : command
  }
  if (command.commands.every(inner => inner.type !== 'batch' && snapshotSafeBatchCommandTypes.has(inner.type))) {
    return {
      type: 'batch',
      commands: command.commands.flatMap(inner => {
        const linked = linkCanvasComponentCommand(file, inner, atoms, makeId)
        return linked.type === 'batch' ? linked.commands : [linked]
      }),
    }
  }
  let working = file
  const commands: FileCommand[] = []
  for (const inner of command.commands) {
    const linked = linkCanvasComponentCommand(working, inner, atoms, makeId)
    commands.push(...(linked.type === 'batch' ? linked.commands : [linked]))
    working = applyFileCommand(working, linked, atoms, { allowUnavailableBindings: true })
  }
  return { type: 'batch', commands }
}
