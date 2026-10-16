export type HostedPreviewCapability = Readonly<{
  version: 1
  artifactId: string
  audience: string
  issuedAt: number
  expiresAt: number
  nonce: string
}>

export type IssueHostedPreviewCapabilityInput = Readonly<{
  artifactId: string
  audience: string
  secret: string
  now?: number
  lifetimeSeconds?: number
  nonce?: string
}>

export type VerifyHostedPreviewCapabilityInput = Readonly<{
  token: string
  artifactId: string
  audience: string
  secret: string
  now?: number
}>

const artifactIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const maximumLifetimeSeconds = 300

export async function issueHostedPreviewCapability(input: IssueHostedPreviewCapabilityInput): Promise<string> {
  const issuedAt = integerTime(input.now ?? Math.floor(Date.now() / 1000))
  const lifetimeSeconds = input.lifetimeSeconds ?? 120
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > maximumLifetimeSeconds) invalid()
  const capability = freezeCapability({
    version: 1,
    artifactId: artifactId(input.artifactId),
    audience: origin(input.audience),
    issuedAt,
    expiresAt: issuedAt + lifetimeSeconds,
    nonce: nonce(input.nonce ?? globalThis.crypto.randomUUID()),
  })
  const payload = base64url(new TextEncoder().encode(JSON.stringify(capability)))
  return `${payload}.${base64url(await signature(input.secret, payload))}`
}

export async function verifyHostedPreviewCapability(input: VerifyHostedPreviewCapabilityInput): Promise<HostedPreviewCapability> {
  if (typeof input.token !== "string" || input.token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.token)) invalid()
  const [payload, encodedSignature] = input.token.split(".") as [string, string]
  const key = await hmacKey(input.secret)
  let verified = false
  try {
    verified = await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64url(encodedSignature).buffer,
      new TextEncoder().encode(payload),
    )
  } catch { invalid() }
  if (!verified) invalid()
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) }
  catch { invalid() }
  const capability = parseCapability(value)
  const now = integerTime(input.now ?? Math.floor(Date.now() / 1000))
  if (
    capability.artifactId !== artifactId(input.artifactId) ||
    capability.audience !== origin(input.audience) ||
    capability.expiresAt <= now ||
    capability.issuedAt > now + 30 ||
    capability.expiresAt <= capability.issuedAt ||
    capability.expiresAt > now + maximumLifetimeSeconds ||
    capability.expiresAt - capability.issuedAt > maximumLifetimeSeconds
  ) invalid()
  return capability
}

function parseCapability(value: unknown): HostedPreviewCapability {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== "artifactId,audience,expiresAt,issuedAt,nonce,version") invalid()
  if (record.version !== 1) invalid()
  return freezeCapability({
    version: 1,
    artifactId: artifactId(record.artifactId),
    audience: origin(record.audience),
    issuedAt: integerTime(record.issuedAt),
    expiresAt: integerTime(record.expiresAt),
    nonce: nonce(record.nonce),
  })
}

function freezeCapability(value: HostedPreviewCapability): HostedPreviewCapability {
  return Object.freeze({ ...value })
}

function artifactId(value: unknown): string {
  if (typeof value !== "string" || !artifactIdPattern.test(value)) invalid()
  return value.toLowerCase()
}

function nonce(value: unknown): string {
  if (typeof value !== "string" || !noncePattern.test(value)) invalid()
  return value.toLowerCase()
}

function origin(value: unknown): string {
  if (typeof value !== "string") invalid()
  let url: URL
  try { url = new URL(value) } catch { invalid() }
  if (url.origin !== value || url.username || url.password || !["http:", "https:"].includes(url.protocol)) invalid()
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) invalid()
  return url.origin
}

function integerTime(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid()
  return Number(value)
}

async function signature(secret: string, value: string): Promise<Uint8Array> {
  const key = await hmacKey(secret)
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(secret)
  if (bytes.byteLength < 32 || /[\r\n]/.test(secret)) invalid()
  return globalThis.crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.byteLength; index += 1) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid()
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)
  let binary: string
  try { binary = atob(base64) } catch { invalid() }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (base64url(bytes) !== value) invalid()
  return bytes
}

function invalid(): never {
  throw new Error("Hosted preview capability is invalid.")
}
