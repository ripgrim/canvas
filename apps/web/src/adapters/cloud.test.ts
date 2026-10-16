import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyFileCommandWithHistory, applyHostedFileCommand, createBlankFile, legacyTextProperties } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { CollaborationSocketEventMap, CollaborationWebSocket } from '@canvas/sync-client'
import type { CollaborationDurableStore } from '@canvas/sync-client'
import { collaborationDocumentSchemaVersion, collaborationEnvelopeSchemaVersion, collaborationProtocolEpoch, collaborationWebSocketProtocol } from '@canvas/sync-protocol'
import type { CollaborationClientMessage, CollaborationServerMessage, FlowDragPresentation, ServerRoomEnvelope } from '@canvas/sync-protocol'
import type { EditorProjectSnapshot } from '@canvas/editor/capabilities'
import { hostedPreviewCatalogFingerprint } from '@canvas/preview-runtime/hosted-artifact'
import { collaborationShellState, createCloudAdapter } from './cloud'
import { browserHollowAtoms } from './browser'

const metadata = {
  id: '11111111-2222-4333-8444-555555555555', projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: 'thumbnails/11111111-2222-4333-8444-555555555555/thumbnail.avif',
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
}
const document = createBlankFile(metadata.id, 'page_cloud', 'root_cloud', 'Page 1')
const malformedHostedDocument = () => ({
  ...document,
  pages: [{ ...document.pages[0]!, rootNodeId: 'missing-root' }],
}) as typeof document
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const imageBytes = new Uint8Array([1, 2, 3, 4])
const imageAsset = {
  id: 'asset-one', name: 'dot.png', mime: 'image/png' as const, extension: 'png' as const,
  bytes: imageBytes.byteLength, width: 1, height: 1, sha256: createHash('sha256').update(imageBytes).digest('hex'),
}
const imageDocument = { ...document, assets: { [imageAsset.id]: imageAsset } }
const flowDocument: FileDocument = {
  ...document,
  nodes: {
    ...document.nodes,
    'source-frame': { id: 'source-frame', type: 'frame', name: 'Source frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 200, height: 200 }, layout: { item: { position: { mode: 'absolute' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    'target-frame': { id: 'target-frame', type: 'frame', name: 'Target frame', styles: { relativeTransform: [1, 0, 0, 1, 300, 0], width: 200, height: 200 }, layout: { item: { position: { mode: 'absolute' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    source: { id: 'source', type: 'frame', name: 'Source', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 }, layout: { item: { position: { mode: 'flow' } }, container: { display: 'freeform' } } },
  },
  relationships: {
    ...document.relationships,
    'source-frame': { parentId: 'root_cloud', orderKey: 'V' },
    'target-frame': { parentId: 'root_cloud', orderKey: 'W' },
    source: { parentId: 'source-frame', orderKey: 'V' },
  },
}

const componentDocument: FileDocument = {
  ...flowDocument,
  nodes: {
    ...flowDocument.nodes,
    'source-face': { id: 'source-face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 } },
    'source-label': { id: 'source-label', type: 'text', name: 'Label', text: 'Continue', styles: { relativeTransform: [1, 0, 0, 1, 4, 5], width: 24, height: 18 }, ...legacyTextProperties() },
    'source-slot': { id: 'source-slot', type: 'frame', name: 'Icon slot', styles: { relativeTransform: [1, 0, 0, 1, 30, 5], width: 16, height: 16 } },
    'source-icon-use': { id: 'source-icon-use', type: 'frame', name: 'Icon use', styles: { relativeTransform: [0.866, 0.5, -0.5, 0.866, 1, 1], width: 14, height: 14 } },
    'icon-master': { id: 'icon-master', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 60, 0], width: 14, height: 14 } },
    'icon-shape': { id: 'icon-shape', type: 'rectangle', name: 'Shape', styles: { relativeTransform: [1, 0, 0, 1, 1, 1], width: 12, height: 12 } },
  },
  relationships: {
    ...flowDocument.relationships,
    'source-face': { parentId: 'source', orderKey: 'V' },
    'source-label': { parentId: 'source', orderKey: 'W' },
    'source-slot': { parentId: 'source', orderKey: 'X' },
    'source-icon-use': { parentId: 'source-slot', orderKey: 'V' },
    'icon-master': { parentId: 'root_cloud', orderKey: 'X' },
    'icon-shape': { parentId: 'icon-master', orderKey: 'V' },
  },
  componentModel: {
    definitions: {
      'component:icon': { id: 'component:icon', name: 'Icon', source: { kind: 'canvas', masterRootId: 'icon-master' }, revision: 0, properties: [], materials: [], parts: [{ id: 'part:shape', name: 'Shape', nodeId: 'icon-shape' }], interactions: [] },
    },
    instances: { 'source-icon-use': { id: 'source-icon-use', componentId: 'component:icon', values: {} } },
  },
}

const flowGeometry = (x: number, y: number) => ({
  coordinateSpace: 'world' as const,
  quad: [{ x, y }, { x: x + 40, y }, { x: x + 40, y: y + 30 }, { x, y: y + 30 }] as const,
  aabb: { x, y, width: 40, height: 30 }, semanticSize: { width: 40, height: 30 },
})

const flowPresentation = (sequence: number, terminal = false): FlowDragPresentation => Object.freeze({
  kind: 'flow-drag', coordinateSpace: 'world', identity: { interactionId: 'cloud-flow', gestureGeneration: 1, sampleSequence: sequence },
  fence: { fileId: metadata.id, fileRevision: 0, measurementRevision: 1, documentRevision: 0, layoutGeneration: 5, pageId: 'page_cloud', pageRootId: 'root_cloud' },
  retention: terminal
    ? { kind: 'terminal-retained', gestureGeneration: 1, sampleSequence: sequence, terminalReason: 'pointer-up', terminalSampleSequence: sequence, holdUntil: 'authoritative-geometry' }
    : { kind: 'active', gestureGeneration: 1, sampleSequence: sequence },
  pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
  original: {
    documentNodeId: 'source', kind: 'frame', name: 'Source', sourceRelationship: { parentId: 'source-frame', orderKey: 'V', slot: { presence: 'absent' } }, sourceIndex: 0,
    mode: 'flow', source: flowGeometry(0, 0), current: flowGeometry(10, 20), sourceOffsetParentPose: null,
    dom: { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null },
    namePresentation: { visible: true, anchor: 'source', pose: flowGeometry(0, 0) },
  },
  movingVisual: { kind: 'fill-ghost', documentNodeId: null, geometry: flowGeometry(10, 20), fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden' },
  supportClone: null,
  target: { parentId: 'target-frame', slot: { presence: 'absent' }, rawIndex: 0, semanticIndex: 0, line: 0,
    parentOutline: { coordinateSpace: 'world', quad: [{ x: 300, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 200 }, { x: 300, y: 200 }],
      aabb: { x: 300, y: 0, width: 200, height: 200 }, color: 'oklch(0.67 0.17 258)', widthCssPx: 2 }, insertionGuide: null },
  hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
  mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
}) as unknown as FlowDragPresentation
const peerFlowPresentation = (sequence: number, serverLeaseId = '55555555-5555-4555-8555-555555555555'): FlowDragPresentation => {
  const presentation = flowPresentation(sequence)
  return Object.freeze({ ...presentation, identity: { ...presentation.identity, interactionId: `lease:${serverLeaseId}` } }) as FlowDragPresentation
}
const imageResponse = () => new Response(imageBytes.slice(), {
  status: 200,
  headers: {
    'Content-Type': imageAsset.mime,
    'Content-Length': String(imageAsset.bytes),
    'X-Canvas-Asset-Id': imageAsset.id,
    'X-Canvas-Asset-Mime': imageAsset.mime,
    'X-Canvas-Asset-Extension': imageAsset.extension,
    'X-Canvas-Asset-Bytes': String(imageAsset.bytes),
    'X-Canvas-Asset-Width': String(imageAsset.width),
    'X-Canvas-Asset-Height': String(imageAsset.height),
    'X-Canvas-Asset-Sha256': imageAsset.sha256,
  },
})

describe('UI-COLLAB-STATE-001 collaboration shell state', () => {
  it('maps transport phases to the small visible product vocabulary', () => {
    expect(collaborationShellState('opening')).toBe('opening')
    expect(collaborationShellState('hydrating-local')).toBe('connecting')
    expect(collaborationShellState('admission-queued')).toBe('connecting')
    expect(collaborationShellState('authorizing', true)).toBe('reconnecting')
    expect(collaborationShellState('admission-queued', true)).toBe('reconnecting')
    expect(collaborationShellState('replaying')).toBe('reconnecting')
    expect(collaborationShellState('access-revoked')).toBe('access-removed')
    expect(collaborationShellState('incompatible-build')).toBe('update-required')
    expect(collaborationShellState('capacity-refused')).toBe('file-busy')
    expect(collaborationShellState('connection-failed')).toBe('connection-failed')
    expect(collaborationShellState('closed')).toBeNull()
    expect(collaborationShellState('live')).toBeNull()
    expect(collaborationShellState('read-only')).toBeNull()
  })
})
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

class ScriptedSocket implements CollaborationWebSocket {
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<keyof CollaborationSocketEventMap, Set<(event: never) => void>>()
  onSend: (message: Record<string, unknown>) => void = () => undefined

  constructor() { queueMicrotask(() => { this.readyState = 1; this.emit('open', new Event('open')) }) }
  addEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void) {
    let listeners = this.listeners.get(type)
    if (!listeners) { listeners = new Set(); this.listeners.set(type, listeners) }
    listeners.add(listener as (event: never) => void)
  }
  removeEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void) { this.listeners.get(type)?.delete(listener as (event: never) => void) }
  send(data: string) { const message = JSON.parse(data) as Record<string, unknown>; this.sent.push(message); this.onSend(message) }
  close() { this.readyState = 3 }
  disconnect() { this.readyState = 3; this.emit('close', { type: 'close', code: 1006, reason: 'network lost', wasClean: false } as CloseEvent) }
  server(value: CollaborationServerMessage) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) })) }
  private emit<K extends keyof CollaborationSocketEventMap>(type: K, event: CollaborationSocketEventMap[K]) { for (const listener of this.listeners.get(type) ?? []) listener(event as never) }
}

const roomEnvelope = (fileId = metadata.id, sequence = '9'): ServerRoomEnvelope => ({
  protocolEpoch: collaborationProtocolEpoch,
  schemaVersion: collaborationEnvelopeSchemaVersion,
  room: { fileId, generationId: '22222222-2222-4222-8222-222222222222' },
  fenceToken: sequence,
})

function scriptRoom(socket: ScriptedSocket, file: FileDocument, onOperation?: (message: Extract<CollaborationClientMessage, { type: 'operation.submit' }>) => void, role: 'owner' | 'viewer' = 'owner') {
  const envelope = roomEnvelope(file.fileId)
  let requestId = ''
  const streamSnapshot = () => {
    const bytes = new TextEncoder().encode(JSON.stringify(file))
    const digest = createHash('sha256').update(bytes).digest('hex')
    const snapshotId = `projection:${file.revision}`
    socket.server({ type: 'load.phase', envelope, requestId, phase: 'stream' })
    socket.server({
      type: 'snapshot.begin', envelope, requestId, snapshotId,
      documentSchemaVersion: collaborationDocumentSchemaVersion,
      baseSequence: String(file.revision), compression: 'none', contentEncoding: 'utf-8',
      storedByteLength: bytes.byteLength, documentByteLength: bytes.byteLength,
      objectDigest: digest, documentDigest: digest, chunkCount: 1,
    })
    socket.server({ type: 'snapshot.chunk', envelope, requestId, snapshotId, chunkIndex: 0, chunkCount: 1, data: Buffer.from(bytes).toString('base64') })
    socket.server({ type: 'snapshot.end', envelope, requestId, snapshotId })
    socket.server({ type: 'load.phase', envelope, requestId, phase: 'apply' })
    socket.server({ type: 'sync.ready', envelope, requestId, snapshotId, serverSequence: String(file.revision), role })
  }
  socket.onSend = raw => {
    const message = raw as CollaborationClientMessage
    if (message.type === 'room.open') {
      requestId = message.requestId
      socket.server({ type: 'room.assigned', envelope, requestId, role, replayScopeId: 'a'.repeat(64) })
      streamSnapshot()
      return
    }
    if (message.type === 'room.resume') return
    if (message.type === 'operation.submit') onOperation?.(message)
  }
  return envelope
}

const waitFor = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (ready()) return; await new Promise(resolve => setTimeout(resolve, 1)) }
  throw new Error('Timed out waiting for the scripted socket.')
}

const memoryOnlyDurableStore: CollaborationDurableStore = Object.freeze({
  load: async () => null,
  repair: async () => undefined,
  enqueue: async () => undefined,
  checkpoint: async () => undefined,
  acknowledge: async () => undefined,
  markRecoverable: async () => undefined,
  markAllRecoverable: async () => undefined,
  reconcileReplayScope: async () => undefined,
  clearCheckpoint: async () => undefined,
  purgeAccount: async () => undefined,
})

const signedInSessionResponse = () => json({
  user: {
    id: 'user-local',
    name: 'Local user',
    email: 'local@example.com',
    image: null,
  },
})

const scriptedSync = (file: typeof document) => ({
  syncOrigin: 'wss://sync.canvas.test',
  syncClientId: `tab-${file.fileId}`,
  syncDurableStore: memoryOnlyDurableStore,
  createWebSocket: () => {
    const socket = new ScriptedSocket()
    scriptRoom(socket, file)
    return socket
  },
}) as const

describe('cloud adapter', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('AT-SHARE-003 preserves the current page and node in the share URL without changing access', () => {
    const fetcher = vi.fn(async () => json({ error: { code: 'not_found', message: 'Not found.' } }, 404)) as unknown as typeof fetch
    vi.stubGlobal('window', { location: { href: `https://canvas.test/file/${metadata.id}?pageId=page_cloud&nodeId=root_cloud`, origin: 'https://canvas.test' } })
    const adapter = createCloudAdapter({ apiOrigin: 'https://api.canvas.test', editorOrigin: 'https://canvas.test', fetch: fetcher })
    expect(adapter.shareUrl?.(metadata.id)).toBe(`https://canvas.test/file/${metadata.id}?pageId=page_cloud&nodeId=root_cloud`)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('CLOUD-SYNC-CLIENT-001 lists and creates files but fails closed when live sync is unavailable', async () => {
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/api/files') && init?.method === 'POST') return json({ file: metadata }, 201)
      if (url.endsWith('/api/files')) return json({ files: [metadata] })
      return json({ file: metadata })
    }) as typeof fetch
    const adapter = createCloudAdapter({ apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test', fetch: fetcher })
    expect(await adapter.listFiles?.()).toEqual([{ id: metadata.id, name: metadata.name, location: 'Cloud', updatedAt: metadata.updatedAt, thumbnailUrl: 'https://assets.canvas.test/file-assets/thumbnails/11111111-2222-4333-8444-555555555555/thumbnail.avif' }])
    expect((await adapter.createFile?.())?.id).toBe(metadata.id)
    await expect(adapter.openFile?.(metadata.id)).rejects.toThrow('Live sync is unavailable')
    expect(calls.some(call => call.endsWith('/document'))).toBe(false)
  })

  it('CLOUD-FILES-001 rejects the canonical malformed hosted document at the browser boundary', async () => {
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      ...scriptedSync(malformedHostedDocument()),
      fetch: (async () => json({ file: metadata })) as typeof fetch,
    })

    const opening = adapter.openFile?.(metadata.id)
    const rejected = expect(opening).rejects.toThrow('This file contains invalid data. Error ID: invalid-file-document')
    await vi.waitFor(() => expect(adapter.collaboration?.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'This file contains invalid data. Error ID: invalid-file-document',
    }))
    await rejected
    adapter.dispose()
  })

  it('FILE-ASSET-LIFECYCLE-001 hydrates verified render bytes when opening a referenced cloud asset', async () => {
    const calls: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test', ...scriptedSync(imageDocument),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input); calls.push(url)
        if (url.includes('/file-assets/')) return imageResponse()
        return json({ file: metadata })
      }) as typeof fetch,
    })

    const opened = await adapter.openFile?.(metadata.id)

    expect(opened?.assetPreviews).toEqual([{ assetId: imageAsset.id, sha256: imageAsset.sha256, mime: imageAsset.mime, data: 'AQIDBA==' }])
    expect(calls).toContain(`https://assets.canvas.test/file-assets/${metadata.id}/${imageAsset.id}.png`)
    adapter.dispose()
  })

  it('FILE-ASSET-LIFECYCLE-001 refuses a referenced cloud asset when the asset service is absent', async () => {
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', ...scriptedSync(imageDocument),
      fetch: (async () => json({ file: metadata })) as typeof fetch,
    })

    await expect(adapter.openFile?.(metadata.id)).rejects.toThrow('asset service is required')
    adapter.dispose()
  })

  it('FILE-ASSET-LIFECYCLE-001 uploads and verifies bytes before returning the editor sidecar', async () => {
    const calls: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/file-assets/upload-intents')) return json({
          method: 'PUT', path: '/file-assets/uploads', token: 'upload-token', expiresAt: '2026-10-10T23:00:00.000Z',
          headers: { 'Content-Length': String(imageAsset.bytes), 'Content-Type': imageAsset.mime, 'X-Canvas-Upload-Token': 'upload-token' },
        })
        if (url.endsWith('/file-assets/uploads')) return json({
          id: imageAsset.id, mime: imageAsset.mime, extension: imageAsset.extension, bytes: imageAsset.bytes,
          width: imageAsset.width, height: imageAsset.height, sha256: imageAsset.sha256,
        })
        if (url.includes('/file-assets/')) return imageResponse()
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })

    const uploaded = await adapter.assets?.uploadImage({ fileId: metadata.id, asset: imageAsset, bytes: imageBytes })

    expect(uploaded).toEqual({ asset: imageAsset, preview: { assetId: imageAsset.id, sha256: imageAsset.sha256, mime: imageAsset.mime, data: 'AQIDBA==' } })
    expect(calls).toEqual([
      'POST https://assets.canvas.test/file-assets/upload-intents',
      'PUT https://assets.canvas.test/file-assets/uploads',
      `GET https://assets.canvas.test/file-assets/${metadata.id}/${imageAsset.id}.png`,
    ])
    adapter.dispose()
  })

  it('gates the cloud workspace on the hosted session and opens the dedicated login app', async () => {
    const navigated: string[] = []
    const reload = vi.fn()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      loginOrigin: 'https://login.canvas.test',
      navigate: url => navigated.push(url),
      reload,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/api/session')) return json({ error: { code: 'unauthorized', message: 'Sign in required.' } }, 401)
        if (String(input).endsWith('/api/auth/sign-out') && init?.method === 'POST') return json({ success: true })
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })
    const auth = adapter.auth
    expect(auth).toBeDefined()
    if (!auth) throw new Error('Cloud auth was not configured')
    expect((await auth.getSession()).status).toBe('signed-out')
    expect((await auth.signInWithGitHub()).status).toBe('signing-in')
    expect(navigated).toEqual(['https://login.canvas.test/'])
    expect((await auth.signOut()).status).toBe('signed-out')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('CLOUD-SYNC-CACHE-001 purges the signed-in account cache before sign-out reload', async () => {
    const purgeAccount = vi.fn(async () => undefined)
    const reload = vi.fn()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test',
      syncDurableStore: { ...memoryOnlyDurableStore, purgeAccount }, reload,
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session')
        ? json({ user: { id: 'user-one', name: 'One', email: 'one@example.com', image: null } })
        : new Response(null, { status: 204 })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.auth?.signOut()
    expect(purgeAccount).toHaveBeenCalledWith('user-one')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('CLOUD-SYNC-CACHE-001 purges and reloads before exposing another account', async () => {
    const purgeAccount = vi.fn(async () => undefined)
    const reload = vi.fn()
    let request = 0
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test',
      syncDurableStore: { ...memoryOnlyDurableStore, purgeAccount }, reload,
      fetch: (async () => {
        request += 1
        const id = request === 1 ? 'user-one' : 'user-two'
        return json({ user: { id, name: id, email: `${id}@example.com`, image: null } })
      }) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.auth?.getSession()
    expect(purgeAccount).toHaveBeenCalledWith('user-one')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('CLOUD-SYNC-CACHE-001 purges and reloads when an active session expires', async () => {
    const purgeAccount = vi.fn(async () => undefined)
    const reload = vi.fn()
    let request = 0
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test',
      syncDurableStore: { ...memoryOnlyDurableStore, purgeAccount }, reload,
      fetch: (async () => {
        request += 1
        return request === 1
          ? json({ user: { id: 'user-one', name: 'One', email: 'one@example.com', image: null } })
          : json({ error: { code: 'unauthorized', message: 'Sign in required.' } }, 401)
      }) as typeof fetch,
    })
    await adapter.auth?.getSession()
    expect((await adapter.auth?.getSession())?.status).toBe('signed-out')
    expect(purgeAccount).toHaveBeenCalledWith('user-one')
    expect(reload).toHaveBeenCalledOnce()
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'unavailable', localClientId: null })
  })

  it('CLOUD-SYNC-CLIENT-001 uses one semantic live authority and publishes the next remote update', async () => {
    const sockets: ScriptedSocket[] = []
    const calls: string[] = []
    const remoteSnapshots: number[] = []
    const loadDurableScope = vi.fn(async () => null)
    let envelope = roomEnvelope()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      loginOrigin: 'https://login.canvas.test',
      syncOrigin: 'wss://sync.canvas.test',
      syncClientId: 'tab-1',
      syncBuildId: '0.1.0-staging',
      syncDurableStore: { ...memoryOnlyDurableStore, load: loadDurableScope },
      createWebSocket: (url, protocol) => {
        expect(url).toBe(`wss://sync.canvas.test/sync/${metadata.id}?tabId=tab-1`)
        expect(protocol).toBe(collaborationWebSocketProtocol)
        const socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document, message => socket.server({ type: 'operation.ack', envelope, mutationId: message.operation.mutationId, sequence: '1', status: 'applied' }))
        sockets.push(socket)
        return socket
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/api/session')) return signedInSessionResponse()
        return json({ file: metadata })
      }) as typeof fetch,
    })
    adapter.subscribeFile?.(snapshot => { if (snapshot) remoteSnapshots.push(snapshot.file.revision) })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    expect(sockets[0]!.sent.find(message => message.type === 'room.open')).toMatchObject({ buildId: '0.1.0-staging' })
    expect(loadDurableScope).toHaveBeenCalledWith({
      accountId: 'user-local',
      clientId: 'tab-1',
      fileId: metadata.id,
      documentSchemaVersion: collaborationDocumentSchemaVersion,
      protocolEpoch: collaborationProtocolEpoch,
    })
    sockets[0]!.server({
      type: 'presence.roster', envelope, participants: [
        { presenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectId: 'user-local', displayName: 'Local user', avatarUrl: null, clientId: 'tab-1', role: 'owner', sequence: null, data: { pageId: null, focused: false, selection: null, camera: null, cursor: null } },
        { presenceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', subjectId: 'user-remote', displayName: 'Remote user', avatarUrl: 'https://images.test/remote.png', clientId: 'tab-2', role: 'viewer', sequence: null, data: { pageId: 'page_cloud', focused: true, selection: null, camera: null, cursor: null } },
      ],
    })
    await waitFor(() => adapter.collaboration?.getSnapshot().participants.length === 2)
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'live', localClientId: 'tab-1', participants: [{ displayName: 'Local user' }, { displayName: 'Remote user', role: 'viewer', avatarUrl: 'https://images.test/remote.png' }] })
    adapter.collaboration?.updateAwareness({ pageId: 'page_cloud', focused: true, cursor: { pageId: 'page_cloud', x: 12, y: 18 } })
    await waitFor(() => sockets[0]!.sent.some(message => message.type === 'presence.update'))
    const localCommand = { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Local page' } as const
    const localFile = applyHostedFileCommand(document, localCommand)
    const saved = await adapter.saveFile(localFile, 0, { kind: 'commands', commands: [localCommand] })
    expect(saved.file.revision).toBe(1)
    expect(calls.some(call => call.startsWith('PUT '))).toBe(false)
    sockets[0]!.server({
      type: 'operation.applied', envelope, mutationId: 'remote-mutation-0001', sequence: '2', subjectId: 'other',
      command: { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Remote page' },
    })
    await waitFor(() => remoteSnapshots.length === 1)
    expect(remoteSnapshots).toEqual([2])
    expect((await adapter.refresh()).file).toMatchObject({ revision: 2, pages: [{ name: 'Remote page' }] })
    expect(calls.some(call => call.endsWith('/document'))).toBe(false)
    sockets[0]!.disconnect()
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'reconnecting', canMutate: true, canManageShare: true, localProfile: { role: 'owner' } })
    adapter.dispose()
  })

  it('CLOUD-SYNC-CLIENT-001 submits edit, undo, and redo through the same live command path', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    let sequence = 0
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-history', syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document, message => {
          sequence += 1
          socket!.server({ type: 'operation.ack', envelope, mutationId: message.operation.mutationId, sequence: String(sequence), status: 'applied' })
        })
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session')
        ? signedInSessionResponse()
        : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    const history = applyFileCommandWithHistory(document, { type: 'page.rename', pageId: 'page_cloud', name: 'Renamed' }, [])
    const edited = await adapter.saveFile(history.file, 0, { kind: 'commands', commands: [history.redo] })
    const undoneFile = applyHostedFileCommand(edited.file, history.undo)
    const undone = await adapter.saveFile(undoneFile, 1, { kind: 'commands', commands: [history.undo] })
    const redoneFile = applyHostedFileCommand(undone.file, history.redo)
    const redone = await adapter.saveFile(redoneFile, 2, { kind: 'commands', commands: [history.redo] })

    expect(edited.file).toMatchObject({ revision: 1, pages: [{ name: 'Renamed' }] })
    expect(undone.file).toMatchObject({ revision: 2, pages: [{ name: 'Page 1' }] })
    expect(redone.file).toMatchObject({ revision: 3, pages: [{ name: 'Renamed' }] })
    expect(socket!.sent.filter(message => message.type === 'operation.submit').map(message => (message.operation as { command: unknown }).command)).toEqual([history.redo, history.undo, history.redo])
    adapter.dispose()
  })

  it('[COMPONENT-BINDING-SAVE-001] saves a newly placed hosted component through live sync', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1', syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document, message => socket!.server({ type: 'operation.ack', envelope, mutationId: message.operation.mutationId, sequence: '1', status: 'applied' }))
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session')
        ? signedInSessionResponse()
        : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    const command = {
      type: 'node.insert' as const,
      node: { id: 'button', type: 'component' as const, componentId: 'sample-button', exportName: 'Button', props: { children: 'Save', variant: 'primary' } },
      placement: { parentId: document.pages[0]!.rootNodeId },
    }
    const changed = applyHostedFileCommand(document, command, browserHollowAtoms)

    const saved = await adapter.saveFile(changed, 0, { kind: 'commands', commands: [command] })

    expect(saved.file.nodes.button).toMatchObject({ componentId: 'sample-button', exportName: 'Button' })
    expect(socket!.sent.some(message => message.type === 'operation.submit')).toBe(true)
    adapter.dispose()
  })

  it('CLOUD-SYNC-COMPONENT-001 CLOUD-SYNC-COMPONENT-002 keeps one live socket while advanced component metadata changes', async () => {
    const sockets: ScriptedSocket[] = []
    let envelope = roomEnvelope()
    let sequence = 0
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-component-authoring', syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        const socket = new ScriptedSocket()
        envelope = scriptRoom(socket, componentDocument, message => {
          sequence += 1
          socket.server({ type: 'operation.ack', envelope, mutationId: message.operation.mutationId, sequence: String(sequence), status: 'applied' })
        })
        sockets.push(socket)
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session')
        ? signedInSessionResponse()
        : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    const definition = {
      id: 'component:surface', name: 'Surface', source: { kind: 'canvas' as const, masterRootId: 'source' }, revision: 0,
      properties: [], materials: [], parts: [{ id: 'part:surface', name: 'Surface', nodeId: 'source' }], interactions: [],
    }
    const create = { type: 'component.create' as const, definition }
    const createdFile = applyHostedFileCommand(componentDocument, create)
    const created = await adapter.saveFile(createdFile, 0, { kind: 'commands', commands: [create] })
    expect(adapter.collaboration?.getSnapshot().status).toBe('live')

    const authored = {
      ...definition,
      revision: 1,
      properties: [
        {
          id: 'property:state', name: 'State', type: 'variant' as const, defaultValueId: 'value:default',
          values: [{ id: 'value:default', name: 'Default' }, { id: 'value:hover', name: 'Hover' }],
          binding: { kind: 'variant' as const, nodeId: 'source-face', appearances: { 'value:default': {}, 'value:hover': { opacity: 0.8 } } },
        },
        {
          id: 'property:tone', name: 'Tone', type: 'variant' as const, defaultValueId: 'value:neutral',
          values: [{ id: 'value:neutral', name: 'Neutral' }, { id: 'value:danger', name: 'Danger' }],
          binding: { kind: 'variant' as const, nodeId: 'source-face', appearances: { 'value:neutral': {}, 'value:danger': { opacity: 0.7 } } },
        },
        { id: 'property:label', name: 'Label', type: 'text' as const, defaultValue: 'Continue', binding: { kind: 'text' as const, nodeId: 'source-label' } },
        { id: 'property:visible', name: 'Visible', type: 'boolean' as const, defaultValue: true, binding: { kind: 'visibility' as const, nodeId: 'source-face' } },
        { id: 'property:content', name: 'Content', type: 'slot' as const, binding: { kind: 'slot' as const, nodeId: 'source-slot' } },
        { id: 'property:icon', name: 'Icon', type: 'instance-swap' as const, defaultValue: 'component:icon', binding: { kind: 'instance-swap' as const, nodeId: 'source-icon-use' } },
      ],
      variantAppearances: { 'source-face': {
        'property:state=value:default|property:tone=value:neutral': { opacity: 0.99 },
        'property:state=value:default|property:tone=value:danger': { opacity: 0.9 },
        'property:state=value:hover|property:tone=value:neutral': { opacity: 0.8 },
        'property:state=value:hover|property:tone=value:danger': { opacity: 0.7 },
      } },
      materials: [{ id: 'material:surface', group: 'Base', name: 'Surface', appearance: {} }],
      parts: [{ id: 'part:surface', name: 'Surface', nodeId: 'source-face', materialId: 'material:surface' }],
      interactions: [{ id: 'interaction:hover', trigger: 'pointer-hover' as const, propertyId: 'property:state', valueId: 'value:hover' }],
    }
    const replace = { type: 'component.replace' as const, componentId: definition.id, expectedRevision: 0, definition: authored }
    const authoredFile = applyHostedFileCommand(created.file, replace)
    const saved = await adapter.saveFile(authoredFile, 1, { kind: 'commands', commands: [replace] })

    expect(saved.file.componentModel.definitions[definition.id]).toEqual(authored)
    expect(adapter.collaboration?.getSnapshot().status).toBe('live')
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.sent.filter(message => message.type === 'operation.submit')).toHaveLength(2)
    adapter.dispose()
  })

  it('FILE-ASSET-LIFECYCLE-001 never publishes an older remote snapshot after its asset hydration is superseded', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const assetGate = deferred<Response>()
    const remoteSnapshots: number[] = []
    const reportError = vi.fn()
    let assetRequested = false
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1', reportError,
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document)
        return socket
      },
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/file-assets/')) { assetRequested = true; return assetGate.promise }
        return json({ file: metadata })
      }) as typeof fetch,
    })
    adapter.subscribeFile?.(snapshot => { if (snapshot) remoteSnapshots.push(snapshot.file.revision) })
    await adapter.openFile?.(metadata.id)

    socket!.server({ type: 'operation.applied', envelope, mutationId: 'remote-asset-attach', sequence: '1', subjectId: 'other', command: { type: 'asset.attach', asset: imageAsset } })
    await waitFor(() => assetRequested)
    socket!.server({ type: 'operation.applied', envelope, mutationId: 'remote-asset-detach', sequence: '2', subjectId: 'other', command: { type: 'asset.detach', assetId: imageAsset.id } })
    await waitFor(() => remoteSnapshots.length === 1)
    assetGate.resolve(imageResponse())
    await Promise.resolve()

    expect(remoteSnapshots).toEqual([2])
    expect(reportError).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it('FILE-ASSET-LIFECYCLE-001 publishes the newest live revision after initial asset hydration finishes', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const firstAssetGate = deferred<Response>()
    const remoteSnapshots: number[] = []
    let assetRequests = 0
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1',
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, imageDocument)
        return socket
      },
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/file-assets/')) {
          assetRequests += 1
          return assetRequests === 1 ? firstAssetGate.promise : imageResponse()
        }
        return json({ file: metadata })
      }) as typeof fetch,
    })
    adapter.subscribeFile?.(snapshot => { if (snapshot) remoteSnapshots.push(snapshot.file.revision) })
    const opening = adapter.openFile?.(metadata.id)
    await waitFor(() => assetRequests === 1)
    socket!.server({
      type: 'operation.applied', envelope, mutationId: 'remote-during-open', sequence: '1', subjectId: 'other',
      command: { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Newest page' },
    })
    firstAssetGate.resolve(imageResponse())

    expect((await opening)?.file.revision).toBe(0)
    await waitFor(() => remoteSnapshots.length === 1)
    expect(remoteSnapshots).toEqual([1])
    expect(assetRequests).toBe(2)
    adapter.dispose()
  })

  it('FILE-ASSET-LIFECYCLE-001 surfaces remote hydration failures through the project failure channel', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const failures: Array<Readonly<{ operation: 'asset_hydration'; error: unknown }>> = []
    const reportError = vi.fn()
    const requestId = '11111111-1111-4111-8111-111111111111'
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1', reportError,
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document)
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).includes('/file-assets/')
        ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'Missing.' } }), { status: 404, headers: { 'Content-Type': 'application/json', 'X-Canvas-Request-Id': requestId } })
        : json({ file: metadata })) as typeof fetch,
    })
    adapter.subscribeFailures?.(failure => failures.push(failure))
    await adapter.openFile?.(metadata.id)

    socket!.server({ type: 'operation.applied', envelope, mutationId: 'missing-asset', sequence: '1', subjectId: 'other', command: { type: 'asset.attach', asset: imageAsset } })
    await waitFor(() => failures.length === 1)

    expect(failures[0]).toMatchObject({ operation: 'asset_hydration', error: { code: 'not_confirmed', requestId } })
    expect(reportError).toHaveBeenCalledWith(failures[0]!.error, 'asset_hydration')
    adapter.dispose()
  })

  it('FILE-ASSET-LIFECYCLE-001 publishes a newer live revision after foreground refresh hydration fails', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const firstAssetGate = deferred<Response>()
    const refreshAssetGate = deferred<Response>()
    const remoteSnapshots: number[] = []
    let assetRequests = 0
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', assetsOrigin: 'https://assets.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1',
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document)
        return socket
      },
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/file-assets/')) {
          assetRequests += 1
          if (assetRequests === 1) return firstAssetGate.promise
          if (assetRequests === 2) return refreshAssetGate.promise
          return imageResponse()
        }
        return json({ file: metadata })
      }) as typeof fetch,
    })
    adapter.subscribeFile?.(snapshot => { if (snapshot) remoteSnapshots.push(snapshot.file.revision) })
    await adapter.openFile?.(metadata.id)
    socket!.server({ type: 'operation.applied', envelope, mutationId: 'asset-before-refresh', sequence: '1', subjectId: 'other', command: { type: 'asset.attach', asset: imageAsset } })
    await waitFor(() => assetRequests === 1)

    const refreshing = adapter.refresh()
    await waitFor(() => assetRequests === 2)
    socket!.server({
      type: 'operation.applied', envelope, mutationId: 'newer-during-refresh', sequence: '2', subjectId: 'other',
      command: { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Newest page' },
    })
    refreshAssetGate.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Missing.' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }))

    await expect(refreshing).rejects.toThrow('missing')
    await waitFor(() => remoteSnapshots.length === 1)
    expect(remoteSnapshots).toEqual([2])
    firstAssetGate.resolve(imageResponse())
    adapter.dispose()
  })

  it('CLOUD-SYNC-PRESENCE-001 sources the local profile from auth without waiting for roster membership', async () => {
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-local',
      syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        const socket = new ScriptedSocket()
        scriptRoom(socket, document)
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session')
        ? json({ user: { id: 'user-local', name: 'Local user', email: 'local@example.com', image: 'https://images.test/local.png' } })
        : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({
      status: 'live', participants: [],
      localProfile: { subjectId: 'user-local', displayName: 'Local user', avatarUrl: 'https://images.test/local.png', role: 'owner' },
    })
    adapter.dispose()
  })

  it('CLOUD-SYNC-CONFLICT-001 rebases a stale semantic save onto the newest room revision', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const submitted: Extract<CollaborationClientMessage, { type: 'operation.submit' }>[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1', syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document, message => {
          submitted.push(message)
          socket!.server({ type: 'operation.ack', envelope, mutationId: message.operation.mutationId, sequence: '2', status: 'applied' })
        })
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session')
        ? signedInSessionResponse()
        : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    socket!.server({ type: 'operation.applied', envelope, mutationId: 'remote-mutation-0001', sequence: '1', subjectId: 'other', command: { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Remote page' } })
    const localCommand = { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Local page' } as const
    const saved = await adapter.saveFile(applyHostedFileCommand(document, localCommand), 0, { kind: 'commands', commands: [localCommand] })

    expect(saved.file).toMatchObject({ revision: 2, pages: [{ name: 'Local page' }] })
    expect(submitted[0]!.operation).toMatchObject({ baseSequence: '1', command: localCommand })
    adapter.dispose()
  })

  it('CLOUD-SYNC-READONLY-001 preserves viewer authority and local profile across roster churn and reconnect', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-viewer',
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document, undefined, 'viewer')
        return socket
      },
      fetch: (async () => json({ file: metadata })) as typeof fetch,
    })
    await adapter.openFile?.(metadata.id)
    socket!.server({
      type: 'presence.roster', envelope, participants: [
        { presenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectId: 'user-viewer', displayName: 'Viewer', avatarUrl: 'https://images.test/viewer.png', clientId: 'tab-viewer', role: 'viewer', sequence: null, data: { pageId: 'page_cloud', focused: true, selection: null, camera: null, cursor: null } },
      ],
    })
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({
      status: 'read-only', canMutate: false, canManageShare: false, agents: [],
      localProfile: { subjectId: 'user-viewer', displayName: 'Viewer', role: 'viewer' },
      participants: [{ isHeadless: false }],
    })
    socket!.server({ type: 'presence.roster', envelope, participants: [] })
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ participants: [], localProfile: { subjectId: 'user-viewer', role: 'viewer' } })
    socket!.disconnect()
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'reconnecting', canMutate: false, canManageShare: false, localProfile: { subjectId: 'user-viewer', role: 'viewer' } })
    adapter.dispose()
  })

  it('CLOUD-SYNC-READONLY-001 fails closed and clears cached authority when access is revoked', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-owner',
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, document)
        return socket
      },
      fetch: (async () => json({ file: metadata })) as typeof fetch,
    })
    const fileUpdates: (EditorProjectSnapshot | null)[] = []
    adapter.subscribeFile?.(snapshot => fileUpdates.push(snapshot))
    await adapter.openFile?.(metadata.id)
    socket!.server({
      type: 'presence.roster', envelope, participants: [
        { presenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectId: 'user-owner', displayName: 'Owner', avatarUrl: null, clientId: 'tab-owner', role: 'owner', sequence: null, data: { pageId: 'page_cloud', focused: true, selection: null, camera: null, cursor: null } },
      ],
    })
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'live', canMutate: true, canManageShare: true, localProfile: { role: 'owner' } })
    socket!.server({ type: 'room.error', envelope, code: 'access_revoked', message: 'Access was removed.', retry: 'none' })
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'error', shellState: 'access-removed', canMutate: false, canManageShare: false, localProfile: null })
    expect(fileUpdates).toEqual([null])
    socket!.server({ type: 'room.error', envelope, code: 'access_revoked', message: 'Access was removed.', retry: 'none' })
    expect(fileUpdates).toEqual([null])
    adapter.dispose()
  })

  it.each([
    { code: 'incompatible_build', message: 'This build is incompatible.', retry: 'refresh', shellState: 'update-required' },
    { code: 'capacity_refused', message: 'This room is full.', retry: 'retry', retryAfterMs: 250, shellState: 'file-busy' },
  ] as const)('CLOUD-SYNC-READONLY-001 fails closed on terminal $code errors', async terminalError => {
    let socket: ScriptedSocket | null = null
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-owner',
      createWebSocket: () => {
        socket = new ScriptedSocket()
        socket.onSend = raw => {
          const message = raw as CollaborationClientMessage
          if (message.type !== 'room.open') return
          socket!.server({
            type: 'request.error', protocolEpoch: collaborationProtocolEpoch, schemaVersion: collaborationEnvelopeSchemaVersion,
            requestId: message.requestId, code: terminalError.code, message: terminalError.message,
            retry: terminalError.retry,
            ...('retryAfterMs' in terminalError ? { retryAfterMs: terminalError.retryAfterMs } : {}),
          })
        }
        return socket
      },
      fetch: (async () => json({ file: metadata })) as typeof fetch,
    })
    await expect(adapter.openFile?.(metadata.id)).rejects.toThrow()
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'error', shellState: terminalError.shellState, canMutate: false, canManageShare: false, localProfile: null })
    adapter.dispose()
  })

  it('UI-COLLAB-STATE-001 retries a busy room and leaves through the adapter actions', async () => {
    const sockets: ScriptedSocket[] = []
    const navigated: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', editorOrigin: 'https://canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-owner',
      navigate: url => navigated.push(url),
      createWebSocket: () => {
        const socket = new ScriptedSocket()
        if (sockets.length === 0) {
          socket.onSend = raw => {
            const message = raw as CollaborationClientMessage
            if (message.type !== 'room.open') return
            socket.server({
              type: 'request.error', protocolEpoch: collaborationProtocolEpoch, schemaVersion: collaborationEnvelopeSchemaVersion,
              requestId: message.requestId, code: 'capacity_refused', message: 'This room is full.', retry: 'retry', retryAfterMs: 250,
            })
          }
        } else scriptRoom(socket, document)
        sockets.push(socket)
        return socket
      },
      fetch: (async () => json({ file: metadata })) as typeof fetch,
    })

    await expect(adapter.openFile?.(metadata.id)).rejects.toThrow('This room is full.')
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'error', shellState: 'file-busy' })

    adapter.collaboration?.retry?.()
    await waitFor(() => adapter.collaboration?.getSnapshot().status === 'live')
    expect(sockets).toHaveLength(2)

    adapter.collaboration?.leave?.()
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({ status: 'unavailable', localClientId: null })
    expect(navigated).toEqual(['https://canvas.test/'])
    adapter.dispose()
  })

  it('CLOUD-SYNC-READONLY-001 updates the cached local profile when reconnect changes the authoritative role before roster returns', async () => {
    const sockets: ScriptedSocket[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-local',
      createWebSocket: () => {
        const socket = new ScriptedSocket()
        scriptRoom(socket, document, undefined, sockets.length === 0 ? 'owner' : 'viewer')
        sockets.push(socket)
        return socket
      },
      fetch: (async () => json({ file: metadata })) as typeof fetch,
    })
    await adapter.openFile?.(metadata.id)
    const envelope = roomEnvelope()
    sockets[0]!.server({
      type: 'presence.roster', envelope, participants: [
        { presenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectId: 'user-local', displayName: 'Local user', avatarUrl: 'https://images.test/local.png', clientId: 'tab-local', role: 'owner', sequence: null, data: { pageId: 'page_cloud', focused: true, selection: null, camera: null, cursor: null } },
      ],
    })
    expect(adapter.collaboration?.getSnapshot().localProfile).toMatchObject({ subjectId: 'user-local', displayName: 'Local user', role: 'owner' })

    sockets[0]!.disconnect()
    await new Promise(resolve => setTimeout(resolve, 500))
    await waitFor(() => sockets.length === 2)
    expect(adapter.collaboration?.getSnapshot().error).toBeNull()
    expect(adapter.collaboration?.getSnapshot()).toMatchObject({
      status: 'read-only', canMutate: false, canManageShare: false, participants: [],
      localProfile: { subjectId: 'user-local', displayName: 'Local user', avatarUrl: 'https://images.test/local.png', role: 'viewer' },
    })
    adapter.dispose()
  })

  it('CLOUD-SYNC-EDITOR-001 lets only the newest overlapping open activate live sync', async () => {
    const firstMetadata = { ...metadata, id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'First' }
    const secondMetadata = { ...metadata, id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'Second' }
    const secondDocument = createBlankFile(secondMetadata.id, 'page_second', 'root_second', 'Second')
    const firstGate = deferred<Response>()
    const socketUrls: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1',
      createWebSocket: url => {
        socketUrls.push(url)
        const socket = new ScriptedSocket()
        scriptRoom(socket, secondDocument)
        return socket
      },
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes(firstMetadata.id)) return firstGate.promise
        if (url.includes(secondMetadata.id)) return json({ file: secondMetadata })
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })
    const firstOpen = adapter.openFile?.(firstMetadata.id)
    const secondOpen = adapter.openFile?.(secondMetadata.id)
    await secondOpen
    firstGate.resolve(json({ file: firstMetadata }))
    await expect(firstOpen).rejects.toThrow('superseded')
    await waitFor(() => socketUrls.length > 0)
    expect(socketUrls).toEqual([`wss://sync.canvas.test/sync/${secondMetadata.id}?tabId=tab-1`])
    adapter.dispose()
  })

  it('CLOUD-SYNC-LIFECYCLE-001 does not activate an open that finishes after disposal', async () => {
    const responseGate = deferred<Response>()
    const socketUrls: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1',
      createWebSocket: url => { socketUrls.push(url); return new ScriptedSocket() },
      fetch: (async () => responseGate.promise) as typeof fetch,
    })
    const opening = adapter.openFile?.(metadata.id)
    adapter.dispose()
    responseGate.resolve(json({ file: metadata }))
    await expect(opening).rejects.toThrow('superseded')
    expect(socketUrls).toEqual([])
    expect(adapter.subscribeFile?.(() => undefined)).toBeTypeOf('function')
  })

  it('CLOUD-SYNC-CLIENT-001 never falls back to the document API when a semantic command is too large', async () => {
    const calls: string[] = []
    const sockets: ScriptedSocket[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-1', syncMaxMessageBytes: 5_000,
      createWebSocket: () => {
        const socket = new ScriptedSocket()
        scriptRoom(socket, document)
        sockets.push(socket)
        return socket
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`)
        return json({ file: metadata })
      }) as typeof fetch,
    })
    await adapter.openFile?.(metadata.id)
    const commands = Array.from({ length: 80 }, (_, index) => ({ type: 'page.rename' as const, pageId: document.pages[0]!.id, name: `${index}-${'x'.repeat(90)}` }))
    const command = { type: 'batch' as const, commands }
    const changed = applyHostedFileCommand(document, command)
    await expect(adapter.saveFile(changed, 0, { kind: 'commands', commands })).rejects.toThrow('byte limit')
    expect(calls.some(call => call.startsWith('PUT '))).toBe(false)
    expect(sockets[0]!.sent.some(message => message.type === 'operation.submit')).toBe(false)
    adapter.dispose()
  })

  it('CLOUD-SYNC-CLIENT-001-C3B CLOUD-SYNC-REPLAY-001-C3B binds canonical flow authority and settles the exact acknowledged claim', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const submittedBindings: unknown[] = []
    const releases: Record<string, unknown>[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-flow', syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, flowDocument, message => {
          submittedBindings.push(message.operation.flowBinding)
          socket!.server({ type: 'operation.ack', envelope, mutationId: message.operation.mutationId, sequence: '1', status: 'applied' })
        })
        const roomSend = socket.onSend
        socket.onSend = raw => {
          const message = raw as CollaborationClientMessage
          if (message.type === 'interaction.acquire') {
            socket!.server({ type: 'interaction.result', envelope, pageId: 'page_cloud', action: 'acquire', status: 'granted', interactionId: message.presentation.identity.interactionId,
              leaseId: '55555555-5555-4555-8555-555555555555', localClaimGeneration: message.localClaimGeneration, reservationGeneration: 1,
              sampleSequence: message.presentation.identity.sampleSequence, denialCode: null })
            return
          }
          if (message.type === 'interaction.release') {
            releases.push(raw)
            socket!.server({ type: 'interaction.result', envelope, pageId: 'page_cloud', action: 'release', status: 'released', interactionId: message.interactionId,
              leaseId: message.leaseId, localClaimGeneration: message.localClaimGeneration, reservationGeneration: message.reservationGeneration,
              sampleSequence: message.terminalSampleSequence, denialCode: null })
            return
          }
          roomSend(raw)
        }
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session') ? signedInSessionResponse() : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    const collaboration = adapter.collaboration!

    expect(() => collaboration.acquireFlow?.({ presentation: flowPresentation(1) })).toThrow('topology is unavailable')
    collaboration.updateFlowAuthority?.({ file: flowDocument, atoms: browserHollowAtoms, pageId: 'page_cloud', pageRootId: 'root_cloud', documentRevision: 0, layoutGeneration: 5 })
    const acquired = collaboration.acquireFlow!({ presentation: flowPresentation(1) })
    await expect(acquired.result).resolves.toMatchObject({ status: 'granted', leaseId: '55555555-5555-4555-8555-555555555555' })
    const terminal = flowPresentation(2, true)
    collaboration.sampleFlow!({ claim: acquired.claim, presentation: terminal })
    const command = { type: 'node.rename' as const, nodeId: 'source', name: 'Moved source' }
    const changed = applyHostedFileCommand(flowDocument, command, browserHollowAtoms)
    const saved = await adapter.saveFile(changed, 0, { kind: 'commands', commands: [command], flow: { claim: acquired.claim, terminalPresentation: terminal } })

    expect(saved.file).toMatchObject({ revision: 1, nodes: { source: { name: 'Moved source' } } })
    expect(submittedBindings).toHaveLength(1)
    expect(submittedBindings[0]).toMatchObject({
      interactionId: 'cloud-flow', localClaimGeneration: acquired.claim.localClaimGeneration, reservationGeneration: 1, terminalSampleSequence: 2,
      sourceLane: { parentId: 'source-frame', slot: { presence: 'absent' } }, targetLane: { parentId: 'target-frame', slot: { presence: 'absent' } },
    })
    const submittedDigest = (submittedBindings[0] as { presentationDigest: string }).presentationDigest
    const expectedDigest = createHash('sha256').update(JSON.stringify(terminal)).digest('hex')
    const changedDigest = createHash('sha256').update(JSON.stringify(flowPresentation(3, true))).digest('hex')
    expect(submittedDigest).toBe(expectedDigest)
    expect(submittedDigest).not.toBe(changedDigest)
    expect(releases).toEqual([expect.objectContaining({ type: 'interaction.release', localClaimGeneration: acquired.claim.localClaimGeneration, terminalSampleSequence: 2, reason: 'committed' })])
    adapter.dispose()
  })

  it('PAPER-FLEX-007-C3B fails closed on stale authority and filters remote samples by the current document fence', async () => {
    let socket: ScriptedSocket | null = null
    let envelope = roomEnvelope()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-flow', syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        socket = new ScriptedSocket()
        envelope = scriptRoom(socket, flowDocument)
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session') ? signedInSessionResponse() : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    const collaboration = adapter.collaboration!
    const events: unknown[] = []
    collaboration.subscribeRemoteFlow?.(event => events.push(event))
    collaboration.updateFlowAuthority?.({ file: flowDocument, atoms: browserHollowAtoms, pageId: 'page_cloud', pageRootId: 'root_cloud', documentRevision: 0, layoutGeneration: 5 })
    socket!.server({ type: 'interaction.sample', envelope, pageId: 'page_cloud', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-remote',
      leaseId: '55555555-5555-4555-8555-555555555555', localClaimGeneration: 1, reservationGeneration: 1, presentation: peerFlowPresentation(1) })
    await Promise.resolve()
    expect(collaboration.getSnapshot()).toMatchObject({ status: 'live' })
    expect(events).toHaveLength(1)

    collaboration.updateFlowAuthority?.({ file: flowDocument, atoms: browserHollowAtoms, pageId: 'wrong-page', pageRootId: 'root_cloud', documentRevision: 0, layoutGeneration: 5 })
    expect(() => collaboration.acquireFlow?.({ presentation: flowPresentation(2) })).toThrow('topology is unavailable')
    socket!.server({ type: 'interaction.sample', envelope, pageId: 'page_cloud', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-remote',
      leaseId: '55555555-5555-4555-8555-555555555555', localClaimGeneration: 1, reservationGeneration: 1, presentation: peerFlowPresentation(2) })
    await Promise.resolve()
    expect(events).toHaveLength(1)
    adapter.dispose()
  })

  it('invalidates same-revision replacement document authority without serializing the document per sample', async () => {
    const sockets: ScriptedSocket[] = []
    const envelopes: ServerRoomEnvelope[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test', loginOrigin: 'https://login.canvas.test', syncOrigin: 'wss://sync.canvas.test', syncClientId: 'tab-flow', syncDurableStore: memoryOnlyDurableStore,
      createWebSocket: () => {
        const socket = new ScriptedSocket()
        envelopes.push(scriptRoom(socket, structuredClone(flowDocument)))
        sockets.push(socket)
        return socket
      },
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/session') ? signedInSessionResponse() : json({ file: metadata })) as typeof fetch,
    })
    await adapter.auth?.getSession()
    await adapter.openFile?.(metadata.id)
    const collaboration = adapter.collaboration!
    const events: unknown[] = []
    collaboration.subscribeRemoteFlow?.(event => events.push(event))
    collaboration.updateFlowAuthority?.({ file: flowDocument, atoms: browserHollowAtoms, pageId: 'page_cloud', pageRootId: 'root_cloud', documentRevision: 0, layoutGeneration: 5 })
    const stringify = vi.spyOn(JSON, 'stringify')
    const sendSample = (socket: ScriptedSocket, envelope: ServerRoomEnvelope, sequence: number) => socket.server({
      type: 'interaction.sample', envelope, pageId: 'page_cloud', presenceId: 'remote-presence', subjectId: 'remote-user', clientId: 'tab-remote',
      leaseId: '55555555-5555-4555-8555-555555555555', localClaimGeneration: 1, reservationGeneration: 1, presentation: peerFlowPresentation(sequence),
    })

    sendSample(sockets[0]!, envelopes[0]!, 1)
    await Promise.resolve()
    expect(events).toHaveLength(1)
    expect(stringify.mock.calls.some(([value]) => Boolean(value && typeof value === 'object' && 'fileId' in value && 'schemaVersion' in value))).toBe(false)

    sockets[0]!.disconnect()
    await new Promise(resolve => setTimeout(resolve, 500))
    await waitFor(() => sockets.length === 2 && collaboration.getSnapshot().status === 'live')
    stringify.mockClear()
    sendSample(sockets[1]!, envelopes[1]!, 2)
    await Promise.resolve()
    expect(events).toHaveLength(1)
    expect(stringify.mock.calls.some(([value]) => Boolean(value && typeof value === 'object' && 'fileId' in value && 'schemaVersion' in value))).toBe(false)

    stringify.mockRestore()
    adapter.dispose()
  })

  it('AT-REPO-LINK-001 completes the browser handoff against the open project', async () => {
    const projectId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const linkedMetadata = { ...metadata, projectId }
    const repository = { id: '42', ownerLogin: 'canvas', name: 'editor', fullName: 'canvas/editor', isPrivate: true }
    const calls: { url: string; method: string; body: unknown }[] = []
    const replaced: string[] = []
    const navigated: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      ...scriptedSync(document),
      currentUrl: () => `https://canvas.test/file/${metadata.id}?pageId=page_cloud&github=connected&installationId=7`,
      replaceUrl: url => replaced.push(url),
      navigate: url => navigated.push(url),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith(`/api/files/${metadata.id}`)) return json({ file: linkedMetadata })
        if (url.endsWith(`/api/projects/${projectId}/repositories?installationId=7`)) return json({ installationId: '7', repositories: [repository] })
        if (url.endsWith(`/api/projects/${projectId}/repository`)) return json({ installationId: '7', repository })
        if (url.endsWith('/api/github/installations/start')) return json({ installationUrl: 'https://github.com/apps/canvas/installations/new', expiresAt: '2026-10-15T00:00:00.000Z' })
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })

    await adapter.openFile?.(metadata.id)
    expect(adapter.hostedRepository?.returnInstallationId()).toBe('7')
    expect(await adapter.hostedRepository?.listChoices('7')).toEqual([repository])
    expect(await adapter.hostedRepository?.getConnection()).toEqual({ installationId: '7', repository })
    expect(await adapter.hostedRepository?.link('7', '42')).toEqual({ installationId: '7', repository })
    adapter.hostedRepository?.clearReturnLocation()
    await adapter.hostedRepository?.startConnection()

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `https://api.canvas.test/api/projects/${projectId}/repositories?installationId=7`, method: 'GET' }),
      expect.objectContaining({ url: `https://api.canvas.test/api/projects/${projectId}/repository`, method: 'PUT', body: { installationId: '7', repositoryId: '42' } }),
      expect.objectContaining({ url: 'https://api.canvas.test/api/github/installations/start', method: 'POST', body: { returnTo: `https://canvas.test/file/${metadata.id}?pageId=page_cloud` } }),
    ]))
    expect(replaced).toEqual([`https://canvas.test/file/${metadata.id}?pageId=page_cloud`])
    expect(navigated).toEqual(['https://github.com/apps/canvas/installations/new'])
    adapter.dispose()
  })

  it('AT-REPO-LINK-001 ignores malformed GitHub return markers', () => {
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      currentUrl: () => `https://canvas.test/file/${metadata.id}?github=connected&installationId=not-an-id`,
      fetch: vi.fn() as unknown as typeof fetch,
    })

    expect(adapter.hostedRepository?.returnInstallationId()).toBeNull()
    adapter.dispose()
  })

  it('COMP-V2-CODE-002 returns the exact hosted component catalog from a completed scan', async () => {
    const projectId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const jobId = '00000000-0000-4000-8000-000000000092'
    const sourceRevision = 'a'.repeat(40)
    const sourceHash = 'b'.repeat(64)
    const componentId = 'shadcn:Button:1234567890abcdef'
    const scan = { components: [{ path: 'src/button.tsx', exportName: 'Button', sourceHash, props: [{ name: 'tone', type: "'quiet' | 'solid'", optional: false }], slots: [] }] }
    const request = { components: [{ componentId, entryPath: 'src/button.tsx', exportName: 'Button', props: { tone: { kind: 'enum', values: ['quiet', 'solid'] } }, slots: [] }] }
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      ...scriptedSync(document),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith(`/api/files/${metadata.id}`)) return json({ file: { ...metadata, projectId } })
        if (url.endsWith(`/api/projects/${projectId}/repository/scan`)) return json({ job: { id: jobId, operation: 'scan', status: 'completed', attempt: 1, result: { sourceRevision, scan, request }, completedAt: metadata.updatedAt } })
        if (url.endsWith(`/api/projects/${projectId}/repository/jobs`)) return json({ job: { id: jobId, operation: 'scan', status: 'completed', attempt: 1, result: { sourceRevision, scan, request }, completedAt: metadata.updatedAt } })
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })

    await adapter.openFile?.(metadata.id)
    const fingerprint = hostedPreviewCatalogFingerprint(request)
    await expect(adapter.hostedRepository?.getLatestScan()).resolves.toEqual({
      jobId,
      sourceRevision,
      componentCount: 1,
      registry: { fingerprint, components: [{ componentId, path: 'src/button.tsx', exportName: 'Button', sourceHash, props: scan.components[0]!.props, slots: [] }] },
    })
    await expect(adapter.hostedRepository?.scan()).resolves.toEqual({
      jobId,
      sourceRevision,
      componentCount: 1,
      registry: { fingerprint, components: [{ componentId, path: 'src/button.tsx', exportName: 'Button', sourceHash, props: scan.components[0]!.props, slots: [] }] },
    })
    adapter.dispose()
  })

  it('AT-REPO-SCAN-001 stops polling on a terminal hosted scan failure', async () => {
    const projectId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const jobId = '00000000-0000-4000-8000-000000000091'
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      ...scriptedSync(document),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith(`/api/files/${metadata.id}`)) return json({ file: { ...metadata, projectId } })
        if (url.endsWith(`/api/projects/${projectId}/repository/jobs`)) return json({ job: { id: jobId, operation: 'scan', status: 'failed', attempt: 3, errorId: 'no-supported-components', failedAt: metadata.updatedAt } })
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })

    await adapter.openFile?.(metadata.id)
    await expect(adapter.hostedRepository?.scan()).rejects.toThrow('Error ID: no-supported-components')
    adapter.dispose()
  })

  it('COMP-V2-CODE-008 keeps hosted preview capabilities ephemeral and file-scoped', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000804'
    const buildId = '00000000-0000-4000-8000-000000000808'
    const previewUrl = `https://preview.canvas.test/hosted/${artifactId}/header.payload/index.html`
    const calls: string[] = []
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      previewOrigin: 'https://preview.canvas.test',
      editorOrigin: 'https://canvas.test',
      ...scriptedSync(document),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith(`/api/files/${metadata.id}`)) return json({ file: metadata })
        if (url.endsWith(`/api/files/${metadata.id}/hosted-preview-builds`)) return json({ job: { id: buildId, fileId: metadata.id, fileRevision: document.revision, status: 'queued', attempts: 0, createdAt: metadata.updatedAt } }, 202)
        if (url.endsWith(`/api/hosted-preview-builds/${buildId}`)) return json({ job: { id: buildId, fileId: metadata.id, fileRevision: document.revision, status: 'completed', attempts: 1, createdAt: metadata.updatedAt, artifactId, completedAt: metadata.updatedAt } })
        if (url.endsWith(`/api/files/${metadata.id}/hosted-preview-capability`)) return json({ preview: { artifactId, url: previewUrl, expiresAt: 1_800_000_120 } }, 201)
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      }) as typeof fetch,
    })

    expect(adapter.capabilities?.hostedExecution.available).toBe(true)
    await expect(adapter.hostedExecution?.startBuild()).rejects.toThrow('Open a file first')
    await expect(adapter.hostedExecution?.getPreview(artifactId)).rejects.toThrow('Open a file first')
    await adapter.openFile?.(metadata.id)
    await expect(adapter.hostedExecution?.startBuild()).resolves.toMatchObject({ id: buildId, fileId: metadata.id, status: 'queued' })
    await expect(adapter.hostedExecution?.getBuild(buildId)).resolves.toMatchObject({ id: buildId, fileId: metadata.id, status: 'completed', artifactId })
    await expect(adapter.hostedExecution?.getPreview(artifactId)).resolves.toEqual({ artifactId, url: previewUrl, expiresAt: 1_800_000_120 })
    expect(calls.filter(url => url.endsWith('/hosted-preview-capability'))).toHaveLength(1)
    expect(JSON.stringify(adapter)).not.toContain('header.payload')
    adapter.dispose()
  })

  it('COMP-V2-CODE-008 rejects a capability that resolves after another file starts opening', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000805'
    const secondFileId = '00000000-0000-4000-8000-000000000806'
    const capability = deferred<Response>()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      previewOrigin: 'https://preview.canvas.test',
      editorOrigin: 'https://canvas.test',
      ...scriptedSync(document),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/hosted-preview-capability')) return capability.promise
        if (url.endsWith(`/api/files/${secondFileId}`)) return json({ file: { ...metadata, id: secondFileId } })
        return json({ file: metadata })
      }) as typeof fetch,
    })

    await adapter.openFile?.(metadata.id)
    const pending = adapter.hostedExecution!.getPreview(artifactId)
    const switching = adapter.openFile?.(secondFileId).catch(error => error)
    capability.resolve(json({ preview: { artifactId, url: `https://preview.canvas.test/hosted/${artifactId}/header.payload/index.html`, expiresAt: 1_800_000_120 } }, 201))
    await expect(pending).rejects.toThrow('superseded')
    adapter.dispose()
    await switching
  })

  it('COMP-V2-CODE-008 rejects a capability that resolves after disposal', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000807'
    const capability = deferred<Response>()
    const adapter = createCloudAdapter({
      apiOrigin: 'https://api.canvas.test',
      previewOrigin: 'https://preview.canvas.test',
      editorOrigin: 'https://canvas.test',
      ...scriptedSync(document),
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/hosted-preview-capability')
        ? capability.promise
        : json({ file: metadata })) as typeof fetch,
    })

    await adapter.openFile?.(metadata.id)
    const pending = adapter.hostedExecution!.getPreview(artifactId)
    adapter.dispose()
    capability.resolve(json({ preview: { artifactId, url: `https://preview.canvas.test/hosted/${artifactId}/header.payload/index.html`, expiresAt: 1_800_000_120 } }, 201))
    await expect(pending).rejects.toThrow('superseded')
  })
})
