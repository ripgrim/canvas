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

export function readWebReturnTo(parameters: URLSearchParams, appUrl: string): string {
  const fallback = new URL(appUrl)
  const values = parameters.getAll('return_to')
  if (values.length !== 1) return fallback.toString()
  try {
    const target = new URL(values[0]!)
    return target.origin === fallback.origin && ['http:', 'https:'].includes(target.protocol) ? target.toString() : fallback.toString()
  } catch { return fallback.toString() }
}
