import type { UploadIntentRequest } from "./contracts.js"
import { FileAssetError } from "./contracts.js"

export interface UploadIntentClaims extends UploadIntentRequest {
  version: 1
  subject: string
  nonce: string
  expiresAt: number
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
      subject,
      nonce: this.#nonce(),
      expiresAt: this.#now() + this.#lifetimeSeconds * 1_000,
    }
    const payload = encoder.encode(JSON.stringify(claims))
    const signature = await crypto.subtle.sign(
      "HMAC",
      await importKey(this.#secret),
      payload,
    )
    return {
      token: `${base64UrlEncode(payload)}.${base64UrlEncode(new Uint8Array(signature))}`,
      claims,
    }
  }

  async verify(token: string): Promise<UploadIntentClaims> {
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
    let claims: UploadIntentClaims
    try {
      claims = JSON.parse(decoder.decode(payload)) as UploadIntentClaims
    } catch {
      throw new FileAssetError("unauthorized", "Upload intent is invalid", 401)
    }
    if (
      claims.version !== 1 ||
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
