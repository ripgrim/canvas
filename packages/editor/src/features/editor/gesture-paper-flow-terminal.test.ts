import { describe, expect, it, vi } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, orderKeySequence } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Scene, SceneNode } from './canvas-scene'
import { beginPaperFlowDrag, samplePaperFlowDrag } from './flow-drag-state'
import type { PaperFlowDragState } from './flow-drag-state'
import type { GestureAuthoritySnapshot } from './gesture-authority'
import { planGestureCommand } from './gesture-command-planner'
import { derivePaperFlowTerminalIntent } from './gesture-terminal-intent'
import { resolveFlowDragTarget } from './flow-drag-target'
import { paperFlowAbsoluteDropGeometry } from './layout-measure'
import type { SceneGeometry } from './scene-geometry'
import { createDocumentStore } from './document-store'

const revision = 7
const measurementRevision = 19
const layoutGeneration = 3
const flex = { direction: 'row' as const, wrap: 'nowrap' as const, justify: 'start' as const, align: 'start' as const }

function fixture(sameParent = false): GestureAuthoritySnapshot {
  const file: FileDocument = {
    schemaVersion: 12, componentModel: { definitions: {}, instances: {} }, fileId: 'paper-terminal', revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      source: { id: 'source', type: 'frame', name: 'Source', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 240, height: 80 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex } } },
      target: { id: 'target', type: 'frame', name: 'Target', styles: { relativeTransform: [1, 0, 0, 1, 300, 0], width: 240, height: 80 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex } } },
      a: { id: 'a', type: 'rectangle', name: 'A', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 60, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
      b: { id: 'b', type: 'rectangle', name: 'B', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 60, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
      c: { id: 'c', type: 'rectangle', name: 'C', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 60, height: 20 }, layout: { item: { position: { mode: 'flow' } } } },
    },
    relationships: {
      source: { parentId: 'root', orderKey: 'V' }, target: { parentId: 'root', orderKey: 'W' },
      a: { parentId: 'source', orderKey: 'V' },
      b: { parentId: sameParent ? 'source' : 'target', orderKey: 'W' },
      c: { parentId: sameParent ? 'source' : 'target', orderKey: 'X' },
    }, theme: { tokens: {} },
  }
  const parentOf = (id: string) => file.relationships[id]!.parentId
  const rects = {
    source: { x: 0, y: 0, width: 240, height: 80 }, target: { x: 300, y: 0, width: 240, height: 80 },
    a: { x: 10, y: 10, width: 60, height: 20 }, b: { x: sameParent ? 80 : 310, y: 10, width: 60, height: 20 }, c: { x: sameParent ? 150 : 380, y: 10, width: 60, height: 20 },
  }
  const geometry: SceneGeometry = { revision: measurementRevision, documentRevision: revision, layoutGeneration, unsupported: {}, themeUnsupported: {}, unownedPortals: 0, nodes: {} }
  for (const id of ['source', 'target'] as const) geometry.nodes[id] = { canvasKind: 'frame', documentRevision: revision, layoutGeneration, rect: rects[id], worldAabb: rects[id], offset: { ...rects[id], origin: { x: 0, y: 0 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true, box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } } }
  for (const id of ['a', 'b', 'c'] as const) {
    const parentId = parentOf(id)
    geometry.nodes[id] = { canvasKind: 'rectangle', documentRevision: revision, layoutGeneration, rect: rects[id], worldAabb: rects[id], offset: { x: rects[id].x - rects[parentId as 'source' | 'target'].x, y: 10, width: 60, height: 20, origin: { x: 30, y: 10 } }, offsetParentNodeId: parentId, directChild: true }
  }
  const sceneNodes: SceneNode[] = ['source', 'target', 'a', 'b', 'c'].map((id, order) => {
    const node = file.nodes[id]!
    const parentId = node.type === 'root' ? null : file.relationships[id]!.parentId
    return { id, kind: node.type as 'frame' | 'rectangle', name: node.type === 'root' ? id : node.name ?? id, parentId: parentId && file.nodes[parentId]?.type !== 'root' ? parentId : null,
      rect: rects[id as keyof typeof rects], rotation: 0, clip: false, depth: parentId && file.nodes[parentId]?.type !== 'root' ? 1 : 0, order,
      flow: id === 'a' || id === 'b' || id === 'c', locked: false }
  })
  const scene: Scene = { nodes: sceneNodes, byId: new Map(sceneNodes.map(node => [node.id, node])) }
  return { file, atoms: [], scene, geometry, layoutGeneration, start: { fileId: file.fileId, fileRevision: revision, measurementRevision, documentRevision: revision, layoutGeneration }, pageId: 'page', camera: { x: 0, y: 0, zoom: 1 }, size: { width: 900, height: 600 }, selection: ['a'] }
}

function begin(authority: GestureAuthoritySnapshot): PaperFlowDragState {
  return beginPaperFlowDrag({ nodeId: 'a', pointerDownWorld: { x: 20, y: 20 }, pointerDownViewport: { x: 20, y: 20 }, pointerDownTime: 0,
    sourceRelationship: { parentId: 'source', orderKey: 'V', slot: { presence: 'absent' } }, sourceIndex: 0,
    gestureGeneration: 4, selectionDepthPrimary: false, fence: authority.start })!
}

function sample(authority: GestureAuthoritySnapshot, state: PaperFlowDragState, world: { x: number; y: number }, alt: boolean, primary: boolean, entryGeometry?: { x: number; y: number; width: number; height: number }): PaperFlowDragState {
  return samplePaperFlowDrag(state, { world, viewport: world, timestamp: state.currentTime,
    modifiers: { altKey: alt, ctrlKey: primary, metaKey: false }, platform: 'windows',
    authority: { ...authority.start, gestureGeneration: 4, owned: true }, ...(entryGeometry ? { entryGeometry } : {}),
    resolveTarget: edge => resolveFlowDragTarget({ authority, state: edge, hoveredNodeId: authority.file.relationships.b!.parentId }) })!
}

const stable = (file: FileDocument) => JSON.stringify({ ...file, revision: 0 })
const freeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen)
  return Object.freeze(value)
}
const alignLayoutGeneration = (authority: GestureAuthoritySnapshot, generation: number) => {
  ;(authority as { layoutGeneration: number }).layoutGeneration = generation
  ;(authority.start as { layoutGeneration: number }).layoutGeneration = generation
  authority.geometry.layoutGeneration = generation
  for (const measurement of Object.values(authority.geometry.nodes)) measurement.layoutGeneration = generation
}

describe('Paper flow terminal semantics', () => {
  it('commits a same-parent ordinary flow move with one literal checked relationship and exact undo/redo', () => {
    const authority = fixture(true)
    const state = sample(authority, begin(authority), { x: 220, y: 20 }, false, false)
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    const allocate = vi.fn()
    const plan = planGestureCommand(authority, [intent], allocate)!
    expect(allocate).not.toHaveBeenCalled()
    expect(plan.selection).toStrictEqual(['a'])
    expect(plan.command).toStrictEqual({ type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'source', orderKey: 'V' }, source: { parentId: 'source', orderKey: 'Y' } })
    const history = applyFileCommandWithHistory(authority.file, plan.command, [])
    expect(history.file.relationships.a).toStrictEqual({ parentId: 'source', orderKey: 'Y' })
    const undone = applyFileCommand(history.file, history.undo, [])
    expect(stable(undone)).toBe(stable(authority.file))
    expect(stable(applyFileCommand(undone, history.redo, []))).toBe(stable(history.file))
  })

  it('commits cross-parent flow and absolute drops with exact target relationship bytes', () => {
    const flowAuthority = fixture()
    const flowState = sample(flowAuthority, begin(flowAuthority), { x: 420, y: 20 }, false, false)
    const flowPlan = planGestureCommand(flowAuthority, [derivePaperFlowTerminalIntent({ authority: flowAuthority, state: flowState })!], vi.fn())!
    expect(flowPlan.command).toStrictEqual({ type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'source', orderKey: 'V' }, source: { parentId: 'target', orderKey: 'Y' } })

    const absoluteAuthority = fixture()
    const absoluteState = sample(absoluteAuthority, begin(absoluteAuthority), { x: 420, y: 20 }, false, true)
    const absolutePlan = planGestureCommand(absoluteAuthority, [derivePaperFlowTerminalIntent({ authority: absoluteAuthority, state: absoluteState })!], vi.fn())!
    expect(absolutePlan.command).toStrictEqual({ type: 'batch', commands: [
      { type: 'node.restoreRelationship', nodeId: 'a', expected: { parentId: 'source', orderKey: 'V' }, source: { parentId: 'target', orderKey: 'Y' } },
      { type: 'node.resizePresentation', entries: [{
        expected: {
          nodeId: 'a', relationship: { parentId: 'target', orderKey: 'Y' },
          layout: { item: { position: { mode: 'flow' } } },
          primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 60, height: 20 },
        },
        source: {
          nodeId: 'a', relationship: { parentId: 'target', orderKey: 'Y' },
          layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 110 }, top: { kind: 'px', value: 10 } } } },
          primitiveGeometry: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 60, height: 20 },
        },
      }] },
    ] })
  })

  it('commits a flow child dragged onto the page root as an absolute node', () => {
    const authority = fixture()
    const started = begin(authority)
    const state = samplePaperFlowDrag(started, {
      world: { x: 600, y: 200 }, viewport: { x: 600, y: 200 }, timestamp: 100,
      modifiers: { altKey: false, ctrlKey: true, metaKey: false }, platform: 'windows',
      authority: { ...authority.start, gestureGeneration: 4, owned: true },
      resolveTarget: edge => resolveFlowDragTarget({ authority, state: edge, hoveredNodeId: 'root' }),
    })!
    expect(state.target).toMatchObject({ parentId: 'root', rawIndex: 2, semanticIndex: 2, guideWorld: null })
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    expect(intent).not.toBeNull()
    const plan = planGestureCommand(authority, [intent], vi.fn())!
    expect(plan).not.toBeNull()
    const applied = applyFileCommand(authority.file, plan.command, [])
    expect(applied.relationships.a!.parentId).toBe('root')
    expect(applied.nodes.a).toMatchObject({ layout: { item: { position: { mode: 'freeform' } } }, styles: { relativeTransform: [1, 0, 0, 1, 590, 190], width: 60, height: 20 } })
  })

  it('allocates an Alt duplicate only after preflight, keeps the source fixed, and selects the moved clone', () => {
    const authority = fixture()
    const state = sample(authority, begin(authority), { x: 420, y: 20 }, true, false)
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    const allocate = vi.fn(() => 'copy-a')
    const plan = planGestureCommand(authority, [intent], allocate)!
    expect(allocate).toHaveBeenCalledTimes(1)
    expect(plan.selection).toStrictEqual(['copy-a'])
    expect(plan.duplicateIds).toStrictEqual({ a: { a: 'copy-a' } })
    const result = applyFileCommand(authority.file, plan.command, [])
    expect(result.relationships['copy-a']!.parentId).toBe('target')
    expect(result.relationships.a).toStrictEqual({ parentId: 'source', orderKey: 'V' })
  })

  it('moves the duplicate to its terminal flow target even when clone mode began from an absolute sample', () => {
    const authority = fixture()
    const absolute = sample(authority, begin(authority), { x: 30, y: 20 }, false, true)
    const entry = paperFlowAbsoluteDropGeometry({ file: authority.file, scene: authority.scene, geometry: authority.geometry, fence: authority.start, childId: 'a', parentId: 'source', pointerDownWorld: { x: 20, y: 20 }, terminalWorld: { x: 35, y: 20 } })!
    const cloned = sample(authority, absolute, { x: 35, y: 20 }, true, true, entry)
    const returned = sample(authority, cloned, { x: 420, y: 20 }, true, false)
    const plan = planGestureCommand(authority, [derivePaperFlowTerminalIntent({ authority, state: returned })!], () => 'copy-a')!
    const applied = applyFileCommand(authority.file, plan.command, [])
    expect(applied.relationships['copy-a']!.parentId).toBe('target')
    expect(applied.relationships.a!.parentId).toBe('source')
  })

  it('rejects stale latest state, target fences, no-op flow, and invalid terminal geometry before allocation', () => {
    const same = fixture(true)
    const noOp = sample(same, begin(same), { x: 30, y: 20 }, false, false)
    expect(noOp.thresholdCrossed).toBe(true)
    expect(derivePaperFlowTerminalIntent({ authority: same, state: noOp })).toBeNull()

    const authority = fixture()
    const state = sample(authority, begin(authority), { x: 420, y: 20 }, true, false)
    const stale = structuredClone(state)
    ;(stale.target!.fence as { sampleSequence: number }).sampleSequence -= 1
    expect(derivePaperFlowTerminalIntent({ authority, state: stale })).toBeNull()
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    const forged = structuredClone(intent)
    ;(forged.target.fence as { layoutGeneration: number }).layoutGeneration += 1
    ;(forged.state.target!.fence as { layoutGeneration: number }).layoutGeneration += 1
    const allocate = vi.fn(() => 'copy-a')
    expect(planGestureCommand(authority, [freeze(forged)], allocate)).toBeNull()
    const wrongSlot = structuredClone(intent)
    ;(wrongSlot.sourceRelationship as { slot: { presence: 'present'; value: string } }).slot = { presence: 'present', value: 'body' }
    ;(wrongSlot.state.sourceRelationship as { slot: { presence: 'present'; value: string } }).slot = { presence: 'present', value: 'body' }
    expect(planGestureCommand(authority, [freeze(wrongSlot)], allocate)).toBeNull()
    const absoluteState = sample(authority, begin(authority), { x: 420, y: 20 }, false, true)
    const wrongRect = structuredClone(derivePaperFlowTerminalIntent({ authority, state: absoluteState })!)
    ;(wrongRect.rect as { x: number }).x += 1
    expect(planGestureCommand(authority, [freeze(wrongRect)], allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
  })

  it('proves Alt duplicate capacity before allocating any identity', () => {
    const authority = fixture()
    const rootKeys = orderKeySequence(52)
    authority.file.relationships.source!.orderKey = rootKeys[0]!
    authority.file.relationships.target!.orderKey = rootKeys[1]!
    for (let frameIndex = 0; frameIndex < 50; frameIndex += 1) {
      const frameId = `filler-frame-${frameIndex}`
      authority.file.nodes[frameId] = { id: frameId, type: 'frame', name: 'Filler frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 } }
      authority.file.relationships[frameId] = { parentId: 'root', orderKey: rootKeys[frameIndex + 2]! }
      const childCount = frameIndex < 44 ? 99 : 98
      const childKeys = orderKeySequence(childCount)
      for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
        const id = `filler-${frameIndex}-${childIndex}`
        authority.file.nodes[id] = { id, type: 'rectangle', name: 'Filler', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 } }
        authority.file.relationships[id] = { parentId: frameId, orderKey: childKeys[childIndex]! }
      }
    }
    const state = sample(authority, begin(authority), { x: 420, y: 20 }, true, false)
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    const allocate = vi.fn(() => 'copy-a')
    expect(planGestureCommand(authority, [intent], allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
  })

  it('commits once through the store with strict selection fences and one persistence intent', async () => {
    const authority = fixture()
    const allocated = vi.fn(() => 'copy-a')
    const store = createDocumentStore(allocated)
    store.load(structuredClone(authority.file), [])
    store.select('a')
    alignLayoutGeneration(authority, store.getSnapshot().layoutGeneration)
    const state = sample(authority, begin(authority), { x: 420, y: 20 }, true, false)
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    const writes: unknown[] = []
    store.configure({ persist: async (file, expectedRevision, persistenceIntent) => {
      writes.push({ expectedRevision, persistenceIntent })
      return { ...file, revision: expectedRevision + 1 }
    } })
    const result = store.commands.commitGesture(authority, [intent])
    expect(result.committed).toBe(true)
    await result.persistence
    expect(allocated).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().selection).toStrictEqual(['copy-a'])
    expect(store.getHistory().past).toHaveLength(1)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ expectedRevision: 7, persistenceIntent: { kind: 'commands', commands: [{ type: 'batch' }] } })
  })

  it('rejects ordered-selection drift before allocation and policy reentrancy after planning', () => {
    const earlyAllocate = vi.fn(() => 'copy-a')
    const early = createDocumentStore(earlyAllocate)
    const authority = fixture()
    early.load(structuredClone(authority.file), [])
    alignLayoutGeneration(authority, early.getSnapshot().layoutGeneration)
    const state = sample(authority, begin(authority), { x: 420, y: 20 }, true, false)
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    early.select('b')
    expect(early.commands.commitGesture(authority, [intent]).committed).toBe(false)
    expect(earlyAllocate).not.toHaveBeenCalled()

    const lateAllocate = vi.fn(() => 'copy-a')
    const late = createDocumentStore(lateAllocate)
    const lateAuthority = fixture()
    late.load(structuredClone(lateAuthority.file), [])
    late.select('a')
    alignLayoutGeneration(lateAuthority, late.getSnapshot().layoutGeneration)
    const lateState = sample(lateAuthority, begin(lateAuthority), { x: 420, y: 20 }, true, false)
    const lateIntent = derivePaperFlowTerminalIntent({ authority: lateAuthority, state: lateState })!
    let replaced = false
    late.setEditPolicy(() => {
      if (replaced) return
      replaced = true
      const changed = structuredClone(late.getSnapshot().file!)
      ;(changed.nodes.target as { name: string }).name = 'Changed during policy'
      late.load(changed, [], { replace: true })
    })
    expect(late.commands.commitGesture(lateAuthority, [lateIntent]).committed).toBe(false)
    expect(lateAllocate).toHaveBeenCalledTimes(1)
    expect(late.getSnapshot().file!.nodes['copy-a']).toBeUndefined()
    expect(late.getHistory()).toStrictEqual({ past: [], future: [] })
  })

  it('rechecks strict authority after Paper clone allocation reenters the store', () => {
    let store: ReturnType<typeof createDocumentStore>
    const allocate = vi.fn(() => {
      store.select('b')
      return 'copy-a'
    })
    store = createDocumentStore(allocate)
    const authority = fixture()
    store.load(structuredClone(authority.file), [])
    store.select('a')
    alignLayoutGeneration(authority, store.getSnapshot().layoutGeneration)
    const state = sample(authority, begin(authority), { x: 420, y: 20 }, true, false)
    const intent = derivePaperFlowTerminalIntent({ authority, state })!
    expect(store.commands.commitGesture(authority, [intent]).committed).toBe(false)
    expect(allocate).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().file!.nodes['copy-a']).toBeUndefined()
    expect(store.getHistory()).toStrictEqual({ past: [], future: [] })
  })
})
