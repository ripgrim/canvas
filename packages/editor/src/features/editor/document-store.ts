import { applyFileCommand, applyFileCommandWithHistory, childrenOf, descendantsOf, pageRoot, resolveToken, validateFileCommand, validateFileDocument, worldPosition } from '@canvas/repo-engine/file-document'
import type { ColorToken, FileCommand, FileDocument, FileNode, NodePlacement, Paint, PrimitiveKind, PrimitiveStylePatch, PrimitiveStyles, SourcePalette, TokenValue } from '@canvas/repo-engine/file-document'
import { appearanceLimits, defaultFillColor, imageMimes, nextBorders, validateImageAssetReference } from '@canvas/repo-engine/appearance'
import { nodeAppearance } from '@canvas/repo-engine/file-document'
import type { Appearance, BlendMode, BorderSide, Borders, ColorValue, ImageAssetReference, ImageExtension, ImageMime, Outline, Stroke } from '@canvas/repo-engine/appearance'
import type { DocumentNodeLayout } from '@canvas/repo-engine/document'
import { layoutFromLegacy, legacyLayout } from '@canvas/repo-engine/layout'
import type { NodeLayout, SizingMode } from '@canvas/repo-engine/layout'
import { positionAbsolute, positionFlow, setAspectRatio, setAxisBound, setAxisLength, setAxisSizingMany, setInset, setSpacing, setZIndex } from './layout-commands'
import { createFlexCommands } from './layout-flex-commands'
import type { LayoutCommandContext } from './layout-flex-commands'
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
import { canvasCopy } from './canvas-copy'
import { canvasElementSizes } from './canvas-drawing'
import { prepareImageFile } from './image-import'
import type { CanvasBounds } from './canvas-drawing'
import { clampZoom, fitCamera, gridVisible, nudgeStep, nudgeStepLarge, screenToWorld, stepZoom, zoomAtPoint } from './canvas-math'
import type { Camera, Point, Rect, Size, SnapGuide } from './canvas-math'
import { selectChildren, selectParents } from './canvas-scene'
import type { Scene } from './canvas-scene'
import { createStore } from 'zustand/vanilla'
import type { EditorAssetPreview, EditorAssetUpload, EditorAssetUploadResult, EditorPersistenceIntent } from '../../capabilities'

export type Viewport = Camera
export type CanvasTool = 'move' | 'scale' | 'hand' | 'frame' | 'shader' | 'text' | 'rectangle' | 'shape' | 'interact'
/** Transient gesture state shared between the interaction layer and the HUD. Never persisted. */
export type CanvasTransient =
  | { kind: 'marquee'; rect: Rect }
  | { kind: 'move'; rects: Record<string, Rect>; offset: Point; guides: SnapGuide[]; targetFrameId: string | null; insertion: { axis: 'x' | 'y'; rect: Rect } | null }
  | { kind: 'resize'; rects: Record<string, Rect>; starts: Record<string, Rect>; appearances: Record<string, Appearance | undefined>; contentLocked: boolean }
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
export type ComponentInsertPoint = { x: number; y: number }
export type SourceTokenImport = Readonly<{ property: string; name: string; fallback: Color }>
export type PersistenceCommit = Readonly<{ committed: boolean; persistence: Promise<void> | null }>
type PersistenceReceipt = Readonly<{
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}>
type PendingPersistenceChange = Readonly<{ file: FileDocument; intent: EditorPersistenceIntent; receipt: PersistenceReceipt | null }>
type AssetPreviewData = Readonly<{ sha256: string; mime: ImageMime; data: string }>

function decodedByteLength(data: string): number {
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(canvasCopy.unsupportedImage)
  try { return atob(data).length } catch { throw new Error(canvasCopy.unsupportedImage) }
}

function validateAssetPreview(asset: ImageAssetReference, preview: EditorAssetPreview): AssetPreviewData {
  if (preview.assetId !== asset.id || preview.sha256 !== asset.sha256 || preview.mime !== asset.mime || decodedByteLength(preview.data) !== asset.bytes) throw new Error(canvasCopy.unsupportedImage)
  return { sha256: preview.sha256, mime: preview.mime, data: preview.data }
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
const defaultCamera: Viewport = { x: 0, y: 0, zoom: 1 }
const elementNames: Record<PrimitiveKind, string> = { frame: 'Frame', rectangle: 'Rectangle', shape: 'Shape', shader: 'Shader', text: 'Text' }
const literalColor = (hex: string) => ({ kind: 'literal' as const, color: { kind: 'hex' as const, hex } })
/** New nodes carry literal colors; the file theme never seeds tokens from editor chrome. Rectangle white is a product default. */
const defaultAppearance = (kind: PrimitiveKind, makeId: () => string): Appearance => {
  if (kind === 'shader') return { fills: [{ id: makeId(), type: 'gradient', shape: 'linear', angle: 135, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ id: makeId(), position: 0, color: literalColor('#685fff') }, { id: makeId(), position: 1, color: literalColor('#202124') }] }] }
  const hex = kind === 'frame' || kind === 'rectangle' ? '#ffffff' : kind === 'text' ? '#202124' : '#d9d9d9'
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

const emptyDocumentState = (): DocumentState => ({ file: null, pageId: null, atoms: [], selection: [], hover: null, renaming: null, transient: null, viewport: defaultCamera, viewportSize: { width: 0, height: 0 }, gridVisible: false, fitRequested: null, spaceHeld: false, tool: 'move', dirty: false, saving: false, error: null, blocked: false, readOnly: false, canUndo: false, canRedo: false, appearanceOverrides: null, layoutOverrides: null, layoutGeneration: 0 })

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
  const changed = (file: FileDocument, pageId: string, selection: string[], intent: EditorPersistenceIntent, trackPersistence = false) => {
    const receipt = trackPersistence && options.persist ? persistenceReceipt() : null
    pendingPersistenceChanges.push({ file, intent, receipt })
    const state = backing.getState()
    const pageChanged = pageId !== state.pageId
    emit({ file, pageId, selection, dirty: true, error: null, canUndo: past.length > 0, canRedo: future.length > 0 })
    if (pageChanged) options.onPageChange?.(pageId)
    options.onSelection?.(selection)
    options.onChange?.(file)
    void schedulePersistence()
    return receipt?.promise ?? null
  }
  const same = (left: FileDocument, right: FileDocument) => JSON.stringify({ ...left, revision: 0 }) === JSON.stringify({ ...right, revision: 0 })
  const commitWithPersistence = (projection: ReturnType<typeof applyFileCommandWithHistory>, selection: string[], pageId = backing.getState().pageId!, trackPersistence = false): PersistenceCommit => {
    const state = backing.getState()
    const next = projection.file
    if (state.readOnly) return noPersistenceCommit
    if (!permits(next)) return noPersistenceCommit
    if (same(next, state.file!)) return noPersistenceCommit
    const before = currentView()
    const page = next.pages.some(candidate => candidate.id === pageId) ? pageId : next.pages[0]!.id
    const nextSelection = selection.filter(id => selectable(next, page, id))
    past.push({ ...before, afterPageId: page, afterSelection: nextSelection, undo: projection.undo, redo: projection.redo })
    if (past.length > 100) past.shift()
    future = []
    const persistence = changed(next, page, nextSelection, { kind: 'commands', commands: [projection.redo] }, trackPersistence)
    return Object.freeze({ committed: true, persistence })
  }
  const fail = (error: unknown, title?: string) => report(error, title)
  /** Applies one semantic command (or batch) as one undo step. */
  const executeWithPersistence = (command: FileCommand, selection?: string[], pageId?: string, trackPersistence = false): PersistenceCommit => {
    const state = backing.getState()
    if (!state.file || persistenceBlocked) return noPersistenceCommit
    try { return commitWithPersistence(applyFileCommandWithHistory(state.file, command, state.atoms, { allowUnavailableBindings: true }), selection ?? state.selection, pageId, trackPersistence) }
    catch (error) { fail(error); return noPersistenceCommit }
  }
  const execute = (command: FileCommand, selection?: string[], pageId?: string) => executeWithPersistence(command, selection, pageId).committed
  const executeBatch = (commands: FileCommand[], selection?: string[]) => commands.length ? execute(commands.length === 1 ? commands[0]! : { type: 'batch', commands }, selection) : false
  const executeBatchWithPersistence = (commands: FileCommand[], selection?: string[]) => commands.length
    ? executeWithPersistence(commands.length === 1 ? commands[0]! : { type: 'batch', commands }, selection, undefined, true)
    : noPersistenceCommit
  const node = (id: string) => backing.getState().file?.nodes[id]
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
  const duplicate = (nodeId?: string) => {
    const state = backing.getState()
    if (!state.file || persistenceBlocked) return false
    const file = state.file
    const candidates = (nodeId ? [nodeId] : state.selection).filter(id => file.nodes[id] && file.nodes[id]!.type !== 'root')
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
      selection.push(ids[id]!)
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
    if (!state.file || !past.length || persistenceBlocked || state.readOnly) return false
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
    if (!state.file || !future.length || persistenceBlocked || state.readOnly) return false
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
    return execute({ type: 'node.delete', nodeIds: ids }, [])
  }
  const primitiveMove = (id: string, world: Point, parentId: string | null): FileCommand[] => {
    const state = backing.getState()
    const file = state.file!
    const target = parentId ?? root(state)!
    const parentWorld = target === root(state) ? { x: 0, y: 0 } : worldPosition(file, target)
    const commands: FileCommand[] = []
    if (parentOf(id) !== target) commands.push({ type: 'node.reparent', nodeId: id, placement: { parentId: target } })
    commands.push({ type: 'node.setStyles', nodeId: id, styles: { left: Math.round(world.x - parentWorld.x), top: Math.round(world.y - parentWorld.y) } })
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
      if (isPrimitive(item)) { commands.push({ type: 'node.setStyles', nodeId: id, styles: { left: item.styles.left + dx, top: item.styles.top + dy } }); continue }
      if (item.type !== 'component') continue
      const placement = legacyLayout(item.layout)
      if (placement.mode === 'absolute') { commands.push(placementCommand(item, { ...placement, x: placement.x + dx, y: placement.y + dy })); continue }
      const rect = scene?.byId.get(id)?.rect
      if (rect && isRootChild(id)) commands.push(placementCommand(item, { ...placement, ...(placement.width === undefined ? { width: Math.max(1, Math.round(rect.width)) } : {}), mode: 'absolute', x: Math.round(rect.x + dx), y: Math.round(rect.y + dy) }))
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
  const tokenName = (file: FileDocument, base: string) => uniqueName(Object.values(file.theme.tokens).map(token => token.name), base)
  const lastTokenKey = (file: FileDocument) => Object.values(file.theme.tokens).sort(compareOrder).at(-1)?.orderKey ?? null
  return {
    getSnapshot: backing.getState,
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
    setReadOnly: (readOnly: boolean) => { if (backing.getState().readOnly !== readOnly) emit({ readOnly, transient: null, renaming: null }) },
    clear: () => {
      generation++
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
          savedRevision = incoming.revision
          pendingPersistenceChanges = rebasePersistenceChanges(incoming, pendingPersistenceChanges, atoms)
          const rebased = pendingPersistenceChanges.at(-1)?.file ?? incoming
          const requested = settings.pageId ?? state.pageId
          const pageId = requested && rebased.pages.some(page => page.id === requested) ? requested : rebased.pages[0]!.id
          updateAssetPreviews()
          persistenceBlocked = false
          emit({ file: rebased, pageId, atoms, selection: state.selection.filter(id => selectable(rebased, pageId, id)), hover: null, renaming: null, transient: null, dirty: pendingPersistenceChanges.length > 0, error: null, blocked: false, canUndo: past.length > 0, canRedo: future.length > 0 })
          void schedulePersistence()
        } catch {
          persistenceBlocked = true
          emit({ atoms, blocked: true, error: canvasCopy.rebaseFailed })
          options.onError?.({ title: canvasCopy.saveFailed, message: canvasCopy.rebaseFailed })
        }
        return
      }
      generation++
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
      emit({ file: incoming, pageId, atoms, selection: state.selection.filter(id => selectable(incoming, pageId, id)), hover: null, renaming: null, transient: null, dirty: false, saving: false, error: null, blocked: false, canUndo: past.length > 0, canRedo: future.length > 0 })
    },
    /** Switches the open page: a view change, not a document change. Selection is page-scoped. */
    setPage: (pageId: string) => {
      const state = backing.getState()
      if (!state.file || state.pageId === pageId || !state.file.pages.some(page => page.id === pageId)) return false
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
      if (!state.file || nodeId && !selectable(state.file, state.pageId, nodeId)) return
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
      if (!state.file) return
      const next = [...new Set(nodeIds)].filter(id => selectable(state.file!, state.pageId, id))
      if (JSON.stringify(next) === JSON.stringify(state.selection)) return
      selectionAnchor = next[next.length - 1] ?? null
      setSelection(next)
    },
    setHover: (nodeId: string | null) => { if (backing.getState().hover !== nodeId) emit({ hover: nodeId }) },
    setRenaming: (nodeId: string | null) => emit({ renaming: nodeId }),
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
      /** Inserts a component instance under the page root or into a component slot. */
      insert: (componentId: string, target?: InsertTarget, props: Record<string, string | number | boolean> = {}) => {
        const state = backing.getState()
        const atom = state.atoms.find(item => item.componentId === componentId && item.status === 'bound')
        if (!atom) return fail(new Error(canvasCopy.componentUnavailable))
        if (!state.file || !state.pageId) return fail(new Error(canvasCopy.openFileForTools))
        const id = makeId()
        const defaults = componentDefaultProps(atom)
        return execute({ type: 'node.insert', node: { id, type: 'component', componentId, exportName: atom.exportName, props: { ...defaults, ...props } }, placement: placementFor(target, state) }, [id])
      },
      /** Inserts a root component at one deterministic world point. Slot targets retain their component-owned flow. */
      insertAt: (componentId: string, point: ComponentInsertPoint, target?: InsertTarget, props: Record<string, string | number | boolean> = {}) => {
        const state = backing.getState()
        const atom = state.atoms.find(item => item.componentId === componentId && item.status === 'bound')
        if (!atom) return fail(new Error(canvasCopy.componentUnavailable))
        if (!state.file || !state.pageId) return fail(new Error(canvasCopy.openFileForTools))
        const id = makeId()
        const defaults = componentDefaultProps(atom)
        const rootTarget = target?.parentId == null
        const layout = rootTarget ? layoutFromLegacy({ mode: 'absolute', x: Math.round(point.x), y: Math.round(point.y) }) : undefined
        return execute({ type: 'node.insert', node: { id, type: 'component', componentId, exportName: atom.exportName, props: { ...defaults, ...props }, ...(layout ? { layout } : {}) }, placement: placementFor(target, state) }, [id])
      },
      duplicate,
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
          if (!state.file || current?.type !== 'component') return false
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
        remove: (assetId: string) => execute({ type: 'asset.detach', assetId }),
      },
      /** Draws a primitive at parent-local coordinates (world when no parent). */
      insertCanvas: (kind: PrimitiveKind, bounds: { x: number; y: number; parentId?: string | null } & Partial<Pick<CanvasBounds, 'width' | 'height'>>) => {
        const state = backing.getState()
        if (!state.file || !state.pageId) return false
        const id = makeId()
        const size = canvasElementSizes[kind]
        const item: FileNode = { id, type: kind, name: elementNames[kind], styles: { left: Math.round(bounds.x), top: Math.round(bounds.y), width: bounds.width === undefined ? size.width : Math.max(1, Math.round(bounds.width)), height: bounds.height === undefined ? size.height : Math.max(1, Math.round(bounds.height)), ...(kind === 'frame' ? { overflow: 'clip' as const } : {}) }, appearance: defaultAppearance(kind, makeId), ...(kind === 'text' ? { text: 'Text' } : {}) }
        return execute({ type: 'node.insert', node: item, placement: { parentId: bounds.parentId ?? root(state)! } }, [id])
      },
      /** Reparents a primitive (null parent means the page root) keeping its world position. */
      reparent: (nodeId: string, parentId: string | null) => {
        const state = backing.getState()
        if (!state.file || !isPrimitive(state.file.nodes[nodeId]) || parentId === nodeId) return false
        const target = parentId ?? root(state)!
        if (parentId && state.file.nodes[parentId]?.type !== 'frame') return false
        return execute({ type: 'node.reparent', nodeId, placement: { parentId: target }, preserveWorldPosition: true })
      },
      /** Commits freeform moves in world coordinates as one history step. Primitives may change parent; component roots leave the host flow. */
      commitMove: (moves: MoveCommit[]): PersistenceCommit => {
        const state = backing.getState()
        if (!state.file) return noPersistenceCommit
        const commands: FileCommand[] = []
        for (const move of moves) {
          const item = state.file.nodes[move.id]
          if (!item) continue
          if (isPrimitive(item)) {
            const parentId = move.parentId === undefined ? parentOf(move.id) : move.parentId
            if (parentId && parentId !== root(state) && state.file.nodes[parentId]?.type !== 'frame') continue
            commands.push(...primitiveMove(move.id, { x: move.x, y: move.y }, parentId === root(state) ? null : parentId))
            continue
          }
          if (item.type !== 'component' || !isRootChild(move.id)) continue
          // Leaving the host flow bakes the measured width so the component keeps the size it had (Paper: capture sizing intent before layout changes).
          const placement = legacyLayout(item.layout)
          const baked = placement.mode === 'absolute' || placement.width !== undefined || move.width === undefined ? {} : { width: Math.max(1, Math.round(move.width)) }
          commands.push(placementCommand(item, { ...placement, ...baked, mode: 'absolute', x: Math.round(move.x), y: Math.round(move.y) }))
        }
        return executeBatchWithPersistence(commands)
      },
      /** Commits bounds and any image crop as one undo step. Mod-resize also holds direct freeform children in world space. */
      commitResize: (id: string, world: Rect, appearance?: Appearance, contentLocked = false, start?: Rect): PersistenceCommit => {
        const state = backing.getState()
        const item = state.file?.nodes[id]
        if (!state.file || !item) return noPersistenceCommit
        const batch: FileCommand[] = []
        if (isPrimitive(item)) {
          const parent = parentOf(id)
          const parentWorld = parent && parent !== root(state) ? worldPosition(state.file, parent) : { x: 0, y: 0 }
          batch.push({ type: 'node.setStyles', nodeId: id, styles: { left: Math.round(world.x - parentWorld.x), top: Math.round(world.y - parentWorld.y), width: Math.max(1, Math.round(world.width)), height: Math.max(1, Math.round(world.height)) } })
          if (contentLocked && start && item.type === 'frame') {
            const offset = { x: start.x - world.x, y: start.y - world.y }
            for (const childId of childrenOf(state.file, id)) {
              const child = state.file.nodes[childId]
              if (child && isPrimitive(child)) batch.push({ type: 'node.setStyles', nodeId: childId, styles: { left: Math.round(child.styles.left + offset.x), top: Math.round(child.styles.top + offset.y) } })
            }
          } else if (start && item.type === 'frame') {
            const scale = { x: world.width / start.width, y: world.height / start.height }
            for (const childId of descendantsOf(state.file, id)) {
              const child = state.file.nodes[childId]
              if (child && isPrimitive(child)) batch.push({ type: 'node.setStyles', nodeId: childId, styles: { left: Math.round(child.styles.left * scale.x), top: Math.round(child.styles.top * scale.y), width: Math.max(1, Math.round(child.styles.width * scale.x)), height: Math.max(1, Math.round(child.styles.height * scale.y)) } })
            }
          }
          if (appearance) batch.push({ type: 'node.setAppearance', nodeId: id, appearance })
          return executeBatchWithPersistence(batch)
        }
        if (item.type !== 'component') return noPersistenceCommit
        const layout = legacyLayout(item.layout)
        const next: DocumentNodeLayout = isRootChild(id)
          ? { ...layout, mode: 'absolute', x: Math.round(world.x), y: Math.round(world.y), width: Math.max(1, Math.round(world.width)), height: Math.max(1, Math.round(world.height)) }
          : { ...layout, width: Math.max(1, Math.round(world.width)), height: Math.max(1, Math.round(world.height)) }
        batch.push(placementCommand(item, next))
        if (appearance) batch.push({ type: 'node.setAppearance', nodeId: id, appearance })
        return executeBatchWithPersistence(batch)
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
        return execute({ type: 'page.delete', pageId }, [], state.pageId === pageId ? fallback : state.pageId!)
      },
      duplicatePage: (pageId: string): string | null => {
        const state = backing.getState()
        const source = state.file?.pages.find(page => page.id === pageId)
        if (!state.file || !source) return null
        const ids = Object.fromEntries(descendantsOf(state.file, source.rootNodeId).map(id => [id, makeId()]))
        const page = { id: makeId(), name: uniqueName(state.file.pages.map(candidate => candidate.name), `${source.name} copy`), rootNodeId: makeId() }
        return execute({ type: 'page.duplicate', pageId, page, ids }, [], page.id) ? page.id : null
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
        createToken: (color: Color = { kind: 'hex', hex: '#d9d9d9' }): string | null => {
          const state = backing.getState()
          if (!state.file) return null
          const token: ColorToken = { id: makeId(), type: 'color', name: tokenName(state.file, 'Untitled'), orderKey: orderKeyBetween(lastTokenKey(state.file), null), value: { kind: 'literal', color } }
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
      if (plain && key === 'escape') { if (state.renaming) emit({ renaming: null }); else setSelection([]); return true }
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
