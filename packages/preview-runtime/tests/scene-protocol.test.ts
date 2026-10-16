import { describe, expect, it } from 'vitest'
import { acceptPreviewCommand, acceptPreviewEvent, isPreviewDocument } from '../src/protocol.js'
import { canvasElementStyle, hostOrigin } from '../src/scene-styles.mjs'

const source = {} as Window
const envelope = { channel: 'design-editor-preview', version: 10, generation: 3 }
const solid = (color: string) => ({ fills: [{ type: 'solid', color }] })
const gradient = { fills: [{ type: 'gradient', shape: 'linear', angle: 135, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ color: 'oklch(0.62 0.19 259.8)', position: 0 }, { color: '#000000', position: 1 }] }] }
const legacyTextProperties = {
  textStyle: { fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
  textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
}
const document = { version: 3, revision: 0, rootIds: [], nodes: {}, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false }, canvas: { elements: [{ id: 'frame', kind: 'frame', name: 'Frame', relativeTransform: [1, 0, 0, 1, -213, -276], width: 438, height: 560, appearance: solid('#ffffff'), parentId: null }, { id: 'text', kind: 'text', name: 'Text', relativeTransform: [1, 0, 0, 1, 12, 13.5], width: 200, height: 21, appearance: solid('#64748b'), text: 'you@example.com', ...legacyTextProperties, parentId: 'frame' }, { id: 'glow', kind: 'shader', name: 'Glow', relativeTransform: [0.965925826289, 0.258819045103, -0.258819045103, 0.965925826289, 57.573593128807, 66.515307716505], width: 120, height: 120, appearance: gradient, parentId: 'frame' }] } }
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
    const camera = { ...envelope, type: 'set-camera', sequence: 1, camera: { x: 12.5, y: -30, zoom: 8, width: 1200, height: 800 } }
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

  it('COMP-V2-UI-009 admits only bounded declarative canvas interactions', () => {
    const interactions = [
      { trigger: 'pointer-hover', targetId: 'text', appearance: solid('#ff0000'), transition: { type: 'smart-animate', durationMs: 180, easing: 'ease-out' } },
      { trigger: 'pointer-press', targetId: 'text', appearance: solid('#0000ff') },
    ]
    expect(isPreviewDocument(withElement(0, { interactions }))).toBe(true)
    expect(isPreviewDocument(withElement(0, { interactions: [...interactions, interactions[0]] }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { interactions: [interactions[0], interactions[0]] }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { interactions: [{ trigger: 'click', targetId: 'text', appearance: solid('#ff0000') }] }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { interactions: [{ trigger: 'pointer-hover', targetId: 'text', appearance: solid('url(x)') }] }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { interactions: [{ trigger: 'pointer-hover', targetId: 'missing', appearance: solid('#ff0000') }] }))).toBe(false)
    expect(isPreviewDocument(withElement(1, { interactions: [{ trigger: 'pointer-hover', targetId: 'frame', appearance: solid('#ff0000') }] }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { interactions: [{ trigger: 'pointer-hover', appearance: solid('#ff0000') }] }))).toBe(false)
    expect(isPreviewDocument(withElement(0, { interactions: [{ ...interactions[0], transition: { type: 'smart-animate', durationMs: 60_001 } }] }))).toBe(false)
  })

  it('PAPER-FLEX-001/002 accepts projected primitive layout and fails closed on competing or hostile authorities', () => {
    const frameLayout = { mode: 'freeform', declarations: { display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap', 'justify-content': 'flex-start', 'align-items': 'center', 'column-gap': '8px', 'row-gap': '10px', 'padding-left': '12px' } }
    const flowText = { mode: 'flow', declarations: { 'margin-left': '4px' } }
    const absolute = { mode: 'absolute', declarations: { position: 'absolute', left: '25%', top: '7px' } }
    expect(isPreviewDocument(withElement(0, { layout: frameLayout }))).toBe(true)
    expect(isPreviewDocument(withElement(1, { layout: flowText }))).toBe(true)
    expect(isPreviewDocument(withElement(2, { layout: absolute }))).toBe(true)

    for (const layout of [
      { ...frameLayout, extra: true },
      { mode: 'flow', declarations: { position: 'absolute' } },
      { mode: 'absolute', declarations: { left: '7px' } },
      { mode: 'absolute', declarations: { position: 'absolute', transform: 'matrix(0.965925826289, 0.258819045103, -0.258819045103, 0.965925826289, 0, 0)' } },
      { mode: 'freeform', declarations: { overflow: 'hidden' } },
      { mode: 'flow', declarations: { width: 'calc(100% - 2px)' } },
    ]) expect(isPreviewDocument(withElement(0, { layout }))).toBe(false)
    expect(isPreviewDocument(withElement(2, { layout: { mode: 'flow', declarations: { display: 'flex' } } }))).toBe(false)
    expect(isPreviewDocument(withElement(1, { layout: { mode: 'flow', declarations: { width: '120px' } } }))).toBe(false)
    expect(isPreviewDocument({ ...document, version: 1 })).toBe(false)
  })

  it('PAPER-FLEX-003 admits only contextual freeform primitive sizing authorities', () => {
    const semanticFields = {
      width: '42%', height: '50%', 'min-width': '12px', 'min-height': '13px', 'max-width': '80%', 'max-height': '90%',
    }
    for (const [name, value] of Object.entries(semanticFields)) {
      expect(isPreviewDocument(withElement(2, { layout: { mode: 'freeform', declarations: { [name]: value } } }))).toBe(true)
    }

    for (const value of ['fit-content', 'min-content', 'max-content', 'auto']) {
      expect(isPreviewDocument(withElement(0, { layout: { mode: 'freeform', declarations: { display: 'flex', width: value, height: value } } }))).toBe(true)
      for (const kind of ['rectangle', 'shape', 'shader']) {
        for (const name of Object.keys(semanticFields)) {
          expect(isPreviewDocument(withElement(2, { kind, layout: { mode: 'freeform', declarations: { [name]: value } } }))).toBe(false)
        }
      }
    }

    for (const name of Object.keys(semanticFields)) {
      for (const mode of ['freeform', 'flow', 'absolute'] as const) {
        const declarations = mode === 'absolute' ? { position: 'absolute', left: '0px', [name]: '42%' } : { [name]: '42%' }
        expect(isPreviewDocument(withElement(0, { layout: { mode, declarations } }))).toBe(false)
      }
    }
    expect(isPreviewDocument(withElement(2, { layout: { mode: 'freeform', declarations: { width: '120px' } } }))).toBe(false)
    expect(isPreviewDocument(withElement(2, { layout: { mode: 'freeform', declarations: { height: '80px' } } }))).toBe(false)

    for (const kind of ['rectangle', 'shape', 'shader'] as const) {
      for (const name of ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] as const) {
        expect(isPreviewDocument(withElement(2, { kind, layout: { mode: 'freeform', declarations: { [name]: '4px' } } }))).toBe(false)
      }
      for (const name of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] as const) {
        expect(isPreviewDocument(withElement(2, { kind, layout: { mode: 'freeform', declarations: { [name]: '4px' } } }))).toBe(false)
      }
    }
    for (const name of ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] as const) {
      expect(isPreviewDocument(withElement(0, { layout: { mode: 'freeform', declarations: { [name]: '4px' } } }))).toBe(false)
    }
    for (const name of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] as const) {
      expect(isPreviewDocument(withElement(2, { kind: 'frame', layout: { mode: 'freeform', declarations: { [name]: '4px' } } }))).toBe(true)
    }

    for (const declarations of [
      { left: '1px' }, { right: '1px' }, { top: '1px' }, { bottom: '1px' }, { 'z-index': '1' },
      { 'flex-grow': '1' }, { 'flex-shrink': '0' }, { 'flex-basis': 'auto' }, { 'grid-column-start': '1' },
      { transform: 'matrix(1, 0, 0, 1, 0, 0)' }, { overflow: 'hidden' }, { 'aspect-ratio': '1' },
    ]) expect(isPreviewDocument(withElement(2, { layout: { mode: 'freeform', declarations } }))).toBe(false)

    for (const name of Object.keys(semanticFields)) {
      expect(isPreviewDocument(withElement(1, { layout: { mode: 'freeform', declarations: { [name]: semanticFields[name as keyof typeof semanticFields] } } }))).toBe(false)
    }
  })

  it('accepts selection of primitive ids, geometry with its measuring camera, and forwarded wheel input', () => {
    const selection = { ...envelope, type: 'set-selection', nodeIds: ['frame'], color: '#e864ff', renderChrome: false }
    expect(acceptPreviewCommand({ origin: 'https://editor.test', source, data: selection }, 'https://editor.test', source, 3, document as never)).toEqual(selection)
    const geometry = { ...envelope, type: 'geometry', items: [], root: null, documentRevision: document.revision, layoutGeneration: 0, measurementRevision: 1, camera: { x: 0, y: 0, zoom: 2, width: 800, height: 600 } }
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: geometry }, 'https://preview.test', source, 3)).toEqual(geometry)
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: { ...geometry, camera: { zoom: 2 } } }, 'https://preview.test', source, 3)).toBeNull()
    const wheel = { ...envelope, type: 'wheel', wheel: { deltaX: 0, deltaY: -53, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 410, clientY: 220 } }
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: wheel }, 'https://preview.test', source, 3)).toEqual(wheel)
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: { ...wheel, wheel: { ...wheel.wheel, deltaMode: 3 } } }, 'https://preview.test', source, 3)).toBeNull()
    const cameraApplied = { ...envelope, type: 'camera-applied', sequence: 7, camera: geometry.camera }
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: cameraApplied }, 'https://preview.test', source, 3)).toEqual(cameraApplied)
    expect(acceptPreviewEvent({ origin: 'https://preview.test', source, data: { ...cameraApplied, sequence: -1 } }, 'https://preview.test', source, 3)).toBeNull()
  })

  it('derives primitive styles from appearance and keeps the legacy host at the old frame origin', () => {
    expect(hostOrigin({ width: 400, height: 520, padding: 24 })).toEqual({ x: -176, y: -236, width: 352 })
    expect(canvasElementStyle(document.canvas.elements[0])).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '438px', height: '560px', transformOrigin: '0 0', transform: 'matrix(1, 0, 0, 1, -213, -276)', backgroundColor: '#ffffff', overflow: 'hidden', pointerEvents: 'none', boxSizing: 'border-box' })
    expect(canvasElementStyle(document.canvas.elements[0]).backgroundImage).toBeUndefined()
    expect(canvasElementStyle({ ...document.canvas.elements[0], clip: false }).overflow).toBe('visible')
    expect(canvasElementStyle({ ...document.canvas.elements[0], clip: true }).overflow).toBe('hidden')
    expect(canvasElementStyle(document.canvas.elements[1], undefined, { x: 2, y: 3.5 })).toMatchObject({ left: '0px', top: '0px', transform: 'matrix(1, 0, 0, 1, 10, 10)', color: '#64748b', fontSize: '16px', whiteSpace: 'pre-wrap' })
    expect(canvasElementStyle(document.canvas.elements[1]).backgroundImage).toBeUndefined()
    expect(canvasElementStyle(document.canvas.elements[2])).toMatchObject({ backgroundColor: 'transparent', backgroundImage: 'linear-gradient(135deg, oklch(0.62 0.19 259.8) 0%, #000000 100%)', transform: 'matrix(0.965925826289, 0.258819045103, -0.258819045103, 0.965925826289, 57.573593128807, 66.515307716505)' })
    expect(canvasElementStyle({ ...document.canvas.elements[2], relativeTransform: [-1, 0, 0, 1, 160, 80] })).toMatchObject({ transform: 'matrix(-1, 0, 0, 1, 160, 80)' })
    expect(canvasElementStyle({ ...document.canvas.elements[2], relativeTransform: [1, 0, 0, -1, 40, 200] })).toMatchObject({ transform: 'matrix(1, 0, 0, -1, 40, 200)' })
    expect(canvasElementStyle({ ...document.canvas.elements[2], kind: 'shape' })).toMatchObject({ backgroundImage: 'linear-gradient(135deg, oklch(0.62 0.19 259.8) 0%, #000000 100%)', borderRadius: '50%' })
    expect(canvasElementStyle({ ...document.canvas.elements[2], kind: 'rectangle', appearance: undefined, relativeTransform: [1, 0, 0, 1, 40, 80] })).toMatchObject({ backgroundColor: 'transparent', transform: 'matrix(1, 0, 0, 1, 40, 80)' })
    expect(canvasElementStyle({ ...document.canvas.elements[2], kind: 'rectangle', appearance: undefined }).backgroundImage).toBeUndefined()
  })

  it('PAPER-FLEX-001 keeps legacy freeform absolute and projects flow, flex, and absolute DOM styles independently', () => {
    const frame = document.canvas.elements[0]!
    const legacy = canvasElementStyle(frame)
    expect(legacy).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '438px', height: '560px', transform: 'matrix(1, 0, 0, 1, -213, -276)' })

    const flex = canvasElementStyle({ ...frame, layout: { mode: 'freeform', declarations: { display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap', 'column-gap': '8px', 'row-gap': '10px', 'padding-left': '12px' } } })
    expect(flex).toMatchObject({ position: 'absolute', left: '0px', top: '0px', transform: 'matrix(1, 0, 0, 1, -213, -276)', display: 'flex', flexDirection: 'row', flexWrap: 'wrap', columnGap: '8px', rowGap: '10px', paddingLeft: '12px' })

    const flow = canvasElementStyle({ ...frame, layout: { mode: 'flow', declarations: { width: '120px', 'flex-grow': '1' } } })
    expect(flow).toMatchObject({ position: 'relative', left: undefined, top: undefined, width: '120px', flexGrow: '1' })

    const absolute = canvasElementStyle({ ...document.canvas.elements[2]!, layout: { mode: 'absolute', declarations: { position: 'absolute', left: '25%', top: '7px' } } })
    expect(absolute).toMatchObject({ position: 'absolute', left: '25%', top: '7px', transform: 'matrix(0.965925826289, 0.258819045103, -0.258819045103, 0.965925826289, 57.573593128807, 66.515307716505)' })
  })

  it('PAPER-FLEX-002 keeps far-edge absolute anchors independent from authored x and y fallbacks', () => {
    const element = document.canvas.elements[2]!
    const right = canvasElementStyle({ ...element, layout: { mode: 'absolute', declarations: { position: 'absolute', right: '11px', top: '7px' } } })
    expect(right).toMatchObject({ position: 'absolute', left: undefined, right: '11px', top: '7px' })
    const bottom = canvasElementStyle({ ...element, layout: { mode: 'absolute', declarations: { position: 'absolute', left: '13px', bottom: '17px' } } })
    expect(bottom).toMatchObject({ position: 'absolute', left: '13px', top: undefined, bottom: '17px' })
    const mixed = canvasElementStyle({ ...element, layout: { mode: 'absolute', declarations: { position: 'absolute', right: '9%', bottom: '21px' } } })
    expect(mixed).toMatchObject({ position: 'absolute', left: undefined, right: '9%', top: undefined, bottom: '21px' })
  })
})
