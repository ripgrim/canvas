import type { ElectronAuthClientOptions } from '@canvas/auth/electron'
import { desktopAuthCallbackPath, desktopAuthClientId, desktopAuthProtocolScheme } from '@canvas/auth'

export const desktopAuthScheme = desktopAuthProtocolScheme
export { desktopAuthCallbackPath }

export function desktopAuthClientOptions(environment: NodeJS.ProcessEnv, development: boolean): ElectronAuthClientOptions | null {
  const raw = environment.DESIGN_EDITOR_AUTH_URL?.trim() || (development ? 'http://127.0.0.1:4320' : '')
  if (!raw) return null
  const base = new URL(raw)
  const local = ['127.0.0.1', 'localhost'].includes(base.hostname)
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(development && local && base.protocol === 'http:'))) throw new Error('Invalid hosted auth URL.')
  const baseURL = base.toString().replace(/\/$/, '')
  const signIn = new URL(environment.DESIGN_EDITOR_LOGIN_URL?.trim() || baseURL)
  const signInLocal = ['127.0.0.1', 'localhost'].includes(signIn.hostname)
  if (signIn.username || signIn.password || signIn.search || signIn.hash || (signIn.protocol !== 'https:' && !(development && signInLocal && signIn.protocol === 'http:'))) throw new Error('Invalid hosted login URL.')
  return {
    baseURL,
    signInURL: new URL('/sign-in', signIn.toString()).toString(),
    scheme: desktopAuthScheme,
    callbackPath: desktopAuthCallbackPath,
    clientID: desktopAuthClientId,
    storagePrefix: 'design-editor-auth',
  }
}

export function authCallbackFromArguments(args: readonly string[]): string | null {
  const prefix = `${desktopAuthScheme}:`
  const matches = args.filter(argument => argument.startsWith(prefix))
  return matches.length === 1 ? matches[0]! : null
}
