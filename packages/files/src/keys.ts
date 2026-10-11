import type { AssetDescriptor, AssetExtension } from "./contracts.js"
import { FileAssetError } from "./contracts.js"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const CONTENT_TYPES = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
} as const satisfies Record<AssetExtension, string>

export function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new FileAssetError("bad_request", `${label} is invalid`, 400)
  }
}

export function assertAssetDescriptor(
  descriptor: AssetDescriptor,
): AssetDescriptor {
  assertIdentifier(descriptor.fileId, "fileId")
  assertIdentifier(descriptor.assetId, "assetId")
  if (!(descriptor.extension in CONTENT_TYPES)) {
    throw new FileAssetError("unsupported_media_type", "File type is not supported", 415)
  }
  return descriptor
}

export function contentTypeForExtension(extension: AssetExtension): string {
  return CONTENT_TYPES[extension]
}

export function assetKey(descriptor: AssetDescriptor): string {
  assertAssetDescriptor(descriptor)
  return `${descriptor.fileId}/${descriptor.assetId}.${descriptor.extension}`
}

export function thumbnailObjectKey(
  fileId: string,
  revision: number,
  nonce: string,
): string {
  assertIdentifier(fileId, "fileId")
  assertIdentifier(nonce, "nonce")
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new FileAssetError("bad_request", "revision is invalid", 400)
  }
  return `thumbnails/${fileId}/versions/${revision}/${nonce}.avif`
}

export function parseThumbnailObjectKey(
  key: string,
  expectedFileId: string,
): Readonly<{ revision: number; nonce: string }> | null {
  assertIdentifier(expectedFileId, "fileId")
  const match = /^thumbnails\/([^/]+)\/versions\/(0|[1-9][0-9]*)\/([^/.]+)\.avif$/.exec(key)
  if (!match || match[1] !== expectedFileId || !match[2] || !match[3]) return null
  const revision = Number(match[2])
  if (!Number.isSafeInteger(revision)) return null
  try {
    assertIdentifier(match[3], "nonce")
    return { revision, nonce: match[3] }
  } catch {
    return null
  }
}

export function thumbnailClaimKey(fileId: string, nonce: string): string {
  assertIdentifier(fileId, "fileId")
  assertIdentifier(nonce, "nonce")
  return `thumbnail-claims/${fileId}/${nonce}`
}

export function thumbnailQuotaPrefix(windowStart: number, scopeHash: string): string {
  if (!Number.isSafeInteger(windowStart) || windowStart < 0) {
    throw new FileAssetError("bad_request", "quota window is invalid", 400)
  }
  if (!/^[a-f0-9]{64}$/.test(scopeHash)) {
    throw new FileAssetError("bad_request", "quota scope is invalid", 400)
  }
  return `thumbnail-quota/${windowStart}/${scopeHash}/`
}

export function parseAssetPath(pathname: string): AssetDescriptor | null {
  const match = /^\/file-assets\/([^/]+)\/([^/.]+)\.([a-z0-9]+)$/.exec(pathname)
  if (!match) {
    return null
  }
  const [, fileId, assetId, extension] = match
  if (!fileId || !assetId || !extension || !(extension in CONTENT_TYPES)) {
    return null
  }
  try {
    return assertAssetDescriptor({
      fileId,
      assetId,
      extension: extension as AssetExtension,
    })
  } catch {
    return null
  }
}

export function parseThumbnailPath(pathname: string): string | null {
  const match = /^\/file-assets\/thumbnails\/([^/]+)\/thumbnail\.avif$/.exec(pathname)
  const fileId = match?.[1]
  if (!fileId) {
    return null
  }
  try {
    assertIdentifier(fileId, "fileId")
    return fileId
  } catch {
    return null
  }
}
