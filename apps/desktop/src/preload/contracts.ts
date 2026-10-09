import type { PreparedChange, ProjectSnapshot, SaveResult } from '@canvas/repo-engine'
import type { PreviewSnapshot } from '@canvas/preview-runtime'
import type { FileDocument } from '@canvas/repo-engine/file-document'

export type DesktopProjectSnapshot = ProjectSnapshot & { preview: PreviewSnapshot }
export type DesktopSaveResult = Omit<SaveResult, 'snapshot'> & { snapshot: DesktopProjectSnapshot }

export type DesignEditorApi = Readonly<{
  inspectFixture(): Promise<DesktopProjectSnapshot>
  prepareLabelPadding(padding: string): Promise<PreparedChange>
  prepareToken(value: string): Promise<PreparedChange>
  preparePromotion(name: string): Promise<PreparedChange>
  prepareUndo(transactionId: string): Promise<PreparedChange>
  prepareRedo(transactionId: string): Promise<PreparedChange>
  saveFile(file: FileDocument, expectedRevision: number): Promise<DesktopProjectSnapshot>
  savePrepared(id: string, approvalDigest: string): Promise<DesktopSaveResult>
  refresh(): Promise<DesktopProjectSnapshot>
}>

export type RepositoryRequest =
  | { method: 'inspectFixture' | 'refresh'; args: [] }
  | { method: 'prepareLabelPadding' | 'prepareToken' | 'preparePromotion' | 'prepareUndo' | 'prepareRedo'; args: [string] }
  | { method: 'savePrepared'; args: [string, string] }
  | { method: 'saveFile'; args: [FileDocument, number] }

export type RepositoryResult = ProjectSnapshot | PreparedChange | SaveResult | DesktopProjectSnapshot | DesktopSaveResult

export type RepositoryResponse =
  | { ok: true; value: RepositoryResult }
  | { ok: false; error: string }

export const repositoryChannel = 'design-editor:repository'

declare global {
  interface Window {
    designEditor: DesignEditorApi
  }
}
