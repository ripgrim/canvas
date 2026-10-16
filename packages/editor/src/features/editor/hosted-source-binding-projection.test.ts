import { describe, expect, it } from 'vitest'
import { parseSourceBindingSnapshot } from '@canvas/repository'
import type { SourceBindingRecord, SourceBindingSnapshot, SourceScanAuthority, SourceSymbolEvidence } from '@canvas/repository'
import type { EditorHostedRepositoryScan } from '../../capabilities'
import { projectHostedSourceBindings } from './hosted-source-binding-projection'

const hash = (letter: string) => letter.repeat(64)
const repository = { provider: 'github' as const, projectId: 'project-1', repositoryId: 'repository-1' }
const authority: SourceScanAuthority = {
  repository,
  scanId: 'scan-1',
  sourceRevision: 'a'.repeat(40),
  registryFingerprint: `sha256:${hash('f')}`,
  grantGeneration: 3,
  adapterId: 'shadcn-v1',
}
const button: SourceSymbolEvidence = {
  symbolKey: 'src-Button-tsx-Button',
  packageName: '@acme/ui',
  path: 'src/Button.tsx',
  exportName: 'Button',
  sourceHash: hash('b'),
  fingerprint: hash('c'),
}
const label: SourceSymbolEvidence = {
  symbolKey: 'symbol-label',
  packageName: '@acme/ui',
  path: 'src/Label.tsx',
  exportName: 'Label',
  sourceHash: hash('d'),
  fingerprint: hash('e'),
}

function record(overrides: Partial<SourceBindingRecord> = {}): SourceBindingRecord {
  return { id: 'opaque-binding-7', repository, authority, evidence: button, status: 'bound', ...overrides } as SourceBindingRecord
}

function snapshot(records: readonly SourceBindingRecord[] = [record()]): SourceBindingSnapshot {
  return { version: 4, authority, records, updatedAt: 17 }
}

function scan(symbols: readonly SourceSymbolEvidence[] = [button]): EditorHostedRepositoryScan & { adapterId: string } {
  return {
    jobId: authority.scanId,
    sourceRevision: authority.sourceRevision,
    componentCount: symbols.length,
    adapterId: authority.adapterId,
    registry: {
      fingerprint: authority.registryFingerprint,
      components: symbols.map((symbol, index) => ({
        componentId: `catalog-${index}`,
        ...symbol,
        props: symbol === button ? [{ name: 'tone', type: "'quiet' | 'solid'", optional: true }] : [],
        slots: symbol === button ? ['children'] : [],
      })),
    },
  }
}

describe('COMP-V2-BINDING-001 hosted source binding projection', () => {
  it('AT-ID-001 projects a bound component only through its opaque binding identity', () => {
    const projected = projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot(), scan: scan() })
    expect(projected).toEqual({
      authority: {
        version: 4,
        projectId: 'project-1',
        repositoryId: 'repository-1',
        scanId: 'scan-1',
        sourceRevision: authority.sourceRevision,
        registryFingerprint: authority.registryFingerprint,
        grantGeneration: 3,
        adapterId: 'shadcn-v1',
        updatedAt: 17,
      },
      components: [{
        bindingId: 'opaque-binding-7',
        status: 'bound',
        name: 'Button',
        props: [{ name: 'tone', type: "'quiet' | 'solid'", optional: true }],
        slots: ['children'],
      }],
    })
    const wire = JSON.stringify(projected)
    for (const forbidden of [button.symbolKey, button.path, button.sourceHash, 'componentId', 'installationId', 'userId', 'accessToken']) {
      expect(wire).not.toContain(forbidden)
    }
  })

  it('AT-ID-002 preserves the opaque binding id across a verified move and rename', () => {
    const moved = { ...button, symbolKey: 'symbol-caption', path: 'src/text/Caption.tsx', exportName: 'Caption', sourceHash: hash('1') }
    const movedRecord = record({ evidence: moved })
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot([movedRecord]), scan: scan([moved]) })?.components).toEqual([
      { bindingId: 'opaque-binding-7', status: 'bound', name: 'Caption', props: [], slots: [] },
    ])
  })

  it('AT-ID-003 reports missing and ambiguous records without selecting or leaking candidate identity', () => {
    const records: SourceBindingRecord[] = [
      record({ id: 'opaque-missing', status: 'missing' }),
      record({ id: 'opaque-choice', evidence: label, status: 'ambiguous', candidates: [button, label] }),
    ]
    const projected = projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot(records), scan: scan([button, label]) })
    expect(projected?.components).toEqual([
      { bindingId: 'opaque-missing', status: 'missing' },
      { bindingId: 'opaque-choice', status: 'ambiguous', candidates: [
        { choiceToken: 'candidate:1', name: 'Button' },
        { choiceToken: 'candidate:2', name: 'Label' },
      ] },
    ])
    const wire = JSON.stringify(projected)
    expect(wire).not.toContain(button.symbolKey)
    expect(wire).not.toContain(label.path)
  })

  it('AT-ID-003 allows two unresolved bindings to share one verified candidate without claiming it', () => {
    const firstPrior = { ...button, symbolKey: 'prior-first', path: 'src/First.tsx', exportName: 'First', sourceHash: hash('1') }
    const secondPrior = { ...button, symbolKey: 'prior-second', path: 'src/Second.tsx', exportName: 'Second', sourceHash: hash('2') }
    const records: SourceBindingRecord[] = [
      record({ id: 'opaque-first', evidence: firstPrior, status: 'ambiguous', candidates: [button] }),
      record({ id: 'opaque-second', evidence: secondPrior, status: 'ambiguous', candidates: [button] }),
    ]
    const parsed = parseSourceBindingSnapshot(snapshot(records))
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: parsed, scan: scan() })?.components).toEqual([
      { bindingId: 'opaque-first', status: 'ambiguous', candidates: [{ choiceToken: 'candidate:1', name: 'Button' }] },
      { bindingId: 'opaque-second', status: 'ambiguous', candidates: [{ choiceToken: 'candidate:1', name: 'Button' }] },
    ])
  })

  it('AT-SYNC-001 rejects every stale authority field and does not treat a path-derived key as identity', () => {
    const base = snapshot()
    const mutations: Array<(value: SourceScanAuthority) => SourceScanAuthority> = [
      value => ({ ...value, repository: { ...value.repository, projectId: 'other-project' } }),
      value => ({ ...value, repository: { ...value.repository, repositoryId: 'other-repository' } }),
      value => ({ ...value, scanId: 'other-scan' }),
      value => ({ ...value, sourceRevision: '9'.repeat(40) }),
      value => ({ ...value, registryFingerprint: `sha256:${hash('9')}` }),
      value => ({ ...value, grantGeneration: value.grantGeneration + 1 }),
      value => ({ ...value, adapterId: 'other-v1' }),
    ]
    for (const mutate of mutations) {
      expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: { ...base, records: [record({ authority: mutate(authority) })] }, scan: scan() })).toBeNull()
    }
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: { ...base, authority: { ...authority, scanId: undefined as unknown as string } }, scan: scan() })).toBeNull()
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: base, scan: { ...scan(), jobId: 'other-scan' } })).toBeNull()
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: base, scan: { ...scan(), sourceRevision: '8'.repeat(40) } })).toBeNull()
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: base, scan: { ...scan(), adapterId: 'other-v1' } })).toBeNull()
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: base, scan: { ...scan(), registry: { ...scan().registry, fingerprint: `sha256:${hash('8')}` } } })).toBeNull()
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: base, scan: { ...scan(), componentCount: 2 } })).toBeNull()
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: base, scan: scan() })?.components[0]).toMatchObject({ bindingId: 'opaque-binding-7' })
  })

  it('COMP-V2-ADMISSION-NEG-001 rejects mutated evidence, duplicates, collisions, and unaccounted symbols', () => {
    for (const [field, value] of [
      ['symbolKey', 'other-symbol'],
      ['packageName', '@other/ui'],
      ['path', 'src/Other.tsx'],
      ['exportName', 'Other'],
      ['sourceHash', hash('8')],
      ['fingerprint', hash('9')],
    ] as const) {
      expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot([record({ evidence: { ...button, [field]: value } })]), scan: scan() })).toBeNull()
    }
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot([record(), record()]), scan: scan() })).toBeNull()
    const duplicateCatalog = scan([button, { ...button, path: 'src/Other.tsx', exportName: 'Other' }])
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot(), scan: duplicateCatalog })).toBeNull()
    const collisionRecords: SourceBindingRecord[] = [
      record(),
      record({ id: 'opaque-choice', evidence: label, status: 'ambiguous', candidates: [button] }),
    ]
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot(collisionRecords), scan: scan() })).toBeNull()
    expect(projectHostedSourceBindings({ projectId: repository.projectId, snapshot: snapshot(), scan: scan([button, label]) })).toBeNull()
  })
})
