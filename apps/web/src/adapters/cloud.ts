import { CloudApiError, createCloudApiClient } from '@canvas/cloud-client'
import type { CloudFileSummary } from '@canvas/cloud-client'
import { authSessionView } from '@canvas/auth'
import type { AuthSessionView } from '@canvas/auth'
import type { EditorAuthApi, EditorCapabilities, EditorFile, EditorProjectApi, EditorProjectSnapshot } from '@canvas/editor/capabilities'
import { UnavailableCapabilityError } from '@canvas/editor/capabilities'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { validateFileDocument } from '@canvas/repo-engine/file-document'
import { createRevisionSyncClient, SyncClientMessageTooLargeError } from '@canvas/sync-client'
import type { SyncWebSocket } from '@canvas/sync-client'
import type { FileEdit, JsonValue } from '@canvas/sync-protocol'
import { browserSampleAtoms, browserSampleComposition, browserSampleThemes } from './browser'

export type CloudAdapterOptions = Readonly<{
  apiOrigin: string
  previewOrigin?: string
  editorOrigin?: string
  assetsOrigin?: string
  loginOrigin?: string
  syncOrigin?: string
  syncClientId?: string
  syncMaxMessageBytes?: number
  createWebSocket?: (url: string) => SyncWebSocket
  fetch?: typeof fetch
  navigate?: (url: string) => void
}>

export type CloudAdapter = EditorProjectApi & Readonly<{ dispose(): void }>

const sourceReason = 'Source editing needs a connected repository.'

export const cloudCapabilities: EditorCapabilities = {
  runtime: 'browser',
  openLabel: 'Open file',
  files: {
    list: { available: true, reason: 'Files are stored in your account.' },
    create: { available: true, reason: 'Create a file.' },
    open: { available: true, reason: 'Open a file.' },
  },
  sourceWrites: { available: false, reason: sourceReason },
  localRepository: { available: false, reason: 'Local repositories are available in the desktop app.' },
  hostedExecution: { available: false, reason: 'Hosted repository execution is not connected.' },
  git: { available: false, reason: 'Repository connection is available in the desktop app.' },
  mcp: { available: false, reason: 'MCP is not connected.' },
  hostedProjects: { available: true, reason: 'Files are stored in your account.' },
}

function origin(value: string | undefined, label: string): string | null {
  if (value === undefined || value === '') return null
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label} must be an HTTP or HTTPS origin`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error(`${label} must be an HTTP or HTTPS origin`)
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${label} must use HTTPS outside loopback`)
  return url.origin
}

function webSocketOrigin(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Sync origin must be a WebSocket origin') }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('Sync origin must be a WebSocket origin')
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Sync origin must use WSS outside loopback')
  return url.origin
}

function jsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function documentEdits(current: FileDocument, next: FileDocument): readonly FileEdit[] {
  const edits: FileEdit[] = []
  const visit = (before: JsonValue | undefined, after: JsonValue | undefined, path: readonly string[]) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return
    if (after === undefined) { edits.push({ type: 'delete', path }); return }
    if (path.length < 64 && jsonRecord(before) && jsonRecord(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) visit(before[key], after[key], [...path, key])
      return
    }
    edits.push({ type: 'set', path, value: structuredClone(after) })
  }
  visit(current as unknown as JsonValue, next as unknown as JsonValue, [])
  return edits
}

function fileSummary(file: CloudFileSummary, assetsOrigin: string | null): EditorFile {
  return {
    id: file.id,
    name: file.name,
    location: 'Cloud',
    updatedAt: file.updatedAt,
    ...(file.thumbnailKey && assetsOrigin ? { thumbnailUrl: `${assetsOrigin}/file-assets/thumbnails/${encodeURIComponent(file.id)}` } : {}),
  }
}

export function createCloudAdapter(options: CloudAdapterOptions): CloudAdapter {
  const preview = origin(options.previewOrigin, 'Preview origin')
  const editor = origin(options.editorOrigin, 'Editor origin')
  const assets = origin(options.assetsOrigin, 'Assets origin')
  const login = origin(options.loginOrigin, 'Login origin')
  const configuredSyncOrigin = options.syncOrigin ?? (typeof import.meta.env.VITE_SYNC_ORIGIN === 'string' ? import.meta.env.VITE_SYNC_ORIGIN : undefined)
  const sync = webSocketOrigin(configuredSyncOrigin)
  if (preview && !editor) throw new Error('Editor origin is required for the browser preview')
  if (preview && preview === editor) throw new Error('Preview must use a separate origin')
  const client = createCloudApiClient<FileDocument>({
    apiOrigin: options.apiOrigin,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    validateDocument: value => validateFileDocument(value, browserSampleAtoms),
  })
  let activeFileId: string | null = null
  let activeMetadata: CloudFileSummary | null = null
  let deliveredRevision: number | null = null
  let disposed = false
  let openGeneration = 0
  let activeSave: { fileId: string; token: symbol } | null = null
  const syncClient = sync ? createRevisionSyncClient<FileDocument>({
    syncOrigin: sync,
    ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
    ...(options.syncMaxMessageBytes ? { maxMessageBytes: options.syncMaxMessageBytes } : {}),
    validateDocument: value => validateFileDocument(value, browserSampleAtoms),
  }) : null
  const syncClientId = options.syncClientId ?? `web-${crypto.randomUUID()}`
  const listeners = new Set<(session: AuthSessionView) => void>()
  const fileListeners = new Set<(snapshot: EditorProjectSnapshot) => void>()
  let authState = authSessionView('loading', null, 'Checking your session.')
  const publish = (state: AuthSessionView) => { authState = state; for (const listener of listeners) listener(state); return state }
  const getSession = async () => {
    try {
      const user = await client.session()
      return publish(authSessionView('signed-in', { id: user.id, name: user.name, email: user.email, avatarUrl: user.image }))
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 401) return publish(authSessionView('signed-out'))
      return publish(authSessionView('offline', null, 'The auth service could not be reached.'))
    }
  }
  const auth = login ? {
    getSession,
    signInWithGitHub: async () => {
      const state = publish(authSessionView('signing-in', null, 'Continue in your browser.'))
      ;(options.navigate ?? (url => window.location.assign(url)))(login)
      return state
    },
    signOut: async () => {
      const response = await (options.fetch ?? fetch)(`${options.apiOrigin}/api/auth/sign-out`, { method: 'POST', credentials: 'include' })
      if (!response.ok) return publish(authSessionView('offline', null, 'The auth service could not be reached.'))
      openGeneration += 1
      syncClient?.stop()
      activeFileId = null
      activeMetadata = null
      deliveredRevision = null
      return publish(authSessionView('signed-out'))
    },
    subscribe: (listener => { listeners.add(listener); listener(authState); return () => listeners.delete(listener) }),
  } satisfies EditorAuthApi : undefined

  const snapshot = (metadata: CloudFileSummary, file: FileDocument): EditorProjectSnapshot => {
    if (metadata.id !== file.fileId) throw new Error('The server returned mismatched file metadata.')
    return {
      projectId: metadata.projectId ?? metadata.id,
      fileId: metadata.id,
      atoms: structuredClone(browserSampleAtoms),
      sourceHashes: {},
      composition: { ...structuredClone(browserSampleComposition), name: metadata.name, children: [] },
      file,
      sourceHistory: [],
      conflict: null,
      phases: [{ name: syncClient ? 'Live file loaded' : 'Cloud file loaded', completed: 1 }],
      tokens: [],
      designThemes: structuredClone(browserSampleThemes),
      preview: preview && editor ? {
        status: 'ready', currentGeneration: 1, activeGeneration: 1, origin: preview,
        url: `${preview}/?generation=1&editorOrigin=${encodeURIComponent(editor)}&file=${encodeURIComponent(file.fileId)}&mode=composition`,
        stale: false, diagnostics: [],
      } : {
        status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null,
        url: null, stale: false, diagnostics: ['The composition preview is not running.'],
      },
    }
  }

  const openFile = async (fileId: string) => {
    if (disposed) throw new Error('This cloud adapter was disposed.')
    const generation = ++openGeneration
    const [metadata, opened] = await Promise.all([client.openFile(fileId), client.openDocument(fileId)])
    if (opened.revision !== opened.document.revision) throw new Error('The server returned mismatched document revisions.')
    const openedSnapshot = snapshot(metadata, opened.document)
    if (disposed || generation !== openGeneration) return openedSnapshot
    activeFileId = fileId
    activeMetadata = metadata
    deliveredRevision = opened.revision
    syncClient?.start({ fileId, clientId: syncClientId, revision: opened.revision, document: opened.document })
    return openedSnapshot
  }
  const publishLiveSnapshot = () => {
    if (disposed || !syncClient) return
    const live = syncClient.getSnapshot()
    if (activeSave?.fileId === live.fileId || live.status !== 'ready' || !live.document || !activeMetadata || live.fileId !== activeFileId || deliveredRevision !== null && live.revision <= deliveredRevision) return
    deliveredRevision = live.revision
    const next = snapshot(activeMetadata, live.document)
    for (const listener of fileListeners) listener(next)
  }
  const stopSyncWatch = syncClient?.subscribe(publishLiveSnapshot)
  const unavailable = async (): Promise<never> => { throw new UnavailableCapabilityError(sourceReason) }

  return {
    capabilities: cloudCapabilities,
    ...(auth ? { auth } : {}),
    listFiles: async () => (await client.listFiles()).map(file => fileSummary(file, assets)),
    createFile: async () => fileSummary(await client.createFile(), assets),
    openFile,
    subscribeFile: listener => {
      if (disposed) return () => undefined
      fileListeners.add(listener)
      return () => fileListeners.delete(listener)
    },
    openProject: async () => {
      const first = (await client.listFiles())[0]
      if (!first) throw new UnavailableCapabilityError('Create a file first')
      return openFile(first.id)
    },
    refresh: async () => {
      if (!activeFileId || !activeMetadata) throw new UnavailableCapabilityError('Open a file first')
      const live = syncClient?.getSnapshot()
      if (live?.status === 'ready' && live.document && live.fileId === activeFileId) {
        deliveredRevision = live.revision
        return snapshot(activeMetadata, live.document)
      }
      return openFile(activeFileId)
    },
    saveFile: async (file, expectedRevision) => {
      if (disposed) throw new Error('This cloud adapter was disposed.')
      if (!activeFileId || activeFileId !== file.fileId) throw new Error('Open this file before saving it')
      const fileId = activeFileId
      const metadata = activeMetadata
      if (syncClient && metadata) {
        const live = syncClient.getSnapshot()
        if (!live.document || live.fileId !== fileId) throw new Error('Live sync is not ready.')
        const token = Symbol('cloud-save')
        activeSave = { fileId, token }
        try {
          const next = { ...file, revision: expectedRevision + 1 }
          const saved = await syncClient.submit(documentEdits(live.document, next), expectedRevision)
          if (!saved.document || saved.document.revision !== saved.revision) throw new Error('The sync service returned mismatched document revisions.')
          if (activeFileId === fileId) deliveredRevision = saved.revision
          return snapshot(metadata, saved.document)
        } catch (error) {
          if (error instanceof SyncClientMessageTooLargeError) {
            const saved = await client.saveDocument(fileId, file, expectedRevision)
            if (saved.revision !== saved.document.revision) throw new Error('The server returned mismatched document revisions.')
            if (activeFileId === fileId) {
              deliveredRevision = saved.revision
              syncClient.start({ fileId, clientId: syncClientId, revision: saved.revision, document: saved.document })
            }
            return snapshot(metadata, saved.document)
          }
          throw error
        } finally {
          if (activeSave?.token === token) activeSave = null
          publishLiveSnapshot()
        }
      }
      const saved = await client.saveDocument(fileId, file, expectedRevision)
      if (saved.revision !== saved.document.revision) throw new Error('The server returned mismatched document revisions.')
      const refreshedMetadata = await client.openFile(fileId)
      if (activeFileId === fileId) {
        activeMetadata = refreshedMetadata
        deliveredRevision = saved.revision
      }
      return snapshot(refreshedMetadata, saved.document)
    },
    prepareLabelPadding: unavailable,
    prepareToken: unavailable,
    preparePromotion: unavailable,
    prepareUndo: unavailable,
    prepareRedo: unavailable,
    savePrepared: unavailable,
    dispose: () => {
      if (disposed) return
      disposed = true
      openGeneration += 1
      stopSyncWatch?.()
      syncClient?.dispose()
      activeSave = null
      activeFileId = null
      activeMetadata = null
      deliveredRevision = null
      listeners.clear()
      fileListeners.clear()
    },
  }
}
