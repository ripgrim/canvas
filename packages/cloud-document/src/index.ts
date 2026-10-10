import { validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine'

type ComponentShape = Readonly<{
  id: string
  componentId: string
  exportName: string
  props: Readonly<Record<string, unknown>>
  slots: readonly string[]
}>

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function componentShapes(value: unknown): ComponentShape[] {
  if (!record(value) || !record(value.nodes) || !record(value.relationships)) return []
  const slots = new Map<string, Set<string>>()
  for (const relationship of Object.values(value.relationships)) {
    if (!record(relationship) || typeof relationship.parentId !== 'string' || typeof relationship.slot !== 'string') continue
    const current = slots.get(relationship.parentId) ?? new Set<string>()
    current.add(relationship.slot)
    slots.set(relationship.parentId, current)
  }
  const shapes: ComponentShape[] = []
  for (const node of Object.values(value.nodes)) {
    if (!record(node) || node.type !== 'component' || typeof node.id !== 'string' || typeof node.componentId !== 'string' || typeof node.exportName !== 'string' || !record(node.props)) continue
    shapes.push({ id: node.id, componentId: node.componentId, exportName: node.exportName, props: node.props, slots: [...(slots.get(node.id) ?? [])] })
  }
  return shapes
}

function hostedAtoms(value: unknown): Atom[] {
  const groups = new Map<string, ComponentShape[]>()
  for (const shape of componentShapes(value)) {
    const current = groups.get(shape.componentId) ?? []
    current.push(shape)
    groups.set(shape.componentId, current)
  }
  return [...groups].map(([componentId, shapes]) => {
    const exports = new Set(shapes.map(shape => shape.exportName))
    if (exports.size !== 1) throw new Error('Component identity is inconsistent')
    const propTypes = new Map<string, Set<string>>()
    for (const shape of shapes) for (const [name, prop] of Object.entries(shape.props)) {
      const types = propTypes.get(name) ?? new Set<string>()
      types.add(typeof prop)
      propTypes.set(name, types)
    }
    for (const shape of shapes) for (const slot of shape.slots) {
      const types = propTypes.get(slot) ?? new Set<string>()
      types.add('ReactNode')
      propTypes.set(slot, types)
    }
    return {
      componentId,
      exportName: shapes[0]!.exportName,
      name: shapes[0]!.exportName,
      kind: 'atom',
      path: '',
      fingerprint: '',
      sourceHash: '',
      status: 'missing',
      candidates: [],
      props: [...propTypes].map(([name, types]) => ({ name, type: [...types].sort().join(' | '), optional: true })),
    }
  })
}

/**
 * Validates the complete hosted document graph while treating component source bindings as unavailable.
 * Source prop contracts are revalidated against a connected repository before code generation.
 */
export function validateHostedFileDocument(value: unknown): FileDocument {
  return validateFileDocument(value, hostedAtoms(value), { allowUnavailableBindings: true })
}
