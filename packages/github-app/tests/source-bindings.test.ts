import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseSourceBindingSnapshot, type SourceBindingSnapshot } from '@canvas/repository'
import {
  GitHubAppError,
  HostedSourceBindingConflictError,
  HostedSourceBindingService,
  type GitHubActor,
  type GitHubGrantService,
  type GitHubRepositoryIdentity,
  type RepositoryGrant,
  type RepositoryJob,
  type RepositoryJobService,
  type RepositorySourceBindingStore,
} from '../src/index.js'

const now = 1_800_000_000_000
const actor: GitHubActor = { accountId: 'account-1', providerUserId: '1001' }
const repository: GitHubRepositoryIdentity = {
  id: '4001',
  installationId: '2001',
  ownerId: '3001',
  ownerLogin: 'canvas-team',
  name: 'design-system',
  fullName: 'canvas-team/design-system',
  isPrivate: true,
  contentsPermission: 'write',
}
const grant: RepositoryGrant = {
  grantId: '00000000-0000-4000-8000-000000000010',
  grantGeneration: 1,
  tenantId: 'tenant-1',
  projectId: 'project-1',
  installationId: repository.installationId,
  repository,
  linkedByAccountId: actor.accountId,
  linkedAt: now - 1_000,
}

function artifact(componentCount = 1) {
  const components = Array.from({ length: componentCount }, (_, index) => {
    const name = index === 0 ? 'Button' : `Card${index}`
    const path = index === 0 ? 'src/button.tsx' : `src/card-${index}.tsx`
    const sourceHash = `${index + 1}`.repeat(64)
    const componentId = `shadcn:${name}:${createHash('sha256').update(`${path}\0${name}`).digest('hex').slice(0, 16)}`
    return {
      scan: { path, exportName: name, packageName: '@acme/ui', declarationKind: 'function', props: [], slots: [], sourceHash, fingerprint: `${index + 3}`.repeat(64) },
      request: { componentId, entryPath: path, exportName: name, integrity: `sha256-${Buffer.from(sourceHash, 'hex').toString('base64')}`, props: {}, slots: [] },
    }
  })
  return {
    sourceRevision: 'a'.repeat(40),
    scan: {
      adapterId: 'shadcn-v1',
      configs: [],
      components: components.map(component => component.scan),
      tokens: [],
      sourceHashes: Object.fromEntries(components.map(component => [component.scan.path, component.scan.sourceHash])),
      diagnostics: [],
    },
    request: {
      version: 1,
      entry: { componentId: components[0]!.request.componentId },
      components: components.map(component => component.request),
      styles: [],
    },
  }
}

function completedJob(result = artifact()): RepositoryJob & Readonly<{ status: 'completed' }> {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    actor,
    tenantId: grant.tenantId,
    projectId: grant.projectId,
    operation: 'scan',
    installationId: grant.installationId,
    repositoryId: grant.repository.id,
    repositoryLinkedAt: grant.linkedAt,
    repositoryGrantId: grant.grantId,
    repositoryGrantGeneration: grant.grantGeneration,
    status: 'completed',
    result,
    completedAt: now - 500,
    createdAt: now - 750,
    attempt: 1,
  }
}

function movedArtifact(candidateCount = 1) {
  const components = Array.from({ length: candidateCount }, (_, index) => {
    const name = index === 0 ? 'MovedButton' : `MovedButton${index + 1}`
    const path = `src/moved-button-${index + 1}.tsx`
    const sourceHash = `${index + 5}`.repeat(64)
    const componentId = `shadcn:${name}:${createHash('sha256').update(`${path}\0${name}`).digest('hex').slice(0, 16)}`
    return {
      scan: { path, exportName: name, packageName: '@acme/ui', declarationKind: 'function', props: [], slots: [], sourceHash, fingerprint: '3'.repeat(64) },
      request: { componentId, entryPath: path, exportName: name, integrity: `sha256-${Buffer.from(sourceHash, 'hex').toString('base64')}`, props: {}, slots: [] },
    }
  })
  return {
    sourceRevision: 'b'.repeat(40),
    scan: { adapterId: 'shadcn-v1', configs: [], components: components.map(component => component.scan), tokens: [], sourceHashes: Object.fromEntries(components.map(component => [component.scan.path, component.scan.sourceHash])), diagnostics: [] },
    request: { version: 1, entry: { componentId: components[0]!.request.componentId }, components: components.map(component => component.request), styles: [] },
  }
}

class MemoryBindingStore implements RepositorySourceBindingStore {
  current: unknown | null = null
  authorize = true
  staleCommit = false
  lastCommit: Parameters<RepositorySourceBindingStore['commitAuthorized']>[0] | null = null

  async getAuthorized() {
    return this.authorize ? this.current : null
  }

  async commitAuthorized(input: Parameters<RepositorySourceBindingStore['commitAuthorized']>[0]) {
    this.lastCommit = input
    if (!this.authorize) return { status: 'unauthorized' as const }
    if (this.staleCommit) return { status: 'stale' as const }
    const prior = this.current === null ? null : parseSourceBindingSnapshot(this.current)
    if (input.expectedVersion !== (prior?.version ?? null)
      || JSON.stringify(input.expectedAuthority) !== JSON.stringify(prior?.authority ?? null)) return { status: 'stale' as const }
    const snapshot: SourceBindingSnapshot = {
      version: (prior?.version ?? 0) + 1,
      authority: input.candidate.authority,
      records: input.candidate.records,
      updatedAt: input.candidate.updatedAt,
    }
    this.current = snapshot
    return { status: 'committed' as const, snapshot }
  }
}

function scenario(input: Readonly<{
  job?: RepositoryJob
  liveGrant?: RepositoryGrant
  componentCount?: number
  allocateBindingId?: () => string
}> = {}) {
  let liveGrant = input.liveGrant ?? grant
  let job = input.job ?? completedJob(artifact(input.componentCount))
  const store = new MemoryBindingStore()
  const grants = {
    async assertLiveRepositoryAccess(request: { actor: GitHubActor; tenantId: string; projectId: string; operation: string }) {
      if (request.actor.accountId !== actor.accountId || request.tenantId !== liveGrant.tenantId
        || request.projectId !== liveGrant.projectId || request.operation !== 'pull') throw unavailable()
      return liveGrant
    },
  } as unknown as GitHubGrantService
  const jobs = {
    async readAuthorizedCompletedScan(request: { id: string; actor: GitHubActor; tenantId: string; projectId: string }) {
      if (request.id !== job.id || request.actor.accountId !== actor.accountId
        || request.tenantId !== job.tenantId || request.projectId !== job.projectId
        || job.operation !== 'scan' || job.status !== 'completed') throw unavailable()
      return job
    },
  } as unknown as RepositoryJobService
  const service = new HostedSourceBindingService(grants, jobs, store, () => now, input.allocateBindingId ?? (() => '00000000-0000-4000-8000-000000000030'))
  return { service, store, setGrant(value: RepositoryGrant) { liveGrant = value }, setJob(value: RepositoryJob) { job = value } }
}

const firstRequest = {
  actor,
  tenantId: grant.tenantId,
  projectId: grant.projectId,
  scanJobId: '00000000-0000-4000-8000-000000000020',
  expectedVersion: null,
  expectedAuthority: null,
  rebinds: [],
} as const

describe('hosted source bindings', () => {
  it('[COMP-V2-BINDING-001] allocates opaque ids on the server and publishes only the renderer snapshot', async () => {
    const { service, store } = scenario()
    const snapshot = await service.reconcile(firstRequest)
    expect(snapshot).toMatchObject({ version: 1, updatedAt: now, records: [{ id: '00000000-0000-4000-8000-000000000030', status: 'bound' }] })
    expect(Object.keys(snapshot)).toEqual(['version', 'authority', 'records', 'updatedAt'])
    expect(store.lastCommit).toMatchObject({
      actorAccountId: actor.accountId,
      tenantId: grant.tenantId,
      projectId: grant.projectId,
      operation: 'pull',
      grantScope: { repositoryGrantId: grant.grantId, repositoryGrantGeneration: grant.grantGeneration },
      scanScope: { scanJobId: firstRequest.scanJobId, sourceRevision: 'a'.repeat(40) },
    })
    await expect(service.get({ actor, tenantId: grant.tenantId, projectId: grant.projectId })).resolves.toEqual(snapshot)
  })

  it('[AT-REPO-LINK-001][AT-REPO-SCAN-001] rejects a stale grant generation and a wrong scan grant', async () => {
    const staleGeneration = scenario({ liveGrant: { ...grant, grantGeneration: 2 } })
    await expect(staleGeneration.service.reconcile(firstRequest)).rejects.toSatisfy(error => errorCode(error) === 'REPOSITORY_NOT_VISIBLE')

    const wrongGrant = scenario({ job: { ...completedJob(), repositoryGrantId: '00000000-0000-4000-8000-000000000099' } })
    await expect(wrongGrant.service.reconcile(firstRequest)).rejects.toSatisfy(error => errorCode(error) === 'REPOSITORY_NOT_VISIBLE')

    const wrongScan = scenario({ job: { ...completedJob(), operation: 'pull' } })
    await expect(wrongScan.service.reconcile(firstRequest)).rejects.toSatisfy(error => errorCode(error) === 'REPOSITORY_NOT_VISIBLE')
  })

  it('[COMP-V2-BINDING-001] rejects stale expected state and a transactional stale commit', async () => {
    const { service, store } = scenario()
    const current = await service.reconcile(firstRequest)
    await expect(service.reconcile({ ...firstRequest, expectedVersion: current.version, expectedAuthority: { ...current.authority, scanId: 'other-scan' } })).rejects.toThrow('changed')
    store.staleCommit = true
    await expect(service.reconcile({ ...firstRequest, expectedVersion: current.version, expectedAuthority: current.authority })).rejects.toThrow('changed')
  })

  it('[COMP-V2-BINDING-001] preserves identity through a checked rebind and types only user-resolvable conflicts', async () => {
    const prepare = async (candidateCount = 1) => {
      const state = scenario()
      const original = await state.service.reconcile(firstRequest)
      const nextJob = { ...completedJob(movedArtifact(candidateCount)), id: '00000000-0000-4000-8000-000000000021' }
      state.setJob(nextJob)
      const ambiguous = await state.service.reconcile({ ...firstRequest, scanJobId: nextJob.id, expectedVersion: original.version, expectedAuthority: original.authority })
      expect(ambiguous.records[0]!.status).toBe('ambiguous')
      return { state, original, nextJob, ambiguous, record: ambiguous.records[0]! }
    }

    const success = await prepare()
    if (success.record.status !== 'ambiguous') throw new Error('Expected an ambiguous binding fixture.')
    const rebound = await success.state.service.reconcile({
      ...firstRequest,
      scanJobId: success.nextJob.id,
      expectedVersion: success.ambiguous.version,
      expectedAuthority: success.ambiguous.authority,
      rebinds: [{ bindingId: success.record.id, expectedAuthority: success.ambiguous.authority, expectedEvidence: success.record.evidence, nextSymbolKey: success.record.candidates[0]!.symbolKey }],
    })
    expect(rebound.records[0]).toMatchObject({ id: success.original.records[0]!.id, status: 'bound', evidence: success.record.candidates[0] })

    const staleEvidence = await prepare()
    if (staleEvidence.record.status !== 'ambiguous') throw new Error('Expected an ambiguous binding fixture.')
    await expect(staleEvidence.state.service.reconcile({
      ...firstRequest,
      scanJobId: staleEvidence.nextJob.id,
      expectedVersion: staleEvidence.ambiguous.version,
      expectedAuthority: staleEvidence.ambiguous.authority,
      rebinds: [{ bindingId: staleEvidence.record.id, expectedAuthority: staleEvidence.ambiguous.authority, expectedEvidence: { ...staleEvidence.record.evidence, sourceHash: 'f'.repeat(64) }, nextSymbolKey: staleEvidence.record.candidates[0]!.symbolKey }],
    })).rejects.toBeInstanceOf(HostedSourceBindingConflictError)

    const ineligible = await prepare()
    if (ineligible.record.status !== 'ambiguous') throw new Error('Expected an ambiguous binding fixture.')
    await expect(ineligible.state.service.reconcile({
      ...firstRequest,
      scanJobId: ineligible.nextJob.id,
      expectedVersion: ineligible.ambiguous.version,
      expectedAuthority: ineligible.ambiguous.authority,
      rebinds: [{ bindingId: 'unknown-binding', expectedAuthority: ineligible.ambiguous.authority, expectedEvidence: ineligible.record.evidence, nextSymbolKey: ineligible.record.candidates[0]!.symbolKey }],
    })).rejects.toBeInstanceOf(HostedSourceBindingConflictError)

    const nonUnique = await prepare(2)
    if (nonUnique.record.status !== 'ambiguous') throw new Error('Expected an ambiguous binding fixture.')
    await expect(nonUnique.state.service.reconcile({
      ...firstRequest,
      scanJobId: nonUnique.nextJob.id,
      expectedVersion: nonUnique.ambiguous.version,
      expectedAuthority: nonUnique.ambiguous.authority,
      rebinds: [{ bindingId: nonUnique.record.id, expectedAuthority: nonUnique.ambiguous.authority, expectedEvidence: nonUnique.record.evidence, nextSymbolKey: nonUnique.record.candidates[0]!.symbolKey }],
    })).rejects.toBeInstanceOf(HostedSourceBindingConflictError)

    const missingTarget = await prepare()
    if (missingTarget.record.status !== 'ambiguous') throw new Error('Expected an ambiguous binding fixture.')
    await expect(missingTarget.state.service.reconcile({
      ...firstRequest,
      scanJobId: missingTarget.nextJob.id,
      expectedVersion: missingTarget.ambiguous.version,
      expectedAuthority: missingTarget.ambiguous.authority,
      rebinds: [{ bindingId: missingTarget.record.id, expectedAuthority: missingTarget.ambiguous.authority, expectedEvidence: missingTarget.record.evidence, nextSymbolKey: 'missing-symbol' }],
    })).rejects.toBeInstanceOf(HostedSourceBindingConflictError)

    const duplicateTarget = await prepare()
    if (duplicateTarget.record.status !== 'ambiguous') throw new Error('Expected an ambiguous binding fixture.')
    const duplicateRebind = { bindingId: duplicateTarget.record.id, expectedAuthority: duplicateTarget.ambiguous.authority, expectedEvidence: duplicateTarget.record.evidence, nextSymbolKey: duplicateTarget.record.candidates[0]!.symbolKey }
    await expect(duplicateTarget.state.service.reconcile({
      ...firstRequest,
      scanJobId: duplicateTarget.nextJob.id,
      expectedVersion: duplicateTarget.ambiguous.version,
      expectedAuthority: duplicateTarget.ambiguous.authority,
      rebinds: [duplicateRebind, duplicateRebind],
    })).rejects.toBeInstanceOf(HostedSourceBindingConflictError)
  })

  it('[COMP-V2-BINDING-001][AT-REPO-LINK-001] advances a compatible persisted binding to the new relink generation', async () => {
    const scenarioState = scenario()
    const current = await scenarioState.service.reconcile(firstRequest)
    const relinked = { ...grant, grantId: '00000000-0000-4000-8000-000000000011', grantGeneration: 2 }
    scenarioState.setGrant(relinked)
    scenarioState.setJob({
      ...completedJob(),
      id: '00000000-0000-4000-8000-000000000021',
      repositoryGrantId: relinked.grantId,
      repositoryGrantGeneration: relinked.grantGeneration,
    })
    const refreshed = await scenarioState.service.reconcile({
      ...firstRequest,
      scanJobId: '00000000-0000-4000-8000-000000000021',
      expectedVersion: current.version,
      expectedAuthority: current.authority,
    })
    expect(refreshed.authority.grantGeneration).toBe(2)
    expect(refreshed.records[0]!.id).toBe(current.records[0]!.id)
  })

  it('[COMP-V2-BINDING-001] rejects malformed persisted state before planning or committing', async () => {
    const { service, store } = scenario()
    store.current = { version: 1, authority: null, records: [], updatedAt: now }
    await expect(service.reconcile(firstRequest)).rejects.toThrow('snapshot')
    expect(store.lastCommit).toBeNull()
  })

  it('[COMP-V2-BINDING-001] rejects allocator collisions before persistence', async () => {
    const { service, store } = scenario({ componentCount: 2, allocateBindingId: () => '00000000-0000-4000-8000-000000000030' })
    await expect(service.reconcile(firstRequest)).rejects.toThrow('collision')
    expect(store.lastCommit).toBeNull()
  })
})

function unavailable(): GitHubAppError {
  return new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
}

function errorCode(error: unknown): string | undefined {
  return error instanceof GitHubAppError ? error.code : undefined
}
