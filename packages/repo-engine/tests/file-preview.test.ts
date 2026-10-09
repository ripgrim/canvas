import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../src/file-document.js'
import type { Appearance, ColorValue, ComponentNode, FileDocument, ImageAsset, Paint, PrimitiveNode } from '../src/file-document.js'
import { projectPreviewPage } from '../src/file-preview.js'
import type { Atom } from '../src/types.js'

const card: Atom = { name: 'Card', kind: 'atom', componentId: 'sample-card', exportName: 'Card', path: 'src/atoms/Card.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'heading', type: 'ReactNode', optional: true }] }
const button: Atom = { name: 'Button', kind: 'atom', componentId: 'sample-button', exportName: 'Button', path: 'src/atoms/Button.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'variant', type: '"primary" | "quiet" | undefined', optional: true }] }
const atoms: Atom[] = [card, button]

const lit = (hex: string): ColorValue => ({ kind: 'literal', color: { kind: 'hex', hex } })
const tok = (tokenId: string): ColorValue => ({ kind: 'token', tokenId })
const solid = (id: string, color: ColorValue): Paint => ({ id, type: 'solid', color })
const buttonNode = (id: string, props: ComponentNode['props'] = {}): ComponentNode => ({ id, type: 'component', componentId: 'sample-button', exportName: 'Button', props })
const primitive = (id: string, type: PrimitiveNode['type'], styles: PrimitiveNode['styles'], appearance?: Appearance): PrimitiveNode => ({ id, type, name: `${id} name`, styles, ...(appearance ? { appearance } : {}) })
const center = { x: 0.5, y: 0.5 }
const pixel = (id: string, data = 'AAAA'): ImageAsset => ({ id, name: id, mime: 'image/png', width: 1, height: 1, bytes: 3, data })

/**
 * Page 1 root order: card (U), outer frame (V), solo button (W), caption text (X). card holds btn-1 (V) and btn-2 (W) in
 * `children` and title (V) in `heading`. outer (visible overflow) > inner (default clip) > dot (gradient). solo carries
 * a half-opacity instance appearance with a red border on every side; caption has no appearance.
 */
const fixture = (): FileDocument => validateFileDocument({
  schemaVersion: 5,
  fileId: 'file-1',
  revision: 9,
  pages: [{ id: 'page-1', name: 'Landing', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Empty', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', name: 'Hero', props: {}, layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } }, width: { value: { kind: 'px', value: 300 } } } } },
    'btn-1': buttonNode('btn-1', { children: 'One' }),
    'btn-2': { ...buttonNode('btn-2', { variant: 'quiet' }), layout: { item: { position: { mode: 'flow' }, height: { value: { kind: 'px', value: 40 } } } } },
    title: buttonNode('title'),
    solo: { ...buttonNode('solo'), appearance: { opacity: 0.5, borders: { all: { color: lit('#ff0000'), width: 2, style: 'solid' } } } },
    outer: primitive('outer', 'frame', { left: -50, top: 60, width: 400, height: 300, overflow: 'visible' }, { fills: [solid('outer:fill:1', tok('surface'))] }),
    inner: primitive('inner', 'frame', { left: 12, top: 18, width: 100, height: 80 }, { fills: [solid('inner:fill:1', lit('#ABCDEF'))] }),
    dot: primitive('dot', 'shape', { left: 4, top: 6, width: 8, height: 8, rotation: 45 }, { fills: [{ id: 'dot:fill:1', type: 'gradient', shape: 'linear', angle: 90, center, length: 1, interpolation: 'srgb', stops: [{ id: 'b', position: 1, color: tok('surface') }, { id: 'a', position: 0, color: lit('#000000') }] }] }),
    caption: { ...primitive('caption', 'text', { left: 0, top: 400, width: 200, height: 24 }), text: 'Welcome' },
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'U' },
    outer: { parentId: 'root-1', orderKey: 'V' },
    solo: { parentId: 'root-1', orderKey: 'W' },
    caption: { parentId: 'root-1', orderKey: 'X' },
    'btn-2': { parentId: 'card', orderKey: 'W', slot: 'children' },
    'btn-1': { parentId: 'card', orderKey: 'V', slot: 'children' },
    title: { parentId: 'card', orderKey: 'V', slot: 'heading' },
    inner: { parentId: 'outer', orderKey: 'V' },
    dot: { parentId: 'inner', orderKey: 'V' },
  },
  theme: { tokens: { surface: { id: 'surface', type: 'color', name: 'surface', orderKey: 'V', value: { kind: 'source', property: '--surface', fallback: { kind: 'hex', hex: '#ffffff' } } } } },
}, atoms)

/** With a plain palette there are no design themes, so every node without its own stored mode reads the light fallback. */
const fallbackTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false }
const flat = (color: string) => ({ fills: [{ type: 'solid', color }] })
const ramp = (end: string) => ({ fills: [{ type: 'gradient', shape: 'linear', angle: 90, center, length: 1, interpolation: 'srgb', stops: [{ color: '#000000', position: 0 }, { color: end, position: 1 }] }] })

describe('preview projection', () => {
  it('lists component children of the root in order as root ids, with slot children per slot and instance appearance', () => {
    const { document } = projectPreviewPage(fixture(), 'page-1')!
    expect(document.version).toBe(1)
    expect(document.revision).toBe(9)
    expect(document.rootIds).toEqual(['card', 'solo'])
    const red = { color: '#ff0000', width: 2, style: 'solid' }
    expect(document.nodes).toStrictEqual({
      card: { id: 'card', componentId: 'sample-card', exportName: 'Card', name: 'Hero', props: {}, children: { children: ['btn-1', 'btn-2'], heading: ['title'] }, theme: fallbackTheme },
      'btn-1': { id: 'btn-1', componentId: 'sample-button', exportName: 'Button', props: { children: 'One' }, children: {}, theme: fallbackTheme },
      'btn-2': { id: 'btn-2', componentId: 'sample-button', exportName: 'Button', props: { variant: 'quiet' }, children: {}, theme: fallbackTheme },
      title: { id: 'title', componentId: 'sample-button', exportName: 'Button', props: {}, children: {}, theme: fallbackTheme },
      solo: { id: 'solo', componentId: 'sample-button', exportName: 'Button', props: {}, children: {}, appearance: { opacity: 0.5, borders: { top: red, bottom: red, left: red, right: red } }, theme: fallbackTheme },
    })
    expect(document.frame).toEqual({ name: 'Landing', width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false })
  })

  it('emits layout entries with mode, position, order, and size only when present', () => {
    const { layout } = projectPreviewPage(fixture(), 'page-1')!
    const byId = Object.fromEntries(layout.map(entry => [entry.nodeId, entry]))
    expect(layout).toHaveLength(5)
    expect(byId).toEqual({
      card: { nodeId: 'card', mode: 'absolute', x: 10, y: 20, order: 0, width: 300 },
      solo: { nodeId: 'solo', mode: 'flow', x: 0, y: 0, order: 1 },
      'btn-1': { nodeId: 'btn-1', mode: 'flow', x: 0, y: 0, order: 0 },
      'btn-2': { nodeId: 'btn-2', mode: 'flow', x: 0, y: 0, order: 1, height: 40 },
      title: { nodeId: 'title', mode: 'flow', x: 0, y: 0, order: 0 },
    })
  })

  it('leaves non-px sizes and insets out of the five-field layout entry', () => {
    const file = fixture()
    ;(file.nodes.card as ComponentNode).layout = { item: { position: { mode: 'absolute', left: { kind: 'percent', value: 25 }, top: { kind: 'px', value: 20 } }, width: { value: { kind: 'percent', value: 50 } }, height: { value: { kind: 'px', value: 90 } } } }
    const { layout } = projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!
    // px sizes travel in the five-field placement; insets travel as longhands with root px insets shifted to the host origin
    // (host 400 wide and 520 tall with 24 padding: origin y = -260 + 24 = -236, so top 20 becomes 256px).
    expect(layout.find(entry => entry.nodeId === 'card')).toStrictEqual({ nodeId: 'card', mode: 'absolute', x: 0, y: 20, order: 0, height: 90, declarations: { left: '25%', top: '256px', width: '50%' } })
    // A legacy-only root keeps the pure five-field entry, and a nested absolute node under a plain parent keeps raw px insets.
    ;(file.nodes.card as ComponentNode).layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } } }
    ;(file.nodes['btn-2'] as ComponentNode).layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 7 }, top: { kind: 'px', value: 8 }, right: { kind: 'px', value: 9 } } } }
    const again = projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!.layout
    expect(again.find(entry => entry.nodeId === 'card')).toStrictEqual({ nodeId: 'card', mode: 'absolute', x: 10, y: 20, order: 0 })
    expect(again.find(entry => entry.nodeId === 'btn-2')).toStrictEqual({ nodeId: 'btn-2', mode: 'absolute', x: 7, y: 8, order: 1, declarations: { left: '7px', right: '9px', top: '8px' } })
  })

  it('flattens primitives in pre-order with parent-local positions, clipping, text, and resolved appearance', () => {
    const { document } = projectPreviewPage(fixture(), 'page-1')!
    expect(document.canvas.elements).toStrictEqual([
      { id: 'outer', kind: 'frame', name: 'outer name', x: -50, y: 60, width: 400, height: 300, rotation: 0, appearance: flat('#ffffff'), parentId: null, clip: false },
      { id: 'inner', kind: 'frame', name: 'inner name', x: 12, y: 18, width: 100, height: 80, rotation: 0, appearance: flat('#abcdef'), parentId: 'outer', clip: true },
      { id: 'dot', kind: 'shape', name: 'dot name', x: 4, y: 6, width: 8, height: 8, rotation: 45, appearance: ramp('#ffffff'), parentId: 'inner' },
      { id: 'caption', kind: 'text', name: 'caption name', x: 0, y: 400, width: 200, height: 24, rotation: 0, text: 'Welcome', parentId: null },
    ])
    expect(document).not.toHaveProperty('assets')
  })

  it('resolves source tokens against the supplied palette', () => {
    const { document } = projectPreviewPage(fixture(), 'page-1', { '--surface': { kind: 'hex', hex: '#242427' } })!
    expect(document.canvas.elements.map(entry => entry.appearance)).toStrictEqual([flat('#242427'), flat('#abcdef'), ramp('#242427'), undefined])
  })

  it('ships only the image assets a page references', () => {
    const file = fixture()
    file.assets = { photo: pixel('photo', 'AQID'), spare: pixel('spare'), other: pixel('other', 'BAUG') }
    ;(file.nodes.inner as PrimitiveNode).appearance = { fills: [solid('inner:fill:1', lit('#abcdef')), { id: 'inner:fill:2', type: 'image', assetId: 'photo', fit: 'cover' }] }
    file.nodes.away = primitive('away', 'rectangle', { left: 0, top: 0, width: 10, height: 10 }, { fills: [{ id: 'away:fill:1', type: 'image', assetId: 'other', fit: 'tile' }] })
    file.relationships.away = { parentId: 'root-2', orderKey: 'V' }
    const { document } = projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!
    expect(document.assets).toStrictEqual({ photo: { mime: 'image/png', data: 'AQID' } })
    expect(document.canvas.elements[1]!.appearance).toStrictEqual({ fills: [{ type: 'solid', color: '#abcdef' }, { type: 'image', assetId: 'photo', fit: 'cover' }] })
    expect(projectPreviewPage(validateFileDocument(file, atoms), 'page-2')!.document.assets).toStrictEqual({ other: { mime: 'image/png', data: 'BAUG' } })
  })

  it('projects an empty page and returns null for an unknown page', () => {
    expect(projectPreviewPage(fixture(), 'page-2')).toStrictEqual({ document: { version: 1, revision: 9, rootIds: [], nodes: {}, frame: { name: 'Empty', width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false }, canvas: { elements: [] } }, layout: [], themeDiagnostics: [] })
    expect(projectPreviewPage(fixture(), 'page-x')).toBeNull()
  })
})
