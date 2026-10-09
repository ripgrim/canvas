import { describe, expect, it } from 'vitest'
import type { LayoutGap, NodeLayout } from '@canvas/repo-engine/layout'
import { convertDisplay } from './display-conversion'
import type { ConversionNode, DisplayConversionInput } from './display-conversion'

// Display conversions with hand-written expected records. Every rectangle below is drawn in the comment beside it and
// every derived number (padding, margins, gaps, tracks, starts) is computed by hand from those drawings.
const px = (value: number) => ({ kind: 'px' as const, value })
const percent = (value: number) => ({ kind: 'percent' as const, value })
const flow = { mode: 'flow' as const }
const node = (id: string, layout?: NodeLayout): ConversionNode => ({ id, layout })
const convert = (input: Partial<DisplayConversionInput> & Pick<DisplayConversionInput, 'container' | 'to'>) => convertDisplay({ children: [], measured: null, ...input })

describe('LAY-BLOCK-001: Flex to Block', () => {
  const flexColumn = (direction: 'column' | 'column-reverse' | 'row' | 'row-reverse', gap: LayoutGap): NodeLayout => ({
    item: { position: flow, width: { value: px(400) } },
    container: { display: 'flex', overflow: 'hidden', gap, flex: { direction, wrap: 'nowrap', justify: 'center', align: 'stretch' } },
  })
  const children = () => [
    node('a', { item: { position: flow, height: { value: px(40) }, flex: { grow: 1, shrink: 0, basis: px(10) } } }),
    node('b', { item: { position: flow, width: { value: percent(100), min: px(10) }, aspectRatio: 2 } }),
    node('c', { item: { position: flow }, spacing: { margin: { x: 4, y: 0 } } }),
  ]

  it('a column row gap of 12 becomes margin-top 12 on every child after the first, child flex fields clear, sizing stays', () => {
    const result = convert({ container: node('card', flexColumn('column', 12)), children: children(), to: 'block' })
    expect(result.order).toBeUndefined()
    expect(result.unsupported).toBeUndefined()
    // Gap and the flex record belong to Flex only; overflow is a container property every mode keeps.
    expect(result.layouts.card).toEqual({ item: { position: flow, width: { value: px(400) } }, container: { display: 'block', overflow: 'hidden' } })
    expect(result.layouts.a).toEqual({ item: { position: flow, height: { value: px(40) } } })
    expect(result.layouts.b).toEqual({ item: { position: flow, width: { value: percent(100), min: px(10) }, aspectRatio: 2 }, spacing: { margin: { top: 12, right: 0, bottom: 0, left: 0 } } })
    // c had margin x 4 / y 0: left and right stay 4, bottom stays 0, top becomes the gap.
    expect(result.layouts.c).toEqual({ item: { position: flow }, spacing: { margin: { top: 12, right: 4, bottom: 0, left: 4 } } })
  })

  it('column-reverse keeps the visual order by reversing the document order; the margins follow the new order', () => {
    // Visual order of a column-reverse Flex is c, b, a top to bottom; Block shows document order, so c, b, a it becomes.
    const result = convert({ container: node('card', flexColumn('column-reverse', { x: 8, y: 20 })), children: children(), to: 'block' })
    expect(result.order).toEqual(['c', 'b', 'a'])
    expect(result.layouts.c).toEqual({ item: { position: flow }, spacing: { margin: { x: 4, y: 0 } } })
    expect(result.layouts.b!.spacing).toEqual({ margin: { top: 20, right: 0, bottom: 0, left: 0 } })
    expect(result.layouts.a!.spacing).toEqual({ margin: { top: 20, right: 0, bottom: 0, left: 0 } })
  })

  it('negative control: a row gap of a row Flex is horizontal spacing and gives no margins; row-reverse still reverses', () => {
    const row = convert({ container: node('card', flexColumn('row', 12)), children: children(), to: 'block' })
    expect(row.order).toBeUndefined()
    expect(row.layouts.b).toEqual({ item: { position: flow, width: { value: percent(100), min: px(10) }, aspectRatio: 2 } })
    expect(row.layouts.c).toEqual({ item: { position: flow }, spacing: { margin: { x: 4, y: 0 } } })
    const reverse = convert({ container: node('card', flexColumn('row-reverse', 12)), children: children(), to: 'block' })
    expect(reverse.order).toEqual(['c', 'b', 'a'])
    expect(reverse.layouts.a!.spacing).toBeUndefined()
  })
})

describe('Freeform to Block', () => {
  it('sorts by y then x, infers padding in 4 px buckets, drops insets and z-index, and derives margins from the vertical gaps', () => {
    // Container border box (100, 50) 300 x 400 with a 1 px border: padding box (101, 51) 298 x 398, right 399, bottom 449.
    //   q (126,  78) 200 x 40   ends at y 118
    //   p (126, 134) 120 x 30   gap 134 - 118 = 16, ends at y 164
    //   r (181, 174) 100 x 50   gap 174 - 164 = 10, ends at y 224
    // Padding x: min(126 - 101, 399 - 326) = 25 -> bucket 24. Padding y: min(78 - 51, 449 - 224) = 27 -> bucket 28.
    const absolute = (left: number, top: number, extra: object = {}): NodeLayout => ({ item: { position: { mode: 'absolute', left: px(left), top: px(top), ...extra } } })
    const result = convert({
      container: node('frame', { item: { position: flow } }),
      children: [node('p', { item: { ...absolute(25, 83).item, width: { value: px(120) } } }), node('q', absolute(25, 27, { zIndex: 3 })), node('r', absolute(80, 123, { right: px(4) }))],
      measured: { container: { x: 100, y: 50, width: 300, height: 400 }, border: { top: 1, right: 1, bottom: 1, left: 1 }, children: { q: { x: 126, y: 78, width: 200, height: 40 }, p: { x: 126, y: 134, width: 120, height: 30 }, r: { x: 181, y: 174, width: 100, height: 50 } } },
      to: 'block',
    })
    expect(result.order).toEqual(['q', 'p', 'r'])
    expect(result.layouts.frame).toEqual({ item: { position: flow }, container: { display: 'block' }, spacing: { padding: { x: 24, y: 28 } } })
    expect(result.layouts.q).toEqual({ item: { position: flow } })
    expect(result.layouts.p).toEqual({ item: { position: flow, width: { value: px(120) } }, spacing: { margin: { top: 16, right: 0, bottom: 0, left: 0 } } })
    expect(result.layouts.r).toEqual({ item: { position: flow }, spacing: { margin: { top: 10, right: 0, bottom: 0, left: 0 } } })
    expect(result.unsupported).toBeUndefined()
  })

  it('an unmeasured child keeps its document place after the measured ones and the result says so', () => {
    const result = convert({
      container: node('frame'),
      children: [node('u'), node('v')],
      measured: { container: { x: 0, y: 0, width: 100, height: 100 }, children: { v: { x: 10, y: 10, width: 20, height: 20 } } },
      to: 'block',
    })
    expect(result.order).toEqual(['v', 'u'])
    expect(result.unsupported).toBe('Some children have no measured position')
  })
})

describe('to Flex', () => {
  it('Block to Flex uses column, start, start, nowrap and keeps child margins', () => {
    const result = convert({ container: node('panel', { item: { position: flow }, container: { display: 'block' } }), children: [node('a', { item: { position: flow }, spacing: { margin: 6 } })], to: 'flex' })
    expect(result.layouts.panel).toEqual({ item: { position: flow }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } })
    expect(result.layouts.a).toEqual({ item: { position: flow }, spacing: { margin: 6 } })
  })

  it('Grid to Flex uses row plus wrap, keeps the gap, and clears child grid placement', () => {
    const result = convert({
      container: node('grid', { item: { position: flow }, container: { display: 'grid', gap: { x: 8, y: 4 }, grid: { columns: [{ kind: 'fr', value: 1 }, { kind: 'px', value: 120 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } } }),
      children: [node('a', { item: { position: flow, grid: { columnStart: 2, rowStart: 1, justifySelf: 'center' }, height: { value: px(30) } } })],
      to: 'flex',
    })
    expect(result.layouts.grid).toEqual({ item: { position: flow }, container: { display: 'flex', gap: { x: 8, y: 4 }, flex: { direction: 'row', wrap: 'wrap', justify: 'start', align: 'start' } } })
    expect(result.layouts.a).toEqual({ item: { position: flow, height: { value: px(30) } } })
  })

  it('LAY-FLEX-005: Freeform to Flex applies the inferred direction, gap, alignment, padding and order', () => {
    // Container (0, 0) 300 x 100, no border. Children in one row, each 60 x 40 at y 30:
    //   a x 20..80, b x 100..160, c x 180..240 -> centers x 50/130/210 (spread 160), y all 50 (spread 0): row.
    //   Gaps 20 and 20 -> gap 20. Padding x min(20, 60) = 20; y min(30, 30) = 30 -> bucket 32.
    //   Main: inner start 20, inner size 260, content 220 -> start candidate 20 matches exactly: start.
    //   Cross: inner start 32, inner size 36; center puts a 40 px child at 32 + (36 - 40) / 2 = 30, the measured y: center.
    const result = convert({
      container: node('frame'),
      children: [node('c', { item: { position: { mode: 'absolute', left: px(180), top: px(30) } } }), node('a', { item: { position: { mode: 'absolute', left: px(20), top: px(30) } } }), node('b', { item: { position: { mode: 'absolute', left: px(100), top: px(30), zIndex: 1 } } })],
      measured: { container: { x: 0, y: 0, width: 300, height: 100 }, children: { a: { x: 20, y: 30, width: 60, height: 40 }, b: { x: 100, y: 30, width: 60, height: 40 }, c: { x: 180, y: 30, width: 60, height: 40 } } },
      to: 'flex',
    })
    expect(result.layouts.frame).toEqual({ item: { position: flow }, container: { display: 'flex', gap: 20, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } }, spacing: { padding: { x: 20, y: 32 } } })
    expect(result.order).toEqual(['a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) expect(result.layouts[id]).toEqual({ item: { position: flow } })
    expect(result.unsupported).toBeUndefined()
  })

  it('LAY-FLEX-005: a non-reproducible Freeform still converts with the inferred values and names the reason', () => {
    // Container (0, 0) 200 x 50. a x 0..50, b x 60..110 (gap 10), c x 140..190 (gap 30); all 50 tall at y 0.
    // Votes: 10 -> bucket 3, 30 -> bucket 8, a tie that the smaller bucket wins: gap 10; 30 differs by more than 2 px.
    // Every child fills the 50 px cross size at the padding edge (padding 0): stretch.
    const result = convert({
      container: node('frame'),
      children: [node('a'), node('b'), node('c')],
      measured: { container: { x: 0, y: 0, width: 200, height: 50 }, children: { a: { x: 0, y: 0, width: 50, height: 50 }, b: { x: 60, y: 0, width: 50, height: 50 }, c: { x: 140, y: 0, width: 50, height: 50 } } },
      to: 'flex',
    })
    expect(result.layouts.frame).toEqual({ item: { position: flow }, container: { display: 'flex', gap: 10, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'stretch' } }, spacing: { padding: { x: 0, y: 0 } } })
    expect(result.unsupported).toBe('Flex cannot reproduce this layout exactly: adjacent gaps differ by more than 2 px')
  })
})

describe('to Grid', () => {
  const three = () => [node('a', { item: { position: flow, flex: { grow: 1 } } }), node('b'), node('c')]
  const flexWith = (direction: 'row' | 'row-reverse' | 'column', wrap: 'nowrap' | 'wrap' = 'nowrap'): NodeLayout => ({ item: { position: flow }, container: { display: 'flex', gap: 12, flex: { direction, wrap, justify: 'start', align: 'start' } } })
  const fr = { kind: 'fr' as const, value: 1 }, auto = { kind: 'auto' as const }

  it('Flex row without wrap: one 1fr column per child, one auto row, gap kept, grow cleared, no explicit starts', () => {
    const result = convert({ container: node('f', flexWith('row')), children: three(), to: 'grid' })
    expect(result.layouts.f!.container).toEqual({ display: 'grid', gap: 12, grid: { columns: [fr, fr, fr], rows: [auto], autoFlow: 'row' } })
    expect(result.layouts.a).toEqual({ item: { position: flow } })
    expect(result.order).toBeUndefined()
  })

  it('Flex column is one column; row-reverse reverses the order', () => {
    expect(convert({ container: node('f', flexWith('column')), children: three(), to: 'grid' }).layouts.f!.container!.grid).toEqual({ columns: [fr], rows: [auto, auto, auto], autoFlow: 'row' })
    const reverse = convert({ container: node('f', flexWith('row-reverse')), children: three(), to: 'grid' })
    expect(reverse.order).toEqual(['c', 'b', 'a'])
    expect(reverse.layouts.f!.container!.grid!.columns).toEqual([fr, fr, fr])
  })

  it('Flex row with wrap estimates the column count from the measured lines', () => {
    // Lines: a b c on y 0..40 and d e on y 50..90 -> the longest line has 3 items -> 3 columns, ceil(5 / 3) = 2 rows.
    const rect = (x: number, y: number) => ({ x, y, width: 100, height: 40 })
    const result = convert({ container: node('f', flexWith('row', 'wrap')), children: [...three(), node('d'), node('e')], measured: { container: { x: 0, y: 0, width: 330, height: 90 }, children: { a: rect(0, 0), b: rect(110, 0), c: rect(220, 0), d: rect(0, 50), e: rect(110, 50) } }, to: 'grid' })
    expect(result.layouts.f!.container!.grid).toEqual({ columns: [fr, fr, fr], rows: [auto, auto], autoFlow: 'row' })
  })

  it('Block to Grid starts with one 1fr column', () => {
    const result = convert({ container: node('stack', { item: { position: flow }, container: { display: 'block' } }), children: three(), to: 'grid' })
    expect(result.layouts.stack!.container).toEqual({ display: 'grid', grid: { columns: [fr], rows: [auto, auto, auto], autoFlow: 'row' } })
  })

  it('Freeform to Grid clusters columns and rows, votes the gap, infers padding and writes explicit starts in row order', () => {
    // Container (0, 0) 400 x 300, no border. Two columns (x 20..170 and 194..344) and two rows (y 20..120 and 142..222):
    //   a (20, 20)  b (194, 20)
    //   c (20, 142) d (194, 142)
    // Column spacing 194 - 170 = 24 (bucket 6), row spacing 142 - 120 = 22 (bucket 6): one bucket, average 23.
    // Padding x min(20, 400 - 344) = 20; y min(20, 300 - 222) = 20.
    const result = convert({
      container: node('frame'),
      children: [node('d'), node('a'), node('c'), node('b')],
      measured: { container: { x: 0, y: 0, width: 400, height: 300 }, children: { a: { x: 20, y: 20, width: 150, height: 100 }, b: { x: 194, y: 20, width: 150, height: 100 }, c: { x: 20, y: 142, width: 150, height: 80 }, d: { x: 194, y: 142, width: 150, height: 80 } } },
      to: 'grid',
    })
    expect(result.layouts.frame).toEqual({ item: { position: flow }, container: { display: 'grid', gap: 23, grid: { columns: [fr, fr], rows: [auto, auto], autoFlow: 'row' } }, spacing: { padding: { x: 20, y: 20 } } })
    expect(result.order).toEqual(['a', 'b', 'c', 'd'])
    expect(result.layouts.a!.item.grid).toEqual({ columnStart: 1, rowStart: 1 })
    expect(result.layouts.b!.item.grid).toEqual({ columnStart: 2, rowStart: 1 })
    expect(result.layouts.c!.item.grid).toEqual({ columnStart: 1, rowStart: 2 })
    expect(result.layouts.d!.item.grid).toEqual({ columnStart: 2, rowStart: 2 })
  })
})

describe('to Freeform and no-ops', () => {
  it('children leave the flow at their measured place inside the padding edge; flex fields clear; unmeasured children stay', () => {
    // Container (100, 100) with a 1 px border: padding edge (101, 101). a at (130, 130): left 29, top 29.
    const result = convert({
      container: node('f', { item: { position: flow }, container: { display: 'flex', gap: 4, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } }),
      children: [node('a', { item: { position: flow, flex: { grow: 1 }, width: { value: px(50) } } }), node('b')],
      measured: { container: { x: 100, y: 100, width: 300, height: 200 }, border: { top: 1, right: 1, bottom: 1, left: 1 }, children: { a: { x: 130, y: 130, width: 50, height: 20 } } },
      to: 'freeform',
    })
    expect(result.layouts.f!.container).toEqual({ display: 'freeform' })
    expect(result.layouts.a).toEqual({ item: { position: { mode: 'absolute', left: px(29), top: px(29) }, width: { value: px(50) } } })
    expect(result.layouts.b).toEqual({ item: { position: flow } })
    expect(result.unsupported).toBe('Some children have no measured position')
  })

  it('converting to the current display writes nothing', () => {
    expect(convert({ container: node('f', { item: { position: flow }, container: { display: 'block' } }), to: 'block' })).toEqual({ layouts: {} })
    // A node without a container record is Freeform.
    expect(convert({ container: node('f'), to: 'freeform' })).toEqual({ layouts: {} })
  })
})
