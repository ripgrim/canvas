import { useRef, useState, useSyncExternalStore } from 'react'
import { getNodeSlots } from '@canvas/repo-engine/document'
import { acceptsChild, childrenOf, descendantsOf, nodeIsLocked, pageRoot } from '@canvas/repo-engine/file-document'
import { Button, Layout, Text } from '../../design-system/atoms'
import type { IconName } from '../../design-system/atoms'
import { DocumentLayerItem, DocumentSlotTarget, DocumentTree } from '../../design-system/canvas-atoms'
import { canvasCopy as copy } from './canvas-copy'
import { displayName } from './canvas-scene'
import { documentStore as store } from './document-store'
import { NodeContextMenu } from './NodeContextMenu'
import { layerTreeIndent, layerTreeRowHeight, layerTreeScrollStep, resolveLayerTreeDrop, surpassedLayerTreeThreshold } from './layer-tree-gesture'
import type { LayerTreeDrop, LayerTreeRow } from './layer-tree-gesture'

const icons: Record<string, IconName> = { frame: 'frame', rectangle: 'rectangle', shape: 'shape', shader: 'shader', text: 'text', component: 'component' }
const slotRowId = (parentId: string, slot: string) => `slot:${parentId}:${slot}`
type VisibleRow = LayerTreeRow & Readonly<{ kind: 'node'; nodeId: string } | { kind: 'slot'; label: string }>
type DragSession = { pointerId: number; startX: number; startY: number; previousY: number; previousTime: number; nodeIds: string[]; affectedIds: string[]; dragged: boolean; altKey: boolean; drop: LayerTreeDrop | null; tree: HTMLDivElement }
type DragView = Readonly<{ nodeIds: readonly string[]; targetId: string | null; drop: LayerTreeDrop | null; altKey: boolean }> | null

/** The layer sidebar owns a pointer gesture, then submits one validated document command at pointer-up. */
export function DocumentLayers({ readOnly = false }: { readOnly?: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [renamingLayer, setRenamingLayer] = useState<string | null>(null)
  const [dragView, setDragView] = useState<DragView>(null)
  const session = useRef<DragSession | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverTarget = useRef<string | null>(null)
  const scrollFrame = useRef<number | null>(null)
  const scrollStep = useRef(0)
  const ignoreClickId = useRef<string | null>(null)
  const file = state.file
  const root = file && state.pageId ? pageRoot(file, state.pageId) : null
  if (!file || !root) return <Layout roleName="library-content"><Text roleName="muted">{copy.empty}</Text></Layout>

  const stopHover = () => { if (hoverTimer.current !== null) clearTimeout(hoverTimer.current); hoverTimer.current = null; hoverTarget.current = null }
  const stopScroll = () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; scrollStep.current = 0 }
  const finishGesture = () => { stopHover(); stopScroll(); session.current = null; setDragView(null) }
  const setAutoScroll = (tree: HTMLDivElement, step: number) => {
    scrollStep.current = step
    if (!step) { stopScroll(); return }
    if (scrollFrame.current !== null) return
    const tick = () => { if (!session.current || !scrollStep.current) { scrollFrame.current = null; return }; tree.scrollTop += scrollStep.current; scrollFrame.current = requestAnimationFrame(tick) }
    scrollFrame.current = requestAnimationFrame(tick)
  }
  const toggle = (id: string, recursive = false) => setCollapsed(current => { const closing = !current.includes(id); const targets = recursive ? [id, ...descendantsOf(file, id)] : [id]; return closing ? [...new Set([...current, ...targets])] : current.filter(item => !targets.includes(item)) })
  const beginRename = (id: string) => { store.select(id); setRenamingLayer(id) }
  const rows: VisibleRow[] = []
  const visit = (id: string, depth: number, hierarchyParentId: string) => {
    const node = file.nodes[id]
    const relationship = file.relationships[id]
    if (!node || node.type === 'root' || !relationship) return
    const expanded = !collapsed.includes(id)
    const childIds = childrenOf(file, id)
    rows.push({ kind: 'node', id, nodeId: id, depth, parentId: hierarchyParentId, placementParentId: relationship.parentId, ...(relationship.slot ? { slot: relationship.slot } : {}), acceptsDrop: node.type === 'frame', expanded, childIds })
    if (!expanded) return
    if (node.type === 'component') {
      const atom = state.atoms.find(item => item.componentId === node.componentId)
      for (const slot of atom ? getNodeSlots(atom) : []) {
        const slotId = slotRowId(id, slot)
        const children = childrenOf(file, id, slot)
        rows.push({ kind: 'slot', id: slotId, label: copy.slotName(slot), depth: depth + 1, parentId: id, placementParentId: id, insideParentId: id, insideSlot: slot, slot, acceptsDrop: true, expanded: true, childIds: children })
        for (const child of children) visit(child, depth + 2, slotId)
      }
      return
    }
    for (const child of childIds) visit(child, depth + 1, id)
  }
  for (const id of childrenOf(file, root)) visit(id, 0, root)
  const nodeRows = rows.filter((row): row is VisibleRow & { kind: 'node'; nodeId: string } => row.kind === 'node')
  const targetRows = (draggedIds: readonly string[]) => rows.map(row => {
    const targetParentId = row.kind === 'slot' ? row.insideParentId! : row.nodeId
    const targetSlot = row.kind === 'slot' ? row.insideSlot : undefined
    const parent = file.nodes[targetParentId]
    const legal = Boolean(parent && draggedIds.every(id => id !== targetParentId && !descendantsOf(file, id).includes(targetParentId) && acceptsChild(parent, file.nodes[id]!, targetSlot, state.atoms)))
    return { ...row, acceptsDrop: legal }
  })
  const scheduleExpand = (targetId: string | null) => {
    if (hoverTarget.current === targetId) return
    stopHover()
    const row = rows.find(candidate => candidate.id === targetId)
    if (!row || row.kind !== 'node' || row.expanded || !row.childIds.length) return
    hoverTarget.current = targetId
    hoverTimer.current = setTimeout(() => { setCollapsed(current => current.filter(id => id !== targetId)); stopHover() }, 600)
  }
  const pointerDown = (id: string) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (readOnly || event.button !== 0 || renamingLayer) return
    const additive = event.ctrlKey || event.metaKey
    const range = event.shiftKey
    const wasSelected = state.selection.includes(id)
    if (!wasSelected || additive || range) store.select(id, { additive, range })
    const selected = wasSelected && !additive && !range ? state.selection : additive ? (wasSelected ? state.selection.filter(item => item !== id) : [...state.selection, id]) : [id]
    const roots = selected.filter(candidate => !selected.some(other => other !== candidate && descendantsOf(file, other).includes(candidate)))
    const affectedIds = [...new Set(roots.flatMap(candidate => [candidate, ...descendantsOf(file, candidate)]))]
    const tree = event.currentTarget.closest('[role="tree"]') as HTMLDivElement | null
    if (!tree || !roots.length) return
    tree.focus({ preventScroll: true })
    ignoreClickId.current = id
    session.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, previousY: event.clientY, previousTime: event.timeStamp, nodeIds: roots, affectedIds, dragged: false, altKey: event.altKey, drop: null, tree }
  }
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = session.current
    if (!active || active.pointerId !== event.pointerId) return
    const elapsed = Math.max(1, event.timeStamp - active.previousTime)
    const velocity = Math.abs(event.clientY - active.previousY) / elapsed * 16
    active.previousY = event.clientY
    active.previousTime = event.timeStamp
    active.altKey = event.altKey
    if (!active.dragged && !surpassedLayerTreeThreshold(active.startX, active.startY, event.clientX, event.clientY)) return
    if (!active.dragged) active.tree.setPointerCapture(event.pointerId)
    active.dragged = true
    event.preventDefault()
    const treeRect = active.tree.getBoundingClientRect()
    setAutoScroll(active.tree, layerTreeScrollStep(event.clientY, treeRect.top, treeRect.bottom))
    const hit = document.elementFromPoint(treeRect.left + 2, event.clientY)?.closest<HTMLElement>('[data-layer-row-id]')
    const targetId = hit?.dataset.layerRowId ?? null
    const targetRect = hit?.getBoundingClientRect()
    const drop = targetId && targetRect ? resolveLayerTreeDrop(targetRows(active.nodeIds), targetId, event.clientY - targetRect.top, targetRect.height, event.clientX - active.startX, velocity) : null
    active.drop = drop
    scheduleExpand(drop?.mode === 'inside' ? drop.targetId : null)
    setDragView({ nodeIds: active.affectedIds, targetId: drop?.mode === 'inside' ? drop.targetId : null, drop, altKey: active.altKey })
  }
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = session.current
    if (!active || active.pointerId !== event.pointerId) return
    if (active.dragged && active.drop) store.commands.layerTreeDrop(active.nodeIds, { parentId: active.drop.parentId === root ? null : active.drop.parentId, ...(active.drop.slot ? { slot: active.drop.slot } : {}), index: active.drop.index, duplicate: event.altKey })
    else if (state.selection.length > 1) { const row = (event.target as HTMLElement).closest<HTMLElement>('[data-layer-node-id]'); if (row?.dataset.layerNodeId && state.selection.includes(row.dataset.layerNodeId)) store.select(row.dataset.layerNodeId) }
    finishGesture()
  }
  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>) => { if (session.current?.pointerId === event.pointerId) finishGesture() }
  const traverseRename = (id: string, direction: 'next' | 'previous', value: string) => { store.commands.rename(id, value); const index = nodeRows.findIndex(row => row.nodeId === id); const offset = direction === 'next' ? 1 : -1; setRenamingLayer(nodeRows[(index + offset + nodeRows.length) % nodeRows.length]?.nodeId ?? null) }
  const treeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && session.current) { event.preventDefault(); finishGesture(); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r' && state.selection.length === 1) { event.preventDefault(); beginRename(state.selection[0]!) }
  }
  const indicator = dragView?.drop && dragView.drop.mode !== 'inside' ? (() => { const index = rows.findIndex(row => row.id === dragView.drop!.targetId); return { top: (index + (dragView.drop!.mode === 'after' ? 1 : 0)) * layerTreeRowHeight - 1, left: dragView.drop!.depth * layerTreeIndent + 20 } })() : null

  return <Layout roleName="component-list">
    <DocumentTree label={copy.layers} indicator={indicator} copying={dragView?.altKey === true} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onKeyDown={treeKeyDown}>
      {rows.map(row => row.kind === 'slot'
        ? <DocumentSlotTarget key={row.id} rowId={row.id} label={row.label} depth={row.depth} dropTarget={dragView?.targetId === row.id} />
        : (() => {
          const node = file.nodes[row.nodeId]!
          if (node.type === 'root') return null
          const name = displayName(file, row.nodeId)
          const visible = node.appearance?.visible !== false
          const directlyLocked = node.isLocked === true
          const locked = nodeIsLocked(file, row.nodeId)
          const inheritedLock = locked && !directlyLocked
          return <DocumentLayerItem key={row.id} id={row.nodeId} name={name} toggleLabel={row.expanded ? copy.collapse(name) : copy.expand(name)} depth={row.depth} selected={state.selection.includes(row.nodeId)} expanded={row.expanded} childrenCount={row.childIds.length} visible={visible} locked={locked} directlyLocked={directlyLocked} showLabel={copy.showLayer(name)} hideLabel={copy.hideLayer(name)} lockLabel={inheritedLock ? copy.lockedByParent(name) : directlyLocked ? copy.unlockLayer(name) : copy.lockLayer(name)} lockDisabled={readOnly || inheritedLock} visibilityDisabled={readOnly} icon={icons[node.type]!} {...(dragView ? { dragging: dragView.nodeIds.includes(row.nodeId), dropTarget: dragView.targetId === row.id } : {})} renaming={!readOnly && renamingLayer === row.nodeId} renameLabel={copy.renameLabel(name)} onSelect={modifiers => { if (ignoreClickId.current === row.nodeId) { ignoreClickId.current = null; return }; store.select(row.nodeId, modifiers) }} onToggle={recursive => toggle(row.nodeId, recursive)} onVisibilityChange={next => { if (!readOnly) store.commands.appearance.setBlending([row.nodeId], { visible: next }) }} onLockChange={next => { if (!readOnly && !inheritedLock) store.commands.setLocked(row.nodeId, next) }} {...(!locked ? { onPointerDown: pointerDown(row.nodeId) } : {})} onIconDoubleClick={() => { store.select(row.nodeId); store.requestFit('selection') }} onRename={() => beginRename(row.nodeId)} onRenameCommit={value => { store.commands.rename(row.nodeId, value); setRenamingLayer(null) }} onRenameCancel={() => setRenamingLayer(null)} onRenameTraverse={(direction, value) => traverseRename(row.nodeId, direction, value)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!state.selection.includes(row.nodeId)) store.select(row.nodeId); setRenamingLayer(null); setContextMenu({ x: event.clientX, y: event.clientY }) }} />
        })())}
    </DocumentTree>
    {state.blocked && state.error && <Layout roleName="canvas-status" aria-live="polite"><Text>{state.error}</Text><Button onClick={() => store.retryPersistence()}>{copy.retry}</Button></Layout>}
    {!readOnly && contextMenu && <NodeContextMenu position={contextMenu} onRename={beginRename} onClose={() => setContextMenu(null)} />}
  </Layout>
}
