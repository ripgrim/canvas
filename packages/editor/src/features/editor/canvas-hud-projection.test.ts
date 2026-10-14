import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { SceneNode } from './canvas-scene'
import { projectHudFrame } from './canvas-hud-projection'
import type { HudProjectionView, HudQuad } from './canvas-hud-projection'
import type { ResizePresentation, ResizePresentationItem } from './resize-projection'
import type { MeasuredNode, SceneGeometry } from './scene-geometry'
import type { FlowDragPresentation } from './flow-drag-presentation'

const fileRevision = 4, measurementRevision = 12, layoutGeneration = 8
const camera = { x: 10, y: -20, zoom: 2 }
const size = { width: 800, height: 600 }
const worldQuad: HudQuad = [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }]
const worldAabb = { x: -70, y: 10, width: 100, height: 70 }
const localRect = { x: 5, y: -15, width: 35, height: 50 }
const zeroBox = { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }

function document(locked = false): FileDocument {
  return {
    schemaVersion: 9,
    fileId: 'hud-file', revision: fileRevision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      selected: {
        id: 'selected', type: 'rectangle', name: 'Selected', isLocked: locked,
        styles: { left: -70, top: 10, width: 100, height: 70 },
        layout: { item: { position: { mode: 'freeform' } } },
      },
    },
    relationships: { selected: { parentId: 'root', orderKey: 'V' } },
    theme: { tokens: {} },
  }
}

function measurement(overrides: Partial<MeasuredNode> = {}): MeasuredNode {
  return {
    canvasKind: 'rectangle', documentRevision: fileRevision, layoutGeneration,
    rect: { ...worldAabb }, worldAabb: { ...worldAabb },
    offset: { ...localRect, origin: { x: localRect.width / 2, y: localRect.height / 2 } },
    offsetParentNodeId: null, directChild: true,
    transform: [1, 0, 0, 1, 0, 0], offsetParentToRoot: [0, 2, -2, 0, 0, 0],
    box: structuredClone(zeroBox),
    ...overrides,
  }
}

function authority(options: { locked?: boolean; measurement?: MeasuredNode; camera?: typeof camera; size?: typeof size } = {}): GestureAuthoritySnapshot {
  const file = document(options.locked)
  const measured = options.measurement ?? measurement()
  const geometry: SceneGeometry = {
    revision: measurementRevision, documentRevision: fileRevision, layoutGeneration,
    nodes: { selected: measured }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
  }
  const sceneNode = {
    id: 'selected', kind: 'rectangle' as const, name: 'Selected', parentId: null,
    rect: { ...measured.rect }, rotation: 0, clip: false, depth: 0, order: 0,
    flow: false, locked: options.locked ?? false,
  }
  return {
    file, pageId: 'page', atoms: [], geometry, layoutGeneration,
    scene: { nodes: [sceneNode], byId: new Map([['selected', sceneNode]]) },
    start: { fileId: file.fileId, fileRevision, measurementRevision, documentRevision: fileRevision, layoutGeneration },
    camera: { ...(options.camera ?? camera) }, size: { ...(options.size ?? size) }, selection: ['selected'],
  }
}

function nestedAuthority(): GestureAuthoritySnapshot {
  const file: FileDocument = {
    schemaVersion: 9, fileId: 'nested-hud-file', revision: fileRevision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      parent: {
        id: 'parent', type: 'frame', name: 'Parent',
        styles: { left: -90, top: 20, width: 100, height: 100, rotation: 90, overflow: 'visible' },
        layout: { item: { position: { mode: 'freeform' } } },
      },
      selected: { id: 'selected', type: 'component', name: 'Card', componentId: 'card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'freeform' } } } },
    },
    relationships: { parent: { parentId: 'root', orderKey: 'V' }, selected: { parentId: 'parent', orderKey: 'V' } },
    theme: { tokens: {} },
  }
  const parentMeasurement: MeasuredNode = {
    canvasKind: 'frame', documentRevision: fileRevision, layoutGeneration,
    rect: { x: -90, y: 20, width: 100, height: 100 }, worldAabb: { x: -90, y: 20, width: 100, height: 100 },
    offset: { x: 10, y: 20, width: 100, height: 100, origin: { x: 0, y: 0 } },
    offsetParentNodeId: null, directChild: true, transform: [0, 1, -1, 0, 0, 0], offsetParentToRoot: [1, 0, 0, 1, 0, 0],
    box: { border: { top: 5, right: 5, bottom: 5, left: 5 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  }
  const childMeasurement: MeasuredNode = {
    componentId: 'card', documentRevision: fileRevision, layoutGeneration,
    rect: { x: -9, y: 28, width: 10, height: 20 }, worldAabb: { x: -9, y: 28, width: 10, height: 20 },
    offset: { x: 3, y: 4, width: 20, height: 10, origin: { x: 10, y: 5 } },
    offsetParentNodeId: 'parent', offsetParentInstanceId: null, parentInstanceId: null, directChild: true,
    transform: [1, 0, 0, 1, 0, 0], box: structuredClone(zeroBox),
  }
  const parentScene: SceneNode = { id: 'parent', kind: 'frame', name: 'Parent', parentId: null, rect: { ...parentMeasurement.rect }, rotation: 90, clip: false, depth: 0, order: 0, flow: false, locked: false }
  const childScene: SceneNode = { id: 'selected', kind: 'component', name: 'Card', parentId: 'parent', rect: { ...childMeasurement.rect }, rotation: 0, clip: false, depth: 1, order: 1, flow: false, locked: false }
  const geometry: SceneGeometry = {
    revision: measurementRevision, documentRevision: fileRevision, layoutGeneration,
    nodes: { parent: parentMeasurement, selected: childMeasurement }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
  }
  return {
    file, pageId: 'page', atoms: [], geometry, layoutGeneration,
    scene: { nodes: [parentScene, childScene], byId: new Map([['parent', parentScene], ['selected', childScene]]) },
    start: { fileId: file.fileId, fileRevision, measurementRevision, documentRevision: fileRevision, layoutGeneration },
    camera: { ...camera }, size: { ...size }, selection: ['selected'],
  }
}

function view(snapshot: GestureAuthoritySnapshot, overrides: Partial<HudProjectionView> = {}): HudProjectionView {
  return {
    fileId: snapshot.file.fileId, pageId: snapshot.pageId, fileRevision: snapshot.file.revision,
    measurementRevision: snapshot.geometry.revision,
    documentRevision: snapshot.geometry.documentRevision!, layoutGeneration: snapshot.layoutGeneration,
    camera: { ...snapshot.camera }, size: { ...snapshot.size }, selection: [...snapshot.selection],
    hover: null, tool: 'move', readOnly: false, mobile: false,
    ...overrides,
  }
}

function resize(quad: HudQuad = worldQuad, effectiveHandle: ResizePresentation['effectiveHandle'] = 'bottom-right'): ResizePresentation {
  const item: ResizePresentationItem = {
    nodeId: 'selected', parentId: 'root', coordinateSpace: 'parent-padding',
    startRect: { x: 0, y: 0, width: 100, height: 50 }, rect: { ...localRect },
    world: { quad, aabb: bounds(quad) },
  }
  return {
    selectedNodeId: 'selected', contentLocked: false, affectedAxes: ['x', 'y'], effectiveHandle,
    items: [item], byNodeId: { selected: item },
  }
}

function bounds(quad: HudQuad) {
  const xs = quad.map(point => point.x), ys = quad.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value as object)) freeze(Reflect.get(value as object, key))
  return Object.freeze(value)
}

function flowDrag(terminal = false): FlowDragPresentation {
  const sourceQuad = worldQuad.map(point => ({ ...point })) as unknown as HudQuad
  const source = { coordinateSpace: 'world' as const, quad: sourceQuad, aabb: { ...worldAabb }, semanticSize: { width: 35, height: 50 } }
  const currentQuad = sourceQuad.map(point => ({ x: point.x + 10, y: point.y + 20 })) as unknown as HudQuad
  const current = { coordinateSpace: 'world' as const, quad: currentQuad, aabb: { x: -60, y: 30, width: 100, height: 70 }, semanticSize: { width: 35, height: 50 } }
  return freeze({
    kind: 'flow-drag' as const,
    coordinateSpace: 'world' as const,
    identity: { interactionId: 'flow-1', gestureGeneration: 2, sampleSequence: 7 },
    fence: { fileId: 'hud-file', pageId: 'page', pageRootId: 'root', fileRevision, measurementRevision, documentRevision: fileRevision, layoutGeneration },
    retention: terminal
      ? { kind: 'terminal-retained' as const, gestureGeneration: 2, sampleSequence: 7, terminalReason: 'pointer-up' as const, terminalSampleSequence: 7, holdUntil: 'authoritative-geometry' as const }
      : { kind: 'active' as const, gestureGeneration: 2, sampleSequence: 7 },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
    original: {
      documentNodeId: 'selected', kind: 'rectangle' as const, name: 'Selected',
      sourceRelationship: { parentId: 'root', orderKey: 'V', slot: { presence: 'absent' as const } }, sourceIndex: 0,
      mode: 'flow' as const, source, current, sourceOffsetParentPose: null,
      dom: { treatment: 'drag-dimmed' as const, opacity: 0.6 as const, opacityPriority: 'important' as const, zIndex: null },
      namePresentation: { visible: true as const, anchor: 'source' as const, pose: source },
    },
    movingVisual: { kind: 'fill-ghost' as const, documentNodeId: null, geometry: current, fill: { kind: 'fill-only' as const, color: 'oklch(0.67 0.17 258)' as const, alpha: 0.15 as const }, hitTesting: 'none' as const, a11y: 'hidden' as const },
    supportClone: null,
    target: {
      parentId: 'root', slot: { presence: 'absent' as const }, rawIndex: 0, semanticIndex: 0, line: 0,
      parentOutline: { coordinateSpace: 'world' as const, quad: sourceQuad.map(point => ({ ...point })) as unknown as HudQuad, aabb: { ...worldAabb }, color: 'oklch(0.67 0.17 258)' as const, widthCssPx: 2 as const },
      insertionGuide: { coordinateSpace: 'world' as const, axis: 'x' as const, position: 5, start: 10, end: 80, color: 'oklch(0.67 0.17 258)' as const, widthCssPx: 4 as const, style: 'solid' as const },
    },
    hud: { showDimensions: false as const, showSelectionOutline: false as const, showResizeHandles: false as const, showRotationHandles: false as const, interactiveHandleLayer: false as const },
    mobileQuickActions: { mounted: true as const, hidden: true as const, inert: true as const, transition: { property: 'opacity' as const, durationMs: 150, source: 'wonder' as const } },
  })
}

describe('PAPER-FLEX-006-HUD / PAPER-FLEX-007-HUD / AT-DOC-003-HUD shared HUD projection authority', () => {
  it('projects Paper flow drag chrome without taking ownership of the moving visual', () => {
    const captured = authority()
    const presentation = flowDrag()
    const frame = projectHudFrame({ authority: captured, view: view(captured, { mobile: true }), flowDragPresentation: presentation })
    const entry = frame?.byNodeId.selected

    expect(frame?.flowDrag).toMatchObject({
      identity: { interactionId: 'flow-1', gestureGeneration: 2, sampleSequence: 7 },
      movingVisualOwner: 'preview-runtime', movingVisualKind: 'fill-ghost', supportCloneOwner: null,
      name: { anchor: 'source', pose: { origin: { x: 270, y: 293 } } },
      target: {
        parentOutline: { quad: [{ x: 470, y: 300 }, { x: 470, y: 440 }, { x: 270, y: 440 }, { x: 270, y: 300 }], widthCssPx: 2 },
        insertionGuide: { start: { x: 420, y: 300 }, end: { x: 420, y: 440 }, widthCssPx: 4, style: 'solid' },
      },
      terminalHold: null,
    })
    expect(frame?.flowDrag?.currentSelectionQuad).toStrictEqual([{ x: 490, y: 340 }, { x: 490, y: 480 }, { x: 290, y: 480 }, { x: 290, y: 340 }])
    expect(entry?.screenQuad).toStrictEqual(frame?.flowDrag?.currentSelectionQuad)
    expect(entry?.policy).toMatchObject({ showOutline: false, showLabel: false, showDimensions: false, showHandles: false, showQuickActions: false })
    expect(entry?.controls).toStrictEqual([])
    expect(Object.isFrozen(frame?.flowDrag?.identity)).toBe(true)
    expect(Object.isFrozen(frame?.flowDrag?.target?.insertionGuide)).toBe(true)
  })

  it('uses the source name anchor for flow, rejects mutable presentations, and exposes terminal receipt state', () => {
    const captured = authority()
    const mutable = structuredClone(flowDrag())
    expect(projectHudFrame({ authority: captured, view: view(captured), flowDragPresentation: mutable })).toBeNull()
    const correct = flowDrag()
    const wrongAnchor = freeze({ ...structuredClone(correct), original: { ...structuredClone(correct.original), namePresentation: { visible: true as const, anchor: 'current' as const, pose: correct.original.current } } })
    expect(projectHudFrame({ authority: captured, view: view(captured), flowDragPresentation: wrongAnchor })).toBeNull()

    const terminal = flowDrag(true)
    const waiting = projectHudFrame({ authority: captured, view: view(captured), flowDragPresentation: terminal })
    expect(waiting?.flowDrag?.name.anchor).toBe('source')
    expect(waiting?.flowDrag?.name.quad).toStrictEqual([{ x: 470, y: 300 }, { x: 470, y: 440 }, { x: 270, y: 440 }, { x: 270, y: 300 }])
    expect(waiting?.flowDrag?.terminalHold).toStrictEqual({ kind: 'awaiting-committed-receipt', receipt: null })
    expect(waiting?.byNodeId.selected?.policy).toMatchObject({ showOutline: false, showDimensions: false, showHandles: false, showQuickActions: false })
    expect(waiting?.byNodeId.selected?.controls).toStrictEqual([])

    const receipt = freeze({
      generation: 11, fileId: 'hud-file', pageId: 'page', documentRevision: 5, layoutGeneration, afterMeasurementRevision: 13,
      interactionId: 'flow-1', gestureGeneration: 2, terminalSequence: 7,
      sourceFence: terminal.fence,
    })
    const received = projectHudFrame({ authority: captured, view: view(captured), flowDragPresentation: terminal, flowDragReceipt: receipt })
    expect(received?.flowDrag?.terminalHold).toStrictEqual({ kind: 'awaiting-authoritative-geometry', receipt })
    expect(projectHudFrame({ authority: captured, view: view(captured), flowDragPresentation: terminal, flowDragReceipt: freeze({ ...receipt, gestureGeneration: 1 }) })).toBeNull()
  })

  it('uses the exact current name geometry for an absolute original', () => {
    const captured = authority()
    const base = flowDrag()
    const absolute = freeze({
      ...structuredClone(base),
      original: {
        ...structuredClone(base.original), mode: 'absolute' as const,
        sourceOffsetParentPose: { coordinateSpace: 'source-offset-parent' as const, offsetParentNodeId: null, sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0] as const, matrix: [0, 2, -2, 0, 40, 30] as const },
        dom: { treatment: 'unchanged' as const, opacity: null, opacityPriority: 'normal' as const, zIndex: null },
        namePresentation: { visible: true as const, anchor: 'current' as const, pose: structuredClone(base.original.current) },
      },
      movingVisual: { kind: 'document-node' as const, documentNodeId: 'selected', geometry: structuredClone(base.original.current) },
    })
    const frame = projectHudFrame({ authority: captured, view: view(captured), flowDragPresentation: absolute })
    expect(frame?.flowDrag?.name.anchor).toBe('current')
    expect(frame?.flowDrag?.name.quad).toStrictEqual([{ x: 490, y: 340 }, { x: 490, y: 480 }, { x: 290, y: 480 }, { x: 290, y: 340 }])
    expect(frame?.flowDrag?.movingVisualOwner).toBe('preview-runtime')
  })
  it('projects the literal active resize quad through the captured camera exactly once', () => {
    const captured = authority()
    const presentation = resize()
    const frame = projectHudFrame({ authority: captured, view: view(captured), resizePresentation: presentation, resizeFence: captured.start })
    const entry = frame?.byNodeId.selected

    expect(entry?.worldQuad).toStrictEqual(worldQuad)
    expect(entry?.screenQuad).toStrictEqual([{ x: 470, y: 300 }, { x: 470, y: 440 }, { x: 270, y: 440 }, { x: 270, y: 300 }])
    expect(entry?.screenAabb).toStrictEqual({ x: 270, y: 300, width: 200, height: 140 })
    // Independent negative control: the semantic dimensions are not the transformed world AABB (100 x 70).
    expect(entry?.dimensions).toStrictEqual({ width: 35, height: 50 })
    expect(entry?.label.start).toStrictEqual({ x: 270, y: 300 })
    expect(entry?.label.end).toStrictEqual({ x: 470, y: 300 })
    expect(entry?.label.origin.y).toBe(293)
    expect(entry?.dimension).toStrictEqual({ anchor: { x: 370, y: 446 }, width: 35, height: 50 })
    expect(frame && Object.isFrozen(frame) && Object.isFrozen(frame.key.camera) && Object.isFrozen(entry) && Object.isFrozen(entry?.screenQuad[0])).toBe(true)
    expect(Object.isFrozen(presentation.items[0]!.world.quad)).toBe(false)
  })

  it('keeps mobile handles at 12 CSS pixels under a different camera and zoom', () => {
    const mobileCamera = { x: -5, y: 10, zoom: 0.5 }
    const mobileSize = { width: 390, height: 844 }
    const captured = authority({ camera: mobileCamera, size: mobileSize })
    const frame = projectHudFrame({ authority: captured, view: view(captured, { mobile: true }), resizePresentation: resize(), resizeFence: captured.start })
    const entry = frame?.byNodeId.selected

    expect(entry?.screenQuad).toStrictEqual([{ x: 205, y: 437 }, { x: 205, y: 472 }, { x: 155, y: 472 }, { x: 155, y: 437 }])
    expect(entry?.screenAabb).toStrictEqual({ x: 155, y: 437, width: 50, height: 35 })
    expect(entry?.handles.map(handle => handle.size)).toStrictEqual([12, 12, 12, 12, 12, 12, 12, 12])
    expect(entry?.handles[0].rect).toStrictEqual({ x: 199, y: 431, width: 12, height: 12 })
  })

  it.each([
    ['zero', [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 50 }, { x: 10, y: 50 }], [{ x: 430, y: 320 }, { x: 510, y: 320 }, { x: 510, y: 380 }, { x: 430, y: 380 }]],
    ['ninety', [{ x: 50, y: 20 }, { x: 50, y: 60 }, { x: 20, y: 60 }, { x: 20, y: 20 }], [{ x: 510, y: 320 }, { x: 510, y: 400 }, { x: 450, y: 400 }, { x: 450, y: 320 }]],
    ['one-eighty', [{ x: 50, y: 50 }, { x: 10, y: 50 }, { x: 10, y: 20 }, { x: 50, y: 20 }], [{ x: 510, y: 380 }, { x: 430, y: 380 }, { x: 430, y: 320 }, { x: 510, y: 320 }]],
    ['reflected', [{ x: 50, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 50 }, { x: 50, y: 50 }], [{ x: 510, y: 320 }, { x: 430, y: 320 }, { x: 430, y: 380 }, { x: 510, y: 380 }]],
  ] as const)('preserves semantic q-index handles for %s geometry', (name, points, expectedQ) => {
    const captured = authority()
    const quad = points as unknown as HudQuad
    const frame = projectHudFrame({ authority: captured, view: view(captured), resizePresentation: resize(quad, 'top-left'), resizeFence: captured.start })
    const entry = frame?.byNodeId.selected

    expect(entry?.handles.map(handle => handle.anchor)).toStrictEqual(['q0', 'q0-q1', 'q1', 'q1-q2', 'q2', 'q2-q3', 'q3', 'q3-q0'])
    expect(entry?.handles[0].center).toStrictEqual(expectedQ[0])
    expect(entry?.handles[2].center).toStrictEqual(expectedQ[1])
    expect(entry?.handles[4].center).toStrictEqual(expectedQ[2])
    expect(entry?.handles[6].center).toStrictEqual(expectedQ[3])
    if (name === 'reflected') {
      expect(entry?.label).toMatchObject({ start: { x: 430, y: 320 }, end: { x: 510, y: 320 }, normal: { x: 0, y: -1 }, origin: { x: 430, y: 313 }, angle: 0, maxWidth: 80 })
      expect(entry?.dimension).toStrictEqual({ anchor: { x: 470, y: 386 }, width: 35, height: 50 })
    }
  })

  it('moves only the active handle identity after crossing without relabeling screen poses', () => {
    const captured = authority()
    const before = projectHudFrame({ authority: captured, view: view(captured), resizePresentation: resize(worldQuad, 'bottom-right'), resizeFence: captured.start })!
    const crossed = projectHudFrame({ authority: captured, view: view(captured), resizePresentation: resize(worldQuad, 'top-left'), resizeFence: captured.start })!

    expect(crossed.byNodeId.selected!.handles.map(handle => [handle.anchor, handle.center])).toStrictEqual(before.byNodeId.selected!.handles.map(handle => [handle.anchor, handle.center]))
    expect(before.byNodeId.selected!.handles.find(handle => handle.active)?.handle).toBe('bottom-right')
    expect(crossed.byNodeId.selected!.handles.find(handle => handle.active)?.handle).toBe('top-left')
    expect(crossed.byNodeId.selected!.effectiveHandle).toBe('top-left')
  })

  it('uses the verified measured matrix chain for idle geometry instead of rect plus authored rotation', () => {
    const captured = authority()
    const entry = projectHudFrame({ authority: captured, view: view(captured) })?.byNodeId.selected

    expect(entry?.worldQuad).toStrictEqual(worldQuad)
    // A rect-plus-rotation reconstruction from measurement.rect would start at the AABB corner.
    expect(entry?.worldQuad[0]).not.toStrictEqual({ x: -70, y: 10 })
  })

  it('proves a nested primitive-border-transform chain and Component identity with literal quads', () => {
    const captured = nestedAuthority()
    const frame = projectHudFrame({ authority: captured, view: view(captured) })

    expect(frame?.byNodeId.parent?.worldQuad).toStrictEqual([{ x: 10, y: 20 }, { x: 10, y: 120 }, { x: -90, y: 120 }, { x: -90, y: 20 }])
    expect(frame?.byNodeId.selected?.worldQuad).toStrictEqual([{ x: 1, y: 28 }, { x: 1, y: 48 }, { x: -9, y: 48 }, { x: -9, y: 28 }])
    expect(frame?.byNodeId.selected?.screenQuad).toStrictEqual([{ x: 412, y: 336 }, { x: 412, y: 376 }, { x: 392, y: 376 }, { x: 392, y: 336 }])
    expect(frame?.byNodeId.selected?.dimensions).toStrictEqual({ width: 20, height: 10 })
  })

  it('PAPER-TEXT-004 accepts subpixel rounding but rejects meaningful geometry drift', () => {
    const rounded = authority()
    rounded.scene.byId.get('selected')!.rect.x += 0.00001

    const roundedFrame = projectHudFrame({ authority: rounded, view: view(rounded) })

    expect(roundedFrame?.byNodeId.selected?.worldAabb).toStrictEqual(worldAabb)

    const drifted = authority()
    drifted.scene.byId.get('selected')!.rect.x += 0.51

    expect(projectHudFrame({ authority: drifted, view: view(drifted) })).toBeNull()
  })

  it('rejects the whole nested frame for missing ancestors, identity drift, topology drift, and cycles', () => {
    const missingAncestor = nestedAuthority()
    delete missingAncestor.geometry.nodes.parent

    const identityDrift = nestedAuthority()
    identityDrift.geometry.nodes.selected!.componentId = 'other-card'

    const topologyDrift = nestedAuthority()
    topologyDrift.geometry.nodes.selected!.offsetParentNodeId = null

    const cycle = nestedAuthority()
    cycle.file.relationships.parent = { parentId: 'selected', orderKey: 'V' }
    cycle.geometry.nodes.parent!.offsetParentNodeId = 'selected'
    cycle.scene.byId.get('parent')!.parentId = 'selected'

    expect([missingAncestor, identityDrift, topologyDrift, cycle].map(snapshot => projectHudFrame({ authority: snapshot, view: view(snapshot) }))).toStrictEqual([null, null, null, null])
  })

  it('emits passive chrome but zero interactive controls for locked and read-only nodes', () => {
    const locked = authority({ locked: true })
    const lockedEntry = projectHudFrame({ authority: locked, view: view(locked) })?.byNodeId.selected
    expect(lockedEntry?.policy).toMatchObject({ selected: true, locked: true, showOutline: true, showDimensions: true, showHandles: false, showQuickActions: false })
    expect(lockedEntry?.handles).toHaveLength(8)
    expect(lockedEntry?.controls).toStrictEqual([])

    const captured = authority()
    const readOnlyEntry = projectHudFrame({ authority: captured, view: view(captured, { readOnly: true, mobile: true }) })?.byNodeId.selected
    expect(readOnlyEntry?.policy).toMatchObject({ selected: true, readOnly: true, showOutline: true, showDimensions: true, showHandles: false, showQuickActions: false })
    expect(readOnlyEntry?.controls).toStrictEqual([])
  })

  it('rejects camera, size, selection, and every revision fence drift for the entire frame', () => {
    const captured = authority()
    const current = view(captured)
    const drifts: HudProjectionView[] = [
      { ...current, fileId: 'other' },
      { ...current, pageId: 'other-page' },
      { ...current, fileRevision: fileRevision + 1 },
      { ...current, measurementRevision: measurementRevision + 1 },
      { ...current, documentRevision: fileRevision + 1 },
      { ...current, layoutGeneration: layoutGeneration + 1 },
      { ...current, camera: { ...camera, x: camera.x + 1 } },
      { ...current, size: { ...size, width: size.width + 1 } },
      { ...current, selection: [] },
    ]
    expect(drifts.map(drift => projectHudFrame({ authority: captured, view: drift, resizePresentation: resize(), resizeFence: captured.start }))).toStrictEqual(Array.from({ length: drifts.length }, () => null))
  })

  it('requires an exact pointer-down fence for every active resize presentation', () => {
    const captured = authority()
    const presentation = resize()
    expect(projectHudFrame({ authority: captured, view: view(captured), resizePresentation: presentation })).toBeNull()
    expect(projectHudFrame({
      authority: captured,
      view: view(captured),
      resizePresentation: presentation,
      resizeFence: { ...captured.start, measurementRevision: captured.start.measurementRevision - 1 },
    })).toBeNull()
  })

  it('deep-freezes detached output without freezing or mutating authority, view, fence, or presentation inputs', () => {
    const captured = authority()
    const current = view(captured)
    const presentation = resize()
    const inputs = [captured, captured.file, captured.camera, captured.size, captured.start, current, current.camera, current.size, presentation, presentation.items[0], presentation.items[0]!.world.quad, presentation.items[0]!.world.quad[0]]
    expect(inputs.map(Object.isFrozen)).toStrictEqual(inputs.map(() => false))

    const frame = projectHudFrame({ authority: captured, view: current, resizePresentation: presentation, resizeFence: captured.start })

    expect(frame && Object.isFrozen(frame) && Object.isFrozen(frame.byNodeId.selected?.handles[0]?.rect)).toBe(true)
    expect(inputs.map(Object.isFrozen)).toStrictEqual(inputs.map(() => false))
    expect(captured.camera).toStrictEqual(camera)
    expect(current.camera).toStrictEqual(camera)
    expect(presentation.items[0]!.world.quad).toStrictEqual(worldQuad)
  })

  it('rejects missing, non-finite, singular, stale, and incomplete measured geometry', () => {
    const missingAabb = measurement()
    delete missingAabb.worldAabb
    const missingChain = measurement()
    delete missingChain.offsetParentToRoot
    const invalidMeasurements = [
      missingAabb,
      measurement({ worldAabb: { ...worldAabb, x: Number.NaN } }),
      measurement({ offsetParentToRoot: [0, 0, 0, 1, 0, 0] }),
      measurement({ documentRevision: fileRevision - 1 }),
      missingChain,
    ]
    expect(invalidMeasurements.map(measured => {
      const captured = authority({ measurement: measured })
      return projectHudFrame({ authority: captured, view: view(captured) })
    })).toStrictEqual([null, null, null, null, null])

    const captured = authority()
    const corrupt = resize([{ x: Number.NaN, y: 10 }, worldQuad[1], worldQuad[2], worldQuad[3]])
    expect(projectHudFrame({ authority: captured, view: view(captured), resizePresentation: corrupt, resizeFence: captured.start })).toBeNull()
  })

  it('rejects resize maps that are not the exact item identity set', () => {
    const captured = authority()
    const projected = resize()
    const copied = { ...projected.items[0]! }
    const mutated: ResizePresentation = { ...projected, byNodeId: { selected: copied } }
    expect(projectHudFrame({ authority: captured, view: view(captured), resizePresentation: mutated, resizeFence: captured.start })).toBeNull()

    const wrongParent = { ...projected.items[0]!, parentId: 'other-root' }
    expect(projectHudFrame({ authority: captured, view: view(captured), resizePresentation: { ...projected, items: [wrongParent], byNodeId: { selected: wrongParent } }, resizeFence: captured.start })).toBeNull()

    const wrongAabb = { ...projected.items[0]!, world: { ...projected.items[0]!.world, aabb: { ...worldAabb, width: worldAabb.width + 1 } } }
    expect(projectHudFrame({ authority: captured, view: view(captured), resizePresentation: { ...projected, items: [wrongAabb], byNodeId: { selected: wrongAabb } }, resizeFence: captured.start })).toBeNull()
  })
})
