import { describe, expect, it } from 'vitest'
import { componentCatalogFromShadcnScan, sourceSymbolEvidenceFromCatalogEntry } from '../src/component-catalog.js'
import { reconcileSourceBindings, type SourceSymbolEvidence } from '../../repository/src/source-binding.js'

const sourceHash = 'a'.repeat(64)
const declarationFingerprint = 'b'.repeat(64)
const integrity = (hash: string) => `sha256-${Buffer.from(hash, 'hex').toString('base64')}`
const button = {
  path: 'src/button.tsx',
  exportName: 'Button',
  packageName: '@acme/ui',
  declarationKind: 'function',
  sourceHash,
  fingerprint: declarationFingerprint,
  props: [{ name: 'tone', type: "'quiet' | 'solid'", optional: false }, { name: 'children', type: 'ReactNode', optional: true }],
  slots: ['children'],
} as const
const card = { path: 'src/card.tsx', exportName: 'Card', packageName: '@acme/cards', declarationKind: 'variable', sourceHash: 'c'.repeat(64), fingerprint: 'd'.repeat(64), props: [], slots: [] } as const
const buttonRequest = {
  componentId: 'shadcn:Button:1234567890abcdef',
  entryPath: 'src/button.tsx',
  exportName: 'Button',
  integrity: integrity(sourceHash),
  props: { tone: { kind: 'enum', values: ['quiet', 'solid'], optional: false } },
  slots: ['children'],
} as const
const cardRequest = { componentId: 'shadcn:Card:1234567890abcdef', entryPath: 'src/card.tsx', exportName: 'Card', integrity: integrity(card.sourceHash), props: {}, slots: [] } as const

function scanWith(components: readonly unknown[] = [card, button]) {
  return {
    adapterId: 'shadcn-v1',
    configs: [],
    components,
    tokens: [],
    sourceHashes: Object.fromEntries(components.flatMap(component => {
      if (!component || typeof component !== 'object') return []
      const item = component as { path?: unknown; sourceHash?: unknown }
      return typeof item.path === 'string' && typeof item.sourceHash === 'string' ? [[item.path, item.sourceHash]] : []
    })),
    diagnostics: [],
    previewDependencies: [],
    previewResolutions: [],
  }
}

function requestWith(components: readonly unknown[] = [buttonRequest]) {
  return {
    version: 1,
    entry: { componentId: buttonRequest.componentId },
    components,
    styles: [],
    aliases: [],
    dependencies: [],
    resolutions: [],
    themeAdapters: [],
  }
}

describe('component catalog', () => {
  it('[COMP-V2-BINDING-001] publishes binding-compatible immutable evidence', () => {
    const catalog = componentCatalogFromShadcnScan(scanWith(), requestWith(), 'github:revision')
    const evidence: SourceSymbolEvidence = sourceSymbolEvidenceFromCatalogEntry(catalog.components[0]!)
    expect(evidence).toMatchObject({ symbolKey: 'shadcn:Button:1234567890abcdef', packageName: '@acme/ui' })
    expect(catalog).toEqual({
      fingerprint: 'github:revision',
      components: [{
        componentId: 'shadcn:Button:1234567890abcdef',
        symbolKey: 'shadcn:Button:1234567890abcdef',
        packageName: '@acme/ui',
        path: 'src/button.tsx',
        exportName: 'Button',
        sourceHash: 'a'.repeat(64),
        fingerprint: 'b'.repeat(64),
        props: [
          { name: 'children', type: 'ReactNode', optional: true },
          { name: 'tone', type: "'quiet' | 'solid'", optional: false },
        ],
        slots: ['children'],
      }],
    })
  })

  it('[COMP-V2-BINDING-001] maps a real catalog entry through repository reconciliation', () => {
    const entry = componentCatalogFromShadcnScan(scanWith(), requestWith(), 'github:revision').components[0]!
    const evidence = sourceSymbolEvidenceFromCatalogEntry(entry)
    expect(Object.keys(evidence)).toEqual(['symbolKey', 'packageName', 'path', 'exportName', 'sourceHash', 'fingerprint'])

    const repository = { provider: 'github' as const, projectId: 'project-1', repositoryId: 'repository-1' }
    const authority = {
      repository,
      scanId: 'scan-1',
      sourceRevision: 'e'.repeat(40),
      registryFingerprint: `sha256:${'f'.repeat(64)}`,
      grantGeneration: 1,
      adapterId: 'shadcn-v1',
    }
    const reconciled = reconcileSourceBindings({
      repository,
      scan: { authority, symbols: [evidence] },
      previous: null,
      seeds: [],
      allocations: [{ bindingId: 'binding-1', symbolKey: evidence.symbolKey }],
      rebinds: [],
    })
    expect(reconciled.records).toEqual([{ id: 'binding-1', repository, authority, evidence, status: 'bound' }])
  })

  it('[COMP-V2-BINDING-001][COMP-V2-ADMISSION-NEG-001] fails closed outside the binding grammar', () => {
    expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, packageName: null }]), requestWith(), 'github:revision')).toThrow('package owner')
    expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, path: 'src/button file.tsx' }]), requestWith([{ ...buttonRequest, entryPath: 'src/button file.tsx' }]), 'github:revision')).toThrow('source path')
    const longId = `x${'a'.repeat(128)}`
    expect(() => componentCatalogFromShadcnScan(scanWith(), requestWith([{ ...buttonRequest, componentId: longId }]), 'github:revision')).toThrow('invalid')
    const longPackage = `@a/${'b'.repeat(126)}`
    expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, packageName: longPackage }]), requestWith(), 'github:revision')).toThrow('package name')
    for (const exportName of ['Button.Primary', 'Button-Primary']) {
      expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, exportName }]), requestWith([{ ...buttonRequest, exportName }]), 'github:revision')).toThrow('export name')
    }
  })

  it('[COMP-V2-ADMISSION-NEG-001] rejects malformed immutable evidence', () => {
    for (const [field, value] of [['fingerprint', 'B'.repeat(64)], ['sourceHash', 'a'.repeat(63)], ['packageName', 'Bad Package']] as const) {
      expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, [field]: value }]), requestWith(), 'github:revision')).toThrow()
    }
    expect(() => componentCatalogFromShadcnScan(scanWith([button]), requestWith([{ ...buttonRequest, integrity: integrity('f'.repeat(64)) }]), 'github:revision')).toThrow('integrity')
  })

  it('[COMP-V2-ADMISSION-NEG-001] parses every accepted scan and request field', () => {
    const scan = scanWith([button])
    for (const malformed of [
      { ...scan, configs: [{}] },
      { ...scan, tokens: [{}] },
      { ...scan, sourceHashes: { '../button.tsx': sourceHash } },
      { ...scan, diagnostics: [{}] },
      { ...scan, previewDependencies: [{}] },
      { ...scan, previewResolutions: [{}] },
    ]) expect(() => componentCatalogFromShadcnScan(malformed, requestWith(), 'github:revision')).toThrow()

    const request = requestWith()
    for (const malformed of [
      { ...request, version: 2 },
      { ...request, entry: {} },
      { ...request, styles: [{}] },
      { ...request, aliases: [{}] },
      { ...request, dependencies: [{}] },
      { ...request, resolutions: [{}] },
      { ...request, provider: {} },
      { ...request, themeAdapters: [{}] },
    ]) expect(() => componentCatalogFromShadcnScan(scan, malformed, 'github:revision')).toThrow()
  })

  it('[COMP-V2-ADMISSION-NEG-001] requires own fields and rejects repository-access metadata', () => {
    const inheritedScan = Object.assign(Object.create({ adapterId: 'shadcn-v1' }) as object, (() => { const { adapterId: _adapterId, ...rest } = scanWith([button]); return rest })())
    expect(() => componentCatalogFromShadcnScan(inheritedScan, requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan({ ...scanWith([button]), accessToken: 'secret' }, requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan(scanWith([button]), { ...requestWith(), repository: { owner: 'acme', name: 'ui' } }, 'github:revision')).toThrow()
  })

  it('[COMP-V2-ADMISSION-NEG-001] rejects boxed string discriminants', () => {
    expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, declarationKind: new String('function') }]), requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan({ ...scanWith([button]), diagnostics: [{ code: new String('unsupported-export'), path: 'src/button.tsx', message: 'Unsupported.' }] }, requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan(scanWith([button]), requestWith([{ ...buttonRequest, props: { tone: { kind: new String('enum'), values: ['quiet', 'solid'], optional: false } } }]), 'github:revision')).toThrow()
  })

  it('[COMP-V2-ADMISSION-NEG-001] rejects unsafe locators and unknown nested fields', () => {
    for (const component of [
      { ...button, path: '../button.tsx' },
      { ...button, exportName: 'Button.default' },
      { ...button, extra: true },
      { ...button, props: [{ ...button.props[0], extra: true }, button.props[1]] },
    ]) expect(() => componentCatalogFromShadcnScan(scanWith([component]), requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan({ ...scanWith([button]), extra: true }, requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan(scanWith([button]), requestWith([{ ...buttonRequest, extra: true }]), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan(scanWith([button]), { ...requestWith(), extra: true }, 'github:revision')).toThrow()
  })

  it('[COMP-V2-ADMISSION-NEG-001] rejects duplicate identities and locators', () => {
    expect(() => componentCatalogFromShadcnScan(scanWith([button, button]), requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan(scanWith([button]), requestWith([buttonRequest, buttonRequest]), 'github:revision')).toThrow('identity')
    expect(() => componentCatalogFromShadcnScan(scanWith([button]), requestWith([buttonRequest, { ...buttonRequest, componentId: 'shadcn:Other:1234567890abcdef' }]), 'github:revision')).toThrow('locator')
  })

  it('[COMP-V2-ADMISSION-NEG-001] rejects schema approximations and implicit numeric adapters', () => {
    const badProps = [
      {},
      { tone: { kind: 'enum', values: ['quiet', 'solid'], optional: true } },
      { tone: { kind: 'string', optional: false } },
      { tone: { kind: 'enum', values: ['solid', 'quiet'], optional: false } },
      { tone: { kind: 'enum', values: ['quiet', null], optional: false } },
      { tone: { kind: 'enum', values: ['quiet', 1], optional: false } },
      { tone: { kind: 'enum', values: ['quiet', true], optional: false } },
      { tone: { kind: 'enum', values: ['quiet', 'quiet'], optional: false } },
      { tone: { kind: 'enum', values: ['quiet', 'solid'], optional: false, extra: true } },
      { tone: { kind: 'enum', values: ['quiet', 'solid'] } },
    ]
    for (const props of badProps) expect(() => componentCatalogFromShadcnScan(scanWith([button]), requestWith([{ ...buttonRequest, props }]), 'github:revision')).toThrow()
    for (const slots of [[], ['children', 'children'], ['missing']]) expect(() => componentCatalogFromShadcnScan(scanWith([button]), requestWith([{ ...buttonRequest, slots }]), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, props: [...button.props, button.props[0]] }]), requestWith(), 'github:revision')).toThrow()
    expect(() => componentCatalogFromShadcnScan(scanWith([{ ...button, slots: ['missing'] }]), requestWith(), 'github:revision')).toThrow()

    const numeric = { ...button, props: [{ name: 'count', type: 'number', optional: false }], slots: [] }
    const numericRequest = { ...buttonRequest, props: { count: { kind: 'number', optional: false } }, slots: [] }
    expect(() => componentCatalogFromShadcnScan(scanWith([numeric]), requestWith([numericRequest]), 'github:revision')).toThrow('explicit prop adapter')
  })

  it('[COMP-V2-ADMISSION-001] is permutation deterministic', () => {
    const left = componentCatalogFromShadcnScan(scanWith([button, card]), requestWith([buttonRequest, cardRequest]), 'github:revision')
    const right = componentCatalogFromShadcnScan(scanWith([card, button]), requestWith([cardRequest, buttonRequest]), 'github:revision')
    expect(right).toEqual(left)
  })
})
