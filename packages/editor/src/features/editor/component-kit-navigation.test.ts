import { describe, expect, it, vi } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { componentKitNavigation, componentKitSidebarView } from './component-kit-navigation'
import { documentStore } from './document-store'

function componentFile(fileId: string) {
  const file = createBlankFile(fileId, `${fileId}-page`, `${fileId}-root`, 'Page')
  file.nodes.master = { id: 'master', type: 'frame', name: 'Component', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 50 } }
  file.relationships.master = { parentId: `${fileId}-root`, orderKey: 'A' }
  file.componentModel = { definitions: { component: { id: 'component', name: 'Component', source: { kind: 'canvas', masterRootId: 'master' }, properties: [], materials: [], parts: [], interactions: [], revision: 0 } }, instances: {} }
  return file
}

describe('component kit navigation', () => {
  it('retains a file-scoped component detail route across subscribers', () => {
    componentKitNavigation.back()
    const listener = vi.fn()
    const unsubscribe = componentKitNavigation.subscribe(listener)
    componentKitNavigation.open('file-a', 'component-a')
    const opened = componentKitNavigation.getSnapshot()
    expect(opened).toEqual({ fileId: 'file-a', componentId: 'component-a', sequence: expect.any(Number) })
    const service = componentKitNavigation.playground(opened)
    expect(service).not.toBeNull()
    expect(componentKitNavigation.playground(opened)).toBe(service)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    componentKitNavigation.back()
    expect(componentKitNavigation.playground(opened)).toBeNull()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('requests Kit only for a newer location in the open file', () => {
    componentKitNavigation.back()
    componentKitNavigation.open('file-a', 'component-a')
    const location = componentKitNavigation.getSnapshot()
    if (!location) throw new Error('Expected component kit location')
    expect(componentKitSidebarView(location, 'file-a', { view: 'design', kitAt: location.sequence - 1 })).toBe('kit')
    expect(componentKitSidebarView(location, 'file-a', { view: 'design', kitAt: location.sequence })).toBe('design')
    expect(componentKitSidebarView(location, 'file-b', { view: 'design', kitAt: 0 })).toBe('design')
    componentKitNavigation.back()
  })

  it('retires the playground across a real file context change', () => {
    const fileA = componentFile('file-a')
    documentStore.load(fileA, [], { replace: true, pageId: 'file-a-page' })
    componentKitNavigation.open('file-a', 'component')
    const opened = componentKitNavigation.getSnapshot()
    expect(componentKitNavigation.playground(opened)).not.toBeNull()

    documentStore.load(componentFile('file-b'), [], { replace: true, pageId: 'file-b-page' })
    expect(componentKitNavigation.getSnapshot()).toBeNull()
    expect(componentKitNavigation.playground(opened)).toBeNull()

    documentStore.load(fileA, [], { replace: true, pageId: 'file-a-page' })
    expect(componentKitNavigation.getSnapshot()).toBeNull()
    expect(componentKitNavigation.playground(opened)).toBeNull()
  })

  it('retires the playground when its definition is removed', () => {
    const file = componentFile('file-a')
    documentStore.load(file, [], { replace: true, pageId: 'file-a-page' })
    componentKitNavigation.open('file-a', 'component')
    const opened = componentKitNavigation.getSnapshot()

    documentStore.load({ ...file, componentModel: { definitions: {}, instances: {} }, revision: file.revision + 1 }, [], { replace: true, pageId: 'file-a-page' })
    expect(componentKitNavigation.getSnapshot()).toBeNull()
    expect(componentKitNavigation.playground(opened)).toBeNull()

    documentStore.load(file, [], { replace: true, pageId: 'file-a-page' })
    expect(componentKitNavigation.getSnapshot()).toBeNull()
    expect(componentKitNavigation.playground(opened)).toBeNull()
  })
})
