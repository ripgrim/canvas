export type AuthStatus = 'unavailable' | 'loading' | 'signed-out' | 'signing-in' | 'authenticating' | 'signed-in' | 'callback-expired' | 'denied' | 'offline' | 'revoked' | 'error'

export const desktopAuthProtocolScheme = 'com.comp-canvas.desktop'
export const desktopAuthCallbackPath = '/auth/callback'
export const desktopAuthClientId = 'design-editor-desktop'

export type AuthSessionView = Readonly<{
  status: AuthStatus
  user: Readonly<{ id: string; name: string; email: string; avatarUrl: string | null }> | null
  message: string | null
}>

export type NativeAuthAttempt = Readonly<{
  id: string
  state: string
  nonce: string
  codeVerifier: string
  codeChallenge: string
  ownerWindowId: number
  createdAt: number
  expiresAt: number
  consumedAt: number | null
}>

export type NativeAuthCallback = Readonly<{ code: string; state: string; issuer: string | null }>

export type NativeAuthTarget = Readonly<{ scheme: string; path: string }>

export type NativeElectronAuthCallback = Readonly<{ token: string }>

export type DesktopSignInRequest = Readonly<{
  client_id: string
  state: string
  code_challenge: string
}>

export type NativeAuthAttemptOptions = Readonly<{
  ownerWindowId: number
  now?: number
  ttlMs?: number
  crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'>
}>

const encoder = new TextEncoder()
const consumedAttempts = new WeakSet<object>()
const base64Url = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const randomToken = (crypto: Pick<Crypto, 'getRandomValues'>, size: number) => {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

function equalSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function validateTarget(target: NativeAuthTarget): void {
  if (!/^[a-z][a-z0-9+.-]{2,63}$/.test(target.scheme) || !target.path.startsWith('/') || target.path.includes('\\') || target.path.includes('..')) {
    throw new Error('Invalid native callback target.')
  }
}

function canonicalBase64Url(value: string): boolean {
  const match = /^([A-Za-z0-9_-]+)(={0,2})$/.exec(value)
  if (!match) return false
  const data = match[1]!
  const padding = match[2]!
  const remainder = data.length % 4
  if (remainder === 1) return false
  const expectedPadding = remainder === 0 ? 0 : 4 - remainder
  if (padding && (padding.length !== expectedPadding || value.length % 4 !== 0)) return false
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(data.at(-1)!)
  if (remainder === 2 && (last & 0b1111) !== 0) return false
  if (remainder === 3 && (last & 0b11) !== 0) return false
  return true
}

export async function createNativeAuthAttempt(options: NativeAuthAttemptOptions): Promise<NativeAuthAttempt> {
  const crypto = options.crypto ?? globalThis.crypto
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') throw new Error('Secure random generation is unavailable.')
  if (!Number.isSafeInteger(options.ownerWindowId) || options.ownerWindowId < 1) throw new Error('Invalid auth window owner.')
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? 5 * 60_000
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 15 * 60_000) throw new Error('Invalid auth attempt lifetime.')
  const codeVerifier = randomToken(crypto, 48)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier)))
  return {
    id: randomToken(crypto, 24),
    state: randomToken(crypto, 32),
    nonce: randomToken(crypto, 32),
    codeVerifier,
    codeChallenge: base64Url(digest),
    ownerWindowId: options.ownerWindowId,
    createdAt: now,
    expiresAt: now + ttlMs,
    consumedAt: null,
  }
}

export function parseNativeAuthCallback(input: string, target: NativeAuthTarget): NativeAuthCallback {
  validateTarget(target)
  if (input.length > 4096) throw new Error('Auth callback is too large.')
  const url = new URL(input)
  if (url.protocol !== `${target.scheme}:` || url.hostname || url.username || url.password || url.port || url.pathname !== target.path || url.hash) {
    throw new Error('Auth callback target does not match.')
  }
  const allowed = new Set(['code', 'state', 'iss'])
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new Error('Auth callback has unexpected parameters.')
  const values = (key: string) => url.searchParams.getAll(key)
  if (values('code').length !== 1 || values('state').length !== 1 || values('iss').length > 1) throw new Error('Auth callback parameters are invalid.')
  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''
  const issuer = url.searchParams.get('iss')
  if (!code || code.length > 2048 || !state || state.length > 256 || (issuer !== null && issuer.length > 512)) throw new Error('Auth callback parameters are invalid.')
  return { code, state, issuer }
}


export function parseNativeElectronAuthCallback(input: string, target: NativeAuthTarget): NativeElectronAuthCallback {
  validateTarget(target)
  if (input.length > 8192) throw new Error('Auth callback is too large.')
  const url = new URL(input)
  const callbackPath = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname
  if (url.protocol !== `${target.scheme}:` || url.username || url.password || url.port || callbackPath !== target.path || url.search) {
    throw new Error('Auth callback target does not match.')
  }
  if (!url.hash.startsWith('#token=')) throw new Error('Auth callback token is missing.')
  const token = url.hash.slice('#token='.length)
  if (!token || token.length > 4096 || !canonicalBase64Url(token)) throw new Error('Auth callback token is invalid.')
  return { token }
}

export function parseDesktopSignInParameters(parameters: URLSearchParams, clientId: string): DesktopSignInRequest | null {
  const allowed = new Set(['client_id', 'state', 'code_challenge', 'error'])
  for (const key of parameters.keys()) if (!allowed.has(key) || parameters.getAll(key).length !== 1) return null
  return parseDesktopSignInRequest(Object.fromEntries(parameters), clientId)
}

export function parseDesktopSignInRequest(input: Readonly<Record<string, unknown>>, clientId: string): DesktopSignInRequest | null {
  if (!clientId || Object.keys(input).some(key => !['client_id', 'state', 'code_challenge', 'error'].includes(key))) return null
  const candidate = input as Record<string, unknown>
  if (candidate.client_id !== clientId || typeof candidate.state !== 'string' || !/^[A-Za-z0-9]{16}$/.test(candidate.state) || typeof candidate.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(candidate.code_challenge)) return null
  if (candidate.error !== undefined && (typeof candidate.error !== 'string' || candidate.error.length > 160)) return null
  return Object.freeze({ client_id: candidate.client_id, state: candidate.state, code_challenge: candidate.code_challenge })
}

export function authSessionView(status: AuthStatus, user: AuthSessionView['user'] = null, message: string | null = null): AuthSessionView {
  if (status === 'signed-in' && !user) throw new Error('A signed-in session needs a user.')
  if (status !== 'signed-in' && user) throw new Error('Only a signed-in session can expose a user.')
  return Object.freeze({ status, user, message })
}

export function consumeNativeAuthCallback(attempt: NativeAuthAttempt, callback: NativeAuthCallback, ownerWindowId: number, now = Date.now()): NativeAuthAttempt {
  if (attempt.consumedAt !== null || consumedAttempts.has(attempt)) throw new Error('Auth callback was already used.')
  if (!Number.isSafeInteger(now) || now < attempt.createdAt || now > attempt.expiresAt) throw new Error('Auth callback expired.')
  if (ownerWindowId !== attempt.ownerWindowId) throw new Error('Auth callback belongs to another window.')
  if (!equalSecret(callback.state, attempt.state)) throw new Error('Auth callback state does not match.')
  consumedAttempts.add(attempt)
  return { ...attempt, consumedAt: now }
}

export class NativeAuthAttemptStore {
  private readonly attempts = new Map<string, NativeAuthAttempt>()

  async create(options: NativeAuthAttemptOptions): Promise<NativeAuthAttempt> {
    const attempt = await createNativeAuthAttempt(options)
    this.attempts.set(attempt.id, attempt)
    return attempt
  }

  consume(id: string, callback: NativeAuthCallback, ownerWindowId: number, now = Date.now()): NativeAuthAttempt {
    const attempt = this.attempts.get(id)
    if (!attempt) throw new Error('Auth attempt was not found or was already used.')
    const consumed = consumeNativeAuthCallback(attempt, callback, ownerWindowId, now)
    this.attempts.delete(id)
    return consumed
  }

  cancel(id: string): void {
    this.attempts.delete(id)
  }

  clear(): void {
    this.attempts.clear()
  }
}
