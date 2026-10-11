import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BetterAuthOptions } from 'better-auth'
import { createHostedAuth, databaseURLFromEnvironment, hostedAuthOptionsFromEnvironment } from '../src/server'

const authMocks = vi.hoisted(() => ({
  betterAuth: vi.fn((configuration: unknown) => ({ configuration, handler: vi.fn(), api: { getSession: vi.fn() } })),
  electron: vi.fn((configuration: unknown) => ({ id: 'electron', configuration })),
}))

vi.mock('better-auth', () => ({ betterAuth: authMocks.betterAuth }))
vi.mock('@better-auth/electron', () => ({ electron: authMocks.electron }))

const database = {} as NonNullable<BetterAuthOptions['database']>

describe('hosted auth environment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds the local desktop and GitHub provider configuration', () => {
    const options = hostedAuthOptionsFromEnvironment({
      BETTER_AUTH_URL: 'http://localhost:4317',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
    }, database)
    expect(options).toMatchObject({
      database,
      baseURL: 'http://localhost:4317',
      desktopScheme: 'com.comp-canvas.desktop',
      desktopClientId: 'design-editor-desktop',
      githubClientId: 'github-client',
    })
  })

  it('accepts explicit login origins without trusting arbitrary callers', () => {
    const options = hostedAuthOptionsFromEnvironment({
      BETTER_AUTH_URL: 'https://api.canvas.test',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      LOGIN_URL: 'https://login.canvas.test,https://login.canvas.test',
      APP_URL: 'https://app.canvas.test',
      AUTH_COOKIE_DOMAIN: '.canvas.test',
    }, database)
    expect(options.trustedOrigins).toEqual(['https://login.canvas.test', 'https://app.canvas.test'])
    expect(options.cookieDomain).toBe('.canvas.test')
  })

  it('keeps loopback development host-only and accepts its explicit local origins', () => {
    const options = hostedAuthOptionsFromEnvironment({
      BETTER_AUTH_URL: 'http://127.0.0.1:4320',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      LOGIN_URL: 'http://localhost:4319',
      APP_URL: 'http://[::1]:4317',
    }, database)
    expect(options.cookieDomain).toBeUndefined()
    expect(options.trustedOrigins).toEqual(['http://localhost:4319', 'http://[::1]:4317'])
  })

  it('configures explicit secure same-site cookies for production API and WSS sessions', () => {
    createHostedAuth({
      database,
      baseURL: 'https://api.canvas.test',
      secret: '01234567890123456789012345678901',
      githubClientId: 'github-client',
      githubClientSecret: 'github-secret',
      desktopScheme: 'com.comp-canvas.desktop',
      trustedOrigins: ['https://login.canvas.test', 'https://app.canvas.test'],
      cookieDomain: 'canvas.test',
    })
    expect(authMocks.betterAuth).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://api.canvas.test',
      trustedOrigins: ['com.comp-canvas.desktop:/', 'https://login.canvas.test', 'https://app.canvas.test'],
      advanced: {
        useSecureCookies: true,
        defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
        crossSubDomainCookies: { enabled: true, domain: '.canvas.test' },
      },
    }))
  })

  it('configures host-only non-secure cookies only for loopback HTTP development', () => {
    createHostedAuth({
      database,
      baseURL: 'http://127.0.0.1:4320',
      secret: '01234567890123456789012345678901',
      githubClientId: 'github-client',
      githubClientSecret: 'github-secret',
      desktopScheme: 'com.comp-canvas.desktop',
    })
    expect(authMocks.betterAuth).toHaveBeenCalledWith(expect.objectContaining({
      advanced: {
        useSecureCookies: false,
        defaultCookieAttributes: { httpOnly: true, secure: false, sameSite: 'lax', path: '/' },
      },
    }))
  })

  it('permits the explicitly trusted Vercel surfaces to send the host-only API cookie', () => {
    createHostedAuth({
      database,
      baseURL: 'https://comp-canvas-api.vercel.app',
      secret: '01234567890123456789012345678901',
      githubClientId: 'github-client',
      githubClientSecret: 'github-secret',
      desktopScheme: 'com.comp-canvas.desktop',
      trustedOrigins: ['https://comp-canvas-login.vercel.app', 'https://comp-canvas-web.vercel.app'],
    })
    expect(authMocks.betterAuth).toHaveBeenCalledWith(expect.objectContaining({
      advanced: {
        useSecureCookies: true,
        defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'none', path: '/' },
      },
    }))
  })

  it.each([
    ['BETTER_AUTH_URL', 'http://api.canvas.test'],
    ['BETTER_AUTH_URL', 'https://api.canvas.test/unexpected-path'],
    ['LOGIN_URL', 'javascript:alert(1)'],
    ['APP_URL', 'https://user:password@app.canvas.test'],
    ['AUTH_TRUSTED_ORIGINS', 'https://app.canvas.test?redirect=https://evil.test'],
    ['AUTH_COOKIE_DOMAIN', '.evil.test'],
    ['AUTH_COOKIE_DOMAIN', 'localhost'],
    ['AUTH_COOKIE_DOMAIN', '127.0.0.1'],
  ])('rejects an invalid hosted origin in %s', (name, value) => {
    expect(() => hostedAuthOptionsFromEnvironment({
      BETTER_AUTH_URL: 'https://api.canvas.test',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      [name]: value,
    }, database)).toThrow(/origin|HTTPS|AUTH_COOKIE_DOMAIN/)
  })

  it.each([
    { LOGIN_URL: 'http://127.0.0.1:4319' },
    { AUTH_TRUSTED_ORIGINS: 'https://unrelated.test' },
  ])('rejects a production trusted origin outside the secure shared-cookie boundary', environment => {
    expect(() => hostedAuthOptionsFromEnvironment({
      BETTER_AUTH_URL: 'https://api.canvas.test',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      AUTH_COOKIE_DOMAIN: '.canvas.test',
      ...environment,
    }, database)).toThrow(/HTTPS|contained/)
  })

  it('revalidates direct factory options instead of trusting their caller', () => {
    expect(() => createHostedAuth({
      database,
      baseURL: 'https://api.canvas.test',
      secret: '01234567890123456789012345678901',
      githubClientId: 'github-client',
      githubClientSecret: 'github-secret',
      desktopScheme: 'com.comp-canvas.desktop',
      trustedOrigins: ['http://127.0.0.1:4319'],
      cookieDomain: '.canvas.test',
    })).toThrow('HTTPS')
  })

  it('rejects a missing required server credential', () => {
    expect(() => hostedAuthOptionsFromEnvironment({}, database)).toThrow('Missing BETTER_AUTH_URL.')
  })

  it('requires an explicit PostgreSQL URL instead of falling back to libpq', () => {
    expect(() => databaseURLFromEnvironment({ PGHOST: 'production.pg.psdb.cloud' })).toThrow('Missing DATABASE_URL.')
    expect(() => databaseURLFromEnvironment({ DATABASE_URL: 'mysql://localhost/design_editor' })).toThrow('must use PostgreSQL')
  })
})
