import { createHash } from 'node:crypto'
import { blumeDocsAdapterInputs, parseBlumeDocsAdapter } from '@canvas/repo-engine/component-docs-adapter'
import { planBlumeComponentDocs } from '@canvas/repo-engine/component-docs-blume'
import { hostedDocsReview, type HostedDocsReviewBundle } from '@canvas/repo-engine/hosted-source-review'
import { createRepoEngine } from '@canvas/repo-engine'
import type { EngineOptions } from '@canvas/repo-engine'
import { parseShadcnScanArtifact } from '@canvas/scanner/artifact'
import type { HostedDocsSnapshotPort, HostedDocsSourceRequest } from './index.js'

export type HostedDocsPrepareJob = HostedDocsSourceRequest & Readonly<{
  projectId: string
  fileId: string
  fileRevision: number
  fileDocumentSha256: string
  scanJobId: string
  installationId: string
  repositoryId: string
  repositoryGrantId: string
  repositoryLinkedAt: number
  baseRef: string
  baseCommitSha: string
  baseTreeSha: string
  adapter: Readonly<Record<string, unknown>>
  document: Readonly<Record<string, unknown>>
  scan: Readonly<Record<string, unknown>>
}>

export interface HostedDocsPrepareQueuePort {
  claim(): Promise<HostedDocsPrepareJob | null>
  complete(job: HostedDocsPrepareJob, bundle: HostedDocsReviewBundle): Promise<void>
}

export interface HostedDocsPreparer {
  prepare(job: HostedDocsPrepareJob, repositoryRoot: string): Promise<HostedDocsReviewBundle>
}

export function createBlumeDocsPreparer(validateDocumentation: NonNullable<EngineOptions['validateDocumentation']>): HostedDocsPreparer {
  const preparer: HostedDocsPreparer = {
    async prepare(job, repositoryRoot) {
      const adapter = parseBlumeDocsAdapter(job.adapter)
      const scan = parseShadcnScanArtifact(job.scan)
      if (scan.sourceRevision !== job.baseCommitSha || scan.sourceRevision !== job.sourceRevision) throw new Error('Documentation review source changed.')
      const componentModel = record(job.document.componentModel, 'component model')
      const verified = scan.request.components.map(component => Object.freeze({ componentId: component.componentId, exportName: component.exportName }))
      const inputs = blumeDocsAdapterInputs(componentModel as never, verified, adapter)
      const plan = planBlumeComponentDocs(inputs.catalog, inputs.examples, { ...inputs.layout, navigationSource: null })
      const engine = await createRepoEngine(repositoryRoot, { validateDocumentation })
      const prepared = await engine.prepareBlumeDocs(inputs.catalog, inputs.examples, inputs.layout)
      if (prepared.validation.some(check => check.status !== 'passed')) throw new Error('Documentation review validation did not pass.')
      const bundle = {
        version: 1,
        projectId: job.projectId,
        fileId: job.fileId,
        fileRevision: job.fileRevision,
        fileDocumentSha256: job.fileDocumentSha256,
        scanJobId: job.scanJobId,
        installationId: job.installationId,
        repositoryId: job.repositoryId,
        repositoryGrantId: job.repositoryGrantId,
        repositoryLinkedAt: job.repositoryLinkedAt,
        baseRef: job.baseRef,
        baseCommitSha: job.baseCommitSha,
        baseTreeSha: job.baseTreeSha,
        adapter,
        files: prepared.files.map(file => Object.freeze({ path: file.path, beforeSha256: file.before === null ? null : createHash('sha256').update(file.before).digest('hex'), after: file.after, diff: file.diff })),
        omissions: plan.omissions,
        validation: prepared.validation.map(check => Object.freeze({ name: check.name, detail: check.detail })),
      }
      return hostedDocsReview(bundle).bundle
    },
  }
  return Object.freeze(preparer)
}

export function createHostedDocsPrepareProcessor(options: Readonly<{ queue: HostedDocsPrepareQueuePort; snapshot: HostedDocsSnapshotPort; preparer: HostedDocsPreparer }>) {
  return Object.freeze({
    async runOnce(): Promise<'idle' | 'completed'> {
      const job = await options.queue.claim()
      if (!job) return 'idle'
      const source = await options.snapshot.open(job)
      try {
        const bundle = await options.preparer.prepare(job, source.root)
        await options.queue.complete(job, bundle)
        return 'completed'
      } finally {
        await source.dispose()
      }
    },
  })
}

export function createHttpHostedDocsPrepareQueue(options: Readonly<{ apiOrigin: string; serviceToken: string; fetch?: typeof globalThis.fetch }>): HostedDocsPrepareQueuePort {
  const origin = apiOrigin(options.apiOrigin)
  const token = serviceToken(options.serviceToken)
  const request = options.fetch ?? globalThis.fetch
  const call = async (pathname: string, body: object): Promise<Record<string, unknown>> => {
    const response = await request(new URL(pathname, origin), { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Canvas-Service-Token': token }, body: JSON.stringify(body) })
    if (!response.ok || response.status >= 300) throw new Error(`Documentation review queue returned ${response.status}.`)
    return record(await response.json(), 'documentation review response')
  }
  const queue: HostedDocsPrepareQueuePort = {
    async claim() {
      const response = await call('/internal/repository-doc-reviews/claim-prepare', {})
      if (response.review === null) return null
      return prepareJob(response.review)
    },
    async complete(job, bundle) {
      const response = await call(`/internal/repository-doc-reviews/${job.reviewId}/complete-prepare`, { leaseId: job.leaseId, bundle })
      const review = record(response.review, 'completed documentation review')
      if (review.id !== job.reviewId || review.status !== 'prepared') throw new Error('Documentation review completion was not confirmed.')
    },
  }
  return Object.freeze(queue)
}

function prepareJob(input: unknown): HostedDocsPrepareJob & Readonly<{ reviewId: string }> {
  const value = record(input, 'documentation review job')
  const required = ['id', 'leaseId', 'leaseExpiresAt', 'projectId', 'fileId', 'fileRevision', 'fileDocumentSha256', 'scanJobId', 'installationId', 'repositoryId', 'repositoryGrantId', 'repositoryLinkedAt', 'baseRef', 'baseCommitSha', 'baseTreeSha', 'adapter', 'document', 'scan']
  if (Object.keys(value).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Documentation review queue returned an invalid job.')
  const baseCommitSha = text(value.baseCommitSha, 40, /^[a-f0-9]{40}$/)
  return Object.freeze({
    reviewId: uuid(value.id),
    leaseId: uuid(value.leaseId),
    leaseExpiresAt: integer(value.leaseExpiresAt),
    projectId: uuid(value.projectId),
    fileId: uuid(value.fileId),
    fileRevision: integer(value.fileRevision),
    fileDocumentSha256: text(value.fileDocumentSha256, 64, /^[a-f0-9]{64}$/),
    scanJobId: uuid(value.scanJobId),
    installationId: text(value.installationId, 32, /^[1-9][0-9]{0,31}$/),
    repositoryId: text(value.repositoryId, 32, /^[1-9][0-9]{0,31}$/),
    repositoryGrantId: uuid(value.repositoryGrantId),
    repositoryLinkedAt: integer(value.repositoryLinkedAt),
    baseRef: text(value.baseRef, 266, /^refs\/heads\//),
    baseCommitSha,
    baseTreeSha: text(value.baseTreeSha, 40, /^[a-f0-9]{40}$/),
    sourceRevision: baseCommitSha,
    adapter: record(value.adapter, 'documentation adapter'),
    document: record(value.document, 'file document'),
    scan: record(value.scan, 'repository scan'),
  })
}

function apiOrigin(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('API origin is invalid.')
  return url.origin
}
function serviceToken(value: string): string { if (new TextEncoder().encode(value).byteLength < 32 || /[\r\n]/.test(value)) throw new Error('Service token is invalid.'); return value }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`); return value as Record<string, unknown> }
function text(value: unknown, maximum: number, pattern: RegExp): string { if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !pattern.test(value)) throw new Error('Documentation review queue returned an invalid job.'); return value }
function uuid(value: unknown): string { return text(value, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Documentation review queue returned an invalid job.'); return value as number }
