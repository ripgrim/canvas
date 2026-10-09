import { describe, expect, it } from 'vitest'
import {
  ancestorsOf, applyFileCommand, childrenOf, createBlankFile, descendantsOf, frameAt, legacyPageDocument, nodeAppearance, pageNodes,
  pageOfNode, projectAppearance, resolveColorValue, resolveToken, tokenReferences, validateFileDocument, worldPosition, worldRect,
} from '../src/file-document.js'
import type { Appearance, ColorToken, ColorValue, ComponentNode, FileCommand, FileDocument, FileNode, FileTheme, ImageAsset, Paint, PrimitiveNode, PrimitiveStyles, Stroke } from '../src/file-document.js'
import type { Color } from '../src/color.js'
import type { NodeLayout } from '../src/layout.js'
import type { Atom } from '../src/types.js'

const card: Atom = { name: 'Card', kind: 'atom', componentId: 'sample-card', exportName: 'Card', path: 'src/atoms/Card.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'heading', type: 'ReactNode', optional: true }] }
const button: Atom = { name: 'Button', kind: 'atom', componentId: 'sample-button', exportName: 'Button', path: 'src/atoms/Button.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'variant', type: '"primary" | "quiet" | undefined', optional: true }] }
const atoms: Atom[] = [card, button]

const hex = (value: string): Color => ({ kind: 'hex', hex: value })
const lit = (value: string): ColorValue => ({ kind: 'literal', color: hex(value) })
const tok = (tokenId: string): ColorValue => ({ kind: 'token', tokenId })
const solid = (id: string, value: string): Paint => ({ id, type: 'solid', color: lit(value) })
const tokenPaint = (id: string, tokenId: string): Paint => ({ id, type: 'solid', color: tok(tokenId) })
const gradient = (id: string, angle: number, stops: [string, number, ColorValue][]): Paint => ({ id, type: 'gradient', shape: 'linear', angle, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: stops.map(([stopId, position, color]) => ({ id: stopId, position, color })) })
const stroke = (color: ColorValue, width = 1): Stroke => ({ color, width, style: 'solid' })
const frame = (id: string, left: number, top: number, width = 100, height = 100): PrimitiveNode => ({ id, type: 'frame', name: id, styles: { left, top, width, height } })
const rect = (id: string, left: number, top: number, fills: Paint[] = []): PrimitiveNode => ({ id, type: 'rectangle', name: id, styles: { left, top, width: 10, height: 10 }, ...(fills.length ? { appearance: { fills } } : {}) })
const text = (id: string, value: string): PrimitiveNode => ({ id, type: 'text', name: id, styles: { left: 0, top: 0, width: 80, height: 20 }, text: value })
const pixel = (id = 'img'): ImageAsset => ({ id, name: 'Pixel', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' })
const appearanceOf = (file: FileDocument, nodeId: string) => nodeAppearance(file.nodes[nodeId])
/** The exact error message, so a broader message with the same prefix cannot satisfy the assertion. */
const thrown = (action: () => unknown): string | null => { try { action() } catch (error) { return (error as Error).message } return null }
const cardNode = (id: string, props: ComponentNode['props'] = {}): ComponentNode => ({ id, type: 'component', componentId: 'sample-card', exportName: 'Card', props })
const buttonNode = (id: string, props: ComponentNode['props'] = {}): ComponentNode => ({ id, type: 'component', componentId: 'sample-button', exportName: 'Button', props })
const literalToken = (id: string, orderKey: string, value: string, name = id): ColorToken => ({ id, type: 'color', name, orderKey, value: { kind: 'literal', color: hex(value) } })
const aliasToken = (id: string, orderKey: string, target: string): ColorToken => ({ id, type: 'color', name: id, orderKey, value: { kind: 'alias', tokenId: target } })

/**
 * Hand-built fixture. World geometry: outer (100,50 400x300) > inner local (20,30) world (120,80 200x150) > box local
 * (5,7) world (125,87 10x10). label sits on the root after outer.
 */
const fixture = (): FileDocument => ({
  schemaVersion: 5,
  fileId: 'file-1',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    outer: frame('outer', 100, 50, 400, 300),
    inner: frame('inner', 20, 30, 200, 150),
    box: rect('box', 5, 7, [tokenPaint('box:fill:1', 'brand')]),
    label: text('label', 'Hello'),
  },
  relationships: {
    outer: { parentId: 'root-1', orderKey: 'V' },
    inner: { parentId: 'outer', orderKey: 'V' },
    box: { parentId: 'inner', orderKey: 'V' },
    label: { parentId: 'root-1', orderKey: 'W' },
  },
  theme: { tokens: { brand: literalToken('brand', 'V', '#3366cc', 'Brand') } },
})

const run = (file: FileDocument, command: FileCommand) => applyFileCommand(file, command, atoms)
const asRecord = (value: unknown) => value as Record<string, unknown>
const defineOwn = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })

describe('file validation', () => {
  it('accepts a blank file and returns a detached copy', () => {
    const blank = createBlankFile('file-1', 'page-1', 'root-1')
    const validated = validateFileDocument(blank, [])
    expect(validated).toEqual({ schemaVersion: 5, fileId: 'file-1', revision: 0, pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }], nodes: { 'root-1': { id: 'root-1', type: 'root' } }, relationships: {}, theme: { tokens: {} } })
    expect(validated).not.toBe(blank)
  })

  it('accepts the nested fixture (positive control for every rejection below)', () => {
    expect(validateFileDocument(fixture(), atoms)).toEqual(fixture())
  })

  const rejects: [string, (file: FileDocument) => void, string][] = [
    ['a wrong schema version', file => { asRecord(file).schemaVersion = 1 }, 'Unsupported design file version'],
    ['the version 2 schema without an upgrade', file => { asRecord(file).schemaVersion = 2 }, 'Unsupported design file version'],
    ['the version 3 schema without an upgrade', file => { asRecord(file).schemaVersion = 3 }, 'Unsupported design file version'],
    ['a stored version 3 five-field component layout', file => { file.nodes.card = { ...cardNode('card'), layout: { mode: 'absolute', x: 1, y: 2 } as never }; file.relationships.card = { parentId: 'root-1', orderKey: 'X' } }, 'Unsupported node layout field'],
    ['an inset on a flow component', file => { file.nodes.card = { ...cardNode('card'), layout: { item: { position: { mode: 'flow', left: { kind: 'px', value: 1 } } } } }; file.relationships.card = { parentId: 'root-1', orderKey: 'X' } }, 'Invalid component layout'],
    ['a stored version 2 fills field', file => { asRecord(file.nodes.box).fills = [] }, 'Unsupported node field'],
    ['duplicate page ids', file => { file.nodes['root-2'] = { id: 'root-2', type: 'root' }; file.pages.push({ id: 'page-1', name: 'Copy', rootNodeId: 'root-2' }) }, 'Invalid page identity'],
    ['a missing page root', file => { file.pages[0]!.rootNodeId = 'root-x' }, 'A page root is missing'],
    ['a page root that is a primitive', file => { file.pages[0]!.rootNodeId = 'outer' }, 'A page root is missing'],
    ['a root with a relationship', file => { file.relationships['root-1'] = { parentId: 'outer', orderKey: 'X' } }, 'Page roots cannot have a parent'],
    ['a non-root node without a relationship', file => { delete file.relationships.label }, 'A node has no parent'],
    ['a relationship to a missing parent', file => { file.relationships.label!.parentId = 'ghost' }, 'A node parent is missing'],
    ['a relationship for a missing node', file => { file.relationships.ghost = { parentId: 'root-1', orderKey: 'X' } }, 'A relationship names a missing node'],
    ['a parent cycle', file => { file.relationships.outer = { parentId: 'inner', orderKey: 'V' } }, 'Node hierarchy contains a cycle'],
    ['a rectangle used as a parent', file => { file.relationships.label!.parentId = 'box' }, 'A node cannot live under that parent'],
    ['a component under a frame', file => { file.nodes.card = cardNode('card'); file.relationships.card = { parentId: 'outer', orderKey: 'W' } }, 'A node cannot live under that parent'],
    ['a primitive under a component', file => { file.nodes.card = cardNode('card'); file.relationships.card = { parentId: 'root-1', orderKey: 'X' }; file.relationships.label = { parentId: 'card', orderKey: 'V', slot: 'children' } }, 'A node cannot live under that parent'],
    ['a component child without a slot', file => { file.nodes.card = cardNode('card'); file.nodes.btn = buttonNode('btn'); file.relationships.card = { parentId: 'root-1', orderKey: 'X' }; file.relationships.btn = { parentId: 'card', orderKey: 'V' } }, 'A node cannot live under that parent'],
    ['a component child in an unknown slot', file => { file.nodes.card = cardNode('card'); file.nodes.btn = buttonNode('btn'); file.relationships.card = { parentId: 'root-1', orderKey: 'X' }; file.relationships.btn = { parentId: 'card', orderKey: 'V', slot: 'footer' } }, 'A node cannot live under that parent'],
    ['a slot on a root child', file => { file.relationships.label!.slot = 'children' }, 'A node cannot live under that parent'],
    ['an order key ending in 0', file => { file.relationships.label!.orderKey = 'a0' }, 'Invalid relationship'],
    ['an empty order key', file => { file.relationships.label!.orderKey = '' }, 'Invalid relationship'],
    ['an order key with symbols', file => { file.relationships.label!.orderKey = 'a-b' }, 'Invalid relationship'],
    ['a fill referencing a missing token', file => { (file.nodes.box as PrimitiveNode).appearance = { fills: [tokenPaint('f', 'ghost')] } }, 'A fill references a missing token'],
    ['a gradient stop referencing a missing token', file => { (file.nodes.box as PrimitiveNode).appearance = { fills: [gradient('f', 90, [['a', 0, tok('ghost')], ['b', 1, lit('#000000')]])] } }, 'A fill references a missing token'],
    ['an outline referencing a missing token', file => { (file.nodes.box as PrimitiveNode).appearance = { outline: { ...stroke(tok('ghost')), offset: 0 } } }, 'A fill references a missing token'],
    ['a border side referencing a missing token', file => { (file.nodes.box as PrimitiveNode).appearance = { borders: { left: stroke(tok('ghost')) } } }, 'A fill references a missing token'],
    ['a cached solid referencing a missing token', file => { (file.nodes.box as PrimitiveNode).appearance = { fills: [{ ...solid('f', '#000000'), cache: { solid: { color: tok('ghost') } } }] } }, 'A fill references a missing token'],
    ['an image fill without its asset', file => { (file.nodes.box as PrimitiveNode).appearance = { fills: [{ id: 'f', type: 'image', assetId: 'img', fit: 'cover' }] } }, 'An image fill references a missing asset'],
    ['a cached image without its asset', file => { file.assets = { other: pixel('other') }; (file.nodes.box as PrimitiveNode).appearance = { fills: [{ ...solid('f', '#000000'), cache: { image: { assetId: 'img', fit: 'cover' } } }] } }, 'An image fill references a missing asset'],
    ['an asset keyed differently from its id', file => { file.assets = { other: pixel('img') } }, 'Invalid image asset identity'],
    ['a malformed asset', file => { file.assets = { img: { ...pixel(), mime: 'image/svg+xml' as never } } }, 'Unsupported image type'],
    ['an outline on text', file => { (file.nodes.label as PrimitiveNode).appearance = { outline: { ...stroke(lit('#000000')), offset: 0 } } }, 'This node has no outline'],
    ['a stored opacity of 1', file => { (file.nodes.box as PrimitiveNode).appearance = { opacity: 1 } }, 'Invalid node opacity'],
    ['a component appearance with visible true', file => { file.nodes.card = { ...cardNode('card'), appearance: { visible: true as never } }; file.relationships.card = { parentId: 'root-1', orderKey: 'X' } }, 'Invalid node visibility'],
    ['an alias to a missing token', file => { file.theme.tokens.accent = aliasToken('accent', 'W', 'ghost') }, 'Token alias target is missing'],
    ['an alias cycle', file => { file.theme.tokens.a = aliasToken('a', 'W', 'b'); file.theme.tokens.b = aliasToken('b', 'X', 'a') }, 'Token aliases cannot form a cycle'],
    ['a self alias', file => { file.theme.tokens.a = aliasToken('a', 'W', 'a') }, 'Token aliases cannot form a cycle'],
    ['oversized text', file => { (file.nodes.label as PrimitiveNode).text = 'x'.repeat(10_001) }, 'Invalid node text'],
    ['text on a rectangle', file => { (file.nodes.box as PrimitiveNode).text = 'x' }, 'Invalid node text'],
    ['a negative width', file => { (file.nodes.box as PrimitiveNode).styles.width = -4 }, 'Invalid node geometry'],
    ['overflow on a rectangle', file => { (file.nodes.box as PrimitiveNode).styles.overflow = 'clip' }, 'Invalid node geometry'],
    ['an unknown node field', file => { asRecord(file.nodes.box).color = 'red' }, 'Unsupported node field'],
    ['an unknown page field', file => { asRecord(file.pages[0]).hidden = true }, 'Unsupported page field'],
    ['an unknown relationship field', file => { asRecord(file.relationships.box).z = 1 }, 'Unsupported relationship field'],
    ['an unknown token field', file => { asRecord(file.theme.tokens.brand).group = 'x' }, 'Unsupported token field'],
    ['an unknown file field', file => { asRecord(file).extra = true }, 'Unsupported design file field'],
    ['a __proto__ node id', file => { defineOwn(file.nodes, '__proto__', { id: '__proto__', type: 'rectangle', name: 'x', styles: { left: 0, top: 0, width: 1, height: 1 } }) }, 'Invalid node identity'],
    ['a constructor token id', file => { defineOwn(file.theme.tokens, 'constructor', literalToken('constructor', 'X', '#000000')) }, 'Invalid token identity'],
    ['a __proto__ page id', file => { file.pages[0]!.id = '__proto__' }, 'Invalid page identity'],
    ['a node keyed differently from its id', file => { file.nodes.box = { ...file.nodes.box!, id: 'other' } as FileNode }, 'Invalid node identity'],
  ]
  it.each(rejects)('rejects %s', (_label, mutate, message) => {
    const file = fixture()
    mutate(file)
    expect(() => validateFileDocument(file, atoms)).toThrow(message)
  })

  it('rejects components whose binding is not bound unless unavailable bindings are allowed', () => {
    const file = fixture()
    file.nodes.card = cardNode('card')
    file.relationships.card = { parentId: 'root-1', orderKey: 'X' }
    const missing = [{ ...card, status: 'missing' as const }]
    expect(() => validateFileDocument(file, missing)).toThrow('Component binding needs review')
    expect(validateFileDocument(file, missing, { allowUnavailableBindings: true }).nodes.card).toEqual(cardNode('card'))
  })
})

describe('derived views', () => {
  it('orders children by order key, then by id on ties', () => {
    const file = createBlankFile('file-1', 'page-1', 'root-1')
    for (const [id, orderKey] of [['b', 'W'], ['c', 'V'], ['a', 'V'], ['d', 'U']] as const) { file.nodes[id] = rect(id, 0, 0); file.relationships[id] = { parentId: 'root-1', orderKey } }
    expect(childrenOf(file, 'root-1')).toEqual(['d', 'a', 'c', 'b'])
    expect(childrenOf(file, 'missing')).toEqual([])
  })

  it('lists page nodes in pre-order and maps nodes to their page', () => {
    const file = fixture()
    expect(pageNodes(file, 'page-1')).toEqual(['outer', 'inner', 'box', 'label'])
    expect(pageNodes(file, 'page-x')).toEqual([])
    expect(pageOfNode(file, 'box')).toBe('page-1')
    expect(pageOfNode(file, 'root-1')).toBe('page-1')
    expect(pageOfNode(file, 'ghost')).toBeNull()
  })

  it('walks ancestors and descendants', () => {
    const file = fixture()
    expect(ancestorsOf(file, 'box')).toEqual(['inner', 'outer', 'root-1'])
    expect(ancestorsOf(file, 'root-1')).toEqual([])
    expect(descendantsOf(file, 'outer')).toEqual(['inner', 'box'])
    expect(descendantsOf(file, 'box')).toEqual([])
  })

  it('sums nested frame offsets into world geometry', () => {
    const file = fixture()
    expect(worldPosition(file, 'outer')).toEqual({ x: 100, y: 50 })
    expect(worldPosition(file, 'inner')).toEqual({ x: 120, y: 80 })
    expect(worldPosition(file, 'box')).toEqual({ x: 125, y: 87 })
    expect(worldRect(file, 'inner')).toEqual({ x: 120, y: 80, width: 200, height: 150 })
    expect(worldRect(file, 'box')).toEqual({ x: 125, y: 87, width: 10, height: 10 })
    expect(worldRect(file, 'root-1')).toBeNull()
    expect(worldRect(file, 'ghost')).toBeNull()
  })

  it('places absolutely positioned components and gives flow components no rect', () => {
    const file = fixture()
    file.nodes.card = { ...cardNode('card'), layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 40 }, top: { kind: 'px', value: 60 } }, width: { value: { kind: 'px', value: 200 } }, height: { value: { kind: 'px', value: 100 } } } } }
    file.nodes.flow = { ...cardNode('flow'), layout: { item: { position: { mode: 'flow' } } } }
    file.relationships.card = { parentId: 'root-1', orderKey: 'X' }
    file.relationships.flow = { parentId: 'root-1', orderKey: 'Y' }
    expect(worldRect(file, 'card')).toEqual({ x: 40, y: 60, width: 200, height: 100 })
    expect(worldRect(file, 'flow')).toBeNull()
  })

  it('finds the deepest frame under a point and skips an excluded subtree', () => {
    const file = fixture()
    expect(frameAt(file, 'page-1', { x: 130, y: 90 })).toBe('inner')
    expect(frameAt(file, 'page-1', { x: 450, y: 300 })).toBe('outer')
    expect(frameAt(file, 'page-1', { x: 130, y: 90 }, 'inner')).toBe('outer')
    expect(frameAt(file, 'page-1', { x: 130, y: 90 }, 'outer')).toBeNull()
    expect(frameAt(file, 'page-1', { x: 0, y: 0 })).toBeNull()
  })

  it('projects the legacy page view with slot children, ordered roots, and the flow host frame', () => {
    const file = fixture()
    file.revision = 7
    file.nodes.card = { ...cardNode('card'), name: 'Hero card' }
    file.nodes.top = { ...buttonNode('top', { variant: 'quiet' }), layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 4 }, top: { kind: 'px', value: 8 } } } } }
    file.nodes['btn-a'] = buttonNode('btn-a', { children: 'A' })
    file.nodes['btn-b'] = buttonNode('btn-b', { children: 'B' })
    file.nodes.title = buttonNode('title')
    file.relationships.card = { parentId: 'root-1', orderKey: 'X' }
    file.relationships.top = { parentId: 'root-1', orderKey: 'U' }
    file.relationships['btn-b'] = { parentId: 'card', orderKey: 'W', slot: 'children' }
    file.relationships['btn-a'] = { parentId: 'card', orderKey: 'V', slot: 'children' }
    file.relationships.title = { parentId: 'card', orderKey: 'V', slot: 'heading' }
    expect(legacyPageDocument(validateFileDocument(file, atoms), 'page-1')).toEqual({
      version: 1,
      revision: 7,
      rootIds: ['top', 'card'],
      nodes: {
        top: { id: 'top', componentId: 'sample-button', exportName: 'Button', props: { variant: 'quiet' }, children: {}, layout: { mode: 'absolute', x: 4, y: 8 } },
        card: { id: 'card', componentId: 'sample-card', exportName: 'Card', name: 'Hero card', props: {}, children: { children: ['btn-a', 'btn-b'], heading: ['title'] } },
        'btn-a': { id: 'btn-a', componentId: 'sample-button', exportName: 'Button', props: { children: 'A' }, children: {} },
        'btn-b': { id: 'btn-b', componentId: 'sample-button', exportName: 'Button', props: { children: 'B' }, children: {} },
        title: { id: 'title', componentId: 'sample-button', exportName: 'Button', props: {}, children: {} },
      },
      frame: { name: 'Page 1', width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false },
    })
    expect(() => legacyPageDocument(file, 'page-x')).toThrow('Unknown page')
  })
})

describe('node commands', () => {
  const withRow = () => {
    let file = createBlankFile('file-1', 'page-1', 'root-1')
    for (const id of ['a', 'b', 'c']) file = run(file, { type: 'node.insert', node: rect(id, 0, 0), placement: { parentId: 'root-1' } })
    return file
  }

  it('appends inserts and bumps the revision once per command', () => {
    const file = withRow()
    expect(file.revision).toBe(3)
    expect(childrenOf(file, 'root-1')).toEqual(['a', 'b', 'c'])
    expect(['a', 'b', 'c'].map(id => file.relationships[id]!.orderKey)).toEqual(['V', 'W', 'X'])
  })

  it('inserts at an index between neighbours and at an explicit order key', () => {
    const atIndex = run(withRow(), { type: 'node.insert', node: rect('d', 0, 0), placement: { parentId: 'root-1', index: 1 } })
    expect(childrenOf(atIndex, 'root-1')).toEqual(['a', 'd', 'b', 'c'])
    expect(atIndex.relationships.d).toEqual({ parentId: 'root-1', orderKey: 'VV' })
    expect(atIndex.revision).toBe(4)
    const atKey = run(withRow(), { type: 'node.insert', node: rect('e', 0, 0), placement: { parentId: 'root-1', orderKey: 'U' } })
    expect(childrenOf(atKey, 'root-1')).toEqual(['e', 'a', 'b', 'c'])
  })

  it.each([
    ['an index past the end', { type: 'node.insert', node: rect('d', 0, 0), placement: { parentId: 'root-1', index: 4 } }, 'Invalid position'],
    ['a negative index', { type: 'node.insert', node: rect('d', 0, 0), placement: { parentId: 'root-1', index: -1 } }, 'Invalid position'],
    ['an order key ending in 0', { type: 'node.insert', node: rect('d', 0, 0), placement: { parentId: 'root-1', orderKey: 'a0' } }, 'Invalid order key'],
    ['a missing parent', { type: 'node.insert', node: rect('d', 0, 0), placement: { parentId: 'ghost' } }, 'Select an existing node'],
    ['a rectangle parent', { type: 'node.insert', node: rect('d', 0, 0), placement: { parentId: 'a' } }, 'That node cannot be placed there'],
    ['an existing id', { type: 'node.insert', node: rect('a', 0, 0), placement: { parentId: 'root-1' } }, 'Node identity is invalid'],
    ['a root node', { type: 'node.insert', node: { id: 'r2', type: 'root' }, placement: { parentId: 'root-1' } }, 'Node identity is invalid'],
    ['invalid geometry', { type: 'node.insert', node: { ...rect('d', 0, 0), styles: { left: 0, top: 0, width: 0, height: 10 } }, placement: { parentId: 'root-1' } }, 'Invalid node geometry'],
  ] as [string, FileCommand, string][])('rejects an insert with %s and leaves the input unchanged', (_label, command, message) => {
    const file = withRow()
    const before = structuredClone(file)
    expect(() => run(file, command)).toThrow(message)
    expect(file).toEqual(before)
  })

  it('reparents preserving world position (Paper sample)', () => {
    let file = createBlankFile('file-1', 'page-1', 'root-1')
    file = run(file, { type: 'node.insert', node: frame('1-0', -156, -194), placement: { parentId: 'root-1' } })
    file = run(file, { type: 'node.insert', node: frame('2-0', -174, -221), placement: { parentId: 'root-1' } })
    file = run(file, { type: 'node.reparent', nodeId: '1-0', placement: { parentId: '2-0' }, preserveWorldPosition: true })
    expect((file.nodes['1-0'] as PrimitiveNode).styles).toEqual({ left: 18, top: 27, width: 100, height: 100 })
    expect(file.relationships['1-0']).toEqual({ parentId: '2-0', orderKey: 'V' })
    expect(worldPosition(file, '1-0')).toEqual({ x: -156, y: -194 })
    expect(file.revision).toBe(3)
  })

  it('reparents across two nested levels preserving world position', () => {
    // box world (125,87). Into outer (world 100,50): local (25,37). Out to the root: (125,87). Into inner (120,80): (5,7).
    let file = run(fixture(), { type: 'node.reparent', nodeId: 'box', placement: { parentId: 'outer' }, preserveWorldPosition: true })
    expect((file.nodes.box as PrimitiveNode).styles).toMatchObject({ left: 25, top: 37 })
    file = run(file, { type: 'node.reparent', nodeId: 'box', placement: { parentId: 'root-1', index: 0 }, preserveWorldPosition: true })
    expect((file.nodes.box as PrimitiveNode).styles).toMatchObject({ left: 125, top: 87 })
    expect(childrenOf(file, 'root-1')).toEqual(['box', 'outer', 'label'])
    file = run(file, { type: 'node.reparent', nodeId: 'label', placement: { parentId: 'inner' }, preserveWorldPosition: true })
    expect((file.nodes.label as PrimitiveNode).styles).toMatchObject({ left: -120, top: -80 })
    expect(worldPosition(file, 'label')).toEqual({ x: 0, y: 0 })
  })

  it('keeps local styles when world position is not preserved', () => {
    const file = run(fixture(), { type: 'node.reparent', nodeId: 'box', placement: { parentId: 'root-1' } })
    expect((file.nodes.box as PrimitiveNode).styles).toEqual({ left: 5, top: 7, width: 10, height: 10 })
    expect(worldPosition(file, 'box')).toEqual({ x: 5, y: 7 })
  })

  it('refuses to reparent a node into itself or its own subtree', () => {
    const file = fixture()
    expect(() => run(file, { type: 'node.reparent', nodeId: 'outer', placement: { parentId: 'inner' } })).toThrow('A node cannot move inside its own subtree')
    expect(() => run(file, { type: 'node.reparent', nodeId: 'outer', placement: { parentId: 'outer' } })).toThrow('A node cannot move inside its own subtree')
    expect(() => run(file, { type: 'node.reparent', nodeId: 'root-1', placement: { parentId: 'outer' } })).toThrow('Select an existing node')
  })

  it('reorders siblings by changing only the moved order key', () => {
    const file = withRow()
    const first = run(file, { type: 'node.reorder', nodeId: 'c', index: 0 })
    expect(childrenOf(first, 'root-1')).toEqual(['c', 'a', 'b'])
    expect(first.nodes).toEqual(file.nodes)
    expect(first.relationships).toEqual({ ...file.relationships, c: { parentId: 'root-1', orderKey: 'F' } })
    const last = run(file, { type: 'node.reorder', nodeId: 'a', index: 2 })
    expect(childrenOf(last, 'root-1')).toEqual(['b', 'c', 'a'])
    expect(last.relationships.a).toEqual({ parentId: 'root-1', orderKey: 'Y' })
    expect(() => run(file, { type: 'node.reorder', nodeId: 'a', index: 3 })).toThrow('Invalid position')
  })

  it('duplicates a subtree with rewritten internal parents and an offset, leaving the source untouched', () => {
    const file = fixture()
    const next = run(file, { type: 'node.duplicate', nodeId: 'outer', ids: { outer: 'outer-2', inner: 'inner-2', box: 'box-2' }, offset: { x: 10, y: 20 } })
    expect(childrenOf(next, 'root-1')).toEqual(['outer', 'outer-2', 'label'])
    expect(next.relationships['outer-2']).toEqual({ parentId: 'root-1', orderKey: 'VV' })
    expect(next.relationships['inner-2']).toEqual({ parentId: 'outer-2', orderKey: 'V' })
    expect(next.relationships['box-2']).toEqual({ parentId: 'inner-2', orderKey: 'V' })
    expect(next.nodes['outer-2']).toEqual({ ...frame('outer-2', 110, 70, 400, 300), name: 'outer' })
    expect(next.nodes['inner-2']).toEqual({ ...frame('inner-2', 20, 30, 200, 150), name: 'inner' })
    expect(next.nodes['box-2']).toEqual({ ...rect('box-2', 5, 7, [tokenPaint('box:fill:1', 'brand')]), name: 'box' })
    for (const id of ['outer', 'inner', 'box', 'label']) { expect(next.nodes[id]).toEqual(file.nodes[id]); expect(next.relationships[id]).toEqual(file.relationships[id]) }
    expect(worldPosition(next, 'box-2')).toEqual({ x: 135, y: 107 })
    expect(next.revision).toBe(1)
  })

  it.each([
    ['a missing descendant id', { outer: 'outer-2', inner: 'inner-2' }, 'Provide a new identity for every copied node'],
    ['an id for a node outside the subtree', { outer: 'outer-2', inner: 'inner-2', box: 'box-2', label: 'label-2' }, 'Provide a new identity for every copied node'],
    ['two copies sharing an id', { outer: 'outer-2', inner: 'same', box: 'same' }, 'Copied nodes need unique new identities'],
    ['a copy reusing an existing id', { outer: 'outer-2', inner: 'inner-2', box: 'label' }, 'Copied nodes need unique new identities'],
  ])('rejects a duplicate with %s', (_label, ids, message) => {
    const file = fixture()
    const before = structuredClone(file)
    expect(() => run(file, { type: 'node.duplicate', nodeId: 'outer', ids })).toThrow(message)
    expect(file).toEqual(before)
  })

  it('deletes a subtree with its relationships and leaves other nodes alone', () => {
    const file = fixture()
    const next = run(file, { type: 'node.delete', nodeIds: ['inner'] })
    expect(Object.keys(next.nodes).sort()).toEqual(['label', 'outer', 'root-1'])
    expect(Object.keys(next.relationships).sort()).toEqual(['label', 'outer'])
    expect(next.nodes.outer).toEqual(file.nodes.outer)
    expect(next.nodes.label).toEqual(file.nodes.label)
    expect(() => run(file, { type: 'node.delete', nodeIds: ['root-1'] })).toThrow('Select an existing node')
    expect(() => run(file, { type: 'node.delete', nodeIds: ['ghost'] })).toThrow('Select an existing node')
  })

  it('updates styles partially and validates the result', () => {
    const file = fixture()
    const moved = run(file, { type: 'node.setStyles', nodeId: 'box', styles: { left: 9, rotation: 15 } })
    expect((moved.nodes.box as PrimitiveNode).styles).toEqual({ left: 9, top: 7, width: 10, height: 10, rotation: 15 })
    const unrotated = run(moved, { type: 'node.setStyles', nodeId: 'box', styles: { rotation: undefined } as unknown as Partial<PrimitiveStyles> })
    expect((unrotated.nodes.box as PrimitiveNode).styles).toEqual({ left: 9, top: 7, width: 10, height: 10 })
    const visible = run(file, { type: 'node.setStyles', nodeId: 'outer', styles: { overflow: 'visible' } })
    expect((visible.nodes.outer as PrimitiveNode).styles.overflow).toBe('visible')
    expect(() => run(file, { type: 'node.setStyles', nodeId: 'box', styles: { width: -1 } })).toThrow('Invalid node geometry')
    expect(() => run(file, { type: 'node.setStyles', nodeId: 'box', styles: { overflow: 'clip' } })).toThrow('Invalid node geometry')
    expect(() => run(file, { type: 'node.setStyles', nodeId: 'box', styles: { left: Number.NaN } })).toThrow('Invalid node geometry')
    expect(() => run(file, { type: 'node.setStyles', nodeId: 'root-1', styles: { left: 1 } })).toThrow('Select a design node')
  })

  it('sets text only on text nodes', () => {
    const file = fixture()
    expect((run(file, { type: 'node.setText', nodeId: 'label', text: 'Bye' }).nodes.label as PrimitiveNode).text).toBe('Bye')
    expect(() => run(file, { type: 'node.setText', nodeId: 'box', text: 'Bye' })).toThrow('Only text nodes carry text')
    expect(() => run(file, { type: 'node.setText', nodeId: 'label', text: 'x'.repeat(10_001) })).toThrow('Invalid node text')
  })

  it('renames primitives and rejects blank names', () => {
    const file = fixture()
    expect((run(file, { type: 'node.rename', nodeId: 'box', name: 'Badge' }).nodes.box as PrimitiveNode).name).toBe('Badge')
    expect(() => run(file, { type: 'node.rename', nodeId: 'box', name: ' ' })).toThrow('Invalid node name')
  })

  const stops = (count: number, duplicate = false) => Array.from({ length: count }, (_, index) => ({ id: duplicate ? 'same' : `s${index}`, position: index / Math.max(1, count - 1), color: lit('#000000') }))
  const linear = (id: string, list: ReturnType<typeof stops>): Paint => ({ id, type: 'gradient', shape: 'linear', angle: 45, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: list })
  it('accepts up to 16 fills and gradients with 2 to 16 unique stops', () => {
    const file = fixture()
    const sixteen = run(file, { type: 'node.fill.replace', nodeId: 'box', fills: Array.from({ length: 16 }, (_, index) => solid(`f${index}`, '#ffffff')) })
    expect(appearanceOf(sixteen, 'box')!.fills).toHaveLength(16)
    const wide = run(file, { type: 'node.fill.replace', nodeId: 'box', fills: [linear('g', stops(16))] })
    expect(appearanceOf(wide, 'box')!.fills![0]).toMatchObject({ type: 'gradient', angle: 45 })
    const narrow = run(file, { type: 'node.fill.replace', nodeId: 'box', fills: [linear('g', stops(2))] })
    expect(appearanceOf(narrow, 'box')).toEqual({ fills: [linear('g', stops(2))] })
  })

  it.each([
    ['seventeen fills', Array.from({ length: 17 }, (_, index) => solid(`f${index}`, '#ffffff')), 'Invalid fills'],
    ['a gradient with one stop', [linear('g', stops(1))], 'A gradient needs between 2 and 16 stops'],
    ['a gradient with seventeen stops', [linear('g', stops(17))], 'A gradient needs between 2 and 16 stops'],
    ['a gradient with duplicate stop ids', [linear('g', stops(2, true))], 'Gradient stops need unique identities'],
    ['a stop position above 1', [linear('g', [{ id: 'a', position: 0, color: lit('#000000') }, { id: 'b', position: 1.5, color: lit('#000000') }])], 'Invalid gradient stop'],
    ['a malformed literal', [{ id: 'f', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: 'red' } } }], 'Invalid fill color'],
    ['a non-boolean visibility', [{ ...solid('f', '#ffffff'), visible: 'no' }], 'Invalid fill visibility'],
    ['duplicate fill ids', [solid('f', '#ffffff'), solid('f', '#000000')], 'Fills need unique identities'],
    ['a version 2 linear gradient', [{ type: 'linear-gradient', angle: 45, stops: stops(2) }], 'Invalid fill identity'],
    ['a fill referencing a missing token', [tokenPaint('f', 'ghost')], 'A fill references a missing token'],
  ] as [string, Paint[], string][])('rejects replacing fills with %s and leaves the input unchanged', (_label, fills, message) => {
    const file = fixture()
    const before = structuredClone(file)
    expect(thrown(() => run(file, { type: 'node.fill.replace', nodeId: 'box', fills }))).toBe(message)
    expect(file).toEqual(before)
  })
})

describe('appearance commands', () => {
  const brandFill = tokenPaint('box:fill:1', 'brand')
  const black = stroke(lit('#000000'))
  const red = stroke(lit('#ff0000'), 3)
  const three = () => run(fixture(), { type: 'node.fill.replace', nodeId: 'box', fills: [solid('a', '#aaaaaa'), solid('b', '#bbbbbb'), solid('c', '#cccccc')] })
  const fillIds = (file: FileDocument, nodeId = 'box') => appearanceOf(file, nodeId)?.fills?.map(paint => paint.id)
  const hasAppearance = (file: FileDocument, nodeId: string) => 'appearance' in file.nodes[nodeId]!
  const rejects = (file: FileDocument, command: FileCommand, message: string) => {
    const before = structuredClone(file)
    expect(thrown(() => run(file, command))).toBe(message)
    expect(file).toEqual(before)
  }

  it('replaces the whole record, dropping node-level defaults, and clears it with null', () => {
    const file = fixture()
    const fourSides = { top: black, bottom: black, left: black, right: black }
    const next = run(file, { type: 'node.setAppearance', nodeId: 'box', appearance: { visible: true, opacity: 1, blendMode: 'normal', fills: [solid('a', '#123456')], borders: fourSides } as unknown as Appearance })
    // Four equal sides are the state before the user combines them, so they stay four sides (negative control for any collapse).
    expect(appearanceOf(next, 'box')).toStrictEqual({ fills: [solid('a', '#123456')], borders: fourSides })
    expect(next.revision).toBe(1)
    const cleared = run(next, { type: 'node.setAppearance', nodeId: 'box', appearance: null })
    expect(hasAppearance(cleared, 'box')).toBe(false)
    expect(hasAppearance(run(file, { type: 'node.setAppearance', nodeId: 'box', appearance: { opacity: 1 } }), 'box')).toBe(false)
    expect(appearanceOf(run(file, { type: 'node.setAppearance', nodeId: 'box', appearance: { opacity: 0.25 } }), 'box')).toStrictEqual({ opacity: 0.25 })
  })

  it.each([
    ['an unknown key', 'box', { shadow: 1 }, 'Unsupported appearance field'],
    ['a stored normal fill blend mode', 'box', { fills: [{ ...solid('a', '#000000'), blendMode: 'normal' }] }, 'Invalid fill blend mode'],
    ['an opacity above 1', 'box', { opacity: 2 }, 'Invalid node opacity'],
    ['an outline on text', 'label', { outline: { ...black, offset: 0 } }, 'This node has no outline'],
    ['a value that is not a record', 'box', 'red', 'Invalid appearance'],
    ['a page root', 'root-1', { opacity: 0.5 }, 'Select a design node'],
  ])('rejects setAppearance with %s', (_label, nodeId, appearance, message) => {
    rejects(fixture(), { type: 'node.setAppearance', nodeId, appearance: appearance as Appearance }, message)
  })

  it('patches blending fields independently and removes defaults', () => {
    let file = run(fixture(), { type: 'node.setBlending', nodeId: 'box', opacity: 0.5 })
    expect(appearanceOf(file, 'box')).toStrictEqual({ opacity: 0.5, fills: [brandFill] })
    file = run(file, { type: 'node.setBlending', nodeId: 'box', blendMode: 'multiply' })
    expect(appearanceOf(file, 'box')).toStrictEqual({ opacity: 0.5, blendMode: 'multiply', fills: [brandFill] })
    file = run(file, { type: 'node.setBlending', nodeId: 'box', visible: false })
    expect(appearanceOf(file, 'box')).toStrictEqual({ visible: false, opacity: 0.5, blendMode: 'multiply', fills: [brandFill] })
    file = run(file, { type: 'node.setBlending', nodeId: 'box', visible: true, opacity: 1, blendMode: 'normal' })
    expect(appearanceOf(file, 'box')).toStrictEqual({ fills: [brandFill] })
    expect(hasAppearance(run(fixture(), { type: 'node.setBlending', nodeId: 'outer', opacity: 1 }), 'outer')).toBe(false)
    expect(appearanceOf(run(fixture(), { type: 'node.setBlending', nodeId: 'outer', opacity: 0 }), 'outer')).toStrictEqual({ opacity: 0 })
  })

  it.each([
    ['an opacity above 1', { opacity: 2 }, 'Invalid node opacity'],
    ['a NaN opacity', { opacity: Number.NaN }, 'Invalid node opacity'],
    ['an unknown blend mode', { blendMode: 'add' }, 'Invalid node blend mode'],
    ['a non-boolean visibility', { visible: 'no' }, 'Invalid visibility'],
  ])('rejects setBlending with %s', (_label, patch, message) => {
    rejects(fixture(), { type: 'node.setBlending', nodeId: 'box', ...patch } as FileCommand, message)
  })

  it('adds a topmost fill seeded per node kind, or the given paint', () => {
    expect(appearanceOf(run(fixture(), { type: 'node.fill.add', nodeId: 'box' }), 'box')).toStrictEqual({ fills: [brandFill, { id: 'fill:1:2', type: 'solid', color: lit('#dddddd') }] })
    expect(appearanceOf(run(fixture(), { type: 'node.fill.add', nodeId: 'outer' }), 'outer')).toStrictEqual({ fills: [{ id: 'fill:1:1', type: 'solid', color: lit('#ffffff') }] })
    expect(appearanceOf(run(fixture(), { type: 'node.fill.add', nodeId: 'label' }), 'label')).toStrictEqual({ fills: [{ id: 'fill:1:1', type: 'solid', color: lit('#dddddd') }] })
    const ramp = gradient('g', 45, [['a', 0, lit('#000000')], ['b', 1, tok('brand')]])
    const explicit = run(fixture(), { type: 'node.fill.add', nodeId: 'box', paint: ramp })
    expect(appearanceOf(explicit, 'box')).toStrictEqual({ fills: [brandFill, ramp] })
  })

  it.each([
    ['a duplicate fill id', 'box', { paint: solid('box:fill:1', '#000000') }, 'Fills need unique identities'],
    ['a missing token', 'box', { paint: tokenPaint('f', 'ghost') }, 'A fill references a missing token'],
    ['a missing image asset', 'box', { paint: { id: 'f', type: 'image', assetId: 'img', fit: 'cover' } }, 'An image fill references a missing asset'],
    ['a stored normal blend mode', 'box', { paint: { ...solid('f', '#000000'), blendMode: 'normal' } }, 'Invalid fill blend mode'],
    ['a page root', 'root-1', {}, 'Select a design node'],
  ])('rejects adding a fill with %s', (_label, nodeId, extra, message) => {
    rejects(fixture(), { type: 'node.fill.add', nodeId, ...extra } as FileCommand, message)
  })

  it('refuses a seventeenth fill', () => {
    const full = run(fixture(), { type: 'node.fill.replace', nodeId: 'box', fills: Array.from({ length: 16 }, (_, index) => solid(`f${index}`, '#ffffff')) })
    rejects(full, { type: 'node.fill.add', nodeId: 'box' }, 'Invalid fills')
  })

  it('updates a fill in place and keeps its identity', () => {
    const next = run(three(), { type: 'node.fill.update', nodeId: 'box', fillId: 'b', paint: { ...solid('b', '#00ff00'), blendMode: 'screen' } })
    expect(appearanceOf(next, 'box')).toStrictEqual({ fills: [solid('a', '#aaaaaa'), { ...solid('b', '#00ff00'), blendMode: 'screen' }, solid('c', '#cccccc')] })
    rejects(three(), { type: 'node.fill.update', nodeId: 'box', fillId: 'ghost', paint: solid('ghost', '#000000') }, 'Select an existing fill')
    rejects(three(), { type: 'node.fill.update', nodeId: 'box', fillId: 'b', paint: solid('other', '#000000') }, 'A fill keeps its identity')
  })

  it('moves a fill to an index and rejects positions out of range', () => {
    expect(fillIds(run(three(), { type: 'node.fill.move', nodeId: 'box', fillId: 'a', index: 2 }))).toEqual(['b', 'c', 'a'])
    expect(fillIds(run(three(), { type: 'node.fill.move', nodeId: 'box', fillId: 'c', index: 0 }))).toEqual(['c', 'a', 'b'])
    for (const index of [3, -1, 0.5]) rejects(three(), { type: 'node.fill.move', nodeId: 'box', fillId: 'a', index }, 'Invalid fill position')
    rejects(three(), { type: 'node.fill.move', nodeId: 'box', fillId: 'ghost', index: 0 }, 'Invalid fill position')
  })

  it('removes fills and clears the section with the last one', () => {
    expect(fillIds(run(three(), { type: 'node.fill.remove', nodeId: 'box', fillId: 'b' }))).toEqual(['a', 'c'])
    expect(hasAppearance(run(fixture(), { type: 'node.fill.remove', nodeId: 'box', fillId: 'box:fill:1' }), 'box')).toBe(false)
    const faded = run(fixture(), { type: 'node.setBlending', nodeId: 'box', opacity: 0.5 })
    expect(appearanceOf(run(faded, { type: 'node.fill.remove', nodeId: 'box', fillId: 'box:fill:1' }), 'box')).toStrictEqual({ opacity: 0.5 })
    expect(hasAppearance(run(fixture(), { type: 'node.fill.replace', nodeId: 'box', fills: [] }), 'box')).toBe(false)
    rejects(three(), { type: 'node.fill.remove', nodeId: 'box', fillId: 'ghost' }, 'Select an existing fill')
    rejects(fixture(), { type: 'node.fill.remove', nodeId: 'outer', fillId: 'ghost' }, 'Select an existing fill')
  })

  it('sets and clears an outline, refusing text', () => {
    const outline = { ...stroke(tok('brand'), 2), offset: 4 }
    const set = run(fixture(), { type: 'node.outline.set', nodeId: 'box', outline })
    expect(appearanceOf(set, 'box')).toStrictEqual({ fills: [brandFill], outline })
    expect(appearanceOf(run(set, { type: 'node.outline.set', nodeId: 'box', outline: null }), 'box')).toStrictEqual({ fills: [brandFill] })
    rejects(fixture(), { type: 'node.outline.set', nodeId: 'label', outline }, 'This node has no outline')
    rejects(fixture(), { type: 'node.outline.set', nodeId: 'box', outline: black as never }, 'Invalid outline offset')
    rejects(fixture(), { type: 'node.outline.set', nodeId: 'box', outline: { ...outline, visible: true } as never }, 'Invalid outline visibility')
  })

  it('sets borders as given and refuses empty borders and text', () => {
    const fourSides = { top: black, bottom: black, left: black, right: black }
    expect(appearanceOf(run(fixture(), { type: 'node.borders.set', nodeId: 'outer', borders: fourSides }), 'outer')).toStrictEqual({ borders: fourSides })
    expect(appearanceOf(run(fixture(), { type: 'node.borders.set', nodeId: 'outer', borders: { all: black } }), 'outer')).toStrictEqual({ borders: { all: black } })
    const sides = run(fixture(), { type: 'node.borders.set', nodeId: 'outer', borders: { top: black, right: red } })
    expect(appearanceOf(sides, 'outer')).toStrictEqual({ borders: { top: black, right: red } })
    expect(hasAppearance(run(sides, { type: 'node.borders.set', nodeId: 'outer', borders: null }), 'outer')).toBe(false)
    rejects(fixture(), { type: 'node.borders.set', nodeId: 'outer', borders: {} }, 'Borders need at least one side')
    rejects(fixture(), { type: 'node.borders.set', nodeId: 'label', borders: { top: black } }, 'This node has no borders')
  })

  it('splits an all border into sides when one side is updated', () => {
    const all = run(fixture(), { type: 'node.borders.set', nodeId: 'outer', borders: { all: black } })
    expect(appearanceOf(run(all, { type: 'node.border.update', nodeId: 'outer', side: 'left', stroke: red }), 'outer')).toStrictEqual({ borders: { top: black, bottom: black, left: red, right: black } })
    expect(appearanceOf(run(all, { type: 'node.border.update', nodeId: 'outer', side: 'left', stroke: black }), 'outer')).toStrictEqual({ borders: { top: black, bottom: black, left: black, right: black } })
    expect(appearanceOf(run(all, { type: 'node.border.update', nodeId: 'outer', side: 'all', stroke: red }), 'outer')).toStrictEqual({ borders: { all: red } })
    expect(appearanceOf(run(fixture(), { type: 'node.border.update', nodeId: 'outer', side: 'top', stroke: red }), 'outer')).toStrictEqual({ borders: { top: red } })
    rejects(all, { type: 'node.border.update', nodeId: 'outer', side: 'top', stroke: stroke(lit('#000000'), -1) }, 'Invalid border')
    rejects(fixture(), { type: 'node.border.update', nodeId: 'label', side: 'top', stroke: red }, 'This node has no borders')
  })

  it('removes border sides and clears the section with the last one', () => {
    const sides = run(fixture(), { type: 'node.borders.set', nodeId: 'box', borders: { top: black, left: red } })
    const left = run(sides, { type: 'node.border.remove', nodeId: 'box', side: 'top' })
    expect(appearanceOf(left, 'box')).toStrictEqual({ fills: [brandFill], borders: { left: red } })
    expect(appearanceOf(run(left, { type: 'node.border.remove', nodeId: 'box', side: 'left' }), 'box')).toStrictEqual({ fills: [brandFill] })
    expect(appearanceOf(run(sides, { type: 'node.border.remove', nodeId: 'box', side: 'all' }), 'box')).toStrictEqual({ fills: [brandFill] })
    const only = run(fixture(), { type: 'node.borders.set', nodeId: 'outer', borders: { bottom: black } })
    expect(hasAppearance(run(only, { type: 'node.border.remove', nodeId: 'outer', side: 'bottom' }), 'outer')).toBe(false)
    rejects(sides, { type: 'node.border.remove', nodeId: 'box', side: 'right' }, 'That side has no border')
    rejects(fixture(), { type: 'node.border.remove', nodeId: 'box', side: 'top' }, 'This node has no borders')
  })

  it('adds assets, refuses duplicates and malformed images, and removes only unreferenced assets', () => {
    const stocked = run(fixture(), { type: 'asset.add', asset: pixel() })
    expect(stocked.assets).toEqual({ img: pixel() })
    rejects(stocked, { type: 'asset.add', asset: pixel() }, 'Asset identity already exists')
    rejects(fixture(), { type: 'asset.add', asset: { ...pixel(), mime: 'image/svg+xml' as never } }, 'Unsupported image type')
    const shown = run(stocked, { type: 'node.fill.add', nodeId: 'box', paint: { id: 'photo', type: 'image', assetId: 'img', fit: 'cover' } })
    expect(validateFileDocument(shown, atoms)).toEqual(shown)
    rejects(shown, { type: 'asset.remove', assetId: 'img' }, 'That image is still used by a fill')
    const cached = run(stocked, { type: 'node.fill.replace', nodeId: 'box', fills: [{ ...solid('s', '#000000'), cache: { image: { assetId: 'img', fit: 'cover' } } }] })
    rejects(cached, { type: 'asset.remove', assetId: 'img' }, 'That image is still used by a fill')
    const two = run(shown, { type: 'asset.add', asset: pixel('spare') })
    expect(run(two, { type: 'asset.remove', assetId: 'spare' }).assets).toEqual({ img: pixel() })
    expect('assets' in run(stocked, { type: 'asset.remove', assetId: 'img' })).toBe(false)
    rejects(fixture(), { type: 'asset.remove', assetId: 'img' }, 'Select an existing image')
  })

  it('duplicates a node with its full appearance', () => {
    const appearance: Appearance = { opacity: 0.5, fills: [brandFill], outline: { ...red, offset: 1 }, borders: { top: black } }
    const styled = run(fixture(), { type: 'node.setAppearance', nodeId: 'box', appearance })
    const copy = run(styled, { type: 'node.duplicate', nodeId: 'box', ids: { box: 'box-2' } })
    expect(appearanceOf(copy, 'box-2')).toStrictEqual(appearance)
    expect(appearanceOf(copy, 'box')).toStrictEqual(appearance)
  })

  it('accepts and edits appearance on component instances, validated as kind component', () => {
    const appearance: Appearance = { opacity: 0.5, outline: { ...black, offset: 2 }, borders: { all: red } }
    let file = run(createBlankFile('file-1', 'page-1', 'root-1'), { type: 'node.insert', node: { ...cardNode('card'), appearance }, placement: { parentId: 'root-1' } })
    expect(appearanceOf(file, 'card')).toStrictEqual(appearance)
    file = run(file, { type: 'node.fill.add', nodeId: 'card' })
    expect(appearanceOf(file, 'card')!.fills).toStrictEqual([{ id: 'fill:2:1', type: 'solid', color: lit('#dddddd') }])
    file = run(file, { type: 'node.setBlending', nodeId: 'card', blendMode: 'screen' })
    expect(appearanceOf(file, 'card')).toMatchObject({ opacity: 0.5, blendMode: 'screen' })
    expect(thrown(() => run(createBlankFile('file-1', 'page-1', 'root-1'), { type: 'node.insert', node: { ...cardNode('card'), appearance: { visible: true } as never }, placement: { parentId: 'root-1' } }))).toBe('Invalid node visibility')
  })
})

describe('component nodes', () => {
  const withCard = () => {
    let file = createBlankFile('file-1', 'page-1', 'root-1')
    file = run(file, { type: 'node.insert', node: frame('frame', 0, 0), placement: { parentId: 'root-1' } })
    file = run(file, { type: 'node.insert', node: cardNode('card'), placement: { parentId: 'root-1' } })
    return run(file, { type: 'node.insert', node: buttonNode('btn', { children: 'Save' }), placement: { parentId: 'card', slot: 'children' } })
  }

  it('inserts a card under the root and a button into its children slot', () => {
    const file = withCard()
    expect(file.relationships.btn).toEqual({ parentId: 'card', orderKey: 'V', slot: 'children' })
    expect(childrenOf(file, 'card', 'children')).toEqual(['btn'])
    expect(childrenOf(file, 'card', 'heading')).toEqual([])
    expect(legacyPageDocument(file, 'page-1').nodes.card!.children).toEqual({ children: ['btn'] })
  })

  it('accepts a button directly under the root', () => {
    const file = run(withCard(), { type: 'node.insert', node: buttonNode('solo'), placement: { parentId: 'root-1' } })
    expect(childrenOf(file, 'root-1')).toEqual(['frame', 'card', 'solo'])
  })

  it.each([
    ['without a slot', { parentId: 'card' }],
    ['in an unknown slot', { parentId: 'card', slot: 'footer' }],
    ['under a frame', { parentId: 'frame' }],
    ['under a button', { parentId: 'btn', slot: 'children' }],
  ])('rejects a button placed %s', (_label, placement) => {
    expect(() => run(withCard(), { type: 'node.insert', node: buttonNode('extra'), placement })).toThrow('That node cannot be placed there')
  })

  it('rejects a primitive inside a component slot', () => {
    expect(() => run(withCard(), { type: 'node.insert', node: rect('r', 0, 0), placement: { parentId: 'card', slot: 'children' } })).toThrow('That node cannot be placed there')
  })

  it('sets and removes props with prop validation', () => {
    const file = withCard()
    const primary = run(file, { type: 'node.setProps', nodeId: 'btn', props: { variant: 'primary' } })
    expect((primary.nodes.btn as ComponentNode).props).toEqual({ children: 'Save', variant: 'primary' })
    const removed = run(primary, { type: 'node.setProps', nodeId: 'btn', props: {}, remove: ['variant'] })
    expect((removed.nodes.btn as ComponentNode).props).toEqual({ children: 'Save' })
    expect(() => run(file, { type: 'node.setProps', nodeId: 'btn', props: { variant: 'loud' } })).toThrow('Unsupported value for Button.variant')
    expect(() => run(file, { type: 'node.setProps', nodeId: 'btn', props: { onClick: 'x' } })).toThrow('Unsupported prop onClick')
    expect(() => run(file, { type: 'node.setProps', nodeId: 'card', props: { children: 'Text' } })).toThrow('Slot children already contains components')
    expect(() => run(file, { type: 'node.setProps', nodeId: 'frame', props: {} })).toThrow('Select a component instance')
  })

  it('sets component layout and validates it', () => {
    const layout: NodeLayout = {
      item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 24 } }, width: { value: { kind: 'px', value: 300 } } },
      container: { display: 'flex', gap: 8, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } },
      spacing: { padding: 4 },
    }
    const file = run(withCard(), { type: 'node.setLayout', nodeId: 'card', layout })
    expect((file.nodes.card as ComponentNode).layout).toStrictEqual({
      item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 24 } }, width: { value: { kind: 'px', value: 300 } } },
      container: { display: 'flex', gap: 8, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } },
      spacing: { padding: 4 },
    })
    expect((file.nodes.card as ComponentNode).layout).not.toBe(layout)
    expect(legacyPageDocument(file, 'page-1').nodes.card!.layout).toEqual({ mode: 'absolute', x: 12, y: 24, width: 300 })
    // A zero px width is a valid fixed size in v4 (positive control for the percent bound below).
    const zero = run(file, { type: 'node.setLayout', nodeId: 'card', layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'px', value: 0 } } } } })
    expect((zero.nodes.card as ComponentNode).layout).toStrictEqual({ item: { position: { mode: 'flow' }, width: { value: { kind: 'px', value: 0 } } } })
    const fill = run(file, { type: 'node.setLayout', nodeId: 'card', layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 100 } } } } })
    expect((fill.nodes.card as ComponentNode).layout).toStrictEqual({ item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 100 } } } })
    const rejected: [unknown, string][] = [
      [{ item: { position: { mode: 'flow', left: { kind: 'px', value: 1 } } } }, 'Invalid component layout'],
      [{ item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 150 } } } }, 'Invalid component layout'],
      [{ mode: 'absolute', x: 0, y: 0, width: 10 }, 'Unsupported node layout field'],
      [{ item: { position: { mode: 'flow' } }, grow: 1 }, 'Unsupported node layout field'],
      [{ item: { position: { mode: 'flow' }, colour: 'red' } }, 'Unsupported layout item field'],
    ]
    for (const [bad, message] of rejected) {
      const before = structuredClone(file)
      expect(thrown(() => run(file, { type: 'node.setLayout', nodeId: 'card', layout: bad as NodeLayout }))).toBe(message)
      expect(file).toEqual(before)
    }
  })
})

describe('page commands', () => {
  it('creates, renames, reorders, and deletes pages', () => {
    let file = fixture()
    file = run(file, { type: 'page.create', page: { id: 'page-0', name: 'Cover', rootNodeId: 'root-0' }, index: 0 })
    expect(file.pages.map(page => page.id)).toEqual(['page-0', 'page-1'])
    expect(file.nodes['root-0']).toEqual({ id: 'root-0', type: 'root' })
    file = run(file, { type: 'page.rename', pageId: 'page-0', name: 'Title' })
    expect(file.pages[0]).toEqual({ id: 'page-0', name: 'Title', rootNodeId: 'root-0' })
    file = run(file, { type: 'page.reorder', pageId: 'page-0', index: 1 })
    expect(file.pages.map(page => page.id)).toEqual(['page-1', 'page-0'])
    file = run(file, { type: 'page.delete', pageId: 'page-1' })
    expect(file.pages.map(page => page.id)).toEqual(['page-0'])
    expect(Object.keys(file.nodes)).toEqual(['root-0'])
    expect(file.relationships).toEqual({})
    expect(file.theme.tokens.brand).toEqual(literalToken('brand', 'V', '#3366cc', 'Brand'))
    expect(file.revision).toBe(4)
  })

  it('keeps at least one page and rejects bad page commands', () => {
    const file = fixture()
    expect(() => run(file, { type: 'page.delete', pageId: 'page-1' })).toThrow('A file keeps at least one page')
    expect(() => run(file, { type: 'page.create', page: { id: 'page-1', name: 'Again', rootNodeId: 'root-9' } })).toThrow('Invalid page')
    expect(() => run(file, { type: 'page.create', page: { id: 'page-9', name: 'Again', rootNodeId: 'outer' } })).toThrow('Invalid page')
    expect(() => run(file, { type: 'page.rename', pageId: 'page-1', name: '' })).toThrow('Invalid page name')
    expect(() => run(file, { type: 'page.reorder', pageId: 'page-1', index: 1 })).toThrow('Invalid page position')
  })

  it('duplicates a page with every relationship rewritten to the new ids and the new root', () => {
    const file = fixture()
    const next = run(file, { type: 'page.duplicate', pageId: 'page-1', page: { id: 'page-2', name: 'Page 1 copy', rootNodeId: 'root-2' }, ids: { outer: 'outer-2', inner: 'inner-2', box: 'box-2', label: 'label-2' } })
    expect(next.pages).toEqual([{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Page 1 copy', rootNodeId: 'root-2' }])
    expect(next.relationships['outer-2']).toEqual({ parentId: 'root-2', orderKey: 'V' })
    expect(next.relationships['inner-2']).toEqual({ parentId: 'outer-2', orderKey: 'V' })
    expect(next.relationships['box-2']).toEqual({ parentId: 'inner-2', orderKey: 'V' })
    expect(next.relationships['label-2']).toEqual({ parentId: 'root-2', orderKey: 'W' })
    expect(pageNodes(next, 'page-2')).toEqual(['outer-2', 'inner-2', 'box-2', 'label-2'])
    expect(pageNodes(next, 'page-1')).toEqual(['outer', 'inner', 'box', 'label'])
    expect(appearanceOf(next, 'box-2')).toEqual({ fills: [tokenPaint('box:fill:1', 'brand')] })
    expect(Object.keys(next.theme.tokens)).toEqual(['brand'])
    expect(() => run(file, { type: 'page.duplicate', pageId: 'page-1', page: { id: 'page-2', name: 'Copy', rootNodeId: 'root-2' }, ids: { outer: 'outer-2' } })).toThrow('Provide a new identity for every copied node')
  })
})

describe('token commands', () => {
  /** Two pages: page-1 holds a solid brand fill and a gradient whose first stop uses brand; page-2 uses accent (alias of brand). */
  const themed = (): FileDocument => {
    const file = fixture()
    file.theme.tokens = {
      brand: { id: 'brand', type: 'color', name: 'Brand', orderKey: 'V', value: { kind: 'source', property: '--brand', fallback: hex('#112233') } },
      accent: aliasToken('accent', 'W', 'brand'),
      ink: literalToken('ink', 'X', '#202124'),
    }
    file.nodes.shader = { id: 'shader', type: 'shader', name: 'Shader', styles: { left: 0, top: 0, width: 40, height: 40 }, appearance: { fills: [gradient('shader:fill:1', 135, [['a', 0, tok('brand')], ['b', 1, tok('ink')]])] } }
    file.relationships.shader = { parentId: 'root-1', orderKey: 'X' }
    file.pages.push({ id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' })
    file.nodes['root-2'] = { id: 'root-2', type: 'root' }
    file.nodes.chip = rect('chip', 0, 0, [tokenPaint('chip:fill:1', 'accent')])
    file.relationships.chip = { parentId: 'root-2', orderKey: 'V' }
    return validateFileDocument(file, atoms)
  }

  it('creates a token', () => {
    const file = run(fixture(), { type: 'token.create', token: literalToken('ink', 'W', '#202124') })
    expect(file.theme.tokens.ink).toEqual(literalToken('ink', 'W', '#202124'))
    expect(() => run(file, { type: 'token.create', token: literalToken('ink', 'X', '#000000') })).toThrow('Token identity is invalid')
  })

  it('renames a token while fills keep pointing at its id', () => {
    const file = run(themed(), { type: 'token.rename', tokenId: 'brand', name: 'Primary' })
    expect(file.theme.tokens.brand!.name).toBe('Primary')
    expect(appearanceOf(file, 'box')).toEqual({ fills: [tokenPaint('box:fill:1', 'brand')] })
    expect(resolveColorValue(file.theme, tok('brand'))).toEqual(hex('#112233'))
    expect(() => run(file, { type: 'token.rename', tokenId: 'brand', name: '  ' })).toThrow('Invalid token name')
  })

  it('sets literal, alias, and source values', () => {
    let file = themed()
    file = run(file, { type: 'token.setValue', tokenId: 'ink', value: { kind: 'literal', color: { kind: 'oklch', l: 0.5, c: 0.1, h: 200 } } })
    expect(file.theme.tokens.ink!.value).toEqual({ kind: 'literal', color: { kind: 'oklch', l: 0.5, c: 0.1, h: 200 } })
    file = run(file, { type: 'token.setValue', tokenId: 'accent', value: { kind: 'alias', tokenId: 'ink' } })
    expect(resolveToken(file.theme, 'accent')).toEqual({ kind: 'oklch', l: 0.5, c: 0.1, h: 200 })
    file = run(file, { type: 'token.setValue', tokenId: 'ink', value: { kind: 'source', property: '--ink', fallback: hex('#000000') } })
    expect(resolveToken(file.theme, 'accent', { '--ink': hex('#eeeeee') })).toEqual(hex('#eeeeee'))
    expect(() => run(file, { type: 'token.setValue', tokenId: 'ink', value: { kind: 'source', property: 'ink', fallback: hex('#000000') } })).toThrow('Invalid token value')
    expect(() => run(file, { type: 'token.setValue', tokenId: 'ink', value: { kind: 'alias', tokenId: 'ghost' } })).toThrow('Token alias target is missing')
  })

  it('rejects self and transitive alias cycles', () => {
    const file = themed()
    expect(() => run(file, { type: 'token.setValue', tokenId: 'ink', value: { kind: 'alias', tokenId: 'ink' } })).toThrow('Token aliases cannot form a cycle')
    // accent -> brand already; brand -> accent would close the loop.
    expect(() => run(file, { type: 'token.setValue', tokenId: 'brand', value: { kind: 'alias', tokenId: 'accent' } })).toThrow('Token aliases cannot form a cycle')
    const chained = run(file, { type: 'token.setValue', tokenId: 'ink', value: { kind: 'alias', tokenId: 'accent' } })
    expect(() => run(chained, { type: 'token.setValue', tokenId: 'brand', value: { kind: 'alias', tokenId: 'ink' } })).toThrow('Token aliases cannot form a cycle')
  })

  it('reorders tokens by order key', () => {
    const file = run(themed(), { type: 'token.reorder', tokenId: 'ink', index: 0 })
    expect(file.theme.tokens.ink!.orderKey).toBe('F')
    expect(file.theme.tokens.brand!.orderKey).toBe('V')
    expect(() => run(file, { type: 'token.reorder', tokenId: 'ink', index: 3 })).toThrow('Invalid position')
  })

  it('duplicates a token right after its source', () => {
    const file = run(themed(), { type: 'token.duplicate', tokenId: 'brand', newId: 'brand-2', name: 'Brand copy' })
    expect(file.theme.tokens['brand-2']).toEqual({ id: 'brand-2', type: 'color', name: 'Brand copy', orderKey: 'VV', value: { kind: 'source', property: '--brand', fallback: hex('#112233') } })
    const last = run(themed(), { type: 'token.duplicate', tokenId: 'ink', newId: 'ink-2', name: 'Ink copy' })
    expect(last.theme.tokens['ink-2']!.orderKey).toBe('Y')
    expect(() => run(file, { type: 'token.duplicate', tokenId: 'brand', newId: 'accent', name: 'x' })).toThrow('Token identity is invalid')
  })

  /**
   * outer: an ink solid caching a brand solid and a brand to accent gradient, a brand outline, a brand top border and an
   * ink left border. inner: brand borders on every side.
   */
  const styledTheme = (): FileDocument => {
    const file = themed()
    ;(file.nodes.outer as PrimitiveNode).appearance = {
      fills: [{ ...tokenPaint('o', 'ink'), cache: { solid: { color: tok('brand') }, gradient: { shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: [{ id: 'c1', position: 0, color: tok('brand') }, { id: 'c2', position: 1, color: tok('accent') }] } } }],
      outline: { ...stroke(tok('brand')), offset: 0 },
      borders: { top: stroke(tok('brand')), left: stroke(tok('ink')) },
    }
    ;(file.nodes.inner as PrimitiveNode).appearance = { borders: { all: stroke(tok('brand'), 2) } }
    return validateFileDocument(file, atoms)
  }

  it('counts paint, stop, and alias references', () => {
    expect(tokenReferences(themed(), 'brand')).toEqual([{ nodeId: 'box' }, { nodeId: 'shader' }, { aliasTokenId: 'accent' }])
    expect(tokenReferences(themed(), 'accent')).toEqual([{ nodeId: 'chip' }])
    expect(tokenReferences(themed(), 'ghost')).toEqual([])
  })

  it('counts outline, border, and cached references once per bound color', () => {
    const file = styledTheme()
    // outer: cached solid, cached stop, outline, top border (4); inner: the all border (1).
    expect(tokenReferences(file, 'brand')).toEqual([{ nodeId: 'outer' }, { nodeId: 'outer' }, { nodeId: 'outer' }, { nodeId: 'outer' }, { nodeId: 'inner' }, { nodeId: 'box' }, { nodeId: 'shader' }, { aliasTokenId: 'accent' }])
    expect(tokenReferences(file, 'accent')).toEqual([{ nodeId: 'outer' }, { nodeId: 'chip' }])
    expect(tokenReferences(file, 'ink')).toEqual([{ nodeId: 'outer' }, { nodeId: 'outer' }, { nodeId: 'shader' }])
  })

  it('deletes a token by inlining its resolved source color into paints, stops, and aliases across pages', () => {
    const file = themed()
    const next = run(file, { type: 'token.delete', tokenIds: ['brand'], sources: { '--brand': hex('#445566') } })
    const inlined = lit('#445566')
    expect(next.theme.tokens.brand).toBeUndefined()
    expect(appearanceOf(next, 'box')).toEqual({ fills: [{ id: 'box:fill:1', type: 'solid', color: inlined }] })
    expect(appearanceOf(next, 'shader')).toEqual({ fills: [gradient('shader:fill:1', 135, [['a', 0, inlined], ['b', 1, tok('ink')]])] })
    expect(next.theme.tokens.accent!.value).toEqual(inlined)
    expect(appearanceOf(next, 'chip')).toEqual({ fills: [tokenPaint('chip:fill:1', 'accent')] })
    expect(resolveColorValue(next.theme, tok('accent'))).toEqual(hex('#445566'))
    expect(next.revision).toBe(file.revision + 1)
  })

  it('inlines a deleted token inside outlines, borders, gradient stops, and paint caches', () => {
    const next = run(styledTheme(), { type: 'token.delete', tokenIds: ['brand'], sources: { '--brand': hex('#445566') } })
    const inlined = lit('#445566')
    expect(appearanceOf(next, 'outer')).toStrictEqual({
      fills: [{ ...tokenPaint('o', 'ink'), cache: { solid: { color: inlined }, gradient: { shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: [{ id: 'c1', position: 0, color: inlined }, { id: 'c2', position: 1, color: tok('accent') }] } } }],
      outline: { ...stroke(inlined), offset: 0 },
      borders: { top: stroke(inlined), left: stroke(tok('ink')) },
    })
    expect(appearanceOf(next, 'inner')).toStrictEqual({ borders: { all: stroke(inlined, 2) } })
    expect(tokenReferences(next, 'accent')).toEqual([{ nodeId: 'outer' }, { nodeId: 'chip' }])
  })

  it('deletes a source token without a palette by inlining its fallback', () => {
    const next = run(themed(), { type: 'token.delete', tokenIds: ['brand'] })
    expect(appearanceOf(next, 'box')).toEqual({ fills: [solid('box:fill:1', '#112233')] })
  })

  it('resolves through a deleted alias target when both are deleted together', () => {
    const next = run(themed(), { type: 'token.delete', tokenIds: ['accent', 'brand'], sources: { '--brand': hex('#445566') } })
    expect(Object.keys(next.theme.tokens)).toEqual(['ink'])
    expect(appearanceOf(next, 'chip')).toEqual({ fills: [solid('chip:fill:1', '#445566')] })
    expect(appearanceOf(next, 'box')).toEqual({ fills: [solid('box:fill:1', '#445566')] })
  })

  it('updates and clears a token description', () => {
    const described = run(themed(), { type: 'token.setDescription', tokenId: 'ink', description: 'Body text' })
    expect(described.theme.tokens.ink!.description).toBe('Body text')
    const cleared = run(described, { type: 'token.setDescription', tokenId: 'ink', description: '' })
    expect('description' in cleared.theme.tokens.ink!).toBe(false)
  })
})

describe('batch commands', () => {
  it('applies every command with a single revision bump and sees earlier inner commands', () => {
    const file = createBlankFile('file-1', 'page-1', 'root-1')
    const next = run(file, { type: 'batch', commands: [
      { type: 'node.insert', node: rect('a', 0, 0), placement: { parentId: 'root-1' } },
      { type: 'node.insert', node: rect('b', 0, 0), placement: { parentId: 'root-1', index: 0 } },
      { type: 'node.insert', node: rect('c', 0, 0), placement: { parentId: 'root-1', index: 1 } },
      { type: 'node.setStyles', nodeId: 'a', styles: { left: 30 } },
    ] })
    expect(next.revision).toBe(1)
    expect(childrenOf(next, 'root-1')).toEqual(['b', 'c', 'a'])
    expect((next.nodes.a as PrimitiveNode).styles.left).toBe(30)
  })

  it('is all-or-nothing when an inner command fails', () => {
    const file = fixture()
    const before = structuredClone(file)
    expect(() => run(file, { type: 'batch', commands: [
      { type: 'node.setStyles', nodeId: 'box', styles: { left: 99 } },
      { type: 'node.insert', node: rect('d', 0, 0), placement: { parentId: 'ghost' } },
    ] })).toThrow('Select an existing node')
    expect(file).toEqual(before)
    expect(file.revision).toBe(0)
    expect(() => run(file, { type: 'batch', commands: [] })).toThrow('Invalid command batch')
  })
})

describe('token resolution and appearance projection', () => {
  const theme: FileTheme = { tokens: {
    brand: literalToken('brand', 'V', '#3366cc'),
    accent: aliasToken('accent', 'W', 'brand'),
    surface: { id: 'surface', type: 'color', name: 'surface', orderKey: 'X', value: { kind: 'source', property: '--surface', fallback: hex('#ffffff') } },
  } }
  const project = (appearance: Appearance, source: FileTheme = theme, sources = {}) => projectAppearance(appearance, value => resolveColorValue(source, value, sources), () => true)

  it('resolves literals, aliases, and source tokens with and without a palette', () => {
    expect(resolveToken(theme, 'accent')).toEqual(hex('#3366cc'))
    expect(resolveToken(theme, 'surface')).toEqual(hex('#ffffff'))
    expect(resolveToken(theme, 'surface', { '--surface': hex('#242427') })).toEqual(hex('#242427'))
    expect(resolveToken(theme, 'ghost')).toBeNull()
  })

  it('terminates on a malformed cyclic theme and drops only the unresolvable fill', () => {
    const cyclic = { tokens: { a: aliasToken('a', 'V', 'b'), b: aliasToken('b', 'W', 'a') } } as FileTheme
    expect(resolveToken(cyclic, 'a')).toBeNull()
    expect(resolveColorValue(cyclic, tok('a'))).toBeNull()
    expect(project({ fills: [tokenPaint('x', 'a'), solid('y', '#010203')] }, cyclic)).toEqual({ fills: [{ type: 'solid', color: '#010203' }] })
  })

  it('projects solid literal and token paints as structured fills', () => {
    expect(project({ fills: [solid('a', '#ABCDEF'), tokenPaint('b', 'accent'), { id: 'c', type: 'solid', color: { kind: 'literal', color: { kind: 'oklch', l: 0.7, c: 0.1, h: 30, alpha: 0.5 } } }] })).toEqual({
      fills: [{ type: 'solid', color: '#abcdef' }, { type: 'solid', color: '#3366cc' }, { type: 'solid', color: 'oklch(0.7 0.1 30 / 0.5)' }],
    })
  })

  it('sorts gradient stops by position and resolves source tokens against the palette', () => {
    const ramp = gradient('g', 90, [['end', 1, tok('surface')], ['start', 0, lit('#000000')], ['mid', 0.333, tok('brand')]])
    const expected = (surface: string) => ({ fills: [{ type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ color: '#000000', position: 0 }, { color: '#3366cc', position: 0.333 }, { color: surface, position: 1 }] }] })
    expect(project({ fills: [ramp] })).toEqual(expected('#ffffff'))
    expect(project({ fills: [ramp] }, theme, { '--surface': hex('#242427') })).toEqual(expected('#242427'))
  })

  it('drops invisible paints and renders every visible paint in storage order', () => {
    expect(project({ fills: [{ ...solid('a', '#ff0000'), visible: false }] })).toStrictEqual({})
    expect(project({ fills: [solid('a', '#0000ff'), { ...solid('b', '#ff0000'), visible: false }, solid('c', '#00ff00')] })).toEqual({ fills: [{ type: 'solid', color: '#0000ff' }, { type: 'solid', color: '#00ff00' }] })
  })
})
