import { describe, expect, it, vi } from 'vitest'
import type { SourceBindingRecord, SourceBindingSnapshot, SourceScanAuthority, SourceSymbolEvidence } from '@canvas/repository'
import type { EditorHostedRepositoryApi, EditorHostedRepositoryScan } from '../../capabilities'
import type { EditorState } from './store'
import { createHostedSourceBindingService } from './hosted-source-binding-service'

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
  symbolKey: 'symbol-button',
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

const bound = (overrides: Partial<SourceBindingRecord> = {}): SourceBindingRecord => ({
  id: 'opaque-binding', repository, authority, evidence: button, status: 'bound', ...overrides,
}) as SourceBindingRecord

const binding = (overrides: Partial<SourceBindingSnapshot> = {}): SourceBindingSnapshot => ({
  version: 4, authority, records: [bound()], updatedAt: 17, ...overrides,
})

const scan = (symbols: readonly SourceSymbolEvidence[] = [button], scanAuthority: SourceScanAuthority = authority): EditorHostedRepositoryScan => ({
  jobId: scanAuthority.scanId,
  adapterId: scanAuthority.adapterId,
  sourceRevision: scanAuthority.sourceRevision,
  componentCount: symbols.length,
  registry: {
    fingerprint: scanAuthority.registryFingerprint,
    components: symbols.map((symbol, index) => ({
      componentId: `catalog-${index}`,
      ...symbol,
      props: symbol === button ? [{ name: 'tone', type: "'quiet' | 'solid'", optional: true }] : [],
      slots: symbol === button ? ['children'] : [],
    })),
  },
})

function projectSource(initial: { projectId: string; fileId?: string } | null = null) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => ({ snapshot: current } as unknown as Pick<EditorState, 'snapshot'>),
      subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    },
    set(next: { projectId: string; fileId?: string } | null) { current = next; listeners.forEach(listener => listener()) },
    listenerCount: () => listeners.size,
  }
}

function hosted(readSourceBindings: EditorHostedRepositoryApi['readSourceBindings'], getScan: EditorHostedRepositoryApi['getScan'] = vi.fn(async () => scan())) {
  return { readSourceBindings, getScan } as EditorHostedRepositoryApi
}

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('COMP-V2-BINDING-001 hosted source binding service', () => {
  it('requires the exact project and file context before reading', async () => {
    const projects = projectSource({ projectId: 'project-1' })
    const readSourceBindings = vi.fn(async () => ({ status: 'authorized' as const, snapshot: binding() }))
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(readSourceBindings))
    await settle()

    expect(service.getSnapshot()).toEqual({ status: 'idle', context: null, projection: null, error: null })
    expect(readSourceBindings).not.toHaveBeenCalled()
  })

  it('loads through the exact scan and exposes only the sanitized projection', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const getScan = vi.fn(async () => scan())
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(vi.fn(async () => ({ status: 'authorized' as const, snapshot: binding() })), getScan))
    await settle()

    expect(getScan).toHaveBeenCalledWith('scan-1')
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready', context: { projectId: 'project-1', fileId: 'file-1' },
      projection: { authority: { version: 4, scanId: 'scan-1' }, components: [{ bindingId: 'opaque-binding', status: 'bound', name: 'Button' }] },
      error: null,
    })
    const wire = JSON.stringify(service.getSnapshot())
    expect(wire).not.toContain(button.path)
    expect(wire).not.toContain(button.sourceHash)
    expect(wire).not.toContain(button.symbolKey)
  })

  it('clears synchronously on a file change and ignores the late prior completion', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    let release!: (value: Awaited<ReturnType<EditorHostedRepositoryApi['readSourceBindings']>>) => void
    const first = new Promise<Awaited<ReturnType<EditorHostedRepositoryApi['readSourceBindings']>>>(resolve => { release = resolve })
    const readSourceBindings = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ status: 'authorized', snapshot: null })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(readSourceBindings))

    projects.set({ projectId: 'project-1', fileId: 'file-2' })
    expect(service.getSnapshot()).toEqual({ status: 'loading', context: { projectId: 'project-1', fileId: 'file-2' }, projection: null, error: null })
    await settle()
    release({ status: 'authorized', snapshot: binding() })
    await settle()

    expect(service.getSnapshot()).toEqual({ status: 'empty', context: { projectId: 'project-1', fileId: 'file-2' }, projection: null, error: null })
  })

  it('clears synchronously when context disappears and after stop', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(vi.fn(async () => ({ status: 'authorized' as const, snapshot: binding() }))))
    await settle()
    expect(service.getSnapshot().status).toBe('ready')

    projects.set(null)
    expect(service.getSnapshot()).toEqual({ status: 'idle', context: null, projection: null, error: null })
    service.stop()
    expect(projects.listenerCount()).toBe(0)
    expect(service.getSnapshot()).toEqual({ status: 'idle', context: null, projection: null, error: null })
  })

  it('publishes generic first-failure state without exposing the thrown error', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(vi.fn(async () => { throw new Error('secret transport detail') })))
    await settle()

    expect(service.getSnapshot()).toEqual({
      status: 'error', context: { projectId: 'project-1', fileId: 'file-1' }, projection: null, error: 'Source bindings are unavailable.',
    })
    expect(JSON.stringify(service.getSnapshot())).not.toContain('secret transport detail')
  })

  it.each(['read', 'scan', 'join'] as const)('retains the exact last-good projection on a same-context %s failure', async failure => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const next = { ...binding(), version: 5, updatedAt: 18 }
    const reads = vi.fn()
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding() })
      .mockImplementationOnce(async () => {
        if (failure === 'read') throw new Error('offline')
        return { status: 'authorized', snapshot: failure === 'join' ? { ...next, authority: { ...authority, sourceRevision: 'z' } } : next }
      })
    const getScan = vi.fn()
      .mockResolvedValueOnce(scan())
      .mockImplementationOnce(async () => {
        if (failure === 'scan') throw new Error('scan unavailable')
        return scan()
      })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(reads, getScan))
    await settle()
    const lastGood = service.getSnapshot().projection

    service.refresh()
    await settle()

    expect(service.getSnapshot()).toEqual({
      status: 'stale', context: { projectId: 'project-1', fileId: 'file-1' }, projection: lastGood, error: 'Source bindings are unavailable.',
    })
    expect(service.getSnapshot().projection).toBe(lastGood)
  })

  it('treats authorized null and access removal as authoritative clearing results', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const reads = vi.fn()
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding() })
      .mockResolvedValueOnce({ status: 'authorized', snapshot: null })
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding() })
      .mockResolvedValueOnce({ status: 'access-removed' })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(reads))
    await settle()
    service.refresh()
    await settle()
    expect(service.getSnapshot()).toEqual({ status: 'empty', context: { projectId: 'project-1', fileId: 'file-1' }, projection: null, error: null })

    service.refresh()
    await settle()
    expect(service.getSnapshot().status).toBe('ready')
    service.refresh()
    await settle()
    expect(service.getSnapshot()).toEqual({ status: 'access-removed', context: { projectId: 'project-1', fileId: 'file-1' }, projection: null, error: null })
  })

  it('does not let a lower version replace the accepted projection', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const reads = vi.fn()
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding() })
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding({ version: 3, updatedAt: 99 }) })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(reads))
    await settle()
    const accepted = service.getSnapshot().projection
    service.refresh()
    await settle()

    expect(service.getSnapshot().status).toBe('ready')
    expect(service.getSnapshot().projection).toBe(accepted)
  })

  it('requires byte-identical authority and records at the same version but treats updatedAt as metadata', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const changedRecord = bound({ evidence: { ...button, exportName: 'Changed' } })
    const reads = vi.fn()
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding() })
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding({ updatedAt: 500 }) })
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding({ records: [changedRecord], updatedAt: 501 }) })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(reads))
    await settle()
    service.refresh()
    await settle()
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', projection: { authority: { updatedAt: 500 } } })
    const metadataProjection = service.getSnapshot().projection

    service.refresh()
    await settle()
    expect(service.getSnapshot().status).toBe('stale')
    expect(service.getSnapshot().projection).toBe(metadataProjection)
  })

  it('rejects grant regression at a higher version', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const regressedAuthority = { ...authority, grantGeneration: 2 }
    const reads = vi.fn()
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding() })
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding({ version: 5, authority: regressedAuthority, records: [bound({ authority: regressedAuthority })] }) })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(reads))
    await settle()
    const accepted = service.getSnapshot().projection
    service.refresh()
    await settle()

    expect(service.getSnapshot().status).toBe('stale')
    expect(service.getSnapshot().projection).toBe(accepted)
  })

  it('replaces a valid bound projection with explicit missing and ambiguous states', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    const records: SourceBindingRecord[] = [
      bound({ id: 'opaque-missing', status: 'missing' }),
      bound({ id: 'opaque-choice', evidence: label, status: 'ambiguous', candidates: [button, label] }),
    ]
    const reads = vi.fn()
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding() })
      .mockResolvedValueOnce({ status: 'authorized', snapshot: binding({ version: 5, records, updatedAt: 18 }) })
    const getScan = vi.fn().mockResolvedValueOnce(scan()).mockResolvedValueOnce(scan([button, label]))
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(reads, getScan))
    await settle()
    service.refresh()
    await settle()

    expect(service.getSnapshot().projection?.components).toEqual([
      { bindingId: 'opaque-missing', status: 'missing' },
      { bindingId: 'opaque-choice', status: 'ambiguous', candidates: [{ choiceToken: 'candidate:1', name: 'Button' }, { choiceToken: 'candidate:2', name: 'Label' }] },
    ])
  })

  it('ignores a completion after disposal', async () => {
    const projects = projectSource({ projectId: 'project-1', fileId: 'file-1' })
    let release!: (value: Awaited<ReturnType<EditorHostedRepositoryApi['readSourceBindings']>>) => void
    const pending = new Promise<Awaited<ReturnType<EditorHostedRepositoryApi['readSourceBindings']>>>(resolve => { release = resolve })
    const service = createHostedSourceBindingService(projects.source)
    service.start(hosted(vi.fn(() => pending)))
    service.dispose()
    release({ status: 'authorized', snapshot: binding() })
    await settle()

    expect(service.getSnapshot()).toEqual({ status: 'idle', context: null, projection: null, error: null })
  })
})
