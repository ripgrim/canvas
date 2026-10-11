import { describe, expect, it } from "vitest"

import {
  createHttpThumbnailUploadPort,
  createThumbnailCapturePipeline,
  thumbnailObjectKey,
  thumbnailUrlPath,
  type ThumbnailMetadata,
} from "../src/index.js"

const FILE_ID = "11111111-2222-4333-8444-555555555555"
const AVIF = Uint8Array.from(atob("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAABAAAAAMAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGBV/vbAIMhMYAAAAUAAAAAoFeVJuQ9k6RgIo"), character => character.charCodeAt(0))
const OBJECT_KEY = thumbnailObjectKey(FILE_ID, 4, "nonce-1")

describe("thumbnail capture pipeline", () => {
  it("AT-THUMB-001 captures, uploads, then commits the stable key at the expected revision", async () => {
    const calls: string[] = []
    const pipeline = createThumbnailCapturePipeline({
      capture: {
        async capture(request) {
          calls.push(`capture:${request.expectedRevision}:${request.maxWidth}x${request.maxHeight}`)
          return AVIF
        },
      },
      upload: {
        async upload(request) {
          calls.push(`upload:${request.expectedRevision}:${request.bytes.byteLength}`)
          return { key: OBJECT_KEY, etag: "thumbnail-etag" }
        },
      },
      metadata: {
        async commit(input) {
          calls.push(`commit:${input.expectedRevision}:${input.thumbnailKey}`)
          return {
            fileId: input.fileId,
            revision: input.expectedRevision,
            thumbnailKey: input.thumbnailKey,
            thumbnailEtag: input.thumbnailEtag,
          }
        },
      },
    })
    expect(await pipeline.captureAndCommit({ fileId: FILE_ID, expectedRevision: 4 }))
      .toEqual({ fileId: FILE_ID, revision: 4, thumbnailKey: OBJECT_KEY, thumbnailEtag: "thumbnail-etag" })
    expect(calls).toEqual([
      "capture:4:1024x768",
      `upload:4:${AVIF.byteLength}`,
      `commit:4:${OBJECT_KEY}`,
    ])
  })

  it("AT-THUMB-001 preserves previous metadata when capture or upload fails", async () => {
    const previous: ThumbnailMetadata = {
      fileId: FILE_ID,
      revision: 2,
      thumbnailKey: thumbnailObjectKey(FILE_ID, 2, "previous"),
      thumbnailEtag: "previous-etag",
    }
    let current = previous
    let commits = 0
    const pipeline = createThumbnailCapturePipeline({
      capture: { async capture() { return AVIF } },
      upload: { async upload() { throw new Error("upload failed") } },
      metadata: {
        async commit(input) {
          commits += 1
          current = { fileId: input.fileId, revision: input.expectedRevision, thumbnailKey: input.thumbnailKey, thumbnailEtag: input.thumbnailEtag }
          return current
        },
      },
    })
    await expect(pipeline.captureAndCommit({ fileId: FILE_ID, expectedRevision: 3 }))
      .rejects.toThrow("upload failed")
    expect(commits).toBe(0)
    expect(current).toBe(previous)
  })

  it("AT-THUMB-001 leaves previous metadata intact when the revision commit rejects", async () => {
    const previous: ThumbnailMetadata = {
      fileId: FILE_ID,
      revision: 2,
      thumbnailKey: thumbnailObjectKey(FILE_ID, 2, "previous"),
      thumbnailEtag: "previous-etag",
    }
    const current = previous
    const pipeline = createThumbnailCapturePipeline({
      capture: { async capture() { return AVIF } },
      upload: { async upload() { return { key: thumbnailObjectKey(FILE_ID, 3, "next"), etag: "next-etag" } } },
      metadata: {
        async commit() {
          throw new Error("revision conflict")
        },
      },
    })
    await expect(pipeline.captureAndCommit({ fileId: FILE_ID, expectedRevision: 3 }))
      .rejects.toThrow("revision conflict")
    expect(current).toBe(previous)
  })

  it("AT-THUMB-001 rejects an unexpected upload key before metadata commit", async () => {
    let commits = 0
    const pipeline = createThumbnailCapturePipeline({
      capture: { async capture() { return AVIF } },
      upload: { async upload() { return { key: "other/key.avif", etag: "etag" } } },
      metadata: { async commit() { commits += 1; throw new Error("not reached") } },
    })
    await expect(pipeline.captureAndCommit({ fileId: FILE_ID, expectedRevision: 0 }))
      .rejects.toThrow("unexpected key")
    expect(commits).toBe(0)
  })

  it("FILE-ASSET-001 obtains a scoped intent before uploading AVIF bytes", async () => {
    const requests: Request[] = []
    const port = createHttpThumbnailUploadPort({
      assetsOrigin: "https://assets.canvas.test",
      headers: () => ({ Authorization: "Bearer desktop-session" }),
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (requests.length === 1) {
          return Response.json({
            method: "PUT",
            path: "/file-assets/thumbnail-uploads",
            token: "signed-intent",
            headers: {
              "Content-Length": String(AVIF.byteLength),
              "Content-Type": "image/avif",
              "X-Canvas-Upload-Token": "signed-intent",
            },
            expiresAt: "2026-10-09T23:00:00.000Z",
          }, { status: 201 })
        }
        return Response.json({ key: thumbnailObjectKey(FILE_ID, 9, "upload-1"), etag: "etag-1" }, { status: 201 })
      },
    })
    expect(await port.upload({
      fileId: FILE_ID,
      expectedRevision: 9,
      contentType: "image/avif",
      bytes: AVIF,
    })).toEqual({ key: thumbnailObjectKey(FILE_ID, 9, "upload-1"), etag: "etag-1" })
    expect(requests.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "POST /file-assets/thumbnail-upload-intents",
      "PUT /file-assets/thumbnail-uploads",
    ])
    expect(requests[1]?.headers.get("x-canvas-upload-token")).toBe("signed-intent")
    expect(new Uint8Array(await requests[1]!.arrayBuffer())).toEqual(AVIF)
    expect(requests.every(request => request.redirect === "manual")).toBe(true)
    expect(thumbnailUrlPath(FILE_ID)).toBe(`/file-assets/thumbnails/${FILE_ID}/thumbnail.avif`)
  })

  it("FILE-ASSET-SEC-001 rejects insecure remote asset origins and redirects", async () => {
    expect(() => createHttpThumbnailUploadPort({
      assetsOrigin: "http://assets.canvas.test",
    })).toThrow("HTTPS outside loopback")
    const port = createHttpThumbnailUploadPort({
      assetsOrigin: "https://assets.canvas.test",
      headers: () => ({ Authorization: "Bearer desktop-session" }),
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("manual")
        return new Response(null, { status: 307, headers: { Location: "https://evil.example" } })
      },
    })
    await expect(port.upload({
      fileId: FILE_ID,
      expectedRevision: 4,
      contentType: "image/avif",
      bytes: AVIF,
    })).rejects.toThrow("redirects are not allowed")
  })
})
