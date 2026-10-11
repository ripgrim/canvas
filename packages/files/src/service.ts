import type {
  AssetActor,
  AssetDescriptor,
  AssetDownload,
  AssetUploadResult,
  CanonicalImageAssetReference,
  AssetObjectInfo,
  AssetStore,
  CopyAssetRequest,
  ThumbnailObjectIdentity,
  ThumbnailUploadIntent,
  ThumbnailUploadIntentRequest,
  UploadIntent,
  UploadIntentRequest,
  AssetExtension,
  LegacyImageExternalizationRequest,
  ImageAssetExtension,
} from "./contracts.js"
import { FileAssetError } from "./contracts.js"
import {
  UploadIntentSigner,
  type ThumbnailUploadIntentClaims,
  type UploadIntentClaims,
} from "./intent.js"
import {
  assetKey,
  contentTypeForExtension,
  parseThumbnailObjectKey,
  thumbnailClaimKey,
} from "./keys.js"
import {
  MAX_ASSET_BYTES,
  MAX_DECODED_IMAGE_PIXELS,
  cacheControlForExtension,
  validateFileSignature,
  validateThumbnail,
  validateThumbnailImage,
  validateThumbnailUploadRequest,
  validateUploadRequest,
  type ImageDimensions,
} from "./policy.js"
import {
  StoreBackedThumbnailUploadQuota,
  type ThumbnailUploadQuota,
} from "./quota.js"

export interface FileAssetServiceOptions {
  store: AssetStore
  signer: UploadIntentSigner
  uploadQuota?: ThumbnailUploadQuota
  thumbnailQuota?: ThumbnailUploadQuota
  mediaDecoder: AssetMediaDecoder
}

export interface AssetMediaDecoder {
  decode(
    extension: Extract<AssetExtension, "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp">,
    bytes: Uint8Array,
  ): Promise<ImageDimensions & Readonly<{ pixelCount: number }>>
}

type ThumbnailUploadReservation = Readonly<{
  actor: AssetActor
  claims: ThumbnailUploadIntentClaims
}>

type AssetUploadReservation = Readonly<{
  actor: AssetActor
  claims: UploadIntentClaims
}>

export class FileAssetService {
  readonly #store: AssetStore
  readonly #signer: UploadIntentSigner
  readonly #uploadQuota: ThumbnailUploadQuota
  readonly #thumbnailQuota: ThumbnailUploadQuota
  readonly #mediaDecoder: AssetMediaDecoder

  constructor(options: FileAssetServiceOptions) {
    this.#store = options.store
    this.#signer = options.signer
    this.#thumbnailQuota = options.thumbnailQuota ?? new StoreBackedThumbnailUploadQuota({
      store: options.store,
    })
    this.#uploadQuota = options.uploadQuota ?? this.#thumbnailQuota
    this.#mediaDecoder = options.mediaDecoder
  }

  async createUploadIntent(
    actor: AssetActor,
    request: UploadIntentRequest,
  ): Promise<UploadIntent> {
    validateUploadRequest(request)
    const { token, claims } = await this.#signer.issue(actor.userId, request)
    await this.#uploadQuota.acquire({
      subject: actor.userId,
      fileId: claims.fileId,
      nonce: claims.nonce,
      operation: "intent",
    })
    const key = assetKey(request)
    if (await this.#store.head(key)) {
      throw new FileAssetError("conflict", "Asset already exists", 409)
    }
    return {
      method: "PUT",
      path: "/file-assets/uploads",
      token,
      headers: {
        "Content-Length": String(request.size),
        "Content-Type": request.contentType,
        "X-Canvas-Upload-Token": token,
      },
      expiresAt: new Date(claims.expiresAt).toISOString(),
    }
  }

  verifyUploadIntent(token: string): Promise<UploadIntentClaims> {
    return this.#signer.verify(token)
  }

  async reserveUploadAttempt(
    actor: AssetActor,
    claims: UploadIntentClaims,
  ): Promise<AssetUploadReservation> {
    if (claims.subject !== actor.userId) {
      throw new FileAssetError("forbidden", "Upload intent belongs to another user", 403)
    }
    validateUploadRequest(claims)
    await this.#uploadQuota.acquire({
      subject: actor.userId,
      fileId: claims.fileId,
      nonce: claims.nonce,
      operation: "upload",
    })
    await this.#store.put(
      thumbnailClaimKey(claims.fileId, claims.nonce),
      new Uint8Array([1]),
      {
        contentType: "application/octet-stream",
        cacheControl: "private, no-store",
        metadata: {
          kind: "asset-upload-claim",
          fileId: claims.fileId,
          subject: actor.userId,
          expiresAt: String(claims.expiresAt),
        },
        condition: { type: "create" },
      },
    )
    return Object.freeze({ actor, claims })
  }

  async createThumbnailUploadIntent(
    actor: AssetActor,
    request: ThumbnailUploadIntentRequest,
  ): Promise<ThumbnailUploadIntent> {
    validateThumbnailUploadRequest(request)
    const { token, claims } = await this.#signer.issueThumbnail(
      actor.userId,
      request,
    )
    await this.#thumbnailQuota.acquire({
      subject: actor.userId,
      fileId: claims.fileId,
      nonce: claims.nonce,
      operation: "intent",
    })
    return {
      method: "PUT",
      path: "/file-assets/thumbnail-uploads",
      token,
      headers: {
        "Content-Length": String(request.size),
        "Content-Type": "image/avif",
        "X-Canvas-Upload-Token": token,
      },
      expiresAt: new Date(claims.expiresAt).toISOString(),
    }
  }

  verifyThumbnailUploadIntent(token: string): Promise<ThumbnailUploadIntentClaims> {
    return this.#signer.verifyThumbnail(token)
  }

  async upload(
    reservation: AssetUploadReservation,
    body: Uint8Array,
    contentType: string,
    contentLength: number,
  ): Promise<AssetUploadResult> {
    const { actor, claims } = reservation
    validateUploadRequest(claims)
    if (contentType !== claims.contentType || contentLength !== claims.size) {
      throw new FileAssetError("bad_request", "Upload does not match its intent", 400)
    }
    if (body.byteLength !== claims.size) {
      throw new FileAssetError("bad_request", "Upload length is invalid", 400)
    }
    const extension = claims.extension
    const dimensions = validateFileSignature(extension, body)
    if (!dimensions || !isImageExtension(extension)) {
      const key = assetKey(claims)
      if (await this.#store.head(key)) {
        throw new FileAssetError("conflict", "Asset already exists", 409)
      }
      return this.#store.put(key, body, {
        contentType: claims.contentType,
        cacheControl: cacheControlForExtension(claims.extension),
        metadata: {
          fileId: claims.fileId,
          assetId: claims.assetId,
          uploadedBy: actor.userId,
        },
        condition: { type: "create" },
      })
    }

    const decoded = await this.#decodeImage(extension, body, dimensions)
    const sha256 = await digestHex(body)
    const asset = canonicalImageAsset(
      { assetId: claims.assetId, extension },
      body.byteLength,
      decoded,
      sha256,
    )
    const key = assetKey(claims)
    const metadata = canonicalImageMetadata(claims.fileId, actor.userId, asset)
    try {
      await this.#store.put(key, body, {
        contentType: claims.contentType,
        cacheControl: cacheControlForExtension(claims.extension),
        metadata,
        condition: { type: "create" },
      })
      return asset
    } catch (error) {
      if (!(error instanceof FileAssetError) || error.code !== "conflict") {
        throw error
      }
    }

    const existing = await this.#store.download(key)
    if (!existing || !sameCanonicalImageInfo(existing.info, claims, metadata)) {
      throw new FileAssetError("conflict", "Asset already exists with different contents", 409)
    }
    const existingBody = await readStoredAsset(existing, MAX_ASSET_BYTES)
    if (await digestHex(existingBody) !== sha256) {
      throw new FileAssetError("conflict", "Asset already exists with different contents", 409)
    }
    return asset
  }

  async externalizeLegacyImage(
    request: LegacyImageExternalizationRequest,
  ): Promise<CanonicalImageAssetReference> {
    const descriptor = {
      fileId: request.fileId,
      assetId: request.assetId,
      extension: request.extension,
    }
    validateUploadRequest({
      ...descriptor,
      contentType: request.contentType,
      size: request.contentLength,
    })
    if (request.body.byteLength !== request.contentLength) {
      throw new FileAssetError("bad_request", "Upload length is invalid", 400)
    }
    if (
      !Number.isSafeInteger(request.width) ||
      !Number.isSafeInteger(request.height) ||
      request.width <= 0 ||
      request.height <= 0
    ) {
      throw new FileAssetError("bad_request", "Image dimensions are invalid", 400)
    }

    const dimensions = validateFileSignature(request.extension, request.body)
    if (!dimensions) {
      throw new FileAssetError("unsupported_media_type", "File type is not an image", 415)
    }
    await this.#decodeImage(request.extension, request.body, dimensions)
    if (dimensions.width !== request.width || dimensions.height !== request.height) {
      throw new FileAssetError("bad_request", "Image dimensions do not match", 400)
    }

    const sha256 = await digestHex(request.body)
    const asset: CanonicalImageAssetReference = Object.freeze({
      id: request.assetId,
      mime: request.contentType,
      extension: request.extension,
      bytes: request.contentLength,
      width: request.width,
      height: request.height,
      sha256,
    })
    const key = assetKey(descriptor)
    const metadata = legacyImageMetadata(request, sha256)
    try {
      await this.#store.put(key, request.body, {
        contentType: request.contentType,
        cacheControl: cacheControlForExtension(request.extension),
        metadata,
        condition: { type: "create" },
      })
      return asset
    } catch (error) {
      if (!(error instanceof FileAssetError) || error.code !== "conflict") {
        throw error
      }
    }

    const existing = await this.#store.download(key)
    if (!existing || !sameLegacyImageInfo(existing.info, request, metadata)) {
      throw new FileAssetError("conflict", "Asset already exists with different contents", 409)
    }
    const existingBody = await readStoredAsset(existing, MAX_ASSET_BYTES)
    if (await digestHex(existingBody) !== sha256) {
      throw new FileAssetError("conflict", "Asset already exists with different contents", 409)
    }
    return asset
  }

  async download(descriptor: AssetDescriptor): Promise<AssetDownload> {
    const stored = await this.#store.download(assetKey(descriptor))
    if (!stored) {
      throw new FileAssetError("not_found", "Asset not found", 404)
    }
    return stored
  }

  async head(descriptor: AssetDescriptor): Promise<AssetObjectInfo> {
    const stored = await this.#store.head(assetKey(descriptor))
    if (!stored) {
      throw new FileAssetError("not_found", "Asset not found", 404)
    }
    return stored
  }

  async copy(actor: AssetActor, request: CopyAssetRequest): Promise<void> {
    const source = assetKey(request.source)
    const target = assetKey(request.target)
    const sourceInfo = await this.#store.head(source)
    if (!sourceInfo) {
      throw new FileAssetError("not_found", "Source asset not found", 404)
    }
    if (sourceInfo.size > MAX_ASSET_BYTES) {
      throw new FileAssetError("payload_too_large", "Source asset is too large", 413)
    }
    if (sourceInfo.contentType !== contentTypeForExtension(request.target.extension)) {
      throw new FileAssetError(
        "unsupported_media_type",
        "Target extension does not match the source content type",
        415,
      )
    }
    if (await this.#store.head(target)) {
      throw new FileAssetError("conflict", "Target asset already exists", 409)
    }
    const sourceAsset = canonicalImageAssetFromInfo(request.source, sourceInfo)
    const targetMetadata = sourceAsset
      ? canonicalImageMetadata(request.target.fileId, actor.userId, {
          ...sourceAsset,
          id: request.target.assetId,
          extension: request.target.extension as ImageAssetExtension,
        })
      : {
          fileId: request.target.fileId,
          assetId: request.target.assetId,
          copiedBy: actor.userId,
          copiedFrom: source,
        }
    await this.#store.copy(source, target, {
      contentType: sourceInfo.contentType,
      cacheControl: cacheControlForExtension(request.target.extension),
      metadata: targetMetadata,
      immutable: true,
    })
  }

  async reserveThumbnailUploadAttempt(
    actor: AssetActor,
    claims: ThumbnailUploadIntentClaims,
  ): Promise<ThumbnailUploadReservation> {
    if (claims.subject !== actor.userId) {
      throw new FileAssetError("forbidden", "Upload intent belongs to another service", 403)
    }
    validateThumbnailUploadRequest(claims)
    await this.#thumbnailQuota.acquire({
      subject: actor.userId,
      fileId: claims.fileId,
      nonce: claims.nonce,
      operation: "upload",
    })
    return Object.freeze({ actor, claims })
  }

  async uploadThumbnail(
    reservation: ThumbnailUploadReservation,
    body: Uint8Array,
    contentType: string,
    contentLength: number,
  ): Promise<AssetObjectInfo> {
    const { actor, claims } = reservation
    validateThumbnail(contentLength, contentType)
    if (contentLength !== claims.size || contentType !== claims.contentType) {
      throw new FileAssetError("bad_request", "Upload does not match its intent", 400)
    }
    if (body.byteLength !== contentLength) {
      throw new FileAssetError("bad_request", "Upload length is invalid", 400)
    }
    const dimensions = validateThumbnailImage(body)
    await this.#decodeImage("avif", body, dimensions)

    if (await this.#store.head(thumbnailClaimKey(claims.fileId, claims.nonce))) {
      throw new FileAssetError("conflict", "Thumbnail upload intent was already used", 409)
    }
    await this.#store.put(thumbnailClaimKey(claims.fileId, claims.nonce), new Uint8Array([1]), {
      contentType: "application/octet-stream",
      cacheControl: "private, no-store",
      metadata: {
        fileId: claims.fileId,
        subject: actor.userId,
        expectedRevision: String(claims.expectedRevision),
      },
      condition: { type: "create" },
    })

    return this.#store.put(claims.objectKey, body, {
      contentType: "image/avif",
      cacheControl: "private, max-age=31536000, immutable",
      metadata: {
        fileId: claims.fileId,
        renderedBy: actor.userId,
        revision: String(claims.expectedRevision),
      },
      condition: { type: "create" },
    })
  }

  async #decodeImage(
    extension: Extract<AssetExtension, "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp">,
    bytes: Uint8Array,
    expected: ImageDimensions,
  ): Promise<ImageDimensions> {
    const expectedPixels = expected.width * expected.height
    if (
      !Number.isSafeInteger(expectedPixels) ||
      expectedPixels <= 0 ||
      expectedPixels > MAX_DECODED_IMAGE_PIXELS
    ) {
      throw new FileAssetError(
        "unsupported_media_type",
        "Decoded image dimensions exceed the safe pixel limit",
        415,
      )
    }
    let decoded: ImageDimensions & Readonly<{ pixelCount: number }>
    try {
      decoded = await this.#mediaDecoder.decode(extension, bytes)
    } catch {
      throw new FileAssetError(
        "unsupported_media_type",
        "Image codec rejected the file contents",
        415,
      )
    }
    if (
      !Number.isSafeInteger(decoded.width) ||
      !Number.isSafeInteger(decoded.height) ||
      !Number.isSafeInteger(decoded.pixelCount) ||
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.pixelCount <= 0 ||
      decoded.pixelCount > MAX_DECODED_IMAGE_PIXELS ||
      decoded.width !== expected.width ||
      decoded.height !== expected.height ||
      decoded.pixelCount < decoded.width * decoded.height
    ) {
      throw new FileAssetError(
        "unsupported_media_type",
        "Decoded image dimensions do not match the file container",
        415,
      )
    }
    return Object.freeze({ width: decoded.width, height: decoded.height })
  }

  async downloadThumbnail(identity: ThumbnailObjectIdentity): Promise<AssetDownload> {
    this.#validateCommittedThumbnail(identity)
    const stored = await this.#store.download(identity.key)
    if (!stored) {
      throw new FileAssetError("not_found", "Thumbnail not found", 404)
    }
    this.#verifyCommittedThumbnail(stored.info, identity)
    return stored
  }

  async headThumbnail(identity: ThumbnailObjectIdentity): Promise<AssetObjectInfo> {
    this.#validateCommittedThumbnail(identity)
    const stored = await this.#store.head(identity.key)
    if (!stored) {
      throw new FileAssetError("not_found", "Thumbnail not found", 404)
    }
    this.#verifyCommittedThumbnail(stored, identity)
    return stored
  }

  #validateCommittedThumbnail(identity: ThumbnailObjectIdentity): void {
    const parsed = parseThumbnailObjectKey(identity.key, identity.fileId)
    if (
      !parsed ||
      parsed.revision !== identity.revision ||
      !identity.etag ||
      identity.etag.length > 256
    ) {
      throw new FileAssetError("not_found", "Thumbnail not found", 404)
    }
  }

  #verifyCommittedThumbnail(
    info: AssetObjectInfo,
    identity: ThumbnailObjectIdentity,
  ): void {
    if (
      info.key !== identity.key ||
      info.etag !== identity.etag ||
      info.contentType !== "image/avif" ||
      info.metadata?.fileId !== identity.fileId ||
      info.metadata.revision !== String(identity.revision)
    ) {
      throw new FileAssetError("not_found", "Thumbnail not found", 404)
    }
  }
}

const CANONICAL_IMAGE_METADATA_KEYS = [
  "assetId",
  "bytes",
  "extension",
  "fileId",
  "height",
  "kind",
  "mime",
  "sha256",
  "uploadedBy",
  "width",
] as const

function isImageExtension(extension: AssetExtension): extension is ImageAssetExtension {
  return ["avif", "gif", "jpeg", "jpg", "png", "webp"].includes(extension)
}

function canonicalImageAsset(
  descriptor: Readonly<{
    assetId: string
    extension: ImageAssetExtension
  }>,
  bytes: number,
  dimensions: ImageDimensions,
  sha256: string,
): CanonicalImageAssetReference {
  return Object.freeze({
    id: descriptor.assetId,
    mime: contentTypeForExtension(descriptor.extension),
    extension: descriptor.extension,
    bytes,
    width: dimensions.width,
    height: dimensions.height,
    sha256,
  })
}

function canonicalImageMetadata(
  fileId: string,
  uploadedBy: string,
  asset: CanonicalImageAssetReference,
): Readonly<Record<(typeof CANONICAL_IMAGE_METADATA_KEYS)[number], string>> {
  return Object.freeze({
    kind: "image",
    fileId,
    assetId: asset.id,
    extension: asset.extension,
    mime: asset.mime,
    bytes: String(asset.bytes),
    width: String(asset.width),
    height: String(asset.height),
    sha256: asset.sha256,
    uploadedBy,
  })
}

function sameCanonicalImageInfo(
  info: AssetObjectInfo,
  descriptor: AssetDescriptor & Readonly<{ contentType: string; size: number }>,
  expectedMetadata: Readonly<Record<string, string>>,
): boolean {
  const metadata = info.metadata
  if (
    info.key !== assetKey(descriptor) ||
    info.size !== descriptor.size ||
    info.contentType !== descriptor.contentType ||
    !metadata ||
    Object.keys(metadata).sort().join(",") !== [...CANONICAL_IMAGE_METADATA_KEYS].sort().join(",")
  ) return false
  return CANONICAL_IMAGE_METADATA_KEYS.every(key => metadata[key] === expectedMetadata[key])
}

export function canonicalImageAssetFromInfo(
  descriptor: AssetDescriptor,
  info: AssetObjectInfo,
): CanonicalImageAssetReference | null {
  if (!isImageExtension(descriptor.extension)) return null
  const metadata = info.metadata
  if (!metadata || metadata.fileId !== descriptor.fileId || metadata.assetId !== descriptor.assetId) {
    return null
  }
  const expectedKeys = metadata.kind === "legacy-image"
    ? LEGACY_IMAGE_METADATA_KEYS
    : metadata.kind === "image"
      ? CANONICAL_IMAGE_METADATA_KEYS
      : null
  if (!expectedKeys || Object.keys(metadata).sort().join(",") !== [...expectedKeys].sort().join(",")) {
    return null
  }
  const width = Number(metadata.width)
  const height = Number(metadata.height)
  const bytes = metadata.bytes === undefined ? info.size : Number(metadata.bytes)
  const mime = metadata.mime ?? info.contentType
  if (
    metadata.extension !== descriptor.extension ||
    mime !== info.contentType ||
    mime !== contentTypeForExtension(descriptor.extension) ||
    bytes !== info.size ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    typeof metadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  ) return null
  return Object.freeze({
    id: descriptor.assetId,
    mime,
    extension: descriptor.extension,
    bytes,
    width,
    height,
    sha256: metadata.sha256,
  })
}

const LEGACY_IMAGE_METADATA_KEYS = [
  "assetId",
  "extension",
  "fileId",
  "height",
  "kind",
  "sha256",
  "width",
] as const

function legacyImageMetadata(
  request: LegacyImageExternalizationRequest,
  sha256: string,
): Readonly<Record<(typeof LEGACY_IMAGE_METADATA_KEYS)[number], string>> {
  return Object.freeze({
    kind: "legacy-image",
    fileId: request.fileId,
    assetId: request.assetId,
    extension: request.extension,
    width: String(request.width),
    height: String(request.height),
    sha256,
  })
}

function sameLegacyImageInfo(
  info: AssetObjectInfo,
  request: LegacyImageExternalizationRequest,
  expectedMetadata: Readonly<Record<string, string>>,
): boolean {
  const metadata = info.metadata
  if (
    info.key !== assetKey(request) ||
    info.size !== request.contentLength ||
    info.contentType !== request.contentType ||
    !metadata ||
    Object.keys(metadata).sort().join(",") !== [...LEGACY_IMAGE_METADATA_KEYS].sort().join(",")
  ) return false
  return LEGACY_IMAGE_METADATA_KEYS.every(key => metadata[key] === expectedMetadata[key])
}

async function readStoredAsset(
  stored: AssetDownload,
  maximumLength: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(stored.info.size) ||
    stored.info.size <= 0 ||
    stored.info.size > maximumLength
  ) {
    throw new FileAssetError("conflict", "Asset already exists with different contents", 409)
  }
  const reader = stored.body.getReader()
  const body = new Uint8Array(stored.info.size)
  let offset = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (offset + value.byteLength > body.byteLength) {
      await reader.cancel("stored asset length mismatch")
      throw new FileAssetError("conflict", "Asset already exists with different contents", 409)
    }
    body.set(value, offset)
    offset += value.byteLength
  }
  if (offset !== body.byteLength) {
    throw new FileAssetError("conflict", "Asset already exists with different contents", 409)
  }
  return body
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  ))
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("")
}
