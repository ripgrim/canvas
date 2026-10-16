import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createBlankFile, tokenTypes } from '@canvas/repo-engine/file-document'
import { documentStore } from './document-store'
import { ThemePanel } from './ThemePanel'

describe('AT-DOC-004 token groups', () => {
  it('renders every supported token type as a named group', () => {
    documentStore.load(createBlankFile('token-file', 'page', 'root'), [], { replace: true, pageId: 'page' })
    for (const type of tokenTypes) expect(documentStore.commands.theme.createToken(type)).toBeTruthy()
    const html = renderToStaticMarkup(h(ThemePanel))
    for (const label of ['Color', 'Opacity', 'Radius', 'Spacing', 'Container', 'Breakpoint', 'Font family', 'Font weight', 'Font size', 'Line height', 'Letter spacing']) expect(html).toContain(`theme-group-${typeId(label)}`)
    expect(html).toContain('aria-label="Add token"')
  })
})

const typeId = (label: string) => ({
  Color: 'color', Opacity: 'opacity', Radius: 'radius', Spacing: 'spacing', Container: 'container', Breakpoint: 'breakpoint',
  'Font family': 'fontFamily', 'Font weight': 'fontWeight', 'Font size': 'fontSize', 'Line height': 'lineHeight', 'Letter spacing': 'letterSpacing',
} satisfies Record<string, string>)[label]
