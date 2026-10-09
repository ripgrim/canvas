import type { CanvasElement } from '@canvas/repo-engine/document'

export type WorldPoint = { x: number; y: number }

export function canvasWorldPoint(elements: readonly CanvasElement[], element: Pick<CanvasElement, 'id' | 'x' | 'y' | 'parentId'>): WorldPoint {
  const byId = new Map(elements.map(item => [item.id, item]))
  let x = element.x
  let y = element.y
  let parentId = element.parentId
  const visited = new Set([element.id])
  while (parentId) {
    if (visited.has(parentId)) break
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.x
    y += parent.y
    parentId = parent.parentId
  }
  return { x, y }
}

export function canvasDepth(elements: readonly CanvasElement[], element: CanvasElement): number {
  const byId = new Map(elements.map(item => [item.id, item]))
  let depth = 0
  let parentId = element.parentId
  const visited = new Set([element.id])
  while (parentId && !visited.has(parentId)) { visited.add(parentId); depth += 1; parentId = byId.get(parentId)?.parentId }
  return depth
}

export function containingFrame(elements: readonly CanvasElement[], point: WorldPoint, excludedId?: string): CanvasElement | null {
  const byId = new Map(elements.map(item => [item.id, item]))
  const insideExcluded = (element: CanvasElement) => { let parentId = element.parentId; while (parentId) { if (parentId === excludedId) return true; parentId = byId.get(parentId)?.parentId } return false }
  return [...elements].filter(element => element.kind === 'frame' && element.id !== excludedId && !insideExcluded(element)).sort((left, right) => canvasDepth(elements, right) - canvasDepth(elements, left)).find(element => {
    const world = canvasWorldPoint(elements, element)
    return point.x >= world.x && point.x <= world.x + element.width && point.y >= world.y && point.y <= world.y + element.height
  }) ?? null
}
