import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Text } from '../../design-system/atoms'
import { MobileSelectionActions } from '../../design-system/canvas-atoms'
import { EditorWorkArea } from './Editor'
import { mobilePanelVisibility, mobileQuickActionsPhase, mobileQuickActionsPosition, toggleMobilePanel } from './mobile-editor'

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

describe('UI-MOBILE-004 quick-action drag fade', () => {
  it('derives the hidden gesture phases from document interaction state', () => {
    expect(mobileQuickActionsPhase(null)).toBe('idle')
    expect(mobileQuickActionsPhase({ kind: 'pan' })).toBe('idle')
    expect(mobileQuickActionsPhase({ kind: 'move', rects: {}, offset: { x: 0, y: 0 }, guides: [], targetFrameId: null, insertion: null })).toBe('moving')
    expect(mobileQuickActionsPhase({ kind: 'resize', rects: {}, starts: {}, appearances: {}, contentLocked: false })).toBe('resizing')
  })

  it('hides and disables the toolbar during a gesture while retaining its stable position', () => {
    const html = renderToStaticMarkup(h(MobileSelectionActions, { label: 'Quick actions', phase: 'moving', visible: false, position: { x: 24, y: 80 }, children: h(Text, null, 'Actions') }))
    expect(html).toContain('data-phase="moving"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('inert=""')
    expect(html).toContain('--mobile-quick-actions-x:24px')
    const css = readFileSync(new URL('../../design-system/canvas.css', import.meta.url), 'utf8')
    expect(css).toMatch(/transform: translate3d\(var\(--mobile-quick-actions-x\), var\(--mobile-quick-actions-y\), 0\)/)
    expect(css).toMatch(/\.mobile-selection-actions:not\(\[data-visible\]\) \{ opacity: 0; pointer-events: none; \}/)
  })
})
