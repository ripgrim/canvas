import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { sizingFieldState, sizingModesForContext, sizingTokenGroups } from './LayoutPanels'

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
    expect(sizingModesForContext(false, true)).toEqual(['fixed', 'fill'])
    expect(sizingModesForContext(true, true)).toEqual(['fixed', 'hug', 'fill'])
  })

  it('groups only compatible numeric token kinds and gates breakpoints to root artboards', () => {
    const file = createBlankFile('sizing-menu', 'page', 'root')
    file.theme.tokens = {
      space: { id: 'space', type: 'spacing', name: '2', orderKey: 'A', value: { kind: 'literal', value: '8px' } },
      container: { id: 'container', type: 'container', name: 'sm', orderKey: 'B', value: { kind: 'literal', value: '320px' } },
      breakpoint: { id: 'breakpoint', type: 'breakpoint', name: 'md', orderKey: 'C', value: { kind: 'literal', value: '640px' } },
      color: { id: 'color', type: 'color', name: 'Ink', orderKey: 'D', value: { kind: 'literal', color: { kind: 'hex', hex: '#111111' } } },
      weight: { id: 'weight', type: 'fontWeight', name: 'Medium', orderKey: 'E', value: { kind: 'literal', value: 500 } },
    }
    expect(sizingTokenGroups(file, {}, true).map(group => [group.label, group.tokens.map(token => `${token.name}:${token.displayValue}`)])).toEqual([
      ['Spacing', ['2:8px']],
      ['Container', ['sm:320px']],
      ['Breakpoint', ['md:640px']],
    ])
    expect(sizingTokenGroups(file, {}, false).map(group => group.label)).toEqual(['Spacing', 'Container'])
  })
})
