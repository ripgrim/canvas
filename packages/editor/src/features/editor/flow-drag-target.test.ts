import { describe, expect, it } from 'vitest'
import type { FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import type { RepositoryAtom } from '@canvas/repo-engine/contracts'
import type { Scene, SceneNode } from './canvas-scene'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import type { SceneGeometry } from './scene-geometry'
import { beginPaperFlowDrag, samplePaperFlowDrag } from './flow-drag-state'
import type { FlowDragSourceRelationship, PaperFlowDragState } from './flow-drag-state'
import { resolveFlowDragTarget } from './flow-drag-target'

const revision = 7, measurementRevision = 11, layoutGeneration = 3
const fence = { fileId: 'flow-target', fileRevision: revision, measurementRevision, documentRevision: revision, layoutGeneration }
const box = (x: number, y: number, width = 100, height = 40) => ({ x, y, width, height })
const flex = (direction: 'row' | 'row-reverse' | 'column' | 'column-reverse' = 'row', wrap: 'nowrap' | 'wrap' | 'wrap-reverse' = 'nowrap') => ({ direction, wrap, justify: 'start' as const, align: 'start' as const })
const frame = (id: string, direction: Parameters<typeof flex>[0] = 'row', wrap: Parameters<typeof flex>[1] = 'nowrap'): FileNode => ({
  id, type: 'frame', name: id, styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 400, height: 200 },
  layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: flex(direction, wrap) } },
})
const rectangle = (id: string): FileNode => ({ id, type: 'rectangle', name: id, styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, layout: { item: { position: { mode: 'flow' } } } })
const component = (id: string, componentId = id): FileNode => ({ id, type: 'component', componentId, exportName: componentId, props: {}, layout: { item: { position: { mode: 'flow' } } } })
const sourceRelationship = (parentId = 'target', orderKey = 'V', slot?: string): FlowDragSourceRelationship => ({
  parentId, orderKey, slot: slot === undefined ? { presence: 'absent' } : { presence: 'present', value: slot },
})

type FixtureOptions = Readonly<{
  direction?: Parameters<typeof flex>[0]
  wrap?: Parameters<typeof flex>[1]
  rects?: Readonly<Record<string, ReturnType<typeof box>>>
  sourceParent?: string
  targetParent?: string
  targetType?: 'frame' | 'component'
  targetSlots?: readonly string[]
  sourceType?: 'rectangle' | 'component'
  targetLocked?: boolean
  cameraScale?: number
}>

function fixture(options: FixtureOptions = {}): GestureAuthoritySnapshot {
  const targetId = options.targetParent ?? 'target'
  const sourceParent = options.sourceParent ?? targetId
  const sourceType = options.sourceType ?? 'rectangle'
  const targetType = options.targetType ?? 'frame'
  const slots = options.targetSlots ?? ['children']
  const rects = options.rects ?? { a: box(0, 0), b: box(110, 0), c: box(220, 0) }
  const nodes: Record<string, FileNode> = { root: { id: 'root', type: 'root' } }
  const relationships: FileDocument['relationships'] = {}
  if (sourceParent !== targetId && sourceParent !== 'root') {
    nodes[sourceParent] = frame(sourceParent)
    relationships[sourceParent] = { parentId: 'root', orderKey: 'U' }
  }
  if (targetType === 'frame') {
    const target = frame(targetId, options.direction, options.wrap)
    if (target.type !== 'frame') throw new Error('Frame fixture factory returned another node kind')
    nodes[targetId] = options.targetLocked ? { ...target, isLocked: true } : target
  } else {
    const target = component(targetId, 'Target') as Extract<FileNode, { type: 'component' }>
    nodes[targetId] = { ...target, ...(options.targetLocked ? { isLocked: true } : {}), layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: flex(options.direction, options.wrap) } } }
  }
  relationships[targetId] = { parentId: 'root', orderKey: 'V' }
  const ids = Object.keys(rects)
  ids.forEach((id, position) => {
    nodes[id] = sourceType === 'component' ? component(id, `Child-${id}`) : rectangle(id)
    const parentId = id === 'a' ? sourceParent : targetId
    relationships[id] = { parentId, orderKey: String.fromCharCode(86 + position), ...(targetType === 'component' && parentId === targetId ? { slot: 'children' } : {}) }
  })
  const file: FileDocument = { schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: fence.fileId, revision, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }], nodes, relationships, theme: { tokens: {} } }
  const sceneNodes: SceneNode[] = []
  const geometryNodes: SceneGeometry['nodes'] = {}
  for (const [id, rect] of Object.entries(rects)) {
    const node = nodes[id]!
    if (node.type === 'root') throw new Error('Fixture children must be renderable nodes')
    const parentId = relationships[id]!.parentId
    sceneNodes.push({ id, kind: node.type as SceneNode['kind'], name: id, parentId, rect, rotation: 0, clip: false, depth: 1, order: sceneNodes.length, flow: true, locked: false })
    geometryNodes[id] = {
      ...(node.type === 'component'
        ? { componentId: node.componentId, parentInstanceId: parentId, offsetParentInstanceId: parentId }
        : { canvasKind: node.type }),
      documentRevision: revision, layoutGeneration, rect, worldAabb: rect,
      offset: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, origin: { x: rect.width / 2, y: rect.height / 2 } },
      offsetParentNodeId: parentId, directChild: true,
    }
  }
  const scene: Scene = { nodes: sceneNodes, byId: new Map(sceneNodes.map(node => [node.id, node])) }
  const atoms: RepositoryAtom[] = targetType === 'component' ? [
    { name: 'Target', kind: 'atom', componentId: 'Target', path: 'Target.tsx', exportName: 'Target', fingerprint: 'target', sourceHash: 'target', status: 'bound', candidates: [], slots: [...slots], props: slots.map(name => ({ name, type: 'ReactNode', optional: true })) },
    ...ids.map(id => ({ name: id, kind: 'atom' as const, componentId: `Child-${id}`, path: `${id}.tsx`, exportName: `Child-${id}`, fingerprint: id, sourceHash: id, status: 'bound' as const, candidates: [], props: [] })),
  ] : []
  return { file, atoms, scene, geometry: { nodes: geometryNodes, revision: measurementRevision, documentRevision: revision, layoutGeneration, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 },
    layoutGeneration, start: fence, pageId: 'page', camera: { x: 0, y: 0, zoom: options.cameraScale ?? 1 }, size: { width: 1000, height: 700 }, selection: ['a'] }
}

function activeState(authority: GestureAuthoritySnapshot, sourceIndex = 0, pointerWorld = { x: 5, y: 0 }, duplicate = false): PaperFlowDragState {
  const relationship = authority.file.relationships.a!
  const exact = sourceRelationship(relationship.parentId, relationship.orderKey, relationship.slot)
  const initial = beginPaperFlowDrag({ nodeId: 'a', pointerDownWorld: { x: 0, y: 0 }, pointerDownViewport: { x: 0, y: 0 }, pointerDownTime: 0,
    sourceRelationship: exact, sourceIndex, gestureGeneration: 4, selectionDepthPrimary: false, fence })!
  return samplePaperFlowDrag(initial, { world: pointerWorld, viewport: pointerWorld, timestamp: 0,
    modifiers: { altKey: duplicate, ctrlKey: false, metaKey: false }, platform: 'windows',
    authority: { ...fence, gestureGeneration: 4, owned: true }, resolveTarget: () => null })!
}

function resolve(authority: GestureAuthoritySnapshot, pointerWorld: { x: number; y: number }, duplicate = false, hoveredNodeId = 'b', sourceIndex = 0) {
  const state = activeState(authority, sourceIndex, pointerWorld, duplicate)
  return resolveFlowDragTarget({ authority, state, hoveredNodeId })
}

describe('exact Paper Flex drag target resolver', () => {
  it('resolves row, column, reverse, and wrapped visual insertions with literal guides', () => {
    expect(resolve(fixture(), { x: 170, y: 20 })).toMatchObject({ rawIndex: 2, semanticIndex: 1, line: 0, guideWorld: { axis: 'x', position: 215, start: 0, end: 40 } })
    const column = fixture({ direction: 'column', rects: { a: box(0, 0), b: box(0, 50), c: box(0, 100) } })
    expect(resolve(column, { x: 50, y: 95 })).toMatchObject({ rawIndex: 2, semanticIndex: 1, guideWorld: { axis: 'y', position: 95, start: 0, end: 100 } })
    const reversed = fixture({ direction: 'row-reverse', rects: { a: box(220, 0), b: box(110, 0), c: box(0, 0) } })
    expect(resolve(reversed, { x: 200, y: 20 }, false, 'b')).toMatchObject({ rawIndex: 1, semanticIndex: 0, line: 0 })
    const wrapped = fixture({ wrap: 'wrap', rects: { a: box(0, 0), b: box(110, 0), c: box(220, 0), d: box(0, 50), e: box(110, 50) } })
    expect(resolve(wrapped, { x: 250, y: 70 }, false, 'e')).toMatchObject({ rawIndex: 5, semanticIndex: 4, line: 1, guideWorld: { axis: 'x', position: 210, start: 50, end: 90 } })
  })

  it('uses exactly 8/cameraScale world units as the cross-axis tolerance', () => {
    const authority = fixture()
    expect(resolveFlowDragTarget({ authority, state: activeState(authority, 0, { x: 170, y: 48 }), hoveredNodeId: 'b' })).not.toBeNull()
    expect(resolveFlowDragTarget({ authority, state: activeState(authority, 0, { x: 170, y: 48.001 }), hoveredNodeId: 'b' })).toBeNull()
    const zoomed = fixture({ cameraScale: 2 })
    expect(resolveFlowDragTarget({ authority: zoomed, state: activeState(zoomed, 0, { x: 170, y: 44 }), hoveredNodeId: 'b' })).not.toBeNull()
    expect(resolveFlowDragTarget({ authority: zoomed, state: activeState(zoomed, 0, { x: 170, y: 44.001 }), hoveredNodeId: 'b' })).toBeNull()
  })

  it('normalizes only same-parent ordinary moves after removal and retains the raw duplicate gap', () => {
    const authority = fixture()
    expect(resolve(authority, { x: 300, y: 20 }, false)).toMatchObject({ rawIndex: 3, semanticIndex: 2 })
    const duplicateState = activeState(authority, 0, { x: 300, y: 20 }, true)
    expect(duplicateState.clone).toMatchObject({ entryMode: 'flow' })
    expect(resolveFlowDragTarget({ authority, state: duplicateState, hoveredNodeId: 'b' })).toMatchObject({ rawIndex: 3, semanticIndex: 3 })
    const normalizedDuplicateMutation = 2
    expect(resolve(authority, { x: 300, y: 20 }, true)!.semanticIndex).not.toBe(normalizedDuplicateMutation)
  })

  it('does not source-normalize a cross-parent move', () => {
    const authority = fixture({ sourceParent: 'source', rects: { a: box(-200, 0), b: box(0, 0), c: box(110, 0) } })
    expect(resolve(authority, { x: 200, y: 20 }, false, 'c')).toMatchObject({ parentId: 'target', rawIndex: 2, semanticIndex: 2 })
  })

  it('accepts compatible primitives in Frames with exact absent-slot identity', () => {
    const result = resolve(fixture(), { x: 170, y: 20 })!
    expect(result).toStrictEqual({ parentId: 'target', slotPresence: 'absent', slotValue: null, rawIndex: 2, semanticIndex: 1, line: 0,
      guideWorld: { axis: 'x', position: 215, start: 0, end: 40 }, fence: { ...fence, gestureGeneration: 4, sampleSequence: 1 } })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.guideWorld)).toBe(true)
    expect(Object.isFrozen(result.fence)).toBe(true)
  })

  it('accepts exactly one verified Component slot and fails closed for ambiguous slots', () => {
    const accepted = fixture({ targetType: 'component', sourceType: 'component' })
    expect(resolve(accepted, { x: 170, y: 20 })).toMatchObject({ parentId: 'target', slotPresence: 'present', slotValue: 'children' })
    const oneVerified = fixture({ targetType: 'component', sourceType: 'component' })
    oneVerified.atoms[0]!.slots = ['children', 'not-declared']
    expect(resolve(oneVerified, { x: 170, y: 20 })).toMatchObject({ slotPresence: 'present', slotValue: 'children' })
    const ambiguous = fixture({ targetType: 'component', sourceType: 'component', targetSlots: ['children', 'footer'] })
    expect(resolve(ambiguous, { x: 170, y: 20 })).toBeNull()
    const duplicateDeclaration = fixture({ targetType: 'component', sourceType: 'component' })
    ;(duplicateDeclaration.atoms as Atom[]).push({ ...(duplicateDeclaration.atoms[0] as RepositoryAtom), path: 'OtherTarget.tsx' })
    expect(resolve(duplicateDeclaration, { x: 170, y: 20 })).toBeNull()
    const incompatible = fixture({ targetType: 'frame', sourceType: 'component' })
    expect(resolve(incompatible, { x: 170, y: 20 })).toBeNull()
  })

  it('climbs out of the selected subtree but never selects it or its descendants as the target', () => {
    const authority = fixture()
    authority.file.nodes.inner = rectangle('inner')
    authority.file.relationships.inner = { parentId: 'a', orderKey: 'V' }
    expect(resolve(authority, { x: 170, y: 20 }, false, 'inner')).toMatchObject({ parentId: 'target' })

    const noAncestor = fixture({ sourceParent: 'root', targetParent: 'other' })
    noAncestor.file.nodes.inner = rectangle('inner')
    noAncestor.file.relationships.inner = { parentId: 'a', orderKey: 'V' }
    expect(resolve(noAncestor, { x: 0, y: 0 }, false, 'inner')).toBeNull()
  })

  it('rejects locked targets, stale topology, source-index drift, and authority drift', () => {
    expect(resolve(fixture({ targetLocked: true }), { x: 170, y: 20 })).toBeNull()
    const relationshipDrift = fixture()
    const relationshipState = activeState(relationshipDrift)
    relationshipDrift.file.relationships.a!.orderKey = 'Q'
    expect(resolveFlowDragTarget({ authority: relationshipDrift, state: relationshipState, hoveredNodeId: 'b' })).toBeNull()
    expect(resolve(fixture(), { x: 170, y: 20 }, false, 'b', 1)).toBeNull()
    const stale = fixture()
    const staleState = activeState(stale)
    stale.file.revision = revision + 1
    expect(resolveFlowDragTarget({ authority: stale, state: staleState, hoveredNodeId: 'b' })).toBeNull()
  })

  it('preserves input objects and rejects a forged selected-child cross-axis bridge', () => {
    const bridged = fixture({ wrap: 'wrap', rects: { left: box(0, 0, 20, 20), a: box(30, 0, 20, 100), b: box(60, 80, 20, 20), c: box(0, 110, 20, 20) } })
    const before = structuredClone(bridged.file)
    const result = resolve(bridged, { x: 10, y: 80 }, false, 'b', 1)
    expect(result).toMatchObject({ rawIndex: 0, line: 0 })
    expect(bridged.file).toStrictEqual(before)
    const withoutBridgeMutation = 2
    expect(result!.rawIndex).not.toBe(withoutBridgeMutation)
  })
})
