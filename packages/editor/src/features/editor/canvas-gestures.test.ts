import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createCanvasGestures } from './canvas-gestures'
import { createDocumentStore } from './document-store'
import type { sceneGeometry } from './scene-geometry'

const solid = (id: string, hex: string) => ({ id, type: 'solid' as const, color: { kind: 'literal' as const, color: { kind: 'hex' as const, hex } } })
const fixture = (): FileDocument => ({
  schemaVersion: 6,
  fileId: 'gesture-file',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 240, height: 180, overflow: 'clip' }, appearance: { fills: [solid('frame-fill', '#685fff')] } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 20, top: 20, width: 160, height: 100 }, appearance: { fills: [solid('child-fill', '#ffffff')] } },
  },
  relationships: {
    frame: { parentId: 'root-1', orderKey: 'V' },
    child: { parentId: 'frame', orderKey: 'V' },
  },
  theme: { tokens: {} },
})

const pointer = (clientX: number, clientY: number, pointerId = 1) => ({ pointerId, clientX, clientY, button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })

const setup = () => {
  const store = createDocumentStore(() => 'unused')
  store.load(fixture(), [])
  store.setViewportSize({ width: 1000, height: 800 })
  store.select('frame')
  const geometry = {
    getSnapshot: () => ({ nodes: {}, revision: 0, layoutGeneration: null, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }),
    subscribe: () => () => undefined,
    update: () => undefined,
    clear: () => undefined,
  } as typeof sceneGeometry
  const gestures = createCanvasGestures(store, geometry)
  gestures.attach({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement)
  return { store, gestures }
}

const primitivePosition = (store: ReturnType<typeof createDocumentStore>, id: 'frame' | 'child') => {
  const node = store.getSnapshot().file!.nodes[id]
  if (!node || node.type === 'root' || node.type === 'component') throw new Error(`${id} is not a primitive`)
  return { left: node.styles.left, top: node.styles.top }
}

describe('AT-CAN-005 selected container pointer precedence', () => {
  it('keeps a child click as a click: it selects the child without moving its selected parent', () => {
    const { store, gestures } = setup()
    const insideChild = pointer(550, 450)

    expect(gestures.stagePointerDown(insideChild)).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['frame'])
    gestures.pointerUp(insideChild)

    expect(store.getSnapshot().selection).toEqual(['child'])
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    expect(primitivePosition(store, 'child')).toEqual({ left: 20, top: 20 })
  })

  it('moves the selected frame when a pointer drag begins over its child-covered body', () => {
    const { store, gestures } = setup()
    const start = pointer(550, 450)

    gestures.stagePointerDown(start)
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerMove(pointer(562, 450))

    expect(store.getSnapshot().selection).toEqual(['frame'])
    expect(store.getSnapshot().transient).toMatchObject({ kind: 'move', rects: { frame: { x: 12, y: 0, width: 240, height: 180 } } })
    gestures.pointerUp(pointer(562, 450))

    expect(primitivePosition(store, 'frame')).toEqual({ left: 12, top: 0 })
    expect(primitivePosition(store, 'child')).toEqual({ left: 20, top: 20 })
  })

  it('keeps drag precedence with an already-selected child', () => {
    const { store, gestures } = setup()
    store.select('child')
    const start = pointer(550, 450)

    gestures.stagePointerDown(start)
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerMove(pointer(562, 450))

    expect(store.getSnapshot().transient).toMatchObject({ kind: 'move', rects: { child: { x: 32, y: 20, width: 160, height: 100 } } })
    gestures.pointerUp(pointer(562, 450))
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    expect(primitivePosition(store, 'child')).toEqual({ left: 32, top: 20 })
  })

  it('lets the deep-selection modifier bypass selected-container drag precedence', () => {
    const { store, gestures } = setup()
    const deepStart = { ...pointer(550, 450), ctrlKey: true }

    gestures.stagePointerDown(deepStart)
    expect(store.getSnapshot().selection).toEqual(['child'])
    gestures.pointerMove({ ...pointer(560, 450), ctrlKey: true })
    gestures.pointerMove({ ...pointer(562, 450), ctrlKey: true })

    expect(store.getSnapshot().transient).toMatchObject({ kind: 'move', rects: { child: { x: 32, y: 20, width: 160, height: 100 } } })
    expect(store.getSnapshot().transient).not.toMatchObject({ rects: { frame: expect.anything() } })
  })

  it('leaves the editor gesture plane inactive in Interact mode', () => {
    const { store, gestures } = setup()
    store.setTool('interact')

    expect(gestures.stagePointerDown(pointer(550, 450))).toBe(false)
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().selection).toEqual(['frame'])
  })
})
