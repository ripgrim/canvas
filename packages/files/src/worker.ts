import type {
  AssetAccess,
  AssetActor,
  AssetDescriptor,
  CopyAssetRequest,
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
import type { FileAssetService } from "./service.js"

export interface FileAccessAuthority {
  authorize(
    request: Request,
    fileId: string,
    access: AssetAccess,
  ): Promise<AssetActor | null>
}

export interface HostedFileAccessAuthorityOptions {
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}

export interface FileAssetsHandlerOptions {
  service: FileAssetService
  accessAuthority: FileAccessAuthority
  allowedOrigins?: ReadonlySet<string>
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

function contentLength(request: Request): number {
  const raw = request.headers.get("content-length")
  const value = raw === null ? Number.NaN : Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FileAssetError("bad_request", "Content-Length is required", 411)
  }
  return value
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
  info: {
    contentType: string
    size: number
    etag?: string
    lastModified?: Date
  },
  cacheControl: string,
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
): Promise<AssetActor> {
  const actor = await authority.authorize(request, fileId, access)
  if (!actor) {
    throw new FileAssetError("unauthorized", "Sign in first", 401)
  }
  return actor
}

export function createHostedFileAccessAuthority(
  options: HostedFileAccessAuthorityOptions,
): FileAccessAuthority {
  const fetchRequest = options.fetch ?? globalThis.fetch
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) {
    throw new Error("API_SERVICE_TOKEN must contain at least 32 bytes")
  }
  const endpointUrl = new URL("/internal/file-access", options.apiOrigin)
  if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
    throw new Error("API_ORIGIN must use HTTP or HTTPS")
  }
  const endpoint = endpointUrl.toString()
  return {
    async authorize(request, fileId, access) {
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Canvas-Service-Token": options.serviceToken,
      })
      const authorization = request.headers.get("authorization")
      const cookie = request.headers.get("cookie")
      if (authorization) {
        headers.set("Authorization", authorization)
      } else if (cookie) {
        headers.set("Cookie", cookie)
      }
      const response = await fetchRequest(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ fileId, access }),
        signal: AbortSignal.timeout(5_000),
      })
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return null
      }
      if (!response.ok) {
        throw new Error(`File access service returned ${response.status}`)
      }
      const declaredLength = Number(response.headers.get("content-length"))
      if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
        await response.body?.cancel()
        return null
      }
      const source = await response.text()
      if (new TextEncoder().encode(source).byteLength > 16 * 1024) {
        return null
      }
      let result: unknown
      try {
        result = JSON.parse(source)
      } catch {
        return null
      }
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        Object.keys(result).join(",") !== "userId"
      ) {
        return null
      }
      const userId = (result as Record<string, unknown>).userId
      return typeof userId === "string" && /^[A-Za-z0-9:._-]{1,128}$/.test(userId)
        ? { userId }
        : null
    },
  }
}

export function createFileAssetsHandler(
  options: FileAssetsHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await (async () => {
      try {
      const { pathname } = new URL(request.url)

      if (request.method === "OPTIONS") {
        const origin = request.headers.get("origin")
        if (!origin || !options.allowedOrigins?.has(origin)) {
          throw new FileAssetError("forbidden", "Origin is not allowed", 403)
        }
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Headers": "Authorization, Content-Length, Content-Type, X-Canvas-Upload-Token",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Max-Age": "3600",
            Vary: "Origin",
          },
        })
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
        const length = contentLength(request)
        const body = await readBoundedBody(request, length, MAX_ASSET_BYTES)
        const stored = await options.service.upload(
          actor,
          claims,
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
        requireMutationOrigin(request, options.allowedOrigins)
        const actor = await requireAccess(
          options.accessAuthority,
          request,
          thumbnailFileId,
          "write",
        )
        const length = contentLength(request)
        const body = await readBoundedBody(request, length, MAX_THUMBNAIL_BYTES)
        const stored = await options.service.putThumbnail(
          actor,
          thumbnailFileId,
          body,
          request.headers.get("content-type") ?? "",
          length,
        )
        return json(stored, 200)
      }
      if (thumbnailFileId && (request.method === "GET" || request.method === "HEAD")) {
        await requireAccess(
          options.accessAuthority,
          request,
          thumbnailFileId,
          "read",
        )
        const stored = request.method === "HEAD"
          ? { info: await options.service.headThumbnail(thumbnailFileId), body: null }
          : await options.service.downloadThumbnail(thumbnailFileId)
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
          headers: responseHeaders(stored.info, "private, max-age=31536000, immutable"),
        })
      }

      return json({ error: "not_found", message: "Not found" }, 404)
      } catch (error) {
        return errorResponse(error)
      }
    })()
    return applyCors(response, request, options.allowedOrigins)
  }
}
