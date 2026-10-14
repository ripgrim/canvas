import { create } from 'fontkit'
import type { Font } from 'fontkit'
import type { FontFeature } from './font-feature-types'

type FeatureRecord = Readonly<{ tag: string; feature?: Readonly<{ featureParams?: Readonly<{ nameID?: number }> }> }>
type OpenTypeFont = Font & Readonly<{
  GPOS?: Readonly<{ featureList?: readonly FeatureRecord[] }>
  GSUB?: Readonly<{ featureList?: readonly FeatureRecord[] }>
  name?: Readonly<{ records?: Readonly<{ fontFeatures?: Readonly<Record<number, Readonly<Record<string, string>>>> }> }>
}>

const names: Readonly<Record<string, string>> = {
  afrc: 'Stacked fractions', apkn: 'Kerning for alternate proportional widths', calt: 'Contextual alternates', case: 'Case-sensitive forms', chws: 'Contextual half-width spacing', clig: 'Contextual ligatures', cpct: 'Centered CJK punctuation', cpsp: 'Capital spacing', cswh: 'Contextual swash', c2pc: 'Petite capitals from capitals', c2sc: 'Small capitals from capitals', dlig: 'Discretionary ligatures', dnom: 'Denominators', expt: 'Expert forms', falt: 'Final glyph on line alternates', frac: 'Fractions', fwid: 'Full widths', halt: 'Alternate half widths', hist: 'Historical forms', hkna: 'Horizontal kana alternates', hlig: 'Historical ligatures', hngl: 'Hangul', hojo: 'Hojo kanji forms', hwid: 'Half widths', ital: 'Italics', jalt: 'Justification alternates', jp78: 'JIS78 forms', jp83: 'JIS83 forms', jp90: 'JIS90 forms', jp04: 'JIS2004 forms', kern: 'Kerning', lfbd: 'Left bounds', liga: 'Standard ligatures', lnum: 'Lining figures', mgrk: 'Mathematical greek', nalt: 'Alternate annotation forms', nlck: 'NLC kanji forms', numr: 'Numerators', onum: 'Oldstyle figures', opbd: 'Optical bounds', ordn: 'Ordinals', ornm: 'Ornaments', palt: 'Proportional alternate widths', pcap: 'Petite capitals', pkna: 'Proportional kana', pnum: 'Proportional figures', pwid: 'Proportional widths', qwid: 'Quarter widths', rand: 'Randomize', rtbd: 'Right bounds', ruby: 'Ruby notation forms', salt: 'Stylistic alternates', sinf: 'Scientific inferiors', size: 'Optical size', smcp: 'Small capitals', smpl: 'Simplified forms', subs: 'Subscript', sups: 'Superscript', swsh: 'Swash', titl: 'Titling', tnam: 'Traditional name forms', tnum: 'Tabular figures', trad: 'Traditional forms', twid: 'Third widths', unic: 'Unicase', valt: 'Alternate vertical metrics', vapk: 'Kerning for alternate proportional vertical metrics', vchw: 'Vertical contextual half-width spacing', vert: 'Vertical alternates', vhal: 'Alternate vertical half metrics', vkna: 'Vertical kana alternates', vkrn: 'Vertical kerning', vpal: 'Proportional alternate vertical metrics', vrt2: 'Vertical alternates and rotation', vrtr: 'Vertical alternates for rotation', zero: 'Slashed zero',
}

const fixedSamples: Readonly<Record<string, string>> = {
  frac: '1/2 1/4 3/4 5/8', kern: 'VA WA YA LT Ta To', pnum: '0123456789', tnum: '0123456789', lnum: '0123456789', onum: '0123456789', numr: '123456789', dnom: '123456789', ordn: '1st 2nd 3rd', subs: 'H2O 123', sups: 'x2 123', zero: '0 00 000', liga: 'fi fl ff ffi ffl', clig: 'fi fl ff ffi ffl', dlig: 'st ct Th', calt: '-> => <=> == != === !==',
}

const probes = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'a g l I R Q G J y & @',
  'fi fl ff ffi ffl st ct Th',
  '-> => <=> == != === !== <= >= :: && || ??',
]

const fontName = (font: OpenTypeFont, record: FeatureRecord): string | null => {
  const id = record.feature?.featureParams?.nameID
  if (id === undefined) return null
  const values = font.name?.records?.fontFeatures?.[id]
  return values?.en ?? (values ? Object.values(values)[0] ?? null : null)
}

const featureName = (font: OpenTypeFont, tag: string): string => {
  const record = [...(font.GSUB?.featureList ?? []), ...(font.GPOS?.featureList ?? [])].find(candidate => candidate.tag === tag)
  const unique = /^(?:ss(?:0[1-9]|1\d|20)|cv(?:0[1-9]|[1-9]\d))$/.test(tag)
  return unique && record ? fontName(font, record) ?? names[tag] ?? (tag.startsWith('ss') ? `Stylistic set ${Number(tag.slice(2))}` : `Character variant ${Number(tag.slice(2))}`) : names[tag] ?? tag
}

const glyphs = (font: OpenTypeFont, text: string, tag: string, enabled: boolean): string => font.layout(text, { [tag]: enabled }).glyphs.map(glyph => glyph.id).join(',')

const featureSample = (font: OpenTypeFont, tag: string): string => {
  const fixed = fixedSamples[tag]
  if (fixed) return fixed
  for (const probe of probes) if (glyphs(font, probe, tag, false) !== glyphs(font, probe, tag, true)) return probe
  return 'Lorem ipsum'
}

self.onmessage = (event: MessageEvent<Readonly<{ bytes: ArrayBuffer; key: string }>>) => {
  try {
    const font = create(new Uint8Array(event.data.bytes) as never) as OpenTypeFont
    const features: FontFeature[] = font.availableFeatures
      .filter(tag => /^[A-Za-z0-9]{4}$/.test(tag))
      .filter((tag, index, all) => all.indexOf(tag) === index)
      .map(tag => ({ tag, name: featureName(font, tag), sample: featureSample(font, tag) }))
    self.postMessage({ key: event.data.key, features })
  } catch (error) {
    self.postMessage({ key: event.data.key, error: error instanceof Error ? error.message : 'Font feature parsing failed.' })
  }
}
