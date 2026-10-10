import { authSessionView, parseNativeElectronAuthCallback } from '@canvas/auth'
import type { AuthSessionView, NativeAuthTarget } from '@canvas/auth'
import type { ElectronAuthClient } from '@canvas/auth/electron'

type PendingAuth = Readonly<{ ownerWindowId: number; expiresAt: number }>

export type DesktopAuthServiceOptions = Readonly<{
  client: ElectronAuthClient | null
  target: NativeAuthTarget
  now?: () => number
}>

function failureState(error: unknown): AuthSessionView {
  const message = error instanceof Error ? error.message : 'Authentication could not finish.'
  const normalized = message.toLowerCase()
  if (normalized.includes('denied') || normalized.includes('access_denied')) return authSessionView('denied', null, 'GitHub sign-in was denied.')
  if (normalized.includes('fetch') || normalized.includes('network') || normalized.includes('offline')) return authSessionView('offline', null, 'The auth service could not be reached.')
  if (normalized.includes('revoked') || normalized.includes('unauthorized')) return authSessionView('revoked', null, 'This session is no longer valid.')
  if (normalized.includes('attempt was not found')) return authSessionView('callback-expired', null, 'This sign-in attempt is no longer active. Start again from the desktop app.')
  if (normalized.includes('callback is invalid')) return authSessionView('error', null, 'The sign-in response was invalid. Start again from the desktop app.')
  return authSessionView('error', null, 'Authentication could not finish. Try again.')
}

export function canAccessAuthenticatedProject(session: AuthSessionView | undefined, development: boolean): boolean {
  return session?.status === 'signed-in' || (development && session?.status === 'unavailable')
}

export class DesktopAuthService {
  private readonly client: ElectronAuthClient | null
  private readonly target: NativeAuthTarget
  private readonly now: () => number
  private readonly listeners = new Set<(state: AuthSessionView) => void>()
  private state: AuthSessionView
  private pending: PendingAuth | null = null

  constructor(options: DesktopAuthServiceOptions) {
    this.client = options.client
    this.target = options.target
    this.now = options.now ?? Date.now
    this.state = this.client ? authSessionView('loading', null, 'Checking your session.') : authSessionView('unavailable', null, 'Sign-in needs a configured hosted auth service.')
  }

  subscribe(listener: (state: AuthSessionView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSession(): AuthSessionView { return this.state }

  private publish(state: AuthSessionView): AuthSessionView {
    this.state = state
    for (const listener of this.listeners) listener(state)
    return state
  }

  async start(): Promise<AuthSessionView> {
    if (!this.client) return this.state
    try {
      const user = await this.client.getUser()
      return this.publish(user ? authSessionView('signed-in', user) : authSessionView('signed-out'))
    } catch (error) {
      return this.publish(failureState(error))
    }
  }

  async requestSignIn(ownerWindowId: number): Promise<AuthSessionView> {
    if (!this.client) return this.state
    if (!Number.isSafeInteger(ownerWindowId) || ownerWindowId < 1) throw new Error('Invalid auth window owner.')
    if (this.pending && this.now() <= this.pending.expiresAt) return this.state
    this.pending = { ownerWindowId, expiresAt: this.now() + 5 * 60_000 }
    this.publish(authSessionView('signing-in', null, 'Finish signing in in your browser.'))
    try {
      await this.client.requestSignIn()
      return this.state
    } catch (error) {
      this.pending = null
      return this.publish(failureState(error))
    }
  }

  async handleCallback(url: string, ownerWindowId: number): Promise<AuthSessionView> {
    const callback = parseNativeElectronAuthCallback(url, this.target)
    const pending = this.pending
    const now = this.now()
    if (!pending || now > pending.expiresAt) {
      this.pending = null
      if (this.state.status === 'signed-in') return this.state
      return this.publish(authSessionView('callback-expired', null, 'This sign-in link expired. Start again from the desktop app.'))
    }
    if (pending.ownerWindowId !== ownerWindowId) throw new Error('Auth callback belongs to another window.')
    this.pending = null
    if (!this.client) return this.publish(authSessionView('unavailable', null, 'Sign-in needs a configured hosted auth service.'))
    this.publish(authSessionView('authenticating', null, 'Finishing sign in.'))
    try {
      const user = await this.client.authenticate(callback.token)
      if (!user) throw new Error('The auth server did not return a user.')
      return this.publish(authSessionView('signed-in', user))
    } catch (error) {
      return this.publish(failureState(error))
    }
  }

  async signOut(): Promise<AuthSessionView> {
    this.pending = null
    if (!this.client) return this.state
    try {
      await this.client.signOut()
      return this.publish(authSessionView('signed-out'))
    } catch (error) {
      return this.publish(failureState(error))
    }
  }

  rejectCallback(): AuthSessionView {
    this.pending = null
    if (this.state.status === 'signed-in') return this.state
    return this.publish(authSessionView('error', null, 'The sign-in response was invalid. Start again from the desktop app.'))
  }

  dispose(): void {
    this.pending = null
    this.listeners.clear()
  }
}
