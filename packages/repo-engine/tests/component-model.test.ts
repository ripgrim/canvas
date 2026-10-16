import { describe, expect, it } from 'vitest'
import { applyComponentAuthoringCommand, componentDefaultValues, componentDescriptionLimit, componentDocsCatalog, componentDocsManifest, componentDocsSlug, componentVariantCombinationLabel, componentVariantCombinations, resolveComponentInstanceValues, validateComponentAuthoringCommand, validateComponentDefinition, validateComponentModelState } from '../src/component-model.js'
import type { ComponentDefinition } from '../src/component-model.js'
import { applyFileCommand, applyFileCommandWithHistory, createBlankFile } from '../src/file-document.js'
import type { FileDocument } from '../src/file-document.js'

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

const buttonFile = (): FileDocument => {
  const file = createBlankFile('file-1', 'page-1', 'root-1')
  file.nodes['node:button-master'] = { id: 'node:button-master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 40 } }
  file.nodes['node:button-face'] = { id: 'node:button-face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 40 } }
  file.nodes['node:button-label'] = { id: 'node:button-label', type: 'rectangle', name: 'Label', styles: { relativeTransform: [1, 0, 0, 1, 16, 10], width: 88, height: 20 } }
  file.relationships['node:button-master'] = { parentId: 'root-1', orderKey: 'V' }
  file.relationships['node:button-face'] = { parentId: 'node:button-master', orderKey: 'V' }
  file.relationships['node:button-label'] = { parentId: 'node:button-master', orderKey: 'W' }
  return file
}

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

  it('[COMP-V2-UI-076] validates and resolves a canvas-only Instance swap property by component definition id', () => {
    const icon = { ...button(), id: 'component:icon', name: 'Icon', source: { kind: 'canvas' as const, masterRootId: 'node:icon-master' }, properties: [], interactions: [] }
    const definition: ComponentDefinition = {
      ...button(),
      properties: [
        ...button().properties,
        { id: 'property:icon', name: 'Icon', type: 'instance-swap', defaultValue: icon.id, binding: { kind: 'instance-swap', nodeId: 'node:icon-instance' } },
      ],
    }
    expect(componentDefaultValues(definition)['property:icon']).toBe(icon.id)
    expect(resolveComponentInstanceValues(definition, { 'property:icon': 'component:alternate-icon' })['property:icon']).toBe('component:alternate-icon')
    const state = validateComponentModelState({
      definitions: { [definition.id]: definition, [icon.id]: icon, 'component:alternate-icon': { ...icon, id: 'component:alternate-icon', source: { kind: 'canvas', masterRootId: 'node:alternate-icon-master' } } },
      instances: { instance: { id: 'instance', componentId: definition.id, values: { 'property:icon': 'component:alternate-icon' } } },
    })
    expect(state.definitions[definition.id]!.properties.at(-1)).toEqual({ id: 'property:icon', name: 'Icon', type: 'instance-swap', defaultValue: icon.id, binding: { kind: 'instance-swap', nodeId: 'node:icon-instance' } })
    expect(state.instances.instance!.values['property:icon']).toBe('component:alternate-icon')
    expect(componentDocsManifest(definition).controls.at(-1)).toMatchObject({ type: 'instance-swap', defaultValue: icon.id })
  })

  it('[COMP-V2-UI-NEG-003] rejects malformed, unavailable, code-backed, duplicate, and recursive Instance swap references', () => {
    const icon = { ...button(), id: 'component:icon', name: 'Icon', source: { kind: 'canvas' as const, masterRootId: 'node:icon-master' }, properties: [], interactions: [] }
    const swap = { id: 'property:icon', name: 'Icon', type: 'instance-swap' as const, defaultValue: icon.id, binding: { kind: 'instance-swap' as const, nodeId: 'node:icon-instance' } }
    const owner = { ...button(), properties: [...button().properties, swap] }
    const { defaultValue: _missingDefault, ...withoutDefault } = swap
    expect(() => validateComponentDefinition({ ...owner, properties: [...button().properties, withoutDefault] })).toThrow('Invalid component property')
    expect(() => validateComponentDefinition({ ...owner, properties: [...button().properties, { ...swap, binding: { kind: 'text', nodeId: swap.binding.nodeId } }] })).toThrow('Invalid component property binding')
    expect(() => validateComponentDefinition({ ...owner, properties: [...button().properties, { ...swap, defaultValue: 'not an id' }] })).toThrow('Invalid Instance swap component id')
    expect(() => validateComponentDefinition({ ...owner, properties: [...button().properties, swap, { ...swap, id: 'property:icon-two', name: 'Icon two' }] })).toThrow('Duplicate component Instance swap binding')
    expect(() => validateComponentDefinition({ ...owner, source: { kind: 'code', bindingId: owner.id } })).toThrow('Code components cannot define Instance swap properties')
    expect(() => validateComponentModelState({ definitions: { [owner.id]: owner }, instances: {} })).toThrow('missing component definition')
    const codeIcon = { ...icon, source: { kind: 'code' as const, bindingId: icon.id } }
    expect(() => validateComponentModelState({ definitions: { [owner.id]: owner, [icon.id]: codeIcon }, instances: {} })).toThrow('requires a canvas component definition')
    expect(() => validateComponentModelState({ definitions: { [owner.id]: owner, [icon.id]: icon, code: { ...codeIcon, id: 'code', source: { kind: 'code', bindingId: 'code' } } }, instances: { instance: { id: 'instance', componentId: owner.id, values: { [swap.id]: 'code' } } } })).toThrow('requires a canvas component definition')
    expect(() => validateComponentModelState({ definitions: { [owner.id]: owner, [icon.id]: icon }, instances: { instance: { id: 'instance', componentId: owner.id, values: { [swap.id]: 'component:missing' } } } })).toThrow('missing component definition')
    expect(() => resolveComponentInstanceValues(owner, { [swap.id]: false })).toThrow('invalid Instance swap value')
    expect(() => validateComponentModelState({ definitions: { [owner.id]: { ...owner, properties: [...button().properties, { ...swap, defaultValue: owner.id }] }, [icon.id]: icon }, instances: {} })).toThrow('recursively')
    const ancestor = { ...icon, properties: [{ ...swap, id: 'property:owner', name: 'Owner', defaultValue: owner.id, binding: { ...swap.binding, nodeId: 'node:owner-instance' } }] }
    expect(() => validateComponentModelState({ definitions: { [owner.id]: owner, [icon.id]: ancestor }, instances: {} })).toThrow('recursively')
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
    expect(componentVariantCombinations(definition).map(combination => componentVariantCombinationLabel(definition, combination))).toEqual([
      'State: Default, Size: Small',
      'State: Default, Size: Large',
      'State: Hover, Size: Small',
      'State: Hover, Size: Large',
    ])
    expect(componentVariantCombinationLabel({ ...definition, properties: definition.properties.filter(property => property.type !== 'variant') }, {}, 'Base')).toBe('Base')
    const manifest = componentDocsManifest(definition)
    expect(manifest).toMatchObject({ componentId: 'component:button', slug: 'button', route: '/components/button', source: 'canvas', openInCanvas: { componentId: 'component:button' }, usage: { status: 'unavailable', reason: 'canvas-source' } })
    expect(manifest.controls.map(control => control.type)).toEqual(['variant', 'variant', 'text', 'boolean', 'slot'])
    expect(manifest.controls.map(control => control.defaultValue)).toEqual(['value:default', 'value:small', 'Continue', false, undefined])
    expect(componentDocsManifest({ ...definition, properties: definition.properties.map((property, index) => index === 0 ? { ...property, description: 'Pointer state.' } : property) }).controls[0]).toMatchObject({ name: 'State', description: 'Pointer state.' })
    expect(manifest.combinations).toHaveLength(4)
    expect(componentDocsSlug('  Primary button  ')).toBe('primary-button')
    expect(componentDocsSlug('按钮', 'component:button')).toBe('component-button')
  })

  it('[COMP-V2-SHEET-NEG-001] bounds generated combinations instead of materializing an unbounded product', () => {
    expect(() => componentVariantCombinations(button(), 3)).toThrow('exceed the supported limit')
  })

  it('[COMP-V2-PERSIST-001] validates a serialized definition and isolated instance record', () => {
    const definition = button()
    const state = validateComponentModelState({
      definitions: { [definition.id]: JSON.parse(JSON.stringify(definition)) },
      instances: { instance1: { id: 'instance1', componentId: definition.id, values: { 'property:label': 'Review', 'property:disabled': true } } },
    })
    expect(state.instances.instance1).toEqual({
      id: 'instance1', componentId: definition.id,
      values: { 'property:label': 'Review', 'property:disabled': true },
    })
  })

  it('[COMP-V2-UI-067] keeps authored descriptions inside the persisted model boundary', () => {
    const definition = button()
    expect(validateComponentDefinition({ ...definition, docs: { slug: 'button', description: 'x'.repeat(componentDescriptionLimit) } }).docs?.description).toHaveLength(componentDescriptionLimit)
    expect(() => validateComponentDefinition({ ...definition, docs: { slug: 'button', description: 'x'.repeat(componentDescriptionLimit + 1) } })).toThrow('Invalid component docs')
  })

  it('[COMP-V2-CODE-013] allows optional properties only on verified code definitions', () => {
    const definition = button()
    const optional = definition.properties.map((property, index) => index === 0 ? { ...property, optional: true as const } : property)
    expect(validateComponentDefinition({ ...definition, source: { kind: 'code', bindingId: definition.id }, properties: optional }).properties[0]).toMatchObject({ optional: true })
    expect(() => validateComponentDefinition({ ...definition, properties: optional })).toThrow('Canvas component properties cannot be optional')
    const control = componentDocsManifest({ ...definition, source: { kind: 'code', bindingId: definition.id }, properties: optional }).controls[0]!
    expect(control).toMatchObject({ optional: true })
    expect(Object.hasOwn(control, 'defaultValue')).toBe(false)
  })

  it('[COMP-V2-BINDING-001] validates typed canvas property bindings without accepting cross-type bindings', () => {
    const definition = button()
    const bound = validateComponentDefinition({ ...definition, properties: definition.properties.map(property => {
      if (property.type === 'text') return { ...property, binding: { kind: 'text', nodeId: 'node:button-label' } }
      if (property.type === 'boolean') return { ...property, binding: { kind: 'visibility', nodeId: 'node:button-face' } }
      if (property.type === 'slot') return { ...property, binding: { kind: 'slot', nodeId: 'node:button-master' } }
      return property
    }) })
    expect(bound.properties).toMatchObject([
      { type: 'variant' },
      { type: 'variant' },
      { type: 'text', binding: { kind: 'text', nodeId: 'node:button-label' } },
      { type: 'boolean', binding: { kind: 'visibility', nodeId: 'node:button-face' } },
      { type: 'slot', binding: { kind: 'slot', nodeId: 'node:button-master' } },
    ])
    expect(() => validateComponentDefinition({ ...definition, properties: definition.properties.map(property => property.type === 'text' ? { ...property, binding: { kind: 'visibility', nodeId: 'node:button-label' } } : property) })).toThrow('Invalid component property binding')
  })

  it('[COMP-V2-PERSIST-NEG-001] rejects malformed serialized definitions and orphaned instances', () => {
    expect(() => validateComponentDefinition({ ...button(), injected: true })).toThrow('Invalid component definition')
    expect(() => validateComponentDefinition({ ...button(), materials: [{ ...button().materials[0], appearance: { opacity: 2 } }] })).toThrow('Invalid node opacity')
    expect(() => validateComponentModelState({ definitions: {}, instances: { instance1: { id: 'instance1', componentId: 'component:missing', values: {} } } })).toThrow('missing definition')
    expect(() => validateComponentModelState({ definitions: { 'component:button': button() }, instances: { wrong: { id: 'instance1', componentId: 'component:button', values: {} } } })).toThrow('Invalid component instance')
  })

  it('[COMP-V2-AUTHOR-001] creates and replaces one complete master at checked revisions', () => {
    const created = { ...button(), revision: 0 }
    const initial = applyComponentAuthoringCommand({ definitions: {}, instances: {} }, { type: 'component.create', definition: created })
    const renamed = { ...created, revision: 1, name: 'Action' }
    const replaced = applyComponentAuthoringCommand(initial, { type: 'component.replace', componentId: created.id, expectedRevision: 0, definition: renamed })
    expect(replaced.definitions[created.id]).toEqual(renamed)
    expect(initial.definitions[created.id]).toEqual(created)
    expect(() => applyComponentAuthoringCommand(replaced, { type: 'component.replace', componentId: created.id, expectedRevision: 0, definition: renamed })).toThrow('changed before this edit')
    expect(() => applyComponentAuthoringCommand(initial, { type: 'component.replace', componentId: created.id, expectedRevision: 0, definition: { ...renamed, source: { kind: 'canvas', masterRootId: 'node:other' } } })).toThrow('source identity cannot change')
  })

  it('[COMP-V2-AUTHOR-NEG-001] admits only the closed authoring command schema', () => {
    const created = { ...button(), revision: 0 }
    expect(validateComponentAuthoringCommand({ type: 'component.create', definition: created })).toEqual({ type: 'component.create', definition: created })
    expect(() => validateComponentAuthoringCommand({ type: 'component.create', definition: created, injected: true })).toThrow('Invalid component authoring command')
    expect(() => validateComponentAuthoringCommand({ type: 'component.replace', componentId: created.id, expectedRevision: -1, definition: created })).toThrow('Invalid component authoring command')
  })

  it('[COMP-V2-HISTORY-001] applies component authoring through file history with checked undo and redo', () => {
    const created = { ...button(), revision: 0 }
    const start = buttonFile()
    const creation = applyFileCommandWithHistory(start, { type: 'component.create', definition: created }, [])
    expect(creation.file.revision).toBe(1)
    expect(creation.file.componentModel.definitions[created.id]).toEqual(created)
    const undone = applyFileCommand(creation.file, creation.undo, [])
    expect(undone.componentModel.definitions).toEqual({})
    const redone = applyFileCommand(undone, creation.redo, [])
    expect(redone.componentModel.definitions[created.id]).toEqual(created)

    const changedAtSameRevision = structuredClone(creation.file)
    ;(changedAtSameRevision.componentModel.definitions as Record<string, ComponentDefinition>)[created.id] = { ...created, name: 'Injected' }
    expect(() => applyFileCommand(changedAtSameRevision, creation.undo, [])).toThrow('changed before this edit')
  })

  it('[COMP-V2-AUTHOR-NEG-002] refuses deletion while an instance still owns the definition', () => {
    const definition = button()
    const state = validateComponentModelState({
      definitions: { [definition.id]: definition },
      instances: { instance1: { id: 'instance1', componentId: definition.id, values: {} } },
    })
    expect(() => applyComponentAuthoringCommand(state, { type: 'component.delete', componentId: definition.id, expectedRevision: definition.revision })).toThrow('Remove component instances')
  })

  it('[COMP-V2-INSTANCE-002] replaces only one instance and keeps unset values connected to master defaults', () => {
    const definition = button()
    const first = { id: 'instance:first', componentId: definition.id, values: { 'property:label': 'First' } }
    const second = { id: 'instance:second', componentId: definition.id, values: { 'property:label': 'Second' } }
    let state = validateComponentModelState({ definitions: { [definition.id]: definition }, instances: { [first.id]: first, [second.id]: second } })
    const changed = { ...first, values: { ...first.values, 'property:disabled': true } }
    state = applyComponentAuthoringCommand(state, { type: 'component.instance.replace', instanceId: first.id, expected: first, instance: changed })
    expect(state.instances[first.id]).toEqual(changed)
    expect(state.instances[second.id]).toEqual(second)
    expect(state.definitions[definition.id]).toEqual(definition)

    const nextDefinition = { ...definition, revision: 2, properties: definition.properties.map(property => property.id === 'property:disabled' && property.type === 'boolean' ? { ...property, defaultValue: true } : property) }
    state = applyComponentAuthoringCommand(state, { type: 'component.replace', componentId: definition.id, expectedRevision: 1, definition: nextDefinition })
    expect(resolveComponentInstanceValues(nextDefinition, state.instances[second.id]!.values)['property:disabled']).toBe(true)
    expect(state.instances[second.id]!.values).not.toHaveProperty('property:disabled')
  })

  it('[COMP-V2-INSTANCE-ORDER-001] accepts an unchanged expected instance after JSON storage reorders object keys', () => {
    const definition = button()
    const stored = { id: 'instance:first', values: { 'property:label': 'First' }, componentId: definition.id }
    const expected = { id: 'instance:first', componentId: definition.id, values: { 'property:label': 'First' } }
    const next = { ...expected, values: { 'property:label': 'Updated' } }
    const state = validateComponentModelState({ definitions: { [definition.id]: definition }, instances: { [stored.id]: stored } })
    const changed = applyComponentAuthoringCommand(state, { type: 'component.instance.replace', instanceId: stored.id, expected, instance: next })
    expect(changed.instances[stored.id]).toEqual(next)
  })

  it('[COMP-V2-INSTANCE-HISTORY-001] creates, edits, and restores instances through checked file history', () => {
    const definition = { ...button(), revision: 0 }
    const withDefinition = applyFileCommand(buttonFile(), { type: 'component.create', definition }, [])
    const instance = { id: 'instance:first', componentId: definition.id, values: { 'property:label': 'First' } }
    const withInstanceNode = structuredClone(withDefinition)
    withInstanceNode.nodes[instance.id] = { id: instance.id, type: 'frame', name: 'Button instance', styles: { relativeTransform: [1, 0, 0, 1, 160, 0], width: 120, height: 40 } }
    withInstanceNode.relationships[instance.id] = { parentId: 'root-1', orderKey: 'W' }
    const creation = applyFileCommandWithHistory(withInstanceNode, { type: 'component.instance.create', instance }, [])
    const changed = { ...instance, values: { 'property:label': 'Updated', 'property:disabled': true } }
    const edit = applyFileCommandWithHistory(creation.file, { type: 'component.instance.replace', instanceId: instance.id, expected: instance, instance: changed }, [])
    expect(edit.file.componentModel.instances[instance.id]).toEqual(changed)
    expect(applyFileCommand(edit.file, edit.undo, []).componentModel.instances[instance.id]).toEqual(instance)

    const stale = structuredClone(edit.file)
    ;(stale.componentModel.instances as Record<string, typeof instance>)[instance.id] = { ...instance, values: { 'property:label': 'Concurrent' } }
    expect(() => applyFileCommand(stale, edit.undo, [])).toThrow('changed before this edit')
  })

  it('[COMP-V2-DOCS-001] emits one deterministic Blume catalog from the component model', () => {
    const primary = { ...button(), source: { kind: 'code', bindingId: 'binding:button' } as const }
    const notice = { ...button(), id: 'component:notice', name: 'Notice', source: { kind: 'canvas', masterRootId: 'node:notice' } as const, docs: { slug: 'notice', description: 'Shows a short message.' } }
    const state = validateComponentModelState({ definitions: { [notice.id]: notice, [primary.id]: primary }, instances: {} })
    const usage = "import { Button } from '@comp/ui'\n\n<Button>Continue</Button>"
    const catalog = componentDocsCatalog(state, { [primary.id]: usage })
    expect(catalog.version).toBe(1)
    expect(catalog.navigation).toEqual([
      { title: 'Button', href: '/components/button', componentId: primary.id },
      { title: 'Notice', href: '/components/notice', componentId: notice.id },
    ])
    expect(catalog.components[0]!.usage).toEqual({ status: 'available', snippet: usage })
    expect(catalog.components[1]!.usage).toEqual({ status: 'unavailable', reason: 'canvas-source' })
  })

  it('[COMP-V2-DOCS-NEG-001] refuses ambiguous routes and invented usage sources', () => {
    const primary = button()
    const duplicate = { ...button(), id: 'component:duplicate', name: 'Duplicate', source: { kind: 'canvas', masterRootId: 'node:duplicate' } as const }
    const state = validateComponentModelState({ definitions: { [primary.id]: primary, [duplicate.id]: duplicate }, instances: {} })
    expect(() => componentDocsCatalog(state)).toThrow('Duplicate component docs slug')
    expect(() => componentDocsCatalog(validateComponentModelState({ definitions: { [primary.id]: primary }, instances: {} }), { missing: '<Missing />' })).toThrow('missing definition')
    expect(componentDocsManifest({ ...primary, source: { kind: 'code', bindingId: 'binding:button' } }).usage).toEqual({ status: 'unavailable', reason: 'source-adapter-required' })
  })
})
