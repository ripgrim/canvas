// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { childrenOf, createBlankFile } from '@canvas/repo-engine/file-document'
import { ComponentDocsPreview } from '../../design-system/component-kit-atoms'
import { ComponentKitPanel } from './ComponentKitPanel'
import { RepositoryDocsReviewDialog, repositoryCommitUrl, repositoryDocsReviewPresentation } from './ComponentRepositoryPanel'
import { documentStore } from './document-store'
import { discoveredRegistryAtoms, discoveredRegistryDefinitions } from './component-registry'
import { mapParallelComponentSubtrees } from './component-canvas-link'
import { componentKitNavigation } from './component-kit-navigation'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

const setInputValue = (input: HTMLInputElement | null, value: string) => {
  if (!input) return
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  componentKitNavigation.back()
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('COMP-V2-UI-015 component names', () => {
  it('COMP-V2-UI-035 never presents a silent blank configured preview', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    const render = async (status: 'connecting' | 'ready' | 'error') => act(async () => {
      root?.render(createElement(ComponentDocsPreview, { src: 'about:blank', title: 'Configured component preview', status, statusText: status === 'error' ? 'Preview unavailable' : 'Loading preview…', action: status === 'error' ? createElement('button', null, 'Retry') : undefined, attach: () => undefined, onReady: () => undefined }))
    })

    await render('connecting')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading preview…')
    await render('error')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Preview unavailableRetry')
    await render('ready')
    expect(host.querySelector('.component-docs-preview-status')).toBeNull()
    consoleError.mockRestore()
  })

  it('COMP-V2-DOCS-007 links only an exact GitHub repository and commit identity', () => {
    expect(repositoryCommitUrl('ripgrim/canvas', 'e'.repeat(40))).toBe(`https://github.com/ripgrim/canvas/commit/${'e'.repeat(40)}`)
    expect(repositoryCommitUrl('ripgrim/canvas/extra', 'e'.repeat(40))).toBeNull()
    expect(repositoryCommitUrl('ripgrim/canvas', '../main')).toBeNull()
  })

  it('COMP-V2-DOCS-007 keeps a prepared review visible but expires approval after the file changes', () => {
    const review = {
      id: '00000000-0000-4000-8000-000000000035', fileId: 'file', fileRevision: 4, status: 'prepared' as const,
      baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'b'.repeat(64),
      preparedBundle: { files: [{ path: 'apps/docs/content/docs/button.mdx', diff: '+# Button' }], omissions: [], validation: [{ name: 'Blume check', detail: 'Passed' }] },
      committedSha: null, errorId: null,
    }
    expect(repositoryDocsReviewPresentation(review, { fileId: 'file', revision: 4 })).toMatchObject({ bundle: review.preparedBundle, ready: true, expired: false })
    expect(repositoryDocsReviewPresentation(review, { fileId: 'file', revision: 5 })).toMatchObject({ bundle: review.preparedBundle, ready: false, expired: true })
    expect(repositoryDocsReviewPresentation(review, { fileId: 'file', revision: 4 }, true)).toMatchObject({ bundle: review.preparedBundle, ready: false, expired: true })
  })

  it('COMP-V2-DOCS-007 shows every exact diff and requires explicit approval before Save', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    const review = {
      files: [
        { path: 'apps/docs/content/docs/components/button.mdx', diff: '-old button\n+new button' },
        { path: 'apps/docs/registry/comp/button.tsx', diff: '+export const ButtonExample = true' },
      ],
      omissions: [],
      validation: [{ name: 'Blume check', detail: 'Passed' }, { name: 'Blume build', detail: 'Passed' }],
    }
    const approve = vi.fn()
    const save = vi.fn()
    const render = async (approved: boolean) => act(async () => { root?.render(createElement(RepositoryDocsReviewDialog, { review, open: true, approved, container: host, busy: false, onApprovedChange: approve, onOpenChange: vi.fn(), onSave: save })) })
    await render(false)

    expect(host.textContent).toContain('Repository docs')
    expect(host.textContent).toContain('apps/docs/content/docs/components/button.mdx')
    expect(host.textContent).toContain('-old button')
    expect(host.textContent).toContain('apps/docs/registry/comp/button.tsx')
    expect(host.textContent).toContain('+export const ButtonExample = true')
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save docs')?.disabled).toBe(true)

    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click() })
    expect(approve).toHaveBeenCalledWith(true)
    await render(true)
    const saveButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save docs')
    expect(saveButton?.disabled).toBe(false)
    await act(async () => { saveButton?.click() })
    expect(save).toHaveBeenCalledOnce()
  })

  it('COMP-V2-CODE-002 shows hosted discoveries while keeping placement unavailable', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const registry = {
      fingerprint: 'github:revision',
      components: [{ componentId: 'component:hosted-button', symbolKey: 'component:hosted-button', path: 'src/button.tsx', exportName: 'Button', packageName: '@acme/ui', sourceHash: 'a'.repeat(64), fingerprint: 'b'.repeat(64), props: [{ name: 'tone', type: "'quiet' | 'solid'", optional: true }], slots: [] }],
    }
    const atoms = discoveredRegistryAtoms(registry)
    documentStore.load(createBlankFile('hosted-components', 'page', 'root'), atoms, { replace: true, pageId: 'page' })
    expect(documentStore.commands.components.reconcileCodeDefinitions(discoveredRegistryDefinitions(registry), atoms)).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms, onOpenCanvas: () => undefined })) })

    const inspect = host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')
    const place = host.querySelector<HTMLButtonElement>('[aria-label="Preview build required before this component can be placed."]')
    expect(inspect?.textContent).toContain('Button')
    expect(inspect?.textContent).toContain('From the kit')
    expect(place?.disabled).toBe(true)

    await act(async () => { inspect?.click() })
    expect(host.textContent).toContain('Preview build required before this component can be placed.')
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Place')?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('#component-docs-component\\:hosted-button-property\\:tone')?.textContent).toContain('Component default')
    expect(host.querySelector('[aria-label="Place every Button variant on the canvas"]')).toBeNull()
  })

  it('COMP-V2-UI-064 authors component documentation details and rejects duplicate names before dispatch', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-names', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    documentStore.commands.insertCanvas('rectangle', { x: 80, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Card')).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })

    const details = host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')
    await act(async () => { details?.click() })
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(candidate => candidate.name === 'Button')!
    const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit Button details"]')
    await act(async () => { edit?.click() })
    expect(host.querySelector<HTMLInputElement>(`#component-details-${definition.id}-description`)?.maxLength).toBe(500)
    const nameField = host.querySelector<HTMLInputElement>(`#component-details-${definition.id}-name`)
    await act(async () => { setInputValue(nameField, 'card') })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Name already exists.')
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save details')?.disabled).toBe(true)

    await act(async () => { setInputValue(nameField, 'Primary button') })
    await act(async () => { setInputValue(host.querySelector<HTMLInputElement>(`#component-details-${definition.id}-description`), 'Triggers the primary action.') })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save details')?.click() })
    expect(host.textContent).toContain('Primary button')
    expect(host.textContent).toContain('Triggers the primary action.')
    expect(documentStore.getSnapshot().file!.componentModel.definitions[definition.id]).toMatchObject({ name: 'Primary button', docs: { slug: 'primary-button', description: 'Triggers the primary action.' } })
  })

  it('COMP-V2-UI-010 preserves playground drafts across unrelated document revisions', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-playground', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('text', { x: 0, y: 0 })
    const masterId = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.setText(masterId, 'Default label')).toBe(true)
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const propertyId = documentStore.commands.components.addProperty(definition.id, 'text')!
    const property = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(candidate => candidate.id === propertyId)!
    expect(documentStore.commands.components.setProperty(definition.id, { ...property, name: 'Label', description: 'Text shown inside the button.' })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')?.click() })
    const label = host.querySelector<HTMLInputElement>(`#component-docs-${definition.id}-${propertyId}`)
    expect(host.textContent).toContain('Text shown inside the button.')
    await act(async () => { setInputValue(label, 'Draft label') })
    expect(label?.value).toBe('Draft label')

    await act(async () => { documentStore.commands.insertCanvas('rectangle', { x: 80, y: 0 }) })
    expect(host.querySelector<HTMLInputElement>(`#component-docs-${definition.id}-${propertyId}`)?.value).toBe('Draft label')
  })

  it('COMP-V2-UI-075 configures Slot content in Kit and places it atomically', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-slot-playground', 'page', 'root'), [], { replace: true, pageId: 'page' })
    expect(documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })).toBe(true)
    expect(documentStore.commands.components.createFromSelection('Notice')).toBe(true)
    const notice = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(definition => definition.name === 'Notice')!
    const propertyId = documentStore.commands.components.addProperty(notice.id, 'slot')!
    const property = documentStore.getSnapshot().file!.componentModel.definitions[notice.id]!.properties.find(candidate => candidate.id === propertyId)!
    expect(documentStore.commands.components.setProperty(notice.id, { ...property, name: 'Content' })).toBe(true)
    expect(documentStore.commands.insertCanvas('rectangle', { x: 400, y: 0 })).toBe(true)
    expect(documentStore.commands.components.createFromSelection('Badge')).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Notice component details"]')?.click() })
    const before = documentStore.getSnapshot().file
    const revision = before!.revision

    const openAddMenu = async () => act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add content to Content"]')?.click() })
    await openAddMenu()
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Text')?.click() })
    await openAddMenu()
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Badge')?.click() })

    expect(host.textContent).toContain('2 layers')
    expect(host.querySelector('[aria-label="Reset playground"]')).not.toBeNull()
    expect(documentStore.getSnapshot().file).toBe(before)
    expect(documentStore.getSnapshot().file!.revision).toBe(revision)
    expect(documentStore.getHistory().past.at(-1)?.file.revision).not.toBe(revision + 1)

    await act(async () => { root?.render(null) })
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    expect(host.textContent).toContain('2 layers')
    expect(host.querySelector('[aria-label="Reset playground"]')).not.toBeNull()

    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Place')?.click() })
    const placedFile = documentStore.getSnapshot().file!
    const outer = Object.values(placedFile.componentModel.instances).find(instance => instance.componentId === notice.id)!
    const nested = Object.values(placedFile.componentModel.instances).find(instance => instance.componentId !== notice.id)!
    const outerMap = mapParallelComponentSubtrees(placedFile, notice.source.kind === 'canvas' ? notice.source.masterRootId : '', outer.id)!
    const placedProperty = placedFile.componentModel.definitions[notice.id]!.properties.find(candidate => candidate.id === propertyId)
    if (placedProperty?.type !== 'slot' || !placedProperty.binding) throw new Error('Expected bound Slot')
    const slotHost = outerMap.get(placedProperty.binding.nodeId)!
    expect(childrenOf(placedFile, slotHost, propertyId)).toHaveLength(2)
    expect(placedFile.relationships[nested.id]).toMatchObject({ parentId: slotHost, slot: propertyId })
    expect(documentStore.getSnapshot().selection).toEqual([outer.id])

    await act(async () => { expect(documentStore.undo()).toBe(true) })
    expect(documentStore.getSnapshot().file!.componentModel.instances).toEqual({})
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Back to components"]')?.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Notice component details"]')?.click() })
    expect(host.textContent).toContain('Empty')
    expect(host.querySelector('[aria-label="Reset playground"]')).toBeNull()
  })

  it('COMP-V2-UI-076 configures and resets Instance swap in the Kit playground', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-swap-playground', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 320, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Badge')).toBe(true)
    const badge = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(candidate => candidate.name === 'Badge')!
    documentStore.commands.insertCanvas('rectangle', { x: 480, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Avatar')).toBe(true)
    const avatar = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(candidate => candidate.name === 'Avatar')!
    documentStore.commands.insertCanvas('frame', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const button = Object.values(documentStore.getSnapshot().file!.componentModel.definitions).find(candidate => candidate.name === 'Button')!
    if (button.source.kind !== 'canvas') throw new Error('Expected canvas Button')
    expect(documentStore.commands.components.place(badge.id)).toBe(true)
    expect(documentStore.commands.move(documentStore.getSnapshot().selection[0]!, { parentId: button.source.masterRootId, index: 0 })).toBe(true)
    documentStore.select(button.source.masterRootId)
    const propertyId = documentStore.commands.components.addProperty(button.id, 'instance-swap')!

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')?.click() })

    const select = host.querySelector<HTMLButtonElement>(`#component-docs-${button.id}-${propertyId}`)
    expect(select?.textContent).toContain('Badge')
    await act(async () => { select?.click() })
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map(option => option.textContent?.replace('✓', '').trim())).toEqual(['Avatar', 'Badge'])
    expect(options.every(option => option.querySelector('[data-icon="component"]'))).toBe(true)
    await act(async () => { options.find(option => option.textContent?.includes('Avatar'))?.click() })

    expect(select?.textContent).toContain('Avatar')
    await act(async () => { root?.render(null) })
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    expect(host.querySelector<HTMLButtonElement>(`#component-docs-${button.id}-${propertyId}`)?.textContent).toContain('Avatar')
    const ownerIds = new Set(Object.values(documentStore.getSnapshot().file!.componentModel.instances).filter(instance => instance.componentId === button.id).map(instance => instance.id))
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Place')?.click() })
    const placedFile = documentStore.getSnapshot().file!
    const placed = Object.values(placedFile.componentModel.instances).find(instance => instance.componentId === button.id && !ownerIds.has(instance.id))!
    const placedDefinition = placedFile.componentModel.definitions[button.id]!
    const swap = placedDefinition.properties.find(property => property.id === propertyId)
    if (swap?.type !== 'instance-swap') throw new Error('Expected Instance swap property')
    const map = mapParallelComponentSubtrees(placedFile, button.source.masterRootId, placed.id, { includeOverriddenSwapRoots: true })!
    expect(placed.values[propertyId]).toBe(avatar.id)
    expect(placedFile.componentModel.instances[map.get(swap.binding.nodeId)!]?.componentId).toBe(avatar.id)
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset playground"]')
    expect(reset).not.toBeNull()
    await act(async () => { reset?.click() })
    expect(host.querySelector<HTMLButtonElement>(`#component-docs-${button.id}-${propertyId}`)?.textContent).toContain('Badge')
    expect(host.querySelector('[aria-label="Reset playground"]')).toBeNull()
    await act(async () => { expect(documentStore.undo()).toBe(true) })
    expect(documentStore.getSnapshot().file!.componentModel.instances[placed.id]).toBeUndefined()
  })

  it('COMP-V2-UI-058 omits unbound canvas properties from the playground and Variant sheet', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-unbound-playground', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const propertyId = documentStore.commands.components.addProperty(definition.id, 'variant')!
    const property = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(candidate => candidate.id === propertyId)!
    const unbound = { ...property }
    delete unbound.binding
    expect(documentStore.commands.components.setProperty(definition.id, unbound)).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')?.click() })

    expect(host.querySelector('[aria-label="Playground"]')).toBeNull()
    expect(host.querySelector('[aria-label="Variant sheet"]')).toBeNull()
    expect(host.querySelector(`#component-docs-${definition.id}-${propertyId}`)).toBeNull()
    expect(host.querySelector('[aria-label="Place every Button variant on the canvas"]')).toBeNull()
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Place')?.click() })
    expect(Object.values(documentStore.getSnapshot().file!.componentModel.instances).map(instance => instance.values)).toEqual([{}])
  })

  it('COMP-V2-UI-036 previews a variant-sheet choice without clearing other playground drafts', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-variant-preview', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('text', { x: 0, y: 0 })
    expect(documentStore.commands.setText(documentStore.getSnapshot().selection[0]!, 'Default label')).toBe(true)
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const variantId = documentStore.commands.components.addProperty(definition.id, 'variant')!
    const hoverId = documentStore.commands.components.addVariantValue(definition.id, variantId)!
    const variant = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === variantId)!
    if (variant.type !== 'variant') throw new Error('Expected variant')
    expect(documentStore.commands.components.setProperty(definition.id, { ...variant, name: 'State', values: variant.values.map(option => option.id === hoverId ? { ...option, name: 'Hover' } : option) })).toBe(true)
    const textId = documentStore.commands.components.addProperty(definition.id, 'text')!
    const text = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === textId)!
    expect(documentStore.commands.components.setProperty(definition.id, { ...text, name: 'Label' })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')?.click() })
    const label = host.querySelector<HTMLInputElement>(`#component-docs-${definition.id}-${textId}`)
    await act(async () => { setInputValue(label, 'Draft label') })
    const previewHover = host.querySelector<HTMLButtonElement>('[aria-label="Preview State: Hover"]')
    expect(previewHover?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => { previewHover?.click() })

    expect(previewHover?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector<HTMLButtonElement>(`#component-docs-${definition.id}-${variantId}`)?.textContent).toContain('Hover')
    expect(label?.value).toBe('Draft label')

    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Reset playground"]')?.click() })

    expect(host.querySelector<HTMLButtonElement>('[aria-label="Reset playground"]')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>(`#component-docs-${definition.id}-${variantId}`)?.textContent).toContain('Default')
    expect(label?.value).toBe('Default label')
  })

  it('COMP-V2-UI-037 places the full canvas variant sheet and removes it with one Undo', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-variant-sheet', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    const variantId = documentStore.commands.components.addProperty(definition.id, 'variant')!
    const hoverId = documentStore.commands.components.addVariantValue(definition.id, variantId)!
    const variant = documentStore.getSnapshot().file!.componentModel.definitions[definition.id]!.properties.find(property => property.id === variantId)!
    if (variant.type !== 'variant') throw new Error('Expected variant')
    expect(documentStore.commands.components.setProperty(definition.id, { ...variant, name: 'State', values: variant.values.map(option => option.id === hoverId ? { ...option, name: 'Hover' } : option) })).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')?.click() })

    const placeSheet = host.querySelector<HTMLButtonElement>('[aria-label="Place every Button variant on the canvas"]')
    expect(placeSheet?.textContent).toContain('Place sheet')
    await act(async () => { placeSheet?.click() })

    expect(Object.values(documentStore.getSnapshot().file!.componentModel.instances).map(instance => instance.values)).toEqual([{}, { [variantId]: hoverId }])
    const generatedFile = documentStore.getSnapshot().file!
    const sheet = Object.values(generatedFile.nodes).find(node => node.type === 'frame' && node.name === 'Button variants')!
    expect(Object.values(generatedFile.nodes).filter(node => node.type === 'text' && generatedFile.relationships[node.id]?.parentId === sheet.id).map(node => node.type === 'text' ? node.text : '')).toEqual(['State: Default', 'State: Hover'])
    expect(host.querySelector('section[aria-label="Instances"] [role="list"]')?.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    await act(async () => { documentStore.undo() })
    expect(documentStore.getSnapshot().file!.componentModel.instances).toEqual({})
    expect(host.querySelector('section[aria-label="Instances"]')).toBeNull()
  })

  it('opens a canvas master in Design only after selection succeeds', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-open', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const masterId = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!.source
    if (masterId.kind !== 'canvas') throw new Error('Expected a canvas component.')
    documentStore.selectMany([])

    const onOpenCanvas = vi.fn()
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button master"]')?.click() })

    expect(documentStore.getSnapshot().selection).toEqual([masterId.masterRootId])
    expect(onOpenCanvas).toHaveBeenCalledOnce()
  })

  it('keeps the Kit row instance count in sync with Place and Undo', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-use-count', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)

    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas: () => undefined })) })
    const row = () => host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')
    expect(row()?.textContent).toContain('From this canvas · 0 instances')
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Create component')).toBeUndefined()

    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Place Button"]')?.click() })
    expect(row()?.textContent).toContain('From this canvas · 1 instance')
    await act(async () => { expect(documentStore.undo()).toBe(true) })
    expect(row()?.textContent).toContain('From this canvas · 0 instances')
  })

  it('COMP-V2-UI-016 lists every use and opens the exact cross-page instance', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('component-uses', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    expect(documentStore.commands.components.createFromSelection('Button')).toBe(true)
    const definition = Object.values(documentStore.getSnapshot().file!.componentModel.definitions)[0]!
    expect(documentStore.commands.components.place(definition.id)).toBe(true)
    const firstUse = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.components.place(definition.id)).toBe(true)
    const reorderedUse = documentStore.getSnapshot().selection[0]!
    expect(documentStore.commands.move(reorderedUse, { parentId: 'root', index: 0 })).toBe(true)
    const secondPage = documentStore.commands.createPage()
    expect(secondPage).not.toBeNull()
    expect(documentStore.commands.components.place(definition.id)).toBe(true)
    const crossPageUse = documentStore.getSnapshot().selection[0]!
    expect(crossPageUse).not.toBe(firstUse)

    const onOpenCanvas = vi.fn()
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ComponentKitPanel, { atoms: [], onOpenCanvas })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button component details"]')?.click() })

    const uses = host.querySelector('section[aria-label="Instances"] [role="list"]')
    expect(uses?.querySelectorAll('[role="listitem"]')).toHaveLength(3)
    const openFirst = host.querySelector<HTMLButtonElement>('[aria-label="Open Button instance 1 on Page 1"]')
    await act(async () => { openFirst?.click() })

    expect(documentStore.getSnapshot().pageId).toBe('page')
    expect(documentStore.getSnapshot().selection).toEqual([reorderedUse])
    expect(onOpenCanvas).toHaveBeenCalledOnce()

    await act(async () => { documentStore.commands.delete() })
    expect(host.querySelector('section[aria-label="Instances"] [role="list"]')?.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Open Button instance 1 on Page 1"]')?.click() })
    expect(documentStore.getSnapshot().selection).toEqual([firstUse])
    await act(async () => { documentStore.undo() })
    expect(host.querySelector('section[aria-label="Instances"] [role="list"]')?.querySelectorAll('[role="listitem"]')).toHaveLength(3)
    expect(host.querySelector('[aria-label="Open Button instance 1 on Page 1"]')).not.toBeNull()
  })
})
