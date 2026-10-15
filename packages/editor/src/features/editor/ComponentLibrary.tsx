import { useState, useSyncExternalStore } from 'react'
import { getNodeSlots } from '@canvas/repo-engine/document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { pageNodes } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import { Button, Icon, Layout, Text } from '../../design-system/atoms'
import { PropertySelect } from '../../design-system/property-atoms'
import type { PropertyOption } from '../../design-system/property-atoms'
import { documentStore } from './document-store'
import { componentInsertionPoint } from './document-store'
import type { InsertTarget } from './document-store'
import { propertiesCopy as copy } from './properties-copy'
import { componentDragMime, encodeComponentDrag } from './component-drag'

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
  const [destination, setDestination] = useState('root')
  const [message, setMessage] = useState<string | null>(null)
  const choices = componentDestinations(file, pageId, atoms)
  const active = choices.find(choice => choice.value === destination) ?? choices[0]!
  const options: PropertyOption[] = choices.map(choice => ({ value: choice.value, label: choice.label }))
  const insert = (componentId: string) => {
    if (!documentStore.setAtoms(documentAtoms)) { setMessage(copy.insertFailed); return }
    const inserted = documentStore.commands.insertAt(componentId, componentInsertionPoint(documentStore.getSnapshot()), active.target)
    setMessage(inserted ? null : copy.insertFailed)
  }
  const kit = atoms.filter(atom => atom.kind === 'atom')
  return <Layout roleName="library-content"><Text roleName="strong">{copy.kit}</Text>{kit.length === 0 && <Text roleName="muted">{copy.empty}</Text>}{choices.length > 1 && <PropertySelect id="component-add-to" label={copy.addTo} value={active.value} options={options} onChange={setDestination} disabled={!file || blocked} />}<Layout roleName="component-list">{kit.map(atom => {
    const available = Boolean(file) && !blocked && atom.status === 'bound'
    return <Button key={atom.componentId} label={copy.add(atom.name)} draggable={available} disabled={!available} title={available ? copy.drag(atom.name) : copy.unavailable} onDragStart={event => { setMessage(null); event.dataTransfer.setData(componentDragMime, encodeComponentDrag({ componentId: atom.componentId, target: active.target })); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => insert(atom.componentId)}><Icon name="component" />{atom.name}</Button>
  })}</Layout>{message && <Layout roleName="canvas-status" role="status" aria-live="polite"><Text>{message}</Text></Layout>}</Layout>
}
