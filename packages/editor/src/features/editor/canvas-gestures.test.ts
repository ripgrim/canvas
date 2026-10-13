import { describe, expect, it, vi } from 'vitest'
import { childrenOf as fileChildren } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createCanvasGestures } from './canvas-gestures'
import type { CanvasInteractionController } from './canvas-gestures'
import { createDocumentStore } from './document-store'
import { createCanvasHudProjectionService } from './canvas-hud-projection-service'
import type { sceneGeometry } from './scene-geometry'
import type { SceneGeometry } from './scene-geometry'
import type { PreviewResizeSample } from './preview-service'
import { cancelActiveGestureAfterCaptureLoss } from './SelectionHud'

const solid = (id: string, hex: string) => ({ id, type: 'solid' as const, color: { kind: 'literal' as const, color: { kind: 'hex' as const, hex } } })
const textStyle = { fontFamily: 'Inter', fontStyle: 'normal' as const, fontWeight: 400, fontSize: 16, lineHeight: { kind: 'normal' as const }, letterSpacing: 0, horizontalAlign: 'left' as const, verticalAlign: 'top' as const, case: 'none' as const, wrap: 'normal' as const, keepWords: false }
const fixture = (): FileDocument => ({
  schemaVersion: 9,
  fileId: 'gesture-file',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 240, height: 180, overflow: 'clip' }, appearance: { fills: [solid('frame-fill', '#685fff')] } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 20, top: 20, width: 160, height: 100 }, appearance: { fills: [solid('child-fill', '#ffffff')] } },
    text: { id: 'text', type: 'text', name: 'Text', text: 'Hello', textStyle, textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } }, styles: { left: 300, top: 0, width: 120, height: 40 } },
    'nested-text': { id: 'nested-text', type: 'text', name: 'Nested text', text: 'Nested', textStyle, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, styles: { left: 10, top: 140, width: 80, height: 20 } },
  },
  relationships: {
    frame: { parentId: 'root-1', orderKey: 'V' },
    child: { parentId: 'frame', orderKey: 'V' },
    'nested-text': { parentId: 'frame', orderKey: 'W' },
    text: { parentId: 'root-1', orderKey: 'W' },
  },
  theme: { tokens: {} },
})

const pointer = (clientX: number, clientY: number, pointerId = 1) => ({ pointerId, clientX, clientY, button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })

const measuredGeometry = (store: ReturnType<typeof createDocumentStore>): SceneGeometry => {
  const state = store.getSnapshot(), file = state.file
  if (!file) return { nodes: {}, revision: 1, documentRevision: null, layoutGeneration: null, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
  const nodes: SceneGeometry['nodes'] = {}
  const position = (id: string): { x: number; y: number } => {
    const node = file.nodes[id], relationship = file.relationships[id]
    if (!node || node.type === 'root' || !relationship) return { x: 0, y: 0 }
    const parent = file.nodes[relationship.parentId]
    const parentPosition = parent?.type === 'root' ? { x: 0, y: 0 } : position(relationship.parentId)
    const styles = node.type === 'component' ? null : node.styles
    return { x: parentPosition.x + (styles?.left ?? 0), y: parentPosition.y + (styles?.top ?? 0) }
  }
  for (const [id, node] of Object.entries(file.nodes)) {
    if (node.type === 'root') continue
    const relationship = file.relationships[id]!, parent = file.nodes[relationship.parentId]!
    const styles = node.type === 'component' ? null : node.styles
    const width = styles?.width ?? 1, height = styles?.height ?? 1, world = position(id)
    const local = parent.type === 'root' ? world : { x: styles?.left ?? 0, y: styles?.top ?? 0 }
    nodes[id] = {
      ...(node.type === 'component' ? { componentId: node.componentId } : { canvasKind: node.type }),
      documentRevision: file.revision, layoutGeneration: state.layoutGeneration,
      rect: { ...world, width, height }, worldAabb: { ...world, width, height },
      offset: { ...local, width, height, origin: { x: width / 2, y: height / 2 } },
      offsetParentNodeId: parent.type === 'root' ? null : parent.id, directChild: true,
      transform: styles?.rotation === 180 ? [-1, 0, 0, -1, 0, 0] : styles?.rotation === 90 ? [0, 1, -1, 0, 0, 0] : [1, 0, 0, 1, 0, 0],
      offsetParentToRoot: [1, 0, 0, 1, 0, 0] as const,
      box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    }
  }
  return { nodes, revision: 1, documentRevision: file.revision, layoutGeneration: state.layoutGeneration, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
}

const setup = (
  interactions?: CanvasInteractionController,
  viewportOrigin = { left: 0, top: 0 },
  geometryFactory?: (store: ReturnType<typeof createDocumentStore>) => typeof sceneGeometry,
  sourceFile = fixture(),
) => {
  const store = createDocumentStore(() => 'unused')
  store.load(sourceFile, [])
  store.setViewportSize({ width: 1000, height: 800 })
  store.select('frame')
  const geometry = geometryFactory?.(store) ?? {
    getSnapshot: () => measuredGeometry(store),
    subscribe: () => () => undefined,
    update: () => undefined,
    clear: () => undefined,
  } as typeof sceneGeometry
  const projections = createCanvasHudProjectionService(store, geometry, { getSnapshot: () => false, subscribe: () => () => undefined })
  projections.start()
  const resizeSamples: PreviewResizeSample[] = []
  const preview = {
    publishResizePresentation: vi.fn((sample: PreviewResizeSample) => { resizeSamples.push(sample); return true }),
    clearResizePresentation: vi.fn(() => true),
    publishRotationPreview: vi.fn(() => true),
    clearRotationPreview: vi.fn(() => true),
    syncCommittedDocument: vi.fn(() => null),
  }
  const gestures = createCanvasGestures(store, geometry, interactions, projections, preview)
  gestures.attach({ getBoundingClientRect: () => viewportOrigin } as HTMLElement)
  return { store, geometry, projections, gestures, preview, resizeSamples }
}

describe('CLOUD-SYNC-GESTURE-001 live collaboration gestures', () => {
  it('streams each pointer sample and releases one semantic commit at pointer up', () => {
    const transforms: unknown[] = []
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn((_interactionId, next) => { transforms.push(next); return true }),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerMove(pointer(562, 450))
    expect(interactions.beginInteraction).toHaveBeenCalledWith('move', ['frame', 'child', 'nested-text'])
    expect(transforms).toEqual([
      [{ nodeId: 'frame', dx: 10, dy: 0 }],
      [{ nodeId: 'frame', dx: 12, dy: 0 }],
    ])
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    gestures.pointerUp(pointer(562, 450))
    expect(primitivePosition(store, 'frame')).toEqual({ left: 12, top: 0 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('keeps the interaction lock until the semantic save is acknowledged', async () => {
    let acknowledge: ((file: FileDocument) => void) | undefined
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    store.configure({ persist: next => new Promise(resolve => { acknowledge = () => resolve({ ...next, revision: next.revision + 1 }) }) })

    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))

    expect(store.getSnapshot().transient).toBeNull()
    expect(interactions.endInteraction).not.toHaveBeenCalled()
    expect(acknowledge).toBeTypeOf('function')

    acknowledge!(fixture())
    await store.waitForPersistence()
    await Promise.resolve()

    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('releases the exact interaction lease once when semantic persistence fails', async () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-failed-save'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    store.configure({ persist: async () => { throw new Error('save failed') } })

    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))
    expect(interactions.endInteraction).not.toHaveBeenCalled()

    await store.waitForPersistence()
    await Promise.resolve()

    expect(interactions.endInteraction).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledWith('interaction-failed-save')
  })

  it('keeps a gesture lease when an older queued save fails, then releases it after its own save succeeds', async () => {
    let rejectOlder: (error: Error) => void = () => undefined
    let writes = 0
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-after-older-save'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    store.configure({
      persist: next => {
        writes += 1
        if (writes === 1) return new Promise((_resolve, reject) => { rejectOlder = reject })
        return Promise.resolve({ ...next, revision: next.revision + 1 })
      },
    })
    expect(store.commands.setStyles('child', { left: 21 })).toBe(true)

    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))
    rejectOlder(new Error('older save failed'))

    await store.waitForPersistence()
    await Promise.resolve()
    expect(interactions.endInteraction).not.toHaveBeenCalled()

    store.retryPersistence()
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    await Promise.resolve()

    expect(interactions.endInteraction).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledWith('interaction-after-older-save')
  })

  it('AT-CAN-005 commits a drag after its first threshold-crossing sample', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))

    expect(primitivePosition(store, 'frame')).toEqual({ left: 10, top: 0 })
    expect(interactions.updateInteraction).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('AT-CAN-006 publishes one phase marker and one shared projected sample per accepted frame, then commits the terminal sample once', () => {
    const publicationOrder: string[] = []
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'resize-claim'),
      updateInteraction: vi.fn(() => { publicationOrder.push('collaboration'); return true }),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures, projections, preview, resizeSamples } = setup(interactions)
    const publishHud = projections.publishResizePresentation.bind(projections)
    const hudPublication = vi.spyOn(projections, 'publishResizePresentation').mockImplementation((presentation, fence) => {
      publicationOrder.push('hud')
      return publishHud(presentation, fence)
    })
    preview.publishResizePresentation.mockImplementation(sample => {
      publicationOrder.push('preview')
      resizeSamples.push(sample)
      return true
    })
    const transientWrites = vi.spyOn(store, 'setTransient')
    const commitGesture = vi.spyOn(store.commands, 'commitGesture')

    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(true)
    expect(interactions.beginInteraction).toHaveBeenCalledWith('resize', ['frame', 'child', 'nested-text'])
    gestures.pointerMove(pointer(760, 490))
    gestures.pointerMove(pointer(761, 490))
    gestures.pointerMove(pointer(762, 490))

    expect(store.getSnapshot().transient).toEqual({ kind: 'resize', interactionId: resizeSamples[0]!.interactionId })
    expect(transientWrites.mock.calls.filter(([value]) => value?.kind === 'resize')).toHaveLength(1)
    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 240, height: 180 })
    expect(resizeSamples.map(value => value.presentation.byNodeId.frame?.rect.width)).toEqual([260, 261, 262])
    expect(projections.getSnapshot().frame?.byNodeId.frame?.dimensions).toEqual({ width: 262, height: 180 })
    expect(interactions.updateInteraction).toHaveBeenCalledTimes(3)
    expect(preview.publishResizePresentation).toHaveBeenCalledTimes(3)
    expect(publicationOrder).toEqual(['collaboration', 'hud', 'preview', 'collaboration', 'hud', 'preview', 'collaboration', 'hud', 'preview'])
    expect(hudPublication.mock.calls[0]?.[0]).toBe(preview.publishResizePresentation.mock.calls[0]?.[0].presentation)
    expect(hudPublication.mock.calls[0]?.[1]).toBe(preview.publishResizePresentation.mock.calls[0]?.[0].start)

    gestures.pointerUp(pointer(763, 490))

    expect(resizeSamples.at(-1)?.presentation.byNodeId.frame?.rect).toEqual({ x: 0, y: 0, width: 263, height: 180 })
    expect(commitGesture).toHaveBeenCalledOnce()
    expect(commitGesture.mock.calls[0]?.[1]).toEqual([expect.objectContaining({
      kind: 'resize',
      nodeId: 'frame',
      sample: expect.objectContaining({ coordinateSpace: 'parent-padding', rect: { x: 0, y: 0, width: 263, height: 180 } }),
    })])
    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 263, height: 180 })
    expect(store.getSnapshot().transient).toBeNull()
    expect(transientWrites.mock.calls.filter(([value]) => value === null)).toHaveLength(1)
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('PAPER-FLEX-006 keeps Space, Shift, Alt, and primary content lock in the pure parent-padding sample', () => {
    const { store, gestures, resizeSamples } = setup()
    expect(store.commands.setStyles('frame', { width: 100, height: 50 })).toBe(true)

    gestures.handlePointerDown(pointer(600, 425), 'frame', 'right')
    gestures.pointerMove(pointer(620, 425))
    expect(resizeSamples.at(-1)?.presentation.byNodeId.frame?.rect).toEqual({ x: 0, y: 0, width: 120, height: 50 })

    store.setSpaceHeld(true)
    gestures.pointerMove({ ...pointer(650, 435), altKey: true })
    expect(resizeSamples.at(-1)?.presentation.byNodeId.frame?.rect).toEqual({ x: 30, y: 10, width: 120, height: 50 })

    store.setSpaceHeld(false)
    gestures.pointerMove({ ...pointer(660, 435), shiftKey: true, altKey: true, ctrlKey: true })
    const final = resizeSamples.at(-1)!
    expect(final.presentation.contentLocked).toBe(true)
    expect(final.presentation.affectedAxes).toEqual(['x'])
    expect(final.presentation.byNodeId.frame?.rect).toEqual({ x: 30, y: 10, width: 120, height: 50 })
  })

  it('AT-CAN-006 samples pointer-up coordinates even when they are one pixel newer than the last move', () => {
    const { store, gestures, resizeSamples } = setup()
    gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    gestures.pointerMove(pointer(760, 490))
    gestures.pointerUp(pointer(761, 490))
    expect(resizeSamples.map(value => value.presentation.byNodeId.frame?.rect.width)).toEqual([260, 261])
    expect(primitiveRect(store, 'frame').width).toBe(261)
  })

  it('AT-CAN-006 commits the terminal pointer-up sample even when no pointer-move event was delivered', () => {
    const { store, gestures, resizeSamples } = setup()
    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(true)
    gestures.pointerUp({ ...pointer(760, 490), altKey: true, metaKey: true })

    expect(resizeSamples).toHaveLength(1)
    expect(resizeSamples[0]?.presentation).toMatchObject({
      contentLocked: true,
      affectedAxes: ['x'],
      effectiveHandle: 'right',
      byNodeId: { frame: { rect: { x: -20, y: 0, width: 280, height: 180 } } },
    })
    expect(primitiveRect(store, 'frame')).toEqual({ left: -20, top: 0, width: 280, height: 180 })
  })

  it('AT-CAN-006 starts the next drag against fresh geometry while the old save remains unresolved and claim counting keeps the new lease', async () => {
    let settleFirst: ((value: FileDocument) => void) | undefined
    let claimCount = 0
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => { claimCount += 1; return 'shared-resize-lease' }),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(() => { claimCount -= 1 }),
    }
    let publishGeometry: (() => void) | undefined
    let refreshGeometry: (() => void) | undefined
    const { store, gestures, preview } = setup(interactions, { left: 0, top: 0 }, currentStore => {
      let current = measuredGeometry(currentStore)
      const listeners = new Set<() => void>()
      publishGeometry = () => { for (const listener of listeners) listener() }
      refreshGeometry = () => { current = measuredGeometry(currentStore) }
      return {
        getSnapshot: () => current,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        update: () => undefined,
        clear: () => undefined,
      } as typeof sceneGeometry
    })
    store.configure({
      persist: next => new Promise(resolve => { settleFirst = resolve; }),
    })

    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(true)
    gestures.pointerMove(pointer(760, 490))
    gestures.pointerUp(pointer(760, 490))
    expect(claimCount).toBe(1)
    expect(primitiveRect(store, 'frame').width).toBe(260)

    expect(gestures.handlePointerDown(pointer(760, 490), 'frame', 'right')).toBe(true)
    expect(claimCount).toBe(2)
    gestures.pointerMove(pointer(780, 490))
    const beforeFreshGeometry = preview.publishResizePresentation.mock.calls.length
    expect(beforeFreshGeometry).toBe(2)

    refreshGeometry!()
    publishGeometry!()
    expect(preview.publishResizePresentation.mock.calls.length).toBe(beforeFreshGeometry + 1)
    expect(preview.publishResizePresentation.mock.calls.at(-1)?.[0].presentation.byNodeId.frame?.rect.width).toBe(280)

    const firstSaved = structuredClone(store.getSnapshot().file!)
    settleFirst!(firstSaved)
    await store.waitForPersistence()
    await Promise.resolve()
    expect(claimCount).toBe(1)
    expect(gestures.active).toBe(true)

    gestures.pointerCancel(pointer(780, 490))
    expect(claimCount).toBe(0)
    expect(interactions.endInteraction).toHaveBeenCalledTimes(2)
  })

  it('AT-CAN-005 cancels a moved pending resize when a remote lock arrives before fresh geometry', () => {
    let locked = false
    const listeners = new Set<() => void>()
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'pending-lock-claim'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      isNodeLocked: nodeId => locked && nodeId === 'child',
    }
    const { store, gestures, preview } = setup(interactions, { left: 0, top: 0 }, currentStore => {
      const current = measuredGeometry(currentStore)
      return { getSnapshot: () => current, subscribe: () => () => undefined, update: () => undefined, clear: () => undefined } as typeof sceneGeometry
    })
    expect(store.commands.setStyles('frame', { width: 260 })).toBe(true)
    const historyBefore = store.getHistory().past.length

    expect(gestures.handlePointerDown(pointer(760, 490), 'frame', 'right')).toBe(true)
    gestures.pointerMove(pointer(780, 490))
    expect(gestures.active).toBe(true)
    locked = true
    for (const listener of listeners) listener()

    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(preview.clearResizePresentation).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledWith('pending-lock-claim')
    expect(store.getHistory().past).toHaveLength(historyBefore)
  })

  it('AT-CAN-005 cancels pending resize on pointer-up and later geometry cannot resurrect it', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'pending-up-claim'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    let publishGeometry: (() => void) | undefined
    let refreshGeometry: (() => void) | undefined
    const { store, gestures, preview } = setup(interactions, { left: 0, top: 0 }, currentStore => {
      let current = measuredGeometry(currentStore)
      const listeners = new Set<() => void>()
      publishGeometry = () => { for (const listener of listeners) listener() }
      refreshGeometry = () => { current = measuredGeometry(currentStore) }
      return {
        getSnapshot: () => current,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        update: () => undefined,
        clear: () => undefined,
      } as typeof sceneGeometry
    })
    expect(store.commands.setStyles('frame', { width: 260 })).toBe(true)
    const historyBefore = store.getHistory().past.length
    const persist = vi.fn()
    store.configure({ persist })
    const commitGesture = vi.spyOn(store.commands, 'commitGesture')

    expect(gestures.handlePointerDown(pointer(760, 490), 'frame', 'right')).toBe(true)
    gestures.pointerMove(pointer(780, 490))
    expect(gestures.active).toBe(true)
    gestures.pointerUp(pointer(780, 490))

    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(preview.clearResizePresentation).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledWith('pending-up-claim')
    expect(commitGesture).not.toHaveBeenCalled()
    expect(store.getHistory().past).toHaveLength(historyBefore)
    expect(persist).not.toHaveBeenCalled()

    refreshGeometry!()
    publishGeometry!()
    expect(preview.publishResizePresentation).not.toHaveBeenCalled()
    expect(commitGesture).not.toHaveBeenCalled()
  })

  it('AT-CAN-005 cancels active and pending resize synchronously when the local claim disappears', () => {
    let owned = true
    let subscribers = new Set<() => void>()
    const interactions = (): CanvasInteractionController => ({
      beginInteraction: vi.fn(() => 'owned-claim'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
      hasInteraction: id => owned && id === 'owned-claim',
      subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener) },
    })

    const activeSetup = setup(interactions())
    activeSetup.gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    activeSetup.gestures.pointerMove(pointer(760, 490))
    owned = false
    for (const subscriber of subscribers) subscriber()
    expect(activeSetup.gestures.active).toBe(false)
    expect(activeSetup.store.getSnapshot().transient).toBeNull()
    expect(activeSetup.preview.clearResizePresentation).toHaveBeenCalledOnce()

    owned = true
    subscribers = new Set()
    const pendingSetup = setup(interactions(), { left: 0, top: 0 }, currentStore => {
      const current = measuredGeometry(currentStore)
      return { getSnapshot: () => current, subscribe: () => () => undefined, update: () => undefined, clear: () => undefined } as typeof sceneGeometry
    })
    expect(pendingSetup.store.commands.setStyles('frame', { width: 260 })).toBe(true)
    pendingSetup.gestures.handlePointerDown(pointer(760, 490), 'frame', 'right')
    pendingSetup.gestures.pointerMove(pointer(780, 490))
    owned = false
    for (const subscriber of subscribers) subscriber()
    expect(pendingSetup.gestures.active).toBe(false)
    expect(pendingSetup.store.getSnapshot().transient).toBeNull()
    expect(pendingSetup.preview.clearResizePresentation).toHaveBeenCalledOnce()
  })

  it('AT-CAN-005 cancels resize with no semantic history or persistence and clears all three publications', () => {
    const { store, gestures, projections, preview } = setup()
    const before = store.getHistory().past.length
    gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    gestures.pointerMove(pointer(760, 490))
    expect(store.getSnapshot().transient?.kind).toBe('resize')
    gestures.pointerCancel(pointer(760, 490))
    expect(store.getSnapshot().transient).toBeNull()
    expect(store.getHistory().past).toHaveLength(before)
    expect(primitiveRect(store, 'frame').width).toBe(240)
    expect(preview.clearResizePresentation).toHaveBeenCalled()
    expect(projections.getSnapshot().frame?.byNodeId.frame?.dimensions).toEqual({ width: 240, height: 180 })
  })

  it('AT-CAN-005 treats unexpected pointer-capture loss as cancellation with zero commit', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'lost-capture-claim'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures, projections, preview } = setup(interactions)
    const commitGesture = vi.spyOn(store.commands, 'commitGesture')
    const historyBefore = store.getHistory().past.length

    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(true)
    gestures.pointerMove(pointer(760, 490))
    expect(gestures.active).toBe(true)
    expect(store.getSnapshot().transient?.kind).toBe('resize')

    cancelActiveGestureAfterCaptureLoss(gestures)

    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(preview.clearResizePresentation).toHaveBeenCalledOnce()
    expect(projections.getSnapshot().frame?.byNodeId.frame?.dimensions).toEqual({ width: 240, height: 180 })
    expect(interactions.endInteraction).toHaveBeenCalledWith('lost-capture-claim')
    expect(commitGesture).not.toHaveBeenCalled()
    expect(store.getHistory().past).toHaveLength(historyBefore)
  })

  it('AT-CAN-006 ignores the capture-loss event caused by normal pointer-up release', () => {
    const { gestures } = setup()
    const cancelGesture = vi.spyOn(gestures, 'cancel')

    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(true)
    gestures.pointerMove(pointer(760, 490))
    gestures.pointerUp(pointer(760, 490))
    expect(gestures.active).toBe(false)

    cancelActiveGestureAfterCaptureLoss(gestures)
    expect(cancelGesture).not.toHaveBeenCalled()
  })

  it('AT-CAN-005 cancels atomically when either synchronous presentation publication fails', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'resize-publication'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures, preview, projections } = setup(interactions)
    const history = store.getHistory().past.length
    preview.publishResizePresentation.mockImplementationOnce(() => { throw new Error('preview disconnected') })

    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(true)
    expect(() => gestures.pointerMove(pointer(760, 490))).not.toThrow()
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(store.getHistory().past).toHaveLength(history)
    expect(primitiveRect(store, 'frame').width).toBe(240)
    expect(projections.getSnapshot().frame?.byNodeId.frame?.dimensions).toEqual({ width: 240, height: 180 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('AT-CAN-005 cancels an active resize when a remote lock arrives for the selected subtree', () => {
    let locked = false
    const listeners = new Set<() => void>()
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'resize-remote-lock'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      isNodeLocked: id => locked && id === 'child',
    }
    const { store, gestures } = setup(interactions)
    const history = store.getHistory().past.length
    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(true)
    gestures.pointerMove(pointer(760, 490))
    locked = true
    for (const listener of listeners) listener()

    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(store.getHistory().past).toHaveLength(history)
    expect(primitiveRect(store, 'frame').width).toBe(240)
    expect(interactions.endInteraction).toHaveBeenCalledWith('resize-remote-lock')
  })

  it('AT-CAN-005 refuses resize authority for read-only, locally locked, and text-editing states', () => {
    const { store, gestures } = setup()
    store.setReadOnly(true)
    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(false)

    store.setReadOnly(false)
    expect(store.commands.setLocked('frame', true)).toBe(true)
    expect(gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')).toBe(false)

    expect(store.commands.setLocked('frame', false)).toBe(true)
    store.select('text')
    expect(store.commands.text.begin('text')).not.toBeNull()
    expect(gestures.handlePointerDown(pointer(920, 420), 'text', 'right')).toBe(false)
    expect(gestures.active).toBe(false)
  })

  it('AT-CAN-006 uses local axes for 180-degree resize while preserving the visual handle identity', () => {
    const { store, gestures, resizeSamples } = setup()
    expect(store.commands.setStyles('text', { rotation: 180 })).toBe(true)
    store.select('text')
    expect(gestures.handlePointerDown(pointer(800, 400), 'text', 'top-left')).toBe(true)
    gestures.pointerMove(pointer(810, 420))
    const final = resizeSamples.at(-1)?.presentation
    expect(final?.effectiveHandle).toBe('top-left')
    expect(final?.byNodeId.text?.rect).toEqual({ x: 300, y: 0, width: 130, height: 60 })
  })

  it('AT-CAN-007 rotates from a corner preview and commits one semantic angle on release', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'rotation-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures, preview } = setup(interactions)
    const before = store.getHistory().past.length

    expect(gestures.rotationPointerDown(pointer(740, 400), 'frame', 'top-right')).toBe(true)
    gestures.pointerMove(pointer(710, 610))

    expect(preview.publishRotationPreview).toHaveBeenLastCalledWith('frame', 90)
    expect((store.getSnapshot().file?.nodes.frame as { styles?: { rotation?: number } }).styles?.rotation).toBeUndefined()

    gestures.pointerUp(pointer(710, 610))

    expect((store.getSnapshot().file?.nodes.frame as { styles?: { rotation?: number } }).styles?.rotation).toBe(90)
    expect(store.getHistory().past).toHaveLength(before + 1)
    expect(preview.clearRotationPreview).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledWith('rotation-1')
  })

  it('PAPER-TEXT-006 commits exact resize presentation and text sizing as one history leaf', () => {
    const { store, gestures, resizeSamples } = setup()
    store.select('text')
    const before = store.getHistory().past.length
    gestures.handlePointerDown(pointer(920, 420), 'text', 'right')
    gestures.pointerMove(pointer(960.5, 420))
    expect(resizeSamples.at(-1)?.presentation.byNodeId.text?.rect).toEqual({ x: 300, y: 0, width: 160.5, height: 40 })
    gestures.pointerUp(pointer(960.5, 420))
    expect(store.getSnapshot().file?.nodes.text).toMatchObject({
      styles: { left: 300, top: 0, width: 160.5, height: 40 },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } },
    })
    expect(store.getHistory().past).toHaveLength(before + 1)
    expect(store.getHistory().past.at(-1)?.redo.type).toBe('node.resizePresentation')
  })

  it('PAPER-TEXT-006 changes handle axes to Fit or eligible nested Fill without producing a root validation error', () => {
    const { store, gestures } = setup()

    expect(gestures.handleDoubleClick('nested-text', 'right', false)).toBe(true)
    expect(store.getSnapshot().file?.nodes['nested-text']).toMatchObject({ textSizing: { width: { mode: 'fit' }, height: { mode: 'fixed' } } })
    expect(gestures.handleDoubleClick('text', 'bottom-right', true)).toBe(false)
    expect(gestures.handleDoubleClick('nested-text', 'bottom-right', true)).toBe(true)
    expect(store.getSnapshot().file?.nodes['nested-text']).toMatchObject({ textSizing: { width: { mode: 'fill' }, height: { mode: 'fill' } } })
  })

  it('AT-CAN-005 releases the transient preview and interaction when a semantic commit throws', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    vi.spyOn(store.commands, 'commitMove').mockImplementation(() => { throw new Error('commit failed') })
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))

    expect(() => gestures.pointerUp(pointer(560, 450))).toThrow('commit failed')
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('AT-CAN-005 releases the terminal resize hold and claim when semantic resize commit throws', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'resize-commit-throws'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures, preview, projections } = setup(interactions)
    vi.spyOn(store.commands, 'commitGesture').mockImplementation(() => { throw new Error('resize commit failed') })
    gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    gestures.pointerMove(pointer(760, 490))

    expect(() => gestures.pointerUp(pointer(760, 490))).toThrow('resize commit failed')
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(preview.clearResizePresentation).toHaveBeenCalled()
    expect(projections.getSnapshot().frame?.byNodeId.frame?.dimensions).toEqual({ width: 240, height: 180 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('does not start or commit a drag when another collaborator owns the node', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => null),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => false),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    expect(interactions.updateInteraction).not.toHaveBeenCalled()
  })

  it('keeps the exact resize preview until room ownership is confirmed after pointer up', async () => {
    let grant: ((allowed: boolean) => void) | undefined
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => false),
      waitForCommitInteraction: vi.fn(() => new Promise<boolean>(resolve => { grant = resolve })),
      endInteraction: vi.fn(),
    }
    const { store, gestures, projections } = setup(interactions)
    gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    gestures.pointerMove(pointer(594, 490))
    expect(store.getSnapshot().transient?.kind).toBe('resize')
    expect(projections.getSnapshot().frame?.byNodeId.frame?.dimensions).toEqual({ width: 94, height: 180 })

    gestures.pointerUp(pointer(594, 490))
    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 240, height: 180 })
    expect(store.getSnapshot().transient?.kind).toBe('resize')
    expect(projections.getSnapshot().frame?.byNodeId.frame?.dimensions).toEqual({ width: 94, height: 180 })
    expect(interactions.endInteraction).not.toHaveBeenCalled()

    grant!(true)
    await vi.waitFor(() => expect(store.getSnapshot().transient).toBeNull())

    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 94, height: 180 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('discards a held preview when the room denies ownership', async () => {
    let deny: ((allowed: boolean) => void) | undefined
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-denied'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => false),
      waitForCommitInteraction: vi.fn(() => new Promise<boolean>(resolve => { deny = resolve })),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    gestures.pointerMove(pointer(594, 490))
    gestures.pointerUp(pointer(594, 490))

    deny!(false)
    await vi.waitFor(() => expect(store.getSnapshot().transient).toBeNull())

    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 240, height: 180 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })
})

const primitivePosition = (store: ReturnType<typeof createDocumentStore>, id: 'frame' | 'child') => {
  const node = store.getSnapshot().file!.nodes[id]
  if (!node || node.type === 'root' || node.type === 'component') throw new Error(`${id} is not a primitive`)
  return { left: node.styles.left, top: node.styles.top }
}

const primitiveRect = (store: ReturnType<typeof createDocumentStore>, id: 'frame' | 'child') => {
  const node = store.getSnapshot().file!.nodes[id]
  if (!node || node.type === 'root' || node.type === 'component') throw new Error(`${id} is not a primitive`)
  return { left: node.styles.left, top: node.styles.top, width: node.styles.width, height: node.styles.height }
}

const flowFixture = (): FileDocument => {
  const source = fixture()
  source.nodes.frame = {
    ...source.nodes.frame as Exclude<FileDocument['nodes'][string], { type: 'root' | 'component' }>,
    layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } },
  }
  source.nodes.child = {
    ...source.nodes.child as Exclude<FileDocument['nodes'][string], { type: 'root' | 'component' }>,
    layout: { item: { position: { mode: 'flow' } } },
  }
  source.nodes['nested-text'] = {
    ...source.nodes['nested-text'] as Exclude<FileDocument['nodes'][string], { type: 'root' | 'component' }>,
    layout: { item: { position: { mode: 'flow' } } },
  }
  return source
}

describe('PAPER-FLEX-006 production flow drag controller', () => {
  it('reorders the selected original through one fresh pointer-up sample', async () => {
    const { store, gestures } = setup(undefined, { left: 0, top: 0 }, undefined, flowFixture())
    store.select('child')

    expect(gestures.stagePointerDown({ ...pointer(550, 450), timeStamp: 1_000 })).toBe(true)
    gestures.pointerMove({ ...pointer(550, 570), timeStamp: 1_100 })
    expect(gestures.active).toBe(true)
    gestures.pointerUp({ ...pointer(550, 575), timeStamp: 1_120 })

    await vi.waitFor(() => expect(fileChildren(store.getSnapshot().file!, 'frame')).toEqual(['nested-text', 'child']))
    expect(store.getSnapshot().selection).toEqual(['child'])
    expect(store.getSnapshot().transient).toBeNull()
  })

  it('Alt-drag leaves one inert-source clone and keeps the original selected', async () => {
    const { store, gestures } = setup(undefined, { left: 0, top: 0 }, undefined, flowFixture())
    store.select('child')

    expect(gestures.stagePointerDown({ ...pointer(550, 450), timeStamp: 2_000 })).toBe(true)
    gestures.pointerMove({ ...pointer(550, 570), altKey: true, timeStamp: 2_100 })
    expect(gestures.active).toBe(true)
    gestures.pointerUp({ ...pointer(550, 575), altKey: true, timeStamp: 2_120 })

    await vi.waitFor(() => expect(fileChildren(store.getSnapshot().file!, 'frame')).toHaveLength(3))
    expect(store.getSnapshot().selection).toEqual(['child'])
    expect(store.getSnapshot().file!.nodes.unused).toBeDefined()
  })

  it('drags a flow child out of its parent onto the page as an absolute node', async () => {
    const { store, gestures } = setup(undefined, { left: 0, top: 0 }, undefined, flowFixture())
    store.select('child')

    expect(gestures.stagePointerDown({ ...pointer(550, 450), timeStamp: 2_500 })).toBe(true)
    gestures.pointerMove({ ...pointer(800, 700), timeStamp: 2_600 })
    gestures.pointerUp({ ...pointer(800, 700), timeStamp: 2_620 })

    await vi.waitFor(() => expect(store.getSnapshot().file!.relationships.child!.parentId).toBe('root-1'))
    expect(store.getSnapshot().file!.nodes.child).toMatchObject({
      layout: { item: { position: { mode: 'freeform' } } },
      styles: { left: 270, top: 270, width: 160, height: 100 },
    })
    expect(store.getSnapshot().selection).toEqual(['child'])
  })

  it('Escape after threshold commits the last accepted Paper sample', async () => {
    const { store, gestures } = setup(undefined, { left: 0, top: 0 }, undefined, flowFixture())
    store.select('child')

    gestures.stagePointerDown({ ...pointer(550, 450), timeStamp: 3_000 })
    gestures.pointerMove({ ...pointer(550, 575), timeStamp: 3_100 })
    gestures.cancel()

    await vi.waitFor(() => expect(fileChildren(store.getSnapshot().file!, 'frame')).toEqual(['nested-text', 'child']))
  })

  it('pointer cancel before threshold rolls back without a semantic write', () => {
    const { store, gestures } = setup(undefined, { left: 0, top: 0 }, undefined, flowFixture())
    store.select('child')
    const revision = store.getSnapshot().file!.revision

    gestures.stagePointerDown({ ...pointer(550, 450), timeStamp: 4_000 })
    gestures.pointerMove({ ...pointer(552, 451), timeStamp: 4_100 })
    gestures.pointerCancel({ ...pointer(552, 451), timeStamp: 4_120 })

    expect(store.getSnapshot().file!.revision).toBe(revision)
    expect(fileChildren(store.getSnapshot().file!, 'frame')).toEqual(['child', 'nested-text'])
  })
})

describe('AT-CAN-005 selected container pointer precedence', () => {
  it('AT-CAN-006 fails closed for copied and incomplete projection publications', () => {
    const { store, geometry, projections } = setup()
    const copied = {
      getSnapshot: () => {
        const current = projections.getSnapshot()
        return Object.freeze({ generation: current.generation, frame: current.frame })
      },
    }
    const copiedGestures = createCanvasGestures(store, geometry, undefined, copied)
    copiedGestures.attach({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement)
    expect(copiedGestures.stagePointerDown(pointer(550, 450))).toBe(false)
    expect(store.getSnapshot().selection).toEqual(['frame'])

    const current = projections.getSnapshot()
    const incompleteFrame = current.frame && { ...current.frame, entries: current.frame.entries.slice(0, -1) }
    const incomplete = Object.freeze({ generation: current.generation, frame: incompleteFrame })
    const incompleteGestures = createCanvasGestures(store, geometry, undefined, { getSnapshot: () => incomplete })
    incompleteGestures.attach({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement)
    expect(incompleteGestures.stagePointerDown(pointer(800, 700))).toBe(false)
    expect(incompleteGestures.active).toBe(false)
    expect(store.getSnapshot().selection).toEqual(['frame'])

    const stale = projections.getSnapshot()
    store.setViewport({ x: 1, y: 0, zoom: 1 })
    const staleGestures = createCanvasGestures(store, geometry, undefined, { getSnapshot: () => stale })
    staleGestures.attach({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement)
    expect(staleGestures.stagePointerDown(pointer(551, 450))).toBe(false)

    const missing = Object.freeze({ generation: stale.generation, frame: null })
    const missingGestures = createCanvasGestures(store, geometry, undefined, { getSnapshot: () => missing })
    missingGestures.attach({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement)
    expect(missingGestures.stagePointerDown(pointer(551, 450))).toBe(false)
  })

  it('AT-APP-005 resolves hover and context menu to the same projected target', () => {
    const { store, gestures } = setup()
    const insideChild = pointer(550, 450)

    gestures.pointerMove(insideChild)
    expect(store.getSnapshot().hover).toBe('child')
    expect(gestures.contextMenuTarget(insideChild)?.id).toBe(store.getSnapshot().hover)

    store.setReadOnly(true)
    expect(gestures.contextMenuTarget(insideChild)).toBeNull()
  })

  it('AT-APP-005 localizes nonzero viewport coordinates exactly once for hover, context, click, and marquee', () => {
    const { store, gestures } = setup(undefined, { left: 100, top: 50 })
    const insideChild = pointer(650, 500)

    gestures.pointerMove(insideChild)
    expect(store.getSnapshot().hover).toBe('child')
    expect(gestures.contextMenuTarget(insideChild)?.id).toBe('child')
    expect(gestures.stagePointerDown(insideChild)).toBe(true)
    gestures.pointerUp(insideChild)
    expect(store.getSnapshot().selection).toEqual(['child'])

    expect(gestures.stagePointerDown(pointer(900, 750))).toBe(true)
    gestures.pointerMove(pointer(620, 470))
    gestures.pointerMove(pointer(610, 460))
    expect(store.getSnapshot().selection).toEqual(['frame'])
    expect(store.getSnapshot().transient).toMatchObject({ kind: 'marquee' })
  })

  it('AT-CAN-001 keeps marquee targeting live across its own selection-generation changes', () => {
    const { store, gestures } = setup()
    store.select(null)

    expect(gestures.stagePointerDown(pointer(800, 700))).toBe(true)
    gestures.pointerMove(pointer(520, 420))
    expect(store.getSnapshot().selection).toEqual(['frame'])
    gestures.pointerMove(pointer(510, 410))
    expect(store.getSnapshot().selection).toEqual(['frame'])
    expect(store.getSnapshot().transient).toMatchObject({ kind: 'marquee' })
  })

  it('keeps a child click as a click: it selects the child without moving its selected parent', () => {
    const { store, gestures } = setup()
    const insideChild = pointer(550, 450)

    expect(gestures.stagePointerDown(insideChild)).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['frame'])
    gestures.pointerUp(insideChild)

    expect(store.getSnapshot().selection).toEqual(['child'])
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    expect(primitivePosition(store, 'child')).toEqual({ left: 20, top: 20 })
  })

  it('moves the selected frame when a pointer drag begins over its child-covered body', () => {
    const { store, gestures } = setup()
    const start = pointer(550, 450)

    gestures.stagePointerDown(start)
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerMove(pointer(562, 450))

    expect(store.getSnapshot().selection).toEqual(['frame'])
    expect(store.getSnapshot().transient).toMatchObject({ kind: 'move', rects: { frame: { x: 12, y: 0, width: 240, height: 180 } } })
    gestures.pointerUp(pointer(562, 450))

    expect(primitivePosition(store, 'frame')).toEqual({ left: 12, top: 0 })
    expect(primitivePosition(store, 'child')).toEqual({ left: 20, top: 20 })
  })

  it('keeps drag precedence with an already-selected child', () => {
    const { store, gestures } = setup()
    store.select('child')
    const start = pointer(550, 450)

    gestures.stagePointerDown(start)
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerMove(pointer(562, 450))

    expect(store.getSnapshot().transient).toMatchObject({ kind: 'move', rects: { child: { x: 32, y: 20, width: 160, height: 100 } } })
    gestures.pointerUp(pointer(562, 450))
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    expect(primitivePosition(store, 'child')).toEqual({ left: 32, top: 20 })
  })

  it('Alt-drags a freeform node while leaving one duplicate at its source', () => {
    const { store, gestures } = setup()
    store.select('child')
    const start = { ...pointer(550, 450), altKey: true }

    gestures.stagePointerDown(start)
    gestures.pointerMove({ ...pointer(560, 450), altKey: true })
    gestures.pointerMove({ ...pointer(562, 450), altKey: true })
    gestures.pointerUp({ ...pointer(562, 450), altKey: true })

    expect(primitivePosition(store, 'child')).toEqual({ left: 32, top: 20 })
    expect(store.getSnapshot().file!.nodes.unused).toMatchObject({ id: 'unused', type: 'rectangle', styles: { left: 20, top: 20, width: 160, height: 100 } })
    expect(store.getSnapshot().selection).toEqual(['child'])
  })

  it('lets the deep-selection modifier bypass selected-container drag precedence', () => {
    const { store, gestures } = setup()
    const deepStart = { ...pointer(550, 450), ctrlKey: true }

    gestures.stagePointerDown(deepStart)
    expect(store.getSnapshot().selection).toEqual(['child'])
    gestures.pointerMove({ ...pointer(560, 450), ctrlKey: true })
    gestures.pointerMove({ ...pointer(562, 450), ctrlKey: true })

    expect(store.getSnapshot().transient).toMatchObject({ kind: 'move', rects: { child: { x: 32, y: 20, width: 160, height: 100 } } })
    expect(store.getSnapshot().transient).not.toMatchObject({ rects: { frame: expect.anything() } })
  })

  it('leaves the editor gesture plane inactive in Interact mode', () => {
    const { store, gestures } = setup()
    store.setTool('interact')

    expect(gestures.stagePointerDown(pointer(550, 450))).toBe(false)
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().selection).toEqual(['frame'])
  })
})

describe('UI-COLLAB-READONLY-001 read-only canvas gestures', () => {
  it('keeps creation tools fail-closed when the editor becomes read-only', () => {
    const { store, gestures } = setup()
    store.setTool('text')
    store.setReadOnly(true)
    const before = structuredClone(store.getSnapshot().file)

    expect(gestures.stagePointerDown(pointer(550, 450))).toBe(true)
    gestures.pointerMove(pointer(600, 500))
    gestures.pointerUp(pointer(600, 500))

    expect(store.getSnapshot().selection).toEqual(['child'])
    expect(store.getSnapshot().transient).toBeNull()
    expect(store.getSnapshot().file).toEqual(before)
    expect(store.getSnapshot().dirty).toBe(false)
  })

  it('keeps selection and panning available without producing an edit', () => {
    const { store, gestures } = setup()
    store.setReadOnly(true)
    const before = structuredClone(store.getSnapshot().file)

    const child = pointer(550, 450)
    expect(gestures.stagePointerDown(child)).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['child'])
    gestures.pointerMove(pointer(590, 470))
    gestures.pointerUp(pointer(590, 470))
    expect(store.getSnapshot().file).toEqual(before)
    expect(store.getSnapshot().transient).toBeNull()
    expect(store.getSnapshot().dirty).toBe(false)

    const panStart = { ...pointer(300, 300), button: 1 }
    expect(gestures.stagePointerDown(panStart)).toBe(true)
    gestures.pointerMove({ ...pointer(330, 320), button: 1 })
    gestures.pointerUp({ ...pointer(330, 320), button: 1 })
    expect(store.getSnapshot().viewport).toMatchObject({ x: 30, y: 20 })
    expect(store.getSnapshot().file).toEqual(before)
  })
})
