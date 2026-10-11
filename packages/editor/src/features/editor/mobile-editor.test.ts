import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Text } from '../../design-system/atoms'
import { EditorWorkArea } from './Editor'
import { mobilePanelVisibility, mobileQuickActionsPosition, toggleMobilePanel } from './mobile-editor'

describe('UI-MOBILE-001 editor sheets', () => {
  it('keeps one mobile panel open at a time and removes Design for read-only viewers', () => {
    expect(toggleMobilePanel(null, 'layers')).toBe('layers')
    expect(toggleMobilePanel('layers', 'design')).toBe('design')
    expect(toggleMobilePanel('design', 'design')).toBeNull()
    expect(mobilePanelVisibility('design', false)).toEqual({ left: false, right: true })
    expect(mobilePanelVisibility('design', true)).toEqual({ left: false, right: false })
  })

  it('keeps the mobile work area canvas-only while sheets are portalled', () => {
    const html = renderToStaticMarkup(h(EditorWorkArea, {
      following: false,
      readOnly: false,
      mobile: true,
      visibility: { left: true, right: false },
      columns: 'minmax(0, 1fr)',
      library: h(Text, null, 'Layers sheet'),
      canvas: h(Text, null, 'Canvas'),
      inspector: h(Text, null, 'Design sheet'),
      leftResizer: h(Text, null, 'Left resize'),
      rightResizer: h(Text, null, 'Right resize'),
    }))
    expect(html).toContain('data-mobile="true"')
    expect(html).toContain('Canvas')
    expect(html).not.toContain('Layers sheet')
    expect(html).not.toContain('Design sheet')
    expect(html).not.toContain('Left resize')
    expect(html).not.toContain('Right resize')
  })
})

describe('UI-MOBILE-002 selected-node quick actions', () => {
  it('keeps the toolbar inside the viewport below the node when possible and above it near the bottom edge', () => {
    const selection = { x: 20, y: 80, width: 120, height: 100 }
    const below = mobileQuickActionsPosition(selection, { width: 390, height: 844 })
    expect(below).toEqual({ x: 20, y: 216 })
    expect(below.y).toBeGreaterThanOrEqual(selection.y + selection.height + 28)
    expect(mobileQuickActionsPosition({ x: 360, y: 790, width: 80, height: 40 }, { width: 390, height: 844 })).toEqual({ x: 202, y: 738 })
  })
})
