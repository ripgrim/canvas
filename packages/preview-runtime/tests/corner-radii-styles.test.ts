import { describe, expect, it } from 'vitest'
import { cornerRadiiStyle } from '../src/appearance-styles.mjs'

describe('AT-CAN-003 AT-APP-003 corner radius DOM styles', () => {
  it('does not override a component root when radius is unauthored', () => {
    expect(cornerRadiiStyle(undefined)).toEqual({})
    expect(cornerRadiiStyle({ fills: [] })).toEqual({})
  })

  it('keeps explicit zero so an imported root can be squared off', () => {
    expect(cornerRadiiStyle({ cornerRadii: { all: 0 } })).toEqual({ borderRadius: '0px' })
  })

  it('projects the CSS shorthand in top-left, top-right, bottom-right, bottom-left order', () => {
    expect(cornerRadiiStyle({ cornerRadii: { topLeft: 1, topRight: 2, bottomLeft: 3, bottomRight: 4 } })).toEqual({ borderRadius: '1px 2px 4px 3px' })
  })

  it('removes floating point noise without rounding authored precision away', () => {
    expect(cornerRadiiStyle({ cornerRadii: { all: 7.000000000000001 } })).toEqual({ borderRadius: '7px' })
    expect(cornerRadiiStyle({ cornerRadii: { all: 1.23456 } })).toEqual({ borderRadius: '1.2346px' })
  })
})
