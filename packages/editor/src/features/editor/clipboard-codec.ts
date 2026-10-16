import { fileSchemaVersion, validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileNode, FileToken, ImageAssetReference, NodeRelationship } from '@canvas/repo-engine/file-document'
import type { ComponentModelState } from '@canvas/repo-engine/component-model'
import type { Atom } from './types'
import { orderKeySequence } from '@canvas/repo-engine/order-keys'
import { appearanceLimits, imageMimes } from '@canvas/repo-engine/appearance'
import { prepareImageFile } from './image-import'

export const canvasClipboardLimits = Object.freeze({
  representations: 16,
  internalBytes: 1_000_000,
  internalNodes: 1_000,
  internalAssets: 64,
  internalTokens: 500,
  treeDepth: 64,
  textBytes: 1_000_000,
  htmlBytes: 2_000_000,
  imageFiles: 16,
  imageConcurrency: 4,
  imageBytes: 25 * 1024 * 1024,
  aggregateImageBytes: 64 * 1024 * 1024,
  svgBytes: 1_000_000,
  svgNodes: 5_000,
})

export type InternalClipboardPayload = Readonly<{
  version: 1
  source: Readonly<{ fileId: string; pageId: string; fileRevision: number }>
  roots: readonly string[]
  nodes: Readonly<Record<string, FileNode>>
  relationships: Readonly<Record<string, NodeRelationship>>
  tokens: Readonly<Record<string, FileToken>>
  componentModel: ComponentModelState
  assets?: Readonly<Record<string, ImageAssetReference>>
}>

export type ClipboardDataSource = Readonly<{
  types: readonly string[]
  files: readonly File[]
  getData: (type: string) => string
}>

export type ClipboardCandidate =
  | Readonly<{ kind: 'internal'; payload: InternalClipboardPayload; fallbackText: string }>
  | Readonly<{ kind: 'svg'; source: string; name: 'pasted.svg' }>
  | Readonly<{ kind: 'images'; files: readonly ClipboardImage[]; failures: readonly ClipboardImageFailure[] }>
  | Readonly<{ kind: 'paper-tree'; tree: PaperTemporaryTree; fallbackText: string }>
  | Readonly<{ kind: 'foreign-html'; source: 'figma' | 'paper'; html: string }>
  | Readonly<{ kind: 'html'; source: string }>
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'unsupported'; diagnostic: string }>

export type ResolvedClipboardCandidate = Exclude<ClipboardCandidate, Readonly<{ kind: 'images'; files: readonly ClipboardImage[]; failures: readonly ClipboardImageFailure[] }>>
  | Readonly<{ kind: 'image-files'; files: readonly File[] }>

export type ClipboardImage = Readonly<{ file: File; width: number; height: number }>
export type ClipboardImageFailure = Readonly<{ name: string; diagnostic: string }>
export type PaperTemporaryTree = Readonly<{
  id: string
  fileId: string
  topLevelNodeIds: readonly string[]
  nodes: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  images: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  parentToChildrenIndex: Readonly<Record<string, readonly string[]>>
  oldIdToNewIdMap: Readonly<Record<string, string>>
  positions: Readonly<Record<string, readonly number[]>>
  themeHash?: string
  tokens?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}>

const markerPrefix = '<!--design-editor-clipboard:v1:'
const markerSuffix = '-->'
const paperTreePrefix = '<!--<paper-paste-start data-embed="'
const paperTreeSuffix = '"></paper-paste-start>-->'
const paperHtmlPrefix = '<x-paper-html>'
const paperHtmlSuffix = '</x-paper-html>'
const figmaMarker = '<!--(figma)'
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const internalKeys = ['version', 'source', 'roots', 'nodes', 'relationships', 'tokens', 'componentModel'] as const
const sourceKeys = ['fileId', 'pageId', 'fileRevision'] as const
const supportedHtmlElements = new Set(['p', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'br', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const svgElements = new Set(['svg', 'g', 'defs', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'image', 'lineargradient', 'radialgradient', 'stop', 'filter', 'fegaussianblur', 'fecolormatrix', 'feoffset', 'feblend', 'fecomposite', 'feflood', 'femerge', 'femergenode', 'clippath', 'mask', 'pattern', 'use'])
const rejectedSvgElements = new Set(['script', 'iframe', 'foreignobject', 'object', 'embed', 'link', 'style', 'audio', 'video'])
const removableSvgElements = new Set(['metadata', 'title', 'desc'])
const svgAttributes = new Set(['id', 'xmlns', 'viewbox', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd', 'points', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'transform-origin', 'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor', 'dominant-baseline', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod', 'filterunits', 'primitiveunits', 'stddeviation', 'in', 'in2', 'result', 'type', 'values', 'operator', 'k1', 'k2', 'k3', 'k4', 'dx', 'dy', 'mode', 'flood-color', 'flood-opacity', 'clip-path', 'mask', 'filter', 'patternunits', 'patterncontentunits', 'patterntransform', 'preserveaspectratio', 'href', 'xlink:href'])

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength
const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key))
}

function assertDataTree(value: unknown, depth = 0, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return
  if (depth > canvasClipboardLimits.treeDepth) throw new Error('Clipboard data is nested too deeply')
  if (seen.has(value)) throw new Error('Clipboard data cannot contain cycles')
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Clipboard data must contain plain values')
  const keys = Reflect.ownKeys(value)
  if (Array.isArray(value)) {
    if (keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)))) throw new Error('Clipboard arrays cannot contain named fields')
    const length = Object.getOwnPropertyDescriptor(value, 'length')
    if (!length || length.enumerable || !('value' in length) || length.value !== value.length) throw new Error('Clipboard data must contain plain values')
  }
  for (const key of keys) {
    if (key === 'length' && Array.isArray(value)) continue
    if (typeof key !== 'string' || forbiddenKeys.has(key)) throw new Error('Clipboard data contains a forbidden key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Clipboard data must contain plain values')
    assertDataTree(descriptor.value, depth + 1, seen)
  }
}

function freezeTree<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child, seen)
  return Object.freeze(value)
}

const base64UrlEncode = (value: string): string => {
  const data = new TextEncoder().encode(value)
  let binary = ''
  for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const base64UrlDecode = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Clipboard payload encoding is invalid')
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  const data = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(data)
}

const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function fragmentRootId(nodes: Readonly<Record<string, FileNode>>): string {
  let id = 'clipboard-root'
  let suffix = 0
  while (Object.hasOwn(nodes, id)) id = `clipboard-root-${++suffix}`
  return id
}

function stringRecord(value: unknown): value is Record<string, string> {
  return plainRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function recordRecord(value: unknown): value is Record<string, Readonly<Record<string, unknown>>> {
  return plainRecord(value) && Object.values(value).every(plainRecord)
}

function childIndex(value: unknown): value is Record<string, readonly string[]> {
  return plainRecord(value) && Object.values(value).every(children => Array.isArray(children) && children.every(child => typeof child === 'string'))
}

function positionsRecord(value: unknown): value is Record<string, readonly number[]> {
  return plainRecord(value) && Object.values(value).every(position => Array.isArray(position) && [2, 4, 8].includes(position.length) && position.every(item => typeof item === 'number' && Number.isFinite(item)))
}

export function validatePaperTemporaryTree(input: unknown): PaperTemporaryTree {
  assertDataTree(input)
  const required = ['id', 'fileId', 'topLevelNodeIds', 'nodes', 'images', 'parentToChildrenIndex', 'oldIdToNewIdMap', 'positions'] as const
  if (!plainRecord(input) || !exactKeys(input, required, ['themeHash', 'tokens'])
    || typeof input.id !== 'string' || !input.id || typeof input.fileId !== 'string' || !input.fileId
    || !Array.isArray(input.topLevelNodeIds) || !input.topLevelNodeIds.length || input.topLevelNodeIds.some(id => typeof id !== 'string')
    || new Set(input.topLevelNodeIds).size !== input.topLevelNodeIds.length
    || !recordRecord(input.nodes) || Object.keys(input.nodes).length > canvasClipboardLimits.internalNodes
    || !recordRecord(input.images) || Object.keys(input.images).length > canvasClipboardLimits.internalAssets
    || !childIndex(input.parentToChildrenIndex) || !stringRecord(input.oldIdToNewIdMap) || !positionsRecord(input.positions)
    || Object.hasOwn(input, 'themeHash') && typeof input.themeHash !== 'string'
    || Object.hasOwn(input, 'tokens') && (!recordRecord(input.tokens) || Object.keys(input.tokens).length > canvasClipboardLimits.internalTokens)) throw new Error('Paper clipboard tree is invalid')
  const nodeIds = new Set(Object.keys(input.nodes))
  const roots = input.topLevelNodeIds as string[]
  if (roots.some(id => !nodeIds.has(id))) throw new Error('Paper clipboard tree has a missing root')
  const parentByChild = new Map<string, string>()
  for (const [parentId, children] of Object.entries(input.parentToChildrenIndex as Record<string, string[]>)) {
    if (!nodeIds.has(parentId) || new Set(children).size !== children.length) throw new Error('Paper clipboard tree has an invalid parent')
    for (const child of children) {
      if (!nodeIds.has(child) || parentByChild.has(child) || roots.includes(child)) throw new Error('Paper clipboard tree has an invalid child')
      parentByChild.set(child, parentId)
    }
  }
  if ([...nodeIds].some(id => !roots.includes(id) && !parentByChild.has(id))) throw new Error('Paper clipboard tree has an orphan')
  for (const id of nodeIds) {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current) {
      if (seen.has(current)) throw new Error('Paper clipboard tree has a cycle')
      seen.add(current)
      current = parentByChild.get(current)
    }
  }
  for (const id of Object.keys(input.positions)) if (!roots.includes(id)) throw new Error('Paper clipboard tree has an invalid position')
  return freezeTree(structuredClone(input) as PaperTemporaryTree)
}

function markerContents(source: string, prefix: string, suffix: string): string | null {
  const start = source.indexOf(prefix)
  if (start < 0) return null
  if (source.indexOf(prefix, start + prefix.length) >= 0) throw new Error('Clipboard data contains duplicate markers')
  const end = source.indexOf(suffix, start + prefix.length)
  if (end < 0) throw new Error('Clipboard data marker is incomplete')
  return source.slice(start + prefix.length, end)
}

export function decodePaperTemporaryTreeHtml(html: string): PaperTemporaryTree | null {
  const data = markerContents(html, paperTreePrefix, paperTreeSuffix)
  if (data === null) return null
  if (bytes(data) > canvasClipboardLimits.internalBytes) throw new Error('Paper clipboard tree exceeds the byte limit')
  return validatePaperTemporaryTree(JSON.parse(data) as unknown)
}

export function validateInternalClipboardPayload(input: unknown, atoms: readonly Atom[] = []): InternalClipboardPayload {
  assertDataTree(input)
  if (!plainRecord(input) || !exactKeys(input, internalKeys, ['assets'])) throw new Error('Invalid clipboard payload')
  if (input.version !== 1 || !plainRecord(input.source) || !exactKeys(input.source, sourceKeys)) throw new Error('Unsupported clipboard payload version')
  if (!Array.isArray(input.roots) || !input.roots.length || new Set(input.roots).size !== input.roots.length || input.roots.some(id => typeof id !== 'string')) throw new Error('Clipboard payload needs unique roots')
  if (!plainRecord(input.nodes) || Object.keys(input.nodes).length > canvasClipboardLimits.internalNodes) throw new Error('Clipboard payload exceeds the node limit')
  if (!plainRecord(input.relationships) || !plainRecord(input.tokens) || Object.keys(input.tokens).length > canvasClipboardLimits.internalTokens) throw new Error('Invalid clipboard payload records')
  if (Object.hasOwn(input, 'assets') && (!plainRecord(input.assets) || Object.keys(input.assets).length > canvasClipboardLimits.internalAssets)) throw new Error('Clipboard payload exceeds the asset limit')
  if (Object.hasOwn(input, 'assets') && Object.values(input.assets as Record<string, ImageAssetReference>).reduce((total, asset) => total + (typeof asset.bytes === 'number' ? asset.bytes : 0), 0) > canvasClipboardLimits.aggregateImageBytes) throw new Error('Clipboard payload exceeds the aggregate image byte limit')
  for (const root of input.roots) if (!Object.hasOwn(input.nodes, root) || Object.hasOwn(input.relationships, root)) throw new Error('Clipboard root relationship is invalid')
  const rootId = fragmentRootId(input.nodes as Record<string, FileNode>)
  const relationships = { ...(input.relationships as Record<string, NodeRelationship>) }
  const rootOrder = orderKeySequence(input.roots.length)
  for (const [index, root] of input.roots.entries()) relationships[root] = { parentId: rootId, orderKey: rootOrder[index]! }
  const file = validateFileDocument({
    schemaVersion: fileSchemaVersion,
    fileId: input.source.fileId,
    revision: input.source.fileRevision,
    pages: [{ id: input.source.pageId, name: 'Clipboard', rootNodeId: rootId }],
    nodes: { [rootId]: { id: rootId, type: 'root' }, ...input.nodes },
    relationships,
    theme: { tokens: input.tokens },
    componentModel: input.componentModel,
    ...(Object.hasOwn(input, 'assets') ? { assets: input.assets } : {}),
  }, [...atoms], { allowUnavailableBindings: true })
  if (Object.keys(file.nodes).length !== Object.keys(input.nodes).length + 1) throw new Error('Clipboard payload contains invalid nodes')
  return freezeTree(structuredClone(input) as InternalClipboardPayload)
}

export function encodeInternalClipboardPayload(payload: InternalClipboardPayload, fallbackText: string, atoms: readonly Atom[] = []): Readonly<{ html: string; text: string }> {
  const checked = validateInternalClipboardPayload(payload, atoms)
  const json = JSON.stringify(checked)
  if (bytes(json) > canvasClipboardLimits.internalBytes) throw new Error('Clipboard payload exceeds the byte limit')
  return Object.freeze({ html: `${markerPrefix}${base64UrlEncode(json)}${markerSuffix}<p>${escapeHtml(fallbackText)}</p>`, text: fallbackText })
}

export function decodeInternalClipboardHtml(html: string, atoms: readonly Atom[] = []): InternalClipboardPayload | null {
  if (bytes(html) > canvasClipboardLimits.htmlBytes) throw new Error('Clipboard HTML exceeds the byte limit')
  const start = html.indexOf(markerPrefix)
  if (start < 0) return null
  if (html.indexOf(markerPrefix, start + markerPrefix.length) >= 0) throw new Error('Clipboard data contains multiple internal payloads')
  const end = html.indexOf(markerSuffix, start + markerPrefix.length)
  if (end < 0) throw new Error('Clipboard payload marker is incomplete')
  const encoded = html.slice(start + markerPrefix.length, end)
  if (encoded.length > Math.ceil(canvasClipboardLimits.internalBytes * 4 / 3) + 4) throw new Error('Clipboard payload exceeds the byte limit')
  const json = base64UrlDecode(encoded)
  if (bytes(json) > canvasClipboardLimits.internalBytes) throw new Error('Clipboard payload exceeds the byte limit')
  return validateInternalClipboardPayload(JSON.parse(json) as unknown, atoms)
}

export function clipboardTargetIsEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const editable = target.closest('input, textarea, select, [contenteditable]')
  if (!editable) return false
  return !editable.hasAttribute('contenteditable') || editable.getAttribute('contenteditable') !== 'false'
}

const looksLikeSvg = (value: string): boolean => /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(value.trim())

function rewriteLocalReference(value: string, ids: ReadonlyMap<string, string>): string {
  if (value.startsWith('#')) {
    const mapped = ids.get(value.slice(1))
    if (!mapped) throw new Error('SVG contains a missing local reference')
    return `#${mapped}`
  }
  if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/iu.test(value)) return value
  const matches = [...value.matchAll(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/giu)]
  if (value.includes('url(') && !matches.length) throw new Error('SVG contains an external reference')
  let rewritten = value
  for (const match of matches) {
    const mapped = ids.get(match[2]!)
    if (!mapped) throw new Error('SVG contains a missing local reference')
    rewritten = rewritten.replace(match[0], `url(#${mapped})`)
  }
  if (/^(?:https?:|\/\/|file:|javascript:|data:text)/iu.test(rewritten.trim())) throw new Error('SVG contains an external reference')
  return rewritten
}

export function sanitizeClipboardSvg(source: string, idPrefix = 'pasted'): string {
  if (bytes(source) > canvasClipboardLimits.svgBytes) throw new Error('SVG exceeds the byte limit')
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName.toLowerCase() !== 'svg') throw new Error('SVG is malformed')
  const elements = [...parsed.documentElement.querySelectorAll('*')]
  if (elements.length + 1 > canvasClipboardLimits.svgNodes) throw new Error('SVG exceeds the node limit')
  const all = [parsed.documentElement, ...elements]
  const ids = new Map<string, string>()
  let nextId = 0
  for (const element of all) {
    let depth = 0
    for (let current: Element | null = element; current && current !== parsed.documentElement; current = current.parentElement) depth += 1
    if (depth > canvasClipboardLimits.treeDepth) throw new Error('SVG is nested too deeply')
    const name = element.localName.toLowerCase()
    if (rejectedSvgElements.has(name)) throw new Error('SVG contains active content')
    if (removableSvgElements.has(name)) { element.remove(); continue }
    if (!svgElements.has(name)) throw new Error('SVG contains an unsupported element')
    const id = element.getAttribute('id')
    if (id) {
      if (ids.has(id)) throw new Error('SVG contains duplicate ids')
      ids.set(id, `${idPrefix}-${++nextId}`)
    }
  }
  for (const element of all.filter(candidate => candidate.isConnected)) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) throw new Error('SVG contains an event handler')
      if (!svgAttributes.has(name)) throw new Error('SVG contains an unsupported attribute')
    }
    const id = element.getAttribute('id')
    if (id) element.setAttribute('id', ids.get(id)!)
    for (const attribute of [...element.attributes]) {
      if (attribute.name === 'id' || attribute.name === 'xmlns') continue
      if (attribute.name === 'href' || attribute.name === 'xlink:href' || attribute.value.includes('url(')) element.setAttribute(attribute.name, rewriteLocalReference(attribute.value, ids))
    }
  }
  return new XMLSerializer().serializeToString(parsed.documentElement)
}

function supportedHtml(source: string): boolean {
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  const elements = [...parsed.body.querySelectorAll('*')]
  return elements.length > 0 && elements.length <= canvasClipboardLimits.svgNodes
    && elements.every(element => supportedHtmlElements.has(element.localName.toLowerCase()) && element.attributes.length === 0)
}

const htmlText = (source: string): string => new DOMParser().parseFromString(source, 'text/html').body.textContent?.trim() ?? ''

export function resolveClipboardCandidate(data: ClipboardDataSource, atoms: readonly Atom[] = []): ResolvedClipboardCandidate {
  const types = [...new Set(Array.from(data.types, type => type.toLowerCase()))]
  if (types.length > canvasClipboardLimits.representations) return Object.freeze({ kind: 'unsupported', diagnostic: 'Clipboard contains too many representations' })
  let text = ''
  let html = ''
  try {
    text = types.includes('text/plain') ? data.getData('text/plain') : ''
    html = types.includes('text/html') ? data.getData('text/html') : ''
  } catch { return Object.freeze({ kind: 'unsupported', diagnostic: 'Clipboard data could not be read' }) }
  if (bytes(text) > canvasClipboardLimits.textBytes) return Object.freeze({ kind: 'unsupported', diagnostic: 'Clipboard text exceeds the byte limit' })
  if (bytes(html) > canvasClipboardLimits.htmlBytes) return Object.freeze({ kind: 'unsupported', diagnostic: 'Clipboard HTML exceeds the byte limit' })
  if (text && looksLikeSvg(text)) {
    try { return Object.freeze({ kind: 'svg', source: sanitizeClipboardSvg(text), name: 'pasted.svg' as const }) }
    catch (error) { return Object.freeze({ kind: 'unsupported', diagnostic: error instanceof Error ? error.message : 'SVG is invalid' }) }
  }
  const images = Array.from(data.files).filter(file => file.type.toLowerCase().startsWith('image/'))
  if (images.length) {
    if (images.length > canvasClipboardLimits.imageFiles || images.some(file => file.size > canvasClipboardLimits.imageBytes) || images.reduce((total, file) => total + file.size, 0) > canvasClipboardLimits.aggregateImageBytes) return Object.freeze({ kind: 'unsupported', diagnostic: 'Clipboard images exceed the import limit' })
    return Object.freeze({ kind: 'image-files', files: Object.freeze([...images]) })
  }
  if (html.includes(markerPrefix)) {
    try {
      const payload = decodeInternalClipboardHtml(html, atoms)
      if (!payload) throw new Error('Clipboard payload is missing')
      return Object.freeze({ kind: 'internal', payload, fallbackText: text || htmlText(html) })
    } catch (error) { return Object.freeze({ kind: 'unsupported', diagnostic: error instanceof Error ? error.message : 'Clipboard payload is invalid' }) }
  }
  if (html.includes(paperTreePrefix)) {
    try {
      const tree = decodePaperTemporaryTreeHtml(html)
      if (!tree) throw new Error('Paper clipboard tree is missing')
      return Object.freeze({ kind: 'paper-tree', tree, fallbackText: text || htmlText(html) })
    } catch (error) { return Object.freeze({ kind: 'unsupported', diagnostic: error instanceof Error ? error.message : 'Paper clipboard tree is invalid' }) }
  }
  if (html.includes(figmaMarker)) return Object.freeze({ kind: 'foreign-html', source: 'figma', html })
  if (html.includes(paperHtmlPrefix)) {
    try {
      const embedded = markerContents(html, paperHtmlPrefix, paperHtmlSuffix)
      if (embedded === null) throw new Error('Paper HTML is missing')
      return Object.freeze({ kind: 'foreign-html', source: 'paper', html: embedded })
    } catch (error) { return Object.freeze({ kind: 'unsupported', diagnostic: error instanceof Error ? error.message : 'Paper HTML is invalid' }) }
  }
  if (text && supportedHtml(text)) return Object.freeze({ kind: 'html', source: text })
  const flattened = html ? htmlText(html) : ''
  if (flattened) return Object.freeze({ kind: 'text', text: flattened })
  if (text) return Object.freeze({ kind: 'text', text })
  return Object.freeze({ kind: 'unsupported', diagnostic: 'Clipboard does not contain a supported representation' })
}

type DecodedClipboardImage = Readonly<{ width: number; height: number; close(): void }>
export type ClipboardImageDependencies = Readonly<{
  prepare: (file: File) => Promise<File>
  decode: (file: File) => Promise<DecodedClipboardImage>
}>

const browserImageDependencies = (): ClipboardImageDependencies => ({
  prepare: file => prepareImageFile(file),
  decode: file => createImageBitmap(file),
})

async function prepareOneClipboardImage(file: File, dependencies: ClipboardImageDependencies): Promise<ClipboardImage | ClipboardImageFailure> {
  try {
    const prepared = await dependencies.prepare(file)
    if (!(imageMimes as readonly string[]).includes(prepared.type) || prepared.size < 1 || prepared.size > appearanceLimits.assetBytes) throw new Error('Image format is not supported')
    const decoded = await dependencies.decode(prepared)
    try {
      if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width < 1 || decoded.height < 1
        || decoded.width > appearanceLimits.assetDimension || decoded.height > appearanceLimits.assetDimension
        || decoded.width * decoded.height > appearanceLimits.assetPixels) throw new Error('Image dimensions exceed the import limit')
      return Object.freeze({ file: prepared, width: decoded.width, height: decoded.height })
    } finally { decoded.close() }
  } catch (error) {
    return Object.freeze({ name: file.name || 'Image', diagnostic: error instanceof Error ? error.message : 'Image could not be imported' })
  }
}

export async function prepareClipboardCandidate(candidate: ResolvedClipboardCandidate, dependencies: ClipboardImageDependencies = browserImageDependencies()): Promise<ClipboardCandidate> {
  if (candidate.kind !== 'svg' && candidate.kind !== 'image-files') return candidate
  const sources = candidate.kind === 'svg' ? [new File([candidate.source], candidate.name, { type: 'image/svg+xml' })] : candidate.files
  const results: (ClipboardImage | ClipboardImageFailure)[] = new Array(sources.length)
  let next = 0
  const worker = async () => {
    while (next < sources.length) {
      const index = next++
      results[index] = await prepareOneClipboardImage(sources[index]!, dependencies)
    }
  }
  await Promise.all(Array.from({ length: Math.min(canvasClipboardLimits.imageConcurrency, sources.length) }, worker))
  const files = results.filter((result): result is ClipboardImage => Object.hasOwn(result, 'file'))
  const failures = results.filter((result): result is ClipboardImageFailure => !Object.hasOwn(result, 'file'))
  if (!files.length) return Object.freeze({ kind: 'unsupported', diagnostic: failures[0]?.diagnostic ?? 'Clipboard images could not be imported' })
  return Object.freeze({ kind: 'images', files: Object.freeze(files), failures: Object.freeze(failures) })
}
