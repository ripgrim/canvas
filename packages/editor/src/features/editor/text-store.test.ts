import { describe, expect, it, vi } from 'vitest'
import type { EditorPersistenceIntent } from '../../capabilities'
import type { FileDocument, TextSizing, TextStyle } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'

const style = (): TextStyle => ({
  fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16,
  lineHeight: { kind: 'normal' }, letterSpacing: 0,
  horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false,
})
const styled = (): TextStyle => ({
  fontFamily: 'Geist Sans', fontStyle: 'italic', fontWeight: 600, fontSize: 24,
  lineHeight: { kind: 'px', value: 30 }, letterSpacing: -0.4,
  horizontalAlign: 'right', verticalAlign: 'bottom', case: 'capitalize', wrap: 'pretty', keepWords: true,
})
const fixed = (): TextSizing => ({ width: { mode: 'fixed' }, height: { mode: 'fixed' } })
const fit = (): TextSizing => ({ width: { mode: 'fit' }, height: { mode: 'fit' } })

const fixture = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'text-store-file',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'text-a': { id: 'text-a', type: 'text', name: 'First', text: 'First', textStyle: style(), textSizing: fixed(), styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 30 } },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 50], width: 300, height: 200 } },
    'text-b': { id: 'text-b', type: 'text', name: 'Second', text: 'Second', textStyle: style(), textSizing: fixed(), styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 100, height: 30 } },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 120, 0], width: 20, height: 20 } },
  },
  relationships: {
    'text-a': { parentId: 'root-1', orderKey: 'V' },
    frame: { parentId: 'root-1', orderKey: 'W' },
    'text-b': { parentId: 'frame', orderKey: 'V' },
    box: { parentId: 'root-1', orderKey: 'X' },
  },
  theme: { tokens: {} },
})

const setup = () => {
  let sequence = 0
  const store = createDocumentStore(() => `session-${++sequence}`)
  store.load(fixture(), [])
  return store
}
const text = (store: ReturnType<typeof setup>, nodeId = 'text-a') => {
  const node = store.getSnapshot().file!.nodes[nodeId]
  if (!node || node.type !== 'text') throw new Error('Expected text node')
  return node
}
const key = (value: string, shiftKey = false) => ({ key: value, ctrlKey: false, metaKey: false, shiftKey, altKey: false })

describe('PAPER-TEXT-006 complete property writes', () => {
  it('stores complete properties as one history step, then restores and redoes exact literal values', () => {
    const store = setup()
    expect(store.commands.text.setProperties('text-a', styled(), fit())).toBe(true)
    expect(text(store)).toMatchObject({ textStyle: styled(), textSizing: fit() })
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.getHistory().past[0]?.redo).toEqual({ type: 'node.setTextProperties', nodeId: 'text-a', textStyle: styled(), textSizing: fit() })
    expect(store.undo()).toBe(true)
    expect(text(store)).toMatchObject({ textStyle: style(), textSizing: fixed() })
    expect(store.redo()).toBe(true)
    expect(text(store)).toMatchObject({ textStyle: styled(), textSizing: fit() })
  })

  it('forces Fit height when max lines is enabled, rejects malformed coupling, and preserves sizing when disabled', () => {
    const store = setup()
    expect(store.commands.text.setProperties('text-a', { ...style(), maxLines: 2 }, fixed())).toBe(false)
    expect(text(store)).toMatchObject({ textStyle: style(), textSizing: fixed() })
    expect(store.commands.text.setMaxLines('text-a', 2)).toBe(true)
    expect(text(store)).toMatchObject({ textStyle: { ...style(), maxLines: 2 }, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } })
    expect(store.commands.text.setMaxLines('text-a', undefined)).toBe(true)
    expect(text(store)).toMatchObject({ textStyle: style(), textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } })
  })

  it('treats current complete properties as a no-op with no revision or history', () => {
    const store = setup()
    expect(store.commands.text.setProperties('text-a', style(), fixed())).toBe(false)
    expect(store.getSnapshot().file?.revision).toBe(0)
    expect(store.getHistory()).toEqual({ past: [], future: [] })
  })

  it('applies multi-selection typography and truncation as one revision and one undo step', () => {
    const store = setup()
    const secondStyle = { ...styled(), fontSize: 30 }
    expect(store.commands.text.setPropertiesMany([
      { nodeId: 'text-a', textStyle: styled(), textSizing: fit() },
      { nodeId: 'text-b', textStyle: secondStyle, textSizing: fit() },
    ])).toBe(true)
    expect(text(store, 'text-a')).toMatchObject({ textStyle: styled(), textSizing: fit() })
    expect(text(store, 'text-b')).toMatchObject({ textStyle: secondStyle, textSizing: fit() })
    expect(store.getSnapshot().file?.revision).toBe(1)
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(text(store, 'text-a')).toMatchObject({ textStyle: style(), textSizing: fixed() })
    expect(text(store, 'text-b')).toMatchObject({ textStyle: style(), textSizing: fixed() })

    expect(store.commands.text.setMaxLinesMany([{ nodeId: 'text-a', maxLines: 2 }, { nodeId: 'text-b', maxLines: 4 }])).toBe(true)
    expect(text(store, 'text-a')).toMatchObject({ textStyle: { ...style(), maxLines: 2 }, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } })
    expect(text(store, 'text-b')).toMatchObject({ textStyle: { ...style(), maxLines: 4 }, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } })
    expect(store.getHistory().past).toHaveLength(1)
  })
})

describe('PAPER-TEXT-005 live text transaction', () => {
  it('publishes each distinct update in order while commit creates one undo with an exact final redo', async () => {
    const store = setup()
    const writes: Array<{ text: string; expected: number; intent: EditorPersistenceIntent }> = []
    store.configure({ persist: async (file, expected, intent) => {
      writes.push({ text: (file.nodes['text-a'] as { text: string }).text, expected, intent })
      return { ...file, revision: expected + 1 }
    } })

    const sessionId = store.commands.text.begin('text-a')
    expect(sessionId).toBe('session-1')
    expect(store.getSnapshot().textEditing).toEqual({ sessionId: 'session-1', nodeId: 'text-a' })
    expect(store.commands.text.update(sessionId!, 'F')).toBe(true)
    expect(text(store).text).toBe('F')
    expect(store.commands.text.update(sessionId!, 'Fi')).toBe(true)
    expect(store.commands.text.update(sessionId!, 'Final')).toBe(true)
    expect(store.commands.text.update(sessionId!, 'Final')).toBe(false)
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.commands.text.commit(sessionId!)).toBe(true)
    expect(store.getSnapshot().textEditing).toBeNull()
    expect(store.getSnapshot().renaming).toBeNull()
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.getHistory().past[0]).toMatchObject({
      undo: { type: 'node.setText', nodeId: 'text-a', text: 'First' },
      redo: { type: 'node.setText', nodeId: 'text-a', text: 'Final' },
    })

    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    expect(writes.map(write => write.text)).toEqual(['F', 'Fi', 'Final'])
    expect(writes.map(write => write.intent)).toEqual([
      { kind: 'commands', commands: [{ type: 'node.setText', nodeId: 'text-a', text: 'F' }] },
      { kind: 'commands', commands: [{ type: 'node.setText', nodeId: 'text-a', text: 'Fi' }] },
      { kind: 'commands', commands: [{ type: 'node.setText', nodeId: 'text-a', text: 'Final' }] },
    ])
    expect(writes.at(-1)?.intent.commands[0]).toEqual(store.getHistory().past[0]?.redo)
    expect(text(store).text).toBe('Final')

    expect(store.undo()).toBe(true)
    expect(text(store).text).toBe('First')
    expect(store.redo()).toBe(true)
    expect(text(store).text).toBe('Final')
  })

  it('restores cancellation through sync without history and rejects stale or overlapping sessions', async () => {
    const store = setup()
    const writes: string[] = []
    store.configure({ persist: async (file, expected) => { writes.push((file.nodes['text-a'] as { text: string }).text); return { ...file, revision: expected + 1 } } })
    const sessionId = store.commands.text.begin('text-a')!
    expect(store.commands.text.begin('text-b')).toBeNull()
    expect(store.commands.text.update('stale-session', 'Wrong')).toBe(false)
    expect(store.commands.text.update(sessionId, '')).toBe(true)
    expect(store.commands.text.cancel('stale-session')).toBe(false)
    expect(store.commands.text.cancel(sessionId)).toBe(true)
    expect(text(store).text).toBe('First')
    expect(store.getHistory()).toEqual({ past: [], future: [] })
    expect(store.commands.text.update(sessionId, 'Late')).toBe(false)
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    expect(writes).toEqual(['', 'First'])
  })

  it('keeps a clean active session open across a newer unrelated collaborator snapshot', async () => {
    const store = setup()
    const writes: Array<{ expected: number; text: string }> = []
    store.configure({ persist: async (file, expected) => {
      writes.push({ expected, text: (file.nodes['text-a'] as { text: string }).text })
      return { ...file, revision: expected + 1 }
    } })
    const sessionId = store.commands.text.begin('text-a')!
    expect(store.commands.text.update(sessionId, 'Local')).toBe(true)
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))

    const incoming = structuredClone(store.getSnapshot().file!)
    incoming.revision += 1
    const remoteBox = incoming.nodes.box
    if (!remoteBox || remoteBox.type !== 'rectangle') throw new Error('Expected rectangle')
    remoteBox.styles.relativeTransform = [1, 0, 0, 1, 180, remoteBox.styles.relativeTransform[5]]
    store.load(incoming, [])

    expect(store.getSnapshot().textEditing).toEqual({ sessionId, nodeId: 'text-a' })
    expect(text(store).text).toBe('Local')
    expect(store.getSnapshot().file?.nodes.box).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 180, 0] } })
    expect(store.commands.text.update(sessionId, 'Final')).toBe(true)
    expect(store.commands.text.commit(sessionId)).toBe(true)
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    expect(writes).toEqual([{ expected: 0, text: 'Local' }, { expected: 2, text: 'Final' }])

    expect(store.undo()).toBe(true)
    expect(text(store).text).toBe('First')
    expect(store.getSnapshot().file?.nodes.box).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 180, 0] } })
  })

  it('ends the session safely when an external replacement removes the edited node', () => {
    const store = setup()
    const sessionId = store.commands.text.begin('text-a')!
    const incoming = structuredClone(store.getSnapshot().file!)
    incoming.revision += 1
    delete incoming.nodes['text-a']
    delete incoming.relationships['text-a']

    store.load(incoming, [])

    expect(store.getSnapshot().textEditing).toBeNull()
    expect(store.getSnapshot().renaming).toBeNull()
    expect(store.commands.text.update(sessionId, 'Late')).toBe(false)
  })

  it('reapplies accepted local text when an unexpected same-node snapshot arrives mid-session', async () => {
    const store = setup()
    const writes: Array<{ expected: number; text: string }> = []
    store.configure({ persist: async (file, expected) => {
      writes.push({ expected, text: (file.nodes['text-a'] as { text: string }).text })
      return { ...file, revision: expected + 1 }
    } })
    const sessionId = store.commands.text.begin('text-a')!
    expect(store.commands.text.update(sessionId, 'Local')).toBe(true)
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))

    const incoming = structuredClone(store.getSnapshot().file!)
    incoming.revision += 1
    const remoteText = incoming.nodes['text-a']
    if (!remoteText || remoteText.type !== 'text') throw new Error('Expected text')
    remoteText.text = 'Remote'
    store.load(incoming, [])

    expect(store.getSnapshot().textEditing).toEqual({ sessionId, nodeId: 'text-a' })
    expect(text(store).text).toBe('Local')
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    expect(writes).toEqual([{ expected: 0, text: 'Local' }, { expected: 2, text: 'Local' }])
  })
})

describe('PAPER-TEXT-005 keyboard and traversal foundation', () => {
  it('starts editing with Enter and traverses text nodes in document order with wrap', () => {
    const store = setup()
    store.select('text-a')
    expect(store.handleKey(key('Enter'))).toBe(true)
    const firstSession = store.getSnapshot().textEditing
    expect(firstSession).toEqual({ sessionId: 'session-1', nodeId: 'text-a' })
    expect(store.commands.text.commit(firstSession!.sessionId)).toBe(true)

    const next = store.commands.text.focusAdjacent('text-a', 'next')
    expect(next).toBe('session-2')
    expect(store.getSnapshot().selection).toEqual(['text-b'])
    expect(store.commands.text.commit(next!)).toBe(true)
    const wrapped = store.commands.text.focusAdjacent('text-b', 'next')
    expect(store.getSnapshot().selection).toEqual(['text-a'])
    expect(store.commands.text.cancel(wrapped!)).toBe(true)
    const previous = store.commands.text.focusAdjacent('text-a', 'previous')
    expect(store.getSnapshot().selection).toEqual(['text-b'])
    expect(store.commands.text.cancel(previous!)).toBe(true)
  })

  it('does not enter or mutate text while the document is read-only', () => {
    const store = setup()
    store.select('text-a')
    store.setReadOnly(true)

    expect(store.commands.text.begin('text-a')).toBeNull()
    expect(store.handleKey(key('Enter'))).toBe(true)
    expect(store.commands.text.setProperties('text-a', styled(), fit())).toBe(false)
    expect(text(store)).toMatchObject({ text: 'First', textStyle: style(), textSizing: fixed() })
    expect(store.getSnapshot().textEditing).toBeNull()
    expect(store.getHistory()).toEqual({ past: [], future: [] })
  })
})
