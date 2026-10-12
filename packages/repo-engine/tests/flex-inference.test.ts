import { describe, expect, it } from 'vitest'
import { inferFlexLayout } from '../src/flex-inference.js'
import type { FlexAnalysisChild, FlexInferenceInput, Rect } from '../src/flex-inference.js'
import type { PositionMode } from '../src/layout.js'

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
const child = (
  id: string,
  worldAabb: Rect,
  authoredPosition = { x: worldAabb.x, y: worldAabb.y },
  authoredSize = { width: worldAabb.width, height: worldAabb.height },
  parentLocalCenter = { x: authoredPosition.x + authoredSize.width / 2, y: authoredPosition.y + authoredSize.height / 2 },
  sourcePosition: PositionMode = 'freeform',
): FlexAnalysisChild => ({ id, worldAabb, authoredPosition, authoredSize, parentLocalCenter, sourcePosition })
const analyze = (children: readonly FlexAnalysisChild[], options: Partial<Pick<FlexInferenceInput, 'containerSize' | 'directAddLeadingInset' | 'kind' | 'isRoot'>> = {}) => inferFlexLayout({
  containerSize: options.containerSize ?? { width: 200, height: 200 },
  children,
  directAddLeadingInset: options.directAddLeadingInset ?? { x: 0, y: 0 },
  kind: options.kind ?? 'direct-add',
  isRoot: options.isRoot ?? false,
})

describe('PAPER-FLEX-001/002 Paper Add and Wrap analysis', () => {
  it('uses Paper empty-frame defaults and the strict wider-than-tall boundary', () => {
    const square = analyze([], { containerSize: { width: 100, height: 100 } })
    expect(square).toMatchObject({ direction: 'column', align: 'start', justify: 'start', wrap: 'nowrap', gap: 16, padding: { x: 16, y: 16 }, order: [], worldBounds: null })
    expect(square.synthetic).toEqual({ container: { x: 0, y: 0, width: 32, height: 32 }, children: [] })

    const wider = analyze([], { containerSize: { width: 101, height: 100 } })
    expect(wider).toMatchObject({ direction: 'row', align: 'center', gap: 16, padding: { x: 16, y: 16 } })
  })

  it('chooses direction from normalized world-AABB center spread and gives an exact tie to row', () => {
    const column = analyze([child('a', rect(0, 0, 100, 40)), child('b', rect(80, 100, 100, 40))])
    expect(column.worldBounds).toEqual({ x: 0, y: 0, width: 180, height: 140 })
    expect(column.direction).toBe('column')

    const tie = analyze([child('a', rect(0, 0, 40, 40)), child('b', rect(50, 50, 40, 40))])
    expect(tie.direction).toBe('row')
  })

  it('matches Paper direct Add fixture A/B/C without shifting the authored Y coordinates', () => {
    const a = child('a', rect(10, 20, 20, 20))
    const b = child('b', rect(50, 20, 20, 40))
    const c = child('c', rect(100, 20, 20, 60))
    const result = analyze([c, a, b], { containerSize: { width: 300, height: 200 }, directAddLeadingInset: { x: 10, y: 20 } })
    expect(result).toMatchObject({ direction: 'row', align: 'start', gap: 25, padding: { x: 10, y: 20 }, order: ['a', 'b', 'c'] })
    expect(result.synthetic.container).toEqual({ x: 0, y: 0, width: 130, height: 100 })
    expect(result.synthetic.children.map(entry => entry.synthetic)).toEqual([
      { x: 10, y: 20, width: 20, height: 20 },
      { x: 55, y: 20, width: 20, height: 40 },
      { x: 100, y: 20, width: 20, height: 60 },
    ])
  })

  it('uses start, then end, then center as exact world cross-range tie priority and never stretch', () => {
    expect(analyze([child('a', rect(0, 20, 20, 20)), child('b', rect(40, 20, 20, 20))]).align).toBe('start')
    expect(analyze([child('a', rect(0, 20, 20, 10)), child('b', rect(40, 5, 20, 30))]).align).toBe('end')
    expect(analyze([child('a', rect(0, 30, 20, 20)), child('b', rect(40, 20, 20, 40)), child('c', rect(80, 10, 20, 60))]).align).toBe('center')
  })

  it('uses the mathematical median of parent-local edge gaps, retaining overlap samples until the final clamp', () => {
    const four = [0, 15, 55, 175].map((x, index) => child(String(index), rect(x, 0, 20, 20)))
    expect(analyze(four).gap).toBe(20)

    const overlap = [0, 15, 30].map((x, index) => child(String(index), rect(x, 0, 20, 20)))
    expect(analyze(overlap).gap).toBe(0)
  })

  it('applies the one-child authored shape, alignment, and main-axis-padding gap rules', () => {
    const wide = analyze([child('wide', rect(10, 20, 60, 20))], { directAddLeadingInset: { x: 10, y: 20 } })
    expect(wide).toMatchObject({ direction: 'column', align: 'start', gap: 20, padding: { x: 10, y: 20 } })
    expect(wide.synthetic.container).toEqual({ x: 0, y: 0, width: 80, height: 60 })

    const square = analyze([child('square', rect(12, 8, 30, 30))], { directAddLeadingInset: { x: 12, y: 8 } })
    expect(square).toMatchObject({ direction: 'row', align: 'center', gap: 12, padding: { x: 12, y: 8 } })
  })

  it('uses authored one-child dimensions even when rotation makes the world AABB imply the inverse', () => {
    const authoredWide = child('authored-wide', rect(0, 0, 20, 80), { x: 0, y: 0 }, { width: 80, height: 20 }, { x: 40, y: 10 })
    const authoredTall = child('authored-tall', rect(0, 0, 80, 20), { x: 0, y: 0 }, { width: 20, height: 80 }, { x: 10, y: 40 })
    expect(analyze([authoredWide])).toMatchObject({ direction: 'column', align: 'start' })
    expect(analyze([authoredTall])).toMatchObject({ direction: 'row', align: 'center' })
  })

  it('stable-sorts only authored main-axis coordinates and retains input tree order for ties', () => {
    const b = child('b', rect(10, 120, 20, 20), { x: 10, y: 120 })
    const a = child('a', rect(10, 0, 20, 20), { x: 10, y: 0 })
    const c = child('c', rect(150, 60, 20, 20), { x: 150, y: 60 })
    const result = analyze([b, a, c])
    expect(result.direction).toBe('row')
    expect(result.order).toEqual(['b', 'a', 'c'])
    expect(result.synthetic.children.map(entry => entry.treeIndex)).toEqual([0, 1, 2])
  })

  it('uses zero padding for roots and wraps while preserving the inferred gap', () => {
    const children = [child('a', rect(18, 24, 20, 20)), child('b', rect(58, 24, 20, 20))]
    const root = analyze(children, { directAddLeadingInset: { x: 18, y: 24 }, isRoot: true })
    const wrap = analyze(children, { directAddLeadingInset: { x: 18, y: 24 }, kind: 'wrap' })
    expect(root.padding).toEqual({ x: 0, y: 0 })
    expect(wrap.padding).toEqual({ x: 0, y: 0 })
    expect(root.gap).toBe(20)
    expect(wrap.gap).toBe(20)
  })

  it('preserves explicit absolute children during direct Add and clears them for Wrap', () => {
    const flow = child('flow', rect(10, 20, 20, 20))
    const absolute = child('absolute', rect(50, 20, 20, 20), undefined, undefined, undefined, 'absolute')
    const direct = analyze([flow, absolute], { directAddLeadingInset: { x: 10, y: 20 } })
    const wrap = analyze([flow, absolute], { kind: 'wrap' })
    expect(direct.synthetic.children.map(entry => ({ id: entry.id, source: entry.sourcePosition, target: entry.position }))).toEqual([
      { id: 'flow', source: 'freeform', target: 'flow' },
      { id: 'absolute', source: 'absolute', target: 'absolute' },
    ])
    expect(wrap.synthetic.children.map(entry => ({ id: entry.id, source: entry.sourcePosition, target: entry.position }))).toEqual([
      { id: 'flow', source: 'freeform', target: 'flow' },
      { id: 'absolute', source: 'absolute', target: 'flow' },
    ])
  })

  it('places center-aligned fractional children from the rounded synthetic cross size', () => {
    const first = child('first', rect(0, 0, 10, 10.6), { x: 0, y: 0 }, { width: 10, height: 10.6 }, { x: 5, y: 5.3 })
    const second = child('second', rect(20, 2.4, 10, 5.8), { x: 20, y: 2.4 }, { width: 10, height: 5.8 }, { x: 25, y: 5.3 })
    const result = analyze([first, second])
    expect(result).toMatchObject({ direction: 'row', align: 'center', gap: 10 })
    expect(result.synthetic.container).toEqual({ x: 0, y: 0, width: 30, height: 11 })
    expect(result.synthetic.children[1]?.synthetic).toEqual({ x: 20, y: 3, width: 10, height: 6 })
  })

  it('keeps rotated world analysis separate from authored ordering, local-center gaps, and authored sizing', () => {
    const a = child('a', rect(0, 0, 80, 20), { x: 0, y: 100 }, { width: 20, height: 80 }, { x: 10, y: 100 }, 'absolute')
    const b = child('b', rect(30, 100, 20, 80), { x: 0, y: 0 }, { width: 80, height: 20 }, { x: 40, y: 30 })
    const result = analyze([a, b], { kind: 'wrap' })
    expect(result).toMatchObject({ direction: 'column', align: 'center', order: ['b', 'a'], gap: 20, padding: { x: 0, y: 0 } })
    expect(result.worldBounds).toEqual({ x: 0, y: 0, width: 80, height: 180 })
    expect(result.synthetic.container).toEqual({ x: 0, y: 0, width: 80, height: 120 })
    expect(result.synthetic.children.map(entry => ({ id: entry.id, treeIndex: entry.treeIndex, rect: entry.synthetic, target: entry.position }))).toEqual([
      { id: 'b', treeIndex: 1, rect: { x: 0, y: 0, width: 80, height: 20 }, target: 'flow' },
      { id: 'a', treeIndex: 0, rect: { x: 30, y: 40, width: 20, height: 80 }, target: 'flow' },
    ])
  })

  it('rounds leading insets and synthetic output without four-pixel buckets', () => {
    const one = child('a', rect(17.7, 29.7, 20.4, 10.4), { x: 7.5, y: 9.6 }, { width: 20.4, height: 10.4 }, { x: 17.7, y: 14.8 })
    const two = child('b', rect(53.2, 29.7, 20.4, 10.4), { x: 43, y: 9.6 }, { width: 20.4, height: 10.4 }, { x: 53.2, y: 14.8 })
    const result = analyze([one, two], { directAddLeadingInset: { x: 7.5, y: 9.6 } })
    expect(result.padding).toEqual({ x: 8, y: 10 })
    expect(result.gap).toBe(15)
    expect(result.synthetic.container).toEqual({ x: 0, y: 0, width: 72, height: 30 })
  })
})
