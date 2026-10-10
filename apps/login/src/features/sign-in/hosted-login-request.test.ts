import { describe, expect, it } from 'vitest'
import { readHostedLoginRequest } from './hosted-login-request'

const clientId = 'design-editor-desktop'
const state = 'AbCdEf1234567890'
const challenge = 'a'.repeat(43)

describe('hosted login request boundary', () => {
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
