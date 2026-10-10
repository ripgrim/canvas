import { createHostedAuthClient } from '@canvas/auth/web'
import { desktopAuthCallbackPath, desktopAuthClientId, desktopAuthProtocolScheme } from '@canvas/auth'
import type { DesktopSignInRequest } from '@canvas/auth'
import { readHostedLoginRequest } from './hosted-login-request'

export type HostedLoginSnapshot = Readonly<{
  request: DesktopSignInRequest | null
  invalidDesktopRequest: boolean
  phase: 'ready' | 'submitting' | 'opening'
  error: string | null
}>

const apiURL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:4320'
const appURL = import.meta.env.VITE_APP_URL || 'http://127.0.0.1:4317/'
const client = createHostedAuthClient({ baseURL: apiURL, protocolScheme: desktopAuthProtocolScheme, callbackPath: desktopAuthCallbackPath, clientID: desktopAuthClientId })
let snapshot: HostedLoginSnapshot = Object.freeze({ request: null, invalidDesktopRequest: false, phase: 'ready', error: null })
const listeners = new Set<() => void>()
let stopRedirect: (() => void) | null = null
let sequence = 0

function publish(next: HostedLoginSnapshot) { snapshot = Object.freeze(next); for (const listener of listeners) listener() }

export const hostedLoginService = Object.freeze({
  start() {
    const currentSequence = ++sequence
    stopRedirect?.()
    const parameters = new URLSearchParams(window.location.search)
    const loginRequest = readHostedLoginRequest(parameters, desktopAuthClientId)
    const request = loginRequest.desktop
    const error = loginRequest.invalidDesktopRequest ? 'Sign-in request is invalid.' : parameters.get('error') ? 'Sign-in could not finish.' : null
    publish({ request, invalidDesktopRequest: loginRequest.invalidDesktopRequest, phase: client.hasDesktopAuthorization() ? 'opening' : 'ready', error })
    stopRedirect = client.startDesktopRedirect()
    if (request && !client.hasDesktopAuthorization()) void client.transferSignedInUser(request).then(transferred => {
      if (currentSequence === sequence && transferred) publish({ request, invalidDesktopRequest: false, phase: 'opening', error: null })
    }).catch(() => undefined)
  },
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot() { return snapshot },
  async signIn() {
    if (snapshot.phase !== 'ready' || snapshot.invalidDesktopRequest) return
    const request = snapshot.request
    publish({ ...snapshot, phase: 'submitting', error: null })
    try {
      if (request) await client.signIn('github', request)
      else await client.signInWeb('github', appURL)
    } catch {
      publish({ request, invalidDesktopRequest: false, phase: 'ready', error: 'Sign-in could not start.' })
    }
  },
})
