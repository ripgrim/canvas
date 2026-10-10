import { afterEach, describe, expect, it } from 'vitest'
import type { EditorProjectApi, EditorRepositoryConnection } from '../../capabilities'
import { repositoryConnectionService as service } from './repository-service'

const connection: EditorRepositoryConnection = {
  repository: { id: 'repository-1', name: 'UI library', source: 'local' },
  scan: { adapterId: 'shadcn-v1', configs: [], components: [{ path: 'components/ui/button.tsx', exportName: 'Button', declarationKind: 'function', props: [{ name: 'variant', type: 'string', optional: true }], slots: ['children'], sourceHash: 'a', fingerprint: 'b' }], tokens: [], sourceHashes: {}, diagnostics: [] },
}

function waitFor(status: 'idle' | 'busy' | 'ready' | 'error') {
  if (service.getSnapshot().status === status) return Promise.resolve(service.getSnapshot())
  return new Promise<ReturnType<typeof service.getSnapshot>>(resolve => {
    const unsubscribe = service.subscribe(state => {
      if (state.status !== status) return
      unsubscribe()
      resolve(state)
    })
  })
}

afterEach(() => service.dispose())

describe('repository connection service', () => {
  it('restores and exposes a persisted read-only scan', async () => {
    service.configure({ getConnectedRepository: async () => connection } as unknown as EditorProjectApi)
    service.load()
    expect(service.getSnapshot()).toMatchObject({ status: 'busy', operation: 'loading' })
    expect(await waitFor('ready')).toMatchObject({ connection, operation: null, error: null })
  })

  it('keeps the previous scan when the folder picker is cancelled', async () => {
    service.configure({ getConnectedRepository: async () => connection, pickLocalRepository: async () => null } as unknown as EditorProjectApi)
    service.load()
    await waitFor('ready')
    service.pickLocal()
    expect(service.getSnapshot()).toMatchObject({ status: 'busy', operation: 'local', connection })
    expect(await waitFor('ready')).toMatchObject({ connection })
  })

  it('reports a clone failure and retries the same operation', async () => {
    let attempts = 0
    service.configure({ cloneGitHubRepository: async () => { attempts += 1; if (attempts === 1) throw new Error('Clone failed safely.'); return connection } } as unknown as EditorProjectApi)
    service.cloneGitHub('owner', 'repo')
    expect(await waitFor('error')).toMatchObject({ error: 'Clone failed safely.', operation: null })
    service.retry()
    expect(service.getSnapshot()).toMatchObject({ status: 'busy', operation: 'clone' })
    expect(await waitFor('ready')).toMatchObject({ connection })
  })
})
