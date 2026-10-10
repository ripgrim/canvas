import { createHostedAuthClient } from '@canvas/auth/web'
import type { DesktopSignInRequest } from '@canvas/auth'
import { desktopAuthCallbackPath, desktopAuthClientId, desktopAuthProtocolScheme, parseDesktopSignInParameters } from '@canvas/auth'

const client = createHostedAuthClient({
  protocolScheme: desktopAuthProtocolScheme,
  callbackPath: desktopAuthCallbackPath,
  clientID: desktopAuthClientId,
})

type HostedAuthSnapshot = Readonly<{
  openingDesktop: boolean
  request: DesktopSignInRequest | null
  providerError: string | null
}>

let snapshot: HostedAuthSnapshot = Object.freeze({ openingDesktop: false, request: null, providerError: null })
const listeners = new Set<() => void>()
let stopRedirect: (() => void) | undefined
let startSequence = 0

function publish(next: HostedAuthSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function providerError(parameters: URLSearchParams): string | null {
  const errors = parameters.getAll('error')
  if (errors.length !== 1) return null
  if (errors[0] === 'access_denied') return 'Sign-in was canceled.'
  return 'Sign-in could not finish. Try again.'
}

export const hostedAuthService = {
  start(): void {
    const sequence = ++startSequence
    stopRedirect?.()
    stopRedirect = undefined
    publish(Object.freeze({ openingDesktop: false, request: null, providerError: null }))
    if (typeof window === 'undefined' || window.location.pathname !== '/sign-in') return
    const parameters = new URLSearchParams(window.location.search)
    const request = parseDesktopSignInParameters(parameters, desktopAuthClientId)
    const error = providerError(parameters)
    if (client.hasDesktopAuthorization()) publish(Object.freeze({ openingDesktop: true, request, providerError: error }))
    else publish(Object.freeze({ openingDesktop: false, request, providerError: error }))
    stopRedirect = client.startDesktopRedirect()
    if (request && !client.hasDesktopAuthorization()) void client.transferSignedInUser(request).then(transferred => {
      if (sequence === startSequence && transferred) publish(Object.freeze({ openingDesktop: true, request, providerError: error }))
    }).catch(() => undefined)
  },
  stop(): void {
    startSequence += 1
    stopRedirect?.()
    stopRedirect = undefined
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot(): HostedAuthSnapshot { return snapshot },
  signInWithGitHub(request: DesktopSignInRequest): Promise<void> { return client.signIn('github', request) },
}
