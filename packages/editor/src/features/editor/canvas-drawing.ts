import type { CanvasElementKind } from '@canvas/repo-engine/document'

export type CanvasPoint = { x: number; y: number }
export type CanvasBounds = CanvasPoint & { width: number; height: number }
export type CanvasCreationIntent = 'point' | 'drag'

export const canvasElementSizes: Record<CanvasElementKind, { width: number; height: number }> = {
  frame: { width: 320, height: 240 },
  // Product default: a click-created rectangle is a 500 x 500 white square (Paper's measured default differs).
  rectangle: { width: 500, height: 500 },
  shape: { width: 120, height: 120 },
  shader: { width: 220, height: 140 },
  text: { width: 180, height: 40 },
}

export function canvasPointFromClient(
  client: CanvasPoint,
  bounds: Pick<DOMRect, 'left' | 'top'>,
  zoom: number,
): CanvasPoint {
  return {
    x: (client.x - bounds.left) / zoom,
    y: (client.y - bounds.top) / zoom,
  }
}

export function canvasCreationBounds(
  kind: CanvasElementKind,
  origin: CanvasPoint,
  current: CanvasPoint,
  zoom: number,
  dragThreshold = 4,
): CanvasBounds {
  if (canvasCreationIntent(origin, current, zoom, dragThreshold) === 'point') return { x: Math.round(origin.x), y: Math.round(origin.y), ...canvasElementSizes[kind] }

  return {
    x: Math.round(Math.min(origin.x, current.x)),
    y: Math.round(Math.min(origin.y, current.y)),
    width: Math.max(1, Math.round(Math.abs(current.x - origin.x))),
    height: Math.max(1, Math.round(Math.abs(current.y - origin.y))),
  }
}

/** Paper does not create a drag-sized text box until the pointer crosses the screen-pixel threshold. */
export function canvasCreationIntent(
  origin: CanvasPoint,
  current: CanvasPoint,
  zoom: number,
  dragThreshold = 4,
): CanvasCreationIntent {
  return Math.hypot(current.x - origin.x, current.y - origin.y) * zoom >= dragThreshold ? 'drag' : 'point'
}
