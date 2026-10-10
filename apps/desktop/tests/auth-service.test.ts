import { describe, expect, it, vi } from 'vitest'
import { authSessionView } from '@canvas/auth'
import type { AuthSessionView } from '@canvas/auth'
import type { ElectronAuthClient } from '@canvas/auth/electron'
import { canAccessAuthenticatedProject, DesktopAuthService } from '../src/main/auth-service'

const target = { scheme: 'com.comp-canvas.desktop', path: '/auth/callback' } as const
const user = { id: 'u1', name: 'Ada', email: 'ada@example.test', avatarUrl: null }
const callbackToken = Buffer.from(JSON.stringify({ identifier: 'A'.repeat(32), state: 'B'.repeat(16) })).toString('base64url')

function client(overrides: Partial<ElectronAuthClient> = {}): ElectronAuthClient {
  return {
    requestSignIn: vi.fn(async () => undefined),
    authenticate: vi.fn(async () => user),
    getUser: vi.fn(async () => null),
    signOut: vi.fn(async () => undefined),
    request: vi.fn(async () => new Response(null, { status: 404 })),
    ...overrides,
  }
}

describe('desktop auth service', () => {
  it('fails project access closed outside the explicit unconfigured development exception', () => {
    expect(canAccessAuthenticatedProject(authSessionView('signed-in', user), false)).toBe(true)
    expect(canAccessAuthenticatedProject(authSessionView('signed-out'), true)).toBe(false)
    expect(canAccessAuthenticatedProject(authSessionView('unavailable'), false)).toBe(false)
    expect(canAccessAuthenticatedProject(authSessionView('unavailable'), true)).toBe(true)
    expect(canAccessAuthenticatedProject(undefined, true)).toBe(false)
  })

  it('keeps an unconfigured build explicitly unavailable', async () => {
    const service = new DesktopAuthService({ client: null, target })
    expect((await service.start()).status).toBe('unavailable')
    expect((await service.requestSignIn(1)).status).toBe('unavailable')
  })

  it('completes one owned browser callback and ignores replay without losing the session', async () => {
    const auth = client()
    const service = new DesktopAuthService({ client: auth, target, now: () => 1_000 })
    const seen: AuthSessionView[] = []
    service.subscribe(state => seen.push(state))
    await service.start()
    expect((await service.requestSignIn(7)).status).toBe('signing-in')
    const callback = `${target.scheme}://auth/callback#token=${callbackToken}`
    expect((await service.handleCallback(callback, 7)).status).toBe('signed-in')
    expect(auth.authenticate).toHaveBeenCalledWith(callbackToken)
    expect((await service.handleCallback(callback, 7)).status).toBe('signed-in')
    expect(auth.authenticate).toHaveBeenCalledTimes(1)
    expect(seen.map(state => state.status)).toEqual(['signed-out', 'signing-in', 'authenticating', 'signed-in'])
    expect(service.rejectCallback().status).toBe('signed-in')
  })

  it('does not consume a callback delivered to another window', async () => {
    const auth = client()
    const service = new DesktopAuthService({ client: auth, target, now: () => 1_000 })
    await service.requestSignIn(7)
    const callback = `${target.scheme}:${target.path}#token=${callbackToken}`
    await expect(service.handleCallback(callback, 8)).rejects.toThrow('another window')
    expect((await service.handleCallback(callback, 7)).status).toBe('signed-in')
  })

  it('keeps one browser sign-in attempt active at a time', async () => {
    const auth = client()
    const service = new DesktopAuthService({ client: auth, target, now: () => 1_000 })
    expect((await service.requestSignIn(7)).status).toBe('signing-in')
    expect((await service.requestSignIn(8)).status).toBe('signing-in')
    expect(auth.requestSignIn).toHaveBeenCalledTimes(1)
  })

  it('expires an old callback before exchange', async () => {
    let now = 1_000
    const auth = client()
    const service = new DesktopAuthService({ client: auth, target, now: () => now })
    await service.requestSignIn(3)
    now += 5 * 60_000 + 1
    expect((await service.handleCallback(`${target.scheme}:${target.path}#token=${callbackToken}`, 3)).status).toBe('callback-expired')
    expect(auth.authenticate).not.toHaveBeenCalled()
  })

  it('clears a pending attempt after a malformed callback', async () => {
    const auth = client()
    const service = new DesktopAuthService({ client: auth, target, now: () => 1_000 })
    await service.requestSignIn(3)
    expect(service.rejectCallback().status).toBe('error')
    expect((await service.requestSignIn(3)).status).toBe('signing-in')
    expect(auth.requestSignIn).toHaveBeenCalledTimes(2)
  })
})
