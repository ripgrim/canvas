import { describe, expect, it } from 'vitest'
import { acceptPreviewCommand, isLayoutDeclarations, protocolVersion } from '../src/protocol.js'

const parent = {} as Window
const command = (alignItems: string) => ({
  channel: 'design-editor-preview',
  version: protocolVersion,
  generation: 7,
  type: 'set-layout', flowDragTerminalPolicy: 'preserve-matching-committed-handoff',
  layoutGeneration: 11,
  items: [{ nodeId: 'frame-1', mode: 'flow', x: 0, y: 0, order: 0, declarations: { display: 'flex', 'align-items': alignItems } }],
})

describe('PAPER-FLEX-005 last baseline preview protocol', () => {
  it('accepts and preserves exact CSS last baseline across the preview message boundary', () => {
    const data = command('last baseline')
    expect(isLayoutDeclarations(data.items[0]!.declarations)).toBe(true)
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data }, 'http://127.0.0.1:4319', parent, 7)).toEqual(data)
    expect(JSON.parse(JSON.stringify(data)).items[0].declarations['align-items']).toBe('last baseline')
  })

  it.each(['last-baseline', 'first baseline', 'baseline last', 'Last baseline'])('rejects unsupported alignment %s as a mutation control', alignItems => {
    const data = command(alignItems)
    expect(isLayoutDeclarations(data.items[0]!.declarations)).toBe(false)
    expect(acceptPreviewCommand({ origin: 'http://127.0.0.1:4319', source: parent, data }, 'http://127.0.0.1:4319', parent, 7)).toBeNull()
  })
})
