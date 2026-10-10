import { describe, expect, it } from 'vitest'
import { authSessionView, consumeNativeAuthCallback, createNativeAuthAttempt, NativeAuthAttemptStore, parseDesktopSignInParameters, parseNativeAuthCallback, parseNativeElectronAuthCallback } from '../src/index'

const target = { scheme: 'com.comp-canvas.desktop', path: '/oauth/callback' } as const

describe('native auth callback', () => {
  it('creates PKCE material and consumes one exact callback', async () => {
    const attempt = await createNativeAuthAttempt({ ownerWindowId: 7, now: 1_000_000 })
    expect(attempt.codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(attempt.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const callback = parseNativeAuthCallback(`${target.scheme}:${target.path}?code=one-time-code&state=${attempt.state}&iss=https%3A%2F%2Fauth.example`, target)
    const consumed = consumeNativeAuthCallback(attempt, callback, 7, 1_000_001)
    expect(consumed.consumedAt).toBe(1_000_001)
    expect(() => consumeNativeAuthCallback(attempt, callback, 7, 1_000_002)).toThrow('already used')
    expect(() => consumeNativeAuthCallback(consumed, callback, 7, 1_000_002)).toThrow('already used')
  })

  it('atomically removes a main-process attempt after one callback', async () => {
    const store = new NativeAuthAttemptStore()
    const attempt = await store.create({ ownerWindowId: 3, now: 3_000_000 })
    const callback = { code: 'one-time-code', state: attempt.state, issuer: null }
    expect(store.consume(attempt.id, callback, 3, 3_000_001).consumedAt).toBe(3_000_001)
    expect(() => store.consume(attempt.id, callback, 3, 3_000_002)).toThrow('not found or was already used')
  })

  it.each([
    'wrong:/oauth/callback?code=x&state=y',
    'com.comp-canvas.desktop:/wrong?code=x&state=y',
    'com.comp-canvas.desktop://host/oauth/callback?code=x&state=y',
    'com.comp-canvas.desktop:/oauth/callback?code=x&code=y&state=z',
    'com.comp-canvas.desktop:/oauth/callback?code=x&state=y&extra=z',
    'com.comp-canvas.desktop:/oauth/callback?code=x&state=y#fragment',
  ])('rejects callback shape %s', input => {
    expect(() => parseNativeAuthCallback(input, target)).toThrow()
  })

  it('rejects state, window, expiry, and replay failures', async () => {
    const attempt = await createNativeAuthAttempt({ ownerWindowId: 4, now: 2_000_000, ttlMs: 30_000 })
    expect(() => consumeNativeAuthCallback(attempt, { code: 'x', state: 'wrong', issuer: null }, 4, 2_000_001)).toThrow('state')
    expect(() => consumeNativeAuthCallback(attempt, { code: 'x', state: attempt.state, issuer: null }, 5, 2_000_001)).toThrow('another window')
    expect(() => consumeNativeAuthCallback(attempt, { code: 'x', state: attempt.state, issuer: null }, 4, 2_030_001)).toThrow('expired')
  })

  it('strictly parses the Better Auth Electron fragment callback', () => {
    expect(parseNativeElectronAuthCallback(`${target.scheme}:${target.path}#token=YQ`, target)).toEqual({ token: 'YQ' })
    expect(parseNativeElectronAuthCallback(`${target.scheme}://oauth/callback#token=YQ`, target)).toEqual({ token: 'YQ' })
    expect(parseNativeElectronAuthCallback(`${target.scheme}://oauth/callback#token=YQ==`, target)).toEqual({ token: 'YQ==' })
    for (const input of [
      `${target.scheme}:${target.path}?token=x#token=y`,
      `${target.scheme}:${target.path}#token=x&extra=y`,
      `${target.scheme}://host${target.path}#token=x`,
      `${target.scheme}:/wrong#token=x`,
      `${target.scheme}:${target.path}#code=x`,
      `${target.scheme}:${target.path}#token=not+base64url`,
      `${target.scheme}:${target.path}#token=not.percent`,
      `${target.scheme}:${target.path}#token=bad===`,
      `${target.scheme}:${target.path}#token=abc_DEF-123==`,
      `${target.scheme}://user:pass@oauth/callback#token=x`,
      `${target.scheme}://oauth:80/callback#token=x`,
    ]) expect(() => parseNativeElectronAuthCallback(input, target)).toThrow()
  })

  it('validates the hosted desktop request without collapsing duplicate parameters', () => {
    const valid = new URLSearchParams({ client_id: 'desktop', state: 'AbCdEf1234567890', code_challenge: 'a'.repeat(43) })
    expect(parseDesktopSignInParameters(valid, 'desktop')).toEqual({ client_id: 'desktop', state: 'AbCdEf1234567890', code_challenge: 'a'.repeat(43) })
    for (const input of [
      'client_id=desktop&state=AbCdEf1234567890&state=AbCdEf1234567890&code_challenge=' + 'a'.repeat(43),
      'client_id=other&state=AbCdEf1234567890&code_challenge=' + 'a'.repeat(43),
      'client_id=desktop&state=short&code_challenge=' + 'a'.repeat(43),
      'client_id=desktop&state=AbCdEf1234567890&code_challenge=' + 'a'.repeat(42),
      'client_id=desktop&state=AbCdEf1234567890&code_challenge=' + 'a'.repeat(43) + '&redirect=https://evil.test',
    ]) expect(parseDesktopSignInParameters(new URLSearchParams(input), 'desktop')).toBeNull()
  })

  it('never pairs a user with a non-authenticated state', () => {
    const user = { id: 'u1', name: 'Ada', email: 'ada@example.test', avatarUrl: null }
    expect(authSessionView('signed-in', user)).toEqual({ status: 'signed-in', user, message: null })
    expect(() => authSessionView('signed-out', user)).toThrow()
    expect(() => authSessionView('signed-in')).toThrow()
  })
})
