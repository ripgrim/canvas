import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../src/file-document.js'
import type { ComponentNode, FileDocument, PrimitiveNode } from '../src/file-document.js'
import { projectPreviewPage } from '../src/file-preview.js'
import type { Atom } from '../src/types.js'

const atom: Atom = { name: 'Card', kind: 'atom', componentId: 'card', exportName: 'Card', path: 'Card.tsx', fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [] }
const frame = (id: string): PrimitiveNode => ({ id, type: 'frame', name: id, styles: { relativeTransform: [1, 0, 0, 1, 12, 18], width: 320, height: 180 } })
const fixture = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'primitive-sizing-file',
  revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' }, frame: frame('frame') },
  relationships: { frame: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})

describe('PAPER-FLEX-003 primitive sizing authority', () => {
  it('roundtrips and projects a freeform Frame Fit axis after its numeric fallback', () => {
    const source = fixture()
    source.nodes.frame = {
      ...frame('frame'),
      layout: {
        item: { position: { mode: 'freeform' }, width: { value: { kind: 'intrinsic', value: 'fit-content' } } },
        container: { display: 'block' },
      },
    }

    const checked = validateFileDocument(JSON.parse(JSON.stringify(source)), [])
    expect(checked.nodes.frame).toStrictEqual(source.nodes.frame)
    const element = projectPreviewPage(checked, 'page-1')!.document.canvas.elements[0]!
    expect({ width: element.width, height: element.height }).toStrictEqual({ width: 320, height: 180 })
    expect(element.layout).toStrictEqual({ mode: 'freeform', declarations: { display: 'block', width: 'fit-content' } })
  })

  it('retains Fill and Relative as semantic freeform axes while styles remain fallback geometry', () => {
    const source = fixture()
    source.nodes.parent = { ...frame('parent'), styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 600, height: 400 } }
    source.relationships.parent = { parentId: 'root-1', orderKey: 'V' }
    source.nodes.frame = {
      ...frame('frame'),
      layout: {
        item: {
          position: { mode: 'freeform' },
          width: { value: { kind: 'percent', value: 100 } },
          height: { value: { kind: 'percent', value: 42 } },
        },
      },
    }
    source.relationships.frame = { parentId: 'parent', orderKey: 'V' }

    const element = projectPreviewPage(validateFileDocument(source, []), 'page-1')!.document.canvas.elements.find(candidate => candidate.id === 'frame')!
    expect({ width: element.width, height: element.height }).toStrictEqual({ width: 320, height: 180 })
    expect(element.layout?.declarations).toStrictEqual({ width: '100%', height: '42%' })
  })

  it('projects freeform Auto after retaining the literal numeric fallback box', () => {
    const source = fixture()
    source.nodes.frame = {
      ...frame('frame'),
      layout: {
        item: { position: { mode: 'freeform' }, width: { value: { kind: 'auto' } }, height: { value: { kind: 'auto' } } },
        container: { display: 'block' },
        spacing: { padding: 24 },
      },
    }

    const element = projectPreviewPage(validateFileDocument(source, []), 'page-1')!.document.canvas.elements[0]!
    expect({ width: element.width, height: element.height }).toStrictEqual({ width: 320, height: 180 })
    expect(element.layout).toStrictEqual({ mode: 'freeform', declarations: { display: 'block', width: 'auto', height: 'auto', 'padding-top': '24px', 'padding-right': '24px', 'padding-bottom': '24px', 'padding-left': '24px' } })
  })

  it('rejects root percentages in width and height values and bounds', () => {
    for (const axis of ['width', 'height'] as const) {
      for (const percentage of [100, 42]) {
        for (const field of ['value', 'min', 'max'] as const) {
          const source = fixture()
          const percent = { kind: 'percent' as const, value: percentage }
          const size = field === 'value' ? { value: percent } : { value: { kind: 'auto' as const }, [field]: percent }
          source.nodes.frame = {
            ...frame('frame'),
            layout: { item: { position: { mode: 'freeform' }, [axis]: size }, container: { display: 'block' } },
          }
          expect(() => validateFileDocument(source, [])).toThrow('Root primitives cannot use percentage sizing')
        }
      }
    }
  })

  it('accepts nested width and height percentages when the parent Frame axes are fixed', () => {
    const source = fixture()
    source.nodes.parent = { ...frame('parent'), styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 600, height: 400 } }
    source.relationships.parent = { parentId: 'root-1', orderKey: 'V' }
    source.nodes.frame = {
      ...frame('frame'),
      layout: {
        item: {
          position: { mode: 'freeform' },
          width: { value: { kind: 'percent', value: 100 }, min: { kind: 'percent', value: 42 }, max: { kind: 'percent', value: 100 } },
          height: { value: { kind: 'percent', value: 42 }, min: { kind: 'percent', value: 10 }, max: { kind: 'percent', value: 100 } },
        },
      },
    }
    source.relationships.frame = { parentId: 'parent', orderKey: 'V' }

    const checked = validateFileDocument(source, [])
    expect((checked.nodes.frame as PrimitiveNode).layout?.item).toStrictEqual((source.nodes.frame as PrimitiveNode).layout?.item)
  })

  it('rejects nested percentages when the corresponding parent Frame axis is intrinsic or Auto', () => {
    const cases = [
      { axis: 'width' as const, parentValue: { kind: 'intrinsic' as const, value: 'fit-content' as const }, percentage: 100 },
      { axis: 'height' as const, parentValue: { kind: 'auto' as const }, percentage: 42 },
    ]
    for (const { axis, parentValue, percentage } of cases) {
      const source = fixture()
      source.nodes.parent = {
        ...frame('parent'),
        layout: { item: { position: { mode: 'freeform' }, [axis]: { value: parentValue } }, container: { display: 'block' } },
      }
      source.relationships.parent = { parentId: 'root-1', orderKey: 'V' }
      source.nodes.frame = { ...frame('frame'), layout: { item: { position: { mode: 'freeform' }, [axis]: { value: { kind: 'percent', value: percentage } } } } }
      source.relationships.frame = { parentId: 'parent', orderKey: 'V' }
      expect(() => validateFileDocument(source, [])).toThrow('Percentage sizing needs a definite parent Frame axis')
    }
  })

  it('rejects a nested percentage chain that does not terminate at a fixed Frame axis', () => {
    const source = fixture()
    source.nodes.parent = {
      ...frame('parent'),
      layout: { item: { position: { mode: 'freeform' }, width: { value: { kind: 'percent', value: 100 } } }, container: { display: 'freeform' } },
    }
    source.relationships.parent = { parentId: 'root-1', orderKey: 'V' }
    source.nodes.frame = { ...frame('frame'), layout: { item: { position: { mode: 'freeform' }, width: { value: { kind: 'percent', value: 42 } } } } }
    source.relationships.frame = { parentId: 'parent', orderKey: 'V' }
    expect(() => validateFileDocument(source, [])).toThrow('Percentage sizing needs a definite parent Frame axis')
  })

  it('rejects intrinsic and Auto axes on freeform rectangle, shape, and shader leaves', () => {
    for (const type of ['rectangle', 'shape', 'shader'] as const) {
      for (const axis of ['width', 'height'] as const) {
        for (const field of ['value', 'min', 'max'] as const) {
          for (const value of [{ kind: 'intrinsic' as const, value: 'fit-content' as const }, { kind: 'auto' as const }]) {
            const source = fixture()
            const size = field === 'value' ? { value } : { value: { kind: 'percent' as const, value: 50 }, [field]: value }
            source.nodes.frame = { ...frame('frame'), type, layout: { item: { position: { mode: 'freeform' }, [axis]: size } } }
            expect(() => validateFileDocument(source, [])).toThrow('Intrinsic primitive sizing needs an explicit Frame container')
          }
        }
      }
    }
  })

  it('rejects competing text axes and redundant primitive px axes but leaves Component semantics unchanged', () => {
    const primitive = fixture()
    ;(primitive.nodes.frame as PrimitiveNode).layout = { item: { position: { mode: 'freeform' }, width: { value: { kind: 'px', value: 320 } } } }
    expect(() => validateFileDocument(primitive, [])).toThrow('Fixed primitive sizing belongs in node styles')

    const text = fixture()
    text.nodes.frame = {
      id: 'frame',
      type: 'text',
      name: 'Text',
      styles: { relativeTransform: [1, 0, 0, 1, 12, 18], width: 320, height: 40 },
      text: 'Paper',
      textStyle: { fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.2 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
      layout: { item: { position: { mode: 'freeform' }, width: { value: { kind: 'intrinsic', value: 'fit-content' } } } },
    }
    expect(() => validateFileDocument(text, [])).toThrow('Text layout cannot override text sizing')

    const component = fixture()
    component.nodes.card = { id: 'card', type: 'component', componentId: 'card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'px', value: 320 } } } } } satisfies ComponentNode
    component.relationships.card = { parentId: 'root-1', orderKey: 'W' }
    expect((validateFileDocument(component, [atom]).nodes.card as ComponentNode).layout?.item.width).toStrictEqual({ value: { kind: 'px', value: 320 } })
  })

  it('rejects an independently mutated primitive px height as competing fixed authority', () => {
    const source = fixture()
    ;(source.nodes.frame as PrimitiveNode).layout = { item: { position: { mode: 'freeform' }, height: { value: { kind: 'px', value: 180 } } } }
    expect(() => validateFileDocument(source, [])).toThrow('Fixed primitive sizing belongs in node styles')
  })

  it('rejects an independently mutated text layout height as competing text authority', () => {
    const source = fixture()
    source.nodes.frame = {
      id: 'frame',
      type: 'text',
      name: 'Text',
      styles: { relativeTransform: [1, 0, 0, 1, 12, 18], width: 320, height: 40 },
      text: 'Paper',
      textStyle: { fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.2 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
      layout: { item: { position: { mode: 'freeform' }, height: { value: { kind: 'intrinsic', value: 'fit-content' } } } },
    }
    expect(() => validateFileDocument(source, [])).toThrow('Text layout cannot override text sizing')
  })
})
