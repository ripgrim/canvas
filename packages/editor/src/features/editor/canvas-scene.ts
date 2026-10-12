import { childrenOf, nodeIsLocked, pageRoot, worldRect } from '@canvas/repo-engine/file-document'
import type { FileDocument, PrimitiveKind } from '@canvas/repo-engine/file-document'
import { legacyLayout } from '@canvas/repo-engine/layout'
import { pointInRect, rectsIntersect } from './canvas-math'
import type { Point, Rect } from './canvas-math'
import type { MeasuredNode } from './scene-geometry'

/**
 * One coherent scene for the open page: component instances (measured in the preview) and primitive nodes (geometry
 * derived from the file) share identity, hierarchy, z-order, and world rectangles for hit testing, the layer tree, and the HUD.
 * The page root is structural and never appears in the scene; its direct children have `parentId: null`.
 */
export type SceneNode = {
  id: string
  kind: 'component' | PrimitiveKind
  name: string
  parentId: string | null
  rect: Rect
  /** Authored clockwise rotation in degrees. Selection chrome uses it to follow the rendered face. */
  rotation: number
  clip: boolean
  depth: number
  order: number
  /** Positioned by the parent layout rather than by x/y. */
  flow: boolean
  /** Directly locked or inherited from a locked ancestor. */
  locked: boolean
}
export type Scene = { nodes: SceneNode[]; byId: Map<string, SceneNode> }
const emptyScene: Scene = { nodes: [], byId: new Map() }

export function displayName(file: FileDocument, id: string): string {
  const node = file.nodes[id]
  if (!node || node.type === 'root') return id
  if (node.type === 'component') return node.name ?? node.exportName
  if (node.type === 'text') { const text = (node.text ?? '').trim().replace(/\s+/g, ' '); if (text) return text.length > 20 ? `${text.slice(0, 20).trimEnd()}…` : text }
  return node.name
}

export function buildScene(file: FileDocument | null, pageId: string | null, measured: Record<string, MeasuredNode>): Scene {
  if (!file || !pageId) return emptyScene
  const root = pageRoot(file, pageId)
  if (!root) return emptyScene
  const nodes: SceneNode[] = []
  let order = 0
  const visit = (id: string, parentId: string | null, depth: number) => {
    const node = file.nodes[id]
    if (!node || node.type === 'root') return
    if (node.type === 'component') {
      const rect = measured[id]?.componentId === node.componentId ? measured[id]!.rect : null
      if (rect) nodes.push({ id, kind: 'component', name: displayName(file, id), parentId, rect, rotation: node.layout?.item.transform?.rotate ?? 0, clip: false, depth, order: order++, flow: parentId !== null && legacyLayout(node.layout).mode !== 'absolute', locked: nodeIsLocked(file, id) })
    } else {
      nodes.push({ id, kind: node.type, name: displayName(file, id), parentId, rect: worldRect(file, id)!, rotation: node.styles.rotation ?? 0, clip: node.type === 'frame' && node.styles.overflow !== 'visible', depth, order: order++, flow: false, locked: nodeIsLocked(file, id) })
    }
    for (const child of childrenOf(file, id)) visit(child, id, depth + 1)
  }
  for (const child of childrenOf(file, root)) visit(child, null, 0)
  return { nodes, byId: new Map(nodes.map(node => [node.id, node])) }
}

export function ancestors(scene: Scene, id: string): SceneNode[] {
  const path: SceneNode[] = []
  let current = scene.byId.get(id)
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) { visited.add(current.id); path.unshift(current); current = current.parentId ? scene.byId.get(current.parentId) : undefined }
  return path
}

export function descendants(scene: Scene, id: string): SceneNode[] {
  return scene.nodes.filter(node => node.id !== id && ancestors(scene, node.id).some(ancestor => ancestor.id === id))
}

function visibleAt(scene: Scene, node: SceneNode, point: Point): boolean {
  if (!pointInRect(point, node.rect)) return false
  return ancestors(scene, node.id).every(ancestor => ancestor.id === node.id || !ancestor.clip || pointInRect(point, ancestor.rect))
}

/** Nodes under a world point, top-most first. Children paint above parents and later siblings above earlier ones. */
export function hitTest(scene: Scene, point: Point): SceneNode[] {
  return scene.nodes.filter(node => !node.locked && visibleAt(scene, node, point)).sort((left, right) => right.order - left.order)
}

/**
 * Wonder observed: a click from no selection picks the direct child of the containing root (the artboard level);
 * a click inside a selected ancestor drills one level below it; Ctrl/Cmd picks the deepest node.
 */
export function clickTarget(scene: Scene, point: Point, selection: readonly string[], deep: boolean): SceneNode | null {
  const top = hitTest(scene, point)[0]
  if (!top) return null
  if (deep) return top
  const path = ancestors(scene, top.id)
  let anchor = -1
  for (let index = path.length - 1; index >= 0; index--) if (selection.includes(path[index]!.id)) { anchor = index; break }
  return path[Math.min(anchor >= 0 ? anchor + 1 : 1, path.length - 1)] ?? top
}

/** Double-click drills one level deeper than the current click target along the hit path. */
export function drillTarget(scene: Scene, point: Point, selection: readonly string[]): SceneNode | null {
  const top = hitTest(scene, point)[0]
  if (!top) return null
  const path = ancestors(scene, top.id)
  let anchor = -1
  for (let index = path.length - 1; index >= 0; index--) if (selection.includes(path[index]!.id)) { anchor = index; break }
  return path[Math.min(anchor + 1, path.length - 1)] ?? top
}

/** Marquee: roots that intersect the brush; deep mode considers every node. */
export function marqueeTargets(scene: Scene, brush: Rect, deep: boolean): string[] {
  return scene.nodes.filter(node => !node.locked && (deep || node.parentId === null) && rectsIntersect(node.rect, brush)).map(node => node.id)
}

export function symmetricDifference(base: readonly string[], toggled: readonly string[]): string[] {
  const result = base.filter(id => !toggled.includes(id))
  for (const id of toggled) if (!base.includes(id)) result.push(id)
  return result
}

export function childrenOfScene(scene: Scene, id: string): SceneNode[] {
  return scene.nodes.filter(node => node.parentId === id).sort((left, right) => left.order - right.order)
}
export { childrenOfScene as childrenOf }

export function selectChildren(scene: Scene, selection: readonly string[]): string[] {
  const next = selection.flatMap(id => childrenOfScene(scene, id).map(child => child.id))
  return next.length ? [...new Set(next)] : [...selection]
}

export function selectParents(scene: Scene, selection: readonly string[]): string[] {
  const parents = selection.map(id => scene.byId.get(id)?.parentId).filter((id): id is string => typeof id === 'string')
  return parents.length ? [...new Set(parents)] : [...selection]
}

/** Deepest frame whose rectangle contains the point, excluding a subtree. Component nodes do not accept primitive children. */
export function containingFrameAt(scene: Scene, point: Point, excludedId?: string): SceneNode | null {
  return hitTest(scene, point).find(node => node.kind === 'frame' && node.id !== excludedId && !(excludedId && ancestors(scene, node.id).some(ancestor => ancestor.id === excludedId))) ?? null
}
