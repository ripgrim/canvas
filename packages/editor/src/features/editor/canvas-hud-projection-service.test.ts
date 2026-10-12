import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'
import { createCanvasHudProjectionService, currentHudProjectionFrame } from './canvas-hud-projection-service'
import type { HudFlowDragFailureRetirement } from './canvas-hud-projection-service'
import type { ResizePresentation, ResizePresentationItem } from './resize-projection'
import type { SceneGeometry } from './scene-geometry'
import type { FlowDragPresentation } from './flow-drag-presentation'
import { createStableMobileQuickActionsStore, mobileQuickActionsPhase } from './mobile-editor'

const revision = 4, measurementRevision = 12, layoutGeneration = 0
const worldQuad = [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }] as const
const file = (): FileDocument => ({
  schemaVersion: 9, fileId: 'hud-file', revision,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    selected: { id: 'selected', type: 'rectangle', name: 'Selected', styles: { left: -70, top: 10, width: 100, height: 70 }, layout: { item: { position: { mode: 'freeform' } } } },
  },
  relationships: { selected: { parentId: 'root', orderKey: 'V' } }, theme: { tokens: {} },
})
const geometry: SceneGeometry = {
  revision: measurementRevision, documentRevision: revision, layoutGeneration,
  nodes: { selected: {
    canvasKind: 'rectangle', documentRevision: revision, layoutGeneration,
    rect: { x: -70, y: 10, width: 100, height: 70 }, worldAabb: { x: -70, y: 10, width: 100, height: 70 },
    offset: { x: 5, y: -15, width: 35, height: 50, origin: { x: 17.5, y: 25 } },
    offsetParentNodeId: null, directChild: true, transform: [1, 0, 0, 1, 0, 0], offsetParentToRoot: [0, 2, -2, 0, 0, 0],
    box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  } }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
}
const resize = (width = 35, height = 50): ResizePresentation => {
  const item: ResizePresentationItem = {
    nodeId: 'selected', parentId: 'root', coordinateSpace: 'parent-padding',
    startRect: { x: 0, y: 0, width: 100, height: 50 }, rect: { x: 5, y: -15, width, height },
    world: { quad: worldQuad, aabb: { x: -70, y: 10, width: 100, height: 70 } },
  }
  return { selectedNodeId: 'selected', contentLocked: false, affectedAxes: ['x', 'y'], effectiveHandle: 'bottom-right', items: [item], byNodeId: { selected: item } }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value as object)) deepFreeze(Reflect.get(value as object, key))
  return Object.freeze(value)
}

function flowDrag(retention: 'active' | 'terminal-retained', sequence = 7): FlowDragPresentation {
  const sourceQuad = worldQuad.map(point => ({ ...point })) as unknown as typeof worldQuad
  const source = { coordinateSpace: 'world' as const, quad: sourceQuad, aabb: { x: -70, y: 10, width: 100, height: 70 }, semanticSize: { width: 35, height: 50 } }
  const currentQuad = sourceQuad.map(point => ({ x: point.x + 10, y: point.y + 20 })) as unknown as typeof worldQuad
  const current = { coordinateSpace: 'world' as const, quad: currentQuad, aabb: { x: -60, y: 30, width: 100, height: 70 }, semanticSize: { width: 35, height: 50 } }
  return deepFreeze({
    kind: 'flow-drag' as const, coordinateSpace: 'world' as const,
    identity: { interactionId: 'flow-1', gestureGeneration: 2, sampleSequence: sequence },
    fence: { fileId: 'hud-file', pageId: 'page', pageRootId: 'root', fileRevision: revision, measurementRevision, documentRevision: revision, layoutGeneration },
    retention: retention === 'active'
      ? { kind: 'active' as const, gestureGeneration: 2, sampleSequence: sequence }
      : { kind: 'terminal-retained' as const, gestureGeneration: 2, sampleSequence: sequence, terminalReason: 'pointer-up' as const, terminalSampleSequence: sequence, holdUntil: 'authoritative-geometry' as const },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
    original: {
      documentNodeId: 'selected', kind: 'rectangle' as const, name: 'Selected', sourceRelationship: { parentId: 'root', orderKey: 'V', slot: { presence: 'absent' as const } }, sourceIndex: 0,
      mode: 'flow' as const, source, current, sourceOffsetParentPose: null,
      dom: { treatment: 'drag-dimmed' as const, opacity: 0.6 as const, opacityPriority: 'important' as const, zIndex: null },
      namePresentation: { visible: true as const, anchor: 'source' as const, pose: source },
    },
    movingVisual: { kind: 'fill-ghost' as const, documentNodeId: null, geometry: current, fill: { kind: 'fill-only' as const, color: 'oklch(0.67 0.17 258)' as const, alpha: 0.15 as const }, hitTesting: 'none' as const, a11y: 'hidden' as const },
    supportClone: null, target: null,
    hud: { showDimensions: false as const, showSelectionOutline: false as const, showResizeHandles: false as const, showRotationHandles: false as const, interactiveHandleLayer: false as const },
    mobileQuickActions: { mounted: true as const, hidden: true as const, inert: true as const, transition: { property: 'opacity' as const, durationMs: 150, source: 'wonder' as const } },
  })
}

function failureRetirement(
  presentation: FlowDragPresentation,
  overrides: Partial<HudFlowDragFailureRetirement> = {},
): HudFlowDragFailureRetirement {
  const terminalSequence = presentation.retention.kind === 'terminal-retained'
    ? presentation.retention.terminalSampleSequence
    : presentation.identity.sampleSequence
  return deepFreeze({
    kind: 'terminal-flow-failure' as const,
    interactionId: presentation.identity.interactionId,
    gestureGeneration: presentation.identity.gestureGeneration,
    terminalSequence,
    sourceFence: presentation.fence,
    ...overrides,
  })
}

function setup(mobile = false) {
  const store = createDocumentStore(() => 'id')
  store.load(file(), [], { replace: true, pageId: 'page' })
  store.setViewport({ x: 10, y: -20, zoom: 2 })
  store.setViewportSize({ width: 800, height: 600 })
  store.select('selected')
  const geometryListeners = new Set<() => void>()
  const mobileListeners = new Set<() => void>()
  let currentGeometry = geometry
  const measured = { getSnapshot: () => currentGeometry, subscribe: (listener: () => void) => { geometryListeners.add(listener); return () => geometryListeners.delete(listener) } }
  const viewport = { getSnapshot: () => mobile, subscribe: (listener: () => void) => { mobileListeners.add(listener); return () => mobileListeners.delete(listener) } }
  const service = createCanvasHudProjectionService(store, measured, viewport)
  service.start()
  return {
    store,
    service,
    setGeometry(next: SceneGeometry) {
      currentGeometry = next
      for (const listener of geometryListeners) listener()
    },
  }
}

describe('AT-CAN-005-HUD shared HUD projection service', () => {
  it('keeps every selection overlay when a freeform frame has browser-owned Hug sizing', () => {
    const store = createDocumentStore(() => 'id')
    const source: FileDocument = {
      schemaVersion: 9, fileId: 'hug-hud-file', revision,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        hug: {
          id: 'hug', type: 'frame', name: 'Hug frame',
          styles: { left: 10, top: 20, width: 100, height: 70 },
          layout: {
            item: {
              position: { mode: 'freeform' },
              height: { value: { kind: 'intrinsic', value: 'fit-content' } },
            },
            container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } },
          },
        },
      },
      relationships: { hug: { parentId: 'root', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    const measuredGeometry: SceneGeometry = {
      revision: measurementRevision, documentRevision: revision, layoutGeneration,
      nodes: {
        hug: {
          canvasKind: 'frame', documentRevision: revision, layoutGeneration,
          rect: { x: 10, y: 20, width: 100, height: 90 },
          worldAabb: { x: 10, y: 20, width: 100, height: 90 },
          offset: { x: 10, y: 20, width: 100, height: 90, origin: { x: 50, y: 45 } },
          offsetParentNodeId: null, directChild: true,
          transform: [1, 0, 0, 1, 0, 0], offsetParentToRoot: [1, 0, 0, 1, 0, 0],
          box: structuredClone({ border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }),
        },
      },
      unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    }
    const measured = { getSnapshot: () => measuredGeometry, subscribe: () => () => undefined }
    const viewport = { getSnapshot: () => false, subscribe: () => () => undefined }
    store.load(source, [], { replace: true, pageId: 'page' })
    store.setViewport({ x: 0, y: 0, zoom: 1 })
    store.setViewportSize({ width: 800, height: 600 })
    store.select('hug')
    const service = createCanvasHudProjectionService(store, measured, viewport)
    service.start()

    expect(service.getSnapshot().frame?.byNodeId.hug).toMatchObject({
      worldAabb: { x: 10, y: 20, width: 100, height: 90 },
      dimensions: { width: 100, height: 90 },
      policy: { selected: true, showOutline: true, showHandles: true },
    })

    service.dispose()
    store.dispose()
  })

  it('keeps axis-aligned overlays when an unrelated nested node has no offset-parent matrix chain', () => {
    const store = createDocumentStore(() => 'id')
    const source: FileDocument = {
      schemaVersion: 9, fileId: 'partial-topology-file', revision,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        parent: {
          id: 'parent', type: 'frame', name: 'Parent',
          styles: { left: -160, top: -210, width: 212, height: 311 },
          layout: {
            item: { position: { mode: 'freeform' } },
            container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'center', align: 'center' } },
          },
        },
        copy: {
          id: 'copy', type: 'text', name: 'Copy', text: 'Copy',
          textStyle: { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 16, lineHeight: { kind: 'unitless', value: 1 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', wrap: 'normal', case: 'none', keepWords: false },
          textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
          styles: { left: 80, top: 140, width: 52, height: 31 },
          layout: { item: { position: { mode: 'flow' } } },
        },
        selected: {
          id: 'selected', type: 'frame', name: 'Selected',
          styles: { left: 190, top: 26, width: 266, height: 217 },
          layout: { item: { position: { mode: 'freeform' } } },
        },
      },
      relationships: { parent: { parentId: 'root', orderKey: 'A' }, copy: { parentId: 'parent', orderKey: 'A' }, selected: { parentId: 'root', orderKey: 'B' } }, theme: { tokens: {} },
    }
    const node = (canvasKind: 'frame' | 'text', rect: { x: number; y: number; width: number; height: number }, offsetParentNodeId?: string | null): SceneGeometry['nodes'][string] => ({
      canvasKind, documentRevision: revision, layoutGeneration, rect, worldAabb: rect,
      offset: { ...rect, origin: { x: rect.width / 2, y: rect.height / 2 } },
      ...(offsetParentNodeId !== undefined ? { offsetParentNodeId } : {}), directChild: true,
      box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    })
    const measuredGeometry: SceneGeometry = {
      revision: measurementRevision, documentRevision: revision, layoutGeneration,
      nodes: {
        parent: node('frame', { x: -160, y: -210, width: 212, height: 311 }),
        copy: node('text', { x: -80, y: -70, width: 52, height: 31 }),
        selected: node('frame', { x: 190, y: 26, width: 266, height: 217 }),
      },
      unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    }
    const measured = { getSnapshot: () => measuredGeometry, subscribe: () => () => undefined }
    const viewport = { getSnapshot: () => false, subscribe: () => () => undefined }
    store.load(source, [], { replace: true, pageId: 'page' })
    store.setViewport({ x: 0, y: 0, zoom: 1 })
    store.setViewportSize({ width: 800, height: 600 })
    store.select('selected')
    const service = createCanvasHudProjectionService(store, measured, viewport)
    service.start()

    expect(service.getSnapshot().frame?.byNodeId.selected).toMatchObject({
      worldAabb: { x: 190, y: 26, width: 266, height: 217 },
      policy: { selected: true, showOutline: true, showHandles: true },
    })

    service.dispose()
    const transformedGeometry = structuredClone(measuredGeometry)
    transformedGeometry.nodes.selected!.transform = [0, 1, -1, 0, 0, 0]
    const transformedSource = { getSnapshot: () => transformedGeometry, subscribe: () => () => undefined }
    const transformedService = createCanvasHudProjectionService(store, transformedSource, viewport)
    transformedService.start()
    expect(transformedService.getSnapshot().frame).toBeNull()
    transformedService.dispose()
    store.dispose()
  })

  it('reconstructs a rotated selected quad from exact measured rectangles when the root matrix chain is unavailable', () => {
    const store = createDocumentStore(() => 'id')
    const source: FileDocument = {
      schemaVersion: 9, fileId: 'rotated-measured-file', revision,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        selected: {
          id: 'selected', type: 'frame', name: 'Selected',
          styles: { left: 190, top: 26, width: 266, height: 217, rotation: 90 },
          layout: { item: { position: { mode: 'freeform' } } },
        },
      },
      relationships: { selected: { parentId: 'root', orderKey: 'A' } }, theme: { tokens: {} },
    }
    const measuredGeometry: SceneGeometry = {
      revision: measurementRevision, documentRevision: revision, layoutGeneration,
      nodes: {
        selected: {
          canvasKind: 'frame', documentRevision: revision, layoutGeneration,
          rect: { x: 190, y: 26, width: 266, height: 217 },
          worldAabb: { x: 214.5, y: 1.5, width: 217, height: 266 },
          offset: { x: 190, y: 26, width: 266, height: 217, origin: { x: 133, y: 108.5 } },
          directChild: true, transform: [0, 1, -1, 0, 0, 0],
          box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
        },
      },
      unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    }
    store.load(source, [], { replace: true, pageId: 'page' })
    store.setViewport({ x: 0, y: 0, zoom: 1 })
    store.setViewportSize({ width: 800, height: 600 })
    store.select('selected')
    const measured = { getSnapshot: () => measuredGeometry, subscribe: () => () => undefined }
    const viewport = { getSnapshot: () => false, subscribe: () => () => undefined }
    const service = createCanvasHudProjectionService(store, measured, viewport)
    service.start()

    expect(service.getSnapshot().frame?.byNodeId.selected).toMatchObject({
      worldQuad: [{ x: 431.5, y: 1.5 }, { x: 431.5, y: 267.5 }, { x: 214.5, y: 267.5 }, { x: 214.5, y: 1.5 }],
      worldAabb: { x: 214.5, y: 1.5, width: 217, height: 266 },
      dimensions: { width: 266, height: 217 },
      policy: { selected: true, showOutline: true, showHandles: true },
    })

    measuredGeometry.nodes.selected!.worldAabb = { x: 190, y: 26, width: 266, height: 217 }
    const rejected = createCanvasHudProjectionService(store, measured, viewport)
    rejected.start()
    expect(rejected.getSnapshot().frame).toBeNull()
    rejected.dispose()
    service.dispose()
    store.dispose()
  })

  it('publishes ordered flow-drag samples from one captured authority and rejects stale generation data', () => {
    const { store, service } = setup(true)
    const first = flowDrag('active', 7)
    expect(service.publishFlowDragPresentation(first)).toBe(true)
    expect(service.getSnapshot().frame?.flowDrag?.identity).toStrictEqual({ interactionId: 'flow-1', gestureGeneration: 2, sampleSequence: 7 })
    expect(service.getSnapshot().frame?.byNodeId.selected?.policy.showHandles).toBe(false)

    const next = flowDrag('active', 8)
    expect(service.publishFlowDragPresentation(next)).toBe(true)
    expect(service.getSnapshot().frame?.flowDrag?.identity.sampleSequence).toBe(8)
    expect(service.publishFlowDragPresentation(first)).toBe(false)
    expect(service.getSnapshot().frame?.flowDrag?.identity.sampleSequence).toBe(8)
    expect(service.clearFlowDragPresentation(first.identity)).toBe(false)
    expect(service.clearFlowDragPresentation(next.identity)).toBe(true)
    expect(service.getSnapshot().frame?.flowDrag).toBeNull()
    service.dispose(); store.dispose()
  })

  it('holds terminal flow chrome until one exact receipt and matching fresh geometry arrive', () => {
    const { store, service, setGeometry } = setup(true)
    expect(service.publishFlowDragPresentation(flowDrag('active'))).toBe(true)
    const terminal = flowDrag('terminal-retained')
    expect(service.publishFlowDragPresentation(terminal)).toBe(true)
    const terminalFrame = service.getSnapshot().frame
    expect(terminalFrame?.flowDrag?.terminalHold?.kind).toBe('awaiting-committed-receipt')

    expect(store.commands.setStyles('selected', { left: 5, top: -15, width: 35, height: 50 })).toBe(true)
    const committed = store.getSnapshot()
    expect(service.getSnapshot().frame).toBe(terminalFrame)
    const receipt = deepFreeze({
      generation: 12, fileId: 'hud-file', pageId: 'page', documentRevision: committed.file!.revision,
      layoutGeneration: committed.layoutGeneration, afterMeasurementRevision: measurementRevision + 1,
      interactionId: 'flow-1', gestureGeneration: 2, terminalSequence: 7, sourceFence: terminal.fence,
    })
    expect(service.completeCommittedFlowDragHold(deepFreeze({ ...receipt, gestureGeneration: 1 }))).toBe(false)
    expect(service.completeCommittedFlowDragHold(deepFreeze({ ...receipt, pageId: 'other-page' }))).toBe(false)
    expect(service.getSnapshot().frame).toBe(terminalFrame)
    expect(service.completeCommittedFlowDragHold(receipt)).toBe(true)
    expect(service.getSnapshot().frame?.flowDrag?.terminalHold).toMatchObject({ kind: 'awaiting-authoritative-geometry', receipt })

    setGeometry({ ...geometry, revision: measurementRevision + 1, documentRevision: committed.file!.revision, layoutGeneration: committed.layoutGeneration + 1 })
    expect(service.getSnapshot().frame?.flowDrag).not.toBeNull()
    setGeometry({
      ...geometry, revision: measurementRevision + 1, documentRevision: committed.file!.revision, layoutGeneration: committed.layoutGeneration,
      nodes: { selected: { ...geometry.nodes.selected!, documentRevision: committed.file!.revision, layoutGeneration: committed.layoutGeneration, rect: { x: 5, y: -15, width: 35, height: 50 }, worldAabb: { x: 5, y: -15, width: 35, height: 50 }, offset: { x: 5, y: -15, width: 35, height: 50, origin: { x: 17.5, y: 25 } }, offsetParentToRoot: [1, 0, 0, 1, 0, 0] } },
    })
    expect(service.getSnapshot().frame?.flowDrag).toBeNull()
    service.dispose(); store.dispose()
  })

  it('cannot let an old terminal receipt clear a newer interaction', () => {
    const { store, service } = setup(true)
    const oldTerminal = flowDrag('terminal-retained')
    expect(service.publishFlowDragPresentation(oldTerminal)).toBe(true)
    const nextTerminal = deepFreeze({
      ...structuredClone(oldTerminal),
      identity: { ...oldTerminal.identity, interactionId: 'flow-2', gestureGeneration: 3 },
      retention: { ...oldTerminal.retention, gestureGeneration: 3 },
    })
    expect(service.publishFlowDragPresentation(nextTerminal)).toBe(true)

    const oldReceipt = deepFreeze({
      generation: 12, fileId: 'hud-file', pageId: 'page', documentRevision: revision + 1,
      layoutGeneration, afterMeasurementRevision: measurementRevision + 1,
      interactionId: 'flow-1', gestureGeneration: 2, terminalSequence: 7, sourceFence: oldTerminal.fence,
    })
    expect(service.completeCommittedFlowDragHold(oldReceipt)).toBe(false)
    expect(service.getSnapshot().frame?.flowDrag?.identity).toStrictEqual({ interactionId: 'flow-2', gestureGeneration: 3, sampleSequence: 7 })
    service.dispose(); store.dispose()
  })

  describe('AT-CAN-005-C5-HUD-RETIRE CLOUD-SYNC-GESTURE-001-C5-HUD-RETIRE UI-MOBILE-004-C5-HUD-RETIRE', () => {
    it('retires one exact failed terminal hold and publishes one update for each accepted phase', () => {
      const { store, service } = setup(true)
      const listener = vi.fn()
      service.subscribe(listener)
      const active = flowDrag('active', 6)
      const terminal = flowDrag('terminal-retained', 7)

      expect(service.publishFlowDragPresentation(active)).toBe(true)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(service.publishFlowDragPresentation(terminal)).toBe(true)
      expect(listener).toHaveBeenCalledTimes(2)
      const terminalSnapshot = service.getSnapshot()
      expect(terminalSnapshot.frame?.flowDrag?.retention.kind).toBe('terminal-retained')

      const retirement = failureRetirement(terminal)
      const retirementBefore = JSON.stringify(retirement)
      const retirementFence = retirement.sourceFence
      expect(service.retireFailedFlowDragHold(retirement)).toBe(true)
      expect(JSON.stringify(retirement)).toBe(retirementBefore)
      expect(retirement.sourceFence).toBe(retirementFence)
      expect(Object.isFrozen(retirement)).toBe(true)
      expect(Object.isFrozen(retirement.sourceFence)).toBe(true)
      expect(listener).toHaveBeenCalledTimes(3)
      const retiredSnapshot = service.getSnapshot()
      expect(retiredSnapshot.generation).toBe(terminalSnapshot.generation + 1)
      expect(retiredSnapshot.frame?.flowDrag).toBeNull()

      expect(service.retireFailedFlowDragHold(retirement)).toBe(false)
      expect(service.getSnapshot()).toBe(retiredSnapshot)
      expect(listener).toHaveBeenCalledTimes(3)
      service.dispose(); store.dispose()
    })

    it('rejects every independently stale identity and source-fence field without mutation', () => {
      const { store, service } = setup(true)
      const listener = vi.fn()
      const oldTerminal = flowDrag('terminal-retained', 7)
      expect(service.publishFlowDragPresentation(oldTerminal)).toBe(true)
      const newerTerminal = deepFreeze({
        ...structuredClone(oldTerminal),
        identity: { interactionId: 'flow-1', gestureGeneration: 3, sampleSequence: 8 },
        retention: { ...oldTerminal.retention, gestureGeneration: 3, sampleSequence: 8, terminalSampleSequence: 8 },
      })
      expect(service.publishFlowDragPresentation(newerTerminal)).toBe(true)
      service.subscribe(listener)
      const retained = service.getSnapshot()
      const exact = failureRetirement(newerTerminal)
      const fenceMutation = <K extends keyof FlowDragPresentation['fence']>(key: K, value: FlowDragPresentation['fence'][K]) => failureRetirement(newerTerminal, {
        sourceFence: deepFreeze({ ...newerTerminal.fence, [key]: value }),
      })
      const invalid = [
        failureRetirement(newerTerminal, { interactionId: 'flow-2' }),
        failureRetirement(newerTerminal, { gestureGeneration: exact.gestureGeneration - 1 }),
        failureRetirement(newerTerminal, { terminalSequence: exact.terminalSequence - 1 }),
        fenceMutation('fileId', 'other-file'),
        fenceMutation('fileRevision', exact.sourceFence.fileRevision + 1),
        fenceMutation('measurementRevision', exact.sourceFence.measurementRevision + 1),
        fenceMutation('documentRevision', exact.sourceFence.documentRevision + 1),
        fenceMutation('layoutGeneration', exact.sourceFence.layoutGeneration + 1),
        fenceMutation('pageId', 'other-page'),
        fenceMutation('pageRootId', 'other-root'),
        failureRetirement(oldTerminal),
      ]
      for (const mutation of invalid) {
        expect(service.retireFailedFlowDragHold(mutation)).toBe(false)
        expect(service.getSnapshot()).toBe(retained)
      }
      expect(service.getSnapshot().frame?.flowDrag?.identity).toStrictEqual(newerTerminal.identity)
      expect(listener).not.toHaveBeenCalled()
      service.dispose(); store.dispose()
    })

    it('never treats a remote lease presentation as local failure authority', () => {
      const { store, service } = setup(true)
      const remoteTerminal = deepFreeze({
        ...structuredClone(flowDrag('terminal-retained')),
        identity: { interactionId: 'lease:remote-lease', gestureGeneration: 2, sampleSequence: 7 },
      })
      expect(service.publishFlowDragPresentation(remoteTerminal)).toBe(true)
      const listener = vi.fn()
      service.subscribe(listener)
      const retained = service.getSnapshot()

      expect(service.retireFailedFlowDragHold(failureRetirement(remoteTerminal))).toBe(false)
      expect(service.getSnapshot()).toBe(retained)
      expect(service.getSnapshot().frame?.flowDrag?.identity.interactionId).toBe('lease:remote-lease')
      expect(listener).not.toHaveBeenCalled()
      service.dispose(); store.dispose()
    })

    it('rejects accessors, extras, mutable input, and active samples without reading or mutation', () => {
      const { store, service } = setup(true)
      const terminal = flowDrag('terminal-retained')
      expect(service.publishFlowDragPresentation(terminal)).toBe(true)
      const listener = vi.fn()
      service.subscribe(listener)
      const retained = service.getSnapshot()
      const exact = failureRetirement(terminal)
      const before = JSON.stringify(exact)
      let reads = 0
      const accessor = Object.freeze({
        kind: 'terminal-flow-failure' as const,
        get interactionId() { reads += 1; return terminal.identity.interactionId },
        gestureGeneration: terminal.identity.gestureGeneration,
        terminalSequence: terminal.identity.sampleSequence,
        sourceFence: terminal.fence,
      })
      const extra = deepFreeze({ ...exact, extra: true })
      const mutable = structuredClone(exact)

      expect(service.retireFailedFlowDragHold(accessor)).toBe(false)
      expect(reads).toBe(0)
      expect(service.retireFailedFlowDragHold(extra as HudFlowDragFailureRetirement)).toBe(false)
      expect(service.retireFailedFlowDragHold(mutable)).toBe(false)
      expect(JSON.stringify(exact)).toBe(before)
      expect(service.getSnapshot()).toBe(retained)
      expect(listener).not.toHaveBeenCalled()

      const active = flowDrag('active', 8)
      expect(service.publishFlowDragPresentation(active)).toBe(true)
      listener.mockClear()
      const activeSnapshot = service.getSnapshot()
      expect(service.retireFailedFlowDragHold(failureRetirement(active))).toBe(false)
      expect(service.getSnapshot()).toBe(activeSnapshot)
      expect(listener).not.toHaveBeenCalled()
      service.dispose(); store.dispose()
    })

    it('rejects hostile nested source-fence descriptors and prototypes without invoking getters', () => {
      const { store, service } = setup(true)
      const terminal = flowDrag('terminal-retained')
      expect(service.publishFlowDragPresentation(terminal)).toBe(true)
      const retained = service.getSnapshot()
      const listener = vi.fn()
      service.subscribe(listener)
      let reads = 0
      const accessorFence = Object.freeze({
        fileId: terminal.fence.fileId,
        fileRevision: terminal.fence.fileRevision,
        measurementRevision: terminal.fence.measurementRevision,
        documentRevision: terminal.fence.documentRevision,
        layoutGeneration: terminal.fence.layoutGeneration,
        get pageId() { reads += 1; return terminal.fence.pageId },
        pageRootId: terminal.fence.pageRootId,
      })
      const hiddenFence = { ...terminal.fence }
      Object.defineProperty(hiddenFence, 'hidden', { value: true, enumerable: false })
      Object.freeze(hiddenFence)
      const symbolFence = { ...terminal.fence, [Symbol('hidden')]: true }
      Object.freeze(symbolFence)
      const nonEnumerableFence = { ...terminal.fence }
      Object.defineProperty(nonEnumerableFence, 'pageId', { value: terminal.fence.pageId, enumerable: false })
      Object.freeze(nonEnumerableFence)
      const customPrototypeFence = Object.assign(Object.create({ inherited: true }), terminal.fence)
      Object.freeze(customPrototypeFence)
      const withFence = (sourceFence: unknown) => Object.freeze({
        kind: 'terminal-flow-failure' as const,
        interactionId: terminal.identity.interactionId,
        gestureGeneration: terminal.identity.gestureGeneration,
        terminalSequence: terminal.identity.sampleSequence,
        sourceFence,
      }) as HudFlowDragFailureRetirement

      for (const sourceFence of [accessorFence, hiddenFence, symbolFence, nonEnumerableFence, customPrototypeFence]) {
        expect(service.retireFailedFlowDragHold(withFence(sourceFence))).toBe(false)
        expect(service.getSnapshot()).toBe(retained)
      }
      expect(reads).toBe(0)
      expect(listener).not.toHaveBeenCalled()
      service.dispose(); store.dispose()
    })

    it('suppresses 100 per-sample quick-action updates and publishes the retirement phase once', () => {
      const { store, service } = setup(true)
      const quickActions = createStableMobileQuickActionsStore(
        () => {
          const projection = service.getSnapshot()
          return { phase: mobileQuickActionsPhase(store.getSnapshot().transient, projection.frame), projection }
        },
        listener => {
          const stops = [store.subscribe(listener), service.subscribe(listener)]
          return () => stops.forEach(stop => stop())
        },
        projection => projection.frame !== null,
      )
      const reactLayerUpdate = vi.fn()
      const stop = quickActions.subscribe(reactLayerUpdate)

      expect(service.publishFlowDragPresentation(flowDrag('active', 1))).toBe(true)
      expect(reactLayerUpdate).toHaveBeenCalledTimes(1)
      const hiddenPhase = quickActions.getSnapshot()
      for (let sequence = 2; sequence <= 101; sequence += 1) {
        expect(service.publishFlowDragPresentation(flowDrag('active', sequence))).toBe(true)
      }
      expect(reactLayerUpdate).toHaveBeenCalledTimes(1)
      expect(quickActions.getSnapshot()).toBe(hiddenPhase)

      const terminal = flowDrag('terminal-retained', 102)
      expect(service.publishFlowDragPresentation(terminal)).toBe(true)
      expect(reactLayerUpdate).toHaveBeenCalledTimes(1)
      expect(service.retireFailedFlowDragHold(failureRetirement(terminal))).toBe(true)
      expect(reactLayerUpdate).toHaveBeenCalledTimes(2)
      expect(quickActions.getSnapshot().phase).toBe('idle')

      stop(); service.dispose(); store.dispose()
    })

    it('cannot retire a terminal hold after its exact committed receipt is installed', () => {
      const { store, service, setGeometry } = setup(true)
      const terminal = flowDrag('terminal-retained')
      expect(service.publishFlowDragPresentation(terminal)).toBe(true)
      expect(store.commands.setStyles('selected', { left: 5, top: -15, width: 35, height: 50 })).toBe(true)
      const committed = store.getSnapshot()
      const receipt = deepFreeze({
        generation: 12, fileId: 'hud-file', pageId: 'page', documentRevision: committed.file!.revision,
        layoutGeneration: committed.layoutGeneration, afterMeasurementRevision: measurementRevision + 1,
        interactionId: 'flow-1', gestureGeneration: 2, terminalSequence: 7, sourceFence: terminal.fence,
      })
      expect(service.completeCommittedFlowDragHold(receipt)).toBe(true)
      const awaitingGeometry = service.getSnapshot()
      expect(awaitingGeometry.frame?.flowDrag?.terminalHold?.kind).toBe('awaiting-authoritative-geometry')
      expect(service.retireFailedFlowDragHold(failureRetirement(terminal))).toBe(false)
      expect(service.getSnapshot()).toBe(awaitingGeometry)

      setGeometry({
        ...geometry, revision: measurementRevision + 1, documentRevision: committed.file!.revision, layoutGeneration: committed.layoutGeneration,
        nodes: { selected: { ...geometry.nodes.selected!, documentRevision: committed.file!.revision, layoutGeneration: committed.layoutGeneration } },
      })
      expect(service.getSnapshot().frame?.flowDrag ?? null).toBeNull()
      service.dispose(); store.dispose()
    })
  })
  it('caches one deeply frozen frame object and one generation for every renderer subscriber', () => {
    const { store, service } = setup()
    const first = service.getSnapshot()
    const canvasObservation = service.getSnapshot()
    const domObservation = service.getSnapshot()

    expect(canvasObservation).toBe(domObservation)
    expect(canvasObservation.frame).toBe(domObservation.frame)
    expect(currentHudProjectionFrame(domObservation, canvasObservation)).toBe(first.frame)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.frame)).toBe(true)
    const split = Object.freeze({ generation: first.generation, frame: first.frame })
    expect(currentHudProjectionFrame(split, first)).toBeNull()
    service.dispose()
    store.dispose()
  })

  it('does not publish another frame for transient move samples that do not change projection authority', () => {
    const { store, service } = setup()
    const listener = vi.fn()
    service.subscribe(listener)
    const before = service.getSnapshot()
    store.setTransient({ kind: 'move', rects: { selected: { x: 20, y: 30, width: 100, height: 70 } }, offset: { x: 90, y: 20 }, guides: [], targetFrameId: null, insertion: null })
    expect(service.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    service.dispose()
    store.dispose()
  })

  it('fails closed throughout resize until an exact presentation and inseparable fence are published', () => {
    const { store, service } = setup()
    const idle = service.getSnapshot()
    const fence = idle.frame!.key
    store.setTransient({ kind: 'resize', interactionId: 'resize-1' })
    expect(service.getSnapshot().frame).toBeNull()

    expect(service.publishResizePresentation(resize(), {
      fileId: fence.fileId, fileRevision: fence.fileRevision, measurementRevision: fence.measurementRevision,
      documentRevision: fence.documentRevision, layoutGeneration: fence.layoutGeneration,
    })).toBe(true)
    expect(service.getSnapshot().frame?.byNodeId.selected).toMatchObject({
      screenQuad: [{ x: 470, y: 300 }, { x: 470, y: 440 }, { x: 270, y: 440 }, { x: 270, y: 300 }],
      screenAabb: { x: 270, y: 300, width: 200, height: 140 },
      dimensions: { width: 35, height: 50 },
    })

    service.clearResizePresentation()
    expect(service.getSnapshot().frame).toBeNull()
    expect(service.publishResizePresentation(resize(), {
      fileId: fence.fileId, fileRevision: fence.fileRevision, measurementRevision: fence.measurementRevision + 1,
      documentRevision: fence.documentRevision, layoutGeneration: fence.layoutGeneration,
    })).toBe(false)
    expect(service.getSnapshot().frame).toBeNull()
    service.dispose()
    store.dispose()
  })

  it('rejects idle publications and drops resize authority on every non-resize transition', () => {
    const { store, service } = setup()
    const idle = service.getSnapshot()
    const fence = idle.frame!.key
    const start = {
      fileId: fence.fileId, fileRevision: fence.fileRevision, measurementRevision: fence.measurementRevision,
      documentRevision: fence.documentRevision, layoutGeneration: fence.layoutGeneration,
    }

    expect(service.publishResizePresentation(resize(63, 41), start)).toBe(false)
    expect(service.getSnapshot()).toBe(idle)

    store.setTransient({ kind: 'resize', interactionId: 'resize-1' })
    expect(service.publishResizePresentation(resize(63, 41), start)).toBe(true)
    expect(service.getSnapshot().frame?.byNodeId.selected?.dimensions).toEqual({ width: 63, height: 41 })
    store.setTransient(null)
    expect(service.getSnapshot().frame?.byNodeId.selected?.dimensions).toEqual({ width: 35, height: 50 })

    store.setTransient({ kind: 'resize', interactionId: 'resize-2' })
    expect(service.getSnapshot().frame).toBeNull()
    expect(service.publishResizePresentation(resize(63, 41), start)).toBe(true)
    expect(service.getSnapshot().frame?.byNodeId.selected?.dimensions).toEqual({ width: 63, height: 41 })
    store.setTransient({ kind: 'move', rects: { selected: { x: 20, y: 30, width: 100, height: 70 } }, offset: { x: 90, y: 20 }, guides: [], targetFrameId: null, insertion: null })
    expect(service.getSnapshot().frame?.byNodeId.selected?.dimensions).toEqual({ width: 35, height: 50 })
    store.setTransient({ kind: 'resize', interactionId: 'resize-3' })
    expect(service.getSnapshot().frame).toBeNull()

    service.dispose()
    store.dispose()
  })

  it('keeps handle CSS-pixel sizes independent from camera zoom and mobile DPR policy', () => {
    const desktop = setup(false), mobile = setup(true)
    expect(desktop.service.getSnapshot().frame?.byNodeId.selected?.handles.every(handle => handle.size === 7)).toBe(true)
    expect(mobile.service.getSnapshot().frame?.byNodeId.selected?.handles.every(handle => handle.size === 12)).toBe(true)
    desktop.store.setViewport({ x: 10, y: -20, zoom: 8 })
    expect(desktop.service.getSnapshot().frame?.byNodeId.selected?.handles.every(handle => handle.size === 7)).toBe(true)
    desktop.service.dispose(); desktop.store.dispose(); mobile.service.dispose(); mobile.store.dispose()
  })

  it('holds the terminal presentation without a null frame until matching committed geometry arrives', () => {
    const { store, service, setGeometry } = setup()
    const key = service.getSnapshot().frame!.key
    const fence = {
      fileId: key.fileId,
      fileRevision: key.fileRevision,
      measurementRevision: key.measurementRevision,
      documentRevision: key.documentRevision,
      layoutGeneration: key.layoutGeneration,
    }
    store.setTransient({ kind: 'resize', interactionId: 'resize-terminal' })
    expect(service.publishResizePresentation(resize(35, 50), fence)).toBe(true)
    const terminalFrame = service.getSnapshot().frame
    const observed: Array<ReturnType<typeof service.getSnapshot>['frame']> = []
    service.subscribe(() => observed.push(service.getSnapshot().frame))
    expect(terminalFrame?.byNodeId.selected?.dimensions).toEqual({ width: 35, height: 50 })
    expect(service.beginCommittedResizeHold()).toBe(true)

    expect(store.commands.setStyles('selected', { left: 5, top: -15, width: 35, height: 50 })).toBe(true)
    store.setTransient(null)
    const committed = store.getSnapshot()
    expect(service.getSnapshot().frame).toBe(terminalFrame)
    expect(service.completeCommittedResizeHold({
      generation: 9,
      fileId: committed.file!.fileId,
      pageId: committed.pageId!,
      documentRevision: committed.file!.revision,
      layoutGeneration: committed.layoutGeneration,
      afterMeasurementRevision: measurementRevision,
    })).toBe(true)
    expect(service.getSnapshot().frame).toBe(terminalFrame)

    setGeometry({
      ...geometry,
      revision: measurementRevision + 1,
      documentRevision: committed.file!.revision,
      nodes: {
        selected: {
          ...geometry.nodes.selected!,
          documentRevision: committed.file!.revision,
          rect: { x: 5, y: -15, width: 35, height: 50 },
          worldAabb: { x: 5, y: -15, width: 35, height: 50 },
          offset: { x: 5, y: -15, width: 35, height: 50, origin: { x: 17.5, y: 25 } },
          offsetParentToRoot: [1, 0, 0, 1, 0, 0],
        },
      },
    })

    expect(service.getSnapshot().frame).not.toBe(terminalFrame)
    expect(service.getSnapshot().frame?.byNodeId.selected?.dimensions).toEqual({ width: 35, height: 50 })
    expect(observed).not.toContain(null)
    service.dispose()
    store.dispose()
  })
})
