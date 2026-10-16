import { acceptsChild, ancestorsOf, applyFileCommand, applyFileCommandWithHistory, childrenOf, descendantsOf, legacyTextProperties, nodeChildDisplay, nodeIsLocked, nodePositionMode, nodeWorldTransform, pageRoot, resolveToken, validateFileCommand, validateFileDocument, worldPosition } from '@canvas/repo-engine/file-document'
import type { ColorToken, FileCommand, FileDocument, FileNode, FileToken, NodePlacement, Paint, PrimitiveKind, PrimitiveStylePatch, PrimitiveStyles, SourcePalette, TextSizing, TextStyle, TokenType, TokenValue } from '@canvas/repo-engine/file-document'
import { appearanceLimits, defaultFillColor, imageMimes, nextBorders, validateImageAssetReference } from '@canvas/repo-engine/appearance'
import { nodeAppearance } from '@canvas/repo-engine/file-document'
import type { Appearance, BlendMode, BorderSide, Borders, ColorValue, ImageAssetReference, ImageExtension, ImageMime, Outline, Stroke } from '@canvas/repo-engine/appearance'
import type { DocumentNodeLayout } from '@canvas/repo-engine/document'
import { layoutFromLegacy, legacyLayout } from '@canvas/repo-engine/layout'
import type { NodeLayout, SizingMode } from '@canvas/repo-engine/layout'
import { positionAbsolute, positionFlow, positionFreeform, setAspectRatio, setAxisBound, setAxisLength, setAxisSizing, setAxisSizingMany, setInset, setSpacing, setZIndex, sizingModeOf } from './layout-commands'
import { createFlexCommands } from './layout-flex-commands'
import type { LayoutCommandContext } from './layout-flex-commands'
import { paperWrapCopy, planPaperWrap } from './layout-wrap-planner'
import type { PaperWrapFailure, PaperWrapPlanResult } from './layout-wrap-planner'
import { paperRemoveFlexCopy, planPaperRemoveFlex } from './layout-remove-planner'
import type { PaperRemoveFlexFailure, PaperRemoveFlexPlanResult } from './layout-remove-planner'
import type { LayoutGeometry } from './layout-measure'
import { createGridCommands } from './layout-grid-commands'
import { layoutWithPose, reparentPose } from './layout-pose'
import { nodeThemeProjection } from '@canvas/repo-engine/file-preview'
import type { PreviewNodeTheme, ThemeDiagnostic, ThemeProjectionContext } from '@canvas/repo-engine/file-preview'
import { nodeThemeMode, resolveEffectiveNodeTheme, fallbackScheme } from '@canvas/repo-engine/node-theme'
import type { EffectiveNodeTheme, NodeThemeMode } from '@canvas/repo-engine/node-theme'
import type { MeasuredNode } from './scene-geometry'
import { flowHost, hostOrigin } from '@canvas/repo-engine/file-document'
import type { Axis, InsetSide, SizingTarget } from './layout-commands'
import type { InsetLength, LayoutLength, NodeSpacing } from '@canvas/repo-engine/layout'
import type { Color } from '@canvas/repo-engine/color'
import { compareOrder, orderKeyBetween } from '@canvas/repo-engine/order-keys'
import type { Atom } from './types'
import { validateFlowDragPresentationStructure } from '@canvas/sync-protocol/flow'
import { canvasCopy } from './canvas-copy'
import { clipboardCopy } from './clipboard-copy'
import { canvasElementSizes } from './canvas-drawing'
import { prepareImageFile } from './image-import'
import { planGestureCommand } from './gesture-command-planner'
import type { GestureCommandSnapshot, GestureFinalIntent } from './gesture-command-planner'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { CanvasBounds, CanvasCreationIntent } from './canvas-drawing'
import { clampZoom, fitCamera, gridVisible, nudgeStep, nudgeStepLarge, screenToWorld, stepZoom, zoomAtPoint } from './canvas-math'
import type { Camera, Point, Rect, ResizeAxis, ResizeHandle, Size, SnapGuide } from './canvas-math'
import { selectChildren, selectParents } from './canvas-scene'
import type { Scene } from './canvas-scene'
import { createStore } from 'zustand/vanilla'
import type { EditorAssetPreview, EditorAssetUpload, EditorAssetUploadResult, EditorPersistenceIntent } from '../../capabilities'
import { componentDefaultValues, componentDocsSlug, componentVariantCombinationLabel, componentVariantCombinations, resolveComponentInstanceValues } from '@canvas/repo-engine/component-model'
import type { ComponentDefinition, ComponentInstanceValues, ComponentInteraction, ComponentPropertyDefinition, ComponentScalarValue } from '@canvas/repo-engine/component-model'
import { identityTransform, invertTransform, multiplyTransforms, transformedBounds, transformPoint, translationTransform } from '@canvas/repo-engine/transform-matrix'
import { canNestComponentInstance, linkCanvasComponentCommand, mapParallelComponentSubtrees } from './component-canvas-link'
import { codeComponentInstanceValues, componentConfigurableDefinition, componentPropertyProjectionCommands, componentPropertyRebindingResetCommands, componentPropertyRemovalResetCommands, componentSlotRebindingCommands } from './component-property-projection'
import { componentMaterialProjectionCommands } from './component-material-projection'
import { planClipboardImageInsertion } from './clipboard-image-insertion'
import { nearestCompatiblePasteParent } from './clipboard-placement'
import { planValidatedInternalPaste, planValidatedInternalReplace } from './clipboard-internal'
import type { InternalPastePlacement, InternalReplaceGeometry, VerifiedCrossFileAssets } from './clipboard-internal'
import type { InternalClipboardAssetPreviews } from './clipboard-internal-buffer'
import type { InternalClipboardPayload } from './clipboard-codec'
import { planComponentSlotDrafts } from './component-configured-instance'
import type { ComponentSlotDraft } from './component-configured-instance'
import { planComponentInstanceSwap } from './component-instance-swap'

export type Viewport = Camera
export type CanvasTool = 'move' | 'scale' | 'hand' | 'frame' | 'shader' | 'text' | 'rectangle' | 'shape' | 'interact'
/** Transient gesture state shared between the interaction layer and the HUD. Never persisted. */
export type CanvasTransient =
  | { kind: 'marquee'; rect: Rect }
  | { kind: 'move'; rects: Record<string, Rect>; offset: Point; guides: SnapGuide[]; targetFrameId: string | null; insertion: { axis: 'x' | 'y'; rect: Rect } | null; duplicate?: boolean }
  | { kind: 'resize'; interactionId: string }
  | { kind: 'draw'; elementKind: PrimitiveKind; rect: Rect; targetFrameId: string | null }
  | { kind: 'pan' }
export type DocumentState = {
  /** The authoritative design file. Every page, node, relationship, and token lives here. */
  file: FileDocument | null
  /** The open page; a viewing preference, not design data. */
  pageId: string | null
  atoms: Atom[]
  selection: string[]
  hover: string | null
  renaming: string | null
  /** The one active content-editing transaction. Its token prevents stale DOM events from editing a later session. */
  textEditing: Readonly<{ sessionId: string; nodeId: string }> | null
  transient: CanvasTransient | null
  viewport: Viewport
  viewportSize: Size
  gridVisible: boolean
  fitRequested: 'all' | 'selection' | null
  /** Space is held: the hand tool is temporarily active without changing the selected tool. */
  spaceHeld: boolean
  tool: CanvasTool
  dirty: boolean
  saving: boolean
  error: string | null
  blocked: boolean
  /** Server-enforced view-only mode. View state remains interactive; semantic document commands are rejected locally. */
  readOnly: boolean
  canUndo: boolean
  canRedo: boolean
  /** Live appearance preview during a gesture: node id to appearance (null clears). Never persisted or recorded. */
  appearanceOverrides: Record<string, Appearance | null> | null
  /** Live layout preview during a gesture: node id to layout record (null clears). Protocol-only; never persisted or recorded. */
  layoutOverrides: Record<string, NodeLayout | null> | null
  /** Increments whenever transient layout begins, commits, or cancels, so measurements from an older projection are recognizable. */
  layoutGeneration: number
}
export type DocumentErrorNotice = Readonly<{ title: string; message: string }>
type StoreOptions = {
  persist?: (file: FileDocument, expectedRevision: number, intent: EditorPersistenceIntent) => Promise<FileDocument>
  uploadImage?: (input: EditorAssetUpload) => Promise<EditorAssetUploadResult>
  onChange?: (file: FileDocument) => void
  onSelection?: (nodeIds: string[]) => void
  onPageChange?: (pageId: string) => void
  onToolChange?: (tool: CanvasTool) => void
  onError?: (notice: DocumentErrorNotice) => void
  /** Resolved design stylesheet colors for the active preview theme, used to resolve `source` tokens. */
  sources?: () => SourcePalette
  /** Design themes, the file's preview choice and per-theme palettes, for resolving each node in its own effective theme. */
  themeContext?: () => ThemeProjectionContext
  editorMode?: () => 'light' | 'dark'
}
/** One history step owns the semantic inverse plus both sides of its page and selection view. */
export type HistoryEntry = {
  file: FileDocument
  pageId: string
  selection: string[]
  afterPageId: string
  afterSelection: string[]
  undo: FileCommand
  redo: FileCommand
}
export type DocumentHistory = { past: HistoryEntry[]; future: HistoryEntry[] }
type KeyInput = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
export type MoveCommit = { id: string; x: number; y: number; parentId?: string | null; width?: number; height?: number }
export type InsertTarget = { parentId: string | null; slot?: string; index?: number }
export type LayerTreeDropTarget = InsertTarget & { duplicate?: boolean }
export type ComponentInsertPoint = { x: number; y: number }
export type SourceTokenImport = Readonly<{ property: string; name: string; fallback: Color }>
export type PersistenceCommit = Readonly<{ committed: boolean; persistence: Promise<void> | null }>
/** Local gestures may omit this. A live collaboration owner supplies it so its exact terminal claim binds the already planned command. */
export type GesturePersistenceBinder = (command: FileCommand) => EditorPersistenceIntent | null
export type PaperWrapExecutionResult = PaperWrapFailure | Readonly<{ status: 'written'; wrapperIds: readonly string[] }>
export type PaperRemoveFlexExecutionResult = PaperRemoveFlexFailure | Readonly<{ status: 'written'; parentIds: readonly string[] }>
type TextEditSession = Readonly<{
  sessionId: string
  nodeId: string
  before: Readonly<{ file: FileDocument; pageId: string; selection: string[] }>
  beforeText: string
  pastBefore: readonly HistoryEntry[]
  futureBefore: readonly HistoryEntry[]
  visibleCanUndo: boolean
  visibleCanRedo: boolean
  creation?: Readonly<{
    before: Readonly<{ file: FileDocument; pageId: string; selection: string[] }>
    pastBefore: readonly HistoryEntry[]
    futureBefore: readonly HistoryEntry[]
    insert: Extract<FileCommand, { type: 'node.insert' }>
  }>
}>
type PersistenceReceipt = Readonly<{
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}>
type PendingPersistenceChange = Readonly<{ file: FileDocument; intent: EditorPersistenceIntent; receipt: PersistenceReceipt | null }>
type AssetPreviewData = Readonly<{ sha256: string; mime: ImageMime; data: string }>

const dataProperty = (value: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined
}

function exactFrozenRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || !Object.isFrozen(value)) return false
    const ownKeys = Reflect.ownKeys(value)
    return ownKeys.length === keys.length && ownKeys.every(key => typeof key === 'string' && keys.includes(key)
      && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable)
      && 'value' in Object.getOwnPropertyDescriptor(value, key)!)
  } catch { return false }
}

function exactFrozenSingleCommand(value: unknown, command: FileCommand): value is readonly [FileCommand] {
  if (!Array.isArray(value)) return false
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value)) return false
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== 2 || !ownKeys.includes('0') || !ownKeys.includes('length')) return false
    const item = Object.getOwnPropertyDescriptor(value, '0')
    const length = Object.getOwnPropertyDescriptor(value, 'length')
    return Boolean(item && item.enumerable && 'value' in item && item.value === command
      && length && !length.enumerable && 'value' in length && length.value === 1)
  } catch { return false }
}

function deeplyFrozenData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true
  if (seen.has(value)) return true
  try {
    if (!Object.isFrozen(value)) return false
    seen.add(value)
    return Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor && 'value' in descriptor && deeplyFrozenData(descriptor.value, seen))
    })
  } catch { return false }
}

function freezeData<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw new Error('The planned command contains an accessor.')
    freezeData(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function exactFlowPersistenceBinding(value: unknown): value is NonNullable<EditorPersistenceIntent['flow']> {
  if (!exactFrozenRecord(value, ['claim', 'terminalPresentation'])) return false
  const claim = dataProperty(value, 'claim')
  const presentation = dataProperty(value, 'terminalPresentation')
  if (!exactFrozenRecord(claim, ['pageId', 'interactionId', 'sourceNodeId', 'localClaimGeneration'])
    || !deeplyFrozenData(presentation) || presentation === null || typeof presentation !== 'object') return false
  const pageId = dataProperty(claim, 'pageId')
  const interactionId = dataProperty(claim, 'interactionId')
  const sourceNodeId = dataProperty(claim, 'sourceNodeId')
  const localClaimGeneration = dataProperty(claim, 'localClaimGeneration')
  const identity = dataProperty(presentation, 'identity')
  const fence = dataProperty(presentation, 'fence')
  const original = dataProperty(presentation, 'original')
  if (typeof pageId !== 'string' || !pageId || typeof interactionId !== 'string' || !interactionId || typeof sourceNodeId !== 'string' || !sourceNodeId
    || !Number.isSafeInteger(localClaimGeneration) || (localClaimGeneration as number) <= 0
    || identity === null || typeof identity !== 'object' || fence === null || typeof fence !== 'object' || original === null || typeof original !== 'object') return false
  const gestureGeneration = dataProperty(identity, 'gestureGeneration')
  const sampleSequence = dataProperty(identity, 'sampleSequence')
  const presentationInteractionId = dataProperty(identity, 'interactionId')
  const presentationPageId = dataProperty(fence, 'pageId')
  const presentationSourceNodeId = dataProperty(original, 'documentNodeId')
  if (presentationInteractionId !== interactionId || presentationPageId !== pageId || presentationSourceNodeId !== sourceNodeId
    || !Number.isSafeInteger(gestureGeneration) || (gestureGeneration as number) < 0
    || !Number.isSafeInteger(sampleSequence) || (sampleSequence as number) < 0) return false
  try { structuredClone(presentation) } catch { return false }
  return validateFlowDragPresentationStructure(presentation, {
    interactionId,
    gestureGeneration: gestureGeneration as number,
    sequence: sampleSequence as number,
  }, fence as Parameters<typeof validateFlowDragPresentationStructure>[2])
}

function exactBoundPersistenceIntent(value: unknown, command: FileCommand, flow: boolean): value is EditorPersistenceIntent {
  const keys = flow ? ['kind', 'commands', 'flow'] : ['kind', 'commands']
  if (!exactFrozenRecord(value, keys) || dataProperty(value, 'kind') !== 'commands'
    || !exactFrozenSingleCommand(dataProperty(value, 'commands'), command)) return false
  if (flow && !exactFlowPersistenceBinding(dataProperty(value, 'flow'))) return false
  try { structuredClone(value); return true } catch { return false }
}

function decodedByteLength(data: string): number {
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(canvasCopy.unsupportedImage)
  try { return atob(data).length } catch { throw new Error(canvasCopy.unsupportedImage) }
}

function validateAssetPreview(asset: ImageAssetReference, preview: EditorAssetPreview): AssetPreviewData {
  if (preview.assetId !== asset.id || preview.sha256 !== asset.sha256 || preview.mime !== asset.mime || decodedByteLength(preview.data) !== asset.bytes) throw new Error(canvasCopy.unsupportedImage)
  return { sha256: preview.sha256, mime: preview.mime, data: preview.data }
}

function decodeAssetPreview(asset: ImageAssetReference, preview: EditorAssetPreview): Uint8Array {
  validateAssetPreview(asset, preview)
  const binary = atob(preview.data)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function sameAssetReference(left: ImageAssetReference, right: ImageAssetReference): boolean {
  return left.id === right.id && left.name === right.name && left.mime === right.mime && left.extension === right.extension
    && left.width === right.width && left.height === right.height && left.bytes === right.bytes && left.sha256 === right.sha256
}

function hydratedAssetPreviews(file: FileDocument, previews: readonly EditorAssetPreview[]): Map<string, AssetPreviewData> {
  const hydrated = new Map<string, AssetPreviewData>()
  for (const preview of previews) {
    if (hydrated.has(preview.assetId)) throw new Error(canvasCopy.unsupportedImage)
    const asset = file.assets?.[preview.assetId]
    if (!asset) throw new Error(canvasCopy.unsupportedImage)
    hydrated.set(preview.assetId, validateAssetPreview(asset, preview))
  }
  return hydrated
}

/** The world-space point represented by the visible center of the canvas. */
export function componentInsertionPoint(state: Pick<DocumentState, 'viewport' | 'viewportSize'>): ComponentInsertPoint {
  return screenToWorld({ x: state.viewportSize.width / 2, y: state.viewportSize.height / 2 }, state.viewport, state.viewportSize)
}
/** Paper production bundle: duplicated and placed artboards sit 20 world units to the right of their source. */
export const duplicateGap = 20

const sparseComponentValues = (definition: ComponentDefinition, values: ComponentInstanceValues): ComponentInstanceValues => {
  const defaults = componentDefaultValues(definition)
  return Object.fromEntries(Object.entries(values).filter(([propertyId, value]) => defaults[propertyId] !== value))
}
const defaultCamera: Viewport = { x: 0, y: 0, zoom: 1 }
const elementNames: Record<PrimitiveKind, string> = { frame: 'Frame', rectangle: 'Rectangle', shape: 'Shape', shader: 'Shader', text: 'Text' }
const literalColor = (hex: string) => ({ kind: 'literal' as const, color: { kind: 'hex' as const, hex } })
/** New text contrasts with editor chrome. */
const defaultAppearance = (kind: PrimitiveKind, makeId: () => string, textMode: NodeThemeMode = 'light'): Appearance => {
  if (kind === 'shader') return { fills: [{ id: makeId(), type: 'gradient', shape: 'linear', angle: 135, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ id: makeId(), position: 0, color: literalColor('#685fff') }, { id: makeId(), position: 1, color: literalColor('#202124') }] }] }
  const hex = kind === 'frame' || kind === 'rectangle' ? '#ffffff' : kind === 'text' ? textMode === 'dark' ? '#ffffff' : '#000000' : '#d9d9d9'
  return { fills: [{ id: makeId(), type: 'solid', color: literalColor(hex) }] }
}

function literalDefault(member: string): string | number | boolean | undefined {
  const value = member.trim()
  if (value === 'string') return ''
  if (value === 'number') return 0
  if (value === 'boolean') return false
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
  const quoted = /^(?:'([^']*)'|"([^"]*)")$/.exec(value)
  return quoted ? quoted[1] ?? quoted[2] ?? '' : undefined
}

/** Required verified scalar props get deterministic safe values; optional props and child slots remain absent. */
export function componentDefaultProps(atom: Atom): Record<string, string | number | boolean> {
  const slots = new Set(atom.slots ?? [])
  return Object.fromEntries(atom.props.flatMap(prop => {
    if (prop.optional || slots.has(prop.name)) return []
    for (const member of prop.type.split('|')) {
      const value = literalDefault(member)
      if (value !== undefined) return [[prop.name, value] as const]
    }
    return []
  }))
}

/** A copy of a paint with new fill and stop identities, for cloning a structure onto other nodes. */
function withFreshIds(paint: Paint, makeId: () => string): Paint {
  const copy = structuredClone(paint)
  copy.id = makeId()
  if (copy.type === 'gradient') copy.stops = copy.stops.map(stop => ({ ...stop, id: makeId() }))
  if (copy.cache?.gradient) copy.cache = { ...copy.cache, gradient: { ...copy.cache.gradient, stops: copy.cache.gradient.stops.map(stop => ({ ...stop, id: makeId() })) } }
  return copy
}

/** Pre-order node ids of the open page: the same order the layer tree shows. */
export function documentOrder(file: FileDocument, pageId: string): string[] {
  const root = pageRoot(file, pageId)
  if (!root) return []
  const ordered: string[] = []
  const visit = (id: string) => { for (const child of childrenOf(file, id)) { ordered.push(child); visit(child) } }
  visit(root)
  return ordered
}

export const isPrimitive = (node: FileNode | undefined): node is Extract<FileNode, { styles: PrimitiveStyles }> => Boolean(node && node.type !== 'root' && node.type !== 'component')

const emptyDocumentState = (): DocumentState => ({ file: null, pageId: null, atoms: [], selection: [], hover: null, renaming: null, textEditing: null, transient: null, viewport: defaultCamera, viewportSize: { width: 0, height: 0 }, gridVisible: false, fitRequested: null, spaceHeld: false, tool: 'move', dirty: false, saving: false, error: null, blocked: false, readOnly: false, canUndo: false, canRedo: false, appearanceOverrides: null, layoutOverrides: null, layoutGeneration: 0 })

const placementCommand = (node: FileNode | undefined, placement: DocumentNodeLayout): FileCommand => ({ type: 'node.setLayout', nodeId: node!.id, layout: layoutFromLegacy(placement, node?.type === 'component' ? node.layout : undefined) })
export function createDocumentStore(makeId: () => string = () => crypto.randomUUID()) {
  const backing = createStore<DocumentState>(emptyDocumentState)
  let viewSource = backing.getState()
  let viewSnapshot = viewSource
  let shellSource = viewSource
  let shellSnapshot = viewSource
  /** React panels do not consume pointer-only transient geometry, so keep their snapshot stable across drag frames. */
  const getViewSnapshot = () => {
    const next = backing.getState()
    if (next === viewSource) return viewSnapshot
    const sameExceptTransient = (Object.keys(next) as (keyof DocumentState)[]).every(key => key === 'transient' || next[key] === viewSource[key])
    viewSource = next
    if (!sameExceptTransient) viewSnapshot = next
    return viewSnapshot
  }
  /** The editor shell leaves live gesture rendering to its subscribed inspector and preview services. */
  const getShellSnapshot = () => {
    const next = backing.getState()
    if (next === shellSource) return shellSnapshot
    const sameExceptLiveGesture = (Object.keys(next) as (keyof DocumentState)[]).every(key => key === 'transient' || key === 'appearanceOverrides' || key === 'layoutOverrides' || next[key] === shellSource[key])
    shellSource = next
    if (!sameExceptLiveGesture) shellSnapshot = next
    return shellSnapshot
  }
  let options: StoreOptions = {}
  /** Render bytes are session-local sidecar data. The authoritative schema stores immutable references only. */
  const assetPreviewData = new Map<string, AssetPreviewData>()
  let editPolicy: ((file: FileDocument) => void) | undefined
  let past: HistoryEntry[] = []
  let future: HistoryEntry[] = []
  let generation = 0
  let savedRevision = 0
  let pendingPersistenceChanges: PendingPersistenceChange[] = []
  let persistenceRun: Promise<void> | null = null
  let selectionAnchor: string | null = null
  let persistenceBlocked = false
  let textSession: TextEditSession | null = null
  const noPersistenceCommit: PersistenceCommit = Object.freeze({ committed: false, persistence: null })
  const persistenceReceipt = (): PersistenceReceipt => {
    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: unknown) => void = () => undefined
    let settled = false
    const promise = new Promise<void>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
    return Object.freeze({
      promise,
      resolve() { if (!settled) { settled = true; resolvePromise() } },
      reject(error: unknown) { if (!settled) { settled = true; rejectPromise(error) } },
    })
  }
  const rejectPersistenceChanges = (changes: readonly PendingPersistenceChange[], error: Error) => {
    for (const change of changes) change.receipt?.reject(error)
  }
  const subscriptions = new Set<() => void>()
  const emit = (patch: Partial<DocumentState>) => backing.setState(patch)
  const messageFor = (error: unknown) => error instanceof Error ? error.message : canvasCopy.persistenceFailed
  const report = (error: unknown, title: string = canvasCopy.changeFailed) => { const message = messageFor(error); emit({ error: message }); options.onError?.({ title, message }); return false }
  const permits = (file: FileDocument) => { try { editPolicy?.(file); return true } catch (error) { return report(error) } }
  const currentView = () => { const state = backing.getState(); return { file: state.file!, pageId: state.pageId!, selection: [...state.selection] } }
  const setSelection = (selection: string[]) => { emit({ selection, renaming: null }); options.onSelection?.(selection) }
  const selectable = (file: FileDocument, pageId: string | null, id: string) => { const node = file.nodes[id]; return Boolean(node && node.type !== 'root' && (pageId === null || documentOrder(file, pageId).includes(id))) }
  const sources = () => options.sources?.() ?? {}
  const themeContext = (): ThemeProjectionContext => options.themeContext?.() ?? { themes: [], previewThemeId: null, palette: () => sources() }
  const root = (state: DocumentState) => state.file && state.pageId ? pageRoot(state.file, state.pageId) : null
  const capturePersistenceChange = (): Readonly<{ change: PendingPersistenceChange; count: number }> | null => {
    const first = pendingPersistenceChanges[0]
    if (!first) return null
    return { change: first, count: 1 }
  }
  const commandFor = (intent: EditorPersistenceIntent): FileCommand => intent.commands.length === 1 ? intent.commands[0]! : { type: 'batch', commands: [...intent.commands] }
  const rebasePersistenceChanges = (base: FileDocument, changes: readonly PendingPersistenceChange[], atoms: Atom[]): PendingPersistenceChange[] => {
    let projected = base
    return changes.map(change => {
      projected = applyFileCommand(projected, commandFor(change.intent), atoms, { allowUnavailableBindings: true })
      return { file: projected, intent: change.intent, receipt: change.receipt }
    })
  }
  const persist = async () => {
    const state = backing.getState()
    if (!options.persist || state.saving || !state.dirty || !state.file || persistenceBlocked) return
    const currentGeneration = generation
    emit({ saving: true })
    try {
      while (currentGeneration === generation) {
        const state = backing.getState()
        if (!state.dirty || !state.file) break
        const captured = capturePersistenceChange()
        if (!captured) break
        const acknowledged = await options.persist(captured.change.file, savedRevision, captured.change.intent)
        if (currentGeneration !== generation) return
        const current = backing.getState()
        const saved = validateFileDocument(acknowledged, current.atoms, { allowUnavailableBindings: true })
        savedRevision = saved.revision
        pendingPersistenceChanges.splice(0, captured.count)
        captured.change.receipt?.resolve()
        pendingPersistenceChanges = rebasePersistenceChanges(saved, pendingPersistenceChanges, current.atoms)
        const projected = pendingPersistenceChanges.at(-1)?.file ?? saved
        emit({ file: projected, dirty: pendingPersistenceChanges.length > 0 })
      }
    } catch (error) {
      if (currentGeneration === generation) {
        capturePersistenceChange()?.change.receipt?.reject(error)
        persistenceBlocked = true
        const message = messageFor(error)
        emit({ blocked: true, error: message })
        options.onError?.({ title: canvasCopy.saveFailed, message })
      }
    } finally { if (currentGeneration === generation) emit({ saving: false }) }
  }
  const schedulePersistence = () => {
    if (!options.persist) return null
    if (persistenceRun) return persistenceRun
    const running = persist()
    let tracked: Promise<void>
    tracked = running.finally(() => { if (persistenceRun === tracked) persistenceRun = null })
    persistenceRun = tracked
    return tracked
  }
  const changed = (file: FileDocument, pageId: string, selection: string[], intent: EditorPersistenceIntent, trackPersistence = false, patch: Partial<DocumentState> = {}) => {
    const receipt = trackPersistence && options.persist ? persistenceReceipt() : null
    pendingPersistenceChanges.push({ file, intent, receipt })
    const state = backing.getState()
    const pageChanged = pageId !== state.pageId
    emit({
      file, pageId, selection, dirty: true, error: null, canUndo: past.length > 0, canRedo: future.length > 0, ...patch,
      ...(textSession ? { renaming: textSession.nodeId, textEditing: { sessionId: textSession.sessionId, nodeId: textSession.nodeId } } : {}),
    })
    if (pageChanged) options.onPageChange?.(pageId)
    options.onSelection?.(selection)
    options.onChange?.(file)
    void schedulePersistence()
    return receipt?.promise ?? null
  }
  const same = (left: FileDocument, right: FileDocument) => JSON.stringify({ ...left, revision: 0 }) === JSON.stringify({ ...right, revision: 0 })
  const authoritativeGestureSnapshot = (state: DocumentState, snapshot: GestureCommandSnapshot) => Boolean(
    state.file
    && state.file.fileId === snapshot.file.fileId
    && state.file.revision === snapshot.file.revision
    && same(state.file, snapshot.file)
    && state.layoutGeneration === snapshot.layoutGeneration
    && JSON.stringify(state.atoms) === JSON.stringify(snapshot.atoms),
  )
  const authoritativeResizeGestureSnapshot = (state: DocumentState, snapshot: GestureCommandSnapshot) => {
    const resize = snapshot as Partial<GestureAuthoritySnapshot>
    return authoritativeGestureSnapshot(state, snapshot)
      && typeof resize.pageId === 'string'
      && state.pageId === resize.pageId
      && Array.isArray(resize.selection)
      && state.selection.length === resize.selection.length
      && state.selection.every((nodeId, index) => nodeId === resize.selection![index])
  }
  const gestureCommitAllowed = (snapshot: GestureCommandSnapshot, resize: boolean) => {
    const state = backing.getState()
    return Boolean(
      state.file
      && !state.readOnly
      && !state.blocked
      && !persistenceBlocked
      && !textSession
      && !state.textEditing
      && (resize ? authoritativeResizeGestureSnapshot(state, snapshot) : authoritativeGestureSnapshot(state, snapshot)),
    )
  }
  const commitWithPersistence = (projection: ReturnType<typeof applyFileCommandWithHistory>, selection: string[], pageId = backing.getState().pageId!, trackPersistence = false, persistenceCommand: FileCommand = projection.redo, preCommitGuard?: () => boolean, persistenceIntent?: EditorPersistenceIntent): PersistenceCommit => {
    const state = backing.getState()
    const next = projection.file
    if (state.readOnly) return noPersistenceCommit
    const candidateBeforePolicy = preCommitGuard ? JSON.stringify(next) : null
    if (!permits(next)) return noPersistenceCommit
    if (preCommitGuard && (!preCommitGuard() || JSON.stringify(next) !== candidateBeforePolicy)) return noPersistenceCommit
    if (same(next, state.file!)) return noPersistenceCommit
    const before = currentView()
    const page = next.pages.some(candidate => candidate.id === pageId) ? pageId : next.pages[0]!.id
    const nextSelection = selection.filter(id => selectable(next, page, id))
    past.push({ ...before, afterPageId: page, afterSelection: nextSelection, undo: projection.undo, redo: projection.redo })
    if (past.length > 100) past.shift()
    future = []
    const persistence = changed(next, page, nextSelection, persistenceIntent ?? { kind: 'commands', commands: [persistenceCommand] }, trackPersistence)
    return Object.freeze({ committed: true, persistence })
  }
  const fail = (error: unknown, title?: string) => report(error, title)
  /** Applies one semantic command (or batch) as one undo step. */
  const executeWithPersistence = (command: FileCommand, selection?: string[], pageId?: string, trackPersistence = false, persistenceCommand?: FileCommand, preCommitGuard?: () => boolean, persistenceIntent?: EditorPersistenceIntent): PersistenceCommit => {
    const state = backing.getState()
    if (!state.file || persistenceBlocked || textSession) return noPersistenceCommit
    if (commandMutatesProtectedInstanceStructure(state.file, command) || commandMutatesInstanceSwapState(state.file, command)) return noPersistenceCommit
    try {
      const linkedCommand = linkCanvasComponentCommand(state.file, command, state.atoms, makeId)
      return commitWithPersistence(applyFileCommandWithHistory(state.file, linkedCommand, state.atoms, { allowUnavailableBindings: true }), selection ?? state.selection, pageId, trackPersistence, persistenceCommand ?? linkedCommand, preCommitGuard, persistenceIntent)
    }
    catch (error) { fail(error); return noPersistenceCommit }
  }
  const execute = (command: FileCommand, selection?: string[], pageId?: string) => executeWithPersistence(command, selection, pageId).committed
  const executeBatch = (commands: FileCommand[], selection?: string[]) => commands.length ? execute(commands.length === 1 ? commands[0]! : { type: 'batch', commands }, selection) : false
  const executePlannedComponentBatch = (commands: FileCommand[], selection?: string[]) => {
    const state = backing.getState()
    if (!commands.length || !state.file || persistenceBlocked || textSession) return false
    const command: FileCommand = commands.length === 1 ? commands[0]! : { type: 'batch', commands }
    try {
      return commitWithPersistence(applyFileCommandWithHistory(state.file, command, state.atoms, { allowUnavailableBindings: true }), selection ?? state.selection, state.pageId!, false, command).committed
    } catch (error) { fail(error); return false }
  }
  const executeBatchWithPersistence = (commands: FileCommand[], selection?: string[]) => commands.length
    ? executeWithPersistence(commands.length === 1 ? commands[0]! : { type: 'batch', commands }, selection, undefined, true)
    : noPersistenceCommit
  const node = (id: string) => backing.getState().file?.nodes[id]
  const beginTextEditing = (nodeId: string, creation?: TextEditSession['creation']): string | null => {
    const state = backing.getState()
    const target = state.file?.nodes[nodeId]
    if (textSession || !state.file || !state.pageId || state.readOnly || persistenceBlocked || !target || target.type !== 'text' || typeof target.text !== 'string') return null
    const sessionId = makeId()
    textSession = {
      sessionId,
      nodeId,
      before: creation?.before ?? currentView(),
      beforeText: target.text,
      pastBefore: creation?.pastBefore ?? [...past],
      futureBefore: creation?.futureBefore ?? [...future],
      visibleCanUndo: creation ? creation.pastBefore.length > 0 : state.canUndo,
      visibleCanRedo: creation ? creation.futureBefore.length > 0 : state.canRedo,
      ...(creation ? { creation } : {}),
    }
    selectionAnchor = nodeId
    setSelection([nodeId])
    emit({ renaming: nodeId, textEditing: { sessionId, nodeId } })
    return sessionId
  }
  const updateTextEditing = (sessionId: string, text: string): boolean => {
    const session = textSession
    const state = backing.getState()
    if (!session || session.sessionId !== sessionId || !state.file || state.readOnly || persistenceBlocked) return false
    const target = state.file.nodes[session.nodeId]
    if (!target || target.type !== 'text' || target.text === text) return false
    try {
      const command: FileCommand = { type: 'node.setText', nodeId: session.nodeId, text }
      const next = applyFileCommand(state.file, command, state.atoms, { allowUnavailableBindings: true })
      if (!permits(next)) return false
      if (text === session.beforeText) {
        past = [...session.pastBefore]
        future = [...session.futureBefore]
      } else if (session.creation) {
        const inserted = next.nodes[session.nodeId]
        if (!inserted || inserted.type !== 'text') throw new Error('The new text node is unavailable.')
        const undo: FileCommand = { type: 'node.delete', nodeIds: [session.nodeId] }
        const redo: FileCommand = { ...session.creation.insert, node: structuredClone(inserted) }
        past = [...session.creation.pastBefore, { ...session.creation.before, afterPageId: state.pageId!, afterSelection: [...state.selection], undo, redo }].slice(-100)
        future = []
      } else {
        const undo: FileCommand = { type: 'node.setText', nodeId: session.nodeId, text: session.beforeText }
        const redo: FileCommand = { type: 'node.setText', nodeId: session.nodeId, text }
        past = [...session.pastBefore, { ...session.before, afterPageId: state.pageId!, afterSelection: [...state.selection], undo, redo }].slice(-100)
        future = []
      }
      changed(next, state.pageId!, state.selection, { kind: 'commands', commands: [command] })
      emit({ canUndo: session.visibleCanUndo, canRedo: session.visibleCanRedo })
      return true
    } catch (error) { return fail(error) }
  }
  const removeCreatedTextEditing = (session: TextEditSession, state: DocumentState): boolean => {
    if (!session.creation || !state.file || state.readOnly || persistenceBlocked) return false
    try {
      const command: FileCommand = { type: 'node.delete', nodeIds: [session.nodeId] }
      const next = applyFileCommand(state.file, command, state.atoms, { allowUnavailableBindings: true })
      if (!permits(next)) return false
      textSession = null
      past = [...session.creation.pastBefore]
      future = [...session.creation.futureBefore]
      const pageId = next.pages.some(page => page.id === session.creation!.before.pageId) ? session.creation.before.pageId : next.pages[0]!.id
      const selection = session.creation.before.selection.filter(id => selectable(next, pageId, id))
      changed(next, pageId, selection, { kind: 'commands', commands: [command] })
      emit({ renaming: null, textEditing: null, canUndo: past.length > 0, canRedo: future.length > 0 })
      return true
    } catch (error) { textSession = session; return fail(error) }
  }
  const commitTextEditing = (sessionId: string): boolean => {
    const session = textSession
    const state = backing.getState()
    if (!session || session.sessionId !== sessionId || !state.file) return false
    const target = state.file.nodes[session.nodeId]
    if (!target || target.type !== 'text' || typeof target.text !== 'string') return false
    if (session.creation && target.text.trim() === '') return removeCreatedTextEditing(session, state)
    textSession = null
    emit({ renaming: null, textEditing: null, canUndo: past.length > 0, canRedo: future.length > 0 })
    return true
  }
  const cancelTextEditing = (sessionId: string): boolean => {
    const session = textSession
    const state = backing.getState()
    if (!session || session.sessionId !== sessionId || !state.file || state.readOnly || persistenceBlocked) return false
    const target = state.file.nodes[session.nodeId]
    if (!target || target.type !== 'text' || typeof target.text !== 'string') return false
    if (session.creation) return removeCreatedTextEditing(session, state)
    try {
      textSession = null
      if (target.text !== session.beforeText) {
        const command: FileCommand = { type: 'node.setText', nodeId: session.nodeId, text: session.beforeText }
        const next = applyFileCommand(state.file, command, state.atoms, { allowUnavailableBindings: true })
        if (!permits(next)) { textSession = session; return false }
        past = [...session.pastBefore]
        future = [...session.futureBefore]
        changed(next, state.pageId!, state.selection, { kind: 'commands', commands: [command] })
      }
      emit({ renaming: null, textEditing: null, canUndo: past.length > 0, canRedo: future.length > 0 })
      return true
    } catch (error) { textSession = session; return fail(error) }
  }
  const focusAdjacentText = (nodeId: string, direction: 'next' | 'previous'): string | null => {
    const state = backing.getState()
    if (textSession || !state.file || !state.pageId) return null
    const textIds = documentOrder(state.file, state.pageId).filter(id => state.file?.nodes[id]?.type === 'text')
    if (!textIds.length) return null
    const current = textIds.indexOf(nodeId)
    const offset = direction === 'next' ? 1 : -1
    const nextIndex = current < 0 ? direction === 'next' ? 0 : textIds.length - 1 : (current + offset + textIds.length) % textIds.length
    return beginTextEditing(textIds[nextIndex]!)
  }
  const styledIds = (ids: readonly string[]) => [...new Set(ids)].filter(id => { const current = node(id); return Boolean(current && current.type !== 'root') })
  const kindOf = (id: string) => { const current = node(id)!; return current.type === 'component' ? 'component' as const : current.type as PrimitiveKind }
  const fillsOf = (id: string) => nodeAppearance(node(id))?.fills ?? []
  const parentOf = (id: string) => backing.getState().file?.relationships[id]?.parentId ?? null
  const isRootChild = (id: string) => { const state = backing.getState(); return parentOf(id) === root(state) }
  /** What the Flex and Grid command factories may use; they never reach into the store otherwise. */
  const layoutContext: LayoutCommandContext = { execute: (command, selection) => execute(command, selection), executeBatch, node, parentOf, isRootChild, childrenOf: (parentId, slot) => { const file = backing.getState().file; return file ? childrenOf(file, parentId, slot) : [] }, slotOf: id => backing.getState().file?.relationships[id]?.slot ?? null }
  const placementFor = (target: InsertTarget | undefined, state: DocumentState): NodePlacement => {
    const parentId = target?.parentId ?? root(state)!
    return { parentId, ...(target?.slot !== undefined ? { slot: target.slot } : {}), ...(target?.index !== undefined ? { index: target.index } : {}) }
  }
  const newIdsFor = (file: FileDocument, nodeId: string) => Object.fromEntries([nodeId, ...descendantsOf(file, nodeId)].map(id => [id, makeId()]))
  const duplicatedInstanceCommands = (file: FileDocument, ids: Record<string, string>): FileCommand[] => Object.entries(ids).flatMap(([sourceId, id]) => {
    const instance = file.componentModel.instances[sourceId]
    return instance ? [{ type: 'component.instance.create', instance: { ...structuredClone(instance), id } }] : []
  })
  const semanticCleanupCommands = (file: FileDocument, removed: ReadonlySet<string>, removedNodeIds = new Set(removed)): FileCommand[] => {
    for (const definition of Object.values(file.componentModel.definitions)) {
      if (definition.source.kind !== 'canvas' || removedNodeIds.has(definition.source.masterRootId)) continue
      const removedMasterIds = [definition.source.masterRootId, ...descendantsOf(file, definition.source.masterRootId)].filter(nodeId => removedNodeIds.has(nodeId))
      if (!removedMasterIds.length) continue
      for (const instance of Object.values(file.componentModel.instances)) {
        if (instance.componentId !== definition.id) continue
        const map = mapParallelComponentSubtrees(file, definition.source.masterRootId, instance.id, { includeOverriddenSwapRoots: true })
        if (!map) continue
        for (const masterId of removedMasterIds) {
          const instanceId = map.get(masterId)
          if (instanceId) for (const nodeId of [instanceId, ...descendantsOf(file, instanceId)]) removedNodeIds.add(nodeId)
        }
      }
    }
    const removedDefinitions = Object.values(file.componentModel.definitions).filter(definition => definition.source.kind === 'canvas' && removed.has(definition.source.masterRootId))
    const removedComponentIds = new Set(removedDefinitions.map(definition => definition.id))
    const instanceCommands: FileCommand[] = Object.values(file.componentModel.instances)
      .filter(instance => removedNodeIds.has(instance.id) || removedComponentIds.has(instance.componentId))
      .map(instance => ({ type: 'component.instance.delete', instanceId: instance.id, expected: instance }))
    const deletedInstanceIds = new Set(instanceCommands.map(command => command.type === 'component.instance.delete' ? command.instanceId : ''))
    const instanceReplaceCommands: FileCommand[] = []
    const definitionReplaceCommands: FileCommand[] = []
    for (const definition of Object.values(file.componentModel.definitions)) {
      if (definition.source.kind !== 'canvas' || removedComponentIds.has(definition.id)) continue
      const properties = definition.properties.filter(property => !property.binding || !removedNodeIds.has(property.binding.nodeId))
      const propertyIds = new Set(properties.map(property => property.id))
      const parts = definition.parts.filter(part => !removedNodeIds.has(part.nodeId))
      const interactions = definition.interactions.filter(interaction => propertyIds.has(interaction.propertyId))
      if (properties.length === definition.properties.length && parts.length === definition.parts.length && interactions.length === definition.interactions.length) continue
      for (const instance of Object.values(file.componentModel.instances)) {
        if (instance.componentId !== definition.id || deletedInstanceIds.has(instance.id)) continue
        const values = Object.fromEntries(Object.entries(instance.values).filter(([propertyId]) => propertyIds.has(propertyId)))
        if (JSON.stringify(values) !== JSON.stringify(instance.values)) instanceReplaceCommands.push({ type: 'component.instance.replace', instanceId: instance.id, expected: instance, instance: { ...instance, values } })
      }
      definitionReplaceCommands.push({ type: 'component.replace', componentId: definition.id, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, properties, parts, interactions } })
    }
    const definitionCommands: FileCommand[] = removedDefinitions.map(definition => ({ type: 'component.delete', componentId: definition.id, expectedRevision: definition.revision }))
    return [...instanceCommands, ...instanceReplaceCommands, ...definitionReplaceCommands, ...definitionCommands]
  }
  const semanticDeleteCommands = (file: FileDocument, nodeIds: readonly string[]): FileCommand[] => {
    const removed = new Set(nodeIds.flatMap(nodeId => [nodeId, ...descendantsOf(file, nodeId)]))
    const removedNodeIds = new Set(removed)
    const cleanup = semanticCleanupCommands(file, removed, removedNodeIds)
    const roots = [...removedNodeIds].filter(nodeId => !ancestorsOf(file, nodeId).some(parentId => removedNodeIds.has(parentId)))
    return [...cleanup, { type: 'node.delete', nodeIds: roots }]
  }
  const isProtectedInstanceDescendant = (file: FileDocument, nodeId: string) => {
    let current = nodeId
    let slotContent = false
    while (file.relationships[current]) {
      const relationship = file.relationships[current]!
      if (relationship.slot !== undefined) slotContent = true
      current = relationship.parentId
      if (file.componentModel.instances[current]) return !slotContent
    }
    return false
  }
  const commandMutatesProtectedInstanceStructure = (file: FileDocument, command: FileCommand): boolean => {
    if (command.type === 'batch') return command.commands.some(inner => commandMutatesProtectedInstanceStructure(file, inner))
    if (command.type === 'node.delete') return command.nodeIds.some(nodeId => isProtectedInstanceDescendant(file, nodeId))
    if (command.type === 'node.duplicate' || command.type === 'node.reparent' || command.type === 'node.reorder' || command.type === 'node.setStyles' || command.type === 'node.setLayout') return isProtectedInstanceDescendant(file, command.nodeId)
    if (command.type === 'node.resizePresentation') return command.entries.some(entry => isProtectedInstanceDescendant(file, entry.expected.nodeId))
    if (command.type === 'node.wrap') return command.groups.some(group => group.children.some(child => isProtectedInstanceDescendant(file, child.nodeId)))
    if (command.type === 'node.unwrap') return command.groups.some(group => isProtectedInstanceDescendant(file, group.wrapperId) || group.children.some(child => isProtectedInstanceDescendant(file, child.nodeId)))
    if (command.type === 'node.removeFlex') return command.groups.some(group => isProtectedInstanceDescendant(file, group.parent.nodeId) || group.children.some(child => isProtectedInstanceDescendant(file, child.nodeId)))
    return false
  }
  const commandMutatesInstanceSwapState = (file: FileDocument, command: FileCommand): boolean => {
    if (command.type === 'batch') return command.commands.some(inner => commandMutatesInstanceSwapState(file, inner))
    if (command.type !== 'component.instance.create' && command.type !== 'component.instance.replace' && command.type !== 'component.instance.restore') return false
    const before = command.type === 'component.instance.create' ? null : command.type === 'component.instance.replace' ? command.expected : command.expected
    const after = command.type === 'component.instance.create' ? command.instance : command.type === 'component.instance.replace' ? command.instance : command.source
    const componentId = after?.componentId ?? before?.componentId
    const definition = componentId ? file.componentModel.definitions[componentId] : undefined
    if (!definition) return false
    return definition.properties.some(property => {
      if (property.type !== 'instance-swap') return false
      const beforeOwns = Boolean(before && Object.hasOwn(before.values, property.id))
      const afterOwns = Boolean(after && Object.hasOwn(after.values, property.id))
      return beforeOwns !== afterOwns || beforeOwns && before!.values[property.id] !== after!.values[property.id]
    })
  }
  const duplicate = (nodeId?: string) => {
    const state = backing.getState()
    if (!state.file || persistenceBlocked) return false
    const file = state.file
    const candidates = (nodeId ? [nodeId] : state.selection).filter(id => file.nodes[id] && file.nodes[id]!.type !== 'root')
    if (candidates.some(id => isProtectedInstanceDescendant(file, id))) return false
    // Only subtree roots duplicate; their descendants come along.
    const roots = candidates.filter(id => !candidates.some(other => other !== id && descendantsOf(file, other).includes(id)))
    if (!roots.length) return false
    const commands: FileCommand[] = []
    const selection: string[] = []
    for (const id of roots) {
      const ids = newIdsFor(file, id)
      const current = file.nodes[id]!
      const placement = current.type === 'component' ? legacyLayout(current.layout) : null
      const width = placement ? placement.width ?? 0 : current.type === 'root' || current.type === 'component' ? 0 : current.styles.width
      const offset = placement && placement.mode !== 'absolute' ? undefined : { x: width + duplicateGap, y: 0 }
      commands.push({ type: 'node.duplicate', nodeId: id, ids, ...(offset ? { offset } : {}) })
      commands.push(...duplicatedInstanceCommands(file, ids))
      selection.push(ids[id]!)
    }
    return executeBatch(commands, selection)
  }
  /** Moves or duplicates selected subtree roots as one ordered, undoable layer-tree transaction. */
  const layerTreeDrop = (nodeIds: readonly string[], target: LayerTreeDropTarget) => {
    const state = backing.getState()
    if (!state.file || !state.pageId || persistenceBlocked || state.readOnly) return false
    const file = state.file
    const order = documentOrder(file, state.pageId)
    const candidates = [...new Set(nodeIds)].filter(id => file.nodes[id] && file.nodes[id]!.type !== 'root')
    if (candidates.some(id => isProtectedInstanceDescendant(file, id))) return false
    const roots = candidates.filter(id => !candidates.some(other => other !== id && descendantsOf(file, other).includes(id))).sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const parentId = target.parentId ?? pageRoot(file, state.pageId)
    if (!parentId) return false
    const parent = file.nodes[parentId]
    if (!parent || !roots.length || roots.some(id => nodeIsLocked(file, id) || id === parentId || descendantsOf(file, id).includes(parentId) || !acceptsChild(parent, file.nodes[id]!, target.slot, state.atoms))) return false
    const moving = new Set(target.duplicate ? [] : roots)
    const allSiblings = childrenOf(file, parentId, target.slot)
    const siblings = allSiblings.filter(id => !moving.has(id))
    const requestedIndex = Math.max(0, Math.min(allSiblings.length, target.index ?? allSiblings.length))
    const removedBefore = allSiblings.slice(0, requestedIndex).filter(id => moving.has(id)).length
    const index = Math.max(0, Math.min(siblings.length, requestedIndex - removedBefore))
    const after = index < siblings.length ? file.relationships[siblings[index]!]!.orderKey : null
    let before = index > 0 ? file.relationships[siblings[index - 1]!]!.orderKey : null
    const commands: FileCommand[] = []
    const selection: string[] = []
    const targetDisplay = nodeChildDisplay(parent)
    for (const id of roots) {
      const orderKey = orderKeyBetween(before, after)
      const placement: NodePlacement = { parentId, orderKey, ...(target.slot !== undefined ? { slot: target.slot } : {}) }
      if (target.duplicate) {
        const ids = newIdsFor(file, id)
        const duplicateId = ids[id]!
        commands.push({ type: 'node.duplicate', nodeId: id, ids })
        commands.push(...duplicatedInstanceCommands(file, ids))
        commands.push({ type: 'node.reparent', nodeId: duplicateId, placement, preserveWorldPosition: true })
        const source = file.nodes[id]!
        if (source.type !== 'root' && source.type !== 'component') {
          const layout = targetDisplay === 'flex' ? positionFlow(source.layout, targetDisplay) : positionFreeform(source.layout)
          if (nodePositionMode(source) !== layout.item.position.mode) commands.push({ type: 'node.setLayout', nodeId: duplicateId, layout })
        }
        selection.push(duplicateId)
      } else {
        commands.push({ type: 'node.reparent', nodeId: id, placement, preserveWorldPosition: true })
        const source = file.nodes[id]!
        if (source.type !== 'root' && source.type !== 'component') {
          const layout = targetDisplay === 'flex' ? positionFlow(source.layout, targetDisplay) : positionFreeform(source.layout)
          if (nodePositionMode(source) !== layout.item.position.mode) commands.push({ type: 'node.setLayout', nodeId: id, layout })
        }
        selection.push(id)
      }
      before = orderKey
    }
    return executeBatch(commands, selection)
  }
  const moveBy = (nodeId: string, delta: number) => {
    const state = backing.getState()
    const relationship = state.file?.relationships[nodeId]
    if (!state.file || !relationship) return false
    const siblings = childrenOf(state.file, relationship.parentId, relationship.slot)
    const index = siblings.indexOf(nodeId) + delta
    if (index < 0 || index >= siblings.length) return false
    return execute({ type: 'node.reorder', nodeId, index })
  }
  const undo = () => {
    const state = backing.getState()
    if (textSession || !state.file || !past.length || persistenceBlocked || state.readOnly) return false
    const step = past[past.length - 1]!
    try {
      const previous = applyFileCommand(state.file, step.undo, state.atoms, { allowUnavailableBindings: true })
      if (!permits(previous)) return false
      past.pop()
      future.push({ ...step, afterPageId: state.pageId!, afterSelection: [...state.selection] })
      const page = previous.pages.some(candidate => candidate.id === step.pageId) ? step.pageId : previous.pages[0]!.id
      changed(previous, page, step.selection.filter(id => selectable(previous, page, id)), { kind: 'commands', commands: [step.undo] })
      return true
    } catch (error) { return fail(error) }
  }
  const redo = () => {
    const state = backing.getState()
    if (textSession || !state.file || !future.length || persistenceBlocked || state.readOnly) return false
    const step = future[future.length - 1]!
    try {
      const next = applyFileCommand(state.file, step.redo, state.atoms, { allowUnavailableBindings: true })
      if (!permits(next)) return false
      future.pop()
      past.push(step)
      const page = next.pages.some(candidate => candidate.id === step.afterPageId) ? step.afterPageId : next.pages[0]!.id
      changed(next, page, step.afterSelection.filter(id => selectable(next, page, id)), { kind: 'commands', commands: [step.redo] })
      return true
    } catch (error) { return fail(error) }
  }
  const setCamera = (viewport: Viewport) => {
    const state = backing.getState()
    const next = { x: viewport.x, y: viewport.y, zoom: clampZoom(viewport.zoom) }
    emit({ viewport: next, gridVisible: gridVisible(next.zoom, state.gridVisible) })
  }
  const center = (): Point => { const { viewportSize } = backing.getState(); return { x: viewportSize.width / 2, y: viewportSize.height / 2 } }
  /** Zooms around a viewport-relative CSS pixel point; defaults to the viewport center. */
  const zoomAt = (zoom: number, point?: Point) => {
    const state = backing.getState()
    setCamera(zoomAtPoint(state.viewport, zoom, point ?? center(), state.viewportSize))
  }
  const zoomStep = (direction: 'in' | 'out', point?: Point) => zoomAt(stepZoom(backing.getState().viewport.zoom, direction), point)
  const deleteSelection = (nodeIds: string[]) => {
    const state = backing.getState()
    const ids = nodeIds.filter(id => state.file?.nodes[id] && state.file.nodes[id]!.type !== 'root')
    if (!state.file || !ids.length) return false
    if (ids.some(id => isProtectedInstanceDescendant(state.file!, id))) return false
    const commands = semanticDeleteCommands(state.file, ids)
    return executePlannedComponentBatch(commands, [])
  }
  const movedPrimitiveMatrix = (file: FileDocument, id: string, targetParentId: string, x: number, y: number) => {
    const item = file.nodes[id]
    if (!item || item.type === 'root' || item.type === 'component') return null
    const world = nodeWorldTransform(file, id)
    const bounds = transformedBounds(world, item.styles)
    const movedWorld = multiplyTransforms(translationTransform(x - bounds.x, y - bounds.y), world)
    const parentWorld = file.nodes[targetParentId]?.type === 'root' ? identityTransform : nodeWorldTransform(file, targetParentId)
    const inverse = invertTransform(parentWorld)
    return inverse ? multiplyTransforms(inverse, movedWorld) : null
  }
  const primitiveMove = (id: string, world: Point, parentId: string | null): FileCommand[] => {
    const state = backing.getState()
    const file = state.file!
    const target = parentId ?? root(state)!
    const relativeTransform = movedPrimitiveMatrix(file, id, target, Math.round(world.x), Math.round(world.y))
    if (!relativeTransform) return []
    const commands: FileCommand[] = []
    if (parentOf(id) !== target) commands.push({ type: 'node.reparent', nodeId: id, placement: { parentId: target } })
    commands.push({ type: 'node.setStyles', nodeId: id, styles: { relativeTransform } })
    return commands
  }
  /** Nudges primitives and freeform component roots; a root still in the host flow leaves it at its measured position, keeping its width. */
  const nudge = (dx: number, dy: number, scene?: Scene) => {
    const state = backing.getState()
    if (!state.file || !state.selection.length) return false
    const commands: FileCommand[] = []
    for (const id of state.selection) {
      const item = state.file.nodes[id]
      if (!item) continue
      if (isPrimitive(item)) {
        const bounds = transformedBounds(nodeWorldTransform(state.file, id), item.styles)
        const target = parentOf(id) ?? root(state)!
        const relativeTransform = movedPrimitiveMatrix(state.file, id, target, bounds.x + dx, bounds.y + dy)
        if (relativeTransform) commands.push({ type: 'node.setStyles', nodeId: id, styles: { relativeTransform } })
        continue
      }
      if (item.type !== 'component') continue
      const placement = legacyLayout(item.layout)
      if (placement.mode === 'absolute') { commands.push(placementCommand(item, { ...placement, x: placement.x + dx, y: placement.y + dy })); continue }
      const rect = scene?.byId.get(id)?.rect
      if (rect && isRootChild(id)) commands.push(placementCommand(item, { ...placement, ...(placement.width === undefined ? { width: Math.max(1, Math.round(rect.width)) } : {}), mode: 'absolute', x: Math.round(rect.x + dx), y: Math.round(rect.y + dy) }))
    }
    return executeBatch(commands)
  }
  const setTextSizingModes = (entries: readonly { nodeId: string; axes: readonly ResizeAxis[]; mode: 'fixed' | 'fit' | 'fill' | 'relative'; measured?: { width?: number; height?: number }; parent?: { width?: number; height?: number }; local?: { x: number; y: number } }[]) => {
    const commands: FileCommand[] = []
    for (const entry of entries) {
      const target = node(entry.nodeId)
      if (!target || target.type !== 'text' || !target.textStyle || !target.textSizing || !entry.axes.length) return false
      const textStyle = structuredClone(target.textStyle)
      const textSizing = structuredClone(target.textSizing)
      const parentId = parentOf(entry.nodeId)
      const parent = parentId ? node(parentId) : undefined
      const display = parent && parent.type !== 'root' ? parent.layout?.container?.display ?? 'freeform' : null
      const direction = display === 'flex' && parent && parent.type !== 'root' ? parent.layout?.container?.flex?.direction ?? 'column' : null
      let layout = target.layout ?? { item: { position: { mode: nodePositionMode(target) ?? 'freeform' as const } } }
      const styleCommands: FileCommand[] = []
      for (const resizeAxis of entry.axes) {
        const axis: Axis = resizeAxis === 'x' ? 'width' : 'height'
        const current = textSizing[axis]
        textSizing[axis] = entry.mode === 'relative' ? { mode: 'relative', value: current.mode === 'relative' ? current.value : 100 } : { mode: entry.mode }
        if (axis === 'height' && entry.mode !== 'fit') delete textStyle.maxLines
        const next = setAxisSizing(layout, axis, entry.mode === 'fit' ? 'hug' : entry.mode, { measuredPx: entry.measured?.[axis], parentPx: entry.parent?.[axis] }, direction, display, entry.local)
        // TextSizing owns the axis value. Layout stores only the parent-dependent contract: anchors or Flex growth.
        if (next) layout = setAxisLength(next, axis, null)
        if (entry.mode === 'fixed') {
          const measured = entry.measured?.[axis]
          if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) styleCommands.push({ type: 'node.setStyles', nodeId: entry.nodeId, styles: { [axis]: Math.max(1, Math.round(measured)) } })
        }
      }
      commands.push({ type: 'node.setLayout', nodeId: entry.nodeId, layout })
      commands.push(...styleCommands)
      commands.push({ type: 'node.setTextProperties', nodeId: entry.nodeId, textStyle, textSizing })
    }
    return executeBatch(commands)
  }
  const uniqueName = (names: Iterable<string>, base: string) => {
    const used = new Set(names)
    if (!used.has(base)) return base
    let sequence = 2
    while (used.has(`${base} ${sequence}`)) sequence += 1
    return `${base} ${sequence}`
  }
  const componentNameExists = (file: FileDocument, name: string, exceptId?: string) => Object.values(file.componentModel.definitions).some(definition => definition.id !== exceptId && definition.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
  const componentPropertyNameExists = (definition: ComponentDefinition, name: string, exceptId: string) => definition.properties.some(property => property.id !== exceptId && property.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
  const componentMaterialNameExists = (definition: ComponentDefinition, name: string, group: string, exceptId: string) => definition.materials.some(material => material.id !== exceptId && material.group.localeCompare(group, undefined, { sensitivity: 'accent' }) === 0 && material.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
  const tokenName = (file: FileDocument, base: string) => uniqueName(Object.values(file.theme.tokens).map(token => token.name), base)
  const lastTokenKey = (file: FileDocument) => Object.values(file.theme.tokens).sort(compareOrder).at(-1)?.orderKey ?? null
  const componentValuesFor = (properties: readonly ComponentPropertyDefinition[], values: Readonly<Record<string, ComponentScalarValue>>): Record<string, ComponentScalarValue> => {
    const propertyById = new Map(properties.map(property => [property.id, property]))
    return Object.fromEntries(Object.entries(values).filter(([propertyId, value]) => {
      const property = propertyById.get(propertyId)
      return property?.type === 'text' && typeof value === 'string'
        || property?.type === 'boolean' && typeof value === 'boolean'
        || property?.type === 'variant' && typeof value === 'string' && property.values.some(option => option.id === value)
        || property?.type === 'instance-swap' && typeof value === 'string'
    }))
  }
  const planInstanceSwapValues = (file: FileDocument, definition: ComponentDefinition, instanceId: string, values: ComponentInstanceValues) => {
    let working = file
    const commands: FileCommand[] = []
    for (const property of definition.properties) {
      if (property.type !== 'instance-swap') continue
      const instance = working.componentModel.instances[instanceId]
      if (!instance) return null
      const desired = typeof values[property.id] === 'string' ? values[property.id] as string : property.defaultValue
      const current = typeof instance.values[property.id] === 'string' ? instance.values[property.id] as string : property.defaultValue
      if (current === desired) continue
      const plan = planComponentInstanceSwap({ file: working, owner: definition, ownerRootId: instanceId, propertyId: property.id, componentId: desired, atoms: backing.getState().atoms, makeId })
      if (!plan) return null
      commands.push(...plan.commands)
      working = plan.file
    }
    return { file: working, commands }
  }
  const replaceComponentPropertyCommands = (file: FileDocument, definition: ComponentDefinition, properties: readonly ComponentPropertyDefinition[]) => {
    const propertyById = new Map(properties.map(property => [property.id, property]))
    const interactions = definition.interactions.filter(interaction => {
      const property = propertyById.get(interaction.propertyId)
      return property?.type === 'variant' && property.values.some(value => value.id === interaction.valueId)
    })
    const commands: FileCommand[] = []
    const instances = []
    for (const instance of Object.values(file.componentModel.instances)) {
      if (instance.componentId !== definition.id) continue
      const values = componentValuesFor(properties, instance.values)
      const next = { ...instance, values }
      instances.push(next)
      if (JSON.stringify(values) !== JSON.stringify(instance.values)) commands.push({ type: 'component.instance.replace', instanceId: instance.id, expected: instance, instance: next })
    }
    const nextDefinition = { ...definition, revision: definition.revision + 1, properties: structuredClone(properties), interactions }
    commands.push({ type: 'component.replace', componentId: definition.id, expectedRevision: definition.revision, definition: nextDefinition })
    for (const instance of instances) commands.push(...componentPropertyProjectionCommands(file, nextDefinition, instance))
    return commands
  }
  const replaceComponentProperties = (componentId: string, properties: readonly ComponentPropertyDefinition[]) => {
    const state = backing.getState()
    const definition = state.file?.componentModel.definitions[componentId]
    return state.file && definition ? executeBatch(replaceComponentPropertyCommands(state.file, definition, properties)) : false
  }
  const insertCodeComponent = (componentId: string, target: InsertTarget | undefined, props: Record<string, string | number | boolean>, point?: ComponentInsertPoint) => {
    const state = backing.getState()
    const atom = state.atoms.find(item => item.componentId === componentId && item.status === 'bound')
    const definition = state.file?.componentModel.definitions[componentId]
    if (!atom || definition?.source.kind !== 'code') return fail(new Error(canvasCopy.componentUnavailable))
    if (!state.file || !state.pageId) return fail(new Error(canvasCopy.openFileForTools))
    const id = makeId()
    const rootTarget = target?.parentId == null
    const layout = point && rootTarget ? layoutFromLegacy({ mode: 'absolute', x: Math.round(point.x), y: Math.round(point.y) }) : undefined
    const insert: FileCommand = {
      type: 'node.insert',
      node: { id, type: 'component', componentId, exportName: atom.exportName, props: { ...componentDefaultProps(atom), ...props }, ...(layout ? { layout } : {}) },
      placement: placementFor(target, state),
    }
    const withNode = applyFileCommand(state.file, insert, state.atoms, { allowUnavailableBindings: true })
    const values = codeComponentInstanceValues(withNode, definition, id)
    if (!values) return false
    return executeBatch([insert, { type: 'component.instance.create', instance: { id, componentId, values } }], [id])
  }
  return {
    getSnapshot: backing.getState,
    getDocumentGeneration: () => generation,
    /** Resolves after the current persistence drain has acknowledged or rejected every queued change. */
    waitForPersistence: () => persistenceRun,
    getViewSnapshot,
    getShellSnapshot,
    subscribe: (listener: () => void) => {
      const stop = backing.subscribe(listener)
      const unsubscribe = () => { stop(); subscriptions.delete(unsubscribe) }
      subscriptions.add(unsubscribe)
      return unsubscribe
    },
    sources,
    themeContext,
    assetPreview: (assetId: string): { mime: ImageMime; data: string } | null => {
      const asset = backing.getState().file?.assets?.[assetId]
      const preview = assetPreviewData.get(assetId)
      return asset && preview?.sha256 === asset.sha256 ? { mime: preview.mime, data: preview.data } : null
    },
    /** The concrete theme, palette and diagnostic of one node in the open file (the fallback theme for unknown nodes). */
    nodeTheme: (nodeId: string): { theme: PreviewNodeTheme; palette: SourcePalette; diagnostic: ThemeDiagnostic | null; effective: EffectiveNodeTheme } | null => {
      const file = backing.getState().file
      if (!file) return null
      const context = themeContext()
      return { ...nodeThemeProjection(file, nodeId, context), effective: resolveEffectiveNodeTheme(file, nodeId, fallbackScheme(context.themes, context.previewThemeId)) }
    },
    /** Source palette that resolves this node's bound tokens (its effective theme), or the fallback palette. */
    paletteFor: (nodeId: string): SourcePalette => { const file = backing.getState().file; return file ? nodeThemeProjection(file, nodeId, themeContext()).palette : sources() },
    setEditPolicy: (next: ((file: FileDocument) => void) | undefined) => { editPolicy = next },
    setReadOnly: (readOnly: boolean) => {
      if (backing.getState().readOnly === readOnly) return
      if (readOnly && textSession) commitTextEditing(textSession.sessionId)
      emit({ readOnly, transient: null, renaming: null, textEditing: null })
    },
    clear: () => {
      generation++
      textSession = null
      persistenceRun = null
      rejectPersistenceChanges(pendingPersistenceChanges, new Error('The document closed before the change was saved.'))
      past = []
      future = []
      savedRevision = 0
      pendingPersistenceChanges = []
      selectionAnchor = null
      persistenceBlocked = false
      assetPreviewData.clear()
      backing.setState(emptyDocumentState(), true)
    },
    configure: (next: StoreOptions) => { options = next },
    /** Rebinds validation to a newly verified catalog without changing the stored document or its history. */
    setAtoms: (atoms: Atom[]) => {
      const state = backing.getState()
      try {
        if (state.file) validateFileDocument(state.file, atoms, { allowUnavailableBindings: true })
        emit({ atoms: structuredClone(atoms), error: null })
        return true
      } catch (error) {
        report(error instanceof Error ? error : new Error(canvasCopy.componentUnavailable))
        return false
      }
    },
    getHistory: (): DocumentHistory => {
      const nextFuture = future.slice(-20)
      const remaining = 20 - nextFuture.length
      return structuredClone({ past: remaining ? past.slice(-remaining) : [], future: nextFuture })
    },
    restoreHistory: (input: unknown) => {
      const state = backing.getState()
      if (!state.file) return false
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['past', 'future'].includes(key))) throw new Error(canvasCopy.historyUnavailable)
        const history = input as { past?: unknown; future?: unknown }
        if (!Array.isArray(history.past) || !Array.isArray(history.future) || history.past.length + history.future.length > 20) throw new Error(canvasCopy.historyUnavailable)
        const entry = (inputEntry: unknown): HistoryEntry => {
          if (!inputEntry || typeof inputEntry !== 'object' || Array.isArray(inputEntry) || Object.keys(inputEntry).some(key => !['file', 'pageId', 'selection', 'afterPageId', 'afterSelection', 'undo', 'redo'].includes(key))) throw new Error(canvasCopy.historyUnavailable)
          const value = inputEntry as { file?: unknown; pageId?: unknown; selection?: unknown; afterPageId?: unknown; afterSelection?: unknown; undo?: unknown; redo?: unknown }
          const file = validateFileDocument(value.file, state.atoms, { allowUnavailableBindings: true })
          if (typeof value.pageId !== 'string' || !file.pages.some(page => page.id === value.pageId)) throw new Error(canvasCopy.historyUnavailable)
          if (!Array.isArray(value.selection) || value.selection.some(id => typeof id !== 'string' || !selectable(file, null, id)) || new Set(value.selection).size !== value.selection.length) throw new Error(canvasCopy.historyUnavailable)
          const undo = validateFileCommand(value.undo)
          const redo = validateFileCommand(value.redo)
          const after = applyFileCommand(file, redo, state.atoms, { allowUnavailableBindings: true })
          if (typeof value.afterPageId !== 'string' || !after.pages.some(page => page.id === value.afterPageId)) throw new Error(canvasCopy.historyUnavailable)
          if (!Array.isArray(value.afterSelection) || value.afterSelection.some(id => typeof id !== 'string' || !selectable(after, null, id)) || new Set(value.afterSelection).size !== value.afterSelection.length) throw new Error(canvasCopy.historyUnavailable)
          const roundTrip = applyFileCommand(after, undo, state.atoms, { allowUnavailableBindings: true })
          if (!same(file, roundTrip)) throw new Error(canvasCopy.historyUnavailable)
          return { file, pageId: value.pageId, selection: [...value.selection], afterPageId: value.afterPageId, afterSelection: [...value.afterSelection], undo, redo }
        }
        const nextPast = history.past.map(entry)
        const nextFuture = history.future.map(entry)
        past = nextPast
        future = nextFuture
        emit({ canUndo: past.length > 0, canRedo: future.length > 0, error: null })
        return true
      } catch { report(new Error(canvasCopy.historyUnavailable)); return false }
    },
    /** Loads a file. `pageId` selects the open page (defaults to the current page when it still exists, else the first). */
    load: (file: FileDocument, atoms: Atom[], settings: { replace?: boolean; pageId?: string | null; assetPreviews?: readonly EditorAssetPreview[] } = {}) => {
      const state = backing.getState()
      const incoming = validateFileDocument(file, atoms, { allowUnavailableBindings: true })
      const fileChanged = state.file?.fileId !== incoming.fileId
      let incomingPreviews: Map<string, AssetPreviewData> | null = null
      try {
        if (settings.assetPreviews !== undefined) incomingPreviews = hydratedAssetPreviews(incoming, settings.assetPreviews)
        else if (fileChanged) incomingPreviews = new Map()
      } catch (error) {
        options.onError?.({ title: canvasCopy.imageFailed, message: messageFor(error) })
        throw error
      }
      const updateAssetPreviews = () => {
        if (incomingPreviews) {
          assetPreviewData.clear()
          for (const [assetId, preview] of incomingPreviews) assetPreviewData.set(assetId, preview)
          return
        }
        for (const [assetId, preview] of assetPreviewData) {
          const asset = incoming.assets?.[assetId]
          if (!asset || asset.sha256 !== preview.sha256 || asset.mime !== preview.mime) assetPreviewData.delete(assetId)
        }
      }
      if (state.file && state.dirty && !settings.replace) {
        if (incoming.revision <= savedRevision) { emit({ atoms }); return }
        try {
          const acknowledgesPendingChange = pendingPersistenceChanges.some(change => same(change.file, incoming))
          if (!acknowledgesPendingChange) {
            past = []
            future = []
          }
          savedRevision = incoming.revision
          pendingPersistenceChanges = rebasePersistenceChanges(incoming, pendingPersistenceChanges, atoms)
          const rebased = pendingPersistenceChanges.at(-1)?.file ?? incoming
          const requested = settings.pageId ?? state.pageId
          const pageId = requested && rebased.pages.some(page => page.id === requested) ? requested : rebased.pages[0]!.id
          updateAssetPreviews()
          persistenceBlocked = false
          emit({ file: rebased, pageId, atoms, selection: state.selection.filter(id => selectable(rebased, pageId, id)), hover: null, renaming: textSession?.nodeId ?? null, textEditing: textSession ? { sessionId: textSession.sessionId, nodeId: textSession.nodeId } : null, transient: null, dirty: pendingPersistenceChanges.length > 0, error: null, blocked: false, canUndo: past.length > 0, canRedo: future.length > 0 })
          void schedulePersistence()
        } catch {
          persistenceBlocked = true
          emit({ atoms, blocked: true, error: canvasCopy.rebaseFailed })
          options.onError?.({ title: canvasCopy.saveFailed, message: canvasCopy.rebaseFailed })
        }
        return
      }
      if (textSession && state.file?.fileId === incoming.fileId && !settings.replace) {
        if (incoming.revision <= savedRevision) { emit({ atoms }); return }
        const currentText = state.file.nodes[textSession.nodeId]
        const incomingText = incoming.nodes[textSession.nodeId]
        if (currentText?.type === 'text' && typeof currentText.text === 'string' && incomingText?.type === 'text' && typeof incomingText.text === 'string') {
          savedRevision = incoming.revision
          persistenceBlocked = false
          const requested = settings.pageId ?? state.pageId
          const pageId = requested && incoming.pages.some(page => page.id === requested) ? requested : incoming.pages[0]!.id
          const selection = state.selection.filter(id => selectable(incoming, pageId, id))
          updateAssetPreviews()
          if (incomingText.text === currentText.text) {
            emit({ file: incoming, pageId, atoms, selection, hover: null, renaming: textSession.nodeId, textEditing: { sessionId: textSession.sessionId, nodeId: textSession.nodeId }, transient: null, dirty: false, saving: false, error: null, blocked: false, canUndo: state.canUndo, canRedo: state.canRedo })
          } else {
            const command: FileCommand = { type: 'node.setText', nodeId: textSession.nodeId, text: currentText.text }
            const merged = applyFileCommand(incoming, command, atoms, { allowUnavailableBindings: true })
            if (!permits(merged)) return
            emit({ atoms, hover: null, renaming: textSession.nodeId, textEditing: { sessionId: textSession.sessionId, nodeId: textSession.nodeId }, transient: null, saving: false, blocked: false })
            changed(merged, pageId, selection, { kind: 'commands', commands: [command] })
            emit({ canUndo: state.canUndo, canRedo: state.canRedo })
          }
          return
        }
      }
      generation++
      textSession = null
      persistenceRun = null
      persistenceBlocked = false
      savedRevision = incoming.revision
      rejectPersistenceChanges(pendingPersistenceChanges, new Error('The document changed before the pending edit was saved.'))
      pendingPersistenceChanges = []
      if (!state.file || settings.replace) { past = []; future = []; selectionAnchor = null }
      const sameTree = state.file && same(state.file, incoming)
      if (!sameTree) { past = []; future = [] }
      const requested = settings.pageId ?? state.pageId
      const pageId = requested && incoming.pages.some(page => page.id === requested) ? requested : incoming.pages[0]!.id
      updateAssetPreviews()
      emit({ file: incoming, pageId, atoms, selection: state.selection.filter(id => selectable(incoming, pageId, id)), hover: null, renaming: null, textEditing: null, transient: null, dirty: false, saving: false, error: null, blocked: false, canUndo: past.length > 0, canRedo: future.length > 0 })
    },
    /** Switches the open page: a view change, not a document change. Selection is page-scoped. */
    setPage: (pageId: string) => {
      const state = backing.getState()
      if (textSession || !state.file || state.pageId === pageId || !state.file.pages.some(page => page.id === pageId)) return false
      selectionAnchor = null
      emit({ pageId, selection: [], hover: null, renaming: null, transient: null })
      options.onSelection?.([])
      options.onPageChange?.(pageId)
      return true
    },
    markSaved: (file: FileDocument) => {
      const state = backing.getState()
      const saved = validateFileDocument(file, state.atoms, { allowUnavailableBindings: true })
      savedRevision = saved.revision
      persistenceBlocked = false
      const sameTree = state.file && same(state.file, saved)
      const acknowledgedIndex = pendingPersistenceChanges.findIndex(change => same(change.file, saved))
      if (acknowledgedIndex >= 0) {
        const acknowledged = pendingPersistenceChanges.splice(0, acknowledgedIndex + 1)
        for (const change of acknowledged) change.receipt?.resolve()
      }
      pendingPersistenceChanges = pendingPersistenceChanges.map(change => ({ ...change, file: { ...change.file, revision: saved.revision } }))
      emit({ file: sameTree || !state.file ? saved : { ...state.file, revision: saved.revision }, dirty: pendingPersistenceChanges.length > 0 || !sameTree && Boolean(state.file), error: null, blocked: false })
    },
    retryPersistence: () => { persistenceBlocked = false; emit({ error: null, blocked: false }); void schedulePersistence() },
    select: (nodeId: string | null, selectionOptions: { additive?: boolean; range?: boolean } = {}) => {
      const state = backing.getState()
      if (textSession || !state.file || nodeId && !selectable(state.file, state.pageId, nodeId)) return
      if (!nodeId) { selectionAnchor = null; setSelection([]); return }
      if (selectionOptions.range && selectionAnchor) {
        const order = documentOrder(state.file, state.pageId!)
        const from = order.indexOf(selectionAnchor)
        const to = order.indexOf(nodeId)
        setSelection(order.slice(Math.min(from, to), Math.max(from, to) + 1))
      } else {
        selectionAnchor = nodeId
        setSelection(selectionOptions.additive ? state.selection.includes(nodeId) ? state.selection.filter(id => id !== nodeId) : [...state.selection, nodeId] : [nodeId])
      }
    },
    selectMany: (nodeIds: string[]) => {
      const state = backing.getState()
      if (textSession || !state.file) return
      const next = [...new Set(nodeIds)].filter(id => selectable(state.file!, state.pageId, id))
      if (JSON.stringify(next) === JSON.stringify(state.selection)) return
      selectionAnchor = next[next.length - 1] ?? null
      setSelection(next)
    },
    setHover: (nodeId: string | null) => { if (backing.getState().hover !== nodeId) emit({ hover: nodeId }) },
    setRenaming: (nodeId: string | null) => { if (!textSession) emit({ renaming: nodeId }) },
    setTransient: (transient: CanvasTransient | null) => emit({ transient }),
    setSpaceHeld: (held: boolean) => { if (backing.getState().spaceHeld !== held) emit({ spaceHeld: held }) },
    setTool: (tool: CanvasTool) => { emit({ tool, transient: null }); options.onToolChange?.(tool) },
    pan: (x: number, y: number) => emit({ viewport: { ...backing.getState().viewport, x, y } }),
    panBy: (dx: number, dy: number) => { const { viewport } = backing.getState(); emit({ viewport: { ...viewport, x: viewport.x + dx, y: viewport.y + dy } }) },
    setViewport: setCamera,
    setViewportSize: (size: Size) => { const current = backing.getState().viewportSize; if (current.width !== size.width || current.height !== size.height) emit({ viewportSize: size }) },
    requestFit: (kind: 'all' | 'selection' = 'all') => emit({ fitRequested: kind }),
    /** Resolves a pending fit with world bounds computed by the canvas; null bounds restore the default camera. */
    resolveFit: (bounds: Rect | null) => {
      const state = backing.getState()
      const camera = (bounds ? fitCamera(bounds, state.viewportSize) : null) ?? (bounds ? null : defaultCamera)
      // One emit: clearing the request together with the camera keeps fit subscribers from re-entering.
      if (camera) emit({ fitRequested: null, viewport: { x: camera.x, y: camera.y, zoom: clampZoom(camera.zoom) }, gridVisible: gridVisible(clampZoom(camera.zoom), state.gridVisible) })
      else emit({ fitRequested: null })
    },
    zoomAt,
    zoomStep,
    fit: (bounds: Rect | null) => { const state = backing.getState(); const camera = bounds ? fitCamera(bounds, state.viewportSize) : null; setCamera(camera ?? defaultCamera) },
    undo, redo,
    commands: {
      execute,
      executeBatch,
      components: {
        reconcileCodeDefinitions: (definitions: readonly ComponentDefinition[], registryAtoms?: readonly Atom[]) => {
          const state = backing.getState()
          if (!state.file || state.blocked || state.readOnly) return false
          const commands = definitions.flatMap((definition): FileCommand[] => {
            const current = state.file!.componentModel.definitions[definition.id]
            if (current && current.source.kind !== 'code') return []
            const next = current ? { ...definition, revision: current.revision + 1 } : definition
            const comparable = current ? { ...current, revision: 0 } : null
            const changedDefinition = !current || JSON.stringify(comparable) !== JSON.stringify({ ...definition, revision: 0 })
            const instanceCommands: FileCommand[] = []
            const projectionCommands: FileCommand[] = []
            const previousPropNames = new Set(current?.properties.flatMap(property => property.type === 'slot' ? [] : [property.name]) ?? [])
            const nextPropNames = new Set(next.properties.flatMap(property => property.type === 'slot' ? [] : [property.name]))
            const removedPropNames = [...previousPropNames].filter(name => !nextPropNames.has(name))
            for (const instance of Object.values(state.file!.componentModel.instances)) {
              if (instance.componentId !== definition.id) continue
              const values = componentValuesFor(next.properties, instance.values)
              const updated = { ...instance, values }
              if (JSON.stringify(values) !== JSON.stringify(instance.values)) instanceCommands.push({ type: 'component.instance.replace', instanceId: instance.id, expected: instance, instance: updated })
              if (changedDefinition) projectionCommands.push(...componentPropertyProjectionCommands(state.file!, next, updated))
              if (removedPropNames.length) projectionCommands.push({ type: 'node.setProps', nodeId: instance.id, props: {}, remove: removedPropNames })
            }
            const adoptionCommands: FileCommand[] = []
            for (const node of Object.values(state.file!.nodes)) {
              if (node.type !== 'component' || node.componentId !== definition.id || state.file!.componentModel.instances[node.id]) continue
              const values = codeComponentInstanceValues(state.file!, next, node.id)
              if (values) adoptionCommands.push({ type: 'component.instance.create', instance: { id: node.id, componentId: definition.id, values } })
              if (removedPropNames.length) adoptionCommands.push({ type: 'node.setProps', nodeId: node.id, props: {}, remove: removedPropNames })
            }
            const definitionCommand: FileCommand[] = !changedDefinition ? [] : current
              ? [{ type: 'component.replace', componentId: current.id, expectedRevision: current.revision, definition: next }]
              : [{ type: 'component.create', definition: next }]
            return [...instanceCommands, ...definitionCommand, ...adoptionCommands, ...projectionCommands]
          })
          if (!registryAtoms) return commands.length === 0 || executeBatch(commands)
          const nextAtoms: Atom[] = registryAtoms ? structuredClone([...registryAtoms]) : state.atoms
          if (commands.length === 0) {
            try {
              validateFileDocument(state.file, nextAtoms, { allowUnavailableBindings: true })
              if (registryAtoms && JSON.stringify(state.atoms) !== JSON.stringify(nextAtoms)) emit({ atoms: nextAtoms, error: null })
              return true
            } catch (error) { return report(error) }
          }
          try {
            const command: FileCommand = commands.length === 1 ? commands[0]! : { type: 'batch', commands }
            const nextById = new Map(nextAtoms.map(atom => [atom.componentId, atom]))
            const compatibilityAtoms = state.atoms.map(atom => {
              const replacement = nextById.get(atom.componentId)
              if (!replacement) return atom
              nextById.delete(atom.componentId)
              const nextProps = new Map(replacement.props.map(prop => [prop.name, prop]))
              const props = atom.props.map(prop => {
                const nextProp = nextProps.get(prop.name)
                nextProps.delete(prop.name)
                return nextProp ? { ...nextProp, type: [...new Set([prop.type, nextProp.type])].join(' | '), optional: true } : { ...prop, optional: true }
              })
              props.push(...[...nextProps.values()].map(prop => ({ ...prop, optional: true })))
              return { ...replacement, props, slots: [...new Set([...(atom.slots ?? []), ...(replacement.slots ?? [])])] }
            }).concat([...nextById.values()])
            const projected = applyFileCommand(state.file, command, compatibilityAtoms, { allowUnavailableBindings: true })
            const next = validateFileDocument(projected, nextAtoms, { allowUnavailableBindings: true })
            if (!permits(next)) return false
            past = []
            future = []
            changed(next, state.pageId!, state.selection.filter(id => selectable(next, state.pageId, id)), { kind: 'commands', commands: [command] }, false, { atoms: nextAtoms })
            return true
          } catch (error) { return report(error) }
        },
        createFromSelection: (name: string) => {
          const state = backing.getState()
          const masterRootId = state.selection.length === 1 ? state.selection[0] : undefined
          const master = masterRootId ? state.file?.nodes[masterRootId] : undefined
          const nextName = name.trim()
          if (!state.file || !masterRootId || !master || master.type === 'root' || !nextName) return false
          if ([masterRootId, ...ancestorsOf(state.file, masterRootId)].some(nodeId => state.file!.componentModel.instances[nodeId])) return false
          if (componentNameExists(state.file, nextName)) return false
          if (Object.values(state.file.componentModel.definitions).some(definition => definition.source.kind === 'canvas' && definition.source.masterRootId === masterRootId)) return false
          return execute({
            type: 'component.create',
            definition: { id: makeId(), name: nextName, source: { kind: 'canvas', masterRootId }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
          })
        },
        rename: (componentId: string, name: string) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          const nextName = name.trim()
          const file = backing.getState().file
          if (!file || definition?.source.kind !== 'canvas' || !nextName || nextName === definition.name || componentNameExists(file, nextName, componentId)) return false
          return execute({
            type: 'component.replace',
            componentId,
            expectedRevision: definition.revision,
            definition: { ...definition, name: nextName, revision: definition.revision + 1 },
          })
        },
        setDetails: (componentId: string, details: Readonly<{ name: string; description: string }>) => {
          const file = backing.getState().file
          const definition = file?.componentModel.definitions[componentId]
          const name = details.name.trim()
          const description = details.description.trim()
          if (!file || definition?.source.kind !== 'canvas' || !name || componentNameExists(file, name, componentId)) return false
          const usedSlugs = new Set(Object.values(file.componentModel.definitions).flatMap(candidate => candidate.id === componentId ? [] : [candidate.docs?.slug ?? componentDocsSlug(candidate.name, candidate.id)]))
          const baseSlug = componentDocsSlug(name, componentId)
          let slug = definition.docs?.slug ?? baseSlug
          for (let suffix = 2; usedSlugs.has(slug); suffix += 1) slug = `${baseSlug}-${suffix}`
          const docs = description ? { slug, description } : definition.docs ? { slug } : undefined
          if (name === definition.name && description === (definition.docs?.description ?? '')) return false
          const { docs: _previousDocs, ...definitionWithoutDocs } = definition
          return execute({
            type: 'component.replace',
            componentId,
            expectedRevision: definition.revision,
            definition: docs
              ? { ...definition, name, revision: definition.revision + 1, docs }
              : { ...definitionWithoutDocs, name, revision: definition.revision + 1 },
          })
        },
        addProperty: (componentId: string, type: ComponentPropertyDefinition['type']) => {
          const file = backing.getState().file
          const definition = file?.componentModel.definitions[componentId]
          if (!file || !definition) return null
          const id = makeId()
          const name = uniqueName(definition.properties.map(property => property.name), 'Property')
          const masterIds = definition.source.kind === 'canvas' ? [definition.source.masterRootId, ...descendantsOf(file, definition.source.masterRootId)] : []
          const textNode = masterIds.map(nodeId => file.nodes[nodeId]).find(candidate => candidate?.type === 'text')
          const masterNode = definition.source.kind === 'canvas' ? file.nodes[definition.source.masterRootId] : undefined
          const swapInstance = type === 'instance-swap' ? masterIds.map(nodeId => file.componentModel.instances[nodeId]).find(candidate => candidate && file.componentModel.definitions[candidate.componentId]?.source.kind === 'canvas') : undefined
          const defaultValueId = type === 'variant' ? makeId() : null
          const property: ComponentPropertyDefinition | null = type === 'variant'
            ? { id, name, type, defaultValueId: defaultValueId!, currentValueId: defaultValueId!, values: [], ...(masterNode && masterNode.type !== 'root' ? { binding: { kind: 'variant' as const, nodeId: masterNode.id, appearances: { [defaultValueId!]: structuredClone(nodeAppearance(masterNode) ?? {}) } } } : {}) }
            : type === 'text'
              ? { id, name, type, defaultValue: textNode?.type === 'text' ? textNode.text ?? '' : 'Text', ...(textNode?.type === 'text' ? { binding: { kind: 'text' as const, nodeId: textNode.id } } : {}) }
              : type === 'boolean'
                ? { id, name, type, defaultValue: masterNode ? nodeAppearance(masterNode)?.visible !== false : true, ...(masterNode && masterNode.type !== 'root' ? { binding: { kind: 'visibility' as const, nodeId: masterNode.id } } : {}) }
                : type === 'instance-swap'
                  ? swapInstance ? { id, name, type, defaultValue: swapInstance.componentId, binding: { kind: 'instance-swap' as const, nodeId: swapInstance.id } } : null
                  : { id, name, type, ...(masterNode && masterNode.type !== 'root' ? { binding: { kind: 'slot' as const, nodeId: masterNode.id } } : {}) }
          if (!property) return null
          const complete = property.type === 'variant' ? { ...property, values: [{ id: property.defaultValueId, name: 'Default' }] } : property
          return replaceComponentProperties(componentId, [...definition.properties, complete]) ? id : null
        },
        setProperty: (componentId: string, property: ComponentPropertyDefinition) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          const previousProperty = definition?.properties.find(candidate => candidate.id === property.id)
          if (!state.file || !definition || !previousProperty || previousProperty.type !== property.type || componentPropertyNameExists(definition, property.name, property.id)) return false
          let nextProperty = property
          if (property.type === 'variant') {
            const names = property.values.map(value => value.name.trim().toLocaleLowerCase())
            if (names.some(name => !name) || new Set(names).size !== names.length) return false
            if (!property.values.some(value => value.id === property.defaultValueId)) return false
            nextProperty = property.values.some(value => value.id === property.currentValueId)
              ? property
              : { ...property, currentValueId: property.defaultValueId }
          }
          if (previousProperty.type === 'instance-swap' && nextProperty.type === 'instance-swap') {
            const structuralChange = previousProperty.binding.nodeId !== nextProperty.binding.nodeId || previousProperty.defaultValue !== nextProperty.defaultValue
            let working = state.file
            const commands: FileCommand[] = []
            if (structuralChange) {
              for (const instance of Object.values(working.componentModel.instances)) {
                if (instance.componentId !== componentId || !Object.hasOwn(instance.values, previousProperty.id)) continue
                const plan = planComponentInstanceSwap({ file: working, owner: definition, ownerRootId: instance.id, propertyId: previousProperty.id, componentId: previousProperty.defaultValue, atoms: state.atoms, makeId })
                if (!plan) return false
                commands.push(...plan.commands)
                working = plan.file
              }
            }
            commands.push(...replaceComponentPropertyCommands(working, definition, definition.properties.map(candidate => candidate.id === property.id ? nextProperty : candidate)))
            return structuralChange ? executePlannedComponentBatch(commands) : executeBatch(commands)
          }
          return executeBatch([
            ...componentPropertyRebindingResetCommands(state.file, definition, nextProperty),
            ...componentSlotRebindingCommands(state.file, definition, nextProperty),
            ...replaceComponentPropertyCommands(state.file, definition, definition.properties.map(candidate => candidate.id === property.id ? nextProperty : candidate)),
          ])
        },
        addVariantValue: (componentId: string, propertyId: string) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          const property = definition?.properties.find(candidate => candidate.id === propertyId)
          if (!definition || property?.type !== 'variant') return null
          const id = makeId()
          const name = uniqueName(property.values.map(value => value.name), 'Value')
          const appearance = property.binding?.appearances[property.currentValueId ?? property.defaultValueId] ?? {}
          const next = { ...property, currentValueId: id, values: [...property.values, { id, name }], ...(property.binding ? { binding: { ...property.binding, appearances: { ...property.binding.appearances, [id]: structuredClone(appearance) } } } : {}) }
          return replaceComponentProperties(componentId, definition.properties.map(candidate => candidate.id === property.id ? next : candidate)) ? id : null
        },
        setVariantCurrent: (componentId: string, propertyId: string, valueId: string) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          const property = definition?.properties.find(candidate => candidate.id === propertyId)
          if (!state.file || !definition || property?.type !== 'variant' || !property.values.some(value => value.id === valueId)) return false
          const nextProperty = { ...property, currentValueId: valueId }
          const nextDefinition = { ...definition, revision: definition.revision + 1, properties: definition.properties.map(candidate => candidate.id === property.id ? nextProperty : candidate) }
          const commands: FileCommand[] = [{ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: nextDefinition }]
          if (property.binding) commands.push({ type: 'node.setAppearance', nodeId: property.binding.nodeId, appearance: structuredClone(property.binding.appearances[valueId]!) })
          for (const instance of Object.values(state.file.componentModel.instances)) if (instance.componentId === componentId) commands.push(...componentPropertyProjectionCommands(state.file, nextDefinition, instance, [nextProperty]))
          return executeBatch(commands)
        },
        setInteraction: (componentId: string, trigger: 'pointer-hover' | 'pointer-press', propertyId: string, valueId: string) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          const property = definition?.properties.find(candidate => candidate.id === propertyId)
          if (!definition || property?.type !== 'variant' || !property.values.some(value => value.id === valueId)) return false
          const existing = definition.interactions.find(interaction => interaction.trigger === trigger && interaction.propertyId === propertyId)
          const interaction = { id: existing?.id ?? makeId(), trigger, propertyId, valueId, transition: existing?.transition ?? { type: 'smart-animate' as const, durationMs: 300, easing: 'ease-out' as const } }
          const interactions = existing ? definition.interactions.map(candidate => candidate.id === existing.id ? interaction : candidate) : [...definition.interactions, interaction]
          return execute({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, interactions } })
        },
        setInteractionTransition: (componentId: string, interactionId: string, transition: NonNullable<ComponentInteraction['transition']>) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          const interaction = definition?.interactions.find(candidate => candidate.id === interactionId)
          if (!definition || !interaction) return false
          const interactions = definition.interactions.map(candidate => candidate.id === interactionId ? { ...candidate, transition } : candidate)
          return execute({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, interactions } })
        },
        removeInteraction: (componentId: string, interactionId: string) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          if (!definition || !definition.interactions.some(interaction => interaction.id === interactionId)) return false
          return execute({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, interactions: definition.interactions.filter(interaction => interaction.id !== interactionId) } })
        },
        addMaterial: (componentId: string, nodeId?: string) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          if (!state.file || definition?.source.kind !== 'canvas') return null
          const targetId = nodeId ?? definition.source.masterRootId
          const target = state.file.nodes[targetId]
          if (!target || target.type === 'root' || ![definition.source.masterRootId, ...descendantsOf(state.file, definition.source.masterRootId)].includes(targetId)) return null
          const id = makeId()
          const part = definition.parts.find(candidate => candidate.nodeId === targetId)
          const nextPart = { id: part?.id ?? makeId(), name: target.name ?? target.type, nodeId: targetId, materialId: id }
          const material = { id, group: 'Layers', name: uniqueName(definition.materials.map(candidate => candidate.name), 'Material'), appearance: structuredClone(nodeAppearance(target) ?? {}) }
          const parts = part ? definition.parts.map(candidate => candidate.id === part.id ? nextPart : candidate) : [...definition.parts, nextPart]
          const next = { ...definition, revision: definition.revision + 1, materials: [...definition.materials, material], parts }
          return execute({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: next }) ? id : null
        },
        setMaterial: (componentId: string, materialId: string, patch: { name?: string; group?: string; description?: string }) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          const material = definition?.materials.find(candidate => candidate.id === materialId)
          if (!definition || !material) return false
          const nextMaterial = { ...material, ...patch }
          if (!nextMaterial.name.trim() || !nextMaterial.group.trim() || componentMaterialNameExists(definition, nextMaterial.name, nextMaterial.group, materialId)) return false
          const materials = definition.materials.map(candidate => candidate.id === materialId ? nextMaterial : candidate)
          return execute({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, materials } })
        },
        assignMaterial: (componentId: string, materialId: string, nodeId: string) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          const material = definition?.materials.find(candidate => candidate.id === materialId)
          if (!state.file || definition?.source.kind !== 'canvas' || !material || ![definition.source.masterRootId, ...descendantsOf(state.file, definition.source.masterRootId)].includes(nodeId)) return false
          const target = state.file.nodes[nodeId]
          if (!target || target.type === 'root') return false
          const occupied = definition.parts.find(part => part.nodeId === nodeId)
          const part = { id: occupied?.id ?? makeId(), name: target.name ?? target.type, nodeId, materialId }
          const parts = definition.parts.filter(candidate => candidate.id !== occupied?.id).concat(part)
          const next = { ...definition, revision: definition.revision + 1, parts }
          return executeBatch([
            { type: 'component.replace', componentId, expectedRevision: definition.revision, definition: next },
            { type: 'node.setAppearance', nodeId, appearance: structuredClone(material.appearance) },
          ])
        },
        clearMaterial: (componentId: string, nodeId: string) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          const part = definition?.parts.find(candidate => candidate.nodeId === nodeId && candidate.materialId !== undefined)
          if (!definition || !part) return false
          const parts = definition.parts.map(candidate => candidate.id === part.id ? { id: candidate.id, name: candidate.name, nodeId: candidate.nodeId } : candidate)
          return execute({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, parts } })
        },
        captureMaterial: (componentId: string, materialId: string, nodeId?: string) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          const material = definition?.materials.find(candidate => candidate.id === materialId)
          const assigned = definition?.parts.filter(candidate => candidate.materialId === materialId) ?? []
          const part = assigned.find(candidate => candidate.nodeId === nodeId) ?? assigned[0]
          const target = part ? state.file?.nodes[part.nodeId] : undefined
          if (!state.file || !definition || !material || !part || !target || target.type === 'root') return false
          const nextMaterial = { ...material, appearance: structuredClone(nodeAppearance(target) ?? {}) }
          const next = { ...definition, revision: definition.revision + 1, materials: definition.materials.map(candidate => candidate.id === materialId ? nextMaterial : candidate) }
          const commands: FileCommand[] = [
            { type: 'component.replace', componentId, expectedRevision: definition.revision, definition: next },
            ...componentMaterialProjectionCommands(definition, nextMaterial, assigned, part.nodeId),
          ]
          return executeBatch(commands)
        },
        removeMaterial: (componentId: string, materialId: string) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          if (!definition || !definition.materials.some(material => material.id === materialId)) return false
          const parts = definition.parts.map(part => part.materialId === materialId ? { id: part.id, name: part.name, nodeId: part.nodeId } : part)
          return execute({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: { ...definition, revision: definition.revision + 1, materials: definition.materials.filter(material => material.id !== materialId), parts } })
        },
        removeProperty: (componentId: string, propertyId: string) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          const property = definition?.properties.find(candidate => candidate.id === propertyId)
          if (!state.file || !definition || !property) return false
          const commands: FileCommand[] = []
          let working = state.file
          if (property.type === 'instance-swap') {
            for (const instance of Object.values(working.componentModel.instances)) {
              if (instance.componentId !== componentId || !Object.hasOwn(instance.values, property.id)) continue
              const plan = planComponentInstanceSwap({ file: working, owner: definition, ownerRootId: instance.id, propertyId: property.id, componentId: property.defaultValue, atoms: state.atoms, makeId })
              if (!plan) return false
              commands.push(...plan.commands)
              working = plan.file
            }
          }
          if (property.type === 'slot') {
            const slotNodes: string[] = []
            for (const instance of Object.values(state.file.componentModel.instances)) {
              if (instance.componentId !== componentId) continue
              const map = definition.source.kind === 'canvas' ? mapParallelComponentSubtrees(state.file, definition.source.masterRootId, instance.id) : null
              const hostId = definition.source.kind === 'canvas' ? property.binding ? map?.get(property.binding.nodeId) : undefined : instance.id
              if (hostId) slotNodes.push(...childrenOf(state.file, hostId, definition.source.kind === 'canvas' ? property.id : property.name))
            }
            if (slotNodes.length) commands.push(...semanticDeleteCommands(state.file, slotNodes))
          } else if (property.type !== 'instance-swap') commands.push(...componentPropertyRemovalResetCommands(working, definition, property))
          commands.push(...replaceComponentPropertyCommands(working, definition, definition.properties.filter(candidate => candidate.id !== propertyId)))
          return property.type === 'instance-swap' ? executePlannedComponentBatch(commands) : executeBatch(commands)
        },
        remove: (componentId: string) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          if (!state.file || definition?.source.kind !== 'canvas') return false
          const instanceCommands: FileCommand[] = Object.values(state.file.componentModel.instances)
            .filter(instance => instance.componentId === componentId)
            .map(instance => ({ type: 'component.instance.delete', instanceId: instance.id, expected: instance }))
          return executeBatch([...instanceCommands, { type: 'component.delete', componentId, expectedRevision: definition.revision }])
        },
        addSlotContent: (instanceId: string, propertyId: string, kind: 'text' | 'frame') => {
          const state = backing.getState()
          const instance = state.file?.componentModel.instances[instanceId]
          const definition = instance ? state.file?.componentModel.definitions[instance.componentId] : undefined
          const property = definition?.properties.find(candidate => candidate.id === propertyId)
          if (!state.file || !instance || !definition || property?.type !== 'slot') return false
          const nodeMap = definition.source.kind === 'canvas' ? mapParallelComponentSubtrees(state.file, definition.source.masterRootId, instance.id) : null
          const parentId = definition.source.kind === 'canvas' ? property.binding ? nodeMap?.get(property.binding.nodeId) : undefined : instance.id
          if (!parentId) return false
          const id = makeId()
          const appearance = defaultAppearance(kind, makeId, options.editorMode?.() ?? 'light')
          const parent = state.file.nodes[parentId]
          const slotLayout = parent && nodeChildDisplay(parent) !== 'freeform' ? { layout: { item: { position: { mode: 'flow' as const } } } } : {}
          const node: FileNode = kind === 'text'
            ? { id, type: 'text', name: 'Text', styles: { relativeTransform: identityTransform, width: 120, height: 20 }, ...slotLayout, appearance, text: 'Text', ...legacyTextProperties(), themeMode: 'inherit' }
            : { id, type: 'frame', name: 'Frame', styles: { relativeTransform: identityTransform, width: 160, height: 120, overflow: 'clip' }, ...slotLayout, appearance, themeMode: 'inherit' }
          return execute({ type: 'node.insert', node, placement: { parentId, slot: definition.source.kind === 'code' ? property.name : property.id } }, [id])
        },
        addSlotComponent: (instanceId: string, propertyId: string, componentId: string) => {
          const state = backing.getState()
          const instance = state.file?.componentModel.instances[instanceId]
          const definition = instance ? state.file?.componentModel.definitions[instance.componentId] : undefined
          const property = definition?.properties.find(candidate => candidate.id === propertyId)
          const insertedDefinition = state.file?.componentModel.definitions[componentId]
          if (!state.file || !instance || !definition || property?.type !== 'slot' || !insertedDefinition || !canNestComponentInstance(state.file, instanceId, componentId)) return false
          const nodeMap = definition.source.kind === 'canvas' ? mapParallelComponentSubtrees(state.file, definition.source.masterRootId, instance.id) : null
          const parentId = definition.source.kind === 'canvas' ? property.binding ? nodeMap?.get(property.binding.nodeId) : undefined : instance.id
          if (!parentId) return false
          const slot = definition.source.kind === 'code' ? property.name : property.id
          const values: ComponentInstanceValues = {}
          if (insertedDefinition.source.kind === 'canvas') {
            const master = state.file.nodes[insertedDefinition.source.masterRootId]
            if (!master || master.type === 'root') return false
            const ids = newIdsFor(state.file, master.id)
            const nestedId = ids[master.id]!
            const nestedInstance = { id: nestedId, componentId, values }
            const commands: FileCommand[] = [
              { type: 'node.duplicate', nodeId: master.id, ids },
              ...duplicatedInstanceCommands(state.file, ids),
              { type: 'node.reparent', nodeId: nestedId, placement: { parentId, slot } },
              { type: 'component.instance.create', instance: nestedInstance },
            ]
            const projected = applyFileCommand(state.file, { type: 'batch', commands }, state.atoms, { allowUnavailableBindings: true })
            commands.push(...componentPropertyProjectionCommands(projected, insertedDefinition, nestedInstance, insertedDefinition.properties))
            return executeBatch(commands, [nestedId])
          }
          const atom = state.atoms.find(item => item.componentId === componentId && item.status === 'bound')
          if (!atom) return false
          const nestedId = makeId()
          const nestedInstance = { id: nestedId, componentId, values }
          const parent = state.file.nodes[parentId]
          const layout = parent && nodeChildDisplay(parent) === 'freeform' ? layoutFromLegacy({ mode: 'absolute', x: 0, y: 0 }) : undefined
          const commands: FileCommand[] = [
            { type: 'node.insert', node: { id: nestedId, type: 'component', componentId, exportName: atom.exportName, props: componentDefaultProps(atom), ...(layout ? { layout } : {}) }, placement: { parentId, slot } },
            { type: 'component.instance.create', instance: nestedInstance },
          ]
          const projected = applyFileCommand(state.file, { type: 'batch', commands }, state.atoms, { allowUnavailableBindings: true })
          commands.push(...componentPropertyProjectionCommands(projected, insertedDefinition, nestedInstance, insertedDefinition.properties))
          return executeBatch(commands, [nestedId])
        },
        place: (componentId: string, values: ComponentInstanceValues = {}, slotDrafts: readonly ComponentSlotDraft[] = []) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          if (!state.file || !state.pageId || !definition) return false
          if (definition.source.kind === 'canvas') {
            const configurablePropertyIds = new Set(componentConfigurableDefinition(definition).properties.map(property => property.id))
            if (Object.keys(values).some(propertyId => !configurablePropertyIds.has(propertyId))) return false
          }
          resolveComponentInstanceValues(definition, values)
          if (definition.source.kind === 'canvas') {
            const master = state.file.nodes[definition.source.masterRootId]
            const targetRoot = root(state)
            if (!master || master.type === 'root' || !targetRoot) return false
            const ids = newIdsFor(state.file, master.id)
            const instanceId = ids[master.id]!
            const width = master.type === 'component' ? legacyLayout(master.layout).width ?? 0 : master.styles.width
            const commands: FileCommand[] = [{ type: 'node.duplicate', nodeId: master.id, ids, offset: { x: width + duplicateGap, y: 0 } }, ...duplicatedInstanceCommands(state.file, ids)]
            if (state.file.relationships[master.id]?.parentId !== targetRoot) commands.push({ type: 'node.reparent', nodeId: instanceId, placement: { parentId: targetRoot }, preserveWorldPosition: true })
            const scalarValues = Object.fromEntries(Object.entries(values).filter(([propertyId]) => definition.properties.find(property => property.id === propertyId)?.type !== 'instance-swap'))
            const instance = { id: instanceId, componentId, values: scalarValues }
            commands.push({ type: 'component.instance.create', instance })
            let projected = applyFileCommand(state.file, { type: 'batch', commands }, state.atoms, { allowUnavailableBindings: true })
            const propertyCommands = componentPropertyProjectionCommands(projected, definition, instance, definition.properties)
            commands.push(...propertyCommands)
            if (propertyCommands.length) projected = applyFileCommand(projected, { type: 'batch', commands: propertyCommands }, state.atoms, { allowUnavailableBindings: true })
            const swapPlan = planInstanceSwapValues(projected, definition, instanceId, values)
            if (!swapPlan) return false
            commands.push(...swapPlan.commands)
            projected = swapPlan.file
            const slotPlan = planComponentSlotDrafts({ file: projected, owner: definition, ownerRootId: instanceId, drafts: slotDrafts, atoms: state.atoms, makeId, editorMode: options.editorMode?.() ?? 'light' })
            if (!slotPlan) return false
            commands.push(...slotPlan.commands)
            return swapPlan.commands.length || slotPlan.commands.length ? executePlannedComponentBatch(commands, [instanceId]) : executeBatch(commands, [instanceId])
          }
          if (slotDrafts.length) return false
          const atom = state.atoms.find(item => item.componentId === componentId && item.status === 'bound')
          if (!atom) return false
          const id = makeId()
          const commands: FileCommand[] = [
            { type: 'node.insert', node: { id, type: 'component', componentId, exportName: atom.exportName, props: componentDefaultProps(atom) }, placement: placementFor(undefined, state) },
            { type: 'component.instance.create', instance: { id, componentId, values } },
          ]
          const projected = applyFileCommand(state.file, { type: 'batch', commands }, state.atoms, { allowUnavailableBindings: true })
          const instance = { id, componentId, values }
          commands.push(...componentPropertyProjectionCommands(projected, definition, instance, definition.properties))
          return executeBatch(commands, [id])
        },
        placeVariantSheet: (componentId: string) => {
          const state = backing.getState()
          const definition = state.file?.componentModel.definitions[componentId]
          if (!state.file || !state.pageId || definition?.source.kind !== 'canvas') return false
          const master = state.file.nodes[definition.source.masterRootId]
          const targetRoot = root(state)
          if (!master || master.type === 'root' || !targetRoot) return false
          const configurableDefinition = componentConfigurableDefinition(definition)
          if (!configurableDefinition.properties.some(property => property.type === 'variant')) return false
          const combinations = componentVariantCombinations(configurableDefinition)
          const width = master.type === 'component' ? legacyLayout(master.layout).width ?? 0 : master.styles.width
          const height = master.type === 'component' ? legacyLayout(master.layout).height ?? 0 : master.styles.height
          const labelHeight = 20
          const labelGap = 8
          const labelBand = labelHeight + labelGap
          const labels = combinations.map(combination => componentVariantCombinationLabel(configurableDefinition, combination))
          const labelWidth = Math.max(width, 160)
          const cellWidth = Math.max(labelWidth, 1) + duplicateGap
          const cellHeight = Math.max(height, 1) + labelBand + duplicateGap
          const columns = Math.max(1, Math.ceil(Math.sqrt(combinations.length)))
          const rows = Math.ceil(combinations.length / columns)
          const placements = combinations.map((combination, index) => {
            const ids = newIdsFor(state.file!, master.id)
            const column = index % columns
            const row = Math.floor(index / columns)
            return { ids, instanceId: ids[master.id]!, label: labels[index]!, column, row, values: sparseComponentValues(configurableDefinition, combination), offset: { x: (column + 1) * cellWidth, y: labelBand + row * cellHeight } }
          })
          const first = placements[0]!
          const firstProjected = applyFileCommand(state.file, { type: 'node.duplicate', nodeId: master.id, ids: first.ids, offset: first.offset }, state.atoms, { allowUnavailableBindings: true })
          const firstWorld = worldPosition(firstProjected, first.instanceId)
          const sheetOrigin = { x: firstWorld.x, y: firstWorld.y - labelBand }
          const sheetId = makeId()
          const sheet: FileNode = {
            id: sheetId,
            type: 'frame',
            name: `${definition.name} variants`,
            styles: {
              relativeTransform: [1, 0, 0, 1, sheetOrigin.x, sheetOrigin.y],
              width: columns * cellWidth - duplicateGap,
              height: rows * cellHeight - duplicateGap,
              overflow: 'visible',
            },
            appearance: {},
          }
          const commands: FileCommand[] = [{ type: 'node.insert', node: sheet, placement: { parentId: targetRoot } }]
          let projected = applyFileCommand(state.file, commands[0]!, state.atoms, { allowUnavailableBindings: true })
          for (const placement of placements) {
            const labelId = makeId()
            const label: FileNode = {
              id: labelId,
              type: 'text',
              name: placement.label,
              text: placement.label,
              ...legacyTextProperties(),
              styles: {
                relativeTransform: [1, 0, 0, 1, placement.column * cellWidth, placement.row * cellHeight],
                width: labelWidth,
                height: labelHeight,
              },
              appearance: defaultAppearance('text', makeId, options.editorMode?.() ?? 'light'),
            }
            const instance = { id: placement.instanceId, componentId, values: placement.values }
            const placementCommands: FileCommand[] = [
              { type: 'node.insert', node: label, placement: { parentId: sheetId } },
              { type: 'node.duplicate', nodeId: master.id, ids: placement.ids, offset: placement.offset },
              ...duplicatedInstanceCommands(projected, placement.ids),
              { type: 'node.reparent', nodeId: placement.instanceId, placement: { parentId: sheetId }, preserveWorldPosition: true },
            ]
            placementCommands.push({ type: 'component.instance.create', instance })
            const withInstance = applyFileCommand(projected, { type: 'batch', commands: placementCommands }, state.atoms, { allowUnavailableBindings: true })
            placementCommands.push(...componentPropertyProjectionCommands(withInstance, definition, instance, definition.properties))
            projected = applyFileCommand(projected, { type: 'batch', commands: placementCommands }, state.atoms, { allowUnavailableBindings: true })
            commands.push(...placementCommands)
          }
          return executeBatch(commands, [sheetId])
        },
        setInstanceValue: (instanceId: string, propertyId: string, value: ComponentScalarValue | null) => {
          const state = backing.getState()
          const instance = state.file?.componentModel.instances[instanceId]
          if (!instance) return false
          const definition = state.file?.componentModel.definitions[instance.componentId]
          const property = definition?.properties.find(candidate => candidate.id === propertyId)
          if (!definition || !property || (value !== null && definition.source.kind === 'canvas' && !property.binding)) return false
          const values = { ...instance.values }
          if (value === null) delete values[propertyId]
          else values[propertyId] = value
          if (property.type === 'instance-swap') {
            if (!state.file) return false
            const plan = planInstanceSwapValues(state.file, definition, instanceId, values)
            return plan ? executePlannedComponentBatch([...plan.commands]) : false
          }
          const next = { ...instance, values }
          const commands: FileCommand[] = [{ type: 'component.instance.replace', instanceId, expected: instance, instance: next }]
          if (state.file) commands.push(...componentPropertyProjectionCommands(state.file, definition, next, [property]))
          return executeBatch(commands)
        },
        detach: (instanceId: string) => {
          const state = backing.getState()
          const instance = state.file?.componentModel.instances[instanceId]
          const definition = instance ? state.file?.componentModel.definitions[instance.componentId] : undefined
          if (!instance || definition?.source.kind !== 'canvas') return false
          return execute({ type: 'component.instance.delete', instanceId, expected: instance })
        },
        resetInstanceValues: (instanceId: string) => {
          const state = backing.getState()
          const instance = state.file?.componentModel.instances[instanceId]
          const definition = instance ? state.file?.componentModel.definitions[instance.componentId] : undefined
          if (!state.file || !instance || !definition || Object.keys(instance.values).length === 0) return false
          const swapPlan = planInstanceSwapValues(state.file, definition, instanceId, {})
          if (!swapPlan) return false
          const current = swapPlan.file.componentModel.instances[instanceId]
          if (!current) return false
          const next = { ...current, values: {} }
          const commands = [...swapPlan.commands]
          if (Object.keys(current.values).length) commands.push({ type: 'component.instance.replace', instanceId, expected: current, instance: next })
          commands.push(...componentPropertyProjectionCommands(swapPlan.file, definition, next, definition.properties))
          return swapPlan.commands.length ? executePlannedComponentBatch(commands) : executeBatch(commands)
        },
        openMaster: (componentId: string) => {
          const definition = backing.getState().file?.componentModel.definitions[componentId]
          if (definition?.source.kind !== 'canvas') return false
          setSelection([definition.source.masterRootId])
          return true
        },
      },
      /** Inserts a component instance under the page root or into a component slot. */
      insert: (componentId: string, target?: InsertTarget, props: Record<string, string | number | boolean> = {}) => insertCodeComponent(componentId, target, props),
      /** Inserts a root component at one deterministic world point. Slot targets retain their component-owned flow. */
      insertAt: (componentId: string, point: ComponentInsertPoint, target?: InsertTarget, props: Record<string, string | number | boolean> = {}) => insertCodeComponent(componentId, target, props, point),
      duplicate,
      layerTreeDrop,
      delete: (nodeIds = backing.getState().selection) => deleteSelection(nodeIds),
      /** Moves a component instance to another slot or position (layer tree drop). */
      move: (nodeId: string, target: InsertTarget) => { const state = backing.getState(); return state.file ? execute({ type: 'node.reparent', nodeId, placement: placementFor(target, state) }) : false },
      moveBy,
      nudge,
      /** Reorders a flow child among its current siblings. */
      reorderFlow: (nodeId: string, index: number): PersistenceCommit => {
        const state = backing.getState()
        const relationship = state.file?.relationships[nodeId]
        if (!state.file || !relationship) return noPersistenceCommit
        const siblings = childrenOf(state.file, relationship.parentId, relationship.slot)
        const current = siblings.indexOf(nodeId)
        const target = Math.max(0, Math.min(siblings.length - 1, index > current ? index - 1 : index))
        if (target === current) return noPersistenceCommit
        return executeWithPersistence({ type: 'node.reorder', nodeId, index: target }, undefined, undefined, true)
      },
      setProps: (nodeId: string, props: Record<string, string | number | boolean>) => execute({ type: 'node.setProps', nodeId, props }),
      removeProps: (nodeId: string, names: string[]) => execute({ type: 'node.setProps', nodeId, props: {}, remove: names }),
      /** Sets the five-field placement; container, spacing and other v4 fields on the node survive untouched. */
      setLayout: (nodeId: string, layout: DocumentNodeLayout) => { const node = backing.getState().file?.nodes[nodeId]; return node ? execute(placementCommand(node, layout)) : false },
      rename: (nodeId: string, name: string) => { const next = name.trim(); return next ? execute({ type: 'node.rename', nodeId, name: next }) : false },
      setLocked: (nodeId: string, isLocked: boolean) => execute({ type: 'node.setLocked', nodeId, isLocked }),
      setText: (nodeId: string, text: string) => execute({ type: 'node.setText', nodeId, text }),
      text: {
        /** The only typography write seam: style and sizing intent cross validation and history together. */
        setProperties: (nodeId: string, textStyle: TextStyle, textSizing: TextSizing) => execute({ type: 'node.setTextProperties', nodeId, textStyle, textSizing }),
        /** One complete typography edit across a selection is one validated revision and one undo step. */
        setPropertiesMany: (entries: readonly { nodeId: string; textStyle: TextStyle; textSizing: TextSizing }[]) => executeBatch(entries.map(entry => ({ type: 'node.setTextProperties', ...entry }))),
        /** Paper exposes max lines only with Fit height. Turning it off preserves the current sizing intent. */
        setMaxLines: (nodeId: string, maxLines: number | undefined) => {
          const target = node(nodeId)
          if (!target || target.type !== 'text' || !target.textStyle || !target.textSizing) return false
          const textStyle = structuredClone(target.textStyle)
          if (maxLines === undefined) delete textStyle.maxLines
          else textStyle.maxLines = maxLines
          const textSizing: TextSizing = maxLines === undefined ? structuredClone(target.textSizing) : { width: structuredClone(target.textSizing.width), height: { mode: 'fit' } }
          return execute({ type: 'node.setTextProperties', nodeId, textStyle, textSizing })
        },
        /** Applies truncation intent to every selected text node atomically. */
        setMaxLinesMany: (entries: readonly { nodeId: string; maxLines: number | undefined }[]) => {
          const commands: FileCommand[] = []
          for (const entry of entries) {
            const target = node(entry.nodeId)
            if (!target || target.type !== 'text' || !target.textStyle || !target.textSizing) return false
            const textStyle = structuredClone(target.textStyle)
            if (entry.maxLines === undefined) delete textStyle.maxLines
            else textStyle.maxLines = entry.maxLines
            const textSizing: TextSizing = entry.maxLines === undefined ? structuredClone(target.textSizing) : { width: structuredClone(target.textSizing.width), height: { mode: 'fit' } }
            commands.push({ type: 'node.setTextProperties', nodeId: entry.nodeId, textStyle, textSizing })
          }
          return executeBatch(commands)
        },
        /** Changes text sizing intent and the parent-dependent layout contract in one undo step. */
        setSizingModes: setTextSizingModes,
        /** Resize-handle shortcuts change sizing intent through the same complete-property command. */
        setSizingMode: (nodeId: string, axes: readonly ResizeAxis[], mode: 'fit' | 'fill', geometry?: { measured?: { width?: number; height?: number }; parent?: { width?: number; height?: number }; local?: { x: number; y: number } }) => setTextSizingModes([{ nodeId, axes, mode, ...geometry }]),
        begin: beginTextEditing,
        update: updateTextEditing,
        commit: commitTextEditing,
        cancel: cancelTextEditing,
        /** Selects and starts the next text in layer order, wrapping at either end. */
        focusAdjacent: focusAdjacentText,
      },
      setStyles: (nodeId: string, styles: PrimitiveStylePatch) => execute({ type: 'node.setStyles', nodeId, styles }),
      /** One primitive geometry/transform edit across a selection is one revision and one undo step. */
      setStylesMany: (entries: Record<string, PrimitiveStylePatch>) => executeBatch(Object.entries(entries).flatMap(([nodeId, styles]): FileCommand[] => isPrimitive(node(nodeId)) ? [{ type: 'node.setStyles', nodeId, styles }] : [])),
      // Appearance ---------------------------------------------------------------------------------------------
      /** Selection-level appearance edits: every method builds one atomic batch so one user action is one undo step. */
      appearance: {
        setBlending: (nodeIds: readonly string[], patch: { visible?: boolean; opacity?: number; blendMode?: BlendMode }) => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.setBlending', nodeId, ...patch }))),
        addFill: (nodeIds: readonly string[]) => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.fill.add', nodeId, paint: { id: makeId(), type: 'solid', color: defaultFillColor(kindOf(nodeId)) } }))),
        replaceFills: (nodeIds: readonly string[], fills: Paint[]) => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.fill.replace', nodeId, fills: fills.map(paint => withFreshIds(paint, makeId)) }))),
        updateFill: (nodeIds: readonly string[], index: number, paint: Paint) => executeBatch(styledIds(nodeIds).flatMap(nodeId => { const current = fillsOf(nodeId)[index]; return current ? [{ type: 'node.fill.update', nodeId, fillId: current.id, paint: { ...paint, id: current.id } } as FileCommand] : [] })),
        moveFill: (nodeIds: readonly string[], from: number, to: number) => executeBatch(styledIds(nodeIds).flatMap(nodeId => { const current = fillsOf(nodeId)[from]; return current ? [{ type: 'node.fill.move', nodeId, fillId: current.id, index: to } as FileCommand] : [] })),
        removeFill: (nodeIds: readonly string[], index: number) => executeBatch(styledIds(nodeIds).flatMap(nodeId => { const current = fillsOf(nodeId)[index]; return current ? [{ type: 'node.fill.remove', nodeId, fillId: current.id } as FileCommand] : [] })),
        setOutline: (nodeIds: readonly string[], outline: Outline | null) => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.outline.set', nodeId, outline }))),
        addBorder: (nodeIds: readonly string[]) => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.borders.set', nodeId, borders: nextBorders(nodeAppearance(node(nodeId))?.borders) }))),
        setBorders: (nodeIds: readonly string[], borders: Borders | null) => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.borders.set', nodeId, borders }))),
        updateBorder: (nodeIds: readonly string[], side: BorderSide | 'all', stroke: Stroke) => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.border.update', nodeId, side, stroke }))),
        removeBorder: (nodeIds: readonly string[], side: BorderSide | 'all') => executeBatch(styledIds(nodeIds).map(nodeId => ({ type: 'node.border.remove', nodeId, side }))),
        /** Moves one side's record to another empty side in one step. */
        moveBorderSide: (nodeIds: readonly string[], from: BorderSide, to: BorderSide) => executeBatch(styledIds(nodeIds).flatMap(nodeId => {
          const borders = nodeAppearance(node(nodeId))?.borders
          if (!borders || 'all' in borders) return []
          const sides = borders as Partial<Record<BorderSide, Stroke>>
          const stroke = sides[from]
          if (!stroke || sides[to]) return []
          const next = { ...sides }; delete next[from]; next[to] = stroke
          return [{ type: 'node.borders.set', nodeId, borders: next } as FileCommand]
        })),
        /** Live preview without history: begin snapshots nothing but marks the gesture; commit writes one batch; cancel restores exactly. */
        gesture: {
          begin: () => { emit({ appearanceOverrides: {} }) },
          preview: (overrides: Record<string, Appearance | null>) => { if (backing.getState().appearanceOverrides !== null) emit({ appearanceOverrides: { ...overrides } }) },
          commit: () => {
            const overrides = backing.getState().appearanceOverrides
            emit({ appearanceOverrides: null })
            if (!overrides) return false
            return executeBatch(Object.entries(overrides).filter(([nodeId]) => node(nodeId) && node(nodeId)!.type !== 'root').map(([nodeId, appearance]) => ({ type: 'node.setAppearance', nodeId, appearance })))
          },
          cancel: () => { emit({ appearanceOverrides: null }) },
        },
      },
      // Node themes ---------------------------------------------------------------------------------------------
      nodeTheme: {
        /** One stored mode for every selected node as one batch; nodes already in that mode are skipped, so a no-op writes nothing. */
        set: (nodeIds: string[], themeMode: NodeThemeMode) => executeBatch([...new Set(nodeIds)].flatMap((nodeId): FileCommand[] => { const current = node(nodeId); return current && current.type !== 'root' && nodeThemeMode(current) !== themeMode ? [{ type: 'node.setThemeMode', nodeId, themeMode }] : [] })),
      },
      // Layout -------------------------------------------------------------------------------------------------
      layout: {
        ...createFlexCommands(layoutContext),
        grid: createGridCommands(layoutContext),
        /** Plans and applies one selection-scoped Paper Wrap command, selecting every generated frame. */
        wrapSelection: (geometry: LayoutGeometry): PaperWrapExecutionResult => {
          const state = backing.getState()
          const plan: PaperWrapPlanResult = state.file
            ? planPaperWrap({ file: state.file, geometry, selection: state.selection, layoutGeneration: state.layoutGeneration, makeId })
            : { status: 'unavailable', reason: 'missing', message: paperWrapCopy.missing }
          if (plan.status !== 'ready') return plan
          return execute(plan.command, [...plan.wrapperIds])
            ? { status: 'written', wrapperIds: plan.wrapperIds }
            : { status: 'unavailable', reason: 'write', message: paperWrapCopy.write }
        },
        /** Plans explicit Flex parents while preserving the user's complete current selection as view state. */
        removeFlexSelection: (geometry: LayoutGeometry, targetIds: readonly string[]): PaperRemoveFlexExecutionResult => {
          const state = backing.getState()
          const plan: PaperRemoveFlexPlanResult = state.file
            ? planPaperRemoveFlex({ file: state.file, geometry, selection: targetIds, layoutGeneration: state.layoutGeneration })
            : { status: 'unavailable', reason: 'missing', message: paperRemoveFlexCopy.missing }
          if (plan.status !== 'ready') return plan
          return execute(plan.command, [...state.selection])
            ? { status: 'written', parentIds: plan.parentIds }
            : { status: 'unavailable', reason: 'write', message: paperRemoveFlexCopy.write }
        },
        /** Stores a full v4 layout record for one node. */
        set: (nodeId: string, layout: NodeLayout) => execute({ type: 'node.setLayout', nodeId, layout }),
        /** Stores layout records for several nodes as one batch and one undo entry. */
        setMany: (entries: Record<string, NodeLayout>) => executeBatch(Object.entries(entries).filter(([nodeId]) => node(nodeId)?.type === 'component').map(([nodeId, layout]): FileCommand => ({ type: 'node.setLayout', nodeId, layout }))),
        /**
         * Moves a component under another component (or back to the page root) keeping its world pose: the new local pose
         * is inverse(newParentWorld) x world from the measured chain, so nested rotation and scale stay exact (LAY-GEST-003).
         * One batch: the relationship change and the absolute layout record. Returns false without measurement.
         */
        reparent: (nodeId: string, placement: NodePlacement, measured: Record<string, MeasuredNode>) => {
          const state = backing.getState()
          const current = node(nodeId)
          if (!state.file || current?.type !== 'component' || isProtectedInstanceDescendant(state.file, nodeId)) return false
          const target = state.file.nodes[placement.parentId]
          if (!target || (target.type !== 'root' && target.type !== 'component')) return false
          const pose = reparentPose(measured, nodeId, target.type === 'root' ? null : placement.parentId, hostOrigin(flowHost))
          if (!pose) return false
          return executeBatch([{ type: 'node.reparent', nodeId, placement }, { type: 'node.setLayout', nodeId, layout: layoutWithPose(current.layout, pose) }])
        },
        /** Flow or absolute for several nodes; `local` supplies each node's parent-local position when leaving the flow. One batch. */
        position: (mode: 'flow' | 'absolute', targets: { id: string; local?: { x: number; y: number } }[]) => executeBatch(targets.flatMap(({ id, local }): FileCommand[] => {
          const current = node(id)
          if (current?.type !== 'component') return []
          const parentId = parentOf(id)
          const parentNode = parentId ? node(parentId) : undefined
          const parentDisplay = parentNode?.type === 'component' ? parentNode.layout?.container?.display ?? null : null
          const next = mode === 'absolute' ? positionAbsolute(current.layout, local ?? { x: 0, y: 0 }) : positionFlow(current.layout, parentDisplay)
          return next === current.layout ? [] : [{ type: 'node.setLayout', nodeId: id, layout: next }]
        })),
        /** Semantic sizing for one axis across a selection, each node with its own measurement (LAY-SIZE-003). One batch. */
        sizing: (axis: Axis, mode: SizingMode, targets: SizingTarget[]) => executeBatch(Object.entries(setAxisSizingMany(targets.filter(target => node(target.id)?.type === 'component'), axis, mode)).map(([nodeId, layout]): FileCommand => ({ type: 'node.setLayout', nodeId, layout }))),
        /** Primitive Fixed/Fit/Fill uses styles as fixed authority and layout only for semantic non-pixel sizing. */
        primitiveSizing: (axis: Axis, mode: 'fixed' | 'hug' | 'fill', targets: readonly { id: string; measuredPx?: number; parentPx?: number; parentMeasuredPx?: number; local?: { x: number; y: number } }[]) => executeBatch(targets.flatMap(({ id, measuredPx, parentPx, parentMeasuredPx, local }): FileCommand[] => {
          const current = node(id)
          if (!isPrimitive(current) || current.type === 'text') return []
          const base = current.layout ?? { item: { position: { mode: 'freeform' as const } } }
          const parentId = parentOf(id)
          const parent = parentId ? node(parentId) : undefined
          const display = parent && parent.type !== 'root' ? parent.layout?.container?.display ?? 'freeform' : null
          const direction = display === 'flex' && parent && parent.type !== 'root' ? parent.layout?.container?.flex?.direction ?? 'column' : null
          const sized = setAxisSizing(base, axis, mode, { measuredPx, parentPx }, direction, display, local)
          const nextLayout = mode === 'fixed' && sized ? setAxisLength(sized, axis, null) : sized
          if (!nextLayout) return []
          if (mode !== 'fixed') {
            const commands: FileCommand[] = []
            const parentFits = parent && parent.type !== 'root' && parent.type !== 'text' && sizingModeOf(parent.layout, axis) === 'hug'
            const childCanFit = current.type === 'frame'
            if (mode === 'fill' && nodePositionMode(current) === 'flow' && parentFits && !childCanFit && parent?.type === 'frame') {
              const fixedParent = typeof parentMeasuredPx === 'number' && Number.isFinite(parentMeasuredPx) && parentMeasuredPx > 0 ? Math.max(1, Math.round(parentMeasuredPx)) : parent.styles[axis]
              commands.push({ type: 'node.setLayout', nodeId: parent.id, layout: setAxisLength(parent.layout ?? { item: { position: { mode: nodePositionMode(parent) ?? 'freeform' } } }, axis, null) })
              commands.push({ type: 'node.setStyles', nodeId: parent.id, styles: { [axis]: fixedParent } })
            }
            commands.push({ type: 'node.setLayout', nodeId: id, layout: nextLayout })
            return commands
          }
          const fixed = typeof measuredPx === 'number' && Number.isFinite(measuredPx) && measuredPx > 0 ? Math.max(1, Math.round(measuredPx)) : current.styles[axis]
          return [
            { type: 'node.setLayout', nodeId: id, layout: nextLayout },
            { type: 'node.setStyles', nodeId: id, styles: { [axis]: fixed } },
          ]
        })),
        length: (axis: Axis, length: LayoutLength | null, nodeIds: string[]) => executeBatch(nodeIds.flatMap((id): FileCommand[] => { const current = node(id); return current?.type === 'component' ? [{ type: 'node.setLayout', nodeId: id, layout: setAxisLength(current.layout, axis, length) }] : [] })),
        bound: (axis: Axis, bound: 'min' | 'max', length: LayoutLength | null, nodeIds: string[]) => executeBatch(nodeIds.flatMap((id): FileCommand[] => { const current = node(id); return current?.type === 'component' ? [{ type: 'node.setLayout', nodeId: id, layout: setAxisBound(current.layout, axis, bound, length) }] : [] })),
        aspectRatio: (ratio: number | null, nodeIds: string[]) => executeBatch(nodeIds.flatMap((id): FileCommand[] => { const current = node(id); return current?.type === 'component' ? [{ type: 'node.setLayout', nodeId: id, layout: setAspectRatio(current.layout, ratio) }] : [] })),
        inset: (side: InsetSide, length: InsetLength | null, nodeIds: string[]) => executeBatch(nodeIds.flatMap((id): FileCommand[] => { const current = node(id); const next = current?.type === 'component' ? setInset(current.layout, side, length) : null; return next ? [{ type: 'node.setLayout', nodeId: id, layout: next }] : [] })),
        zIndex: (zIndex: number | null, nodeIds: string[]) => executeBatch(nodeIds.flatMap((id): FileCommand[] => { const current = node(id); const next = current?.type === 'component' ? setZIndex(current.layout, zIndex) : null; return next ? [{ type: 'node.setLayout', nodeId: id, layout: next }] : [] })),
        spacing: (spacing: NodeSpacing | null, nodeIds: string[]) => executeBatch(nodeIds.flatMap((id): FileCommand[] => { const current = node(id); return current?.type === 'component' ? [{ type: 'node.setLayout', nodeId: id, layout: setSpacing(current.layout, spacing) }] : [] })),
        /** Preview rides on the protocol only; commit writes one batch; cancel clears without touching file or history. */
        gesture: {
          begin: () => { const state = backing.getState(); emit({ layoutOverrides: {}, layoutGeneration: state.layoutGeneration + 1 }) },
          preview: (overrides: Record<string, NodeLayout | null>) => { if (backing.getState().layoutOverrides !== null) emit({ layoutOverrides: { ...overrides } }) },
          commit: () => {
            const state = backing.getState()
            const overrides = state.layoutOverrides
            emit({ layoutOverrides: null, layoutGeneration: state.layoutGeneration + 1 })
            if (!overrides) return false
            const entries = Object.entries(overrides).filter(([nodeId, layout]) => layout !== null && node(nodeId)?.type === 'component') as [string, NodeLayout][]
            if (!entries.length) return false
            return executeBatch(entries.map(([nodeId, layout]): FileCommand => ({ type: 'node.setLayout', nodeId, layout })))
          },
          cancel: () => { const state = backing.getState(); if (state.layoutOverrides !== null) emit({ layoutOverrides: null, layoutGeneration: state.layoutGeneration + 1 }) },
        },
      },
      /** Imports image bytes into a session sidecar and stores only the canonical immutable reference in the file. */
      assets: {
        add: async (source: File): Promise<string | null> => {
          const state = backing.getState()
          if (!state.file || persistenceBlocked) return null
          const currentGeneration = generation
          const fileId = state.file.fileId
          let prepared: File
          try { prepared = await prepareImageFile(source) } catch (error) { fail(error instanceof Error ? error : new Error(canvasCopy.unsupportedImage), canvasCopy.imageFailed); return null }
          if (!(imageMimes as readonly string[]).includes(prepared.type) || prepared.size < 1 || prepared.size > appearanceLimits.assetBytes) { fail(new Error(canvasCopy.unsupportedImage), canvasCopy.imageFailed); return null }
          let bitmap: ImageBitmap
          try { bitmap = await createImageBitmap(prepared) } catch { fail(new Error(canvasCopy.unsupportedImage), canvasCopy.imageFailed); return null }
          const bytes = new Uint8Array(await prepared.arrayBuffer())
          let binary = ''
          for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
          const mime = prepared.type as ImageMime
          const namedExtension = /\.([A-Za-z0-9]+)$/.exec(prepared.name)?.[1]?.toLowerCase()
          const extensionByMime: Record<ImageMime, ImageExtension> = { 'image/avif': 'avif', 'image/gif': 'gif', 'image/jpeg': namedExtension === 'jpg' ? 'jpg' : 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
          const asset: ImageAssetReference = { id: makeId(), name: prepared.name.slice(0, 256) || 'Image', mime, extension: extensionByMime[mime], width: bitmap.width, height: bitmap.height, bytes: bytes.length, sha256: digest }
          bitmap.close()
          try { validateImageAssetReference(asset) } catch { fail(new Error(canvasCopy.unsupportedImage), canvasCopy.imageFailed); return null }
          const localPreview: EditorAssetPreview = { assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data: btoa(binary) }
          let uploaded: EditorAssetUploadResult = { asset, preview: localPreview }
          if (options.uploadImage) {
            try { uploaded = await options.uploadImage({ fileId, asset, bytes }) }
            catch (error) { if (currentGeneration === generation && backing.getState().file?.fileId === fileId) fail(error, canvasCopy.imageFailed); return null }
          }
          if (currentGeneration !== generation || backing.getState().file?.fileId !== fileId) return null
          try {
            validateImageAssetReference(uploaded.asset)
            if (!sameAssetReference(uploaded.asset, asset) || uploaded.preview.data !== localPreview.data) throw new Error(canvasCopy.unsupportedImage)
            assetPreviewData.set(uploaded.asset.id, validateAssetPreview(uploaded.asset, uploaded.preview))
          } catch (error) { fail(error, canvasCopy.imageFailed); return null }
          if (!execute({ type: 'asset.attach', asset: uploaded.asset })) {
            assetPreviewData.delete(uploaded.asset.id)
            return null
          }
          return uploaded.asset.id
        },
        /** Stages every clipboard image before one semantic attach-and-insert batch. */
        insertClipboard: async (images: readonly Readonly<{ file: File; width: number; height: number }>[], insertionPoint?: Point) => {
          const captured = backing.getState()
          if (!captured.file || !captured.pageId || captured.readOnly || persistenceBlocked || !images.length) return { inserted: [] as string[], failures: images.map(image => ({ name: image.file.name, diagnostic: canvasCopy.imageFailed })) }
          const capturedGeneration = generation
          const capturedFileId = captured.file.fileId
          const capturedRevision = captured.file.revision
          const capturedPageId = captured.pageId
          const capturedSelection = [...captured.selection]
          const capturedCenter = insertionPoint ?? screenToWorld({ x: captured.viewportSize.width / 2, y: captured.viewportSize.height / 2 }, captured.viewport, captured.viewportSize)
          const capturedVisibleSize = { width: captured.viewportSize.width / captured.viewport.zoom, height: captured.viewportSize.height / captured.viewport.zoom }
          const extensionFor = (file: File): ImageExtension => {
            const named = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase()
            if (file.type === 'image/jpeg') return named === 'jpg' ? 'jpg' : 'jpeg'
            return ({ 'image/avif': 'avif', 'image/gif': 'gif', 'image/png': 'png', 'image/webp': 'webp' } as const)[file.type as Exclude<ImageMime, 'image/jpeg'>]
          }
          const reserved = images.map(image => ({ image, assetId: makeId(), nodeId: makeId(), fillId: makeId() }))
          try {
            const preflightAssets: ImageAssetReference[] = reserved.map(entry => ({
              id: entry.assetId,
              name: entry.image.file.name.slice(0, 256) || 'Image',
              mime: entry.image.file.type as ImageMime,
              extension: extensionFor(entry.image.file),
              bytes: entry.image.file.size,
              width: entry.image.width,
              height: entry.image.height,
              sha256: '0'.repeat(64),
            }))
            const preflightIds = reserved.flatMap(entry => [entry.nodeId, entry.fillId])
            planClipboardImageInsertion(captured.file, captured.pageId, preflightAssets, { center: capturedCenter, visibleSize: capturedVisibleSize, selection: capturedSelection, containSelectionAtCenter: Boolean(insertionPoint) }, () => preflightIds.shift()!, captured.atoms)
          } catch (error) {
            const diagnostic = error instanceof Error ? error.message : canvasCopy.imageFailed
            return { inserted: [] as string[], failures: images.map(image => ({ name: image.file.name, diagnostic })) }
          }
          type Staged = Readonly<{ asset: ImageAssetReference; preview: EditorAssetPreview; nodeId: string; fillId: string; sourceName: string }>
          const results: ({ staged: Staged } | { failure: { name: string; diagnostic: string } } | undefined)[] = new Array(images.length)
          let cursor = 0
          const stage = async (entry: typeof reserved[number]): Promise<Staged> => {
            const image = entry.image
            const prepared = image.file
            if (!(imageMimes as readonly string[]).includes(prepared.type) || prepared.size < 1 || prepared.size > appearanceLimits.assetBytes) throw new Error(canvasCopy.unsupportedImage)
            const bitmap = await createImageBitmap(prepared)
            try {
              if (bitmap.width !== image.width || bitmap.height !== image.height) throw new Error(canvasCopy.unsupportedImage)
              const bytes = new Uint8Array(await prepared.arrayBuffer())
              let binary = ''
              for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
              const mime = prepared.type as ImageMime
              const namedExtension = /\.([A-Za-z0-9]+)$/.exec(prepared.name)?.[1]?.toLowerCase()
              const extensionByMime: Record<ImageMime, ImageExtension> = { 'image/avif': 'avif', 'image/gif': 'gif', 'image/jpeg': namedExtension === 'jpg' ? 'jpg' : 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }
              const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
              const asset: ImageAssetReference = { id: entry.assetId, name: prepared.name.slice(0, 256) || 'Image', mime, extension: extensionByMime[mime], width: bitmap.width, height: bitmap.height, bytes: bytes.length, sha256: digest }
              validateImageAssetReference(asset)
              const localPreview: EditorAssetPreview = { assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data: btoa(binary) }
              const uploaded = options.uploadImage ? await options.uploadImage({ fileId: capturedFileId, asset, bytes }) : { asset, preview: localPreview }
              validateImageAssetReference(uploaded.asset)
              if (!sameAssetReference(uploaded.asset, asset) || uploaded.preview.data !== localPreview.data) throw new Error(canvasCopy.unsupportedImage)
              validateAssetPreview(uploaded.asset, uploaded.preview)
              return { asset: uploaded.asset, preview: uploaded.preview, nodeId: entry.nodeId, fillId: entry.fillId, sourceName: image.file.name || 'Image' }
            } finally { bitmap.close() }
          }
          const workers = Array.from({ length: Math.min(4, images.length) }, async () => {
            while (cursor < images.length) {
              const index = cursor++
              const entry = reserved[index]!
              try { results[index] = { staged: await stage(entry) } }
              catch (error) { results[index] = { failure: { name: entry.image.file.name, diagnostic: error instanceof Error ? error.message : canvasCopy.unsupportedImage } } }
            }
          })
          await Promise.all(workers)
          const current = backing.getState()
          const authorityChanged = generation !== capturedGeneration || current.file?.fileId !== capturedFileId || current.file?.revision !== capturedRevision || current.pageId !== capturedPageId || current.readOnly || persistenceBlocked || JSON.stringify(current.selection) !== JSON.stringify(capturedSelection)
          const failures = results.flatMap(result => result && 'failure' in result ? [result.failure] : [])
          if (authorityChanged || !current.file) return { inserted: [] as string[], failures: [...failures, ...results.flatMap((result, index) => result && 'staged' in result ? [{ name: images[index]!.file.name, diagnostic: 'The canvas changed before the images were ready.' }] : [])] }
          const staged = results.flatMap(result => result && 'staged' in result ? [result.staged] : [])
          if (!staged.length) return { inserted: [] as string[], failures }
          let plan: ReturnType<typeof planClipboardImageInsertion>
          try {
            const insertionIds = staged.flatMap(item => [item.nodeId, item.fillId])
            plan = planClipboardImageInsertion(current.file, current.pageId!, staged.map(item => item.asset), {
              center: capturedCenter,
              visibleSize: capturedVisibleSize,
              selection: current.selection,
              containSelectionAtCenter: Boolean(insertionPoint),
            }, () => insertionIds.shift()!, current.atoms)
          } catch (error) {
            const diagnostic = error instanceof Error ? error.message : canvasCopy.imageFailed
            return { inserted: [] as string[], failures: [...failures, ...staged.map(item => ({ name: item.sourceName, diagnostic }))] }
          }
          for (const item of staged) assetPreviewData.set(item.asset.id, validateAssetPreview(item.asset, item.preview))
          if (!execute(plan.command, [...plan.selection])) {
            for (const item of staged) assetPreviewData.delete(item.asset.id)
            return { inserted: [] as string[], failures: [...failures, ...staged.map(item => ({ name: item.asset.name, diagnostic: backing.getState().error ?? canvasCopy.imageFailed }))] }
          }
          return { inserted: [...plan.selection], failures }
        },
        /** Imports verified clipboard sidecars before attaching assets and nodes in one semantic history entry. */
        insertInternalClipboard: async (payload: InternalClipboardPayload, previews: InternalClipboardAssetPreviews, placement: InternalPastePlacement = {}, replaceGeometry?: InternalReplaceGeometry) => {
          const captured = backing.getState()
          if (!captured.file || !captured.pageId || captured.readOnly || persistenceBlocked) return { inserted: [] as string[], error: clipboardCopy.internalRejected }
          const capturedGeneration = generation
          const capturedFileId = captured.file.fileId
          const capturedRevision = captured.file.revision
          const capturedPageId = captured.pageId
          const capturedLayoutGeneration = captured.layoutGeneration
          const capturedSelection = [...captured.selection]
          const crossFile = payload.source.fileId !== capturedFileId
          const sourceAssets = payload.assets ?? {}
          const sourceIds = Object.keys(sourceAssets)
          type StagedAsset = Readonly<{ sourceId: string; asset: ImageAssetReference; preview: EditorAssetPreview }>
          const staged: StagedAsset[] = []
          try {
            const planFor = (file: FileDocument, pageId: string, selection: readonly string[], atoms: readonly Atom[], verifiedAssets: VerifiedCrossFileAssets) => replaceGeometry
              ? planValidatedInternalReplace(file, pageId, payload, selection, makeId, replaceGeometry, atoms, verifiedAssets)
              : planValidatedInternalPaste(file, pageId, payload, makeId, placement, selection, atoms, verifiedAssets)
            const reserved = new Set(Object.keys(captured.file.assets ?? {}))
            const prepared: Readonly<{ sourceId: string; asset: ImageAssetReference; bytes: Uint8Array; preview: EditorAssetPreview }>[] = []
            if (crossFile) {
              for (const sourceId of sourceIds) {
                const source = sourceAssets[sourceId]!
                const preview = previews[sourceId]
                if (!preview || preview.assetId !== sourceId || preview.sha256 !== source.sha256 || preview.mime !== source.mime) throw new Error('Cross-file image paste needs verified source bytes')
                const bytes = decodeAssetPreview(source, preview)
                const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer))].map(value => value.toString(16).padStart(2, '0')).join('')
                if (digest !== source.sha256) throw new Error('Cross-file image paste needs verified source bytes')
                let targetId = makeId()
                while (reserved.has(targetId)) targetId = makeId()
                reserved.add(targetId)
                const asset = validateImageAssetReference({ ...structuredClone(source), id: targetId })
                prepared.push({ sourceId, asset, bytes, preview: { assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data: preview.data } })
              }
              if (Object.keys(previews).some(id => !sourceAssets[id])) throw new Error('Cross-file image paste needs verified source bytes')
              const preflightAssets = Object.fromEntries(prepared.map(item => [item.sourceId, item.asset])) as VerifiedCrossFileAssets
              planFor(captured.file, captured.pageId, captured.selection, captured.atoms, preflightAssets)
              for (const item of prepared) {
                const uploaded = options.uploadImage ? await options.uploadImage({ fileId: capturedFileId, asset: item.asset, bytes: item.bytes }) : { asset: item.asset, preview: item.preview }
                validateImageAssetReference(uploaded.asset)
                if (!sameAssetReference(uploaded.asset, item.asset) || uploaded.preview.data !== item.preview.data) throw new Error('Cross-file image paste needs verified source bytes')
                validateAssetPreview(uploaded.asset, uploaded.preview)
                staged.push({ sourceId: item.sourceId, asset: uploaded.asset, preview: uploaded.preview })
              }
            }
            const current = backing.getState()
            const authorityChanged = generation !== capturedGeneration || current.file?.fileId !== capturedFileId || current.file?.revision !== capturedRevision
              || current.pageId !== capturedPageId || current.layoutGeneration !== capturedLayoutGeneration || current.readOnly || persistenceBlocked
              || JSON.stringify(current.selection) !== JSON.stringify(capturedSelection)
            if (authorityChanged || !current.file || !current.pageId) throw new Error(clipboardCopy.canvasChanged)
            const verifiedAssets = Object.fromEntries(staged.map(item => [item.sourceId, item.asset]))
            const plan = planFor(current.file, current.pageId, current.selection, current.atoms, verifiedAssets)
            for (const item of staged) assetPreviewData.set(item.asset.id, validateAssetPreview(item.asset, item.preview))
            if (!execute(plan.command, [...plan.selection])) {
              for (const item of staged) assetPreviewData.delete(item.asset.id)
              throw new Error(backing.getState().error ?? clipboardCopy.internalRejected)
            }
            return { inserted: [...plan.selection], error: null }
          } catch (error) {
            for (const item of staged) assetPreviewData.delete(item.asset.id)
            return { inserted: [] as string[], error: error instanceof Error ? error.message : clipboardCopy.internalRejected }
          }
        },
        remove: (assetId: string) => execute({ type: 'asset.detach', assetId }),
      },
      /** Draws a primitive at parent-local coordinates (world when no parent). */
      insertCanvas: (kind: PrimitiveKind, bounds: { x: number; y: number; parentId?: string | null } & Partial<Pick<CanvasBounds, 'width' | 'height'>>) => {
        const state = backing.getState()
        if (!state.file || !state.pageId) return false
        const id = makeId()
        const size = canvasElementSizes[kind]
        const parentId = bounds.parentId ?? root(state)!
        const textMode = options.editorMode?.() ?? 'light'
        const parent = state.file.nodes[parentId]
        const parentDisplay = parent && parent.type !== 'root' ? parent.layout?.container?.display : undefined
        const layout: NodeLayout | undefined = parentDisplay && parentDisplay !== 'freeform' ? { item: { position: { mode: 'flow' } } } : undefined
        const item: FileNode = { id, type: kind, name: elementNames[kind], styles: { relativeTransform: [1, 0, 0, 1, Math.round(bounds.x), Math.round(bounds.y)], width: bounds.width === undefined ? size.width : Math.max(1, Math.round(bounds.width)), height: bounds.height === undefined ? size.height : Math.max(1, Math.round(bounds.height)), ...(kind === 'frame' ? { overflow: 'clip' as const } : {}) }, appearance: defaultAppearance(kind, makeId, textMode), ...(kind === 'text' ? { text: 'Text', ...legacyTextProperties() } : {}), ...(layout ? { layout } : {}) }
        return execute({ type: 'node.insert', node: item, placement: { parentId } }, [id])
      },
      /** Creates Paper-style empty text and starts one grouped creation/edit transaction. */
      insertCanvasText: (intent: CanvasCreationIntent, bounds: { x: number; y: number; parentId?: string | null } & Partial<Pick<CanvasBounds, 'width' | 'height'>>) => {
        const state = backing.getState()
        if (!state.file || !state.pageId || textSession) return false
        if (intent === 'drag' && (bounds.width === undefined || bounds.height === undefined)) return false
        const id = makeId()
        const parentId = bounds.parentId ?? root(state)!
        const textMode = options.editorMode?.() ?? 'light'
        const parent = state.file.nodes[parentId]
        const parentDisplay = parent && parent.type !== 'root' ? parent.layout?.container?.display : undefined
        const layout: NodeLayout | undefined = parentDisplay && parentDisplay !== 'freeform' ? { item: { position: { mode: 'flow' } } } : undefined
        const textSizing: TextSizing = intent === 'point'
          ? { width: { mode: 'fit' }, height: { mode: 'fit' } }
          : { width: { mode: 'fixed' }, height: { mode: 'fixed' } }
        const item: FileNode = {
          id,
          type: 'text',
          name: elementNames.text,
          text: '',
          textStyle: legacyTextProperties().textStyle,
          textSizing,
          styles: {
            relativeTransform: [1, 0, 0, 1, Math.round(bounds.x), Math.round(bounds.y)],
            // The schema requires positive measured bounds. Fit/Fit, not this floor, owns point-text layout.
            width: intent === 'point' ? 1 : Math.max(1, Math.round(bounds.width!)),
            height: intent === 'point' ? 1 : Math.max(1, Math.round(bounds.height!)),
          },
          appearance: defaultAppearance('text', makeId, textMode),
          ...(layout ? { layout } : {}),
        }
        const placement = { parentId }
        const insert: Extract<FileCommand, { type: 'node.insert' }> = { type: 'node.insert', node: item, placement }
        const creation = { before: currentView(), pastBefore: [...past], futureBefore: [...future], insert }
        const sessionId = makeId()
        textSession = {
          sessionId,
          nodeId: id,
          before: creation.before,
          beforeText: '',
          pastBefore: creation.pastBefore,
          futureBefore: creation.futureBefore,
          visibleCanUndo: creation.pastBefore.length > 0,
          visibleCanRedo: creation.futureBefore.length > 0,
          creation,
        }
        try {
          const projection = applyFileCommandWithHistory(state.file, insert, state.atoms, { allowUnavailableBindings: true })
          if (!commitWithPersistence(projection, [id]).committed) { textSession = null; return false }
          selectionAnchor = id
          return true
        } catch (error) { textSession = null; return fail(error) }
      },
      /** Inserts one clipboard text node at the visible canvas center as one semantic history step. */
      insertClipboardText: (text: string, insertionPoint?: Point) => {
        const state = backing.getState()
        if (!state.file || !state.pageId || textSession || !text || text.length > 10_000) return false
        const id = makeId()
        const textMode = options.editorMode?.() ?? 'light'
        const center = insertionPoint ?? componentInsertionPoint(state)
        const candidate: FileNode = {
          id,
          type: 'text',
          name: elementNames.text,
          text,
          textStyle: legacyTextProperties().textStyle,
          textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } },
          styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 },
          appearance: defaultAppearance('text', makeId, textMode),
        }
        const parent = nearestCompatiblePasteParent(state.file, state.pageId, state.selection, [candidate], state.atoms, center)
        const parentId = parent.id
        const parentWorld = parent.type === 'root' ? identityTransform : nodeWorldTransform(state.file, parentId)
        const inverse = invertTransform(parentWorld)
        if (!inverse) return false
        const local = transformPoint(inverse, center)
        const display = parent.type === 'root' ? 'freeform' : parent.layout?.container?.display ?? 'freeform'
        const node: FileNode = {
          ...candidate,
          styles: { ...candidate.styles, relativeTransform: [1, 0, 0, 1, Math.round(local.x), Math.round(local.y)] },
          ...(display === 'freeform' ? {} : { layout: { item: { position: { mode: 'flow' as const } } } }),
        }
        return execute({ type: 'node.insert', node, placement: { parentId } }, [id])
      },
      /** Reparents a primitive (null parent means the page root) keeping its world position. */
      reparent: (nodeId: string, parentId: string | null) => {
        const state = backing.getState()
        if (!state.file || !isPrimitive(state.file.nodes[nodeId]) || parentId === nodeId || isProtectedInstanceDescendant(state.file, nodeId)) return false
        const target = parentId ?? root(state)!
        if (parentId && state.file.nodes[parentId]?.type !== 'frame') return false
        return execute({ type: 'node.reparent', nodeId, placement: { parentId: target }, preserveWorldPosition: true })
      },
      /** Plans one final gesture against its captured authority fences, then commits that exact batch once. */
      commitGesture: (snapshot: GestureCommandSnapshot, intents: readonly GestureFinalIntent[], bindPersistence?: GesturePersistenceBinder): PersistenceCommit => {
        const strict = intents.some(intent => intent?.kind === 'resize' || intent?.kind === 'paper-flow-terminal')
        const flow = intents.some(intent => intent?.kind === 'paper-flow-terminal')
        if (!gestureCommitAllowed(snapshot, strict)) return noPersistenceCommit
        const plan = planGestureCommand(snapshot, intents, () => makeId())
        if (!plan || !gestureCommitAllowed(snapshot, strict)) return noPersistenceCommit
        let plannedCommand: FileCommand
        try { plannedCommand = freezeData(structuredClone(plan.command)) }
        catch { return noPersistenceCommit }
        let persistenceIntent: EditorPersistenceIntent | undefined
        if (bindPersistence) {
          try {
            const bound = bindPersistence(plannedCommand)
            if (!exactBoundPersistenceIntent(bound, plannedCommand, flow)) return noPersistenceCommit
            persistenceIntent = bound
          } catch { return noPersistenceCommit }
          if (!gestureCommitAllowed(snapshot, strict)) return noPersistenceCommit
        }
        return executeWithPersistence(plannedCommand, [...plan.selection], undefined, true, plannedCommand, strict ? () => gestureCommitAllowed(snapshot, true) : undefined, persistenceIntent)
      },
      /** Commits freeform moves in world coordinates as one history step. Primitives may change parent; component roots leave the host flow. */
      commitMove: (moves: MoveCommit[], settings: { duplicate?: boolean } = {}): PersistenceCommit => {
        const state = backing.getState()
        if (!state.file || moves.some(move => isProtectedInstanceDescendant(state.file!, move.id))) return noPersistenceCommit
        const commands: FileCommand[] = []
        const movedIds: Record<string, string> = {}
        if (settings.duplicate) {
          const moving = new Set(moves.map(move => move.id))
          for (const move of moves) {
            if (!state.file.nodes[move.id] || ancestorsOf(state.file, move.id).some(id => moving.has(id))) continue
            const subtree = [move.id, ...descendantsOf(state.file, move.id)]
            const ids = Object.fromEntries(subtree.map(id => [id, makeId()]))
            commands.push({ type: 'node.duplicate', nodeId: move.id, ids })
            commands.push(...duplicatedInstanceCommands(state.file, ids))
            movedIds[move.id] = ids[move.id]!
          }
        }
        for (const move of moves) {
          const item = state.file.nodes[move.id]
          if (!item) continue
          const movedId = movedIds[move.id] ?? move.id
          if (isPrimitive(item)) {
            const parentId = move.parentId === undefined ? parentOf(move.id) : move.parentId
            if (parentId && parentId !== root(state) && state.file.nodes[parentId]?.type !== 'frame') continue
            const target = parentId ?? root(state)!
            const relativeTransform = movedPrimitiveMatrix(state.file, move.id, target, Math.round(move.x), Math.round(move.y))
            if (!relativeTransform) continue
            if (parentOf(move.id) !== target) commands.push({ type: 'node.reparent', nodeId: movedId, placement: { parentId: target } })
            commands.push({ type: 'node.setStyles', nodeId: movedId, styles: { relativeTransform } })
            continue
          }
          if (item.type !== 'component' || !isRootChild(move.id)) continue
          // Leaving the host flow bakes the measured width so the component keeps the size it had (Paper: capture sizing intent before layout changes).
          const placement = legacyLayout(item.layout)
          const baked = placement.mode === 'absolute' || placement.width !== undefined || move.width === undefined ? {} : { width: Math.max(1, Math.round(move.width)) }
          commands.push({ type: 'node.setLayout', nodeId: movedId, layout: layoutFromLegacy({ ...placement, ...baked, mode: 'absolute', x: Math.round(move.x), y: Math.round(move.y) }, item.layout) })
        }
        return executeBatchWithPersistence(commands, moves.map(move => movedIds[move.id] ?? move.id))
      },
      // Pages ------------------------------------------------------------------------------------------------------
      /** Creates a page. With `activate: false` the open page stays put so a router can push the new page as its own history entry. */
      createPage: (settings: { activate?: boolean } = {}): string | null => {
        const state = backing.getState()
        if (!state.file || !state.pageId) return null
        const used = new Set(state.file.pages.map(page => page.name)); let sequence = 1
        while (used.has(`Page ${sequence}`)) sequence += 1
        const page = { id: makeId(), name: `Page ${sequence}`, rootNodeId: makeId() }
        return execute({ type: 'page.create', page }, [], settings.activate === false ? state.pageId : page.id) ? page.id : null
      },
      renamePage: (pageId: string, name: string) => { const next = name.trim(); return next ? execute({ type: 'page.rename', pageId, name: next }) : false },
      setPageBackground: (pageId: string, background: ColorValue | null) => execute({ type: 'page.setBackground', pageId, background }),
      deletePage: (pageId: string) => {
        const state = backing.getState()
        if (!state.file || state.file.pages.length < 2) return false
        const index = state.file.pages.findIndex(page => page.id === pageId)
        const fallback = state.file.pages[index === 0 ? 1 : index - 1]!.id
        const page = state.file.pages[index]
        if (!page) return false
        const removed = new Set(descendantsOf(state.file, page.rootNodeId))
        const commands = semanticCleanupCommands(state.file, removed)
        commands.push({ type: 'page.delete', pageId })
        return execute(commands.length === 1 ? commands[0]! : { type: 'batch', commands }, [], state.pageId === pageId ? fallback : state.pageId!)
      },
      duplicatePage: (pageId: string): string | null => {
        const state = backing.getState()
        const source = state.file?.pages.find(page => page.id === pageId)
        if (!state.file || !source) return null
        const ids = Object.fromEntries(descendantsOf(state.file, source.rootNodeId).map(id => [id, makeId()]))
        const page = { id: makeId(), name: uniqueName(state.file.pages.map(candidate => candidate.name), `${source.name} copy`), rootNodeId: makeId() }
        const commands: FileCommand[] = [{ type: 'page.duplicate', pageId, page, ids }, ...duplicatedInstanceCommands(state.file, ids)]
        return execute(commands.length === 1 ? commands[0]! : { type: 'batch', commands }, [], page.id) ? page.id : null
      },
      reorderPage: (pageId: string, index: number) => execute({ type: 'page.reorder', pageId, index }),
      // Theme ------------------------------------------------------------------------------------------------------
      theme: {
        /** Imports repository CSS properties as source-backed color tokens in one undo step. Existing properties are skipped. */
        importSourceTokens: (imports: readonly SourceTokenImport[]): number => {
          const state = backing.getState()
          if (!state.file) return 0
          const existing = new Set(Object.values(state.file.theme.tokens).flatMap(token => token.value.kind === 'source' ? [token.value.property] : []))
          const pending = new Set<string>()
          const usedNames = [...Object.values(state.file.theme.tokens).map(token => token.name)]
          let orderKey = lastTokenKey(state.file)
          const commands: FileCommand[] = []
          for (const item of imports) {
            if (!/^--[A-Za-z0-9_-]+$/.test(item.property) || existing.has(item.property) || pending.has(item.property)) continue
            const name = uniqueName(usedNames, item.name.trim() || item.property.slice(2))
            usedNames.push(name)
            orderKey = orderKeyBetween(orderKey, null)
            commands.push({ type: 'token.create', token: { id: makeId(), type: 'color', name, orderKey, value: { kind: 'source', property: item.property, fallback: item.fallback } } })
            pending.add(item.property)
          }
          return executeBatch(commands) ? commands.length : 0
        },
        createToken: (typeOrColor: TokenType | Color = 'color', fallbackColor: Color = { kind: 'hex', hex: '#d9d9d9' }): string | null => {
          const state = backing.getState()
          if (!state.file) return null
          const type: TokenType = typeof typeOrColor === 'string' ? typeOrColor : 'color'
          const color = typeof typeOrColor === 'string' ? fallbackColor : typeOrColor
          const defaults: Record<Exclude<TokenType, 'color'>, string | number> = {
            opacity: 0.5,
            radius: '8px',
            spacing: '8px',
            container: '1200px',
            breakpoint: '768px',
            fontFamily: 'Inter',
            fontWeight: 400,
            fontSize: '16px',
            lineHeight: 1.5,
            letterSpacing: '0px',
          }
          const base = { id: makeId(), name: tokenName(state.file, 'Untitled'), orderKey: orderKeyBetween(lastTokenKey(state.file), null) }
          const token: FileToken = type === 'color' ? { ...base, type, value: { kind: 'literal', color } } : { ...base, type, value: { kind: 'literal', value: defaults[type] } }
          return execute({ type: 'token.create', token }) ? token.id : null
        },
        renameToken: (tokenId: string, name: string) => { const next = name.trim(); return next ? execute({ type: 'token.rename', tokenId, name: next }) : false },
        setTokenValue: (tokenId: string, value: TokenValue) => execute({ type: 'token.setValue', tokenId, value }),
        setTokenDescription: (tokenId: string, description: string) => execute({ type: 'token.setDescription', tokenId, description }),
        duplicateToken: (tokenId: string): string | null => {
          const state = backing.getState()
          const source = state.file?.theme.tokens[tokenId]
          if (!state.file || !source) return null
          const newId = makeId()
          return execute({ type: 'token.duplicate', tokenId, newId, name: tokenName(state.file, `${source.name} copy`) }) ? newId : null
        },
        reorderToken: (tokenId: string, index: number) => execute({ type: 'token.reorder', tokenId, index }),
        /** Deletes tokens while keeping every bound color: references across all pages become the resolved literal. One undo step. */
        deleteTokens: (tokenIds: string[]) => execute({ type: 'token.delete', tokenIds, sources: sources() }),
        resolve: (tokenId: string): Color | null => { const state = backing.getState(); return state.file ? resolveToken(state.file.theme, tokenId, sources()) : null },
      },
    },
    handleKey: (event: KeyInput, platform: 'mac' | 'other' = 'other', scene?: Scene) => {
      const state = backing.getState()
      const command = platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey
      const key = event.key.toLowerCase()
      if (command && key === 'z') { event.shiftKey ? redo() : undo(); return true }
      if (command && key === 'y' && platform !== 'mac') { redo(); return true }
      if (command && key === 'd') { duplicate(); return true }
      if (command && key === 'a' && state.file && state.pageId) { setSelection(documentOrder(state.file, state.pageId)); return true }
      if (command && key === '0') { zoomAt(1); return true }
      if (command && (key === '=' || key === '+')) { zoomStep('in'); return true }
      if (command && key === '-') { zoomStep('out'); return true }
      if (plain && event.shiftKey && (key === '!' || key === '1')) { emit({ fitRequested: 'all' }); return true }
      if (plain && event.shiftKey && (key === '@' || key === '2')) { emit({ fitRequested: 'selection' }); return true }
      if (plain && (key === 'delete' || key === 'backspace')) { if (state.selection.length) deleteSelection(state.selection); return true }
      if (plain && key === 'escape') { if (textSession) cancelTextEditing(textSession.sessionId); else if (state.renaming) emit({ renaming: null }); else setSelection([]); return true }
      if (plain && !event.shiftKey && key === 'enter' && state.selection.length === 1 && state.file?.nodes[state.selection[0]!]?.type === 'text') { beginTextEditing(state.selection[0]!); return true }
      if (plain && key === 'enter' && state.selection.length && scene) { setSelection(event.shiftKey ? selectParents(scene, state.selection) : selectChildren(scene, state.selection)); return true }
      if (plain && key.startsWith('arrow') && state.selection.length) {
        const step = event.shiftKey ? nudgeStepLarge : nudgeStep
        nudge(key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0, scene)
        return true
      }
      if (event.altKey && (key === 'arrowup' || key === 'arrowdown') && state.selection.length === 1) { moveBy(state.selection[0]!, key === 'arrowup' ? -1 : 1); return true }
      if (plain && !event.shiftKey && (key === '+' || key === '=' || key === '-')) { zoomStep(key === '-' ? 'out' : 'in'); return true }
      if (plain && ['v', 'k', 'h', 'f', 'g', 's', 't', 'r', 'o', 'i'].includes(key)) { const tool: CanvasTool = key === 'v' ? 'move' : key === 'k' ? 'scale' : key === 'h' ? 'hand' : key === 'f' ? 'frame' : key === 'g' || key === 's' ? 'shader' : key === 't' ? 'text' : key === 'r' ? 'rectangle' : key === 'o' ? 'shape' : 'interact'; emit({ tool, transient: null }); options.onToolChange?.(tool); return true }
      return false
    },
    dispose: () => {
      generation++
      textSession = null
      persistenceRun = null
      rejectPersistenceChanges(pendingPersistenceChanges, new Error('The document store was disposed before the change was saved.'))
      pendingPersistenceChanges = []
      for (const stop of subscriptions) stop()
      assetPreviewData.clear()
      options = {}
    },
  }
}

export const documentStore = createDocumentStore()
