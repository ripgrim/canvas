import { describe, expect, it } from 'vitest'
import { flowInsertIndex } from './canvas-math'
import type { Rect } from './canvas-math'
import { flexInsertIndex, measuredFlexInsertIndex } from './flex-reorder'

// LAY-GEST-005 (Flex part): hand-drawn sibling boxes, pointer positions, and the expected drop. `index` is a gap in
// the full document-ordered sibling list (dragged node included): 0 is before the first sibling, n after the last.
const box = (x: number, y: number, width = 100, height = 40): Rect => ({ x, y, width, height })
const list = (entries: Record<string, Rect>) => Object.entries(entries).map(([id, rect]) => ({ id, rect }))

describe('LAY-GEST-005: Flex reorder targets', () => {
  // row, nowrap. Document order a b c.
  //   x: 0      100 110    210 220    320
  //      [  a  ]    [  b  ]    [  c  ]      y 0..40
  const row = list({ a: box(0, 0), b: box(110, 0), c: box(220, 0) })

  it('three in a row: the pointer between b and c drops a before c (gap 2); past c is gap 3; before everything is gap 0', () => {
    // Centers: b 160, c 270. Pointer x 170: b is before it, c is not -> before c -> gap at c's document index 2.
    // Guide: b ends at 210, c starts at 220 -> 215, spanning the line's y 0..40.
    expect(flexInsertIndex({ x: 170, y: 20 }, row, 'a', 'row', 'nowrap')).toEqual({ index: 2, line: 0, guide: { axis: 'x', position: 215, start: 0, end: 40 } })
    expect(flexInsertIndex({ x: 300, y: 20 }, row, 'a', 'row', 'nowrap').index).toBe(3)
    expect(flexInsertIndex({ x: -10, y: 20 }, row, 'c', 'row', 'nowrap').index).toBe(0)
  })

  // row, wrap. Document order a b c d e; the container is 330 wide, so d and e wrap.
  //   [  a  ] [  b  ] [  c  ]   y 0..40   (x 0, 110, 220)
  //   [  d  ] [  e  ]           y 50..90  (x 0, 110)
  const wrapped = list({ a: box(0, 0), b: box(110, 0), c: box(220, 0), d: box(0, 50), e: box(110, 50) })

  it('two wrapped lines: the pointer right of e on the second line drops after e (gap 5, line 1)', () => {
    // Line 2 holds d (center 50) and e (center 160); both are left of x 250 -> after e -> gap 4 + 1 = 5.
    // Guide: nothing to the right, so it sits at e's end 210, spanning line 2's y 50..90.
    expect(flexInsertIndex({ x: 250, y: 70 }, wrapped, 'a', 'row', 'wrap')).toEqual({ index: 5, line: 1, guide: { axis: 'x', position: 210, start: 50, end: 90 } })
    // Between d and e on line 2: before e -> gap 4.
    expect(flexInsertIndex({ x: 150, y: 60 }, wrapped, 'a', 'row', 'wrap')).toEqual({ index: 4, line: 1, guide: { axis: 'x', position: 105, start: 50, end: 90 } })
  })

  it('negative control: flowInsertIndex ignores lines and answers 3 for the same wrapped drop', () => {
    // Without a (dragged): centers x b 160, c 270, d 50, e 160; y 20, 20, 70, 70. Spread x 220 > spread y 50 -> axis x.
    // Centers left of x 250: b, d, e -> 3, which would land a between c and d instead of after e.
    expect(flowInsertIndex({ x: 250, y: 70 }, wrapped, 'a')).toEqual({ index: 3, axis: 'x' })
    expect(flexInsertIndex({ x: 250, y: 70 }, wrapped, 'a', 'row', 'wrap').index).not.toBe(3)
  })

  it('uses Paper visual lines for mixed primitive and component children and carries measurement authority', () => {
    const mixed = [
      { id: 'a', kind: 'frame', rect: box(0, 0) },
      { id: 'b', kind: 'component', rect: box(110, 0) },
      { id: 'c', kind: 'text', rect: box(220, 0) },
      { id: 'd', kind: 'rectangle', rect: box(0, 50) },
      { id: 'e', kind: 'component', rect: box(110, 50) },
    ] as const
    const result = measuredFlexInsertIndex({
      pointer: { x: 250, y: 70 }, draggedId: 'a', direction: 'row', wrap: 'wrap',
      expected: { measurementRevision: 41, documentRevision: 17, layoutGeneration: 9 },
      measurement: { measurementRevision: 41, documentRevision: 17, layoutGeneration: 9, siblings: mixed },
    })
    expect(result).toEqual({
      status: 'ready', authority: { measurementRevision: 41, documentRevision: 17, layoutGeneration: 9 },
      target: { index: 5, line: 1, guide: { axis: 'x', position: 210, start: 50, end: 90 } },
    })

    const applyGap = (ids: readonly string[], draggedId: string, gap: number) => {
      const withoutDragged = ids.filter(id => id !== draggedId)
      const insertion = gap > ids.indexOf(draggedId) ? gap - 1 : gap
      return [...withoutDragged.slice(0, insertion), draggedId, ...withoutDragged.slice(insertion)]
    }
    expect(applyGap(['a', 'b', 'c', 'd', 'e'], 'a', result.status === 'ready' ? result.target.index : -1)).toEqual(['b', 'c', 'd', 'e', 'a'])

    // Mutation control: generic dominant-axis ordering answers gap 3 and produces the wrong cross-line order.
    const mutatedGap = flowInsertIndex({ x: 250, y: 70 }, mixed, 'a').index
    expect(mutatedGap).toBe(3)
    expect(applyGap(['a', 'b', 'c', 'd', 'e'], 'a', mutatedGap)).toEqual(['b', 'c', 'a', 'd', 'e'])
    expect(applyGap(['a', 'b', 'c', 'd', 'e'], 'a', mutatedGap)).not.toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('rejects stale measurement, document, or layout authority before exposing an insertion target', () => {
    const actual = { measurementRevision: 41, documentRevision: 17, layoutGeneration: 9 }
    for (const expected of [
      { measurementRevision: 42, documentRevision: 17, layoutGeneration: 9 },
      { measurementRevision: 41, documentRevision: 18, layoutGeneration: 9 },
      { measurementRevision: 41, documentRevision: 17, layoutGeneration: 10 },
    ]) {
      expect(measuredFlexInsertIndex({
        pointer: { x: 250, y: 70 }, draggedId: 'a', direction: 'row', wrap: 'wrap', expected,
        measurement: { ...actual, siblings: wrapped },
      })).toEqual({ status: 'stale', expected, actual, target: null })
    }
  })

  it('keeps unequal and staggered children in their contiguous visual lines', () => {
    // First line: a is tall, b is 70 px lower, and c is short. Second line starts when the main axis wraps to x=0.
    const staggered = list({
      a: box(0, 0, 90, 80), b: box(100, 70, 120, 40), c: box(230, 80, 60, 20),
      d: box(0, 120, 140, 50), e: box(150, 135, 70, 25),
    })
    expect(flexInsertIndex({ x: 280, y: 85 }, staggered, 'd', 'row', 'wrap')).toMatchObject({ index: 3, line: 0 })
    expect(flexInsertIndex({ x: 190, y: 145 }, staggered, 'a', 'row', 'wrap')).toEqual({ index: 5, line: 1, guide: { axis: 'x', position: 220, start: 120, end: 170 } })

    // Mutation control: a fixed 50% overlap with the first child would split b from a despite the same main-axis run.
    const headOverlap = Math.min(80, 70 + 40) - Math.max(0, 70)
    expect(headOverlap).toBe(10)
    expect(headOverlap).toBeLessThan(0.5 * Math.min(80, 40))
    expect(staggered[2]!.rect.y).not.toBe(staggered[0]!.rect.y)
  })

  it('keeps the dragged child as cross-axis evidence while reconstructing its visual line', () => {
    // The dragged item bridges a and b into one contiguous line. Removing it before line reconstruction falsely
    // splits b into a second line and produces an insertion after b instead of before a.
    const bridged = list({
      a: box(0, 0, 20, 20), dragged: box(30, 0, 20, 100), b: box(60, 80, 20, 20), c: box(0, 110, 20, 20),
    })
    expect(flexInsertIndex({ x: 10, y: 80 }, bridged, 'dragged', 'row', 'wrap')).toEqual({
      index: 0,
      line: 0,
      guide: { axis: 'x', position: 40, start: 0, end: 100 },
    })

    // Mutation control: deleting the bridge first creates the false line and changes both the target and guide.
    const withoutBridgeGeometry = bridged.map(entry => entry.id === 'dragged' ? { ...entry, rect: box(30, 0, 0, 0) } : entry)
    expect(flexInsertIndex({ x: 10, y: 80 }, withoutBridgeGeometry, 'dragged', 'row', 'wrap')).toEqual({
      index: 2,
      line: 1,
      guide: { axis: 'x', position: 60, start: 80, end: 100 },
    })
  })

  // row-reverse, nowrap. Document order a b c shows right to left in a 320 wide container.
  //   [  c  ]    [  b  ]    [  a  ]       x c 0..100, b 110..210, a 220..320
  const reversed = list({ a: box(220, 0), b: box(110, 0), c: box(0, 0) })

  it('row-reverse: the visual right end is the document start, and a pointer between a and b drops before b', () => {
    // Pointer x 300: nothing is right of it in document terms (a's center 270 < 300) -> before a -> gap 0.
    expect(flexInsertIndex({ x: 300, y: 20 }, reversed, 'c', 'row-reverse', 'nowrap').index).toBe(0)
    // Pointer x 200: a (center 270) is past it in reverse order, b (center 160) is not -> before b -> gap 1.
    // Guide between b's end 210 and a's start 220 -> 215.
    expect(flexInsertIndex({ x: 200, y: 20 }, reversed, 'c', 'row-reverse', 'nowrap')).toEqual({ index: 1, line: 0, guide: { axis: 'x', position: 215, start: 0, end: 40 } })
    // Negative control: read as a plain row, x 300 is right of both centers (270 and 160) -> after b -> gap 2, not 0.
    expect(flexInsertIndex({ x: 300, y: 20 }, reversed, 'c', 'row', 'nowrap').index).toBe(2)
  })

  // column, nowrap. a y 0..40, b y 50..90, c y 100..140; all x 0..100.
  const column = list({ a: box(0, 0), b: box(0, 50), c: box(0, 100) })

  it('column: the main axis is vertical and the guide is horizontal', () => {
    // Pointer y 95: b's center 70 is above it, c's center 120 is below -> before c -> gap 2. Guide (90 + 100) / 2 = 95 across x 0..100.
    expect(flexInsertIndex({ x: 50, y: 95 }, column, 'a', 'column', 'nowrap')).toEqual({ index: 2, line: 0, guide: { axis: 'y', position: 95, start: 0, end: 100 } })
  })

  // row, wrap-reverse. The first document line (a b c) sits at the bottom, the second (d e) on top.
  //   [  d  ] [  e  ]           y 0..40
  //   [  a  ] [  b  ] [  c  ]   y 50..90
  const wrapReverse = list({ a: box(0, 50), b: box(110, 50), c: box(220, 50), d: box(0, 0), e: box(110, 0) })

  it('wrap-reverse: the bottom visual line is document line 0 and the top one is line 1', () => {
    // Pointer y 70 is inside the bottom line: a (50) and b (160) are left of x 250, c (270) is not -> before c -> gap 2.
    expect(flexInsertIndex({ x: 250, y: 70 }, wrapReverse, 'e', 'row', 'wrap-reverse')).toMatchObject({ index: 2, line: 0 })
    // Pointer y 10 is in the top line, which without e holds only d (50 < 250) -> after d -> gap 4 (e stays last).
    expect(flexInsertIndex({ x: 250, y: 10 }, wrapReverse, 'e', 'row', 'wrap-reverse')).toMatchObject({ index: 4, line: 1 })
  })

  it('siblings without bounds keep their document place but take no part in the geometry', () => {
    // a (0..100), x has no box, b (110..210). Pointer x 100 is left of b's center 160 -> before b -> gap 2 (x stays before it).
    const sparse = [{ id: 'a', rect: box(0, 0) }, { id: 'x', rect: { x: 0, y: 0, width: 0, height: 0 } }, { id: 'b', rect: box(110, 0) }]
    expect(flexInsertIndex({ x: 100, y: 20 }, sparse, 'a', 'row', 'nowrap').index).toBe(2)
    expect(flexInsertIndex({ x: 300, y: 20 }, sparse, 'a', 'row', 'nowrap').index).toBe(3)
    // Only the dragged node: drop at the end with no guide.
    expect(flexInsertIndex({ x: 0, y: 0 }, [{ id: 'a', rect: box(0, 0) }], 'a', 'row', 'wrap')).toEqual({ index: 1, line: 0, guide: null })
  })
})
