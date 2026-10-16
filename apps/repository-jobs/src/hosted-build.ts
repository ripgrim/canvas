import type { ShadcnScanArtifact } from '@canvas/scanner/artifact'
import { hostedPreviewExpectationFromShadcnScanArtifact, parseShadcnScanArtifact } from '@canvas/scanner/artifact'
import { verifyShadcnPreviewRequestClosure } from '@canvas/scanner/preview-registry'
import { HostedPreviewArtifactReconciliationError, publishHostedPreviewArtifact } from '@canvas/preview-runtime/hosted-artifact'
import type {
  HostedPreviewArtifactManifest,
  HostedPreviewArtifactStorage,
} from '@canvas/preview-runtime/hosted-artifact'

export type HostedPreviewBuildRequest = Readonly<{
  artifactId: string
  stagingId: string
  fileId: string
  fileRevision: number
  repositoryRoot: string
  scan: ShadcnScanArtifact
}>

export type HostedPreviewSandboxInput = Readonly<{
  artifactId: string
  repositoryRoot: string
  sourceRevision: string
  registryFingerprint: string
  request: ShadcnScanArtifact['request']
}>

export type HostedPreviewSandboxOutput = Readonly<{
  manifest: HostedPreviewArtifactManifest
  files: ReadonlyMap<string, Uint8Array>
}>

export interface HostedPreviewSandboxPort {
  build(input: HostedPreviewSandboxInput): Promise<HostedPreviewSandboxOutput>
}

export type HostedPreviewRegistration = Readonly<{
  artifactId: string
  fileId: string
  fileRevision: number
  sourceRevision: string
  registryFingerprint: string
  entrypoint: string
}>

export interface HostedPreviewRegistrarPort {
  register(input: HostedPreviewRegistration): Promise<void>
}

export function createHttpHostedPreviewArtifactStorage(options: Readonly<{
  origin: string
  capability: string
  jobId: string
  leaseId: string
  artifactId: string
  stagingId: string
  fetch?: typeof globalThis.fetch
}>): HostedPreviewArtifactStorage {
  const origin = new URL(options.origin)
  if (origin.origin !== options.origin || origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol)
    || origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Hosted preview artifact origin is invalid.')
  for (const value of [options.jobId, options.leaseId, options.artifactId, options.stagingId]) if (!uuid.test(value)) throw new Error('Hosted preview artifact identity is invalid.')
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(options.capability) || options.capability.length > 4096) throw new Error('Hosted preview artifact capability is invalid.')
  const fetchRequest = options.fetch ?? globalThis.fetch
  const pathname = (action: string) => `/internal/hosted-preview-artifacts/${options.artifactId}/staging/${options.stagingId}/${action}`
  const headers = () => ({
    'X-Canvas-Hosted-Preview-Job-Id': options.jobId,
    'X-Canvas-Hosted-Preview-Lease-Id': options.leaseId,
    'X-Canvas-Hosted-Preview-Write-Capability': options.capability,
  })
  const request = async (action: string, init: RequestInit, expected: string): Promise<void> => {
    const response = await fetchRequest(new URL(pathname(action), origin), { credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(20_000), ...init })
    if (!response.ok || response.status >= 300 && response.status < 400) throw new HostedPreviewArtifactHttpError(response.status)
    const body = await readBoundedJson(response, 16 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body) !== JSON.stringify({ status: expected })) throw new Error('Hosted preview artifact transport response is invalid.')
  }
  const stageRequest = async (action: 'file' | 'commit', init: RequestInit, expected: 'uploaded' | 'staged'): Promise<void> => {
    try { await request(action, init, expected) }
    catch (error) {
      if (error instanceof HostedPreviewArtifactHttpError && !error.ambiguous) throw error
      throw new HostedPreviewArtifactReconciliationError([error], 'Hosted preview staging needs reconciliation.')
    }
  }
  const storage: HostedPreviewArtifactStorage = {
    async stage(input) {
      if (input.artifactId !== options.artifactId || input.stagingId !== options.stagingId) throw new Error('Hosted preview artifact identity is invalid.')
      for (const file of input.manifest.files) {
        const bytes = input.files.get(file.path)
        if (!bytes) throw new Error('Hosted preview artifact is invalid.')
        await stageRequest('file', {
          method: 'PUT',
          headers: { ...headers(), 'Content-Type': file.contentType, 'X-Canvas-Artifact-Bytes': String(bytes.byteLength), 'X-Canvas-Artifact-Path': file.path, 'X-Canvas-Artifact-Sha256': file.sha256 },
          body: exactArrayBuffer(bytes),
        }, 'uploaded')
      }
      const manifest = new TextEncoder().encode(JSON.stringify(input.manifest))
      await stageRequest('commit', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json', 'Content-Length': String(manifest.byteLength) }, body: exactArrayBuffer(manifest) }, 'staged')
    },
    async publish(receipt) {
      requireOwnedReceipt(receipt, options)
      await request('publish', { method: 'POST', headers: headers() }, 'published')
    },
    async status(receipt) {
      requireOwnedReceipt(receipt, options)
      const response = await fetchRequest(new URL(pathname('status'), origin), { method: 'GET', credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: headers() })
      if (!response.ok) throw new Error(`Hosted preview artifact transport returned ${response.status}.`)
      const body = await readBoundedJson(response, 16 * 1024)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Hosted preview artifact transport response is invalid.')
      const status = (body as { status?: unknown }).status
      if (status !== 'staged' && status !== 'published' && status !== 'missing') throw new Error('Hosted preview artifact transport response is invalid.')
      return status
    },
    async discard(receipt) {
      requireOwnedReceipt(receipt, options)
      await request('discard', { method: 'POST', headers: headers() }, 'discarded')
    },
  }
  return Object.freeze(storage)
}

class HostedPreviewArtifactHttpError extends Error {
  readonly ambiguous: boolean

  constructor(readonly status: number) {
    super(`Hosted preview artifact transport returned ${status}.`)
    this.name = 'HostedPreviewArtifactHttpError'
    this.ambiguous = status === 408 || status === 425 || status === 429 || status >= 500
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function requireOwnedReceipt(receipt: Readonly<{ artifactId: string; stagingId: string }>, options: Readonly<{ artifactId: string; stagingId: string }>): void {
  if (receipt.artifactId !== options.artifactId || receipt.stagingId !== options.stagingId) throw new Error('Hosted preview artifact identity is invalid.')
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maximumRegistrationResponseBytes = 32 * 1024

export function createHttpHostedPreviewRegistrar(options: Readonly<{
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}>): HostedPreviewRegistrarPort {
  const origin = new URL(options.apiOrigin)
  if (origin.origin !== options.apiOrigin || !['http:', 'https:'].includes(origin.protocol)
    || origin.username || origin.password || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Hosted preview registrar origin is invalid.')
  }
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) throw new Error('Hosted preview publisher token is invalid.')
  const fetchRequest = options.fetch ?? globalThis.fetch
  return Object.freeze({
    async register(input: HostedPreviewRegistration) {
      const response = await fetchRequest(new URL('/internal/hosted-previews/register', origin), {
        method: 'POST',
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json',
          'X-Canvas-Hosted-Preview-Publisher-Token': options.serviceToken,
        },
        body: JSON.stringify(input),
      })
      if (response.status >= 300 && response.status < 400 || !response.ok) throw new Error(`Hosted preview registration returned ${response.status}.`)
      const body = await readBoundedJson(response, maximumRegistrationResponseBytes)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'artifact') throw new Error('Hosted preview registration response is invalid.')
      const artifact = (body as { artifact?: unknown }).artifact
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
        || JSON.stringify(artifact) !== JSON.stringify(input)) throw new Error('Hosted preview registration response is invalid.')
    },
  })
}

export function createHostedPreviewBuildPublisher(options: Readonly<{
  sandbox: HostedPreviewSandboxPort
  storage: HostedPreviewArtifactStorage
  registrar: HostedPreviewRegistrarPort
  verifyClosure?: typeof verifyShadcnPreviewRequestClosure
}>) {
  return Object.freeze({
    async build(request: HostedPreviewBuildRequest): Promise<Readonly<{ artifactId: string; entrypoint: string }>> {
      if (!uuid.test(request.artifactId) || !uuid.test(request.stagingId) || !uuid.test(request.fileId)
        || !Number.isSafeInteger(request.fileRevision) || request.fileRevision < 0 || !request.repositoryRoot) {
        throw new Error('Hosted preview build request is invalid.')
      }
      const scan = parseShadcnScanArtifact(request.scan)
      await (options.verifyClosure ?? verifyShadcnPreviewRequestClosure)(request.repositoryRoot, scan.request)
      const expectation = hostedPreviewExpectationFromShadcnScanArtifact(scan)
      const output = await options.sandbox.build(Object.freeze({
        artifactId: request.artifactId,
        repositoryRoot: request.repositoryRoot,
        sourceRevision: expectation.sourceRevision,
        registryFingerprint: expectation.registryFingerprint,
        request: scan.request,
      }))
      const published = await publishHostedPreviewArtifact({
        artifactId: request.artifactId,
        stagingId: request.stagingId,
        manifest: output.manifest,
        expectation,
        files: output.files,
      }, options.storage)
      await options.registrar.register(Object.freeze({
        artifactId: request.artifactId,
        fileId: request.fileId,
        fileRevision: request.fileRevision,
        sourceRevision: published.manifest.sourceRevision,
        registryFingerprint: published.manifest.registryFingerprint,
        entrypoint: published.manifest.entrypoint,
      }))
      return Object.freeze({ artifactId: request.artifactId, entrypoint: published.manifest.entrypoint })
    },
  })
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new Error('Hosted preview registration response is invalid.')
  const declaredLength = response.headers.get('Content-Length')
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new Error('Hosted preview registration response is invalid.')
  }
  if (!response.body) throw new Error('Hosted preview registration response is invalid.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > maximumBytes) throw new Error('Hosted preview registration response is invalid.')
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('Hosted preview registration response is invalid.') }
}
