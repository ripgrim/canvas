import { describe, expect, it } from 'vitest'
import { canonicalAppearance, canonicalCornerRadii, eligibleSections, expandedCornerRadii, projectAppearance, validateAppearance } from '../src/appearance.js'

describe('AT-APP-001 AT-APP-004 corner radii appearance persistence', () => {
  it('validates radii only for rectangular rendered roots', () => {
    const radius = { cornerRadii: { all: 12 } } as const
    for (const kind of ['frame', 'rectangle', 'shader', 'component'] as const) expect(validateAppearance(radius, kind)).toBe(radius)
    for (const kind of ['shape', 'text'] as const) expect(() => validateAppearance(radius, kind)).toThrow('This node has no corner radius')
    expect(eligibleSections('frame')).toContain('radius')
    expect(eligibleSections('shape')).not.toContain('radius')
  })

  it('rejects malformed, negative, non-finite, and partial records', () => {
    for (const cornerRadii of [
      { all: -1 },
      { all: Number.NaN },
      { all: 1, topLeft: 1 },
      { topLeft: 1, topRight: 2, bottomLeft: 3 },
      { topLeft: 1, topRight: 2, bottomLeft: 3, bottomRight: Number.POSITIVE_INFINITY },
    ]) expect(() => validateAppearance({ cornerRadii }, 'frame')).toThrow('Invalid corner radii')
  })

  it('canonicalizes equal corners to one uniform value while retaining an explicit zero override', () => {
    expect(canonicalCornerRadii({ all: 0 })).toEqual({ all: 0 })
    expect(canonicalCornerRadii({ topLeft: 8, topRight: 8, bottomLeft: 8, bottomRight: 8 })).toEqual({ all: 8 })
    expect(canonicalAppearance({ cornerRadii: { all: 0 } })).toEqual({ cornerRadii: { all: 0 } })
    expect(canonicalAppearance({ cornerRadii: { topLeft: 1, topRight: 2, bottomLeft: 3, bottomRight: 4 } })).toEqual({ cornerRadii: { topLeft: 1, topRight: 2, bottomLeft: 3, bottomRight: 4 } })
  })

  it('expands uniform and absent values for per-corner editing', () => {
    expect(expandedCornerRadii(undefined)).toEqual({ topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 })
    expect(expandedCornerRadii({ all: 7 })).toEqual({ topLeft: 7, topRight: 7, bottomLeft: 7, bottomRight: 7 })
  })

  it('survives a JSON reload and projects a canonical preview record', () => {
    const stored = { cornerRadii: { topLeft: 6, topRight: 12, bottomLeft: 18, bottomRight: 24 } } as const
    const reloaded = JSON.parse(JSON.stringify(stored))
    expect(validateAppearance(reloaded, 'component')).toEqual(stored)
    expect(projectAppearance(reloaded, () => null, () => false)).toEqual(stored)
    expect(projectAppearance({ cornerRadii: { topLeft: 5, topRight: 5, bottomLeft: 5, bottomRight: 5 } }, () => null, () => false)).toEqual({ cornerRadii: { all: 5 } })
  })
})
