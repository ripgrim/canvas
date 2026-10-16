import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { beginPaperFlowDrag, samplePaperFlowDrag } from './flow-drag-state'
import type { PaperFlowDragState } from './flow-drag-state'
import { captureGestureAuthority } from './gesture-authority'
import type { SceneGeometry } from './scene-geometry'
import { buildFlowDragPresentationAuthority, captureFlowDragAuthorityMeasurement } from './flow-drag-authority'
import type { BuildFlowDragPresentationAuthorityInput, FlowDragAuthorityMeasurementProof } from './flow-drag-authority'
import { projectFlowDragPresentation } from './flow-drag-presentation'
import { resolveFlowDragTarget } from './flow-drag-target'
import type { GestureAuthoritySnapshot } from './gesture-authority'

const fence = { fileId: 'authority-file', fileRevision: 7, measurementRevision: 19, documentRevision: 7, layoutGeneration: 11 } as const
const sourceGeometry = {
  coordinateSpace: 'world' as const,
  quad: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 50 }, { x: 10, y: 50 }] as const,
  aabb: { x: 10, y: 20, width: 40, height: 30 },
  semanticSize: { width: 40, height: 30 },
}
const currentGeometry = {
  coordinateSpace: 'world' as const,
  quad: [{ x: 110, y: 70 }, { x: 150, y: 70 }, { x: 150, y: 100 }, { x: 110, y: 100 }] as const,
  aabb: { x: 110, y: 70, width: 40, height: 30 },
  semanticSize: { width: 40, height: 30 },
}
const targetGeometry = {
  coordinateSpace: 'world' as const,
  quad: [{ x: 200, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 250 }, { x: 200, y: 250 }] as const,
  aabb: { x: 200, y: 100, width: 200, height: 150 },
  semanticSize: { width: 200, height: 150 },
}

function file(): FileDocument {
  return {
    schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
    fileId: 'authority-file',
    revision: 7,
    pages: [{ id: 'page', name: 'Page 1', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      'source-parent': { id: 'source-parent', type: 'frame', name: 'Source', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 180, height: 100 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
      node: { id: 'node', type: 'rectangle', name: 'Card', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 }, layout: { item: { position: { mode: 'flow' } } } },
      'target-parent': { id: 'target-parent', type: 'frame', name: 'Target', styles: { relativeTransform: [1, 0, 0, 1, 200, 100], width: 200, height: 150 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
      'target-child': { id: 'target-child', type: 'rectangle', name: 'Existing', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 }, layout: { item: { position: { mode: 'flow' } } } },
    },
    relationships: {
      'source-parent': { parentId: 'root', orderKey: 'F' },
      node: { parentId: 'source-parent', orderKey: 'V' },
      'target-parent': { parentId: 'root', orderKey: 'f' },
      'target-child': { parentId: 'target-parent', orderKey: 'V' },
    },
    theme: { tokens: {} },
  }
}

function geometry(): SceneGeometry {
  return {
    revision: 19,
    documentRevision: 7,
    layoutGeneration: 11,
    unsupported: {},
    themeUnsupported: {},
    unownedPortals: 0,
    nodes: {
      'source-parent': { canvasKind: 'frame', documentRevision: 7, layoutGeneration: 11, rect: { x: 0, y: 0, width: 180, height: 100 }, worldAabb: { x: 0, y: 0, width: 180, height: 100 }, offset: { x: 0, y: 0, width: 180, height: 100, origin: { x: 90, y: 50 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true, box: { padding: { top: 0, right: 0, bottom: 0, left: 0 }, border: { top: 0, right: 0, bottom: 0, left: 0 } } },
      node: { canvasKind: 'rectangle', documentRevision: 7, layoutGeneration: 11, rect: { x: 10, y: 20, width: 40, height: 30 }, worldAabb: { x: 10, y: 20, width: 40, height: 30 }, offset: { x: 10, y: 20, width: 40, height: 30, origin: { x: 20, y: 15 } }, offsetParentNodeId: 'source-parent', directChild: true, transform: [1, 0, 0, 1, 0, 0] },
      'target-parent': { canvasKind: 'frame', documentRevision: 7, layoutGeneration: 11, rect: { x: 200, y: 100, width: 200, height: 150 }, worldAabb: { x: 200, y: 100, width: 200, height: 150 }, offset: { x: 200, y: 100, width: 200, height: 150, origin: { x: 100, y: 75 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true },
      'target-child': { canvasKind: 'rectangle', documentRevision: 7, layoutGeneration: 11, rect: { x: 100, y: 60, width: 40, height: 30 }, worldAabb: { x: 100, y: 60, width: 40, height: 30 }, offset: { x: 100, y: 60, width: 40, height: 30, origin: { x: 20, y: 15 } }, offsetParentNodeId: 'target-parent', directChild: true },
    },
  }
}

function snapshot(sourceFile = file(), sourceGeometry = geometry()) {
  return captureGestureAuthority(() => ({
    file: sourceFile,
    pageId: 'page',
    atoms: [],
    layoutGeneration: 11,
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportSize: { width: 1200, height: 800 },
    selection: ['node'],
  }), () => sourceGeometry)!
}

function flowState(authority: GestureAuthoritySnapshot, options: { absolute?: boolean; clone?: boolean; target?: boolean } = {}): PaperFlowDragState {
  const started = beginPaperFlowDrag({
    nodeId: 'node',
    pointerDownWorld: { x: 20, y: 25 },
    pointerDownViewport: { x: 100, y: 100 },
    pointerDownTime: 1_000,
    sourceRelationship: { parentId: 'source-parent', orderKey: 'V', slot: { presence: 'absent' } },
    sourceIndex: 0,
    gestureGeneration: 5,
    selectionDepthPrimary: false,
    fence,
  })!
  const sampled = samplePaperFlowDrag(started, {
    world: { x: 120, y: 75 },
    viewport: { x: 200, y: 150 },
    timestamp: 1_100,
    modifiers: { altKey: options.absolute && options.clone ? false : options.clone ?? false, ctrlKey: options.absolute ?? false, metaKey: false },
    platform: 'windows',
    authority: { ...fence, gestureGeneration: 5, owned: true },
    resolveTarget: edge => options.target === false ? null : resolveFlowDragTarget({ authority, state: edge, hoveredNodeId: 'target-parent' }),
  })!
  if (!options.absolute || !options.clone) return sampled
  return samplePaperFlowDrag(sampled, {
    world: { x: 120, y: 75 },
    viewport: { x: 200, y: 150 },
    timestamp: 1_120,
    modifiers: { altKey: true, ctrlKey: true, metaKey: false },
    platform: 'windows',
    authority: { ...fence, gestureGeneration: 5, owned: true },
    entryGeometry: { x: 10, y: 20, width: 40, height: 30 },
    resolveTarget: edge => options.target === false ? null : resolveFlowDragTarget({ authority, state: edge, hoveredNodeId: 'target-parent' }),
  })!
}

function measurement(state: PaperFlowDragState): FlowDragAuthorityMeasurementProof {
  return {
    fence: { ...fence, pageId: 'page', pageRootId: 'root' },
    nodeId: 'node',
    source: structuredClone(sourceGeometry),
    current: structuredClone(currentGeometry),
    sourceOffsetParent: {
      offsetParentNodeId: 'source-parent',
      paddingToWorld: [1, 0, 0, 1, 0, 0],
      sourceParentLocal: [1, 0, 0, 1, 10, 20],
    },
    currentParentLocal: state.originalMode === 'absolute' ? [1, 0, 0, 1, 110, 70] : null,
    clone: state.clone ? {
      role: 'inert-marker',
      layoutParticipation: 'none',
      generation: state.clone.generation,
      entryMode: state.clone.entryMode,
      entryRect: state.clone.entryGeometry ? { coordinateSpace: 'parent-padding', ...state.clone.entryGeometry } : null,
      world: structuredClone(state.clone.entryMode === 'absolute' ? currentGeometry : sourceGeometry),
    } : null,
    target: state.target ? {
      parentId: 'target-parent',
      outline: structuredClone(targetGeometry),
      insertionGuide: structuredClone(state.target.guideWorld),
    } : null,
  }
}

function input(options: { absolute?: boolean; clone?: boolean; target?: boolean; sourceFile?: FileDocument; sourceGeometry?: SceneGeometry } = {}): BuildFlowDragPresentationAuthorityInput {
  const authority = snapshot(options.sourceFile, options.sourceGeometry)
  const state = flowState(authority, options)
  return {
    snapshot: authority,
    state,
    interactionId: 'interaction-9',
    retention: { kind: 'active', gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence },
    reducedMotion: false,
    measurement: measurement(state),
  }
}

function componentSourceInput(): BuildFlowDragPresentationAuthorityInput {
  const sourceFile = file()
  sourceFile.nodes['source-parent'] = {
    id: 'source-parent', type: 'component', componentId: 'source-container', exportName: 'SourceContainer', name: 'Source', props: {},
    layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
  }
  sourceFile.nodes.node = {
    id: 'node', type: 'component', componentId: 'card-component', exportName: 'Card', name: 'Card', props: {},
    layout: { item: { position: { mode: 'flow' } } },
  }
  const measured = geometry()
  const { canvasKind: _parentCanvasKind, ...parentMeasurement } = measured.nodes['source-parent']!
  measured.nodes['source-parent'] = { ...parentMeasurement, componentId: 'source-container', parentInstanceId: null }
  const { canvasKind: _nodeCanvasKind, ...nodeMeasurement } = measured.nodes.node!
  measured.nodes.node = { ...nodeMeasurement, componentId: 'card-component', parentInstanceId: 'source-parent' }
  return input({ sourceFile, sourceGeometry: measured, target: false })
}

function componentTargetInput(): BuildFlowDragPresentationAuthorityInput {
  const sourceFile = file()
  sourceFile.nodes['target-parent'] = {
    id: 'target-parent', type: 'component', componentId: 'target-container', exportName: 'TargetContainer', name: 'Target', props: {},
    layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
  }
  const measured = geometry()
  const { canvasKind: _canvasKind, ...targetMeasurement } = measured.nodes['target-parent']!
  measured.nodes['target-parent'] = { ...targetMeasurement, componentId: 'target-container', parentInstanceId: null }
  return input({ sourceFile, sourceGeometry: measured })
}

function descriptorFingerprint(value: unknown, seen = new Map<object, number>()): unknown {
  if (value === null || typeof value !== 'object') return value
  const prior = seen.get(value)
  if (prior !== undefined) return { reference: prior }
  const id = seen.size
  seen.set(value, id)
  return {
    id,
    frozen: Object.isFrozen(value),
    keys: Reflect.ownKeys(value).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      return {
        key: typeof key === 'symbol' ? key.toString() : key,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
        kind: 'value' in descriptor ? 'data' : 'accessor',
        ...('value' in descriptor ? { writable: descriptor.writable, value: descriptorFingerprint(descriptor.value, seen) } : { get: descriptor.get, set: descriptor.set }),
      }
    }),
  }
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    expect('value' in descriptor).toBe(true)
    if ('value' in descriptor) expectDeepFrozen(descriptor.value, seen)
  }
}

describe('PAPER-FLEX-006-C5-AUTHORITY, AT-CAN-005-C5-AUTHORITY, and CLOUD-SYNC-GESTURE-001-C5-AUTHORITY', () => {
  it('captures presentation measurements from the frozen pointer-down authority', () => {
    const authority = snapshot()
    const state = flowState(authority)
    const captured = captureFlowDragAuthorityMeasurement(authority, state)

    expect(captured).toStrictEqual(measurement(state))
    expect(captured).not.toBeNull()
    expectDeepFrozen(captured)
    expect(buildFlowDragPresentationAuthority({
      snapshot: authority,
      state,
      interactionId: 'interaction-9',
      retention: { kind: 'active', gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence },
      reducedMotion: false,
      measurement: captured!,
    })).not.toBeNull()
  })

  it('accepts nested flex geometry inherited from the parent and normalizes sub-pixel DOM rounding', () => {
    const measured = geometry()
    measured.nodes['source-parent']!.box!.padding = { top: 16, right: 16, bottom: 16, left: 16 }
    measured.nodes.node = {
      ...measured.nodes.node!,
      rect: { x: 10.00002, y: 19.99998, width: 39.99997, height: 30.00003 },
      worldAabb: { x: 10.00002, y: 19.99998, width: 39.99997, height: 30.00003 },
    }
    const authority = snapshot(file(), measured)
    const state = flowState(authority)
    const captured = captureFlowDragAuthorityMeasurement(authority, state)

    expect(captured).not.toBeNull()
    expect(captured?.source).toStrictEqual(sourceGeometry)
    expect(buildFlowDragPresentationAuthority({
      snapshot: authority,
      state,
      interactionId: 'interaction-9',
      retention: { kind: 'active', gestureGeneration: state.gestureGeneration, sampleSequence: state.sampleSequence },
      reducedMotion: false,
      measurement: captured!,
    })).not.toBeNull()
  })

  it('refuses to capture when frozen geometry no longer proves the dragged node', () => {
    const staleGeometry = geometry()
    delete staleGeometry.nodes.node
    const authority = snapshot(file(), staleGeometry)
    const state = flowState(authority)

    expect(captureFlowDragAuthorityMeasurement(authority, state)).toBeNull()
  })

  it('builds the literal Paper flow authority from one frozen snapshot and independently specified geometry', () => {
    const source = input()
    const authority = buildFlowDragPresentationAuthority(source)
    expect(authority).not.toBeNull()
    expect(authority!.node).toStrictEqual({
      id: 'node',
      documentKind: 'rectangle',
      sceneKind: 'rectangle',
      documentName: 'Card',
      sceneName: 'Card',
      sourceRelationship: { parentId: 'source-parent', orderKey: 'V', slot: { presence: 'absent' } },
      sourceIndex: 0,
      source: sourceGeometry,
      current: currentGeometry,
      absolutePose: null,
    })
    expect(authority!.target).toStrictEqual({
      parentId: 'target-parent', parentIsRoot: false, slotPresence: 'absent', slotValue: null,
      rawIndex: 0, semanticIndex: 0, line: 0, parentWorld: targetGeometry,
      guideWorld: { axis: 'x', position: 140, start: 60, end: 90 },
    })
    expect(authority!.contract).toStrictEqual({
      ghost: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 },
      flowOriginal: { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null },
      elevatedOriginal: { treatment: 'drag-elevated', opacity: 0.6, opacityPriority: 'normal', zIndex: 1000000 },
      unchangedOriginal: { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
      target: { color: 'oklch(0.67 0.17 258)', outlineWidthCssPx: 2, guideWidthCssPx: 4, guideStyle: 'solid' },
      hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
      mobileQuickActions: { mounted: true, hidden: true, inert: true, wonderDurationMs: 150, reducedMotionDurationMs: 0 },
    })
    expect(projectFlowDragPresentation({ state: source.state, authority: authority!, publicationIdentity: authority!.publicationIdentity })).not.toBeNull()
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority!.node.current.quad[0])).toBe(true)
    expectDeepFrozen(authority)
  })

  it('accepts exact primitive and Component measured topology', () => {
    const primitive = input()
    expect(primitive.snapshot.geometry.nodes.node).toMatchObject({ canvasKind: 'rectangle', directChild: true, offsetParentNodeId: 'source-parent' })
    expect(buildFlowDragPresentationAuthority(primitive)).not.toBeNull()

    const componentSource = componentSourceInput()
    expect(componentSource.snapshot.geometry.nodes.node).toMatchObject({
      componentId: 'card-component', parentInstanceId: 'source-parent', directChild: true, offsetParentNodeId: 'source-parent',
    })
    expect(buildFlowDragPresentationAuthority(componentSource)).not.toBeNull()

    const componentTarget = componentTargetInput()
    expect(componentTarget.snapshot.geometry.nodes['target-parent']).toMatchObject({
      componentId: 'target-container', parentInstanceId: null, directChild: true, offsetParentNodeId: null,
    })
    expect(buildFlowDragPresentationAuthority(componentTarget)).not.toBeNull()
  })

  it('carries an exact detached parent-local affine and terminal retention', () => {
    const base = input({ absolute: true })
    const source: BuildFlowDragPresentationAuthorityInput = { ...base,
      retention: { kind: 'terminal-retained', gestureGeneration: 5, sampleSequence: 1, terminalReason: 'pointer-up', terminalSampleSequence: 1, holdUntil: 'authoritative-geometry' },
      reducedMotion: true,
    }
    const authority = buildFlowDragPresentationAuthority(source)!
    expect(authority.node.absolutePose).toStrictEqual({
      offsetParentNodeId: 'source-parent',
      sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0],
      currentParentLocal: [1, 0, 0, 1, 110, 70],
    })
    expect(authority.retention).toStrictEqual({ kind: 'terminal-retained', gestureGeneration: 5, sampleSequence: 1, terminalReason: 'pointer-up', terminalSampleSequence: 1, holdUntil: 'authoritative-geometry' })
    expect(authority.reducedMotion).toBe(true)
  })

  it('preserves an independently specified rotated quad while proving it from the measured parent-local affine', () => {
    const measured = geometry()
    measured.nodes.node = {
      ...measured.nodes.node!,
      rect: { x: 10, y: 20, width: 40, height: 30 },
      worldAabb: { x: 15, y: 15, width: 30, height: 40 },
      transform: [0, 1, -1, 0, 0, 0],
    }
    const source: any = input({ sourceGeometry: measured })
    source.measurement.source = {
      coordinateSpace: 'world',
      quad: [{ x: 45, y: 15 }, { x: 45, y: 55 }, { x: 15, y: 55 }, { x: 15, y: 15 }],
      aabb: { x: 15, y: 15, width: 30, height: 40 },
      semanticSize: { width: 40, height: 30 },
    }
    source.measurement.current = {
      coordinateSpace: 'world',
      quad: [{ x: 145, y: 65 }, { x: 145, y: 105 }, { x: 115, y: 105 }, { x: 115, y: 65 }],
      aabb: { x: 115, y: 65, width: 30, height: 40 },
      semanticSize: { width: 40, height: 30 },
    }
    source.measurement.sourceOffsetParent.sourceParentLocal = [0, 1, -1, 0, 45, 15]
    const authority = buildFlowDragPresentationAuthority(source)!
    expect(authority.node.source.quad).toStrictEqual([{ x: 45, y: 15 }, { x: 45, y: 55 }, { x: 15, y: 55 }, { x: 15, y: 15 }])
    expect(authority.node.current.aabb).toStrictEqual({ x: 115, y: 65, width: 30, height: 40 })
  })

  it('accepts a reflected detached parent and proves the exact reflected current parent-local affine', () => {
    const measured = geometry()
    measured.nodes.node = {
      ...measured.nodes.node!,
      worldAabb: { x: 250, y: 20, width: 40, height: 30 },
      offsetParentToRoot: [-1, 0, 0, 1, 300, 0],
    }
    const source: any = input({ absolute: true, sourceGeometry: measured })
    source.measurement.source = {
      coordinateSpace: 'world',
      quad: [{ x: 290, y: 20 }, { x: 250, y: 20 }, { x: 250, y: 50 }, { x: 290, y: 50 }],
      aabb: { x: 250, y: 20, width: 40, height: 30 },
      semanticSize: { width: 40, height: 30 },
    }
    source.measurement.current = {
      coordinateSpace: 'world',
      quad: [{ x: 390, y: 70 }, { x: 350, y: 70 }, { x: 350, y: 100 }, { x: 390, y: 100 }],
      aabb: { x: 350, y: 70, width: 40, height: 30 },
      semanticSize: { width: 40, height: 30 },
    }
    source.measurement.sourceOffsetParent.paddingToWorld = [-1, 0, 0, 1, 300, 0]
    source.measurement.currentParentLocal = [1, 0, 0, 1, -90, 70]
    const authority = buildFlowDragPresentationAuthority(source)!
    expect(authority.node.absolutePose).toStrictEqual({
      offsetParentNodeId: 'source-parent',
      sourceOffsetParentPaddingToWorld: [-1, 0, 0, 1, 300, 0],
      currentParentLocal: [1, 0, 0, 1, -90, 70],
    })
    expect(authority.node.current.quad).toStrictEqual([{ x: 390, y: 70 }, { x: 350, y: 70 }, { x: 350, y: 100 }, { x: 390, y: 100 }])
  })

  it('builds only the exact inert clone marker tied to the state generation', () => {
    const source = input({ clone: true })
    const authority = buildFlowDragPresentationAuthority(source)!
    expect(authority.clone).toStrictEqual({
      role: 'inert-marker', layoutParticipation: 'none', generation: 1,
      sourceRelationship: { parentId: 'source-parent', orderKey: 'V', slot: { presence: 'absent' } },
      sourceIndex: 0, entryMode: 'flow', entryRect: null, world: sourceGeometry,
    })
  })

  it('builds the absolute clone with its exact Alt-edge parent-padding entry rectangle', () => {
    const source = input({ absolute: true, clone: true })
    const authority = buildFlowDragPresentationAuthority(source)!
    expect(authority.clone).toStrictEqual({
      role: 'inert-marker', layoutParticipation: 'none', generation: 1,
      sourceRelationship: { parentId: 'source-parent', orderKey: 'V', slot: { presence: 'absent' } },
      sourceIndex: 0, entryMode: 'absolute',
      entryRect: { coordinateSpace: 'parent-padding', x: 10, y: 20, width: 40, height: 30 },
      world: currentGeometry,
    })
  })

  it.each([
    ['document fence', (source: any) => { source.measurement.fence.documentRevision = 6 }],
    ['layout fence', (source: any) => { source.measurement.fence.layoutGeneration = 10 }],
    ['measurement fence', (source: any) => { source.measurement.fence.measurementRevision = 18 }],
    ['page fence', (source: any) => { source.measurement.fence.pageId = 'other' }],
    ['page root fence', (source: any) => { source.measurement.fence.pageRootId = 'other-root' }],
    ['source topology', (source: any) => { source.snapshot.file.relationships.node.orderKey = 'W' }],
    ['target topology', (source: any) => { source.snapshot.file.relationships['target-parent'].parentId = 'source-parent' }],
    ['current quad proof', (source: any) => { source.measurement.current.quad[0].x = 111 }],
    ['source matrix proof', (source: any) => { source.measurement.sourceOffsetParent.sourceParentLocal[4] = 11 }],
    ['singular parent matrix', (source: any) => { source.measurement.sourceOffsetParent.paddingToWorld[3] = 0 }],
    ['nonfinite matrix', (source: any) => { source.measurement.sourceOffsetParent.paddingToWorld[4] = Number.NaN }],
    ['stale guide', (source: any) => { source.measurement.target.insertionGuide = { axis: 'x', position: 221, start: 110, end: 210 } }],
  ])('fails closed on stale or invalid %s evidence', (_name, change) => {
    const source = input()
    change(source)
    expect(buildFlowDragPresentationAuthority(source)).toBeNull()
  })

  it('rejects one-field and same-AABB forged target quads', () => {
    const oneField: any = input()
    oneField.measurement.target.outline.quad[0].x += 1
    expect(buildFlowDragPresentationAuthority(oneField)).toBeNull()

    const sameAabb: any = input()
    sameAabb.measurement.target.outline.quad = [
      { x: 300, y: 100 }, { x: 400, y: 175 }, { x: 300, y: 250 }, { x: 200, y: 175 },
    ]
    expect(sameAabb.measurement.target.outline.aabb).toStrictEqual({ x: 200, y: 100, width: 200, height: 150 })
    expect(buildFlowDragPresentationAuthority(sameAabb)).toBeNull()
  })

  it('rejects an authored absolute source even while the captured gesture has primary detach active', () => {
    const source = input({ absolute: true })
    const node = source.snapshot.file.nodes.node
    if (node && node.type !== 'root') node.layout = { ...node.layout, item: { ...node.layout?.item, position: { mode: 'absolute' } } }
    expect(buildFlowDragPresentationAuthority(source)).toBeNull()
  })

  it('rejects source measured topology drift', () => {
    const directChild: any = input()
    directChild.snapshot.geometry.nodes.node.directChild = false
    expect(buildFlowDragPresentationAuthority(directChild)).toBeNull()

    const primitiveKind: any = input()
    primitiveKind.snapshot.geometry.nodes.node.canvasKind = 'text'
    expect(buildFlowDragPresentationAuthority(primitiveKind)).toBeNull()

    const componentId: any = componentSourceInput()
    componentId.snapshot.geometry.nodes.node.componentId = 'other-component'
    expect(buildFlowDragPresentationAuthority(componentId)).toBeNull()

    const parentInstanceId: any = componentSourceInput()
    parentInstanceId.snapshot.geometry.nodes.node.parentInstanceId = null
    expect(buildFlowDragPresentationAuthority(parentInstanceId)).toBeNull()
  })

  it('rejects target measured and scene topology drift', () => {
    const directChild: any = input()
    directChild.snapshot.geometry.nodes['target-parent'].directChild = false
    expect(buildFlowDragPresentationAuthority(directChild)).toBeNull()

    const primitiveKind: any = input()
    primitiveKind.snapshot.geometry.nodes['target-parent'].canvasKind = 'rectangle'
    expect(buildFlowDragPresentationAuthority(primitiveKind)).toBeNull()

    const offsetParent: any = input()
    offsetParent.snapshot.geometry.nodes['target-parent'].offsetParentNodeId = 'source-parent'
    expect(buildFlowDragPresentationAuthority(offsetParent)).toBeNull()

    const sceneKind: any = input()
    sceneKind.snapshot.scene.nodes.find((node: { id: string }) => node.id === 'target-parent').kind = 'rectangle'
    expect(buildFlowDragPresentationAuthority(sceneKind)).toBeNull()
  })

  it('rejects a locked descendant in a moved Frame subtree', () => {
    const sourceFile = file()
    sourceFile.nodes.node = { id: 'node', type: 'frame', name: 'Group', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 }, layout: { item: { position: { mode: 'flow' } } } }
    sourceFile.nodes.inner = { id: 'inner', type: 'rectangle', name: 'Inner', isLocked: false, styles: { relativeTransform: [1, 0, 0, 1, 2, 2], width: 10, height: 10 } }
    sourceFile.relationships.inner = { parentId: 'node', orderKey: 'V' }
    const measured = geometry()
    measured.nodes.node = { ...measured.nodes.node!, canvasKind: 'frame' }
    measured.nodes.inner = { canvasKind: 'rectangle', documentRevision: 7, layoutGeneration: 11, rect: { x: 12, y: 22, width: 10, height: 10 }, worldAabb: { x: 12, y: 22, width: 10, height: 10 }, offset: { x: 2, y: 2, width: 10, height: 10, origin: { x: 5, y: 5 } }, offsetParentNodeId: 'node', directChild: true }
    const source = input({ sourceFile, sourceGeometry: measured })
    const inner = source.snapshot.file.nodes.inner
    if (inner && inner.type !== 'root') inner.isLocked = true
    expect(buildFlowDragPresentationAuthority(source)).toBeNull()
  })

  it('rejects a locked descendant in a moved Component subtree', () => {
    const sourceFile = file()
    sourceFile.nodes.node = { id: 'node', type: 'component', componentId: 'group-component', exportName: 'Group', name: 'Group', props: {}, layout: { item: { position: { mode: 'flow' } } } }
    sourceFile.nodes.inner = { id: 'inner', type: 'rectangle', name: 'Inner', styles: { relativeTransform: [1, 0, 0, 1, 2, 2], width: 10, height: 10 } }
    sourceFile.relationships.inner = { parentId: 'node', orderKey: 'V' }
    const measured = geometry()
    const { canvasKind: _canvasKind, ...componentMeasurement } = measured.nodes.node!
    measured.nodes.node = { ...componentMeasurement, componentId: 'group-component', parentInstanceId: null }
    measured.nodes.inner = { canvasKind: 'rectangle', documentRevision: 7, layoutGeneration: 11, rect: { x: 12, y: 22, width: 10, height: 10 }, worldAabb: { x: 12, y: 22, width: 10, height: 10 }, offset: { x: 2, y: 2, width: 10, height: 10, origin: { x: 5, y: 5 } }, offsetParentNodeId: 'node', directChild: true }
    const source = input({ sourceFile, sourceGeometry: measured, target: false })
    expect(buildFlowDragPresentationAuthority(source)).not.toBeNull()
    const inner = source.snapshot.file.nodes.inner
    if (inner && inner.type !== 'root') inner.isLocked = true
    expect(buildFlowDragPresentationAuthority(source)).toBeNull()
  })

  it('fails closed when the source, an ancestor, or the target is locked', () => {
    for (const id of ['node', 'source-parent'] as const) {
      const sourceFile = file()
      const node = sourceFile.nodes[id]
      if (node && node.type !== 'root') node.isLocked = true
      expect(buildFlowDragPresentationAuthority(input({ sourceFile }))).toBeNull()
    }
    const staleTarget = input()
    const target = staleTarget.snapshot.file.nodes['target-parent']
    if (target && target.type !== 'root') target.isLocked = true
    expect(buildFlowDragPresentationAuthority(staleTarget)).toBeNull()
  })

  it('rejects extra, hidden, symbol, and accessor evidence keys before invoking a getter', () => {
    const getter = vi.fn(() => 10)
    const accessor = input()
    Object.defineProperty(accessor.measurement.source.aabb, 'x', { enumerable: true, configurable: true, get: getter })
    expect(buildFlowDragPresentationAuthority(accessor)).toBeNull()
    expect(getter).not.toHaveBeenCalled()

    const extra = input()
    ;(extra.measurement as unknown as Record<string, unknown>).extra = true
    expect(buildFlowDragPresentationAuthority(extra)).toBeNull()

    const hidden = input()
    Object.defineProperty(hidden.measurement, 'hidden', { enumerable: false, value: true })
    expect(buildFlowDragPresentationAuthority(hidden)).toBeNull()

    const symbol = input()
    Object.defineProperty(symbol.measurement, Symbol('hidden'), { enumerable: true, value: true })
    expect(buildFlowDragPresentationAuthority(symbol)).toBeNull()
  })

  it('rejects hostile descriptors and prototypes throughout captured document, geometry, scene, and Map entries without invoking getters', () => {
    const cases: Array<(source: BuildFlowDragPresentationAuthorityInput, getter: () => string) => void> = [
      (source, getter) => Object.defineProperty(source.snapshot.file.nodes.node!, 'name', { enumerable: true, configurable: true, get: getter }),
      (source, getter) => Object.defineProperty(source.snapshot.file.relationships.node!, 'orderKey', { enumerable: true, configurable: true, get: getter }),
      (source, getter) => Object.defineProperty(source.snapshot.geometry.nodes.node!.rect, 'x', { enumerable: true, configurable: true, get: getter }),
      (source, getter) => Object.defineProperty(source.snapshot.scene.nodes.find(node => node.id === 'node')!, 'name', { enumerable: true, configurable: true, get: getter }),
      (source, getter) => source.snapshot.scene.byId.set('poison', Object.defineProperty({}, 'name', { enumerable: true, get: getter }) as never),
      (source, getter) => Object.setPrototypeOf(source.snapshot.file.relationships.node!, Object.defineProperty({}, 'poison', { enumerable: true, get: getter })),
    ]
    for (const poison of cases) {
      const getter = vi.fn(() => 'poison')
      const source = input()
      poison(source, getter)
      expect(buildFlowDragPresentationAuthority(source)).toBeNull()
      expect(getter).not.toHaveBeenCalled()
    }

    const customNode = input()
    Object.setPrototypeOf(customNode.snapshot.file.nodes.node!, { inherited: true })
    expect(buildFlowDragPresentationAuthority(customNode)).toBeNull()

    const hiddenNode = input()
    Object.defineProperty(hiddenNode.snapshot.file.nodes.node!, 'hidden', { enumerable: false, value: true })
    expect(buildFlowDragPresentationAuthority(hiddenNode)).toBeNull()

    const symbolGeometry = input()
    Object.defineProperty(symbolGeometry.snapshot.geometry.nodes.node!, Symbol('hidden'), { enumerable: true, value: true })
    expect(buildFlowDragPresentationAuthority(symbolGeometry)).toBeNull()
  })

  it('does not mutate the snapshot, state, or measurement proof', () => {
    const source = input({ clone: true })
    const measurementBefore = structuredClone(source.measurement)
    const stateBefore = structuredClone(source.state)
    const fileBefore = structuredClone(source.snapshot.file)
    const geometryBefore = structuredClone(source.snapshot.geometry)
    const stateDescriptors = descriptorFingerprint(source.state)
    const measurementDescriptors = descriptorFingerprint(source.measurement)
    const snapshotReference = source.snapshot
    expect(buildFlowDragPresentationAuthority(source)).not.toBeNull()
    expect(source.snapshot).toBe(snapshotReference)
    expect(source.measurement).toStrictEqual(measurementBefore)
    expect(source.state).toStrictEqual(stateBefore)
    expect(source.snapshot.file).toStrictEqual(fileBefore)
    expect(source.snapshot.geometry).toStrictEqual(geometryBefore)
    expect(descriptorFingerprint(source.state)).toStrictEqual(stateDescriptors)
    expect(descriptorFingerprint(source.measurement)).toStrictEqual(measurementDescriptors)
    expectDeepFrozen(source.state)
  })

  it('does not mutate frozen state or proof descriptors when a proof fails', () => {
    const source: any = input()
    source.measurement.current.quad[0].x += 1
    const stateDescriptors = descriptorFingerprint(source.state)
    const measurementDescriptors = descriptorFingerprint(source.measurement)
    const fileDescriptors = descriptorFingerprint(source.snapshot.file)
    expect(buildFlowDragPresentationAuthority(source)).toBeNull()
    expect(descriptorFingerprint(source.state)).toStrictEqual(stateDescriptors)
    expect(descriptorFingerprint(source.measurement)).toStrictEqual(measurementDescriptors)
    expect(descriptorFingerprint(source.snapshot.file)).toStrictEqual(fileDescriptors)
    expectDeepFrozen(source.state)
  })

  it('rejects a merely shallow-frozen state without freezing or otherwise mutating its nested values', () => {
    const source: any = input()
    const shallow = structuredClone(source.state)
    Object.freeze(shallow)
    source.state = shallow
    const nestedBefore = descriptorFingerprint(shallow.currentWorld)
    expect(Object.isFrozen(shallow.currentWorld)).toBe(false)
    expect(buildFlowDragPresentationAuthority(source)).toBeNull()
    expect(Object.isFrozen(shallow.currentWorld)).toBe(false)
    expect(descriptorFingerprint(shallow.currentWorld)).toStrictEqual(nestedBefore)
  })
})
