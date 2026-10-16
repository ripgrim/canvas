import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import { applyFileCommand, descendantsOf, legacyTextProperties, nodeChildDisplay } from '@canvas/repo-engine/file-document'
import type { Appearance, FileCommand, FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import { identityTransform } from '@canvas/repo-engine/transform-matrix'
import { mapParallelComponentSubtrees } from './component-canvas-link'
import { componentPropertyProjectionCommands } from './component-property-projection'
import type { Atom } from './types'

export type ComponentSlotDraft = Readonly<{
  id: string
  propertyId: string
  content: Readonly<{ kind: 'text' | 'frame' } | { kind: 'component'; componentId: string }>
}>

type DraftPlan = Readonly<{ commands: readonly FileCommand[]; nodeIds: readonly string[]; file: FileDocument }>

const literalColor = (hex: string) => ({ kind: 'literal' as const, color: { kind: 'hex' as const, hex } })

function draftAppearance(kind: 'text' | 'frame', makeId: () => string, editorMode: 'light' | 'dark'): Appearance {
  const hex = kind === 'frame' ? '#ffffff' : editorMode === 'dark' ? '#ffffff' : '#000000'
  return { fills: [{ id: makeId(), type: 'solid', color: literalColor(hex) }] }
}

function newIdsFor(file: FileDocument, nodeId: string, makeId: () => string): Record<string, string> {
  return Object.fromEntries([nodeId, ...descendantsOf(file, nodeId)].map(id => [id, makeId()]))
}

function duplicatedInstanceCommands(file: FileDocument, ids: Readonly<Record<string, string>>): FileCommand[] {
  return Object.entries(ids).flatMap(([sourceId, id]) => {
    const instance = file.componentModel.instances[sourceId]
    return instance ? [{ type: 'component.instance.create' as const, instance: { ...structuredClone(instance), id } }] : []
  })
}

function canvasDependencies(file: FileDocument, definition: ComponentDefinition): string[] {
  if (definition.source.kind !== 'canvas') return []
  const subtree = new Set([definition.source.masterRootId, ...descendantsOf(file, definition.source.masterRootId)])
  return Object.values(file.componentModel.instances).filter(instance => subtree.has(instance.id)).map(instance => instance.componentId)
}

function dependsOn(file: FileDocument, componentId: string, targetId: string, seen = new Set<string>()): boolean {
  if (componentId === targetId) return true
  if (seen.has(componentId)) return false
  seen.add(componentId)
  const definition = file.componentModel.definitions[componentId]
  return Boolean(definition && canvasDependencies(file, definition).some(dependency => dependsOn(file, dependency, targetId, seen)))
}

export function eligibleSlotDraftComponents(file: FileDocument, owner: ComponentDefinition): ComponentDefinition[] {
  return Object.values(file.componentModel.definitions)
    .filter(candidate => candidate.source.kind === 'canvas' && !dependsOn(file, candidate.id, owner.id))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

export function validComponentSlotDrafts(file: FileDocument, owner: ComponentDefinition, drafts: readonly ComponentSlotDraft[]): ComponentSlotDraft[] {
  if (owner.source.kind !== 'canvas') return []
  const masterIds = new Set([owner.source.masterRootId, ...descendantsOf(file, owner.source.masterRootId)])
  const eligible = new Set(eligibleSlotDraftComponents(file, owner).map(definition => definition.id))
  const ids = new Set<string>()
  return drafts.filter(draft => {
    if (!draft.id || ids.has(draft.id)) return false
    const property = owner.properties.find(candidate => candidate.id === draft.propertyId)
    if (property?.type !== 'slot' || !property.binding || !masterIds.has(property.binding.nodeId) || !file.nodes[property.binding.nodeId]) return false
    if (draft.content.kind === 'component' && !eligible.has(draft.content.componentId)) return false
    ids.add(draft.id)
    return true
  })
}

function slotHost(file: FileDocument, owner: ComponentDefinition, ownerRootId: string, propertyId: string): string | null {
  if (owner.source.kind !== 'canvas') return null
  const property = owner.properties.find(candidate => candidate.id === propertyId)
  if (property?.type !== 'slot' || !property.binding) return null
  if (ownerRootId === owner.source.masterRootId) return property.binding.nodeId
  return mapParallelComponentSubtrees(file, owner.source.masterRootId, ownerRootId)?.get(property.binding.nodeId) ?? null
}

function primitiveDraftNode(file: FileDocument, parentId: string, kind: 'text' | 'frame', id: string, makeId: () => string, editorMode: 'light' | 'dark'): FileNode {
  const parent = file.nodes[parentId]
  const slotLayout = parent && nodeChildDisplay(parent) !== 'freeform' ? { layout: { item: { position: { mode: 'flow' as const } } } } : {}
  const appearance = draftAppearance(kind, makeId, editorMode)
  return kind === 'text'
    ? { id, type: 'text', name: 'Text', styles: { relativeTransform: identityTransform, width: 120, height: 20 }, ...slotLayout, appearance, text: 'Text', ...legacyTextProperties(), themeMode: 'inherit' }
    : { id, type: 'frame', name: 'Frame', styles: { relativeTransform: identityTransform, width: 160, height: 120, overflow: 'clip' }, ...slotLayout, appearance, themeMode: 'inherit' }
}

export function planComponentSlotDrafts(input: Readonly<{
  file: FileDocument
  owner: ComponentDefinition
  ownerRootId: string
  drafts: readonly ComponentSlotDraft[]
  atoms: readonly Atom[]
  makeId: () => string
  editorMode: 'light' | 'dark'
}>): DraftPlan | null {
  const drafts = validComponentSlotDrafts(input.file, input.owner, input.drafts)
  if (drafts.length !== input.drafts.length) return null
  let file = input.file
  const commands: FileCommand[] = []
  const nodeIds: string[] = []
  try {
    for (const draft of drafts) {
      const parentId = slotHost(file, input.owner, input.ownerRootId, draft.propertyId)
      if (!parentId) return null
      let next: FileCommand[]
      let rootId: string
      if (draft.content.kind === 'component') {
        const definition = file.componentModel.definitions[draft.content.componentId]
        if (!definition || definition.source.kind !== 'canvas' || dependsOn(file, definition.id, input.owner.id)) return null
        const master = file.nodes[definition.source.masterRootId]
        if (!master || master.type === 'root') return null
        const ids = newIdsFor(file, master.id, input.makeId)
        rootId = ids[master.id]!
        const instance = { id: rootId, componentId: definition.id, values: {} }
        next = [
          { type: 'node.duplicate', nodeId: master.id, ids },
          ...duplicatedInstanceCommands(file, ids),
          { type: 'node.reparent', nodeId: rootId, placement: { parentId, slot: draft.propertyId } },
          { type: 'component.instance.create', instance },
        ]
        const inserted = applyFileCommand(file, { type: 'batch', commands: next }, [...input.atoms], { allowUnavailableBindings: true })
        next.push(...componentPropertyProjectionCommands(inserted, definition, instance, definition.properties))
      } else {
        rootId = input.makeId()
        next = [{ type: 'node.insert', node: primitiveDraftNode(file, parentId, draft.content.kind, rootId, input.makeId, input.editorMode), placement: { parentId, slot: draft.propertyId } }]
      }
      file = applyFileCommand(file, next.length === 1 ? next[0]! : { type: 'batch', commands: next }, [...input.atoms], { allowUnavailableBindings: true })
      commands.push(...next)
      nodeIds.push(rootId)
    }
  } catch {
    return null
  }
  return { commands, nodeIds, file }
}
