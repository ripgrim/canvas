import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { filterHomeFiles, HomeView, matchesHomeFile } from './HomeView'
import type { HomeFile, HomeViewProps } from './home-types'

const files: readonly HomeFile[] = [
  { id: 'one', name: 'Quiet footer', location: 'local', updatedAt: '1 minute ago' },
  { id: 'two', name: 'Split story', location: 'cloud', updatedAt: '2 minutes ago' },
]
const errorReference = '11111111-2222-4333-8444-555555555555'

function props(overrides: Partial<HomeViewProps> = {}): HomeViewProps {
  return {
    mode: 'light',
    workspaceName: 'Comp Canvas',
    accountName: 'Caleb Perry',
    files,
    status: { kind: 'ready' },
    create: { available: true, reason: '' },
    open: { available: true, reason: '' },
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
}

describe('AT-UX-003 home presentation', () => {
  it('filters recents by name or source without changing the source collection', () => {
    expect(matchesHomeFile(files[0]!, 'quiet')).toBe(true)
    expect(matchesHomeFile(files[1]!, 'LOCAL')).toBe(false)
    expect(filterHomeFiles(files, 'cloud')).toEqual([files[1]])
    expect(files).toHaveLength(2)
  })

  it('renders the Paper-shaped Recents shell with a neutral New file action', () => {
    const html = renderToStaticMarkup(h(HomeView, props()))
    expect(html).toContain('aria-label="Home"')
    expect(html).toContain('>Recents<')
    expect(html).toContain('button-outline')
    expect(html).not.toContain('button-primary')
    expect(html).toContain('>New file<')
    expect(html).toContain('data-view="grid"')
    expect(html).toContain('Quiet footer')
  })

  it('renders independent empty, loading, and error states', () => {
    const empty = renderToStaticMarkup(h(HomeView, props({ files: [] })))
    const loading = renderToStaticMarkup(h(HomeView, props({ status: { kind: 'creating', phases: [{ name: 'Creating local file', state: 'active' }] } })))
    const failed = renderToStaticMarkup(h(HomeView, props({ status: { kind: 'error', operation: 'list', message: 'Offline', reference: errorReference } })))
    expect(empty).toContain('No files')
    expect(loading).toContain('role="status"')
    expect(loading).toContain('Creating file')
    expect(loading).toContain('Creating local file')
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>.*New file/s)
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Files could not be loaded')
    expect(failed).toContain('Try again')
    expect(failed).toContain(`Error ID ${errorReference}`)
  })
})
