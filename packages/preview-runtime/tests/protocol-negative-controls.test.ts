import { describe, expect, it } from 'vitest'
import { acceptPreviewCommand, type PreviewDocument } from '../src/protocol.js'
// Protocol v3: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

// LAY-SEC-001 baseline. Wrong origin, opaque origin, wrong sender, stale generation, extra set-props/set-document/
// set-selection/set-interaction-mode fields, unknown and prototype layout ids, and oversized props are already covered
// in protocol.test.ts; this file adds the remaining envelope and set-layout negative controls. Every rejection table
// starts from a command that is accepted, so a rejection can only come from the single mutation under test.

const editorOrigin = 'http://127.0.0.1:4319'
const parent = {} as Window
const envelope = { channel: 'design-editor-preview', version: 3, generation: 7 } as const
const deliver = (data: unknown, document: PreviewDocument | null = null) => acceptPreviewCommand({ origin: editorOrigin, source: parent, data }, editorOrigin, parent, 7, document)

const document = (): PreviewDocument => ({
  version: 1, revision: 1, rootIds: ['card-1'],
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: {}, children: { children: ['button-1'] } },
    'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: { children: 'Go' }, children: {} },
  },
  frame: { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false },
})
const item = { nodeId: 'button-1', mode: 'absolute', x: 10, y: 20, order: 0, width: 120, height: 40 }
const layout = (items: unknown[]) => ({ ...envelope, type: 'set-layout', layoutGeneration: 0, items })

const accepted: [string, Record<string, unknown>, PreviewDocument | null][] = [
  ['set-layout', layout([item]), document()],
  ['set-theme', { ...envelope, type: 'set-theme', theme: { attribute: 'dark', colorScheme: 'dark' } }, null],
  ['set-camera', { ...envelope, type: 'set-camera', camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 } }, null],
  ['set-interaction-mode', { ...envelope, type: 'set-interaction-mode', mode: 'select' }, null],
  ['set-selection', { ...envelope, type: 'set-selection', nodeIds: ['button-1'], color: '#009ff0' }, document()],
  ['set-document', { ...envelope, type: 'set-document', document: document() }, null],
  ['set-props', { ...envelope, type: 'set-props', props: { children: 'Go' } }, null],
  ['dispose', { ...envelope, type: 'dispose' }, null],
  ['ping', { ...envelope, type: 'ping' }, null],
]

describe('LAY-SEC-001 unknown top-level fields', () => {
  it.each(accepted)('accepts a well formed %s command as the positive control', (_, data, doc) => {
    expect(deliver(data, doc)).toEqual(data)
  })

  it.each(accepted)('rejects %s with one unknown top-level field', (_, data, doc) => {
    expect(deliver({ ...data, sourcePath: '../outside' }, doc)).toBeNull()
    expect(deliver({ ...data, token: 'secret' }, doc)).toBeNull()
  })

  it.each(accepted)('rejects %s carrying a __proto__ own key from parsed JSON', (_, data, doc) => {
    const polluted = JSON.parse(`{"__proto__":{"admin":true},${JSON.stringify(data).slice(1)}`)
    expect(Object.hasOwn(polluted, '__proto__')).toBe(true)
    expect(deliver(polluted, doc)).toBeNull()
  })

  it.each(accepted)('rejects %s with a missing channel, version, or generation', (_, data, doc) => {
    const { channel: _channel, ...noChannel } = data
    const { version: _version, ...noVersion } = data
    const { generation: _generation, ...noGeneration } = data
    expect(deliver(noChannel, doc)).toBeNull()
    expect(deliver(noVersion, doc)).toBeNull()
    expect(deliver(noGeneration, doc)).toBeNull()
    expect(deliver({ ...data, version: 1 }, doc)).toBeNull()
    expect(deliver({ ...data, version: 2 }, doc)).toBeNull()
    expect(deliver({ ...data, version: 4 }, doc)).toBeNull()
    expect(deliver({ ...data, generation: '7' }, doc)).toBeNull()
  })

  it('rejects an unknown command type and a command that is not a plain record', () => {
    expect(deliver({ ...envelope, type: 'set-styles', items: [] })).toBeNull()
    expect(deliver({ ...envelope, type: 'eval', code: 'alert(1)' })).toBeNull()
    expect(deliver([envelope])).toBeNull()
    expect(deliver(JSON.stringify(layout([item])))).toBeNull()
    expect(deliver(null)).toBeNull()
  })
})

describe('LAY-SEC-001 unknown fields inside a set-layout item', () => {
  it('accepts the base item with and without its optional size fields', () => {
    expect(deliver(layout([item]), document())).not.toBeNull()
    const { width: _width, height: _height, ...bare } = item
    expect(deliver(layout([bare]), document())).not.toBeNull()
  })

  it.each([
    ['a CSS string', { style: 'color: red' }],
    ['a transform', { transform: 'rotate(45deg)' }],
    ['a v4 position record', { position: { mode: 'absolute', left: { kind: 'px', value: 10 } } }],
    ['a parent id', { parentId: 'card-1' }],
    ['a slot', { slot: 'children' }],
    ['a source path', { path: 'src/atoms/Button.tsx' }],
    ['an explicit undefined field', { zIndex: undefined }],
  ])('rejects an item with %s', (_, extra) => {
    expect(deliver(layout([{ ...item, ...extra }]), document())).toBeNull()
  })

  it('rejects an item with a __proto__ own key and one bad item among good ones', () => {
    const polluted = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(item).slice(1)}`)
    expect(deliver(layout([polluted]), document())).toBeNull()
    const second = { ...item, nodeId: 'card-1', mode: 'flow', order: 1 }
    expect(deliver(layout([item, second]), document())).not.toBeNull()
    expect(deliver(layout([item, { ...second, color: '#ff0000' }]), document())).toBeNull()
  })

  it.each([
    ['an unknown mode', { mode: 'fixed' }],
    ['a string coordinate', { x: '10' }],
    ['a NaN coordinate', { y: Number.NaN }],
    ['an infinite coordinate', { x: Number.POSITIVE_INFINITY }],
    ['a fractional order', { order: 1.5 }],
    ['a negative order', { order: -1 }],
    ['a zero width', { width: 0 }],
    ['a negative height', { height: -4 }],
    ['a string width', { width: '120px' }],
  ])('rejects an item with %s', (_, patch) => {
    expect(deliver(layout([{ ...item, ...patch }]), document())).toBeNull()
  })

  it('rejects items that are not records', () => {
    expect(deliver(layout(['button-1']), document())).toBeNull()
    expect(deliver(layout([null]), document())).toBeNull()
    expect(deliver(layout([[item]]), document())).toBeNull()
    expect(deliver({ ...envelope, type: 'set-layout', layoutGeneration: 0, items: { 0: item } }, document())).toBeNull()
  })
})

describe('LAY-SEC-001 invalid node ids in set-layout', () => {
  it('accepts the longest valid id as the positive control', () => {
    const id = `a${'b'.repeat(127)}`
    const doc = document()
    doc.nodes[id] = { id, componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: {}, children: {} }
    doc.nodes['card-1']!.children.children!.push(id)
    expect(deliver(layout([{ ...item, nodeId: id }]), doc)).not.toBeNull()
  })

  it.each([
    ['an empty id', ''],
    ['a leading space', ' button-1'],
    ['a trailing newline', 'button-1\n'],
    ['an id over 128 characters', `a${'b'.repeat(128)}`],
    ['a leading separator', '-button-1'],
    ['a CSS selector', 'button-1"]'],
    ['a path', '../button-1'],
    ['constructor', 'constructor'],
    ['prototype', 'prototype'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s even without a document to check membership', (_, nodeId) => {
    expect(deliver(layout([{ ...item, nodeId }]))).toBeNull()
  })

  it('rejects a duplicate node id and an id that is valid but absent from the current document', () => {
    expect(deliver(layout([item, { ...item, order: 1 }]), document())).toBeNull()
    expect(deliver(layout([{ ...item, nodeId: 'button-2' }]), document())).toBeNull()
  })
})

describe('LAY-SEC-001 oversize set-layout payloads', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ nodeId: `node-${index}`, mode: 'flow', x: 0, y: 0, order: index % 501 }))

  it('accepts 500 items and rejects 501', () => {
    expect(deliver(layout(many(500)))).not.toBeNull()
    expect(deliver(layout(many(501)))).toBeNull()
  })

  it.each([
    ['x past 1000000', { x: 1_000_001 }, { x: 1_000_000 }],
    ['y below -1000000', { y: -1_000_001 }, { y: -1_000_000 }],
    ['width past 1000000', { width: 1_000_001 }, { width: 1_000_000 }],
    ['height past 1000000', { height: 1_000_001 }, { height: 1_000_000 }],
    ['order past 500', { order: 501 }, { order: 500 }],
  ])('rejects %s and accepts the bound itself', (_, over, bound) => {
    expect(deliver(layout([{ ...item, ...bound }]), document())).not.toBeNull()
    expect(deliver(layout([{ ...item, ...over }]), document())).toBeNull()
  })
})

describe('LAY-SEC-001 appearance layer priority conflicts', () => {
  it.todo('LAY-SEC-001: the appearance layer reports when an !important stylesheet rule overrides an inline appearance value (no conflict check or diagnostic exists; appearance-layer.mjs only restores inline priorities)')
  // The layout layer now preserves inline priorities and reports stylesheet !important conflicts; see layout-root-baseline.test.ts (LAY-ROOT-001) and layout-runtime.test.ts (LAY-ROOT-002).
})
