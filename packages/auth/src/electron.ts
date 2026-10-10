import { electronClient } from '@better-auth/electron/client'
import { storage } from '@better-auth/electron/storage'
import { createAuthClient } from 'better-auth/client'
import type { BetterAuthClientPlugin } from 'better-auth/client'
import electron from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import type { AuthSessionView } from './index'
import { decodeDesktopAuthorization } from './electron-callback.js'

export { decodeDesktopAuthorization } from './electron-callback.js'

const { shell } = electron

export type ElectronAuthClientOptions = Readonly<{
  baseURL: string
  signInURL: string
  scheme: string
  callbackPath: string
  clientID?: string
  storagePrefix?: string
}>

export type ElectronAuthClient = Readonly<{
  requestSignIn(): Promise<void>
  authenticate(token: string): Promise<AuthSessionView['user']>
  getUser(): Promise<AuthSessionView['user']>
  signOut(): Promise<void>
}>

type PendingAuthorization = Readonly<{ state: string; codeVerifier: string }>

const stateAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomState(): string {
  let value = ''
  while (value.length < 16) {
    for (const byte of randomBytes(16)) {
      if (byte >= 248) continue
      value += stateAlphabet[byte % stateAlphabet.length]
      if (value.length === 16) break
    }
  }
  return value
}

function authorizationAttempt(): PendingAuthorization & Readonly<{ codeChallenge: string }> {
  const codeVerifier = randomBytes(32).toString('base64url')
  return {
    state: randomState(),
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  }
}

function userView(value: unknown): AuthSessionView['user'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const user = value as Record<string, unknown>
  if (typeof user.id !== 'string' || typeof user.name !== 'string' || typeof user.email !== 'string') return null
  const avatarUrl = typeof user.image === 'string' && /^https:\/\//.test(user.image) ? user.image : null
  return Object.freeze({ id: user.id, name: user.name, email: user.email, avatarUrl })
}

/** Main-process-only Better Auth client. The returned facade cannot expose cookies, tokens, or the underlying client. */
export function createElectronAuthClient(options: ElectronAuthClientOptions): ElectronAuthClient {
  const plugin = electronClient({
    signInURL: options.signInURL,
    protocol: { scheme: options.scheme },
    callbackPath: options.callbackPath,
    clientID: options.clientID ?? 'design-editor-desktop',
    storage: storage(),
    storagePrefix: options.storagePrefix ?? 'design-editor-auth',
    channelPrefix: 'design-editor-internal-auth',
    userImageProxy: { enabled: false },
  })
  // Better Auth 1.7.7 and its Electron package expose equivalent fetch-plugin types through separate declaration paths.
  const compatiblePlugin = plugin as typeof plugin & BetterAuthClientPlugin
  const client = createAuthClient({
    baseURL: options.baseURL,
    plugins: [compatiblePlugin],
  })
  let pendingAuthorization: PendingAuthorization | null = null
  return Object.freeze({
    requestSignIn: async () => {
      const attempt = authorizationAttempt()
      const url = new URL(options.signInURL)
      url.searchParams.set('client_id', options.clientID ?? 'design-editor-desktop')
      url.searchParams.set('code_challenge', attempt.codeChallenge)
      url.searchParams.set('state', attempt.state)
      pendingAuthorization = attempt
      try {
        await shell.openExternal(url.toString(), { activate: true })
      } catch (error) {
        if (pendingAuthorization?.state === attempt.state) pendingAuthorization = null
        throw error
      }
    },
    authenticate: async (token: string) => {
      const authorization = decodeDesktopAuthorization(token)
      const attempt = pendingAuthorization
      pendingAuthorization = null
      if (!attempt || attempt.state !== authorization.state) throw new Error('Desktop auth attempt was not found.')
      const result = await client.$fetch<{ user?: unknown }>('/electron/token', {
        method: 'POST',
        body: {
          token: authorization.identifier,
          state: authorization.state,
          code_verifier: attempt.codeVerifier,
        },
      })
      if (result.error) throw new Error(result.error.message ?? result.error.statusText)
      const user = userView(result.data?.user)
      if (!user) throw new Error('The auth server returned an invalid user.')
      return user
    },
    getUser: async () => {
      const result = await client.getSession()
      if (result.error) throw new Error(result.error.message ?? result.error.statusText)
      return userView(result.data?.user)
    },
    signOut: async () => {
      const result = await client.signOut()
      if (result.error) throw new Error(result.error.message ?? result.error.statusText)
    },
  })
}
