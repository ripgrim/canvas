import { describe, expect, it } from 'vitest'
import { acceptPreviewEvent, acceptPreviewCommand } from '../src/protocol.js'
import { collectPreviewGeometry, createGeometryObserver } from '../src/geometry-observer.mjs'

const source = {} as Window
const bounds = { x: -12, y: 30, width: 140, height: 48 }
const payload = { channel: 'design-editor-preview', version: 3, generation: 7, type: 'geometry', items: [{ instanceId: 'button-1', componentId: 'atom-button', bounds }], root: null }
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
  it.each([
    { ...payload, extra: true },
    { ...payload, items: [payload.items[0], payload.items[0]] },
    { ...payload, items: [{ ...payload.items[0], componentId: '__proto__' }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, width: -1 } }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, x: Infinity } }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, y: 1_000_001 } }] },
    { ...payload, items: [{ ...payload.items[0], bounds: { ...bounds, z: 1 } }] },
    { ...payload, root: { componentId: 'login', bounds, extra: true } },
    { ...payload, items: Array.from({ length: 501 }, (_, i) => ({ ...payload.items[0], instanceId: `id-${i}` })) },
  ])('rejects malformed or unbounded geometry as negative controls', data => expect(accept(data)).toBeNull())
  it('accepts optional disabled source chrome without loosening other commands', () => {
    const command = { channel: 'design-editor-preview', version: 3, generation: 7, type: 'set-selection', nodeIds: [], color: '#009ff0', renderChrome: false }
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: command }, 'https://editor.test', source, 7)).toEqual(command)
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: { ...command, renderChrome: 'false' } }, 'https://editor.test', source, 7)).toBeNull()
  })
  it('omits ambiguous identity matches and foreign component annotations', () => {
    const element = (component: string, x: number) => ({ getAttribute: (key: string) => key === 'data-preview-instance' ? 'button-1' : component, getBoundingClientRect: () => ({ x, y: 30, width: 140, height: 48 }) })
    const document = { nodes: { 'button-1': { componentId: 'atom-button' } } }
    const one = { querySelectorAll: () => [element('atom-button', -12), element('foreign-button', 900)] }
    expect(collectPreviewGeometry(one, document, ['button-1'], 'login')).toEqual({ items: [{ instanceId: 'button-1', componentId: 'atom-button', bounds, parentInstanceId: null, directChild: false }], root: null })
    const duplicate = { querySelectorAll: () => [element('atom-button', -12), element('atom-button', 500)] }
    expect(collectPreviewGeometry(duplicate, document, ['button-1'], 'login')).toEqual({ items: [], root: null })
  })
})

describe('ED-CAN06 geometry service ownership', () => {
  it('coalesces invalidations, resends after ping refresh and cancels all work on stop', () => {
    const frames = new Map<number, () => void>()
    const listeners = new Map<string, () => void>()
    let sequence = 0
    let resizeCallback = () => {}
    let mutationCallback = () => {}
    let resizeDisconnected = false
    let mutationDisconnected = false
    const view = {
      requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string) => listeners.delete(event),
      ResizeObserver: class { constructor(callback: () => void) { resizeCallback = callback } observe() {} unobserve() {} disconnect() { resizeDisconnected = true } },
      MutationObserver: class { constructor(callback: () => void) { mutationCallback = callback } observe() {} disconnect() { mutationDisconnected = true } },
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
    expect(deliveries).toEqual([{ items: [], root: { componentId: 'login-form', bounds: { x: 0, y: 0, width: 480, height: 640 } } }])
    observer.refresh(); flush()
    expect(deliveries.length).toBe(2)
    observer.refresh(); observer.stop(); flush(); resizeCallback(); mutationCallback()
    expect(frames.size).toBe(0)
    expect(deliveries.length).toBe(2)
    expect(listeners.size).toBe(0)
    expect(resizeDisconnected).toBe(true)
    expect(mutationDisconnected).toBe(true)
  })
})
