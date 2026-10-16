// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvasClipboardService } from './clipboard-service'
import type { ClipboardDataSource } from './clipboard-codec'

const pasteEvent = (data: ClipboardDataSource): ClipboardEvent => {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: data })
  return event
}

const copyEvent = (data: Pick<DataTransfer, 'setData'>): ClipboardEvent => {
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: data })
  return event
}

const cutEvent = (data: Pick<DataTransfer, 'setData'>): ClipboardEvent => {
  const event = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: data })
  return event
}

const dragEvent = (type: 'dragover' | 'drop', data: ClipboardDataSource): DragEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: data })
  return event
}

const text = (value: string): ClipboardDataSource => ({ types: ['text/plain'], files: [], getData: type => type === 'text/plain' ? value : '' })

afterEach(() => document.body.replaceChildren())

describe('PAPER-CLIP-001 and PAPER-CLIP-003 clipboard event ownership', () => {
  it('crosses the ClipboardEvent boundary and owns a supported canvas paste', async () => {
    const receive = vi.fn()
    const service = createCanvasClipboardService(window, receive)
    const canvas = document.createElement('div')
    document.body.append(canvas)
    service.start()
    const event = pasteEvent(text('Hello'))
    canvas.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(receive).toHaveBeenCalledWith({ kind: 'text', text: 'Hello' }, undefined))
    service.stop()
  })

  it('does not intercept editable targets and reports unsupported data without claiming it', () => {
    const receive = vi.fn()
    const service = createCanvasClipboardService(window, receive)
    const input = document.createElement('input')
    document.body.append(input)
    service.start()
    const editable = pasteEvent(text('Hello'))
    input.dispatchEvent(editable)
    expect(editable.defaultPrevented).toBe(false)
    expect(receive).not.toHaveBeenCalled()

    const unsupported = pasteEvent({ types: ['application/octet-stream'], files: [], getData: () => '' })
    document.body.dispatchEvent(unsupported)
    expect(unsupported.defaultPrevented).toBe(false)
    expect(receive).toHaveBeenLastCalledWith({ kind: 'unsupported', diagnostic: 'Clipboard does not contain a supported representation' }, undefined)
    service.stop()
  })

  it('leaves a recognized representation alone when the current editor adapter cannot insert it', () => {
    const receive = vi.fn()
    const service = createCanvasClipboardService(window, receive, undefined, undefined, candidate => candidate.kind === 'text')
    service.start()
    const image = new File(['png'], 'photo.png', { type: 'image/png' })
    const event = pasteEvent({ types: ['Files'], files: [image], getData: () => '' })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(receive).not.toHaveBeenCalled()
    service.stop()
  })

  it('start and stop are idempotent and drops work that finishes after stop', async () => {
    const receive = vi.fn()
    const service = createCanvasClipboardService(window, receive)
    service.start(); service.start()
    document.body.dispatchEvent(pasteEvent(text('Once')))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    service.stop(); service.stop()
    document.body.dispatchEvent(pasteEvent(text('Never')))
    expect(receive).toHaveBeenCalledTimes(1)
  })

  it('writes both internal HTML and plain fallback text through a real copy event', () => {
    const setData = vi.fn()
    const service = createCanvasClipboardService(window, vi.fn(), undefined, undefined, undefined, () => ({ html: '<p>Layer</p>', text: 'Layer' }))
    service.start()
    const event = copyEvent({ setData })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(setData.mock.calls).toEqual([['text/html', '<p>Layer</p>'], ['text/plain', 'Layer']])
    service.stop()
  })

  it('runs the cut mutation only after clipboard data is written', () => {
    const order: string[] = []
    const service = createCanvasClipboardService(window, vi.fn(), undefined, undefined, undefined, () => ({ html: '<p>Layer</p>', text: 'Layer' }), kind => order.push(kind))
    service.start()
    const event = cutEvent({ setData: type => { order.push(type) } })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(order).toEqual(['text/html', 'text/plain', 'cut'])
    service.stop()
  })

  it('claims supported drops only on the configured canvas target', async () => {
    const receive = vi.fn()
    const canvas = document.createElement('div')
    const outside = document.createElement('div')
    document.body.append(canvas, outside)
    const service = createCanvasClipboardService(window, receive, undefined, undefined, undefined, undefined, undefined, event => event?.type ?? 'none', event => event.target === canvas)
    service.start()
    const over = dragEvent('dragover', text('Dropped'))
    canvas.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const dropped = dragEvent('drop', text('Dropped'))
    canvas.dispatchEvent(dropped)
    expect(dropped.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(receive).toHaveBeenCalledWith({ kind: 'text', text: 'Dropped' }, 'drop'))
    const ignored = dragEvent('drop', text('Outside'))
    outside.dispatchEvent(ignored)
    expect(ignored.defaultPrevented).toBe(false)
    expect(receive).toHaveBeenCalledTimes(1)
    service.stop()
  })
})
