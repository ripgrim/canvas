import { describe, expect, it } from 'vitest'
import { createThemeFocus, focusSequence, pendingFocus, sidebarViewFor } from './theme-focus'

describe('theme focus requests (CC-TB-012)', () => {
  it('increments a sequence per request and notifies subscribers once each', () => {
    const focus = createThemeFocus()
    const seen: (string | null)[] = []
    const stop = focus.subscribe(() => { seen.push(focus.getSnapshot().request?.tokenId ?? null) })
    expect(focus.request('accent')).toBe(1)
    expect(focus.request('surface')).toBe(2)
    expect(focus.getSnapshot()).toEqual({ request: { sequence: 2, tokenId: 'surface' }, acknowledged: 0 })
    expect(seen).toEqual(['accent', 'surface'])
    stop()
    focus.request('ink')
    expect(seen).toEqual(['accent', 'surface'])
  })

  it('keeps the snapshot identity stable between changes so useSyncExternalStore does not loop', () => {
    const focus = createThemeFocus()
    const first = focus.getSnapshot()
    expect(focus.getSnapshot()).toBe(first)
    focus.request('accent')
    const second = focus.getSnapshot()
    expect(second).not.toBe(first)
    expect(focus.getSnapshot()).toBe(second)
  })

  it('reports a request as pending until it is acknowledged, and ignores stale acknowledgements', () => {
    const focus = createThemeFocus()
    expect(pendingFocus(focus.getSnapshot())).toBeNull()
    const sequence = focus.request('accent')
    expect(pendingFocus(focus.getSnapshot())).toEqual({ sequence: 1, tokenId: 'accent' })
    focus.acknowledge(sequence)
    expect(pendingFocus(focus.getSnapshot())).toBeNull()
    const before = focus.getSnapshot()
    focus.acknowledge(0)
    expect(focus.getSnapshot()).toBe(before)
    focus.request('surface')
    expect(pendingFocus(focus.getSnapshot())).toEqual({ sequence: 2, tokenId: 'surface' })
  })

  it('shows the Theme tab for a request newer than the last tab choice only', () => {
    const focus = createThemeFocus()
    expect(sidebarViewFor(focus.getSnapshot(), { view: 'design', at: 0 })).toBe('design')
    focus.request('accent')
    expect(sidebarViewFor(focus.getSnapshot(), { view: 'design', at: 0 })).toBe('theme')
    // The user picks Design after the request: their choice wins until the next request.
    const choice = { view: 'design' as const, at: focusSequence(focus.getSnapshot()) }
    expect(sidebarViewFor(focus.getSnapshot(), choice)).toBe('design')
    focus.acknowledge(1)
    expect(sidebarViewFor(focus.getSnapshot(), choice)).toBe('design')
    focus.request('accent')
    expect(sidebarViewFor(focus.getSnapshot(), choice)).toBe('theme')
  })

  it('dispose drops listeners and resets the sequence', () => {
    const focus = createThemeFocus()
    let calls = 0
    focus.subscribe(() => { calls += 1 })
    focus.request('accent')
    focus.dispose()
    expect(focus.getSnapshot()).toEqual({ request: null, acknowledged: 0 })
    focus.request('surface')
    expect(calls).toBe(1)
  })
})
