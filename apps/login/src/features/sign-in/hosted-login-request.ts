import { parseDesktopSignInParameters } from '@canvas/auth'
import type { DesktopSignInRequest } from '@canvas/auth'

export type HostedLoginRequest = Readonly<{
  desktop: DesktopSignInRequest | null
  invalidDesktopRequest: boolean
}>

const desktopParameters = Object.freeze(['client_id', 'state', 'code_challenge'])

export function readHostedLoginRequest(parameters: URLSearchParams, clientId: string): HostedLoginRequest {
  const desktop = parseDesktopSignInParameters(parameters, clientId)
  const hasDesktopParameters = desktopParameters.some(parameter => parameters.has(parameter))
  return Object.freeze({ desktop, invalidDesktopRequest: hasDesktopParameters && !desktop })
}
