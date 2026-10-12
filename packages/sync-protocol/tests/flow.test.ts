import { describe, expect, it } from 'vitest'
import {
  isFlowDragLane,
  validateFlowDragPresentation,
  validateFlowDragPresentationStructure,
  type FlowDragPresentation,
  type FlowDragPresentationKey,
  type FlowDragSourceFence,
  type FlowDragTopologyAuthority,
} from '../src/flow.js'

const key: FlowDragPresentationKey = { interactionId: 'flow-drag-1', gestureGeneration: 2, sequence: 4 }
const fence: FlowDragSourceFence = {
  fileId: 'file-1', fileRevision: 3, measurementRevision: 8, documentRevision: 3, layoutGeneration: 5,
  pageId: 'page-1', pageRootId: 'page-root-1',
}
const source = {
  coordinateSpace: 'world' as const,
  quad: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }] as const,
  aabb: { x: 0, y: 0, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 },
}
const current = {
  coordinateSpace: 'world' as const,
  quad: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 100 }, { x: 10, y: 100 }] as const,
  aabb: { x: 10, y: 20, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 },
}

function presentation(): FlowDragPresentation {
  return {
    kind: 'flow-drag', coordinateSpace: 'world',
    identity: { interactionId: key.interactionId, gestureGeneration: key.gestureGeneration, sampleSequence: key.sequence },
    fence: { ...fence },
    retention: { kind: 'active', gestureGeneration: key.gestureGeneration, sampleSequence: key.sequence },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
    original: {
      documentNodeId: 'button-1', kind: 'component', name: 'Button',
      sourceRelationship: { parentId: 'card-1', orderKey: 'V', slot: { presence: 'present', value: 'children' } },
      sourceIndex: 0, mode: 'absolute', source, current,
      sourceOffsetParentPose: {
        coordinateSpace: 'source-offset-parent', offsetParentNodeId: 'card-1',
        sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [1, 0, 0, 1, 10, 20],
      },
      dom: { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
      namePresentation: { visible: true, anchor: 'current', pose: current },
    },
    movingVisual: { kind: 'document-node', documentNodeId: 'button-1', geometry: current },
    supportClone: null,
    target: null,
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
  }
}

function authority(overrides: Partial<FlowDragTopologyAuthority> = {}): FlowDragTopologyAuthority {
  return {
    fileId: fence.fileId, fileRevision: fence.fileRevision, pageId: fence.pageId, pageRootId: fence.pageRootId,
    source: nodeId => nodeId === 'button-1' ? {
      kind: 'component', relationship: { parentId: 'card-1', orderKey: 'V', slot: { presence: 'present', value: 'children' } }, sourceIndex: 0,
    } : null,
    acceptsTarget: target => target.targetLane.parentId === 'card-1' && target.targetLane.slot.presence === 'present' && target.targetLane.slot.value === 'children',
    ...overrides,
  }
}

describe('PAPER-FLEX-006-C1, PAPER-FLEX-007-C1, and AT-CAN-005-C1 canonical flow wire', () => {
  it('keeps absent, empty-string, and named slots as distinct exact lane identities', () => {
    expect(isFlowDragLane({ parentId: 'card-1', slot: { presence: 'absent' } })).toBe(true)
    expect(isFlowDragLane({ parentId: 'card-1', slot: { presence: 'present', value: '' } })).toBe(true)
    expect(isFlowDragLane({ parentId: 'card-1', slot: { presence: 'present', value: 'children' } })).toBe(true)
    expect(isFlowDragLane({ parentId: 'card-1', slot: { presence: 'absent', value: '' } })).toBe(false)
  })

  it('accepts one exact peer-renderable presentation without mutation', () => {
    const value = presentation()
    const before = JSON.stringify(value)
    expect(validateFlowDragPresentationStructure(value, key, fence)).toBe(true)
    expect(validateFlowDragPresentation(value, key, fence, authority())).toBe(true)
    expect(JSON.stringify(value)).toBe(before)
  })

  it('separates exact wire structure from trusted topology policy', () => {
    const value = presentation()
    expect(validateFlowDragPresentationStructure(value, key, fence)).toBe(true)
    expect(validateFlowDragPresentation(value, key, fence, authority({ source: () => null }))).toBe(false)
    expect(validateFlowDragPresentation(value, key, fence, authority({ acceptsTarget: () => false }))).toBe(true)
  })

  it('rejects stale identity, source topology, and target policy', () => {
    const stale = structuredClone(presentation())
    ;(stale.identity as { sampleSequence: number }).sampleSequence = 5
    expect(validateFlowDragPresentation(stale, key, fence, authority())).toBe(false)
    expect(validateFlowDragPresentation(presentation(), key, fence, authority({ source: () => ({
      kind: 'component', relationship: { parentId: 'other-parent', orderKey: 'V', slot: { presence: 'present', value: 'children' } }, sourceIndex: 0,
    }) }))).toBe(false)

    const targeted = structuredClone(presentation())
    ;(targeted as { target: FlowDragPresentation['target'] }).target = { parentId: 'card-1', slot: { presence: 'present', value: 'children' }, rawIndex: 1, semanticIndex: 1, line: 0, parentOutline: null, insertionGuide: null }
    expect(validateFlowDragPresentation(targeted, key, fence, authority({ acceptsTarget: () => false }))).toBe(false)
  })

  it('rejects malformed matrices, matrix-to-quad mismatch, and wrong Paper literals', () => {
    const singular = structuredClone(presentation())
    ;(singular.original.sourceOffsetParentPose as unknown as { matrix: number[] }).matrix = [1, 0, 0, 0, 10, 20]
    expect(validateFlowDragPresentation(singular, key, fence, authority())).toBe(false)

    const mismatch = structuredClone(presentation())
    ;(mismatch.original.sourceOffsetParentPose as unknown as { matrix: number[] }).matrix = [1, 0, 0, 1, 11, 20]
    expect(validateFlowDragPresentation(mismatch, key, fence, authority())).toBe(false)

    const color = structuredClone(presentation())
    ;(color.mobileQuickActions.transition as { durationMs: number }).durationMs = 151
    expect(validateFlowDragPresentation(color, key, fence, authority())).toBe(false)
  })

  it('rejects identity-bearing support markers', () => {
    const value = structuredClone(presentation()) as unknown as { supportClone: Record<string, unknown> | null }
    value.supportClone = {
      key: { kind: 'flow-support-clone', interactionId: key.interactionId, gestureGeneration: key.gestureGeneration, cloneGeneration: 1 },
      documentNodeId: 'clone-1', generation: 1,
      sourceRelationship: { parentId: 'card-1', orderKey: 'V', slot: { presence: 'present', value: 'children' } },
      sourceIndex: 0, entryMode: 'flow', entry: null, world: source, hiddenUntilCommit: true,
      role: 'inert-marker', layoutParticipation: 'none', hitTesting: 'none', a11y: 'hidden',
    }
    expect(validateFlowDragPresentation(value, key, fence, authority())).toBe(false)
  })

  it('rejects hidden, symbol, and accessor authority before invoking getters', () => {
    const hidden = structuredClone(presentation())
    Object.defineProperty(hidden.identity, 'hidden', { value: true, enumerable: false })
    expect(validateFlowDragPresentationStructure(hidden, key, fence)).toBe(false)
    expect(validateFlowDragPresentation(hidden, key, fence, authority())).toBe(false)

    const symbolic = structuredClone(presentation())
    Object.defineProperty(symbolic.original, Symbol('authority'), { value: true, enumerable: true })
    expect(validateFlowDragPresentationStructure(symbolic, key, fence)).toBe(false)
    expect(validateFlowDragPresentation(symbolic, key, fence, authority())).toBe(false)

    let reads = 0
    const accessor = structuredClone(presentation())
    Object.defineProperty(accessor.identity, 'interactionId', { enumerable: true, get: () => { reads += 1; return key.interactionId } })
    expect(validateFlowDragPresentationStructure(accessor, key, fence)).toBe(false)
    expect(validateFlowDragPresentation(accessor, key, fence, authority())).toBe(false)
    expect(reads).toBe(0)

    const arrayAccessor = structuredClone(presentation())
    Object.defineProperty(arrayAccessor.original.sourceOffsetParentPose!.matrix, '0', { enumerable: true, get: () => { reads += 1; return 1 } })
    expect(validateFlowDragPresentationStructure(arrayAccessor, key, fence)).toBe(false)
    expect(validateFlowDragPresentation(arrayAccessor, key, fence, authority())).toBe(false)
    expect(reads).toBe(0)

    const prototypeMatrix = structuredClone(presentation())
    Object.setPrototypeOf(prototypeMatrix.original.sourceOffsetParentPose!.matrix, Object.create(Array.prototype, {
      every: { get: () => { reads += 1; throw new Error('prototype getter') } },
    }))
    expect(validateFlowDragPresentationStructure(prototypeMatrix, key, fence)).toBe(false)
    expect(validateFlowDragPresentation(prototypeMatrix, key, fence, authority())).toBe(false)
    expect(reads).toBe(0)

    const prototypeQuad = structuredClone(presentation())
    Object.setPrototypeOf(prototypeQuad.original.current.quad, Object.create(Array.prototype, {
      every: { get: () => { reads += 1; throw new Error('prototype getter') } },
    }))
    expect(validateFlowDragPresentationStructure(prototypeQuad, key, fence)).toBe(false)
    expect(validateFlowDragPresentation(prototypeQuad, key, fence, authority())).toBe(false)
    expect(reads).toBe(0)
  })
})
