import { describe, expect, it } from 'vitest'
import type { CollaborationJsonObject } from '../src/index.js'
import {
  collaborationEnvelopeSchemaVersion,
  collaborationModeForRole,
  collaborationProtocolEpoch,
  collaborationWebSocketProtocol,
  decodeSemanticCommandFromPersistence,
  encodeCollaborationMessage,
  encodeSemanticCommandForPersistence,
  flowDragResourceLimits,
  isValidClientLifecycleTransition,
  isValidLoadPhaseTransition,
  maxCollaborationAvatarUrlBytes,
  maxCollaborationConnectionNonceLength,
  maxCollaborationIdentifierLength,
  maxRetryAfterMs,
  maxRoomTicketLength,
  maxSnapshotBytes,
  maxSnapshotChunkBytes,
  parseCollaborationClientMessage,
  parseCollaborationServerMessage,
  serverMessageMatchesEnvelope,
  semanticOperationContentDigest,
  validateSemanticFileCommand,
  validatePeerFlowDragPresentation,
  validateFlowDragPresentationStructure,
  validateVerifiedRoomTicketClaimsShape,
} from '../src/index.js'
import type { FlowDragPresentation, FlowDragTopologyAuthority } from '../src/flow.js'

const fileId = '11111111-1111-4111-8111-111111111111'
const generationId = '22222222-2222-4222-8222-222222222222'
const room = { fileId, generationId }
const serverEnvelope = { protocolEpoch: collaborationProtocolEpoch, schemaVersion: collaborationEnvelopeSchemaVersion, room, fenceToken: '9223372036854775807' }
const operation = { mutationId: 'mutation-0001', baseSequence: '4', command: { type: 'node.rename', nodeId: 'node-1', name: 'Card' } }
const flowFence = { fileId: 'file-1', fileRevision: 3, measurementRevision: 8, documentRevision: 3, layoutGeneration: 5, pageId: 'page-1', pageRootId: 'page-root-1' }
const flowSource = { coordinateSpace: 'world' as const, quad: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }] as const, aabb: { x: 0, y: 0, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 } }
const flowCurrent = { coordinateSpace: 'world' as const, quad: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 100 }, { x: 10, y: 100 }] as const, aabb: { x: 10, y: 20, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 } }
const flowPresentation = (sequence = 4, withTarget = false, withSupportClone = false): FlowDragPresentation => ({
  kind: 'flow-drag', coordinateSpace: 'world', identity: { interactionId: 'flow-drag-1', gestureGeneration: 2, sampleSequence: sequence }, fence: flowFence,
  retention: { kind: 'active', gestureGeneration: 2, sampleSequence: sequence }, pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
  original: {
    documentNodeId: 'frame-1', kind: 'frame', name: 'Frame', sourceRelationship: { parentId: 'flex-1', orderKey: 'V', slot: { presence: 'absent' } }, sourceIndex: 0,
    mode: 'flow', source: flowSource, current: flowCurrent, sourceOffsetParentPose: null,
    dom: { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null }, namePresentation: { visible: true, anchor: 'source', pose: flowSource },
  },
  movingVisual: { kind: 'fill-ghost', documentNodeId: null, geometry: flowCurrent, fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden' },
  supportClone: withSupportClone ? {
    key: { kind: 'flow-support-clone', interactionId: 'flow-drag-1', gestureGeneration: 2, cloneGeneration: 1 },
    documentNodeId: null, generation: 1,
    sourceRelationship: { parentId: 'flex-1', orderKey: 'V', slot: { presence: 'absent' } }, sourceIndex: 0,
    entryMode: 'flow', entry: null, world: flowSource, hiddenUntilCommit: true,
    role: 'inert-marker', layoutParticipation: 'none', hitTesting: 'none', a11y: 'hidden',
  } : null,
  target: withTarget ? { parentId: 'flex-1', slot: { presence: 'absent' }, rawIndex: 1, semanticIndex: 1, line: 0, parentOutline: null, insertionGuide: null } : null,
  hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
  mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
})
const peerFlowInteractionId = (leaseId: string): string => `lease:${leaseId}`
const peerFlowPresentation = (leaseId: string, sequence = 4, withTarget = false, withSupportClone = false): FlowDragPresentation => {
  const presentation = structuredClone(flowPresentation(sequence, withTarget, withSupportClone))
  ;(presentation.identity as { interactionId: string }).interactionId = peerFlowInteractionId(leaseId)
  if (presentation.supportClone) (presentation.supportClone.key as { interactionId: string }).interactionId = peerFlowInteractionId(leaseId)
  return presentation
}
const flowAuthority: FlowDragTopologyAuthority = {
  fileId: flowFence.fileId, fileRevision: flowFence.fileRevision, pageId: flowFence.pageId, pageRootId: flowFence.pageRootId,
  source: nodeId => nodeId === 'frame-1' ? { kind: 'frame', relationship: { parentId: 'flex-1', orderKey: 'V', slot: { presence: 'absent' } }, sourceIndex: 0 } : null,
  acceptsTarget: target => target.targetLane.parentId === 'flex-1' && target.targetLane.slot.presence === 'absent',
}

const compileTimeJsonPayload: CollaborationJsonObject = { nested: { values: Object.freeze(['x', 1, true, null]) } }
// @ts-expect-error persisted collaboration JSON cannot contain functions
const compileTimeInvalidJsonPayload: CollaborationJsonObject = { invalid: () => undefined }
void compileTimeJsonPayload
void compileTimeInvalidJsonPayload

describe('CLOUD-SYNC-STATE-001 lifecycle contract', () => {
  it('defines opening, dirty reconnect, parking, and graceful close paths', () => {
    const allowed = [
      ['cold', 'opening'], ['opening', 'authorizing'], ['authorizing', 'hydrating-local'], ['authorizing', 'offline-clean'],
      ['hydrating-local', 'admission-queued'], ['admission-queued', 'streaming'],
      ['streaming', 'applying'], ['applying', 'live'], ['live', 'offline-dirty'],
      ['offline-dirty', 'reconnecting'], ['reconnecting', 'authorizing'],
      ['applying', 'replaying'], ['replaying', 'live'],
      ['live', 'parked'], ['parked', 'reconnecting'], ['live', 'closing'], ['closing', 'closed'],
      ['closed', 'opening'], ['access-revoked', 'closing'], ['incompatible-build', 'closing'],
      ['capacity-refused', 'closing'], ['connection-failed', 'closing'],
    ] as const
    for (const [from, to] of allowed) expect(isValidClientLifecycleTransition(from, to), `${from} -> ${to}`).toBe(true)
  })

  it('rejects unsafe shortcuts, role upgrades, and reopening before close completes', () => {
    const denied = [
      ['cold', 'live'], ['streaming', 'live'], ['read-only', 'live'],
      ['opening', 'offline-clean'], ['opening', 'offline-dirty'],
      ['access-revoked', 'live'], ['closing', 'opening'], ['closed', 'live'],
      ['offline-clean', 'live'], ['parked', 'live'], ['reconnecting', 'live'],
      ['reconnecting', 'read-only'], ['access-revoked', 'closed'],
      ['incompatible-build', 'opening'], ['capacity-refused', 'closed'],
      ['hydrating-local', 'streaming'], ['hydrating-local', 'applying'],
    ] as const
    for (const [from, to] of denied) expect(isValidClientLifecycleTransition(from, to), `${from} -> ${to}`).toBe(false)
    expect(isValidClientLifecycleTransition('read-only', 'offline-clean')).toBe(true)
    expect(isValidClientLifecycleTransition('offline-clean', 'reconnecting')).toBe(true)
    expect(isValidClientLifecycleTransition('reconnecting', 'authorizing')).toBe(true)
  })
})

describe('CLOUD-SYNC-SCHEMA-001 client validation', () => {
  it('accepts an authority-free open request and session-bound semantic command', () => {
    const open = { type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId: 'request-1', fileId, clientId: 'client-1', buildId: 'web-2026.10.10', cachedSnapshotId: 'snapshot-1', afterSequence: '4' }
    const submit = { type: 'operation.submit', operation }
    expect(parseCollaborationClientMessage(JSON.stringify(open))).toEqual(open)
    expect(parseCollaborationClientMessage(JSON.stringify(submit))).toEqual(submit)
  })

  it('accepts the closed repo-engine FileCommand language', () => {
    const literal = { kind: 'literal', color: { kind: 'hex', hex: '#112233' } } as const
    const solid = { id: 'fill-1', type: 'solid', color: literal } as const
    const commands = [
      { type: 'page.create', page: { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' } },
      { type: 'page.setBackground', pageId: 'page-1', background: literal },
      { type: 'page.rename', pageId: 'page-1', name: 'Home' },
      { type: 'node.insert', node: { id: 'node-2', type: 'rectangle', name: 'Box', styles: { left: 0, top: 0, width: 10, height: 10 } }, placement: { parentId: 'root-1' } },
      { type: 'node.setStyles', nodeId: 'node-1', styles: { width: 200, rotation: null } },
      { type: 'node.setText', nodeId: 'node-1', text: 'Hello' },
      { type: 'node.setAppearance', nodeId: 'node-1', appearance: { fills: [solid] } },
      { type: 'node.fill.update', nodeId: 'node-1', fillId: 'fill-1', paint: solid },
      { type: 'node.outline.set', nodeId: 'node-1', outline: { color: literal, width: 1, style: 'solid', offset: 0 } },
      { type: 'node.borders.set', nodeId: 'node-1', borders: { all: { color: literal, width: 1, style: 'solid' } } },
      { type: 'asset.attach', asset: { id: 'asset-1', name: 'pixel.png', mime: 'image/png', extension: 'png', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) } },
      { type: 'node.setProps', nodeId: 'node-1', props: { label: 'Save' } },
      { type: 'node.setLayout', nodeId: 'node-1', layout: { item: { position: { mode: 'flow' } } } },
      { type: 'node.setBlending', nodeId: 'node-1', opacity: 0.5, blendMode: 'multiply' },
      { type: 'node.reparent', nodeId: 'node-1', placement: { parentId: 'frame-1', index: 0 }, preserveWorldPosition: true },
      { type: 'node.delete', nodeIds: ['node-1', 'node-2'] },
      { type: 'node.duplicate', nodeId: 'node-1', ids: { 'node-1': 'node-2' } },
      { type: 'token.create', token: { id: 'token-1', type: 'color', name: 'Surface', orderKey: 'V', value: literal } },
      { type: 'token.setValue', tokenId: 'token-1', value: literal },
      { type: 'token.setDescription', tokenId: 'token-1', description: 'Surface color' },
      { type: 'batch', commands: [{ type: 'node.rename', nodeId: 'node-1', name: 'Nested' }] },
    ]
    for (const command of commands) {
      const submit = { type: 'operation.submit', operation: { ...operation, command } }
      expect(() => parseCollaborationClientMessage(JSON.stringify(submit)), String(command.type)).not.toThrow()
      expect(parseCollaborationClientMessage(JSON.stringify(submit))).toMatchObject({ type: 'operation.submit', operation: { command } })
    }
  })

  it('proves arbitrary JSON paths and unknown commands cannot target document identity', () => {
    const submit = (command: unknown) => ({ type: 'operation.submit', operation: { ...operation, command } })
    expect(() => parseCollaborationClientMessage(JSON.stringify(submit({ type: 'set', path: ['fileId'], value: 'forged' })))).toThrow('Invalid semantic operation')
    expect(() => parseCollaborationClientMessage(JSON.stringify(submit({ type: 'document.edit', edits: [{ type: 'set', path: ['fileId'], value: 'forged' }] })))).toThrow('Invalid semantic operation')
    expect(() => parseCollaborationClientMessage(JSON.stringify(submit({ type: 'batch', commands: [] })))).toThrow('Invalid semantic operation')
  })

  it('rejects malformed commands, identifiers, and incompatible versions', () => {
    const open = { type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId: 'request-1', fileId, clientId: 'client-1', buildId: 'web-1' }
    expect(() => parseCollaborationClientMessage(JSON.stringify({ ...open, fileId: 'file-1' }))).toThrow('Invalid room open')
    expect(() => parseCollaborationClientMessage(JSON.stringify({ ...open, protocolEpoch: 3 }))).toThrow('Unsupported collaboration protocol epoch')
    expect(() => parseCollaborationClientMessage(JSON.stringify({ ...open, schemaVersion: 2 }))).toThrow('Unsupported collaboration envelope schema')

    const submit = (command: unknown) => ({ type: 'operation.submit', operation: { ...operation, command } })
    expect(() => parseCollaborationClientMessage(JSON.stringify(submit({ type: 'node.setBlending', nodeId: 'node-1', opacity: 2 })))).toThrow('Invalid semantic operation')
    expect(() => parseCollaborationClientMessage(JSON.stringify(submit({ type: 'node.delete', nodeIds: ['node-1', 'node-1'] })))).toThrow('Invalid semantic operation')
    const rename = { type: 'node.rename', nodeId: 'node-1', name: 'Card' }
    expect(() => validateSemanticFileCommand({ type: 'batch', commands: Array.from({ length: 513 }, () => rename) })).toThrow('Invalid semantic file command')
    const amplified = { type: 'batch', commands: Array.from({ length: 32 }, () => ({ type: 'batch', commands: Array.from({ length: 17 }, () => rename) })) }
    expect(() => validateSemanticFileCommand(amplified)).toThrow('Invalid semantic file command')
    let nested: unknown = rename
    for (let index = 0; index < 33; index += 1) nested = { type: 'batch', commands: [nested] }
    expect(() => validateSemanticFileCommand(nested)).toThrow('Invalid semantic file command')
    expect(() => validateSemanticFileCommand({ ...rename, extra: true })).toThrow('Invalid semantic file command')
    expect(() => validateSemanticFileCommand({ type: 'document.replace', document: { fileId } })).toThrow('Invalid semantic file command')
  })

  it('CLOUD-SYNC-DO-SEC-001 rejects all client-supplied session identity and authority after assignment', () => {
    const open = { type: 'room.open', protocolEpoch: 4, schemaVersion: 1, requestId: 'request-1', fileId, clientId: 'client-1', buildId: 'web-1', generationId: 'chosen', fenceToken: '91', role: 'owner' }
    expect(() => parseCollaborationClientMessage(JSON.stringify(open))).toThrow('Invalid room open')
    const forbiddenClaims = {
      clientId: 'client-2', generationId, role: 'owner', accessEpoch: '1', fenceToken: '91',
      roomTicket: 'room_ticket_1234567890', token: 'secret-token-value', cookie: 'session=secret', authorization: 'Bearer secret',
    }
    for (const [name, value] of Object.entries(forbiddenClaims)) {
      expect(() => parseCollaborationClientMessage(JSON.stringify({ type: 'operation.submit', operation, [name]: value })), name).toThrow('Invalid semantic operation')
      expect(() => parseCollaborationClientMessage(JSON.stringify({ type: 'room.leave', [name]: value })), name).toThrow('Invalid room leave')
    }
    const resume = { type: 'room.resume', requestId: 'request-1', afterSequence: '9', pendingMutationIds: ['mutation-0001', 'mutation-0001'] }
    expect(() => parseCollaborationClientMessage(JSON.stringify(resume))).toThrow('Invalid room resume')
    expect(() => parseCollaborationClientMessage(new Uint8Array([123]) as unknown as string)).toThrow('Binary collaboration messages are not supported')
    expect(() => parseCollaborationClientMessage(JSON.stringify({ ...resume, pendingMutationIds: [] }), 12)).toThrow('byte limit')
  })

  it('CLOUD-SYNC-AUTH-001 encodes subsequent client frames without credentials or mutable room claims', () => {
    const frames = [
      { type: 'room.resume', requestId: 'request-1', afterSequence: '9', pendingMutationIds: ['mutation-0001'] },
      { type: 'operation.submit', operation },
      { type: 'presence.update', sequence: 4, data: { focused: true } },
      { type: 'presence.update', sequence: 5, data: { pageId: null, selection: null, camera: null, cursor: null } },
      { type: 'room.leave' },
    ] as const
    const encoded = frames.map(frame => encodeCollaborationMessage(parseCollaborationClientMessage(JSON.stringify(frame))))
    for (const frame of encoded) {
      expect(frame).not.toMatch(/roomTicket|token|cookie|authorization|accessEpoch|fenceToken|generationId|clientId|room_ticket_1234567890/i)
    }
  })
})

describe('CLOUD-SYNC-PRESENCE-001 protocol contract', () => {
  const state = {
    pageId: 'page-1',
    focused: true,
    selection: { pageId: 'page-1', nodeIds: ['node-1'] },
    camera: { pageId: 'page-1', x: 10, y: -20, zoom: 1.5 },
    cursor: { pageId: 'page-1', x: 40, y: 50 },
  }
  const participant = { presenceId: 'presence-1', subjectId: 'user-1', displayName: 'Alpha', avatarUrl: 'https://images.example/alpha.png', clientId: 'client-1', role: 'owner', sequence: 4, data: state }

  it('accepts sparse same-page awareness and authoritative room events', () => {
    const update = { type: 'presence.update', sequence: 4, data: state }
    expect(parseCollaborationClientMessage(JSON.stringify(update))).toEqual(update)
    const messages = [
      { type: 'presence.roster', envelope: serverEnvelope, participants: [participant] },
      { type: 'presence.join', envelope: serverEnvelope, participant },
      { type: 'presence.changed', envelope: serverEnvelope, participant },
      { type: 'presence.leave', envelope: serverEnvelope, presenceId: 'presence-1', subjectId: 'user-1', clientId: 'client-1' },
    ]
    expect(messages.map(message => parseCollaborationServerMessage(JSON.stringify(message)))).toEqual(messages)
  })

  it('rejects empty, malformed, cross-page, duplicate, and oversized awareness values', () => {
    const update = (data: unknown) => ({ type: 'presence.update', sequence: 4, data })
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({})))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ cursor: { pageId: 'page-1', x: Number.MAX_VALUE, y: 0 } })))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ pageId: 'page-1', camera: { pageId: 'page-2', x: 0, y: 0, zoom: 1 } })))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ selection: { pageId: 'page-1', nodeIds: ['node-1', 'node-1'] } })))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ selection: { pageId: 'page-1', nodeIds: Array.from({ length: 513 }, (_, index) => `node-${index}`) } })), 512 * 1024)).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ pageId: 'page-1', interaction: { interactionId: 'gesture-1', pageId: 'page-2', kind: 'move', nodeIds: ['node-1'], transforms: [] } })))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ interaction: { interactionId: 'gesture-1', pageId: 'page-1', kind: 'move', nodeIds: ['node-1'], transforms: [{ nodeId: 'node-2', dx: 1, dy: 1 }] } })))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ focused: true, extra: 'forged' })))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ focused: true, displayName: 'Forged' })))).toThrow('Invalid presence update')
    expect(() => parseCollaborationClientMessage(JSON.stringify(update({ focused: true, avatarUrl: 'https://evil.example/avatar.png' })))).toThrow('Invalid presence update')
  })

  it('rejects the epoch-3 presence interaction channel', () => {
    const update = { type: 'presence.update', sequence: 4, data: { pageId: 'page-1', interaction: { interactionId: 'gesture-1', pageId: 'page-1', kind: 'resize', nodeIds: ['node-1'], transforms: [{ nodeId: 'node-1', dx: 3, dy: 4, width: 120, height: 80 }] } } }
    expect(() => parseCollaborationClientMessage(JSON.stringify(update))).toThrow('Invalid presence update')
  })

  it('rejects non-authoritative or internally inconsistent server presence', () => {
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'presence.roster', envelope: serverEnvelope, participants: [participant, participant] }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'presence.roster', envelope: serverEnvelope, participants: [participant, { ...participant, clientId: 'client-2' }] }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'presence.changed', envelope: serverEnvelope, participant: { ...participant, data: { ...state, cursor: { pageId: 'page-2', x: 1, y: 1 } } } }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'presence.leave', envelope: serverEnvelope, presenceId: 'presence-1', subjectId: 'user-1', clientId: 'bad client' }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'presence.leave', envelope: serverEnvelope, subjectId: 'user-1', clientId: 'client-1' }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'presence.changed', envelope: serverEnvelope, participant: { ...participant, displayName: ' Forged' } }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'presence.changed', envelope: serverEnvelope, participant: { ...participant, avatarUrl: 'http://images.example/alpha.png' } }))).toThrow('Invalid collaboration server message')
  })

  it('accepts the participant limit and rejects the next roster entry', () => {
    const participants = Array.from({ length: 512 }, (_, index) => ({
      ...participant,
      presenceId: `presence-${index}`,
      clientId: `client-${index}`,
    }))
    const roster = { type: 'presence.roster', envelope: serverEnvelope, participants }
    expect(parseCollaborationServerMessage(JSON.stringify(roster), 1_024 * 1_024)).toEqual(roster)
    expect(() => parseCollaborationServerMessage(JSON.stringify({
      ...roster,
      participants: [...participants, { ...participant, presenceId: 'presence-overflow', clientId: 'client-overflow' }],
    }), 1_024 * 1_024)).toThrow('Invalid collaboration server message')
  })
})

describe('CLOUD-SYNC-GESTURE-001-C1 epoch-4 interaction frames', () => {
  const leaseId = '33333333-3333-4333-8333-333333333333'
  const targetLane = { parentId: 'flex-1', slot: { presence: 'absent' as const } }
  const peerSample = (nextLeaseId: string, presentation: FlowDragPresentation) => ({
    type: 'interaction.sample', envelope: serverEnvelope, pageId: 'page-1', presenceId: 'presence-1', subjectId: 'user-1', clientId: 'client-1',
    leaseId: nextLeaseId, localClaimGeneration: 1, reservationGeneration: 2, presentation,
  })

  it('cuts directly to one exact epoch and rejects v3 without negotiation', () => {
    expect(collaborationProtocolEpoch).toBe(4)
    expect(collaborationWebSocketProtocol).toBe('canvas-sync-v4')
    const open = { type: 'room.open', protocolEpoch: 3, schemaVersion: 1, requestId: 'request-1', fileId, clientId: 'client-1', buildId: 'web-1' }
    expect(() => parseCollaborationClientMessage(JSON.stringify(open))).toThrow('Unsupported collaboration protocol epoch')
    const result = { type: 'interaction.result', envelope: { ...serverEnvelope, protocolEpoch: 3 }, pageId: 'page-1', action: 'acquire', status: 'denied', interactionId: 'flow-drag-1', leaseId: null, localClaimGeneration: 1, reservationGeneration: 1, sampleSequence: 4, denialCode: 'overlap' }
    expect(() => parseCollaborationServerMessage(JSON.stringify(result))).toThrow('Unsupported collaboration protocol epoch')
  })

  it('accepts exact acquire, reserve, sample, and release client frames', () => {
    const frames = [
      { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() },
      { type: 'interaction.reserve', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2, targetLane, presentation: flowPresentation(4, true) },
      { type: 'interaction.sample', pageId: 'page-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2, presentation: flowPresentation(5, true) },
      { type: 'interaction.release', pageId: 'page-1', leaseId, interactionId: 'flow-drag-1', localClaimGeneration: 1, reservationGeneration: 2, terminalSampleSequence: 5, reason: 'committed' },
    ]
    expect(frames.map(frame => parseCollaborationClientMessage(JSON.stringify(frame)))).toEqual(frames)
  })

  it('CLOUD-SYNC-SCHEMA-001-C1-LIVE and CLOUD-SYNC-GESTURE-001-C1-LIVE perform exact structural parsing before RoomCore supplies topology authority', () => {
    const acquire = { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation(4, false, true) }
    expect(validateFlowDragPresentationStructure(acquire.presentation, { interactionId: 'flow-drag-1', gestureGeneration: 2, sequence: 4 }, flowFence)).toBe(true)
    const parsedPresentation = JSON.parse(JSON.stringify(acquire.presentation))
    expect(validateFlowDragPresentationStructure(parsedPresentation, { interactionId: 'flow-drag-1', gestureGeneration: 2, sequence: 4 }, flowFence)).toBe(true)
    expect(parseCollaborationClientMessage(JSON.stringify(acquire))).toEqual(acquire)

    const extra = { ...acquire, presentation: { ...flowPresentation(4, false, true), role: 'owner' } }
    const malformed = structuredClone(acquire)
    ;(malformed.presentation.identity as unknown as Record<string, unknown>).sampleSequence = '4'
    const wrongLiteral = structuredClone(acquire)
    ;(wrongLiteral.presentation.mobileQuickActions.transition as unknown as Record<string, unknown>).source = 'paper'
    for (const frame of [extra, malformed, wrongLiteral]) {
      expect(() => parseCollaborationClientMessage(JSON.stringify(frame))).toThrow('Invalid interaction acquire message')
    }

    expect(() => parseCollaborationClientMessage(JSON.stringify(acquire), undefined, { ...flowAuthority, source: () => null })).toThrow('Invalid interaction acquire message')
  })

  it('accepts exact authoritative result, sample, released, and roster server frames', () => {
    const sample = {
      type: 'interaction.sample', envelope: serverEnvelope, pageId: 'page-1', presenceId: 'presence-1', subjectId: 'user-1', clientId: 'client-1', leaseId,
      localClaimGeneration: 1, reservationGeneration: 2, presentation: peerFlowPresentation(leaseId, 5, true),
    }
    const entry = { pageId: 'page-1', presenceId: 'presence-1', subjectId: 'user-1', clientId: 'client-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2, presentation: peerFlowPresentation(leaseId, 5, true) }
    const frames = [
      { type: 'interaction.result', envelope: serverEnvelope, pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: 'flow-drag-1', leaseId, localClaimGeneration: 1, reservationGeneration: 1, sampleSequence: 4, denialCode: null },
      sample,
      { type: 'interaction.released', envelope: serverEnvelope, pageId: 'page-1', presenceId: 'presence-1', subjectId: 'user-1', clientId: 'client-1', interactionId: peerFlowInteractionId(leaseId), leaseId, localClaimGeneration: 1, reservationGeneration: 2, terminalSampleSequence: 5, reason: 'committed' },
      { type: 'interaction.roster', envelope: serverEnvelope, interactions: [entry] },
    ]
    expect(frames.map(frame => parseCollaborationServerMessage(JSON.stringify(frame), undefined, flowAuthority))).toEqual(frames)
  })

  it('CLOUD-SYNC-LEASE-001-C1-LEASE binds every peer sample presentation identity to its exact lease namespace', () => {
    const otherLeaseId = '44444444-4444-4444-8444-444444444444'
    const rootOnly = peerFlowPresentation(leaseId, 5, true, true)
    ;(rootOnly.identity as { interactionId: string }).interactionId = peerFlowInteractionId(otherLeaseId)
    const supportCloneOnly = peerFlowPresentation(leaseId, 5, true, true)
    ;(supportCloneOnly.supportClone!.key as { interactionId: string }).interactionId = peerFlowInteractionId(otherLeaseId)
    const leaseOnly = peerSample(otherLeaseId, peerFlowPresentation(leaseId, 5, true, true))
    const structurallyValidWrongLease = peerSample(leaseId, peerFlowPresentation(otherLeaseId, 5, true, true))
    for (const frame of [
      peerSample(leaseId, rootOnly),
      peerSample(leaseId, supportCloneOnly),
      leaseOnly,
      structurallyValidWrongLease,
    ]) expect(() => parseCollaborationServerMessage(JSON.stringify(frame), undefined, flowAuthority)).toThrow('Invalid collaboration server message')

    const valid = peerSample(leaseId, peerFlowPresentation(leaseId, 5, true, true))
    expect(parseCollaborationServerMessage(JSON.stringify(valid), undefined, flowAuthority)).toEqual(valid)
  })

  it('CLOUD-SYNC-LEASE-001-C1-LEASE checks lease identities through data descriptors without getters or mutation', () => {
    const value = peerFlowPresentation(leaseId, 5, true, true)
    const before = JSON.stringify(value)
    expect(validatePeerFlowDragPresentation(value, leaseId)).toBe(true)
    expect(JSON.stringify(value)).toBe(before)

    let reads = 0
    const rootAccessor = structuredClone(value)
    Object.defineProperty(rootAccessor.identity, 'interactionId', {
      enumerable: true,
      get: () => { reads += 1; return peerFlowInteractionId(leaseId) },
    })
    expect(validatePeerFlowDragPresentation(rootAccessor, leaseId)).toBe(false)
    expect(reads).toBe(0)

    const nestedAccessor = structuredClone(value)
    Object.defineProperty(nestedAccessor.supportClone!.key, 'interactionId', {
      enumerable: true,
      get: () => { reads += 1; return peerFlowInteractionId(leaseId) },
    })
    expect(validatePeerFlowDragPresentation(nestedAccessor, leaseId)).toBe(false)
    expect(reads).toBe(0)

    const hidden = structuredClone(value)
    Object.defineProperty(hidden.identity, 'hidden', { enumerable: false, value: peerFlowInteractionId(leaseId) })
    expect(validatePeerFlowDragPresentation(hidden, leaseId)).toBe(false)

    const symbolic = structuredClone(value)
    Object.defineProperty(symbolic.supportClone!.key, Symbol('interactionId'), { enumerable: true, value: peerFlowInteractionId(leaseId) })
    expect(validatePeerFlowDragPresentation(symbolic, leaseId)).toBe(false)

    const nonEnumerableIdentity = structuredClone(value)
    Object.defineProperty(nonEnumerableIdentity.supportClone!.key, 'interactionId', {
      enumerable: false,
      value: peerFlowInteractionId(leaseId),
    })
    expect(validatePeerFlowDragPresentation(nonEnumerableIdentity, leaseId)).toBe(false)
  })

  it('CLOUD-SYNC-LEASE-001-C1-LEASE rejects a mixed roster when any entry is not bound to its own lease', () => {
    const otherLeaseId = '44444444-4444-4444-8444-444444444444'
    const first = { pageId: 'page-1', presenceId: 'presence-1', subjectId: 'user-1', clientId: 'client-1', leaseId, localClaimGeneration: 1, reservationGeneration: 2, presentation: peerFlowPresentation(leaseId, 5, true, true) }
    const second = { pageId: 'page-1', presenceId: 'presence-2', subjectId: 'user-2', clientId: 'client-2', leaseId: otherLeaseId, localClaimGeneration: 1, reservationGeneration: 2, presentation: peerFlowPresentation(otherLeaseId, 5, true, true) }
    const mixed = structuredClone({ type: 'interaction.roster', envelope: serverEnvelope, interactions: [first, second] })
    mixed.interactions[1]!.presentation = peerFlowPresentation(leaseId, 5, true, true)
    expect(() => parseCollaborationServerMessage(JSON.stringify(mixed), undefined, flowAuthority)).toThrow('Invalid collaboration server message')

    const valid = { type: 'interaction.roster', envelope: serverEnvelope, interactions: [first, second] }
    expect(parseCollaborationServerMessage(JSON.stringify(valid), undefined, flowAuthority)).toEqual(valid)
  })

  it('CLOUD-SYNC-LEASE-001-C1-LEASE binds released tombstones to lease-derived peer identities', () => {
    const frame = {
      type: 'interaction.released', envelope: serverEnvelope, pageId: 'page-1', presenceId: 'presence-1', subjectId: 'user-1', clientId: 'client-1',
      interactionId: peerFlowInteractionId(leaseId), leaseId, localClaimGeneration: 1, reservationGeneration: 2, terminalSampleSequence: 5, reason: 'committed',
    }
    expect(parseCollaborationServerMessage(JSON.stringify(frame))).toEqual(frame)
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...frame, interactionId: 'flow-drag-1' }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...frame, leaseId: '44444444-4444-4444-8444-444444444444' }))).toThrow('Invalid collaboration server message')
  })

  it('rejects the reserved peer namespace at client acquire without partial acceptance', () => {
    const reserved = peerFlowPresentation(leaseId, 4, false, true)
    const frame = { type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: reserved }
    expect(() => parseCollaborationClientMessage(JSON.stringify(frame), undefined, flowAuthority)).toThrow('Invalid interaction acquire message')

    const valid = { ...frame, presentation: flowPresentation(4, false, true) }
    expect(parseCollaborationClientMessage(JSON.stringify(valid), undefined, flowAuthority)).toEqual(valid)
  })

  it('binds terminal semantic operations to one exact lease, generation, sequence, digest, and lane pair', () => {
    const flowBinding = {
      leaseId, interactionId: 'flow-drag-1', localClaimGeneration: 1, reservationGeneration: 2, terminalSampleSequence: 5,
      presentationDigest: 'a'.repeat(64), sourceLane: { parentId: 'flex-1', slot: { presence: 'absent' as const } },
      targetLane: { parentId: 'flex-2', slot: { presence: 'present' as const, value: '' } },
    }
    const frame = { type: 'operation.submit', operation: { ...operation, flowBinding } }
    expect(parseCollaborationClientMessage(JSON.stringify(frame))).toEqual(frame)

    const invalid = [
      { ...flowBinding, extra: true },
      { ...flowBinding, leaseId: 'not-a-uuid' },
      { ...flowBinding, localClaimGeneration: 0 },
      { ...flowBinding, reservationGeneration: 0 },
      { ...flowBinding, terminalSampleSequence: 0 },
      { ...flowBinding, presentationDigest: 'g'.repeat(64) },
      { ...flowBinding, sourceLane: { parentId: 'flex-1', slot: { presence: 'absent', value: '' } } },
      { ...flowBinding, targetLane: { parentId: 'flex-2', slot: { presence: 'present' } } },
    ]
    const { terminalSampleSequence: _terminalSampleSequence, ...missing } = flowBinding
    invalid.push(missing as typeof flowBinding)
    for (const candidate of invalid) {
      expect(() => parseCollaborationClientMessage(JSON.stringify({ type: 'operation.submit', operation: { ...operation, flowBinding: candidate } }))).toThrow('Invalid semantic operation')
    }
  })

  it('locks the frozen flow-specific resource ceilings', () => {
    expect(Object.isFrozen(flowDragResourceLimits)).toBe(true)
    expect(flowDragResourceLimits).toEqual({
      maxClaimsPerLease: 16,
      maxLanesPerReservation: 8,
      maxNodeIdsPerLane: 4096,
      maxReservedIdsPerSession: 16_384,
      maxReservationBytesPerSession: 512 * 1024,
      maxReservationsPerRoom: 512,
      maxClaimsPerRoom: 2048,
      maxSamplesPerSecond: 240,
      maxSampleBurst: 480,
      maxSamplePayloadBytes: 64 * 1024,
      maxTopologyDepth: 128,
      maxLaneComparisonNodes: 8192,
      maxTerminalGeometryItems: 32,
      maxRetainedSettlementReceipts: 512,
    })
  })

  it('accepts only the exact result action, status, lease, and denial matrix', () => {
    const result = (action: string, status: string, nextLeaseId: string | null, denialCode: string | null) => ({
      type: 'interaction.result', envelope: serverEnvelope, pageId: 'page-1', action, status, interactionId: 'flow-drag-1',
      leaseId: nextLeaseId, localClaimGeneration: 1, reservationGeneration: 1, sampleSequence: 4, denialCode,
    })
    const valid = [
      result('acquire', 'granted', leaseId, null), result('acquire', 'retained', leaseId, null), result('acquire', 'denied', null, 'overlap'),
      result('reserve', 'granted', leaseId, null), result('reserve', 'retained', leaseId, null), result('reserve', 'denied', leaseId, 'invalid_topology'),
      result('release', 'retained', leaseId, null), result('release', 'released', leaseId, null), result('release', 'denied', leaseId, 'stale_generation'),
    ]
    expect(valid.map(frame => parseCollaborationServerMessage(JSON.stringify(frame)))).toEqual(valid)
    for (const frame of [
      result('acquire', 'released', leaseId, null), result('acquire', 'denied', leaseId, 'overlap'),
      result('reserve', 'released', leaseId, null), result('reserve', 'denied', null, 'overlap'),
      result('release', 'granted', leaseId, null), result('release', 'released', null, null),
      result('release', 'denied', leaseId, null), result('release', 'retained', leaseId, 'overlap'),
    ]) expect(() => parseCollaborationServerMessage(JSON.stringify(frame))).toThrow('Invalid collaboration server message')
  })

  it('rejects extra fields, stale presentation identity, topology mismatch, and inconsistent results', () => {
    expect(() => parseCollaborationClientMessage(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation(), role: 'owner' }), undefined, flowAuthority)).toThrow('Invalid interaction acquire')
    const stale = structuredClone(flowPresentation())
    ;(stale.identity as { sampleSequence: number }).sampleSequence = 3
    expect(() => parseCollaborationClientMessage(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: stale }), undefined, flowAuthority)).toThrow('Invalid interaction acquire')
    expect(() => parseCollaborationClientMessage(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-1', localClaimGeneration: 1, presentation: flowPresentation() }), undefined, { ...flowAuthority, source: () => null })).toThrow('Invalid interaction acquire')
    expect(() => parseCollaborationClientMessage(JSON.stringify({ type: 'interaction.acquire', pageId: 'page-2', localClaimGeneration: 1, presentation: flowPresentation() }), undefined, flowAuthority)).toThrow('Invalid interaction acquire')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'interaction.result', envelope: serverEnvelope, pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: 'flow-drag-1', leaseId, localClaimGeneration: 1, reservationGeneration: 1, sampleSequence: 4, denialCode: 'overlap' }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'interaction.result', envelope: serverEnvelope, pageId: 'page-1', action: 'acquire', status: 'granted', interactionId: 'flow-drag-1', leaseId, localClaimGeneration: 1, reservationGeneration: 1, sampleSequence: 0, denialCode: null }))).toThrow('Invalid collaboration server message')
  })
})

describe('ticket capability boundary', () => {
  it('requires every server-verified claim bound by the opaque ticket', () => {
    const claims = { subjectId: 'user-1', displayName: 'Alpha', avatarUrl: 'https://images.example/alpha.png', fileId, role: 'owner', generationId, protocolEpoch: 4, buildId: 'web-1', expiresAtUnixMs: 1_800_000_000_000, accessEpoch: '3', clientId: 'client-1', connectionNonce: 'nonce_1234567890123' }
    expect(validateVerifiedRoomTicketClaimsShape(claims)).toEqual(claims)
    expect(collaborationModeForRole('owner')).toBe('editable')
    expect(collaborationModeForRole('viewer')).toBe('read_only')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, role: 'editor' })).toThrow('Invalid verified room ticket claims')
    const { connectionNonce: _, ...missingNonce } = claims
    expect(() => validateVerifiedRoomTicketClaimsShape(missingNonce)).toThrow('Invalid verified room ticket claims')
    const { buildId: _buildId, ...missingBuild } = claims
    expect(() => validateVerifiedRoomTicketClaimsShape(missingBuild)).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, buildId: 'stale build' })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, accessEpoch: '-1' })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, displayName: ' Alpha ' })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, displayName: 'A'.repeat(81) })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, displayName: 'Al\u202Epha' })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, displayName: 'Al\u2067pha' })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, displayName: 'Al\u200Bpha' })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, displayName: 'Al\u200Dpha' })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, avatarUrl: 'http://images.example/alpha.png' })).toThrow('Invalid verified room ticket claims')
    const avatarPrefix = 'https://images.example/'
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, avatarUrl: `${avatarPrefix}${'a'.repeat(maxCollaborationAvatarUrlBytes - avatarPrefix.length + 1)}` })).toThrow('Invalid verified room ticket claims')
    expect(() => validateVerifiedRoomTicketClaimsShape({ ...claims, email: 'alpha@example.test' })).toThrow('Invalid verified room ticket claims')
  })

  it('keeps the largest valid claims payload within the canonical room-ticket limit', () => {
    const avatarPrefix = 'https://images.example/'
    const worstCase = {
      subjectId: 's'.repeat(128),
      displayName: '😀'.repeat(80),
      avatarUrl: `${avatarPrefix}${'a'.repeat(maxCollaborationAvatarUrlBytes - avatarPrefix.length)}`,
      fileId,
      role: 'viewer',
      generationId,
      protocolEpoch: 4,
      buildId: 'b'.repeat(maxCollaborationIdentifierLength),
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
      accessEpoch: '9223372036854775807',
      clientId: 'c'.repeat(128),
      connectionNonce: 'n'.repeat(maxCollaborationConnectionNonceLength),
    }
    expect(validateVerifiedRoomTicketClaimsShape(worstCase)).toEqual(worstCase)
    const payloadBytes = new TextEncoder().encode(JSON.stringify(worstCase)).byteLength
    const encodedTicketLength = Math.ceil((payloadBytes + 32) * 4 / 3)
    expect(encodedTicketLength).toBeLessThanOrEqual(maxRoomTicketLength)
  })
})

describe('semantic command persistence codec', () => {
  it('round trips the canonical operation columns and matches the database content digest vector', async () => {
    const command = { type: 'node.reparent', nodeId: 'node-1', placement: { parentId: 'frame-1', index: 0 }, preserveWorldPosition: true } as const
    const encoded = encodeSemanticCommandForPersistence(command)
    const persistenceCompatiblePayload: CollaborationJsonObject = encoded.operationPayload
    expect(encoded).toEqual({
      operationType: 'node.reparent',
      operationPayload: { nodeId: 'node-1', placement: { parentId: 'frame-1', index: 0 }, preserveWorldPosition: true },
    })
    expect(decodeSemanticCommandFromPersistence(encoded)).toEqual(command)
    expect(await semanticOperationContentDigest(command)).toBe('641cdb52c2ffe8c8921747c4030d2be4df1a6ec9e9c24202f8f6640f8b51ae6c')
    expect(Object.isFrozen(encoded.operationPayload)).toBe(true)
    expect(Object.isFrozen(encoded.operationPayload.placement)).toBe(true)
    expect(persistenceCompatiblePayload).toBe(encoded.operationPayload)
  })

  it('does not include mutation id or base sequence in persisted operation content', async () => {
    const command = { type: 'node.rename', nodeId: 'node-1', name: 'Card' } as const
    const expected = await semanticOperationContentDigest(command)
    expect(await semanticOperationContentDigest({ ...command })).toBe(expected)
    expect(() => encodeSemanticCommandForPersistence({ mutationId: 'mutation-0001', baseSequence: '4', command })).toThrow('Invalid semantic file command')
  })

  it('rejects unknown columns, type smuggling, and payloads outside the exact command schema', () => {
    expect(() => decodeSemanticCommandFromPersistence({ operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Card' }, role: 'owner' })).toThrow('Invalid persisted semantic command')
    expect(() => decodeSemanticCommandFromPersistence({ operationType: 'node.rename', operationPayload: { type: 'node.delete', nodeId: 'node-1', name: 'Card' } })).toThrow('Invalid persisted semantic command')
    expect(() => decodeSemanticCommandFromPersistence({ operationType: 'node.rename', operationPayload: { nodeId: 'node-1', name: 'Card', fileId } })).toThrow('Invalid semantic file command')
    expect(() => encodeSemanticCommandForPersistence({ type: 'node.rename', nodeId: 'node-1', name: 1n })).toThrow('Invalid semantic file command')
  })
})

describe('protocol portions of REPLAY-001', () => {
  it('models idempotent ACKs and stale-base resynchronization explicitly', () => {
    const messages = [
      { type: 'operation.ack', envelope: serverEnvelope, mutationId: 'mutation-0001', sequence: '5', status: 'applied' },
      { type: 'operation.ack', envelope: serverEnvelope, mutationId: 'mutation-0001', sequence: '5', status: 'duplicate' },
      { type: 'operation.rebase_required', envelope: serverEnvelope, mutationId: 'mutation-0002', baseSequence: '4', authoritativeSequence: '7', retry: 'resync' },
    ]
    expect(messages.map(message => parseCollaborationServerMessage(JSON.stringify(message)))).toEqual(messages)
  })

  it('rejects underdefined stale operations and malformed authority', () => {
    const rebase = { type: 'operation.rebase_required', envelope: serverEnvelope, mutationId: 'mutation-0002', baseSequence: '4', authoritativeSequence: '4', retry: 'resync' }
    expect(() => parseCollaborationServerMessage(JSON.stringify(rebase))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...rebase, authoritativeSequence: '7', retry: 'retry' }))).toThrow('Invalid collaboration server message')
    const ack = { type: 'operation.ack', envelope: { ...serverEnvelope, fenceToken: '01' }, mutationId: 'mutation-0001', sequence: '5', status: 'duplicate' }
    expect(() => parseCollaborationServerMessage(JSON.stringify(ack))).toThrow('Invalid collaboration server message')
  })
})

describe('snapshot stream contract', () => {
  it('accepts the canonical load phases and a consistent snapshot declaration', () => {
    const messages = [
      { type: 'admission.queued', protocolEpoch: 4, schemaVersion: 1, requestId: 'request-1' },
      { type: 'room.assigned', envelope: serverEnvelope, requestId: 'request-1', role: 'owner', replayScopeId: 'a'.repeat(64) },
      { type: 'load.phase', envelope: serverEnvelope, requestId: 'request-1', phase: 'stream' },
      { type: 'snapshot.begin', envelope: serverEnvelope, requestId: 'request-1', snapshotId: 'snapshot-1', documentSchemaVersion: 9, baseSequence: '4', compression: 'none', contentEncoding: 'utf-8', storedByteLength: 2, documentByteLength: 2, objectDigest: 'a'.repeat(64), documentDigest: 'a'.repeat(64), chunkCount: 1 },
      { type: 'snapshot.chunk', envelope: serverEnvelope, requestId: 'request-1', snapshotId: 'snapshot-1', chunkIndex: 0, chunkCount: 1, data: 'e30=' },
      { type: 'snapshot.end', envelope: serverEnvelope, requestId: 'request-1', snapshotId: 'snapshot-1' },
      { type: 'load.phase', envelope: serverEnvelope, requestId: 'request-1', phase: 'apply' },
      { type: 'sync.ready', envelope: serverEnvelope, requestId: 'request-1', snapshotId: 'snapshot-1', serverSequence: '4', role: 'owner' },
    ]
    expect(messages.map(message => parseCollaborationServerMessage(JSON.stringify(message)))).toEqual(messages)
    expect(isValidLoadPhaseTransition('stream', 'apply')).toBe(true)
    expect(isValidLoadPhaseTransition('apply', 'stream')).toBe(false)
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'admission.queued', protocolEpoch: 4, schemaVersion: 1, requestId: 'request-1', envelope: serverEnvelope }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ type: 'room.assigned', envelope: serverEnvelope, requestId: 'request-1', roomTicket: 'room_ticket_1234567890', role: 'owner', replayScopeId: 'a'.repeat(64) }))).toThrow('Invalid collaboration server message')
  })

  it('requires a non-secret replay-scope digest on room assignment', () => {
    const assigned = { type: 'room.assigned', envelope: serverEnvelope, requestId: 'request-1', role: 'owner', replayScopeId: 'a'.repeat(64) }
    expect(parseCollaborationServerMessage(JSON.stringify(assigned))).toEqual(assigned)
    expect(JSON.stringify(assigned)).not.toMatch(/accessEpoch|roomTicket|capability/i)
    for (const replayScopeId of [undefined, '', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64)]) {
      const candidate = replayScopeId === undefined
        ? { type: assigned.type, envelope: assigned.envelope, requestId: assigned.requestId, role: assigned.role }
        : { ...assigned, replayScopeId }
      expect(() => parseCollaborationServerMessage(JSON.stringify(candidate)), String(replayScopeId)).toThrow('Invalid collaboration server message')
    }
  })

  it('rejects unsupported schemas and inconsistent or oversized snapshot declarations', () => {
    const begin = { type: 'snapshot.begin', envelope: serverEnvelope, requestId: 'request-1', snapshotId: 'snapshot-1', documentSchemaVersion: 9, baseSequence: '0', compression: 'none', contentEncoding: 'utf-8', storedByteLength: maxSnapshotChunkBytes + 1, documentByteLength: maxSnapshotChunkBytes + 1, objectDigest: 'a'.repeat(64), documentDigest: 'a'.repeat(64), chunkCount: 2 }
    expect(parseCollaborationServerMessage(JSON.stringify(begin))).toEqual(begin)
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...begin, documentSchemaVersion: 8 }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...begin, chunkCount: 1 }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...begin, storedByteLength: maxSnapshotBytes + 1, documentByteLength: maxSnapshotBytes + 1 }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...begin, compression: 'gzip' }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...begin, documentByteLength: begin.documentByteLength + 1 }))).toThrow('Invalid collaboration server message')
    const chunk = { type: 'snapshot.chunk', envelope: serverEnvelope, requestId: 'request-1', snapshotId: 'snapshot-1', chunkIndex: 0, chunkCount: 1, data: 'A'.repeat(Math.ceil(maxSnapshotChunkBytes / 3) * 4 + 4) }
    expect(() => parseCollaborationServerMessage(JSON.stringify(chunk), 512 * 1024)).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...chunk, data: 'e30=', chunkIndex: 2, chunkCount: 2 }))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...chunk, data: 'e30=', chunkIndex: 0, chunkCount: Math.ceil(maxSnapshotBytes / maxSnapshotChunkBytes) + 1 }))).toThrow('Invalid collaboration server message')
  })

  it('rejects non-canonical durable integers and values above PostgreSQL signed int64', () => {
    const ack = { type: 'operation.ack', envelope: serverEnvelope, mutationId: 'mutation-0001', sequence: '0', status: 'applied' }
    expect(parseCollaborationServerMessage(JSON.stringify(ack))).toEqual(ack)
    for (const sequence of [0, '00', '01', '-1', '9223372036854775808']) {
      expect(() => parseCollaborationServerMessage(JSON.stringify({ ...ack, sequence })), String(sequence)).toThrow('Invalid collaboration server message')
    }
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...ack, envelope: { ...serverEnvelope, fenceToken: '9223372036854775808' } }))).toThrow('Invalid collaboration server message')
  })
})

describe('protocol portions of DRAIN-001 and READONLY-001', () => {
  it('request-scopes pre-assignment errors and room-scopes post-assignment errors', () => {
    const capacity = { type: 'request.error', protocolEpoch: 4, schemaVersion: 1, requestId: 'request-1', code: 'capacity_refused', message: 'Room capacity is unavailable.', retry: 'retry', retryAfterMs: 250 }
    const draining = { type: 'room.error', envelope: serverEnvelope, code: 'draining', message: 'Room is moving.', retry: 'reconnect', retryAfterMs: 250 }
    const readOnly = { type: 'room.error', envelope: serverEnvelope, code: 'read_only', message: 'This file is read-only.', retry: 'none', mutationId: 'mutation-0001' }
    expect(parseCollaborationServerMessage(JSON.stringify(capacity))).toEqual(capacity)
    expect(parseCollaborationServerMessage(JSON.stringify(draining))).toEqual(draining)
    expect(parseCollaborationServerMessage(JSON.stringify(readOnly))).toEqual(readOnly)
  })

  it('rejects unscoped post-assignment errors and unbounded or contradictory retry instructions', () => {
    const unscoped = { type: 'room.error', code: 'access_revoked', message: 'Access was removed.', retry: 'none' }
    expect(() => parseCollaborationServerMessage(JSON.stringify(unscoped))).toThrow('Invalid collaboration envelope')
    const draining = { type: 'room.error', envelope: serverEnvelope, code: 'draining', message: 'Room is moving.', retry: 'reconnect', retryAfterMs: maxRetryAfterMs + 1 }
    expect(() => parseCollaborationServerMessage(JSON.stringify(draining))).toThrow('Invalid collaboration server message')
    expect(() => parseCollaborationServerMessage(JSON.stringify({ ...draining, retry: 'none', retryAfterMs: undefined }))).toThrow('Invalid collaboration server message')
  })

  it('lets consumers reject valid messages from stale generations or fence holders', () => {
    const current = { type: 'room.error', envelope: serverEnvelope, code: 'access_revoked', message: 'Access was removed.', retry: 'none' }
    const staleGeneration = { ...current, envelope: { ...serverEnvelope, room: { ...room, generationId: '33333333-3333-4333-8333-333333333333' } } }
    const staleFence = { ...current, envelope: { ...serverEnvelope, fenceToken: '9' } }
    const parsedCurrent = parseCollaborationServerMessage(JSON.stringify(current))
    const parsedGeneration = parseCollaborationServerMessage(JSON.stringify(staleGeneration))
    const parsedFence = parseCollaborationServerMessage(JSON.stringify(staleFence))
    expect(serverMessageMatchesEnvelope(parsedCurrent, serverEnvelope)).toBe(true)
    expect(serverMessageMatchesEnvelope(parsedGeneration, serverEnvelope)).toBe(false)
    expect(serverMessageMatchesEnvelope(parsedFence, serverEnvelope)).toBe(false)
  })
})
