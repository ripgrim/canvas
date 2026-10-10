import type { AssetExtension, UploadIntentRequest } from "./contracts.js"
import { FileAssetError } from "./contracts.js"
import {
  assertAssetDescriptor,
  contentTypeForExtension,
} from "./keys.js"

export const MAX_ASSET_BYTES = 25 * 1024 * 1024
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

const FONT_EXTENSIONS = new Set<AssetExtension>(["woff", "woff2"])

export function validateUploadRequest(
  request: UploadIntentRequest,
): UploadIntentRequest {
  assertAssetDescriptor(request)
  if (!Number.isSafeInteger(request.size) || request.size <= 0) {
    throw new FileAssetError("bad_request", "size must be a positive integer", 400)
  }
  if (request.size > MAX_ASSET_BYTES) {
    throw new FileAssetError(
      "payload_too_large",
      "File is larger than 25 MiB",
      413,
    )
  }
  if (request.contentType !== contentTypeForExtension(request.extension)) {
    throw new FileAssetError(
      "unsupported_media_type",
      "Content type does not match the file extension",
      415,
    )
  }
  return request
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte)
}

function asciiAt(bytes: Uint8Array, start: number, text: string): boolean {
  return [...text].every((character, index) => bytes[start + index] === character.charCodeAt(0))
}

export function validateFileSignature(
  extension: AssetExtension,
  bytes: Uint8Array,
): void {
  const valid = (() => {
    switch (extension) {
      case "png":
        return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      case "jpg":
      case "jpeg":
        return startsWith(bytes, [0xff, 0xd8, 0xff])
      case "gif":
        return asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")
      case "webp":
        return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")
      case "avif":
        return asciiAt(bytes, 4, "ftyp") &&
          (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis"))
      case "woff":
        return asciiAt(bytes, 0, "wOFF")
      case "woff2":
        return asciiAt(bytes, 0, "wOF2")
    }
  })()
  if (!valid) {
    throw new FileAssetError(
      "unsupported_media_type",
      "File contents do not match the file type",
      415,
    )
  }
}

export function cacheControlForExtension(extension: AssetExtension): string {
  return FONT_EXTENSIONS.has(extension)
    ? "private, max-age=31536000, immutable"
    : "private, max-age=31536000, immutable"
}

export function validateThumbnail(size: number, contentType: string): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new FileAssetError("bad_request", "Content-Length is required", 411)
  }
  if (size > MAX_THUMBNAIL_BYTES) {
    throw new FileAssetError(
      "payload_too_large",
      "Thumbnail is larger than 2 MiB",
      413,
    )
  }
  if (contentType !== "image/avif") {
    throw new FileAssetError(
      "unsupported_media_type",
      "Thumbnail must be AVIF",
      415,
    )
  }
}
