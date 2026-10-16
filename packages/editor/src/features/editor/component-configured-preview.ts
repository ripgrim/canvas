import { resolveComponentInstanceValues } from '@canvas/repo-engine/component-model'
import type { ComponentDefinition, ComponentInstanceValues } from '@canvas/repo-engine/component-model'
import type { Appearance, FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import { descendantsOf, nodeAppearance, pageOfNode } from '@canvas/repo-engine/file-document'
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import type { PreviewPageDocument, PreviewProjection } from '@canvas/repo-engine/file-preview'
import { planComponentSlotDrafts } from './component-configured-instance'
import type { ComponentSlotDraft } from './component-configured-instance'
import { planComponentInstanceSwap } from './component-instance-swap'
import type { Atom } from './types'

function withAppearance(node: Exclude<FileNode, { type: 'root' }>, appearance: Appearance): Exclude<FileNode, { type: 'root' }> {
  return { ...node, appearance }
}

function visibleAppearance(node: Exclude<FileNode, { type: 'root' }>, visible: boolean): Appearance {
  const current = structuredClone(nodeAppearance(node) ?? {})
  if (!visible) return { ...current, visible: false }
  const { visible: _visible, ...rest } = current
  return rest
}

function configuredFile(file: FileDocument, definition: ComponentDefinition, values: ComponentInstanceValues, drafts: readonly ComponentSlotDraft[], atoms: readonly Atom[], editorMode: 'light' | 'dark'): FileDocument | null {
  const resolved = resolveComponentInstanceValues(definition, values)
  const nodes = { ...file.nodes }
  for (const property of definition.properties) {
    if (!property.binding || property.type === 'slot' || property.type === 'instance-swap') continue
    const node = nodes[property.binding.nodeId]
    if (!node || node.type === 'root') continue
    if (property.type === 'variant') {
      const appearance = property.binding.appearances[String(resolved[property.id])]
      if (appearance) nodes[node.id] = withAppearance(node, structuredClone(appearance))
      continue
    }
    if (property.type === 'text' && node.type === 'text') {
      nodes[node.id] = { ...node, text: String(resolved[property.id]) }
      continue
    }
    if (property.type === 'boolean') nodes[node.id] = withAppearance(node, visibleAppearance(node, Boolean(resolved[property.id])))
  }
  let projected = { ...file, nodes }
  const occupied = new Set(Object.keys(file.nodes))
  let sequence = 0
  const makeId = () => {
    let id = ''
    do { id = `configured-preview:${definition.id}:${sequence++}` } while (occupied.has(id))
    occupied.add(id)
    return id
  }
  for (const property of definition.properties) {
    if (property.type !== 'instance-swap') continue
    const desired = resolved[property.id]
    if (typeof desired !== 'string' || desired === property.defaultValue) continue
    const workingDefinition = projected.componentModel.definitions[definition.id]
    if (!workingDefinition || workingDefinition.source.kind !== 'canvas') return null
    const plan = planComponentInstanceSwap({ file: projected, owner: workingDefinition, ownerRootId: workingDefinition.source.masterRootId, propertyId: property.id, componentId: desired, atoms, makeId, transientMaster: true })
    if (!plan) return null
    projected = plan.file
  }
  if (!drafts.length) return projected
  const workingDefinition = projected.componentModel.definitions[definition.id]
  if (!workingDefinition || workingDefinition.source.kind !== 'canvas') return null
  return planComponentSlotDrafts({ file: projected, owner: workingDefinition, ownerRootId: workingDefinition.source.masterRootId, drafts, atoms, makeId, editorMode })?.file ?? null
}

function transformedBounds(matrix: readonly [number, number, number, number, number, number], width: number, height: number) {
  const [a, b, c, d] = matrix
  const points = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => ({ x: a * x! + c * y!, y: b * x! + d * y! }))
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

function transparentDocument(document: PreviewPageDocument): Omit<PreviewPageDocument, 'background'> {
  const { background: _background, ...rest } = document
  return rest
}

const cleanZero = (value: number) => Object.is(value, -0) ? 0 : value

const minimumPreviewFrameSize = 64

function previewFrame(width: number, height: number) {
  const frameWidth = Math.max(minimumPreviewFrameSize, width)
  const frameHeight = Math.max(minimumPreviewFrameSize, height)
  return { width: frameWidth, height: frameHeight, offsetX: (frameWidth - width) / 2, offsetY: (frameHeight - height) / 2 }
}

/** Projects one configured canvas component through the same wire document used by the isolated canvas runtime. */
export function configuredCanvasComponentPreview(
  file: FileDocument,
  definition: ComponentDefinition,
  values: ComponentInstanceValues,
  context: Parameters<typeof projectPreviewPage>[2] = {},
  options: Readonly<{ drafts?: readonly ComponentSlotDraft[]; atoms?: readonly Atom[]; editorMode?: 'light' | 'dark' }> = {},
): PreviewProjection | null {
  if (definition.source.kind !== 'canvas') return null
  const master = file.nodes[definition.source.masterRootId]
  const pageId = pageOfNode(file, definition.source.masterRootId)
  if (!master || master.type === 'root' || !pageId) return null
  const configured = configuredFile(file, definition, values, options.drafts ?? [], options.atoms ?? [], options.editorMode ?? 'light')
  if (!configured) return null
  const projection = projectPreviewPage(configured, pageId, context)
  if (!projection) return null
  const included = new Set([master.id, ...descendantsOf(configured, master.id)])
  const nodes = Object.fromEntries(Object.entries(projection.document.nodes).filter(([nodeId]) => included.has(nodeId)))
  const rootIds = master.type === 'component' ? [master.id] : []
  let layout = projection.layout.filter(item => included.has(item.nodeId))
  if (master.type === 'component') {
    const placement = layout.find(item => item.nodeId === master.id)
    const width = placement?.width ?? projection.document.frame.width
    const height = placement?.height ?? projection.document.frame.height
    const frame = previewFrame(width, height)
    layout = layout.map(item => item.nodeId === master.id ? { ...item, x: frame.offsetX, y: frame.offsetY } : item)
    return { ...projection, document: { ...transparentDocument(projection.document), rootIds, nodes, frame: { ...projection.document.frame, width: frame.width, height: frame.height, clip: false }, canvas: { elements: [] } }, layout }
  }
  const sourceRoot = projection.document.canvas.elements.find(element => element.id === master.id)!
  const bounds = transformedBounds(sourceRoot.relativeTransform, sourceRoot.width, sourceRoot.height)
  const frame = previewFrame(bounds.width, bounds.height)
  const elements = projection.document.canvas.elements.filter(element => included.has(element.id)).map(element => {
    if (element.id !== master.id) return element
    const [a, b, c, d] = element.relativeTransform
    return { ...element, parentId: null, relativeTransform: [a, b, c, d, cleanZero(frame.offsetX - bounds.x), cleanZero(frame.offsetY - bounds.y)] as const }
  })
  return {
    ...projection,
    document: { ...transparentDocument(projection.document), rootIds, nodes, frame: { ...projection.document.frame, width: frame.width, height: frame.height, clip: false }, canvas: { elements } },
    layout,
  }
}
