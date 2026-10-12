import { electronClient } from '@better-auth/electron/client'
import { createAuthClient } from 'better-auth/client'
import type { BetterAuthClientPlugin } from 'better-auth/client'
import Conf from 'conf'
import electron from 'electron'
import WebSocket from 'ws'
import { createHash, randomBytes } from 'node:crypto'
import { authUserView } from './index.js'
import type { AuthSessionView } from './index.js'
import { decodeDesktopAuthorization } from './electron-callback.js'
import { resolveAuthenticatedApiPath } from './api-target.js'
import { createElectronSessionStorage, migrateLegacyEncryptedAuthStorage } from './electron-storage.js'
import type { AuthStorageBackend } from './electron-storage.js'

export { decodeDesktopAuthorization } from './electron-callback.js'
export { createElectronSessionStorage, migrateLegacyEncryptedAuthStorage } from './electron-storage.js'
export type { AuthStorage, AuthStorageBackend, AuthStorageProtection, ElectronSessionStorageOptions } from './electron-storage.js'

const { app, safeStorage, shell } = electron

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
  request(path: string, init?: RequestInit): Promise<Response>
  createWebSocket(url: string, protocol: string, origin: string): WebSocket
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

function protectedPersistentStorage(storagePrefix: string) {
  const config = new Conf<Record<string, string>>({
    cwd: app.getPath('userData'),
    projectName: app.getName(),
    projectVersion: app.getVersion(),
  })
  const backend: AuthStorageBackend = {
    get: name => config.get(name),
    set: (name, value) => { config.set(name, value) },
  }
  const storageOptions = { backend, protection: safeStorage, platform: process.platform }
  const protectedStorage = createElectronSessionStorage(storageOptions)
  migrateLegacyEncryptedAuthStorage(storageOptions, protectedStorage, [
    `${storagePrefix}.cookie`,
    `${storagePrefix}.local_cache`,
  ])
  return protectedStorage
}

/** Main-process-only Better Auth client. The returned facade cannot expose cookies, tokens, or the underlying client. */
export function createElectronAuthClient(options: ElectronAuthClientOptions): ElectronAuthClient {
  const storagePrefix = options.storagePrefix ?? 'design-editor-auth'
  const plugin = electronClient({
    signInURL: options.signInURL,
    protocol: { scheme: options.scheme },
    callbackPath: options.callbackPath,
    clientID: options.clientID ?? 'design-editor-desktop',
    storage: protectedPersistentStorage(storagePrefix),
    storagePrefix,
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
      const user = authUserView(result.data?.user)
      if (!user) throw new Error('The auth server returned an invalid user.')
      return user
    },
    getUser: async () => {
      const result = await client.getSession()
      if (result.error) throw new Error(result.error.message ?? result.error.statusText)
      return authUserView(result.data?.user)
    },
    signOut: async () => {
      const result = await client.signOut()
      if (result.error) throw new Error(result.error.message ?? result.error.statusText)
    },
    request: async (path, init = {}) => {
      const target = resolveAuthenticatedApiPath(options.baseURL, path)
      let response: Response | undefined
      await client.$fetch(target, {
        ...init,
        onResponse: ({ response: received }: { response: Response }) => { response = received.clone() },
      } as never)
      if (!response) throw new Error('Authenticated API returned no response.')
      return response
    },
    createWebSocket: (url: string, protocol: string, origin: string) => {
      const target = new URL(url)
      const source = new URL(origin)
      const targetLocal = target.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      if ((target.protocol !== 'wss:' && !targetLocal) || target.username || target.password || target.hash) throw new Error('Invalid collaboration WebSocket URL.')
      if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin || source.username || source.password) throw new Error('Invalid collaboration request origin.')
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(protocol)) throw new Error('Invalid collaboration WebSocket protocol.')
      return new WebSocket(target, protocol, {
        headers: {
          Cookie: client.getCookie(),
          Origin: source.origin,
          'User-Agent': app.userAgentFallback,
        },
      })
    },
  })
}
