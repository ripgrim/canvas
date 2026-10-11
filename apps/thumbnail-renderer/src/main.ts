import React from 'react'
import { startPreview } from '@canvas/preview-runtime/browser'
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import { validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { PreviewPageDocument } from '@canvas/repo-engine/file-preview'
import type { Atom } from '@canvas/repo-engine'
import type { PreviewEvent } from '@canvas/preview-runtime/protocol'
import { RegistryEntry, RegistryProvider, registry, registryContract, registryProviderProps, registryThemeAdapters } from 'virtual:canvas-verified-component-registry'

type ThumbnailSource = Readonly<{ file: unknown; pageId: string; fileId: string; revision: number; registryFingerprint: string }>

declare global {
  interface Window {
    __CANVAS_THUMBNAIL_SOURCE__?: ThumbnailSource
    __PAPER_THUMBNAIL_READY?: boolean
  }
}

const root = document.documentElement
const source = window.__CANVAS_THUMBNAIL_SOURCE__
root.dataset.previewRegistry = registryContract.fingerprint
const startThumbnailPreview = startPreview as unknown as (options: Readonly<{
  Component: () => React.ReactElement
  Provider?: React.ComponentType<Record<string, unknown>>
  providerProps?: Record<string, unknown>
  initialProps: Record<string, never>
  generation: number
  editorOrigin: string
  componentId: string
  registry: typeof registry
  themeAdapters?: readonly React.ComponentType<Record<string, unknown>>[]
}>) => unknown

function mark(phase: string, error?: string): void {
  root.dataset.paperThumbnailReady = phase === 'ready' ? 'true' : 'false'
  root.dataset.paperThumbnailPhase = phase
  if (source?.fileId) root.dataset.paperThumbnailFileId = source.fileId
  if (error) root.dataset.paperThumbnailError = error.slice(0, 400)
  else delete root.dataset.paperThumbnailError
  window.__PAPER_THUMBNAIL_READY = phase === 'ready'
}

function animationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

function bounds(document: PreviewPageDocument): Readonly<{ x: number; y: number; width: number; height: number }> {
  const frame = { x: -document.frame.width / 2, y: -document.frame.height / 2, width: document.frame.width, height: document.frame.height }
  const items = [frame, ...document.canvas.elements.map(item => ({ x: item.x, y: item.y, width: item.width, height: item.height }))]
  const left = Math.min(...items.map(item => item.x))
  const top = Math.min(...items.map(item => item.y))
  const right = Math.max(...items.map(item => item.x + item.width))
  const bottom = Math.max(...items.map(item => item.y + item.height))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

function camera(content: ReturnType<typeof bounds>): Readonly<{ x: number; y: number; zoom: number; width: number; height: number }> {
  const width = window.innerWidth
  const height = window.innerHeight
  const padding = 24
  const zoom = Math.min((width - padding * 2) / content.width, (height - padding * 2) / content.height)
  return {
    x: -(content.x + content.width / 2) * zoom,
    y: -(content.y + content.height / 2) * zoom,
    zoom: Math.max(0.05, Math.min(200, zoom)),
    width,
    height,
  }
}

function command(message: Record<string, unknown>): void {
  window.postMessage({ channel: 'design-editor-preview', version: 3, generation: 1, ...message }, window.location.origin)
}

function propType(rule: { kind: 'string' | 'number' | 'boolean' } | { kind: 'enum'; values: readonly (string | number | boolean)[] }): string {
  if (rule.kind !== 'enum') return rule.kind
  return rule.values.map(value => typeof value === 'string' ? JSON.stringify(value) : String(value)).join(' | ')
}

function registryAtoms(): Atom[] {
  return registryContract.components.map(component => {
    if (!component.props || !component.slots) throw new Error('Thumbnail component registry needs explicit props and slots.')
    const rules = component.props
    const props = Object.entries(rules).map(([name, rule]) => ({ name, type: propType(rule), optional: true }))
    for (const slot of component.slots) if (!props.some(prop => prop.name === slot)) props.push({ name: slot, type: 'ReactNode', optional: true })
    return { name: component.exportName, kind: 'atom', componentId: component.componentId, path: component.entryPath, exportName: component.exportName, fingerprint: registryContract.fingerprint, sourceHash: component.integrity, status: 'bound', candidates: [], props, slots: [...component.slots] }
  })
}

async function start(): Promise<void> {
  mark('loading')
  if (!source || source.fileId.length > 128 || source.revision < 0 || !Number.isSafeInteger(source.revision)) throw new Error('Thumbnail source is unavailable.')
  if (source.registryFingerprint !== registryContract.fingerprint) throw new Error('Thumbnail component registry does not match the requested source.')
  const file: FileDocument = validateFileDocument(source.file, registryAtoms(), { allowUnavailableBindings: false })
  if (file.fileId !== source.fileId || file.revision !== source.revision) throw new Error('Thumbnail source identity does not match the request.')
  const projection = projectPreviewPage(file, source.pageId)
  if (!projection) throw new Error('Thumbnail page is unavailable.')
  const available = new Set(registry.map(binding => `${binding.componentId}\0${binding.exportName}`))
  const missing = Object.values(projection.document.nodes).find(node => !available.has(`${node.componentId}\0${node.exportName}`))
  if (missing) throw new Error(`Component binding is unavailable in the verified registry: ${missing.componentId}`)
  startThumbnailPreview({
    Component: (RegistryEntry ?? (() => React.createElement(React.Fragment))) as () => React.ReactElement,
    ...(RegistryProvider ? { Provider: RegistryProvider } : {}),
    providerProps: registryProviderProps,
    initialProps: {},
    generation: 1,
    editorOrigin: window.location.origin,
    componentId: registryContract.entry?.componentId ?? 'thumbnail-renderer',
    registry,
    themeAdapters: registryThemeAdapters,
  })
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Thumbnail render timed out.')), 10_000)
    const receive = (event: MessageEvent<PreviewEvent>) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.channel !== 'design-editor-preview' || event.data.generation !== 1) return
      if (event.data.type === 'diagnostic') { window.clearTimeout(timeout); window.removeEventListener('message', receive); reject(new Error(event.data.message)) }
      if (event.data.type === 'ready') { window.clearTimeout(timeout); window.removeEventListener('message', receive); resolve() }
    }
    window.addEventListener('message', receive)
  })
  command({ type: 'ping' })
  await ready
  mark('rendering')
  command({ type: 'set-interaction-mode', mode: 'interact' })
  command({ type: 'set-document', document: projection.document })
  command({ type: 'set-layout', items: projection.layout, layoutGeneration: source.revision })
  command({ type: 'set-selection', nodeIds: [], color: '#000000', renderChrome: false })
  command({ type: 'set-camera', camera: camera(bounds(projection.document)) })
  await animationFrame()
  await animationFrame()
  await animationFrame()
  mark('ready')
}

void start().catch(error => mark('error', error instanceof Error ? error.message : 'Thumbnail render failed.'))
