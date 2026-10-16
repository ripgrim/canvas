import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { hostedPreviewExpectationFromShadcnScanArtifact, parseShadcnScanArtifact } from '../src/artifact.js'
import { scanShadcnPreviewRegistry } from '../src/preview-registry.js'

const sourceHash = 'b'.repeat(64)
const componentId = 'shadcn:Button:8f9171d59b1041d3'
const artifact = Object.freeze({
  sourceRevision: 'a'.repeat(40),
  scan: Object.freeze({ adapterId: 'shadcn-v1', configs: [], components: [{ path: 'src/button.tsx', exportName: 'Button', declarationKind: 'function', props: [], slots: [], sourceHash, fingerprint: 'c'.repeat(64) }], tokens: [], sourceHashes: { 'src/button.tsx': sourceHash }, diagnostics: [] }),
  request: Object.freeze({ version: 1, entry: { componentId }, components: [{ componentId, entryPath: 'src/button.tsx', exportName: 'Button', integrity: `sha256-${Buffer.from(sourceHash, 'hex').toString('base64')}`, props: {}, slots: [] }], styles: [] }),
})

describe('hosted scan artifact validation', () => {
  it('AT-REPO-SCAN-001 accepts the exact integrity-bound scanner contract', () => {
    expect(parseShadcnScanArtifact(artifact)).toMatchObject({ sourceRevision: artifact.sourceRevision, scan: { adapterId: 'shadcn-v1' } })
  })

  it('COMP-V2-CODE-010 accepts the scanner-produced transitive dependency closure', async () => {
    const generated = await scanShadcnPreviewRegistry(resolve(import.meta.dirname, '../../../fixtures/stateful-shadcn-repo'))
    expect(generated.request.dependencies?.length).toBeGreaterThan(0)
    expect(parseShadcnScanArtifact({ sourceRevision: 'e'.repeat(40), ...generated }).request.dependencies).toEqual(generated.request.dependencies)
    const dependencies = generated.request.dependencies ?? []
    const first = dependencies[0]!
    expect(() => parseShadcnScanArtifact({ sourceRevision: 'e'.repeat(40), scan: generated.scan, request: { ...generated.request, dependencies: dependencies.slice(1) } })).toThrow('invalid')
    expect(() => parseShadcnScanArtifact({ sourceRevision: 'e'.repeat(40), scan: generated.scan, request: { ...generated.request, dependencies: [...dependencies, generated.request.styles[0]!] } })).toThrow('invalid')
    expect(() => parseShadcnScanArtifact({ sourceRevision: 'e'.repeat(40), scan: generated.scan, request: { ...generated.request, dependencies: [{ ...first, integrity: `sha256-${Buffer.from('f'.repeat(64), 'hex').toString('base64')}` }, ...dependencies.slice(1)] } })).toThrow('invalid')
    expect(() => parseShadcnScanArtifact({ sourceRevision: 'e'.repeat(40), scan: { ...generated.scan, sourceHashes: { ...generated.scan.sourceHashes, [first.path]: 'f'.repeat(64) } }, request: generated.request })).toThrow('invalid')
  })

  it('COMP-V2-CODE-003 derives immutable preview admission only from the validated registry request', () => {
    expect(hostedPreviewExpectationFromShadcnScanArtifact(artifact)).toEqual({
      sourceRevision: artifact.sourceRevision,
      registryFingerprint: 'sha256:78892a58d1973adad9183c4b14f2a1cbb78464cc42c065fa99d37aa80deddb70',
      components: [{ componentId, exportName: 'Button' }],
    })
    expect(() => hostedPreviewExpectationFromShadcnScanArtifact({ ...artifact, request: { ...artifact.request, components: [{ ...artifact.request.components[0], exportName: 'Card' }] } })).toThrow('invalid')
  })

  it('AT-REPO-SCAN-001 accepts a root workspace from the scanner', () => {
    const configHash = 'd'.repeat(64)
    const rootArtifact = { ...artifact, scan: { ...artifact.scan, configs: [{ source: 'manifest', path: 'components.json', workspace: '', uiAlias: null, uiRoots: ['src'], registryRoots: [], tokenFiles: [], registries: [], moduleConfig: null, previewProvider: null, themeAdapters: [] }], sourceHashes: { ...artifact.scan.sourceHashes, 'components.json': configHash } } }
    expect(parseShadcnScanArtifact(rootArtifact).scan.configs[0]?.workspace).toBe('')
  })

  it('AT-REPO-SCAN-001 rejects incomplete and inconsistent nested results', () => {
    expect(() => parseShadcnScanArtifact({ ...artifact, scan: { adapterId: 'shadcn-v1' } })).toThrow('invalid')
    expect(() => parseShadcnScanArtifact({ ...artifact, request: { ...artifact.request, components: [{ ...artifact.request.components[0], integrity: `sha256-${Buffer.from('d'.repeat(64), 'hex').toString('base64')}` }] } })).toThrow('invalid')
    expect(() => parseShadcnScanArtifact({ ...artifact, request: { ...artifact.request, dependencies: [{ path: 'src/button.tsx', integrity: artifact.request.components[0]!.integrity }, { path: 'src/button.tsx', integrity: artifact.request.components[0]!.integrity }] } })).toThrow('invalid')
  })

  it('AT-REPO-SCAN-001 rejects oversized result collections', () => {
    expect(() => parseShadcnScanArtifact({ ...artifact, scan: { ...artifact.scan, components: Array.from({ length: 5_001 }, () => artifact.scan.components[0]) } })).toThrow('invalid')
  })
})
