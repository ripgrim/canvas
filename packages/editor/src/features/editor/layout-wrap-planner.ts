import { childrenOf, descendantsOf, nodeChildDisplay, nodePositionMode } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, NodeWrapGroup, PrimitiveNode } from '@canvas/repo-engine/file-document'
import { inferFlexLayout } from '@canvas/repo-engine/flex-inference'
import type { FlexInference } from '@canvas/repo-engine/flex-inference'
import { apply } from '@canvas/repo-engine/layout-matrix'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import type { PositionMode } from '@canvas/repo-engine/layout'
import { reconcilePaperSizing } from '@canvas/repo-engine/paper-sizing'
import type { PaperSizingCapabilities } from '@canvas/repo-engine/paper-sizing'
import { paperWrapGeometry } from './layout-measure'
import type { LayoutGeometry } from './layout-measure'

export const paperWrapCopy = {
  empty: 'Select at least one layer to wrap in flex.',
  missing: 'Wrap could not find every selected layer in this document.',
  root: 'A page root cannot be wrapped.',
  topology: 'Wrap currently supports unslotted canvas layers whose parent is the page or a frame.',
  nested: 'Wrap cannot include both a layer and one of its descendants.',
  geometry: 'Wrap needs current canvas measurements. Wait for the canvas to finish updating, then try again.',
  sizing: 'Wrap needs complete current sizing information. Wait for the canvas to finish updating, then try again.',
  identity: 'Wrap could not create a unique frame identity. Try again.',
  write: 'Wrap could not change this document. Confirm that you can edit it, then try again.',
} as const

export type PaperWrapFailureReason = keyof typeof paperWrapCopy
export type PaperWrapPlan = Readonly<{
  status: 'ready'
  command: Extract<FileCommand, { type: 'node.wrap' }>
  wrapperIds: readonly string[]
}>
export type PaperWrapFailure = Readonly<{ status: 'unavailable'; reason: PaperWrapFailureReason; message: string }>
export type PaperWrapPlanResult = PaperWrapPlan | PaperWrapFailure

export type PaperWrapSnapshot = Readonly<{
  file: FileDocument
  geometry: LayoutGeometry
  selection: readonly string[]
  layoutGeneration: number
  makeId: () => string
}>

const failure = (reason: PaperWrapFailureReason): PaperWrapFailure => ({ status: 'unavailable', reason, message: paperWrapCopy[reason] })
const px = (value: number) => ({ kind: 'px' as const, value })
const primitiveFlowCapabilities: PaperSizingCapabilities = {
  width: { fit: true, fill: true, relative: true, constrained: true },
  height: { fit: true, fill: true, relative: true, constrained: true },
}
const textFlowCapabilities: PaperSizingCapabilities = {
  width: { fit: true, fill: true, relative: true, constrained: false },
  height: { fit: true, fill: true, relative: true, constrained: false },
}

function treeOrder(file: FileDocument): string[] {
  const result: string[] = []
  const visit = (parentId: string) => {
    for (const id of childrenOf(file, parentId)) {
      result.push(id)
      visit(id)
    }
  }
  for (const page of file.pages) visit(page.rootNodeId)
  return result
}

function averageCenters(rects: readonly { x: number; y: number; width: number; height: number }[]): { x: number; y: number } {
  const sum = rects.reduce((value, rect) => ({ x: value.x + rect.x + rect.width / 2, y: value.y + rect.y + rect.height / 2 }), { x: 0, y: 0 })
  return { x: sum.x / rects.length, y: sum.y / rects.length }
}

function wrapperOrigin(inference: FlexInference, worldToParentPadding: Matrix, isRoot: boolean): { x: number; y: number } {
  const source = averageCenters(inference.synthetic.children.map(child => child.worldAabb))
  const synthetic = averageCenters(inference.synthetic.children.map(child => child.synthetic))
  const world = { x: source.x - synthetic.x, y: source.y - synthetic.y }
  return isRoot ? world : apply(worldToParentPadding, world)
}

type PendingGroup = Readonly<{
  parentId: string
  children: NodeWrapGroup['children']
  inference: FlexInference
  placement: PositionMode
  origin: { x: number; y: number }
}>

/**
 * Pure Paper Wrap planner. It consumes one immutable document/selection/geometry projection, validates every group
 * before allocating wrapper identities, and returns one closed semantic command without mutating any input.
 */
export function planPaperWrap(snapshot: PaperWrapSnapshot): PaperWrapPlanResult {
  const { file, geometry, layoutGeneration, makeId } = snapshot
  if (!snapshot.selection.length) return failure('empty')
  const unique = [...new Set(snapshot.selection)]
  if (unique.some(id => !file.nodes[id])) return failure('missing')
  if (unique.some(id => file.nodes[id]?.type === 'root')) return failure('root')
  if (unique.some(id => descendantsOf(file, id).some(descendant => unique.includes(descendant)))) return failure('nested')

  const order = treeOrder(file)
  const orderIndex = new Map(order.map((id, index) => [id, index]))
  if (unique.some(id => !orderIndex.has(id))) return failure('missing')
  const selected = unique.sort((left, right) => orderIndex.get(left)! - orderIndex.get(right)!)
  const byParent = new Map<string, string[]>()
  for (const id of selected) {
    const node = file.nodes[id]!
    const relationship = file.relationships[id]
    const parent = relationship ? file.nodes[relationship.parentId] : undefined
    if (node.type === 'component' || !relationship || relationship.slot !== undefined || !parent || (parent.type !== 'root' && parent.type !== 'frame')) return failure('topology')
    const ids = byParent.get(relationship.parentId) ?? []
    ids.push(id)
    byParent.set(relationship.parentId, ids)
  }

  const pending: PendingGroup[] = []
  for (const [parentId, ids] of byParent) {
    const selectedSet = new Set(ids)
    const children = childrenOf(file, parentId).filter(id => selectedSet.has(id)).map(id => file.nodes[id]!)
    if (children.length !== ids.length || children.some(node => node.type === 'root' || node.type === 'component')) return failure('topology')
    const wrapGeometry = paperWrapGeometry(file, geometry, parentId, children.map(node => node.id), layoutGeneration)
    if (!wrapGeometry) return failure('geometry')
    const inference = inferFlexLayout(wrapGeometry.input)
    if (inference.order.length !== children.length || new Set(inference.order).size !== children.length || inference.order.some(nodeId => !children.some(node => node.id === nodeId))) return failure('sizing')
    const targetChildren: NodeWrapGroup['children'] = []
    try {
      for (const nodeId of inference.order) {
        const sizing = wrapGeometry.childSnapshots[nodeId]
        if (!sizing) return failure('sizing')
        const target = reconcilePaperSizing({
          operation: 'wrap',
          snapshot: sizing,
          targetPosition: { mode: 'flow' },
          targetParent: { display: 'flex', flexDirection: inference.direction },
          capabilities: sizing.kind === 'text' ? textFlowCapabilities : primitiveFlowCapabilities,
        })
        targetChildren.push({
          nodeId,
          targetLayout: target.layout,
          ...(target.styles ? { targetPrimitiveSize: target.styles } : {}),
          ...(target.textProperties ? { targetTextProperties: target.textProperties } : {}),
        })
      }
    } catch {
      return failure('sizing')
    }
    if (targetChildren.length !== children.length) return failure('sizing')
    const modes = children.map(node => nodePositionMode(node))
    if (modes.some(mode => mode === null)) return failure('topology')
    const allAbsolute = modes.every(mode => mode === 'absolute')
    const parent = file.nodes[parentId]!
    const placement: PositionMode = allAbsolute ? 'absolute' : parent.type === 'root' || nodeChildDisplay(parent) === 'freeform' ? 'freeform' : 'flow'
    const origin = placement === 'flow' ? { x: 0, y: 0 } : wrapperOrigin(inference, wrapGeometry.worldToParentPadding, parent.type === 'root')
    pending.push({ parentId, children: targetChildren, inference, placement, origin })
  }

  const wrapperIds: string[] = []
  const reserved = new Set(Object.keys(file.nodes))
  for (let index = 0; index < pending.length; index++) {
    const id = makeId()
    if (!id || reserved.has(id)) return failure('identity')
    reserved.add(id)
    wrapperIds.push(id)
  }

  const groups: NodeWrapGroup[] = pending.map((group, index) => {
    const { container } = group.inference.synthetic
    const position = group.placement === 'absolute'
      ? { mode: 'absolute' as const, left: px(group.origin.x), top: px(group.origin.y) }
      : { mode: group.placement }
    const wrapper: PrimitiveNode & { type: 'frame' } = {
      id: wrapperIds[index]!,
      type: 'frame',
      name: 'Frame',
      styles: { relativeTransform: [1, 0, 0, 1, group.placement === 'flow' ? 0 : group.origin.x, group.placement === 'flow' ? 0 : group.origin.y], width: container.width, height: container.height, overflow: 'visible' },
      layout: {
        item: { position },
        container: { display: 'flex', gap: group.inference.gap, flex: { direction: group.inference.direction, wrap: 'nowrap', justify: 'start', align: group.inference.align } },
      },
    }
    return {
      wrapper,
      parentId: group.parentId,
      children: group.children,
    }
  })
  return { status: 'ready', command: { type: 'node.wrap', groups }, wrapperIds }
}
