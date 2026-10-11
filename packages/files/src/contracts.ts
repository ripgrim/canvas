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

export type ImageAssetExtension = Extract<
  AssetExtension,
  "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp"
>

export interface CanonicalImageAssetReference {
  id: string
  mime: string
  extension: ImageAssetExtension
  bytes: number
  width: number
  height: number
  sha256: string
}

export type AssetUploadResult = CanonicalImageAssetReference | AssetObjectInfo

export interface LegacyImageExternalizationRequest extends AssetDescriptor {
  extension: ImageAssetExtension
  body: Uint8Array
  contentType: string
  contentLength: number
  width: number
  height: number
}

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
  condition?: AssetWriteCondition
}

export type AssetWriteCondition =
  | Readonly<{ type: "create" }>
  | Readonly<{ type: "match"; etag: string }>

export interface AssetStore {
  put(
    key: string,
    body: Uint8Array,
    options: AssetWriteOptions,
  ): Promise<AssetObjectInfo>
  download(key: string): Promise<AssetDownload | null>
  head(key: string): Promise<AssetObjectInfo | null>
  copy(from: string, to: string, options: AssetWriteOptions): Promise<void>
  list(input: AssetListRequest): Promise<AssetListPage>
  delete(key: string): Promise<boolean>
}

export interface AssetListRequest {
  prefix: string
  cursor?: string
  limit: number
}

export interface AssetListPage {
  objects: readonly AssetObjectInfo[]
  cursor?: string
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

export interface ThumbnailUploadIntentRequest {
  fileId: string
  expectedRevision: number
  contentType: "image/avif"
  size: number
}

export interface ThumbnailUploadIntent {
  method: "PUT"
  path: "/file-assets/thumbnail-uploads"
  token: string
  headers: Readonly<{
    "Content-Length": string
    "Content-Type": "image/avif"
    "X-Canvas-Upload-Token": string
  }>
  expiresAt: string
}

export interface ThumbnailObjectIdentity {
  fileId: string
  revision: number
  key: string
  etag: string
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
  | "too_many_requests"
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
