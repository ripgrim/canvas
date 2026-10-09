/**
 * One explicit migration from the version 1 per-page documents (each page owned its own node map, primitive list, and
 * name keyed token map) to one version 2 file. Identities, names, geometry, hierarchy, component bindings, and the
 * appearance each page had are preserved; page-local token maps are lifted into one file theme.
 */
import type { Atom } from './types.js'
import type { CanvasElement, DocumentNodeLayout, EditorDocument } from './document.js'
import { hexColor } from './color.js'
import type { Color } from './color.js'
import { fileSchemaVersion, validateFileDocument } from './file-document.js'
import { layoutFromLegacy } from './layout.js'
import type { Appearance, ColorToken, ColorValue, FileDocument, FileNode, NodeRelationship, Paint } from './file-document.js'
import { record, validateNodeLayout } from './document.js'
import { orderKeySequence } from './order-keys.js'

export type LegacyPage = { id: string; name: string; document: EditorDocument }
export type MigrationResult = { file: FileDocument; diagnostics: string[] }

/**
 * Built-in names the version 1 renderer resolved from the design stylesheet. They become file tokens bound to the same
 * custom properties, so a frame filled with `surface` keeps following the design theme instead of freezing one color.
 * Fallbacks are the bundled sample's root values; `muted` had no stylesheet source and keeps its renderer fallback.
 */
export const legacyBuiltIns: Record<string, { property: string; fallback: string } | { literal: string }> = {
  accent: { property: '--accent', fallback: '#685fff' },
  surface: { property: '--surface', fallback: '#ffffff' },
  ink: { property: '--ink', fallback: '#202124' },
  muted: { literal: '#dddddd' },
}
const legacyMutedFallback = '#dddddd'
const isHex = (value: string) => /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)
export const legacyRootId = (pageId: string) => `root:${pageId}`
const builtInTokenId = (name: string) => `legacy:builtin:${name}`

export const isLegacyDocument = (value: unknown): value is EditorDocument => typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1
/** Any stored design file this build can read, including every supported predecessor upgraded on read. */
export const isFileDocumentShape = (value: unknown): value is FileDocument => typeof value === 'object' && value !== null && [2, 3, 4, 5, fileSchemaVersion].includes((value as { schemaVersion?: unknown }).schemaVersion as number)

type LegacyPaint = { type: 'solid'; color: ColorValue; visible?: boolean } | { type: 'linear-gradient'; angle: number; stops: { id: string; position: number; color: ColorValue }[]; visible?: boolean }
/** Version 2 kept `fills` top-first with the first visible paint drawn; version 3 stores bottom-to-top with stable ids. */
function upgradePaints(fills: unknown, nodeId: string): Appearance | undefined {
  if (!Array.isArray(fills) || !fills.length) return undefined
  const paints: Paint[] = (fills as LegacyPaint[]).map((paint, index) => {
    const id = `${nodeId}:fill:${index + 1}`
    const visible = paint.visible === false ? { visible: false as const } : {}
    if (paint.type === 'linear-gradient') return { id, type: 'gradient', shape: 'linear', angle: paint.angle, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: paint.stops.map(stop => ({ id: stop.id, position: stop.position, color: stop.color })), ...visible }
    return { id, type: 'solid', color: paint.color, ...visible }
  })
  return { fills: paints.reverse() }
}

/**
 * Upgrades an older stored file to the current schema without changing what it renders. Unknown versions pass through
 * for the validator to reject.
 */
export function upgradeFileDocument(input: unknown): unknown {
  return upgradeV5ToV6(upgradeV4ToV5(upgradeV3ToV4(upgradeV2ToV3(input))))
}
function upgradeV2ToV3(input: unknown): unknown {
  if (!record(input) || input.schemaVersion !== 2 || !record(input.nodes)) return input
  const nodes: Record<string, unknown> = {}
  for (const [id, node] of Object.entries(input.nodes)) {
    if (!record(node) || !own(node, 'fills')) { nodes[id] = node; continue }
    const { fills, ...rest } = node
    const appearance = upgradePaints(fills, id)
    nodes[id] = appearance ? { ...rest, appearance } : rest
  }
  return { ...input, schemaVersion: 3, nodes }
}
/**
 * Version 3 stored component placement as `{ mode, x, y, width?, height? }`; version 4 stores the tagged layout record
 * (`item.position` insets in px, px axis sizes). Appearance, tokens, assets, pages and relationships pass through untouched;
 * a layout the old validator would have rejected is left as is for the validator to report.
 */
/** The validator throws on unknown keys; the upgrade must leave such layouts for it to report rather than throw itself. */
const isFiveFieldLayout = (value: unknown): value is DocumentNodeLayout => { try { return validateNodeLayout(value) } catch { return false } }
function upgradeV3ToV4(input: unknown): unknown {
  if (!record(input) || input.schemaVersion !== 3 || !record(input.nodes)) return input
  const nodes: Record<string, unknown> = {}
  for (const [id, node] of Object.entries(input.nodes)) {
    if (!record(node) || node.type !== 'component' || !own(node, 'layout') || !isFiveFieldLayout(node.layout)) { nodes[id] = node; continue }
    nodes[id] = { ...node, layout: layoutFromLegacy(node.layout) }
  }
  return { ...input, schemaVersion: 4, nodes }
}
/** Version 5 adds the stored per-node theme mode; every existing non-root node becomes `inherit`, nothing else moves. */
function upgradeV4ToV5(input: unknown): unknown {
  if (!record(input) || input.schemaVersion !== 4 || !record(input.nodes)) return input
  const nodes: Record<string, unknown> = {}
  for (const [id, node] of Object.entries(input.nodes)) nodes[id] = record(node) && node.type !== 'root' && !own(node, 'themeMode') ? { ...node, themeMode: 'inherit' } : node
  return { ...input, schemaVersion: 5, nodes }
}
/** Version 6 permits an optional page background. Existing version 5 pages remain background-free and otherwise unchanged. */
function upgradeV5ToV6(input: unknown): unknown {
  return record(input) && input.schemaVersion === 5 ? { ...input, schemaVersion: fileSchemaVersion } : input
}
const own = (object: object, key: string) => Object.hasOwn(object, key)

type TokenPlan = { tokens: Record<string, ColorToken>; byPage: Map<string, Map<string, string>>; order: string[] }

/**
 * Lifts every page token map into one shared collection. Same name with the same value merges into one token; same name
 * with a different value stays distinct (the first page keeps the plain id, later distinct values are suffixed with the
 * page that introduced them) and every page is rewritten to its own id. Nothing is recolored.
 */
function planTokens(pages: LegacyPage[]): TokenPlan {
  const tokens: Record<string, ColorToken> = {}
  const byPage = new Map<string, Map<string, string>>()
  const order: string[] = []
  const valuesByName = new Map<string, { value: string; id: string; pageId: string }[]>()
  for (const page of pages) {
    const mapping = new Map<string, string>()
    byPage.set(page.id, mapping)
    for (const [name, value] of Object.entries(page.document.tokens ?? {})) {
      const normalized = value.toLowerCase()
      const known = valuesByName.get(name) ?? []
      const existing = known.find(entry => entry.value === normalized)
      if (existing) { mapping.set(name, existing.id); continue }
      const id = known.length === 0 ? `legacy:${name}` : `legacy:${name}:${page.id}`
      const displayName = known.length === 0 ? name : `${name} (${page.name})`
      known.push({ value: normalized, id, pageId: page.id })
      valuesByName.set(name, known)
      tokens[id] = { id, type: 'color', name: displayName, orderKey: '', value: { kind: 'literal', color: hexColor(normalized) } }
      order.push(id)
      mapping.set(name, id)
    }
  }
  return { tokens, byPage, order }
}

function ensureBuiltIn(plan: TokenPlan, name: string): string | null {
  const builtIn = legacyBuiltIns[name]
  if (!builtIn) return null
  const id = builtInTokenId(name)
  if (!plan.tokens[id]) {
    plan.tokens[id] = { id, type: 'color', name, orderKey: '', value: 'literal' in builtIn ? { kind: 'literal', color: hexColor(builtIn.literal) } : { kind: 'source', property: builtIn.property, fallback: hexColor(builtIn.fallback) } }
    plan.order.push(id)
  }
  return id
}

function colorFor(plan: TokenPlan, pageId: string, name: string, diagnostics: string[], elementId: string): ColorValue {
  if (isHex(name)) return { kind: 'literal', color: hexColor(name) }
  const pageTokenId = plan.byPage.get(pageId)?.get(name)
  if (pageTokenId) return { kind: 'token', tokenId: pageTokenId }
  const builtIn = ensureBuiltIn(plan, name)
  if (builtIn) return { kind: 'token', tokenId: builtIn }
  diagnostics.push(`${elementId}: fill "${name}" referenced a missing token and was kept as its rendered fallback color`)
  return { kind: 'literal', color: hexColor(legacyMutedFallback) }
}

function paintsFor(plan: TokenPlan, pageId: string, element: CanvasElement, diagnostics: string[]): Paint[] {
  const id = `${element.id}:fill:1`
  // The version 1 renderer drew the special `gradient` name, and every non-hex shader fill, as accent to ink at 135 degrees in sRGB.
  if (element.fill === 'gradient' || (element.kind === 'shader' && !isHex(element.fill))) {
    return [{ id, type: 'gradient', shape: 'linear', angle: 135, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ id: 'stop:0', position: 0, color: colorFor(plan, pageId, 'accent', diagnostics, element.id) }, { id: 'stop:1', position: 1, color: colorFor(plan, pageId, 'ink', diagnostics, element.id) }] }]
  }
  return [{ id, type: 'solid', color: colorFor(plan, pageId, element.fill, diagnostics, element.id) }]
}

export function migrateLegacyPages(fileId: string, pages: LegacyPage[], atoms: Atom[], options: { allowUnavailableBindings?: boolean } = {}): MigrationResult {
  if (!pages.length) throw new Error('A file needs at least one page')
  const diagnostics: string[] = []
  const plan = planTokens(pages)
  const nodes: Record<string, FileNode> = {}
  const relationships: Record<string, NodeRelationship> = {}
  const filePages = pages.map(page => ({ id: page.id, name: page.name, rootNodeId: legacyRootId(page.id) }))
  const place = (parentId: string, ids: string[], slot?: string) => {
    const keys = orderKeySequence(ids.length)
    ids.forEach((id, index) => { relationships[id] = { parentId, orderKey: keys[index]!, ...(slot !== undefined ? { slot } : {}) } })
  }
  for (const page of pages) {
    const rootId = legacyRootId(page.id)
    const document = page.document
    nodes[rootId] = { id: rootId, type: 'root' }
    for (const node of Object.values(document.nodes)) {
      if (nodes[node.id]) throw new Error(`Node ${node.id} appears in more than one page`)
      nodes[node.id] = { id: node.id, type: 'component', componentId: node.componentId, exportName: node.exportName, props: structuredClone(node.props), ...(node.name !== undefined ? { name: node.name } : {}), ...(node.layout ? { layout: layoutFromLegacy(node.layout) } : {}), themeMode: 'inherit' }
    }
    const elements = document.canvas?.elements ?? []
    for (const element of elements) {
      if (nodes[element.id]) throw new Error(`Node ${element.id} appears in more than one page`)
      nodes[element.id] = {
        id: element.id, type: element.kind, name: element.name,
        styles: { left: element.x, top: element.y, width: element.width, height: element.height, ...(element.rotation ? { rotation: element.rotation } : {}), ...(element.kind === 'frame' ? { overflow: element.clip === false ? 'visible' : 'clip' } : {}) },
        appearance: { fills: paintsFor(plan, page.id, element, diagnostics) },
        ...(element.kind === 'text' ? { text: element.text ?? '' } : {}),
        themeMode: 'inherit',
      }
    }
    // Component roots kept their place above primitives in the version 1 scene order.
    place(rootId, [...document.rootIds, ...elements.filter(element => !element.parentId).map(element => element.id)])
    for (const node of Object.values(document.nodes)) for (const [slot, children] of Object.entries(node.children)) place(node.id, children, slot)
    const byParent = new Map<string, string[]>()
    for (const element of elements) if (element.parentId) { if (!byParent.has(element.parentId)) byParent.set(element.parentId, []); byParent.get(element.parentId)!.push(element.id) }
    for (const [parentId, children] of byParent) place(parentId, children)
  }
  const tokenKeys = orderKeySequence(plan.order.length)
  plan.order.forEach((id, index) => { plan.tokens[id]!.orderKey = tokenKeys[index]! })
  const file: FileDocument = { schemaVersion: fileSchemaVersion, fileId, revision: 0, pages: filePages, nodes, relationships, theme: { tokens: plan.tokens } }
  return { file: validateFileDocument(file, atoms, options), diagnostics }
}

/** Resolved colors of the legacy built-ins for tests and appearance comparisons. */
export const legacyBuiltInColor = (name: string): Color | null => { const builtIn = legacyBuiltIns[name]; return builtIn ? hexColor('literal' in builtIn ? builtIn.literal : builtIn.fallback) : null }
