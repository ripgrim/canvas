import { describe, expect, it } from 'vitest'
import type { HudProjectionEntry, HudProjectionFrame, HudQuad } from './canvas-hud-projection'
import type { CanvasHudProjectionSnapshot } from './canvas-hud-projection-service'
import { currentCanvasHitFrame, pointInHudQuad, projectedClickTarget, projectedDrillTarget, projectedHitTest, projectedMarqueeTargets } from './canvas-hud-hit-testing'
import type { Scene, SceneNode } from './canvas-scene'

const square = (left: number, top: number, size: number): HudQuad => [
  { x: left, y: top }, { x: left + size, y: top }, { x: left + size, y: top + size }, { x: left, y: top + size },
]
const diamond: HudQuad = [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }]
const reflectedDiamond: HudQuad = [diamond[0], diamond[3], diamond[2], diamond[1]]

const sceneNode = (id: string, order: number, parentId: string | null = null, options: Partial<SceneNode> = {}): SceneNode => ({
  id, order, parentId, kind: 'rectangle', name: id, rect: { x: 0, y: 0, width: 100, height: 100 }, rotation: 0,
  clip: false, depth: parentId ? 1 : 0, flow: false, locked: false, ...options,
})
const sceneOf = (...nodes: SceneNode[]): Scene => ({ nodes, byId: new Map(nodes.map(node => [node.id, node])) })
const key = (selection: readonly string[] = []) => ({
  fileId: 'file', pageId: 'page', fileRevision: 3, measurementRevision: 7, documentRevision: 3, layoutGeneration: 2,
  camera: { x: 0, y: 0, zoom: 1 }, size: { width: 500, height: 400 }, selection, hover: null,
  tool: 'move' as const, readOnly: false, mobile: false,
})
const entry = (node: SceneNode, quad: HudQuad): HudProjectionEntry => ({
  nodeId: node.id, name: node.name, kind: node.kind, parentId: node.parentId,
  worldQuad: quad, worldAabb: { x: 0, y: 0, width: 1, height: 1 }, screenQuad: quad,
  screenAabb: { x: Math.min(...quad.map(point => point.x)), y: Math.min(...quad.map(point => point.y)), width: Math.max(...quad.map(point => point.x)) - Math.min(...quad.map(point => point.x)), height: Math.max(...quad.map(point => point.y)) - Math.min(...quad.map(point => point.y)) },
  dimensions: { width: 100, height: 100 },
  policy: { selected: false, hovered: false, locked: node.locked, readOnly: false, showOutline: false, showLabel: false, showDimensions: false, showHandles: false, showQuickActions: false },
  label: { start: quad[0], end: quad[1], normal: { x: 0, y: -1 }, origin: quad[0], angle: 0, maxWidth: 100 },
  dimension: { anchor: quad[2], width: 100, height: 100 }, handles: [] as unknown as HudProjectionEntry['handles'], controls: [], effectiveHandle: null,
})
const frameOf = (scene: Scene, quads: Record<string, HudQuad>, selection: readonly string[] = []): HudProjectionFrame => {
  const entries = scene.nodes.map(node => entry(node, quads[node.id]!))
  return { key: key(selection), entries, byNodeId: Object.fromEntries(entries.map(item => [item.nodeId, item])), flowDrag: null }
}

describe('PAPER-FLEX-007-HUD canonical HUD hit testing', () => {
  it('rejects an AABB-only false positive and accepts the same reflected convex face', () => {
    expect(pointInHudQuad({ x: 5, y: 5 }, diamond)).toBe(false)
    expect(pointInHudQuad({ x: 50, y: 50 }, diamond)).toBe(true)
    expect(pointInHudQuad({ x: 50, y: 50 }, reflectedDiamond)).toBe(true)
    expect(pointInHudQuad({ x: 5, y: 5 }, reflectedDiamond)).toBe(false)

    const node = sceneNode('rotated', 0)
    const scene = sceneOf(node)
    expect(projectedHitTest(scene, frameOf(scene, { rotated: diamond }), { x: 5, y: 5 })).toEqual([])
    expect(projectedHitTest(scene, frameOf(scene, { rotated: reflectedDiamond }), { x: 50, y: 50 }).map(hit => hit.id)).toEqual(['rotated'])
  })

  it('clips a child against the canonical ancestor quad and keeps overlapping paint order', () => {
    const back = sceneNode('back', 0)
    const clip = sceneNode('clip', 1, null, { kind: 'frame', clip: true })
    const child = sceneNode('child', 2, 'clip')
    const front = sceneNode('front', 3)
    const scene = sceneOf(back, clip, child, front)
    const frame = frameOf(scene, { back: square(0, 0, 100), clip: square(25, 25, 50), child: square(0, 0, 100), front: square(40, 40, 20) })

    expect(projectedHitTest(scene, frame, { x: 10, y: 10 }).map(hit => hit.id)).toEqual(['back'])
    expect(projectedHitTest(scene, frame, { x: 50, y: 50 }).map(hit => hit.id)).toEqual(['front', 'child', 'clip', 'back'])
  })

  it('preserves shallow, deep, and drill ancestry semantics for primitives and components', () => {
    const root = sceneNode('root-node', 0, null, { kind: 'component' })
    const middle = sceneNode('middle', 1, 'root-node', { kind: 'frame' })
    const leaf = sceneNode('leaf', 2, 'middle')
    const scene = sceneOf(root, middle, leaf)
    const quads = { 'root-node': square(0, 0, 100), middle: square(10, 10, 80), leaf: square(20, 20, 60) }

    expect(projectedClickTarget(scene, frameOf(scene, quads), { x: 50, y: 50 }, [], false)?.id).toBe('middle')
    expect(projectedClickTarget(scene, frameOf(scene, quads), { x: 50, y: 50 }, [], true)?.id).toBe('leaf')
    expect(projectedClickTarget(scene, frameOf(scene, quads, ['middle']), { x: 50, y: 50 }, ['middle'], false)?.id).toBe('leaf')
    expect(projectedDrillTarget(scene, frameOf(scene, quads), { x: 50, y: 50 }, [])?.id).toBe('root-node')
    expect(projectedDrillTarget(scene, frameOf(scene, quads, ['root-node']), { x: 50, y: 50 }, ['root-node'])?.id).toBe('middle')
  })

  it('excludes the dragged node and its full subtree from every canonical target query', () => {
    const root = sceneNode('root-node', 0, null, { kind: 'frame' })
    const dragged = sceneNode('dragged', 1, 'root-node', { kind: 'frame' })
    const child = sceneNode('child', 2, 'dragged')
    const sibling = sceneNode('sibling', 3, 'root-node')
    const scene = sceneOf(root, dragged, child, sibling)
    const base = frameOf(scene, { 'root-node': square(0, 0, 120), dragged: square(10, 10, 90), child: square(20, 20, 70), sibling: square(30, 30, 20) }, ['dragged'])
    const frame = { ...base, flowDrag: { documentNodeId: 'dragged' } as HudProjectionFrame['flowDrag'] }

    expect(projectedHitTest(scene, frame, { x: 25, y: 25 }).map(node => node.id)).toEqual(['root-node'])
    expect(projectedHitTest(scene, frame, { x: 35, y: 35 }).map(node => node.id)).toEqual(['sibling', 'root-node'])
    expect(projectedClickTarget(scene, frame, { x: 25, y: 25 }, ['dragged'], true)?.id).toBe('root-node')
    expect(projectedMarqueeTargets(scene, frame, { x: 15, y: 15, width: 80, height: 80 }, true)).toEqual(['root-node', 'sibling'])
  })

  it('excludes direct and inherited locks and rejects incomplete or split scene frames', () => {
    const locked = sceneNode('locked', 0, null, { kind: 'frame', locked: true })
    const child = sceneNode('child', 1, 'locked', { locked: true })
    const scene = sceneOf(locked, child)
    const frame = frameOf(scene, { locked: square(0, 0, 100), child: square(10, 10, 80) })
    expect(projectedHitTest(scene, frame, { x: 50, y: 50 })).toEqual([])
    expect(projectedMarqueeTargets(scene, frame, { x: 0, y: 0, width: 100, height: 100 }, true)).toEqual([])

    const incomplete = { ...frame, entries: frame.entries.slice(0, 1) }
    expect(projectedHitTest(scene, incomplete, { x: 50, y: 50 })).toEqual([])
  })

  it('uses true clipped convex intersection for marquee instead of rotated AABBs', () => {
    const root = sceneNode('rotated-root', 0, null, { kind: 'frame', clip: true })
    const child = sceneNode('clipped-child', 1, 'rotated-root')
    const scene = sceneOf(root, child)
    const frame = frameOf(scene, { 'rotated-root': diamond, 'clipped-child': square(0, 0, 15) })

    expect(projectedMarqueeTargets(scene, frame, { x: 1, y: 1, width: 5, height: 5 }, false)).toEqual([])
    expect(projectedMarqueeTargets(scene, frame, { x: 47, y: 1, width: 6, height: 6 }, false)).toEqual(['rotated-root'])
    expect(projectedMarqueeTargets(scene, frame, { x: 1, y: 1, width: 5, height: 5 }, true)).toEqual([])

    const reflected = frameOf(sceneOf(root), { 'rotated-root': reflectedDiamond })
    expect(projectedMarqueeTargets(sceneOf(root), reflected, { x: 1, y: 1, width: 5, height: 5 }, false)).toEqual([])
    expect(projectedMarqueeTargets(sceneOf(root), reflected, { x: 47, y: 1, width: 6, height: 6 }, false)).toEqual(['rotated-root'])
  })

  it('rejects copied and stale service publications before target resolution', () => {
    const node = sceneNode('node', 0)
    const frame = frameOf(sceneOf(node), { node: square(0, 0, 100) })
    const current: CanvasHudProjectionSnapshot = Object.freeze({ generation: 9, frame })
    const source = { getSnapshot: () => current }
    expect(currentCanvasHitFrame(source, key())).toBe(frame)

    let read = 0
    const copied = { getSnapshot: () => ++read === 1 ? Object.freeze({ generation: 9, frame }) : current }
    expect(currentCanvasHitFrame(copied, key())).toBeNull()
    expect(currentCanvasHitFrame(source, { ...key(), layoutGeneration: 3 })).toBeNull()
  })
})
