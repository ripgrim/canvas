import type { Atom } from './types'
import type { EditorRepositoryConnection } from '../../capabilities'
import type { FileDocument } from '@canvas/repo-engine/file-document'

/** Converts the main-process verified catalog into the only insertable component identities for a connected repository. */
export function connectedRegistryAtoms(connection: EditorRepositoryConnection | null): Atom[] {
  if (!connection) return []
  return connection.registry.components.map(component => ({
    componentId: component.componentId,
    name: component.exportName,
    exportName: component.exportName,
    path: component.path,
    fingerprint: connection.registry.fingerprint,
    sourceHash: component.sourceHash,
    status: 'bound',
    candidates: [],
    kind: 'atom',
    props: component.props.map(prop => ({ ...prop })),
    slots: [...component.slots],
  }))
}

/** Keeps identities already stored in the file readable, but only the active registry remains insertable. */
export function documentRegistryAtoms(file: FileDocument | null, active: readonly Atom[], prior: readonly Atom[]): Atom[] {
  const result = active.map(atom => structuredClone(atom))
  const activeIds = new Set(result.map(atom => atom.componentId))
  const referenced = new Set(Object.values(file?.nodes ?? {}).flatMap(node => node.type === 'component' ? [node.componentId] : []))
  for (const atom of prior) {
    if (!referenced.has(atom.componentId) || activeIds.has(atom.componentId)) continue
    result.push({ ...structuredClone(atom), status: 'missing', candidates: [] })
  }
  return result
}
