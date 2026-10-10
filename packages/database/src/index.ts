export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[]

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

export type DocumentSaveResult =
  | Readonly<{ status: 'saved'; document: CloudFileDocument }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>
  | Readonly<{ status: 'not-found' }>

export interface ControlPlaneStore {
  listProjects(ownerUserId: string): Promise<readonly CloudProject[]>
  createProject(ownerUserId: string, name: string): Promise<CloudProject>
  getProject(ownerUserId: string, projectId: string): Promise<CloudProject | null>
  listFiles(ownerUserId: string): Promise<readonly CloudFileSummary[]>
  createFile(ownerUserId: string, name: string, projectId: string | null): Promise<CloudFile>
  getFile(ownerUserId: string, fileId: string): Promise<CloudFile | null>
  getFileDocument(ownerUserId: string, fileId: string): Promise<CloudFileDocument | null>
  saveFileDocument(ownerUserId: string, fileId: string, expectedRevision: number, document: Readonly<Record<string, JsonValue>>): Promise<DocumentSaveResult>
}

export function emptyCanvasDocument(fileId: string, pageId: string, rootNodeId: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    schemaVersion: 6,
    fileId,
    revision: 0,
    pages: Object.freeze([Object.freeze({ id: pageId, name: 'Page 1', rootNodeId })]),
    nodes: Object.freeze({ [rootNodeId]: Object.freeze({ id: rootNodeId, type: 'root' }) }),
    relationships: Object.freeze({}),
    theme: Object.freeze({ tokens: Object.freeze({}) }),
  })
}
