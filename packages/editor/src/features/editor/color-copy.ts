export const colorCopy = {
  format: 'Color format',
  value: 'Color value',
  hue: 'Hue',
  saturation: 'Saturation',
  brightness: 'Brightness',
  alpha: 'Opacity',
  close: 'Close color picker',
  invalid: 'Enter a valid HEX, RGB, or HSL color.',
  alphaUnsupported: 'This token does not support opacity.',
  unsupportedValue: 'The current color cannot be edited with this picker.',
  open: (label: string) => `Edit ${label}`,
} as const
