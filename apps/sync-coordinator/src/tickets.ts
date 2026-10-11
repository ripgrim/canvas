import { maxCollaborationConnectionNonceLength, maxRoomTicketLength, validateVerifiedRoomTicketClaimsShape } from "@canvas/sync-protocol"
import type { VerifiedRoomTicketClaims } from "@canvas/sync-protocol"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const maximumAdmissionLifetimeMs = 15_000
const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}
const decode = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), character => character.charCodeAt(0)) } catch { return null }
}
async function hmac(secret: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(secret).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(payload).buffer))
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

export type AdmissionClaims = Omit<VerifiedRoomTicketClaims, "expiresAtUnixMs" | "clientId" | "connectionNonce">
export type InternalAdmissionEnvelope = Readonly<{ admissionId: string; roomName: string; origin: string; clientId: string; requestId: string; claims: AdmissionClaims; issuedAtUnixMs: number; expiresAtUnixMs: number }>

export async function openInternalAdmission(token: string, secret: Uint8Array, nowUnixMs: number): Promise<InternalAdmissionEnvelope | null> {
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const payload = decode(parts[0]!)
  const signature = decode(parts[1]!)
  if (!payload || !signature || !equal(signature, await hmac(secret, encoder.encode(`canvas-sync-admission-v1:${parts[0]}`)))) return null
  let value: unknown
  try { value = JSON.parse(decoder.decode(payload)) } catch { return null }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).sort().join(",") !== "admissionId,claims,clientId,expiresAtUnixMs,issuedAtUnixMs,origin,requestId,roomName") return null
  if (typeof envelope.admissionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(envelope.admissionId)
    || typeof envelope.roomName !== "string" || typeof envelope.origin !== "string" || typeof envelope.clientId !== "string" || typeof envelope.requestId !== "string") return null
  if (!Number.isSafeInteger(envelope.issuedAtUnixMs) || !Number.isSafeInteger(envelope.expiresAtUnixMs)
    || (envelope.issuedAtUnixMs as number) > nowUnixMs + 5_000
    || (envelope.expiresAtUnixMs as number) <= nowUnixMs
    || (envelope.expiresAtUnixMs as number) <= (envelope.issuedAtUnixMs as number)
    || (envelope.expiresAtUnixMs as number) - (envelope.issuedAtUnixMs as number) > maximumAdmissionLifetimeMs) return null
  try {
    const claims = validateVerifiedRoomTicketClaimsShape({ ...(envelope.claims as object), expiresAtUnixMs: Number.MAX_SAFE_INTEGER, clientId: envelope.clientId, connectionNonce: "n".repeat(maxCollaborationConnectionNonceLength) })
    return Object.freeze({ admissionId: envelope.admissionId, roomName: envelope.roomName, origin: envelope.origin, clientId: envelope.clientId, requestId: envelope.requestId, claims: Object.freeze({ subjectId: claims.subjectId, displayName: claims.displayName, avatarUrl: claims.avatarUrl, fileId: claims.fileId, role: claims.role, generationId: claims.generationId, protocolEpoch: claims.protocolEpoch, buildId: claims.buildId, accessEpoch: claims.accessEpoch }), issuedAtUnixMs: envelope.issuedAtUnixMs as number, expiresAtUnixMs: envelope.expiresAtUnixMs as number })
  } catch { return null }
}

export async function mintRoomTicket(claims: VerifiedRoomTicketClaims, secret: Uint8Array): Promise<string> {
  const payload = encoder.encode(JSON.stringify(validateVerifiedRoomTicketClaimsShape(claims)))
  const signature = await hmac(secret, payload)
  const bytes = new Uint8Array(payload.byteLength + signature.byteLength)
  bytes.set(payload); bytes.set(signature, payload.byteLength)
  const ticket = base64Url(bytes)
  if (ticket.length > maxRoomTicketLength) throw new Error("Room ticket exceeds the collaboration protocol limit.")
  return ticket
}
