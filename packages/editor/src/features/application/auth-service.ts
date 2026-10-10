import { authSessionView } from '@canvas/auth'
import type { AuthSessionView } from '@canvas/auth'
import type { EditorAuthApi } from '../../capabilities'

let api: EditorAuthApi | undefined
let snapshot = authSessionView('unavailable', null, 'Sign-in is unavailable in this build.')
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined

function publish(next: AuthSessionView): void {
  if (Object.is(snapshot, next)) return
  snapshot = next
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
    if (api) void api.getSession().then(publish).catch(() => publish(authSessionView('offline', null, 'The auth service could not be reached.')))
  },
  dispose(): void {
    unsubscribe?.()
    unsubscribe = undefined
    api = undefined
    publish(authSessionView('unavailable', null, 'Sign-in is unavailable in this build.'))
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot(): AuthSessionView { return snapshot },
  allowsUnauthenticatedWorkspace(): boolean { return api === undefined },
  signIn(): void {
    if (!api) return
    void api.signInWithGitHub().then(publish).catch(() => publish(authSessionView('offline', null, 'The auth service could not be reached.')))
  },
  signOut(): void {
    if (!api) return
    void api.signOut().then(publish).catch(() => publish(authSessionView('offline', null, 'The auth service could not be reached.')))
  },
}
