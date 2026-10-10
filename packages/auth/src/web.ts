import { electronProxyClient } from '@better-auth/electron/proxy'
import { createAuthClient } from 'better-auth/client'
import type { DesktopSignInRequest } from './index'

export type HostedAuthProvider = 'github'

export type HostedAuthClientOptions = Readonly<{
  baseURL?: string
  protocolScheme: string
  callbackPath: string
  clientID: string
}>

export type HostedAuthClient = Readonly<{
  signIn(provider: HostedAuthProvider, request: DesktopSignInRequest): Promise<void>
  transferSignedInUser(request: DesktopSignInRequest): Promise<boolean>
  startDesktopRedirect(): () => void
  hasDesktopAuthorization(): boolean
}>

function callbackURL(request: DesktopSignInRequest): string {
  const url = new URL('/sign-in', window.location.origin)
  url.searchParams.set('client_id', request.client_id)
  url.searchParams.set('state', request.state)
  url.searchParams.set('code_challenge', request.code_challenge)
  return url.toString()
}

export function createHostedAuthClient(options: HostedAuthClientOptions): HostedAuthClient {
  const proxy = electronProxyClient({
    protocol: { scheme: options.protocolScheme },
    callbackPath: options.callbackPath,
    clientID: options.clientID,
  })
  const client = createAuthClient({
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    plugins: [proxy],
  })
  return Object.freeze({
    signIn: async (provider, request) => {
      const redirect = callbackURL(request)
      const result = await client.signIn.social({
        provider,
        callbackURL: redirect,
        errorCallbackURL: redirect,
        fetchOptions: { query: request },
      })
      if (result.error) throw new Error(result.error.message ?? result.error.statusText)
    },
    transferSignedInUser: async (request) => {
      const session = await client.getSession()
      if (session.error || !session.data?.user) return false
      const result = await client.electron.transferUser({ fetchOptions: { query: request } })
      if (result.error) throw new Error(result.error.message ?? result.error.statusText)
      return Boolean(result.data?.electron_authorization_code)
    },
    startDesktopRedirect: () => {
      const interval = client.ensureElectronRedirect({ timeout: 30_000, interval: 100 })
      return () => clearInterval(interval)
    },
    hasDesktopAuthorization: () => Boolean(client.electron.getAuthorizationCode()),
  })
}
