import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesktopAuthBoundary } from './DesktopAuthBoundary'

describe('AT-UX-003 application startup shell', () => {
  it('server-renders the styled startup shell before authentication resolves', () => {
    const html = renderToStaticMarkup(h(DesktopAuthBoundary, null, h('span', null, 'Workspace')))

    expect(html).toContain('class="startup-root"')
    expect(html).toContain('class="startup-mark"')
    expect(html).toContain('Checking your session…')
    expect(html).not.toContain('class="theme-dark auth-root"')
    expect(html).not.toContain('Workspace')
  })

  it('uses a route-owned startup fallback without exposing protected content', () => {
    const html = renderToStaticMarkup(h(DesktopAuthBoundary, { loadingFallback: h('main', { className: 'file-startup' }, 'Opening file'), children: h('span', null, 'Workspace') }))

    expect(html).toContain('class="file-startup"')
    expect(html).toContain('Opening file')
    expect(html).not.toContain('Checking your session')
    expect(html).not.toContain('Workspace')
  })
})
