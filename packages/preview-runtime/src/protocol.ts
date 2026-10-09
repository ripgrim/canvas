import { isPreviewCamera, isPreviewGeometry, type PreviewCamera, type PreviewGeometryItem, type PreviewRootGeometry, type PreviewThemeDiagnostics, type PreviewUnsupportedLayout } from './geometry.js'
import { isLayoutDeclarations, type LayoutDeclarations } from './layout-protocol.js'
export type { PreviewBoxMeasure, PreviewCamera, PreviewContentDistribution, PreviewThemeDiagnostics, PreviewThemeStatus, PreviewGeometryItem, PreviewGridMeasure, PreviewLayoutReport, PreviewMatrix, PreviewOffsetMeasure, PreviewRootGeometry, PreviewSides, PreviewUnsupportedLayout } from './geometry.js'
export type { LayoutDeclarations, LayoutStatus } from './layout-protocol.js'
export { isLayoutDeclarations, layoutLonghands, layoutStatuses } from './layout-protocol.js'
/** Wire version of the editor/preview envelope. Version 3 adds the effective theme of every node and the theme layer's reports. */
export const protocolVersion = 3 as const
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export const previewBlendModes = ['normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'plus-lighter', 'color-dodge', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const
export type PreviewBlendMode = typeof previewBlendModes[number]
export type PreviewStop = { color: string; position: number; midpoint?: number }
export type PreviewFill =
  | { type: 'solid'; color: string; blendMode?: PreviewBlendMode }
  | { type: 'gradient'; shape: 'linear' | 'radial' | 'conic'; angle: number; center: { x: number; y: number }; length: number; interpolation: 'oklab' | 'oklch' | 'srgb'; stops: PreviewStop[]; blendMode?: PreviewBlendMode }
  | { type: 'image'; assetId: string; fit: 'cover' | 'contain' | 'stretch' | 'tile'; blendMode?: PreviewBlendMode }
export type PreviewStroke = { color: string; width: number; style: 'solid' | 'dashed' | 'dotted' }
export type PreviewBorderSide = 'top' | 'bottom' | 'left' | 'right'
/** Render-ready appearance. Fills are in storage order, bottom to top. */
export type PreviewAppearance = { visible?: false; opacity?: number; blendMode?: PreviewBlendMode; fills?: PreviewFill[]; outline?: PreviewStroke & { offset: number }; borders?: Partial<Record<PreviewBorderSide, PreviewStroke>> }
export const previewImageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type PreviewAsset = { mime: typeof previewImageMimes[number]; data: string }
/** Effective design theme of one instance; `explicit` marks the root the theme layer stamps, the rest inherit through the DOM or a portal owner claim. */
export type PreviewNodeTheme = { mode: 'light' | 'dark'; designThemeId: string; attribute: string | null; colorScheme: 'light' | 'dark'; explicit: boolean }
/** `theme` is absent only for source-binding baselines built from the legacy page view; the projection always sends it. */
export type PreviewDocumentNode = { id: string; componentId: string; exportName: string; name?: string; props: Record<string, string | number | boolean>; children: Record<string, string[]>; appearance?: PreviewAppearance; theme?: PreviewNodeTheme }
const themeIdPattern = /^[A-Za-z0-9_-]{1,40}$/
export function isPreviewNodeTheme(value: unknown): value is PreviewNodeTheme {
  if (!record(value) || !exactFields(value, ['mode', 'designThemeId', 'attribute', 'colorScheme', 'explicit'])) return false
  if (!['light', 'dark'].includes(value.mode as string) || !['light', 'dark'].includes(value.colorScheme as string)) return false
  if (typeof value.designThemeId !== 'string' || !themeIdPattern.test(value.designThemeId)) return false
  if (value.attribute !== null && (typeof value.attribute !== 'string' || !themeIdPattern.test(value.attribute))) return false
  return typeof value.explicit === 'boolean'
}
export type PreviewCanvasElement = { id: string; kind: 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'; name: string; x: number; y: number; width: number; height: number; rotation: number; text?: string; parentId: string | null; clip?: boolean; appearance?: PreviewAppearance }
export type PreviewDocument = { version: 1; revision: number; rootIds: string[]; nodes: Record<string, PreviewDocumentNode>; frame: { width: number; height: number; direction: 'column' | 'row'; gap: number; padding: number; clip: boolean; name?: string }; canvas?: { elements: PreviewCanvasElement[] }; background?: string; assets?: Record<string, PreviewAsset> }
export type PreviewRegistryBinding = { componentId: string; exportName: string; entryPath: string }
/** The design theme applied to the preview document root. `attribute` becomes `data-theme`; null clears it for the base theme. */
export type PreviewTheme = { attribute: string | null; colorScheme: 'light' | 'dark' }
/** Placement for one mounted node: the five-field host placement plus optional layout longhands projected by the editor. */
export type PreviewLayoutItem = { nodeId: string; mode: 'flow' | 'absolute'; x: number; y: number; order: number; width?: number; height?: number; declarations?: LayoutDeclarations }
/** A pointer-only visual offset. The editor clears it before committing authoritative document geometry. */
export type PreviewTransientMove = { nodeId: string; dx: number; dy: number }

export type PreviewCommand =
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-props'; props: Record<string, JsonValue> }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-document'; document: PreviewDocument; theme?: PreviewTheme }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-theme'; theme: PreviewTheme }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-interaction-mode'; mode: 'select' | 'pan' | 'interact' }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-layout'; items: PreviewLayoutItem[]; layoutGeneration: number }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-transient-move'; items: PreviewTransientMove[] }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-selection'; nodeIds: string[]; color: string; renderChrome?: boolean }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-camera'; camera: PreviewCamera }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'dispose' }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'ping' }

export type PreviewWheel = { deltaX: number; deltaY: number; deltaMode: 0 | 1 | 2; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; clientX: number; clientY: number }
export type PreviewEvent =
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'source-bindings'; instanceIds: string[] }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'geometry'; items: PreviewGeometryItem[]; root: PreviewRootGeometry | null; camera?: PreviewCamera; layoutGeneration?: number; unsupported?: PreviewUnsupportedLayout[]; theme?: PreviewThemeDiagnostics }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'ready'; componentId: string }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'diagnostic'; message: string }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'selected'; componentId: string; instanceId?: string; bounds: { x: number; y: number; width: number; height: number } }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'wheel'; wheel: PreviewWheel }

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => isJsonValue(item, depth + 1))
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.entries(value).length <= 1000 && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && isJsonValue(item, depth + 1))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 128
const exactFields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const textProps = new Set(['id', 'className', 'title', 'role', 'lang', 'dir', 'name', 'htmlFor', 'placeholder', 'autoComplete', 'pattern', 'form', 'list', 'accept'])
const booleanProps = new Set(['hidden', 'disabled', 'required', 'readOnly', 'checked', 'defaultChecked', 'multiple', 'autoFocus', 'draggable', 'spellCheck'])
const numericProps = new Set(['tabIndex', 'size', 'maxLength', 'minLength'])
const coordinateLimit = 1_000_000
const finiteWithin = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
export const isPreviewHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)

// Colors arrive as CSS already resolved by the editor. Only this grammar is accepted, so no url(), expression(), var(),
// declaration separators, or other CSS can reach an inline style. Numbers use JavaScript's own number formatting.
const colorNumber = String.raw`-?\d{1,4}(?:\.\d{1,24})?(?:e-\d{1,3})?`
const oklchPattern = new RegExp(String.raw`^oklch\((${colorNumber}) (${colorNumber}) (${colorNumber})(?: \/ (${colorNumber}))?\)$`)
const within = (text: string | undefined, min: number, max: number) => text !== undefined && Number.isFinite(Number(text)) && Number(text) >= min && Number(text) <= max

/** A hex or oklch(l c h[ / a]) color with l, c, and alpha in 0..1 and hue in 0..360. */
export function isPreviewColor(value: unknown): value is string {
  if (isPreviewHexColor(value)) return true
  if (typeof value !== 'string') return false
  const match = oklchPattern.exec(value)
  return match !== null && within(match[1], 0, 1) && within(match[2], 0, 1) && within(match[3], 0, 360) && (match[4] === undefined || within(match[4], 0, 1))
}

const unsafeCss = ['url(', 'expression(', 'var(', ';', '{', '}']
const safeColor = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && !unsafeCss.some(fragment => value.toLowerCase().includes(fragment)) && isPreviewColor(value)
const numberWithin = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const oneOf = (value: unknown, options: readonly string[]) => typeof value === 'string' && options.includes(value)
const blendField = (value: Record<string, unknown>) => !Object.hasOwn(value, 'blendMode') || oneOf(value.blendMode, previewBlendModes)
/** Required keys must all be present; every other key must be one of the optional keys. */
const shape = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
export const previewAppearanceLimits = { fills: 16, stops: 16, strokeWidth: 1000, outlineOffset: 1000, assets: 64, assetData: 2_000_004 }

function isPreviewStroke(value: unknown, outline: boolean): boolean {
  if (!record(value) || !shape(value, ['color', 'width', 'style', ...(outline ? ['offset'] : [])])) return false
  return safeColor(value.color) && numberWithin(value.width, 0, previewAppearanceLimits.strokeWidth) && oneOf(value.style, ['solid', 'dashed', 'dotted']) && (!outline || numberWithin(value.offset, -previewAppearanceLimits.outlineOffset, previewAppearanceLimits.outlineOffset))
}

function isPreviewStop(value: unknown): value is PreviewStop {
  return record(value) && shape(value, ['color', 'position'], ['midpoint']) && safeColor(value.color) && numberWithin(value.position, 0, 1) && (!Object.hasOwn(value, 'midpoint') || numberWithin(value.midpoint, 0, 1))
}

function isPreviewPaint(value: unknown, assets: Record<string, unknown> | undefined): value is PreviewFill {
  if (!record(value) || !blendField(value)) return false
  if (value.type === 'solid') return shape(value, ['type', 'color'], ['blendMode']) && safeColor(value.color)
  if (value.type === 'image') return shape(value, ['type', 'assetId', 'fit'], ['blendMode']) && validId(value.assetId) && assets !== undefined && Object.hasOwn(assets, value.assetId) && oneOf(value.fit, ['cover', 'contain', 'stretch', 'tile'])
  if (value.type !== 'gradient' || !shape(value, ['type', 'shape', 'angle', 'center', 'length', 'interpolation', 'stops'], ['blendMode'])) return false
  if (!oneOf(value.shape, ['linear', 'radial', 'conic']) || !oneOf(value.interpolation, ['oklab', 'oklch', 'srgb']) || !numberWithin(value.angle, -360, 360) || !numberWithin(value.length, 0.01, 10)) return false
  if (!record(value.center) || !shape(value.center, ['x', 'y']) || !numberWithin(value.center.x, -2, 3) || !numberWithin(value.center.y, -2, 3)) return false
  const stops = value.stops
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > previewAppearanceLimits.stops || !stops.every(isPreviewStop)) return false
  return stops.every((stop, index) => index === 0 || stop.position >= stops[index - 1]!.position)
}

/** Validates a render-ready appearance. Image fills must name an asset present in `assets`. Text has no outline or borders. */
export function isPreviewAppearance(value: unknown, assets: Record<string, unknown> | undefined, kind: PreviewCanvasElement['kind'] | 'component' = 'component'): value is PreviewAppearance {
  if (!record(value) || !shape(value, [], ['visible', 'opacity', 'blendMode', 'fills', 'outline', 'borders'])) return false
  if (Object.hasOwn(value, 'visible') && value.visible !== false) return false
  if (Object.hasOwn(value, 'opacity') && !numberWithin(value.opacity, 0, 1)) return false
  if (!blendField(value)) return false
  if (Object.hasOwn(value, 'fills') && (!Array.isArray(value.fills) || value.fills.length < 1 || value.fills.length > previewAppearanceLimits.fills || !value.fills.every(fill => isPreviewPaint(fill, assets)))) return false
  if (kind === 'text' && (Object.hasOwn(value, 'outline') || Object.hasOwn(value, 'borders'))) return false
  if (Object.hasOwn(value, 'outline') && !isPreviewStroke(value.outline, true)) return false
  if (Object.hasOwn(value, 'borders')) {
    const borders = value.borders
    if (!record(borders) || Object.keys(borders).length < 1 || !shape(borders, [], ['top', 'bottom', 'left', 'right']) || !Object.values(borders).every(side => isPreviewStroke(side, false))) return false
  }
  return true
}

/** Local image assets keyed by id. Data is plain base64 (no data: prefix), so only the runtime builds the URL. */
export function isPreviewAssets(value: unknown): value is Record<string, PreviewAsset> {
  if (!record(value) || Object.keys(value).length > previewAppearanceLimits.assets) return false
  return Object.entries(value).every(([id, asset]) => validId(id) && record(asset) && shape(asset, ['mime', 'data']) && oneOf(asset.mime, previewImageMimes)
    && typeof asset.data === 'string' && asset.data.length > 0 && asset.data.length <= previewAppearanceLimits.assetData && asset.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(asset.data))
}

function validFixtureProp(exportName: string, name: string, value: unknown): boolean {
  if (name.startsWith('data-preview-')) return false
  if (typeof value === 'string' && value.length > 10_000) return false
  if (typeof value === 'number' && !Number.isFinite(value)) return false
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false
  if (['children', 'heading', 'footer'].includes(name)) return name === 'children' ? exportName !== 'Input' : exportName === 'Card'
  if (name === 'variant') return exportName === 'Button' && ['primary', 'quiet'].includes(value as string)
  if (name === 'type') return exportName === 'Input' ? typeof value === 'string' : exportName === 'Button' && ['button', 'submit', 'reset'].includes(value as string)
  if (['value', 'defaultValue', 'min', 'max', 'step'].includes(name)) return ['Input', 'Button'].includes(exportName) && ['string', 'number'].includes(typeof value)
  if (/^(aria|data)-[a-z][a-z0-9-]*$/.test(name)) return true
  if (textProps.has(name)) return typeof value === 'string'
  if (booleanProps.has(name)) return typeof value === 'boolean'
  return numericProps.has(name) && typeof value === 'number'
}

export function isPreviewCanvasElement(value: unknown, assets?: Record<string, unknown>): value is PreviewCanvasElement {
  if (!record(value)) return false
  const optional = ['text', 'clip', 'appearance'].filter(name => Object.hasOwn(value, name))
  if (!exactFields(value, ['id', 'kind', 'name', 'x', 'y', 'width', 'height', 'rotation', 'parentId', ...optional])) return false
  if (!validId(value.id) || !['frame', 'rectangle', 'shape', 'shader', 'text'].includes(value.kind as string) || !validName(value.name)) return false
  if (!finiteWithin(value.x, coordinateLimit) || !finiteWithin(value.y, coordinateLimit) || !finiteWithin(value.rotation, coordinateLimit)) return false
  if (!finiteWithin(value.width, coordinateLimit) || !finiteWithin(value.height, coordinateLimit) || (value.width as number) < 1 || (value.height as number) < 1) return false
  if (Object.hasOwn(value, 'appearance') && !isPreviewAppearance(value.appearance, assets, value.kind as PreviewCanvasElement['kind'])) return false
  if (Object.hasOwn(value, 'text') && (typeof value.text !== 'string' || value.text.length > 10_000)) return false
  if (value.kind === 'text' ? typeof value.text !== 'string' : Object.hasOwn(value, 'text')) return false
  if (value.parentId !== null && !validId(value.parentId)) return false
  if (Object.hasOwn(value, 'clip') && (typeof value.clip !== 'boolean' || value.kind !== 'frame')) return false
  return true
}

export function isPreviewDocument(value: unknown, registry?: readonly Pick<PreviewRegistryBinding, 'componentId' | 'exportName'>[]): value is PreviewDocument {
  if (!record(value)) return false
  const optional = ['canvas', 'background', 'assets'].filter(name => Object.hasOwn(value, name))
  if (!exactFields(value, ['version', 'revision', 'rootIds', 'nodes', 'frame', ...optional]) || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false
  if (!record(value.nodes) || Object.keys(value.nodes).length > 500 || !Array.isArray(value.rootIds) || value.rootIds.length > 500 || !record(value.frame)) return false
  const frame = value.frame
  if (!exactFields(frame, ['width', 'height', 'direction', 'gap', 'padding', 'clip', ...(Object.hasOwn(frame, 'name') ? ['name'] : [])]) || !['row', 'column'].includes(frame.direction as string) || typeof frame.clip !== 'boolean') return false
  if (Object.hasOwn(frame, 'name') && !validName(frame.name)) return false
  for (const key of ['width', 'height', 'gap', 'padding']) if (typeof frame[key] !== 'number' || !Number.isFinite(frame[key]) || frame[key] < (key === 'width' || key === 'height' ? 64 : 0) || frame[key] > 8192) return false
  if (Object.hasOwn(value, 'assets') && !isPreviewAssets(value.assets)) return false
  if (Object.hasOwn(value, 'background') && !safeColor(value.background)) return false
  const assets = Object.hasOwn(value, 'assets') ? value.assets as Record<string, PreviewAsset> : undefined
  if (Object.hasOwn(value, 'canvas')) {
    const canvas = value.canvas
    if (!record(canvas) || !exactFields(canvas, ['elements']) || !Array.isArray(canvas.elements) || canvas.elements.length > 500 || !canvas.elements.every(element => isPreviewCanvasElement(element, assets))) return false
    const ids = new Set<string>()
    const elements = canvas.elements as PreviewCanvasElement[]
    for (const element of elements) { if (ids.has(element.id) || Object.hasOwn(value.nodes, element.id)) return false; ids.add(element.id) }
    const byId = new Map(elements.map(element => [element.id, element]))
    for (const element of elements) {
      if (element.parentId && byId.get(element.parentId)?.kind !== 'frame') return false
      const visited = new Set([element.id]); let parentId: string | null | undefined = element.parentId
      while (parentId) { if (visited.has(parentId)) return false; visited.add(parentId); parentId = byId.get(parentId)?.parentId }
    }
  }
  for (const [id, node] of Object.entries(value.nodes)) {
    if (!record(node) || !exactFields(node, ['id', 'componentId', 'exportName', 'props', 'children', ...['name', 'appearance', 'theme'].filter(name => Object.hasOwn(node, name))]) || !validId(id) || node.id !== id || !validId(node.componentId) || !['Card', 'Label', 'Input', 'Button'].includes(node.exportName as string)) return false
    if (Object.hasOwn(node, 'theme') && !isPreviewNodeTheme(node.theme)) return false
    if (Object.hasOwn(node, 'name') && !validName(node.name)) return false
    if (Object.hasOwn(node, 'appearance') && !isPreviewAppearance(node.appearance, assets, 'component')) return false
    if (registry && !registry.some(binding => binding.componentId === node.componentId && binding.exportName === node.exportName)) return false
    if (!record(node.props) || Object.keys(node.props).length > 100 || !record(node.children)) return false
    for (const [name, prop] of Object.entries(node.props)) if (!validFixtureProp(node.exportName as string, name, prop)) return false
    for (const [slot, children] of Object.entries(node.children)) {
      if (node.exportName !== 'Card' || !['children', 'heading', 'footer'].includes(slot) || !Array.isArray(children) || children.length > 500 || !children.every(validId) || (children.length > 0 && Object.hasOwn(node.props, slot))) return false
    }
  }
  const doc = value as unknown as PreviewDocument
  const visited = new Set<string>()
  function visit(id: unknown, depth: number): boolean {
    if (!validId(id) || !Object.hasOwn(doc.nodes, id) || visited.has(id) || depth > 64) return false
    visited.add(id)
    return Object.values(doc.nodes[id]!.children).every(children => children.every(child => visit(child, depth + 1)))
  }
  // Asset data has its own per-entry and count limits; everything else keeps the total document size limit.
  const { assets: _assets, ...structure } = doc
  return doc.rootIds.every(id => visit(id, 0)) && visited.size === Object.keys(doc.nodes).length && JSON.stringify(structure).length <= 1_000_000
}

export function isPreviewTheme(value: unknown): value is PreviewTheme {
  return record(value) && exactFields(value, ['attribute', 'colorScheme']) && (value.attribute === null || typeof value.attribute === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value.attribute)) && ['light', 'dark'].includes(value.colorScheme as string)
}

export function acceptPreviewCommand(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, editorOrigin: string, parent: MessageEventSource, generation: number, document: PreviewDocument | null = null): PreviewCommand | null {
  if (event.origin !== editorOrigin || event.source !== parent || !record(event.data)) return null
  const data = event.data
  if (data.channel !== 'design-editor-preview' || data.version !== protocolVersion || data.generation !== generation) return null
  if ((data.type === 'dispose' || data.type === 'ping') && Object.keys(data).length === 4) return data as PreviewCommand
  if (data.type === 'set-theme') return exactFields(data, ['channel', 'version', 'generation', 'type', 'theme']) && isPreviewTheme(data.theme) ? data as PreviewCommand : null
  if (data.type === 'set-interaction-mode') return exactFields(data, ['channel', 'version', 'generation', 'type', 'mode']) && ['select', 'pan', 'interact'].includes(data.mode as string) ? data as PreviewCommand : null
  if (data.type === 'set-camera') return exactFields(data, ['channel', 'version', 'generation', 'type', 'camera']) && isPreviewCamera(data.camera) ? data as PreviewCommand : null
  if (data.type === 'set-layout') {
    if (!exactFields(data, ['channel', 'version', 'generation', 'type', 'items', 'layoutGeneration']) || !Array.isArray(data.items) || data.items.length > 500 || !Number.isSafeInteger(data.layoutGeneration) || (data.layoutGeneration as number) < 0) return null
    const ids = new Set<string>()
    for (const item of data.items) {
      if (!record(item) || !exactFields(item, ['nodeId', 'mode', 'x', 'y', 'order', ...['width', 'height', 'declarations'].filter(key => Object.hasOwn(item, key))]) || !validId(item.nodeId) || ids.has(item.nodeId) || !['flow', 'absolute'].includes(item.mode as string)) return null
      if (Object.hasOwn(item, 'declarations') && !isLayoutDeclarations(item.declarations)) return null
      if (!['x', 'y', 'order'].every(key => typeof item[key] === 'number' && Number.isFinite(item[key])) || !Number.isInteger(item.order) || (item.order as number) < 0 || (item.order as number) > 500 || Math.abs(item.x as number) > 1_000_000 || Math.abs(item.y as number) > 1_000_000) return null
      if (document && !Object.hasOwn(document.nodes, item.nodeId as string)) return null
      for (const key of ['width', 'height']) if (Object.hasOwn(item, key) && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || (item[key] as number) < 1 || (item[key] as number) > 1_000_000)) return null
      ids.add(item.nodeId)
    }
    return data as PreviewCommand
  }
  if (data.type === 'set-transient-move') {
    if (!exactFields(data, ['channel', 'version', 'generation', 'type', 'items']) || !Array.isArray(data.items) || data.items.length > 500) return null
    const ids = new Set<string>()
    for (const item of data.items) {
      if (!record(item) || !exactFields(item, ['nodeId', 'dx', 'dy']) || !validId(item.nodeId) || ids.has(item.nodeId) || !finiteWithin(item.dx, coordinateLimit) || !finiteWithin(item.dy, coordinateLimit)) return null
      if (document && !Object.hasOwn(document.nodes, item.nodeId as string) && !document.canvas?.elements.some(element => element.id === item.nodeId)) return null
      ids.add(item.nodeId)
    }
    return data as PreviewCommand
  }
  if (data.type === 'set-selection') {
    if (!exactFields(data, ['channel', 'version', 'generation', 'type', 'nodeIds', 'color', ...(Object.hasOwn(data, 'renderChrome') ? ['renderChrome'] : [])]) || (Object.hasOwn(data, 'renderChrome') && typeof data.renderChrome !== 'boolean') || typeof data.color !== 'string' || data.color.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(data.color) || !Array.isArray(data.nodeIds) || data.nodeIds.length > 500 || !data.nodeIds.every(validId) || new Set(data.nodeIds).size !== data.nodeIds.length) return null
    if (!data.nodeIds.every(id => document !== null && (Object.hasOwn(document.nodes, id) || document.canvas?.elements.some(element => element.id === id)))) return null
    return data as PreviewCommand
  }
  if (data.type === 'set-document') {
    const fields = ['channel', 'version', 'generation', 'type', 'document', ...(Object.hasOwn(data, 'theme') ? ['theme'] : [])]
    return exactFields(data, fields) && (!Object.hasOwn(data, 'theme') || isPreviewTheme(data.theme)) && isPreviewDocument(data.document) ? data as PreviewCommand : null
  }
  if (data.type !== 'set-props' || Object.keys(data).length !== 5 || !record(data.props) || !isJsonValue(data.props)) return null
  if (JSON.stringify(data.props).length > 65_536) return null
  return data as PreviewCommand
}

function isPreviewWheel(value: unknown): value is PreviewWheel {
  if (!record(value) || !exactFields(value, ['deltaX', 'deltaY', 'deltaMode', 'ctrlKey', 'metaKey', 'shiftKey', 'clientX', 'clientY'])) return false
  if (![0, 1, 2].includes(value.deltaMode as number)) return false
  if (!['ctrlKey', 'metaKey', 'shiftKey'].every(key => typeof value[key] === 'boolean')) return false
  return ['deltaX', 'deltaY', 'clientX', 'clientY'].every(key => finiteWithin(value[key], 1_000_000))
}

export function acceptPreviewEvent(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, previewOrigin: string, previewWindow: MessageEventSource, generation: number): PreviewEvent | null {
  if (event.origin !== previewOrigin || event.source !== previewWindow || !record(event.data)) return null
  const data = event.data
  if (data.channel !== 'design-editor-preview' || data.version !== protocolVersion || data.generation !== generation) return null
  if (data.type === 'source-bindings') return exactFields(data, ['channel', 'version', 'generation', 'type', 'instanceIds']) && Array.isArray(data.instanceIds) && data.instanceIds.length <= 500 && data.instanceIds.every(validId) && new Set(data.instanceIds).size === data.instanceIds.length ? data as PreviewEvent : null
  if (data.type === 'geometry') {
    const fields = ['channel', 'version', 'generation', 'type', 'items', 'root', ...['camera', 'layoutGeneration', 'unsupported', 'theme'].filter(key => Object.hasOwn(data, key))]
    return exactFields(data, fields) && isPreviewGeometry({ items: data.items, root: data.root, ...(Object.hasOwn(data, 'layoutGeneration') ? { layoutGeneration: data.layoutGeneration } : {}), ...(Object.hasOwn(data, 'unsupported') ? { unsupported: data.unsupported } : {}), ...(Object.hasOwn(data, 'theme') ? { theme: data.theme } : {}) }) && (!Object.hasOwn(data, 'camera') || isPreviewCamera(data.camera)) ? data as PreviewEvent : null
  }
  if (data.type === 'wheel') return exactFields(data, ['channel', 'version', 'generation', 'type', 'wheel']) && isPreviewWheel(data.wheel) ? data as PreviewEvent : null
  if (data.type === 'ready' && typeof data.componentId === 'string' && data.componentId.length <= 200 && Object.keys(data).length === 5) return data as PreviewEvent
  if (data.type === 'diagnostic' && typeof data.message === 'string' && data.message.length <= 4000 && Object.keys(data).length === 5) return data as PreviewEvent
  if (data.type !== 'selected' || typeof data.componentId !== 'string' || data.componentId.length > 200 || !record(data.bounds) || Object.keys(data).length !== (Object.hasOwn(data, 'instanceId') ? 7 : 6) || (Object.hasOwn(data, 'instanceId') && !validId(data.instanceId))) return null
  const bounds = data.bounds
  if (Object.keys(bounds).length !== 4 || !['x', 'y', 'width', 'height'].every(key => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]))) return null
  if ((bounds.width as number) < 0 || (bounds.height as number) < 0) return null
  return data as PreviewEvent
}


export function sameSourceStructure(baseline: PreviewDocument, document: PreviewDocument): boolean {
  const slots = (node: PreviewDocumentNode) => Object.entries(node.children).filter(([, ids]) => ids.length).map(([slot, ids]) => [slot, [...ids].sort()] as const).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([...baseline.rootIds].sort()) === JSON.stringify([...document.rootIds].sort()) && JSON.stringify(Object.keys(baseline.nodes).sort()) === JSON.stringify(Object.keys(document.nodes).sort()) && Object.entries(baseline.nodes).every(([id, original]) => { const next = document.nodes[id]; return next && original.componentId === next.componentId && original.exportName === next.exportName && JSON.stringify(slots(original)) === JSON.stringify(slots(next)) })
}
