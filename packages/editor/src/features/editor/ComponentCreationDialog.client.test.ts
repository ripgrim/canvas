// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { ComponentCreationDialog } from './ComponentCreationDialog'
import { componentKitNavigation } from './component-kit-navigation'
import { componentCreationCandidate, componentCreationService } from './component-creation-service'
import { documentStore } from './document-store'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

const setInputValue = (input: HTMLInputElement | null, value: string) => {
  if (!input) return
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(async () => {
  await act(async () => { componentCreationService.close(); componentKitNavigation.back(); root?.unmount() })
  root = null
  documentStore.clear()
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('COMP-V2-UI-048 contextual component creation', () => {
  it('opens from one eligible layer, creates it, and rejects a duplicate name before dispatch', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-create', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    const firstNodeId = documentStore.getSnapshot().selection[0]!
    expect(componentCreationCandidate(documentStore.getSnapshot().file, [firstNodeId])).toBe(firstNodeId)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentCreationDialog)) })
    await act(async () => { expect(componentCreationService.open(host)).toBe(true) })

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Create component')
    const name = host.querySelector<HTMLInputElement>('#component-name')
    await act(async () => { setInputValue(name, 'Button') })
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Create component')
    await act(async () => { create?.click() })

    expect(Object.values(documentStore.getSnapshot().file!.componentModel.definitions)).toEqual([
      expect.objectContaining({ name: 'Button', source: { kind: 'canvas', masterRootId: firstNodeId } }),
    ])
    expect(componentKitNavigation.getSnapshot()).toMatchObject({ fileId: 'component-create', componentId: Object.keys(documentStore.getSnapshot().file!.componentModel.definitions)[0] })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(componentCreationCandidate(documentStore.getSnapshot().file, [firstNodeId])).toBeNull()

    await act(async () => { documentStore.commands.insertCanvas('rectangle', { x: 80, y: 0 }) })
    await act(async () => { expect(componentCreationService.open(host)).toBe(true) })
    await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('#component-name'), 'BUTTON') })

    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Name already exists.')
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Create component')?.disabled).toBe(true)
    expect(Object.keys(documentStore.getSnapshot().file!.componentModel.definitions)).toHaveLength(1)
  })

  it('omits roots, multiple selections, masters, and nodes inside an instance', () => {
    documentStore.load(createBlankFile('component-create-eligibility', 'page', 'root'), [], { replace: true, pageId: 'page' })
    const file = documentStore.getSnapshot().file!
    expect(componentCreationCandidate(file, [])).toBeNull()
    expect(componentCreationCandidate(file, ['root'])).toBeNull()
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    const nodeId = documentStore.getSnapshot().selection[0]!
    expect(componentCreationCandidate(documentStore.getSnapshot().file, [nodeId, 'root'])).toBeNull()
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    expect(componentCreationCandidate(documentStore.getSnapshot().file, [nodeId])).toBeNull()
    expect(documentStore.commands.components.place(Object.keys(documentStore.getSnapshot().file!.componentModel.definitions)[0]!)).toBe(true)
    const instanceId = documentStore.getSnapshot().selection[0]!
    expect(componentCreationCandidate(documentStore.getSnapshot().file, [instanceId])).toBeNull()
  })
})
