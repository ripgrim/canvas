import { describe, expect, it } from 'vitest'
import { readHostedLoginRequest, readWebReturnTo } from './hosted-login-request'

const clientId = 'design-editor-desktop'
const state = 'AbCdEf1234567890'
const challenge = 'a'.repeat(43)

describe('hosted login request boundary', () => {
  it('AT-SHARE-003 preserves only a return URL on the configured web origin', () => {
    const appUrl = 'https://canvas.example/'
    expect(readWebReturnTo(new URLSearchParams({ return_to: 'https://canvas.example/file/file-1?pageId=page-2' }), appUrl)).toBe('https://canvas.example/file/file-1?pageId=page-2')
    expect(readWebReturnTo(new URLSearchParams({ return_to: 'https://attacker.example/file/file-1' }), appUrl)).toBe(appUrl)
    expect(readWebReturnTo(new URLSearchParams('return_to=https%3A%2F%2Fcanvas.example%2Ffile%2Fa&return_to=https%3A%2F%2Fcanvas.example%2Ffile%2Fb'), appUrl)).toBe(appUrl)
  })

  it('keeps an ordinary web login separate from desktop authorization', () => {
    expect(readHostedLoginRequest(new URLSearchParams(), clientId)).toEqual({ desktop: null, invalidDesktopRequest: false })
  })

  it('accepts one exact desktop authorization request', () => {
    const parameters = new URLSearchParams({ client_id: clientId, state, code_challenge: challenge })
    expect(readHostedLoginRequest(parameters, clientId)).toEqual({
      desktop: { client_id: clientId, state, code_challenge: challenge },
      invalidDesktopRequest: false,
    })
  })

  it.each([
    `client_id=${clientId}&state=${state}&code_challenge=${challenge}&redirect=https%3A%2F%2Fevil.test`,
    `client_id=${clientId}&state=${state}&state=${state}&code_challenge=${challenge}`,
    `client_id=wrong-client&state=${state}&code_challenge=${challenge}`,
    `client_id=${clientId}&state=short&code_challenge=${challenge}`,
  ])('rejects malformed desktop intent instead of falling back to web login: %s', input => {
    expect(readHostedLoginRequest(new URLSearchParams(input), clientId)).toEqual({ desktop: null, invalidDesktopRequest: true })
  })
})
