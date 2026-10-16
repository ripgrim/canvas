// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { childrenOf, createBlankFile } from '@canvas/repo-engine/file-document'
import { DocumentLayers } from './DocumentLayers'
import { documentStore } from './document-store'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  documentStore.configure({})
  documentStore.setReadOnly(false)
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('LAYER-TREE-KEYBOARD-001 accessible hierarchy editing', () => {
  it('reorders the selected layer through the atomic drop command and remains undoable', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('layer-keyboard', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.insertCanvas('rectangle', { x: 0, y: 0 })
    const first = documentStore.getSnapshot().selection[0]!
    documentStore.commands.insertCanvas('rectangle', { x: 40, y: 0 })
    const second = documentStore.getSnapshot().selection[0]!
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(DocumentLayers)) })

    const row = host.querySelector<HTMLElement>(`[data-layer-node-id="${second}"]`)
    await act(async () => { row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })) })
    expect(childrenOf(documentStore.getSnapshot().file!, 'root')).toEqual([second, first])

    await act(async () => { expect(documentStore.undo()).toBe(true) })
    expect(childrenOf(documentStore.getSnapshot().file!, 'root')).toEqual([first, second])
  })

  it('AT-CAN-005 selects a locked layer without exposing layer movement or lock mutation', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const file = createBlankFile('locked-layer', 'page', 'root')
    file.nodes.locked = { id: 'locked', type: 'rectangle', name: 'Locked', isLocked: true, styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 40 } }
    file.nodes.sibling = { id: 'sibling', type: 'rectangle', name: 'Sibling', styles: { relativeTransform: [1, 0, 0, 1, 80, 0], width: 40, height: 40 } }
    file.relationships.locked = { parentId: 'root', orderKey: 'A' }
    file.relationships.sibling = { parentId: 'root', orderKey: 'B' }
    documentStore.load(file, [], { replace: true, pageId: 'page' })
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(DocumentLayers)) })

    const row = host.querySelector<HTMLElement>('[data-layer-node-id="locked"]')!
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(documentStore.getSnapshot().selection).toEqual(['locked'])
    expect(row.getAttribute('aria-selected')).toBe('true')
    const before = structuredClone(documentStore.getSnapshot().file)
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })) })
    expect(documentStore.getSnapshot().file).toEqual(before)
    expect(childrenOf(documentStore.getSnapshot().file!, 'root')).toEqual(['locked', 'sibling'])
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Unlock Locked"]')?.disabled).toBe(false)
  })

  it('UI-COLLAB-READONLY-001 keeps Layers selectable while every visible layer edit remains unavailable', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const file = createBlankFile('read-only-layer', 'page', 'root')
    file.nodes.first = { id: 'first', type: 'rectangle', name: 'First', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 40 } }
    file.nodes.second = { id: 'second', type: 'rectangle', name: 'Second', styles: { relativeTransform: [1, 0, 0, 1, 80, 0], width: 40, height: 40 } }
    file.relationships.first = { parentId: 'root', orderKey: 'A' }
    file.relationships.second = { parentId: 'root', orderKey: 'B' }
    documentStore.load(file, [], { replace: true, pageId: 'page' })
    documentStore.setReadOnly(true)
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(DocumentLayers, { readOnly: true })) })

    const row = host.querySelector<HTMLElement>('[data-layer-node-id="second"]')!
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(documentStore.getSnapshot().selection).toEqual(['second'])
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect([...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Hide"], button[aria-label^="Lock"]')].every(button => button.disabled)).toBe(true)
    const before = structuredClone(documentStore.getSnapshot().file)
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })) })
    expect(documentStore.commands.rename('second', 'Changed')).toBe(false)
    expect(documentStore.commands.insertClipboardText('Blocked')).toBe(false)
    expect(documentStore.getSnapshot().file).toEqual(before)
    expect(childrenOf(documentStore.getSnapshot().file!, 'root')).toEqual(['first', 'second'])
  })
})
