import { describe, expect, it } from 'vitest'
import { authCallbackFromArguments, desktopAuthCallbackPath, desktopAuthClientOptions, desktopAuthScheme } from '../src/main/auth-config'

describe('desktop auth configuration', () => {
  it('keeps auth unavailable without a hosted service', () => {
    expect(desktopAuthClientOptions({}, false)).toBeNull()
  })

  it('accepts HTTPS and development localhost only', () => {
    expect(desktopAuthClientOptions({ DESIGN_EDITOR_AUTH_URL: 'https://accounts.example.test/' }, false)).toMatchObject({
      baseURL: 'https://accounts.example.test', signInURL: 'https://accounts.example.test/sign-in', scheme: desktopAuthScheme, callbackPath: desktopAuthCallbackPath,
    })
    expect(desktopAuthClientOptions({ DESIGN_EDITOR_AUTH_URL: 'http://127.0.0.1:3000' }, true)?.baseURL).toBe('http://127.0.0.1:3000')
    expect(desktopAuthClientOptions({}, true)?.baseURL).toBe('http://127.0.0.1:4317')
    expect(() => desktopAuthClientOptions({ DESIGN_EDITOR_AUTH_URL: 'http://accounts.example.test' }, true)).toThrow('Invalid hosted auth URL.')
    expect(() => desktopAuthClientOptions({ DESIGN_EDITOR_AUTH_URL: 'https://user:pass@accounts.example.test' }, false)).toThrow('Invalid hosted auth URL.')
  })

  it('extracts one exact desktop callback argument', () => {
    const callback = `${desktopAuthScheme}:${desktopAuthCallbackPath}#token=abc`
    expect(authCallbackFromArguments(['electron', '.', callback])).toBe(callback)
    expect(authCallbackFromArguments(['electron', '.'])).toBeNull()
    expect(authCallbackFromArguments([callback, callback])).toBeNull()
    expect(authCallbackFromArguments(['https://attacker.test'])).toBeNull()
  })
})
