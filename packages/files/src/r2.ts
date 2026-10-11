import { Files } from "files-sdk"
import { r2 } from "files-sdk/r2"

import type {
  AssetDownload,
  AssetListRequest,
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
  head(key: string): Promise<R2PutObject | null>
  list(options: {
    prefix: string
    cursor?: string
    limit: number
    include: readonly ["httpMetadata", "customMetadata"]
  }): Promise<{
    objects: R2PutObject[]
    truncated: boolean
    cursor?: string
  }>
  delete(key: string): Promise<void>
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

function assertMaintenanceBinding(binding: R2PutBinding): void {
  if (
    !("head" in binding) || typeof binding.head !== "function" ||
    !("list" in binding) || typeof binding.list !== "function" ||
    !("delete" in binding) || typeof binding.delete !== "function"
  ) {
    throw new Error("FILE_ASSETS must support R2 maintenance operations")
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
      const condition = writeOptions.condition ??
        (writeOptions.immutable ? { type: "create" as const } : undefined)
      if (condition) {
        const onlyIf = condition.type === "create"
          ? new Headers({ "If-None-Match": "*" })
          : new Headers({ "If-Match": condition.etag })
        const stored = await binding.put(key, body, {
          onlyIf,
          httpMetadata: {
            contentType: writeOptions.contentType,
            cacheControl: writeOptions.cacheControl,
          },
          customMetadata: { ...writeOptions.metadata },
        })
        if (!stored) {
          throw new FileAssetError("conflict", "Asset changed before upload", 409)
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
      const condition = writeOptions.condition ?? { type: "create" as const }
      const onlyIf = condition.type === "create"
        ? new Headers({ "If-None-Match": "*" })
        : new Headers({ "If-Match": condition.etag })
      const stored = await binding.put(to, new Uint8Array(await source.arrayBuffer()), {
        onlyIf,
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
    async list(input: AssetListRequest) {
      assertMaintenanceBinding(binding)
      const page = await binding.list({
        prefix: input.prefix,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit,
        include: ["httpMetadata", "customMetadata"],
      })
      return {
        objects: page.objects.map(object => ({
          key: object.key,
          size: object.size,
          contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
          etag: object.etag,
          lastModified: object.uploaded,
          ...(object.customMetadata ? { metadata: object.customMetadata } : {}),
        })),
        ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
      }
    },
    async delete(key: string): Promise<boolean> {
      assertMaintenanceBinding(binding)
      const current = await binding.head(key)
      if (!current) return false
      await binding.delete(key)
      return true
    },
  }
}
