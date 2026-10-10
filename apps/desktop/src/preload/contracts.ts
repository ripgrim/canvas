import type { PreparedChange, ProjectSnapshot, SaveResult } from '@canvas/repo-engine'
import type { PreviewSnapshot } from '@canvas/preview-runtime'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ShadcnScan } from '@canvas/scanner/contracts'
import type { ConnectedRepository, GitHubCloneRequest } from '@canvas/repository'
import type { AuthSessionView } from '@canvas/auth'

export type DesktopProjectSnapshot = ProjectSnapshot & { preview: PreviewSnapshot }
export type DesktopSaveResult = Omit<SaveResult, 'snapshot'> & { snapshot: DesktopProjectSnapshot }
export type ConnectedRepositoryScan = Readonly<{ repository: ConnectedRepository; scan: ShadcnScan }>
export type DesktopFileSummary = Readonly<{
  id: string
  name: string
  location: string
  updatedAt?: string
  thumbnailUrl?: string
}>

export type DesignEditorApi = Readonly<{
  listFiles(): Promise<readonly DesktopFileSummary[]>
  createFile(): Promise<DesktopFileSummary>
  openFile(fileId: string): Promise<DesktopProjectSnapshot>
  inspectFixture(): Promise<DesktopProjectSnapshot>
  scanShadcn(): Promise<ShadcnScan>
  pickLocalRepository(): Promise<ConnectedRepositoryScan | null>
  cloneGitHubRepository(input: GitHubCloneRequest): Promise<ConnectedRepositoryScan>
  getConnectedRepository(): Promise<ConnectedRepositoryScan | null>
  rescanConnectedRepository(): Promise<ConnectedRepositoryScan>
  prepareLabelPadding(padding: string): Promise<PreparedChange>
  prepareToken(value: string): Promise<PreparedChange>
  preparePromotion(name: string): Promise<PreparedChange>
  prepareUndo(transactionId: string): Promise<PreparedChange>
  prepareRedo(transactionId: string): Promise<PreparedChange>
  saveFile(file: FileDocument, expectedRevision: number): Promise<DesktopProjectSnapshot>
  savePrepared(id: string, approvalDigest: string): Promise<DesktopSaveResult>
  refresh(): Promise<DesktopProjectSnapshot>
  getAuthSession(): Promise<AuthSessionView>
  signInWithGitHub(): Promise<AuthSessionView>
  signOut(): Promise<AuthSessionView>
  onAuthSessionChanged(listener: (session: AuthSessionView) => void): () => void
}>

export type RepositoryRequest =
  | { method: 'listFiles' | 'createFile' | 'inspectFixture' | 'refresh' | 'scanShadcn'; args: [] }
  | { method: 'openFile'; args: [string] }
  | { method: 'prepareLabelPadding' | 'prepareToken' | 'preparePromotion' | 'prepareUndo' | 'prepareRedo'; args: [string] }
  | { method: 'savePrepared'; args: [string, string] }
  | { method: 'saveFile'; args: [FileDocument, number] }

export type RepositoryResult = ProjectSnapshot | PreparedChange | SaveResult | DesktopProjectSnapshot | DesktopSaveResult | ShadcnScan | DesktopFileSummary | readonly DesktopFileSummary[]

export type RepositoryResponse =
  | { ok: true; value: RepositoryResult }
  | { ok: false; error: string }

export const repositoryChannel = 'design-editor:repository'

export type RepositoryConnectionRequest =
  | { method: 'pickLocal' | 'getCurrent' | 'scanCurrent'; args: [] }
  | { method: 'cloneGitHub'; args: [GitHubCloneRequest] }

export type RepositoryConnectionResponse =
  | { ok: true; value: ConnectedRepositoryScan | null }
  | { ok: false; error: string }

export const repositoryConnectionChannel = 'design-editor:repository-connection'

export type AuthRequest = { method: 'getSession' | 'signInWithGitHub' | 'signOut'; args: [] }

export type AuthResponse =
  | { ok: true; value: AuthSessionView }
  | { ok: false; error: string }

export const authChannel = 'design-editor:auth'
export const authSessionChangedChannel = 'design-editor:auth-session-changed'

declare global {
  interface Window {
    designEditor: DesignEditorApi
  }
}
