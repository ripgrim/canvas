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

function publish(next: AuthSessionView): void {
  if (Object.is(snapshot, next)) return
  const previousStatus = snapshot.status
  snapshot = next
  if (next.status === 'signed-in' && (previousStatus === 'signing-in' || previousStatus === 'authenticating')) trackCanvasEvent('sign_in_completed')
  if (next.status === 'signed-out' && previousStatus === 'signed-in') trackCanvasEvent('signed_out')
  for (const listener of listeners) listener()
}

export const authSessionService = {
  configure(next: EditorAuthApi | undefined): void {
    api = next
    publish(next ? authSessionView('loading', null, 'Checking your session.') : authSessionView('unavailable', null, 'Sign-in is unavailable in this build.'))
  },
  start(): void {
    unsubscribe?.()
    unsubscribe = api?.subscribe(publish)
    if (api) void api.getSession().then(publish).catch(error => {
      const failure = failureDetails(error, 'The auth service could not be reached.')
      trackCanvasEvent('operation_failed', { operation: 'auth_session', error_code: failure.code, error_reference: failure.reference })
      publish(authSessionView('offline', null, failure.message, failure.reference))
    })
  },
  dispose(): void {
    unsubscribe?.()
    unsubscribe = undefined
    api = undefined
    publish(authSessionView('unavailable', null, 'Sign-in is unavailable in this build.'))
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot(): AuthSessionView { return snapshot },
  getServerSnapshot(): AuthSessionView { return serverSnapshot },
  allowsUnauthenticatedWorkspace(): boolean { return api === undefined },
  allowsSignedOutWorkspace(): boolean { return api?.allowSignedOutWorkspace === true },
  signIn(): void {
    if (!api) return
    trackCanvasEvent('sign_in_started', { auth_provider: 'github' })
    void api.signInWithGitHub().then(publish).catch(error => {
      const failure = failureDetails(error, 'The auth service could not be reached.')
      trackCanvasEvent('operation_failed', { operation: 'auth_sign_in', error_code: failure.code, error_reference: failure.reference })
      publish(authSessionView('offline', null, failure.message, failure.reference))
    })
  },
  signOut(): void {
    if (!api) return
    void api.signOut().then(publish).catch(error => {
      const failure = failureDetails(error, 'The auth service could not be reached.')
      trackCanvasEvent('operation_failed', { operation: 'auth_sign_out', error_code: failure.code, error_reference: failure.reference })
      publish(authSessionView('offline', null, failure.message, failure.reference))
    })
  },
}
