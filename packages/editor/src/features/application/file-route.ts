import { documentStore } from '../editor/document-store'
import { editorStore, withEditorStoreConfiguration } from '../editor/store'
export type { FileLocationResult } from '../editor/store'
export { applicationCopy as fileRouteCopy } from './application-copy'

export const fileLocationStore = Object.freeze({
  async openLocation(fileId: string, pageId: string | null, nodeId: string | null = null) {
    return withEditorStoreConfiguration(() => editorStore.openLocation(fileId, pageId, nodeId))
  },
  async openSharedLocation(fileId: string, pageId: string | null, nodeId: string | null = null) {
    return withEditorStoreConfiguration(() => editorStore.openSharedLocation(fileId, pageId, nodeId))
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
