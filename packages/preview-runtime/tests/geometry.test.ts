import { describe, expect, it } from 'vitest'
import { acceptPreviewEvent, acceptPreviewCommand } from '../src/protocol.js'
import { collectPreviewGeometry, createGeometryObserver } from '../src/geometry-observer.mjs'

const source = {} as Window
const bounds = { x: -12, y: 30, width: 140, height: 48 }
const payload = { channel: 'design-editor-preview', version: 8, generation: 7, type: 'geometry', items: [{ instanceId: 'button-1', source: 'component', componentId: 'atom-button', bounds, worldAabb: bounds }], root: null, documentRevision: 1, layoutGeneration: 0, measurementRevision: 1 }
const accept = (data: unknown, origin = 'https://preview.test', sender = source, generation = 7) => acceptPreviewEvent({ data, origin, source: sender }, 'https://preview.test', source, generation)
describe('ED-CAN06 validated preview geometry', () => {
  it('accepts signed viewport coordinates and explicit original-root geometry', () => {
    expect(accept(payload)).toEqual(payload)
    const original = { ...payload, items: [], root: { componentId: 'login-form', bounds } }
    expect(accept(original)).toEqual(original)
  })
  it('rejects wrong origin, sender and stale generation independently', () => {
    expect(accept(payload, 'https://hostile.test')).toBeNull()
    expect(accept(payload, 'https://preview.test', {} as Window)).toBeNull()
    expect(accept(payload, 'https://preview.test', source, 8)).toBeNull()
  })
  it('requires one exact nonnegative runtime-issued measurement token', () => {
    const { measurementRevision: _measurementRevision, ...missing } = payload
    expect(accept(missing)).toBeNull()
    expect(accept({ ...payload, measurementRevision: -1 })).toBeNull()
    expect(accept({ ...payload, measurementRevision: 1.5 })).toBeNull()
    expect(accept({ ...payload, measurementRevision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
    expect(accept({ ...payload, measurementRevision: 1, measurementToken: 1 })).toBeNull()
  })
  it.each([
    { ...payload, extra: true },
    { channel: payload.channel, version: payload.version, generation: payload.generation, type: payload.type, items: payload.items, root: payload.root, documentRevision: payload.documentRevision },
    { ...payload, layoutGeneration: -1 },
    { ...payload, layoutGeneration: '0' },
    { ...payload, items: [{ ...payload.items[0], offsetParentToRoot: [1, 0, 0, 1, 0] }] },
    { ...payload, items: [payload.items[0], payload.items[0]] },
    { ...payload, items: [{ instanceId: 'button-1', source: 'component', componentId: 'atom-button', bounds }] },
    { ...payload, items: [{ ...payload.items[0], source: 'canvas' }] },
    { ...payload, items: [{ instanceId: 'text-1', source: 'canvas', canvasKind: 'video', bounds, worldAabb: bounds }] },
    { ...payload, items: [{ ...payload.items[0], text: { resolvedLineHeight: 20 } }] },
    { ...payload, items: [{ instanceId: 'box-1', source: 'canvas', canvasKind: 'rectangle', bounds, worldAabb: bounds, text: { resolvedLineHeight: 20 } }] },
    { ...payload, items: [{ instanceId: 'text-1', source: 'canvas', canvasKind: 'text', bounds, worldAabb: bounds, text: { resolvedLineHeight: 20, extra: true } }] },
    { ...payload, items: [{ instanceId: 'text-1', source: 'canvas', canvasKind: 'text', bounds, worldAabb: bounds, text: { resolvedLineHeight: '20' } }] },
    { ...payload, items: [{ instanceId: 'text-1', source: 'canvas', canvasKind: 'text', bounds, worldAabb: bounds, text: { resolvedLineHeight: 0 } }] },
    { ...payload, items: [{ instanceId: 'text-1', source: 'canvas', canvasKind: 'text', bounds, worldAabb: bounds, text: { resolvedLineHeight: 1_000_001 } }] },
    { ...payload, items: [{ ...payload.items[0], componentId: '__proto__' }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, width: -1 } }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, x: Infinity } }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, y: 1_000_001 } }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, z: 1 } }] },
    { ...payload, root: { componentId: 'login', bounds, extra: true } },
    { ...payload, items: Array.from({ length: 501 }, (_, i) => ({ ...payload.items[0], instanceId: `id-${i}` })) },
  ])('rejects malformed or unbounded geometry as negative controls', data => expect(accept(data)).toBeNull())
  it('accepts optional disabled source chrome without loosening other commands', () => {
    const command = { channel: 'design-editor-preview', version: 8, generation: 7, type: 'set-selection', nodeIds: [], color: '#009ff0', renderChrome: false }
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: command }, 'https://editor.test', source, 7)).toEqual(command)
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: { ...command, renderChrome: 'false' } }, 'https://editor.test', source, 7)).toBeNull()
  })
  it('omits ambiguous identity matches and foreign component annotations', () => {
    const element = (component: string, x: number) => ({ getAttribute: (key: string) => key === 'data-preview-instance' ? 'button-1' : component, getBoundingClientRect: () => ({ x, y: 30, width: 140, height: 48 }) })
    const document = { revision: 1, nodes: { 'button-1': { componentId: 'atom-button' } } }
    const one = { querySelectorAll: () => [element('atom-button', -12), element('foreign-button', 900)] }
    expect(collectPreviewGeometry(one, document, ['button-1'], 'login')).toEqual({ items: [{ instanceId: 'button-1', source: 'component', componentId: 'atom-button', bounds, worldAabb: bounds, parentInstanceId: null, directChild: false }], root: null, documentRevision: 1, layoutGeneration: 0 })
    const duplicate = { querySelectorAll: () => [element('atom-button', -12), element('atom-button', 500)] }
    expect(collectPreviewGeometry(duplicate, document, ['button-1'], 'login')).toEqual({ items: [], root: null, documentRevision: 1, layoutGeneration: 0 })
  })

  it('measures a uniquely identified native canvas node without granting it component topology', () => {
    const canvas = {
      getAttribute: (key: string) => ({ 'data-preview-canvas': 'text-1', 'data-preview-kind': 'text' })[key] ?? null,
      getBoundingClientRect: () => ({ x: 80, y: 90, width: 210, height: 24 }),
    }
    const document = { revision: 2, nodes: {}, canvas: { elements: [{ id: 'text-1', kind: 'text' }] } }
    const container = { querySelectorAll: (selector: string) => selector === '[data-preview-canvas]' ? [canvas] : [] }
    expect(collectPreviewGeometry(container, document, ['text-1'], 'login')).toEqual({
      items: [{ instanceId: 'text-1', source: 'canvas', canvasKind: 'text', bounds: { x: 80, y: 90, width: 210, height: 24 }, worldAabb: { x: 80, y: 90, width: 210, height: 24 }, directChild: false }],
      root: null,
      documentRevision: 2,
      layoutGeneration: 0,
    })
  })

  it.each([
    ['pixel line height', '22.5px', '16px', 22.5],
    ['unitless line height resolved by computed style', '30px', '20px', 30],
    ['normal line height fallback', 'normal', '17.5px', 21],
  ])('measures %s from the rendered canvas text element', (_, lineHeight, fontSize, resolvedLineHeight) => {
    const style = {
      lineHeight, fontSize,
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      transformOrigin: '0px 0px', transform: 'none', boxSizing: 'border-box', width: '100px', height: '40px',
      left: '0px', top: '0px', position: 'absolute', display: 'block',
    }
    const container: Record<string, unknown> = { ownerDocument: { defaultView: { getComputedStyle: () => style } }, closest: () => null }
    const canvas = {
      parentElement: container, offsetParent: container, offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 40,
      getAttribute: (key: string) => ({ 'data-preview-canvas': 'text-1', 'data-preview-kind': 'text' })[key] ?? null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }),
    }
    container.querySelector = () => null
    container.querySelectorAll = (selector: string) => selector === '[data-preview-canvas]' ? [canvas] : []
    const document = { revision: 4, nodes: {}, canvas: { elements: [{ id: 'text-1', kind: 'text', parentId: null }] } }
    expect(collectPreviewGeometry(container, document, ['text-1'], 'login').items[0]).toMatchObject({ text: { resolvedLineHeight } })
  })

  it.each([
    ['missing line height', '', '16px'],
    ['non-pixel computed line height', '1.5em', '16px'],
    ['invalid normal fallback font size', 'normal', 'auto'],
    ['malformed normal fallback font size', 'normal', '16px-not-css'],
    ['zero line height', '0px', '16px'],
    ['over-limit line height', '1000001px', '16px'],
  ])('omits text metrics for %s', (_, lineHeight, fontSize) => {
    const style = {
      lineHeight, fontSize,
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      transformOrigin: '0px 0px', transform: 'none', boxSizing: 'border-box', width: '100px', height: '40px',
      left: '0px', top: '0px', position: 'absolute', display: 'block',
    }
    const container: Record<string, unknown> = { ownerDocument: { defaultView: { getComputedStyle: () => style } }, closest: () => null }
    const canvas = {
      parentElement: container, offsetParent: container, offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 40,
      getAttribute: (key: string) => ({ 'data-preview-canvas': 'text-1', 'data-preview-kind': 'text' })[key] ?? null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }),
    }
    container.querySelector = () => null
    container.querySelectorAll = (selector: string) => selector === '[data-preview-canvas]' ? [canvas] : []
    const document = { revision: 4, nodes: {}, canvas: { elements: [{ id: 'text-1', kind: 'text', parentId: null }] } }
    expect(collectPreviewGeometry(container, document, ['text-1'], 'login').items[0]).not.toHaveProperty('text')
  })

  it('never attaches text metrics to a non-text canvas node or a component root', () => {
    const style = {
      lineHeight: '24px', fontSize: '16px',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      transformOrigin: '0px 0px', transform: 'none', boxSizing: 'border-box', width: '100px', height: '40px',
      left: '0px', top: '0px', position: 'absolute', display: 'block',
    }
    const container: Record<string, unknown> = { ownerDocument: { defaultView: { getComputedStyle: () => style } }, closest: () => null }
    const element = (id: string, attribute: 'canvas' | 'component', kind: string) => ({
      parentElement: container, offsetParent: container, offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 40,
      closest: () => null,
      getAttribute: (key: string) => key === (attribute === 'canvas' ? 'data-preview-canvas' : 'data-preview-instance') ? id : key === (attribute === 'canvas' ? 'data-preview-kind' : 'data-preview-component') ? kind : null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }),
    })
    const rectangle = element('rect-1', 'canvas', 'rectangle')
    const component = element('component-1', 'component', 'atom-label')
    container.querySelector = () => null
    container.querySelectorAll = (selector: string) => selector === '[data-preview-canvas]' ? [rectangle] : selector === '[data-preview-instance]' ? [component] : []
    const document = { revision: 4, nodes: { 'component-1': { componentId: 'atom-label', children: {} } }, canvas: { elements: [{ id: 'rect-1', kind: 'rectangle', parentId: null }] } }
    const items = collectPreviewGeometry(container, document, ['rect-1', 'component-1'], 'login').items
    expect(items).toHaveLength(2)
    expect(items.every((item: Record<string, unknown>) => !Object.hasOwn(item, 'text'))).toBe(true)
  })

  it('accepts an exact resolved text metric through the protocol boundary', () => {
    const textPayload = { ...payload, items: [{ instanceId: 'text-1', source: 'canvas', canvasKind: 'text', bounds, worldAabb: bounds, text: { resolvedLineHeight: 24 } }] }
    expect(accept(textPayload)).toEqual(textPayload)
  })

  it('keeps a rotated primitive visual AABB separate from its untransformed interaction box and proves the root host', () => {
    const style = {
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      transformOrigin: '40px 20px', transform: 'matrix(0, 1, -1, 0, 0, 0)', boxSizing: 'border-box',
      width: '80px', height: '40px', left: '80px', top: '120px', position: 'absolute', display: 'block',
    }
    const container: Record<string, unknown> = { ownerDocument: { defaultView: { getComputedStyle: () => style } } }
    const canvas = {
      parentElement: container, offsetParent: container, offsetLeft: 80, offsetTop: 120, offsetWidth: 80, offsetHeight: 40,
      getAttribute: (key: string) => ({ 'data-preview-canvas': 'box-1', 'data-preview-kind': 'rectangle' })[key] ?? null,
      getBoundingClientRect: () => ({ x: 100, y: 100, width: 40, height: 80 }),
    }
    container.querySelector = () => null
    container.querySelectorAll = (selector: string) => selector === '[data-preview-canvas]' ? [canvas] : []
    const document = { revision: 3, nodes: {}, canvas: { elements: [{ id: 'box-1', kind: 'rectangle', parentId: null }] } }
    expect(collectPreviewGeometry(container, document, ['box-1'], 'login', { camera: { zoom: 1 } })).toMatchObject({
      items: [{
        instanceId: 'box-1', source: 'canvas', canvasKind: 'rectangle',
        bounds: { x: 80, y: 120, width: 80, height: 40 },
        worldAabb: { x: 100, y: 100, width: 40, height: 80 },
        offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true,
      }],
    })
  })
})

describe('ED-CAN06 geometry service ownership', () => {
  it('coalesces invalidations, resends after ping refresh and cancels all work on stop', () => {
    const frames = new Map<number, () => void>()
    const listeners = new Map<string, () => void>()
    let sequence = 0
    let resizeCallback = () => {}
    let mutationCallback: (records?: { target: unknown; type: string; attributeName: string | null }[]) => void = () => {}
    let resizeDisconnected = false
    let mutationDisconnected = false
    const view = {
      requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string) => listeners.delete(event),
      ResizeObserver: class { constructor(callback: () => void) { resizeCallback = callback } observe() {} unobserve() {} disconnect() { resizeDisconnected = true } },
      MutationObserver: class { constructor(callback: typeof mutationCallback) { mutationCallback = callback } observe() {} disconnect() { mutationDisconnected = true } },
    }
    const container = { ownerDocument: { defaultView: view }, querySelectorAll: () => [], getBoundingClientRect: () => ({ x: 0, y: 0, width: 480, height: 640 }) }
    const deliveries: unknown[] = []
    const observer = createGeometryObserver(container, (value: unknown) => deliveries.push(value))
    const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()) }
    observer.update(null, [], 'login-form')
    observer.start()
    resizeCallback(); mutationCallback(); listeners.get('scroll')!()
    expect(frames.size).toBe(1)
    flush()
    expect(deliveries).toEqual([{ items: [], root: { componentId: 'login-form', bounds: { x: 0, y: 0, width: 480, height: 640 } }, documentRevision: 0, layoutGeneration: 0 }])
    mutationCallback([{ target: container, type: 'attributes', attributeName: 'style' }])
    expect(frames.size).toBe(0)
    mutationCallback([{ target: {}, type: 'attributes', attributeName: 'style' }])
    expect(frames.size).toBe(1)
    flush()
    observer.refresh(); flush()
    expect(deliveries.length).toBe(3)
    observer.refresh(); observer.stop(); flush(); resizeCallback(); mutationCallback()
    expect(frames.size).toBe(0)
    expect(deliveries.length).toBe(3)
    expect(listeners.size).toBe(0)
    expect(resizeDisconnected).toBe(true)
    expect(mutationDisconnected).toBe(true)
  })
})
