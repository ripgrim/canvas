import { describe, expect, it } from 'vitest'
import { beginFlowDrag, beginPaperFlowDrag, clearPaperFlowDragClone, normalizeFlowDragModifiers, sampleFlowDrag, samplePaperFlowDrag, validFlowDragState } from './flow-drag-state'
import type { FlowDragState, FlowDragTarget, PaperFlowDragState } from './flow-drag-state'

const down = { x: 10, y: 20 }
const at = (state: FlowDragState, x: number, y: number, alt: boolean, primary: boolean) => sampleFlowDrag(state, { x, y }, { alt, primary })!

describe('Paper flow drag modifier history', () => {
  it('begins in flow mode with the original identity selected', () => {
    const state = beginFlowDrag('a', down)
    expect(state).toStrictEqual({ nodeId: 'a', pointerDownWorld: down, currentWorld: down, initialMode: 'flow', originalMode: 'flow', altActive: false, primaryActive: false, generation: 0, clone: null, selection: ['a'] })
    expect(validFlowDragState(state!)).toBe(true)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state!.selection)).toBe(true)
  })

  it('records the literal Alt-only, primary-only, and same-sample Alt-primary transitions', () => {
    const initial = beginFlowDrag('a', down)!
    expect(at(initial, 20, 30, true, false)).toMatchObject({ originalMode: 'flow', generation: 1, clone: { generation: 1, mode: 'flow', startedAtWorld: { x: 20, y: 30 } }, selection: ['a'] })
    expect(at(initial, 20, 30, false, true)).toMatchObject({ originalMode: 'absolute', generation: 0, clone: null, selection: ['a'] })
    expect(at(initial, 20, 30, true, true)).toMatchObject({ originalMode: 'absolute', generation: 1, clone: { generation: 1, mode: 'flow', startedAtWorld: { x: 20, y: 30 } }, selection: ['a'] })
  })

  it('captures an absolute clone when primary was already active before Alt', () => {
    const primary = at(beginFlowDrag('a', down)!, 20, 30, false, true)
    const alt = at(primary, 35, 45, true, true)
    expect(alt).toMatchObject({ originalMode: 'absolute', generation: 1, clone: { generation: 1, mode: 'absolute', startedAtWorld: { x: 35, y: 45 } }, selection: ['a'] })
  })

  it('keeps a flow clone when Alt preceded primary', () => {
    const alt = at(beginFlowDrag('a', down)!, 20, 30, true, false)
    const primary = at(alt, 35, 45, true, true)
    expect(primary).toMatchObject({ originalMode: 'absolute', generation: 1, clone: { generation: 1, mode: 'flow', startedAtWorld: { x: 20, y: 30 } }, selection: ['a'] })
  })

  it('primary release restores the original flow terminal and leaves the absolute clone descriptor unchanged', () => {
    const primary = at(beginFlowDrag('a', down)!, 20, 30, false, true)
    const alt = at(primary, 35, 45, true, true)
    const released = at(alt, 50, 60, true, false)
    expect(released).toMatchObject({ originalMode: 'flow', primaryActive: false, altActive: true, generation: 1, clone: { generation: 1, mode: 'absolute', startedAtWorld: { x: 35, y: 45 } }, selection: ['a'] })
  })

  it('Alt release clears its generation synchronously and a re-press creates an independent generation', () => {
    const first = at(beginFlowDrag('a', down)!, 20, 30, true, false)
    const released = at(first, 25, 35, false, false)
    expect(released).toMatchObject({ altActive: false, generation: 1, clone: null })
    const second = at(released, 40, 50, true, false)
    expect(second).toMatchObject({ altActive: true, generation: 2, clone: { generation: 2, mode: 'flow', startedAtWorld: { x: 40, y: 50 } }, selection: ['a'] })
  })

  it('supports repeated primary toggles without changing the clone generation or selected identity', () => {
    const alt = at(beginFlowDrag('a', down)!, 20, 30, true, false)
    const primary = at(alt, 30, 40, true, true)
    const flow = at(primary, 40, 50, true, false)
    const primaryAgain = at(flow, 50, 60, true, true)
    expect(primaryAgain).toMatchObject({ originalMode: 'absolute', generation: 1, clone: { generation: 1, mode: 'flow', startedAtWorld: { x: 20, y: 30 } }, selection: ['a'] })
  })

  it('detects the reversed edge-order mutation for a same-sample Alt-primary transition', () => {
    const initial = beginFlowDrag('a', down)!
    const modifiers = { alt: true, primary: true }
    const primaryFirstCloneMode = modifiers.primary ? 'absolute' : initial.originalMode
    expect(primaryFirstCloneMode).toBe('absolute')
    expect(at(initial, 20, 30, true, true).clone!.mode).toBe('flow')
  })

  it('rejects non-finite input and history-inconsistent state', () => {
    expect(beginFlowDrag('a', { x: Number.NaN, y: 0 })).toBeNull()
    const initial = beginFlowDrag('a', down)!
    expect(sampleFlowDrag(initial, { x: Number.POSITIVE_INFINITY, y: 0 }, { alt: false, primary: false })).toBeNull()
    const inconsistent = { ...initial, altActive: true } as FlowDragState
    expect(validFlowDragState(inconsistent)).toBe(false)
    expect(sampleFlowDrag(inconsistent, { x: 20, y: 30 }, { alt: true, primary: false })).toBeNull()
  })
})

const fence = { fileId: 'file', fileRevision: 7, measurementRevision: 11, documentRevision: 7, layoutGeneration: 3 }
const relationship = { parentId: 'parent', orderKey: 'V', slot: { presence: 'absent' as const } }
const pointerDownViewport = { x: 100, y: 200 }
const pointerDownTime = 1_000
const paper = (selectionDepthPrimary = false) => beginPaperFlowDrag({
  nodeId: 'a', pointerDownWorld: down, pointerDownViewport, pointerDownTime, sourceRelationship: relationship, sourceIndex: 2,
  gestureGeneration: 9, selectionDepthPrimary, fence,
})!
const proof = { ...fence, gestureGeneration: 9, owned: true }
const raw = (altKey: boolean, ctrlKey: boolean, metaKey = false, altGraph = false) => ({ altKey, ctrlKey, metaKey, altGraph })
const targetFor = (state: PaperFlowDragState, rawIndex = 4, semanticIndex = 3): FlowDragTarget => ({
  parentId: 'parent', slotPresence: 'absent', slotValue: null, rawIndex, semanticIndex, line: 1,
  guideWorld: { axis: 'x', position: 215, start: 50, end: 90 },
  fence: { ...fence, gestureGeneration: 9, sampleSequence: state.sampleSequence },
})
const paperSample = (
  state: PaperFlowDragState,
  world: { x: number; y: number },
  modifiers: ReturnType<typeof raw>,
  options: { geometry?: { x: number; y: number; width: number; height: number }; resolve?: (edge: PaperFlowDragState) => FlowDragTarget | null;
    platform?: 'macos' | 'windows'; viewport?: { x: number; y: number }; timestamp?: number } = {},
) => samplePaperFlowDrag(state, { world, viewport: options.viewport ?? { x: pointerDownViewport.x + world.x - down.x, y: pointerDownViewport.y + world.y - down.y },
  timestamp: options.timestamp ?? state.currentTime, modifiers, platform: options.platform ?? 'windows', authority: proof,
  ...(options.geometry ? { entryGeometry: options.geometry } : {}), resolveTarget: options.resolve ?? targetFor })!

describe('Paper flow drag exact transition state', () => {
  it('captures exact absent-slot source authority and treats pointer-down primary as selection depth only', () => {
    const state = paper(true)
    expect(state).toStrictEqual({
      kind: 'paper-flow-drag', nodeId: 'a', selection: ['a'], selectionDepthPrimary: true,
      sourceRelationship: { parentId: 'parent', orderKey: 'V', slot: { presence: 'absent' } }, sourceIndex: 2,
      pointerDownWorld: down, currentWorld: down, pointerDownViewport, currentViewport: pointerDownViewport,
      pointerDownTime, currentTime: pointerDownTime, originalMode: 'flow', altActive: false, primaryActive: false,
      thresholdCrossed: false, gestureGeneration: 9, cloneGeneration: 0, clone: null,
      target: null, sampleSequence: 0, fence,
    })
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.sourceRelationship)).toBe(true)
    expect(Object.isFrozen(state.sourceRelationship.slot)).toBe(true)
    expect(validFlowDragState(state)).toBe(true)
  })

  it('records Alt before threshold but creates its source-flow clone only on the first threshold sample', () => {
    const pending = paperSample(paper(true), { x: 13, y: 20 }, raw(true, true))
    expect(pending).toMatchObject({ thresholdCrossed: false, altActive: true, primaryActive: false, originalMode: 'flow', sampleSequence: 1,
      cloneGeneration: 0, clone: null, target: null })
    const active = paperSample(pending, { x: 15, y: 20 }, raw(true, true))
    expect(active).toMatchObject({ thresholdCrossed: true, primaryActive: true, originalMode: 'absolute', cloneGeneration: 1,
      clone: { generation: 1, entryMode: 'flow', startedAtWorld: { x: 15, y: 20 } }, target: { rawIndex: 4, semanticIndex: 3 }, sampleSequence: 2 })
    const earlyCloneMutation = { generation: 1, entryMode: 'flow', startedAtWorld: { x: 13, y: 20 } }
    expect(pending.clone).not.toStrictEqual(earlyCloneMutation)
  })

  it('runs Alt before primary on the threshold sample and exposes the post-edge state to target resolution', () => {
    const observed: Array<{ cloneMode: string | null; originalMode: string; sequence: number }> = []
    const state = paperSample(paper(), { x: 15, y: 20 }, raw(true, true), { resolve: edge => {
      observed.push({ cloneMode: edge.clone?.entryMode ?? null, originalMode: edge.originalMode, sequence: edge.sampleSequence })
      return targetFor(edge)
    } })
    expect(observed).toStrictEqual([{ cloneMode: 'flow', originalMode: 'absolute', sequence: 1 }])
    expect(state.clone).toMatchObject({ entryMode: 'flow', startedAtWorld: { x: 15, y: 20 } })
    expect(state.originalMode).toBe('absolute')

    const swappedOrderMutation = { cloneMode: 'absolute', originalMode: 'absolute' }
    expect(observed[0]).not.toMatchObject(swappedOrderMutation)
  })

  it('captures absolute entry geometry when primary precedes Alt, then returns only the original to flow', () => {
    const absolute = paperSample(paper(), { x: 15, y: 20 }, raw(false, true))
    expect(absolute).toMatchObject({ originalMode: 'absolute', clone: null })
    const geometry = { x: -10, y: 29, width: 60, height: 20 }
    const duplicated = paperSample(absolute, { x: 20, y: 20 }, raw(true, true), { geometry })
    expect(duplicated.clone).toStrictEqual({ generation: 1, entryMode: 'absolute', entryGeometry: geometry, sourceRelationship: relationship, sourceIndex: 2, startedAtWorld: { x: 20, y: 20 } })
    const returned = paperSample(duplicated, { x: 25, y: 20 }, raw(true, false))
    expect(returned).toMatchObject({ originalMode: 'flow', primaryActive: false, clone: { entryMode: 'absolute', entryGeometry: geometry } })
  })

  it('scopes Alt release and delayed clear to one generation', () => {
    const first = paperSample(paper(), { x: 15, y: 20 }, raw(true, false))
    const firstGeneration = first.clone!.generation
    const released = paperSample(first, { x: 16, y: 20 }, raw(false, false))
    expect(released).toMatchObject({ altActive: false, cloneGeneration: 1, clone: null })
    const second = paperSample(released, { x: 17, y: 20 }, raw(true, false))
    expect(second.clone).toMatchObject({ generation: 2, entryMode: 'flow' })
    expect(clearPaperFlowDragClone(second, firstGeneration)).toBe(second)
    const cleared = clearPaperFlowDragClone(second, 2)!
    expect(second.target).toMatchObject({ rawIndex: 4, semanticIndex: 3 })
    expect(cleared).toMatchObject({ altActive: false, cloneGeneration: 2, clone: null, target: null })
    const staleDuplicateTargetMutation = second.target
    expect(cleared.target).not.toBe(staleDuplicateTargetMutation)
  })

  it('normalizes Command on macOS and Ctrl on Windows while rejecting AltGraph synthesis', () => {
    expect(normalizeFlowDragModifiers(raw(true, false, true), 'macos')).toStrictEqual({ alt: true, primary: true })
    expect(normalizeFlowDragModifiers(raw(true, true, false), 'windows')).toStrictEqual({ alt: true, primary: true })
    expect(normalizeFlowDragModifiers(raw(true, true, false, true), 'windows')).toStrictEqual({ alt: false, primary: false })
    expect(normalizeFlowDragModifiers(raw(true, true, true, true), 'macos')).toStrictEqual({ alt: false, primary: false })
  })

  it('lets later primary edges change placement without changing resolved target identity', () => {
    const flow = paperSample(paper(), { x: 15, y: 20 }, raw(false, false))
    const absolute = paperSample(flow, { x: 16, y: 20 }, raw(false, true))
    const backToFlow = paperSample(absolute, { x: 17, y: 20 }, raw(false, false))
    const identity = (state: PaperFlowDragState) => state.target && ({ parentId: state.target.parentId, slotPresence: state.target.slotPresence,
      slotValue: state.target.slotValue, rawIndex: state.target.rawIndex, semanticIndex: state.target.semanticIndex, line: state.target.line, guideWorld: state.target.guideWorld })
    expect(identity(flow)).toStrictEqual(identity(absolute))
    expect(identity(absolute)).toStrictEqual(identity(backToFlow))
    expect([flow.originalMode, absolute.originalMode, backToFlow.originalMode]).toStrictEqual(['flow', 'absolute', 'flow'])
  })

  it('checks threshold before ownership and does not resolve a target below threshold', () => {
    let resolutions = 0
    const pending = paperSample(paper(), { x: 14.999, y: 20 }, raw(false, false), { resolve: edge => { resolutions += 1; return targetFor(edge) } })
    expect(pending.thresholdCrossed).toBe(false)
    expect(pending.target).toBeNull()
    expect(resolutions).toBe(0)
    const atThreshold = paperSample(pending, { x: 15, y: 20 }, raw(false, false), { resolve: edge => { resolutions += 1; return targetFor(edge) } })
    expect(atThreshold.thresholdCrossed).toBe(true)
    expect(resolutions).toBe(1)
  })

  it('uses Paper exact 5 CSS px through 500 ms and 1 CSS px after 500 ms, with equality admitted', () => {
    const cases = [
      { elapsed: 499, distance: 4.999, crossed: false },
      { elapsed: 499, distance: 5, crossed: true },
      { elapsed: 500, distance: 4.999, crossed: false },
      { elapsed: 500, distance: 5, crossed: true },
      { elapsed: 501, distance: 0.999, crossed: false },
      { elapsed: 501, distance: 1, crossed: true },
      { elapsed: 501, distance: 4.999, crossed: true },
      { elapsed: 501, distance: 5, crossed: true },
    ] as const
    const actual = cases.map(({ elapsed, distance }) => paperSample(paper(), down, raw(false, false), {
      viewport: { x: 100 + distance, y: 200 }, timestamp: 1_000 + elapsed, resolve: () => null,
    }).thresholdCrossed)
    expect(actual).toStrictEqual([false, true, false, true, false, true, true, true])

    const onePixelTooEarlyMutation = cases.map(({ distance }) => distance >= 1)
    const fivePixelsAfterHoldMutation = cases.map(({ distance }) => distance >= 5)
    expect(actual).not.toStrictEqual(onePixelTooEarlyMutation)
    expect(actual).not.toStrictEqual(fivePixelsAfterHoldMutation)
  })

  it('latches admission after the exact 5 CSS px boundary even when the pointer returns below both thresholds', () => {
    let resolutions = 0
    const resolve = (edge: PaperFlowDragState) => { resolutions += 1; return targetFor(edge) }
    const admitted = paperSample(paper(), down, raw(false, false), {
      viewport: { x: 105, y: 200 }, timestamp: 1_500, resolve,
    })
    const returnedToOrigin = paperSample(admitted, down, raw(false, false), {
      viewport: { x: 100, y: 200 }, timestamp: 1_501, resolve,
    })
    const belowHeldThreshold = paperSample(returnedToOrigin, down, raw(false, false), {
      viewport: { x: 100.999, y: 200 }, timestamp: 1_502, resolve,
    })
    expect([admitted.thresholdCrossed, returnedToOrigin.thresholdCrossed, belowHeldThreshold.thresholdCrossed]).toStrictEqual([true, true, true])
    expect([admitted.target?.fence.sampleSequence, returnedToOrigin.target?.fence.sampleSequence, belowHeldThreshold.target?.fence.sampleSequence]).toStrictEqual([1, 2, 3])
    expect(resolutions).toBe(3)

    const unlatchMutation = [true, false, false]
    expect([admitted.thresholdCrossed, returnedToOrigin.thresholdCrossed, belowHeldThreshold.thresholdCrossed]).not.toStrictEqual(unlatchMutation)
  })

  it('keeps CSS admission invariant when world movement represents a different zoom', () => {
    const zoomedOutWorld = paperSample(paper(), { x: 1_010, y: 20 }, raw(false, false), {
      viewport: { x: 104.999, y: 200 }, timestamp: 1_499, resolve: () => null,
    })
    const zoomedInWorld = paperSample(paper(), { x: 10.05, y: 20 }, raw(false, false), {
      viewport: { x: 105, y: 200 }, timestamp: 1_499, resolve: () => null,
    })
    expect(zoomedOutWorld.thresholdCrossed).toBe(false)
    expect(zoomedInWorld.thresholdCrossed).toBe(true)
    expect(zoomedOutWorld.currentWorld).toStrictEqual({ x: 1_010, y: 20 })
    expect(zoomedInWorld.currentWorld).toStrictEqual({ x: 10.05, y: 20 })
  })

  it('fails closed for non-finite time or viewport distance and for time regression', () => {
    const initial = paper()
    expect(beginPaperFlowDrag({ nodeId: 'a', pointerDownWorld: down, pointerDownViewport: { x: Number.NaN, y: 200 }, pointerDownTime,
      sourceRelationship: relationship, sourceIndex: 2, gestureGeneration: 9, selectionDepthPrimary: false, fence })).toBeNull()
    expect(beginPaperFlowDrag({ nodeId: 'a', pointerDownWorld: down, pointerDownViewport, pointerDownTime: Number.POSITIVE_INFINITY,
      sourceRelationship: relationship, sourceIndex: 2, gestureGeneration: 9, selectionDepthPrimary: false, fence })).toBeNull()
    for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(samplePaperFlowDrag(initial, { world: down, viewport: pointerDownViewport, timestamp, modifiers: raw(false, false),
        platform: 'windows', authority: proof, resolveTarget: () => null })).toBeNull()
    }
    for (const viewport of [{ x: Number.NaN, y: 200 }, { x: Number.POSITIVE_INFINITY, y: 200 }, { x: 100, y: Number.NEGATIVE_INFINITY }]) {
      expect(samplePaperFlowDrag(initial, { world: down, viewport, timestamp: 1_001, modifiers: raw(false, false),
        platform: 'windows', authority: proof, resolveTarget: () => null })).toBeNull()
    }
    expect(samplePaperFlowDrag(initial, { world: down, viewport: { x: Number.MAX_VALUE, y: Number.MAX_VALUE }, timestamp: 1_001,
      modifiers: raw(false, false), platform: 'windows', authority: proof, resolveTarget: () => null })).toBeNull()
    const accepted = paperSample(initial, down, raw(false, false), { viewport: { x: 100.5, y: 200 }, timestamp: 1_100, resolve: () => null })
    expect(samplePaperFlowDrag(accepted, { world: down, viewport: { x: 100.75, y: 200 }, timestamp: 1_099, modifiers: raw(false, false),
      platform: 'windows', authority: proof, resolveTarget: () => null })).toBeNull()
    expect(validFlowDragState({ ...accepted, currentTime: 999 })).toBe(false)
    expect(validFlowDragState({ ...accepted, currentViewport: undefined } as unknown as PaperFlowDragState)).toBe(false)
  })

  it('requires exact Begin and Sample inputs and rejects extra keys before reading getters', () => {
    const missingBeginViewport = Object.freeze({ nodeId: 'a', pointerDownWorld: down, pointerDownTime,
      sourceRelationship: relationship, sourceIndex: 2, gestureGeneration: 9, selectionDepthPrimary: false, fence })
    const missingBeginTime = Object.freeze({ nodeId: 'a', pointerDownWorld: down, pointerDownViewport,
      sourceRelationship: relationship, sourceIndex: 2, gestureGeneration: 9, selectionDepthPrimary: false, fence })
    expect(beginPaperFlowDrag(missingBeginViewport as unknown as Parameters<typeof beginPaperFlowDrag>[0])).toBeNull()
    expect(beginPaperFlowDrag(missingBeginTime as unknown as Parameters<typeof beginPaperFlowDrag>[0])).toBeNull()
    expect(Object.isFrozen(missingBeginViewport)).toBe(true)
    expect(Object.isFrozen(missingBeginTime)).toBe(true)

    let beginGetterReads = 0
    const injectedThreshold: Record<string, unknown> = { pointerDownWorld: down, pointerDownViewport, pointerDownTime,
      sourceRelationship: relationship, sourceIndex: 2, gestureGeneration: 9, selectionDepthPrimary: false, fence }
    Object.defineProperties(injectedThreshold, {
      nodeId: { enumerable: true, get: () => { beginGetterReads += 1; return 'a' } },
      thresholdWorld: { enumerable: true, get: () => { beginGetterReads += 1; return 5 } },
    })
    Object.freeze(injectedThreshold)
    const beginKeys = Reflect.ownKeys(injectedThreshold)
    expect(beginPaperFlowDrag(injectedThreshold as unknown as Parameters<typeof beginPaperFlowDrag>[0])).toBeNull()
    expect(beginGetterReads).toBe(0)
    expect(Reflect.ownKeys(injectedThreshold)).toStrictEqual(beginKeys)
    expect(Object.isFrozen(injectedThreshold)).toBe(true)

    const initial = paper()
    let missingSampleGetterReads = 0
    const missingSampleViewport: Record<string, unknown> = { timestamp: 1_000, modifiers: raw(false, false), platform: 'windows', authority: proof,
      resolveTarget: () => null }
    Object.defineProperty(missingSampleViewport, 'world', { enumerable: true, get: () => { missingSampleGetterReads += 1; return down } })
    Object.freeze(missingSampleViewport)
    expect(samplePaperFlowDrag(initial, missingSampleViewport as unknown as Parameters<typeof samplePaperFlowDrag>[1])).toBeNull()
    expect(missingSampleGetterReads).toBe(0)

    const missingSampleTime = Object.freeze({ world: down, viewport: pointerDownViewport, modifiers: raw(false, false), platform: 'windows',
      authority: proof, resolveTarget: () => null })
    expect(samplePaperFlowDrag(initial, missingSampleTime as unknown as Parameters<typeof samplePaperFlowDrag>[1])).toBeNull()
    expect(Object.isFrozen(missingSampleTime)).toBe(true)

    let sampleGetterReads = 0
    const injectedSample: Record<string, unknown> = { viewport: pointerDownViewport, timestamp: 1_000, modifiers: raw(false, false),
      platform: 'windows', authority: proof, resolveTarget: () => null }
    Object.defineProperties(injectedSample, {
      world: { enumerable: true, get: () => { sampleGetterReads += 1; return down } },
      untrusted: { enumerable: true, get: () => { sampleGetterReads += 1; return 'value' } },
    })
    Object.freeze(injectedSample)
    const sampleKeys = Reflect.ownKeys(injectedSample)
    expect(samplePaperFlowDrag(initial, injectedSample as unknown as Parameters<typeof samplePaperFlowDrag>[1])).toBeNull()
    expect(sampleGetterReads).toBe(0)
    expect(Reflect.ownKeys(injectedSample)).toStrictEqual(sampleKeys)
    expect(Object.isFrozen(injectedSample)).toBe(true)

    const expectedEnumerableSampleKeys = ['authority', 'modifiers', 'platform', 'resolveTarget', 'timestamp', 'viewport', 'world']
    let symbolGetterReads = 0
    const symbolExtra = Symbol('untrusted')
    const injectedSymbol: Record<PropertyKey, unknown> = { viewport: pointerDownViewport, timestamp: 1_000, modifiers: raw(false, false),
      platform: 'windows', authority: proof, resolveTarget: () => null }
    Object.defineProperties(injectedSymbol, {
      world: { enumerable: true, get: () => { symbolGetterReads += 1; return down } },
      [symbolExtra]: { enumerable: true, get: () => { symbolGetterReads += 1; return 'value' } },
    })
    Object.freeze(injectedSymbol)
    expect(Object.keys(injectedSymbol).sort()).toStrictEqual(expectedEnumerableSampleKeys)
    expect(samplePaperFlowDrag(initial, injectedSymbol as unknown as Parameters<typeof samplePaperFlowDrag>[1])).toBeNull()
    expect(symbolGetterReads).toBe(0)

    let hiddenExtraGetterReads = 0
    const injectedHiddenExtra: Record<string, unknown> = { viewport: pointerDownViewport, timestamp: 1_000, modifiers: raw(false, false),
      platform: 'windows', authority: proof, resolveTarget: () => null }
    Object.defineProperties(injectedHiddenExtra, {
      world: { enumerable: true, get: () => { hiddenExtraGetterReads += 1; return down } },
      hiddenExtra: { enumerable: false, get: () => { hiddenExtraGetterReads += 1; return 'value' } },
    })
    Object.freeze(injectedHiddenExtra)
    expect(Object.keys(injectedHiddenExtra).sort()).toStrictEqual(expectedEnumerableSampleKeys)
    expect(samplePaperFlowDrag(initial, injectedHiddenExtra as unknown as Parameters<typeof samplePaperFlowDrag>[1])).toBeNull()
    expect(hiddenExtraGetterReads).toBe(0)

    let hiddenRequiredGetterReads = 0
    const hiddenRequired: Record<string, unknown> = { viewport: pointerDownViewport, timestamp: 1_000, modifiers: raw(false, false),
      platform: 'windows', authority: proof, resolveTarget: () => null }
    Object.defineProperty(hiddenRequired, 'world', { enumerable: false, get: () => { hiddenRequiredGetterReads += 1; return down } })
    Object.freeze(hiddenRequired)
    expect(Reflect.ownKeys(hiddenRequired)).toContain('world')
    expect(Object.keys(hiddenRequired)).not.toContain('world')
    expect(samplePaperFlowDrag(initial, hiddenRequired as unknown as Parameters<typeof samplePaperFlowDrag>[1])).toBeNull()
    expect(hiddenRequiredGetterReads).toBe(0)
  })

  it('creates an Alt clone only after admission whether Alt precedes or follows the threshold edge', () => {
    const altPending = paperSample(paper(), down, raw(true, false), {
      viewport: { x: 104.999, y: 200 }, timestamp: 1_499, resolve: () => null,
    })
    expect(altPending).toMatchObject({ thresholdCrossed: false, altActive: true, cloneGeneration: 0, clone: null })
    const altAdmitted = paperSample(altPending, down, raw(true, false), {
      viewport: { x: 105, y: 200 }, timestamp: 1_500, resolve: () => null,
    })
    expect(altAdmitted).toMatchObject({ thresholdCrossed: true, altActive: true, cloneGeneration: 1,
      clone: { generation: 1, entryMode: 'flow' } })

    const admittedWithoutAlt = paperSample(paper(), down, raw(false, false), {
      viewport: { x: 105, y: 200 }, timestamp: 1_500, resolve: () => null,
    })
    expect(admittedWithoutAlt).toMatchObject({ thresholdCrossed: true, altActive: false, cloneGeneration: 0, clone: null })
    const altAfterAdmission = paperSample(admittedWithoutAlt, down, raw(true, false), {
      viewport: { x: 106, y: 200 }, timestamp: 1_501, resolve: () => null,
    })
    expect(altAfterAdmission).toMatchObject({ thresholdCrossed: true, altActive: true, cloneGeneration: 1,
      clone: { generation: 1, entryMode: 'flow' } })
  })

  it('preserves source relationship and selected original identity across threshold admission', () => {
    const initial = paper(true)
    const pending = paperSample(initial, { x: -500, y: 750 }, raw(true, true), {
      viewport: { x: 104.999, y: 200 }, timestamp: 1_500, resolve: () => null,
    })
    const admitted = paperSample(pending, { x: 900, y: -300 }, raw(true, true), {
      viewport: { x: 105, y: 200 }, timestamp: 1_500, resolve: () => null,
    })
    expect(pending.sourceRelationship).toBe(initial.sourceRelationship)
    expect(admitted.sourceRelationship).toBe(initial.sourceRelationship)
    expect(pending.selection).toBe(initial.selection)
    expect(admitted.selection).toBe(initial.selection)
    expect(admitted).toMatchObject({ nodeId: 'a', selection: ['a'], sourceIndex: 2, selectionDepthPrimary: true })
  })

  it('fails closed on stale authority, lost ownership, invalid absolute capture, or target fence drift', () => {
    const initial = paper()
    expect(samplePaperFlowDrag(initial, { world: { x: 15, y: 20 }, viewport: { x: 105, y: 200 }, timestamp: 1_000,
      modifiers: raw(false, false), platform: 'windows', authority: { ...proof, owned: false }, resolveTarget: targetFor })).toBeNull()
    expect(samplePaperFlowDrag(initial, { world: { x: 15, y: 20 }, viewport: { x: 105, y: 200 }, timestamp: 1_000,
      modifiers: raw(false, false), platform: 'windows', authority: { ...proof, fileRevision: 8 }, resolveTarget: targetFor })).toBeNull()
    const absolute = paperSample(initial, { x: 15, y: 20 }, raw(false, true))
    expect(samplePaperFlowDrag(absolute, { world: { x: 20, y: 20 }, viewport: { x: 110, y: 200 }, timestamp: 1_000,
      modifiers: raw(true, true), platform: 'windows', authority: proof, resolveTarget: targetFor })).toBeNull()
    expect(samplePaperFlowDrag(initial, { world: { x: 15, y: 20 }, viewport: { x: 105, y: 200 }, timestamp: 1_000,
      modifiers: raw(false, false), platform: 'windows', authority: proof,
      resolveTarget: edge => ({ ...targetFor(edge), fence: { ...targetFor(edge).fence, layoutGeneration: 4 } }) })).toBeNull()
  })

  it('rejects noncanonical source order keys at the state boundary', () => {
    expect(beginPaperFlowDrag({ nodeId: 'a', pointerDownWorld: down, pointerDownViewport, pointerDownTime,
      sourceRelationship: { parentId: 'parent', orderKey: 'a0', slot: { presence: 'absent' } }, sourceIndex: 2,
      gestureGeneration: 9, selectionDepthPrimary: false, fence })).toBeNull()
  })

  it('rejects a clone whose parent, order key, slot presence, or slot value differs from the immutable source', () => {
    const source = beginPaperFlowDrag({ nodeId: 'a', pointerDownWorld: down, pointerDownViewport, pointerDownTime,
      sourceRelationship: { parentId: 'parent', orderKey: 'V', slot: { presence: 'present', value: 'children' } }, sourceIndex: 2,
      gestureGeneration: 9, selectionDepthPrimary: false, fence })!
    const cloned = samplePaperFlowDrag(source, { world: { x: 15, y: 20 }, viewport: { x: 105, y: 200 }, timestamp: 1_000,
      modifiers: raw(true, false), platform: 'windows', authority: proof,
      resolveTarget: state => ({ ...targetFor(state), slotPresence: 'present', slotValue: 'children' }) })!
    for (const relationshipMutation of [
      { parentId: 'other', orderKey: 'V', slot: { presence: 'present' as const, value: 'children' } },
      { parentId: 'parent', orderKey: 'W', slot: { presence: 'present' as const, value: 'children' } },
      { parentId: 'parent', orderKey: 'V', slot: { presence: 'absent' as const } },
      { parentId: 'parent', orderKey: 'V', slot: { presence: 'present' as const, value: 'footer' } },
    ]) {
      const forged = structuredClone(cloned)
      ;(forged.clone as { sourceRelationship: typeof relationshipMutation }).sourceRelationship = relationshipMutation
      expect(validFlowDragState(forged)).toBe(false)
      expect(samplePaperFlowDrag(forged, { world: { x: 16, y: 20 }, viewport: { x: 106, y: 200 }, timestamp: 1_000,
        modifiers: raw(true, false), platform: 'windows', authority: proof, resolveTarget: () => null })).toBeNull()
    }
  })

  it('does not mutate successful Sample inputs and deeply freezes the complete Sample result', () => {
    const source = { parentId: 'parent', orderKey: 'V', slot: { presence: 'absent' as const } }
    const input = { nodeId: 'a', pointerDownWorld: { ...down }, pointerDownViewport: { ...pointerDownViewport }, pointerDownTime,
      sourceRelationship: source, sourceIndex: 2,
      gestureGeneration: 9, selectionDepthPrimary: false, fence: { ...fence } }
    const before = structuredClone(input)
    const initial = beginPaperFlowDrag(input)!
    expect(input).toStrictEqual(before)
    expect(Object.isFrozen(initial.pointerDownViewport)).toBe(true)

    const absolute = paperSample(initial, { x: 15, y: 20 }, raw(false, true))
    const entryGeometry = Object.freeze({ x: -10, y: 29, width: 60, height: 20 })
    const sampleInput = Object.freeze({
      world: Object.freeze({ x: 20, y: 25 }),
      viewport: Object.freeze({ x: 110, y: 205 }),
      timestamp: 1_001,
      modifiers: Object.freeze(raw(true, true)),
      platform: 'windows' as const,
      authority: Object.freeze({ ...proof }),
      entryGeometry,
      resolveTarget: targetFor,
    })
    const sampleBefore = {
      ...sampleInput,
      world: { ...sampleInput.world },
      viewport: { ...sampleInput.viewport },
      modifiers: { ...sampleInput.modifiers },
      authority: { ...sampleInput.authority },
      entryGeometry: { ...sampleInput.entryGeometry },
    }
    const sampleBytesBefore = JSON.stringify(sampleInput)
    const next = samplePaperFlowDrag(absolute, sampleInput)!
    expect(sampleInput).toStrictEqual(sampleBefore)
    expect(JSON.stringify(sampleInput)).toBe(sampleBytesBefore)
    expect(Object.isFrozen(sampleInput)).toBe(true)
    expect(Object.isFrozen(sampleInput.world)).toBe(true)
    expect(Object.isFrozen(sampleInput.viewport)).toBe(true)
    expect(Object.isFrozen(sampleInput.modifiers)).toBe(true)
    expect(Object.isFrozen(sampleInput.authority)).toBe(true)
    expect(Object.isFrozen(sampleInput.entryGeometry)).toBe(true)

    expect(Object.isFrozen(next)).toBe(true)
    expect(Object.isFrozen(next.currentWorld)).toBe(true)
    expect(Object.isFrozen(next.currentViewport)).toBe(true)
    expect(Object.isFrozen(next.fence)).toBe(true)
    expect(Object.isFrozen(next.target)).toBe(true)
    expect(Object.isFrozen(next.target!.guideWorld)).toBe(true)
    expect(Object.isFrozen(next.target!.fence)).toBe(true)
    expect(Object.isFrozen(next.clone)).toBe(true)
    expect(Object.isFrozen(next.clone!.sourceRelationship)).toBe(true)
    expect(Object.isFrozen(next.clone!.sourceRelationship.slot)).toBe(true)
    expect(Object.isFrozen(next.clone!.entryGeometry)).toBe(true)
    expect(next.clone!.entryGeometry).not.toBe(sampleInput.entryGeometry)

    const shallowOnly = Object.freeze(structuredClone(next))
    expect(Object.isFrozen(shallowOnly)).toBe(true)
    expect(Object.isFrozen(shallowOnly.currentWorld)).toBe(false)
    const mutableCurrentWorld = shallowOnly.currentWorld as { x: number; y: number }
    const shallowX = mutableCurrentWorld.x
    mutableCurrentWorld.x += 1
    expect(mutableCurrentWorld.x).toBe(shallowX + 1)
    expect(next.currentWorld.x).toBe(20)
  })
})
