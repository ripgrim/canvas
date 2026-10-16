// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationRouteContent, isPublicFileRoute } from './ApplicationDocument'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('AT-UX-003 route continuity', () => {
  it('recognizes only exact public file paths on the server and client', () => {
    expect(isPublicFileRoute('/file/first-file')).toBe(true)
    expect(isPublicFileRoute('/file/first-file/')).toBe(true)
    expect(isPublicFileRoute('/file/first-file/private')).toBe(false)
    expect(isPublicFileRoute('/files/first-file')).toBe(false)
  })

  it('shows the startup shell only before the first file route resolves', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(createElement(ApplicationRouteContent, {
        pathname: '/file/first-file',
        status: 'pending',
        resolvedLocation: undefined,
        children: createElement('button', null, 'Existing canvas'),
      }))
    })

    expect(host.querySelector('.startup-root')?.textContent).toContain('Opening file')
    expect(host.textContent).not.toContain('Existing canvas')
  })

  it('keeps the resolved canvas interactive while another file is pending', async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const pressed = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(createElement(ApplicationRouteContent, {
        pathname: '/file/second-file',
        status: 'pending',
        resolvedLocation: { pathname: '/file/first-file' },
        children: createElement('button', { onClick: pressed }, 'Existing canvas'),
      }))
    })

    expect(host.querySelector('.startup-root')).toBeNull()
    const canvas = host.querySelector<HTMLButtonElement>('button')
    expect(canvas?.textContent).toBe('Existing canvas')
    await act(async () => { canvas?.click() })
    expect(pressed).toHaveBeenCalledOnce()
  })
})
