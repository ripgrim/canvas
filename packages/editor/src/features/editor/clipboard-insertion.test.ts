import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'

const loaded = () => {
  let id = 0
  const store = createDocumentStore(() => `clipboard-${++id}`)
  store.load(createBlankFile('file', 'page', 'root'), [])
  store.setViewportSize({ width: 800, height: 600 })
  return store
}

describe('PAPER-CLIP-005 text insertion', () => {
  it('inserts Fit text at the visible center in one undoable semantic command', () => {
    const store = loaded()
    expect(store.commands.insertClipboardText('Pasted text')).toBe(true)
    const state = store.getSnapshot()
    const id = state.selection[0]!
    expect(state.file?.nodes[id]).toMatchObject({
      id,
      type: 'text',
      text: 'Pasted text',
      textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } },
      styles: { relativeTransform: [1, 0, 0, 1, 0, 0] },
    })
    expect(state.file?.relationships[id]?.parentId).toBe('root')
    expect(state.canUndo).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.getSnapshot().file?.nodes[id]).toBeUndefined()
  })

  it('uses the selected compatible frame and converts the viewport center into parent-local coordinates', () => {
    const store = loaded()
    expect(store.commands.insertCanvas('frame', { x: 100, y: 50, width: 200, height: 150 })).toBe(true)
    const frameId = store.getSnapshot().selection[0]!
    store.setViewport({ x: -200, y: -125, zoom: 1 })
    expect(store.commands.insertClipboardText('Inside')).toBe(true)
    const state = store.getSnapshot()
    const textId = state.selection[0]!
    expect(state.file?.relationships[textId]?.parentId).toBe(frameId)
    expect(state.file?.nodes[textId]).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 100, 75] } })
  })

  it('climbs from a selected child to the nearest compatible frame containing the insertion point', () => {
    const store = loaded()
    expect(store.commands.insertCanvas('frame', { x: 100, y: 50, width: 200, height: 150 })).toBe(true)
    const frameId = store.getSnapshot().selection[0]!
    expect(store.commands.execute({
      type: 'node.insert',
      node: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 20, height: 20 } },
      placement: { parentId: frameId },
    }, ['child'])).toBe(true)
    store.setViewport({ x: -200, y: -125, zoom: 1 })
    expect(store.commands.insertClipboardText('Nested')).toBe(true)
    const state = store.getSnapshot()
    expect(state.file?.relationships[state.selection[0]!]!.parentId).toBe(frameId)
  })

  it('refuses empty, oversized, and read-only insertion without changing the document', () => {
    const store = loaded()
    const before = store.getSnapshot().file
    expect(store.commands.insertClipboardText('')).toBe(false)
    expect(store.commands.insertClipboardText('x'.repeat(10_001))).toBe(false)
    store.setReadOnly(true)
    expect(store.commands.insertClipboardText('No write')).toBe(false)
    expect(store.getSnapshot().file).toBe(before)
  })
})
