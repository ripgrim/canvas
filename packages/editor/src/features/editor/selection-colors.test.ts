import { describe, expect, it } from 'vitest'
import { hexColor } from '@canvas/repo-engine/color'
import type { Appearance, ColorValue } from '@canvas/repo-engine/appearance'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { replaceSelectionColor, selectionColorGroups } from './selection-colors'

const literal = (hex: string): ColorValue => ({ kind: 'literal', color: hexColor(hex) })
const file = (): FileDocument => ({
  schemaVersion: 7,
  fileId: 'file',
  revision: 0,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    parent: { id: 'parent', type: 'frame', name: 'Parent', styles: { left: 0, top: 0, width: 100, height: 100 }, appearance: { fills: [{ id: 'fill-parent', type: 'solid', color: literal('#ff0000') }] } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 0, top: 0, width: 20, height: 20 }, appearance: { fills: [{ id: 'fill-child', type: 'solid', color: literal('#0000ff') }] } },
    sibling: { id: 'sibling', type: 'rectangle', name: 'Sibling', styles: { left: 30, top: 0, width: 20, height: 20 }, appearance: { fills: [{ id: 'fill-sibling', type: 'solid', color: literal('#00ff00') }] } },
  },
  relationships: {
    parent: { parentId: 'root', orderKey: 'a' },
    child: { parentId: 'parent', orderKey: 'a' },
    sibling: { parentId: 'root', orderKey: 'b' },
  },
  theme: { tokens: {} },
})

describe('selection colors', () => {
  it('aggregates a selected subtree but excludes siblings', () => {
    const groups = selectionColorGroups(file(), ['parent'], () => ({}))
    expect(groups.map(group => group.resolved).sort()).toEqual(['#0000ff', '#ff0000'])
  })

  it('narrows a deep selection to that node', () => {
    const groups = selectionColorGroups(file(), ['child'], () => ({}))
    expect(groups.map(group => group.resolved)).toEqual(['#0000ff'])
  })

  it('changes active colors without mutating an inactive cached paint', () => {
    const appearance: Appearance = { fills: [{ id: 'paint', type: 'solid', color: literal('#ff0000'), cache: { solid: { color: literal('#ff0000') } } }] }
    const next = replaceSelectionColor(appearance, 'literal:#ff0000', literal('#ffffff'))
    expect(next.fills?.[0]?.type === 'solid' ? next.fills[0].color : null).toEqual(literal('#ffffff'))
    expect(next.fills?.[0]?.cache?.solid?.color).toEqual(literal('#ff0000'))
  })
})
