import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { CrossAlignment, FlexContainer } from '@canvas/repo-engine/layout'
import { createDocumentStore } from './document-store'
import { redirectFlex } from './layout-flex-commands'

const flex = (align: CrossAlignment): FlexContainer => ({ direction: 'row', wrap: 'nowrap', justify: 'start', align })
const fixture = (align: CrossAlignment = 'baseline'): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'baseline-store',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: {
      id: 'frame',
      type: 'frame',
      name: 'Frame',
      styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 300, height: 180 },
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: flex(align) } },
    },
  },
  relationships: { frame: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})

const loaded = (align?: CrossAlignment) => {
  const store = createDocumentStore(() => 'unused')
  store.load(fixture(align), [])
  return store
}
const storedFlex = (store: ReturnType<typeof loaded>) => {
  const node = store.getSnapshot().file!.nodes.frame
  return node && node.type !== 'root' ? node.layout!.container!.flex! : null
}

describe('PAPER-FLEX-004/005 last baseline store behavior', () => {
  it('keeps last baseline distinct through one revision and exact undo/redo', () => {
    const store = loaded()
    expect(store.commands.layout.setAlignment({ align: 'last baseline' }, ['frame'])).toBe(true)
    expect(storedFlex(store)).toEqual({ direction: 'row', wrap: 'nowrap', justify: 'start', align: 'last baseline' })
    expect(store.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false, file: { revision: 1 } })

    expect(store.undo()).toBe(true)
    expect(storedFlex(store)).toEqual({ direction: 'row', wrap: 'nowrap', justify: 'start', align: 'baseline' })
    expect(store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true, file: { revision: 2 } })

    expect(store.redo()).toBe(true)
    expect(storedFlex(store)).toEqual({ direction: 'row', wrap: 'nowrap', justify: 'start', align: 'last baseline' })
    expect(store.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false, file: { revision: 3 } })
    expect(JSON.parse(JSON.stringify(store.getSnapshot().file)).nodes.frame.layout.container.flex.align).toBe('last baseline')
  })

  it('does not create history for the same value and rejects an unsupported lookalike without mutation', () => {
    const store = loaded('last baseline')
    const before = JSON.stringify(store.getSnapshot().file)
    expect(store.commands.layout.setAlignment({ align: 'last baseline' }, ['frame'])).toBe(false)
    expect(store.commands.layout.setAlignment({ align: 'last-baseline' as CrossAlignment }, ['frame'])).toBe(false)
    expect(JSON.stringify(store.getSnapshot().file)).toBe(before)
    expect(store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false, file: { revision: 0 } })
  })

  it('uses Paper direction fallbacks without treating first and last baseline as the same value', () => {
    expect(redirectFlex({ direction: 'row', wrap: 'nowrap', justify: 'start', align: 'baseline' }, 'column')).toEqual({ direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' })
    expect(redirectFlex({ direction: 'row', wrap: 'nowrap', justify: 'start', align: 'last baseline' }, 'column')).toEqual({ direction: 'column', wrap: 'nowrap', justify: 'end', align: 'start' })
    expect(redirectFlex({ direction: 'row', wrap: 'nowrap', justify: 'space-between', align: 'baseline' }, 'column')).toEqual({ direction: 'column', wrap: 'nowrap', justify: 'space-between', align: 'start' })
    expect(redirectFlex({ direction: 'row', wrap: 'nowrap', justify: 'space-between', align: 'last baseline' }, 'column')).toEqual({ direction: 'column', wrap: 'nowrap', justify: 'space-between', align: 'end' })
  })
})
