export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[]

export * from './collaboration.js'

export type CloudProject = Readonly<{
  id: string
  name: string
  createdAt: string
  updatedAt: string
}>

export type CloudFileSummary = Readonly<{
  id: string
  projectId: string | null
  name: string
  headRevision: number
  thumbnailKey: string | null
  createdAt: string
  updatedAt: string
}>

export type CloudFile = CloudFileSummary

export type CloudFileDocument = Readonly<{
  fileId: string
  revision: number
  document: Readonly<Record<string, JsonValue>>
  updatedAt: string
}>

export type FileShareAccess = 'private' | 'view'

export type FileShare = Readonly<{
  fileId: string
  access: FileShareAccess
  updatedAt: string
}>

export type FileAccessRole = 'owner' | 'viewer'

export type FileAccessAuthorization = Readonly<{
  fileId: string
  subjectUserId: string
  role: FileAccessRole
  accessEpoch: bigint
}>

export type SharedFile = Readonly<{
  file: Readonly<{
    id: string
    name: string
    headRevision: number
    updatedAt: string
  }>
  document: CloudFileDocument
}>

export type DocumentSaveResult =
  | Readonly<{ status: 'saved'; document: CloudFileDocument }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>
  | Readonly<{ status: 'collaboration-authoritative' }>
  | Readonly<{ status: 'not-found' }>

export type FileMetadataMutationResult =
  | Readonly<{ status: 'saved'; file: CloudFile }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>
  | Readonly<{ status: 'not-found' }>

export type LegacyDocumentExternalizationResult =
  | Readonly<{ status: 'saved' | 'unchanged'; document: CloudFileDocument }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>
  | Readonly<{ status: 'collaboration-authoritative' }>
  | Readonly<{ status: 'not-found' }>

export type DocumentInvariantRepairResult =
  | Readonly<{ status: 'saved' | 'unchanged'; document: CloudFileDocument }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>
  | Readonly<{ status: 'collaboration-active' }>
  | Readonly<{ status: 'not-found' }>

export type FileThumbnailMetadata = Readonly<{
  fileId: string
  revision: number
  thumbnailKey: string | null
  thumbnailEtag: string | null
}>
export type InternalFileThumbnail = FileThumbnailMetadata & Readonly<{ ownerUserId: string }>

export type ThumbnailUpdateResult =
  | Readonly<{ status: 'saved'; thumbnail: FileThumbnailMetadata }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>
  | Readonly<{ status: 'not-found' }>

export type ThumbnailCaptureJob = Readonly<{
  id: string
  fileId: string
  revision: number
  leaseId: string
  leaseExpiresAt: string
  attempts: number
}>

export type HostedPreviewArtifactRecord = Readonly<{
  artifactId: string
  fileId: string
  fileRevision: number
  sourceRevision: string
  registryFingerprint: string
  entrypoint: string
}>

export type HostedPreviewArtifactRegistration =
  | Readonly<{ status: 'registered'; artifact: HostedPreviewArtifactRecord }>
  | Readonly<{ status: 'unchanged'; artifact: HostedPreviewArtifactRecord }>
  | Readonly<{ status: 'revision-conflict'; currentRevision: number }>
  | Readonly<{ status: 'identity-conflict' }>
  | Readonly<{ status: 'not-found' }>

export type HostedPreviewBuildJob = Readonly<{
  id: string
  fileId: string
  fileRevision: number
  projectId: string
  scanJobId: string
  artifactId: string
  stagingId: string
  status: 'queued' | 'leased' | 'completed' | 'failed'
  attempts: number
  leaseId: string | null
  leaseExpiresAt: string | null
  nextAttemptAt: string | null
  errorId: string | null
  createdAt: string
  completedAt: string | null
  failedAt: string | null
}>

export type HostedPreviewBuildJobCreate = Readonly<{
  id: string
  ownerUserId: string
  fileId: string
  fileRevision: number
  projectId: string
  scanJobId: string
  artifactId: string
  stagingId: string
  createdAt: Date
}>

export interface ControlPlaneStore {
  listProjects(ownerUserId: string): Promise<readonly CloudProject[]>
  createProject(ownerUserId: string, name: string): Promise<CloudProject>
  getProject(ownerUserId: string, projectId: string): Promise<CloudProject | null>
  listFiles(ownerUserId: string): Promise<readonly CloudFileSummary[]>
  createFile(ownerUserId: string, name: string, projectId: string | null): Promise<CloudFile>
  getFile(ownerUserId: string, fileId: string): Promise<CloudFile | null>
  renameFile(ownerUserId: string, fileId: string, expectedRevision: number, name: string): Promise<FileMetadataMutationResult>
  getFileThumbnail(ownerUserId: string, fileId: string): Promise<FileThumbnailMetadata | null>
  getFileThumbnailForCapture(fileId: string): Promise<InternalFileThumbnail | null>
  getFileDocument(ownerUserId: string, fileId: string): Promise<CloudFileDocument | null>
  getFileDocumentForCapture(fileId: string): Promise<CloudFileDocument | null>
  getFileShare(ownerUserId: string, fileId: string): Promise<FileShare | null>
  setFileShare(ownerUserId: string, fileId: string, access: FileShareAccess): Promise<FileShare | null>
  resolveFileAccess(subjectUserId: string, fileId: string): Promise<FileAccessAuthorization | null>
  getSharedFile(fileId: string): Promise<SharedFile | null>
  /** Replaces inline legacy bytes with trusted immutable references without creating a semantic document revision. */
  externalizeLegacyFileDocument(fileId: string, expectedRevision: number, source: Readonly<Record<string, JsonValue>>, document: Readonly<Record<string, JsonValue>>): Promise<LegacyDocumentExternalizationResult>
  /** Applies a validated invariant-only repair with exact source matching and without creating a semantic revision. */
  repairFileDocumentInvariant(fileId: string, expectedRevision: number, source: Readonly<Record<string, JsonValue>>, document: Readonly<Record<string, JsonValue>>): Promise<DocumentInvariantRepairResult>
  saveFileDocument(ownerUserId: string, fileId: string, expectedRevision: number, document: Readonly<Record<string, JsonValue>>): Promise<DocumentSaveResult>
  setFileThumbnail(ownerUserId: string, fileId: string, expectedRevision: number, thumbnailKey: string, thumbnailEtag: string): Promise<ThumbnailUpdateResult>
  setFileThumbnailForCapture(fileId: string, expectedRevision: number, thumbnailKey: string, thumbnailEtag: string): Promise<ThumbnailUpdateResult>
  claimThumbnailCaptureJob(now: Date, leaseExpiresAt: Date): Promise<ThumbnailCaptureJob | null>
  completeThumbnailCaptureJob(jobId: string, leaseId: string, completedAt: Date): Promise<boolean>
  releaseThumbnailCaptureJob(jobId: string, leaseId: string): Promise<boolean>
  createHostedPreviewBuildJob(input: HostedPreviewBuildJobCreate): Promise<HostedPreviewBuildJob | null>
  getHostedPreviewBuildJob(ownerUserId: string, jobId: string): Promise<HostedPreviewBuildJob | null>
  claimHostedPreviewBuildJob(now: Date, leaseExpiresAt: Date): Promise<HostedPreviewBuildJob | null>
  isCurrentHostedPreviewBuildLease(jobId: string, leaseId: string, now: Date): Promise<boolean>
  completeHostedPreviewBuildJob(jobId: string, leaseId: string, completedAt: Date): Promise<boolean>
  retryHostedPreviewBuildJob(jobId: string, leaseId: string, retryAt: Date, nextAttemptAt: Date): Promise<boolean>
  failHostedPreviewBuildJob(jobId: string, leaseId: string, errorId: string, failedAt: Date): Promise<boolean>
  registerHostedPreviewArtifact(artifact: HostedPreviewArtifactRecord): Promise<HostedPreviewArtifactRegistration>
  authorizeHostedPreviewArtifact(subjectUserId: string, fileId: string, artifactId: string): Promise<HostedPreviewArtifactRecord | null>
}

export function emptyCanvasDocument(fileId: string, pageId: string, rootNodeId: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    schemaVersion: 13,
    fileId,
    revision: 0,
    pages: Object.freeze([Object.freeze({ id: pageId, name: 'Page 1', rootNodeId })]),
    nodes: Object.freeze({ [rootNodeId]: Object.freeze({ id: rootNodeId, type: 'root' }) }),
    relationships: Object.freeze({}),
    theme: Object.freeze({ tokens: Object.freeze({}) }),
    componentModel: Object.freeze({ definitions: Object.freeze({}), instances: Object.freeze({}) }),
  })
}
