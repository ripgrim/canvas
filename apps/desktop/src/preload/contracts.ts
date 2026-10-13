import type { PreparedChange, ProjectSnapshot, SaveResult } from '@canvas/repo-engine'
import type { PreviewSnapshot } from '@canvas/preview-runtime'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ShadcnComponentCatalog, ShadcnScan } from '@canvas/scanner/contracts'
import type { ConnectedRepository, GitHubCloneRequest } from '@canvas/repository'
import type { AuthSessionView } from '@canvas/auth'
import type { EditorCollaborationPatch, EditorCollaborationSnapshot, EditorPersistenceIntent } from '@canvas/editor/capabilities'
import type { ApplicationUpdateRequest, ApplicationUpdateResponse, ApplicationUpdateSnapshot } from '@canvas/editor/updates'

export type DesktopProjectSnapshot = ProjectSnapshot & { preview: PreviewSnapshot }
export type DesktopSaveResult = Omit<SaveResult, 'snapshot'> & { snapshot: DesktopProjectSnapshot }
export type ConnectedRepositoryScan = Readonly<{ repository: ConnectedRepository; scan: ShadcnScan; registry: ShadcnComponentCatalog }>
export type DesktopFileSummary = Readonly<{
  id: string
  name: string
  location: string
  updatedAt?: string
  thumbnailUrl?: string
}>

export type DesignEditorApi = Readonly<{
  allowUnauthenticatedWorkspace: boolean
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
  saveFile(file: FileDocument, expectedRevision: number, intent?: EditorPersistenceIntent): Promise<DesktopProjectSnapshot>
  savePrepared(id: string, approvalDigest: string): Promise<DesktopSaveResult>
  refresh(): Promise<DesktopProjectSnapshot>
  getAuthSession(): Promise<AuthSessionView>
  signInWithGitHub(): Promise<AuthSessionView>
  signOut(): Promise<AuthSessionView>
  onAuthSessionChanged(listener: (session: AuthSessionView) => void): () => void
  getCollaborationSnapshot(): Promise<EditorCollaborationSnapshot>
  updateCollaborationAwareness(patch: EditorCollaborationPatch, options?: Readonly<{ immediate?: boolean }>): Promise<void>
  retryCollaboration(): Promise<void>
  leaveCollaboration(): Promise<void>
  onCollaborationChanged(listener: (snapshot: EditorCollaborationSnapshot) => void): () => void
  onFileChanged(listener: (snapshot: DesktopProjectSnapshot) => void): () => void
  getUpdateSnapshot(): Promise<ApplicationUpdateSnapshot>
  checkForUpdate(): Promise<ApplicationUpdateSnapshot>
  downloadUpdate(): Promise<ApplicationUpdateSnapshot>
  installUpdate(): Promise<ApplicationUpdateSnapshot>
  onUpdateChanged(listener: (snapshot: ApplicationUpdateSnapshot) => void): () => void
}>

export type RepositoryRequest =
  | { method: 'listFiles' | 'createFile' | 'inspectFixture' | 'refresh' | 'scanShadcn'; args: [] }
  | { method: 'openFile'; args: [string] }
  | { method: 'prepareLabelPadding' | 'prepareToken' | 'preparePromotion' | 'prepareUndo' | 'prepareRedo'; args: [string] }
  | { method: 'savePrepared'; args: [string, string] }
  | { method: 'saveFile'; args: [FileDocument, number, EditorPersistenceIntent?] }

export type RepositoryResult = ProjectSnapshot | PreparedChange | SaveResult | DesktopProjectSnapshot | DesktopSaveResult | ShadcnScan | DesktopFileSummary | readonly DesktopFileSummary[]

export type RepositoryResponse =
  | { ok: true; value: RepositoryResult }
  | { ok: false; error: string; reference?: string }

export const repositoryChannel = 'design-editor:repository'

export type RepositoryConnectionRequest =
  | { method: 'pickLocal' | 'getCurrent' | 'scanCurrent'; args: [] }
  | { method: 'cloneGitHub'; args: [GitHubCloneRequest] }

export type RepositoryConnectionResponse =
  | { ok: true; value: ConnectedRepositoryScan | null }
  | { ok: false; error: string; reference?: string }

export const repositoryConnectionChannel = 'design-editor:repository-connection'

export type AuthRequest = { method: 'getSession' | 'signInWithGitHub' | 'signOut'; args: [] }

export type AuthResponse =
  | { ok: true; value: AuthSessionView }
  | { ok: false; error: string; reference?: string }

export const authChannel = 'design-editor:auth'
export const authSessionChangedChannel = 'design-editor:auth-session-changed'

export type CollaborationRequest =
  | { method: 'getSnapshot' | 'retry' | 'leave'; args: [] }
  | { method: 'updateAwareness'; args: [EditorCollaborationPatch, Readonly<{ immediate?: boolean }> | undefined] }

export type CollaborationResponse =
  | { ok: true; value: EditorCollaborationSnapshot | null }
  | { ok: false; error: string; reference?: string }

export const collaborationChannel = 'design-editor:collaboration'
export const collaborationChangedChannel = 'design-editor:collaboration-changed'
export const fileChangedChannel = 'design-editor:file-changed'
export const updateChannel = 'design-editor:update'
export const updateChangedChannel = 'design-editor:update-changed'
export type UpdateRequest = ApplicationUpdateRequest
export type UpdateResponse = ApplicationUpdateResponse

declare global {
  interface Window {
    designEditor: DesignEditorApi
  }
}
