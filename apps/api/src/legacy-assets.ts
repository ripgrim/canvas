import type { ControlPlaneStore, JsonValue } from '@canvas/database'
import { externalizeHostedFileDocument, repairHostedFileDocument, validateHostedFileDocument } from '@canvas/cloud-document'
import type { LegacyHostedAssetUploader } from '@canvas/cloud-document'

export type LegacyDocumentPreparationFailure = 'invalid-document' | 'service-unavailable'

export class LegacyDocumentPreparationError extends Error {
  readonly failure: LegacyDocumentPreparationFailure
  readonly phase: 'legacy_asset_externalization'
  readonly upstreamStatus: number | null
  readonly upstreamCode: string | null

  constructor(
    failure: LegacyDocumentPreparationFailure,
    cause?: unknown,
    upstream: Readonly<{ status: number; code: string | null }> | null = null,
  ) {
    super(failure === 'invalid-document' ? 'Legacy document migration is not supported.' : 'Legacy document migration is unavailable.', { cause })
    this.name = 'LegacyDocumentPreparationError'
    this.failure = failure
    this.phase = 'legacy_asset_externalization'
    this.upstreamStatus = upstream?.status ?? null
    this.upstreamCode = upstream?.code ?? null
  }
}

export interface LegacyDocumentExternalizer {
  prepare(fileId: string, requestId: string, credentials: LegacyAssetMigrationCredentials): Promise<void>
}

export type LegacyAssetMigrationCredentials = Readonly<{
  authorization: string | null
  cookie: string | null
}>

type CorrelatedLegacyAssetUploader = (input: Parameters<LegacyHostedAssetUploader>[0], requestId: string, credentials: LegacyAssetMigrationCredentials) => ReturnType<LegacyHostedAssetUploader>

type AssetUploadResponse = Readonly<{
  asset: Readonly<{
    id: string
    mime: string
    extension: string
    bytes: number
    width: number
    height: number
    sha256: string
  }>
}>

const responseByteLimit = 16_384
const sha256Pattern = /^[0-9a-f]{64}$/

export function createHostedLegacyAssetUploader(options: Readonly<{
  assetsOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}>): CorrelatedLegacyAssetUploader {
  const origin = trustedAssetsOrigin(options.assetsOrigin)
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) throw new Error('API_SERVICE_TOKEN must contain at least 32 bytes.')
  const request = options.fetch ?? globalThis.fetch
  return async ({ fileId, asset }, requestId, credentials) => {
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(requestId)) throw new Error('Request id is invalid.')
    const credential = forwardedCredential(credentials)
    let response
    try {
      const headers = new Headers({
        'Content-Type': asset.mime,
        'Content-Length': String(asset.bytes),
        'X-Canvas-Service-Token': options.serviceToken,
        'X-Canvas-Request-Id': requestId,
        'X-Canvas-Asset-Width': String(asset.width),
        'X-Canvas-Asset-Height': String(asset.height),
      })
      headers.set(credential.name, credential.value)
      response = await request(new URL(`/internal/file-assets/legacy/${encodeURIComponent(fileId)}/${encodeURIComponent(asset.id)}.${asset.extension}`, origin), {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers,
        body: Buffer.from(asset.data, 'base64'),
      })
    } catch (error) {
      throw new LegacyDocumentPreparationError('service-unavailable', error)
    }
    if (response.headers.get('X-Canvas-Request-Id') !== requestId) {
      throw new LegacyDocumentPreparationError('service-unavailable', undefined, { status: response.status, code: 'correlation_mismatch' })
    }
    const text = await readBoundedText(response, responseByteLimit)
    if (!response.ok) {
      const upstream = Object.freeze({ status: response.status, code: parseWorkerErrorCode(text) })
      const permanent = response.status === 400 || response.status === 409 || response.status === 415
      throw new LegacyDocumentPreparationError(permanent ? 'invalid-document' : 'service-unavailable', undefined, upstream)
    }
    const payload = parseUploadResponse(text)
    const stored = payload.asset
    if (stored.id !== asset.id || stored.mime !== asset.mime || stored.extension !== asset.extension
      || stored.bytes !== asset.bytes || stored.width !== asset.width || stored.height !== asset.height) {
      throw new LegacyDocumentPreparationError('service-unavailable')
    }
    return Object.freeze({
      id: asset.id,
      name: asset.name,
      mime: asset.mime,
      extension: asset.extension,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      sha256: stored.sha256,
    })
  }
}

function forwardedCredential(credentials: LegacyAssetMigrationCredentials): Readonly<{ name: 'Authorization' | 'Cookie'; value: string }> {
  const authorization = credentials.authorization
  const cookie = credentials.cookie
  if (authorization && authorization.length <= 16_384 && !/[\r\n]/.test(authorization)) return Object.freeze({ name: 'Authorization', value: authorization })
  if (cookie && cookie.length <= 16_384 && !/[\r\n]/.test(cookie)) return Object.freeze({ name: 'Cookie', value: cookie })
  throw new LegacyDocumentPreparationError('service-unavailable')
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > limit)) throw new LegacyDocumentPreparationError('service-unavailable')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw new LegacyDocumentPreparationError('service-unavailable')
      }
      chunks.push(value)
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
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (error) { throw new LegacyDocumentPreparationError('service-unavailable', error) }
}

export function createLegacyDocumentExternalizer(options: Readonly<{
  store: Pick<ControlPlaneStore, 'getFileDocumentForCapture' | 'externalizeLegacyFileDocument' | 'repairFileDocumentInvariant'>
  upload: CorrelatedLegacyAssetUploader
}>): LegacyDocumentExternalizer {
  return Object.freeze({
    async prepare(fileId: string, requestId: string, credentials: LegacyAssetMigrationCredentials) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let stored
        try { stored = await options.store.getFileDocumentForCapture(fileId) }
        catch (error) { throw new LegacyDocumentPreparationError('service-unavailable', error) }
        if (!stored) throw new LegacyDocumentPreparationError('invalid-document')
        if (!record(stored.document) || stored.document.fileId !== fileId) {
          throw new LegacyDocumentPreparationError('invalid-document')
        }
        let result
        try {
          result = await externalizeHostedFileDocument(stored.document, input => options.upload(input, requestId, credentials))
        } catch (error) {
          if (error instanceof LegacyDocumentPreparationError) throw error
          const repair = repairHostedFileDocument(stored.document)
          if (repair.status === 'repaired') {
            let saved
            try {
              saved = await options.store.repairFileDocumentInvariant(
                fileId,
                stored.revision,
                repair.source as Readonly<Record<string, JsonValue>>,
                repair.document as unknown as Readonly<Record<string, JsonValue>>,
              )
            } catch (repairError) {
              throw new LegacyDocumentPreparationError('service-unavailable', repairError)
            }
            if (saved.status === 'saved' || saved.status === 'unchanged') return
            if (saved.status === 'conflict') continue
            if (saved.status === 'collaboration-active') throw new LegacyDocumentPreparationError('service-unavailable')
          }
          throw new LegacyDocumentPreparationError('invalid-document', error)
        }
        if (result.status === 'current') return
        const target = result.document as unknown as Readonly<Record<string, JsonValue>>
        const source = result.source as Readonly<Record<string, JsonValue>>
        let saved
        try {
          saved = await options.store.externalizeLegacyFileDocument(fileId, stored.revision, source, target)
        } catch (error) {
          throw new LegacyDocumentPreparationError('service-unavailable', error)
        }
        if (saved.status === 'saved' || saved.status === 'unchanged') return
        if (saved.status === 'collaboration-authoritative') {
          let current
          try { current = await options.store.getFileDocumentForCapture(fileId) }
          catch (error) { throw new LegacyDocumentPreparationError('service-unavailable', error) }
          if (current && isPersistedCurrentDocument(current.document)) return
          throw new LegacyDocumentPreparationError('service-unavailable')
        }
        if (saved.status !== 'conflict') throw new LegacyDocumentPreparationError('invalid-document')
        let current
        try { current = await options.store.getFileDocumentForCapture(fileId) }
        catch (error) { throw new LegacyDocumentPreparationError('service-unavailable', error) }
        if (current && current.revision === stored.revision && equalJson(validateHostedFileDocument(current.document), result.document)) return
      }
      throw new LegacyDocumentPreparationError('service-unavailable')
    },
  })
}

function trustedAssetsOrigin(value: string): URL {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if ((!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol))) throw new Error('ASSETS_ORIGIN must use HTTPS outside loopback.')
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('ASSETS_ORIGIN must be an origin without credentials or a path.')
  return new URL(url.origin)
}

function parseUploadResponse(text: string): AssetUploadResponse {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { throw new LegacyDocumentPreparationError('service-unavailable', error) }
  if (!record(value) || !exactKeys(value, ['asset']) || !record(value.asset)
    || !exactKeys(value.asset, ['id', 'mime', 'extension', 'bytes', 'width', 'height', 'sha256'])) {
    throw new LegacyDocumentPreparationError('service-unavailable')
  }
  const asset = value.asset
  if (typeof asset.id !== 'string' || typeof asset.mime !== 'string' || typeof asset.extension !== 'string'
    || !Number.isSafeInteger(asset.bytes) || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height)
    || typeof asset.sha256 !== 'string' || !sha256Pattern.test(asset.sha256)) {
    throw new LegacyDocumentPreparationError('service-unavailable')
  }
  return value as AssetUploadResponse
}

function parseWorkerErrorCode(text: string): string | null {
  let value: unknown
  try { value = JSON.parse(text) }
  catch { return null }
  if (!record(value) || typeof value.error !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.error)) return null
  return value.error
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => key === rightEntries[index]![0] && equalJson(value, rightEntries[index]![1]))
}

function isPersistedCurrentDocument(value: unknown): boolean {
  if (!record(value)) return false
  try {
    return validateHostedFileDocument(value).schemaVersion === value.schemaVersion
  } catch {
    return false
  }
}
