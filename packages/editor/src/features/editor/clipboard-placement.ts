import { acceptsChild, ancestorsOf, nodeWorldTransform, pageOfNode, pageRoot } from '@canvas/repo-engine/file-document'
import type { FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import type { Point } from './canvas-math'
import { containsTransformedPoint } from '@canvas/repo-engine/transform-matrix'
import type { Atom } from './types'

export function nearestCompatiblePasteParent(
  file: FileDocument,
  pageId: string,
  selection: readonly string[],
  children: readonly FileNode[],
  atoms: readonly Atom[] = [],
  worldPoint?: Point,
  excludedParentIds: ReadonlySet<string> = new Set(),
): FileNode {
  const rootId = pageRoot(file, pageId)
  if (!rootId) throw new Error('Paste target page is missing')
  const candidates = selection.length === 1 ? [selection[0]!, ...ancestorsOf(file, selection[0]!)] : []
  for (const id of candidates) {
    if (excludedParentIds.has(id)) continue
    const parent = file.nodes[id]
    if (!parent || pageOfNode(file, id) !== pageId || !children.every(child => acceptsChild(parent, child, undefined, [...atoms]))) continue
    if (worldPoint && parent.type !== 'root' && (!('styles' in parent) || !containsTransformedPoint(nodeWorldTransform(file, parent.id), parent.styles, worldPoint))) continue
    return parent
  }
  return file.nodes[rootId]!
}
