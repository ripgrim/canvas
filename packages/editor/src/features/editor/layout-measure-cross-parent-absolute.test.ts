import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Scene, SceneNode } from './canvas-scene'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import { paperFlowCrossParentAbsoluteDropGeometry } from './layout-measure'
import type { SceneGeometry } from './scene-geometry'

const revision = 17
const measurementRevision = 23
const layoutGeneration = 9
const flex = { direction: 'row' as const, wrap: 'nowrap' as const, justify: 'start' as const, align: 'start' as const }

function fixture(): GestureAuthoritySnapshot {
  const file: FileDocument = {
    schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'cross-parent-absolute', revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      source: { id: 'source', type: 'frame', name: 'Source', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 200, height: 100 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex } } },
      target: { id: 'target', type: 'frame', name: 'Target', styles: { relativeTransform: [0, 1, -1, 0, 250, 0], width: 200, height: 100 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex } } },
      child: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 60, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
    },
    relationships: { source: { parentId: 'root', orderKey: 'V' }, target: { parentId: 'root', orderKey: 'W' }, child: { parentId: 'source', orderKey: 'V' } },
    theme: { tokens: {} },
  }
  const geometry: SceneGeometry = {
    revision: measurementRevision, documentRevision: revision, layoutGeneration, unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    nodes: {
      source: { canvasKind: 'frame', documentRevision: revision, layoutGeneration, rect: { x: 0, y: 0, width: 200, height: 100 }, worldAabb: { x: 0, y: 0, width: 200, height: 100 }, offset: { x: 0, y: 0, width: 200, height: 100, origin: { x: 0, y: 0 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true, box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } } },
      target: { canvasKind: 'frame', documentRevision: revision, layoutGeneration, rect: { x: 0, y: 50, width: 100, height: 200 }, worldAabb: { x: 0, y: 50, width: 100, height: 200 }, offset: { x: 100, y: 50, width: 200, height: 100, origin: { x: 0, y: 0 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true, transform: [0, 1, -1, 0, 0, 0], box: { border: { top: 20, right: 0, bottom: 0, left: 10 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } } },
      child: { canvasKind: 'rectangle', documentRevision: revision, layoutGeneration, rect: { x: 50, y: 40, width: 60, height: 20 }, worldAabb: { x: 50, y: 40, width: 60, height: 20 }, offset: { x: 50, y: 40, width: 60, height: 20, origin: { x: 30, y: 10 } }, offsetParentNodeId: 'source', directChild: true },
    },
  }
  const nodes: SceneNode[] = [
    { id: 'source', kind: 'frame', name: 'Source', parentId: null, rect: geometry.nodes.source!.rect, rotation: 0, clip: false, depth: 0, order: 0, flow: false, locked: false },
    { id: 'target', kind: 'frame', name: 'Target', parentId: null, rect: geometry.nodes.target!.rect, rotation: 90, clip: false, depth: 0, order: 1, flow: false, locked: false },
    { id: 'child', kind: 'rectangle', name: 'Child', parentId: 'source', rect: geometry.nodes.child!.rect, rotation: 0, clip: false, depth: 1, order: 2, flow: true, locked: false },
  ]
  const scene: Scene = { nodes, byId: new Map(nodes.map(node => [node.id, node])) }
  return { file, atoms: [], scene, geometry, layoutGeneration, start: { fileId: file.fileId, fileRevision: revision, measurementRevision, documentRevision: revision, layoutGeneration }, pageId: 'page', camera: { x: 0, y: 0, zoom: 1 }, size: { width: 1000, height: 700 }, selection: ['child'] }
}

const derive = (snapshot: GestureAuthoritySnapshot) => paperFlowCrossParentAbsoluteDropGeometry({ snapshot, childId: 'child', targetParentId: 'target', pointerDownWorld: { x: 60, y: 40 }, terminalWorld: { x: 40, y: 20 } })

describe('Paper cross-parent absolute-drop geometry', () => {
  it('uses the rotated target-parent inverse once and preserves negative coordinates and source offset size', () => {
    const snapshot = fixture()
    expect(derive(snapshot)).toStrictEqual({ coordinateSpace: 'parent-padding', x: -40, y: 50, width: 60, height: 20 })
    const rawWorldDeltaMutation = { coordinateSpace: 'parent-padding', x: 30, y: 20, width: 60, height: 20 }
    const doubleTransformMutation = { coordinateSpace: 'parent-padding', x: 50, y: 120, width: 60, height: 20 }
    expect(derive(snapshot)).not.toStrictEqual(rawWorldDeltaMutation)
    expect(derive(snapshot)).not.toStrictEqual(doubleTransformMutation)
  })

  it('fails closed for stale, indirect, singular, locked, and unsupported target authority', () => {
    const mutations: Array<(snapshot: GestureAuthoritySnapshot) => void> = [
      snapshot => { snapshot.file.revision += 1 },
      snapshot => { snapshot.geometry.nodes.child!.directChild = false },
      snapshot => { snapshot.file.relationships.child!.slot = 'undeclared' },
      snapshot => { snapshot.geometry.nodes.source!.transform = [0, 0, 0, 0, 0, 0] },
      snapshot => { snapshot.geometry.nodes.target!.transform = [0, 0, 0, 0, 0, 0] },
      snapshot => { (snapshot.file.nodes.target as { isLocked?: boolean }).isLocked = true },
      snapshot => { const target = snapshot.file.nodes.target; if (target?.type === 'frame') target.layout!.container = { display: 'block' } },
      snapshot => { snapshot.file.relationships.target!.parentId = 'child' },
    ]
    for (const mutate of mutations) {
      const snapshot = fixture()
      mutate(snapshot)
      expect(derive(snapshot)).toBeNull()
    }
  })
})
