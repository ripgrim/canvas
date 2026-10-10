import { randomUUID } from 'node:crypto'
import type { CloudFile, CloudFileDocument, CloudFileSummary, CloudProject, ControlPlaneStore, FileThumbnailMetadata, JsonValue } from './index.js'
import { emptyCanvasDocument } from './index.js'

type OwnedProject = CloudProject & Readonly<{ ownerUserId: string }>
type OwnedFile = CloudFile & Readonly<{ ownerUserId: string }>
type OwnedDocument = CloudFileDocument & Readonly<{ ownerUserId: string }>

const now = () => new Date().toISOString()

/** Deterministic process-local adapter for API tests and explicit local development only. */
export function createMemoryControlPlane(): ControlPlaneStore {
  const projects = new Map<string, OwnedProject>()
  const files = new Map<string, OwnedFile>()
  const documents = new Map<string, OwnedDocument>()
  const store: ControlPlaneStore = {
    async listProjects(ownerUserId) {
      return Object.freeze([...projects.values()].filter(project => project.ownerUserId === ownerUserId).sort(updatedFirst).map(publicProject))
    },
    async createProject(ownerUserId, name) {
      const timestamp = now()
      const project = Object.freeze({ id: randomUUID(), ownerUserId, name, createdAt: timestamp, updatedAt: timestamp })
      projects.set(project.id, project)
      return publicProject(project)
    },
    async getProject(ownerUserId, projectId) {
      const project = projects.get(projectId)
      if (!project || project.ownerUserId !== ownerUserId) return null
      return publicProject(project)
    },
    async listFiles(ownerUserId) {
      return Object.freeze([...files.values()].filter(file => file.ownerUserId === ownerUserId).sort(updatedFirst).map(publicFile))
    },
    async createFile(ownerUserId, name, projectId) {
      if (projectId && projects.get(projectId)?.ownerUserId !== ownerUserId) throw new Error('Project was not found.')
      const timestamp = now()
      const file = Object.freeze({ id: randomUUID(), ownerUserId, projectId, name, headRevision: 0, thumbnailKey: null, createdAt: timestamp, updatedAt: timestamp })
      files.set(file.id, file)
      documents.set(file.id, Object.freeze({ fileId: file.id, ownerUserId, revision: 0, document: emptyCanvasDocument(file.id, randomUUID(), randomUUID()), updatedAt: timestamp }))
      return publicFile(file)
    },
    async getFile(ownerUserId, fileId) {
      const file = files.get(fileId)
      if (!file || file.ownerUserId !== ownerUserId) return null
      return publicFile(file)
    },
    async getFileDocument(ownerUserId, fileId) {
      const document = documents.get(fileId)
      if (!document || document.ownerUserId !== ownerUserId) return null
      return publicDocument(document)
    },
    async saveFileDocument(ownerUserId, fileId, expectedRevision, document) {
      const current = documents.get(fileId)
      if (!current || current.ownerUserId !== ownerUserId) return Object.freeze({ status: 'not-found' })
      if (current.revision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision: current.revision })
      const timestamp = now()
      const saved = Object.freeze({ fileId, ownerUserId, revision: current.revision + 1, document: Object.freeze(structuredClone(document)), updatedAt: timestamp })
      documents.set(fileId, saved)
      const file = files.get(fileId)!
      files.set(fileId, Object.freeze({ ...file, headRevision: saved.revision, thumbnailKey: null, updatedAt: timestamp }))
      return Object.freeze({ status: 'saved', document: publicDocument(saved) })
    },
    async setFileThumbnail(ownerUserId, fileId, expectedRevision, thumbnailKey) {
      const file = files.get(fileId)
      if (!file || file.ownerUserId !== ownerUserId) return Object.freeze({ status: 'not-found' })
      if (file.headRevision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision: file.headRevision })
      files.set(fileId, Object.freeze({ ...file, thumbnailKey }))
      return Object.freeze({ status: 'saved', thumbnail: publicThumbnail(fileId, expectedRevision, thumbnailKey) })
    },
  }
  return Object.freeze(store)
}

const updatedFirst = <T extends { updatedAt: string; id?: string; fileId?: string }>(left: T, right: T) => right.updatedAt.localeCompare(left.updatedAt) || (left.id ?? left.fileId ?? '').localeCompare(right.id ?? right.fileId ?? '')
const publicProject = ({ ownerUserId: _owner, ...project }: OwnedProject): CloudProject => Object.freeze(project)
const publicFile = ({ ownerUserId: _owner, ...file }: OwnedFile): CloudFileSummary => Object.freeze(file)
const publicDocument = ({ ownerUserId: _owner, ...document }: OwnedDocument): CloudFileDocument => Object.freeze(document)
const publicThumbnail = (fileId: string, revision: number, thumbnailKey: string | null): FileThumbnailMetadata => Object.freeze({ fileId, revision, thumbnailKey })
