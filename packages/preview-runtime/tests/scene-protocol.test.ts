import { describe, expect, it } from 'vitest'
import { acceptPreviewCommand, acceptPreviewEvent, isPreviewDocument } from '../src/protocol.js'
import { canvasElementStyle, hostOrigin } from '../src/scene-styles.mjs'

const source = {} as Window
const envelope = { channel: 'design-editor-preview', version: 3, generation: 3 }
const solid = (color: string) => ({ fills: [{ type: 'solid', color }] })
const gradient = { fills: [{ type: 'gradient', shape: 'linear', angle: 135, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ color: 'oklch(0.62 0.19 259.8)', position: 0 }, { color: '#000000', position: 1 }] }] }
const document = { version: 1, revision: 0, rootIds: [], nodes: {}, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false }, canvas: { elements: [{ id: 'frame', kind: 'frame', name: 'Frame', x: -213, y: -276, width: 438, height: 560, rotation: 0, appearance: solid('#ffffff'), parentId: null }, { id: 'text', kind: 'text', name: 'Text', x: 12, y: 13.5, width: 200, height: 21, rotation: 0, appearance: solid('#64748b'), text: 'you@example.com', parentId: 'frame' }, { id: 'glow', kind: 'shader', name: 'Glow', x: 40, y: 80, width: 120, height: 120, rotation: 15, appearance: gradient, parentId: 'frame' }] } }
const withElement = (index: number, patch: Record<string, unknown>) => ({ ...document, canvas: { elements: document.canvas.elements.map((element, position) => position === index ? { ...element, ...patch } : element) } })

describe('scene protocol', () => {
  it('accepts primitive nodes with appearance and camera, and rejects cycles, foreign parents, and bad fills', () => {
    expect(isPreviewDocument(document)).toBe(true)
    expect(isPreviewDocument(withElement(0, { appearance: undefined }))).toBe(false)
    expect(isPreviewDocument({ ...document, canvas: { elements: document.canvas.elements.map(({ appearance: _removed, ...element }) => element) } })).toBe(true)
    expect(isPreviewDocument(withElement(0, { appearance: solid('oklch(0.98 0.01 95 / 0.8)') }))).toBe(true)
    expect(isPreviewDocument({ ...document, canvas: { elements: [{ ...document.canvas.elements[1], parentId: 'text' }] } })).toBe(false)
    expect(isPreviewDocument(withElement(1, { parentId: 'missing' }))).toBe(false)
    expect(isPreviewDocument(withElement(2, { parentId: 'text' }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { appearance: solid('url(x)') }))).toBe(false)
    expect(isPreviewDocument(withElement(2, { appearance: { fills: [{ ...gradient.fills[0], stops: [{ color: 'url(x)', position: 0 }, { color: '#000000', position: 1 }] }] } }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { appearance: solid('surface') }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { fill: '#ffffff' }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { clip: 'yes' }))).toBe(false)
    expect(isPreviewDocument({ ...document, tokens: { accent: '#7c3aed' } })).toBe(false)
    const camera = { ...envelope, type: 'set-camera', camera: { x: 12.5, y: -30, zoom: 8, width: 1200, height: 800 } }
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: camera }, 'https://editor.test', source, 3)).toEqual(camera)
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: { ...camera, camera: { ...camera.camera, zoom: 0 } } }, 'https://editor.test', source, 3)).toBeNull()
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: { ...camera, camera: { ...camera.camera, extra: 1 } } }, 'https://editor.test', source, 3)).toBeNull()
  })

  it('requires parentId on every element as a string or null', () => {
    const { parentId: _removed, ...orphan } = document.canvas.elements[0]!
    expect(isPreviewDocument({ ...document, canvas: { elements: [orphan] } })).toBe(false)
    expect(isPreviewDocument(withElement(0, { parentId: undefined }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { parentId: 0 }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { parentId: '' }))).toBe(false)
  })

  it('accepts selection of primitive ids, geometry with its measuring camera, and forwarded wheel input', () => {
    const selection = { ...envelope, type: 'set-selection', nodeIds: ['frame'], color: '#e864ff', renderChrome: false }
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: selection }, 'https://editor.test', source, 3, document as never)).toEqual(selection)
    const geometry = { ...envelope, type: 'geometry', items: [], root: null, camera: { x: 0, y: 0, zoom: 2, width: 800, height: 600 } }
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: geometry }, 'https://preview.test', source, 3)).toEqual(geometry)
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: { ...geometry, camera: { zoom: 2 } } }, 'https://preview.test', source, 3)).toBeNull()
    const wheel = { ...envelope, type: 'wheel', wheel: { deltaX: 0, deltaY: -53, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 410, clientY: 220 } }
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: wheel }, 'https://preview.test', source, 3)).toEqual(wheel)
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: { ...wheel, wheel: { ...wheel.wheel, deltaMode: 3 } } }, 'https://preview.test', source, 3)).toBeNull()
  })

  it('derives primitive styles from appearance and keeps the legacy host at the old frame origin', () => {
    expect(hostOrigin({ width: 400, height: 520, padding: 24 })).toEqual({ x: -176, y: -236, width: 352 })
    expect(canvasElementStyle(document.canvas.elements[0])).toMatchObject({ position: 'absolute', left: '-213px', top: '-276px', width: '438px', height: '560px', backgroundColor: '#ffffff', overflow: 'hidden', pointerEvents: 'none', boxSizing: 'border-box' })
    expect(canvasElementStyle(document.canvas.elements[0]).backgroundImage).toBeUndefined()
    expect(canvasElementStyle({ ...document.canvas.elements[0], clip: false }).overflow).toBe('visible')
    expect(canvasElementStyle({ ...document.canvas.elements[0], clip: true }).overflow).toBe('hidden')
    expect(canvasElementStyle(document.canvas.elements[1], undefined, { x: 2, y: 3.5 })).toMatchObject({ left: '10px', top: '10px', color: '#64748b', fontSize: '16px', whiteSpace: 'pre-wrap' })
    expect(canvasElementStyle(document.canvas.elements[1]).backgroundImage).toBeUndefined()
    expect(canvasElementStyle(document.canvas.elements[2])).toMatchObject({ backgroundColor: 'transparent', backgroundImage: 'linear-gradient(135deg, oklch(0.62 0.19 259.8) 0%, #000000 100%)', transform: 'rotate(15deg)' })
    expect(canvasElementStyle({ ...document.canvas.elements[2], kind: 'shape' })).toMatchObject({ backgroundImage: 'linear-gradient(135deg, oklch(0.62 0.19 259.8) 0%, #000000 100%)', borderRadius: '50%' })
    expect(canvasElementStyle({ ...document.canvas.elements[2], kind: 'rectangle', appearance: undefined, rotation: 0 })).toMatchObject({ backgroundColor: 'transparent', transform: undefined })
    expect(canvasElementStyle({ ...document.canvas.elements[2], kind: 'rectangle', appearance: undefined }).backgroundImage).toBeUndefined()
  })
})
