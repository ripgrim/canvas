import { describe, expect, it } from 'vitest'
import type { ClientLifecycleState, ServerRoomEnvelope } from '@canvas/sync-protocol'
import { collaborationEnvelopeSchemaVersion, collaborationProtocolEpoch } from '@canvas/sync-protocol'
import { createCollaborationStateMachine, StaleCollaborationMessageError } from '../src/collaboration-state.js'

const fileId = '11111111-1111-4111-8111-111111111111'
const firstGenerationId = '22222222-2222-4222-8222-222222222222'
const secondGenerationId = '33333333-3333-4333-8333-333333333333'

function envelope(generationId = firstGenerationId, fenceToken = '1'): ServerRoomEnvelope {
  return {
    protocolEpoch: collaborationProtocolEpoch,
    schemaVersion: collaborationEnvelopeSchemaVersion,
    room: { fileId, generationId },
    fenceToken,
  }
}

type Machine = ReturnType<typeof createCollaborationStateMachine>

function assignedMachine(): Machine {
  const state = createCollaborationStateMachine()
  state.open({ fileId, requestId: 'request-1', socketEpoch: 1 })
  state.transition('authorizing')
  state.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 1 })
  state.assignRoom({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' })
  return state
}

function readOnlyMachine(): Machine {
  const state = createCollaborationStateMachine()
  state.open({ fileId, requestId: 'request-1', socketEpoch: 1 })
  state.transition('authorizing')
  state.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 1 })
  state.assignRoom({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'viewer' })
  state.transition('streaming')
  state.transition('applying')
  state.acceptSyncReady({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'viewer' })
  return state
}

function machineAt(target: ClientLifecycleState): Machine {
  const state = createCollaborationStateMachine()
  if (target === 'cold') return state
  state.open({ fileId, requestId: 'request-1', socketEpoch: 1 })
  if (target === 'opening') return state
  state.transition('authorizing')
  if (target === 'authorizing') return state
  if (target === 'capacity-refused' || target === 'connection-failed') { state.transition(target); return state }
  if (target === 'hydrating-local') { state.transition(target); return state }
  state.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 1 })
  if (target === 'admission-queued') return state
  state.assignRoom({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' })
  if (target === 'streaming') { state.transition(target); return state }
  state.transition('streaming')
  if (target === 'incompatible-build') { state.transition(target); return state }
  state.transition('applying')
  if (target === 'applying') return state
  if (target === 'read-only') return readOnlyMachine()
  if (target === 'replaying') { state.transition(target); return state }
  state.acceptSyncReady({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' })
  if (target === 'live') return state
  if (target === 'offline-clean' || target === 'offline-dirty' || target === 'parked' || target === 'access-revoked' || target === 'draining' || target === 'closing') {
    state.transition(target)
    return state
  }
  if (target === 'reconnecting') {
    state.transition('offline-clean')
    state.transition(target)
    return state
  }
  if (target === 'closed') {
    state.transition('closing')
    state.transition(target)
    return state
  }
  throw new Error(`Unhandled lifecycle state: ${target}`)
}

const currentContext = { requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' as const }

describe('unit coverage for CLOUD-SYNC-STATE-001 collaboration state', () => {
  it('follows the complete open path without skipping phases', () => {
    const state = createCollaborationStateMachine()
    state.open({ fileId, requestId: 'request-1', socketEpoch: 1 })
    state.transition('authorizing')
    state.transition('hydrating-local')
    state.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 1 })
    state.assignRoom({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' })
    state.transition('streaming')
    state.transition('applying')
    state.acceptSyncReady({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' })

    expect(state.getSnapshot()).toMatchObject({
      lifecycle: 'live',
      attempt: { fileId, requestId: 'request-1', socketEpoch: 1 },
      envelope: { room: { fileId, generationId: firstGenerationId }, fenceToken: '1' },
      role: 'owner',
      mode: 'editable',
      disposed: false,
    })
    expect(Object.isFrozen(state.getSnapshot())).toBe(true)
  })

  it('rejects a state shortcut', () => {
    const state = createCollaborationStateMachine()
    expect(() => state.transition('live')).toThrow('Ready state requires an authoritative role confirmation.')
    expect(state.getSnapshot().lifecycle).toBe('cold')
  })

  it('invalidates the previous room when a newer reconnect attempt begins', () => {
    const state = createCollaborationStateMachine()
    state.open({ fileId, requestId: 'request-1', socketEpoch: 1 })
    state.transition('authorizing')
    state.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 1 })
    state.assignRoom({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' })
    state.transition('streaming')
    state.transition('applying')
    state.acceptSyncReady({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'owner' })
    state.transition('offline-clean')
    state.transition('reconnecting')
    state.startReconnectAttempt({ fileId, requestId: 'request-2', socketEpoch: 2 })

    expect(state.getSnapshot()).toMatchObject({ lifecycle: 'authorizing', envelope: null })
    expect(() => state.assertCurrentMessage({ requestId: 'request-2', socketEpoch: 2, envelope: envelope(secondGenerationId, '2') }))
      .toThrow(expect.objectContaining({ reason: 'lifecycle' }))
    expect(() => state.startReconnectAttempt({ fileId, requestId: 'request-3', socketEpoch: 3 })).toThrow('requires the reconnecting state')
  })

  it('rejects an old socket callback and stale generation and fence', () => {
    const state = createCollaborationStateMachine()
    state.open({ fileId, requestId: 'request-1', socketEpoch: 7 })
    state.transition('authorizing')
    state.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 7 })
    state.assignRoom({ requestId: 'request-1', socketEpoch: 7, envelope: envelope(secondGenerationId, '12'), role: 'owner' })

    const staleSocket = () => state.assertCurrentMessage({ requestId: 'request-1', socketEpoch: 6, envelope: envelope(secondGenerationId, '12') })
    const staleGeneration = () => state.assertCurrentMessage({ requestId: 'request-1', socketEpoch: 7, envelope: envelope(firstGenerationId, '12') })
    const staleFence = () => state.assertCurrentMessage({ requestId: 'request-1', socketEpoch: 7, envelope: envelope(secondGenerationId, '11') })

    expect(staleSocket).toThrow(StaleCollaborationMessageError)
    expect(() => staleSocket()).toThrow(expect.objectContaining({ reason: 'socket_epoch' }))
    expect(() => staleGeneration()).toThrow(expect.objectContaining({ reason: 'generation' }))
    expect(() => staleFence()).toThrow(expect.objectContaining({ reason: 'fence' }))
    expect(state.assertCurrentMessage({ requestId: 'request-1', socketEpoch: 7, envelope: envelope(secondGenerationId, '12') })).toBe(true)
  })

  it('rejects room assignment from the wrong request before binding authority', () => {
    const state = createCollaborationStateMachine()
    state.open({ fileId, requestId: 'request-1', socketEpoch: 1 })
    state.transition('authorizing')
    state.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 1 })

    expect(() => state.assignRoom({ requestId: 'request-old', socketEpoch: 1, envelope: envelope(), role: 'owner' }))
      .toThrow(expect.objectContaining({ reason: 'request' }))
    expect(state.getSnapshot().envelope).toBeNull()
  })

  it('allows one room assignment per connection attempt', () => {
    const state = assignedMachine()

    expect(() => state.assignRoom(currentContext)).toThrow('already assigned')
    expect(() => state.assignRoom({ ...currentContext, envelope: envelope(secondGenerationId, '2') })).toThrow('already assigned')
    expect(state.getSnapshot().envelope).toMatchObject({ room: { generationId: firstGenerationId }, fenceToken: '1' })
  })

  it('derives edit mode from the verified room role and blocks role-state mismatch', () => {
    const viewer = createCollaborationStateMachine()
    viewer.open({ fileId, requestId: 'request-viewer', socketEpoch: 1 })
    viewer.transition('authorizing')
    viewer.acceptAdmissionQueued({ requestId: 'request-viewer', socketEpoch: 1 })
    viewer.assignRoom({ requestId: 'request-viewer', socketEpoch: 1, envelope: envelope(), role: 'viewer' })
    viewer.transition('streaming')
    viewer.transition('applying')
    expect(viewer.getSnapshot()).toMatchObject({ role: 'viewer', mode: 'read_only' })
    expect(() => viewer.acceptSyncReady({ requestId: 'request-viewer', socketEpoch: 1, envelope: envelope(), role: 'owner' })).toThrow('role does not match')
    viewer.acceptSyncReady({ requestId: 'request-viewer', socketEpoch: 1, envelope: envelope(), role: 'viewer' })

    const owner = machineAt('applying')
    expect(() => owner.acceptSyncReady({ requestId: 'request-1', socketEpoch: 1, envelope: envelope(), role: 'viewer' })).toThrow('role does not match')
  })

  it('accepts room messages only in explicit active lifecycle states', () => {
    const accepting: readonly ClientLifecycleState[] = ['admission-queued', 'streaming', 'applying', 'live', 'read-only', 'replaying']
    for (const lifecycle of accepting) {
      const state = lifecycle === 'admission-queued' ? assignedMachine() : lifecycle === 'read-only' ? readOnlyMachine() : machineAt(lifecycle)
      expect(state.assertCurrentMessage(currentContext), lifecycle).toBe(true)
    }
  })

  it('rejects room messages in every non-accepting lifecycle state', () => {
    const rejecting: readonly ClientLifecycleState[] = [
      'cold', 'opening', 'authorizing', 'hydrating-local', 'offline-clean', 'offline-dirty', 'reconnecting', 'parked', 'access-revoked',
      'incompatible-build', 'capacity-refused', 'connection-failed', 'draining', 'closing', 'closed',
    ]
    for (const lifecycle of rejecting) {
      const state = machineAt(lifecycle)
      expect(() => state.assertCurrentMessage(currentContext), lifecycle).toThrow(expect.objectContaining({ reason: 'lifecycle' }))
    }
  })

  it('keeps pre-assignment progress request-scoped and rejects room messages before assignment', () => {
    const authorizing = machineAt('authorizing')
    expect(() => authorizing.assertCurrentMessage(currentContext)).toThrow(expect.objectContaining({ reason: 'lifecycle' }))
    expect(() => authorizing.acceptAdmissionQueued({ requestId: 'request-old', socketEpoch: 1 })).toThrow(expect.objectContaining({ reason: 'request' }))
    expect(() => authorizing.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 0 })).toThrow(expect.objectContaining({ reason: 'socket_epoch' }))
    expect(() => authorizing.transition('admission-queued')).toThrow('requires validated request and socket context')
    expect(() => authorizing.assignRoom(currentContext)).toThrow('only be assigned after admission is queued')
    authorizing.acceptAdmissionQueued({ requestId: 'request-1', socketEpoch: 1 })

    const queued = machineAt('admission-queued')
    expect(() => queued.assertCurrentMessage(currentContext)).toThrow(expect.objectContaining({ reason: 'no_active_attempt' }))
    const disposed = assignedMachine()
    disposed.dispose()
    expect(() => disposed.assertCurrentMessage(currentContext)).toThrow(expect.objectContaining({ reason: 'disposed' }))
  })

  it('requires UUID file identity before opening', () => {
    const state = createCollaborationStateMachine()
    expect(() => state.open({ fileId: 'file-1', requestId: 'request-1', socketEpoch: 1 })).toThrow('Invalid file id')
  })

  it('does not let terminal states reconnect', () => {
    const terminal: readonly ClientLifecycleState[] = ['access-revoked', 'incompatible-build', 'capacity-refused', 'connection-failed', 'closing', 'closed']
    for (const lifecycle of terminal) {
      const state = machineAt(lifecycle)
      expect(() => state.transition('reconnecting'), lifecycle).toThrow(`Invalid collaboration state transition from ${lifecycle} to reconnecting.`)
    }
  })
})
