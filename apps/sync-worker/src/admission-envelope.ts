import { maxCollaborationConnectionNonceLength, validateVerifiedRoomTicketClaimsShape } from "@canvas/sync-protocol"
import type { AdmissionClaims } from "./admission.js"

const encoder = new TextEncoder()

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function hmac(secret: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(secret).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(payload).buffer))
}

export type InternalAdmissionEnvelope = Readonly<{
  admissionId: string
  roomName: string
  origin: string
  clientId: string
  requestId: string
  claims: AdmissionClaims
  issuedAtUnixMs: number
  expiresAtUnixMs: number
}>

export async function sealInternalAdmission(envelope: InternalAdmissionEnvelope, secret: Uint8Array): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(envelope.admissionId)) throw new Error("Internal admission ID is invalid.")
  const claims = validateVerifiedRoomTicketClaimsShape({
    ...envelope.claims,
    expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
    clientId: envelope.clientId,
    connectionNonce: "n".repeat(maxCollaborationConnectionNonceLength),
  })
  const canonicalEnvelope: InternalAdmissionEnvelope = Object.freeze({
    admissionId: envelope.admissionId,
    roomName: envelope.roomName,
    origin: envelope.origin,
    clientId: envelope.clientId,
    requestId: envelope.requestId,
    claims: Object.freeze({
      subjectId: claims.subjectId,
      displayName: claims.displayName,
      avatarUrl: claims.avatarUrl,
      fileId: claims.fileId,
      role: claims.role,
      generationId: claims.generationId,
      protocolEpoch: claims.protocolEpoch,
      buildId: claims.buildId,
      accessEpoch: claims.accessEpoch,
    }),
    issuedAtUnixMs: envelope.issuedAtUnixMs,
    expiresAtUnixMs: envelope.expiresAtUnixMs,
  })
  const payload = encoder.encode(JSON.stringify(canonicalEnvelope))
  const encodedPayload = base64Url(payload)
  const signature = await hmac(secret, encoder.encode(`canvas-sync-admission-v1:${encodedPayload}`))
  return `${encodedPayload}.${base64Url(signature)}`
}
