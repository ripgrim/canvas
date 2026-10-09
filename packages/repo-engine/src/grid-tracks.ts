/**
 * Grid track model: non-negative px, percent, fr, auto, or minmax (no fr minimum). The parser accepts the subset of
 * `grid-template-*` syntax the editor can round-trip and rejects everything else explicitly, with the same guard
 * limits Wonder enforces (5,000 input characters, 64 characters per token, repeat 1..100, at most 200 tracks).
 */
export type GridTrack =
  | { kind: 'px'; value: number }
  | { kind: 'percent'; value: number }
  | { kind: 'fr'; value: number }
  | { kind: 'auto' }
  | { kind: 'minmax'; min: Exclude<GridTrack, { kind: 'minmax' | 'fr' }>; max: Exclude<GridTrack, { kind: 'minmax' }> }
export type GridTrackParse = { ok: true; tracks: GridTrack[] } | { ok: false; error: string }

export const gridTrackLimits = { inputLength: 5000, tokenLength: 64, repeatMin: 1, repeatMax: 100, maxTracks: 200 } as const
const limit = 1_000_000
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limit

export function validateGridTrack(value: unknown, depth = 0): value is GridTrack {
  if (!record(value) || typeof value.kind !== 'string') return false
  const names = Object.keys(value).sort().join(',')
  switch (value.kind) {
    case 'px': case 'percent': case 'fr': return names === 'kind,value' && finite(value.value)
    case 'auto': return names === 'kind'
    case 'minmax':
      if (depth > 0 || names !== 'kind,max,min') return false
      return validateGridTrack(value.min, 1) && (value.min as GridTrack).kind !== 'fr' && validateGridTrack(value.max, 1)
    default: return false
  }
}

export const fr = (value = 1): GridTrack => ({ kind: 'fr', value })
export const sameTracks = (left: readonly GridTrack[], right: readonly GridTrack[]): boolean => left.length === right.length && left.every((track, index) => JSON.stringify(track) === JSON.stringify(right[index]))

/** CSS for one track. On a fixed-size axis an fr track keeps a hit area via `minmax(32px, Nfr)`. */
export function trackToCss(track: GridTrack, options: { fixedAxis?: boolean } = {}): string {
  switch (track.kind) {
    case 'px': return `${track.value}px`
    case 'percent': return `${track.value}%`
    case 'fr': return options.fixedAxis ? `minmax(32px, ${track.value}fr)` : `${track.value}fr`
    case 'auto': return 'auto'
    case 'minmax': return `minmax(${trackToCss(track.min)}, ${trackToCss(track.max)})`
  }
}
export const tracksToCss = (tracks: readonly GridTrack[], options: { fixedAxis?: boolean } = {}): string => tracks.map(track => trackToCss(track, options)).join(' ')

const simpleToken = /^(?:(\d+(?:\.\d+)?)(px|%|fr)|auto)$/i
function parseSimple(token: string): Exclude<GridTrack, { kind: 'minmax' }> | null {
  const match = simpleToken.exec(token.trim())
  if (!match) return null
  if (match[1] === undefined) return { kind: 'auto' }
  const value = Number(match[1])
  if (!Number.isFinite(value) || value > limit) return null
  const unit = match[2]!.toLowerCase()
  return unit === 'px' ? { kind: 'px', value } : unit === '%' ? { kind: 'percent', value } : { kind: 'fr', value }
}

/** Splits on top-level whitespace so `minmax(10px, 1fr)` and `repeat(2, 1fr)` stay whole. */
function tokenize(input: string): string[] | null {
  const tokens: string[] = []
  let depth = 0, current = ''
  for (const char of input) {
    if (char === '(') depth += 1
    if (char === ')') { depth -= 1; if (depth < 0) return null }
    if (/\s/.test(char) && depth === 0) { if (current) tokens.push(current); current = ''; continue }
    current += char
  }
  if (depth !== 0) return null
  if (current) tokens.push(current)
  return tokens
}

/**
 * Parses an authored template string. Rejects named lines, areas, subgrid, auto-fill/auto-fit, fit-content(), negative
 * or non-finite values, nested repeats, and anything beyond the guard limits.
 */
export function parseGridTemplate(input: string): GridTrackParse {
  if (typeof input !== 'string') return { ok: false, error: 'Track template must be text' }
  if (input.length > gridTrackLimits.inputLength) return { ok: false, error: `Track template is longer than ${gridTrackLimits.inputLength} characters` }
  const tokens = tokenize(input.trim())
  if (!tokens) return { ok: false, error: 'Unbalanced parentheses in track template' }
  if (!tokens.length) return { ok: false, error: 'Track template is empty' }
  const tracks: GridTrack[] = []
  for (const token of tokens) {
    if (token.length > gridTrackLimits.tokenLength) return { ok: false, error: `Track "${token.slice(0, 16)}" is longer than ${gridTrackLimits.tokenLength} characters` }
    if (token.startsWith('[')) return { ok: false, error: 'Named grid lines are not supported' }
    const repeat = /^repeat\((.+)\)$/i.exec(token)
    if (repeat) {
      const comma = repeat[1]!.indexOf(',')
      if (comma < 0) return { ok: false, error: 'repeat() needs a count and tracks' }
      const countText = repeat[1]!.slice(0, comma).trim()
      if (!/^\d+$/.test(countText)) return { ok: false, error: /auto-(fill|fit)/i.test(countText) ? 'auto-fill and auto-fit are not supported' : 'repeat() count must be a whole number' }
      const count = Number(countText)
      if (count < gridTrackLimits.repeatMin || count > gridTrackLimits.repeatMax) return { ok: false, error: `repeat() count must be between ${gridTrackLimits.repeatMin} and ${gridTrackLimits.repeatMax}` }
      const inner = tokenize(repeat[1]!.slice(comma + 1).trim())
      if (!inner || !inner.length) return { ok: false, error: 'repeat() needs at least one track' }
      const parsedInner: GridTrack[] = []
      for (const part of inner) {
        if (/^repeat\(/i.test(part)) return { ok: false, error: 'Nested repeat() is not supported' }
        const track = parseTrackToken(part)
        if (!track.ok) return track
        parsedInner.push(track.track)
      }
      for (let index = 0; index < count; index++) tracks.push(...parsedInner.map(track => structuredClone(track)))
    } else {
      const track = parseTrackToken(token)
      if (!track.ok) return track
      tracks.push(track.track)
    }
    if (tracks.length > gridTrackLimits.maxTracks) return { ok: false, error: `Track template expands to more than ${gridTrackLimits.maxTracks} tracks` }
  }
  return { ok: true, tracks }
}
function parseTrackToken(token: string): { ok: true; track: GridTrack } | { ok: false; error: string } {
  const minmax = /^minmax\((.+)\)$/i.exec(token)
  if (minmax) {
    const parts = minmax[1]!.split(',').map(part => part.trim())
    if (parts.length !== 2) return { ok: false, error: 'minmax() needs exactly two values' }
    const min = parseSimple(parts[0]!), max = parseSimple(parts[1]!)
    if (!min || !max) return { ok: false, error: `Unsupported minmax() value in "${token.slice(0, 32)}"` }
    if (min.kind === 'fr') return { ok: false, error: 'fr is not allowed as a minmax() minimum' }
    return { ok: true, track: { kind: 'minmax', min, max } }
  }
  if (/^subgrid$/i.test(token)) return { ok: false, error: 'subgrid is not supported' }
  if (/^fit-content\(/i.test(token)) return { ok: false, error: 'fit-content() tracks are not supported' }
  if (/^-/.test(token)) return { ok: false, error: 'Negative track sizes are not allowed' }
  const simple = parseSimple(token)
  if (!simple) return { ok: false, error: `Unsupported track "${token.slice(0, 32)}"` }
  return { ok: true, track: simple }
}
