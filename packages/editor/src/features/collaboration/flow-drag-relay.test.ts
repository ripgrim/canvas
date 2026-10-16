import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { FlowDragPresentation, FlowDragTargetTopology } from '@canvas/sync-protocol'
import type { EditorCollaborationRemoteFlowEvent } from '../../capabilities'
import { createEditorFlowTopologyAuthority, createFlowDragRelay } from './flow-drag-relay'
import type { RemoteFlowPresentationKey } from './flow-drag-relay'

const absent = Object.freeze({ presence: 'absent' as const })

const file = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'file-1',
  revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'source-frame': { id: 'source-frame', type: 'frame', name: 'Source', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 200, height: 200 }, layout: { item: { position: { mode: 'absolute' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    'target-frame': { id: 'target-frame', type: 'frame', name: 'Target', styles: { relativeTransform: [1, 0, 0, 1, 300, 0], width: 200, height: 200 }, layout: { item: { position: { mode: 'absolute' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    source: { id: 'source', type: 'frame', name: 'Source child', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 }, layout: { item: { position: { mode: 'flow' } }, container: { display: 'freeform' } } },
  },
  relationships: {
    'source-frame': { parentId: 'root-1', orderKey: 'V' },
    'target-frame': { parentId: 'root-1', orderKey: 'W' },
    source: { parentId: 'source-frame', orderKey: 'V' },
  },
  theme: { tokens: {} },
})

const presentation = (sequence = 1, interactionId = 'interaction-1') => Object.freeze({
  kind: 'flow-drag',
  identity: Object.freeze({ interactionId, gestureGeneration: 3, sampleSequence: sequence }),
  original: Object.freeze({ documentNodeId: 'source' }),
}) as unknown as FlowDragPresentation

const sample = (value: FlowDragPresentation, clientId = 'remote-client', source: 'live' | 'roster' = 'live') => Object.freeze({
  type: 'sample' as const,
  source,
  sample: Object.freeze({
    presenceId: 'remote-presence', clientId, leaseId: 'lease-1', localClaimGeneration: 7,
    reservationGeneration: 2, presentation: value,
  }),
}) as unknown as EditorCollaborationRemoteFlowEvent

const canonicalSample = (value: FlowDragPresentation, owner: Readonly<{ presenceId: string; clientId: string; leaseId: string; localClaimGeneration: number }>) => Object.freeze({
  type: 'sample' as const,
  source: 'live' as const,
  sample: Object.freeze({ ...owner, reservationGeneration: 2, presentation: value }),
}) as unknown as EditorCollaborationRemoteFlowEvent

describe('PAPER-FLEX-006-C3B canonical editor topology authority', () => {
  it('derives the source lane and accepts only canonical flex targets on the bound page', () => {
    const authority = createEditorFlowTopologyAuthority(file(), [], 'page-1')!
    const target = (patch: Partial<FlowDragTargetTopology> = {}): FlowDragTargetTopology => ({ pageId: 'page-1', pageRootId: 'root-1', sourceNodeId: 'source',
      sourceLane: { parentId: 'source-frame', slot: absent }, targetLane: { parentId: 'target-frame', slot: absent }, rawIndex: 0, semanticIndex: 0, line: 0, ...patch })
    expect(authority).toMatchObject({ fileId: 'file-1', fileRevision: 4, pageId: 'page-1', pageRootId: 'root-1' })
    expect(authority.source('source')).toEqual({ kind: 'frame', relationship: { parentId: 'source-frame', orderKey: 'V', slot: absent }, sourceIndex: 0 })
    expect(authority.acceptsTarget(target())).toBe(true)
    expect(authority.acceptsTarget(target({ pageId: 'other-page' }))).toBe(false)
    expect(authority.acceptsTarget(target({ pageRootId: 'wrong-root' }))).toBe(false)
    expect(authority.acceptsTarget(target({ targetLane: { parentId: 'source', slot: absent } }))).toBe(false)
    expect(authority.acceptsTarget(target({ rawIndex: 2, semanticIndex: 2 }))).toBe(false)
    expect(authority.acceptsTarget(target({ targetLane: { parentId: 'root-1', slot: absent }, rawIndex: 2, semanticIndex: 2 }))).toBe(true)
    expect(authority.acceptsTarget(target({ targetLane: { parentId: 'root-1', slot: { presence: 'present', value: 'children' } }, rawIndex: 2, semanticIndex: 2 }))).toBe(false)
    expect(authority.acceptsTarget(target({ targetLane: { parentId: 'root-1', slot: absent }, rawIndex: 3, semanticIndex: 3 }))).toBe(false)
    expect(createEditorFlowTopologyAuthority(file(), [], 'missing-page')).toBeNull()
  })

  it('indexes relationships once so source and target validation never rescan the document', () => {
    const document = file()
    let scans = 0
    document.relationships = new Proxy(document.relationships, { ownKeys: target => { scans += 1; return Reflect.ownKeys(target) } })
    const authority = createEditorFlowTopologyAuthority(document, [], 'page-1')!
    expect(scans).toBeGreaterThan(0)
    scans = 0

    expect(authority.source('source')).not.toBeNull()
    expect(authority.acceptsTarget({ pageId: 'page-1', pageRootId: 'root-1', sourceNodeId: 'source', sourceLane: { parentId: 'source-frame', slot: absent },
      targetLane: { parentId: 'target-frame', slot: absent }, rawIndex: 0, semanticIndex: 0, line: 0 })).toBe(true)
    expect(scans).toBe(0)
  })
})

describe('CLOUD-SYNC-PRESENCE-001-C3B AT-CAN-005-C3B remote canonical flow relay', () => {
  it('fans out the exact presentation for every live and roster sample without owner echo', () => {
    const preview = { publishRemoteFlowDragPresentation: vi.fn((_key: RemoteFlowPresentationKey, _presentation: FlowDragPresentation) => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const hud = { publishFlowDragPresentation: vi.fn((_presentation: FlowDragPresentation) => true), clearFlowDragPresentation: vi.fn(() => true) }
    const relay = createFlowDragRelay(preview, hud)
    const first = presentation(1)
    const second = presentation(2)

    expect(relay.receive(sample(first, 'local-client'), 'local-client')).toBe(false)
    expect(relay.receive(sample(first), 'local-client')).toBe(true)
    expect(relay.receive(sample(second, 'remote-client', 'roster'), 'local-client')).toBe(true)
    expect(preview.publishRemoteFlowDragPresentation.mock.calls.map(call => call[1])).toEqual([first, second])
    expect(hud.publishFlowDragPresentation.mock.calls.map(call => call[0])).toEqual([first, second])
    expect(preview.publishRemoteFlowDragPresentation.mock.calls[1]![1]).toBe(hud.publishFlowDragPresentation.mock.calls[1]![0])
    expect(relay.size()).toBe(1)
  })

  it('keeps an accepted preview publication when the independently owned HUD surface is unavailable', () => {
    const preview = { publishRemoteFlowDragPresentation: vi.fn(() => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const hud = { publishFlowDragPresentation: vi.fn(() => false), clearFlowDragPresentation: vi.fn(() => false) }
    const relay = createFlowDragRelay(preview, hud)
    const value = presentation(1)

    expect(relay.receive(sample(value), 'local-client')).toBe(true)
    expect(preview.clearRemoteFlowDragPresentation).not.toHaveBeenCalled()
    expect(relay.size()).toBe(1)
  })

  it('uses an exact keyed tombstone and clears all remaining remote state on disposal', () => {
    const preview = { publishRemoteFlowDragPresentation: vi.fn(() => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const hud = { publishFlowDragPresentation: vi.fn(() => true), clearFlowDragPresentation: vi.fn(() => true) }
    const relay = createFlowDragRelay(preview, hud)
    const active = presentation(3)
    relay.receive(sample(active), 'local-client')
    const release = Object.freeze({ type: 'released' as const, release: Object.freeze({
      presenceId: 'remote-presence', clientId: 'remote-client', leaseId: 'lease-1', interactionId: 'interaction-1',
      localClaimGeneration: 7, reservationGeneration: 2, terminalSampleSequence: 3, reason: 'committed' as const,
    }) }) as unknown as EditorCollaborationRemoteFlowEvent
    expect(relay.receive(release, 'local-client')).toBe(true)
    expect(preview.clearRemoteFlowDragPresentation).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease-1', localClaimGeneration: 7, reservationGeneration: 2 }), active, 3)
    expect(hud.clearFlowDragPresentation).toHaveBeenCalledWith(active.identity)
    expect(relay.size()).toBe(0)

    relay.receive(sample(presentation(4, 'interaction-2')), 'local-client')
    relay.clearAll()
    expect(preview.clearAllRemoteFlowDragPresentations).toHaveBeenCalledOnce()
    expect(relay.size()).toBe(0)
  })

  it('retains terminal ownership so late samples cannot resurrect a released remote drag', () => {
    const preview = { publishRemoteFlowDragPresentation: vi.fn(() => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const hud = { publishFlowDragPresentation: vi.fn(() => true), clearFlowDragPresentation: vi.fn(() => true) }
    const relay = createFlowDragRelay(preview, hud)
    const active = presentation(5)
    expect(relay.receive(sample(active), 'local-client')).toBe(true)
    const release = Object.freeze({ type: 'released' as const, release: Object.freeze({
      presenceId: 'remote-presence', clientId: 'remote-client', leaseId: 'lease-1', interactionId: 'interaction-1',
      localClaimGeneration: 7, reservationGeneration: 2, terminalSampleSequence: 10, reason: 'committed' as const,
    }) }) as unknown as EditorCollaborationRemoteFlowEvent

    expect(relay.receive(release, 'local-client')).toBe(true)
    expect(relay.hasState()).toBe(true)
    expect(relay.receive(sample(presentation(6)), 'local-client')).toBe(false)
    expect(relay.receive(sample(presentation(11)), 'local-client')).toBe(false)
    expect(preview.publishRemoteFlowDragPresentation).toHaveBeenCalledTimes(1)
    expect(hud.publishFlowDragPresentation).toHaveBeenCalledTimes(1)

    relay.clearAll()
    expect(relay.hasState()).toBe(false)
    expect(relay.receive(sample(presentation(1)), 'local-client')).toBe(true)
  })

  it('retires an older reservation generation before retaining the newer canonical sample', () => {
    const preview = { publishRemoteFlowDragPresentation: vi.fn((_key: RemoteFlowPresentationKey, _presentation: FlowDragPresentation) => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const hud = { publishFlowDragPresentation: vi.fn((_presentation: FlowDragPresentation) => true), clearFlowDragPresentation: vi.fn(() => true) }
    const relay = createFlowDragRelay(preview, hud)
    const first = presentation(1)
    relay.receive(sample(first), 'local-client')
    const nextPresentation = presentation(2)
    const base = sample(nextPresentation) as Extract<EditorCollaborationRemoteFlowEvent, { type: 'sample' }>
    const next = Object.freeze({ ...base, sample: Object.freeze({ ...base.sample, reservationGeneration: 3 }) })

    expect(relay.receive(next, 'local-client')).toBe(true)
    expect(preview.clearRemoteFlowDragPresentation).toHaveBeenCalledWith(expect.objectContaining({ reservationGeneration: 2 }), first, 1)
    expect(relay.size()).toBe(1)
  })

  it('keeps distinct server-canonical lease identities isolated after upstream owner interaction IDs collide', () => {
    const preview = { publishRemoteFlowDragPresentation: vi.fn(() => true), clearRemoteFlowDragPresentation: vi.fn(() => true), clearAllRemoteFlowDragPresentations: vi.fn() }
    const hud = { publishFlowDragPresentation: vi.fn(() => true), clearFlowDragPresentation: vi.fn(() => true) }
    const relay = createFlowDragRelay(preview, hud)
    const first = presentation(1, 'lease:11111111-1111-4111-8111-111111111111')
    const second = presentation(1, 'lease:22222222-2222-4222-8222-222222222222')
    const firstOwner = { presenceId: 'presence-1', clientId: 'client-1', leaseId: '11111111-1111-4111-8111-111111111111', localClaimGeneration: 1 }
    const secondOwner = { presenceId: 'presence-2', clientId: 'client-2', leaseId: '22222222-2222-4222-8222-222222222222', localClaimGeneration: 1 }

    expect(relay.receive(canonicalSample(first, firstOwner), 'local-client')).toBe(true)
    expect(relay.receive(canonicalSample(second, secondOwner), 'local-client')).toBe(true)
    expect(relay.size()).toBe(2)
    const releaseFirst = Object.freeze({ type: 'released' as const, release: Object.freeze({
      ...firstOwner, interactionId: first.identity.interactionId, reservationGeneration: 2, terminalSampleSequence: 1, reason: 'committed' as const,
    }) }) as unknown as EditorCollaborationRemoteFlowEvent
    expect(relay.receive(releaseFirst, 'local-client')).toBe(true)
    expect(preview.clearRemoteFlowDragPresentation).toHaveBeenCalledTimes(1)
    expect(preview.clearRemoteFlowDragPresentation).toHaveBeenCalledWith(expect.objectContaining({ leaseId: firstOwner.leaseId }), first, 1)
    expect(relay.size()).toBe(1)
  })
})
