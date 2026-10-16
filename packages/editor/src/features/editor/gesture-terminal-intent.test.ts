import { describe, expect, it, vi } from 'vitest'
import { applyFileCommand, childrenOf } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { flowInsertIndex } from './canvas-math'
import type { Scene, SceneNode } from './canvas-scene'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import { planGestureCommand } from './gesture-command-planner'
import { deriveGestureTerminalIntent } from './gesture-terminal-intent'
import { beginFlowDrag, sampleFlowDrag } from './flow-drag-state'
import type { FlowDragModifiers, FlowDragState } from './flow-drag-state'
import type { SceneGeometry } from './scene-geometry'
import type { Atom } from './types'

const revision = 17
const measurementRevision = 41
const layoutGeneration = 9
const flex = { direction: 'row' as const, wrap: 'wrap' as const, justify: 'start' as const, align: 'start' as const }

function scene(nodes: readonly SceneNode[]): Scene {
  return { nodes: [...nodes], byId: new Map(nodes.map(node => [node.id, node])) }
}

function authority(file: FileDocument, geometry: SceneGeometry, nodes: readonly SceneNode[], atoms: readonly Atom[] = []): GestureAuthoritySnapshot {
  return {
    file,
    geometry,
    scene: scene(nodes),
    atoms,
    layoutGeneration,
    start: { fileId: file.fileId, fileRevision: revision, measurementRevision, documentRevision: revision, layoutGeneration },
    pageId: 'page',
    camera: { x: 0, y: 0, zoom: 1 },
    size: { width: 1000, height: 700 },
    selection: ['a'],
  }
}

function wrappedAuthority(): GestureAuthoritySnapshot {
  const file: FileDocument = {
    schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
    fileId: 'terminal-wrapped',
    revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      flex: { id: 'flex', type: 'frame', name: 'Flex', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 330, height: 100 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex } } },
      a: { id: 'a', type: 'rectangle', name: 'A', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
      b: { id: 'b', type: 'rectangle', name: 'B', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
      c: { id: 'c', type: 'rectangle', name: 'C', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
      d: { id: 'd', type: 'rectangle', name: 'D', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
      e: { id: 'e', type: 'rectangle', name: 'E', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } },
    },
    relationships: {
      flex: { parentId: 'root', orderKey: 'V' },
      a: { parentId: 'flex', orderKey: 'G' },
      b: { parentId: 'flex', orderKey: 'W' },
      c: { parentId: 'flex', orderKey: 'X' },
      d: { parentId: 'flex', orderKey: 'Y' },
      e: { parentId: 'flex', orderKey: 'Z' },
    },
    theme: { tokens: {} },
  }
  const rectangles = {
    flex: { x: 0, y: 0, width: 330, height: 100 },
    a: { x: 0, y: 0, width: 100, height: 40 },
    b: { x: 110, y: 0, width: 100, height: 40 },
    c: { x: 220, y: 0, width: 100, height: 40 },
    d: { x: 0, y: 50, width: 100, height: 40 },
    e: { x: 110, y: 50, width: 100, height: 40 },
  }
  const geometry: SceneGeometry = {
    revision: measurementRevision,
    documentRevision: revision,
    layoutGeneration,
    unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    nodes: Object.fromEntries(Object.entries(rectangles).map(([id, rect]) => [id, {
      documentRevision: revision,
      layoutGeneration,
      rect,
      worldAabb: rect,
      offset: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, origin: { x: rect.width / 2, y: rect.height / 2 } },
      offsetParentNodeId: id === 'flex' ? null : 'flex',
      ...(id === 'flex' ? { canvasKind: 'frame' as const, offsetParentToRoot: [1, 0, 0, 1, 0, 0] as const, box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } } } : { canvasKind: 'rectangle' as const }),
      directChild: true,
    }])),
  }
  const nodes: SceneNode[] = [
    { id: 'flex', kind: 'frame', name: 'Flex', parentId: null, rect: rectangles.flex, rotation: 0, clip: false, depth: 0, order: 0, flow: false, locked: false },
    ...(['a', 'b', 'c', 'd', 'e'] as const).map((id, index): SceneNode => ({ id, kind: 'rectangle', name: id.toUpperCase(), parentId: 'flex', rect: rectangles[id], rotation: 0, clip: false, depth: 1, order: index + 1, flow: true, locked: false })),
  ]
  return authority(file, geometry, nodes)
}

function componentAuthority(): GestureAuthoritySnapshot {
  const atoms: Atom[] = [
    { name: 'Parent', kind: 'atom', componentId: 'parent-component', path: 'Parent.tsx', exportName: 'Parent', fingerprint: 'parent', sourceHash: 'parent', status: 'bound', candidates: [], slots: ['children'], props: [{ name: 'children', type: 'ReactNode', optional: true }] },
    { name: 'Child A', kind: 'atom', componentId: 'child-a', path: 'ChildA.tsx', exportName: 'ChildA', fingerprint: 'child-a', sourceHash: 'child-a', status: 'bound', candidates: [], props: [] },
    { name: 'Child B', kind: 'atom', componentId: 'child-b', path: 'ChildB.tsx', exportName: 'ChildB', fingerprint: 'child-b', sourceHash: 'child-b', status: 'bound', candidates: [], props: [] },
  ]
  const file: FileDocument = {
    schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'terminal-components', revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      parent: { id: 'parent', type: 'component', componentId: 'parent-component', exportName: 'Parent', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: { ...flex, wrap: 'nowrap' } } } },
      ca: { id: 'ca', type: 'component', componentId: 'child-a', exportName: 'ChildA', props: {}, layout: { item: { position: { mode: 'flow' } } } },
      cb: { id: 'cb', type: 'component', componentId: 'child-b', exportName: 'ChildB', props: {}, layout: { item: { position: { mode: 'flow' } } } },
    },
    relationships: {
      parent: { parentId: 'root', orderKey: 'V' },
      ca: { parentId: 'parent', orderKey: 'V', slot: 'children' },
      cb: { parentId: 'parent', orderKey: 'W', slot: 'children' },
    },
    theme: { tokens: {} },
  }
  const parentRect = { x: 40, y: 30, width: 220, height: 100 }
  const caRect = { x: 50, y: 50, width: 40, height: 40 }
  const cbRect = { x: 100, y: 50, width: 40, height: 40 }
  const geometry: SceneGeometry = {
    revision: measurementRevision, documentRevision: revision, layoutGeneration,
    unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    nodes: {
      parent: { componentId: 'parent-component', documentRevision: revision, layoutGeneration, rect: parentRect, worldAabb: parentRect, offset: { x: 40, y: 30, width: 220, height: 100, origin: { x: 110, y: 50 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], offsetParentInstanceId: null, parentInstanceId: null, directChild: true, box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } } },
      ca: { componentId: 'child-a', documentRevision: revision, layoutGeneration, rect: caRect, worldAabb: caRect, offset: { x: 10, y: 20, width: 40, height: 40, origin: { x: 20, y: 20 } }, offsetParentNodeId: 'parent', offsetParentInstanceId: 'parent', parentInstanceId: 'parent', directChild: true },
      cb: { componentId: 'child-b', documentRevision: revision, layoutGeneration, rect: cbRect, worldAabb: cbRect, offset: { x: 60, y: 20, width: 40, height: 40, origin: { x: 20, y: 20 } }, offsetParentNodeId: 'parent', offsetParentInstanceId: 'parent', parentInstanceId: 'parent', directChild: true },
    },
  }
  return authority(file, geometry, [
    { id: 'parent', kind: 'component', name: 'Parent', parentId: null, rect: parentRect, rotation: 0, clip: false, depth: 0, order: 0, flow: false, locked: false },
    { id: 'ca', kind: 'component', name: 'ChildA', parentId: 'parent', rect: caRect, rotation: 0, clip: false, depth: 1, order: 1, flow: true, locked: false },
    { id: 'cb', kind: 'component', name: 'ChildB', parentId: 'parent', rect: cbRect, rotation: 0, clip: false, depth: 1, order: 2, flow: true, locked: false },
  ], atoms)
}

function rotatedAuthority(): GestureAuthoritySnapshot {
  const file: FileDocument = {
    schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'terminal-rotated', revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      parent: { id: 'parent', type: 'frame', name: 'Parent', styles: { relativeTransform: [0, 1, -1, 0, 400, 0], width: 200, height: 400 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { ...flex, wrap: 'nowrap' } } } },
      a: { id: 'a', type: 'rectangle', name: 'A', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 60, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
    },
    relationships: { parent: { parentId: 'root', orderKey: 'V' }, a: { parentId: 'parent', orderKey: 'V' } },
    theme: { tokens: {} },
  }
  const parentRect = { x: 100, y: -100, width: 200, height: 400 }
  const childRect = { x: 212, y: -70, width: 40, height: 120 }
  const geometry: SceneGeometry = {
    revision: measurementRevision, documentRevision: revision, layoutGeneration,
    unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    nodes: {
      parent: { canvasKind: 'frame', documentRevision: revision, layoutGeneration, rect: parentRect, worldAabb: parentRect, offset: { x: 100, y: 50, width: 200, height: 100, origin: { x: 100, y: 50 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true, transform: [0, 2, -2, 0, 0, 0], box: { border: { top: 20, right: 0, bottom: 0, left: 10 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } } },
      a: { canvasKind: 'rectangle', documentRevision: revision, layoutGeneration, rect: childRect, worldAabb: childRect, offset: { x: 5, y: 4, width: 60, height: 20, origin: { x: 30, y: 10 } }, offsetParentNodeId: 'parent', directChild: true },
    },
  }
  return authority(file, geometry, [
    { id: 'parent', kind: 'frame', name: 'Parent', parentId: null, rect: parentRect, rotation: 90, clip: false, depth: 0, order: 0, flow: false, locked: false },
    { id: 'a', kind: 'rectangle', name: 'A', parentId: 'parent', rect: childRect, rotation: 0, clip: false, depth: 1, order: 1, flow: true, locked: false },
  ])
}

const terminal = { x: 250, y: 70 }
const pointerDown = { x: 50, y: 20 }
const dragState = (nodeId: string, pointerDownWorld: { x: number; y: number }, samples: readonly { world: { x: number; y: number }; modifiers: FlowDragModifiers }[]): FlowDragState => {
  let state = beginFlowDrag(nodeId, pointerDownWorld)!
  for (const sample of samples) state = sampleFlowDrag(state, sample.world, sample.modifiers)!
  return state
}

const derive = (
  source: GestureAuthoritySnapshot,
  nodeId: string,
  pointerDownWorld: { x: number; y: number },
  samples: readonly { world: { x: number; y: number }; modifiers: FlowDragModifiers }[],
) => {
  const state = dragState(nodeId, pointerDownWorld, samples)
  return deriveGestureTerminalIntent({ authority: source, nodeId, pointerDownWorld, terminalWorld: state.currentWorld, dragState: state })
}

describe('Paper Flex terminal intent', () => {
  it('normalizes the measured wrapped gap after removal and applies the exact final reorder', () => {
    const source = wrappedAuthority()
    const resolved = derive(source, 'a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])
    expect(resolved).toStrictEqual({
      intent: { kind: 'reorder', nodeId: 'a', placement: { parentId: 'flex', index: 4 } },
      insertionTarget: { index: 5, line: 1, guide: { axis: 'x', position: 210, start: 50, end: 90 } },
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved!.intent)).toBe(true)
    expect(Object.isFrozen(resolved!.insertionTarget)).toBe(true)
    expect(Object.isFrozen(resolved!.insertionTarget!.guide)).toBe(true)

    const allocate = vi.fn(() => 'unused')
    const plan = planGestureCommand(source, [resolved!.intent], allocate)
    expect(plan!.command).toStrictEqual({ type: 'batch', commands: [{ type: 'node.reorder', nodeId: 'a', index: 4 }] })
    expect(allocate).not.toHaveBeenCalled()
    const next = applyFileCommand(source.file, plan!.command, [])
    expect(childrenOf(next, 'flex')).toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('detects the generic-axis mutation that would place the child in the wrong wrapped line', () => {
    const source = wrappedAuthority()
    const siblings = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, rect: source.geometry.nodes[id]!.rect }))
    expect(flowInsertIndex(terminal, siblings, 'a')).toStrictEqual({ index: 3, axis: 'x' })
    const mutated = planGestureCommand(source, [{ kind: 'reorder', nodeId: 'a', placement: { parentId: 'flex', index: 2 } }], vi.fn())!
    const wrong = applyFileCommand(source.file, mutated.command, [])
    expect(childrenOf(wrong, 'flex')).toEqual(['b', 'c', 'a', 'd', 'e'])
    expect(childrenOf(wrong, 'flex')).not.toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('retains the raw measured gap for Alt duplication', () => {
    const source = wrappedAuthority()
    const resolved = derive(source, 'a', pointerDown, [{ world: terminal, modifiers: { alt: true, primary: false } }])
    expect(resolved).toStrictEqual({
      intent: {
        kind: 'clone-source-and-move-original', nodeId: 'a',
        sourcePlacement: { parentId: 'flex', index: 0 },
        clone: { mode: 'flow' },
        original: { mode: 'flow', placement: { parentId: 'flex', index: 5 } },
      },
      insertionTarget: { index: 5, line: 1, guide: { axis: 'x', position: 210, start: 50, end: 90 } },
    })
    const plan = planGestureCommand(source, [resolved!.intent], id => `copy-${id}`)!
    const next = applyFileCommand(source.file, plan.command, [])
    expect(plan.selection).toEqual(['copy-a'])
    expect(childrenOf(next, 'flex')).toEqual(['a', 'b', 'c', 'd', 'e', 'copy-a'])
  })

  it('accepts Component children and preserves their slot in the placement', () => {
    const source = componentAuthority()
    const resolved = derive(source, 'ca', { x: 60, y: 60 }, [{ world: { x: 200, y: 70 }, modifiers: { alt: true, primary: false } }])
    expect(resolved).toStrictEqual({
      intent: {
        kind: 'clone-source-and-move-original', nodeId: 'ca',
        sourcePlacement: { parentId: 'parent', slot: 'children', index: 0 },
        clone: { mode: 'flow' },
        original: { mode: 'flow', placement: { parentId: 'parent', slot: 'children', index: 2 } },
      },
      insertionTarget: { index: 2, line: 0, guide: { axis: 'x', position: 140, start: 50, end: 90 } },
    })
  })

  it('returns a guide-free parent-padding absolute drop with negative geometry through a rotated and scaled parent', () => {
    const source = rotatedAuthority()
    const resolved = derive(source, 'a', { x: 248, y: -70 }, [{ world: { x: 198, y: -100 }, modifiers: { alt: false, primary: true } }])
    expect(resolved).toStrictEqual({
      intent: { kind: 'absolute-drop', nodeId: 'a', parentId: 'parent', rect: { coordinateSpace: 'parent-padding', x: -10, y: 29, width: 60, height: 20 } },
      insertionTarget: null,
    })
    expect(Object.isFrozen((resolved!.intent as { rect: object }).rect)).toBe(true)
    const plan = planGestureCommand(source, [resolved!.intent], vi.fn())
    expect(plan!.command).toStrictEqual({ type: 'batch', commands: [
      { type: 'node.setLayout', nodeId: 'a', layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: -10 }, top: { kind: 'px', value: 29 } } } } },
      { type: 'node.setStyles', nodeId: 'a', styles: { width: 60, height: 20 } },
    ] })
  })

  it('processes same-sample Alt before primary, leaving the original in flow while the duplicate becomes absolute', () => {
    const source = rotatedAuthority()
    const resolved = derive(source, 'a', { x: 248, y: -70 }, [{ world: { x: 198, y: -100 }, modifiers: { alt: true, primary: true } }])
    expect(resolved).toStrictEqual({
      intent: {
        kind: 'clone-source-and-move-original', nodeId: 'a',
        sourcePlacement: { parentId: 'parent', index: 0 },
        clone: { mode: 'flow' },
        original: { mode: 'absolute', parentId: 'parent', rect: { coordinateSpace: 'parent-padding', x: -10, y: 29, width: 60, height: 20 } },
      },
      insertionTarget: null,
    })
    expect(Object.isFrozen((resolved!.intent as { sourcePlacement: object }).sourcePlacement)).toBe(true)
    const plan = planGestureCommand(source, [resolved!.intent], id => `copy-${id}`)!
    expect(plan.selection).toEqual(['copy-a'])
    expect(plan.command).toStrictEqual({ type: 'batch', commands: [
      { type: 'node.duplicate', nodeId: 'a', ids: { a: 'copy-a' } },
      { type: 'node.setLayout', nodeId: 'copy-a', layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: -10 }, top: { kind: 'px', value: 29 } } } } },
      { type: 'node.setStyles', nodeId: 'copy-a', styles: { width: 60, height: 20 } },
    ] })
    const next = applyFileCommand(source.file, plan.command, [])
    expect(childrenOf(next, 'parent')).toEqual(['a', 'copy-a'])
    expect(next.nodes['copy-a']).toMatchObject({ layout: { item: { position: { mode: 'absolute' } } } })
    expect(next.nodes.a).toMatchObject({ layout: { item: { position: { mode: 'flow' } } } })
  })

  it('captures an absolute clone when primary was already active before Alt', () => {
    const source = rotatedAuthority()
    const resolved = derive(source, 'a', { x: 248, y: -70 }, [
      { world: { x: 220, y: -80 }, modifiers: { alt: false, primary: true } },
      { world: { x: 198, y: -100 }, modifiers: { alt: true, primary: true } },
    ])
    expect(resolved).toStrictEqual({
      intent: {
        kind: 'clone-source-and-move-original', nodeId: 'a',
        sourcePlacement: { parentId: 'parent', index: 0 },
        clone: { mode: 'absolute', rect: { coordinateSpace: 'parent-padding', x: -10, y: 29, width: 60, height: 20 } },
        original: { mode: 'absolute', parentId: 'parent', rect: { coordinateSpace: 'parent-padding', x: -10, y: 29, width: 60, height: 20 } },
      },
      insertionTarget: null,
    })
  })

  it('keeps the absolute clone snapshot when primary releases and returns the original to a measured flow target', () => {
    const source = wrappedAuthority()
    const resolved = derive(source, 'a', pointerDown, [
      { world: { x: 70, y: 25 }, modifiers: { alt: false, primary: true } },
      { world: { x: 90, y: 30 }, modifiers: { alt: true, primary: true } },
      { world: terminal, modifiers: { alt: true, primary: false } },
    ])
    expect(resolved).toStrictEqual({
      intent: {
        kind: 'clone-source-and-move-original', nodeId: 'a',
        sourcePlacement: { parentId: 'flex', index: 0 },
        clone: { mode: 'absolute', rect: { coordinateSpace: 'parent-padding', x: 40, y: 10, width: 100, height: 40 } },
        original: { mode: 'flow', placement: { parentId: 'flex', index: 5 } },
      },
      insertionTarget: { index: 5, line: 1, guide: { axis: 'x', position: 210, start: 50, end: 90 } },
    })
  })

  it('keeps the Component slot and source index in a same-sample Alt-primary composite', () => {
    const source = componentAuthority()
    const resolved = derive(source, 'ca', { x: 60, y: 60 }, [{ world: { x: 80, y: 50 }, modifiers: { alt: true, primary: true } }])
    expect(resolved).toStrictEqual({
      intent: {
        kind: 'clone-source-and-move-original', nodeId: 'ca',
        sourcePlacement: { parentId: 'parent', slot: 'children', index: 0 },
        clone: { mode: 'flow' },
        original: { mode: 'absolute', parentId: 'parent', rect: { coordinateSpace: 'parent-padding', x: 30, y: 10, width: 40, height: 40 } },
      },
      insertionTarget: null,
    })
  })

  it('rejects a missing sibling measurement instead of substituting zero geometry', () => {
    const source = wrappedAuthority()
    delete source.geometry.nodes.e
    expect(derive(source, 'a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])).toBeNull()
  })

  it('rejects a stale authority after its shared file changes', () => {
    const source = wrappedAuthority()
    source.file.revision = 18
    expect(derive(source, 'a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])).toBeNull()
  })

  it('rejects unsupported child and slot topology', () => {
    const componentUnderFrame = wrappedAuthority()
    componentUnderFrame.file.nodes.a = { id: 'a', type: 'component', componentId: 'child-a', exportName: 'ChildA', props: {}, layout: { item: { position: { mode: 'flow' } } } }
    expect(derive(componentUnderFrame, 'a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])).toBeNull()

    const missingSlot = componentAuthority()
    delete missingSlot.file.relationships.ca!.slot
    expect(derive(missingSlot, 'ca', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])).toBeNull()
  })

  it('rejects invalid Flex axes, locks, and non-finite points', () => {
    const direction = wrappedAuthority()
    ;(direction.file.nodes.flex as { layout: { container: { flex: { direction: string } } } }).layout.container.flex.direction = 'inline'
    expect(derive(direction, 'a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])).toBeNull()

    const wrap = wrappedAuthority()
    ;(wrap.file.nodes.flex as { layout: { container: { flex: { wrap: string } } } }).layout.container.flex.wrap = 'balance'
    expect(derive(wrap, 'a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])).toBeNull()

    const locked = wrappedAuthority()
    ;(locked.file.nodes.flex as { isLocked?: boolean }).isLocked = true
    expect(derive(locked, 'a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])).toBeNull()

    const state = dragState('a', pointerDown, [{ world: terminal, modifiers: { alt: false, primary: false } }])
    expect(deriveGestureTerminalIntent({ authority: wrappedAuthority(), nodeId: 'a', pointerDownWorld: { x: Number.NaN, y: 20 }, terminalWorld: terminal, dragState: state })).toBeNull()
  })

  it('rejects a semantic no-op reorder and a mismatched terminal history', () => {
    const source = wrappedAuthority()
    const state = dragState('a', pointerDown, [{ world: { x: 120, y: 20 }, modifiers: { alt: false, primary: false } }])
    expect(deriveGestureTerminalIntent({ authority: source, nodeId: 'a', pointerDownWorld: pointerDown, terminalWorld: { x: 120, y: 20 }, dragState: state })).toBeNull()
    expect(deriveGestureTerminalIntent({ authority: source, nodeId: 'a', pointerDownWorld: pointerDown, terminalWorld: { x: 121, y: 20 }, dragState: state })).toBeNull()
  })
})
