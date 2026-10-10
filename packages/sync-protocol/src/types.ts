export const syncProtocolVersion = 1 as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type PathSegment = string | number

export type SetFileEdit = Readonly<{
  type: 'set'
  path: readonly PathSegment[]
  value: JsonValue
}>

export type DeleteFileEdit = Readonly<{
  type: 'delete'
  path: readonly PathSegment[]
}>

export type SpliceFileEdit = Readonly<{
  type: 'splice'
  path: readonly PathSegment[]
  index: number
  deleteCount: number
  values: readonly JsonValue[]
}>

/** A deterministic edit against the normalized file payload. The server validates the resulting document before commit. */
export type FileEdit = SetFileEdit | DeleteFileEdit | SpliceFileEdit

export type FileEditBatch = Readonly<{
  clientMutationId: string
  baseRevision: number
  edits: readonly FileEdit[]
}>

/** Canonical bootstrap state. `document` remains JSON-safe so the protocol package does not own the editor schema. */
export type FilePayload = Readonly<{
  fileId: string
  serverRevision: number
  document: JsonObject
}>

export type PersistedFileEditBatch = Readonly<{
  fileId: string
  subjectId: string
  clientId: string
  clientMutationId: string
  baseRevision: number
  serverRevision: number
  edits: readonly FileEdit[]
  committedAt: string
}>

export type FileSubscribeMessage = Readonly<{
  type: 'file.subscribe'
  protocolVersion: typeof syncProtocolVersion
  requestId: string
  fileId: string
  clientId: string
  afterRevision?: number
}>

export type FileEditBatchMessage = Readonly<{
  type: 'file.edit.batch'
  protocolVersion: typeof syncProtocolVersion
  fileId: string
  clientId: string
  clientMutationId: string
  baseRevision: number
  edits: readonly FileEdit[]
}>

export type FilePresenceMessage = Readonly<{
  type: 'file.presence'
  protocolVersion: typeof syncProtocolVersion
  fileId: string
  clientId: string
  sequence: number
  data: JsonObject
}>

export type ClientSyncMessage = FileSubscribeMessage | FileEditBatchMessage | FilePresenceMessage

export type FilePayloadMessage = Readonly<{
  type: 'file.payload'
  protocolVersion: typeof syncProtocolVersion
  requestId: string
  payload: FilePayload
  reason: 'bootstrap' | 'history_unavailable'
}>

export type FileCatchUpMessage = Readonly<{
  type: 'file.catchup'
  protocolVersion: typeof syncProtocolVersion
  requestId: string
  fileId: string
  fromRevision: number
  serverRevision: number
  batches: readonly PersistedFileEditBatch[]
}>

export type FileReadyMessage = Readonly<{
  type: 'file.ready'
  protocolVersion: typeof syncProtocolVersion
  requestId: string
  fileId: string
  serverRevision: number
}>

export type FileEditAckMessage = Readonly<{
  type: 'file.ack'
  protocolVersion: typeof syncProtocolVersion
  fileId: string
  clientMutationId: string
  baseRevision: number
  serverRevision: number
  status: 'applied' | 'duplicate'
}>

export type FileEditAppliedMessage = Readonly<{
  type: 'file.edit.applied'
  protocolVersion: typeof syncProtocolVersion
  batch: PersistedFileEditBatch
}>

export type FileConflictMessage = Readonly<{
  type: 'file.conflict'
  protocolVersion: typeof syncProtocolVersion
  fileId: string
  clientMutationId: string
  baseRevision: number
  serverRevision: number
  code: 'stale_revision'
  retry: 'resubscribe'
  batches?: readonly PersistedFileEditBatch[]
}>

export type FilePresenceBroadcastMessage = Readonly<{
  type: 'file.presence'
  protocolVersion: typeof syncProtocolVersion
  fileId: string
  subjectId: string
  clientId: string
  sequence: number
  data: JsonObject
}>

export type SyncErrorCode =
  | 'invalid_message'
  | 'unsupported_protocol'
  | 'unauthorized'
  | 'forbidden'
  | 'file_scope_mismatch'
  | 'not_subscribed'
  | 'mutation_id_reused'
  | 'invalid_edit'
  | 'file_not_found'
  | 'internal_error'

export type SyncErrorMessage = Readonly<{
  type: 'error'
  protocolVersion: typeof syncProtocolVersion
  code: SyncErrorCode
  message: string
  requestId?: string
  clientMutationId?: string
}>

export type ServerSyncMessage =
  | FilePayloadMessage
  | FileCatchUpMessage
  | FileReadyMessage
  | FileEditAckMessage
  | FileEditAppliedMessage
  | FileConflictMessage
  | FilePresenceBroadcastMessage
  | SyncErrorMessage
