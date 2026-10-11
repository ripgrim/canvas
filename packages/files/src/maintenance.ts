import type {
  AssetObjectInfo,
  AssetStore,
  ThumbnailObjectIdentity,
} from "./contracts.js"
import { parseThumbnailObjectKey } from "./keys.js"

export interface ThumbnailCommitResolver {
  resolve(fileId: string): Promise<ThumbnailObjectIdentity | null>
}

export type ThumbnailGarbageCollectorOptions = Readonly<{
  store: AssetStore
  committed: ThumbnailCommitResolver
  now?: () => number
  uncommittedGraceMs?: number
  supersededRetentionMs?: number
  markerRetentionMs?: number
  scanLimit?: number
  deleteLimit?: number
}>

export type ThumbnailGarbageCollectionResult = Readonly<{
  scanned: number
  deleted: number
  protected: number
  deferred: number
  continuation: ThumbnailGarbageCollectionContinuation | null
}>

export type ThumbnailGarbageCollectionContinuation = Readonly<{
  phase: "versions" | "claims" | "quota"
  cursor?: string
}>

const DAY = 24 * 60 * 60 * 1_000

export class ThumbnailGarbageCollector {
  readonly #store: AssetStore
  readonly #committed: ThumbnailCommitResolver
  readonly #now: () => number
  readonly #uncommittedGraceMs: number
  readonly #supersededRetentionMs: number
  readonly #markerRetentionMs: number
  readonly #scanLimit: number
  readonly #deleteLimit: number

  constructor(options: ThumbnailGarbageCollectorOptions) {
    this.#store = options.store
    this.#committed = options.committed
    this.#now = options.now ?? Date.now
    this.#uncommittedGraceMs = duration(options.uncommittedGraceMs ?? DAY, "uncommitted grace")
    this.#supersededRetentionMs = duration(
      options.supersededRetentionMs ?? 7 * DAY,
      "superseded retention",
    )
    this.#markerRetentionMs = duration(options.markerRetentionMs ?? 7 * DAY, "marker retention")
    this.#scanLimit = bounded(options.scanLimit ?? 1_000, "scan limit")
    this.#deleteLimit = bounded(options.deleteLimit ?? 100, "delete limit")
  }

  async collect(
    continuation: ThumbnailGarbageCollectionContinuation = { phase: "versions" },
  ): Promise<ThumbnailGarbageCollectionResult> {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Garbage collection clock is invalid")
    const state = { scanned: 0, deleted: 0, protected: 0, deferred: 0 }
    if (continuation.phase === "claims") {
      const cursor = await this.#collectMarkers(
        "thumbnail-claims/",
        continuation.cursor,
        state,
        object => {
          const age = objectAge(now, object)
          return age !== null && age >= this.#markerRetentionMs
        },
      )
      return Object.freeze({
        ...state,
        continuation: cursor
          ? Object.freeze({ phase: "claims" as const, cursor })
          : Object.freeze({ phase: "quota" as const }),
      })
    }
    if (continuation.phase === "quota") {
      const cursor = await this.#collectMarkers(
        "thumbnail-quota/",
        continuation.cursor,
        state,
        object => {
          const expiresAt = Number(object.metadata?.expiresAt)
          return Number.isSafeInteger(expiresAt) && expiresAt <= now
        },
      )
      return Object.freeze({
        ...state,
        continuation: cursor
          ? Object.freeze({ phase: "quota" as const, cursor })
          : null,
      })
    }
    const identities = new Map<string, ThumbnailObjectIdentity | null>()
    const versions = await this.#store.list({
      prefix: "thumbnails/",
      ...(continuation.cursor ? { cursor: continuation.cursor } : {}),
      limit: Math.min(this.#scanLimit, this.#deleteLimit),
    })
    for (const object of versions.objects) {
      state.scanned += 1
      const fileId = object.metadata?.fileId
      const parsed = fileId ? safeThumbnailObjectKey(object.key, fileId) : null
      if (!fileId || !parsed || object.metadata?.revision !== String(parsed.revision)) {
        state.protected += 1
        continue
      }
      let committed = identities.get(fileId)
      if (committed === undefined && !identities.has(fileId)) {
        committed = await this.#committed.resolve(fileId)
        identities.set(fileId, committed)
      }
      if (committed?.key === object.key) {
        state.protected += 1
        continue
      }
      const age = objectAge(now, object)
      const retention = committed && parsed.revision < committed.revision
        ? this.#supersededRetentionMs
        : this.#uncommittedGraceMs
      if (age === null || age < retention) {
        state.deferred += 1
        continue
      }
      if (!object.etag) {
        state.protected += 1
        continue
      }
      if (await this.#store.delete(object.key)) {
        state.deleted += 1
      }
    }
    return Object.freeze({
      ...state,
      continuation: versions.cursor
        ? Object.freeze({ phase: "versions" as const, cursor: versions.cursor })
        : Object.freeze({ phase: "claims" as const }),
    })
  }

  async #collectMarkers(
    prefix: string,
    cursor: string | undefined,
    state: { scanned: number; deleted: number; protected: number; deferred: number },
    expired: (object: AssetObjectInfo) => boolean,
  ): Promise<string | undefined> {
    const page = await this.#store.list({
      prefix,
      ...(cursor ? { cursor } : {}),
      limit: Math.min(this.#scanLimit, this.#deleteLimit),
    })
    for (const object of page.objects) {
      state.scanned += 1
      if (!expired(object)) {
        state.deferred += 1
        continue
      }
      if (!object.etag) {
        state.protected += 1
        continue
      }
      if (await this.#store.delete(object.key)) {
        state.deleted += 1
      }
    }
    return page.cursor
  }
}

function objectAge(now: number, object: AssetObjectInfo): number | null {
  const modified = object.lastModified?.getTime()
  return modified === undefined || !Number.isFinite(modified) || modified > now
    ? null
    : now - modified
}

function safeThumbnailObjectKey(
  key: string,
  fileId: string,
): Readonly<{ revision: number; nonce: string }> | null {
  try {
    return parseThumbnailObjectKey(key, fileId)
  } catch {
    return null
  }
}

function duration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}

function bounded(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new Error(`${label} must be between 1 and 10000`)
  }
  return value
}
