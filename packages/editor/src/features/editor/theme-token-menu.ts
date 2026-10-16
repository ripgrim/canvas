import type { FileToken, TokenType } from '@canvas/repo-engine/file-document'
import { isColor } from '@canvas/repo-engine/color'

const clipboardHeader = 'canvas-theme-tokens:v1\n'
const types = new Set<TokenType>(['color', 'opacity', 'radius', 'spacing', 'container', 'breakpoint', 'fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing'])

export type TokenMove = 'up' | 'down' | 'first' | 'last'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const clipboardToken = (value: unknown): value is FileToken => {
  if (!record(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.orderKey !== 'string'
    || typeof value.type !== 'string'
    || !types.has(value.type as TokenType)
    || value.description !== undefined && typeof value.description !== 'string'
    || !record(value.value)) return false
  const tokenValue = value.value
  if (tokenValue.kind === 'alias') return typeof tokenValue.tokenId === 'string'
  if (value.type === 'color') {
    if (tokenValue.kind === 'literal') return isColor(tokenValue.color)
    return tokenValue.kind === 'source' && typeof tokenValue.property === 'string' && isColor(tokenValue.fallback)
  }
  return tokenValue.kind === 'literal' && (typeof tokenValue.value === 'string' || typeof tokenValue.value === 'number' && Number.isFinite(tokenValue.value))
}

export const encodeThemeTokens = (tokens: readonly FileToken[]) => `${clipboardHeader}${JSON.stringify(tokens)}`

export function decodeThemeTokens(text: string): FileToken[] | null {
  if (!text.startsWith(clipboardHeader)) return null
  try {
    const value: unknown = JSON.parse(text.slice(clipboardHeader.length))
    return Array.isArray(value) && value.length > 0 && value.every(clipboardToken) ? value : null
  } catch { return null }
}

/** Paper moves selected tokens together inside each token type without disturbing the other type groups. */
export function moveThemeTokens(tokens: readonly FileToken[], selectedIds: ReadonlySet<string>, direction: TokenMove): string[] {
  const result = [...tokens]
  for (const type of types) {
    const positions = result.flatMap((token, index) => token.type === type ? [index] : [])
    const group = positions.map(index => result[index]!)
    const selected = group.filter(token => selectedIds.has(token.id))
    if (!selected.length) continue
    let next = [...group]
    if (direction === 'first') next = [...selected, ...group.filter(token => !selectedIds.has(token.id))]
    else if (direction === 'last') next = [...group.filter(token => !selectedIds.has(token.id)), ...selected]
    else if (direction === 'up') {
      for (let index = 1; index < next.length; index += 1) if (selectedIds.has(next[index]!.id) && !selectedIds.has(next[index - 1]!.id)) [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
    } else {
      for (let index = next.length - 2; index >= 0; index -= 1) if (selectedIds.has(next[index]!.id) && !selectedIds.has(next[index + 1]!.id)) [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]
    }
    positions.forEach((position, index) => { result[position] = next[index]! })
  }
  return result.map(token => token.id)
}
