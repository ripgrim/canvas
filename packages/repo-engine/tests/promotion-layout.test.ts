import * as recast from 'recast'
import { describe, expect, it } from 'vitest'
import { documentPromotionSource, promotionLayoutStyles } from '../src/document-promotion.js'
import { legacyPageDocument, validateFileDocument } from '../src/file-document.js'
import type { FileDocument } from '../src/file-document.js'
import { isLayoutDeclarations, isSourceLayoutStyle } from '../src/layout-css.js'
import { parseTsx } from '../src/patches.js'
import type { Atom } from '../src/types.js'
// Test-only import: repo-engine source must not depend on the runtime, but the two grammars must agree.
import { isLayoutDeclarations as runtimeIsLayoutDeclarations } from '../../preview-runtime/src/layout-protocol.js'

const card: Atom = { name: 'Card', kind: 'atom', componentId: 'sample-card', exportName: 'Card', path: 'src/atoms/Card.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'heading', type: 'ReactNode', optional: true }] }
const button: Atom = { name: 'Button', kind: 'atom', componentId: 'sample-button', exportName: 'Button', path: 'src/atoms/Button.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] }
const atoms: Atom[] = [card, button]
const px = (value: number) => ({ kind: 'px' as const, value })

/**
 * Page root: grid-card (U) then pinned (V).
 * grid-card: Grid container (1fr 200px / auto, gap 12 x 8), padding x 16 y 12; children placed, sized; heading title.
 * placed: grid placement column 1 span 2, row 2, align-self end. sized: flow with a 120 px width (legacy-only).
 * pinned: legacy-only absolute card at world (40, 60), 300 x 200; holds badge, absolute with right/top insets and z-index.
 * title has no layout at all.
 */
const fixture = (): FileDocument => validateFileDocument({
  schemaVersion: 13,
  componentModel: { definitions: {}, instances: {} },
  fileId: 'file-1',
  revision: 3,
  pages: [{ id: 'page-1', name: 'Layout', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'grid-card': { id: 'grid-card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'grid', gap: { x: 12, y: 8 }, grid: { columns: [{ kind: 'fr', value: 1 }, { kind: 'px', value: 200 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } }, spacing: { padding: { x: 16, y: 12 } } } },
    placed: { id: 'placed', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Placed' }, layout: { item: { position: { mode: 'flow' }, grid: { columnStart: 1, columnSpan: 2, rowStart: 2, alignSelf: 'end' } } } },
    sized: { id: 'sized', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Sized' }, layout: { item: { position: { mode: 'flow' }, width: { value: px(120) } } } },
    title: { id: 'title', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Title' } },
    pinned: { id: 'pinned', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'absolute', left: px(40), top: px(60) }, width: { value: px(300) }, height: { value: px(200) } } } },
    badge: { id: 'badge', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Badge' }, layout: { item: { position: { mode: 'absolute', right: px(8), top: px(8), zIndex: 2 } } } },
  },
  relationships: {
    'grid-card': { parentId: 'root-1', orderKey: 'U' },
    pinned: { parentId: 'root-1', orderKey: 'V' },
    placed: { parentId: 'grid-card', orderKey: 'U', slot: 'children' },
    sized: { parentId: 'grid-card', orderKey: 'V', slot: 'children' },
    title: { parentId: 'grid-card', orderKey: 'U', slot: 'heading' },
    badge: { parentId: 'pinned', orderKey: 'U', slot: 'children' },
  },
  theme: { tokens: {} },
}, atoms)

type Element = { name: string; attributes: string[]; key: string | null; style: Record<string, string> | null }
/** Every JSX element in the emitted module with its attribute names and, when present, its literal style object. */
function elements(source: string): Element[] {
  const found: Element[] = []
  recast.types.visit(parseTsx(source), {
    visitJSXElement(path) {
      const opening = path.node.openingElement
      if (opening.name.type !== 'JSXIdentifier') throw new Error('Unexpected member or namespaced element name')
      const element: Element = { name: opening.name.name, attributes: [], key: null, style: null }
      for (const attribute of opening.attributes ?? []) {
        if (attribute.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier') throw new Error('Unexpected spread or namespaced attribute')
        element.attributes.push(attribute.name.name)
        const value = attribute.value
        if (attribute.name.name === 'key' && value?.type === 'JSXExpressionContainer' && value.expression.type === 'StringLiteral') element.key = value.expression.value
        if (attribute.name.name === 'style') {
          if (value?.type !== 'JSXExpressionContainer' || value.expression.type !== 'ObjectExpression') throw new Error('Style is not an object literal')
          element.style = {}
          for (const property of value.expression.properties) {
            if (property.type !== 'ObjectProperty' || property.key.type !== 'Identifier' || property.value.type !== 'StringLiteral') throw new Error('Style entry is not an identifier key with a string literal value')
            element.style[property.key.name] = property.value.value
          }
        }
      }
      found.push(element)
      this.traverse(path)
    },
  })
  return found
}

const promote = (file: FileDocument, styles = promotionLayoutStyles(file, 'page-1')) => documentPromotionSource('LayoutPage', legacyPageDocument(file, 'page-1'), atoms, 'src/components/LayoutPage.tsx', styles)

describe('LAY-SAVE-004 promotion writes layout as style props on the node elements', () => {
  it('builds per-node longhands from the preview projection, including the five-field placement', () => {
    // Root origin of the 400 x 520 host with 24 px padding is (-176, -236), so world (40, 60) sits at 216, 296.
    expect(promotionLayoutStyles(fixture(), 'page-1')).toEqual({
      'grid-card': { display: 'grid', 'grid-template-columns': '1fr 200px', 'grid-template-rows': 'auto', 'grid-auto-flow': 'row', 'column-gap': '12px', 'row-gap': '8px', 'padding-top': '12px', 'padding-right': '16px', 'padding-bottom': '12px', 'padding-left': '16px' },
      placed: { 'grid-column-start': '1', 'grid-column-end': 'span 2', 'grid-row-start': '2', 'align-self': 'end' },
      sized: { width: '120px', flex: '0 0 auto' },
      pinned: { position: 'absolute', left: '216px', top: '296px', width: '300px', height: '200px' },
      badge: { position: 'absolute', right: '8px', top: '8px', 'z-index': '2' },
    })
  })

  it('emits exactly the expected style objects with no wrapper element', () => {
    const source = promote(fixture())
    const found = elements(source)
    // One element per design node, each an atom export: no div, span, or other layout wrapper was introduced.
    expect(found.map(element => element.name).sort()).toEqual(['Button', 'Button', 'Button', 'Button', 'Card', 'Card'])
    expect(found.map(element => element.key).sort()).toEqual(['badge', 'grid-card', 'pinned', 'placed', 'sized', 'title'])
    const byKey = Object.fromEntries(found.map(element => [element.key, element]))
    expect(byKey['grid-card']).toEqual({ name: 'Card', key: 'grid-card', attributes: ['key', 'style', 'heading'], style: { display: 'grid', gridTemplateColumns: '1fr 200px', gridTemplateRows: 'auto', gridAutoFlow: 'row', columnGap: '12px', rowGap: '8px', paddingTop: '12px', paddingRight: '16px', paddingBottom: '12px', paddingLeft: '16px' } })
    expect(byKey.placed).toEqual({ name: 'Button', key: 'placed', attributes: ['key', 'style'], style: { gridColumnStart: '1', gridColumnEnd: 'span 2', gridRowStart: '2', alignSelf: 'end' } })
    expect(byKey.sized).toEqual({ name: 'Button', key: 'sized', attributes: ['key', 'style'], style: { width: '120px', flex: '0 0 auto' } })
    expect(byKey.pinned).toEqual({ name: 'Card', key: 'pinned', attributes: ['key', 'style'], style: { position: 'absolute', left: '216px', top: '296px', width: '300px', height: '200px' } })
    expect(byKey.badge).toEqual({ name: 'Button', key: 'badge', attributes: ['key', 'style'], style: { position: 'absolute', right: '8px', top: '8px', zIndex: '2' } })
    expect(byKey.title).toEqual({ name: 'Button', key: 'title', attributes: ['key'], style: null })
    expect(source).not.toMatch(/className|<style|<div|<span/)
    // Recast ends lines with the platform terminator, so compare lines rather than bytes.
    expect(source.split(/\r?\n/).slice(0, 2)).toEqual(["import { Button } from '../atoms/Button';", "import { Card } from '../atoms/Card';"])
  })

  it('throws on a declaration outside the grammar and returns no source', () => {
    const file = fixture()
    const styles = promotionLayoutStyles(file, 'page-1')
    let output: string | undefined
    expect(() => { output = promote(file, { ...styles, 'grid-card': { display: 'url(x)' } }) }).toThrow('Layout style for grid-card is outside the reviewed CSS grammar: display')
    expect(output).toBeUndefined()
    expect(() => promote(file, { ...styles, placed: { ...styles.placed, color: 'red' } })).toThrow('outside the reviewed CSS grammar: color')
    expect(() => promote(file, { ...styles, sized: { width: '120px', flex: '1' } })).toThrow('outside the reviewed CSS grammar: flex')
    expect(() => promote(file, { ...styles, pinned: { ...styles.pinned, left: 'calc(1px + 2px)' } })).toThrow('outside the reviewed CSS grammar: left')
    expect(() => promote(file, { ...styles, ghost: { display: 'grid' } })).toThrow('not on this page: ghost')
    // Negative control: the same map without the injected entry promotes.
    expect(promote(file, styles)).toContain('gridTemplateColumns')
  })

  it('refuses layout without reviewed styles, and canvas elements still refuse with the existing message', () => {
    const file = fixture()
    const document = legacyPageDocument(file, 'page-1')
    expect(() => documentPromotionSource('LayoutPage', document, atoms)).toThrow('Canvas layout needs a reviewed source adapter before promotion')
    const drawn = { ...document, canvas: { elements: [{ id: 'drawn-frame', kind: 'frame' as const, name: 'Frame 1', x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: '#ffffff' }] } }
    expect(() => documentPromotionSource('LayoutPage', drawn, atoms, 'src/components/LayoutPage.tsx', promotionLayoutStyles(file, 'page-1'))).toThrow('Canvas layout needs a reviewed source adapter before promotion')
    // Negative control: with no layout and no canvas elements, promotion needs no styles at all.
    const plain = structuredClone(document)
    for (const node of Object.values(plain.nodes)) delete node.layout
    expect(elements(documentPromotionSource('LayoutPage', plain, atoms)).every(element => element.style === null)).toBe(true)
  })
})

/** Hand-written samples with the verdict both grammars must reach. */
const samples: [string, unknown, boolean][] = [
  ['empty map', {}, true],
  ['grid container', { display: 'grid', 'grid-template-columns': '1fr 200px minmax(100px, 1fr)', 'grid-template-rows': 'auto 40%', 'grid-auto-flow': 'column', 'column-gap': '12px', 'row-gap': '8.5px' }, true],
  ['flex container', { display: 'flex', 'flex-direction': 'row-reverse', 'flex-wrap': 'wrap', 'justify-content': 'space-between', 'align-items': 'baseline', 'align-content': 'flex-end', overflow: 'clip' }, true],
  ['absolute insets', { position: 'absolute', left: '-10px', top: '50%', right: '0px', bottom: '2.25px', 'z-index': '-3' }, true],
  ['sizes', { width: 'fit-content', height: '100%', 'min-width': '10px', 'min-height': '10%', 'max-width': 'none', 'max-height': 'max-content' }, true],
  ['flex item', { 'flex-grow': '1', 'flex-shrink': '0', 'flex-basis': 'content' }, true],
  ['grid item', { 'grid-column-start': 'span 2', 'grid-column-end': '3', 'grid-row-start': '1', 'grid-row-end': 'span 4', 'justify-self': 'center', 'align-self': 'baseline', 'justify-items': 'start' }, true],
  ['transform', { transform: 'matrix(1.06066017178, 1.06066017178, -1.414213562373, 1.414213562373, 0, 0)', 'aspect-ratio': '1.5' }, true],
  ['legacy transform functions', { transform: 'rotate(45deg) scale(1.5, 2)' }, false],
  ['translated matrix', { transform: 'matrix(1, 0, 0, 1, 2, 3)' }, false],
  ['spacing', { 'margin-left': 'auto', 'margin-top': '-4px', 'padding-top': '0px', 'padding-left': '16px' }, true],
  ['url value', { display: 'url(x)' }, false],
  ['inline display', { display: 'inline' }, false],
  ['upper case keyword', { display: 'GRID' }, false],
  ['trailing space', { display: 'grid ' }, false],
  ['relative position', { position: 'relative' }, false],
  ['calc', { width: 'calc(100% - 4px)' }, false],
  ['var', { width: 'var(--w)' }, false],
  ['important', { width: '10px !important' }, false],
  ['declaration separator', { left: '10px; color: red' }, false],
  ['negative padding', { 'padding-top': '-4px' }, false],
  ['percent gap', { 'column-gap': '4%' }, false],
  ['unknown property', { color: 'red' }, false],
  ['camelCase property', { gridTemplateColumns: '1fr' }, false],
  ['flex shorthand', { flex: '0 0 auto' }, false],
  ['repeat track', { 'grid-template-columns': 'repeat(2, 1fr)' }, false],
  ['named grid line', { 'grid-column-start': 'auto' }, false],
  ['translate', { transform: 'translate(10px)' }, false],
  ['too many fraction digits', { width: '1.12345px' }, false],
  ['number value', { width: 1 }, false],
  ['array', [], false],
  ['null', null, false],
  ['text', 'display: grid', false],
  ['inherited prototype', Object.assign(Object.create({ inherited: 1 }), { display: 'grid' }), false],
]

describe('repo-engine layout grammar mirrors the preview runtime grammar', () => {
  it.each(samples)('%s', (_, sample, expected) => {
    expect(runtimeIsLayoutDeclarations(sample)).toBe(expected)
    expect(isLayoutDeclarations(sample)).toBe(expected)
  })

  it('the source grammar adds only the placement flex value', () => {
    expect(isSourceLayoutStyle({ width: '120px', flex: '0 0 auto' })).toBe(true)
    for (const flex of ['1', '0 0 auto ', '1 1 auto', '0 0 120px']) expect(isSourceLayoutStyle({ flex })).toBe(false)
    for (const [, sample, expected] of samples.filter(([name]) => name !== 'flex shorthand')) expect(isSourceLayoutStyle(sample)).toBe(expected)
  })

  it('rejects prototype member names as properties instead of reaching them through lookup', () => {
    for (const sample of [{ constructor: 'x' }, { toString: 'x' }, JSON.parse('{"__proto__": "grid"}') as unknown]) {
      expect(isLayoutDeclarations(sample)).toBe(false)
      expect(isSourceLayoutStyle(sample)).toBe(false)
    }
  })
})
