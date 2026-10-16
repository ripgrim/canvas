import { editorToast } from '../../design-system/toast-atoms'
import { encodeInternalClipboardPayload } from './clipboard-codec'
import { clipboardCopy } from './clipboard-copy'
import { clipboardHtmlToText } from './clipboard-html'
import { createInternalClipboardPayload } from './clipboard-internal'
import { createCanvasClipboardService } from './clipboard-service'
import { captureInternalClipboardAssets, internalClipboardBuffer } from './clipboard-internal-buffer'
import { documentStore } from './document-store'
import { screenToWorld } from './canvas-math'
import type { Point } from './canvas-math'

type ClipboardAuthority = Readonly<{
  documentGeneration: number
  fileId: string
  revision: number
  pageId: string
  layoutGeneration: number
  selection: readonly string[]
  dropPoint?: Point
}>

const canvasDropViewport = (event: DragEvent): Element | null => event.target instanceof Element ? event.target.closest('.canvas-viewport') : null

const captureAuthority = (event?: ClipboardEvent | DragEvent): ClipboardAuthority | null => {
  const state = documentStore.getSnapshot()
  const dropEvent = event?.type === 'drop' ? event as DragEvent : undefined
  const viewport = dropEvent ? canvasDropViewport(dropEvent) : null
  const rect = viewport?.getBoundingClientRect()
  const dropPoint = dropEvent && rect
    ? screenToWorld({ x: dropEvent.clientX - rect.left, y: dropEvent.clientY - rect.top }, state.viewport, state.viewportSize)
    : undefined
  return !state.file || !state.pageId || state.readOnly ? null : Object.freeze({
    documentGeneration: documentStore.getDocumentGeneration(),
    fileId: state.file.fileId,
    revision: state.file.revision,
    pageId: state.pageId,
    layoutGeneration: state.layoutGeneration,
    selection: Object.freeze([...state.selection]),
    ...(dropPoint ? { dropPoint: Object.freeze(dropPoint) } : {}),
  })
}

const authorityMatches = (authority: ClipboardAuthority | null) => {
  const state = documentStore.getSnapshot()
  return Boolean(authority && state.file && !state.readOnly
    && documentStore.getDocumentGeneration() === authority.documentGeneration
    && state.file.fileId === authority.fileId
    && state.file.revision === authority.revision
    && state.pageId === authority.pageId
    && state.layoutGeneration === authority.layoutGeneration
    && state.selection.length === authority.selection.length
    && state.selection.every((id, index) => id === authority.selection[index]))
}

export function createEditorClipboardService(host: Window = window) {
  return createCanvasClipboardService(
    host,
    (candidate, authority) => {
      if (candidate.kind === 'unsupported') { editorToast.error(clipboardCopy.pasteFailed, candidate.diagnostic); return }
      if (!authorityMatches(authority)) { editorToast.error(clipboardCopy.pasteFailed, clipboardCopy.canvasChanged); return }
      if (candidate.kind === 'text' && !documentStore.commands.insertClipboardText(candidate.text, authority?.dropPoint)) editorToast.error(clipboardCopy.pasteFailed, clipboardCopy.textRejected)
      if (candidate.kind === 'html') {
        const text = clipboardHtmlToText(candidate.source)
        if (!text || !documentStore.commands.insertClipboardText(text, authority?.dropPoint)) editorToast.error(clipboardCopy.pasteFailed, clipboardCopy.textRejected)
      }
      if (candidate.kind === 'images') {
        void documentStore.commands.assets.insertClipboard(candidate.files, authority?.dropPoint).then(result => {
          const failures = [...candidate.failures, ...result.failures]
          if (!result.inserted.length) editorToast.error(clipboardCopy.pasteFailed, failures[0]?.diagnostic ?? clipboardCopy.imageRejected)
          else if (failures.length) editorToast.error(clipboardCopy.partialImages(result.inserted.length, result.inserted.length + failures.length), failures[0]?.diagnostic ?? clipboardCopy.imageRejected)
        }, error => editorToast.error(clipboardCopy.pasteFailed, error instanceof Error ? error.message : clipboardCopy.imageRejected))
      }
      if (candidate.kind === 'internal') {
        const previews = internalClipboardBuffer.assetsFor(candidate.payload)
        void documentStore.commands.assets.insertInternalClipboard(candidate.payload, previews, authority?.dropPoint ? { center: authority.dropPoint } : {}).then(result => {
          if (!result.inserted.length) editorToast.error(clipboardCopy.pasteFailed, result.error ?? clipboardCopy.internalRejected)
        }, error => editorToast.error(clipboardCopy.pasteFailed, error instanceof Error ? error.message : clipboardCopy.internalRejected))
      }
    },
    () => documentStore.getSnapshot().atoms,
    undefined,
    candidate => candidate.kind === 'text' || candidate.kind === 'html' || candidate.kind === 'internal' || candidate.kind === 'image-files' || candidate.kind === 'svg',
    kind => {
      const state = documentStore.getSnapshot()
      try {
        if (!state.file || !state.pageId || !state.selection.length) return null
        const authority = captureAuthority()
        if (!authority) return null
        const payload = createInternalClipboardPayload(state.file, state.pageId, state.selection, state.atoms)
        const fallback = payload.roots.map(id => {
          const node = payload.nodes[id]
          return node && node.type !== 'root' ? node.name : 'Layer'
        }).join(', ')
        const encoded = encodeInternalClipboardPayload(payload, fallback, state.atoms)
        internalClipboardBuffer.remember(payload, encoded, captureInternalClipboardAssets(payload, documentStore.assetPreview))
        return kind === 'cut' ? { ...encoded, afterWrite: () => {
          if (!authorityMatches(authority) || !documentStore.commands.execute({ type: 'node.delete', nodeIds: [...payload.roots] }, [])) editorToast.error(clipboardCopy.cutFailed, clipboardCopy.canvasChanged)
        } } : encoded
      } catch (error) {
        editorToast.error(clipboardCopy.copyFailed, error instanceof Error ? error.message : clipboardCopy.copyRejected)
        return null
      }
    },
    undefined,
    captureAuthority,
    event => Boolean(canvasDropViewport(event)),
  )
}
