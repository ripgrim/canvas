import { useState, useSyncExternalStore } from 'react'
import { getNodeSlots } from '@canvas/repo-engine/document'
import { childrenOf, pageRoot } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { Button, Layout, Text } from '../../design-system/atoms'
import type { IconName } from '../../design-system/atoms'
import { DocumentLayerItem, DocumentSlotTarget, DocumentTree } from '../../design-system/canvas-atoms'
import { canvasCopy as copy } from './canvas-copy'
import { displayName } from './canvas-scene'
import { documentStore as store } from './document-store'
import { NodeContextMenu } from './NodeContextMenu'

const icons: Record<string, IconName> = { frame: 'frame', rectangle: 'rectangle', shape: 'shape', shader: 'shader', text: 'text', component: 'component' }

/** The layer tree reads the same identities, names, and hierarchy the canvas renders; selection is shared. */
export function DocumentLayers({ readOnly = false }: { readOnly?: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [renamingLayer, setRenamingLayer] = useState<string | null>(null)
  const file = state.file
  const root = file && state.pageId ? pageRoot(file, state.pageId) : null
  if (!file || !root) return <Layout roleName="library-content"><Text roleName="muted">{copy.empty}</Text></Layout>
  const toggle = (id: string) => setCollapsed(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  const beginRename = (id: string) => { store.select(id); setRenamingLayer(id) }
  /** Dropping onto a row places the dragged node right before it (same parent); dropping onto a frame nests inside it. */
  const dropBefore = (file: FileDocument, dragged: string, targetId: string) => {
    const relationship = file.relationships[targetId]
    const draggedNode = file.nodes[dragged]
    const targetNode = file.nodes[targetId]
    if (!relationship || !draggedNode || !targetNode || dragged === targetId) return
    if (draggedNode.type !== 'component' && targetNode.type === 'frame') { store.commands.reparent(dragged, targetId); return }
    if (draggedNode.type === 'component' && targetNode.type !== 'component' || draggedNode.type !== 'component' && targetNode.type === 'component') return
    const siblings = childrenOf(file, relationship.parentId, relationship.slot)
    store.commands.move(dragged, { parentId: relationship.parentId === root ? null : relationship.parentId, ...(relationship.slot ? { slot: relationship.slot } : {}), index: siblings.filter(id => id !== dragged).indexOf(targetId) })
  }
  const render = (id: string, depth: number): React.ReactNode => {
    const node = file.nodes[id]
    if (!node || node.type === 'root') return null
    const name = displayName(file, id)
    const expanded = !collapsed.includes(id)
    const common = { id, name, toggleLabel: expanded ? copy.collapse(name) : copy.expand(name), depth, selected: state.selection.includes(id), expanded, renaming: !readOnly && renamingLayer === id, renameLabel: copy.renameLabel(name), onSelect: (modifiers: { additive: boolean; range: boolean }) => store.select(id, modifiers), onToggle: () => toggle(id), ...(!readOnly ? { onRename: () => beginRename(id), onRenameCommit: (value: string) => { store.commands.rename(id, value); setRenamingLayer(null) }, onRenameCancel: () => setRenamingLayer(null), onDrop: (dragged: string) => dropBefore(file, dragged, id), onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); if (!state.selection.includes(id)) store.select(id); setRenamingLayer(null); setContextMenu({ x: event.clientX, y: event.clientY }) } } : {}) }
    if (node.type === 'component') {
      const atom = state.atoms.find(item => item.componentId === node.componentId)
      const slots = atom ? getNodeSlots(atom) : []
      const children = childrenOf(file, id)
      return <DocumentLayerItem key={id} {...common} childrenCount={slots.length || children.length}>
        {slots.map((slot: string) => <DocumentSlotTarget key={slot} label={copy.slotName(slot)} depth={depth + 1} {...(!readOnly ? { onDrop: (dragged: string) => { if (file.nodes[dragged]?.type === 'component') store.commands.move(dragged, { parentId: id, slot }) } } : {})}>{childrenOf(file, id, slot).map(child => render(child, depth + 1))}</DocumentSlotTarget>)}
      </DocumentLayerItem>
    }
    const children = childrenOf(file, id)
    return <DocumentLayerItem key={id} {...common} childrenCount={children.length} icon={icons[node.type]!}>{children.map(child => render(child, depth + 1))}</DocumentLayerItem>
  }
  return <Layout roleName="component-list"><DocumentTree label={copy.layers}>{childrenOf(file, root).map(id => render(id, 0))}</DocumentTree>{state.blocked && state.error && <Layout roleName="canvas-status" aria-live="polite"><Text>{state.error}</Text><Button onClick={() => store.retryPersistence()}>{copy.retry}</Button></Layout>}{!readOnly && contextMenu && <NodeContextMenu position={contextMenu} onRename={beginRename} onClose={() => setContextMenu(null)} />}</Layout>
}
