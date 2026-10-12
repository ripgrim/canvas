import { describe, expect, it } from 'vitest'
import { planPaperAddSizing, reconcilePaperSizing, snapshotPaperSizing } from '../src/paper-sizing.js'
import type { PaperSizingCapabilities, PaperSizingSnapshot } from '../src/paper-sizing.js'
import type { NodeLayout } from '../src/layout.js'
import { legacyTextStyle } from '../src/text.js'

const all: PaperSizingCapabilities = {
  width: { fit: true, fill: true, relative: true, constrained: true },
  height: { fit: true, fill: true, relative: true, constrained: true },
}
const measured = (width: number, height: number) => ({ width, height })
const layout = (position: NodeLayout['item']['position'], width?: NodeLayout['item']['width'], height?: NodeLayout['item']['height']): NodeLayout => ({
  item: { position, ...(width ? { width } : {}), ...(height ? { height } : {}) },
})
const primitive = (nodeId: string, source: NodeLayout | null, size = measured(64, 32), actual = size) => snapshotPaperSizing({ nodeId, kind: 'primitive', layout: source, styles: size, measured: actual })
const component = (nodeId: string, source: NodeLayout | null, actual: { width: number; height: number }) => snapshotPaperSizing({ nodeId, kind: 'component', layout: source, measured: actual })
const text = (nodeId: string, sizing: { width: { mode: 'fixed' | 'fit' | 'fill' } | { mode: 'relative'; value: number }; height: { mode: 'fixed' | 'fit' | 'fill' } | { mode: 'relative'; value: number } }, actual: { width: number; height: number }, resolvedLineHeight: number, source: NodeLayout = layout({ mode: 'freeform' }), editable = true, stored = actual) => snapshotPaperSizing({
  nodeId,
  kind: 'text',
  layout: source,
  styles: stored,
  textStyle: { ...legacyTextStyle, lineHeight: { ...legacyTextStyle.lineHeight } },
  textSizing: sizing,
  measured: actual,
  resolvedLineHeight,
  editable,
})
const transition = (snapshot: PaperSizingSnapshot, targetPosition: NodeLayout['item']['position'], display: 'freeform' | 'block' | 'flex' | 'grid' = 'freeform', flexDirection?: 'row' | 'column') => reconcilePaperSizing({
  operation: targetPosition.mode === 'flow' ? 'add' : 'remove',
  snapshot,
  targetPosition,
  targetParent: { display, ...(flexDirection ? { flexDirection } : {}) },
  capabilities: all,
})

describe('PAPER-FLEX-003 Paper sizing snapshots and transitions', () => {
  it('01 bakes a primitive Fill width to the measured fixed style across layout families', () => {
    const source = primitive('box', layout({ mode: 'flow' }, { value: { kind: 'percent', value: 100 } }), measured(20, 30), measured(137, 30))
    expect(source.axes.width.intent).toBe('fill')
    expect(transition(source, { mode: 'freeform' })).toStrictEqual({
      nodeId: 'box',
      layout: { item: { position: { mode: 'freeform' } } },
      styles: { width: 137, height: 30 },
    })
  })

  it('02 bakes a component Relative 40 percent width to a 96px fixed axis', () => {
    const source = component('card', layout({ mode: 'flow' }, { value: { kind: 'percent', value: 40 } }), measured(96, 48))
    expect(transition(source, { mode: 'absolute', left: { kind: 'px', value: 8 }, top: { kind: 'px', value: 12 } })).toStrictEqual({
      nodeId: 'card',
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 8 }, top: { kind: 'px', value: 12 } }, width: { value: { kind: 'px', value: 96 } }, height: { value: { kind: 'px', value: 48 } } } },
    })
  })

  it('03 keeps an authored fixed primitive at 64 instead of replacing it with the measurement', () => {
    const source = primitive('fixed-box', layout({ mode: 'flow' }), measured(64, 32), measured(91, 32))
    expect(transition(source, { mode: 'freeform' })).toStrictEqual({ nodeId: 'fixed-box', layout: { item: { position: { mode: 'freeform' } } } })
  })

  it('04 converts editable dependent text height to Fit', () => {
    const source = text('editable', { width: { mode: 'fixed' }, height: { mode: 'fill' } }, measured(120, 48), 24)
    expect(transition(source, { mode: 'flow' }, 'flex', 'column')).toStrictEqual({
      nodeId: 'editable',
      layout: { item: { position: { mode: 'flow' } } },
      textProperties: {
        textStyle: { ...legacyTextStyle, lineHeight: { ...legacyTextStyle.lineHeight } },
        textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } },
      },
    })
  })

  it('05 keeps intrinsic single-line text width Fit when changing family', () => {
    const source = text('single', { width: { mode: 'fit' }, height: { mode: 'fit' } }, measured(88, 20), 20)
    expect(transition(source, { mode: 'flow' }, 'flex', 'row')).toStrictEqual({ nodeId: 'single', layout: { item: { position: { mode: 'flow' } } } })
  })

  it('06 uses the strict greater-than multiline threshold at exactly 1.5', () => {
    expect(text('threshold', { width: { mode: 'fit' }, height: { mode: 'fit' } }, measured(90, 30), 20).text).toStrictEqual({ editable: true, multiline: false })
  })

  it('07 classifies 1.5001 lines as multiline', () => {
    expect(text('over-threshold', { width: { mode: 'fit' }, height: { mode: 'fit' } }, measured(90, 30.002), 20).text).toStrictEqual({ editable: true, multiline: true })
  })

  it('08 converts intrinsic multiline text width to Fill under column Flex', () => {
    const source = text('column-copy', { width: { mode: 'fit' }, height: { mode: 'fit' } }, measured(172, 42), 20)
    expect(transition(source, { mode: 'flow' }, 'flex', 'column')).toStrictEqual({
      nodeId: 'column-copy',
      layout: { item: { position: { mode: 'flow' } } },
      textProperties: { textStyle: { ...legacyTextStyle, lineHeight: { ...legacyTextStyle.lineHeight } }, textSizing: { width: { mode: 'fill' }, height: { mode: 'fit' } } },
    })
  })

  it('converts intrinsic multiline text width to Fill under Block', () => {
    const source = text('block-copy', { width: { mode: 'fit' }, height: { mode: 'fit' } }, measured(172, 42), 20)
    expect(transition(source, { mode: 'flow' }, 'block')).toStrictEqual({
      nodeId: 'block-copy',
      layout: { item: { position: { mode: 'flow' } } },
      textProperties: { textStyle: { ...legacyTextStyle, lineHeight: { ...legacyTextStyle.lineHeight } }, textSizing: { width: { mode: 'fill' }, height: { mode: 'fit' } } },
    })
  })

  it('09 converts the same multiline width to measured fixed under row Flex', () => {
    const source = text('row-copy', { width: { mode: 'fit' }, height: { mode: 'fit' } }, measured(172, 42), 20, layout({ mode: 'freeform' }), true, measured(60, 42))
    expect(transition(source, { mode: 'flow' }, 'flex', 'row')).toStrictEqual({
      nodeId: 'row-copy',
      layout: { item: { position: { mode: 'flow' } } },
      styles: { width: 172, height: 42 },
      textProperties: { textStyle: { ...legacyTextStyle, lineHeight: { ...legacyTextStyle.lineHeight } }, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } },
    })
  })

  it('10 never resurrects Fill when an absolute child enters flow', () => {
    const source = primitive('absolute-fill', layout({ mode: 'absolute', left: { kind: 'px', value: 2 }, top: { kind: 'px', value: 6 }, zIndex: 9 }, { value: { kind: 'percent', value: 100 } }), measured(50, 20), measured(111, 20))
    expect(transition(source, { mode: 'flow' }, 'flex', 'column')).toStrictEqual({
      nodeId: 'absolute-fill',
      layout: { item: { position: { mode: 'flow' } } },
      styles: { width: 111, height: 20 },
    })
  })

  it('bakes prior Relative when an absolute child enters flow', () => {
    const source = component('absolute-relative', layout({ mode: 'absolute', left: { kind: 'px', value: 2 }, top: { kind: 'px', value: 6 } }, { value: { kind: 'percent', value: 40 } }), measured(96, 24))
    expect(transition(source, { mode: 'flow' }, 'block')).toStrictEqual({
      nodeId: 'absolute-relative',
      layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'px', value: 96 } }, height: { value: { kind: 'px', value: 24 } } } },
    })
  })

  it('bakes constrained absolute sizing and clears opposing insets and bounds', () => {
    const source = component('absolute-constrained', layout(
      { mode: 'absolute', left: { kind: 'px', value: 2 }, right: { kind: 'px', value: 4 }, top: { kind: 'px', value: 6 }, bottom: { kind: 'px', value: 8 }, zIndex: 3 },
      { value: { kind: 'percent', value: 40 }, min: { kind: 'px', value: 20 }, max: { kind: 'px', value: 200 } },
      { value: { kind: 'percent', value: 50 }, min: { kind: 'px', value: 10 }, max: { kind: 'px', value: 80 } },
    ), measured(140, 60))
    expect(transition(source, { mode: 'flow' }, 'block')).toStrictEqual({
      nodeId: 'absolute-constrained',
      layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'px', value: 140 } }, height: { value: { kind: 'px', value: 60 } } } },
    })
  })

  it('distinguishes exact 100 percent Fill from 99 percent Relative', () => {
    expect(primitive('fill', layout({ mode: 'flow' }, { value: { kind: 'percent', value: 100 } })).axes.width.intent).toBe('fill')
    expect(primitive('relative', layout({ mode: 'flow' }, { value: { kind: 'percent', value: 99 } })).axes.width).toMatchObject({ intent: 'relative', relativeValue: 99 })
  })

  it('enforces the layout Relative domain before emitting primitive or component targets', () => {
    const box = primitive('box', layout({ mode: 'flow' }))
    const card = component('card', layout({ mode: 'flow' }), measured(80, 40))
    const run = (snapshot: PaperSizingSnapshot, value: number) => reconcilePaperSizing({
      operation: 'add', snapshot, targetPosition: { mode: 'flow' }, targetParent: { display: 'block' }, capabilities: all,
      overrides: { width: { intent: 'relative', relativeValue: value } },
    })
    expect(() => run(box, -1)).toThrow('0 up to but excluding 100')
    expect(() => run(card, 101)).toThrow('0 up to but excluding 100')
    expect(() => run(card, 100)).toThrow('0 up to but excluding 100')
    expect(run(box, 0).layout.item.width).toStrictEqual({ value: { kind: 'percent', value: 0 } })
    expect(run(box, 99).layout.item.width).toStrictEqual({ value: { kind: 'percent', value: 99 } })
  })

  it('uses the authoritative text Relative domain instead of the layout percentage domain', () => {
    const copy = text('copy', { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, measured(80, 20), 20, layout({ mode: 'flow' }))
    const run = (value: number) => reconcilePaperSizing({
      operation: 'add', snapshot: copy, targetPosition: { mode: 'flow' }, targetParent: { display: 'block' }, capabilities: all,
      overrides: { width: { intent: 'relative', relativeValue: value } },
    })
    expect(() => run(-1)).toThrow('authoritative text domain')
    expect(run(99).textProperties?.textSizing.width).toStrictEqual({ mode: 'relative', value: 99 })
    expect(run(100).textProperties?.textSizing.width).toStrictEqual({ mode: 'relative', value: 100 })
    expect(run(101).textProperties?.textSizing.width).toStrictEqual({ mode: 'relative', value: 101 })
  })

  it('rejects unsupported explicit overrides before target emission', () => {
    const source = component('card', layout({ mode: 'flow' }), measured(80, 40))
    expect(() => reconcilePaperSizing({
      operation: 'add', snapshot: source, targetPosition: { mode: 'flow' }, targetParent: { display: 'block' },
      capabilities: { ...all, width: { ...all.width, relative: false } },
      overrides: { width: { intent: 'relative', relativeValue: 99 } },
    })).toThrow('override is unsupported')
  })

  it('rejects an invalid manually supplied snapshot before target emission', () => {
    const source = component('card', layout({ mode: 'flow' }, { value: { kind: 'percent', value: 99 } }), measured(80, 40))
    const invalid = structuredClone(source)
    invalid.axes.width.relativeValue = 101
    expect(() => transition(invalid, { mode: 'flow' }, 'block')).toThrow('0 up to but excluding 100')
  })

  it('fails when editable dependent text requires Fit height but Fit is unavailable', () => {
    const source = text('copy', { width: { mode: 'fixed' }, height: { mode: 'fill' } }, measured(80, 40), 20)
    expect(() => reconcilePaperSizing({
      operation: 'add', snapshot: source, targetPosition: { mode: 'flow' }, targetParent: { display: 'block' },
      capabilities: { ...all, height: { ...all.height, fit: false } },
    })).toThrow('Editable text requires Fit height')
  })

  it('falls back to measured fixed for a valid source intent unsupported by the target', () => {
    const source = component('relative-card', layout({ mode: 'flow' }, { value: { kind: 'percent', value: 40 } }), measured(96, 40))
    const target = reconcilePaperSizing({
      operation: 'add', snapshot: source, targetPosition: { mode: 'flow' }, targetParent: { display: 'block' },
      capabilities: { ...all, width: { ...all.width, relative: false } },
    })
    expect(target.layout.item.width).toStrictEqual({ value: { kind: 'px', value: 96 } })
  })

  it('clears insets, z-index, Flex fields, and Grid self-alignment outside their valid target parent', () => {
    const sourceLayout: NodeLayout = { item: {
      position: { mode: 'absolute', left: { kind: 'px', value: 1 }, right: { kind: 'px', value: 2 }, top: { kind: 'px', value: 3 }, bottom: { kind: 'px', value: 4 }, zIndex: 7 },
      flex: { grow: 1, shrink: 0 },
      grid: { columnStart: 2, justifySelf: 'end', alignSelf: 'center' },
    } }
    expect(transition(primitive('stale', sourceLayout, measured(40, 20)), { mode: 'flow' }, 'block').layout).toStrictEqual({ item: { position: { mode: 'flow' } } })
  })

  it('preserves Fit only when supported and otherwise bakes the measurement', () => {
    const source = component('hug', layout({ mode: 'flow' }, { value: { kind: 'intrinsic', value: 'fit-content' } }), measured(77, 22))
    const target = reconcilePaperSizing({ operation: 'add', snapshot: source, targetPosition: { mode: 'flow' }, targetParent: { display: 'block' }, capabilities: { ...all, width: { ...all.width, fit: false } } })
    expect(target.layout.item.width).toStrictEqual({ value: { kind: 'px', value: 77 } })
  })

  it('bakes constrained sizing across families and unpins a fixed absolute axis', () => {
    const constrained = component('pinned', layout({ mode: 'absolute', left: { kind: 'px', value: 4 }, right: { kind: 'px', value: 8 } }), measured(140, 30))
    expect(constrained.axes.width.intent).toBe('constrained')
    expect(transition(constrained, { mode: 'flow' }, 'block').layout.item.width).toStrictEqual({ value: { kind: 'px', value: 140 } })

    const fixed = component('fixed', layout({ mode: 'absolute', left: { kind: 'px', value: 4 } }, { value: { kind: 'px', value: 64 } }), measured(64, 30))
    expect(transition(fixed, { mode: 'absolute', left: { kind: 'px', value: 4 }, right: { kind: 'px', value: 8 } }).layout.item.position).toStrictEqual({ mode: 'absolute', left: { kind: 'px', value: 4 } })
  })

  it('fails closed on invalid measurements and line metrics', () => {
    expect(() => primitive('bad', null, measured(30, 20), measured(Number.NaN, 20))).toThrow('positive finite measurements')
    expect(() => text('bad-line', { width: { mode: 'fit' }, height: { mode: 'fit' } }, measured(30, 20), 0)).toThrow('positive finite resolved line height')
  })

  it('does not mutate snapshot, transition, or plan inputs on success or failure', () => {
    const assertUnchanged = <T>(value: T, action: () => unknown, fails = false) => {
      const deep = structuredClone(value)
      const bytes = JSON.stringify(value)
      if (fails) expect(action).toThrow()
      else action()
      expect(value).toStrictEqual(deep)
      expect(JSON.stringify(value)).toBe(bytes)
    }

    const snapshotInput = { nodeId: 'pure-box', kind: 'primitive' as const, layout: layout({ mode: 'flow' }, { value: { kind: 'percent' as const, value: 40 } }), styles: measured(60, 20), measured: measured(96, 20) }
    assertUnchanged(snapshotInput, () => snapshotPaperSizing(snapshotInput))
    const badSnapshotInput = { ...snapshotInput, measured: measured(Number.NaN, 20) }
    assertUnchanged(badSnapshotInput, () => snapshotPaperSizing(badSnapshotInput), true)

    const snapshot = snapshotPaperSizing(snapshotInput)
    const success = { operation: 'remove' as const, snapshot, targetPosition: { mode: 'freeform' as const }, targetParent: { display: 'freeform' as const }, capabilities: all }
    assertUnchanged(success, () => reconcilePaperSizing(success))
    const failure = { ...success, targetPosition: { mode: 'flow' as const }, targetParent: { display: 'block' as const }, overrides: { width: { intent: 'relative' as const, relativeValue: 101 } } }
    assertUnchanged(failure, () => reconcilePaperSizing(failure), true)

    const planSuccess = { parent: primitive('parent', null, measured(200, 100)), direction: 'row' as const, inferred: measured(180, 80), parentIsFlexChild: false, parentCapabilities: all, children: [{ snapshot: primitive('child', null, measured(40, 20)), capabilities: all }] }
    assertUnchanged(planSuccess, () => planPaperAddSizing(planSuccess))
    const noFill = { ...all, width: { ...all.width, fill: false } }
    const planFailure = { ...planSuccess, direction: 'column' as const, children: [{ snapshot: primitive('child', null, measured(40, 20)), capabilities: noFill }] }
    assertUnchanged(planFailure, () => planPaperAddSizing(planFailure), true)
  })
})

describe('PAPER-FLEX-003 Add-parent sizing', () => {
  const child = (nodeId: string, width: number, source: NodeLayout | null = null) => ({ snapshot: primitive(nodeId, source, measured(width, 20), measured(width, 20)), capabilities: all })

  it('11 turns fixed row parent width and fixed height into Fit', () => {
    const result = planPaperAddSizing({ parent: primitive('parent', layout({ mode: 'freeform' }), measured(240, 120)), direction: 'row', inferred: measured(208, 64), parentIsFlexChild: false, parentCapabilities: all, children: [child('one', 40)] })
    expect(result.parentAxes).toStrictEqual({
      width: { intent: 'fit', stored: { value: { kind: 'intrinsic', value: 'fit-content' } } },
      height: { intent: 'fit', stored: { value: { kind: 'intrinsic', value: 'fit-content' } } },
    })
  })

  it('12 keeps inferred fixed width for a fixed column parent while height becomes Fit', () => {
    const result = planPaperAddSizing({ parent: primitive('parent', null, measured(240, 120)), direction: 'column', inferred: measured(208, 64), parentIsFlexChild: false, parentCapabilities: all, children: [child('one', 40)] })
    expect(result.parentAxes).toStrictEqual({
      width: { intent: 'fixed', fixedPx: 208 },
      height: { intent: 'fit', stored: { value: { kind: 'intrinsic', value: 'fit-content' } } },
    })
  })

  it('kills the row-column swap mutant with opposite literal width decisions', () => {
    const parent = primitive('parent', null, measured(240, 120))
    const base = { parent, inferred: measured(208, 64), parentIsFlexChild: false, parentCapabilities: all, children: [child('one', 40)] }
    expect(planPaperAddSizing({ ...base, direction: 'row' }).parentAxes.width.intent).toBe('fit')
    expect(planPaperAddSizing({ ...base, direction: 'column' }).parentAxes.width).toStrictEqual({ intent: 'fixed', fixedPx: 208 })
  })

  it('13 transfers one dependent Relative intent to an auto parent and makes that child Fill', () => {
    const parent = component('parent', layout({ mode: 'flow' }), measured(240, 120))
    const dependentChild = child('dependent', 96, layout({ mode: 'flow' }, { value: { kind: 'percent', value: 40 } }))
    const result = planPaperAddSizing({ parent, direction: 'row', inferred: measured(200, 80), parentIsFlexChild: false, parentCapabilities: all, children: [dependentChild] })
    expect(result.parentAxes.width).toStrictEqual({ intent: 'relative', stored: { value: { kind: 'percent', value: 40 } }, relativeValue: 40 })
    expect(result.childAxes).toStrictEqual([{ nodeId: 'dependent', axes: { width: { intent: 'fill', stored: { value: { kind: 'percent', value: 100 } } } } }])
  })

  it('14 uses inferred fixed bounds for multiple dependent children', () => {
    const parent = component('parent', layout({ mode: 'flow' }), measured(240, 120))
    const children = [
      child('fill', 120, layout({ mode: 'flow' }, { value: { kind: 'percent', value: 100 } })),
      child('relative', 80, layout({ mode: 'flow' }, { value: { kind: 'percent', value: 50 } })),
    ]
    const result = planPaperAddSizing({ parent, direction: 'row', inferred: measured(222, 66), parentIsFlexChild: false, parentCapabilities: all, children })
    expect(result.parentAxes.width).toStrictEqual({ intent: 'fixed', fixedPx: 222 })
    expect(result.childAxes).toStrictEqual([{ nodeId: 'fill', axes: {} }, { nodeId: 'relative', axes: {} }])
  })

  it('15 marks every greatest rounded-width tie Fill in a fixed-width column', () => {
    const result = planPaperAddSizing({
      parent: primitive('parent', null, measured(240, 120)),
      direction: 'column',
      inferred: measured(101, 80),
      parentIsFlexChild: false,
      parentCapabilities: all,
      children: [child('tie-a', 100.49), child('tie-b', 100.4), child('narrow', 99.4)],
    })
    expect(result.childAxes).toStrictEqual([
      { nodeId: 'tie-a', axes: { width: { intent: 'fill', stored: { value: { kind: 'percent', value: 100 } } } } },
      { nodeId: 'tie-b', axes: { width: { intent: 'fill', stored: { value: { kind: 'percent', value: 100 } } } } },
      { nodeId: 'narrow', axes: {} },
    ])
  })

  it('makes an auto axis Fit without dependents and Fill when the parent is itself a Flex child', () => {
    const parent = component('parent', layout({ mode: 'flow' }), measured(240, 120))
    const base = { parent, direction: 'row' as const, inferred: measured(200, 80), parentCapabilities: all, children: [child('fixed', 60)] }
    expect(planPaperAddSizing({ ...base, parentIsFlexChild: false }).parentAxes.width.intent).toBe('fit')
    expect(planPaperAddSizing({ ...base, parentIsFlexChild: true }).parentAxes.width).toStrictEqual({ intent: 'fill', stored: { value: { kind: 'percent', value: 100 } } })
  })

  it('fails closed when Add requires unavailable parent or widest-child sizing', () => {
    const fixedParent = primitive('fixed-parent', null, measured(240, 120))
    const noFit = { ...all, width: { ...all.width, fit: false } }
    expect(() => planPaperAddSizing({ parent: fixedParent, direction: 'row', inferred: measured(200, 80), parentIsFlexChild: false, parentCapabilities: noFit, children: [child('one', 40)] })).toThrow('requires Fit width')

    const autoParent = component('auto-parent', layout({ mode: 'flow' }), measured(240, 120))
    const noFill = { ...all, width: { ...all.width, fill: false } }
    expect(() => planPaperAddSizing({ parent: autoParent, direction: 'row', inferred: measured(200, 80), parentIsFlexChild: true, parentCapabilities: noFill, children: [child('one', 40)] })).toThrow('requires Fill width')

    expect(() => planPaperAddSizing({ parent: fixedParent, direction: 'column', inferred: measured(200, 80), parentIsFlexChild: false, parentCapabilities: all, children: [{ snapshot: primitive('widest', null, measured(100, 20)), capabilities: noFill }] })).toThrow('widest column child cannot become Fill width')
  })
})
