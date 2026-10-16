import type { Atom } from './types'
import type { EditorRepositoryConnection } from '../../capabilities'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import { codeComponentPropertiesFromScan } from '@canvas/repo-engine/component-admission'
import type { ShadcnComponentCatalog } from '@canvas/scanner/contracts'

function registryDefinitions(atoms: readonly Atom[]): ComponentDefinition[] {
  return atoms.map(atom => ({
    id: atom.componentId,
    name: atom.name,
    source: { kind: 'code', bindingId: atom.componentId },
    revision: 0,
    properties: codeComponentPropertiesFromScan(atom.props, atom.slots ?? []),
    materials: [],
    parts: [],
    interactions: [],
  }))
}

/** Adapts only bound registry facts the component model can represent without guessing source behavior. */
export function connectedRegistryDefinitions(atoms: readonly Atom[]): ComponentDefinition[] {
  return registryDefinitions(atoms.filter(atom => atom.status === 'bound'))
}

function catalogAtoms(registry: ShadcnComponentCatalog, status: Atom['status']): Atom[] {
  return registry.components.map(component => ({
    componentId: component.componentId,
    name: component.exportName,
    exportName: component.exportName,
    path: component.path,
    fingerprint: registry.fingerprint,
    sourceHash: component.sourceHash,
    status,
    candidates: [],
    kind: 'atom',
    props: component.props.map(prop => ({ ...prop })),
    slots: [...component.slots],
  }))
}

/** Converts the main-process verified catalog into the only insertable component identities for a connected repository. */
export function connectedRegistryAtoms(connection: EditorRepositoryConnection | null): Atom[] {
  if (!connection) return []
  return catalogAtoms(connection.registry, 'bound')
}

/** Makes hosted discoveries readable in Kit without pretending their source can run in the preview runtime. */
export function discoveredRegistryAtoms(registry: ShadcnComponentCatalog): Atom[] {
  return catalogAtoms(registry, 'missing')
}

export function discoveredRegistryDefinitions(registry: ShadcnComponentCatalog): ComponentDefinition[] {
  return registryDefinitions(discoveredRegistryAtoms(registry))
}

/** Keeps identities already stored in the file readable, but only the active registry remains insertable. */
export function documentRegistryAtoms(file: FileDocument | null, active: readonly Atom[], prior: readonly Atom[]): Atom[] {
  const result = active.map(atom => structuredClone(atom))
  const activeIds = new Set(result.map(atom => atom.componentId))
  const referenced = new Set([
    ...Object.values(file?.nodes ?? {}).flatMap(node => node.type === 'component' ? [node.componentId] : []),
    ...Object.values(file?.componentModel.definitions ?? {}).flatMap(definition => definition.source.kind === 'code' ? [definition.id] : []),
  ])
  for (const atom of prior) {
    if (!referenced.has(atom.componentId) || activeIds.has(atom.componentId)) continue
    result.push({ ...structuredClone(atom), status: 'missing', candidates: [] })
  }
  return result
}
