/**
 * The authoritative design file: ordered pages, one normalized node map, one parent/order relationship per node, and
 * one file-scoped theme. Child lists, page membership, and world geometry are derived from the relationships. Pages are
 * open workspaces whose roots render nothing; frames are ordinary nodes that may contain children.
 */
import type { Atom } from './types.js'
import { fields, forbiddenKeys, getNodeSlots, record, validId, validName, validateProps } from './document.js'
import type { DocumentValue, EditorDocument } from './document.js'
import { legacyLayout, validateLayout } from './layout.js'
import type { NodeLayout } from './layout.js'
import { isNodeThemeMode } from './node-theme.js'
import type { NodeThemeMode } from './node-theme.js'
import { isColor } from './color.js'
import type { Color } from './color.js'
import { compareOrder, isOrderKey, orderKeyBetween, orderKeySequence } from './order-keys.js'
import { appearanceColors, assetReferences, blendModes, borderSides, canonicalAppearance, defaultFillColor, isColorValue, mapAppearanceColors, validateAppearance, validateBorders, validateImageAssetReference, validateOutline, validatePaint, validateStroke } from './appearance.js'
import type { Appearance, BlendMode, BorderSide, Borders, ColorValue, ImageAssetReference, Outline, Paint, Stroke } from './appearance.js'
export * from './appearance.js'

export const fileSchemaVersion = 7 as const
export type PrimitiveKind = 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'
export const primitiveKinds: readonly PrimitiveKind[] = ['frame', 'rectangle', 'shape', 'shader', 'text']
export type PrimitiveStyles = { left: number; top: number; width: number; height: number; rotation?: number; flipX?: boolean; flipY?: boolean; overflow?: 'clip' | 'visible' }
export type RootNode = { id: string; type: 'root' }
/**
 * `themeMode` is the stored per-node theme choice (schema v5). Migration and insertion write it explicitly; a node
 * without the field (hand-built or pre-migration data) reads as `inherit` through `nodeThemeMode`.
 */
export type PrimitiveNode = { id: string; type: PrimitiveKind; name: string; styles: PrimitiveStyles; appearance?: Appearance; text?: string; themeMode?: NodeThemeMode; isLocked?: boolean }
export type ComponentNode = { id: string; type: 'component'; name?: string; componentId: string; exportName: string; props: Record<string, DocumentValue>; layout?: NodeLayout; appearance?: Appearance; themeMode?: NodeThemeMode; isLocked?: boolean }
export type FileNode = RootNode | PrimitiveNode | ComponentNode
/** Parent plus sibling order; `slot` names the component slot when the parent is a component instance. */
export type NodeRelationship = { parentId: string; orderKey: string; slot?: string }
export type FilePage = { id: string; name: string; rootNodeId: string; background?: ColorValue }
export type TokenValue =
  | { kind: 'literal'; color: Color }
  | { kind: 'alias'; tokenId: string }
  /** A design stylesheet custom property (for example `--surface`), resolved against the active design theme. */
  | { kind: 'source'; property: string; fallback: Color }
export type ColorToken = { id: string; type: 'color'; name: string; orderKey: string; description?: string; value: TokenValue }
export type FileTheme = { tokens: Record<string, ColorToken> }
export type FileDocument = {
  schemaVersion: typeof fileSchemaVersion
  fileId: string
  revision: number
  pages: FilePage[]
  nodes: Record<string, FileNode>
  relationships: Record<string, NodeRelationship>
  theme: FileTheme
  /** Immutable private asset metadata. Object keys, URLs, and bytes never enter the document. */
  assets?: Record<string, ImageAssetReference>
}
/** Resolved design stylesheet values by custom property name, supplied by the active design theme. */
export type SourcePalette = Record<string, Color>
export type FileValidationOptions = { allowUnavailableBindings?: boolean }
export type Rect = { x: number; y: number; width: number; height: number }

/** Invisible layout host for component roots that still flow (legacy composition behaviour). Never rendered as a frame. */
export const flowHost = { width: 400, height: 520, direction: 'column' as const, gap: 16, padding: 24, clip: false }
/** World origin of the legacy component host: root components flow inside it, so their world coordinates shift by this. */
export const hostOrigin = (frame: { width: number; height: number; padding: number }) => ({ x: -frame.width / 2 + frame.padding, y: -frame.height / 2 + frame.padding })
const limits = { pages: 100, nodes: 5000, tokens: 500, assets: 64, bytes: 4_000_000, coordinate: 1_000_000, depth: 64 }
const own = (object: object, key: string) => Object.hasOwn(object, key)
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
export const isTokenId = validId
const sourceProperty = (value: unknown): value is string => typeof value === 'string' && /^--[A-Za-z0-9_-]{1,64}$/.test(value)

function validateStyles(value: unknown, kind: PrimitiveKind): value is PrimitiveStyles {
  if (!record(value)) return false
  fields(value, ['left', 'top', 'width', 'height', ...(own(value, 'rotation') ? ['rotation'] : []), ...(own(value, 'flipX') ? ['flipX'] : []), ...(own(value, 'flipY') ? ['flipY'] : []), ...(own(value, 'overflow') ? ['overflow'] : [])], 'node styles')
  if (!finite(value.left, -limits.coordinate, limits.coordinate) || !finite(value.top, -limits.coordinate, limits.coordinate)) return false
  if (!finite(value.width, 1, limits.coordinate) || !finite(value.height, 1, limits.coordinate)) return false
  if (own(value, 'rotation') && !finite(value.rotation, -limits.coordinate, limits.coordinate)) return false
  if (own(value, 'flipX') && typeof value.flipX !== 'boolean') return false
  if (own(value, 'flipY') && typeof value.flipY !== 'boolean') return false
  if (own(value, 'overflow') && (kind !== 'frame' || !['clip', 'visible'].includes(value.overflow as string))) return false
  return true
}

function validateTokenValue(value: unknown): value is TokenValue {
  if (!record(value)) return false
  if (value.kind === 'literal') return Object.keys(value).length === 2 && isColor(value.color)
  if (value.kind === 'alias') return Object.keys(value).length === 2 && validId(value.tokenId)
  if (value.kind === 'source') return Object.keys(value).length === 3 && sourceProperty(value.property) && isColor(value.fallback)
  return false
}

const invalid = (message: string) => new Error(message)

/** Parents that accept children: page roots take anything, frames take primitives, component instances take components in a slot. */
export function acceptsChild(parent: FileNode, child: FileNode, slot: string | undefined, atoms: Atom[]): boolean {
  if (parent.type === 'root') return slot === undefined && child.type !== 'root'
  if (parent.type === 'frame') return slot === undefined && child.type !== 'root' && child.type !== 'component'
  if (parent.type === 'component') {
    if (child.type !== 'component' || slot === undefined) return false
    const atom = atoms.find(candidate => candidate.componentId === parent.componentId)
    return Boolean(atom && getNodeSlots(atom).includes(slot))
  }
  return false
}

export function validateFileDocument(input: unknown, atoms: Atom[], options: FileValidationOptions = {}): FileDocument {
  if (!record(input)) throw invalid('Invalid design file')
  fields(input, ['schemaVersion', 'fileId', 'revision', 'pages', 'nodes', 'relationships', 'theme', ...(own(input, 'assets') ? ['assets'] : [])], 'design file')
  if (input.schemaVersion !== fileSchemaVersion) throw invalid('Unsupported design file version')
  if (!validId(input.fileId)) throw invalid('Invalid design file identity')
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw invalid('Invalid design file revision')
  if (!Array.isArray(input.pages) || input.pages.length === 0 || input.pages.length > limits.pages) throw invalid('A design file needs between 1 and 100 pages')
  if (!record(input.nodes) || Object.keys(input.nodes).length > limits.nodes) throw invalid('Design file exceeds the supported node limit')
  if (!record(input.relationships)) throw invalid('Invalid node relationships')
  if (!record(input.theme)) throw invalid('Invalid file theme')
  fields(input.theme, ['tokens'], 'file theme')
  if (!record(input.theme.tokens) || Object.keys(input.theme.tokens).length > limits.tokens) throw invalid('Design file exceeds the supported token limit')
  if (own(input, 'assets')) {
    if (!record(input.assets) || Object.keys(input.assets).length > limits.assets) throw invalid('Design file exceeds the supported asset limit')
    for (const [assetId, asset] of Object.entries(input.assets)) { const checked = validateImageAssetReference(asset); if (checked.id !== assetId) throw invalid('Invalid image asset identity') }
  }
  const file = input as unknown as FileDocument

  for (const [key, node] of Object.entries(file.nodes)) {
    if (!record(node) || !validId(key) || node.id !== key || forbiddenKeys.has(key)) throw invalid('Invalid node identity')
    if (node.type === 'root') { fields(node, ['id', 'type'], 'root node'); continue }
    if (node.type === 'component') {
      fields(node, ['id', 'type', 'componentId', 'exportName', 'props', ...(own(node, 'name') ? ['name'] : []), ...(own(node, 'layout') ? ['layout'] : []), ...(own(node, 'appearance') ? ['appearance'] : []), ...(own(node, 'themeMode') ? ['themeMode'] : []), ...(own(node, 'isLocked') ? ['isLocked'] : [])], 'component node')
      if (own(node, 'themeMode') && !isNodeThemeMode(node.themeMode)) throw invalid('Invalid node theme mode')
      if (own(node, 'isLocked') && typeof node.isLocked !== 'boolean') throw invalid('Invalid node lock')
      if (!validId(node.componentId) || typeof node.exportName !== 'string') throw invalid('Invalid component identity')
      if (own(node, 'name') && !validName(node.name)) throw invalid('Invalid component name')
      const atom = atoms.find(candidate => candidate.componentId === node.componentId)
      if (!atom || (!options.allowUnavailableBindings && atom.status !== 'bound') || atom.kind !== 'atom' || atom.exportName !== node.exportName) throw invalid('Component binding needs review')
      if (own(node, 'layout') && !validateLayout(node.layout)) throw invalid('Invalid component layout')
      if (own(node, 'appearance')) validateAppearance(node.appearance, 'component')
      continue
    }
    if (!(primitiveKinds as readonly string[]).includes(node.type as string)) throw invalid('Unsupported node type')
    fields(node, ['id', 'type', 'name', 'styles', ...(own(node, 'appearance') ? ['appearance'] : []), ...(own(node, 'text') ? ['text'] : []), ...(own(node, 'themeMode') ? ['themeMode'] : []), ...(own(node, 'isLocked') ? ['isLocked'] : [])], 'node')
    if (own(node, 'themeMode') && !isNodeThemeMode(node.themeMode)) throw invalid('Invalid node theme mode')
    if (own(node, 'isLocked') && typeof node.isLocked !== 'boolean') throw invalid('Invalid node lock')
    if (!validName(node.name)) throw invalid('Invalid node name')
    if (!validateStyles(node.styles, node.type)) throw invalid('Invalid node geometry')
    if (own(node, 'appearance')) validateAppearance(node.appearance, node.type)
    if (node.type === 'text' ? typeof node.text !== 'string' || node.text.length > 10_000 : own(node, 'text')) throw invalid('Invalid node text')
  }

  for (const [tokenId, token] of Object.entries(file.theme.tokens)) {
    if (!record(token) || !validId(tokenId) || token.id !== tokenId) throw invalid('Invalid token identity')
    fields(token, ['id', 'type', 'name', 'orderKey', 'value', ...(own(token, 'description') ? ['description'] : [])], 'token')
    if (token.type !== 'color' || typeof token.name !== 'string' || token.name.trim().length === 0 || token.name.length > 64 || !isOrderKey(token.orderKey)) throw invalid('Invalid token')
    if (own(token, 'description') && (typeof token.description !== 'string' || token.description.length > 500)) throw invalid('Invalid token description')
    if (!validateTokenValue(token.value)) throw invalid('Invalid token value')
    if (token.value.kind === 'alias' && !own(file.theme.tokens, token.value.tokenId)) throw invalid('Token alias target is missing')
  }
  for (const token of Object.values(file.theme.tokens)) {
    const visited = new Set<string>()
    let current: ColorToken | undefined = token
    while (current?.value.kind === 'alias') {
      if (visited.has(current.id)) throw invalid('Token aliases cannot form a cycle')
      visited.add(current.id)
      current = file.theme.tokens[current.value.tokenId]
    }
  }
  for (const node of Object.values(file.nodes)) {
    if (node.type === 'root' || !node.appearance) continue
    for (const value of appearanceColors(node.appearance)) if (value.kind === 'token' && !own(file.theme.tokens, value.tokenId)) throw invalid('A fill references a missing token')
    for (const assetId of assetReferences(node.appearance)) if (!file.assets || !own(file.assets, assetId)) throw invalid('An image fill references a missing asset')
  }

  const roots = new Set<string>()
  const pageIds = new Set<string>()
  for (const page of file.pages) {
    if (!record(page)) throw invalid('Invalid page')
    fields(page, ['id', 'name', 'rootNodeId', ...(own(page, 'background') ? ['background'] : [])], 'page')
    if (!validId(page.id) || pageIds.has(page.id) || !validName(page.name) || !validId(page.rootNodeId) || roots.has(page.rootNodeId)) throw invalid('Invalid page identity')
    if (own(page, 'background') && !isColorValue(page.background)) throw invalid('Invalid page background')
    if (page.background?.kind === 'token' && !own(file.theme.tokens, page.background.tokenId)) throw invalid('A page background references a missing token')
    const root = file.nodes[page.rootNodeId]
    if (!root || root.type !== 'root') throw invalid('A page root is missing')
    if (own(file.relationships, page.rootNodeId)) throw invalid('Page roots cannot have a parent')
    pageIds.add(page.id); roots.add(page.rootNodeId)
  }
  for (const [nodeId, node] of Object.entries(file.nodes)) {
    if (node.type === 'root') { if (!roots.has(nodeId)) throw invalid('A root node belongs to no page'); continue }
    const relationship = file.relationships[nodeId]
    if (!relationship) throw invalid('A node has no parent')
  }
  for (const [nodeId, relationship] of Object.entries(file.relationships)) {
    if (!record(relationship) || !own(file.nodes, nodeId)) throw invalid('A relationship names a missing node')
    fields(relationship, ['parentId', 'orderKey', ...(own(relationship, 'slot') ? ['slot'] : [])], 'relationship')
    if (!validId(relationship.parentId) || !isOrderKey(relationship.orderKey) || (own(relationship, 'slot') && typeof relationship.slot !== 'string')) throw invalid('Invalid relationship')
    const parent = file.nodes[relationship.parentId]
    if (!parent) throw invalid('A node parent is missing')
    if (!acceptsChild(parent, file.nodes[nodeId]!, relationship.slot, atoms)) throw invalid('A node cannot live under that parent')
  }
  // Every node reaches a page root without cycles.
  const reach = new Map<string, string>()
  for (const nodeId of Object.keys(file.nodes)) {
    const trail: string[] = []
    let current: string | undefined = nodeId
    let depth = 0
    while (current && !reach.has(current)) {
      if (trail.includes(current)) throw invalid('Node hierarchy contains a cycle')
      if (depth++ > limits.depth) throw invalid('Node nesting exceeds the supported limit')
      trail.push(current)
      const relationship: NodeRelationship | undefined = file.relationships[current]
      if (!relationship) { if (!roots.has(current)) throw invalid('A node is detached from every page'); break }
      current = relationship.parentId
    }
    const root = current && reach.has(current) ? reach.get(current)! : current!
    for (const id of trail) reach.set(id, root)
  }
  for (const node of Object.values(file.nodes)) {
    if (node.type !== 'component') continue
    const atom = atoms.find(candidate => candidate.componentId === node.componentId)!
    const children: Record<string, string[]> = {}
    for (const [childId, relationship] of Object.entries(file.relationships)) if (relationship.parentId === node.id && relationship.slot) (children[relationship.slot] ??= []).push(childId)
    validateProps({ props: node.props, children }, atom)
  }
  if (JSON.stringify(file).length > limits.bytes) throw invalid('Design file exceeds the supported size')
  return structuredClone(file)
}

// Derived views -----------------------------------------------------------------------------------------------------

export type FileIndex = {
  children: Map<string, string[]>
  pageOfNode: Map<string, string>
}
const indexes = new WeakMap<FileDocument, FileIndex>()

export function indexFile(file: FileDocument): FileIndex {
  const cached = indexes.get(file)
  if (cached) return cached
  const children = new Map<string, string[]>()
  const entries = Object.entries(file.relationships).map(([id, relationship]) => ({ id, orderKey: relationship.orderKey, parentId: relationship.parentId })).sort(compareOrder)
  for (const entry of entries) { if (!children.has(entry.parentId)) children.set(entry.parentId, []); children.get(entry.parentId)!.push(entry.id) }
  const pageOfNode = new Map<string, string>()
  for (const page of file.pages) {
    const stack = [page.rootNodeId]
    while (stack.length) { const id = stack.pop()!; pageOfNode.set(id, page.id); for (const child of children.get(id) ?? []) stack.push(child) }
  }
  const index = { children, pageOfNode }
  indexes.set(file, index)
  return index
}

export function childrenOf(file: FileDocument, parentId: string, slot?: string): string[] {
  const all = indexFile(file).children.get(parentId) ?? []
  return slot === undefined ? all : all.filter(id => file.relationships[id]?.slot === slot)
}
export const pageOfNode = (file: FileDocument, nodeId: string): string | null => indexFile(file).pageOfNode.get(nodeId) ?? null
export const pageRoot = (file: FileDocument, pageId: string): string | null => file.pages.find(page => page.id === pageId)?.rootNodeId ?? null
/** Pre-order node ids of a page, excluding the structural root. */
export function pageNodes(file: FileDocument, pageId: string): string[] {
  const root = pageRoot(file, pageId)
  if (!root) return []
  const result: string[] = []
  const visit = (id: string) => { for (const child of childrenOf(file, id)) { result.push(child); visit(child) } }
  visit(root)
  return result
}
export function ancestorsOf(file: FileDocument, nodeId: string): string[] {
  const chain: string[] = []
  let current = file.relationships[nodeId]?.parentId
  const seen = new Set([nodeId])
  while (current && !seen.has(current)) { seen.add(current); chain.push(current); current = file.relationships[current]?.parentId }
  return chain
}
export function descendantsOf(file: FileDocument, nodeId: string): string[] {
  const result: string[] = []
  const visit = (id: string) => { for (const child of childrenOf(file, id)) { result.push(child); visit(child) } }
  visit(nodeId)
  return result
}

/** A direct lock also locks every descendant, matching the interaction model used by the canvas and layer tree. */
export function nodeIsLocked(file: FileDocument, nodeId: string): boolean {
  const visited = new Set<string>()
  let current: string | undefined = nodeId
  while (current && !visited.has(current)) {
    visited.add(current)
    const node = file.nodes[current]
    if (!node) return false
    if (node.type !== 'root' && node.isLocked === true) return true
    current = file.relationships[current]?.parentId
  }
  return false
}
/** World position of a primitive or absolutely placed component: parent-local offsets accumulated up to the page root. */
export function worldPosition(file: FileDocument, nodeId: string): { x: number; y: number } {
  let x = 0, y = 0
  let current: string | undefined = nodeId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const node: FileNode | undefined = file.nodes[current]
    if (!node) break
    if (node.type === 'component') { const placement = legacyLayout(node.layout); if (placement.mode === 'absolute') { x += placement.x; y += placement.y } }
    else if (node.type !== 'root') { x += node.styles.left; y += node.styles.top }
    current = file.relationships[current]?.parentId
  }
  return { x, y }
}
export function worldRect(file: FileDocument, nodeId: string): Rect | null {
  const node = file.nodes[nodeId]
  if (!node) return null
  const position = worldPosition(file, nodeId)
  if (node.type === 'component') { const placement = legacyLayout(node.layout); return placement.mode === 'absolute' && placement.width !== undefined && placement.height !== undefined ? { x: position.x, y: position.y, width: placement.width, height: placement.height } : null }
  if (node.type === 'root') return null
  return { x: position.x, y: position.y, width: node.styles.width, height: node.styles.height }
}
/** Deepest frame on a page containing a world point, ignoring a subtree. */
export function frameAt(file: FileDocument, pageId: string, point: { x: number; y: number }, excludedId?: string): string | null {
  let best: { id: string; depth: number } | null = null
  const excluded = excludedId ? new Set([excludedId, ...descendantsOf(file, excludedId)]) : new Set<string>()
  for (const id of pageNodes(file, pageId)) {
    const node = file.nodes[id]
    if (!node || node.type !== 'frame' || excluded.has(id)) continue
    const rect = worldRect(file, id)!
    if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) continue
    const depth = ancestorsOf(file, id).length
    if (!best || depth >= best.depth) best = { id, depth }
  }
  return best?.id ?? null
}

// Token resolution --------------------------------------------------------------------------------------------------

export function resolveToken(theme: FileTheme, tokenId: string, sources: SourcePalette = {}, visited = new Set<string>()): Color | null {
  const token = theme.tokens[tokenId]
  if (!token || visited.has(tokenId) || visited.size > limits.depth) return null
  visited.add(tokenId)
  if (token.value.kind === 'literal') return token.value.color
  if (token.value.kind === 'source') return sources[token.value.property] ?? token.value.fallback
  return resolveToken(theme, token.value.tokenId, sources, visited)
}
export const resolveColorValue = (theme: FileTheme, value: ColorValue, sources: SourcePalette = {}): Color | null => value.kind === 'literal' ? value.color : resolveToken(theme, value.tokenId, sources)
/** The appearance of any non-root node (primitives and component instances share one model). */
export const nodeAppearance = (node: FileNode | undefined): Appearance | undefined => node && node.type !== 'root' ? node.appearance : undefined
export type TokenReference = { nodeId: string } | { pageId: string } | { aliasTokenId: string }
/** One entry per bound color (page backgrounds, fills, stops, cached states, outline, borders) plus dependent aliases. */
export function tokenReferences(file: FileDocument, tokenId: string): TokenReference[] {
  const references: TokenReference[] = []
  for (const page of file.pages) if (page.background?.kind === 'token' && page.background.tokenId === tokenId) references.push({ pageId: page.id })
  for (const node of Object.values(file.nodes)) {
    const appearance = nodeAppearance(node)
    if (!appearance) continue
    for (const value of appearanceColors(appearance)) if (value.kind === 'token' && value.tokenId === tokenId) references.push({ nodeId: node.id })
  }
  for (const token of Object.values(file.theme.tokens)) if (token.value.kind === 'alias' && token.value.tokenId === tokenId) references.push({ aliasTokenId: token.id })
  return references
}
export function wouldCreateAliasCycle(theme: FileTheme, tokenId: string, targetId: string): boolean {
  let current: string | undefined = targetId
  const seen = new Set<string>()
  while (current && !seen.has(current)) { if (current === tokenId) return true; seen.add(current); const token: ColorToken | undefined = theme.tokens[current]; current = token?.value.kind === 'alias' ? token.value.tokenId : undefined }
  return false
}

// Construction ------------------------------------------------------------------------------------------------------

export function createBlankFile(fileId: string, pageId: string, rootNodeId: string, pageName = 'Page 1'): FileDocument {
  return { schemaVersion: fileSchemaVersion, fileId, revision: 0, pages: [{ id: pageId, name: pageName, rootNodeId }], nodes: { [rootNodeId]: { id: rootNodeId, type: 'root' } }, relationships: {}, theme: { tokens: {} } }
}

/** Legacy per-page view used by code output, promotion, and source bindings: component nodes with slot children. */
export function legacyPageDocument(file: FileDocument, pageId: string): EditorDocument {
  const root = pageRoot(file, pageId)
  const page = file.pages.find(candidate => candidate.id === pageId)
  if (!root || !page) throw invalid('Unknown page')
  const nodes: EditorDocument['nodes'] = {}
  const visit = (id: string) => {
    const node = file.nodes[id]
    if (!node || node.type !== 'component') return
    const children: Record<string, string[]> = {}
    for (const childId of childrenOf(file, id)) { const slot = file.relationships[childId]?.slot; if (slot) (children[slot] ??= []).push(childId); visit(childId) }
    nodes[id] = { id, componentId: node.componentId, exportName: node.exportName, props: structuredClone(node.props), children, ...(node.name !== undefined ? { name: node.name } : {}), ...(node.layout ? { layout: legacyLayout(node.layout) } : {}) }
  }
  const rootIds = childrenOf(file, root).filter(id => file.nodes[id]?.type === 'component')
  for (const id of rootIds) visit(id)
  return { version: 1, revision: file.revision, rootIds, nodes, frame: { ...flowHost, name: page.name } }
}

// Commands -----------------------------------------------------------------------------------------------------------

export type NodePlacement = { parentId: string; slot?: string; orderKey?: string; index?: number }
export type PrimitiveStylePatch = {
  left?: number
  top?: number
  width?: number
  height?: number
  rotation?: number | null
  flipX?: boolean | null
  flipY?: boolean | null
  overflow?: PrimitiveStyles['overflow'] | null
}
export type FileCommand =
  | { type: 'page.create'; page: FilePage; index?: number }
  | { type: 'page.rename'; pageId: string; name: string }
  | { type: 'page.setBackground'; pageId: string; background: ColorValue | null }
  | { type: 'page.reorder'; pageId: string; index: number }
  | { type: 'page.delete'; pageId: string }
  /** Copies every node of a page under a new root; `ids` maps each copied node id to its new identity. */
  | { type: 'page.duplicate'; pageId: string; page: FilePage; ids: Record<string, string> }
  | { type: 'node.insert'; node: FileNode; placement: NodePlacement }
  | { type: 'node.rename'; nodeId: string; name: string | null }
  | { type: 'node.setLocked'; nodeId: string; isLocked: boolean }
  /** Partial geometry update; `null` removes an optional stored style such as `rotation`. */
  | { type: 'node.setStyles'; nodeId: string; styles: PrimitiveStylePatch }
  | { type: 'node.setText'; nodeId: string; text: string }
  /** Replaces the whole appearance record (null clears it). Used by gesture commits; narrower commands below are preferred. */
  | { type: 'node.setAppearance'; nodeId: string; appearance: Appearance | null }
  | { type: 'node.setBlending'; nodeId: string; visible?: boolean; opacity?: number; blendMode?: BlendMode }
  /** Appends a topmost fill; without `paint` the node kind's default solid is seeded. */
  | { type: 'node.fill.add'; nodeId: string; paint?: Paint }
  | { type: 'node.fill.update'; nodeId: string; fillId: string; paint: Paint }
  | { type: 'node.fill.move'; nodeId: string; fillId: string; index: number }
  | { type: 'node.fill.remove'; nodeId: string; fillId: string }
  | { type: 'node.fill.replace'; nodeId: string; fills: Paint[] }
  | { type: 'node.outline.set'; nodeId: string; outline: Outline | null }
  | { type: 'node.borders.set'; nodeId: string; borders: Borders | null }
  | { type: 'node.border.update'; nodeId: string; side: BorderSide | 'all'; stroke: Stroke }
  | { type: 'node.border.remove'; nodeId: string; side: BorderSide | 'all' }
  | { type: 'asset.attach'; asset: ImageAssetReference }
  /** Removes an asset nobody references; referenced assets are refused. */
  | { type: 'asset.detach'; assetId: string }
  | { type: 'node.setProps'; nodeId: string; props: Record<string, DocumentValue>; remove?: string[] }
  | { type: 'node.setLayout'; nodeId: string; layout: NodeLayout | null }
  /** Stored theme choice for one node; descendants that inherit follow it. Touches nothing else on the node. */
  | { type: 'node.setThemeMode'; nodeId: string; themeMode: NodeThemeMode | null }
  | { type: 'node.reparent'; nodeId: string; placement: NodePlacement; preserveWorldPosition?: boolean }
  | { type: 'node.reorder'; nodeId: string; index: number }
  | { type: 'node.delete'; nodeIds: string[] }
  /** Copies a subtree beside its source; `ids` maps every copied node id to a new identity. */
  | { type: 'node.duplicate'; nodeId: string; ids: Record<string, string>; offset?: { x: number; y: number } }
  | { type: 'token.create'; token: ColorToken }
  | { type: 'token.rename'; tokenId: string; name: string }
  | { type: 'token.setValue'; tokenId: string; value: TokenValue }
  | { type: 'token.setDescription'; tokenId: string; description: string }
  | { type: 'token.reorder'; tokenId: string; index: number }
  | { type: 'token.duplicate'; tokenId: string; newId: string; name: string }
  /** Replaces every reference with the resolved color across the whole file, then removes the tokens. */
  | { type: 'token.delete'; tokenIds: string[]; sources?: SourcePalette }
  | { type: 'batch'; commands: FileCommand[] }

export type FileCommandValidationLimits = Readonly<{
  maxBatchCommands?: number
  maxDepth?: number
  maxBytes?: number
}>

const commandDefaults = { maxBatchCommands: 1000, maxDepth: 64, maxBytes: 4_000_000 } as const

function commandFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => own(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function commandJson(value: unknown, depth: number, maxDepth: number): boolean {
  if (depth > maxDepth) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => commandJson(item, depth + 1, maxDepth))
  if (!record(value)) return false
  return Object.entries(value).every(([key, item]) => !forbiddenKeys.has(key) && commandJson(item, depth + 1, maxDepth))
}

const commandIndex = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const commandIds = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= limits.nodes && value.every(validId) && new Set(value).size === value.length
const commandFinite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limits.coordinate
const commandPropName = (value: unknown) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) && !forbiddenKeys.has(value) && !/^on[A-Z]/.test(value) && !['style', 'dangerouslySetInnerHTML', 'ref', 'key'].includes(value)
const commandPropValue = (value: unknown): value is DocumentValue => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value)) && (typeof value !== 'string' || value.length <= 10_000)

function commandStringMap(value: unknown, allowEmpty = false): value is Record<string, string> {
  return record(value) && (allowEmpty || Object.keys(value).length > 0) && Object.keys(value).length <= limits.nodes && Object.entries(value).every(([key, item]) => validId(key) && validId(item)) && new Set(Object.values(value)).size === Object.keys(value).length
}

function commandPlacement(value: unknown): value is NodePlacement {
  return record(value) && commandFields(value, ['parentId'], ['slot', 'orderKey', 'index']) && validId(value.parentId)
    && (!own(value, 'slot') || validId(value.slot)) && (!own(value, 'orderKey') || isOrderKey(value.orderKey))
    && (!own(value, 'index') || commandIndex(value.index))
}

function commandProps(value: unknown): value is Record<string, DocumentValue> {
  return record(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) => commandPropName(key) && commandPropValue(item))
}

function commandPage(value: unknown): value is FilePage {
  if (!record(value) || !commandFields(value, ['id', 'name', 'rootNodeId'], ['background']) || !validId(value.id) || !validName(value.name) || !validId(value.rootNodeId)) return false
  return !own(value, 'background') || isColorValue(value.background)
}

function commandTokenValue(value: unknown): value is TokenValue {
  if (!record(value)) return false
  if (value.kind === 'literal') return commandFields(value, ['kind', 'color']) && isColor(value.color)
  if (value.kind === 'alias') return commandFields(value, ['kind', 'tokenId']) && validId(value.tokenId)
  return value.kind === 'source' && commandFields(value, ['kind', 'property', 'fallback']) && sourceProperty(value.property) && isColor(value.fallback)
}

function commandToken(value: unknown): value is ColorToken {
  return record(value) && commandFields(value, ['id', 'type', 'name', 'orderKey', 'value'], ['description'])
    && validId(value.id) && value.type === 'color' && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 64
    && isOrderKey(value.orderKey) && commandTokenValue(value.value)
    && (!own(value, 'description') || typeof value.description === 'string' && value.description.length <= 500)
}

function commandNode(value: unknown): value is FileNode {
  if (!record(value) || !validId(value.id) || value.type === 'root') return false
  if (value.type === 'component') {
    if (!commandFields(value, ['id', 'type', 'componentId', 'exportName', 'props'], ['name', 'layout', 'appearance', 'themeMode', 'isLocked']) || !validId(value.componentId) || typeof value.exportName !== 'string' || !commandProps(value.props)) return false
    if (own(value, 'name') && !validName(value.name)) return false
    if (own(value, 'layout') && !validateLayout(value.layout)) return false
    if (own(value, 'appearance')) validateAppearance(value.appearance, 'component')
    return (!own(value, 'themeMode') || isNodeThemeMode(value.themeMode)) && (!own(value, 'isLocked') || typeof value.isLocked === 'boolean')
  }
  if (!(primitiveKinds as readonly unknown[]).includes(value.type)) return false
  if (!commandFields(value, ['id', 'type', 'name', 'styles'], ['appearance', 'text', 'themeMode', 'isLocked']) || !validName(value.name) || !validateStyles(value.styles, value.type as PrimitiveKind)) return false
  if (own(value, 'appearance')) validateAppearance(value.appearance, value.type as PrimitiveKind)
  if (value.type === 'text' ? typeof value.text !== 'string' || value.text.length > 10_000 : own(value, 'text')) return false
  return (!own(value, 'themeMode') || isNodeThemeMode(value.themeMode)) && (!own(value, 'isLocked') || typeof value.isLocked === 'boolean')
}

function commandAppearance(value: unknown): value is Appearance {
  if (!record(value)) return false
  for (const kind of ['frame', 'rectangle', 'shape', 'shader', 'text', 'component'] as const) {
    try { validateAppearance(value, kind); return true } catch { continue }
  }
  return false
}

function commandSourcePalette(value: unknown): value is SourcePalette {
  return record(value) && Object.entries(value).every(([key, color]) => sourceProperty(key) && isColor(color))
}

function validateCommandShape(value: unknown, limitsValue: Required<FileCommandValidationLimits>, depth: number, budget: { remaining: number }): value is FileCommand {
  if (!record(value) || typeof value.type !== 'string' || depth > limitsValue.maxDepth) return false
  if (value.type !== 'batch' && --budget.remaining < 0) return false
  switch (value.type) {
    case 'page.create': return commandFields(value, ['type', 'page'], ['index']) && commandPage(value.page) && (!own(value, 'index') || commandIndex(value.index))
    case 'page.rename': return commandFields(value, ['type', 'pageId', 'name']) && validId(value.pageId) && validName(value.name)
    case 'page.setBackground': return commandFields(value, ['type', 'pageId', 'background']) && validId(value.pageId) && (value.background === null || isColorValue(value.background))
    case 'page.reorder': return commandFields(value, ['type', 'pageId', 'index']) && validId(value.pageId) && commandIndex(value.index)
    case 'page.delete': return commandFields(value, ['type', 'pageId']) && validId(value.pageId)
    case 'page.duplicate': return commandFields(value, ['type', 'pageId', 'page', 'ids']) && validId(value.pageId) && commandPage(value.page) && commandStringMap(value.ids, true)
    case 'node.insert': return commandFields(value, ['type', 'node', 'placement']) && commandNode(value.node) && commandPlacement(value.placement)
    case 'node.rename': return commandFields(value, ['type', 'nodeId', 'name']) && validId(value.nodeId) && (value.name === null || validName(value.name))
    case 'node.setLocked': return commandFields(value, ['type', 'nodeId', 'isLocked']) && validId(value.nodeId) && typeof value.isLocked === 'boolean'
    case 'node.setStyles': {
      if (!commandFields(value, ['type', 'nodeId', 'styles']) || !validId(value.nodeId) || !record(value.styles) || Object.keys(value.styles).length === 0) return false
      const styles = value.styles
      if (Object.keys(styles).some(key => !['left', 'top', 'width', 'height', 'rotation', 'flipX', 'flipY', 'overflow'].includes(key))) return false
      if (['left', 'top', 'width', 'height'].some(key => styles[key] === null)) return false
      const geometry: Record<string, unknown> = { left: 0, top: 0, width: 1, height: 1 }
      for (const [key, item] of Object.entries(styles)) if (item !== null) geometry[key] = item
      return validateStyles(geometry, own(styles, 'overflow') ? 'frame' : 'rectangle')
    }
    case 'node.setText': return commandFields(value, ['type', 'nodeId', 'text']) && validId(value.nodeId) && typeof value.text === 'string' && value.text.length <= 10_000
    case 'node.setAppearance': return commandFields(value, ['type', 'nodeId', 'appearance']) && validId(value.nodeId) && (value.appearance === null || commandAppearance(value.appearance))
    case 'node.setBlending': return commandFields(value, ['type', 'nodeId'], ['visible', 'opacity', 'blendMode']) && validId(value.nodeId)
      && ['visible', 'opacity', 'blendMode'].some(key => own(value, key))
      && (!own(value, 'visible') || typeof value.visible === 'boolean')
      && (!own(value, 'opacity') || typeof value.opacity === 'number' && Number.isFinite(value.opacity) && value.opacity >= 0 && value.opacity <= 1)
      && (!own(value, 'blendMode') || (blendModes as readonly unknown[]).includes(value.blendMode))
    case 'node.fill.add': return commandFields(value, ['type', 'nodeId'], ['paint']) && validId(value.nodeId) && (!own(value, 'paint') || Boolean(validatePaint(value.paint)))
    case 'node.fill.update': return commandFields(value, ['type', 'nodeId', 'fillId', 'paint']) && validId(value.nodeId) && validId(value.fillId) && validatePaint(value.paint).id === value.fillId
    case 'node.fill.move': return commandFields(value, ['type', 'nodeId', 'fillId', 'index']) && validId(value.nodeId) && validId(value.fillId) && commandIndex(value.index)
    case 'node.fill.remove': return commandFields(value, ['type', 'nodeId', 'fillId']) && validId(value.nodeId) && validId(value.fillId)
    case 'node.fill.replace': return commandFields(value, ['type', 'nodeId', 'fills']) && validId(value.nodeId) && Array.isArray(value.fills) && value.fills.length <= 16 && value.fills.every(fill => Boolean(validatePaint(fill)))
    case 'node.outline.set': return commandFields(value, ['type', 'nodeId', 'outline']) && validId(value.nodeId) && (value.outline === null || Boolean(validateOutline(value.outline)))
    case 'node.borders.set': return commandFields(value, ['type', 'nodeId', 'borders']) && validId(value.nodeId) && (value.borders === null || Boolean(validateBorders(value.borders)))
    case 'node.border.update': return commandFields(value, ['type', 'nodeId', 'side', 'stroke']) && validId(value.nodeId) && (value.side === 'all' || (borderSides as readonly unknown[]).includes(value.side)) && Boolean(validateStroke(value.stroke, 'border'))
    case 'node.border.remove': return commandFields(value, ['type', 'nodeId', 'side']) && validId(value.nodeId) && (value.side === 'all' || (borderSides as readonly unknown[]).includes(value.side))
    case 'asset.attach': return commandFields(value, ['type', 'asset']) && Boolean(validateImageAssetReference(value.asset))
    case 'asset.detach': return commandFields(value, ['type', 'assetId']) && validId(value.assetId)
    case 'node.setProps': return commandFields(value, ['type', 'nodeId', 'props'], ['remove']) && validId(value.nodeId) && commandProps(value.props)
      && (!own(value, 'remove') || Array.isArray(value.remove) && value.remove.length <= 100 && value.remove.every(commandPropName) && new Set(value.remove).size === value.remove.length)
    case 'node.setLayout': return commandFields(value, ['type', 'nodeId', 'layout']) && validId(value.nodeId) && (value.layout === null || validateLayout(value.layout))
    case 'node.setThemeMode': return commandFields(value, ['type', 'nodeId', 'themeMode']) && validId(value.nodeId) && (value.themeMode === null || isNodeThemeMode(value.themeMode))
    case 'node.reparent': return commandFields(value, ['type', 'nodeId', 'placement'], ['preserveWorldPosition']) && validId(value.nodeId) && commandPlacement(value.placement) && (!own(value, 'preserveWorldPosition') || typeof value.preserveWorldPosition === 'boolean')
    case 'node.reorder': return commandFields(value, ['type', 'nodeId', 'index']) && validId(value.nodeId) && commandIndex(value.index)
    case 'node.delete': return commandFields(value, ['type', 'nodeIds']) && commandIds(value.nodeIds)
    case 'node.duplicate': return commandFields(value, ['type', 'nodeId', 'ids'], ['offset']) && validId(value.nodeId) && commandStringMap(value.ids)
      && (!own(value, 'offset') || record(value.offset) && commandFields(value.offset, ['x', 'y']) && commandFinite(value.offset.x) && commandFinite(value.offset.y))
    case 'token.create': return commandFields(value, ['type', 'token']) && commandToken(value.token)
    case 'token.rename': return commandFields(value, ['type', 'tokenId', 'name']) && validId(value.tokenId) && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 64
    case 'token.setValue': return commandFields(value, ['type', 'tokenId', 'value']) && validId(value.tokenId) && commandTokenValue(value.value)
    case 'token.setDescription': return commandFields(value, ['type', 'tokenId', 'description']) && validId(value.tokenId) && typeof value.description === 'string' && value.description.length <= 500
    case 'token.reorder': return commandFields(value, ['type', 'tokenId', 'index']) && validId(value.tokenId) && commandIndex(value.index)
    case 'token.duplicate': return commandFields(value, ['type', 'tokenId', 'newId', 'name']) && validId(value.tokenId) && validId(value.newId) && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 64
    case 'token.delete': return commandFields(value, ['type', 'tokenIds'], ['sources']) && commandIds(value.tokenIds) && (!own(value, 'sources') || commandSourcePalette(value.sources))
    case 'batch': return commandFields(value, ['type', 'commands']) && Array.isArray(value.commands) && value.commands.length > 0 && value.commands.every(command => validateCommandShape(command, limitsValue, depth + 1, budget))
    default: return false
  }
}

/** The single closed runtime schema for commands accepted by local editing and collaboration. */
export function validateFileCommand(value: unknown, validationLimits: FileCommandValidationLimits = {}): FileCommand {
  const resolved = { ...commandDefaults, ...validationLimits }
  if (!Number.isSafeInteger(resolved.maxBatchCommands) || resolved.maxBatchCommands < 1 || !Number.isSafeInteger(resolved.maxDepth) || resolved.maxDepth < 1 || !Number.isSafeInteger(resolved.maxBytes) || resolved.maxBytes < 1) throw invalid('Invalid file command limits')
  if (!commandJson(value, 0, resolved.maxDepth)) throw invalid('Invalid file command')
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > resolved.maxBytes || !validateCommandShape(value, resolved, 0, { remaining: resolved.maxBatchCommands })) throw invalid('Invalid file command')
  return structuredClone(value) as FileCommand
}

type HostedComponentShape = Readonly<{ componentId: string; exportName: string; props: Readonly<Record<string, DocumentValue>>; slots: readonly string[] }>

function hostedComponentShapes(file: FileDocument): HostedComponentShape[] {
  const slots = new Map<string, Set<string>>()
  for (const relationship of Object.values(file.relationships)) {
    if (relationship.slot === undefined) continue
    const current = slots.get(relationship.parentId) ?? new Set<string>()
    current.add(relationship.slot)
    slots.set(relationship.parentId, current)
  }
  return Object.values(file.nodes).flatMap(node => node.type === 'component'
    ? [{ componentId: node.componentId, exportName: node.exportName, props: node.props, slots: [...(slots.get(node.id) ?? [])] }]
    : [])
}

/** Synthetic unavailable bindings used only to validate hosted document structure, never source compatibility. */
export function hostedFileAtoms(file: FileDocument): Atom[] {
  const groups = new Map<string, HostedComponentShape[]>()
  for (const shape of hostedComponentShapes(file)) {
    const current = groups.get(shape.componentId) ?? []
    current.push(shape)
    groups.set(shape.componentId, current)
  }
  return [...groups].map(([componentId, shapes]) => {
    const exports = new Set(shapes.map(shape => shape.exportName))
    if (exports.size !== 1) throw invalid('Component identity is inconsistent')
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
      kind: 'atom' as const,
      path: '', fingerprint: '', sourceHash: '', status: 'missing' as const, candidates: [],
      props: [...propTypes].map(([name, types]) => ({ name, type: [...types].sort().join(' | '), optional: true })),
    }
  })
}

const bump = (file: FileDocument) => { file.revision += 1 }

function placeRelationship(file: FileDocument, nodeId: string, placement: NodePlacement, atoms: Atom[]): NodeRelationship {
  const parent = file.nodes[placement.parentId]
  const node = file.nodes[nodeId]
  if (!parent || !node) throw invalid('Select an existing node')
  if (!acceptsChild(parent, node, placement.slot, atoms)) throw invalid('That node cannot be placed there')
  const siblings = childrenOf(file, placement.parentId, placement.slot).filter(id => id !== nodeId)
  let orderKey = placement.orderKey
  if (orderKey === undefined) {
    const index = placement.index === undefined ? siblings.length : placement.index
    if (!Number.isInteger(index) || index < 0 || index > siblings.length) throw invalid('Invalid position')
    const before = index > 0 ? file.relationships[siblings[index - 1]!]!.orderKey : null
    const after = index < siblings.length ? file.relationships[siblings[index]!]!.orderKey : null
    orderKey = before !== null && after !== null && before >= after ? orderKeyBetween(before, null) : orderKeyBetween(before, after)
  } else if (!isOrderKey(orderKey)) throw invalid('Invalid order key')
  return { parentId: placement.parentId, orderKey, ...(placement.slot !== undefined ? { slot: placement.slot } : {}) }
}

function removeSubtree(file: FileDocument, nodeId: string) {
  for (const id of [nodeId, ...descendantsOf(file, nodeId)]) { delete file.nodes[id]; delete file.relationships[id] }
}

function copySubtree(file: FileDocument, sourceId: string, ids: Record<string, string>, placement: NodePlacement, atoms: Atom[]) {
  const subtree = [sourceId, ...descendantsOf(file, sourceId)]
  if (Object.keys(ids).length !== subtree.length || subtree.some(id => !own(ids, id))) throw invalid('Provide a new identity for every copied node')
  const assigned = new Set<string>()
  for (const id of subtree) { const next = ids[id]!; if (!validId(next) || own(file.nodes, next) || assigned.has(next)) throw invalid('Copied nodes need unique new identities'); assigned.add(next) }
  const working = structuredClone(file)
  for (const id of subtree) { const original = working.nodes[id]!; working.nodes[ids[id]!] = { ...structuredClone(original), id: ids[id]! } }
  for (const id of subtree) {
    if (id === sourceId) continue
    const relationship = working.relationships[id]!
    working.relationships[ids[id]!] = { ...relationship, parentId: ids[relationship.parentId]! }
  }
  working.relationships[ids[sourceId]!] = placeRelationship(working, ids[sourceId]!, placement, atoms)
  return working
}

/** Any node that carries appearance: a primitive or a component instance. */
function styled(file: FileDocument, nodeId: string): PrimitiveNode | ComponentNode {
  const node = file.nodes[nodeId]
  if (!node || node.type === 'root') throw invalid('Select a design node')
  return node
}
/** Canonicalizes and writes an appearance record, dropping the field when nothing remains. */
function writeAppearance(node: PrimitiveNode | ComponentNode, appearance: Appearance | undefined) {
  const canonical = canonicalAppearance(appearance)
  if (canonical) { validateAppearance(canonical, node.type); node.appearance = canonical } else delete node.appearance
}
function primitive(file: FileDocument, nodeId: string): PrimitiveNode {
  const node = file.nodes[nodeId]
  if (!node || node.type === 'root' || node.type === 'component') throw invalid('Select a design node')
  return node
}
function component(file: FileDocument, nodeId: string): ComponentNode {
  const node = file.nodes[nodeId]
  if (!node || node.type !== 'component') throw invalid('Select a component instance')
  return node
}
function token(file: FileDocument, tokenId: string): ColorToken {
  const found = file.theme.tokens[tokenId]
  if (!found) throw invalid('Select an existing token')
  return found
}
const orderedTokens = (theme: FileTheme) => Object.values(theme.tokens).sort(compareOrder)

function apply(file: FileDocument, command: FileCommand, atoms: Atom[]): FileDocument {
  // Commands mutate `file` in place, so a cached index from an earlier batch step would be stale.
  indexes.delete(file)
  switch (command.type) {
    case 'batch': {
      if (!Array.isArray(command.commands) || !command.commands.length || command.commands.length > 1000) throw invalid('Invalid command batch')
      let working = file
      for (const inner of command.commands) working = apply(working, inner, atoms)
      return working
    }
    case 'page.create': {
      if (file.pages.length >= limits.pages) throw invalid(`A file supports up to ${limits.pages} pages`)
      if (!validId(command.page.id) || !validId(command.page.rootNodeId) || own(file.nodes, command.page.rootNodeId) || file.pages.some(page => page.id === command.page.id) || !validName(command.page.name)) throw invalid('Invalid page')
      const index = command.index ?? file.pages.length
      if (!Number.isInteger(index) || index < 0 || index > file.pages.length) throw invalid('Invalid page position')
      if (command.page.background !== undefined && !isColorValue(command.page.background)) throw invalid('Invalid page background')
      if (command.page.background?.kind === 'token' && !own(file.theme.tokens, command.page.background.tokenId)) throw invalid('A page background references a missing token')
      file.nodes[command.page.rootNodeId] = { id: command.page.rootNodeId, type: 'root' }
      file.pages.splice(index, 0, structuredClone(command.page))
      return file
    }
    case 'page.rename': {
      const page = file.pages.find(candidate => candidate.id === command.pageId)
      if (!page || !validName(command.name)) throw invalid('Invalid page name')
      page.name = command.name
      return file
    }
    case 'page.setBackground': {
      const page = file.pages.find(candidate => candidate.id === command.pageId)
      if (!page) throw invalid('Unknown page')
      if (command.background === null) delete page.background
      else {
        if (!isColorValue(command.background)) throw invalid('Invalid page background')
        if (command.background.kind === 'token' && !own(file.theme.tokens, command.background.tokenId)) throw invalid('A page background references a missing token')
        page.background = structuredClone(command.background)
      }
      return file
    }
    case 'page.reorder': {
      const from = file.pages.findIndex(page => page.id === command.pageId)
      if (from < 0 || !Number.isInteger(command.index) || command.index < 0 || command.index >= file.pages.length) throw invalid('Invalid page position')
      const [page] = file.pages.splice(from, 1)
      file.pages.splice(command.index, 0, page!)
      return file
    }
    case 'page.delete': {
      const page = file.pages.find(candidate => candidate.id === command.pageId)
      if (!page) throw invalid('Unknown page')
      if (file.pages.length === 1) throw invalid('A file keeps at least one page')
      removeSubtree(file, page.rootNodeId)
      file.pages = file.pages.filter(candidate => candidate.id !== command.pageId)
      return file
    }
    case 'page.duplicate': {
      const source = file.pages.find(candidate => candidate.id === command.pageId)
      if (!source) throw invalid('Unknown page')
      if (file.pages.length >= limits.pages) throw invalid(`A file supports up to ${limits.pages} pages`)
      if (!validId(command.page.id) || !validId(command.page.rootNodeId) || own(file.nodes, command.page.rootNodeId) || file.pages.some(page => page.id === command.page.id) || !validName(command.page.name)) throw invalid('Invalid page')
      const copied = descendantsOf(file, source.rootNodeId)
      if (Object.keys(command.ids).length !== copied.length || copied.some(id => !own(command.ids, id))) throw invalid('Provide a new identity for every copied node')
      const assigned = new Set<string>()
      for (const id of copied) { const next = command.ids[id]!; if (!validId(next) || own(file.nodes, next) || assigned.has(next) || next === command.page.rootNodeId) throw invalid('Copied nodes need unique new identities'); assigned.add(next) }
      file.nodes[command.page.rootNodeId] = { id: command.page.rootNodeId, type: 'root' }
      for (const id of copied) file.nodes[command.ids[id]!] = { ...structuredClone(file.nodes[id]!), id: command.ids[id]! }
      for (const id of copied) { const relationship = file.relationships[id]!; file.relationships[command.ids[id]!] = { ...relationship, parentId: relationship.parentId === source.rootNodeId ? command.page.rootNodeId : command.ids[relationship.parentId]! } }
      file.pages.splice(file.pages.indexOf(source) + 1, 0, { id: command.page.id, name: command.page.name, rootNodeId: command.page.rootNodeId, ...(source.background ? { background: structuredClone(source.background) } : {}) })
      return file
    }
    case 'node.insert': {
      if (!record(command.node) || !validId(command.node.id) || own(file.nodes, command.node.id) || command.node.type === 'root') throw invalid('Node identity is invalid')
      // New nodes always carry an explicit stored mode so the canonical v5 form is written, not inferred.
      file.nodes[command.node.id] = { ...structuredClone(command.node), themeMode: command.node.themeMode ?? 'inherit' }
      file.relationships[command.node.id] = placeRelationship(file, command.node.id, command.placement, atoms)
      return file
    }
    case 'node.rename': {
      const node = file.nodes[command.nodeId]
      if (!node || node.type === 'root' || (command.name !== null && !validName(command.name)) || (command.name === null && node.type !== 'component')) throw invalid('Invalid node name')
      if (command.name === null) delete node.name
      else node.name = command.name
      return file
    }
    case 'node.setLocked': {
      const node = file.nodes[command.nodeId]
      if (!node || node.type === 'root') throw invalid('Select an existing node')
      if (command.isLocked) node.isLocked = true
      else delete node.isLocked
      return file
    }
    case 'node.setStyles': {
      const node = primitive(file, command.nodeId)
      if (!record(command.styles)) throw invalid('Invalid node geometry')
      const next: Record<string, unknown> = { ...node.styles }
      for (const [key, value] of Object.entries(command.styles)) { if (value === null) delete next[key]; else next[key] = value }
      if (!validateStyles(next, node.type)) throw invalid('Invalid node geometry')
      node.styles = next
      return file
    }
    case 'node.setText': {
      const node = primitive(file, command.nodeId)
      if (node.type !== 'text' || typeof command.text !== 'string') throw invalid('Only text nodes carry text')
      node.text = command.text
      return file
    }
    case 'node.setAppearance': {
      const node = styled(file, command.nodeId)
      const input: unknown = structuredClone(command.appearance)
      // Gesture commits may carry node-level logical defaults (for example opacity scrubbed back to 1); drop them before strict validation.
      if (record(input)) { if (input.opacity === 1) delete input.opacity; if (input.blendMode === 'normal') delete input.blendMode; if (input.visible === true) delete input.visible }
      writeAppearance(node, input === null ? undefined : validateAppearance(input, node.type))
      return file
    }
    case 'node.setBlending': {
      const node = styled(file, command.nodeId)
      const next: Appearance = { ...(node.appearance ?? {}) }
      if (command.visible !== undefined) { if (typeof command.visible !== 'boolean') throw invalid('Invalid visibility'); if (command.visible) delete next.visible; else next.visible = false }
      if (command.opacity !== undefined) { if (typeof command.opacity !== 'number' || !Number.isFinite(command.opacity) || command.opacity < 0 || command.opacity > 1) throw invalid('Invalid node opacity'); if (command.opacity === 1) delete next.opacity; else next.opacity = command.opacity }
      if (command.blendMode !== undefined) { if (command.blendMode === 'normal') delete next.blendMode; else next.blendMode = command.blendMode }
      writeAppearance(node, next)
      return file
    }
    case 'node.fill.add': {
      const node = styled(file, command.nodeId)
      const fills = [...(node.appearance?.fills ?? [])]
      let sequence = fills.length + 1
      while (fills.some(existing => existing.id === `fill:${file.revision + 1}:${sequence}`)) sequence += 1
      const paint: Paint = command.paint ? validatePaint(structuredClone(command.paint)) : { id: `fill:${file.revision + 1}:${sequence}`, type: 'solid', color: defaultFillColor(node.type) }
      if (fills.some(existing => existing.id === paint.id)) throw invalid('Fills need unique identities')
      fills.push(paint)
      writeAppearance(node, { ...(node.appearance ?? {}), fills })
      return file
    }
    case 'node.fill.update': {
      const node = styled(file, command.nodeId)
      const fills = [...(node.appearance?.fills ?? [])]
      const index = fills.findIndex(existing => existing.id === command.fillId)
      if (index < 0) throw invalid('Select an existing fill')
      const paint = validatePaint(structuredClone(command.paint))
      if (paint.id !== command.fillId) throw invalid('A fill keeps its identity')
      fills[index] = paint
      writeAppearance(node, { ...(node.appearance ?? {}), fills })
      return file
    }
    case 'node.fill.move': {
      const node = styled(file, command.nodeId)
      const fills = [...(node.appearance?.fills ?? [])]
      const index = fills.findIndex(existing => existing.id === command.fillId)
      if (index < 0 || !Number.isInteger(command.index) || command.index < 0 || command.index >= fills.length) throw invalid('Invalid fill position')
      const [paint] = fills.splice(index, 1)
      fills.splice(command.index, 0, paint!)
      writeAppearance(node, { ...(node.appearance ?? {}), fills })
      return file
    }
    case 'node.fill.remove': {
      const node = styled(file, command.nodeId)
      const fills = (node.appearance?.fills ?? []).filter(existing => existing.id !== command.fillId)
      if (fills.length === (node.appearance?.fills?.length ?? 0)) throw invalid('Select an existing fill')
      const { fills: _fills, ...rest } = node.appearance ?? {}
      writeAppearance(node, fills.length ? { ...rest, fills } : rest)
      return file
    }
    case 'node.fill.replace': {
      const node = styled(file, command.nodeId)
      if (!Array.isArray(command.fills)) throw invalid('Invalid fills')
      const { fills: _fills, ...rest } = node.appearance ?? {}
      writeAppearance(node, command.fills.length ? { ...rest, fills: command.fills.map(paint => validatePaint(structuredClone(paint))) } : rest)
      return file
    }
    case 'node.outline.set': {
      const node = styled(file, command.nodeId)
      const { outline: _outline, ...rest } = node.appearance ?? {}
      writeAppearance(node, command.outline === null ? rest : { ...rest, outline: validateOutline(structuredClone(command.outline)) })
      return file
    }
    case 'node.borders.set': {
      const node = styled(file, command.nodeId)
      const { borders: _borders, ...rest } = node.appearance ?? {}
      writeAppearance(node, command.borders === null ? rest : { ...rest, borders: validateBorders(structuredClone(command.borders)) })
      return file
    }
    case 'node.border.update': {
      const node = styled(file, command.nodeId)
      const stroke = validateStroke(structuredClone(command.stroke), 'border')
      const current = node.appearance?.borders
      let borders: Borders
      if (command.side === 'all') borders = { all: stroke }
      else if (current && 'all' in current && current.all) { borders = Object.fromEntries(borderSides.map(side => [side, side === command.side ? stroke : current.all])) as Borders }
      else borders = { ...(current as Partial<Record<BorderSide, Stroke>> ?? {}), [command.side]: stroke }
      writeAppearance(node, { ...(node.appearance ?? {}), borders })
      return file
    }
    case 'node.border.remove': {
      const node = styled(file, command.nodeId)
      const current = node.appearance?.borders
      if (!current) throw invalid('This node has no borders')
      const { borders: _borders, ...rest } = node.appearance ?? {}
      if (command.side === 'all') { writeAppearance(node, rest); return file }
      // Removing one side of an `all` record keeps the other three sides.
      const sides: Partial<Record<BorderSide, Stroke>> = 'all' in current && current.all ? Object.fromEntries(borderSides.map(side => [side, current.all])) : { ...(current as Partial<Record<BorderSide, Stroke>>) }
      if (!sides[command.side]) throw invalid('That side has no border')
      delete sides[command.side]
      writeAppearance(node, Object.keys(sides).length ? { ...rest, borders: sides } : rest)
      return file
    }
    case 'asset.attach': {
      const asset = validateImageAssetReference(structuredClone(command.asset))
      if (file.assets && own(file.assets, asset.id)) throw invalid('Asset identity already exists')
      if (Object.keys(file.assets ?? {}).length >= limits.assets) throw invalid(`A file supports up to ${limits.assets} images`)
      file.assets = { ...(file.assets ?? {}), [asset.id]: asset }
      return file
    }
    case 'asset.detach': {
      if (!file.assets || !own(file.assets, command.assetId)) throw invalid('Select an existing image')
      for (const node of Object.values(file.nodes)) { const appearance = nodeAppearance(node); if (appearance && assetReferences(appearance).includes(command.assetId)) throw invalid('That image is still used by a fill') }
      const { [command.assetId]: _removed, ...rest } = file.assets
      if (Object.keys(rest).length) file.assets = rest; else delete file.assets
      return file
    }
    case 'node.setProps': {
      const node = component(file, command.nodeId)
      if (!record(command.props)) throw invalid('Invalid component props')
      node.props = { ...node.props, ...command.props }
      for (const name of command.remove ?? []) { if (typeof name !== 'string' || forbiddenKeys.has(name)) throw invalid('Invalid component props'); delete node.props[name] }
      return file
    }
    case 'node.setLayout': {
      const node = component(file, command.nodeId)
      if (command.layout === null) delete node.layout
      else { if (!validateLayout(command.layout)) throw invalid('Invalid component layout'); node.layout = structuredClone(command.layout) }
      return file
    }
    case 'node.setThemeMode': {
      const node = file.nodes[command.nodeId]
      if (!node || node.type === 'root') throw invalid('Select an existing node')
      if (command.themeMode === null) delete node.themeMode
      else {
        if (!isNodeThemeMode(command.themeMode)) throw invalid('Invalid node theme mode')
        node.themeMode = command.themeMode
      }
      return file
    }
    case 'node.reparent': {
      const node = file.nodes[command.nodeId]
      if (!node || node.type === 'root' || !own(file.relationships, command.nodeId)) throw invalid('Select an existing node')
      if (command.placement.parentId === command.nodeId || descendantsOf(file, command.nodeId).includes(command.placement.parentId)) throw invalid('A node cannot move inside its own subtree')
      const world = worldPosition(file, command.nodeId)
      const relationship = placeRelationship(file, command.nodeId, command.placement, atoms)
      const previousParent = file.relationships[command.nodeId]!.parentId
      file.relationships[command.nodeId] = relationship
      if (command.preserveWorldPosition && previousParent !== relationship.parentId && node.type !== 'component') {
        // newLocal = inverse(newParentWorld) x oldWorld, for unrotated parents a translation.
        const parentWorld = worldPosition(file, relationship.parentId)
        node.styles = { ...node.styles, left: world.x - parentWorld.x, top: world.y - parentWorld.y }
      }
      return file
    }
    case 'node.reorder': {
      const relationship = file.relationships[command.nodeId]
      if (!relationship) throw invalid('Select an existing node')
      const siblings = childrenOf(file, relationship.parentId, relationship.slot)
      const from = siblings.indexOf(command.nodeId)
      if (!Number.isInteger(command.index) || command.index < 0 || command.index >= siblings.length) throw invalid('Invalid position')
      if (from === command.index) return file
      const others = siblings.filter(id => id !== command.nodeId)
      const before = command.index > 0 ? file.relationships[others[command.index - 1]!]!.orderKey : null
      const after = command.index < others.length ? file.relationships[others[command.index]!]!.orderKey : null
      // Tied neighbour keys (possible after explicit keys) fall back to an open-ended key so the move still succeeds.
      file.relationships[command.nodeId] = { ...relationship, orderKey: before !== null && after !== null && before >= after ? orderKeyBetween(before, null) : orderKeyBetween(before, after) }
      return file
    }
    case 'node.delete': {
      if (!Array.isArray(command.nodeIds) || !command.nodeIds.length) throw invalid('Select a node')
      for (const id of command.nodeIds) { const node = file.nodes[id]; if (!node || node.type === 'root') throw invalid('Select an existing node') }
      for (const id of command.nodeIds) if (own(file.nodes, id)) removeSubtree(file, id)
      return file
    }
    case 'node.duplicate': {
      const relationship = file.relationships[command.nodeId]
      if (!relationship) throw invalid('Select an existing node')
      const siblings = childrenOf(file, relationship.parentId, relationship.slot)
      const next = copySubtree(file, command.nodeId, command.ids, { parentId: relationship.parentId, ...(relationship.slot !== undefined ? { slot: relationship.slot } : {}), index: siblings.indexOf(command.nodeId) + 1 }, atoms)
      const copy = next.nodes[command.ids[command.nodeId]!]!
      if (command.offset) {
        if (copy.type === 'component') { const position = copy.layout?.item.position; if (copy.layout && position?.mode === 'absolute' && position.left?.kind === 'px' && position.top?.kind === 'px') copy.layout = { ...copy.layout, item: { ...copy.layout.item, position: { ...position, left: { kind: 'px', value: position.left.value + command.offset.x }, top: { kind: 'px', value: position.top.value + command.offset.y } } } } }
        else if (copy.type !== 'root') copy.styles = { ...copy.styles, left: copy.styles.left + command.offset.x, top: copy.styles.top + command.offset.y }
      }
      return next
    }
    case 'token.create': {
      if (!record(command.token) || !validId(command.token.id) || own(file.theme.tokens, command.token.id)) throw invalid('Token identity is invalid')
      if (Object.keys(file.theme.tokens).length >= limits.tokens) throw invalid(`A file supports up to ${limits.tokens} tokens`)
      file.theme.tokens[command.token.id] = structuredClone(command.token)
      return file
    }
    case 'token.rename': {
      const target = token(file, command.tokenId)
      if (typeof command.name !== 'string' || !command.name.trim() || command.name.length > 64) throw invalid('Invalid token name')
      target.name = command.name
      return file
    }
    case 'token.setDescription': {
      const target = token(file, command.tokenId)
      if (typeof command.description !== 'string' || command.description.length > 500) throw invalid('Invalid token description')
      if (command.description) target.description = command.description; else delete target.description
      return file
    }
    case 'token.setValue': {
      const target = token(file, command.tokenId)
      if (!validateTokenValue(command.value)) throw invalid('Invalid token value')
      if (command.value.kind === 'alias') { if (!own(file.theme.tokens, command.value.tokenId)) throw invalid('Token alias target is missing'); if (command.value.tokenId === command.tokenId || wouldCreateAliasCycle(file.theme, command.tokenId, command.value.tokenId)) throw invalid('Token aliases cannot form a cycle') }
      target.value = structuredClone(command.value)
      return file
    }
    case 'token.reorder': {
      token(file, command.tokenId)
      const ordered = orderedTokens(file.theme)
      const others = ordered.filter(candidate => candidate.id !== command.tokenId)
      if (!Number.isInteger(command.index) || command.index < 0 || command.index >= ordered.length) throw invalid('Invalid position')
      const before = command.index > 0 ? others[command.index - 1]!.orderKey : null
      const after = command.index < others.length ? others[command.index]!.orderKey : null
      file.theme.tokens[command.tokenId]!.orderKey = before !== null && after !== null && before >= after ? orderKeyBetween(before, null) : orderKeyBetween(before, after)
      return file
    }
    case 'token.duplicate': {
      const source = token(file, command.tokenId)
      if (!validId(command.newId) || own(file.theme.tokens, command.newId) || typeof command.name !== 'string' || !command.name.trim() || command.name.length > 64) throw invalid('Token identity is invalid')
      const ordered = orderedTokens(file.theme)
      const index = ordered.findIndex(candidate => candidate.id === command.tokenId)
      const after = ordered[index + 1]?.orderKey ?? null
      file.theme.tokens[command.newId] = { ...structuredClone(source), id: command.newId, name: command.name, orderKey: after !== null && source.orderKey >= after ? orderKeyBetween(source.orderKey, null) : orderKeyBetween(source.orderKey, after) }
      return file
    }
    case 'token.delete': {
      if (!Array.isArray(command.tokenIds) || !command.tokenIds.length) throw invalid('Select a token')
      const deleting = new Set(command.tokenIds)
      const resolved = new Map<string, Color>()
      for (const tokenId of deleting) {
        const color = resolveToken(file.theme, tokenId, command.sources ?? {})
        if (!color) throw invalid('A token could not be resolved, so its references cannot be preserved')
        resolved.set(tokenId, color)
      }
      const replace = (value: ColorValue): ColorValue => value.kind === 'token' && deleting.has(value.tokenId) ? { kind: 'literal', color: resolved.get(value.tokenId)! } : value
      for (const node of Object.values(file.nodes)) {
        if (node.type === 'root' || !node.appearance) continue
        node.appearance = mapAppearanceColors(node.appearance, replace)
      }
      for (const page of file.pages) if (page.background) page.background = replace(page.background)
      for (const other of Object.values(file.theme.tokens)) if (!deleting.has(other.id) && other.value.kind === 'alias' && deleting.has(other.value.tokenId)) other.value = { kind: 'literal', color: resolved.get(other.value.tokenId)! }
      for (const tokenId of deleting) delete file.theme.tokens[tokenId]
      return file
    }
    default:
      throw invalid('Unknown file command')
  }
}

function validateApplyStructure(command: FileCommand, depth: number, budget: { remaining: number }): void {
  if (depth > commandDefaults.maxDepth) throw invalid('Invalid command batch')
  if (command.type !== 'batch') {
    if (--budget.remaining < 0) throw invalid('Invalid command batch')
    return
  }
  if (!Array.isArray(command.commands) || !command.commands.length || command.commands.length > commandDefaults.maxBatchCommands) throw invalid('Invalid command batch')
  for (const inner of command.commands) validateApplyStructure(inner, depth + 1, budget)
}

/** Applies one semantic command (or an atomic batch) to a validated file, bumping the revision once. */
export function applyFileCommand(input: FileDocument, command: FileCommand, atoms: Atom[], options: FileValidationOptions = {}): FileDocument {
  validateApplyStructure(command, 0, { remaining: commandDefaults.maxBatchCommands })
  const working = validateFileDocument(input, atoms, options)
  const next = apply(working, command, atoms)
  bump(next)
  return validateFileDocument(next, atoms, options)
}

export type FileCommandHistory = Readonly<{ file: FileDocument; undo: FileCommand; redo: FileCommand }>

const historyBatch = (commands: FileCommand[]): FileCommand => commands.length === 1 ? commands[0]! : { type: 'batch', commands }
const historyJson = (value: unknown) => JSON.stringify(value)
const historyPlacement = (file: FileDocument, nodeId: string): NodePlacement => {
  const relationship = file.relationships[nodeId]
  if (!relationship) throw invalid('History references a detached node')
  return { parentId: relationship.parentId, orderKey: relationship.orderKey, ...(relationship.slot !== undefined ? { slot: relationship.slot } : {}) }
}
const historyDepth = (file: FileDocument, nodeId: string) => {
  let depth = 0
  let current = file.relationships[nodeId]?.parentId
  while (current && file.relationships[current]) { depth += 1; current = file.relationships[current]?.parentId }
  return depth
}
const restoreDeletedNodes = (before: FileDocument, after: FileDocument): FileCommand[] => Object.keys(before.nodes)
  .filter(nodeId => before.nodes[nodeId]?.type !== 'root' && !own(after.nodes, nodeId))
  .sort((left, right) => historyDepth(before, left) - historyDepth(before, right))
  .flatMap(nodeId => {
    const node = before.nodes[nodeId]!
    const commands: FileCommand[] = [{ type: 'node.insert', node: structuredClone(node), placement: historyPlacement(before, nodeId) }]
    if (node.type !== 'root' && node.themeMode === undefined) commands.push({ type: 'node.setThemeMode', nodeId, themeMode: null })
    return commands
  })

function canonicalHistoryRedo(before: FileDocument, after: FileDocument, command: Exclude<FileCommand, { type: 'batch' }>): FileCommand {
  if (command.type !== 'node.fill.add' || command.paint) return structuredClone(command)
  const beforeIds = new Set((nodeAppearance(before.nodes[command.nodeId])?.fills ?? []).map(paint => paint.id))
  const paint = (nodeAppearance(after.nodes[command.nodeId])?.fills ?? []).find(candidate => !beforeIds.has(candidate.id))
  if (!paint) throw invalid('History could not identify the added fill')
  return { ...command, paint: structuredClone(paint) }
}

function inverseHistoryLeaf(before: FileDocument, after: FileDocument, command: Exclude<FileCommand, { type: 'batch' }>): FileCommand {
  switch (command.type) {
    case 'page.create': return { type: 'page.delete', pageId: command.page.id }
    case 'page.rename': return { type: 'page.rename', pageId: command.pageId, name: before.pages.find(page => page.id === command.pageId)!.name }
    case 'page.setBackground': return { type: 'page.setBackground', pageId: command.pageId, background: structuredClone(before.pages.find(page => page.id === command.pageId)?.background ?? null) }
    case 'page.reorder': return { type: 'page.reorder', pageId: command.pageId, index: before.pages.findIndex(page => page.id === command.pageId) }
    case 'page.delete': {
      const page = before.pages.find(candidate => candidate.id === command.pageId)
      if (!page) throw invalid('History references a missing page')
      return historyBatch([{ type: 'page.create', page: structuredClone(page), index: before.pages.indexOf(page) }, ...restoreDeletedNodes(before, after)])
    }
    case 'page.duplicate': return { type: 'page.delete', pageId: command.page.id }
    case 'node.insert': return { type: 'node.delete', nodeIds: [command.node.id] }
    case 'node.rename': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type === 'root') throw invalid('History references a missing node')
      return { type: 'node.rename', nodeId: command.nodeId, name: node.type === 'component' ? node.name ?? null : node.name }
    }
    case 'node.setLocked': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type === 'root') throw invalid('History references a missing node')
      return { type: 'node.setLocked', nodeId: command.nodeId, isLocked: node.isLocked === true }
    }
    case 'node.setStyles': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type === 'root' || node.type === 'component') throw invalid('History references a missing primitive')
      const styles = Object.fromEntries(Object.keys(command.styles).map(key => [key, own(node.styles, key) ? node.styles[key as keyof PrimitiveStyles] : null])) as PrimitiveStylePatch
      return { type: 'node.setStyles', nodeId: command.nodeId, styles }
    }
    case 'node.setText': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type !== 'text') throw invalid('History references a missing text node')
      return { type: 'node.setText', nodeId: command.nodeId, text: node.text ?? '' }
    }
    case 'node.setAppearance':
    case 'node.setBlending':
    case 'node.fill.add':
    case 'node.fill.update':
    case 'node.fill.move':
    case 'node.fill.remove':
    case 'node.fill.replace':
    case 'node.outline.set':
    case 'node.borders.set':
    case 'node.border.update':
    case 'node.border.remove': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type === 'root') throw invalid('History references a missing styled node')
      return { type: 'node.setAppearance', nodeId: command.nodeId, appearance: structuredClone(node.appearance ?? null) }
    }
    case 'asset.attach': return { type: 'asset.detach', assetId: command.asset.id }
    case 'asset.detach': {
      const asset = before.assets?.[command.assetId]
      if (!asset) throw invalid('History references a missing asset')
      return { type: 'asset.attach', asset: structuredClone(asset) }
    }
    case 'node.setProps': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type !== 'component') throw invalid('History references a missing component')
      const names = new Set([...Object.keys(command.props), ...(command.remove ?? [])])
      const props: Record<string, DocumentValue> = {}
      const remove: string[] = []
      for (const name of names) { if (own(node.props, name)) props[name] = node.props[name]!; else remove.push(name) }
      return { type: 'node.setProps', nodeId: command.nodeId, props, ...(remove.length ? { remove } : {}) }
    }
    case 'node.setLayout': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type !== 'component') throw invalid('History references a missing component')
      return { type: 'node.setLayout', nodeId: command.nodeId, layout: structuredClone(node.layout ?? null) }
    }
    case 'node.setThemeMode': {
      const node = before.nodes[command.nodeId]
      if (!node || node.type === 'root') throw invalid('History references a missing node')
      return { type: 'node.setThemeMode', nodeId: command.nodeId, themeMode: node.themeMode ?? null }
    }
    case 'node.reparent': return { type: 'node.reparent', nodeId: command.nodeId, placement: historyPlacement(before, command.nodeId), ...(command.preserveWorldPosition ? { preserveWorldPosition: true } : {}) }
    case 'node.reorder': {
      const relationship = before.relationships[command.nodeId]
      if (!relationship) throw invalid('History references a missing node')
      return { type: 'node.reorder', nodeId: command.nodeId, index: childrenOf(before, relationship.parentId, relationship.slot).indexOf(command.nodeId) }
    }
    case 'node.delete': return historyBatch(restoreDeletedNodes(before, after))
    case 'node.duplicate': return { type: 'node.delete', nodeIds: [command.ids[command.nodeId]!] }
    case 'token.create': return { type: 'token.delete', tokenIds: [command.token.id] }
    case 'token.rename': return { type: 'token.rename', tokenId: command.tokenId, name: before.theme.tokens[command.tokenId]!.name }
    case 'token.setValue': return { type: 'token.setValue', tokenId: command.tokenId, value: structuredClone(before.theme.tokens[command.tokenId]!.value) }
    case 'token.setDescription': return { type: 'token.setDescription', tokenId: command.tokenId, description: before.theme.tokens[command.tokenId]!.description ?? '' }
    case 'token.reorder': return { type: 'token.reorder', tokenId: command.tokenId, index: orderedTokens(before.theme).findIndex(token => token.id === command.tokenId) }
    case 'token.duplicate': return { type: 'token.delete', tokenIds: [command.newId] }
    case 'token.delete': {
      const commands: FileCommand[] = command.tokenIds.map(tokenId => ({ type: 'token.create', token: structuredClone(before.theme.tokens[tokenId]!) }))
      for (const [tokenId, token] of Object.entries(before.theme.tokens)) if (after.theme.tokens[tokenId] && historyJson(token.value) !== historyJson(after.theme.tokens[tokenId]!.value)) commands.push({ type: 'token.setValue', tokenId, value: structuredClone(token.value) })
      for (const page of before.pages) if (historyJson(page.background) !== historyJson(after.pages.find(candidate => candidate.id === page.id)?.background)) commands.push({ type: 'page.setBackground', pageId: page.id, background: structuredClone(page.background ?? null) })
      for (const [nodeId, node] of Object.entries(before.nodes)) {
        if (node.type === 'root') continue
        const next = after.nodes[nodeId]
        if (next && next.type !== 'root' && historyJson(node.appearance) !== historyJson(next.appearance)) commands.push({ type: 'node.setAppearance', nodeId, appearance: structuredClone(node.appearance ?? null) })
      }
      return historyBatch(commands)
    }
  }
}

/** Builds exact semantic undo and redo commands while applying one user command atomically. */
export function applyFileCommandWithHistory(input: FileDocument, command: FileCommand, atoms: Atom[], options: FileValidationOptions = {}): FileCommandHistory {
  const leaves: Exclude<FileCommand, { type: 'batch' }>[] = []
  const flatten = (candidate: FileCommand) => { if (candidate.type === 'batch') candidate.commands.forEach(flatten); else leaves.push(candidate) }
  flatten(validateFileCommand(command))
  const baseRevision = input.revision
  let working = validateFileDocument(input, atoms, options)
  const undo: FileCommand[] = []
  const redo: FileCommand[] = []
  for (const leaf of leaves) {
    working = { ...working, revision: baseRevision }
    const next = applyFileCommand(working, leaf, atoms, options)
    const canonical = canonicalHistoryRedo(working, next, leaf)
    undo.unshift(inverseHistoryLeaf(working, next, canonical as Exclude<FileCommand, { type: 'batch' }>))
    redo.push(canonical)
    working = next
  }
  const file = applyFileCommand(input, command, atoms, options)
  if (historyJson(working) !== historyJson(file)) throw invalid('History projection did not match the command')
  return Object.freeze({ file, undo: historyBatch(undo), redo: historyBatch(redo) })
}

/** Applies a validated command to a hosted file whose repository component bindings are intentionally unavailable. */
export function applyHostedFileCommand(input: FileDocument, command: FileCommand, trustedAtoms: readonly Atom[] = []): FileDocument {
  const validated = validateFileCommand(command)
  const established = hostedFileAtoms(input)
  const trustedIds = new Set<string>()
  for (const atom of trustedAtoms) {
    if (atom.kind !== 'atom' || atom.status !== 'bound' || trustedIds.has(atom.componentId)) throw invalid('Invalid trusted component catalog')
    trustedIds.add(atom.componentId)
    const prior = established.find(candidate => candidate.componentId === atom.componentId)
    if (prior && prior.exportName !== atom.exportName) throw invalid('Component binding needs review')
  }
  const atoms = [...established.filter(atom => !trustedIds.has(atom.componentId)), ...trustedAtoms.map(atom => structuredClone(atom))]
  const source = validateFileDocument(input, atoms, { allowUnavailableBindings: true })
  return applyFileCommand(source, validated, atoms, { allowUnavailableBindings: true })
}

/** Order keys for `count` new siblings appended after the current last child. */
export function appendOrderKeys(file: FileDocument, parentId: string, count: number, slot?: string): string[] {
  const siblings = childrenOf(file, parentId, slot)
  const last = siblings.length ? file.relationships[siblings[siblings.length - 1]!]!.orderKey : null
  const keys: string[] = []
  let previous = last
  for (let position = 0; position < count; position++) { previous = orderKeyBetween(previous, null); keys.push(previous) }
  return keys
}
export { orderKeySequence }
