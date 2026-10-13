import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { FlexContainer } from '@canvas/repo-engine/layout'
import { InspectorAnchorGrid, InspectorFlexDirection, InspectorFlexWrap, InspectorScrubField, InspectorSpacingMode, InspectorTransformActions, inspectorFlexOverflowItems, moveFlexMatrixCell } from '../../design-system/inspector-atoms'
import type { InspectorAnchorCell } from '../../design-system/inspector-atoms'
import { numericLayoutTokens, paperFlexBaseline, paperFlexDirection, paperFlexMainSpaceBetween, paperFlexOverflowLabels, runInspectorFlexAction } from './LayoutPanels'
import { SelectionInspector } from './InspectorPanels'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { editorStore } from './store'

const noop = () => undefined
const baseFlex = (patch: Partial<FlexContainer> = {}): FlexContainer => ({ direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start', ...patch })

const fixture = (): FileDocument => ({
  schemaVersion: 9,
  fileId: 'paper-flex-inspector',
  revision: 0,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    free: { id: 'free', type: 'frame', name: 'Free', styles: { left: 0, top: 0, width: 160, height: 120 } },
    free2: { id: 'free2', type: 'frame', name: 'Free 2', styles: { left: 200, top: 0, width: 160, height: 120 } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 12, top: 16, width: 20, height: 24 } },
    flex: {
      id: 'flex', type: 'frame', name: 'Flex', styles: { left: 0, top: 180, width: 240, height: 180 },
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 180 } } }, spacing: { padding: { x: 12, y: 16 } }, container: { display: 'flex', gap: 8, flex: baseFlex() } },
    },
    wrapped: {
      id: 'wrapped', type: 'frame', name: 'Wrapped', styles: { left: 280, top: 180, width: 240, height: 180 },
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 280 }, top: { kind: 'px', value: 180 } } }, spacing: { padding: { left: 1, top: 2, right: 3, bottom: 4 } }, container: { display: 'flex', gap: { x: 10, y: 14 }, flex: baseFlex({ direction: 'column', wrap: 'wrap', justify: 'center', align: 'end', alignContent: 'center' }) } },
    },
  },
  relationships: {
    free: { parentId: 'root', orderKey: 'A' },
    free2: { parentId: 'root', orderKey: 'B' },
    child: { parentId: 'free', orderKey: 'A' },
    flex: { parentId: 'root', orderKey: 'C' },
    wrapped: { parentId: 'root', orderKey: 'D' },
  },
  theme: { tokens: {} },
})

const renderSelection = (...ids: string[]) => {
  documentStore.load(fixture(), [], { replace: true })
  if (ids.length === 1) documentStore.select(ids[0]!)
  else if (ids.length > 1) documentStore.selectMany(ids)
  return renderToStaticMarkup(h(SelectionInspector))
}

const renderFlexState = (patch: Partial<FlexContainer>) => {
  const file = fixture()
  const node = file.nodes.flex
  if (!node || node.type !== 'frame' || node.layout?.container?.display !== 'flex') throw new Error('Expected the Flex fixture')
  const flex = node.layout.container.flex
  if (!flex) throw new Error('Expected the Flex fixture controls')
  node.layout.container.flex = { ...flex, ...patch }
  documentStore.load(file, [], { replace: true })
  documentStore.select('flex')
  return renderToStaticMarkup(h(SelectionInspector))
}

afterEach(() => {
  vi.unstubAllGlobals()
  documentStore.clear()
  sceneGeometry.clear()
  editorStore.set({ busy: null })
})

describe('PAPER-FLEX-001 inspector entry and active block', () => {
  it('renders nothing for an empty selection and only Add flex for an eligible singleton', () => {
    documentStore.load(fixture(), [], { replace: true })
    expect(renderToStaticMarkup(h(SelectionInspector))).toBe('')

    const html = renderSelection('free')
    expect(html).toContain('>Add flex<')
    expect(html).toContain('>Shift+A<')
    expect(html).not.toContain('>Wrap in flex<')
    expect(html).not.toContain('>Remove flex<')
    expect(html).not.toContain('class="inspector-anchor-grid"')
  })

  it('uses Wrap for an eligible multi-selection and orders Wrap before the active Flex block', () => {
    const ordinary = renderSelection('free', 'free2')
    expect(ordinary).toContain('>Wrap in flex<')
    expect(ordinary).not.toContain('>Add flex<')

    const mixed = renderSelection('flex', 'free2')
    expect(mixed.indexOf('>Wrap in flex<')).toBeGreaterThan(-1)
    expect(mixed.indexOf('>Wrap in flex<')).toBeLessThan(mixed.indexOf('class="inspector-flex-block"'))
    expect(mixed).toContain('aria-label="Remove flex"')
  })

  it('renders Paper order, one matrix tab stop, and omits unsupported Flex item controls', () => {
    const html = renderSelection('flex')
    const matrix = html.indexOf('class="inspector-anchor-grid"')
    const direction = html.indexOf('aria-label="Column"')
    const wrap = html.indexOf('aria-label="Wrap"')
    const gap = html.indexOf('id="container-gap-main"')
    const overflow = html.indexOf('aria-label="More flex alignment options"')
    const padding = html.indexOf('id="flex-padding-x"')
    expect([matrix, direction, wrap, gap, overflow, padding].every(index => index >= 0)).toBe(true)
    expect(matrix).toBeLessThan(direction)
    expect(direction).toBeLessThan(wrap)
    expect(wrap).toBeLessThan(gap)
    expect(gap).toBeLessThan(overflow)
    expect(overflow).toBeLessThan(padding)
    const layoutEnd = html.indexOf('</section>', padding)
    const clip = html.indexOf('id="layout-clip"')
    expect(clip).toBeGreaterThan(padding)
    expect(layoutEnd).toBeGreaterThan(clip)
    expect(html.indexOf('aria-label="Column"')).toBeLessThan(html.indexOf('aria-label="Row"'))
    expect(html).toContain('aria-label="Remove flex"')
    expect(html).not.toContain('Reverse direction')
    expect(html).not.toContain('Wrap reverse')
    expect(html).not.toContain('item-grow')
    expect(html).not.toContain('item-shrink')
    expect(html).not.toContain('item-basis')

    const matrixStart = html.lastIndexOf('<button', matrix)
    const matrixEnd = html.indexOf('</button>', matrix)
    const matrixHtml = html.slice(matrixStart, matrixEnd + 9)
    expect(matrixHtml.match(/<button/g)).toHaveLength(1)
    expect(matrixHtml.match(/data-flex-cell=/g)).toHaveLength(9)
    expect(matrixHtml).not.toContain('tabindex=')
  })

  it('places Add/Flex and Clip content inside Layout in Paper order', () => {
    const html = renderSelection('flex')
    const layoutStart = html.indexOf('data-section="layout"')
    const layoutEnd = html.indexOf('</section>', layoutStart)
    const flexStart = html.indexOf('class="inspector-flex-block"')
    const clip = html.indexOf('id="layout-clip"')

    expect(layoutStart).toBeGreaterThan(-1)
    expect(flexStart).toBeGreaterThan(layoutStart)
    expect(clip).toBeGreaterThan(flexStart)
    expect(layoutEnd).toBeGreaterThan(clip)

    const free = renderSelection('free')
    const freeLayoutStart = free.indexOf('data-section="layout"')
    const add = free.indexOf('>Add flex<')
    const freeLayoutEnd = free.indexOf('</section>', freeLayoutStart)
    expect(add).toBeGreaterThan(freeLayoutStart)
    expect(freeLayoutEnd).toBeGreaterThan(add)
  })

  it('uses Paper flex glyph geometry instead of generic editor icons', () => {
    const html = renderSelection('flex')
    expect(html).toContain('class="inspector-flex-glyph" width="10" height="2" viewBox="0 0 10 2"')
    expect(html).toContain('class="inspector-flex-glyph" data-column="true" width="9" height="9" viewBox="0 0 9 9"')
    expect(html).toContain('class="inspector-flex-glyph" width="13" height="11" viewBox="0 0 13 11"')
    expect(html).toContain('class="inspector-flex-glyph" width="13" height="12" viewBox="0 0 13 12"')
    expect(html).toContain('class="inspector-flex-glyph" width="12" height="12" viewBox="0 0 12 12" fill="currentColor"')
    expect(html).toContain('aria-label="Individual padding"')
    expect(html).not.toContain('data-icon="trash"')
    expect(html).not.toContain('data-icon="list"')
  })

  it('keeps every individual padding field the same width', () => {
    const css = readFileSync(new URL('../../design-system/inspector.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.inspector-flex-padding \.inspector-row > \.inspector-row-spacer\s*\{[^}]*flex:\s*0 0 16px;/)
  })

  it('shows cross gap only while wrapping and switches between axis and individual padding', () => {
    const packed = renderSelection('flex')
    expect(packed).toContain('id="container-gap-main"')
    expect(packed).not.toContain('id="container-gap-cross"')
    expect(packed).toContain('id="flex-padding-x"')
    expect(packed).toContain('id="flex-padding-y"')
    expect(packed).not.toContain('id="flex-padding-left"')

    const wrapped = renderSelection('wrapped')
    expect(wrapped).toContain('id="container-gap-cross"')
    expect(wrapped).not.toContain('id="flex-padding-x"')
    expect(wrapped).toContain('id="flex-padding-left"')
    expect(wrapped).toContain('id="flex-padding-top"')
    expect(wrapped).toContain('id="flex-padding-right"')
    expect(wrapped).toContain('id="flex-padding-bottom"')
  })

  it('omits all Flex actions in read-only mode', () => {
    documentStore.load(fixture(), [], { replace: true })
    documentStore.select('free')
    documentStore.setReadOnly(true)
    const revision = documentStore.getSnapshot().file!.revision
    const html = renderToStaticMarkup(h(SelectionInspector))
    expect(html).not.toContain('>Add flex<')
    expect(html).not.toContain('>Wrap in flex<')
    expect(html).not.toContain('aria-label="Remove flex"')
    expect(documentStore.getSnapshot().file!.revision).toBe(revision)
  })

  it('keeps an active Flex block inert when the inspector is rendered defensively in read-only mode', () => {
    documentStore.load(fixture(), [], { replace: true })
    documentStore.select('flex')
    documentStore.setReadOnly(true)
    const html = renderToStaticMarkup(h(SelectionInspector))

    expect(html).not.toContain('aria-label="Remove flex"')
    expect(html).toContain('class="inspector-anchor-grid"')
    expect(html).toContain('class="inspector-anchor-grid" data-mode="normal" data-direction="row" aria-label="Alignment: Align top left" disabled=""')
    expect(html).toContain('aria-label="Column" title="Column" aria-pressed="false" disabled=""')
    expect(html).toContain('aria-label="Wrap" title="Wrap" aria-pressed="false" disabled=""')
  })
})

describe('PAPER-FLEX-004 matrix and overflow behavior', () => {
  it('uses the verified composite geometry rather than nine independent controls', () => {
    const css = readFileSync(new URL('../../design-system/inspector.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.inspector-flex-panel\s*\{[^}]*grid-template-columns:\s*1fr 1fr 16px;[^}]*column-gap:\s*8px;/)
    expect(css).toMatch(/\.inspector-anchor-grid\s*\{[^}]*grid-template-rows:\s*29px 30px 29px;[^}]*height:\s*88px;/)
    expect(css).not.toMatch(/\.inspector-flex-panel\s*\{[^}]*grid-template-columns:\s*repeat\(3/)
  })

  it('moves only to literal in-bounds matrix neighbors and constrains special modes', () => {
    expect(moveFlexMatrixCell('1-1', 'ArrowRight', 'normal')).toBe('1-2')
    expect(moveFlexMatrixCell('1-1', 'ArrowDown', 'normal')).toBe('2-1')
    expect(moveFlexMatrixCell('0-0', 'ArrowLeft', 'normal')).toBeNull()
    expect(moveFlexMatrixCell('1-1', 'Enter', 'normal')).toBeNull()
    expect(moveFlexMatrixCell('1-1', 'ArrowRight', 'space-horizontal')).toBeNull()
    expect(moveFlexMatrixCell('1-1', 'ArrowDown', 'space-horizontal')).toBe('2-1')
    expect(moveFlexMatrixCell('1-1', 'ArrowDown', 'space-vertical')).toBeNull()
    expect(moveFlexMatrixCell('0-1', 'ArrowLeft', 'baseline')).toBe('0-0')
  })

  it('keeps a neutral active cell when both axes or baseline and main-axis distribution use special modes', () => {
    const bothSpaces = renderFlexState({ wrap: 'wrap', justify: 'space-between', alignContent: 'space-between' })
    expect(bothSpaces).toContain('data-mode="space-horizontal"')
    expect(bothSpaces).toContain('data-flex-cell="1-1" data-active="true"')

    const baselineAndSpace = renderFlexState({ justify: 'space-between', align: 'last baseline' })
    expect(baselineAndSpace).toContain('data-mode="baseline"')
    expect(baselineAndSpace).toContain('data-flex-cell="0-1" data-active="true"')
    expect(baselineAndSpace).not.toContain('data-flex-cell="1-1" data-active="true"')
  })

  it('does not invent a center anchor for genuinely mixed multi-selection alignment', () => {
    const html = renderSelection('flex', 'wrapped')
    const matrixStart = html.indexOf('class="inspector-anchor-grid"')
    const matrixEnd = html.indexOf('</button>', matrixStart)
    const matrix = html.slice(matrixStart, matrixEnd)
    expect(matrixStart).toBeGreaterThan(-1)
    expect(matrix).not.toContain('data-active="true"')
    expect(matrix).not.toContain('Alignment: Align center')
  })

  it('routes a real composite key event from the active cell and ignores a hidden baseline row', () => {
    const cells: InspectorAnchorCell[] = [0, 1, 2].flatMap(y => [0, 1, 2].map(x => ({ key: `${y}-${x}`, label: `${y}-${x}`, x, y, pressed: y === 0 && x === 1 })))
    const onSelect = vi.fn()
    const preventDefault = vi.fn()
    const grid = InspectorAnchorGrid({ label: 'Alignment', cells, mode: 'baseline', direction: 'row', onSelect, onSpaceBetween: vi.fn() })
    grid.props.onKeyDown({ key: 'ArrowLeft', preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('0-0')
    expect(onSelect).not.toHaveBeenCalledWith('1-0')
  })

  it('routes pointer and double-click events through the hit cell instead of the button shell', () => {
    class HitTarget {
      closest() { return { dataset: { flexCell: '2-1' } } }
    }
    vi.stubGlobal('Element', HitTarget)
    const cells: InspectorAnchorCell[] = [0, 1, 2].flatMap(y => [0, 1, 2].map(x => ({ key: `${y}-${x}`, label: `${y}-${x}`, x, y, pressed: y === 1 && x === 1 })))
    const onSelect = vi.fn()
    const onSpaceBetween = vi.fn()
    const preventDefault = vi.fn()
    const grid = InspectorAnchorGrid({ label: 'Alignment', cells, mode: 'normal', direction: 'row', onSelect, onSpaceBetween })
    const target = new HitTarget()

    grid.props.onPointerDown({ target, preventDefault })
    grid.props.onDoubleClick({ target })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('2-1')
    expect(onSpaceBetween).toHaveBeenCalledWith('2-1')
  })

  it('double-click semantics change only the main distribution to space-between', () => {
    const input = baseFlex({ direction: 'column', justify: 'end', align: 'center', alignContent: 'end' })
    expect(paperFlexMainSpaceBetween(input)).toEqual({ direction: 'column', wrap: 'nowrap', justify: 'space-between', align: 'center', alignContent: 'end' })
    expect(input.justify).toBe('end')
  })

  it('offers both axes only while wrapping and preserves distinct baseline choices', () => {
    expect(inspectorFlexOverflowItems('Horizontally', 'Vertically', false)).toEqual([
      { action: 'main-space-between', label: 'Horizontally', group: 'space' },
      { action: 'first-baseline', label: 'First baseline', group: 'baseline' },
      { action: 'last-baseline', label: 'Last baseline', group: 'baseline' },
    ])
    expect(inspectorFlexOverflowItems('Vertically', 'Horizontally', true)).toEqual([
      { action: 'main-space-between', label: 'Vertically', group: 'space' },
      { action: 'cross-space-between', label: 'Horizontally', group: 'space' },
      { action: 'first-baseline', label: 'First baseline', group: 'baseline' },
      { action: 'last-baseline', label: 'Last baseline', group: 'baseline' },
    ])
    expect(paperFlexOverflowLabels('row')).toEqual({ main: 'Horizontally', cross: 'Vertically' })
    expect(paperFlexOverflowLabels('column')).toEqual({ main: 'Vertically', cross: 'Horizontally' })
    expect(paperFlexOverflowLabels(null)).toEqual({ main: 'On the main axis', cross: 'On the cross axis' })
  })
})

describe('PAPER-FLEX-005 semantic writes', () => {
  it('clears wrapping on a direction change and never carries reverse into the new direction', () => {
    const input = baseFlex({ direction: 'column-reverse', wrap: 'wrap', justify: 'end', align: 'center', alignContent: 'space-between' })
    const result = paperFlexDirection(input, 'row')
    expect(result.direction).toBe('row')
    expect(result.wrap).toBe('nowrap')
    expect(result.direction).not.toContain('reverse')
    expect(input.wrap).toBe('wrap')
  })

  it('forces row for first and last baseline and keeps the two values distinct', () => {
    const column = baseFlex({ direction: 'column', justify: 'end', align: 'center' })
    expect(paperFlexBaseline(column, 'baseline')).toMatchObject({ direction: 'row', align: 'baseline' })
    expect(paperFlexBaseline(column, 'last baseline')).toMatchObject({ direction: 'row', align: 'last baseline' })
    expect(paperFlexBaseline(baseFlex({ align: 'baseline' }), 'baseline').align).toBe('start')
  })

  it('surfaces a shared executor failure and leaves the file untouched', () => {
    documentStore.load(fixture(), [], { replace: true })
    documentStore.select('free')
    const report = vi.fn()
    const before = structuredClone(documentStore.getSnapshot().file)
    expect(runInspectorFlexAction('add-flex-to-node', report)).toEqual({
      status: 'unavailable',
      action: 'add-flex-to-node',
      message: 'Add flex needs current canvas measurements. Wait for the canvas to finish updating, then try again.',
    })
    expect(report).toHaveBeenCalledWith("Couldn't add flex", 'Add flex needs current canvas measurements. Wait for the canvas to finish updating, then try again.')
    expect(documentStore.getSnapshot().file).toEqual(before)
    expect(documentStore.getSnapshot().canUndo).toBe(false)
  })
})

describe('AT-DOC-002/003 existing inspector controls remain intact', () => {
  it('keeps direction and wrap as separate accessible controls', () => {
    const direction = renderToStaticMarkup(h(InspectorFlexDirection, { label: 'Direction', rowLabel: 'Row', columnLabel: 'Column', axis: 'row', onAxis: noop }))
    const wrap = renderToStaticMarkup(h(InspectorFlexWrap, { label: 'Wrap', wrapped: true, onChange: noop }))
    expect(direction.indexOf('aria-label="Column"')).toBeLessThan(direction.indexOf('aria-label="Row"'))
    expect(direction).not.toContain('Reverse direction')
    expect(wrap).toContain('aria-label="Wrap" title="Wrap" aria-pressed="true"')
  })

  it('preserves numeric tokens, spacing modes, and transform controls outside Flex', () => {
    const tokens = numericLayoutTokens([{ name: 'space-2', value: '8px' }, { name: 'duration', value: '120ms' }, { name: 'negative', value: '-4px' }])
    expect(tokens).toEqual([{ name: 'space-2', value: 8, displayValue: '8px' }])
    const tokenField = renderToStaticMarkup(h(InspectorScrubField, { id: 'gap', label: 'Gap', value: 8, tokens, tokenLabel: 'Choose token', onCommit: noop }))
    expect(tokenField).toContain('space-2 · 8px')

    const spacing = renderToStaticMarkup(h(InspectorSpacingMode, { label: 'Padding mode', value: 'axes', labels: { all: 'All', axes: 'Axes', sides: 'Sides' }, onChange: noop }))
    expect(spacing.match(/class="inspector-spacing-mode-button"/g)).toHaveLength(3)

    const transform = renderToStaticMarkup(h(InspectorTransformActions, { actionsLabel: 'Transform actions', rotateLabel: 'Rotate', flipXLabel: 'Flip X', flipYLabel: 'Flip Y', absoluteLabel: 'Absolute', absolutePressed: true, onRotate: noop, onFlipX: noop, onFlipY: noop, onAbsolute: noop }))
    expect(transform.match(/class="inspector-transform-action"/g)).toHaveLength(4)
  })
})
