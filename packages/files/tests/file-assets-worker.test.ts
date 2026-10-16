import { describe, expect, it } from "vitest"

import type {
  AssetDownload,
  AssetObjectInfo,
  AssetStore,
  AssetWriteOptions,
  AssetMediaDecoder,
  ThumbnailUploadQuota,
} from "../src/index.js"
import {
  FileAssetError,
  FileAssetService,
  MAX_ASSET_BYTES,
  MAX_DECODED_IMAGE_PIXELS,
  UploadIntentSigner,
} from "../src/index.js"
import {
  createFileAssetsHandler,
  createHostedFileAccessAuthority,
  createHostedThumbnailCommitResolver,
  createHostedThumbnailServiceAuthority,
  type FileAssetErrorReport,
  type FileAccessAuthority,
} from "../src/worker.js"
import { createR2BindingAssetStore } from "../src/r2.js"
import { createHostedPreviewArtifactAssetStorage } from "../src/hosted-preview.js"
import type { HostedPreviewArtifactAssetStorage } from "../src/hosted-preview.js"
import type { HostedPreviewArtifactManifest } from "@canvas/preview-runtime/hosted-artifact"
import { issueHostedPreviewWriteCapability } from "@canvas/preview-runtime/hosted-write-capability"

const fixture = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))
const PNG_BYTES = fixture("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6goKBSYeYRwWLQAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMC0xMFQwNTozODozMCswMDowMIU5XnIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTAtMTBUMDU6Mzg6MzArMDA6MDD0ZObOAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTEwLTEwVDA1OjM4OjMwKzAwOjAwo3HHEQAAAABJRU5ErkJggg==")
const PNG_SHA256 = "ce7e567b6c50d6366a2f1aa0b9aa9a3debc253f67f07f2206ec481849197eb6d"
const AVIF_BYTES = fixture("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAABAAAAAMAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGBV/vbAIMhMYAAAAUAAAAAoFeVJuQ9k6RgIo")
const OVERSIZED_PNG = fixture("iVBORw0KGgoAAAANSUhEUgAAE4gAABOIAQMAAABnVhWIAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6goKBSYeYRwWLQAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMC0xMFQwNTozODozMCswMDowMIU5XnIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTAtMTBUMDU6Mzg6MzArMDA6MDD0ZObOAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTEwLTEwVDA1OjM4OjMwKzAwOjAwo3HHEQAAAABJRU5ErkJggg==")
const OVERSIZED_GIF = fixture("R0lGODlhiBOIE4AAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
const OVERSIZED_WEBP = fixture("UklGRhIAAABXRUJQVlA4TAUAAAAvh9PhBAA=")
const THUMBNAIL_SERVICE_TOKEN = "thumbnail-service-test-token-at-least-32-bytes"
const API_SERVICE_TOKEN = "test-only-service-token-at-least-32-bytes"
const HOSTED_ARTIFACT_ID = "00000000-0000-4000-8000-000000000301"
const HOSTED_STAGING_ID = "00000000-0000-4000-8000-000000000401"
const HOSTED_JOB_ID = "00000000-0000-4000-8000-000000000501"
const HOSTED_LEASE_ID = "00000000-0000-4000-8000-000000000601"
const HOSTED_WRITE_SECRET = "hosted-preview-write-test-secret-0123456789"
const HOSTED_ASSETS_ORIGIN = "https://workers.canvas.test"
const HOSTED_MANIFEST: HostedPreviewArtifactManifest = Object.freeze({
  version: 1,
  sourceRevision: "a".repeat(40),
  registryFingerprint: `sha256:${"b".repeat(64)}`,
  entrypoint: "index.html",
  files: Object.freeze([
    Object.freeze({ path: "index.html", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", bytes: 5, contentType: "text/html; charset=utf-8" as const }),
    Object.freeze({ path: "assets/components.js", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", bytes: 0, contentType: "text/javascript; charset=utf-8" as const }),
  ]),
  components: Object.freeze([
    Object.freeze({ componentId: "shadcn:Button:1234567890abcdef", modulePath: "assets/components.js", exportName: "Button" }),
  ]),
})
const NOOP_UPLOAD_QUOTA: ThumbnailUploadQuota = {
  async acquire() {},
}
const TEST_MEDIA_DECODER = {
  async decode(extension: "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp") {
    const dimensions = extension === "avif" ? { width: 64, height: 48 }
      : extension === "png" ? { width: 2, height: 2 }
        : { width: 1, height: 1 }
    return { ...dimensions, pixelCount: dimensions.width * dimensions.height }
  },
} satisfies AssetMediaDecoder

function oversizedChunkedResponse(onCancel: () => void): Response {
  let chunks = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1
      controller.enqueue(new Uint8Array(9 * 1024).fill(0x20))
    },
    cancel() {
      onCancel()
    },
  }), {
    status: 200,
    headers: {
      "Content-Length": "1",
      "Content-Type": "application/json",
    },
  })
}

class MemoryAssetStore implements AssetStore {
  readonly objects = new Map<
    string,
    { body: Uint8Array; info: AssetObjectInfo }
  >()
  readonly copyCalls: Array<{ from: string; to: string }> = []
  #version = 0

  async put(
    key: string,
    body: Uint8Array,
    options: AssetWriteOptions,
  ): Promise<AssetObjectInfo> {
    const current = this.objects.get(key)
    const condition = options.condition ??
      (options.immutable ? { type: "create" as const } : undefined)
    if (
      (condition?.type === "create" && current) ||
      (condition?.type === "match" && current?.info.etag !== condition.etag)
    ) {
      throw new FileAssetError("conflict", "Asset changed before upload", 409)
    }
    this.#version += 1
    const info: AssetObjectInfo = {
      key,
      size: body.byteLength,
      contentType: options.contentType,
      etag: `etag-${this.#version}-${key}`,
      metadata: options.metadata,
    }
    this.objects.set(key, { body: body.slice(), info })
    return info
  }

  async download(key: string): Promise<AssetDownload | null> {
    const stored = this.objects.get(key)
    if (!stored) {
      return null
    }
    const body = stored.body.slice()
    return {
      info: stored.info,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(body)
          controller.close()
        },
      }),
    }
  }

  async head(key: string): Promise<AssetObjectInfo | null> {
    return this.objects.get(key)?.info ?? null
  }

  async copy(from: string, to: string, options: AssetWriteOptions): Promise<void> {
    const source = this.objects.get(from)
    if (!source) {
      throw new Error("missing source")
    }
    if (this.objects.has(to)) {
      throw new Error("target already exists")
    }
    this.copyCalls.push({ from, to })
    this.objects.set(to, {
      body: source.body.slice(),
      info: {
        ...source.info,
        key: to,
        etag: `etag-${to}`,
        contentType: options.contentType,
        metadata: options.metadata,
      },
    })
  }

  async list(input: { prefix: string; cursor?: string; limit: number }) {
    const objects = [...this.objects.values()]
      .map(value => value.info)
      .filter(info => info.key.startsWith(input.prefix))
      .slice(0, input.limit)
    return { objects }
  }

  async delete(key: string): Promise<boolean> {
    const current = this.objects.get(key)
    if (!current) return false
    return this.objects.delete(key)
  }
}

interface TestContext {
  store: MemoryAssetStore
  hostedPreviewStorage: HostedPreviewArtifactAssetStorage
  handler: (request: Request) => Promise<Response>
  grant(userId: string, fileId: string, access: "read" | "write"): void
  setHead(fileId: string, revision: number): void
  commitThumbnail(fileId: string, revision: number, key: string, etag: string): void
}

function createContext(
  thumbnailQuota?: ThumbnailUploadQuota,
  mediaDecoder: AssetMediaDecoder = TEST_MEDIA_DECODER,
  reportError?: (report: FileAssetErrorReport) => void,
): TestContext {
  const store = new MemoryAssetStore()
  const grants = new Set<string>()
  const heads = new Map<string, number>()
  const thumbnails = new Map<string, { fileId: string; revision: number; key: string; etag: string }>()
  let nonce = 0
  const authority: FileAccessAuthority = {
    async authorize(request, fileId, access, expectedRevision, resource) {
      const userId = request.headers.get("x-user-id")
      if (!userId || !grants.has(`${userId}:${fileId}:${access}`)) return null
      if (resource !== "thumbnail") return { userId }
      const revision = heads.get(fileId)
      if (revision === undefined) return null
      if (expectedRevision !== undefined) return { userId, revision }
      return { userId, revision, thumbnail: thumbnails.get(fileId) ?? null }
    },
  }
  const service = new FileAssetService({
    store,
    signer: new UploadIntentSigner({
      secret: "test-only-secret-that-is-at-least-thirty-two-bytes",
      now: () => 1_800_000_000_000,
      nonce: () => `fixed-nonce-${++nonce}`,
    }),
    mediaDecoder,
    uploadQuota: thumbnailQuota ?? NOOP_UPLOAD_QUOTA,
    ...(thumbnailQuota ? { thumbnailQuota } : {}),
  })
  const hostedPreviewStorage = createHostedPreviewArtifactAssetStorage({ store })
  return {
    store,
    hostedPreviewStorage,
    handler: createFileAssetsHandler({
      service,
      accessAuthority: authority,
      thumbnailServiceAuthority: {
        async authorize(request, fileId, expectedRevision) {
          if (request.headers.get("x-canvas-thumbnail-service-token") !== THUMBNAIL_SERVICE_TOKEN) {
            return null
          }
          const revision = heads.get(fileId)
          if (revision !== expectedRevision) {
            throw new FileAssetError("conflict", "File changed before upload", 409)
          }
          return { userId: "thumbnail-service", revision }
        },
      },
      serviceToken: API_SERVICE_TOKEN,
      hostedPreviewStorage,
      hostedPreviewWriteSecret: HOSTED_WRITE_SECRET,
      hostedPreviewAssetsOrigin: HOSTED_ASSETS_ORIGIN,
      allowedOrigins: new Set(["https://app.canvas.test"]),
      ...(reportError ? { reportError } : {}),
    }),
    grant(userId, fileId, access) {
      grants.add(`${userId}:${fileId}:${access}`)
    },
    setHead(fileId, revision) {
      heads.set(fileId, revision)
    },
    commitThumbnail(fileId, revision, key, etag) {
      thumbnails.set(fileId, { fileId, revision, key, etag })
    },
  }
}

function jsonRequest(
  path: string,
  userId: string,
  body: unknown,
): Request {
  return new Request(`https://workers.canvas.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://app.canvas.test",
      "X-User-Id": userId,
    },
    body: JSON.stringify(body),
  })
}

async function createIntent(
  context: TestContext,
  fileId: string,
  assetId: string,
  bytes: Uint8Array,
): Promise<string> {
  const response = await context.handler(
    jsonRequest("/file-assets/upload-intents", "user-a", {
      fileId,
      assetId,
      extension: "png",
      contentType: "image/png",
      size: bytes.byteLength,
    }),
  )
  expect(response.status).toBe(201)
  const payload = (await response.json()) as { token: string }
  return payload.token
}

async function upload(
  context: TestContext,
  token: string,
  bytes: Uint8Array,
  userId = "user-a",
): Promise<Response> {
  return context.handler(
    new Request("https://workers.canvas.test/file-assets/uploads", {
      method: "PUT",
      headers: {
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "image/png",
        Origin: "https://app.canvas.test",
        "X-Canvas-Upload-Token": token,
        "X-User-Id": userId,
      },
      body: bytes.buffer as ArrayBuffer,
    }),
  )
}

async function createThumbnailIntent(
  context: TestContext,
  fileId: string,
  bytes: Uint8Array,
  expectedRevision: number,
): Promise<string> {
  const response = await context.handler(thumbnailIntentRequest(
    fileId,
    bytes.byteLength,
    expectedRevision,
  ))
  expect(response.status).toBe(201)
  const payload = (await response.json()) as { token: string }
  return payload.token
}

function thumbnailIntentRequest(
  fileId: string,
  size: number,
  expectedRevision: number,
): Request {
  return new Request("https://workers.canvas.test/file-assets/thumbnail-upload-intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Canvas-Thumbnail-Service-Token": THUMBNAIL_SERVICE_TOKEN,
      },
      body: JSON.stringify({
      fileId,
      expectedRevision,
      contentType: "image/avif",
      size,
      }),
    })
}

async function uploadThumbnail(
  context: TestContext,
  token: string,
  bytes: Uint8Array,
  userId = "user-a",
): Promise<Response> {
  return context.handler(
    new Request("https://workers.canvas.test/file-assets/thumbnail-uploads", {
      method: "PUT",
      headers: {
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "image/avif",
        Origin: "https://app.canvas.test",
        "X-Canvas-Upload-Token": token,
        "X-Canvas-Thumbnail-Service-Token": userId === "user-a"
          ? THUMBNAIL_SERVICE_TOKEN
          : "wrong-thumbnail-service-token-at-least-32-bytes",
      },
      body: bytes.buffer as ArrayBuffer,
    }),
  )
}

function legacyImageRequest(input: Readonly<{
  bytes?: Uint8Array
  token?: string
  fileId?: string
  assetId?: string
  extension?: string
  contentType?: string
  contentLength?: number
  width?: string
  height?: string
  method?: string
  path?: string
  origin?: string
  userId?: string | null
  requestId?: string
}> = {}): Request {
  const bytes = input.bytes ?? PNG_BYTES
  const fileId = input.fileId ?? "file-1"
  const assetId = input.assetId ?? "legacy-image"
  const extension = input.extension ?? "png"
  const headers = new Headers({
    "Content-Length": String(input.contentLength ?? bytes.byteLength),
    "Content-Type": input.contentType ?? "image/png",
    "X-Canvas-Asset-Height": input.height ?? "2",
    "X-Canvas-Asset-Width": input.width ?? "2",
    "X-Canvas-Request-Id": input.requestId ?? "11111111-1111-4111-8111-111111111111",
    "X-Canvas-Service-Token": input.token ?? API_SERVICE_TOKEN,
  })
  if (input.userId !== null) headers.set("X-User-Id", input.userId ?? "user-a")
  if (input.origin) headers.set("Origin", input.origin)
  const method = input.method ?? "PUT"
  return new Request(
    `https://workers.canvas.test${input.path ?? `/internal/file-assets/legacy/${fileId}/${assetId}.${extension}`}`,
    {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: bytes.buffer as ArrayBuffer }),
      redirect: "manual",
    },
  )
}

function createLegacyContext(reportError?: (report: FileAssetErrorReport) => void): TestContext {
  const context = createContext(undefined, TEST_MEDIA_DECODER, reportError)
  context.grant("user-a", "file-1", "write")
  return context
}

describe("file assets Worker boundary", () => {
  it("COMP-V2-CODE-012 writes only the capability-bound hosted artifact before publication", async () => {
    const context = createContext()
    const token = await issueHostedPreviewWriteCapability({
      jobId: HOSTED_JOB_ID,
      leaseId: HOSTED_LEASE_ID,
      artifactId: HOSTED_ARTIFACT_ID,
      stagingId: HOSTED_STAGING_ID,
      audience: HOSTED_ASSETS_ORIGIN,
      secret: HOSTED_WRITE_SECRET,
      lifetimeSeconds: 300,
    })
    const root = `/internal/hosted-preview-artifacts/${HOSTED_ARTIFACT_ID}/staging/${HOSTED_STAGING_ID}`
    const authorizationHeaders = {
      "X-Canvas-Hosted-Preview-Job-Id": HOSTED_JOB_ID,
      "X-Canvas-Hosted-Preview-Lease-Id": HOSTED_LEASE_ID,
      "X-Canvas-Hosted-Preview-Write-Capability": token,
    }
    const upload = (input: Readonly<{ artifactId?: string; stagingId?: string; jobId?: string; leaseId?: string; capability?: string }> = {}) => context.handler(new Request(
      `https://workers.canvas.test/internal/hosted-preview-artifacts/${input.artifactId ?? HOSTED_ARTIFACT_ID}/staging/${input.stagingId ?? HOSTED_STAGING_ID}/file`,
      {
        method: "PUT",
        headers: {
          ...authorizationHeaders,
          "X-Canvas-Hosted-Preview-Job-Id": input.jobId ?? HOSTED_JOB_ID,
          "X-Canvas-Hosted-Preview-Lease-Id": input.leaseId ?? HOSTED_LEASE_ID,
          "X-Canvas-Hosted-Preview-Write-Capability": input.capability ?? token,
          "X-Canvas-Artifact-Path": "index.html",
          "X-Canvas-Artifact-Sha256": HOSTED_MANIFEST.files[0]!.sha256,
          "X-Canvas-Artifact-Bytes": "5",
          "Content-Type": HOSTED_MANIFEST.files[0]!.contentType,
          "Content-Length": "5",
        },
        body: new TextEncoder().encode("hello"),
      },
    ))
    expect((await upload({ artifactId: crypto.randomUUID() })).status).toBe(403)
    expect((await upload({ leaseId: crypto.randomUUID() })).status).toBe(403)
    expect((await upload({ jobId: crypto.randomUUID() })).status).toBe(403)
    expect((await upload({ stagingId: crypto.randomUUID() })).status).toBe(403)
    expect((await upload({ capability: `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}` })).status).toBe(403)
    expect(context.store.objects.size).toBe(0)
    expect((await upload()).status).toBe(201)
    const emptyFile = HOSTED_MANIFEST.files[1]!
    expect((await context.handler(new Request(`https://workers.canvas.test${root}/file`, {
      method: "PUT",
      headers: { ...authorizationHeaders, "X-Canvas-Artifact-Path": emptyFile.path, "X-Canvas-Artifact-Sha256": emptyFile.sha256, "X-Canvas-Artifact-Bytes": "0", "Content-Type": emptyFile.contentType },
    }))).status).toBe(201)
    const manifest = new TextEncoder().encode(JSON.stringify(HOSTED_MANIFEST))
    expect((await context.handler(new Request(`https://workers.canvas.test${root}/commit`, {
      method: "POST",
      headers: { ...authorizationHeaders, "Content-Type": "application/json", "Content-Length": String(manifest.byteLength) },
      body: manifest,
    }))).status).toBe(201)
    expect((await context.handler(new Request(`https://workers.canvas.test${root}/status`, { headers: authorizationHeaders }))).status).toBe(200)
    expect((await context.handler(new Request(`https://workers.canvas.test${root}/publish`, { method: "POST", headers: authorizationHeaders }))).status).toBe(200)
    expect((await context.handler(new Request(`https://workers.canvas.test/internal/hosted-previews/${HOSTED_ARTIFACT_ID}/files/index.html`, { headers: { "X-Canvas-Service-Token": API_SERVICE_TOKEN } }))).status).toBe(200)
  })

  it("COMP-V2-CODE-005 exposes only published hosted files through the service-only route", async () => {
    const context = createContext()
    const receipt = { artifactId: HOSTED_ARTIFACT_ID, stagingId: HOSTED_STAGING_ID }
    const files = new Map([
      ["index.html", new TextEncoder().encode("hello")],
      ["assets/components.js", new Uint8Array()],
    ])
    await context.hostedPreviewStorage.stage({ ...receipt, manifest: HOSTED_MANIFEST, files })
    const request = (method = "GET", headers: HeadersInit = {}) => context.handler(new Request(
      `https://workers.canvas.test/internal/hosted-previews/${HOSTED_ARTIFACT_ID}/files/index.html`,
      { method, headers: { "X-Canvas-Service-Token": API_SERVICE_TOKEN, ...headers } },
    ))

    expect((await request()).status).toBe(404)
    await context.hostedPreviewStorage.publish(receipt)

    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello")
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(response.headers.get("etag")).toBe(`"${HOSTED_MANIFEST.files[0]!.sha256}"`)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()

    const head = await request("HEAD")
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("content-length")).toBe("5")

    const storedKey = `hosted-previews/${HOSTED_ARTIFACT_ID}/staging/${HOSTED_STAGING_ID}/index.html`
    context.store.objects.get(storedKey)!.body.fill(0)
    expect((await request()).status).toBe(500)
  })

  it("COMP-V2-CODE-005 rejects browser, unauthenticated, malformed, and mutating hosted-file requests", async () => {
    const context = createContext()
    const path = `/internal/hosted-previews/${HOSTED_ARTIFACT_ID}/files/index.html`
    expect((await context.handler(new Request(`https://workers.canvas.test${path}`))).status).toBe(401)
    expect((await context.handler(new Request(`https://workers.canvas.test${path}`, {
      headers: { Origin: "https://app.canvas.test", "X-Canvas-Service-Token": API_SERVICE_TOKEN },
    }))).status).toBe(403)
    expect((await context.handler(new Request(`https://workers.canvas.test${path}`, {
      method: "POST",
      headers: { "X-Canvas-Service-Token": API_SERVICE_TOKEN },
    }))).status).toBe(405)
    expect((await context.handler(new Request(
      `https://workers.canvas.test/internal/hosted-previews/${HOSTED_ARTIFACT_ID}/files/%2e%2e/secret.js`,
      { headers: { "X-Canvas-Service-Token": API_SERVICE_TOKEN } },
    ))).status).toBe(404)
    expect((await context.handler(new Request(
      `https://workers.canvas.test${path}?download=1`,
      { headers: { "X-Canvas-Service-Token": API_SERVICE_TOKEN } },
    ))).status).toBe(404)
  })

  it("FILE-ASSET-SEC-001 serves credentialed preflight and correlates every public response", async () => {
    const context = createContext()
    const requestId = "11111111-1111-4111-8111-111111111111"
    const allowed = await context.handler(new Request(
      "https://workers.canvas.test/file-assets/uploads",
      {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Headers": "content-type,x-canvas-upload-token",
          "Access-Control-Request-Method": "PUT",
          Origin: "https://app.canvas.test",
          "X-Canvas-Request-Id": requestId,
        },
      },
    ))
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.canvas.test")
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true")
    expect(allowed.headers.get("access-control-allow-methods")).toContain("PUT")
    expect(allowed.headers.get("access-control-allow-headers"))
      .toContain("X-Canvas-Request-Id")
    expect(allowed.headers.get("x-canvas-request-id")).toBe(requestId)
    expect(allowed.headers.get("access-control-expose-headers"))
      .toContain("X-Canvas-Request-Id")

    const rejected = await context.handler(new Request(
      "https://workers.canvas.test/file-assets/uploads",
      {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "PUT",
          Origin: "https://evil.example",
          "X-Canvas-Request-Id": "bad request id",
        },
      },
    ))
    expect(rejected.status).toBe(403)
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull()
    expect(rejected.headers.get("access-control-allow-credentials")).toBeNull()
    expect(rejected.headers.get("x-canvas-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(rejected.headers.get("x-canvas-request-id")).not.toBe("bad request id")

    const error = await context.handler(new Request(
      "https://workers.canvas.test/file-assets/upload-intents",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.canvas.test",
          "X-Canvas-Request-Id": requestId,
        },
        body: "{}",
      },
    ))
    expect(error.status).toBe(400)
    expect(error.headers.get("x-canvas-request-id")).toBe(requestId)
    expect(error.headers.get("access-control-expose-headers"))
      .toContain("X-Canvas-Request-Id")
  })

  it("FILE-ASSET-SEC-001 meters ordinary upload intents and malformed upload attempts", async () => {
    let intentAttempts = 0
    const intentContext = createContext({
      async acquire(request) {
        if (request.operation !== "intent") return
        intentAttempts += 1
        if (intentAttempts > 1) {
          throw new FileAssetError("too_many_requests", "intent limit reached", 429)
        }
      },
    })
    intentContext.grant("user-a", "file-1", "write")
    expect((await createIntent(intentContext, "file-1", "intent-1", PNG_BYTES))).toBeTruthy()
    const boundedIntent = await intentContext.handler(jsonRequest(
      "/file-assets/upload-intents",
      "user-a",
      {
        fileId: "file-1",
        assetId: "intent-2",
        extension: "png",
        contentType: "image/png",
        size: PNG_BYTES.byteLength,
      },
    ))
    expect(boundedIntent.status).toBe(429)
    expect(intentAttempts).toBe(2)

    let uploadAttempts = 0
    const uploadContext = createContext({
      async acquire(request) {
        if (request.operation !== "upload") return
        uploadAttempts += 1
        if (uploadAttempts > 1) {
          throw new FileAssetError("too_many_requests", "upload limit reached", 429)
        }
      },
    })
    uploadContext.grant("user-a", "file-1", "write")
    const firstToken = await createIntent(uploadContext, "file-1", "malformed-1", PNG_BYTES)
    const secondToken = await createIntent(uploadContext, "file-1", "malformed-2", PNG_BYTES)
    const malformed = (token: string) => uploadContext.handler(new Request(
      "https://workers.canvas.test/file-assets/uploads",
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          Origin: "https://app.canvas.test",
          "X-Canvas-Upload-Token": token,
          "X-User-Id": "user-a",
        },
      },
    ))
    expect((await malformed(firstToken)).status).toBe(411)
    expect(uploadAttempts).toBe(1)
    expect((await malformed(secondToken)).status).toBe(429)
    expect(uploadAttempts).toBe(2)
    expect(materialAssetKeys(uploadContext.store)).toEqual([])
  })

  it("FILE-ASSET-SEC-001 meters malformed upload attempts before reading request bodies", async () => {
    let uploadAttempts = 0
    const context = createContext({
      async acquire(request) {
        if (request.operation !== "upload") return
        uploadAttempts += 1
        if (uploadAttempts > 1) {
          throw new FileAssetError("too_many_requests", "upload limit reached", 429)
        }
      },
    })
    context.setHead("file-1", 0)
    const token = await createThumbnailIntent(context, "file-1", AVIF_BYTES, 0)
    const malformed = () => context.handler(new Request(
      "https://workers.canvas.test/file-assets/thumbnail-uploads",
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/avif",
          "X-Canvas-Thumbnail-Service-Token": THUMBNAIL_SERVICE_TOKEN,
          "X-Canvas-Upload-Token": token,
        },
      },
    ))
    expect((await malformed()).status).toBe(411)
    expect(uploadAttempts).toBe(1)
    expect((await malformed()).status).toBe(429)
    expect(uploadAttempts).toBe(2)
  })

  it("FILE-ASSET-SEC-001 authorizes thumbnail writes only through the narrow service contract", async () => {
    const requests: Request[] = []
    const authority = createHostedThumbnailServiceAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ serviceId: "thumbnail-renderer", revision: 4 })
      },
    })
    expect(await authority.authorize(
      new Request("https://workers.canvas.test"),
      "file-1",
      4,
    )).toBeNull()
    expect(requests).toHaveLength(0)
    const actor = await authority.authorize(new Request("https://workers.canvas.test", {
      headers: {
        Authorization: "Bearer end-user-must-not-forward",
        Cookie: "session=must-not-forward",
        "X-Canvas-Thumbnail-Service-Token": THUMBNAIL_SERVICE_TOKEN,
      },
    }), "file-1", 4)
    expect(actor).toEqual({ userId: "thumbnail-renderer", revision: 4 })
    expect(new URL(requests[0]!.url).pathname).toBe("/internal/thumbnail-upload-access")
    expect(requests[0]!.headers.get("x-canvas-thumbnail-service-token"))
      .toBe(THUMBNAIL_SERVICE_TOKEN)
    expect(requests[0]!.headers.get("authorization")).toBeNull()
    expect(requests[0]!.headers.get("cookie")).toBeNull()
    expect(await requests[0]!.json()).toEqual({ fileId: "file-1", expectedRevision: 4 })
  })

  it("FILE-ASSET-SEC-001 forwards one end-user credential and rejects malformed authority responses", async () => {
    const requests: Request[] = []
    const authority = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ userId: "user-a" })
      },
    })
    const actor = await authority.authorize(
      new Request("https://workers.canvas.test/file-assets/file-1/asset-1.png", {
        headers: {
          Authorization: "Bearer desktop-session",
          Cookie: "session=browser-session",
          "X-Canvas-Request-Id": "11111111-1111-4111-8111-111111111111",
        },
      }),
      "file-1",
      "read",
    )
    expect(actor).toEqual({ userId: "user-a" })
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer desktop-session")
    expect(requests[0]?.headers.get("cookie")).toBeNull()
    expect(requests[0]?.headers.get("x-canvas-request-id"))
      .toBe("11111111-1111-4111-8111-111111111111")

    const revisionAuthority = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ userId: "user-a", revision: 5 })
      },
    })
    expect(await revisionAuthority.authorize(
      new Request("https://workers.canvas.test", {
        headers: { Authorization: "Bearer desktop-session" },
      }),
      "file-1",
      "write",
      5,
      "thumbnail",
    )).toEqual({ userId: "user-a", revision: 5 })
    expect(await requests[1]?.json()).toEqual({
      fileId: "file-1",
      access: "write",
      expectedRevision: 5,
      resource: "thumbnail",
    })
    const missingRevision = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async () => Response.json({ userId: "user-a" }),
    })
    expect(await missingRevision.authorize(
      new Request("https://workers.canvas.test"),
      "file-1",
      "write",
      5,
      "thumbnail",
    )).toBeNull()

    const thumbnailAuthority = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async () => Response.json({
        userId: "user-a",
        revision: 5,
        thumbnailKey: "thumbnails/file-1/versions/5/nonce-1.avif",
        thumbnailEtag: "etag-1",
      }),
    })
    expect(await thumbnailAuthority.authorize(
      new Request("https://workers.canvas.test"),
      "file-1",
      "read",
      undefined,
      "thumbnail",
    )).toEqual({
      userId: "user-a",
      revision: 5,
      thumbnail: {
        fileId: "file-1",
        revision: 5,
        key: "thumbnails/file-1/versions/5/nonce-1.avif",
        etag: "etag-1",
      },
    })

    const malformed = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async () => Response.json({ userId: "user-a", extra: true }),
    })
    expect(await malformed.authorize(new Request("https://workers.canvas.test"), "file-1", "read")).toBeNull()
    expect(() => createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "short",
    })).toThrow("at least 32 bytes")
    expect(() => createHostedFileAccessAuthority({
      apiOrigin: "http://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
    })).toThrow("HTTPS outside loopback")

    const redirectAuthority = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("manual")
        return new Response(null, {
          status: 307,
          headers: { Location: "https://evil.example/collect" },
        })
      },
    })
    await expect(redirectAuthority.authorize(
      new Request("https://workers.canvas.test", {
        headers: { Authorization: "Bearer desktop-session" },
      }),
      "file-1",
      "read",
    )).rejects.toThrow("redirects are not allowed")
  })

  it("FILE-ASSET-SEC-001 bounds chunked responses from every authority service before buffering", async () => {
    let cancellations = 0
    const oversized = async () => oversizedChunkedResponse(() => { cancellations += 1 })
    const fileAuthority = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: oversized,
    })
    const thumbnailAuthority = createHostedThumbnailServiceAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: oversized,
    })
    const commitResolver = createHostedThumbnailCommitResolver({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: oversized,
    })
    expect(await fileAuthority.authorize(
      new Request("https://workers.canvas.test"),
      "file-1",
      "read",
    )).toBeNull()
    expect(await thumbnailAuthority.authorize(new Request("https://workers.canvas.test", {
      headers: { "X-Canvas-Thumbnail-Service-Token": THUMBNAIL_SERVICE_TOKEN },
    }), "file-1", 1)).toBeNull()
    await expect(commitResolver.resolve("file-1"))
      .rejects.toThrow("response is invalid")
    expect(cancellations).toBe(3)
  })

  it("FILE-ASSET-001 uses an atomic R2 create-only condition for immutable assets", async () => {
    let condition: string | null = null
    const binding = {
      async get() {
        return null
      },
      async put(
        key: string,
        body: Uint8Array,
        options: { onlyIf: Headers; httpMetadata: { contentType: string } },
      ) {
        condition = options.onlyIf.get("if-none-match")
        return {
          key,
          size: body.byteLength,
          etag: "abc123",
          uploaded: new Date("2026-10-09T12:00:00.000Z"),
          httpMetadata: { contentType: options.httpMetadata.contentType },
        }
      },
    }
    const store = createR2BindingAssetStore({ binding })
    const result = await store.put("file-1/asset-1.png", PNG_BYTES, {
      contentType: "image/png",
      cacheControl: "private, max-age=31536000, immutable",
      metadata: { fileId: "file-1" },
      immutable: true,
    })
    expect(condition).toBe("*")
    expect(result).toMatchObject({
      key: "file-1/asset-1.png",
      size: PNG_BYTES.byteLength,
      contentType: "image/png",
    })
  })

  it("COMP-V2-CODE-004 quotes R2 ETags for atomic compare-and-swap writes", async () => {
    let condition: string | null = null
    const binding = {
      async get() {
        return null
      },
      async put(
        key: string,
        body: Uint8Array,
        options: { onlyIf: Headers; httpMetadata: { contentType: string } },
      ) {
        condition = options.onlyIf.get("if-match")
        return {
          key,
          size: body.byteLength,
          etag: "next-etag",
          uploaded: new Date("2026-10-09T12:00:00.000Z"),
          httpMetadata: { contentType: options.httpMetadata.contentType },
        }
      },
    }
    const store = createR2BindingAssetStore({ binding })
    await store.put("hosted-previews/artifact/state.json", PNG_BYTES, {
      contentType: "application/json",
      cacheControl: "private, no-store",
      metadata: { status: "published" },
      condition: { type: "match", etag: "abc123" },
    })
    expect(condition).toBe('"abc123"')
  })

  it("AT-THUMB-001 enforces the API head revision before thumbnail object mutation", async () => {
    let headRevision = 3
    const authority = createHostedFileAccessAuthority({
      apiOrigin: "https://api.canvas.test",
      serviceToken: "test-only-service-token-at-least-32-bytes",
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("x-canvas-service-token"))
          .toBe("test-only-service-token-at-least-32-bytes")
        const input = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(input).toMatchObject({
          fileId: "file-1",
          access: "write",
          resource: "thumbnail",
        })
        return input.expectedRevision === headRevision
          ? Response.json({ userId: "user-a", revision: headRevision })
          : Response.json({ error: "revision_conflict" }, { status: 409 })
      },
    })
    const store = new MemoryAssetStore()
    const service = new FileAssetService({
      store,
      signer: new UploadIntentSigner({
        secret: "test-only-secret-that-is-at-least-thirty-two-bytes",
        now: () => 1_800_000_000_000,
        nonce: () => "api-boundary-nonce",
      }),
      mediaDecoder: TEST_MEDIA_DECODER,
    })
    const handler = createFileAssetsHandler({
      service,
      accessAuthority: authority,
      thumbnailServiceAuthority: {
        async authorize(_request, _fileId, expectedRevision) {
          if (expectedRevision !== headRevision) {
            throw new FileAssetError("conflict", "File changed before upload", 409)
          }
          return { userId: "thumbnail-service", revision: headRevision }
        },
      },
      serviceToken: API_SERVICE_TOKEN,
      allowedOrigins: new Set(["https://app.canvas.test"]),
    })
    const authHeaders = {
      Authorization: "Bearer desktop-session",
      "Content-Type": "application/json",
      Origin: "https://app.canvas.test",
    }
    const intentResponse = await handler(new Request(
      "https://workers.canvas.test/file-assets/thumbnail-upload-intents",
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          fileId: "file-1",
          expectedRevision: 3,
          contentType: "image/avif",
          size: AVIF_BYTES.byteLength,
        }),
      },
    ))
    expect(intentResponse.status).toBe(201)
    const token = ((await intentResponse.json()) as { token: string }).token
    headRevision = 4
    const staleUpload = await handler(new Request(
      "https://workers.canvas.test/file-assets/thumbnail-uploads",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer desktop-session",
          "Content-Length": String(AVIF_BYTES.byteLength),
          "Content-Type": "image/avif",
          Origin: "https://app.canvas.test",
          "X-Canvas-Upload-Token": token,
        },
        body: AVIF_BYTES.buffer as ArrayBuffer,
      },
    ))
    expect(staleUpload.status).toBe(409)
    expect(materialThumbnailKeys(store)).toEqual([])
    const staleIntent = await handler(new Request(
      "https://workers.canvas.test/file-assets/thumbnail-upload-intents",
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          fileId: "file-1",
          expectedRevision: 3,
          contentType: "image/avif",
          size: AVIF_BYTES.byteLength,
        }),
      },
    ))
    expect(staleIntent.status).toBe(409)
    expect(materialThumbnailKeys(store)).toEqual([])
  })

  it("AT-THUMB-001 uses an atomic R2 create for immutable thumbnail versions", async () => {
    let condition: string | null = null
    const binding = {
      async get() {
        return null
      },
      async put(
        key: string,
        body: Uint8Array,
        options: { onlyIf: Headers; httpMetadata: { contentType: string } },
      ) {
        condition = options.onlyIf.get("if-none-match")
        return {
          key,
          size: body.byteLength,
          etag: "next-etag",
          uploaded: new Date("2026-10-09T12:00:00.000Z"),
          httpMetadata: { contentType: options.httpMetadata.contentType },
        }
      },
    }
    const store = createR2BindingAssetStore({ binding })
    await store.put("thumbnails/file-1/versions/3/nonce-1.avif", AVIF_BYTES, {
      contentType: "image/avif",
      cacheControl: "private, no-cache",
      metadata: { fileId: "file-1" },
      condition: { type: "create" },
    })
    expect(condition).toBe("*")
  })

  it("FILE-COPY-001 uses an atomic R2 destination create when copying immutable assets", async () => {
    const bytes = PNG_BYTES.slice()
    const conditions: Array<string | null> = []
    const writes = new Map<string, Uint8Array>([["file-1/source.png", bytes]])
    const binding = {
      async get(key: string) {
        const value = writes.get(key)
        return value
          ? {
              size: value.byteLength,
              httpMetadata: {
                contentType: "image/png",
                cacheControl: "private, max-age=31536000, immutable",
              },
              customMetadata: { fileId: "file-1" },
              async arrayBuffer() {
                return value.slice().buffer
              },
            }
          : null
      },
      async put(
        key: string,
        body: Uint8Array,
        options: { onlyIf: Headers; httpMetadata: { contentType: string } },
      ) {
        conditions.push(options.onlyIf.get("if-none-match"))
        if (writes.has(key)) return null
        writes.set(key, body.slice())
        return {
          key,
          size: body.byteLength,
          etag: `etag-${key}`,
          uploaded: new Date("2026-10-09T12:00:00.000Z"),
          httpMetadata: { contentType: options.httpMetadata.contentType },
        }
      },
    }
    const store = createR2BindingAssetStore({ binding })
    const copyOptions = {
      contentType: "image/png",
      cacheControl: "private, max-age=31536000, immutable",
      metadata: { fileId: "file-2", assetId: "copy" },
      immutable: true,
    }
    await store.copy("file-1/source.png", "file-2/copy.png", copyOptions)
    await expect(store.copy("file-1/source.png", "file-2/copy.png", copyOptions)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    })
    expect(conditions).toEqual(["*", "*"])
    expect(writes.get("file-2/copy.png")).toEqual(bytes)
  })

  it("FILE-ASSET-001 scopes upload and read to a canonical immutable key", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.grant("user-a", "file-1", "read")
    const bytes = PNG_BYTES

    const token = await createIntent(context, "file-1", "asset-1", bytes)
    const uploadResponse = await upload(context, token, bytes)
    expect(uploadResponse.status).toBe(201)
    const expectedAsset = {
      id: "asset-1",
      mime: "image/png",
      extension: "png",
      bytes: PNG_BYTES.byteLength,
      width: 2,
      height: 2,
      sha256: PNG_SHA256,
    }
    expect(await uploadResponse.json()).toEqual(expectedAsset)
    expect(materialAssetKeys(context.store)).toEqual(["file-1/asset-1.png"])
    expect(context.store.objects.get("file-1/asset-1.png")?.info.metadata).toEqual({
      kind: "image",
      fileId: "file-1",
      assetId: "asset-1",
      extension: "png",
      mime: "image/png",
      bytes: String(PNG_BYTES.byteLength),
      width: "2",
      height: "2",
      sha256: PNG_SHA256,
      uploadedBy: "user-a",
    })
    const initialEtag = context.store.objects.get("file-1/asset-1.png")?.info.etag

    const response = await context.handler(
      new Request(
        "https://workers.canvas.test/file-assets/file-1/asset-1.png",
        { headers: { Origin: "https://app.canvas.test", "X-User-Id": "user-a" } },
      ),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("x-canvas-asset-id")).toBe("asset-1")
    expect(response.headers.get("x-canvas-asset-mime")).toBe("image/png")
    expect(response.headers.get("x-canvas-asset-extension")).toBe("png")
    expect(response.headers.get("x-canvas-asset-bytes")).toBe(String(PNG_BYTES.byteLength))
    expect(response.headers.get("x-canvas-asset-width")).toBe("2")
    expect(response.headers.get("x-canvas-asset-height")).toBe("2")
    expect(response.headers.get("x-canvas-asset-sha256")).toBe(PNG_SHA256)
    expect(response.headers.get("access-control-expose-headers"))
      .toContain("X-Canvas-Asset-Sha256")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)

    const replay = await upload(context, token, bytes)
    expect(replay.status).toBe(409)
    expect(context.store.objects.get("file-1/asset-1.png")?.info.etag).toBe(initialEtag)

    const mismatchedReplay = await upload(context, token, distinctValidPng(bytes))
    expect(mismatchedReplay.status).toBe(409)
    expect(context.store.objects.get("file-1/asset-1.png")?.info.etag).toBe(initialEtag)
  })

  it("FILE-ASSET-LIFECYCLE-001 reconciles a lost upload response through authorized GET and HEAD", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.grant("user-a", "file-1", "read")
    const token = await createIntent(context, "file-1", "lost-response", PNG_BYTES)
    expect((await upload(context, token, PNG_BYTES)).status).toBe(201)

    const url = "https://workers.canvas.test/file-assets/file-1/lost-response.png"
    const getResponse = await context.handler(new Request(url, {
      headers: { Origin: "https://app.canvas.test", "X-User-Id": "user-a" },
      redirect: "manual",
    }))
    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get("location")).toBeNull()
    expect(getResponse.headers.get("x-canvas-asset-sha256")).toBe(PNG_SHA256)
    expect(getResponse.headers.get("x-canvas-asset-width")).toBe("2")
    expect(getResponse.headers.get("x-canvas-asset-height")).toBe("2")
    expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(PNG_BYTES)

    const headResponse = await context.handler(new Request(url, {
      method: "HEAD",
      headers: { Origin: "https://app.canvas.test", "X-User-Id": "user-a" },
      redirect: "manual",
    }))
    expect(headResponse.status).toBe(200)
    expect(headResponse.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength))
    expect(headResponse.headers.get("x-canvas-asset-sha256")).toBe(PNG_SHA256)
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0)
  })

  it("FILE-ASSET-SEC-001 derives canonical metadata from decoded bytes instead of forged headers", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    const token = await createIntent(context, "file-1", "forged-metadata", PNG_BYTES)
    const response = await context.handler(new Request(
      "https://workers.canvas.test/file-assets/uploads",
      {
        method: "PUT",
        headers: {
          "Content-Length": String(PNG_BYTES.byteLength),
          "Content-Type": "image/png",
          Origin: "https://app.canvas.test",
          "X-Canvas-Asset-Height": "9000",
          "X-Canvas-Asset-Sha256": "0".repeat(64),
          "X-Canvas-Asset-Width": "9000",
          "X-Canvas-Upload-Token": token,
          "X-User-Id": "user-a",
        },
        body: PNG_BYTES.buffer as ArrayBuffer,
      },
    ))

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      width: 2,
      height: 2,
      sha256: PNG_SHA256,
    })
    expect(context.store.objects.get("file-1/forged-metadata.png")?.info.metadata)
      .toMatchObject({ width: "2", height: "2", sha256: PNG_SHA256 })
  })

  it("FILE-ASSET-SEC-001 denies unauthorized and cross-file requests", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.grant("user-a", "file-1", "read")
    const bytes = PNG_BYTES
    const token = await createIntent(context, "file-1", "asset-1", bytes)
    expect((await upload(context, token, bytes)).status).toBe(201)

    const anonymous = await context.handler(
      jsonRequest("/file-assets/upload-intents", "anonymous", {
        fileId: "file-1",
        assetId: "other",
        extension: "png",
        contentType: "image/png",
        size: 3,
      }),
    )
    expect(anonymous.status).toBe(401)

    context.grant("user-b", "file-2", "read")
    const crossFile = await context.handler(
      new Request(
        "https://workers.canvas.test/file-assets/file-1/asset-1.png",
        { headers: { "X-User-Id": "user-b" } },
      ),
    )
    expect(crossFile.status).toBe(401)

    const wrongUserUpload = await upload(context, token, bytes, "user-b")
    expect(wrongUserUpload.status).toBe(401)

    const traversal = await context.handler(
      new Request(
        "https://workers.canvas.test/file-assets/file-1/%2e%2e%2fsecret.png",
        { headers: { "X-User-Id": "user-a" } },
      ),
    )
    expect(traversal.status).toBe(404)
  })

  it("FILE-ASSET-SEC-001 rejects mismatched media and declared sizes", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")

    const mismatched = await context.handler(
      jsonRequest("/file-assets/upload-intents", "user-a", {
        fileId: "file-1",
        assetId: "asset-1",
        extension: "png",
        contentType: "image/jpeg",
        size: 20,
      }),
    )
    expect(mismatched.status).toBe(415)

    const oversized = await context.handler(
      jsonRequest("/file-assets/upload-intents", "user-a", {
        fileId: "file-1",
        assetId: "asset-2",
        extension: "png",
        contentType: "image/png",
        size: MAX_ASSET_BYTES + 1,
      }),
    )
    expect(oversized.status).toBe(413)

    const bytes = PNG_BYTES
    const token = await createIntent(context, "file-1", "asset-3", bytes)
    const wrongLength = await context.handler(
      new Request("https://workers.canvas.test/file-assets/uploads", {
        method: "PUT",
        headers: {
          "Content-Length": "2",
          "Content-Type": "image/png",
          Origin: "https://app.canvas.test",
          "X-Canvas-Upload-Token": token,
          "X-User-Id": "user-a",
        },
        body: bytes.buffer as ArrayBuffer,
      }),
    )
    expect(wrongLength.status).toBe(413)
    expect(materialAssetKeys(context.store)).toEqual([])

    const forgedBytes = new Uint8Array([1, 2, 3])
    const forgedToken = await createIntent(
      context,
      "file-1",
      "asset-4",
      forgedBytes,
    )
    const forged = await upload(context, forgedToken, forgedBytes)
    expect(forged.status).toBe(415)
    expect(materialAssetKeys(context.store)).toEqual([])
  })

  it("FILE-ASSET-SEC-001 rejects a decoder result above the independent pixel budget", async () => {
    const context = createContext(undefined, {
      async decode() {
        return {
          width: 2,
          height: 2,
          pixelCount: MAX_DECODED_IMAGE_PIXELS + 1,
        }
      },
    })
    context.grant("user-a", "file-1", "write")
    const token = await createIntent(context, "file-1", "oversized-decoded-image", PNG_BYTES)
    expect((await upload(context, token, PNG_BYTES)).status).toBe(415)
    expect(materialAssetKeys(context.store)).toEqual([])
  })

  it("FILE-ASSET-SEC-001 rejects oversized PNG, GIF, and WebP dimensions before pixel decode", async () => {
    const store = new MemoryAssetStore()
    let decodeCalls = 0
    let nonce = 0
    const signer = new UploadIntentSigner({
      secret: "test-only-secret-that-is-at-least-thirty-two-bytes",
      now: () => 1_800_000_000_000,
      nonce: () => `oversized-dimension-nonce-${++nonce}`,
    })
    const service = new FileAssetService({
      store,
      signer,
      mediaDecoder: {
        async decode() {
          decodeCalls += 1
          return { width: 1, height: 1, pixelCount: 1 }
        },
      },
    })
    const actor = { userId: "user-a" }
    for (const [extension, contentType, bytes] of [
      ["png", "image/png", OVERSIZED_PNG],
      ["gif", "image/gif", OVERSIZED_GIF],
      ["webp", "image/webp", OVERSIZED_WEBP],
    ] as const) {
      const { claims } = await signer.issue(actor.userId, {
        fileId: "file-1",
        assetId: `oversized-${extension}`,
        extension,
        contentType,
        size: bytes.byteLength,
      })
      const reservation = await service.reserveUploadAttempt(actor, claims)
      await expect(service.upload(reservation, bytes, contentType, bytes.byteLength))
        .rejects.toMatchObject({ code: "unsupported_media_type", status: 415 })
    }
    expect(decodeCalls).toBe(0)
    expect(materialAssetKeys(store)).toEqual([])
  })

  it("FILE-ASSET-SEC-001 rejects ambient-cookie mutations without a trusted origin and unknown request fields", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    const payload = {
      fileId: "file-1",
      assetId: "asset-1",
      extension: "png",
      contentType: "image/png",
      size: PNG_BYTES.byteLength,
    }
    const noOrigin = await context.handler(
      new Request("https://workers.canvas.test/file-assets/upload-intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "session=ambient",
          "X-User-Id": "user-a",
        },
        body: JSON.stringify(payload),
      }),
    )
    expect(noOrigin.status).toBe(403)

    const unknownField = await context.handler(
      jsonRequest("/file-assets/upload-intents", "user-a", {
        ...payload,
        destination: "another-key",
      }),
    )
    expect(unknownField.status).toBe(400)

    const forgedMetadata = await context.handler(
      jsonRequest("/file-assets/upload-intents", "user-a", {
        ...payload,
        width: 9000,
        height: 9000,
        sha256: "0".repeat(64),
      }),
    )
    expect(forgedMetadata.status).toBe(400)
    expect(context.store.objects.size).toBe(0)
  })

  it("FILE-COPY-001 copies inside the storage service after both scope checks", async () => {
    const context = createContext()
    context.grant("user-a", "source-file", "write")
    context.grant("user-a", "source-file", "read")
    context.grant("user-a", "target-file", "write")
    context.grant("user-a", "target-file", "read")
    const bytes = PNG_BYTES
    const token = await createIntent(context, "source-file", "image", bytes)
    expect((await upload(context, token, bytes)).status).toBe(201)

    const response = await context.handler(
      jsonRequest("/file-assets/copies", "user-a", {
        source: {
          fileId: "source-file",
          assetId: "image",
          extension: "png",
        },
        target: {
          fileId: "target-file",
          assetId: "image-copy",
          extension: "png",
        },
      }),
    )
    expect(response.status).toBe(204)
    expect(context.store.copyCalls).toEqual([
      {
        from: "source-file/image.png",
        to: "target-file/image-copy.png",
      },
    ])
    expect(context.store.objects.get("target-file/image-copy.png")?.body).toEqual(bytes)
    expect(context.store.objects.get("target-file/image-copy.png")?.info.metadata).toMatchObject({
      kind: "image",
      fileId: "target-file",
      assetId: "image-copy",
      sha256: PNG_SHA256,
    })
  })

  it("AT-THUMB-001 resolves the stable URL only through committed immutable object identity", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.grant("user-a", "file-1", "read")
    context.setHead("file-1", 7)
    const bytes = AVIF_BYTES

    const token = await createThumbnailIntent(context, "file-1", bytes, 7)
    const putResponse = await uploadThumbnail(context, token, bytes)
    expect(putResponse.status).toBe(201)
    const uploaded = (await putResponse.json()) as AssetObjectInfo
    const objectKey = "thumbnails/file-1/versions/7/fixed-nonce-1.avif"
    expect(uploaded).toMatchObject({ key: objectKey, contentType: "image/avif" })
    expect([...context.store.objects.keys()].filter(key => (
      key.startsWith("thumbnail-claims/") || key.startsWith("thumbnails/")
    ))).toEqual([
      "thumbnail-claims/file-1/fixed-nonce-1",
      objectKey,
    ])
    expect(context.store.objects.get(objectKey)?.info.metadata)
      .toMatchObject({ fileId: "file-1", renderedBy: "thumbnail-service", revision: "7" })

    const stableUrl = "https://workers.canvas.test/file-assets/thumbnails/file-1/thumbnail.avif"
    const uncommitted = await context.handler(
      new Request(stableUrl, { headers: { "X-User-Id": "user-a" } }),
    )
    expect(uncommitted.status).toBe(404)
    context.commitThumbnail("file-1", 7, objectKey, uploaded.etag!)
    const getResponse = await context.handler(
      new Request(
        stableUrl,
        { headers: { "X-User-Id": "user-a" } },
      ),
    )
    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get("cache-control")).toBe("private, no-cache")
    expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(bytes)
    context.commitThumbnail("file-1", 7, objectKey, "wrong-etag")
    const mismatched = await context.handler(
      new Request(stableUrl, { headers: { "X-User-Id": "user-a" } }),
    )
    expect(mismatched.status).toBe(404)
  })

  it("AT-THUMB-001 rejects stale revision authorization before nonce or object mutation", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.setHead("file-1", 3)
    const staleToken = await createThumbnailIntent(context, "file-1", AVIF_BYTES, 3)
    context.setHead("file-1", 4)
    expect((await uploadThumbnail(context, staleToken, AVIF_BYTES)).status).toBe(409)
    expect(materialThumbnailKeys(context.store)).toEqual([])

    const staleIntent = await context.handler(thumbnailIntentRequest(
      "file-1",
      AVIF_BYTES.byteLength,
      3,
    ))
    expect(staleIntent.status).toBe(409)
    expect(materialThumbnailKeys(context.store)).toEqual([])

    const currentToken = await createThumbnailIntent(context, "file-1", AVIF_BYTES, 4)
    expect((await uploadThumbnail(context, currentToken, AVIF_BYTES)).status).toBe(201)
    const materialObjects = materialThumbnailKeys(context.store)
    expect((await uploadThumbnail(context, currentToken, AVIF_BYTES)).status).toBe(409)
    expect(materialThumbnailKeys(context.store)).toEqual(materialObjects)
  })

  it("AT-THUMB-001 requires a write grant and a valid intent before accepting thumbnail bytes", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.setHead("file-1", 0)
    const token = await createThumbnailIntent(context, "file-1", AVIF_BYTES, 0)
    expect((await uploadThumbnail(context, token, AVIF_BYTES, "user-b")).status).toBe(401)

    const direct = await context.handler(new Request(
      "https://workers.canvas.test/file-assets/thumbnails/file-1/thumbnail.avif",
      {
        method: "PUT",
        headers: {
          "Content-Length": String(AVIF_BYTES.byteLength),
          "Content-Type": "image/avif",
          Origin: "https://app.canvas.test",
          "X-User-Id": "user-a",
        },
        body: AVIF_BYTES.buffer as ArrayBuffer,
      },
    ))
    expect(direct.status).toBe(400)
    expect(materialThumbnailKeys(context.store)).toEqual([])
  })

  it("FILE-ASSET-001 rejects structurally truncated PNG and AVIF payloads before storage", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.setHead("file-1", 0)
    const png = PNG_BYTES.slice(0, -1)
    const pngToken = await createIntent(context, "file-1", "truncated", png)
    expect((await upload(context, pngToken, png)).status).toBe(415)

    const avif = AVIF_BYTES.slice(0, -1)
    const avifToken = await createThumbnailIntent(context, "file-1", avif, 0)
    expect((await uploadThumbnail(context, avifToken, avif)).status).toBe(415)
    expect(materialThumbnailKeys(context.store)).toEqual([])
  })

  it("AT-THUMB-001 rejects structurally valid AVIF dimensions beyond the capture limit", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.setHead("file-1", 0)
    const oversized = AVIF_BYTES.slice()
    const ispe = findAscii(oversized, "ispe")
    expect(ispe).toBeGreaterThan(0)
    oversized.set([0x00, 0x00, 0x08, 0x00], ispe + 8)
    const token = await createThumbnailIntent(context, "file-1", oversized, 0)
    expect((await uploadThumbnail(context, token, oversized)).status).toBe(415)
    expect(materialThumbnailKeys(context.store)).toEqual([])
  })
})

describe("trusted legacy image externalization", () => {
  const expectedAsset = Object.freeze({
    id: "legacy-image",
    mime: "image/png",
    extension: "png",
    bytes: 313,
    width: 2,
    height: 2,
    sha256: "ce7e567b6c50d6366a2f1aa0b9aa9a3debc253f67f07f2206ec481849197eb6d",
  })

  it("FILE-ASSET-001 externalizes validated raw image bytes to one canonical immutable object", async () => {
    const context = createLegacyContext()
    const response = await context.handler(legacyImageRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(await response.json()).toEqual({ asset: expectedAsset })
    expect(context.store.objects.get("file-1/legacy-image.png")).toMatchObject({
      body: PNG_BYTES,
      info: {
        key: "file-1/legacy-image.png",
        size: PNG_BYTES.byteLength,
        contentType: "image/png",
        metadata: {
          kind: "legacy-image",
          fileId: "file-1",
          assetId: "legacy-image",
          extension: "png",
          width: "2",
          height: "2",
          sha256: expectedAsset.sha256,
        },
      },
    })
  })

  it("CLOUD-SYNC-SCHEMA-001 makes exact retries and simultaneous races idempotent", async () => {
    const sequential = createLegacyContext()
    expect((await sequential.handler(legacyImageRequest())).status).toBe(200)
    const originalEtag = sequential.store.objects.get("file-1/legacy-image.png")?.info.etag
    const retry = await sequential.handler(legacyImageRequest())
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ asset: expectedAsset })
    expect(sequential.store.objects).toHaveLength(1)
    expect(sequential.store.objects.get("file-1/legacy-image.png")?.info.etag).toBe(originalEtag)

    const racing = createLegacyContext()
    const results = await Promise.all([
      racing.handler(legacyImageRequest({ assetId: "racing-image" })),
      racing.handler(legacyImageRequest({ assetId: "racing-image" })),
    ])
    expect(results.map(result => result.status)).toEqual([200, 200])
    expect(racing.store.objects).toHaveLength(1)
  })

  it("FILE-ASSET-SEC-001 rejects tampered bytes and declared metadata mismatches before storage", async () => {
    const reports: FileAssetErrorReport[] = []
    const context = createLegacyContext(report => reports.push(report))
    const tampered = PNG_BYTES.slice()
    tampered[tampered.byteLength - 1] = tampered[tampered.byteLength - 1]! ^ 1

    const tamperResponse = await context.handler(legacyImageRequest({
      bytes: tampered,
      assetId: "tampered",
    }))
    expect(tamperResponse.status).toBe(415)

    const dimensionsResponse = await context.handler(legacyImageRequest({
      assetId: "wrong-dimensions",
      width: "3",
    }))
    expect(dimensionsResponse.status).toBe(400)

    const typeResponse = await context.handler(legacyImageRequest({
      assetId: "wrong-type",
      contentType: "image/webp",
    }))
    expect(typeResponse.status).toBe(415)
    expect(typeResponse.headers.get("x-canvas-request-id")).toBe("11111111-1111-4111-8111-111111111111")
    expect(reports).toContainEqual(expect.objectContaining({
      requestId: "11111111-1111-4111-8111-111111111111",
      phase: "file_asset_request",
      code: "unsupported_media_type",
      status: 415,
    }))

    const invalidCorrelation = await context.handler(legacyImageRequest({
      assetId: "invalid-correlation",
      requestId: "bad request id",
      contentType: "image/webp",
    }))
    expect(invalidCorrelation.status).toBe(415)
    expect(invalidCorrelation.headers.get("x-canvas-request-id")).toBeNull()
    expect(reports.at(-1)).toMatchObject({ requestId: null, phase: "file_asset_request" })
    expect(context.store.objects).toHaveLength(0)
  })

  it("FILE-ASSET-SEC-001 treats any differing immutable object as a conflict", async () => {
    const context = createLegacyContext()
    await context.store.put("file-1/legacy-image.png", PNG_BYTES, {
      contentType: "image/png",
      cacheControl: "private, max-age=31536000, immutable",
      metadata: {
        kind: "legacy-image",
        fileId: "file-1",
        assetId: "legacy-image",
        extension: "png",
        width: "2",
        height: "2",
        sha256: "0".repeat(64),
      },
      condition: { type: "create" },
    })
    const before = context.store.objects.get("file-1/legacy-image.png")

    const response = await context.handler(legacyImageRequest())
    expect(response.status).toBe(409)
    expect(context.store.objects.get("file-1/legacy-image.png")).toEqual(before)

    const disguised = createLegacyContext()
    const differentBytes = PNG_BYTES.slice()
    differentBytes[32] = differentBytes[32]! ^ 1
    await disguised.store.put("file-1/legacy-image.png", differentBytes, {
      contentType: "image/png",
      cacheControl: "private, max-age=31536000, immutable",
      metadata: {
        kind: "legacy-image",
        fileId: "file-1",
        assetId: "legacy-image",
        extension: "png",
        width: "2",
        height: "2",
        sha256: expectedAsset.sha256,
      },
      condition: { type: "create" },
    })
    expect((await disguised.handler(legacyImageRequest())).status).toBe(409)
  })

  it("FILE-ASSET-SEC-001 requires the service token and refuses browser CORS access", async () => {
    const context = createLegacyContext()
    const wrongTokenRequest = legacyImageRequest({ token: "wrong" })
    const wrongToken = await context.handler(wrongTokenRequest)
    expect(wrongToken.status).toBe(401)
    expect(wrongToken.headers.get("access-control-allow-origin")).toBeNull()
    expect(wrongTokenRequest.bodyUsed).toBe(false)

    const browserRequest = legacyImageRequest({
      origin: "https://app.canvas.test",
    })
    const browser = await context.handler(browserRequest)
    expect(browser.status).toBe(403)
    expect(browser.headers.get("access-control-allow-origin")).toBeNull()
    expect(browserRequest.bodyUsed).toBe(false)
    expect(context.store.objects).toHaveLength(0)
  })

  it("FILE-ASSET-SEC-001 rechecks per-file write access before reading bytes", async () => {
    const context = createLegacyContext()
    const crossFile = legacyImageRequest({ fileId: "file-2" })
    const crossFileResponse = await context.handler(crossFile)
    expect(crossFileResponse.status).toBe(401)
    expect(crossFile.bodyUsed).toBe(false)

    const noCredential = legacyImageRequest({ userId: null })
    const noCredentialResponse = await context.handler(noCredential)
    expect(noCredentialResponse.status).toBe(401)
    expect(noCredential.bodyUsed).toBe(false)
    expect(context.store.objects).toHaveLength(0)
  })

  it("FILE-ASSET-SEC-001 rejects wrong verbs, redirect-like paths, invalid dimensions, and oversized declarations", async () => {
    const context = createLegacyContext()
    const wrongVerb = await context.handler(legacyImageRequest({ method: "GET" }))
    expect(wrongVerb.status).toBe(405)
    expect(wrongVerb.headers.get("allow")).toBe("PUT")
    expect(wrongVerb.headers.get("location")).toBeNull()

    const redirectLike = await context.handler(legacyImageRequest({
      path: "/internal/file-assets/legacy/file-1/legacy-image.png/",
    }))
    expect(redirectLike.status).toBe(404)
    expect(redirectLike.headers.get("location")).toBeNull()

    const invalidDimensions = await context.handler(legacyImageRequest({ width: "0" }))
    expect(invalidDimensions.status).toBe(400)

    const oversized = await context.handler(legacyImageRequest({
      contentLength: MAX_ASSET_BYTES + 1,
    }))
    expect(oversized.status).toBe(413)
    expect(context.store.objects).toHaveLength(0)
  })
})

function findAscii(bytes: Uint8Array, value: string): number {
  const expected = [...value].map(character => character.charCodeAt(0))
  for (let offset = 0; offset <= bytes.byteLength - expected.length; offset += 1) {
    if (expected.every((byte, index) => bytes[offset + index] === byte)) return offset
  }
  return -1
}

function distinctValidPng(source: Uint8Array): Uint8Array {
  const bytes = source.slice()
  let offset = 8
  while (offset + 12 <= bytes.byteLength) {
    const length = readU32(bytes, offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const dataEnd = dataOffset + length
    if (dataEnd + 4 > bytes.byteLength) break
    if (String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4)) === "tEXt" && length > 0) {
      bytes[dataEnd - 1] = bytes[dataEnd - 1]! ^ 1
      writeU32(bytes, dataEnd, fixtureCrc32(bytes, typeOffset, dataEnd))
      return bytes
    }
    offset = dataEnd + 4
  }
  throw new Error("PNG fixture has no mutable text chunk")
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  ) >>> 0
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24
  bytes[offset + 1] = value >>> 16
  bytes[offset + 2] = value >>> 8
  bytes[offset + 3] = value
}

function fixtureCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function materialThumbnailKeys(store: MemoryAssetStore): string[] {
  return [...store.objects.entries()]
    .filter(([key, value]) => (
      key.startsWith("thumbnails/") ||
      (key.startsWith("thumbnail-claims/") && value.info.metadata?.kind !== "asset-upload-claim")
    ))
    .map(([key]) => key)
}

function materialAssetKeys(store: MemoryAssetStore): string[] {
  return [...store.objects.keys()].filter(key => (
    !key.startsWith("thumbnail-claims/") &&
    !key.startsWith("thumbnail-quota/") &&
    !key.startsWith("thumbnails/")
  ))
}
