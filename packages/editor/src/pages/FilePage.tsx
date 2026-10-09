import { FileLoading, FileScreen } from '../features/application/FileScreen'
import type { FileScreenProps } from '../features/application/FileScreen'
import { documentStore } from '../features/editor/document-store'
export { editorStore as fileLocationStore } from '../features/editor/store'
export type { FileLocationResult } from '../features/editor/store'
export { applicationCopy as fileRouteCopy } from '../features/application/application-copy'

/** The canvas selection as a URL-addressable node: exactly one selected node has an id, anything else is null. */
export const fileSelection = {
  subscribe: documentStore.subscribe,
  getNodeId: (): string | null => { const { selection } = documentStore.getSnapshot(); return selection.length === 1 ? selection[0]! : null },
}

/** The open page of the file as a URL-addressable id. */
export const filePageState = {
  subscribe: documentStore.subscribe,
  getPageId: (): string | null => documentStore.getSnapshot().pageId,
}

export function FilePage(props: FileScreenProps) { return <FileScreen {...props} /> }
export function FileLoadingPage() { return <FileLoading /> }
