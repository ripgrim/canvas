import { describe, expect, it } from 'vitest'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import { positionAbsolute, positionFlow, setAspectRatio, setAxisBound, setAxisLength, setAxisSizing, setAxisSizingMany, setInset, setSpacing, setZIndex, sizingModeOf } from './layout-commands'

const px = (value: number) => ({ kind: 'px' as const, value })
const percent = (value: number) => ({ kind: 'percent' as const, value })
const absolute: NodeLayout = { item: { position: { mode: 'absolute', left: px(12), top: px(34), right: px(8), zIndex: 3 }, width: { value: px(200), min: px(50) }, height: { value: percent(100) }, aspectRatio: 1.5 }, container: { display: 'block' }, spacing: { padding: 4 } }

describe('positioning transitions', () => {
  it('LAY-GEST-004: absolute to flow drops insets and z-index but keeps sizing, bounds, aspect, container and spacing', () => {
    expect(positionFlow(absolute, null)).toEqual({ item: { position: { mode: 'flow' }, width: { value: px(200), min: px(50) }, height: { value: percent(100) }, aspectRatio: 1.5 }, container: { display: 'block' }, spacing: { padding: 4 } })
  })
  it('LAY-GEST-004: flow to absolute writes the parent-local position as px insets and keeps sizing', () => {
    const flow: NodeLayout = { item: { position: { mode: 'flow' }, width: { value: px(120) } } }
    expect(positionAbsolute(flow, { x: 40.4, y: 59.6 })).toEqual({ item: { position: { mode: 'absolute', left: px(40), top: px(60) }, width: { value: px(120) } } })
    expect(positionAbsolute(undefined, { x: 0, y: 0 })).toEqual({ item: { position: { mode: 'absolute', left: px(0), top: px(0) } } })
    // Already absolute: unchanged, including the right inset and z-index.
    expect(positionAbsolute(absolute, { x: 1, y: 2 })).toBe(absolute)
  })
  it('round trip flow -> absolute -> flow leaves the record equal to the normalized start', () => {
    const start: NodeLayout = { item: { position: { mode: 'flow' }, width: { value: px(120) }, height: { value: { kind: 'intrinsic', value: 'fit-content' } } } }
    expect(positionFlow(positionAbsolute(start, { x: 5, y: 6 }), 'flex')).toEqual(start)
  })
  it('insets and z-index only exist on absolute nodes and keep their opposing anchors', () => {
    expect(setInset({ item: { position: { mode: 'flow' } } }, 'left', px(1))).toBeNull()
    expect(setInset(absolute, 'bottom', percent(10))!.item.position).toEqual({ mode: 'absolute', left: px(12), top: px(34), right: px(8), bottom: percent(10), zIndex: 3 })
    expect(setInset(absolute, 'left', null)!.item.position).toEqual({ mode: 'absolute', top: px(34), right: px(8), zIndex: 3 })
    expect(setZIndex(absolute, null)!.item.position).toEqual({ mode: 'absolute', left: px(12), top: px(34), right: px(8) })
    expect(setZIndex(absolute, 7.4)!.item.position.zIndex).toBe(7)
    expect(setZIndex(undefined, 1)).toBeNull()
  })
})

describe('sizing transitions', () => {
  it('LAY-SIZE-002: classifies the stored axis', () => {
    expect(sizingModeOf(absolute, 'width')).toBe('fixed')
    expect(sizingModeOf(absolute, 'height')).toBe('fill')
    expect(sizingModeOf({ item: { position: { mode: 'flow' }, width: { value: percent(99) } } }, 'width')).toBe('relative')
    expect(sizingModeOf(undefined, 'width')).toBe('auto')
  })
  it('Fixed takes the measured size and keeps bounds; Fill is exactly 100%; Hug is fit-content; Auto is auto', () => {
    const fixed = setAxisSizing(absolute, 'height', 'fixed', { measuredPx: 143.5 })!
    expect(fixed.item.height).toEqual({ value: px(144) })
    expect(fixed.item.width).toEqual({ value: px(200), min: px(50) })
    expect(setAxisSizing(absolute, 'width', 'fill', {})!.item.width).toEqual({ value: percent(100), min: px(50) })
    expect(setAxisSizing(absolute, 'width', 'hug', {})!.item.width).toEqual({ value: { kind: 'intrinsic', value: 'fit-content' }, min: px(50) })
    expect(setAxisSizing(absolute, 'width', 'auto', {})!.item.width).toEqual({ value: { kind: 'auto' }, min: px(50) })
  })
  it('LAY-SIZE-004: Relative from measurement, clamped to 0..99, and never NaN without a parent', () => {
    expect(setAxisSizing(undefined, 'width', 'relative', { measuredPx: 150, parentPx: 400 })!.item.width).toEqual({ value: percent(38) })
    expect(setAxisSizing(undefined, 'width', 'relative', { measuredPx: 500, parentPx: 400 })!.item.width).toEqual({ value: percent(99) })
    expect(setAxisSizing(undefined, 'width', 'relative', { measuredPx: 150, parentPx: 0 })!.item.width).toEqual({ value: percent(50) })
    expect(setAxisSizing(undefined, 'width', 'relative', {})!.item.width).toEqual({ value: percent(50) })
  })
  it('Calculate has nothing to store without a source value and is left alone', () => {
    expect(setAxisSizing(undefined, 'width', 'calculate', {})).toBeNull()
  })
  it('LAY-FLEX-004: a definite main axis in a Flex parent stops shrinking; the cross axis and an explicit triple do not', () => {
    const start: NodeLayout = { item: { position: { mode: 'flow' }, flex: { grow: 1 } } }
    expect(setAxisSizing(start, 'width', 'fixed', { measuredPx: 90 }, 'row')!.item).toEqual({ position: { mode: 'flow' }, width: { value: px(90) }, flex: { shrink: 0 } })
    expect(setAxisSizing(start, 'width', 'fixed', { measuredPx: 90 }, 'column')!.item).toEqual({ position: { mode: 'flow' }, width: { value: px(90) }, flex: { grow: 1 } })
    const triple: NodeLayout = { item: { position: { mode: 'flow' }, flex: { grow: 1, shrink: 1, basis: { kind: 'auto' } } } }
    expect(setAxisSizing(triple, 'height', 'fixed', { measuredPx: 20 }, 'column')!.item.flex).toEqual({ grow: 1, shrink: 1, basis: { kind: 'auto' } })
  })
  it('LAY-SIZE-003: multi-selection transitions use per-node measurements and skip Relative without a parent', () => {
    const results = setAxisSizingMany([
      { id: 'a', layout: undefined, measurement: { measuredPx: 100, parentPx: 400 } },
      { id: 'b', layout: undefined, measurement: { measuredPx: 300, parentPx: 400 } },
      { id: 'c', layout: undefined, measurement: { measuredPx: 300 } },
      { id: 'd', layout: { item: { position: { mode: 'flow' }, width: { value: percent(30) } } }, measurement: {} },
    ], 'width', 'relative')
    expect(Object.keys(results)).toEqual(['a', 'b', 'd'])
    expect(results.a!.item.width).toEqual({ value: percent(25) })
    expect(results.b!.item.width).toEqual({ value: percent(75) })
    expect(results.d!.item.width).toEqual({ value: percent(30) })
    const fixed = setAxisSizingMany([{ id: 'a', layout: undefined, measurement: { measuredPx: 100 } }, { id: 'c', layout: undefined, measurement: {} }], 'height', 'fixed')
    expect(fixed.a!.item.height).toEqual({ value: px(100) })
    expect(fixed.c!.item.height).toEqual({ value: px(100) })
  })
})

describe('bounds, aspect, lengths and spacing', () => {
  it('LAY-SIZE-005: bounds attach to an axis without touching its value; clearing the value keeps bounds as auto', () => {
    expect(setAxisBound(undefined, 'width', 'max', px(600)).item.width).toEqual({ value: { kind: 'auto' }, max: px(600) })
    expect(setAxisBound(absolute, 'width', 'min', null).item.width).toEqual({ value: px(200) })
    expect(setAxisLength(absolute, 'width', null).item.width).toEqual({ value: { kind: 'auto' }, min: px(50) })
    expect(setAxisLength(absolute, 'height', null).item.height).toBeUndefined()
    expect(setAxisLength(undefined, 'height', px(44)).item.height).toEqual({ value: px(44) })
  })
  it('LAY-SIZE-005: only a finite positive aspect ratio is stored', () => {
    expect(setAspectRatio(undefined, 1.5).item.aspectRatio).toBe(1.5)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) expect(setAspectRatio(absolute, bad).item.aspectRatio).toBeUndefined()
  })
  it('spacing is stored only when a side exists and clears cleanly', () => {
    expect(setSpacing(undefined, { padding: { x: 8, y: 4 } }).spacing).toEqual({ padding: { x: 8, y: 4 } })
    expect(setSpacing(absolute, { margin: { top: 'auto', right: 0, bottom: 0, left: 'auto' } }).spacing).toEqual({ margin: { top: 'auto', right: 0, bottom: 0, left: 'auto' } })
    expect(setSpacing(absolute, null).spacing).toBeUndefined()
    expect(setSpacing(absolute, {}).spacing).toBeUndefined()
  })
})
