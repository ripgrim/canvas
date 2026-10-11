import type { PreparedChange, ProjectSnapshot, SaveResult } from '@canvas/repo-engine/contracts'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import type { ImageAssetReference, ImageMime } from '@canvas/repo-engine/appearance'
import type { PreviewSnapshot } from '@canvas/preview-runtime/browser-contracts'
import type { ConnectedRepository, GitHubCloneRequest } from '@canvas/repository'
import type { ShadcnComponentCatalog, ShadcnScan } from '@canvas/scanner/contracts'
import type { AuthSessionView } from '@canvas/auth'

export type CapabilityState = Readonly<{ available: boolean; reason: string }>
export type EditorFile = Readonly<{ id: string; name: string; location: string; updatedAt?: string; thumbnailUrl?: string }>
export type EditorPage = Readonly<{ id: string; name: string }>
export type EditorFileShare = Readonly<{ fileId: string; access: 'private' | 'view'; updatedAt: string }>
export type EditorCollaborationPoint = Readonly<{ pageId: string; x: number; y: number }>
export type EditorCollaborationCamera = EditorCollaborationPoint & Readonly<{ zoom: number }>
export type EditorCollaborationSelection = Readonly<{ pageId: string; nodeIds: readonly string[] }>
export type EditorCollaborationTransform = Readonly<{ nodeId: string; dx: number; dy: number; width?: number; height?: number }>
export type EditorCollaborationInteraction = Readonly<{ interactionId: string; pageId: string; kind: 'move' | 'resize'; nodeIds: readonly string[]; transforms: readonly EditorCollaborationTransform[] }>
export type EditorCollaborationAwareness = Readonly<{
  pageId: string | null
  focused: boolean
  selection: EditorCollaborationSelection | null
  camera: EditorCollaborationCamera | null
  cursor: EditorCollaborationPoint | null
  interaction?: EditorCollaborationInteraction | null
}>
export type EditorCollaborationRole = 'owner' | 'viewer'
export type EditorCollaborationLocalProfile = Readonly<{
  subjectId: string
  displayName: string
  avatarUrl: string | null
  role: EditorCollaborationRole
}>
export type EditorCollaborationParticipant = Readonly<{
  presenceId: string
  subjectId: string
  displayName: string
  avatarUrl: string | null
  clientId: string
  role: EditorCollaborationRole
  isHeadless: boolean
  sequence: number | null
  awareness: EditorCollaborationAwareness
}>
export type EditorCollaborationAgent = Readonly<{
  agentId: string
  displayName: string
  harness: string
  userId: string | null
}>
export type EditorCollaborationSnapshot = Readonly<{
  status: 'unavailable' | 'connecting' | 'live' | 'read-only' | 'reconnecting' | 'error'
  /** Stable product state for the collaboration shell. Transport-specific phases stay behind the adapter. */
  shellState?: 'opening' | 'connecting' | 'reconnecting' | 'access-removed' | 'update-required' | 'file-busy' | null
  localClientId: string | null
  localProfile: EditorCollaborationLocalProfile | null
  canMutate: boolean
  canManageShare: boolean
  participants: readonly EditorCollaborationParticipant[]
  agents: readonly EditorCollaborationAgent[]
  error: string | null
}>
export type EditorCollaborationPatch = Readonly<{
  pageId?: string | null
  focused?: boolean
  selection?: EditorCollaborationSelection | null
  camera?: EditorCollaborationCamera | null
  cursor?: EditorCollaborationPoint | null
  interaction?: EditorCollaborationInteraction | null
}>
export type EditorCollaborationApi = Readonly<{
  subscribe(listener: () => void): () => void
  getSnapshot(): EditorCollaborationSnapshot
  updateAwareness(patch: EditorCollaborationPatch, options?: Readonly<{ immediate?: boolean }>): void
  /** Re-enters authorization and admission after a recoverable terminal state. */
  retry?(): void
  /** Leaves the current file after a terminal state without retaining rendered file data. */
  leave?(): void
}>
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
/** Verified render bytes for one immutable asset. Bytes stay outside the document, history, and persistence payloads. */
export type EditorAssetPreview = Readonly<{ assetId: string; sha256: string; mime: ImageMime; data: string }>
export type EditorAssetUpload = Readonly<{ fileId: string; asset: ImageAssetReference; bytes: Uint8Array }>
export type EditorAssetUploadResult = Readonly<{ asset: ImageAssetReference; preview: EditorAssetPreview }>
export type EditorAssetApi = Readonly<{
  uploadImage(input: EditorAssetUpload): Promise<EditorAssetUploadResult>
}>
export type EditorProjectFailure = Readonly<{ operation: 'asset_hydration'; error: unknown }>
/** Snapshot of an open file: the normalized design file plus source metadata, verified render sidecars, and the running preview. Pages and view state are not adapter concerns. */
export type EditorProjectSnapshot = ProjectSnapshot & { fileId?: string; assetPreviews?: readonly EditorAssetPreview[]; preview: PreviewSnapshot }
export type EditorSaveResult = Omit<SaveResult, 'snapshot'> & { snapshot: EditorProjectSnapshot }
export type EditorPersistenceIntent = Readonly<{ kind: 'commands'; commands: readonly FileCommand[] }>
export type EditorRepositoryConnection = Readonly<{ repository: ConnectedRepository; scan: ShadcnScan; registry: ShadcnComponentCatalog }>
export type EditorAuthApi = Readonly<{
  /** Hosted public-file routes may keep the read-only workspace mounted while the account is signed out. */
  allowSignedOutWorkspace?: boolean
  getSession(): Promise<AuthSessionView>
  signInWithGitHub(): Promise<AuthSessionView>
  signOut(): Promise<AuthSessionView>
  subscribe(listener: (session: AuthSessionView) => void): () => void
}>
export type EditorProjectApi = Readonly<{
  capabilities?: EditorCapabilities
  auth?: EditorAuthApi
  collaboration?: EditorCollaborationApi
  assets?: EditorAssetApi
  subscribeFailures?(listener: (failure: EditorProjectFailure) => void): () => void
  listFiles?(): Promise<readonly EditorFile[]>
  createFile?(): Promise<EditorFile>
  openFile?(fileId: string): Promise<EditorProjectSnapshot>
  /** Opens only a server-authorized public view. A private or missing file returns null without revealing which it was. */
  openSharedFile?(fileId: string): Promise<EditorProjectSnapshot | null>
  /** Publishes newer snapshots for the currently open file. The consumer owns and must call the returned disposer. */
  subscribeFile?(listener: (snapshot: EditorProjectSnapshot) => void): () => void
  getFileShare?(fileId: string): Promise<EditorFileShare>
  setFileShare?(fileId: string, access: EditorFileShare['access']): Promise<EditorFileShare>
  shareUrl?(fileId: string): string
  openProject(): Promise<EditorProjectSnapshot>
  pickLocalRepository?(): Promise<EditorRepositoryConnection | null>
  cloneGitHubRepository?(input: GitHubCloneRequest): Promise<EditorRepositoryConnection>
  getConnectedRepository?(): Promise<EditorRepositoryConnection | null>
  rescanConnectedRepository?(): Promise<EditorRepositoryConnection>
  refresh(): Promise<EditorProjectSnapshot>
  /** Persists semantic commands against the newest live revision. The file is the caller's optimistic projection. */
  saveFile(file: FileDocument, expectedRevision: number, intent?: EditorPersistenceIntent): Promise<EditorProjectSnapshot>
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
