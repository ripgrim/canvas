import { describe, expect, it } from 'vitest'
import { beginPaperFlowDrag, samplePaperFlowDrag } from './flow-drag-state'
import type { FlowDragTarget, PaperFlowDragState } from './flow-drag-state'
import { projectFlowDragPresentation } from './flow-drag-presentation'
import type { FlowDragPresentationAuthority, FlowDragPresentationContract, FlowDragWorldGeometry } from './flow-drag-presentation'

const fence = { fileId: 'file', fileRevision: 7, measurementRevision: 11, documentRevision: 7, layoutGeneration: 3 } as const
const relationship = { parentId: 'source-parent', orderKey: 'V', slot: { presence: 'absent' as const } } as const
const contract: FlowDragPresentationContract = {
  ghost: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 },
  flowOriginal: { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null },
  elevatedOriginal: { treatment: 'drag-elevated', opacity: 0.6, opacityPriority: 'normal', zIndex: 1000000 },
  unchangedOriginal: { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
  target: { color: 'oklch(0.67 0.17 258)', outlineWidthCssPx: 2, guideWidthCssPx: 4, guideStyle: 'solid' },
  hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
  mobileQuickActions: { mounted: true, hidden: true, inert: true, wonderDurationMs: 150, reducedMotionDurationMs: 0 },
}

const source: FlowDragWorldGeometry = {
  coordinateSpace: 'world',
  quad: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 50 }, { x: 10, y: 50 }],
  aabb: { x: 10, y: 20, width: 40, height: 30 },
  semanticSize: { width: 40, height: 30 },
}

const parentWorld: FlowDragWorldGeometry = {
  coordinateSpace: 'world',
  quad: [{ x: 200, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 250 }, { x: 200, y: 250 }],
  aabb: { x: 200, y: 100, width: 200, height: 150 },
  semanticSize: { width: 200, height: 150 },
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) freeze(Reflect.get(value, key), seen)
  return Object.freeze(value)
}

function freezeWithoutReadingAccessors<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) freezeWithoutReadingAccessors(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function descriptorSnapshot(value: object) {
  return Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    return 'value' in descriptor ? {
      key,
      kind: 'data' as const,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
      writable: descriptor.writable,
      value: structuredClone(descriptor.value),
    } : {
      key,
      kind: 'accessor' as const,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
      get: descriptor.get,
      set: descriptor.set,
    }
  })
}

function translate(geometry: FlowDragWorldGeometry, x: number, y: number): FlowDragWorldGeometry {
  return {
    coordinateSpace: 'world',
    quad: geometry.quad.map(point => ({ x: point.x + x, y: point.y + y })) as unknown as FlowDragWorldGeometry['quad'],
    aabb: { x: geometry.aabb.x + x, y: geometry.aabb.y + y, width: geometry.aabb.width, height: geometry.aabb.height },
    semanticSize: { ...geometry.semanticSize },
  }
}

function target(state: PaperFlowDragState, parentId = 'target-parent', guide = true): FlowDragTarget {
  return freeze({
    parentId, slotPresence: 'absent' as const, slotValue: null, rawIndex: 2, semanticIndex: 2, line: 1,
    guideWorld: guide ? { axis: 'x' as const, position: 240, start: 110, end: 210 } : null,
    fence: { ...state.fence, gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence },
  })
}

function state(options: {
  primary?: boolean
  alt?: boolean
  parentId?: string | null
  sourceParentId?: string
  guide?: boolean
  absoluteClone?: boolean
} = {}): PaperFlowDragState {
  const started = beginPaperFlowDrag({
    nodeId: 'node', pointerDownWorld: { x: 20, y: 25 }, pointerDownViewport: { x: 100, y: 100 }, pointerDownTime: 1_000,
    sourceRelationship: { ...relationship, parentId: options.sourceParentId ?? relationship.parentId },
    sourceIndex: 0, gestureGeneration: 5, selectionDepthPrimary: false, fence,
  })!
  const resolve = (edge: PaperFlowDragState) => options.parentId === null ? null : target(edge, options.parentId, options.guide !== false)
  if (options.absoluteClone) {
    const absolute = samplePaperFlowDrag(started, {
      world: { x: 60, y: 45 }, viewport: { x: 110, y: 105 }, timestamp: 1_100,
      modifiers: { altKey: false, ctrlKey: true, metaKey: false }, platform: 'windows', authority: { ...fence, gestureGeneration: 5, owned: true }, resolveTarget: resolve,
    })!
    return samplePaperFlowDrag(absolute, {
      world: { x: 80, y: 55 }, viewport: { x: 120, y: 110 }, timestamp: 1_120,
      modifiers: { altKey: true, ctrlKey: true, metaKey: false }, platform: 'windows', authority: { ...fence, gestureGeneration: 5, owned: true },
      entryGeometry: { x: 40, y: 30, width: 40, height: 30 }, resolveTarget: resolve,
    })!
  }
  return samplePaperFlowDrag(started, {
    world: { x: 120, y: 75 }, viewport: { x: 110, y: 105 }, timestamp: 1_100,
    modifiers: { altKey: options.alt ?? false, ctrlKey: options.primary ?? false, metaKey: false }, platform: 'windows',
    authority: { ...fence, gestureGeneration: 5, owned: true }, resolveTarget: resolve,
  })!
}

function authority(currentState: PaperFlowDragState, options: {
  terminalReason?: 'pointer-up' | 'escape-after-threshold' | 'pointercancel-after-threshold'
  reducedMotion?: boolean
} = {}): FlowDragPresentationAuthority {
  const delta = { x: currentState.currentWorld.x - currentState.pointerDownWorld.x, y: currentState.currentWorld.y - currentState.pointerDownWorld.y }
  const cloneDelta = currentState.clone ? currentState.clone.entryMode === 'flow' ? { x: 0, y: 0 }
    : { x: currentState.clone.startedAtWorld.x - currentState.pointerDownWorld.x, y: currentState.clone.startedAtWorld.y - currentState.pointerDownWorld.y } : null
  const currentGeometry = translate(source, delta.x, delta.y)
  const publicationIdentity = {
    kind: 'flow-drag-presentation-publication' as const,
    interactionId: 'interaction-9',
    pageId: 'page',
    pageRootId: 'root',
    fence: { ...fence },
    gestureGeneration: currentState.gestureGeneration,
    sampleSequence: currentState.sampleSequence,
  }
  return freeze({
    kind: 'flow-drag-presentation-authority' as const,
    publicationIdentity,
    stateIdentity: currentState,
    interactionId: 'interaction-9', pageId: 'page', pageRootId: 'root', fence: { ...fence },
    gestureGeneration: currentState.gestureGeneration, sampleSequence: currentState.sampleSequence,
    retention: options.terminalReason ? {
      kind: 'terminal-retained' as const,
      gestureGeneration: currentState.gestureGeneration,
      sampleSequence: currentState.sampleSequence,
      terminalReason: options.terminalReason,
      terminalSampleSequence: currentState.sampleSequence,
      holdUntil: 'authoritative-geometry' as const,
    } : { kind: 'active' as const, gestureGeneration: currentState.gestureGeneration, sampleSequence: currentState.sampleSequence },
    reducedMotion: options.reducedMotion ?? false,
    node: {
      id: 'node', documentKind: 'rectangle' as const, sceneKind: 'rectangle' as const, documentName: 'Card', sceneName: 'Card',
      sourceRelationship: structuredClone(currentState.sourceRelationship), sourceIndex: 0, source: structuredClone(source), current: currentGeometry,
      absolutePose: currentState.originalMode === 'absolute' ? {
        offsetParentNodeId: currentState.sourceRelationship.parentId === 'root' ? null : currentState.sourceRelationship.parentId,
        sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0] as const,
        currentParentLocal: [1, 0, 0, 1, currentGeometry.quad[0].x, currentGeometry.quad[0].y] as const,
      } : null,
    },
    clone: currentState.clone ? {
      role: 'inert-marker' as const, layoutParticipation: 'none' as const,
      generation: currentState.clone.generation, sourceRelationship: structuredClone(currentState.clone.sourceRelationship), sourceIndex: 0, entryMode: currentState.clone.entryMode,
      entryRect: currentState.clone.entryGeometry ? { coordinateSpace: 'parent-padding' as const, ...currentState.clone.entryGeometry } : null,
      world: translate(source, cloneDelta!.x, cloneDelta!.y),
    } : null,
    target: currentState.target ? {
      parentId: currentState.target.parentId, parentIsRoot: currentState.target.parentId === 'root', slotPresence: currentState.target.slotPresence,
      slotValue: currentState.target.slotValue, rawIndex: currentState.target.rawIndex, semanticIndex: currentState.target.semanticIndex, line: currentState.target.line,
      parentWorld: currentState.target.parentId === 'root' ? null : structuredClone(parentWorld), guideWorld: structuredClone(currentState.target.guideWorld),
    } : null,
    contract: structuredClone(contract),
  })
}

function project(currentState: PaperFlowDragState, currentAuthority = authority(currentState)) {
  return projectFlowDragPresentation({
    state: currentState,
    authority: currentAuthority,
    publicationIdentity: currentAuthority.publicationIdentity,
  })
}

function revised(base: FlowDragPresentationAuthority, currentState: PaperFlowDragState, change: (draft: FlowDragPresentationAuthority) => void, shouldFreeze = true): FlowDragPresentationAuthority {
  const draft = structuredClone(base)
  ;(draft as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
  change(draft)
  return shouldFreeze ? freeze(draft) : draft
}

describe('PAPER-FLEX-006-PRESENTATION-V8, PAPER-FLEX-007-PRESENTATION-V8, and AT-CAN-005-PRESENTATION-V8 Paper flow drag presentation', () => {
  it('projects the exact flow ghost, dimmed DOM treatment, source name, target outline, guide, and hidden HUD policy', () => {
    const currentState = state()
    const presentation = project(currentState)!
    expect(presentation.kind).toBe('flow-drag')
    expect(presentation.coordinateSpace).toBe('world')
    expect(presentation.identity).toStrictEqual({ interactionId: 'interaction-9', gestureGeneration: 5, sampleSequence: 1 })
    expect(presentation.retention).toStrictEqual({ kind: 'active', gestureGeneration: 5, sampleSequence: 1 })
    expect(presentation.original.sourceOffsetParentPose).toBeNull()
    expect(presentation.supportClone).toBeNull()
    expect(presentation.original.dom).toStrictEqual({ treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null })
    expect(presentation.original.namePresentation).toStrictEqual({ visible: true, anchor: 'source', pose: source })
    expect(presentation.movingVisual).toStrictEqual({
      kind: 'fill-ghost', documentNodeId: null,
      geometry: { coordinateSpace: 'world', quad: [{ x: 110, y: 70 }, { x: 150, y: 70 }, { x: 150, y: 100 }, { x: 110, y: 100 }], aabb: { x: 110, y: 70, width: 40, height: 30 }, semanticSize: { width: 40, height: 30 } },
      fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden',
    })
    expect(presentation.target?.parentOutline).toStrictEqual({ coordinateSpace: 'world', quad: parentWorld.quad, aabb: parentWorld.aabb, color: 'oklch(0.67 0.17 258)', widthCssPx: 2 })
    expect(presentation.target?.insertionGuide).toStrictEqual({ coordinateSpace: 'world', axis: 'x', position: 240, start: 110, end: 210, color: 'oklch(0.67 0.17 258)', widthCssPx: 4, style: 'solid' })
    expect(presentation.hud).toStrictEqual({ showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false })
    expect(presentation.mobileQuickActions).toStrictEqual({ mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } })
  })

  it('elevates an absolute original only over a different non-root parent and moves its name with current geometry', () => {
    const elevatedState = state({ primary: true })
    const elevated = project(elevatedState)!
    expect(elevated.original.dom).toStrictEqual({ treatment: 'drag-elevated', opacity: 0.6, opacityPriority: 'normal', zIndex: 1000000 })
    expect(elevated.original.namePresentation).toStrictEqual({ visible: true, anchor: 'current', pose: translate(source, 100, 50) })
    expect(elevated.original.sourceOffsetParentPose).toStrictEqual({
      coordinateSpace: 'source-offset-parent', offsetParentNodeId: 'source-parent',
      sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [1, 0, 0, 1, 110, 70],
    })
    expect(elevated.movingVisual).toStrictEqual({ kind: 'document-node', documentNodeId: 'node', geometry: elevated.original.current })

    const sameParentState = state({ primary: true, parentId: 'source-parent' })
    const sameParent = project(sameParentState)!
    expect(sameParent.original.dom).toStrictEqual({ treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null })
    expect(sameParent.target?.parentOutline).toBeNull()
    expect(sameParent.original.sourceOffsetParentPose).toStrictEqual({
      coordinateSpace: 'source-offset-parent', offsetParentNodeId: 'source-parent',
      sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [1, 0, 0, 1, 110, 70],
    })

    const rootState = state({ primary: true, parentId: 'root' })
    const root = project(rootState)!
    expect(root.original.dom.treatment).toBe('unchanged')
    expect(root.target?.parentOutline).toBeNull()
    expect(root.original.sourceOffsetParentPose).toStrictEqual({
      coordinateSpace: 'source-offset-parent', offsetParentNodeId: 'source-parent',
      sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [1, 0, 0, 1, 110, 70],
    })

    const rootSourceState = state({ primary: true, sourceParentId: 'root', parentId: 'root' })
    const rootSource = project(rootSourceState)!
    expect(rootSource.original.sourceOffsetParentPose).toStrictEqual({
      coordinateSpace: 'source-offset-parent', offsetParentNodeId: null,
      sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [1, 0, 0, 1, 110, 70],
    })

    const noGuideState = state({ guide: false })
    const noGuide = project(noGuideState)!
    expect(noGuide.target?.insertionGuide).toBeNull()
  })

  it('carries the complete rotated source pose for the source-anchored name', () => {
    const currentState = state()
    const base = authority(currentState)
    const rotatedSource: FlowDragWorldGeometry = {
      coordinateSpace: 'world',
      quad: [{ x: 10, y: 20 }, { x: 10, y: 60 }, { x: -20, y: 60 }, { x: -20, y: 20 }],
      aabb: { x: -20, y: 20, width: 30, height: 40 },
      semanticSize: { width: 40, height: 30 },
    }
    const rotatedAuthority = revised(base, currentState, draft => {
      ;(draft.node as { source: FlowDragWorldGeometry }).source = rotatedSource
      ;(draft.node as { current: FlowDragWorldGeometry }).current = translate(rotatedSource, 100, 50)
    })
    const presentation = project(currentState, rotatedAuthority)!
    expect(presentation.original.namePresentation).toStrictEqual({ visible: true, anchor: 'source', pose: rotatedSource })
    expect(presentation.original.namePresentation.pose.quad).toStrictEqual([
      { x: 10, y: 20 }, { x: 10, y: 60 }, { x: -20, y: 60 }, { x: -20, y: 20 },
    ])
  })

  it('retains authored rotation and reflection in the exact parent-local matrix under a transformed source parent', () => {
    const currentState = state({ primary: true })
    const base = authority(currentState)
    const sourceGeometry: FlowDragWorldGeometry = {
      coordinateSpace: 'world',
      quad: [{ x: -60, y: 170 }, { x: 60, y: 170 }, { x: 60, y: 50 }, { x: -60, y: 50 }],
      aabb: { x: -60, y: 50, width: 120, height: 120 },
      semanticSize: { width: 40, height: 30 },
    }
    const currentGeometry: FlowDragWorldGeometry = {
      coordinateSpace: 'world',
      quad: [{ x: 40, y: 220 }, { x: 160, y: 220 }, { x: 160, y: 100 }, { x: 40, y: 100 }],
      aabb: { x: 40, y: 100, width: 120, height: 120 },
      semanticSize: { width: 40, height: 30 },
    }
    const transformed = revised(base, currentState, draft => {
      ;(draft.node as { source: FlowDragWorldGeometry }).source = sourceGeometry
      ;(draft.node as { current: FlowDragWorldGeometry }).current = currentGeometry
      ;(draft.node as { absolutePose: NonNullable<FlowDragPresentationAuthority['node']['absolutePose']> }).absolutePose = {
        offsetParentNodeId: 'source-parent',
        sourceOffsetParentPaddingToWorld: [0, 2, -3, 0, 100, 200],
        currentParentLocal: [0, -1, -2, 0, 10, 20],
      }
    })
    const before = structuredClone(transformed)
    const presentation = project(currentState, transformed)!
    expect(presentation.original.current).toStrictEqual(currentGeometry)
    expect(presentation.original.sourceOffsetParentPose).toStrictEqual({
      coordinateSpace: 'source-offset-parent',
      offsetParentNodeId: 'source-parent',
      sourceOffsetParentPaddingToWorld: [0, 2, -3, 0, 100, 200],
      matrix: [0, -1, -2, 0, 10, 20],
    })
    expect(Object.keys(presentation.original.sourceOffsetParentPose!)).toStrictEqual([
      'coordinateSpace', 'offsetParentNodeId', 'sourceOffsetParentPaddingToWorld', 'matrix',
    ])
    expect(structuredClone(transformed)).toStrictEqual(before)
    expect(Object.isFrozen(presentation.original.sourceOffsetParentPose)).toBe(true)
    expect(Object.isFrozen(presentation.original.sourceOffsetParentPose!.sourceOffsetParentPaddingToWorld)).toBe(true)
    expect(Object.isFrozen(presentation.original.sourceOffsetParentPose!.matrix)).toBe(true)
  })

  it('accepts an exactly nonsingular proof whose determinant is smaller than a display epsilon', () => {
    const currentState = state({ primary: true })
    const base = authority(currentState)
    const tinyProof = revised(base, currentState, draft => {
      ;(draft.node as { absolutePose: NonNullable<FlowDragPresentationAuthority['node']['absolutePose']> }).absolutePose = {
        offsetParentNodeId: 'source-parent',
        sourceOffsetParentPaddingToWorld: [5.684341886080802e-14, 0, 0, 1, 0, 0],
        currentParentLocal: [17592186044416, 0, 0, 1, 1935140464885760, 70],
      }
    })
    expect(project(currentState, tinyProof)?.original.sourceOffsetParentPose).toStrictEqual({
      coordinateSpace: 'source-offset-parent',
      offsetParentNodeId: 'source-parent',
      sourceOffsetParentPaddingToWorld: [5.684341886080802e-14, 0, 0, 1, 0, 0],
      matrix: [17592186044416, 0, 0, 1, 1935140464885760, 70],
    })
  })

  it('creates an identity-less support clone scoped to interaction, gesture, and clone generation', () => {
    const currentState = state({ alt: true })
    const cloneAuthority = authority(currentState)
    const before = structuredClone(cloneAuthority)
    const presentation = project(currentState, cloneAuthority)!
    expect(presentation.original.dom).toStrictEqual({ treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null })
    expect(presentation.movingVisual).toStrictEqual({ kind: 'document-node', documentNodeId: 'node', geometry: presentation.original.current })
    expect(presentation.supportClone).toStrictEqual({
      key: { kind: 'flow-support-clone', interactionId: 'interaction-9', gestureGeneration: 5, cloneGeneration: 1 },
      documentNodeId: null, role: 'inert-marker', layoutParticipation: 'none', generation: 1,
      sourceRelationship: relationship, sourceIndex: 0, entryMode: 'flow', entry: null, world: source,
      hiddenUntilCommit: true, hitTesting: 'none', a11y: 'hidden',
    })
    expect(typeof presentation.supportClone!.key).toBe('object')
    expect(presentation.supportClone!.documentNodeId).toBeNull()
    expect(Object.keys(presentation.supportClone!)).toStrictEqual([
      'key', 'documentNodeId', 'role', 'layoutParticipation', 'generation', 'sourceRelationship', 'sourceIndex',
      'entryMode', 'entry', 'world', 'hiddenUntilCommit', 'hitTesting', 'a11y',
    ])
    expect(Object.isFrozen(presentation.supportClone)).toBe(true)
    expect(Object.isFrozen(presentation.supportClone!.key)).toBe(true)
    expect(structuredClone(cloneAuthority)).toStrictEqual(before)
  })

  it('rejects wrong literals and hostile keys on support clone authority without evaluating accessors', () => {
    const currentState = state({ alt: true })
    const base = authority(currentState)
    const rejectUnchanged = (candidate: FlowDragPresentationAuthority) => {
      const before = descriptorSnapshot(candidate.clone!)
      expect(project(currentState, candidate)).toBeNull()
      expect(descriptorSnapshot(candidate.clone!)).toStrictEqual(before)
    }

    const wrongRole = revised(base, currentState, draft => {
      ;(draft.clone as { role: string }).role = 'document-node'
    })
    rejectUnchanged(wrongRole)
    const wrongLayout = revised(base, currentState, draft => {
      ;(draft.clone as { layoutParticipation: string }).layoutParticipation = 'flow'
    })
    rejectUnchanged(wrongLayout)
    const missingRole = revised(base, currentState, draft => {
      delete (draft.clone as { role?: string }).role
    })
    rejectUnchanged(missingRole)
    const missingLayout = revised(base, currentState, draft => {
      delete (draft.clone as { layoutParticipation?: string }).layoutParticipation
    })
    rejectUnchanged(missingLayout)

    const extraClone = structuredClone(base)
    ;(extraClone as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(extraClone.clone!, 'extra', { value: true, enumerable: true })
    const frozenExtraClone = freezeWithoutReadingAccessors(extraClone)
    rejectUnchanged(frozenExtraClone)

    const symbolClone = structuredClone(base)
    ;(symbolClone as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(symbolClone.clone!, Symbol('extra'), { value: true, enumerable: true })
    const frozenSymbolClone = freezeWithoutReadingAccessors(symbolClone)
    rejectUnchanged(frozenSymbolClone)

    const hiddenClone = structuredClone(base)
    ;(hiddenClone as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(hiddenClone.clone!, 'extra', { value: true, enumerable: false })
    const frozenHiddenClone = freezeWithoutReadingAccessors(hiddenClone)
    rejectUnchanged(frozenHiddenClone)

    let getterCalls = 0
    const accessorClone = structuredClone(base)
    ;(accessorClone as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(accessorClone.clone!, 'role', {
      get: () => {
        getterCalls += 1
        throw new Error('support clone getter must not run')
      },
      enumerable: true,
    })
    const frozenAccessorClone = freezeWithoutReadingAccessors(accessorClone)
    expect(() => rejectUnchanged(frozenAccessorClone)).not.toThrow()
    expect(Object.getOwnPropertyDescriptor(frozenAccessorClone.clone!, 'role')?.get).toBeTypeOf('function')
    expect(getterCalls).toBe(0)
  })

  it('retains exact absolute clone entry geometry without converting it to document identity', () => {
    const currentState = state({ absoluteClone: true })
    const presentation = project(currentState)!
    expect(presentation.supportClone?.entryMode).toBe('absolute')
    expect(presentation.supportClone?.entry).toStrictEqual({ coordinateSpace: 'parent-padding', x: 40, y: 30, width: 40, height: 30 })
    expect(presentation.supportClone?.world).toStrictEqual({
      coordinateSpace: 'world', quad: [{ x: 70, y: 50 }, { x: 110, y: 50 }, { x: 110, y: 80 }, { x: 70, y: 80 }],
      aabb: { x: 70, y: 50, width: 40, height: 30 }, semanticSize: { width: 40, height: 30 },
    })
    expect(presentation.supportClone?.documentNodeId).toBeNull()
  })

  it('uses exact terminal retention and zero-duration reduced motion', () => {
    const currentState = state()
    for (const terminalReason of ['pointer-up', 'escape-after-threshold', 'pointercancel-after-threshold'] as const) {
      const presentation = project(currentState, authority(currentState, { terminalReason, reducedMotion: true }))!
      expect(presentation.retention).toStrictEqual({
        kind: 'terminal-retained', gestureGeneration: 5, sampleSequence: 1,
        terminalReason, terminalSampleSequence: 1, holdUntil: 'authoritative-geometry',
      })
      expect(presentation.identity).toStrictEqual({ interactionId: 'interaction-9', gestureGeneration: 5, sampleSequence: 1 })
      expect(presentation.mobileQuickActions.transition).toStrictEqual({ property: 'opacity', durationMs: 0, source: 'wonder' })
    }
  })

  it('rejects stale identity, topology, relationship, index, generation, sequence, and copied or mutable authority', () => {
    const currentState = state()
    const base = authority(currentState)
    const reject = (next: FlowDragPresentationAuthority) => expect(project(currentState, next)).toBeNull()
    reject(freeze(structuredClone(base)))
    const copied = structuredClone(base)
    ;(copied as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    expect(projectFlowDragPresentation(freeze({
      state: currentState,
      authority: freeze(copied),
      publicationIdentity: base.publicationIdentity,
    }))).toBeNull()
    reject(revised(base, currentState, () => {}, false))
    reject(revised(base, currentState, draft => { (draft as { pageId: string }).pageId = 'other-page' }))
    reject(revised(base, currentState, draft => { (draft as { pageRootId: string }).pageRootId = 'other-root' }))
    reject(revised(base, currentState, draft => { (draft.fence as { fileId: string }).fileId = 'other-file' }))
    reject(revised(base, currentState, draft => { (draft.fence as { fileRevision: number }).fileRevision += 1 }))
    reject(revised(base, currentState, draft => { (draft.fence as { documentRevision: number }).documentRevision += 1 }))
    reject(revised(base, currentState, draft => { (draft.fence as { measurementRevision: number }).measurementRevision += 1 }))
    reject(revised(base, currentState, draft => { (draft.fence as { layoutGeneration: number }).layoutGeneration += 1 }))
    reject(revised(base, currentState, draft => { (draft.node.sourceRelationship as { orderKey: string }).orderKey = 'W' }))
    reject(revised(base, currentState, draft => { (draft.node.sourceRelationship as { slot: { presence: 'present'; value: string } }).slot = { presence: 'present', value: 'body' } }))
    reject(revised(base, currentState, draft => { (draft.node as { sourceIndex: number }).sourceIndex += 1 }))
    reject(revised(base, currentState, draft => { (draft as { gestureGeneration: number }).gestureGeneration += 1 }))
    reject(revised(base, currentState, draft => { (draft as { sampleSequence: number }).sampleSequence += 1 }))
    reject(revised(base, currentState, draft => { (draft.retention as { sampleSequence: number }).sampleSequence += 1 }))
    reject(revised(base, currentState, draft => { (draft.target as { rawIndex: number }).rawIndex += 1 }))
    reject(revised(base, currentState, draft => { (draft.target as { semanticIndex: number }).semanticIndex += 1 }))
    reject(revised(base, currentState, draft => { (draft.target as { line: number }).line += 1 }))
    reject(revised(base, currentState, draft => {
      const targetAuthority = draft.target as { slotPresence: 'present'; slotValue: string | null }
      targetAuthority.slotPresence = 'present'; targetAuthority.slotValue = 'body'
    }))
    reject(revised(base, currentState, draft => { delete (draft.node as { sceneName?: string }).sceneName }))

    const terminal = authority(currentState, { terminalReason: 'pointer-up' })
    const rejectTerminal = (change: (draft: FlowDragPresentationAuthority) => void) => reject(revised(terminal, currentState, change))
    rejectTerminal(draft => { (draft.retention as { terminalReason: string }).terminalReason = 'blur' })
    rejectTerminal(draft => { (draft.retention as { terminalSampleSequence: number }).terminalSampleSequence += 1 })
    rejectTerminal(draft => { (draft.retention as { holdUntil: string }).holdUntil = 'timer' })

    const cloneState = state({ alt: true })
    const cloneAuthority = authority(cloneState)
    const rejectClone = (change: (draft: FlowDragPresentationAuthority) => void) => {
      expect(project(cloneState, revised(cloneAuthority, cloneState, change))).toBeNull()
    }
    rejectClone(draft => { (draft.clone as { generation: number }).generation += 1 })
    rejectClone(draft => { (draft.clone!.sourceRelationship as { orderKey: string }).orderKey = 'W' })
    rejectClone(draft => { (draft.clone as { sourceIndex: number }).sourceIndex += 1 })

    const staleState = structuredClone(currentState)
    ;(staleState.target!.fence as { sampleSequence: number }).sampleSequence += 1
    const staleStateAuthority = structuredClone(base)
    ;(staleStateAuthority as { stateIdentity: PaperFlowDragState }).stateIdentity = staleState
    const frozenStaleAuthority = freeze(staleStateAuthority)
    expect(projectFlowDragPresentation({
      state: freeze(staleState), authority: frozenStaleAuthority, publicationIdentity: frozenStaleAuthority.publicationIdentity,
    })).toBeNull()
  })

  it('rejects non-finite and mismatched quad, AABB, semantic geometry, and invalid guide authority', () => {
    const currentState = state()
    const base = authority(currentState)
    const reject = (change: (draft: FlowDragPresentationAuthority) => void) => expect(project(currentState, revised(base, currentState, change))).toBeNull()
    reject(draft => { (draft.node.current.quad[0] as { x: number }).x = Number.NaN })
    reject(draft => { (draft.node.current.aabb as { width: number }).width += 1 })
    reject(draft => { (draft.node.current.semanticSize as { width: number }).width += 1 })
    reject(draft => { (draft.node.current.quad[2] as { x: number }).x += 1 })
    reject(draft => { (draft.target!.parentWorld!.aabb as { x: number }).x += 1 })
    reject(draft => { (draft.target!.guideWorld as { end: number }).end = 110 })
  })

  it('rejects missing, stale, singular, non-finite, or world-mismatched absolute pose authority', () => {
    const absoluteState = state({ primary: true })
    const base = authority(absoluteState)
    const reject = (change: (draft: FlowDragPresentationAuthority) => void) => {
      expect(project(absoluteState, revised(base, absoluteState, change))).toBeNull()
    }
    reject(draft => { (draft.node as { absolutePose: null }).absolutePose = null })
    reject(draft => { (draft.node.absolutePose as { offsetParentNodeId: string | null }).offsetParentNodeId = 'other-parent' })
    reject(draft => { (draft.node.absolutePose as { offsetParentNodeId: string | null }).offsetParentNodeId = null })
    reject(draft => { (draft.node.absolutePose!.currentParentLocal as unknown as number[])[0] = Number.NaN })
    reject(draft => { (draft.node.absolutePose!.sourceOffsetParentPaddingToWorld as unknown as number[])[0] = Number.NaN })
    reject(draft => { (draft.node.absolutePose!.currentParentLocal as unknown as number[])[3] = 0 })
    reject(draft => { (draft.node.absolutePose!.sourceOffsetParentPaddingToWorld as unknown as number[])[3] = 0 })
    reject(draft => {
      const matrix = draft.node.absolutePose!.currentParentLocal as unknown as number[]
      matrix[4] = matrix[4]! + 1
    })
    reject(draft => {
      const proof = draft.node.absolutePose!.sourceOffsetParentPaddingToWorld as unknown as number[]
      proof[4] = proof[4]! + 1
    })
    reject(draft => { delete (draft.node.absolutePose as { currentParentLocal?: readonly number[] }).currentParentLocal })

    const rootState = state({ primary: true, sourceParentId: 'root', parentId: 'root' })
    const rootAuthority = authority(rootState)
    expect(project(rootState, revised(rootAuthority, rootState, draft => {
      ;(draft.node.absolutePose as { offsetParentNodeId: string | null }).offsetParentNodeId = 'root'
    }))).toBeNull()

    const flowState = state()
    const flowAuthority = authority(flowState)
    expect(project(flowState, revised(flowAuthority, flowState, draft => {
      ;(draft.node as { absolutePose: NonNullable<FlowDragPresentationAuthority['node']['absolutePose']> }).absolutePose = {
        offsetParentNodeId: 'source-parent',
        sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0],
        currentParentLocal: [1, 0, 0, 1, 110, 70],
      }
    }))).toBeNull()
    expect(project(absoluteState, revised(base, absoluteState, () => {}, false))).toBeNull()
  })

  it('rejects extra and accessor keys inside absolute pose authority without evaluating them', () => {
    const currentState = state({ primary: true })
    const base = authority(currentState)

    const symbolPose = structuredClone(base)
    ;(symbolPose as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(symbolPose.node.absolutePose!, Symbol('extra'), { value: true, enumerable: true })
    const frozenSymbolPose = freezeWithoutReadingAccessors(symbolPose)
    expect(project(currentState, frozenSymbolPose)).toBeNull()

    const hiddenPose = structuredClone(base)
    ;(hiddenPose as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(hiddenPose.node.absolutePose!, 'extra', { value: true, enumerable: false })
    const frozenHiddenPose = freezeWithoutReadingAccessors(hiddenPose)
    expect(project(currentState, frozenHiddenPose)).toBeNull()

    const symbolProof = structuredClone(base)
    ;(symbolProof as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(symbolProof.node.absolutePose!.sourceOffsetParentPaddingToWorld, Symbol('extra'), { value: true, enumerable: true })
    const frozenSymbolProof = freezeWithoutReadingAccessors(symbolProof)
    expect(project(currentState, frozenSymbolProof)).toBeNull()
    expect([...frozenSymbolProof.node.absolutePose!.sourceOffsetParentPaddingToWorld]).toStrictEqual([1, 0, 0, 1, 0, 0])

    const hiddenProof = structuredClone(base)
    ;(hiddenProof as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(hiddenProof.node.absolutePose!.sourceOffsetParentPaddingToWorld, 'extra', { value: true, enumerable: false })
    const frozenHiddenProof = freezeWithoutReadingAccessors(hiddenProof)
    expect(project(currentState, frozenHiddenProof)).toBeNull()
    expect([...frozenHiddenProof.node.absolutePose!.sourceOffsetParentPaddingToWorld]).toStrictEqual([1, 0, 0, 1, 0, 0])

    let getterCalls = 0
    const getterPose = structuredClone(base)
    ;(getterPose as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(getterPose.node.absolutePose!.currentParentLocal, '0', {
      get: () => {
        getterCalls += 1
        throw new Error('matrix getter must not run')
      },
      enumerable: true,
    })
    const frozenGetterPose = freezeWithoutReadingAccessors(getterPose)
    expect(() => project(currentState, frozenGetterPose)).not.toThrow()
    expect(project(currentState, frozenGetterPose)).toBeNull()

    const proofGetter = structuredClone(base)
    ;(proofGetter as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(proofGetter.node.absolutePose!.sourceOffsetParentPaddingToWorld, '0', {
      get: () => {
        getterCalls += 1
        throw new Error('proof getter must not run')
      },
      enumerable: true,
    })
    const frozenProofGetter = freezeWithoutReadingAccessors(proofGetter)
    expect(() => project(currentState, frozenProofGetter)).not.toThrow()
    expect(project(currentState, frozenProofGetter)).toBeNull()
    expect(Object.getOwnPropertyDescriptor(frozenProofGetter.node.absolutePose!.sourceOffsetParentPaddingToWorld, '0')?.get).toBeTypeOf('function')
    expect(getterCalls).toBe(0)
  })

  it('rejects name, fill, target, HUD, and mobile policy drift', () => {
    const currentState = state()
    const base = authority(currentState)
    const reject = (change: (draft: FlowDragPresentationAuthority) => void) => expect(project(currentState, revised(base, currentState, change))).toBeNull()
    reject(draft => { (draft.node as { sceneName: string }).sceneName = 'Other' })
    reject(draft => { (draft.contract.ghost as { color: string }).color = 'oklch(0 0 0)' })
    reject(draft => { (draft.contract.ghost as { alpha: number }).alpha = 0.2 })
    reject(draft => { (draft.contract.target as { guideWidthCssPx: number }).guideWidthCssPx = 2 })
    reject(draft => { (draft.contract.hud as { showDimensions: boolean }).showDimensions = true })
    reject(draft => { (draft.contract.mobileQuickActions as { wonderDurationMs: number }).wonderDurationMs = 200 })
  })

  it('rejects symbol and non-enumerable keys and returns a deeply frozen result without mutating inputs', () => {
    const currentState = state()
    const base = authority(currentState)
    const beforeState = structuredClone(currentState)
    const beforeAuthority = structuredClone(base)
    const presentation = project(currentState, base)!
    expect(currentState).toStrictEqual(beforeState)
    expect(structuredClone(base)).toStrictEqual(beforeAuthority)
    expect(Object.isFrozen(presentation)).toBe(true)
    expect(Object.isFrozen(presentation.original.current.quad[0])).toBe(true)
    expect(Object.isFrozen(presentation.mobileQuickActions.transition)).toBe(true)

    const symbolAuthority = structuredClone(base)
    ;(symbolAuthority as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(symbolAuthority, Symbol('extra'), { value: true, enumerable: true })
    const frozenSymbolAuthority = freeze(symbolAuthority)
    expect(projectFlowDragPresentation(freeze({
      state: currentState, authority: frozenSymbolAuthority, publicationIdentity: frozenSymbolAuthority.publicationIdentity,
    }))).toBeNull()
    const hiddenAuthority = structuredClone(base)
    ;(hiddenAuthority as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(hiddenAuthority.node, 'extra', { value: true, enumerable: false })
    const frozenHiddenAuthority = freeze(hiddenAuthority)
    expect(projectFlowDragPresentation(freeze({
      state: currentState, authority: frozenHiddenAuthority, publicationIdentity: frozenHiddenAuthority.publicationIdentity,
    }))).toBeNull()

    const mutableState = structuredClone(currentState)
    const stateAuthority = structuredClone(base)
    ;(stateAuthority as { stateIdentity: PaperFlowDragState }).stateIdentity = mutableState
    expect(projectFlowDragPresentation({
      state: mutableState, authority: stateAuthority, publicationIdentity: stateAuthority.publicationIdentity,
    })).toBeNull()
    const hiddenState = structuredClone(currentState)
    Object.defineProperty(hiddenState, 'extra', { value: true, enumerable: false })
    const hiddenStateAuthority = structuredClone(base)
    ;(hiddenStateAuthority as { stateIdentity: PaperFlowDragState }).stateIdentity = hiddenState
    const frozenHiddenStateAuthority = freeze(hiddenStateAuthority)
    expect(projectFlowDragPresentation({
      state: freeze(hiddenState), authority: frozenHiddenStateAuthority, publicationIdentity: frozenHiddenStateAuthority.publicationIdentity,
    })).toBeNull()

    const extraInput = { state: currentState, authority: base, publicationIdentity: base.publicationIdentity }
    Object.defineProperty(extraInput, Symbol('extra'), { value: true, enumerable: true })
    expect(projectFlowDragPresentation(extraInput)).toBeNull()
    const hiddenInput = { state: currentState, authority: base, publicationIdentity: base.publicationIdentity }
    Object.defineProperty(hiddenInput, 'extra', { value: true, enumerable: false })
    expect(projectFlowDragPresentation(hiddenInput)).toBeNull()
  })

  it('rejects accessor descriptors without evaluating top-level, nested, or quad getters', () => {
    const currentState = state()
    const base = authority(currentState)
    let getterCalls = 0
    const fail = () => {
      getterCalls += 1
      throw new Error('getter must not run')
    }

    const inputGetter = { state: currentState, authority: base, publicationIdentity: base.publicationIdentity }
    Object.defineProperty(inputGetter, 'state', { get: fail, enumerable: true })
    expect(() => projectFlowDragPresentation(Object.freeze(inputGetter))).not.toThrow()
    expect(projectFlowDragPresentation(Object.freeze(inputGetter))).toBeNull()

    const stateGetter = structuredClone(currentState)
    Object.defineProperty(stateGetter, 'currentWorld', { get: fail, enumerable: true })
    const frozenStateGetter = freezeWithoutReadingAccessors(stateGetter)
    const stateGetterAuthority = structuredClone(base)
    ;(stateGetterAuthority as { stateIdentity: PaperFlowDragState }).stateIdentity = frozenStateGetter
    const frozenStateGetterAuthority = freezeWithoutReadingAccessors(stateGetterAuthority)
    expect(() => projectFlowDragPresentation({
      state: frozenStateGetter,
      authority: frozenStateGetterAuthority,
      publicationIdentity: frozenStateGetterAuthority.publicationIdentity,
    })).not.toThrow()
    expect(projectFlowDragPresentation({
      state: frozenStateGetter,
      authority: frozenStateGetterAuthority,
      publicationIdentity: frozenStateGetterAuthority.publicationIdentity,
    })).toBeNull()

    const authorityGetter = structuredClone(base)
    ;(authorityGetter as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(authorityGetter.node, 'sceneName', { get: fail, enumerable: true })
    const frozenAuthorityGetter = freezeWithoutReadingAccessors(authorityGetter)
    expect(() => projectFlowDragPresentation({
      state: currentState,
      authority: frozenAuthorityGetter,
      publicationIdentity: frozenAuthorityGetter.publicationIdentity,
    })).not.toThrow()
    expect(projectFlowDragPresentation({
      state: currentState,
      authority: frozenAuthorityGetter,
      publicationIdentity: frozenAuthorityGetter.publicationIdentity,
    })).toBeNull()

    const quadGetter = structuredClone(base)
    ;(quadGetter as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(quadGetter.node.source.quad, '0', { get: fail, enumerable: true })
    const frozenQuadGetter = freezeWithoutReadingAccessors(quadGetter)
    expect(() => projectFlowDragPresentation({
      state: currentState,
      authority: frozenQuadGetter,
      publicationIdentity: frozenQuadGetter.publicationIdentity,
    })).not.toThrow()
    expect(projectFlowDragPresentation({
      state: currentState,
      authority: frozenQuadGetter,
      publicationIdentity: frozenQuadGetter.publicationIdentity,
    })).toBeNull()

    const publicationGetter = structuredClone(base)
    ;(publicationGetter as { stateIdentity: PaperFlowDragState }).stateIdentity = currentState
    Object.defineProperty(publicationGetter, 'publicationIdentity', { get: fail, enumerable: true })
    const frozenPublicationGetter = freezeWithoutReadingAccessors(publicationGetter)
    expect(() => projectFlowDragPresentation({
      state: currentState,
      authority: frozenPublicationGetter,
      publicationIdentity: base.publicationIdentity,
    })).not.toThrow()
    expect(projectFlowDragPresentation({
      state: currentState,
      authority: frozenPublicationGetter,
      publicationIdentity: base.publicationIdentity,
    })).toBeNull()
    expect(Object.getOwnPropertyDescriptor(frozenPublicationGetter, 'publicationIdentity')?.get).toBeTypeOf('function')
    expect(getterCalls).toBe(0)
  })
})
