import { useState, useSyncExternalStore } from 'react'
import { getNodeSlots } from '@canvas/repo-engine/document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { pageNodes } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import { Button, FieldLabel, Icon, Input, Layout, Popup, Text } from '../../design-system/atoms'
import { PropertySelect } from '../../design-system/property-atoms'
import type { PropertyOption } from '../../design-system/property-atoms'
import { documentStore } from './document-store'
import { componentInsertionPoint } from './document-store'
import type { InsertTarget } from './document-store'
import { propertiesCopy as copy } from './properties-copy'
import { componentDragMime, encodeComponentDrag } from './component-drag'
import { editorStore } from './store'
import { componentSyncQueue } from './component-sync-queue'

const syncCopy = {
  queuedForDesktop: 'Added.',
  setUpSync: 'Sync components',
  syncTitle: 'Sync components',
  sourceLocation: 'Source',
  syncDestination: 'Destination',
  queueSync: 'Sync',
  cancelSync: 'Cancel',
  syncQueued: 'Queued.',
  syncBridgeNeeded: 'Desktop sync is unavailable.',
} as const

export type ComponentDestination = { value: string; label: string; target: InsertTarget }

export function componentDestinations(file: FileDocument | null, pageId: string | null, atoms: Atom[]): ComponentDestination[] {
  const destinations: ComponentDestination[] = [{ value: 'root', label: copy.root, target: { parentId: null } }]
  if (!file || !pageId) return destinations
  const instances = pageNodes(file, pageId).map(id => file.nodes[id]!).filter((node): node is Extract<typeof node, { type: 'component' }> => node.type === 'component')
  const cards = instances.filter(node => node.exportName === 'Card')
  let cardIndex = 0
  for (const node of instances) {
    const atom = atoms.find(candidate => candidate.componentId === node.componentId)
    if (!atom) continue
    const name = node.exportName === 'Card' && cards.length > 1 ? `${node.exportName} ${++cardIndex}` : node.exportName
    for (const slot of getNodeSlots(atom)) {
      if (Object.hasOwn(node.props, slot)) continue
      destinations.push({ value: `${node.id}:${slot}`, label: copy.slotName(name, slot), target: { parentId: node.id, slot } })
    }
  }
  return destinations
}

export function ComponentLibrary({ atoms, documentAtoms = atoms }: { atoms: Atom[]; documentAtoms?: Atom[] }) {
  const { file, pageId, blocked } = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const editor = useSyncExternalStore(editorStore.subscribe, editorStore.getSnapshot, editorStore.getSnapshot)
  const [destination, setDestination] = useState('root')
  const [message, setMessage] = useState<string | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [sourceLocation, setSourceLocation] = useState('components/ui')
  const [syncDestination, setSyncDestination] = useState('packages/ui')
  const choices = componentDestinations(file, pageId, atoms)
  const active = choices.find(choice => choice.value === destination) ?? choices[0]!
  const options: PropertyOption[] = choices.map(choice => ({ value: choice.value, label: choice.label }))
  const insert = (componentId: string) => {
    if (!documentStore.setAtoms(documentAtoms)) { setMessage(copy.insertFailed); return }
    const inserted = documentStore.commands.insertAt(componentId, componentInsertionPoint(documentStore.getSnapshot()), active.target)
    if (inserted && file && editor.capabilities.runtime === 'browser') {
      componentSyncQueue.queueBrowserUse(file.fileId, componentId)
      setMessage(syncCopy.queuedForDesktop)
      return
    }
    setMessage(inserted ? null : copy.insertFailed)
  }
  const unresolved = file ? [...new Set(Object.values(file.nodes).flatMap(node => node.type === 'component' && !atoms.some(atom => atom.componentId === node.componentId && atom.status === 'bound') ? [node.componentId] : []))] : []
  const submitSync = () => { if (!file) return; void componentSyncQueue.submit({ fileId: file.fileId, componentIds: unresolved, sourceLocation: sourceLocation.trim(), destination: syncDestination.trim() }).then(queued => { setMessage(queued ? syncCopy.syncQueued : syncCopy.syncBridgeNeeded); if (queued) setSyncOpen(false) }) }
  return <Layout roleName="library-content">{editor.capabilities.runtime === 'desktop' && unresolved.length > 0 && <Button variant="outline" onClick={() => setSyncOpen(true)}>{syncCopy.setUpSync}</Button>}{atoms.length === 0 && <Text roleName="muted">{copy.empty}</Text>}{choices.length > 1 && <PropertySelect id="component-add-to" label={copy.addTo} value={active.value} options={options} onChange={setDestination} disabled={!file || blocked} />}<Layout roleName="component-list">{atoms.filter(atom => atom.kind === 'atom').map(atom => {
    const available = Boolean(file) && !blocked && atom.status === 'bound'
    return <Button key={atom.componentId} label={copy.add(atom.name)} draggable={available} disabled={!available} title={available ? copy.drag(atom.name) : copy.unavailable} onDragStart={event => { setMessage(null); event.dataTransfer.setData(componentDragMime, encodeComponentDrag({ componentId: atom.componentId, target: active.target })); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => insert(atom.componentId)}><Icon name="component" />{atom.name}</Button>
  })}</Layout>{message && <Layout roleName="canvas-status" role="status" aria-live="polite"><Text>{message}</Text></Layout>}<Popup open={syncOpen} onOpenChange={setSyncOpen} title={syncCopy.syncTitle} mode={editor.mode} closeLabel={syncCopy.cancelSync}><Layout roleName="stack"><FieldLabel htmlFor="component-sync-source">{syncCopy.sourceLocation}</FieldLabel><Input id="component-sync-source" label={syncCopy.sourceLocation} value={sourceLocation} onChange={event => setSourceLocation(event.currentTarget.value)} /></Layout><Layout roleName="stack"><FieldLabel htmlFor="component-sync-destination">{syncCopy.syncDestination}</FieldLabel><Input id="component-sync-destination" label={syncCopy.syncDestination} value={syncDestination} onChange={event => setSyncDestination(event.currentTarget.value)} /></Layout><Button variant="primary" disabled={!sourceLocation.trim() || !syncDestination.trim()} onClick={submitSync}>{syncCopy.queueSync}</Button></Popup></Layout>
}
