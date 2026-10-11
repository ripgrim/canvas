import { afterEach, describe, expect, it, vi } from 'vitest'
import { authSessionView } from '@canvas/auth'
import type { EditorAuthApi } from '../../capabilities'
import { authSessionService } from './auth-service'

afterEach(() => authSessionService.dispose())

describe('renderer auth session service', () => {
  it('only permits an unauthenticated workspace when no desktop auth API exists', () => {
    expect(authSessionService.getServerSnapshot().status).toBe('loading')
    authSessionService.configure(undefined)
    expect(authSessionService.getSnapshot().status).toBe('unavailable')
    expect(authSessionService.allowsUnauthenticatedWorkspace()).toBe(true)
    authSessionService.configure({
      allowSignedOutWorkspace: true,
      getSession: vi.fn(async () => authSessionView('unavailable')),
      signInWithGitHub: vi.fn(async () => authSessionView('unavailable')),
      signOut: vi.fn(async () => authSessionView('unavailable')),
      subscribe: () => () => undefined,
    })
    expect(authSessionService.allowsUnauthenticatedWorkspace()).toBe(false)
    expect(authSessionService.allowsSignedOutWorkspace()).toBe(true)
  })

  it('exposes only the session view and follows main-process notifications', async () => {
    let notify: ((session: ReturnType<typeof authSessionView>) => void) | undefined
    const api: EditorAuthApi = {
      getSession: vi.fn(async () => authSessionView('signed-out')),
      signInWithGitHub: vi.fn(async () => authSessionView('signing-in')),
      signOut: vi.fn(async () => authSessionView('signed-out')),
      subscribe: listener => { notify = listener; return () => { notify = undefined } },
    }
    authSessionService.configure(api)
    authSessionService.start()
    await vi.waitFor(() => expect(authSessionService.getSnapshot().status).toBe('signed-out'))
    notify?.(authSessionView('signed-in', { id: 'u1', name: 'Ada', email: 'ada@example.test', avatarUrl: null }))
    expect(authSessionService.getSnapshot()).toMatchObject({ status: 'signed-in', user: { id: 'u1', name: 'Ada' } })
    expect(Object.keys(api).sort()).toEqual(['getSession', 'signInWithGitHub', 'signOut', 'subscribe'])
  })
})
