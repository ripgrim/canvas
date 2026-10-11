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

export type LegacyDocumentExternalizationResult =
  | Readonly<{ status: 'saved' | 'unchanged'; document: CloudFileDocument }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>
  | Readonly<{ status: 'collaboration-authoritative' }>
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

export interface ControlPlaneStore {
  listProjects(ownerUserId: string): Promise<readonly CloudProject[]>
  createProject(ownerUserId: string, name: string): Promise<CloudProject>
  getProject(ownerUserId: string, projectId: string): Promise<CloudProject | null>
  listFiles(ownerUserId: string): Promise<readonly CloudFileSummary[]>
  createFile(ownerUserId: string, name: string, projectId: string | null): Promise<CloudFile>
  getFile(ownerUserId: string, fileId: string): Promise<CloudFile | null>
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
  saveFileDocument(ownerUserId: string, fileId: string, expectedRevision: number, document: Readonly<Record<string, JsonValue>>): Promise<DocumentSaveResult>
  setFileThumbnail(ownerUserId: string, fileId: string, expectedRevision: number, thumbnailKey: string, thumbnailEtag: string): Promise<ThumbnailUpdateResult>
  setFileThumbnailForCapture(fileId: string, expectedRevision: number, thumbnailKey: string, thumbnailEtag: string): Promise<ThumbnailUpdateResult>
  claimThumbnailCaptureJob(now: Date, leaseExpiresAt: Date): Promise<ThumbnailCaptureJob | null>
  completeThumbnailCaptureJob(jobId: string, leaseId: string, completedAt: Date): Promise<boolean>
  releaseThumbnailCaptureJob(jobId: string, leaseId: string): Promise<boolean>
}

export function emptyCanvasDocument(fileId: string, pageId: string, rootNodeId: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    schemaVersion: 7,
    fileId,
    revision: 0,
    pages: Object.freeze([Object.freeze({ id: pageId, name: 'Page 1', rootNodeId })]),
    nodes: Object.freeze({ [rootNodeId]: Object.freeze({ id: rootNodeId, type: 'root' }) }),
    relationships: Object.freeze({}),
    theme: Object.freeze({ tokens: Object.freeze({}) }),
  })
}
