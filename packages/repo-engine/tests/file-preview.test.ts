import { describe, expect, it } from 'vitest'
import { legacyTextProperties, validateFileDocument } from '../src/file-document.js'
import type { Appearance, ColorValue, ComponentNode, FileDocument, ImageAssetReference, Paint, PrimitiveNode } from '../src/file-document.js'
import { projectPreviewPage } from '../src/file-preview.js'
import type { Atom } from '../src/types.js'
import { matrixFromLegacyPose } from '../src/layout-pose.js'

const card: Atom = { name: 'Card', kind: 'atom', componentId: 'sample-card', exportName: 'Card', path: 'src/atoms/Card.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'heading', type: 'ReactNode', optional: true }] }
const button: Atom = { name: 'Button', kind: 'atom', componentId: 'sample-button', exportName: 'Button', path: 'src/atoms/Button.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'variant', type: '"primary" | "quiet" | undefined', optional: true }] }
const atoms: Atom[] = [card, button]

const lit = (hex: string): ColorValue => ({ kind: 'literal', color: { kind: 'hex', hex } })
const tok = (tokenId: string): ColorValue => ({ kind: 'token', tokenId })
const solid = (id: string, color: ColorValue): Paint => ({ id, type: 'solid', color })
const buttonNode = (id: string, props: ComponentNode['props'] = {}): ComponentNode => ({ id, type: 'component', componentId: 'sample-button', exportName: 'Button', props })
const primitive = (id: string, type: PrimitiveNode['type'], styles: PrimitiveNode['styles'], appearance?: Appearance): PrimitiveNode => ({ id, type, name: `${id} name`, styles, ...(appearance ? { appearance } : {}) })
const center = { x: 0.5, y: 0.5 }
const pixel = (id: string, sha256 = 'a'.repeat(64)): ImageAssetReference => ({ id, name: `${id}.png`, mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256 })

/**
 * Page 1 root order: card (U), outer frame (V), solo button (W), caption text (X). card holds btn-1 (V) and btn-2 (W) in
 * `children` and title (V) in `heading`. outer (visible overflow) > inner (default clip) > dot (gradient). solo carries
 * a half-opacity instance appearance with a red border on every side; caption has no appearance.
 */
const fixture = (): FileDocument => validateFileDocument({
  schemaVersion: 12,
  componentModel: { definitions: {}, instances: {} },
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
    outer: primitive('outer', 'frame', { relativeTransform: [1, 0, 0, 1, -50, 60], width: 400, height: 300, overflow: 'visible' }, { fills: [solid('outer:fill:1', tok('surface'))] }),
    inner: primitive('inner', 'frame', { relativeTransform: [1, 0, 0, 1, 12, 18], width: 100, height: 80 }, { fills: [solid('inner:fill:1', lit('#ABCDEF'))] }),
    dot: primitive('dot', 'shape', { relativeTransform: matrixFromLegacyPose({ left: 4, top: 6, rotation: 45, flipX: true }, { width: 8, height: 8 }), width: 8, height: 8 }, { fills: [{ id: 'dot:fill:1', type: 'gradient', shape: 'linear', angle: 90, center, length: 1, interpolation: 'srgb', stops: [{ id: 'b', position: 1, color: tok('surface') }, { id: 'a', position: 0, color: lit('#000000') }] }] }),
    caption: { ...primitive('caption', 'text', { relativeTransform: [1, 0, 0, 1, 0, 400], width: 200, height: 24 }), text: 'Welcome', ...legacyTextProperties() },
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
    expect(document.version).toBe(3)
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
      { id: 'outer', kind: 'frame', name: 'outer name', relativeTransform: [1, 0, 0, 1, -50, 60], width: 400, height: 300, appearance: flat('#ffffff'), parentId: null, clip: false },
      { id: 'inner', kind: 'frame', name: 'inner name', relativeTransform: [1, 0, 0, 1, 12, 18], width: 100, height: 80, appearance: flat('#abcdef'), parentId: 'outer', clip: true },
      { id: 'dot', kind: 'shape', name: 'dot name', relativeTransform: matrixFromLegacyPose({ left: 4, top: 6, rotation: 45, flipX: true }, { width: 8, height: 8 }), width: 8, height: 8, appearance: ramp('#ffffff'), parentId: 'inner' },
      { id: 'caption', kind: 'text', name: 'caption name', relativeTransform: [1, 0, 0, 1, 0, 400], width: 200, height: 24, text: 'Welcome', ...legacyTextProperties(), parentId: null },
    ])
    expect(document).not.toHaveProperty('assets')
  })

  it('PAPER-FLEX-001/002 projects primitive flex participation without changing legacy freeform nodes or transform authority', () => {
    const file = fixture()
    ;(file.nodes.outer as PrimitiveNode).layout = {
      item: { position: { mode: 'freeform' } },
      container: { display: 'flex', gap: { x: 8, y: 10 }, flex: { direction: 'row', wrap: 'wrap', justify: 'start', align: 'center' } },
      spacing: { padding: { x: 12, y: 16 } },
    }
    ;(file.nodes.inner as PrimitiveNode).layout = {
      item: { position: { mode: 'flow' }, flex: { shrink: 0 } },
      container: { display: 'freeform' },
    }
    ;(file.nodes.dot as PrimitiveNode).layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 7 }, top: { kind: 'percent', value: 25 } } } }
    const { document } = projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!
    const byId = Object.fromEntries(document.canvas.elements.map(element => [element.id, element]))

    expect(document.version).toBe(3)
    expect(byId.outer!.layout).toStrictEqual({
      mode: 'freeform',
      declarations: { display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap', 'justify-content': 'flex-start', 'align-items': 'center', 'column-gap': '8px', 'row-gap': '10px', 'padding-top': '16px', 'padding-right': '12px', 'padding-bottom': '16px', 'padding-left': '12px' },
    })
    expect(byId.inner!.layout).toStrictEqual({ mode: 'flow', declarations: { 'flex-shrink': '0' } })
    expect(byId.dot!.layout).toStrictEqual({ mode: 'absolute', declarations: { position: 'absolute', left: '7px', top: '25%' } })
    expect(byId.dot!.relativeTransform).toStrictEqual(matrixFromLegacyPose({ left: 4, top: 6, rotation: 45, flipX: true }, { width: 8, height: 8 }))
    expect(byId.caption).not.toHaveProperty('layout')
  })

  it('resolves source tokens against the supplied palette', () => {
    const { document } = projectPreviewPage(fixture(), 'page-1', { '--surface': { kind: 'hex', hex: '#242427' } })!
    expect(document.canvas.elements.map(entry => entry.appearance)).toStrictEqual([flat('#242427'), flat('#abcdef'), ramp('#242427'), undefined])
  })

  it('projects an optional page background through the active palette', () => {
    const file = fixture()
    file.pages[0]!.background = tok('surface')
    expect(projectPreviewPage(validateFileDocument(file, atoms), 'page-1', { '--surface': { kind: 'hex', hex: '#242427' } })!.document.background).toBe('#242427')
    delete file.pages[0]!.background
    expect(projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!.document).not.toHaveProperty('background')
  })

  it('ships only the image assets a page references', () => {
    const file = fixture()
    file.assets = { photo: pixel('photo', '1'.repeat(64)), spare: pixel('spare'), other: pixel('other', '2'.repeat(64)) }
    ;(file.nodes.inner as PrimitiveNode).appearance = { fills: [solid('inner:fill:1', lit('#abcdef')), { id: 'inner:fill:2', type: 'image', assetId: 'photo', fit: 'cover' }] }
    file.nodes.away = primitive('away', 'rectangle', { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 }, { fills: [{ id: 'away:fill:1', type: 'image', assetId: 'other', fit: 'tile' }] })
    file.relationships.away = { parentId: 'root-2', orderKey: 'V' }
    const { document } = projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!
    expect(document.assets).toStrictEqual({ photo: { name: 'photo.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: '1'.repeat(64) } })
    expect(document.canvas.elements[1]!.appearance).toStrictEqual({ fills: [{ type: 'solid', color: '#abcdef' }, { type: 'image', assetId: 'photo', fit: 'cover' }] })
    expect(projectPreviewPage(validateFileDocument(file, atoms), 'page-2')!.document.assets).toStrictEqual({ other: { name: 'other.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: '2'.repeat(64) } })
  })

  it('projects only public image metadata even when a typed caller supplies private fields', () => {
    const file = fixture()
    file.assets = {
      photo: {
        ...pixel('photo', '1'.repeat(64)),
        data: 'private-inline-bytes',
        url: 'https://private.example/photo.png',
        objectKey: 'private/photo.png',
        etag: 'private-etag',
      } as ImageAssetReference,
    }
    ;(file.nodes.inner as PrimitiveNode).appearance = { fills: [{ id: 'inner:fill:1', type: 'image', assetId: 'photo', fit: 'cover' }] }

    expect(projectPreviewPage(file, 'page-1')!.document.assets).toStrictEqual({
      photo: { name: 'photo.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: '1'.repeat(64) },
    })
  })

  it('projects an empty page and returns null for an unknown page', () => {
    expect(projectPreviewPage(fixture(), 'page-2')).toStrictEqual({ document: { version: 3, revision: 9, rootIds: [], nodes: {}, frame: { name: 'Empty', width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false }, canvas: { elements: [] } }, layout: [], themeDiagnostics: [] })
    expect(projectPreviewPage(fixture(), 'page-x')).toBeNull()
  })

  it('COMP-V2-UI-003 projects model defaults and one instance override by source prop name', () => {
    const file = fixture()
    file.componentModel = {
      definitions: {
        'sample-button': {
          id: 'sample-button', name: 'Button', source: { kind: 'code', bindingId: 'button-binding' }, revision: 0,
          properties: [
            { id: 'label', name: 'children', type: 'text', defaultValue: 'Default label' },
            { id: 'tone', name: 'variant', type: 'variant', defaultValueId: 'primary', values: [{ id: 'primary', name: 'Primary' }, { id: 'quiet', name: 'Quiet' }] },
          ], materials: [], parts: [], interactions: [],
        },
      },
      instances: {
        'btn-1': { id: 'btn-1', componentId: 'sample-button', values: { label: 'Only one', tone: 'quiet' } },
        'btn-2': { id: 'btn-2', componentId: 'sample-button', values: {} },
      },
    }
    const { document } = projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!
    expect(document.nodes['btn-1']!.props).toEqual({ children: 'Only one', variant: 'quiet' })
    expect(document.nodes['btn-2']!.props).toEqual({ variant: 'primary', children: 'Default label' })
  })

  it('COMP-V2-UI-073 projects authored hover and press ownership onto the component root with the bound layer as target', () => {
    const file = fixture()
    const white = { fills: [solid('default-fill', lit('#ffffff'))] }
    const red = { fills: [solid('hover-fill', lit('#ff0000'))] }
    const blue = { fills: [solid('press-fill', lit('#0000ff'))] }
    file.componentModel = {
      definitions: {
        card: {
          id: 'card', name: 'Canvas card', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 1,
          properties: [{
            id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', currentValueId: 'default',
            values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }, { id: 'pressed', name: 'Pressed' }],
            binding: { kind: 'variant', nodeId: 'inner', appearances: { default: white, hover: red, pressed: blue } },
          }],
          materials: [], parts: [],
          interactions: [
            { id: 'hover-state', trigger: 'pointer-hover', propertyId: 'state', valueId: 'hover', transition: { type: 'smart-animate', durationMs: 180, easing: 'ease-out' } },
            { id: 'press-state', trigger: 'pointer-press', propertyId: 'state', valueId: 'pressed' },
          ],
        },
      },
      instances: {},
    }
    const elements = projectPreviewPage(validateFileDocument(file, atoms), 'page-1')!.document.canvas.elements
    expect(elements.find(element => element.id === 'outer')?.interactions).toStrictEqual([
      { trigger: 'pointer-hover', targetId: 'inner', appearance: flat('#ff0000'), transition: { type: 'smart-animate', durationMs: 180, easing: 'ease-out' } },
      { trigger: 'pointer-press', targetId: 'inner', appearance: flat('#0000ff') },
    ])
    expect(elements.find(element => element.id === 'inner')?.interactions).toBeUndefined()
    expect(elements.find(element => element.id === 'inner')?.appearance).toStrictEqual(flat('#abcdef'))
  })
})
