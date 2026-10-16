// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InspectorScrubField, InspectorSelectField } from './inspector-atoms'
import { MobileSheet } from './shell-atoms'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('AT-DOC-004 numeric token menu', () => {
  it('uses the themed menu and commits the chosen token value', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    const commit = vi.fn()
    await act(async () => {
      root?.render(createElement(InspectorScrubField, {
        id: 'width', label: 'Width', value: 16, onCommit: commit, tokenLabel: 'Choose numeric token for width',
        tokens: [{ name: 'spacing-2', value: 8, displayValue: '8px' }, { name: 'spacing-4', value: 16, displayValue: '16px' }],
      }))
    })

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Choose numeric token for width"]')
    expect(trigger?.querySelector('select')).toBeNull()
    await act(async () => { trigger?.click() })

    const menu = host.querySelector<HTMLElement>('[role="menu"][aria-label="Choose numeric token for width"]')
    expect(menu).not.toBeNull()
    expect(menu?.textContent).toContain('spacing-2')
    expect(menu?.textContent).toContain('8px')
    const option = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find(item => item.textContent?.includes('spacing-2'))
    await act(async () => { option?.click() })

    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(8)
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('keeps numeric and select menus inside the active mobile properties sheet', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(createElement(MobileSheet, {
        open: true, mode: 'light', title: 'Properties', closeLabel: 'Close', onOpenChange: () => undefined,
        children: createElement('div', null,
          createElement(InspectorScrubField, { id: 'gap', label: 'Gap', value: 8, onCommit: () => undefined, tokenLabel: 'Choose gap token', tokens: [{ name: 'spacing-2', value: 8, displayValue: '8px' }] }),
          createElement(InspectorSelectField, { id: 'kind', label: 'Value type', value: 'literal', options: [{ value: 'literal', label: 'Literal' }, { value: 'alias', label: 'Alias' }], onChange: () => undefined }),
        ),
      }))
    })

    const sheet = document.querySelector<HTMLElement>('.mobile-sheet-popup')
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Choose gap token"]')?.click() })
    expect(document.querySelector('[role="menu"]')?.closest('.mobile-sheet-popup')).toBe(sheet)
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click() })

    const select = document.querySelector<HTMLButtonElement>('#kind')
    expect(select?.tagName).toBe('BUTTON')
    await act(async () => { select?.click() })
    expect(document.querySelector('[role="listbox"]')?.closest('.mobile-sheet-popup')).toBe(sheet)
  })
})
