import { describe, expect, it } from 'vitest'
import type { BetterAuthOptions } from 'better-auth'
import { databaseURLFromEnvironment, hostedAuthOptionsFromEnvironment } from '../src/server'

const database = {} as NonNullable<BetterAuthOptions['database']>

describe('hosted auth environment', () => {
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

  it('rejects a missing required server credential', () => {
    expect(() => hostedAuthOptionsFromEnvironment({}, database)).toThrow('Missing BETTER_AUTH_URL.')
  })

  it('requires an explicit PostgreSQL URL instead of falling back to libpq', () => {
    expect(() => databaseURLFromEnvironment({ PGHOST: 'production.pg.psdb.cloud' })).toThrow('Missing DATABASE_URL.')
    expect(() => databaseURLFromEnvironment({ DATABASE_URL: 'mysql://localhost/design_editor' })).toThrow('must use PostgreSQL')
  })
})
