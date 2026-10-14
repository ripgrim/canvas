export type FontFeature = Readonly<{ tag: string; name: string; sample: string }>

export type FontFeatureStatus = 'idle' | 'loading' | 'loaded' | 'unavailable' | 'error'

export type FontFeatureSnapshot = Readonly<{
  error: string | null
  features: readonly FontFeature[]
  status: FontFeatureStatus
}>

export const defaultFontFeatureTags = new Set(['calt', 'clig', 'kern', 'liga', 'valt', 'vert', 'vkrn', 'vrt2'])

export const fontFeatureGroups = {
  Numbers: ['tnum', 'pnum', 'lnum', 'onum'],
  'Stylistic sets': ['salt', ...Array.from({ length: 20 }, (_, index) => `ss${String(index + 1).padStart(2, '0')}`)],
  'Character variants': [...Array.from({ length: 99 }, (_, index) => `cv${String(index + 1).padStart(2, '0')}`), 'zero', 'calt'],
  'Case and position': ['case', 'smcp', 'c2sc', 'pcap', 'c2pc', 'unic', 'subs', 'sups', 'ordn', 'numr', 'dnom', 'sinf', 'ital'],
  Ligatures: ['liga', 'clig', 'dlig', 'hlig', 'rlig'],
  Fractions: ['frac', 'afrc'],
  Spacing: ['kern', 'apkn', 'chws', 'cpct', 'cpsp', 'fwid', 'halt', 'hwid', 'lfbd', 'opbd', 'palt', 'pwid', 'qwid', 'rtbd', 'size', 'twid'],
  Decoration: ['cswh', 'falt', 'hist', 'jalt', 'ornm', 'rand', 'swsh', 'titl'],
  'Language-specific forms': ['expt', 'hkna', 'hngl', 'hojo', 'jp04', 'jp78', 'jp83', 'jp90', 'mgrk', 'nalt', 'nlck', 'pkna', 'ruby', 'smpl', 'tnam', 'trad'],
  'Vertical typography': ['vkrn', 'vapk', 'valt', 'vchw', 'vert', 'vhal', 'vkna', 'vpal', 'vrt2', 'vrtr'],
} as const
