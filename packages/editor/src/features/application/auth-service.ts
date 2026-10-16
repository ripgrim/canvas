import { authSessionView } from '@canvas/auth'
import type { AuthSessionView } from '@canvas/auth'
import type { EditorAuthApi } from '../../capabilities'
import { trackCanvasEvent } from '@canvas/tracking'
import { failureDetails } from './failure'

let api: EditorAuthApi | undefined
let snapshot = authSessionView('unavailable', null, 'Sign-in is unavailable in this build.')
const serverSnapshot = authSessionView('loading', null, 'Checking your session.')
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0

const retryDelay = 1_000

function clearRetry(): void {
  if (retryTimer === undefined) return
  clearTimeout(retryTimer)
  retryTimer = undefined
}

function publish(next: AuthSessionView): void {
  if (Object.is(snapshot, next)) return
  const previousStatus = snapshot.status
  snapshot = next
  if (next.status === 'signed-in' && (previousStatus === 'signing-in' || previousStatus === 'authenticating')) trackCanvasEvent('sign_in_completed')
  if (next.status === 'signed-out' && previousStatus === 'signed-in') trackCanvasEvent('signed_out')
  for (const listener of listeners) listener()
}

function scheduleRetry(activeGeneration: number): void {
  if (retryTimer !== undefined || activeGeneration !== generation || !api) return
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void refresh(activeGeneration)
  }, retryDelay)
}

function accept(next: AuthSessionView, activeGeneration: number): void {
  if (activeGeneration !== generation) return
  publish(next)
  if (next.status === 'offline') scheduleRetry(activeGeneration)
  else clearRetry()
}

async function refresh(activeGeneration: number): Promise<void> {
  const current = api
  if (!current || activeGeneration !== generation) return
  try {
    accept(await current.getSession(), activeGeneration)
  } catch (error) {
    if (activeGeneration !== generation) return
    const failure = failureDetails(error, 'The auth service could not be reached.')
    trackCanvasEvent('operation_failed', { operation: 'auth_session', error_code: failure.code, error_reference: failure.reference })
    accept(authSessionView('offline', null, failure.message, failure.reference), activeGeneration)
  }
}

export const authSessionService = {
  configure(next: EditorAuthApi | undefined): void {
    generation += 1
    clearRetry()
    api = next
    publish(next ? authSessionView('loading', null, 'Checking your session.') : authSessionView('unavailable', null, 'Sign-in is unavailable in this build.'))
  },
  start(): void {
    generation += 1
    const activeGeneration = generation
    clearRetry()
    unsubscribe?.()
    unsubscribe = api?.subscribe(next => accept(next, activeGeneration))
    void refresh(activeGeneration)
  },
  dispose(): void {
    generation += 1
    clearRetry()
    unsubscribe?.()
    unsubscribe = undefined
    api = undefined
    publish(authSessionView('unavailable', null, 'Sign-in is unavailable in this build.'))
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot(): AuthSessionView { return snapshot },
  getServerSnapshot(): AuthSessionView { return serverSnapshot },
  allowsUnauthenticatedWorkspace(): boolean { return api === undefined || api.allowUnauthenticatedWorkspace === true },
  allowsSignedOutWorkspace(): boolean { return api?.allowSignedOutWorkspace === true },
  retry(): void {
    clearRetry()
    void refresh(generation)
  },
  signIn(): void {
    if (!api) return
    const activeGeneration = generation
    trackCanvasEvent('sign_in_started', { auth_provider: 'github' })
    void api.signInWithGitHub().then(next => accept(next, activeGeneration)).catch(error => {
      const failure = failureDetails(error, 'The auth service could not be reached.')
      trackCanvasEvent('operation_failed', { operation: 'auth_sign_in', error_code: failure.code, error_reference: failure.reference })
      accept(authSessionView('offline', null, failure.message, failure.reference), activeGeneration)
    })
  },
  signOut(): void {
    if (!api) return
    const activeGeneration = generation
    void api.signOut().then(next => accept(next, activeGeneration)).catch(error => {
      const failure = failureDetails(error, 'The auth service could not be reached.')
      trackCanvasEvent('operation_failed', { operation: 'auth_sign_out', error_code: failure.code, error_reference: failure.reference })
      accept(authSessionView('offline', null, failure.message, failure.reference), activeGeneration)
    })
  },
}
