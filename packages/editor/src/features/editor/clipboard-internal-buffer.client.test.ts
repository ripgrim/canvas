// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { encodeInternalClipboardPayload } from './clipboard-codec'
import { createInternalClipboardPayload } from './clipboard-internal'
import { internalClipboardBuffer, publishInternalClipboard } from './clipboard-internal-buffer'

afterEach(() => internalClipboardBuffer.clear())

describe('PAPER-CLIP-003 shared internal clipboard', () => {
  it('shares one validated payload and both browser representations', () => {
    const file = createBlankFile('file', 'page', 'root')
    file.nodes.layer = { id: 'layer', type: 'rectangle', name: 'Layer', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 20, height: 20 } }
    file.relationships.layer = { parentId: 'root', orderKey: 'V' }
    const payload = createInternalClipboardPayload(file, 'page', ['layer'])
    const value = encodeInternalClipboardPayload(payload, 'Layer')
    internalClipboardBuffer.remember(payload, value)
    expect(internalClipboardBuffer.get()).toStrictEqual({ payload, value, assets: {} })
  })

  it('writes HTML and plain text through ClipboardItem and reports denied writes', async () => {
    let written: ClipboardItem[] = []
    const write = vi.fn(async (items: ClipboardItem[]) => { written = [...items] })
    const writeText = vi.fn(async (_text: string) => undefined)
    const value = { html: '<p>Layer</p>', text: 'Layer' }
    expect(await publishInternalClipboard(value, { write, writeText }, ClipboardItem)).toBe(true)
    const item = written[0]!
    expect(await item.getType('text/html').then(blob => blob.text())).toBe(value.html)
    expect(await item.getType('text/plain').then(blob => blob.text())).toBe(value.text)
    expect(await publishInternalClipboard(value, { write: async () => { throw new Error('Denied') }, writeText }, ClipboardItem)).toBe(false)
  })
})
