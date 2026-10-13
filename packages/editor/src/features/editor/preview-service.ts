import { acceptPreviewCommand, acceptPreviewEvent, isPreviewAssets, isPreviewDocument, previewAssetByteLimit, previewImageMimes, protocolVersion } from '@canvas/preview-runtime/protocol'
import type { PreviewAsset, PreviewCamera, PreviewCommand, PreviewDocument, PreviewEvent, PreviewFlowDragSourceFence, PreviewFlowDragTransaction, PreviewPresentationFence } from '@canvas/preview-runtime/protocol'
type PreviewGeometryItem = Extract<PreviewEvent, { type: 'geometry' }>['items'][number]
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import type { PreviewPageDocument } from '@canvas/repo-engine/file-preview'
import { pageRoot } from '@canvas/repo-engine/file-document'
import type { Appearance, FileDocument } from '@canvas/repo-engine/file-document'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import { editorStore } from './store'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import type { MeasuredNode } from './scene-geometry'
import { collaborationService } from '../collaboration/collaboration-service'
import type { RemoteFlowPresentationKey, RemoteFlowPreviewBridge } from '../collaboration/flow-drag-relay'
import { previewResizePresentation, previewTransientMoves } from './preview-transient'
import type { PreviewTransientMove } from './preview-transient'
export { previewTransientMoves } from './preview-transient'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { ResizePresentation } from './resize-projection'
import type { FlowDragPresentation } from './flow-drag-presentation'
import { wheelPanDelta, wheelZoomFactor } from './canvas-math'
import { activeDesignTheme, normalizeCssColor, previewThemeMessage, themeProjectionContext } from './design-theme'
import { createFrameQueue } from './frame-queue'
import { previewCameraStore } from './preview-camera-store'
export { normalizeCssColor }

export type PreviewResizeSample = Readonly<{
  presentation: ResizePresentation
  start: GestureAuthoritySnapshot['start']
  interactionId: string
  sampleSequence: number
  pageRootNodeId: string
}>

export type PreviewCommittedDocumentReceipt = Readonly<{
  generation: number
  fileId: string
  pageId: string
  documentRevision: number
  layoutGeneration: number
  afterMeasurementRevision: number
}>

export type PreviewCommittedDocumentHandoff = Readonly<{
  commit: Readonly<{ committed: boolean }>
  committedFile: FileDocument | null
  start: GestureAuthoritySnapshot['start']
  interactionId: string
  sampleSequence: number
}>

export type PreviewFlowDragRetirement = Readonly<{
  interactionId: string
  gestureGeneration: number
  sequence: number
  sourceFence: PreviewFlowDragSourceFence
}>

export type PreviewCommittedFlowDragHandoff = Readonly<{
  commit: Readonly<{ committed: boolean }>
  committedFile: FileDocument | null
  terminalPresentation: FlowDragPresentation
}>

export type PreviewCommittedFlowDragReceipt = Readonly<PreviewCommittedDocumentReceipt & {
  interactionId: string
  gestureGeneration: number
  terminalSequence: number
  sourceFence: PreviewFlowDragSourceFence
}>

type PreviewEnvelope = Readonly<{ channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number }>
type FlowDragWireCommand = Readonly<Extract<PreviewCommand, { type: 'apply-flow-drag-transaction' }>>
type CommittedDocumentWireCommand = Readonly<Extract<PreviewCommand, { type: 'set-document' }>>
type CommittedLayoutWireCommand = Readonly<Extract<PreviewCommand, { type: 'set-layout' }>>
type ProjectedAuthority = Readonly<{
  target: Window
  origin: string
  generation: number
  fileId: string
  pageId: string
  pageRootNodeId: string
  documentRevision: number
  layoutGeneration: number
}>
type CommittedProjectionRetry = Readonly<{
  target: Window
  origin: string
  envelope: PreviewEnvelope
  sourceFile: FileDocument
  pageId: string
  pageRootNodeId: string
  layoutGeneration: number
  document: PreviewDocument
  theme: ReturnType<typeof previewThemeMessage>
  layout: NonNullable<ReturnType<typeof projectPreviewPage>>['layout']
  retainedMoves: readonly PreviewTransientMove[]
  signature: string
}>

type FlowDragPublication = Readonly<{
  target: Window
  origin: string
  envelope: PreviewEnvelope
  transaction: PreviewFlowDragTransaction
  signature: string
}>

type FlowDragCommittedProjection = Readonly<{
  publication: FlowDragPublication
  sourceFile: FileDocument
  pageId: string
  pageRootNodeId: string
  layoutGeneration: number
  committedDocument: PreviewDocument
  committedDocumentCommand: CommittedDocumentWireCommand
  committedLayoutCommand: CommittedLayoutWireCommand
  handoffCommand: FlowDragWireCommand
  signature: string
  receipt: PreviewCommittedFlowDragReceipt
}>

const sameGestureStart = (left: GestureAuthoritySnapshot['start'], right: GestureAuthoritySnapshot['start']) => left.fileId === right.fileId
  && left.fileRevision === right.fileRevision
  && left.documentRevision === right.documentRevision
  && left.layoutGeneration === right.layoutGeneration
  && left.measurementRevision === right.measurementRevision

function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true
  const object = value as object
  if (seen.has(object)) return true
  if (!Object.isFrozen(object)) return false
  seen.add(object)
  return Reflect.ownKeys(object).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    return Boolean(descriptor && 'value' in descriptor && deeplyFrozen(descriptor.value, seen))
  })
}

const sameFlowFence = (left: PreviewFlowDragSourceFence, right: PreviewFlowDragSourceFence) => left.fileId === right.fileId
  && left.fileRevision === right.fileRevision
  && left.measurementRevision === right.measurementRevision
  && left.documentRevision === right.documentRevision
  && left.layoutGeneration === right.layoutGeneration
  && left.pageId === right.pageId
  && left.pageRootId === right.pageRootId

const flowKeyId = (interactionId: string, gestureGeneration: number) => `${interactionId}\u0000${gestureGeneration}`

function exactDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor)
  }) && ownKeys.every(key => typeof key === 'string' && keys.includes(key))
}

function validFlowRetirement(value: unknown): value is PreviewFlowDragRetirement {
  return exactDataRecord(value, ['interactionId', 'gestureGeneration', 'sequence', 'sourceFence'])
    && typeof value.interactionId === 'string' && value.interactionId.length > 0
    && Number.isSafeInteger(value.gestureGeneration) && (value.gestureGeneration as number) >= 0
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0
    && exactDataRecord(value.sourceFence, ['fileId', 'fileRevision', 'measurementRevision', 'documentRevision', 'layoutGeneration', 'pageId', 'pageRootId'])
}

/** A gesture's live appearance preview rides on a shallow copy of the file; the authoritative file is untouched until commit. */
function withOverrides(file: FileDocument, overrides: Record<string, Appearance | null> | null, layouts: Record<string, NodeLayout | null> | null): FileDocument {
  if ((!overrides || !Object.keys(overrides).length) && (!layouts || !Object.keys(layouts).length)) return file
  const nodes = { ...file.nodes }
  for (const [nodeId, appearance] of Object.entries(overrides ?? {})) {
    const node = nodes[nodeId]
    if (!node || node.type === 'root') continue
    const { appearance: _current, ...rest } = node
    nodes[nodeId] = (appearance ? { ...rest, appearance } : rest) as typeof node
  }
  for (const [nodeId, layout] of Object.entries(layouts ?? {})) {
    const node = nodes[nodeId]
    if (!node || node.type === 'root') continue
    const { layout: _current, ...rest } = node
    nodes[nodeId] = layout ? { ...rest, layout } : rest
  }
  return { ...file, nodes }
}

/** Measured preview geometry arrives in preview-local pixels; the editor keeps world rectangles. */
export function unprojectGeometry(items: PreviewGeometryItem[], camera: PreviewCamera, documentRevision: number, layoutGeneration: number): Record<string, MeasuredNode> {
  const measured: Record<string, MeasuredNode> = {}
  const unproject = (bounds: { x: number; y: number; width: number; height: number }) => ({ x: (bounds.x - camera.width / 2 - camera.x) / camera.zoom, y: (bounds.y - camera.height / 2 - camera.y) / camera.zoom, width: bounds.width / camera.zoom, height: bounds.height / camera.zoom })
  for (const item of items) {
    const rect = unproject(item.bounds)
    const worldAabb = unproject(item.worldAabb)
    // Computed-style measurements (tracks, gaps, padding, transform) are layout pixels, which are world units already.
    measured[item.instanceId] = { ...(item.source === 'component' ? { componentId: item.componentId } : { canvasKind: item.canvasKind }), documentRevision, layoutGeneration, rect, worldAabb, ...(item.source === 'component' && item.theme ? { theme: item.theme } : {}), ...(item.box ? { box: item.box } : {}), ...(item.offset ? { offset: item.offset } : {}), ...(item.offsetParentNodeId !== undefined ? { offsetParentNodeId: item.offsetParentNodeId } : {}), ...(item.offsetParentToRoot ? { offsetParentToRoot: item.offsetParentToRoot } : {}), ...(item.source === 'component' && item.offsetParentInstanceId !== undefined ? { offsetParentInstanceId: item.offsetParentInstanceId } : {}), ...(item.source === 'component' && item.parentInstanceId !== undefined ? { parentInstanceId: item.parentInstanceId } : {}), ...(item.directChild !== undefined ? { directChild: item.directChild } : {}), ...(item.transform ? { transform: item.transform } : {}), ...(item.source === 'component' && item.layout ? { layout: item.layout } : {}), ...(item.grid ? { grid: item.grid } : {}), ...(item.source === 'canvas' && item.canvasKind === 'text' && item.text ? { text: item.text } : {}) }
  }
  return measured
}

export function geometryMatchesProjection(geometry: { documentRevision: number; layoutGeneration?: number }, document: { revision: number } | null, layoutGeneration: number): geometry is { documentRevision: number; layoutGeneration: number } {
  return document !== null && geometry.documentRevision === document.revision && geometry.layoutGeneration === layoutGeneration
}

export class PreviewAssetHydrationError extends Error {
  constructor(message: string) { super(message); this.name = 'PreviewAssetHydrationError' }
}

const decodedBase64Bytes = (data: string) => data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

/** Hydrates reference-only current-schema assets for the isolated renderer or fails before a fill can disappear. */
export function hydratePreviewDocument(document: PreviewPageDocument, resolve: (assetId: string) => { mime: string; data: string } | null): PreviewDocument {
  const supported = new Set<PreviewAsset['mime']>(previewImageMimes)
  const isPreviewMime = (mime: string): mime is PreviewAsset['mime'] => supported.has(mime as PreviewAsset['mime'])
  const entries = Object.entries(document.assets ?? {}).map(([assetId, reference]) => {
    if (reference.bytes > previewAssetByteLimit) throw new PreviewAssetHydrationError(`Image "${reference.name}" exceeds the preview transfer limit. Reimport it to create a preview-safe copy.`)
    const asset = resolve(assetId)
    if (!asset) throw new PreviewAssetHydrationError(`Image "${reference.name}" is unavailable in this session. Reattach it to preview this file.`)
    if (!isPreviewMime(asset.mime) || asset.mime !== reference.mime) throw new PreviewAssetHydrationError(`Image "${reference.name}" has preview bytes that do not match its file reference. Reattach it to preview this file.`)
    return [assetId, { mime: asset.mime, data: asset.data }] as const
  })
  const assets: Record<string, PreviewAsset> = Object.fromEntries(entries)
  if (!isPreviewAssets(assets)) throw new PreviewAssetHydrationError('One or more image previews exceed the runtime transfer limits. Reimport the affected image.')
  for (const [assetId, reference] of Object.entries(document.assets ?? {})) {
    if (decodedBase64Bytes(assets[assetId]!.data) !== reference.bytes) throw new PreviewAssetHydrationError(`Image "${reference.name}" has incomplete preview bytes. Reattach it to preview this file.`)
  }
  const { assets: _assets, ...rest } = document
  const hydrated: PreviewDocument = { ...rest, ...(Object.keys(assets).length ? { assets } : {}) }
  if (!isPreviewDocument(hydrated)) throw new PreviewAssetHydrationError('The image preview message exceeds the runtime limits. Reimport the affected image.')
  return hydrated
}

/**
 * Projects the open page of the file onto the preview iframe: resolved CSS fills, component slots, layout, selection,
 * camera, and the file's design preview theme. Editor appearance never enters here.
 */
export function createPreviewConnection(options: { resolveAsset?: (assetId: string) => { mime: string; data: string } | null } = {}) {
  const resolveAsset = options.resolveAsset ?? documentStore.assetPreview
  let target: Window | null = null
  let listening = false
  let signature = ''
  let cameraSignature = ''
  let cameraSequence = 0
  let appliedCameraSequence = -1
  const sentCameras = new Map<number, PreviewCamera>()
  let transientSignature = '[]'
  let strictPresentationSignature = ''
  let strictPresentationContext: Readonly<{
    target: Window
    origin: string
    envelope: PreviewEnvelope
    interactionId: string
    sampleSequence: number
    fence: Readonly<PreviewPresentationFence>
    start: GestureAuthoritySnapshot['start']
    fileId: string
    pageId: string
    pageRootNodeId: string
  }> | null = null
  const strictPresentationSequences = new Map<string, Readonly<{ sequence: number; signature: string }>>()
  const flowDragSequences = new Map<string, Readonly<{ sequence: number; signature: string; operation: 'publish' | 'handoff' | 'tombstone' }>>()
  const flowDragGenerations = new Map<string, number>()
  const remoteFlowDrags = new Map<string, FlowDragPublication>()
  const remoteFlowSequences = new Map<string, Readonly<{ sequence: number; signature: string; operation: 'publish' | 'tombstone' }>>()
  const remoteFlowGenerations = new Map<string, number>()
  let activeFlowDrag: FlowDragPublication | null = null
  let flowDragCommittedRetry: FlowDragCommittedProjection | null = null
  let flowDragCommittedHold: FlowDragCommittedProjection | null = null
  let projectedDocument: PreviewDocument | null = null
  let projectedAuthority: ProjectedAuthority | null = null
  let committedProjectionRetry: CommittedProjectionRetry | null = null
  let assetHydrationError: string | null = null
  let geometryGeneration: number | null = null
  let stopEditor: (() => void) | undefined
  let stopDocument: (() => void) | undefined
  let stopCollaboration: (() => void) | undefined
  /** Pointer input is already browser-coalesced. Forward every distinct sample without adding another frame of latency. */
  const publishTransient = (pending: { target: Window; origin: string; envelope: { channel: 'design-editor-preview'; version: typeof protocolVersion; generation: number }; items: PreviewTransientMove[]; signature: string }) => {
    if (target !== pending.target) return
    transientSignature = pending.signature
    pending.target.postMessage({ ...pending.envelope, type: 'set-transient-move', items: pending.items }, pending.origin)
  }
  const publishRotationPreview = (nodeId: string, rotationDelta: number): boolean => {
    const context = connectedContext()
    if (!context || !projectedDocument || !Number.isFinite(rotationDelta)) return false
    const items: PreviewTransientMove[] = [{ nodeId, dx: 0, dy: 0, rotationDelta }]
    const nextSignature = JSON.stringify(items)
    publishTransient({ target: context.target, origin: context.origin, envelope: context.envelope, items, signature: nextSignature })
    return true
  }
  const clearRotationPreview = (): boolean => {
    const context = connectedContext()
    transientSignature = '[]'
    if (!context) return false
    context.target.postMessage({ ...context.envelope, type: 'set-transient-move', items: [] }, context.origin)
    return true
  }
  const retireStrictPresentation = () => {
    strictPresentationSignature = ''
    strictPresentationContext = null
  }
  const clearStrictPresentation = () => {
    const active = strictPresentationContext
    retireStrictPresentation()
    if (!active) return true
    try { active.target.postMessage({ ...active.envelope, type: 'set-transient-presentations', presentations: [] }, active.origin); return true }
    catch { return false }
  }
  const clearStrictPresentationBeforeContextChange = () => {
    clearStrictPresentation()
  }
  const clearStrictPresentationIf = (expected: NonNullable<typeof strictPresentationContext>) => {
    if (strictPresentationContext !== expected) return false
    return clearStrictPresentation()
  }
  const postFlowDragTransaction = (publication: FlowDragPublication) => {
    publication.target.postMessage({ ...publication.envelope, type: 'apply-flow-drag-transaction', transaction: publication.transaction }, publication.origin)
  }
  const retirementFor = (presentation: FlowDragPresentation): PreviewFlowDragRetirement => Object.freeze({
    interactionId: presentation.identity.interactionId,
    gestureGeneration: presentation.identity.gestureGeneration,
    sequence: presentation.identity.sampleSequence,
    sourceFence: presentation.fence,
  })
  const retireFlowDrag = (retirement: PreviewFlowDragRetirement, expectedTarget: Window | null = target): boolean => {
    const active = activeFlowDrag
    if (!active || active.target !== expectedTarget) return false
    const key = active.transaction.key
    if (key.interactionId !== retirement.interactionId || key.gestureGeneration !== retirement.gestureGeneration
      || key.sequence !== retirement.sequence || !sameFlowFence(active.transaction.sourceFence, retirement.sourceFence)) return false
    const transaction: PreviewFlowDragTransaction = Object.freeze({
      key: Object.freeze({ ...key }),
      sourceFence: active.transaction.sourceFence,
      operation: Object.freeze({ kind: 'tombstone' as const }),
    })
    try {
      postFlowDragTransaction(Object.freeze({ ...active, transaction, signature: JSON.stringify(transaction) }))
      flowDragSequences.set(flowKeyId(key.interactionId, key.gestureGeneration), Object.freeze({ sequence: key.sequence, signature: JSON.stringify(transaction), operation: 'tombstone' }))
      activeFlowDrag = null
      flowDragCommittedHold = null
      if (flowDragCommittedRetry?.publication === active) flowDragCommittedRetry = null
      return true
    } catch {
      return false
    }
  }
  const retireFlowDragBeforeContextChange = () => {
    const active = activeFlowDrag
    if (active) retireFlowDrag({ interactionId: active.transaction.key.interactionId, gestureGeneration: active.transaction.key.gestureGeneration,
      sequence: active.transaction.key.sequence, sourceFence: active.transaction.sourceFence }, active.target)
    activeFlowDrag = null
    flowDragCommittedRetry = null
    flowDragCommittedHold = null
  }
  const remoteFlowKeyId = (key: RemoteFlowPresentationKey) => `${key.presenceId}\0${key.clientId}\0${key.leaseId}\0${key.localClaimGeneration}\0${key.reservationGeneration}\0${key.gestureGeneration}`
  const remoteFlowLineageId = (key: RemoteFlowPresentationKey, interactionId: string) => `${key.presenceId}\0${key.clientId}\0${key.leaseId}\0${key.localClaimGeneration}\0${key.reservationGeneration}\0${interactionId}`
  const retireRemoteFlowDrag = (key: RemoteFlowPresentationKey, presentation: FlowDragPresentation, terminalSampleSequence: number, expectedTarget: Window | null = target) => {
    const id = remoteFlowKeyId(key)
    const active = remoteFlowDrags.get(id)
    if (!active || active.target !== expectedTarget || terminalSampleSequence < active.transaction.key.sequence
      || active.transaction.key.interactionId !== presentation.identity.interactionId
      || active.transaction.key.gestureGeneration !== presentation.identity.gestureGeneration
      || active.transaction.key.sequence !== presentation.identity.sampleSequence
      || !sameFlowFence(active.transaction.sourceFence, presentation.fence)) return false
    const transaction: PreviewFlowDragTransaction = Object.freeze({
      key: active.transaction.key,
      sourceFence: active.transaction.sourceFence,
      operation: Object.freeze({ kind: 'tombstone' as const }),
    })
    try {
      postFlowDragTransaction(Object.freeze({ ...active, transaction, signature: JSON.stringify(transaction) }))
      remoteFlowSequences.set(id, Object.freeze({ sequence: terminalSampleSequence, signature: JSON.stringify(transaction), operation: 'tombstone' }))
      remoteFlowDrags.delete(id)
      return true
    } catch { return false }
  }
  const retireAllRemoteFlowDrags = (expectedTarget: Window | null = target) => {
    for (const [id, active] of [...remoteFlowDrags]) {
      const presentation = active.transaction.operation.kind === 'publish' ? active.transaction.operation.presentation : null
      if (!presentation) continue
      const [presenceId, clientId, leaseId, localClaimGeneration, reservationGeneration, gestureGeneration] = id.split('\0')
      retireRemoteFlowDrag(Object.freeze({ presenceId: presenceId!, clientId: clientId!, leaseId: leaseId!, localClaimGeneration: Number(localClaimGeneration), reservationGeneration: Number(reservationGeneration), gestureGeneration: Number(gestureGeneration) }), presentation, presentation.identity.sampleSequence, expectedTarget)
    }
    remoteFlowDrags.clear()
    remoteFlowSequences.clear()
    remoteFlowGenerations.clear()
  }
  const connectedContext = () => {
    const state = editorStore.getSnapshot()
    const preview = state.snapshot?.preview
    if (!state.previewReady || !target || !preview?.origin || preview.activeGeneration === null) return null
    return { state, preview, target, origin: preview.origin, generation: preview.activeGeneration, envelope: { channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration } as const }
  }
  const acceptedFlowDragTransaction = (context: NonNullable<ReturnType<typeof connectedContext>>, transaction: PreviewFlowDragTransaction) => {
    const command = { ...context.envelope, type: 'apply-flow-drag-transaction' as const, transaction }
    return acceptPreviewCommand({ origin: context.origin, source: context.target, data: command }, context.origin, context.target, context.generation, projectedDocument) ? command : null
  }
  const sourceGeometryMatches = (fence: PreviewFlowDragSourceFence) => {
    const geometry = sceneGeometry.getSnapshot()
    return geometry.documentRevision === fence.documentRevision && geometry.layoutGeneration === fence.layoutGeneration && geometry.revision === fence.measurementRevision
  }
  const validFlowCommittedHold = (hold: FlowDragCommittedProjection) => {
    const context = connectedContext()
    const current = documentStore.getSnapshot()
    return Boolean(context
      && activeFlowDrag === hold.publication
      && context.target === hold.publication.target
      && context.origin === hold.publication.origin
      && context.generation === hold.publication.envelope.generation
      && current.file === hold.sourceFile
      && current.file.revision === hold.receipt.documentRevision
      && current.pageId === hold.pageId
      && current.layoutGeneration === hold.receipt.layoutGeneration
      && pageRoot(current.file, current.pageId) === hold.pageRootNodeId)
  }
  const cancelStaleFlowCommittedHold = () => {
    const hold = flowDragCommittedHold
    if (!hold || validFlowCommittedHold(hold)) return
    retireFlowDrag({ interactionId: hold.publication.transaction.key.interactionId,
      gestureGeneration: hold.publication.transaction.key.gestureGeneration,
      sequence: hold.publication.transaction.key.sequence,
      sourceFence: hold.publication.transaction.sourceFence }, hold.publication.target)
    flowDragCommittedHold = null
  }
  const validFlowCommittedProjection = (retry: FlowDragCommittedProjection) => {
    const context = connectedContext()
    const current = documentStore.getSnapshot()
    const active = activeFlowDrag
    return Boolean(context
      && flowDragCommittedRetry === retry
      && active === retry.publication
      && context.target === retry.publication.target
      && context.origin === retry.publication.origin
      && context.generation === retry.publication.envelope.generation
      && current.file === retry.sourceFile
      && current.file.revision === retry.committedDocument.revision
      && current.pageId === retry.pageId
      && current.layoutGeneration === retry.layoutGeneration
      && !current.transient
      && !current.appearanceOverrides
      && !current.layoutOverrides
      && pageRoot(retry.sourceFile, retry.pageId) === retry.pageRootNodeId
      && sourceGeometryMatches(retry.publication.transaction.sourceFence))
  }
  const publishFlowCommittedProjection = (retry: FlowDragCommittedProjection): boolean => {
    if (!validFlowCommittedProjection(retry)) {
      if (flowDragCommittedRetry === retry) flowDragCommittedRetry = null
      return false
    }
    try {
      retry.publication.target.postMessage(retry.handoffCommand, retry.publication.origin)
      if (!validFlowCommittedProjection(retry)) return false
      retry.publication.target.postMessage(retry.committedDocumentCommand, retry.publication.origin)
      if (!validFlowCommittedProjection(retry)) return false
      retry.publication.target.postMessage(retry.committedLayoutCommand, retry.publication.origin)
      if (!validFlowCommittedProjection(retry)) return false
      projectedDocument = retry.committedDocument
      projectedAuthority = Object.freeze({
        target: retry.publication.target,
        origin: retry.publication.origin,
        generation: retry.publication.envelope.generation,
        fileId: retry.sourceFile.fileId,
        pageId: retry.pageId,
        pageRootNodeId: retry.pageRootNodeId,
        documentRevision: retry.committedDocument.revision,
        layoutGeneration: retry.layoutGeneration,
      })
      signature = retry.signature
      flowDragCommittedHold = retry
      flowDragSequences.set(flowKeyId(retry.handoffCommand.transaction.key.interactionId, retry.handoffCommand.transaction.key.gestureGeneration), Object.freeze({
        sequence: retry.handoffCommand.transaction.key.sequence,
        signature: JSON.stringify(retry.handoffCommand.transaction),
        operation: 'handoff' as const,
      }))
      if (flowDragCommittedRetry === retry) flowDragCommittedRetry = null
      return true
    } catch {
      signature = ''
      return false
    }
  }
  const publishCommittedProjection = (retry: CommittedProjectionRetry): boolean => {
    const context = connectedContext()
    const current = documentStore.getSnapshot()
    if (!context
      || committedProjectionRetry !== retry
      || context.target !== retry.target
      || context.origin !== retry.origin
      || context.generation !== retry.envelope.generation
      || current.file !== retry.sourceFile
      || current.pageId !== retry.pageId
      || current.layoutGeneration !== retry.layoutGeneration
      || current.transient
      || current.appearanceOverrides
      || current.layoutOverrides
      || pageRoot(retry.sourceFile, retry.pageId) !== retry.pageRootNodeId) {
      if (committedProjectionRetry === retry) committedProjectionRetry = null
      return false
    }
    try {
      retry.target.postMessage({ ...retry.envelope, type: 'set-document', document: retry.document, theme: retry.theme, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' }, retry.origin)
      retireStrictPresentation()
      projectedDocument = retry.document
      projectedAuthority = Object.freeze({
        target: retry.target,
        origin: retry.origin,
        generation: retry.envelope.generation,
        fileId: retry.sourceFile.fileId,
        pageId: retry.pageId,
        pageRootNodeId: retry.pageRootNodeId,
        documentRevision: retry.document.revision,
        layoutGeneration: retry.layoutGeneration,
      })
      signature = ''
      const afterDocumentContext = connectedContext()
      const afterDocumentState = documentStore.getSnapshot()
      if (!afterDocumentContext
        || committedProjectionRetry !== retry
        || afterDocumentContext.target !== retry.target
        || afterDocumentContext.origin !== retry.origin
        || afterDocumentContext.generation !== retry.envelope.generation
        || afterDocumentState.file !== retry.sourceFile
        || afterDocumentState.pageId !== retry.pageId
        || afterDocumentState.layoutGeneration !== retry.layoutGeneration) {
        if (committedProjectionRetry === retry) committedProjectionRetry = null
        return false
      }
      retry.target.postMessage({ ...retry.envelope, type: 'set-layout', items: retry.layout, layoutGeneration: retry.layoutGeneration, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' }, retry.origin)
      const afterLayoutContext = connectedContext()
      const afterLayoutState = documentStore.getSnapshot()
      if (!afterLayoutContext
        || committedProjectionRetry !== retry
        || afterLayoutContext.target !== retry.target
        || afterLayoutContext.origin !== retry.origin
        || afterLayoutContext.generation !== retry.envelope.generation
        || afterLayoutState.file !== retry.sourceFile
        || afterLayoutState.pageId !== retry.pageId
        || afterLayoutState.layoutGeneration !== retry.layoutGeneration) {
        if (committedProjectionRetry === retry) committedProjectionRetry = null
        return false
      }
      if (retry.retainedMoves.length) retry.target.postMessage({ ...retry.envelope, type: 'set-transient-move', items: retry.retainedMoves }, retry.origin)
      transientSignature = JSON.stringify(retry.retainedMoves)
      signature = retry.signature
      if (committedProjectionRetry === retry) committedProjectionRetry = null
      return true
    } catch {
      signature = ''
      transientSignature = '[]'
      return false
    }
  }
  const sync = () => {
    cancelStaleFlowCommittedHold()
    if (flowDragCommittedRetry) {
      const retry = flowDragCommittedRetry
      publishFlowCommittedProjection(retry)
      if (flowDragCommittedRetry === retry) syncFrames.request()
      return
    }
    if (committedProjectionRetry) {
      publishCommittedProjection(committedProjectionRetry)
      if (committedProjectionRetry) return
    }
    const state = editorStore.getSnapshot()
    const document = documentStore.getSnapshot()
    const preview = state.snapshot?.preview
    if (geometryGeneration !== (preview?.activeGeneration ?? null)) {
      retireFlowDragBeforeContextChange()
      retireAllRemoteFlowDrags()
      clearStrictPresentationBeforeContextChange()
      committedProjectionRetry = null
      geometryGeneration = preview?.activeGeneration ?? null
      transientSignature = '[]'
      projectedAuthority = null
      sceneGeometry.clear()
    }
    if (!state.previewReady || !target || !preview?.origin || preview.activeGeneration === null) { sceneGeometry.clear(); return }
    const envelope = { channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration } as const
    const camera = { x: document.viewport.x, y: document.viewport.y, zoom: document.viewport.zoom, width: document.viewportSize.width, height: document.viewportSize.height }
    const nextCamera = JSON.stringify(camera)
    if (nextCamera !== cameraSignature) {
      cameraSignature = nextCamera
      cameraSequence += 1
      sentCameras.set(cameraSequence, camera)
      previewCameraStore.expect(preview.activeGeneration, cameraSequence)
      while (sentCameras.size > 8) sentCameras.delete(sentCameras.keys().next().value!)
      target.postMessage({ ...envelope, type: 'set-camera', sequence: cameraSequence, camera }, preview.origin)
    }
    const transientMoves = activeFlowDrag ? [] : previewTransientMoves(document.file, document.pageId, document.transient, projectedDocument)
    const nextTransient = JSON.stringify(transientMoves)
    if (nextTransient !== '[]' && nextTransient !== transientSignature) publishTransient({ target, origin: preview.origin, envelope, items: transientMoves, signature: nextTransient })
    if (document.transient) {
      // A live canvas gesture owns only camera and transient style. Do not rebuild or stringify the document projection.
      return
    }
    // The editor root supplies only the selection chrome color; the design theme comes from the file's view state.
    const themeRoot = window.document.querySelector('.editor-root')
    const color = themeRoot ? getComputedStyle(themeRoot).getPropertyValue('--color-4').trim() : ''
    const designTheme = previewThemeMessage(activeDesignTheme(state.snapshot, state.previewThemeId))
    const projection = document.file && document.pageId ? projectPreviewPage(withOverrides(document.file, document.appearanceOverrides, document.layoutOverrides), document.pageId, themeProjectionContext(state.snapshot, state.previewThemeId)) : null
    try { projectedDocument = projection ? hydratePreviewDocument(projection.document, resolveAsset) : null }
    catch (error) {
      projectedDocument = null
      projectedAuthority = null
      const message = error instanceof Error ? error.message : 'An image could not be prepared for preview.'
      assetHydrationError = message
      if (state.error !== message) editorStore.set({ error: message })
      return
    }
    if (assetHydrationError) {
      const resolvedError = assetHydrationError
      assetHydrationError = null
      if (state.error === resolvedError) editorStore.set({ error: null })
    }
    const projectedRootNodeId = document.file && document.pageId ? pageRoot(document.file, document.pageId) : null
    projectedAuthority = projectedDocument && document.file && document.pageId && projectedRootNodeId ? {
      target,
      origin: preview.origin,
      generation: preview.activeGeneration,
      fileId: document.file.fileId,
      pageId: document.pageId,
      pageRootNodeId: projectedRootNodeId,
      documentRevision: projectedDocument.revision,
      layoutGeneration: document.layoutGeneration,
    } : null
    const bound = state.runtimeInstanceIds !== null
    const nodeIds = projection && (state.compositionPreview || bound) ? document.selection.filter(id => Object.hasOwn(projection.document.nodes, id) || projection.document.canvas.elements.some(element => element.id === id)) : []
    const interactionMode = document.tool === 'hand' ? 'pan' : document.tool === 'interact' ? 'interact' : 'select'
    const next = JSON.stringify({ generation: preview.activeGeneration, theme: designTheme, mode: interactionMode, document: projectedDocument, layout: projection?.layout ?? [], layoutGeneration: document.layoutGeneration, nodeIds, color })
    if (signature !== next) {
      signature = next
      target.postMessage({ ...envelope, type: 'set-theme', theme: designTheme }, preview.origin)
      target.postMessage({ ...envelope, type: 'set-interaction-mode', mode: interactionMode }, preview.origin)
      if (projectedDocument) {
        target.postMessage({ ...envelope, type: 'set-document', document: projectedDocument, theme: designTheme, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' }, preview.origin)
        retireStrictPresentation()
      }
      target.postMessage({ ...envelope, type: 'set-layout', items: projection?.layout ?? [], layoutGeneration: document.layoutGeneration, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' }, preview.origin)
      if (/^#[0-9a-fA-F]{6}$/.test(color)) target.postMessage({ ...envelope, type: 'set-selection', nodeIds, color, renderChrome: false }, preview.origin)
    }
    if (nextTransient === '[]' && transientSignature !== '[]') { transientSignature = '[]'; target.postMessage({ ...envelope, type: 'set-transient-move', items: [] }, preview.origin) }
  }
  // Inspector scrubs can publish faster than the browser paints. Project and serialize only the newest state per frame.
  const syncFrames = createFrameQueue(sync, callback => requestAnimationFrame(callback), frame => cancelAnimationFrame(frame))
  const syncDocument = () => {
    // Canvas move and resize already have their own latest-frame transient queue. Feeding that queue immediately avoids
    // adding a second frame of latency while inspector-only previews take the coalesced projection path.
    // Camera-only pan samples can arrive much faster than the preview iframe paints. Publish only the newest camera per
    // frame so an input burst cannot leave the rendered document behind the parent-owned selection chrome.
    const transient = documentStore.getSnapshot().transient
    if (transient && transient.kind !== 'pan') sync()
    else syncFrames.request()
  }
  const handleMessage = (event: MessageEvent) => {
    const preview = editorStore.getSnapshot().snapshot?.preview
    if (!preview?.origin || preview.activeGeneration === null || !target) return
    const accepted = acceptPreviewEvent(event, preview.origin, target, preview.activeGeneration)
    if (!accepted) return
    if (accepted.type === 'source-bindings') {
      const current = documentStore.getSnapshot().file
      const snapshot = editorStore.getSnapshot().snapshot
      if (current && snapshot && accepted.instanceIds.every(id => current.nodes[id]?.type === 'component')) {
        documentStore.setEditPolicy(undefined)
        editorStore.set({ runtimeInstanceIds: accepted.instanceIds, compositionPreview: false })
      }
    }
    if (accepted.type === 'camera-applied') {
      const sent = sentCameras.get(accepted.sequence)
      if (!sent || accepted.sequence <= appliedCameraSequence || JSON.stringify(sent) !== JSON.stringify(accepted.camera)) return
      appliedCameraSequence = accepted.sequence
      for (const sequence of sentCameras.keys()) if (sequence <= accepted.sequence) sentCameras.delete(sequence)
      previewCameraStore.publish(preview.activeGeneration, accepted.sequence, accepted.camera)
    }
    if (accepted.type === 'geometry') {
      const current = documentStore.getSnapshot()
      if (!geometryMatchesProjection(accepted, projectedDocument, current.layoutGeneration)) return
      const camera = accepted.camera ?? { x: current.viewport.x, y: current.viewport.y, zoom: current.viewport.zoom, width: current.viewportSize.width, height: current.viewportSize.height }
      sceneGeometry.update(unprojectGeometry(accepted.items, camera, accepted.documentRevision, accepted.layoutGeneration), { documentRevision: accepted.documentRevision, layoutGeneration: accepted.layoutGeneration, measurementRevision: accepted.measurementRevision }, Object.fromEntries((accepted.unsupported ?? []).map(entry => [entry.instanceId, entry.status])), { themeUnsupported: Object.fromEntries((accepted.theme?.nodes ?? []).map(entry => [entry.instanceId, entry.status])), unownedPortals: accepted.theme?.unownedPortals ?? 0 })
      const hold = flowDragCommittedHold
      if (hold && accepted.documentRevision === hold.receipt.documentRevision && accepted.layoutGeneration === hold.receipt.layoutGeneration
        && accepted.measurementRevision >= hold.receipt.afterMeasurementRevision && activeFlowDrag === hold.publication) {
        activeFlowDrag = null
        flowDragCommittedHold = null
      }
    }
    if (accepted.type === 'wheel') {
      const wheel = accepted.wheel
      const current = documentStore.getSnapshot()
      if (wheel.ctrlKey || wheel.metaKey) documentStore.zoomAt(current.viewport.zoom * wheelZoomFactor(wheel.deltaY), { x: wheel.clientX, y: wheel.clientY })
      else { const delta = wheelPanDelta(wheel, current.viewportSize.height); documentStore.panBy(-delta.x, -delta.y) }
    }
    if (accepted.type === 'ready') editorStore.set({ previewReady: true })
    if (accepted.type === 'diagnostic') editorStore.set({ error: accepted.message })
    if (accepted.type === 'selected') {
      if (accepted.instanceId) documentStore.select(accepted.instanceId)
      else editorStore.set({ selected: accepted.componentId })
    }
  }
  const publishFlowDragPresentation = (presentation: FlowDragPresentation): boolean => {
    try {
      if (!deeplyFrozen(presentation)) return false
      const context = connectedContext()
      const document = documentStore.getSnapshot()
      const geometry = sceneGeometry.getSnapshot()
      const authority = projectedAuthority
      const rootNodeId = document.file && document.pageId ? pageRoot(document.file, document.pageId) : null
      if (!context || !authority || !projectedDocument || !document.file || !document.pageId || !rootNodeId || document.transient) return false
      if (authority.target !== context.target || authority.origin !== context.origin || authority.generation !== context.generation) return false
      if (authority.fileId !== document.file.fileId || authority.pageId !== document.pageId || authority.pageRootNodeId !== rootNodeId) return false
      if (authority.documentRevision !== projectedDocument.revision || authority.documentRevision !== document.file.revision || authority.layoutGeneration !== document.layoutGeneration) return false
      const fence = presentation.fence
      if (fence.fileId !== document.file.fileId || fence.fileRevision !== document.file.revision || fence.documentRevision !== document.file.revision
        || fence.layoutGeneration !== document.layoutGeneration || fence.pageId !== document.pageId || fence.pageRootId !== rootNodeId) return false
      if (geometry.documentRevision !== fence.documentRevision || geometry.layoutGeneration !== fence.layoutGeneration || geometry.revision !== fence.measurementRevision) return false
      const key = Object.freeze({ interactionId: presentation.identity.interactionId, gestureGeneration: presentation.identity.gestureGeneration, sequence: presentation.identity.sampleSequence })
      const transaction: PreviewFlowDragTransaction = Object.freeze({ key, sourceFence: fence, operation: Object.freeze({ kind: 'publish' as const, presentation }) })
      const accepted = acceptedFlowDragTransaction(context, transaction)
      if (!accepted) return false
      const signature = JSON.stringify(transaction)
      const interactionGeneration = flowDragGenerations.get(key.interactionId)
      if (interactionGeneration !== undefined && key.gestureGeneration < interactionGeneration) return false
      const sequenceKey = flowKeyId(key.interactionId, key.gestureGeneration)
      const previous = flowDragSequences.get(sequenceKey)
      if (previous && key.sequence < previous.sequence) return false
      if (previous && key.sequence === previous.sequence) return previous.operation === 'publish' && previous.signature === signature
      if (activeFlowDrag && activeFlowDrag.transaction.key.interactionId !== key.interactionId) return false
      const publication: FlowDragPublication = Object.freeze({ target: context.target, origin: context.origin, envelope: context.envelope, transaction, signature })
      postFlowDragTransaction(publication)
      flowDragGenerations.set(key.interactionId, key.gestureGeneration)
      flowDragSequences.set(sequenceKey, Object.freeze({ sequence: key.sequence, signature, operation: 'publish' }))
      activeFlowDrag = publication
      return true
    } catch {
      return false
    }
  }
  const clearFlowDragPresentation = (retirement: PreviewFlowDragRetirement): boolean => {
    try {
      if (!deeplyFrozen(retirement) || !validFlowRetirement(retirement)) return false
      const context = connectedContext()
      const active = activeFlowDrag
      if (!context || !active || active.target !== context.target || active.origin !== context.origin || active.envelope.generation !== context.generation) return false
      const transaction: PreviewFlowDragTransaction = Object.freeze({
        key: Object.freeze({ interactionId: retirement.interactionId, gestureGeneration: retirement.gestureGeneration, sequence: retirement.sequence }),
        sourceFence: retirement.sourceFence,
        operation: Object.freeze({ kind: 'tombstone' as const }),
      })
      if (!acceptedFlowDragTransaction(context, transaction)) return false
      return retireFlowDrag(retirement)
    } catch {
      return false
    }
  }
  const publishRemoteFlowDragPresentation = (remoteKey: RemoteFlowPresentationKey, presentation: FlowDragPresentation): boolean => {
    try {
      if (!Object.isFrozen(remoteKey) || !deeplyFrozen(presentation)
        || remoteKey.gestureGeneration !== presentation.identity.gestureGeneration
        || !Number.isSafeInteger(remoteKey.localClaimGeneration) || remoteKey.localClaimGeneration < 1
        || !Number.isSafeInteger(remoteKey.reservationGeneration) || remoteKey.reservationGeneration < 1) return false
      const context = connectedContext()
      const document = documentStore.getSnapshot()
      const authority = projectedAuthority
      const rootNodeId = document.file && document.pageId ? pageRoot(document.file, document.pageId) : null
      if (!context || !authority || !projectedDocument || !document.file || !document.pageId || !rootNodeId || document.transient) return false
      if (authority.target !== context.target || authority.origin !== context.origin || authority.generation !== context.generation
        || authority.fileId !== document.file.fileId || authority.pageId !== document.pageId || authority.pageRootNodeId !== rootNodeId
        || authority.documentRevision !== projectedDocument.revision || authority.documentRevision !== document.file.revision
        || authority.layoutGeneration !== document.layoutGeneration) return false
      const fence = presentation.fence
      if (fence.fileId !== document.file.fileId || fence.fileRevision !== document.file.revision || fence.documentRevision !== document.file.revision
        || fence.layoutGeneration !== document.layoutGeneration || fence.pageId !== document.pageId || fence.pageRootId !== rootNodeId
        || !sourceGeometryMatches(fence)) return false
      const key = Object.freeze({ interactionId: presentation.identity.interactionId, gestureGeneration: presentation.identity.gestureGeneration, sequence: presentation.identity.sampleSequence })
      const transaction: PreviewFlowDragTransaction = Object.freeze({ key, sourceFence: fence, operation: Object.freeze({ kind: 'publish' as const, presentation }) })
      if (!acceptedFlowDragTransaction(context, transaction)) return false
      const signature = JSON.stringify(transaction)
      const id = remoteFlowKeyId(remoteKey)
      const lineageId = remoteFlowLineageId(remoteKey, key.interactionId)
      const interactionGeneration = remoteFlowGenerations.get(lineageId)
      if (interactionGeneration !== undefined && key.gestureGeneration < interactionGeneration) return false
      const previous = remoteFlowSequences.get(id)
      if (previous?.operation === 'tombstone') return false
      if (previous && key.sequence < previous.sequence) return false
      if (previous && key.sequence === previous.sequence && (previous.operation !== 'publish' || previous.signature !== signature)) return false
      const publication: FlowDragPublication = Object.freeze({ target: context.target, origin: context.origin, envelope: context.envelope, transaction, signature })
      postFlowDragTransaction(publication)
      remoteFlowGenerations.set(lineageId, key.gestureGeneration)
      remoteFlowSequences.set(id, Object.freeze({ sequence: key.sequence, signature, operation: 'publish' }))
      remoteFlowDrags.set(id, publication)
      return true
    } catch { return false }
  }
  const remoteFlowBridge: RemoteFlowPreviewBridge = Object.freeze({
    publishRemoteFlowDragPresentation,
    clearRemoteFlowDragPresentation: retireRemoteFlowDrag,
    clearAllRemoteFlowDragPresentations: () => retireAllRemoteFlowDrags(),
  })
  const syncCommittedFlowDrag = (handoff: PreviewCommittedFlowDragHandoff): PreviewCommittedFlowDragReceipt | null => {
    if (!handoff.commit.committed || !handoff.committedFile || !deeplyFrozen(handoff.terminalPresentation)) return null
    const terminal = handoff.terminalPresentation
    const active = activeFlowDrag
    if (!active || active.transaction.operation.kind !== 'publish' || active.transaction.operation.presentation !== terminal
      || terminal.retention.kind !== 'terminal-retained' || terminal.retention.terminalSampleSequence !== terminal.identity.sampleSequence) return null
    if (flowDragCommittedHold?.publication === active && flowDragCommittedHold.sourceFile === handoff.committedFile) {
      if (validFlowCommittedHold(flowDragCommittedHold)) return flowDragCommittedHold.receipt
      cancelStaleFlowCommittedHold()
      return null
    }
    try {
      const context = connectedContext()
      const document = documentStore.getSnapshot()
      if (!context || active.target !== context.target || active.origin !== context.origin || active.envelope.generation !== context.generation) return null
      if (!sourceGeometryMatches(terminal.fence)) return null
      if (!document.file || !document.pageId || document.transient || document.appearanceOverrides || document.layoutOverrides) return null
      if (document.file !== handoff.committedFile || document.file.fileId !== terminal.fence.fileId || document.pageId !== terminal.fence.pageId
        || document.file.revision !== terminal.fence.fileRevision + 1 || document.layoutGeneration < terminal.fence.layoutGeneration) return null
      const rootNodeId = pageRoot(document.file, document.pageId)
      if (!rootNodeId || rootNodeId !== terminal.fence.pageRootId) return null
      syncFrames.cancel()
      const sourceFile = document.file
      const sourcePageId = document.pageId
      const sourceLayoutGeneration = document.layoutGeneration
      const designTheme = previewThemeMessage(activeDesignTheme(context.state.snapshot, context.state.previewThemeId))
      const projection = projectPreviewPage(sourceFile, sourcePageId, themeProjectionContext(context.state.snapshot, context.state.previewThemeId))
      if (!projection) return null
      let committedDocument: PreviewDocument
      try { committedDocument = hydratePreviewDocument(projection.document, resolveAsset) }
      catch (error) {
        const message = error instanceof Error ? error.message : 'An image could not be prepared for preview.'
        assetHydrationError = message
        if (context.state.error !== message) editorStore.set({ error: message })
        return null
      }
      const currentContext = connectedContext()
      const currentDocument = documentStore.getSnapshot()
      if (!currentContext || currentContext.target !== context.target || currentContext.origin !== context.origin || currentContext.generation !== context.generation
        || activeFlowDrag !== active || currentDocument.file !== sourceFile || currentDocument.pageId !== sourcePageId
        || currentDocument.layoutGeneration !== sourceLayoutGeneration || currentDocument.transient || currentDocument.appearanceOverrides || currentDocument.layoutOverrides) return null
      const receipt: PreviewCommittedFlowDragReceipt = Object.freeze({
        generation: context.generation,
        fileId: sourceFile.fileId,
        pageId: sourcePageId,
        documentRevision: committedDocument.revision,
        layoutGeneration: sourceLayoutGeneration,
        afterMeasurementRevision: terminal.fence.measurementRevision + 1,
        interactionId: terminal.identity.interactionId,
        gestureGeneration: terminal.identity.gestureGeneration,
        terminalSequence: terminal.identity.sampleSequence,
        sourceFence: terminal.fence,
      })
      const handoffTransaction: PreviewFlowDragTransaction = Object.freeze({
        key: active.transaction.key,
        sourceFence: active.transaction.sourceFence,
        operation: Object.freeze({ kind: 'committed-handoff' as const, committed: Object.freeze({
          previewGeneration: context.generation,
          fileId: receipt.fileId,
          pageId: receipt.pageId,
          pageRootId: rootNodeId,
          documentRevision: receipt.documentRevision,
          layoutGeneration: receipt.layoutGeneration,
          afterMeasurementRevision: receipt.afterMeasurementRevision,
          terminalSequence: receipt.terminalSequence,
        }) }),
      })
      if (!acceptedFlowDragTransaction(context, handoffTransaction)) return null
      const handoffCommand = Object.freeze({ ...context.envelope, type: 'apply-flow-drag-transaction' as const, transaction: handoffTransaction })
      const committedDocumentCommand = Object.freeze({ ...context.envelope, type: 'set-document' as const, document: committedDocument, theme: designTheme, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' as const })
      const committedLayoutCommand = Object.freeze({ ...context.envelope, type: 'set-layout' as const, items: projection.layout, layoutGeneration: sourceLayoutGeneration, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' as const })
      const retry: FlowDragCommittedProjection = Object.freeze({ publication: active, sourceFile, pageId: sourcePageId, pageRootNodeId: rootNodeId,
        layoutGeneration: sourceLayoutGeneration, committedDocument, committedDocumentCommand, committedLayoutCommand, handoffCommand,
        signature: '', receipt })
      flowDragCommittedRetry = retry
      if (!publishFlowCommittedProjection(retry)) {
        if (flowDragCommittedRetry === retry) syncFrames.request()
        return null
      }
      return receipt
    } catch {
      if (flowDragCommittedRetry) syncFrames.request()
      return null
    }
  }
  const rejectResizePresentation = () => {
    clearStrictPresentation()
    return false
  }
  const publishResizePresentation = (input: PreviewResizeSample): boolean => {
    try {
      const context = connectedContext()
      const document = documentStore.getSnapshot()
      const geometry = sceneGeometry.getSnapshot()
      const authority = projectedAuthority
      const rootNodeId = document.file && document.pageId ? pageRoot(document.file, document.pageId) : null
      if (!context || !authority || !projectedDocument || !document.file || !document.pageId || !rootNodeId) return rejectResizePresentation()
      if (!deeplyFrozen(input.presentation) || !deeplyFrozen(input.start)) return rejectResizePresentation()
      if (authority.target !== context.target || authority.origin !== context.origin || authority.generation !== context.generation) return rejectResizePresentation()
      if (authority.fileId !== document.file.fileId || authority.pageId !== document.pageId || authority.pageRootNodeId !== rootNodeId || input.pageRootNodeId !== rootNodeId) return rejectResizePresentation()
      if (authority.documentRevision !== projectedDocument.revision || authority.documentRevision !== document.file.revision || authority.layoutGeneration !== document.layoutGeneration) return rejectResizePresentation()
      if (input.start.fileId !== document.file.fileId || input.start.fileRevision !== document.file.revision || input.start.documentRevision !== document.file.revision || input.start.layoutGeneration !== document.layoutGeneration) return rejectResizePresentation()
      if (geometry.documentRevision !== input.start.documentRevision || geometry.layoutGeneration !== input.start.layoutGeneration || geometry.revision !== input.start.measurementRevision) return rejectResizePresentation()
      const fence: Readonly<PreviewPresentationFence> = Object.freeze({ documentRevision: input.start.documentRevision, layoutGeneration: input.start.layoutGeneration, measurementRevision: input.start.measurementRevision })
      const presentation = previewResizePresentation({ presentation: input.presentation, document: projectedDocument, pageRootNodeId: input.pageRootNodeId, interactionId: input.interactionId, sampleSequence: input.sampleSequence, fence })
      if (!presentation) return rejectResizePresentation()
      const nextSignature = JSON.stringify(presentation)
      const previous = strictPresentationSequences.get(presentation.interactionId)
      if (previous && presentation.sampleSequence < previous.sequence) return rejectResizePresentation()
      if (previous && presentation.sampleSequence === previous.sequence) {
        return previous.signature === nextSignature && strictPresentationSignature === nextSignature && strictPresentationContext?.target === context.target
          ? true
          : rejectResizePresentation()
      }
      context.target.postMessage({ ...context.envelope, type: 'set-transient-presentations', presentations: [presentation] }, context.origin)
      strictPresentationSequences.set(presentation.interactionId, Object.freeze({ sequence: presentation.sampleSequence, signature: nextSignature }))
      strictPresentationSignature = nextSignature
      strictPresentationContext = Object.freeze({
        target: context.target,
        origin: context.origin,
        envelope: context.envelope,
        interactionId: presentation.interactionId,
        sampleSequence: presentation.sampleSequence,
        fence,
        start: input.start,
        fileId: document.file.fileId,
        pageId: document.pageId,
        pageRootNodeId: rootNodeId,
      })
      return true
    } catch {
      return rejectResizePresentation()
    }
  }
  const clearResizePresentation = (): boolean => {
    try {
      const active = strictPresentationContext
      if (active) return clearStrictPresentation()
      const context = connectedContext()
      retireStrictPresentation()
      if (!context) return false
      context.target.postMessage({ ...context.envelope, type: 'set-transient-presentations', presentations: [] }, context.origin)
      return true
    } catch {
      retireStrictPresentation()
      return false
    }
  }
  const syncCommittedDocument = (handoff: PreviewCommittedDocumentHandoff): PreviewCommittedDocumentReceipt | null => {
    if (!handoff.commit.committed || !handoff.committedFile) return null
    const terminal = strictPresentationContext
    if (!terminal || !deeplyFrozen(handoff.start) || terminal.interactionId !== handoff.interactionId || terminal.sampleSequence !== handoff.sampleSequence || !sameGestureStart(terminal.start, handoff.start)) return null
    try {
      const context = connectedContext()
      const document = documentStore.getSnapshot()
      if (!context || terminal.target !== context.target || terminal.origin !== context.origin || terminal.envelope.generation !== context.generation) return null
      if (!document.file || !document.pageId || document.transient || document.appearanceOverrides || document.layoutOverrides) return null
      if (document.file !== handoff.committedFile || document.file.fileId !== terminal.fileId || document.pageId !== terminal.pageId || document.file.revision !== handoff.start.fileRevision + 1 || document.layoutGeneration !== handoff.start.layoutGeneration) return null
      const rootNodeId = pageRoot(document.file, document.pageId)
      if (!rootNodeId || rootNodeId !== terminal.pageRootNodeId) return null
      syncFrames.cancel()
      const sourceFile = document.file
      const sourcePageId = document.pageId
      const sourceLayoutGeneration = document.layoutGeneration
      const designTheme = previewThemeMessage(activeDesignTheme(context.state.snapshot, context.state.previewThemeId))
      const projection = projectPreviewPage(sourceFile, sourcePageId, themeProjectionContext(context.state.snapshot, context.state.previewThemeId))
      if (!projection) return null
      let committedDocument: PreviewDocument
      try { committedDocument = hydratePreviewDocument(projection.document, resolveAsset) }
      catch (error) {
        const message = error instanceof Error ? error.message : 'An image could not be prepared for preview.'
        assetHydrationError = message
        if (context.state.error !== message) editorStore.set({ error: message })
        clearStrictPresentationIf(terminal)
        return null
      }
      const currentContext = connectedContext()
      const currentDocument = documentStore.getSnapshot()
      if (!currentContext
        || currentContext.target !== context.target
        || currentContext.origin !== context.origin
        || currentContext.generation !== context.generation
        || strictPresentationContext !== terminal
        || currentDocument.file !== sourceFile
        || currentDocument.pageId !== sourcePageId
        || currentDocument.layoutGeneration !== sourceLayoutGeneration
        || currentDocument.transient
        || currentDocument.appearanceOverrides
        || currentDocument.layoutOverrides) {
        clearStrictPresentationIf(terminal)
        return null
      }
      const measurementRevision = sceneGeometry.getSnapshot().revision
      const themeRoot = window.document.querySelector('.editor-root')
      const color = themeRoot ? getComputedStyle(themeRoot).getPropertyValue('--color-4').trim() : ''
      const bound = context.state.runtimeInstanceIds !== null
      const nodeIds = context.state.compositionPreview || bound ? currentDocument.selection.filter(id => Object.hasOwn(committedDocument.nodes, id) || committedDocument.canvas?.elements.some(element => element.id === id)) : []
      const interactionMode = currentDocument.tool === 'hand' ? 'pan' : currentDocument.tool === 'interact' ? 'interact' : 'select'
      const nextSignature = JSON.stringify({ generation: context.generation, theme: designTheme, mode: interactionMode, document: committedDocument, layout: projection.layout, layoutGeneration: sourceLayoutGeneration, nodeIds, color })
      const retry: CommittedProjectionRetry = Object.freeze({
        target: context.target,
        origin: context.origin,
        envelope: context.envelope,
        sourceFile,
        pageId: sourcePageId,
        pageRootNodeId: rootNodeId,
        layoutGeneration: sourceLayoutGeneration,
        document: committedDocument,
        theme: designTheme,
        layout: projection.layout,
        retainedMoves: Object.freeze([]),
        signature: nextSignature,
      })
      committedProjectionRetry = retry
      if (!publishCommittedProjection(retry)) {
        if (committedProjectionRetry === retry) syncFrames.request()
        return null
      }
      return Object.freeze({
        generation: context.generation,
        fileId: sourceFile.fileId,
        pageId: sourcePageId,
        documentRevision: committedDocument.revision,
        layoutGeneration: sourceLayoutGeneration,
        afterMeasurementRevision: measurementRevision,
      })
    } catch {
      if (committedProjectionRetry) syncFrames.request()
      else clearStrictPresentationIf(terminal)
      return null
    }
  }
  return {
    start: () => {
      if (listening) return
      window.addEventListener('message', handleMessage)
      listening = true
      stopEditor = editorStore.subscribe(syncFrames.request)
      stopDocument = documentStore.subscribe(syncDocument)
      stopCollaboration = collaborationService.subscribe(sync)
      collaborationService.bindRemoteFlowPreview(remoteFlowBridge)
    },
    stop: () => { window.removeEventListener('message', handleMessage); stopEditor?.(); stopDocument?.(); stopCollaboration?.(); collaborationService.bindRemoteFlowPreview(null); stopEditor = undefined; stopDocument = undefined; stopCollaboration = undefined; listening = false; syncFrames.cancel(); retireFlowDragBeforeContextChange(); retireAllRemoteFlowDrags(); clearStrictPresentationBeforeContextChange(); committedProjectionRetry = null; target = null; signature = ''; cameraSignature = ''; cameraSequence = 0; appliedCameraSequence = -1; sentCameras.clear(); previewCameraStore.reset(); transientSignature = '[]'; projectedDocument = null; projectedAuthority = null; assetHydrationError = null; geometryGeneration = null; sceneGeometry.clear(); documentStore.setEditPolicy(undefined) },
    sync,
    publishResizePresentation,
    clearResizePresentation,
    syncCommittedDocument,
    publishRotationPreview,
    clearRotationPreview,
    publishFlowDragPresentation,
    clearFlowDragPresentation,
    syncCommittedFlowDrag,
    disconnect: () => {
      retireFlowDragBeforeContextChange()
      retireAllRemoteFlowDrags()
      clearStrictPresentationBeforeContextChange()
      committedProjectionRetry = null
      target = null
      sceneGeometry.clear()
      documentStore.setEditPolicy(undefined)
      signature = ''
      cameraSignature = ''
      cameraSequence = 0
      appliedCameraSequence = -1
      sentCameras.clear()
      previewCameraStore.reset()
      transientSignature = '[]'
      projectedAuthority = null
      editorStore.set({ previewReady: false, runtimeInstanceIds: null })
    },
    connect: (frame: Window | null) => {
      retireFlowDragBeforeContextChange()
      retireAllRemoteFlowDrags()
      clearStrictPresentationBeforeContextChange()
      committedProjectionRetry = null
      target = frame
      sceneGeometry.clear()
      documentStore.setEditPolicy(undefined)
      signature = ''
      cameraSignature = ''
      cameraSequence = 0
      appliedCameraSequence = -1
      sentCameras.clear()
      previewCameraStore.reset()
      transientSignature = '[]'
      projectedAuthority = null
      const preview = editorStore.getSnapshot().snapshot?.preview
      if (!frame || !preview?.origin || preview.activeGeneration === null) return
      editorStore.set({ previewReady: false, runtimeInstanceIds: null })
      frame.postMessage({ channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration, type: 'ping' }, preview.origin)
    },
  }
}
export const previewConnection = createPreviewConnection()
