import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Scene, SceneNode } from './canvas-scene'
import type { SceneGeometry } from './scene-geometry'
import { paperFlowAbsoluteDropGeometry } from './layout-measure'
import type { PaperFlowAbsoluteDropInput } from './layout-measure'

const documentRevision = 17
const layoutGeneration = 9
const measurementRevision = 23
const fence = { fileId: 'absolute-drop', fileRevision: documentRevision, measurementRevision, documentRevision, layoutGeneration }
const flex = { direction: 'row' as const, wrap: 'nowrap' as const, justify: 'start' as const, align: 'start' as const }

function scene(nodes: readonly SceneNode[]): Scene {
  return { nodes: [...nodes], byId: new Map(nodes.map(node => [node.id, node])) }
}

function frameInput(): PaperFlowAbsoluteDropInput {
  const file: FileDocument = {
    schemaVersion: 9,
    fileId: 'absolute-drop',
    revision: documentRevision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      parent: {
        id: 'parent', type: 'frame', name: 'Parent', styles: { left: 100, top: 50, width: 200, height: 100 },
        layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex } },
      },
      child: {
        id: 'child', type: 'rectangle', name: 'Child', styles: { left: 0, top: 0, width: 60, height: 20 },
        layout: { item: { position: { mode: 'flow' } } },
      },
    },
    relationships: { parent: { parentId: 'root', orderKey: 'V' }, child: { parentId: 'parent', orderKey: 'V' } },
    theme: { tokens: {} },
  }
  const geometry: SceneGeometry = {
    revision: measurementRevision,
    documentRevision,
    layoutGeneration,
    unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    nodes: {
      parent: {
        canvasKind: 'frame', documentRevision, layoutGeneration,
        rect: { x: 100, y: -100, width: 200, height: 400 },
        worldAabb: { x: 100, y: -100, width: 200, height: 400 },
        offset: { x: 100, y: 50, width: 200, height: 100, origin: { x: 100, y: 50 } },
        offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true,
        transform: [0, 2, -2, 0, 0, 0],
        box: { border: { top: 20, right: 0, bottom: 0, left: 10 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      },
      child: {
        canvasKind: 'rectangle', documentRevision, layoutGeneration,
        rect: { x: 212, y: -70, width: 40, height: 120 },
        worldAabb: { x: -800, y: 900, width: 999, height: 777 },
        offset: { x: 5, y: 4, width: 60, height: 20, origin: { x: 30, y: 10 } },
        offsetParentNodeId: 'parent', directChild: true,
      },
    },
  }
  const parent: SceneNode = { id: 'parent', kind: 'frame', name: 'Parent', parentId: null, rect: geometry.nodes.parent!.rect, rotation: 90, clip: false, depth: 0, order: 0, flow: false, locked: false }
  const child: SceneNode = { id: 'child', kind: 'rectangle', name: 'Child', parentId: 'parent', rect: geometry.nodes.child!.rect, rotation: 0, clip: false, depth: 1, order: 1, flow: true, locked: false }
  return {
    file,
    scene: scene([parent, child]),
    geometry,
    fence,
    childId: 'child',
    parentId: 'parent',
    pointerDownWorld: { x: 248, y: -70 },
    terminalWorld: { x: 198, y: -100 },
  }
}

function componentInput(): PaperFlowAbsoluteDropInput {
  const file: FileDocument = {
    schemaVersion: 9,
    fileId: 'absolute-drop',
    revision: documentRevision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      parent: {
        id: 'parent', type: 'component', componentId: 'parent-component', exportName: 'Parent', props: {},
        layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex } },
      },
      child: {
        id: 'child', type: 'component', componentId: 'child-component', exportName: 'Child', props: {},
        layout: { item: { position: { mode: 'flow' } } },
      },
    },
    relationships: { parent: { parentId: 'root', orderKey: 'V' }, child: { parentId: 'parent', orderKey: 'V', slot: 'children' } },
    theme: { tokens: {} },
  }
  const geometry: SceneGeometry = {
    revision: measurementRevision,
    documentRevision,
    layoutGeneration,
    unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    nodes: {
      parent: {
        componentId: 'parent-component', documentRevision, layoutGeneration,
        rect: { x: 40, y: 30, width: 200, height: 100 },
        worldAabb: { x: 40, y: 30, width: 200, height: 100 },
        offset: { x: 40, y: 30, width: 200, height: 100, origin: { x: 0, y: 0 } },
        offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], offsetParentInstanceId: null, parentInstanceId: null, directChild: true,
        box: { border: { top: 6, right: 0, bottom: 0, left: 4 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      },
      child: {
        componentId: 'child-component', documentRevision, layoutGeneration,
        rect: { x: 56, y: 50, width: 90, height: 36 },
        worldAabb: { x: 56, y: 50, width: 90, height: 36 },
        offset: { x: 12, y: 14, width: 90, height: 36, origin: { x: 45, y: 18 } },
        offsetParentNodeId: 'parent', offsetParentInstanceId: 'parent', parentInstanceId: 'parent', directChild: true,
      },
    },
  }
  const parent: SceneNode = { id: 'parent', kind: 'component', name: 'Parent', parentId: null, rect: geometry.nodes.parent!.rect, rotation: 0, clip: false, depth: 0, order: 0, flow: false, locked: false }
  const child: SceneNode = { id: 'child', kind: 'component', name: 'Child', parentId: 'parent', rect: geometry.nodes.child!.rect, rotation: 0, clip: false, depth: 1, order: 1, flow: true, locked: false }
  return { file, scene: scene([parent, child]), geometry, fence, childId: 'child', parentId: 'parent', pointerDownWorld: { x: 60, y: 60 }, terminalWorld: { x: 80, y: 50 } }
}

function copy(input: PaperFlowAbsoluteDropInput): PaperFlowAbsoluteDropInput {
  const file = structuredClone(input.file)
  const geometry = structuredClone(input.geometry)
  const nodes = structuredClone(input.scene.nodes)
  return { ...input, file, geometry, scene: scene(nodes), fence: { ...input.fence }, pointerDownWorld: { ...input.pointerDownWorld }, terminalWorld: { ...input.terminalWorld } }
}

function replaceSceneNode(input: PaperFlowAbsoluteDropInput, id: string, change: Partial<SceneNode>): void {
  const nodes = input.scene.nodes.map(node => node.id === id ? { ...node, ...change } : node)
  ;(input as { scene: Scene }).scene = scene(nodes)
}

describe('Paper flow child absolute-drop geometry', () => {
  it('uses one rotated and scaled parent inverse, preserves offset size, and allows negative local coordinates', () => {
    const input = frameInput()
    expect(paperFlowAbsoluteDropGeometry(input)).toStrictEqual({ coordinateSpace: 'parent-padding', x: -10, y: 29, width: 60, height: 20 })

    // World-space subtraction is observably wrong for this 90-degree, 2x parent transform.
    const offset = input.geometry.nodes.child!.offset!
    const naive = { x: offset.x + input.terminalWorld.x - input.pointerDownWorld.x, y: offset.y + input.terminalWorld.y - input.pointerDownWorld.y }
    expect(naive).toStrictEqual({ x: -45, y: -26 })
    expect(naive).not.toStrictEqual({ x: -10, y: 29 })

    const changedAabb = copy(input)
    changedAabb.geometry.nodes.child!.worldAabb = { x: 50_000, y: -50_000, width: 1, height: 1 }
    expect(paperFlowAbsoluteDropGeometry(changedAabb)).toStrictEqual({ coordinateSpace: 'parent-padding', x: -10, y: 29, width: 60, height: 20 })

    const finalSample = copy(input)
    ;(finalSample.terminalWorld as { y: number }).y += 1
    expect(paperFlowAbsoluteDropGeometry(finalSample)).toStrictEqual({ coordinateSpace: 'parent-padding', x: -9.5, y: 29, width: 60, height: 20 })
  })

  it('proves component parent and child identities without losing their parent-padding box', () => {
    expect(paperFlowAbsoluteDropGeometry(componentInput())).toStrictEqual({ coordinateSpace: 'parent-padding', x: 32, y: 4, width: 90, height: 36 })
  })

  it('rejects a Component child under a Frame Flex parent', () => {
    const componentUnderFrame = copy(frameInput())
    componentUnderFrame.file.nodes.child = {
      id: 'child', type: 'component', componentId: 'child-component', exportName: 'Child', props: {},
      layout: { item: { position: { mode: 'flow' } } },
    }
    expect(paperFlowAbsoluteDropGeometry(componentUnderFrame)).toBeNull()
  })

  it('rejects a primitive child under a Component Flex parent', () => {
    const primitiveUnderComponent = copy(componentInput())
    primitiveUnderComponent.file.nodes.child = {
      id: 'child', type: 'rectangle', name: 'Child', styles: { left: 0, top: 0, width: 90, height: 36 },
      layout: { item: { position: { mode: 'flow' } } },
    }
    expect(paperFlowAbsoluteDropGeometry(primitiveUnderComponent)).toBeNull()
  })

  it('rejects an unslotted Component child under a Component Flex parent', () => {
    const unslottedComponent = copy(componentInput())
    delete unslottedComponent.file.relationships.child!.slot
    expect(paperFlowAbsoluteDropGeometry(unslottedComponent)).toBeNull()
  })

  it('rejects every stale file, document, measurement, and layout fence', () => {
    const mutations: Array<(input: PaperFlowAbsoluteDropInput) => void> = [
      input => { (input.fence as { fileId: string }).fileId = 'other-file' },
      input => { (input.fence as { fileRevision: number }).fileRevision -= 1 },
      input => { (input.fence as { documentRevision: number }).documentRevision -= 1 },
      input => { (input.fence as { measurementRevision: number }).measurementRevision -= 1 },
      input => { (input.fence as { layoutGeneration: number }).layoutGeneration -= 1 },
      input => { input.geometry.documentRevision! -= 1 },
      input => { input.geometry.layoutGeneration! -= 1 },
      input => { input.geometry.nodes.child!.documentRevision! -= 1 },
      input => { input.geometry.nodes.parent!.layoutGeneration! -= 1 },
    ]
    for (const mutate of mutations) {
      const input = copy(frameInput())
      mutate(input)
      expect(paperFlowAbsoluteDropGeometry(input)).toBeNull()
    }
  })

  it('rejects unproven direct-child, offset-parent, scene, and node-kind identity', () => {
    const mutations: Array<(input: PaperFlowAbsoluteDropInput) => void> = [
      input => { input.geometry.nodes.child!.directChild = false },
      input => { input.geometry.nodes.child!.offsetParentNodeId = null },
      input => { input.geometry.nodes.child!.canvasKind = 'shape' },
      input => { delete input.geometry.nodes.child },
      input => { replaceSceneNode(input, 'child', { parentId: null }) },
      input => { replaceSceneNode(input, 'child', { kind: 'shape' }) },
      input => { replaceSceneNode(input, 'child', { rect: { x: 0, y: 0, width: 40, height: 120 } }) },
    ]
    for (const mutate of mutations) {
      const input = copy(frameInput())
      mutate(input)
      expect(paperFlowAbsoluteDropGeometry(input)).toBeNull()
    }

    const component = copy(componentInput())
    component.geometry.nodes.child!.offsetParentInstanceId = null
    expect(paperFlowAbsoluteDropGeometry(component)).toBeNull()
    component.geometry.nodes.child!.offsetParentInstanceId = 'parent'
    component.geometry.nodes.child!.componentId = 'wrong-component'
    expect(paperFlowAbsoluteDropGeometry(component)).toBeNull()
  })

  it('rejects locks, non-Flex or non-flow topology, margins, and unsupported parent relationships', () => {
    const mutations: Array<(input: PaperFlowAbsoluteDropInput) => void> = [
      input => { (input.file.nodes.child as Exclude<FileDocument['nodes'][string], { type: 'root' }>).isLocked = true },
      input => { (input.file.nodes.parent as Exclude<FileDocument['nodes'][string], { type: 'root' }>).isLocked = true },
      input => { const node = input.file.nodes.parent!; if (node.type !== 'root') node.layout!.container = { display: 'block' } },
      input => { const node = input.file.nodes.child!; if (node.type !== 'root') node.layout!.item.position = { mode: 'absolute' } },
      input => { const node = input.file.nodes.child!; if (node.type !== 'root') node.layout!.spacing = { margin: 0 } },
      input => { input.file.relationships.child!.parentId = 'root' },
      input => { input.file.relationships.child!.slot = 'unsupported' },
      input => { replaceSceneNode(input, 'child', { flow: false }) },
    ]
    for (const mutate of mutations) {
      const input = copy(frameInput())
      mutate(input)
      expect(paperFlowAbsoluteDropGeometry(input)).toBeNull()
    }
  })

  it('rejects missing, singular, and non-finite transforms or samples instead of approximating', () => {
    const mutations: Array<(input: PaperFlowAbsoluteDropInput) => void> = [
      input => { delete input.geometry.nodes.parent!.offsetParentToRoot },
      input => { delete input.geometry.nodes.parent!.box },
      input => { input.geometry.nodes.parent!.transform = [0, 0, 0, 0, 0, 0] },
      input => { input.geometry.nodes.parent!.transform = [1, 0, 0, Number.NaN, 0, 0] },
      input => { input.geometry.nodes.parent!.offset!.origin.x = Number.NaN },
      input => { (input.pointerDownWorld as { x: number }).x = Number.POSITIVE_INFINITY },
      input => { (input.terminalWorld as { y: number }).y = Number.NaN },
    ]
    for (const mutate of mutations) {
      const input = copy(frameInput())
      mutate(input)
      expect(paperFlowAbsoluteDropGeometry(input)).toBeNull()
    }
  })
})
