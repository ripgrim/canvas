import type { PreparedChange, ProjectSnapshot, SaveResult } from '@canvas/repo-engine/contracts'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { PreviewSnapshot } from '@canvas/preview-runtime/browser-contracts'
import type { ConnectedRepository, GitHubCloneRequest } from '@canvas/repository'
import type { ShadcnScan } from '@canvas/scanner/contracts'
import type { AuthSessionView } from '@canvas/auth'

export type CapabilityState = Readonly<{ available: boolean; reason: string }>
export type EditorFile = Readonly<{ id: string; name: string; location: string; updatedAt?: string; thumbnailUrl?: string }>
export type EditorPage = Readonly<{ id: string; name: string }>
export type EditorCapabilities = Readonly<{
  runtime: 'browser' | 'desktop'
  openLabel: string
  files: Readonly<{ list: CapabilityState; create: CapabilityState; open: CapabilityState }>
  sourceWrites: CapabilityState
  localRepository: CapabilityState
  hostedExecution: CapabilityState
  git: CapabilityState
  mcp: CapabilityState
  hostedProjects: CapabilityState
}>
/** Snapshot of an open file: the normalized design file plus source metadata and the running preview. Pages and view state are not adapter concerns. */
export type EditorProjectSnapshot = ProjectSnapshot & { fileId?: string; preview: PreviewSnapshot }
export type EditorSaveResult = Omit<SaveResult, 'snapshot'> & { snapshot: EditorProjectSnapshot }
export type EditorRepositoryConnection = Readonly<{ repository: ConnectedRepository; scan: ShadcnScan }>
export type EditorAuthApi = Readonly<{
  getSession(): Promise<AuthSessionView>
  signInWithGitHub(): Promise<AuthSessionView>
  signOut(): Promise<AuthSessionView>
  subscribe(listener: (session: AuthSessionView) => void): () => void
}>
export type EditorProjectApi = Readonly<{
  capabilities?: EditorCapabilities
  auth?: EditorAuthApi
  listFiles?(): Promise<readonly EditorFile[]>
  createFile?(): Promise<EditorFile>
  openFile?(fileId: string): Promise<EditorProjectSnapshot>
  openProject(): Promise<EditorProjectSnapshot>
  pickLocalRepository?(): Promise<EditorRepositoryConnection | null>
  cloneGitHubRepository?(input: GitHubCloneRequest): Promise<EditorRepositoryConnection>
  getConnectedRepository?(): Promise<EditorRepositoryConnection | null>
  rescanConnectedRepository?(): Promise<EditorRepositoryConnection>
  refresh(): Promise<EditorProjectSnapshot>
  /** Persists the whole design file. Rejects when `expectedRevision` is not the stored revision (stale tab protection). */
  saveFile(file: FileDocument, expectedRevision: number): Promise<EditorProjectSnapshot>
  prepareLabelPadding(padding: string): Promise<PreparedChange>
  prepareToken(value: string): Promise<PreparedChange>
  preparePromotion(name: string): Promise<PreparedChange>
  prepareUndo(transactionId: string): Promise<PreparedChange>
  prepareRedo(transactionId: string): Promise<PreparedChange>
  savePrepared(id: string, approvalDigest: string): Promise<EditorSaveResult>
}>

export class UnavailableCapabilityError extends Error {
  constructor(reason: string) { super(reason); this.name = 'UnavailableCapabilityError' }
}

export const unavailableCapabilities: EditorCapabilities = {
  runtime: 'browser', openLabel: 'Open project',
  files: {
    list: { available: false, reason: 'File listing is unavailable.' },
    create: { available: false, reason: 'File creation is unavailable.' },
    open: { available: false, reason: 'File opening is unavailable.' },
  },
  sourceWrites: { available: false, reason: 'Source editing needs a connected repository.' },
  localRepository: { available: false, reason: 'Local repository access is not connected.' },
  hostedExecution: { available: false, reason: 'Hosted repository execution is not connected.' },
  git: { available: false, reason: 'Git operations are not available.' },
  mcp: { available: false, reason: 'MCP is deferred.' },
  hostedProjects: { available: false, reason: 'Hosted projects are not connected.' },
}
