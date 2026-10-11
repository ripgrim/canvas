import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('UI-COLLAB-PRESENCE-001 collaboration CSS', () => {
  it('keeps Paper avatar, outline, overlap, focus, and blur metrics', () => {
    const css = readFileSync(new URL('./collaboration.css', import.meta.url), 'utf8')
    expect(css).toContain('width: 22px; height: 22px;')
    expect(css).toContain('width: 14px; height: 14px;')
    expect(css).toContain('margin-left: -4px;')
    expect(css).toContain('box-shadow: 0 0 0 2px var(--neutral-1)')
    expect(css).toContain('opacity: .8')
    expect(css).toContain('opacity: .25')
    expect(css).toContain('width: 8px; height: 8px;')
    expect(css).toContain('top: 6px; left: 6px;')
    expect(css).toContain('border-radius: 3px; padding: 0 6px;')
    expect(css).toContain('line-height: 20px;')
    expect(css).toContain('max-width: 100px; overflow: hidden; text-overflow: ellipsis;')
    expect(css).not.toContain('translateY(-1px)')
    expect(css).toContain('.collaboration-roster-item .collaboration-avatar { margin-left: 0; flex-shrink: 0; box-shadow: none; }')
    expect(css).toContain('bottom: 24px;')
    expect(css).toContain('width: 18px; height: 18px;')
    expect(css).toContain('backdrop-filter: blur(12px)')
    expect(css).toContain('.collaboration-tooltip')
    expect(css).toMatch(/\.collaboration-tooltip \{[^}]*border-radius: var\(--radius-s\);[^}]*padding: var\(--space-xxs\) var\(--space-xs\);[^}]*font-size: var\(--size-m\);[^}]*font-weight: var\(--weight-ui-medium\);/)
    expect(css).toContain('.collaboration-strip[data-floating] { position: absolute;')
    expect(css).not.toContain('.collaboration-strip { position: absolute;')
  })

  it('uses a ten pixel following boundary and removes cursor motion for reduced motion', () => {
    const css = readFileSync(new URL('./collaboration.css', import.meta.url), 'utf8')
    expect(css).toContain('border: 10px solid var(--collaboration-color)')
    expect(css).toContain('left: calc(var(--space-s) + 44px + var(--space-s))')
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.collaboration-cursor \{ transition: none;/)
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.collaboration-status-mark \{ animation: none;/)
  })

  it('keeps one compact themed status surface inside the canvas', () => {
    const css = readFileSync(new URL('./collaboration.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.collaboration-status \{[^}]*position: absolute;[^}]*top: var\(--space-s\);[^}]*background: var\(--neutral-1\);[^}]*box-shadow: var\(--border-shadow-s\), var\(--shadow-s\);/)
    expect(css).toContain('.collaboration-status[data-tone="danger"] { color: var(--error); }')
  })

  it('preserves the bottom-24 notice while clearing the narrow footer', () => {
    const css = readFileSync(new URL('./collaboration.css', import.meta.url), 'utf8')
    expect(css).toContain('.canvas-area:has(> .collaboration-read-only) { padding-bottom: 72px; }')
    expect(css).toContain('max-width: calc(100% - 48px);')
    expect(css).toContain('-webkit-backdrop-filter: blur(12px);')
    expect(css).not.toContain('.collaboration-read-only { bottom: 68px;')
  })

})
