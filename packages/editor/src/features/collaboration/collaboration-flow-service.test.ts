import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { FlowDragPresentation, InteractionResultMessage } from '@canvas/sync-protocol'
import type { EditorCollaborationApi, EditorCollaborationFlowClaim, EditorCollaborationRemoteFlowEvent, EditorCollaborationSnapshot } from '../../capabilities'
import type { DocumentState } from '../editor/document-store'
import { documentStore } from '../editor/document-store'
import { createCollaborationService } from './collaboration-service'

const file: FileDocument = {
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'file-1',
  revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' }, source: { id: 'source', type: 'rectangle', name: 'Source', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 } } },
  relationships: { source: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
}

const collaborationSnapshot = (status: EditorCollaborationSnapshot['status'] = 'live', canMutate = status === 'live'): EditorCollaborationSnapshot => ({
  status, localClientId: 'local-client', localProfile: { subjectId: 'local-user', displayName: 'Local', avatarUrl: null, role: canMutate ? 'owner' : 'viewer' },
  canMutate, canManageShare: canMutate, participants: [], agents: [], error: null,
})

function docs() {
  let state = { file, atoms: [], pageId: 'page-1', selection: ['source'], viewport: { x: 0, y: 0, zoom: 1 }, readOnly: false, layoutGeneration: 9 } as unknown as DocumentState
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const api = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    setPage: (pageId: string) => { state = { ...state, pageId }; notify() },
    setViewport: (viewport: DocumentState['viewport']) => { state = { ...state, viewport }; notify() },
    setReadOnly: (readOnly: boolean) => { state = { ...state, readOnly }; notify() },
  } as unknown as typeof documentStore
  return { api, get: () => state, publish: (next: DocumentState) => { state = next; notify() } }
}

const presentation = (sequence: number, terminal = false): FlowDragPresentation => Object.freeze({
  kind: 'flow-drag',
  identity: Object.freeze({ interactionId: 'interaction-1', gestureGeneration: 2, sampleSequence: sequence }),
  fence: Object.freeze({ fileId: 'file-1', fileRevision: 4, documentRevision: 4, layoutGeneration: 9, measurementRevision: 6, pageId: 'page-1', pageRootId: 'root-1' }),
  original: Object.freeze({ documentNodeId: 'source' }),
  retention: terminal
    ? Object.freeze({ kind: 'terminal-retained', gestureGeneration: 2, sampleSequence: sequence, terminalReason: 'pointer-up', terminalSampleSequence: sequence, holdUntil: 'authoritative-geometry' })
    : Object.freeze({ kind: 'active', gestureGeneration: 2, sampleSequence: sequence }),
}) as unknown as FlowDragPresentation

const result = (claim: EditorCollaborationFlowClaim, action: 'acquire' | 'reserve' | 'release', status: 'granted' | 'retained' | 'released' | 'denied', sequence: number, denialCode: InteractionResultMessage['denialCode'] = null): InteractionResultMessage => Object.freeze({
  type: 'interaction.result', pageId: claim.pageId, action, status, interactionId: claim.interactionId,
  leaseId: status === 'denied' ? null : 'lease-1', localClaimGeneration: claim.localClaimGeneration,
  reservationGeneration: 1, sampleSequence: sequence, denialCode,
}) as unknown as InteractionResultMessage

type PendingAcquire = Readonly<{ claim: EditorCollaborationFlowClaim; leaseId?: string; resolve(value: InteractionResultMessage): void }>

function flowApi(initial = collaborationSnapshot()) {
  let current = initial
  let generation = 0
  const baseListeners = new Set<() => void>()
  const resultListeners = new Set<(value: InteractionResultMessage) => void>()
  const remoteListeners = new Set<Parameters<NonNullable<EditorCollaborationApi['subscribeRemoteFlow']>>[0]>()
  const pending: PendingAcquire[] = []
  const releases: Array<Parameters<NonNullable<EditorCollaborationApi['releaseFlow']>>[0]> = []
  const authorities: Array<Parameters<NonNullable<EditorCollaborationApi['updateFlowAuthority']>>[0]> = []
  const api: EditorCollaborationApi = {
    getSnapshot: () => current,
    subscribe: listener => { baseListeners.add(listener); return () => baseListeners.delete(listener) },
    updateAwareness: () => undefined,
    updateFlowAuthority: authority => { authorities.push(authority) },
    getFlowClaims: () => [],
    subscribeInteractionResults: listener => { resultListeners.add(listener); return () => resultListeners.delete(listener) },
    subscribeRemoteFlow: listener => { remoteListeners.add(listener); return () => remoteListeners.delete(listener) },
    acquireFlow: input => {
      const claim = Object.freeze({ pageId: input.presentation.fence.pageId, interactionId: input.presentation.identity.interactionId,
        sourceNodeId: input.presentation.original.documentNodeId, localClaimGeneration: ++generation })
      let resolve!: (value: InteractionResultMessage) => void
      const resultPromise = new Promise<InteractionResultMessage>(settle => { resolve = value => { for (const listener of resultListeners) listener(value); settle(value) } })
      pending.push(Object.freeze({ claim, ...(input.leaseId ? { leaseId: input.leaseId } : {}), resolve }))
      return Object.freeze({ claim, result: resultPromise })
    },
    reserveFlow: input => Promise.resolve(result(input.claim, 'reserve', 'granted', input.presentation.identity.sampleSequence)),
    sampleFlow: () => undefined,
    releaseFlow: input => { releases.push(input); return Promise.resolve(result(input.claim, 'release', 'retained', input.terminalSampleSequence)) },
  }
  return {
    api, pending, releases, authorities,
    publish: (next: EditorCollaborationSnapshot) => { current = next; for (const listener of baseListeners) listener() },
    emitResult: (value: InteractionResultMessage) => { for (const listener of resultListeners) listener(value) },
    emitRemote: (value: EditorCollaborationRemoteFlowEvent) => { for (const listener of remoteListeners) listener(value) },
    listeners: () => ({ base: baseListeners.size, results: resultListeners.size, remote: remoteListeners.size }),
  }
}

const fakeWindow = { document: { hasFocus: () => true }, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Window

describe('CLOUD-SYNC-GESTURE-001-C3B immutable local flow claims', () => {
  it('resolves denial deterministically before or after a pending terminal mark', async () => {
    const documents = docs()
    const transport = flowApi()
    const service = createCollaborationService(documents.api, fakeWindow)
    service.configure(transport.api)
    service.start()

    const first = service.acquireFlow(presentation(1))
    expect(service.markFlowTerminal(first.token, presentation(2, true), 'cancelled')).toBe(true)
    transport.pending[0]!.resolve(result(transport.pending[0]!.claim, 'acquire', 'denied', 1, 'overlap'))
    await expect(first.result).resolves.toEqual({ status: 'denied', code: 'overlap' })
    expect(service.hasFlowClaim(first.token)).toBe(false)
    expect(transport.releases).toHaveLength(0)

    const second = service.acquireFlow(presentation(3))
    transport.pending[1]!.resolve(result(transport.pending[1]!.claim, 'acquire', 'granted', 3))
    await expect(second.result).resolves.toMatchObject({ status: 'granted' })
    expect(service.markFlowTerminal(second.token, presentation(4, true), 'cancelled')).toBe(true)
    await Promise.resolve()
    expect(transport.releases.at(-1)).toMatchObject({ claim: transport.pending[1]!.claim, terminalSampleSequence: 4, reason: 'cancelled' })
    service.stop()
  })

  it('retains a newer compatible claim when an older save settles and when one claim releases', async () => {
    const documents = docs()
    const transport = flowApi()
    const service = createCollaborationService(documents.api, fakeWindow)
    service.configure(transport.api)
    service.start()

    const first = service.acquireFlow(presentation(1))
    transport.pending[0]!.resolve(result(transport.pending[0]!.claim, 'acquire', 'granted', 1))
    await first.result
    expect(service.markFlowTerminal(first.token, presentation(2, true), 'committed')).toBe(true)
    expect(service.flowPersistenceIntent(first.token, [{ type: 'node.rename', nodeId: 'source', name: 'Moved' }])).toMatchObject({ flow: { claim: transport.pending[0]!.claim } })

    const second = service.acquireFlow(presentation(3), first.token)
    expect(transport.pending[1]!.leaseId).toBe('lease-1')
    transport.pending[1]!.resolve(result(transport.pending[1]!.claim, 'acquire', 'granted', 3))
    await second.result
    await expect(service.releaseFlow(first.token, 'committed')).resolves.toMatchObject({ status: 'granted', result: { action: 'release', status: 'retained' } })
    expect(service.hasFlowClaim(first.token)).toBe(false)
    expect(service.hasFlowClaim(second.token)).toBe(true)
    expect(service.sampleFlow(second.token, presentation(4))).toBe(true)
    service.stop()
  })

  it('quarantines a stale room callback and clears claims, waiters, authority, and bridges on switch', async () => {
    const documents = docs()
    const firstTransport = flowApi()
    const secondTransport = flowApi()
    const preview = { publishRemoteFlowDragPresentation: vi.fn(() => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const service = createCollaborationService(documents.api, fakeWindow)
    service.bindRemoteFlowPreview(preview)
    service.configure(firstTransport.api)
    service.start()
    const pending = service.acquireFlow(presentation(1))
    expect(firstTransport.authorities.at(-1)).toMatchObject({ pageId: 'page-1', documentRevision: 4, layoutGeneration: 9 })

    service.configure(secondTransport.api)
    firstTransport.pending[0]!.resolve(result(firstTransport.pending[0]!.claim, 'acquire', 'granted', 1))
    await expect(pending.result).resolves.toEqual({ status: 'denied', code: 'stale_room' })
    expect(service.hasFlowClaim(pending.token)).toBe(false)
    expect(firstTransport.listeners()).toEqual({ base: 0, results: 0, remote: 0 })
    expect(preview.clearAllRemoteFlowDragPresentations).toHaveBeenCalled()

    service.stop()
    expect(secondTransport.authorities.at(-1)).toBeNull()
    expect(secondTransport.listeners()).toEqual({ base: 0, results: 0, remote: 0 })
  })

  it('rejects viewer acquisition while retaining read-only authority for remote flow validation', async () => {
    const documents = docs()
    const transport = flowApi(collaborationSnapshot('read-only', false))
    const service = createCollaborationService(documents.api, fakeWindow)
    service.configure(transport.api)
    service.start()
    const acquire = service.acquireFlow(presentation(1))
    await expect(acquire.result).resolves.toEqual({ status: 'denied', code: 'read_only' })
    expect(transport.pending).toHaveLength(0)
    expect(transport.authorities.at(-1)).toMatchObject({ pageId: 'page-1', documentRevision: 4 })
    expect(transport.listeners().remote).toBe(1)
    service.stop()
  })

  it('keeps result and remote-flow callbacks live after reconnecting invalidates an active claim on the same API', async () => {
    const documents = docs()
    const transport = flowApi()
    const preview = { publishRemoteFlowDragPresentation: vi.fn(() => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const service = createCollaborationService(documents.api, fakeWindow)
    const observedResults: InteractionResultMessage[] = []
    service.bindRemoteFlowPreview(preview)
    service.subscribeFlowResults(value => observedResults.push(value))
    service.configure(transport.api)
    service.start()

    const acquired = service.acquireFlow(presentation(1))
    const claim = transport.pending[0]!.claim
    transport.pending[0]!.resolve(result(claim, 'acquire', 'granted', 1))
    await acquired.result
    transport.publish(collaborationSnapshot('reconnecting', false))
    expect(service.hasFlowClaim(acquired.token)).toBe(false)
    transport.publish(collaborationSnapshot('live', true))

    const reacquired = service.acquireFlow(presentation(2))
    const newClaim = transport.pending[1]!.claim
    const laterResult = result(newClaim, 'acquire', 'granted', 2)
    transport.pending[1]!.resolve(laterResult)
    await expect(reacquired.result).resolves.toMatchObject({ status: 'granted' })
    transport.emitRemote(Object.freeze({ type: 'sample', source: 'roster', sample: Object.freeze({
      pageId: 'page-1', presenceId: 'remote-presence', subjectId: 'remote-subject', clientId: 'remote-client',
      leaseId: 'remote-lease', localClaimGeneration: 4, reservationGeneration: 2, presentation: presentation(2),
    }) }) as EditorCollaborationRemoteFlowEvent)

    expect(transport.listeners()).toEqual({ base: 1, results: 1, remote: 1 })
    expect(observedResults).toContain(laterResult)
    expect(preview.publishRemoteFlowDragPresentation).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'remote-lease' }), presentation(2))
    service.stop()
  })

  it('publishes flow authority only when file, atoms, page, or layout authority changes', () => {
    const documents = docs()
    const transport = flowApi()
    const service = createCollaborationService(documents.api, fakeWindow)
    service.configure(transport.api)
    service.start()
    const initialPublications = transport.authorities.length

    documents.api.setViewport({ x: 10, y: 20, zoom: 2 })
    documents.publish({ ...documents.get(), selection: ['root-1'], transient: {
      kind: 'move', rects: {}, offset: { x: 2, y: 3 }, guides: [], targetFrameId: null, insertion: null,
    } } as unknown as DocumentState)
    expect(transport.authorities).toHaveLength(initialPublications)

    documents.publish({ ...documents.get(), layoutGeneration: 10 } as DocumentState)
    expect(transport.authorities).toHaveLength(initialPublications + 1)
    expect(transport.authorities.at(-1)).toMatchObject({ layoutGeneration: 10 })
    service.stop()
  })
})
