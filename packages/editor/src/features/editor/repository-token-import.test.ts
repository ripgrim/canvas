import { describe, expect, it } from 'vitest'
import type { ShadcnToken } from '@canvas/scanner/contracts'
import { repositoryTokenCatalog } from './repository-token-import'

const token = (name: string, value: string, theme = 'base'): ShadcnToken => ({ name, value, theme, path: 'src/globals.css', selector: theme === 'dark' ? '.dark' : ':root', atRules: [], aliases: [...value.matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map(match => match[1]!), line: 1, column: 1 })

describe('AT-REPO-TOKEN-001 repository color catalog', () => {
  it('deduplicates themes, resolves aliases, and hides non-color variables', () => {
    const catalog = repositoryTokenCatalog([
      token('--background', 'oklch(1 0 0)'),
      token('--background', 'oklch(0.2 0 0)', 'dark'),
      token('--color-background', 'var(--background)', 'custom'),
      token('--brand', '#685fff'),
      token('--radius', '0.5rem'),
      token('--font-sans', '"Geist Variable", sans-serif', 'custom'),
      token('--font-heading', 'var(--font-sans)', 'custom'),
    ])

    expect(catalog.hidden).toBe(3)
    expect(catalog.colors.map(entry => ({ property: entry.property, color: entry.color, themes: entry.themes }))).toEqual([
      { property: '--background', color: 'oklch(1 0 0)', themes: ['base', 'dark'] },
      { property: '--brand', color: '#685fff', themes: ['base'] },
      { property: '--color-background', color: 'oklch(1 0 0)', themes: ['custom'] },
    ])
  })

  it('rejects alias cycles and unsupported composite values instead of inventing a swatch', () => {
    const catalog = repositoryTokenCatalog([
      token('--a', 'var(--b)'), token('--b', 'var(--a)'), token('--shadow', '0 2px 8px #000'),
    ])
    expect(catalog).toEqual({ colors: [], hidden: 3 })
  })
})
