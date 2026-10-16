/**
 * Layout CSS grammar for source writes. The longhand names and value patterns are a copy of the preview runtime's
 * allow-list (`packages/preview-runtime/src/layout-protocol.ts`): repo-engine may not import the runtime, and a parity
 * test keeps the two in step. Promotion writes these values into TSX `style` props, so anything outside the grammar
 * (url(), var(), calc(), expression(), separators) never reaches source.
 */
export type LayoutDeclarations = Record<string, string>

const number = String.raw`-?\d{1,7}(?:\.\d{1,4})?`
const unsigned = String.raw`\d{1,7}(?:\.\d{1,4})?`
const length = String.raw`${number}(?:px|%)`
const unsignedLength = String.raw`${unsigned}(?:px|%)`
const exact = (pattern: string) => new RegExp(`^(?:${pattern})$`)
const keywords = (...values: string[]) => exact(values.join('|'))
const sizeValue = exact(`${unsignedLength}|auto|fit-content|min-content|max-content`)
const track = String.raw`(?:${unsigned}(?:px|%|fr)|auto|minmax\((?:${unsigned}(?:px|%)|auto), (?:${unsigned}(?:px|%|fr)|auto)\))`
const matrixNumber = String.raw`-?(?:1000|\d{1,3}(?:\.\d{1,12})?)`
const matrix = String.raw`matrix\(${matrixNumber}, ${matrixNumber}, ${matrixNumber}, ${matrixNumber}, 0, 0\)`

const containerGrammar: Record<string, RegExp> = {
  display: keywords('block', 'flex', 'grid'),
  overflow: keywords('visible', 'hidden', 'clip', 'auto', 'scroll'),
  'flex-direction': keywords('row', 'row-reverse', 'column', 'column-reverse'),
  'flex-wrap': keywords('nowrap', 'wrap', 'wrap-reverse'),
  'justify-content': keywords('flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'stretch', 'start', 'end'),
  'align-content': keywords('flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'stretch', 'start', 'end'),
  'align-items': keywords('flex-start', 'flex-end', 'center', 'stretch', 'baseline', 'last baseline', 'start', 'end'),
  'justify-items': keywords('flex-start', 'flex-end', 'center', 'stretch', 'start', 'end'),
  'column-gap': exact(`${unsigned}px`),
  'row-gap': exact(`${unsigned}px`),
  'grid-template-columns': exact(`${track}(?: ${track}){0,199}`),
  'grid-template-rows': exact(`${track}(?: ${track}){0,199}`),
  'grid-auto-flow': keywords('row', 'column'),
}
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
  transform: exact(matrix),
  'padding-top': exact(`${unsigned}px`), 'padding-right': exact(`${unsigned}px`), 'padding-bottom': exact(`${unsigned}px`), 'padding-left': exact(`${unsigned}px`),
  'margin-top': exact(`${number}px|auto`), 'margin-right': exact(`${number}px|auto`), 'margin-bottom': exact(`${number}px|auto`), 'margin-left': exact(`${number}px|auto`),
}
/**
 * The five-field placement the runtime writes for a px width (`flex: 0 0 auto` keeps a flow item at its baked
 * width). It is not part of the wire grammar because the runtime derives it itself; source has to spell it out.
 */
const placementGrammar: Record<string, RegExp> = { flex: keywords('0 0 auto') }
export const maxLayoutDeclarations = 64

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function matches(value: unknown, grammarOf: (name: string) => RegExp | undefined): value is LayoutDeclarations {
  if (!record(value)) return false
  const entries = Object.entries(value)
  if (entries.length > maxLayoutDeclarations) return false
  for (const [name, text] of entries) {
    const grammar = grammarOf(name)
    if (!grammar || typeof text !== 'string' || text.length > 5000 || !grammar.test(text)) return false
  }
  return true
}
const own = (grammar: Record<string, RegExp>, name: string) => Object.hasOwn(grammar, name) ? grammar[name] : undefined

/** Same acceptance as the runtime's `isLayoutDeclarations`: deny by default, whole map rejected on any miss. */
export const isLayoutDeclarations = (value: unknown): value is LayoutDeclarations => matches(value, name => own(containerGrammar, name) ?? own(itemGrammar, name))
/** Wire grammar plus the placement longhands a source `style` prop carries. */
export const isSourceLayoutStyle = (value: unknown): value is LayoutDeclarations => matches(value, name => own(containerGrammar, name) ?? own(itemGrammar, name) ?? own(placementGrammar, name))

/** First declaration outside the source grammar, for an actionable error message. */
export function rejectedSourceDeclaration(value: Record<string, unknown>): string | null {
  if (Object.keys(value).length > maxLayoutDeclarations) return `more than ${maxLayoutDeclarations} declarations`
  for (const [name, text] of Object.entries(value)) if (!isSourceLayoutStyle({ [name]: text })) return name
  return null
}
export const cssPropertyToJsx = (name: string): string => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
