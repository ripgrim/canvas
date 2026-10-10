import { Files } from "files-sdk"
import { r2 } from "files-sdk/r2"

import type {
  AssetDownload,
  AssetObjectInfo,
  AssetStore,
  AssetWriteOptions,
} from "./contracts.js"
import { FileAssetError } from "./contracts.js"

export interface R2BindingAssetStoreOptions {
  binding: object
}

interface R2PutObject {
  key: string
  size: number
  etag: string
  uploaded: Date
  httpMetadata?: { contentType?: string; cacheControl?: string }
  customMetadata?: Record<string, string>
}

interface R2PutBinding {
  get(key: string): Promise<{
    size: number
    httpMetadata?: { contentType?: string; cacheControl?: string }
    customMetadata?: Record<string, string>
    arrayBuffer(): Promise<ArrayBuffer>
  } | null>
  put(
    key: string,
    body: Uint8Array,
    options: {
      onlyIf: Headers
      httpMetadata: { contentType: string; cacheControl: string }
      customMetadata: Record<string, string>
    },
  ): Promise<R2PutObject | null>
}

function asPutBinding(binding: object): R2PutBinding {
  if (!("put" in binding) || typeof binding.put !== "function") {
    throw new Error("FILE_ASSETS must be an R2 bucket binding")
  }
  return binding as R2PutBinding
}

function assertCopyBinding(binding: R2PutBinding): void {
  if (!("get" in binding) || typeof binding.get !== "function") {
    throw new Error("FILE_ASSETS must support R2 reads")
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "NotFound"
  )
}

function toInfo(info: {
  key: string
  size: number
  contentType: string
  etag?: string | undefined
  lastModified?: number | undefined
  metadata?: Readonly<Record<string, string>> | undefined
}): AssetObjectInfo {
  return {
    key: info.key,
    size: info.size,
    contentType: info.contentType,
    ...(info.etag ? { etag: info.etag } : {}),
    ...(info.lastModified ? { lastModified: new Date(info.lastModified) } : {}),
    ...(info.metadata ? { metadata: info.metadata } : {}),
  }
}

export function createR2BindingAssetStore(
  options: R2BindingAssetStoreOptions,
): AssetStore {
  const files = new Files({
    adapter: r2({ binding: options.binding as never }),
  })
  const binding = asPutBinding(options.binding)

  return {
    async put(
      key: string,
      body: Uint8Array,
      writeOptions: AssetWriteOptions,
    ): Promise<AssetObjectInfo> {
      if (writeOptions.immutable) {
        const stored = await binding.put(key, body, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: {
            contentType: writeOptions.contentType,
            cacheControl: writeOptions.cacheControl,
          },
          customMetadata: { ...writeOptions.metadata },
        })
        if (!stored) {
          throw new FileAssetError("conflict", "Asset already exists", 409)
        }
        return {
          key: stored.key,
          size: stored.size,
          contentType: stored.httpMetadata?.contentType ?? writeOptions.contentType,
          etag: stored.etag,
          lastModified: stored.uploaded,
          ...(stored.customMetadata ? { metadata: stored.customMetadata } : {}),
        }
      }
      const info = await files.upload(key, body, {
        contentType: writeOptions.contentType,
        cacheControl: writeOptions.cacheControl,
        metadata: { ...writeOptions.metadata },
      })
      return toInfo(info)
    },
    async download(key: string): Promise<AssetDownload | null> {
      try {
        const file = await files.download(key, { as: "stream" })
        return {
          info: toInfo(file),
          body: file.stream(),
        }
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }
        throw error
      }
    },
    async head(key: string): Promise<AssetObjectInfo | null> {
      try {
        return toInfo(await files.head(key))
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }
        throw error
      }
    },
    async copy(from: string, to: string, writeOptions: AssetWriteOptions): Promise<void> {
      assertCopyBinding(binding)
      const source = await binding.get(from)
      if (!source) {
        throw new FileAssetError("not_found", "Source asset not found", 404)
      }
      const stored = await binding.put(to, new Uint8Array(await source.arrayBuffer()), {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: {
          contentType: writeOptions.contentType,
          cacheControl: writeOptions.cacheControl,
        },
        customMetadata: { ...writeOptions.metadata },
      })
      if (!stored) {
        throw new FileAssetError("conflict", "Target asset already exists", 409)
      }
    },
  }
}
