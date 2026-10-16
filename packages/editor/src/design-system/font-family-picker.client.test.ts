// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { FontFamilyPicker } from './font-family-picker'
import { MobileSheet } from './shell-atoms'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('FONT-MOBILE-001 font picker dialog ownership', () => {
  it('opens inside the active properties sheet', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    host.className = 'editor-root theme-light'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(createElement(MobileSheet, {
        open: true, mode: 'light', title: 'Properties', closeLabel: 'Close', onOpenChange: () => undefined,
        children: createElement(FontFamilyPicker, {
          id: 'text-family', value: 'Geist', placeholder: 'Mixed', options: [{ family: 'Geist', label: 'Geist', source: 'system' }],
          copy: {
            title: 'Font family', close: 'Close', fonts: 'Fonts', favorites: 'Favorites', tokens: 'Tokens', searchFonts: 'Search fonts', searchFavorites: 'Search favorites', searchTokens: 'Search tokens', noMatches: 'No matches', noMatchesLoaded: 'No matches', noFavorites: 'No favorites', noTokens: 'No tokens', loadLocalFonts: 'Load local fonts', loadingLocalFonts: 'Loading local fonts', localFontsDenied: 'Denied', localFontsLate: 'Late', localFontsUnsupported: 'Unsupported', unavailable: 'Unavailable', loadFailed: 'Failed', favorite: family => `Favorite ${family}`, unfavorite: family => `Unfavorite ${family}`,
          },
          onChoose: () => undefined,
        }),
      }))
    })

    const trigger = document.querySelector<HTMLButtonElement>('#text-family')
    expect(trigger).not.toBeNull()
    await act(async () => { trigger?.click() })

    const sheet = document.querySelector<HTMLElement>('.mobile-sheet-popup')
    const picker = document.querySelector<HTMLElement>('.font-picker-dialog')
    expect(sheet).not.toBeNull()
    expect(picker).not.toBeNull()
    expect(picker?.closest('.mobile-sheet-popup')).toBe(sheet)
  })
})
