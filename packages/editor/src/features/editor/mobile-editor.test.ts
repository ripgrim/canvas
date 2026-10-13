import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Text } from '../../design-system/atoms'
import { MobileSelectionActions } from '../../design-system/canvas-atoms'
import { EditorWorkArea } from './Editor'
import { createStableMobileQuickActionsStore, mobilePanelVisibility, mobileQuickActionsPhase, mobileQuickActionsPosition, shouldMountMobileQuickActions, stableMobileQuickActionsSnapshot, toggleMobilePanel } from './mobile-editor'
import type { MobileQuickActionsPhase } from './mobile-editor'
import type { HudProjectionFrame } from './canvas-hud-projection'

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

  it('uses the canonical dimension pose as an exclusion instead of estimating from the node bounds', () => {
    const selection = { x: 20, y: 80, width: 120, height: 100 }
    const position = mobileQuickActionsPosition(selection, { width: 390, height: 844 }, { anchor: { x: 80, y: 230 } })
    expect(position).toEqual({ x: 20, y: 258 })
    expect(position.y).toBeGreaterThan(230 + 20)
  })
})

describe('UI-MOBILE-004-FLOW quick-action drag fade', () => {
  it('does not mount the quick-action subscription on desktop', () => {
    const mobile = { key: { mobile: true } } as HudProjectionFrame
    const desktop = { key: { mobile: false } } as HudProjectionFrame

    expect(shouldMountMobileQuickActions(mobile, true)).toBe(true)
    expect(shouldMountMobileQuickActions(desktop, true)).toBe(false)
    expect(shouldMountMobileQuickActions(null, true)).toBe(false)
    expect(shouldMountMobileQuickActions(mobile, false)).toBe(false)
  })

  it('derives the hidden gesture phases from document interaction state', () => {
    expect(mobileQuickActionsPhase(null)).toBe('idle')
    expect(mobileQuickActionsPhase({ kind: 'pan' })).toBe('idle')
    expect(mobileQuickActionsPhase({ kind: 'move', rects: {}, offset: { x: 0, y: 0 }, guides: [], targetFrameId: null, insertion: null })).toBe('moving')
    expect(mobileQuickActionsPhase({ kind: 'resize', interactionId: 'resize-1' })).toBe('resizing')
    expect(mobileQuickActionsPhase(null, { flowDrag: { documentNodeId: 'selected' } } as HudProjectionFrame)).toBe('moving')
  })

  it('does not republish the toolbar for every flow sample while its hidden phase is unchanged', () => {
    const idle = Object.freeze({ phase: 'idle' as const, projection: { generation: 4, frame: {} } })
    const first = stableMobileQuickActionsSnapshot(idle, 'moving', { generation: 5, frame: {} }, value => value.frame !== null)
    const next = stableMobileQuickActionsSnapshot(first, 'moving', { generation: 6, frame: {} }, value => value.frame !== null)
    const visible = stableMobileQuickActionsSnapshot(next, 'idle', { generation: 7, frame: {} }, value => value.frame !== null)

    expect(first).not.toBe(idle)
    expect(first.projection).toBe(idle.projection)
    expect(next).toBe(first)
    expect(visible).not.toBe(next)
    expect(visible.projection.generation).toBe(7)
  })

  it('does not notify React subscribers for per-sample flow publications', () => {
    let sourceListener: () => void = () => undefined
    let next: { phase: MobileQuickActionsPhase; projection: { generation: number; frame: HudProjectionFrame } } = { phase: 'idle', projection: { generation: 4, frame: {} as HudProjectionFrame } }
    const store = createStableMobileQuickActionsStore(
      () => next,
      listener => { sourceListener = listener; return () => { sourceListener = () => undefined } },
      value => value.frame !== null,
    )
    const render = vi.fn()
    const stop = store.subscribe(render)

    next = { phase: 'moving', projection: { generation: 5, frame: {} as HudProjectionFrame } }
    sourceListener()
    expect(render).toHaveBeenCalledTimes(1)
    const retained = store.getSnapshot()
    next = { phase: 'moving', projection: { generation: 6, frame: {} as HudProjectionFrame } }
    sourceListener()
    expect(render).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe(retained)
    next = { phase: 'idle', projection: { generation: 7, frame: {} as HudProjectionFrame } }
    sourceListener()
    expect(render).toHaveBeenCalledTimes(2)
    stop()
  })

  it('hides and disables the toolbar during a gesture while retaining its stable position', () => {
    const html = renderToStaticMarkup(h(MobileSelectionActions, { label: 'Quick actions', phase: 'moving', visible: false, position: { x: 24, y: 80 }, children: h(Text, null, 'Actions') }))
    expect(html).toContain('data-phase="moving"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('inert=""')
    expect(html).toContain('--mobile-quick-actions-x:24px')
    const css = readFileSync(new URL('../../design-system/canvas.css', import.meta.url), 'utf8')
    const theme = readFileSync(new URL('../../design-system/theme.css', import.meta.url), 'utf8')
    expect(css).toMatch(/transform: translate3d\(var\(--mobile-quick-actions-x\), var\(--mobile-quick-actions-y\), 0\)/)
    expect(css).toMatch(/\.mobile-selection-actions:not\(\[data-visible\]\) \{ opacity: 0; pointer-events: none; \}/)
    expect(theme).toMatch(/--motion-duration:\s*150ms;/)
    expect(css).toMatch(/@media \(max-width: 760px\) and \(prefers-reduced-motion: reduce\) \{\s*\.mobile-selection-actions \{ transition: none; \}\s*\}/)
  })

  it('keeps touch targets screen-sized and removes percent-position edge reconstruction', () => {
    const css = readFileSync(new URL('../../design-system/canvas.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.resize-handles \{ inset: 0; z-index: 1; pointer-events: none; \}/)
    expect(css).toMatch(/\.resize-handle \{[^}]*width: 20px; height: 20px;/)
    expect(css).toMatch(/\.resize-handle\[data-edge\] \{ width: 20px; height: 16px;/)
    expect(css).toMatch(/\.rotation-handles \{ inset: 0; z-index: 2;/)
    expect(css).toMatch(/\.rotation-handle \{[^}]*width: 24px; height: 24px;[^}]*cursor: url\(/)
    expect(css).toContain("M8.46 20.88A1.1 1.1")
    expect(css).toContain("transform='rotate(90 16 16)'")
    expect(css).toContain('.resize-handle { width: 28px; height: 28px; }')
    expect(css).toContain('.resize-handle[data-edge] { width: 24px; height: 24px; }')
    expect(css).not.toContain('width: calc(100% - 28px)')
    expect(css).not.toContain('height: calc(100% - 28px)')
  })
})
