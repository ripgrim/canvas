import { describe, expect, it } from 'vitest'
import { sizingFieldState, sizingModesForContext } from './LayoutPanels'

describe('AT-CAN-002 attached sizing menus', () => {
  it('uses the exact Fixed and Fit labels and only exposes available modes', () => {
    expect(sizingFieldState(['fixed', 'hug'], 'hug', false)).toEqual({
      currentLabel: 'Fit',
      options: [
        { value: 'fixed', label: 'Fixed', selected: false, disabled: false },
        { value: 'fit', label: 'Fit', selected: true, disabled: false },
      ],
    })
    expect(sizingFieldState(['fixed'], 'fixed', false).options).toEqual([{ value: 'fixed', label: 'Fixed', selected: true, disabled: false }])
  })

  it('keeps an unsupported stored mode visible and disabled', () => {
    expect(sizingFieldState(['fixed', 'hug'], 'fill', false)).toEqual({
      currentLabel: 'Fill',
      options: [
        { value: 'fixed', label: 'Fixed', selected: false, disabled: false },
        { value: 'fit', label: 'Fit', selected: false, disabled: false },
        { value: 'fill', label: 'Fill', selected: true, disabled: true },
      ],
    })
  })

  it('only adds Fit in flex context and Fill for flex items', () => {
    expect(sizingModesForContext(false, false)).toEqual(['fixed'])
    expect(sizingModesForContext(true, false)).toEqual(['fixed', 'hug'])
    expect(sizingModesForContext(false, true)).toEqual(['fixed', 'hug', 'fill'])
  })
})
