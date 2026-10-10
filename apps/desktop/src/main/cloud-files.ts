import { createCloudApiClient } from '@canvas/cloud-client'
import type { CloudFileSummary } from '@canvas/cloud-client'
import type { ElectronAuthClient } from '@canvas/auth/electron'
import type { ProjectSnapshot } from '@canvas/repo-engine'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { validateFileDocument } from '@canvas/repo-engine/file-document'
import type { PreviewSnapshot } from '@canvas/preview-runtime'

export type DesktopCloudSnapshot = ProjectSnapshot & { fileId: string; preview: PreviewSnapshot }
export type DesktopCloudFile = Readonly<{ id: string; name: string; location: string; updatedAt: string; thumbnailUrl?: string }>

function safeOrigin(value: string | undefined, label: string): string | null {
  if (!value) return null
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error(`${label} must be an HTTP or HTTPS origin.`)
  return url.origin
}

export class DesktopCloudFiles {
  private readonly client
  private readonly previewOrigin: string | null
  private readonly editorOrigin: string
  private readonly assetsOrigin: string | null
  private activeFileId: string | null = null

  constructor(auth: Pick<ElectronAuthClient, 'request'>, apiOrigin: string, editorOrigin: string, previewOrigin?: string, assetsOrigin?: string) {
    this.previewOrigin = safeOrigin(previewOrigin, 'Preview origin')
    this.editorOrigin = safeOrigin(editorOrigin, 'Editor origin') ?? (() => { throw new Error('Editor origin is required.') })()
    this.assetsOrigin = safeOrigin(assetsOrigin, 'Assets origin')
    if (this.previewOrigin === this.editorOrigin) throw new Error('Preview must use a separate origin.')
    this.client = createCloudApiClient<FileDocument>({
      apiOrigin,
      fetch: ((input: string | URL | Request, init?: RequestInit) => auth.request(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init)) as typeof fetch,
      validateDocument: value => validateFileDocument(value, []),
    })
  }

  isActive(fileId: string): boolean { return this.activeFileId === fileId }
  hasActive(): boolean { return this.activeFileId !== null }
  accepts(fileId: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId) }

  private summary(file: CloudFileSummary): DesktopCloudFile {
    return {
      id: file.id,
      name: file.name,
      location: 'Cloud',
      updatedAt: file.updatedAt,
      ...(file.thumbnailKey && this.assetsOrigin ? { thumbnailUrl: `${this.assetsOrigin}/file-assets/thumbnails/${encodeURIComponent(file.id)}` } : {}),
    }
  }

  private snapshot(metadata: CloudFileSummary, file: FileDocument): DesktopCloudSnapshot {
    if (metadata.id !== file.fileId) throw new Error('The server returned mismatched file metadata.')
    const preview: PreviewSnapshot = this.previewOrigin ? {
      status: 'ready', currentGeneration: 1, activeGeneration: 1, origin: this.previewOrigin,
      url: `${this.previewOrigin}/?generation=1&editorOrigin=${encodeURIComponent(this.editorOrigin)}&file=${encodeURIComponent(file.fileId)}&mode=composition`,
      stale: false, diagnostics: [],
    } : {
      status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false,
      diagnostics: ['The composition preview is not running.'],
    }
    return {
      projectId: metadata.projectId ?? metadata.id,
      fileId: metadata.id,
      atoms: [],
      sourceHashes: {},
      composition: { id: `composition-${metadata.id}`, name: metadata.name, componentId: null, children: [] },
      file,
      sourceHistory: [],
      conflict: null,
      phases: [{ name: 'Cloud file loaded', completed: 1 }],
      tokens: [],
      designThemes: [],
      preview,
    }
  }

  async list(): Promise<readonly DesktopCloudFile[]> { return (await this.client.listFiles()).map(file => this.summary(file)) }
  async create(): Promise<DesktopCloudFile> { return this.summary(await this.client.createFile()) }
  async open(fileId: string): Promise<DesktopCloudSnapshot> {
    const [metadata, opened] = await Promise.all([this.client.openFile(fileId), this.client.openDocument(fileId)])
    if (opened.revision !== opened.document.revision) throw new Error('The server returned mismatched document revisions.')
    this.activeFileId = fileId
    return this.snapshot(metadata, opened.document)
  }
  async refresh(): Promise<DesktopCloudSnapshot> {
    if (!this.activeFileId) throw new Error('Open a cloud file first.')
    return this.open(this.activeFileId)
  }
  async save(file: FileDocument, expectedRevision: number): Promise<DesktopCloudSnapshot> {
    if (!this.isActive(file.fileId)) throw new Error('Open this cloud file before saving it.')
    const saved = await this.client.saveDocument(file.fileId, file, expectedRevision)
    if (saved.revision !== saved.document.revision) throw new Error('The server returned mismatched document revisions.')
    return this.snapshot(await this.client.openFile(file.fileId), saved.document)
  }
}
