import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileLoading, FileScreen } from './FileScreen'

describe('FILE-OPEN-SLOW-001 file opening presentation', () => {
  it('uses the same stable startup shell before and after the slow-open threshold', () => {
    const opening = renderToStaticMarkup(h(FileLoading))
    const slow = renderToStaticMarkup(h(FileLoading, { slow: true, onRetry: () => undefined, onHome: () => undefined }))

    expect(opening).toContain('class="startup-root"')
    expect(slow).toContain('class="startup-root"')
    expect(opening).toContain('class="startup-detail"')
    expect(opening).toContain('class="startup-actions"')
    expect(opening).not.toContain('home-status-screen')
  })

  it('keeps a slow open pending and offers retry and back actions', () => {
    const html = renderToStaticMarkup(h(FileLoading, {
      slow: true,
      onRetry: () => undefined,
      onHome: () => undefined,
    }))

    expect(html).toContain('Opening file')
    expect(html).toContain('This is taking longer than usual.')
    expect(html).toContain('Try again')
    expect(html).toContain('Back to files')
    expect(html).toContain('role="status"')
  })

  it('renders a real file error with its reference', () => {
    const html = renderToStaticMarkup(h(FileScreen, {
      result: { status: 'error', message: 'The collaboration service could not open this file.', reference: '11111111-2222-4333-8444-555555555555' },
      onHome: () => undefined,
      onPageChange: () => undefined,
      onOpenDefaultPage: () => undefined,
    }))

    expect(html).toContain('The file could not be opened')
    expect(html).toContain('The collaboration service could not open this file.')
    expect(html).toContain('Error ID 11111111-2222-4333-8444-555555555555')
    expect(html).toContain('role="alert"')
  })
})
