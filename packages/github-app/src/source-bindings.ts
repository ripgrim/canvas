import { randomUUID } from 'node:crypto'
import {
  parseSourceBindingReconcileCommand,
  parseSourceBindingSnapshot,
  parseSourceScanAuthority,
  planSourceBindingAllocations,
  reconcileSourceBindings,
  SourceBindingRebindConflictError,
  type SourceBindingRebind,
  type SourceBindingSnapshot,
  type SourceScanAuthority,
  type SourceBindingTransportRebind,
  type SourceSymbolEvidence,
} from '@canvas/repository'
import {
  componentCatalogFromShadcnScan,
  hostedPreviewExpectationFromShadcnScanArtifact,
  parseShadcnScanArtifact,
  sourceSymbolEvidenceFromCatalogEntry,
} from '@canvas/scanner'
import type {
  GitHubActor,
  HostedSourceBindingSnapshot,
  RepositoryGrant,
  RepositorySourceBindingGrantScope,
  RepositorySourceBindingStore,
} from './contracts.js'
import type { GitHubGrantService } from './grants.js'
import type { RepositoryJobService } from './jobs.js'
import { GitHubAppError, opaqueId, validateActor } from './validation.js'

export class HostedSourceBindingConflictError extends Error {
  readonly name = 'HostedSourceBindingConflictError'
}

export class HostedSourceBindingService {
  constructor(
    private readonly grants: GitHubGrantService,
    private readonly jobs: RepositoryJobService,
    private readonly store: RepositorySourceBindingStore,
    private readonly now: () => number = Date.now,
    private readonly allocateBindingId: () => string = randomUUID,
  ) {}

  async get(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
  }>): Promise<HostedSourceBindingSnapshot | null> {
    const context = contextFrom(input)
    const grant = await this.grants.assertLiveRepositoryAccess({ ...context, operation: 'pull' })
    const stored = await this.store.getAuthorized({
      actorAccountId: context.actor.accountId,
      tenantId: context.tenantId,
      projectId: context.projectId,
      operation: 'pull',
    })
    if (stored === null) return null
    const snapshot = parseSourceBindingSnapshot(stored)
    assertAuthorityMatchesGrant(snapshot.authority, grant)
    return snapshot
  }

  async reconcile(input: Readonly<{
    actor: GitHubActor
    tenantId: string
    projectId: string
    scanJobId: string
    expectedVersion: number | null
    expectedAuthority: SourceScanAuthority | null
    rebinds: readonly SourceBindingTransportRebind[]
  }>): Promise<HostedSourceBindingSnapshot> {
    const context = contextFrom(input)
    const command = parseSourceBindingReconcileCommand({
      scanJobId: input.scanJobId,
      expectedVersion: input.expectedVersion,
      expectedAuthority: input.expectedAuthority,
      rebinds: input.rebinds,
    })
    const expectedVersion = version(command.expectedVersion)
    const expectedAuthority = command.expectedAuthority === null ? null : parseSourceScanAuthority(command.expectedAuthority)

    const grant = await this.grants.assertLiveRepositoryAccess({ ...context, operation: 'pull' })
    const job = await this.jobs.readAuthorizedCompletedScan({
      id: command.scanJobId,
      actor: context.actor,
      tenantId: context.tenantId,
      projectId: context.projectId,
    })
    assertJobMatchesGrant(job, grant)

    const artifact = parseShadcnScanArtifact(job.result)
    const expectation = hostedPreviewExpectationFromShadcnScanArtifact(artifact)
    const catalog = componentCatalogFromShadcnScan(artifact.scan, artifact.request, expectation.registryFingerprint)
    const repository = Object.freeze({ provider: 'github' as const, projectId: context.projectId, repositoryId: grant.repository.id })
    const authority = Object.freeze({
      repository,
      scanId: job.id,
      sourceRevision: artifact.sourceRevision,
      registryFingerprint: catalog.fingerprint,
      grantGeneration: grant.grantGeneration,
      adapterId: artifact.scan.adapterId,
    })
    const symbols = Object.freeze(catalog.components.map(sourceSymbolEvidenceFromCatalogEntry))
    const rebinds = resolveTrustedRebinds(command.rebinds, symbols)

    const stored = await this.store.getAuthorized({
      actorAccountId: context.actor.accountId,
      tenantId: context.tenantId,
      projectId: context.projectId,
      operation: 'pull',
    })
    const current = stored === null ? null : parseSourceBindingSnapshot(stored)
    assertExpected(current, expectedVersion, expectedAuthority)
    if (current) assertPriorAuthorityCompatible(current.authority, grant)
    const previous = current === null ? null : { authority: current.authority, records: current.records }
    const base = { repository, scan: { authority, symbols }, previous, seeds: [], rebinds }
    let reconciled: ReturnType<typeof reconcileSourceBindings>
    try {
      const plan = planSourceBindingAllocations(base)
      const allocations = plan.requiredSymbolKeys.map(symbolKey => ({ bindingId: serverUuid(this.allocateBindingId()), symbolKey }))
      reconciled = reconcileSourceBindings({ ...base, allocations })
    } catch (error) {
      if (error instanceof SourceBindingRebindConflictError) throw stale()
      throw error
    }
    const updatedAt = this.now()
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw invalid()

    const committed = await this.store.commitAuthorized({
      actorAccountId: context.actor.accountId,
      tenantId: context.tenantId,
      projectId: context.projectId,
      operation: 'pull',
      expectedVersion: current?.version ?? null,
      expectedAuthority: current?.authority ?? null,
      grantScope: grantScope(grant),
      scanScope: {
        scanJobId: job.id,
        sourceRevision: artifact.sourceRevision,
        registryFingerprint: catalog.fingerprint,
      },
      candidate: { authority: reconciled.authority, records: reconciled.records, updatedAt },
    })
    if (committed.status === 'unauthorized') throw unavailable()
    if (committed.status === 'stale') throw stale()
    const snapshot = parseSourceBindingSnapshot(committed.snapshot)
    if (snapshot.version !== (current?.version ?? 0) + 1
      || snapshot.updatedAt !== updatedAt
      || JSON.stringify(snapshot.authority) !== JSON.stringify(reconciled.authority)
      || JSON.stringify(snapshot.records) !== JSON.stringify(reconciled.records)) throw invalid()
    return snapshot
  }
}

function resolveTrustedRebinds(
  rebinds: readonly SourceBindingTransportRebind[],
  symbols: readonly SourceSymbolEvidence[],
): readonly SourceBindingRebind[] {
  const consumedTargets = new Set<string>()
  return Object.freeze(rebinds.map(item => {
    const matches = symbols.filter(symbol => symbol.symbolKey === item.nextSymbolKey)
    if (matches.length !== 1 || consumedTargets.has(item.nextSymbolKey)) throw stale()
    consumedTargets.add(item.nextSymbolKey)
    return Object.freeze({
      bindingId: item.bindingId,
      expectedAuthority: item.expectedAuthority,
      expectedEvidence: item.expectedEvidence,
      replacement: matches[0]!,
    })
  }))
}

function contextFrom(input: Readonly<{ actor: GitHubActor; tenantId: string; projectId: string }>) {
  return Object.freeze({ actor: validateActor(input.actor), tenantId: opaqueId(input.tenantId), projectId: opaqueId(input.projectId) })
}

function version(value: number | null): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw stale()
  return value
}

function assertExpected(current: SourceBindingSnapshot | null, expectedVersion: number | null, expectedAuthority: SourceScanAuthority | null): void {
  if (current === null) {
    if (expectedVersion !== null || expectedAuthority !== null) throw stale()
    return
  }
  if (expectedVersion !== current.version || expectedAuthority === null
    || JSON.stringify(expectedAuthority) !== JSON.stringify(current.authority)) throw stale()
}

function assertAuthorityMatchesGrant(authority: SourceScanAuthority, grant: RepositoryGrant): void {
  if (authority.repository.provider !== 'github'
    || authority.repository.projectId !== grant.projectId
    || authority.repository.repositoryId !== grant.repository.id
    || authority.grantGeneration !== grant.grantGeneration) throw unavailable()
}

function assertPriorAuthorityCompatible(authority: SourceScanAuthority, grant: RepositoryGrant): void {
  if (authority.repository.provider !== 'github'
    || authority.repository.projectId !== grant.projectId
    || authority.repository.repositoryId !== grant.repository.id
    || authority.grantGeneration > grant.grantGeneration) throw unavailable()
}

function assertJobMatchesGrant(job: Readonly<{
  installationId: string
  repositoryId: string
  repositoryLinkedAt: number
  repositoryGrantId: string
  repositoryGrantGeneration: number
}>, grant: RepositoryGrant): void {
  if (job.installationId !== grant.installationId
    || job.repositoryId !== grant.repository.id
    || job.repositoryLinkedAt !== grant.linkedAt
    || job.repositoryGrantId !== grant.grantId
    || job.repositoryGrantGeneration !== grant.grantGeneration) throw unavailable()
}

function grantScope(grant: RepositoryGrant): RepositorySourceBindingGrantScope {
  return Object.freeze({
    installationId: grant.installationId,
    repositoryId: grant.repository.id,
    repositoryLinkedAt: grant.linkedAt,
    repositoryGrantId: grant.grantId,
    repositoryGrantGeneration: grant.grantGeneration,
  })
}

function unavailable(): GitHubAppError {
  return new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
}

function stale(): Error {
  return new HostedSourceBindingConflictError('Repository source bindings changed.')
}

function invalid(): Error {
  return new Error('Repository source bindings are invalid.')
}

function serverUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw invalid()
  return value
}
