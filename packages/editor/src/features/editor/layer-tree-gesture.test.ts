import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layerTreeScrollStep, layerTreeZone, resolveLayerTreeDrop, resolveLayerTreeKeyboardDrop, surpassedLayerTreeThreshold } from './layer-tree-gesture'

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

  it('resolves keyboard reorder, indent, and outdent through the pointer drop contract', () => {
    expect(resolveLayerTreeKeyboardDrop(rows, ['root-b'], 'up')).toMatchObject({ parentId: 'page', targetId: 'root-a', mode: 'before', index: 0 })
    expect(resolveLayerTreeKeyboardDrop(rows, ['root-a'], 'down')).toMatchObject({ parentId: 'page', targetId: 'root-b', mode: 'after', index: 2 })
    expect(resolveLayerTreeKeyboardDrop(rows, ['root-b'], 'in')).toMatchObject({ parentId: 'root-a', targetId: 'root-a', mode: 'inside', index: 1 })
    expect(resolveLayerTreeKeyboardDrop(rows, ['child-a'], 'out')).toMatchObject({ parentId: 'page', targetId: 'root-a', mode: 'after', index: 1 })
  })

  it('moves a same-parent multi-selection as one ordered keyboard transaction', () => {
    const siblings = [
      { id: 'a', depth: 0, parentId: 'page', acceptsDrop: false, expanded: true, childIds: [] },
      { id: 'b', depth: 0, parentId: 'page', acceptsDrop: false, expanded: true, childIds: [] },
      { id: 'c', depth: 0, parentId: 'page', acceptsDrop: false, expanded: true, childIds: [] },
      { id: 'd', depth: 0, parentId: 'page', acceptsDrop: false, expanded: true, childIds: [] },
    ] as const
    expect(resolveLayerTreeKeyboardDrop(siblings, ['b', 'c'], 'up')).toMatchObject({ targetId: 'a', mode: 'before', index: 0 })
    expect(resolveLayerTreeKeyboardDrop(siblings, ['b', 'c'], 'down')).toMatchObject({ targetId: 'd', mode: 'after', index: 4 })
  })

  it('does not cross parents or move beyond a hierarchy boundary', () => {
    expect(resolveLayerTreeKeyboardDrop(rows, ['root-a', 'child-a'], 'down')).toBeNull()
    expect(resolveLayerTreeKeyboardDrop(rows, ['root-a'], 'up')).toBeNull()
    expect(resolveLayerTreeKeyboardDrop(rows, ['root-a'], 'out')).toBeNull()
  })
})

describe('LAYER-DRAG-SELECTION-001 layer row selection behavior', () => {
  it('prevents selection on draggable rows while restoring it for the rename input', () => {
    const css = readFileSync(new URL('../../design-system/canvas.css', import.meta.url), 'utf8')
    const rowRule = /\.document-layer-item\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const renameRule = /\.sidebar-inline-name\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

    expect(rowRule).toContain('user-select: none')
    expect(renameRule).toContain('user-select: text')
  })
})
