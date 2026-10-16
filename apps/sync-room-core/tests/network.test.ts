import { once } from 'node:events'
import { applyHostedFileCommand, legacyTextProperties, validateFileDocument, type FileDocument } from '@canvas/repo-engine/file-document'
import { createCollaborationClient, createCollaborationDurableStore, type CollaborationWebSocket } from '@canvas/sync-client'
import { parseCollaborationServerMessage } from '@canvas/sync-protocol'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoomNetworkServer } from '../src/network.js'
import { createSemanticProjector } from '../src/projector.js'
import { CollaborationRoomCore } from '../src/room-core.js'
import { checkpoints, clientId, connectionNonce, document, FakePersistence, fileId, flowDocument, flowPresentation, generationId, projection, projector, ticket, tickets } from './support.js'

const origin = 'http://127.0.0.1:4317'

async function waitForWire(messages: readonly string[], predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const expiresAt = Date.now() + 1_000
  while (Date.now() < expiresAt) {
    const match = messages.map(message => JSON.parse(message) as Record<string, unknown>).find(predicate)
    if (match) return match
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Expected WebSocket message was not received')
}

async function openObservedSocket(port: number, nonce: string, socketClientId: string, requestId: string): Promise<Readonly<{ socket: WebSocket; messages: string[] }>> {
  const url = `ws://127.0.0.1:${port}/sync/${fileId}/${generationId}?clientId=${socketClientId}&connectionNonce=${nonce}`
  const socket = new WebSocket(url, { origin, headers: { Authorization: `Bearer ${ticket}` } })
  const messages: string[] = []
  socket.on('message', data => messages.push(data.toString()))
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId, fileId, clientId: socketClientId, buildId: 'test-build' }))
  await waitForWire(messages, value => value.type === 'presence.roster')
  return Object.freeze({ socket, messages })
}

function memoryCollaborationStore() {
  const values = new Map<string, unknown>()
  return createCollaborationDurableStore({
    async read(key) { return values.get(key) ?? null },
    async update(key, updater) {
      const next = updater(values.get(key) ?? null)
      if (next === null) values.delete(key)
      else values.set(key, next)
    },
    async reserve() {},
    async purgeAccount(accountId) {
      for (const [key, value] of values) {
        if (typeof value === 'object' && value !== null && Reflect.get(Reflect.get(value, 'scope') ?? {}, 'accountId') === accountId) values.delete(key)
      }
    },
  })
}

async function waitForClientDocument(
  client: ReturnType<typeof createCollaborationClient<FileDocument>>,
  predicate: (document: FileDocument) => boolean,
): Promise<FileDocument> {
  const expiresAt = Date.now() + 1_000
  while (Date.now() < expiresAt) {
    const current = client.getSnapshot().document
    if (current && predicate(current)) return current
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Expected collaboration client document was not received')
}

function componentSeedDocument(): FileDocument {
  return validateFileDocument(document({
    nodes: {
      'root-1': { id: 'root-1', type: 'root' },
      'button-master': { id: 'button-master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 160, height: 48 } },
      'button-face': { id: 'button-face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 160, height: 48 } },
      'button-label': { id: 'button-label', type: 'text', name: 'Label', styles: { relativeTransform: [1, 0, 0, 1, 16, 14], width: 96, height: 20 }, text: 'Continue', ...legacyTextProperties() },
      'button-slot': { id: 'button-slot', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 128, 12], width: 24, height: 24 } },
      'icon-master': { id: 'icon-master', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 220, 0], width: 24, height: 24 } },
      'icon-shape': { id: 'icon-shape', type: 'rectangle', name: 'Shape', styles: { relativeTransform: [1, 0, 0, 1, 4, 4], width: 16, height: 16 } },
    },
    relationships: {
      'button-master': { parentId: 'root-1', orderKey: 'V' },
      'button-face': { parentId: 'button-master', orderKey: 'V' },
      'button-label': { parentId: 'button-master', orderKey: 'W' },
      'button-slot': { parentId: 'button-master', orderKey: 'X' },
      'icon-master': { parentId: 'root-1', orderKey: 'W' },
      'icon-shape': { parentId: 'icon-master', orderKey: 'V' },
    },
  }), [])
}

const buttonDraft = {
  id: 'component:button', name: 'Button', source: { kind: 'canvas' as const, masterRootId: 'button-master' }, revision: 0,
  properties: [], materials: [], parts: [], interactions: [],
}

const buttonDefinition = {
  ...buttonDraft,
  revision: 1,
  properties: [
    {
      id: 'property:state', name: 'State', type: 'variant' as const, defaultValueId: 'value:default',
      values: [{ id: 'value:default', name: 'Default' }, { id: 'value:hover', name: 'Hover' }, { id: 'value:pressed', name: 'Pressed' }],
      binding: { kind: 'variant' as const, nodeId: 'button-face', appearances: {
        'value:default': {}, 'value:hover': { opacity: 0.8 }, 'value:pressed': { opacity: 0.6 },
      } },
    },
    { id: 'property:label', name: 'Label', type: 'text' as const, defaultValue: 'Continue', binding: { kind: 'text' as const, nodeId: 'button-label' } },
    { id: 'property:visible', name: 'Visible', type: 'boolean' as const, defaultValue: true, binding: { kind: 'visibility' as const, nodeId: 'button-face' } },
    { id: 'property:content', name: 'Content', type: 'slot' as const, binding: { kind: 'slot' as const, nodeId: 'button-slot' } },
  ],
  materials: [{ id: 'material:surface', group: 'Interaction', name: 'Surface', description: 'Button surface states.', appearance: { opacity: 0.95 } }],
  parts: [{ id: 'part:face', name: 'Face', nodeId: 'button-face', materialId: 'material:surface' }, { id: 'part:label', name: 'Label', nodeId: 'button-label' }],
  interactions: [
    { id: 'interaction:hover', trigger: 'pointer-hover' as const, propertyId: 'property:state', valueId: 'value:hover' },
    { id: 'interaction:pressed', trigger: 'pointer-press' as const, propertyId: 'property:state', valueId: 'value:pressed' },
  ],
  docs: { slug: 'button', description: 'Triggers an action.' },
}

const iconDefinition = {
  id: 'component:icon', name: 'Icon', source: { kind: 'canvas' as const, masterRootId: 'icon-master' }, revision: 0,
  properties: [], materials: [], parts: [{ id: 'part:shape', name: 'Shape', nodeId: 'icon-shape' }], interactions: [],
}

describe('room network boundary', () => {
  let cleanup: (() => Promise<unknown>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('CLOUD-SYNC-DO-SEC-001 and CLOUD-SYNC-AUTH-001 bind authority at the real WebSocket boundary', async () => {
    let verificationCount = 0
    const verifier = tickets()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: {
        async verify(context) { verificationCount += 1; return verifier.verify(context) },
        async consume(authorization, input) { return verifier.consume(authorization, input) },
        async isCurrent(value, nowUnixMs) { return verifier.isCurrent(value, nowUnixMs) },
      },
      projector,
      checkpoints,
    })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await network.listen(0)
    cleanup = () => network.close()
    const base = `http://${address.hostname}:${address.port}`
    await expect(fetch(`${base}/readyz`).then(response => response.json())).resolves.toEqual({ ready: true, phase: 'accepting' })

    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1:4317', headers: { Authorization: `Bearer ${ticket}` } })
    const messages: string[] = []
    socket.on('message', data => messages.push(data.toString()))
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId: 'network-request', fileId, clientId, buildId: 'test-build' }))
    while (messages.length < 8) await once(socket, 'message')
    expect(messages.map(message => parseCollaborationServerMessage(message).type)).toEqual(['room.assigned', 'load.phase', 'snapshot.begin', 'snapshot.chunk', 'snapshot.end', 'load.phase', 'sync.ready', 'presence.roster'])
    expect(messages.slice(0, 7).map(message => parseCollaborationServerMessage(message)).every(message => 'requestId' in message && message.requestId === 'network-request')).toBe(true)
    expect(verificationCount).toBe(1)
    expect(messages.join('')).not.toContain(ticket)
    expect(messages.join('')).not.toMatch(/roomTicket|authorization|cookie|accessEpoch/i)

    const closed = once(socket, 'close')
    socket.send(JSON.stringify({
      type: 'operation.submit',
      clientId: 'forged-client',
      generationId: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
      operation: { mutationId: 'mutation-forged', baseSequence: '0', command: { type: 'node.rename', nodeId: 'node-1', name: 'Forged' } },
    }))
    const [code, reason] = await closed
    expect(code).toBe(1007)
    expect(reason.toString()).toBe('Invalid collaboration message')
    expect(verificationCount).toBe(1)
  })

  it('PAPER-CLIP-008 broadcasts one atomic clipboard batch and converges the persisted projection over real WebSockets', async () => {
    const persistence = new FakePersistence()
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: createSemanticProjector(), checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: [origin], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await network.listen(0)
    let observerClient: ReturnType<typeof createCollaborationClient<FileDocument>> | null = null
    cleanup = async () => {
      observerClient?.dispose()
      await network.close()
    }
    const owner = await openObservedSocket(address.port, connectionNonce, clientId, 'clipboard-owner')
    const observerClientId = 'clipboard-observer'
    const observerNonce = 'C'.repeat(24)
    const observerAppliedCommands: unknown[] = []
    let observerRequest = 0
    observerClient = createCollaborationClient<FileDocument>({
      syncOrigin: `ws://${address.hostname}:${address.port}`,
      buildId: 'test-build',
      clientId: observerClientId,
      durableStore: memoryCollaborationStore(),
      validateDocument: value => validateFileDocument(value, []),
      applyCommand(value, nextCommand) {
        observerAppliedCommands.push(nextCommand)
        return applyHostedFileCommand(value, nextCommand)
      },
      createId: () => `clipboard-observer-request-${++observerRequest}`,
      lifecycleTarget: null,
      reconnectDelaysMs: [0],
      createWebSocket(_url, protocol) {
        const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${observerClientId}&connectionNonce=${observerNonce}`
        return new WebSocket(url, protocol, { origin, headers: { Authorization: `Bearer ${ticket}` } }) as unknown as CollaborationWebSocket
      },
    })
    await observerClient.start({ fileId, cache: { accountId: 'clipboard-account', documentSchemaVersion: 13 } })
    await waitForClientDocument(observerClient, value => value.revision === document().revision)
    owner.messages.length = 0
    const command = {
      type: 'batch', commands: [
        { type: 'token.create', token: { id: 'clipboard-color', type: 'color', name: 'Clipboard color', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#123456' } } } },
        { type: 'asset.attach', asset: { id: 'clipboard-asset', name: 'Clipboard image', mime: 'image/png', extension: 'png', bytes: 4, width: 1, height: 1, sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' } },
        { type: 'node.insert', node: { id: 'clipboard-node', type: 'rectangle', name: 'Clipboard image', styles: { relativeTransform: [1, 0, 0, 1, 120, 80], width: 80, height: 60 }, appearance: { fills: [
          { id: 'clipboard-image-fill', type: 'image', assetId: 'clipboard-asset', fit: 'cover' },
          { id: 'clipboard-color-fill', type: 'solid', color: { kind: 'token', tokenId: 'clipboard-color' } },
        ] } }, placement: { parentId: 'root-1' } },
      ],
    }
    owner.socket.send(JSON.stringify({ type: 'operation.submit', operation: { mutationId: 'clipboard-paste-0001', baseSequence: '0', command } }))
    await expect(waitForWire(owner.messages, value => value.type === 'operation.ack')).resolves.toMatchObject({ mutationId: 'clipboard-paste-0001', sequence: '1', status: 'applied' })
    const observerDocument = await waitForClientDocument(observerClient, value => value.revision === 1 && Boolean(value.nodes['clipboard-node']))
    expect(observerAppliedCommands).toEqual([command])
    expect(observerClient.getSnapshot()).toMatchObject({ lifecycle: 'live', serverSequence: '1', lastOperation: { mutationId: 'clipboard-paste-0001', command } })
    expect(observerDocument).toMatchObject({
      revision: 1,
      theme: { tokens: { 'clipboard-color': { value: { color: { hex: '#123456' } } } } },
      assets: { 'clipboard-asset': { sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' } },
      nodes: { 'clipboard-node': { appearance: { fills: [{ assetId: 'clipboard-asset' }, { color: { tokenId: 'clipboard-color' } }] } } },
      relationships: { 'clipboard-node': { parentId: 'root-1' } },
    })
    expect(persistence.current.sequence).toBe(1n)
    expect(persistence.current.document).toMatchObject({
      revision: 1,
      theme: { tokens: { 'clipboard-color': { value: { color: { hex: '#123456' } } } } },
      assets: { 'clipboard-asset': { sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' } },
      nodes: { 'clipboard-node': { appearance: { fills: [{ assetId: 'clipboard-asset' }, { color: { tokenId: 'clipboard-color' } }] } } },
      relationships: { 'clipboard-node': { parentId: 'root-1' } },
    })
  })

  it('CLOUD-SYNC-COMPONENT-001 converges and rejects stale canvas component edits across real WebSocket clients', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(componentSeedDocument())
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: createSemanticProjector(), checkpoints })
    await room.start()
    let activeNetwork = createRoomNetworkServer({ room, allowedOrigins: [origin], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await activeNetwork.listen(0)
    let authorClient: ReturnType<typeof createCollaborationClient<FileDocument>> | null = null
    let observerClient: ReturnType<typeof createCollaborationClient<FileDocument>> | null = null
    let replayAuthor: Readonly<{ socket: WebSocket; messages: string[] }> | null = null
    cleanup = async () => {
      authorClient?.dispose()
      observerClient?.dispose()
      replayAuthor?.socket.close()
      await activeNetwork.close()
    }

    const owner = await openObservedSocket(address.port, connectionNonce, clientId, 'component-owner')
    const authorClientId = 'component-author'
    const authorNonce = 'F'.repeat(24)
    const observerClientId = 'component-observer'
    const observerNonce = 'D'.repeat(24)
    let clientRequest = 0
    const componentClient = (socketClientId: string, nonce: string, requestPrefix: string) => createCollaborationClient<FileDocument>({
      syncOrigin: `ws://${address.hostname}:${address.port}`,
      buildId: 'test-build',
      clientId: socketClientId,
      durableStore: memoryCollaborationStore(),
      validateDocument: value => validateFileDocument(value, []),
      applyCommand: (value, command) => applyHostedFileCommand(value, command),
      createId: () => `${requestPrefix}-${++clientRequest}`,
      lifecycleTarget: null,
      reconnectDelaysMs: [0],
      createWebSocket(_url, protocol) {
        const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${socketClientId}&connectionNonce=${nonce}`
        return new WebSocket(url, protocol, { origin, headers: { Authorization: `Bearer ${ticket}` } }) as unknown as CollaborationWebSocket
      },
    })
    authorClient = componentClient(authorClientId, authorNonce, 'component-author-request')
    observerClient = componentClient(observerClientId, observerNonce, 'component-observer-request')
    await Promise.all([
      authorClient.start({ fileId, cache: { accountId: 'component-account', documentSchemaVersion: 13 } }),
      observerClient.start({ fileId, cache: { accountId: 'component-account', documentSchemaVersion: 13 } }),
    ])
    await Promise.all([
      waitForClientDocument(authorClient, value => value.revision === 0),
      waitForClientDocument(observerClient, value => value.revision === 0),
    ])

    await expect(authorClient.submit({ mutationId: 'component-create-0001', command: { type: 'component.create', definition: buttonDraft } })).resolves.toMatchObject({ sequence: '1' })
    await expect(authorClient.submit({ mutationId: 'component-author-0002', command: { type: 'component.replace', componentId: buttonDraft.id, expectedRevision: 0, definition: buttonDefinition } })).resolves.toMatchObject({ sequence: '2' })
    await expect(authorClient.submit({ mutationId: 'component-icon-0003', command: { type: 'component.create', definition: iconDefinition } })).resolves.toMatchObject({ sequence: '3' })

    const buttonInstance = { id: 'button-instance', componentId: buttonDefinition.id, values: { 'property:label': 'Review' } }
    const iconInstance = { id: 'icon-instance', componentId: iconDefinition.id, values: {} }
    const placement: Parameters<typeof applyHostedFileCommand>[1] = {
      type: 'batch', commands: [
        { type: 'node.insert', node: { id: 'button-instance', type: 'frame', name: 'Button instance', styles: { relativeTransform: [1, 0, 0, 1, 0, 120], width: 160, height: 48 } }, placement: { parentId: 'root-1' } },
        { type: 'node.insert', node: { id: 'button-instance-face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 160, height: 48 } }, placement: { parentId: 'button-instance' } },
        { type: 'node.insert', node: { id: 'button-instance-label', type: 'text', name: 'Label', styles: { relativeTransform: [1, 0, 0, 1, 16, 14], width: 96, height: 20 }, text: 'Review', ...legacyTextProperties() }, placement: { parentId: 'button-instance' } },
        { type: 'node.insert', node: { id: 'button-instance-slot', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 128, 12], width: 24, height: 24 } }, placement: { parentId: 'button-instance' } },
        { type: 'node.insert', node: { id: 'icon-instance', type: 'frame', name: 'Icon instance', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 24, height: 24 } }, placement: { parentId: 'button-instance-slot' } },
        { type: 'node.insert', node: { id: 'icon-instance-shape', type: 'rectangle', name: 'Shape', styles: { relativeTransform: [1, 0, 0, 1, 4, 4], width: 16, height: 16 } }, placement: { parentId: 'icon-instance' } },
        { type: 'component.instance.create', instance: buttonInstance },
        { type: 'component.instance.create', instance: iconInstance },
      ],
    }
    await expect(authorClient.submit({ mutationId: 'component-place-0004', command: placement })).resolves.toMatchObject({ sequence: '4' })
    const [authorPlaced, observerPlaced] = await Promise.all([
      waitForClientDocument(authorClient, value => value.revision === 4),
      waitForClientDocument(observerClient, value => value.revision === 4),
    ])
    expect(observerPlaced).toEqual(authorPlaced)
    expect(observerPlaced.componentModel).toMatchObject({
      definitions: {
        [buttonDefinition.id]: buttonDefinition,
        [iconDefinition.id]: iconDefinition,
      },
      instances: {
        [buttonInstance.id]: buttonInstance,
        [iconInstance.id]: iconInstance,
      },
    })
    expect(observerPlaced.relationships).toMatchObject({
      'icon-instance': { parentId: 'button-instance-slot' },
      'icon-instance-shape': { parentId: 'icon-instance' },
    })
    expect(observerPlaced.nodes).toMatchObject({
      'icon-instance': { id: 'icon-instance', type: 'frame' },
      'icon-instance-shape': { id: 'icon-instance-shape', type: 'rectangle' },
    })

    const changedInstance = { ...buttonInstance, values: { 'property:label': 'Review', 'property:state': 'value:hover', 'property:visible': false } }
    const observerReceipt = observerClient.submit({
      mutationId: 'component-instance-0005',
      command: { type: 'component.instance.replace', instanceId: buttonInstance.id, expected: buttonInstance, instance: changedInstance },
    })
    await expect(observerReceipt).resolves.toMatchObject({ mutationId: 'component-instance-0005', sequence: '5' })
    await expect(waitForWire(owner.messages, value => value.type === 'operation.applied' && value.mutationId === 'component-instance-0005')).resolves.toMatchObject({ sequence: '5' })
    const [authorChanged, observerChanged] = await Promise.all([
      waitForClientDocument(authorClient, value => value.revision === 5),
      waitForClientDocument(observerClient, value => value.revision === 5),
    ])
    expect(authorChanged).toEqual(observerChanged)

    authorClient.dispose()
    authorClient = null
    replayAuthor = await openObservedSocket(address.port, authorNonce, authorClientId, 'component-author-replay')
    replayAuthor.socket.send(JSON.stringify({
      type: 'operation.submit',
      operation: { mutationId: 'component-create-0001', baseSequence: '0', command: { type: 'component.create', definition: buttonDraft } },
    }))
    await expect(waitForWire(replayAuthor.messages, value => value.type === 'operation.ack' && value.mutationId === 'component-create-0001' && value.status === 'duplicate')).resolves.toMatchObject({ sequence: '1' })

    replayAuthor.socket.send(JSON.stringify({
      type: 'operation.submit',
      operation: {
        mutationId: 'component-create-0001', baseSequence: '5',
        command: { type: 'component.replace', componentId: buttonDefinition.id, expectedRevision: 1, definition: { ...buttonDefinition, revision: 2, name: 'Reused mutation' } },
      },
    }))
    await expect(waitForWire(replayAuthor.messages, value => value.type === 'room.error' && value.mutationId === 'component-create-0001')).resolves.toMatchObject({ code: 'mutation_id_reused', retry: 'none' })

    replayAuthor.socket.send(JSON.stringify({
      type: 'operation.submit',
      operation: {
        mutationId: 'component-stale-0006', baseSequence: '5',
        command: { type: 'component.replace', componentId: buttonDraft.id, expectedRevision: 0, definition: { ...buttonDefinition, name: 'Stale button' } },
      },
    }))
    await expect(waitForWire(replayAuthor.messages, value => value.type === 'room.error' && value.mutationId === 'component-stale-0006')).resolves.toMatchObject({ code: 'invalid_operation', retry: 'none' })

    replayAuthor.socket.send(JSON.stringify({
      type: 'operation.submit',
      operation: {
        mutationId: 'component-stale-undo-0007', baseSequence: '5',
        command: { type: 'component.instance.restore', instanceId: buttonInstance.id, expected: buttonInstance, source: null },
      },
    }))
    await expect(waitForWire(replayAuthor.messages, value => value.type === 'room.error' && value.mutationId === 'component-stale-undo-0007')).resolves.toMatchObject({ code: 'invalid_operation', retry: 'none' })

    expect(persistence.current.sequence).toBe(5n)
    expect(persistence.current.document.componentModel).toMatchObject({
      definitions: { [buttonDefinition.id]: buttonDefinition, [iconDefinition.id]: iconDefinition },
      instances: { [buttonInstance.id]: changedInstance, [iconInstance.id]: iconInstance },
    })
    const persistedDocument = validateFileDocument(persistence.current.document, [])
    expect(persistedDocument.nodes['button-master']).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 0, 0] } })
    expect(persistedDocument.nodes['button-instance']).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 0, 120] } })

    observerClient.dispose()
    observerClient = null
    replayAuthor.socket.close()
    replayAuthor = null
    owner.socket.close()
    await activeNetwork.close()
    await room.drain()

    const restartedRoom = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: createSemanticProjector(), checkpoints })
    await restartedRoom.start()
    activeNetwork = createRoomNetworkServer({ room: restartedRoom, allowedOrigins: [origin], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const restartedAddress = await activeNetwork.listen(0)
    const reconnectClientId = 'component-reconnect'
    const reconnectNonce = 'E'.repeat(24)
    observerClient = createCollaborationClient<FileDocument>({
      syncOrigin: `ws://${restartedAddress.hostname}:${restartedAddress.port}`,
      buildId: 'test-build',
      clientId: reconnectClientId,
      durableStore: memoryCollaborationStore(),
      validateDocument: value => validateFileDocument(value, []),
      applyCommand: (value, command) => applyHostedFileCommand(value, command),
      createId: () => `component-reconnect-request-${++clientRequest}`,
      lifecycleTarget: null,
      reconnectDelaysMs: [0],
      createWebSocket(_url, protocol) {
        const url = `ws://${restartedAddress.hostname}:${restartedAddress.port}/sync/${fileId}/${generationId}?clientId=${reconnectClientId}&connectionNonce=${reconnectNonce}`
        return new WebSocket(url, protocol, { origin, headers: { Authorization: `Bearer ${ticket}` } }) as unknown as CollaborationWebSocket
      },
    })
    await observerClient.start({ fileId, cache: { accountId: 'component-account', documentSchemaVersion: 13 } })
    const restarted = await waitForClientDocument(observerClient, value => value.revision === 5)
    expect(restarted).toEqual(validateFileDocument(persistence.current.document, []))
    expect(restarted.relationships).toMatchObject({
      'icon-instance': { parentId: 'button-instance-slot' },
      'icon-instance-shape': { parentId: 'icon-instance' },
    })
  })

  it('CLOUD-SYNC-DO-SEC-001 rejects non-exact query authority before ticket verification', async () => {
    let verificationCount = 0
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, {
      persistence: new FakePersistence(),
      tickets: {
        async verify() { verificationCount += 1; return null },
        async consume() { return null },
        async isCurrent() { return false },
      },
      projector,
      checkpoints,
    })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: [origin], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await network.listen(0)
    cleanup = () => network.close()
    const base = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}`
    const validQuery = `clientId=${clientId}&connectionNonce=${connectionNonce}`
    const invalid = [
      `${base}?${validQuery}&role=owner`,
      `${base}?${validQuery}&clientId=client-2`,
      `${base}?${validQuery}&connectionNonce=${'x'.repeat(24)}`,
      `${base}?connectionNonce=${connectionNonce}`,
      `${base}?clientId=${clientId}`,
      `${base}?clientId=%20client-1&connectionNonce=${connectionNonce}`,
      `${base}?clientId=${clientId}&connectionNonce=short`,
    ]
    for (const candidate of invalid) {
      const socket = new WebSocket(candidate, { origin, headers: { Authorization: `Bearer ${ticket}` } })
      const [error] = await once(socket, 'error')
      expect(String(error), candidate).toContain('404')
    }
    expect(verificationCount).toBe(0)
    expect(room.activeConnections).toBe(0)
  })

  it('CLOUD-SYNC-GESTURE-001-C2-LIVE and CLOUD-SYNC-SCHEMA-001-C2-LIVE carry flow leases through the room network WebSocket', async () => {
    const persistence = new FakePersistence()
    persistence.current = projection(flowDocument())
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence, tickets: tickets(), projector: createSemanticProjector(), checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: [origin], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    const address = await network.listen(0)
    cleanup = () => network.close()

    const owner = await openObservedSocket(address.port, connectionNonce, clientId, 'live-owner')
    const observer = await openObservedSocket(address.port, 'O'.repeat(24), 'live-observer-client', 'live-observer')
    owner.messages.length = 0
    observer.messages.length = 0

    const acquired = flowPresentation()
    owner.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: acquired }))
    const grant = await waitForWire(owner.messages, value => value.type === 'interaction.result')
    expect(grant).toMatchObject({ action: 'acquire', status: 'granted', interactionId: 'flow-interaction', denialCode: null })
    const leaseId = String(grant.leaseId)
    const firstPeerSample = await waitForWire(observer.messages, value => value.type === 'interaction.sample')
    expect(firstPeerSample).toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 1 } } })

    owner.messages.length = 0
    observer.messages.length = 0
    const reservationPresentation = flowPresentation({ sequence: 2, targetParentId: 'disjoint-frame' })
    owner.socket.send(JSON.stringify({
      type: 'interaction.reserve', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2,
      targetLane: { parentId: 'disjoint-frame', slot: { presence: 'absent' } }, presentation: reservationPresentation,
    }))
    await expect(waitForWire(owner.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ action: 'reserve', status: 'retained', leaseId, reservationGeneration: 2 })
    await expect(waitForWire(observer.messages, value => value.type === 'interaction.sample')).resolves.toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 2 } } })

    owner.messages.length = 0
    observer.messages.length = 0
    owner.socket.send(JSON.stringify({
      type: 'interaction.sample', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2,
      presentation: flowPresentation({ sequence: 3, targetParentId: 'disjoint-frame' }),
    }))
    await expect(waitForWire(observer.messages, value => value.type === 'interaction.sample')).resolves.toMatchObject({ leaseId, presentation: { identity: { interactionId: `lease:${leaseId}`, sampleSequence: 3 } } })
    expect(owner.messages).toEqual([])

    owner.socket.send(JSON.stringify({
      type: 'interaction.release', pageId: 'page-1', leaseId, interactionId: 'flow-interaction',
      localClaimGeneration: 1, reservationGeneration: 2, terminalSampleSequence: 3, reason: 'cancelled',
    }))
    await expect(waitForWire(owner.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ action: 'release', status: 'released', interactionId: 'flow-interaction' })

    const malformed = await openObservedSocket(address.port, 'P'.repeat(24), 'live-malformed-client', 'live-malformed')
    const malformedClosed = once(malformed.socket, 'close')
    malformed.socket.send('{')
    const [malformedCode, malformedReason] = await malformedClosed
    expect(malformedCode).toBe(1007)
    expect(malformedReason.toString()).toBe('Invalid collaboration message')

    const topology = await openObservedSocket(address.port, 'Q'.repeat(24), 'live-topology-client', 'live-topology')
    topology.messages.length = 0
    topology.socket.send(JSON.stringify({
      type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1,
      presentation: flowPresentation({ interactionId: 'missing-source', sourceNodeId: 'missing-source-node' }),
    }))
    await expect(waitForWire(topology.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ status: 'denied', denialCode: 'missing_node', leaseId: null })
    topology.messages.length = 0
    topology.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 2, presentation: flowPresentation({ interactionId: 'after-topology-denial' }) }))
    const topologyRecovery = await waitForWire(topology.messages, value => value.type === 'interaction.result')
    expect(topologyRecovery).toMatchObject({ status: 'granted', denialCode: null })
    topology.socket.send(JSON.stringify({
      type: 'interaction.release', pageId: 'page-1', leaseId: topologyRecovery.leaseId, interactionId: 'after-topology-denial',
      localClaimGeneration: 2, reservationGeneration: 1, terminalSampleSequence: 1, reason: 'cancelled',
    }))
    await waitForWire(topology.messages, value => value.type === 'interaction.result' && value.action === 'release')

    const reservedSocket = await openObservedSocket(address.port, 'R'.repeat(24), 'live-reserved-client', 'live-reserved')
    const reservedClosed = once(reservedSocket.socket, 'close')
    reservedSocket.socket.send(JSON.stringify({
      type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1,
      presentation: flowPresentation({ interactionId: 'lease:11111111-1111-4111-8111-111111111111' }),
    }))
    const [reservedCode, reservedReason] = await reservedClosed
    expect(reservedCode).toBe(1007)
    expect(reservedReason.toString()).toBe('Invalid collaboration message')

    const recovery = await openObservedSocket(address.port, 'S'.repeat(24), 'live-reserved-recovery-client', 'live-reserved-recovery')
    recovery.messages.length = 0
    recovery.socket.send(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation({ interactionId: 'after-reserved-rejection' }) }))
    await expect(waitForWire(recovery.messages, value => value.type === 'interaction.result')).resolves.toMatchObject({ status: 'granted', denialCode: null })
  })

  it('rejects cross-origin upgrades and non-loopback binds', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence: new FakePersistence(), tickets: tickets(), projector, checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    cleanup = () => network.close()
    await expect(network.listen(0, '0.0.0.0')).rejects.toThrow('loopback')
    const address = await network.listen(0)
    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'https://wrong.example', headers: { Authorization: `Bearer ${ticket}` } })
    const [error] = await once(socket, 'error')
    expect(String(error)).toContain('403')
  })

  it('rejects an invalid capability before completing the WebSocket upgrade', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence: new FakePersistence(), tickets: { async verify() { return null }, async consume() { return null }, async isCurrent() { return false } }, projector, checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 2_000 })
    cleanup = () => network.close()
    const address = await network.listen(0)
    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1:4317', headers: { Authorization: `Bearer ${ticket}` } })
    const [error] = await once(socket, 'error')
    expect(String(error)).toContain('401')
    expect(room.activeConnections).toBe(0)
  })

  it('CLOUD-SYNC-DO-SEC-001 closes an authorized socket that never sends room.open', async () => {
    const room = new CollaborationRoomCore({
      identity: { fileId, generationId, protocolEpoch: 4 }, leaseDurationMs: 60_000, leaseRenewalMs: 30_000, drainTimeoutMs: 2_000,
    }, { persistence: new FakePersistence(), tickets: tickets(), projector, checkpoints })
    await room.start()
    const network = createRoomNetworkServer({ room, allowedOrigins: ['http://127.0.0.1:4317'], maxMessageBytes: 256 * 1024, handshakeTimeoutMs: 25 })
    cleanup = () => network.close()
    const address = await network.listen(0)
    const url = `ws://${address.hostname}:${address.port}/sync/${fileId}/${generationId}?clientId=${clientId}&connectionNonce=${connectionNonce}`
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1:4317', headers: { Authorization: `Bearer ${ticket}` } })
    await once(socket, 'open')
    const [code, reason] = await once(socket, 'close')

    expect(code).toBe(4408)
    expect(reason.toString()).toBe('Room open timed out')
    expect(room.activeConnections).toBe(0)
  })
})
