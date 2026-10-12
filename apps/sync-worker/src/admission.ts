import { collaborationProtocolEpoch, collaborationWebSocketProtocol, maxCollaborationConnectionNonceLength, validateVerifiedRoomTicketClaimsShape } from "@canvas/sync-protocol"
import type { VerifiedRoomTicketClaims } from "@canvas/sync-protocol"

export type AdmissionClaims = Omit<VerifiedRoomTicketClaims, "expiresAtUnixMs" | "clientId" | "connectionNonce">

export type CollaborationAdmission = Readonly<{
  claims: AdmissionClaims
  generation: Readonly<{ status: "active" | "candidate" }>
  compatibility: Readonly<{ status: "compatible"; protocolEpoch: typeof collaborationProtocolEpoch; buildId: string }>
}>

type AdmissionRequest = Readonly<{
  apiOrigin: string
  serviceToken: string
  buildId: string
  fileId: string
  clientId: string
  origin: string
  webSocketProtocol: typeof collaborationWebSocketProtocol
  requestId: string
  request: Request
  fetcher?: typeof fetch
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function parseAdmissionResponse(value: unknown, expected: Readonly<{ fileId: string; buildId: string; clientId: string }>): CollaborationAdmission | null {
  if (!isRecord(value) || !exactKeys(value, ["claims", "generation", "compatibility"])) return null
  if (!isRecord(value.claims) || !isRecord(value.generation) || !isRecord(value.compatibility)) return null
  if (!exactKeys(value.claims, ["subjectId", "displayName", "avatarUrl", "fileId", "role", "generationId", "protocolEpoch", "accessEpoch"])) return null
  if (!exactKeys(value.generation, ["status"]) || !exactKeys(value.compatibility, ["status", "protocolEpoch", "buildId"])) return null
  if (value.generation.status !== "active" && value.generation.status !== "candidate") return null
  if (value.compatibility.status !== "compatible" || value.compatibility.protocolEpoch !== collaborationProtocolEpoch || value.compatibility.buildId !== expected.buildId) return null
  try {
    const fullClaims = validateVerifiedRoomTicketClaimsShape({
      ...value.claims,
      buildId: expected.buildId,
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
      clientId: expected.clientId,
      connectionNonce: "n".repeat(maxCollaborationConnectionNonceLength),
    })
    if (fullClaims.fileId !== expected.fileId) return null
    const claims: AdmissionClaims = Object.freeze({
      subjectId: fullClaims.subjectId,
      displayName: fullClaims.displayName,
      avatarUrl: fullClaims.avatarUrl,
      fileId: fullClaims.fileId,
      role: fullClaims.role,
      generationId: fullClaims.generationId,
      protocolEpoch: fullClaims.protocolEpoch,
      buildId: fullClaims.buildId,
      accessEpoch: fullClaims.accessEpoch,
    })
    return Object.freeze({ claims, generation: Object.freeze({ status: value.generation.status }), compatibility: Object.freeze({ status: "compatible", protocolEpoch: collaborationProtocolEpoch, buildId: expected.buildId }) })
  } catch { return null }
}

export async function requestCollaborationAdmission(input: AdmissionRequest): Promise<Readonly<{ response: Response; admission: CollaborationAdmission | null }>> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Origin": input.origin,
    "X-Canvas-Collaboration-Token": input.serviceToken,
    "X-Canvas-Request-Id": input.requestId,
  })
  const authorization = input.request.headers.get("Authorization")
  const cookie = input.request.headers.get("Cookie")
  if (authorization) headers.set("Authorization", authorization)
  if (cookie) headers.set("Cookie", cookie)
  const response = await (input.fetcher ?? fetch)(`${input.apiOrigin}/internal/collaboration/admission`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileId: input.fileId, clientId: input.clientId, protocolEpoch: collaborationProtocolEpoch, webSocketProtocol: input.webSocketProtocol, buildId: input.buildId }),
  })
  if (!response.ok) return Object.freeze({ response, admission: null })
  let value: unknown
  try { value = await response.json() } catch { return Object.freeze({ response, admission: null }) }
  return Object.freeze({ response, admission: parseAdmissionResponse(value, { fileId: input.fileId, buildId: input.buildId, clientId: input.clientId }) })
}
