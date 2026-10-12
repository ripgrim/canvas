import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createCanvasGestures } from './canvas-gestures'
import type { CanvasInteractionController } from './canvas-gestures'
import { createDocumentStore } from './document-store'
import type { sceneGeometry } from './scene-geometry'

const solid = (id: string, hex: string) => ({ id, type: 'solid' as const, color: { kind: 'literal' as const, color: { kind: 'hex' as const, hex } } })
const fixture = (): FileDocument => ({
  schemaVersion: 7,
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

const setup = (interactions?: CanvasInteractionController) => {
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
  const gestures = createCanvasGestures(store, geometry, interactions)
  gestures.attach({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement)
  return { store, gestures }
}

describe('CLOUD-SYNC-GESTURE-001 live collaboration gestures', () => {
  it('streams each pointer sample and releases one semantic commit at pointer up', () => {
    const transforms: unknown[] = []
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn((_interactionId, next) => { transforms.push(next); return true }),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerMove(pointer(562, 450))
    expect(interactions.beginInteraction).toHaveBeenCalledWith('move', ['frame', 'child'])
    expect(transforms).toEqual([
      [{ nodeId: 'frame', dx: 10, dy: 0 }],
      [{ nodeId: 'frame', dx: 12, dy: 0 }],
    ])
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    gestures.pointerUp(pointer(562, 450))
    expect(primitivePosition(store, 'frame')).toEqual({ left: 12, top: 0 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('keeps the interaction lock until the semantic save is acknowledged', async () => {
    let acknowledge: ((file: FileDocument) => void) | undefined
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    store.configure({ persist: next => new Promise(resolve => { acknowledge = () => resolve({ ...next, revision: next.revision + 1 }) }) })

    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))

    expect(store.getSnapshot().transient).toBeNull()
    expect(interactions.endInteraction).not.toHaveBeenCalled()
    expect(acknowledge).toBeTypeOf('function')

    acknowledge!(fixture())
    await store.waitForPersistence()
    await Promise.resolve()

    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('releases the exact interaction lease once when semantic persistence fails', async () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-failed-save'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    store.configure({ persist: async () => { throw new Error('save failed') } })

    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))
    expect(interactions.endInteraction).not.toHaveBeenCalled()

    await store.waitForPersistence()
    await Promise.resolve()

    expect(interactions.endInteraction).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledWith('interaction-failed-save')
  })

  it('keeps a gesture lease when an older queued save fails, then releases it after its own save succeeds', async () => {
    let rejectOlder: (error: Error) => void = () => undefined
    let writes = 0
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-after-older-save'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    store.configure({
      persist: next => {
        writes += 1
        if (writes === 1) return new Promise((_resolve, reject) => { rejectOlder = reject })
        return Promise.resolve({ ...next, revision: next.revision + 1 })
      },
    })
    expect(store.commands.setStyles('child', { left: 21 })).toBe(true)

    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))
    rejectOlder(new Error('older save failed'))

    await store.waitForPersistence()
    await Promise.resolve()
    expect(interactions.endInteraction).not.toHaveBeenCalled()

    store.retryPersistence()
    await vi.waitFor(() => expect(store.getSnapshot().dirty).toBe(false))
    await Promise.resolve()

    expect(interactions.endInteraction).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledWith('interaction-after-older-save')
  })

  it('AT-CAN-005 commits a drag after its first threshold-crossing sample', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    gestures.pointerUp(pointer(560, 450))

    expect(primitivePosition(store, 'frame')).toEqual({ left: 10, top: 0 })
    expect(interactions.updateInteraction).toHaveBeenCalledOnce()
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('AT-CAN-006 resizes the visible side of a 180-degree node without moving its opposite corner', () => {
    const { store, gestures } = setup()
    expect(store.commands.setStyles('frame', { rotation: 180 })).toBe(true)

    gestures.handlePointerDown(pointer(550, 450), 'frame', 'top-left')
    gestures.pointerMove(pointer(560, 470))

    expect(store.getSnapshot().transient).toMatchObject({
      kind: 'resize',
      rects: { frame: { x: 0, y: 0, width: 250, height: 200 } },
    })
  })

  it('AT-CAN-005 releases the transient preview and interaction when a semantic commit throws', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => true),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    vi.spyOn(store.commands, 'commitMove').mockImplementation(() => { throw new Error('commit failed') })
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))

    expect(() => gestures.pointerUp(pointer(560, 450))).toThrow('commit failed')
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('does not start or commit a drag when another collaborator owns the node', () => {
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => null),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => false),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.stagePointerDown(pointer(550, 450))
    gestures.pointerMove(pointer(560, 450))
    expect(gestures.active).toBe(false)
    expect(store.getSnapshot().transient).toBeNull()
    expect(primitivePosition(store, 'frame')).toEqual({ left: 0, top: 0 })
    expect(interactions.updateInteraction).not.toHaveBeenCalled()
  })

  it('keeps the exact resize preview until room ownership is confirmed after pointer up', async () => {
    let grant: ((allowed: boolean) => void) | undefined
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-1'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => false),
      waitForCommitInteraction: vi.fn(() => new Promise<boolean>(resolve => { grant = resolve })),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    gestures.pointerMove(pointer(594, 490))
    expect(store.getSnapshot().transient).toMatchObject({ kind: 'resize', rects: { frame: { x: 0, y: 0, width: 94, height: 180 } } })

    gestures.pointerUp(pointer(594, 490))
    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 240, height: 180 })
    expect(store.getSnapshot().transient).toMatchObject({ kind: 'resize', rects: { frame: { width: 94 } } })
    expect(interactions.endInteraction).not.toHaveBeenCalled()

    grant!(true)
    await vi.waitFor(() => expect(store.getSnapshot().transient).toBeNull())

    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 94, height: 180 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })

  it('discards a held preview when the room denies ownership', async () => {
    let deny: ((allowed: boolean) => void) | undefined
    const interactions: CanvasInteractionController = {
      beginInteraction: vi.fn(() => 'interaction-denied'),
      updateInteraction: vi.fn(() => true),
      canCommitInteraction: vi.fn(() => false),
      waitForCommitInteraction: vi.fn(() => new Promise<boolean>(resolve => { deny = resolve })),
      endInteraction: vi.fn(),
    }
    const { store, gestures } = setup(interactions)
    gestures.handlePointerDown(pointer(740, 490), 'frame', 'right')
    gestures.pointerMove(pointer(594, 490))
    gestures.pointerUp(pointer(594, 490))

    deny!(false)
    await vi.waitFor(() => expect(store.getSnapshot().transient).toBeNull())

    expect(primitiveRect(store, 'frame')).toEqual({ left: 0, top: 0, width: 240, height: 180 })
    expect(interactions.endInteraction).toHaveBeenCalledOnce()
  })
})

const primitivePosition = (store: ReturnType<typeof createDocumentStore>, id: 'frame' | 'child') => {
  const node = store.getSnapshot().file!.nodes[id]
  if (!node || node.type === 'root' || node.type === 'component') throw new Error(`${id} is not a primitive`)
  return { left: node.styles.left, top: node.styles.top }
}

const primitiveRect = (store: ReturnType<typeof createDocumentStore>, id: 'frame' | 'child') => {
  const node = store.getSnapshot().file!.nodes[id]
  if (!node || node.type === 'root' || node.type === 'component') throw new Error(`${id} is not a primitive`)
  return { left: node.styles.left, top: node.styles.top, width: node.styles.width, height: node.styles.height }
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

describe('UI-COLLAB-READONLY-001 read-only canvas gestures', () => {
  it('keeps selection and panning available without producing an edit', () => {
    const { store, gestures } = setup()
    store.setReadOnly(true)
    const before = structuredClone(store.getSnapshot().file)

    const child = pointer(550, 450)
    expect(gestures.stagePointerDown(child)).toBe(true)
    expect(store.getSnapshot().selection).toEqual(['child'])
    gestures.pointerMove(pointer(590, 470))
    gestures.pointerUp(pointer(590, 470))
    expect(store.getSnapshot().file).toEqual(before)
    expect(store.getSnapshot().transient).toBeNull()
    expect(store.getSnapshot().dirty).toBe(false)

    const panStart = { ...pointer(300, 300), button: 1 }
    expect(gestures.stagePointerDown(panStart)).toBe(true)
    gestures.pointerMove({ ...pointer(330, 320), button: 1 })
    gestures.pointerUp({ ...pointer(330, 320), button: 1 })
    expect(store.getSnapshot().viewport).toMatchObject({ x: 30, y: 20 })
    expect(store.getSnapshot().file).toEqual(before)
  })
})
