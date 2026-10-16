import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { HostedPreviewArtifactReconciliationError } from '@canvas/preview-runtime/hosted-artifact'
import { scanShadcnPreviewRegistry } from '@canvas/scanner/preview-registry'
import { createHostedPreviewBuildQueueProcessor, createHttpHostedPreviewBuildQueue, type HostedPreviewBuildPublisher } from '../src/hosted-worker.js'

const jobId = '00000000-0000-4000-8000-000000000701'
const leaseId = '00000000-0000-4000-8000-000000000702'
const artifactId = '00000000-0000-4000-8000-000000000703'
const stagingId = '00000000-0000-4000-8000-000000000704'
const fileId = '00000000-0000-4000-8000-000000000705'
const accessToken = 'ghs_repository_read_token'
const artifactCapability = 'header.payload'
const sourceRevision = 'a'.repeat(40)
const sourceHash = 'b'.repeat(64)
const componentId = 'shadcn:Button:8f9171d59b1041d3'
const scan = Object.freeze({
  sourceRevision,
  scan: Object.freeze({ adapterId: 'shadcn-v1' as const, configs: [], components: [{ path: 'src/button.tsx', exportName: 'Button', packageName: '@acme/ui', declarationKind: 'function' as const, props: [], slots: [], sourceHash, fingerprint: 'c'.repeat(64) }], tokens: [], sourceHashes: { 'src/button.tsx': sourceHash }, diagnostics: [] }),
  request: Object.freeze({ version: 1 as const, entry: { componentId }, components: [{ componentId, entryPath: 'src/button.tsx', exportName: 'Button', integrity: `sha256-${Buffer.from(sourceHash, 'hex').toString('base64')}`, props: {}, slots: [] }], styles: [] }),
})
const job = Object.freeze({
  id: jobId,
  fileId,
  fileRevision: 4,
  artifactId,
  stagingId,
  repositoryId: '4001',
  accessToken,
  leaseId,
  attempts: 1,
  scan,
  artifactOrigin: 'https://assets.canvas.test',
  artifactCapability,
})

describe('hosted preview build worker', () => {
  it('COMP-V2-CODE-010 accepts the production scanner artifact with its dependency resolutions', async () => {
    const generated = await scanShadcnPreviewRegistry(resolve(import.meta.dirname, '../../../fixtures/stateful-shadcn-repo'))
    const actualScan = { sourceRevision, ...generated }
    const queue = createHttpHostedPreviewBuildQueue({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: 'build-service-token-0123456789abcdef',
      fetch: vi.fn(async () => Response.json({
        job: { id: jobId, fileId, fileRevision: 4, projectId: crypto.randomUUID(), scanJobId: crypto.randomUUID(), artifactId, stagingId, status: 'leased', attempts: 1 },
        lease: { id: leaseId, expiresAt: new Date(Date.now() + 300_000).toISOString() },
        repository: { repositoryId: '4001' },
        access: { token: accessToken, expiresAt: Date.now() + 300_000, contentsPermission: 'read' },
        scan: actualScan,
        artifactAccess: { origin: 'https://assets.canvas.test', token: artifactCapability, expiresAt: Math.floor(Date.now() / 1_000) + 300 },
      })),
    })

    await expect(queue.claim()).resolves.toMatchObject({ scan: { request: { dependencies: generated.request.dependencies, resolutions: generated.request.resolutions } } })
  })

  it('COMP-V2-CODE-012 parses one exact capability-bound claim and keeps credentials off completion', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (new URL(request.url).pathname.endsWith('/claim')) return Response.json({
        job: { id: jobId, fileId, fileRevision: 4, projectId: crypto.randomUUID(), scanJobId: crypto.randomUUID(), artifactId, stagingId, status: 'leased', attempts: 1 },
        lease: { id: leaseId, expiresAt: new Date(Date.now() + 300_000).toISOString() },
        repository: { repositoryId: '4001' },
        access: { token: accessToken, expiresAt: Date.now() + 300_000, contentsPermission: 'read' },
        scan,
        artifactAccess: { origin: 'https://assets.canvas.test', token: artifactCapability, expiresAt: Math.floor(Date.now() / 1_000) + 300 },
      })
      return Response.json({ status: 'completed' })
    })
    const queue = createHttpHostedPreviewBuildQueue({ apiOrigin: 'https://api.canvas.test', serviceToken: 'build-service-token-0123456789abcdef', fetch })

    await expect(queue.claim()).resolves.toEqual(job)
    await queue.complete(jobId, leaseId)

    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/internal/hosted-preview-builds/claim', `/internal/hosted-preview-builds/${jobId}/complete`])
    const completionBody = await requests[1]!.text()
    expect(completionBody).toBe(JSON.stringify({ leaseId }))
    expect(completionBody).not.toContain(accessToken)
    expect(requests[1]!.headers.get('authorization')).toBeNull()
    expect(requests[1]!.headers.get('cookie')).toBeNull()
  })

  it('COMP-V2-CODE-012 rejects swapped expiry units before source access', async () => {
    const claim = (githubExpiresAt: number, artifactExpiresAt: number) => createHttpHostedPreviewBuildQueue({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: 'build-service-token-0123456789abcdef',
      fetch: vi.fn(async () => Response.json({
        job: { id: jobId, fileId, fileRevision: 4, projectId: crypto.randomUUID(), scanJobId: crypto.randomUUID(), artifactId, stagingId, status: 'leased', attempts: 1 },
        lease: { id: leaseId, expiresAt: new Date(Date.now() + 300_000).toISOString() },
        repository: { repositoryId: '4001' },
        access: { token: accessToken, expiresAt: githubExpiresAt, contentsPermission: 'read' },
        scan,
        artifactAccess: { origin: 'https://assets.canvas.test', token: artifactCapability, expiresAt: artifactExpiresAt },
      })),
    }).claim()
    const now = Date.now()

    await expect(claim(Math.floor(now / 1_000) + 300, Math.floor(now / 1_000) + 300)).rejects.toThrow('invalid response')
    await expect(claim(now + 300_000, now + 300_000)).rejects.toThrow('invalid response')
  })

  it('COMP-V2-CODE-012 runs the real processor composition without forwarding credentials to the sandbox contract', async () => {
    const complete = vi.fn(async () => undefined)
    const dispose = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ root: 'C:/worker-owned/source', sourceRevision, dispose }))
    let receivedBuild: Parameters<HostedPreviewBuildPublisher['build']>[0] | undefined
    const build = vi.fn(async (input: Parameters<HostedPreviewBuildPublisher['build']>[0]) => { receivedBuild = input; return { artifactId, entrypoint: 'index.html' } })
    const publisher = vi.fn((_job: typeof job) => ({ build }))
    const processor = createHostedPreviewBuildQueueProcessor({
      queue: { claim: vi.fn(async () => job), complete, retry: vi.fn(), fail: vi.fn() },
      snapshot: { open },
      publisher,
    })

    await expect(processor.runOnce()).resolves.toBe('completed')

    expect(open).toHaveBeenCalledWith({ repositoryId: '4001', accessToken, sourceRevision })
    expect(publisher).toHaveBeenCalledWith(job)
    expect(build).toHaveBeenCalledWith({ artifactId, stagingId, fileId, fileRevision: 4, repositoryRoot: 'C:/worker-owned/source', scan })
    expect(JSON.stringify(receivedBuild)).not.toContain(accessToken)
    expect(JSON.stringify(receivedBuild)).not.toContain(artifactCapability)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(jobId, leaseId)
  })

  it('COMP-V2-CODE-011 retries transient build failures through the exact lease', async () => {
    const retry = vi.fn(async (_jobId: string, _leaseId: string, _nextAttemptAt: number) => undefined)
    const fail = vi.fn(async () => undefined)
    const dispose = vi.fn(async () => undefined)
    const processor = createHostedPreviewBuildQueueProcessor({
      queue: { claim: vi.fn(async () => job), complete: vi.fn(), retry, fail },
      snapshot: { open: vi.fn(async () => ({ root: 'C:/worker-owned/source', sourceRevision, dispose })) },
      publisher: () => ({ async build() { throw new TypeError('fetch failed') } }),
    })

    const before = Date.now()
    await expect(processor.runOnce()).rejects.toThrow('fetch failed')
    expect(retry).toHaveBeenCalledWith(jobId, leaseId, expect.any(Number))
    expect(retry.mock.calls[0]![2]).toBeGreaterThanOrEqual(before + 2_000)
    expect(fail).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('COMP-V2-CODE-012 retries unresolved artifact reconciliation with the exact lease', async () => {
    const retry = vi.fn(async (_jobId: string, _leaseId: string, _nextAttemptAt: number) => undefined)
    const fail = vi.fn(async () => undefined)
    const processor = createHostedPreviewBuildQueueProcessor({
      queue: { claim: vi.fn(async () => job), complete: vi.fn(), retry, fail },
      snapshot: { open: vi.fn(async () => ({ root: 'C:/worker-owned/source', sourceRevision, dispose: async () => undefined })) },
      publisher: () => ({ async build() { throw new HostedPreviewArtifactReconciliationError([new TypeError('file acknowledgement lost')]) } }),
    })

    await expect(processor.runOnce()).rejects.toThrow('reconciliation')
    expect(retry).toHaveBeenCalledWith(jobId, leaseId, expect.any(Number))
    expect(fail).not.toHaveBeenCalled()
  })
})
