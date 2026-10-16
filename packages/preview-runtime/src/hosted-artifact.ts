import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const hostedPreviewArtifactVersion = 1 as const

export type HostedPreviewArtifactFile = Readonly<{
  path: string
  sha256: string
  bytes: number
  contentType: 'text/html; charset=utf-8' | 'text/javascript; charset=utf-8' | 'text/css; charset=utf-8' | 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp' | 'font/woff2'
}>

export type HostedPreviewArtifactBinding = Readonly<{
  componentId: string
  modulePath: string
  exportName: string
}>

export type HostedPreviewArtifactManifest = Readonly<{
  version: typeof hostedPreviewArtifactVersion
  sourceRevision: string
  registryFingerprint: string
  entrypoint: string
  files: readonly HostedPreviewArtifactFile[]
  components: readonly HostedPreviewArtifactBinding[]
}>

export type HostedPreviewArtifactExpectation = Readonly<{
  sourceRevision: string
  registryFingerprint: string
  components: readonly Readonly<{ componentId: string; exportName: string }>[]
}>

export type HostedPreviewArtifactStorage = Readonly<{
  /** Create-only, private, and retryable with the same persisted receipt. */
  stage(input: Readonly<{ artifactId: string; stagingId: string; manifest: HostedPreviewArtifactManifest; files: ReadonlyMap<string, Uint8Array> }>): Promise<void>
  /** One atomic, idempotent visibility swap. A lost acknowledgement is resolved through status. */
  publish(receipt: HostedPreviewArtifactStageReceipt): Promise<void>
  status(receipt: HostedPreviewArtifactStageReceipt): Promise<'staged' | 'published' | 'missing'>
  /** Idempotent and receipt-scoped. A published artifact is never removed. */
  discard(receipt: HostedPreviewArtifactStageReceipt): Promise<void>
}>

export type HostedPreviewArtifactStageReceipt = Readonly<{ artifactId: string; stagingId: string }>

export type PublishedHostedPreviewArtifact = Readonly<{
  artifactId: string
  manifest: HostedPreviewArtifactManifest
}>

export class HostedPreviewArtifactReconciliationError extends AggregateError {
  constructor(errors: Iterable<unknown>, message = 'Hosted preview operation needs reconciliation.') {
    super(errors, message)
    this.name = 'HostedPreviewArtifactReconciliationError'
  }
}

const contentTypes = new Set<HostedPreviewArtifactFile['contentType']>([
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'font/woff2',
])
const sha256Pattern = /^[a-f0-9]{64}$/
const sourceRevisionPattern = /^[a-f0-9]{40}$/
const exportNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/
const componentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/
const maximumFiles = 10_000
const maximumComponents = 5_000
const maximumFileBytes = 8 * 1024 * 1024
const maximumArtifactBytes = 64 * 1024 * 1024

export function parseHostedPreviewArtifactManifest(value: unknown): HostedPreviewArtifactManifest {
  const manifest = exact(value, ['version', 'sourceRevision', 'registryFingerprint', 'entrypoint', 'files', 'components'])
  if (manifest.version !== hostedPreviewArtifactVersion) invalid()
  const sourceRevision = text(manifest.sourceRevision, sourceRevisionPattern)
  const registryFingerprint = text(manifest.registryFingerprint, /^sha256:[a-f0-9]{64}$/)
  const entrypoint = artifactPath(manifest.entrypoint)
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > maximumFiles) invalid()
  if (!Array.isArray(manifest.components) || manifest.components.length === 0 || manifest.components.length > maximumComponents) invalid()

  let totalBytes = 0
  const paths = new Set<string>()
  const files = manifest.files.map(value => {
    const file = parseHostedPreviewArtifactFile(value)
    const path = file.path
    if (paths.has(path)) invalid()
    paths.add(path)
    totalBytes += file.bytes
    if (totalBytes > maximumArtifactBytes) invalid()
    return file
  })
  const entry = files.find(file => file.path === entrypoint)
  if (entry?.contentType !== 'text/html; charset=utf-8') invalid()

  const componentIds = new Set<string>()
  const components = manifest.components.map(value => {
    const binding = exact(value, ['componentId', 'modulePath', 'exportName'])
    const componentId = text(binding.componentId, componentIdPattern)
    if (componentIds.has(componentId)) invalid()
    componentIds.add(componentId)
    const modulePath = artifactPath(binding.modulePath)
    const module = files.find(file => file.path === modulePath)
    if (module?.contentType !== 'text/javascript; charset=utf-8') invalid()
    return Object.freeze({ componentId, modulePath, exportName: text(binding.exportName, exportNamePattern) })
  })

  return Object.freeze({ version: hostedPreviewArtifactVersion, sourceRevision, registryFingerprint, entrypoint, files: Object.freeze(files), components: Object.freeze(components) })
}

export function parseHostedPreviewArtifactFile(value: unknown): HostedPreviewArtifactFile {
  const file = exact(value, ['path', 'sha256', 'bytes', 'contentType'])
  const path = artifactPath(file.path)
  const sha256 = text(file.sha256, sha256Pattern)
  if (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > maximumFileBytes || !contentTypes.has(file.contentType as HostedPreviewArtifactFile['contentType'])) invalid()
  const contentType = file.contentType as HostedPreviewArtifactFile['contentType']
  if (!contentTypeMatchesPath(contentType, path)) invalid()
  return Object.freeze({ path, sha256, bytes: Number(file.bytes), contentType })
}

export function assertHostedPreviewArtifactAdmission(manifest: HostedPreviewArtifactManifest, expectation: HostedPreviewArtifactExpectation): void {
  if (!sourceRevisionPattern.test(expectation.sourceRevision) || !/^sha256:[a-f0-9]{64}$/.test(expectation.registryFingerprint)
    || manifest.sourceRevision !== expectation.sourceRevision || manifest.registryFingerprint !== expectation.registryFingerprint) invalid()
  const expected = expectation.components.map(component => `${text(component.componentId, componentIdPattern)}\u0000${text(component.exportName, exportNamePattern)}`).sort()
  const actual = manifest.components.map(component => `${component.componentId}\u0000${component.exportName}`).sort()
  if (new Set(expected).size !== expectation.components.length || JSON.stringify(actual) !== JSON.stringify(expected)) invalid()
}

export function hostedPreviewCatalogFingerprint(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))))}`
}

export function verifyHostedPreviewArtifactFiles(manifest: HostedPreviewArtifactManifest, bytesByPath: ReadonlyMap<string, Uint8Array>): void {
  if (bytesByPath.size !== manifest.files.length) invalid()
  for (const file of manifest.files) {
    const bytes = bytesByPath.get(file.path)
    if (!bytes || bytes.byteLength !== file.bytes || bytesToHex(sha256(bytes)) !== file.sha256) invalid()
  }
}

/** Verifies every trust input before staging, then exposes the staged artifact through one storage-owned visibility swap. */
export async function publishHostedPreviewArtifact(
  input: Readonly<{ artifactId: string; stagingId: string; manifest: unknown; expectation: HostedPreviewArtifactExpectation; files: ReadonlyMap<string, Uint8Array> }>,
  storage: HostedPreviewArtifactStorage,
): Promise<PublishedHostedPreviewArtifact> {
  const manifest = parseHostedPreviewArtifactManifest(input.manifest)
  assertHostedPreviewArtifactAdmission(manifest, input.expectation)
  const files = new Map([...input.files].map(([path, bytes]) => [path, new Uint8Array(bytes)] as const))
  verifyHostedPreviewArtifactFiles(manifest, files)
  const artifactId = input.artifactId
  const stagingId = input.stagingId
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(artifactId) || !uuid.test(stagingId)) invalid()
  const receipt = Object.freeze({ artifactId, stagingId })
  try {
    await storage.stage({ artifactId, stagingId, manifest, files })
  } catch (stagingError) {
    if (!(stagingError instanceof HostedPreviewArtifactReconciliationError)) throw stagingError
    try { await storage.stage({ artifactId, stagingId, manifest, files }) }
    catch (replayError) { throw new HostedPreviewArtifactReconciliationError([stagingError, replayError], 'Hosted preview staging needs reconciliation.') }
  }
  try {
    await storage.publish(receipt)
  } catch (publicationError) {
    let status: Awaited<ReturnType<HostedPreviewArtifactStorage['status']>>
    try { status = await storage.status(receipt) }
    catch (statusError) { throw new AggregateError([publicationError, statusError], 'Hosted preview publication needs reconciliation.') }
    if (status === 'published') return Object.freeze({ artifactId, manifest })
    try { await storage.discard(receipt) }
    catch (discardError) { throw new AggregateError([publicationError, discardError], 'Hosted preview publication and cleanup failed.') }
    throw publicationError
  }
  return Object.freeze({ artifactId, manifest })
}

function artifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.startsWith('/') || value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) invalid()
  return value
}

function contentTypeMatchesPath(contentType: HostedPreviewArtifactFile['contentType'], path: string): boolean {
  const suffixes: Record<HostedPreviewArtifactFile['contentType'], readonly string[]> = {
    'text/html; charset=utf-8': ['.html'],
    'text/javascript; charset=utf-8': ['.js', '.mjs'],
    'text/css; charset=utf-8': ['.css'],
    'image/svg+xml': ['.svg'],
    'image/png': ['.png'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/webp': ['.webp'],
    'font/woff2': ['.woff2'],
  }
  return suffixes[contentType].some(suffix => path.endsWith(suffix))
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid()
  return value
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).sort().join('\u0000') !== [...keys].sort().join('\u0000')) invalid()
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) invalid()
    return [key, descriptor.value]
  }))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const expectedKeys = [...value.keys()].map(String)
    const actualKeys = Object.keys(descriptors).filter(key => key !== 'length')
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) invalid()
    return `[${expectedKeys.map(key => {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) invalid()
      return canonicalJson(descriptor.value)
    }).join(',')}]`
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  if (Object.getOwnPropertySymbols(value).length) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors).sort()
  return `{${keys.map(key => {
    const descriptor = descriptors[key]!
    if (!('value' in descriptor) || descriptor.value === undefined) invalid()
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`
  }).join(',')}}`
}

function invalid(): never {
  throw new Error('Hosted preview artifact is invalid.')
}
