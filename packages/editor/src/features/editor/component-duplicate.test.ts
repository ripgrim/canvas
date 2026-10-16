import { describe, expect, it } from 'vitest'
import { legacyTextProperties } from '@canvas/repo-engine/file-document'
import type { FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import type { ComponentDefinition, ComponentPropertyDefinition } from '@canvas/repo-engine/component-model'
import { componentDuplicatePlanCurrent, planComponentDuplicate } from './component-duplicate'

const solid = (id: string, hex: string) => ({ id, type: 'solid' as const, color: { kind: 'literal' as const, color: { kind: 'hex' as const, hex } } })
const frame = (id: string, name: string, x: number, y: number, width: number, height: number) => ({
  id, type: 'frame' as const, name, styles: { relativeTransform: [1, 0, 0, 1, x, y] as const, width, height, overflow: 'visible' as const }, appearance: {},
})
const rectangle = (id: string, name: string, x: number, y: number, width: number, height: number, color: string) => ({
  id, type: 'rectangle' as const, name, styles: { relativeTransform: [1, 0, 0, 1, x, y] as const, width, height }, appearance: { fills: [solid(`${id}-fill`, color)] },
})

const fixture = (): FileDocument => ({
  schemaVersion: 13,
  fileId: 'component-duplicate-file',
  revision: 12,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    'icon-master': frame('icon-master', 'Icon', 40, 40, 20, 20),
    'icon-glyph': rectangle('icon-glyph', 'Glyph', 2, 2, 16, 16, '#111111'),
    'button-master': frame('button-master', 'Button', 300, 40, 100, 40),
    face: rectangle('face', 'Face', 0, 0, 100, 40, '#0055ff'),
    label: { id: 'label', type: 'text', name: 'Label', text: 'Continue', ...legacyTextProperties(), styles: { relativeTransform: [1, 0, 0, 1, 12, 10], width: 60, height: 20 }, appearance: { fills: [solid('label-fill', '#ffffff')] } },
    'icon-use': frame('icon-use', 'Icon', 76, 10, 20, 20),
    'icon-use-glyph': rectangle('icon-use-glyph', 'Glyph', 2, 2, 16, 16, '#111111'),
    'button-instance': frame('button-instance', 'Button', 300, 140, 100, 40),
    'instance-face': rectangle('instance-face', 'Face', 0, 0, 100, 40, '#ff00aa'),
    'instance-label': { id: 'instance-label', type: 'text', name: 'Label', text: 'Go', ...legacyTextProperties(), styles: { relativeTransform: [1, 0, 0, 1, 12, 10], width: 60, height: 20 }, appearance: { fills: [solid('instance-label-fill', '#ffffff')], visible: false } },
    'instance-icon': frame('instance-icon', 'Icon', 76, 10, 20, 20),
    'instance-icon-glyph': rectangle('instance-icon-glyph', 'Glyph', 2, 2, 16, 16, '#111111'),
    'instance-slot': { id: 'instance-slot', type: 'text', name: 'Slot content', text: 'Extra', ...legacyTextProperties(), styles: { relativeTransform: [1, 0, 0, 1, 0, 44], width: 60, height: 20 }, appearance: {} },
  },
  relationships: {
    'icon-master': { parentId: 'root', orderKey: 'A' },
    'icon-glyph': { parentId: 'icon-master', orderKey: 'A' },
    'button-master': { parentId: 'root', orderKey: 'B' },
    face: { parentId: 'button-master', orderKey: 'A' },
    label: { parentId: 'button-master', orderKey: 'B' },
    'icon-use': { parentId: 'button-master', orderKey: 'C' },
    'icon-use-glyph': { parentId: 'icon-use', orderKey: 'A' },
    'button-instance': { parentId: 'root', orderKey: 'C' },
    'instance-face': { parentId: 'button-instance', orderKey: 'A' },
    'instance-label': { parentId: 'button-instance', orderKey: 'B' },
    'instance-icon': { parentId: 'button-instance', orderKey: 'C' },
    'instance-icon-glyph': { parentId: 'instance-icon', orderKey: 'A' },
    'instance-slot': { parentId: 'button-instance', orderKey: 'D', slot: 'content' },
  },
  theme: { tokens: {} },
  componentModel: {
    definitions: {
      icon: { id: 'icon', name: 'Icon', source: { kind: 'canvas', masterRootId: 'icon-master' }, revision: 3, properties: [], materials: [], parts: [], interactions: [] },
      button: {
        id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'button-master' }, revision: 8,
        properties: [
          { id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', currentValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'face', appearances: { default: { fills: [solid('default-fill', '#0055ff')] }, hover: { fills: [solid('hover-fill', '#ff00aa')] } } } },
          { id: 'label-property', name: 'Label', type: 'text', defaultValue: 'Continue', binding: { kind: 'text', nodeId: 'label' } },
          { id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'label' } },
          { id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'button-master' } },
          { id: 'icon-property', name: 'Icon', type: 'instance-swap', defaultValue: 'icon', binding: { kind: 'instance-swap', nodeId: 'icon-use' } },
        ],
        materials: [{ id: 'surface', group: 'Interaction', name: 'Surface', description: 'Button face', appearance: { fills: [solid('surface-fill', '#0055ff')] } }],
        parts: [{ id: 'face-part', name: 'Face', nodeId: 'face', materialId: 'surface' }, { id: 'label-part', name: 'Label', nodeId: 'label' }],
        interactions: [{ id: 'hover-interaction', trigger: 'pointer-hover', propertyId: 'state', valueId: 'hover', transition: { type: 'smart-animate', durationMs: 180, easing: 'ease-out' } }],
        variantAppearances: { face: { 'state=default': { fills: [solid('tuple-default-fill', '#0055ff')] }, 'state=hover': { fills: [solid('tuple-hover-fill', '#ff00aa')] } } },
        docs: { slug: 'button', description: 'Primary action' },
      },
    },
    instances: {
      'icon-use': { id: 'icon-use', componentId: 'icon', values: {} },
      'button-instance': { id: 'button-instance', componentId: 'button', values: { state: 'hover', 'label-property': 'Go', visible: false, 'icon-property': 'icon' } },
      'instance-icon': { id: 'instance-icon', componentId: 'icon', values: {} },
    },
  },
})

const ids = () => { let index = 0; return () => `fresh-${++index}` }

describe('canvas component semantic duplication', () => {
  it('[COMP-V2-UI-078] clones a master as an independent complete semantic graph while existing instances stay linked to the source', () => {
    const source = fixture()
    const sourceSnapshot = structuredClone(source)
    const plan = planComponentDuplicate({ file: source, nodeId: 'button-master', atoms: [], makeId: ids(), offset: { x: 120, y: 0 } })
    expect(plan).not.toBeNull()
    expect(source).toEqual(sourceSnapshot)
    expect(plan!.rootId).toBe('fresh-1')
    expect(plan!.file.componentModel.definitions['fresh-6']).toEqual({
      id: 'fresh-6', name: 'Button copy', source: { kind: 'canvas', masterRootId: 'fresh-1' }, revision: 0,
      properties: [
        { id: 'fresh-7', name: 'State', type: 'variant', defaultValueId: 'fresh-8', currentValueId: 'fresh-8', values: [{ id: 'fresh-8', name: 'Default' }, { id: 'fresh-9', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'fresh-2', appearances: { 'fresh-8': { fills: [solid('default-fill', '#0055ff')] }, 'fresh-9': { fills: [solid('hover-fill', '#ff00aa')] } } } },
        { id: 'fresh-10', name: 'Label', type: 'text', defaultValue: 'Continue', binding: { kind: 'text', nodeId: 'fresh-3' } },
        { id: 'fresh-11', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'fresh-3' } },
        { id: 'fresh-12', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'fresh-1' } },
        { id: 'fresh-13', name: 'Icon', type: 'instance-swap', defaultValue: 'icon', binding: { kind: 'instance-swap', nodeId: 'fresh-4' } },
      ],
      materials: [{ id: 'fresh-14', group: 'Interaction', name: 'Surface', description: 'Button face', appearance: { fills: [solid('surface-fill', '#0055ff')] } }],
      parts: [{ id: 'fresh-15', name: 'Face', nodeId: 'fresh-2', materialId: 'fresh-14' }, { id: 'fresh-16', name: 'Label', nodeId: 'fresh-3' }],
      interactions: [{ id: 'fresh-17', trigger: 'pointer-hover', propertyId: 'fresh-7', valueId: 'fresh-9', transition: { type: 'smart-animate', durationMs: 180, easing: 'ease-out' } }],
      variantAppearances: { 'fresh-2': { 'fresh-7=fresh-8': { fills: [solid('tuple-default-fill', '#0055ff')] }, 'fresh-7=fresh-9': { fills: [solid('tuple-hover-fill', '#ff00aa')] } } },
      docs: { slug: 'button-copy', description: 'Primary action' },
    })
    expect(plan!.file.nodes['fresh-1']).toMatchObject({ id: 'fresh-1', name: 'Button copy', styles: { relativeTransform: [1, 0, 0, 1, 420, 40] } })
    expect(plan!.file.componentModel.instances['fresh-4']).toEqual({ id: 'fresh-4', componentId: 'icon', values: {} })
    expect(plan!.file.componentModel.instances['button-instance']).toEqual(source.componentModel.instances['button-instance'])
    expect(plan!.file.componentModel.definitions.button).toEqual(source.componentModel.definitions.button)
  })

  it('[COMP-V2-UI-078] plans the complete rich authoring graph used by the browser evidence flow', () => {
    const source = fixture()
    const button = source.componentModel.definitions.button!
    const state = button.properties.find(property => property.id === 'state')
    if (state?.type !== 'variant' || !state.binding) throw new Error('Expected bound State variant')
    const richState = {
      ...state,
      values: [...state.values, { id: 'pressed', name: 'Pressed' }],
      binding: { ...state.binding, appearances: { ...state.binding.appearances, pressed: { fills: [solid('pressed-fill', '#0055ff')] } } },
    }
    const tone: ComponentPropertyDefinition = {
      id: 'tone', name: 'Tone', type: 'variant', defaultValueId: 'tone-default', currentValueId: 'tone-danger',
      values: [{ id: 'tone-default', name: 'Default' }, { id: 'tone-danger', name: 'Danger' }],
      binding: { kind: 'variant', nodeId: 'face', appearances: {
        'tone-default': { fills: [solid('tone-default-fill', '#0055ff')] },
        'tone-danger': { fills: [solid('tone-danger-fill', '#00aa55')] },
      } },
    }
    const richButton: ComponentDefinition = {
      ...button,
      properties: [richState, tone, ...button.properties.filter(property => property.id !== state.id)],
      interactions: [...button.interactions, { id: 'press-interaction', trigger: 'pointer-press', propertyId: 'state', valueId: 'pressed', transition: { type: 'instant' } }],
      parts: [
        { id: 'face-part', name: 'Face', nodeId: 'face', materialId: 'surface' },
        { id: 'label-part', name: 'Label', nodeId: 'label', materialId: 'surface' },
      ],
      variantAppearances: { face: Object.fromEntries(richState.values.flatMap(stateValue => ['tone-default', 'tone-danger'].map(toneValue => [
        `state=${stateValue.id}|tone=${toneValue}`,
        { fills: [solid(`tuple-${stateValue.id}-${toneValue}`, toneValue === 'tone-danger' ? '#00aa55' : stateValue.id === 'hover' ? '#ff00aa' : '#0055ff')] },
      ]))) },
    }
    const richSource: FileDocument = { ...source, componentModel: { ...source.componentModel, definitions: { ...source.componentModel.definitions, button: richButton } } }

    const plan = planComponentDuplicate({ file: richSource, nodeId: 'button-master', atoms: [], makeId: ids(), offset: { x: 120, y: 0 } })
    expect(plan).not.toBeNull()
    const duplicate = Object.values(plan!.file.componentModel.definitions).find(definition => definition.id !== 'icon' && definition.id !== 'button')!
    expect(duplicate.properties.map(property => [property.type, property.name])).toEqual(richButton.properties.map(property => [property.type, property.name]))
    expect(Object.keys(duplicate.variantAppearances?.[duplicate.parts[0]!.nodeId] ?? {})).toHaveLength(6)
    expect(duplicate.interactions).toHaveLength(2)
    expect(duplicate.parts.every(part => part.materialId === duplicate.materials[0]!.id)).toBe(true)
  })

  it('[COMP-V2-UI-078] clones an instance with the same definition, sparse values, Slot content, and nested component identities', () => {
    const plan = planComponentDuplicate({ file: fixture(), nodeId: 'button-instance', atoms: [], makeId: ids() })
    expect(plan).not.toBeNull()
    expect(plan!.file.componentModel.instances['fresh-1']).toEqual({ id: 'fresh-1', componentId: 'button', values: { state: 'hover', 'label-property': 'Go', visible: false, 'icon-property': 'icon' } })
    expect(plan!.file.componentModel.instances['fresh-4']).toEqual({ id: 'fresh-4', componentId: 'icon', values: {} })
    expect(plan!.file.nodes['fresh-6']).toMatchObject({ id: 'fresh-6', type: 'text', text: 'Extra' })
    expect(plan!.file.relationships['fresh-6']).toEqual({ parentId: 'fresh-1', orderKey: 'D', slot: 'content' })
    expect(Object.keys(plan!.file.componentModel.definitions)).toEqual(['icon', 'button'])
  })

  it('[COMP-V2-UI-078] assigns an explicit collision-free docs identity when the source used an implicit fallback', () => {
    const source = fixture()
    ;(source.componentModel.definitions as Record<string, ComponentDefinition>)['reserved-docs'] = {
      id: 'reserved-docs', name: 'Different name', source: { kind: 'code', bindingId: 'reserved-binding' }, revision: 0,
      properties: [], materials: [], parts: [], interactions: [], docs: { slug: 'icon-copy' },
    }
    const plan = planComponentDuplicate({ file: source, nodeId: 'icon-master', atoms: [], makeId: ids() })
    expect(plan).not.toBeNull()
    expect(plan!.file.componentModel.definitions['fresh-3']).toEqual({
      id: 'fresh-3', name: 'Icon copy', source: { kind: 'canvas', masterRootId: 'fresh-1' }, revision: 0,
      properties: [], materials: [], parts: [], interactions: [], docs: { slug: 'icon-copy-2' },
    })
    expect(plan!.file.componentModel.definitions.icon).not.toHaveProperty('docs')
  })

  it('[COMP-V2-UI-NEG-005] rejects stale, incomplete, recursive, colliding, and over-limit plans without mutating input', () => {
    const source = fixture()
    const before = structuredClone(source)
    const plan = planComponentDuplicate({ file: source, nodeId: 'button-master', atoms: [], makeId: ids() })!
    const changed = structuredClone(source)
    const changedFace = changed.nodes.face
    if (!changedFace || changedFace.type === 'root') throw new Error('Expected Face node')
    ;(changed.nodes as Record<string, FileNode>).face = { ...changedFace, name: 'Changed without revision' }
    expect(componentDuplicatePlanCurrent(changed, plan)).toBe(false)
    expect(componentDuplicatePlanCurrent(source, plan)).toBe(true)

    expect(planComponentDuplicate({ file: source, nodeId: 'button-master', atoms: [], makeId: () => 'root' })).toBeNull()

    const incomplete = structuredClone(source)
    delete incomplete.relationships.face
    expect(planComponentDuplicate({ file: incomplete, nodeId: 'button-master', atoms: [], makeId: ids() })).toBeNull()

    const recursive = structuredClone(source)
    const button = recursive.componentModel.definitions.button!
    ;(recursive.componentModel.definitions as Record<string, ComponentDefinition>).button = { ...button, properties: button.properties.map(property => property.type === 'instance-swap' ? { ...property, defaultValue: 'button' } : property) }
    expect(planComponentDuplicate({ file: recursive, nodeId: 'button-master', atoms: [], makeId: ids() })).toBeNull()

    const overLimit = structuredClone(source)
    const overLimitDefinitions = overLimit.componentModel.definitions as Record<string, ComponentDefinition>
    for (let index = 0; index < 498; index += 1) overLimitDefinitions[`code-${index}`] = { id: `code-${index}`, name: `Code ${index}`, source: { kind: 'code', bindingId: `binding-${index}` }, revision: 0, properties: [], materials: [], parts: [], interactions: [] }
    expect(Object.keys(overLimit.componentModel.definitions)).toHaveLength(500)
    expect(planComponentDuplicate({ file: overLimit, nodeId: 'button-master', atoms: [], makeId: ids() })).toBeNull()
    expect(source).toEqual(before)
  })
})
