export type AssetAccess = "read" | "write"

export interface AssetActor {
  userId: string
}

export interface AssetDescriptor {
  fileId: string
  assetId: string
  extension: AssetExtension
}

export type AssetExtension =
  | "avif"
  | "gif"
  | "jpeg"
  | "jpg"
  | "png"
  | "webp"
  | "woff"
  | "woff2"

export interface AssetObjectInfo {
  key: string
  size: number
  contentType: string
  etag?: string
  lastModified?: Date
  metadata?: Readonly<Record<string, string>>
}

export interface AssetDownload {
  info: AssetObjectInfo
  body: ReadableStream<Uint8Array>
}

export interface AssetWriteOptions {
  contentType: string
  cacheControl: string
  metadata: Readonly<Record<string, string>>
  immutable?: boolean
}

export interface AssetStore {
  put(
    key: string,
    body: Uint8Array,
    options: AssetWriteOptions,
  ): Promise<AssetObjectInfo>
  download(key: string): Promise<AssetDownload | null>
  head(key: string): Promise<AssetObjectInfo | null>
  copy(from: string, to: string, options: AssetWriteOptions): Promise<void>
}

export interface UploadIntentRequest extends AssetDescriptor {
  contentType: string
  size: number
}

export interface UploadIntent {
  method: "PUT"
  path: "/file-assets/uploads"
  token: string
  headers: Readonly<{
    "Content-Length": string
    "Content-Type": string
    "X-Canvas-Upload-Token": string
  }>
  expiresAt: string
}

export interface CopyAssetRequest {
  source: AssetDescriptor
  target: AssetDescriptor
}

export type FileAssetErrorCode =
  | "bad_request"
  | "conflict"
  | "forbidden"
  | "not_found"
  | "payload_too_large"
  | "unsupported_media_type"
  | "unauthorized"

export class FileAssetError extends Error {
  readonly code: FileAssetErrorCode
  readonly status: number

  constructor(code: FileAssetErrorCode, message: string, status: number) {
    super(message)
    this.name = "FileAssetError"
    this.code = code
    this.status = status
  }
}
