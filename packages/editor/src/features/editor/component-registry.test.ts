import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import type { EditorRepositoryConnection } from '../../capabilities'
import { connectedRegistryAtoms, connectedRegistryDefinitions, discoveredRegistryAtoms, discoveredRegistryDefinitions, documentRegistryAtoms } from './component-registry'
import { codeComponentValueId } from '@canvas/repo-engine/component-admission'

const connection: EditorRepositoryConnection = {
  repository: { id: 'repository', name: 'Repository', source: 'local' },
  scan: { adapterId: 'shadcn-v1', configs: [], components: [], tokens: [], sourceHashes: {}, diagnostics: [] },
  registry: {
    fingerprint: `sha256-${'A'.repeat(43)}=`,
    components: [{ componentId: 'shadcn:LoginForm:1234567890abcdef', symbolKey: 'shadcn:LoginForm:1234567890abcdef', path: 'components/ui/LoginForm.tsx', exportName: 'LoginForm', packageName: '@acme/ui', sourceHash: 'source-hash', fingerprint: 'declaration-fingerprint', props: [{ name: 'title', type: 'string', optional: true }, { name: 'footer', type: 'ReactNode', optional: true }], slots: ['footer'] }],
  },
}

describe('connected component registry', () => {
  it('[AT-COMP-001] derives exact identities, props, and slots from the active verified catalog', () => {
    expect(connectedRegistryAtoms(connection)).toEqual([{
      componentId: 'shadcn:LoginForm:1234567890abcdef', name: 'LoginForm', exportName: 'LoginForm', path: 'components/ui/LoginForm.tsx',
      fingerprint: `sha256-${'A'.repeat(43)}=`, sourceHash: 'source-hash', status: 'bound', candidates: [], kind: 'atom',
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

  it('COMP-V2-CODE-001 adapts only exact representable registry properties into the component model', () => {
    const [definition] = connectedRegistryDefinitions([{
      componentId: 'component:button', name: 'Button', exportName: 'Button', path: 'components/ui/button.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom',
      props: [
        { name: 'label', type: 'string', optional: false },
        { name: 'active', type: 'boolean', optional: false },
        { name: 'tone', type: "'quiet' | 'solid'", optional: false },
        { name: 'count', type: 'number', optional: false },
        { name: 'description', type: 'string | undefined', optional: true },
        { name: 'children', type: 'ReactNode', optional: true },
      ],
      slots: ['children'],
    }])
    expect(definition).toMatchObject({ id: 'component:button', name: 'Button', source: { kind: 'code', bindingId: 'component:button' } })
    expect(definition?.properties).toEqual([
      { id: 'property:label', name: 'label', type: 'text', defaultValue: '' },
      { id: 'property:active', name: 'active', type: 'boolean', defaultValue: false },
      { id: 'property:tone', name: 'tone', type: 'variant', defaultValueId: codeComponentValueId('quiet'), values: [{ id: codeComponentValueId('quiet'), name: 'quiet' }, { id: codeComponentValueId('solid'), name: 'solid' }] },
      { id: 'property:description', name: 'description', type: 'text', defaultValue: '', optional: true },
      { id: 'property:children', name: 'children', type: 'slot', optional: true },
    ])
  })

  it('COMP-V2-CODE-002 exposes hosted discoveries without making them insertable', () => {
    const atoms = discoveredRegistryAtoms(connection.registry)
    const definitions = discoveredRegistryDefinitions(connection.registry)
    expect(atoms).toMatchObject([{ componentId: 'shadcn:LoginForm:1234567890abcdef', status: 'missing' }])
    expect(definitions).toMatchObject([{
      id: 'shadcn:LoginForm:1234567890abcdef',
      name: 'LoginForm',
      source: { kind: 'code', bindingId: 'shadcn:LoginForm:1234567890abcdef' },
      properties: [
        { id: 'property:title', name: 'title', type: 'text', defaultValue: '', optional: true },
        { id: 'property:footer', name: 'footer', type: 'slot', optional: true },
      ],
    }])
  })

  it('keeps code variant identity attached to its literal value when source order changes', () => {
    const atom = (type: string): Atom => ({ componentId: 'component:button', name: 'Button', exportName: 'Button', path: 'button.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom', props: [{ name: 'tone', type, optional: false }], slots: [] })
    const before = connectedRegistryDefinitions([atom("'quiet' | 'solid'")])[0]!.properties[0]
    const after = connectedRegistryDefinitions([atom("'solid' | 'quiet'")])[0]!.properties[0]
    expect(before?.type).toBe('variant')
    expect(after?.type).toBe('variant')
    if (!before || !after || before.type !== 'variant' || after.type !== 'variant') throw new Error('Expected variants')
    expect(before.values.find(value => value.name === 'quiet')?.id).toBe(after.values.find(value => value.name === 'quiet')?.id)
    expect(before.values.find(value => value.name === 'solid')?.id).toBe(after.values.find(value => value.name === 'solid')?.id)
  })

  it('keeps a stored code definition readable when its registry binding disconnects', () => {
    const prior: Atom = { componentId: 'component:button', name: 'Button', exportName: 'Button', path: 'components/ui/button.tsx', fingerprint: 'registry', sourceHash: 'source', status: 'bound', candidates: [], kind: 'atom', props: [], slots: [] }
    const file: FileDocument = { ...createBlankFile('file', 'page', 'root', 'Page'), componentModel: { definitions: {
      'component:button': { id: 'component:button', name: 'Button', source: { kind: 'code', bindingId: 'component:button' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
    }, instances: {} } }
    expect(documentRegistryAtoms(file, [], [prior])).toMatchObject([{ componentId: 'component:button', status: 'missing' }])
  })
})
