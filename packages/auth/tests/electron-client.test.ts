import { describe, expect, it } from 'vitest'
import { decodeDesktopAuthorization } from '../src/electron-callback'
import { requestAuthenticatedApi, resolveAuthenticatedApiPath } from '../src/api-target'

const validToken = 'eyJpZGVudGlmaWVyIjoiQWJDZEVmR2hJaktsTW5PcFFyU3RVdld4WXowMTIzNDUiLCJzdGF0ZSI6IkFiQ2RFZjEyMzQ1Njc4OTAifQ'

describe('desktop authorization callback', () => {
  it('decodes the exact Better Auth authorization payload', () => {
    expect(decodeDesktopAuthorization(validToken)).toEqual({
      identifier: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      state: 'AbCdEf1234567890',
    })
    expect(decodeDesktopAuthorization(`${validToken}==`)).toEqual({
      identifier: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      state: 'AbCdEf1234567890',
    })
  })

  it.each([
    '',
    `${validToken}=`,
    `${validToken}===`,
    Buffer.from('{"identifier":"short","state":"AbCdEf1234567890"}').toString('base64url'),
    Buffer.from('{"identifier":"AbCdEfGhIjKlMnOpQrStUvWxYz012345","state":"short"}').toString('base64url'),
    Buffer.from('{"identifier":"AbCdEfGhIjKlMnOpQrStUvWxYz012345","state":"AbCdEf1234567890","extra":true}').toString('base64url'),
  ])('rejects an invalid or extended payload', token => {
    expect(() => decodeDesktopAuthorization(token)).toThrow('Desktop auth callback is invalid.')
  })
})

describe('main-process authenticated API boundary', () => {
  it('AT-AUTH-001 resolves same-origin API paths outside the Better Auth base path', () => {
    expect(resolveAuthenticatedApiPath('https://api.canvas.test', '/api/files?limit=10')).toBe('https://api.canvas.test/api/files?limit=10')
    for (const target of [
      'https://attacker.test/api/files',
      '//attacker.test/api/files',
      '/internal/file-access',
      '/files',
      '/api/files#token',
    ]) expect(() => resolveAuthenticatedApiPath('https://api.canvas.test', target)).toThrow('not allowed')
  })

  it('AT-AUTH-001 sends the protected cookie on the fixed desktop origin and cannot be overridden by request input', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher: typeof fetch = async (input, init = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const response = await requestAuthenticatedApi({
      baseURL: 'https://api.canvas.test',
      path: '/api/files',
      init: { credentials: 'include', headers: { Cookie: 'attacker=1', Origin: 'https://attacker.test', 'User-Agent': 'Attacker' } },
      cookie: 'canvas.session=protected',
      origin: 'com.comp-canvas.desktop:/',
      userAgent: 'Comp Canvas/1.0',
      fetch: fetcher,
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.canvas.test/api/files')
    expect(calls[0]!.init.credentials).toBe('omit')
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('Cookie')).toBe('canvas.session=protected')
    expect(headers.get('Origin')).toBe('com.comp-canvas.desktop:/')
    expect(headers.get('User-Agent')).toBe('Comp Canvas/1.0')

    expect(() => requestAuthenticatedApi({
      baseURL: 'https://api.canvas.test',
      path: 'https://attacker.test/api/files',
      cookie: 'canvas.session=protected',
      origin: 'com.comp-canvas.desktop:/',
      userAgent: 'Comp Canvas/1.0',
      fetch: fetcher,
    })).toThrow('not allowed')
    expect(calls).toHaveLength(1)
  })
})
