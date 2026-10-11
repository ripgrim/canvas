import type { Atom, Composition } from './types.js'

export type DocumentValue = string | number | boolean
export type CanvasElementKind = 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'
/** Fill is a token reference (accent, surface, muted, gradient or a document token name) or a literal hex override. */
export type CanvasFill = string
export type CanvasElement = {
  id: string
  kind: CanvasElementKind
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  fill: CanvasFill
  text?: string
  parentId?: string | null
  clip?: boolean
}
export const builtInTokenNames = ['accent', 'surface', 'muted', 'gradient'] as const
export const isTokenName = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)
export type DocumentNodeLayout = {
  mode: 'flow' | 'absolute'
  x: number
  y: number
  width?: number
  height?: number
}
export type DocumentNode = {
  id: string
  componentId: string
  exportName: string
  name?: string
  props: Record<string, DocumentValue>
  children: Record<string, string[]>
  layout?: DocumentNodeLayout
}
export type EditorDocument = {
  version: 1
  revision: number
  rootIds: string[]
  nodes: Record<string, DocumentNode>
  frame: { name?: string; width: number; height: number; direction: 'column' | 'row'; gap: number; padding: number; clip: boolean }
  canvas?: { elements: CanvasElement[] }
  tokens?: Record<string, string>
}
export type DocumentTarget = { parentId: string | null; slot?: string; index?: number }
export type DocumentValidationOptions = { allowUnavailableBindings?: boolean }
export type DocumentCommand =
  | { type: 'insert'; node: DocumentNode; target?: DocumentTarget }
  | { type: 'duplicate'; nodeId: string; ids: Record<string, string>; target?: DocumentTarget }
  | { type: 'delete'; nodeIds: string[] }
  | { type: 'move'; nodeId: string; target: DocumentTarget }
  | { type: 'update-props'; nodeId: string; props: Record<string, DocumentValue> }
  | { type: 'update-many-props'; updates: { nodeId: string; props: Record<string, DocumentValue>; remove?: string[] }[] }
  | { type: 'remove-props'; nodeId: string; names: string[] }
  | { type: 'update-frame'; frame: Partial<EditorDocument['frame']> }
  | { type: 'insert-canvas-element'; element: CanvasElement; index?: number }
  | { type: 'update-canvas-element'; elementId: string; patch: Partial<Omit<CanvasElement, 'id' | 'kind'>> }
  | { type: 'delete-canvas-elements'; elementIds: string[] }
  | { type: 'move-canvas-element'; elementId: string; index: number }
  | { type: 'update-node-layout'; nodeId: string; layout: DocumentNodeLayout }
  | { type: 'rename-node'; nodeId: string; name: string }
  | { type: 'update-token'; name: string; value: string }
  | { type: 'remove-token'; name: string }

export const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const coordinateLimit = 1_000_000
export const supportedInputTypes = ['button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset', 'search', 'submit', 'tel', 'text', 'time', 'url', 'week'] as const
const own = (object: object, key: string) => Object.hasOwn(object, key)
export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value) && !forbiddenKeys.has(value)
export const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= 128

export function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unsupported ${label} field`)
}

export function getNodeSlots(atom: Atom): string[] {
  if (atom.kind !== 'atom') return []
  if (atom.slots !== undefined) return atom.slots.filter(name => atom.props.some(prop => prop.name === name))
  return atom.exportName === 'Card' ? ['children', 'heading', 'footer'].filter(name => atom.props.some(prop => prop.name === name)) : []
}

function validPropValue(type: string, value: DocumentValue): boolean {
  if (type.includes('ReactNode')) return true
  if (typeof value === 'string' && /\bHTMLInputTypeAttribute\b/.test(type)) return (supportedInputTypes as readonly string[]).includes(value)
  if (/\bBooleanish\b/.test(type)) return typeof value === 'boolean' || value === 'true' || value === 'false'
  const members = type.split(/\s*\|\s*/)
  if (members.includes(typeof value)) return true
  if (typeof value === 'boolean') return members.includes(String(value))
  if (typeof value === 'number') return members.includes(String(value))
  if (members.some(member => /^(['"]).*\1$/.test(member) && member.slice(1, -1) === value)) return true
  return false
}

export function validateNodeLayout(value: unknown): value is DocumentNodeLayout {
  if (!record(value)) return false
  fields(value, ['mode', 'x', 'y', ...(own(value, 'width') ? ['width'] : []), ...(own(value, 'height') ? ['height'] : [])], 'node layout')
  if (!['flow', 'absolute'].includes(value.mode as string)) return false
  if (typeof value.x !== 'number' || !Number.isFinite(value.x) || Math.abs(value.x) > coordinateLimit || typeof value.y !== 'number' || !Number.isFinite(value.y) || Math.abs(value.y) > coordinateLimit) return false
  for (const key of ['width', 'height'] as const) if (own(value, key) && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value[key] as number) < 1 || (value[key] as number) > coordinateLimit)) return false
  return true
}

function validateCanvasElement(value: unknown): value is CanvasElement {
  if (!record(value)) return false
  fields(value, ['id', 'kind', 'name', 'x', 'y', 'width', 'height', 'rotation', 'fill', ...(own(value, 'text') ? ['text'] : []), ...(own(value, 'parentId') ? ['parentId'] : []), ...(own(value, 'clip') ? ['clip'] : [])], 'canvas element')
  if (!validId(value.id) || !['frame', 'rectangle', 'shape', 'shader', 'text'].includes(value.kind as string) || !validName(value.name)) return false
  if (own(value, 'parentId') && value.parentId !== null && !validId(value.parentId)) return false
  if (own(value, 'clip') && (typeof value.clip !== 'boolean' || value.kind !== 'frame')) return false
  for (const key of ['x', 'y', 'rotation'] as const) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key] as number) > coordinateLimit) return false
  for (const key of ['width', 'height'] as const) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value[key] as number) < 1 || (value[key] as number) > coordinateLimit) return false
  if (!isTokenName(value.fill) && !isHexColor(value.fill)) return false
  if (own(value, 'text') && (typeof value.text !== 'string' || value.text.length > 10_000)) return false
  return value.kind === 'text' ? typeof value.text === 'string' : !own(value, 'text')
}

export function validateProps(node: Pick<DocumentNode, 'props' | 'children'>, atom: Atom) {
  if (!record(node.props) || Object.keys(node.props).length > 100) throw new Error('Invalid component props')
  for (const [name, value] of Object.entries(node.props)) {
    if (forbiddenKeys.has(name) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || /^on[A-Z]/.test(name) || ['style', 'dangerouslySetInnerHTML', 'ref', 'key'].includes(name)) throw new Error(`Unsupported prop ${name}`)
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.length > 10_000)) throw new Error(`Invalid value for ${name}`)
    const definition = atom.props.find(prop => prop.name === name)
    if (!definition || !validPropValue(definition.type, value)) throw new Error(`Unsupported value for ${atom.exportName}.${name}`)
    if (name === 'children' && atom.exportName === 'Input') throw new Error('Input does not accept children')
    if (own(node.children, name) && node.children[name]!.length > 0) throw new Error(`Slot ${name} already contains components`)
  }
  for (const definition of atom.props) {
    if (!definition.optional && !own(node.props, definition.name) && !(node.children[definition.name]?.length)) throw new Error(`Required prop ${definition.name} is missing`)
  }
}

export function validateDocument(input: unknown, atoms: Atom[], options: DocumentValidationOptions = {}): EditorDocument {
  if (!record(input)) throw new Error('Invalid editor document')
  fields(input, ['version', 'revision', 'rootIds', 'nodes', 'frame', ...(own(input, 'canvas') ? ['canvas'] : []), ...(own(input, 'tokens') ? ['tokens'] : [])], 'document')
  if (input.version !== 1 || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error('Invalid document revision')
  if (!record(input.nodes) || Object.keys(input.nodes).length > 500 || !Array.isArray(input.rootIds) || input.rootIds.length > 500) throw new Error('Document exceeds the supported node limit')
  if (!record(input.frame)) throw new Error('Invalid document frame')
  fields(input.frame, ['name', 'width', 'height', 'direction', 'gap', 'padding', 'clip'], 'frame')
  if (own(input.frame, 'name') && (typeof input.frame.name !== 'string' || !input.frame.name.trim() || input.frame.name !== input.frame.name.trim() || input.frame.name.length > 128)) throw new Error('Invalid frame name')
  for (const name of ['width', 'height', 'gap', 'padding'] as const) {
    const value = input.frame[name]
    const min = name === 'width' || name === 'height' ? 64 : 0
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > 8192) throw new Error(`Invalid frame ${name}`)
  }
  if (!['row', 'column'].includes(input.frame.direction as string) || typeof input.frame.clip !== 'boolean') throw new Error('Invalid frame layout')
  const doc = input as unknown as EditorDocument
  if (own(input, 'tokens')) {
    if (!record(input.tokens) || Object.keys(input.tokens).length > 100 || Object.entries(input.tokens).some(([name, value]) => !isTokenName(name) || !isHexColor(value))) throw new Error('Invalid document tokens')
  }
  if (own(input, 'canvas')) {
    if (!record(input.canvas) || Object.keys(input.canvas).length !== 1 || !Array.isArray(input.canvas.elements) || input.canvas.elements.length > 500 || input.canvas.elements.some(element => !validateCanvasElement(element))) throw new Error('Invalid canvas elements')
    const elementIds = input.canvas.elements.map(element => element.id)
    if (new Set(elementIds).size !== elementIds.length || elementIds.some(id => own(doc.nodes, id))) throw new Error('Canvas elements need unique identities')
    const elements = new Map(input.canvas.elements.map(element => [element.id, element]))
    for (const element of input.canvas.elements) {
      if (element.parentId) {
        const parent = elements.get(element.parentId)
        if (!parent || parent.kind !== 'frame') throw new Error('Canvas elements can only be nested in frames')
      }
      const visited = new Set([element.id]); let parentId = element.parentId
      while (parentId) { if (visited.has(parentId)) throw new Error('Canvas element nesting cannot contain a cycle'); visited.add(parentId); parentId = elements.get(parentId)?.parentId }
    }
  }
  for (const [key, node] of Object.entries(doc.nodes)) {
    if (!record(node)) throw new Error('Invalid document node')
    fields(node, ['id', 'componentId', 'exportName', 'props', 'children', ...(own(node, 'layout') ? ['layout'] : []), ...(own(node, 'name') ? ['name'] : [])], 'node')
    if (!validId(key) || node.id !== key || !validId(node.componentId) || typeof node.exportName !== 'string') throw new Error('Invalid component identity')
    if (own(node, 'name') && !validName(node.name)) throw new Error('Invalid component name')
    const atom = atoms.find(candidate => candidate.componentId === node.componentId)
    if (!atom || (!options.allowUnavailableBindings && atom.status !== 'bound') || atom.kind !== 'atom' || atom.exportName !== node.exportName) throw new Error('Component binding needs review')
    if (!record(node.children)) throw new Error('Invalid component slots')
    if (own(node, 'layout') && !validateNodeLayout(node.layout)) throw new Error('Invalid component layout')
    const slots = getNodeSlots(atom)
    for (const [slot, children] of Object.entries(node.children)) {
      if (!slots.includes(slot) || !Array.isArray(children) || children.length > 500 || children.some(id => !validId(id))) throw new Error(`Invalid slot ${node.exportName}.${slot}`)
    }
    validateProps(node, atom)
  }
  const visited = new Set<string>()
  const active = new Set<string>()
  function visit(id: string, depth: number) {
    if (!validId(id) || !own(doc.nodes, id)) throw new Error('A document child is missing')
    if (active.has(id)) throw new Error('Document contains a cycle')
    if (visited.has(id)) throw new Error('An instance cannot have multiple parents')
    if (depth > 64) throw new Error('Document nesting exceeds the supported limit')
    active.add(id)
    visited.add(id)
    for (const children of Object.values(doc.nodes[id]!.children)) for (const child of children) visit(child, depth + 1)
    active.delete(id)
  }
  for (const id of doc.rootIds) visit(id, 0)
  if (visited.size !== Object.keys(doc.nodes).length) throw new Error('Document contains unreachable instances or a cycle')
  if (JSON.stringify(doc).length > 1_000_000) throw new Error('Document exceeds the supported size')
  return structuredClone(doc)
}

export function createDocument(atoms: Atom[], composition: Composition, options: DocumentValidationOptions = {}): EditorDocument {
  const nodes: Record<string, DocumentNode> = {}
  const rootIds: string[] = []
  for (const child of composition.children) {
    if (own(nodes, child.id)) throw new Error('Duplicate composition identity')
    nodes[child.id] = { ...structuredClone(child), children: {} }
    rootIds.push(child.id)
  }
  const card = atoms.find(atom => atom.exportName === 'Card' && atom.kind === 'atom' && (atom.status === 'bound' || options.allowUnavailableBindings))
  if (card && rootIds.length > 0) {
    const id = `${composition.id}:card`
    nodes[id] = { id, componentId: card.componentId, exportName: card.exportName, props: { heading: 'Welcome back' }, children: { children: [...rootIds] } }
    rootIds.splice(0, rootIds.length, id)
  }
  return validateDocument({ version: 1, revision: 0, rootIds, nodes, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false } }, atoms, options)
}

export function getDocumentParent(doc: EditorDocument, nodeId: string): (DocumentTarget & { index: number }) | null {
  const rootIndex = doc.rootIds.indexOf(nodeId)
  if (rootIndex >= 0) return { parentId: null, index: rootIndex }
  for (const node of Object.values(doc.nodes)) for (const [slot, children] of Object.entries(node.children)) {
    const index = children.indexOf(nodeId)
    if (index >= 0) return { parentId: node.id, slot, index }
  }
  return null
}

export function applyDocumentCommand(input: EditorDocument, command: DocumentCommand, atoms: Atom[]): EditorDocument {
  const doc = validateDocument(input, atoms)
  const node = (id: string) => {
    if (!own(doc.nodes, id)) throw new Error('Select an existing instance')
    return doc.nodes[id]!
  }
  const descendants = (id: string): string[] => [id, ...Object.values(node(id).children).flatMap(children => children.flatMap(descendants))]
  const targetList = (target: DocumentTarget): string[] => {
    if (target.parentId === null) {
      if (target.slot !== undefined) throw new Error('Root instances do not have a slot')
      return doc.rootIds
    }
    const parent = node(target.parentId)
    const atom = atoms.find(candidate => candidate.componentId === parent.componentId)!
    const slot = target.slot ?? 'children'
    if (!getNodeSlots(atom).includes(slot)) throw new Error(`Invalid slot ${parent.exportName}.${slot}`)
    if (own(parent.props, slot)) throw new Error(`Clear the text prop before adding to ${slot}`)
    return parent.children[slot] ??= []
  }
  const insert = (id: string, target: DocumentTarget) => {
    const list = targetList(target)
    const index = target.index ?? list.length
    if (!Number.isInteger(index) || index < 0 || index > list.length) throw new Error('Invalid insertion position')
    list.splice(index, 0, id)
  }
  const detach = (id: string) => {
    const parent = getDocumentParent(doc, id)
    if (!parent) throw new Error('Instance has no parent')
    targetList(parent).splice(parent.index, 1)
    return parent
  }
  switch (command.type) {
    case 'insert':
      if (own(doc.nodes, command.node.id)) throw new Error('Instance identity already exists')
      if (Object.values(command.node.children).some(children => children.length)) throw new Error('Insert one new instance at a time')
      doc.nodes[command.node.id] = structuredClone(command.node)
      insert(command.node.id, command.target ?? { parentId: null })
      break
    case 'duplicate': {
      const originalParent = getDocumentParent(doc, command.nodeId)
      if (!originalParent) throw new Error('Select an existing instance')
      const subtree = descendants(command.nodeId)
      if (Object.keys(command.ids).length !== subtree.length) throw new Error('Provide a new identity for every duplicate instance')
      const assigned = new Set<string>()
      for (const id of subtree) {
        const nextId = command.ids[id]
        if (!validId(nextId) || own(doc.nodes, nextId) || assigned.has(nextId)) throw new Error('Duplicate instances need unique new identities')
        assigned.add(nextId)
      }
      for (const id of subtree) {
        const original = node(id)
        const nextId = command.ids[id]!
        doc.nodes[nextId] = { ...structuredClone(original), id: nextId, children: Object.fromEntries(Object.entries(original.children).map(([slot, children]) => [slot, children.map(child => command.ids[child]!)])) }
      }
      insert(command.ids[command.nodeId]!, command.target ?? { ...originalParent, index: originalParent.index + 1 })
      break
    }
    case 'delete': {
      const removed = new Set(command.nodeIds.flatMap(descendants))
      doc.rootIds = doc.rootIds.filter(id => !removed.has(id))
      for (const value of Object.values(doc.nodes)) for (const [slot, children] of Object.entries(value.children)) value.children[slot] = children.filter(id => !removed.has(id))
      for (const id of removed) delete doc.nodes[id]
      break
    }
    case 'move':
      if (command.target.parentId !== null && descendants(command.nodeId).includes(command.target.parentId)) throw new Error('Cannot move an instance inside its own subtree')
      detach(command.nodeId)
      insert(command.nodeId, command.target)
      break
    case 'update-props':
      node(command.nodeId).props = { ...node(command.nodeId).props, ...command.props }
      break
    case 'update-many-props':
      if (!Array.isArray(command.updates) || !command.updates.length || command.updates.length > 500 || new Set(command.updates.map(update => update.nodeId)).size !== command.updates.length) throw new Error('Invalid prop batch')
      for (const update of command.updates) {
        const target = node(update.nodeId)
        if (!record(update.props) || update.remove && (!Array.isArray(update.remove) || update.remove.some(name => typeof name !== 'string' || forbiddenKeys.has(name)))) throw new Error('Invalid prop batch')
        target.props = { ...target.props, ...update.props }
        for (const name of update.remove ?? []) delete target.props[name]
      }
      break
    case 'remove-props':
      for (const name of command.names) delete node(command.nodeId).props[name]
      break
    case 'update-frame':
      doc.frame = { ...doc.frame, ...command.frame }
      break
    case 'insert-canvas-element': {
      if (!validateCanvasElement(command.element) || own(doc.nodes, command.element.id) || doc.canvas?.elements.some(element => element.id === command.element.id)) throw new Error('Canvas element identity is invalid')
      const elements = doc.canvas?.elements ?? []
      const index = command.index ?? elements.length
      if (!Number.isInteger(index) || index < 0 || index > elements.length) throw new Error('Invalid canvas element position')
      doc.canvas = { elements: [...elements.slice(0, index), structuredClone(command.element), ...elements.slice(index)] }
      break
    }
    case 'update-canvas-element': {
      const index = doc.canvas?.elements.findIndex(element => element.id === command.elementId) ?? -1
      if (index < 0) throw new Error('Select an existing canvas element')
      const current = doc.canvas!.elements[index]!
      const next = { ...current, ...command.patch }
      if (!validateCanvasElement(next)) throw new Error('Invalid canvas element update')
      doc.canvas!.elements[index] = next
      break
    }
    case 'delete-canvas-elements': {
      if (!Array.isArray(command.elementIds) || !command.elementIds.length) throw new Error('Select a canvas element')
      const removed = new Set(command.elementIds)
      let changed = true
      while (changed) { changed = false; for (const element of doc.canvas?.elements ?? []) if (element.parentId && removed.has(element.parentId) && !removed.has(element.id)) { removed.add(element.id); changed = true } }
      doc.canvas = { elements: (doc.canvas?.elements ?? []).filter(element => !removed.has(element.id)) }
      break
    }
    case 'move-canvas-element': {
      const elements = doc.canvas?.elements ?? []
      const index = elements.findIndex(element => element.id === command.elementId)
      if (index < 0 || !Number.isInteger(command.index) || command.index < 0 || command.index >= elements.length) throw new Error('Invalid canvas element position')
      const [element] = elements.splice(index, 1)
      elements.splice(command.index, 0, element!)
      doc.canvas = { elements }
      break
    }
    case 'update-node-layout':
      if (!validateNodeLayout(command.layout)) throw new Error('Invalid component layout')
      node(command.nodeId).layout = structuredClone(command.layout)
      break
    case 'rename-node':
      if (!validName(command.name)) throw new Error('Invalid component name')
      node(command.nodeId).name = command.name
      break
    case 'update-token':
      if (!isTokenName(command.name) || !isHexColor(command.value)) throw new Error('Invalid document token')
      doc.tokens = { ...doc.tokens, [command.name]: command.value }
      break
    case 'remove-token': {
      if (!isTokenName(command.name) || !doc.tokens || !own(doc.tokens, command.name)) throw new Error('Select an existing document token')
      const { [command.name]: _removed, ...rest } = doc.tokens
      if (Object.keys(rest).length) doc.tokens = rest
      else delete doc.tokens
      break
    }
    default:
      throw new Error('Unknown document command')
  }
  doc.revision += 1
  return validateDocument(doc, atoms)
}
