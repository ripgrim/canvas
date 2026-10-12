import { childrenOf, descendantsOf, nodeChildDisplay } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, FileNode, NodeFlexState, NodeRemoveFlexGroup } from '@canvas/repo-engine/file-document'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import { reconcilePaperSizing } from '@canvas/repo-engine/paper-sizing'
import type { PaperSizingCapabilities, PaperSizingParent, PaperSizingSnapshot } from '@canvas/repo-engine/paper-sizing'
import * as layoutMeasure from './layout-measure'
import type { LayoutGeometry, PaperRemoveFlexGeometry } from './layout-measure'

export const paperRemoveFlexCopy = {
  empty: 'Select at least one Flex parent to remove Flex.',
  missing: 'Remove Flex could not find every selected layer in this document.',
  topology: 'Remove Flex needs non-overlapping Frame or Component Flex parents.',
  geometry: 'Remove Flex needs current canvas measurements. Wait for the canvas to finish updating, then try again.',
  sizing: 'Remove Flex needs complete current sizing information. Wait for the canvas to finish updating, then try again.',
  write: 'Remove Flex could not change this document. Confirm that you can edit it, then try again.',
} as const

export type PaperRemoveFlexFailureReason = keyof typeof paperRemoveFlexCopy
export type PaperRemoveFlexFailure = Readonly<{ status: 'unavailable'; reason: PaperRemoveFlexFailureReason; message: string }>
export type PaperRemoveFlexPlan = Readonly<{
  status: 'ready'
  command: Extract<FileCommand, { type: 'node.removeFlex' }>
  parentIds: readonly string[]
}>
export type PaperRemoveFlexPlanResult = PaperRemoveFlexPlan | PaperRemoveFlexFailure
export type PaperRemoveFlexSnapshot = Readonly<{
  file: FileDocument
  geometry: LayoutGeometry
  selection: readonly string[]
  layoutGeneration: number
}>

const failure = (reason: PaperRemoveFlexFailureReason): PaperRemoveFlexFailure => ({ status: 'unavailable', reason, message: paperRemoveFlexCopy[reason] })
const px = (value: number) => ({ kind: 'px' as const, value })
const primitiveCapabilities: PaperSizingCapabilities = {
  width: { fit: true, fill: true, relative: true, constrained: true },
  height: { fit: true, fill: true, relative: true, constrained: true },
}
const textCapabilities: PaperSizingCapabilities = {
  width: { fit: true, fill: true, relative: true, constrained: false },
  height: { fit: true, fill: true, relative: true, constrained: false },
}

function treeOrder(file: FileDocument): string[] {
  const ordered: string[] = []
  const visit = (parentId: string) => {
    for (const nodeId of childrenOf(file, parentId)) {
      ordered.push(nodeId)
      visit(nodeId)
    }
  }
  for (const page of file.pages) visit(page.rootNodeId)
  return ordered
}

function sizingParent(file: FileDocument, nodeId: string): PaperSizingParent | null {
  const relationship = file.relationships[nodeId]
  const parent = relationship ? file.nodes[relationship.parentId] : undefined
  if (!relationship || !parent) return null
  const display = nodeChildDisplay(parent)
  if (!display) return null
  if (display !== 'flex') return { display }
  const flexDirection = parent.type === 'root' ? undefined : parent.layout?.container?.flex?.direction
  return flexDirection ? { display, flexDirection } : null
}

function restoreUnrelatedItemAuthority(layout: NodeLayout, snapshot: PaperSizingSnapshot): NodeLayout {
  const sourceItem = snapshot.sourceLayout?.item
  const target = structuredClone(layout)
  if (sourceItem?.aspectRatio !== undefined) target.item.aspectRatio = sourceItem.aspectRatio
  if (sourceItem?.transform !== undefined) target.item.transform = structuredClone(sourceItem.transform)
  return target
}

function targetState(
  snapshot: PaperSizingSnapshot,
  relationship: NodeFlexState['relationship'],
  targetPosition: NodeLayout['item']['position'],
  targetParent: PaperSizingParent,
  capabilities: PaperSizingCapabilities,
  overrides?: Parameters<typeof reconcilePaperSizing>[0]['overrides'],
): NodeFlexState {
  const target = reconcilePaperSizing({ operation: 'remove', snapshot, targetPosition, targetParent, capabilities, ...(overrides ? { overrides } : {}) })
  return {
    nodeId: snapshot.nodeId,
    relationship: structuredClone(relationship),
    layout: target.layout,
    ...(target.styles ? { primitiveSize: target.styles } : {}),
    ...(target.textProperties ? { textProperties: target.textProperties } : {}),
  }
}

function parentState(file: FileDocument, parent: FileNode, captured: PaperRemoveFlexGeometry): NodeFlexState | null {
  if (parent.type !== 'frame' && parent.type !== 'component') return null
  const relationship = file.relationships[parent.id]
  const targetParent = sizingParent(file, parent.id)
  if (!relationship || !targetParent) return null
  const overrides: NonNullable<Parameters<typeof reconcilePaperSizing>[0]['overrides']> = {}
  if (captured.parentSnapshot.axes.width.intent === 'fit') overrides.width = { intent: 'fixed', fixedPx: captured.parentBorderBox.width }
  if (captured.parentSnapshot.axes.height.intent === 'fit') overrides.height = { intent: 'fixed', fixedPx: captured.parentBorderBox.height }
  const reconciled = targetState(
    captured.parentSnapshot,
    relationship,
    captured.parentSnapshot.sourcePosition,
    targetParent,
    primitiveCapabilities,
    Object.keys(overrides).length ? overrides : undefined,
  )
  const layout = restoreUnrelatedItemAuthority(reconciled.layout!, captured.parentSnapshot)
  delete layout.item.flex
  delete layout.item.grid
  const overflow = parent.layout?.container?.overflow
  layout.container = { display: 'freeform', ...(overflow !== undefined ? { overflow } : {}) }
  return { ...reconciled, layout }
}

function childState(captured: PaperRemoveFlexGeometry['flowChildren'][number]): NodeFlexState {
  return targetState(
    captured.snapshot,
    captured.sourceRelationship,
    { mode: 'absolute', left: px(captured.parentLocalPosition.x), top: px(captured.parentLocalPosition.y) },
    { display: 'freeform' },
    captured.snapshot.kind === 'text' ? textCapabilities : primitiveCapabilities,
  )
}

/** Pure Remove Flex planner. It validates every selected parent before returning one closed semantic command. */
export function planPaperRemoveFlex(snapshot: PaperRemoveFlexSnapshot): PaperRemoveFlexPlanResult {
  const { file, geometry, layoutGeneration } = snapshot
  if (!snapshot.selection.length) return failure('empty')
  const unique = [...new Set(snapshot.selection)]
  if (unique.some(nodeId => !file.nodes[nodeId])) return failure('missing')
  const order = treeOrder(file)
  const orderIndex = new Map(order.map((nodeId, index) => [nodeId, index]))
  if (unique.some(nodeId => !orderIndex.has(nodeId))) return failure('missing')
  const parentIds = unique.sort((left, right) => orderIndex.get(left)! - orderIndex.get(right)!)
  const selected = new Set(parentIds)
  for (const parentId of parentIds) {
    const parent = file.nodes[parentId]
    const relationship = file.relationships[parentId]
    if (!parent || (parent.type !== 'frame' && parent.type !== 'component') || !relationship || parent.layout?.container?.display !== 'flex' || !parent.layout.container.flex) return failure('topology')
    if (descendantsOf(file, parentId).some(nodeId => selected.has(nodeId))) return failure('topology')
  }

  const groups: NodeRemoveFlexGroup[] = []
  for (const parentId of parentIds) {
    const captured = layoutMeasure.paperRemoveFlexGeometry(file, geometry, parentId, layoutGeneration)
    if (!captured) return failure('geometry')
    try {
      const parent = parentState(file, file.nodes[parentId]!, captured)
      if (!parent) return failure('topology')
      groups.push({ parent, children: captured.flowChildren.map(childState) })
    } catch {
      return failure('sizing')
    }
  }
  return { status: 'ready', command: { type: 'node.removeFlex', groups }, parentIds }
}
