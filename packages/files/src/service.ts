import type {
  AssetActor,
  AssetDescriptor,
  AssetDownload,
  AssetObjectInfo,
  AssetStore,
  CopyAssetRequest,
  UploadIntent,
  UploadIntentRequest,
} from "./contracts.js"
import { FileAssetError } from "./contracts.js"
import { UploadIntentSigner, type UploadIntentClaims } from "./intent.js"
import {
  assetKey,
  contentTypeForExtension,
  thumbnailKey,
} from "./keys.js"
import {
  MAX_ASSET_BYTES,
  cacheControlForExtension,
  validateFileSignature,
  validateThumbnail,
  validateUploadRequest,
} from "./policy.js"

export interface FileAssetServiceOptions {
  store: AssetStore
  signer: UploadIntentSigner
}

export class FileAssetService {
  readonly #store: AssetStore
  readonly #signer: UploadIntentSigner

  constructor(options: FileAssetServiceOptions) {
    this.#store = options.store
    this.#signer = options.signer
  }

  async createUploadIntent(
    actor: AssetActor,
    request: UploadIntentRequest,
  ): Promise<UploadIntent> {
    validateUploadRequest(request)
    const key = assetKey(request)
    if (await this.#store.head(key)) {
      throw new FileAssetError("conflict", "Asset already exists", 409)
    }
    const { token, claims } = await this.#signer.issue(actor.userId, request)
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

  async upload(
    actor: AssetActor,
    claims: UploadIntentClaims,
    body: Uint8Array,
    contentType: string,
    contentLength: number,
  ): Promise<AssetObjectInfo> {
    if (claims.subject !== actor.userId) {
      throw new FileAssetError("forbidden", "Upload intent belongs to another user", 403)
    }
    validateUploadRequest(claims)
    if (contentType !== claims.contentType || contentLength !== claims.size) {
      throw new FileAssetError("bad_request", "Upload does not match its intent", 400)
    }
    if (body.byteLength !== claims.size) {
      throw new FileAssetError("bad_request", "Upload length is invalid", 400)
    }
    validateFileSignature(claims.extension, body)
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
      immutable: true,
    })
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
    await this.#store.copy(source, target, {
      contentType: sourceInfo.contentType,
      cacheControl: cacheControlForExtension(request.target.extension),
      metadata: {
        fileId: request.target.fileId,
        assetId: request.target.assetId,
        copiedBy: actor.userId,
        copiedFrom: source,
      },
      immutable: true,
    })
  }

  async putThumbnail(
    actor: AssetActor,
    fileId: string,
    body: Uint8Array,
    contentType: string,
    contentLength: number,
  ): Promise<AssetObjectInfo> {
    validateThumbnail(contentLength, contentType)
    if (body.byteLength !== contentLength) {
      throw new FileAssetError("bad_request", "Upload length is invalid", 400)
    }
    validateFileSignature("avif", body)
    return this.#store.put(thumbnailKey(fileId), body, {
      contentType: "image/avif",
      cacheControl: "private, no-cache",
      metadata: { fileId, renderedBy: actor.userId },
    })
  }

  async downloadThumbnail(fileId: string): Promise<AssetDownload> {
    const stored = await this.#store.download(thumbnailKey(fileId))
    if (!stored) {
      throw new FileAssetError("not_found", "Thumbnail not found", 404)
    }
    return stored
  }

  async headThumbnail(fileId: string): Promise<AssetObjectInfo> {
    const stored = await this.#store.head(thumbnailKey(fileId))
    if (!stored) {
      throw new FileAssetError("not_found", "Thumbnail not found", 404)
    }
    return stored
  }
}
