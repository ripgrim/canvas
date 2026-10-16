// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { ComponentModelProperties } from './ComponentModelProperties'
import { connectedRegistryDefinitions } from './component-registry'
import { documentStore } from './document-store'
import type { Atom } from './types'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('COMP-V2-UI-003 instance overrides', () => {
  it('COMP-V2-UI-038 uses the semantic inspector for an adopted code node and keeps unsupported source values read-only', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const file = createBlankFile('adopted-code-properties', 'page', 'root')
    const button: Atom = {
      componentId: 'code-button', name: 'Button', exportName: 'Button', path: 'components/Button.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom',
      props: [{ name: 'label', type: 'string', optional: false }, { name: 'active', type: 'boolean', optional: true }, { name: 'tone', type: "'quiet' | 'solid'", optional: true }, { name: 'note', type: 'string', optional: true }, { name: 'count', type: 'number', optional: false }],
    }
    file.nodes.instance = { id: 'instance', type: 'component', componentId: button.componentId, exportName: button.exportName, props: { label: 'Continue', count: 3 } }
    file.relationships.instance = { parentId: 'root', orderKey: 'V' }
    documentStore.load(file, [button], { replace: true, pageId: 'page' })
    expect(documentStore.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions([button]), [button])).toBe(true)
    documentStore.select('instance')

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentModelProperties)) })

    expect(host.querySelector<HTMLInputElement>('#model-instance-property\\:label')?.value).toBe('Continue')
    expect(host.querySelector<HTMLButtonElement>('#model-instance-property\\:active')?.textContent).toContain('Component default')
    expect(host.querySelector<HTMLButtonElement>('#model-instance-property\\:tone')?.textContent).toContain('Component default')
    expect(host.querySelector<HTMLInputElement>('#model-instance-property\\:note')?.placeholder).toBe('Component default')
    expect(documentStore.getSnapshot().file!.nodes.instance).toMatchObject({ type: 'component', props: { label: 'Continue', count: 3 } })
    await act(async () => { host.querySelector<HTMLButtonElement>('#model-instance-property\\:active')?.click() })
    await act(async () => { [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('On'))?.click() })
    expect(documentStore.getSnapshot().file!.nodes.instance).toMatchObject({ type: 'component', props: { label: 'Continue', count: 3, active: true } })
    expect(documentStore.getSnapshot().file!.componentModel.instances.instance?.values['property:active']).toBe(true)
    await act(async () => { host.querySelector<HTMLButtonElement>('#model-instance-property\\:active')?.click() })
    await act(async () => { [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Component default'))?.click() })
    expect(documentStore.getSnapshot().file!.nodes.instance).toMatchObject({ type: 'component', props: { label: 'Continue', count: 3 } })
    expect(Object.hasOwn(documentStore.getSnapshot().file!.componentModel.instances.instance!.values, 'property:active')).toBe(false)
    expect(host.textContent).toContain('count3')
    expect(host.textContent).toContain('components/Button.tsx')
    expect(host.textContent).toContain('Button')
    expect(host.querySelector('#instance-instance-count')).toBeNull()
  })

  it('COMP-V2-UI-057 omits unbound canvas properties from instance controls', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('instance-unbound', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const propertyId = documentStore.commands.components.addProperty(definition.id, 'variant')!
    const property = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(candidate => candidate.id === propertyId)!
    const unbound = { ...property }
    delete unbound.binding
    expect(documentStore.commands.components.setProperty(definition.id, unbound)).toBe(true)
    expect(documentStore.commands.components.place(definition.id)).toBe(true)
    const instance = Object.values(documentStore.getSnapshot().file!.componentModel.instances)[0]!

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentModelProperties)) })

    expect(host.querySelector(`#model-${instance.id}-${propertyId}`)).toBeNull()
    expect(host.querySelector('[aria-label="Edit scope"]')).toBeNull()
    expect(host.querySelector('[aria-label="Reset all instance properties"]')).toBeNull()
    expect(host.querySelector('[aria-label="Open main component"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Detach instance"]')).not.toBeNull()
  })

  it('shows scope and removes a sparse override through Reset', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('instance-reset', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const propertyId = documentStore.commands.components.addProperty(definition.id, 'variant')!
    const hoverId = documentStore.commands.components.addVariantValue(definition.id, propertyId)!
    const variant = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === propertyId)!
    if (variant.type !== 'variant') throw new Error('Expected variant')
    expect(documentStore.commands.components.setProperty(definition.id, { ...variant, name: 'State', description: 'Visual interaction state.', values: variant.values.map(option => option.id === hoverId ? { ...option, name: 'Hover' } : option) })).toBe(true)
    expect(documentStore.commands.components.place(definition.id, { [propertyId]: hoverId })).toBe(true)
    const instance = Object.values(documentStore.getSnapshot().file!.componentModel.instances)[0]!

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentModelProperties)) })

    expect(host.querySelector('[aria-label="Edit scope"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Instance"]')).not.toBeNull()
    const sharedScope = host.querySelector<HTMLButtonElement>('[aria-label="Shared component"]')
    expect(sharedScope).not.toBeNull()
    await act(async () => { sharedScope?.click() })
    expect(documentStore.getSnapshot().selection).toEqual([definition.source.kind === 'canvas' ? definition.source.masterRootId : ''])
    await act(async () => { documentStore.select(instance.id) })
    expect(host.textContent).toContain('Visual interaction state.')
    const resetAll = host.querySelector<HTMLButtonElement>('[aria-label="Reset all instance properties"]')
    expect(resetAll).not.toBeNull()
    await act(async () => { resetAll?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.instances[instance.id]!.values).toEqual({})
    expect(host.querySelector('[aria-label="Reset all instance properties"]')).toBeNull()
    await act(async () => { expect(documentStore.undo()).toBe(true) })
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset State"]')
    expect(reset).not.toBeNull()
    await act(async () => { reset?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.instances[instance.id]!.values).toEqual({})
    expect(host.querySelector('[aria-label="Reset State"]')).toBeNull()
  })

  it('COMP-V2-UI-039 detaches a canvas instance and restores it through Undo', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('instance-detach', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    expect(documentStore.commands.components.place(definition.id)).toBe(true)
    const instance = Object.values(documentStore.getSnapshot().file!.componentModel.instances)[0]!

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentModelProperties)) })

    const openMain = host.querySelector<HTMLButtonElement>('[aria-label="Open main component"]')
    expect(openMain).not.toBeNull()
    await act(async () => { openMain?.click() })
    expect(documentStore.getSnapshot().selection).toEqual([definition.source.kind === 'canvas' ? definition.source.masterRootId : ''])
    expect(documentStore.getSnapshot().file!.componentModel.instances[instance.id]).toEqual(instance)
    await act(async () => { documentStore.select(instance.id) })

    const detach = host.querySelector<HTMLButtonElement>('[aria-label="Detach instance"]')
    expect(detach).not.toBeNull()
    await act(async () => { detach?.click() })
    expect(documentStore.getSnapshot().file!.nodes[instance.id]).toBeDefined()
    expect(documentStore.getSnapshot().file!.componentModel.instances[instance.id]).toBeUndefined()
    expect(host.querySelector('[aria-label="Detach instance"]')).toBeNull()

    await act(async () => { expect(documentStore.undo()).toBe(true) })
    expect(documentStore.getSnapshot().file!.componentModel.instances[instance.id]).toEqual(instance)
    expect(host.querySelector('[aria-label="Detach instance"]')).not.toBeNull()
  })

  it('offers other available components as slot content without offering recursive self nesting', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const blank = createBlankFile('instance-slot', 'page', 'root')
    const file = { ...blank, componentModel: { ...blank.componentModel, definitions: { missing: { id: 'missing', name: 'Missing', source: { kind: 'code' as const, bindingId: 'missing' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] } } } }
    const codeGuest: Atom = { componentId: 'code-guest', name: 'Code guest', exportName: 'CodeGuest', path: 'CodeGuest.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom', props: [{ name: 'active', type: 'boolean', optional: false }] }
    documentStore.load(file, [codeGuest], { replace: true, pageId: 'page' })
    expect(documentStore.commands.components.reconcileCodeDefinitions(connectedRegistryDefinitions([codeGuest]))).toBe(true)
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Host')).toBe(true)
    const hostDefinition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(definition => definition.name === 'Host')!
    const slotId = documentStore.commands.components.addProperty(hostDefinition.id, 'slot')!
    documentStore.commands.insertCanvas('frame', { x: 240, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Guest')).toBe(true)
    const guestDefinition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(definition => definition.name === 'Guest')!
    const guestSlotId = documentStore.commands.components.addProperty(guestDefinition.id, 'slot')!
    expect(documentStore.commands.components.place(hostDefinition.id)).toBe(true)
    const hostInstance = Object.values(documentStore.getSnapshot().file!.componentModel.instances).find(instance => instance.componentId === hostDefinition.id)!

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentModelProperties)) })

    const add = host.querySelector<HTMLButtonElement>('[aria-label="Add content to Property"]')
    await act(async () => { add?.click() })
    const choices = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(choices.map(choice => choice.textContent)).toEqual(['Text', 'Frame', 'Code guest', 'Guest'])
    expect(choices.some(choice => choice.textContent === 'Host')).toBe(false)
    expect(choices.some(choice => choice.textContent === 'Missing')).toBe(false)
    await act(async () => { choices.find(choice => choice.textContent === 'Guest')?.click() })
    const nestedGuest = Object.values(documentStore.getSnapshot().file!.componentModel.instances).find(instance => instance.componentId === guestDefinition.id)!
    expect(documentStore.getSnapshot().file!.relationships[nestedGuest.id]).toMatchObject({ parentId: hostInstance.id, slot: slotId })
    expect(documentStore.commands.components.addSlotComponent(nestedGuest.id, guestSlotId, hostDefinition.id)).toBe(false)

    const nestedAdd = host.querySelector<HTMLButtonElement>('[aria-label="Add content to Property"]')
    await act(async () => { nestedAdd?.click() })
    const nestedChoices = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(nestedChoices.map(choice => choice.textContent)).toEqual(['Text', 'Frame', 'Code guest'])
    expect(nestedChoices.some(choice => choice.textContent === 'Host')).toBe(false)
    expect(nestedChoices.some(choice => choice.textContent === 'Guest')).toBe(false)
    await act(async () => { nestedChoices.find(choice => choice.textContent === 'Code guest')?.click() })
    const nestedCode = Object.values(documentStore.getSnapshot().file!.componentModel.instances).find(instance => instance.componentId === codeGuest.componentId)
    expect(nestedCode).toBeDefined()
    expect(documentStore.getSnapshot().file!.relationships[nestedCode!.id]).toMatchObject({ parentId: nestedGuest.id, slot: guestSlotId })
    expect(documentStore.getSnapshot().file!.nodes[nestedCode!.id]).toMatchObject({ type: 'component', componentId: codeGuest.componentId, exportName: codeGuest.exportName })
    expect(documentStore.commands.components.detach(nestedCode!.id)).toBe(false)
    expect(host.querySelector('[aria-label="Open main component"]')).toBeNull()
    expect(host.querySelector('[aria-label="Detach instance"]')).toBeNull()
    await act(async () => { expect(documentStore.commands.components.setInstanceValue(nestedCode!.id, 'property:active', true)).toBe(true) })
    const resetCode = host.querySelector<HTMLButtonElement>('[aria-label="Reset all instance properties"]')
    expect(resetCode).not.toBeNull()
    await act(async () => { resetCode?.click() })
    expect(documentStore.getSnapshot().file!.componentModel.instances[nestedCode!.id]!.values).toEqual({})
    expect(documentStore.getSnapshot().file!.nodes[nestedCode!.id]).toMatchObject({ type: 'component', props: { active: false } })
    expect(host.querySelector('[aria-label="Reset all instance properties"]')).toBeNull()
  })
})
