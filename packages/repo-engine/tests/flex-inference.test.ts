import { describe, expect, it } from 'vitest'
import { inferFlexLayout } from '../src/flex-inference.js'
import type { Rect } from '../src/flex-inference.js'

const box = (id: string, x: number, y: number, width: number, height: number): { id: string } & Rect => ({ id, x, y, width, height })
const gapReason = 'Adjacent gaps differ by more than 2 px'
const wrapReason = 'Children wrap onto more than one line'

describe('freeform to flex inference', () => {
  it('LAY-FLEX-005: an evenly spaced row with symmetric cross insets is a stretch row', () => {
    // Children span x 32..364, y 40..80 in a 400x120 box. Gaps: 148 - 132 = 16, 264 - 248 = 16.
    // insetX = min(32, 400 - 364 = 36) = 32; insetY = min(40, 120 - 80 = 40) = 40.
    // Main: inner start 32, inner size 336, content 332 at 32 -> start 0, center (32 - 34)^2 = 4, end (32 - 36)^2 = 16.
    // Cross: inner size 120 - 80 = 40 equals every child height at the inner start, so the stretch rule applies.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 120 }, children: [box('c', 264, 40, 100, 40), box('a', 32, 40, 100, 40), box('b', 148, 40, 100, 40)] })
    expect(result).toEqual({ direction: 'row', wrap: 'nowrap', gap: 16, justify: 'start', align: 'stretch', padding: { x: 32, y: 40 }, order: ['a', 'b', 'c'], lines: 1, reproducible: true, reasons: [] })
  })

  it('LAY-FLEX-005: the same row in a 140 px tall container aligns to the cross start', () => {
    // insetY = min(40, 140 - 80 = 60) = 40; inner cross size 140 - 80 = 60, children 40 tall at y 40.
    // Errors: start |40 - 40| = 0, center 40 + 10 = 50 -> 10, end 40 + 20 = 60 -> 20.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 140 }, children: [box('a', 32, 40, 100, 40), box('b', 148, 40, 100, 40), box('c', 264, 40, 100, 40)] })
    expect(result).toEqual({ direction: 'row', wrap: 'nowrap', gap: 16, justify: 'start', align: 'start', padding: { x: 32, y: 40 }, order: ['a', 'b', 'c'], lines: 1, reproducible: true, reasons: [] })
  })

  it('LAY-FLEX-005: column gaps 12, 12, 13 share one 4 px bucket and average to 12', () => {
    // y ranges: 20..40, 52..72, 84..104, 117..137 -> gaps 12, 12, 13; average 37 / 3 = 12.33 -> 12.
    // Each raw gap is within 2 px of 12.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 200, height: 300 }, children: [box('a', 48, 20, 100, 20), box('b', 48, 52, 100, 20), box('c', 48, 84, 100, 20), box('d', 48, 117, 100, 20)] })
    expect(result?.direction).toBe('column')
    expect(result?.gap).toBe(12)
    expect(result?.order).toEqual(['a', 'b', 'c', 'd'])
    expect(result?.reproducible).toBe(true)
    expect(result?.reasons).toEqual([])
  })

  it('LAY-FLEX-005 negative: column gaps 8 and 24 are not reproducible', () => {
    // y ranges: 20..40, 48..68, 92..112 -> gaps 8 and 24, which differ by 16.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 200, height: 300 }, children: [box('a', 48, 20, 100, 20), box('b', 48, 48, 100, 20), box('c', 48, 92, 100, 20)] })
    expect(result?.direction).toBe('column')
    expect(result?.reproducible).toBe(false)
    expect(result?.reasons).toContain(gapReason)
  })

  it('LAY-FLEX-005: raw gaps under 2 px (1 and 0) collapse to gap 0', () => {
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 100, height: 40 }, children: [box('a', 0, 10, 10, 20), box('b', 11, 10, 10, 20), box('c', 21, 10, 10, 20)] })
    expect(result?.direction).toBe('row')
    expect(result?.gap).toBe(0)
    expect(result?.reasons).not.toContain(gapReason)
  })

  it('LAY-FLEX-005: centered content justifies center', () => {
    // Content 40 + 10 + 40 + 10 + 40 = 140 wide at x 130..270 in 400: insets 130 and 130.
    // padding x = round(130 / 4) * 4 = 132; inner start 132, inner size 400 - 264 = 136.
    // start (130 - 132)^2 = 4; center 132 + (136 - 140) / 2 = 130 -> 0; end 132 + 136 - 140 = 128 -> 4.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 100 }, children: [box('a', 130, 30, 40, 40), box('b', 180, 30, 40, 40), box('c', 230, 30, 40, 40)] })
    expect(result?.justify).toBe('center')
  })

  it('LAY-FLEX-005: right-aligned content justifies end', () => {
    // Content 144 wide at x 224..368 in 400: insetX = min(224, 32) = 32; inner start 32, inner size 336.
    // start (224 - 32)^2, center 32 + 96 = 128 -> 96^2, end 32 + 336 - 144 = 224 -> 0.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 100 }, children: [box('a', 224, 30, 40, 40), box('b', 276, 30, 40, 40), box('c', 328, 30, 40, 40)] })
    expect(result?.justify).toBe('end')
  })

  it('LAY-FLEX-005: children filling the inner cross size within 2 px stretch', () => {
    // Heights 60, 61, 60 at y 20 in a 100 px tall box: insetY = min(20, 100 - 81 = 19) = 19 -> padding 20.
    // Inner cross size 100 - 40 = 60; |61 - 60| = 1 is within tolerance and every child starts at 20.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 100 }, children: [box('a', 20, 20, 40, 60), box('b', 72, 20, 40, 61), box('c', 124, 20, 40, 60)] })
    expect(result?.align).toBe('stretch')
  })

  it('LAY-FLEX-005 negative: a child 4 px short of the inner cross size prevents stretch', () => {
    // Heights 60, 60, 56 at y 20: padding 20, inner 60; |56 - 60| = 4 > 2. All start at 20, so start error is 0.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 100 }, children: [box('a', 20, 20, 40, 60), box('b', 72, 20, 40, 60), box('c', 124, 20, 40, 56)] })
    expect(result?.align).toBe('start')
  })

  it('LAY-FLEX-005: children of different heights sharing a vertical center align center', () => {
    // Heights 20, 40, 60 centered on y 60: y 50, 40, 30. insetY = min(30, 30) = 30 -> padding 32, inner 56.
    // center expects 32 + (56 - h) / 2 = 50, 40, 30 -> error 0; start and end both average 28 / 3.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 120 }, children: [box('a', 32, 50, 40, 20), box('b', 84, 40, 40, 40), box('c', 136, 30, 40, 60)] })
    expect(result?.direction).toBe('row')
    expect(result?.align).toBe('center')
  })

  it('LAY-FLEX-005: two visual lines are reported as wrapping and ordered line by line', () => {
    // Line 1 at y 32..72: a, b, c at x 32, 84, 136. Line 2 at y 84..124: d, e at x 32, 84.
    // Center spread: x 52..156 = 104, y 52..104 = 52, so row. Line 2 does not overlap line 1 on the cross axis.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 200 }, children: [box('e', 84, 84, 40, 40), box('c', 136, 32, 40, 40), box('a', 32, 32, 40, 40), box('d', 32, 84, 40, 40), box('b', 84, 32, 40, 40)] })
    expect(result?.direction).toBe('row')
    expect(result?.lines).toBe(2)
    expect(result?.reproducible).toBe(false)
    expect(result?.reasons).toContain(wrapReason)
    expect(result?.order).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('LAY-FLEX-005: zero-size children are ignored and an empty input yields null', () => {
    // Without the ignore rule, the 0x40 child at x 0 would make insetX 0 instead of 32.
    const result = inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 120 }, children: [box('z', 0, 0, 0, 40), box('a', 32, 40, 100, 40), box('w', 380, 0, 10, 0), box('b', 148, 40, 100, 40), box('c', 264, 40, 100, 40)] })
    expect(result?.order).toEqual(['a', 'b', 'c'])
    expect(result?.padding).toEqual({ x: 32, y: 40 })
    expect(inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 120 }, children: [] })).toBeNull()
    expect(inferFlexLayout({ container: { x: 0, y: 0, width: 400, height: 120 }, children: [box('z', 10, 10, 0, 0)] })).toBeNull()
  })

  it('LAY-FLEX-005: direction is column when the vertical center spread exceeds the horizontal one', () => {
    // Centers (20, 20) and (30, 120): spread x 10, y 100.
    const column = inferFlexLayout({ container: { x: 0, y: 0, width: 200, height: 200 }, children: [box('a', 0, 0, 40, 40), box('b', 10, 100, 40, 40)] })
    expect(column?.direction).toBe('column')
    expect(column?.order).toEqual(['a', 'b'])
    // Negative control: centers (20, 20) and (70, 70) spread equally, and a tie picks row.
    const tie = inferFlexLayout({ container: { x: 0, y: 0, width: 200, height: 200 }, children: [box('a', 0, 0, 40, 40), box('b', 50, 50, 40, 40)] })
    expect(tie?.direction).toBe('row')
  })
})
