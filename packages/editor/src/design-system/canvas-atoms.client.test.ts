// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasTextEditor, NodeNameEditor } from './canvas-atoms'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLDivElement | null = null

afterEach(async () => {
  await act(async () => { root?.unmount() })
  host?.remove()
  root = null
  host = null
})

const mount = async (element: ReturnType<typeof createElement>) => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root?.render(element) })
  return host
}

describe('TEXT-ESCAPE-COMMIT-001 text completion', () => {
  it('commits canvas text on Escape instead of cancelling it', async () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const mounted = await mount(createElement(CanvasTextEditor, {
      id: 'text-1',
      value: 'Add secret',
      label: 'Edit text',
      style: {},
      onUpdate: () => true,
      onCommit,
      onCancel,
      onTraverse: vi.fn(),
    }))

    mounted.querySelector<HTMLElement>('[contenteditable]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('keeps Escape as cancel for layer-name editing', async () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const mounted = await mount(createElement(NodeNameEditor, {
      id: 'layer-1',
      pose: { x: 0, y: 0, width: 120, angle: 0 },
      value: 'Layer',
      label: 'Rename layer',
      onCommit,
      onCancel,
    }))

    mounted.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
  })
})
