import type {
  AssetAccess,
  AssetActor,
  AssetDescriptor,
  AssetObjectInfo,
  CanonicalImageAssetReference,
  ImageAssetExtension,
  CopyAssetRequest,
  ThumbnailObjectIdentity,
  ThumbnailUploadIntentRequest,
  UploadIntentRequest,
} from "./contracts.js"
import { FileAssetError } from "./contracts.js"
import {
  parseAssetPath,
  parseThumbnailPath,
} from "./keys.js"
import {
  MAX_ASSET_BYTES,
  MAX_THUMBNAIL_BYTES,
} from "./policy.js"
import {
  canonicalImageAssetFromInfo,
  type FileAssetService,
} from "./service.js"
import type { ThumbnailCommitResolver } from "./maintenance.js"
import type { HostedPreviewArtifactAssetStorage } from "./hosted-preview.js"
import { parseHostedPreviewArtifactFile, parseHostedPreviewArtifactManifest } from "@canvas/preview-runtime/hosted-artifact"
import { verifyHostedPreviewWriteCapability } from "@canvas/preview-runtime/hosted-write-capability"

export interface FileAccessAuthority {
  authorize(
    request: Request,
    fileId: string,
    access: AssetAccess,
    expectedRevision?: number,
    resource?: "thumbnail",
  ): Promise<FileAccessGrant | null>
}

export interface ThumbnailServiceAuthority {
  authorize(
    request: Request,
    fileId: string,
    expectedRevision: number,
  ): Promise<(AssetActor & Readonly<{ revision: number }>) | null>
}

export type FileAccessGrant = AssetActor & Readonly<{
  revision?: number
  thumbnail?: ThumbnailObjectIdentity | null
}>

export interface HostedFileAccessAuthorityOptions {
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}

export interface HostedThumbnailServiceAuthorityOptions {
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}

export interface HostedThumbnailCommitResolverOptions {
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}

export interface FileAssetsHandlerOptions {
  service: FileAssetService
  accessAuthority: FileAccessAuthority
  thumbnailServiceAuthority: ThumbnailServiceAuthority
  serviceToken: string
  hostedPreviewStorage?: HostedPreviewArtifactAssetStorage
  hostedPreviewWriteSecret?: string
  hostedPreviewAssetsOrigin?: string
  allowedOrigins?: ReadonlySet<string>
  reportError?: (report: FileAssetErrorReport) => void
}

export interface FileAssetErrorReport {
  requestId: string | null
  method: string
  pathname: string
  phase: "file_asset_request"
  code: string
  status: number
  error: unknown
}

const requestIdPattern = /^[A-Za-z0-9:._-]{1,128}$/

function correlationRequestId(request: Request): string | null {
  const value = request.headers.get("x-canvas-request-id")
  return value && requestIdPattern.test(value) ? value : null
}

function defaultFileAssetErrorReporter(report: FileAssetErrorReport): void {
  const error = report.error instanceof Error
    ? { name: report.error.name, message: report.error.message, stack: report.error.stack }
    : { name: "UnknownError", message: String(report.error) }
  console.error(JSON.stringify({
    level: "error",
    event: "file_asset_request_failed",
    requestId: report.requestId,
    method: report.method,
    pathname: report.pathname,
    phase: report.phase,
    code: report.code,
    status: report.status,
    error,
  }))
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  })
}

function errorResponse(error: unknown): Response {
  if (error instanceof FileAssetError) {
    return json({ error: error.code, message: error.message }, error.status)
  }
  return json({ error: "internal_error", message: "File operation failed" }, 500)
}

async function parseJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new FileAssetError("bad_request", "Expected JSON", 400)
  }
  try {
    if (!request.body) {
      throw new Error("missing body")
    }
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > 16 * 1024) {
        await reader.cancel("JSON limit exceeded")
        throw new Error("body too large")
      }
      chunks.push(value)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object")
    }
    return value as Record<string, unknown>
  } catch {
    throw new FileAssetError("bad_request", "JSON body is invalid", 400)
  }
}

function parseDescriptor(value: unknown): AssetDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FileAssetError("bad_request", "Asset is invalid", 400)
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).sort().join(",") !== "assetId,extension,fileId") {
    throw new FileAssetError("bad_request", "Asset is invalid", 400)
  }
  if (
    typeof candidate.fileId !== "string" ||
    typeof candidate.assetId !== "string" ||
    typeof candidate.extension !== "string"
  ) {
    throw new FileAssetError("bad_request", "Asset is invalid", 400)
  }
  return candidate as unknown as AssetDescriptor
}

function parseUploadIntentRequest(
  value: Record<string, unknown>,
): UploadIntentRequest {
  if (Object.keys(value).sort().join(",") !== "assetId,contentType,extension,fileId,size") {
    throw new FileAssetError("bad_request", "Upload intent is invalid", 400)
  }
  const descriptor = parseDescriptor({
    fileId: value.fileId,
    assetId: value.assetId,
    extension: value.extension,
  })
  if (typeof value.contentType !== "string" || typeof value.size !== "number") {
    throw new FileAssetError("bad_request", "Upload intent is invalid", 400)
  }
  return {
    ...descriptor,
    contentType: value.contentType,
    size: value.size,
  }
}

function parseThumbnailUploadIntentRequest(
  value: Record<string, unknown>,
): ThumbnailUploadIntentRequest {
  if (
    Object.keys(value).sort().join(",") !==
    "contentType,expectedRevision,fileId,size"
  ) {
    throw new FileAssetError("bad_request", "Thumbnail upload intent is invalid", 400)
  }
  if (
    typeof value.fileId !== "string" ||
    typeof value.expectedRevision !== "number" ||
    value.contentType !== "image/avif" ||
    typeof value.size !== "number"
  ) {
    throw new FileAssetError("bad_request", "Thumbnail upload intent is invalid", 400)
  }
  return {
    fileId: value.fileId,
    expectedRevision: value.expectedRevision,
    contentType: value.contentType,
    size: value.size,
  }
}

function contentLength(request: Request): number {
  const raw = request.headers.get("content-length")
  const value = raw === null ? Number.NaN : Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FileAssetError("bad_request", "Content-Length is required", 411)
  }
  return value
}

function positiveIntegerHeader(request: Request, name: string): number {
  const raw = request.headers.get(name)
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
    throw new FileAssetError("bad_request", `${name} is required`, 400)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new FileAssetError("bad_request", `${name} is invalid`, 400)
  }
  return value
}

function parseLegacyImagePath(pathname: string): AssetDescriptor & {
  extension: ImageAssetExtension
} | null {
  const match = /^\/internal\/file-assets\/legacy\/([^/]+)\/([^/.]+)\.([a-z0-9]+)$/.exec(pathname)
  if (!match) return null
  const [, fileId, assetId, extension] = match
  if (
    !fileId ||
    !assetId ||
    !extension ||
    !["avif", "gif", "jpeg", "jpg", "png", "webp"].includes(extension)
  ) return null
  try {
    return parseAssetPath(`/file-assets/${fileId}/${assetId}.${extension}`) as
      | (AssetDescriptor & { extension: ImageAssetExtension })
      | null
  } catch {
    return null
  }
}

function parseHostedPreviewPath(pathname: string): Readonly<{ artifactId: string; path: string }> | null {
  const match = /^\/internal\/hosted-previews\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/files\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/i.exec(pathname)
  if (!match?.[1] || !match[2] || match[2].endsWith("/") || match[2].split("/").some(part => !part || part === "." || part === "..")) return null
  return Object.freeze({ artifactId: match[1], path: match[2] })
}

async function tokenDigest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ))
}

async function serviceTokenMatches(
  supplied: string | null,
  expectedDigest: Promise<Uint8Array>,
): Promise<boolean> {
  const [actual, expected] = await Promise.all([
    tokenDigest(supplied ?? ""),
    expectedDigest,
  ])
  let different = 0
  for (let index = 0; index < expected.byteLength; index += 1) {
    different |= actual[index]! ^ expected[index]!
  }
  return different === 0 && supplied !== null
}

async function readBoundedBody(
  request: Request,
  declaredLength: number,
  maximumLength: number,
): Promise<Uint8Array> {
  if (declaredLength > maximumLength) {
    throw new FileAssetError("payload_too_large", "Upload is too large", 413)
  }
  if (!request.body) {
    throw new FileAssetError("bad_request", "Upload body is required", 400)
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > declaredLength || total > maximumLength) {
      await reader.cancel("upload limit exceeded")
      throw new FileAssetError("payload_too_large", "Upload is too large", 413)
    }
    chunks.push(value)
  }
  if (total !== declaredLength) {
    throw new FileAssetError("bad_request", "Upload length is invalid", 400)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function responseHeaders(
  info: AssetObjectInfo,
  cacheControl: string,
  asset?: CanonicalImageAssetReference | null,
): Headers {
  const headers = new Headers({
    "Cache-Control": cacheControl,
    "Content-Length": String(info.size),
    "Content-Type": info.contentType,
    "X-Content-Type-Options": "nosniff",
  })
  if (info.etag) {
    headers.set("ETag", info.etag.startsWith("\"") ? info.etag : `"${info.etag}"`)
  }
  if (info.lastModified) {
    headers.set("Last-Modified", info.lastModified.toUTCString())
  }
  if (asset) {
    headers.set("X-Canvas-Asset-Bytes", String(asset.bytes))
    headers.set("X-Canvas-Asset-Extension", asset.extension)
    headers.set("X-Canvas-Asset-Height", String(asset.height))
    headers.set("X-Canvas-Asset-Id", asset.id)
    headers.set("X-Canvas-Asset-Mime", asset.mime)
    headers.set("X-Canvas-Asset-Sha256", asset.sha256)
    headers.set("X-Canvas-Asset-Width", String(asset.width))
  }
  return headers
}

function applyCors(
  response: Response,
  request: Request,
  allowedOrigins: ReadonlySet<string> | undefined,
): Response {
  const origin = request.headers.get("origin")
  if (!origin || !allowedOrigins?.has(origin)) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Credentials", "true")
  headers.set("Access-Control-Allow-Origin", origin)
  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Type, ETag, Last-Modified, X-Canvas-Asset-Bytes, X-Canvas-Asset-Extension, X-Canvas-Asset-Height, X-Canvas-Asset-Id, X-Canvas-Asset-Mime, X-Canvas-Asset-Sha256, X-Canvas-Asset-Width, X-Canvas-Request-Id",
  )
  headers.append("Vary", "Origin")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function requireMutationOrigin(
  request: Request,
  allowedOrigins: ReadonlySet<string> | undefined,
): void {
  const origin = request.headers.get("origin")
  if (origin) {
    if (!allowedOrigins?.has(origin)) {
      throw new FileAssetError("forbidden", "Origin is not allowed", 403)
    }
    return
  }
  const bearer = request.headers.get("authorization")?.startsWith("Bearer ") ?? false
  if (!bearer) {
    throw new FileAssetError("forbidden", "Origin is not allowed", 403)
  }
}

async function requireAccess(
  authority: FileAccessAuthority,
  request: Request,
  fileId: string,
  access: AssetAccess,
  expectedRevision?: number,
  resource?: "thumbnail",
): Promise<AssetActor> {
  const actor = await authority.authorize(
    request,
    fileId,
    access,
    expectedRevision,
    resource,
  )
  if (!actor) {
    throw new FileAssetError("unauthorized", "Sign in first", 401)
  }
  if (expectedRevision !== undefined && actor.revision !== expectedRevision) {
    throw new FileAssetError("conflict", "File changed before upload", 409)
  }
  return actor
}

async function requireThumbnailRead(
  authority: FileAccessAuthority,
  request: Request,
  fileId: string,
): Promise<ThumbnailObjectIdentity> {
  const grant = await authority.authorize(
    request,
    fileId,
    "read",
    undefined,
    "thumbnail",
  )
  if (!grant) {
    throw new FileAssetError("unauthorized", "Sign in first", 401)
  }
  if (!grant.thumbnail) {
    throw new FileAssetError("not_found", "Thumbnail not found", 404)
  }
  if (
    grant.revision !== grant.thumbnail.revision ||
    grant.thumbnail.fileId !== fileId
  ) {
    throw new FileAssetError("not_found", "Thumbnail not found", 404)
  }
  return grant.thumbnail
}

async function requireThumbnailService(
  authority: ThumbnailServiceAuthority,
  request: Request,
  fileId: string,
  expectedRevision: number,
): Promise<AssetActor> {
  const actor = await authority.authorize(request, fileId, expectedRevision)
  if (!actor) {
    throw new FileAssetError("unauthorized", "Thumbnail service authorization is required", 401)
  }
  if (actor.revision !== expectedRevision) {
    throw new FileAssetError("conflict", "File changed before upload", 409)
  }
  return actor
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase()
  return value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(value)
}

function trustedServiceUrl(path: string, origin: string): URL {
  const url = new URL(path, origin)
  if (url.username || url.password) {
    throw new Error("API_ORIGIN must not include credentials")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("API_ORIGIN must use HTTPS outside loopback")
  }
  return url
}

const MAX_AUTHORITY_RESPONSE_BYTES = 16 * 1024

async function readBoundedAuthorityJson(response: Response): Promise<unknown | null> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    const declaredLength = Number(contentLength)
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_AUTHORITY_RESPONSE_BYTES
    ) {
      await response.body?.cancel()
      return null
    }
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > MAX_AUTHORITY_RESPONSE_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
  } catch {
    return null
  }
  const source = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    source.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(source)) as unknown
  } catch {
    return null
  }
}

export function createHostedFileAccessAuthority(
  options: HostedFileAccessAuthorityOptions,
): FileAccessAuthority {
  const fetchRequest = options.fetch ?? globalThis.fetch
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) {
    throw new Error("API_SERVICE_TOKEN must contain at least 32 bytes")
  }
  const endpointUrl = trustedServiceUrl("/internal/file-access", options.apiOrigin)
  const endpoint = endpointUrl.toString()
  return {
    async authorize(request, fileId, access, expectedRevision, resource) {
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Canvas-Service-Token": options.serviceToken,
      })
      const authorization = request.headers.get("authorization")
      const cookie = request.headers.get("cookie")
      const requestId = correlationRequestId(request)
      if (authorization) {
        headers.set("Authorization", authorization)
      } else if (cookie) {
        headers.set("Cookie", cookie)
      }
      if (requestId) {
        headers.set("X-Canvas-Request-Id", requestId)
      }
      const response = await fetchRequest(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fileId,
          access,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(resource === undefined ? {} : { resource }),
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: "manual",
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error("File access service redirects are not allowed")
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return null
      }
      if (response.status === 409) {
        throw new FileAssetError("conflict", "File changed before upload", 409)
      }
      if (!response.ok) {
        throw new Error(`File access service returned ${response.status}`)
      }
      const result = await readBoundedAuthorityJson(response)
      const expectedKeys = resource === "thumbnail" && expectedRevision === undefined
        ? "revision,thumbnailEtag,thumbnailKey,userId"
        : expectedRevision === undefined
          ? "userId"
          : "revision,userId"
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(",") !== expectedKeys
      ) {
        return null
      }
      const userId = (result as Record<string, unknown>).userId
      if (typeof userId !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(userId)) {
        return null
      }
      if (expectedRevision === undefined) {
        if (resource !== "thumbnail") return { userId }
        const record = result as Record<string, unknown>
        const revision = record.revision
        const thumbnailKey = record.thumbnailKey
        const thumbnailEtag = record.thumbnailEtag
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) return null
        if (thumbnailKey === null && thumbnailEtag === null) {
          return { userId, revision: revision as number, thumbnail: null }
        }
        if (
          typeof thumbnailKey !== "string" ||
          typeof thumbnailEtag !== "string" ||
          !thumbnailEtag ||
          thumbnailEtag.length > 256
        ) return null
        return {
          userId,
          revision: revision as number,
          thumbnail: {
            fileId,
            revision: revision as number,
            key: thumbnailKey,
            etag: thumbnailEtag,
          },
        }
      }
      const revision = (result as Record<string, unknown>).revision
      return revision === expectedRevision ? { userId, revision } : null
    },
  }
}

export function createHostedThumbnailServiceAuthority(
  options: HostedThumbnailServiceAuthorityOptions,
): ThumbnailServiceAuthority {
  const fetchRequest = options.fetch ?? globalThis.fetch
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) {
    throw new Error("API_SERVICE_TOKEN must contain at least 32 bytes")
  }
  const endpoint = trustedServiceUrl(
    "/internal/thumbnail-upload-access",
    options.apiOrigin,
  ).toString()
  return {
    async authorize(request, fileId, expectedRevision) {
      const thumbnailToken = request.headers.get("x-canvas-thumbnail-service-token")
      if (!thumbnailToken || new TextEncoder().encode(thumbnailToken).byteLength < 32) {
        return null
      }
      const response = await fetchRequest(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Service-Token": options.serviceToken,
          "X-Canvas-Thumbnail-Service-Token": thumbnailToken,
        },
        body: JSON.stringify({ fileId, expectedRevision }),
        signal: AbortSignal.timeout(5_000),
        redirect: "manual",
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Thumbnail authorization service redirects are not allowed")
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return null
      }
      if (response.status === 409) {
        throw new FileAssetError("conflict", "File changed before upload", 409)
      }
      if (!response.ok) {
        throw new Error(`Thumbnail authorization service returned ${response.status}`)
      }
      const result = await readBoundedAuthorityJson(response)
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(",") !== "revision,serviceId"
      ) return null
      const record = result as Record<string, unknown>
      if (
        typeof record.serviceId !== "string" ||
        !/^[A-Za-z0-9:._-]{1,128}$/.test(record.serviceId) ||
        record.revision !== expectedRevision
      ) return null
      return { userId: record.serviceId, revision: expectedRevision }
    },
  }
}

export function createHostedThumbnailCommitResolver(
  options: HostedThumbnailCommitResolverOptions,
): ThumbnailCommitResolver {
  const fetchRequest = options.fetch ?? globalThis.fetch
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) {
    throw new Error("API_SERVICE_TOKEN must contain at least 32 bytes")
  }
  const endpoint = trustedServiceUrl(
    "/internal/thumbnail-commit",
    options.apiOrigin,
  ).toString()
  return {
    async resolve(fileId) {
      const response = await fetchRequest(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Service-Token": options.serviceToken,
        },
        body: JSON.stringify({ fileId }),
        signal: AbortSignal.timeout(5_000),
        redirect: "manual",
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Thumbnail commit service redirects are not allowed")
      }
      if (response.status === 404) return null
      if (!response.ok) {
        throw new Error(`Thumbnail commit service returned ${response.status}`)
      }
      const result = await readBoundedAuthorityJson(response)
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(",") !== "revision,thumbnailEtag,thumbnailKey"
      ) throw new Error("Thumbnail commit service response is invalid")
      const record = result as Record<string, unknown>
      if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
        throw new Error("Thumbnail commit service response is invalid")
      }
      if (record.thumbnailKey === null && record.thumbnailEtag === null) return null
      if (
        typeof record.thumbnailKey !== "string" ||
        typeof record.thumbnailEtag !== "string" ||
        !record.thumbnailEtag ||
        record.thumbnailEtag.length > 256
      ) throw new Error("Thumbnail commit service response is invalid")
      return {
        fileId,
        revision: record.revision as number,
        key: record.thumbnailKey,
        etag: record.thumbnailEtag,
      }
    },
  }
}

export function createFileAssetsHandler(
  options: FileAssetsHandlerOptions,
): (request: Request) => Promise<Response> {
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) {
    throw new Error("API_SERVICE_TOKEN must contain at least 32 bytes")
  }
  const expectedServiceTokenDigest = tokenDigest(options.serviceToken)
  const reportError = options.reportError ?? defaultFileAssetErrorReporter
  return async (request) => {
    const url = new URL(request.url)
    const { pathname } = url
    const internalRequest = pathname.startsWith("/internal/")
    const requestId = correlationRequestId(request) ?? (
      internalRequest ? null : globalThis.crypto.randomUUID()
    )
    const response = await (async () => {
      try {
      const hostedPreviewWrite = parseHostedPreviewWritePath(pathname)
      if (hostedPreviewWrite && options.hostedPreviewStorage && options.hostedPreviewWriteSecret && options.hostedPreviewAssetsOrigin) {
        if (url.search || request.headers.has("origin")) throw new FileAssetError("forbidden", "Hosted preview write is not allowed", 403)
        const jobId = request.headers.get("x-canvas-hosted-preview-job-id") ?? ""
        const leaseId = request.headers.get("x-canvas-hosted-preview-lease-id") ?? ""
        try {
          await verifyHostedPreviewWriteCapability({
            token: request.headers.get("x-canvas-hosted-preview-write-capability") ?? "",
            jobId,
            leaseId,
            artifactId: hostedPreviewWrite.artifactId,
            stagingId: hostedPreviewWrite.stagingId,
            audience: options.hostedPreviewAssetsOrigin,
            secret: options.hostedPreviewWriteSecret,
          })
        } catch {
          throw new FileAssetError("forbidden", "Hosted preview write is not allowed", 403)
        }
        const receipt = { artifactId: hostedPreviewWrite.artifactId, stagingId: hostedPreviewWrite.stagingId }
        if (hostedPreviewWrite.action === "file") {
          if (request.method !== "PUT") return json({ error: "method_not_allowed", message: "Method not allowed" }, 405, { Allow: "PUT" })
          const length = nonnegativeIntegerHeader(request, "x-canvas-artifact-bytes")
          const file = parseHostedPreviewArtifactFile({
            path: request.headers.get("x-canvas-artifact-path"),
            sha256: request.headers.get("x-canvas-artifact-sha256"),
            bytes: length,
            contentType: request.headers.get("content-type"),
          })
          const bytes = length === 0 ? new Uint8Array() : await readBoundedBody(request, length, 8 * 1024 * 1024)
          await options.hostedPreviewStorage.uploadStagedFile({ ...receipt, file, bytes })
          return json({ status: "uploaded" }, 201)
        }
        if (hostedPreviewWrite.action === "commit") {
          if (request.method !== "POST") return json({ error: "method_not_allowed", message: "Method not allowed" }, 405, { Allow: "POST" })
          const length = contentLength(request)
          const bytes = await readBoundedBody(request, length, 4 * 1024 * 1024)
          let value: unknown
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
          catch { throw new FileAssetError("bad_request", "Hosted preview manifest is invalid", 400) }
          await options.hostedPreviewStorage.commitStagedArtifact({ ...receipt, manifest: parseHostedPreviewArtifactManifest(value) })
          return json({ status: "staged" }, 201)
        }
        if (hostedPreviewWrite.action === "status") {
          if (request.method !== "GET") return json({ error: "method_not_allowed", message: "Method not allowed" }, 405, { Allow: "GET" })
          return json({ status: await options.hostedPreviewStorage.status(receipt) }, 200)
        }
        if (request.method !== "POST") return json({ error: "method_not_allowed", message: "Method not allowed" }, 405, { Allow: "POST" })
        if (hostedPreviewWrite.action === "publish") await options.hostedPreviewStorage.publish(receipt)
        else await options.hostedPreviewStorage.discard(receipt)
        return json({ status: hostedPreviewWrite.action === "publish" ? "published" : "discarded" }, 200)
      }

      const hostedPreview = parseHostedPreviewPath(pathname)
      if (hostedPreview && options.hostedPreviewStorage) {
        if (url.search) throw new FileAssetError("not_found", "Hosted preview file not found", 404)
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json(
            { error: "method_not_allowed", message: "Method not allowed" },
            405,
            { Allow: "GET, HEAD" },
          )
        }
        if (request.headers.has("origin")) {
          throw new FileAssetError("forbidden", "Browser requests are not allowed", 403)
        }
        if (!await serviceTokenMatches(
          request.headers.get("x-canvas-service-token"),
          expectedServiceTokenDigest,
        )) {
          throw new FileAssetError("unauthorized", "Service authorization is required", 401)
        }
        const published = await options.hostedPreviewStorage.readPublishedFile(hostedPreview.artifactId, hostedPreview.path)
        if (!published) throw new FileAssetError("not_found", "Hosted preview file not found", 404)
        return new Response(request.method === "HEAD" ? null : published.download.body, {
          status: 200,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Length": String(published.file.bytes),
            "Content-Type": published.file.contentType,
            "Cross-Origin-Resource-Policy": "same-origin",
            ETag: `"${published.file.sha256}"`,
            "X-Canvas-Artifact-Id": hostedPreview.artifactId,
            "X-Canvas-Artifact-Sha256": published.file.sha256,
            "X-Content-Type-Options": "nosniff",
          },
        })
      }

      const legacyImage = parseLegacyImagePath(pathname)
      if (legacyImage) {
        if (request.method !== "PUT") {
          return json(
            { error: "method_not_allowed", message: "Method not allowed" },
            405,
            { Allow: "PUT" },
          )
        }
        if (request.headers.has("origin")) {
          throw new FileAssetError("forbidden", "Browser requests are not allowed", 403)
        }
        if (!await serviceTokenMatches(
          request.headers.get("x-canvas-service-token"),
          expectedServiceTokenDigest,
        )) {
          throw new FileAssetError("unauthorized", "Service authorization is required", 401)
        }
        await requireAccess(
          options.accessAuthority,
          request,
          legacyImage.fileId,
          "write",
        )
        const length = contentLength(request)
        const width = positiveIntegerHeader(request, "X-Canvas-Asset-Width")
        const height = positiveIntegerHeader(request, "X-Canvas-Asset-Height")
        const body = await readBoundedBody(request, length, MAX_ASSET_BYTES)
        const asset = await options.service.externalizeLegacyImage({
          ...legacyImage,
          body,
          contentType: request.headers.get("content-type") ?? "",
          contentLength: length,
          width,
          height,
        })
        return json({ asset })
      }

      if (request.method === "OPTIONS") {
        const origin = request.headers.get("origin")
        if (!origin || !options.allowedOrigins?.has(origin)) {
          throw new FileAssetError("forbidden", "Origin is not allowed", 403)
        }
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "Authorization, Content-Length, Content-Type, X-Canvas-Request-Id, X-Canvas-Thumbnail-Service-Token, X-Canvas-Upload-Token",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Max-Age": "3600",
            Vary: "Origin",
          },
        })
      }

      if (internalRequest) {
        return json({ error: "not_found", message: "Not found" }, 404)
      }

      if (pathname === "/file-assets/upload-intents" && request.method === "POST") {
        requireMutationOrigin(request, options.allowedOrigins)
        const input = parseUploadIntentRequest(await parseJson(request))
        const actor = await requireAccess(
          options.accessAuthority,
          request,
          input.fileId,
          "write",
        )
        return json(await options.service.createUploadIntent(actor, input), 201)
      }

      if (pathname === "/file-assets/uploads" && request.method === "PUT") {
        requireMutationOrigin(request, options.allowedOrigins)
        const token = request.headers.get("x-canvas-upload-token")
        if (!token) {
          throw new FileAssetError("unauthorized", "Upload intent is required", 401)
        }
        const claims = await options.service.verifyUploadIntent(token)
        const actor = await requireAccess(
          options.accessAuthority,
          request,
          claims.fileId,
          "write",
        )
        const reservation = await options.service.reserveUploadAttempt(actor, claims)
        const length = contentLength(request)
        const body = await readBoundedBody(request, length, MAX_ASSET_BYTES)
        const stored = await options.service.upload(
          reservation,
          body,
          request.headers.get("content-type") ?? "",
          length,
        )
        return json(stored, 201)
      }

      if (
        pathname === "/file-assets/thumbnail-upload-intents" &&
        request.method === "POST"
      ) {
        const input = parseThumbnailUploadIntentRequest(await parseJson(request))
        const actor = await requireThumbnailService(
          options.thumbnailServiceAuthority,
          request,
          input.fileId,
          input.expectedRevision,
        )
        return json(await options.service.createThumbnailUploadIntent(actor, input), 201)
      }

      if (pathname === "/file-assets/thumbnail-uploads" && request.method === "PUT") {
        const token = request.headers.get("x-canvas-upload-token")
        if (!token) {
          throw new FileAssetError("unauthorized", "Upload intent is required", 401)
        }
        const claims = await options.service.verifyThumbnailUploadIntent(token)
        const actor = await requireThumbnailService(
          options.thumbnailServiceAuthority,
          request,
          claims.fileId,
          claims.expectedRevision,
        )
        const reservation = await options.service.reserveThumbnailUploadAttempt(actor, claims)
        const length = contentLength(request)
        const body = await readBoundedBody(request, length, MAX_THUMBNAIL_BYTES)
        const stored = await options.service.uploadThumbnail(
          reservation,
          body,
          request.headers.get("content-type") ?? "",
          length,
        )
        return json(stored, 201)
      }

      if (pathname === "/file-assets/copies" && request.method === "POST") {
        requireMutationOrigin(request, options.allowedOrigins)
        const input = await parseJson(request)
        if (Object.keys(input).sort().join(",") !== "source,target") {
          throw new FileAssetError("bad_request", "Copy request is invalid", 400)
        }
        const copyRequest: CopyAssetRequest = {
          source: parseDescriptor(input.source),
          target: parseDescriptor(input.target),
        }
        const [sourceActor, targetActor] = await Promise.all([
          requireAccess(
            options.accessAuthority,
            request,
            copyRequest.source.fileId,
            "read",
          ),
          requireAccess(
            options.accessAuthority,
            request,
            copyRequest.target.fileId,
            "write",
          ),
        ])
        if (sourceActor.userId !== targetActor.userId) {
          throw new FileAssetError("forbidden", "File access does not match", 403)
        }
        await options.service.copy(targetActor, copyRequest)
        return new Response(null, { status: 204 })
      }

      const thumbnailFileId = parseThumbnailPath(pathname)
      if (thumbnailFileId && request.method === "PUT") {
        return json({
          error: "bad_request",
          message: "Create a thumbnail upload intent first",
        }, 400)
      }
      if (thumbnailFileId && (request.method === "GET" || request.method === "HEAD")) {
        const identity = await requireThumbnailRead(
          options.accessAuthority,
          request,
          thumbnailFileId,
        )
        const stored = request.method === "HEAD"
          ? { info: await options.service.headThumbnail(identity), body: null }
          : await options.service.downloadThumbnail(identity)
        return new Response(request.method === "HEAD" ? null : stored.body, {
          status: 200,
          headers: responseHeaders(stored.info, "private, no-cache"),
        })
      }

      const descriptor = parseAssetPath(pathname)
      if (descriptor && (request.method === "GET" || request.method === "HEAD")) {
        await requireAccess(
          options.accessAuthority,
          request,
          descriptor.fileId,
          "read",
        )
        const stored = request.method === "HEAD"
          ? { info: await options.service.head(descriptor), body: null }
          : await options.service.download(descriptor)
        return new Response(request.method === "HEAD" ? null : stored.body, {
          status: 200,
          headers: responseHeaders(
            stored.info,
            "private, max-age=31536000, immutable",
            canonicalImageAssetFromInfo(descriptor, stored.info),
          ),
        })
      }

      return json({ error: "not_found", message: "Not found" }, 404)
      } catch (error) {
        if (internalRequest) {
          reportError({
            requestId,
            method: request.method,
            pathname,
            phase: "file_asset_request",
            code: error instanceof FileAssetError ? error.code : "internal_error",
            status: error instanceof FileAssetError ? error.status : 500,
            error,
          })
        }
        return errorResponse(error)
      }
    })()
    const responseWithRequestId = (() => {
      if (!requestId) return response
      const headers = new Headers(response.headers)
      headers.set("X-Canvas-Request-Id", requestId)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    })()
    return internalRequest
      ? responseWithRequestId
      : applyCors(responseWithRequestId, request, options.allowedOrigins)
  }
}

function parseHostedPreviewWritePath(pathname: string): Readonly<{ artifactId: string; stagingId: string; action: "file" | "commit" | "publish" | "status" | "discard" }> | null {
  const match = /^\/internal\/hosted-preview-artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/staging\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(file|commit|publish|status|discard)$/i.exec(pathname)
  return match ? Object.freeze({ artifactId: match[1]!.toLowerCase(), stagingId: match[2]!.toLowerCase(), action: match[3]!.toLowerCase() as "file" | "commit" | "publish" | "status" | "discard" }) : null
}

function nonnegativeIntegerHeader(request: Request, name: string): number {
  const raw = request.headers.get(name)
  if (raw === null || !/^\d+$/.test(raw)) throw new FileAssetError("bad_request", `${name} is invalid`, 400)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new FileAssetError("bad_request", `${name} is invalid`, 400)
  return value
}
