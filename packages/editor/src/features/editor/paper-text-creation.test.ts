import { describe, expect, it, vi } from 'vitest'
import type { FileDocument, TextStyle } from '@canvas/repo-engine/file-document'
import type { EditorPersistenceIntent } from '../../capabilities'
import { createCanvasGestures } from './canvas-gestures'
import { createCanvasHudProjectionService } from './canvas-hud-projection-service'
import { createDocumentStore } from './document-store'
import type { sceneGeometry } from './scene-geometry'

const style: TextStyle = {
  fontFamily: 'Inter, sans-serif',
  fontStyle: 'normal',
  fontWeight: 400,
  fontSize: 16,
  lineHeight: { kind: 'unitless', value: 1.25 },
  letterSpacing: 0,
  horizontalAlign: 'left',
  verticalAlign: 'top',
  case: 'none',
  wrap: 'normal',
  keepWords: false,
}

const document = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'paper-text-creation',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    existing: {
      id: 'existing',
      type: 'text',
      name: 'Existing',
      text: 'Keep me',
      textStyle: style,
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
      styles: { relativeTransform: [1, 0, 0, 1, -200, -160], width: 100, height: 24 },
    },
  },
  relationships: { existing: { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})

const pointer = (clientX: number, clientY: number) => ({ pointerId: 1, clientX, clientY, button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
const setup = () => {
  const ids = ['created-text', 'created-fill', 'text-session']
  const store = createDocumentStore(() => ids.shift() ?? `later-${ids.length}`)
  store.load(document(), [])
  store.setViewportSize({ width: 1000, height: 800 })
  const geometry = {
    getSnapshot: () => ({
      nodes: { existing: {
        canvasKind: 'text' as const, documentRevision: store.getSnapshot().file!.revision, layoutGeneration: store.getSnapshot().layoutGeneration,
        rect: { x: -200, y: -160, width: 100, height: 24 }, worldAabb: { x: -200, y: -160, width: 100, height: 24 },
        offset: { x: -200, y: -160, width: 100, height: 24, origin: { x: 50, y: 12 } }, offsetParentNodeId: null,
        offsetParentToRoot: [1, 0, 0, 1, 0, 0] as const, directChild: true, transform: [1, 0, 0, 1, 0, 0] as const,
        box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      } },
      revision: 1, documentRevision: store.getSnapshot().file!.revision, layoutGeneration: store.getSnapshot().layoutGeneration,
      unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    }),
    subscribe: () => () => undefined, update: () => undefined, clear: () => undefined,
  } as typeof sceneGeometry
  const projections = createCanvasHudProjectionService(store, geometry, { getSnapshot: () => false, subscribe: () => () => undefined })
  projections.start()
  const gestures = createCanvasGestures(store, geometry, undefined, projections)
  gestures.attach({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement)
  store.setTool('text')
  return { store, gestures }
}

describe('PAPER-TEXT-004 creation intent', () => {
  it('creates point text as empty Fit/Fit content without the legacy 180 by 40 authored rectangle', () => {
    const { store, gestures } = setup()

    gestures.stagePointerDown(pointer(700, 500))
    gestures.pointerMove(pointer(703, 500))
    expect(store.getSnapshot().transient).toBeNull()
    gestures.pointerUp(pointer(703, 500))

    expect(store.getSnapshot().file?.nodes['created-text']).toMatchObject({
      id: 'created-text',
      type: 'text',
      text: '',
      styles: { relativeTransform: [1, 0, 0, 1, 200, 100], width: 1, height: 1 },
      textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } },
    })
    expect(store.getSnapshot().tool).toBe('text')
    expect(store.getSnapshot().textEditing).toEqual({ sessionId: 'text-session', nodeId: 'created-text' })
  })

  it('creates crossed-threshold text with the authored drag rectangle and Fixed/Fixed sizing', () => {
    const { store, gestures } = setup()

    gestures.stagePointerDown(pointer(600, 450))
    gestures.pointerMove(pointer(720, 510))
    expect(store.getSnapshot().transient).toMatchObject({ kind: 'draw', rect: { x: 100, y: 50, width: 120, height: 60 } })
    gestures.pointerUp(pointer(720, 510))

    expect(store.getSnapshot().file?.nodes['created-text']).toMatchObject({
      id: 'created-text',
      type: 'text',
      text: '',
      styles: { relativeTransform: [1, 0, 0, 1, 100, 50], width: 120, height: 60 },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
    })
    expect(store.getSnapshot().tool).toBe('text')
    expect(store.getSnapshot().textEditing).toEqual({ sessionId: 'text-session', nodeId: 'created-text' })
  })

  it('rejects an incomplete drag rectangle instead of falling back to point or legacy geometry', () => {
    const { store } = setup()
    const before = store.getSnapshot().file

    expect(store.commands.insertCanvasText('drag', { x: 10, y: 20, width: 80 })).toBe(false)
    expect(store.getSnapshot().file).toBe(before)
    expect(store.getHistory()).toEqual({ past: [], future: [] })
  })

  it('groups drag creation and text entry into one semantic undo step', () => {
    const { store, gestures } = setup()
    gestures.stagePointerDown(pointer(600, 450))
    gestures.pointerUp(pointer(720, 510))
    const session = store.getSnapshot().textEditing!

    expect(store.commands.text.update(session.sessionId, 'Hello')).toBe(true)
    expect(store.commands.text.commit(session.sessionId)).toBe(true)
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(store.getSnapshot().file?.nodes['created-text']).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.getSnapshot().file?.nodes['created-text']).toMatchObject({
      text: 'Hello',
      styles: { relativeTransform: [1, 0, 0, 1, 100, 50], width: 120, height: 60 },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
    })
  })

  it('persists insertion and every text sample in order while the semantic redo owns the exact final node', async () => {
    const { store, gestures } = setup()
    const writes: Array<{ expected: number; intent: EditorPersistenceIntent; file: FileDocument }> = []
    store.configure({ persist: async (file, expected, intent) => {
      writes.push({ expected, intent, file: structuredClone(file) })
      return { ...file, revision: expected + 1 }
    } })

    gestures.stagePointerDown(pointer(600, 450))
    gestures.pointerUp(pointer(720, 510))
    const session = store.getSnapshot().textEditing!
    expect(store.commands.text.update(session.sessionId, 'H')).toBe(true)
    expect(store.commands.text.update(session.sessionId, 'Hello')).toBe(true)
    expect(store.commands.text.commit(session.sessionId)).toBe(true)

    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    expect(writes.map(write => write.expected)).toEqual([0, 1, 2])
    expect(writes.map(write => write.intent.commands[0]?.type)).toEqual(['node.insert', 'node.setText', 'node.setText'])
    expect(writes[0]?.intent.commands[0]).toMatchObject({
      type: 'node.insert',
      node: { id: 'created-text', type: 'text', text: '', styles: { relativeTransform: [1, 0, 0, 1, 100, 50], width: 120, height: 60 } },
      placement: { parentId: 'root-1' },
    })
    expect(writes.slice(1).map(write => write.intent.commands[0])).toEqual([
      { type: 'node.setText', nodeId: 'created-text', text: 'H' },
      { type: 'node.setText', nodeId: 'created-text', text: 'Hello' },
    ])
    const redo = store.getHistory().past[0]?.redo
    expect(redo).toMatchObject({ type: 'node.insert', node: { id: 'created-text', text: 'Hello' } })
    expect(writes.at(-1)?.file.nodes['created-text']).toEqual(store.getSnapshot().file?.nodes['created-text'])
    expect(writes.at(-1)?.file.nodes['created-text']).toEqual(redo && redo.type === 'node.insert' ? redo.node : undefined)
  })
})

describe('PAPER-TEXT-005 new-empty cleanup', () => {
  it('removes a newly created whitespace-only node without leaving creation or deletion history', () => {
    const { store, gestures } = setup()
    gestures.stagePointerDown(pointer(700, 500))
    gestures.pointerUp(pointer(700, 500))
    const session = store.getSnapshot().textEditing!

    expect(store.commands.text.update(session.sessionId, ' \n ')).toBe(true)
    expect(store.commands.text.commit(session.sessionId)).toBe(true)

    expect(store.getSnapshot().file?.nodes['created-text']).toBeUndefined()
    expect(store.getSnapshot().selection).toEqual([])
    expect(store.getHistory()).toEqual({ past: [], future: [] })
    expect(store.undo()).toBe(false)
  })

  it('cancels a newly created nonempty node back out of the document and history', () => {
    const { store, gestures } = setup()
    gestures.stagePointerDown(pointer(700, 500))
    gestures.pointerUp(pointer(700, 500))
    const session = store.getSnapshot().textEditing!
    store.commands.text.update(session.sessionId, 'Discard me')

    expect(store.commands.text.cancel(session.sessionId)).toBe(true)
    expect(store.getSnapshot().file?.nodes['created-text']).toBeUndefined()
    expect(store.getHistory()).toEqual({ past: [], future: [] })
  })

  it('keeps an existing node when its committed text is empty', () => {
    const { store } = setup()
    const sessionId = store.commands.text.begin('existing')!

    expect(store.commands.text.update(sessionId, '')).toBe(true)
    expect(store.commands.text.commit(sessionId)).toBe(true)
    expect(store.getSnapshot().file?.nodes.existing).toMatchObject({ id: 'existing', type: 'text', text: '' })
    expect(store.getHistory().past).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(store.getSnapshot().file?.nodes.existing).toMatchObject({ text: 'Keep me' })
  })
})
