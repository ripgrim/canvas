import { describe, expect, it, vi } from 'vitest'
import { componentKitNavigation, componentKitSidebarView } from './component-kit-navigation'

describe('component kit navigation', () => {
  it('retains a file-scoped component detail route across subscribers', () => {
    componentKitNavigation.back()
    const listener = vi.fn()
    const unsubscribe = componentKitNavigation.subscribe(listener)
    componentKitNavigation.open('file-a', 'component-a')
    expect(componentKitNavigation.getSnapshot()).toEqual({ fileId: 'file-a', componentId: 'component-a', sequence: expect.any(Number) })
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    componentKitNavigation.back()
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
})
