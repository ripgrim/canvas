/**
 * Layout declarations on the wire: kebab-case CSS longhands with values accepted only by a per-property grammar.
 * The editor projects the file's layout model into these; the runtime never evaluates CSS text from the editor
 * beyond this allow-list, so no url(), var(), calc(), expression(), or declaration separators reach an inline style.
 */
export type LayoutDeclarations = Record<string, string>
export type LayoutStatus = 'applied' | 'unsupported-ambiguous-root' | 'unsupported-indirect-children' | 'unsupported-no-root'
export const layoutStatuses: readonly LayoutStatus[] = ['applied', 'unsupported-ambiguous-root', 'unsupported-indirect-children', 'unsupported-no-root']

const number = String.raw`-?\d{1,7}(?:\.\d{1,4})?`
const unsigned = String.raw`\d{1,7}(?:\.\d{1,4})?`
const length = String.raw`${number}(?:px|%)`
const unsignedLength = String.raw`${unsigned}(?:px|%)`
const exact = (pattern: string) => new RegExp(`^(?:${pattern})$`)
const keywords = (...values: string[]) => exact(values.join('|'))
const sizeValue = exact(`${unsignedLength}|auto|fit-content|min-content|max-content`)
const track = String.raw`(?:${unsigned}(?:px|%|fr)|auto|minmax\((?:${unsigned}(?:px|%)|auto), (?:${unsigned}(?:px|%|fr)|auto)\))`

/** Container longhands. */
const containerGrammar: Record<string, RegExp> = {
  display: keywords('block', 'flex', 'grid'),
  overflow: keywords('visible', 'hidden', 'clip', 'auto', 'scroll'),
  'flex-direction': keywords('row', 'row-reverse', 'column', 'column-reverse'),
  'flex-wrap': keywords('nowrap', 'wrap', 'wrap-reverse'),
  'justify-content': keywords('flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'stretch', 'start', 'end'),
  'align-content': keywords('flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'stretch', 'start', 'end'),
  'align-items': keywords('flex-start', 'flex-end', 'center', 'stretch', 'baseline', 'start', 'end'),
  'justify-items': keywords('flex-start', 'flex-end', 'center', 'stretch', 'start', 'end'),
  'column-gap': exact(`${unsigned}px`),
  'row-gap': exact(`${unsigned}px`),
  'grid-template-columns': exact(`${track}(?: ${track}){0,199}`),
  'grid-template-rows': exact(`${track}(?: ${track}){0,199}`),
  'grid-auto-flow': keywords('row', 'column'),
}
/** Item longhands. */
const itemGrammar: Record<string, RegExp> = {
  position: keywords('absolute'),
  left: exact(length), right: exact(length), top: exact(length), bottom: exact(length),
  'z-index': exact(String.raw`-?\d{1,5}`),
  width: sizeValue, height: sizeValue,
  'min-width': sizeValue, 'min-height': sizeValue,
  'max-width': exact(`${unsignedLength}|none|fit-content|min-content|max-content`), 'max-height': exact(`${unsignedLength}|none|fit-content|min-content|max-content`),
  'flex-grow': exact(unsigned), 'flex-shrink': exact(unsigned),
  'flex-basis': exact(`${unsignedLength}|auto|content|fit-content|min-content|max-content`),
  'grid-column-start': exact(String.raw`\d{1,4}|span \d{1,4}`), 'grid-column-end': exact(String.raw`\d{1,4}|span \d{1,4}`),
  'grid-row-start': exact(String.raw`\d{1,4}|span \d{1,4}`), 'grid-row-end': exact(String.raw`\d{1,4}|span \d{1,4}`),
  'justify-self': keywords('flex-start', 'flex-end', 'center', 'stretch', 'start', 'end'),
  'align-self': keywords('flex-start', 'flex-end', 'center', 'stretch', 'baseline', 'start', 'end'),
  'aspect-ratio': exact(unsigned),
  transform: exact(String.raw`rotate\(${number}deg\)|scale\(${number}(?:, ${number})?\)|rotate\(${number}deg\) scale\(${number}(?:, ${number})?\)`),
  'padding-top': exact(`${unsigned}px`), 'padding-right': exact(`${unsigned}px`), 'padding-bottom': exact(`${unsigned}px`), 'padding-left': exact(`${unsigned}px`),
  'margin-top': exact(`${number}px|auto`), 'margin-right': exact(`${number}px|auto`), 'margin-bottom': exact(`${number}px|auto`), 'margin-left': exact(`${number}px|auto`),
}
export const containerLonghands: readonly string[] = Object.keys(containerGrammar)
export const itemLonghands: readonly string[] = Object.keys(itemGrammar)
/** Every longhand the runtime layout layer may write and therefore must capture and restore. */
export const layoutLonghands: readonly string[] = [...containerLonghands, ...itemLonghands, 'order', 'box-sizing', 'flex']
export const maxLayoutDeclarations = 64

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** Deny by default: unknown property names, unknown values, and oversize maps are rejected whole. */
export function isLayoutDeclarations(value: unknown): value is LayoutDeclarations {
  if (!record(value)) return false
  const entries = Object.entries(value)
  if (entries.length > maxLayoutDeclarations) return false
  for (const [name, text] of entries) {
    // Own keys only: inherited names such as constructor or toString are not properties and must not reach the regexes.
    const grammar = Object.hasOwn(containerGrammar, name) ? containerGrammar[name] : Object.hasOwn(itemGrammar, name) ? itemGrammar[name] : undefined
    if (!grammar || typeof text !== 'string' || text.length > 5000 || !grammar.test(text)) return false
  }
  return true
}
export const isContainerLonghand = (name: string): boolean => Object.hasOwn(containerGrammar, name)
export const isLayoutStatus = (value: unknown): value is LayoutStatus => typeof value === 'string' && (layoutStatuses as readonly string[]).includes(value)
