import { describe, expect, it } from 'vitest'
import { decodeDesktopAuthorization } from '../src/electron-callback'

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
