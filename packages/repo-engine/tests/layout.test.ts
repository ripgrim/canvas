import { describe, expect, it } from 'vitest'
import {
  applyDefiniteMainAxis, availableSizingModes, axisSizeToCss, classifySizing, gridLine, isLegacyOnlyLayout, isValidLayout, layoutFromLegacy, legacyLayout,
  normalizeContainer, normalizeItem, normalizeLayout, projectContainerStyle, projectItemStyle, spacingToCss, transitionSizing, transitionSizingMany, validateLayout,
} from '../src/layout.js'
import type { LayoutContainer, LayoutItem, NodeLayout } from '../src/layout.js'

// Loose shape for building invalid records; the validators receive `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

/** A v4 record touching every part of the schema: flex container, gap {x,y}, spacing sides, min/max, aspect ratio, flex item, transform. */
const full = (): NodeLayout => ({
  item: {
    position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'percent', value: 5 }, zIndex: 3 },
    width: { value: { kind: 'px', value: 200 }, min: { kind: 'px', value: 100 }, max: { kind: 'percent', value: 100 } },
    height: { value: { kind: 'intrinsic', value: 'fit-content' } },
    aspectRatio: 1.5,
    flex: { grow: 1, shrink: 0, basis: { kind: 'auto' } },
    transform: { rotate: 45, scale: { x: 2, y: 1 } },
  },
  container: { display: 'flex', gap: { x: 8, y: 4 }, flex: { direction: 'row', wrap: 'wrap', justify: 'space-between', align: 'center' } },
  spacing: { padding: { top: 1, right: 2, bottom: 3, left: 4 }, margin: { x: 'auto', y: 8 } },
})
const mutate = (change: (value: Loose) => void): unknown => { const value = full() as unknown as Loose; change(value); return value }
const thrown = (run: () => unknown): string | null => { try { run() } catch (error) { return (error as Error).message } return null }
const tracks = (count: number) => Array.from({ length: count }, () => ({ kind: 'fr', value: 1 }))
const gridContainer = (columns: unknown[]) => ({ display: 'grid', grid: { columns, rows: [{ kind: 'auto' }], autoFlow: 'row' } })
const flow = (extra: Partial<LayoutItem> = {}): LayoutItem => ({ position: { mode: 'flow' }, ...extra })

describe('layout validation', () => {
  it('LAY-SCHEMA-002: accepts a full v4 record', () => {
    expect(validateLayout(full())).toBe(true)
    expect(isValidLayout(full())).toBe(true)
  })

  it('LAY-SCHEMA-002: rejects non-finite and out-of-range lengths', () => {
    expect(validateLayout(mutate(value => { value.item.width.value = { kind: 'px', value: Number.NaN } }))).toBe(false)
    expect(validateLayout(mutate(value => { value.item.width.value = { kind: 'px', value: Number.POSITIVE_INFINITY } }))).toBe(false)
    expect(validateLayout(mutate(value => { value.item.width.value = { kind: 'px', value: -1 } }))).toBe(false)
    expect(validateLayout(mutate(value => { value.item.width.value = { kind: 'percent', value: 101 } }))).toBe(false)
    // Negative control: the 100% boundary is accepted.
    expect(validateLayout(mutate(value => { value.item.width.value = { kind: 'percent', value: 100 } }))).toBe(true)
  })

  it('LAY-SCHEMA-002: expression lengths need the expressions option', () => {
    const layout = mutate(value => { value.item.width.value = { kind: 'expression', raw: '100% - 8px' } })
    expect(validateLayout(layout)).toBe(false)
    expect(validateLayout(layout, { expressions: true })).toBe(true)
  })

  it('LAY-SCHEMA-002: unknown keys throw at every record level and make isValidLayout false', () => {
    const cases: [string, (value: Loose) => void][] = [
      ['Unsupported node layout field', value => { value.extra = 1 }],
      ['Unsupported layout item field', value => { value.item.extra = 1 }],
      ['Unsupported node position field', value => { value.item.position.extra = 1 }],
      ['Unsupported axis size field', value => { value.item.width.extra = 1 }],
      ['Unsupported flex item field', value => { value.item.flex.extra = 1 }],
      ['Unsupported node transform field', value => { value.item.transform.extra = 1 }],
      ['Unsupported layout container field', value => { value.container.extra = 1 }],
      ['Unsupported flex container field', value => { value.container.flex.extra = 1 }],
      ['Unsupported spacing field', value => { value.spacing.extra = 1 }],
      ['Unsupported grid item field', value => { value.item.grid = { columnStart: 1, extra: 1 } }],
      ['Unsupported grid container field', value => { value.container = { ...gridContainer(tracks(1)), grid: { ...gridContainer(tracks(1)).grid, extra: 1 } } }],
    ]
    for (const [message, change] of cases) {
      const layout = mutate(change)
      expect(thrown(() => validateLayout(layout))).toBe(message)
      expect(isValidLayout(layout)).toBe(false)
    }
  })

  it('LAY-SCHEMA-002: unknown keys inside a length return false rather than throw', () => {
    const layout = mutate(value => { value.item.width.value = { kind: 'px', value: 10, extra: 1 } })
    expect(thrown(() => validateLayout(layout))).toBeNull()
    expect(validateLayout(layout)).toBe(false)
  })

  it('LAY-SCHEMA-002: insets and zIndex are only valid on absolute positions', () => {
    expect(validateLayout({ item: { position: { mode: 'flow', left: { kind: 'px', value: 0 } } } })).toBe(false)
    expect(validateLayout({ item: { position: { mode: 'flow', zIndex: 1 } } })).toBe(false)
    expect(validateLayout({ item: { position: { mode: 'absolute', left: { kind: 'px', value: -20 }, zIndex: 1 } } })).toBe(true)
    expect(validateLayout({ item: { position: { mode: 'absolute', zIndex: 1.5 } } })).toBe(false)
  })

  it('LAY-SCHEMA-002: mode-specific container records must match the display mode', () => {
    const flex = { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' }
    const item = { position: { mode: 'flow' } }
    expect(validateLayout({ item, container: { display: 'block', flex } })).toBe(false)
    expect(validateLayout({ item, container: { display: 'flex', flex, grid: gridContainer(tracks(1)).grid } })).toBe(false)
    expect(validateLayout({ item, container: { display: 'block', gap: 8 } })).toBe(false)
    expect(validateLayout({ item, container: { display: 'flex' } })).toBe(false)
    expect(validateLayout({ item, container: { display: 'grid' } })).toBe(false)
    // Negative controls.
    expect(validateLayout({ item, container: { display: 'block' } })).toBe(true)
    expect(validateLayout({ item, container: { display: 'flex', flex, gap: 8 } })).toBe(true)
  })

  it('LAY-SCHEMA-002: grid containers need 1 to 200 tracks per axis', () => {
    const item = { position: { mode: 'flow' } }
    expect(validateLayout({ item, container: gridContainer([]) })).toBe(false)
    expect(validateLayout({ item, container: gridContainer(tracks(201)) })).toBe(false)
    expect(validateLayout({ item, container: gridContainer(tracks(200)) })).toBe(true)
    expect(validateLayout({ item, container: gridContainer([{ kind: 'fr', value: -1 }]) })).toBe(false)
  })

  it('LAY-SCHEMA-002: grid item lines are integers from 1 to 1000', () => {
    const withGrid = (grid: Loose) => ({ item: { position: { mode: 'flow' }, grid } })
    expect(validateLayout(withGrid({ columnStart: 0 }))).toBe(false)
    expect(validateLayout(withGrid({ columnSpan: 1001 }))).toBe(false)
    expect(validateLayout(withGrid({ rowSpan: 2.5 }))).toBe(false)
    expect(validateLayout(withGrid({ columnStart: 1, columnSpan: 1000 }))).toBe(true)
  })

  it('LAY-SCHEMA-002: transforms bound rotation and require a number or {x,y} scale', () => {
    const withTransform = (transform: Loose) => ({ item: { position: { mode: 'flow' }, transform } })
    expect(validateLayout(withTransform({ rotate: 3601 }))).toBe(false)
    expect(validateLayout(withTransform({ rotate: 3600 }))).toBe(true)
    expect(validateLayout(withTransform({ scale: { x: 1 } }))).toBe(false)
    expect(validateLayout(withTransform({ scale: { x: 1, y: 1, z: 1 } }))).toBe(false)
    expect(validateLayout(withTransform({ scale: [1, 1] }))).toBe(false)
    expect(validateLayout(withTransform({ scale: '2' }))).toBe(false)
    expect(validateLayout(withTransform({ scale: 2 }))).toBe(true)
    expect(validateLayout(withTransform({ scale: { x: 2, y: -1 } }))).toBe(true)
  })

  it('LAY-SCHEMA-002: auto is valid on margin but not on padding', () => {
    const item = { position: { mode: 'flow' } }
    expect(validateLayout({ item, spacing: { padding: 'auto' } })).toBe(false)
    expect(validateLayout({ item, spacing: { padding: { x: 'auto', y: 0 } } })).toBe(false)
    expect(validateLayout({ item, spacing: { margin: 'auto' } })).toBe(true)
    expect(validateLayout({ item, spacing: { padding: -1 } })).toBe(false)
    expect(validateLayout({ item, spacing: { margin: -8 } })).toBe(true)
  })
})

describe('sizing classification and transitions', () => {
  it('LAY-SIZE-002: classifySizing maps each length kind to its mode', () => {
    expect(classifySizing({ kind: 'percent', value: 100 })).toBe('fill')
    expect(classifySizing({ kind: 'percent', value: 99 })).toBe('relative')
    expect(classifySizing({ kind: 'percent', value: 0 })).toBe('relative')
    expect(classifySizing({ kind: 'px', value: 100 })).toBe('fixed')
    expect(classifySizing({ kind: 'intrinsic', value: 'fit-content' })).toBe('hug')
    expect(classifySizing({ kind: 'intrinsic', value: 'min-content' })).toBe('hug')
    expect(classifySizing({ kind: 'intrinsic', value: 'max-content' })).toBe('hug')
    expect(classifySizing({ kind: 'auto' })).toBe('auto')
    expect(classifySizing(undefined)).toBe('auto')
    expect(classifySizing({ kind: 'expression', raw: '100% - 8px' })).toBe('calculate')
  })

  it('LAY-SIZE-002: fixed takes the rounded measurement, then the current px, then 100', () => {
    expect(transitionSizing('fixed', { measuredPx: 183.6 })).toEqual({ kind: 'px', value: 184 })
    expect(transitionSizing('fixed', {})).toEqual({ kind: 'px', value: 100 })
    expect(transitionSizing('fixed', { current: { kind: 'px', value: 75 } })).toEqual({ kind: 'px', value: 75 })
  })

  it('LAY-SIZE-002: relative derives the measured to parent ratio', () => {
    expect(transitionSizing('relative', { measuredPx: 240, parentPx: 480 })).toEqual({ kind: 'percent', value: 50 })
    // 250 / 300 = 83.33 -> 83.
    expect(transitionSizing('relative', { measuredPx: 250, parentPx: 300 })).toEqual({ kind: 'percent', value: 83 })
    // A Fill length is not a Relative one, so the ratio is derived instead of keeping 100.
    expect(transitionSizing('relative', { current: { kind: 'percent', value: 100 }, measuredPx: 240, parentPx: 480 })).toEqual({ kind: 'percent', value: 50 })
    // An existing relative percent is kept.
    expect(transitionSizing('relative', { current: { kind: 'percent', value: 30 }, measuredPx: 240, parentPx: 480 })).toEqual({ kind: 'percent', value: 30 })
  })

  it('LAY-SIZE-004: relative never produces NaN and never reaches 100', () => {
    expect(transitionSizing('relative', { measuredPx: 240, parentPx: 0 })).toEqual({ kind: 'percent', value: 50 })
    // 500 / 400 = 125% clamps to 99 so the result stays Relative, not Fill.
    expect(transitionSizing('relative', { measuredPx: 500, parentPx: 400 })).toEqual({ kind: 'percent', value: 99 })
  })

  it('LAY-SIZE-002: hug, fill, auto, and calculate transitions', () => {
    expect(transitionSizing('hug', { current: { kind: 'intrinsic', value: 'min-content' } })).toEqual({ kind: 'intrinsic', value: 'min-content' })
    expect(transitionSizing('hug', { current: { kind: 'px', value: 40 } })).toEqual({ kind: 'intrinsic', value: 'fit-content' })
    expect(transitionSizing('fill', { current: { kind: 'px', value: 40 }, measuredPx: 40, parentPx: 80 })).toEqual({ kind: 'percent', value: 100 })
    expect(transitionSizing('auto', { current: { kind: 'px', value: 40 } })).toEqual({ kind: 'auto' })
    expect(transitionSizing('calculate', { current: { kind: 'px', value: 12 } })).toEqual({ kind: 'expression', raw: '12px' })
    expect(transitionSizing('calculate', {})).toBeNull()
  })

  it('LAY-SIZE-002: transitionSizingMany skips relative nodes with no parent size unless they already hold a percent', () => {
    const result = transitionSizingMany('relative', [
      { id: 'a', measuredPx: 100, parentPx: undefined },
      { id: 'b', current: { kind: 'percent', value: 30 } },
      { id: 'c', measuredPx: 50, parentPx: 200 },
    ])
    expect(result).toEqual([{ id: 'b', length: { kind: 'percent', value: 30 } }, { id: 'c', length: { kind: 'percent', value: 25 } }])
    // Negative control: fixed does not skip the parentless node.
    expect(transitionSizingMany('fixed', [{ id: 'a', measuredPx: 100, parentPx: undefined }])).toEqual([{ id: 'a', length: { kind: 'px', value: 100 } }])
  })

  it('LAY-SIZE-002: availableSizingModes intersects parent and content capabilities', () => {
    expect(availableSizingModes({ hasParent: false, intrinsicContent: false })).toEqual(['fixed'])
    expect(availableSizingModes({ hasParent: true, intrinsicContent: false })).toEqual(['fixed', 'relative', 'fill', 'auto'])
    expect(availableSizingModes({ hasParent: true, intrinsicContent: true })).toEqual(['fixed', 'relative', 'fill', 'hug', 'auto'])
    expect(availableSizingModes({ hasParent: true, intrinsicContent: true, expressions: true })).toEqual(['fixed', 'relative', 'fill', 'hug', 'auto', 'calculate'])
  })
})

describe('size and spacing projection', () => {
  it('LAY-SIZE-005: axisSizeToCss clears all three longhands when unset and resets bounds when absent', () => {
    expect(axisSizeToCss(undefined, 'width')).toEqual({ width: null, minWidth: null, maxWidth: null })
    expect(axisSizeToCss({ value: { kind: 'px', value: 10 } }, 'width')).toEqual({ width: '10px', minWidth: null, maxWidth: null })
    expect(axisSizeToCss({ value: { kind: 'percent', value: 50 }, min: { kind: 'px', value: 20 }, max: { kind: 'intrinsic', value: 'max-content' } }, 'height')).toEqual({ height: '50%', minHeight: '20px', maxHeight: 'max-content' })
  })

  it('LAY-SIZE-005: aspect ratio projects when set and clears when absent', () => {
    expect(projectItemStyle(flow({ aspectRatio: 1.5 }), null).aspectRatio).toBe('1.5')
    expect(projectItemStyle(flow(), null).aspectRatio).toBeNull()
  })

  it('LAY-SPACING-001: spacingToCss writes all four longhands for each value shape', () => {
    expect(spacingToCss(8, 'padding')).toEqual({ paddingTop: '8px', paddingRight: '8px', paddingBottom: '8px', paddingLeft: '8px' })
    expect(spacingToCss({ x: 4, y: 2 }, 'padding')).toEqual({ paddingTop: '2px', paddingRight: '4px', paddingBottom: '2px', paddingLeft: '4px' })
    expect(spacingToCss({ top: 1, right: 2, bottom: 3, left: 4 }, 'padding')).toEqual({ paddingTop: '1px', paddingRight: '2px', paddingBottom: '3px', paddingLeft: '4px' })
    expect(spacingToCss({ x: 'auto', y: 0 }, 'margin')).toEqual({ marginTop: '0px', marginRight: 'auto', marginBottom: '0px', marginLeft: 'auto' })
    expect(spacingToCss({ top: 'auto', right: 1, bottom: 'auto', left: 2 }, 'margin')).toEqual({ marginTop: 'auto', marginRight: '1px', marginBottom: 'auto', marginLeft: '2px' })
  })

  it('LAY-SPACING-001: undefined clears the longhands while zero writes explicit zeros', () => {
    expect(spacingToCss(undefined, 'margin')).toEqual({ marginTop: null, marginRight: null, marginBottom: null, marginLeft: null })
    expect(spacingToCss(0, 'margin')).toEqual({ marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px' })
  })
})

describe('container projection', () => {
  const cleared = { display: null, flexDirection: null, flexWrap: null, justifyContent: null, alignItems: null, alignContent: null, justifyItems: null, gridTemplateColumns: null, gridTemplateRows: null, gridAutoFlow: null, overflow: null, columnGap: null, rowGap: null }

  it('LAY-FLEX-003: undefined and freeform containers clear every longhand', () => {
    expect(projectContainerStyle(undefined)).toEqual(cleared)
    expect(projectContainerStyle({ display: 'freeform' })).toEqual(cleared)
    expect(projectContainerStyle({ display: 'freeform', overflow: 'hidden' })).toEqual({ ...cleared, overflow: 'hidden' })
  })

  it('LAY-FLEX-003: block sets display only', () => {
    expect(projectContainerStyle({ display: 'block' })).toEqual({ ...cleared, display: 'block' })
  })

  it('LAY-FLEX-003: flex projects direction, wrap, distribution, alignment, and split gaps', () => {
    const container: LayoutContainer = { display: 'flex', gap: { x: 8, y: 4 }, flex: { direction: 'row', wrap: 'wrap', justify: 'space-between', align: 'center' } }
    expect(projectContainerStyle(container)).toEqual({ ...cleared, display: 'flex', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: '8px', rowGap: '4px' })
  })

  it('LAY-FLEX-003: flex start and end map to the flex-start and flex-end keywords; a scalar gap fills both axes', () => {
    const style = projectContainerStyle({ display: 'flex', gap: 6, flex: { direction: 'column', wrap: 'nowrap', justify: 'end', align: 'start' } })
    expect(style.justifyContent).toBe('flex-end')
    expect(style.alignItems).toBe('flex-start')
    expect(style.columnGap).toBe('6px')
    expect(style.rowGap).toBe('6px')
  })

  it('LAY-FLEX-003: grid projects templates and auto flow and clears flex longhands', () => {
    const container: LayoutContainer = { display: 'grid', grid: { columns: [{ kind: 'fr', value: 1 }, { kind: 'px', value: 200 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } }
    expect(projectContainerStyle(container)).toEqual({ ...cleared, display: 'grid', gridTemplateColumns: '1fr 200px', gridTemplateRows: 'auto', gridAutoFlow: 'row' })
  })
})

describe('item projection', () => {
  it('LAY-GEST-004: a flow item clears position, insets, and z-index', () => {
    const style = projectItemStyle(flow(), null)
    for (const key of ['position', 'left', 'top', 'right', 'bottom', 'zIndex']) expect(style[key]).toBeNull()
  })

  it('LAY-GEST-004: an absolute item projects each authored inset and clears the rest', () => {
    const style = projectItemStyle({ position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'percent', value: 5 }, zIndex: 3 } }, null)
    expect(style.position).toBe('absolute')
    expect(style.left).toBe('10px')
    expect(style.top).toBe('5%')
    expect(style.right).toBeNull()
    expect(style.bottom).toBeNull()
    expect(style.zIndex).toBe('3')
  })

  it('LAY-FLEX-004: a zero px basis projects as 0% and flex fields only apply in a flex parent', () => {
    expect(projectItemStyle(flow({ flex: { basis: { kind: 'px', value: 0 } } }), 'flex').flexBasis).toBe('0%')
    expect(projectItemStyle(flow({ flex: { basis: { kind: 'px', value: 10 } } }), 'flex').flexBasis).toBe('10px')
    const style = projectItemStyle(flow({ flex: { grow: 1, shrink: 0 } }), 'flex')
    expect(style.flexGrow).toBe('1')
    expect(style.flexShrink).toBe('0')
    expect(style.flexBasis).toBeNull()
    expect(projectItemStyle(flow({ flex: { grow: 1, basis: { kind: 'px', value: 0 } } }), 'grid').flexGrow).toBeNull()
  })

  it('PAPER-FILL-001: semantic Fill projects by parent axis instead of as a universal 100 percent size', () => {
    const fill = { value: { kind: 'percent' as const, value: 100 } }
    const rowMain = projectItemStyle(flow({ width: fill }), { display: 'flex', flexDirection: 'row' })
    expect([rowMain.width, rowMain.flexGrow, rowMain.flexShrink, rowMain.flexBasis]).toEqual([null, '1', '1', '0%'])
    const rowCross = projectItemStyle(flow({ height: fill }), { display: 'flex', flexDirection: 'row' })
    expect([rowCross.height, rowCross.alignSelf]).toEqual([null, 'stretch'])
    const gridWidth = projectItemStyle(flow({ width: fill }), { display: 'grid' })
    expect([gridWidth.width, gridWidth.justifySelf]).toEqual([null, 'stretch'])
    const constrained = projectItemStyle({ position: { mode: 'absolute', left: { kind: 'px', value: 0 }, right: { kind: 'px', value: 0 } }, width: fill }, { display: 'freeform' })
    expect(constrained.width).toBeNull()
  })

  it('LAY-SCHEMA-002: transform projects rotate then scale', () => {
    expect(projectItemStyle(flow({ transform: { rotate: 45, scale: { x: 2, y: 1 } } }), null).transform).toBe('rotate(45deg) scale(2, 1)')
    expect(projectItemStyle(flow({ transform: { scale: 1.5 } }), null).transform).toBe('scale(1.5)')
    expect(projectItemStyle(flow(), null).transform).toBeNull()
  })

  it('LAY-GRID-002: gridLine emits start, span end, span start, or nothing', () => {
    expect(gridLine(2, 1)).toEqual({ start: '2', end: null })
    expect(gridLine(2, 3)).toEqual({ start: '2', end: 'span 3' })
    expect(gridLine(undefined, 2)).toEqual({ start: 'span 2', end: null })
    expect(gridLine(undefined, undefined)).toEqual({ start: null, end: null })
  })

  it('LAY-GRID-002: grid lines project in a grid parent and clear in a flex parent', () => {
    const item = flow({ grid: { columnStart: 2, columnSpan: 3, rowSpan: 2, justifySelf: 'center' } })
    const inGrid = projectItemStyle(item, 'grid')
    expect([inGrid.gridColumnStart, inGrid.gridColumnEnd, inGrid.gridRowStart, inGrid.gridRowEnd, inGrid.justifySelf]).toEqual(['2', 'span 3', 'span 2', null, 'center'])
    const inFlex = projectItemStyle(item, 'flex')
    expect([inFlex.gridColumnStart, inFlex.gridColumnEnd, inFlex.gridRowStart, inFlex.gridRowEnd, inFlex.justifySelf]).toEqual([null, null, null, null, null])
  })
})

describe('definite main axis', () => {
  it('LAY-FLEX-004: a definite row width stops shrinking and clears stale grow and basis', () => {
    expect(applyDefiniteMainAxis(flow({ width: { value: { kind: 'px', value: 200 } } }), 'row')).toEqual(flow({ width: { value: { kind: 'px', value: 200 } }, flex: { shrink: 0 } }))
    expect(applyDefiniteMainAxis(flow({ width: { value: { kind: 'px', value: 200 } }, flex: { grow: 1 } }), 'row-reverse').flex).toEqual({ shrink: 0 })
    expect(applyDefiniteMainAxis(flow({ width: { value: { kind: 'percent', value: 50 } } }), 'row').flex).toEqual({ shrink: 0 })
  })

  it('LAY-FLEX-004: an explicit triple, a cross-axis length, or an intrinsic length leaves the item alone', () => {
    const triple = flow({ width: { value: { kind: 'px', value: 200 } }, flex: { grow: 1, shrink: 1, basis: { kind: 'auto' } } })
    expect(applyDefiniteMainAxis(triple, 'row')).toEqual(flow({ width: { value: { kind: 'px', value: 200 } }, flex: { grow: 1, shrink: 1, basis: { kind: 'auto' } } }))
    expect(applyDefiniteMainAxis(flow({ width: { value: { kind: 'px', value: 200 } } }), 'column').flex).toBeUndefined()
    expect(applyDefiniteMainAxis(flow({ height: { value: { kind: 'px', value: 50 } } }), 'column').flex).toEqual({ shrink: 0 })
    expect(applyDefiniteMainAxis(flow({ width: { value: { kind: 'intrinsic', value: 'fit-content' } } }), 'row').flex).toBeUndefined()
  })
})

describe('normalization', () => {
  it('LAY-SCHEMA-002: normalizeContainer drops stale mode state and fills required records', () => {
    expect(normalizeContainer({ display: 'block', gap: 8, flex: { direction: 'row', wrap: 'wrap', justify: 'center', align: 'center' } })).toEqual({ display: 'block' })
    expect(normalizeContainer({ display: 'flex' })).toEqual({ display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } })
    expect(normalizeContainer({ display: 'grid', gap: 4 })).toEqual({ display: 'grid', gap: 4, grid: { columns: [{ kind: 'fr', value: 1 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } })
    expect(normalizeContainer({ display: 'freeform', overflow: 'clip', gap: 2 })).toEqual({ display: 'freeform', overflow: 'clip' })
  })

  it('LAY-GEST-004: an item switched to flow loses its insets and z-index but keeps its size', () => {
    const item: LayoutItem = { position: { mode: 'flow', left: { kind: 'px', value: 5 }, top: { kind: 'px', value: 6 }, right: { kind: 'percent', value: 1 }, zIndex: 2 }, width: { value: { kind: 'px', value: 100 } }, height: { value: { kind: 'px', value: 50 } } }
    expect(normalizeItem(item, null)).toEqual({ position: { mode: 'flow' }, width: { value: { kind: 'px', value: 100 } }, height: { value: { kind: 'px', value: 50 } } })
    // Negative control: an absolute item keeps them.
    const absolute: LayoutItem = { position: { mode: 'absolute', left: { kind: 'px', value: 5 }, zIndex: 2 } }
    expect(normalizeItem(absolute, null)).toEqual({ position: { mode: 'absolute', left: { kind: 'px', value: 5 }, zIndex: 2 } })
  })

  it('LAY-SCHEMA-002: item flex and grid fields survive only under a matching parent', () => {
    const item = flow({ flex: { grow: 1 }, grid: { columnStart: 2 } })
    expect(normalizeItem(item, 'block')).toEqual({ position: { mode: 'flow' } })
    expect(normalizeItem(item, 'flex')).toEqual({ position: { mode: 'flow' }, flex: { grow: 1 } })
    expect(normalizeItem(item, 'grid')).toEqual({ position: { mode: 'flow' }, grid: { columnStart: 2 } })
    expect(normalizeItem(flow({ flex: {} }), 'flex')).toEqual({ position: { mode: 'flow' } })
  })

  it('LAY-SCHEMA-002: normalizeLayout normalizes item, container, and empty spacing together', () => {
    const layout: NodeLayout = { item: flow({ grid: { rowStart: 1 } }), container: { display: 'block', gap: 4 }, spacing: { padding: 8 } }
    expect(normalizeLayout(layout, 'flex')).toEqual({ item: { position: { mode: 'flow' } }, container: { display: 'block' }, spacing: { padding: 8 } })
    expect(normalizeLayout({ item: flow(), spacing: {} }, null)).toEqual({ item: { position: { mode: 'flow' } } })
  })
})

describe('legacy adapters', () => {
  it('LAY-SCHEMA-002: legacyLayout derives the five-field placement', () => {
    expect(legacyLayout(undefined)).toStrictEqual({ mode: 'flow', x: 0, y: 0 })
    const absolute: NodeLayout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 34 } }, width: { value: { kind: 'px', value: 300 } } } }
    expect(legacyLayout(absolute)).toStrictEqual({ mode: 'absolute', x: 12, y: 34, width: 300 })
    const relative: NodeLayout = { item: { position: { mode: 'absolute', left: { kind: 'percent', value: 10 }, top: { kind: 'px', value: 34 } }, width: { value: { kind: 'percent', value: 50 } }, height: { value: { kind: 'px', value: 20 } } } }
    expect(legacyLayout(relative)).toStrictEqual({ mode: 'absolute', x: 0, y: 34, height: 20 })
  })

  it('LAY-SCHEMA-002: layoutFromLegacy keeps everything the legacy fields cannot express', () => {
    const previous: NodeLayout = {
      item: { position: { mode: 'absolute', left: { kind: 'px', value: 1 }, top: { kind: 'px', value: 2 }, right: { kind: 'px', value: 3 }, zIndex: 4 }, width: { value: { kind: 'px', value: 10 }, min: { kind: 'px', value: 5 }, max: { kind: 'px', value: 500 } }, aspectRatio: 2 },
      container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } },
      spacing: { padding: 8 },
    }
    expect(layoutFromLegacy({ mode: 'absolute', x: 12, y: 34, width: 300 }, previous)).toEqual({
      item: { position: { mode: 'absolute', left: { kind: 'px', value: 12 }, top: { kind: 'px', value: 34 }, right: { kind: 'px', value: 3 }, zIndex: 4 }, width: { value: { kind: 'px', value: 300 }, min: { kind: 'px', value: 5 }, max: { kind: 'px', value: 500 } }, aspectRatio: 2 },
      container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } },
      spacing: { padding: 8 },
    })
    expect(layoutFromLegacy({ mode: 'flow', x: 12, y: 34, width: 300 }, previous).item.position).toEqual({ mode: 'flow' })
  })

  it('LAY-SCHEMA-002: layoutFromLegacy drops a px size the legacy view no longer has and keeps a percent one', () => {
    const pxWidth: NodeLayout = { item: { position: { mode: 'flow' }, width: { value: { kind: 'px', value: 10 } } } }
    expect(layoutFromLegacy({ mode: 'flow', x: 0, y: 0 }, pxWidth)).toEqual({ item: { position: { mode: 'flow' } } })
    const percentWidth: NodeLayout = { item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 50 } } } }
    expect(layoutFromLegacy({ mode: 'flow', x: 0, y: 0 }, percentWidth)).toEqual(percentWidth)
  })

  it('LAY-SCHEMA-002: isLegacyOnlyLayout is true only for px placement and px sizes', () => {
    const plain: NodeLayout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 1 }, top: { kind: 'px', value: 2 } }, width: { value: { kind: 'px', value: 3 } } } }
    expect(isLegacyOnlyLayout(plain)).toBe(true)
    expect(isLegacyOnlyLayout({ item: flow() })).toBe(true)
    expect(isLegacyOnlyLayout({ ...plain, spacing: { padding: 0 } })).toBe(false)
    expect(isLegacyOnlyLayout({ item: { ...plain.item, position: { mode: 'absolute', right: { kind: 'px', value: 0 } } } })).toBe(false)
    expect(isLegacyOnlyLayout({ item: { ...plain.item, width: { value: { kind: 'percent', value: 50 } } } })).toBe(false)
    expect(isLegacyOnlyLayout({ item: { ...plain.item, width: { value: { kind: 'px', value: 3 }, min: { kind: 'px', value: 1 } } } })).toBe(false)
    expect(isLegacyOnlyLayout({ item: flow({ aspectRatio: 1 }) })).toBe(false)
  })
})
