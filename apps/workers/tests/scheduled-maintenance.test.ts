import type { AssetDownload, AssetListRequest, AssetObjectInfo, AssetStore, AssetWriteOptions } from "@canvas/files"
import { ThumbnailGarbageCollector } from "@canvas/files"
import { describe, expect, it } from "vitest"

import { runScheduledThumbnailGarbageCollection } from "../src/scheduled-maintenance.js"

const NOW = Date.UTC(2026, 9, 9, 12)
const DAY = 24 * 60 * 60 * 1_000

class ScheduledStore implements AssetStore {
  readonly objects = new Map<string, Readonly<{ info: AssetObjectInfo; body: Uint8Array }>>()
  #version = 0

  async put(key: string, body: Uint8Array, options: AssetWriteOptions): Promise<AssetObjectInfo> {
    this.#version += 1
    const info = Object.freeze({ key, size: body.byteLength, contentType: options.contentType, etag: `etag-${this.#version}`, lastModified: new Date(NOW), metadata: options.metadata })
    this.objects.set(key, Object.freeze({ info, body: body.slice() }))
    return info
  }
  async download(key: string): Promise<AssetDownload | null> {
    const value = this.objects.get(key)
    if (!value) return null
    return {
      info: value.info,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value.body.slice())
          controller.close()
        },
      }),
    }
  }
  async head(key: string): Promise<AssetObjectInfo | null> { return this.objects.get(key)?.info ?? null }
  async copy(): Promise<void> { throw new Error("not used") }
  async list(input: AssetListRequest) {
    const candidates = [...this.objects.values()].map(value => value.info)
      .filter(object => object.key.startsWith(input.prefix))
      .filter(object => !input.cursor || object.key > input.cursor)
      .sort((left, right) => left.key.localeCompare(right.key))
    const objects = candidates.slice(0, input.limit)
    return { objects, ...(candidates.length > objects.length && objects.length ? { cursor: objects.at(-1)!.key } : {}) }
  }
  async delete(key: string): Promise<boolean> { return this.objects.delete(key) }
  seed(info: AssetObjectInfo): void { this.objects.set(info.key, Object.freeze({ info, body: new Uint8Array() })) }
}

describe("scheduled thumbnail maintenance", () => {
  it("AT-THUMB-001 persists the cursor so a later cron reaches objects beyond twelve pages", async () => {
    const store = new ScheduledStore()
    for (let index = 0; index < 1_200; index += 1) {
      const key = `thumbnails/file-a/versions/1/protected-${String(index).padStart(4, "0")}.avif`
      store.seed({ key, size: 1, contentType: "image/avif", etag: `protected-${index}`, lastModified: new Date(NOW - 2 * DAY), metadata: { fileId: "../file-a", revision: "1" } })
    }
    const expired = "thumbnails/file-z/versions/1/z-expired.avif"
    store.seed({ key: expired, size: 1, contentType: "image/avif", etag: "expired", lastModified: new Date(NOW - 2 * DAY), metadata: { fileId: "file-z", revision: "1" } })
    const collector = new ThumbnailGarbageCollector({
      store,
      committed: { async resolve() { return null } },
      now: () => NOW,
      uncommittedGraceMs: DAY,
      supersededRetentionMs: 0,
      scanLimit: 100,
      deleteLimit: 100,
    })

    await runScheduledThumbnailGarbageCollection({ store, collector, maxPages: 12 })
    expect(store.objects.has(expired)).toBe(true)
    expect(store.objects.has("thumbnail-maintenance/garbage-collection.json")).toBe(true)
    await runScheduledThumbnailGarbageCollection({ store, collector, maxPages: 12 })
    expect(store.objects.has(expired)).toBe(false)
    expect(store.objects.has("thumbnail-maintenance/garbage-collection.json")).toBe(false)
  })

  it("FILE-ASSET-SEC-001 fails closed on a malformed durable checkpoint", async () => {
    const store = new ScheduledStore()
    await store.put("thumbnail-maintenance/garbage-collection.json", new TextEncoder().encode('{"phase":"versions","cursor":4}'), { contentType: "application/json", cacheControl: "no-store", metadata: {} })
    await expect(runScheduledThumbnailGarbageCollection({ store, collector: { async collect() { throw new Error("must not collect") } } })).rejects.toThrow("checkpoint is invalid")
  })
})
