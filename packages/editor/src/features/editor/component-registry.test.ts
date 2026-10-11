import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import type { EditorRepositoryConnection } from '../../capabilities'
import { connectedRegistryAtoms, documentRegistryAtoms } from './component-registry'

const connection: EditorRepositoryConnection = {
  repository: { id: 'repository', name: 'Repository', source: 'local' },
  scan: { adapterId: 'shadcn-v1', configs: [], components: [], tokens: [], sourceHashes: {}, diagnostics: [] },
  registry: {
    fingerprint: 'sha256-login-form',
    components: [{ componentId: 'shadcn:LoginForm:1234567890abcdef', path: 'components/ui/LoginForm.tsx', exportName: 'LoginForm', sourceHash: 'source-hash', props: [{ name: 'title', type: 'string', optional: true }, { name: 'footer', type: 'ReactNode', optional: true }], slots: ['footer'] }],
  },
}

describe('connected component registry', () => {
  it('[AT-COMP-001] derives exact identities, props, and slots from the active verified catalog', () => {
    expect(connectedRegistryAtoms(connection)).toEqual([{
      componentId: 'shadcn:LoginForm:1234567890abcdef', name: 'LoginForm', exportName: 'LoginForm', path: 'components/ui/LoginForm.tsx',
      fingerprint: 'sha256-login-form', sourceHash: 'source-hash', status: 'bound', candidates: [], kind: 'atom',
      props: [{ name: 'title', type: 'string', optional: true }, { name: 'footer', type: 'ReactNode', optional: true }], slots: ['footer'],
    }])
  })

  it('retains a stored hollow identity only as missing and never makes it insertable', () => {
    const prior: Atom = { componentId: 'sample-card', name: 'Card', exportName: 'Card', path: 'Bundled sample / Card', fingerprint: 'sample', sourceHash: '', status: 'bound', candidates: [], kind: 'atom', props: [], slots: [] }
    const file = createBlankFile('file', 'page', 'root', 'Page')
    file.nodes.card = { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {} }
    file.relationships.card = { parentId: 'root', orderKey: 'V' }
    const merged = documentRegistryAtoms(file, connectedRegistryAtoms(connection), [prior])
    expect(merged.map(atom => [atom.componentId, atom.status])).toEqual([
      ['shadcn:LoginForm:1234567890abcdef', 'bound'],
      ['sample-card', 'missing'],
    ])
  })
})
