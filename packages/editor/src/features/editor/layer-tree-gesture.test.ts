import { describe, expect, it } from 'vitest'
import { layerTreeScrollStep, layerTreeZone, resolveLayerTreeDrop, surpassedLayerTreeThreshold } from './layer-tree-gesture'

const rows = [
  { id: 'root-a', depth: 0, parentId: 'page', acceptsDrop: true, expanded: true, childIds: ['child-a'] },
  { id: 'child-a', depth: 1, parentId: 'root-a', acceptsDrop: true, expanded: true, childIds: [] },
  { id: 'root-b', depth: 0, parentId: 'page', acceptsDrop: true, expanded: true, childIds: [] },
] as const

describe('layer tree gesture math', () => {
  it('uses the Paper 24/52/24 nesting bands and suppresses nesting at high velocity', () => {
    expect(layerTreeZone(6, 28, true, 0)).toBe('before')
    expect(layerTreeZone(14, 28, true, 0)).toBe('inside')
    expect(layerTreeZone(24, 28, true, 0)).toBe('after')
    expect(layerTreeZone(14, 28, true, 31)).toBe('after')
  })

  it('requires five pixels before a pointer press becomes a drag', () => {
    expect(surpassedLayerTreeThreshold(0, 0, 3, 3)).toBe(false)
    expect(surpassedLayerTreeThreshold(0, 0, 3, 4)).toBe(true)
  })

  it('nests in the middle and resolves sibling insertion at the edges', () => {
    expect(resolveLayerTreeDrop(rows, 'root-b', 14, 28, 0, 0)).toMatchObject({ parentId: 'root-b', mode: 'inside', index: 0 })
    expect(resolveLayerTreeDrop(rows, 'root-b', 2, 28, 0, 0)).toMatchObject({ parentId: 'page', mode: 'before', index: 1 })
    expect(resolveLayerTreeDrop(rows, 'root-b', 27, 28, 0, 0)).toMatchObject({ parentId: 'page', mode: 'after', index: 2 })
  })

  it('escapes a nested row to its parent hierarchy when dragged left', () => {
    expect(resolveLayerTreeDrop(rows, 'child-a', 2, 28, -16, 0)).toMatchObject({ parentId: 'page', mode: 'before', depth: 0 })
  })

  it('scrolls proportionally only inside the edge bands', () => {
    expect(layerTreeScrollStep(110, 100, 300)).toBe(-3)
    expect(layerTreeScrollStep(200, 100, 300)).toBe(0)
    expect(layerTreeScrollStep(295, 100, 300)).toBe(4.5)
  })
})
