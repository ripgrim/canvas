export const layerTreeRowHeight = 28
export const layerTreeIndent = 16
export const layerTreeDragThreshold = 5
export const layerTreeDepthStep = 15
export const layerTreeNestVelocityLimit = 30
export const layerTreeEdgeSize = 20
export const layerTreeMaxScrollStep = 6

export type LayerTreeRow = Readonly<{
  id: string
  depth: number
  parentId: string
  slot?: string
  placementParentId?: string
  insideParentId?: string
  insideSlot?: string
  acceptsDrop: boolean
  expanded: boolean
  childIds: readonly string[]
}>

export type LayerTreeDrop = Readonly<{
  parentId: string
  slot?: string
  index: number
  targetId: string
  mode: 'before' | 'inside' | 'after'
  depth: number
}>

export const surpassedLayerTreeThreshold = (startX: number, startY: number, x: number, y: number) => Math.hypot(x - startX, y - startY) >= layerTreeDragThreshold

export function layerTreeZone(offsetY: number, rowHeight: number, acceptsDrop: boolean, velocity: number): 'before' | 'inside' | 'after' {
  const ratio = Math.max(0, Math.min(1, offsetY / Math.max(1, rowHeight)))
  if (!acceptsDrop || velocity > layerTreeNestVelocityLimit) return ratio < 0.5 ? 'before' : 'after'
  if (ratio < 0.24) return 'before'
  if (ratio > 0.76) return 'after'
  return 'inside'
}

const previousSibling = (rows: readonly LayerTreeRow[], row: LayerTreeRow) => {
  const siblings = rows.filter(candidate => candidate.parentId === row.parentId && candidate.slot === row.slot)
  return siblings[Math.max(0, siblings.findIndex(candidate => candidate.id === row.id) - 1)]
}

/** Paper starts from the deepest legal parent near the insertion point, then changes one level per 15 screen pixels. */
export function layerTreeParentCandidates(rows: readonly LayerTreeRow[], target: LayerTreeRow): readonly LayerTreeRow[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const candidates: LayerTreeRow[] = []
  let current: LayerTreeRow | undefined = target
  while (current) {
    if (current.acceptsDrop) candidates.unshift(current)
    const previous = previousSibling(rows, current)
    if (previous?.acceptsDrop) {
      let deepest = previous
      while (deepest.expanded && deepest.childIds.length) {
        const child = byId.get(deepest.childIds[deepest.childIds.length - 1]!)
        if (!child?.acceptsDrop) break
        deepest = child
      }
      candidates.unshift(deepest)
    }
    current = byId.get(current.parentId)
  }
  return [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()].sort((a, b) => a.depth - b.depth)
}

export function resolveLayerTreeDrop(rows: readonly LayerTreeRow[], targetId: string, offsetY: number, rowHeight: number, horizontalDelta: number, velocity: number): LayerTreeDrop | null {
  const target = rows.find(row => row.id === targetId)
  if (!target) return null
  const mode = layerTreeZone(offsetY, rowHeight, target.acceptsDrop, velocity)
  if (mode === 'inside') return { parentId: target.insideParentId ?? target.id, ...(target.insideSlot ? { slot: target.insideSlot } : {}), index: target.childIds.length, targetId, mode, depth: target.depth + 1 }
  const placementParentId = target.placementParentId ?? target.parentId
  const siblings = rows.filter(row => (row.placementParentId ?? row.parentId) === placementParentId && row.slot === target.slot)
  const targetIndex = siblings.findIndex(row => row.id === target.id)
  const base = { parentId: placementParentId, ...(target.slot ? { slot: target.slot } : {}), index: targetIndex + (mode === 'after' ? 1 : 0), targetId, mode, depth: target.depth }
  const depthDelta = Math.trunc(horizontalDelta / layerTreeDepthStep)
  if (depthDelta === 0) return base
  if (depthDelta < 0) {
    const byId = new Map(rows.map(row => [row.id, row]))
    const desiredDepth = Math.max(0, target.depth + depthDelta)
    let anchor = target
    while (anchor.depth > desiredDepth) {
      const parent = byId.get(anchor.parentId)
      if (!parent) break
      anchor = parent
    }
    const anchorParentId = anchor.placementParentId ?? anchor.parentId
    const anchorSiblings = rows.filter(row => (row.placementParentId ?? row.parentId) === anchorParentId && row.slot === anchor.slot)
    const anchorIndex = anchorSiblings.findIndex(row => row.id === anchor.id)
    return { parentId: anchorParentId, ...(anchor.slot ? { slot: anchor.slot } : {}), index: anchorIndex + (mode === 'after' ? 1 : 0), targetId, mode, depth: anchor.depth }
  }
  const candidates = layerTreeParentCandidates(rows, target)
  if (!candidates.length) return base
  const candidate = candidates.filter(item => item.depth >= target.depth).at(Math.min(depthDelta - 1, candidates.length - 1))
  if (!candidate || candidate.id === target.parentId) return base
  return { parentId: candidate.id, index: candidate.childIds.length, targetId, mode, depth: candidate.depth + 1 }
}

export function layerTreeScrollStep(pointerY: number, top: number, bottom: number) {
  if (pointerY < top + layerTreeEdgeSize) return -layerTreeMaxScrollStep * Math.max(0, Math.min(1, (top + layerTreeEdgeSize - pointerY) / layerTreeEdgeSize))
  if (pointerY > bottom - layerTreeEdgeSize) return layerTreeMaxScrollStep * Math.max(0, Math.min(1, (pointerY - (bottom - layerTreeEdgeSize)) / layerTreeEdgeSize))
  return 0
}
