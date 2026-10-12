import { describe, expect, it } from 'vitest'
import { createTransientMoveLayer } from '../src/transient-move-layer.mjs'

class FakeStyle {
  readonly values = new Map<string, { value: string; priority: string }>()
  readonly writes: string[] = []
  getPropertyValue(property: string) { return this.values.get(property)?.value ?? '' }
  getPropertyPriority(property: string) { return this.values.get(property)?.priority ?? '' }
  setProperty(property: string, value: string, priority = '') { this.writes.push(property); this.values.set(property, { value, priority }) }
  removeProperty(property: string) { this.values.delete(property) }
}

class FakeElement { readonly style = new FakeStyle() }

describe('AT-CAN-006 transient move presentation', () => {
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
