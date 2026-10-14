import { describe, expect, it } from 'vitest'
import { resolveWebAdapterMode } from './adapter-mode'

describe('web adapter mode', () => {
  it('uses account storage by default in local development', () => {
    expect(resolveWebAdapterMode({ desktop: false, development: true, browserTestStorage: false })).toEqual({ kind: 'cloud', apiOrigin: 'http://127.0.0.1:4320' })
  })

  it('requires an account API in production', () => {
    expect(() => resolveWebAdapterMode({ desktop: false, development: false, browserTestStorage: false })).toThrow('VITE_API_ORIGIN is required')
  })

  it('keeps browser storage behind an explicit test-only mode', () => {
    expect(resolveWebAdapterMode({ desktop: false, development: false, browserTestStorage: true })).toEqual({ kind: 'browser-test' })
  })
})
