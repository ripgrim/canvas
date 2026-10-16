import type { Atom } from './types'
import { isHostedAtom } from '@canvas/repo-engine/contracts'
import type { HostedAtom, RepositoryAtom } from '@canvas/repo-engine/contracts'
import type { EditorRepositoryConnection } from '../../capabilities'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import { codeComponentPropertiesFromScan } from '@canvas/repo-engine/component-admission'
import type { ShadcnComponentCatalog } from '@canvas/scanner/contracts'
import type { HostedSourceBindingProjection, HostedSourceComponentProjection } from './hosted-source-binding-projection'

const opaquePattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const own = (value: object, key: string): boolean => Object.hasOwn(value, key)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && keys.every(key => own(value, key)) && Object.keys(value).every(key => keys.includes(key))
}

function invalidHostedProjection(): never {
  throw new Error('Invalid hosted source binding projection.')
}

function validateHostedComponents(projection: HostedSourceBindingProjection): readonly HostedSourceComponentProjection[] {
  if (!exact(projection, ['authority', 'components']) || !exact(projection.authority, [
    'version', 'projectId', 'repositoryId', 'scanId', 'sourceRevision', 'registryFingerprint', 'grantGeneration', 'adapterId', 'updatedAt',
  ]) || !Number.isSafeInteger(projection.authority.version) || projection.authority.version < 1
    || typeof projection.authority.projectId !== 'string' || typeof projection.authority.repositoryId !== 'string'
    || typeof projection.authority.scanId !== 'string' || typeof projection.authority.sourceRevision !== 'string'
    || typeof projection.authority.registryFingerprint !== 'string' || !Number.isSafeInteger(projection.authority.grantGeneration)
    || projection.authority.grantGeneration < 1 || typeof projection.authority.adapterId !== 'string'
    || !Number.isSafeInteger(projection.authority.updatedAt) || projection.authority.updatedAt < 0
    || !Array.isArray(projection.components)) invalidHostedProjection()
  const ids = new Set<string>()
  for (const component of projection.components) {
    if (!object(component) || typeof component.bindingId !== 'string' || !opaquePattern.test(component.bindingId) || ids.has(component.bindingId)) invalidHostedProjection()
    ids.add(component.bindingId)
    if (component.status === 'missing') {
      if (!exact(component, ['bindingId', 'status'])) invalidHostedProjection()
      continue
    }
    if (component.status === 'bound') {
      if (!exact(component, ['bindingId', 'status', 'name', 'props', 'slots'])
        || typeof component.name !== 'string' || component.name.length < 1
        || !Array.isArray(component.props) || !Array.isArray(component.slots)) invalidHostedProjection()
      const names = new Set<string>()
      for (const prop of component.props) {
        if (!exact(prop, ['name', 'type', 'optional']) || typeof prop.name !== 'string' || typeof prop.type !== 'string'
          || typeof prop.optional !== 'boolean' || names.has(prop.name)) invalidHostedProjection()
        names.add(prop.name)
      }
      const slots = new Set<string>()
      for (const slot of component.slots) {
        if (typeof slot !== 'string' || slots.has(slot)) invalidHostedProjection()
        slots.add(slot)
      }
      continue
    }
    if (component.status !== 'ambiguous' || !exact(component, ['bindingId', 'status', 'candidates'])
      || !Array.isArray(component.candidates) || component.candidates.length < 1) invalidHostedProjection()
    const tokens = new Set<string>()
    for (const candidate of component.candidates) {
      if (!exact(candidate, ['choiceToken', 'name']) || typeof candidate.choiceToken !== 'string'
        || !opaquePattern.test(candidate.choiceToken) || tokens.has(candidate.choiceToken)
        || typeof candidate.name !== 'string' || candidate.name.length < 1) invalidHostedProjection()
      tokens.add(candidate.choiceToken)
    }
  }
  return projection.components
}

/** Admits only the renderer-safe fields from a verified hosted binding projection. */
export function hostedProjectionAtoms(projection: HostedSourceBindingProjection): HostedAtom[] {
  return validateHostedComponents(projection).map(component => {
    if (component.status === 'missing') return { componentId: component.bindingId, kind: 'hosted' as const, status: 'missing' as const, name: null, candidates: [], props: [] }
    if (component.status === 'ambiguous') return {
      componentId: component.bindingId,
      kind: 'hosted' as const,
      status: 'ambiguous' as const,
      name: null,
      candidates: component.candidates.map(candidate => candidate.choiceToken),
      props: [],
    }
    return {
      componentId: component.bindingId,
      kind: 'hosted' as const,
      status: 'bound' as const,
      name: component.name,
      candidates: [],
      props: component.props.map(prop => ({ name: prop.name, type: prop.type, optional: prop.optional })),
      slots: [...component.slots],
    }
  })
}

/** Creates source definitions only for bindings proven bound by the hosted projection. */
export function hostedProjectionDefinitions(projection: HostedSourceBindingProjection): ComponentDefinition[] {
  return validateHostedComponents(projection).flatMap(component => component.status === 'bound' ? [{
    id: component.bindingId,
    name: component.name,
    source: { kind: 'code' as const, bindingId: component.bindingId },
    revision: 0,
    properties: codeComponentPropertiesFromScan(component.props, component.slots),
    materials: [],
    parts: [],
    interactions: [],
  }] : [])
}

function registryDefinitions(atoms: readonly RepositoryAtom[]): ComponentDefinition[] {
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
export function connectedRegistryDefinitions(atoms: readonly RepositoryAtom[]): ComponentDefinition[] {
  return registryDefinitions(atoms.filter(atom => atom.status === 'bound'))
}

function catalogAtoms(registry: ShadcnComponentCatalog, status: RepositoryAtom['status']): RepositoryAtom[] {
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
export function connectedRegistryAtoms(connection: EditorRepositoryConnection | null): RepositoryAtom[] {
  if (!connection) return []
  return catalogAtoms(connection.registry, 'bound')
}

/** Makes hosted discoveries readable in Kit without pretending their source can run in the preview runtime. */
export function discoveredRegistryAtoms(registry: ShadcnComponentCatalog): RepositoryAtom[] {
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
    if (activeIds.has(atom.componentId)) continue
    if (isHostedAtom(atom)) {
      result.push(structuredClone(atom))
      activeIds.add(atom.componentId)
      continue
    }
    if (!referenced.has(atom.componentId)) continue
    result.push({ ...structuredClone(atom), status: 'missing', candidates: [] })
    activeIds.add(atom.componentId)
  }
  return result
}
