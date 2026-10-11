import type { AssetStore } from "./contracts.js"
import { FileAssetError } from "./contracts.js"
import { thumbnailQuotaPrefix } from "./keys.js"

export type ThumbnailQuotaRequest = Readonly<{
  subject: string
  fileId: string
  nonce: string
  operation: "intent" | "upload"
}>

export interface ThumbnailUploadQuota {
  acquire(request: ThumbnailQuotaRequest): Promise<void>
}

export type StoreBackedThumbnailQuotaOptions = Readonly<{
  store: AssetStore
  now?: () => number
  windowMs?: number
  uploadsPerUser?: number
  uploadsPerFile?: number
}>

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_UPLOADS_PER_USER = 60
const DEFAULT_UPLOADS_PER_FILE = 20

export class StoreBackedThumbnailUploadQuota implements ThumbnailUploadQuota {
  readonly #store: AssetStore
  readonly #now: () => number
  readonly #windowMs: number
  readonly #uploadsPerUser: number
  readonly #uploadsPerFile: number

  constructor(options: StoreBackedThumbnailQuotaOptions) {
    this.#store = options.store
    this.#now = options.now ?? Date.now
    this.#windowMs = positiveDuration(options.windowMs ?? DEFAULT_WINDOW_MS, "quota window")
    this.#uploadsPerUser = positiveInteger(
      options.uploadsPerUser ?? DEFAULT_UPLOADS_PER_USER,
      "user quota",
    )
    this.#uploadsPerFile = positiveInteger(
      options.uploadsPerFile ?? DEFAULT_UPLOADS_PER_FILE,
      "file quota",
    )
  }

  async acquire(request: ThumbnailQuotaRequest): Promise<void> {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Quota clock is invalid")
    const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs
    const expiresAt = windowStart + this.#windowMs
    await this.#claim(
      "user",
      request.operation,
      request.subject,
      request.nonce,
      windowStart,
      expiresAt,
      this.#uploadsPerUser,
    )
    await this.#claim(
      "file",
      request.operation,
      request.fileId,
      request.nonce,
      windowStart,
      expiresAt,
      this.#uploadsPerFile,
    )
  }

  async #claim(
    kind: "user" | "file",
    operation: "intent" | "upload",
    scope: string,
    nonce: string,
    windowStart: number,
    expiresAt: number,
    limit: number,
  ): Promise<void> {
    const scopeHash = await sha256(`${operation}\0${kind}\0${scope}`)
    const nonceHash = await sha256(nonce)
    const start = Number.parseInt(nonceHash.slice(0, 8), 16) % limit
    const prefix = thumbnailQuotaPrefix(windowStart, scopeHash)
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const slot = (start + attempt) % limit
      try {
        await this.#store.put(`${prefix}${slot}`, new Uint8Array([1]), {
          contentType: "application/octet-stream",
          cacheControl: "private, no-store",
          metadata: {
            kind,
            operation,
            windowStart: String(windowStart),
            expiresAt: String(expiresAt),
          },
          condition: { type: "create" },
        })
        return
      } catch (error) {
        if (!(error instanceof FileAssetError) || error.code !== "conflict") throw error
      }
    }
    throw new FileAssetError(
      "too_many_requests",
      `Thumbnail ${kind} upload limit reached`,
      429,
    )
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new Error(`${label} must be a positive integer no greater than 10000`)
  }
  return value
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}
