import type {
  AssetDownload,
  AssetStore,
  ThumbnailGarbageCollectionContinuation,
  ThumbnailGarbageCollector,
} from "@canvas/files"

const CHECKPOINT_KEY = "thumbnail-maintenance/garbage-collection.json"
const CHECKPOINT_LIMIT = 1_024

export async function runScheduledThumbnailGarbageCollection(options: Readonly<{
  store: AssetStore
  collector: Pick<ThumbnailGarbageCollector, "collect">
  maxPages?: number
}>): Promise<void> {
  const maxPages = boundedPages(options.maxPages ?? 12)
  let continuation = await readCheckpoint(options.store)
  for (let page = 0; page < maxPages; page += 1) {
    const result = await options.collector.collect(continuation ?? undefined)
    continuation = result.continuation
    if (!continuation) {
      await options.store.delete(CHECKPOINT_KEY)
      return
    }
    await writeCheckpoint(options.store, continuation)
  }
}

async function readCheckpoint(store: AssetStore): Promise<ThumbnailGarbageCollectionContinuation | null> {
  const checkpoint = await store.download(CHECKPOINT_KEY)
  if (!checkpoint) return null
  const bytes = await readBounded(checkpoint, CHECKPOINT_LIMIT)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error("Thumbnail garbage collection checkpoint is invalid")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Thumbnail garbage collection checkpoint is invalid")
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(",")
  if (!["phase", "cursor,phase"].includes(keys) || !["versions", "claims", "quota"].includes(String(record.phase))) {
    throw new Error("Thumbnail garbage collection checkpoint is invalid")
  }
  if (record.cursor !== undefined && (typeof record.cursor !== "string" || !record.cursor || record.cursor.length > 512 || /[\r\n]/.test(record.cursor))) {
    throw new Error("Thumbnail garbage collection checkpoint is invalid")
  }
  return Object.freeze({
    phase: record.phase as ThumbnailGarbageCollectionContinuation["phase"],
    ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
  })
}

async function writeCheckpoint(store: AssetStore, continuation: ThumbnailGarbageCollectionContinuation): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(continuation))
  await store.put(CHECKPOINT_KEY, body, {
    contentType: "application/json",
    cacheControl: "no-store",
    metadata: { kind: "thumbnail-garbage-collection-checkpoint" },
  })
}

async function readBounded(download: AssetDownload, limit: number): Promise<Uint8Array> {
  const reader = download.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > limit) throw new Error("Thumbnail garbage collection checkpoint is too large")
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function boundedPages(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("Garbage collection page bound is invalid")
  return value
}
