import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertLocalDatabaseURL, loadLocalAuthEnvironment, localAuthEnvironment } from '../scripts/local-auth-cli.mjs'

describe('local auth database command', () => {
  it('accepts only the owned Docker database', () => {
    expect(assertLocalDatabaseURL('postgresql://design_editor:design_editor_local@127.0.0.1:54329/design_editor').port).toBe('54329')
  })

  it('rejects a production database before invoking the auth CLI', () => {
    expect(() => assertLocalDatabaseURL('postgresql://user:secret@production.pg.psdb.cloud:6432/postgres')).toThrow('Local database commands require the Docker database')
  })

  it('rejects another local database or port', () => {
    expect(() => assertLocalDatabaseURL('postgresql://user:secret@127.0.0.1:5432/postgres')).toThrow('Local database commands require the Docker database')
  })

  it('rejects node-postgres query overrides of the validated connection fields', () => {
    const disguisedRemote = 'postgresql://design_editor:design_editor_local@127.0.0.1:54329/design_editor?host=production.pg.psdb.cloud&port=6432&user=prod_user&password=prod_secret'
    expect(() => assertLocalDatabaseURL(disguisedRemote)).toThrow('Local database commands require the Docker database')
  })

  it('overrides an inherited production URL and removes libpq fallbacks', () => {
    const environment = localAuthEnvironment({
      DATABASE_URL: 'postgresql://user:secret@production.pg.psdb.cloud:6432/postgres',
      PGHOST: 'production.pg.psdb.cloud',
      PGUSER: 'production-user',
    }, {
      DATABASE_URL: 'postgresql://design_editor:design_editor_local@127.0.0.1:54329/design_editor',
    })
    expect(environment.DATABASE_URL).toContain('@127.0.0.1:54329/design_editor')
    expect(environment.PGHOST).toBeUndefined()
    expect(environment.PGUSER).toBeUndefined()
  })

  it('rejects missing DATABASE_URL even when libpq points remotely', () => {
    expect(() => localAuthEnvironment({ PGHOST: 'production.pg.psdb.cloud' }, {})).toThrow('DATABASE_URL is required')
  })

  it('requires the local override file before resolving any database target', () => {
    expect(() => loadLocalAuthEnvironment(join(tmpdir(), 'design-editor-missing-local-env'), {
      DATABASE_URL: 'postgresql://user:secret@production.pg.psdb.cloud:6432/postgres',
    })).toThrow('Missing .env.local.')
  })
})
