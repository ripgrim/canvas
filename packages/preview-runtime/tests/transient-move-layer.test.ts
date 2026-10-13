import { describe, expect, it } from 'vitest'
import { createFlowDragLayer, createTransientMoveLayer, createTransientPresentationLayer } from '../src/transient-move-layer.mjs'

class FakeStyle {
  readonly values = new Map<string, { value: string; priority: string }>()
  readonly writes: string[] = []
  getPropertyValue(property: string) { return this.values.get(property)?.value ?? '' }
  getPropertyPriority(property: string) { return this.values.get(property)?.priority ?? '' }
  setProperty(property: string, value: string, priority = '') { this.writes.push(property); this.values.set(property, { value, priority }) }
  removeProperty(property: string) { this.values.delete(property) }
}

class FakeElement {
  readonly style = new FakeStyle()
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  offsetParent: FakeElement | null = null
  parentElement: FakeElement | null = null
  tabIndex = 0
  inert = false
  removed = false
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  removeAttribute(name: string) { this.attributes.delete(name) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  querySelectorAll() { return [] }
  append(child: FakeElement) { child.parentElement = this; this.children.push(child) }
  insertBefore(child: FakeElement, reference: FakeElement | null) {
    child.parentElement = this
    const index = reference ? this.children.indexOf(reference) : -1
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
  }
  cloneNode() {
    const clone = new FakeElement()
    for (const [name, value] of this.style.values) clone.style.values.set(name, { ...value })
    for (const [name, value] of this.attributes) clone.attributes.set(name, value)
    return clone
  }
  remove() { this.removed = true; if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1) }
}

describe('AT-CAN-006 transient move presentation', () => {
  it('moves an inert optimistic duplicate while leaving the authored source untouched', () => {
    const parent = new FakeElement()
    const source = new FakeElement()
    source.style.setProperty('translate', '3px 4px')
    parent.append(source)
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: (element: FakeElement) => ({ translate: element.style.getPropertyValue('translate') }) } }
    const layer = createTransientMoveLayer(ownerDocument, { querySelector: () => source })

    layer.update([{ nodeId: 'node-1', dx: 10, dy: 20, duplicate: true }])

    expect(source.style.getPropertyValue('translate')).toBe('3px 4px')
    expect(parent.children).toHaveLength(2)
    const duplicate = parent.children[1]!
    expect(duplicate.getAttribute('data-preview-transient-clone')).toBe('')
    expect(duplicate.inert).toBe(true)
    expect(duplicate.style.getPropertyValue('translate')).toBe('13px 24px')
    layer.clear()
    expect(parent.children).toEqual([source])
  })

  it('indexes an element and its base translation once for the lifetime of a gesture', () => {
    const element = new FakeElement()
    element.style.setProperty('translate', '3px 4px')
    let queries = 0
    let computedReads = 0
    const ownerDocument = {
      defaultView: {
        HTMLElement: FakeElement,
        getComputedStyle: () => { computedReads += 1; return { translate: '3px 4px' } },
      },
    }
    const container = { querySelector: () => { queries += 1; return element } }
    const layer = createTransientMoveLayer(ownerDocument, container)

    layer.update([{ nodeId: 'node-1', dx: 10, dy: 20 }])
    layer.update([{ nodeId: 'node-1', dx: 14, dy: 25 }])

    expect(queries).toBe(1)
    expect(computedReads).toBe(1)
    expect(element.style.getPropertyValue('translate')).toBe('17px 29px')
    layer.clear()
    expect(element.style.getPropertyValue('translate')).toBe('3px 4px')
  })

  it('restores resize declarations that disappear before the gesture ends', () => {
    const element = new FakeElement()
    element.style.setProperty('width', '100px')
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientMoveLayer(ownerDocument, { querySelector: () => element })
    layer.setDocument({ assets: {}, canvas: { elements: [{ id: 'node-1', kind: 'frame' }] } })

    layer.update([{ nodeId: 'node-1', dx: 0, dy: 0, width: 140 }])
    expect(element.style.getPropertyValue('width')).toBe('140px')
    layer.update([{ nodeId: 'node-1', dx: 1, dy: 2 }])
    expect(element.style.getPropertyValue('width')).toBe('100px')
    layer.clear()
    expect(element.style.getPropertyValue('translate')).toBe('')
  })

  it('applies a rotation delta with the individual transform property and restores it exactly', () => {
    const element = new FakeElement()
    element.style.setProperty('rotate', '12deg', 'revert-layer')
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientMoveLayer(ownerDocument, { querySelector: () => element })

    layer.update([{ nodeId: 'node-1', dx: 0, dy: 0, rotationDelta: 37.5 }])
    expect(element.style.values.get('rotate')).toEqual({ value: '37.5deg', priority: 'important' })
    layer.clear()
    expect(element.style.values.get('rotate')).toEqual({ value: '12deg', priority: 'revert-layer' })
  })

  it('does not restore a stale size after the authoritative render replaces it', () => {
    const element = new FakeElement()
    element.style.setProperty('width', '100px')
    element.style.setProperty('height', '80px')
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientMoveLayer(ownerDocument, { querySelector: () => element })
    layer.setDocument({ assets: {}, canvas: { elements: [{ id: 'node-1', kind: 'frame' }] } })

    layer.update([{ nodeId: 'node-1', dx: 0, dy: 0, width: 140, height: 120 }])
    element.style.setProperty('width', '180px')
    element.style.setProperty('height', '160px')
    layer.update([])
    expect(element.style.getPropertyValue('width')).toBe('100px')
    expect(element.style.getPropertyValue('height')).toBe('80px')

    layer.update([{ nodeId: 'node-1', dx: 0, dy: 0, width: 140, height: 120 }])
    layer.clear()
    element.style.setProperty('width', '180px')
    element.style.setProperty('height', '160px')
    layer.update([])

    expect(element.style.getPropertyValue('width')).toBe('180px')
    expect(element.style.getPropertyValue('height')).toBe('160px')
  })

  it('restores a node immediately when it leaves the active transient set', () => {
    const first = new FakeElement()
    const second = new FakeElement()
    const elements = new Map([['node-1', first], ['node-2', second]])
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientMoveLayer(ownerDocument, {
      querySelector: (selector: string) => elements.get(selector.includes('node-1') ? 'node-1' : 'node-2'),
    })

    layer.update([{ nodeId: 'node-1', dx: 10, dy: 20 }, { nodeId: 'node-2', dx: 30, dy: 40 }])
    layer.update([{ nodeId: 'node-2', dx: 31, dy: 41 }])

    expect(first.style.getPropertyValue('translate')).toBe('')
    expect(second.style.getPropertyValue('translate')).toBe('31px 41px')
  })

  it('updates image geometry without rebuilding the image data URL and restores the compositor hint', () => {
    const element = new FakeElement()
    const image = 'url("data:image/png;base64,' + 'A'.repeat(4_096) + '")'
    element.style.setProperty('background-image', image)
    element.style.setProperty('background-size', 'cover')
    element.style.writes.length = 0
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientMoveLayer(ownerDocument, { querySelector: () => element })
    layer.setDocument({ assets: { photo: { mime: 'image/png', data: 'AAAA' } }, canvas: { elements: [{ id: 'node-1', kind: 'frame' }] } })

    layer.update([{ nodeId: 'node-1', dx: -20, dy: 0, width: 140, height: 100, appearance: { fills: [{ type: 'image', assetId: 'photo', fit: 'cover', geometry: { x: 20, y: 4, width: 180, height: 120 } }] } }])
    layer.update([{ nodeId: 'node-1', dx: -24, dy: 0, width: 144, height: 100, appearance: { fills: [{ type: 'image', assetId: 'photo', fit: 'cover', geometry: { x: 24, y: 4, width: 180, height: 120 } }] } }])

    expect(element.style.getPropertyValue('background-image')).toBe(image)
    expect(element.style.writes).not.toContain('background-image')
    expect(element.style.getPropertyValue('background-position')).toBe('24px 4px')
    expect(element.style.getPropertyValue('background-size')).toBe('180px 120px')
    expect(element.style.getPropertyValue('will-change')).toContain('background-position')
    layer.update([])
    expect(element.style.getPropertyValue('background-image')).toBe(image)
    expect(element.style.getPropertyValue('background-size')).toBe('cover')
    expect(element.style.getPropertyValue('will-change')).toBe('')
  })
})

describe('AT-CAN-006 and PAPER-FLEX-007 coordinate-explicit transient presentation layer', () => {
  const fence = { documentRevision: 4, layoutGeneration: 2, measurementRevision: 9 }

  it('writes parent-padding geometry literally on primitive and Component roots without a wrapper or transform rewrite', () => {
    const primitive = new FakeElement()
    const component = new FakeElement()
    primitive.style.setProperty('transform', 'matrix(0, 2, -2, 0, 0, 0)', 'important')
    primitive.style.setProperty('transform-origin', '0px 0px')
    component.style.setProperty('transform', 'rotate(15deg)')
    primitive.style.writes.length = 0
    component.style.writes.length = 0
    const elements = new Map([['primitive', primitive], ['component', component]])
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const container = { querySelector: (selector: string) => elements.get(selector.includes('primitive') ? 'primitive' : 'component') }
    const layer = createTransientPresentationLayer(ownerDocument, container)
    layer.setDocument({ assets: {}, canvas: { elements: [{ id: 'primitive', kind: 'rectangle' }] }, nodes: { component: {} } })

    layer.update([{
      kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-1', sampleSequence: 1, fence,
      items: [
        { nodeId: 'primitive', parentNodeId: null, startRect: { x: 0, y: 0, width: 10, height: 20 }, rect: { x: 5, y: -15, width: 35, height: 50 } },
        { nodeId: 'component', parentNodeId: null, startRect: { x: 4, y: 6, width: 20, height: 30 }, rect: { x: -8, y: 12, width: 44, height: 55 } },
      ],
    }])

    expect(primitive.style.getPropertyValue('left')).toBe('5px')
    expect(primitive.style.getPropertyValue('top')).toBe('-15px')
    expect(primitive.style.getPropertyValue('width')).toBe('35px')
    expect(primitive.style.getPropertyValue('height')).toBe('50px')
    expect(component.style.getPropertyValue('left')).toBe('-8px')
    expect(component.style.getPropertyValue('top')).toBe('12px')
    expect(component.style.getPropertyValue('width')).toBe('44px')
    expect(component.style.getPropertyValue('height')).toBe('55px')
    expect(primitive.style.getPropertyValue('transform')).toBe('matrix(0, 2, -2, 0, 0, 0)')
    expect(component.style.getPropertyValue('transform')).toBe('rotate(15deg)')
    expect(primitive.style.writes).not.toContain('transform')
    expect(component.style.writes).not.toContain('transform')
  })

  it('keeps move ownership to translate and will-change and restores exact values and priorities', () => {
    const element = new FakeElement()
    element.style.setProperty('translate', '3px 4px', 'important')
    element.style.setProperty('will-change', 'opacity', 'revert-layer')
    element.style.writes.length = 0
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: '3px 4px' }) } }
    const layer = createTransientPresentationLayer(ownerDocument, { querySelector: () => element })
    layer.setDocument({ nodes: { component: {} }, canvas: { elements: [] } })

    layer.update([{ kind: 'move-world', coordinateSpace: 'world', interactionId: 'move-1', sampleSequence: 7, fence, items: [{ nodeId: 'component', dx: 10, dy: -20 }] }])
    expect([...element.style.values.keys()].sort()).toEqual(['translate', 'will-change'])
    expect(element.style.values.get('translate')).toEqual({ value: '13px -16px', priority: 'important' })
    expect(element.style.values.get('will-change')).toEqual({ value: 'translate', priority: 'important' })

    layer.clear()
    expect(element.style.values.get('translate')).toEqual({ value: '3px 4px', priority: 'important' })
    expect(element.style.values.get('will-change')).toEqual({ value: 'opacity', priority: 'revert-layer' })
  })

  it('writes image geometry but never background-image and restores removed, cleared, and disposed nodes exactly', () => {
    const primitive = new FakeElement()
    const component = new FakeElement()
    const image = 'url("data:image/png;base64,AAAA")'
    for (const element of [primitive, component]) {
      element.style.setProperty('background-image', image, 'important')
      element.style.setProperty('background-size', 'cover', 'revert-layer')
      element.style.setProperty('left', '1px', 'important')
      element.style.writes.length = 0
    }
    const elements = new Map([['primitive', primitive], ['component', component]])
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientPresentationLayer(ownerDocument, { querySelector: (selector: string) => elements.get(selector.includes('primitive') ? 'primitive' : 'component') })
    layer.setDocument({ assets: { photo: { mime: 'image/png', data: 'AAAA' } }, nodes: { component: {} }, canvas: { elements: [{ id: 'primitive', kind: 'rectangle' }] } })
    const appearance = { fills: [{ type: 'image', assetId: 'photo', fit: 'cover', geometry: { x: 7, y: 8, width: 90, height: 60 } }] }
    const item = (nodeId: string) => ({ nodeId, parentNodeId: null, startRect: { x: 0, y: 0, width: 20, height: 20 }, rect: { x: 2, y: 3, width: 40, height: 50 }, appearance })

    layer.update([{ kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-images', sampleSequence: 1, fence, items: [item('primitive'), item('component')] }])
    for (const element of [primitive, component]) {
      expect(element.style.getPropertyValue('background-image')).toBe(image)
      expect(element.style.writes).not.toContain('background-image')
      expect(element.style.getPropertyValue('background-position')).toBe('7px 8px')
      expect(element.style.getPropertyValue('background-size')).toBe('90px 60px')
    }

    layer.update([{ kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-component', sampleSequence: 2, fence, items: [item('component')] }])
    expect(primitive.style.values.get('left')).toEqual({ value: '1px', priority: 'important' })
    expect(primitive.style.values.get('background-size')).toEqual({ value: 'cover', priority: 'revert-layer' })
    layer.clear()
    expect(component.style.values.get('left')).toEqual({ value: '1px', priority: 'important' })
    expect(component.style.values.get('background-size')).toEqual({ value: 'cover', priority: 'revert-layer' })

    layer.update([{ kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-dispose', sampleSequence: 3, fence, items: [item('primitive')] }])
    layer.dispose()
    expect(primitive.style.values.get('left')).toEqual({ value: '1px', priority: 'important' })
    expect(primitive.style.getPropertyValue('width')).toBe('')
  })

  it('restores an old root before a same-authority remount and captures the replacement root independently', () => {
    const oldRoot = new FakeElement()
    const newRoot = new FakeElement()
    oldRoot.style.setProperty('left', '1px', 'important')
    newRoot.style.setProperty('left', '21px', 'revert-layer')
    let current = oldRoot
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientPresentationLayer(ownerDocument, { querySelector: () => current })
    layer.setDocument({ nodes: { component: {} }, canvas: { elements: [] } })
    const next = (sampleSequence: number, x: number) => [{
      kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'remount', sampleSequence, fence,
      items: [{ nodeId: 'component', parentNodeId: null, startRect: { x: 0, y: 0, width: 10, height: 10 }, rect: { x, y: 2, width: 30, height: 40 } }],
    }]

    layer.update(next(1, 5))
    expect(oldRoot.style.getPropertyValue('left')).toBe('5px')
    current = newRoot
    layer.update(next(2, 25))

    expect(oldRoot.style.values.get('left')).toEqual({ value: '1px', priority: 'important' })
    expect(newRoot.style.values.get('left')).toEqual({ value: '25px', priority: 'important' })
    layer.clear()
    expect(newRoot.style.values.get('left')).toEqual({ value: '21px', priority: 'revert-layer' })
  })

  it('keeps transient ownership visible while retaining the latest authored overlapping declaration for restore', () => {
    const component = new FakeElement()
    component.style.setProperty('width', '20px', 'revert-layer')
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, getComputedStyle: () => ({ translate: 'none' }) } }
    const layer = createTransientPresentationLayer(ownerDocument, { querySelector: () => component })
    layer.setDocument({ nodes: { component: {} }, canvas: { elements: [] } })
    const presentation = [{
      kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'authored-drift', sampleSequence: 1, fence,
      items: [{ nodeId: 'component', parentNodeId: null, startRect: { x: 0, y: 0, width: 20, height: 20 }, rect: { x: 0, y: 0, width: 80, height: 30 } }],
    }]

    layer.update(presentation)
    component.style.setProperty('width', '44px', 'important')
    layer.update([{ ...presentation[0], sampleSequence: 2 }])
    expect(component.style.values.get('width')).toEqual({ value: '80px', priority: 'important' })
    layer.clear()
    expect(component.style.values.get('width')).toEqual({ value: '44px', priority: 'important' })
  })
})

describe('PAPER-FLEX-006-RUNTIME-V8 flow drag DOM layer', () => {
  const geometry = (x = 0, y = 0) => ({
    coordinateSpace: 'world', semanticSize: { width: 40, height: 20 },
    quad: [{ x, y }, { x: x + 40, y }, { x: x + 40, y: y + 20 }, { x, y: y + 20 }],
    aabb: { x, y, width: 40, height: 20 },
  })
  const relationship = { parentId: 'page-root', orderKey: 'a', slot: { presence: 'absent' } }
  const base = (mode: 'flow' | 'absolute') => ({
    kind: 'flow-drag', coordinateSpace: 'world', identity: { interactionId: `drag-${mode}`, gestureGeneration: 1, sampleSequence: 1 },
    fence: { fileId: 'file', fileRevision: 1, measurementRevision: 1, documentRevision: 1, layoutGeneration: 1, pageId: 'page', pageRootId: 'page-root' },
    retention: { kind: 'active', gestureGeneration: 1, sampleSequence: 1 },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 10 } },
    original: {
      documentNodeId: mode === 'flow' ? 'flow-node' : 'absolute-node', kind: 'rectangle', name: 'Node', sourceRelationship: relationship,
      sourceIndex: 0, mode, source: geometry(), current: geometry(10, 10),
      sourceOffsetParentPose: mode === 'absolute' ? { coordinateSpace: 'source-offset-parent', offsetParentNodeId: null, sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [0, -1, -1, 0, 50, 30] } : null,
      dom: mode === 'flow' ? { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null } : { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
      namePresentation: { visible: true, anchor: mode === 'flow' ? 'source' : 'current', pose: mode === 'flow' ? geometry() : geometry(10, 10) },
    },
    movingVisual: mode === 'flow'
      ? { kind: 'fill-ghost', documentNodeId: null, geometry: geometry(10, 10), fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden' }
      : { kind: 'document-node', documentNodeId: 'absolute-node', geometry: geometry(10, 10) },
    supportClone: null, target: null,
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
  })
  const harness = () => {
    const container = new FakeElement()
    const flow = new FakeElement(); flow.setAttribute('data-preview-canvas', 'flow-node'); flow.setAttribute('data-preview-kind', 'rectangle'); flow.offsetParent = container
    const absolute = new FakeElement(); absolute.setAttribute('data-preview-canvas', 'absolute-node'); absolute.setAttribute('data-preview-kind', 'rectangle'); absolute.offsetParent = container
    const roots = [flow, absolute]
    const matches = (element: FakeElement, selector: string) => [...element.attributes].every(() => {
      const canvas = /data-preview-canvas="([^"]+)"/.exec(selector)?.[1]
      const kind = /data-preview-kind="([^"]+)"/.exec(selector)?.[1]
      return (!canvas || element.getAttribute('data-preview-canvas') === canvas) && (!kind || element.getAttribute('data-preview-kind') === kind)
    })
    ;(container as FakeElement & { querySelectorAll: (selector: string) => FakeElement[]; querySelector: () => null }).querySelectorAll = selector => roots.filter(element => matches(element, selector))
    ;(container as FakeElement & { querySelector: () => null }).querySelector = () => null
    const callbacks: Array<() => void> = []
    class Observer { constructor(readonly callback: () => void) { callbacks.push(callback) } observe() {} disconnect() {} }
    const ownerDocument = {
      defaultView: { HTMLElement: FakeElement, MutationObserver: Observer, getComputedStyle: () => { throw new Error('flow drag must not read computed style') } },
      createElement: () => new FakeElement(),
    }
    const layer = createFlowDragLayer(ownerDocument, container)
    layer.setDocument({ nodes: {}, canvas: { elements: [{ id: 'flow-node', kind: 'rectangle' }, { id: 'absolute-node', kind: 'rectangle' }] } })
    return { layer, container, flow, absolute, roots, callbacks }
  }

  it('dims a flow original with Paper priority, paints an identity-free ghost, and restores exact authored opacity', () => {
    const { layer, container, flow } = harness()
    flow.style.setProperty('opacity', '0.85', 'revert-layer')
    layer.update([base('flow')])
    expect(flow.style.values.get('opacity')).toEqual({ value: '0.6', priority: 'important' })
    const ghost = container.children.find(child => child.getAttribute('data-preview-flow-ghost') === '')!
    expect(ghost.getAttribute('data-preview-instance')).toBeNull()
    expect(ghost.getAttribute('data-preview-canvas')).toBeNull()
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(ghost.tabIndex).toBe(-1)
    layer.clear()
    expect(flow.style.values.get('opacity')).toEqual({ value: '0.85', priority: 'revert-layer' })
    expect(ghost.removed).toBe(true)
  })

  it('applies the supplied absolute matrix literally, neutralizes transform longhands, and promotes authored drift to the restore baseline', () => {
    const { layer, absolute } = harness()
    absolute.style.setProperty('translate', '4px 5px', 'important')
    absolute.style.setProperty('rotate', '25deg')
    absolute.style.setProperty('scale', '-1 2')
    absolute.style.setProperty('transform', 'skew(8deg)', 'revert-layer')
    layer.update([base('absolute')])
    expect(absolute.style.values.get('transform')).toEqual({ value: 'matrix(0, -1, -1, 0, 50, 30)', priority: 'important' })
    expect(absolute.style.values.get('translate')).toEqual({ value: 'none', priority: 'important' })
    expect(absolute.style.values.get('rotate')).toEqual({ value: 'none', priority: 'important' })
    expect(absolute.style.values.get('scale')).toEqual({ value: 'none', priority: 'important' })
    absolute.style.setProperty('rotate', '70deg', 'revert-layer')
    layer.clear()
    expect(absolute.style.values.get('translate')).toEqual({ value: '4px 5px', priority: 'important' })
    expect(absolute.style.values.get('rotate')).toEqual({ value: '70deg', priority: 'revert-layer' })
    expect(absolute.style.values.get('scale')).toEqual({ value: '-1 2', priority: '' })
    expect(absolute.style.values.get('transform')).toEqual({ value: 'skew(8deg)', priority: 'revert-layer' })
  })

  it('fails closed for ambiguous roots and offset-parent mismatches, then rebinds a replaced exact root without residue', () => {
    const { layer, container, absolute, roots, callbacks } = harness()
    const presentation = base('absolute')
    absolute.offsetParent = new FakeElement()
    layer.update([presentation])
    expect(absolute.style.getPropertyValue('transform')).toBe('')
    absolute.offsetParent = container
    callbacks[0]!()
    expect(absolute.style.getPropertyValue('transform')).toContain('matrix(')
    const duplicate = new FakeElement(); duplicate.setAttribute('data-preview-canvas', 'absolute-node'); duplicate.setAttribute('data-preview-kind', 'rectangle'); duplicate.offsetParent = container
    roots.push(duplicate)
    callbacks[0]!()
    expect(absolute.style.getPropertyValue('transform')).toBe('')
    roots.splice(roots.indexOf(absolute), 1)
    callbacks[0]!()
    expect(duplicate.style.getPropertyValue('transform')).toContain('matrix(')
    layer.dispose()
    expect(duplicate.style.getPropertyValue('transform')).toBe('')
  })

  it('fails closed when a root Component has an ambiguous preview host', () => {
    const container = new FakeElement()
    const component = new FakeElement(); component.setAttribute('data-preview-instance', 'component-node'); component.setAttribute('data-preview-component', 'atom-card')
    const firstHost = new FakeElement(); firstHost.setAttribute('data-preview-host', '')
    const secondHost = new FakeElement(); secondHost.setAttribute('data-preview-host', '')
    component.offsetParent = firstHost
    const all = [component, firstHost, secondHost]
    ;(container as FakeElement & { querySelectorAll: (selector: string) => FakeElement[] }).querySelectorAll = selector => {
      if (selector === '[data-preview-host]') return all.filter(element => element.getAttribute('data-preview-host') === '')
      return all.filter(element => element.getAttribute('data-preview-instance') === 'component-node' && selector.includes('component-node'))
    }
    class Observer { observe() {} disconnect() {} }
    const ownerDocument = { defaultView: { HTMLElement: FakeElement, MutationObserver: Observer }, createElement: () => new FakeElement() }
    const layer = createFlowDragLayer(ownerDocument, container)
    layer.setDocument({ nodes: { 'component-node': { componentId: 'atom-card' } }, canvas: { elements: [] } })
    const presentation = base('absolute')
    presentation.original.documentNodeId = 'component-node'
    presentation.original.kind = 'component'
    presentation.movingVisual.documentNodeId = 'component-node'
    layer.update([presentation])
    expect(component.style.getPropertyValue('transform')).toBe('')
    all.splice(all.indexOf(secondHost), 1)
    layer.reapply()
    expect(component.style.getPropertyValue('transform')).toContain('matrix(')
  })

  it('creates only an inert, hidden, non-identity support marker', () => {
    const { layer, container } = harness()
    const presentation = base('flow')
    presentation.supportClone = {
      key: { kind: 'flow-support-clone', interactionId: 'drag-flow', gestureGeneration: 1, cloneGeneration: 1 }, documentNodeId: null, generation: 1,
      sourceRelationship: relationship, sourceIndex: 0, entryMode: 'flow', entry: null, world: geometry(), hiddenUntilCommit: true,
      role: 'inert-marker', layoutParticipation: 'none', hitTesting: 'none', a11y: 'hidden',
    }
    layer.update([presentation])
    const marker = container.children.find(child => child.getAttribute('data-preview-flow-support-marker') === '')!
    expect(marker.inert).toBe(true)
    expect(marker.tabIndex).toBe(-1)
    expect(marker.getAttribute('aria-hidden')).toBe('true')
    expect(marker.getAttribute('data-preview-instance')).toBeNull()
    expect(marker.getAttribute('data-preview-canvas')).toBeNull()
    layer.update([{ ...presentation, supportClone: null }])
    expect(marker.removed).toBe(true)
    layer.update([presentation])
    expect(container.children.filter(child => child.getAttribute('data-preview-flow-support-marker') === '' && !child.removed)).toHaveLength(1)
  })
})
