import type { PreviewAppearance, PreviewDocument } from '@canvas/preview-runtime/protocol'
import type { Appearance, FileDocument } from '@canvas/repo-engine/file-document'
import type { CanvasTransient } from './document-store'

export type PreviewTransientMove = Readonly<{
  nodeId: string
  dx: number
  dy: number
  width?: number
  height?: number
  appearance?: PreviewAppearance
}>

/** Converts document-space gesture state into the imperative transforms consumed by the isolated preview. */
export function previewTransientMoves(file: FileDocument | null, pageId: string | null, transient: CanvasTransient | null, previewDocument: PreviewDocument | null = null): PreviewTransientMove[] {
  if (!file || !pageId || !transient) return []
  if (transient.kind === 'resize') return Object.entries(transient.rects).flatMap(([nodeId, rect]) => {
    const start = transient.starts[nodeId]
    if (!start) return []
    const source = transient.appearances[nodeId]
    const base = previewDocument?.nodes[nodeId]?.appearance ?? previewDocument?.canvas?.elements.find(element => element.id === nodeId)?.appearance
    const geometry = new Map(source?.fills?.flatMap(fill => fill.type === 'image' && fill.geometry ? [[fill.assetId, fill.geometry] as const] : []) ?? [])
    const appearance: PreviewAppearance | undefined = base && geometry.size ? { ...base, ...(base.fills ? { fills: base.fills.map(fill => fill.type === 'image' && geometry.has(fill.assetId) ? { ...fill, geometry: geometry.get(fill.assetId)! } : fill) } : {}) } : undefined
    const resized: PreviewTransientMove = { nodeId, dx: rect.x - start.x, dy: rect.y - start.y, width: rect.width, height: rect.height, ...(appearance ? { appearance } : {}) }
    if (file.nodes[nodeId]?.type !== 'frame') return [resized]
    if (transient.contentLocked) {
      const correction = { dx: start.x - rect.x, dy: start.y - rect.y }
      const children = Object.entries(file.relationships).filter(([, relation]) => relation.parentId === nodeId).map(([childId]) => ({ nodeId: childId, ...correction }))
      return [resized, ...children]
    }
    const scale = { x: rect.width / start.width, y: rect.height / start.height }
    const descendants = Object.keys(file.nodes).filter(childId => {
      let parentId = file.relationships[childId]?.parentId
      while (parentId) { if (parentId === nodeId) return true; parentId = file.relationships[parentId]?.parentId }
      return false
    }).flatMap(childId => {
      const child = file.nodes[childId]
      if (!child || child.type === 'root' || child.type === 'component') return []
      return [{ nodeId: childId, dx: child.styles.left * (scale.x - 1), dy: child.styles.top * (scale.y - 1), width: Math.max(1, child.styles.width * scale.x), height: Math.max(1, child.styles.height * scale.y) }]
    })
    return [resized, ...descendants]
  })
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
  return roots.map(nodeId => ({ nodeId, dx: transient.offset.x, dy: transient.offset.y }))
}

export function collaborationTransforms(moves: readonly PreviewTransientMove[]) {
  return moves.map(({ appearance: _appearance, ...transform }) => Object.freeze(transform))
}
