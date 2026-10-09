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
import { appearanceColors, assetReferences, borderSides, canonicalAppearance, defaultFillColor, mapAppearanceColors, validateAppearance, validateBorders, validateImageAsset, validateOutline, validatePaint, validateStroke } from './appearance.js'
import type { Appearance, BlendMode, BorderSide, Borders, ColorValue, ImageAsset, Outline, Paint, Stroke } from './appearance.js'
export * from './appearance.js'

export const fileSchemaVersion = 5 as const
export type PrimitiveKind = 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'
export const primitiveKinds: readonly PrimitiveKind[] = ['frame', 'rectangle', 'shape', 'shader', 'text']
export type PrimitiveStyles = { left: number; top: number; width: number; height: number; rotation?: number; overflow?: 'clip' | 'visible' }
export type RootNode = { id: string; type: 'root' }
/**
 * `themeMode` is the stored per-node theme choice (schema v5). Migration and insertion write it explicitly; a node
 * without the field (hand-built or pre-migration data) reads as `inherit` through `nodeThemeMode`.
 */
export type PrimitiveNode = { id: string; type: PrimitiveKind; name: string; styles: PrimitiveStyles; appearance?: Appearance; text?: string; themeMode?: NodeThemeMode }
export type ComponentNode = { id: string; type: 'component'; name?: string; componentId: string; exportName: string; props: Record<string, DocumentValue>; layout?: NodeLayout; appearance?: Appearance; themeMode?: NodeThemeMode }
export type FileNode = RootNode | PrimitiveNode | ComponentNode
/** Parent plus sibling order; `slot` names the component slot when the parent is a component instance. */
export type NodeRelationship = { parentId: string; orderKey: string; slot?: string }
export type FilePage = { id: string; name: string; rootNodeId: string }
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
  /** Local image assets referenced by image fills. Stored with the file; never fetched from a URL. */
  assets?: Record<string, ImageAsset>
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
  fields(value, ['left', 'top', 'width', 'height', ...(own(value, 'rotation') ? ['rotation'] : []), ...(own(value, 'overflow') ? ['overflow'] : [])], 'node styles')
  if (!finite(value.left, -limits.coordinate, limits.coordinate) || !finite(value.top, -limits.coordinate, limits.coordinate)) return false
  if (!finite(value.width, 1, limits.coordinate) || !finite(value.height, 1, limits.coordinate)) return false
  if (own(value, 'rotation') && !finite(value.rotation, -limits.coordinate, limits.coordinate)) return false
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
    for (const [assetId, asset] of Object.entries(input.assets)) { const checked = validateImageAsset(asset); if (checked.id !== assetId) throw invalid('Invalid image asset identity') }
  }
  const file = input as unknown as FileDocument

  for (const [key, node] of Object.entries(file.nodes)) {
    if (!record(node) || !validId(key) || node.id !== key || forbiddenKeys.has(key)) throw invalid('Invalid node identity')
    if (node.type === 'root') { fields(node, ['id', 'type'], 'root node'); continue }
    if (node.type === 'component') {
      fields(node, ['id', 'type', 'componentId', 'exportName', 'props', ...(own(node, 'name') ? ['name'] : []), ...(own(node, 'layout') ? ['layout'] : []), ...(own(node, 'appearance') ? ['appearance'] : []), ...(own(node, 'themeMode') ? ['themeMode'] : [])], 'component node')
      if (own(node, 'themeMode') && !isNodeThemeMode(node.themeMode)) throw invalid('Invalid node theme mode')
      if (!validId(node.componentId) || typeof node.exportName !== 'string') throw invalid('Invalid component identity')
      if (own(node, 'name') && !validName(node.name)) throw invalid('Invalid component name')
      const atom = atoms.find(candidate => candidate.componentId === node.componentId)
      if (!atom || (!options.allowUnavailableBindings && atom.status !== 'bound') || atom.kind !== 'atom' || atom.exportName !== node.exportName) throw invalid('Component binding needs review')
      if (own(node, 'layout') && !validateLayout(node.layout)) throw invalid('Invalid component layout')
      if (own(node, 'appearance')) validateAppearance(node.appearance, 'component')
      continue
    }
    if (!(primitiveKinds as readonly string[]).includes(node.type as string)) throw invalid('Unsupported node type')
    fields(node, ['id', 'type', 'name', 'styles', ...(own(node, 'appearance') ? ['appearance'] : []), ...(own(node, 'text') ? ['text'] : []), ...(own(node, 'themeMode') ? ['themeMode'] : [])], 'node')
    if (own(node, 'themeMode') && !isNodeThemeMode(node.themeMode)) throw invalid('Invalid node theme mode')
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
    fields(page, ['id', 'name', 'rootNodeId'], 'page')
    if (!validId(page.id) || pageIds.has(page.id) || !validName(page.name) || !validId(page.rootNodeId) || roots.has(page.rootNodeId)) throw invalid('Invalid page identity')
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
export type TokenReference = { nodeId: string } | { aliasTokenId: string }
/** One entry per bound color (fills, stops, cached states, outline, borders) plus dependent aliases. */
export function tokenReferences(file: FileDocument, tokenId: string): TokenReference[] {
  const references: TokenReference[] = []
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
export type FileCommand =
  | { type: 'page.create'; page: FilePage; index?: number }
  | { type: 'page.rename'; pageId: string; name: string }
  | { type: 'page.reorder'; pageId: string; index: number }
  | { type: 'page.delete'; pageId: string }
  /** Copies every node of a page under a new root; `ids` maps each copied node id to its new identity. */
  | { type: 'page.duplicate'; pageId: string; page: FilePage; ids: Record<string, string> }
  | { type: 'node.insert'; node: FileNode; placement: NodePlacement }
  | { type: 'node.rename'; nodeId: string; name: string }
  /** Partial geometry update; an explicit `undefined` removes an optional style such as `rotation`. */
  | { type: 'node.setStyles'; nodeId: string; styles: { [K in keyof PrimitiveStyles]?: PrimitiveStyles[K] | undefined } }
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
  | { type: 'asset.add'; asset: ImageAsset }
  /** Removes an asset nobody references; referenced assets are refused. */
  | { type: 'asset.remove'; assetId: string }
  | { type: 'node.setProps'; nodeId: string; props: Record<string, DocumentValue>; remove?: string[] }
  | { type: 'node.setLayout'; nodeId: string; layout: NodeLayout }
  /** Stored theme choice for one node; descendants that inherit follow it. Touches nothing else on the node. */
  | { type: 'node.setThemeMode'; nodeId: string; themeMode: NodeThemeMode }
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
      file.nodes[command.page.rootNodeId] = { id: command.page.rootNodeId, type: 'root' }
      file.pages.splice(index, 0, { id: command.page.id, name: command.page.name, rootNodeId: command.page.rootNodeId })
      return file
    }
    case 'page.rename': {
      const page = file.pages.find(candidate => candidate.id === command.pageId)
      if (!page || !validName(command.name)) throw invalid('Invalid page name')
      page.name = command.name
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
      file.pages.splice(file.pages.indexOf(source) + 1, 0, { id: command.page.id, name: command.page.name, rootNodeId: command.page.rootNodeId })
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
      if (!node || node.type === 'root' || !validName(command.name)) throw invalid('Invalid node name')
      node.name = command.name
      return file
    }
    case 'node.setStyles': {
      const node = primitive(file, command.nodeId)
      if (!record(command.styles)) throw invalid('Invalid node geometry')
      const next: Record<string, unknown> = { ...node.styles }
      for (const [key, value] of Object.entries(command.styles)) { if (value === undefined) delete next[key]; else next[key] = value }
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
    case 'asset.add': {
      const asset = validateImageAsset(structuredClone(command.asset))
      if (file.assets && own(file.assets, asset.id)) throw invalid('Asset identity already exists')
      if (Object.keys(file.assets ?? {}).length >= limits.assets) throw invalid(`A file supports up to ${limits.assets} images`)
      file.assets = { ...(file.assets ?? {}), [asset.id]: asset }
      return file
    }
    case 'asset.remove': {
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
      if (!validateLayout(command.layout)) throw invalid('Invalid component layout')
      node.layout = structuredClone(command.layout)
      return file
    }
    case 'node.setThemeMode': {
      const node = file.nodes[command.nodeId]
      if (!node || node.type === 'root') throw invalid('Select an existing node')
      if (!isNodeThemeMode(command.themeMode)) throw invalid('Invalid node theme mode')
      node.themeMode = command.themeMode
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
      for (const other of Object.values(file.theme.tokens)) if (!deleting.has(other.id) && other.value.kind === 'alias' && deleting.has(other.value.tokenId)) other.value = { kind: 'literal', color: resolved.get(other.value.tokenId)! }
      for (const tokenId of deleting) delete file.theme.tokens[tokenId]
      return file
    }
    default:
      throw invalid('Unknown file command')
  }
}

/** Applies one semantic command (or an atomic batch) to a validated file, bumping the revision once. */
export function applyFileCommand(input: FileDocument, command: FileCommand, atoms: Atom[], options: FileValidationOptions = {}): FileDocument {
  const working = validateFileDocument(input, atoms, options)
  const next = apply(working, command, atoms)
  bump(next)
  return validateFileDocument(next, atoms, options)
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
