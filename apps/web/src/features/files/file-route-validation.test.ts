import { describe, expect, it } from 'vitest'
import { isValidNodeRouteId, isValidRouteId, validateFileRouteSearch } from './file-route-validation'

describe('file route validation', () => {
  it('accepts the independent file and document identity alphabets', () => {
    expect(isValidRouteId('file_1-safe')).toBe(true)
    expect(isValidNodeRouteId('node:frame.1_safe')).toBe(true)
    expect(validateFileRouteSearch({ pageId: 'page_1', nodeId: 'node:frame.1' })).toEqual({ pageId: 'page_1', nodeId: 'node:frame.1' })
  })

  it('drops invalid values before the file service sees them', () => {
    expect(isValidRouteId('../private')).toBe(false)
    expect(isValidNodeRouteId('-leading-dash')).toBe(false)
    expect(validateFileRouteSearch({ pageId: '../private', nodeId: '<script>', ignored: 'value' })).toEqual({})
  })
})
