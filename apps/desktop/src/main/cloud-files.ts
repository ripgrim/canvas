import { randomUUID } from 'node:crypto'
import { createCloudApiClient } from '@canvas/cloud-client'
import type { CloudFileSummary } from '@canvas/cloud-client'
import type { ElectronAuthClient } from '@canvas/auth/electron'
import type { EditorCollaborationLocalProfile, EditorCollaborationPatch, EditorCollaborationRole, EditorCollaborationSnapshot, EditorPersistenceIntent } from '@canvas/editor/capabilities'
import type { Atom, ProjectSnapshot } from '@canvas/repo-engine'
import { applyHostedFileCommand, fileSchemaVersion, validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import type { PreviewSnapshot } from '@canvas/preview-runtime'
import { createCollaborationClient } from '@canvas/sync-client'
import type { CollaborationDurableStore, CollaborationWebSocket } from '@canvas/sync-client'
import { bundledEditorOrigin } from './web-target'

export type DesktopCloudSnapshot = ProjectSnapshot & { fileId: string; preview: PreviewSnapshot }
export type DesktopCloudFile = Readonly<{ id: string; name: string; location: string; updatedAt: string; thumbnailUrl?: string }>
export type DesktopWorkspacePreview = Readonly<{ atoms(): Atom[]; project(file: FileDocument): Promise<PreviewSnapshot> }>
export type DesktopCollaborationOptions = Readonly<{
  syncOrigin: string
  buildId: string
  clientId: string
  requestOrigin: string
  accountId(): string | null
  durableStore: CollaborationDurableStore
}>

type CollaborationClient = ReturnType<typeof createCollaborationClient<FileDocument>>

function safeOrigin(value: string | undefined, label: string): string | null {
  if (!value) return null
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error(`${label} must be an HTTP or HTTPS origin.`)
  return url.origin
}

function safeEditorOrigin(value: string): string {
  if (value === bundledEditorOrigin) return value
  return safeOrigin(value, 'Editor origin') ?? (() => { throw new Error('Editor origin is required.') })()
}

function shellState(lifecycle: ReturnType<CollaborationClient['getSnapshot']>['lifecycle']): Exclude<EditorCollaborationSnapshot['shellState'], undefined> {
  if (lifecycle === 'opening') return 'opening'
  if (['connecting', 'authorizing', 'hydrating-local', 'admission-queued', 'streaming', 'applying'].includes(lifecycle)) return 'connecting'
  if (['offline-clean', 'offline-dirty', 'reconnecting', 'replaying', 'draining', 'parked', 'closing'].includes(lifecycle)) return 'reconnecting'
  if (lifecycle === 'access-revoked') return 'access-removed'
  if (lifecycle === 'incompatible-build') return 'update-required'
  if (lifecycle === 'capacity-refused') return 'file-busy'
  return null
}

function waitForDocument(client: CollaborationClient, fileId: string): Promise<FileDocument> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: () => void = () => undefined
    const finish = (result: { document?: FileDocument; error?: Error }) => {
      if (settled) return
      settled = true
      unsubscribe()
      if (result.error) reject(result.error)
      else resolve(result.document!)
    }
    const check = () => {
      const current = client.getSnapshot()
      if (current.fileId !== fileId) return
      if ((current.lifecycle === 'live' || current.lifecycle === 'read-only') && current.document) finish({ document: current.document })
      else if (['access-revoked', 'incompatible-build', 'capacity-refused', 'closed'].includes(current.lifecycle)) finish({ error: new Error(current.error ?? 'Live sync could not open this file.') })
    }
    unsubscribe = client.subscribe(check)
    check()
  })
}

export class DesktopCloudFiles {
  private readonly client
  private readonly previewOrigin: string | null
  private readonly editorOrigin: string
  private readonly assetsOrigin: string | null
  private readonly sync: CollaborationClient
  private readonly fileListeners = new Set<(snapshot: DesktopCloudSnapshot) => void>()
  private readonly collaborationListeners = new Set<() => void>()
  private activeFileId: string | null = null
  private activeMetadata: CloudFileSummary | null = null
  private activeAccountId: string | null = null
  private authorityFileId: string | null = null
  private authoritativeRole: EditorCollaborationRole | null = null
  private localProfile: EditorCollaborationLocalProfile | null = null
  private previewUrl: string | null = null
  private deliveredRevision: number | null = null
  private opening = false
  private saving = false
  private publishGeneration = 0
  private disposed = false

  constructor(auth: Pick<ElectronAuthClient, 'request' | 'createWebSocket'>, apiOrigin: string, editorOrigin: string, previewOrigin: string | undefined, assetsOrigin: string | undefined, private readonly workspace: DesktopWorkspacePreview | undefined, private readonly collaboration: DesktopCollaborationOptions) {
    this.previewOrigin = safeOrigin(previewOrigin, 'Preview origin')
    this.editorOrigin = safeEditorOrigin(editorOrigin)
    this.assetsOrigin = safeOrigin(assetsOrigin, 'Assets origin')
    if (this.previewOrigin === this.editorOrigin) throw new Error('Preview must use a separate origin.')
    this.client = createCloudApiClient<FileDocument>({
      apiOrigin,
      fetch: ((input: string | URL | Request, init?: RequestInit) => auth.request(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init)) as typeof fetch,
      validateDocument: value => validateFileDocument(value, this.workspace?.atoms() ?? [], { allowUnavailableBindings: true }),
    })
    this.sync = createCollaborationClient<FileDocument>({
      syncOrigin: collaboration.syncOrigin,
      buildId: collaboration.buildId,
      clientId: collaboration.clientId,
      durableStore: collaboration.durableStore,
      createWebSocket: (url, protocol) => auth.createWebSocket(url, protocol, collaboration.requestOrigin) as unknown as CollaborationWebSocket,
      validateDocument: value => validateFileDocument(value, this.workspace?.atoms() ?? [], { allowUnavailableBindings: true }),
      applyCommand: (document, command) => applyHostedFileCommand(document, command, this.workspace?.atoms() ?? []),
    })
    this.sync.subscribe(() => this.handleSyncChange())
  }

  isActive(fileId: string): boolean { return this.activeFileId === fileId }
  hasActive(): boolean { return this.activeFileId !== null }
  activePreviewUrl(): string | null { return this.previewUrl }
  accepts(fileId: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId) }
  subscribeFile(listener: (snapshot: DesktopCloudSnapshot) => void): () => void { this.fileListeners.add(listener); return () => this.fileListeners.delete(listener) }
  subscribeCollaboration(listener: () => void): () => void { this.collaborationListeners.add(listener); return () => this.collaborationListeners.delete(listener) }

  private summary(file: CloudFileSummary): DesktopCloudFile {
    return { id: file.id, name: file.name, location: 'Cloud', updatedAt: file.updatedAt, ...(file.thumbnailKey && this.assetsOrigin ? { thumbnailUrl: `${this.assetsOrigin}/file-assets/thumbnails/${encodeURIComponent(file.id)}/thumbnail.avif` } : {}) }
  }

  private async snapshot(metadata: CloudFileSummary, file: FileDocument): Promise<DesktopCloudSnapshot> {
    if (metadata.id !== file.fileId) throw new Error('The server returned mismatched file metadata.')
    const atoms = this.workspace?.atoms() ?? []
    const preview: PreviewSnapshot = atoms.length && this.workspace ? await this.workspace.project(file) : this.previewOrigin ? {
      status: 'ready', currentGeneration: 1, activeGeneration: 1, origin: this.previewOrigin,
      url: `${this.previewOrigin}/?generation=1&editorOrigin=${encodeURIComponent(this.editorOrigin)}&file=${encodeURIComponent(file.fileId)}&mode=composition`,
      stale: false, diagnostics: [],
    } : { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: ['The composition preview is not running.'] }
    return {
      projectId: metadata.projectId ?? metadata.id,
      fileId: metadata.id,
      atoms,
      sourceHashes: {},
      composition: { id: `composition-${metadata.id}`, name: metadata.name, componentId: null, children: [] },
      file,
      sourceHistory: [],
      conflict: null,
      phases: [{ name: atoms.length ? 'Verified repository catalog loaded' : 'Cloud file loaded without a repository catalog', completed: 1 }],
      tokens: [],
      designThemes: [],
      preview,
    }
  }

  private handleSyncChange(): void {
    for (const listener of this.collaborationListeners) listener()
    const current = this.sync.getSnapshot()
    if (this.disposed || this.opening || this.saving || !this.activeFileId || !this.activeMetadata || current.fileId !== this.activeFileId || !current.document || (current.lifecycle !== 'live' && current.lifecycle !== 'read-only') || current.document.revision === this.deliveredRevision) return
    const generation = ++this.publishGeneration
    const metadata = this.activeMetadata
    const fileId = this.activeFileId
    void this.snapshot(metadata, current.document).then(snapshot => {
      if (this.disposed || this.saving || generation !== this.publishGeneration || this.activeFileId !== fileId) return
      this.deliveredRevision = snapshot.file.revision
      for (const listener of this.fileListeners) listener(snapshot)
    }).catch(error => console.error('Desktop collaboration snapshot failed.', error))
  }

  private resetAuthority(fileId: string | null = null): void {
    this.authorityFileId = fileId
    this.authoritativeRole = null
    this.localProfile = null
  }

  collaborationSnapshot(): EditorCollaborationSnapshot {
    const current = this.sync.getSnapshot()
    if (!this.activeFileId || current.fileId !== this.activeFileId) {
      this.resetAuthority()
      return { status: 'unavailable', shellState: null, localClientId: null, localProfile: null, canMutate: false, canManageShare: false, participants: [], agents: [], error: null }
    }
    if (this.authorityFileId !== current.fileId) this.resetAuthority(current.fileId)
    const authorityFailed = ['access-revoked', 'incompatible-build', 'capacity-refused'].includes(current.lifecycle)
    if (authorityFailed) this.resetAuthority(current.fileId)
    const roleIsCurrent = !authorityFailed && !['cold', 'opening', 'connecting', 'authorizing', 'closing', 'closed'].includes(current.lifecycle)
    if (current.role && roleIsCurrent) this.authoritativeRole = current.role
    const local = current.participants.find(participant => participant.clientId === current.clientId)
    if (this.authoritativeRole && local) this.localProfile = { subjectId: local.subjectId, displayName: local.displayName, avatarUrl: local.avatarUrl, role: this.authoritativeRole }
    else if (this.authoritativeRole && this.localProfile && this.localProfile.role !== this.authoritativeRole) this.localProfile = { ...this.localProfile, role: this.authoritativeRole }
    const status: EditorCollaborationSnapshot['status'] = current.lifecycle === 'live' ? 'live' : current.lifecycle === 'read-only' ? 'read-only' : ['offline-clean', 'offline-dirty', 'reconnecting', 'replaying', 'draining', 'parked'].includes(current.lifecycle) ? 'reconnecting' : ['access-revoked', 'incompatible-build', 'capacity-refused'].includes(current.lifecycle) ? 'error' : 'connecting'
    return {
      status,
      shellState: shellState(current.lifecycle),
      localClientId: current.clientId,
      localProfile: this.localProfile,
      canMutate: this.authoritativeRole === 'owner',
      canManageShare: this.authoritativeRole === 'owner',
      participants: current.participants.map(participant => ({ presenceId: participant.presenceId, subjectId: participant.subjectId, displayName: participant.displayName, avatarUrl: participant.avatarUrl, clientId: participant.clientId, role: participant.role, isHeadless: false, sequence: participant.sequence, awareness: participant.data })),
      agents: [],
      error: current.error,
    }
  }

  updateAwareness(patch: EditorCollaborationPatch, options?: Readonly<{ immediate?: boolean }>): void { this.sync.updatePresence(patch, options) }
  retry(): void { if (this.activeFileId) void this.startSync(this.activeFileId).catch(error => console.error('Desktop collaboration retry failed.', error)) }
  leave(): void { this.publishGeneration += 1; this.sync.stop(); this.activeFileId = null; this.activeMetadata = null; this.deliveredRevision = null; this.resetAuthority(); for (const listener of this.collaborationListeners) listener() }

  private async startSync(fileId: string): Promise<FileDocument> {
    const accountId = this.collaboration.accountId()
    if (!accountId) throw new Error('Sign in to open this file.')
    this.sync.stop()
    this.activeAccountId = accountId
    await this.sync.start({ fileId, cache: { accountId, documentSchemaVersion: fileSchemaVersion } })
    return waitForDocument(this.sync, fileId)
  }

  async list(): Promise<readonly DesktopCloudFile[]> { return (await this.client.listFiles()).map(file => this.summary(file)) }
  async create(): Promise<DesktopCloudFile> { return this.summary(await this.client.createFile()) }
  async open(fileId: string): Promise<DesktopCloudSnapshot> {
    if (this.disposed) throw new Error('Desktop cloud files are disposed.')
    this.publishGeneration += 1
    if (this.activeFileId !== fileId) this.resetAuthority(fileId)
    this.opening = true
    try {
      const metadata = await this.client.openFile(fileId)
      this.activeFileId = fileId
      this.activeMetadata = metadata
      const document = await this.startSync(fileId)
      const snapshot = await this.snapshot(metadata, document)
      this.deliveredRevision = document.revision
      this.previewUrl = snapshot.preview.url
      for (const listener of this.collaborationListeners) listener()
      return snapshot
    } catch (error) {
      this.sync.stop()
      this.activeFileId = null
      this.activeMetadata = null
      this.deliveredRevision = null
      this.resetAuthority()
      throw error
    } finally {
      this.opening = false
    }
  }
  async refresh(): Promise<DesktopCloudSnapshot> {
    if (!this.activeFileId || !this.activeMetadata) throw new Error('Open a cloud file first.')
    const current = this.sync.getSnapshot()
    if ((current.lifecycle === 'live' || current.lifecycle === 'read-only') && current.document && current.fileId === this.activeFileId) return this.snapshot(this.activeMetadata, current.document)
    return this.open(this.activeFileId)
  }
  async save(file: FileDocument, _expectedRevision: number, intent?: EditorPersistenceIntent): Promise<DesktopCloudSnapshot> {
    if (!this.isActive(file.fileId) || !this.activeMetadata) throw new Error('Open this cloud file before saving it.')
    const current = this.sync.getSnapshot()
    if (current.lifecycle !== 'live' || !current.document || current.fileId !== file.fileId) throw new Error(current.lifecycle === 'read-only' ? 'This file is read only.' : 'Live sync is not ready.')
    if (!intent) throw new Error('Live sync requires the semantic command that produced this change.')
    if (!intent.commands.length) return this.snapshot(this.activeMetadata, current.document)
    const command: FileCommand = intent.commands.length === 1 ? intent.commands[0]! : { type: 'batch', commands: [...intent.commands] }
    applyHostedFileCommand(current.document, command, this.workspace?.atoms() ?? [])
    this.saving = true
    try {
      await this.sync.submit({ mutationId: randomUUID(), command })
      const saved = this.sync.getSnapshot().document
      if (!saved || saved.fileId !== file.fileId) throw new Error('The sync service did not acknowledge this change.')
      this.deliveredRevision = saved.revision
      return this.snapshot(this.activeMetadata, saved)
    } finally {
      this.saving = false
      this.handleSyncChange()
    }
  }

  async signOut(): Promise<void> {
    const accountId = this.activeAccountId
    this.leave()
    this.activeAccountId = null
    if (accountId) await this.sync.purgeAccount(accountId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.publishGeneration += 1
    this.sync.dispose()
    this.fileListeners.clear()
    this.collaborationListeners.clear()
    this.activeFileId = null
    this.activeMetadata = null
    this.resetAuthority()
  }
}
