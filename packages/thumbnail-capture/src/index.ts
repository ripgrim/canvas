export const THUMBNAIL_CONTENT_TYPE = "image/avif" as const
export const THUMBNAIL_MAX_WIDTH = 1024
export const THUMBNAIL_MAX_HEIGHT = 768
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type ThumbnailCaptureRequest = Readonly<{
  fileId: string
  expectedRevision: number
  contentType: typeof THUMBNAIL_CONTENT_TYPE
  maxWidth: typeof THUMBNAIL_MAX_WIDTH
  maxHeight: typeof THUMBNAIL_MAX_HEIGHT
}>

export type ThumbnailUploadRequest = Readonly<{
  fileId: string
  expectedRevision: number
  contentType: typeof THUMBNAIL_CONTENT_TYPE
  bytes: Uint8Array
}>

export type ThumbnailUploadReceipt = Readonly<{
  key: string
  etag: string
}>

export type ThumbnailMetadata = Readonly<{
  fileId: string
  revision: number
  thumbnailKey: string
  thumbnailEtag: string
}>

export interface ThumbnailCapturePort {
  capture(request: ThumbnailCaptureRequest): Promise<Uint8Array>
}

export interface ThumbnailUploadPort {
  upload(request: ThumbnailUploadRequest): Promise<ThumbnailUploadReceipt>
}

export interface ThumbnailMetadataPort {
  commit(input: Readonly<{
    fileId: string
    expectedRevision: number
    thumbnailKey: string
    thumbnailEtag: string
  }>): Promise<ThumbnailMetadata>
}

export interface ThumbnailCapturePipeline {
  captureAndCommit(input: Readonly<{
    fileId: string
    expectedRevision: number
  }>): Promise<ThumbnailMetadata>
}

export function thumbnailObjectKey(
  fileId: string,
  expectedRevision: number,
  nonce: string,
): string {
  identifier(fileId, "file id")
  revision(expectedRevision)
  identifier(nonce, "thumbnail nonce")
  return `thumbnails/${fileId}/versions/${expectedRevision}/${nonce}.avif`
}

export function thumbnailUrlPath(fileId: string): string {
  identifier(fileId, "file id")
  return `/file-assets/thumbnails/${fileId}/thumbnail.avif`
}

export function createThumbnailCapturePipeline(options: Readonly<{
  capture: ThumbnailCapturePort
  upload: ThumbnailUploadPort
  metadata: ThumbnailMetadataPort
}>): ThumbnailCapturePipeline {
  return Object.freeze({
    async captureAndCommit(input: Readonly<{ fileId: string; expectedRevision: number }>) {
      const fileId = identifier(input.fileId, "file id")
      const expectedRevision = revision(input.expectedRevision)
      const captured = await options.capture.capture(Object.freeze({
        fileId,
        expectedRevision,
        contentType: THUMBNAIL_CONTENT_TYPE,
        maxWidth: THUMBNAIL_MAX_WIDTH,
        maxHeight: THUMBNAIL_MAX_HEIGHT,
      }))
      const bytes = captured.slice()
      validateThumbnailSize(bytes)
      const uploaded = await options.upload.upload(Object.freeze({
        fileId,
        expectedRevision,
        contentType: THUMBNAIL_CONTENT_TYPE,
        bytes,
      }))
      if (!isThumbnailObjectKey(uploaded.key, fileId, expectedRevision)) {
        throw new Error("Thumbnail upload returned an unexpected key.")
      }
      const etag = uploaded.etag
      if (!etag || etag.length > 256) throw new Error("Thumbnail upload returned an invalid ETag.")
      const committed = await options.metadata.commit(Object.freeze({
        fileId,
        expectedRevision,
        thumbnailKey: uploaded.key,
        thumbnailEtag: etag,
      }))
      if (
        committed.fileId !== fileId ||
        committed.revision !== expectedRevision ||
        committed.thumbnailKey !== uploaded.key ||
        committed.thumbnailEtag !== etag
      ) {
        throw new Error("Thumbnail metadata response does not match the request.")
      }
      return Object.freeze({ ...committed })
    },
  })
}

export function createHttpThumbnailUploadPort(options: Readonly<{
  assetsOrigin: string
  fetch?: typeof globalThis.fetch
  headers?: () => HeadersInit
}>): ThumbnailUploadPort {
  const origin = httpOrigin(options.assetsOrigin)
  const fetchRequest = options.fetch ?? globalThis.fetch
  return Object.freeze({
    async upload(request: ThumbnailUploadRequest) {
      const fileId = identifier(request.fileId, "file id")
      const expectedRevision = revision(request.expectedRevision)
      validateThumbnailSize(request.bytes)
      const intentResponse = await fetchRequest(
        new URL("/file-assets/thumbnail-upload-intents", origin),
        {
          method: "POST",
          credentials: "include",
          headers: mutationHeaders(options.headers?.(), true),
          body: JSON.stringify({
            fileId,
            expectedRevision,
            contentType: THUMBNAIL_CONTENT_TYPE,
            size: request.bytes.byteLength,
          }),
          redirect: "manual",
        },
      )
      await checked(intentResponse)
      const intent = intentPayload(await intentResponse.json(), request.bytes.byteLength)
      const uploadResponse = await fetchRequest(new URL(intent.path, origin), {
        method: "PUT",
        credentials: "include",
        headers: mutationHeaders(options.headers?.(), false, intent.headers),
        body: request.bytes.slice().buffer as ArrayBuffer,
        redirect: "manual",
      })
      await checked(uploadResponse)
      const receipt = record(await uploadResponse.json(), "thumbnail upload response")
      const key = string(receipt.key, "thumbnail key")
      const etag = string(receipt.etag, "thumbnail ETag")
      if (!isThumbnailObjectKey(key, fileId, expectedRevision) || !etag || etag.length > 256) {
        throw new Error("Thumbnail upload response is invalid.")
      }
      return Object.freeze({ key, etag })
    },
  })
}

function validateThumbnailSize(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new Error("Thumbnail bytes are invalid.")
  }
}

function isThumbnailObjectKey(key: string, fileId: string, expectedRevision: number): boolean {
  const match = /^thumbnails\/([^/]+)\/versions\/(0|[1-9][0-9]*)\/([^/.]+)\.avif$/.exec(key)
  return Boolean(
    match &&
    match[1] === fileId &&
    Number(match[2]) === expectedRevision &&
    match[3] &&
    IDENTIFIER.test(match[3]),
  )
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid expected revision.")
  }
  return value
}

function httpOrigin(value: string): URL {
  const origin = new URL(value)
  const hostname = origin.hostname.toLowerCase()
  const loopback = hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname === "::1" || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
  if (
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))
  ) {
    throw new Error("Assets origin must use HTTPS outside loopback and must not include credentials.")
  }
  return origin
}

function mutationHeaders(
  initial: HeadersInit | undefined,
  json: boolean,
  intent?: Readonly<Record<string, string>>,
): Headers {
  const headers = new Headers(initial)
  if (json) headers.set("Content-Type", "application/json")
  if (intent) {
    headers.set("Content-Length", intent["Content-Length"] ?? "")
    headers.set("Content-Type", intent["Content-Type"] ?? "")
    headers.set("X-Canvas-Upload-Token", intent["X-Canvas-Upload-Token"] ?? "")
  }
  return headers
}

async function checked(response: Response): Promise<Response> {
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Thumbnail service redirects are not allowed.")
  }
  if (!response.ok) {
    throw new Error(`Thumbnail service returned ${response.status}.`)
  }
  return response
}

function intentPayload(value: unknown, size: number): Readonly<{
  path: "/file-assets/thumbnail-uploads"
  headers: Readonly<Record<string, string>>
}> {
  const intent = record(value, "thumbnail upload intent")
  if (
    intent.method !== "PUT" ||
    intent.path !== "/file-assets/thumbnail-uploads" ||
    typeof intent.token !== "string" ||
    typeof intent.expiresAt !== "string"
  ) {
    throw new Error("Thumbnail upload intent is invalid.")
  }
  const headers = record(intent.headers, "thumbnail upload headers")
  if (
    headers["Content-Length"] !== String(size) ||
    headers["Content-Type"] !== THUMBNAIL_CONTENT_TYPE ||
    headers["X-Canvas-Upload-Token"] !== intent.token
  ) {
    throw new Error("Thumbnail upload intent is invalid.")
  }
  return Object.freeze({
    path: intent.path,
    headers: Object.freeze({
      "Content-Length": headers["Content-Length"],
      "Content-Type": headers["Content-Type"],
      "X-Canvas-Upload-Token": headers["X-Canvas-Upload-Token"],
    }),
  })
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`)
  return value
}
