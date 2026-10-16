import { describe, expect, it } from "vitest"

import { publishHostedPreviewArtifact } from "@canvas/preview-runtime/hosted-artifact"
import type {
  HostedPreviewArtifactExpectation,
  HostedPreviewArtifactManifest,
} from "@canvas/preview-runtime/hosted-artifact"

import type {
  AssetDownload,
  AssetListRequest,
  AssetObjectInfo,
  AssetStore,
  AssetWriteOptions,
} from "../src/contracts.js"
import { FileAssetError } from "../src/contracts.js"
import { createHostedPreviewArtifactAssetStorage } from "../src/hosted-preview.js"

const artifactId = "00000000-0000-4000-8000-000000000101"
const stagingId = "00000000-0000-4000-8000-000000000201"
const secondStagingId = "00000000-0000-4000-8000-000000000202"
const sourceRevision = "a".repeat(40)
const registryFingerprint = `sha256:${"b".repeat(64)}`
const manifest: HostedPreviewArtifactManifest = Object.freeze({
  version: 1,
  sourceRevision,
  registryFingerprint,
  entrypoint: "index.html",
  files: Object.freeze([
    Object.freeze({ path: "index.html", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", bytes: 5, contentType: "text/html; charset=utf-8" as const }),
    Object.freeze({ path: "assets/components.js", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", bytes: 0, contentType: "text/javascript; charset=utf-8" as const }),
  ]),
  components: Object.freeze([
    Object.freeze({ componentId: "shadcn:Button:1234567890abcdef", modulePath: "assets/components.js", exportName: "Button" }),
  ]),
})
const expectation: HostedPreviewArtifactExpectation = Object.freeze({
  sourceRevision,
  registryFingerprint,
  components: Object.freeze([Object.freeze({ componentId: "shadcn:Button:1234567890abcdef", exportName: "Button" })]),
})
const artifactFiles = () => new Map([
  ["index.html", new TextEncoder().encode("hello")],
  ["assets/components.js", new Uint8Array()],
])

class MemoryStore implements AssetStore {
  readonly objects = new Map<string, { body: Uint8Array; info: AssetObjectInfo }>()
  beforePut?: (key: string, options: AssetWriteOptions) => void | Promise<void>
  afterPut?: (key: string, options: AssetWriteOptions) => void | Promise<void>
  downloadFailures = 0
  #version = 0

  async put(key: string, body: Uint8Array, options: AssetWriteOptions): Promise<AssetObjectInfo> {
    await this.beforePut?.(key, options)
    const current = this.objects.get(key)
    const condition = options.condition ?? (options.immutable ? { type: "create" as const } : undefined)
    if (condition?.type === "create" && current || condition?.type === "match" && current?.info.etag !== condition.etag) {
      throw new FileAssetError("conflict", "Asset changed before upload", 409)
    }
    this.#version += 1
    const info: AssetObjectInfo = {
      key,
      size: body.byteLength,
      contentType: options.contentType,
      etag: `etag-${this.#version}`,
      metadata: { ...options.metadata },
    }
    this.objects.set(key, { body: body.slice(), info })
    await this.afterPut?.(key, options)
    return info
  }

  async download(key: string): Promise<AssetDownload | null> {
    if (this.downloadFailures > 0) {
      this.downloadFailures -= 1
      throw new Error("store read unavailable")
    }
    const stored = this.objects.get(key)
    if (!stored) return null
    const body = stored.body.slice()
    return {
      info: { ...stored.info, ...(stored.info.metadata ? { metadata: { ...stored.info.metadata } } : {}) },
      body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close() } }),
    }
  }

  async head(key: string): Promise<AssetObjectInfo | null> {
    return this.objects.get(key)?.info ?? null
  }

  async copy(from: string, to: string, options: AssetWriteOptions): Promise<void> {
    const source = this.objects.get(from)
    if (!source) throw new Error("Source missing")
    await this.put(to, source.body, { ...options, condition: { type: "create" } })
  }

  async list(input: AssetListRequest) {
    return { objects: [...this.objects.values()].map(item => item.info).filter(info => info.key.startsWith(input.prefix)).slice(0, input.limit) }
  }

  async delete(key: string): Promise<boolean> {
    return this.objects.delete(key)
  }
}

describe("hosted preview artifact asset storage", () => {
  it("COMP-V2-CODE-004 publishes and reads one exact immutable file", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    await publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: artifactFiles() }, storage)

    const published = await storage.readPublishedFile(artifactId, "index.html")
    expect(published?.file).toEqual(manifest.files[0])
    expect(await bytes(published!.download.body)).toEqual(new TextEncoder().encode("hello"))
    expect(await storage.readPublishedFile(artifactId, "missing.js")).toBeNull()
    expect([...store.objects.keys()].sort()).toEqual([
      `hosted-previews/${artifactId}/staging/${stagingId}/assets/components.js`,
      `hosted-previews/${artifactId}/staging/${stagingId}/index.html`,
      `hosted-previews/${artifactId}/state.json`,
    ])
  })

  it("COMP-V2-CODE-004 atomically discards a private attempt and prevents later publication", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const receipt = Object.freeze({ artifactId, stagingId })
    await storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })
    expect(await storage.status(receipt)).toBe("staged")
    await storage.discard(receipt)
    expect(await storage.status(receipt)).toBe("missing")
    expect(await storage.readPublishedFile(artifactId, "index.html")).toBeNull()
    expect([...store.objects.keys()]).toEqual([`hosted-previews/${artifactId}/state.json`])
    await expect(storage.publish(receipt)).rejects.toThrow("missing")
  })

  it("COMP-V2-CODE-004 never deletes an artifact after publication wins", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const receipt = Object.freeze({ artifactId, stagingId })
    await storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })
    await storage.publish(receipt)
    await storage.discard(receipt)
    expect(await storage.status(receipt)).toBe("published")
    expect(await storage.readPublishedFile(artifactId, "index.html")).not.toBeNull()
  })

  it("COMP-V2-CODE-004 reconciles a committed state write whose acknowledgement is lost", async () => {
    const store = new MemoryStore()
    let loseStageAck = true
    store.afterPut = (key, options) => {
      if (loseStageAck && key.endsWith("/state.json") && options.metadata.status === "staged") {
        loseStageAck = false
        throw new Error("stage acknowledgement lost")
      }
    }
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const receipt = Object.freeze({ artifactId, stagingId })
    await storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })

    let losePublishAck = true
    store.afterPut = (key, options) => {
      if (losePublishAck && key.endsWith("/state.json") && options.metadata.status === "published") {
        losePublishAck = false
        throw new Error("publish acknowledgement lost")
      }
    }
    await expect(storage.publish(receipt)).resolves.toBeUndefined()
    expect(await storage.status(receipt)).toBe("published")
  })

  it("COMP-V2-CODE-004 lets the publisher reconcile an ambiguous staging result with its persisted receipt", async () => {
    const store = new MemoryStore()
    let loseStageAck = true
    store.afterPut = (key, options) => {
      if (loseStageAck && key.endsWith("/state.json") && options.metadata.status === "staged") {
        loseStageAck = false
        store.downloadFailures = 1
        throw new Error("stage acknowledgement lost")
      }
    }
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: artifactFiles() }, storage)).resolves.toMatchObject({ artifactId })
    expect(await storage.status({ artifactId, stagingId })).toBe("published")
  })

  it("COMP-V2-CODE-004 retries the same private staging identity and verifies existing bytes", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    await storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })
    await expect(storage.stage({ artifactId, stagingId, manifest: { ...manifest, sourceRevision: "c".repeat(40) }, files: artifactFiles() })).rejects.toThrow("already exists")
    const indexKey = `hosted-previews/${artifactId}/staging/${stagingId}/index.html`
    store.objects.get(indexKey)!.body.fill(0)
    await expect(storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })).rejects.toThrow("invalid")
    store.objects.get(indexKey)!.body = new TextEncoder().encode("hello")

    store.objects.delete(`hosted-previews/${artifactId}/state.json`)
    await expect(storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })).resolves.toBeUndefined()

    store.objects.delete(`hosted-previews/${artifactId}/state.json`)
    store.objects.get(indexKey)!.body.fill(0)
    await expect(storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })).rejects.toThrow("invalid")
  })

  it("COMP-V2-CODE-004 preserves a concurrent retry's verified bytes when the observer later fails", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const indexKey = `hosted-previews/${artifactId}/staging/${stagingId}/index.html`
    const scriptKey = `hosted-previews/${artifactId}/staging/${stagingId}/assets/components.js`
    await store.put(indexKey, new TextEncoder().encode("hello"), {
      contentType: manifest.files[0]!.contentType,
      cacheControl: "private, no-store",
      metadata: { artifactId, stagingId, path: manifest.files[0]!.path, sha256: manifest.files[0]!.sha256 },
      condition: { type: "create" },
    })
    store.beforePut = key => {
      if (key === scriptKey) throw new Error("second file rejected")
    }

    await expect(storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() }))
      .rejects.toThrow("needs reconciliation")
    expect(store.objects.has(indexKey)).toBe(true)
    expect(store.objects.has(scriptKey)).toBe(false)
  })

  it("COMP-V2-CODE-004 marks a lost file acknowledgement with an unreadable result for reconciliation", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const indexKey = `hosted-previews/${artifactId}/staging/${stagingId}/index.html`
    let loseFileAck = true
    store.afterPut = key => {
      if (loseFileAck && key === indexKey) {
        loseFileAck = false
        store.downloadFailures = 1
        throw new Error("file acknowledgement lost")
      }
    }

    await expect(storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() }))
      .rejects.toThrow("needs reconciliation")
    expect(store.objects.has(indexKey)).toBe(true)
    delete store.afterPut
    await expect(storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })).resolves.toBeUndefined()
    await expect(storage.publish({ artifactId, stagingId })).resolves.toBeUndefined()
  })

  it("COMP-V2-CODE-004 never lets a same-receipt loser delete bytes already published by the winner", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const indexKey = `hosted-previews/${artifactId}/staging/${stagingId}/index.html`
    let releaseFirstPut!: () => void
    const firstPutReleased = new Promise<void>(resolve => { releaseFirstPut = resolve })
    let firstPutPaused!: () => void
    const firstPutDidPause = new Promise<void>(resolve => { firstPutPaused = resolve })
    let pauseOnce = true
    store.afterPut = async key => {
      if (pauseOnce && key === indexKey) {
        pauseOnce = false
        firstPutPaused()
        await firstPutReleased
      }
    }

    const loser = storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })
    await firstPutDidPause
    await storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })
    await storage.publish({ artifactId, stagingId })
    releaseFirstPut()
    await expect(loser).resolves.toBeUndefined()

    expect(await storage.status({ artifactId, stagingId })).toBe("published")
    expect(await storage.readPublishedFile(artifactId, "index.html")).not.toBeNull()
    expect(store.objects.has(indexKey)).toBe(true)
  })

  it("COMP-V2-CODE-004 rejects a concurrent different manifest that reuses the same receipt", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const indexKey = `hosted-previews/${artifactId}/staging/${stagingId}/index.html`
    const otherManifest = { ...manifest, sourceRevision: "c".repeat(40) }
    let releaseFirstPut!: () => void
    const firstPutReleased = new Promise<void>(resolve => { releaseFirstPut = resolve })
    let firstPutPaused!: () => void
    const firstPutDidPause = new Promise<void>(resolve => { firstPutPaused = resolve })
    let pauseOnce = true
    store.afterPut = async key => {
      if (pauseOnce && key === indexKey) {
        pauseOnce = false
        firstPutPaused()
        await firstPutReleased
      }
    }

    const loser = storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })
    await firstPutDidPause
    await storage.stage({ artifactId, stagingId, manifest: otherManifest, files: artifactFiles() })
    releaseFirstPut()
    await expect(loser).rejects.toThrow("identity already exists")
    await storage.publish({ artifactId, stagingId })
    expect(await storage.status({ artifactId, stagingId })).toBe("published")
    expect(await storage.readPublishedFile(artifactId, "index.html")).not.toBeNull()
  })

  it("COMP-V2-CODE-004 cleans a losing stage without disturbing the published artifact", async () => {
    const store = new MemoryStore()
    const first = createHostedPreviewArtifactAssetStorage({ store })
    await publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: artifactFiles() }, first)
    const second = createHostedPreviewArtifactAssetStorage({ store })
    await expect(second.stage({ artifactId, stagingId: secondStagingId, manifest, files: artifactFiles() })).rejects.toThrow("already exists")
    expect([...store.objects.keys()].some(key => key.includes(secondStagingId))).toBe(false)
    expect(await first.readPublishedFile(artifactId, "index.html")).not.toBeNull()
  })

  it("COMP-V2-CODE-004 leaves either a complete publication or a complete discard under a race", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    const receipt = Object.freeze({ artifactId, stagingId })
    await storage.stage({ artifactId, stagingId, manifest, files: artifactFiles() })
    await Promise.allSettled([storage.publish(receipt), storage.discard(receipt)])
    const status = await storage.status(receipt)
    const published = await storage.readPublishedFile(artifactId, "index.html")
    expect(status === "published" ? published !== null : published === null).toBe(true)
    expect(status === "published" || status === "missing").toBe(true)
  })

  it("COMP-V2-CODE-004 refuses corrupted published metadata", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    await publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: artifactFiles() }, storage)
    const key = `hosted-previews/${artifactId}/staging/${stagingId}/index.html`
    store.objects.get(key)!.info = { ...store.objects.get(key)!.info, contentType: "text/css; charset=utf-8" }
    await expect(storage.readPublishedFile(artifactId, "index.html")).rejects.toThrow("invalid")
  })

  it("COMP-V2-CODE-004 refuses corrupted published bytes even when metadata still matches", async () => {
    const store = new MemoryStore()
    const storage = createHostedPreviewArtifactAssetStorage({ store })
    await publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: artifactFiles() }, storage)
    const key = `hosted-previews/${artifactId}/staging/${stagingId}/index.html`
    store.objects.get(key)!.body.fill(0)
    await expect(storage.readPublishedFile(artifactId, "index.html")).rejects.toThrow("invalid")
  })
})

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.byteLength
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
