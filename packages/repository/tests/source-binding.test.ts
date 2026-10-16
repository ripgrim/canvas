import { describe, expect, it } from 'vitest'
import { reconcileSourceBindings, type SourceBindingRecord, type SourceScanAuthority, type SourceSymbolEvidence } from '../src/source-binding'

const repository = { provider: 'github' as const, projectId: 'project-1', repositoryId: 'repository-1' }
const hash = (value: string) => value.repeat(64)
const revision = (value: string) => value.repeat(40)
const registry = (value: string) => `sha256:${hash(value)}`

function authority(scanId: string, sourceRevision: string, registryFingerprint: string, grantGeneration = 1): SourceScanAuthority {
  return { repository, scanId, sourceRevision, registryFingerprint, grantGeneration, adapterId: 'shadcn-v1' }
}

function symbol(symbolKey: string, path: string, exportName: string, sourceHash: string, fingerprint: string): SourceSymbolEvidence {
  return { symbolKey, packageName: '@acme/ui', path, exportName, sourceHash, fingerprint }
}

function previous(scan: SourceScanAuthority, records: readonly SourceBindingRecord[]) {
  return { authority: scan, records }
}

describe('source binding reconciliation', () => {
  it('[COMP-V2-BINDING-001] seeds admitted identities and allocates only new symbols', () => {
    const scan = authority('scan-1', revision('a'), registry('1'))
    const button = symbol('symbol-button', 'src/Button.tsx', 'Button', hash('a'), hash('1'))
    const card = symbol('symbol-card', 'src/Card.tsx', 'Card', hash('b'), hash('2'))
    const result = reconcileSourceBindings({
      repository,
      scan: { authority: scan, symbols: [card, button] },
      previous: null,
      seeds: [{ bindingId: 'binding-existing', evidence: button }],
      allocations: [{ bindingId: 'binding-new', symbolKey: card.symbolKey }],
      rebinds: [],
    })
    expect(result).toEqual({
      repository,
      authority: scan,
      records: [
        { id: 'binding-existing', repository, authority: scan, evidence: button, status: 'bound' },
        { id: 'binding-new', repository, authority: scan, evidence: card, status: 'bound' },
      ],
    })
    expect(reconcileSourceBindings({
      repository,
      scan: { authority: scan, symbols: [button, card] },
      previous: null,
      seeds: [{ bindingId: 'binding-existing', evidence: button }],
      allocations: [{ bindingId: 'binding-new', symbolKey: card.symbolKey }],
      rebinds: [],
    })).toEqual(result)
  })

  it('preserves identity through a non-semantic edit', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('symbol-button-1', 'src/Button.tsx', 'Button', hash('a'), hash('1'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'opaque-button', symbolKey: first.symbolKey }],
      rebinds: [],
    })
    const secondAuthority = authority('scan-2', revision('b'), registry('2'))
    const edited = symbol('symbol-button-1', 'src/Button.tsx', 'Button', hash('b'), hash('1'))
    const result = reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [edited] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(result.records).toEqual([
      { id: 'opaque-button', repository, authority: secondAuthority, evidence: edited, status: 'bound' },
    ])
    expect(result.records[0]!.id).not.toBe(`binding-${secondAuthority.sourceRevision}`)
  })

  it('requires checked evidence for one move and rename', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('symbol-label-1', 'src/Label.tsx', 'Label', hash('a'), hash('3'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'opaque-label', symbolKey: first.symbolKey }],
      rebinds: [],
    })
    const secondAuthority = authority('scan-2', revision('b'), registry('2'))
    const moved = symbol('symbol-caption-2', 'src/text/Caption.tsx', 'Caption', hash('b'), hash('3'))
    const unconfirmed = reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [moved] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(unconfirmed.records).toEqual([{
      id: 'opaque-label',
      repository,
      authority: secondAuthority,
      evidence: first,
      status: 'ambiguous',
      candidates: [moved],
    }])
    const checkedRebind = {
      bindingId: 'opaque-label',
      expectedAuthority: firstAuthority,
      expectedEvidence: first,
      replacement: moved,
    }
    const result = reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [moved] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [checkedRebind],
    })
    expect(result.records).toEqual([
      { id: 'opaque-label', repository, authority: secondAuthority, evidence: moved, status: 'bound' },
    ])
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [moved] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [{ ...checkedRebind, expectedEvidence: { ...first, sourceHash: hash('f') } }],
    })).toThrow('Stale source binding rebind')
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [moved] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [{ ...checkedRebind, expectedAuthority: { ...firstAuthority, sourceRevision: revision('f') } }],
    })).toThrow('Stale source binding rebind')
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [moved] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [{ ...checkedRebind, replacement: { ...moved, sourceHash: hash('f') } }],
    })).toThrow('not unique')
    const otherPackage = { ...moved, packageName: '@other/ui' }
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [otherPackage] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [{ ...checkedRebind, replacement: otherPackage }],
    })).toThrow('not unique')
    const other = symbol('symbol-other', 'src/text/Other.tsx', 'Other', hash('c'), hash('3'))
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [moved, other] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [checkedRebind],
    })).toThrow('not unique')
  })

  it('retains missing identity and reports candidates', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('symbol-label-1', 'src/Label.tsx', 'Label', hash('a'), hash('4'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'opaque-label', symbolKey: first.symbolKey }],
      rebinds: [],
    })
    const missingAuthority = authority('scan-2', revision('b'), registry('2'))
    const missing = reconcileSourceBindings({
      repository,
      scan: { authority: missingAuthority, symbols: [] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(missing.records).toEqual([
      { id: 'opaque-label', repository, authority: missingAuthority, evidence: first, status: 'missing' },
    ])
    const ambiguousAuthority = authority('scan-3', revision('c'), registry('3'))
    const caption = symbol('symbol-caption-3', 'src/Caption.tsx', 'Caption', hash('b'), hash('4'))
    const legend = symbol('symbol-legend-3', 'src/Legend.tsx', 'Legend', hash('c'), hash('4'))
    const ambiguous = reconcileSourceBindings({
      repository,
      scan: { authority: ambiguousAuthority, symbols: [legend, caption] },
      previous: previous(missingAuthority, missing.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(ambiguous.records).toEqual([{
      id: 'opaque-label',
      repository,
      authority: ambiguousAuthority,
      evidence: first,
      status: 'ambiguous',
      candidates: [caption, legend],
    }])
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: ambiguousAuthority, symbols: [caption, legend] },
      previous: previous(missingAuthority, missing.records),
      seeds: [],
      allocations: [{ bindingId: 'guessed-caption', symbolKey: caption.symbolKey }],
      rebinds: [],
    })).toThrow('not new')
    const goneAuthority = authority('scan-4', revision('d'), registry('4'))
    const gone = reconcileSourceBindings({
      repository,
      scan: { authority: goneAuthority, symbols: [] },
      previous: previous(ambiguousAuthority, ambiguous.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(gone.records).toEqual([
      { id: 'opaque-label', repository, authority: goneAuthority, evidence: first, status: 'missing' },
    ])
  })

  it('does not bind a recreated symbol at the same locator', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('symbol-card-1', 'src/Card.tsx', 'Card', hash('a'), hash('5'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'opaque-card', symbolKey: first.symbolKey }],
      rebinds: [],
    })
    const deletedAuthority = authority('scan-2', revision('b'), registry('2'))
    const deleted = reconcileSourceBindings({
      repository,
      scan: { authority: deletedAuthority, symbols: [] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    const recreatedAuthority = authority('scan-3', revision('c'), registry('3'))
    const recreated = symbol('symbol-card-3', 'src/Card.tsx', 'Card', hash('c'), hash('5'))
    const result = reconcileSourceBindings({
      repository,
      scan: { authority: recreatedAuthority, symbols: [recreated] },
      previous: previous(deletedAuthority, deleted.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(result.records).toEqual([{
      id: 'opaque-card',
      repository,
      authority: recreatedAuthority,
      evidence: first,
      status: 'ambiguous',
      candidates: [recreated],
    }])
  })

  it('requires a checked rebind when a path-derived symbol key returns after missing', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const pathDerivedKey = 'src-Card-tsx-Card'
    const first = symbol(pathDerivedKey, 'src/Card.tsx', 'Card', hash('a'), hash('5'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'opaque-card', symbolKey: first.symbolKey }],
      rebinds: [],
    })
    const missingAuthority = authority('scan-2', revision('b'), registry('2'))
    const missing = reconcileSourceBindings({
      repository,
      scan: { authority: missingAuthority, symbols: [] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    const recreatedAuthority = authority('scan-3', revision('c'), registry('3'))
    const recreated = symbol(pathDerivedKey, 'src/Card.tsx', 'Card', hash('c'), hash('5'))
    const unconfirmed = reconcileSourceBindings({
      repository,
      scan: { authority: recreatedAuthority, symbols: [recreated] },
      previous: previous(missingAuthority, missing.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(unconfirmed.records).toEqual([{
      id: 'opaque-card',
      repository,
      authority: recreatedAuthority,
      evidence: first,
      status: 'ambiguous',
      candidates: [recreated],
    }])

    expect(reconcileSourceBindings({
      repository,
      scan: { authority: recreatedAuthority, symbols: [recreated] },
      previous: previous(missingAuthority, missing.records),
      seeds: [],
      allocations: [],
      rebinds: [{
        bindingId: 'opaque-card',
        expectedAuthority: missingAuthority,
        expectedEvidence: first,
        replacement: recreated,
      }],
    }).records).toEqual([{
      id: 'opaque-card',
      repository,
      authority: recreatedAuthority,
      evidence: recreated,
      status: 'bound',
    }])
  })

  it('rejects previous bindings that reuse one symbol key at different locators', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('shared-symbol', 'src/First.tsx', 'First', hash('a'), hash('1'))
    const second = symbol('shared-symbol', 'src/Second.tsx', 'Second', hash('b'), hash('2'))
    const records: readonly SourceBindingRecord[] = [
      { id: 'opaque-first', repository, authority: firstAuthority, evidence: first, status: 'bound' },
      { id: 'opaque-second', repository, authority: firstAuthority, evidence: second, status: 'bound' },
    ]
    const secondAuthority = authority('scan-2', revision('b'), registry('2'))

    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [] },
      previous: previous(firstAuthority, records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })).toThrow('Duplicate previous source binding')
  })

  it('removes a rebound candidate from every remaining ambiguous record', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('symbol-first', 'src/First.tsx', 'First', hash('a'), hash('3'))
    const second = symbol('symbol-second', 'src/Second.tsx', 'Second', hash('b'), hash('3'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first, second] },
      previous: null,
      seeds: [],
      allocations: [
        { bindingId: 'opaque-first', symbolKey: first.symbolKey },
        { bindingId: 'opaque-second', symbolKey: second.symbolKey },
      ],
      rebinds: [],
    })
    const secondAuthority = authority('scan-2', revision('b'), registry('2'))
    const moved = symbol('symbol-moved', 'src/Moved.tsx', 'Moved', hash('c'), hash('3'))
    const result = reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [moved] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [{
        bindingId: 'opaque-first',
        expectedAuthority: firstAuthority,
        expectedEvidence: first,
        replacement: moved,
      }],
    })

    expect(result.records).toEqual([
      { id: 'opaque-first', repository, authority: secondAuthority, evidence: moved, status: 'bound' },
      { id: 'opaque-second', repository, authority: secondAuthority, evidence: second, status: 'missing' },
    ])
  })

  it('is deterministic across input permutations', () => {
    const scan = authority('scan-1', revision('a'), registry('1'))
    const upper = symbol('symbol-upper', 'src/Upper.tsx', 'Upper', hash('a'), hash('6'))
    const lower = symbol('symbol-lower', 'src/Lower.tsx', 'Lower', hash('b'), hash('7'))
    const run = (symbols: readonly SourceSymbolEvidence[], allocations: readonly { bindingId: string, symbolKey: string }[]) => reconcileSourceBindings({
      repository,
      scan: { authority: scan, symbols },
      previous: null,
      seeds: [],
      allocations,
      rebinds: [],
    })
    const expected = run(
      [upper, lower],
      [
        { bindingId: 'binding-Z', symbolKey: upper.symbolKey },
        { bindingId: 'binding-a', symbolKey: lower.symbolKey },
      ],
    )
    expect(run(
      [lower, upper],
      [
        { bindingId: 'binding-a', symbolKey: lower.symbolKey },
        { bindingId: 'binding-Z', symbolKey: upper.symbolKey },
      ],
    )).toEqual(expected)
    expect(expected.records.map(record => record.id)).toEqual(['binding-Z', 'binding-a'])
  })

  it('rejects revision-derived identity as locator continuity', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('symbol-a', 'src/Button.tsx', 'Button', hash('a'), hash('8'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'opaque-button', symbolKey: first.symbolKey }],
      rebinds: [],
    })
    const secondAuthority = authority('scan-2', revision('b'), registry('2'))
    const mutated = symbol(`symbol-${secondAuthority.sourceRevision}`, 'src/Button.tsx', 'Button', hash('b'), hash('8'))
    const result = reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [mutated] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    })
    expect(result.records[0]).toMatchObject({
      id: 'opaque-button',
      evidence: first,
      status: 'ambiguous',
      candidates: [mutated],
    })
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: secondAuthority, symbols: [mutated] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [{ bindingId: `binding-${secondAuthority.sourceRevision}`, symbolKey: mutated.symbolKey }],
      rebinds: [],
    })).toThrow('not new')
  })

  it('rejects stale and malformed evidence', () => {
    const firstAuthority = authority('scan-1', revision('a'), registry('1'))
    const first = symbol('symbol-button-1', 'src/Button.tsx', 'Button', hash('a'), hash('5'))
    const initial = reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'opaque-button', symbolKey: first.symbolKey }],
      rebinds: [],
    })
    const secondAuthority = authority('scan-2', revision('b'), registry('2'), 2)
    const edited = symbol('symbol-button-2', 'src/Button.tsx', 'Button', hash('b'), hash('5'))
    const base = {
      repository,
      scan: { authority: secondAuthority, symbols: [edited] },
      previous: previous(firstAuthority, initial.records),
      seeds: [],
      allocations: [],
      rebinds: [],
    }
    const staleRecord = { ...initial.records[0]!, authority: { ...firstAuthority, scanId: 'stale-scan' } }
    expect(() => reconcileSourceBindings({ ...base, previous: previous(firstAuthority, [staleRecord]) })).toThrow('Stale')
    expect(() => reconcileSourceBindings({ ...base, scan: { ...base.scan, authority: { ...secondAuthority, repository: { ...repository, repositoryId: 'other' } } } })).toThrow('mismatch')
    expect(() => reconcileSourceBindings({ ...base, scan: { ...base.scan, authority: { ...secondAuthority, scanId: firstAuthority.scanId } } })).toThrow('authority mismatch')
    expect(() => reconcileSourceBindings({ ...base, scan: { authority: firstAuthority, symbols: [edited] } })).toThrow('immutable authority')
    expect(() => reconcileSourceBindings({ ...base, scan: { ...base.scan, symbols: [{ ...edited, path: '../Button.tsx' }] } })).toThrow('source path')
    expect(() => reconcileSourceBindings({ ...base, scan: { ...base.scan, symbols: [{ ...edited, extra: true }] } })).toThrow('symbol evidence')
    expect(() => reconcileSourceBindings({ ...base, scan: { ...base.scan, symbols: [edited, { ...edited, sourceHash: hash('c') }] } })).toThrow('Duplicate')
    expect(() => reconcileSourceBindings({ ...base, allocations: [{ bindingId: 'opaque-button', symbolKey: 'unknown' }] })).toThrow('collision')
    expect(() => reconcileSourceBindings({ ...base, allocations: [{ bindingId: 'new-id', symbolKey: edited.symbolKey }] })).toThrow('not new')
    expect(() => reconcileSourceBindings({ ...base, scan: { ...base.scan, authority: { ...secondAuthority, grantGeneration: 0 } } })).toThrow('grant generation')
    expect(() => reconcileSourceBindings({ ...base, seeds: [{ bindingId: 'late-seed', evidence: edited }] })).toThrow('only be applied once')
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [first] },
      previous: null,
      seeds: [{ bindingId: 'seeded', evidence: { ...first, sourceHash: hash('f') } }],
      allocations: [],
      rebinds: [],
    })).toThrow('does not match')
    const newSymbol = symbol('symbol-card', 'src/Card.tsx', 'Card', hash('c'), hash('6'))
    expect(() => reconcileSourceBindings({
      repository,
      scan: { authority: firstAuthority, symbols: [newSymbol] },
      previous: null,
      seeds: [],
      allocations: [],
      rebinds: [],
    })).toThrow('opaque binding ids')
  })
})
