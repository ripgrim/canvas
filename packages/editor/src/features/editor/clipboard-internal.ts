import { appearanceColors, assetReferences, mapAppearanceColors, validateImageAssetReference } from '@canvas/repo-engine/appearance'
import type { Appearance } from '@canvas/repo-engine/appearance'
import { ancestorsOf, applyFileCommand, childrenOf, descendantsOf, nodeAppearance, nodeChildDisplay, nodePositionMode, nodeWorldTransform, pageOfNode } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, FileNode, FileToken, ImageAssetReference, NodeRelationship } from '@canvas/repo-engine/file-document'
import type { ComponentDefinition, ComponentModelState } from '@canvas/repo-engine/component-model'
import { identityTransform, invertTransform, multiplyTransforms, normalizeTransform, transformedBounds, translationTransform } from '@canvas/repo-engine/transform-matrix'
import { compareOrder } from '@canvas/repo-engine/order-keys'
import { validateInternalClipboardPayload } from './clipboard-codec'
import type { InternalClipboardPayload } from './clipboard-codec'
import { positionAbsolute, positionFlow, positionFreeform } from './layout-commands'
import type { Atom } from './types'
import { nearestCompatiblePasteParent } from './clipboard-placement'
import { componentDuplicatePlanCurrent, planComponentDuplicate } from './component-duplicate'

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

function selectedRoots(file: FileDocument, pageId: string, selection: readonly string[]): string[] {
  const selected = new Set(selection.filter(id => file.nodes[id]?.type !== 'root' && pageOfNode(file, id) === pageId))
  return [...selected].filter(id => !ancestorsOf(file, id).some(parent => selected.has(parent)))
    .sort((left, right) => compareOrder({ id: left, orderKey: file.relationships[left]!.orderKey }, { id: right, orderKey: file.relationships[right]!.orderKey }))
}

function referencedAppearanceData(appearance: Appearance | undefined, tokenIds: Set<string>, assetIds: Set<string>) {
  if (!appearance) return
  for (const color of appearanceColors(appearance)) if (color.kind === 'token') tokenIds.add(color.tokenId)
  for (const assetId of assetReferences(appearance)) assetIds.add(assetId)
}

function collectDefinitionData(definition: ComponentDefinition, tokenIds: Set<string>, assetIds: Set<string>) {
  for (const material of definition.materials) referencedAppearanceData(material.appearance, tokenIds, assetIds)
  for (const table of Object.values(definition.variantAppearances ?? {})) for (const appearance of Object.values(table)) referencedAppearanceData(appearance, tokenIds, assetIds)
  for (const property of definition.properties) if (property.type === 'variant' && property.binding) {
    for (const appearance of Object.values(property.binding.appearances)) referencedAppearanceData(appearance, tokenIds, assetIds)
  }
}

function tokenClosure(file: FileDocument, requested: Set<string>): Record<string, FileToken> {
  const tokens: Record<string, FileToken> = {}
  const pending = [...requested]
  while (pending.length) {
    const id = pending.pop()!
    if (Object.hasOwn(tokens, id)) continue
    const token = file.theme.tokens[id]
    if (!token) throw new Error('Clipboard selection references a missing token')
    tokens[id] = structuredClone(token)
    if (token.value.kind === 'alias') pending.push(token.value.tokenId)
  }
  return tokens
}

function componentClosure(file: FileDocument, nodeIds: ReadonlySet<string>): ComponentModelState {
  const definitions: Record<string, ComponentDefinition> = {}
  const instances = Object.fromEntries(Object.entries(file.componentModel.instances)
    .filter(([id]) => nodeIds.has(id)).map(([id, instance]) => [id, structuredClone(instance)]))
  const pending = new Set(Object.values(instances).map(instance => instance.componentId))
  for (const definition of Object.values(file.componentModel.definitions)) if (definition.source.kind === 'canvas' && nodeIds.has(definition.source.masterRootId)) pending.add(definition.id)
  const queue = [...pending]
  while (queue.length) {
    const id = queue.shift()!
    if (definitions[id]) continue
    const definition = file.componentModel.definitions[id]
    if (!definition) throw new Error('Clipboard selection references a missing component definition')
    definitions[id] = structuredClone(definition)
    for (const property of definition.properties) {
      if (property.type !== 'instance-swap') continue
      const targets = [property.defaultValue, ...Object.values(instances)
        .filter(instance => instance.componentId === definition.id)
        .map(instance => instance.values[property.id])
        .filter((value): value is string => typeof value === 'string')]
      for (const target of targets) if (!definitions[target] && !pending.has(target)) { pending.add(target); queue.push(target) }
    }
  }
  return { definitions, instances }
}

export function createInternalClipboardPayload(file: FileDocument, pageId: string, selection: readonly string[], atoms: readonly Atom[] = []): InternalClipboardPayload {
  const roots = selectedRoots(file, pageId, selection)
  if (!roots.length) throw new Error('Select a canvas layer to copy')
  if (roots.some(id => file.nodes[id]?.type === 'component')) throw new Error('Copying a source component root is not supported yet')
  const ids = new Set(roots.flatMap(id => [id, ...descendantsOf(file, id)]))
  const componentModel = componentClosure(file, ids)
  const nodes: Record<string, FileNode> = {}
  const relationships: Record<string, NodeRelationship> = {}
  const tokenIds = new Set<string>()
  const assetIds = new Set<string>()
  for (const id of ids) {
    const original = file.nodes[id]!
    const node = structuredClone(original)
    if (roots.includes(id)) {
      if (node.type === 'component' || node.type === 'root') throw new Error('Clipboard roots need primitive geometry')
      node.styles.relativeTransform = nodeWorldTransform(file, id)
      node.layout = positionFreeform(node.layout)
    } else relationships[id] = structuredClone(file.relationships[id]!)
    nodes[id] = node
    referencedAppearanceData(nodeAppearance(original), tokenIds, assetIds)
  }
  for (const definition of Object.values(componentModel.definitions)) collectDefinitionData(definition, tokenIds, assetIds)
  const tokens = tokenClosure(file, tokenIds)
  const assets: Record<string, ImageAssetReference> = {}
  for (const id of assetIds) {
    const asset = file.assets?.[id]
    if (!asset) throw new Error('Clipboard selection references a missing image')
    assets[id] = structuredClone(asset)
  }
  return validateInternalClipboardPayload({
    version: 1,
    source: { fileId: file.fileId, pageId, fileRevision: file.revision },
    roots,
    nodes,
    relationships,
    tokens,
    componentModel,
    ...(Object.keys(assets).length ? { assets } : {}),
  }, atoms)
}

export type InternalPastePlan = Readonly<{ command: FileCommand; selection: readonly string[]; ids: Readonly<Record<string, string>>; componentSemantic: boolean }>
export type VerifiedCrossFileAssets = Readonly<Record<string, ImageAssetReference>>
export type InternalPastePlacement = Readonly<{
  offset?: Readonly<{ x: number; y: number }>
  center?: Readonly<{ x: number; y: number }>
}>
export type InternalReplaceGeometry = Readonly<{
  documentRevision: number | null
  layoutGeneration: number | null
  expectedLayoutGeneration: number
  nodes: Readonly<Record<string, Readonly<{ documentRevision?: number; layoutGeneration?: number; rect: Readonly<{ x: number; y: number; width: number; height: number }>; worldAabb?: Readonly<{ x: number; y: number; width: number; height: number }> }>>>
}>

function assertSameFileDependencies(file: FileDocument, payload: InternalClipboardPayload) {
  if (payload.source.fileId !== file.fileId) throw new Error('Cross-file clipboard assets must be verified before insertion')
  for (const [id, token] of Object.entries(payload.tokens)) if (!same(file.theme.tokens[id], token)) throw new Error('Clipboard token changed before insertion')
  for (const [id, asset] of Object.entries(payload.assets ?? {})) if (!same(file.assets?.[id], asset)) throw new Error('Clipboard image changed before insertion')
  for (const [id, definition] of Object.entries(payload.componentModel.definitions)) if (!same(file.componentModel.definitions[id], definition)) throw new Error('Clipboard component changed before insertion')
  for (const [id, instance] of Object.entries(payload.componentModel.instances)) if (!same(file.componentModel.instances[id], instance)) throw new Error('Clipboard component instance changed before insertion')
}

const hasCanvasComponentClosure = (payload: InternalClipboardPayload): boolean => Object.values(payload.componentModel.definitions).some(definition => definition.source.kind === 'canvas')

function canvasComponentRoots(payload: InternalClipboardPayload): string[] {
  return payload.roots.filter(root => {
    if (Object.values(payload.componentModel.definitions).some(definition => definition.source.kind === 'canvas' && definition.source.masterRootId === root)) return true
    const instance = payload.componentModel.instances[root]
    return Boolean(instance && payload.componentModel.definitions[instance.componentId]?.source.kind === 'canvas')
  })
}

function checkedComponentCommands(file: FileDocument, plan: NonNullable<ReturnType<typeof planComponentDuplicate>>): FileCommand[] {
  const structural = plan.commands.filter(command => command.type !== 'component.create' && command.type !== 'component.instance.create')
  const definitions = plan.commands.filter((command): command is Extract<FileCommand, { type: 'component.create' }> => command.type === 'component.create')
  const pendingInstances = plan.commands.filter((command): command is Extract<FileCommand, { type: 'component.instance.create' }> => command.type === 'component.instance.create')
  const semantic: FileCommand[] = []
  const availableDefinitions = new Set(Object.keys(file.componentModel.definitions))
  const takeInstances = (nodeIds?: ReadonlySet<string>) => {
    for (let index = pendingInstances.length - 1; index >= 0; index -= 1) {
      const command = pendingInstances[index]!
      if (nodeIds && !nodeIds.has(command.instance.id) || !availableDefinitions.has(command.instance.componentId)) continue
      semantic.push(command)
      pendingInstances.splice(index, 1)
    }
  }
  for (const command of definitions) {
    const source = command.definition.source
    if (source.kind !== 'canvas') throw new Error('Clipboard canvas component plan is invalid')
    takeInstances(new Set([source.masterRootId, ...descendantsOf(plan.file, source.masterRootId)]))
    semantic.push(command)
    availableDefinitions.add(command.definition.id)
  }
  takeInstances()
  if (pendingInstances.length) throw new Error('Clipboard canvas component closure is incomplete')
  return [...structural, ...semantic]
}

function localComponentOffset(file: FileDocument, root: string, worldOffset: Readonly<{ x: number; y: number }>): Readonly<{ x: number; y: number }> {
  const parentId = file.relationships[root]?.parentId
  const parent = parentId ? file.nodes[parentId] : undefined
  if (!parent) throw new Error('Clipboard canvas component parent changed before insertion')
  const parentInverse = invertTransform(parent.type === 'root' ? identityTransform : nodeWorldTransform(file, parent.id))
  if (!parentInverse) throw new Error('Clipboard canvas component parent transform is invalid')
  return {
    x: parentInverse[0] * worldOffset.x + parentInverse[2] * worldOffset.y,
    y: parentInverse[1] * worldOffset.x + parentInverse[3] * worldOffset.y,
  }
}

function planCanvasAwarePaste(
  file: FileDocument,
  pageId: string,
  payload: InternalClipboardPayload,
  makeId: () => string,
  placement: InternalPastePlacement,
  selection: readonly string[],
  atoms: readonly Atom[],
): InternalPastePlan | null {
  if (!hasCanvasComponentClosure(payload)) return null
  if (payload.source.fileId !== file.fileId) throw new Error('Cross-file canvas component identity is not supported')
  if (payload.source.pageId !== pageId || payload.source.fileRevision !== file.revision) throw new Error('Clipboard canvas component context changed before insertion')
  assertSameFileDependencies(file, payload)
  if (!same(createInternalClipboardPayload(file, payload.source.pageId, payload.roots, atoms), payload)) throw new Error('Clipboard canvas component graph changed before insertion')
  const group = payloadGroupBounds(payload)
  const worldOffset = placement.center
    ? { x: placement.center.x - group.x - group.width / 2, y: placement.center.y - group.y - group.height / 2 }
    : placement.offset ?? { x: group.width + 20, y: 0 }
  const semanticRoots = canvasComponentRoots(payload)
  const semanticSet = new Set(semanticRoots)
  const genericRoots = payload.roots.filter(root => !semanticSet.has(root))
  const commands: FileCommand[] = []
  const ids: Record<string, string> = {}
  let working = file
  for (const root of semanticRoots) {
    const plan = planComponentDuplicate({ file: working, nodeId: root, atoms, makeId, offset: localComponentOffset(working, root, worldOffset) })
    if (!plan || !componentDuplicatePlanCurrent(working, plan)) throw new Error('Clipboard canvas component graph changed before insertion')
    commands.push(...checkedComponentCommands(working, plan))
    Object.assign(ids, plan.ids)
    working = plan.file
  }
  if (genericRoots.length) {
    const generic = planInternalPaste(working, pageId, payload, makeId, false, { ...placement, offset: worldOffset }, selection, atoms, {}, genericRoots)
    commands.push(...(generic.command.type === 'batch' ? generic.command.commands : [generic.command]))
    Object.assign(ids, generic.ids)
    working = applyFileCommand(working, generic.command, [...atoms], { allowUnavailableBindings: true })
  }
  if (!commands.length || commands.length > 1000) throw new Error('Clipboard paste exceeds the command limit')
  const command: FileCommand = commands.length === 1 ? commands[0]! : { type: 'batch', commands }
  applyFileCommand(file, command, [...atoms], { allowUnavailableBindings: true })
  return Object.freeze({ command, selection: Object.freeze(payload.roots.map(root => ids[root]!)), ids: Object.freeze(ids), componentSemantic: true })
}

const remapAppearanceData = (appearance: Appearance | undefined, tokenIds: Readonly<Record<string, string>>, assetIds: Readonly<Record<string, string>>): Appearance | undefined => {
  if (!appearance) return undefined
  const remapped = mapAppearanceColors(appearance, value => value.kind === 'token' ? { kind: 'token', tokenId: tokenIds[value.tokenId] ?? value.tokenId } : value)
  if (!remapped.fills) return remapped
  return {
    ...remapped,
    fills: remapped.fills.map(fill => {
      const cache = fill.cache?.image
        ? { ...fill.cache, image: { ...fill.cache.image, assetId: assetIds[fill.cache.image.assetId] ?? fill.cache.image.assetId } }
        : fill.cache
      return fill.type === 'image'
        ? { ...fill, assetId: assetIds[fill.assetId] ?? fill.assetId, ...(cache ? { cache } : {}) }
        : { ...fill, ...(cache ? { cache } : {}) }
    }),
  }
}

function remapDefinitionData(definition: ComponentDefinition, tokenIds: Readonly<Record<string, string>>, assetIds: Readonly<Record<string, string>>): ComponentDefinition {
  return {
    ...structuredClone(definition),
    ...(definition.variantAppearances ? { variantAppearances: Object.fromEntries(Object.entries(definition.variantAppearances).map(([nodeId, table]) => [nodeId, Object.fromEntries(Object.entries(table).map(([key, appearance]) => [key, remapAppearanceData(appearance, tokenIds, assetIds)!]))])) } : {}),
    materials: definition.materials.map(material => ({ ...structuredClone(material), appearance: remapAppearanceData(material.appearance, tokenIds, assetIds)! })),
    properties: definition.properties.map(property => property.type === 'variant' && property.binding
      ? { ...structuredClone(property), binding: { ...structuredClone(property.binding), appearances: Object.fromEntries(Object.entries(property.binding.appearances).map(([valueId, appearance]) => [valueId, remapAppearanceData(appearance, tokenIds, assetIds)!])) } }
      : structuredClone(property)),
  }
}

function sameAssetContent(left: ImageAssetReference, right: ImageAssetReference): boolean {
  return left.name === right.name && left.mime === right.mime && left.extension === right.extension && left.bytes === right.bytes
    && left.width === right.width && left.height === right.height && left.sha256 === right.sha256
}

function crossFileDependencies(file: FileDocument, payload: InternalClipboardPayload, makeId: () => string, verifiedAssets: VerifiedCrossFileAssets) {
  const sourceAssets = payload.assets ?? {}
  const sourceAssetIds = Object.keys(sourceAssets)
  if (sourceAssetIds.some(id => !verifiedAssets[id]) || Object.keys(verifiedAssets).some(id => !sourceAssets[id])) throw new Error('Cross-file image paste needs verified source bytes')
  const reserved = new Set([...Object.keys(file.nodes), ...Object.keys(file.theme.tokens), ...Object.keys(file.componentModel.definitions), ...Object.keys(file.assets ?? {})])
  const fresh = (label: string) => {
    const id = makeId()
    if (reserved.has(id)) throw new Error(`${label} identity must be unique`)
    return id
  }
  const tokenIds: Record<string, string> = {}
  const tokenCommands: FileCommand[] = []
  const visited = new Set<string>()
  const visitToken = (sourceId: string) => {
    if (visited.has(sourceId)) return
    const source = payload.tokens[sourceId]
    if (!source) throw new Error('Clipboard token closure is incomplete')
    if (source.value.kind === 'alias') visitToken(source.value.tokenId)
    const remapped = structuredClone(source) as FileToken
    if (remapped.value.kind === 'alias') remapped.value.tokenId = tokenIds[remapped.value.tokenId]!
    const existing = file.theme.tokens[sourceId]
    const targetId = !existing || same(existing, remapped) ? sourceId : fresh('Clipboard token')
    reserved.add(targetId)
    tokenIds[sourceId] = targetId
    visited.add(sourceId)
    if (existing && targetId === sourceId) return
    remapped.id = targetId
    tokenCommands.push({ type: 'token.create', token: remapped })
  }
  for (const id of Object.keys(payload.tokens)) visitToken(id)

  const assetIds: Record<string, string> = {}
  const assetCommands: FileCommand[] = []
  for (const sourceId of sourceAssetIds) {
    const source = sourceAssets[sourceId]!
    const target = validateImageAssetReference(verifiedAssets[sourceId])
    if (!sameAssetContent(source, target) || reserved.has(target.id)) throw new Error('Cross-file image paste needs verified source bytes')
    reserved.add(target.id)
    assetIds[sourceId] = target.id
    assetCommands.push({ type: 'asset.attach', asset: structuredClone(target) })
  }

  const componentIds: Record<string, string> = {}
  const componentCommands: FileCommand[] = []
  for (const source of Object.values(payload.componentModel.definitions)) {
    if (source.source.kind === 'canvas') throw new Error('Cross-file canvas component identity is not supported')
    const remapped = remapDefinitionData(source, tokenIds, assetIds)
    const existing = file.componentModel.definitions[source.id]
    const targetId = !existing || same(existing, remapped) ? source.id : fresh('Clipboard component')
    reserved.add(targetId)
    componentIds[source.id] = targetId
    if (existing && targetId === source.id) continue
    componentCommands.push({ type: 'component.create', definition: { ...remapped, id: targetId } })
  }
  return { tokenIds, assetIds, componentIds, commands: [...tokenCommands, ...assetCommands, ...componentCommands], reserved, fresh }
}

type PasteDependencies = Readonly<{
  tokenIds: Readonly<Record<string, string>>
  assetIds: Readonly<Record<string, string>>
  componentIds: Readonly<Record<string, string>>
  commands: readonly FileCommand[]
  reserved: Set<string>
  fresh: (label: string) => string
}>

const sameFileDependencies = (file: FileDocument, payload: InternalClipboardPayload, makeId: () => string): PasteDependencies => ({
  tokenIds: Object.fromEntries(Object.keys(payload.tokens).map(id => [id, id])),
  assetIds: Object.fromEntries(Object.keys(payload.assets ?? {}).map(id => [id, id])),
  componentIds: Object.fromEntries(Object.keys(payload.componentModel.definitions).map(id => [id, id])),
  commands: [],
  reserved: new Set(Object.keys(file.nodes)),
  fresh: (_label: string) => makeId(),
})

function payloadChildren(payload: InternalClipboardPayload): Map<string, string[]> {
  const byParent = new Map<string, string[]>()
  for (const [id, relationship] of Object.entries(payload.relationships)) {
    const children = byParent.get(relationship.parentId) ?? []
    children.push(id)
    byParent.set(relationship.parentId, children)
  }
  for (const children of byParent.values()) children.sort((left, right) => compareOrder({ id: left, orderKey: payload.relationships[left]!.orderKey }, { id: right, orderKey: payload.relationships[right]!.orderKey }))
  return byParent
}

function payloadNodeIds(payload: InternalClipboardPayload, roots: readonly string[]): Set<string> {
  const byParent = payloadChildren(payload)
  const ids = new Set<string>()
  const visit = (id: string) => {
    if (ids.has(id)) return
    ids.add(id)
    for (const child of byParent.get(id) ?? []) visit(child)
  }
  roots.forEach(visit)
  return ids
}

function allocatePayloadIds(payload: InternalClipboardPayload, dependencies: PasteDependencies, sourceIds: ReadonlySet<string> = new Set(Object.keys(payload.nodes))): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const id of Object.keys(payload.nodes)) {
    if (!sourceIds.has(id)) continue
    const next = dependencies.fresh('Paste')
    if (dependencies.reserved.has(next) || Object.values(ids).includes(next)) throw new Error('Paste identities must be unique')
    dependencies.reserved.add(next)
    ids[id] = next
  }
  return ids
}

function payloadCopyCommands(
  payload: InternalClipboardPayload,
  dependencies: PasteDependencies,
  ids: Readonly<Record<string, string>>,
  byParent: ReadonlyMap<string, readonly string[]>,
  roots: readonly string[],
  root: (node: FileNode, sourceId: string, rootIndex: number) => Readonly<{ node: FileNode; parentId: string; index?: number; slot?: string }>,
): FileCommand[] {
  const commands: FileCommand[] = []
  const visit = (sourceId: string, parentId: string, rootIndex: number | null) => {
    const source = payload.nodes[sourceId]!
    let node = structuredClone(source) as FileNode
    node.id = ids[sourceId]!
    if (node.type !== 'root') {
      if (node.appearance) node.appearance = remapAppearanceData(node.appearance, dependencies.tokenIds, dependencies.assetIds)!
      if (node.type === 'component') node.componentId = dependencies.componentIds[node.componentId] ?? node.componentId
    }
    let placement: Readonly<{ parentId: string; index?: number; slot?: string }>
    if (rootIndex !== null) {
      const prepared = root(node, sourceId, rootIndex)
      node = prepared.node
      placement = { parentId: prepared.parentId, ...(prepared.index === undefined ? {} : { index: prepared.index }), ...(prepared.slot === undefined ? {} : { slot: prepared.slot }) }
    } else {
      const relationship = payload.relationships[sourceId]
      placement = { parentId, ...(relationship?.slot === undefined ? {} : { slot: relationship.slot }) }
    }
    commands.push({ type: 'node.insert', node, placement })
    for (const child of byParent.get(sourceId) ?? []) visit(child, node.id, null)
  }
  roots.forEach((sourceId, index) => visit(sourceId, '', index))
  for (const instance of Object.values(payload.componentModel.instances)) {
    const nextId = ids[instance.id]
    if (!nextId) continue
    commands.push({ type: 'component.instance.create', instance: { ...structuredClone(instance), id: nextId, componentId: dependencies.componentIds[instance.componentId] ?? instance.componentId } })
  }
  return commands
}

function planInternalPaste(file: FileDocument, pageId: string, payload: InternalClipboardPayload, makeId: () => string, crossFile: boolean, placement: InternalPastePlacement, selection: readonly string[], atoms: readonly Atom[], verifiedAssets: VerifiedCrossFileAssets = {}, pasteRoots: readonly string[] = payload.roots): InternalPastePlan {
  const page = file.pages.find(candidate => candidate.id === pageId)
  if (!page) throw new Error('Paste target page is missing')
  const dependencies = crossFile ? crossFileDependencies(file, payload, makeId, verifiedAssets) : sameFileDependencies(file, payload, makeId)
  if (!pasteRoots.length) throw new Error('Clipboard paste needs a root')
  const sourceIds = payloadNodeIds(payload, pasteRoots)
  const ids = allocatePayloadIds(payload, dependencies, sourceIds)
  const byParent = payloadChildren(payload)
  const group = payloadGroupBounds(payload, pasteRoots)
  const roots = pasteRoots.map(id => payload.nodes[id]!)
  const target = nearestCompatiblePasteParent(file, pageId, selection, roots, atoms, placement.center, new Set(Object.keys(payload.nodes)))
  const parentWorld = target.type === 'root' ? identityTransform : nodeWorldTransform(file, target.id)
  const parentInverse = invertTransform(parentWorld)
  if (!parentInverse) throw new Error('Paste target transform is invalid')
  const display = target.type === 'root' ? 'freeform' : nodeChildDisplay(target)
  const commands: FileCommand[] = [...dependencies.commands, ...payloadCopyCommands(payload, dependencies, ids, byParent, pasteRoots, node => {
    if (node.type === 'root' || node.type === 'component') throw new Error('Clipboard root cannot be inserted on the page')
    const offset = placement.offset ?? (placement.center
      ? { x: placement.center.x - group.x - group.width / 2, y: placement.center.y - group.y - group.height / 2 }
      : { x: group.width + 20, y: 0 })
    const desiredWorld = multiplyTransforms(translationTransform(offset.x, offset.y), node.styles.relativeTransform)
    const local = normalizeTransform(multiplyTransforms(parentInverse, desiredWorld))
    if (display === 'freeform') {
      node.styles.relativeTransform = local
      node.layout = positionFreeform(node.layout)
    } else {
      node.styles.relativeTransform = [local[0], local[1], local[2], local[3], 0, 0]
      node.layout = positionFlow(node.layout, display)
    }
    return { node, parentId: target.id }
  })]
  if (!commands.length || commands.length > 1000) throw new Error('Clipboard paste exceeds the command limit')
  const command: FileCommand = commands.length === 1 ? commands[0]! : { type: 'batch', commands }
  return Object.freeze({
    command,
    selection: Object.freeze(pasteRoots.map(id => ids[id]!)),
    ids: Object.freeze(ids),
    componentSemantic: false,
  })
}

const payloadGroupBounds = (payload: InternalClipboardPayload, roots: readonly string[] = payload.roots) => {
  const bounds = roots.map(id => {
    const node = payload.nodes[id]
    if (!node || node.type === 'root' || node.type === 'component') throw new Error('Clipboard root needs primitive geometry')
    return transformedBounds(node.styles.relativeTransform, { width: node.styles.width, height: node.styles.height })
  })
  const left = Math.min(...bounds.map(value => value.x))
  const top = Math.min(...bounds.map(value => value.y))
  const right = Math.max(...bounds.map(value => value.x + value.width))
  const bottom = Math.max(...bounds.map(value => value.y + value.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function currentReplacementBounds(file: FileDocument, nodeId: string, geometry: InternalReplaceGeometry): Readonly<{ x: number; y: number; width: number; height: number }> {
  const measurement = geometry.nodes[nodeId]
  if (geometry.documentRevision !== file.revision || geometry.layoutGeneration !== geometry.expectedLayoutGeneration
    || measurement?.documentRevision !== file.revision || measurement.layoutGeneration !== geometry.expectedLayoutGeneration) throw new Error('Paste to replace needs current canvas measurements')
  return measurement.worldAabb ?? measurement.rect
}

function planInternalReplace(
  file: FileDocument,
  pageId: string,
  payload: InternalClipboardPayload,
  selection: readonly string[],
  makeId: () => string,
  geometry: InternalReplaceGeometry,
  crossFile: boolean,
  atoms: readonly Atom[],
  verifiedAssets: VerifiedCrossFileAssets = {},
): InternalPastePlan {
  const targets = selectedRoots(file, pageId, selection)
  if (!targets.length) throw new Error('Select canvas layers to replace')
  if (Object.keys(payload.nodes).length * targets.length > 10_000) throw new Error('Paste to replace exceeds the 10,000 node limit')
  const dependencies = crossFile ? crossFileDependencies(file, payload, makeId, verifiedAssets) : sameFileDependencies(file, payload, makeId)
  const byParent = payloadChildren(payload)
  const group = payloadGroupBounds(payload)
  const commands: FileCommand[] = [...dependencies.commands]
  const selectionIds: string[] = []
  const allIds: Record<string, string> = {}
  let working = dependencies.commands.length
    ? applyFileCommand(file, { type: 'batch', commands: [...dependencies.commands] }, [...atoms], { allowUnavailableBindings: true })
    : structuredClone(file)
  for (const targetId of targets) {
    const target = working.nodes[targetId]
    const relationship = working.relationships[targetId]
    if (!target || target.type === 'root' || !relationship) throw new Error('Paste to replace target changed')
    const parent = working.nodes[relationship.parentId]
    if (!parent) throw new Error('Paste to replace parent changed')
    const targetIndex = childrenOf(working, parent.id, relationship.slot).indexOf(targetId)
    if (targetIndex < 0) throw new Error('Paste to replace target changed')
    const targetMode = nodePositionMode(target)
    const bounds = targetMode === 'flow' ? null : currentReplacementBounds(file, targetId, geometry)
    const parentWorld = parent.type === 'root' ? identityTransform : nodeWorldTransform(working, parent.id)
    const parentInverse = invertTransform(parentWorld)
    if (!parentInverse) throw new Error('Paste to replace parent transform is invalid')
    const ids = allocatePayloadIds(payload, dependencies)
    Object.assign(allIds, Object.fromEntries(Object.entries(ids).map(([source, id]) => [`${targetId}:${source}`, id])))
    const copy = payloadCopyCommands(payload, dependencies, ids, byParent, payload.roots, (node, sourceId, rootIndex) => {
      if (node.type === 'root' || node.type === 'component') throw new Error('Clipboard root needs primitive geometry')
      const sourceWorld = node.styles.relativeTransform
      const sourceOrigin = { x: sourceWorld[4], y: sourceWorld[5] }
      const desiredWorld = bounds
        ? multiplyTransforms(translationTransform(bounds.x - group.x, bounds.y - group.y), sourceWorld)
        : sourceWorld
      const local = normalizeTransform(multiplyTransforms(parentInverse, desiredWorld))
      if (targetMode === 'flow') {
        node.styles.relativeTransform = [local[0], local[1], local[2], local[3], 0, 0]
        node.layout = positionFlow(node.layout, nodeChildDisplay(parent))
      } else if (targetMode === 'absolute') {
        node.styles.relativeTransform = [local[0], local[1], local[2], local[3], 0, 0]
        node.layout = positionAbsolute(node.layout, { x: local[4], y: local[5] })
      } else {
        node.styles.relativeTransform = local
        node.layout = positionFreeform(node.layout)
      }
      const slot = relationship.slot
      return { node, parentId: parent.id, index: targetIndex + rootIndex, ...(slot === undefined ? {} : { slot }) }
    })
    commands.push(...copy)
    working = applyFileCommand(working, copy.length === 1 ? copy[0]! : { type: 'batch', commands: copy }, [...atoms], { allowUnavailableBindings: true })
    selectionIds.push(...payload.roots.map(id => ids[id]!))
  }
  commands.push({ type: 'node.delete', nodeIds: targets })
  if (commands.length > 1000) throw new Error('Paste to replace exceeds the command limit')
  const command: FileCommand = { type: 'batch', commands }
  applyFileCommand(file, command, [...atoms], { allowUnavailableBindings: true })
  return Object.freeze({ command, selection: Object.freeze(selectionIds), ids: Object.freeze(allIds), componentSemantic: false })
}

export function planSameFileInternalPaste(file: FileDocument, pageId: string, payload: InternalClipboardPayload, makeId: () => string, placement: InternalPastePlacement = {}, selection: readonly string[] = [], atoms: readonly Atom[] = []): InternalPastePlan {
  assertSameFileDependencies(file, payload)
  const component = planCanvasAwarePaste(file, pageId, payload, makeId, placement, selection, atoms)
  if (component) return component
  return planInternalPaste(file, pageId, payload, makeId, false, placement, selection, atoms)
}

export function planCrossFileInternalPaste(file: FileDocument, pageId: string, payload: InternalClipboardPayload, makeId: () => string, placement: InternalPastePlacement = {}, selection: readonly string[] = [], atoms: readonly Atom[] = [], verifiedAssets: VerifiedCrossFileAssets = {}): InternalPastePlan {
  if (payload.source.fileId === file.fileId) throw new Error('Cross-file paste requires a different source file')
  return planInternalPaste(file, pageId, payload, makeId, true, placement, selection, atoms, verifiedAssets)
}

export function planValidatedInternalPaste(file: FileDocument, pageId: string, payload: InternalClipboardPayload, makeId: () => string, placement: InternalPastePlacement = {}, selection: readonly string[] = [], atoms: readonly Atom[] = [], verifiedAssets: VerifiedCrossFileAssets = {}): InternalPastePlan {
  return payload.source.fileId === file.fileId
    ? planSameFileInternalPaste(file, pageId, payload, makeId, placement, selection, atoms)
    : planCrossFileInternalPaste(file, pageId, payload, makeId, placement, selection, atoms, verifiedAssets)
}

export function planValidatedInternalReplace(file: FileDocument, pageId: string, payload: InternalClipboardPayload, selection: readonly string[], makeId: () => string, geometry: InternalReplaceGeometry, atoms: readonly Atom[] = [], verifiedAssets: VerifiedCrossFileAssets = {}): InternalPastePlan {
  if (hasCanvasComponentClosure(payload)) throw new Error('Paste to replace does not support canvas component identity')
  if (payload.source.fileId === file.fileId) assertSameFileDependencies(file, payload)
  return planInternalReplace(file, pageId, payload, selection, makeId, geometry, payload.source.fileId !== file.fileId, atoms, verifiedAssets)
}
