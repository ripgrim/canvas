import type { HudProjectionFrame, HudQuad } from './canvas-hud-projection'
import { currentHudProjectionFrame } from './canvas-hud-projection-service'
import type { CanvasHudProjectionSnapshot } from './canvas-hud-projection-service'
import type { Point, Rect } from './canvas-math'
import { ancestors } from './canvas-scene'
import type { Scene, SceneNode } from './canvas-scene'

const epsilon = 1e-9
type Polygon = readonly Readonly<Point>[]
export type CanvasHudProjectionSource = Readonly<{ getSnapshot: () => CanvasHudProjectionSnapshot }>
export type CanvasHitFrameKey = Omit<HudProjectionFrame['key'], 'hover' | 'mobile'>
export type CanvasHitDocumentKey = Omit<CanvasHitFrameKey, 'camera' | 'size' | 'targetCamera' | 'targetSize'> & Readonly<{
  targetCamera: Readonly<{ x: number; y: number; zoom: number }>
  targetSize: Readonly<{ width: number; height: number }>
}>

const finitePoint = (point: Readonly<Point>) => Number.isFinite(point.x) && Number.isFinite(point.y)
const cross = (origin: Readonly<Point>, end: Readonly<Point>, point: Readonly<Point>) => (end.x - origin.x) * (point.y - origin.y) - (end.y - origin.y) * (point.x - origin.x)
const signedArea = (polygon: Polygon) => polygon.reduce((area, point, index) => {
  const next = polygon[(index + 1) % polygon.length]!
  return area + point.x * next.y - next.x * point.y
}, 0) / 2

const sameOrdered = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index])
const sameKey = (left: CanvasHitFrameKey, right: CanvasHitFrameKey) => left.fileId === right.fileId
  && left.pageId === right.pageId
  && left.fileRevision === right.fileRevision
  && left.measurementRevision === right.measurementRevision
  && left.documentRevision === right.documentRevision
  && left.layoutGeneration === right.layoutGeneration
  && left.camera.x === right.camera.x
  && left.camera.y === right.camera.y
  && left.camera.zoom === right.camera.zoom
  && left.size.width === right.size.width
  && left.size.height === right.size.height
  && sameOrdered(left.selection, right.selection)
  && left.tool === right.tool
  && left.readOnly === right.readOnly

/** Reads one exact service publication and rejects copied, superseded, or state-split generations. */
export function currentCanvasHitFrame(source: CanvasHudProjectionSource, expected: CanvasHitFrameKey): HudProjectionFrame | null {
  const observed = source.getSnapshot()
  const frame = currentHudProjectionFrame(observed, source.getSnapshot())
  return frame && sameKey(frame.key, expected) ? frame : null
}

/** Hit-testing follows the exact camera and viewport that produced the current renderer frame, not a newer target camera still awaiting preview acknowledgement. */
export function currentCanvasHitFrameForDocument(source: CanvasHudProjectionSource, expected: CanvasHitDocumentKey): HudProjectionFrame | null {
  const observed = source.getSnapshot()
  const frame = currentHudProjectionFrame(observed, source.getSnapshot())
  if (!frame) return null
  const key = frame.key
  const targetCamera = key.targetCamera ?? key.camera
  const targetSize = key.targetSize ?? key.size
  return key.fileId === expected.fileId
    && key.pageId === expected.pageId
    && key.fileRevision === expected.fileRevision
    && key.measurementRevision === expected.measurementRevision
    && key.documentRevision === expected.documentRevision
    && key.layoutGeneration === expected.layoutGeneration
    && targetCamera.x === expected.targetCamera.x
    && targetCamera.y === expected.targetCamera.y
    && targetCamera.zoom === expected.targetCamera.zoom
    && targetSize.width === expected.targetSize.width
    && targetSize.height === expected.targetSize.height
    && sameOrdered(key.selection, expected.selection)
    && key.tool === expected.tool
    && key.readOnly === expected.readOnly
    ? frame
    : null
}

function usablePolygon(polygon: Polygon): boolean {
  return polygon.length >= 3 && polygon.every(finitePoint) && Math.abs(signedArea(polygon)) > epsilon
}

/** Winding-independent containment for the convex quads emitted by the canonical HUD projector. */
export function pointInHudQuad(point: Readonly<Point>, quad: HudQuad): boolean {
  if (!finitePoint(point) || !usablePolygon(quad)) return false
  let positive = false, negative = false
  for (let index = 0; index < quad.length; index++) {
    const value = cross(quad[index]!, quad[(index + 1) % quad.length]!, point)
    if (value > epsilon) positive = true
    else if (value < -epsilon) negative = true
    if (positive && negative) return false
  }
  return true
}

function lineIntersection(start: Readonly<Point>, end: Readonly<Point>, clipStart: Readonly<Point>, clipEnd: Readonly<Point>): Point | null {
  const line = { x: end.x - start.x, y: end.y - start.y }
  const clip = { x: clipEnd.x - clipStart.x, y: clipEnd.y - clipStart.y }
  const denominator = line.x * clip.y - line.y * clip.x
  if (Math.abs(denominator) <= epsilon) return null
  const offset = { x: clipStart.x - start.x, y: clipStart.y - start.y }
  const distance = (offset.x * clip.y - offset.y * clip.x) / denominator
  const point = { x: start.x + line.x * distance, y: start.y + line.y * distance }
  return finitePoint(point) ? point : null
}

/** Convex polygon clipping preserves the actually visible portion through every clipping ancestor. */
function clipPolygon(subject: Polygon, clip: Polygon): Polygon {
  if (!usablePolygon(subject) || !usablePolygon(clip)) return []
  const winding = Math.sign(signedArea(clip))
  let output = [...subject]
  for (let clipIndex = 0; clipIndex < clip.length && output.length; clipIndex++) {
    const clipStart = clip[clipIndex]!, clipEnd = clip[(clipIndex + 1) % clip.length]!
    const input = output
    output = []
    const inside = (point: Readonly<Point>) => cross(clipStart, clipEnd, point) * winding >= -epsilon
    let start = input[input.length - 1]!
    for (const end of input) {
      const startInside = inside(start), endInside = inside(end)
      if (endInside) {
        if (!startInside) { const intersection = lineIntersection(start, end, clipStart, clipEnd); if (intersection) output.push(intersection) }
        output.push(end)
      } else if (startInside) {
        const intersection = lineIntersection(start, end, clipStart, clipEnd)
        if (intersection) output.push(intersection)
      }
      start = end
    }
  }
  return output
}

const marqueePolygon = (rect: Readonly<Rect>): Polygon => [
  { x: rect.x, y: rect.y },
  { x: rect.x + rect.width, y: rect.y },
  { x: rect.x + rect.width, y: rect.y + rect.height },
  { x: rect.x, y: rect.y + rect.height },
]

export function projectedFrameMatchesScene(scene: Scene, frame: HudProjectionFrame): boolean {
  if (frame.entries.length !== scene.nodes.length || Object.keys(frame.byNodeId).length !== scene.nodes.length) return false
  return scene.nodes.every((node, index) => {
    const entry = frame.entries[index]
    return entry?.nodeId === node.id
      && frame.byNodeId[node.id] === entry
      && entry.parentId === node.parentId
      && entry.kind === node.kind
      && entry.policy.locked === node.locked
      && usablePolygon(entry.screenQuad)
  })
}

function visiblePolygon(scene: Scene, frame: HudProjectionFrame, node: SceneNode): Polygon {
  let visible: Polygon = frame.byNodeId[node.id]!.screenQuad
  for (const ancestor of ancestors(scene, node.id)) {
    if (ancestor.id === node.id || !ancestor.clip) continue
    visible = clipPolygon(visible, frame.byNodeId[ancestor.id]!.screenQuad)
    if (!visible.length) return []
  }
  return visible
}

function pointInPolygon(point: Readonly<Point>, polygon: Polygon): boolean {
  if (!usablePolygon(polygon)) return false
  const winding = Math.sign(signedArea(polygon))
  for (let index = 0; index < polygon.length; index++) if (cross(polygon[index]!, polygon[(index + 1) % polygon.length]!, point) * winding < -epsilon) return false
  return true
}

function belongsToDraggedSubtree(scene: Scene, frame: HudProjectionFrame, node: SceneNode): boolean {
  const dragged = frame.flowDrag?.documentNodeId
  if (!dragged) return false
  let current: SceneNode | undefined = node
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    if (current.id === dragged) return true
    visited.add(current.id)
    current = current.parentId ? scene.byId.get(current.parentId) : undefined
  }
  return false
}

/** Canonical screen-quad hits in scene paint order. An incomplete or split frame rejects the whole query. */
export function projectedHitTest(scene: Scene, frame: HudProjectionFrame, point: Readonly<Point>): SceneNode[] {
  if (!projectedFrameMatchesScene(scene, frame) || !finitePoint(point)) return []
  return scene.nodes
    .filter(node => !node.locked && !belongsToDraggedSubtree(scene, frame, node) && pointInPolygon(point, visiblePolygon(scene, frame, node)))
    .sort((left, right) => right.order - left.order)
}

export function projectedClickTarget(scene: Scene, frame: HudProjectionFrame, point: Readonly<Point>, selection: readonly string[], deep: boolean): SceneNode | null {
  if (selection.length !== frame.key.selection.length || selection.some((id, index) => id !== frame.key.selection[index])) return null
  const top = projectedHitTest(scene, frame, point)[0]
  if (!top) return null
  if (deep) return top
  const path = ancestors(scene, top.id)
  let anchor = -1
  for (let index = path.length - 1; index >= 0; index--) if (selection.includes(path[index]!.id)) { anchor = index; break }
  return path[Math.min(anchor >= 0 ? anchor + 1 : 1, path.length - 1)] ?? top
}

export function projectedDrillTarget(scene: Scene, frame: HudProjectionFrame, point: Readonly<Point>, selection: readonly string[]): SceneNode | null {
  if (selection.length !== frame.key.selection.length || selection.some((id, index) => id !== frame.key.selection[index])) return null
  const top = projectedHitTest(scene, frame, point)[0]
  if (!top) return null
  const path = ancestors(scene, top.id)
  let anchor = -1
  for (let index = path.length - 1; index >= 0; index--) if (selection.includes(path[index]!.id)) { anchor = index; break }
  return path[Math.min(anchor + 1, path.length - 1)] ?? top
}

/** True convex intersection in screen space. AABB overlap alone never selects a rotated node. */
export function projectedMarqueeTargets(scene: Scene, frame: HudProjectionFrame, brush: Readonly<Rect>, deep: boolean): string[] {
  if (!projectedFrameMatchesScene(scene, frame) || ![brush.x, brush.y, brush.width, brush.height].every(Number.isFinite) || brush.width <= 0 || brush.height <= 0) return []
  const marquee = marqueePolygon(brush)
  return scene.nodes.filter(node => {
    if (node.locked || belongsToDraggedSubtree(scene, frame, node) || (!deep && node.parentId !== null)) return false
    return usablePolygon(clipPolygon(visiblePolygon(scene, frame, node), marquee))
  }).map(node => node.id)
}
