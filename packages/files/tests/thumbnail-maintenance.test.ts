import { describe, expect, it } from "vitest"

import type {
  AssetDownload,
  AssetListRequest,
  AssetObjectInfo,
  AssetStore,
  AssetWriteOptions,
} from "../src/contracts.js"
import { FileAssetError } from "../src/contracts.js"
import { ThumbnailGarbageCollector } from "../src/maintenance.js"
import { StoreBackedThumbnailUploadQuota } from "../src/quota.js"

const NOW = Date.UTC(2026, 9, 9, 12)
const DAY = 24 * 60 * 60 * 1_000

class MaintenanceStore implements AssetStore {
  readonly objects = new Map<string, AssetObjectInfo>()
  #version = 0

  async put(key: string, body: Uint8Array, options: AssetWriteOptions): Promise<AssetObjectInfo> {
    if ((options.condition?.type === "create" || options.immutable) && this.objects.has(key)) {
      throw new FileAssetError("conflict", "already exists", 409)
    }
    this.#version += 1
    const info = {
      key,
      size: body.byteLength,
      contentType: options.contentType,
      etag: `etag-${this.#version}`,
      lastModified: new Date(NOW),
      metadata: options.metadata,
    }
    this.objects.set(key, info)
    return info
  }

  async download(): Promise<AssetDownload | null> { return null }
  async head(key: string): Promise<AssetObjectInfo | null> { return this.objects.get(key) ?? null }
  async copy(): Promise<void> { throw new Error("not used") }
  async list(input: AssetListRequest) {
    const candidates = [...this.objects.values()]
      .filter(object => object.key.startsWith(input.prefix))
      .filter(object => !input.cursor || object.key > input.cursor)
      .sort((left, right) => left.key.localeCompare(right.key))
    const objects = candidates.slice(0, input.limit)
    return {
      objects,
      ...(candidates.length > objects.length && objects.length > 0
        ? { cursor: objects.at(-1)!.key }
        : {}),
    }
  }
  async delete(key: string): Promise<boolean> {
    const current = this.objects.get(key)
    if (!current) return false
    return this.objects.delete(key)
  }

  seed(info: AssetObjectInfo): void { this.objects.set(info.key, info) }
}

async function runCollector(collector: ThumbnailGarbageCollector) {
  const total = { scanned: 0, deleted: 0, protected: 0, deferred: 0 }
  let continuation: Awaited<ReturnType<ThumbnailGarbageCollector["collect"]>>["continuation"] = null
  for (let page = 0; page < 100; page += 1) {
    const result = await collector.collect(continuation ?? undefined)
    total.scanned += result.scanned
    total.deleted += result.deleted
    total.protected += result.protected
    total.deferred += result.deferred
    if (!result.continuation) return total
    continuation = result.continuation
  }
  throw new Error("collector did not finish within the test page bound")
}

describe("thumbnail storage maintenance", () => {
  it("AT-THUMB-001 enforces hard per-user and per-file quota slots", async () => {
    const store = new MaintenanceStore()
    const quota = new StoreBackedThumbnailUploadQuota({
      store,
      now: () => NOW,
      windowMs: 60_000,
      uploadsPerUser: 2,
      uploadsPerFile: 2,
    })
    await quota.acquire({ subject: "user-a", fileId: "file-a", nonce: "nonce-1", operation: "upload" })
    await quota.acquire({ subject: "user-a", fileId: "file-a", nonce: "nonce-2", operation: "upload" })
    await expect(quota.acquire({ subject: "user-a", fileId: "file-b", nonce: "nonce-3", operation: "upload" }))
      .rejects.toMatchObject({ code: "too_many_requests", status: 429 })
    const userMarkers = [...store.objects.values()].filter(object => object.metadata?.kind === "user")
    expect(userMarkers).toHaveLength(2)
  })

  it("AT-THUMB-001 deletes old uncommitted and superseded versions but protects current and recent ones", async () => {
    const store = new MaintenanceStore()
    const object = (
      key: string,
      revision: number,
      age: number,
      etag: string,
    ): AssetObjectInfo => ({
      key,
      size: 10,
      contentType: "image/avif",
      etag,
      lastModified: new Date(NOW - age),
      metadata: { fileId: "file-a", revision: String(revision) },
    })
    const currentKey = "thumbnails/file-a/versions/5/current.avif"
    const recentKey = "thumbnails/file-a/versions/6/recent.avif"
    const oldUncommittedKey = "thumbnails/file-a/versions/5/abandoned.avif"
    const supersededKey = "thumbnails/file-a/versions/4/old.avif"
    store.seed(object(currentKey, 5, 30 * DAY, "current-etag"))
    store.seed(object(recentKey, 6, 60_000, "recent-etag"))
    store.seed(object(oldUncommittedKey, 5, 2 * DAY, "abandoned-etag"))
    store.seed(object(supersededKey, 4, 8 * DAY, "old-etag"))
    store.seed({
      key: "thumbnails/file-a/versions/1/malformed-metadata.avif",
      size: 10,
      contentType: "image/avif",
      etag: "malformed-etag",
      lastModified: new Date(NOW - 30 * DAY),
      metadata: { fileId: "../file-a", revision: "1" },
    })
    store.seed({
      key: "thumbnail-claims/file-a/old-claim",
      size: 1,
      contentType: "application/octet-stream",
      etag: "claim-etag",
      lastModified: new Date(NOW - 8 * DAY),
    })
    store.seed({
      key: "thumbnail-quota/1/hash/0",
      size: 1,
      contentType: "application/octet-stream",
      etag: "quota-etag",
      lastModified: new Date(NOW - DAY),
      metadata: { expiresAt: String(NOW - 1) },
    })
    const collector = new ThumbnailGarbageCollector({
      store,
      committed: {
        async resolve(fileId) {
          return fileId === "file-a"
            ? { fileId, revision: 5, key: currentKey, etag: "current-etag" }
            : null
        },
      },
      now: () => NOW,
      uncommittedGraceMs: DAY,
      supersededRetentionMs: 7 * DAY,
      markerRetentionMs: 7 * DAY,
    })
    const result = await runCollector(collector)
    expect(result).toMatchObject({ deleted: 4, protected: 2, deferred: 1 })
    expect([...store.objects.keys()].sort()).toEqual([
      currentKey,
      recentKey,
      "thumbnails/file-a/versions/1/malformed-metadata.avif",
    ].sort())
  })

  it("AT-THUMB-001 fails closed when immutable-object listing omits an ETag", async () => {
    const store = new MaintenanceStore()
    const key = "thumbnails/file-a/versions/1/raced.avif"
    store.seed({
      key,
      size: 10,
      contentType: "image/avif",
      lastModified: new Date(NOW - 2 * DAY),
      metadata: { fileId: "file-a", revision: "1" },
    })
    const collector = new ThumbnailGarbageCollector({
      store,
      committed: { async resolve() { return null } },
      now: () => NOW,
      uncommittedGraceMs: DAY,
    })
    expect((await runCollector(collector)).deleted).toBe(0)
    expect(store.objects.has(key)).toBe(true)
  })

  it("AT-THUMB-001 follows version continuations until a later eligible object is reached", async () => {
    const store = new MaintenanceStore()
    const currentKey = "thumbnails/file-a/versions/1/a-current.avif"
    const abandonedKey = "thumbnails/file-a/versions/1/z-abandoned.avif"
    for (const [key, etag] of [[currentKey, "current"], [abandonedKey, "abandoned"]] as const) {
      store.seed({
        key,
        size: 10,
        contentType: "image/avif",
        etag,
        lastModified: new Date(NOW - 2 * DAY),
        metadata: { fileId: "file-a", revision: "1" },
      })
    }
    const collector = new ThumbnailGarbageCollector({
      store,
      committed: {
        async resolve(fileId) {
          return { fileId, revision: 1, key: currentKey, etag: "current" }
        },
      },
      now: () => NOW,
      uncommittedGraceMs: DAY,
      scanLimit: 1,
      deleteLimit: 1,
    })
    const result = await runCollector(collector)
    expect(result).toMatchObject({ deleted: 1, protected: 1 })
    expect([...store.objects.keys()]).toEqual([currentKey])
  })
})
