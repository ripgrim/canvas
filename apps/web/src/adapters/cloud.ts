import { CloudApiError, createCloudApiClient } from '@canvas/cloud-client'
import type { CloudFileSummary } from '@canvas/cloud-client'
import { authSessionView } from '@canvas/auth'
import type { AuthSessionView } from '@canvas/auth'
import type { EditorAssetPreview, EditorAuthApi, EditorCapabilities, EditorCollaborationLocalProfile, EditorCollaborationRole, EditorCollaborationSnapshot, EditorFile, EditorPersistenceIntent, EditorProjectApi, EditorProjectSnapshot } from '@canvas/editor/capabilities'
import { UnavailableCapabilityError } from '@canvas/editor/capabilities'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { applyHostedFileCommand, validateFileDocument } from '@canvas/repo-engine/file-document'
import { createCollaborationClient } from '@canvas/sync-client'
import type { CollaborationDurableStore, CollaborationWebSocket } from '@canvas/sync-client'
import type { FileCommand } from '@canvas/repo-engine/file-document'
import { collaborationDocumentSchemaVersion } from '@canvas/sync-protocol'
import type { ClientLifecycleState } from '@canvas/sync-protocol'
import { appVersion } from '@canvas/tracking'
import { browserHollowAtoms, browserSampleComposition, browserSampleThemes } from './browser'
import { createCloudAssetTransport } from './cloud-assets'

export type CloudAdapterOptions = Readonly<{
  apiOrigin: string
  previewOrigin?: string
  editorOrigin?: string
  assetsOrigin?: string
  loginOrigin?: string
  syncOrigin?: string
  syncClientId?: string
  syncBuildId?: string
  syncMaxMessageBytes?: number
  createWebSocket?: (url: string, protocol: 'canvas-sync-v2') => CollaborationWebSocket
  syncDurableStore?: CollaborationDurableStore
  fetch?: typeof fetch
  navigate?: (url: string) => void
  reload?: () => void
  reportError?: (error: unknown, operation: 'asset_hydration') => void
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

function fileSummary(file: CloudFileSummary, assetsOrigin: string | null): EditorFile {
  return {
    id: file.id,
    name: file.name,
    location: 'Cloud',
    updatedAt: file.updatedAt,
    ...(file.thumbnailKey && assetsOrigin ? { thumbnailUrl: `${assetsOrigin}/file-assets/thumbnails/${encodeURIComponent(file.id)}/thumbnail.avif` } : {}),
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function reportCloudError(error: unknown, operation: 'asset_hydration'): void {
  console.error(`Cloud ${operation} failed.`, error)
}

const syncClientHistoryKey = 'canvasSyncClientId'

function browserSyncClientId(): string {
  if (typeof window === 'undefined') return `web-${crypto.randomUUID()}`
  try {
    const state = typeof window.history.state === 'object' && window.history.state !== null ? window.history.state as Record<string, unknown> : {}
    const stored = state[syncClientHistoryKey]
    if (typeof stored === 'string' && /^web-[0-9a-f-]{36}$/i.test(stored)) return stored
    const created = `web-${crypto.randomUUID()}`
    window.history.replaceState({ ...state, [syncClientHistoryKey]: created }, '')
    return created
  } catch {
    return `web-${crypto.randomUUID()}`
  }
}

export function collaborationShellState(lifecycle: ClientLifecycleState): Exclude<EditorCollaborationSnapshot['shellState'], undefined> {
  if (lifecycle === 'opening') return 'opening'
  if (['connecting', 'authorizing', 'hydrating-local', 'admission-queued', 'streaming', 'applying'].includes(lifecycle)) return 'connecting'
  if (['offline-clean', 'offline-dirty', 'reconnecting', 'replaying', 'draining', 'parked', 'closing'].includes(lifecycle)) return 'reconnecting'
  if (lifecycle === 'access-revoked') return 'access-removed'
  if (lifecycle === 'incompatible-build') return 'update-required'
  if (lifecycle === 'capacity-refused') return 'file-busy'
  return null
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
    validateDocument: value => validateFileDocument(value, browserHollowAtoms),
  })
  const assetTransport = assets ? createCloudAssetTransport({ assetsOrigin: assets, ...(options.fetch ? { fetch: options.fetch } : {}) }) : null
  const reportError = options.reportError ?? reportCloudError
  let activeFileId: string | null = null
  let activeMetadata: CloudFileSummary | null = null
  let deliveredRevision: number | null = null
  let disposed = false
  let openGeneration = 0
  let activeOpenGeneration: number | null = null
  let activeSave: { fileId: string; token: symbol } | null = null
  let assetHydrationGeneration = 0
  let pendingHydrationRevision: number | null = null
  let activeForegroundHydration: symbol | null = null
  const syncClientId = options.syncClientId ?? browserSyncClientId()
  const syncClient = sync ? createCollaborationClient<FileDocument>({
    syncOrigin: sync,
    buildId: options.syncBuildId ?? appVersion,
    clientId: syncClientId,
    ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
    ...(options.syncDurableStore ? { durableStore: options.syncDurableStore } : {}),
    ...(options.syncMaxMessageBytes ? { maxMessageBytes: options.syncMaxMessageBytes } : {}),
    validateDocument: value => validateFileDocument(value, browserHollowAtoms),
    applyCommand: (document, command) => applyHostedFileCommand(document, command, browserHollowAtoms),
  }) : null
  const listeners = new Set<(session: AuthSessionView) => void>()
  const fileListeners = new Set<(snapshot: EditorProjectSnapshot) => void>()
  const failureListeners = new Set<(failure: Readonly<{ operation: 'asset_hydration'; error: unknown }>) => void>()
  let authState = authSessionView('loading', null, 'Checking your session.')
  const collaborationListeners = new Set<() => void>()
  const noAgents = Object.freeze([])
  let authorityFileId: string | null = null
  let authoritativeRole: EditorCollaborationRole | null = null
  let localProfile: EditorCollaborationLocalProfile | null = null
  const resetCollaborationAuthority = (fileId: string | null = null) => {
    authorityFileId = fileId
    authoritativeRole = null
    localProfile = null
  }
  const collaborationStatus = (): EditorCollaborationSnapshot['status'] => {
    if (!syncClient) return 'unavailable'
    const current = syncClient.getSnapshot()
    if (!activeFileId || current.fileId !== activeFileId) return 'unavailable'
    if (current.lifecycle === 'live') return 'live'
    if (current.lifecycle === 'read-only') return 'read-only'
    if (['offline-clean', 'offline-dirty', 'reconnecting', 'replaying', 'draining', 'parked'].includes(current.lifecycle)) return 'reconnecting'
    if (['access-revoked', 'incompatible-build', 'capacity-refused'].includes(current.lifecycle) && current.error) return 'error'
    if (current.lifecycle === 'closed') return 'unavailable'
    return 'connecting'
  }
  const readCollaborationSnapshot = (): EditorCollaborationSnapshot => {
    if (!syncClient) return Object.freeze({ status: 'unavailable', localClientId: null, localProfile: null, canMutate: false, canManageShare: false, participants: Object.freeze([]), agents: noAgents, error: null })
    const current = syncClient.getSnapshot()
    if (!activeFileId || current.fileId !== activeFileId) {
      resetCollaborationAuthority()
      return Object.freeze({ status: 'unavailable', shellState: null, localClientId: null, localProfile: null, canMutate: false, canManageShare: false, participants: Object.freeze([]), agents: noAgents, error: null })
    }
    if (current.fileId !== authorityFileId) resetCollaborationAuthority(current.fileId)
    const authorityFailed = ['access-revoked', 'incompatible-build', 'capacity-refused'].includes(current.lifecycle)
    if (authorityFailed) resetCollaborationAuthority(current.fileId)
    const roleIsCurrent = !authorityFailed && !['cold', 'opening', 'connecting', 'authorizing', 'closing', 'closed'].includes(current.lifecycle)
    if (current.role && roleIsCurrent) authoritativeRole = current.role
    const currentLocal = current.participants.find(participant => participant.clientId === current.clientId)
    if (authoritativeRole && currentLocal) {
      localProfile = Object.freeze({
        subjectId: currentLocal.subjectId,
        displayName: currentLocal.displayName,
        avatarUrl: currentLocal.avatarUrl,
        role: authoritativeRole,
      })
    } else if (authoritativeRole && localProfile && localProfile.role !== authoritativeRole) {
      localProfile = Object.freeze({ ...localProfile, role: authoritativeRole })
    } else if (authoritativeRole && !localProfile && authState.user) {
      localProfile = Object.freeze({
        subjectId: authState.user.id,
        displayName: authState.user.name,
        avatarUrl: authState.user.avatarUrl,
        role: authoritativeRole,
      })
    }
    return Object.freeze({
      status: collaborationStatus(),
      shellState: collaborationShellState(current.lifecycle),
      localClientId: current.fileId ? current.clientId : null,
      localProfile,
      canMutate: authoritativeRole === 'owner',
      canManageShare: authoritativeRole === 'owner',
      participants: Object.freeze(current.participants.map(participant => Object.freeze({
        presenceId: participant.presenceId,
        subjectId: participant.subjectId,
        displayName: participant.displayName,
        avatarUrl: participant.avatarUrl,
        clientId: participant.clientId,
        role: participant.role,
        isHeadless: false,
        sequence: participant.sequence,
        awareness: participant.data,
      }))),
      agents: noAgents,
      error: current.error,
    })
  }
  let collaborationSnapshot = readCollaborationSnapshot()
  const publishCollaborationSnapshot = () => {
    const next = readCollaborationSnapshot()
    if (JSON.stringify(next) === JSON.stringify(collaborationSnapshot)) return
    collaborationSnapshot = next
    for (const listener of collaborationListeners) listener()
  }
  const publish = (state: AuthSessionView) => { authState = state; for (const listener of listeners) listener(state); publishCollaborationSnapshot(); return state }
  const getSession = async () => {
    try {
      const user = await client.session()
      const changedAccount = authState.user && authState.user.id !== user.id ? authState.user.id : null
      if (changedAccount) {
        await syncClient?.purgeAccount(changedAccount)
        openGeneration += 1
        activeOpenGeneration = null
        resetCollaborationAuthority()
        activeFileId = null
        activeMetadata = null
        deliveredRevision = null
      }
      const state = publish(authSessionView('signed-in', { id: user.id, name: user.name, email: user.email, avatarUrl: user.image }))
      if (changedAccount) (options.reload ?? (() => window.location.reload()))()
      return state
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 401) {
        const signedOutAccountId = authState.user?.id ?? null
        syncClient?.stop()
        if (signedOutAccountId) await syncClient?.purgeAccount(signedOutAccountId)
        openGeneration += 1
        activeOpenGeneration = null
        resetCollaborationAuthority()
        activeFileId = null
        activeMetadata = null
        deliveredRevision = null
        const state = publish(authSessionView('signed-out'))
        if (signedOutAccountId) (options.reload ?? (() => window.location.reload()))()
        return state
      }
      return publish(authSessionView('offline', null, 'The auth service could not be reached.', error instanceof CloudApiError ? error.requestId : crypto.randomUUID()))
    }
  }
  const auth = login ? {
    allowSignedOutWorkspace: true,
    getSession,
    signInWithGitHub: async () => {
      const state = publish(authSessionView('signing-in', null, 'Continue in your browser.'))
      const target = new URL(login)
      if (typeof window !== 'undefined' && ['http:', 'https:'].includes(window.location.protocol)) target.searchParams.set('return_to', window.location.href)
      ;(options.navigate ?? (url => window.location.assign(url)))(target.toString())
      return state
    },
    signOut: async () => {
      const signedOutAccountId = authState.user?.id ?? null
      syncClient?.stop()
      if (signedOutAccountId) await syncClient?.purgeAccount(signedOutAccountId)
      const response = await (options.fetch ?? fetch)(`${options.apiOrigin}/api/auth/sign-out`, { method: 'POST', credentials: 'include' })
      if (!response.ok) {
        const requestId = response.headers.get('X-Canvas-Request-Id')
        return publish(authSessionView('offline', null, 'The auth service could not be reached.', requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ? requestId : crypto.randomUUID()))
      }
      openGeneration += 1
      activeOpenGeneration = null
      resetCollaborationAuthority()
      publishCollaborationSnapshot()
      activeFileId = null
      activeMetadata = null
      deliveredRevision = null
      const state = publish(authSessionView('signed-out'))
      ;(options.reload ?? (() => window.location.reload()))()
      return state
    },
    subscribe: (listener => { listeners.add(listener); listener(authState); return () => listeners.delete(listener) }),
  } satisfies EditorAuthApi : undefined

  const snapshot = (metadata: CloudFileSummary, file: FileDocument, assetPreviews: readonly EditorAssetPreview[] = []): EditorProjectSnapshot => {
    if (metadata.id !== file.fileId) throw new Error('The server returned mismatched file metadata.')
    return {
      projectId: metadata.projectId ?? metadata.id,
      fileId: metadata.id,
      atoms: structuredClone(browserHollowAtoms),
      sourceHashes: {},
      composition: { ...structuredClone(browserSampleComposition), name: metadata.name, children: [] },
      file,
      assetPreviews,
      sourceHistory: [],
      conflict: null,
      phases: [{ name: syncClient ? 'Live file loaded with hollow catalog' : 'Cloud file loaded with hollow catalog', completed: 1 }],
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

  const hydrateAssetPreviews = async (file: FileDocument, isCurrent: () => boolean): Promise<readonly EditorAssetPreview[]> => {
    const references = Object.values(file.assets ?? {})
    if (!references.length) return Object.freeze([])
    if (!assetTransport) throw new Error('The asset service is required to open this file.')
    const previews: EditorAssetPreview[] = []
    for (const asset of references) {
      const bytes = await assetTransport.downloadImage(file.fileId, asset, { isCurrent })
      if (!isCurrent()) throw new Error('This asset hydration was superseded.')
      previews.push(Object.freeze({ assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data: base64(bytes) }))
    }
    return Object.freeze(previews)
  }

  const hydratedSnapshot = async (metadata: CloudFileSummary, file: FileDocument, isCurrent: () => boolean): Promise<EditorProjectSnapshot> => {
    const assetPreviews = await hydrateAssetPreviews(file, isCurrent)
    if (!isCurrent()) throw new Error('This asset hydration was superseded.')
    return snapshot(metadata, file, assetPreviews)
  }

  const foregroundSnapshot = async (metadata: CloudFileSummary, file: FileDocument, isCurrent: () => boolean): Promise<EditorProjectSnapshot> => {
    const token = Symbol('asset-hydration')
    activeForegroundHydration = token
    pendingHydrationRevision = null
    const hydration = ++assetHydrationGeneration
    try {
      return await hydratedSnapshot(metadata, file, () => activeForegroundHydration === token && hydration === assetHydrationGeneration && isCurrent())
    } finally {
      if (activeForegroundHydration === token) activeForegroundHydration = null
    }
  }

  const waitForLiveFile = (fileId: string, generation: number): Promise<FileDocument> => {
    if (!syncClient) throw new Error('Live sync is not configured.')
    return new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => undefined
      const finish = (result: Readonly<{ document: FileDocument }> | Readonly<{ error: Error }>) => {
        unsubscribe()
        if ('error' in result) reject(result.error)
        else resolve(result.document)
      }
      const check = () => {
        if (disposed) { finish({ error: new Error('This cloud adapter was disposed.') }); return }
        if (generation !== openGeneration) { finish({ error: new Error('This file open was superseded.') }); return }
        const live = syncClient.getSnapshot()
        if (live.fileId !== fileId) return
        if ((live.lifecycle === 'live' || live.lifecycle === 'read-only') && live.document) { finish({ document: live.document }); return }
        if (['access-revoked', 'incompatible-build', 'capacity-refused', 'closed'].includes(live.lifecycle)) {
          finish({ error: new Error(live.error ?? 'Live sync could not open this file.') })
        }
      }
      unsubscribe = syncClient.subscribe(check)
      check()
    })
  }

  const openWithMetadata = async (fileId: string, metadata: CloudFileSummary, generation: number) => {
    if (syncClient) {
      if (disposed || generation !== openGeneration) throw new Error('This file open was superseded.')
      activeFileId = fileId
      activeMetadata = metadata
      deliveredRevision = null
      activeOpenGeneration = generation
      syncClient.stop()
      resetCollaborationAuthority(fileId)
      publishCollaborationSnapshot()
      await syncClient.start({
        fileId,
        cache: authState.user
          ? { accountId: authState.user.id, documentSchemaVersion: collaborationDocumentSchemaVersion }
          : false,
      })
      try {
        const document = await waitForLiveFile(fileId, generation)
        if (disposed || generation !== openGeneration) throw new Error('This file open was superseded.')
        const openedSnapshot = await foregroundSnapshot(metadata, document, () => !disposed && generation === openGeneration && activeFileId === fileId)
        if (disposed || generation !== openGeneration) throw new Error('This file open was superseded.')
        deliveredRevision = document.revision
        return openedSnapshot
      } finally {
        if (activeOpenGeneration === generation) activeOpenGeneration = null
        publishLiveSnapshot()
      }
    }
    throw new UnavailableCapabilityError('Live sync is unavailable.')
  }
  const openFile = async (fileId: string) => {
    if (disposed) throw new Error('This cloud adapter was disposed.')
    const generation = ++openGeneration
    const metadata = await client.openFile(fileId)
    return openWithMetadata(fileId, metadata, generation)
  }
  const openSharedFile = async (fileId: string): Promise<EditorProjectSnapshot | null> => {
    if (disposed) throw new Error('This cloud adapter was disposed.')
    const generation = ++openGeneration
    let shared
    try { shared = await client.openSharedFile(fileId) }
    catch (error) { if (error instanceof CloudApiError && error.status === 404) return null; throw error }
    const metadata: CloudFileSummary = Object.freeze({
      id: shared.file.id,
      projectId: null,
      name: shared.file.name,
      headRevision: shared.file.headRevision,
      thumbnailKey: null,
      createdAt: shared.file.updatedAt,
      updatedAt: shared.file.updatedAt,
    })
    return openWithMetadata(fileId, metadata, generation)
  }
  const retryCollaboration = () => {
    if (disposed || !syncClient || !activeFileId || !activeMetadata) return
    const fileId = activeFileId
    const metadata = activeMetadata
    const generation = ++openGeneration
    void openWithMetadata(fileId, metadata, generation).then(next => {
      if (disposed || generation !== openGeneration || activeFileId !== fileId) return
      for (const listener of fileListeners) listener(next)
    }).catch(error => {
      console.error('Collaboration retry failed.', error)
      publishCollaborationSnapshot()
    })
  }
  const leaveCollaboration = () => {
    if (disposed) return
    openGeneration += 1
    activeOpenGeneration = null
    syncClient?.stop()
    resetCollaborationAuthority()
    activeFileId = null
    activeMetadata = null
    deliveredRevision = null
    pendingHydrationRevision = null
    publishCollaborationSnapshot()
    const home = editor ?? (typeof window === 'undefined' ? null : window.location.origin)
    if (home) (options.navigate ?? (url => window.location.assign(url)))(`${home}/`)
  }
  const publishLiveSnapshot = () => {
    if (disposed || !syncClient || activeOpenGeneration !== null || activeForegroundHydration !== null) return
    const live = syncClient.getSnapshot()
    if (activeSave?.fileId === live.fileId || (live.lifecycle !== 'live' && live.lifecycle !== 'read-only') || !live.document || !activeMetadata || live.fileId !== activeFileId || deliveredRevision !== null && live.document.revision <= deliveredRevision || pendingHydrationRevision !== null && live.document.revision <= pendingHydrationRevision) return
    const file = live.document
    const metadata = activeMetadata
    const fileId = live.fileId
    const hydration = ++assetHydrationGeneration
    pendingHydrationRevision = file.revision
    void hydratedSnapshot(metadata, file, () => !disposed && hydration === assetHydrationGeneration && fileId === activeFileId && syncClient.getSnapshot().fileId === fileId).then(next => {
      if (disposed || hydration !== assetHydrationGeneration || fileId !== activeFileId) return
      deliveredRevision = file.revision
      pendingHydrationRevision = null
      for (const listener of fileListeners) listener(next)
      publishLiveSnapshot()
    }).catch(error => {
      if (hydration !== assetHydrationGeneration) return
      pendingHydrationRevision = null
      reportError(error, 'asset_hydration')
      for (const listener of failureListeners) {
        try { listener(Object.freeze({ operation: 'asset_hydration', error })) }
        catch (listenerError) { reportError(listenerError, 'asset_hydration') }
      }
    })
  }
  const stopSyncWatch = syncClient?.subscribe(() => { publishLiveSnapshot(); publishCollaborationSnapshot() })
  const unavailable = async (): Promise<never> => { throw new UnavailableCapabilityError(sourceReason) }
  return {
    capabilities: cloudCapabilities,
    ...(auth ? { auth } : {}),
    ...(syncClient ? { collaboration: {
      subscribe: (listener: () => void) => { collaborationListeners.add(listener); return () => collaborationListeners.delete(listener) },
      getSnapshot: () => collaborationSnapshot,
      updateAwareness: (patch, presenceOptions) => syncClient.updatePresence({
        ...(patch.pageId === undefined ? {} : { pageId: patch.pageId }),
        ...(patch.focused === undefined ? {} : { focused: patch.focused }),
        ...(patch.selection === undefined ? {} : { selection: patch.selection }),
        ...(patch.camera === undefined ? {} : { camera: patch.camera }),
        ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }),
        ...(patch.interaction === undefined ? {} : { interaction: patch.interaction }),
      }, presenceOptions),
      retry: retryCollaboration,
      leave: leaveCollaboration,
    } } : {}),
    ...(assetTransport ? { assets: {
      uploadImage: async input => {
        const asset = await assetTransport.uploadImage(input)
        return Object.freeze({
          asset,
          preview: Object.freeze({ assetId: asset.id, sha256: asset.sha256, mime: asset.mime, data: base64(input.bytes) }),
        })
      },
    } } : {}),
    listFiles: async () => (await client.listFiles()).map(file => fileSummary(file, assets)),
    createFile: async () => fileSummary(await client.createFile(), assets),
    openFile,
    openSharedFile,
    getFileShare: fileId => client.getFileShare(fileId),
    setFileShare: (fileId, access) => client.setFileShare(fileId, access),
    shareUrl: fileId => {
      if (typeof window === 'undefined') return `${editor ?? ''}/file/${encodeURIComponent(fileId)}`
      const current = new URL(window.location.href)
      return current.pathname === `/file/${encodeURIComponent(fileId)}` ? current.href : `${editor ?? window.location.origin}/file/${encodeURIComponent(fileId)}`
    },
    subscribeFile: listener => {
      if (disposed) return () => undefined
      fileListeners.add(listener)
      return () => fileListeners.delete(listener)
    },
    subscribeFailures: listener => {
      if (disposed) return () => undefined
      failureListeners.add(listener)
      return () => failureListeners.delete(listener)
    },
    openProject: async () => {
      const first = (await client.listFiles())[0]
      if (!first) throw new UnavailableCapabilityError('Create a file first')
      return openFile(first.id)
    },
    refresh: async () => {
      if (!activeFileId || !activeMetadata) throw new UnavailableCapabilityError('Open a file first')
      const live = syncClient?.getSnapshot()
      if (live && (live.lifecycle === 'live' || live.lifecycle === 'read-only') && live.document && live.fileId === activeFileId) {
        try {
          const refreshed = await foregroundSnapshot(activeMetadata, live.document, () => !disposed && live.fileId === activeFileId)
          deliveredRevision = live.document.revision
          return refreshed
        } finally {
          publishLiveSnapshot()
        }
      }
      return openFile(activeFileId)
    },
    saveFile: async (file, expectedRevision, intent?: EditorPersistenceIntent) => {
      if (disposed) throw new Error('This cloud adapter was disposed.')
      if (!activeFileId || activeFileId !== file.fileId) throw new Error('Open this file before saving it')
      const fileId = activeFileId
      const metadata = activeMetadata
      if (syncClient && metadata) {
        const live = syncClient.getSnapshot()
        if (live.lifecycle !== 'live' || !live.document || live.fileId !== fileId) throw new Error(live.lifecycle === 'read-only' ? 'This file is read only.' : 'Live sync is not ready.')
        if (!intent) throw new Error('Live sync requires the semantic command that produced this change.')
        if (!intent.commands.length) {
          return foregroundSnapshot(metadata, live.document, () => !disposed && activeFileId === fileId)
        }
        const command: FileCommand = intent.commands.length === 1 ? intent.commands[0]! : { type: 'batch', commands: [...intent.commands] }
        const projected = applyHostedFileCommand(live.document, command, browserHollowAtoms)
        const token = Symbol('cloud-save')
        activeSave = { fileId, token }
        try {
          await syncClient.submit({ mutationId: crypto.randomUUID(), command })
          const saved = syncClient.getSnapshot().document
          if (!saved || saved.fileId !== fileId || saved.revision < projected.revision) throw new Error('The sync service did not acknowledge this change.')
          if (activeFileId === fileId) deliveredRevision = saved.revision
          return foregroundSnapshot(metadata, saved, () => !disposed && activeFileId === fileId)
        } finally {
          if (activeSave?.token === token) activeSave = null
          publishLiveSnapshot()
        }
      }
      throw new UnavailableCapabilityError('Live sync is unavailable.')
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
      assetHydrationGeneration += 1
      pendingHydrationRevision = null
      activeForegroundHydration = null
      stopSyncWatch?.()
      syncClient?.dispose()
      resetCollaborationAuthority()
      collaborationListeners.clear()
      activeSave = null
      activeOpenGeneration = null
      activeFileId = null
      activeMetadata = null
      deliveredRevision = null
      listeners.clear()
      fileListeners.clear()
      failureListeners.clear()
    },
  }
}
