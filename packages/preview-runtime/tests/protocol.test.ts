import { describe, expect, it } from 'vitest'
import { acceptPreviewCommand, acceptPreviewEvent, isPreviewColor, isPreviewDocument, sameSourceStructure, type PreviewDocument } from '../src/protocol.js'
import { BuildGenerations } from '../src/generation.js'
// Protocol v4: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

const parent = {} as Window
const command = { channel: 'design-editor-preview', version: 9, generation: 4, type: 'set-props', props: { variant: 'quiet' } }
const onePixelAvif = 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAD6AAEAAAAAAAAAHwAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgUBsAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwwMDAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAnbWRhdBIACghYAAY0BDQbhDIRGAAOOOOEAACwE1TtMKTrDPw='
const fixtureDocument = (): PreviewDocument => ({
  version: 2, revision: 2, rootIds: ['card-1'],
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: { heading: 'Sign in' }, children: { children: ['label-1', 'input-1', 'button-1'] } },
    'label-1': { id: 'label-1', componentId: 'atom-label', exportName: 'Label', theme: lightTheme, props: { children: 'Email', htmlFor: 'email' }, children: {} },
    'input-1': { id: 'input-1', componentId: 'atom-input', exportName: 'Input', theme: lightTheme, props: { id: 'email', type: 'email', disabled: false }, children: {} },
    'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: { children: 'Continue', variant: 'quiet', type: 'button' }, children: {} },
  },
  frame: { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: true },
})
const fixtureRegistry = [
  { componentId: 'atom-card', exportName: 'Card', props: {}, slots: ['children', 'heading', 'footer'] },
  { componentId: 'atom-label', exportName: 'Label', props: { children: { kind: 'string' }, htmlFor: { kind: 'string' } }, slots: [] },
  { componentId: 'atom-input', exportName: 'Input', props: { id: { kind: 'string' }, type: { kind: 'string' }, disabled: { kind: 'boolean' } }, slots: [] },
  { componentId: 'atom-button', exportName: 'Button', props: { children: { kind: 'string' }, variant: { kind: 'enum', values: ['primary', 'quiet'] }, type: { kind: 'enum', values: ['button', 'submit', 'reset'] } }, slots: [] },
] as const

describe('AT-SEC-003 narrow preview protocol', () => {
  it('accepts one correctly addressed props command', () => {
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data: command }, 'http://127.0.0.1:4319', parent, 4)).toEqual(command)
  })
  it.each([
    ['wrong origin', 'https://attacker.example', parent, command],
    ['opaque origin', 'null', parent, command],
    ['wrong sender', 'http://127.0.0.1:4319', {}, command],
    ['stale generation', 'http://127.0.0.1:4319', parent, { ...command, generation: 3 }],
    ['filesystem capability', 'http://127.0.0.1:4319', parent, { ...command, type: 'read-file', path: '../secrets' }],
    ['extra field', 'http://127.0.0.1:4319', parent, { ...command, token: 'secret' }],
    ['oversized input', 'http://127.0.0.1:4319', parent, { ...command, props: { text: 'x'.repeat(70_000) } }],
  ])('rejects %s as a negative control', (_, origin, source, data) => {
    expect(acceptPreviewCommand({ origin: origin as string, source: source as Window, data }, 'http://127.0.0.1:4319', parent, 4)).toBeNull()
  })
  it('rejects cyclic and prototype-bearing props', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const props of [cyclic, JSON.parse('{"__proto__":{"polluted":true}}')]) {
      expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data: { ...command, props } }, 'http://127.0.0.1:4319', parent, 4)).toBeNull()
    }
  })
  it('accepts bounded font faces and rejects CSS-capable payloads', () => {
    const font = { key: 'google-abel-normal-400-0', family: 'Abel', style: 'normal', weight: 400, data: 'data:font/ttf;base64,QQ==' }
    const data = { channel: command.channel, version: command.version, generation: command.generation, type: 'set-fonts', fonts: [font] }
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data }, 'http://127.0.0.1:4319', parent, 4)).toEqual(data)
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data: { ...data, fonts: [{ ...font, data: 'url(https://attacker.example/font.woff2)' }] } }, 'http://127.0.0.1:4319', parent, 4)).toBeNull()
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data: { ...data, fonts: [{ ...font, unicodeRange: 'U+0-5; color:red' }] } }, 'http://127.0.0.1:4319', parent, 4)).toBeNull()
  })
  it('validates preview event origin, source, generation and exact fields', () => {
    const data = { channel: 'design-editor-preview', version: 9, generation: 4, type: 'selected', componentId: 'fixture-login', bounds: { x: 1, y: 2, width: 340, height: 440 } }
    expect(acceptPreviewEvent({ origin: 'http://127.0.0.1:4400', source: parent, data }, 'http://127.0.0.1:4400', parent, 4)).toEqual(data)
    expect(acceptPreviewEvent({ origin: 'http://127.0.0.1:4401', source: parent, data }, 'http://127.0.0.1:4400', parent, 4)).toBeNull()
    expect(acceptPreviewEvent({ origin: 'http://127.0.0.1:4400', source: parent, data: { ...data, bounds: { ...data.bounds, width: -1 } } }, 'http://127.0.0.1:4400', parent, 4)).toBeNull()
    const applied = { channel: 'design-editor-preview', version: 9, generation: 4, type: 'document-applied', renderSequence: 7, documentRevision: 2 }
    expect(acceptPreviewEvent({ origin: 'http://127.0.0.1:4400', source: parent, data: applied }, 'http://127.0.0.1:4400', parent, 4)).toEqual(applied)
    expect(acceptPreviewEvent({ origin: 'http://127.0.0.1:4400', source: parent, data: { ...applied, renderSequence: -1 } }, 'http://127.0.0.1:4400', parent, 4)).toBeNull()
    expect(acceptPreviewEvent({ origin: 'http://127.0.0.1:4400', source: parent, data: { ...applied, extra: true } }, 'http://127.0.0.1:4400', parent, 4)).toBeNull()
  })
})

describe('AT-PRV-005 document atom protocol', () => {
  const deliver = (data: unknown, document: PreviewDocument | null = null) => acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data }, 'http://127.0.0.1:4319', parent, 4, document, fixtureRegistry)
  const envelope = { channel: 'design-editor-preview', version: 9, generation: 4 }
  it('accepts typed atom documents and both concrete themes', () => {
    const doc = fixtureDocument()
    doc.background = '#123456'
    const data = { ...envelope, type: 'set-document', document: doc, flowDragTerminalPolicy: 'preserve-matching-committed-handoff', theme: { attribute: 'dark', colorScheme: 'dark' } }
    expect(deliver(data)).toEqual(data)
    expect(deliver({ ...data, renderSequence: 7 })).toEqual({ ...data, renderSequence: 7 })
    expect(deliver({ ...data, renderSequence: -1 })).toBeNull()
    expect(deliver({ ...data, renderSequence: 1.5 })).toBeNull()
    expect(deliver({ ...envelope, type: 'set-theme', theme: { attribute: null, colorScheme: 'light' } })).toEqual({ ...envelope, type: 'set-theme', theme: { attribute: null, colorScheme: 'light' } })
    expect(deliver({ ...envelope, type: 'set-theme', theme: 'system' })).toBeNull()
    expect(deliver({ ...envelope, type: 'set-theme', theme: { attribute: 'dark', colorScheme: 'system' } })).toBeNull()
    expect(deliver({ ...envelope, type: 'set-theme', theme: { attribute: 'bad theme', colorScheme: 'dark' } })).toBeNull()
    expect(deliver({ ...data, generation: 3 })).toBeNull()
    expect(deliver({ ...data, extra: true })).toBeNull()
    for (const mode of ['select', 'pan', 'interact']) expect(deliver({ ...envelope, type: 'set-interaction-mode', mode })).toEqual({ ...envelope, type: 'set-interaction-mode', mode })
    expect(deliver({ ...envelope, type: 'set-interaction-mode', mode: 'execute' })).toBeNull()
    expect(deliver({ ...envelope, type: 'set-interaction-mode', mode: 'interact', path: '../file' })).toBeNull()
  })
  it('accepts scalar document content only for declared slots', () => {
    const doc = fixtureDocument()
    doc.nodes['card-1']!.props.footer = 'Document footer'
    expect(deliver({ ...envelope, type: 'set-document', document: doc, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' })).not.toBeNull()

    doc.nodes['card-1']!.props.content = 'Undeclared content'
    expect(deliver({ ...envelope, type: 'set-document', document: doc, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' })).toBeNull()
  })
  it('accepts only bounded render-safe page background colors', () => {
    const doc = fixtureDocument()
    doc.background = 'oklch(0.5 0.2 120 / 0.75)'
    expect(isPreviewDocument(doc)).toBe(true)
    for (const background of ['red', 'var(--surface)', 'url(https://attacker.example/x)', '#fff', '#000000; color:red']) {
      const invalid = fixtureDocument() as PreviewDocument & { background?: string }
      invalid.background = background
      expect(isPreviewDocument(invalid)).toBe(false)
    }
  })
  it('accepts bounded layout commands and permits reorder without permitting reparenting', () => {
    const layout = { ...envelope, type: 'set-layout', layoutGeneration: 0, flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items: [{ nodeId: 'button-1', mode: 'absolute', x: 12, y: 24, order: 2, width: 120, height: 40 }] }
    expect(deliver(layout, fixtureDocument())).toEqual(layout)
    expect(deliver({ ...layout, items: [{ ...layout.items[0], width: 0 }] })).toBeNull()
    expect(deliver({ ...layout, items: [{ ...layout.items[0], nodeId: '__proto__' }] })).toBeNull()
    expect(deliver({ ...layout, items: [{ ...layout.items[0], nodeId: 'unknown' }] }, fixtureDocument())).toBeNull()
    const baseline = fixtureDocument()
    const reordered = fixtureDocument()
    reordered.nodes['card-1']!.children.children = ['button-1', 'label-1', 'input-1']
    expect(sameSourceStructure(baseline, reordered)).toBe(true)
    const reparented = fixtureDocument()
    reparented.nodes['card-1']!.children.children = ['label-1', 'input-1']
    reparented.rootIds.push('button-1')
    expect(sameSourceStructure(baseline, reparented)).toBe(false)
  })
  it.each([
    ['cycle', (doc: PreviewDocument) => { doc.nodes['card-1']!.children.children = ['card-1'] }],
    ['multiple parents', (doc: PreviewDocument) => { doc.rootIds.push('input-1') }],
    ['missing child', (doc: PreviewDocument) => { doc.nodes['card-1']!.children.children!.push('missing') }],
    ['unreachable instance', (doc: PreviewDocument) => { doc.rootIds = [] }],
    ['invalid Input slot', (doc: PreviewDocument) => { doc.nodes['input-1']!.children.children = ['label-1'] }],
    ['invalid Card slot', (doc: PreviewDocument) => { doc.nodes['card-1']!.children.content = [] }],
    ['colliding text slot', (doc: PreviewDocument) => { doc.nodes['card-1']!.props.children = 'Replace components' }],
    ['undeclared scalar slot prop', (doc: PreviewDocument) => { doc.nodes['card-1']!.props.content = 'Not declared' }],
    ['invalid Button variant', (doc: PreviewDocument) => { doc.nodes['button-1']!.props.variant = 'invented' }],
    ['invalid prop type', (doc: PreviewDocument) => { doc.nodes['input-1']!.props.disabled = 'false' }],
    ['unknown prop', (doc: PreviewDocument) => { doc.nodes['input-1']!.props.madeUp = 'invalid' }],
    ['handler', (doc: PreviewDocument) => { doc.nodes['button-1']!.props.onClick = 'alert(1)' }],
    ['HTML injection', (doc: PreviewDocument) => { doc.nodes['card-1']!.props.dangerouslySetInnerHTML = '<script>' }],
    ['unbounded frame', (doc: PreviewDocument) => { doc.frame.width = Infinity }],
    ['oversized text', (doc: PreviewDocument) => { doc.nodes['label-1']!.props.children = 'x'.repeat(10_001) }],
  ])('rejects %s without accepting a replacement document', (_, mutate) => {
    const doc = fixtureDocument()
    mutate(doc)
    expect(deliver({ ...envelope, type: 'set-document', document: doc, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' })).toBeNull()
  })
  it('requires an exact bound component identity, not a same-named export', () => {
    const doc = fixtureDocument()
    const registry = Object.values(doc.nodes).map(node => ({ componentId: node.componentId, exportName: node.exportName }))
    expect(isPreviewDocument(doc, registry)).toBe(true)
    doc.nodes['label-1']!.componentId = 'same-name-other-source'
    expect(isPreviewDocument(doc, registry)).toBe(false)
  })
  it('accepts an atom selection with its instance identity and rejects extra authority', () => {
    const data = { ...envelope, type: 'selected', componentId: 'atom-input', instanceId: 'input-1', bounds: { x: 24, y: 60, width: 380, height: 40 } }
    const accept = (data: unknown) => acceptPreviewEvent({ origin: 'http://127.0.0.1:4400', source: parent, data }, 'http://127.0.0.1:4400', parent, 4)
    expect(accept(data)).toEqual(data)
    expect(accept({ ...data, instanceId: '__proto__' })).toBeNull()
    expect(accept({ ...data, path: '../outside' })).toBeNull()
  })
})

describe('AT-PRV-006 selection annotation protocol', () => {
  const selection = { channel: 'design-editor-preview', version: 9, generation: 4, type: 'set-selection', nodeIds: ['input-1', 'button-1'], color: '#009ff0' }
  const deliver = (data: unknown, document: PreviewDocument | null = fixtureDocument(), origin = 'http://127.0.0.1:4319', source = parent) => acceptPreviewCommand({ origin, source, data }, 'http://127.0.0.1:4319', parent, 4, document)
  it('accepts current document instances and an empty clear in original component mode', () => {
    expect(deliver(selection)).toEqual(selection)
    expect(deliver({ ...selection, nodeIds: [] }, null)).toEqual({ ...selection, nodeIds: [] })
    expect(deliver(selection, null)).toBeNull()
  })
  it.each([
    ['unknown instance', { ...selection, nodeIds: ['unknown'] }],
    ['stale generation', { ...selection, generation: 3 }],
    ['duplicate instance', { ...selection, nodeIds: ['input-1', 'input-1'] }],
    ['prototype ID', { ...selection, nodeIds: ['__proto__'] }],
    ['trailing whitespace ID', { ...selection, nodeIds: ['input-1\n'] }],
    ['non-string ID', { ...selection, nodeIds: [Infinity] }],
    ['unbounded list', { ...selection, nodeIds: Array.from({ length: 501 }, (_, index) => `instance-${index}`) }],
    ['missing color', { channel: selection.channel, version: 3, generation: 4, type: 'set-selection', nodeIds: [] }],
    ['CSS injection', { ...selection, color: '#009ff0;display:none' }],
    ['unknown palette', { ...selection, color: 'blue' }],
    ['trailing color whitespace', { ...selection, color: '#009ff0\n' }],
    ['extra authority', { ...selection, sourcePath: '../outside' }],
  ])('rejects %s without replacing selection', (_, data) => { expect(deliver(data)).toBeNull() })
  it('rejects forged origins and senders independently', () => {
    expect(deliver(selection, fixtureDocument(), 'https://attacker.example')).toBeNull()
    expect(deliver(selection, fixtureDocument(), 'http://127.0.0.1:4319', {} as Window)).toBeNull()
  })
  it('reserves adapter DOM annotation attributes against component prop spoofing', () => {
    const document = fixtureDocument()
    document.nodes['input-1']!.props['data-preview-selected'] = true
    expect(isPreviewDocument(document)).toBe(false)
  })
})

describe('AT-PRV-002 stale generation negative controls', () => {
  it('retains the latest successful generation when old work arrives', () => {
    const state = new BuildGenerations<string>()
    expect(state.request()).toBe(1)
    expect(state.accept(1, 'first-good')).toBe(true)
    expect(state.request()).toBe(2)
    expect(state.request()).toBe(3)
    expect(state.accept(3, 'latest-good')).toBe(true)
    expect(state.accept(2, 'obsolete')).toBe(false)
    expect(state.good()).toEqual({ generation: 3, value: 'latest-good' })
  })
  it('does not replace last good when the current generation fails', () => {
    const state = new BuildGenerations<string>()
    state.request()
    state.accept(1, 'first-good')
    state.request()
    expect(state.accept(1, 'late-old')).toBe(false)
    expect(state.good()).toEqual({ generation: 1, value: 'first-good' })
  })
})

describe('AT-SEC-003 resolved color grammar', () => {
  it.each([
    ['six digit hex', '#1a2b3c'],
    ['upper case hex', '#1A2B3C'],
    ['eight digit hex', '#1a2b3c80'],
    ['oklch', 'oklch(0.62 0.19 259.8)'],
    ['oklch with alpha', 'oklch(0.62 0.19 259.8 / 0.5)'],
    ['oklch at its bounds', 'oklch(1 1 360 / 0)'],
    ['oklch with a tiny exponent', 'oklch(0.5 1e-7 0)'],
  ])('accepts %s', (_, color) => { expect(isPreviewColor(color)).toBe(true) })

  it.each([
    ['url', 'url(https://attacker.example/x.png)'],
    ['expression', 'expression(alert(1))'],
    ['declaration injection', '#ffffff;display:none'],
    ['brace', '#ffffff}'],
    ['rule injection', '} body { display: none'],
    ['custom property', 'var(--accent)'],
    ['gradient string', 'linear-gradient(135deg, #9b4dff 0%, #000000 100%)'],
    ['transparent keyword', 'transparent'],
    ['token name', 'accent'],
    ['named color', 'red'],
    ['three digit hex', '#fff'],
    ['seven digit hex', '#fffffff'],
    ['leading space', ' #ffffff'],
    ['trailing newline', '#ffffff\n'],
    ['empty', ''],
    ['lightness above one', 'oklch(1.2 0.1 10)'],
    ['negative chroma', 'oklch(0.5 -0.1 10)'],
    ['hue above 360', 'oklch(0.5 0.1 361)'],
    ['alpha above one', 'oklch(0.5 0.1 10 / 1.5)'],
    ['percent lightness', 'oklch(50% 0.1 10)'],
    ['comma oklch', 'oklch(0.5, 0.1, 10)'],
    ['number', 0xffffff],
    ['null', null],
  ])('rejects %s', (_, color) => { expect(isPreviewColor(color)).toBe(false) })
})

describe('AT-APP-003 and AT-SEC-003 appearance protocol', () => {
  // 1x1 transparent PNG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const full = () => ({
    visible: false as const, opacity: 0.5, blendMode: 'multiply',
    fills: [
      { type: 'solid', color: '#ff0000', blendMode: 'screen' },
      { type: 'gradient', shape: 'radial', angle: -45, center: { x: 0.25, y: 0.75 }, length: 1.5, interpolation: 'oklch', stops: [{ color: 'oklch(0.7 0.1 120 / 0.5)', position: 0, midpoint: 0.25 }, { color: '#0000ff80', position: 1 }], blendMode: 'normal' },
      { type: 'image', assetId: 'photo-1', fit: 'tile' },
    ],
    outline: { color: '#00ff00', width: 2, style: 'dashed', offset: -3 },
    borders: { top: { color: '#111111', width: 1, style: 'solid' }, bottom: { color: '#222222', width: 0, style: 'dotted' }, left: { color: '#333333', width: 1000, style: 'dashed' }, right: { color: '#444444', width: 4, style: 'solid' } },
  })
  const element = (appearance: unknown, kind = 'rectangle') => ({ id: 'box', kind, name: 'Box', relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 80, parentId: null, ...(kind === 'text' ? { text: 'Hi', textStyle: { fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false }, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } } } : {}), appearance })
  const documentWith = (appearance: unknown, assets: unknown = { 'photo-1': { mime: 'image/png', data: png } }, kind = 'rectangle') => ({ ...fixtureDocument(), canvas: { elements: [element(appearance, kind)] }, ...(assets === null ? {} : { assets }) })
  const withNode = (appearance: unknown) => { const document = fixtureDocument(); return { ...document, nodes: { ...document.nodes, 'button-1': { ...document.nodes['button-1']!, appearance } }, assets: { 'photo-1': { mime: 'image/png', data: png } } } }
  const setDocument = (document: unknown) => ({ channel: 'design-editor-preview', version: 9, generation: 4, type: 'set-document', document, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' })

  it('accepts a fully populated appearance on a primitive and on a component instance, through the real command boundary', () => {
    expect(isPreviewDocument(documentWith(full()))).toBe(true)
    expect(isPreviewDocument(withNode(full()))).toBe(true)
    const data = setDocument(documentWith(full()))
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data }, 'http://127.0.0.1:4319', parent, 4)).toEqual(data)
    expect(isPreviewDocument(documentWith({}))).toBe(true)
    expect(isPreviewDocument(documentWith({ fills: [{ type: 'solid', color: '#202124' }] }, undefined, 'text'))).toBe(true)
    expect(isPreviewDocument(documentWith({ opacity: 0 }, {}))).toBe(true)
  })

  const variations: [string, (appearance: ReturnType<typeof full>) => unknown][] = [
    ['unknown appearance key', value => ({ ...value, shadow: 1 })],
    ['visible true', value => ({ ...value, visible: true })],
    ['opacity above one', value => ({ ...value, opacity: 1.01 })],
    ['negative opacity', value => ({ ...value, opacity: -0.1 })],
    ['infinite opacity', value => ({ ...value, opacity: Infinity })],
    ['not a number opacity', value => ({ ...value, opacity: NaN })],
    ['string opacity', value => ({ ...value, opacity: '0.5' })],
    ['unknown blend mode', value => ({ ...value, blendMode: 'dissolve' })],
    ['upper case blend mode', value => ({ ...value, blendMode: 'Multiply' })],
    ['empty fills', value => ({ ...value, fills: [] })],
    ['seventeen fills', value => ({ ...value, fills: Array.from({ length: 17 }, () => ({ type: 'solid', color: '#ffffff' })) })],
    ['unknown fill type', value => ({ ...value, fills: [{ type: 'pattern', color: '#ffffff' }] })],
    ['unknown fill key', value => ({ ...value, fills: [{ type: 'solid', color: '#ffffff', id: 'fill-1' }] })],
    ['url in a fill color', value => ({ ...value, fills: [{ type: 'solid', color: 'url(https://attacker.example/x.png)' }] })],
    ['declaration in a fill color', value => ({ ...value, fills: [{ type: 'solid', color: '#ffffff;background:red' }] })],
    ['var in a stop color', value => ({ ...value, fills: [{ ...value.fills[1], stops: [{ color: 'var(--x)', position: 0 }, { color: '#000000', position: 1 }] }] })],
    ['expression in an outline color', value => ({ ...value, outline: { ...value.outline, color: 'expression(alert(1))' } })],
    ['brace in a border color', value => ({ ...value, borders: { top: { color: '#ffffff}', width: 1, style: 'solid' } } })],
    ['fill blend mode unknown', value => ({ ...value, fills: [{ type: 'solid', color: '#ffffff', blendMode: 'add' }] })],
    ['gradient shape unknown', value => ({ ...value, fills: [{ ...value.fills[1], shape: 'diamond' }] })],
    ['gradient interpolation unknown', value => ({ ...value, fills: [{ ...value.fills[1], interpolation: 'hsl' }] })],
    ['gradient angle above 360', value => ({ ...value, fills: [{ ...value.fills[1], angle: 361 }] })],
    ['gradient length below minimum', value => ({ ...value, fills: [{ ...value.fills[1], length: 0.001 }] })],
    ['gradient length above maximum', value => ({ ...value, fills: [{ ...value.fills[1], length: 10.5 }] })],
    ['gradient center out of range', value => ({ ...value, fills: [{ ...value.fills[1], center: { x: 3.5, y: 0 } }] })],
    ['gradient center extra key', value => ({ ...value, fills: [{ ...value.fills[1], center: { x: 0, y: 0, z: 0 } }] })],
    ['one stop', value => ({ ...value, fills: [{ ...value.fills[1], stops: [{ color: '#000000', position: 0 }] }] })],
    ['seventeen stops', value => ({ ...value, fills: [{ ...value.fills[1], stops: Array.from({ length: 17 }, (_, index) => ({ color: '#000000', position: index / 16 })) }] })],
    ['unsorted stops', value => ({ ...value, fills: [{ ...value.fills[1], stops: [{ color: '#000000', position: 0.8 }, { color: '#ffffff', position: 0.2 }] }] })],
    ['stop position above one', value => ({ ...value, fills: [{ ...value.fills[1], stops: [{ color: '#000000', position: 0 }, { color: '#ffffff', position: 1.5 }] }] })],
    ['stop midpoint above one', value => ({ ...value, fills: [{ ...value.fills[1], stops: [{ color: '#000000', position: 0, midpoint: 2 }, { color: '#ffffff', position: 1 }] }] })],
    ['stop unknown key', value => ({ ...value, fills: [{ ...value.fills[1], stops: [{ color: '#000000', position: 0, id: 'a' }, { color: '#ffffff', position: 1 }] }] })],
    ['image fill with a missing asset', value => ({ ...value, fills: [{ type: 'image', assetId: 'missing', fit: 'cover' }] })],
    ['image fill with a url asset id', value => ({ ...value, fills: [{ type: 'image', assetId: 'url(x)', fit: 'cover' }] })],
    ['image fill with an inline url', value => ({ ...value, fills: [{ type: 'image', assetId: 'photo-1', fit: 'cover', url: 'https://attacker.example/x.png' }] })],
    ['image fit unknown', value => ({ ...value, fills: [{ type: 'image', assetId: 'photo-1', fit: 'fill' }] })],
    ['outline without offset', value => ({ ...value, outline: { color: '#000000', width: 1, style: 'solid' } })],
    ['outline width above 1000', value => ({ ...value, outline: { ...value.outline, width: 1001 } })],
    ['outline offset below -1000', value => ({ ...value, outline: { ...value.outline, offset: -1001 } })],
    ['outline style unknown', value => ({ ...value, outline: { ...value.outline, style: 'double' } })],
    ['negative border width', value => ({ ...value, borders: { top: { color: '#000000', width: -1, style: 'solid' } } })],
    ['border with offset', value => ({ ...value, borders: { top: { color: '#000000', width: 1, style: 'solid', offset: 0 } } })],
    ['border side all', value => ({ ...value, borders: { all: { color: '#000000', width: 1, style: 'solid' } } })],
    ['empty borders', value => ({ ...value, borders: {} })],
    ['array appearance', () => []],
  ]
  it.each(variations)('rejects %s on primitives and component instances', (_, mutate) => {
    expect(isPreviewDocument(documentWith(mutate(full())))).toBe(false)
    expect(isPreviewDocument(withNode(mutate(full())))).toBe(false)
  })

  it('rejects outline and borders on text, a legacy fill field, and image fills without an asset map', () => {
    expect(isPreviewDocument(documentWith({ outline: { color: '#000000', width: 1, style: 'solid', offset: 0 } }, undefined, 'text'))).toBe(false)
    expect(isPreviewDocument(documentWith({ borders: { top: { color: '#000000', width: 1, style: 'solid' } } }, undefined, 'text'))).toBe(false)
    expect(isPreviewDocument({ ...fixtureDocument(), canvas: { elements: [{ ...element(undefined), fill: '#ffffff' }] } })).toBe(false)
    expect(isPreviewDocument(documentWith(full(), null))).toBe(false)
    expect(isPreviewDocument(documentWith({ fills: [{ type: 'solid', color: '#ffffff' }] }, null))).toBe(true)
    const data = setDocument(documentWith({ fills: [{ type: 'solid', color: 'url(x)' }] }))
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data }, 'http://127.0.0.1:4319', parent, 4)).toBeNull()
  })

  it('MATRIX-LAYOUT-NEG-001 accepts reflected affine matrices and rejects legacy flip state', () => {
    const { appearance: _appearance, ...plain } = element(undefined)
    expect(isPreviewDocument({ ...fixtureDocument(), canvas: { elements: [{ ...plain, relativeTransform: [-1, 0, 0, -1, 100, 80] }] } })).toBe(true)
    expect(isPreviewDocument({ ...fixtureDocument(), canvas: { elements: [{ ...plain, flipX: 1 }] } })).toBe(false)
    expect(isPreviewDocument({ ...fixtureDocument(), canvas: { elements: [{ ...plain, relativeTransform: [1, 0, 0, 0, 0, 0] }] } })).toBe(false)
    expect(isPreviewDocument({ ...fixtureDocument(), canvas: { elements: [{ ...plain, relativeTransform: [1, 0, 0, 1, Number.POSITIVE_INFINITY, 0] }] } })).toBe(false)
  })

  it.each([
    ['unknown asset key', { 'photo-1': { mime: 'image/png', data: png, name: 'x' } }],
    ['svg mime', { 'photo-1': { mime: 'image/svg+xml', data: png } }],
    ['data url prefix', { 'photo-1': { mime: 'image/png', data: `data:image/png;base64,${png}` } }],
    ['length not a multiple of four', { 'photo-1': { mime: 'image/png', data: png.slice(0, -1) } }],
    ['bad base64 character', { 'photo-1': { mime: 'image/png', data: `${png.slice(0, -4)}AA)=` } }],
    ['padding inside the data', { 'photo-1': { mime: 'image/png', data: `AA==${png}` } }],
    ['empty data', { 'photo-1': { mime: 'image/png', data: '' } }],
    ['oversized data', { 'photo-1': { mime: 'image/png', data: 'A'.repeat(2_000_008) } }],
    ['invalid asset id', { 'photo-1': { mime: 'image/png', data: png }, '__proto__x y': { mime: 'image/png', data: png } }],
    ['sixty five assets', Object.fromEntries([['photo-1', { mime: 'image/png', data: png }], ...Array.from({ length: 64 }, (_, index) => [`extra-${index}`, { mime: 'image/png', data: png }])])],
    ['array asset map', [{ mime: 'image/png', data: png }]],
  ])('rejects assets with %s', (_, assets) => {
    expect(isPreviewDocument(documentWith(full(), assets))).toBe(false)
  })

  it('accepts sixty four assets at the size limit and keeps the structural size limit separate from asset bytes', () => {
    const large = 'A'.repeat(2_000_004)
    expect(isPreviewDocument(documentWith(full(), { 'photo-1': { mime: 'image/webp', data: large } }))).toBe(true)
    expect(isPreviewDocument(documentWith(full(), Object.fromEntries([['photo-1', { mime: 'image/png', data: png }], ...Array.from({ length: 63 }, (_, index) => [`extra-${index}`, { mime: 'image/gif', data: png }])])))).toBe(true)
    const elements = Array.from({ length: 500 }, (_, index) => ({ ...element({ fills: Array.from({ length: 16 }, () => ({ type: 'gradient', shape: 'linear', angle: 0, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: [{ color: 'oklch(0.5 0.1 120 / 0.5)', position: 0 }, { color: 'oklch(0.5 0.1 120 / 0.5)', position: 1 }] })) }), id: `box-${index}` }))
    expect(isPreviewDocument({ ...fixtureDocument(), canvas: { elements: elements.slice(0, 100) } })).toBe(true)
    expect(isPreviewDocument({ ...fixtureDocument(), canvas: { elements } })).toBe(false)
  })

  it('FILE-ASSET-001 accepts real AVIF bytes at the isolated preview schema boundary', () => {
    expect(isPreviewDocument(documentWith(full(), { 'photo-1': { mime: 'image/avif', data: onePixelAvif } }))).toBe(true)
  })
})
