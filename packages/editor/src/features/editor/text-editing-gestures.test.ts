import { describe, expect, it } from 'vitest'
import type { FileDocument, TextStyle } from '@canvas/repo-engine/file-document'
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
const file = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'text-gesture-file',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'text-1': { id: 'text-1', type: 'text', name: 'Text', text: 'Heading', textStyle: style, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 40 } },
  },
  relationships: { 'text-1': { parentId: 'root-1', orderKey: 'V' } },
  theme: { tokens: {} },
})
const pointer = (clientX: number, clientY: number) => ({ pointerId: 1, clientX, clientY, button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
const setup = () => {
  const store = createDocumentStore(() => 'generated-text-id')
  store.load(file(), [])
  store.setViewportSize({ width: 1000, height: 800 })
  const geometry = {
    getSnapshot: () => ({
      nodes: { 'text-1': {
        canvasKind: 'text' as const, documentRevision: store.getSnapshot().file!.revision, layoutGeneration: store.getSnapshot().layoutGeneration,
        rect: { x: 0, y: 0, width: 120, height: 40 }, worldAabb: { x: 0, y: 0, width: 120, height: 40 },
        offset: { x: 0, y: 0, width: 120, height: 40, origin: { x: 60, y: 20 } }, offsetParentNodeId: null,
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
  return { store, gestures }
}

describe('PAPER-TEXT-004 edit entry gestures', () => {
  it('starts a text transaction when the selected text is double-clicked', () => {
    const { store, gestures } = setup()
    store.select('text-1')

    gestures.doubleClick(pointer(550, 420))

    expect(store.getSnapshot().textEditing).toMatchObject({ nodeId: 'text-1' })
    expect(store.getSnapshot().renaming).toBe('text-1')
  })

  it('creates point text, keeps Text active, and immediately enters its text transaction', () => {
    const { store, gestures } = setup()
    store.setTool('text')

    gestures.stagePointerDown(pointer(700, 500))
    gestures.pointerUp(pointer(700, 500))

    const insertedId = store.getSnapshot().selection[0]
    expect(insertedId).toBe('generated-text-id')
    expect(store.getSnapshot().file?.nodes[insertedId!]?.type).toBe('text')
    expect(store.getSnapshot().tool).toBe('text')
    expect(store.getSnapshot().textEditing).toMatchObject({ nodeId: insertedId })
  })
})
