import { describe, expect, it } from 'vitest'
import { componentDefaultValues, componentDocsManifest, componentVariantCombinations, resolveComponentInstanceValues, validateComponentDefinition } from '../src/component-model.js'
import type { ComponentDefinition } from '../src/component-model.js'

const button = (): ComponentDefinition => ({
  id: 'component:button',
  name: 'Button',
  source: { kind: 'canvas', masterRootId: 'node:button-master' },
  revision: 1,
  properties: [
    { id: 'property:state', name: 'State', type: 'variant', defaultValueId: 'value:default', values: [{ id: 'value:default', name: 'Default' }, { id: 'value:hover', name: 'Hover' }] },
    { id: 'property:size', name: 'Size', type: 'variant', defaultValueId: 'value:small', values: [{ id: 'value:small', name: 'Small' }, { id: 'value:large', name: 'Large' }] },
    { id: 'property:label', name: 'Label', type: 'text', defaultValue: 'Continue' },
    { id: 'property:disabled', name: 'Disabled', type: 'boolean', defaultValue: false },
    { id: 'property:content', name: 'Content', type: 'slot' },
  ],
  materials: [{ id: 'material:quiet', group: 'Interaction', name: 'Quiet', description: 'Quiet hover and selected states', appearance: { opacity: 0.8 } }],
  parts: [{ id: 'part:face', name: 'Face', nodeId: 'node:button-face', materialId: 'material:quiet' }, { id: 'part:label', name: 'Label', nodeId: 'node:button-label' }],
  interactions: [{ id: 'interaction:hover', trigger: 'pointer-hover', propertyId: 'property:state', valueId: 'value:hover', transition: { type: 'smart-animate', durationMs: 300, easing: 'ease-out' } }],
  docs: { slug: 'button', description: 'Triggers an action.' },
})

describe('component model v2', () => {
  it('[COMP-V2-IDENTITY-001] keeps source identity separate from mutable source location', () => {
    const definition = button()
    const code = validateComponentDefinition({ ...definition, source: { kind: 'code', bindingId: 'binding:button' } })
    expect(code).toMatchObject({ id: 'component:button', source: { kind: 'code', bindingId: 'binding:button' } })
    expect(JSON.stringify(code)).not.toContain('path')
    expect(JSON.stringify(code)).not.toContain('exportName')
    expect(JSON.stringify(code)).not.toContain('sourceHash')
  })

  it('[COMP-V2-INSTANCE-001] resolves isolated instance values without mutating the definition or peers', () => {
    const definition = button()
    const defaults = componentDefaultValues(definition)
    const hovered = resolveComponentInstanceValues(definition, { 'property:state': 'value:hover', 'property:label': 'Save' })
    const disabled = resolveComponentInstanceValues(definition, { 'property:disabled': true })
    expect(hovered).toEqual({ ...defaults, 'property:state': 'value:hover', 'property:label': 'Save' })
    expect(disabled).toEqual({ ...defaults, 'property:disabled': true })
    expect(defaults).toEqual({ 'property:state': 'value:default', 'property:size': 'value:small', 'property:label': 'Continue', 'property:disabled': false })
  })

  it('[COMP-V2-INSTANCE-NEG-001] rejects unknown, slotted, and invalid scalar overrides', () => {
    const definition = button()
    expect(() => resolveComponentInstanceValues(definition, { missing: 'value' })).toThrow('missing scalar property')
    expect(() => resolveComponentInstanceValues(definition, { 'property:content': 'layer' })).toThrow('missing scalar property')
    expect(() => resolveComponentInstanceValues(definition, { 'property:state': 'value:pressed' })).toThrow('invalid variant value')
    expect(() => resolveComponentInstanceValues(definition, { 'property:disabled': 'true' })).toThrow('invalid boolean value')
  })

  it('[COMP-V2-MATERIAL-001] requires every part material and interaction target to resolve by stable id', () => {
    expect(validateComponentDefinition(button()).parts[0]).toMatchObject({ id: 'part:face', materialId: 'material:quiet' })
    expect(() => validateComponentDefinition({ ...button(), parts: [{ id: 'part:face', name: 'Face', nodeId: 'node:button-face', materialId: 'material:missing' }] })).toThrow('missing material')
    expect(() => validateComponentDefinition({ ...button(), interactions: [{ id: 'interaction:hover', trigger: 'pointer-hover', propertyId: 'property:state', valueId: 'value:missing' }] })).toThrow('missing variant value')
  })

  it('[COMP-V2-SHEET-001] derives the Blume playground controls and variant sheet from the same schema', () => {
    const definition = button()
    expect(componentVariantCombinations(definition)).toEqual([
      { 'property:state': 'value:default', 'property:size': 'value:small' },
      { 'property:state': 'value:default', 'property:size': 'value:large' },
      { 'property:state': 'value:hover', 'property:size': 'value:small' },
      { 'property:state': 'value:hover', 'property:size': 'value:large' },
    ])
    const manifest = componentDocsManifest(definition)
    expect(manifest).toMatchObject({ componentId: 'component:button', slug: 'button', source: 'canvas' })
    expect(manifest.controls.map(control => control.type)).toEqual(['variant', 'variant', 'text', 'boolean', 'slot'])
    expect(manifest.combinations).toHaveLength(4)
  })

  it('[COMP-V2-SHEET-NEG-001] bounds generated combinations instead of materializing an unbounded product', () => {
    expect(() => componentVariantCombinations(button(), 3)).toThrow('exceed the supported limit')
  })
})
