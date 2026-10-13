/**
 * Pure final-gesture planning. The caller supplies one immutable document/scene/measurement snapshot and the fences
 * captured at pointer down. Nothing is allocated until every requested target has passed structural and geometry
 * preflight, and the returned command is replayed through repository history before it is exposed.
 */
import { acceptsChild, applyFileCommand, applyFileCommandWithHistory, childrenOf, descendantsOf, nodeChildDisplay, nodeIsLocked, nodePositionMode, pageOfNode, validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, FileNode, NodeResizePresentationEntry, NodeResizeState } from '@canvas/repo-engine/file-document'
import type { LayoutItem, NodeLayout } from '@canvas/repo-engine/layout'
import { applyDefiniteMainAxis } from '@canvas/repo-engine/layout'
import type { Atom } from './types'
import type { Rect } from './canvas-math'
import type { Scene, SceneNode } from './canvas-scene'
import type { GestureAuthoritySnapshot, ResizeGeometryAuthority } from './gesture-authority'
import { paperFlowAbsoluteDropGeometry, paperFlowCrossParentAbsoluteDropGeometry, resizeGeometryAuthority } from './layout-measure'
import { projectResizePresentation } from './resize-projection'
import type { ResizePresentation, ResizePresentationItem, ResizeProjectionSample } from './resize-projection'
import type { MeasuredNode, SceneGeometry } from './scene-geometry'
import { validFlowDragState } from './flow-drag-state'
import type { FlowDragSourceRelationship, PaperFlowDragState } from './flow-drag-state'
import { resolveFlowDragTarget } from './flow-drag-target'

export type GestureStartFence = Readonly<{
  fileId: string
  fileRevision: number
  measurementRevision: number
  documentRevision: number
  layoutGeneration: number
}>

export type ParentLocalRect = Readonly<Rect & { coordinateSpace: 'parent-padding' }>

type PlacementIntent = Readonly<{ parentId: string; slot?: string; index: number }>
export type GestureFinalIntent =
  | Readonly<{ kind: 'resize'; nodeId: string; authority: ResizeGeometryAuthority; sample: ResizeProjectionSample }>
  | Readonly<{
    kind: 'clone-source-and-move-original'
    nodeId: string
    sourcePlacement: PlacementIntent
    clone: Readonly<{ mode: 'flow' }> | Readonly<{ mode: 'absolute'; rect: ParentLocalRect }>
    original: Readonly<{ mode: 'flow'; placement: PlacementIntent }> | Readonly<{ mode: 'absolute'; parentId: string; rect: ParentLocalRect }>
  }>
  | Readonly<{ kind: 'absolute-drop'; nodeId: string; parentId: string; rect: ParentLocalRect }>
  | Readonly<{ kind: 'reorder'; nodeId: string; placement: PlacementIntent }>
  | Readonly<{
    kind: 'paper-flow-terminal'
    nodeId: string
    selection: readonly [string]
    sourceRelationship: FlowDragSourceRelationship
    sourceIndex: number
    target: NonNullable<PaperFlowDragState['target']>
    mode: 'flow' | 'absolute'
    rect: ParentLocalRect | null
    clone: Readonly<{ generation: number; mode: 'flow' | 'absolute'; rect: ParentLocalRect | null }> | null
    state: PaperFlowDragState
  }>

export type GestureCommandSnapshot = Readonly<{
  file: FileDocument
  atoms: readonly Atom[]
  scene: Scene
  geometry: SceneGeometry
  /** Current editor layout generation. It must still equal the pointer-down fence and the accepted measurement. */
  layoutGeneration: number
  start: GestureStartFence
}>

export type GestureCommandPlan = Readonly<{
  command: FileCommand
  selection: readonly string[]
  /** Source subtree id to allocated subtree id, keyed by each duplicated root. */
  duplicateIds: Readonly<Record<string, Readonly<Record<string, string>>>>
}>

type AbsolutePreflight = Readonly<{ kind: 'absolute-drop'; nodeId: string; parentId: string; rect: ParentLocalRect }>
type CloneMovePreflight = Readonly<{
  kind: 'clone-source-and-move-original'
  nodeId: string
  sourceIds: readonly string[]
  sourcePlacement: PlacementIntent
  clone: Readonly<{ mode: 'flow' }> | Readonly<{ mode: 'absolute'; rect: ParentLocalRect }>
  original: Readonly<{ mode: 'flow'; placement: PlacementIntent }> | Readonly<{ mode: 'absolute'; parentId: string; rect: ParentLocalRect }>
}>
type ReorderPreflight = Readonly<{ kind: 'reorder'; nodeId: string; placement: PlacementIntent }>
type ResizePreflight = Readonly<{ kind: 'resize'; nodeId: string; presentation: ResizePresentation }>
type PaperFlowPreflight = Readonly<{
  kind: 'paper-flow-terminal'
  nodeId: string
  sourceIds: readonly string[]
  sourceRelationship: FlowDragSourceRelationship
  sourceIndex: number
  target: NonNullable<PaperFlowDragState['target']>
  mode: 'flow' | 'absolute'
  rect: ParentLocalRect | null
  sourceRect: ParentLocalRect | null
  clone: Readonly<{ generation: number; mode: 'flow' | 'absolute'; rect: ParentLocalRect | null }> | null
}>
type Preflight = ResizePreflight | CloneMovePreflight | AbsolutePreflight | ReorderPreflight | PaperFlowPreflight

const coordinateLimit = 1_000_000
const finiteWithin = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= coordinateLimit
const exactRect = (value: unknown): value is ParentLocalRect => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).sort().join(',') === 'coordinateSpace,height,width,x,y'
    && record.coordinateSpace === 'parent-padding'
    && finiteWithin(record.x) && finiteWithin(record.y) && finiteWithin(record.width) && finiteWithin(record.height)
    && (record.width as number) > 0 && (record.height as number) > 0
}
const sameNumber = (left: number, right: number) => Math.abs(left - right) < 1e-9
const sameRect = (left: Rect, right: Rect) => sameNumber(left.x, right.x) && sameNumber(left.y, right.y) && sameNumber(left.width, right.width) && sameNumber(left.height, right.height)
const sameSlot = (left: string | undefined, right: string | undefined) => left === right
const groupKey = (parentId: string, slot: string | undefined) => `${parentId}\u0000${slot ?? ''}`
const px = (value: number) => ({ kind: 'px' as const, value })

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord), rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]))
}

function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true
  if (seen.has(value)) return true
  if (!Object.isFrozen(value)) return false
  seen.add(value)
  return Object.values(value as Record<string, unknown>).every(child => deeplyFrozen(child, seen))
}

function exactResizeSample(value: unknown): value is ResizeProjectionSample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const sample = value as Record<string, unknown>
  if (Object.keys(sample).sort().join(',') !== 'affectedAxes,contentLocked,coordinateSpace,effectiveHandle,rect') return false
  if (!sample.rect || typeof sample.rect !== 'object' || Array.isArray(sample.rect) || Object.keys(sample.rect).sort().join(',') !== 'height,width,x,y') return false
  return sample.coordinateSpace === 'parent-padding'
    && typeof sample.contentLocked === 'boolean'
    && Array.isArray(sample.affectedAxes)
    && typeof sample.effectiveHandle === 'string'
}

function exactResizeIntent(value: GestureFinalIntent): value is Extract<GestureFinalIntent, { kind: 'resize' }> {
  return value.kind === 'resize' && Object.keys(value).sort().join(',') === 'authority,kind,nodeId,sample'
}

function resizeSnapshot(snapshot: GestureCommandSnapshot): snapshot is GestureAuthoritySnapshot {
  const candidate = snapshot as Partial<GestureAuthoritySnapshot>
  return typeof candidate.pageId === 'string'
    && Array.isArray(candidate.selection)
    && Boolean(candidate.camera && finiteWithin(candidate.camera.x) && finiteWithin(candidate.camera.y) && finiteWithin(candidate.camera.zoom) && candidate.camera.zoom > 0)
    && Boolean(candidate.size && finiteWithin(candidate.size.width) && finiteWithin(candidate.size.height) && candidate.size.width > 0 && candidate.size.height > 0)
}

function exactProjection(snapshot: GestureCommandSnapshot, measurement: MeasuredNode | undefined): measurement is MeasuredNode & { offset: NonNullable<MeasuredNode['offset']> } {
  return Boolean(
    measurement?.offset
    && measurement.documentRevision === snapshot.file.revision
    && measurement.layoutGeneration === snapshot.layoutGeneration
    && finiteWithin(measurement.offset.x) && finiteWithin(measurement.offset.y)
    && finiteWithin(measurement.offset.width) && finiteWithin(measurement.offset.height)
    && measurement.offset.width > 0 && measurement.offset.height > 0,
  )
}

function directGeometry(snapshot: GestureCommandSnapshot, nodeId: string, parentId: string): { node: Exclude<FileNode, { type: 'root' }>; scene: SceneNode; measurement: MeasuredNode & { offset: NonNullable<MeasuredNode['offset']> } } | null {
  const node = snapshot.file.nodes[nodeId]
  const parent = snapshot.file.nodes[parentId]
  const relationship = snapshot.file.relationships[nodeId]
  const scene = snapshot.scene.byId.get(nodeId)
  const measurement = snapshot.geometry.nodes[nodeId]
  if (!node || node.type === 'root' || !parent || !relationship || relationship.parentId !== parentId || !scene || !exactProjection(snapshot, measurement)) return null
  if (measurement.directChild !== true) return null
  const expectedOffsetParent = parent.type === 'root' ? null : parentId
  if (measurement.offsetParentNodeId === undefined || measurement.offsetParentNodeId !== expectedOffsetParent) return null
  if (node.type === 'component') {
    if (measurement.componentId !== node.componentId) return null
    const expectedComponentParent = parent.type === 'component' ? parentId : null
    if (measurement.parentInstanceId === undefined || measurement.parentInstanceId !== expectedComponentParent) return null
  } else if (measurement.canvasKind !== node.type) return null
  const expectedSceneParent = parent.type === 'root' ? null : parentId
  if (scene.parentId !== expectedSceneParent || scene.kind !== node.type || scene.locked !== nodeIsLocked(snapshot.file, nodeId)) return null
  if (scene.flow !== (nodePositionMode(node) === 'flow') || !sameRect(scene.rect, measurement.rect)) return null
  return { node, scene, measurement }
}

function parentGeometry(snapshot: GestureCommandSnapshot, parentId: string): boolean {
  const relationship = snapshot.file.relationships[parentId]
  const parent = snapshot.file.nodes[parentId]
  if (!parent) return false
  if (parent.type === 'root') return true
  return Boolean(relationship && directGeometry(snapshot, parentId, relationship.parentId))
}

function cleanAbsoluteLayout(node: Exclude<FileNode, { type: 'root' }>, rect: ParentLocalRect): NodeLayout {
  const source = node.layout
  const item: LayoutItem = {
    ...(source?.item ?? { position: { mode: 'flow' as const } }),
    position: { mode: 'absolute', left: px(rect.x), top: px(rect.y) },
  }
  delete item.flex
  delete item.grid
  if (node.type === 'component') {
    item.width = { ...(source?.item.width ?? {}), value: px(rect.width) }
    item.height = { ...(source?.item.height ?? {}), value: px(rect.height) }
  } else {
    delete item.width
    delete item.height
  }
  return { item, ...(source?.container ? { container: structuredClone(source.container) } : {}), ...(source?.spacing?.padding !== undefined ? { spacing: { padding: structuredClone(source.spacing.padding) } } : {}) }
}

function cleanRootFreeformLayout(node: Exclude<FileNode, { type: 'root' | 'component' }>): NodeLayout {
  const source = node.layout
  const item: LayoutItem = { ...(source?.item ?? { position: { mode: 'flow' as const } }), position: { mode: 'freeform' } }
  delete item.flex
  delete item.grid
  delete item.width
  delete item.height
  return { item, ...(source?.container ? { container: structuredClone(source.container) } : {}), ...(source?.spacing?.padding !== undefined ? { spacing: { padding: structuredClone(source.spacing.padding) } } : {}) }
}

function appendAbsoluteCommands(commands: FileCommand[], nodeId: string, node: Exclude<FileNode, { type: 'root' }>, rect: ParentLocalRect) {
  commands.push({ type: 'node.setLayout', nodeId, layout: cleanAbsoluteLayout(node, rect) })
  if (node.type === 'component') return
  commands.push({ type: 'node.setStyles', nodeId, styles: { width: rect.width, height: rect.height } })
  if (node.type === 'text') {
    const textStyle = structuredClone(node.textStyle!)
    delete textStyle.maxLines
    commands.push({ type: 'node.setTextProperties', nodeId, textStyle, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } } })
  }
}

function checkedRelationshipProjection(file: FileDocument, nodeId: string, placement: PlacementIntent, atoms: readonly Atom[]): { file: FileDocument; command: Extract<FileCommand, { type: 'node.restoreRelationship' }> } | null {
  const expected = file.relationships[nodeId]
  if (!expected) return null
  let projected: FileDocument
  try { projected = applyFileCommand(file, { type: 'node.reparent', nodeId, placement }, [...atoms], { allowUnavailableBindings: true }) } catch { return null }
  const source = projected.relationships[nodeId]
  if (!source) return null
  const command = { type: 'node.restoreRelationship' as const, nodeId, expected: structuredClone(expected), source: structuredClone(source) }
  try { return { file: applyFileCommand(file, command, [...atoms], { allowUnavailableBindings: true }), command } } catch { return null }
}

function absolutePresentationEntry(file: FileDocument, nodeId: string, rect: ParentLocalRect): NodeResizePresentationEntry | null {
  const node = file.nodes[nodeId]
  const relationship = file.relationships[nodeId]
  if (!node || node.type === 'root' || !relationship || !exactRect(rect)) return null
  const parent = file.nodes[relationship.parentId]
  if (!parent) return null
  const rootPrimitive = parent.type === 'root' && node.type !== 'component'
  const expected: NodeResizeState = { nodeId, relationship: structuredClone(relationship) }
  const source: NodeResizeState = { nodeId, relationship: structuredClone(relationship) }
  expected.layout = node.layout === undefined ? null : structuredClone(node.layout)
  source.layout = rootPrimitive ? cleanRootFreeformLayout(node) : cleanAbsoluteLayout(node, rect)
  if (node.type !== 'component') {
    expected.primitiveGeometry = { left: node.styles.left, top: node.styles.top, width: node.styles.width, height: node.styles.height }
    source.primitiveGeometry = { left: rootPrimitive ? rect.x : node.styles.left, top: rootPrimitive ? rect.y : node.styles.top, width: rect.width, height: rect.height }
    if (node.type === 'text') {
      if (!node.textStyle || !node.textSizing) return null
      const textStyle = structuredClone(node.textStyle)
      delete textStyle.maxLines
      expected.textProperties = { textStyle: structuredClone(node.textStyle), textSizing: structuredClone(node.textSizing) }
      source.textProperties = { textStyle, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } } }
    }
  }
  return { expected, source }
}

function applyAbsoluteProjection(file: FileDocument, nodeId: string, rect: ParentLocalRect, atoms: readonly Atom[]): { file: FileDocument; command: Extract<FileCommand, { type: 'node.resizePresentation' }> } | null {
  const entry = absolutePresentationEntry(file, nodeId, rect)
  if (!entry) return null
  const command = { type: 'node.resizePresentation' as const, entries: [entry] }
  try { return { file: applyFileCommand(file, command, [...atoms], { allowUnavailableBindings: true }), command } } catch { return null }
}

function duplicateFeasible(file: FileDocument, nodeId: string, sourceIds: readonly string[], atoms: readonly Atom[]): boolean {
  const ids: Record<string, string> = {}
  const assigned = new Set(Object.keys(file.nodes))
  for (const [index, sourceId] of sourceIds.entries()) {
    let salt = 0
    let id = `gesture-preflight-${index}-${salt}`
    while (assigned.has(id)) { salt += 1; id = `gesture-preflight-${index}-${salt}` }
    assigned.add(id)
    ids[sourceId] = id
  }
  try {
    applyFileCommand(file, { type: 'node.duplicate', nodeId, ids }, [...atoms], { allowUnavailableBindings: true })
    return true
  } catch { return false }
}

function stableDocument(file: FileDocument): string {
  const copy = structuredClone(file)
  copy.revision = 0
  return JSON.stringify(copy)
}

function resizeAbsoluteLayout(node: Exclude<FileNode, { type: 'root' }>, item: ResizePresentationItem, widthChanged: boolean, heightChanged: boolean): NodeLayout | null {
  const layout = node.layout
  const position = layout?.item.position
  if (!layout || position?.mode !== 'absolute' || position.left?.kind !== 'px' || position.top?.kind !== 'px' || position.right !== undefined || position.bottom !== undefined) return null
  const nextItem: LayoutItem = { ...structuredClone(layout.item), position: { mode: 'absolute', left: px(item.rect.x), top: px(item.rect.y) } }
  if (node.type === 'component') {
    if (widthChanged) nextItem.width = { ...(layout.item.width ?? {}), value: px(item.rect.width) }
    if (heightChanged) nextItem.height = { ...(layout.item.height ?? {}), value: px(item.rect.height) }
  } else if (layout.item.width !== undefined || layout.item.height !== undefined || layout.item.aspectRatio !== undefined || layout.item.flex !== undefined || layout.item.grid !== undefined) return null
  return {
    item: nextItem,
    ...(layout.container !== undefined ? { container: structuredClone(layout.container) } : {}),
    ...(layout.spacing !== undefined ? { spacing: structuredClone(layout.spacing) } : {}),
  }
}

function resizeFlowLayout(snapshot: GestureCommandSnapshot, node: Exclude<FileNode, { type: 'root' }>, parentId: string, item: ResizePresentationItem, widthChanged: boolean, heightChanged: boolean): NodeLayout | null {
  const source = node.layout
  if (nodePositionMode(node) !== 'flow' || source?.item.position.mode === 'absolute') return null
  let nextItem: LayoutItem = structuredClone(source?.item ?? { position: { mode: 'flow' as const } })
  const parent = snapshot.file.nodes[parentId]
  const flex = parent && parent.type !== 'root' && parent.layout?.container?.display === 'flex' ? parent.layout.container.flex : undefined
  const direction = flex?.direction
  const setAxis = (axis: 'width' | 'height', changed: boolean, value: number) => {
    if (!changed) return
    if (node.type === 'component') nextItem[axis] = { ...(nextItem[axis] ?? {}), value: px(value) }
    else delete nextItem[axis]
    if (direction && (direction.startsWith('row') ? axis === 'width' : axis === 'height')) {
      const definite = node.type === 'component' ? nextItem : { ...nextItem, [axis]: { value: px(value) } }
      nextItem = applyDefiniteMainAxis(definite, direction)
      if (node.type !== 'component') delete nextItem[axis]
    }
  }
  setAxis('width', widthChanged, item.rect.width)
  setAxis('height', heightChanged, item.rect.height)
  const next: NodeLayout = {
    item: nextItem,
    ...(source?.container !== undefined ? { container: structuredClone(source.container) } : {}),
    ...(source?.spacing !== undefined ? { spacing: structuredClone(source.spacing) } : {}),
  }
  return next
}

function resizeFreeformPrimitiveLayout(node: Exclude<FileNode, { type: 'root' | 'component' }>, widthChanged: boolean, heightChanged: boolean): NodeLayout | null {
  const source = node.layout
  if (!source) return null
  if (source.item.position.mode !== 'freeform' || source.item.aspectRatio !== undefined || source.item.flex !== undefined || source.item.grid !== undefined) return null
  const item = structuredClone(source.item)
  if (widthChanged) delete item.width
  if (heightChanged) delete item.height
  return {
    item,
    ...(source.container !== undefined ? { container: structuredClone(source.container) } : {}),
    ...(source.spacing !== undefined ? { spacing: structuredClone(source.spacing) } : {}),
  }
}

function resizeEntry(snapshot: GestureCommandSnapshot, presentation: ResizePresentation, item: ResizePresentationItem): NodeResizePresentationEntry | 'unchanged' | null {
  const node = snapshot.file.nodes[item.nodeId]
  const relationship = snapshot.file.relationships[item.nodeId]
  if (!node || node.type === 'root' || !relationship || relationship.parentId !== item.parentId || item.coordinateSpace !== 'parent-padding') return null
  const widthChanged = !sameNumber(item.startRect.width, item.rect.width)
  const heightChanged = !sameNumber(item.startRect.height, item.rect.height)
  if (presentation.contentLocked && item.nodeId !== presentation.selectedNodeId && (widthChanged || heightChanged)) return null
  const expected: NodeResizeState = { nodeId: node.id, relationship: structuredClone(relationship) }
  const source: NodeResizeState = { nodeId: node.id, relationship: structuredClone(relationship) }
  const mode = nodePositionMode(node)
  if (node.type === 'component') {
    const layout = mode === 'flow'
      ? resizeFlowLayout(snapshot, node, relationship.parentId, item, widthChanged, heightChanged)
      : mode === 'absolute'
        ? resizeAbsoluteLayout(node, item, widthChanged, heightChanged)
        : null
    if (!layout || !node.layout) return null
    expected.layout = structuredClone(node.layout)
    source.layout = layout
  } else {
    if (mode !== 'flow' && mode !== 'freeform' && mode !== 'absolute') return null
    expected.primitiveGeometry = { left: node.styles.left, top: node.styles.top, width: node.styles.width, height: node.styles.height }
    source.primitiveGeometry = {
      left: mode === 'flow' ? node.styles.left : item.rect.x,
      top: mode === 'flow' ? node.styles.top : item.rect.y,
      width: item.rect.width,
      height: item.rect.height,
    }
    if (mode === 'flow') {
      const layout = resizeFlowLayout(snapshot, node, relationship.parentId, item, widthChanged, heightChanged)
      if (!layout) return null
      expected.layout = node.layout === undefined ? null : structuredClone(node.layout)
      source.layout = layout
    } else if (mode === 'freeform') {
      expected.layout = node.layout === undefined ? null : structuredClone(node.layout)
      source.layout = node.layout === undefined ? null : resizeFreeformPrimitiveLayout(node, widthChanged, heightChanged)
      if (source.layout === null && node.layout !== undefined) return null
    } else {
      const layout = resizeAbsoluteLayout(node, item, widthChanged, heightChanged)
      if (!layout || !node.layout) return null
      expected.layout = structuredClone(node.layout)
      source.layout = layout
    }
    if (node.type === 'text' && (widthChanged || heightChanged)) {
      if (!node.textStyle || !node.textSizing) return null
      const nextStyle = structuredClone(node.textStyle)
      const nextSizing = structuredClone(node.textSizing)
      if (widthChanged) nextSizing.width = { mode: 'fixed' }
      if (heightChanged) {
        nextSizing.height = { mode: 'fixed' }
        delete nextStyle.maxLines
      }
      expected.textProperties = { textStyle: structuredClone(node.textStyle), textSizing: structuredClone(node.textSizing) }
      source.textProperties = { textStyle: nextStyle, textSizing: nextSizing }
    }
  }
  if (item.appearance !== undefined && !sameValue(node.appearance ?? null, item.appearance)) {
    expected.appearance = structuredClone(node.appearance ?? null)
    source.appearance = structuredClone(item.appearance)
  }
  if (sameValue(expected, source)) return 'unchanged'
  return { expected, source }
}

function resizeCommand(snapshot: GestureCommandSnapshot, presentation: ResizePresentation): Extract<FileCommand, { type: 'node.resizePresentation' }> | null {
  if (!presentation.items.length || presentation.items[0]?.nodeId !== presentation.selectedNodeId) return null
  const entries: NodeResizePresentationEntry[] = []
  for (const item of presentation.items) {
    const entry = resizeEntry(snapshot, presentation, item)
    if (!entry) return null
    if (entry === 'unchanged') continue
    entries.push(entry)
  }
  if (!entries.length) return null
  return { type: 'node.resizePresentation', entries }
}

function closesHistory(snapshot: GestureCommandSnapshot, command: FileCommand): boolean {
  try {
    const history = applyFileCommandWithHistory(snapshot.file, command, [...snapshot.atoms], { allowUnavailableBindings: true })
    const undone = applyFileCommand(history.file, history.undo, [...snapshot.atoms], { allowUnavailableBindings: true })
    if (stableDocument(undone) !== stableDocument(snapshot.file)) return false
    const redone = applyFileCommand(undone, history.redo, [...snapshot.atoms], { allowUnavailableBindings: true })
    return stableDocument(redone) === stableDocument(history.file)
  } catch { return false }
}

function validFence(snapshot: GestureCommandSnapshot): boolean {
  const { file, geometry, start } = snapshot
  if (file.fileId !== start.fileId || file.revision !== start.fileRevision) return false
  if (geometry.revision !== start.measurementRevision || geometry.documentRevision !== start.documentRevision) return false
  if (start.documentRevision !== file.revision || snapshot.layoutGeneration !== start.layoutGeneration || geometry.layoutGeneration !== start.layoutGeneration) return false
  try { validateFileDocument(file, [...snapshot.atoms], { allowUnavailableBindings: true }) } catch { return false }
  return true
}

function preflight(snapshot: GestureCommandSnapshot, intents: readonly GestureFinalIntent[]): Preflight[] | null {
  if (!validFence(snapshot) || intents.length === 0 || intents.length > 100) return null
  const result: Preflight[] = []
  const nodes = new Set<string>()
  const groups = new Set<string>()
  const duplicateTrees: string[][] = []
  for (const intent of intents) {
    if (!intent || typeof intent !== 'object' || nodes.has(intent.nodeId) || duplicateTrees.some(tree => tree.includes(intent.nodeId))) return null
    nodes.add(intent.nodeId)
    if (intent.kind === 'resize') {
      if (!exactResizeIntent(intent)) return null
      if (intents.length !== 1 || intent.nodeId !== intent.authority?.nodeId || !deeplyFrozen(intent.authority) || !exactResizeSample(intent.sample) || !resizeSnapshot(snapshot)) return null
      const derived = resizeGeometryAuthority(snapshot, intent.nodeId)
      if (!derived || !sameValue(derived, intent.authority)) return null
      const presentation = projectResizePresentation(snapshot, intent.authority, intent.sample)
      if (!presentation || presentation.selectedNodeId !== intent.nodeId) return null
      result.push({ kind: 'resize', nodeId: intent.nodeId, presentation })
      continue
    }
    if (intent.kind === 'paper-flow-terminal') {
      if (intents.length !== 1 || !resizeSnapshot(snapshot) || !deeplyFrozen(intent) || !validFlowDragState(intent.state) || intent.state.kind !== 'paper-flow-drag') return null
      const state = intent.state
      if (state.nodeId !== intent.nodeId || state.selection[0] !== intent.nodeId || intent.selection.length !== 1 || intent.selection[0] !== intent.nodeId) return null
      if (snapshot.selection.length !== 1 || snapshot.selection[0] !== intent.nodeId || pageOfNode(snapshot.file, intent.nodeId) !== snapshot.pageId) return null
      if (!state.thresholdCrossed || !state.target || !sameValue(state.sourceRelationship, intent.sourceRelationship) || state.sourceIndex !== intent.sourceIndex
        || state.originalMode !== intent.mode || !sameValue(state.target, intent.target)) return null
      const relationship = snapshot.file.relationships[intent.nodeId]
      const node = snapshot.file.nodes[intent.nodeId]
      if (!relationship || !node || node.type === 'root' || nodePositionMode(node) !== 'flow' || nodeIsLocked(snapshot.file, intent.nodeId)) return null
      const sourceRelationship: FlowDragSourceRelationship = { parentId: relationship.parentId, orderKey: relationship.orderKey,
        slot: Object.hasOwn(relationship, 'slot') ? { presence: 'present', value: relationship.slot! } : { presence: 'absent' } }
      if (!sameValue(sourceRelationship, intent.sourceRelationship)) return null
      const sourceSiblings = childrenOf(snapshot.file, relationship.parentId, relationship.slot)
      if (sourceSiblings[intent.sourceIndex] !== intent.nodeId) return null
      const resolved = resolveFlowDragTarget({ authority: snapshot, state, hoveredNodeId: intent.target.parentId })
      if (!resolved || !sameValue(resolved, intent.target) || pageOfNode(snapshot.file, intent.target.parentId) !== snapshot.pageId) return null
      const targetSlot = intent.target.slotPresence === 'present' ? { slot: intent.target.slotValue! } : {}
      const derivedRect = intent.mode === 'absolute'
        ? intent.target.parentId === relationship.parentId
          ? paperFlowAbsoluteDropGeometry({ file: snapshot.file, scene: snapshot.scene, geometry: snapshot.geometry, fence: snapshot.start,
            childId: intent.nodeId, parentId: relationship.parentId, pointerDownWorld: state.pointerDownWorld, terminalWorld: state.currentWorld })
          : paperFlowCrossParentAbsoluteDropGeometry({ snapshot, childId: intent.nodeId, targetParentId: intent.target.parentId,
            ...targetSlot, pointerDownWorld: state.pointerDownWorld, terminalWorld: state.currentWorld })
        : null
      if (intent.mode === 'absolute' ? !derivedRect || !intent.rect || !sameRect(derivedRect, intent.rect) : intent.rect !== null) return null
      if ((state.clone === null) !== (intent.clone === null)) return null
      if (state.clone && intent.clone) {
        if (state.clone.generation !== intent.clone.generation || state.clone.entryMode !== intent.clone.mode) return null
        const cloneRect = state.clone.entryMode === 'absolute'
          ? paperFlowAbsoluteDropGeometry({ file: snapshot.file, scene: snapshot.scene, geometry: snapshot.geometry, fence: snapshot.start,
            childId: intent.nodeId, parentId: relationship.parentId, pointerDownWorld: state.pointerDownWorld, terminalWorld: state.clone.startedAtWorld })
          : null
        if (state.clone.entryMode === 'absolute'
          ? !cloneRect || !state.clone.entryGeometry || !intent.clone.rect || !sameRect(cloneRect, state.clone.entryGeometry) || !sameRect(cloneRect, intent.clone.rect)
          : intent.clone.rect !== null || state.clone.entryGeometry !== null) return null
      }
      if (!intent.clone && intent.mode === 'flow' && intent.target.parentId === relationship.parentId
        && intent.target.slotPresence === intent.sourceRelationship.slot.presence
        && (intent.target.slotPresence === 'absent' || intent.sourceRelationship.slot.presence === 'present' && intent.target.slotValue === intent.sourceRelationship.slot.value)
        && intent.target.semanticIndex === intent.sourceIndex) return null
      const sourceIds = [intent.nodeId, ...descendantsOf(snapshot.file, intent.nodeId)]
      if (sourceIds.some(id => id !== intent.nodeId && snapshot.file.nodes[id]?.type !== 'root' && snapshot.file.nodes[id]?.isLocked === true)) return null
      if (intent.clone && !duplicateFeasible(snapshot.file, intent.nodeId, sourceIds, snapshot.atoms)) return null
      const sourceRect = intent.mode === 'absolute' && snapshot.file.nodes[intent.target.parentId]?.type === 'root'
        ? paperFlowAbsoluteDropGeometry({ file: snapshot.file, scene: snapshot.scene, geometry: snapshot.geometry, fence: snapshot.start,
          childId: intent.nodeId, parentId: relationship.parentId, pointerDownWorld: state.pointerDownWorld, terminalWorld: state.currentWorld })
        : null
      if (intent.mode === 'absolute' && snapshot.file.nodes[intent.target.parentId]?.type === 'root' && !sourceRect) return null
      result.push({ kind: intent.kind, nodeId: intent.nodeId, sourceIds, sourceRelationship, sourceIndex: intent.sourceIndex,
        target: intent.target, mode: intent.mode, rect: intent.rect, sourceRect, clone: intent.clone })
      continue
    }
    const relationship = snapshot.file.relationships[intent.nodeId]
    const node = snapshot.file.nodes[intent.nodeId]
    const parent = relationship ? snapshot.file.nodes[relationship.parentId] : undefined
    if (!relationship || !node || node.type === 'root' || !parent) return null
    if (!acceptsChild(parent, node, relationship.slot, [...snapshot.atoms])) return null
    if (nodeIsLocked(snapshot.file, intent.nodeId) || nodeIsLocked(snapshot.file, relationship.parentId)) return null
    const measured = directGeometry(snapshot, intent.nodeId, relationship.parentId)
    if (!measured || !parentGeometry(snapshot, relationship.parentId)) return null

    if (intent.kind === 'clone-source-and-move-original') {
      const sourcePlacement = intent.sourcePlacement
      const siblings = childrenOf(snapshot.file, relationship.parentId, relationship.slot)
      if (
        !intent.clone
        || typeof intent.clone !== 'object'
        || !intent.original
        || typeof intent.original !== 'object'
        || !sourcePlacement
        || sourcePlacement.parentId !== relationship.parentId
        || !sameSlot(sourcePlacement.slot, relationship.slot)
        || !Number.isInteger(sourcePlacement.index)
        || sourcePlacement.index !== siblings.indexOf(intent.nodeId)
      ) return null
      if (nodePositionMode(node) !== 'flow' || nodeChildDisplay(parent) !== 'flex') return null
      if (node.layout?.spacing?.margin !== undefined) return null
      if (intent.clone.mode !== 'flow' && intent.clone.mode !== 'absolute') return null
      if (intent.clone.mode === 'absolute' && (!exactRect(intent.clone.rect) || !sameNumber(intent.clone.rect.width, measured.measurement.offset.width) || !sameNumber(intent.clone.rect.height, measured.measurement.offset.height))) return null
      if (intent.original.mode === 'flow') {
        const target = intent.original.placement
        if (target.parentId !== relationship.parentId || !sameSlot(target.slot, relationship.slot) || !Number.isInteger(target.index) || target.index < 0 || target.index > siblings.length) return null
      } else if (intent.original.mode === 'absolute') {
        if (intent.original.parentId !== relationship.parentId || !exactRect(intent.original.rect) || !sameNumber(intent.original.rect.width, measured.measurement.offset.width) || !sameNumber(intent.original.rect.height, measured.measurement.offset.height)) return null
      } else return null
      const key = groupKey(relationship.parentId, relationship.slot)
      if (groups.has(key)) return null
      groups.add(key)
      const sourceIds = [intent.nodeId, ...descendantsOf(snapshot.file, intent.nodeId)]
      if (sourceIds.some(id => id !== intent.nodeId && nodes.has(id))) return null
      if (sourceIds.some(id => snapshot.file.nodes[id]?.type !== 'root' && snapshot.file.nodes[id]?.isLocked === true)) return null
      if (duplicateTrees.some(tree => tree.some(id => sourceIds.includes(id)))) return null
      duplicateTrees.push(sourceIds)
      result.push({ kind: intent.kind, nodeId: intent.nodeId, sourceIds, sourcePlacement, clone: intent.clone, original: intent.original })
      continue
    }

    if (intent.kind === 'absolute-drop') {
      if (intent.parentId !== relationship.parentId || !exactRect(intent.rect)) return null
      if (nodePositionMode(node) !== 'flow' || nodeChildDisplay(snapshot.file.nodes[intent.parentId]!) !== 'flex') return null
      if (!sameNumber(intent.rect.width, measured.measurement.offset.width) || !sameNumber(intent.rect.height, measured.measurement.offset.height)) return null
      if (node.layout?.spacing?.margin !== undefined) return null
      const key = groupKey(intent.parentId, relationship.slot)
      if (groups.has(key)) return null
      groups.add(key)
      result.push({ kind: intent.kind, nodeId: intent.nodeId, parentId: intent.parentId, rect: intent.rect })
      continue
    }

    const placement = intent.placement
    if (!placement || placement.parentId !== relationship.parentId || !sameSlot(placement.slot, relationship.slot) || !Number.isInteger(placement.index)) return null
    const siblings = childrenOf(snapshot.file, placement.parentId, placement.slot)
    if (placement.index < 0 || placement.index >= siblings.length) return null
    const key = groupKey(placement.parentId, placement.slot)
    if (groups.has(key)) return null
    groups.add(key)

    if (nodePositionMode(node) !== 'flow' || nodeChildDisplay(snapshot.file.nodes[placement.parentId]!) !== 'flex') return null
    if (siblings.indexOf(intent.nodeId) === placement.index) return null
    result.push({ kind: intent.kind, nodeId: intent.nodeId, placement })
  }
  return result
}

/**
 * Returns one history-closed command or null. `allocateId` is called only after the complete intent list passes
 * preflight, in deterministic intent and subtree pre-order.
 */
export function planGestureCommand(snapshot: GestureCommandSnapshot, intents: readonly GestureFinalIntent[], allocateId: (sourceId: string) => string): GestureCommandPlan | null {
  const validated = preflight(snapshot, intents)
  if (!validated) return null
  const resize = validated.length === 1 && validated[0]?.kind === 'resize' ? validated[0] : null
  if (resize) {
    const command = resizeCommand(snapshot, resize.presentation)
    if (!command || !closesHistory(snapshot, command)) return null
    return { command, selection: [resize.nodeId], duplicateIds: {} }
  }
  const paper = validated.length === 1 && validated[0]?.kind === 'paper-flow-terminal' ? validated[0] : null
  if (paper) {
    const duplicateIds: Record<string, Record<string, string>> = {}
    const assigned = new Set(Object.keys(snapshot.file.nodes))
    let ids: Record<string, string> | null = null
    if (paper.clone) {
      ids = {}
      for (const sourceId of paper.sourceIds) {
        let id: string
        try { id = allocateId(sourceId) } catch { return null }
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || assigned.has(id)) return null
        assigned.add(id)
        ids[sourceId] = id
      }
      duplicateIds[paper.nodeId] = ids
    }
    const commands: FileCommand[] = []
    let working = snapshot.file
    if (paper.clone && ids) {
      const duplicate: Extract<FileCommand, { type: 'node.duplicate' }> = { type: 'node.duplicate', nodeId: paper.nodeId, ids }
      try { working = applyFileCommand(working, duplicate, [...snapshot.atoms], { allowUnavailableBindings: true }) } catch { return null }
      commands.push(duplicate)
    }
    const movingId = ids?.[paper.nodeId] ?? paper.nodeId
    const targetSlot = paper.target.slotPresence === 'present' ? { slot: paper.target.slotValue! } : {}
    const targetIndex = paper.clone ? paper.target.rawIndex : paper.target.semanticIndex
    if (snapshot.file.nodes[paper.target.parentId]?.type === 'root') {
      if (paper.mode !== 'absolute' || !paper.rect) return null
      if (!paper.sourceRect) return null
      const sourceAbsolute = applyAbsoluteProjection(working, movingId, paper.sourceRect, snapshot.atoms)
      if (!sourceAbsolute) return null
      working = sourceAbsolute.file
      commands.push(sourceAbsolute.command)
      const rootRelationship = checkedRelationshipProjection(working, movingId, { parentId: paper.target.parentId, index: targetIndex }, snapshot.atoms)
      if (!rootRelationship) return null
      working = rootRelationship.file
      commands.push(rootRelationship.command)
      const rootProjection = applyAbsoluteProjection(working, movingId, paper.rect, snapshot.atoms)
      if (!rootProjection) return null
      working = rootProjection.file
      commands.push(rootProjection.command)
    } else {
      const originalRelationship = checkedRelationshipProjection(working, movingId, { parentId: paper.target.parentId, ...targetSlot, index: targetIndex }, snapshot.atoms)
      if (!originalRelationship) return null
      working = originalRelationship.file
      if (!sameValue(originalRelationship.command.expected, originalRelationship.command.source)) commands.push(originalRelationship.command)
      if (paper.mode === 'absolute') {
        if (!paper.rect) return null
        const absoluteOriginal = applyAbsoluteProjection(working, movingId, paper.rect, snapshot.atoms)
        if (!absoluteOriginal) return null
        working = absoluteOriginal.file
        commands.push(absoluteOriginal.command)
      }
    }
    if (!commands.length) return null
    const command: FileCommand = commands.length === 1 ? commands[0]! : { type: 'batch', commands }
    if (!closesHistory(snapshot, command)) return null
    return { command, selection: [movingId], duplicateIds }
  }
  const duplicateIds: Record<string, Record<string, string>> = {}
  const assigned = new Set(Object.keys(snapshot.file.nodes))
  for (const intent of validated) {
    if (intent.kind !== 'clone-source-and-move-original') continue
    const ids: Record<string, string> = {}
    for (const sourceId of intent.sourceIds) {
      let id: string
      try { id = allocateId(sourceId) } catch { return null }
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || assigned.has(id)) return null
      assigned.add(id)
      ids[sourceId] = id
    }
    duplicateIds[intent.nodeId] = ids
  }

  const commands: FileCommand[] = []
  const selection: string[] = []
  for (const intent of validated) {
    if (intent.kind === 'reorder') {
      commands.push({ type: 'node.reorder', nodeId: intent.nodeId, index: intent.placement.index })
      selection.push(intent.nodeId)
      continue
    }
    if (intent.kind === 'absolute-drop') {
      const node = snapshot.file.nodes[intent.nodeId] as Exclude<FileNode, { type: 'root' }>
      appendAbsoluteCommands(commands, intent.nodeId, node, intent.rect)
      selection.push(intent.nodeId)
      continue
    }
    if (intent.kind === 'clone-source-and-move-original') {
      const ids = duplicateIds[intent.nodeId]!
      const copyId = ids[intent.nodeId]!
      commands.push({ type: 'node.duplicate', nodeId: intent.nodeId, ids })
      const node = snapshot.file.nodes[intent.nodeId] as Exclude<FileNode, { type: 'root' }>
      if (intent.original.mode === 'absolute') appendAbsoluteCommands(commands, copyId, node, intent.original.rect)
      else commands.push({ type: 'node.reorder', nodeId: copyId, index: intent.original.placement.index })
      selection.push(copyId)
      continue
    }
  }
  if (!commands.length) return null
  const command: FileCommand = { type: 'batch', commands }
  if (!closesHistory(snapshot, command)) return null
  return { command, selection, duplicateIds }
}
