import { describe, expect, it } from 'vitest'
import { cornerRadiusAgreement, withCornerRadii } from './RadiusSection'

describe('AT-APP-005 AT-UX-002 AT-UX-003 RadiusSection appearance updates', () => {
  it('reports uniform, per-corner mixed, and selection-mixed values independently', () => {
    expect(cornerRadiusAgreement([undefined, undefined])).toEqual({ mixed: false, value: 0 })
    expect(cornerRadiusAgreement([{ cornerRadii: { all: 8 } }, { cornerRadii: { all: 8 } }])).toEqual({ mixed: false, value: 8 })
    const values = [{ cornerRadii: { topLeft: 4, topRight: 8, bottomLeft: 12, bottomRight: 16 } }, { cornerRadii: { topLeft: 4, topRight: 9, bottomLeft: 12, bottomRight: 16 } }] as const
    expect(cornerRadiusAgreement(values)).toEqual({ mixed: true, value: null })
    expect(cornerRadiusAgreement(values, 'topLeft')).toEqual({ mixed: false, value: 4 })
    expect(cornerRadiusAgreement(values, 'topRight')).toEqual({ mixed: true, value: null })
  })

  it('preserves unrelated appearance and canonicalizes four equal corners', () => {
    expect(withCornerRadii({ opacity: 0.5 }, { topLeft: 6, topRight: 6, bottomLeft: 6, bottomRight: 6 })).toEqual({ opacity: 0.5, cornerRadii: { all: 6 } })
    expect(withCornerRadii({ cornerRadii: { all: 12 } }, { topLeft: 0, topRight: 12, bottomLeft: 18, bottomRight: 24 })).toEqual({ cornerRadii: { topLeft: 0, topRight: 12, bottomLeft: 18, bottomRight: 24 } })
  })

  it('retains explicit zero for imported roots instead of treating it as unauthored', () => {
    expect(withCornerRadii(undefined, { all: 0 })).toEqual({ cornerRadii: { all: 0 } })
  })
})
