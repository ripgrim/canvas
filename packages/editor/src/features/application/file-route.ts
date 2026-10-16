import { documentStore } from '../editor/document-store'
import { editorStore, withEditorStoreConfiguration } from '../editor/store'
import { failureDetails } from './failure'
import { applicationCopy } from './application-copy'
import { trackCanvasEvent } from '@canvas/tracking'
export type { FileLocationResult } from '../editor/store'
export { applicationCopy as fileRouteCopy } from './application-copy'

const failedLocation = (error: unknown) => {
  const failure = failureDetails(error, applicationCopy.errorTitle)
  trackCanvasEvent('operation_failed', { operation: 'open_route', error_code: failure.code, error_reference: failure.reference })
  return { status: 'error' as const, message: failure.message, reference: failure.reference }
}

export const fileLocationStore = Object.freeze({
  async openLocation(fileId: string, pageId: string | null, nodeId: string | null = null, signal?: AbortSignal) {
    try { return await withEditorStoreConfiguration(() => editorStore.openLocation(fileId, pageId, nodeId, signal), signal) }
    catch (error) { return failedLocation(error) }
  },
  async openSharedLocation(fileId: string, pageId: string | null, nodeId: string | null = null, signal?: AbortSignal) {
    try { return await withEditorStoreConfiguration(() => editorStore.openSharedLocation(fileId, pageId, nodeId, signal), signal) }
    catch (error) { return failedLocation(error) }
  },
})

export const fileSelection = Object.freeze({
  subscribe: documentStore.subscribe,
  getNodeId: (): string | null => { const { selection } = documentStore.getSnapshot(); return selection.length === 1 ? selection[0]! : null },
})

export const filePageState = Object.freeze({
  subscribe: documentStore.subscribe,
  getPageId: (): string | null => documentStore.getSnapshot().pageId,
})
