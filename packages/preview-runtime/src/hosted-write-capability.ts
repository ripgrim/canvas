export type HostedPreviewWriteCapability = Readonly<{
  version: 1
  jobId: string
  leaseId: string
  artifactId: string
  stagingId: string
  audience: string
  issuedAt: number
  expiresAt: number
}>

export type HostedPreviewWriteIdentity = Readonly<{
  jobId: string
  leaseId: string
  artifactId: string
  stagingId: string
}>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const maximumLifetimeSeconds = 300

export async function issueHostedPreviewWriteCapability(input: HostedPreviewWriteIdentity & Readonly<{
  audience: string
  secret: string
  now?: number
  lifetimeSeconds?: number
}>): Promise<string> {
  const issuedAt = integer(input.now ?? Math.floor(Date.now() / 1000))
  const lifetimeSeconds = integer(input.lifetimeSeconds ?? maximumLifetimeSeconds)
  if (lifetimeSeconds < 1 || lifetimeSeconds > maximumLifetimeSeconds) invalid()
  const capability = parseCapability({
    version: 1,
    ...identity(input),
    audience: origin(input.audience),
    issuedAt,
    expiresAt: issuedAt + lifetimeSeconds,
  })
  const payload = encode(new TextEncoder().encode(JSON.stringify(capability)))
  return `${payload}.${encode(await sign(input.secret, payload))}`
}

export async function verifyHostedPreviewWriteCapability(input: HostedPreviewWriteIdentity & Readonly<{
  token: string
  audience: string
  secret: string
  now?: number
}>): Promise<HostedPreviewWriteCapability> {
  if (typeof input.token !== 'string' || input.token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.token)) invalid()
  const [payload, signature] = input.token.split('.') as [string, string]
  const key = await hmacKey(input.secret)
  if (!await globalThis.crypto.subtle.verify('HMAC', key, decode(signature).buffer, new TextEncoder().encode(payload))) invalid()
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(payload))) }
  catch { invalid() }
  const capability = parseCapability(parsed)
  const now = integer(input.now ?? Math.floor(Date.now() / 1000))
  const expected = identity(input)
  if (capability.jobId !== expected.jobId || capability.leaseId !== expected.leaseId
    || capability.artifactId !== expected.artifactId || capability.stagingId !== expected.stagingId
    || capability.audience !== origin(input.audience) || capability.expiresAt <= now
    || capability.issuedAt > now + 30 || capability.expiresAt <= capability.issuedAt
    || capability.expiresAt - capability.issuedAt > maximumLifetimeSeconds) invalid()
  return capability
}

function parseCapability(value: unknown): HostedPreviewWriteCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'artifactId,audience,expiresAt,issuedAt,jobId,leaseId,stagingId,version' || record.version !== 1) invalid()
  return Object.freeze({
    version: 1,
    ...identity(record),
    audience: origin(record.audience),
    issuedAt: integer(record.issuedAt),
    expiresAt: integer(record.expiresAt),
  })
}

function identity(value: Record<string, unknown> | HostedPreviewWriteIdentity): HostedPreviewWriteIdentity {
  return Object.freeze({
    jobId: uuid(value.jobId),
    leaseId: uuid(value.leaseId),
    artifactId: uuid(value.artifactId),
    stagingId: uuid(value.stagingId),
  })
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) invalid()
  return value.toLowerCase()
}

function origin(value: unknown): string {
  if (typeof value !== 'string') invalid()
  let parsed: URL
  try { parsed = new URL(value) } catch { invalid() }
  if (parsed.origin !== value || parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) invalid()
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) invalid()
  return parsed.origin
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid()
  return Number(value)
}

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload)))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || new TextEncoder().encode(secret).byteLength < 32 || /[\r\n]/.test(secret)) invalid()
  return globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid()
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  let binary: string
  try { binary = atob(base64) } catch { invalid() }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (encode(bytes) !== value) invalid()
  return bytes
}

function invalid(): never {
  throw new Error('Hosted preview write capability is invalid.')
}
