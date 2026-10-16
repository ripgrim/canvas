// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankFile, resolveToken } from '@canvas/repo-engine/file-document'
import { colorToHex } from '@canvas/repo-engine/color'
import { documentStore } from './document-store'
import { ThemePanel } from './ThemePanel'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('THEME-TOKEN-MENU-001 Paper token actions', () => {
  it('opens the complete grouped context menu from a token row', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('token-menu', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.theme.createToken('color')
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ThemePanel)) })
    const row = host.querySelector<HTMLElement>('.theme-token-row')
    expect(row).not.toBeNull()
    await act(async () => { row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 48 })) })
    const menu = host.querySelector<HTMLElement>('[role="menu"][aria-label="Token actions"]')
    expect(menu?.querySelectorAll('[role="group"]')).toHaveLength(4)
    expect([...menu?.querySelectorAll('.context-menu-label') ?? []].map(item => item.textContent)).toEqual(['Cut', 'Copy', 'Paste', 'Paste over', 'Duplicate', 'Select all', 'Move up', 'Move down', 'Move first', 'Move last', 'Delete'])
  })

  it('confirms a referenced non-color token deletion from the context menu and preserves the resolved value', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('token-delete', 'page', 'root'), [], { replace: true, pageId: 'page' })
    const targetId = documentStore.commands.theme.createToken('spacing')!
    const aliasId = documentStore.commands.theme.createToken('spacing')!
    documentStore.commands.theme.setTokenValue(aliasId, { kind: 'alias', tokenId: targetId })
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ThemePanel)) })

    const targetRow = [...host.querySelectorAll<HTMLElement>('.theme-token-row')].find(row => row.getAttribute('aria-label')?.includes('Untitled, 8px'))
    expect(targetRow).not.toBeNull()
    await act(async () => { targetRow?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 48 })) })
    const deleteItem = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Delete'))
    await act(async () => { deleteItem?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const confirmation = document.querySelector<HTMLElement>('[role="group"][aria-label="Confirm delete"]')
    expect(confirmation?.textContent).toContain('Delete and keep the current value on 1 reference')
    expect(documentStore.getSnapshot().file!.theme.tokens[targetId]).toBeDefined()
    const confirm = [...confirmation?.querySelectorAll<HTMLButtonElement>('button') ?? []].find(button => button.textContent?.startsWith('Delete and keep'))
    await act(async () => { confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const file = documentStore.getSnapshot().file!
    expect(file.theme.tokens[targetId]).toBeUndefined()
    expect(file.theme.tokens[aliasId]?.value).toEqual({ kind: 'literal', value: '8px' })
  })

  it('deletes a multi-selection directly when its only references are inside that selection', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('token-delete-selection', 'page', 'root'), [], { replace: true, pageId: 'page' })
    const targetId = documentStore.commands.theme.createToken('spacing')!
    const aliasId = documentStore.commands.theme.createToken('spacing')!
    documentStore.commands.theme.setTokenValue(aliasId, { kind: 'alias', tokenId: targetId })
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ThemePanel)) })

    const rows = [...host.querySelectorAll<HTMLElement>('.theme-token-row')]
    await act(async () => { rows[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { rows[1]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, ctrlKey: true, clientX: 24, clientY: 72 })) })
    const deleteItem = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Delete'))
    await act(async () => { deleteItem?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(document.querySelector('[role="group"][aria-label="Confirm delete"]')).toBeNull()
    expect(documentStore.getSnapshot().file!.theme.tokens[targetId]).toBeUndefined()
    expect(documentStore.getSnapshot().file!.theme.tokens[aliasId]).toBeUndefined()
  })

  it('AT-APP-004 opens the color picker from the token preview and keeps opacity as an editor', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('token-color-picker', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.theme.createToken('color')
    const token = Object.values(documentStore.getSnapshot().file!.theme.tokens)[0]!
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root?.render(createElement(ThemePanel)) })

    const row = host.querySelector<HTMLElement>('.theme-token-row')
    await act(async () => { row?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const editor = document.querySelector<HTMLElement>('.theme-editor')
    const preview = editor?.querySelector<HTMLButtonElement>('.color-picker-trigger-preview')
    expect(preview?.getAttribute('aria-label')).toBe('Edit Untitled color')
    await act(async () => { preview?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const picker = document.querySelector<HTMLElement>('.color-picker-popup')
    expect(picker).not.toBeNull()
    expect(editor?.contains(picker ?? null)).toBe(true)

    const close = picker?.querySelector<HTMLButtonElement>('.color-picker-close')
    await act(async () => { close?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const opacity = editor?.querySelector<HTMLInputElement>('input[id$="-opacity"]')
    expect(opacity).not.toBeNull()
    expect(opacity?.closest('button')).toBeNull()
    await act(async () => {
      if (!opacity) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(opacity, '42')
      opacity.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      if (!opacity) return
      opacity.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    const resolved = resolveToken(documentStore.getSnapshot().file!.theme, token.id, documentStore.sources())
    expect(resolved && colorToHex(resolved)).toBe('#d9d9d96b')
  })

  it('AT-APP-004 keeps the nested color picker inside its mobile sheet owner', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    documentStore.load(createBlankFile('token-color-picker-mobile', 'page', 'root'), [], { replace: true, pageId: 'page' })
    documentStore.commands.theme.createToken('color')
    const host = document.createElement('div')
    host.className = 'editor-root theme-dark'
    const sheet = document.createElement('div')
    sheet.className = 'theme-dark mobile-sheet-popup'
    host.append(sheet)
    document.body.append(host)
    root = createRoot(sheet)
    await act(async () => { root?.render(createElement(ThemePanel)) })

    const row = sheet.querySelector<HTMLElement>('.theme-token-row')
    await act(async () => { row?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const preview = sheet.querySelector<HTMLButtonElement>('.color-picker-trigger-preview')
    await act(async () => { preview?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const picker = document.querySelector<HTMLElement>('.color-picker-popup')
    expect(picker).not.toBeNull()
    expect(picker?.closest('.mobile-sheet-popup')).toBe(sheet)
    expect(picker?.closest('.theme-dark')).toBe(sheet)
  })
})
