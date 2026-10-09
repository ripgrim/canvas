import { useState, useSyncExternalStore } from 'react'
import { getNodeSlots } from '@canvas/repo-engine/document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { pageNodes } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import { Button, Icon, Layout, Text } from '../../design-system/atoms'
import { PropertySelect } from '../../design-system/property-atoms'
import type { PropertyOption } from '../../design-system/property-atoms'
import { documentStore } from './document-store'
import type { InsertTarget } from './document-store'
import { propertiesCopy as copy } from './properties-copy'

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

export function ComponentLibrary({ atoms }: { atoms: Atom[] }) {
  const { file, pageId, blocked } = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot, documentStore.getSnapshot)
  const [destination, setDestination] = useState('root')
  const choices = componentDestinations(file, pageId, atoms)
  const active = choices.find(choice => choice.value === destination) ?? choices[0]!
  const options: PropertyOption[] = choices.map(choice => ({ value: choice.value, label: choice.label }))
  if (!atoms.length) return <Layout roleName="library-content"><Text roleName="muted">{copy.empty}</Text></Layout>
  return <Layout roleName="library-content"><Text roleName="muted">{copy.fromCode}</Text><PropertySelect id="component-add-to" label={copy.addTo} value={active.value} options={options} onChange={setDestination} disabled={!file || blocked} /><Layout roleName="component-list">{atoms.filter(atom => atom.kind === 'atom').map(atom => <Button key={atom.componentId} disabled={!file || blocked || atom.status !== 'bound'} title={atom.status === 'bound' ? copy.add(atom.name) : copy.unavailable} onClick={() => documentStore.commands.insert(atom.componentId, active.target)}><Icon name="component" />{copy.add(atom.name)}</Button>)}</Layout></Layout>
}
