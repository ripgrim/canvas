import { describe, expect, it } from 'vitest'
import { decodeDesktopAuthorization } from '../src/electron-callback'
import { resolveAuthenticatedApiPath } from '../src/api-target'

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
})
