import { randomUUID } from 'node:crypto'
import type { CloudFile, CloudFileDocument, CloudFileSummary, CloudProject, ControlPlaneStore, FileShare, FileThumbnailMetadata, JsonValue, SharedFile, ThumbnailCaptureJob } from './index.js'
import { emptyCanvasDocument } from './index.js'

type OwnedProject = CloudProject & Readonly<{ ownerUserId: string }>
type OwnedFile = Omit<CloudFile, 'thumbnailKey'> & Readonly<{ ownerUserId: string; thumbnailKey: string | null; thumbnailEtag: string | null }>
type OwnedDocument = CloudFileDocument & Readonly<{ ownerUserId: string }>
type CaptureRecord = Readonly<{ id: string; fileId: string; revision: number; status: 'queued' | 'leased' | 'completed'; leaseId: string | null; leaseExpiresAt: string | null; attempts: number; createdAt: string }>

const now = () => new Date().toISOString()

export type MemoryControlPlaneOptions = Readonly<{
  isCollaborationAuthoritative?: (fileId: string) => boolean
}>

/** Deterministic process-local adapter for API tests and explicit local development only. */
export function createMemoryControlPlane(options: MemoryControlPlaneOptions = {}): ControlPlaneStore {
  const projects = new Map<string, OwnedProject>()
  const files = new Map<string, OwnedFile>()
  const documents = new Map<string, OwnedDocument>()
  const captureJobs = new Map<string, CaptureRecord>()
  const shares = new Map<string, FileShare>()
  const accessEpochs = new Map<string, bigint>()
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
      const file = Object.freeze({ id: randomUUID(), ownerUserId, projectId, name, headRevision: 0, thumbnailKey: null, thumbnailEtag: null, createdAt: timestamp, updatedAt: timestamp })
      files.set(file.id, file)
      accessEpochs.set(file.id, 1n)
      documents.set(file.id, Object.freeze({ fileId: file.id, ownerUserId, revision: 0, document: emptyCanvasDocument(file.id, randomUUID(), randomUUID()), updatedAt: timestamp }))
      enqueueCapture(captureJobs, file.id, 0, timestamp)
      return publicFile(file)
    },
    async getFile(ownerUserId, fileId) {
      const file = files.get(fileId)
      if (!file || file.ownerUserId !== ownerUserId) return null
      return publicFile(file)
    },
    async getFileThumbnail(ownerUserId, fileId) {
      const file = files.get(fileId)
      if (!file || file.ownerUserId !== ownerUserId) return null
      return publicThumbnail(fileId, file.headRevision, file.thumbnailKey, file.thumbnailEtag)
    },
    async getFileThumbnailForCapture(fileId) {
      const file = files.get(fileId)
      return file ? Object.freeze({ ...publicThumbnail(fileId, file.headRevision, file.thumbnailKey, file.thumbnailEtag), ownerUserId: file.ownerUserId }) : null
    },
    async getFileDocument(ownerUserId, fileId) {
      const document = documents.get(fileId)
      if (!document || document.ownerUserId !== ownerUserId) return null
      return publicDocument(document)
    },
    async getFileDocumentForCapture(fileId) {
      const document = documents.get(fileId)
      return document ? publicDocument(document) : null
    },
    async getFileShare(ownerUserId, fileId) {
      const file = files.get(fileId)
      if (!file || file.ownerUserId !== ownerUserId) return null
      return shares.get(fileId) ?? Object.freeze({ fileId, access: 'private', updatedAt: file.updatedAt })
    },
    async setFileShare(ownerUserId, fileId, access) {
      const file = files.get(fileId)
      if (!file || file.ownerUserId !== ownerUserId) return null
      const current = shares.get(fileId)?.access ?? 'private'
      if (current === access) return shares.get(fileId) ?? Object.freeze({ fileId, access, updatedAt: file.updatedAt })
      const share = Object.freeze({ fileId, access, updatedAt: now() })
      shares.set(fileId, share)
      accessEpochs.set(fileId, (accessEpochs.get(fileId) ?? 1n) + 1n)
      return share
    },
    async resolveFileAccess(subjectUserId, fileId) {
      if (subjectUserId.length < 1 || subjectUserId.length > 128) throw new Error('Subject user id must contain between 1 and 128 characters.')
      const file = files.get(fileId)
      if (!file) return null
      const role = file.ownerUserId === subjectUserId ? 'owner' : shares.get(fileId)?.access === 'view' ? 'viewer' : null
      return role ? Object.freeze({ fileId, subjectUserId, role, accessEpoch: accessEpochs.get(fileId) ?? 1n }) : null
    },
    async getSharedFile(fileId) {
      const share = shares.get(fileId)
      const file = files.get(fileId)
      const document = documents.get(fileId)
      if (share?.access !== 'view' || !file || !document) return null
      return publicSharedFile(file, document)
    },
    async externalizeLegacyFileDocument(fileId, expectedRevision, source, document) {
      const current = documents.get(fileId)
      if (!current) return Object.freeze({ status: 'not-found' })
      if (options.isCollaborationAuthoritative?.(fileId)) return Object.freeze({ status: 'collaboration-authoritative' })
      if (current.revision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision: current.revision })
      if (equalJson(current.document, document)) return Object.freeze({ status: 'unchanged', document: publicDocument(current) })
      if (!equalJson(current.document, source)) return Object.freeze({ status: 'conflict', currentRevision: current.revision })
      const saved = Object.freeze({ ...current, document: Object.freeze(structuredClone(document)) })
      documents.set(fileId, saved)
      return Object.freeze({ status: 'saved', document: publicDocument(saved) })
    },
    async saveFileDocument(ownerUserId, fileId, expectedRevision, document) {
      const current = documents.get(fileId)
      if (!current || current.ownerUserId !== ownerUserId) return Object.freeze({ status: 'not-found' })
      if (options.isCollaborationAuthoritative?.(fileId)) return Object.freeze({ status: 'collaboration-authoritative' })
      if (current.revision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision: current.revision })
      const timestamp = now()
      const saved = Object.freeze({ fileId, ownerUserId, revision: current.revision + 1, document: Object.freeze(structuredClone(document)), updatedAt: timestamp })
      documents.set(fileId, saved)
      const file = files.get(fileId)!
      files.set(fileId, Object.freeze({ ...file, headRevision: saved.revision, thumbnailKey: null, thumbnailEtag: null, updatedAt: timestamp }))
      enqueueCapture(captureJobs, fileId, saved.revision, timestamp)
      return Object.freeze({ status: 'saved', document: publicDocument(saved) })
    },
    async setFileThumbnail(ownerUserId, fileId, expectedRevision, thumbnailKey, thumbnailEtag) {
      const file = files.get(fileId)
      if (!file || file.ownerUserId !== ownerUserId) return Object.freeze({ status: 'not-found' })
      if (file.headRevision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision: file.headRevision })
      files.set(fileId, Object.freeze({ ...file, thumbnailKey, thumbnailEtag }))
      return Object.freeze({ status: 'saved', thumbnail: publicThumbnail(fileId, expectedRevision, thumbnailKey, thumbnailEtag) })
    },
    async setFileThumbnailForCapture(fileId, expectedRevision, thumbnailKey, thumbnailEtag) {
      const file = files.get(fileId)
      if (!file) return Object.freeze({ status: 'not-found' })
      if (file.headRevision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision: file.headRevision })
      files.set(fileId, Object.freeze({ ...file, thumbnailKey, thumbnailEtag }))
      return Object.freeze({ status: 'saved', thumbnail: publicThumbnail(fileId, expectedRevision, thumbnailKey, thumbnailEtag) })
    },
    async claimThumbnailCaptureJob(current, leaseExpiresAt) {
      const nowMs = current.getTime()
      const candidate = [...captureJobs.values()].filter(job => job.status === 'queued' || (job.status === 'leased' && Date.parse(job.leaseExpiresAt!) <= nowMs)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
      if (!candidate) return null
      const leased = Object.freeze({ ...candidate, status: 'leased' as const, leaseId: randomUUID(), leaseExpiresAt: leaseExpiresAt.toISOString(), attempts: candidate.attempts + 1 })
      captureJobs.set(candidate.id, leased)
      return publicCaptureJob(leased)
    },
    async completeThumbnailCaptureJob(jobId, leaseId) {
      const job = captureJobs.get(jobId)
      if (job?.status !== 'leased' || job.leaseId !== leaseId) return false
      captureJobs.set(jobId, Object.freeze({ ...job, status: 'completed', leaseId: null, leaseExpiresAt: null }))
      return true
    },
    async releaseThumbnailCaptureJob(jobId, leaseId) {
      const job = captureJobs.get(jobId)
      if (job?.status !== 'leased' || job.leaseId !== leaseId) return false
      captureJobs.set(jobId, Object.freeze({ ...job, status: 'queued', leaseId: null, leaseExpiresAt: null }))
      return true
    },
  }
  return Object.freeze(store)
}

const updatedFirst = <T extends { updatedAt: string; id?: string; fileId?: string }>(left: T, right: T) => right.updatedAt.localeCompare(left.updatedAt) || (left.id ?? left.fileId ?? '').localeCompare(right.id ?? right.fileId ?? '')
const publicProject = ({ ownerUserId: _owner, ...project }: OwnedProject): CloudProject => Object.freeze(project)
const publicFile = ({ ownerUserId: _owner, thumbnailEtag: _etag, ...file }: OwnedFile): CloudFileSummary => Object.freeze({ ...file, thumbnailKey: file.thumbnailKey ? `thumbnails/${file.id}/thumbnail.avif` : null })
const publicDocument = ({ ownerUserId: _owner, ...document }: OwnedDocument): CloudFileDocument => Object.freeze(document)
const publicThumbnail = (fileId: string, revision: number, thumbnailKey: string | null, thumbnailEtag: string | null): FileThumbnailMetadata => Object.freeze({ fileId, revision, thumbnailKey, thumbnailEtag })
const publicCaptureJob = (job: CaptureRecord): ThumbnailCaptureJob => Object.freeze({ id: job.id, fileId: job.fileId, revision: job.revision, leaseId: job.leaseId!, leaseExpiresAt: job.leaseExpiresAt!, attempts: job.attempts })
const publicSharedFile = (file: OwnedFile, document: OwnedDocument): SharedFile => Object.freeze({
  file: Object.freeze({ id: file.id, name: file.name, headRevision: file.headRevision, updatedAt: file.updatedAt }),
  document: publicDocument(document),
})
function enqueueCapture(jobs: Map<string, CaptureRecord>, fileId: string, revision: number, createdAt: string): void {
  if ([...jobs.values()].some(job => job.fileId === fileId && job.revision === revision)) return
  const id = randomUUID()
  jobs.set(id, Object.freeze({ id, fileId, revision, status: 'queued', leaseId: null, leaseExpiresAt: null, attempts: 0, createdAt }))
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]!))
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => key === rightEntries[index]![0] && equalJson(value, rightEntries[index]![1]))
}
