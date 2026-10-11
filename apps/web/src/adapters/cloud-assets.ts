import { validateImageAssetReference } from '@canvas/repo-engine/appearance'
import type { ImageAssetReference } from '@canvas/repo-engine/appearance'

const maximumAssetBytes = 25 * 1024 * 1024
const maximumJsonBytes = 16 * 1024
const defaultTimeoutMs = 15_000
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^[a-f0-9]{64}$/

export type CloudAssetOperation = Readonly<{
  signal?: AbortSignal
  isCurrent?: () => boolean
}>

export type CloudAssetTransportOptions = Readonly<{
  assetsOrigin: string
  fetch?: typeof fetch
  timeoutMs?: number
}>

export type CloudAssetUpload = Readonly<{
  fileId: string
  asset: ImageAssetReference
  bytes: Uint8Array
}>

export type CloudAssetErrorCode =
  | 'aborted'
  | 'discarded'
  | 'invalid_asset'
  | 'not_confirmed'
  | 'request_failed'
  | 'response_invalid'
  | 'verification_failed'

export class CloudAssetTransportError extends Error {
  readonly code: CloudAssetErrorCode
  readonly requestId: string

  constructor(code: CloudAssetErrorCode, message: string, requestId: string = crypto.randomUUID()) {
    const verifiedRequestId = safeRequestId(requestId) ?? crypto.randomUUID()
    super(`${message} Request ID: ${verifiedRequestId}.`)
    this.name = 'CloudAssetTransportError'
    this.code = code
    this.requestId = verifiedRequestId
  }
}

export type CloudAssetTransport = Readonly<{
  uploadImage(input: CloudAssetUpload, operation?: CloudAssetOperation): Promise<ImageAssetReference>
  downloadImage(fileId: string, asset: ImageAssetReference, operation?: CloudAssetOperation): Promise<Uint8Array>
}>

type CanonicalAsset = Omit<ImageAssetReference, 'name'>

type UploadIntent = Readonly<{
  method: 'PUT'
  path: '/file-assets/uploads'
  token: string
  headers: Readonly<{
    'Content-Length': string
    'Content-Type': string
    'X-Canvas-Upload-Token': string
  }>
  expiresAt: string
}>

function fixedOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Assets origin must be an HTTP or HTTPS origin') }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error('Assets origin must be an HTTP or HTTPS origin')
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Assets origin must use HTTPS outside loopback')
  }
  return url.origin
}

function safeRequestId(value: string | null | undefined): string | null {
  return value && requestIdPattern.test(value) ? value.toLowerCase() : null
}

function responseRequestId(response: Response): string | null {
  return safeRequestId(response.headers.get('X-Canvas-Request-Id'))
}

function fail(code: CloudAssetErrorCode, message: string, requestId?: string | null): never {
  throw new CloudAssetTransportError(code, message, requestId ?? undefined)
}

function ensureCurrent(operation: CloudAssetOperation | undefined): void {
  if (operation?.signal?.aborted) fail('aborted', 'The asset operation was canceled')
  if (operation?.isCurrent && !operation.isCurrent()) fail('discarded', 'The asset operation was superseded')
}

function requestSignal(operation: CloudAssetOperation | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return operation?.signal ? AbortSignal.any([operation.signal, timeout]) : timeout
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function parsePositiveIntegerHeader(response: Response, name: string): number {
  const raw = response.headers.get(name)
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) fail('response_invalid', 'The asset service returned invalid metadata', responseRequestId(response))
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) fail('response_invalid', 'The asset service returned invalid metadata', responseRequestId(response))
  return value
}

function canonicalFromJson(value: unknown, response: Response): CanonicalAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('response_invalid', 'The asset service returned an invalid upload record', responseRequestId(response))
  }
  const record = value as Record<string, unknown>
  if (!exactKeys(record, ['id', 'mime', 'extension', 'bytes', 'width', 'height', 'sha256']) ||
    typeof record.id !== 'string' || typeof record.mime !== 'string' || typeof record.extension !== 'string' ||
    !positiveInteger(record.bytes) || !positiveInteger(record.width) || !positiveInteger(record.height) ||
    typeof record.sha256 !== 'string' || !digestPattern.test(record.sha256)) {
    fail('response_invalid', 'The asset service returned an invalid upload record', responseRequestId(response))
  }
  return record as CanonicalAsset
}

function canonicalFromHeaders(response: Response): CanonicalAsset {
  const id = response.headers.get('X-Canvas-Asset-Id')
  const contentType = response.headers.get('Content-Type')
  const mime = response.headers.get('X-Canvas-Asset-Mime')
  const extension = response.headers.get('X-Canvas-Asset-Extension')
  const sha256 = response.headers.get('X-Canvas-Asset-Sha256')
  const bytes = parsePositiveIntegerHeader(response, 'X-Canvas-Asset-Bytes')
  const width = parsePositiveIntegerHeader(response, 'X-Canvas-Asset-Width')
  const height = parsePositiveIntegerHeader(response, 'X-Canvas-Asset-Height')
  if (!id || !mime || mime !== contentType || !extension || !sha256 || !digestPattern.test(sha256)) {
    fail('response_invalid', 'The asset service returned invalid metadata', responseRequestId(response))
  }
  return { id, mime, extension, sha256, bytes, width, height } as CanonicalAsset
}

function sameCanonical(left: CanonicalAsset, right: ImageAssetReference): boolean {
  return left.id === right.id && left.mime === right.mime && left.extension === right.extension &&
    left.bytes === right.bytes && left.width === right.width && left.height === right.height && left.sha256 === right.sha256
}

function assertCanonical(actual: CanonicalAsset, expected: ImageAssetReference, response: Response): void {
  if (!sameCanonical(actual, expected)) {
    fail('verification_failed', 'The stored asset does not match the selected image', responseRequestId(response))
  }
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer))
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function readBounded(response: Response, maximumBytes: number, operation?: CloudAssetOperation): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel('response limit exceeded')
    fail('response_invalid', 'The asset service returned an oversized response', responseRequestId(response))
  }
  if (!response.body) fail('response_invalid', 'The asset service returned an empty response', responseRequestId(response))
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    ensureCurrent(operation)
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximumBytes) {
      await reader.cancel('response limit exceeded')
      fail('response_invalid', 'The asset service returned an oversized response', responseRequestId(response))
    }
    chunks.push(value)
  }
  if (declared !== null && length !== Number(declared)) {
    fail('response_invalid', 'The asset service returned an invalid content length', responseRequestId(response))
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  ensureCurrent(operation)
  return bytes
}

async function readJson(response: Response, operation?: CloudAssetOperation): Promise<unknown> {
  const bytes = await readBounded(response, maximumJsonBytes, operation)
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch {
    fail('response_invalid', 'The asset service returned malformed JSON', responseRequestId(response))
  }
}

function parseIntent(value: unknown, response: Response, expected: ImageAssetReference): UploadIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('response_invalid', 'The asset service returned an invalid upload intent', responseRequestId(response))
  }
  const record = value as Record<string, unknown>
  const headers = record.headers
  if (!exactKeys(record, ['method', 'path', 'token', 'headers', 'expiresAt']) || record.method !== 'PUT' ||
    record.path !== '/file-assets/uploads' || typeof record.token !== 'string' || !record.token || record.token.length > 8192 ||
    /[\r\n]/.test(record.token) || typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt)) ||
    !headers || typeof headers !== 'object' || Array.isArray(headers)) {
    fail('response_invalid', 'The asset service returned an invalid upload intent', responseRequestId(response))
  }
  const headerRecord = headers as Record<string, unknown>
  if (!exactKeys(headerRecord, ['Content-Length', 'Content-Type', 'X-Canvas-Upload-Token']) ||
    headerRecord['Content-Length'] !== String(expected.bytes) || headerRecord['Content-Type'] !== expected.mime ||
    headerRecord['X-Canvas-Upload-Token'] !== record.token) {
    fail('response_invalid', 'The asset service returned an invalid upload intent', responseRequestId(response))
  }
  return record as UploadIntent
}

function assertExpectedResponse(response: Response, expectedUrl: URL): void {
  if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
    fail('request_failed', 'The asset service tried to redirect the request', responseRequestId(response))
  }
  if (response.url) {
    let actual: URL
    try { actual = new URL(response.url) } catch { fail('request_failed', 'The asset service returned an invalid response location', responseRequestId(response)) }
    if (actual.origin !== expectedUrl.origin || actual.pathname !== expectedUrl.pathname || actual.search !== expectedUrl.search) {
      fail('request_failed', 'The asset service returned a response from another location', responseRequestId(response))
    }
  }
}

function requestFailure(response: Response, message: string): never {
  fail('request_failed', `${message} (${response.status})`, responseRequestId(response))
}

function assetUrl(origin: string, fileId: string, asset: ImageAssetReference): URL {
  return new URL(`/file-assets/${encodeURIComponent(fileId)}/${encodeURIComponent(asset.id)}.${asset.extension}`, origin)
}

function validateInput(fileId: string, asset: ImageAssetReference, bytes?: Uint8Array): void {
  if (!identifierPattern.test(fileId)) fail('invalid_asset', 'The file identity is invalid')
  try { validateImageAssetReference(asset) } catch { fail('invalid_asset', 'The image metadata is invalid') }
  if (bytes && (bytes.byteLength !== asset.bytes || bytes.byteLength > maximumAssetBytes)) {
    fail('invalid_asset', 'The image bytes do not match the image metadata')
  }
}

function assetSnapshot(asset: ImageAssetReference): ImageAssetReference {
  return Object.freeze({ ...asset })
}

export function createCloudAssetTransport(options: CloudAssetTransportOptions): CloudAssetTransport {
  const origin = fixedOrigin(options.assetsOrigin)
  const fetchRequest = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error('Asset timeout must be between 1 and 120000 milliseconds')

  const request = async (url: URL, init: RequestInit, operation?: CloudAssetOperation): Promise<Response> => {
    ensureCurrent(operation)
    const response = await fetchRequest(url, {
      ...init,
      credentials: 'include',
      redirect: 'manual',
      signal: requestSignal(operation, timeoutMs),
    })
    try { ensureCurrent(operation) } catch (error) { await response.body?.cancel('operation superseded'); throw error }
    assertExpectedResponse(response, url)
    return response
  }

  const downloadImage = async (fileId: string, asset: ImageAssetReference, operation?: CloudAssetOperation): Promise<Uint8Array> => {
    validateInput(fileId, asset)
    const expected = assetSnapshot(asset)
    const url = assetUrl(origin, fileId, expected)
    let response: Response
    try { response = await request(url, { method: 'GET' }, operation) } catch (error) {
      if (error instanceof CloudAssetTransportError) throw error
      ensureCurrent(operation)
      fail('not_confirmed', 'The stored asset could not be confirmed')
    }
    if (response.status === 404) fail('not_confirmed', 'The stored asset is missing', responseRequestId(response))
    if (!response.ok) requestFailure(response, 'The stored asset could not be loaded')
    const canonical = canonicalFromHeaders(response)
    assertCanonical(canonical, expected, response)
    const contentLength = response.headers.get('Content-Length')
    if (contentLength !== String(expected.bytes)) {
      await response.body?.cancel('asset length mismatch')
      fail('verification_failed', 'The stored asset has the wrong length', responseRequestId(response))
    }
    const bytes = await readBounded(response, expected.bytes, operation)
    if (bytes.byteLength !== expected.bytes || await digestHex(bytes) !== expected.sha256) {
      fail('verification_failed', 'The stored asset contents do not match the selected image', responseRequestId(response))
    }
    ensureCurrent(operation)
    return bytes
  }

  const reconcile = async (input: CloudAssetUpload, operation: CloudAssetOperation | undefined, requestId: string | null): Promise<ImageAssetReference> => {
    try {
      await downloadImage(input.fileId, input.asset, operation)
      ensureCurrent(operation)
      return input.asset
    } catch (error) {
      if (error instanceof CloudAssetTransportError && (error.code === 'aborted' || error.code === 'discarded')) throw error
      fail('not_confirmed', 'The asset upload could not be confirmed. Retry the upload', requestId ?? (error instanceof CloudAssetTransportError ? error.requestId : null))
    }
  }

  const uploadImage = async (input: CloudAssetUpload, operation?: CloudAssetOperation): Promise<ImageAssetReference> => {
    validateInput(input.fileId, input.asset, input.bytes)
    const pending = Object.freeze({ fileId: input.fileId, asset: assetSnapshot(input.asset), bytes: input.bytes.slice() })
    if (await digestHex(pending.bytes) !== pending.asset.sha256) fail('invalid_asset', 'The image digest does not match the image bytes')
    ensureCurrent(operation)
    const intentUrl = new URL('/file-assets/upload-intents', origin)
    let intentResponse: Response
    try {
      intentResponse = await request(intentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: pending.fileId,
          assetId: pending.asset.id,
          extension: pending.asset.extension,
          contentType: pending.asset.mime,
          size: pending.asset.bytes,
        }),
      }, operation)
    } catch (error) {
      if (error instanceof CloudAssetTransportError) throw error
      ensureCurrent(operation)
      return reconcile(pending, operation, null)
    }
    if (intentResponse.status === 409 || intentResponse.status >= 500) {
      return reconcile(pending, operation, responseRequestId(intentResponse))
    }
    if (!intentResponse.ok) requestFailure(intentResponse, 'The asset upload could not start')
    const intent = parseIntent(await readJson(intentResponse, operation), intentResponse, pending.asset)
    const uploadUrl = new URL(intent.path, origin)
    let uploadResponse: Response
    try {
      uploadResponse = await request(uploadUrl, {
        method: intent.method,
        headers: intent.headers,
        body: pending.bytes.buffer as ArrayBuffer,
      }, operation)
    } catch (error) {
      if (error instanceof CloudAssetTransportError) throw error
      ensureCurrent(operation)
      return reconcile(input, operation, responseRequestId(intentResponse))
    }
    if (uploadResponse.status === 409 || uploadResponse.status >= 500) {
      return reconcile(pending, operation, responseRequestId(uploadResponse))
    }
    if (!uploadResponse.ok) requestFailure(uploadResponse, 'The asset upload failed')
    assertCanonical(canonicalFromJson(await readJson(uploadResponse, operation), uploadResponse), pending.asset, uploadResponse)
    await downloadImage(pending.fileId, pending.asset, operation)
    ensureCurrent(operation)
    return pending.asset
  }

  return Object.freeze({ uploadImage, downloadImage })
}
