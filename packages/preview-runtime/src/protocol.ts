import { isPreviewCamera, isPreviewGeometry, type PreviewCamera, type PreviewGeometryItem, type PreviewRootGeometry, type PreviewThemeDiagnostics, type PreviewUnsupportedLayout } from './geometry.js'
import { containerLonghands, isLayoutDeclarations, type LayoutDeclarations } from './layout-protocol.js'
export type { PreviewBoxMeasure, PreviewCamera, PreviewContentDistribution, PreviewThemeDiagnostics, PreviewThemeStatus, PreviewGeometryItem, PreviewGridMeasure, PreviewLayoutReport, PreviewMatrix, PreviewOffsetMeasure, PreviewRootGeometry, PreviewSides, PreviewTextMeasure, PreviewUnsupportedLayout } from './geometry.js'
export type { LayoutDeclarations, LayoutStatus } from './layout-protocol.js'
export { isLayoutDeclarations, layoutLonghands, layoutStatuses } from './layout-protocol.js'
/** Wire version of the editor/preview envelope. Version 8 adds ordered, identity-bound flow-drag transactions. */
export const protocolVersion = 8 as const
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export const previewBlendModes = ['normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'plus-lighter', 'color-dodge', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const
export type PreviewBlendMode = typeof previewBlendModes[number]
export type PreviewStop = { color: string; position: number; midpoint?: number }
export type PreviewFill =
  | { type: 'solid'; color: string; blendMode?: PreviewBlendMode }
  | { type: 'gradient'; shape: 'linear' | 'radial' | 'conic'; angle: number; center: { x: number; y: number }; length: number; interpolation: 'oklab' | 'oklch' | 'srgb'; stops: PreviewStop[]; blendMode?: PreviewBlendMode }
  | { type: 'image'; assetId: string; fit: 'cover' | 'contain' | 'stretch' | 'tile'; geometry?: { x: number; y: number; width: number; height: number }; blendMode?: PreviewBlendMode }
export type PreviewStroke = { color: string; width: number; style: 'solid' | 'dashed' | 'dotted' }
export type PreviewBorderSide = 'top' | 'bottom' | 'left' | 'right'
export type PreviewCornerRadii = { all: number } | { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number }
/** Render-ready appearance. Fills are in storage order, bottom to top. */
export type PreviewAppearance = { visible?: false; opacity?: number; blendMode?: PreviewBlendMode; fills?: PreviewFill[]; outline?: PreviewStroke & { offset: number }; borders?: Partial<Record<PreviewBorderSide, PreviewStroke>>; cornerRadii?: PreviewCornerRadii }
export const previewImageMimes = ['image/avif', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type PreviewAsset = { mime: typeof previewImageMimes[number]; data: string }
/** Effective design theme of one instance; `explicit` marks the root the theme layer stamps, the rest inherit through the DOM or a portal owner claim. */
export type PreviewNodeTheme = { mode: 'light' | 'dark'; designThemeId: string; attribute: string | null; colorScheme: 'light' | 'dark'; explicit: boolean }
export type PreviewTextAxisSizing = { mode: 'fixed' | 'fit' | 'fill' } | { mode: 'relative'; value: number }
export type PreviewTextSizing = { width: PreviewTextAxisSizing; height: PreviewTextAxisSizing }
export type PreviewTextLineHeightLiteral = { kind: 'normal' } | { kind: 'unitless' | 'percent' | 'px' | 'em'; value: number }
export type PreviewTextLineHeight = PreviewTextLineHeightLiteral | { kind: 'source'; property: string; fallback: PreviewTextLineHeightLiteral }
export type PreviewTextStyle = { fontFamily: string; fontStyle: 'normal' | 'italic' | 'oblique'; fontWeight: number; fontSize: number; lineHeight: PreviewTextLineHeight; letterSpacing: number; horizontalAlign: 'left' | 'center' | 'right' | 'justify'; verticalAlign: 'top' | 'middle' | 'bottom'; case: 'none' | 'uppercase' | 'lowercase' | 'capitalize'; wrap: 'normal' | 'pretty' | 'balance'; keepWords: boolean; maxLines?: number }
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
export type PreviewPrimitiveLayout = { mode: 'freeform' | 'flow' | 'absolute'; declarations: LayoutDeclarations }
export type PreviewCanvasElement = { id: string; kind: 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'; name: string; x: number; y: number; width: number; height: number; rotation: number; flipX?: boolean; flipY?: boolean; text?: string; textStyle?: PreviewTextStyle; textSizing?: PreviewTextSizing; parentId: string | null; clip?: boolean; appearance?: PreviewAppearance; layout?: PreviewPrimitiveLayout }
export type PreviewDocument = { version: 2; revision: number; rootIds: string[]; nodes: Record<string, PreviewDocumentNode>; frame: { width: number; height: number; direction: 'column' | 'row'; gap: number; padding: number; clip: boolean; name?: string }; canvas?: { elements: PreviewCanvasElement[] }; background?: string; assets?: Record<string, PreviewAsset> }
export type PreviewPropRule = { kind: 'string' | 'number' | 'boolean' } | { kind: 'enum'; values: readonly (string | number | boolean)[] }
export type PreviewRegistryBinding = { componentId: string; exportName: string; entryPath: string; props?: Readonly<Record<string, PreviewPropRule>>; slots?: readonly string[] }
/** The design theme applied to the preview document root. `attribute` becomes `data-theme`; null clears it for the base theme. */
export type PreviewTheme = { attribute: string | null; colorScheme: 'light' | 'dark' }
/** Placement for one mounted node: the five-field host placement plus optional layout longhands projected by the editor. */
export type PreviewLayoutItem = { nodeId: string; mode: 'flow' | 'absolute'; x: number; y: number; order: number; width?: number; height?: number; declarations?: LayoutDeclarations }
/** Pointer-only visual bounds. Optional dimensions make resize gestures live without changing the document. */
export type PreviewTransientMove = { nodeId: string; dx: number; dy: number; width?: number; height?: number; rotationDelta?: number; appearance?: PreviewAppearance }
export type PreviewPresentationFence = { documentRevision: number; layoutGeneration: number; measurementRevision: number }
export type PreviewMoveWorldPresentation = {
  kind: 'move-world'
  coordinateSpace: 'world'
  interactionId: string
  sampleSequence: number
  fence: PreviewPresentationFence
  items: { nodeId: string; dx: number; dy: number }[]
}
export type PreviewResizeParentPaddingPresentation = {
  kind: 'resize-parent-padding'
  coordinateSpace: 'parent-padding'
  interactionId: string
  sampleSequence: number
  fence: PreviewPresentationFence
  items: { nodeId: string; parentNodeId: string | null; startRect: { x: number; y: number; width: number; height: number }; rect: { x: number; y: number; width: number; height: number }; appearance?: PreviewAppearance }[]
}
export type PreviewFlowDragPoint = FlowDragPoint
export type PreviewFlowDragRect = FlowDragRect
export type PreviewFlowDragSize = FlowDragSize
export type PreviewFlowDragQuad = FlowDragQuad
export type PreviewFlowDragMatrix = FlowDragMatrix
export type PreviewFlowDragSlot = FlowDragSlot
export type PreviewFlowDragRelationship = FlowDragRelationship
export type PreviewFlowDragGeometry = FlowDragGeometry
export type PreviewFlowDragSourceFence = FlowDragSourceFence
export type PreviewFlowDragKey = FlowDragPresentationKey
export type PreviewFlowDragPresentation = FlowDragPresentation
export type PreviewFlowDragTransaction = Readonly<{
  key: PreviewFlowDragKey
  sourceFence: PreviewFlowDragSourceFence
  operation: Readonly<{ kind: 'publish'; presentation: PreviewFlowDragPresentation }>
    | Readonly<{ kind: 'tombstone' }>
    | Readonly<{
      kind: 'committed-handoff'
      committed: Readonly<{
        previewGeneration: number
        fileId: string
        pageId: string
        pageRootId: string
        documentRevision: number
        layoutGeneration: number
        afterMeasurementRevision: number
        terminalSequence: number
      }>
    }>
}>
export type PreviewTransientPresentation = PreviewMoveWorldPresentation | PreviewResizeParentPaddingPresentation

export type PreviewCommand =
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-props'; props: Record<string, JsonValue> }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-document'; document: PreviewDocument; flowDragTerminalPolicy: 'preserve-matching-committed-handoff'; theme?: PreviewTheme }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-theme'; theme: PreviewTheme }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-interaction-mode'; mode: 'select' | 'pan' | 'interact' }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-layout'; items: PreviewLayoutItem[]; layoutGeneration: number; flowDragTerminalPolicy: 'preserve-matching-committed-handoff' }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-transient-move'; items: PreviewTransientMove[] }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-transient-presentations'; presentations: PreviewTransientPresentation[] }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'apply-flow-drag-transaction'; transaction: PreviewFlowDragTransaction }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-selection'; nodeIds: string[]; color: string; renderChrome?: boolean }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'set-camera'; camera: PreviewCamera }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'dispose' }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'ping' }

export type PreviewWheel = { deltaX: number; deltaY: number; deltaMode: 0 | 1 | 2; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; clientX: number; clientY: number }
export type PreviewEvent =
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'source-bindings'; instanceIds: string[] }
  | { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number; type: 'geometry'; items: PreviewGeometryItem[]; root: PreviewRootGeometry | null; documentRevision: number; layoutGeneration: number; measurementRevision: number; camera?: PreviewCamera; unsupported?: PreviewUnsupportedLayout[]; theme?: PreviewThemeDiagnostics }
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
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  })
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 128
const exactFields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const textProps = new Set(['id', 'className', 'title', 'role', 'lang', 'dir', 'name', 'htmlFor', 'placeholder', 'autoComplete', 'pattern', 'form', 'list', 'accept'])
const booleanProps = new Set(['hidden', 'disabled', 'required', 'readOnly', 'checked', 'defaultChecked', 'multiple', 'autoFocus', 'draggable', 'spellCheck'])
const numericProps = new Set(['tabIndex', 'size', 'maxLength', 'minLength'])
const coordinateLimit = 1_000_000
const finiteWithin = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
const flowIntegerLimit = 2_147_483_647
const flowInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= flowIntegerLimit
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
/** Largest binary asset whose canonical base64 representation fits in one preview message asset entry. */
export const previewAssetByteLimit = 1_500_003
export const previewAppearanceLimits = { fills: 16, stops: 16, strokeWidth: 1000, outlineOffset: 1000, radius: 100_000, assets: 64, assetData: Math.ceil(previewAssetByteLimit / 3) * 4 }

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
  if (value.type === 'image') {
    if (!shape(value, ['type', 'assetId', 'fit'], ['geometry', 'blendMode']) || !validId(value.assetId) || assets === undefined || !Object.hasOwn(assets, value.assetId) || !oneOf(value.fit, ['cover', 'contain', 'stretch', 'tile'])) return false
    return !Object.hasOwn(value, 'geometry') || record(value.geometry) && shape(value.geometry, ['x', 'y', 'width', 'height']) && finiteWithin(value.geometry.x, coordinateLimit) && finiteWithin(value.geometry.y, coordinateLimit) && numberWithin(value.geometry.width, 1, coordinateLimit) && numberWithin(value.geometry.height, 1, coordinateLimit)
  }
  if (value.type !== 'gradient' || !shape(value, ['type', 'shape', 'angle', 'center', 'length', 'interpolation', 'stops'], ['blendMode'])) return false
  if (!oneOf(value.shape, ['linear', 'radial', 'conic']) || !oneOf(value.interpolation, ['oklab', 'oklch', 'srgb']) || !numberWithin(value.angle, -360, 360) || !numberWithin(value.length, 0.01, 10)) return false
  if (!record(value.center) || !shape(value.center, ['x', 'y']) || !numberWithin(value.center.x, -2, 3) || !numberWithin(value.center.y, -2, 3)) return false
  const stops = value.stops
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > previewAppearanceLimits.stops || !stops.every(isPreviewStop)) return false
  return stops.every((stop, index) => index === 0 || stop.position >= stops[index - 1]!.position)
}

function isPreviewCornerRadii(value: unknown): value is PreviewCornerRadii {
  if (!record(value)) return false
  if (shape(value, ['all'])) return numberWithin(value.all, 0, previewAppearanceLimits.radius)
  return shape(value, ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'])
    && [value.topLeft, value.topRight, value.bottomLeft, value.bottomRight].every(radius => numberWithin(radius, 0, previewAppearanceLimits.radius))
}

/** Validates a render-ready appearance. Image fills must name an asset present in `assets`. Text has no outline or borders. */
export function isPreviewAppearance(value: unknown, assets: Record<string, unknown> | undefined, kind: PreviewCanvasElement['kind'] | 'component' = 'component'): value is PreviewAppearance {
  if (!record(value) || !shape(value, [], ['visible', 'opacity', 'blendMode', 'fills', 'outline', 'borders', 'cornerRadii'])) return false
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
  if (Object.hasOwn(value, 'cornerRadii') && (!['component', 'frame', 'rectangle', 'shader'].includes(kind) || !isPreviewCornerRadii(value.cornerRadii))) return false
  return true
}

/** Local image assets keyed by id. Data is plain base64 (no data: prefix), so only the runtime builds the URL. */
export function isPreviewAssets(value: unknown): value is Record<string, PreviewAsset> {
  if (!record(value) || Object.keys(value).length > previewAppearanceLimits.assets) return false
  return Object.entries(value).every(([id, asset]) => validId(id) && record(asset) && shape(asset, ['mime', 'data']) && oneOf(asset.mime, previewImageMimes)
    && typeof asset.data === 'string' && asset.data.length > 0 && asset.data.length <= previewAppearanceLimits.assetData && asset.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(asset.data))
}

function validComponentProp(binding: Pick<PreviewRegistryBinding, 'props' | 'slots'> | undefined, name: string, value: unknown): boolean {
  if (name.startsWith('data-preview-')) return false
  if (/^on[A-Z]/.test(name) || ['dangerouslySetInnerHTML', 'style', 'ref', 'key'].includes(name)) return false
  if (!/^[A-Za-z_$][\w$-]{0,127}$/.test(name)) return false
  if (typeof value === 'string' && value.length > 10_000) return false
  if (typeof value === 'number' && !Number.isFinite(value)) return false
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false
  const rule = binding?.props?.[name]
  // ReactNode slots may be represented either by child instance ids in `children` or by a scalar document prop.
  // Scanner registries intentionally keep slots out of the scalar prop-rule table, so the declared slot list is the
  // only additional authority granted here. The collision check below still rejects a slot supplied both ways.
  if (binding?.props && !rule && !binding.slots?.includes(name)) return false
  if (rule?.kind === 'enum') return rule.values.some(candidate => candidate === value)
  if (rule) return typeof value === rule.kind
  if (/^(aria|data)-[a-z][a-z0-9-]*$/.test(name)) return true
  if (textProps.has(name)) return typeof value === 'string'
  if (booleanProps.has(name)) return typeof value === 'boolean'
  if (numericProps.has(name)) return typeof value === 'number'
  // Older scan snapshots do not yet carry prop rules. They stay scalar-only and still reject executable or raw HTML
  // surfaces. Generated registries should carry exact prop rules.
  return true
}

export function isPreviewCanvasElement(value: unknown, assets?: Record<string, unknown>): value is PreviewCanvasElement {
  if (!record(value)) return false
  const optional = ['flipX', 'flipY', 'text', 'textStyle', 'textSizing', 'clip', 'appearance', 'layout'].filter(name => Object.hasOwn(value, name))
  if (!exactFields(value, ['id', 'kind', 'name', 'x', 'y', 'width', 'height', 'rotation', 'parentId', ...optional])) return false
  if (!validId(value.id) || !['frame', 'rectangle', 'shape', 'shader', 'text'].includes(value.kind as string) || !validName(value.name)) return false
  if (!finiteWithin(value.x, coordinateLimit) || !finiteWithin(value.y, coordinateLimit) || !finiteWithin(value.rotation, coordinateLimit)) return false
  if (!finiteWithin(value.width, coordinateLimit) || !finiteWithin(value.height, coordinateLimit) || (value.width as number) < 1 || (value.height as number) < 1) return false
  if (Object.hasOwn(value, 'flipX') && typeof value.flipX !== 'boolean') return false
  if (Object.hasOwn(value, 'flipY') && typeof value.flipY !== 'boolean') return false
  if (Object.hasOwn(value, 'appearance') && !isPreviewAppearance(value.appearance, assets, value.kind as PreviewCanvasElement['kind'])) return false
  if (Object.hasOwn(value, 'text') && (typeof value.text !== 'string' || value.text.length > 10_000)) return false
  if (value.kind === 'text' ? typeof value.text !== 'string' || !isPreviewTextStyle(value.textStyle) || !isPreviewTextSizing(value.textSizing) || value.textStyle.maxLines !== undefined && value.textSizing.height.mode !== 'fit' : Object.hasOwn(value, 'text') || Object.hasOwn(value, 'textStyle') || Object.hasOwn(value, 'textSizing')) return false
  if (value.parentId !== null && !validId(value.parentId)) return false
  if (Object.hasOwn(value, 'clip') && (typeof value.clip !== 'boolean' || value.kind !== 'frame')) return false
  if (Object.hasOwn(value, 'layout') && !isPreviewPrimitiveLayout(value.layout, value.kind as PreviewCanvasElement['kind'])) return false
  return true
}

const primitiveTransformFields = new Set(['transform'])
const primitiveClipFields = new Set(['overflow'])
const primitivePositionFields = new Set(['position', 'left', 'right', 'top', 'bottom', 'z-index'])
const primitiveTextSizeFields = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio', 'flex-basis'])
const primitiveFreeformSizeFields = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height'])
const primitivePaddingFields = new Set(['padding-top', 'padding-right', 'padding-bottom', 'padding-left'])
const primitiveTextFreeformFields = new Set<string>()
const primitiveFrameFreeformFields = new Set([
  ...primitiveFreeformSizeFields,
  ...containerLonghands.filter(name => name !== 'overflow'),
  ...primitivePaddingFields,
])
const primitiveIntrinsicOrAutoSizes = new Set(['auto', 'fit-content', 'min-content', 'max-content'])
const hasPercentagePrimitiveSizing = (layout: PreviewPrimitiveLayout | undefined): boolean => layout !== undefined && Object.entries(layout.declarations).some(([name, value]) => primitiveFreeformSizeFields.has(name) && value.endsWith('%'))
function isPreviewPrimitiveLayout(value: unknown, kind: PreviewCanvasElement['kind']): value is PreviewPrimitiveLayout {
  if (!record(value) || !shape(value, ['mode', 'declarations']) || !oneOf(value.mode, ['freeform', 'flow', 'absolute']) || !isLayoutDeclarations(value.declarations)) return false
  const declarations = value.declarations as LayoutDeclarations
  const names = Object.keys(declarations)
  if (names.some(name => primitiveTransformFields.has(name) || primitiveClipFields.has(name))) return false
  if (kind !== 'frame' && names.some(name => containerLonghands.includes(name))) return false
  if (kind === 'text' && names.some(name => primitiveTextSizeFields.has(name))) return false
  if (value.mode === 'absolute') return declarations.position === 'absolute'
  if (names.some(name => primitivePositionFields.has(name))) return false
  if (value.mode === 'freeform') {
    const allowed = kind === 'frame' ? primitiveFrameFreeformFields : kind === 'text' ? primitiveTextFreeformFields : primitiveFreeformSizeFields
    if (names.some(name => !allowed.has(name))) return false
    if (['width', 'height'].some(name => declarations[name]?.endsWith('px'))) return false
    if (kind !== 'frame' && names.some(name => primitiveFreeformSizeFields.has(name) && primitiveIntrinsicOrAutoSizes.has(declarations[name]!))) return false
  }
  return true
}

function isPreviewTextAxisSizing(value: unknown): value is PreviewTextAxisSizing {
  if (!record(value) || !oneOf(value.mode, ['fixed', 'fit', 'fill', 'relative'])) return false
  return value.mode === 'relative' ? shape(value, ['mode', 'value']) && numberWithin(value.value, 0.01, 1000) : shape(value, ['mode'])
}

function isPreviewTextSizing(value: unknown): value is PreviewTextSizing {
  return record(value) && shape(value, ['width', 'height']) && isPreviewTextAxisSizing(value.width) && isPreviewTextAxisSizing(value.height)
}

function isPreviewTextLineHeightLiteral(value: unknown): value is PreviewTextLineHeightLiteral {
  if (!record(value) || !oneOf(value.kind, ['normal', 'unitless', 'percent', 'px', 'em'])) return false
  if (value.kind === 'normal') return shape(value, ['kind'])
  if (!shape(value, ['kind', 'value'])) return false
  if (value.kind === 'percent') return numberWithin(value.value, 1, 10_000)
  if (value.kind === 'px') return numberWithin(value.value, 0.1, 10_000)
  return numberWithin(value.value, 0.01, 100)
}

function isPreviewTextLineHeight(value: unknown): value is PreviewTextLineHeight {
  if (!record(value)) return false
  if (value.kind === 'source') return shape(value, ['kind', 'property', 'fallback']) && typeof value.property === 'string' && /^--[A-Za-z0-9_-]{1,64}$/.test(value.property) && isPreviewTextLineHeightLiteral(value.fallback)
  return isPreviewTextLineHeightLiteral(value)
}

function isPreviewTextStyle(value: unknown): value is PreviewTextStyle {
  if (!record(value) || !shape(value, ['fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing', 'horizontalAlign', 'verticalAlign', 'case', 'wrap', 'keepWords'], ['maxLines'])) return false
  if (typeof value.fontFamily !== 'string' || value.fontFamily.trim() !== value.fontFamily || value.fontFamily.length < 1 || value.fontFamily.length > 256 || /[\u0000-\u001f\u007f]/.test(value.fontFamily)) return false
  if (!oneOf(value.fontStyle, ['normal', 'italic', 'oblique']) || !Number.isInteger(value.fontWeight) || !numberWithin(value.fontWeight, 1, 1000)) return false
  if (!numberWithin(value.fontSize, 1, 10_000) || !isPreviewTextLineHeight(value.lineHeight) || !numberWithin(value.letterSpacing, -10_000, 10_000)) return false
  if (!oneOf(value.horizontalAlign, ['left', 'center', 'right', 'justify']) || !oneOf(value.verticalAlign, ['top', 'middle', 'bottom']) || !oneOf(value.case, ['none', 'uppercase', 'lowercase', 'capitalize']) || !oneOf(value.wrap, ['normal', 'pretty', 'balance']) || typeof value.keepWords !== 'boolean') return false
  return !Object.hasOwn(value, 'maxLines') || Number.isInteger(value.maxLines) && numberWithin(value.maxLines, 1, 10_000)
}

export function isPreviewDocument(value: unknown, registry?: readonly Pick<PreviewRegistryBinding, 'componentId' | 'exportName' | 'props' | 'slots'>[]): value is PreviewDocument {
  if (!record(value)) return false
  const optional = ['canvas', 'background', 'assets'].filter(name => Object.hasOwn(value, name))
  if (!exactFields(value, ['version', 'revision', 'rootIds', 'nodes', 'frame', ...optional]) || value.version !== 2 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false
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
      if (element.parentId === null && hasPercentagePrimitiveSizing(element.layout)) return false
      const visited = new Set([element.id]); let parentId: string | null | undefined = element.parentId
      while (parentId) { if (visited.has(parentId)) return false; visited.add(parentId); parentId = byId.get(parentId)?.parentId }
    }
  }
  for (const [id, node] of Object.entries(value.nodes)) {
    if (!record(node) || !exactFields(node, ['id', 'componentId', 'exportName', 'props', 'children', ...['name', 'appearance', 'theme'].filter(name => Object.hasOwn(node, name))]) || !validId(id) || node.id !== id || !validId(node.componentId) || typeof node.exportName !== 'string' || !/^[A-Za-z_$][\w$]{0,127}$/.test(node.exportName)) return false
    if (Object.hasOwn(node, 'theme') && !isPreviewNodeTheme(node.theme)) return false
    if (Object.hasOwn(node, 'name') && !validName(node.name)) return false
    if (Object.hasOwn(node, 'appearance') && !isPreviewAppearance(node.appearance, assets, 'component')) return false
    const binding = registry?.find(binding => binding.componentId === node.componentId && binding.exportName === node.exportName)
    if (registry && !binding) return false
    if (!record(node.props) || Object.keys(node.props).length > 100 || !record(node.children)) return false
    for (const [name, prop] of Object.entries(node.props)) if (!validComponentProp(binding, name, prop)) return false
    for (const [slot, children] of Object.entries(node.children)) {
      if (!/^[A-Za-z_$][\w$-]{0,127}$/.test(slot) || slot.startsWith('data-preview-') || binding?.slots && !binding.slots.includes(slot) || !Array.isArray(children) || children.length > 500 || !children.every(validId) || (children.length > 0 && Object.hasOwn(node.props, slot))) return false
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

function previewNodeParent(document: PreviewDocument, nodeId: string): string | null | undefined {
  let matches = 0
  let parent: string | null | undefined
  for (const canvas of document.canvas?.elements ?? []) if (canvas.id === nodeId) { matches += 1; parent = canvas.parentId }
  for (const rootId of document.rootIds) if (rootId === nodeId) { matches += 1; parent = null }
  for (const [candidateId, candidate] of Object.entries(document.nodes)) {
    if (!Object.values(candidate.children).some(children => children.includes(nodeId))) continue
    matches += 1
    parent = candidateId
  }
  return matches === 1 ? parent : undefined
}

function previewFlowNodeTopology(document: PreviewDocument, nodeId: string, pageRootId: string): FlowDragAuthoritativeSource | null {
  const component = Object.hasOwn(document.nodes, nodeId) ? document.nodes[nodeId] : undefined
  const canvas = document.canvas?.elements.filter(element => element.id === nodeId) ?? []
  if (component && canvas.length > 0 || canvas.length > 1) return null
  if (component) {
    const rootIndex = document.rootIds.indexOf(nodeId)
    if (rootIndex >= 0) return { kind: 'component', relationship: { parentId: pageRootId, orderKey: null, slot: { presence: 'absent' } }, sourceIndex: rootIndex }
    const parents: { parentId: string; slot: string; sourceIndex: number }[] = []
    for (const [parentId, parent] of Object.entries(document.nodes)) for (const [slot, children] of Object.entries(parent.children)) {
      const sourceIndex = children.indexOf(nodeId)
      if (sourceIndex >= 0) parents.push({ parentId, slot, sourceIndex })
    }
    if (parents.length !== 1) return null
    const parent = parents[0]!
    return { kind: 'component', relationship: { parentId: parent.parentId, orderKey: null, slot: { presence: 'present', value: parent.slot } }, sourceIndex: parent.sourceIndex }
  }
  const element = canvas[0]
  if (!element) return null
  const siblings = (document.canvas?.elements ?? []).filter(candidate => candidate.parentId === element.parentId)
  return {
    kind: element.kind,
    relationship: { parentId: element.parentId ?? pageRootId, orderKey: null, slot: { presence: 'absent' } },
    sourceIndex: siblings.findIndex(candidate => candidate.id === nodeId),
  }
}

function previewFlowTopologyAuthority(document: PreviewDocument, sourceFence: PreviewFlowDragSourceFence): FlowDragTopologyAuthority {
  return {
    fileId: sourceFence.fileId,
    fileRevision: document.revision,
    pageId: sourceFence.pageId,
    pageRootId: sourceFence.pageRootId,
    source: nodeId => previewFlowNodeTopology(document, nodeId, sourceFence.pageRootId),
    acceptsTarget: target => target.pageId === sourceFence.pageId
      && target.pageRootId === sourceFence.pageRootId
      && (target.targetLane.parentId === sourceFence.pageRootId || previewNodeParent(document, target.targetLane.parentId) !== undefined),
  }
}

function isPresentationFence(value: unknown): value is PreviewPresentationFence {
  return record(value)
    && exactFields(value, ['documentRevision', 'layoutGeneration', 'measurementRevision'])
    && ['documentRevision', 'layoutGeneration', 'measurementRevision'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
}

function isPresentationRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  return record(value)
    && exactFields(value, ['x', 'y', 'width', 'height'])
    && finiteWithin(value.x, coordinateLimit)
    && finiteWithin(value.y, coordinateLimit)
    && numberWithin(value.width, 1, coordinateLimit)
    && numberWithin(value.height, 1, coordinateLimit)
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameStructuredValue(value, right[index]))
  if (!record(left) || !record(right)) return false
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameStructuredValue(left[key], right[key]))
}

function sameImageFillExceptGeometry(candidate: Record<string, unknown>, authoritative: Record<string, unknown>): boolean {
  if (candidate.type !== 'image' || authoritative.type !== 'image') return false
  const candidateBase = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'geometry'))
  const authoritativeBase = Object.fromEntries(Object.entries(authoritative).filter(([key]) => key !== 'geometry'))
  return sameStructuredValue(candidateBase, authoritativeBase)
}

function isReviewedPresentationAppearance(candidate: unknown, authoritative: PreviewAppearance | undefined, assets: PreviewDocument['assets'], kind: PreviewCanvasElement['kind'] | 'component'): candidate is PreviewAppearance {
  if (!authoritative || !isPreviewAppearance(candidate, assets, kind) || !record(candidate)) return false
  const candidateRecord = candidate as Record<string, unknown>
  const authoritativeRecord = authoritative as Record<string, unknown>
  const candidateKeys = Object.keys(candidateRecord).sort(), authoritativeKeys = Object.keys(authoritativeRecord).sort()
  if (candidateKeys.length !== authoritativeKeys.length || !candidateKeys.every((key, index) => key === authoritativeKeys[index])) return false
  for (const key of candidateKeys) {
    if (key !== 'fills') {
      if (!sameStructuredValue(candidateRecord[key], authoritativeRecord[key])) return false
      continue
    }
    const candidateFills = candidateRecord.fills, authoritativeFills = authoritativeRecord.fills
    if (!Array.isArray(candidateFills) || !Array.isArray(authoritativeFills) || candidateFills.length !== authoritativeFills.length) return false
    for (let index = 0; index < candidateFills.length; index += 1) {
      const next = candidateFills[index], current = authoritativeFills[index]
      if (!record(next) || !record(current)) return false
      if (next.type === 'image' || current.type === 'image') {
        if (!sameImageFillExceptGeometry(next, current)) return false
      } else if (!sameStructuredValue(next, current)) return false
    }
  }
  return true
}

function exactDataObject(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === names.length && names.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  }) && keys.every(key => typeof key === 'string' && names.includes(key))
}

function sameFlowFence(left: PreviewFlowDragSourceFence, right: PreviewFlowDragSourceFence): boolean {
  return left.fileId === right.fileId && left.fileRevision === right.fileRevision && left.measurementRevision === right.measurementRevision
    && left.documentRevision === right.documentRevision && left.layoutGeneration === right.layoutGeneration
    && left.pageId === right.pageId && left.pageRootId === right.pageRootId
}

function flowPresentation(value: unknown, key: PreviewFlowDragKey, sourceFence: PreviewFlowDragSourceFence, document: PreviewDocument | null): value is PreviewFlowDragPresentation {
  return document !== null && validateFlowDragPresentation(value, key, sourceFence, previewFlowTopologyAuthority(document, sourceFence))
}

function flowKey(value: unknown): value is PreviewFlowDragKey {
  return isFlowDragPresentationKey(value)
}

function flowDragTransaction(value: unknown, generation: number, document: PreviewDocument | null): value is PreviewFlowDragTransaction {
  if (!exactDataObject(value, ['key', 'sourceFence', 'operation']) || !flowKey(value.key) || !isFlowDragSourceFence(value.sourceFence) || !record(value.operation)) return false
  if (value.operation.kind === 'publish') return document !== null && exactDataObject(value.operation, ['kind', 'presentation'])
    && flowPresentation(value.operation.presentation, value.key, value.sourceFence, document)
  if (value.operation.kind === 'tombstone') return exactDataObject(value.operation, ['kind'])
  if (!exactDataObject(value.operation, ['kind', 'committed']) || value.operation.kind !== 'committed-handoff'
    || !exactDataObject(value.operation.committed, ['previewGeneration', 'fileId', 'pageId', 'pageRootId', 'documentRevision', 'layoutGeneration', 'afterMeasurementRevision', 'terminalSequence'])) return false
  const committed = value.operation.committed
  return committed.previewGeneration === generation && committed.fileId === value.sourceFence.fileId && committed.pageId === value.sourceFence.pageId
    && committed.pageRootId === value.sourceFence.pageRootId && flowInteger(committed.documentRevision)
    && (committed.documentRevision as number) > value.sourceFence.documentRevision && flowInteger(committed.layoutGeneration)
    && (committed.layoutGeneration as number) >= value.sourceFence.layoutGeneration && flowInteger(committed.afterMeasurementRevision)
    && (committed.afterMeasurementRevision as number) > value.sourceFence.measurementRevision && committed.terminalSequence === value.key.sequence
}

const flowOperationRank = (transaction: PreviewFlowDragTransaction): number => transaction.operation.kind === 'publish' ? 0 : transaction.operation.kind === 'committed-handoff' ? 1 : 2

/** Returns null for a different interaction, otherwise negative/stable/positive ordering for one interaction. */
export function compareFlowDragTransactionOrder(current: PreviewFlowDragTransaction, incoming: PreviewFlowDragTransaction): -1 | 0 | 1 | null {
  if (current.key.interactionId !== incoming.key.interactionId) return null
  if (!sameFlowFence(current.sourceFence, incoming.sourceFence)) return null
  if (incoming.key.gestureGeneration !== current.key.gestureGeneration) return incoming.key.gestureGeneration > current.key.gestureGeneration ? 1 : -1
  if (incoming.key.sequence !== current.key.sequence) return incoming.key.sequence > current.key.sequence ? 1 : -1
  const rank = flowOperationRank(incoming) - flowOperationRank(current)
  return rank === 0 ? 0 : rank > 0 ? 1 : -1
}

function isTransientPresentations(value: unknown, document: PreviewDocument | null): value is PreviewTransientPresentation[] {
  if (!Array.isArray(value) || value.length > 500) return false
  if (value.length > 0 && document === null) return false
  const interactions = new Set<string>()
  const nodes = new Set<string>()
  let itemCount = 0
  for (const presentation of value) {
    if (!record(presentation)
      || !exactFields(presentation, ['kind', 'coordinateSpace', 'interactionId', 'sampleSequence', 'fence', 'items'])
      || !validId(presentation.interactionId)
      || interactions.has(presentation.interactionId)
      || !Number.isSafeInteger(presentation.sampleSequence)
      || (presentation.sampleSequence as number) < 0
      || !isPresentationFence(presentation.fence)
      || !Array.isArray(presentation.items)
      || presentation.items.length < 1) return false
    interactions.add(presentation.interactionId)
    itemCount += presentation.items.length
    if (itemCount > 500) return false
    if (presentation.kind === 'move-world') {
      if (presentation.coordinateSpace !== 'world') return false
      for (const item of presentation.items) {
        if (!record(item)
          || !exactFields(item, ['nodeId', 'dx', 'dy'])
          || !validId(item.nodeId)
          || nodes.has(item.nodeId)
          || !finiteWithin(item.dx, coordinateLimit)
          || !finiteWithin(item.dy, coordinateLimit)
          || document !== null && previewNodeParent(document, item.nodeId as string) === undefined) return false
        nodes.add(item.nodeId as string)
      }
      continue
    }
    if (presentation.kind !== 'resize-parent-padding' || presentation.coordinateSpace !== 'parent-padding') return false
    for (const item of presentation.items) {
      if (!record(item)) return false
      const fields = ['nodeId', 'parentNodeId', 'startRect', 'rect', ...(Object.hasOwn(item, 'appearance') ? ['appearance'] : [])]
      if (!exactFields(item, fields)
        || !validId(item.nodeId)
        || nodes.has(item.nodeId)
        || item.parentNodeId !== null && !validId(item.parentNodeId)
        || !isPresentationRect(item.startRect)
        || !isPresentationRect(item.rect)) return false
      if (document) {
        const parentNodeId = previewNodeParent(document, item.nodeId as string)
        if (parentNodeId === undefined || parentNodeId !== item.parentNodeId) return false
        if (Object.hasOwn(item, 'appearance')) {
          const canvas = document.canvas?.elements.find(element => element.id === item.nodeId)
          const component = Object.hasOwn(document.nodes, item.nodeId as string) ? document.nodes[item.nodeId as string] : undefined
          const kind = canvas?.kind ?? (component ? 'component' : null)
          const appearance = canvas?.appearance ?? component?.appearance
          if (!kind || !isReviewedPresentationAppearance(item.appearance, appearance, document.assets, kind)) return false
        }
      } else if (Object.hasOwn(item, 'appearance')) return false
      nodes.add(item.nodeId as string)
    }
  }
  return true
}

export function acceptPreviewCommand(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, editorOrigin: string, parent: MessageEventSource, generation: number, document: PreviewDocument | null = null, registry?: readonly Pick<PreviewRegistryBinding, 'componentId' | 'exportName' | 'props' | 'slots'>[]): PreviewCommand | null {
  if (event.origin !== editorOrigin || event.source !== parent || !record(event.data)) return null
  const data = event.data
  if (data.channel !== 'design-editor-preview' || data.version !== protocolVersion || data.generation !== generation) return null
  if ((data.type === 'dispose' || data.type === 'ping') && Object.keys(data).length === 4) return data as PreviewCommand
  if (data.type === 'set-theme') return exactFields(data, ['channel', 'version', 'generation', 'type', 'theme']) && isPreviewTheme(data.theme) ? data as PreviewCommand : null
  if (data.type === 'set-interaction-mode') return exactFields(data, ['channel', 'version', 'generation', 'type', 'mode']) && ['select', 'pan', 'interact'].includes(data.mode as string) ? data as PreviewCommand : null
  if (data.type === 'set-camera') return exactFields(data, ['channel', 'version', 'generation', 'type', 'camera']) && isPreviewCamera(data.camera) ? data as PreviewCommand : null
  if (data.type === 'set-layout') {
    if (!exactFields(data, ['channel', 'version', 'generation', 'type', 'items', 'layoutGeneration', 'flowDragTerminalPolicy']) || data.flowDragTerminalPolicy !== 'preserve-matching-committed-handoff' || !Array.isArray(data.items) || data.items.length > 500 || !Number.isSafeInteger(data.layoutGeneration) || (data.layoutGeneration as number) < 0) return null
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
      if (!record(item)) return null
      const fields = ['nodeId', 'dx', 'dy', ...['width', 'height', 'rotationDelta', 'appearance'].filter(key => Object.hasOwn(item, key))]
      if (!exactFields(item, fields) || !validId(item.nodeId) || ids.has(item.nodeId) || !finiteWithin(item.dx, coordinateLimit) || !finiteWithin(item.dy, coordinateLimit)) return null
      for (const key of ['width', 'height']) if (Object.hasOwn(item, key) && (!finiteWithin(item[key], coordinateLimit) || (item[key] as number) < 1)) return null
      if (Object.hasOwn(item, 'rotationDelta') && !finiteWithin(item.rotationDelta, coordinateLimit)) return null
      if (Object.hasOwn(item, 'appearance')) {
        const canvas = document?.canvas?.elements.find(element => element.id === item.nodeId)
        const kind = canvas?.kind ?? (document && Object.hasOwn(document.nodes, item.nodeId as string) ? 'component' : null)
        if (!kind || !isPreviewAppearance(item.appearance, document?.assets, kind)) return null
      }
      if (document && !Object.hasOwn(document.nodes, item.nodeId as string) && !document.canvas?.elements.some(element => element.id === item.nodeId)) return null
      ids.add(item.nodeId)
    }
    return data as PreviewCommand
  }
  if (data.type === 'set-transient-presentations') {
    if (!exactFields(data, ['channel', 'version', 'generation', 'type', 'presentations']) || data.version !== protocolVersion) return null
    let size = 0
    try { size = JSON.stringify(data).length }
    catch { return null }
    return size <= 1_000_000 && isTransientPresentations(data.presentations, document) ? data as PreviewCommand : null
  }
  if (data.type === 'apply-flow-drag-transaction') {
    if (!exactFields(data, ['channel', 'version', 'generation', 'type', 'transaction'])) return null
    if (!flowDragTransaction(data.transaction, generation, document)) return null
    let size = 0
    try { size = JSON.stringify(data).length }
    catch { return null }
    return size <= 1_000_000 ? data as PreviewCommand : null
  }
  if (data.type === 'set-selection') {
    if (!exactFields(data, ['channel', 'version', 'generation', 'type', 'nodeIds', 'color', ...(Object.hasOwn(data, 'renderChrome') ? ['renderChrome'] : [])]) || (Object.hasOwn(data, 'renderChrome') && typeof data.renderChrome !== 'boolean') || typeof data.color !== 'string' || data.color.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(data.color) || !Array.isArray(data.nodeIds) || data.nodeIds.length > 500 || !data.nodeIds.every(validId) || new Set(data.nodeIds).size !== data.nodeIds.length) return null
    if (!data.nodeIds.every(id => document !== null && (Object.hasOwn(document.nodes, id) || document.canvas?.elements.some(element => element.id === id)))) return null
    return data as PreviewCommand
  }
  if (data.type === 'set-document') {
    const fields = ['channel', 'version', 'generation', 'type', 'document', 'flowDragTerminalPolicy', ...(Object.hasOwn(data, 'theme') ? ['theme'] : [])]
    return exactFields(data, fields) && data.flowDragTerminalPolicy === 'preserve-matching-committed-handoff' && (!Object.hasOwn(data, 'theme') || isPreviewTheme(data.theme)) && isPreviewDocument(data.document, registry) ? data as PreviewCommand : null
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
    const fields = ['channel', 'version', 'generation', 'type', 'items', 'root', 'documentRevision', 'layoutGeneration', 'measurementRevision', ...['camera', 'unsupported', 'theme'].filter(key => Object.hasOwn(data, key))]
    return exactFields(data, fields)
      && Number.isSafeInteger(data.measurementRevision)
      && (data.measurementRevision as number) >= 0
      && isPreviewGeometry({ items: data.items, root: data.root, documentRevision: data.documentRevision, layoutGeneration: data.layoutGeneration, ...(Object.hasOwn(data, 'unsupported') ? { unsupported: data.unsupported } : {}), ...(Object.hasOwn(data, 'theme') ? { theme: data.theme } : {}) })
      && (!Object.hasOwn(data, 'camera') || isPreviewCamera(data.camera)) ? data as PreviewEvent : null
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
import {
  isFlowDragPresentationKey,
  isFlowDragSourceFence,
  validateFlowDragPresentation,
  type FlowDragAuthoritativeSource,
  type FlowDragGeometry,
  type FlowDragMatrix,
  type FlowDragPoint,
  type FlowDragPresentation,
  type FlowDragPresentationKey,
  type FlowDragQuad,
  type FlowDragRect,
  type FlowDragRelationship,
  type FlowDragSize,
  type FlowDragSlot,
  type FlowDragSourceFence,
  type FlowDragTopologyAuthority,
} from '@canvas/sync-protocol/flow'
