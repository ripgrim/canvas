// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { documentStore } from './document-store'
import { ComponentMasterProperties } from './ComponentMasterProperties'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

function setInputValue(input: HTMLInputElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input?.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('COMP-V2-UI-013 focused component authoring', () => {
  it('keeps shared authoring on the selected master instead of the instance inspector', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('shared-component-scope', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Card')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    expect(documentStore.commands.components.addMaterial(definition.id)).not.toBeNull()

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    expect(host.textContent).toContain('Properties')
    expect(host.textContent).toContain('Materials')
    expect(host.textContent).toContain('Layer materials')
    expect(host.textContent).not.toContain('Shared properties')
    expect(host.textContent).not.toContain('Shared materials')
  })

  it('shows usable options in the inspector and creates definitions only after dialog save', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-authoring', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const propertyId = documentStore.commands.components.addProperty(definition.id, 'variant')!
    const hoverId = documentStore.commands.components.addVariantValue(definition.id, propertyId)!
    const variant = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)!
    if (variant.type !== 'variant') throw new Error('Expected variant')
    expect(documentStore.commands.components.setProperty(definition.id, { ...variant, name: 'State', values: variant.values.map(option => option.id === hoverId ? { ...option, name: 'Hover' } : option) })).toBe(true)
    expect(documentStore.commands.components.setInteraction(definition.id, 'pointer-hover', propertyId, hoverId)).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    const stateSelect = host.querySelector<HTMLButtonElement>('#component-property-' + propertyId + '-current')
    expect(stateSelect?.textContent).toContain('Hover')
    await act(async () => { stateSelect?.click() })
    expect([...host.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.textContent?.replace('✓', '').trim())).toEqual(['Default', 'Hover'])
    const defaultOption = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Default'))
    await act(async () => { defaultOption?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)).toMatchObject({ currentValueId: variant.defaultValueId })
    expect(host.querySelector('.component-definition-row')?.textContent).toContain('StateVariant · 2 optionsButton · Default appearanceCanvas edits')
    expect(host.querySelector('.component-definition-row [data-icon="component"]')).not.toBeNull()
    expect(host.querySelector('.component-definition-row')?.textContent).not.toContain('On hover')

    const editState = host.querySelector<HTMLButtonElement>('[aria-label="Edit State"]')
    await act(async () => { editState?.click() })
    expect(host.querySelector<HTMLInputElement>('#component-property-dialog-description')?.maxLength).toBe(500)
    expect(host.querySelector('#component-property-dialog-current')).toBeNull()
    const addOption = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add option')
    await act(async () => { addOption?.click() })
    expect([...host.querySelectorAll<HTMLInputElement>('[id^="component-property-dialog-option-"]')].at(-1)?.value).toBe('Option 3')
    expect(host.querySelector<HTMLButtonElement>('#component-property-dialog-default')?.textContent).toContain('Default')
    expect(host.textContent).toContain('Hover shows')
    expect(host.textContent).toContain('Press shows')
    await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('#component-property-dialog-description'), 'Visual interaction state.') })
    const saveProperty = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')
    await act(async () => { saveProperty?.click() })
    const savedStateSelect = host.querySelector<HTMLButtonElement>('#component-property-' + propertyId + '-current')
    expect(savedStateSelect?.textContent).toContain('Default')
    const savedProperty = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)
    expect(savedProperty).toMatchObject({ currentValueId: variant.defaultValueId, description: 'Visual interaction state.' })
    if (savedProperty?.type !== 'variant') throw new Error('Expected saved variant')
    const optionThree = savedProperty.values.find(option => option.name === 'Option 3')
    expect(optionThree).toBeDefined()
    await act(async () => { savedStateSelect?.click() })
    const optionThreeChoice = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Option 3'))
    await act(async () => { optionThreeChoice?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)).toMatchObject({ currentValueId: optionThree?.id })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Edit State"]')?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)).toMatchObject({ currentValueId: optionThree?.id })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Remove Option 3"]')?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)).toMatchObject({ currentValueId: optionThree?.id })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)).toMatchObject({ currentValueId: variant.defaultValueId })
    expect(host.querySelector<HTMLButtonElement>('#component-property-' + propertyId + '-current')?.textContent).toContain('Default')

    const before = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.length
    const add = host.querySelector<HTMLButtonElement>('[aria-label="Add property"]')
    await act(async () => { add?.click() })
    const textChoice = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Text')
    const slotChoice = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Slot')
    const booleanChoice = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Boolean')
    const variantChoice = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Variant')
    const swapChoice = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Instance swap')
    expect(variantChoice?.querySelector('[data-icon="component"]')).not.toBeNull()
    expect(textChoice?.querySelector('[data-icon="text"]')).not.toBeNull()
    expect(booleanChoice?.querySelector('[data-icon="check"]')).not.toBeNull()
    expect(slotChoice?.querySelector('[data-icon="frame"]')).not.toBeNull()
    expect(swapChoice?.querySelector('[data-icon="component"]')).not.toBeNull()
    expect(textChoice?.disabled).toBe(true)
    expect(slotChoice?.disabled).toBe(true)
    expect(swapChoice?.disabled).toBe(true)
    expect(booleanChoice?.disabled).toBe(false)
    expect(textChoice?.title).toBe('This component has no text layer to bind.')
    expect(slotChoice?.title).toBe('This component has no frame layer to use as a slot.')
    expect(swapChoice?.title).toBe('This component has no nested canvas component to swap.')
    expect(booleanChoice?.title).toBe('')
    await act(async () => { booleanChoice?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties).toHaveLength(before)
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('New property')
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')
    await act(async () => { save?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties).toHaveLength(before + 1)
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.at(-1)).toMatchObject({ type: 'boolean', binding: { kind: 'visibility', nodeId: definition.source.kind === 'canvas' ? definition.source.masterRootId : '' } })
    await act(async () => { expect(documentStore.undo()).toBe(true) })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties).toHaveLength(before)

    const savedVariant = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)!
    if (savedVariant.type !== 'variant') throw new Error('Expected variant')
    const unboundVariant = { ...savedVariant }
    delete unboundVariant.binding
    await act(async () => { expect(documentStore.commands.components.setProperty(definition.id, unboundVariant)).toBe(true) })
    expect(host.querySelector('.component-definition-row')?.textContent).toContain('Unbound')
    expect(host.querySelector('.component-definition-row')?.textContent).not.toContain('Layer · No layer')
    expect(host.querySelector<HTMLButtonElement>('#component-property-' + propertyId + '-current')?.disabled).toBe(true)
    const bind = host.querySelector<HTMLButtonElement>('[aria-label="Bind State"]')
    expect(bind?.textContent).toBe('Bind')
    await act(async () => { bind?.click() })
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Bind property')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')?.click() })
    await act(async () => { expect(documentStore.undo()).toBe(true) })
    expect(host.querySelector<HTMLButtonElement>('#component-property-' + propertyId + '-current')?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Edit State"]')?.textContent).toBe('Edit')
  })

  it('captures Text and Boolean defaults from the selected layer', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-property-defaults', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    documentStore.commands.insertCanvas('text', { x: 8, y: 8, parentId: masterId })
    const textId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.rename(textId, 'Label')).toBe(true)
    expect(documentStore.commands.setText(textId, 'Existing label')).toBe(true)
    documentStore.commands.insertCanvas('rectangle', { x: 8, y: 48, parentId: masterId })
    const hiddenId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.rename(hiddenId, 'Hidden control')).toBe(true)
    expect(documentStore.commands.appearance.setBlending([hiddenId], { visible: false })).toBe(true)
    documentStore.select(masterId)
    expect(documentStore.commands.components.createFromSelection('Card')).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    const addProperty = async (type: string) => {
      await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add property"]')?.click() })
      const choice = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === type)
      await act(async () => { choice?.click() })
    }

    await addProperty('Text')
    expect(host.querySelector<HTMLInputElement>('#component-property-dialog-default')?.value).toBe('Existing label')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')?.click() })
    expect(documentStore.getSnapshot().file!.nodes[textId]).toMatchObject({ text: 'Existing label' })

    await addProperty('Boolean')
    await act(async () => { host.querySelector<HTMLButtonElement>('#component-property-dialog-layer')?.click() })
    const hidden = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Hidden control'))
    await act(async () => { hidden?.click() })
    expect(host.querySelector<HTMLInputElement>('#component-property-dialog-default')?.checked).toBe(false)
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')?.click() })
    const hiddenNode = documentStore.getSnapshot().file!.nodes[hiddenId]
    if (!hiddenNode || hiddenNode.type === 'root') throw new Error('Expected hidden component layer')
    expect(hiddenNode.appearance?.visible).toBe(false)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    expect(definition.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', defaultValue: 'Existing label', binding: { kind: 'text', nodeId: textId } }),
      expect.objectContaining({ type: 'boolean', defaultValue: false, binding: { kind: 'visibility', nodeId: hiddenId } }),
    ]))
  })

  it('COMP-V2-UI-071 captures the selected layer when rebinding a property', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-property-rebinding-default', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    documentStore.commands.insertCanvas('text', { x: 8, y: 8, parentId: masterId })
    const primaryId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.rename(primaryId, 'Primary label')).toBe(true)
    expect(documentStore.commands.setText(primaryId, 'Primary')).toBe(true)
    documentStore.commands.insertCanvas('text', { x: 8, y: 40, parentId: masterId })
    const secondaryId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.rename(secondaryId, 'Secondary label')).toBe(true)
    expect(documentStore.commands.setText(secondaryId, 'Secondary')).toBe(true)
    documentStore.select(masterId)
    expect(documentStore.commands.components.createFromSelection('Field')).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add property"]')?.click() })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Text')?.click() })
    expect(host.querySelector<HTMLInputElement>('#component-property-dialog-default')?.value).toBe('Primary')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')?.click() })

    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const property = definition.properties.find(candidate => candidate.type === 'text')
    if (!property || property.type !== 'text') throw new Error('Expected text property')
    await act(async () => { host.querySelector<HTMLButtonElement>(`[aria-label="Edit ${property.name}"]`)?.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('#component-property-dialog-layer')?.click() })
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map(option => option.textContent)).toContain('Secondary')
    const secondary = options.find(option => option.textContent?.includes('Secondary'))
    await act(async () => { secondary?.click() })
    expect(host.querySelector<HTMLInputElement>('#component-property-dialog-default')?.value).toBe('Secondary')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')?.click() })

    const rebound = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(candidate => candidate.id === property.id)
    expect(rebound).toMatchObject({ type: 'text', defaultValue: 'Secondary', binding: { kind: 'text', nodeId: secondaryId } })
  })

  it('COMP-V2-UI-060 offers Edit instead of a false Bind when no compatible layer exists', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-unbindable-property', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const propertyId = documentStore.commands.components.addProperty(definition.id, 'text')!
    const property = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(candidate => candidate.id === propertyId)!
    if (property.type !== 'text') throw new Error('Expected text property')
    expect(documentStore.commands.components.setProperty(definition.id, { ...property, name: 'Label' })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    expect(host.querySelector('[aria-label="Bind Label"]')).toBeNull()
    const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit Label"]')
    expect(edit?.textContent).toBe('Edit')
    await act(async () => { edit?.click() })
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Edit property')
    expect(host.querySelector('#component-property-dialog-layer')).toBeNull()
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')?.click() })

    await act(async () => {
      documentStore.commands.insertCanvas('text', { x: 8, y: 8, parentId: definition.source.kind === 'canvas' ? definition.source.masterRootId : '' })
      documentStore.select(definition.source.kind === 'canvas' ? definition.source.masterRootId : '')
    })
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Bind Label"]')?.textContent).toBe('Bind')
  })

  it('COMP-V2-UI-052 binds an existing Variant from the selected layer in one undoable transaction', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-variant-binding', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const propertyId = documentStore.commands.components.addProperty(definition.id, 'variant')!
    const hoverId = documentStore.commands.components.addVariantValue(definition.id, propertyId)!
    const variant = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)!
    if (variant.type !== 'variant') throw new Error('Expected variant')
    expect(documentStore.commands.components.setProperty(definition.id, {
      ...variant,
      name: 'State',
      values: variant.values.map(option => option.id === hoverId ? { ...option, name: 'Hover' } : option),
    })).toBe(true)
    const boundVariant = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)!
    if (boundVariant.type !== 'variant') throw new Error('Expected variant')
    const unboundVariant = { ...boundVariant }
    delete unboundVariant.binding
    expect(documentStore.commands.components.setProperty(definition.id, unboundVariant)).toBe(true)
    expect(documentStore.commands.appearance.setBlending([masterId], { opacity: 0.42 })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Bind State"]')?.click() })
    expect(host.querySelector<HTMLButtonElement>('#component-property-dialog-layer')?.textContent).toContain('Button')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')?.click() })

    const rebound = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)!
    if (rebound.type !== 'variant' || !rebound.binding) throw new Error('Expected bound variant')
    expect(rebound.binding.nodeId).toBe(masterId)
    expect(Object.keys(rebound.binding.appearances)).toEqual(rebound.values.map(value => value.id))
    for (const value of rebound.values) expect(rebound.binding.appearances[value.id]).toMatchObject({ opacity: 0.42 })
    expect(host.querySelector<HTMLButtonElement>('#component-property-' + propertyId + '-current')?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Edit State"]')?.textContent).toBe('Edit')
    expect(host.querySelector('.component-definition-row')?.textContent).toContain('Button · Hover appearance')

    await act(async () => { expect(documentStore.undo()).toBe(true) })
    const restored = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)!
    expect(restored).not.toHaveProperty('binding')
    expect(host.querySelector<HTMLButtonElement>('#component-property-' + propertyId + '-current')?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Bind State"]')?.textContent).toBe('Bind')
  })

  it('COMP-V2-UI-077 allows two Variant axes to bind the same real layer', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-compound-variant-binding', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const componentId = Object.keys(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    expect(documentStore.commands.components.addProperty(componentId, 'variant')).not.toBeNull()
    const toneId = documentStore.commands.components.addProperty(componentId, 'variant')!
    const tone = documentStore.getSnapshot().file!.componentModel.definitions[componentId]!.properties.find(property => property.id === toneId)!
    if (tone.type !== 'variant') throw new Error('Expected Tone Variant')
    const unboundTone = { ...tone }
    delete unboundTone.binding
    expect(documentStore.commands.components.setProperty(componentId, unboundTone)).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    await act(async () => { host.querySelector<HTMLButtonElement>(`[aria-label="Bind ${tone.name}"]`)?.click() })
    expect(host.querySelector<HTMLButtonElement>('#component-property-dialog-layer')?.textContent).toContain('Button')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save property')?.click() })

    const definition = documentStore.getSnapshot().file!.componentModel.definitions[componentId]!
    const boundNodeIds = definition.properties.flatMap(property => property.type === 'variant' && property.binding ? [property.binding.nodeId] : [])
    expect(boundNodeIds).toEqual([masterId, masterId])
    expect(definition.variantAppearances?.[masterId]).toBeDefined()
  })

  it('creates a reusable material without silently assigning its appearance source', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('material-definition', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    documentStore.commands.insertCanvas('rectangle', { x: 8, y: 8, parentId: masterId })
    const innerId = documentStore.getSnapshot().selection[0]!
    documentStore.select(masterId)
    expect(documentStore.commands.components.createFromSelection('Card')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add material"]')?.click() })
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Appearance source')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save material')?.click() })

    const saved = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!
    expect(saved.materials).toHaveLength(1)
    expect(saved.parts).toEqual([])
    expect(host.querySelector('[aria-label="Layers"]')?.textContent).toContain('Not assigned')
    expect(host.querySelector<HTMLButtonElement>(`#component-part-${masterId}-material`)?.textContent).toContain('No material')
    expect(host.querySelector<HTMLButtonElement>(`#component-part-${innerId}-material`)?.textContent).toContain('No material')
  })

  it('renders materials in their authored groups without reordering definitions inside each group', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('material-groups', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    documentStore.commands.insertCanvas('rectangle', { x: 8, y: 8, parentId: masterId })
    const innerId = documentStore.getSnapshot().selection[0]!
    documentStore.select(masterId)
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const first = documentStore.commands.components.addMaterial(definition.id, masterId)!
    const second = documentStore.commands.components.addMaterial(definition.id, innerId)!
    expect(documentStore.commands.components.setMaterial(definition.id, first, { name: 'Base', group: 'Layers' })).toBe(true)
    expect(documentStore.commands.components.setMaterial(definition.id, second, { name: 'Hover', group: 'Interaction' })).toBe(true)
    const third = documentStore.commands.components.addMaterial(definition.id, innerId)!
    expect(documentStore.commands.components.setMaterial(definition.id, third, { name: 'Pressed', group: 'Interaction' })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    const groups = [...host.querySelectorAll<HTMLElement>('.component-definition-group')]
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Layers', 'Interaction'])
    expect([...groups[0]!.querySelectorAll('[aria-label^="Edit "]')].map(action => action.getAttribute('aria-label'))).toEqual(['Edit Base'])
    expect([...groups[1]!.querySelectorAll('[aria-label^="Edit "]')].map(action => action.getAttribute('aria-label'))).toEqual(['Edit Hover', 'Edit Pressed'])
    expect(groups[0]!.textContent).toContain('1 layer')
    expect(groups[1]!.textContent).toContain('Not assigned')
    expect(groups[1]!.textContent).toContain('1 layer')
  })

  it('starts a new material in the component\'s existing group', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('material-group-default', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.components.createFromSelection('Menu')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const materialId = documentStore.commands.components.addMaterial(definition.id, masterId)!
    expect(documentStore.commands.components.setMaterial(definition.id, materialId, { name: 'Hover', group: 'Interaction' })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add material"]')?.click() })
    expect(host.querySelector<HTMLInputElement>('#component-material-dialog-group')?.value).toBe('Interaction')
    await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('#component-material-dialog-group'), 'interaction') })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save material')?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.materials.at(-1)?.group).toBe('Interaction')
  })

  it('keeps material capture in the dialog draft until Save', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('material-authoring', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    documentStore.commands.insertCanvas('rectangle', { x: 8, y: 8, parentId: masterId })
    const innerId = documentStore.getSnapshot().selection[0]!
    documentStore.select(masterId)
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const materialId = documentStore.commands.components.addMaterial(definition.id)!
    expect(documentStore.commands.appearance.setBlending([masterId], { opacity: 0.25 })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    const innerMaterial = host.querySelector<HTMLButtonElement>(`#component-part-${innerId}-material`)
    expect(innerMaterial?.textContent).toContain('No material')
    await act(async () => { innerMaterial?.click() })
    expect(host.querySelector('[role="group"][aria-label="Layers"]')?.textContent).toContain('Material')
    const materialOption = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Material'))
    await act(async () => { materialOption?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: masterId, materialId }),
      expect.objectContaining({ nodeId: innerId, materialId }),
    ]))

    const openMaterial = async () => {
      const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit Material"]')
      await act(async () => { edit?.click() })
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Edit material')
    }
    await openMaterial()
    const beforeCapture = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!
    const update = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use current appearance')
    await act(async () => { update?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.revision).toBe(beforeCapture.revision)
    const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')
    await act(async () => { cancel?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.materials.find(material => material.id === materialId)?.appearance.opacity).not.toBe(0.25)

    await openMaterial()
    await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('#component-material-dialog-description'), 'Quiet surface') })
    const saveMetadata = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save material')
    await act(async () => { saveMetadata?.click() })
    expect(documentStore.getSnapshot().file!.nodes[masterId]).toMatchObject({ appearance: { opacity: 0.25 } })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.materials.find(material => material.id === materialId)).toMatchObject({ description: 'Quiet surface' })
    expect(host.querySelector('[aria-label="Edit Material"]')?.closest('.component-definition-row')?.textContent).toContain('Quiet surface')
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.materials.find(material => material.id === materialId)?.appearance.opacity).not.toBe(0.25)

    await openMaterial()
    const updateAgain = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use current appearance')
    await act(async () => { updateAgain?.click() })
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save material')
    await act(async () => { save?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.materials.find(material => material.id === materialId)?.appearance.opacity).toBe(0.25)
    const inner = documentStore.getSnapshot().file!.nodes[innerId]
    if (!inner || inner.type === 'root') throw new Error('Expected material part')
    expect(inner.appearance?.opacity).toBe(0.25)
  })

  it('COMP-V2-UI-070 captures a newly selected appearance source without a second action', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('material-source-selection', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    documentStore.commands.insertCanvas('rectangle', { x: 8, y: 8, parentId: masterId })
    const faceId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.rename(faceId, 'Face')).toBe(true)
    documentStore.select(masterId)
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const materialId = documentStore.commands.components.addMaterial(definition.id, masterId)!
    expect(documentStore.commands.appearance.setBlending([faceId], { opacity: 0.4 })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Edit Material"]')?.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('#component-material-dialog-layer')?.click() })
    const face = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Face'))
    await act(async () => { face?.click() })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save material')?.click() })

    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.materials.find(material => material.id === materialId)?.appearance.opacity).toBe(0.4)
    const master = documentStore.getSnapshot().file!.nodes[masterId]
    if (!master || master.type === 'root') throw new Error('Expected material part')
    expect(master.appearance?.opacity).toBe(0.4)
  })

  it('COMP-V2-UI-076 authors Instance swap only from a nested canvas component', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('instance-swap-authoring', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 320, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Badge')).toBe(true)
    const badge = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(candidate => candidate.name === 'Badge')!
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const button = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(candidate => candidate.name === 'Button')!
    if (button.source.kind !== 'canvas') throw new Error('Expected canvas Button')
    expect(documentStore.commands.components.place(badge.id)).toBe(true)
    const nestedId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.move(nestedId, { parentId: button.source.masterRootId, index: 0 })).toBe(true)
    documentStore.select(button.source.masterRootId)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentMasterProperties)) })

    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add property"]')?.click() })
    const choice = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Instance swap')
    expect(choice?.disabled).toBe(false)
    expect(choice?.querySelector('[data-icon="component"]')).not.toBeNull()
    await act(async () => { choice?.click() })

    const layer = host.querySelector<HTMLButtonElement>('#component-property-dialog-layer')
    expect(layer?.textContent).toContain('Badge')
    await act(async () => { layer?.click() })
    const badgeOption = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Badge'))
    expect(badgeOption?.querySelector('[data-icon="component"]')).not.toBeNull()
    await act(async () => { badgeOption?.click() })
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Default valueBadge')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === 'Save property')?.click() })

    const saved = documentStore.getSnapshot().file!.componentModel.definitions[button.id]!.properties.find(property => property.type === 'instance-swap')
    expect(saved).toMatchObject({ type: 'instance-swap', defaultValue: badge.id, binding: { kind: 'instance-swap', nodeId: nestedId } })
    const row = host.querySelector<HTMLButtonElement>('[aria-label="Edit Property"]')?.closest('.component-definition-row')
    expect(row?.textContent).toContain('PropertyInstance swapLayer · BadgeDefault valueBadge')
    expect(row?.querySelector('[data-icon="component"]')).not.toBeNull()

    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add property"]')?.click() })
    const unavailable = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Instance swap')
    expect(unavailable?.disabled).toBe(true)
    expect(unavailable?.title).toBe('This component has no nested canvas component to swap.')
  })
})
