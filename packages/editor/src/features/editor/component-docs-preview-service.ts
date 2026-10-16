import type { ComponentDefinition, ComponentInstanceValues, ComponentScalarValue } from '@canvas/repo-engine/component-model'
import { descendantsOf } from '@canvas/repo-engine/file-document'
import type { PreviewCommand, PreviewDocument, PreviewFontFace, PreviewLayoutItem, PreviewTheme } from '@canvas/preview-runtime/protocol'
import { acceptPreviewEvent, isPreviewDocument, protocolVersion } from '@canvas/preview-runtime/protocol'
import { fontCatalogService } from '../fonts/font-catalog-service'
import { configuredCanvasComponentPreview } from './component-configured-preview'
import { validComponentSlotDrafts } from './component-configured-instance'
import type { ComponentSlotDraft } from './component-configured-instance'
import { activeDesignTheme, previewThemeMessage, themeProjectionContext } from './design-theme'
import { documentStore } from './document-store'
import { hydratePreviewDocument } from './preview-service'
import { editorStore } from './store'

type PreviewViewport = Readonly<{ width: number; height: number }>
type PreviewContext = Readonly<{ target: Window; viewport: PreviewViewport; ready: boolean }>
type PreviewMessageHost = Pick<Window, 'addEventListener' | 'removeEventListener'>

export type ComponentDocsPreviewSnapshot = Readonly<{ values: ComponentInstanceValues; slotDrafts: readonly ComponentSlotDraft[]; status: 'connecting' | 'ready' | 'error' }>

function fitCamera(frame: Readonly<{ width: number; height: number }>, viewport: PreviewViewport) {
  const padding = 24
  const width = Math.max(frame.width, 1)
  const height = Math.max(frame.height, 1)
  const zoom = Math.min(2, Math.max(0.05, Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height)))
  return { x: -width * zoom / 2, y: -height * zoom / 2, zoom, width: viewport.width, height: viewport.height }
}

export function configuredComponentPreviewCommands(input: Readonly<{
  generation: number
  document: PreviewDocument
  layout: readonly PreviewLayoutItem[]
  layoutGeneration: number
  cameraSequence: number
  renderSequence: number
  viewport: PreviewViewport
  theme: PreviewTheme
  fonts: readonly PreviewFontFace[]
}>): PreviewCommand[] {
  const envelope = { channel: 'design-editor-preview' as const, version: protocolVersion, generation: input.generation }
  const commands: PreviewCommand[] = [
    { ...envelope, type: 'set-theme', theme: input.theme },
    { ...envelope, type: 'set-interaction-mode', mode: 'interact' },
    { ...envelope, type: 'set-document', document: input.document, theme: input.theme, renderSequence: input.renderSequence, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' },
    { ...envelope, type: 'set-layout', items: [...input.layout], layoutGeneration: input.layoutGeneration, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' },
    { ...envelope, type: 'set-camera', sequence: input.cameraSequence, camera: fitCamera(input.document.frame, input.viewport) },
  ]
  if (input.fonts.length) commands.splice(1, 0, { ...envelope, type: 'set-fonts', fonts: [...input.fonts] })
  return commands
}

export function validComponentPreviewValues(definition: ComponentDefinition, previous: ComponentInstanceValues): ComponentInstanceValues {
  const values: Record<string, ComponentScalarValue> = {}
  for (const property of definition.properties) {
    const value = previous[property.id]
    if (property.type === 'variant' && typeof value === 'string' && property.values.some(option => option.id === value)) values[property.id] = value
    if (property.type === 'text' && typeof value === 'string') values[property.id] = value
    if (property.type === 'boolean' && typeof value === 'boolean') values[property.id] = value
  }
  return values
}

function validValues(componentId: string, previous: ComponentInstanceValues): ComponentInstanceValues {
  const definition = documentStore.getSnapshot().file?.componentModel.definitions[componentId]
  return definition ? validComponentPreviewValues(definition, previous) : {}
}

function validSlotDrafts(componentId: string, previous: readonly ComponentSlotDraft[]): ComponentSlotDraft[] {
  const file = documentStore.getSnapshot().file
  const definition = file?.componentModel.definitions[componentId]
  return file && definition ? validComponentSlotDrafts(file, definition, previous) : []
}

export function createComponentDocsPreviewService(componentId: string, messageHost: PreviewMessageHost = window) {
  let snapshot: ComponentDocsPreviewSnapshot = { values: validValues(componentId, {}), slotDrafts: [], status: 'connecting' }
  let context: PreviewContext | null = null
  let signature = ''
  let cameraSequence = 0
  let renderSequence = 0
  let pendingRenderSequence: number | null = null
  let draftSequence = 0
  let stops: (() => void)[] = []
  const listeners = new Set<() => void>()
  const publish = (next: ComponentDocsPreviewSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
  const sync = () => {
    const values = validValues(componentId, snapshot.values)
    if (JSON.stringify(values) !== JSON.stringify(snapshot.values)) publish({ ...snapshot, values })
    const slotDrafts = validSlotDrafts(componentId, snapshot.slotDrafts)
    if (JSON.stringify(slotDrafts) !== JSON.stringify(snapshot.slotDrafts)) publish({ ...snapshot, slotDrafts })
    const file = documentStore.getSnapshot().file
    const state = editorStore.getSnapshot()
    const definition = file?.componentModel.definitions[componentId]
    const preview = state.snapshot?.preview
    if (!context?.ready || !file || !definition || definition.source.kind !== 'canvas' || preview?.activeGeneration === null || !preview?.origin) return
    for (const nodeId of [definition.source.masterRootId, ...descendantsOf(file, definition.source.masterRootId)]) {
      const node = file.nodes[nodeId]
      if (node?.type === 'text' && node.textStyle) fontCatalogService.require(node.textStyle.fontFamily, { style: node.textStyle.fontStyle, weight: node.textStyle.fontWeight })
    }
    const projection = configuredCanvasComponentPreview(file, definition, values, themeProjectionContext(state.snapshot, state.previewThemeId), { drafts: slotDrafts, atoms: documentStore.getSnapshot().atoms, editorMode: globalThis.document?.documentElement.classList.contains('theme-dark') ? 'dark' : 'light' })
    if (!projection) { publish({ ...snapshot, status: 'error' }); return }
    let document
    try { document = hydratePreviewDocument(projection.document, documentStore.assetPreview) } catch { publish({ ...snapshot, status: 'error' }); return }
    if (!isPreviewDocument(document)) { publish({ ...snapshot, status: 'error' }); return }
    const theme = previewThemeMessage(activeDesignTheme(state.snapshot, state.previewThemeId))
    const layoutGeneration = documentStore.getSnapshot().layoutGeneration
    const fonts = fontCatalogService.getLoadedFonts()
    const nextSignature = JSON.stringify({ generation: preview.activeGeneration, document, layout: projection.layout, layoutGeneration, viewport: context.viewport, theme, fonts })
    if (signature === nextSignature) return
    signature = nextSignature
    pendingRenderSequence = renderSequence
    const commands = configuredComponentPreviewCommands({ generation: preview.activeGeneration, document, layout: projection.layout, layoutGeneration, cameraSequence, renderSequence, viewport: context.viewport, theme, fonts })
    cameraSequence += 1
    renderSequence += 1
    for (const command of commands) context.target.postMessage(command, preview.origin)
  }
  const stop = () => { for (const dispose of stops) dispose(); stops = []; context = null; signature = ''; cameraSequence = 0; renderSequence = 0; pendingRenderSequence = null }
  const ping = () => {
    const preview = editorStore.getSnapshot().snapshot?.preview
    if (!context || preview?.activeGeneration === null || !preview?.origin) return
    context.target.postMessage({ channel: 'design-editor-preview', version: protocolVersion, generation: preview.activeGeneration, type: 'ping' }, preview.origin)
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    setValue(propertyId: string, value: ComponentScalarValue) { publish({ ...snapshot, values: { ...snapshot.values, [propertyId]: value } }); sync() },
    resetValue(propertyId: string) { const values = { ...snapshot.values }; delete values[propertyId]; publish({ ...snapshot, values }); sync() },
    setValues(values: ComponentInstanceValues) { publish({ ...snapshot, values: { ...snapshot.values, ...values } }); sync() },
    addSlotContent(propertyId: string, kind: 'text' | 'frame') {
      const draft: ComponentSlotDraft = { id: `slot-draft:${++draftSequence}`, propertyId, content: { kind } }
      const slotDrafts = validSlotDrafts(componentId, [...snapshot.slotDrafts, draft])
      if (slotDrafts.length !== snapshot.slotDrafts.length + 1) return false
      publish({ ...snapshot, slotDrafts }); sync(); return true
    },
    addSlotComponent(propertyId: string, nestedComponentId: string) {
      const draft: ComponentSlotDraft = { id: `slot-draft:${++draftSequence}`, propertyId, content: { kind: 'component', componentId: nestedComponentId } }
      const slotDrafts = validSlotDrafts(componentId, [...snapshot.slotDrafts, draft])
      if (slotDrafts.length !== snapshot.slotDrafts.length + 1) return false
      publish({ ...snapshot, slotDrafts }); sync(); return true
    },
    removeSlotDraft(draftId: string) {
      if (!snapshot.slotDrafts.some(draft => draft.id === draftId)) return false
      publish({ ...snapshot, slotDrafts: snapshot.slotDrafts.filter(draft => draft.id !== draftId) }); sync(); return true
    },
    reset() { publish({ ...snapshot, values: {}, slotDrafts: [] }); sync() },
    connect(target: Window, viewport: PreviewViewport) {
      stop()
      context = { target, viewport, ready: false }
      publish({ ...snapshot, status: 'connecting' })
      const onMessage = (event: MessageEvent) => {
        const preview = editorStore.getSnapshot().snapshot?.preview
        if (!context || preview?.activeGeneration === null || !preview?.origin) return
        const accepted = acceptPreviewEvent(event, preview.origin, context.target, preview.activeGeneration)
        if (accepted?.type === 'diagnostic') { publish({ ...snapshot, status: 'error' }); return }
        if (accepted?.type === 'document-applied') {
          if (accepted.renderSequence === pendingRenderSequence) publish({ ...snapshot, status: 'ready' })
          return
        }
        if (accepted?.type !== 'ready') return
        context = { ...context, ready: true }
        signature = ''
        sync()
      }
      messageHost.addEventListener('message', onMessage)
      stops = [() => messageHost.removeEventListener('message', onMessage), documentStore.subscribe(sync), editorStore.subscribe(sync), fontCatalogService.subscribeLoadedFonts(sync)]
      ping()
    },
    retry() {
      if (!context) return
      context = { ...context, ready: false }
      signature = ''
      pendingRenderSequence = null
      publish({ ...snapshot, status: 'connecting' })
      ping()
    },
    ping,
    disconnect: stop,
  }
}
