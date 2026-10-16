import { describe, expect, it } from 'vitest'
import { legacyTextProperties } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { buildScene, clickTarget, containingFrameAt, displayName, drillTarget, hitTest, marqueeTargets, selectChildren, selectParents, symmetricDifference } from './canvas-scene'

const appearance = { fills: [{ id: 'white-fill', type: 'solid' as const, color: { kind: 'literal' as const, color: { kind: 'hex' as const, hex: '#ffffff' } } }] }
/** Page 1: card > button (measured components), frame (300,0) > inner (+20,+20) > text (+10,+10), loose rectangle. */
const file = (innerOverflow: 'clip' | 'visible' = 'clip'): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'file-a', revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'atom-card', exportName: 'Card', name: 'Login Card', props: {} },
    button: { id: 'button', type: 'component', componentId: 'atom-button', exportName: 'Button', props: { children: 'Sign in' } },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 300, 0], width: 200, height: 200, overflow: 'clip' }, appearance },
    inner: { id: 'inner', type: 'frame', name: 'Inner', styles: { relativeTransform: [1, 0, 0, 1, 20, 20], width: 100, height: 100, overflow: innerOverflow }, appearance },
    text: { id: 'text', type: 'text', name: 'Text', styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 300, height: 40 }, appearance, text: '  Welcome   back to the workspace today ', ...legacyTextProperties() },
    loose: { id: 'loose', type: 'rectangle', name: 'Rectangle', styles: { relativeTransform: [1, 0, 0, 1, -600, -600], width: 50, height: 50 }, appearance },
    elsewhere: { id: 'elsewhere', type: 'rectangle', name: 'Elsewhere', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 }, appearance },
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
    const generated = { ...measured, card: { ...measured.card, layoutGeneration: 4 }, button: { ...measured.button, layoutGeneration: 4 } }
    expect(ids(buildScene(file(), 'page-1', generated, 4).nodes)).toEqual(ids(scene.nodes))
    expect(ids(buildScene(file(), 'page-1', generated, 5).nodes)).toEqual(['frame', 'inner', 'text', 'loose'])
  })

  it('uses current DOM geometry for intrinsic text, including its resolved alignment and parent box edges', () => {
    const source = file()
    const text = source.nodes.text
    if (!text || text.type !== 'text' || !text.textStyle || !text.textSizing) throw new Error('Text fixture is missing')
    text.textSizing = { width: { mode: 'fit' }, height: { mode: 'fit' } }
    text.textStyle = { ...text.textStyle, horizontalAlign: 'center' }
    const geometry = { ...measured, text: { canvasKind: 'text' as const, documentRevision: source.revision, layoutGeneration: 2, rect: { x: 390, y: 30, width: 180, height: 24 }, offset: { x: 160, y: 10, width: 180, height: 24, origin: { x: 90, y: 12 } } } }
    expect(buildScene(source, 'page-1', geometry, 2).byId.get('text')?.rect).toEqual({ x: 390, y: 30, width: 180, height: 24 })

    text.textStyle = { ...text.textStyle, horizontalAlign: 'right' }
    expect(buildScene(source, 'page-1', geometry, 2).byId.get('text')?.rect).toEqual({ x: 390, y: 30, width: 180, height: 24 })
  })

  it('ignores native measurements for fixed text and fixed non-text primitives', () => {
    const hostile = {
      ...measured,
      text: { canvasKind: 'text' as const, rect: { x: 999, y: 999, width: 1, height: 1 }, offset: { x: 999, y: 999, width: 1, height: 1, origin: { x: 0, y: 0 } } },
      loose: { canvasKind: 'rectangle' as const, rect: { x: 999, y: 999, width: 1, height: 1 }, offset: { x: 999, y: 999, width: 1, height: 1, origin: { x: 0, y: 0 } } },
    }
    const fixed = buildScene(file(), 'page-1', hostile)
    expect(fixed.byId.get('text')?.rect).toEqual({ x: 330, y: 30, width: 300, height: 40 })
    expect(fixed.byId.get('loose')?.rect).toEqual({ x: -600, y: -600, width: 50, height: 50 })
  })

  it('uses current DOM geometry for freeform primitives with browser-owned sizing', () => {
    const source = file()
    const frame = source.nodes.frame
    if (!frame || frame.type !== 'frame') throw new Error('Frame fixture is missing')
    frame.layout = {
      item: {
        position: { mode: 'freeform' },
        height: { value: { kind: 'intrinsic', value: 'fit-content' } },
      },
      container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'center', align: 'center' } },
    }
    const current = {
      ...measured,
      frame: { canvasKind: 'frame' as const, documentRevision: source.revision, layoutGeneration: 3, rect: { x: 300, y: 0, width: 200, height: 311 } },
    }

    expect(buildScene(source, 'page-1', current, 3).byId.get('frame')?.rect).toEqual({ x: 300, y: 0, width: 200, height: 311 })
    expect(buildScene(source, 'page-1', measured, 3).byId.has('frame')).toBe(false)
    expect(buildScene(source, 'page-1', measured, 3).byId.has('inner')).toBe(false)
  })

  it('PAPER-FLEX-001/002 uses only current DOM geometry for flow and absolute primitives', () => {
    const source = file()
    const frame = source.nodes.frame
    const inner = source.nodes.inner
    if (!frame || frame.type !== 'frame' || !inner || inner.type !== 'frame') throw new Error('Frame fixtures are missing')
    frame.layout = { container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } }, item: { position: { mode: 'freeform' } } }
    inner.layout = { container: { display: 'freeform' }, item: { position: { mode: 'flow' } } }

    const deferred = buildScene(source, 'page-1', measured)
    expect(deferred.byId.has('inner')).toBe(false)
    expect(deferred.byId.has('text')).toBe(false)
    const current = { ...measured, inner: { canvasKind: 'frame' as const, documentRevision: source.revision, layoutGeneration: 2, rect: { x: 410, y: 25, width: 120, height: 80 } } }
    expect(buildScene(source, 'page-1', current, 2).byId.get('inner')?.rect).toEqual({ x: 410, y: 25, width: 120, height: 80 })
    const stale = { ...current, inner: { ...current.inner, documentRevision: source.revision - 1 } }
    expect(buildScene(source, 'page-1', stale, 2).byId.has('inner')).toBe(false)
    expect(buildScene(source, 'page-1', current, 3).byId.has('inner')).toBe(false)
    const { layoutGeneration: _generation, ...withoutGeneration } = current.inner
    expect(buildScene(source, 'page-1', { ...current, inner: withoutGeneration }, 2).byId.has('inner')).toBe(false)
  })

  it('PAPER-FLEX-002 keeps one unrotated measured box and one authored rotation for semantic primitives', () => {
    const source = file()
    const inner = source.nodes.inner
    if (!inner || inner.type !== 'frame') throw new Error('Inner frame fixture is missing')
    inner.layout = { container: { display: 'freeform' }, item: { position: { mode: 'absolute', right: { kind: 'px', value: 12 }, bottom: { kind: 'px', value: 8 } } } }
    inner.styles = { ...inner.styles, relativeTransform: [0, 1, -1, 0, 120, 20] }
    const geometry = { ...measured, inner: { canvasKind: 'frame' as const, documentRevision: source.revision, layoutGeneration: 4, rect: { x: 440, y: 50, width: 120, height: 80 } } }
    const node = buildScene(source, 'page-1', geometry, 4).byId.get('inner')
    expect(node).toMatchObject({ rect: { x: 440, y: 50, width: 120, height: 80 }, rotation: 90 })
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

  it('excludes directly and ancestrally locked nodes from canvas hit testing and marquee selection', () => {
    const locked = file()
    const frame = locked.nodes.frame
    if (!frame || frame.type === 'root') throw new Error('Frame fixture is missing')
    frame.isLocked = true
    const lockedScene = buildScene(locked, 'page-1', measured)
    expect(lockedScene.byId.get('frame')?.locked).toBe(true)
    expect(lockedScene.byId.get('inner')?.locked).toBe(true)
    expect(hitTest(lockedScene, { x: 340, y: 40 })).toEqual([])
    expect(marqueeTargets(lockedScene, { x: 310, y: 10, width: 20, height: 20 }, true)).toEqual([])
    expect(clickTarget(lockedScene, { x: 340, y: 40 }, [], true)).toBeNull()
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
