import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ContextMenuAction } from '../../design-system/context-menu'
import { toastManager } from '../../design-system/toast-atoms'
import { canvasGestures } from './canvas-gestures'
import { documentStore } from './document-store'
import { flexContextMenuActions, layoutContextMenuGroup } from './NodeContextMenu'
import { sceneGeometry } from './scene-geometry'

const px = (value: number) => ({ kind: 'px' as const, value })
const flexContainer = { display: 'flex' as const, gap: 0, flex: { direction: 'row' as const, wrap: 'nowrap' as const, justify: 'start' as const, align: 'start' as const } }

const fixture = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'context-flex',
  revision: 0,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    free: { id: 'free', type: 'frame', name: 'Free', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 100 } },
    flex: { id: 'flex', type: 'frame', name: 'Flex', styles: { relativeTransform: [1, 0, 0, 1, 120, 0], width: 100, height: 100 }, layout: { item: { position: { mode: 'absolute', left: px(120), top: px(0) } }, container: flexContainer } },
    rect: { id: 'rect', type: 'rectangle', name: 'Rectangle', styles: { relativeTransform: [1, 0, 0, 1, 240, 0], width: 20, height: 20 } },
  },
  relationships: {
    free: { parentId: 'root', orderKey: 'A' },
    flex: { parentId: 'root', orderKey: 'B' },
    rect: { parentId: 'root', orderKey: 'C' },
  },
  theme: { tokens: {} },
})

const menuAction = (id: string, label: string): ContextMenuAction => ({ id, label, onSelect: vi.fn() })

afterEach(() => {
  documentStore.clear()
  sceneGeometry.clear()
  toastManager.close()
  vi.restoreAllMocks()
})

describe('PAPER-FLEX-001/002/008 Flex context menu', () => {
  it('uses Paper labels and exact shortcut copy for each single-selection action', () => {
    documentStore.load(fixture(), [], { replace: true })

    documentStore.select('free')
    expect(flexContextMenuActions().map(({ id, label, shortcut }) => ({ id, label, shortcut }))).toStrictEqual([
      { id: 'flex-add', label: 'Add flex layout', shortcut: 'Shift+A' },
    ])

    documentStore.select('rect')
    expect(flexContextMenuActions().map(({ id, label, shortcut }) => ({ id, label, shortcut }))).toStrictEqual([
      { id: 'flex-wrap', label: 'Wrap in flex', shortcut: 'Shift+A' },
    ])

    documentStore.select('flex')
    expect(flexContextMenuActions().map(({ id, label, shortcut }) => ({ id, label, shortcut }))).toStrictEqual([
      { id: 'flex-remove', label: 'Remove flex', shortcut: 'Shift+Alt+A' },
    ])
  })

  it('shows mixed-selection Wrap then Remove contiguously immediately before Ungroup', () => {
    documentStore.load(fixture(), [], { replace: true })
    documentStore.selectMany(['flex', 'rect'])
    const flex = flexContextMenuActions()
    expect(flex.map(({ id, label, shortcut }) => ({ id, label, shortcut }))).toStrictEqual([
      { id: 'flex-wrap', label: 'Wrap in flex', shortcut: 'Shift+A' },
      { id: 'flex-remove', label: 'Remove flex', shortcut: 'Shift+Alt+A' },
    ])

    const group = layoutContextMenuGroup(menuAction('frame', 'Frame selection'), flex, menuAction('ungroup', 'Ungroup'))
    expect(group.map(item => item.id)).toStrictEqual(['frame', 'flex-wrap', 'flex-remove', 'ungroup'])
    expect(group.at(-1)?.label).toBe('Ungroup')
  })

  it('omits ineligible actions instead of rendering disabled placeholders or claiming an action', () => {
    const file = fixture()
    file.nodes.nested = { id: 'nested', type: 'frame', name: 'Nested', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 20, height: 20 }, layout: { item: { position: { mode: 'flow' } }, container: flexContainer } }
    file.relationships.nested = { parentId: 'flex', orderKey: 'A' }
    documentStore.load(file, [], { replace: true })

    documentStore.selectMany(['flex', 'nested'])
    expect(flexContextMenuActions()).toStrictEqual([])
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().canUndo).toBe(false)

    documentStore.select('free')
    documentStore.setReadOnly(true)
    expect(flexContextMenuActions()).toStrictEqual([])
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().canUndo).toBe(false)

    documentStore.setReadOnly(false)
    const active = vi.spyOn(canvasGestures, 'active', 'get').mockReturnValue(true)
    expect(flexContextMenuActions()).toStrictEqual([])
    active.mockRestore()
  })

  it('re-reads fresh state and executes one shared command with one history entry', () => {
    documentStore.load(fixture(), [], { replace: true })
    documentStore.select('free')
    const generation = documentStore.getSnapshot().layoutGeneration
    sceneGeometry.update({
      free: {
        canvasKind: 'frame', documentRevision: 0, layoutGeneration: generation,
        rect: { x: 0, y: 0, width: 100, height: 100 },
        offset: { x: 0, y: 0, width: 100, height: 100, origin: { x: 50, y: 50 } },
        box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
        offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true,
      },
    }, { documentRevision: 0, layoutGeneration: generation, measurementRevision: 1 })
    const closeMenu = vi.fn()
    const rendered = flexContextMenuActions({ closeMenu })
    const setDisplay = vi.spyOn(documentStore.commands.layout, 'setDisplay')

    expect(rendered).toHaveLength(1)
    rendered[0]?.onSelect?.()

    expect(setDisplay).toHaveBeenCalledOnce()
    expect(closeMenu).toHaveBeenCalledOnce()
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getHistory().past).toHaveLength(1)
    expect(documentStore.getSnapshot().file?.nodes.free).toMatchObject({ layout: { container: { display: 'flex' } } })
    expect(documentStore.undo()).toBe(true)
    expect(documentStore.getSnapshot().file?.nodes.free).not.toHaveProperty('layout')
  })

  it('runs mixed Remove through one executor command without duplicate leaf writes', () => {
    documentStore.load(fixture(), [], { replace: true })
    documentStore.selectMany(['flex', 'rect'])
    const generation = documentStore.getSnapshot().layoutGeneration
    sceneGeometry.update({
      flex: {
        canvasKind: 'frame', documentRevision: 0, layoutGeneration: generation,
        rect: { x: 120, y: 0, width: 100, height: 100 },
        offset: { x: 120, y: 0, width: 100, height: 100, origin: { x: 50, y: 50 } },
        box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
        offsetParentNodeId: null, directChild: true,
      },
    }, { documentRevision: 0, layoutGeneration: generation, measurementRevision: 1 })
    const remove = vi.spyOn(documentStore.commands.layout, 'removeFlexSelection')
    const actions = flexContextMenuActions()

    actions.find(item => item.id === 'flex-remove')?.onSelect?.()

    expect(remove).toHaveBeenCalledOnce()
    expect(remove.mock.calls[0]?.[1]).toStrictEqual(['flex'])
    expect(documentStore.getSnapshot().file?.revision).toBe(1)
    expect(documentStore.getHistory().past).toHaveLength(1)
    expect(documentStore.getSnapshot().selection).toStrictEqual(['flex', 'rect'])
    expect(documentStore.getSnapshot().file?.nodes.flex).toMatchObject({ layout: { container: { display: 'freeform' } } })
  })

  it.each([
    ['free', 'flex', 'flex-add', "Couldn't add flex"],
    ['rect', 'free', 'flex-wrap', "Couldn't wrap in flex"],
    ['flex', 'free', 'flex-remove', "Couldn't remove flex"],
  ] as const)('surfaces a visible, action-specific error when %s becomes stale', (selectedId, driftId, actionId, title) => {
    documentStore.load(fixture(), [], { replace: true })
    documentStore.select(selectedId)
    const closeMenu = vi.fn()
    const rendered = flexContextMenuActions({ closeMenu })
    const report = vi.spyOn(toastManager, 'add')
    documentStore.select(driftId)

    rendered.find(item => item.id === actionId)?.onSelect?.()

    expect(report).toHaveBeenCalledOnce()
    expect(closeMenu).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      title,
      description: 'The document or selection changed before Flex could be applied. Try again.',
      type: 'error',
      priority: 'high',
    }))
    expect(documentStore.getSnapshot().file?.revision).toBe(0)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })
})
