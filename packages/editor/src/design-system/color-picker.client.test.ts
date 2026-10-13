// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Popover } from '@base-ui/react/popover'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColorDraft } from './color-picker'

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: ReturnType<typeof createRoot> | null = null

const setRange = (input: HTMLInputElement, value: number) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, String(value))
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const mount = async (value: string, onPreview = vi.fn(), onChange = vi.fn(), onCancel = vi.fn()) => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(createElement(Popover.Root, null, createElement(ColorDraft, { label: 'Fill', value, onPreview, onChange, onCancel, allowAlpha: true, close: null })))
  })
  return { host, onPreview, onChange, onCancel }
}

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe('COLOR-PICKER-001 independent hue rail', () => {
  it('retains hue movement for white before the saturation and brightness plane is used', async () => {
    const { host } = await mount('#ffffff')
    const hue = host.querySelector<HTMLInputElement>('input[aria-label="Hue"]')
    expect(hue).not.toBeNull()

    await act(async () => { setRange(hue!, 240) })

    expect(host.querySelector<HTMLElement>('.color-picker-rail-thumb')?.style.top).toBe('66.66666666666666%')
    expect(host.querySelector<HTMLElement>('.color-picker-plane')?.style.backgroundColor).toBe('rgb(0, 0, 255)')
  })
})

describe('COLOR-PREVIEW-001 transient color preview', () => {
  it('publishes drag samples immediately, commits once, and cancels a later uncommitted sample', async () => {
    const callbacks = await mount('#ff0000')
    const hue = callbacks.host.querySelector<HTMLInputElement>('input[aria-label="Hue"]')
    expect(hue).not.toBeNull()

    await act(async () => { setRange(hue!, 120) })
    expect(callbacks.onPreview).toHaveBeenLastCalledWith('#00ff00')
    expect(callbacks.onChange).not.toHaveBeenCalled()

    await act(async () => { hue!.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true })) })
    expect(callbacks.onChange).toHaveBeenCalledOnce()
    expect(callbacks.onChange).toHaveBeenLastCalledWith('#00ff00')

    await act(async () => { setRange(hue!, 240) })
    expect(callbacks.onPreview).toHaveBeenLastCalledWith('#0000ff')
    await act(async () => { hue!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
    expect(callbacks.onChange).toHaveBeenCalledOnce()
  })
})
