import type { FileEdit, FilePayload, JsonObject, PersistedFileEditBatch } from '@canvas/sync-protocol'

export type SyncPrincipal = Readonly<{ subjectId: string }>

export type SyncConnectionRequest = Readonly<{
  url: string
  headers: Readonly<Record<string, string>>
  origin?: string
  remoteAddress?: string
  scopedFileId?: string
  scopedClientId?: string
}>

export type FileAuthorizationAction = 'read' | 'write' | 'presence'
export type SyncAuthorizer = Readonly<{
  authorizeConnection(request: SyncConnectionRequest): Promise<SyncPrincipal | null>
  authorizeFile(input: Readonly<{ principal: SyncPrincipal; request: SyncConnectionRequest; fileId: string; action: FileAuthorizationAction }>): Promise<boolean>
}>

export type SyncSocket = Readonly<{
  send(data: string): void | Promise<void>
  close(code: number, reason: string): void
}>

export type CommitFileEditInput = Readonly<{
  fileId: string
  subjectId: string
  clientId: string
  clientMutationId: string
  baseRevision: number
  edits: readonly FileEdit[]
}>

export type CommitFileEditResult =
  | Readonly<{ status: 'applied'; batch: PersistedFileEditBatch }>
  | Readonly<{ status: 'duplicate'; batch: PersistedFileEditBatch }>
  | Readonly<{ status: 'conflict'; serverRevision: number; batches: readonly PersistedFileEditBatch[] | null }>
  | Readonly<{ status: 'mutation_id_reused'; serverRevision: number }>
  | Readonly<{ status: 'invalid_edit'; serverRevision: number }>
  | Readonly<{ status: 'not_found' }>

export type OpenFileSyncResult =
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'ahead'; serverRevision: number }>
  | Readonly<{ status: 'payload'; payload: FilePayload; reason: 'bootstrap' | 'history_unavailable' }>
  | Readonly<{ status: 'ready'; fileId: string; serverRevision: number }>
  | Readonly<{ status: 'catchup'; fileId: string; fromRevision: number; serverRevision: number; batches: readonly PersistedFileEditBatch[] }>

/** Storage must make `open` a consistent snapshot and `commit` one atomic revision/idempotency transaction. */
export type SyncRepository = Readonly<{
  open(fileId: string, afterRevision?: number): Promise<OpenFileSyncResult>
  commit(input: CommitFileEditInput): Promise<CommitFileEditResult>
}>

export type SeedFile = Readonly<{ fileId: string; serverRevision?: number; document: JsonObject }>
