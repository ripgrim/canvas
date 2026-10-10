import { describe, expect, it } from "vitest"

import type {
  AssetDownload,
  AssetObjectInfo,
  AssetStore,
  AssetWriteOptions,
} from "../src/index.js"
import {
  FileAssetService,
  MAX_ASSET_BYTES,
  UploadIntentSigner,
} from "../src/index.js"
import {
  createFileAssetsHandler,
  createHostedFileAccessAuthority,
  type FileAccessAuthority,
} from "../src/worker.js"
import { createR2BindingAssetStore } from "../src/r2.js"

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
])
const AVIF_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
])

class MemoryAssetStore implements AssetStore {
  readonly objects = new Map<
    string,
    { body: Uint8Array; info: AssetObjectInfo }
  >()
  readonly copyCalls: Array<{ from: string; to: string }> = []

  async put(
    key: string,
    body: Uint8Array,
    options: AssetWriteOptions,
  ): Promise<AssetObjectInfo> {
    if (options.immutable && this.objects.has(key)) {
      throw new Error("immutable object already exists")
    }
    const info: AssetObjectInfo = {
      key,
      size: body.byteLength,
      contentType: options.contentType,
      etag: `etag-${key}`,
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
}

interface TestContext {
  store: MemoryAssetStore
  handler: (request: Request) => Promise<Response>
  grant(userId: string, fileId: string, access: "read" | "write"): void
}

function createContext(): TestContext {
  const store = new MemoryAssetStore()
  const grants = new Set<string>()
  const authority: FileAccessAuthority = {
    async authorize(request, fileId, access) {
      const userId = request.headers.get("x-user-id")
      return userId && grants.has(`${userId}:${fileId}:${access}`)
        ? { userId }
        : null
    },
  }
  const service = new FileAssetService({
    store,
    signer: new UploadIntentSigner({
      secret: "test-only-secret-that-is-at-least-thirty-two-bytes",
      now: () => 1_800_000_000_000,
      nonce: () => "fixed-nonce",
    }),
  })
  return {
    store,
    handler: createFileAssetsHandler({
      service,
      accessAuthority: authority,
      allowedOrigins: new Set(["https://app.canvas.test"]),
    }),
    grant(userId, fileId, access) {
      grants.add(`${userId}:${fileId}:${access}`)
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

describe("file assets Worker boundary", () => {
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
        },
      }),
      "file-1",
      "read",
    )
    expect(actor).toEqual({ userId: "user-a" })
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer desktop-session")
    expect(requests[0]?.headers.get("cookie")).toBeNull()

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
    expect([...context.store.objects.keys()]).toEqual(["file-1/asset-1.png"])

    const response = await context.handler(
      new Request(
        "https://workers.canvas.test/file-assets/file-1/asset-1.png",
        { headers: { "X-User-Id": "user-a" } },
      ),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)

    const replay = await upload(context, token, bytes)
    expect(replay.status).toBe(409)
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
    expect(context.store.objects.size).toBe(0)

    const forgedBytes = new Uint8Array([1, 2, 3])
    const forgedToken = await createIntent(
      context,
      "file-1",
      "asset-4",
      forgedBytes,
    )
    const forged = await upload(context, forgedToken, forgedBytes)
    expect(forged.status).toBe(415)
    expect(context.store.objects.size).toBe(0)
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
      fileId: "target-file",
      assetId: "image-copy",
      copiedBy: "user-a",
      copiedFrom: "source-file/image.png",
    })
  })

  it("FILE-THUMB-001 stores a pre-rendered AVIF at the stable thumbnail key", async () => {
    const context = createContext()
    context.grant("user-a", "file-1", "write")
    context.grant("user-a", "file-1", "read")
    const bytes = AVIF_BYTES

    const putResponse = await context.handler(
      new Request(
        "https://workers.canvas.test/file-assets/thumbnails/file-1",
        {
          method: "PUT",
          headers: {
            "Content-Length": String(bytes.byteLength),
            "Content-Type": "image/avif",
            Origin: "https://app.canvas.test",
            "X-User-Id": "user-a",
          },
          body: bytes.buffer as ArrayBuffer,
        },
      ),
    )
    expect(putResponse.status).toBe(200)
    expect([...context.store.objects.keys()]).toEqual([
      "thumbnails/file-1/thumbnail.avif",
    ])

    const getResponse = await context.handler(
      new Request(
        "https://workers.canvas.test/file-assets/thumbnails/file-1",
        { headers: { "X-User-Id": "user-a" } },
      ),
    )
    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get("cache-control")).toBe("private, no-cache")
    expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(bytes)
  })
})
