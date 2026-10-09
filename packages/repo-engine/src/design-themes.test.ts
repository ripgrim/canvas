import { describe, expect, it } from 'vitest'
import { designThemesFromTokens, designTokenValues, extractCssTokens, resolveDesignTheme } from './design-themes.js'

const css = `
:root { --accent: #685fff; --surface: #ffffff; --ink: #202124; }
/* a comment { with braces } */
[data-theme='dark'] { --surface: #242427; --ink: #eeeeef; }
html[data-theme="contrast"] { --ink: #000000; }
.fixture-button { background: var(--accent); --local: 1px; }
@media (prefers-color-scheme: dark) { body { color: red; } }
`

describe('design themes', () => {
  it('extracts custom properties with their selectors from a flat stylesheet', () => {
    const tokens = extractCssTokens(css, 'src/globals.css')
    expect(tokens.map(token => `${token.selector} ${token.name}=${token.value}`)).toEqual([
      ':root --accent=#685fff', ':root --surface=#ffffff', ':root --ink=#202124',
      "[data-theme='dark'] --surface=#242427", "[data-theme='dark'] --ink=#eeeeef",
      'html[data-theme="contrast"] --ink=#000000',
      '.fixture-button --local=1px',
    ])
  })

  it('derives the base theme plus every data-theme mode, never a mode the stylesheet lacks', () => {
    const themes = designThemesFromTokens(extractCssTokens(css, 'src/globals.css'))
    expect(themes.map(theme => [theme.id, theme.name, theme.attribute, theme.colorScheme])).toEqual([
      ['default', 'Default', null, 'light'],
      ['dark', 'Dark', 'dark', 'dark'],
      ['contrast', 'Contrast', 'contrast', 'light'],
    ])
    expect(designThemesFromTokens([]).map(theme => theme.id)).toEqual(['default'])
    expect(designThemesFromTokens(extractCssTokens(':root { --a: 1 }', 'x.css')).map(theme => theme.id)).toEqual(['default'])
  })

  it('overlays a mode on the base values without touching other modes', () => {
    const tokens = extractCssTokens(css, 'src/globals.css')
    const themes = designThemesFromTokens(tokens)
    expect(designTokenValues(tokens, themes[0]!)).toEqual({ accent: '#685fff', surface: '#ffffff', ink: '#202124' })
    expect(designTokenValues(tokens, themes[1]!)).toEqual({ accent: '#685fff', surface: '#242427', ink: '#eeeeef' })
    expect(designTokenValues(tokens, themes[2]!)).toEqual({ accent: '#685fff', surface: '#ffffff', ink: '#000000' })
  })

  it('falls back to the base theme when a stored selection is unknown', () => {
    const themes = designThemesFromTokens(extractCssTokens(css, 'src/globals.css'))
    expect(resolveDesignTheme(themes, 'dark').id).toBe('dark')
    expect(resolveDesignTheme(themes, 'sepia').id).toBe('default')
    expect(resolveDesignTheme(themes, undefined).id).toBe('default')
  })
})
