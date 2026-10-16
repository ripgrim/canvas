import { describe, expect, it } from 'vitest'
import type { FileToken } from '@canvas/repo-engine/file-document'
import { decodeThemeTokens, encodeThemeTokens, moveThemeTokens } from './theme-token-menu'

const token = (id: string, type: FileToken['type'], name: string, orderKey: string): FileToken => ({ id, type, name, orderKey, value: type === 'color' ? { kind: 'literal', color: { kind: 'hex', hex: '#FFFFFF' } } : { kind: 'literal', value: '8px' } } as FileToken)

describe('THEME-TOKEN-MENU-001 Paper token actions', () => {
  it('round trips only the explicit Canvas token clipboard envelope', () => {
    const tokens = [token('space-1', 'spacing', '1', 'A'), token('space-2', 'spacing', '2', 'B')]
    expect(decodeThemeTokens(encodeThemeTokens(tokens))).toEqual(tokens)
    expect(decodeThemeTokens(JSON.stringify(tokens))).toBeNull()
    expect(decodeThemeTokens('canvas-theme-tokens:v1\n[]')).toBeNull()
    expect(decodeThemeTokens('canvas-theme-tokens:v1\n[{"id":"bad","type":"spacing","name":"Bad","orderKey":"A","value":{"kind":"literal","color":{"kind":"hex","hex":"#FFFFFF"}}}]')).toBeNull()
    expect(decodeThemeTokens('canvas-theme-tokens:v1\n[{"id":"bad","type":"color","name":"Bad","orderKey":"A","value":{"kind":"source","property":"--bad","fallback":{"kind":"hex","hex":"not-a-color"}}}]')).toBeNull()
  })

  it('moves a selected run within its type without disturbing interleaved token types', () => {
    const tokens = [token('space-1', 'spacing', '1', 'A'), token('color-1', 'color', 'Ink', 'B'), token('space-2', 'spacing', '2', 'C'), token('space-3', 'spacing', '3', 'D')]
    expect(moveThemeTokens(tokens, new Set(['space-2', 'space-3']), 'first')).toEqual(['space-2', 'color-1', 'space-3', 'space-1'])
    expect(moveThemeTokens(tokens, new Set(['space-2']), 'down')).toEqual(['space-1', 'color-1', 'space-3', 'space-2'])
  })
})
