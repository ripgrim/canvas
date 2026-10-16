import { afterEach, describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { EditorProjectApi, EditorRepositoryConnection } from '../../capabilities'
import { documentStore } from './document-store'
import { repositoryConnectionService as service } from './repository-service'
import type { HostedSourceBindingProjection } from './hosted-source-binding-projection'

const connection: EditorRepositoryConnection = {
  repository: { id: 'repository-1', name: 'UI library', source: 'local' },
  scan: { adapterId: 'shadcn-v1', configs: [], components: [{ path: 'components/ui/button.tsx', exportName: 'Button', packageName: '@acme/ui', declarationKind: 'function', props: [{ name: 'variant', type: 'string', optional: true }], slots: ['children'], sourceHash: 'a', fingerprint: 'b' }], tokens: [], sourceHashes: {}, diagnostics: [] },
  registry: { fingerprint: 'sha256-registry', components: [{ componentId: 'shadcn:Button:1234567890abcdef', symbolKey: 'shadcn:Button:1234567890abcdef', path: 'components/ui/button.tsx', exportName: 'Button', packageName: '@acme/ui', sourceHash: 'a', fingerprint: 'b', props: [{ name: 'variant', type: 'string', optional: true }, { name: 'children', type: 'ReactNode', optional: true }], slots: ['children'] }] },
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

afterEach(() => {
  service.dispose()
  documentStore.dispose()
})

describe('repository connection service', () => {
  it('restores and exposes a persisted read-only scan', async () => {
    service.configure({ getConnectedRepository: async () => connection } as unknown as EditorProjectApi)
    service.load()
    expect(service.getSnapshot()).toMatchObject({ status: 'busy', operation: 'loading' })
    expect(await waitFor('ready')).toMatchObject({ connection, operation: null, error: null })
  })

  it('COMP-V2-CODE-001 reapplies the verified registry after a file opens', async () => {
    service.configure({ getConnectedRepository: async () => connection } as unknown as EditorProjectApi)
    service.load()
    await waitFor('ready')

    documentStore.load(createBlankFile('file', 'page', 'root'), [], { replace: true })

    expect(documentStore.getSnapshot().file?.componentModel.definitions['shadcn:Button:1234567890abcdef']).toMatchObject({
      source: { kind: 'code', bindingId: 'shadcn:Button:1234567890abcdef' },
      properties: [
        { id: 'property:variant', name: 'variant', type: 'text', defaultValue: '', optional: true },
        { id: 'property:children', name: 'children', type: 'slot', optional: true },
      ],
    })
  })

  it('COMP-V2-BINDING-001 does not downgrade a hosted binding during local registry reconciliation', async () => {
    service.configure({ getConnectedRepository: async () => connection } as unknown as EditorProjectApi)
    service.load()
    await waitFor('ready')
    documentStore.load(createBlankFile('file', 'page', 'root'), [], { replace: true })
    const projection: HostedSourceBindingProjection = {
      authority: {
        version: 1, projectId: 'project', repositoryId: 'repository', scanId: 'scan', sourceRevision: 'revision',
        registryFingerprint: 'registry', grantGeneration: 1, adapterId: 'adapter', updatedAt: 1,
      },
      components: [{ bindingId: 'hosted:button', status: 'bound', name: 'Hosted button', props: [], slots: [] }],
    }

    expect(documentStore.commands.components.reconcileHostedProjection({
      expectedFileId: 'file', expectedFileRevision: documentStore.getSnapshot().file!.revision, projection,
    })).toBe('applied')

    expect(documentStore.getSnapshot().atoms.find(atom => atom.componentId === 'hosted:button')).toMatchObject({
      kind: 'hosted', status: 'bound', name: 'Hosted button',
    })
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
