import { ancestorsOf, childrenOf, descendantsOf, pageRoot, worldPosition, worldRect } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import { legacyLayout } from '@canvas/repo-engine/layout'
import { unionRects } from './canvas-math'

export type LayerOrder = 'front' | 'back' | 'forward' | 'backward'

const selectionRoots = (file: FileDocument, ids: readonly string[]) => {
  const selected = new Set(ids.filter(id => Boolean(file.nodes[id]) && file.nodes[id]!.type !== 'root'))
  return [...selected].filter(id => !ancestorsOf(file, id).some(parent => selected.has(parent)))
}

export function duplicatePlan(file: FileDocument, ids: readonly string[], makeId: () => string, onTop: boolean): { commands: FileCommand[]; selection: string[] } {
  const commands: FileCommand[] = []
  const selection: string[] = []
  for (const nodeId of selectionRoots(file, ids)) {
    const subtree = [nodeId, ...descendantsOf(file, nodeId)]
    const mapped = Object.fromEntries(subtree.map(id => [id, makeId()]))
    const node = file.nodes[nodeId]!
    const placement = node.type === 'component' ? legacyLayout(node.layout) : null
    const width = placement ? placement.width ?? 0 : node.type === 'root' || node.type === 'component' ? 0 : node.styles.width
    const offset = !onTop && (!placement || placement.mode === 'absolute') ? { x: width + 20, y: 0 } : undefined
    commands.push({ type: 'node.duplicate', nodeId, ids: mapped, ...(offset ? { offset } : {}) })
    selection.push(mapped[nodeId]!)
  }
  return { commands, selection }
}

export function layerOrderPlan(file: FileDocument, ids: readonly string[], direction: LayerOrder): FileCommand[] {
  if (ids.length !== 1) return []
  const nodeId = ids[0]!
  const relationship = file.relationships[nodeId]
  if (!relationship) return []
  const siblings = childrenOf(file, relationship.parentId, relationship.slot)
  const current = siblings.indexOf(nodeId)
  if (current < 0) return []
  const index = direction === 'front' ? siblings.length - 1 : direction === 'back' ? 0 : direction === 'forward' ? Math.min(siblings.length - 1, current + 1) : Math.max(0, current - 1)
  return index === current ? [] : [{ type: 'node.reorder', nodeId, index }]
}

export function frameSelectionPlan(file: FileDocument, pageId: string, ids: readonly string[], makeId: () => string): { commands: FileCommand[]; selection: string[] } | null {
  const roots = selectionRoots(file, ids)
  if (!roots.length || roots.some(id => file.nodes[id]?.type === 'component')) return null
  const relationships = roots.map(id => file.relationships[id]).filter((item): item is NonNullable<typeof item> => Boolean(item))
  if (relationships.length !== roots.length) return null
  const firstRelationship = relationships[0]
  if (!firstRelationship) return null
  const parentId = firstRelationship.parentId
  if (relationships.some(item => item.parentId !== parentId || item.slot !== firstRelationship.slot)) return null
  const page = pageRoot(file, pageId)
  if (!page) return null
  const bounds = unionRects(roots.map(id => worldRect(file, id)).filter((rect): rect is NonNullable<typeof rect> => Boolean(rect)))
  if (!bounds) return null
  const parentWorld = parentId === page ? { x: 0, y: 0 } : worldPosition(file, parentId)
  const frameId = makeId()
  const frame: FileNode = { id: frameId, type: 'frame', name: 'Frame', styles: { left: Math.round(bounds.x - parentWorld.x), top: Math.round(bounds.y - parentWorld.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)), overflow: 'visible' } }
  const commands: FileCommand[] = [{ type: 'node.insert', node: frame, placement: { parentId } }]
  for (const nodeId of roots) commands.push({ type: 'node.reparent', nodeId, placement: { parentId: frameId }, preserveWorldPosition: true })
  return { commands, selection: [frameId] }
}

export function ungroupPlan(file: FileDocument, ids: readonly string[]): { commands: FileCommand[]; selection: string[] } | null {
  const frames = selectionRoots(file, ids).filter(id => file.nodes[id]?.type === 'frame')
  if (!frames.length || frames.length !== selectionRoots(file, ids).length) return null
  const commands: FileCommand[] = []
  const selection: string[] = []
  for (const frameId of frames) {
    const relationship = file.relationships[frameId]
    if (!relationship) return null
    for (const child of childrenOf(file, frameId)) {
      commands.push({ type: 'node.reparent', nodeId: child, placement: { parentId: relationship.parentId, ...(relationship.slot ? { slot: relationship.slot } : {}) }, preserveWorldPosition: true })
      selection.push(child)
    }
    commands.push({ type: 'node.delete', nodeIds: [frameId] })
  }
  return { commands, selection }
}
