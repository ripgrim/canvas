import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InspectorFlexDirection, InspectorScrubField, InspectorSpacingMode, InspectorTransformActions } from '../../design-system/inspector-atoms'
import { numericLayoutTokens } from './LayoutPanels'

const noop = () => undefined

describe('AT-CAN-002 Paper-style layout controls', () => {
  it('renders wrap and reverse as accessible pressed icon toggles', () => {
    const html = renderToStaticMarkup(h(InspectorFlexDirection, { label: 'Direction', rowLabel: 'Row', columnLabel: 'Column', reverseLabel: 'Reverse direction', wrapLabel: 'Wrap', axis: 'row', reversed: false, wrapped: true, onAxis: noop, onReverse: noop, onWrap: noop }))
    expect(html).toContain('aria-label="Wrap"')
    expect(html).toContain('aria-label="Wrap" title="Wrap" aria-pressed="true"')
    expect(html).toContain('aria-label="Reverse direction"')
  })

  it('renders all, axes, and sides split controls with one pressed mode', () => {
    const html = renderToStaticMarkup(h(InspectorSpacingMode, { label: 'Padding mode', value: 'axes', labels: { all: 'All', axes: 'Axes', sides: 'Sides' }, onChange: noop }))
    expect(html.match(/class="inspector-spacing-mode-button"/g)).toHaveLength(3)
    expect(html).toContain('aria-label="Axes" title="Axes" aria-pressed="true"')
  })

  it('only renders a numeric token menu when compatible tokens exist and shows names with values', () => {
    const tokens = numericLayoutTokens([{ name: 'space-2', value: '8px' }, { name: 'duration', value: '120ms' }, { name: 'negative', value: '-4px' }])
    expect(tokens).toEqual([{ name: 'space-2', value: 8, displayValue: '8px' }])
    const without = renderToStaticMarkup(h(InspectorScrubField, { id: 'gap-a', label: 'Gap', value: 8, onCommit: noop }))
    const withTokens = renderToStaticMarkup(h(InspectorScrubField, { id: 'gap-b', label: 'Gap', value: 8, tokens, tokenLabel: 'Choose numeric token for gap', onCommit: noop }))
    expect(without).not.toContain('<select')
    expect(withTokens).toContain('aria-label="Choose numeric token for gap"')
    expect(withTokens).toContain('space-2 · 8px')
  })

  it('places one accessible Absolute toggle at the end of transform actions', () => {
    const html = renderToStaticMarkup(h(InspectorTransformActions, { actionsLabel: 'Transform actions', rotateLabel: 'Rotate', flipXLabel: 'Flip X', flipYLabel: 'Flip Y', absoluteLabel: 'Absolute', absolutePressed: true, onRotate: noop, onFlipX: noop, onFlipY: noop, onAbsolute: noop }))
    expect(html.match(/class="inspector-transform-action"/g)).toHaveLength(4)
    expect(html.lastIndexOf('aria-label="Absolute"')).toBeGreaterThan(html.lastIndexOf('aria-label="Flip Y"'))
    expect(html).toContain('aria-label="Absolute" title="Absolute" aria-pressed="true"')
  })
})
