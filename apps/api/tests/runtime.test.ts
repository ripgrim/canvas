import { describe, expect, it } from 'vitest'
import { apiAllowedOrigins } from '../src/runtime'

describe('API runtime origin policy', () => {
  it('AT-AUTH-001 includes the desktop protocol beside canonical web origins', () => {
    expect(apiAllowedOrigins({
      LOGIN_URL: 'http://127.0.0.1:4319',
      APP_URL: 'http://127.0.0.1:4317,http://127.0.0.1:4317/',
    })).toEqual([
      'com.comp-canvas.desktop:/',
      'http://127.0.0.1:4319',
      'http://127.0.0.1:4317',
    ])
  })

  it('fails closed without the hosted login origin', () => {
    expect(() => apiAllowedOrigins({ APP_URL: 'http://127.0.0.1:4317' })).toThrow('Missing LOGIN_URL.')
  })
})
