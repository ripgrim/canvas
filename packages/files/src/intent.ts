import type {
  ThumbnailUploadIntentRequest,
  UploadIntentRequest,
} from "./contracts.js"
import { FileAssetError } from "./contracts.js"
import { thumbnailObjectKey } from "./keys.js"

export interface UploadIntentClaims extends UploadIntentRequest {
  version: 1
  kind: "asset"
  subject: string
  nonce: string
  expiresAt: number
}

export interface ThumbnailUploadIntentClaims extends ThumbnailUploadIntentRequest {
  version: 1
  kind: "thumbnail"
  subject: string
  nonce: string
  expiresAt: number
  objectKey: string
}

export interface UploadIntentSignerOptions {
  secret: string
  lifetimeSeconds?: number
  now?: () => number
  nonce?: () => string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  )
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  } catch {
    throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

export class UploadIntentSigner {
  readonly #secret: string
  readonly #lifetimeSeconds: number
  readonly #now: () => number
  readonly #nonce: () => string

  constructor(options: UploadIntentSignerOptions) {
    if (encoder.encode(options.secret).byteLength < 32) {
      throw new Error("UPLOAD_INTENT_SECRET must be at least 32 bytes")
    }
    this.#secret = options.secret
    this.#lifetimeSeconds = options.lifetimeSeconds ?? 120
    this.#now = options.now ?? (() => Date.now())
    this.#nonce = options.nonce ?? (() => crypto.randomUUID())
  }

  async issue(
    subject: string,
    request: UploadIntentRequest,
  ): Promise<{ token: string; claims: UploadIntentClaims }> {
    const claims: UploadIntentClaims = {
      ...request,
      version: 1,
      kind: "asset",
      subject,
      nonce: this.#nonce(),
      expiresAt: this.#now() + this.#lifetimeSeconds * 1_000,
    }
    return {
      token: await this.#sign(claims),
      claims,
    }
  }

  async issueThumbnail(
    subject: string,
    request: ThumbnailUploadIntentRequest,
  ): Promise<{ token: string; claims: ThumbnailUploadIntentClaims }> {
    const nonce = this.#nonce()
    const claims: ThumbnailUploadIntentClaims = {
      ...request,
      version: 1,
      kind: "thumbnail",
      subject,
      nonce,
      expiresAt: this.#now() + this.#lifetimeSeconds * 1_000,
      objectKey: thumbnailObjectKey(
        request.fileId,
        request.expectedRevision,
        nonce,
      ),
    }
    return { token: await this.#sign(claims), claims }
  }

  async verify(token: string): Promise<UploadIntentClaims> {
    const claims = await this.#verify(token)
    if (
      claims.kind !== "asset" ||
      Object.keys(claims).sort().join(",") !==
        "assetId,contentType,expiresAt,extension,fileId,kind,nonce,size,subject,version"
    ) {
      throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
    }
    return claims as unknown as UploadIntentClaims
  }

  async verifyThumbnail(token: string): Promise<ThumbnailUploadIntentClaims> {
    const claims = await this.#verify(token)
    if (
      claims.kind !== "thumbnail" ||
      Object.keys(claims).sort().join(",") !==
        "contentType,expectedRevision,expiresAt,fileId,kind,nonce,objectKey,size,subject,version" ||
      typeof claims.objectKey !== "string" ||
      typeof claims.fileId !== "string" ||
      typeof claims.expectedRevision !== "number" ||
      typeof claims.nonce !== "string"
    ) {
      throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
    }
    try {
      if (claims.objectKey !== thumbnailObjectKey(
        claims.fileId,
        claims.expectedRevision,
        claims.nonce,
      )) {
        throw new Error("mismatch")
      }
    } catch {
      throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
    }
    return claims as unknown as ThumbnailUploadIntentClaims
  }

  async #sign(claims: UploadIntentClaims | ThumbnailUploadIntentClaims): Promise<string> {
    const payload = encoder.encode(JSON.stringify(claims))
    const signature = await crypto.subtle.sign(
      "HMAC",
      await importKey(this.#secret),
      payload,
    )
    return `${base64UrlEncode(payload)}.${base64UrlEncode(new Uint8Array(signature))}`
  }

  async #verify(token: string): Promise<Record<string, unknown>> {
    const [payloadPart, signaturePart, extra] = token.split(".")
    if (!payloadPart || !signaturePart || extra) {
      throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
    }
    const payload = base64UrlDecode(payloadPart)
    const signature = base64UrlDecode(signaturePart)
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importKey(this.#secret),
      signature.buffer,
      payload,
    )
    if (!valid) {
      throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
    }
    let claims: Record<string, unknown>
    try {
      claims = JSON.parse(decoder.decode(payload)) as Record<string, unknown>
    } catch {
      throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
    }
    if (
      claims.version !== 1 ||
      (claims.kind !== "asset" && claims.kind !== "thumbnail") ||
      typeof claims.subject !== "string" ||
      typeof claims.expiresAt !== "number" ||
      typeof claims.nonce !== "string" ||
      claims.expiresAt <= this.#now()
    ) {
      throw new FileAssetError("unauthorized", "Upload intent has expired", 401)
    }
    return claims
  }
}
