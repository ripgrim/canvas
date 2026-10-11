import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { buildScene, clickTarget, containingFrameAt, displayName, drillTarget, hitTest, marqueeTargets, selectChildren, selectParents, symmetricDifference } from './canvas-scene'

const appearance = { fills: [{ id: 'white-fill', type: 'solid' as const, color: { kind: 'literal' as const, color: { kind: 'hex' as const, hex: '#ffffff' } } }] }
/** Page 1: card > button (measured components), frame (300,0) > inner (+20,+20) > text (+10,+10), loose rectangle. */
const file = (innerOverflow: 'clip' | 'visible' = 'clip'): FileDocument => ({
  schemaVersion: 7, fileId: 'file-a', revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'atom-card', exportName: 'Card', name: 'Login Card', props: {} },
    button: { id: 'button', type: 'component', componentId: 'atom-button', exportName: 'Button', props: { children: 'Sign in' } },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 300, top: 0, width: 200, height: 200, overflow: 'clip' }, appearance },
    inner: { id: 'inner', type: 'frame', name: 'Inner', styles: { left: 20, top: 20, width: 100, height: 100, overflow: innerOverflow }, appearance },
    text: { id: 'text', type: 'text', name: 'Text', styles: { left: 10, top: 10, width: 300, height: 40 }, appearance, text: '  Welcome   back to the workspace today ' },
    loose: { id: 'loose', type: 'rectangle', name: 'Rectangle', styles: { left: -600, top: -600, width: 50, height: 50 }, appearance },
    elsewhere: { id: 'elsewhere', type: 'rectangle', name: 'Elsewhere', styles: { left: 0, top: 0, width: 10, height: 10 }, appearance },
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' },
    button: { parentId: 'card', orderKey: 'V', slot: 'children' },
    frame: { parentId: 'root-1', orderKey: 'W' },
    inner: { parentId: 'frame', orderKey: 'V' },
    text: { parentId: 'inner', orderKey: 'V' },
    loose: { parentId: 'root-1', orderKey: 'X' },
    elsewhere: { parentId: 'root-2', orderKey: 'V' },
  },
  theme: { tokens: {} },
})
const measured = { card: { componentId: 'atom-card', rect: { x: -176, y: -236, width: 352, height: 300 } }, button: { componentId: 'atom-button', rect: { x: -148, y: 0, width: 296, height: 40 } } }
const scene = buildScene(file(), 'page-1', measured)
const ids = (nodes: { id: string }[]) => nodes.map(node => node.id)

describe('AT-CAN scene identity and geometry', () => {
  it('orders the page in pre-order with depth, parent, world rect, and clip', () => {
    expect(scene.nodes.map(node => ({ id: node.id, kind: node.kind, parentId: node.parentId, depth: node.depth, order: node.order, rect: node.rect, clip: node.clip, flow: node.flow }))).toEqual([
      { id: 'card', kind: 'component', parentId: null, depth: 0, order: 0, rect: { x: -176, y: -236, width: 352, height: 300 }, clip: false, flow: false },
      { id: 'button', kind: 'component', parentId: 'card', depth: 1, order: 1, rect: { x: -148, y: 0, width: 296, height: 40 }, clip: false, flow: true },
      { id: 'frame', kind: 'frame', parentId: null, depth: 0, order: 2, rect: { x: 300, y: 0, width: 200, height: 200 }, clip: true, flow: false },
      { id: 'inner', kind: 'frame', parentId: 'frame', depth: 1, order: 3, rect: { x: 320, y: 20, width: 100, height: 100 }, clip: true, flow: false },
      { id: 'text', kind: 'text', parentId: 'inner', depth: 2, order: 4, rect: { x: 330, y: 30, width: 300, height: 40 }, clip: false, flow: false },
      { id: 'loose', kind: 'rectangle', parentId: null, depth: 0, order: 5, rect: { x: -600, y: -600, width: 50, height: 50 }, clip: false, flow: false },
    ])
    expect(scene.byId.get('text')!.name).toBe('Welcome back to the…')
    expect(scene.byId.get('card')!.name).toBe('Login Card')
  })

  it('shows only the requested page and nothing for unknown pages or no file', () => {
    expect(ids(buildScene(file(), 'page-2', measured).nodes)).toEqual(['elsewhere'])
    expect(buildScene(file(), 'page-404', measured).nodes).toEqual([])
    expect(buildScene(null, 'page-1', measured).nodes).toEqual([])
  })

  it('omits component nodes until measured with the matching component identity', () => {
    expect(ids(buildScene(file(), 'page-1', {}).nodes)).toEqual(['frame', 'inner', 'text', 'loose'])
    const rebound = { ...measured, button: { componentId: 'atom-other', rect: measured.button.rect } }
    expect(ids(buildScene(file(), 'page-1', rebound).nodes)).toEqual(['card', 'frame', 'inner', 'text', 'loose'])
  })

  it('names nodes by content, name, or export name and truncates text at 20 characters', () => {
    const source = file()
    expect(displayName(source, 'text')).toBe('Welcome back to the…')
    expect(displayName(source, 'card')).toBe('Login Card')
    expect(displayName(source, 'button')).toBe('Button')
    expect(displayName(source, 'frame')).toBe('Frame')
    expect(displayName(source, 'root-1')).toBe('root-1')
    expect(displayName(source, 'missing')).toBe('missing')
    ;(source.nodes.text as { text: string }).text = 'Exactly twenty chars'
    expect(displayName(source, 'text')).toBe('Exactly twenty chars')
    ;(source.nodes.text as { text: string }).text = '   '
    expect(displayName(source, 'text')).toBe('Text')
  })
})

describe('AT-CAN hit testing and selection policy', () => {
  it('returns the top-most node first and respects frame clipping', () => {
    expect(ids(hitTest(scene, { x: 340, y: 40 }))).toEqual(['text', 'inner', 'frame'])
    // The text overflows inner to x 630; inner clips it at x 420.
    expect(ids(hitTest(scene, { x: 450, y: 40 }))).toEqual(['frame'])
    expect(ids(hitTest(buildScene(file('visible'), 'page-1', measured), { x: 450, y: 40 }))).toEqual(['text', 'frame'])
    expect(hitTest(scene, { x: 1000, y: 1000 })).toEqual([])
  })

  it('selects the direct child of the containing root, drills below a selected ancestor, and goes deep with the modifier', () => {
    expect(clickTarget(scene, { x: 340, y: 40 }, [], false)!.id).toBe('inner')
    expect(clickTarget(scene, { x: 340, y: 40 }, ['inner'], false)!.id).toBe('text')
    expect(clickTarget(scene, { x: 340, y: 40 }, ['text'], false)!.id).toBe('text')
    expect(clickTarget(scene, { x: 340, y: 40 }, [], true)!.id).toBe('text')
    expect(clickTarget(scene, { x: 450, y: 25 }, [], false)!.id).toBe('frame')
    expect(clickTarget(scene, { x: 0, y: 20 }, [], false)!.id).toBe('button')
    expect(clickTarget(scene, { x: 0, y: -200 }, [], false)!.id).toBe('card')
    expect(clickTarget(scene, { x: 1000, y: 1000 }, [], false)).toBeNull()
  })

  it('drills one level below the selected ancestor on double click', () => {
    expect(drillTarget(scene, { x: 340, y: 40 }, [])!.id).toBe('frame')
    expect(drillTarget(scene, { x: 340, y: 40 }, ['frame'])!.id).toBe('inner')
    expect(drillTarget(scene, { x: 340, y: 40 }, ['inner'])!.id).toBe('text')
    expect(drillTarget(scene, { x: 1000, y: 1000 }, [])).toBeNull()
  })

  it('selects intersecting roots for a shallow marquee and every node for a deep one', () => {
    expect(marqueeTargets(scene, { x: 310, y: 10, width: 20, height: 20 }, false)).toEqual(['frame'])
    expect(marqueeTargets(scene, { x: 310, y: 10, width: 20, height: 20 }, true)).toEqual(['frame', 'inner'])
    expect(marqueeTargets(scene, { x: -100, y: 10, width: 20, height: 20 }, true)).toEqual(['card', 'button'])
    expect(marqueeTargets(scene, { x: -700, y: -700, width: 50, height: 50 }, false)).toEqual([])
  })

  it('finds the deepest containing frame, skipping an excluded subtree', () => {
    expect(containingFrameAt(scene, { x: 340, y: 40 })!.id).toBe('inner')
    expect(containingFrameAt(scene, { x: 340, y: 40 }, 'inner')!.id).toBe('frame')
    expect(containingFrameAt(scene, { x: 340, y: 40 }, 'frame')).toBeNull()
    expect(containingFrameAt(scene, { x: 450, y: 150 })!.id).toBe('frame')
    expect(containingFrameAt(scene, { x: 0, y: -200 })).toBeNull()
    expect(containingFrameAt(scene, { x: -575, y: -575 })).toBeNull()
  })

  it('toggles with a symmetric difference and walks children and parents', () => {
    expect(symmetricDifference(['a', 'b'], ['b', 'c'])).toEqual(['a', 'c'])
    expect(selectChildren(scene, ['frame'])).toEqual(['inner'])
    expect(selectChildren(scene, ['loose'])).toEqual(['loose'])
    expect(selectParents(scene, ['text', 'inner'])).toEqual(['inner', 'frame'])
    expect(selectParents(scene, ['card'])).toEqual(['card'])
  })
})
