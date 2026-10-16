import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyHostedFileCommand, createBlankFile } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine'
import type { PreviewSnapshot } from '@canvas/preview-runtime'
import { shadcnPreviewComponentId } from '@canvas/scanner/preview-registry'
import { DesktopCloudFiles } from '../src/main/cloud-files'
import type { CollaborationDurableStore, CollaborationSocketEventMap, CollaborationWebSocket } from '@canvas/sync-client'
import { collaborationDocumentSchemaVersion, collaborationEnvelopeSchemaVersion, collaborationProtocolEpoch } from '@canvas/sync-protocol'
import type { CollaborationClientMessage, CollaborationServerMessage, ServerRoomEnvelope } from '@canvas/sync-protocol'

const id = '11111111-2222-4333-8444-555555555555'
const metadata = { id, projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }
const document = createBlankFile(id, 'page_cloud', 'root_cloud', 'Page 1')
const malformedHostedDocument = () => ({
  ...document,
  pages: [{ ...document.pages[0]!, rootNodeId: 'missing-root' }],
}) as typeof document
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

class ScriptedSocket implements CollaborationWebSocket {
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<keyof CollaborationSocketEventMap, Set<(event: never) => void>>()
  onSend: (message: Record<string, unknown>) => void = () => undefined
  constructor() { queueMicrotask(() => { this.readyState = 1; this.emit('open', new Event('open')) }) }
  addEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void) { const current = this.listeners.get(type) ?? new Set(); current.add(listener as (event: never) => void); this.listeners.set(type, current) }
  removeEventListener<K extends keyof CollaborationSocketEventMap>(type: K, listener: (event: CollaborationSocketEventMap[K]) => void) { this.listeners.get(type)?.delete(listener as (event: never) => void) }
  send(data: string) { const message = JSON.parse(data) as Record<string, unknown>; this.sent.push(message); this.onSend(message) }
  close() { this.readyState = 3 }
  disconnect() {
    this.readyState = 3
    this.emit('close', Object.assign(new Event('close'), { code: 1006, reason: 'network lost', wasClean: false }) as CloseEvent)
  }
  server(value: CollaborationServerMessage) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) })) }
  private emit<K extends keyof CollaborationSocketEventMap>(type: K, event: CollaborationSocketEventMap[K]) { for (const listener of this.listeners.get(type) ?? []) listener(event as never) }
}

const durableStore: CollaborationDurableStore = Object.freeze({
  load: async () => null, repair: async () => undefined, enqueue: async () => undefined, checkpoint: async () => undefined,
  acknowledge: async () => undefined, markRecoverable: async () => undefined, markAllRecoverable: async () => undefined, reconcileReplayScope: async () => undefined, clearCheckpoint: async () => undefined, purgeAccount: async () => undefined,
})

function scriptedRoom(socket: ScriptedSocket, initial: typeof document) {
  const envelope: ServerRoomEnvelope = { protocolEpoch: collaborationProtocolEpoch, schemaVersion: collaborationEnvelopeSchemaVersion, room: { fileId: initial.fileId, generationId: '22222222-2222-4222-8222-222222222222' }, fenceToken: '9' }
  let requestId = ''
  let sequence = initial.revision
  socket.onSend = raw => {
    const message = raw as CollaborationClientMessage
    if (message.type === 'room.open') {
      requestId = message.requestId
      socket.server({ type: 'room.assigned', envelope, requestId, role: 'owner', replayScopeId: 'a'.repeat(64) })
      const bytes = new TextEncoder().encode(JSON.stringify(initial))
      const digest = createHash('sha256').update(bytes).digest('hex')
      socket.server({ type: 'load.phase', envelope, requestId, phase: 'stream' })
      socket.server({ type: 'snapshot.begin', envelope, requestId, snapshotId: 'projection:0', documentSchemaVersion: collaborationDocumentSchemaVersion, baseSequence: String(initial.revision), compression: 'none', contentEncoding: 'utf-8', storedByteLength: bytes.byteLength, documentByteLength: bytes.byteLength, objectDigest: digest, documentDigest: digest, chunkCount: 1 })
      socket.server({ type: 'snapshot.chunk', envelope, requestId, snapshotId: 'projection:0', chunkIndex: 0, chunkCount: 1, data: Buffer.from(bytes).toString('base64') })
      socket.server({ type: 'snapshot.end', envelope, requestId, snapshotId: 'projection:0' })
      socket.server({ type: 'load.phase', envelope, requestId, phase: 'apply' })
      socket.server({ type: 'sync.ready', envelope, requestId, snapshotId: 'projection:0', serverSequence: String(initial.revision), role: 'owner' })
    } else if (message.type === 'operation.submit') {
      sequence += 1
      socket.server({ type: 'operation.ack', envelope, mutationId: message.operation.mutationId, sequence: String(sequence), status: 'applied' })
    }
  }
}

function service(request: (path: string, init?: RequestInit) => Promise<Response>, initial: typeof document = document, editorOrigin = 'https://app.canvas.test', previewOrigin: string | undefined = 'https://preview.canvas.test', assetsOrigin?: string, workspace?: ConstructorParameters<typeof DesktopCloudFiles>[5]) {
  const sockets: ScriptedSocket[] = []
  const auth = { request, createWebSocket: () => {
    const socket = new ScriptedSocket()
    scriptedRoom(socket, initial)
    sockets.push(socket)
    return socket as never
  } }
  const instance = new DesktopCloudFiles(auth, 'https://api.canvas.test', editorOrigin, previewOrigin, assetsOrigin, workspace, { syncOrigin: 'wss://sync.canvas.test', buildId: '0.1.0', clientId: 'desktop-test', requestOrigin: 'https://app.canvas.test', accountId: () => 'user-test', durableStore })
  return { instance, sockets }
}

describe('desktop cloud files', () => {
  it('carries only the registered bundled editor origin into the cloud preview URL', async () => {
    const { instance } = service(async () => json({ file: metadata }), document, 'design-editor://app')
    const opened = await instance.open(id)
    expect(new URL(opened.preview.url!).searchParams.get('editorOrigin')).toBe('design-editor://app')
    expect(instance.activePreviewUrl()).toBe(opened.preview.url)
    expect(() => service(async () => json({}), document, 'other-editor://app')).toThrow('Editor origin must be an HTTP or HTTPS origin.')
  })

  it('CLOUD-FILES-001 rejects the canonical malformed hosted document at the desktop boundary', async () => {
    const { instance } = service(async () => json({ file: metadata }), malformedHostedDocument())

    const opening = instance.open(id)
    await expect(opening).rejects.toThrow('This file contains invalid data. Error ID: invalid-file-document')
    expect(instance.collaborationSnapshot()).toMatchObject({ status: 'unavailable', error: null })
    instance.dispose()
  })

  it('[CLOUD-SYNC-CLIENT-001] uses the main-process authenticated room for consecutive cloud saves', async () => {
    const paths: string[] = []
    const request = async (path: string, init?: RequestInit) => {
      paths.push(`${init?.method ?? 'GET'} ${new URL(path).pathname}`)
      if (path.endsWith('/api/files') && init?.method === 'POST') return json({ file: metadata }, 201)
      if (path.endsWith('/api/files')) return json({ files: [metadata] })
      return json({ file: metadata })
    }
    const { instance, sockets } = service(request)
    expect(await instance.list()).toHaveLength(1)
    expect((await instance.create()).id).toBe(id)
    expect((await instance.open(id)).file).toEqual(document)
    const command = { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Renamed' } as const
    const projected = applyHostedFileCommand(document, command)
    const first = await instance.save(projected, 0, { kind: 'commands', commands: [command] })
    expect(first.file.revision).toBe(1)
    const secondCommand = { type: 'page.rename', pageId: document.pages[0]!.id, name: 'Renamed again' } as const
    const secondProjected = applyHostedFileCommand(first.file, secondCommand)
    const second = await instance.save(secondProjected, first.file.revision, { kind: 'commands', commands: [secondCommand] })
    expect(second.file.revision).toBe(2)
    expect(paths.some(path => path.startsWith('PUT '))).toBe(false)
    expect(sockets[0]?.sent.filter(message => message.type === 'operation.submit')).toHaveLength(2)
    expect(instance.collaborationSnapshot().canMutate).toBe(true)
    sockets[0]!.disconnect()
    expect(instance.collaborationSnapshot()).toMatchObject({ status: 'reconnecting', canMutate: true, canManageShare: true })
  })

  it('uses the stable private thumbnail resolver for cloud file summaries', async () => {
    const thumbnailMetadata = { ...metadata, thumbnailKey: `thumbnails/${id}/versions/0/nonce.avif` }
    const { instance } = service(async () => json({ files: [thumbnailMetadata] }), document, 'https://app.canvas.test', 'https://preview.canvas.test', 'https://assets.canvas.test')

    expect((await instance.list())[0]?.thumbnailUrl).toBe(`https://assets.canvas.test/file-assets/thumbnails/${id}/thumbnail.avif`)
  })

  it('validates and projects cloud documents against the active verified repository catalog', async () => {
    const componentId = shadcnPreviewComponentId({ path: 'src/components/ui/login-form.tsx', exportName: 'LoginForm' })
    const loginForm: Atom = {
      componentId,
      name: 'LoginForm',
      exportName: 'LoginForm',
      path: 'src/components/ui/login-form.tsx',
      fingerprint: 'verified-fingerprint',
      sourceHash: 'source-hash',
      status: 'bound',
      candidates: [],
      kind: 'atom',
      props: [],
      slots: [],
    }
    const connectedDocument = structuredClone(document)
    connectedDocument.nodes.login = { id: 'login', type: 'component', componentId, exportName: 'LoginForm', props: {} }
    connectedDocument.relationships.login = { parentId: 'root_cloud', orderKey: 'V' }
    const projected: string[] = []
    const preview: PreviewSnapshot = {
      status: 'ready', currentGeneration: 3, activeGeneration: 3, origin: 'http://127.0.0.1:49152',
      url: 'http://127.0.0.1:49152/connected/3/build/3/index.html', stale: false, diagnostics: [],
    }
    const { instance } = service(async () => json({ file: metadata }), connectedDocument, 'design-editor://app', undefined, undefined, { atoms: () => [loginForm], project: async file => { projected.push(file.fileId); return preview } })

    const opened = await instance.open(id)
    expect(opened.atoms).toEqual([loginForm])
    expect(opened.preview).toEqual(preview)
    expect(opened.phases).toEqual([{ name: 'Verified repository catalog loaded', completed: 1 }])
    expect(projected).toEqual([id])
  })
})
