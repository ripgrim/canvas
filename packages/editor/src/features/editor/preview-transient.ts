import { isPreviewAppearance, isPreviewDocument } from '@canvas/preview-runtime/protocol'
import type { PreviewAppearance, PreviewDocument, PreviewPresentationFence, PreviewResizeParentPaddingPresentation } from '@canvas/preview-runtime/protocol'
import type { Appearance, FileDocument } from '@canvas/repo-engine/file-document'
import type { CanvasTransient } from './document-store'
import type { ResizePresentation } from './resize-projection'

export type PreviewTransientMove = Readonly<{
  nodeId: string
  dx: number
  dy: number
  duplicate?: true
  width?: number
  height?: number
  rotationDelta?: number
  appearance?: PreviewAppearance
}>

export type PreviewResizePresentationInput = Readonly<{
  presentation: ResizePresentation
  document: PreviewDocument
  pageRootNodeId: string
  interactionId: string
  sampleSequence: number
  fence: Readonly<PreviewPresentationFence>
}>

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const finiteCoordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000
const finiteRect = (value: { x: number; y: number; width: number; height: number }) => finiteCoordinate(value.x) && finiteCoordinate(value.y) && finiteCoordinate(value.width) && finiteCoordinate(value.height) && value.width > 0 && value.height > 0
const safeFence = (value: Readonly<PreviewPresentationFence>) => Object.isFrozen(value)
  && Object.keys(value).length === 3
  && ['documentRevision', 'layoutGeneration', 'measurementRevision'].every(key => Object.hasOwn(value, key) && Number.isSafeInteger(value[key as keyof PreviewPresentationFence]) && value[key as keyof PreviewPresentationFence] >= 0)

function freezeGraph<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) freezeGraph(child, seen)
  return Object.freeze(value)
}

function previewParents(document: PreviewDocument): Map<string, string | null> | null {
  const parents = new Map<string, string | null>()
  for (const id of document.rootIds) parents.set(id, null)
  for (const [parentId, node] of Object.entries(document.nodes)) for (const children of Object.values(node.children)) for (const childId of children) {
    if (parents.has(childId)) return null
    parents.set(childId, parentId)
  }
  for (const element of document.canvas?.elements ?? []) {
    if (parents.has(element.id)) return null
    parents.set(element.id, element.parentId)
  }
  return parents.size === Object.keys(document.nodes).length + (document.canvas?.elements.length ?? 0) ? parents : null
}

function baseAppearance(document: PreviewDocument, nodeId: string): { appearance: PreviewAppearance | undefined; kind: Parameters<typeof isPreviewAppearance>[2] } | null {
  const canvas = document.canvas?.elements.find(element => element.id === nodeId)
  if (canvas) return { appearance: canvas.appearance, kind: canvas.kind }
  const component = document.nodes[nodeId]
  return component ? { appearance: component.appearance, kind: 'component' } : null
}

function mergeProjectedImageGeometry(document: PreviewDocument, nodeId: string, source: Appearance): PreviewAppearance | null {
  const base = baseAppearance(document, nodeId)
  if (!base?.appearance?.fills || !source.fills || base.appearance.fills.length !== source.fills.length) return null
  let changed = false
  const fills = base.appearance.fills.map((fill, index) => {
    const projected = source.fills![index]!
    if (fill.type !== projected.type) return null
    if (projected.type !== 'image') return fill
    if (fill.type !== 'image' || fill.assetId !== projected.assetId || fill.fit !== projected.fit || !document.assets || !Object.hasOwn(document.assets, projected.assetId)) return null
    if (!projected.geometry) return fill
    if (!finiteRect(projected.geometry)) return null
    changed = true
    return { ...fill, geometry: { ...projected.geometry } }
  })
  if (!changed || fills.some(fill => fill === null)) return null
  const appearance = { ...structuredClone(base.appearance), fills: fills as PreviewAppearance['fills'] }
  return isPreviewAppearance(appearance, document.assets, base.kind) ? appearance : null
}

/**
 * Strict v8 adapter for a reviewed resize projection. It copies parent-padding rectangles literally and only merges
 * projector-produced image geometry into the render-ready appearance.
 */
export function previewResizePresentation(input: PreviewResizePresentationInput): PreviewResizeParentPaddingPresentation | null {
  const { presentation, document, pageRootNodeId, interactionId, sampleSequence, fence } = input
  if (!isPreviewDocument(document) || !validId(pageRootNodeId) || !validId(interactionId) || !Number.isSafeInteger(sampleSequence) || sampleSequence < 0 || !safeFence(fence) || fence.documentRevision !== document.revision) return null
  if (!presentation.items.length || presentation.items.length > 500) return null
  const parents = previewParents(document)
  if (!parents) return null
  const seen = new Set<string>()
  const items: PreviewResizeParentPaddingPresentation['items'] = []
  for (const item of presentation.items) {
    if (!validId(item.nodeId) || seen.has(item.nodeId) || item.coordinateSpace !== 'parent-padding' || !finiteRect(item.startRect) || !finiteRect(item.rect)) return null
    const parentNodeId = item.parentId === pageRootNodeId ? null : item.parentId
    if (!validId(item.parentId) || !parents.has(item.nodeId) || parents.get(item.nodeId) !== parentNodeId) return null
    const appearance = item.appearance ? mergeProjectedImageGeometry(document, item.nodeId, item.appearance) : undefined
    if (item.appearance && !appearance) return null
    items.push({ nodeId: item.nodeId, parentNodeId, startRect: { ...item.startRect }, rect: { ...item.rect }, ...(appearance ? { appearance } : {}) })
    seen.add(item.nodeId)
  }
  return freezeGraph({ kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId, sampleSequence, fence, items })
}

/** Migration-only compatibility adapter for the active legacy `set-transient-move` controller path. */
export function previewTransientMoves(file: FileDocument | null, pageId: string | null, transient: CanvasTransient | null, _previewDocument: PreviewDocument | null = null): PreviewTransientMove[] {
  if (!file || !pageId || !transient) return []
  if (transient.kind !== 'move') return []
  const moved = new Set(Object.keys(transient.rects))
  const roots = [...moved].filter(id => {
    let parentId = file.relationships[id]?.parentId ?? null
    while (parentId) {
      if (moved.has(parentId)) return false
      parentId = file.relationships[parentId]?.parentId ?? null
    }
    return true
  })
  return roots.map(nodeId => ({ nodeId, dx: transient.offset.x, dy: transient.offset.y, ...(transient.duplicate ? { duplicate: true as const } : {}) }))
}

export function collaborationTransforms(moves: readonly PreviewTransientMove[]) {
  return moves.map(({ appearance: _appearance, duplicate: _duplicate, ...transform }) => Object.freeze(transform))
}
